/**
 * Matching for Ctrl/⌘+K (nav.tsx → CommandPalette): how well a typed query fits a command, so the best hit comes first instead
 * of the first one in a fixed list. Pure – tests/nav-palette.test.ts.
 */

/** Lower case without accents ("Kanäle" → "kanale"), so umlauts and their plain spelling both match. */
export const normText = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

/**
 * The whole label 100, its start 80, the start of a word in it 60, anywhere in the label 40, every typed word somewhere in
 * label or extra words (hint, keywords, route) 20, else 0. An empty query matches everything with 1.
 */
export function scoreMatch(q: string, label: string, extra = ''): number {
  const n = normText(q.trim());
  if (!n) return 1;
  const l = normText(label);
  if (l === n) return 100;
  if (l.startsWith(n)) return 80;
  if (l.split(/[\s›·:/&(),–-]+/).some((w) => w.startsWith(n))) return 60;
  if (l.includes(n)) return 40;
  const hay = `${l} ${normText(extra)}`;
  return n.split(/\s+/).every((w) => hay.includes(w)) ? 20 : 0;
}
