/**
 * Contenido del panel de demostración: los 3 servicios del contrato TI-FT-45 tal
 * como los describe `TI-FT-45_Documentacion_TCF_VentaABordo_v1_0_0`.
 *
 * Este archivo es **solo descripción** — explicaciones, actores del diagrama,
 * campos del formulario y consultas SQL de validación. La ejecución vive en
 * `server.cjs`. Están separados a propósito: durante una reunión lo que se ajusta
 * es el texto y los datos, no la mecánica.
 *
 * El lenguaje es deliberadamente llano: la audiencia incluye gente de negocio.
 */

// ── Actores del ecosistema ─────────────────────────────────────────────────
// `tipo` decide el color en el diagrama: quién es de quién.
const ACTORES = {
  smartmac: { id: 'smartmac', label: 'SmartMac', sub: 'TECNITRANS · equipo a bordo', tipo: 'tercero' },
  bcb: { id: 'bcb', label: 'BCB', sub: 'sistema central de Estrella Roja', tipo: 'bcb' },
  adapterBcb: { id: 'adapter-bcb', label: 'adapter-bcb', sub: 'puerta de BCB hacia BIGER', tipo: 'biger' },
  bus: { id: 'nats', label: 'Mensajería', sub: 'NATS · cola interna de BIGER', tipo: 'infra' },
  adapterVa: { id: 'adapter-ventaabordo', label: 'adapter-ventaabordo', sub: 'traductor BIGER ↔ satélite', tipo: 'biger' },
  satelite: { id: 'satelite', label: 'Satélite Venta a Bordo', sub: 'el servicio que documentamos', tipo: 'satelite' },
  webhooks: { id: 'webhooks', label: 'BCB · webhooks', sub: 'recibe la venta', tipo: 'bcb' },
  bdBcb: { id: 'bd-bcb', label: 'Base de datos BCB', sub: 'fuente de datos principal', tipo: 'bd' },
  bdSat: { id: 'bd-sat', label: 'Base del satélite', sub: 'registro local del viaje', tipo: 'bd' },
  appBcb: { id: 'app-bcb', label: 'BCB · abordaje', sub: 'consulta las corridas del día', tipo: 'bcb' },
};

const A = (k) => ACTORES[k];

