/**
 * Casos de la sincronización offline: tablet → adapter-ticketcolectoroffline →
 * NATS request/reply → adapter-bcb → app `bcb` (módulo sync).
 *
 * Dos cosas hacen a este flujo distinto de los otros dos:
 *
 *  1. **La identidad no viaja en el payload.** El taquillero sale del token
 *     ADVISOR que valida el adapter, se copia al `_auth` del mensaje NATS y
 *     adapter-bcb lo vuelve a firmar como los claims `userId`/`role` del
 *     contrato-token 2.0. Toda la cadena tiene que estar bien o BCB responde 401
 *     sin decir en cuál eslabón se perdió. Por eso el flujo corre con el
 *     autenticador real y no con `JWT_BYPASS`.
 *
 *  2. **El error de BCB tiene que llegar como error de BCB.** Es request/reply, no
 *     un evento: la tablet decide si reintentar con el mismo `sync_id` según el
 *     status. Un 404 (caja/turno) que llegue como 502 le dice a la tablet "el
 *     servidor está caído" cuando en realidad falta configurar la caja. Los casos
 *     t12–t14 fijan esa propagación.
 *
 * El payload va tipado con el DTO REAL de BCB (`SyncOfflineSalesDto`), porque el
 * lote se reenvía sin transformación: un campo fuera del contrato no compila.
 */
import type { SyncOfflineSalesResponseDto } from '@bcb/dto/sync/dto/sync-offline-sales-response.dto';
import type { OfflineOrderDto, SyncOfflineSalesDto } from '@bcb/dto/sync/dto/sync-offline-sales.dto';
import { bcbDb } from '@harness/db';
import { jwkThumbprint, signJwt, type SignOpts } from '@harness/http';
import { streamMessages } from '@harness/nats';
import { REPO_MAIN } from '@harness/paths';
import { recordHttp } from '@harness/trace';
import type { CaseDef } from '@harness/types';
import { sleep, until } from '@harness/wait';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { catalog, tcoBatches, type TcoBatch, type TcoOrder } from './scenarios';

const ADAPTER_URL =
  process.env.E2E_TCO_ADAPTER_URL ?? 'http://localhost:8092/ticketcolectoroffline';
/** Debe coincidir con TICKETCOLECTOROFFLINE_ADVISOR_ISSUER del flow.sh. */
const JWKS_ISSUER = process.env.E2E_TCO_JWKS_ISSUER ?? 'http://127.0.0.1:7802/advisor';
const LEG_ADVISOR = 'tablet-advisor';
const STREAM = 'TICKETCOLECTOROFFLINE_SYNC_STREAM';

type Res<T = unknown> = { status: number; body: T; text: string };

/**
 * Token del taquillero, tal como lo emitiría el emisor ADVISOR de BCB. El `sub` es
 * lo que termina siendo `userId` en BCB, así que tiene que ser el id del asesor
 * dueño de la caja. El `kid` sale del thumbprint de la llave: es el mismo que
 * publica lib/jwks-server.js.
 */
function advisorToken(over: Partial<SignOpts> = {}): string {
  return signJwt({
    leg: LEG_ADVISOR,
    issuer: JWKS_ISSUER,
    subject: catalog.advisorId,
    keyId: jwkThumbprint(LEG_ADVISOR),
    ttlSeconds: 600,
    // Claim propio del token ADVISOR. BCB resuelve la estación desde la caja, no
    // desde acá, pero el token real lo trae y el `_auth` lo propaga.
    extraClaims: { stationNumber: catalog.stationNumber },
    ...over,
  });
}

