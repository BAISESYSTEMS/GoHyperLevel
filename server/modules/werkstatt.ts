import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Ctx, type User } from '../core/http.js';
import { id as newId, now } from '../core/util.js';
import type { SystemBlock, Usage } from '../services/anthropic.js';
import { getItem } from '../services/feedback-store.js';
import { PURPOSES } from './ai-assistant.js';
import { PUSH_KINDS } from './push.js';
import { callCost, describeAi, modelInfo } from '../services/werkstatt/aicost.js';
import { SCOPES, newScopes, riskOf, type Manifest } from '../services/werkstatt/manifest.js';
import { NAMES, STAGE_LABELS } from '../services/werkstatt/names.js';
import { PLAN_SCHEMA, PLAN_SYSTEM, PLUGIN_SCHEMA, PLUGIN_SYSTEM, changeUser, parsePlan, parsePluginOutput, planUser, pluginUser, type ParsedPlan, type PluginDraft } from '../services/werkstatt/generate.js';
import { activateVersion, storeVersion, upsertInstall } from '../services/werkstatt/lifecycle.js';
import { verificationText, verify } from '../services/werkstatt/logic.js';
import { tell, type Tell } from '../services/werkstatt/notify.js';
import { executeSteps, missingAreas, undoCreated, type Created, type PlanStep } from '../services/werkstatt/plan.js';
import { DEFAULT_POLICY, budgetProblem, budgetUsd, cleanPolicy, loadPolicy, mayBuild, needsApproval, savePolicy, spentMicros } from '../services/werkstatt/policy.js';
import { licenseInfo } from '../services/werkstatt/license.js';
import { GATE_FAMILIES } from '../services/werkstatt/modelgate.js';
import { gateProblem, gateStatus } from '../services/werkstatt/models.js';
import { effortOverview } from '../services/werkstatt/effortview.js';
import { EFFORT_LABELS, type EffortPlan } from '../services/ai-effort.js';
import { probeSandbox } from '../services/werkstatt/sandbox.js';
import { canManage, createPlugin, getPlugin, getVersion, nextVersion, setVersionMeta, versionsOf } from '../services/werkstatt/store.js';
import { diffVersions } from '../services/werkstatt/diff.js';

/**
 * Werkstatt: a wish becomes a build. The AI analyses it and proposes a plan in one of two stages –
 * „Einrichtung“ (no code: workflows, fields, objects, reports, agents, templates, forms …) or „Mini-App“ (a
 * sandboxed plugin). The requester (or an admin) sees what gets created, which permissions it needs and what it
 * may cost, confirms, and the build runs: with a log, cost tracking against a monthly budget per sub-account
 * and – by policy – an admin's approval first. "Ändern lassen" makes a new plugin version from chat feedback.
 */

type Row = Record<string, any>;
const jsonOr = <T>(s: unknown, fallback: T): T => {
  try {
    return s === null || s === undefined ? fallback : (JSON.parse(String(s)) as T);
  } catch {
    return fallback;
  }
};
const LOG_MAX = 200;
const STATUS_LABELS: Record<string, string> = { planning: 'Wird analysiert', planned: 'Plan liegt vor', awaiting_approval: 'Wartet auf Freigabe', building: 'Wird gebaut', done: 'Fertig', failed: 'Fehlgeschlagen', cancelled: 'Abgebrochen', rejected: 'Abgelehnt', undone: 'Rückgängig gemacht' };

