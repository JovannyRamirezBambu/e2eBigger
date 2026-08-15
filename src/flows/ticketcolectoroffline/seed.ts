/**
 * Siembra el contexto que el `/sync` de BCB exige antes de aceptar un lote.
 *
 * El sync no recibe al taquillero en el payload: lo resuelve del token y con eso
 * busca su caja activa y su turno (`resolveAdvisorContext`). Si falta cualquiera de
 * los dos, responde 404 y el lote se queda en la tablet. Así que el seed tiene que
 * dejar en pie una cadena completa: Admin → Company → Service → Estaciones → Ruta →
 * Corrida, y Taquillero → Caja activa → Turnos.
 *
 * El número de estación NO es decorativo: `reserveTicketNumbers` lo mete en el folio
 * y rechaza cualquier cosa que no sea numérica de ≤4 dígitos (422). Por eso la
 * estación de la caja usa `9971` y no un `E2E-…` como en tomtom.
 *
 * Idempotente: borra por LLAVE DE NEGOCIO (nuestros ids y nuestras claves únicas),
 * nunca con un deleteMany() a secas — esta base tiene datos de pruebas manuales del
 * equipo que no hay que tocar.
 */
import {
  AdvisorUserType,
  CashRegisterDevice,
  CashRegisterShiftStatus,
  CashRegisterShiftType,
  CashRegisterStatus,
  CollectionType,
  Shift,
  StationType,
  TripStatus,
} from '@bcb/prisma-enums';
import { bcbDb } from '@harness/db';
import { catalog, TCO_PREFIX } from './scenarios';

const ADVISORS = [catalog.advisorId, catalog.advisorAjenoId];
const SHIFTS = [catalog.turnoAbiertoId, catalog.turnoCerradoId, catalog.turnoAjenoId];

async function wipe(): Promise<void> {
  const db = bcbDb();

  // Las órdenes se borran por ADVISOR, no por el prefijo del folio de tablet: una
  // corrida anterior pudo dejar una orden cuyo OrderItemOffline ya no está (o que
  // nunca llegó a crearse porque el lote falló a media transacción), y esa quedaría
  // huérfana contando en los conteos del caso siguiente.
  const orders = await db.order.findMany({
    where: { advisorId: { in: ADVISORS } },
    select: { id: true },
  });

  // SyncOfflineRequestOrder cuelga de las dos puntas con Cascade, así que basta con
  // borrar Order y SyncOfflineRequest. OrderItem, OrderItemOffline, Passenger y los
  // historiales también son Cascade desde Order.
  await db.syncOfflineRequest.deleteMany({ where: { advisorId: { in: ADVISORS } } });
  await db.cashCollection.deleteMany({ where: { shiftId: { in: SHIFTS } } });
  if (orders.length) {
    await db.order.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } });
  }
  await db.advisorSession.deleteMany({ where: { advisorUserId: { in: ADVISORS } } });

  // Catálogo, en orden inverso a las FKs. Se borra por id Y por clave única: una
  // corrida vieja pudo dejar la fila con otro id pero el mismo `key`/`number`, y
  // entonces el create de abajo chocaría con P2002.
  await db.cashRegisterShift.deleteMany({ where: { OR: [{ id: { in: SHIFTS } }, { advisorUserId: { in: ADVISORS } }] } });
  await db.cashRegister.deleteMany({
    where: { OR: [{ id: catalog.cashRegisterId }, { name: { startsWith: TCO_PREFIX } }] },
  });
  await db.advisorUser.deleteMany({ where: { OR: [{ id: { in: ADVISORS } }, { key: { startsWith: TCO_PREFIX } }] } });
  await db.trip.deleteMany({ where: { id: catalog.tripId } });
  await db.route.deleteMany({ where: { OR: [{ id: catalog.routeId }, { number: { startsWith: TCO_PREFIX } }] } });
  await db.station.deleteMany({
    where: { OR: [{ id: { in: [catalog.origenId, catalog.destinoId] } }, { number: { in: [catalog.stationNumber, catalog.destinoNumber] } }] },
  });
  await db.service.deleteMany({ where: { OR: [{ id: catalog.serviceId }, { key: { startsWith: TCO_PREFIX } }] } });
  await db.company.deleteMany({ where: { OR: [{ id: catalog.companyId }, { key: 'E2ETCO' }] } });
  await db.passengerType.deleteMany({
    where: { OR: [{ id: catalog.passengerTypeId }, { key: { startsWith: TCO_PREFIX } }] },
  });
  await db.file.deleteMany({ where: { id: catalog.fileId } });
  await db.admin.deleteMany({ where: { OR: [{ id: catalog.adminId }, { key: { startsWith: TCO_PREFIX } }] } });
}

