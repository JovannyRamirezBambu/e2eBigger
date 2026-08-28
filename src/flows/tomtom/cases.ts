/**
 * Los 18 casos de CU04/CU05.
 *
 * Los payloads están tipados con los DTOs REALES del satélite BCB (`import type`,
 * se borran al compilar). Si alguien agrega o renombra un campo en el contrato,
 * esto deja de compilar — que es el momento correcto para enterarse, en vez de
 * descubrirlo como un 400 que en producción significa un evento perdido.
 */
import type { ConfirmarLlegadaDto } from '@bcb/dto/tomtom/dto/confirmar-llegada.dto';
import type { DespacharCorridaDto } from '@bcb/dto/tomtom/dto/despachar-corrida.dto';
import { BusStatus, OperatorTripStatus, TravelCardStatus, TripStatus } from '@bcb/prisma-enums';
import { bcbDb } from '@harness/db';
import { SatelliteClient } from '@harness/http';
import { logFile } from '@harness/paths';
import type { Report } from '@harness/report';
import type { CaseDef } from '@harness/types';
import { isoUtc, pgTimestamp, untilEquals } from '@harness/wait';
import * as fs from 'fs';
import * as path from 'path';
import { catalog, scenarios } from './scenarios';
import { confirmarLlegada as satConfirmar, despacharCorrida as satDespachar } from './satellite';
import { createChainTrip } from './seed';

const BCB_URL = process.env.E2E_BCB_URL ?? 'http://localhost:3009';

/** Habla con el satélite BCB como lo hace adapter-bcb: firmando con su llave. */
const bcb = new SatelliteClient(BCB_URL, { leg: 'adapter-bcb', subject: 'adapter-bcb' });

type DespachoRes = { corridaId: string; despachada: boolean; salidaReal: string; yaRegistrada: boolean };
type LlegadaRes = { tarjetaViajeId: string; corridaId: string; confirmada: boolean; llegadaReal: string; yaRegistrada: boolean };
type ContextoRes = { corrida: { economicNumber: string | null; autobusId: string | null } };

const despachar = (tripId: string, body: DespacharCorridaDto, override?: { useWrongKey?: boolean }) =>
  bcb.post<DespachoRes, DespacharCorridaDto>(`/corridas/${tripId}/despachar`, body, override);

const confirmar = (cardId: string, body: ConfirmarLlegadaDto) =>
  bcb.post<LlegadaRes, ConfirmarLlegadaDto>(`/tarjetas-viaje/${cardId}/confirmar-llegada`, body);

/** Payload de llegada válido para un escenario, para variar un campo a la vez. */
const llegadaPara = (s: typeof scenarios.VALIDACIONES, over: Partial<ConfirmarLlegadaDto> = {}): ConfirmarLlegadaDto => ({
  corridaId: s.tripId,
  autobusId: s.busId,
  operadorId: s.operadorId,
  estacionDestinoId: catalog.destinoId,
  llegadaReal: '2026-08-11T12:00:00Z',
  ...over,
});

const SAT_URL = process.env.E2E_SAT_URL ?? 'http://localhost:3003';
const FAKE_INROUTE = process.env.E2E_FAKE_INROUTE_URL ?? 'http://localhost:7803';
const WEBHOOK_TOKEN = process.env.E2E_INROUTE_WEBHOOK_TOKEN ?? 'e2e-webhook-token';

/** Habla con el satélite TomTom como lo hace adapter-tomtom: firmando con su llave. */
const sat = new SatelliteClient(SAT_URL, { leg: 'adapter-tt', subject: 'adapter-tomtom' });

/**
 * ¿El satélite está apuntando al sandbox REAL de Adsum? (levantado con
 * `E2E_INROUTE=real ./e2e up tomtom`). Se lee del .env del satélite — la misma
 * fuente de verdad que usa el proceso — para que `test` no dependa de repetir
 * la variable de entorno.
 */
function esInrouteReal(): boolean {
  try {
    const env = fs.readFileSync(path.resolve(process.cwd(), '../BIGER_EstrellaRoja_TomTom/.env'), 'utf-8');
    const m = env.match(/^INROUTE_BASE_URL=(.+)$/m);
    return Boolean(m && !m[1]!.includes('127.0.0.1') && !m[1]!.includes('localhost'));
  } catch {
    return false;
  }
}

