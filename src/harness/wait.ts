/** Esperas para los saltos asíncronos (NATS) — con timeout, nunca infinitas. */

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Repite `probe` hasta que devuelva algo distinto de undefined/null.
 * Devuelve `undefined` si se agotó el tiempo.
 */
export async function until<T>(
  probe: () => Promise<T | null | undefined>,
  { timeoutMs = 30_000, everyMs = 500 } = {},
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v !== null && v !== undefined) return v;
    if (Date.now() >= deadline) return undefined;
    await sleep(everyMs);
  }
}

/** Espera a que `probe` sea exactamente `expected` (comparación por string). */
export async function untilEquals<T>(
  probe: () => Promise<T | null | undefined>,
  expected: T,
  opts?: { timeoutMs?: number; everyMs?: number },
): Promise<{ ok: boolean; last: T | null | undefined }> {
  let last: T | null | undefined;
  const found = await until(async () => {
    last = await probe();
    return last !== null && last !== undefined && String(last) === String(expected) ? last : undefined;
  }, opts);
  return { ok: found !== undefined, last };
}

/** Fecha ISO con offset Z, que es lo que exigen los DTOs de geocerca. */
export const isoUtc = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, '.000Z');

/** Formato de Postgres `to_char(col,'YYYY-MM-DD HH24:MI:SS')`, para comparar. */
export function pgTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
