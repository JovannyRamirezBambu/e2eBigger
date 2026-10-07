// Siembra ~30 días inhábiles en dev para pruebas manuales del módulo Días Inhábiles
// (fechas/festivos realistas, factor de pago variado, mezcla pasado/hoy/futuro para
// poder probar el filtro "Por estados" (Cumplida/En curso/Pendiente)).
//
//   node seed-non-working-days.mjs           # crea los que falten
//   node seed-non-working-days.mjs --dry-run # solo muestra qué haría
import { loadSession, RELAY_URL, HERE } from './lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const DRY_RUN = process.argv.includes('--dry-run');
const session = loadSession();
if (!session?.appToken) { console.error('No hay sesión: corre `node token.mjs` con el admin logueado.'); process.exit(2); }
const TOKEN = session.appToken;

async function api(method, route, { params, body } = {}) {
  const url = new URL(RELAY_URL + route);
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'X-Lang': 'es', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await res.json().catch(() => null) : await res.text().catch(() => '');
  return { status: res.status, data };
}

// 30 fechas: mezcla de pasado (Cumplida), hoy (En curso) y futuro (Pendiente) sobre 2026,
// con nombres reconocibles para que sea fácil ubicarlos al probar filtros/búsqueda a mano.
const DAYS = [
  { date: '2026-01-01', description: 'Año Nuevo', paymentFactor: 2 },
  { date: '2026-02-02', description: 'Día de la Candelaria', paymentFactor: 1.5 },
  { date: '2026-02-03', description: 'Conmemoración Constitución 1917', paymentFactor: 2 },
  { date: '2026-03-16', description: 'Natalicio de Benito Juárez (observado)', paymentFactor: 2 },
  { date: '2026-03-19', description: 'Aniversario expropiación petrolera (prueba)', paymentFactor: 1.5 },
  { date: '2026-04-02', description: 'Jueves Santo', paymentFactor: 2.5 },
  { date: '2026-04-03', description: 'Viernes Santo', paymentFactor: 2.5 },
  { date: '2026-04-30', description: 'Día del Niño', paymentFactor: 1.5 },
  { date: '2026-05-01', description: 'Día del Trabajo', paymentFactor: 2 },
  { date: '2026-05-10', description: 'Día de las Madres', paymentFactor: 2 },
  { date: '2026-05-15', description: 'Día del Maestro', paymentFactor: 1.5 },
  { date: '2026-06-01', description: 'Día de la Marina', paymentFactor: 1.5 },
  { date: '2026-06-21', description: 'Puente operativo — solsticio', paymentFactor: 1.5 },
  { date: '2026-07-04', description: 'Puente operativo de julio', paymentFactor: 2 },
  { date: '2026-08-15', description: 'Aniversario de la ciudad (prueba)', paymentFactor: 2 },
  { date: '2026-09-16', description: 'Día de la Independencia', paymentFactor: 3 },
  { date: '2026-09-18', description: 'Mantenimiento programado de flotilla', paymentFactor: 1.5 },
  { date: '2026-09-25', description: 'Cierre trimestral operativo', paymentFactor: 1.5 },
  { date: '2026-10-12', description: 'Día de la Raza', paymentFactor: 2 },
  { date: '2026-10-31', description: 'Puente operativo — Halloween', paymentFactor: 1.5 },
  { date: '2026-11-02', description: 'Día de Muertos', paymentFactor: 2 },
  { date: '2026-11-16', description: 'Revolución Mexicana (observado)', paymentFactor: 2 },
  { date: '2026-11-20', description: 'Revolución Mexicana', paymentFactor: 2 },
  { date: '2026-11-27', description: 'Puente operativo de noviembre', paymentFactor: 1.5 },
  { date: '2026-12-01', description: 'Transmisión de gobierno (evento especial)', paymentFactor: 1.5 },
  { date: '2026-12-12', description: 'Día de la Virgen de Guadalupe', paymentFactor: 2 },
  { date: '2026-12-24', description: 'Nochebuena', paymentFactor: 2.5 },
  { date: '2026-12-25', description: 'Navidad', paymentFactor: 3 },
  { date: '2026-12-28', description: 'Puente fin de año', paymentFactor: 1.5 },
  { date: '2026-12-31', description: 'Fin de año', paymentFactor: 2.5 },
];

console.log(`Sembrando ${DAYS.length} días inhábiles en ${RELAY_URL} ${DRY_RUN ? '(dry-run)' : ''}\n`);

// Trae lo que ya existe en el rango para no duplicar (F03: duplicado mismo día → 4xx).
const existing = await api('GET', '/non-working-days', { params: { page: 1, limit: 100, dateFrom: '2026-01-01', dateTo: '2026-12-31' } });
const existingDates = new Set((existing.data?.data ?? []).map((d) => d.date.slice(0, 10)));
console.log(`Ya existían ${existingDates.size} días inhábiles en 2026.\n`);

const created = [];
const skipped = [];
const failed = [];

for (const day of DAYS) {
  if (existingDates.has(day.date)) { skipped.push(day); console.log(`⏭️  ${day.date}  ${day.description}  (ya existía)`); continue; }
  if (DRY_RUN) { console.log(`🔹 ${day.date}  ${day.description}  factor ${day.paymentFactor}  (dry-run, no se crea)`); continue; }
  const r = await api('POST', '/non-working-days', { body: day });
  if ([200, 201].includes(r.status)) {
    created.push(r.data);
    console.log(`✅ ${day.date}  ${day.description}  factor ${day.paymentFactor}`);
  } else {
    failed.push({ ...day, status: r.status, error: r.data });
    console.log(`❌ ${day.date}  ${day.description}  → HTTP ${r.status} ${JSON.stringify(r.data)?.slice(0, 120)}`);
  }
}

console.log(`\n${created.length} creados · ${skipped.length} ya existían · ${failed.length} fallaron`);

if (!DRY_RUN) {
  const out = path.join(HERE, 'results', `seed-non-working-days-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), created, skipped, failed }, null, 2));
  console.log(`resultados → ${out}`);
}
process.exitCode = failed.length ? 1 : 0;
process.exit(process.exitCode);
