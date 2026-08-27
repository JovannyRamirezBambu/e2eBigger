#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2317
FLOW_DESC="CU04/CU05 — geocercas TomTom/InRoute: despacho y llegada reales hacia BCB"

# ── Repos ──────────────────────────────────────────────────────────────────
REPO_BCB="$ER_ROOT/BCB_EstrellaRoja_Backend"
REPO_MAIN="$ER_ROOT/BIGER_EstrellaRoja_Main"
REPO_SAT="$ER_ROOT/BIGER_EstrellaRoja_TomTom"

# ── Infraestructura ────────────────────────────────────────────────────────
BCB_DB_CONTAINER="bcb-local-db"
BCB_DB_PORT=5436
BCB_DB_USER="bcb"; BCB_DB_PASS="bcb"; BCB_DB_NAME="bcb"
BCB_DB_URL="postgresql://$BCB_DB_USER:$BCB_DB_PASS@localhost:$BCB_DB_PORT/$BCB_DB_NAME"

BIGER_DB_CONTAINER="postgres"
BIGER_DB_URL="jdbc:postgresql://localhost:5433/db_biger"

SAT_DB_URL="postgresql://postgres:password@localhost:5440/biger_tomtom"

NATS_URL="nats://localhost:4222"
NATS_MONITOR="http://localhost:8222"

PORT_ADAPTER_BCB=8085
PORT_ADAPTER_TOMTOM=8090   # 8088 lo reserva adapter-ventaabordo (ver docker-compose)
PORT_BCB_APP=3009
PORT_SAT=3003              # satélite TomTom (3001 es Venta a Bordo, 3002 portalagencias)

# InRoute falso (contrato REAL verificado contra el sandbox de Adsum). Lo levanta
# este flujo en modo standalone — las cadenas CU01/T12 lo necesitan; el panel
# (./e2e demo tomtom) usa su propia instancia en el mismo puerto.
PORT_FAKE_INROUTE=7803

# Legs de autenticación: cada uno es un par RSA independiente, como en AWS.
LEG_SAT="tomtom-sat"      # satélite TomTom → adapter-tomtom (callbacks CU04/CU05)
LEG_ADAPTER="adapter-tt"  # adapter-tomtom → satélite TomTom (viaje.crear/actualizar/cancelar)
LEG_BCB="adapter-bcb"     # adapter-bcb    → satélite BCB

# ── Helpers de infraestructura ──────────────────────────────────────────────
# Los helpers de prueba (HTTP firmado, asertos, escenarios, esperas) se fueron a
# src/flows/tomtom/ en TypeScript. Acá solo queda lo que necesita el propio
# levantamiento.
bcb_sql() { # bcb_sql <query>  → escalar / filas crudas
  docker exec "$BCB_DB_CONTAINER" psql -U "$BCB_DB_USER" -d "$BCB_DB_NAME" -tA -c "$1" 2>/dev/null
}

