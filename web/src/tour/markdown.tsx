import type { ReactNode } from 'react';
import { navigate } from '../ui';
import { slug } from './slug';

/**
 * Small Markdown renderer for the docs and the handbook (headings with anchors, paragraphs, lists,
 * tables, code, quotes, links). Builds React elements – never raw HTML – so nothing in a document
 * can run in the app. Links to other `.md` files open inside the academy.
 */

/** `docs/x.md#y`, `x.md`, `../README.md` → in-app route; everything else unchanged. */
export function docHref(href: string): { internal: string } | { external: string } | { anchor: string } {
  if (href.startsWith('#')) return { anchor: href.slice(1) };
  const m = href.match(/^(?:\.{1,2}\/)*(?:docs\/)?([A-Za-z0-9-]+)\.md(#.*)?$/);
  if (m) return { internal: `academy/docs/${m[1]}${m[2] ?? ''}` };
  return { external: href };
}

function inline(text: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<code key={k}>{t.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{inline(t.slice(2, -2), i)}</strong>);
    else if (m[3]) out.push(<em key={k}>{inline(t.slice(1, -1), i)}</em>);
    else {
      const [, label, href] = t.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!;
      const target = docHref(href);
      if ('internal' in target)
        out.push(
          <a key={k} href={`/app/${target.internal}`} onClick={(e) => (e.preventDefault(), navigate(target.internal), window.scrollTo(0, 0))}>
            {inline(label, i)}
          </a>,
        );
      else if ('anchor' in target)
        out.push(
          <a key={k} href={`#${target.anchor}`} onClick={(e) => (e.preventDefault(), document.getElementById(target.anchor)?.scrollIntoView({ behavior: 'smooth' }))}>
            {inline(label, i)}
          </a>,
        );
      else if (/^(https?:|mailto:)/i.test(target.external))
        out.push(
          <a key={k} href={target.external} target="_blank" rel="noreferrer">
            {inline(label, i)}
          </a>,
        );
      else out.push(inline(label, i));
    }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    // fenced code
    if (line.startsWith('```')) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={k++} className="md-code">
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const content = h[2].replace(/\s+#+\s*$/, '');
      const id = slug(content);
      const Tag = (`h${Math.min(level + 1, 5)}` as 'h2');
      blocks.push(
        <Tag key={k++} id={id} className={`md-h md-h${level}`}>
          {inline(content)}
        </Tag>,
      );
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push(<hr key={k++} />);
      i++;
      continue;
    }
    // table
    if (line.trim().startsWith('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]));
      blocks.push(
        <div key={k++} className="table-wrap md-table">
          <table className="t">
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j}>{inline(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, j) => (
                <tr key={j}>
                  {r.map((c, n) => (
                    <td key={n}>{inline(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (line.startsWith('>')) {
      const body: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) body.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push(
        <blockquote key={k++} className="md-quote">
          {inline(body.join(' '))}
        </blockquote>,
      );
      continue;
    }
    // lists (one level of nesting by indentation)
    const li = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const start = ordered ? parseInt(li[2], 10) : 1;
      const items: { text: string; sub: string[] }[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
        if (m && m[1].length < 2) items.push({ text: m[3], sub: [] });
        else if (m && items.length) items[items.length - 1].sub.push(m[3]);
        else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) items[items.length - 1].text += ` ${lines[i].trim()}`;
        else break;
        i++;
      }
      const L = ordered ? 'ol' : 'ul';
      blocks.push(
        <L key={k++} className="md-list" start={ordered && start !== 1 ? start : undefined}>
          {items.map((it, j) => (
            <li key={j}>
              {inline(it.text.replace(/^\[( |x)\]\s*/, (_m, x) => (x === 'x' ? '☑ ' : '☐ ')))}
              {it.sub.length > 0 && (
                <ul>
                  {it.sub.map((s, n) => (
                    <li key={n}>{inline(s.replace(/^\[( |x)\]\s*/, (_m, x) => (x === 'x' ? '☑ ' : '☐ ')))}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </L>,
      );
      continue;
    }
    // paragraph
    const body: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|>|\s*([-*]|\d+\.)\s|\|)/.test(lines[i])) body.push(lines[i++].trim());
    if (!body.length) body.push(lines[i++].trim());
    blocks.push(<p key={k++}>{inline(body.join(' '))}</p>);
  }
  return <div className="md">{blocks}</div>;
}
