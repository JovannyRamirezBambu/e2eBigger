#!/usr/bin/env node
/**
 * InRoute falso en modo standalone — para `./e2e up/test tomtom`, sin el panel.
 *
 * Mismo simulador que usa el panel (inroute.cjs, contrato REAL verificado contra
 * el sandbox de Adsum), más rutas de administración para las pruebas:
 *
 *   POST /__e2e/corridas        → registrarCorrida (da de alta unidad/operador/
 *                                 grupo/instrucción y devuelve los IDs)
 *   POST /__e2e/terminar-viaje  → terminarViaje (nStatusViaje=6 + telemetría)
 *   POST /__e2e/reiniciar       → estado limpio
 *   GET  /__e2e/estado          → dump del estado (viajes, órdenes, catálogos)
 *
 * El prefijo __e2e no existe en el InRoute real: si el satélite alguna vez lo
 * llamara, sería un bug del satélite, no del harness.
 */
const { InrouteFalso, crearServidorInroute, GEOCERCA_ORIGEN, GEOCERCA_DESTINO } = require('./inroute.cjs');

const PORT = Number(process.env.E2E_FAKE_INROUTE_PORT || 7803);
const falso = new InrouteFalso();

const base = crearServidorInroute(
  falso,
  () => ({ modo: 'simulado' }),
  (registro) => {
    if (process.env.E2E_INROUTE_VERBOSE) {
      console.log(`[inroute] ${registro.metodo} ${registro.ruta} → ${registro.respuesta.status}`);
    }
  },
);

// Envolver el listener del simulador con las rutas de administración.
const listeners = base.listeners('request').slice();
base.removeAllListeners('request');
base.on('request', (req, res) => {
  if (!req.url.startsWith('/__e2e/')) {
    for (const l of listeners) l.call(base, req, res);
    return;
  }

  let crudo = '';
  req.on('data', (c) => (crudo += c));
  req.on('end', () => {
    let body = {};
    try {
      body = crudo ? JSON.parse(crudo) : {};
    } catch {
      /* cuerpo no-JSON */
    }
    let out;
    let status = 200;
    try {
      if (req.method === 'POST' && req.url === '/__e2e/corridas') {
        out = { ...falso.registrarCorrida(body), GEOCERCA_ORIGEN, GEOCERCA_DESTINO };
      } else if (req.method === 'POST' && req.url === '/__e2e/terminar-viaje') {
        out = falso.terminarViaje(body.nViaje, body.telemetria) || { error: 'viaje no encontrado' };
      } else if (req.method === 'POST' && req.url === '/__e2e/reiniciar') {
        falso.reiniciar();
        out = { ok: true };
      } else if (req.method === 'GET' && req.url === '/__e2e/estado') {
        out = falso.estado;
      } else {
        status = 404;
        out = { error: `ruta __e2e desconocida: ${req.method} ${req.url}` };
      }
    } catch (err) {
      status = 500;
      out = { error: String((err && err.message) || err) };
    }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(out));
  });
});

base.listen(PORT, () => console.log(`InRoute falso (standalone) escuchando en :${PORT}`));
