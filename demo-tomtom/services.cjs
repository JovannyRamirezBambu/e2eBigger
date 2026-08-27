/**
 * Contenido del panel de demostración de TomTom: los seis momentos del ciclo, tal
 * como los describe `TI-FT-45_Documentación_técnica_TomTom` y como los ejecuta el
 * código del satélite.
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
  bcb: { id: 'bcb', label: 'BCB', sub: 'sistema central de Estrella Roja', tipo: 'bcb' },
  adapterBcb: { id: 'adapter-bcb', label: 'adapter-bcb', sub: 'puerta de BCB hacia BIGER', tipo: 'biger' },
  bus: { id: 'nats', label: 'Mensajería', sub: 'NATS · cola interna de BIGER', tipo: 'infra' },
  jetstream: { id: 'jetstream', label: 'Cola durable', sub: 'JetStream · reintenta y no pierde', tipo: 'infra' },
  adapterTt: { id: 'adapter-tomtom', label: 'adapter-tomtom', sub: 'traductor BIGER ↔ satélite', tipo: 'biger' },
  satelite: { id: 'satelite', label: 'Satélite TomTom', sub: 'el servicio que documentamos', tipo: 'satelite' },
  inroute: { id: 'inroute', label: 'InRoute', sub: 'Adsum · plataforma TomTom', tipo: 'tercero' },
  appBcb: { id: 'app-bcb', label: 'BCB · corridas', sub: 'despacho y llegada de la corrida', tipo: 'bcb' },
  bdBcb: { id: 'bd-bcb', label: 'Base de datos BCB', sub: 'fuente de datos principal', tipo: 'bd' },
  bdSat: { id: 'bd-sat', label: 'Base del satélite', sub: 'registro local del viaje', tipo: 'bd' },
  unidad: { id: 'unidad', label: 'La unidad', sub: 'GPS a bordo · cruza la geocerca', tipo: 'tercero' },
};

const A = (k) => ACTORES[k];

// ── SQL reutilizable ───────────────────────────────────────────────────────
// El registro que el satélite guarda de cada viaje. Se repite en varias pestañas
// porque es la prueba de que la operación llegó hasta InRoute y volvió.
const SQL_VIAJE_SATELITE = {
  id: 'viaje',
  titulo: 'El viaje quedó registrado en el satélite',
  base: 'satelite',
  descripcion:
    'Si "id en InRoute" trae número, InRoute aceptó el viaje y lo devolvió. Si viene vacío, el alta no se completó: la razón está en la bitácora de abajo.',
  query: `SELECT "travelCardId"      AS "tarjeta de viaje (BCB)",
       "tripId"            AS "corrida (BCB)",
       "nTripId"           AS "id en InRoute",
       "economicNumber"    AS "autobus",
       "operatorKey"       AS "operador",
       "nVehicleId"        AS "unidad en InRoute",
       "nTripInstructionId" AS "instruccion de viaje",
       "departure"         AS "salida programada",
       "dispatchedAt"      AS "salida real (geocerca)",
       "arrivedAt"         AS "llegada real (geocerca)",
       "failed"            AS "marcado como fallido"
FROM "TomTomTrip"
WHERE "travelCardId" = '{{claveERP}}'`,
};

const SQL_BITACORA = {
  id: 'bitacora',
  titulo: 'Bitácora de sincronizaciones con InRoute',
  base: 'satelite',
  descripcion:
    'Un renglón por intento. Es donde se ve qué pasó cuando algo no llegó: el satélite no devuelve error HTTP por un fallo de InRoute, lo deja anotado acá.',
  query: `SELECT s."operation"    AS "operacion",
       s."status"       AS "resultado",
       s."nTripId"      AS "id en InRoute",
       s."errorMessage" AS "error",
       s."attemptedAt"  AS "intento"
FROM "TomTomSync" s
JOIN "TomTomTrip" t ON t.id = s."tripId"
WHERE t."travelCardId" = '{{claveERP}}'
ORDER BY s."attemptedAt"`,
};

// ── 1 · Registro del viaje en InRoute ──────────────────────────────────────
const alta = {
  id: 'alta',
  numero: 1,
  nombre: 'Registro del viaje',
  alias: 'Alta en InRoute',
  metodo: 'POST',
  ruta: '/tomtom/viajes',
  auth: 'JWT RS256 (firmado por adapter-tomtom)',
  quienLlama: 'BCB, a través de adapter-tomtom',
  direccion: 'BCB → BIGER → InRoute',
  resumen: 'Cuando tráfico asigna operador y unidad a una corrida, el viaje aparece en la plataforma TomTom.',

  explicacion: [
    'En TMS se despacha la corrida: se le asigna una unidad y un operador, y BCB crea la **tarjeta de viaje**. Ese es el disparador de todo el ciclo.',
    'Para que la torre de control pueda seguir esa corrida en el mapa, el viaje tiene que existir también del lado de **InRoute**, la plataforma de TomTom. BIGER es el puente: escucha el evento de BCB, traduce los datos al formato de InRoute y da de alta el viaje.',
    'La traducción no es trivial: BCB habla de autobuses por número económico y de operadores por su clave; InRoute los identifica con **números propios**. El satélite resuelve esas equivalencias —unidad, operador, grupo y ruta— antes de mandar nada, y se guarda el par unidad+operador para no volver a preguntarlo.',
  ],

  reglas: [
    'Es el **primer** eslabón: sin viaje en InRoute no hay nada que vigilar, y los eventos de geocerca de los servicios 3 y 4 nunca se disparan.',
    'La **tarjeta de viaje** (`claveERP`) es la llave de idempotencia: si el mismo evento llega dos veces, no se duplica el viaje.',
    'Si el evento no trae los identificadores de InRoute, el satélite los resuelve contra el proveedor: la unidad por su número económico, el operador por su clave, el grupo por el par unidad+operador y la ruta por su clave. El grupo queda cacheado en `TomTomGroup`.',
    'Si falta una equivalencia —una unidad que InRoute no conoce— el viaje queda registrado localmente **sin** id de InRoute y con el motivo anotado. Al tercer intento fallido se marca `failed` y sale del ciclo hasta que se reintente a mano.',
    'El satélite responde **201 aunque InRoute haya fallado**: el veredicto real es el campo `nTripId` de la respuesta, y el detalle está en la bitácora.',
    '**Punto abierto:** en producción los identificadores de InRoute se precargan con `setup-mappings.ts`. En este entorno están vacíos a propósito, así que se ejercita el camino de resolución dinámica — el mismo que corre cuando falta un mapeo.',
    '**Punto abierto a revisar con BCB:** el evento que arma adapter-bcb manda la **estación destino vacía** (`destinationId: ""` en `TravelCardRelayService.buildViajePayload`). El alta funciona igual, pero ese dato es el que después necesita la confirmación de llegada: sin él, CU05 se rechaza. Se ve abajo, en el resultado del alta.',
  ],

  actores: [A('bcb'), A('adapterBcb'), A('bus'), A('adapterTt'), A('satelite'), A('inroute')],
  pasos: [
    { de: 'bcb', a: 'adapter-bcb', texto: 'Se despachó la corrida', detalle: 'BCB publica que creó la tarjeta de viaje' },
    { de: 'adapter-bcb', a: 'nats', texto: 'Se arma el contexto del viaje', detalle: 'adapter-bcb le pregunta a BCB los datos de la corrida y publica biger.tomtom.viaje.crear' },
    { de: 'nats', a: 'adapter-tomtom', texto: 'Lo toma el adaptador de TomTom', detalle: 'Consume el mensaje y firma su JWT' },
    { de: 'adapter-tomtom', a: 'satelite', texto: 'Llama al satélite', detalle: 'POST /tomtom/viajes' },
    { de: 'satelite', a: 'inroute', texto: 'Da de alta el viaje en InRoute', detalle: 'POST /viajes — traducido al formato del proveedor' },
  ],

  campos: [
    { name: 'claveERP', label: 'Tarjeta de viaje (BCB)', tipo: 'text', doc: 'UUID · requerido — llave de idempotencia' },
    { name: 'tripId', label: 'Corrida (BCB)', tipo: 'text', doc: 'UUID · requerido' },
    { name: 'economicNumber', label: 'Número económico del autobús', tipo: 'text', doc: 'string · requerido' },
    { name: 'operatorKey', label: 'Clave del operador', tipo: 'text', doc: 'string · requerido' },
    { name: 'routeId', label: 'Clave de la ruta', tipo: 'text', doc: 'string · requerido' },
    { name: 'departure', label: 'Salida programada', tipo: 'text', doc: 'ISO 8601 · requerido' },
    { name: 'description', label: 'Descripción del viaje', tipo: 'text', doc: 'máx. 300 caracteres · requerido' },
    { name: 'busId', label: 'Autobús (BCB)', tipo: 'text', doc: 'UUID · requerido' },
    { name: 'operatorId', label: 'Operador (BCB)', tipo: 'text', doc: 'UUID · requerido' },
    { name: 'destinationId', label: 'Estación destino (BCB)', tipo: 'text', doc: 'UUID · requerido' },
  ],

  entradas: [
    {
      id: 'bcb',
      label: 'Desde BCB (cadena completa)',
      ayuda: 'Publica el mismo evento que BCB emite al crear la tarjeta de viaje. Recorre los 5 saltos hasta InRoute.',
    },
    {
      id: 'satelite',
      label: 'Directo al satélite',
      ayuda: 'Llama al satélite con el JWT del adaptador, saltando la mensajería. Sirve para aislar al satélite si algo falla en un eslabón intermedio.',
    },
  ],

  sql: [SQL_VIAJE_SATELITE, SQL_BITACORA],
};

// ── 2 · Cambios y cancelación ──────────────────────────────────────────────
const cambios = {
  id: 'cambios',
  numero: 2,
  nombre: 'Cambios y cancelación',
  alias: 'Actualizar / cancelar',
  metodo: 'PUT · DELETE',
  ruta: '/tomtom/viajes/{claveERP}',
  auth: 'JWT RS256 (firmado por adapter-tomtom)',
  quienLlama: 'BCB, a través de adapter-tomtom',
  direccion: 'BCB → BIGER → InRoute',
  resumen: 'Si la corrida cambia de unidad, de operador o de horario —o se cancela— InRoute se entera por el mismo camino.',

  explicacion: [
    'Una corrida no siempre sale como se planeó: cambia la unidad por una falla, entra otro operador, se recorre el horario, o se cancela.',
    'BCB emite esos cambios igual que emitió el alta, y el viaje se **actualiza en InRoute** en lugar de crearse. Si la corrida se cancela, el viaje se cancela también, con su motivo.',
    'Nada de esto borra el registro local: el satélite conserva el viaje y anota cada operación en su bitácora, que es lo que después permite explicar qué pasó y cuándo.',
  ],

  reglas: [
    'La actualización exige que el viaje **ya exista en InRoute**. Si el alta nunca se completó, la operación se ignora y queda anotada — no se inventa un viaje nuevo.',
    'La cancelación usa el motivo configurado en el satélite o, si no hay ninguno, el primero del catálogo de motivos de InRoute.',
    'InRoute **no permite editar un viaje en progreso** o en un estado mayor (error 3000), ni cancelar uno en proceso (3013). Ese rechazo llega como fallo y queda en la bitácora.',
    'Igual que en el alta, un rechazo del proveedor no se convierte en error HTTP hacia BCB: la corrida sigue su curso y el problema se ve en la bitácora.',
    '**Punto abierto a revisar con BCB (bloqueante):** hoy la actualización por la cadena **no llega**. adapter-bcb manda el mismo cuerpo para el alta y para el cambio, con el campo `claveERP` incluido; el satélite valida en modo estricto y en la actualización ese campo no existe en el contrato, así que responde `400 property claveERP should not exist` y el cambio se pierde. Se puede ver con el botón de abajo: la entrada «Directo al satélite» manda el cuerpo correcto y sí pasa.',
  ],

  actores: [A('bcb'), A('adapterBcb'), A('bus'), A('adapterTt'), A('satelite'), A('inroute')],
  pasos: [
    { de: 'bcb', a: 'adapter-bcb', texto: 'Cambió o se canceló la corrida', detalle: 'BCB publica la actualización de la tarjeta de viaje' },
    { de: 'adapter-bcb', a: 'nats', texto: 'Se encola el cambio', detalle: 'biger.tomtom.viaje.actualizar · biger.tomtom.viaje.cancelar' },
    { de: 'nats', a: 'adapter-tomtom', texto: 'Lo toma el adaptador de TomTom', detalle: '' },
    { de: 'adapter-tomtom', a: 'satelite', texto: 'Llama al satélite', detalle: 'PUT /tomtom/viajes/{claveERP} · DELETE /tomtom/viajes/{claveERP}' },
    { de: 'satelite', a: 'inroute', texto: 'Aplica el cambio en InRoute', detalle: 'POST /viajes con nViaje · DELETE /viajes con el motivo' },
  ],

  campos: [
    { name: 'claveERP', label: 'Tarjeta de viaje (BCB)', tipo: 'text', doc: 'UUID · requerido' },
    { name: 'economicNumber', label: 'Número económico del autobús', tipo: 'text', doc: 'cambiar la unidad se ve acá' },
    { name: 'operatorKey', label: 'Clave del operador', tipo: 'text', doc: 'cambiar el operador se ve acá' },
    { name: 'departure', label: 'Salida programada', tipo: 'text', doc: 'ISO 8601 · recorrer el horario se ve acá' },
    { name: 'description', label: 'Descripción del viaje', tipo: 'text', doc: 'máx. 300 caracteres' },
  ],

  entradas: [
    {
      id: 'actualizar',
      label: 'Actualizar el viaje',
      ayuda: 'Manda el cambio por la cadena completa, como cuando tráfico reasigna la unidad o mueve el horario.',
    },
    {
      id: 'cancelar',
      label: 'Cancelar el viaje',
      ayuda: 'Cancela el viaje en InRoute con su motivo. El registro local se conserva, con la operación anotada.',
    },
    {
      id: 'directo',
      label: 'Actualizar directo al satélite',
      ayuda: 'Manda el cambio con el cuerpo que el contrato pide (sin claveERP), saltando la mensajería. Es la actualización funcionando, mientras se corrige el payload de adapter-bcb.',
    },
  ],

  sql: [SQL_VIAJE_SATELITE, SQL_BITACORA],
};

// ── 3 · CU04 — salida de geocerca ──────────────────────────────────────────
const cu04 = {
  id: 'cu04',
  numero: 3,
  nombre: 'Salida de la terminal',
  alias: 'CU04',
  metodo: 'POST',
  ruta: '/tomtom/eventos-geocerca',
  auth: 'Token del webhook (INROUTE_WEBHOOK_TOKEN)',
  quienLlama: 'TomTom/InRoute, al detectar el cruce (webhook)',
  direccion: 'InRoute → BIGER → BCB',
  resumen: 'La unidad cruza la geocerca de la terminal y la corrida queda despachada en BCB, con su hora real.',

  explicacion: [
    'Cuando la unidad sale físicamente de la terminal, su GPS cruza la **geocerca de origen** y TomTom lo registra. Eso es lo más cercano a la verdad que hay sobre a qué hora salió realmente la corrida.',
    'El DCU define el modelo como **webhook**: TomTom empuja cada cruce al satélite en tiempo real (POST /tomtom/eventos-geocerca, respuesta 202) — el endpoint de consulta nunca existió en el API real (404). Este botón hace el mismo POST que hará el InRoute de Adsum.',
    'Si el cruce corresponde a un viaje activo y cae dentro de la ventana permitida, el satélite avisa a BCB —por una cola durable, para que el evento no se pierda si BCB está caído— y la corrida queda **despachada con su hora real**, el autobús pasa a "en viaje", y la operación deja de depender de que alguien lo capture a mano.',
  ],

  reglas: [
    'Solo se acepta la salida de la **geocerca de origen** ocurrida entre **45 minutos antes y 60 minutos después** de la salida programada. Fuera de esa ventana el cruce se descarta y queda en bitácora: requiere confirmación manual del jefe de terminal.',
    'El evento se notifica **una sola vez**. La marca se escribe antes de avisar, así que aunque el proceso programado y este panel coincidan, BCB recibe un solo aviso.',
    'El satélite firma su propio **JWT RS256** de 5 minutos para llamar al adaptador. Sin esa llave el aviso sale sin credencial, el adaptador responde 401 y el evento se pierde: el satélite no reintenta.',
    'De ahí a BCB el evento viaja por una **cola durable** con deduplicación de 2 minutos: si BCB está caído, el mensaje espera; si el mismo evento se publica dos veces seguidas, la cola descarta el repetido.',
    'BCB rechaza (409) una corrida nunca despachada, una cancelada o un autobús que no es el de esa corrida. Un reintento con otra hora **no pisa** la salida ya registrada.',
    'Solo se miran los viajes activos con salida entre 6 horas antes y 1 hora después del momento de la consulta, de a 50 por corrida.',
  ],

  actores: [A('unidad'), A('inroute'), A('satelite'), A('adapterTt'), A('jetstream'), A('adapterBcb'), A('appBcb'), A('bdBcb')],
  pasos: [
    { de: 'unidad', a: 'inroute', texto: 'La unidad cruza la geocerca de origen', detalle: 'El GPS reporta la salida (nTipo = 2)' },
    { de: 'inroute', a: 'satelite', texto: 'TomTom empuja el evento al webhook', detalle: 'POST /tomtom/eventos-geocerca (202 · regla <5 s del DCU)' },
    { de: 'satelite', a: 'adapter-tomtom', texto: 'Avisa el despacho', detalle: 'POST /tomtom/corridas/{corrida}/despachar con su JWT' },
    { de: 'adapter-tomtom', a: 'jetstream', texto: 'Se encola durable', detalle: 'TOMTOM_GEOCERCAS_STREAM · no se pierde si BCB está caído' },
    { de: 'jetstream', a: 'adapter-bcb', texto: 'Lo toma el adaptador de BCB', detalle: 'Consumidor durable tomtom-geocercas-workers' },
    { de: 'adapter-bcb', a: 'app-bcb', texto: 'Despacha la corrida en BCB', detalle: 'POST /corridas/{id}/despachar' },
    { de: 'app-bcb', a: 'bd-bcb', texto: 'Queda la hora real de salida', detalle: 'Trip.realDepartureAt y el autobús en viaje' },
  ],

  campos: [
    { name: 'claveERP', label: 'Tarjeta de viaje (BCB)', tipo: 'text', doc: 'la corrida que se va a despachar' },
    {
      name: 'desfaseMinutos',
      label: 'Cruce respecto a la salida programada (min)',
      tipo: 'number',
      doc: 'negativo = se adelantó · dentro de −45 y +60 se acepta',
    },
  ],

  entradas: [
    {
      id: 'satelite',
      label: 'Webhook del satélite',
      ayuda: 'POST /tomtom/eventos-geocerca con el token del webhook — el mismo camino que usará el InRoute de Adsum.',
    },
  ],

  sql: [
    {
      id: 'corrida',
      titulo: 'La corrida quedó despachada en BCB',
      base: 'bcb',
      descripcion:
        'Ésta es la validación que importa: BCB es la fuente de datos principal. "salida real" es la hora del cruce de geocerca, no la programada.',
      query: `SELECT t.status              AS "estado de la corrida",
       t."departure"         AS "salida programada",
       t."realDepartureAt"   AS "salida real (geocerca)",
       t."realArrivalAt"     AS "llegada real",
       b."economicNumber"    AS "autobus",
       b.status              AS "estado del autobus",
       tc.status             AS "estado de la tarjeta"
FROM "TravelCard" tc
JOIN "Trip" t ON t.id = tc."tripId"
LEFT JOIN "TripDispatch" td ON td."tripId" = t.id
LEFT JOIN "Bus" b ON b.id = td."busId"
WHERE tc.id = '{{claveERP}}'`,
    },
    {
      id: 'marca',
      titulo: 'El satélite anotó la salida',
      base: 'satelite',
      descripcion:
        'La marca local es lo que garantiza que el aviso se manda una sola vez, aunque el cron y el panel disparen a la vez.',
      query: `SELECT "travelCardId" AS "tarjeta de viaje",
       "nTripId"      AS "id en InRoute",
       "dispatchedAt" AS "salida detectada",
       "arrivedAt"    AS "llegada detectada"
FROM "TomTomTrip"
WHERE "travelCardId" = '{{claveERP}}'`,
    },
  ],
};

// ── 4 · CU05 — llegada a destino ───────────────────────────────────────────
const cu05 = {
  id: 'cu05',
  numero: 4,
  nombre: 'Llegada a destino',
  alias: 'CU05',
  metodo: 'POST',
  ruta: '/tomtom/eventos-geocerca',
  auth: 'Token del webhook (INROUTE_WEBHOOK_TOKEN)',
  quienLlama: 'TomTom/InRoute, al detectar el cruce (webhook)',
  direccion: 'InRoute → BIGER → BCB',
  resumen: 'La unidad entra a la geocerca de la terminal destino: se confirma la tarjeta y quedan libres el autobús y el operador.',

  explicacion: [
    'Al final del trayecto la unidad entra a la **geocerca de la terminal destino**. Ese cruce cierra el ciclo de la corrida.',
    'BIGER lo detecta con el mismo polling que el servicio anterior y se lo avisa a BCB, que **confirma la tarjeta de viaje**, guarda la hora real de llegada y —esto es lo que le importa a operación— **libera al autobús y al operador en la terminal destino**, listos para su siguiente asignación.',
    'Antes esa confirmación dependía de que alguien la capturara. Con la geocerca ocurre sola, con la hora real, y el tablero de la torre de control deja de tener corridas abiertas que ya llegaron.',
  ],

  reglas: [
    'La llegada **no tiene ventana de tiempo**: se toma el primer cruce de entrada a la geocerca de destino.',
    'BCB confirma la tarjeta, marca la corrida como confirmada y mueve autobús y operador a la terminal destino, disponibles.',
    'Si alguien ya confirmó la tarjeta **a mano** —abordaje móvil, operación—, el evento no vuelve a mover nada: el autobús pudo haber sido reasignado a otra corrida.',
    'Se rechaza (409) una geocerca que corresponde a **otra terminal**: una geocerca mal mapeada no debe mover la unidad a un destino equivocado.',
    'Un reintento no duplica el registro ni pisa la llegada original.',
    '**Punto abierto a revisar con BCB:** BCB valida que la estación destino del aviso sea la de la ruta, pero el evento que arma adapter-bcb llega al satélite con ese campo **vacío**. Con el viaje dado de alta por la cadena completa, la confirmación se rechaza; con el alta «directo al satélite» —que sí lleva la estación— el ciclo cierra. Es un campo que falta en `TravelCardRelayService.buildViajePayload`.',
  ],

  actores: [A('unidad'), A('inroute'), A('satelite'), A('adapterTt'), A('jetstream'), A('adapterBcb'), A('appBcb'), A('bdBcb')],
  pasos: [
    { de: 'unidad', a: 'inroute', texto: 'La unidad entra a la geocerca de destino', detalle: 'El GPS reporta la entrada (nTipo = 1)' },
    { de: 'inroute', a: 'satelite', texto: 'TomTom empuja el evento al webhook', detalle: 'POST /tomtom/eventos-geocerca (202 · regla <5 s del DCU)' },
    { de: 'satelite', a: 'adapter-tomtom', texto: 'Avisa la llegada', detalle: 'POST /tomtom/tarjetas-viaje/{tarjeta}/confirmar-llegada' },
    { de: 'adapter-tomtom', a: 'jetstream', texto: 'Se encola durable', detalle: 'TOMTOM_GEOCERCAS_STREAM' },
    { de: 'jetstream', a: 'adapter-bcb', texto: 'Lo toma el adaptador de BCB', detalle: '' },
    { de: 'adapter-bcb', a: 'app-bcb', texto: 'Confirma la llegada en BCB', detalle: 'POST /tarjetas-viaje/{id}/confirmar-llegada' },
    { de: 'app-bcb', a: 'bd-bcb', texto: 'Tarjeta confirmada, unidad liberada', detalle: 'Bus y operador quedan disponibles en la terminal destino' },
  ],

  campos: [
    { name: 'claveERP', label: 'Tarjeta de viaje (BCB)', tipo: 'text', doc: 'la corrida que llega a destino' },
    {
      name: 'desfaseMinutos',
      label: 'Cruce respecto a la salida programada (min)',
      tipo: 'number',
      doc: 'la llegada no tiene ventana: cualquier valor se acepta',
    },
  ],

  entradas: [
    {
      id: 'adapter',
      label: 'Desde el proceso programado',
      ayuda: 'Publica biger.tomtom.geocercas.sync, igual que el cron de las 30 minutos.',
    },
    { id: 'satelite', label: 'Directo al satélite', ayuda: 'Dispara el polling llamando al satélite, saltando la mensajería.' },
  ],

  sql: [
    {
      id: 'llegada',
      titulo: 'La llegada quedó confirmada en BCB',
      base: 'bcb',
      descripcion:
        'La tarjeta pasa a confirmada y la corrida guarda su hora real de llegada. Si esto aparece, el ciclo se cerró solo, sin captura manual.',
      query: `SELECT tc.status           AS "estado de la tarjeta",
       tc."confirmedAt"    AS "confirmada el",
       t.status            AS "estado de la corrida",
       t."realDepartureAt" AS "salida real",
       t."realArrivalAt"   AS "llegada real"
FROM "TravelCard" tc
JOIN "Trip" t ON t.id = tc."tripId"
WHERE tc.id = '{{claveERP}}'`,
    },
    {
      id: 'unidad',
      titulo: 'El autobús y el operador quedaron libres en destino',
      base: 'bcb',
      descripcion:
        'Lo que operación mira: la unidad ya no está "en viaje" y aparece en la terminal a la que llegó, disponible para su siguiente corrida.',
      query: `SELECT b."economicNumber" AS "autobus",
       b.status           AS "estado del autobus",
       eb."shortName"     AS "autobus en",
       o.key              AS "operador",
       o."tripStatus"     AS "estado del operador",
       eo."shortName"     AS "operador en"
FROM "TravelCard" tc
JOIN "Trip" t ON t.id = tc."tripId"
JOIN "TripDispatch" td ON td."tripId" = t.id
JOIN "Bus" b ON b.id = td."busId"
JOIN "Operator" o ON o.id = td."operatorId"
LEFT JOIN "Station" eb ON eb.id = b."stationId"
LEFT JOIN "Station" eo ON eo.id = o."stationId"
WHERE tc.id = '{{claveERP}}'`,
    },
  ],
};

// ── 5 · Catálogos de InRoute ───────────────────────────────────────────────
const catalogos = {
  id: 'catalogos',
  numero: 5,
  nombre: 'Catálogos de InRoute',
  alias: 'Consultas',
  metodo: 'GET',
  ruta: '/tomtom/{catálogo}',
  auth: 'JWT RS256 (firmado por adapter-tomtom)',
  quienLlama: 'BIGER, cuando necesita resolver una equivalencia',
  direccion: 'BIGER → InRoute',
  resumen: 'Las unidades, operadores, grupos y geocercas que InRoute conoce — que es contra lo que BIGER traduce cada corrida.',

  explicacion: [
    'InRoute tiene sus propios identificadores: la unidad 9006 de Estrella Roja es *la unidad 732* para TomTom, y el operador 305889 es *el conductor 1841*.',
    'El satélite publica esos catálogos tal como los devuelve el proveedor. No los guarda: pregunta y reenvía. Así, cuando una corrida no cuadra, se puede ver en un clic si la unidad existe del lado de TomTom y con qué número.',
    'La única excepción es el **grupo** —la combinación de unidad y operador—: ése sí se cachea, porque se necesita en cada alta de viaje y no cambia entre corridas.',
  ],

  reglas: [
    'El satélite no persiste catálogos: cada consulta va a InRoute en el momento.',
    'Las coordenadas de InRoute vienen **multiplicadas por 10⁶**: `19074661` es `19.074661`.',
    'Si InRoute rechaza las credenciales cinco veces seguidas, el satélite se **autobloquea 15 minutos** y las consultas fallan localmente, sin salir a la red. Es un fusible: evita que un cambio de contraseña se convierta en cientos de intentos fallidos contra el proveedor.',
    'Estos endpoints son de solo lectura y no tocan ninguna base de datos.',
  ],

  actores: [A('adapterTt'), A('satelite'), A('inroute')],
  pasos: [
    { de: 'adapter-tomtom', a: 'satelite', texto: 'Se pide el catálogo', detalle: 'GET /tomtom/vehiculos · /conductores · /grupos · /geocercas-catalogo' },
    { de: 'satelite', a: 'inroute', texto: 'El satélite pregunta a InRoute', detalle: 'La respuesta se reenvía tal cual, sin guardarse' },
  ],
  respuestaDeVuelta: true,

  campos: [],

  entradas: [
    { id: 'vehiculos', label: 'Unidades', ayuda: 'Las unidades que InRoute conoce, con su número económico y su posición actual.' },
    { id: 'conductores', label: 'Operadores', ayuda: 'Los conductores registrados, con la clave que usa BCB.' },
    { id: 'grupos', label: 'Grupos', ayuda: 'La combinación unidad + operador que InRoute exige para dar de alta un viaje.' },
    { id: 'geocercas-catalogo', label: 'Geocercas', ayuda: 'Los perímetros configurados: son los que disparan el despacho y la llegada.' },
  ],

  sql: [
    {
      id: 'grupos',
      titulo: 'Los grupos que el satélite ya tenía cacheados',
      base: 'satelite',
      descripcion:
        'Único catálogo que se guarda. Se llena la primera vez que se resuelve un par unidad+operador y se reutiliza en cada corrida siguiente.',
      query: `SELECT "nVehicleId" AS "unidad en InRoute",
       "nDriverId"  AS "conductor en InRoute",
       "nGroupId"   AS "grupo en InRoute",
       "createdAt"  AS "resuelto el"
FROM "TomTomGroup"
ORDER BY "createdAt" DESC`,
    },
  ],
};

// ── 6 · Telemetría del viaje terminado ─────────────────────────────────────
const telemetria = {
  id: 'telemetria',
  numero: 6,
  nombre: 'Telemetría del viaje',
  alias: 'Cierre',
  metodo: 'Proceso programado',
  ruta: 'Lambda tomtomSync · cada 30 minutos',
  auth: 'Interno (no expuesto por HTTP)',
  quienLlama: 'Un reloj: EventBridge',
  direccion: 'InRoute → BIGER',
  resumen: 'Cuando TomTom da el viaje por terminado, BIGER descarga el recorrido: kilómetros, combustible, velocidades y tiempos.',

  explicacion: [
    'Terminado el viaje, InRoute consolida lo que midió el GPS durante el trayecto: distancia recorrida, litros consumidos, rendimiento, velocidad promedio y máxima, cuánto duró y cuánto tiempo estuvo detenida la unidad.',
    'Un proceso programado del satélite revisa cada 30 minutos qué viajes ya cerraron del lado del proveedor y **descarga esos datos una sola vez**, para que queden disponibles en la plataforma sin depender de que alguien entre a consultarlos.',
    'De ahí salen los indicadores operativos del documento: rendimiento por unidad, kilómetros de vacío, unidades con retraso, insumos para el FOC y el reporte de ingresos.',
  ],

  reglas: [
    'Solo se descarga cuando InRoute reporta el viaje como **terminado** (`nStatusViaje = 6`). Un viaje en curso se salta y se vuelve a mirar en la siguiente pasada.',
    'La telemetría se guarda **una sola vez por viaje**; una segunda pasada no la duplica.',
    'Se procesa de a 50 viajes por corrida, con corte a los 250 segundos para no exceder el tiempo máximo de la función.',
    'Los viajes marcados como fallidos quedan fuera hasta que se reintenten.',
    'Este proceso no tiene endpoint HTTP: en AWS lo dispara el reloj. Acá se ejecuta el mismo código, a mano.',
  ],

  actores: [A('inroute'), A('satelite'), A('bdSat')],
  pasos: [
    { de: 'inroute', a: 'satelite', texto: 'Se pregunta por los viajes ya cerrados', detalle: 'GET /viajes — se toman los que están en estado terminado' },
    { de: 'satelite', a: 'bd-sat', texto: 'Se guarda el recorrido', detalle: 'TomTomTripData: km, litros, rendimiento, velocidades y tiempos' },
  ],

  campos: [
    { name: 'claveERP', label: 'Tarjeta de viaje (BCB)', tipo: 'text', doc: 'el viaje que se va a cerrar' },
    { name: 'nDistanciaRecorrida', label: 'Distancia recorrida (km)', tipo: 'number', doc: 'lo que reportaría InRoute' },
    { name: 'nConsumoGasolina', label: 'Combustible (litros)', tipo: 'number', doc: '' },
    { name: 'nRendimientoGasolina', label: 'Rendimiento (km/litro)', tipo: 'number', doc: '' },
    { name: 'nVelocidadPromedio', label: 'Velocidad promedio (km/h)', tipo: 'number', doc: '' },
    { name: 'nVelocidadMaxima', label: 'Velocidad máxima (km/h)', tipo: 'number', doc: '' },
    { name: 'nTiempoDuracion', label: 'Duración (min)', tipo: 'number', doc: '' },
    { name: 'nTiempoParado', label: 'Tiempo detenido (min)', tipo: 'number', doc: '' },
  ],

  sql: [
    {
      id: 'telemetria',
      titulo: 'El recorrido quedó guardado',
      base: 'satelite',
      descripcion:
        'Estos son los datos con los que después se arman los indicadores de operación. Si el renglón aparece, el viaje cerró y su telemetría ya está en BIGER.',
      query: `SELECT t."travelCardId"      AS "tarjeta de viaje",
       t."nTripId"           AS "id en InRoute",
       d."tripStatus"        AS "estado en InRoute",
       d."departureReal"     AS "salida real",
       d."arrivalReal"       AS "llegada real",
       d."distanceKm"        AS "km recorridos",
       d."fuelLiters"        AS "litros",
       d."fuelEfficiencyKmL" AS "km por litro",
       d."avgSpeedKmh"       AS "velocidad promedio",
       d."maxSpeedKmh"       AS "velocidad maxima",
       d."durationMinutes"   AS "duracion (min)",
       d."stoppedMinutes"    AS "detenido (min)"
FROM "TomTomTripData" d
JOIN "TomTomTrip" t ON t.id = d."tripId"
WHERE t."travelCardId" = '{{claveERP}}'`,
    },
  ],
};

const SERVICIOS = [alta, cambios, cu04, cu05, catalogos, telemetria];

module.exports = { SERVICIOS, ACTORES };
