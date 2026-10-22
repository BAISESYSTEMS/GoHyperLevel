import type { Module } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { HttpError, bad, notFound, str } from '../core/http.js';
import { id, now, safeEqual, token } from '../core/util.js';
import { upsertContact } from '../services/contacts.js';
import { deliveryIdOf, firstSeen } from '../services/channel-kit.js';
import { hasIdentity } from '../services/inbound-webhooks.js';
import { designFields } from '../services/email-design.js';
import { cleanErrorSettings } from '../services/workflow-errors.js';
import { TRIGGERS, branchKeys, installWorkflowEngine, processRun, startWorkflow, walk, type Step } from '../services/workflow-engine.js';

const STEP_TYPES = [
  'send_email', 'send_sms', 'wait', 'if', 'goal', 'end', 'add_tag', 'remove_tag', 'update_field', 'set_dnd',
  'create_opportunity', 'move_opportunity', 'set_opportunity_status', 'create_task', 'add_note', 'notify',
  'webhook', 'review_request', 'add_to_workflow', 'remove_from_workflow',
];

let extraSteps: () => string[] = () => [];
/** Modules may normalise/validate the settings of their steps when a workflow is saved (app.services.workflowStepCleaners). */
let stepCleaners: () => Record<string, (step: Step) => void> = () => ({});

export function cleanSteps(input: unknown, depth = 0): Step[] {
  if (!Array.isArray(input)) return [];
  if (depth > 8) throw bad('Zu tief verschachtelt');
  return input.slice(0, 300).map((s: any) => {
    if (!STEP_TYPES.includes(s?.type) && !extraSteps().includes(s?.type)) throw bad(`Unbekannter Schritt: ${s?.type}`);
    const out: Step = { ...s, id: String(s.id || id(8)) };
    if (s.type === 'send_email') {
      // Email builder: the step stores its design and the rendered HTML/text next to it.
      if (s.design) {
        const f = designFields(s.design);
        Object.assign(out, { design: f.design, body: f.body, text: f.body_text, isHtml: true });
      } else {
        delete out.design;
        delete out.text;
      }
    }
    stepCleaners()['*']?.(out);
    stepCleaners()[s.type]?.(out);
    // Nested step lists: Wenn/Sonst (then/else), split test variants (b0…), loop list (each) – anything else loses stale lists.
    const keep = branchKeys(out);
    for (const k of Object.keys(out)) if ((k === 'then' || k === 'else' || k === 'each' || /^b\d+$/.test(k)) && !keep.includes(k)) delete out[k];
    for (const k of keep) out[k] = cleanSteps(s[k], depth + 1);
    return out;
  });
}

type Recipe = { name: string; trigger: any; steps: Omit<Step, 'id'>[]; settings?: Record<string, unknown> };
const RECIPES: Record<string, Recipe> = {
  new_lead: {
    name: 'Neuer Lead: Willkommen + Follow-up',
    trigger: { type: 'form.submitted', config: {} },
    steps: [
      { type: 'add_tag', tags: ['lead'] },
      { type: 'send_email', purpose: 'transactional', subject: 'Danke für deine Anfrage, {{contact.first_name|}}!', body: 'Hallo {{contact.first_name|du}},\n\ndanke für deine Nachricht! Wir melden uns innerhalb von 24 Stunden.\n\nViele Grüße\n{{location.name}}' },
      { type: 'notify', subject: 'Neuer Lead: {{contact.name}}', body: '{{contact.name}} ({{contact.email}}, {{contact.phone}}) hat ein Formular ausgefüllt.' },
      { type: 'wait', amount: 2, unit: 'days' },
      { type: 'goal', conditions: [{ field: 'tag', op: 'has', value: 'termin-gebucht' }] },
      { type: 'send_email', subject: 'Kurze Rückfrage', body: 'Hallo {{contact.first_name|du}},\n\nmagst du direkt einen Termin buchen? Hier geht es zum Kalender: …\n\n{{location.name}}' },
    ],
  },
  booked: {
    name: 'Termin gebucht: Tag + Aufgabe',
    trigger: { type: 'appointment.booked', config: {} },
    steps: [
      { type: 'add_tag', tags: ['termin-gebucht'] },
      { type: 'create_task', title: 'Termin mit {{contact.name}} vorbereiten', due_in_days: 0 },
    ],
  },
  noshow: {
    name: 'No-Show: neu buchen lassen',
    trigger: { type: 'appointment.status_changed', config: { status: 'noshow' } },
    steps: [
      { type: 'send_email', subject: 'Schade, dass es nicht geklappt hat', body: 'Hallo {{contact.first_name|du}},\n\nwir haben dich heute verpasst. Buch dir gern einen neuen Termin.\n\n{{location.name}}' },
      { type: 'wait', amount: 1, unit: 'days' },
      { type: 'send_sms', body: 'Hi {{contact.first_name|}}, sollen wir einen neuen Termin finden? {{location.name}}' },
    ],
  },
  review: {
    name: 'Nach dem Termin: Bewertung anfragen',
    trigger: { type: 'appointment.status_changed', config: { status: 'showed' } },
    steps: [{ type: 'wait', amount: 2, unit: 'hours' }, { type: 'review_request', channel: 'email' }],
  },
  won: {
    name: 'Deal gewonnen: Kunde taggen',
    trigger: { type: 'opportunity.status_changed', config: { status: 'won' } },
    steps: [
      { type: 'add_tag', tags: ['kunde'] },
      { type: 'remove_tag', tags: ['lead'] },
      { type: 'send_email', subject: 'Willkommen an Bord!', body: 'Hallo {{contact.first_name|du}},\n\nschön, dass wir zusammenarbeiten!\n\n{{location.name}}' },
    ],
  },
};

