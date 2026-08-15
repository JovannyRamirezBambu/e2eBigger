#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2317
FLOW_DESC="Sincronización offline — lote de la tablet del taquillero hacia BCB"

# ── Repos ──────────────────────────────────────────────────────────────────
# No hay repo de satélite acá: el "satélite" de este flujo es el app `bcb` del
# propio BCB_EstrellaRoja_Backend (módulo sync, POST /sync).
REPO_BCB="$ER_ROOT/BCB_EstrellaRoja_Backend"
REPO_MAIN="$ER_ROOT/BIGER_EstrellaRoja_Main"

# ── Infraestructura ────────────────────────────────────────────────────────
BCB_DB_CONTAINER="bcb-local-db"
BCB_DB_USER="bcb"; BCB_DB_NAME="bcb"
BCB_DB_URL="postgresql://bcb:bcb@localhost:5436/bcb"

BIGER_DB_CONTAINER="postgres"

NATS_URL="nats://localhost:4222"
NATS_MONITOR="http://localhost:8222"

PORT_ADAPTER_TCO=8092        # puerto propio del adapter (default de su application.yml)
PORT_ADAPTER_BCB=8085
PORT_BCB_APP=3009            # app `bcb`; lo comparte el flujo tomtom
PORT_JWKS=7802               # emisor JWKS de prueba (7801 lo usa el SmartMac falso)

LEG_BCB="adapter-bcb"        # firma el JWT saliente adapter-bcb → app bcb
LEG_ADVISOR="tablet-advisor" # llave del token del TAQUILLERO, que el adapter valida por JWKS

# El adapter enruta por el claim `iss`, así que el issuer y el JWKS tienen que
# apuntar al mismo servidor local. `src/flows/ticketcolectoroffline/cases.ts`
# firma con el mismo issuer (mismos defaults por env).
JWKS_ISSUER="http://127.0.0.1:$PORT_JWKS/advisor"
JWKS_URI="$JWKS_ISSUER/.well-known/jwks.json"

bcb_sql() {
  docker exec "$BCB_DB_CONTAINER" psql -U "$BCB_DB_USER" -d "$BCB_DB_NAME" -tA -c "$1" 2>/dev/null
}

