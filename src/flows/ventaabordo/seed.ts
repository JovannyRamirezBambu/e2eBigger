/**
 * Prepara los datos de Venta a Bordo.
 *
 * Para WS1/WS2/SM04 el "seed" es sobre todo **limpieza**: WS1 crea la
 * `TarjetaViaje` en el satélite y WS2 crea la `VentaABordo`, así que esos datos
 * los generan las pruebas, no el seed. Lo que hace falta es borrar lo que dejaron
 * corridas anteriores, y solo eso: la base del satélite tiene datos de pruebas
 * manuales del equipo que no hay que tocar.
 *
 * La Consulta de tarjetas de viaje por operador es la excepción: ahí BCB es la
 * fuente (no el satélite), y `AbordajeTripsService.findAllByOperator` filtra por
 * el día de HOY, así que sí hace falta un catálogo completo sembrado de antemano
 * (ver `consulta-scenarios.ts`).
 */
import { BusStatus, BusType, CashRegisterDevice, CashRegisterStatus, CollectionType, OperatorTripStatus, StationType, TravelCardStatus, TripStatus } from '@bcb/prisma-enums';
import { bcbDb, vaDb } from '@harness/db';
import { allVaScenarios } from './scenarios';
import { CONSULTA_PREFIX, consulta, consultaCatalog } from './consulta-scenarios';

async function wipeConsulta(): Promise<void> {
  const db = bcbDb();
  const routes = await db.route.findMany({ where: { number: { startsWith: CONSULTA_PREFIX } }, select: { id: true } });
  const routeIds = routes.map((r) => r.id);
  const trips = await db.trip.findMany({ where: { routeId: { in: routeIds } }, select: { id: true } });
  const tripIds = trips.map((t) => t.id);
  const cards = await db.travelCard.findMany({ where: { tripId: { in: tripIds } }, select: { id: true } });
  const cardIds = cards.map((c) => c.id);

  // Orden inverso a las FKs, mismo criterio que el wipe de tomtom.
  await db.travelCardStatusLog.deleteMany({ where: { travelCardId: { in: cardIds } } });
  await db.travelCard.deleteMany({ where: { id: { in: cardIds } } });
  await db.trip.deleteMany({ where: { id: { in: tripIds } } });
  await db.bus.deleteMany({ where: { economicNumber: { startsWith: CONSULTA_PREFIX } } });
  await db.operator.deleteMany({ where: { key: { startsWith: CONSULTA_PREFIX } } });
  await db.cashRegister.deleteMany({ where: { deviceIdentifier: { startsWith: CONSULTA_PREFIX } } });
  await db.route.deleteMany({ where: { id: { in: routeIds } } });
  await db.station.deleteMany({ where: { number: { startsWith: CONSULTA_PREFIX } } });
  await db.service.deleteMany({ where: { key: { startsWith: CONSULTA_PREFIX } } });
  await db.company.deleteMany({ where: { key: { startsWith: CONSULTA_PREFIX } } });
  await db.admin.deleteMany({ where: { key: { startsWith: CONSULTA_PREFIX } } });
}

