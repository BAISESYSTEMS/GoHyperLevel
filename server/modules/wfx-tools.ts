import type { Module } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { bad, notFound, str, type Ctx } from '../core/http.js';
import { id as newId, now, sha256 } from '../core/util.js';
import { upsertContact, getContact, contactVars } from '../services/contacts.js';
import { callRoute } from '../services/route-call.js';
import { functionDocs } from '../services/expr.js';
import { TRIGGERS, branchKeys, execute, walk, type RunState, type Step } from '../services/workflow-engine.js';
import { BUILTIN_ACTION_META, BUILTIN_TRIGGER_META } from '../services/wfx-catalog.js';
import { CATEGORIES, TRIGGER_CATEGORIES, type ActionMeta, type TriggerMeta } from '../services/wfx-kit.js';
import { stripHttpSecrets } from '../services/wfx-http.js';
import { APP_VERSION } from '../version.js';
import type { Tool } from './mcp.js';
import { cleanSteps } from './workflows.js';

/**
 * Tools around workflows: the catalog of steps and triggers for the editor (categories, search, docs, form fields), test
 * runs with sample data (nothing is sent or changed), the run log with inputs/outputs of every step, split-test results,
 * versions with a draft and "Veröffentlichen", import/export as JSON, and custom events from outside (REST and MCP).
 * Docs: docs/workflow-actions.md.
 */

const KEEP_VERSIONS = 50;
const EXPORT_FORMAT = 'gohigh-workflow';
const BUNDLE_FORMAT = 'gohigh-workflows';
const REF_KEYS = ['pipeline_id', 'stage_id', 'form_id', 'calendar_id', 'workflow_id', 'template_id', 'product_id', 'group_id', 'course_id', 'integration_ids', 'link_id'] as const;

const flat = (steps: Step[]) => new Map(walk(steps).map((f) => [f.step.id, f.step]));
const hashOf = (w: { name?: string; trigger: unknown; steps: unknown; settings: unknown }) => sha256(JSON.stringify([w.trigger, w.steps, w.settings])).slice(0, 24);

/** "3 Schritte neu, 1 geändert" between two versions of a workflow. */
export function diffSummary(prev: { trigger: any; steps: Step[]; settings?: any } | undefined, next: { trigger: any; steps: Step[]; settings?: any }): string {
  if (!prev) return `Erste Version · ${walk(next.steps).length} Schritte`;
  const a = flat(prev.steps);
  const b = flat(next.steps);
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const [id, s] of b) {
    const old = a.get(id);
    if (!old) added++;
    else if (JSON.stringify({ ...old, ...Object.fromEntries(branchKeys(old).map((k) => [k, undefined])) }) !== JSON.stringify({ ...s, ...Object.fromEntries(branchKeys(s).map((k) => [k, undefined])) })) changed++;
  }
  for (const id of a.keys()) if (!b.has(id)) removed++;
  const parts = [
    JSON.stringify(prev.trigger) !== JSON.stringify(next.trigger) ? 'Auslöser geändert' : '',
    added ? `${added} Schritt${added === 1 ? '' : 'e'} neu` : '',
    removed ? `${removed} entfernt` : '',
    changed ? `${changed} geändert` : '',
    JSON.stringify(prev.settings ?? {}) !== JSON.stringify(next.settings ?? {}) ? 'Einstellungen geändert' : '',
  ].filter(Boolean);
  return parts.join(' · ') || 'Keine inhaltliche Änderung';
}

