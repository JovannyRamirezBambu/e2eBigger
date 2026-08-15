#!/usr/bin/env node
/**
 * Panel de DEMOSTRACIÓN de los 3 servicios del satélite Venta a Bordo
 * (contrato TI-FT-45 con TECNITRANS/SmartMac).
 *
 *   ./e2e demo            →  http://localhost:7788
 *
 * No es el panel de diagnóstico (`./e2e ui`, :7777). Aquél sirve para depurar el
 * harness; éste sirve para **explicar el flujo a otras personas**: un servicio a
 * la vez, con su diagrama, los datos editables, la petición y la respuesta a la
 * vista, y el SQL que demuestra que el dato quedó guardado en BCB.
 *
 * Sin dependencias, y a propósito **sin capa TypeScript**: durante una reunión lo
 * que importa es que arranque al instante y que un valor se pueda cambiar en
 * caliente. La detección de cambios de contrato (payloads tipados con los DTOs
 * reales) vive en el harness de pruebas, `src/` — que es donde tiene sentido.
 *
 * Requiere el stack arriba:  ./e2e up ventaabordo  &&  ./e2e seed ventaabordo
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { SERVICIOS } = require('./services.cjs');

const E2E_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(__dirname, 'public');
const RUN_DIR = path.join(E2E_ROOT, 'run');
const KEYS_DIR = path.join(RUN_DIR, 'keys');
const LOG_DIR = path.join(RUN_DIR, 'logs');
const CONFIG_FILE = path.join(RUN_DIR, 'demo-config.json');

const PORT = Number(process.env.E2E_DEMO_PORT || 7788);

// ── Configuración ──────────────────────────────────────────────────────────
// Todo lo que se puede cambiar en vivo desde el panel. Se persiste en `run/`
// (gitignored) para que sobreviva a un reinicio del panel a media reunión.
const CONFIG_DEFAULT = {
  satelite: 'http://localhost:3001/venta-abordo',
  adapterBcb: 'http://localhost:8085',
  smartmac: {
    // 'simulado' → contestamos nosotros.  'real' → se reenvía a TECNITRANS.
    modo: 'simulado',
    url: 'http://er-smartmac.dyndns.org:5056/WS/Papeletascloud.php',
    usuario: '',
    password: '',
    // El satélite lee esta dirección al arrancar (SMARTMAC_WS1_URL en su .env),
    // así que el puerto es fijo: lo escribe `flows/ventaabordo/flow.sh`.
    puertoEscucha: Number(process.env.E2E_FAKE_SMARTMAC_PORT || 7801),
    timeoutMs: 15000,
  },
  // Credencial ENTRANTE: la que SmartMac usa para llamarnos (servicios 2 y 3).
  // La escribe el harness en el .env del satélite; estos son sus valores.
  smartmacEntrante: {
    usuario: process.env.SMARTMAC_INBOUND_USER || 'e2e-smartmac',
    password: process.env.SMARTMAC_INBOUND_PASS || 'e2e-smartmac-local',
  },
};

function cargarConfig() {
  try {
    const guardada = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    return {
      ...CONFIG_DEFAULT,
      ...guardada,
      smartmac: { ...CONFIG_DEFAULT.smartmac, ...(guardada.smartmac || {}) },
      smartmacEntrante: { ...CONFIG_DEFAULT.smartmacEntrante, ...(guardada.smartmacEntrante || {}) },
    };
  } catch {
    return JSON.parse(JSON.stringify(CONFIG_DEFAULT));
  }
}

function guardarConfig() {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

let config = cargarConfig();

// ── Firma del JWT que BCB usa para llamar a WS1 ────────────────────────────
// Espeja `bcbSystemToken()` de src/flows/ventaabordo/cases.ts: el guard del
// satélite exige un RS256 con `sub: bcb-system`, un `userType` válido y un
// `userToken` interno (el del usuario final). Con crypto de Node basta — no hace
// falta traer una librería para un panel local.
const b64url = (buf) => Buffer.from(buf).toString('base64url');

function firmarJwt(claims, ttlSegundos = 600) {
  const pem = fs.readFileSync(path.join(KEYS_DIR, 'bcb-to-va-private-pkcs8.pem'), 'utf-8');
  const ahora = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: ahora, exp: ahora + ttlSegundos, ...claims }));
  const firma = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), pem);
  return `${header}.${payload}.${b64url(firma)}`;
}

function tokenBcb() {
  const interno = firmarJwt({ sub: 'usuario-demo' });
  return firmarJwt({ sub: 'bcb-system', name: 'BCB', userType: 'advisor', userToken: interno });
}

const basic = (usuario, password) =>
  `Basic ${Buffer.from(`${usuario}:${password}`).toString('base64')}`;

const authSmartmacEntrante = () =>
  basic(config.smartmacEntrante.usuario, config.smartmacEntrante.password);

// ── SmartMac: simulador y proxy hacia el real ──────────────────────────────
/**
 * El satélite siempre apunta acá (`SMARTMAC_WS1_URL` de su .env). Este proceso
 * decide qué hacer con lo que llega:
 *
 *   modo 'simulado'  → contesta como el SmartMac real, sin salir a internet.
 *   modo 'real'      → lo reenvía a TECNITRANS y devuelve SU respuesta, verbatim.
 *
 * Conmutar es instantáneo y no reinicia el satélite: por eso el panel puede
 * enseñar el mismo despacho contra el simulador y contra el real, seguido.
 * El payload que se ve aquí lo construyó el código real del satélite, no el panel.
 */