// ── Servicio 1 — Despacho de tarjeta de viaje (WS1) ────────────────────────
const ws1 = {
  id: 'ws1',
  numero: 1,
  nombre: 'Despacho de tarjeta de viaje',
  alias: 'WS1',
  metodo: 'POST',
  ruta: '/corrida/despachar',
  auth: 'JWT Bearer (interno de BCB)',
  quienLlama: 'BCB',
  direccion: 'BCB → BIGER → SmartMac',
  resumen: 'Estrella Roja avisa a TECNITRANS que una corrida salió y le entrega su tarjeta de viaje.',

  explicacion: [
    'Cuando en la terminal se despacha una corrida, BCB crea la **tarjeta de viaje**: el documento que ampara ese viaje concreto, con su autobús, su operador, su ruta y su folio.',
    'Ese despacho tiene que llegar al equipo instalado en la unidad, porque sin la tarjeta de viaje el equipo no sabe qué corrida está corriendo y no puede vender boletos a bordo.',
    'BIGER es el puente: recibe el despacho de BCB, traduce los datos al formato que espera SmartMac y se los entrega. La respuesta que ve BCB es la confirmación (o el rechazo) que SmartMac dio.',
  ],

  reglas: [
    'Es el **primer** servicio del ciclo: sin despacho previo, los servicios 2 y 3 responden que la corrida no existe.',
    'SmartMac contesta HTTP 200 aunque rechace la operación — el veredicto real viaja en el campo `responseCode` del cuerpo.',
    'La tarjeta solo se marca como enviada si SmartMac la **aceptó**. Si la rechaza, queda registrada localmente y un reintento programado la vuelve a mandar.',
    'La clave de corrida (`tripId`) es de longitud variable, entre 11 y 22 caracteres.',
  ],

  actores: [A('bcb'), A('adapterBcb'), A('bus'), A('adapterVa'), A('satelite'), A('smartmac')],
  pasos: [
    { de: 'bcb', a: 'adapter-bcb', texto: 'Se despachó la corrida', detalle: 'BCB publica el despacho con los datos del viaje' },
    { de: 'adapter-bcb', a: 'nats', texto: 'Se encola el aviso', detalle: 'biger.ventaabordo.corrida.despachar' },
    { de: 'nats', a: 'adapter-ventaabordo', texto: 'Lo toma el adaptador', detalle: 'El adaptador del satélite consume el mensaje' },
    { de: 'adapter-ventaabordo', a: 'satelite', texto: 'Llama a WS1', detalle: 'POST /venta-abordo/corrida/despachar' },
    { de: 'satelite', a: 'smartmac', texto: 'Entrega la tarjeta de viaje', detalle: 'POST /WS/Papeletascloud.php — traducido al formato de SmartMac' },
  ],

  // Los nombres y descripciones salen tal cual de la tabla de entrada del documento.
  campos: [
    { name: 'busEconomicNumber', label: 'Número económico del autobús', tipo: 'text', doc: 'string · requerido' },
    { name: 'operatorKey', label: 'Clave del operador', tipo: 'number', doc: 'int · requerido' },
    { name: 'tripId', label: 'Clave de la corrida', tipo: 'text', doc: 'string 11–22 caracteres · requerido' },
    { name: 'tripNumericId', label: 'ID numérico de la corrida', tipo: 'number', doc: 'int · requerido' },
    { name: 'travelCardNumber', label: 'Folio de la tarjeta de viaje', tipo: 'number', doc: 'int · requerido' },
    { name: 'dispatchedAt', label: 'Fecha y hora del despacho', tipo: 'text', doc: 'fecha · requerido' },
    { name: 'originStationNumber', label: 'Estación de origen', tipo: 'number', doc: 'int · requerido' },
    { name: 'destinationStationNumber', label: 'Estación de destino', tipo: 'number', doc: 'int · requerido' },
    { name: 'serviceNumber', label: 'Clave del servicio', tipo: 'number', doc: 'int · requerido' },
    { name: 'routeNumber', label: 'Número de ruta', tipo: 'number', doc: 'int · requerido' },
  ],

  // Dos formas de entrar a la misma cadena. La primera es la real de producción.
  entradas: [
    {
      id: 'bcb',
      label: 'Desde BCB (cadena completa)',
      ayuda: 'Dispara exactamente el mismo evento que BCB emite al despachar una corrida. Recorre los 5 saltos hasta SmartMac.',
    },
    {
      id: 'satelite',
      label: 'Directo al satélite',
      ayuda: 'Llama a WS1 sin pasar por la mensajería interna. Útil para aislar el satélite si algo falla en la cadena.',
    },
  ],

  sql: [
    {
      id: 'tarjeta',
      titulo: 'La tarjeta de viaje quedó registrada',
      base: 'satelite',
      descripcion:
        'El satélite guarda la tarjeta al recibir el despacho. Si "enviada a SmartMac" trae fecha, SmartMac la confirmó; si viene vacía, el reintento programado la volverá a mandar.',
      query: `SELECT "claveCorrida"          AS "clave de corrida",
       "idTarjetaViaje"        AS "folio de tarjeta",
       "numeroAutobus"         AS "autobus",
       "numeroOperador"        AS "operador",
       "estado"                AS "estado de la tarjeta",
       "estadoCorrida"         AS "estado de la corrida",
       "fechaEnvioSmartmac"    AS "enviada a SmartMac",
       "intentosEnvioSmartmac" AS "intentos",
       "ultimoErrorSmartmac"   AS "ultimo error"
FROM "TarjetaViaje"
WHERE "idTarjetaViaje" = {{travelCardNumber}}`,
    },
  ],
};

