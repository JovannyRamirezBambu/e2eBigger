import { bcbDb, closeDb } from '@harness/db';
import { isUp, portOpen } from '@harness/http';
import { logFile } from '@harness/paths';
import type { Flow, Probe } from '@harness/types';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { cases } from './cases';
import { AGENCIA, PORTS, SAT_DB } from './scenarios';
import { seed } from './seed';

function lastError(service: string): string {
  try {
    const lines = fs.readFileSync(logFile(service), 'utf-8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && i > lines.length - 500; i--) {
      const raw = lines[i]!;
      try {
        const o = JSON.parse(raw) as { level?: string; message?: string };
        if (o.level?.toUpperCase() === 'ERROR') return (o.message ?? '').slice(0, 220);
      } catch {
        if (/ERROR/.test(raw)) return raw.replace(/\x1b?\[[0-9;]*m/g, '').slice(0, 220);
      }
    }
  } catch {
    /* sin log todavía */
  }
  return '';
}

function satSql(sql: string): string {
  try {
    return execFileSync(
      'docker',
      ['exec', SAT_DB.container, 'psql', '-U', SAT_DB.user, '-d', SAT_DB.db, '-tA', '-c', sql],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    return '';
  }
}

async function probe(): Promise<Probe> {
  const { natsUp } = await import('@harness/nats');
  const [upSat, upPa, upBcb, upAuth, upJwks, upNats] = await Promise.all([
    isUp(`http://localhost:${PORTS.sat}/portal-agencias/health`),
    isUp(`http://localhost:${PORTS.adapterPa}/actuator/health`),
    isUp(`http://localhost:${PORTS.adapterBcb}/actuator/health`),
    portOpen(PORTS.bcbAuth),
    isUp(`http://127.0.0.1:${PORTS.jwks}/health`),
    natsUp(),
  ]);
  const sesiones = await bcbDb()
    .agencySession.count({ where: { agencyId: AGENCIA.id } })
    .catch(() => 0);

  return {
    flow: 'agencias',
    escenarios: sesiones,
    nodes: [
      {
        id: 'satelite',
        label: 'satélite Portal de Agencias',
        sub: `:${PORTS.sat} · POST /auth/login · guard @AgencyAccess`,
        up: upSat,
        error: lastError('satelite-agencias'),
      },
      {
        id: 'adapter-portalagencias',
        label: 'adapter-portalagencias',
        sub: `:${PORTS.adapterPa} · /agencies/auth/* público → NATS`,
        up: upPa,
        error: lastError('adapter-portalagencias'),
      },
      {
        id: 'nats',
        label: 'NATS',
        sub: 'request/reply biger.bcb.agencies.auth.*',
        up: upNats,
      },
      {
        id: 'adapter-bcb',
        label: 'adapter-bcb',
        sub: `:${PORTS.adapterBcb} · AgencyResponder → app auth`,
        up: upBcb,
        error: lastError('adapter-bcb'),
      },
      {
        id: 'bcb-auth',
        label: 'BCB app auth',
        sub: `:${PORTS.bcbAuth} · /agency/authenticate · RS256 rol agency`,
        up: upAuth,
        error: lastError('bcb-auth'),
        metrics: { sesiones },
      },
      {
        id: 'jwks',
        label: 'JWKS agency (prueba)',
        sub: `:${PORTS.jwks} · publica la pública del rol agency`,
        up: upJwks,
        error: lastError('jwks-agency'),
        note: 'sustituye al JWKS en S3 de BCB; sin él, refresh y /agency/me dan 401',
      },
    ],
  };
}

async function dbSnapshot(): Promise<Record<string, unknown>[]> {
  const db = bcbDb();
  const agency = await db.agency.findUnique({
    where: { id: AGENCIA.id },
    include: { rfcs: { where: { isPrimary: true } }, sessions: true },
  });
  if (!agency) return [];
  const copia = satSql(`SELECT "nombreComercial" || ' · ' || status FROM "Agencia" WHERE id='${AGENCIA.id}';`);
  return [
    {
      agencia: agency.name,
      correo_login: agency.rfcs[0]?.email ?? null,
      status_bcb: agency.status,
      contrasena_temporal: agency.isTempPassword,
      sesiones_vivas: agency.sessions.length,
      access_expira: agency.sessions[0]?.accessTokenExpiresAt?.toISOString() ?? null,
      copia_satelite: copia || '(no existe)',
    },
  ];
}

export const flow: Flow = {
  name: 'agencias',
  description: 'Login de agencias — Portal de Agencias → adapter-portalagencias → NATS → adapter-bcb → BCB app auth',
  cases,
  seed,
  probe,
  dbSnapshot,
  close: closeDb,
};
