/**
 * Task hierarchy, pure: subtasks of subtasks, with limits. Used by the routes (validation) and the views
 * (ordering, progress). `parentOf` maps a task id to its parent id (or null/undefined for top-level tasks).
 */

export const MAX_DEPTH = 6;
export const MAX_SUBTASKS_PER_TASK = 200;

export type ParentMap = Map<string, string | null | undefined>;

export class TreeError extends Error {
  constructor(
    public code: 'self' | 'cycle' | 'depth' | 'unknown',
    message: string,
  ) {
    super(message);
  }
}

/** Ancestors from the direct parent up to the root. Stops (and returns what it has) on a broken chain. */
export function ancestors(parentOf: ParentMap, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  let cur = parentOf.get(id);
  while (cur && !seen.has(cur)) {
    out.push(cur);
    seen.add(cur);
    cur = parentOf.get(cur);
  }
  return out;
}

/** 1 for a top-level task, 2 for its subtask … */
export const depthOf = (parentOf: ParentMap, id: string): number => ancestors(parentOf, id).length + 1;

export function childrenOf(parentOf: ParentMap): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const [id, p] of parentOf) if (p) m.set(p, [...(m.get(p) ?? []), id]);
  return m;
}

export function descendants(parentOf: ParentMap, id: string): string[] {
  const kids = childrenOf(parentOf);
  const out: string[] = [];
  const stack = [...(kids.get(id) ?? [])];
  const seen = new Set<string>([id]);
  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    stack.push(...(kids.get(n) ?? []));
  }
  return out;
}

/** How many levels the task's own subtree has below it (0 = no subtasks). */
export function subtreeHeight(parentOf: ParentMap, id: string): number {
  const kids = childrenOf(parentOf);
  const walk = (n: string, seen: Set<string>): number => {
    let h = 0;
    for (const k of kids.get(n) ?? []) if (!seen.has(k)) h = Math.max(h, 1 + walk(k, new Set([...seen, k])));
    return h;
  };
  return walk(id, new Set([id]));
}

/**
 * May `task` become a subtask of `parent` (null = top level)? Refuses itself, its own descendants (a cycle) and
 * anything that would nest deeper than MAX_DEPTH levels – counting the task's own subtasks too.
 */
export function assertParent(parentOf: ParentMap, task: string, parent: string | null | undefined, maxDepth = MAX_DEPTH): void {
  if (!parent) return;
  if (parent === task) throw new TreeError('self', 'Eine Aufgabe kann nicht ihre eigene Unteraufgabe sein');
  if (!parentOf.has(parent)) throw new TreeError('unknown', 'Übergeordnete Aufgabe nicht gefunden');
  if (ancestors(parentOf, parent).includes(task)) throw new TreeError('cycle', 'Die Aufgabe wäre ihre eigene Unteraufgabe (Zirkelbezug)');
  const depth = depthOf(parentOf, parent) + 1 + subtreeHeight(parentOf, task);
  if (depth > maxDepth) throw new TreeError('depth', `Unteraufgaben lassen sich höchstens ${maxDepth - 1} Ebenen tief verschachteln`);
}

/** Is `a` an ancestor or descendant of `b`? (Such tasks may not depend on each other.) */
export const related = (parentOf: ParentMap, a: string, b: string): boolean => ancestors(parentOf, a).includes(b) || ancestors(parentOf, b).includes(a);

export interface FlatNode<T> {
  item: T;
  depth: number;
}

/**
 * Depth-first order for a list view: every task is followed by its subtasks. Items whose parent is not in the
 * list (filtered out, other project) count as top level. `compare` orders siblings.
 */
export function flatten<T extends { id: string; parent_id?: string | null }>(items: T[], compare: (a: T, b: T) => number = () => 0, collapsed: Set<string> = new Set()): FlatNode<T>[] {
  const ids = new Set(items.map((i) => i.id));
  const kids = new Map<string, T[]>();
  const roots: T[] = [];
  for (const it of items) {
    if (it.parent_id && ids.has(it.parent_id)) kids.set(it.parent_id, [...(kids.get(it.parent_id) ?? []), it]);
    else roots.push(it);
  }
  const out: FlatNode<T>[] = [];
  const seen = new Set<string>();
  const walk = (list: T[], depth: number) => {
    for (const it of [...list].sort(compare)) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      out.push({ item: it, depth });
      if (!collapsed.has(it.id)) walk(kids.get(it.id) ?? [], depth + 1);
    }
  };
  walk(roots, 0);
  return out;
}

/** Done subtasks out of all subtasks below a task (the whole subtree), for the progress bar. */
export function progressOf(parentOf: ParentMap, doneOf: (id: string) => boolean, id: string): { done: number; total: number } {
  const all = descendants(parentOf, id);
  return { done: all.filter(doneOf).length, total: all.length };
}
