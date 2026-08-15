/**
 * Casos de Venta a Bordo: WS1 (despacho hacia SmartMac), WS2 (retorno de ventas
 * hacia BCB), SM04 (consulta de tarjeta de viaje, fallback cuando el push de WS1
 * falló) y la Consulta de tarjetas de viaje por operador (documento TCF, PRs
 * #1547/#191/#13 — reemplazo de `apicloud.../abordaje/v1/corrida/operador`).
 *
 * Los payloads están tipados con los DTOs reales del satélite (`import type`), así
 * que un campo fuera del contrato no compila.
 */
import type { ConsultaCorridasOperadorDto } from '../../../../BIGER_EstrellaRoja_VentaABordo/src/dto/consulta-corridas-operador.dto';
import type { ConsultaTarjetaDto } from '../../../../BIGER_EstrellaRoja_VentaABordo/src/dto/consulta-tarjeta.dto';
import type { DespacharCorridaDto } from '../../../../BIGER_EstrellaRoja_VentaABordo/src/dto/despachar-corrida.dto';
import type { RecepcionVentaDto } from '../../../../BIGER_EstrellaRoja_VentaABordo/src/dto/recepcion-venta.dto';
import type { ConsultaCorridasOperadorEntity } from '../../../../BIGER_EstrellaRoja_VentaABordo/src/entities/consulta-corridas-operador.entity';
import type { ConsultaTarjetaEntity } from '../../../../BIGER_EstrellaRoja_VentaABordo/src/entities/consulta-tarjeta.entity';
import { TipoPago } from './tipo-pago';
import { consulta, consultaCatalog } from './consulta-scenarios';
import { bcbDb, vaDb } from '@harness/db';
import { FakeSmartmac } from '@harness/fake-smartmac';
import { signJwt } from '@harness/http';
import { REPO_VENTAABORDO } from '@harness/paths';
import { recordHttp } from '@harness/trace';
import type { CaseDef } from '@harness/types';
import { until } from '@harness/wait';
import * as fs from 'fs';
import { vaScenarios, type VaScenario } from './scenarios';

const SAT_URL = process.env.E2E_VA_SAT_URL ?? 'http://localhost:3001/venta-abordo';
/** Par de llaves de quien llama a WS1; el satélite lo verifica con su pública. */
const LEG_WS1 = 'bcb-to-va';

/** El SmartMac falso vive mientras corren las pruebas; lo abre y cierra el runner. */
export const fake = new FakeSmartmac();

type Res<T = unknown> = { status: number; body: T; text: string };

/**
 * Token que BCB emitiría al llamar WS1. El guard del satélite exige un JWT RS256
 * con `sub: "bcb-system"`, un `userType` válido y un `userToken` interno (el del
 * usuario final) que traiga `exp`. `userType: "admin"` se rechaza a propósito en
 * este camino, así que se usa `advisor`, que es lo que manda un despacho real.
 */
function bcbSystemToken(): string {
  const inner = signJwt({ leg: LEG_WS1, subject: 'usuario-e2e', ttlSeconds: 600 });
  return signJwt({
    leg: LEG_WS1,
    subject: 'bcb-system',
    ttlSeconds: 600,
    extraClaims: { name: 'BCB', userType: 'advisor', userToken: inner },
  });
}

/**
 * ¿Los endpoints que invoca SmartMac exigen Basic Auth?
 *
 * El satélite pasó de aceptar el JWT `bcb-system` en TODO a exigir Basic Auth en
 * lo que llama SmartMac (WS2, canje, consulta), y dejar el JWT solo para WS1 —que
 * lo llama BCB, no SmartMac. Se detecta leyendo el repo en vez de fijarlo, por lo
 * mismo que `shiftId` en ticketcolectoroffline: mientras la rama no esté en
 * develop, el harness debe decir la verdad en las dos, y ponerse en rojo si el
 * satélite y quien lo llama dejan de coincidir.
 */
