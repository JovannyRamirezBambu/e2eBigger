/**
 * Siembra en BCB una venta redonda pagada, para que los reportes de boletos tengan algo
 * que traer en local. Idempotente: reutiliza catálogos y sólo agrega la venta.
 *
 * Por qué hace falta: los seeds oficiales de BCB son catálogos (estados, canales, reglas),
 * no ventas. Sin esto todos los reportes salen en EMPTY — que es el desenlace correcto,
 * pero no sirve para ver un archivo.
 *
 * Ojo con `Order.status`: su default es AWAITING_PAYMENT y los reportes de venta la
 * excluyen a propósito (una venta sin pagar no es una venta). Se crea PAID.
 *
 * La venta se siembra ENLAZADA —corrida, asiento, cajero, tipo de pasajero— y no con lo
 * mínimo para que exista. Casi ninguna columna del reporte sale de `OrderItem`: el mapeo
 * (`libs/tickets-history/src/history-detail-rows.ts`) las resuelve por relación —
 * SERVICIO/ORIGEN/DESTINO/EMPRESA por `tripSeat.trip.route`, CLAVE_CORRIDA por el id de la
 * corrida, NO_ASIENTO por el asiento, CLAVE_CAJERO por `order.Advisor`, TIPO_PASAJERO por
 * `passenger.passengerType`— y cae a 'N/A' cuando la relación falta. Una venta suelta baja
 * un archivo de N/A que no sirve para dos cosas: no delata un mapeo mal cableado (también
 * daría N/A) y no se le puede mostrar a nadie como muestra del formato.
 *
 * Y hay un filtro que sin esto no se puede probar: CLAVE_CORRIDA (`tripKey`, CU-004) se
 * resuelve con la búsqueda de texto de BCB, que la compara contra `tripSeat.trip.id`. Un
 * boleto sin asiento no tiene corrida contra la que comparar, así que ese filtro devuelve
 * EMPTY siempre — y no por un error, sino porque el dato nunca se sembró.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@generated/prisma';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, ssl: false }),
});

/** Fecha de venta: dentro de la ventana de 90 días que retiene BCB. */
const SALE_DATE = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

/** Marca de las ventas de este seed: sirve para reconocer las de corridas anteriores. */
const PAYMENT_REF = 'e2e-ref-1';

/** Clave corta del tipo de pasajero, como la nombran los reportes del legado. */
const CLAVE_ADULTO = 'A';

/** Un id con forma de uuid es una corrida que este seed dejó sin clave de negocio. */
const ES_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Clave con la forma de las de BCB: terminal + hora de salida + tipo + consecutivo.
 *
 * El consecutivo sale de la última clave emitida, no de contar corridas: al re-etiquetar se borra
 * una por cada una que se crea, así que contar devolvería el mismo número y la segunda creación
 * chocaría con el id de la primera.
 */
const PREFIJO_CORRIDA = 'E2EPU0800N';

async function claveDeCorrida() {
  const ultima = await prisma.trip.findFirst({
    where: { id: { startsWith: PREFIJO_CORRIDA } },
    orderBy: { id: 'desc' },
    select: { id: true },
  });
  const consecutivo = ultima
    ? Number(ultima.id.slice(PREFIJO_CORRIDA.length)) + 1
    : 1;
  return `${PREFIJO_CORRIDA}${String(consecutivo).padStart(7, '0')}`;
}

/**
 * Cambia por una clave de negocio el uuid de las corridas que sembraron corridas ANTERIORES de
 * este seed. Sin esto, una base que ya se sembró sigue bajando reportes con un uuid en
 * CLAVE_CORRIDA para siempre, porque la corrida del día se reutiliza.
 *
 * El id es llave foránea de los asientos y no se puede editar, así que se cambia de corrida: la
 * vieja se marca borrada —el índice único de (ruta, salida) es parcial y solo mira las vivas, así
 * que la nueva puede nacer con la misma salida—, se le pasan los asientos y la vieja se borra.
 * Solo toca corridas a las que llegan boletos de ESTE seed; las de otros flujos no se tocan.
 */
async function reetiquetarCorridasViejas() {
  const mios = await prisma.orderItem.findMany({
    where: { order: { providerPaymentId: PAYMENT_REF }, NOT: { tripSeatId: null } },
    select: { tripSeat: { select: { id: true, tripId: true } } },
  });

  const asientosPorCorrida = new Map<string, string[]>();
  for (const { tripSeat } of mios) {
    if (!tripSeat || !ES_UUID.test(tripSeat.tripId)) continue;
    asientosPorCorrida.set(tripSeat.tripId, [
      ...(asientosPorCorrida.get(tripSeat.tripId) ?? []),
      tripSeat.id,
    ]);
  }

  for (const [viejaId, asientos] of asientosPorCorrida) {
    const vieja = await prisma.trip.findUnique({ where: { id: viejaId } });
    if (!vieja) continue;

    await prisma.trip.update({ where: { id: viejaId }, data: { deletedAt: new Date() } });
    const nueva = await prisma.trip.create({
      data: {
        id: await claveDeCorrida(),
        routeId: vieja.routeId, departure: vieja.departure, status: vieja.status,
        priceOneWay: vieja.priceOneWay, priceRound: vieja.priceRound,
      },
    });
    await prisma.tripSeat.updateMany({
      where: { id: { in: asientos } },
      data: { tripId: nueva.id },
    });

    // Solo se borra si no le quedó ningún asiento de otro origen: borrarla arrastraría los suyos.
    if ((await prisma.tripSeat.count({ where: { tripId: viejaId } })) === 0) {
      await prisma.trip.delete({ where: { id: viejaId } });
    }
    console.log(`corrida ${viejaId} → ${nueva.id} (${asientos.length} asientos)`);
  }
}

