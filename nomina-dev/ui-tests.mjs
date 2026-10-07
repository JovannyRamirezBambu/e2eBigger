// Cableado y navegación del módulo Portal de Nómina en el CMS local, usando la sesión del
// Chrome persistente. Recorre los 4 tabs, registra cada llamada al relay (ruta, token, estatus),
// los toasts y los errores de consola, y deja una captura por tab en results/.
//
//   node ui-tests.mjs                          # contra el relay que trae el build (dev)
//   node ui-tests.mjs --relay http://localhost:8098/portalnomina   # reescribe las llamadas al relay local
//   node ui-tests.mjs --tabs bonos,pagos
import fs from 'node:fs';
import path from 'node:path';
import { connect, newAuthedPage, loadSession, ADMIN_URL, RELAY_URL, HERE } from './lib.mjs';

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : def; };
const RELAY_OVERRIDE = arg('--relay', null);
const TABS = (arg('--tabs', 'bonos,pagos,asistencias,dias-inhabiles')).split(',');
const session = loadSession();
if (!session?.appToken) { console.error('Sin sesión: corre `node token.mjs` con el admin logueado.'); process.exit(2); }

const { browser, context } = await connect();
const page = await newAuthedPage(context, session);
const calls = []; const consoleErrors = []; const results = { when: new Date().toISOString(), relay: RELAY_OVERRIDE ?? RELAY_URL, tabs: {} };

page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push({ tab: current, text: m.text().slice(0, 300) }); });
page.on('pageerror', (e) => consoleErrors.push({ tab: current, text: `pageerror: ${String(e).slice(0, 300)}` }));
let current = 'inicio';

// Registro de TODAS las llamadas al relay (dev) + opcionalmente reescritura hacia otro relay.
await page.route(`${RELAY_URL}/**`, async (route) => {
  const req = route.request();
  const h = req.headers();
  const started = Date.now();
  const rec = { tab: current, method: req.method(), path: req.url().replace(RELAY_URL, ''), auth: h.authorization ? (h.authorization === `Bearer ${session.appToken}` ? 'appToken(Cognito)' : h.authorization === `Bearer ${session.accessToken}` ? 'idToken(BCB) ✗' : 'otro ✗') : 'sin token ✗', xlang: h['x-lang'] ?? '-', status: null, ms: null };
  calls.push(rec);
  try {
    if (RELAY_OVERRIDE) {
      const resp = await route.fetch({ url: RELAY_OVERRIDE + rec.path });
      rec.status = resp.status(); rec.ms = Date.now() - started;
      const headers = { ...resp.headers(), 'access-control-allow-origin': '*' };
      await route.fulfill({ response: resp, headers });
    } else {
      const resp = await route.fetch();
      rec.status = resp.status(); rec.ms = Date.now() - started;
      await route.fulfill({ response: resp });
    }
  } catch (e) { rec.status = `ERR ${String(e.message).slice(0, 80)}`; await route.abort().catch(() => {}); }
});
// Cualquier llamada al camino viejo o al camino equivocado cuenta como defecto de cableado.
const wrong = [];
page.on('request', (r) => { const u = r.url(); if (u.includes('/operation/') || u.includes('/bcb/portalnomina')) wrong.push({ tab: current, url: u.slice(0, 160) }); });

const settle = async () => { try { await page.waitForLoadState('networkidle', { timeout: 20000 }); } catch {} ; await page.waitForTimeout(800); };
const toasts = async () => page.$$eval('.p-toast-message, .p-toast-detail, .p-toast-summary', (els) => [...new Set(els.map((e) => e.textContent?.trim()).filter(Boolean))]).catch(() => []);

for (const tab of TABS) {
  current = tab;
  const before = calls.length;
  await page.goto(`${ADMIN_URL}/dashboard/portal-nomina?tab=${tab}`, { waitUntil: 'domcontentloaded' });
  await settle();
  const url = page.url();
  const redirectedToLogin = url.includes('iniciar-sesion');
  const shot = path.join(HERE, 'results', `ui-${tab}.png`);
  await page.screenshot({ path: shot, fullPage: true });
  const tabCalls = calls.slice(before);
  const rows = await page.$$eval('table tbody tr, p-table tbody tr', (trs) => trs.length).catch(() => 0);
  const cards = await page.$$eval('app-non-working-days-card, .non-working-day-card', (els) => els.length).catch(() => 0);
  const t = await toasts();
  results.tabs[tab] = { url, redirectedToLogin, calls: tabCalls, toasts: t, rows, cards, shot };
  console.log(`\n▶ ${tab}  (${url.replace(ADMIN_URL, '')})${redirectedToLogin ? '  ⚠️ REDIRIGIÓ AL LOGIN' : ''}`);
  for (const c of tabCalls) console.log(`   ${String(c.status).padEnd(4)} ${c.method.padEnd(5)} ${c.path.slice(0, 110)}  · ${c.auth} · X-Lang ${c.xlang}${c.ms != null ? ` · ${c.ms} ms` : ''}`);
  if (!tabCalls.length) console.log('   (sin llamadas al relay)');
  console.log(`   filas en tabla: ${rows} · tarjetas: ${cards} · toasts: ${t.length ? t.join(' | ') : '-'}`);
}

// ── veredicto de cableado ──
const bad = calls.filter((c) => !c.auth.startsWith('appToken'));
const badLang = calls.filter((c) => c.xlang !== 'es');
const okStatus = calls.filter((c) => typeof c.status === 'number' && c.status < 400).length;
console.log('\n── Cableado ──');
console.log(`${calls.length} llamadas al relay · ${okStatus} con 2xx/3xx · ${calls.length - okStatus} con error`);
console.log(`${bad.length === 0 ? '✅' : '❌'} todas llevan el token de aplicación (Cognito)${bad.length ? ': ' + bad.map((b) => b.path).join(', ') : ''}`);
console.log(`${badLang.length === 0 ? '✅' : '❌'} todas llevan X-Lang: es`);
console.log(`${wrong.length === 0 ? '✅' : '❌'} ninguna llamada al camino viejo (/operation) ni a /bcb/portalnomina${wrong.length ? ': ' + wrong.map((w) => w.url).join(', ') : ''}`);
const loginRedirects = Object.entries(results.tabs).filter(([, v]) => v.redirectedToLogin).map(([k]) => k);
console.log(`${loginRedirects.length === 0 ? '✅' : '❌'} ningún tab cerró la sesión${loginRedirects.length ? ' (redirigió: ' + loginRedirects.join(',') + ')' : ''}`);
if (consoleErrors.length) { console.log(`⚠️  ${consoleErrors.length} errores de consola:`); for (const e of consoleErrors.slice(0, 8)) console.log(`   [${e.tab}] ${e.text}`); }
results.calls = calls; results.wrong = wrong; results.consoleErrors = consoleErrors;
const out = path.join(HERE, 'results', `ui-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`resultados → ${out}`);
await page.close();
  // Nunca cerramos `browser`: es el Chrome real y compartido con Jovanny — browser.close()
  // lo mataría (y con noDefaults+isLocal, Playwright lo trata como propio). Solo soltamos
  // la conexión CDP dejando que el proceso termine; Chrome sigue vivo con su sesión intacta.
process.exitCode = bad.length || wrong.length || loginRedirects.length ? 1 : 0;
process.exit(process.exitCode);