# ── up ─────────────────────────────────────────────────────────────────────
flow_up() {
  local reset=0
  for a in "$@"; do [ "$a" = "--reset" ] && reset=1; done

  step "Preflight"
  for c in docker mvn node npx pnpm openssl curl python3; do need_cmd "$c"; done
  for r in "$REPO_BCB" "$REPO_MAIN" "$REPO_SAT"; do [ -d "$r" ] || die "no encuentro el repo: $r"; done
  ok "comandos y repos presentes"

  step "Llaves de prueba"
  ensure_keypair "$LEG_SAT"
  ensure_keypair "$LEG_ADAPTER"
  ensure_keypair "$LEG_BCB"
  dim "   run/keys/ — solo para local, nunca credenciales reales"

  step "Infraestructura BIGER (Postgres + NATS x3 + adapter-invoice)"
  ( cd "$REPO_MAIN" && docker compose up -d adapter-invoice >/dev/null 2>&1 ) \
    || die "no pude levantar la infra de BIGER"
  wait_for "NATS respondiendo" 60 http_ok "$NATS_MONITOR/healthz?js-server-only=true" || return 1
  wait_for "Postgres BIGER listo" 60 pg_ready "$BIGER_DB_CONTAINER" biger db_biger || return 1

  step "Streams de JetStream"
  # No se auto-crean. Sin esto el publish da 503 y el consumer durable nunca enlaza.
  ( cd "$REPO_MAIN" && make nats-init >/dev/null 2>&1 ) || die "make nats-init falló"
  local streams
  streams=$(curl -s "$NATS_MONITOR/jsz?streams=true" | python3 -c "
import json,sys
d=json.load(sys.stdin)
names=[s['name'] for a in d.get('account_details',[]) for s in a.get('stream_detail',[])]
print('ok' if 'TOMTOM_GEOCERCAS_STREAM' in names else 'missing')")
  [ "$streams" = "ok" ] || die "TOMTOM_GEOCERCAS_STREAM no quedó creado"
  ok "TOMTOM_GEOCERCAS_STREAM + DLQ presentes"

  step "Postgres de BCB (:$BCB_DB_PORT)"
  if ! docker inspect "$BCB_DB_CONTAINER" >/dev/null 2>&1; then
    docker run -d --name "$BCB_DB_CONTAINER" \
      -e POSTGRES_DB="$BCB_DB_NAME" -e POSTGRES_USER="$BCB_DB_USER" -e POSTGRES_PASSWORD="$BCB_DB_PASS" \
      -p "$BCB_DB_PORT:5432" postgres:16-alpine >/dev/null || die "no pude crear $BCB_DB_CONTAINER"
    ok "contenedor $BCB_DB_CONTAINER creado"
  elif [ "$(docker inspect -f '{{.State.Status}}' "$BCB_DB_CONTAINER")" != "running" ]; then
    docker start "$BCB_DB_CONTAINER" >/dev/null; ok "contenedor $BCB_DB_CONTAINER reiniciado"
  fi
  wait_for "Postgres BCB listo" 60 pg_ready "$BCB_DB_CONTAINER" "$BCB_DB_USER" "$BCB_DB_NAME" || return 1

  if [ "$reset" -eq 1 ]; then
    warn "--reset: recreando la base '$BCB_DB_NAME' (se pierde todo lo que haya)"
    docker exec "$BCB_DB_CONTAINER" psql -U "$BCB_DB_USER" -d postgres \
      -c "DROP DATABASE IF EXISTS $BCB_DB_NAME WITH (FORCE);" >/dev/null
    docker exec "$BCB_DB_CONTAINER" psql -U "$BCB_DB_USER" -d postgres \
      -c "CREATE DATABASE $BCB_DB_NAME;" >/dev/null
  fi

  step "Migraciones de BCB"
  local tracked tables
  tracked=$(bcb_sql "SELECT to_regclass('public._prisma_migrations') IS NOT NULL;")
  tables=$(bcb_sql "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';")
  if [ "$tracked" != "t" ] && [ "${tables:-0}" -gt 0 ]; then
    die "la base tiene $tables tablas pero sin historial de Prisma (P3005).
     Se aplicó con 'db push' en algún momento. Corré:  ./e2e up tomtom --reset"
  fi
  ( cd "$REPO_BCB" && DATABASE_URL="$BCB_DB_URL" pnpm exec prisma migrate deploy >/dev/null 2>&1 ) \
    || die "prisma migrate deploy falló (ver: cd $REPO_BCB && DATABASE_URL=... pnpm exec prisma migrate deploy)"
  ok "esquema al día ($(bcb_sql "SELECT count(*) FROM _prisma_migrations;") migraciones)"

  # Regenerar SIEMPRE el client: es la misma trampa que el jar viejo, con otra
  # cara. Cambiar de rama (o cualquier `prisma generate` desde una rama sin las
  # columnas nuevas — el hook de pre-push lo hace) deja un client que no compila
  # contra el código actual, y la app muere con errores de tipos sin relación
  # aparente. Tarda menos de un segundo.
  ( cd "$REPO_BCB" && pnpm exec prisma generate >/dev/null 2>&1 ) \
    || die "prisma generate falló"
  ok "client de Prisma regenerado desde el schema actual"

  # Catálogos base (State, AdminsDepartment, roles…) que el seed del flujo asume.
  if [ "$(bcb_sql "SELECT count(*) FROM \"State\";")" = "0" ]; then
    ( cd "$REPO_BCB" && DATABASE_URL="$BCB_DB_URL" pnpm prisma:local:db:seed >/dev/null 2>&1 ) \
      || die "el seed oficial de BCB falló"
    ok "catálogos base sembrados (seed oficial del repo)"
  else
    dim "   catálogos base ya presentes"
  fi

  # El .env se arma ANTES de tocar docker compose: compose lee ese mismo archivo
  # para resolver las vars del servicio db y aborta si tiene líneas inválidas.
  step "Configuración del satélite (.env)"
  # El satélite valida estas vars de forma eager al bootear TomtomModule, aunque
  # CU04/CU05 no toquen InRoute.
  [ -f "$REPO_SAT/.env" ] || cp "$REPO_SAT/.env.example" "$REPO_SAT/.env"
  local sat_priv adapter_pub
  sat_priv=$(pem_escaped "$(key_path "$LEG_SAT-private.pem")")
  # JWT_PUBLIC_KEY es la llave con la que el satélite valida lo que le ENTRA, y lo
  # que le entra lo firma adapter-tomtom: va la pública de ese leg, no la suya.
  adapter_pub=$(pem_escaped "$(key_path "$LEG_ADAPTER-public.pem")")
  python3 - "$REPO_SAT/.env" "$sat_priv" "$adapter_pub" "$PORT_ADAPTER_TOMTOM" "$SAT_DB_URL" \
           "$PORT_SAT" "$PORT_FAKE_INROUTE" <<'PY'
import sys, re
path, priv, pub, adapter_port, dburl, sat_port, inroute_port = sys.argv[1:8]
vals = {
    'DATABASE_URL': f'"{dburl}"',
    'PORT': sat_port,
    'BIGER_ADAPTER_TOMTOM_URL': f'http://localhost:{adapter_port}',
    'TOMTOM_CALLBACK_PRIVATE_KEY': f'"{priv}"',
    'TOMTOM_CALLBACK_JWT_ISSUER': 'biger-tomtom-satellite',
    'JWT_PUBLIC_KEY': f'"{pub}"',
    # InRoute falso del panel de demostración (./e2e demo tomtom). Las pruebas de
    # CU04/CU05 no lo tocan; el panel sí, y ahí es donde el ciclo completo se ve.
    # InRoute falso con el contrato REAL (lo levanta este mismo flujo). Las
    # credenciales Basic NO se tocan: si el usuario tiene las del sandbox en su
    # .env, se conservan — el simulador ignora la autenticación.
    'INROUTE_BASE_URL': f'http://127.0.0.1:{inroute_port}',
    # CU03: el simulador y las pruebas empujan eventos al webhook con este token.
    'INROUTE_WEBHOOK_TOKEN': 'e2e-webhook-token',
    'SCHEDULER_ENABLED': 'false',
}
seen = set()
out = []
for ln in open(path).read().splitlines():
    m = re.match(r'^([A-Z0-9_]+)=', ln)
    if m:
        k = m.group(1)
        if k in vals:
            out.append(f'{k}={vals[k]}'); seen.add(k)
        else:
            out.append(ln)
    elif ln.strip() == '' or ln.lstrip().startswith('#'):
        out.append(ln)
    # Cualquier otra cosa se descarta: solo puede ser el resto de un PEM que
    # quedó partido en líneas reales (p. ej. por un `sed` cuyo reemplazo tenía
    # `\n`, que sed convierte en salto de línea). Docker compose falla al leer
    # el .env con esas líneas huérfanas.
for k, v in vals.items():
    if k not in seen:
        out.append(f'{k}={v}')
open(path, 'w').write('\n'.join(out) + '\n')
PY
  ok ".env del satélite configurado (gitignored)"

  step "Postgres del satélite TomTom (:5440)"
  ( cd "$REPO_SAT" && docker compose up -d db >/dev/null 2>&1 ) || die "no pude levantar la BD del satélite"
  wait_for "Postgres satélite listo" 60 pg_ready biger_estrellaroja_tomtom-db-1 postgres biger_tomtom || return 1
  ( cd "$REPO_SAT" && DATABASE_URL="$SAT_DB_URL" npx prisma migrate deploy >/dev/null 2>&1 ) \
    || die "migraciones del satélite fallaron"
  ok "esquema del satélite al día"

  step "Compilación de los adapters"
  # Trampa #1 del monorepo: un jar viejo arranca sin error pero NO trae los
  # consumers agregados después de compilarlo. Se revisa por fecha, no por fe.
  local jar_bcb="$REPO_MAIN/adapter-bcb/target/adapter-bcb-1.0.0-SNAPSHOT.jar"
  local jar_tt="$REPO_MAIN/adapter-tomtom/target/adapter-tomtom-1.0.0-SNAPSHOT.jar"
  local to_build=()
  jar_is_stale "$jar_bcb" "$REPO_MAIN/adapter-bcb/src/main" "$REPO_MAIN/shared/src/main" && to_build+=("adapter-bcb")
  jar_is_stale "$jar_tt"  "$REPO_MAIN/adapter-tomtom/src/main" "$REPO_MAIN/shared/src/main" && to_build+=("adapter-tomtom")
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

  step "Servicios"
  local nats_seed_bcb nats_seed_tt
  nats_seed_bcb=$(grep -m1 '^BCB_SECRET_NATS_SEED=' "$REPO_MAIN/.env" | cut -d= -f2)
  nats_seed_tt=$(grep -m1 '^TOMTOM_SECRET_NATS_SEED=' "$REPO_MAIN/.env" | cut -d= -f2)
  [ -n "$nats_seed_bcb" ] && [ -n "$nats_seed_tt" ] || die "faltan las seeds NKEY en $REPO_MAIN/.env"

  # adapter-tomtom — dos direcciones en el mismo proceso:
  #   entrante  ← callbacks del satélite (CU04/CU05). JWT_BYPASS=false a propósito:
  #     así se ejerce la verificación real de la firma del satélite (leg tomtom-sat).
  #   saliente  → llamadas al satélite al consumir biger.tomtom.viaje.* Firma con la
  #     privada del leg adapter-tt, cuya pública quedó en el .env del satélite.
  #     Sin esto el adaptador llama sin `Authorization` y el satélite responde 401:
  #     el mismo agujero que tuvo adapter-ventaabordo y que solo se ve en este log.
  if is_running adapter-tomtom; then
    dim "   adapter-tomtom ya corriendo"
  else
    stop_bg adapter-tomtom
    ensure_port_free "$PORT_ADAPTER_TOMTOM" adapter-tomtom
    local tt_priv_json
    tt_priv_json=$(python3 -c 'import json,sys; print(json.dumps({"privateKey": open(sys.argv[1]).read()}))' \
      "$(key_path "$LEG_ADAPTER-private-pkcs8.pem")")
    ( cd "$REPO_MAIN" && \
      SPRING_PROFILES_ACTIVE=local SERVER_PORT="$PORT_ADAPTER_TOMTOM" NATS_URL="$NATS_URL" \
      SECRETS_SOURCE=local DB_SECRET=db-local \
      DB_SECRET_KEY_VALUE='{"username":"biger","password":"biger_local"}' \
      NATS_NKEY_SECRET=nats-nkey-tomtom NATS_NKEY_SECRET_KEY_VALUE="{\"seed\":\"$nats_seed_tt\"}" \
      SPRING_DATASOURCE_URL="$BIGER_DB_URL" \
      JWT_BYPASS=false JWT_PUBLIC_KEY="$(pem_escaped "$(key_path "$LEG_SAT-public.pem")")" \
      SATELLITE_TOMTOM_URL="http://localhost:$PORT_SAT" \
      TOMTOM_AUTH_PRIVATE_KEY_SECRET=tomtom-jwt-local \
      TOMTOM_AUTH_PRIVATE_KEY_SECRET_KEY_VALUE="$tt_priv_json" \
      TOMTOM_AUTH_SUBJECT=adapter-tomtom \
      OTLP_TRACES_ENABLED=false \
      start_bg adapter-tomtom "$LOG_DIR/adapter-tomtom.log" \
        java -jar "$REPO_MAIN/adapter-tomtom/target/adapter-tomtom-1.0.0-SNAPSHOT.jar" )
  fi

  # adapter-bcb es infraestructura compartida: vive en lib/common.sh porque todos
  # los flujos lo usan y el proceso es uno solo.
  start_adapter_bcb "$REPO_MAIN" "http://localhost:$PORT_BCB_APP" \
    "http://localhost:${PORT_BCB_WEBHOOKS:-3011}" "$LEG_BCB"

  # app bcb — el satélite BCB de verdad, con el guard real. El bootstrap es
  # compartido (lib/), porque este mismo proceso lo usa ticketcolectoroffline.
  start_bcb_app "$REPO_BCB" "$PORT_BCB_APP" "$BCB_DB_URL" "$LEG_BCB"

  # InRoute falso standalone: el satélite resuelve catálogos y registra orden+viaje
  # contra él en las cadenas CU01/T12. Contrato real (cDriverNo, nGeoCerca*, 3008,
  # 3016-como-500, motivosCancelacion caído, DELETE /ordenes 405).
  if is_running fake-inroute; then
    dim "   InRoute falso ya corriendo"
  else
    stop_bg fake-inroute
    ensure_port_free "$PORT_FAKE_INROUTE" "InRoute falso"
    ( cd "$ER_ROOT/e2e" &&       start_bg fake-inroute "$LOG_DIR/fake-inroute.log"         node demo-tomtom/inroute-standalone.cjs )
  fi

  # Satélite TomTom. Recibe POST /tomtom/viajes del adaptador (CU01), el webhook
  # de eventos de geocerca (CU03, empujado — el polling ya no existe) y expone el
  # disparador del sync de telemetría (T12).
  if is_running satelite-tomtom; then
    dim "   satélite TomTom ya corriendo"
  else
    stop_bg satelite-tomtom
  stop_bg fake-inroute
    ensure_port_free "$PORT_SAT" "satélite TomTom"
    ( cd "$REPO_SAT" && \
      start_bg satelite-tomtom "$LOG_DIR/satelite-tomtom.log" \
        npx nest start )
  fi

  step "Health"
  wait_for "adapter-tomtom :$PORT_ADAPTER_TOMTOM" 90 http_ok "http://localhost:$PORT_ADAPTER_TOMTOM/actuator/health" || return 1
  wait_for "adapter-bcb :$PORT_ADAPTER_BCB"       90 http_ok "http://localhost:$PORT_ADAPTER_BCB/actuator/health" || return 1
  wait_for "app bcb :$PORT_BCB_APP" 90 bash -c \
    "curl -s -o /dev/null -w '%{http_code}' http://localhost:$PORT_BCB_APP/corridas/x/despachar -X POST | grep -qE '401|400'" || return 1
  wait_for "InRoute falso :$PORT_FAKE_INROUTE" 30 http_ok "http://localhost:$PORT_FAKE_INROUTE/__e2e/estado" || return 1
  wait_for "satélite TomTom :$PORT_SAT" 150 http_ok "http://localhost:$PORT_SAT/tomtom/health" || return 1
  # …y que el guard siga cerrando lo autenticado (la llave pública cargó bien).
  wait_for "satélite TomTom guard JWT" 30 bash -c \
    "curl -s -o /dev/null -w '%{http_code}' http://localhost:$PORT_SAT/tomtom/viajes | grep -q 401" || return 1

  if ! grep -q "TOMTOM_GEOCERCAS_STREAM" "$LOG_DIR/adapter-bcb.log" 2>/dev/null; then
    warn "adapter-bcb no reporta el consumer de geocercas — revisá $LOG_DIR/adapter-bcb.log"
  else
    ok "consumer durable tomtom-geocercas-workers enlazado"
  fi

  printf '\n'; ok "stack arriba"
  dim "   InRoute falso standalone arriba en :$PORT_FAKE_INROUTE — el panel (./e2e demo tomtom) usa el suyo"
}

# ── seed / test / verify / probe ────────────────────────────────────────────
# Ya no viven acá: están en src/flows/tomtom/ (TypeScript), y el entrypoint los
# despacha con `tsx src/cli.ts`. Bash se quedó con lo que hace bien —docker,
# maven, puertos, procesos— y dejó de armar JSON y SQL a mano.

# ── down / status / psql ───────────────────────────────────────────────────
flow_down() {
  local all=0
  for a in "$@"; do [ "$a" = "--all" ] && all=1; done

  step "Deteniendo servicios del flujo"
  stop_bg bcb-app
  stop_bg adapter-bcb
  stop_bg adapter-tomtom
  stop_bg satelite-tomtom
  stop_bg fake-inroute
  # …y los huérfanos que el pid registrado no cubre (wrappers tipo `pnpm exec`).
  kill_port "$PORT_BCB_APP"
  kill_port "$PORT_ADAPTER_BCB"
  kill_port "$PORT_ADAPTER_TOMTOM"
  kill_port "$PORT_SAT"
  kill_port "$PORT_FAKE_INROUTE"
  ungraft_all
  ok "scripts temporales removidos de los repos"

  if [ "$all" -eq 1 ]; then
    step "Deteniendo infraestructura compartida (--all)"
    ( cd "$REPO_MAIN" && docker compose stop >/dev/null 2>&1 ) && ok "compose de BIGER detenido"
    ( cd "$REPO_SAT" && docker compose stop >/dev/null 2>&1 ) && ok "BD del satélite detenida"
    docker stop "$BCB_DB_CONTAINER" >/dev/null 2>&1 && ok "BD de BCB detenida"
  else
    dim "   la infra compartida sigue arriba (otros flujos la usan) — './e2e down tomtom --all' para bajarla"
  fi
}

flow_status() {
  step "Estado"
  local rows=()
  chk() { # chk <etiqueta> <comando...>
    local label="$1"; shift
    if "$@" >/dev/null 2>&1; then printf '  %-34s %s\n' "$label" "${C_GREEN}arriba${C_RESET}"
    else printf '  %-34s %s\n' "$label" "${C_RED}abajo${C_RESET}"; fi
  }
  chk "NATS (:4222/:8222)"            http_ok "$NATS_MONITOR/healthz?js-server-only=true"
  chk "Postgres BIGER (:5433)"        pg_ready "$BIGER_DB_CONTAINER" biger db_biger
  chk "Postgres BCB (:$BCB_DB_PORT)"  pg_ready "$BCB_DB_CONTAINER" "$BCB_DB_USER" "$BCB_DB_NAME"
  chk "Postgres satélite (:5440)"     pg_ready biger_estrellaroja_tomtom-db-1 postgres biger_tomtom
  chk "adapter-tomtom (:$PORT_ADAPTER_TOMTOM)" http_ok "http://localhost:$PORT_ADAPTER_TOMTOM/actuator/health"
  chk "adapter-bcb (:$PORT_ADAPTER_BCB)"       http_ok "http://localhost:$PORT_ADAPTER_BCB/actuator/health"
  chk "app bcb (:$PORT_BCB_APP)"      port_busy "$PORT_BCB_APP"
  chk "satélite TomTom (:$PORT_SAT)"  port_busy "$PORT_SAT"
  chk "InRoute falso (:$PORT_FAKE_INROUTE)" http_ok "http://localhost:$PORT_FAKE_INROUTE/__e2e/estado"

  printf '\n'
  local n; n=$(bcb_sql "SELECT count(*) FROM \"Trip\" WHERE id LIKE 'e2e%';" 2>/dev/null)
  printf '  %-34s %s\n' "escenarios sembrados" "${n:-0}"
}

flow_psql() {
  docker exec -it "$BCB_DB_CONTAINER" psql -U "$BCB_DB_USER" -d "$BCB_DB_NAME"
}
