#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2317
FLOW_DESC="Login de agencias — Portal de Agencias → adapter-portalagencias → NATS → adapter-bcb → BCB app auth"

# ── Repos ──────────────────────────────────────────────────────────────────
REPO_BCB="$ER_ROOT/BCB_EstrellaRoja_Backend"
REPO_MAIN="$ER_ROOT/BIGER_EstrellaRoja_Main"
REPO_SAT="$ER_ROOT/BIGER_EstrellaRoja_PortalAgenciasAdmin"
# El alta de la agencia de prueba NO es un seed versionado (decisión del equipo):
# son los dos SQL manuales que viven fuera de los repos. El harness los ejecuta tal
# cual contra las BD locales — así también se prueban ellos.
SQL_DIR="$ER_ROOT/_portal-agencias-docs"

# ── Infraestructura ────────────────────────────────────────────────────────
BCB_DB_CONTAINER="bcb-local-db"
BCB_DB_PORT=5436
BCB_DB_USER="bcb"; BCB_DB_PASS="bcb"; BCB_DB_NAME="bcb"
BCB_DB_URL="postgresql://$BCB_DB_USER:$BCB_DB_PASS@localhost:$BCB_DB_PORT/$BCB_DB_NAME"

BIGER_DB_CONTAINER="postgres"
BIGER_DB_URL="jdbc:postgresql://localhost:5433/db_biger"

SAT_DB_CONTAINER="biger_estrellaroja_portalagenciasadmin-db-1"
SAT_DB_USER="agencias"; SAT_DB_PASS="agencias"; SAT_DB_NAME="portal_agencias"; SAT_DB_PORT=5434
SAT_DB_URL="postgresql://$SAT_DB_USER:$SAT_DB_PASS@localhost:$SAT_DB_PORT/$SAT_DB_NAME?schema=public"

NATS_URL="nats://localhost:4222"
NATS_MONITOR="http://localhost:8222"

PORT_ADAPTER_BCB=8085
PORT_ADAPTER_PA=8094       # adapter-portalagencias como jar en el host (8087 lo usa puntoabordo en compose)
PORT_BCB_AUTH=3012         # app `auth` de BCB (3009 es el app `bcb`, 3011 webhooks)
PORT_BCB_AGENCIES=3013     # app `agencies` de BCB (AD01–AD15): el eslabón final de la cadena
PORT_SAT=3002              # satélite Portal de Agencias (su default)
PORT_JWKS=7804             # emisor JWKS de prueba para el rol `agency` (7802 lo usa ticketcolectoroffline)
JWKS_ISSUER="http://127.0.0.1:$PORT_JWKS/agency"

# Legs de autenticación (un par RSA por dirección, como en AWS):
LEG_BCB="adapter-bcb"        # adapter-bcb → BCB (lo usa start_adapter_bcb de lib/common.sh)
LEG_AGENCY="bcb-agency"      # BCB firma los tokens de agencia; los verifican el satélite (pública en env) y BCB (JWKS)
LEG_ADAPTER_PA="adapter-pa"  # adapter-portalagencias → satélite (sync saliente; el login no lo usa)
LEG_SAT_IN="portal-sat"      # entrada del adapter: JwtFilter exige una pública aunque el login sea público

bcb_sql() { docker exec "$BCB_DB_CONTAINER" psql -U "$BCB_DB_USER" -d "$BCB_DB_NAME" -tA -c "$1" 2>/dev/null; }
sat_sql() { docker exec "$SAT_DB_CONTAINER" psql -U "$SAT_DB_USER" -d "$SAT_DB_NAME" -tA -c "$1" 2>/dev/null; }
b64() { base64 < "$1" | tr -d '\n'; }

