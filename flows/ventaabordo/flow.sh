#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2317
FLOW_DESC="WS1/WS2 — Venta a Bordo: despacho hacia SmartMac y retorno de ventas hacia BCB"

# ── Repos ──────────────────────────────────────────────────────────────────
REPO_BCB="$ER_ROOT/BCB_EstrellaRoja_Backend"
REPO_MAIN="$ER_ROOT/BIGER_EstrellaRoja_Main"
REPO_SAT="$ER_ROOT/BIGER_EstrellaRoja_VentaABordo"

# ── Infraestructura ────────────────────────────────────────────────────────
BCB_DB_CONTAINER="bcb-local-db"
BCB_DB_USER="bcb"; BCB_DB_NAME="bcb"
BCB_DB_URL="postgresql://bcb:bcb@localhost:5436/bcb"

BIGER_DB_CONTAINER="postgres"
SAT_DB_CONTAINER="biger_estrellaroja_ventaabordo-db-1"
SAT_DB_URL="postgresql://venta:venta@localhost:5435/venta_abordo?schema=public"

NATS_URL="nats://localhost:4222"
NATS_MONITOR="http://localhost:8222"

PORT_ADAPTER_BCB=8085
PORT_ADAPTER_VA=8088          # el compose reserva este para ventaabordo (tomtom usa 8090)
PORT_SAT=3001                 # el satélite escucha 3001, NO 3002 (ese es portalagencias)
PORT_BCB_APP=3009             # app `bcb`, la comparte el flujo tomtom
PORT_BCB_WEBHOOKS=3011        # app `webhooks`: es OTRA app de BCB, con su propio puerto
PORT_FAKE_SMARTMAC=7801

LEG_BCB="adapter-bcb"
LEG_WS1="bcb-to-va"        # quien llama a WS1 del satélite (en producción, BCB)
LEG_VA_ADAPTER="va-to-adapter"  # el satélite firmando sus webhooks hacia adapter-ventaabordo

# Credencial ENTRANTE de SmartMac, desechable y local. La escribe el harness en el
# .env del satélite y la usan los casos de WS2 — así el flujo es autocontenido y
# nunca se apoya en (ni pisa con) las credenciales reales de TECNITRANS.
# `src/flows/ventaabordo/cases.ts` lee estos mismos valores por env.
export SMARTMAC_INBOUND_USER="${SMARTMAC_INBOUND_USER:-e2e-smartmac}"
export SMARTMAC_INBOUND_PASS="${SMARTMAC_INBOUND_PASS:-e2e-smartmac-local}"

bcb_sql() {
  docker exec "$BCB_DB_CONTAINER" psql -U "$BCB_DB_USER" -d "$BCB_DB_NAME" -tA -c "$1" 2>/dev/null
}

