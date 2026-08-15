#!/usr/bin/env bash
# Utilidades compartidas por todos los flujos. Se hace `source` desde e2e y desde flows/*/flow.sh.

E2E_ROOT="${E2E_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ER_ROOT="${ER_ROOT:-$(cd "$E2E_ROOT/.." && pwd)}"
RUN_DIR="$E2E_ROOT/run"
KEYS_DIR="$RUN_DIR/keys"
LOG_DIR="$RUN_DIR/logs"
PID_DIR="$RUN_DIR/pids"
mkdir -p "$KEYS_DIR" "$LOG_DIR" "$PID_DIR"

if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
  C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[36m'
else
  C_RESET=''; C_DIM=''; C_BOLD=''; C_GREEN=''; C_RED=''; C_YELLOW=''; C_BLUE=''
fi

log()   { printf '%s\n' "${C_BLUE}▸${C_RESET} $*"; }
ok()    { printf '%s\n' "${C_GREEN}✓${C_RESET} $*"; }
warn()  { printf '%s\n' "${C_YELLOW}!${C_RESET} $*"; }
err()   { printf '%s\n' "${C_RED}✗${C_RESET} $*" >&2; }
dim()   { printf '%s\n' "${C_DIM}$*${C_RESET}"; }
die()   { err "$*"; exit 1; }
step()  { printf '\n%s\n' "${C_BOLD}── $* ${C_RESET}"; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "falta el comando '$1' en el PATH"
}

# ── Esperas ────────────────────────────────────────────────────────────────
# wait_for <descripción> <timeout_seg> <comando...>
wait_for() {
  local desc="$1" timeout="$2"; shift 2
  local waited=0
  while ! "$@" >/dev/null 2>&1; do
    if [ "$waited" -ge "$timeout" ]; then
      err "timeout esperando: $desc (${timeout}s)"
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  ok "$desc (${waited}s)"
}

http_ok() { curl -fsS -o /dev/null --max-time 3 "$1"; }

pg_ready() { # pg_ready <container> <user> <db>
  docker exec "$1" pg_isready -U "$2" -d "$3" >/dev/null 2>&1
}

port_busy() { lsof -iTCP:"$1" -sTCP:LISTEN -P >/dev/null 2>&1; }

# ── Procesos en el host (jars y apps node) ─────────────────────────────────
# start_bg <nombre> <logfile> <comando...>   — el entorno se hereda del caller
start_bg() {
  local name="$1" logfile="$2"; shift 2
  # nohup: el proceso debe sobrevivir a la salida del script.
  nohup "$@" >"$logfile" 2>&1 &
  echo $! > "$PID_DIR/$name.pid"
  dim "   $name → pid $(cat "$PID_DIR/$name.pid"), log: ${logfile/#$E2E_ROOT\//}"
}

stop_bg() { # stop_bg <nombre>
  local name="$1" pidfile="$PID_DIR/$1.pid"
  [ -f "$pidfile" ] || return 0
  local pid; pid=$(cat "$pidfile")
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    local waited=0
    while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 10 ]; do sleep 1; waited=$((waited+1)); done
    kill -9 "$pid" 2>/dev/null || true
    ok "$name detenido"
  fi
  rm -f "$pidfile"
}

is_running() { # is_running <nombre>
  local pidfile="$PID_DIR/$1.pid"
  [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null
}

# Matar el pid registrado NO alcanza: `pnpm exec …` es un wrapper y su hijo node
# queda huérfano sosteniendo el puerto. El síntoma es EADDRINUSE en el log del
# servicio nuevo, mientras las pruebas le siguen pegando al proceso viejo — un
# falso verde muy difícil de ver. Por eso se cierra por puerto, no por pid.
kill_port() { # kill_port <puerto>
  local port="$1" pids
  pids=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null)
  [ -n "$pids" ] || return 0
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null
  local waited=0
  while lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && [ "$waited" -lt 10 ]; do
    sleep 1; waited=$((waited + 1))
  done
  pids=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null)
  # shellcheck disable=SC2086
  [ -n "$pids" ] && kill -9 $pids 2>/dev/null
  return 0
}

ensure_port_free() { # ensure_port_free <puerto> <etiqueta>
  if port_busy "$1"; then
    warn "puerto $1 ocupado por un proceso previo ($2) — lo cierro"
    kill_port "$1"
  fi
}

