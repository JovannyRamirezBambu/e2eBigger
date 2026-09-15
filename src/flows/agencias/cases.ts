/**
 * Casos del login de agencias. Cadena bajo prueba, de punta a punta y con los
 * guards REALES (sin JWT_BYPASS en ningún eslabón):
 *
 *   satélite  POST /portal-agencias/auth/login
 *     → adapter-portalagencias  POST /agencies/auth/login   (público por app.security.public-paths)
 *     → NATS request/reply      biger.bcb.agencies.auth.*
 *     → adapter-bcb             AgencyResponder → HTTP
 *     → BCB app auth            POST /agency/authenticate    (Agency.passwordHash, RS256 rol agency)
 *
 * Lo que este flujo tiene de propio y por eso se fija con casos:
 *  - los errores de BCB llegan al frontend con su status (401 credenciales, 403 inactiva);
 *  - una agencia conserva UNA sesión viva (agencyId único + upsert), también con logins concurrentes;
 *  - en el satélite un token de agencia solo abre lo marcado con @AgencyAccess() y solo lo propio;
 *  - el refresh token no sirve como Bearer;
 *  - en el adapter solo /agencies/auth/* es público; el resto sigue exigiendo JWT.
 */
import { bcbDb } from '@harness/db';
import type { Report } from '@harness/report';
import { recordHttp } from '@harness/trace';
import type { CaseDef } from '@harness/types';
import { sleep } from '@harness/wait';
import { adminToken } from './admin-token';
import { ADAPTER_PA_URL, AGENCIA, BCB_AUTH_URL, OTRA_AGENCIA_ID, SAT_URL } from './scenarios';

type Res<T = any> = { status: number; body: T; text: string };

async function http<T = any>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  opts: { body?: unknown; token?: string | null } = {},
): Promise<Res<T>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(url, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* 204 u otra respuesta sin JSON */
  }
  recordHttp({ method, url, reqHeaders: headers, reqBody: opts.body ?? null, status: res.status, resBody: parsed });
  return { status: res.status, body: parsed as T, text };
}

type LoginBody = {
  accessToken: string;
  refreshToken: string;
  agency: {
    id: string;
    name: string;
    email: string;
    /** Sucursal con la que se entró: desde AD02/AD11 las credenciales son suyas. */
    branchId: string;
    username: string;
    status: string;
    isTempPassword: boolean;
    creditLimit: number;
    currentDebt: number;
    discountPercent: number;
  };
};

const login = (email: string = AGENCIA.email, password: string = AGENCIA.password) =>
  http<LoginBody>('POST', `${SAT_URL}/auth/login`, { body: { email, password } });
const refresh = (refreshToken: string) =>
  http<{ accessToken: string; refreshToken: string }>('POST', `${SAT_URL}/auth/refresh`, { body: { refreshToken } });
const logout = (refreshToken: string) => http('POST', `${SAT_URL}/auth/logout`, { body: { refreshToken } });
const satGet = (ruta: string, token: string) => http('GET', `${SAT_URL}${ruta}`, { token });

// ── Administración: mismo satélite, token de admin (no de agencia) ───────────
const adminGet = (ruta: string) => http('GET', `${SAT_URL}${ruta}`, { token: adminToken() });
const adminPost = (ruta: string, body: unknown) =>
  http('POST', `${SAT_URL}${ruta}`, { token: adminToken(), body });
const adminPut = (ruta: string, body: unknown) =>
  http('PUT', `${SAT_URL}${ruta}`, { token: adminToken(), body });
const adminPatch = (ruta: string, body: unknown) =>
  http('PATCH', `${SAT_URL}${ruta}`, { token: adminToken(), body });
const adminDelete = (ruta: string) => http('DELETE', `${SAT_URL}${ruta}`, { token: adminToken() });

/**
 * RFC único por corrida: es único global en BCB y estos casos dan de alta sucursales.
 * Debe cumplir el formato oficial (3 letras + 6 dígitos de fecha + 3 alfanuméricos),
 * si no lo rechaza el DTO antes de llegar a la base.
 */
const rfcUnico = (prefijo: string) => {
  const fecha = new Date();
  const aa = String(fecha.getFullYear()).slice(-2);
  const mm = String(fecha.getMonth() + 1).padStart(2, '0');
  const dd = String(fecha.getDate()).padStart(2, '0');
  const sufijo = Date.now().toString(36).slice(-3).toUpperCase();
  return `${prefijo}${aa}${mm}${dd}${sufijo}`;
};
const bcbGet = (ruta: string, token: string) => http('GET', `${BCB_AUTH_URL}${ruta}`, { token });

function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [h, p] = token.split('.');
  const dec = (s: string) => JSON.parse(Buffer.from(s!, 'base64url').toString('utf-8')) as Record<string, unknown>;
  return { header: dec(h!), payload: dec(p!) };
}

const sessions = () => bcbDb().agencySession.findMany({ where: { agencyId: AGENCIA.id } });

/** Deja la agencia INACTIVE mientras corre `fn` y SIEMPRE la restaura. */
async function conAgenciaInactiva(fn: () => Promise<void>): Promise<void> {
  const db = bcbDb();
  await db.agency.update({ where: { id: AGENCIA.id }, data: { status: 'INACTIVE' } });
  try {
    await fn();
  } finally {
    await db.agency.update({ where: { id: AGENCIA.id }, data: { status: 'ACTIVE' } });
  }
}

/** Login que debe salir bien; si no, el caso no tiene sentido y se aborta con contexto. */
async function loginOk(): Promise<LoginBody> {
  const r = await login();
  if (r.status !== 200) throw new Error(`login previo falló: ${r.status} ${r.text.slice(0, 200)}`);
  return r.body;
}

