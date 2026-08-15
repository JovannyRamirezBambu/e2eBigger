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