/** "dd/mm/yyyy" + "HH:mm" en CST, como los registra InRoute. */
function fechaHoraInroute(d: Date): { fecha: string; hora: string } {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Mexico_City', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const v = (t: string) => p.find((x) => x.type === t)!.value;
  return { fecha: `${v('day')}/${v('month')}/${v('year')}`, hora: `${v('hour')}:${v('minute')}` };
}

/** Administración del InRoute falso (rutas __e2e del standalone). */
async function fakeInroute<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${FAKE_INROUTE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await res.json()) as T;
}

/** Empuja un evento de geocerca al webhook del satélite (CU03 — como lo haría TomTom). */
async function webhookEvento(body: {
  nVehiculo: number;
  nGeoCerca: number;
  nTipo: 1 | 2;
  dFechaHoraEvento: string;
}): Promise<{ status: number; body: { processed?: boolean; motivo?: string } }> {
  const res = await fetch(`${SAT_URL}/tomtom/eventos-geocerca`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WEBHOOK_TOKEN}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as { processed?: boolean; motivo?: string } };
}

const trip = (id: string) => bcbDb().trip.findUnique({ where: { id } });
const card = (id: string) => bcbDb().travelCard.findUnique({ where: { id } });
const bus = (id: string) => bcbDb().bus.findUnique({ where: { id } });
const operador = (id: string) => bcbDb().operator.findUnique({ where: { id } });

/**
 * ¿JetStream descartó el publish por deduplicación?
 *
 * El Nats-Msg-Id se deriva del id del viaje y la ventana de dedup es de 2 min, así
 * que repetir un caso de cadena de inmediato NO publica nada. Es correcto en
 * producción pero desconcertante en una prueba: detectarlo permite decir por qué.
 */
function dedupHit(id: string): boolean {
  try {
    const log = fs.readFileSync(logFile('adapter-tomtom'), 'utf-8').split('\n').slice(-40).join('\n');
    return log.includes(id) && log.includes('duplicate=true');
  } catch {
    return false;
  }
}

const DEDUP_HINT =
  'JetStream deduplicó el evento: ya se publicó hace <2 min.\n' +
  '     No es la cadena rota — esperá ~2 min o corré la suite completa.';

/**
 * Estos dos casos afirman el comportamiento CORRECTO (400). Fallan con 500 porque
 * `apps/bcb` monta I18nValidationPipe sin haber registrado I18nModule, así que el
 * filtro muere con "I18n context undefined" y cualquier payload inválido sale como
 * 500. No es un fallo del harness: es el bug que arregla el PR #1534, todavía sin
 * mergear. En cuanto entre a develop, estos dos pasan sin tocar nada.
 */
const PIPE_BUG_HINT =
  'develop devuelve 500 en vez de 400: I18nValidationPipe sin I18nModule.\n' +
  '     Lo arregla el PR #1534 (abierto). No es un fallo del harness.';