# ── up ─────────────────────────────────────────────────────────────────────
flow_up() {
  local reset=0
  for a in "$@"; do [ "$a" = "--reset" ] && reset=1; done

  step "Preflight"
  for c in docker mvn node npx pnpm openssl curl python3; do need_cmd "$c"; done
  for r in "$REPO_BCB" "$REPO_MAIN" "$REPO_SAT" "$SQL_DIR"; do [ -d "$r" ] || die "no encuentro: $r"; done
  ok "comandos, repos y SQL manual presentes"

  step "Llaves de prueba"
  ensure_keypair "$LEG_BCB"
  ensure_keypair "$LEG_AGENCY"
  ensure_keypair "$LEG_ADAPTER_PA"
  ensure_keypair "$LEG_SAT_IN"
  dim "   run/keys/ — solo para local, nunca credenciales reales"

  step "Infraestructura BIGER (Postgres + NATS x3 + adapter-invoice)"
  ( cd "$REPO_MAIN" && docker compose up -d adapter-invoice >/dev/null 2>&1 ) \
    || die "no pude levantar la infra de BIGER"
  wait_for "NATS respondiendo" 60 http_ok "$NATS_MONITOR/healthz?js-server-only=true" || return 1
  wait_for "Postgres BIGER listo" 60 pg_ready "$BIGER_DB_CONTAINER" biger db_biger || return 1
  # El login es request/reply (core NATS), pero adapter-bcb enlaza consumers durables al
  # arrancar: sin los streams se queda reintentando en el log.
  ( cd "$REPO_MAIN" && make nats-init >/dev/null 2>&1 ) || die "make nats-init falló"
  ok "streams de JetStream presentes"

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
    warn "--reset: recreando la base '$BCB_DB_NAME'"
    docker exec "$BCB_DB_CONTAINER" psql -U "$BCB_DB_USER" -d postgres -c "DROP DATABASE IF EXISTS $BCB_DB_NAME WITH (FORCE);" >/dev/null
    docker exec "$BCB_DB_CONTAINER" psql -U "$BCB_DB_USER" -d postgres -c "CREATE DATABASE $BCB_DB_NAME;" >/dev/null
  fi

  step "Migraciones de BCB"
  # Incluye la de este PR: AgencySession con accessTokenExpiresAt/refreshExpiresAt y agencyId único.
  ( cd "$REPO_BCB" && DATABASE_URL="$BCB_DB_URL" pnpm exec prisma migrate deploy >/dev/null 2>&1 ) \
    || die "prisma migrate deploy (BCB) falló — probá: cd $REPO_BCB && DATABASE_URL=$BCB_DB_URL pnpm exec prisma migrate deploy"
  ( cd "$REPO_BCB" && pnpm exec prisma generate >/dev/null 2>&1 ) || die "prisma generate (BCB) falló"
  ok "esquema al día ($(bcb_sql "SELECT count(*) FROM _prisma_migrations;") migraciones) y client regenerado"
  local uniq
  uniq=$(bcb_sql "SELECT count(*) FROM pg_indexes WHERE tablename='AgencySession' AND indexname='AgencySession_agencyRfcId_key';")
  [ "$uniq" = "1" ] || die "falta el índice único AgencySession_agencyRfcId_key: ¿la rama de BCB trae la migración de credenciales por sucursal?"
  ok "AgencySession.agencyRfcId es único (una sesión viva por sucursal)"
  if [ "$(bcb_sql "SELECT count(*) FROM \"State\";")" = "0" ]; then
    ( cd "$REPO_BCB" && DATABASE_URL="$BCB_DB_URL" pnpm prisma:local:db:seed >/dev/null 2>&1 ) \
      || die "el seed oficial de catálogos de BCB falló"
    ok "catálogos base sembrados (seed oficial del repo)"
  fi

  step "Postgres del satélite Portal de Agencias (:$SAT_DB_PORT)"
  [ -f "$REPO_SAT/.env" ] || cp "$REPO_SAT/.env.example" "$REPO_SAT/.env"
  ( cd "$REPO_SAT" && docker compose up -d db >/dev/null 2>&1 ) || die "no pude levantar la BD del satélite"
  wait_for "Postgres satélite listo" 60 pg_ready "$SAT_DB_CONTAINER" "$SAT_DB_USER" "$SAT_DB_NAME" || return 1
  ( cd "$REPO_SAT" && DATABASE_URL="$SAT_DB_URL" npx prisma migrate deploy >/dev/null 2>&1 ) \
    || die "migraciones del satélite fallaron"
  ok "esquema del satélite al día"

  step "Configuración del satélite (.env)"
  # JWT_PUBLIC_KEY_BCB_AGENCY es la pública con la que BCB firma los tokens de agencia:
  # el guard del satélite la registra como consumidor 'BCB_AGENCY' y aplica el
  # deny-by-default (@AgencyAccess) a esos tokens.
  # SECRET_PEM_PORTALAGENCIAS_JWT_PRIVATE_KEY es la privada del leg portal-sat, con la que
  # el satélite FIRMA sus llamadas salientes al adapter. Su pública es el JWT_PUBLIC_KEY con
  # el que arranca adapter-portalagencias: sin esto, todo /portalagencias/agencies/** da 401
  # (las rutas de login son la excepción, son públicas en el adapter). La base INCLUYE el
  # prefijo /portalagencias, igual que en dev detrás del balanceador.
  python3 - "$REPO_SAT/.env" "$SAT_DB_URL" "$PORT_SAT" "http://localhost:$PORT_ADAPTER_PA/portalagencias" \
    "$(b64 "$(key_path "$LEG_ADAPTER_PA-public.pem")")" "$(b64 "$(key_path "$LEG_AGENCY-public.pem")")" \
    "$(key_path "$LEG_SAT_IN-private-pkcs8.pem")" <<'PY'
import sys, re
path, dburl, port, adapter, pub_adapter, pub_agency, priv_sat = sys.argv[1:8]
vals = {
    'PORT': port,
    'NODE_ENV': 'development',
    'APP_PREFIX': 'portal-agencias',
    'DATABASE_URL': dburl,
    'BIGER_ADAPTER_AGENCIAS': adapter,
    'JWT_PUBLIC_KEY_ADAPTER_PORTALAGENCIAS': pub_adapter,
    'JWT_PUBLIC_KEY_BCB_AGENCY': pub_agency,
    'SECRET_PEM_PORTALAGENCIAS_JWT_PRIVATE_KEY': priv_sat,
    'ADAPTER_JWT_ISSUER': 'portal-agencias-api',
}
seen, out = set(), []
for ln in open(path).read().splitlines():
    m = re.match(r'^([A-Z0-9_]+)=', ln)
    if m:
        k = m.group(1)
        out.append(f'{k}={vals[k]}' if k in vals else ln); seen.add(k)
    elif ln.strip() == '' or ln.lstrip().startswith('#'):
        out.append(ln)
for k, v in vals.items():
    if k not in seen:
        out.append(f'{k}={v}')
open(path, 'w').write('\n'.join(out) + '\n')
PY
  ok ".env del satélite configurado (gitignored)"

  step "Compilación de los adapters"
  local jar_bcb="$REPO_MAIN/adapter-bcb/target/adapter-bcb-1.0.0-SNAPSHOT.jar"
  local jar_pa="$REPO_MAIN/adapter-portalagencias/target/adapter-portalagencias-1.0.0-SNAPSHOT.jar"
  local to_build=()
  jar_is_stale "$jar_bcb" "$REPO_MAIN/adapter-bcb/src/main" "$REPO_MAIN/shared/src/main" && to_build+=("adapter-bcb")
  jar_is_stale "$jar_pa"  "$REPO_MAIN/adapter-portalagencias/src/main" "$REPO_MAIN/shared/src/main" && to_build+=("adapter-portalagencias")
  if [ ${#to_build[@]} -gt 0 ]; then
    log "recompilando: ${to_build[*]} (fuentes más nuevas que el jar)"
    local mods; mods=$(IFS=,; echo "${to_build[*]}")
    ( cd "$REPO_MAIN" && mvn -q package -pl "$mods" -am -DskipTests -Ddependency-check.skip=true >/dev/null 2>&1 ) \
      || die "mvn package falló para $mods (ver: cd $REPO_MAIN && mvn package -pl $mods -am -DskipTests -Ddependency-check.skip=true)"
    ok "jars reconstruidos"
    stop_rebuilt "${to_build[@]}"
  else
    dim "   jars al día"
  fi

  step "Emisor JWKS de prueba (rol agency)"
  # BCB firma con la privada (vía SecretManagerService sustituido) y VERIFICA refresh/me
  # bajando la pública de ${JWT_AGENCY_ISS}/.well-known/jwks.json — en AWS es S3, acá este servidor.
  if is_running jwks-agency; then
    dim "   jwks-agency ya corriendo"
  else
    stop_bg jwks-agency
    ensure_port_free "$PORT_JWKS" jwks-agency
    start_bg jwks-agency "$LOG_DIR/jwks-agency.log" \
      node "$E2E_ROOT/lib/jwks-server.js" "$(key_path "$LEG_AGENCY-public.pem")" "$PORT_JWKS" /agency
  fi
  wait_for "JWKS :$PORT_JWKS" 30 http_ok "http://127.0.0.1:$PORT_JWKS/health" || return 1
  local kid
  kid=$(curl -s "$JWKS_ISSUER/.well-known/jwks.json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["keys"][0]["kid"])')
  [ -n "$kid" ] || die "no pude leer el kid del JWKS"
  dim "   kid=$kid (thumbprint RFC 7638 de la llave; BCB lo pone en el header del token)"

  step "Servicios"
  # app `auth` de BCB — el login real (AgencyController), con Prisma y guard reales.
  # Solo se sustituye SecretManagerService: devuelve el secreto del rol agency como JSON
  # {privateKey, kid, iss} (igual que en AWS). Ojo: NO se pasan JWT_AGENCY_ISS/KID por
  # entorno a propósito — así se prueba que BCB los toma del secreto.
  # Se reinicia siempre, como el satélite: son los apps que se están escribiendo y
  # reutilizar el proceso hacía correr las pruebas contra el código anterior (una ruta
  # nueva daba 404 y un campo nuevo del DTO daba 400 "should not exist").
  if is_running bcb-auth; then
    warn "app auth ya estaba arriba — se reinicia para correr el código actual"
  fi
  stop_bg bcb-auth
  ensure_port_free "$PORT_BCB_AUTH" "app auth"
  graft "$E2E_ROOT/lib/bcb-auth-bootstrap.ts" "$REPO_BCB" "scripts/e2e/auth-bootstrap.ts"
  ( cd "$REPO_BCB" && \
    DATABASE_URL="$BCB_DB_URL" NODE_ENV=development AWS_REGION=us-west-2 PORT="$PORT_BCB_AUTH" \
    E2E_AGENCY_ISS="$JWKS_ISSUER" E2E_AGENCY_KID="$kid" \
    JWT_AGENCY_PRIVATE_KEY_SECRET_NAME="e2e/agency-private-key" \
    E2E_AGENCY_PRIVATE_KEY_PATH="$(key_path "$LEG_AGENCY-private.pem")" \
    start_bg bcb-auth "$LOG_DIR/bcb-auth.log" \
      pnpm exec ts-node -r tsconfig-paths/register scripts/e2e/auth-bootstrap.ts )

  # app `agencies` de BCB — AD01–AD15 (agencias, sucursales, cortes, ventas, catálogos).
  # Guard, DTOs y Prisma reales; solo se sustituyen SecretManagerService (llave pública de
  # prueba), EmailService (correo de alta) y S3Service (XLSX del reporte).
  if is_running bcb-agencies; then
    warn "app agencies ya estaba arriba — se reinicia para correr el código actual"
  fi
  stop_bg bcb-agencies
  ensure_port_free "$PORT_BCB_AGENCIES" "app agencies"
  graft "$E2E_ROOT/lib/bcb-agencies-bootstrap.ts" "$REPO_BCB" "scripts/e2e/agencies-bootstrap.ts"
  ( cd "$REPO_BCB" && \
    DATABASE_URL="$BCB_DB_URL" NODE_ENV=development AWS_REGION=us-west-2 PORT="$PORT_BCB_AGENCIES" \
    E2E_PUBLIC_KEY_PATH="$(key_path "$LEG_BCB-public.pem")" \
    ADAPTER_BCB_URL="http://localhost:$PORT_ADAPTER_BCB/bcb" \
    start_bg bcb-agencies "$LOG_DIR/bcb-agencies.log" \
      pnpm exec ts-node -r tsconfig-paths/register scripts/e2e/agencies-bootstrap.ts )

  # adapter-bcb: compartido con los otros flujos, pero ESTE necesita que apunten sus módulos
  # bcb-auth y agencies a los apps locales (por defecto van al API Gateway de develop). Se
  # reinicia siempre para no probar contra un proceso levantado por otro flujo sin esas variables.
  if is_running adapter-bcb; then
    warn "adapter-bcb ya estaba arriba — se reinicia con BCB_AUTH_SATELLITE_URL / SATELLITE_AGENCIES_URL locales"
    stop_bg adapter-bcb; kill_port "$PORT_ADAPTER_BCB"
  fi
  export BCB_AUTH_SATELLITE_URL="http://localhost:$PORT_BCB_AUTH"
  # El catálogo de endpoints ya trae el prefijo /portal, así que en local la base va sin sufijo
  # (Nest directo). En AWS la base termina en /agencies/portal: ese recurso de API Gateway recorta
  # el prefijo y a Nest le llega solo lo que sigue; con /develop/agencies a secas todo da 404.
  export SATELLITE_AGENCIES_URL="http://localhost:$PORT_BCB_AGENCIES"
  start_adapter_bcb "$REPO_MAIN" "http://localhost:3009" "http://localhost:3011" "$LEG_BCB"

  # adapter-portalagencias: JWT_BYPASS=false A PROPÓSITO. Lo que se prueba es que las tres
  # rutas de auth son públicas por app.security.public-paths y el resto de /agencies/** no.
  local seed_pa; seed_pa=$(grep -m1 '^PORTALAGENCIAS_SECRET_NATS_SEED=' "$REPO_MAIN/.env" | cut -d= -f2)
  [ -n "$seed_pa" ] || die "falta PORTALAGENCIAS_SECRET_NATS_SEED en $REPO_MAIN/.env"
  if is_running adapter-portalagencias; then
    dim "   adapter-portalagencias ya corriendo"
  else
    stop_bg adapter-portalagencias
    ensure_port_free "$PORT_ADAPTER_PA" adapter-portalagencias
    local pa_priv_json
    pa_priv_json=$(python3 -c 'import json,sys; print(json.dumps({"privateKey": open(sys.argv[1]).read()}))' \
      "$(key_path "$LEG_ADAPTER_PA-private-pkcs8.pem")")
    ( cd "$REPO_MAIN" && \
      SPRING_PROFILES_ACTIVE=local SERVER_PORT="$PORT_ADAPTER_PA" NATS_URL="$NATS_URL" \
      SECRETS_SOURCE=local DB_SECRET=db-local \
      DB_SECRET_KEY_VALUE='{"username":"biger","password":"biger_local"}' \
      NATS_NKEY_SECRET=nats-nkey-portalagencias NATS_NKEY_SECRET_KEY_VALUE="{\"seed\":\"$seed_pa\"}" \
      SPRING_DATASOURCE_URL="$BIGER_DB_URL" \
      JWT_BYPASS=false JWT_PUBLIC_KEY="$(pem_escaped "$(key_path "$LEG_SAT_IN-public.pem")")" \
      SATELLITE_PORTALAGENCIAS_URL="http://localhost:$PORT_SAT/portal-agencias" \
      PORTALAGENCIAS_AUTH_PRIVATE_KEY_SECRET=portalagencias-jwt-local \
      PORTALAGENCIAS_AUTH_PRIVATE_KEY_SECRET_KEY_VALUE="$pa_priv_json" \
      PORTALAGENCIAS_AUTH_SUBJECT=adapter-portalagencias \
      OTLP_TRACES_ENABLED=false \
      start_bg adapter-portalagencias "$LOG_DIR/adapter-portalagencias.log" \
        java -jar "$jar_pa" )
  fi

  # Satélite Portal de Agencias (NestJS). Lee su .env vía ConfigModule. También se
  # reinicia siempre: es el servicio que más cambia y reutilizarlo dejaba las pruebas
  # corriendo contra el build anterior.
  if is_running satelite-agencias; then
    warn "satélite ya estaba arriba — se reinicia para correr el código actual"
  fi
  stop_bg satelite-agencias
  ensure_port_free "$PORT_SAT" "satélite Portal de Agencias"
  ( cd "$REPO_SAT" && start_bg satelite-agencias "$LOG_DIR/satelite-agencias.log" npx nest start )

  step "Health"
  wait_for "adapter-bcb :$PORT_ADAPTER_BCB" 90 http_ok "http://localhost:$PORT_ADAPTER_BCB/actuator/health" || return 1
  wait_for "adapter-portalagencias :$PORT_ADAPTER_PA" 90 http_ok "http://localhost:$PORT_ADAPTER_PA/actuator/health" || return 1
  wait_for "app auth :$PORT_BCB_AUTH" 150 bash -c \
    "curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' http://localhost:$PORT_BCB_AUTH/agency/authenticate | grep -qE '^(400|401|422)$'" || return 1
  # Sin Authorization el guard responde 401: prueba que arrancó Y que el guard está puesto.
  wait_for "app agencies :$PORT_BCB_AGENCIES" 150 bash -c \
    "curl -s -o /dev/null -w '%{http_code}' http://localhost:$PORT_BCB_AGENCIES/portal | grep -q 401" || return 1
  wait_for "satélite :$PORT_SAT" 150 http_ok "http://localhost:$PORT_SAT/portal-agencias/health" || return 1
  wait_for "satélite guard JWT (llaves cargadas)" 30 bash -c \
    "curl -s -o /dev/null -w '%{http_code}' http://localhost:$PORT_SAT/portal-agencias/agencies | grep -q 401" || return 1
  if grep -q "BCB_AGENCY" "$LOG_DIR/satelite-agencias.log" 2>/dev/null; then
    ok "el satélite registró la llave BCB_AGENCY"
  else
    warn "el satélite no reporta la llave BCB_AGENCY — revisá $LOG_DIR/satelite-agencias.log"
  fi

  printf '\n'; ok "stack arriba"
}

# ── down / status / psql ───────────────────────────────────────────────────
flow_down() {
  local all=0
  for a in "$@"; do [ "$a" = "--all" ] && all=1; done
  step "Deteniendo servicios del flujo"
  stop_bg satelite-agencias;       kill_port "$PORT_SAT"
  stop_bg adapter-portalagencias;  kill_port "$PORT_ADAPTER_PA"
  stop_bg bcb-auth;                kill_port "$PORT_BCB_AUTH"
  stop_bg bcb-agencies;            kill_port "$PORT_BCB_AGENCIES"
  stop_bg jwks-agency;             kill_port "$PORT_JWKS"
  # adapter-bcb se levantó con BCB_AUTH_SATELLITE_URL local: se baja para que otro flujo
  # lo vuelva a levantar con su propia configuración.
  stop_bg adapter-bcb;             kill_port "$PORT_ADAPTER_BCB"
  ungraft_all
  ok "scripts temporales removidos de los repos"
  if [ "$all" -eq 1 ]; then
    step "Deteniendo infraestructura compartida (--all)"
    ( cd "$REPO_MAIN" && docker compose stop >/dev/null 2>&1 ) && ok "compose de BIGER detenido"
    ( cd "$REPO_SAT" && docker compose stop >/dev/null 2>&1 ) && ok "BD del satélite detenida"
    docker stop "$BCB_DB_CONTAINER" >/dev/null 2>&1 && ok "BD de BCB detenida"
  else
    dim "   la infra compartida sigue arriba — './e2e down agencias --all' para bajarla"
  fi
}

flow_status() {
  step "Estado"
  chk() { local label="$1"; shift
    if "$@" >/dev/null 2>&1; then printf '  %-40s %s\n' "$label" "${C_GREEN}arriba${C_RESET}"
    else printf '  %-40s %s\n' "$label" "${C_RED}abajo${C_RESET}"; fi; }
  chk "NATS (:4222/:8222)"                   http_ok "$NATS_MONITOR/healthz?js-server-only=true"
  chk "Postgres BIGER (:5433)"               pg_ready "$BIGER_DB_CONTAINER" biger db_biger
  chk "Postgres BCB (:$BCB_DB_PORT)"         pg_ready "$BCB_DB_CONTAINER" "$BCB_DB_USER" "$BCB_DB_NAME"
  chk "Postgres satélite (:$SAT_DB_PORT)"    pg_ready "$SAT_DB_CONTAINER" "$SAT_DB_USER" "$SAT_DB_NAME"
  chk "JWKS agency (:$PORT_JWKS)"            http_ok "http://127.0.0.1:$PORT_JWKS/health"
  chk "app auth BCB (:$PORT_BCB_AUTH)"       port_busy "$PORT_BCB_AUTH"
  chk "adapter-bcb (:$PORT_ADAPTER_BCB)"     http_ok "http://localhost:$PORT_ADAPTER_BCB/actuator/health"
  chk "adapter-portalagencias (:$PORT_ADAPTER_PA)" http_ok "http://localhost:$PORT_ADAPTER_PA/actuator/health"
  chk "satélite Portal de Agencias (:$PORT_SAT)" http_ok "http://localhost:$PORT_SAT/portal-agencias/health"
  printf '\n'
  printf '  %-40s %s\n' "agencia de prueba en BCB" "$(bcb_sql "SELECT coalesce(max(status::text),'(no existe)') FROM \"Agency\" WHERE id='0f1e2d3c-4b5a-4c6d-8e9f-a0b1c2d3e4f5';")"
  printf '  %-40s %s\n' "sesiones vivas de la agencia" "$(bcb_sql "SELECT count(*) FROM \"AgencySession\" WHERE \"agencyId\"='0f1e2d3c-4b5a-4c6d-8e9f-a0b1c2d3e4f5';")"
}

flow_psql() { docker exec -it "$BCB_DB_CONTAINER" psql -U "$BCB_DB_USER" -d "$BCB_DB_NAME"; }
