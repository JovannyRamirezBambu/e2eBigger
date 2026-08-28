/**
 * Siembra los escenarios de CU04/CU05 en la BD de BCB.
 *
 * Idempotente: borra por LLAVE DE NEGOCIO (prefijo `E2E-`) y no por id, porque
 * una corrida anterior pudo dejar filas con otro id pero el mismo `key`/`email`/
 * `economicNumber` único, y el create chocaría con P2002.
 */
import { BusStatus, BusType, CollectionType, OperatorTripStatus, StationType, TravelCardStatus, TripStatus } from '@bcb/prisma-enums';
import { bcbDb } from '@harness/db';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { allScenarios, catalog, type Scenario } from './scenarios';

const E2E = { startsWith: 'E2E-' } as const;

async function wipe(): Promise<void> {
  const db = bcbDb();
  const routes = await db.route.findMany({ where: { number: E2E }, select: { id: true } });
  const routeIds = routes.map((r) => r.id);
  const trips = await db.trip.findMany({
    where: { OR: [{ routeId: { in: routeIds } }, { id: { startsWith: 'e2e' } }] },
    select: { id: true },
  });
  const tripIds = trips.map((t) => t.id);
  const cards = await db.travelCard.findMany({
    where: { OR: [{ tripId: { in: tripIds } }, { number: E2E }] },
    select: { id: true },
  });
  const cardIds = cards.map((c) => c.id);

  // Orden inverso a las FKs. Bus antes que Operator: Bus.operatorId → Operator.
  await db.travelCardStatusLog.deleteMany({ where: { travelCardId: { in: cardIds } } });
  // Hijas del corte de depuración (telemetría T12 y bitácora de sync con InRoute)
  await db.tomTomTripData.deleteMany({ where: { travelCardId: { in: cardIds } } });
  await db.travelCardTomTomSync.deleteMany({ where: { travelCardId: { in: cardIds } } });
  await db.travelCard.deleteMany({ where: { id: { in: cardIds } } });
  await db.tripDispatch.deleteMany({ where: { tripId: { in: tripIds } } });
  await db.trip.deleteMany({ where: { id: { in: tripIds } } });
  await db.bus.deleteMany({ where: { economicNumber: E2E } });
  await db.operator.deleteMany({ where: { key: E2E } });
  await db.route.deleteMany({ where: { id: { in: routeIds } } });
  await db.station.deleteMany({ where: { number: E2E } });
  await db.service.deleteMany({ where: { key: E2E } });
  await db.company.deleteMany({ where: { key: 'E2E' } });
  await db.admin.deleteMany({ where: { key: E2E } });
}

async function seedCatalog(): Promise<void> {
  const db = bcbDb();
  // State y AdminsDepartment vienen del seed oficial del repo, que corre `./e2e up`.
  const state = await db.state.findFirstOrThrow({ where: { name: 'Puebla' } });
  const department = await db.adminsDepartment.findFirstOrThrow({ where: { name: 'Operaciones' } });
  const role = await db.adminDepartmentRole.findFirstOrThrow({ where: { departmentId: department.id } });

  await db.admin.create({
    data: {
      id: catalog.adminId,
      key: 'E2E-ADMIN',
      email: 'e2e-tomtom@estrellaroja.test',
      name: 'E2E TomTom',
      departmentId: department.id,
      roleId: role.id,
    },
  });

  await db.company.create({
    data: {
      id: catalog.companyId,
      key: 'E2E',
      shortName: 'E2E-CO',
      tradeName: 'E2E Co',
      legalName: 'E2E Co SA de CV',
      createdById: catalog.adminId,
      updatedById: catalog.adminId,
    },
  });

  await db.service.create({
    data: {
      id: catalog.serviceId,
      number: '900',
      key: 'E2E-SVC',
      shortName: 'E2E SVC',
      fullName: 'E2E TomTom Service',
      companyId: catalog.companyId,
      createdById: catalog.adminId,
      updatedById: catalog.adminId,
    },
  });

  const stations = [
    { id: catalog.origenId, shortName: 'E2E-ORI', name: 'E2E Origen', number: 'E2E-901', latitude: 19.04, longitude: -98.2 },
    { id: catalog.destinoId, shortName: 'E2E-DST', name: 'E2E Destino', number: 'E2E-902', latitude: 19.43, longitude: -99.13 },
  ];
  for (const s of stations) {
    await db.station.create({
      data: {
        ...s,
        type: StationType.SCALE,
        stateId: state.id,
        createdById: catalog.adminId,
        updatedById: catalog.adminId,
      },
    });
  }

  await db.route.create({
    data: {
      id: catalog.routeId,
      number: 'E2E-R1',
      name: 'E2E Ruta Origen-Destino',
      collectionType: CollectionType.NORMAL,
      priceOneWay: 250,
      travelTimeMinutes: 120,
      distanceKm: 130,
      stayTimeMinutes: 10,
      originId: catalog.origenId,
      destinationId: catalog.destinoId,
      serviceId: catalog.serviceId,
      createdById: catalog.adminId,
      updatedById: catalog.adminId,
    },
  });
}

