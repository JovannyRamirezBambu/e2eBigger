#!/usr/bin/env node
/**
 * Vista de PRUEBA MANUAL del módulo de Reportes.
 *
 *   ./e2e demo reporteo      →  http://localhost:7790
 *
 * No es la pantalla del CMS: ésa la construye el equipo de frontend en
 * `BCB_EstrellaRoja_Administrador`. Esto existe para **probar la cadena a mano** —
 * elegir plantilla, ver qué filtros pide cada una, generar y bajar el archivo — sin
 * depender de que la pantalla real esté lista, y para tener a la vista la petición y la
 * respuesta cuando algo no cuadra.
 *
 * Sirve una sola página estática: le pega directo al adapter (:8097), que en local corre
 * con CORS abierto y `JWT_BYPASS=true`. Sin build, sin dependencias y sin backend propio
 * a propósito: es una herramienta de prueba, no código de producto.
 *
 * Requiere el stack arriba:  ./e2e up reporteo
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT ?? 7790);
const ADAPTER = process.env.ADAPTER_URL ?? 'http://localhost:8097/reportes';
const PUBLIC_DIR = path.join(__dirname, 'public');

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

http
  .createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    // La página necesita saber a qué adapter pegarle; se lo decimos sin build.
    if (url === '/config.js') {
      res.writeHead(200, { 'Content-Type': TIPOS['.js'] });
      res.end(`window.ADAPTER_URL = ${JSON.stringify(ADAPTER)};`);
      return;
    }
    const file = path.join(PUBLIC_DIR, url === '/' ? 'index.html' : url);
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) {
      res.writeHead(404).end('no existe');
      return;
    }
    res.writeHead(200, { 'Content-Type': TIPOS[path.extname(file)] ?? 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  })
  .listen(PORT, () => {
    console.log(`\n  Vista de prueba de Reportes → http://localhost:${PORT}`);
    console.log(`  adapter: ${ADAPTER}`);
    console.log(`  (requiere el stack arriba: ./e2e up reporteo)\n`);
  });