# ── Llaves RSA para los saltos de autenticación ────────────────────────────
# Genera un par por "leg". Dos formatos porque los dos lados NO son compatibles:
#   *-private.pem        PKCS#1 — lo que consume jsonwebtoken (Node/satélites)
#   *-private-pkcs8.pem  PKCS#8 — lo que exige PemRsaKeyParser (Java/adapters)
# Confundirlos da "InvalidKeySpecException: algid parse error" en el lado Java.
ensure_keypair() { # ensure_keypair <leg>
  local leg="$1"
  local priv="$KEYS_DIR/$leg-private.pem"
  if [ ! -f "$priv" ]; then
    openssl genrsa -out "$priv" 2048 2>/dev/null
    openssl rsa -in "$priv" -pubout -out "$KEYS_DIR/$leg-public.pem" 2>/dev/null
    openssl pkcs8 -topk8 -nocrypt -in "$priv" -out "$KEYS_DIR/$leg-private-pkcs8.pem" 2>/dev/null
    chmod 600 "$KEYS_DIR/$leg"-*.pem
    ok "par de llaves '$leg' generado"
  fi
}

key_path() { echo "$KEYS_DIR/$1"; }

# PEM con \n escapados, para meterlo en una variable de entorno de una línea.
pem_escaped() { awk '{printf "%s\\n", $0}' "$1"; }

# ── Frescura de artefactos compilados ──────────────────────────────────────
# La trampa #1 de este monorepo: un jar compilado antes de que existiera un
# consumer nuevo arranca sin error y simplemente NO registra el consumer.
jar_is_stale() { # jar_is_stale <jar> <dir_fuentes...>
  local jar="$1"; shift
  [ -f "$jar" ] || return 0
  local newer
  newer=$(find "$@" -name '*.java' -newer "$jar" -print -quit 2>/dev/null)
  [ -n "$newer" ]
}

# Un jar recién empaquetado NO entra en un proceso que ya está corriendo: la JVM lo
# leyó al arrancar. Si se recompila y no se reinicia, las pruebas corren contra el
# binario viejo y el verde no significa nada — es el mismo engaño que el jar stale,
# solo que al revés (antes faltaba compilar; acá falta reiniciar).
#
# Se aplica también a los adapters compartidos: reiniciar adapter-bcb y que otro
# flujo lo levante de nuevo cuesta segundos; probar contra código que ya no existe
# cuesta una tarde.
stop_rebuilt() { # stop_rebuilt <servicio...>
  local s
  for s in "$@"; do
    if is_running "$s"; then
      warn "$s se recompiló — se reinicia para que corra el jar nuevo"
      stop_bg "$s"
    fi
  done
}

# ── Build del panel (React/Vite/Tailwind) ──────────────────────────────────
# Mismo principio que jar_is_stale: un ui/dist/ viejo serviría el panel de ayer
# sin ningún error visible — el navegador no tiene forma de saber que el bundle
# no incluye tu último cambio. Se compara también contra package.json y los
# configs, no solo contra src/, para que un cambio de dependencias fuerce rebuild.
ui_dist_is_stale() {
  local dist="$E2E_ROOT/ui/dist/index.html"
  [ -f "$dist" ] || return 0
  local newer
  newer=$(find "$E2E_ROOT/ui/src" "$E2E_ROOT/ui/index.html" "$E2E_ROOT/ui/package.json" \
    "$E2E_ROOT/ui/vite.config.ts" "$E2E_ROOT/ui/tailwind.config.ts" \
    -newer "$dist" -print -quit 2>/dev/null)
  [ -n "$newer" ]
}

ensure_ui_build() {
  need_cmd pnpm
  if [ ! -d "$E2E_ROOT/ui/node_modules" ]; then
    log "instalando dependencias del panel (primera vez — react, vite, tailwind…)"
    ( cd "$E2E_ROOT/ui" && pnpm install ) || die "pnpm install falló en ui/"
  fi
  if ui_dist_is_stale; then
    log "panel desactualizado — reconstruyendo (pnpm --dir ui build)"
    ( cd "$E2E_ROOT/ui" && pnpm run build ) || die "el build del panel falló"
    ok "panel reconstruido"
  fi
}

