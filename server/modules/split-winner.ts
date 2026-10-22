import type { Module } from '../core/app.js';
import { now } from '../core/util.js';
import { ALPHA, MIN_CONVERSIONS, MIN_VISITORS, zTest } from '../services/ab-stats.js';
import { walk, type Step } from '../services/workflow-engine.js';

/**
 * Split test with an automatic winner (docs/workflow-actions.md#split-test-winner): the option „Gewinner automatisch übernehmen“ on
 * the step *Split-Test*. On the tick (at most every ten minutes) every active workflow with such a step is checked: when each path
 * has at least 100 contacts, together at least 10 reached goals, and the path with the best goal rate beats every other one
 * significantly (two-proportion z-test, p < 0.05), it gets 100 % and the others 0 %. The decision is written on the step
 * (`auto_winner_result`) so it is never taken twice; switching the option off and on again starts a new round.
 */

const FIELD = {
  key: 'auto_winner',
  label: 'Gewinner automatisch übernehmen',
  type: 'bool' as const,
  help: 'Ab 100 Kontakten je Pfad und einem signifikanten Vorsprung bei den erreichten Zielen bekommt der beste Pfad 100 %.',
};
const EVERY_MS = 10 * 60_000;

export interface PathCount {
  index: number;
  name: string;
  assigned: number;
  goals: number;
}

/** The winning path, or null while it is too early or no path is clearly better. */
export function decideWinner(paths: PathCount[]): { index: number; name: string; rate: number; p: number } | null {
  if (paths.length < 2 || paths.some((p) => p.assigned < MIN_VISITORS)) return null;
  if (paths.reduce((s, p) => s + p.goals, 0) < MIN_CONVERSIONS) return null;
  const rate = (p: PathCount) => p.goals / p.assigned;
  const best = [...paths].sort((a, b) => rate(b) - rate(a))[0];
  let worstP = 0;
  for (const other of paths) {
    if (other.index === best.index) continue;
    if (rate(other) >= rate(best)) return null;
    const z = zTest({ visitors: other.assigned, conversions: other.goals }, { visitors: best.assigned, conversions: best.goals });
    if (!z || z.p >= ALPHA) return null;
    worstP = Math.max(worstP, z.p);
  }
  return { index: best.index, name: best.name, rate: Math.round(rate(best) * 1000) / 10, p: Math.round(worstP * 10000) / 10000 };
}

export const splitWinnerModule: Module = {
  name: 'split-winner',
  register(app) {
    const { db } = app;
    // The option on the step's form (the step itself lives in services/wfx-flow.ts).
    const meta = app.services.workflowActionMeta?.split_test as { fields: { key: string }[] } | undefined;
    if (meta && !meta.fields.some((f) => f.key === FIELD.key)) meta.fields = [...meta.fields, FIELD];

    const counts = (workflowId: string, stepId: string): PathCount[] =>
      db.all<PathCount>(
        `SELECT s.variant AS "index", s.name AS name, COUNT(*) AS assigned,
                SUM(CASE WHEN EXISTS (SELECT 1 FROM json_each(r.log) j WHERE json_extract(j.value, '$.type') IN ('goal','goal_jump') AND json_extract(j.value, '$.result') LIKE 'erreicht%') THEN 1 ELSE 0 END) AS goals
         FROM wfx_split s JOIN workflow_runs r ON r.id = s.run_id
         WHERE s.workflow_id = ? AND s.step_id = ? GROUP BY s.variant, s.name ORDER BY s.variant`,
        workflowId,
        stepId,
      );

    /** Checks every active workflow with an auto-winner split test once; returns the decisions taken. */
    function check(): { workflowId: string; stepId: string; winner: string }[] {
      const decided: { workflowId: string; stepId: string; winner: string }[] = [];
      const flows = db.all<{ id: string; steps: string }>(`SELECT id, steps FROM workflows WHERE status = 'active' AND steps LIKE '%"auto_winner":true%'`);
      for (const wf of flows) {
        let steps: Step[];
        try {
          steps = JSON.parse(wf.steps);
        } catch {
          continue;
        }
        let changed = false;
        for (const { step } of walk(steps)) {
          const s = step as any;
          if (s.type !== 'split_test' || s.auto_winner !== true || s.auto_winner_result || !Array.isArray(s.variants)) continue;
          const paths = counts(wf.id, s.id).filter((p) => p.index < s.variants.length);
          if (paths.length < s.variants.length) continue;
          const win = decideWinner(paths);
          if (!win) continue;
          s.variants = s.variants.map((v: any, i: number) => ({ ...v, weight: i === win.index ? 100 : 0 }));
          s.auto_winner_result = { variant: win.index, name: win.name, goal_rate: win.rate, p: win.p, decided_at: now() };
          decided.push({ workflowId: wf.id, stepId: s.id, winner: win.name });
          changed = true;
        }
        if (changed) db.run('UPDATE workflows SET steps = ?, updated_at = ? WHERE id = ?', JSON.stringify(steps), now(), wf.id);
      }
      return decided;
    }
    let last = 0;
    app.onTick(() => {
      if (Date.now() - last < EVERY_MS) return;
      last = Date.now();
      try {
        check();
      } catch (e) {
        console.error('[split-winner]', (e as Error).message);
      }
    });
    app.services.splitWinnerCheck = check;
  },
};
