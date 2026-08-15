/**
 * Cliente Prisma de BCB, tipado, importado del client generado del propio repo.
 *
 * Esto es la mitad del motivo de haber pasado a TypeScript: en vez de
 * `bcb_sql "SELECT status FROM \"TravelCard\" WHERE id='$card';"` (una string sin
 * red de seguridad), se escribe `db.travelCard.findUnique(...)` con
 * autocompletado, y si una columna cambia de nombre el harness deja de compilar.
 */
import { PrismaPg } from '../../../BCB_EstrellaRoja_Backend/node_modules/@prisma/adapter-pg';
import { PrismaClient } from '@bcb/prisma';

export const BCB_DB_URL = process.env.E2E_BCB_DB_URL ?? 'postgresql://bcb:bcb@localhost:5436/bcb';

let client: PrismaClient | undefined;

export function bcbDb(): PrismaClient {
  if (!client) {
    const adapter = new PrismaPg({ connectionString: BCB_DB_URL, ssl: false });
    client = new PrismaClient({ adapter });
  }
  return client;
}

/**
 * Cliente Prisma del satélite Venta a Bordo (su propia base, desacoplada de BCB).
 *
 * Se importa del client que ese repo genera en su `node_modules/@prisma/client`
 * (usa el generador por defecto, no un directorio `generated/` como BCB).
 */
export const VA_DB_URL =
  process.env.E2E_VA_DB_URL ?? 'postgresql://venta:venta@localhost:5435/venta_abordo?schema=public';

// eslint-disable-next-line @typescript-eslint/no-var-requires
type VaClientCtor = new (opts: { datasources: { db: { url: string } } }) => VaClient;
export type VaClient = {
  tarjetaViaje: {
    findFirst: (a: unknown) => Promise<Record<string, unknown> | null>;
    findMany: (a?: unknown) => Promise<Record<string, unknown>[]>;
    deleteMany: (a?: unknown) => Promise<{ count: number }>;
    count: (a?: unknown) => Promise<number>;
  };
  ventaABordo: {
    findFirst: (a: unknown) => Promise<Record<string, unknown> | null>;
    deleteMany: (a?: unknown) => Promise<{ count: number }>;
    count: (a?: unknown) => Promise<number>;
  };
  ventaABordoItem: { deleteMany: (a?: unknown) => Promise<{ count: number }>; count: (a?: unknown) => Promise<number> };
  tarjetaViajeLog: { deleteMany: (a?: unknown) => Promise<{ count: number }> };
  notificacionAdapter: {
    findMany: (a?: unknown) => Promise<Record<string, unknown>[]>;
    deleteMany: (a?: unknown) => Promise<{ count: number }>;
  };
  $disconnect: () => Promise<void>;
};

let vaClient: VaClient | undefined;

export function vaDb(): VaClient {
  if (!vaClient) {
    // require y no import: el client del satélite se genera en SU node_modules, y
    // el tipado se declara arriba a mano para no acoplar el tsconfig del harness
    // a la configuración de Prisma de ese repo.
    const mod = require('../../../BIGER_EstrellaRoja_VentaABordo/node_modules/@prisma/client') as {
      PrismaClient: VaClientCtor;
    };
    vaClient = new mod.PrismaClient({ datasources: { db: { url: VA_DB_URL } } });
  }
  return vaClient;
}

export async function closeDb(): Promise<void> {
  await client?.$disconnect();
  client = undefined;
  await vaClient?.$disconnect();
  vaClient = undefined;
}

/** Escotilla de escape para lo que Prisma no expresa bien (resets, agregados). */
export async function raw(sql: string): Promise<void> {
  await bcbDb().$executeRawUnsafe(sql);
}