# ── Infraestructura compartida entre flujos ────────────────────────────────
# adapter-bcb lo usan TODOS los flujos (es la puerta de BIGER hacia BCB), así que
# vive acá y no en un flujo. Quien lo levante configura las URLs de los dos
# satélites de BCB —el app `bcb` y el app `webhooks`, que son distintos— porque el
# proceso es uno solo y el segundo flujo en arrancar no lo reinicia.
start_adapter_bcb() { # start_adapter_bcb <repo_main> <url_bcb> <url_webhooks> <leg>
  local repo_main="$1" url_bcb="$2" url_webhooks="$3" leg="$4"
  if is_running adapter-bcb; then
    dim "   adapter-bcb ya corriendo"
    return 0
  fi
  stop_bg adapter-bcb
  ensure_port_free 8085 adapter-bcb

  local seed; seed=$(grep -m1 '^BCB_SECRET_NATS_SEED=' "$repo_main/.env" | cut -d= -f2)
  [ -n "$seed" ] || die "falta BCB_SECRET_NATS_SEED en $repo_main/.env"

  ( cd "$repo_main" && \
    SPRING_PROFILES_ACTIVE=local NATS_URL="${NATS_URL:-nats://localhost:4222}" \
    SECRETS_SOURCE=local DB_SECRET=db-local \
    DB_SECRET_KEY_VALUE='{"username":"biger","password":"biger_local"}' \
    NATS_NKEY_SECRET=nats-nkey-bcb NATS_NKEY_SECRET_KEY_VALUE="{\"seed\":\"$seed\"}" \
    SPRING_DATASOURCE_URL="jdbc:postgresql://localhost:5433/db_biger" \
    JWT_BYPASS=true BCB_MULTI_ISSUER_AUTH_ENABLED=false \
    BCB_SATELLITE_URL="$url_bcb" \
    BCB_WEBHOOKS_SATELLITE_URL="$url_webhooks" \
    BCB_AUTH_PRIVATE_KEY_SECRET_KEY_VALUE="{\"privateKey\":\"$(pem_escaped "$(key_path "$leg-private-pkcs8.pem")")\"}" \
    BCB_AUTH_SUBJECT=adapter-bcb \
    OTLP_TRACES_ENABLED=false \
    start_bg adapter-bcb "$LOG_DIR/adapter-bcb.log" \
      java -jar "$repo_main/adapter-bcb/target/adapter-bcb-1.0.0-SNAPSHOT.jar" )
}

# El app `bcb` (el satélite BCB de verdad) también lo comparten varios flujos:
# tomtom le pega a /corridas y /tarjetas-viaje, ticketcolectoroffline a /sync. Es UN
# proceso, así que se levanta una sola vez y el bootstrap tiene que ser el mismo —
# por eso vive en lib/ y no dentro de un flujo. Con una copia por flujo, el segundo
# en arrancar no reinicia nada y en realidad estarías probando contra el bootstrap
# del primero, creyendo que es el tuyo.
start_bcb_app() { # start_bcb_app <repo_bcb> <puerto> <db_url> <leg>
  local repo_bcb="$1" port="$2" db_url="$3" leg="$4"
  if is_running bcb-app; then
    dim "   app bcb ya corriendo"
    return 0
  fi
  stop_bg bcb-app
  ensure_port_free "$port" "app bcb"
  graft "$E2E_ROOT/lib/bcb-bootstrap.ts" "$repo_bcb" "scripts/e2e/bootstrap.ts"
  ( cd "$repo_bcb" && \
    DATABASE_URL="$db_url" NODE_ENV=development AWS_REGION=us-west-2 PORT="$port" \
    E2E_PUBLIC_KEY_PATH="$(key_path "$leg-public.pem")" \
    start_bg bcb-app "$LOG_DIR/bcb-app.log" \
      pnpm exec ts-node -r tsconfig-paths/register scripts/e2e/bootstrap.ts )
}

# ── Reporte de resultados ──────────────────────────────────────────────────
E2E_PASS=0
E2E_FAIL=0
E2E_FAILED_NAMES=()
E2E_CASE_RESULTS=()
E2E_ONLY=""

# run_case corre un caso si no se pidió uno específico, y registra si pasó
# (ningún assert nuevo falló durante él). Vive acá y no en el flujo para que
# todos los flujos —y la UI— compartan el mismo registro de resultados.
run_case() { # run_case <nombre> <función>
  local name="$1" fn="$2"
  if [ -n "$E2E_ONLY" ] && [ "$E2E_ONLY" != "$name" ]; then return 0; fi
  local before="$E2E_FAIL"
  "$fn"
  if [ "$E2E_FAIL" -gt "$before" ]; then
    E2E_CASE_RESULTS+=("$name:fail")
  else
    E2E_CASE_RESULTS+=("$name:ok")
  fi
}

