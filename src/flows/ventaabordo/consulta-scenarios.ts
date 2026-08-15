/**
 * Catálogo BCB para la Consulta de tarjetas de viaje por operador (documento TCF
 * "Servicio – Consulta de tarjetas de viaje"; PRs #1547 BCB / #191 Main / #13
 * VentaABordo — el reemplazo de `apicloud.../abordaje/v1/corrida/operador`).
 *
 * A diferencia de WS1/WS2/SM04 —donde los datos los crean las propias pruebas en
 * el satélite— acá BCB es la fuente de verdad (`AbordajeTripsService.findAllByOperator`),
 * así que hace falta un catálogo completo: empresa, servicio, ruta, estaciones,
 * autobús, caja y corridas del DÍA (el filtro es por la fecha de hoy).
 *
 * Prefijo `E2EVACO-` (Venta A bordo, COnsulta): no es substring de `E2E-` (tomtom)
 * ni de `E2ETCO-` (ticketcolectoroffline) — ver CLAUDE.md, "Adding a flow" — así el
 * wipe de un flujo no le borra los datos a otro.
 */
export const CONSULTA_PREFIX = 'E2EVACO-';

export const consultaCatalog = {
  adminId: 'e2e0a000-0000-4000-8000-0000000ad001',
  companyId: 'e2e0a000-0000-4000-8000-0000000c0001',
  serviceId: 'e2e0a000-0000-4000-8000-0000000e0001',
  origenId: 'e2e0a000-0000-4000-8000-00000005a101',
  destinoId: 'e2e0a000-0000-4000-8000-00000005a102',
  routeId: 'e2e0a000-0000-4000-8000-000000000b01',
  busId: 'e2e0a000-0000-4000-8000-000000000bb1',
  cashRegisterId: 'e2e0a000-0000-4000-8000-000000000ca1',
  operadorConId: 'e2e0a000-0000-4000-8000-0000000001a1',
  operadorSinId: 'e2e0a000-0000-4000-8000-0000000001a2',
  cardId: 'e2e0a000-0000-4000-8000-0000000ca101',
  /** Trip.id ES la claveCorrida del documento (verbatim) — ver CorridasService#toCorrida. */
  tripDespachadaId: `${CONSULTA_PREFIX}TRIP-DESPACHADA`,
  tripAbiertaId: `${CONSULTA_PREFIX}TRIP-ABIERTA`,
} as const;

export const consulta = {
  operadorKey: `${CONSULTA_PREFIX}OP-1`,
  operadorNombre: 'E2E VACO Operador Uno',
  /** Existe en BCB pero no tiene corridas hoy: dispara el semáforo AMARILLO. */
  operadorSinCorridasKey: `${CONSULTA_PREFIX}OP-2`,
  caja: `${CONSULTA_PREFIX}CAJA-1`,
  /** No se registra ningún CashRegister con este deviceIdentifier: dispara ROJO. */
  cajaInvalida: `${CONSULTA_PREFIX}CAJA-NO-EXISTE`,
  busEconomicNumber: `${CONSULTA_PREFIX}BUS-1`,
  busCapacidad: 44,
  // shortName y tradeName/fullName DELIBERADAMENTE distintos: el documento pide
  // el nombre comercial, no la abreviatura — ver el fix de PR #1547 (empresa/
  // servicio venían con shortName antes de la auditoría final).
  companyShortName: `${CONSULTA_PREFIX}SN`,
  companyTradeName: 'E2E VACO Terminal Comercial',
  serviceShortName: `${CONSULTA_PREFIX}SVC`,
  serviceFullName: 'E2E VACO INTERMEDIO',
  origenShortName: `${CONSULTA_PREFIX}ORI`,
  destinoShortName: `${CONSULTA_PREFIX}DST`,
  routeNumber: `${CONSULTA_PREFIX}R1`,
  routeName: 'E2E VACO Ruta Origen-Destino',
  /** TravelCard.key: es lo que el documento llama folioTarjeta. */
  cardKey: `${CONSULTA_PREFIX}FOLIO-0000000000001`,
} as const;
