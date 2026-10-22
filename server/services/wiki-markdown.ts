import { escapeHtml } from '../core/template.js';
import { slugify } from '../core/util.js';

/**
 * Markdown for the Wiki and the Team-Chat – the renderer, the HTML sanitiser behind it and the small
 * text tools around them (plain text for search, references, checklist toggle, export forms, diff).
 *
 * Safety model (two independent layers):
 * 1. The renderer escapes every character of the source; the only tags that appear are the ones it
 *    writes itself, URLs are checked against an allow-list (https, http, mailto, tel, /path, #anchor and
 *    our own user:/card:/page: references). Raw HTML in the source is shown as text, never interpreted.
 * 2. `sanitizeHtml` runs over the finished HTML and keeps only an allow-list of tags, attributes and class
 *    names, drops script-like elements with their content and re-balances the tags. Even a renderer bug
 *    could therefore not put script, event handlers, styles or foreign frames on a page.
 *
 * Syntax (everything is plain Markdown that degrades well elsewhere):
 * - blocks: # headings, paragraphs, - / 1. lists (nested), - [ ] / - [x] checklists, > quotes,
 *   > [!INFO] callouts (INFO NOTE TIP WARNING DANGER SUCCESS), ``` code, | tables |, --- rules
 * - inline: **bold** *italic* ~~strike~~ ==mark== `code` [link](url) ![image](url)
 * - [@Name](user:ID) mentions, [Title](page:ID) page links, [Label](card:kind:ID) live record cards
 *   (a line of its own = a card, inside text = a chip)
 */

export const CARD_KINDS = ['contact', 'company', 'deal', 'task', 'ticket', 'appointment', 'project', 'report', 'pipeline', 'canvas', 'doc', 'wiki'] as const;
export type CardKind = (typeof CARD_KINDS)[number];
export const isCardKind = (v: unknown): v is CardKind => typeof v === 'string' && (CARD_KINDS as readonly string[]).includes(v);
export const isRefId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);

/** Where a record opens in the app (the card's link). */
export function cardPath(kind: string, id: string): string {
  const e = encodeURIComponent(id);
  switch (kind) {
    case 'contact':
      return `/app/contacts/${e}`;
    case 'company':
      return `/app/companies/${e}`;
    case 'deal':
      return '/app/opportunities';
    case 'task':
      return '/app/tasks';
    case 'ticket':
      return `/app/tickets/${e}`;
    case 'appointment':
      return '/app/calendars';
    case 'project':
      return '/app/project';
    case 'report':
      return `/app/reports/r/${e}`;
    case 'pipeline':
      return `/app/opportunities?pipeline=${e}`;
    case 'canvas':
      return `/app/canvas/${e}`;
    case 'wiki':
      return `/app/wiki/${e}`;
    default:
      return '/app';
  }
}

export interface RenderOptions {
  /** `page`: everything; `chat`: no headings, tables, callouts or card blocks. */
  profile?: 'page' | 'chat';
  /** Public share page: no live data, no links into the app, checkboxes read-only. */
  publicView?: boolean;
  /** Checkboxes can be clicked (the signed-in page view toggles the source line). */
  interactive?: boolean;
  /** Level of `#` headings (2 on pages that show the title as <h1>). */
  baseLevel?: number;
}
export interface TocEntry {
  level: number;
  id: string;
  text: string;
}
export interface Rendered {
  html: string;
  toc: TocEntry[];
}

export const MAX_SOURCE = 400_000;
const MAX_LINE = 6000;
const MAX_DEPTH = 6;
const WINDOW = 2500;
const MAX_BLOCKS = 6000;

const esc = escapeHtml;

// --- URLs ------------------------------------------------------------------------------------

const CTRL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u2060\ufeff]/g;

/** A link target we are willing to emit, or null. Relative paths must start with a single "/". */
export function safeHref(raw: string, opts: { publicView?: boolean } = {}): string | null {
  const u = String(raw ?? '').replace(CTRL, '').trim();
  if (!u || u.length > 2000 || /\s/.test(u)) return null;
  if (/^https?:\/\/[^/\s]+/i.test(u)) return u;
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(u)) return u;
  if (/^tel:\+?[\d\s().-]{3,30}$/i.test(u)) return u;
  if (u.startsWith('#')) return /^#[\w-]{0,100}$/.test(u) ? u : null;
  if (u.startsWith('/') && !u.startsWith('//') && !u.includes('\\')) {
    // The public page must not point into the app (it would only lead to a login).
    if (opts.publicView && /^\/(app|api)(\/|$)/.test(u)) return null;
    return u;
  }
  return null;
}

/** Image sources: https, or a file of the media library. */
export function safeImageSrc(raw: string): string | null {
  const u = String(raw ?? '').replace(CTRL, '').trim();
  if (!u || u.length > 2000 || /\s/.test(u)) return null;
  if (/^https:\/\/[^/\s]+/i.test(u)) return u;
  if (/^\/uploads\/[A-Za-z0-9._-]{1,80}$/.test(u)) return u;
  return null;
}

// --- inline ------------------------------------------------------------------------------------

interface Flags {
  o: Required<RenderOptions>;
  inLink: boolean;
  /** Characters of look-ahead left for this render: bounds the work whatever the input looks like. */
  b: { n: number };
}

const isSpace = (c: string | undefined) => c === undefined || c === '' || /\s/.test(c);
const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

/** Index of the next `marker` in the window after `from`, or -1. */
function find(src: string, from: number, marker: string, f: Flags): number {
  if (f.b.n <= 0) return -1;
  const w = src.slice(from, from + WINDOW);
  const k = w.indexOf(marker);
  f.b.n -= k < 0 ? w.length : k + marker.length;
  return k < 0 ? -1 : from + k;
}

/** Matching "]" of the "[" at `i` (nested brackets up to 3 deep, same line only). */
function bracketEnd(src: string, i: number, f: Flags): number {
  let depth = 0;
  const end = Math.min(src.length, i + 1200);
  for (let k = i; k < end; k++) {
    if (--f.b.n < 0) return -1;
    const c = src[k];
    if (c === '\\') k++;
    else if (c === '[') {
      if (++depth > 3) return -1;
    } else if (c === ']') {
      if (--depth === 0) return k;
    } else if (c === '\n') return -1;
  }
  return -1;
}