const smartmacRecibidos = [];

async function reenviarASmartmacReal(cuerpo) {
  const { url, usuario, password, timeoutMs } = config.smartmac;
  const headers = { 'Content-Type': 'application/json' };
  if (usuario) headers.Authorization = basic(usuario, password);
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const texto = await res.text();
  return {
    url,
    status: res.status,
    ms: Date.now() - t0,
    body: parseJson(texto, texto),
    headers: { ...headers, ...(usuario ? { Authorization: `Basic ${usuario}:***` } : {}) },
  };
}

function servidorSmartmac() {
  return http.createServer((req, res) => {
    let crudo = '';
    req.on('data', (c) => (crudo += c));
    req.on('end', async () => {
      const cuerpo = parseJson(crudo, crudo);
      const registro = {
        at: new Date().toISOString(),
        modo: config.smartmac.modo,
        path: req.url || '',
        headersRecibidos: req.headers,
        // Éste es el dato de oro de la demostración: el payload EXACTO que el
        // satélite le manda a TECNITRANS, en el formato de TECNITRANS.
        payloadEnviado: cuerpo,
        reenvio: null,
        respuesta: null,
      };

      let respuesta;
      let status = 200;
      if (config.smartmac.modo === 'real') {
        try {
          const r = await reenviarASmartmacReal(cuerpo);
          registro.reenvio = r;
          respuesta = r.body;
          // El status HTTP del real se propaga tal cual al satélite: si SmartMac
          // devuelve 500, el satélite debe verlo igual que en producción.
          status = r.status;
        } catch (e) {
          registro.reenvio = { url: config.smartmac.url, error: String(e && e.message ? e.message : e) };
          respuesta = { responseCode: '500', mensaje: `No se pudo contactar a SmartMac: ${registro.reenvio.error}` };
          status = 502;
        }
      } else {
        // Formato del real: HTTP 200 y el veredicto en `responseCode`.
        respuesta = {
          responseCode: '200',
          mensaje: 'Operacion registrada exitosamente',
          tripId: cuerpo && cuerpo.clave_corrida,
          travelCardNumber: cuerpo && cuerpo.id_tarjeta_viaje,
        };
      }

      registro.respuesta = { status, body: respuesta };
      smartmacRecibidos.push(registro);
      if (smartmacRecibidos.length > 200) smartmacRecibidos.shift();

      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(respuesta));
    });
  });
}

