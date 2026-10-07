// Flujos con datos reales sobre el Portal de Nómina en dev:
//   A. Bonos → Carga masiva (única forma de alta en la UI) → aparece en el listado → eliminar.
//   B. Asistencias → "Crear asistencia" (alta de servicio especial, CU07) → verlo en el detalle
//      del operador → editar → eliminar.
// Usa un operador real ya sincronizado (con tarjeta de viaje real, para poder abrir su detalle).
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { connect, newAuthedPage, loadSession, ADMIN_URL, RELAY_URL, HERE } from './lib.mjs';

const OPERATOR_KEY = process.env.NOMINA_OPERATOR_KEY ?? '304032';
const OPERATOR_NAME = process.env.NOMINA_OPERATOR_NAME ?? 'ANAYA CONTRERAS ROBERTO CARLOS';

const session = loadSession();
if (!session?.appToken) { console.error('Sin sesión: node token.mjs'); process.exit(2); }
const { browser, context } = await connect();
const page = await newAuthedPage(context, session);
page.setDefaultTimeout(20000);

const calls = [];
// `route.fetch()` reconstruye la petición a partir del postData que captura CDP, y CDP no expone
// el contenido binario completo de un archivo dentro de un `multipart/form-data` (limitación
// conocida de Network.getRequestPostData, no de esta app): el archivo llegaba con 0 bytes al
// satélite. Para esas peticiones dejamos pasar la petición original tal cual (`route.continue()`)
// y solo observamos el estatus por un listener aparte, sin tocar el cuerpo.
await page.route(`${RELAY_URL}/**`, async (route) => {
  const req = route.request();
  const rec = { method: req.method(), path: req.url().replace(RELAY_URL, ''), status: null };
  calls.push(rec);
  const isMultipart = (req.headers()['content-type'] ?? '').startsWith('multipart/form-data');
  if (isMultipart) { await route.continue(); return; }
  try { const r = await route.fetch(); rec.status = r.status(); await route.fulfill({ response: r }); }
  catch (e) { rec.status = `ERR ${e.message.slice(0, 60)}`; await route.abort().catch(() => {}); }
});
page.on('response', (res) => {
  const rec = calls.find((c) => c.status === null && res.url() === RELAY_URL + c.path && res.request().method() === c.method);
  if (rec) rec.status = res.status();
});
let since = 0; const mark = () => { since = calls.length; };
const waitCall = async (m, re, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const c = calls.slice(since).find((x) => x.method === m && re.test(x.path) && x.status !== null); if (c) return c; await page.waitForTimeout(150); } return null; };

const checks = []; const ok = (c, m) => { checks.push({ ok: !!c, m }); console.log(`${c ? '  ✅' : '  ❌'} ${m}`); return !!c; };
const skip = (m) => console.log(`  ⏭️  ${m}`);
const shot = (n) => page.screenshot({ path: path.join(HERE, 'results', `flow2-${n}.png`), fullPage: true });
const toastText = async () => (await page.$$eval('.p-toast-message', (els) => els.map((e) => e.textContent?.replace(/\s+/g, ' ').trim())).catch(() => [])).join(' | ');
const dismissToasts = async () => { for (const b of await page.$$('.p-toast-close-button, .p-toast-icon-close')) await b.click().catch(() => {}); };

/** Selecciona un día en un p-datepicker, navegando `monthsAhead` meses adelante desde el mes que ya esté mostrando. */
async function pickCalendarDay(scope, inputSelector, monthsAhead, day) {
  const input = scope.locator(inputSelector);
  await input.click();
  const panel = page.locator('.p-datepicker-panel, .p-datepicker').last();
  await panel.waitFor();
  for (let i = 0; i < monthsAhead; i++) {
    await panel.locator('.p-datepicker-next-button, button[aria-label*="Next"], button[aria-label*="Siguiente"]').first().click();
    await page.waitForTimeout(150);
  }
  await panel.locator('td:not(.p-datepicker-other-month):not(.p-disabled) span:not(.p-disabled)').filter({ hasText: new RegExp(`^${day}$`) }).first().click();
  await page.waitForTimeout(150);
}

