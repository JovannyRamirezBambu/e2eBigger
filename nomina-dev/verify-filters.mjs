// Verifica, para cada filtro visible del Portal de Nómina, que elegir una opción (a) cambie la
// URL con el query param correcto y (b) dispare una petición NUEVA al relay con ese filtro.
// No depende de que haya datos suficientes para ver cambiar las filas — eso lo cubre api-tests.mjs.
import { connect, newAuthedPage, loadSession, ADMIN_URL, RELAY_URL } from './lib.mjs';
const session = loadSession();
const { context } = await connect();
const page = await newAuthedPage(context, session);
page.setDefaultTimeout(15000);

let calls = [];
page.on('request', (r) => { if (r.url().startsWith(RELAY_URL) && r.method() === 'GET') calls.push(r.url().replace(RELAY_URL, '')); });
const mark = () => { calls = []; };
const lastCallHasParam = async (param, ms = 4000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (calls.some((c) => c.includes(param))) return calls[calls.length - 1]; await page.waitForTimeout(150); }
  return null;
};

const results = [];
const check = async (tab, label, action) => {
  mark();
  let detail = '';
  try { detail = await action(); } catch (e) { results.push({ tab, label, ok: false, detail: `excepción: ${String(e.message ?? e).split('\n')[0].slice(0, 140)}` }); return; }
  results.push({ tab, label, ok: !!detail, detail: detail || '(sin petición nueva con el param esperado)' });
};

const openSingle = async (title) => { await page.locator('app-selector-with-title').filter({ hasText: title }).locator('[role="combobox"]').click(); await page.waitForTimeout(400); };
const openMulti = async (title) => { await page.locator('app-selector-multiple-with-title').filter({ hasText: title }).locator('.p-multiselect-label-container').click(); await page.waitForTimeout(400); };
const pickOption = async (text) => { await page.getByRole('option', { name: text }).first().click(); await page.waitForTimeout(600); };

/* ═══════════ BONOS ═══════════ */
await page.goto(`${ADMIN_URL}/dashboard/portal-nomina?tab=bonos`, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle').catch(() => {});

await check('Bonos', 'Buscar por operador (busqueda)', async () => {
  mark();
  await page.getByPlaceholder('Buscar por operador').fill('304032');
  return lastCallHasParam('search=304032');
});
await page.getByPlaceholder('Buscar por operador').fill('');
await page.waitForTimeout(600);

await check('Bonos', 'Tipo de Bono (bonusType, multiselect)', async () => {
  await openMulti('Tipo de Bono');
  await pickOption('Bono por productividad');
  return lastCallHasParam('bonusType=PRODUCTIVITY');
});
await check('Bonos', 'Estado (bonusStatus en la URL, status en la API — evita colisión con Asistencias)', async () => {
  await openSingle('Estado');
  await pickOption('Pendiente');
  // El form/URL usan `bonusStatus` a propósito (todos los tabs comparten la misma URL); el
  // padre lo traduce a `status`, el nombre real del contrato. Se valida el nombre real de la API.
  return lastCallHasParam('status=PENDING');
});

/* ═══════════ PAGOS ═══════════ */
await page.goto(`${ADMIN_URL}/dashboard/portal-nomina?tab=pagos`, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle').catch(() => {});

await check('Pagos', 'Tipo de Bono → Tipo de pago (origin, multiselect)', async () => {
  await openMulti('Tipo de Bono');
  await pickOption('Tarjeta de viaje');
  return lastCallHasParam('origin=TRAVEL_CARD');
});
await check('Pagos', 'Servicio (serviceId)', async () => {
  await openSingle('Servicio');
  await page.waitForTimeout(300);
  const firstOpt = page.getByRole('option').first();
  const txt = (await firstOpt.textContent()) ?? '';
  await firstOpt.click();
  await page.waitForTimeout(600);
  const c = await lastCallHasParam('serviceId=');
  return c ? `${c}  (elegido: ${txt.trim()})` : null;
});
await check('Pagos', 'Buscar por operador (busqueda)', async () => {
  mark();
  await page.getByPlaceholder('Buscar por operador').fill('304032');
  return lastCallHasParam('search=304032');
});

/* ═══════════ ASISTENCIAS ═══════════ */
await page.goto(`${ADMIN_URL}/dashboard/portal-nomina?tab=asistencias`, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle').catch(() => {});

await check('Asistencias', 'Buscar por operador (busqueda)', async () => {
  mark();
  await page.getByPlaceholder('Buscar por operador').fill('304032');
  return lastCallHasParam('search=304032');
});
await page.getByPlaceholder('Buscar por operador').fill('');
await page.waitForTimeout(600);

await check('Asistencias', 'Botón "Hoy"', async () => {
  await page.getByRole('button', { name: 'Hoy' }).click();
  await page.waitForTimeout(600);
  // Fecha local de hoy (no Date.toISOString(), que puede caer en el día siguiente en UTC).
  const d = new Date(); const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const c = calls[calls.length - 1] ?? '';
  return c.includes(`dateFrom=${today}`) && c.includes(`dateTo=${today}`) ? c : null;
});
await check('Asistencias', 'Servicio (serviceId)', async () => {
  await openSingle('Servicio');
  await page.waitForTimeout(300);
  const firstOpt = page.getByRole('option').first();
  const txt = (await firstOpt.textContent()) ?? '';
  await firstOpt.click();
  await page.waitForTimeout(600);
  const c = await lastCallHasParam('serviceId=');
  return c ? `${c}  (elegido: ${txt.trim()})` : null;
});
await check('Asistencias', 'Ruta (routeId)', async () => {
  await openSingle('Ruta');
  await page.waitForTimeout(300);
  const firstOpt = page.getByRole('option').first();
  const txt = (await firstOpt.textContent()) ?? '';
  await firstOpt.click();
  await page.waitForTimeout(600);
  const c = await lastCallHasParam('routeId=');
  return c ? `${c}  (elegido: ${txt.trim()})` : null;
});
await check('Asistencias', 'Estatus de tarjeta (status)', async () => {
  await openSingle('Estatus de tarjeta');
  await pickOption('Recaudada');
  return lastCallHasParam('status=RECAUDADA');
});

/* ═══════════ DÍAS INHÁBILES ═══════════ */
await page.goto(`${ADMIN_URL}/dashboard/portal-nomina?tab=dias-inhabiles`, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle').catch(() => {});

await check('Días inhábiles', 'Por estados (dayStatus → dateTo, ya corregido)', async () => {
  await openSingle('Por estados');
  await pickOption('Cumplida');
  return lastCallHasParam('dateTo=');
});

console.log('\n' + '='.repeat(70));
for (const r of results) console.log(`${r.ok ? '✅' : '❌'} [${r.tab}] ${r.label}\n     ${r.detail}`);
const okCount = results.filter((r) => r.ok).length;
console.log(`\n${okCount}/${results.length} filtros verificados como funcionales`);
await page.close();
process.exit(0);