/** `(url "title")` after "](" at `i` → url and the index after ")", or null. */
function linkTarget(src: string, i: number, f: Flags): { url: string; next: number } | null {
  let k = i;
  while (src[k] === ' ') k++;
  const start = k;
  let depth = 0;
  const end = Math.min(src.length, k + 2200);
  for (; k < end; k++) {
    if (--f.b.n < 0) return null;
    const c = src[k];
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) break;
      depth--;
    } else if (/\s/.test(c)) break;
  }
  if (k >= end) return null;
  const url = src.slice(start, k);
  while (src[k] === ' ') k++;
  if (src[k] === '"') {
    const close = src.indexOf('"', k + 1);
    if (close < 0 || close - k > 300) return null;
    k = close + 1;
    while (src[k] === ' ') k++;
  }
  return src[k] === ')' ? { url, next: k + 1 } : null;
}

function renderLink(label: string, rawLabel: string, url: string, f: Flags): string {
  const pub = f.o.publicView;
  const sch = /^(user|card|page):/.exec(url);
  if (sch) {
    const parts = url.slice(sch[0].length).split(':');
    if (sch[1] === 'user') {
      const uid = parts[0];
      if (!isRefId(uid) || parts.length !== 1) return label;
      return `<span class="wk-mention"${pub ? '' : ` data-user="${esc(uid)}"`}>${label}</span>`;
    }
    if (sch[1] === 'page') {
      const pid = parts[0];
      if (!isRefId(pid) || parts.length !== 1 || f.inLink) return label;
      return pub ? `<span class="wk-pagelink">${label}</span>` : `<a class="wk-pagelink" href="/app/wiki/${esc(encodeURIComponent(pid))}" data-page="${esc(pid)}">${label}</a>`;
    }
    const [kind, cid] = parts;
    if (!isCardKind(kind) || !isRefId(cid) || parts.length !== 2 || f.inLink) return label;
    return pub ? `<span class="wk-chip">${label}</span>` : `<a class="wk-chip" href="${esc(cardPath(kind, cid))}" data-card-kind="${esc(kind)}" data-card-id="${esc(cid)}">${label}</a>`;
  }
  const href = f.inLink ? null : safeHref(url, { publicView: pub });
  if (!href) return label;
  void rawLabel;
  if (/^https?:/i.test(href)) return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`;
  return `<a href="${esc(href)}"${/^\/uploads\//.test(href) ? ' class="wk-file" target="_blank" rel="noopener noreferrer"' : ''}>${label}</a>`;
}

function inline(src: string, f: Flags, depth = 0): string {
  if (depth > MAX_DEPTH) return esc(src);
  const n = src.length;
  let out = '';
  let buf = '';
  const flush = () => {
    if (buf) {
      out += esc(buf);
      buf = '';
    }
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    // escapes
    if (c === '\\' && i + 1 < n && /[\\`*_{}[\]()#+\-.!|~=>@<:]/.test(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    // code span
    if (c === '`') {
      let run = 1;
      while (src[i + run] === '`') run++;
      const fence = '`'.repeat(run);
      const close = find(src, i + run, fence, f);
      if (close > 0) {
        flush();
        out += `<code>${esc(src.slice(i + run, close).replace(/^ (.*[^ ].*) $/, '$1'))}</code>`;
        i = close + run;
        continue;
      }
      buf += fence;
      i += run;
      continue;
    }
    // images and links
    if (c === '!' && src[i + 1] === '[') {
      const end = bracketEnd(src, i + 1, f);
      if (end > 0 && src[end + 1] === '(') {
        const t = linkTarget(src, end + 2, f);
        if (t) {
          const alt = src.slice(i + 2, end).replace(/[*_`~=[\]\\]/g, '');
          const s = safeImageSrc(t.url);
          flush();
          out += s ? `<img class="wk-img" src="${esc(s)}" alt="${esc(alt)}" loading="lazy">` : esc(alt);
          i = t.next;
          continue;
        }
      }
    }
    if (c === '[') {
      const end = bracketEnd(src, i, f);
      if (end > 0 && src[end + 1] === '(') {
        const t = linkTarget(src, end + 2, f);
        if (t) {
          const raw = src.slice(i + 1, end);
          flush();
          out += renderLink(inline(raw, { ...f, inLink: true }, depth + 1), raw, t.url, f);
          i = t.next;
          continue;
        }
      }
    }
    // emphasis
    if ((c === '*' || c === '_') && src[i + 1] === c) {
      const m = c + c;
      const next = src[i + 2];
      const before = src[i - 1];
      if (!isSpace(next) && !(c === '_' && isWord(before))) {
        let close = find(src, i + 2, m, f);
        for (let tries = 0; tries < 3 && close > 0 && (isSpace(src[close - 1]) || close === i + 2); tries++) close = find(src, close + 1, m, f);
        if (close > 0 && (isSpace(src[close - 1]) || close === i + 2)) close = -1;
        if (close > 0 && !(c === '_' && isWord(src[close + 2]))) {
          flush();
          out += `<strong>${inline(src.slice(i + 2, close), f, depth + 1)}</strong>`;
          i = close + 2;
          continue;
        }
      }
    }
    if (c === '*' || c === '_') {
      const next = src[i + 1];
      const before = src[i - 1];
      if (!isSpace(next) && next !== c && !(c === '_' && isWord(before))) {
        const lim = Math.min(n, i + WINDOW);
        let close = -1;
        for (let k = i + 1; k < lim; k++) {
          if (--f.b.n < 0) break;
          if (src[k] === '\\') k++;
          else if (src[k] === '`') {
            const e = src.indexOf('`', k + 1);
            if (e > 0 && e < lim) k = e;
          } else if (src[k] === c) {
            if (src[k + 1] === c) k++;
            else if (!isSpace(src[k - 1]) && !(c === '_' && isWord(src[k + 1]))) {
              close = k;
              break;
            }
          }
        }
        if (close > i + 1) {
          flush();
          out += `<em>${inline(src.slice(i + 1, close), f, depth + 1)}</em>`;
          i = close + 1;
          continue;
        }
      }
    }
    if ((c === '~' || c === '=') && src[i + 1] === c && !isSpace(src[i + 2])) {
      const m = c + c;
      const close = find(src, i + 2, m, f);
      if (close > i + 2 && !isSpace(src[close - 1])) {
        flush();
        const tag = c === '~' ? 'del' : 'mark';
        out += `<${tag}>${inline(src.slice(i + 2, close), f, depth + 1)}</${tag}>`;
        i = close + 2;
        continue;
      }
    }
    // bare links
    if ((c === 'h' || c === 'H') && !f.inLink && /^https?:\/\//i.test(src.slice(i, i + 8)) && (i === 0 || /[\s(>]/.test(src[i - 1]))) {
      let k = i;
      while (k < n && !/[\s<>"]/.test(src[k]) && k - i < 1500) k++;
      let url = src.slice(i, k);
      while (/[.,;:!?'*_~\])}]$/.test(url) && !(url.endsWith(')') && url.includes('('))) url = url.slice(0, -1);
      const href = safeHref(url);
      if (href && /^https?:\/\/[^/\s]+\.[^/\s]+/i.test(href)) {
        flush();
        out += `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer nofollow">${esc(url.length > 90 ? `${url.slice(0, 87)}…` : url)}</a>`;
        i += url.length;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

/** Several lines of one paragraph: line breaks become <br>; very long ones are cut into pieces so emphasis can't span megabytes. */
function inlineText(text: string, f: Flags): string {
  if (text.length <= 6000) return inline(text, f).replace(/\n/g, '<br>');
  const parts: string[] = [];
  let cur = '';
  for (const l of text.split('\n')) {
    if (cur && cur.length + l.length > 6000) {
      parts.push(cur);
      cur = '';
    }
    cur += (cur ? '\n' : '') + l;
  }
  if (cur) parts.push(cur);
  return parts.map((p) => inline(p, f).replace(/\n/g, '<br>')).join('<br>');
}

// --- blocks ------------------------------------------------------------------------------------

interface Ln {
  s: string;
  n: number;
}
interface State {
  o: Required<RenderOptions>;
  ids: Map<string, number>;
  toc: TocEntry[];
  blocks: number;
  b: { n: number };
}

const indentOf = (s: string) => {
  let w = 0;
  for (const ch of s) {
    if (ch === ' ') w++;
    else if (ch === '\t') w += 4;
    else break;
  }
  return w;
};
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+#.-]{0,30})(?:[ \t].*)?$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>/;
const LI = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(\S.*)$/;
const LI_EMPTY = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]*$/;
const TABLE_SEP = /^[ \t]*\|?[ \t]*:?-{1,80}:?[ \t]*(?:\|[ \t]*:?-{1,80}:?[ \t]*)*\|?[ \t]*$/;
const CARD_LINE = /^\[([^\]\n]{0,200})\]\(card:([a-z]+):([A-Za-z0-9_-]{1,64})\)$/;
const CALLOUTS: Record<string, [string, string]> = {
  INFO: ['info', 'Info'],
  NOTE: ['note', 'Hinweis'],
  TIP: ['tip', 'Tipp'],
  WARNING: ['warning', 'Achtung'],
  CAUTION: ['warning', 'Achtung'],
  DANGER: ['danger', 'Wichtig'],
  IMPORTANT: ['danger', 'Wichtig'],
  SUCCESS: ['success', 'Geschafft'],
};

function headingOf(s: string): { level: number; text: string } | null {
  const m = /^ {0,3}(#{1,6})[ \t]+/.exec(s);
  if (!m) return null;
  let text = s.slice(m[0].length).trimEnd();
  // closing sequence "## Title ##"
  let e = text.length;
  while (e > 0 && text[e - 1] === '#') e--;
  if (e < text.length && (e === 0 || text[e - 1] === ' ')) text = text.slice(0, e).trimEnd();
  return text ? { level: m[1].length, text } : null;
}

/** Cells of a table row: split on "|" outside code spans, honouring "\|". */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  let code = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (ch === '`') {
      code = !code;
      cur += ch;
    } else if (ch === '|' && !code) {
      cells.push(cur.trim());
      cur = '';
      if (cells.length >= 30) return cells;
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function startsBlock(lines: Ln[], i: number, o: Required<RenderOptions>, inPara: boolean): boolean {
  const s = lines[i].s;
  if (!s.trim()) return true;
  if (FENCE.test(s) || HR.test(s) || QUOTE.test(s)) return true;
  if (o.profile === 'page' && /^ {0,3}#{1,6}[ \t]+\S/.test(s)) return true;
  const li = LI.exec(s);
  if (li && (!inPara || /^[-*+]$/.test(li[2]) || /^1[.)]$/.test(li[2]))) return true;
  if (o.profile === 'page' && s.includes('|') && i + 1 < lines.length && lines[i + 1].s.includes('|') && TABLE_SEP.test(lines[i + 1].s) && splitRow(s).length === splitRow(lines[i + 1].s).length) return true;
  return false;
}

function parseBlocks(lines: Ln[], st: State, depth: number): string {
  const o = st.o;
  const out: string[] = [];
  let i = 0;
  const para = (from: number, to: number) => {
    const chunk = lines.slice(from, to);
    const flags: Flags = { o, inLink: false, b: st.b };
    if (o.profile === 'page' && chunk.every((l) => CARD_LINE.test(l.s.trim()))) {
      for (const l of chunk) {
        const m = CARD_LINE.exec(l.s.trim())!;
        if (isCardKind(m[2])) {
          const kind = m[2];
          const label = inline(m[1] || kind, { ...flags, inLink: true }, 1);
          out.push(
            o.publicView
              ? `<div class="wk-card wk-card-static"><span class="wk-chip">${label}</span></div>`
              : `<div class="wk-card" data-card-kind="${esc(kind)}" data-card-id="${esc(m[3])}"><a class="wk-card-link" href="${esc(cardPath(kind, m[3]))}">${label}</a></div>`,
          );
        } else out.push(`<p>${inline(l.s.trim(), flags)}</p>`);
      }
      return;
    }
    const joined = chunk.map((l) => l.s.trim()).join('\n');
    if (joined) out.push(`<p>${inlineText(joined, flags)}</p>`);
  };

  while (i < lines.length) {
    if (++st.blocks > MAX_BLOCKS) break;
    const line = lines[i];
    const s = line.s;
    if (!s.trim()) {
      i++;
      continue;
    }
    // fenced code
    const f = FENCE.exec(s);
    if (f) {
      const mark = f[1][0];
      const len = f[1].length;
      const code: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const t = lines[j].s.trim();
        if (t.length >= len && t.split('').every((ch) => ch === mark)) break;
        code.push(lines[j].s);
      }
      out.push(`<pre class="wk-code"${f[2] ? ` data-lang="${esc(f[2])}"` : ''}><code>${esc(code.join('\n'))}</code></pre>`);
      i = j + 1;
      continue;
    }
    // headings (pages only: in chat a "#" is just text)
    const h = o.profile === 'page' ? headingOf(s) : null;
    if (h) {
      const level = Math.min(6, h.level + o.baseLevel - 1);
      const plain = markdownToText(h.text);
      const base = `h-${slugify(plain).slice(0, 60)}`;
      const k = st.ids.get(base) ?? 0;
      st.ids.set(base, k + 1);
      const id = k ? `${base}-${k + 1}` : base;
      if (level <= 4 && plain) st.toc.push({ level, id, text: plain.slice(0, 160) });
      out.push(`<h${level} id="${esc(id)}">${inline(h.text, { o, inLink: false, b: st.b })}</h${level}>`);
      i++;
      continue;
    }
    if (HR.test(s)) {
      out.push('<hr>');
      i++;
      continue;
    }
    // quote / callout
    if (QUOTE.test(s)) {
      const q: Ln[] = [];
      while (i < lines.length && QUOTE.test(lines[i].s)) {
        q.push({ s: lines[i].s.replace(/^ {0,3}>[ ]?/, ''), n: lines[i].n });
        i++;
      }
      if (depth >= MAX_DEPTH) {
        out.push(`<p>${esc(q.map((l) => l.s).join('\n')).replace(/\n/g, '<br>')}</p>`);
        continue;
      }
      const tag = o.profile === 'page' ? /^\[!([A-Za-z]{3,12})\][ \t]*(.*)$/.exec(q[0].s.trim()) : null;
      const kind = tag ? CALLOUTS[tag[1].toUpperCase()] : undefined;
      if (tag && kind) {
        // "> [!TIP] Eigener Titel" – the text after the tag replaces the default title
        const rest = tag[2].trim();
        const body = parseBlocks(q.slice(1), st, depth + 1);
        const title = rest ? inline(rest, { o, inLink: false, b: st.b }) : kind[1];
        out.push(`<div class="wk-callout wk-callout-${kind[0]}" data-kind="${kind[0]}"><div class="wk-callout-title">${title}</div><div class="wk-callout-body">${body}</div></div>`);
      } else out.push(`<blockquote>${parseBlocks(q, st, depth + 1)}</blockquote>`);
      continue;
    }
    // table
    if (o.profile === 'page' && s.includes('|') && i + 1 < lines.length && lines[i + 1].s.includes('|') && TABLE_SEP.test(lines[i + 1].s)) {
      const head = splitRow(s);
      const sep = splitRow(lines[i + 1].s);
      if (head.length === sep.length) {
        const align = sep.map((c) => (c.startsWith(':') && c.endsWith(':') ? 'c' : c.endsWith(':') ? 'r' : ''));
        const rows: string[][] = [];
        let j = i + 2;
        while (j < lines.length && lines[j].s.trim() && lines[j].s.includes('|') && rows.length < 500) rows.push(splitRow(lines[j++].s));
        const flags: Flags = { o, inLink: false, b: st.b };
        const cell = (tag: string, text: string, k: number) => `<${tag}${align[k] ? ` class="wk-al-${align[k]}"` : ''}>${inline(text, flags)}</${tag}>`;
        const cols = head.length;
        out.push(
          `<div class="wk-table-wrap"><table class="wk-table"><thead><tr>${head.map((t, k) => cell('th', t, k)).join('')}</tr></thead><tbody>${rows
            .map((r) => `<tr>${Array.from({ length: cols }, (_x, k) => cell('td', r[k] ?? '', k)).join('')}</tr>`)
            .join('')}</tbody></table></div>`,
        );
        i = j;
        continue;
      }
    }
    // lists
    if (LI.test(s) || LI_EMPTY.test(s)) {
      const r = parseList(lines, i, st, depth);
      out.push(r.html);
      i = r.next;
      continue;
    }
    // paragraph
    let j = i + 1;
    while (j < lines.length && !startsBlock(lines, j, o, true)) j++;
    para(i, j);
    i = j;
  }
  return out.join('\n');
}

function parseList(lines: Ln[], start: number, st: State, depth: number): { html: string; next: number } {
  const o = st.o;
  const first = LI.exec(lines[start].s) ?? LI_EMPTY.exec(lines[start].s)!;
  const base = indentOf(first[1]);
  const ordered = /\d/.test(first[2]);
  const startNo = ordered ? Number(first[2].replace(/\D/g, '')) : 1;
  const items: string[] = [];
  let anyTask = false;
  let i = start;
  while (i < lines.length) {
    const m = LI.exec(lines[i].s) ?? LI_EMPTY.exec(lines[i].s);
    if (!m) break;
    const ind = indentOf(m[1]);
    if (ind < base || ind > base + 1 || /\d/.test(m[2]) !== ordered) break;
    if (++st.blocks > MAX_BLOCKS) break;
    const marker = m[2];
    const content = (m[3] ?? '') as string;
    const contentIndent = ind + marker.length + 1;
    const item: Ln[] = [{ s: content, n: lines[i].n }];
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j];
      if (!l.s.trim()) {
        let k = j + 1;
        while (k < lines.length && !lines[k].s.trim()) k++;
        if (k < lines.length && indentOf(lines[k].s) >= base + 2) {
          item.push({ s: '', n: l.n });
          j++;
          continue;
        }
        break;
      }
      const li = indentOf(l.s);
      if (li >= base + 2) {
        // strip the item's content indent (at most)
        let strip = 0;
        let cut = 0;
        while (cut < l.s.length && strip < contentIndent && (l.s[cut] === ' ' || l.s[cut] === '\t')) {
          strip += l.s[cut] === '\t' ? 4 : 1;
          cut++;
        }
        item.push({ s: l.s.slice(cut), n: l.n });
        j++;
        continue;
      }
      if (LI.test(l.s) || LI_EMPTY.test(l.s) || FENCE.test(l.s) || HR.test(l.s) || QUOTE.test(l.s) || headingOf(l.s)) break;
      // lazy continuation of the item's paragraph
      item.push({ s: l.s.trim(), n: l.n });
      j++;
    }
    // checklist marker
    let task: { checked: boolean; line: number } | null = null;
    const tm = /^\[([ xX])\][ \t]+(.*)$/.exec(item[0].s) ?? (/^\[([ xX])\]$/.test(item[0].s) ? [item[0].s, item[0].s[1], ''] : null);
    if (tm) {
      task = { checked: tm[1].toLowerCase() === 'x', line: item[0].n };
      item[0] = { s: tm[2] ?? '', n: item[0].n };
      anyTask = true;
    }
    // leading text lines = the item's own paragraph; the rest (nested lists, code, more paragraphs) are blocks
    let t = 0;
    while (t < item.length && item[t].s.trim() && !(t > 0 && startsBlock(item, t, o, true))) t++;
    const text = item
      .slice(0, t)
      .map((l) => l.s.trim())
      .join('\n');
    const rest = item.slice(t);
    const flags: Flags = { o, inLink: false, b: st.b };
    const inner = inlineText(text, flags);
    const nested = rest.some((l) => l.s.trim()) && depth < MAX_DEPTH ? parseBlocks(rest, st, depth + 1) : '';
    if (task) {
      const dis = !o.interactive || o.publicView ? ' disabled' : '';
      items.push(`<li class="wk-task${task.checked ? ' wk-done' : ''}"><input type="checkbox" data-line="${task.line}"${task.checked ? ' checked' : ''}${dis}> <span>${inner}</span>${nested}</li>`);
    } else items.push(`<li>${inner}${nested}</li>`);
    i = j;
    // blank lines between items of one list
    while (i < lines.length && !lines[i].s.trim()) {
      let k = i;
      while (k < lines.length && !lines[k].s.trim()) k++;
      const nm = k < lines.length ? (LI.exec(lines[k].s) ?? LI_EMPTY.exec(lines[k].s)) : null;
      if (nm && indentOf(nm[1]) >= base && indentOf(nm[1]) <= base + 1 && /\d/.test(nm[2]) === ordered) i = k;
      else break;
    }
  }
  const cls = anyTask ? ' class="wk-tasks"' : '';
  return { html: ordered ? `<ol${startNo !== 1 ? ` start="${Math.min(startNo, 999999)}"` : ''}${cls}>${items.join('')}</ol>` : `<ul${cls}>${items.join('')}</ul>`, next: i };
}

/** Splits very long lines so no later pattern has to look at a megabyte-long run. */
function toLines(src: string): Ln[] {
  const out: Ln[] = [];
  const raw = src.replace(/\r\n?/g, '\n').split('\n');
  let blanks = 0;
  raw.forEach((s, n) => {
    // endless runs of empty lines are cut (they would make the look-ahead of lists quadratic)
    if (!s.trim()) {
      if (++blanks > 50) return;
    } else blanks = 0;
    if (s.length <= MAX_LINE) out.push({ s, n });
    else for (let k = 0; k < s.length; k += MAX_LINE) out.push({ s: s.slice(k, k + MAX_LINE), n });
  });
  return out;
}

export function renderMarkdown(source: string, options: RenderOptions = {}): Rendered {
  const o: Required<RenderOptions> = { profile: options.profile ?? 'page', publicView: !!options.publicView, interactive: !!options.interactive, baseLevel: Math.min(Math.max(options.baseLevel ?? 1, 1), 3) };
  const src = String(source ?? '').slice(0, MAX_SOURCE);
  const st: State = { o, ids: new Map(), toc: [], blocks: 0, b: { n: 3_000_000 } };
  const html = parseBlocks(toLines(src), st, 0);
  return { html: sanitizeHtml(html), toc: st.toc };
}

/** Chat messages: inline formatting, quotes, lists and code – no headings, tables or cards-as-blocks. */
export const renderChat = (text: string): string => renderMarkdown(text, { profile: 'chat' }).html;

// --- sanitiser (second layer) ----------------------------------------------------------------------

type AttrRule = (value: string) => string | null;
const cls: AttrRule = (v) => {
  const ok = v
    .split(/\s+/)
    .filter((c) => /^wk-[a-z0-9_-]{1,40}$/.test(c))
    .slice(0, 6);
  return ok.length ? ok.join(' ') : null;
};
const ref: AttrRule = (v) => (isRefId(v) ? v : null);
const kindRule: AttrRule = (v) => (isCardKind(v) ? v : null);
const num: AttrRule = (v) => (/^\d{1,9}$/.test(v) ? v : null);
const short: AttrRule = (v) => (v.length <= 300 ? v : null);
const bool: AttrRule = () => '';
const href: AttrRule = (v) => safeHref(v);
const src: AttrRule = (v) => safeImageSrc(v);

const ALLOWED: Record<string, Record<string, AttrRule>> = {
  p: {},
  br: {},
  hr: {},
  strong: {},
  em: {},
  del: {},
  mark: {},
  code: { class: cls },
  pre: { class: cls, 'data-lang': (v) => (/^[A-Za-z0-9_+#.-]{1,30}$/.test(v) ? v : null) },
  h1: { id: (v) => (/^h-[a-z0-9-]{1,80}$/.test(v) ? v : null) },
  h2: { id: (v) => (/^h-[a-z0-9-]{1,80}$/.test(v) ? v : null) },
  h3: { id: (v) => (/^h-[a-z0-9-]{1,80}$/.test(v) ? v : null) },
  h4: { id: (v) => (/^h-[a-z0-9-]{1,80}$/.test(v) ? v : null) },
  h5: { id: (v) => (/^h-[a-z0-9-]{1,80}$/.test(v) ? v : null) },
  h6: { id: (v) => (/^h-[a-z0-9-]{1,80}$/.test(v) ? v : null) },
  ul: { class: cls },
  ol: { class: cls, start: num },
  li: { class: cls },
  blockquote: {},
  a: { href, class: cls, target: (v) => (v === '_blank' ? v : null), rel: (v) => (/^(noopener|noreferrer|nofollow| )+$/.test(v) ? v : null), 'data-card-kind': kindRule, 'data-card-id': ref, 'data-page': ref },
  img: { src, alt: short, class: cls, loading: (v) => (v === 'lazy' ? v : null) },
  span: { class: cls, 'data-user': ref },
  div: { class: cls, 'data-kind': (v) => (/^[a-z]{3,10}$/.test(v) ? v : null), 'data-card-kind': kindRule, 'data-card-id': ref },
  table: { class: cls },
  thead: {},
  tbody: {},
  tr: {},
  th: { class: cls },
  td: { class: cls },
  input: { type: (v) => (v === 'checkbox' ? v : null), checked: bool, disabled: bool, 'data-line': num },
};
const VOID = new Set(['br', 'hr', 'img', 'input']);
/** Elements dropped together with everything inside them. */
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'noscript', 'textarea', 'title', 'xmp', 'plaintext', 'noembed', 'noframes', 'frameset', 'frame', 'applet', 'head', 'select', 'button', 'form', 'audio', 'video', 'canvas', 'portal']);

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', tab: '\t', newline: '\n', lpar: '(', rpar: ')', sol: '/', num: '#', period: '.' };
/** Decodes the entities a browser would decode in an attribute value (so "jav&#x61;script:" is seen for what it is). */
function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z]{2,10}));?/g, (m, dec, hex, name) => {
    if (dec || hex) {
      const cp = dec ? Number(dec) : parseInt(hex, 16);
      return cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : '';
    }
    return ENTITIES[String(name).toLowerCase()] ?? m;
  });
}

/** Escapes text so it can sit in an element: keeps valid entities, escapes "<", ">" and stray "&". */
function cleanText(s: string): string {
  return s.replace(/&(?!(?:amp|lt|gt|quot|#39|#\d{1,7}|#x[0-9a-fA-F]{1,6});)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface Tag {
  name: string;
  closing: boolean;
  attrs: [string, string][];
  end: number;
}

/** Reads a tag starting at "<" (quotes honoured, every piece bounded). Null when it is not a well-formed tag. */
function readTag(html: string, i: number): Tag | null {
  let k = i + 1;
  const closing = html[k] === '/';
  if (closing) k++;
  const nameStart = k;
  while (k < html.length && k - nameStart < 24 && /[A-Za-z0-9:-]/.test(html[k])) k++;
  if (k === nameStart || !/[A-Za-z]/.test(html[nameStart]) || /[A-Za-z0-9:-]/.test(html[k] ?? ' ')) return null;
  const name = html.slice(nameStart, k).toLowerCase();
  const attrs: [string, string][] = [];
  let guard = 0;
  while (k < html.length && guard++ < 40) {
    while (k < html.length && /[\s/]/.test(html[k])) k++;
    if (html[k] === '>') return { name, closing, attrs, end: k + 1 };
    const as = k;
    while (k < html.length && k - as < 60 && !/[\s=>/]/.test(html[k])) k++;
    if (k === as || k - as >= 60) return null;
    const an = html.slice(as, k).toLowerCase();
    while (k < html.length && /\s/.test(html[k])) k++;
    let value = '';
    if (html[k] === '=') {
      k++;
      while (k < html.length && /\s/.test(html[k])) k++;
      if (html[k] === '"' || html[k] === "'") {
        const q = html[k];
        const e = html.slice(k + 1, k + 4001).indexOf(q);
        if (e < 0) return null;
        value = html.slice(k + 1, k + 1 + e);
        k += e + 2;
      } else {
        const vs = k;
        while (k < html.length && k - vs < 2000 && !/[\s>]/.test(html[k])) k++;
        value = html.slice(vs, k);
      }
    }
    attrs.push([an, value]);
  }
  return null;
}

/**
 * Keeps only allow-listed tags, attributes and class names, drops script-like elements with their content,
 * escapes everything else and closes what is left open. Linear time; input of any origin is fine.
 */
export function sanitizeHtml(html: string): string {
  const src = String(html ?? '');
  let lower: string | undefined;
  let out = '';
  const stack: string[] = [];
  let i = 0;
  let nodes = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      out += cleanText(src.slice(i));
      break;
    }
    if (lt > i) out += cleanText(src.slice(i, lt));
    if (++nodes > 200_000) break;
    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt + 4);
      i = e < 0 ? src.length : e + 3;
      continue;
    }
    if (src[lt + 1] === '!' || src[lt + 1] === '?') {
      const e = src.indexOf('>', lt);
      i = e < 0 ? src.length : e + 1;
      continue;
    }
    const tag = readTag(src, lt);
    if (!tag) {
      out += '&lt;';
      i = lt + 1;
      continue;
    }
    i = tag.end;
    if (!tag.closing && DROP_WITH_CONTENT.has(tag.name)) {
      lower ??= src.toLowerCase();
      const at = lower.indexOf(`</${tag.name}`, i);
      if (at < 0) {
        i = src.length;
        break;
      }
      const e = src.indexOf('>', at);
      i = e < 0 ? src.length : e + 1;
      continue;
    }
    const rules = ALLOWED[tag.name];
    if (!rules) continue; // unknown tag: dropped, its text content stays
    if (tag.closing) {
      const at = stack.lastIndexOf(tag.name);
      if (at < 0) continue;
      while (stack.length > at) out += `</${stack.pop()}>`;
      continue;
    }
    let attrs = '';
    const seen = new Set<string>();
    for (const [name, raw] of tag.attrs) {
      const rule = rules[name];
      if (!rule || seen.has(name)) continue;
      seen.add(name);
      const v = rule(decodeEntities(raw).replace(CTRL, ''));
      if (v === null) continue;
      attrs += v === '' && (name === 'checked' || name === 'disabled') ? ` ${name}` : ` ${name}="${escapeHtml(v)}"`;
    }
    // an <input> must be a checkbox and an <img> needs a source – anything else is dropped
    if ((tag.name === 'input' && !/\stype="checkbox"/.test(attrs)) || (tag.name === 'img' && !/\ssrc="/.test(attrs))) continue;
    if (tag.name === 'a' && /\starget="_blank"/.test(attrs) && !/\srel=/.test(attrs)) attrs += ' rel="noopener noreferrer"';
    out += `<${tag.name}${attrs}>`;
    if (!VOID.has(tag.name)) stack.push(tag.name);
    if (stack.length > 200) break;
  }
  while (stack.length) out += `</${stack.pop()}>`;
  return out;
}

// --- HTML tree (for the PDF layout) ------------------------------------------------------------------

export interface HNode {
  tag: string;
  attrs: Record<string, string>;
  children: HNode[];
  /** Set on text nodes (tag is "#text"). */
  text?: string;
}

/** Parses *our own sanitised output* into a small tree (void elements, entities decoded). */
export function parseHtml(html: string): HNode[] {
  const root: HNode = { tag: '#root', attrs: {}, children: [] };
  const stack: HNode[] = [root];
  let i = 0;
  const src = String(html ?? '');
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    const end = lt < 0 ? src.length : lt;
    if (end > i) stack[stack.length - 1].children.push({ tag: '#text', attrs: {}, children: [], text: decodeEntities(src.slice(i, end)) });
    if (lt < 0) break;
    const tag = readTag(src, lt);
    if (!tag) {
      i = lt + 1;
      continue;
    }
    i = tag.end;
    if (tag.closing) {
      const at = stack.map((n) => n.tag).lastIndexOf(tag.name);
      if (at > 0) stack.length = at;
      continue;
    }
    const node: HNode = { tag: tag.name, attrs: Object.fromEntries(tag.attrs.map(([k, v]) => [k, decodeEntities(v)])), children: [] };
    stack[stack.length - 1].children.push(node);
    if (!VOID.has(tag.name)) stack.push(node);
    if (stack.length > 60) break;
  }
  return root.children;
}

// --- text tools -----------------------------------------------------------------------------------

/** Plain text of Markdown (for search, previews, push bodies). */
export function markdownToText(md: string): string {
  const lines = String(md ?? '')
    .slice(0, MAX_SOURCE)
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const out: string[] = [];
  for (let l of lines) {
    if (l.length > MAX_LINE) l = l.slice(0, MAX_LINE);
    if (FENCE.test(l)) continue;
    if (/^[\s|:-]*$/.test(l) && /[|-]/.test(l)) continue;
    l = l
      .replace(/!\[([^\]\n]{0,300})\]\([^)\s]{0,2000}(?:\s+"[^"\n]*")?\)/g, '$1')
      .replace(/\[([^\]\n]{0,300})\]\([^)\s]{0,2000}(?:\s+"[^"\n]*")?\)/g, '$1')
      .replace(/^ {0,3}#{1,6}[ \t]+/, '')
      .replace(/^[ \t]*>[ \t]?(?:\[![A-Za-z]{3,12}\][ \t]*)?/, '')
      .replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]*)?/, '')
      .replace(/\|/g, ' ')
      .replace(/(\*\*|__|~~|==|`)/g, '')
      .replace(/(^|[\s(])[*_]([^*_\n]{1,300})[*_](?=[\s).,;:!?]|$)/g, '$1$2')
      .replace(/[ \t]+/g, ' ')
      .trim();
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Text without fenced and inline code (so a mention inside code does not notify anyone). */
function withoutCode(md: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const l of String(md ?? '').slice(0, MAX_SOURCE).split('\n')) {
    const f = FENCE.exec(l);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2]) fence = null;
      continue;
    }
    if (f) {
      fence = f[1];
      continue;
    }
    out.push(l.slice(0, MAX_LINE).replace(/`[^`\n]*`/g, ' '));
  }
  return out.join('\n');
}

export interface Refs {
  users: string[];
  cards: { kind: CardKind; id: string; label: string }[];
  pages: string[];
}

/** Mentions, record cards and page links a text refers to. */
export function extractRefs(md: string): Refs {
  const users = new Set<string>();
  const pages = new Set<string>();
  const cards = new Map<string, { kind: CardKind; id: string; label: string }>();
  for (const m of withoutCode(md).matchAll(/\[([^\]\n]{0,200})\]\((user|card|page):([A-Za-z0-9_:-]{1,140})\)/g)) {
    const parts = m[3].split(':');
    if (m[2] === 'user' && parts.length === 1 && isRefId(parts[0])) users.add(parts[0]);
    else if (m[2] === 'page' && parts.length === 1 && isRefId(parts[0])) pages.add(parts[0]);
    else if (m[2] === 'card' && parts.length === 2 && isCardKind(parts[0]) && isRefId(parts[1])) cards.set(`${parts[0]}:${parts[1]}`, { kind: parts[0], id: parts[1], label: m[1] });
  }
  return { users: [...users], cards: [...cards.values()], pages: [...pages] };
}

/** True when source line `line` (0-based) lies inside a fenced code block. */
export function insideFence(md: string, line: number): boolean {
  let fence: string | null = null;
  const lines = String(md ?? '').split('\n');
  for (let i = 0; i < Math.min(line + 1, lines.length); i++) {
    const f = FENCE.exec(lines[i].slice(0, MAX_LINE));
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2]) fence = null;
      if (i === line) return true;
    } else if (f) {
      fence = f[1];
      if (i === line) return true;
    }
  }
  return fence !== null;
}

