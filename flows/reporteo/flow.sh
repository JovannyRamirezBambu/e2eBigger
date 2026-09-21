#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2317
FLOW_DESC="Reporteo — CMS → adapter-reportes → satélite → NATS → adapter-bcb → BCB app reports → archivo"

# Este flujo levanta el stack y siembra una venta; los reportes se ejercitan con la
# colección Bruno del satélite (19 requests / 33 pruebas), no con casos en `test`:
#   cd $ER_ROOT/BIGER_EstrellaRoja_Reportes/bruno/reportes
#   npx @usebruno/cli run --env Local -r

# ── Repos ──────────────────────────────────────────────────────────────────
REPO_BCB="$ER_ROOT/BCB_EstrellaRoja_Backend"
REPO_MAIN="$ER_ROOT/BIGER_EstrellaRoja_Main"
REPO_SAT="$ER_ROOT/BIGER_EstrellaRoja_Reportes"

# ── Infraestructura ────────────────────────────────────────────────────────
BCB_DB_CONTAINER="bcb-local-db"
BCB_DB_PORT=5436
BCB_DB_USER="bcb"; BCB_DB_PASS="bcb"; BCB_DB_NAME="bcb"
BCB_DB_URL="postgresql://$BCB_DB_USER:$BCB_DB_PASS@localhost:$BCB_DB_PORT/$BCB_DB_NAME"

BIGER_DB_CONTAINER="postgres"
BIGER_DB_URL="jdbc:postgresql://localhost:5433/db_biger"

# El satélite de Reporteo corre en SU PROPIO compose (Java + Postgres), no como jar en el
# host: su imagen ya está construida y Liquibase aplica las migraciones al arrancar.
SAT_DB_CONTAINER="reportes-postgres"
SAT_API_CONTAINER="reportes-api"
SAT_DB_USER="reportes"; SAT_DB_NAME="db_reportes"; SAT_DB_PORT=5435

NATS_URL="nats://localhost:4222"
NATS_MONITOR="http://localhost:8222"

PORT_ADAPTER_BCB=8085
PORT_ADAPTER_REPORTES=8097   # el que expone su application.yml
PORT_BCB_REPORTS=3010        # app `reports` de BCB (3009 bcb, 3011 webhooks, 3012 auth, 3013 agencies)
PORT_SAT=9110                # satélite Reporteo, publicado por su docker-compose
PORT_FILES=7806              # "bucket" local que sirve los .xlsx (7801-7804 los usan otros flujos)
SAT_PREFIX="/reporteo"       # context-path del satélite
ADAPTER_PREFIX="/reportes"   # prefijo con el que el gateway entrega al adapter

# Legs de autenticación (un par RSA por dirección, como en AWS):
LEG_BCB="adapter-bcb"        # adapter-bcb → apps de BCB (compartido con los otros flujos)
LEG_REPORTES="reportes"      # adapter-reportes → satélite Reporteo

BUCKET_DIR="$RUN_DIR/reports-bucket"

bcb_sql() { docker exec "$BCB_DB_CONTAINER" psql -U "$BCB_DB_USER" -d "$BCB_DB_NAME" -tA -c "$1" 2>/dev/null; }
sat_sql() { docker exec "$SAT_DB_CONTAINER" psql -U "$SAT_DB_USER" -d "$SAT_DB_NAME" -tA -c "$1" 2>/dev/null; }