// ── Servicio 2 — Recepción de venta / recaudación (WS2) ────────────────────
const ws2 = {
  id: 'ws2',
  numero: 2,
  nombre: 'Recepción de venta (recaudación)',
  alias: 'WS2',
  metodo: 'POST',
  ruta: '/venta/recaudacion',
  auth: 'HTTP Basic (credencial de SmartMac)',
  quienLlama: 'SmartMac',
  direccion: 'SmartMac → BIGER → BCB',
  resumen: 'Al cerrar la corrida, TECNITRANS reporta todo lo que se vendió a bordo y eso queda guardado en BCB.',

  explicacion: [
    'Durante el trayecto el equipo a bordo vende boletos: en efectivo, con tarjeta prepago, canjeando un boleto comprado antes en taquilla o recargando una tarjeta.',
    'Al cerrar la corrida, SmartMac manda **el detalle completo** de esa venta: los totales y un renglón por cada boleto, con su folio preimpreso, asiento, tarifa, tramo y forma de pago.',
    'BIGER recibe ese reporte, lo valida contra la tarjeta de viaje que se despachó en el Servicio 1 y lo hace llegar hasta BCB, que es donde vive la información de recaudación de la empresa.',
  ],

  reglas: [
    'La tarjeta de viaje referenciada **debe existir** (haberse despachado con el Servicio 1). Si no, la respuesta es 404.',
    'El campo `id` es la llave de idempotencia: si SmartMac reenvía la misma venta, no se duplica — se devuelve la que ya estaba.',
    'El folio preimpreso debe ser único entre los boletos de una misma corrida. Las recargas están exentas y pueden compartir folio.',
    '`tipoPago` es un catálogo cerrado: EFECTIVO, PREPAGO, CANJE o RECARGA. `boletoExternoId` solo es obligatorio en CANJE; `codigoFacturacion` está prohibido en PREPAGO.',
    'El viaje hasta BCB es asíncrono: la respuesta del satélite es inmediata y el dato termina de asentarse unos segundos después.',
    '**Punto abierto a revisar con TECNITRANS:** hoy BCB exige `boletoExternoId` en *todos* los renglones, no solo en los de CANJE. Un renglón de EFECTIVO sin ese campo —válido según el contrato— lo acepta el satélite y luego se descarta en BCB, sin que SmartMac reciba ningún aviso.',
  ],

  actores: [A('smartmac'), A('satelite'), A('adapterVa'), A('bus'), A('adapterBcb'), A('webhooks'), A('bdBcb')],
  pasos: [
    { de: 'smartmac', a: 'satelite', texto: 'Reporta la venta de la corrida', detalle: 'POST /venta-abordo/venta/recaudacion' },
    { de: 'satelite', a: 'adapter-ventaabordo', texto: 'Se valida y se registra', detalle: 'Comprueba que la tarjeta de viaje exista' },
    { de: 'adapter-ventaabordo', a: 'nats', texto: 'Se encola hacia BCB', detalle: 'JetStream · VENTAABORDO_VENTAS' },
    { de: 'nats', a: 'adapter-bcb', texto: 'Lo toma el adaptador de BCB', detalle: 'Consumidor durable: si BCB está caído, el mensaje espera' },
    { de: 'adapter-bcb', a: 'webhooks', texto: 'Entrega la venta a BCB', detalle: 'POST /smartmac/venta-abordo' },
    { de: 'webhooks', a: 'bd-bcb', texto: 'Queda guardada', detalle: 'BoardingSale + un renglón por boleto' },
  ],

  campos: [
    { name: 'id', label: 'ID de la venta (idempotencia)', tipo: 'number', doc: 'int · requerido' },
    { name: 'corridaId', label: 'ID numérico de la corrida', tipo: 'number', doc: 'int · requerido' },
    { name: 'claveCorrida', label: 'Clave de la corrida', tipo: 'text', doc: 'string 11–22 caracteres · requerido' },
    { name: 'operador', label: 'Clave del operador', tipo: 'text', doc: 'string · requerido' },
    { name: 'rutaId', label: 'Número de ruta', tipo: 'number', doc: 'int · requerido' },
    { name: 'tarjetaViajeId', label: 'Folio de la tarjeta de viaje', tipo: 'number', doc: 'int · requerido — debe existir' },
    { name: 'montoTotalVenta', label: 'Monto total vendido', tipo: 'number', doc: 'number · requerido' },
    { name: 'totalBoletosVendidos', label: 'Total de boletos vendidos', tipo: 'number', doc: 'int · requerido' },
    { name: 'folioTarjeta', label: 'Folio único de la tarjeta', tipo: 'text', doc: 'string de 22 caracteres' },
    { name: 'estatusCorrida', label: 'Estado de la corrida', tipo: 'text', doc: 'string · opcional' },
    { name: 'estatusTarjeta', label: 'Estado de la tarjeta', tipo: 'text', doc: 'string · opcional' },
    { name: 'fechaCreacion', label: 'Fecha de la venta', tipo: 'text', doc: 'fecha · requerido' },
  ],

  sql: [
    {
      id: 'venta',
      titulo: 'La venta llegó a BCB',
      base: 'bcb',
      descripcion:
        'Ésta es la validación que importa: BCB es la fuente de datos principal. Si aquí aparece el renglón, la venta hizo el viaje completo desde el autobús.',
      query: `SELECT s."smartmacId"       AS "id de SmartMac",
       s."tripKey"          AS "clave de corrida",
       s."operatorKey"      AS "operador",
       s."cardFolio"        AS "folio de tarjeta",
       s."totalAmount"      AS "monto total",
       s."totalTicketsSold" AS "boletos vendidos",
       count(i.id)          AS "renglones guardados",
       s."tripStatus"       AS "estado corrida",
       s."cardStatus"       AS "estado tarjeta",
       s."saleDate"         AS "fecha de venta",
       s."createdAt"        AS "recibida en BCB"
FROM "BoardingSale" s
LEFT JOIN "BoardingSaleItem" i ON i."boardingSaleId" = s.id
WHERE s."smartmacId" = {{id}}
GROUP BY s.id`,
    },
    {
      id: 'boletos',
      titulo: 'Detalle boleto por boleto',
      base: 'bcb',
      descripcion: 'Cada renglón que mandó SmartMac, tal como quedó guardado en BCB.',
      query: `SELECT i."ticketFolio"   AS "folio preimpreso",
       i."paymentType"   AS "forma de pago",
       i."passengerType" AS "tipo de pasajero",
       i."ticketAmount"  AS "importe",
       i."seatNumber"    AS "asiento",
       i."fareId"        AS "tarifa",
       i."segmentId"     AS "tramo",
       i."prepaidCard"   AS "tarjeta prepago",
       i."billingCode"   AS "codigo facturacion",
       i."soldAt"        AS "vendido el"
FROM "BoardingSaleItem" i
JOIN "BoardingSale" s ON s.id = i."boardingSaleId"
WHERE s."smartmacId" = {{id}}
ORDER BY i."ticketFolio"`,
    },
  ],
};

