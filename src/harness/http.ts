/**
 * Cliente HTTP con firma JWT RS256, para hablarle a un satélite como lo haría un
 * adapter de BIGER.
 *
 * El JWT se firma con `crypto` de Node (nada de dependencias): los satélites
 * verifican RS256 con la llave pública correspondiente, y no hay nada más que
 * hacer que armar header.payload.firma.
 */
import * as crypto from 'crypto';
import { readKey } from './paths';
import { recordHttp } from './trace';

const b64url = (buf: Buffer | string) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export type SignOpts = {
  /** `leg` del par de llaves en run/keys (p. ej. 'adapter-bcb'). */
  leg: string;
  subject?: string;
  issuer?: string;
  audience?: string;
  ttlSeconds?: number;
  /** Firma con una llave efímera para probar el rechazo por firma inválida. */
  useWrongKey?: boolean;
  /** Claims extra que exija el guard del satélite (p. ej. userType, userToken). */
  extraClaims?: Record<string, unknown>;
  /**
   * `kid` del header. Solo hace falta cuando el verificador resuelve la llave por
   * JWKS (el autenticador BCB multi-emisor); con llave pública estática se omite.
   */
  keyId?: string;
};

/**
 * Thumbprint RFC 7638 de la pública de `leg`: el mismo `kid` que publica
 * lib/jwks-server.js. Vive acá y no como constante para que regenerar las llaves
 * no deje al firmador anunciando un kid que el JWKS ya no sirve.
 */
export function jwkThumbprint(leg: string): string {
  const jwk = crypto.createPublicKey(readKey(leg, 'public')).export({ format: 'jwk' }) as {
    e: string;
    kty: string;
    n: string;
  };
  const canonical = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
  return crypto.createHash('sha256').update(canonical).digest('base64url');
}

export function signJwt(opts: SignOpts): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    iat: now,
    exp: now + (opts.ttlSeconds ?? 600),
  };
  if (opts.subject) payload.sub = opts.subject;
  if (opts.issuer) payload.iss = opts.issuer;
  if (opts.audience) payload.aud = opts.audience;
  Object.assign(payload, opts.extraClaims ?? {});

  const privateKey = opts.useWrongKey
    ? crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    : crypto.createPrivateKey(readKey(opts.leg, 'private'));

  const header: Record<string, string> = { alg: 'RS256', typ: 'JWT' };
  if (opts.keyId) header.kid = opts.keyId;

  const head = b64url(JSON.stringify(header));
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey));
  return `${head}.${body}.${sig}`;
}

export type Res<T = unknown> = { status: number; body: T; text: string };

/**
 * Cliente de un satélite. El genérico de `post`/`get` es el DTO real del
 * satélite, así que un campo fuera del contrato no compila — que es justo la
 * clase de error que en producción se traduce en un evento perdido.
 */
export class SatelliteClient {
  constructor(
    private readonly baseUrl: string,
    private readonly sign: SignOpts,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown, override?: Partial<SignOpts>): Promise<Res<T>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${signJwt({ ...this.sign, ...override })}`,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* respuesta no-JSON: se deja el texto crudo */
    }
    recordHttp({ method, url, reqHeaders: headers, reqBody: body ?? null, status: res.status, resBody: parsed });
    return { status: res.status, body: parsed as T, text };
  }

  get<T = unknown>(path: string, override?: Partial<SignOpts>) {
    return this.request<T>('GET', path, undefined, override);
  }

  /** `Body` se ata al DTO del satélite en el sitio de llamada. */
  post<T = unknown, Body = unknown>(path: string, body: Body, override?: Partial<SignOpts>) {
    return this.request<T>('POST', path, body, override);
  }
}

/** Health de Spring Boot / cualquier endpoint que solo interese si responde. */
export async function isUp(url: string, timeoutMs = 2500): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/** ¿Hay algo escuchando? Sirve para procesos sin endpoint de health. */
export async function portOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  const net = await import('net');
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host });
    const done = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(1500);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}
