import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableHead, TableRow, TableTd, TableTh } from '@/components/ui/table';
import { cn } from '@/lib/utils';

const TAG_STYLE: Record<string, string> = {
  ON_TRIP: 'bg-warning/15 text-warning',
  DISPATCHED: 'bg-warning/15 text-warning',
  CONFIRMED: 'bg-success/15 text-success',
  FINISHED: 'bg-success/15 text-success',
  ACTIVE: 'bg-success/15 text-success',
  AVAILABLE: 'bg-success/15 text-success',
  CANCELLED: 'bg-destructive/15 text-destructive',
  CANCELLED_BY_GROUP: 'bg-destructive/15 text-destructive',
};

const HEADS: Record<string, string> = {
  esc: 'esc',
  corrida: 'corrida',
  despacho_admin: 'despacho admin',
  salida_real: 'salida real',
  llegada_real: 'llegada real',
  tarjeta: 'tarjeta',
  bus: 'bus',
  bus_en: 'bus en',
  operador: 'operador',
};

export function DbTable({ rows }: { rows: Record<string, unknown>[] }) {
  const cols = rows.length ? Object.keys(rows[0]!) : [];
  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="flex-1">Estado en la base de BCB</CardTitle>
        <span className="text-[11px] text-muted-foreground">se refresca solo</span>
      </CardHeader>
      <CardContent>
        {!rows.length ? (
          <div className="py-6 text-center text-xs text-muted-foreground">Sin escenarios sembrados.</div>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                {cols.map((c) => (
                  <TableTh key={c}>{HEADS[c] ?? c}</TableTh>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={i}>
                  {cols.map((c) => {
                    const v = r[c];
                    if (v === null || v === undefined || v === '') return <TableTd key={c} className="text-muted-foreground">—</TableTd>;
                    const style = TAG_STYLE[String(v)];
                    return (
                      <TableTd key={c} className="font-mono">
                        {style ? (
                          <span className={cn('rounded px-1.5 py-0.5 font-sans text-[10.5px] font-bold', style)}>{String(v)}</span>
                        ) : (
                          String(v)
                        )}
                      </TableTd>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