/** Ticks or unticks the checklist item on source line `line`; null when that line is no (real) checklist item. */
export function toggleTask(md: string, line: number, checked: boolean): string | null {
  const lines = String(md ?? '').split('\n');
  if (!Number.isInteger(line) || line < 0 || line >= lines.length) return null;
  const m = /^([ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[)([ xX])(\](?:[ \t]|$))/.exec(lines[line]);
  if (!m || insideFence(md, line)) return null;
  lines[line] = `${m[1]}${checked ? 'x' : ' '}${m[3]}${lines[line].slice(m[0].length)}`;
  return lines.join('\n');
}

/** Counts of checklist items: [done, total]. */
export function taskCount(md: string): [number, number] {
  let done = 0;
  let total = 0;
  for (const l of withoutCode(md).split('\n')) {
    const m = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\](?:[ \t]|$)/.exec(l);
    if (m) {
      total++;
      if (m[1] !== ' ') done++;
    }
  }
  return [done, total];
}

/** First "# Heading" of a text (page title when importing), if any. */
export function firstHeading(md: string): string {
  for (const l of String(md ?? '').slice(0, 20_000).split('\n')) {
    const m = /^ {0,3}#[ \t]+(.+?)[ \t#]*$/.exec(l.slice(0, 400));
    if (m) return markdownToText(m[1]).slice(0, 200);
    if (l.trim() && !/^---\s*$/.test(l)) break;
  }
  return '';
}

