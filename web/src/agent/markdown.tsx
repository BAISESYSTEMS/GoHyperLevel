import type { ReactNode } from 'react';
import { BASE, navigate } from '../ui';

/**
 * Markdown for agent answers – React elements only, never raw HTML, so nothing a model (or text it
 * quotes from an e-mail) writes can run in the app. Supports headings, paragraphs, lists, tables,
 * code, quotes, **bold**, *italic*, `code` and links: internal links (/app/contacts/…, contacts/…)
 * open inside the app, http(s)/mailto in a new tab, everything else stays text.
 */

const INTERNAL = /^(?:\/app\/|\/)?([a-z0-9-]+(?:\/[A-Za-z0-9._~%-]+){0,4}(?:\?[A-Za-z0-9=&_.%+-]*)?)$/;

export function internalRoute(href: string): string | null {
  if (/^[a-z]+:/i.test(href) || href.startsWith('//')) return null;
  const m = href.match(INTERNAL);
  return m ? m[1] : null;
}

function inline(text: string, key: string, onNavigate?: () => void): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?])/g;
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<code key={k}>{t.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{inline(t.slice(2, -2), k, onNavigate)}</strong>);
    else if (m[3]) out.push(<em key={k}>{inline(t.slice(1, -1), k, onNavigate)}</em>);
    else if (m[5]) out.push(<a key={k} href={t} target="_blank" rel="noreferrer noopener">{t.replace(/^https?:\/\//, '').slice(0, 60)}</a>);
    else {
      const [, label, href] = t.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!;
      const route = internalRoute(href);
      if (route)
        out.push(
          <a
            key={k}
            href={`${BASE}/${route}`}
            className="agent-link"
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey) return;
              e.preventDefault();
              navigate(route);
              onNavigate?.();
            }}
          >
            {inline(label, k, onNavigate)}
          </a>,
        );
      else if (/^(https?:|mailto:)/i.test(href))
        out.push(
          <a key={k} href={href} target="_blank" rel="noreferrer noopener">
            {inline(label, k, onNavigate)}
          </a>,
        );
      else out.push(inline(label, k, onNavigate));
    }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function AgentMarkdown({ text, onNavigate }: { text: string; onNavigate?: () => void }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let n = 0;
  const key = () => `b${n++}`;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={key()} className="agent-code">
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const k = key();
      blocks.push(h[1].length <= 2 ? <h4 key={k}>{inline(h[2], k, onNavigate)}</h4> : <h5 key={k}>{inline(h[2], k, onNavigate)}</h5>);
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      const k = key();
      blocks.push(
        <div key={k} className="agent-table-wrap">
          <table className="agent-table">
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j}>{inline(c, `${k}h${j}`, onNavigate)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, j) => (
                    // Short cells (amounts, dates, statuses) stay on one line; long text wraps.
                    <td key={j} className={c.length <= 16 ? 'nw' : undefined}>
                      {inline(c, `${k}r${ri}c${j}`, onNavigate)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, ''));
      const k = key();
      const lis = items.map((it, j) => <li key={j}>{inline(it, `${k}-${j}`, onNavigate)}</li>);
      blocks.push(ordered ? <ol key={k}>{lis}</ol> : <ul key={k}>{lis}</ul>);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''));
      const k = key();
      blocks.push(<blockquote key={k}>{inline(q.join(' '), k, onNavigate)}</blockquote>);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|>\s?|\s*([-*•]|\d+[.)])\s+)/.test(lines[i]) && !/^\s*\|.*\|\s*$/.test(lines[i])) para.push(lines[i++]);
    const k = key();
    blocks.push(
      <p key={k}>
        {para.flatMap((p, j) => (j ? [<br key={`${k}br${j}`} />, ...inline(p, `${k}-${j}`, onNavigate)] : inline(p, `${k}-${j}`, onNavigate)))}
      </p>,
    );
  }
  return <div className="agent-md">{blocks}</div>;
}