async function seedConsulta(): Promise<void> {
  const db = bcbDb();
  // State y AdminsDepartment vienen del seed oficial del repo, que corre `./e2e up`.
  const state = await db.state.findFirstOrThrow({ where: { name: 'Puebla' } });
  const department = await db.adminsDepartment.findFirstOrThrow({ where: { name: 'Operaciones' } });
  const role = await db.adminDepartmentRole.findFirstOrThrow({ where: { departmentId: department.id } });

  await db.admin.create({
    data: {
      id: consultaCatalog.adminId,
      key: `${CONSULTA_PREFIX}ADMIN`,
      email: 'e2e-vaco@estrellaroja.test',
      name: 'E2E VACO',
      departmentId: department.id,
      roleId: role.id,
    },
  });

  await db.company.create({
    data: {
      id: consultaCatalog.companyId,
      key: `${CONSULTA_PREFIX}CO`,
      shortName: consulta.companyShortName,
      tradeName: consulta.companyTradeName,
      legalName: 'E2E VACO Terminal Comercial SA de CV',
      createdById: consultaCatalog.adminId,
      updatedById: consultaCatalog.adminId,
    },
  });

  await db.service.create({
    data: {
      id: consultaCatalog.serviceId,
      number: '944',
      key: `${CONSULTA_PREFIX}SVC`,
      shortName: consulta.serviceShortName,
      fullName: consulta.serviceFullName,
      companyId: consultaCatalog.companyId,
      createdById: consultaCatalog.adminId,
      updatedById: consultaCatalog.adminId,
    },
  });

  const stations = [
    { id: consultaCatalog.origenId, shortName: consulta.origenShortName, name: 'E2E VACO Origen', number: `${CONSULTA_PREFIX}901` },
    { id: consultaCatalog.destinoId, shortName: consulta.destinoShortName, name: 'E2E VACO Destino', number: `${CONSULTA_PREFIX}902` },
  ];
  for (const s of stations) {
    await db.station.create({
      data: {
        ...s,
        latitude: 19.04,
        longitude: -98.2,
        type: StationType.SCALE,
        stateId: state.id,
        createdById: consultaCatalog.adminId,
        updatedById: consultaCatalog.adminId,
      },
    });
  }

  await db.route.create({
    data: {
      id: consultaCatalog.routeId,
      number: consulta.routeNumber,
      name: consulta.routeName,
      collectionType: CollectionType.NORMAL,
      priceOneWay: 250,
      travelTimeMinutes: 120,
      distanceKm: 130,
      stayTimeMinutes: 10,
      originId: consultaCatalog.origenId,
      destinationId: consultaCatalog.destinoId,
      serviceId: consultaCatalog.serviceId,
      createdById: consultaCatalog.adminId,
      updatedById: consultaCatalog.adminId,
    },
  });

  await db.bus.create({
    data: {
      id: consultaCatalog.busId,
      economicNumber: consulta.busEconomicNumber,
      serialNumber: `${CONSULTA_PREFIX}SN1`,
      tagNumber: `${CONSULTA_PREFIX}TAG1`,
      plates: `${CONSULTA_PREFIX}PLT1`,
      brand: 'Volvo',
      model: 2024,
      type: BusType.BUS,
      status: BusStatus.ACTIVE,
      seatCount: consulta.busCapacidad,
      currentKm: 1000,
      maintenanceKmLimit: 500_000,
      maintenanceAlertKm: 480_000,
      stationId: consultaCatalog.origenId,
      serviceId: consultaCatalog.serviceId,
      createdById: consultaCatalog.adminId,
      updatedById: consultaCatalog.adminId,
    },
  });

  await db.operator.create({
    data: {
      id: consultaCatalog.operadorConId,
      key: consulta.operadorKey,
      name: consulta.operadorNombre,
      type: 'OPERADOR',
      activeDays: 10,
      hireDate: new Date('2024-01-01'),
      status: 'ACTIVO',
      tripStatus: OperatorTripStatus.AVAILABLE,
      serviceId: consultaCatalog.serviceId,
      stationId: consultaCatalog.origenId,
    },
  });
  // Existe en BCB pero no tendrá NINGUNA corrida hoy — es el escenario AMARILLO.
  await db.operator.create({
    data: {
      id: consultaCatalog.operadorSinId,
      key: consulta.operadorSinCorridasKey,
      name: 'E2E VACO Operador Sin Corridas',
      type: 'OPERADOR',
      activeDays: 10,
      hireDate: new Date('2024-01-01'),
      status: 'ACTIVO',
      tripStatus: OperatorTripStatus.AVAILABLE,
      serviceId: consultaCatalog.serviceId,
      stationId: consultaCatalog.origenId,
    },
  });

  await db.cashRegister.create({
    data: {
      id: consultaCatalog.cashRegisterId,
      name: `${CONSULTA_PREFIX}CAJA`,
      number: '1',
      deviceIdentifier: consulta.caja,
      device: CashRegisterDevice.TICKET_COLLECTOR_TPV,
      status: CashRegisterStatus.ACTIVE,
      stationId: consultaCatalog.origenId,
      createdById: consultaCatalog.adminId,
      updatedById: consultaCatalog.adminId,
    },
  });

  // Corrida despachada CON tarjeta de viaje — folioTarjeta/estadoTarjetaViaje deben
  // venir llenos. COLLECTED (→ "RECAUDADA") y no CONFIRMED a propósito: es un valor
  // que NO existe en el vocabulario de estadoCorrida, así que si alguna vez se usa
  // el mapa equivocado para traducir esto, el passthrough de valor desconocido lo
  // delata en vez de pasar la prueba por casualidad.
  const departureDespachada = new Date(Date.now() + 30 * 60_000);
  await db.trip.create({
    data: {
      id: consultaCatalog.tripDespachadaId,
      departure: departureDespachada,
      status: TripStatus.DISPATCHED,
      dispatchedAt: new Date(),
      routeId: consultaCatalog.routeId,
      operatorId: consultaCatalog.operadorConId,
      busId: consultaCatalog.busId,
    },
  });
  await db.travelCard.create({
    data: {
      id: consultaCatalog.cardId,
      number: '1',
      key: consulta.cardKey,
      status: TravelCardStatus.COLLECTED,
      departure: departureDespachada,
      tripId: consultaCatalog.tripDespachadaId,
      confirmedAt: new Date(),
      collectedAt: new Date(),
    },
  });

  // Corrida abierta SIN tarjeta de viaje — folioTarjeta/estadoTarjetaViaje deben
  // venir null. Mismo operador, misma ruta, mismo autobús: la única variable es
  // "tiene tarjeta o no".
  await db.trip.create({
    data: {
      id: consultaCatalog.tripAbiertaId,
      departure: new Date(Date.now() + 45 * 60_000),
      status: TripStatus.OPEN,
      routeId: consultaCatalog.routeId,
      operatorId: consultaCatalog.operadorConId,
      busId: consultaCatalog.busId,
    },
  });
}

