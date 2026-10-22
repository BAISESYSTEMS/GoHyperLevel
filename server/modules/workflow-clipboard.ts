import type { Module } from '../core/app.js';
import { bad, notFound } from '../core/http.js';
import { now } from '../core/util.js';
import { walk, type Step } from '../services/workflow-engine.js';
import { cleanSteps } from './workflows.js';

/**
 * Copy and paste steps between workflows (docs/workflow-actions.md → Copy and paste). The web editors keep the clipboard in
 * localStorage in the format `gohigh-steps`; the server does what the JSON import does:
 *
 *   POST /api/workflows/:id/copy   {steps}                → {format: 'gohigh-steps', version: 1, steps, references, source}
 *                                                            (steps checked, secrets of HTTP steps blanked like an export)
 *   POST /api/workflows/:id/paste  {data, existing_ids?}  → {steps, warnings, count}
 *                                                            (new ids for every step, jumps inside the pasted steps rewritten,
 *                                                            references to pipelines, forms … of another sub-account as warnings)
 *
 * Nothing is saved here – the editor inserts the steps and the normal save stores them. Uses the import's helpers
 * (`app.services.workflowImportKit` from modules/wfx-tools.ts).
 */

export const STEPS_FORMAT = 'gohigh-steps';
const MAX_STEPS = 300;
const JUMP_KEYS = ['target', 'timeout_target'] as const;

interface ImportKit {
  reId: (steps: Step[], map: Map<string, string>) => Step[];
  warningsFor: (loc: string, steps: Step[], trigger: unknown) => string[];
  stripSecrets: (steps: Step[]) => Step[];
  refsOf: (steps: Step[], trigger: unknown) => string[];
}

export const workflowClipboardModule: Module = {
  name: 'workflow-clipboard',
  register(app) {
    const kit = (): ImportKit => {
      const k = app.services.workflowImportKit as ImportKit | undefined;
      if (!k) throw bad('Kopieren und Einfügen braucht das Workflow-Import-Modul');
      return k;
    };
    const workflowOf = (loc: string, id: string) => {
      const w = app.db.get<{ id: string; name: string; steps: string }>('SELECT id, name, steps FROM workflows WHERE id = ? AND location_id = ?', id, loc);
      if (!w) throw notFound();
      return w;
    };
    const checked = (input: unknown): Step[] => {
      if (!Array.isArray(input) || !input.length) throw bad('Keine Schritte zum Kopieren');
      const steps = cleanSteps(input);
      if (walk(steps).length > MAX_STEPS) throw bad(`Höchstens ${MAX_STEPS} Schritte auf einmal`);
      return steps;
    };

    app.router.post('/api/workflows/:id/copy', 'location', (ctx) => {
      const w = workflowOf(ctx.locationId, ctx.params.id);
      const steps = kit().stripSecrets(checked(ctx.body?.steps));
      return { format: STEPS_FORMAT, version: 1, copied_at: now(), source: { workflow_id: w.id, workflow: w.name, location_id: ctx.locationId }, steps, references: kit().refsOf(steps, undefined) };
    });

    app.router.post('/api/workflows/:id/paste', 'location', (ctx) => {
      const w = workflowOf(ctx.locationId, ctx.params.id);
      let data = ctx.body?.data;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {
          throw bad('Das ist kein gültiges JSON');
        }
      }
      if (!data || typeof data !== 'object' || data.format !== STEPS_FORMAT) throw bad(`Das sind keine kopierten Workflow-Schritte (Format „${STEPS_FORMAT}“)`);
      if (Number(data.version) > 1) throw bad('Diese Schritte stammen aus einer neueren HyperLevel-Version');
      const steps = kit().reId(checked(data.steps), new Map());
      // Jumps to a step outside the pasted ones only stay when that step is in the workflow being edited.
      const fresh = new Set(walk(steps).map((f) => f.step.id));
      const existing = new Set<string>(Array.isArray(ctx.body?.existing_ids) ? ctx.body.existing_ids.map(String) : walk(JSON.parse(w.steps || '[]')).map((f) => f.step.id));
      const warnings: string[] = [];
      walk(steps).forEach((f, i) => {
        for (const k of JUMP_KEYS) {
          const v = f.step[k];
          if (typeof v === 'string' && v && !fresh.has(v) && !existing.has(v)) {
            f.step[k] = '';
            warnings.push(`Schritt ${i + 1} (${f.step.type}): Sprungziel liegt außerhalb der eingefügten Schritte – bitte neu wählen`);
          }
        }
      });
      return { steps, warnings: [...warnings, ...kit().warningsFor(ctx.locationId, steps, undefined)].slice(0, 40), count: fresh.size };
    });
  },
};
