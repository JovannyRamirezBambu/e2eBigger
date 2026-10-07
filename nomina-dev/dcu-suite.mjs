// Suite trazada al DCU "Descripción de casos de uso - Administrador - Portal Nóminas"
// (Jacobo Esaú Herrera Tizcareño, actualizado 2025-12-05).
//
// No duplica api-tests.mjs: lo corre por grupos y mapea cada caso de uso (CU01-CU16)
// a los IDs de prueba que ya lo cubren. Lo que agrega:
//   - Verificación real del nombre de archivo que descarga el navegador (CU05/CU08/CU13),
//     que api-tests.mjs NO puede ver (solo lee el Content-Disposition del satélite; el
//     nombre real lo decide `downloadFileHelper` en el front, que siempre gana). Esto es
//     justo el bug que Jovanny encontró: los 4 reportes bajaban con nombre fijo en inglés
//     y sin fecha, aunque el satélite mandaba un Content-Disposition razonable.
//   - Un reporte final CU01-CU16 con estado y nota (PASS/FAIL/SKIP/N-A).
//
// CU14-CU16 son procesos de "Sistema BCB (Proceso Batch o Trigger)" — no tienen endpoint
// ni botón en el CMS, así que no son ejecutables desde aquí; se listan como N/A con la
// razón, no como fallos.
//
//   node dcu-suite.mjs                  # todo: api-tests.mjs (todos los grupos) + nombres de reporte
//   node dcu-suite.mjs --skip-download  # omite la verificación de nombre de archivo (requiere Chrome+sesión)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HERE, connect, newAuthedPage, loadSession, ADMIN_URL } from './lib.mjs';

const SKIP_DOWNLOAD = process.argv.includes('--skip-download');

/* ─── 1. Corre api-tests.mjs por grupo y junta los resultados ─── */
const GROUPS = ['A', 'G', 'B', 'C', 'D', 'E', 'F'];
const byId = {};
for (const g of GROUPS) {
  let out;
  try {
    out = execFileSync('node', ['api-tests.mjs', '--only', g], { cwd: HERE, encoding: 'utf8' });
  } catch (e) {
    out = e.stdout ?? '';
  }
  for (const line of out.split('\n')) {
    const m = line.match(/^(✅|❌|⏭️ )\s(\S+)\s(.+)$/);
    if (!m) continue;
    const status = m[1] === '✅' ? 'PASS' : m[1] === '❌' ? 'FAIL' : 'SKIP';
    byId[m[2]] = { status, name: m[3] };
  }
}

/* ─── 2. Verificación del nombre real de archivo (CU05/CU08/CU13 y Pagos) ─── */
// El patrón del DCU (CU05, ejemplo literal): ReporteBonos_[Fecha].xlsx
const FILENAME_RE = /^Reporte(Bonos|Pagos|Asistencias|DiasInhabiles)_\d{4}-\d{2}-\d{2}\.xlsx$/;
const downloadChecks = {}; // cu -> { status, note }

async function verifyDownloadNames() {
  const session = loadSession();
  if (!session?.appToken) {
    for (const cu of ['CU05', 'CU08', 'CU13']) downloadChecks[cu] = { status: 'SKIP', note: 'sin sesión (corre token.mjs)' };
    return;
  }
  let context;
  try {
    ({ context } = await connect());
  } catch (e) {
    for (const cu of ['CU05', 'CU08', 'CU13']) downloadChecks[cu] = { status: 'SKIP', note: `sin Chrome CDP: ${e.message}` };
    return;
  }
  const page = await newAuthedPage(context, session);
  const targets = [
    { cu: 'CU05', tab: 'bonos', prefix: 'Bonos' },
    { cu: 'PAGOS', tab: 'pagos', prefix: 'Pagos' },
    { cu: 'CU08', tab: 'asistencias', prefix: 'Asistencias' },
    { cu: 'CU13', tab: 'dias-inhabiles', prefix: 'DiasInhabiles' },
  ];
  for (const { cu, tab, prefix } of targets) {
    try {
      await page.goto(`${ADMIN_URL}/dashboard/portal-nomina?tab=${tab}`, { waitUntil: 'networkidle', timeout: 20000 });
      if (/iniciar-sesion/.test(page.url())) {
        downloadChecks[cu] = { status: 'SKIP', note: 'sesión inválida — el token de BCB fue rechazado (401); requiere volver a iniciar sesión' };
        continue;
      }
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 15000 }),
        page.getByRole('button', { name: /descargar reporte/i }).click(),
      ]);
      const suggested = download.suggestedFilename();
      const okName = FILENAME_RE.test(suggested) && suggested.startsWith(`Reporte${prefix}_`);
      downloadChecks[cu] = { status: okName ? 'PASS' : 'FAIL', note: `nombre descargado: "${suggested}"${okName ? '' : ` — no cumple Reporte${prefix}_[Fecha].xlsx`}` };
      await download.cancel().catch(() => {});
    } catch (e) {
      downloadChecks[cu] = { status: 'FAIL', note: `excepción: ${e.message}` };
    }
  }
  await page.close();
}

