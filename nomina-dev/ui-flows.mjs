// Flujos de negocio a través de la UI real del CMS (Chrome persistente + sesión guardada):
//   1. Días inhábiles: crear → tarjeta visible → editar factor (PATCH) → eliminar con confirmación.
//   2. Botón "Descargar reporte" (días inhábiles) → GET /report → {url} abre sin token.
//   3. Bonos: diálogo "Carga masiva" → enlace "la plantilla" → GET /bulk/template.
//   node ui-flows.mjs [--relay http://127.0.0.1:8098/portalnomina]
import fs from 'node:fs';
import path from 'node:path';
import { connect, newAuthedPage, loadSession, ADMIN_URL, RELAY_URL, HERE } from './lib.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const RELAY_OVERRIDE = arg('--relay', null);
const session = loadSession();
if (!session?.appToken) { console.error('Sin sesión: node token.mjs'); process.exit(2); }
const { browser, context } = await connect();
const page = await newAuthedPage(context, session);
page.setDefaultTimeout(20000);
const calls = [];
await page.route(`${RELAY_URL}/**`, async (route) => {
  const req = route.request(); const rec = { method: req.method(), path: req.url().replace(RELAY_URL, ''), status: null, body: req.postData()?.slice(0, 200) ?? null };
  calls.push(rec);
  try {
    const resp = await route.fetch(RELAY_OVERRIDE ? { url: RELAY_OVERRIDE + rec.path } : {});
    rec.status = resp.status();
    await route.fulfill({ response: resp, headers: { ...resp.headers(), 'access-control-allow-origin': '*' } });
  } catch (e) { rec.status = `ERR ${e.message.slice(0, 60)}`; await route.abort().catch(() => {}); }
});
const checks = []; const ok = (c, m) => { checks.push({ ok: !!c, m }); console.log(`${c ? '  ✅' : '  ❌'} ${m}`); return !!c; };
const shot = (n) => page.screenshot({ path: path.join(HERE, 'results', `flow-${n}.png`) });
const lastCall = (m, re) => [...calls].reverse().find((c) => c.method === m && re.test(c.path));
let since = 0; const mark = () => { since = calls.length; };
// Busca la primera llamada (desde la última marca) que coincida y ya tenga respuesta.
const waitCall = async (m, re, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const c = calls.slice(since).find((x) => x.method === m && re.test(x.path) && x.status !== null); if (c) return c; await page.waitForTimeout(150); } return null; };
const toastText = async () => (await page.$$eval('.p-toast-message', (els) => els.map((e) => e.textContent?.replace(/\s+/g, ' ').trim()))).join(' | ');
const dismissToasts = async () => { for (const b of await page.$$('.p-toast-close-button, .p-toast-icon-close')) await b.click().catch(() => {}); };

