#!/usr/bin/env tsx
/**
 * Capa de pruebas del harness. La invoca el entrypoint `./e2e` (bash), que sigue
 * siendo el dueño de la infraestructura (docker, mvn, puertos, procesos).
 *
 *   tsx src/cli.ts <flujo> cases|probe|db-json|seed|test|verify|dlq [caso]
 *
 * El formato de salida de `test` es idéntico al que tenía la versión en bash,
 * porque el panel lo parsea y porque cambiar de lenguaje no debería cambiar lo
 * que ves en la terminal.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Report } from './harness/report';
import { RUN_DIR } from './harness/paths';
import { drainHttp, setCurrentCase, type HttpTraceEntry } from './harness/trace';
import type { Flow } from './harness/types';

const FLOWS: Record<string, () => Promise<{ flow: Flow }>> = {
  tomtom: () => import('./flows/tomtom/index'),
  ventaabordo: () => import('./flows/ventaabordo/index'),
  ticketcolectoroffline: () => import('./flows/ticketcolectoroffline/index'),
  agencias: () => import('./flows/agencias/index'),
};

async function loadFlow(name: string): Promise<Flow> {
  const loader = FLOWS[name];
  if (!loader) {
    console.error(`flujo desconocido: '${name}'. Disponibles: ${Object.keys(FLOWS).join(', ')}`);
    process.exit(1);
  }
  return (await loader()).flow;
}

/** Fusiona con lo previo: correr un caso suelto no debe borrar los otros 17. */
function writeResults(flowName: string, report: Report): void {
  const file = path.join(RUN_DIR, `${flowName}-results.json`);
  let prev: { cases?: Record<string, string> } = {};
  try {
    prev = JSON.parse(fs.readFileSync(file, 'utf-8')) as typeof prev;
  } catch {
    /* primera corrida */
  }
  const cases = { ...(prev.cases ?? {}) };
  for (const [name, status] of report.caseResults) cases[name] = status;
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      flow: flowName,
      cases,
      lastRun: { pass: report.pass, fail: report.fail, cases: report.caseResults.size },
    }),
  );
}

/**
 * Igual que `writeResults`: fusiona con lo previo. Los casos que SÍ corrieron ahora
 * reemplazan su tráfico viejo (si un caso dejó de llamar a algo, no debe seguir
 * mostrando la llamada fantasma de la corrida anterior); los que no corrieron
 * conservan el suyo.
 */
function writeTraffic(flowName: string, ranCases: string[]): void {
  const file = path.join(RUN_DIR, `${flowName}-http.json`);
  let prev: { entries?: HttpTraceEntry[] } = {};
  try {
    prev = JSON.parse(fs.readFileSync(file, 'utf-8')) as typeof prev;
  } catch {
    /* primera corrida */
  }
  const kept = (prev.entries ?? []).filter((e) => !ranCases.includes(e.case ?? ''));
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ flow: flowName, entries: [...kept, ...drainHttp()] }));
}

async function main(): Promise<number> {
  const [, , flowName, cmd, arg] = process.argv;
  if (!flowName || !cmd) {
    console.error('uso: cli.ts <flujo> cases|probe|db-json|seed|test|verify|dlq [caso]');
    return 1;
  }
  const flow = await loadFlow(flowName);

  try {
    switch (cmd) {
      case 'cases':
        for (const c of flow.cases) console.log(`${c.name}\t${c.label}`);
        return 0;

      case 'probe':
        console.log(JSON.stringify(await flow.probe()));
        return 0;

      case 'token': {
        if (!flow.adminToken) {
          console.error(`el flujo '${flowName}' no emite tokens de administración`);
          return 1;
        }
        // Solo el token en stdout: así se puede canalizar directo a curl o a Bruno.
        console.log(flow.adminToken(arg ? Number(arg) : undefined));
        return 0;
      }

      case 'db-json':
        console.log(JSON.stringify(await flow.dbSnapshot()));
        return 0;

      case 'dlq': {
        const { readDlq } = await import('./harness/nats');
        console.log(JSON.stringify(await readDlq(arg ?? 'TOMTOM_GEOCERCAS_DLQ_STREAM')));
        return 0;
      }

      case 'traffic': {
        const file = path.join(RUN_DIR, `${flowName}-http.json`);
        try {
          console.log(fs.readFileSync(file, 'utf-8'));
        } catch {
          console.log(JSON.stringify({ flow: flowName, entries: [] }));
        }
        return 0;
      }

      case 'seed': {
        const r = new Report();
        r.step('Sembrando escenarios');
        await flow.seed();
        return 0;
      }

      case 'verify': {
        const rows = await flow.dbSnapshot();
        if (!rows.length) {
          console.log('sin escenarios sembrados');
          return 0;
        }
        const cols = Object.keys(rows[0]!);
        const width = (c: string) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '—').length));
        const w = Object.fromEntries(cols.map((c) => [c, width(c)]));
        const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(w[cols[i]!]!)).join('  ');
        console.log(`\n${line(cols)}`);
        console.log(cols.map((c) => '─'.repeat(w[c]!)).join('  '));
        for (const r of rows) console.log(line(cols.map((c) => String(r[c] ?? '—'))));
        console.log('');
        return 0;
      }

      case 'test': {
        const only = arg;
        const selected = only ? flow.cases.filter((c) => c.name === only) : flow.cases;
        if (only && selected.length === 0) {
          console.error(`caso desconocido: '${only}'`);
          return 1;
        }
        const report = new Report();
        await flow.beforeCases?.();
        report.step('Casos');
        for (const c of selected) {
          report.beginCase(c.name);
          setCurrentCase(c.name);
          try {
            await c.run(report);
          } catch (err) {
            report.crashed(c.name, err);
          } finally {
            setCurrentCase(null);
          }
          report.endCase();
        }
        writeResults(flow.name, report);
        writeTraffic(
          flow.name,
          selected.map((c) => c.name),
        );
        return report.summary(flow.name) === 0 ? 0 : 1;
      }

      default:
        console.error(`comando desconocido: '${cmd}'`);
        return 1;
    }
  } finally {
    await flow.close?.();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