# Recorre FLOW_CASES (declarado por el flujo como "nombre:función").
run_all_cases() {
  local entry
  for entry in "${FLOW_CASES[@]}"; do
    run_case "${entry%%:*}" "${entry##*:}"
  done
}

# Persiste el resultado por caso para que la UI lo muestre al abrir, sin tener
# que volver a correr nada. FUSIONA con lo que ya había: correr un caso suelto no
# debe borrar lo que sabemos de los otros 17.
write_results_json() { # write_results_json <flujo>
  local flow="$1" out="$RUN_DIR/$flow-results.json"
  E2E_FLOW="$flow" E2E_OUT="$out" E2E_RESULTS="${E2E_CASE_RESULTS[*]}" \
  E2E_P="$E2E_PASS" E2E_F="$E2E_FAIL" \
  python3 -c '
import json, os
out = os.environ["E2E_OUT"]
prev = {}
try:
    with open(out) as fh: prev = json.load(fh)
except Exception: pass
cases = prev.get("cases", {}) if isinstance(prev.get("cases"), dict) else {}
for item in os.environ["E2E_RESULTS"].split():
    name, _, status = item.rpartition(":")
    if name: cases[name] = status
with open(out, "w") as fh:
    json.dump({
        "flow": os.environ["E2E_FLOW"],
        "cases": cases,
        "lastRun": {"pass": int(os.environ["E2E_P"]), "fail": int(os.environ["E2E_F"]),
                    "cases": len(os.environ["E2E_RESULTS"].split())},
    }, fh)'
}

assert_eq() { # assert_eq <descripción> <esperado> <obtenido> [detalle]
  local desc="$1" expected="$2" actual="$3" detail="${4:-}"
  if [ "$expected" = "$actual" ]; then
    E2E_PASS=$((E2E_PASS + 1))
    printf '%s %s %s\n' "${C_GREEN}PASS${C_RESET}" "$desc" "${C_DIM}[$actual]${C_RESET}"
  else
    E2E_FAIL=$((E2E_FAIL + 1))
    E2E_FAILED_NAMES+=("$desc")
    printf '%s %s %s\n' "${C_RED}FAIL${C_RESET}" "$desc" "${C_RED}esperado=$expected obtenido=$actual${C_RESET}"
    [ -n "$detail" ] && dim "     $detail"
  fi
}

assert_present() { # assert_present <descripción> <valor> [detalle]
  local desc="$1" value="$2" detail="${3:-}"
  if [ -n "$value" ]; then
    E2E_PASS=$((E2E_PASS + 1))
    printf '%s %s %s\n' "${C_GREEN}PASS${C_RESET}" "$desc" "${C_DIM}[$value]${C_RESET}"
  else
    E2E_FAIL=$((E2E_FAIL + 1))
    E2E_FAILED_NAMES+=("$desc")
    printf '%s %s %s\n' "${C_RED}FAIL${C_RESET}" "$desc" "${C_RED}(vacío / timeout)${C_RESET}"
    [ -n "$detail" ] && dim "     $detail"
  fi
}

print_summary() { # print_summary <nombre_flujo>
  printf '\n%s\n' "${C_BOLD}── Resultado: $1 ${C_RESET}"
  if [ "$E2E_FAIL" -eq 0 ]; then
    printf '%s\n' "${C_GREEN}${E2E_PASS} pass / 0 fail${C_RESET}"
  else
    printf '%s\n' "${C_RED}${E2E_PASS} pass / ${E2E_FAIL} fail${C_RESET}"
    for n in "${E2E_FAILED_NAMES[@]}"; do printf '   %s\n' "${C_RED}· $n${C_RESET}"; done
  fi
  return "$E2E_FAIL"
}

# ── Copia temporal de scripts dentro de un repo ────────────────────────────
# Algunos scripts (bootstrap de la app BCB, trigger del satélite) importan
# módulos por alias de tsconfig, así que TIENEN que ejecutarse desde dentro del
# repo. Se copian al entrar y se borran al salir para no dejar basura en git.
graft() { # graft <origen> <repo> <ruta_relativa>
  local src="$1" repo="$2" rel="$3"
  mkdir -p "$(dirname "$repo/$rel")"
  cp "$src" "$repo/$rel"
  echo "$repo/$rel" >> "$RUN_DIR/grafted.list"
}

ungraft_all() {
  [ -f "$RUN_DIR/grafted.list" ] || return 0
  while IFS= read -r f; do [ -n "$f" ] && rm -f "$f"; done < "$RUN_DIR/grafted.list"
  rm -f "$RUN_DIR/grafted.list"
}
