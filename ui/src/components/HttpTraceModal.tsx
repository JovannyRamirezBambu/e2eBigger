import { useState } from 'react';
import type { HttpTraceEntry } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogHeader } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { JsonView } from '@/components/JsonView';
import { bodyAsText, buildCurl, describeAuth, methodColor } from '@/lib/format';
import { cn } from '@/lib/utils';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-6 px-2 text-[10px] font-semibold normal-case tracking-normal"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? 'copiado' : 'copiar'}
    </Button>
  );
}

function CodeBlock({ value }: { value: unknown }) {
  const empty = value === null || value === undefined || value === '';
  return (
    <div className="rounded-lg border bg-muted/60 p-3 font-mono text-[11.5px] leading-relaxed">
      {empty ? <span className="text-muted-foreground">—</span> : <pre className="whitespace-pre-wrap break-words"><JsonView value={value} /></pre>}
    </div>
  );
}

function AuthDetail({ value }: { value: string }) {
  const auth = describeAuth(value);
  if (auth.scheme === 'Bearer' && auth.jwt) {
    return (
      <div className="mt-1.5 rounded-md border border-dashed p-2 text-[11px]">
        <div className="mb-1 text-[9.5px] font-bold uppercase tracking-wide text-muted-foreground">
          JWT decodificado (sin verificar firma — panel local)
        </div>
        <pre className="mb-1.5 whitespace-pre-wrap break-words font-mono">
          <JsonView value={auth.jwt.header} />
        </pre>
        <pre className="whitespace-pre-wrap break-words font-mono">
          <JsonView value={auth.jwt.payload} />
        </pre>
      </div>
    );
  }
  if (auth.scheme === 'Basic') {
    return (
      <div className="mt-1.5 rounded-md border border-dashed p-2 text-[11px]">
        <div className="mb-1 text-[9.5px] font-bold uppercase tracking-wide text-muted-foreground">Basic decodificado</div>
        <div className="font-mono">usuario: {auth.user}</div>
        <div className="font-mono">contraseña: {auth.pass}</div>
      </div>
    );
  }
  return null;
}

function HeadersTable({ headers }: { headers?: Record<string, string> }) {
  const rows = Object.entries(headers ?? {});
  if (!rows.length) return <div className="py-3 text-center text-xs text-muted-foreground">Sin headers registrados.</div>;
  return (
    <div className="rounded-lg border">
      <table className="w-full text-[11.5px]">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k} className="border-b align-top last:border-0">
              <td className="whitespace-nowrap px-3 py-2 font-mono text-muted-foreground">{k}</td>
              <td className="break-all px-3 py-2 font-mono">
                {v}
                {/^authorization$/i.test(k) && <AuthDetail value={v} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function HttpTraceModal({ entry, onOpenChange }: { entry: HttpTraceEntry | null; onOpenChange: (open: boolean) => void }) {
  const ok = entry ? entry.status >= 200 && entry.status < 300 : true;
  return (
    <Dialog open={entry !== null} onOpenChange={onOpenChange}>
      {entry && (
        <DialogContent>
          <DialogHeader>
            <Badge variant="solid" solidColor={methodColor(entry.method)}>
              {entry.method}
            </Badge>
            <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-muted-foreground" title={entry.url}>
              {entry.url}
            </span>
            <span className={cn('font-mono text-[12.5px] font-bold', ok ? 'text-success' : 'text-destructive')}>{entry.status}</span>
          </DialogHeader>
          <DialogBody>
            <div className="text-xs text-muted-foreground">
              <span className="font-mono">{entry.case ?? '—'}</span> · {new Date(entry.at).toLocaleString()}
            </div>
            <Tabs defaultValue="headers">
              <TabsList>
                <TabsTrigger value="headers">Headers</TabsTrigger>
                <TabsTrigger value="request">Request</TabsTrigger>
                <TabsTrigger value="response">Response</TabsTrigger>
                <TabsTrigger value="curl">curl</TabsTrigger>
              </TabsList>
              <TabsContent value="headers">
                <HeadersTable headers={entry.reqHeaders} />
              </TabsContent>
              <TabsContent value="request">
                <div className="mb-1.5 flex justify-end">
                  <CopyButton text={bodyAsText(entry.reqBody)} />
                </div>
                <CodeBlock value={entry.reqBody} />
              </TabsContent>
              <TabsContent value="response">
                <div className="mb-1.5 flex justify-end">
                  <CopyButton text={bodyAsText(entry.resBody)} />
                </div>
                <CodeBlock value={entry.resBody} />
              </TabsContent>
              <TabsContent value="curl">
                <div className="mb-1.5 flex justify-end">
                  <CopyButton text={buildCurl(entry)} />
                </div>
                <pre className="overflow-x-auto rounded-lg border bg-muted/60 p-3 font-mono text-[11.5px] leading-relaxed">
                  {buildCurl(entry)}
                </pre>
              </TabsContent>
            </Tabs>
          </DialogBody>
        </DialogContent>
      )}
    </Dialog>
  );
}
