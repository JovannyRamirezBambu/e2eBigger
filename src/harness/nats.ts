/**
 * JetStream de verdad, no el endpoint de monitoreo.
 *
 * Con el monitor HTTP solo se puede ver un CONTADOR de la DLQ. Con un cliente
 * real se puede leer el CONTENIDO y sus headers (`x-dlq-reason`,
 * `x-origin-subject`, `x-error-detail`), que es lo único que responde la pregunta
 * que importa cuando algo se descarta: por qué.
 */
import { connect, nkeyAuthenticator, type NatsConnection, headers as natsHeaders } from 'nats';

const MONITOR = process.env.E2E_NATS_MONITOR ?? 'http://localhost:8222';
const SERVERS = (process.env.E2E_NATS_URL ?? 'nats://localhost:4222').split(',');

export type StreamState = { name: string; messages: number; subjects: string[] };

/** Vía monitor HTTP: no necesita credenciales NKEY, sirve para el panel. */
export async function streamStates(): Promise<StreamState[]> {
  try {
    const res = await fetch(`${MONITOR}/jsz?streams=true`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      account_details?: { stream_detail?: { name: string; state: { messages: number }; config?: { subjects?: string[] } }[] }[];
    };
    return (data.account_details ?? []).flatMap((acc) =>
      (acc.stream_detail ?? []).map((s) => ({
        name: s.name,
        messages: s.state.messages,
        subjects: s.config?.subjects ?? [],
      })),
    );
  } catch {
    return [];
  }
}

export async function streamMessages(name: string): Promise<number> {
  return (await streamStates()).find((s) => s.name === name)?.messages ?? 0;
}

export async function natsUp(): Promise<boolean> {
  try {
    const res = await fetch(`${MONITOR}/healthz?js-server-only=true`, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

export type DlqEntry = {
  seq: number;
  subject: string;
  reason: string;
  originSubject: string;
  detail: string;
  payload: unknown;
  at: string;
};

/**
 * Lee los mensajes de una DLQ sin consumirlos (direct get por secuencia), así
 * que se puede inspeccionar cuantas veces se quiera sin alterar el stream.
 */
/**
 * NUNCA devuelve [] para ocultar un fallo.
 *
 * La primera versión atrapaba cualquier error y devolvía lista vacía, así que una
 * DLQ con 21 mensajes se reportaba como "0 mensajes" cuando la conexión fallaba
 * por falta de NKEY. Un harness que calla un fallo es peor que no tenerlo: se lee
 * como "todo bien". Ahora el error sale explícito y quien llama decide.
 */
export async function readDlq(streamName: string, max = 20): Promise<DlqEntry[]> {
  let nc: NatsConnection | undefined;
  try {
    nc = await connect({
      servers: SERVERS,
      timeout: 3000,
      maxReconnectAttempts: 1,
      // NATS local exige NKEY (ver docker/nats/accounts.conf). Sin seed no hay
      // lectura posible, y hay que decirlo, no devolver vacío.
      ...(process.env.E2E_NATS_NKEY_SEED
        ? { authenticator: nkeyAuthenticator(new TextEncoder().encode(process.env.E2E_NATS_NKEY_SEED)) }
        : {}),
    });
    const js = await nc.jetstreamManager();
    const info = await js.streams.info(streamName);
    const last = info.state.last_seq;
    const first = info.state.first_seq;
    if (!last || last < first) return [];

    const sm = await nc.jetstream().streams.get(streamName);
    const out: DlqEntry[] = [];
    for (let seq = last; seq >= first && out.length < max; seq--) {
      try {
        const msg = await sm.getMessage({ seq });
        if (!msg) continue;
        const h = msg.header;
        let payload: unknown = msg.string();
        try {
          payload = msg.json();
        } catch {
          /* payload no-JSON */
        }
        out.push({
          seq,
          subject: msg.subject,
          reason: h?.get('x-dlq-reason') ?? '',
          originSubject: h?.get('x-origin-subject') ?? '',
          detail: h?.get('x-error-detail') ?? '',
          payload,
          at: msg.time?.toISOString() ?? '',
        });
      } catch {
        /* secuencia purgada o ilegible: se salta */
      }
    }
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `no se pudo leer la DLQ '${streamName}': ${msg}. ` +
        'NATS local exige NKEY: exportá E2E_NATS_NKEY_SEED (ver BIGER_EstrellaRoja_Main/.env). ' +
        'El contador del monitor HTTP sí funciona sin credenciales.',
    );
  } finally {
    await nc?.drain().catch(() => undefined);
  }
}

/** Solo para pruebas del transporte en sí; los flujos publican por sus adapters. */
export async function publishRaw(subject: string, data: unknown, msgId?: string): Promise<boolean> {
  let nc: NatsConnection | undefined;
  try {
    nc = await connect({ servers: SERVERS, timeout: 3000, maxReconnectAttempts: 1 });
    const h = natsHeaders();
    if (msgId) h.set('Nats-Msg-Id', msgId);
    await nc.jetstream().publish(subject, Buffer.from(JSON.stringify(data)), { headers: h });
    return true;
  } catch {
    return false;
  } finally {
    await nc?.drain().catch(() => undefined);
  }
}