export const werkstattModule: Module = {
  name: 'werkstatt',
  migrations: [
    [
      '001-init',
      `CREATE TABLE werkstatt_builds (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        user_id TEXT, user_name TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'new', wish_id TEXT, plugin_id TEXT,
        text TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', stage INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'planning',
        plan TEXT NOT NULL DEFAULT '{}', created TEXT NOT NULL DEFAULT '[]', log TEXT NOT NULL DEFAULT '[]',
        est_cost_micros INTEGER NOT NULL DEFAULT 0, cost_micros INTEGER NOT NULL DEFAULT 0,
        tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, ai_calls INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '', consent TEXT NOT NULL DEFAULT '{}', approval_by TEXT, approval_at TEXT, approval_note TEXT NOT NULL DEFAULT '',
        version_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT
      );
      CREATE INDEX werkstatt_builds_loc ON werkstatt_builds(location_id, created_at);
      CREATE INDEX werkstatt_builds_status ON werkstatt_builds(status, updated_at);`,
    ],
    [
      '002-progress-notices',
      `ALTER TABLE werkstatt_builds ADD COLUMN progress TEXT NOT NULL DEFAULT '{}';
      CREATE TABLE werkstatt_notices (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, build_id TEXT,
        kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
        read_at TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX werkstatt_notices_user ON werkstatt_notices(user_id, read_at, created_at);`,
    ],
    // Which model wrote it and with which Denkstufe (shown on every build and version).
    ['003-ai-meta', `ALTER TABLE werkstatt_builds ADD COLUMN ai TEXT NOT NULL DEFAULT '{}';`],
  ],
  register(app) {
    const { db, router } = app;
    Object.assign(PURPOSES, { werkstatt_plan: `${NAMES.werkstatt}: Plan`, werkstatt_build: `${NAMES.werkstatt}: Bau`, werkstatt_review: `${NAMES.werkstatt}: Sicherheitsprüfung`, werkstatt_review2: `${NAMES.werkstatt}: Zweitmeinung`, werkstatt_spec: `${NAMES.werkstatt}: Kernfeature-Spezifikation`, plugin: 'Plugin' });
    // Members can switch these push notifications off in Einstellungen → Mein Konto like the other kinds.
    Object.assign(PUSH_KINDS, { werkstatt: { label: `${NAMES.werkstatt}: Pläne, Freigaben und fertige Aufträge`, perm: '' } });
    const running = new Set<Promise<unknown>>();
    const detach = (p: Promise<unknown>) => {
      const q = p.catch((e) => console.error('[werkstatt]', (e as Error).message)).finally(() => running.delete(q));
      running.add(q);
    };
    /** Tests wait for background builds. */
    app.services.werkstatt = { idle: async () => void (await Promise.all([...running])) };

    const user = (ctx: Ctx): User | undefined => ctx.user;
    const isAdmin = (u: User | undefined) => !!u && u.role === 'admin';
    const loadUser = (id: string | null): User | null => {
      const r = id ? db.get('SELECT * FROM users WHERE id = ?', id) : null;
      return r ? { id: r.id, email: r.email, name: r.name, role: r.role, locations: JSON.parse(r.locations || '[]'), permissions: r.permissions ? JSON.parse(r.permissions) : null } : null;
    };

    // --- AI: model, price, one call with cost tracking ---------------------------------------------------------------
    const modelOf = (locId: string) => modelInfo(app, locId);
    /** What a plugin build typically costs: the system prompt, the plan and the code (output is the expensive part). */
    const estimate = (locId: string, kind: 'plan' | 'build' | 'change') => {
      const m = modelOf(locId);
      const typical: Usage = kind === 'plan' ? { input_tokens: 5500, output_tokens: 1500, cache_read_tokens: 0, cache_write_tokens: 0 } : { input_tokens: 8500 + (kind === 'change' ? 4000 : 0), output_tokens: 7000, cache_read_tokens: 0, cache_write_tokens: 0 };
      // The worst case includes two repair rounds.
      const max: Usage = kind === 'plan' ? { ...typical, input_tokens: typical.input_tokens * 2, output_tokens: typical.output_tokens * 2 } : { ...typical, input_tokens: typical.input_tokens * 3, output_tokens: typical.output_tokens * 3 };
      return { model: m.model, typical_micros: m.price(typical), max_micros: m.price(max) };
    };
    interface CallResult {
      text: string;
      usage?: Usage;
      model: string;
      costMicros?: number;
      effort?: EffortPlan;
    }
    /** Model and Denkstufe of the calls of a build: kept on the row, one line in the log per new combination. */
    const noteAi = (id: string, purpose: string, r: CallResult) => {
      const cur = jsonOr<Row>(get(id)?.ai, {});
      const e = r.effort;
      const entry = { purpose, model: r.model, requested: e?.requested ?? null, applied: e?.applied ?? null, note: e?.note ?? '' };
      const calls: any[] = (cur.calls ?? []).filter((c: any) => !(c.purpose === purpose && c.model === entry.model && c.applied === entry.applied));
      const fresh = calls.length === (cur.calls ?? []).length;
      calls.push(entry);
      const main = purpose === 'werkstatt_build' || !cur.model ? entry : { model: cur.model, applied: cur.applied, requested: cur.requested, note: cur.note };
      set(id, { ai: { model: main.model, requested: main.requested, applied: main.applied, label: main.applied ? EFFORT_LABELS[main.applied as keyof typeof EFFORT_LABELS] : '', note: main.note, calls: calls.slice(-12) } });
      if (fresh) log(id, `KI: ${r.model} · Denkstufe ${e?.applied ? EFFORT_LABELS[e.applied] : 'nicht gesendet'}${e?.note ? ` (${e.note})` : ''}`);
    };
    /** One AI call for a build: budget check first, cost and tokens added to the build afterwards. */
    const ask = async (b: Row, purpose: string, system: SystemBlock[], userText: string, schema: Record<string, unknown>, maxTokens: number): Promise<CallResult> => {
      const run = app.services.aiRun as ((i: Record<string, unknown>) => Promise<CallResult>) | undefined;
      if (!run) throw new HttpError(409, 'Die KI ist nicht eingerichtet (Einstellungen → KI-Assistent).');
      const over = budgetProblem(app, loadPolicy(app), b.location_id, 0);
      if (over) throw new HttpError(409, over);
      // Only a top model writes code and reviews it: refuse before anything is spent.
      const refused = gateProblem(app, b.location_id, purpose, loadUser(b.user_id) ?? undefined);
      if (refused) throw new HttpError(409, refused);
      let r: CallResult | undefined;
      try {
        r = await run({ locationId: b.location_id, purpose, system, user: userText, schema, maxTokens, timeoutMs: 240_000, userId: b.user_id });
        return r;
      } finally {
        // aiRun logs failed calls itself; the build only counts what came back with usage.
        if (r) {
          const cost = callCost(app, b.location_id, r);
          db.run('UPDATE werkstatt_builds SET cost_micros = cost_micros + ?, tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, ai_calls = ai_calls + 1, updated_at = ? WHERE id = ?', Math.round(cost), r.usage?.input_tokens ?? 0, r.usage?.output_tokens ?? 0, now(), b.id);
          noteAi(b.id, purpose, r);
        }
      }
    };

    /** Model and Denkstufe of the build, as stored on the version. */
    const versionAi = (id: string) => {
      const a = jsonOr<Row>(get(id)?.ai, {});
      return { model: String(a.model ?? ''), requested: (a.requested ?? null) as string | null, applied: (a.applied ?? null) as string | null, label: String(a.label ?? ''), note: String(a.note ?? '') };
    };

    // --- rows ---------------------------------------------------------------------------------------------------------------
    const get = (id: string): Row | undefined => db.get('SELECT * FROM werkstatt_builds WHERE id = ?', id);
    const log = (id: string, text: string, level: 'info' | 'error' = 'info') => {
      const cur = jsonOr<any[]>(db.get<{ log: string }>('SELECT log FROM werkstatt_builds WHERE id = ?', id)?.log, []);
      cur.push({ at: now(), level, text: text.slice(0, 400) });
      db.run('UPDATE werkstatt_builds SET log = ?, updated_at = ? WHERE id = ?', JSON.stringify(cur.slice(-LOG_MAX)), now(), id);
    };
    const set = (id: string, patch: Row) => {
      const keys = Object.keys(patch);
      db.run(`UPDATE werkstatt_builds SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => (patch[k] !== null && typeof patch[k] === 'object' ? JSON.stringify(patch[k]) : patch[k])), now(), id);
    };
    /** What the build is doing right now ("Schritt 2 von 3 …"): shown live next to the log. */
    const progress = (id: string, label: string, current = 0, total = 0) => set(id, { progress: { label, current, total } });
    /** In-app note + push (+ email for decisions people wait for), in the background. */
    const notify = (t: Tell) => detach(tell(app, t));
    const admins = () => db.all<{ id: string }>(`SELECT id FROM users WHERE role = 'admin'`).map((r) => r.id);

    const out = (b: Row, full = false) => {
      const plan = jsonOr<Row>(b.plan, {});
      const policy = loadPolicy(app);
      const brief = {
        id: b.id,
        kind: b.kind,
        status: b.status,
        status_label: STATUS_LABELS[b.status] ?? b.status,
        stage: b.stage,
        stage_label: STAGE_LABELS[b.stage] ?? '',
        title: b.title || plan.title || b.text.slice(0, 80),
        text: b.text,
        wish_id: b.wish_id,
        plugin_id: b.plugin_id,
        user: b.user_name,
        location_id: b.location_id,
        location: app.location(b.location_id)?.name ?? '',
        est_cost_usd: Math.round(b.est_cost_micros) / 1e6,
        cost_usd: Math.round(b.cost_micros) / 1e6,
        tokens: b.tokens_in + b.tokens_out,
        error: b.error,
        ai: jsonOr<Row>(b.ai, {}),
        needs_approval: b.status === 'awaiting_approval',
        progress: jsonOr(b.progress, {}),
        created_at: b.created_at,
        updated_at: b.updated_at,
        finished_at: b.finished_at,
      };
      if (!full) return brief;
      const manifest: Manifest | undefined = plan.manifest;
      return {
        ...brief,
        plan: { stage: plan.stage ?? b.stage, title: plan.title, summary: plan.summary, rationale: plan.rationale, notes: plan.notes ?? [], steps: (plan.steps ?? []).map((s: PlanStep) => ({ block: s.block, title: s.title, area: s.area })), areas: plan.areas ?? [], scopes: (plan.scopes ?? []).map((k: string) => ({ key: k, label: SCOPES[k]?.label ?? k, hint: SCOPES[k]?.hint ?? '', risk: SCOPES[k]?.risk ?? 'medium', write: !!SCOPES[k]?.write })), risk: riskOf(plan.scopes ?? []), manifest: manifest ? { name: manifest.name, icon: manifest.icon, description: manifest.description, category: manifest.category, entries: manifest.entries, server: manifest.server } : null, change: plan.change ?? null, estimate: plan.estimate ?? null, missing_areas: plan.missing_areas ?? [], draft_issues: plan.draft_issues ?? [], model_gate: plan.model_gate ?? { ok: true }, ai: plan.ai ?? null, diff: plan.diff ?? null, new_scopes: plan.new_scopes ?? [] },
        log: jsonOr(b.log, []),
        created: jsonOr(b.created, []),
        approval: b.approval_at ? { by: db.get('SELECT name FROM users WHERE id = ?', b.approval_by)?.name ?? '', at: b.approval_at, note: b.approval_note } : null,
        budget: { limit_usd: budgetUsd(policy, b.location_id), used_usd: Math.round(spentMicros(app, b.location_id)) / 1e6 },
        undoable: b.stage === 1 && b.status === 'done' && jsonOr<Created[]>(b.created, []).some((c) => !c.undone),
      };
    };
    const mine = (ctx: Ctx, b: Row | undefined): Row => {
      const u = user(ctx);
      if (!b || b.location_id !== ctx.locationId || !(isAdmin(u) || (u && b.user_id === u.id) || (!u && !b.user_id))) throw notFound('Auftrag nicht gefunden');
      return b;
    };
    const owner = (b: Row) => loadUser(b.user_id);

    // --- inventory for the prompt ---------------------------------------------------------------------------------
    const inventory = (locId: string) => {
      const names = (sql: string) => {
        try {
          return db.all<{ n: string }>(sql, locId).map((r) => r.n).slice(0, 15).join(', ');
        } catch {
          return '';
        }
      };
      return [
        ['Automationen', names('SELECT name AS n FROM workflows WHERE location_id = ? ORDER BY updated_at DESC LIMIT 15')],
        ['Eigene Kontaktfelder', names('SELECT label AS n FROM custom_fields WHERE location_id = ? LIMIT 15')],
        ['Eigene Objekte', names('SELECT plural AS n FROM object_types WHERE location_id = ? LIMIT 15')],
        ['Pipelines', names('SELECT name AS n FROM pipelines WHERE location_id = ? LIMIT 15')],
        ['Formulare', names('SELECT name AS n FROM forms WHERE location_id = ? LIMIT 15')],
        ['Tags', names('SELECT name AS n FROM tags WHERE location_id = ? LIMIT 15')],
      ]
        .filter(([, v]) => v)
        .map(([k, v]) => `- ${k}: ${v}`)
        .join('\n');
    };

    // --- stage decision: the plan ------------------------------------------------------------------------------------
    const analyze = async (id: string) => {
      const b = get(id);
      if (!b) return;
      try {
        const u = owner(b);
        const loc = app.location(b.location_id);
        const [title, ...rest] = String(b.text).split('\n');
        const system: SystemBlock[] = [{ text: PLAN_SYSTEM, cache: true }];
        let repair: string | undefined;
        let plan: ParsedPlan | undefined;
        const rounds = 1 + loadPolicy(app).repair_rounds;
        for (let attempt = 0; attempt < rounds && !plan; attempt++) {
          log(id, attempt ? `Der Plan war unbrauchbar (${repair}) – die KI korrigiert ihn (Versuch ${attempt + 1} von ${rounds}).` : 'Die KI analysiert den Wunsch …', attempt ? 'error' : 'info');
          progress(id, attempt ? `Plan wird korrigiert (Versuch ${attempt + 1} von ${rounds})` : 'Die KI analysiert den Wunsch', attempt + 1, rounds);
          const r = await ask(get(id)!, 'werkstatt_plan', system, planUser({ title: b.title || title, body: rest.join('\n').trim(), locationName: loc?.name ?? '', inventory: inventory(b.location_id), repair }), PLAN_SCHEMA, 4000);
          const parsed = parsePlan(r.text);
          if (parsed.ok) plan = parsed.value;
          else repair = parsed.error;
        }
        if (!plan) throw new HttpError(502, `Die KI hat auch nach ${rounds} Versuch${rounds === 1 ? '' : 'en'} keinen brauchbaren Plan geliefert (${repair}). Bitte beschreibe den Wunsch genauer – oder prüfe unter Einstellungen → KI-Anbieter, ob das gewählte Modell strukturierte Antworten (JSON) liefern kann.`);
        const policy = loadPolicy(app);
        const notes = [...plan.notes];
        const areas = [...new Set(plan.steps.map((s) => s.area).filter((a): a is string => !!a))];
        const scopes = plan.manifest?.scopes ?? [];
        // Server logic the policy does not allow is said now, not after the build.
        if (plan.manifest && (plan.manifest.entries.actions?.length || plan.manifest.entries.jobs?.length)) {
          if (policy.server_logic === 'off') notes.push('Aktionen und Jobs sind laut Richtlinie ausgeschaltet – dieses Plugin kann so nicht gebaut werden.');
          else if (plan.manifest.server?.mode === 'script' && policy.server_logic === 'declarative') notes.push('Skripte sind laut Richtlinie aus – das Plugin muss aus deklarativen Schritten bestehen.');
          else if (plan.manifest.server?.mode === 'script' && !(await probeSandbox()).ok) notes.push('Die Skript-Sandbox ist auf diesem Server nicht verfügbar – Server-Logik ist nur deklarativ möglich.');
        }
        const est = plan.stage === 2 ? estimate(b.location_id, 'build') : { model: modelOf(b.location_id).model, typical_micros: 0, max_micros: 0 };
        const missing = missingAreas(u ?? undefined, plan.steps);
        // Stufe 1 may be planned with the everyday model; a Mini-App needs a top model – say so now, not after the click.
        const modelGate = plan.stage === 2 ? gateProblem(app, b.location_id, 'werkstatt_build', u ?? undefined) : null;
        if (modelGate) notes.push(modelGate);
        const buildAi = describeAi(app, b.location_id, 'werkstatt_build');
        const stored = { stage: plan.stage, title: plan.title, summary: plan.summary, rationale: plan.rationale, notes, steps: plan.steps, areas, scopes, manifest: plan.manifest ?? null, estimate: { model: est.model, typical_usd: est.typical_micros / 1e6, max_usd: est.max_micros / 1e6 }, missing_areas: missing, model_gate: modelGate ? { ok: false, message: modelGate } : { ok: true }, ai: plan.stage === 2 ? { model: buildAi.model, effort: effortOverview(app, b.location_id, buildAi) } : null };
        set(id, { plan: stored, stage: plan.stage, title: plan.title, status: 'planned', est_cost_micros: est.typical_micros, progress: {} });
        log(id, `Plan: ${STAGE_LABELS[plan.stage]} – ${plan.title}`);
        notify({ userIds: [b.user_id], kind: 'plan', title: `${NAMES.werkstatt}: Dein Plan liegt vor`, body: plan.title, path: `/app/werkstatt/${id}`, buildId: id, locationId: b.location_id });
      } catch (e) {
        const msg = (e as Error).message || 'Fehler';
        log(id, `Analyse fehlgeschlagen: ${msg}`, 'error');
        set(id, { status: 'failed', error: msg, finished_at: now(), progress: {} });
        const b2 = get(id);
        if (b2) notify({ userIds: [b2.user_id], kind: 'failed', title: `${NAMES.werkstatt}: Der Plan ist fehlgeschlagen`, body: msg.slice(0, 200), path: `/app/werkstatt/${id}`, buildId: id, locationId: b2.location_id });
      }
    };

    // --- stage 1/2: the build -------------------------------------------------------------------------------------------
    const finish = (id: string, status: 'done' | 'failed', patch: Row = {}) => {
      set(id, { status, finished_at: now(), progress: {}, ...patch });
      const b = get(id)!;
      notify({ userIds: [b.user_id], kind: status === 'done' ? 'done' : 'failed', title: status === 'done' ? `${NAMES.werkstatt}: „${b.title}“ ist fertig` : `${NAMES.werkstatt}: Bau fehlgeschlagen`, body: status === 'done' ? 'Jetzt ansehen' : String(b.error).slice(0, 200), path: `/app/werkstatt/${id}`, buildId: id, locationId: b.location_id });
    };

    /** Writes the plugin with the AI, repairing up to twice until the checks and the sandbox self-test pass. */
    const generate = async (id: string, input: (repair?: string) => { user: string }, version: string, keep: { slug?: string } | undefined): Promise<{ draft: PluginDraft; verification: Awaited<ReturnType<typeof verify>> } | { error: string; draft?: PluginDraft; issues?: string[] }> => {
      let repair: string | undefined;
      let last: PluginDraft | undefined;
      const rounds = 1 + loadPolicy(app).repair_rounds;
      for (let attempt = 0; attempt < rounds; attempt++) {
        log(id, attempt ? `Die KI überarbeitet das Plugin (Versuch ${attempt + 1} von ${rounds}) …` : 'Die KI schreibt das Plugin …');
        progress(id, attempt ? `Plugin wird überarbeitet (Versuch ${attempt + 1} von ${rounds})` : 'Die KI schreibt das Plugin', attempt + 1, rounds);
        const b = get(id)!;
        const r = await ask(b, 'werkstatt_build', [{ text: PLUGIN_SYSTEM, cache: true }], input(repair).user, PLUGIN_SCHEMA, 14_000);
        const parsed = parsePluginOutput(r.text, version, keep);
        if (!parsed.ok) {
          repair = `Die Ausgabe war unbrauchbar: ${parsed.error}`;
          log(id, repair, 'error');
          continue;
        }
        last = parsed.value;
        progress(id, 'Sicherheitsprüfung und Selbsttest laufen', attempt + 1, rounds);
        const v = await verify(app, { manifest: last.manifest, ui_html: last.ui_html, server_js: last.server_js, steps: last.steps }, b.location_id);
        if (v.ok) {
          log(id, `Prüfungen bestanden${v.issues.some((i) => i.level === 'warn') ? ` (${v.issues.filter((i) => i.level === 'warn').length} Hinweise)` : ''}.`);
          return { draft: last, verification: v };
        }
        repair = verificationText(v);
        log(id, `Die Prüfung hat Probleme gefunden:\n${repair}`, 'error');
        if (attempt === rounds - 1) return { error: `Das Plugin hat die automatische Prüfung auch nach ${rounds} Versuch${rounds === 1 ? '' : 'en'} nicht bestanden:\n${repair}`, draft: last, issues: v.issues.filter((i) => i.level === 'error').map((i) => i.message) };
      }
      return { error: `Die KI hat auch nach ${rounds} Versuch${rounds === 1 ? '' : 'en'} kein brauchbares Plugin geliefert (${repair}). Prüfe unter Einstellungen → KI-Anbieter, ob das Modell lange, strukturierte Antworten (JSON) liefern kann – oder wähle ein stärkeres.`, draft: last };
    };

    const buildStage1 = async (id: string, runner: User) => {
      const b = get(id)!;
      const plan = jsonOr<Row>(b.plan, {});
      log(id, `Baue ${plan.steps.length} Schritt${plan.steps.length === 1 ? '' : 'e'} im Sub-Account „${app.location(b.location_id)?.name ?? ''}“ …`);
      const r = await executeSteps(app, { user: runner, locationId: b.location_id, steps: plan.steps, label: NAMES.werkstatt, log: (t, l) => log(id, t, l), progress: (i, n, title) => progress(id, title, i, n) });
      set(id, { created: r.created });
      if (r.error) return finish(id, 'failed', { error: r.error });
      finish(id, 'done');
    };

    const buildStage2 = async (id: string, runner: User) => {
      const b = get(id)!;
      const plan = jsonOr<Row>(b.plan, {});
      const manifest: Manifest = plan.manifest;
      const policy = loadPolicy(app);
      if (policy.server_logic === 'off' && (manifest.entries.actions?.length || manifest.entries.jobs?.length)) return finish(id, 'failed', { error: 'Server-Logik ist laut Richtlinie ausgeschaltet – Aktionen und Jobs lassen sich nicht bauen.' });
      const [title, ...rest] = String(b.text).split('\n');
      const planText = JSON.stringify({ title: plan.title, summary: plan.summary, manifest }, null, 1);
      const res = await generate(id, (repair) => ({ user: pluginUser({ title: b.title && b.wish_id ? b.title : title, body: rest.join('\n').trim(), plan: planText, repair }) }), '1.0.0', undefined);
      if ('error' in res) {
        if (res.draft) set(id, { plan: { ...plan, draft_issues: res.issues ?? [] } });
        return finish(id, 'failed', { error: res.error });
      }
      const { draft, verification } = res;
      const p = createPlugin(app, { manifest: draft.manifest, ownerLocationId: b.location_id, ownerUserId: runner.id, origin: 'werkstatt', wishId: b.wish_id });
      const { version } = await storeVersion(app, p, { ...draft, changelog: draft.changelog || 'Erste Version', source: 'ai', buildId: id, meta: { ai: versionAi(id) } }, runner, b.location_id, verification);
      activateVersion(app, p, version, runner, version.manifest.scopes);
      upsertInstall(app, { pluginId: p.id, locationId: b.location_id, userId: runner.id, consent: version.manifest.scopes, by: runner.id });
      log(id, `Das Plugin „${draft.manifest.name}“ ist jetzt für dich aktiv – privat, nur in diesem Sub-Account.`);
      finish(id, 'done', { plugin_id: p.id, version_id: version.id, plan: { ...plan, notes: [...(plan.notes ?? []), ...draft.notes] } });
    };

    const buildChange = async (id: string, runner: User) => {
      const b = get(id)!;
      const plan = jsonOr<Row>(b.plan, {});
      const p = b.plugin_id ? getPlugin(app, b.plugin_id) : undefined;
      const cur = p && getVersion(app, p.active_version_id);
      if (!p || !cur) return finish(id, 'failed', { error: 'Das Plugin gibt es nicht mehr.' });
      const version = nextVersion(app, p.id, versionsOf(app, p.id)[0]?.version ?? cur.version);
      const res = await generate(id, (repair) => ({ user: changeUser({ feedback: b.text, manifest: cur.manifest, ui_html: cur.ui_html, server_js: cur.server_js, steps: cur.steps, repair }) }), version, { slug: p.slug });
      if ('error' in res) return finish(id, 'failed', { error: res.error });
      const { draft, verification } = res;
      const { version: v } = await storeVersion(app, p, { ...draft, changelog: draft.changelog || b.text.slice(0, 200), source: 'ai', buildId: id, meta: { ai: versionAi(id) } }, runner, b.location_id, verification);
      const diff = diffVersions(cur, v);
      setVersionMeta(app, v.id, { diff });
      for (const line of diff.summary) log(id, `Änderung: ${line}`);
      const added = newScopes(cur.manifest.scopes, draft.manifest.scopes);
      // A private plugin switches to the new version at once; a shared one, or one that asks for more, waits for its author's click.
      if (p.scope === 'private' && !added.length) {
        activateVersion(app, p, v, runner);
        log(id, `Version ${v.version} ist aktiv. Die alte Version bleibt in der Versionsliste (Zurückrollen möglich).`);
      } else log(id, `Version ${v.version} ist fertig geprüft${added.length ? ` und fragt neue Berechtigungen an (${added.join(', ')})` : ''} – bitte beim Plugin aktivieren.`);
      finish(id, 'done', { version_id: v.id, plan: { ...plan, new_scopes: added, diff } });
    };

    const run = async (id: string, runner: User) => {
      const b = get(id);
      if (!b || b.status !== 'building') return;
      try {
        if (b.kind === 'change') await buildChange(id, runner);
        else if (b.stage === 1) await buildStage1(id, runner);
        else await buildStage2(id, runner);
      } catch (e) {
        const msg = (e as Error).message || 'Fehler';
        log(id, `Bau fehlgeschlagen: ${msg}`, 'error');
        finish(id, 'failed', { error: msg });
      }
    };

    // --- creating builds -------------------------------------------------------------------------------------------------
    const AI_HINT = 'Die KI wird pro Sub-Account freigeschaltet: Einstellungen → KI-Assistent einschalten und unter „KI-Anbieter“ eine Verbindung hinterlegen (Anthropic, OpenAI oder jeder OpenAI-kompatible Dienst wie OpenRouter) – oder die Agentur hinterlegt eine Verbindung für alle.';
    const aiProblem = (locId: string): string | null => (app.services.aiReady?.(locId) as string | null | undefined) ?? (app.services.aiRun ? null : 'Die KI ist nicht eingerichtet.');
    const gate = (ctx: Ctx) => {
      const policy = loadPolicy(app);
      const can = mayBuild(policy, user(ctx), ctx.locationId);
      if (!can.ok) throw new HttpError(403, can.reason);
      const ai = aiProblem(ctx.locationId);
      if (ai) throw new HttpError(409, ai);
      // With "Stufe 1 darf das normale Modell" off, even planning needs a top model.
      const refused = gateProblem(app, ctx.locationId, 'werkstatt_plan', user(ctx));
      if (refused) throw new HttpError(409, refused);
      return policy;
    };
    const create = (ctx: Ctx, o: { kind: 'new' | 'change'; text: string; title?: string; wishId?: string | null; pluginId?: string | null }) => {
      const u = user(ctx);
      const row = { id: newId(), location_id: ctx.locationId, user_id: u?.id ?? null, user_name: (u ? (db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', u.id)?.name ?? u.name) : 'API-Schlüssel'), kind: o.kind, wish_id: o.wishId ?? null, plugin_id: o.pluginId ?? null, text: o.text, title: o.title ?? '', stage: o.kind === 'change' ? 2 : 0, status: o.kind === 'change' ? 'planned' : 'planning', plan: '{}', created: '[]', log: '[]', est_cost_micros: 0, cost_micros: 0, tokens_in: 0, tokens_out: 0, ai_calls: 0, error: '', consent: '{}', approval_note: '', created_at: now(), updated_at: now() };
      db.insert('werkstatt_builds', row);
      return row.id;
    };

    router.post('/api/werkstatt/builds', 'location', (ctx) => {
      const policy = gate(ctx);
      const u = user(ctx);
      let text = str(ctx.body?.text, 'Wunsch', { max: 4000 });
      let title = str(ctx.body?.title, 'Titel', { max: 150 });
      let wishId: string | null = null;
      if (ctx.body?.wish_id) {
        const f = getItem(app, String(ctx.body.wish_id));
        if (!f || f.kind !== 'wish' || (f.hidden && !isAdmin(u))) throw notFound('Wunsch nicht gefunden');
        wishId = f.id;
        title = title || f.title;
        text = text || [f.title, f.body].filter(Boolean).join('\n');
      }
      if (text.trim().length < 8) throw bad('Bitte beschreibe den Wunsch in ein bis zwei Sätzen.');
      // Planning costs a little too: stop early when the month's budget is gone.
      const over = budgetProblem(app, policy, ctx.locationId, 0);
      if (over) throw new HttpError(409, over);
      const open = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM werkstatt_builds WHERE location_id = ? AND user_id IS ? AND status IN ('planning', 'building')`, ctx.locationId, u?.id ?? null)!.n;
      if (open >= 2) throw new HttpError(429, 'Es laufen schon zwei Aufträge – bitte warte, bis einer fertig ist.');
      const id = create(ctx, { kind: 'new', text: wishId && !ctx.body?.text ? text : [title, text].filter((x, i, a) => x && a.indexOf(x) === i).join('\n'), title, wishId });
      log(id, 'Auftrag angelegt.');
      detach(analyze(id));
      return out(get(id)!, true);
    });
    router.get('/api/werkstatt/builds', 'location', (ctx) => {
      const u = user(ctx);
      const rows = db.all(`SELECT * FROM werkstatt_builds WHERE location_id = ? ${isAdmin(u) ? '' : 'AND user_id IS ?'} ORDER BY created_at DESC LIMIT 100`, ctx.locationId, ...(isAdmin(u) ? [] : [u?.id ?? null]));
      return rows.map((b) => out(b));
    });
    router.get('/api/werkstatt/builds/:id', 'location', (ctx) => out(mine(ctx, get(ctx.params.id)), true));

    const start = (id: string, runner: User) => {
      set(id, { status: 'building' });
      log(id, 'Bau gestartet.');
      detach(run(id, runner));
    };
    /** The requester (or an admin) accepts the plan; by policy it then waits for an admin's approval before anything is built. */
    const confirm = (ctx: Ctx, b: Row, accept: { scopes?: unknown; areas?: unknown }) => {
      if (b.status !== 'planned') throw bad('Dieser Auftrag wartet nicht auf eine Bestätigung.');
      const u = user(ctx);
      const plan = jsonOr<Row>(b.plan, {});
      const policy = loadPolicy(app);
      if (plan.missing_areas?.length && !isAdmin(u)) throw new HttpError(403, `Dir fehlt das Recht für: ${plan.missing_areas.join(', ')}. Ein Admin kann den Plan bestätigen.`);
      // Consent: the confirm lists exactly the permissions the plan shows.
      const wantScopes = [...(plan.scopes ?? [])].sort().join(',');
      const wantAreas = [...(plan.areas ?? [])].sort().join(',');
      if (b.kind !== 'change') {
        if (!Array.isArray(accept.scopes) || [...accept.scopes.map(String)].sort().join(',') !== wantScopes) throw bad('Bitte bestätige die Berechtigungen des Plans.');
        if (!Array.isArray(accept.areas) || [...accept.areas.map(String)].sort().join(',') !== wantAreas) throw bad('Bitte bestätige die Bereiche, die der Plan anlegt.');
      }
      if (b.stage === 2 || b.kind === 'change') {
        const refused = gateProblem(app, b.location_id, 'werkstatt_build', u);
        if (refused) throw new HttpError(409, refused);
        const over = budgetProblem(app, policy, b.location_id, b.kind === 'change' ? estimate(b.location_id, 'change').typical_micros : (plan.estimate?.typical_usd ?? 0) * 1e6);
        if (over) throw new HttpError(409, over);
      }
      set(b.id, { consent: { scopes: plan.scopes ?? [], areas: plan.areas ?? [], by: u?.id ?? null, at: now() } });
      if (needsApproval(policy, u)) {
        set(b.id, { status: 'awaiting_approval' });
        log(b.id, `${u?.name ?? 'Der Auftraggeber'} hat den Plan bestätigt – wartet auf die Freigabe eines Admins.`);
        notify({
          userIds: admins().filter((a) => a !== u?.id),
          kind: 'approval',
          title: `${NAMES.werkstatt}: Freigabe nötig – ${b.title || b.text.slice(0, 60)}`,
          body: `${b.user_name} (${app.location(b.location_id)?.name ?? ''}) möchte „${b.title || b.text.slice(0, 80)}“ bauen lassen${plan.estimate?.typical_usd ? ` – geschätzt ${plan.estimate.typical_usd.toLocaleString('de-DE', { minimumFractionDigits: 2 })} $ KI-Kosten` : ''}.`,
          path: `/app/werkstatt/${b.id}`,
          buildId: b.id,
          locationId: b.location_id,
          actions: [{ action: 'approve', title: 'Freigeben' }, { action: 'reject', title: 'Ablehnen' }],
          email: true,
        });
      } else {
        // An admin confirming runs it under their own name; a member (no approval needed) under theirs.
        const runner = u ?? owner(b);
        if (!runner) throw new HttpError(403, 'Bauen braucht eine Anmeldung (nicht einen API-Schlüssel).');
        start(b.id, runner);
      }
      return out(get(b.id)!, true);
    };
    router.post('/api/werkstatt/builds/:id/confirm', 'location', (ctx) => {
      const b = mine(ctx, get(ctx.params.id));
      gate(ctx);
      return confirm(ctx, b, { scopes: ctx.body?.accept_scopes, areas: ctx.body?.accept_areas });
    });
    /** "Plan neu erstellen": the same wish planned again – e.g. after the admin connected a top model. */
    router.post('/api/werkstatt/builds/:id/replan', 'location', (ctx) => {
      const b = mine(ctx, get(ctx.params.id));
      if (b.kind !== 'new' || !['planned', 'failed'].includes(b.status)) throw bad('Nur ein fertiger oder fehlgeschlagener Plan lässt sich neu erstellen.');
      const policy = gate(ctx);
      const over = budgetProblem(app, policy, ctx.locationId, 0);
      if (over) throw new HttpError(409, over);
      if (b.status === 'planned') {
        set(b.id, { status: 'cancelled', finished_at: now() });
        log(b.id, 'Abgebrochen – der Plan wird neu erstellt.');
      }
      const id = create(ctx, { kind: 'new', text: b.text, title: b.title, wishId: b.wish_id });
      log(id, 'Auftrag angelegt (neuer Plan).');
      detach(analyze(id));
      return out(get(id)!, true);
    });
    router.post('/api/werkstatt/builds/:id/cancel', 'location', (ctx) => {
      const b = mine(ctx, get(ctx.params.id));
      if (!['planning', 'planned', 'awaiting_approval'].includes(b.status)) throw bad('Dieser Auftrag läuft schon oder ist beendet.');
      set(b.id, { status: 'cancelled', finished_at: now() });
      log(b.id, 'Abgebrochen.');
      return out(get(b.id)!, true);
    });

    // --- approval (admins) -----------------------------------------------------------------------------------------------
    const pending = (id: string) => {
      const b = get(id);
      if (!b || b.status !== 'awaiting_approval') throw bad('Dieser Auftrag wartet nicht auf eine Freigabe.');
      return b;
    };
    router.post('/api/werkstatt/builds/:id/approve', 'admin', (ctx) => {
      const b = pending(ctx.params.id);
      const policy = loadPolicy(app);
      const plan = jsonOr<Row>(b.plan, {});
      const over = b.stage === 2 || b.kind === 'change' ? budgetProblem(app, policy, b.location_id, ((plan.estimate?.typical_usd ?? 0) as number) * 1e6) : null;
      if (over) throw new HttpError(409, over);
      // It runs under the requester's rights (they consented), or the admin's when they are gone.
      const runner = owner(b) ?? ctx.user!;
      set(b.id, { approval_by: ctx.user!.id, approval_at: now(), approval_note: str(ctx.body?.note, 'Notiz', { max: 300 }) });
      log(b.id, `Freigegeben von ${ctx.user!.name}.`);
      notify({ userIds: [b.user_id], kind: 'decision', title: `${NAMES.werkstatt}: Freigegeben – „${b.title || b.text.slice(0, 60)}“ wird gebaut`, body: `${ctx.user!.name} hat den Auftrag freigegeben.`, path: `/app/werkstatt/${b.id}`, buildId: b.id, locationId: b.location_id, email: true });
      start(b.id, runner);
      return out(get(b.id)!, true);
    });
    router.post('/api/werkstatt/builds/:id/reject', 'admin', (ctx) => {
      const b = pending(ctx.params.id);
      const note = str(ctx.body?.note, 'Begründung', { max: 300 });
      set(b.id, { status: 'rejected', approval_by: ctx.user!.id, approval_at: now(), approval_note: note, finished_at: now(), error: note ? `Abgelehnt: ${note}` : 'Abgelehnt.' });
      log(b.id, `Abgelehnt von ${ctx.user!.name}${note ? `: ${note}` : ''}.`);
      notify({ userIds: [b.user_id], kind: 'decision', title: `${NAMES.werkstatt}: Abgelehnt – „${b.title || b.text.slice(0, 60)}“`, body: note || `${ctx.user!.name} hat den Auftrag abgelehnt.`, path: `/app/werkstatt/${b.id}`, buildId: b.id, locationId: b.location_id, email: true });
      return out(get(b.id)!, true);
    });

    // --- undo (stage 1) ---------------------------------------------------------------------------------------------------
    router.post('/api/werkstatt/builds/:id/undo', 'location', async (ctx) => {
      const b = mine(ctx, get(ctx.params.id));
      const u = user(ctx);
      if (!u) throw new HttpError(403, 'Nur mit Anmeldung');
      if (b.stage !== 1) throw bad('Rückgängig machen gibt es für Einrichtungen – ein Plugin entfernst du beim Plugin.');
      if (!['done', 'failed'].includes(b.status)) throw bad('Dieser Auftrag läuft noch.');
      const r = await undoCreated(app, { user: u, locationId: b.location_id, baseCtx: ctx, created: jsonOr<Created[]>(b.created, []), label: NAMES.werkstatt });
      set(b.id, { created: r.created, ...(r.created.every((c) => c.undone) ? { status: 'undone' } : {}) });
      log(b.id, `Rückgängig gemacht: ${r.removed} entfernt${r.failed ? `, ${r.failed} konnten nicht entfernt werden` : ''}.`);
      return { ...out(get(b.id)!, true), removed: r.removed, failed: r.failed };
    });

    // --- change (Ändern lassen) ------------------------------------------------------------------------------------------
    router.post('/api/werkstatt/plugins/:id/change', 'location', (ctx) => {
      const policy = gate(ctx);
      const u = user(ctx);
      if (!u) throw new HttpError(403, 'Nur mit Anmeldung');
      const p = getPlugin(app, ctx.params.id);
      if (!p || !canManage(u, p)) throw notFound('Plugin nicht gefunden');
      if (p.status !== 'active') throw bad('Das Plugin ist abgeschaltet.');
      if (!getVersion(app, p.active_version_id)) throw bad('Das Plugin hat noch keine aktive Version.');
      const feedback = str(ctx.body?.feedback, 'Änderungswunsch', { required: true, max: 3000 });
      if (feedback.length < 5) throw bad('Bitte beschreibe die Änderung genauer.');
      const refused = gateProblem(app, ctx.locationId, 'werkstatt_build', u);
      if (refused) throw new HttpError(409, refused);
      const est = estimate(ctx.locationId, 'change');
      const over = budgetProblem(app, policy, ctx.locationId, est.typical_micros);
      if (over) throw new HttpError(409, over);
      const id = create(ctx, { kind: 'change', text: feedback, title: `Änderung: ${p.name}`, pluginId: p.id });
      set(id, { plan: { stage: 2, title: `Änderung: ${p.name}`, summary: feedback, rationale: '', notes: [], steps: [], areas: [], scopes: [], manifest: null, change: { plugin: p.name, from: p.active_version_id }, estimate: { model: est.model, typical_usd: est.typical_micros / 1e6, max_usd: est.max_micros / 1e6 }, missing_areas: [] }, est_cost_micros: est.typical_micros });
      log(id, 'Änderungswunsch angelegt.');
      return confirm(ctx, get(id)!, {});
    });
    /** What a change would cost (shown before the button is pressed). */
    router.get('/api/werkstatt/estimate', 'location', (ctx) => {
      const e = estimate(ctx.locationId, ctx.query.get('kind') === 'plan' ? 'plan' : ctx.query.get('kind') === 'build' ? 'build' : 'change');
      return { model: e.model, typical_usd: e.typical_micros / 1e6, max_usd: e.max_micros / 1e6 };
    });

    // --- status for the UI -----------------------------------------------------------------------------------------------
    router.get('/api/werkstatt/me', 'location', async (ctx) => {
      const u = user(ctx);
      const policy = loadPolicy(app);
      const can = mayBuild(policy, u, ctx.locationId);
      const sandbox = await probeSandbox();
      return {
        names: NAMES,
        can_build: can.ok,
        reason: can.ok ? '' : can.reason,
        ai_problem: aiProblem(ctx.locationId),
        ai_hint: aiProblem(ctx.locationId) ? AI_HINT : '',
        ai: describeAi(app, ctx.locationId),
        model_gate: gateStatus(app, ctx.locationId, u),
        license: licenseInfo(app),
        budget_problem: budgetProblem(app, policy, ctx.locationId, 0),
        who: policy.who,
        approval: policy.approval,
        needs_approval: needsApproval(policy, u),
        budget: { limit_usd: budgetUsd(policy, ctx.locationId), used_usd: Math.round(spentMicros(app, ctx.locationId)) / 1e6 },
        server_logic: policy.server_logic === 'script' && !sandbox.ok ? 'declarative' : policy.server_logic,
        admin: isAdmin(u),
        pending_approvals: isAdmin(u) ? db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM werkstatt_builds WHERE status = 'awaiting_approval'`)!.n : 0,
      };
    });

    // --- notes in the app (strip on the page, badge in the menu) --------------------------------------------------------
    router.get('/api/werkstatt/notices', 'user', (ctx) => ({
      unread: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM werkstatt_notices WHERE user_id = ? AND read_at IS NULL', ctx.user!.id)!.n,
      notices: db.all('SELECT id, build_id, kind, title, body, url, read_at, created_at FROM werkstatt_notices WHERE user_id = ? ORDER BY created_at DESC LIMIT 20', ctx.user!.id),
    }));
    router.post('/api/werkstatt/notices/read', 'user', (ctx) => {
      const ids = Array.isArray(ctx.body?.ids) ? ctx.body.ids.slice(0, 100).map(String) : [];
      if (ids.length) for (const nid of ids) db.run('UPDATE werkstatt_notices SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL', now(), nid, ctx.user!.id);
      else db.run('UPDATE werkstatt_notices SET read_at = ? WHERE user_id = ? AND read_at IS NULL', now(), ctx.user!.id);
      return { ok: true };
    });

    // --- dry run: everything a build would check, without asking the AI (no cost, no rows) ------------------------------
    // GET as well as POST: it only reads, so even a read-only agency key can run it (scripts/werkstatt-smoke.mjs).
    const dryRun = async (ctx: Ctx, wished: string) => {
      const u = user(ctx);
      const policy = loadPolicy(app);
      const can = mayBuild(policy, u, ctx.locationId);
      const ai = aiProblem(ctx.locationId);
      const budget = budgetProblem(app, policy, ctx.locationId, 0);
      const text = wished.trim().slice(0, 4000);
      const gatePlan = gateProblem(app, ctx.locationId, 'werkstatt_plan', u);
      const status = gateStatus(app, ctx.locationId, u);
      const problems = [...(can.ok ? [] : [can.reason]), ...(ai ? [ai] : []), ...(gatePlan ? [gatePlan] : []), ...(budget ? [budget] : []), ...(text && text.length < 8 ? ['Der Wunsch ist zu kurz (mindestens ein Satz).'] : [])];
      const [title, ...rest] = (text || 'Beispielwunsch').split('\n');
      const loc = app.location(ctx.locationId);
      const sys = PLAN_SYSTEM;
      const usr = planUser({ title, body: rest.join('\n').trim(), locationName: loc?.name ?? '', inventory: inventory(ctx.locationId) });
      const sandbox = await probeSandbox();
      const gh = app.services.githubIssues as { hasToken?: (l: string) => boolean; defaultRepo?: (l: string) => string } | undefined;
      const e = (k: 'plan' | 'build' | 'change') => {
        const x = estimate(ctx.locationId, k);
        return { typical_usd: x.typical_micros / 1e6, max_usd: x.max_micros / 1e6 };
      };
      return {
        ok: problems.length === 0,
        problems,
        user: u ? { name: u.name, role: u.role } : { name: 'API-Schlüssel', role: 'api' },
        location: { id: ctx.locationId, name: loc?.name ?? '' },
        policy: { who: policy.who, allowed: can.ok, approval: policy.approval, needs_approval: needsApproval(policy, u), repair_rounds: policy.repair_rounds, server_logic: policy.server_logic },
        budget: { limit_usd: budgetUsd(policy, ctx.locationId), used_usd: Math.round(spentMicros(app, ctx.locationId)) / 1e6, problem: budget },
        ai: { ...describeAi(app, ctx.locationId), ready: !ai, problem: ai },
        model_gate: status,
        // Not blocking planning (Stufe 1 may use the everyday model) but a Mini-App cannot be built with it.
        warnings: status.ok ? [] : [status.message],
        estimate: { plan: e('plan'), build: e('build'), change: e('change') },
        prompt: { system_chars: sys.length, user_chars: usr.length, approx_tokens: Math.round((sys.length + usr.length) / 3.5), schema_bytes: JSON.stringify(PLAN_SCHEMA).length },
        sandbox: { ok: sandbox.ok, network: sandbox.network ?? null, reason: sandbox.reason ?? null },
        github: { token: !!gh?.hasToken?.(ctx.locationId), default_repo: gh?.defaultRepo?.(ctx.locationId) ?? '', core_repo: policy.core.repo },
        note: 'Trockenlauf: Es wurde keine KI angefragt, nichts gespeichert und nichts verbraucht.',
      };
    };
    router.post('/api/werkstatt/dry-run', 'location', (ctx) => dryRun(ctx, String(ctx.body?.text ?? '')));
    router.get('/api/werkstatt/dry-run', 'location', (ctx) => dryRun(ctx, String(ctx.query.get('text') ?? '')));

    // --- policy and the agency view (admins) ----------------------------------------------------------------------------------
    router.get('/api/werkstatt/policy', 'admin', async () => ({
      policy: loadPolicy(app),
      defaults: DEFAULT_POLICY,
      gate_families: GATE_FAMILIES.map((f) => ({ id: f.id, label: f.label, patterns: f.patterns })),
      license: licenseInfo(app),
      locations: db.all<{ id: string; name: string }>('SELECT id, name FROM locations ORDER BY name').map((l) => ({ ...l, spent_usd: Math.round(spentMicros(app, l.id)) / 1e6 })),
      users: db.all<{ id: string; name: string; email: string; role: string; locations: string }>('SELECT id, name, email, role, locations FROM users ORDER BY name LIMIT 500').map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, locations: (JSON.parse(u.locations || '[]') as string[]).map((l) => app.location(l)?.name ?? '').filter(Boolean) })),
      sandbox: await probeSandbox(),
    }));
    router.put('/api/werkstatt/policy', 'admin', (ctx) => {
      const next = cleanPolicy(app, loadPolicy(app), ctx.body ?? {});
      savePolicy(app, next);
      return { policy: next };
    });
    router.get('/api/werkstatt/agency', 'admin', () => ({
      builds: db.all('SELECT * FROM werkstatt_builds ORDER BY CASE status WHEN \'awaiting_approval\' THEN 0 ELSE 1 END, created_at DESC LIMIT 200').map((b) => out(b)),
      spent: db.all<{ id: string; name: string }>('SELECT id, name FROM locations ORDER BY name').map((l) => ({ location_id: l.id, location: l.name, spent_usd: Math.round(spentMicros(app, l.id)) / 1e6, limit_usd: budgetUsd(loadPolicy(app), l.id) })),
    }));

    // the wish's page: who built what for it
    router.get('/api/werkstatt/wishes/:id', 'location', (ctx) => {
      const u = user(ctx);
      const rows = db.all(`SELECT * FROM werkstatt_builds WHERE wish_id = ? AND location_id = ? ${isAdmin(u) ? '' : 'AND user_id IS ?'} ORDER BY created_at DESC LIMIT 10`, ctx.params.id, ctx.locationId, ...(isAdmin(u) ? [] : [u?.id ?? null]));
      return rows.map((b) => out(b));
    });

    // Stale work after a restart: a build that was running cannot continue, say so instead of hanging.
    for (const b of db.all(`SELECT id FROM werkstatt_builds WHERE status IN ('planning', 'building')`)) {
      set(b.id, { status: 'failed', error: 'Der Server wurde während des Baus neu gestartet – bitte den Auftrag noch einmal starten.', finished_at: now() });
    }
  },
};
