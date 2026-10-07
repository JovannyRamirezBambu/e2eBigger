// Dispara a mano el sync COMPLETO del catálogo de operadores BCB → satélite PortalNominas.
//
// Es el otro sync del adapter (el de tarjetas es sync-travel-cards.mjs): manda el catálogo de
// operadores vigentes con el nombre de su servicio y la EMPRESA de ese servicio. Corre solo en el
// cron semanal (lunes 6:00am CDMX), así que tras un deploy hay que forzarlo para no esperar.
//
//   node sync-operator-catalog.mjs            # sincroniza y reporta cuántos quedaron con empresa
//   node sync-operator-catalog.mjs --check    # NO sincroniza: solo mide cómo está el snapshot
import { loadSession, RELAY_URL } from './lib.mjs';

const soloCheck = process.argv.includes('--check');

const session = loadSession();
if (!session?.appToken) {
  console.error('No hay sesión: corre `node token-cdp.mjs` con el admin logueado.');
  process.exit(2);
}
if (session.appTokenExp && new Date(session.appTokenExp) < new Date()) {
  console.error(`La sesión guardada expiró (${new Date(session.appTokenExp).toLocaleString()}) — corre \`node token-cdp.mjs\`.`);
  process.exit(2);
}

const relay = (path, init = {}) =>
  fetch(`${RELAY_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${session.appToken}`, 'X-Lang': 'es', ...init.headers },
  });

/** Cuántos operadores del snapshot traen empresa y servicio — la foto que ve el CMS. */
async function medirSnapshot() {
  const res = await relay('/operators?page=1&limit=500');
  if (!res.ok) throw new Error(`No pude leer /operators: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json())?.data ?? [];
  const activos = data.filter((o) => o.active);
  return {
    total: data.length,
    activos: activos.length,
    conEmpresa: activos.filter((o) => o.company).length,
    conServicio: activos.filter((o) => o.serviceName).length,
    empresas: [...new Set(activos.map((o) => o.company).filter(Boolean))],
  };
}

const antes = await medirSnapshot();
console.log(`Snapshot actual: ${antes.activos} operadores activos · ${antes.conEmpresa} con empresa · ${antes.conServicio} con servicio`);
if (antes.empresas.length) console.log(`  empresas: ${antes.empresas.join(', ')}`);

if (soloCheck) process.exit(0);

console.log('\nDisparando POST /operators/sync (catálogo completo desde BCB)…');
const inicio = Date.now();
const res = await relay('/operators/sync', { method: 'POST' });
const cuerpo = await res.text();
if (!res.ok) {
  console.error(`Falló: HTTP ${res.status} ${cuerpo.slice(0, 300)}`);
  process.exit(1);
}
console.log(`  ${cuerpo} (${((Date.now() - inicio) / 1000).toFixed(1)}s)`);

const despues = await medirSnapshot();
console.log(`\nSnapshot tras el sync: ${despues.activos} operadores activos · ${despues.conEmpresa} con empresa · ${despues.conServicio} con servicio`);
if (despues.empresas.length) console.log(`  empresas: ${despues.empresas.join(', ')}`);
if (despues.conEmpresa === 0) {
  console.log('\n⚠️  Ninguno quedó con empresa: revisa que adapter-portalnomina desplegado sea el que resuelve Service.companyId → Company.shortName.');
}
