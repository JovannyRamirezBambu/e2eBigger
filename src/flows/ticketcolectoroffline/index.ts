import { bcbDb, closeDb } from '@harness/db';
import { isUp, portOpen } from '@harness/http';
import { logFile } from '@harness/paths';
import type { Flow, Probe } from '@harness/types';
import * as fs from 'fs';
import { cases } from './cases';
import { seed } from './seed';
import { allTcoBatches, catalog, TCO_PREFIX } from './scenarios';

const PORT_ADAPTER_TCO = Number(process.env.E2E_PORT_ADAPTER_TCO ?? 8092);
const PORT_ADAPTER_BCB = Number(process.env.E2E_PORT_ADAPTER_BCB ?? 8085);
const PORT_BCB_APP = Number(process.env.E2E_PORT_BCB_APP ?? 3009);
const PORT_JWKS = Number(process.env.E2E_PORT_JWKS ?? 7802);

function lastError(service: string): string {
  try {
    const lines = fs.readFileSync(logFile(service), 'utf-8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && i > lines.length - 500; i--) {
      const raw = lines[i]!;
      try {
        const o = JSON.parse(raw) as { level?: string; message?: string };
        if (o.level?.toUpperCase() === 'ERROR') return (o.message ?? '').slice(0, 220);
      } catch {
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
  const [upJwks, upAdapterTco, upAdapterBcb, upBcbApp, upNats] = await Promise.all([
    isUp(`http://127.0.0.1:${PORT_JWKS}/health`),
    isUp(`http://localhost:${PORT_ADAPTER_TCO}/ticketcolectoroffline/health`),
    isUp(`http://localhost:${PORT_ADAPTER_BCB}/actuator/health`),
    portOpen(PORT_BCB_APP),
    natsUp(),
  ]);
  const enCola = await streamMessages('TICKETCOLECTOROFFLINE_SYNC_STREAM');
  const lotes = await bcbDb()
    .syncOfflineRequest.count({ where: { advisorId: catalog.advisorId } })
    .catch(() => 0);

  return {
    flow: 'ticketcolectoroffline',
    escenarios: lotes,
    nodes: [
      {
        id: 'tablet',
        label: 'tablet del taquillero',
        sub: 'captura offline; acá la simula el harness',
        up: null,
        note: 'firma un JWT ADVISOR — la identidad NO viaja en el payload',
      },
      {
        id: 'jwks',
        label: 'emisor JWKS (prueba)',
        sub: `:${PORT_JWKS} · publica la pública del taquillero`,
        up: upJwks,
        error: lastError('jwks'),
        note: 'sustituye al emisor de BCB; sin él, todo responde 401',
      },
      {
        id: 'adapter-ticketcolectoroffline',
        label: 'adapter-ticketcolectoroffline',
        sub: `:${PORT_ADAPTER_TCO} · @BcbAuth(ADVISOR)`,
        up: upAdapterTco,
        error: lastError('adapter-ticketcolectoroffline'),
      },
      {
        id: 'nats',
        label: 'NATS',
        sub: 'request/reply del sync + JetStream de eventos',
        up: upNats,
        metrics: { 'eventos en cola': enCola },
      },
      {
        id: 'adapter-bcb',
        label: 'adapter-bcb',
        sub: `:${PORT_ADAPTER_BCB} · responde y firma el contrato-token 2.0`,
        up: upAdapterBcb,
        error: lastError('adapter-bcb'),
      },
      {
        id: 'bcb-app',
        label: 'apps/bcb — módulo sync',
        sub: `:${PORT_BCB_APP} · POST /sync`,
        up: upBcbApp,
        error: lastError('bcb-app'),
      },
    ],
  };
}

/**
 * Una fila por lote, con lo que quedó del otro lado. Se busca por el folio de la
 * tablet porque los ids del lote son nuevos en cada corrida (ver scenarios.ts).
 */
async function dbSnapshot(): Promise<Record<string, unknown>[]> {
  const db = bcbDb();
  const rows: Record<string, unknown>[] = [];

  for (const b of allTcoBatches) {
    const ventas = await db.orderItemOffline.findMany({
      where: { tabletTicketNumber: { startsWith: `${TCO_PREFIX}${b.tag}-` } },
      select: {
        tripId: true,
        orderItem: {
          select: {
            ticketNumber: true,
            order: { select: { status: true, total: true, shiftId: true } },
          },
        },
      },
    });
    const orden = ventas[0]?.orderItem?.order;

    rows.push({
      lote: b.tag,
      ventas: ventas.length || null,
      estado: orden?.status ?? null,
      total: orden ? String(orden.total) : null,
      folio_bcb: ventas[0]?.orderItem?.ticketNumber ?? null,
      corrida: ventas[0]?.tripId ?? null,
      turno: orden?.shiftId === catalog.turnoCerradoId ? 'cerrado' : orden?.shiftId ? 'abierto' : null,
    });
  }

  const recolecciones = await db.cashCollection.count({
    where: { shiftId: { in: [catalog.turnoAbiertoId, catalog.turnoCerradoId] } },
  });
  rows.push({
    lote: '(recolecciones)',
    ventas: recolecciones || null,
    estado: null,
    total: null,
    folio_bcb: null,
    corrida: null,
    turno: null,
  });

  return rows;
}

export const flow: Flow = {
  name: 'ticketcolectoroffline',
  description: 'Sincronización offline — lote de la tablet del taquillero hacia BCB',
  cases,
  seed,
  probe,
  dbSnapshot,
  close: closeDb,
};
