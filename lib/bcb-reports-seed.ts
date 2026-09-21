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
  const corridasPrevias = await prisma.trip.count();
  const corrida =
    (await prisma.trip.findFirst({ where: { routeId: ruta.id, departure: DEPARTURE } })) ??
    (await prisma.trip.create({
      data: {
        id: `E2EPU0800N${String(corridasPrevias + 1).padStart(7, '0')}`,
        routeId: ruta.id, departure: DEPARTURE, status: 'CLOSED',
        priceOneWay: 250, priceRound: 500,
      },
    }));

  // Cajero y tipo de pasajero se REUSAN: crearlos cuesta un `Admin` y un `File` (los exige
  // el esquema) y los bootstraps de los otros flujos ya dejaron los dos catálogos. Si el
  // seed oficial no corrió, quedan en null y esas columnas vuelven a N/A — sin reventar.
  const cajero = await prisma.advisorUser.findFirst();
  const tipoPasajero = await prisma.passengerType.findFirst();

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
        status: 'BOOKED', passengerTypeId: tipoPasajero?.id ?? null,
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
        passengerTypeId: tipoPasajero?.id ?? null,
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
        status: 'BOOKED', passengerTypeId: tipoPasajero?.id ?? null,
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
      data: { passengerTypeId: tipoPasajero?.id ?? null },
    });
    console.log(`reparadas ${sinAsiento.length} ventas viejas del seed (sin corrida ni asiento)`);
  }

  const total = await prisma.orderItem.count();
  // El folio se imprime para que el flujo lo deje a mano: es el filtro OBLIGATORIO del
  // reporte de movimientos de boletos (CU-005), que no se puede pedir sin él.
  console.log(`FOLIO=${folios[0]}`);
  console.log(`venta redonda sembrada (${folios.join(', ')}); boletos en la BD: ${total}`);
}

main().finally(() => prisma.$disconnect());
