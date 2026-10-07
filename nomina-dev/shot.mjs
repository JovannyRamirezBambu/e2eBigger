// Captura la pestaña del admin: node shot.mjs [archivo.png]
import { connect, adminPage } from './lib.mjs';
const out = process.argv[2] ?? 'shot.png';
const { browser, context } = await connect();
try {
  const page = await adminPage(context);
  await page.screenshot({ path: out });
  console.log(`${page.url()} → ${out}`);
} finally {
  // Nunca cerramos `browser`: es el Chrome real y compartido con Jovanny — browser.close()
  // lo mataría (y con noDefaults+isLocal, Playwright lo trata como propio). Solo soltamos
  // la conexión CDP dejando que el proceso termine — pero el WebSocket abierto no deja
  // salir a node solo, así que forzamos la salida explícita.
  process.exit(process.exitCode ?? 0);
}