// ── Utilidades ─────────────────────────────────────────────────────────────
function parseJson(texto, fallback) {
  try {
    return JSON.parse(texto);
  } catch {
    return fallback;
  }
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** Oculta la contraseña de un `Basic` para que se pueda proyectar en pantalla. */
function headersVisibles(headers) {
  const salida = { ...headers };
  if (salida.Authorization && salida.Authorization.startsWith('Basic ')) {
    const [usuario] = Buffer.from(salida.Authorization.slice(6), 'base64').toString().split(':');
    salida.Authorization = `Basic ${usuario}:••••••`;
  }
  if (salida.Authorization && salida.Authorization.startsWith('Bearer ')) {
    salida.Authorization = `Bearer ${salida.Authorization.slice(7, 27)}… (JWT RS256)`;
  }
  return salida;
}

/** Una llamada HTTP registrada para mostrarla completa en el panel. */
async function llamar(metodo, url, { headers = {}, body, timeoutMs = 20000 } = {}) {
  const t0 = Date.now();
  const opciones = { method: metodo, headers, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) {
    opciones.body = JSON.stringify(body);
    opciones.headers = { 'Content-Type': 'application/json', ...headers };
  }
  try {
    const res = await fetch(url, opciones);
    const texto = await res.text();
    return {
      ok: res.status < 400,
      metodo,
      url,
      headers: headersVisibles(opciones.headers || headers),
      request: body === undefined ? null : body,
      status: res.status,
      ms: Date.now() - t0,
      response: parseJson(texto, texto || null),
    };
  } catch (e) {
    return {
      ok: false,
      metodo,
      url,
      headers: headersVisibles(opciones.headers || headers),
      request: body === undefined ? null : body,
      status: 0,
      ms: Date.now() - t0,
      error: String(e && e.message ? e.message : e),
      response: null,
    };
  }
}

// ── SQL ────────────────────────────────────────────────────────────────────
const BASES = {
  bcb: {
    etiqueta: 'Base de datos de BCB',
    contenedor: 'bcb-local-db',
    usuario: 'bcb',
    base: 'bcb',
  },
  satelite: {
    etiqueta: 'Base del satélite Venta a Bordo',
    contenedor: 'biger_estrellaroja_ventaabordo-db-1',
    usuario: 'venta',
    base: 'venta_abordo',
  },
};

/**
 * Corre una consulta de LECTURA y devuelve filas como objetos.
 *
 * Solo `SELECT`/`WITH`: el panel se proyecta en una reunión y nadie debería poder
 * escribir en la base desde ahí, ni por accidente. La consulta se envuelve en
 * `json_agg` para no tener que parsear la salida tabular de psql.
 */
function correrSql(baseId, sql) {
  const base = BASES[baseId];
  if (!base) return Promise.reject(new Error(`base desconocida: ${baseId}`));

  const limpia = sql.trim().replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(limpia)) {
    return Promise.reject(new Error('solo se permiten consultas de lectura (SELECT o WITH)'));
  }
  if (limpia.includes(';')) {
    return Promise.reject(new Error('una sola consulta por vez (se encontró un ";" intermedio)'));
  }

  const envuelta = `SELECT coalesce(json_agg(t), '[]'::json)::text FROM (${limpia}) t`;
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      ['exec', base.contenedor, 'psql', '-U', base.usuario, '-d', base.base, '-tA', '-c', envuelta],
      { maxBuffer: 16 << 20 },
      (err, stdout, stderr) => {
        if (err) {
          const detalle = (stderr || String(err)).split('\n').filter(Boolean).slice(0, 4).join(' · ');
          return reject(new Error(detalle || 'psql falló'));
        }
        const filas = parseJson(stdout.trim(), null);
        if (!Array.isArray(filas)) return reject(new Error('respuesta inesperada de psql'));
        resolve(filas);
      },
    );
  });
}

/** Sustituye `{{campo}}` con los valores del escenario en curso. */
function resolverSql(plantilla, valores) {
  return plantilla.replace(/\{\{(\w+)\}\}/g, (_, clave) =>
    valores[clave] === undefined || valores[clave] === null ? 'NULL' : String(valores[clave]),
  );
}

// ── Datos de demostración ──────────────────────────────────────────────────
/**
 * Genera una corrida nueva con la forma de los ejemplos del documento
 * (folio de tarjeta `180001…`, clave de corrida `…I0445N…`, folio de 22
 * caracteres), pero con un sufijo derivado del reloj para que **dos ejecuciones
 * seguidas en vivo nunca choquen** — ni entre sí ni con datos reales.
 */
