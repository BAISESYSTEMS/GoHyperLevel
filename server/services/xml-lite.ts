/**
 * A small, safe XML reader for e-invoices (XRechnung, ZUGFeRD/Factur-X) and bank statements (CAMT.053).
 * Namespace prefixes are dropped, DOCTYPE and custom entities are ignored (nothing is ever expanded or fetched),
 * depth and size are limited. Not a general XML parser: no validation, no mixed-content handling.
 */

export interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  text: string;
}

const MAX_DEPTH = 64;
const MAX_NODES = 400_000;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const decode = (s: string) =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e] ?? m;
  });

const local = (n: string) => n.slice(n.indexOf(':') + 1);

export function parseXml(src: string): XNode {
  const root: XNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XNode[] = [root];
  let nodes = 0;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      stack[stack.length - 1].text += decode(src.slice(i));
      break;
    }
    if (lt > i) stack[stack.length - 1].text += decode(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      stack[stack.length - 1].text += src.slice(lt + 9, end < 0 ? n : end);
      i = end < 0 ? n : end + 3;
    } else if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      i = end < 0 ? n : end + 2;
    } else if (src.startsWith('<!', lt)) {
      // DOCTYPE (possibly with an internal subset in brackets): skipped, never interpreted.
      let depth = 0;
      let j = lt + 2;
      for (; j < n; j++) {
        if (src[j] === '[') depth++;
        else if (src[j] === ']') depth--;
        else if (src[j] === '>' && depth <= 0) break;
      }
      i = j + 1;
    } else if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt + 2);
      if (stack.length > 1) stack.pop();
      i = end < 0 ? n : end + 1;
    } else {
      // Start tag: find its end, honouring quotes in attribute values.
      let j = lt + 1;
      let quote = '';
      for (; j < n; j++) {
        const c = src[j];
        if (quote) {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
      }
      const body = src.slice(lt + 1, j);
      const selfClose = body.endsWith('/');
      const m = /^([^\s/>]+)([\s\S]*?)\/?$/.exec(body);
      if (!m) throw new Error('Ungültiges XML');
      const node: XNode = { name: local(m[1]), attrs: {}, children: [], text: '' };
      for (const a of m[2].matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) if (!/^xmlns(:|$)/.test(a[1])) node.attrs[local(a[1])] = decode(a[3] ?? a[4] ?? '');
      if (++nodes > MAX_NODES) throw new Error('XML zu groß');
      stack[stack.length - 1].children.push(node);
      if (!selfClose) {
        if (stack.length >= MAX_DEPTH) throw new Error('XML zu tief verschachtelt');
        stack.push(node);
      }
      i = j + 1;
    }
  }
  return root.children[0] ?? root;
}

/** Direct children named `name`. */
export const kids = (n: XNode | undefined, name: string): XNode[] => (n ? n.children.filter((c) => c.name === name) : []);

/** Follows a path of child names ("A/B/C") and returns the first node there. */
export function at(n: XNode | undefined, path: string): XNode | undefined {
  let cur = n;
  for (const seg of path.split('/')) {
    if (!cur) return undefined;
    cur = cur.children.find((c) => c.name === seg);
  }
  return cur;
}

/** All nodes at the end of a path ("A/B/C"), fanning out over repeated elements. */
export function allAt(n: XNode | undefined, path: string): XNode[] {
  let cur: XNode[] = n ? [n] : [];
  for (const seg of path.split('/')) cur = cur.flatMap((c) => kids(c, seg));
  return cur;
}

/** Trimmed text at a path. */
export const textAt = (n: XNode | undefined, path: string): string => at(n, path)?.text.trim() ?? '';

/** First descendant (depth-first) with this name. */
export function deep(n: XNode | undefined, name: string): XNode | undefined {
  if (!n) return undefined;
  for (const c of n.children) {
    if (c.name === name) return c;
    const d = deep(c, name);
    if (d) return d;
  }
  return undefined;
}

export function deepAll(n: XNode | undefined, name: string, out: XNode[] = []): XNode[] {
  if (!n) return out;
  for (const c of n.children) {
    if (c.name === name) out.push(c);
    deepAll(c, name, out);
  }
  return out;
}
