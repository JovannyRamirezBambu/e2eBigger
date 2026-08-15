import { Fragment } from 'react';
import type { ChainNode } from '@/lib/api';
import { cn } from '@/lib/utils';

function Dot({ up }: { up: boolean | null }) {
  return (
    <span
      className={cn(
        'inline-block h-2 w-2 flex-none rounded-full',
        up === true ? 'bg-success' : up === false ? 'bg-destructive' : 'bg-muted-foreground/50',
      )}
    />
  );
}

export function Chain({
  nodes,
  services,
  selected,
  onSelect,
}: {
  nodes: ChainNode[];
  services: string[];
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <section className="mb-6">
      <div className="mb-2.5 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
        Cadena — clic en un nodo para filtrar su log
      </div>
      <div className="overflow-x-auto pb-1">
        <div className="flex min-w-[940px] items-stretch">
          {nodes.map((n, i) => {
            const clickable = services.includes(n.id);
            const isSel = selected === n.id;
            const body = (
              <div
                className={cn(
                  'min-w-[158px] flex-1 rounded-[9px] border bg-card p-3 text-left shadow-sm transition-colors',
                  n.up === false && 'border-destructive',
                  isSel && 'border-primary ring-1 ring-primary',
                  clickable && 'cursor-pointer hover:border-muted-foreground/40',
                )}
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
                onClick={clickable ? () => onSelect(isSel ? null : n.id) : undefined}
                onKeyDown={
                  clickable
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onSelect(isSel ? null : n.id);
                        }
                      }
                    : undefined
                }
              >
                <div className="flex items-center gap-1.5">
                  <Dot up={n.up} />
                  <span className="text-[13px] font-bold">{n.label}</span>
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">{n.sub}</div>
                {n.note && n.up === null && <div className="mt-0.5 text-[11px] text-muted-foreground">{n.note}</div>}
                {n.metrics && (
                  <div className="mt-2 flex gap-3">
                    {Object.entries(n.metrics).map(([k, v]) => (
                      <div key={k} className="text-[11px] text-muted-foreground">
                        <b className={cn('block text-sm tabular-nums text-foreground', k === 'DLQ' && v > 0 && 'text-destructive')}>
                          {v}
                        </b>
                        {k}
                      </div>
                    ))}
                  </div>
                )}
                {n.error && (
                  <div className="mt-2 max-h-11 overflow-hidden rounded bg-destructive/10 p-1.5 text-[10.5px] leading-tight text-destructive">
                    {n.error}
                  </div>
                )}
              </div>
            );
            return (
              <Fragment key={n.id}>
                {i > 0 && <div className="flex w-[30px] flex-none items-center justify-center text-muted-foreground">→</div>}
                {body}
              </Fragment>
            );
          })}
        </div>
      </div>
    </section>
  );
}
