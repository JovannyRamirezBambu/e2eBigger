/**
 * Arranca el app `agencies` de BCB (Portal de Agencias, AD01–AD15) para pruebas locales.
 *
 * Es el eslabón final de la cadena: adapter-bcb le pega firmando con la llave del leg
 * `adapter-bcb`, igual que al app `bcb`. Se sustituyen TRES providers y nada más:
 *
 *   SecretManagerService → devuelve la llave pública de prueba (run/keys/), para que
 *                          BigerBcbAuthGuard verifique RS256 de verdad sin ir a AWS
 *   EmailService         → registra el correo de alta de agencia en el log (no SES)
 *   S3Service            → devuelve una URL falsa para el XLSX del reporte (no sube a S3)
 *
 * Controllers, servicios, validación y Prisma son los de producción. Se ejecuta DESDE el
 * repo de BCB (lo copia ahí el harness) por los alias de tsconfig.
 */
import 'dotenv/config';
import * as fs from 'fs';
import { Test } from '@nestjs/testing';
import { I18nValidationExceptionFilter, I18nValidationPipe } from 'nestjs-i18n';
import { PrismaClientValidationFilter } from '@prisma/prisma/filters/prisma-client.filter';
import { PrismaExceptionFilter } from '@prisma/prisma/filters/prisma-exception.filter';
import { EmailService } from '@app/email';
import { S3Service } from '@app/s3/s3.service';
import { SecretManagerService } from '@app/secret-manager';
import { AppModule } from '../../apps/agencies/src/agencies.module';

const publicKeyPath = process.env.E2E_PUBLIC_KEY_PATH;
if (!publicKeyPath) throw new Error('falta E2E_PUBLIC_KEY_PATH');
const PUBLIC_KEY_PEM = fs.readFileSync(publicKeyPath, 'utf-8');

const fakeSecretManager = {
  getSecretString: async () => PUBLIC_KEY_PEM,
  getSecretValue: async () => ({}),
};

/**
 * El alta de agencia (AD02) y de sucursal (AD11) mandan la contraseña temporal por
 * correo. Se registra en el log con un prefijo estable para que un caso del harness
 * pueda leerla si algún día prueba el primer login con la contraseña generada.
 */
const fakeEmail = {
  sendEmail: async (args: { sendMailOptions?: { to?: string } }) => {
    console.log(`[EMAIL] to=${args?.sendMailOptions?.to ?? '?'}`);
    return { MessageId: 'e2e-local' };
  },
  renderMail: async () => '<html>e2e</html>',
};

const fakeS3 = {
  uploadFile: async ({ key }: { key: string }) => {
    console.log(`[S3] uploadFile ${key}`);
    return { key };
  },
  generateFileUrl: (key: string) => `http://localhost:9999/e2e-bucket/${key}`,
};

async function main() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SecretManagerService)
    .useValue(fakeSecretManager)
    .overrideProvider(EmailService)
    .useValue(fakeEmail)
    .overrideProvider(S3Service)
    .useValue(fakeS3)
    .compile();

  const app = moduleRef.createNestApplication();

  // Mismos filtros y pipe que apps/agencies/src/main.ts: si el DTO rechaza algo, el
  // harness tiene que ver el mismo 400 que vería en AWS.
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

  const port = Number(process.env.PORT ?? 3013);
  await app.listen(port);
  console.log(`[e2e] app agencies de BCB escuchando en :${port}`);
}

void main();
