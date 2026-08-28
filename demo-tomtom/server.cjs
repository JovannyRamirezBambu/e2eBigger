#!/usr/bin/env node
/**
 * Panel de DEMOSTRACIÓN del satélite TomTom — el ciclo completo de una corrida
 * entre BCB e InRoute (Adsum), como lo describe `TI-FT-45_Documentación_técnica_TomTom`.
 *
 *   ./e2e demo tomtom      →  http://localhost:7789
 *
 * No es el panel de diagnóstico (`./e2e ui tomtom`, :7777). Aquél sirve para
 * depurar el harness; éste sirve para **explicar el flujo a otras personas**: un
 * momento del ciclo a la vez, con su diagrama, los datos editables, la petición y
 * la respuesta a la vista, y el SQL que demuestra que el dato quedó guardado.
 *
 * Sin dependencias propias y a propósito **sin capa TypeScript**: durante una
 * reunión lo que importa es que arranque al instante y que un valor se pueda
 * cambiar en caliente. Las dos cosas que no puede hacer solo se delegan al código
 * de quien corresponde: la corrida de demostración la crea el harness con el
 * Prisma de BCB (`tsx src/cli.ts tomtom demo-trip`), y la telemetría la corre el
 * satélite con su propio código compilado (`sync-runner.cjs`).
 *
 * Requiere el stack arriba:  ./e2e up tomtom  &&  ./e2e seed tomtom
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { SERVICIOS } = require('./services.cjs');
const {
  InrouteFalso,
  crearServidorInroute,
} = require('./inroute.cjs');

const E2E_ROOT = path.resolve(__dirname, '..');
const ER_ROOT = path.resolve(E2E_ROOT, '..');
const REPO_SAT = path.join(ER_ROOT, 'BIGER_EstrellaRoja_TomTom');
const REPO_MAIN = path.join(ER_ROOT, 'BIGER_EstrellaRoja_Main');
const PUBLIC_DIR = path.join(__dirname, 'public');
const RUN_DIR = path.join(E2E_ROOT, 'run');
const KEYS_DIR = path.join(RUN_DIR, 'keys');
const LOG_DIR = path.join(RUN_DIR, 'logs');
const CONFIG_FILE = path.join(RUN_DIR, 'demo-tomtom-config.json');
const ESCENARIO_FILE = path.join(RUN_DIR, 'demo-tomtom-escenario.json');

const PORT = Number(process.env.E2E_DEMO_TOMTOM_PORT || 7789);

// ── Configuración ──────────────────────────────────────────────────────────
// Todo lo que se puede cambiar en vivo desde el panel. Se persiste en `run/`
// (gitignored) para que sobreviva a un reinicio del panel a media reunión.
const CONFIG_DEFAULT = {
  satelite: 'http://localhost:3003',
  adapterTomtom: 'http://localhost:8090',
  adapterBcb: 'http://localhost:8085',
  inroute: {
    // 'simulado' → contesta este panel.  'real' → se reenvía a Adsum.
    modo: 'simulado',
    url: 'http://inrouteapi.adsum.com.mx/api',
    usuario: '',
    password: '',
    // El satélite lee esta dirección al arrancar (INROUTE_BASE_URL en su .env),
    // así que el puerto es fijo: lo escribe `flows/tomtom/flow.sh`.
    puertoEscucha: Number(process.env.E2E_FAKE_INROUTE_PORT || 7803),
    // /grupos del sandbox real pesa ~8 MB y tarda >20 s: el proxy no corta antes que el satélite (30 s).
    timeoutMs: 60000,
    // Claves que SÍ existen en el sandbox de Adsum (verificadas): en modo real
    // la corrida de demostración se crea en BCB con estas, porque las E2E-* del
    // catálogo simulado no existen allá y el alta fallaría con
    // "Trip instruction not found".
    refs: {
      unidad: process.env.E2E_INROUTE_BUS || '675',
      operador: process.env.E2E_INROUTE_OP || '303258',
      instruccion: process.env.E2E_INROUTE_ROUTE || '200',
      grupo: process.env.E2E_INROUTE_GRUPO || 'Primera Clase',
    },
  },
};

function cargarConfig() {
  try {
    const guardada = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    return { ...CONFIG_DEFAULT, ...guardada, inroute: { ...CONFIG_DEFAULT.inroute, ...(guardada.inroute || {}) } };
  } catch {
    return JSON.parse(JSON.stringify(CONFIG_DEFAULT));
  }
}

function guardarConfig() {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

let config = cargarConfig();

// ── Firma del JWT con el que adapter-tomtom llama al satélite ──────────────
// El satélite valida lo que le entra con la pública del leg `adapter-tt` (la puso
// flows/tomtom/flow.sh en su .env). Cuando el panel llama "directo al satélite"
// firma con esa misma privada: es exactamente la credencial del adaptador, no un
// bypass. Con crypto de Node alcanza — no hace falta una librería para esto.
const b64url = (buf) => Buffer.from(buf).toString('base64url');

function tokenAdapter(ttlSegundos = 600) {
  const pem = fs.readFileSync(path.join(KEYS_DIR, 'adapter-tt-private.pem'), 'utf-8');
  const ahora = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({ sub: 'adapter-tomtom', iat: ahora, exp: ahora + ttlSegundos }),
  );
  const firma = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), pem);
  return `${header}.${payload}.${b64url(firma)}`;
}

const authSatelite = () => ({ Authorization: `Bearer ${tokenAdapter()}` });
// CU03: el webhook de eventos de geocerca usa token estático parametrizado

// ── Mensajería NATS ────────────────────────────────────────────────────────
/**
 * Publicar en NATS es lo que convierte al panel en la cadena real: el evento que
 * emite BCB al despachar una corrida es un mensaje, no una llamada HTTP. La
 * librería ya está en el harness (`nats`), así que el panel la reutiliza.
 *
 * Las seeds NKEY salen del .env del monorepo, igual que para los adaptadores.
 */
let nats = null;