export const cases: CaseDef[] = [
  {
    name: 'auth-llave-invalida',
    label: 'Rechaza un JWT firmado con otra llave',
    async run(t) {
      const s = scenarios.HAPPY;
      const res = await despachar(s.tripId, { autobusId: s.busId, salidaReal: '2026-08-11T10:00:00Z' }, { useWrongKey: true });
      t.is('auth: JWT firmado con otra llave → 401', 401, res.status, res.text);
    },
  },
  {
    name: 't1-contexto',
    label: 'T1 · entrega el contexto de InRoute',
    async run(t) {
      const s = scenarios.HAPPY;
      const res = await bcb.get<ContextoRes>(`/tarjetas-viaje/${s.cardId}/contexto-tomtom`);
      t.is('T1: contexto-tomtom responde 200', 200, res.status, res.text);
      // Regresión del bug tripDispatch: bus y operador viven en TripDispatch,
      // no en Trip; leer Trip.bus directo devuelve null.
      t.is('T1: resuelve el bus desde TripDispatch', `E2E-BUS-${s.n}`, res.body?.corrida?.economicNumber);
    },
  },
  {
    name: 't10-trip-open',
    label: 'T10 · rechaza corrida nunca despachada',
    async run(t) {
      const s = scenarios.OPEN;
      const res = await despachar(s.tripId, { autobusId: s.busId, salidaReal: '2026-08-11T10:00:00Z' });
      t.is('T10: corrida OPEN (nunca despachada) → 409', 409, res.status, res.text);
    },
  },
  {
    name: 't10-trip-cancelled',
    label: 'T10 · rechaza corrida cancelada',
    async run(t) {
      const s = scenarios.CANCELLED;
      const res = await despachar(s.tripId, { autobusId: s.busId, salidaReal: '2026-08-11T10:00:00Z' });
      t.is('T10: corrida CANCELLED → 409', 409, res.status, res.text);
    },
  },
  {
    name: 't10-bus-no-coincide',
    label: 'T10 · rechaza un bus ajeno a la corrida',
    async run(t) {
      const res = await despachar(scenarios.HAPPY.tripId, {
        autobusId: '00000000-0000-4000-8000-000000000000',
        salidaReal: '2026-08-11T10:00:00Z',
      });
      t.is('T10: autobusId que no es de la corrida → 409', 409, res.status, res.text);
    },
  },
  {
    name: 't10-sin-offset-utc',
    label: 'T10 · exige offset UTC en la hora',
    async run(t) {
      // Sin offset la hora es ambigua: se guardaría corrida por horas.
      const s = scenarios.HAPPY;
      const res = await despachar(s.tripId, { autobusId: s.busId, salidaReal: '2026-08-11T10:00:00' });
      t.is('T10: salidaReal sin offset UTC → 400', 400, res.status, res.status === 500 ? PIPE_BUG_HINT : res.text);
    },
  },
  {
    name: 't10-campo-extra',
    label: 'T10 · rechaza campos fuera del contrato',
    async run(t) {
      // forbidNonWhitelisted: un campo de más da 400, y como el satélite no
      // reintenta, en producción eso es un evento perdido. Se manda a propósito
      // por fuera del tipo (un cast) porque el DTO no permite escribirlo.
      const s = scenarios.HAPPY;
      const body = { autobusId: s.busId, salidaReal: '2026-08-11T10:00:00Z', campoDeMas: 1 } as unknown as DespacharCorridaDto;
      const res = await despachar(s.tripId, body);
      t.is('T10: campo no declarado en el DTO → 400', 400, res.status, res.status === 500 ? PIPE_BUG_HINT : res.text);
    },
  },
  {
    name: 't10-idempotente',
    label: 'T10 · reintento no pisa la salida real',
    async run(t) {
      const s = scenarios.HAPPY;
      await despachar(s.tripId, { autobusId: s.busId, salidaReal: '2026-08-11T10:00:00Z' });
      // Segundo intento con OTRA hora: no debe pisar lo ya guardado.
      const res = await despachar(s.tripId, { autobusId: s.busId, salidaReal: '2099-01-01T00:00:00Z' });
      t.is('T10: reintento → 201', 201, res.status, res.text);
      t.is('T10: reintento marcado yaRegistrada', true, res.body?.yaRegistrada);
      t.is('T10: no sobrescribió la salida original', 2026, (await trip(s.tripId))?.realDepartureAt?.getUTCFullYear());
    },
  },
  {
    name: 't11-trip-open',
    label: 'T11 · rechaza corrida nunca despachada',
    async run(t) {
      const s = scenarios.OPEN;
      const res = await confirmar(s.cardId, llegadaPara(s));
      t.is('T11: corrida OPEN → 409', 409, res.status, res.text);
    },
  },
  {
    name: 't11-trip-cancelled',
    label: 'T11 · rechaza corrida cancelada',
    async run(t) {
      const s = scenarios.CANCELLED;
      const res = await confirmar(s.cardId, llegadaPara(s));
      t.is('T11: corrida CANCELLED → 409', 409, res.status, res.text);
    },
  },
  {
    name: 't11-bus-no-coincide',
    label: 'T11 · rechaza un bus ajeno a la corrida',
    async run(t) {
      const s = scenarios.VALIDACIONES;
      const res = await confirmar(s.cardId, llegadaPara(s, { autobusId: '00000000-0000-4000-8000-000000000000' }));
      t.is('T11: autobusId que no es de la corrida → 409', 409, res.status, res.text);
    },
  },
  {
    name: 't11-estacion-no-coincide',
    label: 'T11 · rechaza geocerca de otra terminal',
    async run(t) {
      // Falla ruidoso a propósito: una geocerca mal mapeada no debe mover el bus
      // a la terminal equivocada.
      const s = scenarios.VALIDACIONES;
      const res = await confirmar(s.cardId, llegadaPara(s, { estacionDestinoId: catalog.origenId }));
      t.is('T11: estación destino ≠ destino de la ruta → 409', 409, res.status, res.text);
    },
  },
  {
    name: 't11-happy',
    label: 'T11 · confirma y libera bus y operador',
    async run(t) {
      const s = scenarios.VALIDACIONES;
      await despachar(s.tripId, { autobusId: s.busId, salidaReal: '2026-08-11T10:00:00Z' });
      const res = await confirmar(s.cardId, llegadaPara(s));
      t.is('T11: happy path → 201', 201, res.status, res.text);
      t.is('T11: tarjeta CONFIRMED', TravelCardStatus.CONFIRMED, (await card(s.cardId))?.status);
      t.is('T11: corrida CONFIRMED', TripStatus.CONFIRMED, (await trip(s.tripId))?.status);
      const b = await bus(s.busId);
      t.is('T11: bus liberado a ACTIVE', BusStatus.ACTIVE, b?.status);
      t.is('T11: bus movido a la terminal destino', catalog.destinoId, b?.stationId);
      const o = await operador(s.operadorId);
      t.is('T11: operador AVAILABLE', OperatorTripStatus.AVAILABLE, o?.tripStatus);
      t.is('T11: operador en la terminal destino', catalog.destinoId, o?.stationId);
    },
  },
  {
    name: 't11-idempotente',
    label: 'T11 · reintento no duplica ni pisa',
    async run(t) {
      const s = scenarios.VALIDACIONES;
      const res = await confirmar(s.cardId, llegadaPara(s, { llegadaReal: '2099-01-01T00:00:00Z' }));
      t.is('T11: reintento → 201', 201, res.status, res.text);
      t.is('T11: no sobrescribió la llegada original', 2026, (await trip(s.tripId))?.realArrivalAt?.getUTCFullYear());
      const logs = await bcbDb().travelCardStatusLog.count({ where: { travelCardId: s.cardId } });
      t.is('T11: no duplicó el log de estado', 1, logs);
    },
  },
  {
    name: 't11-carrera-manual',
    label: 'T11 · respeta la confirmación humana',
    async run(t) {
      // Alguien confirmó la tarjeta a mano (abordaje móvil, PR #1428) antes de que
      // llegara la geocerca. El bus y el operador pueden estar YA reasignados a
      // otra corrida, así que la geocerca no debe volver a moverlos.
      const s = scenarios.MANUALCONFIRM;
      const antes = (await bus(s.busId))?.stationId;
      const res = await confirmar(s.cardId, llegadaPara(s));
      t.is('T11: ya confirmada a mano → 201 sin error', 201, res.status, res.text);
      t.is('T11: NO re-movió el bus (podría estar en otra corrida)', antes, (await bus(s.busId))?.stationId);
    },
  },
  {
    name: 'cadena-t10',
    label: 'CADENA · despacho real por toda la cadena',
    async run(t) {
      const s = scenarios.CADENA_T10;
      // Viaje nuevo por corrida: el id es la llave de dedup de JetStream, así que
      // reusar uno fijo hacía que dos corridas seguidas no publicaran nada.
      const { tripId } = await createChainTrip(s);
      // Hora distinta en cada corrida: el valor verificado solo puede haber
      // llegado por la cadena en esta pasada.
      const salida = new Date(Date.UTC(2026, 7, 11, 6 + Math.floor(Math.random() * 12), Math.floor(Math.random() * 60)));
      await satDespachar(tripId, { autobusId: s.busId, salidaReal: isoUtc(salida) });

      const want = pgTimestamp(salida);
      const { ok } = await untilEquals(async () => {
        const r = await trip(tripId);
        return r?.realDepartureAt ? pgTimestamp(r.realDepartureAt) : undefined;
      }, want);

      t.is(
        'CADENA CU04: la salida real viajó satélite→NATS→BCB',
        want,
        ok ? want : dedupHit(tripId) ? '(deduplicado)' : '(no llegó)',
        ok ? undefined : dedupHit(tripId) ? DEDUP_HINT : 'revisá: ./e2e logs tomtom adapter-bcb',
      );
      t.is('CADENA CU04: bus a ON_TRIP', BusStatus.ON_TRIP, (await bus(s.busId))?.status);
    },
  },
  {
    name: 'cadena-t11',
    label: 'CADENA · llegada real por toda la cadena',
    async run(t) {
      const s = scenarios.CADENA_T11;
      const { tripId, cardId } = await createChainTrip(s);
      const salida = new Date(Date.UTC(2026, 7, 11, 6 + Math.floor(Math.random() * 6), Math.floor(Math.random() * 60)));
      await satDespachar(tripId, { autobusId: s.busId, salidaReal: isoUtc(salida) });
      await untilEquals(async () => {
        const r = await trip(tripId);
        return r?.realDepartureAt ? pgTimestamp(r.realDepartureAt) : undefined;
      }, pgTimestamp(salida));

      const llegada = new Date(Date.UTC(2026, 7, 11, 13 + Math.floor(Math.random() * 8), Math.floor(Math.random() * 60)));
      await satConfirmar(cardId, {
        corridaId: tripId,
        autobusId: s.busId,
        operadorId: s.operadorId,
        estacionDestinoId: catalog.destinoId,
        llegadaReal: isoUtc(llegada),
      });

      const want = pgTimestamp(llegada);
      const { ok } = await untilEquals(async () => {
        const r = await trip(tripId);
        return r?.realArrivalAt ? pgTimestamp(r.realArrivalAt) : undefined;
      }, want);
      const deduped = dedupHit(cardId) || dedupHit(tripId);

      t.is(
        'CADENA CU05: la llegada real viajó satélite→NATS→BCB',
        want,
        ok ? want : deduped ? '(deduplicado)' : '(no llegó)',
        ok ? undefined : deduped ? DEDUP_HINT : 'revisá: ./e2e logs tomtom adapter-bcb',
      );
      t.is('CADENA CU05: tarjeta CONFIRMED', TravelCardStatus.CONFIRMED, (await card(cardId))?.status);
      t.is('CADENA CU05: bus en la terminal destino', catalog.destinoId, (await bus(s.busId))?.stationId);
    },
  },
  {
    name: 'cadena-cu01-webhook-t12',
    label: 'CADENA · CU01 alta en InRoute → webhook CU03 → CU04 en BCB → T12 telemetría',
    skip: () => (esInrouteReal() ? 'requiere el InRoute falso (catálogos __e2e y simulación del webhook)' : null),
    async run(t) {
      const s8 = scenarios.CADENA_CU01;
      const { tripId, cardId } = await createChainTrip(s8);

      // La corrida existe en el InRoute falso (catálogos con el contrato real:
      // cDriverNo, cObjectNo con relleno, grupos solo-nGrupo/cDescripcion).
      const ids = await fakeInroute<{ nVehicleId: number; GEOCERCA_ORIGEN: number; GEOCERCA_DESTINO: number }>(
        '/__e2e/corridas',
        { economicNumber: `E2E-BUS-${s8.n}`, operatorKey: `E2E-OP-${s8.n}`, routeNumber: `E2E-R-${s8.n}`, routeName: 'CADENA CU01' },
      );

      // CU01 — contrato mínimo BCB + enriquecimiento de UUIDs para los callbacks.
      const departure = new Date(Date.now() + 10 * 60_000);
      const alta = await sat.post<{ nTripId: number | null; nOrderId: number | null }>(
        '/tomtom/viajes',
        {
          claveERP: cardId,
          tripId,
          economicNumber: `E2E-BUS-${s8.n}`,
          operatorKey: `E2E-OP-${s8.n}`,
          routeId: `E2E-R-${s8.n}`,
          service: 'Pullman Primera Clase',
          operatorName: 'OPERADOR CADENA OCHO',
          departure: departure.toISOString(),
          busId: s8.busId,
          operatorId: s8.operadorId,
          destinationId: catalog.destinoId,
        },
      );
      t.is('CU01: alta 201 (orden + viaje en InRoute)', 201, alta.status, alta.text);
      t.is('CU01: nTripId asignado', true, (alta.body?.nTripId ?? 0) > 0, alta.text);
      t.is('CU01: nOrderId asignado (regla 3008: viaje con orden)', true, (alta.body?.nOrderId ?? 0) > 0, alta.text);

      // El viaje en el InRoute falso quedó Conformado (nEstatus 2, referencia GEF)
      const estado = await fakeInroute<{ viajes: { cClaveERP: string; nStatusViaje: number }[]; ordenes: { cObjectNo: string }[] }>('/__e2e/estado');
      const viajeInroute = estado.viajes.find((v) => v.cClaveERP === tripId);
      t.is('CU01: viaje Conformado (nStatusViaje 2)', 2, viajeInroute?.nStatusViaje);

      // CU03 — TomTom empuja la SALIDA de la geocerca de origen al webhook.
      const ahoraInroute = () => {
        const p = new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/Mexico_City', day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit', hour12: false,
        }).formatToParts(new Date());
        const v = (t2: string) => p.find((x) => x.type === t2)!.value;
        return `${v('day')}/${v('month')}/${v('year')} ${v('hour')}:${v('minute')}`;
      };
      const salida = await webhookEvento({
        nVehiculo: ids.nVehicleId, nGeoCerca: ids.GEOCERCA_ORIGEN, nTipo: 2, dFechaHoraEvento: ahoraInroute(),
      });
      t.is('CU03: webhook salida → 202', 202, salida.status, JSON.stringify(salida.body));
      t.is('CU03: evento procesado (corrida despachada)', true, salida.body.processed === true, salida.body.motivo);

      // CU04 — el despacho viajó satélite → adapter → JetStream → BCB.
      const { ok: despachada } = await untilEquals(async () => Boolean((await trip(tripId))?.realDepartureAt), true);
      t.is('CU04: realDepartureAt registrado en BCB', true, despachada, 'revisá: ./e2e logs tomtom adapter-bcb');

      // CU03/CU04 — ENTRADA a la geocerca de destino.
      const llegada = await webhookEvento({
        nVehiculo: ids.nVehicleId, nGeoCerca: ids.GEOCERCA_DESTINO, nTipo: 1, dFechaHoraEvento: ahoraInroute(),
      });
      t.is('CU03: webhook llegada → 202 procesado', true, llegada.status === 202 && llegada.body.processed === true, llegada.body.motivo);
      const { ok: confirmada } = await untilEquals(async () => (await card(cardId))?.status, TravelCardStatus.CONFIRMED);
      t.is('CU04: tarjeta CONFIRMED en BCB', true, confirmada);

      // T12 — el viaje termina en InRoute; el sync del satélite empuja la telemetría a BCB.
      await fakeInroute('/__e2e/terminar-viaje', { nViaje: alta.body!.nTripId });
      const sync = await sat.post('/tomtom/viajes/sync', {});
      t.is('T12: disparo del sync → 202', 202, sync.status, sync.text);
      const { ok: conTelemetria } = await untilEquals(
        async () => Boolean(await bcbDb().tomTomTripData.findUnique({ where: { travelCardId: cardId } })),
        true,
      );
      t.is('T12: TomTomTripData poblada en BCB', true, conTelemetria, 'revisá: ./e2e logs tomtom adapter-bcb satelite-tomtom');
      if (conTelemetria) {
        const datos = await bcbDb().tomTomTripData.findUnique({ where: { travelCardId: cardId } });
        t.is('T12: telemetría con distancia', true, (datos?.distanceKm ?? 0) > 0);
        t.is('T12: estatus Terminado (6)', 6, datos?.tripStatus);
      }
    },
  },
  {
    name: 'cadena-nats-bitacora',
    label: 'CADENA · alta vía NATS y bitácora de sync en BCB',
    skip: () => (esInrouteReal() ? 'requiere el InRoute falso (los catálogos E2E-* no existen en el sandbox real)' : null),
    async run(t) {
      const s9 = scenarios.CADENA_NATS;
      const { tripId, cardId } = await createChainTrip(s9);
      await fakeInroute('/__e2e/corridas', {
        economicNumber: `E2E-BUS-${s9.n}`, operatorKey: `E2E-OP-${s9.n}`, routeNumber: `E2E-R-${s9.n}`, routeName: 'CADENA NATS',
      });

      // Como adapter-bcb: publica el evento de viaje al subject que consume
      // adapter-tomtom. El contrato mínimo + UUIDs de enriquecimiento.
      const { publishRaw } = await import('@harness/nats');
      const publicado = await publishRaw('biger.tomtom.viaje.crear', {
        claveERP: cardId,
        tripId,
        economicNumber: `E2E-BUS-${s9.n}`,
        operatorKey: `E2E-OP-${s9.n}`,
        routeId: `E2E-R-${s9.n}`,
        service: 'Pullman Primera Clase',
        operatorName: 'OPERADOR CADENA NUEVE',
        departure: new Date(Date.now() + 30 * 60_000).toISOString(),
        description: '',
        busId: s9.busId,
        operatorId: s9.operadorId,
        originId: '',
        destinationId: catalog.destinoId,
        nVehicleId: null, nDriverId: null, nGroupId: null, nTripInstructionId: null,
      });
      t.is('NATS: evento de viaje publicado', true, publicado);

      // Cadena D: adapter-tomtom → satélite → InRoute falso, y el RESULTADO del
      // sync regresa por JetStream hasta la bitácora de BCB.
      const { ok: conBitacora } = await untilEquals(
        async () => (await bcbDb().travelCardTomTomSync.count({ where: { travelCardId: cardId } })) > 0,
        true,
      );
      t.is('BITÁCORA: TravelCardTomTomSync registrada en BCB', true, conBitacora, 'revisá: ./e2e logs tomtom adapter-tomtom adapter-bcb');

      const { ok: conTripId } = await untilEquals(
        async () => ((await card(cardId))?.tomTomTripId ?? 0) > 0,
        true,
      );
      t.is('BITÁCORA: tomTomTripId poblado en la TravelCard', true, conTripId);
      t.is('BITÁCORA: tomTomFailed en false', false, (await card(cardId))?.tomTomFailed);
    },
  },
  {
    name: 'cadena-reconciliacion',
    label: 'CADENA · reconciliación por poll: salida/llegada reales derivadas de InRoute, sin webhook',
    skip: () => (esInrouteReal() ? 'requiere el InRoute falso (rutas __e2e para simular el cruce de geocercas)' : null),
    async run(t) {
      const s10 = scenarios.CADENA_POLL;
      const { tripId, cardId } = await createChainTrip(s10);

      await fakeInroute('/__e2e/corridas', {
        economicNumber: `E2E-BUS-${s10.n}`, operatorKey: `E2E-OP-${s10.n}`,
        routeNumber: `E2E-R-${s10.n}`, routeName: 'CADENA POLL',
      });

      const departure = new Date(Date.now() + 10 * 60_000);
      const alta = await sat.post<{ nTripId: number | null }>('/tomtom/viajes', {
        claveERP: cardId,
        tripId,
        economicNumber: `E2E-BUS-${s10.n}`,
        operatorKey: `E2E-OP-${s10.n}`,
        routeId: `E2E-R-${s10.n}`,
        operatorName: 'OPERADOR CADENA DIEZ',
        departure: departure.toISOString(),
        busId: s10.busId,
        operatorId: s10.operadorId,
        destinationId: catalog.destinoId,
      });
      t.is('CU01: alta 201', 201, alta.status, alta.text);

      // Sin tiempos reales aún: el poll no debe derivar nada.
      const enVacio = await sat.post('/tomtom/viajes/reconciliar', {});
      t.is('poll sin cruces → 202 y sin efectos', 202, enVacio.status, enVacio.text);
      t.is('poll sin cruces: BCB sigue sin salida real', null, (await trip(tripId))?.realDepartureAt ?? null);

      // InRoute registra el cruce él mismo (salida dentro de la ventana −45/+60
      // respecto a la salida programada; llegada = ahora).
      const salida = fechaHoraInroute(new Date());
      const llegada = fechaHoraInroute(new Date());
      await fakeInroute('/__e2e/terminar-viaje', {
        nViaje: alta.body!.nTripId,
        telemetria: {
          cFechaSalidaReal: salida.fecha, cHoraSalidaReal: salida.hora,
          cFechaLlegadaReal: llegada.fecha, cHoraLlegadaReal: llegada.hora,
        },
      });

      const conCruces = await sat.post('/tomtom/viajes/reconciliar', {});
      t.is('poll con cruces → 202', 202, conCruces.status, conCruces.text);

      // El despacho y la llegada viajaron satélite → adapter → JetStream → BCB.
      const { ok: despachada } = await untilEquals(async () => Boolean((await trip(tripId))?.realDepartureAt), true);
      t.is('CU04: realDepartureAt en BCB (derivado del poll)', true, despachada, dedupHit(tripId) ? DEDUP_HINT : 'revisá: ./e2e logs tomtom adapter-bcb');
      const { ok: confirmada } = await untilEquals(async () => (await card(cardId))?.status, TravelCardStatus.CONFIRMED);
      t.is('CU04: tarjeta CONFIRMED en BCB (derivado del poll)', true, confirmada);

      // Idempotencia: repetir el poll no re-notifica ni cambia la hora registrada.
      const antes = (await trip(tripId))?.realDepartureAt?.toISOString();
      const repetido = await sat.post('/tomtom/viajes/reconciliar', {});
      t.is('poll repetido → 202', 202, repetido.status, repetido.text);
      t.is('poll repetido: hora real intacta', antes, (await trip(tripId))?.realDepartureAt?.toISOString());
    },
  },
  {
    name: 'inroute-ciclo-viaje',
    label: 'InRoute · ciclo completo del viaje vía satélite: alta → consulta → actualiza → cancela (sandbox real con E2E_INROUTE=real)',
    async run(t) {
      const real = esInrouteReal();
      let refs = {
        economicNumber: process.env.E2E_INROUTE_BUS ?? '675',
        operatorKey: process.env.E2E_INROUTE_OP ?? '303258',
        routeId: process.env.E2E_INROUTE_ROUTE ?? '200',
      };
      if (!real) {
        await fakeInroute('/__e2e/corridas', {
          economicNumber: 'E2E-BUS-SMOKE', operatorKey: 'E2E-OP-SMOKE',
          routeNumber: 'E2E-R-SMOKE', routeName: 'CICLO VIAJE',
        });
        refs = { economicNumber: 'E2E-BUS-SMOKE', operatorKey: 'E2E-OP-SMOKE', routeId: 'E2E-R-SMOKE' };
      }

      // Clave única ≤20 chars (cObjectNo de la orden InRoute trunca a 20).
      const clave = `BQAE2E${Date.now()}`;
      const departure = new Date(Date.now() + 70 * 60_000); // respeta los 60 min del CU01

      const alta = await sat.post<{ nTripId: number | null; nOrderId: number | null }>('/tomtom/viajes', {
        claveERP: clave,
        tripId: clave,
        economicNumber: refs.economicNumber,
        operatorKey: refs.operatorKey,
        routeId: refs.routeId,
        operatorName: 'PRUEBA E2E BAMBU',
        departure: departure.toISOString(),
      });
      t.is(`alta 201 contra InRoute ${real ? 'REAL (sandbox)' : 'falso'}`, 201, alta.status, alta.text);
      t.is('alta: nTripId asignado', true, (alta.body?.nTripId ?? 0) > 0, alta.text);
      t.is('alta: nOrderId asignado (regla 3008)', true, (alta.body?.nOrderId ?? 0) > 0, alta.text);

      const consulta = await sat.get<{ nStatusViaje?: number }>(`/tomtom/viajes/${clave}`);
      t.is('consulta 200', 200, consulta.status, consulta.text);
      t.is('consulta: viaje Conformado (nStatusViaje 2)', 2, consulta.body?.nStatusViaje, consulta.text);

      // El claveERP va en el path — el UpdateViajeDto lo rechaza en el body.
      const actualiza = await sat.put(`/tomtom/viajes/${clave}`, {
        tripId: clave,
        economicNumber: refs.economicNumber,
        operatorKey: refs.operatorKey,
        routeId: refs.routeId,
        operatorName: 'PRUEBA E2E BAMBU (upd)',
        departure: new Date(departure.getTime() + 10 * 60_000).toISOString(),
      });
      t.is('actualización 200', 200, actualiza.status, actualiza.text);

      // Limpieza siempre: el viaje se cancela en InRoute (motivo fallback 1).
      const cancela = await sat.delete(`/tomtom/viajes/${clave}`);
      t.is('cancelación aceptada', true, cancela.status < 300, cancela.text);
    },
  },
  {
    name: 'webhook-auth',
    label: 'CU03 · el webhook rechaza sin token y con token equivocado',
    async run(t) {
      const evento = { nVehiculo: 1, nGeoCerca: 1, nTipo: 2, dFechaHoraEvento: '11/08/2026 10:00' };
      const sin = await fetch(`${SAT_URL}/tomtom/eventos-geocerca`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(evento),
      });
      t.is('CU03: sin Authorization → 401', 401, sin.status);
      const malo = await fetch(`${SAT_URL}/tomtom/eventos-geocerca`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-equivocado' },
        body: JSON.stringify(evento),
      });
      t.is('CU03: token equivocado → 401', 401, malo.status);
      const malFormado = await webhookEvento({ nVehiculo: 1, nGeoCerca: 1, nTipo: 2, dFechaHoraEvento: 'ayer' });
      t.is('CU03: timestamp inválido → 400 (contrato DCU)', 400, malFormado.status);
    },
  },
  {
    name: 'dlq-vacia',
    label: 'Ningún evento terminó descartado',
    async run(t: Report) {
      const { streamMessages, readDlq } = await import('@harness/nats');
      const n = await streamMessages('TOMTOM_GEOCERCAS_DLQ_STREAM');
      if (n === 0) {
        t.is('ningún evento cayó a la DLQ', 0, 0);
        return;
      }
      // Ahora sí se puede decir POR QUÉ, no solo que hay algo: el cliente NATS
      // lee los headers x-dlq-reason / x-error-detail de cada descarte.
      const entries = await readDlq('TOMTOM_GEOCERCAS_DLQ_STREAM', 5);
      const detalle = entries.map((e) => `#${e.seq} ${e.reason}: ${e.detail}`).join('\n     ') || '(sin detalle legible)';
      t.is('ningún evento cayó a la DLQ', 0, n, detalle);
    },
  },
];