# ── up ─────────────────────────────────────────────────────────────────────
flow_up() {
  step "Preflight"
  for c in docker mvn node npx pnpm openssl curl python3; do need_cmd "$c"; done
  for r in "$REPO_BCB" "$REPO_MAIN" "$REPO_SAT"; do [ -d "$r" ] || die "no encuentro el repo: $r"; done
  ok "comandos y repos presentes"

  step "Llaves de prueba"
  ensure_keypair "$LEG_BCB"
  # WS1 del satélite exige un JWT RS256 tipo "bcb-system" (lo emitiría BCB).
  ensure_keypair "$LEG_WS1"
  # El satélite firma sus llamadas SALIENTES al adapter (webhooks de venta/canje).
  # Desde el refactor de secretos, sin esta llave `AdapterNotifierService` ni
  # siquiera intenta el POST: falla al cargar el PEM y la venta se queda en el
  # outbox, así que WS2 nunca llega a BCB.
  ensure_keypair "$LEG_VA_ADAPTER"
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
print('ok' if 'VENTAABORDO_VENTAS_STREAM' in names else 'missing')")
  [ "$ok_stream" = "ok" ] || die "VENTAABORDO_VENTAS_STREAM no quedó creado"
  ok "VENTAABORDO_VENTAS_STREAM + DLQ presentes"

  step "Postgres de BCB"
  wait_for "Postgres BCB listo" 60 pg_ready "$BCB_DB_CONTAINER" "$BCB_DB_USER" "$BCB_DB_NAME" \
    || die "la BD de BCB no está arriba — corré primero: ./e2e up tomtom"
  ( cd "$REPO_BCB" && DATABASE_URL="$BCB_DB_URL" pnpm exec prisma migrate deploy >/dev/null 2>&1 ) \
    || die "prisma migrate deploy (BCB) falló"
  # Misma trampa que el jar viejo: cambiar de rama deja el client desincronizado.
  ( cd "$REPO_BCB" && pnpm exec prisma generate >/dev/null 2>&1 ) || die "prisma generate (BCB) falló"
  ok "esquema y client de BCB al día"

  step "Postgres del satélite Venta a Bordo (:5435)"
  [ -f "$REPO_SAT/.env" ] || cp "$REPO_SAT/.env.example" "$REPO_SAT/.env"
  ( cd "$REPO_SAT" && docker compose up -d db >/dev/null 2>&1 ) || die "no pude levantar la BD del satélite"
  wait_for "Postgres satélite listo" 60 pg_ready "$SAT_DB_CONTAINER" venta venta_abordo || return 1
  ( cd "$REPO_SAT" && DATABASE_URL="$SAT_DB_URL" npx prisma migrate deploy >/dev/null 2>&1 ) \
    || die "migraciones del satélite fallaron"
  ( cd "$REPO_SAT" && npx prisma generate >/dev/null 2>&1 ) || die "prisma generate (satélite) falló"
  ok "esquema y client del satélite al día"

  step "Compilación de los adapters"
  local jar_bcb="$REPO_MAIN/adapter-bcb/target/adapter-bcb-1.0.0-SNAPSHOT.jar"
  local jar_va="$REPO_MAIN/adapter-ventaabordo/target/adapter-ventaabordo-1.0.0-SNAPSHOT.jar"
  local to_build=()
  jar_is_stale "$jar_bcb" "$REPO_MAIN/adapter-bcb/src/main" "$REPO_MAIN/shared/src/main" && to_build+=("adapter-bcb")
  jar_is_stale "$jar_va"  "$REPO_MAIN/adapter-ventaabordo/src/main" "$REPO_MAIN/shared/src/main" && to_build+=("adapter-ventaabordo")
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

  step "Configuración del satélite (.env)"
  # El SmartMac real es un tercero sin sandbox; se apunta al falso del harness.
  # Igual que en tomtom, se descartan líneas que no sean CLAVE=/comentario/vacío:
  # un PEM partido por un `sed` rompe la lectura del .env por docker compose.
  # El guard del satélite espera JWT_PUBLIC_KEY_<NOMBRE> con el PEM en BASE64
  # (no el PEM crudo) y prueba todas las que encuentre.
  local ws1_pub_b64
  ws1_pub_b64=$(base64 < "$(key_path "$LEG_WS1-public.pem")" | tr -d '\n')

  # El satélite cambió el contrato de SmartMac (Basic Auth contra Papeletascloud,
  # tanto de salida como de entrada) y renombró sus variables. Cuál se escribe se
  # decide leyendo el repo, no fijándolo acá: mientras la rama no esté en develop,
  # el harness tiene que funcionar en las dos, y escribir el set equivocado deja al
  # satélite arrancando con todo vacío —el guard falla cerrado y TODO da 401 sin
  # decir por qué.
  local contrato="jwt"
  [ -f "$REPO_SAT/src/shared/guards/smartmac-basic-auth.guard.ts" ] && contrato="basic"
  dim "   contrato de SmartMac detectado: $contrato"

  python3 - "$REPO_SAT/.env" "$SAT_DB_URL" "$PORT_ADAPTER_VA" "$PORT_FAKE_SMARTMAC" "$PORT_SAT" \
           "$ws1_pub_b64" "$contrato" "$SMARTMAC_INBOUND_USER" "$SMARTMAC_INBOUND_PASS" \
           "$(key_path "$LEG_VA_ADAPTER-private-pkcs8.pem")" <<'PY'
import sys, re
path, dburl, adapter_port, fake_port, sat_port, ws1_pub_b64, contrato, in_user, in_pass, va_key = sys.argv[1:11]
vals = {
    'DATABASE_URL': dburl,
    'PORT': sat_port,
    'JWT_PUBLIC_KEY_BCB': ws1_pub_b64,
    'ADAPTER_VENTAABORDO_URL': f'http://localhost:{adapter_port}',
    # RUTA del PEM, no el PEM: así lo espera AdapterJwtKeyProvider en local.
    # Sin esto el satélite ni siquiera intenta el POST al adapter y la venta de
    # WS2 se queda en su outbox, sin llegar nunca a BCB.
    'SECRET_PEM_VENTAABORDO_JWT_PRIVATE_KEY': va_key,
    'SMARTMAC_TIMEOUT_MS': '4000',
    # Sin espera de gracia: el reintento de WS1 debe poder observarse en una prueba.
    'SMARTMAC_REENVIO_GRACIA_MS': '1000',
}
if contrato == 'basic':
    vals.update({
        # WS1 saliente: una sola URL completa (ya no base + path) con Basic Auth.
        # Apunta al SmartMac falso, que ignora las credenciales.
        'SMARTMAC_WS1_URL': f'http://127.0.0.1:{fake_port}/WS/Papeletascloud.php',
        'SMARTMAC_WS1_BASIC_USERNAME': 'e2e',
        'SMARTMAC_WS1_BASIC_PASSWORD': 'e2e',
        # Credencial ENTRANTE (la que SmartMac usa para llamarnos). Valores
        # desechables del harness: no se leen los del .env porque pueden ser los
        # reales de TECNITRANS, y una prueba local no tiene por qué tocarlos.
        'SMARTMAC_INBOUND_BASIC_USERNAME': in_user,
        'SMARTMAC_INBOUND_BASIC_PASSWORD': in_pass,
    })
else:
    vals.update({
        'SMARTMAC_BASE_URL': f'http://127.0.0.1:{fake_port}',
        'SMARTMAC_WS1_PATH': '/SM/API_TEST',
        'SMARTMAC_WS1_AUTH_MODE': 'none',
        'SMARTMAC_USERNAME': 'e2e',
        'SMARTMAC_PASSWORD': 'e2e',
    })
seen, out = set(), []
for ln in open(path).read().splitlines():
    m = re.match(r'^([A-Z0-9_]+)=', ln)
    if m:
        k = m.group(1)
        out.append(f'{k}={vals[k]}' if k in vals else ln)
        if k in vals: seen.add(k)
    elif ln.strip() == '' or ln.lstrip().startswith('#'):
        out.append(ln)
for k, v in vals.items():
    if k not in seen: out.append(f'{k}={v}')
open(path, 'w').write('\n'.join(out) + '\n')
PY
  ok ".env del satélite configurado (gitignored)"

  step "Servicios"
  local seed_va; seed_va=$(grep -m1 '^VENTAABORDO_SECRET_NATS_SEED=' "$REPO_MAIN/.env" | cut -d= -f2)
  [ -n "$seed_va" ] || die "falta VENTAABORDO_SECRET_NATS_SEED en $REPO_MAIN/.env"

  # adapter-ventaabordo: recibe los webhooks del satélite y publica a JetStream.
  #
  # `JWT_BYPASS=true` solo afecta a los tokens ENTRANTES. La llave de SALIDA es otra
  # cosa y hay que configurarla igual: cuando el despacho llega por la cadena real
  # (BCB → adapter-bcb → NATS → acá → satélite), este adaptador firma su propio JWT
  # para llamar a WS1. Sin llave llama sin `Authorization` y el satélite responde
  # 401 "Token de acceso no proporcionado" — la tarjeta nunca llega y el error solo
  # se ve en este log. No lo detectaban las pruebas porque el caso de WS1 le pega al
  # satélite directo, sin pasar por acá; lo ejercita el panel `./e2e demo`.
  #
  # Se firma con la MISMA llave privada cuya pública ya viaja como JWT_PUBLIC_KEY_BCB
  # en el .env del satélite: su guard acepta cualquier RS256 válido contra las llaves
  # que conoce, sin exigir `iss`/`aud`.
  local ws1_priv_json
  ws1_priv_json=$(python3 -c 'import json,sys; print(json.dumps({"privateKey": open(sys.argv[1]).read()}))' \
    "$(key_path "$LEG_WS1-private-pkcs8.pem")")

  if is_running adapter-ventaabordo; then
    dim "   adapter-ventaabordo ya corriendo"
  else
    stop_bg adapter-ventaabordo
    ensure_port_free "$PORT_ADAPTER_VA" adapter-ventaabordo
    ( cd "$REPO_MAIN" && \
      SPRING_PROFILES_ACTIVE=local SERVER_PORT="$PORT_ADAPTER_VA" NATS_URL="$NATS_URL" \
      SECRETS_SOURCE=local DB_SECRET=db-local \
      DB_SECRET_KEY_VALUE='{"username":"biger","password":"biger_local"}' \
      NATS_NKEY_SECRET=nats-nkey-ventaabordo NATS_NKEY_SECRET_KEY_VALUE="{\"seed\":\"$seed_va\"}" \
      SPRING_DATASOURCE_URL="jdbc:postgresql://localhost:5433/db_biger" \
      SATELLITE_VENTAABORDO_URL="http://localhost:$PORT_SAT" \
      VENTAABORDO_AUTH_PRIVATE_KEY_SECRET=ventaabordo-jwt-local \
      VENTAABORDO_AUTH_PRIVATE_KEY_SECRET_KEY_VALUE="$ws1_priv_json" \
      JWT_BYPASS=true OTLP_TRACES_ENABLED=false \
      start_bg adapter-ventaabordo "$LOG_DIR/adapter-ventaabordo.log" \
        java -jar "$REPO_MAIN/adapter-ventaabordo/target/adapter-ventaabordo-1.0.0-SNAPSHOT.jar" )
  fi

  # adapter-bcb y app bcb: compartidos con tomtom/ticketcolectoroffline (ver
  # lib/common.sh). La Consulta de tarjetas de viaje por operador (PR #1547) los
  # necesita a los dos: adapter-bcb resuelve biger.bcb.abordaje.trips.list contra
  # el app bcb de verdad, no contra un mock — sin esto el chequeo de `caja`
  # (CashRegister.deviceIdentifier) nunca se ejerce de punta a punta.
  start_adapter_bcb "$REPO_MAIN" "http://localhost:$PORT_BCB_APP" \
    "http://localhost:$PORT_BCB_WEBHOOKS" "$LEG_BCB"
  start_bcb_app "$REPO_BCB" "$PORT_BCB_APP" "$BCB_DB_URL" "$LEG_BCB"

  # Satélite Venta a Bordo. Apunta al SmartMac falso por env; ese falso lo levanta
  # el proceso de pruebas (así puede forzar un rechazo y leer el payload que sale),
  # así que entre corridas el satélite vería conexión rechazada — solo importa
  # cuando WS1 dispara, que es dentro de una prueba.
  if is_running satelite-va; then
    dim "   satélite Venta a Bordo ya corriendo"
  else
    stop_bg satelite-va
    ensure_port_free "$PORT_SAT" "satélite Venta a Bordo"
    ( cd "$REPO_SAT" && \
      start_bg satelite-va "$LOG_DIR/satelite-va.log" \
        npx nest start )
  fi

  # App `webhooks` de BCB: es OTRA app del monorepo, la que recibe la venta de
  # SmartMac. En AWS el prefijo /webhooks lo agrega el API Gateway; en local la app
  # escucha sin prefijo, y el catálogo del adapter apunta a /smartmac/venta-abordo.
  if is_running bcb-webhooks; then
    dim "   app webhooks ya corriendo"
  else
    stop_bg bcb-webhooks
    ensure_port_free "$PORT_BCB_WEBHOOKS" "app webhooks"
    ( cd "$REPO_BCB" && \
      DATABASE_URL="$BCB_DB_URL" NODE_ENV=development AWS_REGION=us-west-2 PORT="$PORT_BCB_WEBHOOKS" \
      start_bg bcb-webhooks "$LOG_DIR/bcb-webhooks.log" \
        pnpm exec nest start webhooks )
  fi

  step "Health"
  wait_for "adapter-ventaabordo :$PORT_ADAPTER_VA" 90 http_ok "http://localhost:$PORT_ADAPTER_VA/ventaabordo/health" || return 1
  wait_for "adapter-bcb :$PORT_ADAPTER_BCB" 90 http_ok "http://localhost:$PORT_ADAPTER_BCB/actuator/health" || return 1
  wait_for "app webhooks :$PORT_BCB_WEBHOOKS" 120 port_busy "$PORT_BCB_WEBHOOKS" || return 1
  wait_for "app bcb :$PORT_BCB_APP" 120 bash -c \
    "curl -s -o /dev/null -w '%{http_code}' http://localhost:$PORT_BCB_APP/abordaje/trips | grep -qE '401|400'" || return 1
  # Prefijo global /venta-abordo (APP_PREFIX en su main.ts); el catálogo del
  # adapter también lo incluye, así que las rutas reales lo llevan.
  wait_for "satélite Venta a Bordo :$PORT_SAT" 120 http_ok "http://localhost:$PORT_SAT/venta-abordo/health" || return 1

  if grep -q "VENTAABORDO_VENTAS_STREAM" "$LOG_DIR/adapter-bcb.log" 2>/dev/null; then
    ok "consumer durable ventaabordo-ventas-workers enlazado"
  else
    warn "adapter-bcb no reporta el consumer de ventas — revisá $LOG_DIR/adapter-bcb.log"
  fi
  if grep -q "biger.bcb.abordaje.trips.list" "$LOG_DIR/adapter-bcb.log" 2>/dev/null; then
    ok "suscripción a biger.bcb.abordaje.trips.list enlazada (Consulta de tarjetas de viaje)"
  else
    warn "adapter-bcb no reporta la suscripción de abordaje/trips — revisá $LOG_DIR/adapter-bcb.log"
  fi

  printf '\n'; ok "stack arriba"
  dim "   el SmartMac falso (:$PORT_FAKE_SMARTMAC) lo levanta el proceso de pruebas"
}

