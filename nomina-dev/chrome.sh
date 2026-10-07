#!/usr/bin/env bash
# Chrome persistente para validar el Portal de Nómina.
# - Perfil propio (no toca el Chrome personal), sobrevive entre sesiones: la cookie/sesión queda.
# - Puerto de depuración 9222: Playwright se conecta al MISMO navegador (connectOverCDP),
#   así que el login manual sirve también para las pruebas automáticas.
# Uso: ./chrome.sh [url]   (idempotente: si ya está arriba, solo abre la URL)
set -euo pipefail
PROFILE="${NOMINA_CHROME_PROFILE:-$HOME/.er-admin-chrome}"
PORT="${NOMINA_CHROME_PORT:-9222}"
URL="${1:-http://127.0.0.1:4200/}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
mkdir -p "$PROFILE"
if curl -s --max-time 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "Chrome ya escucha en :$PORT — abriendo $URL en una pestaña nueva"
  curl -s --max-time 3 -X PUT "http://127.0.0.1:$PORT/json/new?$URL" >/dev/null || true
  exit 0
fi
nohup "$CHROME" \
  --user-data-dir="$PROFILE" \
  --remote-debugging-port="$PORT" \
  --remote-allow-origins='*' \
  --no-first-run --no-default-browser-check \
  --disable-session-crashed-bubble --hide-crash-restore-bubble \
  --window-size=1440,960 \
  "$URL" >"$PROFILE/chrome.log" 2>&1 &
for i in $(seq 1 30); do
  if curl -s --max-time 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
    echo "Chrome arriba en :$PORT (perfil $PROFILE)"; exit 0
  fi
  sleep 0.5
done
echo "Chrome no levantó; ver $PROFILE/chrome.log" >&2; exit 1
