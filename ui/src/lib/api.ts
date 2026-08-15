/**
 * Cliente tipado de la API de `ui/server.js`. El contrato no cambió al migrar el
 * frontend: mismos endpoints, mismas formas — server.js sigue siendo el único que
 * ejecuta `./e2e`.
 */

export type ChainNode = {
  id: string;
  label: string;
  sub: string;
  up: boolean | null;
  note?: string;
  error?: string;
  metrics?: Record<string, number>;
};

export type FlowInfo = { name: string; description: string };
export type CaseInfo = { name: string; label: string };

export type HttpTraceEntry = {
  at: string;
  case: string | null;
  method: string;
  url: string;
  reqHeaders?: Record<string, string>;
  reqBody: unknown;
  status: number;
  resBody: unknown;
};

export type PanelState = {
  flow: string;
  flows: FlowInfo[];
  services: string[];
  cases: CaseInfo[];
  nodes: ChainNode[];
  db: Record<string, unknown>[];
  results: { cases?: Record<string, 'ok' | 'fail'>; lastRun?: { pass: number; fail: number; cases: number } };
  traffic: HttpTraceEntry[];
  dlq?: number;
  escenarios?: number;
  ts: number;
};

export type LogEntry = { ts: string; level: string; msg: string; logger: string; service?: string };

const qs = (flow: string, extra?: Record<string, string>) => {
  const p = new URLSearchParams({ flow, ...extra });
  return `?${p.toString()}`;
};

export async function getFlows(): Promise<FlowInfo[]> {
  const res = await fetch('/api/flows');
  return res.json();
}

export async function getState(flow: string): Promise<PanelState> {
  const res = await fetch(`/api/state${qs(flow)}`);
  return res.json();
}

export async function getLogs(flow: string, service: string): Promise<LogEntry[]> {
  const res = await fetch(`/api/logs${qs(flow, { service })}`);
  return res.json();
}

export type StreamHandlers = { onLine: (line: string) => void; onDone?: (code: number) => void };

/** Consume el SSE de /api/run o /api/seed línea por línea, hasta el evento `done`. */
export async function streamRun(url: string, { onLine, onDone }: StreamHandlers): Promise<void> {
  const res = await fetch(url, { method: 'POST' });
  if (!res.ok || !res.body) {
    onLine(`no se pudo iniciar: ${res.status}`);
    onDone?.(-1);
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const frame of frames) {
      const ev = /^event: (.+)$/m.exec(frame)?.[1] ?? '';
      const dataMatch = /^data: (.*)$/m.exec(frame);
      if (!dataMatch) continue;
      const data = JSON.parse(dataMatch[1]!);
      if (ev === 'line') onLine(data as string);
      else if (ev === 'done') onDone?.((data as { code: number }).code);
    }
  }
}

export const runUrl = (flow: string, caseName?: string) => `/api/run${qs(flow, caseName ? { case: caseName } : undefined)}`;
export const seedUrl = (flow: string) => `/api/seed${qs(flow)}`;