try {

/* ═══════════════════════ A · Bonos — carga masiva ═══════════════════════ */
console.log('\n▶ Bonos — carga masiva (alta real vía Excel)');
await page.goto(`${ADMIN_URL}/dashboard/portal-nomina?tab=bonos`, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle').catch(() => {});
await page.getByRole('button', { name: 'Carga masiva' }).click();
const bulk = page.locator('.p-dialog, .p-dynamicdialog').last();
await bulk.waitFor();

// 1) tipo de bono
await bulk.locator('p-select[inputid="bulkBonusType"]').click();
await page.waitForTimeout(400);
await page.getByRole('option', { name: 'Productividad' }).click();
// 2) mes del período (vista de mes: clic en el mes actual, por índice — el `hasText` con
// RegExp no matchea el span de PrimeNG por el espacio+ligadura que trae alrededor del texto).
await bulk.locator('#bulkPeriod').click();
await page.waitForTimeout(400);
const monthPanel = page.locator('.p-datepicker-panel, .p-datepicker').last();
await monthPanel.waitFor();
await monthPanel.locator('span.p-datepicker-month').nth(new Date().getMonth()).click();
await page.waitForTimeout(300);
ok(await bulk.locator('.er-drop-file, ngx-file-drop').isVisible().catch(() => false), 'con tipo + mes puestos aparece la zona de carga');

// 3) descargar la plantilla real y construir el archivo con un operador real + uno inexistente
mark();
const popupP = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
await bulk.getByText('la plantilla').click();
const tplCall = await waitCall('GET', /^\/manual-bonuses\/bulk\/template/);
ok(tplCall && tplCall.status === 200, `GET /manual-bonuses/bulk/template → ${tplCall?.status}`);
const popup = await popupP;
let tplBuf;
if (popup) await popup.close().catch(() => {});
// El link de descarga es el mismo reporte del hallazgo "reportes intermitentes" (satélite con
// ≥2 réplicas y store en memoria): la MISMA url da 404 la mitad de las veces. Reintentamos con
// un reportId nuevo cada vez en lugar de fallar la prueba por un defecto ya reportado aparte.
for (let attempt = 1; attempt <= 5 && !tplBuf; attempt++) {
  const r = await page.request.get(`${RELAY_URL}/manual-bonuses/bulk/template`, { headers: { Authorization: `Bearer ${session.appToken}` } });
  const { url } = await r.json();
  const dl = await page.request.get(url);
  if (dl.ok()) tplBuf = await dl.body();
  else console.log(`     (descarga de plantilla ${dl.status()} en el intento ${attempt}, reintentando — ver "reportes intermitentes")`);
}
if (!tplBuf) throw new Error('no se pudo descargar la plantilla tras 5 intentos');
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(tplBuf);
const ws = wb.worksheets[0];
const headers = (ws.getRow(1).values ?? []).slice(1).map((v) => String(v ?? '').trim());
const idx = (re) => headers.findIndex((h) => re.test(h.toLowerCase())) + 1;
const cKey = idx(/clave/), cName = idx(/nombre/), cAmount = idx(/monto/), cPeriod = idx(/per[ií]odo/);
for (let i = ws.rowCount; i >= 2; i--) ws.spliceRows(i, 1);
const period = `${new Date().toISOString().slice(0, 7)}-01 a ${new Date().toISOString().slice(0, 7)}-01`;
const fill = (rowN, key, name, amount) => {
  const row = ws.getRow(rowN);
  row.getCell(cKey).value = key; if (cName) row.getCell(cName).value = name;
  row.getCell(cAmount).value = amount; if (cPeriod) row.getCell(cPeriod).value = period;
  row.commit();
};
fill(2, OPERATOR_KEY, OPERATOR_NAME, 75.5);
fill(3, 'NO-EXISTE-UI', 'Operador Inexistente', 20);
const filePath = path.join(HERE, 'results', 'carga-bonos-ui.xlsx');
fs.writeFileSync(filePath, Buffer.from(await wb.xlsx.writeBuffer()));
ok(cKey > 0 && cAmount > 0, `plantilla real mapeada: clave col ${cKey}, monto col ${cAmount} (encabezados: ${headers.join(' | ')})`);

// 4) adjuntar el archivo (input real detrás de ngx-file-drop) y enviar
await bulk.locator('input[type="file"]').setInputFiles(filePath);
await page.waitForTimeout(400);
mark();
await bulk.getByRole('button', { name: 'Cargar bonos' }).click();
const bulkResp = await waitCall('POST', /^\/manual-bonuses\/bulk$/, 20000);
ok(bulkResp && [200, 201].includes(bulkResp.status), `POST /manual-bonuses/bulk → ${bulkResp?.status}`);
await page.waitForTimeout(600);
const rowErrorVisible = await bulk.getByText('No se cargó ningún bono').isVisible().catch(() => false);
ok(rowErrorVisible, 'el diálogo avisa que no se cargó nada y lista las filas con error');
if (rowErrorVisible) {
  const errText = (await bulk.locator('ul li').first().textContent().catch(() => '')) ?? '';
  console.log(`     detalle del error: ${errText.replace(/\s+/g, ' ').trim()}`);
}
console.log(`   toast: ${await toastText() || '-'}`); await dismissToasts();
await shot('bulk-result');
await bulk.getByRole('button', { name: 'Quitar el archivo' }).click().catch(() => {});
await bulk.locator('button[aria-label]').first().click().catch(() => {}); // botón X de cerrar
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(400);

// 5) la carga es TODO O NADA desde el fix de ADM-NOM-01: el archivo traía una fila con clave
//    inexistente, así que NI SIQUIERA el bono válido debe haber entrado.
await page.goto(`${ADMIN_URL}/dashboard/portal-nomina?tab=bonos`, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle').catch(() => {});
const filtersToggle = page.getByPlaceholder('Buscar por operador');
if (await filtersToggle.count()) { await filtersToggle.fill(OPERATOR_KEY); await page.keyboard.press('Enter'); await page.waitForLoadState('networkidle').catch(() => {}); }
await page.waitForTimeout(600);
const bonusRow = page.locator('tr, [role="row"]').filter({ hasText: OPERATOR_KEY }).first();
const bonusRowVisible = await bonusRow.isVisible().catch(() => false);
ok(!bonusRowVisible, `la carga rechazada no dejó ningún bono del operador ${OPERATOR_KEY} en el listado`);
// Red de seguridad: solo entra aquí si la aserción de arriba falló y algo SÍ se escribió. En ese
// caso se borra para no dejar basura en dev, y de paso se ejercita el borrado por UI.
if (bonusRowVisible) {
  await bonusRow.locator('.er-icon-delete, [class*="icon-delete"]').first().click();
  const confirm = page.locator('.p-dialog, .p-dynamicdialog').last();
  await confirm.waitFor();
  mark();
  await confirm.getByRole('button', { name: 'Eliminar' }).click();
  const del = await waitCall('DELETE', /^\/manual-bonuses\//);
  ok(del && [200, 204].includes(del.status), `DELETE /manual-bonuses/{id} → ${del?.status}`);
  console.log(`   toast: ${await toastText() || '-'}`); await dismissToasts();
}

} catch (e) { ok(false, `excepción en flujo Bonos: ${String(e.message ?? e).split('\n')[0].slice(0, 220)}`); await shot('bonos-error').catch(() => {}); }

/* ═══════════════════════ B · Asistencias — servicio especial (CU07) ═══════════════════════ */
try {

console.log('\n▶ Asistencias — crear servicio especial (real)');
await page.goto(`${ADMIN_URL}/dashboard/portal-nomina/asistencia/crear`, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle').catch(() => {});
ok(await page.getByText('Cargar Asistencia').count() > 0, 'abre la página "Cargar Asistencia"');

await page.locator('p-select[formcontrolname="operatorId"]').click();
await page.waitForTimeout(400);
await page.locator('.p-select-filter').fill(OPERATOR_KEY);
await page.waitForTimeout(500);
await page.getByRole('option', { name: new RegExp(OPERATOR_KEY) }).first().click();
ok(await page.getByText(OPERATOR_NAME).count() > 0, 'el operador queda asignado tras elegirlo');

await page.locator('p-select[formcontrolname="serviceType"]').click();
await page.waitForTimeout(400);
await page.getByRole('option', { name: 'Turismo' }).click();

// Dentro del mismo rango Aug-Sep que usa la navegación a Asistencias más abajo: el detalle
// del operador filtra los servicios especiales por el mismo dateFrom/dateTo del tab (por
// diseño, no por bug), así que si el servicio cae fuera de ese rango "no aparece" sin ser un error.
await pickCalendarDay(page, '#serviceStart', 0, 20);
await pickCalendarDay(page, '#serviceEnd', 0, 23);
const workedDaysVal = await page.locator('#workedDays').inputValue();
ok(workedDaysVal.trim() !== '', `días trabajados calculados por el servidor: "${workedDaysVal}"`);

mark();
const crear = page.getByRole('button', { name: 'Cargar' });
for (let i = 0; i < 20 && await crear.isDisabled(); i++) await page.waitForTimeout(250);
await shot('ss-form');
await crear.click();
const ssPost = await waitCall('POST', /^\/special-services$/);
ok(ssPost && [200, 201].includes(ssPost.status), `POST /special-services → ${ssPost?.status}`);
await page.waitForLoadState('networkidle').catch(() => {});
console.log(`   toast: ${await toastText() || '-'}`); await dismissToasts();

console.log('\n▶ Asistencias — ver/editar/eliminar el servicio especial desde el detalle del operador');
// dateFrom/dateTo por query param: la tarjeta real del operador se dispachó el 27-ago,
// fuera del rango-semana por defecto del tab, así que forzamos un rango que la cubra.
await page.goto(`${ADMIN_URL}/dashboard/portal-nomina?tab=asistencias&dateFrom=2026-08-01&dateTo=2026-09-30`, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle').catch(() => {});
await page.waitForTimeout(500);
const opRow = page.locator('tr, [role="row"]').filter({ hasText: OPERATOR_KEY }).first();
ok(await opRow.isVisible().catch(() => false), `el operador ${OPERATOR_KEY} aparece en el listado de Asistencias (tiene tarjeta real)`);
await opRow.locator('.pi-eye').first().click();
const detail = page.locator('.p-dialog, .p-dynamicdialog').last();
await detail.waitFor();
await detail.getByText('Turismo').first().waitFor({ timeout: 8000 }).catch(() => {});
ok(await detail.getByText('Turismo').count() > 0, 'el servicio especial creado aparece en el detalle del operador');
await shot('ss-detail');

mark();
await detail.locator('i.pi-pencil').first().click();
await page.waitForURL(/\/asistencia\/editar\//, { timeout: 8000 }).catch(() => {});
await page.waitForLoadState('networkidle').catch(() => {});
ok(await page.getByText('Editar Asistencia').count() > 0, 'navega a "Editar Asistencia" al hacer clic en el lápiz');
await page.locator('p-select[formcontrolname="serviceType"]').click();
await page.waitForTimeout(400);
await page.getByRole('option', { name: 'Carga' }).click();
mark();
await page.getByRole('button', { name: 'Actualizar' }).click();
const ssPatch = await waitCall('PATCH', /^\/special-services\//);
ok(ssPatch && ssPatch.status === 200, `PATCH /special-services/{id} → ${ssPatch?.status}`);
await page.waitForLoadState('networkidle').catch(() => {});
console.log(`   toast: ${await toastText() || '-'}`); await dismissToasts();

console.log('\n▶ Asistencias — eliminar el servicio especial');
await page.goto(`${ADMIN_URL}/dashboard/portal-nomina?tab=asistencias&dateFrom=2026-08-01&dateTo=2026-09-30`, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle').catch(() => {});
await page.waitForTimeout(500);
const opRow2 = page.locator('tr, [role="row"]').filter({ hasText: OPERATOR_KEY }).first();
await opRow2.locator('.pi-eye').first().click();
const detail2 = page.locator('.p-dialog, .p-dynamicdialog').last();
await detail2.waitFor();
await detail2.getByText('Carga').first().waitFor({ timeout: 8000 }).catch(() => {});
await detail2.locator('i.er-icon-delete').first().click();
const confirm2 = page.locator('.p-dialog, .p-dynamicdialog').last();
await confirm2.waitFor();
mark();
await confirm2.getByRole('button', { name: 'Eliminar' }).click();
const ssDel = await waitCall('DELETE', /^\/special-services\//);
ok(ssDel && [200, 204].includes(ssDel.status), `DELETE /special-services/{id} → ${ssDel?.status}`);
console.log(`   toast: ${await toastText() || '-'}`); await dismissToasts();

} catch (e) { ok(false, `excepción en flujo Asistencias: ${String(e.message ?? e).split('\n')[0].slice(0, 220)}`); await shot('asistencia-error').catch(() => {}); }

const fails = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - fails}/${checks.length} asertos · ${calls.length} llamadas al relay`);
fs.writeFileSync(path.join(HERE, 'results', `flows2-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify({ checks, calls }, null, 2));
await page.close();
  // Nunca cerramos `browser`: es el Chrome real y compartido con Jovanny — browser.close()
  // lo mataría (y con noDefaults+isLocal, Playwright lo trata como propio). Solo soltamos
  // la conexión CDP dejando que el proceso termine; Chrome sigue vivo con su sesión intacta.
process.exitCode = fails ? 1 : 0;
process.exit(process.exitCode);