function nuevoEscenario() {
  const n = Date.now() % 1_000_000;
  const sufijo = String(n).padStart(6, '0');
  const travelCardNumber = 180_001_000_000 + n;
  const tripId = `DEMOI0445N${sufijo}`;
  return {
    tripId,
    tripNumericId: 1_300_000_000 + n,
    travelCardNumber,
    // 22 caracteres exactos, como `TAPOI0900N180001693461` del documento:
    // 10 de la clave de corrida + 12 del folio de la tarjeta.
    folioTarjeta: `DEMOI0445N${travelCardNumber}`,
    ventaId: 900_000_000 + n,
    folioBase: 293_700_000 + n * 10,
  };
}

const ahoraIso = () => new Date().toISOString().slice(0, 19);

function payloadWs1(e) {
  return {
    busEconomicNumber: '9001',
    dispatchedAt: ahoraIso(),
    operatorKey: 303809,
    tripId: e.tripId,
    originStationNumber: 18,
    destinationStationNumber: 21,
    serviceNumber: 4,
    routeNumber: 117,
    tripNumericId: e.tripNumericId,
    travelCardNumber: e.travelCardNumber,
    travelCardId: String(e.travelCardNumber),
  };
}

function payloadWs2(e) {
  const boleto = (i, extra) => ({
    folioPreimpreso: e.folioBase + i,
    fechaHoraVenta: ahoraIso(),
    importeBoleto: 150,
    numeroAsiento: i + 1,
    tarifaId: 98950,
    tramoId: 20704,
    tipoPasajero: 'ADULTO',
    // TI-FT-45 lo pide "solo si tipoPago = CANJE", pero BCB lo exige en TODOS los
    // renglones (`BoardingSaleItemDto.boletoExternoId`: @IsInt @Min(1), sin
    // @IsOptional). Un renglón EFECTIVO sin este campo lo acepta el satélite y
    // después muere con 400 en la DLQ, sin que SmartMac se entere. Va en todos
    // para que la demostración recorra el camino feliz; la divergencia está
    // anotada en las reglas del servicio.
    boletoExternoId: e.folioBase + i,
    ...extra,
  });
  return {
    id: e.ventaId,
    corridaId: e.tripNumericId,
    claveCorrida: e.tripId,
    operador: '303809',
    rutaId: 117,
    tarjetaViajeId: e.travelCardNumber,
    montoTotalVenta: 450,
    totalBoletosVendidos: 3,
    estatusCorrida: 'CERRADA',
    estatusTarjeta: 'CERRADA',
    folioTarjeta: e.folioTarjeta,
    fechaCreacion: ahoraIso(),
    detalleVenta: [
      boleto(0, { tipoPago: 'EFECTIVO', codigoFacturacion: '582fae142f4e' }),
      boleto(1, { tipoPago: 'PREPAGO', tarjetaPrepago: 'C1EC3E03' }),
      boleto(2, { tipoPago: 'CANJE', boletoExternoId: e.folioBase + 900 }),
    ],
  };
}

/**
 * El servicio 3 lee de BCB, no del satélite, así que sus datos no salen de una
 * corrida recién despachada: salen del catálogo que siembra `./e2e seed
 * ventaabordo` (ver src/flows/ventaabordo/consulta-scenarios.ts).
 */
const payloadConsulta = () => ({ numeroOperador: 'E2EVACO-OP-1', caja: 'E2EVACO-CAJA-1' });

function payloadPorDefecto(servicioId, escenario) {
  if (servicioId === 'ws1') return payloadWs1(escenario);
  if (servicioId === 'ws2') return payloadWs2(escenario);
  return payloadConsulta();
}

// ── Ejecución de cada servicio ─────────────────────────────────────────────
/**
 * Servicio 1. Dos entradas posibles a la MISMA cadena:
 *
 *  · `bcb`      → POST /bcb/travel-cards/despachar en adapter-bcb. Ese endpoint
 *                 es un relay puro (no valida nada contra la base de BCB), así que
 *                 pegarle es **exactamente** disparar el evento que BCB dispara al
 *                 despachar una corrida — no una simulación degradada. Recorre los
 *                 5 saltos. Responde 204 sin esperar: la confirmación se observa
 *                 en SmartMac y en la base del satélite.
 *  · `satelite` → POST /corrida/despachar directo, con el JWT de BCB. Salta la
 *                 mensajería interna; sirve para aislar al satélite si la cadena
 *                 falla en algún eslabón intermedio.
 */