const ws2ExigeBasicAuth = fs.existsSync(
  `${REPO_VENTAABORDO}/src/shared/guards/smartmac-basic-auth.guard.ts`,
);

/** Credencial entrante desechable; la escribe el flow.sh en el .env del satélite. */
const SMARTMAC_USER = process.env.SMARTMAC_INBOUND_USER ?? 'e2e-smartmac';
const SMARTMAC_PASS = process.env.SMARTMAC_INBOUND_PASS ?? 'e2e-smartmac-local';
const basicAuth = () =>
  `Basic ${Buffer.from(`${SMARTMAC_USER}:${SMARTMAC_PASS}`).toString('base64')}`;

type Auth = 'jwt' | 'smartmac' | 'smartmac-invalido' | 'none';

function authHeader(auth: Auth): Record<string, string> {
  if (auth === 'jwt') return { Authorization: `Bearer ${bcbSystemToken()}` };
  // Antes de que existiera el guard, estos endpoints tomaban el mismo JWT.
  if (auth === 'smartmac')
    return { Authorization: ws2ExigeBasicAuth ? basicAuth() : `Bearer ${bcbSystemToken()}` };
  // Credencial del tipo correcto pero con la contraseña equivocada: distingue
  // "el guard valida" de "el guard deja pasar cualquier cosa con Authorization".
  if (auth === 'smartmac-invalido')
    return {
      Authorization: ws2ExigeBasicAuth
        ? `Basic ${Buffer.from(`${SMARTMAC_USER}:contraseña-incorrecta`).toString('base64')}`
        : `Bearer ${signJwt({ leg: LEG_WS1, subject: 'bcb-system', useWrongKey: true })}`,
    };
  return {};
}

async function post<T, Body>(path: string, body: Body, auth: Auth = 'jwt'): Promise<Res<T>> {
  const url = `${SAT_URL}${path}`;
  const headers = { 'Content-Type': 'application/json', ...authHeader(auth) };
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* no-JSON */
  }
  recordHttp({ method: 'POST', url, reqHeaders: headers, reqBody: body, status: res.status, resBody: parsed });
  return { status: res.status, body: parsed as T, text };
}

async function get<T>(path: string, auth: Auth = 'smartmac'): Promise<Res<T>> {
  const url = `${SAT_URL}${path}`;
  const headers = authHeader(auth);
  const res = await fetch(url, { method: 'GET', headers });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* no-JSON */
  }
  recordHttp({ method: 'GET', url, reqHeaders: headers, reqBody: null, status: res.status, resBody: parsed });
  return { status: res.status, body: parsed as T, text };
}

const despachar = (body: DespacharCorridaDto) => post<unknown, DespacharCorridaDto>('/corrida/despachar', body);
// WS2 lo llama SmartMac, no BCB: va con la credencial de SmartMac.
const recaudar = (body: RecepcionVentaDto) =>
  post<unknown, RecepcionVentaDto>('/venta/recaudacion', body, 'smartmac');
// SM04 también lo llama SmartMac — mismo guard que WS2 y el canje de boleto.
const consultarTarjeta = (query: ConsultaTarjetaDto, auth: Auth = 'smartmac') => {
  const qs = new URLSearchParams();
  if (query.travelCardNumber !== undefined) qs.set('travelCardNumber', String(query.travelCardNumber));
  if (query.busEconomicNumber !== undefined) qs.set('busEconomicNumber', query.busEconomicNumber);
  return get<ConsultaTarjetaEntity>(`/tarjeta/consulta?${qs.toString()}`, auth);
};

// Consulta de tarjetas de viaje por operador — mismo guard que WS2/SM04.
const consultarCorridasOperador = (
  query: Partial<ConsultaCorridasOperadorDto>,
  auth: Auth = 'smartmac',
) => {
  const qs = new URLSearchParams();
  if (query.numeroOperador !== undefined) qs.set('numeroOperador', query.numeroOperador);
  if (query.caja !== undefined) qs.set('caja', query.caja);
  return get<ConsultaCorridasOperadorEntity>(`/corrida/operador?${qs.toString()}`, auth);
};

