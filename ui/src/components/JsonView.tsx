import { Fragment, type ReactNode } from 'react';
import { bodyAsText } from '@/lib/format';

const TOKEN =
  /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false)\b|null|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g;

function tokenClass(tok: string): string {
  if (tok.startsWith('"')) return /:$/.test(tok) ? 'text-primary' : 'text-success';
  if (tok === 'true' || tok === 'false' || tok === 'null') return 'text-destructive';
  return 'text-warning';
}

/**
 * JSON resaltado por tipo de token (clave, string, número, booleano/null). Arma
 * nodos de React en vez de HTML crudo — nada de `dangerouslySetInnerHTML`, React
 * ya escapa el texto de cada segmento.
 */
export function JsonView({ value }: { value: unknown }) {
  const text = bodyAsText(value);
  if (!text) return <span className="text-muted-foreground">—</span>;
  if (typeof value === 'string') return <>{text}</>;

  const nodes: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(text))) {
    if (m.index > last) nodes.push(<Fragment key={key++}>{text.slice(last, m.index)}</Fragment>);
    nodes.push(
      <span key={key++} className={tokenClass(m[0])}>
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(<Fragment key={key++}>{text.slice(last)}</Fragment>);
  return <>{nodes}</>;
}