const absolute = (base: string, p: string) => `${base.replace(/\/$/, '')}${p}`;

/**
 * Markdown that reads well outside HyperLevel (export): mentions become plain "@Name", records and pages
 * become links to the app, uploads get absolute URLs.
 */
export function portableMarkdown(md: string, baseUrl: string): string {
  return String(md ?? '')
    .replace(/\[([^\]\n]{0,200})\]\(user:[A-Za-z0-9_-]{1,64}\)/g, (_m, t) => t)
    .replace(/\[([^\]\n]{0,200})\]\(card:([a-z]+):([A-Za-z0-9_-]{1,64})\)/g, (_m, t, k, id) => (isCardKind(k) ? `[${t}](${absolute(baseUrl, cardPath(k, id))})` : t))
    .replace(/\[([^\]\n]{0,200})\]\(page:([A-Za-z0-9_-]{1,64})\)/g, (_m, t, id) => `[${t}](${absolute(baseUrl, cardPath('wiki', id))})`)
    .replace(/(\]\()(\/uploads\/[A-Za-z0-9._-]{1,80}\))/g, (_m, a, b) => `${a}${absolute(baseUrl, b)}`);
}

/**
 * Markdown for the public help center (its renderer has no tables, checklists or callouts, and no
 * internal links): tables become lists, checklists get ☐/☑, callouts get a bold title, references plain text.
 */