function seedNats(clave) {
  const linea = fs
    .readFileSync(path.join(REPO_MAIN, '.env'), 'utf-8')
    .split('\n')
    .find((l) => l.startsWith(`${clave}=`));
  if (!linea) throw new Error(`falta ${clave} en ${REPO_MAIN}/.env`);
  return linea.slice(clave.length + 1).trim();
}

async function conexionNats(dominio) {
  const clave = dominio === 'tomtom' ? 'TOMTOM_SECRET_NATS_SEED' : 'BCB_SECRET_NATS_SEED';
  if (nats && nats.dominio === dominio && !nats.conn.isClosed()) return nats.conn;
  if (nats) await nats.conn.close().catch(() => {});
  const { connect, nkeyAuthenticator } = require('nats');
  const conn = await connect({
    servers: (process.env.E2E_NATS_URL ?? 'nats://localhost:4222').split(','),
    timeout: 4000,
    maxReconnectAttempts: 2,
    authenticator: nkeyAuthenticator(new TextEncoder().encode(seedNats(clave))),
  });
  nats = { dominio, conn };
  return conn;
}

async function publicar(dominio, subject, cuerpo) {
  const t0 = Date.now();
  try {
    const conn = await conexionNats(dominio);
    conn.publish(subject, new TextEncoder().encode(JSON.stringify(cuerpo)));
    await conn.flush();
    return { ok: true, subject, request: cuerpo, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, subject, request: cuerpo, ms: Date.now() - t0, error: String((e && e.message) || e) };
  }
}

// ── InRoute simulado ───────────────────────────────────────────────────────
const inroute = new InrouteFalso();
const inrouteRecibidos = [];

const servidorInroute = crearServidorInroute(
  inroute,
  () => config.inroute,
  (registro) => {
    inrouteRecibidos.push(registro);
    if (inrouteRecibidos.length > 300) inrouteRecibidos.shift();
  },
);

// ── Utilidades ─────────────────────────────────────────────────────────────
function parseJson(texto, fallback) {
  try {
    return JSON.parse(texto);
  } catch {
    return fallback;
  }
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** Oculta la firma de un Bearer para que se pueda proyectar en pantalla. */
function headersVisibles(headers) {
  const salida = { ...headers };
  if (salida.Authorization && salida.Authorization.startsWith('Bearer ')) {
    salida.Authorization = `Bearer ${salida.Authorization.slice(7, 27)}… (JWT RS256)`;
  }
  return salida;
}

/** Una llamada HTTP registrada para mostrarla completa en el panel. */
async function llamar(metodo, url, { headers = {}, body, timeoutMs = 25000 } = {}) {
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
      error: String((e && e.message) || e),
      response: null,
    };
  }
}

// ── SQL ────────────────────────────────────────────────────────────────────
const BASES = {
  bcb: { etiqueta: 'Base de datos de BCB', contenedor: 'bcb-local-db', usuario: 'bcb', base: 'bcb' },
  satelite: {
    etiqueta: 'Base del satélite TomTom',
    contenedor: 'biger_estrellaroja_tomtom-db-1',
    usuario: 'postgres',
    base: 'biger_tomtom',
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

async function esperarFila(baseId, sql, timeoutMs, cumple = () => true) {
  const limite = Date.now() + timeoutMs;
  let ultima = null;
  while (Date.now() < limite) {
    const filas = await correrSql(baseId, sql).catch(() => []);
    if (filas.length) {
      ultima = filas[0];
      if (cumple(ultima)) return ultima;
    }
    await esperar(700);
  }
  return null;
}

async function esperarInroute(predicado, desde, timeoutMs) {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    const hallado = inrouteRecibidos.slice(desde).find(predicado);
    if (hallado) return hallado;
    await esperar(300);
  }
  return null;
}

// ── El harness: crear corrida y correr la telemetría ───────────────────────
/** Corre un comando y devuelve el JSON que imprime en su última línea. */
function correr(cmd, args, opciones = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120000, maxBuffer: 16 << 20, ...opciones }, (err, stdout, stderr) => {
      // La salida útil es la ÚLTIMA línea; antes puede haber avisos del runtime.
      const ultima = String(stdout).trim().split('\n').filter(Boolean).pop();
      const datos = parseJson(ultima, null);
      if (datos) return resolve(datos);
      reject(new Error((stderr || String(err) || 'sin salida').split('\n').filter(Boolean).slice(-3).join(' · ')));
    });
  });
}

/**
 * La corrida de demostración la crea el harness, que tiene el Prisma de BCB.
 * En modo real lleva las claves del sandbox de Adsum (config.inroute.refs):
 * unidad/operador/instrucción que existen allá — las E2E-* solo existen en el
 * catálogo simulado y el alta fallaría con "Trip instruction not found".
 */
const crearCorrida = () => {
  const args = ['exec', 'tsx', 'src/cli.ts', 'tomtom', 'demo-trip'];
  if (config.inroute.modo === 'real') {
    const r = config.inroute.refs || {};
    args.push(
      JSON.stringify({
        economicNumber: r.unidad || '675',
        operatorKey: r.operador || '303258',
        routeNumber: r.instruccion || '200',
        routeName: 'Ruta sandbox (Adsum)',
        serviceName: r.grupo || 'Primera Clase',
      }),
    );
  }
  return correr('pnpm', args, { cwd: E2E_ROOT });
};

/**
 * El proceso programado de telemetría corre con el código COMPILADO del satélite
 * (ver sync-runner.cjs): es el mismo que ejecuta la Lambda, con la metadata de
 * decoradores que Nest necesita.
 */
const correrTelemetria = (envExtra) =>
  correr('node', [path.join(__dirname, 'sync-runner.cjs'), REPO_SAT], {
    cwd: REPO_SAT,
    env: { ...process.env, ...envExtra },
  });

