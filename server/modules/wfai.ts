import type { Module } from '../core/app.js';
import { HttpError, bad, clampLimit, notFound, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import { auditLog, clip, json, limiter } from '../services/creator-kit.js';
import { callRoute } from '../services/route-call.js';
import { cleanSteps } from './workflows.js';
import {
  EDIT_RULES,
  LIMITS,
  SYSTEM_RULES,
  catalogText,
  checkWorkflow,
  contextText,
  diffWorkflows,
  parseAnswer,
  reconcileIds,
  retryPrompt,
  usableActions,
  usableTriggers,
  type Refs,
  type WorkflowDraft,
} from '../services/wfai.js';
import type { Tool } from './mcp.js';

/**
 * KI-Workflow-Builder: "Wenn jemand … dann …" in Alltagssprache → ein Workflow. The AI (BYOK, routed under the use "Workflows",
 * falling back to the quick-text connection and then the KI-Assistent's own key) gets the live workflow catalogue and the ids that
 * exist in the sub-account, answers with JSON, and the answer is checked against that catalogue (services/wfai.ts). A failed check
 * goes back to the AI with the error list, up to three attempts. The person sees a preview with a diff and applies it as a DRAFT:
 * a new workflow is created with status "draft", a change lands in the workflow's draft ("Als Entwurf speichern") – nothing here
 * publishes or activates. Also MCP `ghl_workflow_generate`. Docs: docs/workflow-ai.md.
 */

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const obj = (props: Record<string, any>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const ATTEMPTS = 3;
const HOUR = 3600_000;

export const EXAMPLES = [
  'Wenn jemand das Kontaktformular ausfüllt: Tag „lead“ setzen, Willkommens-Mail senden und nach zwei Tagen nachfassen, falls noch kein Termin gebucht wurde.',
  'Nach einem Kauf: Danke-Mail, nach sieben Tagen um eine Bewertung bitten.',
  'Bei einer Bewertung mit höchstens 3 Sternen: Aufgabe für das Team anlegen und das Team per E-Mail benachrichtigen.',
  'Am Geburtstag um 9 Uhr eine herzliche Glückwunsch-Mail schicken.',
];

const TOOLS: Tool[] = [
  {
    name: 'ghl_workflow_generate',
    title: 'Workflow mit KI entwerfen',
    description:
      'Baut aus einer Beschreibung in Alltagssprache einen Workflow-Entwurf (oder ändert einen bestehenden, mit workflow_id). Die KI nutzt den Workflow-Katalog und die IDs des Sub-Accounts; die Antwort wird gegen den Katalog geprüft (bis zu drei Versuche). Ergebnis: Vorschau mit Zusammenfassung, Hinweisen und Änderungsliste. Mit apply=true wird der Entwurf gespeichert: ein neuer Workflow mit Status „draft“, eine Änderung als Entwurf des bestehenden Workflows – nie veröffentlicht, nie aktiviert. Kostet KI-Tokens (zählt aufs Monatslimit); KI-Anbieter und -Schlüssel kommen aus Einstellungen → KI-Assistent bzw. KI-Anbieter (Verwendung „Workflows“).',
    inputSchema: obj(
      {
        ...LOC,
        prompt: { type: 'string', description: 'Was der Workflow tun soll, z. B. „Wenn jemand das Formular ausfüllt, Tag lead setzen und nach 2 Tagen nachfassen“' },
        workflow_id: { type: 'string', description: 'Optional: ID eines bestehenden Workflows, der geändert werden soll (statt eines neuen)' },
        apply: { type: 'boolean', description: 'true: als Entwurf speichern (Standard: nur Vorschau)' },
      },
      ['location_id', 'prompt'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    klassFor: (a) => (a.apply ? 'write' : 'read'),
    run: async (call, a) => {
      const r = await call.api('POST', '/api/workflow-ai/generate', { body: { prompt: a.prompt, workflow_id: a.workflow_id }, location: a.location_id });
      const applied = a.apply ? await call.api('POST', `/api/workflow-ai/runs/${encodeURIComponent(r.run_id)}/apply`, { body: {}, location: a.location_id }) : null;
      return {
        run_id: r.run_id,
        mode: r.mode,
        name: r.workflow.name,
        summary: r.summary,
        notes: r.notes,
        warnings: r.warnings,
        changes: r.diff.counts,
        trigger: r.workflow.trigger,
        steps: r.workflow.steps,
        settings: r.workflow.settings,
        applied,
        hint: applied ? 'Als Entwurf gespeichert – nicht veröffentlicht. Prüfen und veröffentlichen im Workflow-Editor.' : 'Nur eine Vorschau. Mit apply=true (oder im Editor) als Entwurf speichern.',
      };
    },
  },
];

interface RunRow {
  id: string;
  location_id: string;
  user_id: string | null;
  user_name: string;
  workflow_id: string | null;
  mode: 'create' | 'edit';
  prompt: string;
  status: 'ok' | 'failed' | 'applied';
  attempts: number;
  error: string;
  model: string;
  tokens: number;
  result: string;
  applied_workflow_id: string | null;
  applied_at: string | null;
  created_at: string;
}

export const wfaiModule: Module = {
  name: 'wfai',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE wfai_runs (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, user_id TEXT, user_name TEXT NOT NULL DEFAULT '',
        workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL, mode TEXT NOT NULL DEFAULT 'create', prompt TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'ok', attempts INTEGER NOT NULL DEFAULT 1, error TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
        tokens INTEGER NOT NULL DEFAULT 0, result TEXT NOT NULL DEFAULT '{}', applied_workflow_id TEXT, applied_at TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX wfai_runs_loc ON wfai_runs(location_id, created_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    const tooMany = limiter(20, HOUR);

    // --- what the AI is told ---------------------------------------------------------------------------------------
    /** The lists a request may read (its rights apply: what the person may not see is left out, and ids from it are not checked). */
    async function loadRefs(ctx: Ctx): Promise<Refs> {
      const get = async <T>(path: string, pick: (r: any) => T): Promise<T | undefined> => {
        try {
          return pick(await callRoute(app, ctx, 'GET', path));
        } catch {
          return undefined;
        }
      };
      const named = (r: any) => (Array.isArray(r) ? r : []).map((x: any) => ({ id: String(x.id), name: String(x.name ?? x.title ?? x.label ?? x.id) }));
      const [pipeline, calendar, form, workflow, product, course, group, link, user, tags, custom] = await Promise.all([
        get('/api/pipelines', (r) => (Array.isArray(r) ? r : []).map((p: any) => ({ id: String(p.id), name: String(p.name), stages: (p.stages ?? []).map((s: any) => ({ id: String(s.id), name: String(s.name) })) }))),
        get('/api/calendars', named),
        get('/api/forms', named),
        get('/api/workflows', (r) => (Array.isArray(r) ? r : []).map((w: any) => ({ id: String(w.id), name: String(w.name), status: String(w.status) }))),
        get('/api/products', named),
        get('/api/courses', named),
        get('/api/community/groups', named),
        get('/api/trigger-links', (r) => (Array.isArray(r) ? r : []).map((l: any) => ({ id: String(l.id), name: String(l.name ?? l.slug ?? l.id) }))),
        get('/api/location-users', named),
        get('/api/tags', (r) => (Array.isArray(r) ? r : []).map((x: any) => String(x.name))),
        get('/api/custom-fields', (r) => (Array.isArray(r) ? r : []).map((x: any) => ({ key: String(x.key ?? x.field_key ?? x.id), label: String(x.label ?? x.name ?? x.key) }))),
      ]);
      return { pipeline, calendar, form, workflow, product, course, group, link, user, tags, custom_fields: custom };
    }

    async function loadCatalog(ctx: Ctx) {
      const cat = await callRoute(app, ctx, 'GET', '/api/workflow-catalog');
      return { actions: usableActions(cat.actions ?? []), triggers: usableTriggers(cat.triggers ?? []) };
    }

    /** The workflow to change: its draft when there is one (that is what the editor shows), else the saved workflow. */
    function baseOf(ctx: Ctx, workflowId: string) {
      const w = db.get<any>('SELECT * FROM workflows WHERE id = ? AND location_id = ?', workflowId, ctx.locationId);
      if (!w) throw notFound('Workflow nicht gefunden');
      const d = db.get<any>('SELECT * FROM workflow_drafts WHERE workflow_id = ? AND location_id = ?', w.id, ctx.locationId);
      const src = d ?? w;
      const draft: WorkflowDraft = {
        name: String(d?.name ?? w.name),
        trigger: json(src.trigger, { type: '', config: {} }),
        steps: json(src.steps, []),
        settings: { allow_reentry: false, stop_on_error: false, ...json(src.settings, {}) },
      };
      return { id: String(w.id), status: String(w.status), name: String(w.name), has_draft: !!d, draft };
    }

    // --- generate (with retries) -----------------------------------------------------------------------------------
    async function generate(ctx: Ctx, input: { prompt: string; workflowId?: string }) {
      const run = app.services.aiRun as ((i: any) => Promise<{ text: string; model: string; usage?: { input_tokens?: number; output_tokens?: number } }>) | undefined;
      if (!run) throw new HttpError(409, 'Der KI-Assistent ist nicht verfügbar.');
      const loc = ctx.locationId;
      const base = input.workflowId ? baseOf(ctx, input.workflowId) : null;
      const baseJson = base ? JSON.stringify(base.draft) : '';
      if (baseJson.length > 60_000) throw bad('Dieser Workflow ist für eine KI-Änderung zu groß (über 60 KB) – bitte in kleineren Teilen ändern.');
      const [{ actions, triggers }, refs] = await Promise.all([loadCatalog(ctx), loadRefs(ctx)]);
      const l = app.location(loc);
      const system = [
        { text: `${SYSTEM_RULES}${base ? `\n\n${EDIT_RULES}` : ''}\n\nKATALOG\n${catalogText(actions, triggers)}`, cache: true },
        { text: `KONTEXT DES SUB-ACCOUNTS\n${contextText(refs, { name: l?.name, timezone: l?.timezone })}` },
      ];
      const first = `AUFTRAG:\n${input.prompt}${base ? `\n\nBISHERIGER WORKFLOW (JSON):\n${baseJson}` : ''}`;
      let user = first;
      let errors: string[] = [];
      let warnings: string[] = [];
      let tokens = 0;
      let model = '';
      let last = '';
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        // transport and limit problems (no key, budget used up, provider down) are the person's to read – no retry
        const r = await run({ locationId: loc, purpose: 'workflow_builder', system, user, maxTokens: 8000, timeoutMs: 150_000, userId: ctx.user?.id ?? null });
        tokens += (r.usage?.input_tokens ?? 0) + (r.usage?.output_tokens ?? 0);
        model = r.model || model;
        last = r.text ?? '';
        const raw = parseAnswer(last);
        errors = [];
        if (!raw) errors.push('Die Antwort war kein einzelnes JSON-Objekt. Antworte ausschließlich mit dem JSON-Objekt.');
        else {
          const checked = checkWorkflow(raw, { actions, triggers, refs });
          errors = checked.errors;
          warnings = checked.warnings;
          if (!errors.length && checked.workflow) {
            const wf = checked.workflow;
            try {
              // the same gate as saving a workflow (unknown steps, per-module cleaners)
              wf.steps = cleanSteps(wf.steps);
            } catch (e) {
              errors.push((e as Error).message);
            }
            if (!errors.length) {
              if (base) reconcileIds(base.draft.steps, wf.steps);
              const diff = diffWorkflows(base?.draft ?? null, wf, (t) => actions.get(t)?.label ?? t);
              const result = { workflow: wf, diff, summary: checked.summary, notes: checked.notes, warnings };
              const rid = id();
              db.insert('wfai_runs', { id: rid, location_id: loc, user_id: ctx.user?.id ?? null, user_name: ctx.user?.name ?? '', workflow_id: base?.id ?? null, mode: base ? 'edit' : 'create', prompt: clip(input.prompt, LIMITS.prompt), status: 'ok', attempts: attempt, error: '', model, tokens, result: JSON.stringify(result), applied_workflow_id: null, applied_at: null, created_at: now() });
              return { run_id: rid, mode: base ? 'edit' : 'create', ...result, attempts: attempt, model, base: base ? { id: base.id, name: base.name, status: base.status, has_draft: base.has_draft } : null };
            }
          }
        }
        user = retryPrompt(first, last, errors);
      }
      const message = `Die KI hat nach ${ATTEMPTS} Versuchen keinen gültigen Workflow geliefert: ${errors.slice(0, 4).join(' · ')}`;
      db.insert('wfai_runs', { id: id(), location_id: loc, user_id: ctx.user?.id ?? null, user_name: ctx.user?.name ?? '', workflow_id: base?.id ?? null, mode: base ? 'edit' : 'create', prompt: clip(input.prompt, LIMITS.prompt), status: 'failed', attempts: ATTEMPTS, error: message.slice(0, 1500), model, tokens, result: '{}', applied_workflow_id: null, applied_at: null, created_at: now() });
      throw new HttpError(422, message);
    }

    // --- routes ------------------------------------------------------------------------------------------------------
    router.get('/api/workflow-ai/status', 'location', (ctx) => {
      const reason: string | null = app.services.aiReady?.(ctx.locationId) ?? (app.services.aiRun ? null : 'Der KI-Assistent ist nicht verfügbar.');
      const p = app.services.aiProvider?.(ctx.locationId, 'workflow_builder') as { label: string; model: string; connectionId?: string } | null | undefined;
      return {
        ready: !reason,
        reason,
        provider: p ? { label: p.label, model: p.model, byok: !!p.connectionId } : { label: 'Claude', model: '', byok: false },
        examples: EXAMPLES,
        limits: { per_hour: 20, attempts: ATTEMPTS, max_steps: LIMITS.steps },
      };
    });

    router.post('/api/workflow-ai/generate', 'location', async (ctx) => {
      const prompt = clip(ctx.body?.prompt, LIMITS.prompt);
      if (prompt.length < 8) throw bad('Bitte beschreibe in ein bis zwei Sätzen, was der Workflow tun soll.');
      const workflowId = ctx.body?.workflow_id ? String(ctx.body.workflow_id) : undefined;
      if (tooMany(ctx.locationId)) throw new HttpError(429, 'Zu viele KI-Entwürfe in kurzer Zeit – bitte in einigen Minuten erneut versuchen.');
      return generate(ctx, { prompt, workflowId });
    });

    router.get('/api/workflow-ai/runs', 'location', (ctx) => {
      const wf = ctx.query.get('workflow_id');
      const rows = db.all<RunRow>(`SELECT * FROM wfai_runs WHERE location_id = ? ${wf ? 'AND workflow_id = ?' : ''} ORDER BY created_at DESC LIMIT ?`, ctx.locationId, ...(wf ? [wf] : []), clampLimit(ctx.query.get('limit'), 20, 100));
      return rows.map((r) => {
        const res = json<any>(r.result, {});
        return { id: r.id, mode: r.mode, workflow_id: r.workflow_id, prompt: r.prompt, status: r.status, attempts: r.attempts, error: r.error, model: r.model, summary: res.summary ?? '', name: res.workflow?.name ?? '', applied_workflow_id: r.applied_workflow_id, applied_at: r.applied_at, user_name: r.user_name, created_at: r.created_at };
      });
    });

    router.get('/api/workflow-ai/runs/:id', 'location', (ctx) => {
      const r = db.get<RunRow>('SELECT * FROM wfai_runs WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!r) throw notFound('Entwurf nicht gefunden');
      return { id: r.id, mode: r.mode, status: r.status, prompt: r.prompt, attempts: r.attempts, model: r.model, applied_workflow_id: r.applied_workflow_id, ...json<any>(r.result, {}) };
    });

    /** Saves the checked proposal as a draft. Never publishes, never activates. */
    router.post('/api/workflow-ai/runs/:id/apply', 'location', async (ctx) => {
      const r = db.get<RunRow>('SELECT * FROM wfai_runs WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!r) throw notFound('Entwurf nicht gefunden');
      if (r.status === 'applied') throw new HttpError(409, 'Dieser KI-Entwurf wurde schon übernommen.');
      if (r.status !== 'ok') throw new HttpError(409, 'Dieser KI-Versuch hat keinen gültigen Workflow geliefert.');
      const wf = json<any>(r.result, {}).workflow as WorkflowDraft | undefined;
      if (!wf) throw new HttpError(409, 'Kein Entwurf gespeichert.');
      const body = { name: wf.name, trigger: wf.trigger, steps: wf.steps, settings: wf.settings };
      let target: string;
      let replacedDraft = false;
      if (r.mode === 'create') {
        const w = await callRoute(app, ctx, 'POST', '/api/workflows', body);
        if (w.status !== 'draft') throw new HttpError(500, 'Der Workflow wurde nicht als Entwurf angelegt.');
        target = String(w.id);
      } else {
        const wid = r.workflow_id;
        if (!wid || !db.get('SELECT 1 FROM workflows WHERE id = ? AND location_id = ?', wid, ctx.locationId)) throw new HttpError(409, 'Der Workflow, der geändert werden sollte, existiert nicht mehr.');
        replacedDraft = !!db.get('SELECT 1 FROM workflow_drafts WHERE workflow_id = ?', wid);
        await callRoute(app, ctx, 'PUT', `/api/workflows/${encodeURIComponent(wid)}/draft`, body);
        target = wid;
      }
      db.run(`UPDATE wfai_runs SET status = 'applied', applied_workflow_id = ?, applied_at = ? WHERE id = ?`, target, now(), r.id);
      auditLog(app, ctx, ctx.locationId, 'workflow_ai.apply', r.mode === 'create' ? `KI-Entwurf „${wf.name}“ als neuen Workflow-Entwurf angelegt` : `KI-Änderung an „${wf.name}“ als Entwurf gespeichert`, target);
      return { ok: true, mode: r.mode, workflow_id: target, status: r.mode === 'create' ? 'draft' : undefined, replaced_draft: replacedDraft, message: r.mode === 'create' ? 'Als Entwurf angelegt – noch nicht aktiv. Prüfen, testen und dann aktivieren.' : 'Als Entwurf des Workflows gespeichert – veröffentlichen im Editor, wenn alles stimmt.' };
    });

    app.onTick(() => {
      db.run('DELETE FROM wfai_runs WHERE created_at < ?', new Date(Date.now() - 30 * 864e5).toISOString());
    });
  },
};