async function main() {
  // Los catálogos se REUSAN si ya existen. No se buscan por una clave propia: casi todos
  // sus campos son únicos (`Company.shortName`, `Service.fullName`, `Station.number`…), así
  // que insistir en nombres propios choca con lo que dejó el seed oficial o una corrida
  // anterior. Al reporte solo le hace falta una venta coherente, no catálogos suyos.
  const state =
    (await prisma.state.findFirst()) ??
    (await prisma.state.create({ data: { name: 'Puebla' } }));

  const company =
    (await prisma.company.findFirst()) ??
    (await prisma.company.create({
      data: { key: 'E2E', shortName: 'AMPERSA', tradeName: 'Ampersa', legalName: 'Ampersa SA de CV' },
    }));

  const service =
    (await prisma.service.findFirst()) ??
    (await prisma.service.create({
      data: {
        number: 'E2E-1', key: 'E2EDIR', shortName: 'DIRECTO ECONOMICO',
        fullName: 'Directo Económico', companyId: company.id,
      },
    }));

  const existentes = await prisma.station.findMany({ take: 2 });
  const nueva = async (n: number) =>
    prisma.station.create({
      data: {
        shortName: `E2E${n}`, name: `Terminal E2E ${n}`, number: `E2E-${n}`,
        latitude: 19, longitude: -98.2, type: 'SALE', stateId: state.id,
      },
    });
  const origen = existentes[0] ?? (await nueva(1));
  const destino = existentes[1] ?? (await nueva(2));

  const ruta =
    (await prisma.route.findFirst()) ??
    (await prisma.route.create({
      data: {
        number: 'E2E-R1', name: `${origen.shortName}-${destino.shortName}`,
        collectionType: 'NORMAL', priceOneWay: 250, travelTimeMinutes: 120,
        distanceKm: 130, stayTimeMinutes: 10,
        originId: origen.id, destinationId: destino.id, serviceId: service.id,
      },
    }));

  const caja =
    (await prisma.cashRegister.findFirst()) ??
    (await prisma.cashRegister.create({
      data: {
        name: 'Caja E2E', number: 'E2E-1', deviceIdentifier: 'e2e-caja-1',
        device: 'TICKET_OFFICE', stationId: origen.id,
      },
    }));

  const canal = await prisma.salesChannel.findFirst();

  // La corrida sale 2 días DESPUÉS de la venta: DIFERENCIA_HORAS (CU-003) mide la
  // anticipación con que se compró, y una corrida anterior a la venta la daría negativa.
  // La hora se fija (08:00) en vez de heredar la de la venta: así la salida es la MISMA en
  // cada corrida del seed del día y la corrida se reutiliza, en vez de crear una nueva por
  // milisegundo —`Trip` es único por (routeId, departure), pero nunca chocaría—.
  const DEPARTURE = new Date(SALE_DATE);
  DEPARTURE.setDate(DEPARTURE.getDate() + 2);
  DEPARTURE.setHours(8, 0, 0, 0);
  // Ojo con el ID de la corrida: en BCB **no es un uuid**, es la clave de negocio
  // (`CAPUA0300N9364282` = terminal + hora + tipo + consecutivo) y es lo que el reporte entrega
  // como CLAVE_CORRIDA. El default del esquema sí es uuid, así que una corrida sembrada sin id
  // deja el reporte mostrando un uuid donde el cliente espera su clave, y parece un defecto del
  // mapeo cuando es de los datos.
  await reetiquetarCorridasViejas();

  const corrida =
    (await prisma.trip.findFirst({
      where: { routeId: ruta.id, departure: DEPARTURE, deletedAt: null },
    })) ??
    (await prisma.trip.create({
      data: {
        id: await claveDeCorrida(),
        routeId: ruta.id, departure: DEPARTURE, status: 'CLOSED',
        priceOneWay: 250, priceRound: 500,
      },
    }));

  // El cajero se REUSA: crearlo cuesta un `Admin` y una terminal, y los bootstraps de los otros
  // flujos ya lo dejaron. Si el seed oficial no corrió queda en null y esas columnas vuelven a
  // N/A, sin reventar.
  const cajero = await prisma.advisorUser.findFirst();

  // El tipo de pasajero NO se reusa a ciegas: el reporte entrega su CLAVE (`A`, `S`, `M`…, así
  // la trae el archivo del cliente) y los catálogos que dejan los otros flujos usan claves suyas
  // como `E2ETCO-ADULTO`, que en la columna TIPO_PASAJERO se ve como un dato roto. Si no hay una
  // clave corta se siembra una; cuesta un `File`, que solo pide escalares.
  const tipoPasajero =
    (await prisma.passengerType.findFirst({ where: { key: CLAVE_ADULTO } })) ??
    (await prisma.passengerType.create({
      data: {
        key: CLAVE_ADULTO, name: 'Adulto E2E', discountPercent: 0,
        icon: {
          create: {
            name: 'adulto.svg', path: 'e2e/adulto.svg',
            url: 'https://example.invalid/e2e/adulto.svg',
            mimetype: 'image/svg+xml', size: 1,
          },
        },
      },
    }));

  const order = await prisma.order.create({
    data: {
      type: 'ROUND', status: 'PAID', subtotal: 500, total: 580, paymentMethod: 'CASH',
      providerPaymentId: PAYMENT_REF, cashRegisterId: caja.id,
      advisorId: cajero?.id ?? null,
      email: 'pruebas@e2e.local', phone: '2221234567',
      salesChannelId: canal?.id ?? null, createdAt: SALE_DATE,
    },
  });

  const folio = `E2E-${Date.now()}`;
  const folios: string[] = [];
  // Cada venta estrena asientos: `OrderItem` es único por (tripSeatId, segmentId), así que
  // reciclar el asiento de una corrida anterior del seed reventaría la segunda venta.
  const asientosOcupados = await prisma.tripSeat.count({ where: { tripId: corrida.id } });
  for (const [i, ida] of [true, false].entries()) {
    const asiento = await prisma.tripSeat.create({
      data: {
        tripId: corrida.id, number: asientosOcupados + i + 1,
        status: 'BOOKED', passengerTypeId: tipoPasajero.id,
      },
    });
    const item = await prisma.orderItem.create({
      data: {
        ticketNumber: `${folio}-${i + 1}`,
        basePrice: 250, tax: 40, discount: 0, totalPrice: 290,
        isOutbound: ida, orderId: order.id, createdAt: SALE_DATE,
        tripSeatId: asiento.id, routeId: ruta.id,
        invoiceCode: `FAC-${folio}-${i + 1}`,
      },
    });
    folios.push(item.ticketNumber);
    await prisma.passenger.create({
      data: {
        name: i === 0 ? 'Juan Perez' : 'Maria Lopez',
        isMainPassenger: i === 0,
        passengerTypeId: tipoPasajero.id,
        orderItemId: item.id,
      },
    });
  }

  // Las ventas que dejaron corridas ANTERIORES del seed se sembraron sin asiento, y por eso
  // el reporte bajaba con filas enteras de N/A. Se les cuelga uno ahora: repara en vez de
  // borrar, porque un reporte de una sola venta no deja ver ni el orden de las filas.
  // Las ventas de antes del seed (otro marcador de pago) se quedan como están: no son suyas.
  const sinAsiento = await prisma.orderItem.findMany({
    where: { tripSeatId: null, order: { providerPaymentId: PAYMENT_REF } },
    select: { id: true },
  });
  for (const [i, viejo] of sinAsiento.entries()) {
    const asiento = await prisma.tripSeat.create({
      data: {
        tripId: corrida.id, number: asientosOcupados + folios.length + i + 1,
        status: 'BOOKED', passengerTypeId: tipoPasajero.id,
      },
    });
    await prisma.orderItem.update({
      where: { id: viejo.id },
      data: { tripSeatId: asiento.id, routeId: ruta.id },
    });
  }
  if (sinAsiento.length) {
    await prisma.order.updateMany({
      where: { providerPaymentId: PAYMENT_REF, advisorId: null },
      data: { advisorId: cajero?.id ?? null },
    });
    await prisma.passenger.updateMany({
      where: {
        passengerTypeId: null,
        orderItem: { order: { providerPaymentId: PAYMENT_REF } },
      },
      data: { passengerTypeId: tipoPasajero.id },
    });
    console.log(`reparadas ${sinAsiento.length} ventas viejas del seed (sin corrida ni asiento)`);
  }

  // Los pasajeros que sembraron corridas anteriores pueden apuntar al catálogo de otro flujo, con
  // una clave que en el reporte se ve como un dato roto. Se repintan al de clave corta.
  const repintados = await prisma.passenger.updateMany({
    where: {
      orderItem: { order: { providerPaymentId: PAYMENT_REF } },
      NOT: { passengerTypeId: tipoPasajero.id },
    },
    data: { passengerTypeId: tipoPasajero.id },
  });
  if (repintados.count) {
    console.log(`${repintados.count} pasajeros repintados al tipo '${CLAVE_ADULTO}'`);
  }

  const total = await prisma.orderItem.count();
  // El folio se imprime para que el flujo lo deje a mano: es el filtro OBLIGATORIO del
  // reporte de movimientos de boletos (CU-005), que no se puede pedir sin él.
  console.log(`FOLIO=${folios[0]}`);
  console.log(`venta redonda sembrada (${folios.join(', ')}); boletos en la BD: ${total}`);
}

main().finally(() => prisma.$disconnect());
