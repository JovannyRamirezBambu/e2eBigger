import { useCallback, useEffect, useRef, useState } from 'react';
import { CaseList } from '@/components/CaseList';
import { Chain } from '@/components/Chain';
import { DbTable } from '@/components/DbTable';
import { Header } from '@/components/Header';
import { LogPanel } from '@/components/LogPanel';
import { getLogs, getState, runUrl, seedUrl, streamRun, type LogEntry, type PanelState } from '@/lib/api';

function initialFlow(): string {
  return new URLSearchParams(location.search).get('flow') || localStorage.getItem('e2e.flow') || '';
}

export default function App() {
  const [flow, setFlow] = useState(initialFlow);
  const [state, setState] = useState<PanelState | null>(null);
  const [busy, setBusy] = useState(false);
  const [runningCase, setRunningCase] = useState<string | null>(null);
  const [runLines, setRunLines] = useState<string[]>([]);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [logFilter, setLogFilter] = useState('all');
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const refreshState = useCallback(async () => {
    try {
      const data = await getState(flow);
      setState(data);
      document.title = `Panel E2E · ${data.flow}`;
      if (data.flow && data.flow !== flow) setFlow(data.flow);
    } catch {
      /* el backend puede estar reiniciando entre corridas */
    }
  }, [flow]);

  const refreshLog = useCallback(async () => {
    if (logFilter === 'run') return;
    try {
      setLogEntries(await getLogs(flow, logFilter));
    } catch {
      setLogEntries([]);
    }
  }, [flow, logFilter]);

  useEffect(() => {
    refreshState();
  }, [refreshState]);

  useEffect(() => {
    refreshLog();
  }, [refreshLog]);

  // Mientras hay una corrida en curso no se sondea: el estado va a cambiar de
  // todos modos al terminar, y sondear encima ensucia la lectura.
  useEffect(() => {
    const id = setInterval(() => {
      if (!busyRef.current) refreshState();
    }, 4000);
    return () => clearInterval(id);
  }, [refreshState]);

  const activeFlow = flow || state?.flow || '';

  const handleFlowChange = (next: string) => {
    setFlow(next);
    localStorage.setItem('e2e.flow', next);
    history.replaceState(null, '', `?flow=${encodeURIComponent(next)}`);
    setRunLines([]);
    setSelectedNode(null);
    setLogFilter('all');
  };

  const runStream = async (url: string, caseName?: string) => {
    setBusy(true);
    setRunningCase(caseName ?? null);
    setRunLines([]);
    setLogFilter('run');
    setSelectedNode(null);
    const lines: string[] = [];
    try {
      await streamRun(url, {
        onLine: (line) => {
          lines.push(line);
          setRunLines([...lines]);
        },
      });
    } finally {
      setBusy(false);
      setRunningCase(null);
      refreshState();
    }
  };

  const handleNodeSelect = (id: string | null) => {
    setSelectedNode(id);
    setLogFilter(id ?? 'run');
  };

  const handleFilterChange = (v: string) => {
    setLogFilter(v);
    setSelectedNode((state?.services ?? []).includes(v) ? v : null);
  };

  if (!state) {
    return <div className="mx-auto max-w-[1320px] px-5 py-10 text-sm text-muted-foreground">Cargando…</div>;
  }

  return (
    <div className="mx-auto max-w-[1320px] px-5 pb-16">
      <Header
        flows={state.flows}
        flow={activeFlow}
        state={state}
        busy={busy}
        onFlowChange={handleFlowChange}
        onSeed={() => runStream(seedUrl(activeFlow))}
        onRunAll={() => runStream(runUrl(activeFlow))}
      />
      <Chain nodes={state.nodes} services={state.services} selected={selectedNode} onSelect={handleNodeSelect} />
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(340px,1fr)_minmax(420px,1.25fr)]">
        <CaseList
          cases={state.cases}
          results={state.results}
          traffic={state.traffic}
          busy={busy}
          runningCase={runningCase}
          onRunCase={(name) => runStream(runUrl(activeFlow, name), name)}
        />
        <LogPanel
          services={state.services}
          filter={logFilter}
          onFilterChange={handleFilterChange}
          runLines={runLines}
          logEntries={logEntries}
        />
      </div>
      <DbTable rows={state.db} />
      <footer className="mt-6 text-[11.5px] text-muted-foreground">
        Solo lectura y ejecución de casos. Levantar o bajar el stack, y recrear la base, se hacen desde el CLI:{' '}
        <code className="font-mono text-[11px]">./e2e up tomtom</code> ·{' '}
        <code className="font-mono text-[11px]">./e2e down tomtom</code> ·{' '}
        <code className="font-mono text-[11px]">./e2e psql tomtom</code>
      </footer>
    </div>
  );
}
