import { escapeHtml } from '../core/template.js';

/**
 * A small, safe Markdown renderer for blog posts and course lessons. Everything is escaped first,
 * so authors can never inject HTML or script; only the syntax below turns into tags.
 *
 * Blocks: # headings, paragraphs, - / 1. lists, > quotes, ``` code, --- rules, and a line that is
 * only a YouTube/Vimeo/Loom/MP4 link becomes an embedded player (with `embeds`).
 * Inline: **bold**, *italic*, ~~strike~~, `code`, [link](url), ![image](url), bare https:// links.
 */

const SAFE_URL = /^(https?:\/\/|\/|#|mailto:|tel:)/i;
export const safeUrl = (u: unknown): string => {
  const s = String(u ?? '').trim();
  return SAFE_URL.test(s) ? s : '#';
};

/** A URL for CSS `url("…")` in a style attribute: quotes, brackets and spaces percent-encoded. */
export const cssUrl = (u: unknown): string => escapeHtml(safeUrl(u).replace(/["'()\\\s<>]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`));

export type Embed = { kind: 'iframe' | 'video'; src: string };

/** YouTube, Vimeo, Loom or a direct video file (https) → something the browser can play. */
export function videoEmbed(url: unknown): Embed | null {
  const s = String(url ?? '').trim();
  if (!/^https:\/\//i.test(s)) return null;
  const yt = s.match(/(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{6,})/i);
  if (yt) return { kind: 'iframe', src: `https://www.youtube-nocookie.com/embed/${yt[1]}?rel=0` };
  const vm = s.match(/vimeo\.com\/(?:video\/)?(\d+)(?:\/([0-9a-f]{6,}))?/i);
  if (vm) return { kind: 'iframe', src: `https://player.vimeo.com/video/${vm[1]}${vm[2] ? `?h=${vm[2]}` : ''}` };
  const loom = s.match(/loom\.com\/(?:share|embed)\/([0-9a-f]{16,})/i);
  if (loom) return { kind: 'iframe', src: `https://www.loom.com/embed/${loom[1]}` };
  if (/\.(mp4|webm|m4v|mov|ogg)(\?[^\s]*)?$/i.test(s)) return { kind: 'video', src: s };
  return null;
}

export function embedHtml(e: Embed, title = 'Video'): string {
  return e.kind === 'iframe'
    ? `<div class="md-video"><iframe src="${escapeHtml(e.src)}" title="${escapeHtml(title)}" loading="lazy" allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowfullscreen></iframe></div>`
    : `<div class="md-video"><video src="${escapeHtml(e.src)}" controls preload="metadata" playsinline></video></div>`;
}

/** Inline syntax on one line (or a paragraph joined with <br>). */
function inline(src: string): string {
  const keep: string[] = [];
  const hold = (html: string) => `\u0000${keep.push(html) - 1}\u0000`;
  let s = escapeHtml(src);
  const url = (u: string) => escapeHtml(safeUrl(u.replace(/&amp;/g, '&')));
  // Code spans first: nothing inside them is formatted.
  s = s.replace(/`([^`\n]+)`/g, (_m, c) => hold(`<code>${c}</code>`));
  // URLs may hold one level of (…) but never a bare "(": otherwise "[a](" repeated makes every match scan to the
  // end of the text (quadratic – a DoS through member posts).
  s = s.replace(/!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (_m, alt, u) => hold(`<img src="${url(u)}" alt="${alt}" loading="lazy">`));
  s = s.replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (_m, t, u) => {
    const href = url(u);
    const ext = /^https?:/i.test(href) ? ' rel="noopener" target="_blank"' : '';
    return hold(`<a href="${href}"${ext}>${format(t)}</a>`);
  });
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, (_m, pre, u) => `${pre}${hold(`<a href="${url(u)}" rel="noopener" target="_blank">${u}</a>`)}`);
  s = format(s);
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => keep[Number(i)]);
}

function format(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?!\s)(.+?)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>');
}

const UL = /^\s*[-*+•]\s+(.*)$/;
const OL = /^\s*(\d{1,4})[.)]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

export function renderMarkdown(src: string, opts: { embeds?: boolean } = {}): string {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (!para.length) return;
    const text = para.join('\n').trim();
    para = [];
    if (!text) return;
    const e = opts.embeds && !text.includes('\n') ? videoEmbed(text) : null;
    out.push(e ? embedHtml(e) : `<p>${inline(text).replace(/\n/g, '<br>')}</p>`);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = line.match(HEADING);
    if (h) {
      flush();
      // The page title is the only <h1>; "#" in the text becomes a section heading.
      const lvl = Math.min(Math.max(h[1].length, 2), 4);
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      continue;
    }
    if (RULE.test(line)) {
      flush();
      out.push('<hr>');
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const quote: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*>\s?/, ''));
      i--;
      out.push(`<blockquote>${renderMarkdown(quote.join('\n'), opts)}</blockquote>`);
      continue;
    }
    const ul = UL.test(line);
    const ol = !ul && OL.test(line);
    if (ul || ol) {
      flush();
      const items: string[] = [];
      const re = ul ? UL : OL;
      const start = ol ? Number(line.match(OL)![1]) : 1;
      for (; i < lines.length; i++) {
        const m = lines[i].match(re);
        if (m) items.push(ul ? m[1] : m[2]);
        else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) items[items.length - 1] += `\n${lines[i].trim()}`;
        else break;
      }
      i--;
      const lis = items.map((t) => `<li>${inline(t).replace(/\n/g, '<br>')}</li>`).join('');
      out.push(ul ? `<ul>${lis}</ul>` : `<ol${start !== 1 ? ` start="${start}"` : ''}>${lis}</ol>`);
      continue;
    }
    para.push(line);
  }
  flush();
  return out.join('\n');
}

/** Plain text for excerpts, meta descriptions and feeds. */
export function stripMarkdown(src: string): string {
  return String(src ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*([-*_])(\s*\1){2,}\s*$/gm, ' ')
    .replace(/!\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '')
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+•]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\s)[*_](\S[^*_]*)[*_]/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cuts plain text at a word boundary. */
export function excerptOf(text: string, max = 200): string {
  const s = text.trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 30)).replace(/[\s,.;:–-]+$/, '')} …`;
}

/** Minutes to read at ~200 words per minute (at least 1). */
export function readingMinutes(src: string): number {
  return Math.max(1, Math.round(stripMarkdown(src).split(/\s+/).filter(Boolean).length / 200));
}