const TOOLS: Tool[] = [
  {
    name: 'ghl_workflow_catalog',
    title: 'Workflow-Schritte und -Auslöser',
    description:
      'Katalog der Workflow-Aktionen und -Auslöser mit Kategorie, Beschreibung, Einstellungsfeldern (key, type, options), Beispielen und – bei Auslösern – typischen Ereignisdaten. q = Suchtext, category = Kategorie (flow, data, crm, sales, messaging, payments, content, ai, integration, apps, apps_composio), kind = actions|triggers|all, compact=true liefert nur Typ, Name und Kurztext. Nutze das, bevor du mit ghl_workflow_import einen Workflow baust.',
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' },
        q: { type: 'string' },
        category: { type: 'string' },
        kind: { type: 'string', enum: ['actions', 'triggers', 'all'] },
        compact: { type: 'boolean' },
      },
      required: ['location_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => {
      const qs = new URLSearchParams();
      for (const k of ['q', 'category', 'kind']) if (a[k]) qs.set(k, String(a[k]));
      if (a.compact !== false) qs.set('compact', '1');
      return call.api('GET', `/api/workflow-catalog?${qs}`, { location: a.location_id });
    },
  },
  {
    name: 'ghl_workflow_test_run',
    title: 'Workflow testen (Trockenlauf)',
    description:
      'Spielt einen Workflow mit Beispieldaten durch, ohne etwas zu senden oder zu ändern. Rechen-, Format-, Code-, Such- und Ablaufschritte laufen wirklich, Schritte mit Außenwirkung (E-Mail, SMS, Änderungen, API-Aufrufe, KI) zeigen nur, was sie tun würden. Gibt je Schritt Eingaben, Ausgaben und Fehler zurück. Optional contact_id (echter Kontakt), sample {contact, event, vars} und workflow {trigger, steps, settings} für einen noch nicht gespeicherten Entwurf.',
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' },
        workflow_id: { type: 'string' },
        contact_id: { type: 'string' },
        sample: { type: 'object' },
        workflow: { type: 'object' },
      },
      required: ['location_id', 'workflow_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => call.api('POST', `/api/workflows/${encodeURIComponent(a.workflow_id)}/test-run`, { body: { contact_id: a.contact_id, sample: a.sample, workflow: a.workflow }, location: a.location_id }),
  },
  {
    name: 'ghl_workflow_export',
    title: 'Workflow exportieren (JSON)',
    description: 'Exportiert einen Workflow (oder mit all=true alle) als portables JSON (Format gohigh-workflow) – ohne Geheimnisse in Headern. Zum Sichern, Kopieren in einen anderen Sub-Account oder als Vorlage.',
    inputSchema: {
      type: 'object',
      properties: { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' }, workflow_id: { type: 'string' }, all: { type: 'boolean' } },
      required: ['location_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => (a.all ? call.api('GET', '/api/workflow-export', { location: a.location_id }) : call.api('GET', `/api/workflows/${encodeURIComponent(String(a.workflow_id ?? ''))}/export`, { location: a.location_id })),
  },
  {
    name: 'ghl_workflow_import',
    title: 'Workflow importieren (JSON)',
    description: 'Legt aus einem Export (Format gohigh-workflow oder gohigh-workflows) neue Workflows als Entwurf an (nie aktiv). Schritt-IDs werden neu vergeben, Sprungziele angepasst; Verweise auf nicht vorhandene Pipelines, Formulare usw. kommen als Warnungen zurück. name überschreibt den Namen.',
    inputSchema: {
      type: 'object',
      properties: { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' }, data: { type: 'object', description: 'Der Export (JSON-Objekt)' }, name: { type: 'string' } },
      required: ['location_id', 'data'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: (call, a) => call.api('POST', '/api/workflow-import', { body: { data: a.data, name: a.name }, location: a.location_id }),
  },
  {
    name: 'ghl_emit_event',
    title: 'Eigenes Ereignis auslösen',
    description: 'Löst ein eigenes Ereignis für einen Kontakt aus; Workflows mit dem Auslöser „Eigenes Ereignis“ (Name passend) starten. Kontakt per contact_id, email oder phone; mit create=true wird er bei Bedarf angelegt. data = beliebige Zusatzdaten ({{event.…}} im Workflow).',
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' },
        name: { type: 'string', description: 'Ereignisname, z. B. bestellung_versendet' },
        contact_id: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        create: { type: 'boolean' },
        data: { type: 'object' },
      },
      required: ['location_id', 'name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: (call, a) => call.api('POST', '/api/custom-events', { body: { name: a.name, contact_id: a.contact_id, email: a.email, phone: a.phone, create: a.create, data: a.data }, location: a.location_id }),
  },
];

export const wfxToolsModule: Module = {
  name: 'wfx-tools',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE workflow_versions (
        id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, location_id TEXT NOT NULL,
        version INTEGER NOT NULL, name TEXT NOT NULL, trigger TEXT NOT NULL, steps TEXT NOT NULL, settings TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '', hash TEXT NOT NULL, user_id TEXT, user_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
        UNIQUE (workflow_id, version)
      );
      CREATE TABLE workflow_drafts (
        workflow_id TEXT PRIMARY KEY REFERENCES workflows(id) ON DELETE CASCADE, location_id TEXT NOT NULL,
        name TEXT, trigger TEXT NOT NULL, steps TEXT NOT NULL, settings TEXT NOT NULL, base_version INTEGER,
        user_id TEXT, user_name TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    const triggerTypes = (): string[] => [...TRIGGERS, ...(app.services.workflowTriggers ?? [])];
    const getWf = (loc: string, wid: string) => parseJson(db.get('SELECT * FROM workflows WHERE id = ? AND location_id = ?', wid, loc), ['trigger', 'steps', 'settings']);
    const must = (loc: string, wid: string) => {
      const w = getWf(loc, wid);
      if (!w) throw notFound();
      return w;
    };

    // --- catalog ----------------------------------------------------------------------------------
    const actionMetas = (): ActionMeta[] => {
      const registered: Record<string, ActionMeta> = app.services.workflowActionMeta ?? {};
      const types = new Set<string>([...Object.keys(BUILTIN_ACTION_META), ...Object.keys(app.services.workflowActions ?? {})]);
      const out: ActionMeta[] = [];
      for (const type of types) {
        const m = registered[type] ?? BUILTIN_ACTION_META[type];
        // An action another module registered without a description still appears in the picker.
        out.push(m ?? { type, label: type.replace(/_/g, ' '), category: 'apps_composio', summary: '', doc: '', fields: [], custom: true });
      }
      return out;
    };
    const triggerMetas = (): TriggerMeta[] => {
      const registered: Record<string, TriggerMeta> = app.services.workflowTriggerMeta ?? {};
      return triggerTypes().map((type) => registered[type] ?? BUILTIN_TRIGGER_META[type] ?? { type, label: type, category: 'system', summary: '', doc: '', fields: [], sample: {} });
    };
    const matches = (q: string, ...parts: (string | undefined)[]) => {
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      const hay = parts.join(' ').toLowerCase();
      return words.every((w) => hay.includes(w));
    };
    router.get('/api/workflow-catalog', 'location', (ctx) => {
      const q = (ctx.query.get('q') ?? '').trim();
      const cat = ctx.query.get('category') ?? '';
      const kind = ctx.query.get('kind') ?? 'all';
      const compact = ctx.query.get('compact') === '1';
      const slimA = (m: ActionMeta) => (compact ? { type: m.type, label: m.label, category: m.category, summary: m.summary, app: m.app } : m);
      const slimT = (m: TriggerMeta) => (compact ? { type: m.type, label: m.label, category: m.category, summary: m.summary } : m);
      const actions = kind === 'triggers' ? [] : actionMetas().filter((m) => (!cat || m.category === cat) && (!q || matches(q, m.type, m.label, m.summary, m.keywords, m.app))).map(slimA);
      const triggers = kind === 'actions' ? [] : triggerMetas().filter((m) => (!cat || m.category === cat) && (!q || matches(q, m.type, m.label, m.summary, m.keywords))).map(slimT);
      return {
        categories: CATEGORIES.map(([key, label]) => ({ key, label })),
        trigger_categories: TRIGGER_CATEGORIES.map(([key, label]) => ({ key, label })),
        actions,
        triggers,
        counts: { actions: actionMetas().length, triggers: triggerTypes().length },
        ...(compact ? {} : { functions: functionDocs() }),
      };
    });

    // --- run log ------------------------------------------------------------------------------------
    router.get('/api/workflow-runs/:id', 'location', (ctx) => {
      const r = parseJson(
        db.get(
          `SELECT r.*, c.first_name, c.last_name, c.email, w.name AS workflow_name FROM workflow_runs r
           LEFT JOIN contacts c ON c.id = r.contact_id LEFT JOIN workflows w ON w.id = r.workflow_id
           WHERE r.id = ? AND r.location_id = ?`,
          ctx.params.id,
          ctx.locationId,
        ),
        ['cursor', 'log', 'event', 'vars'],
      );
      if (!r) throw notFound();
      const { event, vars, ...rest } = r as any;
      return { ...rest, vars: Object.fromEntries(Object.entries(vars ?? {}).filter(([k]) => !k.startsWith('_'))), event_keys: Object.keys(event ?? {}).slice(0, 40) };
    });

    // --- split-test results -------------------------------------------------------------------------
    router.get('/api/workflows/:id/split-stats', 'location', (ctx) => {
      const w = must(ctx.locationId, ctx.params.id);
      const rows = db.all<any>(
        `SELECT s.step_id, s.variant, s.name, COUNT(*) AS assigned,
                SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) AS completed,
                SUM(CASE WHEN r.status IN ('active','waiting','running') THEN 1 ELSE 0 END) AS running,
                SUM(CASE WHEN EXISTS (SELECT 1 FROM json_each(r.log) j WHERE json_extract(j.value, '$.type') IN ('goal','goal_jump') AND json_extract(j.value, '$.result') LIKE 'erreicht%') THEN 1 ELSE 0 END) AS goals
         FROM wfx_split s JOIN workflow_runs r ON r.id = s.run_id
         WHERE s.workflow_id = ? GROUP BY s.step_id, s.variant, s.name ORDER BY s.step_id, s.variant`,
        w.id,
      );
      const steps = flat(w.steps ?? []);
      const tests = new Map<string, any>();
      for (const r of rows) {
        const t = tests.get(r.step_id) ?? { step_id: r.step_id, name: (steps.get(r.step_id) as any)?.name || 'Split-Test', variants: [] };
        t.variants.push({ index: r.variant, name: r.name, assigned: r.assigned, running: r.running, completed: r.completed, goals: r.goals, goal_rate: r.assigned ? Math.round((r.goals / r.assigned) * 1000) / 10 : 0 });
        tests.set(r.step_id, t);
      }
      return { tests: [...tests.values()] };
    });

    // --- test run -----------------------------------------------------------------------------------
    const checkTrigger = (t: any) => {
      if (!t || !triggerTypes().includes(t.type)) throw bad('Unbekannter Auslöser');
      return { type: t.type as string, config: t.config ?? {} };
    };
    router.post('/api/workflows/:id/test-run', 'location', async (ctx) => {
      const w = must(ctx.locationId, ctx.params.id);
      const o = ctx.body?.workflow ?? {};
      const steps = o.steps !== undefined ? cleanSteps(o.steps) : (w.steps as Step[]);
      const trigger = o.trigger ? checkTrigger(o.trigger) : w.trigger;
      const settings = { ...(w.settings ?? {}), ...(o.settings ?? {}) };
      const sample = ctx.body?.sample && typeof ctx.body.sample === 'object' ? ctx.body.sample : {};
      let contact: any;
      if (ctx.body?.contact_id) {
        contact = getContact(app, ctx.locationId, String(ctx.body.contact_id));
        if (!contact) throw notFound('Kontakt nicht gefunden');
      } else {
        contact = { id: 'sample', location_id: ctx.locationId, first_name: 'Erika', last_name: 'Muster', email: 'erika.muster@example.com', phone: '+4915112345678', company: 'Muster GmbH', city: 'Köln', tags: ['lead'], custom: {}, dnd: 0, source: 'Testlauf', created_at: now(), updated_at: now(), ...(sample.contact ?? {}) };
        contact.tags = Array.isArray(contact.tags) ? contact.tags : [];
        contact.custom = contact.custom && typeof contact.custom === 'object' ? contact.custom : {};
      }
      const meta = triggerMetas().find((m) => m.type === trigger?.type);
      const traitless = Object.fromEntries(Object.entries((meta?.sample ?? {}) as Record<string, any>).filter(([k]) => k !== 'contact'));
      const run: RunState = {
        id: 'test',
        workflow_id: w.id,
        location_id: ctx.locationId,
        contact_id: contact.id,
        event: { ...traitless, ...(sample.event && typeof sample.event === 'object' ? sample.event : {}) },
        vars: sample.vars && typeof sample.vars === 'object' ? { ...sample.vars } : {},
        cursor: [0],
        log: [],
      };
      const started = Date.now();
      const res = await execute(app, run, { ...w, steps, trigger, settings }, { dry: true, contact, maxSteps: Math.min(2000, Math.max(10, Number(ctx.body?.max_steps) || 600)) });
      const log = run.log as any[];
      return {
        status: res.status,
        ms: Date.now() - started,
        contact: { id: contact.id, name: (contactVars(contact as any) as any).name, sample: contact.id === 'sample' },
        event: run.event,
        log,
        vars: Object.fromEntries(Object.entries(run.vars).filter(([k]) => !k.startsWith('_'))),
        summary: { steps: log.length, skipped: log.filter((l) => l.dry && String(l.result).startsWith('Trockenlauf: nicht')).length, errors: log.filter((l) => l.error).length },
      };
    });

    // --- versions, draft, publish ---------------------------------------------------------------------
    const pendingNote = new Map<string, string>();
    const versionOut = (v: any, prev?: any) => ({ id: v.id, version: v.version, name: v.name, note: v.note, user_name: v.user_name, created_at: v.created_at, hash: v.hash, steps: walk(v.steps ?? []).length, trigger: v.trigger?.type, summary: diffSummary(prev && { trigger: prev.trigger, steps: prev.steps, settings: prev.settings }, v) });
    const snapshot = (locationId: string, w: any, ctx: Ctx | undefined, note = '') => {
      if (!w?.id || !Array.isArray(w.steps)) return;
      const hash = hashOf(w);
      const last = db.get<any>('SELECT version, hash FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC LIMIT 1', w.id);
      if (last?.hash === hash) return;
      const version = (last?.version ?? 0) + 1;
      db.insert('workflow_versions', { id: newId(), workflow_id: w.id, location_id: locationId, version, name: String(w.name ?? ''), trigger: w.trigger ?? {}, steps: w.steps, settings: w.settings ?? {}, note: note.slice(0, 300), hash, user_id: ctx?.user?.id ?? null, user_name: ctx?.user?.name ?? '', created_at: now() });
      db.run('DELETE FROM workflow_versions WHERE workflow_id = ? AND version <= ?', w.id, version - KEEP_VERSIONS);
    };
    // The undo journal (modules/undo.ts) points at these versions instead of copying workflows, and adds one when it restores.
    app.services.workflowVersions = { hashOf, snapshot };
    // Every saved change of a workflow (editor, API, MCP, import) becomes a version.
    app.afterWrite.push((ctx, route, result) => {
      const r = result as any;
      if (route.pattern === '/api/workflows' && ctx.method === 'POST' && r?.id) snapshot(r.location_id ?? ctx.locationId, r, ctx);
      else if (route.pattern === '/api/workflows/:id' && ctx.method === 'PATCH' && r?.id && (ctx.body?.steps !== undefined || ctx.body?.trigger !== undefined || ctx.body?.settings !== undefined || ctx.body?.name !== undefined)) {
        snapshot(r.location_id ?? ctx.locationId, r, ctx, pendingNote.get(r.id) ?? '');
        pendingNote.delete(r.id);
      }
    });

    router.get('/api/workflows/:id/versions', 'location', (ctx) => {
      const w = must(ctx.locationId, ctx.params.id);
      const rows = parseRows(db.all<any>('SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC LIMIT ?', w.id, KEEP_VERSIONS), ['trigger', 'steps', 'settings']);
      const draft = db.get('SELECT updated_at, user_name, base_version FROM workflow_drafts WHERE workflow_id = ?', w.id);
      return { current_hash: hashOf(w as any), versions: rows.map((v, i) => versionOut(v, rows[i + 1])), draft: draft ?? null };
    });
    router.get('/api/workflows/:id/versions/:version', 'location', (ctx) => {
      const w = must(ctx.locationId, ctx.params.id);
      const v = parseJson(db.get<any>('SELECT * FROM workflow_versions WHERE workflow_id = ? AND version = ?', w.id, Number(ctx.params.version)), ['trigger', 'steps', 'settings']);
      if (!v) throw notFound('Version nicht gefunden');
      return { ...versionOut(v), workflow: { name: v.name, trigger: v.trigger, steps: v.steps, settings: v.settings } };
    });
    router.get('/api/workflows/:id/draft', 'location', (ctx) => {
      const w = must(ctx.locationId, ctx.params.id);
      const d = parseJson(db.get<any>('SELECT * FROM workflow_drafts WHERE workflow_id = ?', w.id), ['trigger', 'steps', 'settings']);
      return d ? { draft: { name: d.name, trigger: d.trigger, steps: d.steps, settings: d.settings, base_version: d.base_version, user_name: d.user_name, updated_at: d.updated_at } } : { draft: null };
    });
    router.put('/api/workflows/:id/draft', 'location', (ctx) => {
      const w = must(ctx.locationId, ctx.params.id);
      const b = ctx.body ?? {};
      const row = {
        workflow_id: w.id,
        location_id: ctx.locationId,
        name: b.name !== undefined ? str(b.name, 'Name', { required: true, max: 200 }) : w.name,
        trigger: b.trigger ? checkTrigger(b.trigger) : w.trigger,
        steps: b.steps !== undefined ? cleanSteps(b.steps) : w.steps,
        settings: { ...(w.settings ?? {}), ...(b.settings ?? {}) },
        base_version: db.get<any>('SELECT MAX(version) AS v FROM workflow_versions WHERE workflow_id = ?', w.id)?.v ?? null,
        user_id: ctx.user?.id ?? null,
        user_name: ctx.user?.name ?? '',
        updated_at: now(),
      };
      db.run('DELETE FROM workflow_drafts WHERE workflow_id = ?', w.id);
      db.insert('workflow_drafts', row);
      return { ok: true, updated_at: row.updated_at };
    });
    router.delete('/api/workflows/:id/draft', 'location', (ctx) => {
      const w = must(ctx.locationId, ctx.params.id);
      db.run('DELETE FROM workflow_drafts WHERE workflow_id = ?', w.id);
      return { ok: true };
    });
    router.post('/api/workflows/:id/publish', 'location', async (ctx) => {
      const w = must(ctx.locationId, ctx.params.id);
      const d = parseJson(db.get<any>('SELECT * FROM workflow_drafts WHERE workflow_id = ?', w.id), ['trigger', 'steps', 'settings']);
      if (!d) throw bad('Kein Entwurf vorhanden – erst „Als Entwurf speichern“');
      const note = str(ctx.body?.note, 'Notiz', { max: 300 });
      pendingNote.set(w.id, note);
      let saved: any;
      try {
        saved = await callRoute(app, ctx, 'PATCH', `/api/workflows/${w.id}`, { name: d.name ?? w.name, trigger: d.trigger, steps: d.steps, settings: d.settings });
      } finally {
        pendingNote.delete(w.id);
      }
      db.run('DELETE FROM workflow_drafts WHERE workflow_id = ?', w.id);
      const v = db.get<any>('SELECT version FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC LIMIT 1', w.id);
      return { ...saved, version: v?.version ?? null };
    });
    router.post('/api/workflows/:id/versions/:version/restore', 'location', (ctx) => {
      const w = must(ctx.locationId, ctx.params.id);
      const v = parseJson(db.get<any>('SELECT * FROM workflow_versions WHERE workflow_id = ? AND version = ?', w.id, Number(ctx.params.version)), ['trigger', 'steps', 'settings']);
      if (!v) throw notFound('Version nicht gefunden');
      db.run('DELETE FROM workflow_drafts WHERE workflow_id = ?', w.id);
      db.insert('workflow_drafts', { workflow_id: w.id, location_id: ctx.locationId, name: v.name, trigger: v.trigger, steps: v.steps, settings: v.settings, base_version: v.version, user_id: ctx.user?.id ?? null, user_name: ctx.user?.name ?? '', updated_at: now() });
      return { ok: true, message: `Version ${v.version} liegt jetzt als Entwurf bereit – prüfen und veröffentlichen.` };
    });

    // --- export / import ----------------------------------------------------------------------------
    const refsOf = (steps: Step[], trigger: any) => {
      const refs = new Set<string>();
      const scan = (o: any) => {
        for (const k of REF_KEYS) {
          const v = o?.[k];
          if (Array.isArray(v)) v.filter(Boolean).forEach((x) => refs.add(`${k}:${x}`));
          else if (v) refs.add(`${k}:${v}`);
        }
      };
      scan(trigger?.config);
      for (const f of walk(steps)) scan(f.step);
      return [...refs];
    };
    /** Steps without secrets (header keys and passwords of HTTP steps are blanked), as a deep copy. */
    const stripSecrets = (steps: Step[]): Step[] =>
      (JSON.parse(JSON.stringify(steps ?? [])) as Step[]).map(function strip(s: Step): Step {
        const o: Step = stripHttpSecrets(s) as Step;
        for (const k of branchKeys(o)) o[k] = (o[k] ?? []).map(strip);
        return o;
      });
    const exportOne = (w: any) => ({
      format: EXPORT_FORMAT,
      version: 1,
      exported_at: now(),
      app_version: APP_VERSION,
      workflow: { name: w.name, trigger: w.trigger, steps: stripSecrets(w.steps), settings: w.settings ?? {} },
      references: refsOf(w.steps ?? [], w.trigger),
    });
    router.get('/api/workflows/:id/export', 'location', (ctx) => exportOne(must(ctx.locationId, ctx.params.id)));
    router.get('/api/workflow-export', 'location', (ctx) => ({
      format: BUNDLE_FORMAT,
      version: 1,
      exported_at: now(),
      app_version: APP_VERSION,
      workflows: parseRows(db.all<any>('SELECT * FROM workflows WHERE location_id = ? ORDER BY name', ctx.locationId), ['trigger', 'steps', 'settings']).map((w) => exportOne(w).workflow),
    }));

    /** New ids for every step, `goto`-style references rewritten. */
    const reId = (steps: Step[], map: Map<string, string>): Step[] => {
      for (const f of walk(steps)) if (!map.has(f.step.id)) map.set(f.step.id, newId(8));
      const redo = (list: Step[]): Step[] =>
        list.map((s) => {
          const o: Step = { ...s, id: map.get(s.id) ?? newId(8) };
          for (const k of ['target', 'timeout_target'] as const) if (typeof o[k] === 'string' && map.has(o[k])) o[k] = map.get(o[k]);
          for (const k of branchKeys(s)) o[k] = redo(s[k] ?? []);
          return o;
        });
      return redo(steps);
    };
    const warningsFor = (loc: string, steps: Step[], trigger: any): string[] => {
      const out: string[] = [];
      const exists = (table: string, v: unknown) => !!db.get(`SELECT 1 FROM ${table} WHERE id = ? AND location_id = ?`, String(v), loc);
      const tables: Record<string, [string, string]> = { pipeline_id: ['pipelines', 'Pipeline'], form_id: ['forms', 'Formular'], calendar_id: ['calendars', 'Kalender'], workflow_id: ['workflows', 'Workflow'], product_id: ['products', 'Produkt'], group_id: ['community_groups', 'Community-Gruppe'], course_id: ['courses', 'Kurs'], link_id: ['trigger_links', 'Trigger-Link'] };
      const check = (o: any, where: string) => {
        for (const [k, [table, label]] of Object.entries(tables)) {
          try {
            if (o?.[k] && !exists(table, o[k])) out.push(`${where}: ${label} „${o[k]}“ gibt es in diesem Sub-Account nicht – bitte neu wählen`);
          } catch {
            /* table of a module that is not installed */
          }
        }
        if (o?.template_id) {
          try {
            if (!db.get('SELECT 1 FROM contracts WHERE id = ? AND location_id = ?', String(o.template_id), loc) && !db.get('SELECT 1 FROM templates WHERE id = ? AND location_id = ?', String(o.template_id), loc)) out.push(`${where}: Vorlage „${o.template_id}“ nicht gefunden`);
          } catch {
            /* ignore */
          }
        }
      };
      check(trigger?.config, 'Auslöser');
      walk(steps).forEach((f, i) => check(f.step, `Schritt ${i + 1} (${f.step.type})`));
      return [...new Set(out)].slice(0, 40);
    };
    // Copy and paste of steps between workflows (modules/workflow-clipboard.ts) re-ids and checks like the import does.
    app.services.workflowImportKit = { reId, warningsFor, stripSecrets, refsOf };
    const importOne = async (ctx: Ctx, data: any, nameOverride?: string) => {
      const wf = data?.workflow ?? data;
      if (!wf || typeof wf !== 'object' || !Array.isArray(wf.steps)) throw bad('Das ist kein Workflow-Export (Feld „workflow.steps“ fehlt)');
      const trigger = checkTrigger(wf.trigger ?? { type: 'manual', config: {} });
      const steps = reId(cleanSteps(wf.steps), new Map());
      const name = str(nameOverride ?? wf.name, 'Name', { max: 200 }) || 'Importierter Workflow';
      const created = await callRoute(app, ctx, 'POST', '/api/workflows', { name, trigger, steps, settings: wf.settings && typeof wf.settings === 'object' ? { ...wf.settings, on_error_workflow_id: '' } : {} });
      return { id: created.id, name: created.name, steps: walk(steps).length, warnings: warningsFor(ctx.locationId, steps, trigger) };
    };
    router.post('/api/workflow-import', 'location', async (ctx) => {
      let data = ctx.body?.data ?? ctx.body;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {
          throw bad('Das ist kein gültiges JSON');
        }
      }
      if (!data || typeof data !== 'object') throw bad('Keine Daten');
      if (data.format === BUNDLE_FORMAT || Array.isArray(data.workflows)) {
        const list = (Array.isArray(data.workflows) ? data.workflows : []).slice(0, 100);
        if (!list.length) throw bad('Der Export enthält keine Workflows');
        const out = [];
        for (const w of list) out.push(await importOne(ctx, { workflow: w }));
        return { imported: out };
      }
      if (data.format && data.format !== EXPORT_FORMAT) throw bad(`Unbekanntes Format „${String(data.format).slice(0, 40)}“`);
      return { imported: [await importOne(ctx, data, ctx.body?.name ? String(ctx.body.name) : undefined)] };
    });

    // --- custom events from outside -----------------------------------------------------------------
    router.post('/api/custom-events', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const name = String(b.name ?? '').trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').slice(0, 60);
      if (!name) throw bad('Name des Ereignisses fehlt');
      const data = b.data && typeof b.data === 'object' && !Array.isArray(b.data) ? b.data : {};
      if (JSON.stringify(data).length > 50_000) throw bad('Die Daten sind zu groß (über 50 KB)');
      let contactId: string | undefined;
      if (b.contact_id) {
        if (!getContact(app, ctx.locationId, String(b.contact_id))) throw notFound('Kontakt nicht gefunden');
        contactId = String(b.contact_id);
      } else if (b.email || b.phone) {
        const email = String(b.email ?? '').trim().toLowerCase();
        const found = email ? db.get<any>('SELECT id FROM contacts WHERE location_id = ? AND email = ?', ctx.locationId, email) : db.get<any>('SELECT id FROM contacts WHERE location_id = ? AND phone = ?', ctx.locationId, String(b.phone));
        if (found) contactId = found.id;
        else if (b.create) contactId = upsertContact(app, ctx.locationId, { email: b.email, phone: b.phone, first_name: b.first_name, last_name: b.last_name }, { source: `Ereignis: ${name}` }).contact.id;
        else throw notFound('Kontakt nicht gefunden (create=true legt ihn an)');
      } else throw bad('contact_id, email oder phone angeben');
      app.events.emit(ctx.locationId, 'event.custom', { ...data, name, data, contactId, source: 'api' });
      return { ok: true, name, contactId };
    });
  },
};
