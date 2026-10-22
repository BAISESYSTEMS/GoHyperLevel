import { bad } from '../core/http.js';

/**
 * Discussion under a lesson and reviews of a course – the pure parts: cleaning what members write, building the thread tree
 * (replies up to a depth, hidden comments gone) and the numbers of a review summary.
 */

export const COMMENT_MAX = 2000;
export const COMMENT_MIN = 2;
export const MAX_DEPTH = 3;

/** Plain text only: tags stay visible as text (they are escaped when printed), control characters and long blank runs go. */
export function cleanText(v: unknown, field: string, opts: { min?: number; max: number }): string {
  const s = String(v ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e\ufeff]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (opts.min && s.length < opts.min) throw bad(`${field}: bitte etwas schreiben`);
  if (s.length > opts.max) throw bad(`${field}: höchstens ${opts.max} Zeichen`);
  return s;
}

export interface CommentRow {
  id: string;
  parent_id: string | null;
  status: string;
  created_at: string;
  [k: string]: any;
}
export type Threaded<T extends CommentRow> = T & { replies: Threaded<T>[]; depth: number };

/**
 * Comments → trees. Top level newest first, replies oldest first (a conversation reads downwards). Hidden comments are dropped with
 * everything below them; a reply whose parent is gone becomes a top-level comment. Replies deeper than `maxDepth` hang on the deepest level.
 */
export function buildThreads<T extends CommentRow>(rows: T[], opts: { includeHidden?: boolean; maxDepth?: number } = {}): Threaded<T>[] {
  const maxDepth = opts.maxDepth ?? MAX_DEPTH;
  const visible = opts.includeHidden ? rows : rows.filter((r) => r.status === 'visible');
  const byId = new Map(visible.map((r) => [r.id, r]));
  const node = new Map<string, Threaded<T>>(visible.map((r) => [r.id, { ...r, replies: [], depth: 1 }]));
  const host = new Map<string, string | null>();
  const visiting = new Set<string>();
  /** Where a comment hangs: under its parent – or, below the depth limit, next to its parent. */
  const place = (r: T): void => {
    if (host.has(r.id)) return;
    const parent = r.parent_id ? byId.get(r.parent_id) : undefined;
    if (!parent || visiting.has(r.id)) {
      host.set(r.id, null);
      return;
    }
    visiting.add(r.id);
    place(parent);
    visiting.delete(r.id);
    if (host.has(r.id)) return; // a loop was cut here
    let h = parent;
    if (node.get(parent.id)!.depth >= maxDepth) h = byId.get(host.get(parent.id) ?? '') ?? parent;
    host.set(r.id, h.id);
    node.get(r.id)!.depth = node.get(h.id)!.depth + 1;
  };
  const roots: Threaded<T>[] = [];
  for (const r of visible) {
    place(r);
    const h = host.get(r.id);
    if (h) node.get(h)!.replies.push(node.get(r.id)!);
    else roots.push(node.get(r.id)!);
  }
  const sortReplies = (list: Threaded<T>[]) => {
    list.sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const n of list) sortReplies(n.replies);
  };
  for (const n of roots) sortReplies(n.replies);
  roots.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return roots;
}

/** The comment a reply is attached to: replies to replies at the depth limit attach to their own parent. */
export function replyTarget(rows: { id: string; parent_id: string | null }[], parentId: string, maxDepth = MAX_DEPTH): string {
  const byId = new Map(rows.map((r) => [r.id, r]));
  let depth = 1;
  for (let cur = byId.get(parentId); cur?.parent_id && byId.has(cur.parent_id) && depth < 20; cur = byId.get(cur.parent_id)) depth++;
  if (depth < maxDepth) return parentId;
  return byId.get(parentId)?.parent_id ?? parentId;
}

export interface RatingSummary {
  count: number;
  average: number;
  /** [1★ … 5★] counts. */
  distribution: number[];
}

export function ratingSummary(ratings: number[]): RatingSummary {
  const distribution = [0, 0, 0, 0, 0];
  let sum = 0;
  let n = 0;
  for (const r of ratings) {
    const i = Math.round(Number(r));
    if (!(i >= 1 && i <= 5)) continue;
    distribution[i - 1]++;
    sum += i;
    n++;
  }
  return { count: n, average: n ? Math.round((sum / n) * 10) / 10 : 0, distribution };
}

export const cleanRating = (v: unknown): number => {
  const n = Math.round(Number(v));
  if (!(n >= 1 && n <= 5)) throw bad('Bitte 1 bis 5 Sterne vergeben');
  return n;
};

export const stars = (n: number) => '★'.repeat(Math.max(0, Math.min(5, Math.round(n)))) + '☆'.repeat(5 - Math.max(0, Math.min(5, Math.round(n))));
