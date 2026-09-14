/**
 * Alta de la agencia de prueba ejecutando LOS MISMOS SQL manuales que se corren en
 * develop (ER/_portal-agencias-docs). Así el harness también los prueba: si un
 * nombre de columna está mal, falla aquí y no en la base de develop.
 *
 * Idempotente: los SQL son upserts y además se limpian las sesiones y se
 * restaura el estado ACTIVE antes de cada corrida.
 */
import { bcbDb } from '@harness/db';
import { ER_ROOT } from '@harness/paths';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { AGENCIA, BCB_DB, COMPANY, SAT_DB } from './scenarios';

const SQL_DIR = path.join(ER_ROOT, '_portal-agencias-docs');

function psql(target: { container: string; user: string; db: string }, sql: string, vars: string[] = []): string {
  const args = ['exec', '-i', target.container, 'psql', '-U', target.user, '-d', target.db, '-v', 'ON_ERROR_STOP=1'];
  for (const v of vars) args.push('-v', v);
  args.push('-f', '-');
  return execFileSync('docker', args, { input: sql, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

export async function seed(): Promise<void> {
  const db = bcbDb();

  // 1. Una Company activa: el SQL 01 la exige (misma regla que AgenciesService.create).
  await db.company.upsert({
    where: { key: COMPANY.key },
    create: { ...COMPANY, isActive: true },
    update: { isActive: true, deletedAt: null },
  });

  // 2. Agencia en BCB — SQL manual 01, tal cual.
  const sql01 = fs.readFileSync(path.join(SQL_DIR, '01-bcb-agencia-prueba-develop.sql'), 'utf-8');
  psql(BCB_DB, sql01);

  const agency = await db.agency.findUniqueOrThrow({
    where: { id: AGENCIA.id },
    include: { rfcs: true },
  });
  if (agency.rfcs.find((r) => r.isPrimary)?.email !== AGENCIA.email) {
    throw new Error(`el SQL 01 no dejó el correo esperado (${AGENCIA.email})`);
  }

  // 3. Copia local en el satélite — SQL manual 02, con el companyId que dejó el 01.
  const sql02 = fs.readFileSync(path.join(SQL_DIR, '02-satelite-agencia-prueba-develop.sql'), 'utf-8');
  psql(SAT_DB, sql02, [`company_id=${agency.companyId}`]);

  // 4. Estado limpio para los casos: ACTIVE y sin sesiones previas.
  await db.agency.update({ where: { id: AGENCIA.id }, data: { status: 'ACTIVE', deletedAt: null } });
  await db.agencySession.deleteMany({ where: { agencyId: AGENCIA.id } });

  console.log(`  agencia ${AGENCIA.id} lista en BCB y en el satélite (company ${agency.companyId})`);
}
