#!/usr/bin/env node
/**
 * Corre el proceso programado de telemetría del satélite —el mismo que ejecuta la
 * función Lambda `tomtomSync` cada 30 minutos— y dice cuántos viajes cerró.
 *
 *   node demo-tomtom/sync-runner.cjs <ruta-del-repo-del-satelite>
 *
 * Usa el código **compilado** del satélite (`dist/`), no el fuente: Nest resuelve
 * las dependencias del constructor con la metadata que emite `tsc`, y los
 * compiladores rápidos (esbuild/tsx) no la generan — con ellos el contexto no
 * levanta. `dist/` lo produce el propio `nest start` cuando el flujo levanta el
 * satélite, así que si el stack está arriba, está compilado.
 *
 * La configuración llega por variables de entorno (el panel le pasa el .env del
 * satélite con INROUTE_BASE_URL apuntando al InRoute que esté activo). Imprime
 * JSON en stdout: es su contrato con el panel.
 */
const path = require('path');
const fs = require('fs');

async function main() {
  const repo = process.argv[2];
  if (!repo) throw new Error('falta la ruta del repo del satélite');

  // `nest start` compila con rootDir en la raíz del repo (por prisma.config.ts),
  // así que el código del satélite queda un nivel adentro: dist/src/.
  const dist = path.join(repo, 'dist', 'src');
  if (!fs.existsSync(path.join(dist, 'tomtom.module.js'))) {
    throw new Error('el satélite no está compilado (falta dist/src). Levantá el stack: ./e2e up tomtom');
  }

  const { NestFactory } = require(path.join(repo, 'node_modules', '@nestjs', 'core'));
  const { TomtomModule } = require(path.join(dist, 'tomtom.module'));
  const { TomtomService } = require(path.join(dist, 'tomtom.service'));
  const { PrismaService } = require(path.join(dist, 'prisma', 'prisma.service'));

  const app = await NestFactory.createApplicationContext(TomtomModule, { logger: ['warn', 'error'] });
  try {
    const prisma = app.get(PrismaService);
    const antes = await prisma.tomTomTripData.count();
    await app.get(TomtomService).syncFinishedTrips();
    const despues = await prisma.tomTomTripData.count();
    console.log(JSON.stringify({ sincronizados: despues - antes }));
  } finally {
    await app.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(String((err && err.message) || err));
    process.exit(1);
  });
