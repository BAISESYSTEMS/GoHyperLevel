import { lookup } from '../core/template.js';

/**
 * Bedingte Inhalte in E-Mails, SMS und Vorlagen – docs/email-marketing.md#conditional-content (pure).
 *
 *   {{#if contact.tags has "VIP"}}Ihr VIP-Rabatt: 20 %{{else}}Jetzt 10 % sichern{{/if}}
 *   {{#if contact.city == "Köln"}}…{{/if}}   {{#if contact.custom.budget >= 5000}}…{{/if}}   {{#unless contact.phone}}…{{/unless}}
 *
 * Operators: `==`, `!=`, `contains` / `enthält`, `has` / `hat` (list contains, e.g. tags), `>`, `>=`, `<`, `<=`; without one the
 * field only has to be filled. Comparisons ignore case; quotes may be "…", '…' or the HTML-escaped forms the e-mail designer
 * writes. Blocks nest. A malformed block is left as it is (never a broken mail).
 *
 * Templates come from sub-account users and this pass runs in the single-threaded server, so it stays linear: one hand-written scan
 * for the tags (no backtracking regex), the blocks paired with a stack, and a template above MAX_TEMPLATE is left as it is.
 */

/** Longest template (characters) the conditional pass reads – a bigger one goes out unchanged. */
export const MAX_TEMPLATE = 2_000_000;
const decode = (s: string) => s.replace(/&quot;|&#34;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

const asList = (v: unknown): unknown[] | undefined => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim().startsWith('[')) {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
};
const filled = (v: unknown) => {
  if (v === undefined || v === null || v === false) return false;
  const l = asList(v);
  if (l) return l.length > 0;
  const s = String(v).trim().toLowerCase();
  return s !== '' && s !== '0' && s !== 'false' && s !== 'nein';
};
const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();
const number = (v: unknown) => {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};

/** Evaluates one condition against the template data. */
export function testCondition(expr: string, data: Record<string, unknown>): boolean {
  const e = decode(expr).trim();
  // A word operator needs a space before it, so the field name cannot backtrack into it ("hashas…has x" stays linear).
  const m = e.match(/^(!|not\s+|nicht\s+)?([\w.]+)(?:(?:\s*(==|!=|>=|<=|>|<)|\s+(contains|enthält|has|hat))\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?$/i);
  if (!m) return false;
  const [, neg, path, symOp, wordOp, q1, q2, bare] = m;
  const op = symOp ?? wordOp;
  const want = q1 ?? q2 ?? bare ?? '';
  const v = lookup(data, path);
  let r: boolean;
  switch ((op ?? '').toLowerCase()) {
    case '':
      r = filled(v);
      break;
    case '==':
      r = norm(v) === norm(want);
      break;
    case '!=':
      r = norm(v) !== norm(want);
      break;
    case 'contains':
    case 'enthält': {
      const l = asList(v);
      r = l ? l.some((x) => norm(x).includes(norm(want))) : norm(v).includes(norm(want));
      break;
    }
    case 'has':
    case 'hat': {
      const l = asList(v);
      r = l ? l.some((x) => norm(x) === norm(want)) : norm(v) === norm(want);
      break;
    }
    default: {
      const a = number(v);
      const b = number(want);
      if (Number.isNaN(a) || Number.isNaN(b)) r = false;
      else r = op === '>' ? a > b : op === '>=' ? a >= b : op === '<' ? a < b : a <= b;
    }
  }
  return neg ? !r : r;
}

/** One block tag: `{{#if …}}` / `{{#unless …}}` (with its condition), `{{else}}`, `{{/if}}` or `{{/unless}}`; `end` is after the `}}`. */
type Tag = { at: number; end: number; type: 'open' | 'else' | 'close'; kind: string; expr: string };

const WS = /\s*/y;
/** First index at or after `i` that is not whitespace (the set of `\s` and trim()). */
const skipWs = (s: string, i: number) => {
  WS.lastIndex = i;
  WS.exec(s);
  return WS.lastIndex;
};
const isWs = (s: string, i: number) => i < s.length && /\s/.test(s.charAt(i));
const blockKind = (s: string, i: number) => (s.startsWith('if', i) ? 'if' : s.startsWith('unless', i) ? 'unless' : '');

/**
 * Every block tag in `tpl`, left to right and non-overlapping – what `\{\{\s*(#(if|unless)\s[^}]*|else|\/(if|unless))\s*\}\}` finds,
 * in linear time: a tag ends at the first `}` after its `{{`, which has to be followed by a second `}`.
 */
function scanTags(tpl: string): Tag[] {
  const tags: Tag[] = [];
  let brace = -1;
  for (let at = tpl.indexOf('{{'); at >= 0; ) {
    if (brace < at + 2) brace = tpl.indexOf('}', at + 2);
    if (brace < 0) break;
    let tag: Tag | null = null;
    if (tpl.charCodeAt(brace + 1) === 125 /* } */) {
      const p = skipWs(tpl, at + 2);
      const end = brace + 2;
      if (tpl.charAt(p) === '#') {
        const kind = blockKind(tpl, p + 1);
        const from = p + 1 + kind.length;
        if (kind && from < brace && isWs(tpl, from)) tag = { at, end, type: 'open', kind, expr: tpl.slice(from, brace).trim() };
      } else if (tpl.charAt(p) === '/') {
        const kind = blockKind(tpl, p + 1);
        if (kind && skipWs(tpl, p + 1 + kind.length) === brace) tag = { at, end, type: 'close', kind, expr: '' };
      } else if (tpl.startsWith('else', p) && skipWs(tpl, p + 4) === brace) tag = { at, end, type: 'else', kind: '', expr: '' };
    }
    if (tag) tags.push(tag);
    at = tpl.indexOf('{{', tag ? tag.end : at + 1);
  }
  return tags;
}

/** Resolves every condition block in `tpl` (inner blocks of the chosen branch included). */
export function applyConditions(tpl: string, data: Record<string, unknown>, depth = 0): string {
  if (!tpl || !tpl.includes('{{') || depth > 20 || tpl.length > MAX_TEMPLATE) return tpl;
  const tags = scanTags(tpl);
  // Pair each opener with the `{{else}}` and closing tag on its own level: any closing tag ends the innermost open block, one of
  // the wrong kind leaves that opener as it is.
  const elseOf = new Map<Tag, Tag>();
  const closeOf = new Map<Tag, Tag>();
  const stack: Tag[] = [];
  for (const t of tags) {
    if (t.type === 'open') stack.push(t);
    else if (t.type === 'else') {
      const top = stack[stack.length - 1];
      if (top && !elseOf.has(top)) elseOf.set(top, t);
    } else {
      const top = stack.pop();
      if (top && top.kind === t.kind) closeOf.set(top, t);
    }
  }
  let out = '';
  let pos = 0;
  for (const t of tags) {
    const close = t.type === 'open' && t.at >= pos ? closeOf.get(t) : undefined;
    if (!close) continue;
    const els = elseOf.get(t);
    const yes = tpl.slice(t.end, els ? els.at : close.at);
    const no = els ? tpl.slice(els.end, close.at) : '';
    const ok = testCondition(t.expr, data);
    out += tpl.slice(pos, t.at) + applyConditions((t.kind === 'unless' ? !ok : ok) ? yes : no, data, depth + 1);
    pos = close.end;
  }
  return out + tpl.slice(pos);
}
