/**
 * Registro de cada llamada HTTP que hace el harness contra un satélite/adapter, para
 * que el panel pueda mostrar el body del request y el de la response sin tener que
 * reproducir el caso a mano ni leer el log del servicio (que ni siquiera loguea el
 * payload entrante completo).
 *
 * Un módulo aparte y no algo colgado del `Report`: los clientes HTTP (`SatelliteClient`
 * y los `post()` locales de cada flujo) no reciben el `Report` de la corrida, así que
 * necesitan una forma de anotar "esto pasó durante tal caso" sin que cada sitio de
 * llamada tenga que pasarlo como parámetro.
 */

export type HttpTraceEntry = {
  at: string;
  /** `null` cuando la llamada ocurrió fuera de un caso (p. ej. en `seed`). */
  case: string | null;
  method: string;
  url: string;
  /** Tal cual se mandaron, `Authorization` incluido — son credenciales de un solo uso local. */
  reqHeaders: Record<string, string>;
  reqBody: unknown;
  status: number;
  resBody: unknown;
};

let currentCase: string | null = null;
const entries: HttpTraceEntry[] = [];

/** Lo llama el runner de casos (`src/cli.ts`) al entrar y salir de cada caso. */
export function setCurrentCase(name: string | null): void {
  currentCase = name;
}

export function recordHttp(e: {
  method: string;
  url: string;
  reqHeaders: Record<string, string>;
  reqBody: unknown;
  status: number;
  resBody: unknown;
}): void {
  entries.push({ ...e, at: new Date().toISOString(), case: currentCase });
}

/** Todo lo registrado en ESTE proceso (una corrida de `cli.ts`). */
export function drainHttp(): HttpTraceEntry[] {
  return entries;
}
