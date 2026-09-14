/**
 * Arranca el app `auth` de BCB para pruebas locales del login de agencias.
 *
 * `AuthJwtService.signRs256('agency')` pide el secreto del rol a SecretManagerService
 * (AWS). Para agency ese secreto es un JSON {privateKey, kid, iss} — así BCB no necesita
 * JWT_AGENCY_ISS/KID en el entorno de Lambda, que está al límite de 4 KB — y `verifyRs256`
 * baja la pública del JWKS que indica ese `iss`. Aquí se sustituye UN provider:
 * SecretManagerService devuelve ese JSON armado con la privada de prueba de run/keys/,
 * y el JWKS lo sirve lib/jwks-server.js con la pública del mismo par.
 * Controller, servicio, guard y Prisma son los de producción.
 *
 * Se ejecuta DESDE el repo de BCB (lo copia ahí el harness) por los alias de tsconfig.
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { CognitoFilter } from '@app/cognito/filters/cognito.filter';
import { SecretManagerService } from '@app/secret-manager';
import { PrismaClientValidationFilter } from '@prisma/prisma/filters/prisma-client.filter';
import { PrismaExceptionFilter } from '@prisma/prisma/filters/prisma-exception.filter';
import { JwtFilter } from '@shared/filters/jwt.filter';
import { AuthModule } from '../../apps/auth/src/auth.module';

const privateKeyPath = process.env.E2E_AGENCY_PRIVATE_KEY_PATH;
if (!privateKeyPath) throw new Error('falta E2E_AGENCY_PRIVATE_KEY_PATH');
const AGENCY_KID = process.env.E2E_AGENCY_KID;
const AGENCY_ISS = process.env.E2E_AGENCY_ISS;
if (!AGENCY_KID || !AGENCY_ISS) throw new Error('faltan E2E_AGENCY_KID / E2E_AGENCY_ISS');
const AGENCY_SECRET_NAME = process.env.JWT_AGENCY_PRIVATE_KEY_SECRET_NAME ?? '';
// Mismo formato que provisiona scripts/provision-jwks-infra.sh en AWS.
const AGENCY_SECRET_JSON = JSON.stringify({
  privateKey: fs.readFileSync(privateKeyPath, 'utf-8'),
  kid: AGENCY_KID,
  iss: AGENCY_ISS,
});

// Solo conoce el secreto del rol agency. Cualquier otro nombre falla ruidosamente:
// si un caso de este flujo llegara a pedir otra llave, es un error de la prueba, no
// algo que deba resolverse con un valor inventado.
const fakeSecretManager = {
  getSecretString: async (name: string) => {
    if (name === AGENCY_SECRET_NAME) return AGENCY_SECRET_JSON;
    throw new Error(`[e2e] SecretManagerService.getSecretString('${name}') no está simulado`);
  },
  getSecretValue: async (name: string) => {
    throw new Error(`[e2e] SecretManagerService.getSecretValue('${name}') no está simulado`);
  },
};

async function main() {
  const moduleRef = await Test.createTestingModule({ imports: [AuthModule] })
    .overrideProvider(SecretManagerService)
    .useValue(fakeSecretManager)
    .compile();

  const app = moduleRef.createNestApplication();

  // Réplica de los pipes/filtros globales de apps/auth/src/main.ts — se lee de ahí,
  // no se asume: el harness debe reflejar el repo (ver lib/bcb-bootstrap.ts).
  const mainTs = fs.readFileSync(
    path.join(__dirname, '..', '..', 'apps', 'auth', 'src', 'main.ts'),
    'utf-8',
  );
  const usaI18n = /new I18nValidationPipe\(/.test(mainTs);
  const pipeOpts = {
    whitelist: true,
    forbidUnknownValues: true,
    forbidNonWhitelisted: true,
    transform: true,
  };
  const filters: Parameters<typeof app.useGlobalFilters> = [
    new JwtFilter(),
    new CognitoFilter(),
    new PrismaExceptionFilter(),
    new PrismaClientValidationFilter(),
  ];
  if (usaI18n) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { I18nValidationExceptionFilter, I18nValidationPipe } = require('nestjs-i18n');
    filters.push(new I18nValidationExceptionFilter({ detailedErrors: false }));
    app.useGlobalPipes(new I18nValidationPipe(pipeOpts));
  } else {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ValidationPipe } = require('@nestjs/common');
    app.useGlobalPipes(new ValidationPipe(pipeOpts));
  }
  app.useGlobalFilters(...filters);
  console.log(`[e2e] pipe de validación espejado de main.ts: ${usaI18n ? 'I18nValidationPipe' : 'ValidationPipe'}`);

  await app.init();
  const port = Number(process.env.PORT ?? 3012);
  await app.listen(port);
  console.log(`apps/auth (e2e) escuchando en :${port} — JWKS agency (desde el secreto): ${AGENCY_ISS}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
