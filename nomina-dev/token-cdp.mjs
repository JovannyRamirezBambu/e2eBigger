// Igual que token.mjs pero SIN Playwright: habla CDP crudo contra la pestaña del admin.
//
// Playwright (`chromium.connectOverCDP`) dejó de completar el handshake a nivel navegador con
// Chrome 153 — conecta el websocket y se queda esperando hasta el timeout. Esto no lo necesita:
// se cuelga del target de la pestaña y evalúa una expresión para leer el sessionStorage.
//
//   node token-cdp.mjs
import fs from 'node:fs';
import { SESSION_FILE, ADMIN_URL, CDP_URL, KEYS, decodeJwt } from './lib.mjs';

const targets = await fetch(`${CDP_URL}/json/list`).then((r) => r.json());
const page = targets.find((t) => t.type === 'page' && (t.url ?? '').startsWith(ADMIN_URL));
if (!page) {
  console.error(`No hay pestaña abierta en ${ADMIN_URL}. Abre el admin y vuelve a intentar.`);
  process.exit(2);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
const respuestas = new Map();
let id = 0;

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mensaje = ++id;
    respuestas.set(mensaje, { resolve, reject });
    ws.send(JSON.stringify({ id: mensaje, method, params }));
  });

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  const pendiente = respuestas.get(msg.id);
  if (!pendiente) return;
  respuestas.delete(msg.id);
  msg.error ? pendiente.reject(new Error(msg.error.message)) : pendiente.resolve(msg.result);
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('No pude conectar al target de la pestaña')), { once: true });
});

const expresion = `JSON.stringify({
  accessToken: sessionStorage.getItem(${JSON.stringify(KEYS.access)}),
  refreshToken: sessionStorage.getItem(${JSON.stringify(KEYS.refresh)}),
  appToken: sessionStorage.getItem(${JSON.stringify(KEYS.app)}),
  user: sessionStorage.getItem(${JSON.stringify(KEYS.user)}),
  url: location.href
})`;

const { result, exceptionDetails } = await send('Runtime.evaluate', { expression: expresion, returnByValue: true });
ws.close();

if (exceptionDetails) {
  console.error('La pestaña no dejó leer el sessionStorage:', exceptionDetails.text);
  process.exit(1);
}

const sesion = JSON.parse(result.value);
if (!sesion.appToken) {
  console.error(`Sin sesión en la pestaña (${sesion.url}) — inicia sesión en el admin y repite.`);
  process.exit(2);
}

const payload = decodeJwt(sesion.appToken) ?? {};
const exp = payload.exp ? new Date(payload.exp * 1000) : null;
fs.writeFileSync(
  SESSION_FILE,
  JSON.stringify({ ...sesion, savedAt: new Date().toISOString(), appTokenExp: exp?.toISOString() ?? null }, null, 2),
);
console.log(
  `sesión guardada · usuario=${payload.username ?? payload['cognito:username'] ?? '?'} · exp=${exp?.toLocaleString() ?? '?'}`,
);
