/**
 * Datos de prueba de la sincronización offline.
 *
 * Dos clases de identificador, y la diferencia importa:
 *
 *  · **Catálogo** (estación, caja, turnos, taquilleros): ids FIJOS. Hacen los
 *    fallos legibles y permiten correr un caso suelto sin recrear el mundo.
 *
 *  · **Lotes** (`sync_id` y los ids de las órdenes): FRESCOS en cada corrida.
 *    El `/sync` es idempotente por `sync_id`, así que un id fijo haría que la
 *    segunda corrida devolviera la respuesta cacheada (`ordersCreated: 0`) y los
 *    casos pasarían sin haber escrito nada. Es el mismo error que ya apareció en
 *    tomtom con el dedup de JetStream: un caso que solo pasa la primera vez es
 *    peor que uno que falla siempre, porque parece que funciona.
 *
 * Para que `verify` (otro proceso, sin los ids aleatorios) pueda encontrar las
 * filas, la llave estable es `tabletTicketNumber`, que sí es nuestro y sí es fijo.
 */
import { randomUUID } from 'crypto';

/**
 * Prefijo de TODO lo que este flujo escribe en BCB. El seed limpia por acá.
 *
 * `E2ETCO-` y no `E2E-TCO-` a propósito: los tres flujos comparten la base de BCB y
 * el seed de tomtom borra su catálogo con `key startsWith 'E2E-'`, o sea que reclama
 * ese espacio entero. Con el prefijo "obvio", tomtom borraba el Admin de este flujo
 * —todavía referenciado por su estación, su ruta y su caja— y su propio seed moría
 * con P2003, dejando la suite de tomtom en 25 rojos por culpa de un flujo ajeno.
 *
 * Regla para el próximo flujo: elegí un prefijo que NO caiga dentro del de otro.
 */
export const TCO_PREFIX = 'E2ETCO-';

/**
 * Ids fijos del catálogo. UUID v4 de verdad (nibble de versión `4`, variante `8`):
 * el DTO valida `shiftId`, `createdById` y `passengerTypeId` con `@IsUUID('4')`, así
 * que un uuid "casi válido" daría 400 y parecería un problema de negocio.
 */
export const catalog = {
  adminId: 'e2e70000-0000-4000-8000-000000000001',
  origenId: 'e2e70000-0000-4000-8000-000000000002',
  destinoId: 'e2e70000-0000-4000-8000-000000000003',
  companyId: 'e2e70000-0000-4000-8000-000000000004',
  serviceId: 'e2e70000-0000-4000-8000-000000000005',
  routeId: 'e2e70000-0000-4000-8000-000000000006',
  /** El taquillero que sincroniza: es el `userId` del token y el dueño de la caja. */
  advisorId: 'e2e70000-0000-4000-8000-000000000007',
  /** Otro taquillero, para probar que no se puede colgar un lote de un turno ajeno. */
  advisorAjenoId: 'e2e70000-0000-4000-8000-000000000008',
  cashRegisterId: 'e2e70000-0000-4000-8000-000000000009',
  turnoAbiertoId: 'e2e70000-0000-4000-8000-00000000000a',
  /** Cerrado a propósito: un lote offline es, por definición, pasado. */
  turnoCerradoId: 'e2e70000-0000-4000-8000-00000000000b',
  turnoAjenoId: 'e2e70000-0000-4000-8000-00000000000c',
  fileId: 'e2e70000-0000-4000-8000-00000000000d',
  passengerTypeId: 'e2e70000-0000-4000-8000-00000000000e',
  /**
   * `Trip.id` NO es un uuid: las corridas importadas del legacy llevan clave propia
   * (ver el `@ApiPropertyOptional` de `tripId` en el DTO del satélite). Si acá se
   * usara un uuid, el caso pasaría por la razón equivocada.
   */
  tripId: 'E2ETCO1130N0000001',
  /** Estación de la caja: numérica y de ≤4 dígitos, o el folio no se puede generar. */
  stationNumber: '9971',
  destinoNumber: '9972',
} as const;

/** Una venta del lote. */
export type TcoOrder = {
  id: string;
  /** Folio impreso en la tablet. Llave ESTABLE: por acá limpia el seed y busca `verify`. */
  tabletTicketNumber: string;
  total: number;
  invoiceCode: string;
  issuedAt: string;
};

export type TcoBatch = {
  tag: string;
  desc: string;
  /** Fresco por corrida: es la llave de idempotencia del `/sync`. */
  syncId: string;
  orders: TcoOrder[];
};

/**
 * Arma un lote. Se evalúa una vez por proceso, así que dentro de una corrida los
 * ids son estables (un caso puede mandar el mismo lote dos veces) y entre
 * corridas son nuevos (la idempotencia no enmascara nada).
 */
function batch(tag: string, desc: string, orders = 1): TcoBatch {
  return {
    tag,
    desc,
    syncId: randomUUID(),
    orders: Array.from({ length: orders }, (_, i) => ({
      id: randomUUID(),
      tabletTicketNumber: `${TCO_PREFIX}${tag}-${i + 1}`,
      total: 150 + i * 50,
      // 14 caracteres Base58, como los folios que pre-reserva facturación. El DTO
      // solo exige no-vacío, pero un valor con la forma real evita que un día se
      // endurezca la validación y el flujo falle por el dato de prueba.
      invoiceCode: `E2ETCO${tag.slice(0, 3)}`.padEnd(14, '1').slice(0, 14),
      issuedAt: new Date(Date.now() - (i + 1) * 60_000).toISOString(),
    })),
  };
}

export const tcoBatches = {
  /** Camino completo: el lote llega a BCB y queda persistido. */
  LOTE_OK: batch('LOTEOK', 'lote de 2 ventas que llega hasta BCB', 2),
  /** Mismo lote dos veces: la segunda debe responder cacheado, sin duplicar. */
  IDEMPOTENTE: batch('IDEM', 'el mismo lote reenviado no duplica'),
  /** Mismo `sync_id` con otro contenido: 409, no un merge silencioso. */
  CONFLICTO: batch('CONFLI', 'sync_id repetido con payload distinto'),
  /** Venta creada Y cancelada durante el mismo periodo offline. */
  CANCELADA: batch('CANCEL', 'venta creada y cancelada en el mismo lote'),
  /** Recolección de efectivo del turno. */
  RECOLECCION: batch('RECOL', 'recolección de efectivo del turno'),
  /** Venta con una corrida que existe: el tripId debe quedar guardado. */
  CORRIDA_OK: batch('CORROK', 'venta con corrida existente'),
  /** Corrida borrada: se guarda como null en vez de tumbar el lote. */
  CORRIDA_FANTASMA: batch('CORRFA', 'corrida inexistente se guarda como null'),
  /** Tipo de pasajero explícito: llega hasta la fila de Passenger. */
  TIPO_PASAJERO: batch('TIPOPA', 'venta con tipo de pasajero'),
} as const;

export const allTcoBatches = Object.values(tcoBatches);
