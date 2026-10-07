// Contrato del Portal de Nómina: CMS Administrador ↔ adapter-portalnomina (dev).
// Reproduce exactamente las llamadas que hacen los 3 servicios Angular del módulo
// (mismas rutas, params, headers y cuerpos) y valida las formas que el front tipa
// en `interfaces/*.ts`. Usa la sesión capturada del Chrome persistente (.session.json).
//
//   node api-tests.mjs            # todo
//   node api-tests.mjs --only B   # solo un grupo (A auth, B bonos, C pagos, D asistencias,
//                                 #   E servicios especiales, F días inhábiles, G operadores)
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { loadSession, RELAY_URL as DEFAULT_RELAY, HERE, decodeJwt } from './lib.mjs';
const relayArg = process.argv.indexOf('--relay');
const RELAY_URL = relayArg > -1 ? process.argv[relayArg + 1] : DEFAULT_RELAY;
// El adapter local corre con JWT_BYPASS=true: las pruebas de 401 solo aplican al relay desplegado.
const RELAY_ENFORCES_AUTH = /desarrollobambu\.com/.test(RELAY_URL);

const BCB_API = process.env.NOMINA_BCB_API ?? 'https://kpbelqbjle.execute-api.us-west-2.amazonaws.com/develop';
const only = (process.argv.find((a) => a.startsWith('--only')) ?? '').split(/[= ]/)[1] ?? process.argv[process.argv.indexOf('--only') + 1];
const ONLY = process.argv.includes('--only') ? String(only).toUpperCase() : null;

const session = loadSession();
if (!session?.appToken) { console.error('No hay sesión: corre `node token.mjs` con el admin logueado.'); process.exit(2); }
const TOKEN = session.appToken;
const BCB_TOKEN = session.accessToken;

/* ─── mini runner ─── */
const results = [];
let current = null;
async function t(id, name, fn) {
  if (ONLY && !id.startsWith(ONLY)) return;
  current = { id, name, checks: [], status: 'PASS', notes: [] };
  try { await fn(current); } catch (e) { current.status = 'FAIL'; current.checks.push({ ok: false, msg: `excepción: ${e?.message ?? e}` }); }
  if (current.checks.some((c) => !c.ok)) current.status = 'FAIL';
  results.push(current);
  const icon = current.status === 'PASS' ? '✅' : current.status === 'SKIP' ? '⏭️ ' : '❌';
  console.log(`${icon} ${id} ${name}`);
  for (const c of current.checks) if (!c.ok) console.log(`     ✗ ${c.msg}`);
  for (const n of current.notes) console.log(`     · ${n}`);
}
const ok = (cond, msg) => { current.checks.push({ ok: !!cond, msg }); return !!cond; };
const note = (msg) => current.notes.push(msg);
const skip = (why) => { current.status = 'SKIP'; note(`omitido: ${why}`); };

/** Valida forma: spec = { campo: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'string|null' | ... } */
function shape(obj, spec, label) {
  if (!obj || typeof obj !== 'object') return ok(false, `${label}: no es objeto`);
  for (const [k, types] of Object.entries(spec)) {
    const v = obj[k];
    const actual = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
    const allowed = types.split('|');
    const present = k in obj;
    if (!present) { ok(false, `${label}.${k}: falta (esperado ${types})`); continue; }
    if (!allowed.includes(actual)) ok(false, `${label}.${k}: es ${actual}, esperado ${types} (valor ${JSON.stringify(v)?.slice(0, 60)})`);
  }
}
const PAGINATION_SPEC = { isFirstPage: 'boolean', isLastPage: 'boolean', currentPage: 'number', previousPage: 'number|null', nextPage: 'number|null', pageCount: 'number', totalCount: 'number' };
const SERVICE_REF_SPEC = { id: 'string', key: 'string', number: 'string', shortName: 'string' };
const OPERATOR_REF_SPEC = { id: 'string', key: 'string', name: 'string' };