/** El .env del satélite, para pasárselo al proceso de telemetría. */
function envSatelite() {
  const salida = {};
  let texto = '';
  try {
    texto = fs.readFileSync(path.join(REPO_SAT, '.env'), 'utf-8');
  } catch {
    return salida;
  }
  for (const linea of texto.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(linea);
    if (!m) continue;
    salida[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return salida;
}

// ── Escenario ──────────────────────────────────────────────────────────────
/**
 * Una corrida NUEVA por demostración: ids frescos en BCB y su equivalencia dada
 * de alta en InRoute (unidad, operador, grupo e instrucción de viaje).
 *
 * Ids nuevos y no un escenario fijo porque adapter-tomtom deriva el identificador
 * de deduplicación del id del viaje: repetir uno hace que el segundo evento no se
 * publique. Con una corrida nueva la demostración se puede repetir las veces que
 * haga falta.
 */
let escenario = (() => {
  try {
    return JSON.parse(fs.readFileSync(ESCENARIO_FILE, 'utf-8'));
  } catch {
    return null;
  }
})();

async function nuevoEscenario() {
  const corrida = await crearCorrida();
  // Los cruces de geocerca son de la unidad, no de la corrida, y todas las
  // demostraciones usan la misma unidad: sin esto, el cruce de destino de la
  // corrida anterior sigue en la ventana de consulta y da por llegada a la
  // corrida nueva apenas se dispara el polling.
  inroute.estado.eventos = [];
  const ids = inroute.registrarCorrida({
    economicNumber: corrida.economicNumber,
    operatorKey: corrida.operatorKey,
    routeNumber: corrida.routeNumber,
    routeName: corrida.routeName,
  });
  escenario = { ...corrida, inroute: ids, creadoEl: new Date().toISOString() };
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(ESCENARIO_FILE, JSON.stringify(escenario, null, 2));
  return escenario;
}

/**
 * Reponer el registro en InRoute después de reiniciar el panel: el catálogo del
 * InRoute simulado vive en memoria, pero el escenario sobrevive en disco.
 */
function asegurarRegistroInroute() {
  if (!escenario) return null;
  if (!inroute.estado.vehiculos.some((v) => (v.cObjectNo || '').trim() === escenario.economicNumber)) {
    escenario.inroute = inroute.registrarCorrida({
      economicNumber: escenario.economicNumber,
      operatorKey: escenario.operatorKey,
      routeNumber: escenario.routeNumber,
      routeName: escenario.routeName,
    });
  }
  return escenario.inroute;
}

function payloadPorDefecto(servicioId, e) {
  if (!e) return {};
  const base = {
    claveERP: e.travelCardId,
    tripId: e.tripId,
    economicNumber: e.economicNumber,
    operatorKey: e.operatorKey,
    routeId: e.routeNumber,
    departure: e.departure,
    description: `${e.routeName} — ${e.economicNumber}`,
    busId: e.busId,
    operatorId: e.operadorId,
    destinationId: e.destinoId,
  };

  if (servicioId === 'alta') return base;
  if (servicioId === 'cambios') {
    return {
      claveERP: base.claveERP,
      economicNumber: base.economicNumber,
      operatorKey: base.operatorKey,
      departure: base.departure,
      description: base.description,
    };
  }
  // El cruce se expresa como desfase respecto a la salida programada: es como lo
  // piensa operación ("salió cinco minutos tarde"), y es lo que decide si cae
  // dentro de la ventana de despacho.
  if (servicioId === 'reconciliacion') return { claveERP: base.claveERP, desfaseSalida: 5, desfaseLlegada: 18 };
  if (servicioId === 'telemetria') {
    return {
      claveERP: base.claveERP,
      nDistanciaRecorrida: 128.4,
      nConsumoGasolina: 41.2,
      nRendimientoGasolina: 3.11,
      nVelocidadPromedio: 61.3,
      nVelocidadMaxima: 94,
      nTiempoDuracion: 126,
      nTiempoParado: 18,
    };
  }
  return {};
}

// ── Ejecución de cada servicio ─────────────────────────────────────────────
const pasoInroute = (registro, titulo, nota) => ({ titulo, nota, inroute: registro });

/**
 * 1 · Alta del viaje. Dos entradas a la MISMA cadena:
 *
 *  · `bcb`      → publica biger.bcb.travelcard.creada, el evento que BCB emite al
 *                 crear la tarjeta. adapter-bcb le pregunta a BCB los datos de la
 *                 corrida, arma el payload y lo publica hacia adapter-tomtom, que
 *                 llama al satélite. Los 5 saltos, con el payload que arma BIGER.
 *  · `satelite` → POST /tomtom/viajes directo, con el JWT del adaptador y el
 *                 payload editable de la pantalla.
 */
async function ejecutarAlta(payload, opciones) {
  const entrada = opciones.entrada === 'satelite' ? 'satelite' : 'bcb';
  const pasos = [];
  const desde = inrouteRecibidos.length;
  asegurarRegistroInroute();

  if (entrada === 'bcb') {
    pasos.push({
      titulo: 'BCB avisa que creó la tarjeta de viaje',
      nota:
        'Mismo evento que BCB emite al despachar. De acá en adelante el payload lo arma BIGER con los datos de la corrida: lo que se edite en pantalla no viaja en esta entrada.',
      nats: await publicar('bcb', 'biger.bcb.travelcard.creada', {
        travelCardId: payload.claveERP,
        operation: 'CREATE',
      }),
    });
  } else {
    pasos.push({
      titulo: 'Llamada directa al satélite',
      nota: 'Se omite la mensajería interna de BIGER; el satélite recibe el alta tal como se ve arriba.',
      http: await llamar('POST', `${config.satelite}/tomtom/viajes`, {
        headers: authSatelite(),
        body: payload,
      }),
    });
  }

  // Observación: ¿llegó a InRoute? Es el punto que le importa a Adsum.
  const alta = await esperarInroute(
    (r) => r.metodo === 'POST' && r.ruta === '/viajes' && r.payloadEnviado && r.payloadEnviado.cClaveERP === payload.tripId,
    desde,
    // Contra el sandbox real la PRIMERA alta de un par unidad/operador tarda
    // ~80 s (solo /grupos pesa 8 MB y toma ~44 s); con equivalencias cacheadas
    // baja a segundos. El watcher no debe declarar el fallo antes de tiempo.
    config.inroute.modo === 'real' ? 180000 : entrada === 'bcb' ? 40000 : 20000,
  );

  if (alta) {
    pasos.push(
      pasoInroute(
        alta,
        alta.modo === 'real' ? 'InRoute REAL registró el viaje' : 'InRoute registró el viaje (simulado)',
        'Éste es el cuerpo exacto que sale hacia Adsum, ya traducido a su formato por el satélite.',
      ),
    );
  } else {
    pasos.push({
      titulo: 'InRoute no recibió el alta',
      error: true,
      nota: 'El viaje no completó la cadena.',
      diagnostico: await diagnosticar(entrada === 'bcb' ? 'cadena' : 'satelite'),
    });
  }

  // Observación: ¿quedó registrado en el satélite, con su id de InRoute?
  const viaje = await esperarFila(
    'satelite',
    `SELECT "nTripId" AS "id en InRoute", "nVehicleId" AS "unidad en InRoute",
            "nTripInstructionId" AS "instruccion de viaje", "destinationId" AS "estacion destino",
            "failed" AS "marcado como fallido"
     FROM "TomTomTrip" WHERE "travelCardId" = '${payload.claveERP}'`,
    15000,
    (fila) => fila['id en InRoute'] !== null,
  );

  if (viaje) {
    pasos.push({
      titulo: 'El viaje quedó registrado con su id de InRoute',
      nota: 'El satélite guarda la equivalencia: a partir de acá sabe qué viaje de InRoute mirar cuando la unidad cruce una geocerca.',
      datos: viaje,
    });
    // El relay de BCB manda la estación destino vacía; sin ella la confirmación de
    // llegada (CU05) no puede validarse contra la ruta. Se avisa acá, que es donde
    // todavía se puede corregir, y no dos pestañas después con un 409.
    if (!viaje['estacion destino']) {
      pasos.push({
        titulo: 'El viaje quedó sin estación destino',
        error: true,
        nota:
          'adapter-bcb manda `destinationId` vacío en el evento (TravelCardRelayService.buildViajePayload). ' +
          'La llegada por geocerca (CU05) necesita ese dato para validar contra la ruta: con el alta por la cadena ' +
          'completa, la confirmación se rechaza. Para demostrar CU05 hoy, dar de alta con «Directo al satélite».',
      });
    }
  } else {
    // El motivo está en la bitácora del propio satélite, que es más preciso que
    // cualquier cosa que el panel pueda inferir del log.
    const fallo = await correrSql(
      'satelite',
      `SELECT s."operation" AS "operacion", s."status" AS "resultado", s."errorMessage" AS "error",
              s."attemptedAt" AS "intento"
       FROM "TomTomSync" s JOIN "TomTomTrip" t ON t.id = s."tripId"
       WHERE t."travelCardId" = '${payload.claveERP}' ORDER BY s."attemptedAt" DESC LIMIT 1`,
    ).catch(() => []);
    pasos.push({
      titulo: 'El viaje quedó sin id de InRoute',
      error: true,
      nota: 'Se registró localmente, pero la sincronización no se completó. Esto es lo último que anotó la bitácora:',
      datos: fallo.length ? fallo : null,
      diagnostico: await diagnosticar('satelite'),
    });
  }

  return { pasos, valores: payload };
}

/** 2 · Actualización o cancelación. Por la cadena, o directo con el cuerpo correcto. */
async function ejecutarCambios(payload, opciones) {
  const cancelar = opciones.entrada === 'cancelar';
  const directo = opciones.entrada === 'directo';
  const pasos = [];
  const desde = inrouteRecibidos.length;
  asegurarRegistroInroute();

  if (directo) {
    // El contrato de la actualización no lleva `claveERP` (va en la URL). Ése es
    // justo el campo que adapter-bcb manda de más y que rompe la cadena.
    const { claveERP, ...resto } = payload;
    const cuerpo = {
      tripId: escenario ? escenario.tripId : resto.tripId,
      economicNumber: resto.economicNumber,
      operatorKey: resto.operatorKey,
      routeId: escenario ? escenario.routeNumber : resto.routeId,
      departure: resto.departure,
      description: resto.description,
      busId: escenario ? escenario.busId : resto.busId,
      operatorId: escenario ? escenario.operadorId : resto.operatorId,
      destinationId: escenario ? escenario.destinoId : resto.destinationId,
    };
    pasos.push({
      titulo: 'Actualización directa al satélite',
      nota: 'Mismo cambio, con el cuerpo que el contrato pide: sin `claveERP` (viaja en la URL).',
      http: await llamar('PUT', `${config.satelite}/tomtom/viajes/${claveERP}`, {
        headers: authSatelite(),
        body: cuerpo,
      }),
    });

    const enInroute = await esperarInroute((r) => r.metodo === 'POST' && r.ruta === '/viajes', desde, 15000);
    pasos.push(
      enInroute
        ? pasoInroute(enInroute, 'InRoute aplicó el cambio', 'Se manda el mismo `nViaje` que InRoute asignó en el alta.')
        : { titulo: 'InRoute no recibió el cambio', error: true, diagnostico: await diagnosticar('satelite') },
    );
    return { pasos, valores: payload };
  }

  pasos.push({
    titulo: cancelar ? 'BCB avisa que canceló la corrida' : 'BCB avisa que la corrida cambió',
    nota: cancelar
      ? 'adapter-bcb publica la cancelación; no hace falta volver a leer la corrida.'
      : 'adapter-bcb vuelve a leer la corrida en BCB y publica el viaje actualizado.',
    nats: await publicar(
      'bcb',
      cancelar ? 'biger.bcb.travelcard.cancelada' : 'biger.bcb.travelcard.actualizada',
      { travelCardId: payload.claveERP, operation: cancelar ? 'CANCEL' : 'UPDATE' },
    ),
  });

  const enInroute = await esperarInroute(
    (r) => (cancelar ? r.metodo === 'DELETE' : r.metodo === 'POST') && r.ruta === '/viajes',
    desde,
    20000,
  );

  if (enInroute) {
    pasos.push(
      pasoInroute(
        enInroute,
        cancelar ? 'InRoute canceló el viaje' : 'InRoute aplicó el cambio',
        cancelar
          ? 'La cancelación viaja con su motivo, tomado del catálogo de InRoute.'
          : 'El viaje se actualiza en su lugar: se manda el mismo `nViaje` que InRoute asignó en el alta.',
      ),
    );
  } else {
    pasos.push({
      titulo: 'InRoute no recibió el cambio',
      error: true,
      nota: 'Puede ser que el viaje nunca se haya dado de alta: sin id de InRoute, el satélite ignora la operación y la anota.',
      diagnostico: await diagnosticar('cadena'),
    });
  }

  const bitacora = await correrSql(
    'satelite',
    `SELECT s."operation" AS "operacion", s."status" AS "resultado", s."errorMessage" AS "error",
            s."attemptedAt" AS "intento"
     FROM "TomTomSync" s JOIN "TomTomTrip" t ON t.id = s."tripId"
     WHERE t."travelCardId" = '${payload.claveERP}' ORDER BY s."attemptedAt" DESC LIMIT 3`,
  ).catch(() => []);

  if (bitacora.length) {
    pasos.push({
      titulo: 'Último movimiento en la bitácora del satélite',
      nota: 'Cada intento queda anotado: es lo que después permite explicar qué pasó y cuándo.',
      datos: bitacora,
    });
  }

  return { pasos, valores: payload };
}

/**
 * 3 y 4 · Geocercas. El panel programa el cruce en InRoute —como si la unidad
 * acabara de pasar por ahí— y dispara el polling. De ahí en adelante corre el
 * código real: detección, callback firmado, cola durable y BCB.
 */
/**
 * 5 · Reconciliación por poll: InRoute ya registró los cruces por su cuenta;
 * el satélite los descubre consultando y deriva despacho/llegada hacia BCB.
 * Es el mecanismo ACTIVO en producción (el webhook está dormido).
 */
async function ejecutarReconciliacion(payload) {
  if (config.inroute.modo === 'real') {
    return {
      pasos: [
        {
          titulo: 'El sandbox real no tiene unidades transmitiendo',
          error: true,
          nota:
            'Este momento necesita que el motor de InRoute registre cruces reales (cFechaSalidaReal/cFechaLlegadaReal), ' +
            'y en el sandbox de Adsum ninguna unidad se mueve. El poll real del satélite sí corre y consulta — pero ' +
            'nunca encuentra cruces que derivar. Para VER el mecanismo completo, cambiá InRoute a modo simulado; ' +
            'contra el sandbox, este punto queda pendiente de validar con Adsum con una unidad viva.',
        },
      ],
      valores: payload,
    };
  }
  const pasos = [];
  const ids = asegurarRegistroInroute();
  if (!escenario || !ids) {
    return {
      pasos: [{ titulo: 'No hay corrida cargada', error: true, nota: 'Generá una corrida nueva antes de disparar el poll.' }],
      valores: payload,
    };
  }

  // El viaje InRoute de esta corrida (el satélite guarda el nTripId al darla de alta).
  const fila = await correrSql(
    'satelite',
    `SELECT "nTripId" AS n, "tripId" AS corrida FROM "TomTomTrip" WHERE "travelCardId" = '${payload.claveERP}'`,
  ).catch(() => []);
  if (!fila.length || !fila[0].n) {
    return {
      pasos: [
        {
          titulo: 'La corrida no tiene viaje en InRoute',
          error: true,
          nota: 'El poll solo mira corridas con nTripId asignado. Corré primero el servicio 1 (alta) para esta tarjeta.',
        },
      ],
      valores: payload,
    };
  }
  const nViaje = fila[0].n;

  // 1) InRoute registra los cruces él solo — esto en producción lo hace su motor
  //    de geocercas con el GPS de la unidad; acá lo simula el panel.
  const salidaReal = new Date(new Date(escenario.departure).getTime() + Number(payload.desfaseSalida || 0) * 60_000);
  const conLlegada = payload.desfaseLlegada !== '' && payload.desfaseLlegada !== null && payload.desfaseLlegada !== undefined;
  const llegadaReal = conLlegada
    ? new Date(new Date(escenario.departure).getTime() + Number(payload.desfaseLlegada) * 60_000)
    : null;
  const viaje = inroute.registrarCruceReal(nViaje, salidaReal, llegadaReal);
  pasos.push({
    titulo: 'InRoute registró los cruces por su cuenta (nadie nos avisó)',
    nota:
      'El motor de geocercas de InRoute escribe las horas reales en el viaje. El satélite todavía no sabe nada — eso es exactamente lo que el poll viene a descubrir.',
    datos: viaje && {
      nViaje,
      cFechaSalidaReal: viaje.cFechaSalidaReal,
      cHoraSalidaReal: viaje.cHoraSalidaReal,
      cFechaLlegadaReal: viaje.cFechaLlegadaReal || '(aún sin llegada)',
      cHoraLlegadaReal: viaje.cHoraLlegadaReal || '',
    },
  });

  // 2) El poll — el mismo job que el scheduler corre cada 2 minutos.
  pasos.push({
    titulo: 'El satélite dispara el poll de reconciliación',
    nota:
      'POST /tomtom/viajes/reconciliar (en producción lo agenda el scheduler cada 2 min con candado en Postgres). ' +
      'UNA consulta a InRoute con todas las claves vigentes; deriva despacho y llegada de las horas reales.',
    http: await llamar('POST', `${config.satelite}/tomtom/viajes/reconciliar`, {
      headers: authSatelite(),
      body: {},
      timeoutMs: 60000,
    }),
  });

  // 3) Las marcas del satélite (compartidas con el camino webhook).
  const marca = await esperarFila(
    'satelite',
    `SELECT "dispatchedAt" AS "salida detectada", "arrivedAt" AS "llegada detectada"
     FROM "TomTomTrip" WHERE "travelCardId" = '${payload.claveERP}'`,
    25000,
    (f) => f['salida detectada'] !== null && (!conLlegada || f['llegada detectada'] !== null),
  );
  pasos.push(
    marca && marca['salida detectada']
      ? {
          titulo: 'El poll derivó los eventos y marcó el viaje',
          nota: 'Las marcas dispatchedAt/arrivedAt son las MISMAS que usa el webhook: por eso los dos caminos pueden convivir sin duplicar avisos.',
          datos: marca,
        }
      : {
          titulo: 'El poll no derivó la salida',
          error: true,
          nota: 'O la salida real quedó fuera de la ventana −45/+60 min de la programada, o la corrida ya estaba despachada, o el callback falló (la marca se revierte para reintentar).',
          diagnostico: await diagnosticar('satelite'),
        },
  );

  // 4) Y la validación que importa: BCB.
  const enBcb = await esperarFila(
    'bcb',
    `SELECT t.status AS "estado de la corrida", t."realDepartureAt" AS "salida real (InRoute)",
            t."realArrivalAt" AS "llegada real (InRoute)", tc.status AS "estado de la tarjeta"
     FROM "TravelCard" tc JOIN "Trip" t ON t.id = tc."tripId" WHERE tc.id = '${payload.claveERP}'`,
    30000,
    (f) => f['salida real (InRoute)'] !== null && (!conLlegada || f['llegada real (InRoute)'] !== null),
  );
  pasos.push(
    enBcb && enBcb['salida real (InRoute)']
      ? {
          titulo: conLlegada ? 'BCB despachó y confirmó con las horas reales de InRoute' : 'BCB despachó la corrida con su hora real',
          nota: 'La hora registrada es la del cruce (la capturó InRoute), no la del poll: el intervalo solo es latencia, nunca imprecisión.',
          datos: enBcb,
        }
      : {
          titulo: 'El evento no terminó de asentarse en BCB',
          error: true,
          nota: 'El satélite lo derivó pero no llegó al otro lado de la cola.',
          diagnostico: await diagnosticar('cola'),
        },
  );

  return { pasos, valores: payload };
}

/** 6 · Catálogos: el satélite pregunta a InRoute y reenvía, sin guardar nada. */
async function ejecutarCatalogos(payload, opciones) {
  const recurso = ['vehiculos', 'conductores', 'grupos', 'geocercas-catalogo'].includes(opciones.entrada)
    ? opciones.entrada
    : 'vehiculos';
  asegurarRegistroInroute();
  const desde = inrouteRecibidos.length;

  const http1 = await llamar('GET', `${config.satelite}/tomtom/${recurso}`, { headers: authSatelite() });
  const pasos = [
    {
      titulo: `Se consulta el catálogo de ${etiquetaRecurso(recurso)}`,
      nota: 'El satélite no guarda catálogos: la consulta va a InRoute en el momento.',
      http: http1,
    },
  ];

  const enInroute = await esperarInroute((r) => r.metodo === 'GET', desde, 8000);
  if (enInroute) {
    pasos.push(pasoInroute(enInroute, 'Lo que se le preguntó a InRoute', 'Ruta y parámetros tal como salen hacia Adsum.'));
  }

  if (Array.isArray(http1.response)) {
    pasos.push({
      titulo: `${http1.response.length} registro(s) en InRoute`,
      nota:
        recurso === 'vehiculos'
          ? 'Las coordenadas vienen multiplicadas por 10⁶: 19074661 es 19.074661.'
          : 'Éstos son los identificadores contra los que BIGER traduce cada corrida.',
      datos: http1.response,
    });
  }

  return { pasos, valores: payload };
}

const etiquetaRecurso = (r) =>
  ({ vehiculos: 'unidades', conductores: 'operadores', grupos: 'grupos', 'geocercas-catalogo': 'geocercas' })[r] || r;

/** 6 · Telemetría: se cierra el viaje en InRoute y corre el proceso programado. */
async function ejecutarTelemetria(payload) {
  const pasos = [];
  asegurarRegistroInroute();

  const fila = await correrSql(
    'satelite',
    `SELECT "nTripId" AS n FROM "TomTomTrip" WHERE "travelCardId" = '${payload.claveERP}'`,
  ).catch(() => []);
  const nViaje = fila.length ? fila[0].n : null;

  if (!nViaje) {
    return {
      pasos: [
        {
          titulo: 'La corrida todavía no tiene viaje en InRoute',
          error: true,
          nota: 'La telemetría se descarga del viaje que InRoute cerró: primero hay que darlo de alta (servicio 1).',
        },
      ],
      valores: payload,
    };
  }

  if (config.inroute.modo === 'real') {
    pasos.push({
      titulo: 'InRoute está en modo REAL',
      nota: 'El viaje tiene que estar terminado del lado de Adsum para que haya telemetría que descargar; el panel no lo cierra por vos.',
    });
  } else {
    const viaje = inroute.terminarViaje(nViaje, {
      nDistanciaRecorrida: Number(payload.nDistanciaRecorrida),
      nConsumoGasolina: Number(payload.nConsumoGasolina),
      nRendimientoGasolina: Number(payload.nRendimientoGasolina),
      nVelocidadPromedio: Number(payload.nVelocidadPromedio),
      nVelocidadMaxima: Number(payload.nVelocidadMaxima),
      nTiempoDuracion: Number(payload.nTiempoDuracion),
      nTiempoParado: Number(payload.nTiempoParado),
    });
    pasos.push({
      titulo: 'TomTom da el viaje por terminado',
      nota: 'Estado 6 en InRoute, con el recorrido consolidado. Es la condición que el proceso programado espera.',
      datos: viaje,
    });
  }

  const t0 = Date.now();
  let resultado;
  try {
    resultado = await correrTelemetria({
      ...envSatelite(),
      INROUTE_BASE_URL: `http://127.0.0.1:${config.inroute.puertoEscucha}`,
    });
    pasos.push({
      titulo: 'Corrió el proceso programado del satélite',
      nota: `Es el mismo código que ejecuta la función tomtomSync cada 30 minutos en AWS. Tomó ${((Date.now() - t0) / 1000).toFixed(1)} s.`,
      datos: { 'viajes con telemetría nueva': resultado.sincronizados },
    });
  } catch (e) {
    pasos.push({
      titulo: 'El proceso programado falló',
      error: true,
      nota: String((e && e.message) || e),
    });
  }

  const datos = await esperarFila(
    'satelite',
    `SELECT d."distanceKm" AS "km recorridos", d."fuelLiters" AS "litros",
            d."fuelEfficiencyKmL" AS "km por litro", d."avgSpeedKmh" AS "velocidad promedio",
            d."maxSpeedKmh" AS "velocidad maxima", d."durationMinutes" AS "duracion (min)",
            d."stoppedMinutes" AS "detenido (min)", d."syncedAt" AS "descargada el"
     FROM "TomTomTripData" d JOIN "TomTomTrip" t ON t.id = d."tripId"
     WHERE t."travelCardId" = '${payload.claveERP}'`,
    15000,
  );

  pasos.push(
    datos
      ? {
          titulo: 'El recorrido quedó guardado en BIGER',
          nota: 'De acá salen los indicadores de operación: rendimiento por unidad, kilómetros, tiempos.',
          datos,
        }
      : {
          titulo: 'No se descargó telemetría',
          error: true,
          nota: 'El viaje no está terminado en InRoute, o ya se había descargado antes (se guarda una sola vez).',
          diagnostico: await diagnosticar('satelite'),
        },
  );

  return { pasos, valores: payload };
}

// ── Diagnóstico ────────────────────────────────────────────────────────────
/** Últimos errores de los servicios implicados, para no tener que ir al log. */
async function diagnosticar(contexto) {
  const porContexto = {
    cadena: ['adapter-bcb', 'bcb-app', 'adapter-tomtom', 'satelite-tomtom'],
    satelite: ['satelite-tomtom'],
    cola: ['satelite-tomtom', 'adapter-tomtom', 'adapter-bcb', 'bcb-app'],
  };
  const servicios = porContexto[contexto] || porContexto.cadena;
  const errores = servicios.map((s) => ({ servicio: s, error: ultimoProblema(s) })).filter((e) => e.error);

  const pistas = [];
  const errSat = errores.find((e) => e.servicio === 'satelite-tomtom');
  if (errSat && /Vehicle not found|Driver not found|Group not found|Trip instruction not found/i.test(errSat.error)) {
    pistas.push(
      'El satélite no encontró la equivalencia en InRoute (unidad, operador, grupo o ruta). ' +
        'Con el InRoute simulado eso se arregla generando una corrida nueva: el panel la da de alta en el catálogo.',
    );
  }
  if (errSat && /notificar llegada destino.*40[03]/i.test(errSat.error)) {
    pistas.push(
      'El aviso de llegada salió con la estación destino vacía y adapter-tomtom lo rechazó. ' +
        'Es el hueco de `destinationId` en TravelCardRelayService.buildViajePayload: dar de alta el viaje ' +
        'con «Directo al satélite» lo llena y la confirmación pasa.',
    );
  }
  const rechazoTt = errores.find((e) => e.servicio === 'adapter-tomtom');
  if (rechazoTt && /(PUT retorn[óo] 400|viaje\.actualizar.*status=400)/i.test(rechazoTt.error)) {
    pistas.push(
      'El satélite rechazó la actualización con 400: adapter-bcb manda `claveERP` en el cuerpo y el contrato ' +
        'de actualización no lo lleva (va en la URL). Es un campo de más en TravelCardRelayService.buildViajePayload. ' +
        'Con la entrada «Directo al satélite» se ve el mismo cambio pasando.',
    );
  }
  const errAdapter = errores.find((e) => e.servicio === 'adapter-tomtom');
  if (errAdapter && /401|Unauthorized/i.test(errAdapter.error)) {
    pistas.push(
      'adapter-tomtom llamó al satélite sin credencial válida. Revisá que el stack se haya levantado con la versión ' +
        'nueva del flujo: ./e2e down tomtom && ./e2e up tomtom',
    );
  }
  if (!errores.length) {
    pistas.push(
      'Ningún servicio reportó nada raro durante esta ejecución. Revisá que todo esté arriba: ./e2e status tomtom',
    );
  }
  return { errores, pistas };
}

/**
 * El diagnóstico solo mira lo que los servicios escribieron DURANTE esta
 * ejecución.
 *
 * Con el log completo, un fallo de hace diez minutos se presenta como si fuera la
 * causa del de ahora — y en una reunión eso manda a revisar lo que no es. Antes de
 * cada ejecución se anota el tamaño de cada log y después se lee solo lo nuevo.
 */
const LOGS = ['satelite-tomtom', 'adapter-tomtom', 'adapter-bcb', 'bcb-app'];
let marcaLogs = {};

function marcarLogs() {
  marcaLogs = {};
  for (const s of LOGS) {
    try {
      marcaLogs[s] = fs.statSync(path.join(LOG_DIR, `${s}.log`)).size;
    } catch {
      marcaLogs[s] = 0;
    }
  }
}

function lineasNuevas(servicio) {
  const archivo = path.join(LOG_DIR, `${servicio}.log`);
  try {
    const desde = marcaLogs[servicio] ?? 0;
    const largo = fs.statSync(archivo).size - desde;
    if (largo <= 0) return [];
    const buffer = Buffer.alloc(largo);
    const fd = fs.openSync(archivo, 'r');
    try {
      fs.readSync(fd, buffer, 0, largo, desde);
    } finally {
      fs.closeSync(fd);
    }
    return buffer.toString('utf-8').split('\n').filter(Boolean);
  } catch {
    return []; // sin log todavía
  }
}

/**
 * Un rechazo del satélite (4xx) llega al log del adaptador como WARN, no como
 * ERROR: buscar solo ERROR deja el diagnóstico mudo justo cuando más falta hace.
 */
function ultimoProblema(servicio) {
  const lineas = lineasNuevas(servicio);
  for (let i = lineas.length - 1; i >= 0; i--) {
    const cruda = lineas[i];
    const obj = parseJson(cruda, null);
    const mensaje = obj ? String(obj.message || '') : cruda.replace(/\x1b?\[[0-9;]*m/g, '');
    const nivel = obj ? String(obj.level).toUpperCase() : /ERROR/.test(cruda) ? 'ERROR' : '';
    if (nivel === 'ERROR' || /retorn[óo] 4\d\d|Error de negocio/i.test(mensaje)) return mensaje.slice(0, 300);
  }
  return '';
}

// ── Estado del stack ───────────────────────────────────────────────────────
const arriba = async (url) => {
  const r = await llamar('GET', url, { timeoutMs: 2500 });
  return r.status > 0 && r.status < 500;
};

async function estado() {
  const [sat, adapterTt, adapterBcb, appBcb, nats] = await Promise.all([
    arriba(`${config.satelite}/tomtom/viajes`),
    arriba(`${config.adapterTomtom}/actuator/health`),
    arriba(`${config.adapterBcb}/actuator/health`),
    arriba('http://localhost:3009/corridas'),
    arriba('http://localhost:8222/healthz?js-server-only=true'),
  ]);
  return {
    servicios: [
      { id: 'satelite', label: 'Satélite TomTom', up: sat },
      { id: 'adapter-tomtom', label: 'adapter-tomtom', up: adapterTt },
      { id: 'nats', label: 'Mensajería NATS', up: nats },
      { id: 'adapter-bcb', label: 'adapter-bcb', up: adapterBcb },
      { id: 'app-bcb', label: 'BCB (corridas y tarjetas)', up: appBcb },
      { id: 'inroute', label: `InRoute · ${config.inroute.modo}`, up: true, modo: config.inroute.modo },
    ],
    listo: sat && adapterTt && adapterBcb && appBcb && nats,
  };
}

// ── API HTTP ───────────────────────────────────────────────────────────────
function json(res, code, cuerpo) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(cuerpo));
}

function leerCuerpo(req) {
  return new Promise((resolve) => {
    let crudo = '';
    req.on('data', (c) => (crudo += c));
    req.on('end', () => resolve(parseJson(crudo, {})));
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

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
  return { ...config, inroute: { ...config.inroute, password: config.inroute.password ? '••••••' : '' } };
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const ruta = url.pathname;

  try {
    if (ruta === '/api/servicios') {
      asegurarRegistroInroute();
      return json(res, 200, {
        servicios: SERVICIOS.map((s) => ({ ...s, payload: payloadPorDefecto(s.id, escenario) })),
        escenario,
      });
    }

    if (ruta === '/api/escenario') {
      try {
        const e = await nuevoEscenario();
        return json(res, 200, {
          escenario: e,
          payloads: Object.fromEntries(SERVICIOS.map((s) => [s.id, payloadPorDefecto(s.id, e)])),
        });
      } catch (err) {
        return json(res, 200, { error: String((err && err.message) || err) });
      }
    }

    if (ruta === '/api/estado') return json(res, 200, await estado());

    if (ruta === '/api/config' && req.method === 'GET') return json(res, 200, configPublica());

    if (ruta === '/api/config' && req.method === 'POST') {
      const cambios = await leerCuerpo(req);
      const entrante = { ...config.inroute, ...(cambios.inroute || {}) };
      // Una contraseña enmascarada que vuelve del navegador no debe pisar la real.
      if (entrante.password === '••••••') entrante.password = config.inroute.password;
      config = { ...config, ...cambios, inroute: entrante };
      guardarConfig();
      return json(res, 200, configPublica());
    }

    if (ruta === '/api/ejecutar' && req.method === 'POST') {
      const { servicio, payload, opciones = {} } = await leerCuerpo(req);
      const inicio = Date.now();
      // Marca para que el diagnóstico solo mire lo que se escriba de acá en más.
      marcarLogs();
      let salida;
      if (servicio === 'alta') salida = await ejecutarAlta(payload, opciones);
      else if (servicio === 'cambios') salida = await ejecutarCambios(payload, opciones);
      else if (servicio === 'reconciliacion') salida = await ejecutarReconciliacion(payload);
      else if (servicio === 'catalogos') salida = await ejecutarCatalogos(payload, opciones);
      else if (servicio === 'telemetria') salida = await ejecutarTelemetria(payload);
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

    if (ruta === '/api/inroute') {
      return json(res, 200, { recibidos: inrouteRecibidos.slice(-25).reverse(), catalogo: inroute.estado });
    }

    return estatico(res, ruta);
  } catch (e) {
    return json(res, 500, { error: String((e && e.message) || e) });
  }
});

// ── Arranque ───────────────────────────────────────────────────────────────
servidorInroute.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(
      `\n  ⚠  El puerto ${config.inroute.puertoEscucha} (InRoute) ya está ocupado.\n` +
        '     Suele ser otra copia de este panel. Cerrala y volvé a abrirlo.\n',
    );
    process.exit(1);
  }
  throw e;
});