# ── up ─────────────────────────────────────────────────────────────────────
flow_up() {
  local reset=0
  for a in "$@"; do [ "$a" = "--reset" ] && reset=1; done

  step "Preflight"
  for c in docker mvn node npx pnpm openssl curl python3; do need_cmd "$c"; done
  for r in "$REPO_BCB" "$REPO_MAIN" "$REPO_SAT"; do [ -d "$r" ] || die "no encuentro: $r"; done
  ok "comandos y repos presentes"

  step "Llaves de prueba"
  ensure_keypair "$LEG_BCB"
  ensure_keypair "$LEG_REPORTES"
  dim "   run/keys/ — solo para local, nunca credenciales reales"

  step "Infraestructura BIGER (Postgres + NATS x3 + adapter-invoice)"
  ( cd "$REPO_MAIN" && docker compose up -d adapter-invoice >/dev/null 2>&1 ) \
    || die "no pude levantar la infra de BIGER"
  wait_for "NATS respondiendo" 60 http_ok "$NATS_MONITOR/healthz?js-server-only=true" || return 1
  wait_for "Postgres BIGER listo" 60 pg_ready "$BIGER_DB_CONTAINER" biger db_biger || return 1
  # La generación es request/reply (core NATS), pero adapter-bcb enlaza consumers durables
  # al arrancar: sin los streams se queda reintentando en el log.
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
  # El esquema local se queda atrás seguido, y el síntoma no se parece a la causa: un
  # `column OrderItem.<x> does not exist` en runtime, o un tsc que marca enums que sí
  # están en schema.prisma porque el CLIENTE generado es viejo. Se hacen las dos siempre.
  ( cd "$REPO_BCB" && DATABASE_URL="$BCB_DB_URL" pnpm exec prisma migrate deploy >/dev/null 2>&1 ) \
    || die "prisma migrate deploy (BCB) falló — probá: cd $REPO_BCB && DATABASE_URL=$BCB_DB_URL pnpm exec prisma migrate deploy"
  ( cd "$REPO_BCB" && pnpm exec prisma generate >/dev/null 2>&1 ) || die "prisma generate (BCB) falló"
  ok "esquema al día ($(bcb_sql "SELECT count(*) FROM _prisma_migrations;") migraciones) y client regenerado"
  if [ "$(bcb_sql "SELECT count(*) FROM \"State\";")" = "0" ]; then
    ( cd "$REPO_BCB" && DATABASE_URL="$BCB_DB_URL" pnpm prisma:local:db:seed >/dev/null 2>&1 ) \
      || die "el seed oficial de catálogos de BCB falló"
    ok "catálogos base sembrados (seed oficial del repo)"
  fi

  step "Compilación de los adapters"
  local jar_bcb="$REPO_MAIN/adapter-bcb/target/adapter-bcb-1.0.0-SNAPSHOT.jar"
  local jar_rep="$REPO_MAIN/adapter-reportes/target/adapter-reportes-1.0.0-SNAPSHOT.jar"
  local to_build=()
  jar_is_stale "$jar_bcb" "$REPO_MAIN/adapter-bcb/src/main" "$REPO_MAIN/shared/src/main" && to_build+=("adapter-bcb")
  jar_is_stale "$jar_rep" "$REPO_MAIN/adapter-reportes/src/main" "$REPO_MAIN/shared/src/main" && to_build+=("adapter-reportes")
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

  step "App reports de BCB (:$PORT_BCB_REPORTS)"
  # Se reinicia siempre: es el app que se está escribiendo y reutilizar el proceso hacía
  # correr las pruebas contra el build anterior (una plantilla nueva daba 404).
  if is_running bcb-reports; then
    warn "app reports ya estaba arriba — se reinicia para correr el código actual"
  fi
  stop_bg bcb-reports
  ensure_port_free "$PORT_BCB_REPORTS" "app reports"
  ensure_port_free "$PORT_FILES" "bucket local"
  mkdir -p "$BUCKET_DIR"
  graft "$E2E_ROOT/lib/bcb-reports-bootstrap.ts" "$REPO_BCB" "scripts/e2e/reports-bootstrap.ts"
  ( cd "$REPO_BCB" && \
    DATABASE_URL="$BCB_DB_URL" NODE_ENV=development AWS_REGION=us-west-2 PORT="$PORT_BCB_REPORTS" \
    E2E_PUBLIC_KEY_PATH="$(key_path "$LEG_BCB-public.pem")" \
    E2E_BUCKET_DIR="$BUCKET_DIR" E2E_FILES_PORT="$PORT_FILES" \
    start_bg bcb-reports "$LOG_DIR/bcb-reports.log" \
      pnpm exec ts-node -r tsconfig-paths/register scripts/e2e/reports-bootstrap.ts )
  dim "   el .xlsx se guarda en $BUCKET_DIR y se sirve en :$PORT_FILES — sin credenciales de AWS"

  step "Venta de prueba en BCB"
  # Los seeds oficiales de BCB son catálogos, no ventas: sin esto todos los reportes
  # salen EMPTY, que es correcto pero no deja ver un archivo.
  local folio
  graft "$E2E_ROOT/lib/bcb-reports-seed.ts" "$REPO_BCB" "scripts/e2e/reports-seed.ts"
  folio=$( cd "$REPO_BCB" && DATABASE_URL="$BCB_DB_URL" \
    pnpm exec ts-node -r tsconfig-paths/register scripts/e2e/reports-seed.ts 2>/dev/null \
    | grep '^FOLIO=' | cut -d= -f2 )
  [ -n "$folio" ] || die "el seed de la venta falló (ver: cd $REPO_BCB && DATABASE_URL=$BCB_DB_URL pnpm exec ts-node -r tsconfig-paths/register scripts/e2e/reports-seed.ts)"
  echo "$folio" > "$RUN_DIR/reporteo-folio.txt"
  ok "venta redonda pagada sembrada — folio $folio"

  step "adapter-bcb (:$PORT_ADAPTER_BCB)"
  # Compartido con los otros flujos, pero ESTE necesita SATELLITE_REPORTS_URL apuntando al
  # app local: por defecto va al API Gateway de develop. Se reinicia siempre para no probar
  # contra un proceso levantado por otro flujo sin esa variable.
  if is_running adapter-bcb; then
    warn "adapter-bcb ya estaba arriba — se reinicia con SATELLITE_REPORTS_URL local"
    stop_bg adapter-bcb; kill_port "$PORT_ADAPTER_BCB"
  fi
  start_adapter_bcb "$REPO_MAIN" "http://localhost:3009" "http://localhost:3011" "$LEG_BCB" \
    "http://localhost:$PORT_BCB_REPORTS"

  step "Satélite Reporteo (:$PORT_SAT, docker compose del repo)"
  # El satélite valida un JWT RS256 del adapter y NO tiene bypass: su .env lleva la pública
  # del leg `reportes` y el adapter firma con la privada.
  python3 - "$REPO_SAT/.env" "$(key_path "$LEG_REPORTES-public.pem")" <<'PY'
import re, sys
path, pub_path = sys.argv[1:3]
pub = ''.join(l.strip() for l in open(pub_path) if 'PUBLIC KEY' not in l)
vals = {
    'POSTGRES_USER': 'reportes',
    'POSTGRES_PASSWORD': 'reportes_local',
    'POSTGRES_DB': 'db_reportes',
    'DB_HOST': 'localhost',
    'DB_PORT': '5435',
    'DB_HOST_PORT': '5435',
    'SECRET_DB_DATA': '{"dbName":"db_reportes","username":"reportes","password":"reportes_local"}',
    'JWT_PUBLIC_KEY_ADAPTER_REPORTES': pub,
    'JWT_ISSUER_ADAPTER_REPORTES': 'https://auth.biger.com',
    'JWT_AUDIENCE_ADAPTER_REPORTES': '',
}
try:
    lines = open(path).read().splitlines()
except FileNotFoundError:
    lines = []
seen, out = set(), []
for ln in lines:
    m = re.match(r'^([A-Z0-9_]+)=', ln)
    if m:
        k = m.group(1)
        out.append(f'{k}={vals[k]}' if k in vals else ln); seen.add(k)
    else:
        out.append(ln)
for k, v in vals.items():
    if k not in seen:
        out.append(f'{k}={v}')
open(path, 'w').write('\n'.join(out) + '\n')
PY
  ok ".env del satélite configurado (gitignored)"
  # `up -d --build` reconstruye si el jar cambió; Liquibase aplica las migraciones al arrancar.
  ( cd "$REPO_SAT" && docker compose up -d --build >/dev/null 2>&1 ) \
    || die "no pude levantar el satélite (ver: cd $REPO_SAT && docker compose up --build)"
  wait_for "Postgres del satélite listo" 90 pg_ready "$SAT_DB_CONTAINER" "$SAT_DB_USER" "$SAT_DB_NAME" || return 1

  step "adapter-reportes (:$PORT_ADAPTER_REPORTES)"
  local seed_rep; seed_rep=$(grep -m1 '^REPORTES_SECRET_NATS_SEED=' "$REPO_MAIN/.env" | cut -d= -f2)
  [ -n "$seed_rep" ] || die "falta REPORTES_SECRET_NATS_SEED en $REPO_MAIN/.env — corré 'make nats-keys' en $REPO_MAIN"
  stop_bg adapter-reportes
  ensure_port_free "$PORT_ADAPTER_REPORTES" adapter-reportes
  local rep_priv_json
  rep_priv_json=$(python3 -c 'import json,sys; print(json.dumps({"privateKey": open(sys.argv[1]).read()}))' \
    "$(key_path "$LEG_REPORTES-private-pkcs8.pem")")
  # SERVER_PORT se pasa explícito: si quedó exportado por otro flujo (adapter-bcb usa 8085),
  # el adapter se lo queda y el otro servicio no arranca — con el único síntoma de un job en
  # FAILED cinco minutos después, porque nadie contesta por NATS.
  ( cd "$REPO_MAIN" && \
    SPRING_PROFILES_ACTIVE=local SERVER_PORT="$PORT_ADAPTER_REPORTES" NATS_URL="$NATS_URL" \
    SECRETS_SOURCE=local DB_SECRET=db-local \
    DB_SECRET_KEY_VALUE='{"username":"biger","password":"biger_local"}' \
    NATS_NKEY_SECRET=nats-nkey-reportes NATS_NKEY_SECRET_KEY_VALUE="{\"seed\":\"$seed_rep\"}" \
    SPRING_DATASOURCE_URL="$BIGER_DB_URL" \
    JWT_BYPASS=true BCB_MULTI_ISSUER_AUTH_ENABLED=false \
    SATELLITE_REPORTES_URL="http://localhost:$PORT_SAT$SAT_PREFIX" \
    REPORTES_AUTH_PRIVATE_KEY_SECRET=reportes-jwt-local \
    REPORTES_AUTH_PRIVATE_KEY_SECRET_KEY_VALUE="$rep_priv_json" \
    REPORTES_AUTH_ISSUER=https://auth.biger.com \
    REPORTES_AUTH_SUBJECT=adapter-reportes \
    OTLP_TRACES_ENABLED=false \
    start_bg adapter-reportes "$LOG_DIR/adapter-reportes.log" \
      java -jar "$jar_rep" )

  step "Health"
  wait_for "satélite :$PORT_SAT" 150 http_ok "http://localhost:$PORT_SAT$SAT_PREFIX/health" || return 1
  wait_for "adapter-bcb :$PORT_ADAPTER_BCB" 90 http_ok "http://localhost:$PORT_ADAPTER_BCB/actuator/health" || return 1
  wait_for "adapter-reportes :$PORT_ADAPTER_REPORTES" 120 http_ok "http://localhost:$PORT_ADAPTER_REPORTES$ADAPTER_PREFIX/health" || return 1
  # Sin Authorization el guard responde 401: prueba que arrancó Y que el guard está puesto.
  wait_for "app reports :$PORT_BCB_REPORTS (guard puesto)" 150 bash -c \
    "curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:$PORT_BCB_REPORTS/reports/generate | grep -q 401" || return 1
  wait_for "bucket local :$PORT_FILES" 30 bash -c \
    "curl -s -o /dev/null -w '%{http_code}' http://localhost:$PORT_FILES/nada | grep -q 404" || return 1
  # adapter-bcb tiene que estar suscrito a los subjects de reporteo, o la generación se
  # queda esperando cinco minutos y el job muere en FAILED sin decir por qué.
  wait_for "adapter-bcb suscrito a biger.bcb.reports.*" 60 bash -c \
    "grep -q 'Suscrito a subjects de reporteo' '$LOG_DIR/adapter-bcb.log'" || return 1

  step "Prueba de humo: generar y descargar"
  local job status
  job=$(curl -s -H 'Content-Type: application/json' \
    -d "{\"templateKey\":\"venta-reporte-boletos\",\"dateFrom\":\"$(date -v-7d +%Y-%m-%d 2>/dev/null || date -d '7 days ago' +%Y-%m-%d)\",\"dateTo\":\"$(date +%Y-%m-%d)\"}" \
    "http://localhost:$PORT_ADAPTER_REPORTES$ADAPTER_PREFIX/reports" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin).get("jobId",""))')
  [ -n "$job" ] || die "el POST de generación no devolvió jobId"
  wait_for "job $job en estado terminal" 90 bash -c \
    "curl -s http://localhost:$PORT_ADAPTER_REPORTES$ADAPTER_PREFIX/reports/$job | grep -qE '\"(READY|EMPTY|FAILED)\"'" || return 1
  status=$(curl -s "http://localhost:$PORT_ADAPTER_REPORTES$ADAPTER_PREFIX/reports/$job" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["status"])')
  case "$status" in
    READY)
      local bytes
      bytes=$(curl -s -L -o "$RUN_DIR/reporteo-humo.xlsx" -w '%{size_download}' \
        "http://localhost:$PORT_ADAPTER_REPORTES$ADAPTER_PREFIX/reports/$job/download")
      ok "reporte descargado: $bytes bytes en $RUN_DIR/reporteo-humo.xlsx"
      ;;
    EMPTY) warn "el job terminó EMPTY: no hay ventas en el rango (¿se sembró?)" ;;
    *)     err "el job terminó en $status — revisá $LOG_DIR/adapter-reportes.log"; return 1 ;;
  esac

  printf '\n'; ok "stack arriba"
  dim "   folio para el reporte de movimientos (CU-005): $(cat "$RUN_DIR/reporteo-folio.txt")"
  dim "   colección Bruno: cd $REPO_SAT/bruno/reportes && npx @usebruno/cli run --env Local -r"
}

