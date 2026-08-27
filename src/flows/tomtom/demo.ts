/**
 * La corrida de demostración del panel (`./e2e demo tomtom`).
 *
 * El panel es Node pelado a propósito —arranca al instante y no se recompila a
 * media reunión—, así que lo único que necesita el Prisma de BCB vive acá y se
 * invoca con `tsx src/cli.ts tomtom demo-trip`. Imprime JSON en stdout: ése es su
 * contrato con el panel.
 *
 * (El otro trabajo del panel, correr el proceso programado de telemetría, usa el
 * código YA COMPILADO del satélite: ver demo-tomtom/sync-runner.cjs. No puede
 * pasar por acá porque tsx no emite la metadata de decoradores que Nest necesita
 * para inyectar dependencias.)
 */
import { BusStatus, OperatorTripStatus, TravelCardStatus, TripStatus } from '@bcb/prisma-enums';
import { bcbDb } from '@harness/db';
import { randomUUID } from 'crypto';
import { catalog, scenarios } from './scenarios';

/** Escenario del que cuelgan bus, operador y ruta de la demostración. */
const DEMO = scenarios.CADENA_T10;
const MARKER = 'E2E-DEMO-TOMTOM';

export type DemoTrip = {
  travelCardId: string;
  tripId: string;
  busId: string;
  operadorId: string;
  economicNumber: string;
  operatorKey: string;
  routeNumber: string;
  routeName: string;
  origenId: string;
  destinoId: string;
  departure: string;
};

/**
 * Crea una corrida despachada y su tarjeta de viaje, con ids nuevos.
 *
 * Ids nuevos por corrida y no un escenario fijo, por dos razones: adapter-tomtom
 * deriva el `Nats-Msg-Id` del id del viaje, así que repetir uno cae en la ventana
 * de deduplicación de JetStream (2 min) y el segundo evento no publica nada; y en
 * una reunión la demostración se repite varias veces seguidas.
 *
 * Barre las corridas de demostraciones anteriores (cuelgan del mismo marcador) y
 * deja bus y operador en su estado inicial, en la terminal de origen.
 */
export async function demoTrip(): Promise<DemoTrip> {
  const db = bcbDb();

  const previos = await db.travelCard.findMany({
    where: { number: MARKER },
    select: { id: true, tripId: true },
  });
  if (previos.length) {
    const cardIds = previos.map((c) => c.id);
    const tripIds = previos.map((c) => c.tripId);
    await db.travelCardStatusLog.deleteMany({ where: { travelCardId: { in: cardIds } } });
    await db.travelCard.deleteMany({ where: { id: { in: cardIds } } });
    await db.tripDispatch.deleteMany({ where: { tripId: { in: tripIds } } });
    await db.trip.deleteMany({ where: { id: { in: tripIds } } });
  }

  const [bus, operador, ruta] = await Promise.all([
    db.bus.findUniqueOrThrow({ where: { id: DEMO.busId } }),
    db.operator.findUniqueOrThrow({ where: { id: DEMO.operadorId } }),
    db.route.findUniqueOrThrow({ where: { id: catalog.routeId } }),
  ]);

  // Salida hace un rato, no en el futuro: el polling de geocercas solo mira los
  // últimos 35 minutos, así que un cruce de una corrida que "sale después" nunca
  // caería dentro de la ventana de consulta y la demostración no mostraría nada.
  // Con la salida ~20 min atrás, el despacho (dentro de −45/+60) y la llegada
  // caen los dos en la ventana. El desfase aleatorio da unicidad: Trip tiene
  // @@unique([routeId, departure]).
  const departure = new Date(Date.now() - 20 * 60_000 - Math.floor(Math.random() * 300_000));
  const tripId = randomUUID();
  const cardId = randomUUID();

  await db.trip.create({
    data: {
      id: tripId,
      departure,
      status: TripStatus.DISPATCHED,
      routeId: catalog.routeId,
      dispatchedAt: new Date(),
      tripDispatch: { create: { busId: DEMO.busId, operatorId: DEMO.operadorId } },
    },
  });
  await db.travelCard.create({
    data: { id: cardId, number: MARKER, status: TravelCardStatus.OPEN, departure, tripId },
  });

  await db.$transaction([
    db.bus.update({ where: { id: DEMO.busId }, data: { status: BusStatus.ACTIVE, stationId: catalog.origenId } }),
    db.operator.update({
      where: { id: DEMO.operadorId },
      data: { tripStatus: OperatorTripStatus.AVAILABLE, stationId: catalog.origenId },
    }),
  ]);

  return {
    travelCardId: cardId,
    tripId,
    busId: DEMO.busId,
    operadorId: DEMO.operadorId,
    economicNumber: bus.economicNumber,
    operatorKey: operador.key,
    routeNumber: ruta.number,
    routeName: ruta.name,
    origenId: catalog.origenId,
    destinoId: catalog.destinoId,
    departure: departure.toISOString(),
  };
}