# ── up ─────────────────────────────────────────────────────────────────────
flow_up() {
  step "Preflight"
  for c in docker mvn node pnpm openssl curl python3; do need_cmd "$c"; done
  for r in "$REPO_BCB" "$REPO_MAIN"; do [ -d "$r" ] || die "no encuentro el repo: $r"; done
  ok "comandos y repos presentes"

  step "Llaves de prueba"
  ensure_keypair "$LEG_BCB"
  # La del taquillero: el harness firma con la privada y el adapter la verifica
  # bajando la pública del JWKS local. Es el ÚNICO camino que puebla el `_auth`
  # del mensaje NATS, y sin `_auth` BCB responde 401 (ver lib/jwks-server.js).
  ensure_keypair "$LEG_ADVISOR"
  dim "   run/keys/ — solo para local, nunca credenciales reales"

  step "Infraestructura BIGER (Postgres + NATS x3 + adapter-invoice)"
  ( cd "$REPO_MAIN" && docker compose up -d adapter-invoice >/dev/null 2>&1 ) \
    || die "no pude levantar la infra de BIGER"
  wait_for "NATS respondiendo" 60 http_ok "$NATS_MONITOR/healthz?js-server-only=true" || return 1
  wait_for "Postgres BIGER listo" 60 pg_ready "$BIGER_DB_CONTAINER" biger db_biger || return 1

  step "Streams de JetStream"
  ( cd "$REPO_MAIN" && make nats-init >/dev/null 2>&1 ) || die "make nats-init falló"
  local ok_stream
  ok_stream=$(curl -s "$NATS_MONITOR/jsz?streams=true" | python3 -c "
import json,sys
d=json.load(sys.stdin)
names=[s['name'] for a in d.get('account_details',[]) for s in a.get('stream_detail',[])]
print('ok' if 'TICKETCOLECTOROFFLINE_SYNC_STREAM' in names else 'missing')")
  [ "$ok_stream" = "ok" ] || die "TICKETCOLECTOROFFLINE_SYNC_STREAM no quedó creado"
  ok "TICKETCOLECTOROFFLINE_SYNC_STREAM presente"

  step "Postgres de BCB"
  wait_for "Postgres BCB listo" 60 pg_ready "$BCB_DB_CONTAINER" "$BCB_DB_USER" "$BCB_DB_NAME" \
    || die "la BD de BCB no está arriba — arrancá el contenedor $BCB_DB_CONTAINER"
  ( cd "$REPO_BCB" && DATABASE_URL="$BCB_DB_URL" pnpm exec prisma migrate deploy >/dev/null 2>&1 ) \
    || die "prisma migrate deploy (BCB) falló"
  ( cd "$REPO_BCB" && pnpm exec prisma generate >/dev/null 2>&1 ) || die "prisma generate (BCB) falló"
  ok "esquema y client de BCB al día"

  step "Compilación de los adapters"
  local jar_bcb="$REPO_MAIN/adapter-bcb/target/adapter-bcb-1.0.0-SNAPSHOT.jar"
  local jar_tco="$REPO_MAIN/adapter-ticketcolectoroffline/target/adapter-ticketcolectoroffline-1.0.0-SNAPSHOT.jar"
  local to_build=()
  jar_is_stale "$jar_bcb" "$REPO_MAIN/adapter-bcb/src/main" "$REPO_MAIN/shared/src/main" && to_build+=("adapter-bcb")
  jar_is_stale "$jar_tco" "$REPO_MAIN/adapter-ticketcolectoroffline/src/main" "$REPO_MAIN/shared/src/main" \
    && to_build+=("adapter-ticketcolectoroffline")
  if [ ${#to_build[@]} -gt 0 ]; then
    log "recompilando: ${to_build[*]} (fuentes más nuevas que el jar)"
    local mods; mods=$(IFS=,; echo "${to_build[*]}")
    ( cd "$REPO_MAIN" && mvn -q package -pl "$mods" -am -DskipTests -Ddependency-check.skip=true >/dev/null 2>&1 ) \
      || die "mvn package falló para $mods"
    ok "jars reconstruidos"
    stop_rebuilt "${to_build[@]}"
  else
    dim "   jars al día"
  fi

  step "Emisor JWKS de prueba"
  # Arranca ANTES del adapter y queda arriba entre corridas: Nimbus baja el JWKS
  # de forma perezosa (en la primera validación), así que si viviera dentro del
  # proceso de pruebas el primer caso de cada corrida sería una carrera.
  if is_running jwks; then
    dim "   jwks ya corriendo"
  else
    stop_bg jwks
    ensure_port_free "$PORT_JWKS" jwks
    start_bg jwks "$LOG_DIR/jwks.log" \
      node "$E2E_ROOT/lib/jwks-server.js" "$(key_path "$LEG_ADVISOR-public.pem")" "$PORT_JWKS" /advisor
  fi
  wait_for "JWKS :$PORT_JWKS" 30 http_ok "http://127.0.0.1:$PORT_JWKS/health" || return 1

  step "Servicios"
  local seed_tco; seed_tco=$(grep -m1 '^TICKETCOLECTOROFFLINE_SECRET_NATS_SEED=' "$REPO_MAIN/.env" | cut -d= -f2)
  [ -n "$seed_tco" ] || die "falta TICKETCOLECTOROFFLINE_SECRET_NATS_SEED en $REPO_MAIN/.env"

  # adapter-ticketcolectoroffline: la puerta de la tablet.
  #
  # JWT_BYPASS=false + auth.bcb.enabled=true a propósito, al revés que los otros
  # flujos. Sus controllers llevan @BcbAuth({ADVISOR}) y la identidad del
  # taquillero sale del SecurityContext, no del payload: con el bypass las pruebas
  # pasarían el adapter pero BCB devolvería 401, y con auth.bcb.enabled=false el
  # @BcbAuth no se registra y el `_auth` viajaría vacío. Es decir, el bypass
  # convertiría este flujo en una prueba que no prueba lo único que tiene de propio.
  if is_running adapter-ticketcolectoroffline; then
    dim "   adapter-ticketcolectoroffline ya corriendo"
  else
    stop_bg adapter-ticketcolectoroffline
    ensure_port_free "$PORT_ADAPTER_TCO" adapter-ticketcolectoroffline
    ( cd "$REPO_MAIN" && \
      SPRING_PROFILES_ACTIVE=local SERVER_PORT="$PORT_ADAPTER_TCO" NATS_URL="$NATS_URL" \
      SECRETS_SOURCE=local DB_SECRET=db-local \
      DB_SECRET_KEY_VALUE='{"username":"biger","password":"biger_local"}' \
      NATS_NKEY_SECRET=nats-nkey-ticketcolectoroffline \
      NATS_NKEY_SECRET_KEY_VALUE="{\"seed\":\"$seed_tco\"}" \
      SPRING_DATASOURCE_URL="jdbc:postgresql://localhost:5433/db_biger" \
      JWT_BYPASS=false \
      TICKETCOLECTOROFFLINE_MULTI_ISSUER_AUTH_ENABLED=true \
      TICKETCOLECTOROFFLINE_ADVISOR_ISSUER="$JWKS_ISSUER" \
      TICKETCOLECTOROFFLINE_ADVISOR_JWKS_URL="$JWKS_URI" \
      OTLP_TRACES_ENABLED=false \
      start_bg adapter-ticketcolectoroffline "$LOG_DIR/adapter-ticketcolectoroffline.log" \
        java -jar "$jar_tco" )
  fi

  # adapter-bcb y el app `bcb`: compartidos con los otros flujos (ver lib/common.sh).
  start_adapter_bcb "$REPO_MAIN" "http://localhost:$PORT_BCB_APP" \
    "http://localhost:${PORT_BCB_WEBHOOKS:-3011}" "$LEG_BCB"
  start_bcb_app "$REPO_BCB" "$PORT_BCB_APP" "$BCB_DB_URL" "$LEG_BCB"

  step "Health"
  wait_for "adapter-ticketcolectoroffline :$PORT_ADAPTER_TCO" 90 http_ok \
    "http://localhost:$PORT_ADAPTER_TCO/ticketcolectoroffline/health" || return 1
  wait_for "adapter-bcb :$PORT_ADAPTER_BCB" 90 http_ok "http://localhost:$PORT_ADAPTER_BCB/actuator/health" || return 1
  # El /sync exige token: un 401 ya prueba que la ruta existe y el guard corre.
  wait_for "app bcb :$PORT_BCB_APP" 120 bash -c \
    "curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:$PORT_BCB_APP/sync | grep -q 401" || return 1

  # El responder es request/reply (core NATS), no un consumer durable: si no quedó
  # suscrito, cada sync moriría en un 504 por timeout y no en un error claro.
  if grep -q "ticketcolectoroffline.sync" "$LOG_DIR/adapter-bcb.log" 2>/dev/null; then
    ok "OfflineSyncResponder suscrito a biger.bcb.ticketcolectoroffline.sync"
  else
    warn "adapter-bcb no reporta la suscripción del sync — revisá $LOG_DIR/adapter-bcb.log"
  fi

  # El autenticador tiene que haber registrado el emisor advisor; si no, todo da 401
  # y el mensaje del adapter no dice por qué.
  if grep -q "tipo=ADVISOR" "$LOG_DIR/adapter-ticketcolectoroffline.log" 2>/dev/null; then
    ok "autenticador BCB con emisor ADVISOR registrado"
  else
    warn "el adapter no registró el emisor ADVISOR — revisá $LOG_DIR/adapter-ticketcolectoroffline.log"
  fi

  printf '\n'; ok "stack arriba"
}

# ── down / status / psql ───────────────────────────────────────────────────
flow_down() {
  local all=0
  for a in "$@"; do [ "$a" = "--all" ] && all=1; done

  step "Deteniendo servicios del flujo"
  stop_bg adapter-ticketcolectoroffline
  stop_bg jwks
  kill_port "$PORT_ADAPTER_TCO"
  kill_port "$PORT_JWKS"
  dim "   adapter-bcb y app bcb se dejan arriba: los comparte el flujo tomtom"

  if [ "$all" -eq 1 ]; then
    step "Deteniendo infraestructura compartida (--all)"
    stop_bg bcb-app;     kill_port "$PORT_BCB_APP"
    stop_bg adapter-bcb; kill_port "$PORT_ADAPTER_BCB"
    ungraft_all
    ok "scripts temporales removidos de los repos"
  fi
}

flow_status() {
  step "Estado"
  chk() {
    local label="$1"; shift
    if "$@" >/dev/null 2>&1; then printf '  %-46s %s\n' "$label" "${C_GREEN}arriba${C_RESET}"
    else printf '  %-46s %s\n' "$label" "${C_RED}abajo${C_RESET}"; fi
  }
  chk "NATS (:4222/:8222)"          http_ok "$NATS_MONITOR/healthz?js-server-only=true"
  chk "Postgres BIGER (:5433)"      pg_ready "$BIGER_DB_CONTAINER" biger db_biger
  chk "Postgres BCB (:5436)"        pg_ready "$BCB_DB_CONTAINER" "$BCB_DB_USER" "$BCB_DB_NAME"
  chk "JWKS de prueba (:$PORT_JWKS)"          http_ok "http://127.0.0.1:$PORT_JWKS/health"
  chk "adapter-ticketcolectoroffline (:$PORT_ADAPTER_TCO)" http_ok \
      "http://localhost:$PORT_ADAPTER_TCO/ticketcolectoroffline/health"
  chk "adapter-bcb (:$PORT_ADAPTER_BCB)"      http_ok "http://localhost:$PORT_ADAPTER_BCB/actuator/health"
  chk "app bcb (:$PORT_BCB_APP)"              port_busy "$PORT_BCB_APP"
  printf '\n'
  printf '  %-46s %s\n' "lotes sincronizados (SyncOfflineRequest)" "$(bcb_sql "SELECT count(*) FROM \"SyncOfflineRequest\";")"
  printf '  %-46s %s\n' "ventas offline (OrderItemOffline)"        "$(bcb_sql "SELECT count(*) FROM \"OrderItemOffline\";")"
}

flow_psql() {
  docker exec -it "$BCB_DB_CONTAINER" psql -U "$BCB_DB_USER" -d "$BCB_DB_NAME"
}