# ── down / status / psql ───────────────────────────────────────────────────
flow_down() {
  local all=0
  for a in "$@"; do [ "$a" = "--all" ] && all=1; done
  step "Deteniendo servicios del flujo"
  stop_bg adapter-reportes; kill_port "$PORT_ADAPTER_REPORTES"
  stop_bg bcb-reports;      kill_port "$PORT_BCB_REPORTS"; kill_port "$PORT_FILES"
  # adapter-bcb se levantó con SATELLITE_REPORTS_URL local: se baja para que otro flujo
  # lo vuelva a levantar con su propia configuración.
  stop_bg adapter-bcb;      kill_port "$PORT_ADAPTER_BCB"
  ( cd "$REPO_SAT" && docker compose stop >/dev/null 2>&1 ) && ok "satélite Reporteo detenido"
  ungraft_all
  ok "scripts temporales removidos de los repos"
  if [ "$all" -eq 1 ]; then
    step "Deteniendo infraestructura compartida (--all)"
    ( cd "$REPO_MAIN" && docker compose stop >/dev/null 2>&1 ) && ok "compose de BIGER detenido"
    docker stop "$BCB_DB_CONTAINER" >/dev/null 2>&1 && ok "BD de BCB detenida"
  else
    dim "   la infra compartida sigue arriba — './e2e down reporteo --all' para bajarla"
  fi
}