export const cases: CaseDef[] = [
  {
    name: 'a01-login-ok',
    label: 'Login con correo y contraseña → tokens + datos de la agencia + una sesión en BCB',
    run: async (t: Report) => {
      await bcbDb().agencySession.deleteMany({ where: { agencyId: AGENCIA.id } });
      const r = await login();
      t.is('status', 200, r.status, r.text.slice(0, 200));
      t.present('accessToken', r.body?.accessToken);
      t.present('refreshToken', r.body?.refreshToken);
      t.is('agencia.id = UUID de la agencia', AGENCIA.id, r.body?.agency?.id);
      t.is('agencia.name', AGENCIA.name, r.body?.agency?.name);
      t.is('agencia.email = correo del login', AGENCIA.email, r.body?.agency?.email);
      t.is('agencia.status', 'ACTIVE', r.body?.agency?.status);
      t.is('esContrasenaTemporal (el SQL la siembra en false)', false, r.body?.agency?.isTempPassword);
      t.is('porcentajeDescuento como número', 10, r.body?.agency?.discountPercent);

      if (r.body?.accessToken) {
        const { header, payload } = decodeJwt(r.body.accessToken);
        t.is('token RS256', 'RS256', header.alg);
        t.present('token trae kid (JWKS)', header.kid);
        t.is('claim role', 'agency', payload.role);
        t.is('claim token_use', 'access', payload.token_use);
        t.is('claim sub = agencyId', AGENCIA.id, payload.sub);
        t.is('claim email', AGENCIA.email, payload.email);
        const rt = decodeJwt(r.body.refreshToken).payload;
        t.is('refresh token_use', 'refresh', rt.token_use);
      }

      const rows = await sessions();
      t.is('exactamente 1 AgencySession', 1, rows.length);
      t.is('la sesión guarda el access token emitido', r.body?.accessToken, rows[0]?.accessToken);
      t.assert('accessTokenExpiresAt en el futuro', (rows[0]?.accessTokenExpiresAt?.getTime() ?? 0) > Date.now());
    },
  },
  {
    name: 'a02-login-password-incorrecta',
    label: 'Contraseña incorrecta → 401 (el 401 de BCB cruza NATS con su status)',
    run: async (t) => {
      const r = await login(AGENCIA.email, 'NoEsLaContrasena!');
      t.is('status', 401, r.status, r.text.slice(0, 200));
    },
  },
  {
    name: 'a03-login-correo-inexistente',
    label: 'Correo que no existe → 401 genérico (no revela si el correo existe)',
    run: async (t) => {
      const r = await login('nadie@example.com', AGENCIA.password);
      t.is('status', 401, r.status, r.text.slice(0, 200));
    },
  },
  {
    name: 'a04-login-agencia-inactiva',
    label: 'Agencia INACTIVE con contraseña correcta → 403 (AD05: el admin la desactivó)',
    run: async (t) =>
      conAgenciaInactiva(async () => {
        const r = await login();
        t.is('status', 403, r.status, r.text.slice(0, 200));
      }),
  },
  {
    name: 'a05-me-satelite',
    label: 'GET /auth/me con el access token → perfil propio desde el Postgres del satélite',
    run: async (t) => {
      const s = await loginOk();
      const r = await satGet('/auth/me', s.accessToken);
      t.is('status', 200, r.status, r.text.slice(0, 200));
      t.is('id', AGENCIA.id, r.body?.id);
      t.is('name', AGENCIA.name, r.body?.name);
    },
  },
  {
    name: 'a06-refresh-como-bearer',
    label: 'El refresh token como Bearer → 401 (solo el access token abre el satélite)',
    run: async (t) => {
      const s = await loginOk();
      const r = await satGet('/auth/me', s.refreshToken);
      t.is('status', 401, r.status, r.text.slice(0, 200));
    },
  },
  {
    name: 'a07-endpoint-admin-prohibido',
    label: 'Token de agencia contra un endpoint de administración (listar agencias) → 403',
    run: async (t) => {
      const s = await loginOk();
      const r = await satGet('/agencies', s.accessToken);
      t.is('status', 403, r.status, r.text.slice(0, 200));
    },
  },
  {
    name: 'a08-detalle-propio-ok',
    label: 'GET /agencies/:id con su propio id → 200 (@AgencyAccess + dueño)',
    run: async (t) => {
      const s = await loginOk();
      const r = await satGet(`/agencies/${AGENCIA.id}`, s.accessToken);
      t.is('status', 200, r.status, r.text.slice(0, 200));
      t.is('id', AGENCIA.id, r.body?.id);
    },
  },
  {
    name: 'a09-detalle-ajeno-prohibido',
    label: 'GET /agencies/:id con el id de OTRA agencia → 403',
    run: async (t) => {
      const s = await loginOk();
      const r = await satGet(`/agencies/${OTRA_AGENCIA_ID}`, s.accessToken);
      t.is('status', 403, r.status, r.text.slice(0, 200));
    },
  },
  {
    name: 'a10-refresh-renueva',
    label: 'POST /auth/refresh → access token nuevo; el anterior deja de valer en BCB',
    run: async (t) => {
      const s = await loginOk();
      // RS256 es determinista y `iat`/`exp` van en segundos: un refresh dentro del mismo
      // segundo del login produce un JWT byte a byte idéntico (y por tanto la misma
      // sesión). En la vida real pasan minutos; acá se espera al siguiente segundo.
      await sleep(1100);
      const r = await refresh(s.refreshToken);
      t.is('status', 200, r.status, r.text.slice(0, 200));
      t.present('accessToken nuevo', r.body?.accessToken);
      t.assert('el access token cambió', !!r.body?.accessToken && r.body.accessToken !== s.accessToken);
      t.is('el refresh token se conserva', s.refreshToken, r.body?.refreshToken);

      const rows = await sessions();
      t.is('sigue habiendo 1 sesión', 1, rows.length);
      t.is('la sesión apunta al access token nuevo', r.body?.accessToken, rows[0]?.accessToken);

      const viejo = await bcbGet('/agency/me', s.accessToken);
      t.is('BCB rechaza el access token anterior (sesión rotada)', 401, viejo.status);
      const nuevo = await bcbGet('/agency/me', r.body.accessToken);
      t.is('BCB acepta el nuevo', 200, nuevo.status, nuevo.text.slice(0, 200));
    },
  },
  {
    name: 'a11-bcb-me-directo',
    label: 'BCB GET /agency/me con @Auth(AGENCY): verifica RS256 por JWKS + sesión en BD',
    run: async (t) => {
      const s = await loginOk();
      const r = await bcbGet('/agency/me', s.accessToken);
      t.is('status', 200, r.status, r.text.slice(0, 200));
      t.is('id', AGENCIA.id, r.body?.id);
      t.is('email', AGENCIA.email, r.body?.email);
      // Prisma serializa Decimal sin ceros a la derecha ("10", no "10.00"); lo que fija el
      // contrato es que viaje como string (igual que el payload de sync), no el formato.
      t.is('decimales como string', 'string', typeof r.body?.discountPercent);
      t.is('discountPercent = 10', 10, Number(r.body?.discountPercent));
    },
  },
  {
    name: 'a12-bcb-me-inactiva-403',
    label: 'Agencia desactivada con token válido → BCB responde 403 AGENCY_INACTIVE (no 401)',
    run: async (t) => {
      const s = await loginOk();
      await conAgenciaInactiva(async () => {
        const r = await bcbGet('/agency/me', s.accessToken);
        t.is('status', 403, r.status, r.text.slice(0, 200));
        t.assert('mensaje AGENCY_INACTIVE', /AGENCY_INACTIVE|inactiva/i.test(r.text), r.text.slice(0, 200));
      });
    },
  },
  {
    name: 'a13-logout',
    label: 'POST /auth/logout → 204; el refresh queda revocado y no hay sesiones',
    run: async (t) => {
      const s = await loginOk();
      const r = await logout(s.refreshToken);
      t.is('status', 204, r.status, r.text.slice(0, 200));
      const again = await refresh(s.refreshToken);
      t.is('refresh después del logout → 401', 401, again.status, again.text.slice(0, 200));
      t.is('0 sesiones en BCB', 0, (await sessions()).length);
    },
  },
  {
    name: 'a14-logins-concurrentes',
    label: 'Dos logins en paralelo → ambos 200 y UNA sola sesión (agencyId único + upsert)',
    run: async (t) => {
      await bcbDb().agencySession.deleteMany({ where: { agencyId: AGENCIA.id } });
      const [a, b] = await Promise.all([login(), login()]);
      t.is('login A', 200, a.status, a.text.slice(0, 200));
      t.is('login B', 200, b.status, b.text.slice(0, 200));
      const rows = await sessions();
      t.is('exactamente 1 sesión', 1, rows.length);
      const tokens = [a.body?.accessToken, b.body?.accessToken];
      t.assert('la sesión es la de uno de los dos logins', tokens.includes(rows[0]?.accessToken ?? ''));
    },
  },
  {
    name: 'a15-adapter-rutas-publicas',
    label: 'adapter-portalagencias: /agencies/auth/login sin token → 200; /agencies/** sin token → 401',
    run: async (t) => {
      const pub = await http('POST', `${ADAPTER_PA_URL}/agencies/auth/login`, {
        body: { email: AGENCIA.email, password: AGENCIA.password },
      });
      t.is('login directo al adapter sin Authorization', 200, pub.status, pub.text.slice(0, 200));
      t.present('passthrough: accessToken', pub.body?.accessToken);
      t.is('passthrough: me.id', AGENCIA.id, pub.body?.me?.id);

      const priv = await http('GET', `${ADAPTER_PA_URL}/agencies/${AGENCIA.id}/charges`);
      t.is('ruta no listada sigue exigiendo JWT', 401, priv.status, priv.text.slice(0, 200));
    },
  },
  {
    name: 'a16-login-payload-invalido',
    label: 'Body inválido en el satélite → 400 (los DTOs validan, no 500)',
    run: async (t) => {
      const r = await http('POST', `${SAT_URL}/auth/login`, { body: { email: 'no-es-correo', password: '' } });
      t.is('status', 400, r.status, r.text.slice(0, 200));
    },
  },
  {
    name: 'a17-sucursales-propias',
    label: 'GET /agencies/:id/branches con el token propio → 200 con la sucursal del RFC de login (AD15)',
    run: async (t) => {
      const s = await loginOk();
      const r = await satGet(`/agencies/${AGENCIA.id}/branches`, s.accessToken);
      t.is('status', 200, r.status, r.text.slice(0, 200));
      t.assert('trae al menos una sucursal', (r.body?.data?.length ?? 0) >= 1);
      const sucursal = r.body?.data?.[0];
      t.is('rfc de la sucursal', AGENCIA.rfc, sucursal?.rfc);
      t.is('correo de acceso', AGENCIA.email, sucursal?.email);
      t.is('es la principal', true, sucursal?.isPrimary);
      t.is('status de la sucursal', 'ACTIVE', sucursal?.status);
      t.is('la sucursal referencia a su agencia', AGENCIA.id, sucursal?.agency?.id);
    },
  },
  {
    name: 'a18-sucursales-ajenas-prohibidas',
    label: 'GET /agencies/:id/branches con el id de OTRA agencia → 403',
    run: async (t) => {
      const s = await loginOk();
      const r = await satGet(`/agencies/${OTRA_AGENCIA_ID}/branches`, s.accessToken);
      t.is('status', 403, r.status, r.text.slice(0, 200));
    },
  },
  {
    name: 'a19-busqueda-global-sucursales-prohibida',
    label: 'GET /branches (búsqueda global, AD15) con token de agencia → 403 (solo administración)',
    run: async (t) => {
      const s = await loginOk();
      const r = await satGet('/branches', s.accessToken);
      t.is('status', 403, r.status, r.text.slice(0, 200));
    },
  },
  {
    name: 'a20-detalle-agencia-trae-sucursales',
    label: 'GET /agencies/:id propio → incluye sucursales, totalSucursales y saldoDisponible',
    run: async (t) => {
      const s = await loginOk();
      const r = await satGet(`/agencies/${AGENCIA.id}`, s.accessToken);
      t.is('status', 200, r.status, r.text.slice(0, 200));
      t.is('branchCount', 1, r.body?.branchCount);
      t.is('saldoDisponible = creditLimit - currentDebt',
        (r.body?.creditLimit ?? 0) - (r.body?.currentDebt ?? 0), r.body?.availableCredit);
      t.is('datos de contacto desde la sucursal principal', AGENCIA.email, r.body?.email);
      t.present('ciudad de la sucursal principal', r.body?.city);
      t.assert('las sucursales vienen embebidas', (r.body?.branches?.length ?? 0) === 1);
    },
  },
  {
    name: 'a21-cambio-contrasena-requiere-token',
    label: 'POST /auth/change-password sin Bearer → 401; con refresh token → 401',
    run: async (t) => {
      const sinToken = await http('POST', `${SAT_URL}/auth/change-password`, {
        body: { currentPassword: AGENCIA.password, newPassword: 'OtraClave2026!' },
      });
      t.is('sin Authorization', 401, sinToken.status, sinToken.text.slice(0, 200));

      const s = await loginOk();
      const conRefresh = await http('POST', `${SAT_URL}/auth/change-password`, {
        token: s.refreshToken,
        body: { currentPassword: AGENCIA.password, newPassword: 'OtraClave2026!' },
      });
      t.is('con refresh token', 401, conRefresh.status, conRefresh.text.slice(0, 200));
    },
  },
  {
    name: 'a22-cambio-contrasena-valida-dto',
    label: 'POST /auth/change-password con contraseña nueva corta → 400 (el DTO valida antes de salir)',
    run: async (t) => {
      const s = await loginOk();
      const r = await http('POST', `${SAT_URL}/auth/change-password`, {
        token: s.accessToken,
        body: { currentPassword: AGENCIA.password, newPassword: 'corta' },
      });
      t.is('status', 400, r.status, r.text.slice(0, 200));
    },
  },
  // ── Administración: la cadena completa hasta el app `agencies` de BCB ──────
  {
    name: 'a23-catalogos',
    label: 'Catálogos AD08/AD09 (servicios, tipos de pasajero, stations) resueltos en BCB',
    run: async (t) => {
      for (const [ruta, campos] of [
        ['/catalogs/services', ['id', 'key', 'shortName', 'fullName']],
        ['/catalogs/passenger-types', ['id', 'key', 'name']],
        ['/catalogs/stations', ['id', 'name', 'shortName', 'number']],
      ] as const) {
        const r = await adminGet(ruta);
        t.is(`status ${ruta}`, 200, r.status, r.text.slice(0, 200));
        t.assert(`${ruta} devuelve elementos`, Array.isArray(r.body) && r.body.length > 0);
        for (const campo of campos) {
          t.present(`${ruta} trae ${campo}`, r.body?.[0]?.[campo]);
        }
      }
    },
  },
  {
    name: 'a24-listado-admin',
    label: 'GET /agencies con token de admin → listado con sucursales y saldo disponible',
    run: async (t) => {
      const r = await adminGet('/agencies');
      t.is('status', 200, r.status, r.text.slice(0, 200));
      const agencia = (r.body?.data ?? []).find((a: any) => a.id === AGENCIA.id);
      t.present('la agencia demo aparece', agencia);
      t.is('name', AGENCIA.name, agencia?.name);
      t.assert('trae sus sucursales', (agencia?.branches?.length ?? 0) >= 1);
      t.is(
        'saldoDisponible = creditLimit - currentDebt',
        (agencia?.creditLimit ?? 0) - (agencia?.currentDebt ?? 0),
        agencia?.availableCredit,
      );
    },
  },
  {
    name: 'a25-config-ad09-ad10',
    label: 'AD09/AD10: límite, descuento, tipos de pasajero y de servicio llegan a BCB',
    run: async (t) => {
      const tipos = await adminGet('/catalogs/passenger-types');
      const servicios = await adminGet('/catalogs/services');
      const tipoId = tipos.body?.[0]?.id;
      const servicioId = servicios.body?.[0]?.id;

      const r = await adminPut(`/agencies/${AGENCIA.id}`, {
        creditLimit: 75000,
        discountPercent: 12,
        passengerTypeIds: [tipoId],
        serviceIds: [servicioId],
      });

      t.is('status', 200, r.status, r.text.slice(0, 300));
      t.is('creditLimit', 75000, r.body?.creditLimit);
      t.is('discountPercent', 12, r.body?.discountPercent);
      // El campo se pierde si algún DTO del relay no lo declara: por eso se comprueba
      // el valor de vuelta y no solo el status.
      t.is('tipos de pasajero configurados', 1, r.body?.passengerTypes?.length);
      t.is('tipo de pasajero correcto', tipoId, r.body?.passengerTypes?.[0]?.id);
      // AD09: los tipos de servicio son de la AGENCIA, no de cada sucursal.
      t.is('servicios de la agencia', 1, r.body?.services?.length);
      t.is('servicio correcto', servicioId, r.body?.services?.[0]?.id);
      // El portal pinta el nombre completo ("Primera clase"), no la abreviatura.
      t.present(
        'el servicio trae su nombre completo',
        r.body?.services?.[0]?.fullName,
      );
      t.assert(
        'y las sucursales ya no los traen',
        !('services' in (r.body?.branches?.[0] ?? {})),
      );

      // Se restaura el estado sembrado: otros casos verifican el 10 % y los 50 000.
      await adminPut(`/agencies/${AGENCIA.id}`, {
        creditLimit: 50000,
        discountPercent: 10,
        passengerTypeIds: [],
        serviceIds: [],
      });
    },
  },
  {
    name: 'a26-editar-contacto-ad03',
    label: 'AD03: los datos de contacto se enrutan a la sucursal principal',
    run: async (t) => {
      const r = await adminPut(`/agencies/${AGENCIA.id}`, {
        phone: '2225556677',
        city: 'Cholula',
      });
      t.is('status', 200, r.status, r.text.slice(0, 300));
      t.is('phone', '2225556677', r.body?.phone);
      t.is('city', 'Cholula', r.body?.city);
      t.is('la sucursal principal quedó actualizada', '2225556677', r.body?.branches?.[0]?.phone);

      // Se deja como estaba para no arrastrar estado entre corridas.
      await adminPut(`/agencies/${AGENCIA.id}`, { phone: '2220000000', city: 'Puebla' });
    },
  },
  {
    name: 'a27-sucursales-ciclo-completo',
    label: 'AD11→AD12→AD14→AD13: alta, edición, desactivación y baja de una sucursal',
    run: async (t) => {
      const rfc = rfcUnico('SUC');
      const alta = await adminPost(`/agencies/${AGENCIA.id}/branches`, {
        rfc,
        businessName: 'Sucursal E2E SA de CV',
        email: `suc.${Date.now()}@example.com`,
        phone: '2221112233',
        address: 'Blvd. Atlixco 100',
        city: 'Puebla',
      });
      t.is('AD11 status', 201, alta.status, alta.text.slice(0, 300));
      t.is('AD11 rfc', rfc, alta.body?.rfc);
      t.is('AD11 ciudad', 'Puebla', alta.body?.city);
      t.is('AD11 nace activa', 'ACTIVE', alta.body?.status);
      t.is('AD11 no es la principal', false, alta.body?.isPrimary);
      const id = alta.body?.id;

      const edicion = await adminPut(`/agencies/${AGENCIA.id}/branches/${id}`, {
        phone: '2229998877',
        city: 'Cholula',
      });
      t.is('AD12 status', 200, edicion.status, edicion.text.slice(0, 300));
      t.is('AD12 telefono', '2229998877', edicion.body?.phone);
      t.is('AD12 el RFC no cambia', rfc, edicion.body?.rfc);

      const baja = await adminPatch(`/agencies/${AGENCIA.id}/branches/${id}/status`, {
        status: 'INACTIVE',
      });
      t.is('AD14 status', 200, baja.status, baja.text.slice(0, 300));
      t.is('AD14 quedó inactiva', 'INACTIVE', baja.body?.status);

      const borrado = await adminDelete(`/agencies/${AGENCIA.id}/branches/${id}`);
      t.is('AD13 status', 204, borrado.status, borrado.text.slice(0, 200));

      const listado = await adminGet(`/agencies/${AGENCIA.id}/branches`);
      t.assert(
        'AD13 ya no aparece en el listado',
        !(listado.body?.data ?? []).some((x: any) => x.id === id),
      );
    },
  },
  {
    name: 'a28-no-borrar-unica-activa',
    label: 'AD13: la única sucursal activa de la agencia no se puede eliminar',
    run: async (t) => {
      const listado = await adminGet(`/agencies/${AGENCIA.id}/branches`);
      const activas = (listado.body?.data ?? []).filter((x: any) => x.status === 'ACTIVE');
      t.is('la agencia demo tiene exactamente una sucursal activa', 1, activas.length);

      const r = await adminDelete(`/agencies/${AGENCIA.id}/branches/${activas[0]?.id}`);
      t.is('status', 400, r.status, r.text.slice(0, 300));
      t.assert('el motivo es la última activa', r.text.includes('LAST_ACTIVE_RFC'));
    },
  },
  {
    name: 'a29-rfc-duplicado',
    label: 'AD11: un RFC ya registrado responde 409, no 500',
    run: async (t) => {
      const r = await adminPost(`/agencies/${AGENCIA.id}/branches`, {
        rfc: AGENCIA.rfc,
        businessName: 'Duplicada SA de CV',
        email: `dup.${Date.now()}@example.com`,
        phone: '2221112233',
        address: 'Calle Duplicada 1',
      });
      t.is('status', 409, r.status, r.text.slice(0, 300));
    },
  },
  {
    name: 'a30-busqueda-sin-acentos',
    label: 'AD06/AD15: la búsqueda ignora acentos y alcanza a las sucursales',
    run: async (t) => {
      // La sucursal demo está en 'Puebla'; se busca con acento a propósito.
      const sucursales = await adminGet('/branches?search=Pu%C3%A9bla');
      t.is('status sucursales', 200, sucursales.status, sucursales.text.slice(0, 200));
      t.assert(
        'encuentra la sucursal demo pese al acento',
        (sucursales.body?.data ?? []).some((x: any) => x.rfc === AGENCIA.rfc),
      );

      const agencias = await adminGet('/agencies?search=Pu%C3%A9bla');
      t.is('status agencias', 200, agencias.status, agencias.text.slice(0, 200));
      t.assert(
        'la agencia se encuentra por la ciudad de su sucursal',
        (agencias.body?.data ?? []).some((a: any) => a.id === AGENCIA.id),
      );
    },
  },
  {
    name: 'a31-cortes-ad07',
    label: 'AD07: historial de cortes paginado y corte con detalle boleto por boleto',
    run: async (t) => {
      const historial = await adminGet(`/agencies/${AGENCIA.id}/settlements`);
      t.is('status historial', 200, historial.status, historial.text.slice(0, 200));
      t.assert('data es una lista', Array.isArray(historial.body?.data));
      t.present('trae paginación', historial.body?.pagination);

      const corte = await adminPost(`/agencies/${AGENCIA.id}/settlements`, {
        from: '2026-01-01',
        to: '2026-12-31',
      });
      t.is('status corte', 201, corte.status, corte.text.slice(0, 300));
      t.present('el corte trae id', corte.body?.id);

      const detalle = await adminGet(`/agencies/${AGENCIA.id}/settlements/${corte.body?.id}`);
      t.is('status detalle', 200, detalle.status, detalle.text.slice(0, 200));
      t.is('el detalle es del corte pedido', corte.body?.id, detalle.body?.id);
      t.assert('trae el desglose por boleto', Array.isArray(detalle.body?.charges));
      t.is('totalBoletos coincide con el desglose', detalle.body?.charges?.length, detalle.body?.totalTickets);
    },
  },
  {
    name: 'a32-alta-agencia-ad02',
    label: 'AD02: alta de agencia por la cadena completa, con su primera sucursal',
    run: async (t) => {
      const rfc = rfcUnico('NVA');
      const email = `nueva.${Date.now()}@example.com`;
      const r = await adminPost('/agencies', {
        name: 'Agencia Nueva E2E',
        creditLimit: 10000,
        discountPercent: 5,
        branches: [
          {
            rfc,
            businessName: 'Agencia Nueva E2E SA de CV',
            email,
            phone: '2223334455',
            address: 'Av. Nueva 1',
            city: 'Atlixco',
          },
        ],
      });

      t.is('status', 201, r.status, r.text.slice(0, 300));
      t.present('devuelve el id de BCB', r.body?.id);
      t.is('creditLimit', 10000, r.body?.creditLimit);
      t.is('ciudad desde la sucursal principal', 'Atlixco', r.body?.city);
      t.is('nace con una sucursal', 1, r.body?.branchCount);
      t.is('la sucursal es la principal', true, r.body?.branches?.[0]?.isPrimary);
      t.is('y tiene el RFC capturado', rfc, r.body?.branches?.[0]?.rfc);

      // AD04: se elimina para no dejar basura entre corridas (sin deuda ni boletos, debe poder).
      const borrado = await adminDelete(`/agencies/${r.body?.id}`);
      t.is('AD04 eliminar la recién creada', 204, borrado.status, borrado.text.slice(0, 200));
    },
  },
  {
    name: 'a33-cambio-contrasena-real',
    label: 'Cambio de contraseña de punta a punta: la nueva entra, la vieja deja de servir',
    run: async (t) => {
      const NUEVA = 'ClaveCambiadaE2E2026!';
      const s = await loginOk();

      const cambio = await http('POST', `${SAT_URL}/auth/change-password`, {
        token: s.accessToken,
        body: { currentPassword: AGENCIA.password, newPassword: NUEVA },
      });
      t.is('status del cambio', 204, cambio.status, cambio.text.slice(0, 200));

      const conVieja = await login(AGENCIA.email, AGENCIA.password);
      t.is('la contraseña anterior deja de servir', 401, conVieja.status);

      const conNueva = await login(AGENCIA.email, NUEVA);
      t.is('la nueva sirve', 200, conNueva.status, conNueva.text.slice(0, 200));
      t.is(
        'y ya no está marcada como temporal',
        false,
        conNueva.body?.agency?.isTempPassword,
      );

      // Se deja como estaba: el resto de los casos y el seed usan la contraseña original.
      const revertir = await http('POST', `${SAT_URL}/auth/change-password`, {
        token: conNueva.body?.accessToken,
        body: { currentPassword: NUEVA, newPassword: AGENCIA.password },
      });
      t.is('se restaura la contraseña sembrada', 204, revertir.status, revertir.text.slice(0, 200));
      const final = await login();
      t.is('el login original vuelve a funcionar', 200, final.status);
    },
  },
  {
    name: 'a34-alta-agencia-varios-rfc',
    label: 'AD02: alta de agencia con dos RFC de una vez, como pide el diseño',
    run: async (t) => {
      const sello = Date.now();
      const rfcUno = rfcUnico('SLO');
      const rfcDos = rfcUnico('DFN');
      const correoUno = `operaciones.${sello}@example.com`;
      const correoDos = `frias.${sello}@example.com`;

      const r = await adminPost('/agencies', {
        name: 'Soluciones Logísticas del Occidente',
        creditLimit: 80000,
        discountPercent: 12,
        branches: [
          {
            rfc: rfcUno,
            businessName: 'Soluciones Logísticas del Occidente S.A. de C.V.',
            email: correoUno,
            phone: '3341237788',
            address: 'C. Eligio Ancona 145, CDMX',
            city: 'Ciudad de México',
            isPrimary: true,
          },
          {
            rfc: rfcDos,
            businessName: 'Distribuciones Frías del Occidente',
            email: correoDos,
            phone: '3341237788',
            address: 'C. Eligio Ancona 145, CDMX',
            city: 'Ciudad de México',
          },
        ],
      });

      t.is('status', 201, r.status, r.text.slice(0, 300));
      t.is('nace con las dos sucursales', 2, r.body?.branchCount);

      const porRfc = Object.fromEntries(
        (r.body?.branches ?? []).map((s: any) => [s.rfc, s]),
      );
      // Cada RFC conserva lo suyo: es justo lo que se perdía cuando los DTO de
      // relay solo declaraban `rfc` e `isPrimary`.
      t.is('la primera conserva su correo', correoUno, porRfc[rfcUno]?.email);
      t.is(
        'la segunda conserva su razón social',
        'Distribuciones Frías del Occidente',
        porRfc[rfcDos]?.businessName,
      );
      t.is(
        'exactamente una es la principal',
        1,
        (r.body?.branches ?? []).filter((s: any) => s.isPrimary).length,
      );
      t.is('y es la marcada', true, porRfc[rfcUno]?.isPrimary);
      t.is(
        'los datos de contacto de la agencia salen de la principal',
        correoUno,
        r.body?.email,
      );

      // Las dos pueden iniciar sesión: el correo de cualquiera es identificador.
      const listado = await adminGet(`/agencies/${r.body?.id}/branches`);
      t.is('ambas quedan vivas', 2, listado.body?.data?.length);

      const borrado = await adminDelete(`/agencies/${r.body?.id}`);
      t.is('se elimina con sus dos sucursales', 204, borrado.status, borrado.text.slice(0, 200));
    },
  },
  {
    name: 'a35-sin-limite-de-credito',
    label: 'AD09: la casilla "Sin límite de crédito" deja el tope en null y no bloquea la venta',
    run: async (t) => {
      const sinTope = await adminPut(`/agencies/${AGENCIA.id}`, {
        unlimitedCredit: true,
      });
      t.is('status', 200, sinTope.status, sinTope.text.slice(0, 300));
      t.is('creditLimit queda en null', null, sinTope.body?.creditLimit);
      // Sin tope no hay disponible que calcular.
      t.is('saldoDisponible también', null, sinTope.body?.availableCredit);

      // La copia local del satélite refleja el null, no un 0.
      const detalle = await adminGet(`/agencies/${AGENCIA.id}`);
      t.is('el detalle lo confirma', null, detalle.body?.creditLimit);

      const conTope = await adminPut(`/agencies/${AGENCIA.id}`, {
        creditLimit: 50000,
        unlimitedCredit: false,
      });
      t.is('vuelve a tener tope', 50000, conTope.body?.creditLimit);
      t.is(
        'y el disponible se vuelve a calcular',
        50000 - (conTope.body?.currentDebt ?? 0),
        conTope.body?.availableCredit,
      );
    },
  },
  {
    name: 'a36-desactivar-corta-la-sesion',
    label: 'AD05: desactivar la agencia corta el acceso en el momento, no cuando expire el token',
    run: async (t) => {
      const s = await loginOk();
      const antes = await satGet('/auth/me', s.accessToken);
      t.is('la agencia entra con su token', 200, antes.status, antes.text.slice(0, 200));

      // Apagar el interruptor desde el portal, por la cadena real.
      const apagar = await adminPatch(`/agencies/${AGENCIA.id}/status`, { status: 'INACTIVE' });
      t.is('status del cambio', 200, apagar.status, apagar.text.slice(0, 300));
      t.is('la agencia queda inactiva', 'INACTIVE', apagar.body?.status);

      try {
        // BCB borra la sesión: el refresh muere aunque el token siga sin expirar.
        t.is('BCB se quedó sin sesiones vivas', 0, (await sessions()).length);

        const renovar = await refresh(s.refreshToken);
        t.is('el refresh ya no sirve', 401, renovar.status, renovar.text.slice(0, 200));

        // Y el access token que la agencia tiene en la mano deja de abrir.
        const despues = await satGet('/auth/me', s.accessToken);
        t.is('el access token deja de abrir', 403, despues.status, despues.text.slice(0, 200));

        const propio = await satGet(`/agencies/${AGENCIA.id}`, s.accessToken);
        t.is('tampoco sus propios datos', 403, propio.status, propio.text.slice(0, 200));
      } finally {
        const prender = await adminPatch(`/agencies/${AGENCIA.id}/status`, { status: 'ACTIVE' });
        t.is('se vuelve a activar', 200, prender.status, prender.text.slice(0, 200));
      }

      const otra = await login();
      t.is('y puede volver a entrar', 200, otra.status, otra.text.slice(0, 200));
    },
  },
  {
    name: 'a37-credenciales-por-sucursal',
    label: 'AD02/AD11: cada sucursal tiene su usuario y su contraseña, independientes entre sí',
    run: async (t) => {
      const sello = Date.now();
      const alta = await adminPost('/agencies', {
        name: `Agencia Credenciales ${sello}`,
        branches: [
          {
            rfc: rfcUnico('CRA'),
            businessName: 'Credenciales Uno S.A. de C.V.',
            username: `matriz.${sello}`,
            email: `matriz.${sello}@example.com`,
            phone: '5512340001',
            address: 'Av. Uno 1, CDMX',
            city: 'Ciudad de México',
            isPrimary: true,
          },
          {
            rfc: rfcUnico('CRB'),
            businessName: 'Credenciales Dos S.A. de C.V.',
            username: `sucursal.${sello}`,
            email: `sucursal.${sello}@example.com`,
            phone: '2229990002',
            address: 'Blvd. Dos 2, Puebla',
            city: 'Puebla',
            isPrimary: false,
          },
        ],
      });
      t.is('status', 201, alta.status, alta.text.slice(0, 400));

      const agencyId: string = alta.body?.id;
      const sucursales = (alta.body?.branches ?? []) as {
        id: string;
        username: string;
        email: string;
      }[];
      t.is('nacen las dos sucursales', 2, sucursales.length);
      t.is(
        'cada una conserva su nombre de usuario',
        `matriz.${sello},sucursal.${sello}`,
        sucursales
          .map((x) => x.username)
          .sort()
          .join(','),
      );

      try {
        // BCB genera una contraseña DISTINTA por sucursal, así que se leen de la base:
        // por diseño no salen en la respuesta, solo viajan por correo.
        const db = bcbDb();
        const filas = await db.agencyRfc.findMany({
          where: { agencyId: agencyId },
          select: { id: true, username: true, passwordHash: true },
        });
        t.assert(
          'cada sucursal guarda su propio hash',
          new Set(filas.map((f) => f.passwordHash)).size === 2,
        );

        // Se fija una contraseña conocida por sucursal para poder entrar con cada una.
        const hash =
          '$2b$12$HDNcRuUcQ0o3P.sij7.JP.nzxqpQS28h5WQrUuXXFoP4wmL2r6Cia';
        await db.agencyRfc.updateMany({
          where: { agencyId: agencyId },
          data: { passwordHash: hash, isTempPassword: true },
        });

        const conCorreo = await login(`matriz.${sello}@example.com`, 'AgenciaDemo2026!');
        t.is('entra con el correo', 200, conCorreo.status, conCorreo.text.slice(0, 200));

        // El DCU llama credenciales a "Usuario y Contraseña": el nombre de usuario
        // también abre, porque es único en toda la tabla.
        const conUsuario = await login(`sucursal.${sello}`, 'AgenciaDemo2026!');
        t.is('y también con el nombre de usuario', 200, conUsuario.status, conUsuario.text.slice(0, 200));
        t.is(
          'el perfil dice con qué sucursal entró',
          `sucursal.${sello}`,
          conUsuario.body?.agency?.username,
        );

        // Las dos sesiones conviven: antes la sesión era una por agencia y la segunda
        // entrada echaba a la primera.
        const vivas = await db.agencySession.count({
          where: { agencyId: agencyId },
        });
        t.is('las dos sesiones conviven', 2, vivas);

        // Cambiar la contraseña de una NO toca la de la otra.
        const cambio = await http('POST', `${SAT_URL}/auth/change-password`, {
          token: conCorreo.body.accessToken,
          body: { currentPassword: 'AgenciaDemo2026!', newPassword: 'OtraClave2026!' },
        });
        t.is('cambia su contraseña', 204, cambio.status, cambio.text.slice(0, 200));

        const otraSigue = await login(`sucursal.${sello}`, 'AgenciaDemo2026!');
        t.is('la otra sucursal conserva la suya', 200, otraSigue.status, otraSigue.text.slice(0, 200));

        const yaNo = await login(`matriz.${sello}@example.com`, 'AgenciaDemo2026!');
        t.is('y la que cambió ya no entra con la anterior', 401, yaNo.status);
      } finally {
        await adminDelete(`/agencies/${agencyId}`);
      }
    },
  },
  {
    name: 'a38-ventas-fecha-de-corrida-y-total',
    label: 'AD08: el reporte trae la FECHA DE CORRIDA y el total de todo lo filtrado, no el de la página',
    run: async (t) => {
      const db = bcbDb();
      const sello = Date.now();

      // Cadena mínima para que exista un cargo: un viaje ya sembrado, un asiento, una
      // orden y su boleto. El cargo exige orderItemId, no se puede inventar suelto.
      // Se usa la salida que el viaje YA tiene, sin tocarla: Trip tiene único
      // (routeId, departure) y forzarle una fecha fija choca con otro viaje de la ruta.
      const trip = await db.trip.findFirst({ select: { id: true, departure: true } });
      if (!trip) throw new Error('no hay Trip sembrado en BCB');
      const salida = trip.departure;

      const creados: string[] = [];
      const importes: [number, number] = [250.5, 749.5];

      try {
        for (const [i, importe] of importes.entries()) {
          const seat = await db.tripSeat.create({
            data: { number: 900 + i, tripId: trip.id },
            select: { id: true },
          });
          const order = await db.order.create({
            data: {
              type: 'ONE_WAY',
              subtotal: importe,
              total: importe,
            },
            select: { id: true },
          });
          const item = await db.orderItem.create({
            data: {
              ticketNumber: `E2E-${sello}-${i}`,
              basePrice: importe,
              totalPrice: importe,
              orderId: order.id,
              tripSeatId: seat.id,
            },
            select: { id: true },
          });
          const cargo = await db.agencyCharge.create({
            data: {
              amount: importe,
              agencyId: AGENCIA.id,
              orderItemId: item.id,
            },
            select: { id: true },
          });
          creados.push(cargo.id);
        }

        // limit=1 a propósito: el total NO puede ser el de la página.
        const r = await adminGet(`/agencies/${AGENCIA.id}/sales?page=1&limit=1`);
        t.is('status', 200, r.status, r.text.slice(0, 300));
        t.is('la página trae una sola fila', 1, r.body?.data?.length);
        t.is('pero el total cuenta las dos', 2, r.body?.pagination?.totalCount);
        t.is('el importe total es de todo lo filtrado', 1000, r.body?.totalAmount);

        t.is(
          'la fila trae la fecha de CORRIDA',
          salida.toISOString(),
          r.body?.data?.[0]?.departureAt,
        );
        // Y no es la de venta: son dos fechas distintas y la tabla pinta la de salida.
        t.assert(
          'que no es la fecha de venta',
          r.body?.data?.[0]?.departureAt !== r.body?.data?.[0]?.soldAt,
        );

        // El filtro por fecha acota el total, no solo la página.
        const vacio = await adminGet(
          `/agencies/${AGENCIA.id}/sales?page=1&limit=20&from=2020-01-01&to=2020-12-31`,
        );
        t.is('sin cargos en el rango', 0, vacio.body?.data?.length);
        t.is('el total del rango vacío es 0', 0, vacio.body?.totalAmount);
      } finally {
        await db.agencyCharge.deleteMany({ where: { id: { in: creados } } });
        await db.orderItem.deleteMany({
          where: { ticketNumber: { startsWith: `E2E-${sello}-` } },
        });
        await db.tripSeat.deleteMany({ where: { number: { in: [900, 901] } } });
      }
    },
  },
];
