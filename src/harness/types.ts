/**
 * Contrato que implementa cada flujo. Lo consumen el CLI y el panel por igual,
 * así que agregar un flujo nunca obliga a tocar ninguno de los dos.
 */
import type { Report } from './report';

/** Un nodo de la cadena, tal como lo dibuja el panel. */
export type ChainNode = {
  id: string;
  label: string;
  sub: string;
  /** true arriba, false abajo, null = no aplica (p. ej. algo que se invoca por script). */
  up: boolean | null;
  note?: string;
  error?: string;
  metrics?: Record<string, number>;
};

export type Probe = {
  flow: string;
  nodes: ChainNode[];
  /** Métricas de cabecera; el panel las muestra tal cual. */
  dlq?: number;
  escenarios?: number;
};

export type CaseDef = {
  /** Identificador estable: es lo que se pasa a `./e2e test <flujo> <name>`. */
  name: string;
  /** Etiqueta legible para alguien que no conoce el código. */
  label: string;
  run: (t: Report) => Promise<void>;
};

export type Flow = {
  name: string;
  description: string;
  cases: CaseDef[];
  /** Datos de prueba. Debe ser idempotente: se corre N veces. */
  seed: () => Promise<void>;
  probe: () => Promise<Probe>;
  /** Filas para el panel y para `./e2e verify`. */
  dbSnapshot: () => Promise<Record<string, unknown>[]>;
  /**
   * Se llama antes de los casos. Para lo que solo debe existir durante las
   * pruebas — p. ej. el SmartMac falso de Venta a Bordo, que no tiene sentido
   * dejar corriendo entre corridas.
   */
  beforeCases?: () => Promise<void>;
  /** Se llama siempre al terminar, pase lo que pase. */
  close?: () => Promise<void>;
  /**
   * Token para pegarle a mano al satélite (Bruno, curl, el navegador). Lo firma el
   * flujo con sus propias llaves de `run/keys/`, las mismas que usan las pruebas.
   * Solo local: esas llaves no existen en ningún ambiente real.
   */
  adminToken?: (expiraEnSegundos?: number) => string;
};
