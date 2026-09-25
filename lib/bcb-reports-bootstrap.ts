/**
 * Arranca el app `reports` de BCB (satélite de Reporteo) para pruebas locales.
 *
 * Es el eslabón final de la cadena: adapter-bcb le pega firmando con la llave del leg
 * `adapter-bcb`, igual que a los apps `bcb` y `agencies`. Se sustituyen DOS providers y
 * nada más:
 *
 *   SecretManagerService → devuelve la llave pública de prueba (run/keys/), para que
 *                          BigerBcbAuthGuard verifique RS256 de verdad sin ir a AWS
 *   S3Service            → guarda el .xlsx en disco y lo sirve por HTTP desde aquí
 *
 * Por qué el S3 de mentira **sí guarda de verdad**: el reporte se descarga con un 302 a
 * una URL prefirmada, así que un doble que solo devuelva una URL falsa deja la descarga
 * rota y el flujo no prueba nada. Este guarda los bytes en `run/reports-bucket/` y levanta
 * un servidor mínimo que los sirve, de modo que la cadena completa —incluido el 302 y el
 * archivo que llega al navegador— funciona **sin credenciales de AWS**.
 *
 * Controllers, plantillas, mapeo de columnas, validación y Prisma son los de producción.
 * Se ejecuta DESDE el repo de BCB (lo copia ahí el harness) por los alias de tsconfig.
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { I18nValidationExceptionFilter, I18nValidationPipe } from 'nestjs-i18n';
import { PrismaClientValidationFilter } from '@prisma/prisma/filters/prisma-client.filter';
import { PrismaExceptionFilter } from '@prisma/prisma/filters/prisma-exception.filter';
import { S3Service } from '@app/s3/s3.service';
import { SecretManagerService } from '@app/secret-manager';
import { AppModule } from '../../apps/reports/src/app.module';

const publicKeyPath = process.env.E2E_PUBLIC_KEY_PATH;
if (!publicKeyPath) throw new Error('falta E2E_PUBLIC_KEY_PATH');
const PUBLIC_KEY_PEM = fs.readFileSync(publicKeyPath, 'utf-8');

const BUCKET_DIR = process.env.E2E_BUCKET_DIR;
if (!BUCKET_DIR) throw new Error('falta E2E_BUCKET_DIR');
const FILES_PORT = Number(process.env.E2E_FILES_PORT ?? 7806);
const FILES_BASE = `http://localhost:${FILES_PORT}`;

const fakeSecretManager = {
  getSecretString: async () => PUBLIC_KEY_PEM,
  getSecretValue: async () => ({}),
};

/** Ruta en disco de una llave de S3, plana para no crear árboles de carpetas. */
const onDisk = (key: string) => path.join(BUCKET_DIR, key.replace(/[/\\]/g, '__'));

const localBucket = {
  uploadFile: async ({ key, buffer }: { key: string; buffer: Buffer }) => {
    fs.mkdirSync(BUCKET_DIR, { recursive: true });
    fs.writeFileSync(onDisk(key), buffer);
    console.log(`[BUCKET] ${key} (${buffer.length} bytes)`);
    return { key };
  },
  fileExists: async (key: string) => fs.existsSync(onDisk(key)),
  createSignedUrlDownload: async (key: string, expiresIn = 900) => ({
    url: `${FILES_BASE}/${encodeURIComponent(key)}`,
    expiresIn,
  }),
  generateFileUrl: (key: string) => `${FILES_BASE}/${encodeURIComponent(key)}`,
  downloadFile: async (url: string) =>
    fs.readFileSync(onDisk(decodeURIComponent(new URL(url).pathname.slice(1)))),
};

/** Sirve el "bucket" local, para que el 302 de la descarga llegue a algo real. */
function startFileServer(): void {
  http
    .createServer((req, res) => {
      const key = decodeURIComponent((req.url ?? '/').slice(1));
      const file = onDisk(key);
      if (!key || !fs.existsSync(file)) {
        res.writeHead(404).end('no existe');
        return;
      }
      res.writeHead(200, {
        'Content-Type':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${path.basename(file)}"`,
      });
      res.end(fs.readFileSync(file));
    })
    .listen(FILES_PORT, () => console.log(`[BUCKET] sirviendo en ${FILES_BASE}`));
}

async function main() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SecretManagerService)
    .useValue(fakeSecretManager)
    .overrideProvider(S3Service)
    .useValue(localBucket)
    .compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(
    new PrismaExceptionFilter(),
    new PrismaClientValidationFilter(),
    new I18nValidationExceptionFilter({ detailedErrors: false }),
  );
  app.useGlobalPipes(
    new I18nValidationPipe({
      whitelist: true,
      forbidUnknownValues: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  startFileServer();
  await app.listen(Number(process.env.PORT ?? 3010));
  console.log(`app reports escuchando en ${process.env.PORT ?? 3010}`);
}

void main();