export async function seed(): Promise<void> {
  const va = vaDb();
  const ids = allVaScenarios.map((s) => BigInt(s.tarjetaViajeId));
  const ventaIds = allVaScenarios.map((s) => BigInt(s.ventaId));

  // Satélite: solo lo que tiene NUESTROS ids. Nada de deleteMany() a secas.
  const tarjetas = await va.tarjetaViaje.findMany({
    where: { idTarjetaViaje: { in: ids } },
    select: { id: true },
  });
  const tarjetaIds = tarjetas.map((t) => t.id as string);

  if (tarjetaIds.length) {
    await va.ventaABordoItem.deleteMany({ where: { ventaABordo: { tarjetaViajeId: { in: tarjetaIds } } } });
    await va.ventaABordo.deleteMany({ where: { tarjetaViajeId: { in: tarjetaIds } } });
    await va.tarjetaViajeLog.deleteMany({ where: { tarjetaViajeId: { in: tarjetaIds } } });
    await va.tarjetaViaje.deleteMany({ where: { id: { in: tarjetaIds } } });
  }

  // BCB: las ventas a bordo que llegaron por WS2 en corridas anteriores.
  const bcb = bcbDb();
  const smartmacIds = allVaScenarios.map((s) => s.ventaId);
  const ventas = await bcb.boardingSale.findMany({
    where: { smartmacId: { in: smartmacIds } },
    select: { id: true },
  });
  if (ventas.length) {
    // BoardingSaleItem tiene onDelete: Cascade, así que basta borrar la cabecera.
    await bcb.boardingSale.deleteMany({ where: { id: { in: ventas.map((v) => v.id) } } });
  }

  console.log(
    `  limpiado: ${tarjetaIds.length} tarjeta(s) en el satélite, ${ventas.length} venta(s) en BCB`,
  );
  console.log(`${allVaScenarios.length} escenarios listos (los datos los crean WS1/WS2)`);

  await wipeConsulta();
  await seedConsulta();
  console.log(
    `\nconsulta de tarjetas de viaje: operador ${consulta.operadorKey} con 2 corridas hoy, ` +
      `operador ${consulta.operadorSinCorridasKey} sin corridas, caja ${consulta.caja}`,
  );
}