async function ejecutarWs1(payload, opciones) {
  const entrada = opciones.entrada === 'satelite' ? 'satelite' : 'bcb';
  const pasos = [];
  const recibidosAntes = smartmacRecibidos.length;

  if (entrada === 'bcb') {
    pasos.push({
      titulo: 'BCB despacha la corrida',
      nota: 'Mismo evento que BCB emite al despachar. adapter-bcb lo publica en la mensajería interna y contesta sin esperar.',
      http: await llamar('POST', `${config.adapterBcb}/bcb/travel-cards/despachar`, { body: payload }),
    });
  } else {
    pasos.push({
      titulo: 'Llamada directa a WS1 del satélite',
      nota: 'Se omite la mensajería interna de BIGER; el satélite recibe el despacho tal cual.',
      http: await llamar('POST', `${config.satelite}/corrida/despachar`, {
        headers: { Authorization: `Bearer ${tokenBcb()}` },
        body: payload,
      }),
    });
  }

  // Observación: ¿llegó a SmartMac? Es el punto que le importa a TECNITRANS.
  const llegada = await esperarLlegadaSmartmac(payload.tripId, recibidosAntes, entrada === 'bcb' ? 25000 : 8000);
  if (llegada) {
    pasos.push({
      titulo:
        llegada.modo === 'real'
          ? 'SmartMac REAL recibió la tarjeta de viaje'
          : 'SmartMac recibió la tarjeta de viaje (simulado)',
      nota: 'Éste es el payload exacto que sale hacia TECNITRANS, ya traducido a su formato por el satélite.',
      smartmac: llegada,
    });
  } else {
    pasos.push({
      titulo: 'SmartMac no recibió nada',
      error: true,
      nota: 'El despacho no completó la cadena.',
      diagnostico: await diagnosticar(entrada),
    });
  }

  // Observación: ¿quedó registrada la tarjeta en el satélite?
  const tarjeta = await esperarFila(
    'satelite',
    `SELECT "estado"               AS "estado de la tarjeta",
            "fechaEnvioSmartmac"   AS "enviada a SmartMac",
            "intentosEnvioSmartmac" AS "intentos de envio",
            "ultimoErrorSmartmac"  AS "ultimo error"
     FROM "TarjetaViaje" WHERE "idTarjetaViaje" = ${Number(payload.travelCardNumber)}`,
    12000,
  );
  const confirmada = tarjeta && tarjeta['enviada a SmartMac'];
  pasos.push(
    tarjeta
      ? {
          titulo: confirmada
            ? 'La tarjeta quedó registrada y confirmada por SmartMac'
            : 'La tarjeta quedó registrada, pendiente de confirmar',
          nota: confirmada
            ? 'El satélite solo pone esta fecha cuando SmartMac aceptó el despacho.'
            : 'SmartMac no la aceptó todavía. La corrida no se pierde: el reintento programado la volverá a enviar.',
          datos: tarjeta,
        }
      : {
          titulo: 'La tarjeta no llegó a registrarse en el satélite',
          error: true,
          nota: 'El despacho no alcanzó al satélite.',
          diagnostico: await diagnosticar(entrada),
        },
  );

  return { pasos, valores: payload };
}