export function publicMarkdown(md: string, baseUrl: string): string {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].slice(0, MAX_LINE);
    const f = FENCE.exec(l);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2]) fence = null;
      out.push(l);
      continue;
    }
    if (f) {
      fence = f[1];
      out.push(l);
      continue;
    }
    // tables → list
    if (l.includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && TABLE_SEP.test(lines[i + 1])) {
      const head = splitRow(l);
      i += 2;
      for (; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) {
        const cells = splitRow(lines[i]);
        out.push(`- ${cells.map((c, k) => (head[k] ? `**${head[k]}:** ${c}` : c)).join(' · ')}`);
      }
      i--;
      out.push('');
      continue;
    }
    out.push(
      l
        .replace(/^([ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)\[ \](?=[ \t]|$)/, '$1☐')
        .replace(/^([ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)\[[xX]\](?=[ \t]|$)/, '$1☑')
        .replace(/^([ \t]*>[ \t]?)\[!([A-Za-z]{3,12})\][ \t]*/, (_m, q, k) => `${q}**${CALLOUTS[k.toUpperCase()]?.[1] ?? k}:** `)
        .replace(/\[([^\]\n]{0,200})\]\((?:user|card|page):[A-Za-z0-9_:-]{1,140}\)/g, (_m, t) => t),
    );
  }
  return out.join('\n').replace(/(\]\()(\/uploads\/[A-Za-z0-9._-]{1,80}\))/g, (_m, a, b) => `${a}${absolute(baseUrl, b)}`);
}

