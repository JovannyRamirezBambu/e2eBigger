/** Utilidades de presentación: resaltado de JSON, decodificación de credenciales, `curl`. */

export function b64urlDecode(str: string): string {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  try {
    return decodeURIComponent(
      bin
        .split('')
        .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join(''),
    );
  } catch {
    return bin;
  }
}

export type DecodedJwt = { header: unknown; payload: unknown };

/** Sin verificar firma: es un panel de diagnóstico local, solo lee los claims. */
export function decodeJwt(token: string): DecodedJwt | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    return { header: JSON.parse(b64urlDecode(parts[0]!)), payload: JSON.parse(b64urlDecode(parts[1]!)) };
  } catch {
    return null;
  }
}

// El tercer miembro usa un literal ('other'), no `string`: con `scheme: string`
// TS no puede descartarlo al comparar `auth.scheme === 'Bearer'` (string admite
// 'Bearer'), y el discriminated union deja de angostar el tipo en los otros dos.
export type AuthDescriptor =
  | { scheme: 'Bearer'; jwt: DecodedJwt | null }
  | { scheme: 'Basic'; user: string; pass: string }
  | { scheme: 'other' };

/** Describe un header `Authorization`: esquema + credencial decodificada. */
export function describeAuth(value: string): AuthDescriptor {
  const sp = value.indexOf(' ');
  const scheme = sp === -1 ? value : value.slice(0, sp);
  const rest = sp === -1 ? '' : value.slice(sp + 1);
  if (/^Bearer$/i.test(scheme)) return { scheme: 'Bearer', jwt: decodeJwt(rest) };
  if (/^Basic$/i.test(scheme)) {
    try {
      const decoded = atob(rest);
      const idx = decoded.indexOf(':');
      return {
        scheme: 'Basic',
        user: idx >= 0 ? decoded.slice(0, idx) : decoded,
        pass: idx >= 0 ? decoded.slice(idx + 1) : '',
      };
    } catch {
      return { scheme: 'Basic', user: '', pass: '' };
    }
  }
  return { scheme: 'other' };
}

export function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export type CurlSource = { method: string; url: string; reqHeaders?: Record<string, string>; reqBody: unknown };

/** Un comando reproducible a mano, credenciales incluidas — mismo header que se mandó. */
export function buildCurl(entry: CurlSource): string {
  const parts = ['curl', '-i', '-X', entry.method, shQuote(entry.url)];
  Object.entries(entry.reqHeaders ?? {}).forEach(([k, v]) => parts.push('-H', shQuote(`${k}: ${v}`)));
  if (entry.reqBody !== null && entry.reqBody !== undefined) {
    const body = typeof entry.reqBody === 'string' ? entry.reqBody : JSON.stringify(entry.reqBody);
    parts.push('-d', shQuote(body));
  }
  return parts.join(' ');
}

export function bodyAsText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

const HTTP_METHOD_COLOR: Record<string, string> = {
  GET: '#1d5a87',
  POST: '#2f6b46',
  PUT: '#9a6410',
  PATCH: '#9a6410',
  DELETE: '#a3402c',
};

export function methodColor(method: string): string {
  return HTTP_METHOD_COLOR[method.toUpperCase()] ?? '#5d666e';
}