/** Servicio 2: SmartMac reporta la venta y ésta debe terminar en BCB. */
async function ejecutarWs2(payload) {
  const pasos = [];

  pasos.push({
    titulo: 'SmartMac reporta la venta de la corrida',
    nota: 'Llamada entrante con credencial HTTP Basic, igual que la que hace el equipo a bordo al cerrar el viaje.',
    http: await llamar('POST', `${config.satelite}/venta/recaudacion`, {
      headers: { Authorization: authSmartmacEntrante() },
      body: payload,
    }),
  });

  if (!pasos[0].http.ok) {
    pasos[0].error = true;
    if (pasos[0].http.status === 404) {
      pasos[0].nota =
        'La tarjeta de viaje referenciada no existe. Hay que despachar la corrida primero — es el Servicio 1.';
    }
    return { pasos, valores: payload };
  }

  // El salto a BCB es asíncrono; es normal que tarde unos segundos.
  const venta = await esperarFila(
    'bcb',
    `SELECT s."tripKey"          AS "clave de corrida",
            s."operatorKey"      AS "operador",
            s."cardFolio"        AS "folio de tarjeta",
            s."totalAmount"      AS "monto total",
            s."totalTicketsSold" AS "boletos vendidos",
            count(i.id)          AS "renglones guardados"
     FROM "BoardingSale" s
     LEFT JOIN "BoardingSaleItem" i ON i."boardingSaleId" = s.id
     WHERE s."smartmacId" = ${Number(payload.id)}
     GROUP BY s.id`,
    45000,
  );

  pasos.push(
    venta
      ? {
          titulo: 'La venta llegó hasta BCB',
          nota: 'Recorrió el satélite, la cola de mensajería y el adaptador de BCB, y quedó guardada con todos sus boletos.',
          datos: venta,
        }
      : {
          titulo: 'La venta no llegó a BCB',
          error: true,
          nota: 'El satélite la aceptó pero no terminó de asentarse en BCB.',
          diagnostico: await diagnosticar('ws2'),
        },
  );

  return { pasos, valores: payload };
}

/** Servicio 3: consulta de las corridas del día de un operador. */
async function ejecutarConsulta(payload) {
  const qs = new URLSearchParams({
    numeroOperador: String(payload.numeroOperador ?? ''),
    caja: String(payload.caja ?? ''),
  });
  const http1 = await llamar('GET', `${config.satelite}/corrida/operador?${qs}`, {
    headers: { Authorization: authSmartmacEntrante() },
    timeoutMs: 25000,
  });

  const cuerpo = http1.response || {};
  const semaforo = cuerpo.semaforo || null;
  const corridas = Array.isArray(cuerpo.corridas) ? cuerpo.corridas : [];

  const pasos = [
    {
      titulo: 'El equipo a bordo pregunta por sus corridas del día',
      nota: 'La pregunta llega al satélite, que se la reenvía a BCB por la mensajería interna y devuelve la respuesta por el mismo camino.',
      http: http1,
    },
  ];

  const explicacionSemaforo = {
    VERDE: `Se encontraron ${corridas.length} corrida(s) para hoy. El equipo ya puede operar.`,
    AMARILLO: 'El operador existe pero no tiene corridas programadas hoy.',
    ROJO: 'La caja o el operador no están registrados en BCB.',
  };

  if (semaforo) {
    pasos.push({
      titulo: `Semáforo ${semaforo}`,
      semaforo,
      nota:
        (explicacionSemaforo[semaforo] || cuerpo.mensaje || '') +
        ' Los rechazos de negocio no son errores HTTP: el servicio siempre responde 200 y el veredicto viaja en el semáforo.',
      datos: corridas.length
        ? corridas.map((c) => ({
            'clave de corrida': c.claveCorrida,
            hora: c.fechaHoraCorrida,
            origen: c.origen,
            destino: c.destino,
            'estado corrida': c.estadoCorrida,
            'folio tarjeta': c.folioTarjeta,
            'estado tarjeta': c.estadoTarjetaViaje,
            autobus: c.autobus,
          }))
        : null,
    });
  } else if (!http1.ok) {
    pasos[0].error = true;
    pasos[0].nota =
      http1.status === 401
        ? 'Credencial HTTP Basic rechazada — revisá usuario y contraseña en Configuración.'
        : pasos[0].nota;
    pasos.push({ titulo: 'Sin respuesta de negocio', error: true, diagnostico: await diagnosticar('consulta') });
  }

  return { pasos, valores: payload };
}

// ── Observación y diagnóstico ──────────────────────────────────────────────
async function esperarLlegadaSmartmac(claveCorrida, desde, timeoutMs) {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    const encontrado = smartmacRecibidos
      .slice(desde)
      .find((r) => !claveCorrida || (r.payloadEnviado && r.payloadEnviado.clave_corrida === claveCorrida));
    if (encontrado) return encontrado;
    await esperar(400);
  }
  return null;
}

async function esperarFila(baseId, sql, timeoutMs) {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    const filas = await correrSql(baseId, sql).catch(() => []);
    if (filas.length) return filas[0];
    await esperar(700);
  }
  return null;
}