/**
 * Los ids de viaje del InRoute simulado tienen que seguir donde quedaron.
 *
 * El catálogo del simulador vive en memoria, así que al reiniciar el panel el
 * contador vuelve a empezar y reasignaría un `nViaje` que el satélite ya tiene
 * guardado — y `TomTomTrip.nTripId` es único: el alta se registra en InRoute pero
 * el satélite no puede guardarla, y el viaje queda sin id. Se arranca el contador
 * por encima del último id conocido.
 */
async function alinearContadorDeViajes() {
  const filas = await correrSql('satelite', 'SELECT max("nTripId") AS n FROM "TomTomTrip"').catch(() => []);
  const ultimo = filas.length && filas[0].n ? Number(filas[0].n) : 0;
  if (ultimo >= inroute.estado.siguiente.nViaje) inroute.estado.siguiente.nViaje = ultimo;
}

servidorInroute.listen(config.inroute.puertoEscucha, '127.0.0.1', () => {
  void alinearContadorDeViajes();
  servidor.listen(PORT, () => {
    console.log(`\n  Demo TomTom          →  http://localhost:${PORT}`);
    console.log(`  InRoute escuchando   →  127.0.0.1:${config.inroute.puertoEscucha} (modo: ${config.inroute.modo})`);
    console.log('\n  Requiere el stack arriba:  ./e2e up tomtom  &&  ./e2e seed tomtom\n');
  });
});