# ── down / status / psql ───────────────────────────────────────────────────
flow_down() {
  local all=0
  for a in "$@"; do [ "$a" = "--all" ] && all=1; done

  step "Deteniendo servicios del flujo"
  stop_bg satelite-va
  stop_bg bcb-webhooks
  stop_bg adapter-ventaabordo
  kill_port "$PORT_BCB_WEBHOOKS"
  kill_port "$PORT_ADAPTER_VA"
  kill_port "$PORT_SAT"
  ungraft_all
  dim "   adapter-bcb y app bcb se dejan arriba: los comparte el flujo tomtom"

  if [ "$all" -eq 1 ]; then
    step "Deteniendo infraestructura compartida (--all)"
    stop_bg bcb-app;     kill_port "$PORT_BCB_APP"
    stop_bg adapter-bcb; kill_port "$PORT_ADAPTER_BCB"
    ( cd "$REPO_SAT" && docker compose stop >/dev/null 2>&1 ) && ok "BD del satélite detenida"
  fi
}

flow_status() {
  step "Estado"
  chk() {
    local label="$1"; shift
    if "$@" >/dev/null 2>&1; then printf '  %-38s %s\n' "$label" "${C_GREEN}arriba${C_RESET}"
    else printf '  %-38s %s\n' "$label" "${C_RED}abajo${C_RESET}"; fi
  }
  chk "NATS (:4222/:8222)"                 http_ok "$NATS_MONITOR/healthz?js-server-only=true"
  chk "Postgres BIGER (:5433)"             pg_ready "$BIGER_DB_CONTAINER" biger db_biger
  chk "Postgres BCB (:5436)"               pg_ready "$BCB_DB_CONTAINER" "$BCB_DB_USER" "$BCB_DB_NAME"
  chk "Postgres satélite VA (:5435)"       pg_ready "$SAT_DB_CONTAINER" venta venta_abordo
  chk "satélite Venta a Bordo (:$PORT_SAT)"     http_ok "http://localhost:$PORT_SAT/venta-abordo/health"
  chk "adapter-ventaabordo (:$PORT_ADAPTER_VA)" http_ok "http://localhost:$PORT_ADAPTER_VA/ventaabordo/health"
  chk "adapter-bcb (:$PORT_ADAPTER_BCB)"   http_ok "http://localhost:$PORT_ADAPTER_BCB/actuator/health"
  chk "app webhooks (:$PORT_BCB_WEBHOOKS)" port_busy "$PORT_BCB_WEBHOOKS"
  chk "app bcb (:$PORT_BCB_APP)"           port_busy "$PORT_BCB_APP"
  printf '\n'
  printf '  %-38s %s\n' "ventas a bordo en BCB" "$(bcb_sql "SELECT count(*) FROM \"BoardingSale\";")"
}

flow_psql() {
  docker exec -it "$SAT_DB_CONTAINER" psql -U venta -d venta_abordo
}
