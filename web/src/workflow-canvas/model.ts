/**
 * Pure operations on a workflow's step tree, shared by the list editor and the canvas (copy, duplicate, move, delete, pause,
 * paste). Steps are the same JSON the server stores (docs/workflow-actions.md): containers hold lanes of their own – Wenn/Sonst
 * `then`/`else`, Split-Test `b0`…`b4`, Schleife `each`. Every function returns a new tree and leaves the input alone.
 */

export type Step = { id: string; type: string; disabled?: boolean; [k: string]: any };

/** Where a step sits or goes: the list `key` of container `parent` (null and `steps` = the top level), at `index`. */
export interface Slot {
  parent: string | null;
  key: string;
  index: number;
}
export const ROOT_KEY = 'steps';

const BRANCH = /^(then|else|each|b\d)$/;
export const laneKeys = (s: Step): string[] => Object.keys(s).filter((k) => BRANCH.test(k) && Array.isArray(s[k]));
export const newId = () => Math.random().toString(36).slice(2, 10);
const JUMPS = ['target', 'timeout_target'] as const;

/** Every step in reading order (containers before their lanes). */
export function flat(steps: Step[]): Step[] {
  return (steps ?? []).flatMap((s) => [s, ...laneKeys(s).flatMap((k) => flat(s[k]))]);
}
export const allIds = (steps: Step[]) => flat(steps).map((s) => s.id);
export const findStep = (steps: Step[], id: string): Step | undefined => flat(steps).find((s) => s.id === id);

/** The list at a container's lane (or the top level). */
export function listAt(steps: Step[], parent: string | null, key: string): Step[] | undefined {
  if (parent === null) return steps;
  const p = findStep(steps, parent);
  return p && Array.isArray(p[key]) ? p[key] : undefined;
}

export function slotOf(steps: Step[], id: string, parent: string | null = null, key = ROOT_KEY): Slot | null {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.id === id) return { parent, key, index: i };
    for (const k of laneKeys(s)) {
      const hit = slotOf(s[k], id, s.id, k);
      if (hit) return hit;
    }
  }
  return null;
}

/** Is `id` the step `ancestor` or somewhere inside its lanes? */
export function isWithin(steps: Step[], id: string, ancestor: string): boolean {
  const a = findStep(steps, ancestor);
  return !!a && flat([a]).some((s) => s.id === id);
}

/** Rewrites one list of the tree (fn gets a copy of it). */
function editList(steps: Step[], parent: string | null, key: string, fn: (list: Step[]) => Step[]): Step[] {
  if (parent === null) return fn([...steps]);
  return steps.map((s) => {
    if (s.id === parent) return { ...s, [key]: fn([...(Array.isArray(s[key]) ? s[key] : [])]) };
    const keys = laneKeys(s);
    if (!keys.length) return s;
    return { ...s, ...Object.fromEntries(keys.map((k) => [k, editList(s[k], parent, key, fn)])) };
  });
}

export function insertAt(steps: Step[], slot: Slot, items: Step[]): Step[] {
  return editList(steps, slot.parent, slot.key, (list) => {
    const at = Math.max(0, Math.min(list.length, slot.index));
    return [...list.slice(0, at), ...items, ...list.slice(at)];
  });
}

export function updateStep(steps: Step[], id: string, fn: (s: Step) => Step): Step[] {
  return steps.map((s) => {
    const next = s.id === id ? fn(s) : s;
    const keys = laneKeys(next);
    return keys.length ? { ...next, ...Object.fromEntries(keys.map((k) => [k, updateStep(next[k], id, fn)])) } : next;
  });
}

export function removeStep(steps: Step[], id: string): Step[] {
  return steps.filter((s) => s.id !== id).map((s) => {
    const keys = laneKeys(s);
    return keys.length ? { ...s, ...Object.fromEntries(keys.map((k) => [k, removeStep(s[k], id)])) } : s;
  });
}

/** Pauses a running step or resumes a paused one (`disabled: true` – the engine skips it). */
export const togglePaused = (steps: Step[], id: string) =>
  updateStep(steps, id, (s) => {
    const { disabled, ...rest } = s;
    return disabled ? rest : { ...rest, disabled: true };
  });

/**
 * Moves a step (with its lanes) to a slot, given as a position in the tree before the move. Null when the target lies inside
 * the step itself.
 */
export function moveStep(steps: Step[], id: string, to: Slot): Step[] | null {
  const from = slotOf(steps, id);
  const step = findStep(steps, id);
  if (!from || !step) return null;
  if (to.parent !== null && isWithin(steps, to.parent, id)) return null;
  const index = to.parent === from.parent && to.key === from.key && to.index > from.index ? to.index - 1 : to.index;
  return insertAt(removeStep(steps, id), { ...to, index }, [step]);
}

/** Deep copies with new ids; jumps between the copied steps follow their copies, jumps to other steps stay. */
export function cloneWithNewIds(items: Step[], makeId: () => string = newId): Step[] {
  const map = new Map<string, string>();
  for (const s of flat(items)) map.set(s.id, makeId());
  const redo = (list: Step[]): Step[] =>
    list.map((s) => {
      const o: Step = { ...JSON.parse(JSON.stringify(s)), id: map.get(s.id)! };
      for (const k of JUMPS) if (typeof o[k] === 'string' && map.has(o[k])) o[k] = map.get(o[k]);
      for (const k of laneKeys(s)) o[k] = redo(s[k]);
      return o;
    });
  return redo(items);
}

/** A copy of the step right after it, with new ids. */
export function duplicateStep(steps: Step[], id: string): { steps: Step[]; copy?: Step } {
  const slot = slotOf(steps, id);
  const step = findStep(steps, id);
  if (!slot || !step) return { steps };
  const [copy] = cloneWithNewIds([step]);
  return { steps: insertAt(steps, { ...slot, index: slot.index + 1 }, [copy]), copy };
}

/** The slot right after a step (where paste and keyboard inserts go), or the end of the top level. */
export function slotAfter(steps: Step[], id?: string | null): Slot {
  const s = id ? slotOf(steps, id) : null;
  return s ? { ...s, index: s.index + 1 } : { parent: null, key: ROOT_KEY, index: steps.length };
}
