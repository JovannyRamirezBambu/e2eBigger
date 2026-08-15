#!/usr/bin/env node
/**
 * Servidor del panel E2E. Sin dependencias: solo módulos de Node.
 *
 * No reimplementa nada. Todo lo que hace es invocar el mismo `./e2e` que usás en
 * la terminal y transformar su salida a JSON o a un stream SSE. Si el CLI y la UI
 * alguna vez discrepan, es un bug del servidor, no dos verdades distintas.
 *
 * Solo lectura + correr casos: NO expone levantar/bajar servicios ni recrear la
 * base. Eso se queda en el CLI a propósito, para que un clic no pueda dejar el
 * entorno a medias.
 *
 * El frontend (`ui/src`) es React/Vite/Tailwind — necesita su propio build — pero
 * este servidor sigue sin dependencias: sirve el resultado (`ui/dist`) como
 * archivos estáticos con Node puro, y expone la misma API de siempre. `./e2e ui`
 * arma `dist/` si hace falta antes de arrancar esto (ver `e2e`, comando `ui`).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const E2E_ROOT = path.resolve(__dirname, '..');
const E2E_BIN = path.join(E2E_ROOT, 'e2e');
const DIST_DIR = path.join(__dirname, 'dist');
/** Flujo por defecto; el panel puede cambiarlo con ?flow=… en cada llamada. */
const DEFAULT_FLOW = process.argv[2] || 'tomtom';
const PORT = Number(process.env.E2E_UI_PORT || 7777);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** Sirve `ui/dist/<p>`, o `index.html` para rutas de la SPA. Sin acceso fuera de `dist/`. */
function serveStatic(req, res, p) {
  const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
  const resolved = path.normalize(path.join(DIST_DIR, rel));
  const file = resolved.startsWith(DIST_DIR) && fs.existsSync(resolved) && fs.statSync(resolved).isFile()
    ? resolved
    : path.join(DIST_DIR, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('ui/dist no existe todavía — corré: pnpm --dir ui build (o ./e2e ui <flujo>, que lo hace solo)');
  }
  const ext = path.extname(file);
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

/** Corre `./e2e <args>` y devuelve stdout. */
function e2e(args) {
  return new Promise((resolve, reject) => {
    execFile(E2E_BIN, args, { cwd: E2E_ROOT, maxBuffer: 8 << 20 }, (err, stdout) =>
      err && !stdout ? reject(err) : resolve(stdout),
    );
  });
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

const parseJsonOr = (text, fallback) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

/** Flujos disponibles; los descubre el propio entrypoint leyendo el directorio. */
async function listFlows() {
  const out = await e2e(['flows']).catch(() => '');
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, description] = line.split('\t');
      return { name, description: description || '' };
    });
}

/**
 * Resuelve el flujo pedido validándolo contra la lista real. Nunca se pasa a
 * exec una cadena que venga del navegador sin comprobarla.
 */
async function resolveFlow(url) {
  const asked = url.searchParams.get('flow');
  if (!asked) return DEFAULT_FLOW;
  const names = (await listFlows()).map((f) => f.name);
  if (!names.includes(asked)) throw new Error(`flujo desconocido: ${asked}`);
  return asked;
}

// ── Endpoints de lectura ───────────────────────────────────────────────────
async function getState(flow) {
  const [probeOut, casesOut, dbOut, resultsOut, trafficOut, flows] = await Promise.all([
    e2e(['probe', flow]).catch(() => '{}'),
    e2e(['cases', flow]).catch(() => ''),
    e2e(['db-json', flow]).catch(() => '[]'),
    e2e(['results', flow]).catch(() => '{}'),
    e2e(['traffic', flow]).catch(() => '{}'),
    listFlows(),
  ]);
  const services = await logServices(flow);
  const cases = casesOut
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, label] = line.split('\t');
      return { name, label: label || name };
    });
  return {
    ...parseJsonOr(probeOut, {}),
    flow,
    flows,
    services,
    cases,
    db: parseJsonOr(dbOut.trim(), []),
    results: parseJsonOr(resultsOut, {}),
    traffic: parseJsonOr(trafficOut, {}).entries || [],
    ts: Date.now(),
  };
}

/** Nodos del flujo que tienen archivo de log, en el orden de la cadena. */
async function logServices(flow) {
  const probe = parseJsonOr(await e2e(['probe', flow]).catch(() => '{}'), {});
  return (probe.nodes ?? [])
    .map((n) => n.id)
    .filter((id) => fs.existsSync(path.join(E2E_ROOT, 'run', 'logs', `${id}.log`)));
}