/**
 * BCB expresa `fechaHoraCorrida` en hora de México
 * (`CorridasService.ZONA_OPERACION`), truncada a segundos. Se recalcula acá con
 * la misma zona en vez de comparar contra un string fijo, porque `departure` se
 * siembra relativo a `Date.now()` — el truco de formatear con locale `sv-SE` da
 * directamente el orden AAAA-MM-DD HH:mm:ss.
 */
const FORMATO_MX = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/Mexico_City',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const fechaHoraEsperada = (d: Date) => FORMATO_MX.format(d).replace(' ', 'T');

const CAMPOS_DOCUMENTO = [
  'claveCorrida', 'fechaHoraCorrida', 'empresa', 'origen', 'destino', 'estadoCorrida',
  'operador', 'autobus', 'folioTarjeta', 'estadoTarjetaViaje', 'numeroRuta', 'rutaNombre',
  'servicio', 'operadorNombre', 'capacidadAutobus',
].sort();

const porClave = (body: ConsultaCorridasOperadorEntity | undefined, clave: string) =>
  body?.corridas?.find((c) => c.claveCorrida === clave);

/** Payload de WS1 para un escenario. */
function ws1Payload(s: VaScenario, over: Partial<DespacharCorridaDto> = {}): DespacharCorridaDto {
  return {
    travelCardId: String(s.tarjetaViajeId),
    travelCardNumber: s.tarjetaViajeId,
    tripId: s.claveCorrida,
    tripNumericId: s.corridaId,
    busEconomicNumber: '9001',
    dispatchDate: new Date().toISOString(),
    dispatchedAt: new Date().toISOString(),
    operatorKey: 1234,
    originStationNumber: 1,
    destinationStationNumber: 2,
    serviceNumber: 900,
    routeNumber: 1,
    ...over,
  };
}

/** Payload de WS2: dos boletos en efectivo, totales consistentes. */
function ws2Payload(s: VaScenario, over: Partial<RecepcionVentaDto> = {}): RecepcionVentaDto {
  const detalle = s.folios.slice(0, 2).map((folio, i) => ({
    id: folio,
    boletoExternoId: folio,
    folioPreimpreso: folio,
    importeBoleto: 150,
    numeroAsiento: i + 1,
    tarifaId: 1,
    tramoId: 1,
    tipoPago: TipoPago.EFECTIVO,
    tipoPasajero: 'ADULTO',
    fechaHoraVenta: new Date().toISOString(),
  }));
  return {
    id: s.ventaId,
    corridaId: s.corridaId,
    claveCorrida: s.claveCorrida,
    operador: s.operador,
    rutaId: 1,
    tarjetaViajeId: s.tarjetaViajeId,
    montoTotalVenta: 300,
    totalBoletosVendidos: 2,
    boletosEfectivo: 2,
    estatusCorrida: 'CERRADA',
    estatusTarjeta: 'CERRADA',
    folioTarjeta: s.folioTarjeta,
    fechaCreacion: new Date().toISOString(),
    detalleVenta: detalle,
    ...over,
  };
}

const tarjetaEnSatelite = (s: VaScenario) =>
  vaDb().tarjetaViaje.findFirst({ where: { idTarjetaViaje: BigInt(s.tarjetaViajeId) } });

const ventaEnBcb = (s: VaScenario) =>
  bcbDb().boardingSale.findFirst({ where: { smartmacId: s.ventaId }, include: { items: true } });

/** WS1 tiene que haber corrido antes: WS2 exige una TarjetaViaje existente. */
async function asegurarTarjeta(s: VaScenario): Promise<void> {
  if (await tarjetaEnSatelite(s)) return;
  fake.behavior = { kind: 'ok' };
  await despachar(ws1Payload(s));
}

/**
 * Número económico exclusivo del escenario SM04. Los demás escenarios comparten
 * '9001' en `ws1Payload`, así que buscar por autobús ahí sería ambiguo — cualquier
 * tarjeta con ese número calificaría. Un valor propio hace la consulta por
 * `busEconomicNumber` determinística.
 */
