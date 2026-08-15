import { RotateCcw, Play } from 'lucide-react';
import type { FlowInfo, PanelState } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

function Summary({ results, total }: { results: PanelState['results']; total: number }) {
  const cases = results.cases ?? {};
  const vals = Object.values(cases);
  if (!vals.length) return <span className="text-xs text-muted-foreground">sin correr todavía</span>;
  const ok = vals.filter((v) => v === 'ok').length;
  const fail = vals.filter((v) => v === 'fail').length;
  const pending = Math.max(0, total - ok - fail);
  return (
    <div className="flex items-baseline gap-2 tabular-nums">
      <span className="text-[22px] font-bold text-success">{ok}</span>
      <span className="text-xs text-muted-foreground">ok</span>
      {fail > 0 && (
        <>
          <span className="text-[22px] font-bold text-destructive">{fail}</span>
          <span className="text-xs text-muted-foreground">fail</span>
        </>
      )}
      {pending > 0 && <span className="text-xs text-muted-foreground">· {pending} sin correr</span>}
    </div>
  );
}

export function Header({
  flows,
  flow,
  state,
  busy,
  onFlowChange,
  onSeed,
  onRunAll,
}: {
  flows: FlowInfo[];
  flow: string;
  state: PanelState | null;
  busy: boolean;
  onFlowChange: (flow: string) => void;
  onSeed: () => void;
  onRunAll: () => void;
}) {
  const desc = flows.find((f) => f.name === flow)?.description ?? '';
  return (
    <header className="flex flex-wrap items-center gap-4 border-b py-5">
      <h1 className="text-[17px] font-bold tracking-tight">Panel E2E</h1>
      <Select value={flow} onValueChange={onFlowChange}>
        <SelectTrigger className="font-mono">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {flows.map((f) => (
            <SelectItem key={f.name} value={f.name} className="font-mono">
              {f.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="hidden max-w-[46ch] text-xs text-muted-foreground md:inline">{desc}</span>
      <div className="flex-1" />
      <Summary results={state?.results ?? {}} total={state?.cases.length ?? 0} />
      <Button variant="outline" size="sm" disabled={busy} onClick={onSeed}>
        <RotateCcw className="h-3.5 w-3.5" /> Resembrar
      </Button>
      <Button size="sm" disabled={busy} onClick={onRunAll}>
        <Play className="h-3.5 w-3.5" /> Correr todo
      </Button>
    </header>
  );
}
