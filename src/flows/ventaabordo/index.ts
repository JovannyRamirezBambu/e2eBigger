import { bcbDb, closeDb, vaDb } from '@harness/db';
import { isUp, portOpen } from '@harness/http';
import { logFile } from '@harness/paths';
import type { Flow, Probe } from '@harness/types';
import * as fs from 'fs';
import { cases, fake } from './cases';
import { consultaCatalog } from './consulta-scenarios';
import { seed } from './seed';
import { allVaScenarios } from './scenarios';

const PORT_SAT = Number(process.env.E2E_VA_PORT_SAT ?? 3001);
const PORT_ADAPTER_VA = Number(process.env.E2E_PORT_ADAPTER_VA ?? 8088);
const PORT_ADAPTER_BCB = Number(process.env.E2E_PORT_ADAPTER_BCB ?? 8085);
const PORT_WEBHOOKS = Number(process.env.E2E_PORT_BCB_WEBHOOKS ?? 3011);
const PORT_BCB_APP = Number(process.env.E2E_PORT_BCB_APP ?? 3009);

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
  const [upSat, upAdapterVa, upAdapterBcb, upWebhooks, upBcbApp, upNats] = await Promise.all([
    isUp(`http://localhost:${PORT_SAT}/venta-abordo/health`),
    isUp(`http://localhost:${PORT_ADAPTER_VA}/ventaabordo/health`),
    isUp(`http://localhost:${PORT_ADAPTER_BCB}/actuator/health`),
    portOpen(PORT_WEBHOOKS),
    portOpen(PORT_BCB_APP),
    natsUp(),
  ]);
  const [enCola, dlq] = await Promise.all([
    streamMessages('VENTAABORDO_VENTAS_STREAM'),
    streamMessages('VENTAABORDO_VENTAS_DLQ_STREAM'),
  ]);
  const ventas = await bcbDb().boardingSale.count().catch(() => 0);

  return {
    flow: 'ventaabordo',
    escenarios: ventas,
    dlq,
    nodes: [
      {
        id: 'smartmac',
        label: 'SmartMac (falso)',
        sub: 'tercero real; acá se sustituye',
        up: null,
        note: 'lo levanta el proceso de pruebas, para leer el payload de WS1',
      },
      {
        id: 'satelite-va',
        label: 'satélite Venta a Bordo',
        sub: `:${PORT_SAT} · WS1 y WS2`,
        up: upSat,
        error: lastError('satelite-va'),
      },
      {
        id: 'adapter-ventaabordo',
        label: 'adapter-ventaabordo',
        sub: `:${PORT_ADAPTER_VA} · publica a JetStream`,
        up: upAdapterVa,
        error: lastError('adapter-ventaabordo'),
      },
      {
        id: 'jetstream',
        label: 'JetStream durable',
        sub: 'VENTAABORDO_VENTAS + DLQ',
        up: upNats,
        metrics: { 'en cola': enCola, DLQ: dlq },
      },
      {
        id: 'adapter-bcb',
        label: 'adapter-bcb',
        sub: `:${PORT_ADAPTER_BCB} · consume, llama a webhooks y responde biger.bcb.abordaje.trips.list`,
        up: upAdapterBcb,
        error: lastError('adapter-bcb'),
      },
      {
        id: 'bcb-webhooks',
        label: 'apps/webhooks',
        sub: `:${PORT_WEBHOOKS} · /smartmac/venta-abordo`,
        up: upWebhooks,
        error: lastError('bcb-webhooks'),
      },
      {
        id: 'bcb-app',
        label: 'app bcb',
        sub: `:${PORT_BCB_APP} · GET /abordaje/trips — fuente de la Consulta de tarjetas de viaje`,
        up: upBcbApp,
        note: 'compartida con tomtom/ticketcolectoroffline; no la baja `./e2e down ventaabordo` sin --all',
        error: lastError('bcb-app'),
      },
    ],
  };
}

/** Las dos mitades del flujo, una al lado de la otra: satélite y BCB. */
async function dbSnapshot(): Promise<Record<string, unknown>[]> {
  const va = vaDb();
  const bcb = bcbDb();
  const rows: Record<string, unknown>[] = [];

  for (const s of allVaScenarios) {
    const tarjeta = (await va.tarjetaViaje.findFirst({
      where: { idTarjetaViaje: BigInt(s.tarjetaViajeId) },
    })) as { estado?: string; fechaEnvioSmartmac?: Date | null } | null;
    const venta = await bcb.boardingSale.findFirst({
      where: { smartmacId: s.ventaId },
      select: { totalTicketsSold: true, totalAmount: true, _count: { select: { items: true } } },
    });

    rows.push({
      escenario: s.tag,
      clave_corrida: s.claveCorrida,
      tarjeta_satelite: tarjeta ? (tarjeta.estado ?? 'sí') : null,
      enviada_a_smartmac: tarjeta?.fechaEnvioSmartmac ? 'sí' : tarjeta ? 'NO' : null,
      venta_en_bcb: venta ? 'sí' : null,
      boletos: venta?.totalTicketsSold ?? null,
      items: venta?._count?.items ?? null,
      monto: venta ? String(venta.totalAmount) : null,
    });
  }

  // Consulta de tarjetas de viaje por operador: BCB es la fuente acá, no el
  // satélite — dos filas fijas en vez de iterar `allVaScenarios`.
  const corridasConsulta = await bcb.trip.findMany({
    where: { id: { in: [consultaCatalog.tripDespachadaId, consultaCatalog.tripAbiertaId] } },
    include: { travelCard: true },
  });
  for (const trip of corridasConsulta) {
    rows.push({
      escenario: `consulta:${trip.id}`,
      clave_corrida: trip.id,
      tarjeta_satelite: trip.travelCard ? `folio=${trip.travelCard.key} estado=${trip.travelCard.status}` : 'sin tarjeta',
      enviada_a_smartmac: null,
      venta_en_bcb: null,
      boletos: null,
      items: null,
      monto: null,
    });
  }
  return rows;
}

export const flow: Flow = {
  name: 'ventaabordo',
  description: 'WS1/WS2 — Venta a Bordo: despacho hacia SmartMac y retorno de ventas hacia BCB',
  cases,
  seed,
  probe,
  dbSnapshot,
  // El SmartMac falso solo tiene sentido mientras corren las pruebas: se abre
  // antes de los casos y se cierra al final, en su puerto fijo (el satélite ya
  // apunta ahí desde que arrancó).
  beforeCases: () => fake.start(),
  async close() {
    await fake.stop();
    await closeDb();
  },
};