/** Markdown from a little HTML (an imported file): links, images, line breaks and text survive, tags and scripts do not. */
export function htmlToMarkdown(html: string): string {
  const src = String(html ?? '').slice(0, MAX_SOURCE);
  let lower: string | undefined;
  let out = '';
  let link: { href: string; text: string } | null = null;
  const add = (t: string) => {
    if (link) link.text += t;
    else out += t;
  };
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      add(decodeEntities(src.slice(i)));
      break;
    }
    if (lt > i) add(decodeEntities(src.slice(i, lt)));
    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt + 4);
      i = e < 0 ? src.length : e + 3;
      continue;
    }
    const tag = readTag(src, lt);
    if (!tag) {
      add('<');
      i = lt + 1;
      continue;
    }
    i = tag.end;
    if (!tag.closing && DROP_WITH_CONTENT.has(tag.name)) {
      lower ??= src.toLowerCase();
      const at = lower.indexOf(`</${tag.name}`, i);
      const e = at < 0 ? -1 : src.indexOf('>', at);
      i = e < 0 ? src.length : e + 1;
      continue;
    }
    if (tag.name === 'br') add('\n');
    else if (/^h[1-6]$/.test(tag.name)) add(tag.closing ? '\n\n' : `\n\n${'#'.repeat(Number(tag.name[1]))} `);
    else if (tag.name === 'li' && !tag.closing) add('\n- ');
    else if ((tag.name === 'strong' || tag.name === 'b') && !link) add('**');
    else if ((tag.name === 'em' || tag.name === 'i') && !link) add('*');
    else if (tag.name === 'code') add('`');
    else if (tag.name === 'hr' && !tag.closing) add('\n\n---\n\n');
    else if (tag.name === 'blockquote' && !tag.closing) add('\n\n> ');
    else if (tag.name === 'img' && !tag.closing) {
      const u = safeImageSrc(decodeEntities(tag.attrs.find(([n]) => n === 'src')?.[1] ?? '').replace(CTRL, ''));
      const alt = decodeEntities(tag.attrs.find(([n]) => n === 'alt')?.[1] ?? '').replace(/[\]\n[]/g, ' ');
      if (u) add(`![${alt}](${u})`);
    } else if (tag.name === 'a' && !tag.closing) {
      link = { href: decodeEntities(tag.attrs.find(([n]) => n === 'href')?.[1] ?? '').replace(CTRL, ''), text: '' };
    } else if (tag.name === 'a' && tag.closing && link) {
      const url = safeHref(link.href);
      const t = link.text.replace(/[\]\n[]/g, ' ').trim();
      const done = link;
      link = null;
      add(url && t ? `[${t}](${url})` : done.text);
    } else if (tag.closing && /^(p|div|li|tr|ul|ol|table|blockquote)$/.test(tag.name)) add('\n');
  }
  if (link) out += (link as { text: string }).text;
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** Line diff (longest common subsequence, capped) for the version comparison. */
export function lineDiff(a: string, b: string, maxLines = 1500): { t: 'same' | 'add' | 'del'; text: string }[] {
  const x = String(a ?? '').split('\n').slice(0, maxLines);
  const y = String(b ?? '').split('\n').slice(0, maxLines);
  let pre = 0;
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let post = 0;
  while (post < x.length - pre && post < y.length - pre && x[x.length - 1 - post] === y[y.length - 1 - post]) post++;
  const xm = x.slice(pre, x.length - post);
  const ym = y.slice(pre, y.length - post);
  const out: { t: 'same' | 'add' | 'del'; text: string }[] = x.slice(0, pre).map((text) => ({ t: 'same' as const, text }));
  if (xm.length * ym.length > 4_000_000) {
    out.push(...xm.map((text) => ({ t: 'del' as const, text })), ...ym.map((text) => ({ t: 'add' as const, text })));
  } else {
    const w = ym.length + 1;
    const dp = new Uint32Array((xm.length + 1) * w);
    for (let i = xm.length - 1; i >= 0; i--) for (let j = ym.length - 1; j >= 0; j--) dp[i * w + j] = xm[i] === ym[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    let i = 0;
    let j = 0;
    while (i < xm.length && j < ym.length) {
      if (xm[i] === ym[j]) {
        out.push({ t: 'same', text: xm[i] });
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) out.push({ t: 'del', text: xm[i++] });
      else out.push({ t: 'add', text: ym[j++] });
    }
    while (i < xm.length) out.push({ t: 'del', text: xm[i++] });
    while (j < ym.length) out.push({ t: 'add', text: ym[j++] });
  }
  out.push(...x.slice(x.length - post).map((text) => ({ t: 'same' as const, text })));
  return out;
}
