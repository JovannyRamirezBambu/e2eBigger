import type { LogEntry } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

function classifyRunLine(line: string): string {
  if (/^PASS /.test(line)) return 'text-success';
  if (/^FAIL /.test(line)) return 'text-destructive font-semibold';
  if (/^✗|falló|error/i.test(line)) return 'text-destructive';
  return 'text-foreground';
}

const levelColor = (level: string) =>
  level === 'ERROR' ? 'text-destructive' : level === 'WARN' ? 'text-warning' : 'text-foreground';

export function LogPanel({
  services,
  filter,
  onFilterChange,
  runLines,
  logEntries,
}: {
  services: string[];
  filter: string;
  onFilterChange: (v: string) => void;
  runLines: string[];
  logEntries: LogEntry[];
}) {
  const options = [
    { v: 'all', t: 'Todos los servicios' },
    { v: 'run', t: 'Salida de la corrida' },
    ...services.map((s) => ({ v: s, t: s })),
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex-1">Log</CardTitle>
        <Select value={filter} onValueChange={onFilterChange}>
          <SelectTrigger className="font-mono">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.v} value={o.v}>
                {o.t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent>
        <ScrollArea className="max-h-[min(72vh,760px)]">
          {filter === 'run' ? (
            runLines.length ? (
              <div className="py-2">
                {runLines.map((l, i) => (
                  <div key={i} className={cn('whitespace-pre-wrap break-words px-3.5 py-px font-mono text-[11.5px]', classifyRunLine(l))}>
                    {l}
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-6 text-center text-xs text-muted-foreground">Corré algo para ver la salida acá.</div>
            )
          ) : logEntries.length ? (
            <div className="py-2">
              {logEntries.map((e, i) => (
                <div key={i} className="flex gap-2 px-3.5 py-px font-mono text-[11.5px] hover:bg-muted/60">
                  <span className="w-[60px] flex-none text-muted-foreground">{e.ts}</span>
                  <span className="w-[104px] flex-none text-primary">{e.service}</span>
                  <span className={cn('min-w-0 flex-1 whitespace-pre-wrap break-words', levelColor(e.level))}>{e.msg}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-6 text-center text-xs text-muted-foreground">Sin líneas todavía.</div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
