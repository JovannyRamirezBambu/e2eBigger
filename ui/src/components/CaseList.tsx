import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import type { CaseInfo, HttpTraceEntry, PanelState } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { HttpTraceModal } from '@/components/HttpTraceModal';
import { methodColor } from '@/lib/format';
import { cn } from '@/lib/utils';

function CallRow({ entry, onOpen }: { entry: HttpTraceEntry; onOpen: () => void }) {
  const ok = entry.status >= 200 && entry.status < 300;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="flex cursor-pointer items-center gap-2.5 rounded-md border bg-card px-2.5 py-1.5 hover:border-primary"
    >
      <Badge variant="solid" solidColor={methodColor(entry.method)}>
        {entry.method}
      </Badge>
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground" title={entry.url}>
        {entry.url}
      </span>
      <span className={cn('font-mono text-[11.5px] font-bold', ok ? 'text-success' : 'text-destructive')}>{entry.status}</span>
      <ChevronRight className="h-3.5 w-3.5 flex-none text-muted-foreground" />
    </div>
  );
}

export function CaseList({
  cases,
  results,
  traffic,
  busy,
  runningCase,
  onRunCase,
}: {
  cases: CaseInfo[];
  results: PanelState['results'];
  traffic: HttpTraceEntry[];
  busy: boolean;
  runningCase: string | null;
  onRunCase: (name: string) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [openEntry, setOpenEntry] = useState<HttpTraceEntry | null>(null);
  const byCase = results.cases ?? {};

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex-1">Casos</CardTitle>
        <span className="font-mono text-[11px] text-muted-foreground">{cases.length} casos</span>
      </CardHeader>
      <CardContent>
        <ScrollArea className="max-h-[min(72vh,760px)]">
          <ul>
            {cases.map((c) => {
              const r = byCase[c.name];
              const calls = traffic.filter((e) => e.case === c.name);
              const open = expanded === c.name;
              return (
                <li key={c.name} className="border-b last:border-0">
                  <div
                    className={cn(
                      'flex cursor-pointer items-center gap-2.5 px-3.5 py-2 hover:bg-muted/60',
                      runningCase === c.name && 'bg-accent hover:bg-accent',
                    )}
                    onClick={() => setExpanded(open ? null : c.name)}
                  >
                    <Badge variant={r === 'ok' ? 'ok' : r === 'fail' ? 'fail' : 'neutral'}>
                      {r === 'ok' ? 'PASS' : r === 'fail' ? 'FAIL' : '—'}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px]">{c.label}</div>
                      <div className="truncate font-mono text-[10.5px] text-muted-foreground">{c.name}</div>
                    </div>
                    {calls.length > 0 && <span className="font-mono text-[10.5px] text-muted-foreground">{calls.length} req</span>}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      title="Correr solo este caso"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRunCase(c.name);
                      }}
                    >
                      correr
                    </Button>
                  </div>
                  {open && (
                    <div className="flex flex-col gap-1.5 bg-muted/40 px-3.5 pb-3 pt-1">
                      {calls.length === 0 ? (
                        <div className="py-4 text-center text-xs text-muted-foreground">
                          Sin llamadas HTTP registradas — corré el caso para verlas.
                        </div>
                      ) : (
                        calls.map((entry, i) => <CallRow key={i} entry={entry} onOpen={() => setOpenEntry(entry)} />)
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      </CardContent>
      <HttpTraceModal entry={openEntry} onOpenChange={(v) => !v && setOpenEntry(null)} />
    </Card>
  );
}