if (!SKIP_DOWNLOAD) await verifyDownloadNames();
else for (const cu of ['CU05', 'CU08', 'CU13']) downloadChecks[cu] = { status: 'SKIP', note: '--skip-download' };

/* ─── 3. Mapa DCU → pruebas ─── */
const CU = [
  { id: 'CU01', title: 'Cargar bono o pago adicional (manual)', tests: ['B05', 'B09'] },
  { id: 'CU02', title: 'Obtener bonos o pagos adicionales', tests: ['B01', 'B02'] },
  { id: 'CU03', title: 'Editar bonos o pagos adicionales', tests: ['B07'] },
  { id: 'CU04', title: 'Eliminar bonos o pagos adicionales', tests: ['B08'] },
  { id: 'CU05', title: 'Descargar reporte de bonos', tests: ['B03'], download: 'CU05' },
  { id: '(Pagos)', title: 'Tab Pagos — split del CMS de CU02/CU05 (no es un CU propio del DCU)', tests: ['C01', 'C02', 'C03', 'C04'], download: 'PAGOS' },
  { id: 'CU06', title: 'Consulta de asistencias (tarjetas de viaje)', tests: ['D01', 'D03', 'D04'] },
  { id: 'CU07', title: 'Carga manual de asistencias (servicios especiales)', tests: ['E02', 'E04', 'E05', 'E06'] },
  { id: 'CU08', title: 'Descargar reporte asistencias', tests: ['D05'], download: 'CU08' },
  { id: 'CU09', title: 'Crear día inhábil', tests: ['F02', 'F03'] },
  { id: 'CU10', title: 'Obtener días inhábiles', tests: ['F01'] },
  { id: 'CU11', title: 'Actualizar día inhábil', tests: ['F04'] },
  { id: 'CU12', title: 'Eliminar días inhábiles', tests: ['F05'] },
  { id: 'CU13', title: 'Descargar reporte días inhábiles', tests: ['F06'], download: 'CU13' },
  { id: 'CU14', title: 'Cálculo de bono asistencia (FIK/FOC)', tests: [], na: 'Actor = Sistema BCB (batch/trigger); sin endpoint/botón en el CMS' },
  { id: 'CU15', title: 'Cálculo de pago adicional por día inhábil', tests: [], na: 'Actor = Sistema BCB (batch/trigger); sin endpoint/botón en el CMS' },
  { id: 'CU16', title: 'Envío de Información de Nómina a BIGER', tests: ['C01'], na: 'Proceso de sistema; el listado de Pagos (C01) solo confirma que su salida (orígenes SPECIAL_SERVICE/TRAVEL_CARD) llega al CMS, no dispara el envío' },
];

console.log('\n═══ Trazabilidad DCU · Administrador · Portal Nóminas ═══\n');
let overallFail = false;
for (const cu of CU) {
  const rows = cu.tests.map((id) => byId[id] ?? { status: 'SKIP', name: '(no corrió)' });
  const dl = cu.download ? downloadChecks[cu.download] : null;
  const all = dl ? [...rows, dl] : rows;
  const status = cu.na && rows.length === 0
    ? 'N/A'
    : all.some((r) => r.status === 'FAIL') ? 'FAIL'
    : all.every((r) => r.status === 'SKIP') ? 'SKIP'
    : 'PASS';
  if (status === 'FAIL') overallFail = true;
  const icon = { PASS: '✅', FAIL: '❌', SKIP: '⏭️ ', 'N/A': '➖' }[status];
  console.log(`${icon} ${cu.id.padEnd(8)} ${cu.title}`);
  for (const id of cu.tests) console.log(`     · ${id}: ${byId[id] ? byId[id].status : '(no corrió)'} — ${byId[id]?.name ?? ''}`);
  if (dl) console.log(`     · descarga real (navegador): ${dl.status} — ${dl.note}`);
  if (cu.na) console.log(`     · nota: ${cu.na}`);
}

const out = path.join(HERE, 'results', `dcu-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), byId, downloadChecks, CU }, null, 2));
console.log(`\nresultados → ${out}`);
process.exitCode = overallFail ? 1 : 0;
// La conexión CDP deja un handle vivo (igual que en shot.mjs/token.mjs); sin este exit
// explícito el proceso nunca termina aunque ya haya impreso todo el reporte.
process.exit(process.exitCode);