async function seedScenario(s: Scenario): Promise<void> {
  const db = bcbDb();
  await db.bus.create({
    data: {
      id: s.busId,
      economicNumber: `E2E-BUS-${s.n}`,
      serialNumber: `E2ESN${s.n}`,
      tagNumber: `E2ETAG${s.n}`,
      plates: `E2E-${s.n}`,
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
    },
  });

  await db.operator.create({
    data: {
      id: s.operadorId,
      key: `E2E-OP-${s.n}`,
      name: `E2E Operador ${s.n}`,
      type: 'OPERADOR',
      activeDays: 10,
      hireDate: new Date('2024-01-01'),
      status: 'ACTIVO',
      tripStatus: OperatorTripStatus.AVAILABLE,
      serviceId: catalog.serviceId,
      stationId: catalog.origenId,
    },
  });

  // departure distinta por escenario: Trip tiene @@unique([routeId, departure]).
  const departure = new Date(Date.now() + 3_600_000 + s.n * 60_000);

  await db.trip.create({
    data: {
      id: s.tripId,
      departure,
      status: s.tripStatus,
      routeId: catalog.routeId,
      // dispatchedAt lleno en todo lo que operación ya despachó — es justo la
      // razón por la que la idempotencia de T10 no puede colgarse de ese campo.
      dispatchedAt: s.tripStatus === TripStatus.OPEN ? null : new Date(),
      tripDispatch: { create: { busId: s.busId, operatorId: s.operadorId } },
    },
  });

  await db.travelCard.create({
    data: {
      id: s.cardId,
      number: `E2E-${s.n}`,
      status: s.cardStatus,
      departure,
      tripId: s.tripId,
      confirmedAt: s.cardStatus === TravelCardStatus.CONFIRMED ? new Date() : null,
    },
  });
}

export async function seed(): Promise<void> {
  await wipe();
  await seedCatalog();
  // Línea base limpia: los venenos de corridas anteriores (trips borrados por el
  // cleanup) no deben contar contra el caso dlq-vacia de ESTA corrida.
  const { purgeStream } = await import('@harness/nats');
  if (await purgeStream('TOMTOM_GEOCERCAS_DLQ_STREAM')) {
    console.log('DLQ purgada (línea base limpia)');
  }

  // La BD del SATÉLITE también se limpia: el wipe borra las TravelCards de BCB,
  // pero los TomTomTrip huérfanos del satélite siguen ahí y el sync T12 acabaría
  // empujando telemetría de tarjetas ya inexistentes (404 → veneno en la DLQ que
  // no es de esta corrida). Las equivalencias SÍ se conservan: el simulador usa
  // ids deterministas, así que siguen siendo válidas entre corridas y reinicios.
  try {
    execSync(
      `docker exec biger_estrellaroja_tomtom-db-1 psql -U postgres -d biger_tomtom -c 'TRUNCATE "TomTomTrip" CASCADE;'`,
      { stdio: 'pipe' },
    );
    console.log('BD del satélite limpia (TomTomTrip y sus hijas)');
  } catch {
    console.warn('aviso: no se pudo limpiar la BD del satélite (¿contenedor abajo?) — el sync T12 puede envenenar la DLQ con corridas viejas');
  }

  for (const s of allScenarios) {
    await seedScenario(s);
    console.log(`  ${String(s.n).padEnd(3)} trip=${s.tripId} card=${s.cardId}`);
  }
  console.log(`\n${allScenarios.length} escenarios sembrados`);
}

