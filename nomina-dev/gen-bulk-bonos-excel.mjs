// Genera un Excel de carga masiva de Bonos con muchos operadores reales de dev,
// listo para usar a mano en "Carga masiva" (tab Bonos) y así poblar Pagos con
// datos de prueba variados (el bonusType/período se eligen en el diálogo, no en
// el archivo — la columna "Período de aplicación" del archivo es informativa).
//
//   node gen-bulk-bonos-excel.mjs [n]   # n filas (default 50, tope 200: cuantos operadores hay)
import ExcelJS from 'exceljs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSession, RELAY_URL, HERE } from './lib.mjs';

const N = Math.min(Number(process.argv[2]) || 50, 200);
const session = loadSession();
if (!session?.appToken) { console.error('No hay sesión: corre `node token.mjs` con el admin logueado.'); process.exit(2); }
const TOKEN = session.appToken;

async function api(method, route, { params } = {}) {
  const url = new URL(RELAY_URL + route);
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'X-Lang': 'es' } });
  return { status: res.status, data: await res.json().catch(() => null) };
}

// 1. Plantilla real (mismos encabezados/formato que descarga el botón "aquí" del diálogo)
const tplRes = await api('GET', '/manual-bonuses/bulk/template');
if (tplRes.status !== 200 || !tplRes.data?.url) { console.error('No pude obtener la plantilla:', tplRes.status, tplRes.data); process.exit(1); }
const tplBuf = Buffer.from(await (await fetch(tplRes.data.url)).arrayBuffer());
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(tplBuf);
const ws = wb.worksheets[0];
const headers = (ws.getRow(1).values ?? []).slice(1).map((v) => String(v ?? '').trim());
const idx = (re) => headers.findIndex((h) => re.test(h.toLowerCase())) + 1;
const cKey = idx(/^clave|key|hcm/), cName = idx(/nombre|name/), cAmount = idx(/monto|amount|importe/), cPeriod = idx(/per[ií]odo|period/), cComments = idx(/coment|observ|comment/);
if (!cKey || !cAmount) { console.error('No pude mapear las columnas clave/monto en la plantilla:', headers); process.exit(1); }
console.log(`Plantilla: ${headers.join(' | ')}`);

// 2. Operadores reales de dev
const opsRes = await api('GET', '/operators', { params: { page: 1, limit: 200 } });
const operators = (opsRes.data?.data ?? []).filter((o) => o.active);
if (operators.length < N) console.warn(`Solo hay ${operators.length} operadores activos; se generarán ${operators.length} filas.`);
const rows = operators.slice(0, N);

// 3. Llena el archivo: montos variados, algunos comentarios largos/cortos/vacíos para probar
const COMMENTS = ['', 'Bono por desempeño', 'Ajuste manual', 'Cubrir turno extra', 'Revisar antes de procesar', 'Prueba masiva e2e'];
const today = new Date();
const periodStart = new Date(today.getFullYear(), today.getMonth(), 1);
const periodEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
const fmt = (d) => d.toISOString().slice(0, 10);
const periodText = `${fmt(periodStart)} a ${fmt(periodEnd)}`;

// limpia filas de ejemplo que trae la plantilla
for (let i = ws.rowCount; i >= 2; i--) ws.spliceRows(i, 1);

rows.forEach((op, i) => {
  const row = ws.getRow(i + 2);
  row.getCell(cKey).value = op.key;
  if (cName) row.getCell(cName).value = op.name.trim();
  row.getCell(cAmount).value = Math.round((50 + Math.random() * 1450) * 100) / 100;
  if (cPeriod) row.getCell(cPeriod).value = periodText;
  if (cComments) row.getCell(cComments).value = COMMENTS[i % COMMENTS.length];
  row.commit();
});

const buf = Buffer.from(await wb.xlsx.writeBuffer());
const resultsPath = path.join(HERE, 'results', 'carga-masiva-bonos-prueba.xlsx');
fs.writeFileSync(resultsPath, buf);
const downloadsPath = path.join(os.homedir(), 'Downloads', 'carga-masiva-bonos-prueba.xlsx');
fs.writeFileSync(downloadsPath, buf);

console.log(`\n${rows.length} filas generadas (operadores reales de dev, período sugerido ${periodText}).`);
console.log(`→ ${resultsPath}`);
console.log(`→ ${downloadsPath}  (listo para arrastrar al diálogo "Carga masiva")`);