function tailLog(service, lines = 300) {
  const file = path.join(E2E_ROOT, 'run', 'logs', `${service}.log`);
  if (!fs.existsSync(file)) return [];
  const all = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
  return all.slice(-lines).map((raw) => {
    // Los adapters loguean JSON estructurado; la app de BCB, texto de Nest.
    try {
      const o = JSON.parse(raw);
      return {
        ts: (o.timestamp || '').slice(11, 19),
        level: (o.level || 'INFO').toUpperCase(),
        msg: o.message || '',
        logger: (o.logger || '').split('.').pop(),
      };
    } catch {
      const clean = raw.replace(/\[[0-9;]*m/g, '');
      const level = /ERROR/.test(clean) ? 'ERROR' : /WARN/.test(clean) ? 'WARN' : 'INFO';
      const ts = (clean.match(/(\d{1,2}:\d{2}:\d{2})/) || [, ''])[1];
      return { ts, level, msg: clean.slice(0, 400), logger: '' };
    }
  });
}

// ── Ejecución de casos, en streaming ───────────────────────────────────────
// Un trabajo a la vez: correr dos suites en paralelo sobre la misma base daría
// resultados que no significan nada.
let running = null;

/** Vivo de verdad, no solo "no lo limpiamos". Evita quedar trabado en 409. */
const isAlive = (child) => child && child.exitCode === null && child.signalCode === null;

/**
 * Mata el GRUPO de procesos, no solo el hijo directo: `./e2e` es un bash que
 * lanza npx/pnpm, y matar al padre deja a los nietos corriendo (y al puerto o a
 * la base ocupados). Requiere `detached: true` al lanzarlo.
 */
function killGroup(child) {
  if (!child) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill(); } catch {} }
}

function runJob(res, args) {
  if (isAlive(running)) {
    json(res, 409, { error: 'ya hay una corrida en curso' });
    return;
  }
  running = null;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const child = spawn(E2E_BIN, args, { cwd: E2E_ROOT, detached: true });
  running = child;
  let buffer = '';

  const onChunk = (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) send('line', stripAnsi(line));
  };
  child.stdout.on('data', onChunk);
  child.stderr.on('data', onChunk);

  const finish = (code) => {
    if (running !== child) return;
    running = null;
    if (buffer) send('line', stripAnsi(buffer));
    send('done', { code });
    res.end();
  };
  child.on('close', finish);
  child.on('error', (err) => {
    send('line', `no se pudo ejecutar: ${err.message}`);
    finish(-1);
  });

  // Si el navegador se va (cerró la pestaña, cortó el fetch), no dejamos la
  // corrida huérfana ni el guard trabado.
  res.on('close', () => {
    if (running === child) {
      killGroup(child);
      running = null;
    }
  });
}

const stripAnsi = (s) => s.replace(/\[[0-9;]*m/g, '');

// ── Router ─────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    if (!p.startsWith('/api/')) return serveStatic(req, res, p);
    if (p === '/api/flows') return json(res, 200, await listFlows());
    if (p === '/api/state') return json(res, 200, await getState(await resolveFlow(url)));
    if (p === '/api/logs') {
      const svc = url.searchParams.get('service');
      // Los servicios permitidos salen de los nodos del flujo que TIENEN log en
      // disco. Así el panel nunca muestra logs de otro flujo, y agregar un flujo
      // no obliga a mantener una lista acá. Además evita que el navegador pueda
      // nombrar un archivo arbitrario.
      const allowed = await logServices(await resolveFlow(url));
      if (svc && svc !== 'all' && !allowed.includes(svc)) return json(res, 400, { error: 'servicio inválido' });
      const entries =
        svc && svc !== 'all'
          ? tailLog(svc).map((e) => ({ ...e, service: svc }))
          : allowed
              .flatMap((s) => tailLog(s, 120).map((e) => ({ ...e, service: s })))
              .sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
      return json(res, 200, entries.slice(-400));
    }
    if (p === '/api/run' && req.method === 'POST') {
      const only = url.searchParams.get('case');
      // Whitelist estricta: solo nombres de casos que el flujo declara.
      const flow = await resolveFlow(url);
      if (only) {
        const names = (await e2e(['cases', flow])).split('\n').map((l) => l.split('\t')[0]);
        if (!names.includes(only)) return json(res, 400, { error: 'caso desconocido' });
      }
      return runJob(res, only ? ['test', flow, only] : ['test', flow]);
    }
    if (p === '/api/seed' && req.method === 'POST') return runJob(res, ['seed', await resolveFlow(url)]);

    json(res, 404, { error: 'no encontrado' });
  } catch (err) {
    json(res, 500, { error: String(err && err.message ? err.message : err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  Panel E2E · flujo inicial "${DEFAULT_FLOW}" (se cambia desde el panel)\n  ${url}\n\n  Ctrl-C para salir.\n`);
  spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
});
