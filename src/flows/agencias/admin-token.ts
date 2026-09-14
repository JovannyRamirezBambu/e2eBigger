import { createSign } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Token de ADMINISTRADOR para el satélite Portal de Agencias.
 *
 * El guard del satélite registra una llave pública por consumidor
 * (`JWT_PUBLIC_KEY_<NOMBRE>`) y acepta cualquier token RS256 que verifique con
 * alguna de ellas. Los de agencia (claim `role: "agency"`) caen en el carril
 * restringido de `@AgencyAccess`; cualquier otro payload válido es tratado como
 * administración — así es como le pega adapter-portalagencias a `/agencies/sync`.
 *
 * Acá se firma con la privada del leg `adapter-pa`, cuya pública el harness pone
 * en `JWT_PUBLIC_KEY_ADAPTER_PORTALAGENCIAS`. Es el mismo camino que usaría el
 * frontend de administración detrás de BIGER.
 *
 * Se firma a mano con `crypto` en vez de traer `jsonwebtoken`: el harness no tiene
 * esa dependencia y un JWT RS256 son tres segmentos en base64url.
 */
const KEYS_DIR =
  process.env.E2E_KEYS_DIR ?? path.join(__dirname, '../../../run/keys');
const LLAVE_ADMIN = path.join(KEYS_DIR, 'adapter-pa-private-pkcs8.pem');

const b64url = (valor: Buffer | string): string =>
  Buffer.from(valor)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export function adminToken(
  opciones: { expiraEn?: number; payload?: Record<string, unknown> } = {},
): string {
  const pem = fs.readFileSync(LLAVE_ADMIN, 'utf8');
  const ahora = Math.floor(Date.now() / 1000);

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      sub: 'e2e-admin',
      name: 'E2E Admin',
      iss: 'adapter-portalagencias',
      iat: ahora,
      exp: ahora + (opciones.expiraEn ?? 3600),
      ...opciones.payload,
    }),
  );

  const firma = createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign(pem);

  return `${header}.${payload}.${b64url(firma)}`;
}
