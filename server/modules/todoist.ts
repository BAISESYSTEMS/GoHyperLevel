import type { App, Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { todoistClient, verifyTodoistHmac, TodoistError } from '../services/todoist.js';
import {
  clearLimit,
  getConfig,
  getState,
  homeId,
  homeName,
  log,
  needsPush,
  runSync,
  saveConfig,
  saveState,
  setMapping,
  targets,
  type Mode,
  type RunMode,
  type TodoistConfig,
} from '../services/todoist-sync.js';
import type { Tool } from './mcp.js';
import { openSecret, sealSecret } from './mail-sync.js';

/**
 * Agentur → Integrationen → Todoist: two-way task sync with one personal Todoist account –
 * by default one Todoist project with a section per sub-account (fits the free plan), or one
 * project per sub-account.
 * Settings and routes live here, the sync itself in services/todoist-sync.ts and every HTTP call
 * in services/todoist.ts. Polling (every 3 minutes, a full read once a day) works on its own;
 * changes made here are pushed a few seconds later (after-write hook + a scan on every tick).
 * Optional Todoist webhooks (/hooks/todoist) only trigger an early incremental read.
 */

const INCREMENTAL_MS = 3 * 60_000;
const FULL_MS = 23.5 * 3600_000;

const TOOLS: Tool[] = [
  {
    name: 'ghl_todoist_sync_status',
    title: 'Todoist-Abgleich: Status',
    description: 'Status des Todoist-Abgleichs der Aufgaben: aktiv?, Layout (ein Projekt mit Abschnitten oder ein Projekt je Sub-Account), Richtung, letzter Abgleich, Zähler, letzter Fehler, erreichte Todoist-Limits, Zuordnung je Sub-Account und die letzten Protokolleinträge (Konflikte, Fehler).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    agencyOnly: true,
    run: async (call) => {
      const v = await call.api('GET', '/api/agency/todoist');
      return { enabled: v.enabled, connected: v.token_set, account: v.account, layout: v.layout, project: v.layout === 'sections' ? v.home : undefined, direction: v.direction, scope: v.scope, state: v.state, totals: v.totals, sub_accounts: v.locations, log: v.log.slice(0, 15) };
    },
  },
  {
    name: 'ghl_todoist_sync',
    title: 'Todoist jetzt abgleichen',
    description: 'Startet sofort einen Abgleich der Aufgaben mit Todoist (full=true liest alles neu statt nur Änderungen). Gibt die Zähler des Laufs zurück.',
    inputSchema: { type: 'object', properties: { full: { type: 'boolean', description: 'Kompletter Abgleich statt nur Änderungen' } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    agencyOnly: true,
    run: async (call, a) => {
      const v = await call.api('POST', '/api/agency/todoist/sync', { body: { full: !!a.full } });
      return { counts: v.state.counts, last_error: v.state.last_error, totals: v.totals };
    },
  },
];

const timers = new WeakMap<App, NodeJS.Timeout>();
/** Debounced background run (after a change here or a webhook); errors land in the status/log. */
function schedule(app: App, mode: RunMode, delayMs?: number) {
  const delay = delayMs ?? app.services.todoistPushDelayMs ?? 2000;
  if (delay < 0) return;
  clearTimeout(timers.get(app));
  const t = setTimeout(() => {
    timers.delete(app);
    try {
      const cfg = getConfig(app);
      if (cfg.enabled && cfg.token_sealed) runSync(app, mode).catch(() => {});
    } catch {
      /* app closed meanwhile */
    }
  }, delay);
  t.unref?.();
  timers.set(app, t);
}

function view(app: App) {
  const cfg = getConfig(app);
  const st = getState(app);
  const n = (sql: string, ...p: string[]) => Number(app.db.get(sql, ...p)?.n ?? 0);
  const linked = new Map(app.db.all(`SELECT location_id, COUNT(*) AS n FROM todoist_links WHERE status = 'active' GROUP BY location_id`).map((r) => [r.location_id, Number(r.n)]));
  return {
    enabled: cfg.enabled,
    token_set: !!cfg.token_sealed,
    token_hint: cfg.token_hint ?? '',
    account: cfg.account ? { name: cfg.account.name, email: cfg.account.email, timezone: cfg.account.tz, premium: cfg.account.premium ?? null } : null,
    layout: cfg.layout,
    home: { id: homeId(cfg, st), name: homeName(cfg), picked: !!cfg.home_project_id },
    unsectioned_location_id: cfg.unsectioned_location_id ?? null,
    direction: cfg.direction,
    scope: cfg.scope,
    parent_name: cfg.parent_name,
    default_mode: cfg.default_mode,
    label: cfg.label,
    webhook_secret_set: !!cfg.webhook_secret_sealed,
    webhook_url: `${app.baseUrl()}/hooks/todoist`,
    state: { last_run: st.last_run ?? null, last_sync: st.last_sync ?? null, last_full: st.last_full ?? null, last_push: st.last_push ?? null, last_error: st.last_error ?? '', limit_error: st.limit_error ?? '', counts: st.counts ?? null },
    totals: {
      linked: n(`SELECT COUNT(*) AS n FROM todoist_links WHERE status = 'active'`),
      pending: n(`SELECT COUNT(*) AS n FROM todoist_links WHERE status = 'pending'`),
      failed: n(`SELECT COUNT(*) AS n FROM todoist_links WHERE fail_count >= 5`),
      conflicts: n(`SELECT COUNT(*) AS n FROM todoist_log WHERE level = 'conflict'`),
    },
    locations: targets(app, cfg, st).map((t) => ({ id: t.location_id, name: t.name, mode: t.mode, project_id: t.project_id, project_name: t.project_name, section_id: t.section_id, section_name: t.section_name, ready: t.ready, linked: linked.get(t.location_id) ?? 0 })),
    log: app.db.all('SELECT id, at, level, message, task_id, todoist_id FROM todoist_log ORDER BY id DESC LIMIT 30'),
  };
}

/** A token for another Todoist account: links, project ids and the sync token belong to the old one. */
function resetForNewAccount(app: App, cfg: TodoistConfig) {
  app.db.run('DELETE FROM todoist_links');
  app.db.run(`UPDATE todoist_projects SET project_id = NULL, mode = CASE WHEN mode = 'existing' THEN 'auto' ELSE mode END`);
  resetSections(app);
  Object.assign(cfg, { home_project_id: null, home_project_name: '' });
  saveState(app, {});
}

/** The sections belong to one project: when that project changes, look them up / create them again. */
function resetSections(app: App) {
  app.db.run(`UPDATE todoist_projects SET section_id = NULL, section_name = '', section_mode = CASE WHEN section_mode = 'existing' THEN NULL ELSE section_mode END`);
  saveState(app, { ...getState(app), sync_token: undefined });
}

export const todoistModule: Module = {
  name: 'todoist',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE todoist_projects (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
        mode TEXT NOT NULL DEFAULT 'auto', project_id TEXT, project_name TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
      );
      CREATE TABLE todoist_links (
        task_id TEXT PRIMARY KEY, todoist_id TEXT, location_id TEXT NOT NULL, project_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        local_hash TEXT, remote_hash TEXT, synced_done INTEGER NOT NULL DEFAULT 0,
        local_changed_at TEXT, remote_updated_at TEXT, synced_at TEXT,
        pending_uuid TEXT, pending_temp_id TEXT, fail_count INTEGER NOT NULL DEFAULT 0, last_error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX todoist_links_remote ON todoist_links(todoist_id);
      CREATE INDEX todoist_links_location ON todoist_links(location_id, status);
      CREATE TABLE todoist_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL,
        task_id TEXT, todoist_id TEXT
      );
      `,
    ],
    [
      '002-sections',
      `
      ALTER TABLE todoist_projects ADD COLUMN section_mode TEXT;
      ALTER TABLE todoist_projects ADD COLUMN section_id TEXT;
      ALTER TABLE todoist_projects ADD COLUMN section_name TEXT NOT NULL DEFAULT '';
      ALTER TABLE todoist_links ADD COLUMN section_id TEXT;
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    app.services.todoistSync = (mode: RunMode = 'sync') => runSync(app, mode);

    router.get('/api/agency/todoist', 'admin', () => view(app));

    router.patch('/api/agency/todoist', 'admin', async (ctx) => {
      const b = ctx.body ?? {};
      const cfg: TodoistConfig = { ...getConfig(app) };
      const before = { ...cfg };
      if (b.layout !== undefined) {
        if (!['sections', 'projects'].includes(b.layout)) throw bad('Layout: sections oder projects');
        cfg.layout = b.layout;
      }
      if (typeof b.token === 'string' && b.token.trim()) {
        const tokenValue = str(b.token, 'API-Token', { max: 200 });
        if (/\s/.test(tokenValue)) throw bad('API-Token: bitte ohne Leerzeichen einfügen');
        let user;
        try {
          user = await todoistClient(app, tokenValue).user();
        } catch (e) {
          throw bad(e instanceof TodoistError && (e.status === 401 || e.status === 403) ? 'Todoist lehnt den Token ab – bitte unter Todoist → Einstellungen → Integrationen → Entwickler neu kopieren' : `Token-Test fehlgeschlagen: ${(e as Error).message}`);
        }
        const premium = user.is_premium ?? (user.premium_status ? user.premium_status !== 'not_premium' : undefined);
        const account = { id: String(user.id), name: user.full_name ?? '', email: user.email ?? '', tz: user.tz_info?.timezone ?? '', premium };
        if (cfg.account && cfg.account.id !== account.id) resetForNewAccount(app, cfg);
        // First connection: start right away only with the sections layout (creates at most one
        // project). One project per sub-account waits until the user switches syncing on.
        if (!cfg.token_sealed && b.enabled === undefined) cfg.enabled = cfg.layout === 'sections';
        Object.assign(cfg, { token_sealed: sealSecret(app, tokenValue), token_hint: `…${tokenValue.slice(-4)}`, account, owner_user_id: ctx.user?.id ?? cfg.owner_user_id ?? null });
        log(app, 'info', `Verbunden mit Todoist${account.name ? ` (${account.name})` : ''}.`);
      }
      if (b.enabled !== undefined) {
        if (b.enabled && !cfg.token_sealed) throw bad('Bitte zuerst den API-Token eintragen');
        cfg.enabled = !!b.enabled;
      }
      if (b.direction !== undefined) {
        if (!['both', 'push'].includes(b.direction)) throw bad('Richtung: both oder push');
        cfg.direction = b.direction;
      }
      if (b.scope !== undefined) {
        if (!['mine', 'all'].includes(b.scope)) throw bad('Aufgaben: mine oder all');
        cfg.scope = b.scope;
        if (b.scope === 'mine') cfg.owner_user_id = ctx.user?.id ?? cfg.owner_user_id ?? null;
      }
      if (b.parent_name !== undefined) cfg.parent_name = str(b.parent_name, 'Projektname', { max: 120 });
      if (b.home_project_id !== undefined) {
        cfg.home_project_id = b.home_project_id ? str(b.home_project_id, 'Todoist-Projekt', { max: 64 }) : null;
        cfg.home_project_name = cfg.home_project_id ? str(b.home_project_name, 'Projektname', { max: 200 }) : '';
      }
      if (b.unsectioned_location_id !== undefined) {
        const loc = b.unsectioned_location_id ? String(b.unsectioned_location_id) : null;
        if (loc && !app.location(loc)) throw bad('Sub-Account für Aufgaben ohne Abschnitt nicht gefunden');
        cfg.unsectioned_location_id = loc;
      }
      if (b.default_mode !== undefined) {
        if (!['auto', 'off'].includes(b.default_mode)) throw bad('Standard: auto oder off');
        cfg.default_mode = b.default_mode;
      }
      if (b.label !== undefined) cfg.label = !!b.label;
      if (b.webhook_secret !== undefined) {
        const s = str(b.webhook_secret, 'Client Secret', { max: 200 });
        cfg.webhook_secret_sealed = s ? sealSecret(app, s) : undefined;
      }
      // Another project picked for the sections → look up / create the sections there. A new name
      // for the auto project renames it (sections layout) or applies to new projects (projects layout).
      if ((cfg.home_project_id ?? null) !== (before.home_project_id ?? null)) resetSections(app);
      else if (cfg.parent_name !== before.parent_name && cfg.layout === 'projects') saveState(app, { ...getState(app), parent_project_id: undefined, parent_project_name: undefined });
      if ((cfg.unsectioned_location_id ?? null) !== (before.unsectioned_location_id ?? null)) saveState(app, { ...getState(app), sync_token: undefined }); // pick up tasks already there
      saveConfig(app, cfg);
      clearLimit(app);
      if (cfg.enabled) schedule(app, 'sync', app.services.todoistPushDelayMs ?? 500);
      return view(app);
    });

    // Disconnect: forget the token, keep the links (the same account can be reconnected).
    router.delete('/api/agency/todoist', 'admin', () => {
      const cfg = getConfig(app);
      saveConfig(app, { ...cfg, token_sealed: undefined, token_hint: undefined, enabled: false });
      saveState(app, { ...getState(app), sync_token: undefined, last_error: '' });
      log(app, 'info', 'Todoist getrennt.');
      return view(app);
    });

    // Todoist projects for the "existing project" picker.
    router.get('/api/agency/todoist/projects', 'admin', async () => {
      const cfg = getConfig(app);
      if (!cfg.token_sealed) throw bad('Bitte zuerst den API-Token eintragen');
      try {
        const list = await todoistClient(app, openSecret(app, cfg.token_sealed)).projects();
        const names = new Map(list.map((p) => [p.id, p.name]));
        return list
          .filter((p) => !p.is_deleted && !p.is_archived)
          .map((p) => ({ id: p.id, name: p.parent_id && names.has(p.parent_id) ? `${names.get(p.parent_id)} / ${p.name}` : p.name, inbox: !!p.inbox_project }));
      } catch (e) {
        throw new HttpError(502, (e as Error).message);
      }
    });

    // Sections of the sections-layout project (or of ?project_id=) for the "existing section" picker.
    router.get('/api/agency/todoist/sections', 'admin', async (ctx) => {
      const cfg = getConfig(app);
      if (!cfg.token_sealed) throw bad('Bitte zuerst den API-Token eintragen');
      const projectId = ctx.query.get('project_id') || homeId(cfg, getState(app));
      if (!projectId) throw bad('Das Todoist-Projekt gibt es noch nicht – erst ein vorhandenes wählen oder einmal abgleichen');
      try {
        const list = await todoistClient(app, openSecret(app, cfg.token_sealed)).sections(projectId);
        return list.filter((x) => !x.is_deleted && !x.is_archived && x.project_id === projectId).map((x) => ({ id: x.id, name: x.name }));
      } catch (e) {
        throw new HttpError(502, (e as Error).message);
      }
    });

    router.put('/api/agency/todoist/mapping/:locationId', 'admin', (ctx) => {
      const loc = app.location(ctx.params.locationId);
      if (!loc) throw notFound('Sub-Account nicht gefunden');
      const mode = String(ctx.body?.mode ?? '') as Mode;
      if (!['auto', 'existing', 'off'].includes(mode)) throw bad('Zuordnung: auto, existing oder off');
      const cfg = getConfig(app);
      const cur = targets(app, cfg).find((t) => t.location_id === loc.id)!;
      clearLimit(app);
      if (cfg.layout === 'sections') {
        if (mode === 'existing') {
          const sectionId = str(ctx.body.section_id, 'Todoist-Abschnitt', { required: true, max: 64 });
          setMapping(app, loc.id, { section_mode: mode, section_id: sectionId, section_name: str(ctx.body.section_name, 'Abschnitt', { max: 200 }) });
          if (sectionId !== cur.section_id) saveState(app, { ...getState(app), sync_token: undefined }); // import what is already in it
        } else if (mode === 'auto') {
          setMapping(app, loc.id, cur.mode === 'auto' ? { section_mode: mode } : { section_mode: mode, section_id: null, section_name: '' });
        } else {
          setMapping(app, loc.id, { section_mode: mode });
        }
        if (cfg.enabled) schedule(app, 'sync');
        return view(app);
      }
      if (mode === 'existing') {
        const projectId = str(ctx.body.project_id, 'Todoist-Projekt', { required: true, max: 64 });
        setMapping(app, loc.id, { mode, project_id: projectId, project_name: str(ctx.body.project_name, 'Projektname', { max: 200 }) });
        // tasks already in that project are not "changed" – read everything once to import them
        if (projectId !== cur.project_id) saveState(app, { ...getState(app), sync_token: undefined });
      } else if (mode === 'auto') {
        // keep an auto-created project; anything else is looked up / created by name on the next run
        setMapping(app, loc.id, cur.mode === 'auto' ? { mode } : { mode, project_id: null, project_name: '' });
      } else {
        setMapping(app, loc.id, { mode });
      }
      if (cfg.enabled) schedule(app, 'sync');
      return view(app);
    });

    router.post('/api/agency/todoist/sync', 'admin', async (ctx) => {
      clearLimit(app); // a manual run tries again even after a plan limit
      try {
        await runSync(app, ctx.body?.full ? 'full' : 'sync');
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(502, (e as Error).message);
      }
      return view(app);
    });

    // Optional webhook (Todoist App Console): only a hint to read early – polling stays the source of truth.
    router.post('/hooks/todoist', 'public', (ctx) => {
      const cfg = getConfig(app);
      if (!cfg.webhook_secret_sealed) throw notFound();
      if (!verifyTodoistHmac(ctx.rawBody, openSecret(app, cfg.webhook_secret_sealed), ctx.req.headers['x-todoist-hmac-sha256'] as string | undefined)) throw new HttpError(401, 'Signatur ungültig');
      const event = String(ctx.body?.event_name ?? '');
      const forUs = !cfg.account?.id || String(ctx.body?.user_id ?? '') === cfg.account.id;
      if (forUs && cfg.enabled && cfg.token_sealed && /^(item|project):/.test(event) && cfg.direction === 'both') schedule(app, 'sync', app.services.todoistPushDelayMs ?? 1500);
      return { ok: true };
    });

    // Changes made here through the app, API or MCP: push a few seconds later.
    app.afterWrite.push((ctx: Ctx, route) => {
      if (!route.pattern.startsWith('/api/tasks')) return;
      const cfg = getConfig(app);
      if (!cfg.enabled || !cfg.token_sealed) return;
      if (ctx.params.id) db.run('UPDATE todoist_links SET local_changed_at = ? WHERE task_id = ?', new Date().toISOString(), ctx.params.id);
      schedule(app, 'push');
    });

    // Every 3 minutes an incremental read (once a day a full one); in between, a cheap local scan
    // pushes changes made without a request (workflows, AI assistant, imports).
    let lastIncremental = 0;
    app.onTick(async () => {
      const cfg = getConfig(app);
      if (!cfg.enabled || !cfg.token_sealed) return;
      const t = Date.now();
      const st = getState(app);
      if (t - lastIncremental >= INCREMENTAL_MS) {
        lastIncremental = t;
        const full = !st.last_full || t - Date.parse(st.last_full) > FULL_MS;
        await runSync(app, full ? 'full' : 'sync').catch(() => {});
        return;
      }
      if (st.last_error && st.last_run && t - Date.parse(st.last_run) < INCREMENTAL_MS) return; // back off after an error
      if (needsPush(app)) await runSync(app, 'push').catch(() => {});
    });
  },
};