// ── Servicio 3 — Consulta de tarjetas de viaje ─────────────────────────────
const consulta = {
  id: 'consulta',
  numero: 3,
  nombre: 'Consulta de tarjetas de viaje',
  alias: 'Consulta por operador',
  metodo: 'GET',
  ruta: '/corrida/operador',
  auth: 'HTTP Basic (credencial de SmartMac)',
  quienLlama: 'SmartMac',
  direccion: 'SmartMac → BIGER → BCB → SmartMac',
  resumen: 'El equipo a bordo pregunta qué corridas tiene hoy un operador y en qué estado está la tarjeta de viaje de cada una.',

  explicacion: [
    'El equipo instalado en la unidad puede reiniciarse, quedarse sin señal o cambiar de operador a media jornada. Cuando eso pasa necesita recuperar su contexto sin depender de que le vuelvan a empujar los datos.',
    'Este servicio le permite preguntar, en cualquier momento: *"soy la caja X y traigo al operador Y — ¿qué corridas tengo hoy y cómo va su tarjeta de viaje?"*.',
    'La respuesta la arma BCB, que es donde vive la programación del día. Por eso este servicio es también la red de seguridad del Servicio 1: si un despacho no alcanzó a llegar, aquí se ve el estado real.',
  ],

  reglas: [
    'Los rechazos de negocio **no** son errores HTTP: responden 200 con un semáforo.',
    '**VERDE** — se encontraron corridas para ese operador hoy.',
    '**AMARILLO** — el operador existe pero no tiene corridas programadas hoy.',
    '**ROJO** — la caja o el operador no están registrados.',
    'Las corridas que aún no se despachan aparecen con `folioTarjeta` y `estadoTarjetaViaje` vacíos: todavía no tienen tarjeta.',
  ],

  actores: [A('smartmac'), A('satelite'), A('adapterVa'), A('bus'), A('adapterBcb'), A('appBcb'), A('bdBcb')],
  pasos: [
    { de: 'smartmac', a: 'satelite', texto: 'Pregunta por el operador y la caja', detalle: 'GET /venta-abordo/corrida/operador' },
    { de: 'satelite', a: 'adapter-ventaabordo', texto: 'Reenvía la pregunta', detalle: 'El satélite no guarda la programación del día' },
    { de: 'adapter-ventaabordo', a: 'nats', texto: 'Pregunta y espera respuesta', detalle: 'biger.bcb.abordaje.trips.list' },
    { de: 'nats', a: 'adapter-bcb', texto: 'La resuelve el adaptador de BCB', detalle: '' },
    { de: 'adapter-bcb', a: 'app-bcb', texto: 'Consulta las corridas del día', detalle: 'GET /abordaje/trips' },
    { de: 'app-bcb', a: 'bd-bcb', texto: 'Lee la programación', detalle: 'Corridas de hoy del operador, con su tarjeta de viaje' },
  ],
  // La respuesta se devuelve por el mismo camino, en sentido inverso.
  respuestaDeVuelta: true,

  campos: [
    { name: 'numeroOperador', label: 'Número de operador', tipo: 'text', doc: 'string · requerido' },
    { name: 'caja', label: 'Identificador de la caja / equipo', tipo: 'text', doc: 'string · requerido' },
  ],

  sql: [
    {
      id: 'corridas',
      titulo: 'Las corridas de hoy en BCB',
      base: 'bcb',
      descripcion:
        'Lo que la consulta devuelve sale de estas filas. Compará este resultado con la respuesta del servicio: deben coincidir corrida por corrida.',
      query: `SELECT t.id                 AS "clave de corrida",
       t."departure"        AS "fecha y hora",
       t.status             AS "estado de la corrida",
       o.key                AS "operador",
       o.name               AS "nombre del operador",
       b."economicNumber"   AS "autobus",
       b."seatCount"        AS "capacidad",
       r.number             AS "numero de ruta",
       r.name               AS "nombre de la ruta",
       tc.key               AS "folio de tarjeta",
       tc.status            AS "estado de la tarjeta"
FROM "Trip" t
JOIN "Operator" o    ON o.id = t."operatorId"
JOIN "Bus" b         ON b.id = t."busId"
JOIN "Route" r       ON r.id = t."routeId"
LEFT JOIN "TravelCard" tc ON tc."tripId" = t.id
WHERE o.key = '{{numeroOperador}}'
  AND t."departure" >= date_trunc('day', now())
  AND t."departure" <  date_trunc('day', now()) + interval '1 day'
ORDER BY t."departure"`,
    },
    {
      id: 'caja',
      titulo: 'La caja está registrada',
      base: 'bcb',
      descripcion:
        'Si esta consulta no devuelve nada, el servicio contesta con semáforo ROJO: la caja que dice traer el equipo no existe en BCB.',
      query: `SELECT "deviceIdentifier" AS "caja",
       name               AS "nombre",
       device             AS "tipo de equipo",
       status             AS "estado"
FROM "CashRegister"
WHERE "deviceIdentifier" = '{{caja}}'`,
    },
  ],
};

const SERVICIOS = [ws1, ws2, consulta];

module.exports = { SERVICIOS, ACTORES };