async function seedCatalog(): Promise<void> {
  const db = bcbDb();
  // State y AdminsDepartment salen del seed oficial del repo, no de acá.
  const state = await db.state.findFirstOrThrow({ where: { name: 'Puebla' } });
  const department = await db.adminsDepartment.findFirstOrThrow({ where: { name: 'Operaciones' } });
  const role = await db.adminDepartmentRole.findFirstOrThrow({ where: { departmentId: department.id } });

  await db.admin.create({
    data: {
      id: catalog.adminId,
      key: `${TCO_PREFIX}ADMIN`,
      email: 'e2e-tcoffline@estrellaroja.test',
      name: 'E2E TicketColectorOffline',
      departmentId: department.id,
      roleId: role.id,
    },
  });

  await db.company.create({
    data: {
      id: catalog.companyId,
      key: 'E2ETCO',
      shortName: 'E2E-TCO',
      tradeName: 'E2E TCO',
      legalName: 'E2E TCO SA de CV',
      createdById: catalog.adminId,
      updatedById: catalog.adminId,
    },
  });

  await db.service.create({
    data: {
      id: catalog.serviceId,
      number: '971',
      key: `${TCO_PREFIX}SVC`,
      shortName: 'E2E TCO SVC',
      fullName: 'E2E TicketColectorOffline Service',
      companyId: catalog.companyId,
      createdById: catalog.adminId,
      updatedById: catalog.adminId,
    },
  });

  const stations = [
    { id: catalog.origenId, shortName: 'E2E-TCO-ORI', name: 'E2E TCO Origen', number: catalog.stationNumber, latitude: 19.04, longitude: -98.2 },
    { id: catalog.destinoId, shortName: 'E2E-TCO-DST', name: 'E2E TCO Destino', number: catalog.destinoNumber, latitude: 19.43, longitude: -99.13 },
  ];
  for (const s of stations) {
    await db.station.create({
      data: {
        ...s,
        type: StationType.SALE,
        stateId: state.id,
        createdById: catalog.adminId,
        updatedById: catalog.adminId,
      },
    });
  }

  await db.route.create({
    data: {
      id: catalog.routeId,
      number: `${TCO_PREFIX}R1`,
      name: 'E2E TCO Ruta Origen-Destino',
      collectionType: CollectionType.NORMAL,
      priceOneWay: 150,
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

  // Corrida con clave legacy (no uuid), para el caso que comprueba que el tripId
  // del boleto queda guardado en OrderItemOffline.
  await db.trip.create({
    data: {
      id: catalog.tripId,
      departure: new Date(Date.now() - 3 * 60 * 60 * 1000),
      priceOneWay: 150,
      priceRound: 280,
      status: TripStatus.CLOSED,
      routeId: catalog.routeId,
    },
  });

  // PassengerType exige un File (fileId es @unique y obligatorio).
  await db.file.create({
    data: {
      id: catalog.fileId,
      name: 'e2e-tco-icono.png',
      path: 'e2e/tco/icono.png',
      url: 'https://example.invalid/e2e/tco/icono.png',
      mimetype: 'image/png',
      size: 1,
    },
  });

  await db.passengerType.create({
    data: {
      id: catalog.passengerTypeId,
      key: `${TCO_PREFIX}ADULTO`,
      name: 'E2E TCO Adulto',
      fileId: catalog.fileId,
      createdById: catalog.adminId,
      updatedById: catalog.adminId,
    },
  });
}

async function seedTaquilleros(): Promise<void> {
  const db = bcbDb();

  const advisores = [
    { id: catalog.advisorId, key: `${TCO_PREFIX}TAQ1`, name: 'E2E TCO Taquillero' },
    { id: catalog.advisorAjenoId, key: `${TCO_PREFIX}TAQ2`, name: 'E2E TCO Taquillero Ajeno' },
  ];
  for (const a of advisores) {
    await db.advisorUser.create({
      data: {
        ...a,
        shift: Shift.MORNING,
        type: AdvisorUserType.A,
        stationId: catalog.origenId,
        createdById: catalog.adminId,
        updatedById: catalog.adminId,
      },
    });
  }

  // La caja debe tener al taquillero como ACTIVO: es lo que busca
  // resolveAdvisorContext (`activeAdvisorUserId`), y de ella sale el número de
  // estación con el que se generan los folios.
  await db.cashRegister.create({
    data: {
      id: catalog.cashRegisterId,
      name: `${TCO_PREFIX}CAJA`,
      number: '1',
      deviceIdentifier: `${TCO_PREFIX}TABLET-1`,
      device: CashRegisterDevice.TICKET_COLLECTOR_OFFLINE,
      status: CashRegisterStatus.ACTIVE,
      stationId: catalog.origenId,
      activeAdvisorUserId: catalog.advisorId,
      createdById: catalog.adminId,
      updatedById: catalog.adminId,
    },
  });

  const turnos = [
    // El único OPEN del taquillero: es el que resuelve el sync cuando el lote no
    // trae shiftId.
    { id: catalog.turnoAbiertoId, advisorUserId: catalog.advisorId, status: CashRegisterShiftStatus.OPEN, shiftNumber: 1 },
    // Ya conciliado. `CashRegisterShiftStatus` no tiene CLOSED: "cerrado" es
    // RECONCILED. Sirve para el caso del turno explícito, que debe aceptar un
    // turno pasado (un lote offline es, por definición, pasado).
    { id: catalog.turnoCerradoId, advisorUserId: catalog.advisorId, status: CashRegisterShiftStatus.RECONCILED, shiftNumber: 2 },
    // De OTRO taquillero: colgar un lote de acá descuadraría dos cortes.
    { id: catalog.turnoAjenoId, advisorUserId: catalog.advisorAjenoId, status: CashRegisterShiftStatus.OPEN, shiftNumber: 1 },
  ];
  for (const t of turnos) {
    await db.cashRegisterShift.create({
      data: {
        ...t,
        shiftType: CashRegisterShiftType.TICKET_OFFICE_OFFLINE,
        stationId: catalog.origenId,
        shiftStart: new Date(Date.now() - 8 * 60 * 60 * 1000),
        createdById: catalog.adminId,
        updatedById: catalog.adminId,
      },
    });
  }
}

export async function seed(): Promise<void> {
  await wipe();
  await seedCatalog();
  await seedTaquilleros();

  console.log(`  taquillero      ${catalog.advisorId}`);
  console.log(`  caja activa     ${catalog.cashRegisterId} (estación ${catalog.stationNumber})`);
  console.log(`  turno abierto   ${catalog.turnoAbiertoId}`);
  console.log(`  turno cerrado   ${catalog.turnoCerradoId} (RECONCILED)`);
  console.log(`  turno ajeno     ${catalog.turnoAjenoId} (de ${catalog.advisorAjenoId})`);
  console.log(`  corrida         ${catalog.tripId}`);
  console.log('\ncontexto listo (los lotes los crean los casos, con sync_id nuevo por corrida)');
}