/** Últimos errores de los servicios implicados, para no tener que ir al log. */
async function diagnosticar(contexto) {
  const porContexto = {
    bcb: ['adapter-bcb', 'adapter-ventaabordo', 'satelite-va'],
    satelite: ['satelite-va'],
    ws2: ['satelite-va', 'adapter-ventaabordo', 'adapter-bcb', 'bcb-webhooks'],
    consulta: ['satelite-va', 'adapter-ventaabordo', 'adapter-bcb', 'bcb-app'],
  };
  const servicios = porContexto[contexto] || porContexto.bcb;
  const errores = servicios.map((s) => ({ servicio: s, error: ultimoError(s) })).filter((e) => e.error);

  const pistas = [];
  const errorVa = errores.find((e) => e.servicio === 'adapter-ventaabordo');
  // Trampa conocida: `flows/ventaabordo/flow.sh` levanta adapter-ventaabordo sin
  // llave privada de SALIDA, así que su llamada a WS1 va sin `Authorization` y el
  // satélite responde 401. El harness no lo detecta porque sus propias pruebas de
  // WS1 le pegan al satélite directo, sin pasar por este adaptador.
  if (errorVa && /401|Token de acceso no proporcionado/i.test(errorVa.error)) {
    pistas.push(
      'adapter-ventaabordo no tiene configurada su llave de firma saliente, así que el satélite le responde 401. ' +
        'Corré antes de la demo: BIGER_EstrellaRoja_Main/bruno/venta-abordo-local/99 - Utilidades/reiniciar-adapter-ventaabordo-con-firma.sh',
    );
  }
  if (!errores.length) {
    pistas.push('Ningún servicio reportó error. Revisá que todo esté arriba: ./e2e status ventaabordo');
  }
  return { errores, pistas };
}