flow_status() {
  step "Estado"
  chk() { local label="$1"; shift
    if "$@" >/dev/null 2>&1; then printf '  %-44s %s\n' "$label" "${C_GREEN}arriba${C_RESET}"
    else printf '  %-44s %s\n' "$label" "${C_RED}abajo${C_RESET}"; fi; }
  chk "NATS (:4222/:8222)"                        http_ok "$NATS_MONITOR/healthz?js-server-only=true"
  chk "Postgres BIGER (:5433)"                    pg_ready "$BIGER_DB_CONTAINER" biger db_biger
  chk "Postgres BCB (:$BCB_DB_PORT)"              pg_ready "$BCB_DB_CONTAINER" "$BCB_DB_USER" "$BCB_DB_NAME"
  chk "Postgres satélite (:$SAT_DB_PORT)"         pg_ready "$SAT_DB_CONTAINER" "$SAT_DB_USER" "$SAT_DB_NAME"
  chk "app reports BCB (:$PORT_BCB_REPORTS)"      port_busy "$PORT_BCB_REPORTS"
  chk "bucket local (:$PORT_FILES)"               port_busy "$PORT_FILES"
  chk "adapter-bcb (:$PORT_ADAPTER_BCB)"          http_ok "http://localhost:$PORT_ADAPTER_BCB/actuator/health"
  chk "satélite Reporteo (:$PORT_SAT)"            http_ok "http://localhost:$PORT_SAT$SAT_PREFIX/health"
  chk "adapter-reportes (:$PORT_ADAPTER_REPORTES)" http_ok "http://localhost:$PORT_ADAPTER_REPORTES$ADAPTER_PREFIX/health"
  printf '\n'
  printf '  %-44s %s\n' "plantillas activas en el satélite" "$(sat_sql "SELECT count(*) FROM report_template WHERE active;")"
  printf '  %-44s %s\n' "reportes pedidos (jobs)" "$(sat_sql "SELECT count(*) FROM report_job;")"
  printf '  %-44s %s\n' "jobs listos con archivo" "$(sat_sql "SELECT count(*) FROM report_job WHERE status='READY';")"
  printf '  %-44s %s\n' "boletos vendidos en BCB" "$(bcb_sql "SELECT count(*) FROM \"OrderItem\";")"
  printf '  %-44s %s\n' "archivos en el bucket local" "$(ls -1 "$BUCKET_DIR" 2>/dev/null | wc -l | tr -d ' ')"
  [ -f "$RUN_DIR/reporteo-folio.txt" ] && \
    printf '  %-44s %s\n' "folio de prueba (CU-005)" "$(cat "$RUN_DIR/reporteo-folio.txt")"

  # adapter-bcb es compartido: cualquier `up` de otro flujo lo reinicia SIN la URL local y
  # lo deja apuntando al API Gateway de develop. No se puede leer el entorno de un JVM vivo,
  # pero su propio log dice a dónde llamó, y eso alcanza para delatarlo.
  if grep -q 'PETICION POST https://[^ ]*execute-api' "$LOG_DIR/adapter-bcb.log" 2>/dev/null; then
    printf '\n'
    warn "el adapter-bcb vivo llamó a un API Gateway de AWS para generar reportes"
    dim  "   debería pegarle a http://localhost:$PORT_BCB_REPORTS — corré: ./e2e up reporteo"
  fi
}

flow_psql() { docker exec -it "$SAT_DB_CONTAINER" psql -U "$SAT_DB_USER" -d "$SAT_DB_NAME"; }
