/**
 * Numbers per step for the canvas's statistics overlay, from what the editor already loads (GET /api/workflows/:id/runs: the
 * last 300 runs with their slim logs, and `at` – how many contacts wait at each step right now). Pure.
 */

export interface StepStat {
  /** Log lines of the step that went through (a step inside a loop counts once per pass). */
  done: number;
  errors: number;
  /** Skipped because the step was paused. */
  skipped: number;
  /** Contacts waiting at this step now. */
  waiting: number;
}

export function stepStats(runs: { log?: { step?: string; error?: unknown; skipped?: unknown }[] }[] = [], at: Record<string, number> = {}): Record<string, StepStat> {
  const out: Record<string, StepStat> = {};
  const of = (id: string) => (out[id] ??= { done: 0, errors: 0, skipped: 0, waiting: 0 });
  for (const r of runs) {
    for (const l of Array.isArray(r.log) ? r.log : []) {
      if (!l?.step) continue;
      const s = of(String(l.step));
      if (l.error) s.errors++;
      else if (l.skipped) s.skipped++;
      else s.done++;
    }
  }
  for (const [id, n] of Object.entries(at)) of(id).waiting = n;
  return out;
}
