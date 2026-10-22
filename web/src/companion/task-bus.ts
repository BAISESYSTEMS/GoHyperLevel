import { useEffect, useState } from 'react';

/**
 * Hintergrundaufgaben des Companions (1.0.54) – the small shared part: what the agent is working on in this tab (label, status) and who
 * is looking at which run. companion/tasks.ts (in the focus chunk) reports every run here; the edge button (CompanionLayer) and focus
 * mode's task list read it, and the layer announces a run that ends while nobody is looking ("Erledigt: …" by voice and a toast).
 * No agent code here, so the layer that is on every page stays small.
 */

export type TaskStatus = 'running' | 'confirm' | 'done' | 'failed' | 'stopped';
export interface TaskInfo {
  id: string;
  label: string;
  status: TaskStatus;
  startedAt: number;
  endedAt?: number;
  /** the agent's last words (a few sentences) or the error */
  text?: string;
  /** the confirmation card's title while it waits */
  confirmTitle?: string;
}

const MAX = 8;
let list: TaskInfo[] = [];
let viewing: string | null = null;
const subs = new Set<() => void>();
const settled = new Set<(t: TaskInfo, watched: boolean) => void>();
const emit = () => subs.forEach((f) => f());

export const taskBus = {
  get list() {
    return list;
  },
  /** A run started or changed; `settledNow` = it just ended or now waits for a confirmation. */
  report(t: TaskInfo, settledNow = false) {
    const i = list.findIndex((x) => x.id === t.id);
    list = i >= 0 ? list.map((x) => (x.id === t.id ? t : x)) : [t, ...list].slice(0, MAX);
    emit();
    if (settledNow) {
      const watched = viewing === t.id && typeof document !== 'undefined' && !document.hidden;
      settled.forEach((f) => f(t, watched));
    }
  },
  remove(id: string) {
    list = list.filter((x) => x.id !== id);
    emit();
  },
  /** focus mode shows this run right now (its end is spoken there, not announced) */
  setViewing(id: string | null) {
    viewing = id;
  },
  get viewing() {
    return viewing;
  },
  on(fn: () => void) {
    subs.add(fn);
    return () => void subs.delete(fn);
  },
  onSettled(fn: (t: TaskInfo, watched: boolean) => void) {
    settled.add(fn);
    return () => void settled.delete(fn);
  },
};

export function useTaskList(): TaskInfo[] {
  const [, tick] = useState(0);
  useEffect(() => taskBus.on(() => tick((n) => n + 1)), []);
  return list;
}