async function post<T>(
  ruta: string,
  body: unknown,
  opts: { token?: string | null } = {},
): Promise<Res<T>> {
  const token = opts.token === undefined ? advisorToken() : opts.token;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const url = `${ADAPTER_URL}${ruta}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* respuesta no-JSON (p. ej. 202 sin cuerpo) */
  }
  recordHttp({ method: 'POST', url, reqHeaders: headers, reqBody: body, status: res.status, resBody: parsed });
  return { status: res.status, body: parsed as T, text };
}

const sincronizar = (lote: SyncOfflineSalesDto, opts?: { token?: string | null }) =>
  post<SyncOfflineSalesResponseDto>('/sincronizaciones', lote, opts);

// ── Armado de payloads ──────────────────────────────────────────────────────

function orden(o: TcoOrder, over: Partial<OfflineOrderDto> = {}): OfflineOrderDto {
  return {
    id: o.id,
    total: o.total,
    issuedAt: o.issuedAt,
    ticketNumber: o.tabletTicketNumber,
    invoiceCode: o.invoiceCode,
    ...over,
  };
}

function lote(b: TcoBatch, over: Partial<SyncOfflineSalesDto> = {}): SyncOfflineSalesDto {
  return {
    sync_id: b.syncId,
    orders: b.orders.map((o) => orden(o)),
    ...over,
  };
}

// ── Lecturas de BD ──────────────────────────────────────────────────────────

/**
 * La venta tal como quedó en BCB, buscada por el folio de la TABLET —la única
 * llave que este harness controla y que sobrevive entre corridas (los ids del lote
 * son nuevos en cada una, a propósito).
 */
async function ventaEnBcb(o: TcoOrder) {
  return bcbDb().orderItemOffline.findFirst({
    where: { tabletTicketNumber: o.tabletTicketNumber },
    select: {
      tripId: true,
      orderItem: {
        select: {
          ticketNumber: true,
          invoiceCode: true,
          totalPrice: true,
          passenger: { select: { name: true, isMainPassenger: true, passengerTypeId: true } },
          order: {
            select: {
              id: true,
              status: true,
              total: true,
              shiftId: true,
              advisorId: true,
              cashRegisterId: true,
              salesChannelId: true,
            },
          },
        },
      },
    },
  });
}

const cuentaVentas = (b: TcoBatch) =>
  bcbDb().orderItemOffline.count({
    where: { tabletTicketNumber: { in: b.orders.map((o) => o.tabletTicketNumber) } },
  });

/**
 * ¿El adapter reenvía `shiftId`? Se lee del DTO del repo, no se asume.
 *
 * `shiftId` es un cambio de DOS repos (el adapter lo reenvía, BCB lo consume) y hoy
 * vive en una rama. Fijar aquí el comportamiento de la rama pondría el flujo en rojo
 * sobre develop; fijar el de develop lo dejaría en verde el día que la rama se
 * mergee mal. Espejar el DTO —igual que el bootstrap del app bcb espeja su main.ts—
 * hace que el caso afirme lo que el repo dice que hace, y que se ponga en rojo justo
 * en el caso interesante: el adapter lo manda y BCB lo ignora.
 */
function adapterReenviaShiftId(): boolean {
  const dto = path.join(
    REPO_MAIN,
    'adapter-bcb/src/main/java/com/biger/adapters/bcb/ticketcolectoroffline/request/SyncOfflineRequest.java',
  );
  try {
    return /\bshiftId\b/.test(fs.readFileSync(dto, 'utf-8'));
  } catch {
    return false;
  }
}

// ── Casos ───────────────────────────────────────────────────────────────────

export const cases: CaseDef[] = [
  {
    name: 't01-lote-completo',
    label: 'el lote de la tablet llega hasta BCB y queda persistido',
    async run(t) {
      const b = tcoBatches.LOTE_OK;
      const res = await sincronizar(lote(b));

      t.is('POST /sincronizaciones responde 200', 200, res.status, res.text.slice(0, 300));
      t.is('totalReceived', 2, res.body?.totalReceived);
      t.is('ordersCreated', 2, res.body?.ordersCreated);
      t.is('itemsCreated', 2, res.body?.itemsCreated);

      const venta = await ventaEnBcb(b.orders[0]!);
      t.present('la venta existe en BCB', venta?.orderItem?.order?.id);
      t.is('la orden cuelga del taquillero del token', catalog.advisorId, venta?.orderItem?.order?.advisorId);
      t.is('cuelga del turno abierto', catalog.turnoAbiertoId, venta?.orderItem?.order?.shiftId);
      t.is('cuelga de la caja activa', catalog.cashRegisterId, venta?.orderItem?.order?.cashRegisterId);
      t.is(
        'canal = ticket collector offline',
        'c2cbf57a-760e-47bd-aa00-0cb4f00b7ae7',
        venta?.orderItem?.order?.salesChannelId,
      );
      t.is('conserva el folio de facturación', b.orders[0]!.invoiceCode, venta?.orderItem?.invoiceCode);

      // El folio de BCB lo genera el servidor (reserveTicketNumbers) y arranca con
      // el número de estación de la caja. Si la estación no fuera numérica esto
      // sería un 422, así que verificarlo prueba también el seed.
      const folio = venta?.orderItem?.ticketNumber ?? '';
      t.assert(
        'el folio de BCB lleva el número de estación',
        folio.startsWith(catalog.stationNumber.padStart(4, '0')),
        folio,
      );

      // Sin esta fila los reportes salen vacíos: leen orderItem.passenger.name.
      t.present('registra el pasajero al portador', venta?.orderItem?.passenger?.name);
      t.is('el pasajero es el principal', true, venta?.orderItem?.passenger?.isMainPassenger);
    },
  },

  {
    name: 't02-idempotente',
    label: 'reenviar el mismo lote no duplica nada',
    async run(t) {
      const b = tcoBatches.IDEMPOTENTE;
      const primera = await sincronizar(lote(b));
      t.is('la primera pasa', 200, primera.status, primera.text.slice(0, 200));
      t.is('crea 1 orden', 1, primera.body?.ordersCreated);

      const segunda = await sincronizar(lote(b));
      t.is('la segunda también responde 200', 200, segunda.status, segunda.text.slice(0, 200));
      // Es la respuesta CACHEADA del primer intento (mismo sync_id, mismo hash),
      // así que los conteos se repiten: no significan "creé otra vez".
      t.is('devuelve la respuesta cacheada', 1, segunda.body?.ordersCreated);

      t.is('en BD sigue habiendo UNA sola venta', 1, await cuentaVentas(b));
    },
  },

  {
    name: 't03-conflicto-payload',
    label: 'mismo sync_id con otro contenido → 409, no un merge silencioso',
    async run(t) {
      const b = tcoBatches.CONFLICTO;
      const primera = await sincronizar(lote(b));
      t.is('la primera pasa', 200, primera.status, primera.text.slice(0, 200));

      // Mismo sync_id, total distinto: el hash del payload cambia.
      const distinta = await sincronizar(
        lote(b, { orders: [orden(b.orders[0]!, { total: b.orders[0]!.total + 99 })] }),
      );
      t.is('responde 409', 409, distinta.status, distinta.text.slice(0, 300));
      t.is('y no creó una segunda venta', 1, await cuentaVentas(b));
    },
  },

  {
    name: 't04-cancelada-en-el-lote',
    label: 'venta creada y cancelada durante el mismo periodo offline',
    async run(t) {
      const b = tcoBatches.CANCELADA;
      const o = b.orders[0]!;
      // El contrato pide que la venta venga en orders[] Y en canceled_orders[]:
      // primero se crea y después se cancela, para que quede el historial completo.
      const res = await sincronizar(lote(b, { canceled_orders: [{ id: o.id }] }));

      t.is('responde 200', 200, res.status, res.text.slice(0, 300));
      t.is('crea la orden', 1, res.body?.ordersCreated);
      t.is('y la marca cancelada', 1, res.body?.canceledOrdersMarked);

      const venta = await ventaEnBcb(o);
      t.is('la orden queda CANCELED en BD', 'CANCELED', venta?.orderItem?.order?.status);
    },
  },

  {
    name: 't05-recoleccion-de-efectivo',
    label: 'la recolección se registra contra el turno del taquillero',
    async run(t) {
      const b = tcoBatches.RECOLECCION;
      const recoleccionId = b.orders[0]!.id; // uuid fresco, sirve igual de PK
      const res = await sincronizar(
        lote(b, {
          cashCollect: [
            {
              id: recoleccionId,
              amount: 1500.5,
              createdById: catalog.adminId,
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      );

      t.is('responde 200', 200, res.status, res.text.slice(0, 300));
      t.is('registra 1 recolección', 1, res.body?.collectionsCreated);

      const rec = await bcbDb().cashCollection.findUnique({
        where: { id: recoleccionId },
        select: { amount: true, shiftId: true, createdById: true },
      });
      t.is('cuelga del turno abierto', catalog.turnoAbiertoId, rec?.shiftId);
      t.is('conserva el monto', '1500.5', String(rec?.amount));
      t.is('conserva quién la hizo', catalog.adminId, rec?.createdById);
    },
  },

  {
    name: 't06-corrida-existente',
    label: 'el tripId del boleto queda guardado',
    async run(t) {
      const b = tcoBatches.CORRIDA_OK;
      const res = await sincronizar(
        lote(b, { orders: [orden(b.orders[0]!, { tripId: catalog.tripId })] }),
      );
      t.is('responde 200', 200, res.status, res.text.slice(0, 300));

      const venta = await ventaEnBcb(b.orders[0]!);
      // De acá saca el reporte la clave de corrida y su hora de salida.
      t.is('OrderItemOffline.tripId conserva la corrida', catalog.tripId, venta?.tripId);
    },
  },

  {
    name: 't07-corrida-inexistente',
    label: 'una corrida borrada se guarda como null, sin tumbar el lote',
    async run(t) {
      const b = tcoBatches.CORRIDA_FANTASMA;
      const res = await sincronizar(
        lote(b, { orders: [orden(b.orders[0]!, { tripId: 'E2ETCO-NO-EXISTE-0001' })] }),
      );

      // El lote son ventas ya cobradas en efectivo: una FK rota no puede costar
      // el lote entero.
      t.is('responde 200 igual', 200, res.status, res.text.slice(0, 300));
      t.is('y crea la venta', 1, res.body?.ordersCreated);

      const venta = await ventaEnBcb(b.orders[0]!);
      t.present('la venta existe', venta?.orderItem?.order?.id);
      t.is('el tripId queda en null', null, venta?.tripId);
    },
  },

  {
    name: 't08-tipo-de-pasajero',
    label: 'el tipo de pasajero llega hasta la fila de Passenger',
    async run(t) {
      const b = tcoBatches.TIPO_PASAJERO;
      const res = await sincronizar(
        lote(b, { orders: [orden(b.orders[0]!, { passengerTypeId: catalog.passengerTypeId })] }),
      );
      t.is('responde 200', 200, res.status, res.text.slice(0, 300));

      const venta = await ventaEnBcb(b.orders[0]!);
      t.is(
        'Passenger.passengerTypeId queda poblado',
        catalog.passengerTypeId,
        venta?.orderItem?.passenger?.passengerTypeId,
      );
    },
  },

  {
    name: 't09-turno-explicito',
    label: 'el turno del lote (shiftId) — espejado del DTO del adapter',
    async run(t) {
      const b = tcoBatches.LOTE_OK;
      const reenvia = adapterReenviaShiftId();

      // sync_id nuevo: este caso manda otro lote, no el de t01.
      const syncId = randomUUID();
      const o: TcoOrder = { ...b.orders[0]!, id: randomUUID(), tabletTicketNumber: 'E2E-TCO-TURNO-1' };
      const res = await sincronizar({
        sync_id: syncId,
        orders: [orden(o)],
        shiftId: catalog.turnoCerradoId,
      });

      t.is('responde 200', 200, res.status, res.text.slice(0, 300));
      const venta = await ventaEnBcb(o);

      if (reenvia) {
        // El adapter declara el campo: el lote DEBE colgar del turno pedido, aunque
        // esté conciliado. Es justo el caso que hoy deja ventas atrapadas en la
        // tablet (404 "no se encontró un turno abierto").
        t.is('cuelga del turno indicado, ya conciliado', catalog.turnoCerradoId, venta?.orderItem?.order?.shiftId);
      } else {
        // develop: el adapter no declara shiftId, así que Jackson lo descarta y BCB
        // resuelve el turno OPEN de ahora. Comportamiento correcto para este árbol.
        t.is(
          'el adapter aún no reenvía shiftId → cae al turno abierto',
          catalog.turnoAbiertoId,
          venta?.orderItem?.order?.shiftId,
          'esperado en develop; con feat/tcoffline-shift-id-passthrough debe colgar del turno pedido',
        );
      }
    },
  },

  {
    name: 't10-eventos-a-jetstream',
    label: 'los eventos de ventas/cancelaciones/recolecciones se encolan durables',
    async run(t) {
      const antes = await streamMessages(STREAM);
      // Ojo: estos endpoints usan `syncId` en camelCase, no `sync_id` como el de
      // sincronizaciones. Son contratos distintos aunque suenen igual.
      const syncId = randomUUID();

      const ventas = await post('/ventas', {
        syncId,
        ventas: [
          {
            id: randomUUID(),
            total: 120,
            ticketNumber: 'E2E-TCO-EV-1',
            invoiceCode: 'E2ETCOEV111111',
            issuedAt: new Date().toISOString(),
          },
        ],
      });
      t.is('POST /ventas responde 202', 202, ventas.status, ventas.text.slice(0, 200));

      const cancelaciones = await post('/cancelaciones', {
        syncId,
        cancelaciones: [{ id: randomUUID() }],
      });
      t.is('POST /cancelaciones responde 202', 202, cancelaciones.status, cancelaciones.text.slice(0, 200));

      const recolecciones = await post('/recolecciones', {
        syncId,
        recolecciones: [
          {
            id: randomUUID(),
            amount: 900.25,
            createdById: catalog.adminId,
            createdAt: new Date().toISOString(),
          },
        ],
      });
      t.is('POST /recolecciones responde 202', 202, recolecciones.status, recolecciones.text.slice(0, 200));

      // 202 solo se devuelve si llegó el PublishAck, pero eso lo afirma el adapter:
      // acá se comprueba contra el stream, que es la fuente de verdad.
      const llegaron = await until(
        async () => ((await streamMessages(STREAM)) >= antes + 3 ? true : undefined),
        { timeoutMs: 8000 },
      );
      t.assert(
        'los 3 eventos quedaron en TICKETCOLECTOROFFLINE_SYNC_STREAM',
        llegaron === true,
        `antes=${antes} ahora=${await streamMessages(STREAM)}`,
      );

      // Dedup por Nats-Msg-Id "<tipo>:<syncId>": reenviar el mismo lote no encola de
      // nuevo. Sin el prefijo de tipo, las cancelaciones del mismo syncId se
      // perderían — por eso se prueban los tres, no solo uno.
      const conDedup = await streamMessages(STREAM);
      await post('/ventas', {
        syncId,
        ventas: [
          {
            id: randomUUID(),
            total: 120,
            ticketNumber: 'E2E-TCO-EV-1',
            invoiceCode: 'E2ETCOEV111111',
            issuedAt: new Date().toISOString(),
          },
        ],
      });
      await sleep(1500);
      t.is('el reenvío del mismo syncId no encola otro', conDedup, await streamMessages(STREAM));
    },
  },

  {
    name: 't11-sin-token',
    label: 'sin Authorization el adapter corta en la puerta (401)',
    async run(t) {
      const res = await sincronizar(lote(tcoBatches.LOTE_OK), { token: null });
      t.is('responde 401', 401, res.status, res.text.slice(0, 200));
    },
  },

  {
    name: 't12-token-con-firma-invalida',
    label: 'un token firmado con otra llave no pasa el JWKS (401)',
    async run(t) {
      const res = await sincronizar(lote(tcoBatches.LOTE_OK), {
        token: advisorToken({ useWrongKey: true }),
      });
      // Prueba que el JWKS se está usando de verdad: si el adapter aceptara esto,
      // todos los demás casos estarían pasando sin validar nada.
      t.is('responde 401', 401, res.status, res.text.slice(0, 200));
    },
  },

  {
    name: 't13-propaga-el-400-de-bcb',
    label: 'lo que BCB rechaza llega como 400, no como 502',
    async run(t) {
      // El adapter declara passengerTypeId como String suelto, así que lo deja
      // pasar; BCB lo valida con @IsUUID('4') y responde 400. Ese status es el que
      // le dice a la tablet "no reintentes esto tal cual".
      const b = tcoBatches.CONFLICTO;
      const res = await sincronizar({
        sync_id: randomUUID(),
        orders: [orden({ ...b.orders[0]!, id: randomUUID() }, { passengerTypeId: 'no-es-uuid' })],
      });

      t.is('responde 400', 400, res.status, res.text.slice(0, 300));
    },
  },

  {
    name: 't14-propaga-el-404-de-bcb',
    label: 'un taquillero sin caja activa da 404, no 502',
    async run(t) {
      // advisorAjeno tiene turno pero NO tiene caja: resolveAdvisorContext corta con
      // 404. Es el caso real de una tablet configurada a medias, y confundirlo con
      // "satélite caído" manda a revisar el servidor equivocado.
      const res = await sincronizar(
        {
          sync_id: randomUUID(),
          orders: [orden({ ...tcoBatches.LOTE_OK.orders[0]!, id: randomUUID() })],
        },
        { token: advisorToken({ subject: catalog.advisorAjenoId }) },
      );

      t.is('responde 404', 404, res.status, res.text.slice(0, 300));
    },
  },

  {
    name: 't15-payload-invalido-en-la-puerta',
    label: 'el adapter rechaza el lote malformado sin molestar a BCB',
    async run(t) {
      // sync_id que no es uuid: Jackson no lo puede deserializar. Rechazar acá evita
      // gastar un request/reply y una transacción en BCB.
      const res = await sincronizar({
        sync_id: 'esto-no-es-un-uuid',
        orders: [orden({ ...tcoBatches.LOTE_OK.orders[0]!, id: randomUUID() })],
      });

      t.is('responde 400', 400, res.status, res.text.slice(0, 200));
    },
  },
];