/**
 * Crea un viaje EFÍMERO, con id nuevo, para un caso de cadena.
 *
 * Por qué no se reusa un viaje fijo: adapter-tomtom deriva el `Nats-Msg-Id` del id
 * del viaje (`despacho:<tripId>`) y **no incluye el timestamp**, así que con un id
 * fijo dos corridas seguidas siempre caen en la ventana de dedup de 2 min de
 * JetStream y la segunda no publica nada. Con un viaje nuevo por corrida el msgId
 * es único y la suite se puede correr las veces que quieras, sin esperas.
 *
 * (Randomizar la hora enviada NO alcanzaba: no participa en la llave de dedup.
 * Sirve para otra cosa — verificar que el valor llegó en ESTA pasada.)
 *
 * Reusa el bus y el operador del escenario, y los deja en su estado inicial.
 * Los viajes efímeros de corridas anteriores se borran acá mismo, así no se
 * acumulan; y un reseed los barre igual porque cuelgan de la ruta E2E.
 */
export async function createChainTrip(s: Scenario): Promise<{ tripId: string; cardId: string }> {
  const db = bcbDb();
  const marker = `E2E-CHAIN-${s.n}`;

  const previos = await db.travelCard.findMany({ where: { number: marker }, select: { id: true, tripId: true } });
  if (previos.length) {
    const cardIds = previos.map((c) => c.id);
    const tripIds = previos.map((c) => c.tripId);
    await db.travelCardStatusLog.deleteMany({ where: { travelCardId: { in: cardIds } } });
    // Hijas nuevas del corte de depuración: telemetría T12 y bitácora de sync.
    await db.tomTomTripData.deleteMany({ where: { travelCardId: { in: cardIds } } });
    await db.travelCardTomTomSync.deleteMany({ where: { travelCardId: { in: cardIds } } });
    await db.travelCard.deleteMany({ where: { id: { in: cardIds } } });
    await db.tripDispatch.deleteMany({ where: { tripId: { in: tripIds } } });
    await db.trip.deleteMany({ where: { id: { in: tripIds } } });
  }

  // departure única: Trip tiene @@unique([routeId, departure]).
  const departure = new Date(Date.now() + 7_200_000 + s.n * 60_000 + Math.floor(Math.random() * 3_600_000));
  const tripId = randomUUID();
  const cardId = randomUUID();

  await db.trip.create({
    data: {
      id: tripId,
      departure,
      status: TripStatus.DISPATCHED,
      routeId: catalog.routeId,
      dispatchedAt: new Date(),
      tripDispatch: { create: { busId: s.busId, operatorId: s.operadorId } },
    },
  });
  await db.travelCard.create({
    data: { id: cardId, number: marker, status: TravelCardStatus.OPEN, departure, tripId },
  });

  await db.$transaction([
    db.bus.update({ where: { id: s.busId }, data: { status: BusStatus.ACTIVE, stationId: catalog.origenId } }),
    db.operator.update({
      where: { id: s.operadorId },
      data: { tripStatus: OperatorTripStatus.AVAILABLE, stationId: catalog.origenId },
    }),
  ]);

  return { tripId, cardId };
}