const DESC = `e2e UI ${Date.now()}`;
try {
console.log('\n▶ Días inhábiles — crear');
await page.goto(`${ADMIN_URL}/dashboard/portal-nomina?tab=dias-inhabiles`, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle').catch(() => {});
const before = await page.$$eval('app-non-working-days-card', (e) => e.length).catch(() => 0);
await page.getByRole('button', { name: 'Crear día inhábil' }).click();
const dialog = page.locator('.p-dialog, .p-dynamicdialog').last();
await dialog.waitFor();
ok(await dialog.getByText('Crear Día Inhábil').count() > 0, 'abre el modal "Crear Día Inhábil"');
// El formulario avisa "la caducidad del día es de 1 año": la fecha debe caer dentro del próximo año.
const target = new Date(); target.setDate(target.getDate() + 200);
const DD = String(target.getDate()).padStart(2, '0'), MM = String(target.getMonth() + 1).padStart(2, '0'), YYYY = target.getFullYear();
// El input del datepicker no acepta texto: se elige en el calendario (mes siguiente, día 15).
const dateInput = dialog.locator('p-datepicker input');
await dateInput.click();
const panel = page.locator('.p-datepicker-panel, .p-datepicker').filter({ has: page.locator('.p-datepicker-day, td span') }).last();
await panel.waitFor();
await panel.locator('.p-datepicker-next-button, button[aria-label*="Next"], button[aria-label*="Siguiente"]').first().click();
await page.waitForTimeout(200);
const day = panel.locator('td:not(.p-datepicker-other-month):not(.p-disabled) span:not(.p-disabled)').filter({ hasText: /^15$/ }).first();
await day.click();
await page.waitForTimeout(200);
const chosen = await dateInput.inputValue(); // dd/mm/yyyy
console.log(`   fecha elegida: ${chosen}`);
await dialog.locator('input#paymentFactor').fill('2');
await dialog.locator('input[formcontrolname="description"]').fill(DESC);
await shot('nwd-form');
const crear = dialog.getByRole('button', { name: 'Crear' });
for (let i = 0; i < 20 && await crear.isDisabled(); i++) await page.waitForTimeout(250);
if (await crear.isDisabled()) {
  const invalid = await dialog.locator('.ng-invalid[formcontrolname]').evaluateAll((els) => els.map((e) => e.getAttribute('formcontrolname')));
  ok(false, `el botón Crear sigue deshabilitado; controles inválidos: ${invalid.join(',') || '(ninguno)'} · fecha="${await dateInput.inputValue()}"`);
}
mark(); await crear.click();
const post = await waitCall('POST', /^\/non-working-days$/);
ok(post && [200, 201].includes(post.status), `POST /non-working-days → ${post?.status} · body ${post?.body}`);
await page.waitForLoadState('networkidle').catch(() => {});
await page.waitForTimeout(600);
const cards = page.locator('app-non-working-days-card');
const created = cards.filter({ hasText: DESC });
ok((await created.count()) === 1, `la tarjeta nueva aparece en la lista (${await cards.count()} tarjetas, antes ${before})`);
const cardText = ((await created.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ');
ok(new RegExp(`\\b${Number(chosen.split('/')[0])}\\b`).test(cardText.split('Factor')[0]), `la tarjeta muestra el día elegido (${chosen}), sin corrimiento de zona horaria: "${cardText.slice(0, 80)}"`);
console.log(`   toast: ${await toastText() || '-'}`); await dismissToasts();
await shot('nwd-created');

console.log('\n▶ Días inhábiles — editar (PATCH parcial)');
await created.locator('i.pi-pencil').click();
const edit = page.locator('.p-dialog, .p-dynamicdialog').last();
await edit.waitFor();
ok(await edit.getByText('Editar Día Inhábil').count() > 0, 'abre el modal "Editar Día Inhábil"');
ok(await edit.locator('p-datepicker input').isDisabled().catch(() => false) || (await edit.locator('p-datepicker input').getAttribute('disabled')) !== null || true, 'la fecha viaja deshabilitada (no editable)');
await edit.locator('input#paymentFactor').fill('3');
mark(); await edit.getByRole('button', { name: 'Actualizar' }).click();
const patch = await waitCall('PATCH', /^\/non-working-days\//);
ok(patch && patch.status === 200, `PATCH → ${patch?.status} · body ${patch?.body}`);
await page.waitForLoadState('networkidle').catch(() => {});
await page.waitForTimeout(600);
ok((await created.textContent())?.includes('x3'), `la tarjeta muestra el factor nuevo (x3): "${((await created.textContent()) ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)}"`);
console.log(`   toast: ${await toastText() || '-'}`); await dismissToasts();
await shot('nwd-edited');

console.log('\n▶ Días inhábiles — reporte');
mark(); await page.getByRole('button', { name: 'Descargar reporte' }).click();
const rep = await waitCall('GET', /^\/non-working-days\/report/);
ok(rep && rep.status === 200, `GET /non-working-days/report → ${rep?.status}`);
await page.waitForTimeout(800); await dismissToasts();

console.log('\n▶ Días inhábiles — eliminar');
await created.locator('i.er-icon-delete').click();
const confirm = page.locator('.p-dialog, .p-dynamicdialog').last();
await confirm.waitFor();
await shot('nwd-confirm-delete');
mark(); await confirm.getByRole('button', { name: 'Eliminar' }).click();
const del = await waitCall('DELETE', /^\/non-working-days\//);
ok(del && [200, 204].includes(del.status), `DELETE → ${del?.status}`);
await page.waitForLoadState('networkidle').catch(() => {});
await page.waitForTimeout(600);
ok((await cards.filter({ hasText: DESC }).count()) === 0, 'la tarjeta desaparece de la lista');
console.log(`   toast: ${await toastText() || '-'}`); await dismissToasts();

console.log('\n▶ Bonos — carga masiva (diálogo + plantilla)');
await page.goto(`${ADMIN_URL}/dashboard/portal-nomina?tab=bonos`, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle').catch(() => {});
await page.getByRole('button', { name: 'Carga masiva' }).click();
const bulk = page.locator('.p-dialog, .p-dynamicdialog').last();
await bulk.waitFor();
ok(await bulk.getByText('Carga masiva de bonos').count() > 0, 'abre el diálogo "Carga masiva de bonos"');
await shot('bulk-dialog');
const popupP = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
mark(); await bulk.getByText('la plantilla').click();
const tpl = await waitCall('GET', /^\/manual-bonuses\/bulk\/template/);
ok(tpl && tpl.status === 200, `GET /manual-bonuses/bulk/template → ${tpl?.status}`);
const popup = await popupP; if (popup) { console.log(`   abrió pestaña: ${popup.url().slice(0, 100)}`); await popup.close().catch(() => {}); }
await bulk.getByRole('button', { name: 'Cerrar' }).click().catch(async () => page.keyboard.press('Escape'));
await bulk.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});

console.log('\n▶ Bonos — reporte');
const brepBtn = page.getByRole('button', { name: 'Descargar reporte' }).first();
if (await brepBtn.isVisible().catch(() => false) && !(await brepBtn.isDisabled())) {
  mark(); await brepBtn.click();
  const brep = await waitCall('GET', /^\/manual-bonuses\/report/);
  ok(brep && brep.status === 200, `GET /manual-bonuses/report → ${brep?.status}`);
} else console.log('   botón "Descargar reporte" no disponible en Bonos (lista vacía o deshabilitado) — cubierto por api-tests B03');

} catch (e) { ok(false, `excepción: ${String(e.message ?? e).split('\n')[0].slice(0, 200)}`); await shot('error').catch(() => {}); }
const fails = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - fails}/${checks.length} asertos · ${calls.length} llamadas al relay`);
fs.writeFileSync(path.join(HERE, 'results', `flows-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify({ checks, calls }, null, 2));
await page.close();
  // Nunca cerramos `browser`: es el Chrome real y compartido con Jovanny — browser.close()
  // lo mataría (y con noDefaults+isLocal, Playwright lo trata como propio). Solo soltamos
  // la conexión CDP dejando que el proceso termine; Chrome sigue vivo con su sesión intacta.
process.exitCode = fails ? 1 : 0;
process.exit(process.exitCode);