function ultimoError(servicio) {
  try {
    const lineas = fs.readFileSync(path.join(LOG_DIR, `${servicio}.log`), 'utf-8').split('\n').filter(Boolean);
    for (let i = lineas.length - 1; i >= 0 && i > lineas.length - 400; i--) {
      const cruda = lineas[i];
      const obj = parseJson(cruda, null);
      if (obj && String(obj.level).toUpperCase() === 'ERROR') return String(obj.message || '').slice(0, 300);
      if (!obj && /ERROR/.test(cruda)) return cruda.replace(/\x1b?\[[0-9;]*m/g, '').slice(0, 300);
    }
  } catch {
    /* sin log todavía */
  }
  return '';
}

// ── Estado del stack ───────────────────────────────────────────────────────
const arriba = async (url) => {
  const r = await llamar('GET', url, { timeoutMs: 2500 });
  return r.status > 0 && r.status < 500;
};

async function estado() {
  const [sat, adapterVa, adapterBcb, appBcb] = await Promise.all([
    arriba(`${config.satelite}/health`),
    arriba('http://localhost:8088/ventaabordo/health'),
    arriba(`${config.adapterBcb}/actuator/health`),
    arriba('http://localhost:3009/abordaje/trips'),
  ]);
  return {
    servicios: [
      { id: 'satelite', label: 'Satélite Venta a Bordo', up: sat },
      { id: 'adapter-ventaabordo', label: 'adapter-ventaabordo', up: adapterVa },
      { id: 'adapter-bcb', label: 'adapter-bcb', up: adapterBcb },
      { id: 'app-bcb', label: 'BCB (abordaje / webhooks)', up: appBcb },
      { id: 'smartmac', label: `SmartMac · ${config.smartmac.modo}`, up: true, modo: config.smartmac.modo },
    ],
    listo: sat && adapterVa && adapterBcb && appBcb,
  };
}

// ── API HTTP ───────────────────────────────────────────────────────────────
function json(res, code, cuerpo) {
  const datos = JSON.stringify(cuerpo);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(datos);
}

function leerCuerpo(req) {
  return new Promise((resolve) => {
    let crudo = '';
    req.on('data', (c) => (crudo += c));
    req.on('end', () => resolve(parseJson(crudo, {})));
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function estatico(res, ruta) {
  const rel = ruta === '/' ? 'index.html' : ruta.replace(/^\/+/, '');
  const destino = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!destino.startsWith(PUBLIC_DIR) || !fs.existsSync(destino) || !fs.statSync(destino).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('no encontrado');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(destino)] || 'application/octet-stream' });
  fs.createReadStream(destino).pipe(res);
}

/** La configuración que se manda al navegador nunca lleva contraseñas. */
function configPublica() {
  return {
    ...config,
    smartmac: { ...config.smartmac, password: config.smartmac.password ? '••••••' : '' },
    smartmacEntrante: { ...config.smartmacEntrante, password: '••••••' },
  };
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const ruta = url.pathname;

  try {
    if (ruta === '/api/servicios') {
      const escenario = nuevoEscenario();
      return json(res, 200, {
        servicios: SERVICIOS.map((s) => ({ ...s, payload: payloadPorDefecto(s.id, escenario) })),
        escenario,
      });
    }

    if (ruta === '/api/escenario') {
      const escenario = nuevoEscenario();
      return json(res, 200, {
        escenario,
        payloads: Object.fromEntries(SERVICIOS.map((s) => [s.id, payloadPorDefecto(s.id, escenario)])),
      });
    }

    if (ruta === '/api/estado') return json(res, 200, await estado());

    if (ruta === '/api/config' && req.method === 'GET') return json(res, 200, configPublica());

    if (ruta === '/api/config' && req.method === 'POST') {
      const cambios = await leerCuerpo(req);
      // Una contraseña enmascarada que vuelve del navegador no debe pisar la real.
      const limpiar = (nuevo, actual) => {
        const salida = { ...actual, ...nuevo };
        if (salida.password === '••••••') salida.password = actual.password;
        return salida;
      };
      config = {
        ...config,
        ...cambios,
        smartmac: limpiar(cambios.smartmac || {}, config.smartmac),
        smartmacEntrante: limpiar(cambios.smartmacEntrante || {}, config.smartmacEntrante),
      };
      guardarConfig();
      return json(res, 200, configPublica());
    }

    if (ruta === '/api/ejecutar' && req.method === 'POST') {
      const { servicio, payload, opciones = {} } = await leerCuerpo(req);
      const inicio = Date.now();
      let salida;
      if (servicio === 'ws1') salida = await ejecutarWs1(payload, opciones);
      else if (servicio === 'ws2') salida = await ejecutarWs2(payload);
      else if (servicio === 'consulta') salida = await ejecutarConsulta(payload);
      else return json(res, 400, { error: `servicio desconocido: ${servicio}` });
      return json(res, 200, { ...salida, ms: Date.now() - inicio, at: new Date().toISOString() });
    }

    if (ruta === '/api/sql' && req.method === 'POST') {
      const { base, sql, valores = {} } = await leerCuerpo(req);
      const resuelto = resolverSql(sql, valores);
      try {
        const filas = await correrSql(base, resuelto);
        return json(res, 200, { sql: resuelto, base, etiqueta: (BASES[base] || {}).etiqueta, filas });
      } catch (e) {
        return json(res, 200, { sql: resuelto, base, error: String(e.message || e), filas: [] });
      }
    }

    if (ruta === '/api/smartmac') {
      return json(res, 200, { recibidos: smartmacRecibidos.slice(-25).reverse() });
    }

    return estatico(res, ruta);
  } catch (e) {
    return json(res, 500, { error: String((e && e.message) || e) });
  }
});

// ── Arranque ───────────────────────────────────────────────────────────────
const listener = servidorSmartmac();
listener.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(
      `\n  ⚠  El puerto ${config.smartmac.puertoEscucha} (SmartMac) ya está ocupado.\n` +
        '     Suele ser el harness de pruebas corriendo en paralelo (./e2e test ventaabordo).\n' +
        '     Cerralo y volvé a abrir el panel: los dos no pueden escuchar el mismo puerto.\n',
    );
    process.exit(1);
  }
  throw e;
});
listener.listen(config.smartmac.puertoEscucha, '127.0.0.1', () => {
  servidor.listen(PORT, () => {
    console.log(`\n  Demo Venta a Bordo   →  http://localhost:${PORT}`);
    console.log(`  SmartMac escuchando  →  127.0.0.1:${config.smartmac.puertoEscucha} (modo: ${config.smartmac.modo})`);
    console.log('\n  Requiere el stack arriba:  ./e2e up ventaabordo  &&  ./e2e seed ventaabordo\n');
  });
});