const SM04_BUS = '9004E2E';

async function asegurarTarjetaConsulta(s: VaScenario): Promise<void> {
  if (await tarjetaEnSatelite(s)) return;
  fake.behavior = { kind: 'ok' };
  await despachar(ws1Payload(s, { busEconomicNumber: SM04_BUS }));
}

export const cases: CaseDef[] = [
  {
    name: 'ws1-envio-ok',
    label: 'WS1 · despacha y SmartMac acepta la tarjeta',
    async run(t) {
      const s = vaScenarios.WS1_OK;
      fake.clear();
      fake.behavior = { kind: 'ok' };

      const res = await despachar(ws1Payload(s));
      t.is('WS1: el satélite acepta el despacho', 201, res.status, res.text);

      // Prueba de contrato de verdad: qué payload llegó a SmartMac, no solo que
      // la llamada no explotó.
      t.present('WS1: SmartMac recibió la llamada', fake.last?.path);
      const enviado = fake.last?.body as Record<string, unknown> | undefined;
      t.present('WS1: el cuerpo enviado a SmartMac no viene vacío', enviado && Object.keys(enviado).length);

      const tarjeta = await tarjetaEnSatelite(s);
      t.present('WS1: la tarjeta quedó registrada en el satélite', tarjeta?.id);
      t.is('WS1: la clave de corrida se guardó tal cual', s.claveCorrida, tarjeta?.claveCorrida);
      // El fix del PR #10: solo se marca como enviada si SmartMac la aceptó.
      t.present('WS1: marcada como enviada a SmartMac', tarjeta?.fechaEnvioSmartmac);
    },
  },
  {
    name: 'ws1-rechazo-no-marca-enviada',
    label: 'WS1 · si SmartMac rechaza, no la da por enviada',
    async run(t) {
      // Regresión del fix "no dar por enviada una tarjeta que SmartMac rechazó"
      // (PR #10). El SmartMac real contesta HTTP 200 con responseCode != "200",
      // así que el satélite tiene que leer el cuerpo para darse cuenta.
      const s = vaScenarios.WS1_RECHAZO;
      fake.clear();
      fake.behavior = { kind: 'rechazo' };

      await despachar(ws1Payload(s));

      const tarjeta = await tarjetaEnSatelite(s);
      t.present('WS1: la tarjeta se registró localmente igual', tarjeta?.id);
      t.is(
        'WS1: NO marcada como enviada (SmartMac la rechazó)',
        null,
        tarjeta?.fechaEnvioSmartmac ?? null,
        'si trae fecha, el satélite está dando por enviada una tarjeta rechazada',
      );
    },
  },
  {
    name: 'ws1-clave-corrida-larga',
    label: 'WS1 · acepta claves de corrida de longitud variable',
    async run(t) {
      // Regresión del fix "aceptar claves de corrida de longitud variable": el
      // consecutivo de la clave no tiene largo fijo, y el tope es 22.
      const s = vaScenarios.WS1_OK;
      fake.behavior = { kind: 'ok' };
      const larga = 'PUEBEXP0730N0000123456';
      t.is('la clave de prueba mide 22', 22, larga.length);
      const res = await despachar(ws1Payload({ ...s, claveCorrida: larga }, { tripId: larga }));
      t.is('WS1: clave de 22 caracteres aceptada', 201, res.status, res.text.slice(0, 200));
    },
  },
  {
    name: 'ws2-cadena-hasta-bcb',
    label: 'WS2 · la venta viaja satélite→NATS→BCB',
    async run(t) {
      const s = vaScenarios.WS2_OK;
      await asegurarTarjeta(s);

      const res = await recaudar(ws2Payload(s));
      t.is('WS2: el satélite acepta la recaudación', 201, res.status, res.text);

      // El salto es asíncrono: outbox → adapter-ventaabordo → JetStream →
      // adapter-bcb → app webhooks de BCB.
      const venta = await until(async () => (await ventaEnBcb(s)) ?? undefined, { timeoutMs: 40_000 });
      t.present(
        'WS2: la venta llegó a BoardingSale en BCB',
        venta?.id,
        'si falla: ./e2e logs ventaabordo adapter-bcb  ·  ./e2e logs ventaabordo bcb-webhooks',
      );
      t.is('WS2: totalTicketsSold correcto', 2, venta?.totalTicketsSold);
      t.is('WS2: se guardaron los 2 boletos', 2, venta?.items?.length);
      t.is('WS2: el monto total llegó íntegro', '300', String(venta?.totalAmount ?? ''));
    },
  },
  {
    name: 'ws2-idempotente',
    label: 'WS2 · reenviar la misma venta no la duplica',
    async run(t) {
      // `BoardingSale.smartmacId` es @unique justamente para esto: si SmartMac
      // reenvía (o el consumer reentrega), no debe duplicarse la venta.
      const s = vaScenarios.WS2_OK;
      await asegurarTarjeta(s);
      await recaudar(ws2Payload(s));
      await until(async () => (await ventaEnBcb(s)) ?? undefined, { timeoutMs: 40_000 });

      await recaudar(ws2Payload(s));
      // Margen para que un duplicado, si lo hubiera, alcanzara a llegar.
      await new Promise((r) => setTimeout(r, 4000));
      const n = await bcbDb().boardingSale.count({ where: { smartmacId: s.ventaId } });
      t.is('WS2: sigue habiendo una sola venta en BCB', 1, n);
    },
  },
  {
    name: 'ws2-recargas-comparten-folio',
    label: 'WS2 · varias recargas con el mismo folio son válidas',
    async run(t) {
      // Matiz de TI-FT-45 rev.3: la regla "folio impreso único" aplica a BOLETOS.
      // El ejemplo de producción de la rev.3 trae tres RECARGA compartiendo folio,
      // así que rechazarlas con 409 tiraría un lote perfectamente válido.
      const s = vaScenarios.WS2_VALIDA;
      await asegurarTarjeta(s);
      const folio = s.folios[0]!;
      const recargas = [0, 1, 2].map((i) => ({
        id: folio * 10 + i,
        boletoExternoId: folio * 10 + i,
        folioPreimpreso: folio,
        importeBoleto: 50,
        // numeroAsiento exige @Min(1) aunque una recarga no ocupe asiento.
        numeroAsiento: i + 1,
        tarifaId: 1,
        tramoId: 1,
        tipoPago: TipoPago.RECARGA,
        tipoPasajero: 'ADULTO',
        fechaHoraVenta: new Date().toISOString(),
        tarjetaPrepago: '1234567890',
      }));
      const res = await recaudar(
        ws2Payload(s, {
          montoTotalVenta: 150,
          totalBoletosVendidos: 0,
          boletosEfectivo: 0,
          boletosRecarga: 3,
          detalleVenta: recargas,
        } as Partial<RecepcionVentaDto>),
      );
      t.is(
        'WS2: tres recargas con folio repetido son aceptadas',
        201,
        res.status,
        'TI-FT-45 rev.3: la unicidad de folio aplica a BOLETOS, no a recargas. ' + res.text.slice(0, 220),
      );
    },
  },
  {
    name: 'ws2-folio-boleto-duplicado',
    label: 'WS2 · rechaza dos boletos con el mismo folio',
    async run(t) {
      // La otra cara de la regla: en BOLETOS el folio sí debe ser único.
      const s = vaScenarios.WS2_VALIDA;
      await asegurarTarjeta(s);
      const folio = s.folios[0]!;
      const dos = [0, 1].map((i) => ({
        id: folio * 100 + i,
        boletoExternoId: folio * 100 + i,
        folioPreimpreso: folio,
        importeBoleto: 150,
        numeroAsiento: i + 1,
        tarifaId: 1,
        tramoId: 1,
        tipoPago: TipoPago.EFECTIVO,
        tipoPasajero: 'ADULTO',
        fechaHoraVenta: new Date().toISOString(),
      }));
      const res = await recaudar(
        ws2Payload(s, {
          id: s.ventaId + 500,
          montoTotalVenta: 300,
          totalBoletosVendidos: 2,
          boletosEfectivo: 2,
          detalleVenta: dos,
        } as Partial<RecepcionVentaDto>),
      );
      t.is('WS2: folio de boleto duplicado → 409', 409, res.status, res.text.slice(0, 250));
    },
  },
  {
    name: 'ws2-tarjeta-inexistente',
    label: 'WS2 · rechaza una venta de una tarjeta que no existe',
    async run(t) {
      const fantasma = { ...vaScenarios.WS2_VALIDA, tarjetaViajeId: 999_000_111, ventaId: 999_000_111 };
      const res = await recaudar(ws2Payload(fantasma));
      t.is('WS2: tarjeta de viaje inexistente → 404', 404, res.status, res.text.slice(0, 200));
    },
  },
  {
    name: 'ws2-credencial',
    label: 'WS2 · rechaza a quien no trae la credencial de SmartMac',
    async run(t) {
      const s = vaScenarios.WS2_OK;

      // Sin este caso, un guard mal configurado —o desactivado por una variable
      // vacía— dejaría pasar todo y el resto de la suite seguiría en verde: WS2
      // quedaría abierto a internet sin que ninguna prueba se enterara.
      const sin = await post<unknown, RecepcionVentaDto>('/venta/recaudacion', ws2Payload(s), 'none');
      t.is('WS2: sin credencial → 401', 401, sin.status, sin.text.slice(0, 200));

      const mala = await post<unknown, RecepcionVentaDto>(
        '/venta/recaudacion',
        ws2Payload(s),
        'smartmac-invalido',
      );
      t.is(
        `WS2: credencial incorrecta → 401 (${ws2ExigeBasicAuth ? 'Basic' : 'JWT'})`,
        401,
        mala.status,
        mala.text.slice(0, 200),
      );
    },
  },
  {
    name: 'sm04-consulta-por-folio',
    label: 'SM04 · consulta la tarjeta de viaje por folio',
    async run(t) {
      // Fallback de BIG01: cuando el push automático a SmartMac falló o el
      // dispositivo se reinició, SmartMac vuelve a preguntar por la tarjeta.
      const s = vaScenarios.SM04;
      await asegurarTarjetaConsulta(s);

      const res = await consultarTarjeta({ travelCardNumber: s.tarjetaViajeId });
      t.is('SM04: responde 200', 200, res.status, res.text);
      t.is('SM04: clave_corrida coincide', s.claveCorrida, res.body?.clave_corrida);
      t.is('SM04: id_tarjeta_viaje coincide', s.tarjetaViajeId, res.body?.id_tarjeta_viaje);
      t.is('SM04: id_corrida coincide', s.corridaId, res.body?.id_corrida);
    },
  },
  {
    name: 'sm04-consulta-por-autobus',
    label: 'SM04 · consulta la tarjeta activa por número económico',
    async run(t) {
      // Segunda forma de preguntar que admite el mismo endpoint: sin folio a
      // mano, SmartMac puede preguntar solo por el autobús.
      const s = vaScenarios.SM04;
      await asegurarTarjetaConsulta(s);

      const res = await consultarTarjeta({ busEconomicNumber: SM04_BUS });
      t.is('SM04: responde 200 buscando por autobús', 200, res.status, res.text);
      t.is('SM04: resuelve la misma tarjeta', s.tarjetaViajeId, res.body?.id_tarjeta_viaje);
    },
  },
  {
    name: 'sm04-consulta-inexistente',
    label: 'SM04 · tarjeta inexistente responde 404',
    async run(t) {
      const res = await consultarTarjeta({ travelCardNumber: 999_000_222 });
      t.is('SM04: tarjeta inexistente → 404', 404, res.status, res.text.slice(0, 200));
    },
  },
  {
    name: 'sm04-credencial',
    label: 'SM04 · rechaza a quien no trae la credencial de SmartMac',
    async run(t) {
      // Mismo guard que WS2 (SmartmacBasicAuthGuard cubre WS2, BIG05 y SM04):
      // sin este caso, una ruta que quedó afuera del guard no la vería nadie.
      const s = vaScenarios.SM04;
      await asegurarTarjetaConsulta(s);

      const sin = await consultarTarjeta({ travelCardNumber: s.tarjetaViajeId }, 'none');
      t.is('SM04: sin credencial → 401', 401, sin.status, sin.text.slice(0, 200));

      const mala = await consultarTarjeta({ travelCardNumber: s.tarjetaViajeId }, 'smartmac-invalido');
      t.is(
        `SM04: credencial incorrecta → 401 (${ws2ExigeBasicAuth ? 'Basic' : 'JWT'})`,
        401,
        mala.status,
        mala.text.slice(0, 200),
      );
    },
  },
  {
    name: 'consulta-corridas-verde',
    label: 'Consulta de tarjetas de viaje · operador con corridas hoy (VERDE)',
    async run(t) {
      // Fuente de verdad para el assert de fecha: `departure` se siembra relativo a
      // Date.now(), así que se relee de BCB en vez de recalcularlo a ciegas.
      const [tripDespachada, tripAbierta] = await Promise.all([
        bcbDb().trip.findUniqueOrThrow({ where: { id: consultaCatalog.tripDespachadaId } }),
        bcbDb().trip.findUniqueOrThrow({ where: { id: consultaCatalog.tripAbiertaId } }),
      ]);

      const res = await consultarCorridasOperador({ numeroOperador: consulta.operadorKey, caja: consulta.caja });
      t.is('responde 200', 200, res.status, res.text);
      t.is('semáforo VERDE', 'VERDE', res.body?.semaforo);
      t.is('mensaje de éxito', 'Corridas encontradas', res.body?.mensaje);
      t.is('trae las 2 corridas sembradas para hoy', 2, res.body?.corridas?.length ?? -1);

      const despachada = porClave(res.body, consultaCatalog.tripDespachadaId);
      t.present('la corrida despachada aparece (claveCorrida = Trip.id)', despachada);
      if (despachada) {
        t.is(
          'son EXACTAMENTE los 15 campos del documento, sin ids internos filtrados',
          JSON.stringify(CAMPOS_DOCUMENTO),
          JSON.stringify(Object.keys(despachada).sort()),
        );
        t.is(
          'fechaHoraCorrida en hora de México, sin milisegundos ni sufijo de zona',
          fechaHoraEsperada(tripDespachada.departure),
          despachada.fechaHoraCorrida,
        );
        t.is('empresa = tradeName de la compañía (NO shortName)', consulta.companyTradeName, despachada.empresa);
        t.is('servicio = fullName del servicio (NO shortName)', consulta.serviceFullName, despachada.servicio);
        t.is('origen = shortName de la estación', consulta.origenShortName, despachada.origen);
        t.is('destino = shortName de la estación', consulta.destinoShortName, despachada.destino);
        t.is('estadoCorrida traducido (DISPATCHED→DESPACHADA)', 'DESPACHADA', despachada.estadoCorrida);
        t.is('operador = numeroOperador consultado', consulta.operadorKey, despachada.operador);
        t.is('operadorNombre', consulta.operadorNombre, despachada.operadorNombre);
        t.is('autobus = número económico', consulta.busEconomicNumber, despachada.autobus);
        t.is('capacidadAutobus', consulta.busCapacidad, despachada.capacidadAutobus);
        t.is('numeroRuta', consulta.routeNumber, despachada.numeroRuta);
        t.is('rutaNombre', consulta.routeName, despachada.rutaNombre);
        t.is('folioTarjeta = TravelCard.key', consulta.cardKey, despachada.folioTarjeta);
        t.is('estadoTarjetaViaje traducido (COLLECTED→RECAUDADA)', 'RECAUDADA', despachada.estadoTarjetaViaje);
      }

      const abierta = porClave(res.body, consultaCatalog.tripAbiertaId);
      t.present('la corrida abierta (sin tarjeta) también aparece', abierta);
      if (abierta) {
        t.is(
          'fechaHoraCorrida de la segunda corrida también en hora de México',
          fechaHoraEsperada(tripAbierta.departure),
          abierta.fechaHoraCorrida,
        );
        t.is('estadoCorrida traducido (OPEN→ABIERTA)', 'ABIERTA', abierta.estadoCorrida);
        t.is('folioTarjeta null: la corrida no tiene tarjeta despachada', null, abierta.folioTarjeta);
        t.is('estadoTarjetaViaje null: la corrida no tiene tarjeta despachada', null, abierta.estadoTarjetaViaje);
      }
    },
  },
  {
    name: 'consulta-corridas-amarillo',
    label: 'Consulta de tarjetas de viaje · operador sin corridas hoy (AMARILLO)',
    async run(t) {
      const res = await consultarCorridasOperador({
        numeroOperador: consulta.operadorSinCorridasKey,
        caja: consulta.caja,
      });
      // El rechazo de negocio viaja en el cuerpo con HTTP 200, no como error HTTP
      // — es la misma convención que BCB ya usa en su servicio SmartMac.
      t.is('responde 200 aunque sea un rechazo de negocio', 200, res.status, res.text);
      t.is('semáforo AMARILLO', 'AMARILLO', res.body?.semaforo);
      t.is(
        'mensaje',
        'No se encontraron corridas para el operador en el día actual',
        res.body?.mensaje,
      );
      t.is('corridas vacío', 0, res.body?.corridas?.length ?? -1);
    },
  },
  {
    name: 'consulta-corridas-caja-invalida',
    label: 'Consulta de tarjetas de viaje · caja no registrada (ROJO)',
    async run(t) {
      // Operador válido a propósito: la caja se valida ANTES e independientemente
      // del operador, así que esto aísla que el rechazo es por la caja.
      const res = await consultarCorridasOperador({
        numeroOperador: consulta.operadorKey,
        caja: consulta.cajaInvalida,
      });
      t.is('responde 200 aunque sea un rechazo de negocio', 200, res.status, res.text);
      t.is('semáforo ROJO', 'ROJO', res.body?.semaforo);
      t.is('mensaje', 'Caja inválida o no configurada correctamente', res.body?.mensaje);
      t.is('corridas vacío', 0, res.body?.corridas?.length ?? -1);
    },
  },
  {
    name: 'consulta-corridas-validacion',
    label: 'Consulta de tarjetas de viaje · falta un parámetro requerido → 400',
    async run(t) {
      // numeroOperador y caja son AMBOS requeridos (a diferencia de SM04, donde uno
      // de los dos basta) — sin este caso, un consumidor que omite `caja` se
      // enteraría con un 502 confuso del lado del adapter, no un 400 claro acá.
      const res = await consultarCorridasOperador({ numeroOperador: consulta.operadorKey });
      t.is('sin caja → 400', 400, res.status, res.text.slice(0, 200));
    },
  },
  {
    name: 'consulta-corridas-credencial',
    label: 'Consulta de tarjetas de viaje · rechaza a quien no trae la credencial de SmartMac',
    async run(t) {
      const query = { numeroOperador: consulta.operadorKey, caja: consulta.caja };

      const sin = await consultarCorridasOperador(query, 'none');
      t.is('sin credencial → 401', 401, sin.status, sin.text.slice(0, 200));

      const mala = await consultarCorridasOperador(query, 'smartmac-invalido');
      t.is(
        `credencial incorrecta → 401 (${ws2ExigeBasicAuth ? 'Basic' : 'JWT'})`,
        401,
        mala.status,
        mala.text.slice(0, 200),
      );
    },
  },
];
