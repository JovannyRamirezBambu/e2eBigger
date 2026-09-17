/**
 * Datos del flujo `agencias`. La agencia de prueba NO viene de un seed versionado:
 * la dan de alta los dos SQL manuales de ER/_portal-agencias-docs (decisión del
 * equipo: nada que cree usuarios va en los repos). Estos valores deben coincidir
 * con esos archivos — el seed del harness los ejecuta y luego verifica que quedó
 * exactamente esto.
 */
export const AGENCIA = {
  id: '0f1e2d3c-4b5a-4c6d-8e9f-a0b1c2d3e4f5',
  name: 'Agencia Demo Portal',
  rfc: 'ADP010101AB1',
  email: 'agencia.demo@example.com',
  password: 'AgenciaDemo2026!',
} as const;

/** Company de BCB para la agencia (el SQL 01 toma la primera activa). */
export const COMPANY = {
  key: 'E2EAG',
  shortName: 'E2E Agencias',
  tradeName: 'E2E Agencias Portal',
  legalName: 'E2E Agencias Portal SA de CV',
} as const;

/** Otra agencia, solo para probar que un token no abre datos ajenos. */
export const OTRA_AGENCIA_ID = '11111111-2222-4333-8444-555555555555';

export const PORTS = {
  sat: Number(process.env.E2E_PORT_SAT_AGENCIAS ?? 3002),
  adapterPa: Number(process.env.E2E_PORT_ADAPTER_PA ?? 8094),
  adapterBcb: Number(process.env.E2E_PORT_ADAPTER_BCB ?? 8085),
  bcbAuth: Number(process.env.E2E_PORT_BCB_AUTH ?? 3012),
  jwks: Number(process.env.E2E_PORT_JWKS_AGENCY ?? 7804),
} as const;

export const SAT_URL = `http://localhost:${PORTS.sat}/portal-agencias`;
// Con el prefijo: todo lo que expone adapter-portalagencias cuelga de /portalagencias, igual que
// detrás del balanceador de biger.
export const ADAPTER_PA_URL = `http://localhost:${PORTS.adapterPa}/portalagencias`;
export const BCB_AUTH_URL = `http://localhost:${PORTS.bcbAuth}`;

export const SAT_DB = {
  container: 'biger_estrellaroja_portalagenciasadmin-db-1',
  user: 'agencias',
  db: 'portal_agencias',
} as const;
export const BCB_DB = { container: 'bcb-local-db', user: 'bcb', db: 'bcb' } as const;
