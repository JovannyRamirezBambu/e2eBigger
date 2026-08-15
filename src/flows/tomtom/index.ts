import { bcbDb, closeDb } from '@harness/db';
import { isUp, portOpen } from '@harness/http';
import { logFile } from '@harness/paths';
import type { Flow, Probe } from '@harness/types';
import * as fs from 'fs';
import { cases } from './cases';
import { seed } from './seed';

const PORT_ADAPTER_TOMTOM = Number(process.env.E2E_PORT_ADAPTER_TOMTOM ?? 8090);
const PORT_ADAPTER_BCB = Number(process.env.E2E_PORT_ADAPTER_BCB ?? 8085);
const PORT_BCB_APP = Number(process.env.E2E_PORT_BCB_APP ?? 3009);

/**
 * Último error de un servicio. Es lo que convierte "algo falló" en "falló acá,
 * por esto" en el panel, y ahorra grepear tres logs a mano.
 */
function lastError(service: string): string {
  try {
    const lines = fs.readFileSync(logFile(service), 'utf-8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && i > lines.length - 500; i--) {
      const raw = lines[i]!;
      try {
        const o = JSON.parse(raw) as { level?: string; message?: string };
        if (o.level?.toUpperCase() === 'ERROR') return (o.message ?? '').slice(0, 220);
      } catch {
        // La app de BCB loguea texto de Nest, no JSON.
        if (/ERROR/.test(raw)) return raw.replace(/\x1b?\[[0-9;]*m/g, '').slice(0, 220);
      }
    }
  } catch {
    /* sin log todavía */
  }
  return '';
}

async function probe(): Promise<Probe> {
  const { natsUp, streamMessages } = await import('@harness/nats');
  const [upTomtom, upBcb, upApp, upNats] = await Promise.all([
    isUp(`http://localhost:${PORT_ADAPTER_TOMTOM}/actuator/health`),
    isUp(`http://localhost:${PORT_ADAPTER_BCB}/actuator/health`),
    portOpen(PORT_BCB_APP),
    natsUp(),
  ]);
  const [enCola, dlq] = await Promise.all([
    streamMessages('TOMTOM_GEOCERCAS_STREAM'),
    streamMessages('TOMTOM_GEOCERCAS_DLQ_STREAM'),
  ]);
  const escenarios = await bcbDb()
    .trip.count({ where: { id: { startsWith: 'e2e' } } })
    .catch(() => 0);

  return {
    flow: 'tomtom',
    escenarios,
    dlq,
    nodes: [
      {
        id: 'satelite',
        label: 'satélite TomTom',
        sub: 'firma el JWT y notifica',
        up: null,
        note: 'se invoca por script, no es un proceso residente',
      },
      {
        id: 'adapter-tomtom',
        label: 'adapter-tomtom',
        sub: `:${PORT_ADAPTER_TOMTOM} · publica a JetStream`,
        up: upTomtom,
        error: lastError('adapter-tomtom'),
      },
      {
        id: 'jetstream',
        label: 'JetStream durable',
        sub: '7 d · dedup · DLQ 30 d',
        up: upNats,
        metrics: { 'en cola': enCola, DLQ: dlq },
      },
      {
        id: 'adapter-bcb',
        label: 'adapter-bcb',
        sub: `:${PORT_ADAPTER_BCB} · consume y llama a BCB`,
        up: upBcb,
        error: lastError('adapter-bcb'),
      },
      {
        id: 'bcb-app',
        label: 'apps/bcb',
        sub: `:${PORT_BCB_APP} · T1 · T10 · T11`,
        up: upApp,
        error: lastError('bcb-app'),
      },
    ],
  };
}

/** Filas para el panel y para `./e2e verify`. */
async function dbSnapshot(): Promise<Record<string, unknown>[]> {
  const trips = await bcbDb().trip.findMany({
    where: { id: { startsWith: 'e2e' } },
    orderBy: { id: 'asc' },
    include: {
      travelCard: { select: { status: true } },
      tripDispatch: {
        select: {
          bus: { select: { status: true, station: { select: { shortName: true } } } },
          operator: { select: { tripStatus: true } },
        },
      },
    },
  });

  const hm = (d: Date | null) =>
    d ? `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}` : null;
  const dmhm = (d: Date | null) =>
    d ? `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')} ${hm(d)}` : null;

  return trips.map((t) => ({
    esc: t.id.slice(-7),
    corrida: t.status,
    despacho_admin: hm(t.dispatchedAt),
    salida_real: dmhm(t.realDepartureAt),
    llegada_real: dmhm(t.realArrivalAt),
    tarjeta: t.travelCard?.status ?? null,
    bus: t.tripDispatch?.bus?.status ?? null,
    bus_en: t.tripDispatch?.bus?.station?.shortName ?? null,
    operador: t.tripDispatch?.operator?.tripStatus ?? null,
  }));
}

export const flow: Flow = {
  name: 'tomtom',
  description: 'CU04/CU05 — geocercas TomTom/InRoute: despacho y llegada reales hacia BCB',
  cases,
  seed,
  probe,
  dbSnapshot,
  close: closeDb,
};