export const workflowsModule: Module = {
  name: 'workflows',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE workflows (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', trigger TEXT NOT NULL DEFAULT '{}',
        steps TEXT NOT NULL DEFAULT '[]', settings TEXT NOT NULL DEFAULT '{}', webhook_key TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL, contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        status TEXT NOT NULL, cursor TEXT NOT NULL DEFAULT '[0]', event TEXT NOT NULL DEFAULT '{}',
        next_run_at TEXT, log TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX workflow_runs_due ON workflow_runs(status, next_run_at);
      CREATE INDEX workflow_runs_wf ON workflow_runs(workflow_id, contact_id);
      `,
    ],
    // Variables of a run ({{var.name}}): set by steps, kept between waits.
    ['002-run-vars', `ALTER TABLE workflow_runs ADD COLUMN vars TEXT NOT NULL DEFAULT '{}';`],
  ],
  register(app) {
    const { db, router } = app;
    installWorkflowEngine(app);
    const getWf = (loc: string, wid: string) => parseJson(db.get('SELECT * FROM workflows WHERE id = ? AND location_id = ?', wid, loc), ['trigger', 'steps', 'settings']);
    const out = (w: any) => ({ ...w, webhook_url: w.trigger?.type === 'webhook' && w.webhook_key ? `${app.baseUrl()}/hooks/workflow/${w.id}?key=${w.webhook_key}` : undefined });

    extraSteps = () => Object.keys(app.services.workflowActions ?? {});
    stepCleaners = () => app.services.workflowStepCleaners ?? {};
    // Other modules add triggers (e.g. call.missed) and recipes via app.services.
    const triggers = (): string[] => [...TRIGGERS, ...(app.services.workflowTriggers ?? [])];
    const recipes = (): Record<string, Recipe> => ({ ...RECIPES, ...(app.services.workflowRecipes ?? {}) });
    router.get('/api/workflows/meta', 'location', () => ({ triggers: triggers(), steps: [...STEP_TYPES, ...extraSteps()], recipes: Object.entries(recipes()).map(([k, r]) => ({ key: k, name: r.name })) }));

    router.get('/api/workflows', 'location', (ctx) =>
      parseRows(
        db.all(
          `SELECT w.*,
             (SELECT COUNT(*) FROM workflow_runs r WHERE r.workflow_id = w.id) AS enrolled,
             (SELECT COUNT(*) FROM workflow_runs r WHERE r.workflow_id = w.id AND r.status IN ('active','waiting','running')) AS active_runs,
             (SELECT COUNT(*) FROM workflow_runs r WHERE r.workflow_id = w.id AND r.status = 'completed') AS completed
           FROM workflows w WHERE w.location_id = ? ORDER BY w.updated_at DESC`,
          ctx.locationId,
        ),
        ['trigger', 'steps', 'settings'],
      ).map(out),
    );
    router.get('/api/workflows/:id', 'location', (ctx) => {
      const w = getWf(ctx.locationId, ctx.params.id);
      if (!w) throw notFound();
      return out(w);
    });
    router.post('/api/workflows', 'location', (ctx) => {
      const recipe = recipes()[ctx.body.recipe];
      const trigger = recipe?.trigger ?? ctx.body.trigger ?? { type: 'contact.tag_added', config: {} };
      if (!triggers().includes(trigger.type)) throw bad('Unbekannter Auslöser');
      const row = {
        id: id(),
        location_id: ctx.locationId,
        name: str(ctx.body.name, 'Name') || recipe?.name || 'Neuer Workflow',
        status: 'draft',
        trigger,
        steps: cleanSteps(recipe?.steps ?? ctx.body.steps ?? []),
        settings: cleanErrorSettings(app, ctx.locationId, { allow_reentry: false, stop_on_error: false, ...(recipe?.settings ?? {}), ...(ctx.body.settings ?? {}) }),
        webhook_key: token(16),
        created_at: now(),
        updated_at: now(),
      };
      db.insert('workflows', row);
      return out(row);
    });
    router.patch('/api/workflows/:id', 'location', (ctx) => {
      const w = getWf(ctx.locationId, ctx.params.id);
      if (!w) throw notFound();
      const patch: Record<string, any> = { updated_at: now() };
      if (ctx.body.name !== undefined) patch.name = str(ctx.body.name, 'Name', { required: true });
      if (ctx.body.status !== undefined) {
        if (!['draft', 'active', 'paused'].includes(ctx.body.status)) throw bad('Unbekannter Status');
        patch.status = ctx.body.status;
      }
      if (ctx.body.trigger !== undefined) {
        if (!triggers().includes(ctx.body.trigger?.type)) throw bad('Unbekannter Auslöser');
        patch.trigger = { type: ctx.body.trigger.type, config: ctx.body.trigger.config ?? {} };
      }
      if (ctx.body.steps !== undefined) patch.steps = cleanSteps(ctx.body.steps);
      if (ctx.body.settings) patch.settings = cleanErrorSettings(app, ctx.locationId, { ...w.settings, ...ctx.body.settings }, w.settings, w.id);
      db.update('workflows', w.id, patch);
      return out(getWf(ctx.locationId, w.id));
    });
    router.delete('/api/workflows/:id', 'location', (ctx) => {
      db.run('DELETE FROM workflows WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      return { ok: true };
    });

    router.get('/api/workflows/:id/runs', 'location', (ctx) => {
      const w = getWf(ctx.locationId, ctx.params.id);
      if (!w) throw notFound();
      const runs = parseRows(
        db.all(
          `SELECT r.*, c.first_name, c.last_name, c.email FROM workflow_runs r LEFT JOIN contacts c ON c.id = r.contact_id
           WHERE r.workflow_id = ? ORDER BY r.created_at DESC LIMIT 300`,
          w.id,
        ),
        ['cursor', 'log', 'event', 'vars'],
      );
      // How many contacts currently sit at each step (for the builder's counters).
      const at: Record<string, number> = {};
      const flat = walk(w.steps ?? []);
      for (const r of runs) {
        if (!['waiting', 'active'].includes(r.status)) continue;
        const hit = flat.find((f) => JSON.stringify(f.cursor) === JSON.stringify(r.cursor));
        if (hit) at[hit.step.id] = (at[hit.step.id] ?? 0) + 1;
      }
      // The list stays light: inputs/outputs of every step come with GET /api/workflow-runs/:id.
      const slim = (log: any[]) => (Array.isArray(log) ? log.map(({ input: _i, output: _o, ...l }) => l) : []);
      return { runs: runs.map(({ event: _e, vars, log, ...r }) => ({ ...r, log: slim(log), vars: Object.fromEntries(Object.entries(vars ?? {}).filter(([k]) => !k.startsWith('_'))) })), at };
    });
    router.post('/api/workflow-runs/:id/stop', 'location', (ctx) => {
      db.run(`UPDATE workflow_runs SET status = 'stopped', updated_at = ? WHERE id = ? AND location_id = ?`, now(), ctx.params.id, ctx.locationId);
      return { ok: true };
    });

    /** Manually enroll contacts (from the contact page or a bulk action). */
    router.post('/api/workflows/:id/enroll', 'location', async (ctx) => {
      const w = getWf(ctx.locationId, ctx.params.id);
      if (!w) throw notFound();
      if (w.status !== 'active') throw bad('Workflow ist nicht aktiv');
      const ids: string[] = Array.isArray(ctx.body.contact_ids) ? ctx.body.contact_ids.map(String) : [];
      let n = 0;
      for (const cid of ids) {
        const rid = startWorkflow(app, w, cid, { manual: true, userId: ctx.user?.id });
        if (rid) {
          n++;
          await processRun(app, rid);
        }
      }
      return { enrolled: n };
    });

    /** Inbound webhook trigger: any tool (Zapier-like) can push a contact into the workflow. */
    router.post('/hooks/workflow/:id', 'public', async (ctx) => {
      const w = parseJson(db.get('SELECT * FROM workflows WHERE id = ?', ctx.params.id), ['trigger', 'steps', 'settings']);
      if (!w || w.trigger?.type !== 'webhook' || !safeEqual(ctx.query.get('key'), w.webhook_key)) throw new HttpError(404, 'Nicht gefunden');
      if (w.status !== 'active') throw bad('Workflow ist nicht aktiv');
      const b = ctx.body ?? {};
      const input = b.contact ?? b;
      // Without e-mail, phone or name there is nobody to start the workflow for (a list or a text would make an empty contact).
      if (!input || typeof input !== 'object' || Array.isArray(input) || !hasIdentity(input)) throw bad('Keine Kontaktdaten gefunden (E-Mail, Telefon oder Name)');
      if (!firstSeen(app, w.location_id, `webhook:${w.id}`, deliveryIdOf(ctx.req.headers))) return { ok: true, duplicate: true };
      const { contact } = upsertContact(app, w.location_id, input, { source: `Webhook: ${w.name}`, tags: Array.isArray(b.tags) ? b.tags : [] });
      const rid = startWorkflow(app, w, contact.id, { webhook: b });
      if (rid) await processRun(app, rid);
      return { ok: true, contactId: contact.id, enrolled: !!rid };
    });
  },
};