/* ─── http ─── */
async function api(method, route, { params, body, form, token = TOKEN, raw = false } = {}) {
  const url = new URL(route.startsWith('http') ? route : RELAY_URL + route);
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const headers = { 'X-Lang': 'es' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const started = Date.now();
  const res = await fetch(url, { method, headers, body: form ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  const ms = Date.now() - started;
  const ct = res.headers.get('content-type') ?? '';
  let data;
  if (raw) data = Buffer.from(await res.arrayBuffer());
  else if (ct.includes('json')) data = await res.json().catch(() => null);
  else data = await res.text().catch(() => '');
  return { status: res.status, data, ct, ms, url: url.toString(), headers: res.headers };
}
const fmt = (d) => d.toISOString().slice(0, 10);
const today = new Date();
const daysAgo = (n) => { const d = new Date(today); d.setUTCDate(d.getUTCDate() - n); return fmt(d); };
const RANGE = { dateFrom: daysAgo(60), dateTo: fmt(today) };
const listRes = (r) => (Array.isArray(r.data?.data) ? r.data.data : Array.isArray(r.data) ? r.data : []);

/** Descarga un reporte como lo haría el navegador: sin token, y valida que sea un xlsx real. */
async function checkReportLink(r, resource) {
  if (!ok(r.status === 200, `HTTP ${r.status} (${r.ms} ms) ${r.status !== 200 ? JSON.stringify(r.data)?.slice(0, 200) : ''}`)) return;
  shape(r.data, { url: 'string', reportId: 'string' }, 'reporte');
  const url = r.data?.url ?? '';
  ok(url.startsWith(`${RELAY_URL}/reports/${resource}/`), `url del reporte cuelga del relay público (${url.slice(0, 90)}…)`);
  const dl = await api('GET', url, { token: null, raw: true });
  ok(dl.status === 200, `descarga sin token → HTTP ${dl.status} (${dl.ms} ms)`);
  const isXlsx = dl.data?.length > 4 && dl.data[0] === 0x50 && dl.data[1] === 0x4b;
  ok(isXlsx, `archivo es xlsx (zip) · ${dl.data?.length ?? 0} bytes · content-type ${dl.ct}`);
  return dl;
}

/* ═══════════════════════════ A · Sesión y seguridad ═══════════════════════════ */
await t('A01', 'token de aplicación (Cognito) vigente', () => {
  const p = decodeJwt(TOKEN);
  ok(p, 'appToken decodificable');
  ok(String(p?.iss ?? '').includes('cognito'), `iss = ${p?.iss}`);
  ok((p?.exp ?? 0) * 1000 > Date.now(), `exp = ${p?.exp ? new Date(p.exp * 1000).toLocaleString() : '?'}`);
  note(`usuario ${p?.username ?? p?.['cognito:username'] ?? '?'} · token_use ${p?.token_use}`);
});
await t('A02', 'GET /health público', async () => {
  const r = await api('GET', '/health', { token: null });
  ok(r.status === 200 && r.data?.status === 'UP', `HTTP ${r.status} ${JSON.stringify(r.data)}`);
});
await t('A03', 'sin token → 401 (no 403 ni 500)', async () => {
  if (!RELAY_ENFORCES_AUTH) return skip('relay local con JWT_BYPASS');
  const r = await api('GET', '/manual-bonuses', { token: null, params: { page: 1, limit: 10 } });
  ok(r.status === 401, `HTTP ${r.status} ${JSON.stringify(r.data)?.slice(0, 120)}`);
});
await t('A04', 'token del CMS aceptado por el adapter (llave/multi-emisor de la task)', async () => {
  const r = await api('GET', '/manual-bonuses', { params: { page: 1, limit: 1 } });
  ok(r.status === 200, `HTTP ${r.status} (${r.ms} ms) ${r.status !== 200 ? JSON.stringify(r.data)?.slice(0, 200) : ''}`);
});
await t('A05', 'token de BCB (idToken) rechazado por el adapter — justifica la rama del authInterceptor', async () => {
  if (!RELAY_ENFORCES_AUTH) return skip('relay local con JWT_BYPASS');
  if (!BCB_TOKEN) return skip('sin er-tkn en la sesión');
  const r = await api('GET', '/manual-bonuses', { token: BCB_TOKEN, params: { page: 1, limit: 1 } });
  ok(r.status === 401 || r.status === 403, `HTTP ${r.status}`);
  note(r.status === 200 ? 'el adapter acepta también el idToken: la rama del interceptor no sería necesaria, pero no hace daño' : 'con el token de BCB el módulo daría 401 → la rama del interceptor es obligatoria');
});

/* ═══════════════════════════ G · Operadores (insumo de los altas) ═══════════════════════════ */
const ctx = { operator: null, bcbOperator: null, serviceId: null, routeId: null };
await t('G01', 'GET /operators del relay — snapshot del catálogo de BCB en el satélite', async () => {
  const r = await api('GET', '/operators', { params: { page: 1, limit: 5 } });
  ok(r.status === 200, `HTTP ${r.status} (${r.ms} ms)`);
  const rows = listRes(r);
  ok(rows.length > 0, `snapshot con operadores (${r.data?.pagination?.totalCount ?? rows.length})`);
  if (rows[0]) { shape(rows[0], OPERATOR_REF_SPEC, 'operator'); ctx.operator = rows[0]; note(`operador de prueba: ${rows[0].key} · ${rows[0].name} · id ${rows[0].id}`); }
});
await t('G02', 'catálogo de operadores de BCB (el que usa el buscador del admin) y cruce con el satélite', async () => {
  if (!BCB_TOKEN) return skip('sin er-tkn en la sesión');
  const r = await api('GET', `${BCB_API}/core-administration/operators`, { token: BCB_TOKEN, params: { page: 1, limit: 20 } });
  ok(r.status === 200, `BCB HTTP ${r.status} (${r.ms} ms) ${r.status !== 200 ? JSON.stringify(r.data)?.slice(0, 160) : ''}`);
  const rows = listRes(r);
  if (!rows.length) return note('BCB no devolvió operadores');
  const op = rows.find((o) => o.id === ctx.operator?.id) ?? rows[0];
  ctx.bcbOperator = op;
  note(`operador BCB: ${op.key ?? op.employeeKey ?? '?'} · ${op.name ?? op.fullName ?? '?'} · id ${op.id}`);
  const one = await api('GET', `/operators/${op.id}`);
  ok(one.status === 200, `el satélite conoce ese id de BCB → HTTP ${one.status}`);
  if (!ctx.operator && one.status === 200) ctx.operator = one.data;
});
await t('G03', 'catálogos de servicios y rutas de BCB (filtros del módulo)', async () => {
  if (!BCB_TOKEN) return skip('sin er-tkn en la sesión');
  const s = await api('GET', `${BCB_API}/core-administration/services/find`, { token: BCB_TOKEN, params: { page: 1, limit: 5 } });
  const rt = await api('GET', `${BCB_API}/core-administration/routes/find`, { token: BCB_TOKEN, params: { page: 1, limit: 5 } });
  ok(s.status === 200, `services/find HTTP ${s.status}`); ok(rt.status === 200, `routes/find HTTP ${rt.status}`);
  ctx.serviceId = listRes(s)[0]?.id ?? null; ctx.routeId = listRes(rt)[0]?.id ?? null;
  note(`serviceId ${ctx.serviceId} · routeId ${ctx.routeId}`);
});

/* ═══════════════════════════ B · Bonos manuales ═══════════════════════════ */
const created = { bonus: null, bulkIds: [], special: null, nwd: null };
const BONUS_SPEC = { id: 'string', operatorId: 'string', operatorKey: 'string', operator: 'object', bonusType: 'string', amount: 'string', periodStart: 'string', periodEnd: 'string', comments: 'string|null', status: 'string', sentToOracleAt: 'string|null', createdAt: 'string', updatedAt: 'string' };
await t('B01', 'listado GET /manual-bonuses (page/limit como el tab Bonos)', async () => {
  const r = await api('GET', '/manual-bonuses', { params: { page: 1, limit: 10 } });
  ok(r.status === 200, `HTTP ${r.status} (${r.ms} ms)`);
  shape(r.data, { data: 'array', pagination: 'object' }, 'respuesta');
  if (r.data?.pagination) { shape(r.data.pagination, PAGINATION_SPEC, 'pagination'); note(`totalCount ${r.data.pagination.totalCount} · limit ${r.data.pagination.limit ?? '(no viene)'}`); }
  const row = r.data?.data?.[0];
  if (row) { shape(row, BONUS_SPEC, 'bono[0]'); shape(row.operator, OPERATOR_REF_SPEC, 'bono[0].operator'); ok(/^\d+\.\d{2}$/.test(row.amount), `amount string con 2 decimales (${row.amount})`); }
  else note('sin bonos en dev: las validaciones de fila se cubren con B05');
});
await t('B02', 'filtros del tab Bonos: status, bonusType, período, search, serviceId', async () => {
  const cases = [
    { status: 'PENDING' }, { status: 'PROCESSED' }, { bonusType: 'PRODUCTIVITY' },
    { periodStart: RANGE.dateFrom, periodEnd: RANGE.dateTo }, { search: 'a' },
    ...(ctx.serviceId ? [{ serviceId: ctx.serviceId }] : []),
  ];
  for (const f of cases) {
    const r = await api('GET', '/manual-bonuses', { params: { page: 1, limit: 10, ...f } });
    ok(r.status === 200, `${JSON.stringify(f)} → HTTP ${r.status} ${r.status !== 200 ? JSON.stringify(r.data)?.slice(0, 120) : ''}`);
    const rows = listRes(r);
    if (f.status) ok(rows.every((x) => x.status === f.status), `filtro status=${f.status} respetado (${rows.length} filas)`);
    if (f.bonusType) ok(rows.every((x) => x.bonusType === f.bonusType), `filtro bonusType respetado (${rows.length} filas)`);
  }
});
await t('B05', 'alta POST /manual-bonuses (relay expone el alta aunque el CMS solo lo use en carga masiva)', async () => {
  if (!ctx.operator) return skip('sin operador');
  const body = { operatorId: ctx.operator.id, bonusType: 'OTHER', amount: '123.45', periodStart: daysAgo(3), periodEnd: daysAgo(1), comments: `e2e nomina-dev ${new Date().toISOString()}` };
  const r = await api('POST', '/manual-bonuses', { body });
  ok([200, 201].includes(r.status), `HTTP ${r.status} (${r.ms} ms) ${![200, 201].includes(r.status) ? JSON.stringify(r.data)?.slice(0, 200) : ''}`);
  if (r.data?.id) { created.bonus = r.data; shape(r.data, BONUS_SPEC, 'bono'); ok(r.data.status === 'PENDING', `nace PENDING (${r.data.status})`); ok(r.data.amount === '123.45', `amount eco (${r.data.amount})`); }
});
await t('B06', 'detalle GET /manual-bonuses/{id}', async () => {
  if (!created.bonus) return skip('sin bono creado');
  const r = await api('GET', `/manual-bonuses/${created.bonus.id}`);
  ok(r.status === 200, `HTTP ${r.status}`); ok(r.data?.id === created.bonus.id, 'mismo id');
});
await t('B07', 'edición PATCH /manual-bonuses/{id} (amount, comments)', async () => {
  if (!created.bonus) return skip('sin bono creado');
  const r = await api('PATCH', `/manual-bonuses/${created.bonus.id}`, { body: { amount: '200.00', comments: 'editado e2e' } });
  ok(r.status === 200, `HTTP ${r.status} ${r.status !== 200 ? JSON.stringify(r.data)?.slice(0, 160) : ''}`);
  ok(Number(r.data?.amount) === 200, `amount actualizado (${r.data?.amount} → ${typeof r.data?.amount})`);
});
await t('B03', 'reporte GET /manual-bonuses/report → {url, reportId} descargable sin token', async () => {
  await checkReportLink(await api('GET', '/manual-bonuses/report', { params: { page: 1, limit: 10, status: 'PENDING' } }), 'manual-bonuses');
});
let templateHeaders = null;
await t('B04', 'plantilla GET /manual-bonuses/bulk/template → xlsx con encabezados', async () => {
  const dl = await checkReportLink(await api('GET', '/manual-bonuses/bulk/template'), 'manual-bonuses');
  if (!dl) return;
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(dl.data);
  const ws = wb.worksheets[0];
  templateHeaders = (ws.getRow(1).values ?? []).slice(1).map((v) => String(v ?? '').trim());
  ok(templateHeaders.length > 0, `encabezados: ${templateHeaders.join(' | ')}`);
  note(`hoja "${ws.name}" · ${ws.rowCount} filas`);
  fs.writeFileSync(path.join(HERE, 'results', 'plantilla-bonos.xlsx'), dl.data);
});
await t('B09', 'carga masiva POST /manual-bonuses/bulk (multipart) — 1 fila válida + 1 inválida', async () => {
  if (!templateHeaders || !ctx.operator) return skip('sin plantilla u operador');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(fs.readFileSync(path.join(HERE, 'results', 'plantilla-bonos.xlsx')));
  const ws = wb.worksheets[0];
  const idx = (re) => templateHeaders.findIndex((h) => re.test(h.toLowerCase())) + 1;
  // Plantilla real (B04): "Clave de operador" | "Nombre de operador" | "Monto" | "Período de aplicación" ("YYYY-MM-DD a YYYY-MM-DD")
  const cKey = idx(/^clave|key|hcm/), cName = idx(/nombre|name/), cAmount = idx(/monto|amount|importe/), cPeriod = idx(/per[ií]odo|period/), cComments = idx(/coment|observ|comment/);
  note(`mapa columnas → clave:${cKey} nombre:${cName} monto:${cAmount} período:${cPeriod} comentarios:${cComments} · encabezados: ${templateHeaders.join(' | ')}`);
  if (!cKey || !cAmount) return skip('no pude mapear clave/monto en la plantilla; probar a mano');
  const fill = (row, key, amount, name) => { row.getCell(cKey).value = key; if (cName) row.getCell(cName).value = name; row.getCell(cAmount).value = amount; if (cPeriod) row.getCell(cPeriod).value = `${daysAgo(9)} a ${daysAgo(8)}`; if (cComments) row.getCell(cComments).value = 'e2e bulk'; row.commit(); };
  // limpia filas de ejemplo que traiga la plantilla
  for (let i = ws.rowCount; i >= 2; i--) ws.spliceRows(i, 1);
  fill(ws.getRow(2), ctx.operator.key, 55.5, ctx.operator.name);
  fill(ws.getRow(3), 'NO-EXISTE-E2E', 10, 'Operador Inexistente');
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  fs.writeFileSync(path.join(HERE, 'results', 'carga-bonos-e2e.xlsx'), buf);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'carga-bonos-e2e.xlsx');
  form.append('bonusType', 'OTHER'); form.append('periodStart', daysAgo(9)); form.append('periodEnd', daysAgo(8));
  const r = await api('POST', '/manual-bonuses/bulk', { form });
  ok([200, 201].includes(r.status), `HTTP ${r.status} (${r.ms} ms) ${JSON.stringify(r.data)?.slice(0, 300)}`);
  if (r.data && typeof r.data === 'object') {
    shape(r.data, { total: 'number', created: 'number', errors: 'array' }, 'resultado');
    // La carga es TODO O NADA desde el fix de ADM-NOM-01: el archivo trae una fila buena y una con
    // clave inexistente, así que no debe crearse ninguno de los dos.
    ok(r.data.created === 0, `created = 0 porque el archivo trae una fila mala (${r.data.created})`);
    ok(r.data.errors?.length >= 1, `errors ≥ 1 por la clave inexistente (${r.data.errors?.length})`);
    if (r.data.errors?.[0]) shape(r.data.errors[0], { row: 'number', column: 'string|null', message: 'string' }, 'errors[0]');
    // No hay nada que limpiar: si algo quedó en la base, el todo-o-nada se rompió.
    const l = await api('GET', '/manual-bonuses', { params: { page: 1, limit: 50, operatorId: ctx.operator.id, periodStart: daysAgo(9), periodEnd: daysAgo(8), status: 'PENDING' } });
    created.bulkIds = listRes(l).filter((b) => b.comments?.startsWith('Carga masiva carga-bonos-e2e')).map((b) => b.id);
    ok(created.bulkIds.length === 0, `la carga rechazada no dejó bonos en la base (${created.bulkIds.length})`);
  }
});

// El reverso del anterior: el mismo archivo SIN la fila mala sí debe entrar completo. Hace falta
// para distinguir "el todo o nada funciona" de "la carga masiva se rompió del todo".
await t('B09b', 'carga masiva con el archivo limpio: entra completo', async () => {
  if (!templateHeaders || !ctx.operator) return skip('sin plantilla u operador');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(fs.readFileSync(path.join(HERE, 'results', 'plantilla-bonos.xlsx')));
  const ws = wb.worksheets[0];
  const idx = (re) => templateHeaders.findIndex((h) => re.test(h.toLowerCase())) + 1;
  const cKey = idx(/^clave|key|hcm/), cName = idx(/nombre|name/), cAmount = idx(/monto|amount|importe/), cPeriod = idx(/per[ií]odo|period/);
  if (!cKey || !cAmount) return skip('no pude mapear clave/monto en la plantilla');
  for (let i = ws.rowCount; i >= 2; i--) ws.spliceRows(i, 1);
  const row = ws.getRow(2);
  row.getCell(cKey).value = ctx.operator.key;
  if (cName) row.getCell(cName).value = ctx.operator.name;
  row.getCell(cAmount).value = 55.5;
  if (cPeriod) row.getCell(cPeriod).value = `${daysAgo(9)} a ${daysAgo(8)}`;
  row.commit();

  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'carga-bonos-e2e-ok.xlsx');
  form.append('bonusType', 'OTHER'); form.append('periodStart', daysAgo(9)); form.append('periodEnd', daysAgo(8));
  const r = await api('POST', '/manual-bonuses/bulk', { form });
  ok([200, 201].includes(r.status), `HTTP ${r.status} (${r.ms} ms)`);
  ok(r.data?.created === r.data?.total, `created = total (${r.data?.created}/${r.data?.total})`);
  ok(!r.data?.errors?.length, `sin errores (${r.data?.errors?.length ?? 0})`);
  // localizar lo creado para que B08 lo limpie
  const l = await api('GET', '/manual-bonuses', { params: { page: 1, limit: 50, operatorId: ctx.operator.id, periodStart: daysAgo(9), periodEnd: daysAgo(8), status: 'PENDING' } });
  created.bulkIds = listRes(l).filter((b) => b.comments?.startsWith('Carga masiva carga-bonos-e2e')).map((b) => b.id);
  note(`bonos creados por la carga localizados: ${created.bulkIds.length}`);
});
await t('B08', 'baja DELETE /manual-bonuses/{id} y 404 posterior (limpieza)', async () => {
  const ids = [created.bonus?.id, ...created.bulkIds].filter(Boolean);
  if (!ids.length) return skip('nada que borrar');
  for (const id of ids) {
    const r = await api('DELETE', `/manual-bonuses/${id}`);
    ok([200, 204].includes(r.status), `DELETE ${id} → HTTP ${r.status}`);
    const g = await api('GET', `/manual-bonuses/${id}`);
    ok(g.status === 404, `GET tras borrar → HTTP ${g.status}`);
  }
});

/* ═══════════════════════════ C · Pagos consolidados ═══════════════════════════ */
const PAYMENT_SPEC = { id: 'string', origin: 'string', sourceId: 'string', operator: 'object', concept: 'string', conceptLabel: 'string', reference: 'string', date: 'string', periodStart: 'string', periodEnd: 'string', amount: 'number', nonWorkingDay: 'object|null', payableAmount: 'number', status: 'string', sentToOracleAt: 'string|null', oracleElementEntryId: 'string|null', service: 'object|null' };
await t('C01', 'listado GET /payroll-payments con dateFrom/dateTo (tab Pagos)', async () => {
  const r = await api('GET', '/payroll-payments', { params: { ...RANGE, page: 1, limit: 10 } });
  ok(r.status === 200, `HTTP ${r.status} (${r.ms} ms) ${r.status !== 200 ? JSON.stringify(r.data)?.slice(0, 200) : ''}`);
  shape(r.data, { data: 'array', pagination: 'object' }, 'respuesta');
  if (r.data?.pagination) shape(r.data.pagination, PAGINATION_SPEC, 'pagination');
  const rows = r.data?.data ?? [];
  note(`${r.data?.pagination?.totalCount ?? rows.length} pagos en ${RANGE.dateFrom}..${RANGE.dateTo} · orígenes: ${[...new Set(rows.map((x) => x.origin))].join(',') || '-'}`);
  if (rows[0]) {
    shape(rows[0], PAYMENT_SPEC, 'pago[0]'); shape(rows[0].operator, OPERATOR_REF_SPEC, 'pago[0].operator');
    ok(rows.every((p) => p.id === `${p.origin}:${p.sourceId}`), 'id compuesto ORIGIN:sourceId');
    ok(rows.every((p) => Math.abs(p.payableAmount - p.amount * (p.nonWorkingDay?.paymentFactor ?? 1)) < 0.01), 'payableAmount = amount × factor');
    if (rows[0].service) shape(rows[0].service, SERVICE_REF_SPEC, 'pago[0].service');
  }
});
await t('C02', 'filtro por origen (lo que el CU02 llama Tipo de pago) y por status', async () => {
  for (const origin of ['MANUAL_BONUS', 'TRAVEL_CARD', 'SPECIAL_SERVICE']) {
    const r = await api('GET', '/payroll-payments', { params: { ...RANGE, page: 1, limit: 20, origin } });
    ok(r.status === 200, `origin=${origin} → HTTP ${r.status}`);
    const rows = listRes(r);
    ok(rows.every((p) => p.origin === origin), `todas las filas son ${origin} (${rows.length})`);
  }
  for (const status of ['PENDING', 'PROCESSED']) {
    const r = await api('GET', '/payroll-payments', { params: { ...RANGE, page: 1, limit: 20, status } });
    ok(r.status === 200 && listRes(r).every((p) => p.status === status), `status=${status} → HTTP ${r.status}, filas coherentes`);
  }
});
await t('C03', 'filtros search y serviceId; sin fechas el satélite las trata como opcionales', async () => {
  const s = await api('GET', '/payroll-payments', { params: { ...RANGE, page: 1, limit: 10, search: 'a' } });
  ok(s.status === 200, `search → HTTP ${s.status}`);
  if (ctx.serviceId) { const sv = await api('GET', '/payroll-payments', { params: { ...RANGE, page: 1, limit: 10, serviceId: ctx.serviceId } }); ok(sv.status === 200, `serviceId → HTTP ${sv.status}`); }
  // El admin siempre manda un rango (ver payments.ts _buildDateRange), pero el DTO del satélite
  // (ListPayrollPaymentsDto) declara dateFrom/dateTo @IsOptional: sin ellos no filtra por fecha.
  const nf = await api('GET', '/payroll-payments', { params: { page: 1, limit: 10 } });
  ok(nf.status === 200, `sin dateFrom/dateTo → HTTP ${nf.status} (el satélite las trata como opcionales, no filtra)`);
});
await t('C04', 'reporte GET /payroll-payments/report → descargable', async () => {
  await checkReportLink(await api('GET', '/payroll-payments/report', { params: { ...RANGE, page: 1, limit: 10 } }), 'payroll-payments');
});

/* ═══════════════════════════ D · Asistencias por operador ═══════════════════════════ */
const ATT_SPEC = { operatorId: 'string', operatorKey: 'string', operatorName: 'string', company: 'string|null', service: 'object|null', collectedTravelCards: 'number', totalTravelCards: 'number', absences: 'number', lastDispatchedAt: 'string|null' };
const CARD_SPEC = { id: 'string', folio: 'string', tripId: 'string', status: 'string', amount: 'number', dispatchedAt: 'string', cardCreatedAt: 'string|null', confirmedAt: 'string|null', collectedAt: 'string|null', service: 'object|null', route: 'object|null', sentToOracleAt: 'string|null' };
let attRow = null;
await t('D01', 'listado GET /travel-card-attendance/by-operator (agregado en servidor)', async () => {
  const r = await api('GET', '/travel-card-attendance/by-operator', { params: { ...RANGE, page: 1, limit: 10 } });
  ok(r.status === 200, `HTTP ${r.status} (${r.ms} ms) ${r.status !== 200 ? JSON.stringify(r.data)?.slice(0, 200) : ''}`);
  shape(r.data, { data: 'array', pagination: 'object' }, 'respuesta');
  if (r.data?.pagination) shape(r.data.pagination, PAGINATION_SPEC, 'pagination');
  const rows = r.data?.data ?? [];
  note(`${r.data?.pagination?.totalCount ?? rows.length} operadores con tarjetas en el rango`);
  if (rows[0]) {
    attRow = rows.find((x) => x.totalTravelCards > 0) ?? rows[0];
    shape(rows[0], ATT_SPEC, 'fila[0]'); if (rows[0].service) shape(rows[0].service, SERVICE_REF_SPEC, 'fila[0].service');
    ok(rows.every((x) => x.collectedTravelCards <= x.totalTravelCards), 'recaudadas ≤ total');
    ok(rows.some((x) => x.company), `columna Empresa viene informada en ${rows.filter((x) => x.company).length}/${rows.length}`);
  }
});
await t('D02', 'sin dateFrom/dateTo → 400 (contrato: obligatorias)', async () => {
  const r = await api('GET', '/travel-card-attendance/by-operator', { params: { page: 1, limit: 10 } });
  ok(r.status === 400, `HTTP ${r.status} ${r.status !== 400 ? JSON.stringify(r.data)?.slice(0, 120) : ''}`);
});
await t('D03', 'filtros: status (enum en español), search, serviceId, routeId', async () => {
  for (const status of ['RECAUDADA', 'CONFIRMADA', 'ABIERTA', 'CANCELADA']) {
    const r = await api('GET', '/travel-card-attendance/by-operator', { params: { ...RANGE, page: 1, limit: 5, status } });
    ok(r.status === 200, `status=${status} → HTTP ${r.status}`);
  }
  const s = await api('GET', '/travel-card-attendance/by-operator', { params: { ...RANGE, page: 1, limit: 5, search: attRow?.operatorKey ?? 'a' } });
  ok(s.status === 200, `search=${attRow?.operatorKey ?? 'a'} → HTTP ${s.status}`);
  if (attRow) ok(listRes(s).some((x) => x.operatorId === attRow.operatorId), 'el buscador por clave encuentra al operador');
  if (ctx.serviceId) { const sv = await api('GET', '/travel-card-attendance/by-operator', { params: { ...RANGE, page: 1, limit: 5, serviceId: ctx.serviceId } }); ok(sv.status === 200, `serviceId → HTTP ${sv.status}`); }
  if (ctx.routeId) { const rt = await api('GET', '/travel-card-attendance/by-operator', { params: { ...RANGE, page: 1, limit: 5, routeId: ctx.routeId } }); ok(rt.status === 200, `routeId → HTTP ${rt.status}`); }
});
await t('D04', 'detalle GET /travel-card-attendance/operator/{id} — tarjetas con costo y 3 fechas (CU06)', async () => {
  const opId = attRow?.operatorId ?? ctx.operator?.id;
  if (!opId) return skip('sin operador');
  const r = await api('GET', `/travel-card-attendance/operator/${opId}`, { params: RANGE });
  ok(r.status === 200, `HTTP ${r.status} (${r.ms} ms) ${r.status !== 200 ? JSON.stringify(r.data)?.slice(0, 200) : ''}`);
  shape(r.data, { ...ATT_SPEC, dateFrom: 'string', dateTo: 'string', cards: 'array' }, 'detalle');
  const cards = r.data?.cards ?? [];
  note(`${cards.length} tarjetas · estatus: ${[...new Set(cards.map((c) => c.status))].join(',') || '-'}`);
  if (cards[0]) {
    shape(cards[0], CARD_SPEC, 'cards[0]');
    ok(cards.every((c) => ['RECAUDADA', 'CONFIRMADA', 'ABIERTA', 'CANCELADA'].includes(c.status)), 'estatus dentro del enum en español');
    ok(cards.length === r.data.totalTravelCards, `cards.length (${cards.length}) = totalTravelCards (${r.data.totalTravelCards})`);
  }
});
await t('D05', 'reporte GET /travel-card-attendance/report → descargable', async () => {
  await checkReportLink(await api('GET', '/travel-card-attendance/report', { params: { ...RANGE, page: 1, limit: 10 } }), 'travel-card-attendance');
});

/* ═══════════════════════════ E · Servicios especiales (CU07) ═══════════════════════════ */
const SS_SPEC = { id: 'string', operatorId: 'string', operatorKey: 'string', operator: 'object', serviceType: 'string', serviceStartDate: 'string', serviceEndDate: 'string', workedDays: 'number|string', fixedAmount: 'number|string|null', status: 'string', sentToOracleAt: 'string|null', createdAt: 'string', updatedAt: 'string' };
await t('E01', 'listado GET /special-services (detalle del operador lo pide con operatorId)', async () => {
  const r = await api('GET', '/special-services', { params: { page: 1, limit: 10, ...(ctx.operator ? { operatorId: ctx.operator.id } : {}) } });
  ok(r.status === 200, `HTTP ${r.status} (${r.ms} ms)`);
  const paginated = Array.isArray(r.data?.data);
  note(paginated ? `paginado · totalCount ${r.data.pagination?.totalCount}` : `arreglo plano de ${Array.isArray(r.data) ? r.data.length : '?'} (el front acepta ambas formas)`);
  const row = listRes(r)[0]; if (row) shape(row, SS_SPEC, 'ss[0]');
});
await t('E02', 'alta POST /special-services con rango (el servidor calcula workedDays y fixedAmount)', async () => {
  if (!ctx.operator) return skip('sin operador');
  const body = { operatorId: ctx.operator.id, serviceStartDate: daysAgo(5), serviceEndDate: daysAgo(3), serviceType: 'TOURISM' };
  const r = await api('POST', '/special-services', { body });
  ok([200, 201].includes(r.status), `HTTP ${r.status} (${r.ms} ms) ${![200, 201].includes(r.status) ? JSON.stringify(r.data)?.slice(0, 200) : ''}`);
  if (r.data?.id) {
    created.special = r.data; shape(r.data, SS_SPEC, 'ss'); shape(r.data.operator, OPERATOR_REF_SPEC, 'ss.operator');
    ok(Number(r.data.workedDays) === 3, `workedDays inclusive = 3 (${r.data.workedDays} → ${typeof r.data.workedDays})`);
    ok(r.data.status === 'PENDING', `nace PENDING (${r.data.status})`);
    note(`fixedAmount ${r.data.fixedAmount} (null si el operador no tiene tarifa)`);
  }
});
await t('E03', 'alta con el contrato viejo (serviceDate/workedDays/fixedAmount) → 400', async () => {
  if (!ctx.operator) return skip('sin operador');
  const r = await api('POST', '/special-services', { body: { operatorId: ctx.operator.id, serviceDate: daysAgo(2), workedDays: 1, fixedAmount: 100, serviceType: 'OTHER' } });
  ok(r.status === 400, `HTTP ${r.status} ${JSON.stringify(r.data)?.slice(0, 160)}`);
  if (r.data?.id) await api('DELETE', `/special-services/${r.data.id}`);
});
await t('E04', 'detalle GET /special-services/{id}', async () => {
  if (!created.special) return skip('sin servicio creado');
  const r = await api('GET', `/special-services/${created.special.id}`);
  ok(r.status === 200 && r.data?.id === created.special.id, `HTTP ${r.status}`);
});
await t('E05', 'edición PATCH /special-services/{id} (extiende el rango → recalcula días)', async () => {
  if (!created.special) return skip('sin servicio creado');
  const r = await api('PATCH', `/special-services/${created.special.id}`, { body: { serviceEndDate: daysAgo(1), serviceType: 'FREIGHT' } });
  ok(r.status === 200, `HTTP ${r.status} ${r.status !== 200 ? JSON.stringify(r.data)?.slice(0, 160) : ''}`);
  ok(Number(r.data?.workedDays) === 5, `workedDays recalculado = 5 (${r.data?.workedDays} → ${typeof r.data?.workedDays})`);
  ok(r.data?.serviceType === 'FREIGHT', `serviceType actualizado (${r.data?.serviceType})`);
});
await t('E06', 'baja DELETE /special-services/{id} y 404 posterior', async () => {
  if (!created.special) return skip('sin servicio creado');
  const r = await api('DELETE', `/special-services/${created.special.id}`);
  ok([200, 204].includes(r.status), `HTTP ${r.status}`);
  const g = await api('GET', `/special-services/${created.special.id}`);
  ok(g.status === 404, `GET tras borrar → HTTP ${g.status}`);
});
await t('E07', '(informativo) GET /special-services/report — método muerto en el admin', async () => {
  const r = await api('GET', '/special-services/report', { params: { page: 1, limit: 10 } });
  note(`HTTP ${r.status}: ni el relay ni el satélite lo exponen; en el admin nadie llama downloadSpecialServicesReport`);
  ok(r.status !== 500, 'no revienta con 500');
});

/* ═══════════════════════════ F · Días inhábiles ═══════════════════════════ */
// paymentFactor: Prisma Decimal(6,4) → el satélite lo serializa como string ('2'); el admin lo coerciona con Number().
const NWD_SPEC = { id: 'string', date: 'string', paymentFactor: 'number|string', description: 'string', createdAt: 'string', updatedAt: 'string' };
const NWD_DATE = '2031-12-24';
await t('F01', 'listado GET /non-working-days con page/limit/dateFrom/dateTo', async () => {
  const r = await api('GET', '/non-working-days', { params: { page: 1, limit: 10, dateFrom: `${today.getUTCFullYear()}-01-01`, dateTo: `${today.getUTCFullYear()}-12-31` } });
  ok(r.status === 200, `HTTP ${r.status} (${r.ms} ms)`);
  shape(r.data, { data: 'array', pagination: 'object' }, 'respuesta');
  if (r.data?.pagination) shape(r.data.pagination, PAGINATION_SPEC, 'pagination');
  const row = r.data?.data?.[0]; if (row) shape(row, NWD_SPEC, 'dia[0]');
  note(`${r.data?.pagination?.totalCount ?? 0} días inhábiles en ${today.getUTCFullYear()}`);
});
await t('F02', 'alta POST /non-working-days', async () => {
  // por si quedó de una corrida anterior
  const prev = await api('GET', '/non-working-days', { params: { page: 1, limit: 5, dateFrom: NWD_DATE, dateTo: NWD_DATE } });
  for (const d of listRes(prev)) await api('DELETE', `/non-working-days/${d.id}`);
  const r = await api('POST', '/non-working-days', { body: { date: NWD_DATE, paymentFactor: 2, description: 'e2e nomina-dev' } });
  ok([200, 201].includes(r.status), `HTTP ${r.status} (${r.ms} ms) ${![200, 201].includes(r.status) ? JSON.stringify(r.data)?.slice(0, 200) : ''}`);
  if (r.data?.id) { created.nwd = r.data; shape(r.data, NWD_SPEC, 'dia'); ok(r.data.date.startsWith(NWD_DATE), `fecha eco (${r.data.date})`); }
});
await t('F03', 'duplicado mismo día → 4xx (no 500)', async () => {
  if (!created.nwd) return skip('sin día creado');
  const r = await api('POST', '/non-working-days', { body: { date: NWD_DATE, paymentFactor: 2, description: 'dup' } });
  ok(r.status >= 400 && r.status < 500, `HTTP ${r.status} ${JSON.stringify(r.data)?.slice(0, 120)}`);
  if (r.data?.id && r.data.id !== created.nwd.id) await api('DELETE', `/non-working-days/${r.data.id}`);
});
await t('F04', 'detalle y edición PATCH /non-working-days/{id} (factor, descripción; la fecha no se edita)', async () => {
  if (!created.nwd) return skip('sin día creado');
  const g = await api('GET', `/non-working-days/${created.nwd.id}`);
  ok(g.status === 200 && g.data?.id === created.nwd.id, `GET HTTP ${g.status}`);
  const r = await api('PATCH', `/non-working-days/${created.nwd.id}`, { body: { paymentFactor: 3, description: 'e2e editado' } });
  ok(r.status === 200, `PATCH HTTP ${r.status} ${r.status !== 200 ? JSON.stringify(r.data)?.slice(0, 160) : ''}`);
  ok(Number(r.data?.paymentFactor) === 3 && r.data?.description === 'e2e editado', `cambios reflejados (paymentFactor=${JSON.stringify(r.data?.paymentFactor)} → llega como ${typeof r.data?.paymentFactor})`);
});
await t('F05', 'baja DELETE /non-working-days/{id} y 404 posterior', async () => {
  if (!created.nwd) return skip('sin día creado');
  const r = await api('DELETE', `/non-working-days/${created.nwd.id}`);
  ok([200, 204].includes(r.status), `HTTP ${r.status}`);
  const g = await api('GET', `/non-working-days/${created.nwd.id}`);
  ok(g.status === 404, `GET tras borrar → HTTP ${g.status}`);
});
await t('F06', 'reporte GET /non-working-days/report → descargable', async () => {
  await checkReportLink(await api('GET', '/non-working-days/report', { params: { page: 1, limit: 10, dateFrom: `${today.getUTCFullYear()}-01-01`, dateTo: `${today.getUTCFullYear()}-12-31` } }), 'non-working-days');
});

/* ─── resumen ─── */
const pass = results.filter((r) => r.status === 'PASS').length, fail = results.filter((r) => r.status === 'FAIL').length, skipped = results.filter((r) => r.status === 'SKIP').length;
const checks = results.reduce((n, r) => n + r.checks.length, 0), failedChecks = results.reduce((n, r) => n + r.checks.filter((c) => !c.ok).length, 0);
console.log(`\nrelay: ${RELAY_URL}`);
console.log(`${pass} PASS · ${fail} FAIL · ${skipped} SKIP · ${checks - failedChecks}/${checks} asertos`);
const out = path.join(HERE, 'results', `api-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), relay: RELAY_URL, range: RANGE, results }, null, 2));
console.log(`resultados → ${out}`);
process.exitCode = fail ? 1 : 0;
