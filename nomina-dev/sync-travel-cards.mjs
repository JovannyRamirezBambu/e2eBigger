// Dispara a mano el sync de tarjetas de viaje BCB → satélite PortalNominas.
//
// En dev las tarjetas NO llegan al Portal de Nómina cuando se recaudan: las trae un cron del
// adapter los lunes 6:00am (CDMX) con una ventana de 14 días que termina AYER. Por eso una tarjeta
// recaudada hoy no se ve hasta el lunes — y por eso este comando existe.
//
// El `to` por defecto acá es HOY, no ayer como en el cron: si se deja el default del endpoint, la
// ventana cierra ayer y la tarjeta que acabas de recaudar se queda fuera (es el error fácil).
//
//   node sync-travel-cards.mjs 6463                      # por clave de operador, últimos 14 días
//   node sync-travel-cards.mjs 6463 --from 2026-09-01    # rango explícito
//   node sync-travel-cards.mjs --recientes               # operadores con tarjetas recientes en BCB
//   node sync-travel-cards.mjs --todos                   # todo el catálogo activo (lento)
//   node sync-travel-cards.mjs 6463 --check              # no sincroniza; solo compara BCB vs satélite
import { loadSession, RELAY_URL } from './lib.mjs';

const BCB_API = process.env.NOMINA_BCB_API ?? 'https://kpbelqbjle.execute-api.us-west-2.amazonaws.com/develop';
const VENTANA_DIAS = 14;

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => { const i = args.indexOf(`--${name}`); return i > -1 ? args[i + 1] : null; };
const keys = args.filter((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));

const session = loadSession();
if (!session?.appToken) { console.error('No hay sesión: corre `node token.mjs` con el admin logueado.'); process.exit(2); }

const fmt = (d) => d.toISOString().slice(0, 10);
const today = fmt(new Date());
const to = value('to') ?? today;
const from = value('from') ?? fmt(new Date(new Date(`${to}T00:00:00Z`).getTime() - (VENTANA_DIAS - 1) * 86400000));

const relay = (path, init = {}) => fetch(`${RELAY_URL}${path}`, {
  ...init,
  headers: { Authorization: `Bearer ${session.appToken}`, 'X-Lang': 'es', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
});
const bcb = (path) => fetch(`${BCB_API}${path}`, { headers: { Authorization: `Bearer ${session.accessToken}`, 'X-Lang': 'es' } });

/** Catálogo de operadores del satélite: clave HCM → uuid (el endpoint de sync pide uuid). */
async function operatorCatalog() {
  const res = await relay('/operators?page=1&limit=500');
  if (!res.ok) throw new Error(`No pude leer /operators: HTTP ${res.status}`);
  return ((await res.json())?.data ?? []);
}

/** Tarjetas recientes en BCB (la fuente), para saber a quién vale la pena sincronizar. */
async function recentBcbCards(limit = 50) {
  const res = await bcb(`/operation/travel-cards?page=1&limit=${limit}`);
  if (!res.ok) {
    console.warn(`  (no pude consultar BCB: HTTP ${res.status} — el token de BCB puede haber expirado)`);
    return [];
  }
  return ((await res.json())?.data ?? []);
}

const catalog = await operatorCatalog();
const byKey = new Map(catalog.map((o) => [String(o.key), o]));

/* ─── A quién sincronizar ─── */
let targets = [];
if (flag('todos')) {
  targets = catalog.filter((o) => o.active);
  console.log(`Catálogo activo completo: ${targets.length} operadores (esto puede tardar varios minutos)`);
} else if (flag('recientes')) {
  const cards = await recentBcbCards(100);
  const ids = new Set(cards.filter((c) => c.status === 'COLLECTED').map((c) => c.trip?.operator?.id).filter(Boolean));
  targets = catalog.filter((o) => ids.has(o.id));
  console.log(`Operadores con tarjetas RECAUDADAS recientes en BCB: ${targets.length}`);
} else if (keys.length) {
  for (const k of keys) {
    const op = byKey.get(String(k));
    if (op) targets.push(op);
    else console.warn(`  clave ${k}: no está en el catálogo del satélite, se omite`);
  }
} else {
  console.error('Falta a quién sincronizar. Usa una clave de operador, --recientes o --todos.');
  process.exit(2);
}

if (!targets.length) { console.error('Nada que sincronizar.'); process.exit(1); }

console.log(`\nRango: ${from} → ${to}${to === today ? ' (incluye hoy)' : ''}`);
for (const o of targets.slice(0, 10)) console.log(`  · ${o.key} ${o.name?.trim()}`);
if (targets.length > 10) console.log(`  · … y ${targets.length - 10} más`);

/* ─── --check: comparar sin escribir ─── */
if (flag('check')) {
  console.log('\n--check: no se sincroniza nada.\n');
  const cards = await recentBcbCards(100);
  for (const o of targets) {
    const enBcb = cards.filter((c) => c.trip?.operator?.id === o.id);
    const res = await relay(`/travel-card-attendance/operator/${o.id}?dateFrom=${from}&dateTo=${to}`);
    const enSatelite = res.ok ? ((await res.json())?.cards ?? []) : [];
    console.log(`${o.key} ${o.name?.trim()} — BCB(recientes): ${enBcb.length} · satélite(${from}→${to}): ${enSatelite.length}`);
    const folios = new Set(enSatelite.map((c) => c.folio));
    for (const c of enBcb.filter((c) => c.status === 'COLLECTED' && !folios.has(c.key))) {
      console.log(`     falta: ${c.key} (${c.trip?.route?.number} ${c.trip?.route?.name})`);
    }
  }
  process.exit(0);
}

/* ─── Sync ─── */
const res = await relay('/travel-card-attendance-sync', {
  method: 'POST',
  body: JSON.stringify({ operatorIds: targets.map((o) => o.id), from, to }),
});
const body = await res.json().catch(() => null);
console.log(`\nsync HTTP ${res.status}:`, JSON.stringify(body));
if (!res.ok) process.exit(1);

/* ─── Qué quedó ─── */
console.log('\nEn el satélite tras el sync:');
for (const o of targets.slice(0, 10)) {
  const r = await relay(`/travel-card-attendance/operator/${o.id}?dateFrom=${from}&dateTo=${to}`);
  if (!r.ok) { console.log(`  ${o.key}: HTTP ${r.status}`); continue; }
  const d = await r.json();
  console.log(`  ${o.key} ${o.name?.trim()} — ${d.cards?.length ?? 0} tarjetas, ${d.absences} inasistencias`);
  for (const c of (d.cards ?? [])) {
    console.log(`     ${c.folio} ${c.status} monto=${c.amount ?? '(sin costo)'} ruta=${c.route?.number ?? '—'} ${c.route?.name ?? ''}`);
  }
}
process.exit(0);
