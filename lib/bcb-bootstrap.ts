/**
 * Arranca la app `bcb` para pruebas locales.
 *
 * No se usa `pnpm dev:bcb` porque BigerBcbAuthGuard no tiene bypass local:
 * siempre resuelve la llave pública desde AWS Secrets Manager. Aquí se sustituyen
 * DOS providers y nada más:
 *
 *   SecretManagerService → devuelve la llave pública de prueba (run/keys/)
 *   SnsService           → registra los publish en el log en vez de ir a AWS
 *
 * El guard sigue verificando RS256 de verdad, y los controllers, el servicio y
 * Prisma son exactamente los de producción. Se ejecuta DESDE el repo de BCB
 * (lo copia ahí el harness) por los alias de tsconfig.
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { PrismaClientValidationFilter } from '@prisma/prisma';
import { PrismaExceptionFilter } from '@prisma/prisma/filters/prisma-exception.filter';
import { SecretManagerService } from '@app/secret-manager';
import { SnsService } from '@app/sns';
import { AppModule } from '../../apps/bcb/src/app.module';

const publicKeyPath = process.env.E2E_PUBLIC_KEY_PATH;
if (!publicKeyPath) throw new Error('falta E2E_PUBLIC_KEY_PATH');
const PUBLIC_KEY_PEM = fs.readFileSync(publicKeyPath, 'utf-8');

const fakeSecretManager = {
  getSecretString: async () => PUBLIC_KEY_PEM,
  getSecretValue: async () => ({}),
};

// Proxy en vez de una clase: SnsService tiene ~20 métodos publishX y solo nos
// interesa observar cuáles se llaman. `then` se excluye a propósito — si no,
// Nest cree que el provider es una promesa y se cuelga esperando resolverla.
const fakeSns = new Proxy(
  {},
  {
    get(_target, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return async (...args: unknown[]) => {
        console.log(`[SNS] ${prop} ${JSON.stringify(args[0] ?? null)}`);
        return { MessageId: 'e2e-local' };
      };
    },
  },
);

async function main() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SecretManagerService)
    .useValue(fakeSecretManager)
    .overrideProvider(SnsService)
    .useValue(fakeSns)
    .compile();

  const app = moduleRef.createNestApplication();

  // Réplica de los pipes/filtros globales de apps/bcb. Sin ellos no corre ninguna
  // validación de DTO (@IsISO8601, @Matches, forbidNonWhitelisted) y las pruebas
  // darían falsos PASS en payloads que en AWS responden con error.
  //
  // Cuál se usa NO se decide acá: se lee de main.ts del repo. Tener uno fijo hacía
  // que el harness mintiera — montaba el ValidationPipe plano mientras el repo
  // montaba el de i18n, así que los casos de validación pasaban aquí y en AWS
  // habrían dado 500. El harness debe reflejar el repo, no lo que nos gustaría.
  const mainTs = fs.readFileSync(
    path.join(__dirname, '..', '..', 'apps', 'bcb', 'src', 'main.ts'),
    'utf-8',
  );
  const usaI18n = /new I18nValidationPipe\(/.test(mainTs);

  const filters: Parameters<typeof app.useGlobalFilters> = [
    new PrismaExceptionFilter(),
    new PrismaClientValidationFilter(),
  ];
  const pipeOpts = {
    whitelist: true,
    forbidUnknownValues: true,
    forbidNonWhitelisted: true,
    transform: true,
  };

  if (usaI18n) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { I18nValidationExceptionFilter, I18nValidationPipe } = require('nestjs-i18n');
    filters.push(new I18nValidationExceptionFilter({ detailedErrors: false }));
    app.useGlobalPipes(new I18nValidationPipe(pipeOpts));
  } else {
    app.useGlobalPipes(new ValidationPipe(pipeOpts));
  }
  app.useGlobalFilters(...filters);
  console.log(`[e2e] pipe de validación espejado de main.ts: ${usaI18n ? 'I18nValidationPipe' : 'ValidationPipe'}`);

  await app.init();
  const port = Number(process.env.PORT ?? 3009);
  await app.listen(port);
  console.log(`apps/bcb (e2e) escuchando en :${port}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
