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
import { BusStatus, BusType, CollectionType, OperatorTripStatus, TravelCardStatus, TripStatus } from '@bcb/prisma-enums';
import { bcbDb } from '@harness/db';
import { randomUUID } from 'crypto';
import { catalog, scenarios } from './scenarios';

/** Escenario del que cuelgan bus, operador y ruta de la demostración. */
const DEMO = scenarios.CADENA_T10;
const MARKER = 'E2E-DEMO-TOMTOM';

/**
 * Claves que el payload de la cadena lleva hasta InRoute (número económico del
 * bus, clave del operador, número de ruta). Contra el InRoute SIMULADO da igual
 * — el panel las da de alta en su catálogo —, pero contra el SANDBOX REAL de
 * Adsum tienen que existir allá: el panel pasa las del sandbox y acá se crean
 * registros BCB dedicados que las llevan, sin tocar los del escenario 5 (que
 * usa la suite de pruebas).
 */
export type DemoRefs = {
  economicNumber: string;
  operatorKey: string;
  routeNumber: string;
  routeName?: string;
  /** Nombre del grupo tal como existe en InRoute (el satélite resuelve el grupo por este nombre). */
  serviceName?: string;
};

const DEDICADOS = {
  busId: 'e2e00003-0000-4000-8000-0000000de301',
  operadorId: 'e2e00004-0000-4000-8000-0000000de301',
  routeId: 'e2e00000-0000-4000-8000-0000000de301',
  serviceId: 'e2e00000-0000-4000-8000-0000000de302',
};

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
export async function demoTrip(refs?: DemoRefs): Promise<DemoTrip> {
  const db = bcbDb();

  const previos = await db.travelCard.findMany({
    where: { number: MARKER },
    select: { id: true, tripId: true },
  });
  if (previos.length) {
    const cardIds = previos.map((c) => c.id);
    const tripIds = previos.map((c) => c.tripId);
    await db.travelCardStatusLog.deleteMany({ where: { travelCardId: { in: cardIds } } });
    // Hijas del corte de depuración: telemetría T12 y bitácora de sync.
    await db.tomTomTripData.deleteMany({ where: { travelCardId: { in: cardIds } } });
    await db.travelCardTomTomSync.deleteMany({ where: { travelCardId: { in: cardIds } } });
    await db.travelCard.deleteMany({ where: { id: { in: cardIds } } });
    await db.tripDispatch.deleteMany({ where: { tripId: { in: tripIds } } });
    await db.trip.deleteMany({ where: { id: { in: tripIds } } });
  }

  const ids = refs
    ? { busId: DEDICADOS.busId, operadorId: DEDICADOS.operadorId, routeId: DEDICADOS.routeId }
    : { busId: DEMO.busId, operadorId: DEMO.operadorId, routeId: catalog.routeId };

  if (refs) {
    // El satélite resuelve el grupo InRoute por el NOMBRE del servicio de la
    // corrida; contra el sandbox tiene que coincidir con un grupo real de allá.
    const serviceData = {
      number: '901',
      key: 'E2E-SVC-DEMO',
      shortName: 'DEMO SBX',
      fullName: refs.serviceName ?? 'Primera Clase',
      companyId: catalog.companyId,
      createdById: catalog.adminId,
      updatedById: catalog.adminId,
    };
    await db.service.upsert({
      where: { id: DEDICADOS.serviceId },
      update: serviceData,
      create: { id: DEDICADOS.serviceId, ...serviceData },
    });
    const busData = {
      economicNumber: refs.economicNumber,
      serialNumber: 'E2ESNDEMO',
      tagNumber: 'E2ETAGDEMO',
      plates: 'E2E-DEMO',
      brand: 'Volvo',
      model: 2024,
      type: BusType.BUS,
      status: BusStatus.ACTIVE,
      seatCount: 40,
      currentKm: 1000,
      maintenanceKmLimit: 500_000,
      maintenanceAlertKm: 480_000,
      stationId: catalog.origenId,
      serviceId: catalog.serviceId,
      createdById: catalog.adminId,
      updatedById: catalog.adminId,
    };
    const operadorData = {
      key: refs.operatorKey,
      name: 'E2E Operador Demo (sandbox)',
      type: 'OPERADOR',
      activeDays: 10,
      hireDate: new Date('2024-01-01'),
      status: 'ACTIVO',
      tripStatus: OperatorTripStatus.AVAILABLE,
      serviceId: catalog.serviceId,
      stationId: catalog.origenId,
    };
    const rutaData = {
      number: refs.routeNumber,
      name: refs.routeName ?? `Ruta sandbox ${refs.routeNumber}`,
      collectionType: CollectionType.NORMAL,
      priceOneWay: 250,
      travelTimeMinutes: 120,
      distanceKm: 130,
      stayTimeMinutes: 10,
      originId: catalog.origenId,
      destinationId: catalog.destinoId,
      serviceId: DEDICADOS.serviceId,
      createdById: catalog.adminId,
      updatedById: catalog.adminId,
    };
    await db.bus.upsert({ where: { id: ids.busId }, update: busData, create: { id: ids.busId, ...busData } });
    await db.operator.upsert({
      where: { id: ids.operadorId },
      update: operadorData,
      create: { id: ids.operadorId, ...operadorData },
    });
    await db.route.upsert({ where: { id: ids.routeId }, update: rutaData, create: { id: ids.routeId, ...rutaData } });
  }

  const [bus, operador, ruta] = await Promise.all([
    db.bus.findUniqueOrThrow({ where: { id: ids.busId } }),
    db.operator.findUniqueOrThrow({ where: { id: ids.operadorId } }),
    db.route.findUniqueOrThrow({ where: { id: ids.routeId } }),
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
      routeId: ids.routeId,
      dispatchedAt: new Date(),
      tripDispatch: { create: { busId: ids.busId, operatorId: ids.operadorId } },
    },
  });
  await db.travelCard.create({
    data: { id: cardId, number: MARKER, status: TravelCardStatus.OPEN, departure, tripId },
  });

  await db.$transaction([
    db.bus.update({ where: { id: ids.busId }, data: { status: BusStatus.ACTIVE, stationId: catalog.origenId } }),
    db.operator.update({
      where: { id: ids.operadorId },
      data: { tripStatus: OperatorTripStatus.AVAILABLE, stationId: catalog.origenId },
    }),
  ]);

  return {
    travelCardId: cardId,
    tripId,
    busId: ids.busId,
    operadorId: ids.operadorId,
    economicNumber: bus.economicNumber,
    operatorKey: operador.key,
    routeNumber: ruta.number,
    routeName: ruta.name,
    origenId: catalog.origenId,
    destinoId: catalog.destinoId,
    departure: departure.toISOString(),
  };
}

