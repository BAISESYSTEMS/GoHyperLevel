import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, type Ctx, type RawResult, type User } from '../core/http.js';
import { render } from '../core/template.js';
import { addDaysYmd, weekdayKey, ymdInTz, zonedToUtc } from '../core/time.js';
import { now } from '../core/util.js';
import { registerActionMeta } from '../services/wfx-kit.js';
import { Bridge, removeCreated } from '../services/werkstatt/bridge.js';
import { versionBadges } from '../services/werkstatt/badges.js';
import { exportBundle, parseBundle } from '../services/werkstatt/bundle.js';
import { proProblem, requirePro } from '../services/werkstatt/license.js';
import { maybeSign, trustedKeys } from '../services/werkstatt/trust.js';
import { EXAMPLES, EXAMPLE_KEYS } from '../services/werkstatt/examples.js';
import { FRAME_HEADERS, buildFrameDoc, buildHostPage } from '../services/werkstatt/frame.js';
import { healthOf, killPlugin, pruneEvents, recordEvent, reportPluginError, revivePlugin } from '../services/werkstatt/health.js';
import { activateVersion, deletePlugin, pluginOrThrow, rollbackPlugin, storeVersion, upsertInstall } from '../services/werkstatt/lifecycle.js';
import { runLogic } from '../services/werkstatt/logic.js';
import { SCOPES, riskOf, type Manifest } from '../services/werkstatt/manifest.js';
import { NAMES } from '../services/werkstatt/names.js';
import { PLUGIN_ROUTES, opsFor, sampleFor } from '../services/werkstatt/ops.js';
import { WERKSTATT_ROUTES } from '../services/werkstatt/plan.js';
import { loadPolicy, mayBuild } from '../services/werkstatt/policy.js';
import { probeSandbox } from '../services/werkstatt/sandbox.js';
import { activeFor, canManage, createPlugin, getPlugin, getPluginBySlug, getVersion, installsOf, manifestOrThrow, resolveFor, versionsOf, type ActivePlugin, type PluginRow, type VersionRow } from '../services/werkstatt/store.js';

/**
 * Plugin runtime: the registry (plugins, versions, installs), the isolated UI (host page + sandboxed frame),
 * the bridge endpoint, server logic (jobs, workflow action "Plugin-Aktion"), health and the kill switch,
 * export/import. Building plugins is modules/werkstatt.ts, the catalogue and publishing modules/marktplatz.ts.
 * Security model: docs/werkstatt.md.
 */

const CALLS_PER_MINUTE = 600;
const calls = new Map<string, { n: number; at: number }>();
const limited = (key: string, max: number) => {
  const t = Date.now();
  const h = calls.get(key);
  if (!h || t - h.at > 60_000) {
    calls.set(key, { n: 1, at: t });
    if (calls.size > 20_000) calls.clear();
    return false;
  }
  return ++h.n > max;
};

const html = (body: string, status: number, csp: string): RawResult => ({ __raw: true, status, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp, ...FRAME_HEADERS }, body });
const page = (message: string, status = 404) => html(`<!doctype html><meta charset="utf-8"><body style="font:14px system-ui,sans-serif;padding:14px;color:#6b7280">${message.replace(/</g, '&lt;')}</body>`, status, "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'");

const userRow = (r: any): User => ({ id: r.id, email: r.email, name: r.name, role: r.role, locations: JSON.parse(r.locations || '[]'), permissions: r.permissions ? JSON.parse(r.permissions) : null });
/** Admin or a team member with access to the sub-account's settings. */
const isTeam = (u: User | undefined) => !!u && (u.role === 'admin' || !u.permissions || u.permissions.includes('settings'));
const mayOpen = (u: User, locationId: string) => u.role === 'admin' || u.locations.includes(locationId);

/** When a job runs next: hourly (minute from `at`), daily at `at`, weekly on `weekday` at `at` – local time of the sub-account. */
export function nextRun(job: { every: string; at?: string; weekday?: number }, tz: string, from: Date): Date {
  if (job.every === 'hourly') {
    const minute = Number((job.at ?? '00:00').slice(3, 5)) || 0;
    const t = new Date(from);
    t.setUTCSeconds(0, 0);
    t.setUTCMinutes(minute);
    while (t <= from) t.setUTCHours(t.getUTCHours() + 1);
    return t;
  }
  const at = job.at ?? '07:00';
  let ymd = ymdInTz(from, tz);
  for (let i = 0; i < 9; i++, ymd = addDaysYmd(ymd, 1)) {
    const t = zonedToUtc(ymd, at, tz);
    if (t <= from) continue;
    if (job.every === 'weekly') {
      const want = job.weekday ?? 1;
      const day = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(weekdayKey(ymd));
      if (day !== want) continue;
    }
    return t;
  }
  return new Date(from.getTime() + 864e5);
}

export const pluginsModule: Module = {
  name: 'plugins',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE plugins (
        id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, icon TEXT NOT NULL DEFAULT 'puzzle',
        description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'sonstiges',
        owner_location_id TEXT REFERENCES locations(id) ON DELETE SET NULL, owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        origin TEXT NOT NULL DEFAULT 'werkstatt', scope TEXT NOT NULL DEFAULT 'private', status TEXT NOT NULL DEFAULT 'active',
        active_version_id TEXT, market_version_id TEXT, wish_id TEXT, killed_at TEXT, killed_reason TEXT NOT NULL DEFAULT '', run_as TEXT,
        core_status TEXT NOT NULL DEFAULT '', core_version TEXT NOT NULL DEFAULT '', published_at TEXT, published_by TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE plugin_versions (
        id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE, version TEXT NOT NULL,
        manifest TEXT NOT NULL, ui_html TEXT NOT NULL DEFAULT '', server_js TEXT NOT NULL DEFAULT '', steps TEXT,
        changelog TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'ai', build_id TEXT, status TEXT NOT NULL DEFAULT 'draft',
        checks TEXT NOT NULL DEFAULT '{}', hash TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX plugin_versions_v ON plugin_versions(plugin_id, version);
      CREATE TABLE plugin_installs (
        id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        version_id TEXT, enabled INTEGER NOT NULL DEFAULT 1, consent_scopes TEXT NOT NULL DEFAULT '[]', consent_at TEXT, consent_by TEXT,
        installed_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX plugin_installs_uq ON plugin_installs(plugin_id, location_id, COALESCE(user_id, ''));
      CREATE INDEX plugin_installs_loc ON plugin_installs(location_id, enabled);
      CREATE TABLE plugin_storage (
        plugin_id TEXT NOT NULL, location_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (plugin_id, location_id, key)
      );
      CREATE TABLE plugin_events (
        id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, location_id TEXT, kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
        ms INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE INDEX plugin_events_p ON plugin_events(plugin_id, created_at);
      CREATE TABLE plugin_created (
        id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, location_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX plugin_created_p ON plugin_created(plugin_id, location_id);
      CREATE TABLE plugin_runs (
        id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, location_id TEXT NOT NULL, kind TEXT NOT NULL, entry_id TEXT NOT NULL,
        status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', ms INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE INDEX plugin_runs_p ON plugin_runs(plugin_id, created_at);
      CREATE TABLE plugin_job_state (
        plugin_id TEXT NOT NULL, location_id TEXT NOT NULL, job_id TEXT NOT NULL, last_run_at TEXT, next_run_at TEXT NOT NULL,
        PRIMARY KEY (plugin_id, location_id, job_id)
      );
      `,
    ],
    // What vouches for a version: signature of an imported bundle, model and Denkstufe of the build.
    ['002-version-meta', `ALTER TABLE plugin_versions ADD COLUMN meta TEXT NOT NULL DEFAULT '{}';`],
  ],
  register(app) {
    const { db, router } = app;
    const user = (ctx: Ctx): User => {
      if (!ctx.user) throw new HttpError(403, 'Plugins brauchen eine Anmeldung (nicht einen API-Schlüssel).');
      return ctx.user;
    };
    /** Read-only routes also answer sub-account API keys (MCP): they see what everyone of the sub-account sees. */
    const actor = (ctx: Ctx): User => ctx.user ?? { id: '', email: '', name: 'API-Schlüssel', role: 'member', locations: [ctx.locationId], permissions: null };
    const loc = (id: string) => app.location(id);

    // --- guards: what "via plugin" may reach, and the Werkstatt's own routes -------------------------------------
    app.guards.push((ctx) => {
      const via = ctx.via as string;
      const sig = `${ctx.method} ${ctx.path}`;
      if (via === 'plugin' && !PLUGIN_ROUTES.some((r) => r.test(sig))) throw new HttpError(403, 'Diese Funktion ist für Plugins nicht freigegeben.');
      if (via === 'werkstatt' && !WERKSTATT_ROUTES.some((r) => r.test(sig))) throw new HttpError(403, `Diese Funktion ist für die ${NAMES.werkstatt} nicht freigegeben.`);
    });

    // --- output ----------------------------------------------------------------------------------------------------------
    const entriesOf = (m: Manifest) => ({ page: m.entries.page ?? null, panels: m.entries.panels ?? [], widgets: m.entries.widgets ?? [], actions: m.entries.actions ?? [], jobs: m.entries.jobs ?? [] });
    const scopesOut = (scopes: string[]) => scopes.map((s) => ({ key: s, label: SCOPES[s]?.label ?? s, hint: SCOPES[s]?.hint ?? '', risk: SCOPES[s]?.risk ?? 'medium', write: !!SCOPES[s]?.write }));
    const versionBrief = (v: VersionRow, p: PluginRow) => ({ badges: versionBadges(app, v), diff: v.meta?.diff ?? null, id: v.id, version: v.version, status: v.status, changelog: v.changelog, source: v.source, created_at: v.created_at, active: v.id === p.active_version_id, scopes: v.manifest.scopes, ok: !!v.checks?.ok, issues: (v.checks?.issues ?? []).filter((i: any) => i.level === 'error').map((i: any) => i.message).slice(0, 6), warnings: (v.checks?.issues ?? []).filter((i: any) => i.level === 'warn').length });
    const pluginBrief = (p: PluginRow, u: User, locationId: string) => {
      const a = resolveFor(app, p.id, u, locationId);
      const v = a?.version ?? getVersion(app, p.active_version_id);
      const m = v?.manifest;
      const mine = canManage(u, p);
      return {
        id: p.id,
        slug: p.slug,
        name: p.name,
        icon: p.icon,
        description: p.description,
        category: p.category,
        scope: p.scope,
        status: p.status,
        origin: p.origin,
        version: v?.version ?? '',
        scopes: scopesOut(m?.scopes ?? []),
        risk: riskOf(m?.scopes ?? []),
        entries: m ? entriesOf(m) : null,
        mine,
        can_manage: mine,
        active_here: !!a,
        via: a?.via ?? null,
        enabled_here: a ? (a.install ? a.install.enabled === 1 : true) : false,
        killed_reason: p.status === 'killed' ? p.killed_reason : '',
        wish_id: p.wish_id,
        core_status: p.core_status,
        core_version: p.core_version,
        owner: u.role === 'admin' ? { user: p.owner_user_id ? (db.get('SELECT name FROM users WHERE id = ?', p.owner_user_id)?.name ?? '') : '', location: p.owner_location_id ? (loc(p.owner_location_id)?.name ?? '') : '' } : undefined,
        health: mine ? healthOf(app, p.id) : undefined,
        created_at: p.created_at,
        updated_at: p.updated_at,
      };
    };
    /** Plugins this person may see in this sub-account: active here, their own, or (admins) all. */
    const visible = (u: User, locationId: string): PluginRow[] => {
      if (u.role === 'admin') return db.all<PluginRow>('SELECT * FROM plugins ORDER BY name');
      const ids = new Set<string>(activeFor(app, u, locationId).map((a) => a.plugin.id));
      for (const r of db.all<{ id: string }>('SELECT id FROM plugins WHERE owner_user_id = ?', u.id)) ids.add(r.id);
      // Plugins the sub-account switched off or that were killed stay listed for those who have them installed.
      for (const r of db.all<{ plugin_id: string }>('SELECT plugin_id FROM plugin_installs WHERE location_id = ? AND (user_id IS NULL OR user_id = ?)', locationId, u.id)) ids.add(r.plugin_id);
      return [...ids].map((id) => getPlugin(app, id)).filter((p): p is PluginRow => !!p).sort((a, b) => a.name.localeCompare(b.name));
    };
    const seeing = (u: User, locationId: string, id: string): PluginRow => {
      const p = getPlugin(app, id);
      if (!p || !(u.role === 'admin' || p.owner_user_id === u.id || visible(u, locationId).some((x) => x.id === p.id))) throw notFound('Plugin nicht gefunden');
      return p;
    };
    const managing = (u: User, locationId: string, id: string): PluginRow => {
      const p = seeing(u, locationId, id);
      if (!canManage(u, p)) throw new HttpError(403, 'Das Plugin kann nur seine Autorin bzw. sein Autor oder ein Admin ändern.');
      return p;
    };

    // --- services for the other modules ----------------------------------------------------------------------------------
    app.services.plugins = { get: (id: string) => getPlugin(app, id), versions: (id: string) => versionsOf(app, id), activeFor: (u: User, l: string) => activeFor(app, u, l), resolveFor: (id: string, u: User | undefined, l: string) => resolveFor(app, id, u, l), pluginBrief, visible, seeing, managing, scopesOut, entriesOf, versionBrief, health: (id: string) => healthOf(app, id), runLogic: (o: Parameters<typeof runLogic>[1]) => runLogic(app, o), userRow, isTeam, mayOpen };

    // --- listing and detail ------------------------------------------------------------------------------------------------
    router.get('/api/plugins', 'location', (ctx) => {
      const u = actor(ctx);
      return { plugins: visible(u, ctx.locationId).map((p) => pluginBrief(p, u, ctx.locationId)), names: NAMES };
    });
    /** For the app shell: menu pages, contact/deal panels and dashboard widgets of the plugins that are on here. */
    router.get('/api/plugins/active', 'location', (ctx) => {
      const u = user(ctx);
      return activeFor(app, u, ctx.locationId)
        .filter((a) => a.manifest.entries.page || a.manifest.entries.panels?.length || a.manifest.entries.widgets?.length)
        .map((a) => ({ id: a.plugin.id, slug: a.plugin.slug, name: a.plugin.name, icon: a.plugin.icon, version: a.version.version, ...entriesOf(a.manifest) }))
        .map(({ actions: _a, jobs: _j, ...rest }) => rest);
    });
    /** Workflow editor: the actions of the plugins that are on for the whole sub-account. */
    router.get('/api/plugins/actions', 'location', (ctx) =>
      activeFor(app, undefined, ctx.locationId)
        .filter((a) => a.manifest.entries.actions?.length)
        .flatMap((a) => (a.manifest.entries.actions ?? []).map((x) => ({ plugin: a.plugin.id, slug: a.plugin.slug, plugin_name: a.plugin.name, action: x.id, label: x.label, fields: x.fields ?? [] }))),
    );
    router.get('/api/plugins/sandbox', 'admin', async () => ({ ...(await probeSandbox()), policy: loadPolicy(app).server_logic }));
    router.get('/api/plugins/examples', 'location', (ctx) => {
      const u = user(ctx);
      return EXAMPLE_KEYS.map((k) => {
        const e = EXAMPLES[k];
        const mine = db.get<{ id: string }>('SELECT id FROM plugins WHERE slug LIKE ? AND owner_user_id = ?', `${k}%`, u.id);
        return { key: k, name: e.manifest.name, icon: e.manifest.icon, description: e.manifest.description, scopes: scopesOut(e.manifest.scopes), entries: entriesOf(e.manifest), wish: e.wish, installed: mine?.id ?? null };
      });
    });
    router.post('/api/plugins/examples/:key/install', 'location', async (ctx) => {
      const u = user(ctx);
      const e = EXAMPLES[ctx.params.key];
      if (!e) throw notFound('Beispiel nicht gefunden');
      const can = mayBuild(loadPolicy(app), u, ctx.locationId);
      if (!can.ok) throw new HttpError(403, can.reason);
      // The same consent as for every install: the confirm lists exactly what the example asks for.
      if (!Array.isArray(ctx.body?.consent) || [...ctx.body.consent.map(String)].sort().join(',') !== [...e.manifest.scopes].sort().join(',')) throw bad('Bitte bestätige die angefragten Berechtigungen.');
      const manifest = manifestOrThrow(e.manifest);
      const p = createPlugin(app, { manifest, ownerLocationId: ctx.locationId, ownerUserId: u.id, origin: 'example' });
      const { version, verification } = await storeVersion(app, p, { manifest, ui_html: e.ui_html, server_js: e.server_js, steps: e.steps ?? null, changelog: 'Beispiel-Plugin', source: 'example' }, u, ctx.locationId);
      if (version.status !== 'checked') {
        deletePlugin(app, p.id);
        throw bad(`Das Beispiel hat die Prüfung nicht bestanden: ${verification.issues.filter((i) => i.level === 'error').map((i) => i.message).join(' ')}`);
      }
      activateVersion(app, p, version, u, version.manifest.scopes);
      upsertInstall(app, { pluginId: p.id, locationId: ctx.locationId, userId: u.id, consent: version.manifest.scopes, by: u.id });
      return pluginBrief(getPlugin(app, p.id)!, u, ctx.locationId);
    });

    router.get('/api/plugins/:id', 'location', (ctx) => {
      const u = actor(ctx);
      const p = seeing(u, ctx.locationId, ctx.params.id);
      const brief = pluginBrief(p, u, ctx.locationId);
      const mine = canManage(u, p);
      const cur = getVersion(app, p.active_version_id);
      return {
        ...brief,
        manifest: cur?.manifest ?? null,
        versions: mine ? versionsOf(app, p.id).map((v) => versionBrief(v, p)) : cur ? [versionBrief(cur, p)] : [],
        installs: mine ? installsOf(app, p.id).map((i) => ({ id: i.id, location: loc(i.location_id)?.name ?? '', location_id: i.location_id, private: !!i.user_id, enabled: i.enabled === 1, version_id: i.version_id, created_at: i.created_at })) : undefined,
        runs: mine ? db.all('SELECT kind, entry_id, status, detail, ms, created_at FROM plugin_runs WHERE plugin_id = ? ORDER BY created_at DESC LIMIT 20', p.id) : undefined,
        created_count: mine ? db.get<{ n: number }>('SELECT COUNT(*) AS n FROM plugin_created WHERE plugin_id = ? AND location_id = ?', p.id, ctx.locationId)!.n : undefined,
        wish: p.wish_id ? (db.get('SELECT id, title FROM feedback_items WHERE id = ?', p.wish_id) ?? null) : null,
      };
    });

    // --- versions, scope, switches ---------------------------------------------------------------------------------------------
    router.post('/api/plugins/:id/versions/:vid/activate', 'location', (ctx) => {
      const u = user(ctx);
      const p = managing(u, ctx.locationId, ctx.params.id);
      const v = getVersion(app, ctx.params.vid);
      if (!v || v.plugin_id !== p.id) throw notFound('Version nicht gefunden');
      const r = activateVersion(app, p, v, u, Array.isArray(ctx.body?.consent) ? ctx.body.consent.map(String) : undefined);
      return { ...pluginBrief(getPlugin(app, p.id)!, u, ctx.locationId), new_scopes: r.newScopes };
    });
    /** Wider rollout: privat → Sub-Account (team) → Agentur-weit (admin). The Marktplatz has its own route (review first). */
    router.post('/api/plugins/:id/scope', 'location', (ctx) => {
      const u = user(ctx);
      const p = managing(u, ctx.locationId, ctx.params.id);
      const to = String(ctx.body?.scope ?? '');
      const cur = getVersion(app, p.active_version_id);
      if (!cur || cur.status !== 'checked') throw bad('Das Plugin hat noch keine geprüfte Version.');
      if (p.status !== 'active') throw bad('Das Plugin ist abgeschaltet.');
      const homeLoc = p.owner_location_id ?? ctx.locationId;
      if (to === 'location') {
        if (!isTeam(u)) throw new HttpError(403, 'Für den ganzen Sub-Account brauchst du das Recht „Einstellungen“.');
        if (p.scope === 'marketplace' || p.scope === 'agency') throw bad('Das Plugin ist schon weiter freigegeben.');
        // The author's private install becomes the sub-account's.
        db.run('DELETE FROM plugin_installs WHERE plugin_id = ? AND location_id = ? AND user_id IS NULL', p.id, homeLoc);
        const own = db.get<{ id: string }>('SELECT id FROM plugin_installs WHERE plugin_id = ? AND location_id = ? AND user_id IS NOT NULL', p.id, homeLoc);
        if (own) db.run('UPDATE plugin_installs SET user_id = NULL, updated_at = ? WHERE id = ?', now(), own.id);
        else upsertInstall(app, { pluginId: p.id, locationId: homeLoc, userId: null, consent: cur.manifest.scopes, by: u.id });
        db.run(`UPDATE plugins SET scope = 'location', updated_at = ? WHERE id = ?`, now(), p.id);
      } else if (to === 'agency') {
        if (u.role !== 'admin') throw new HttpError(403, 'Agentur-weit freigeben können nur Admins.');
        if (p.scope === 'marketplace') throw bad('Das Plugin ist schon im Marktplatz.');
        db.run(`UPDATE plugins SET scope = 'agency', run_as = ?, updated_at = ? WHERE id = ?`, u.id, now(), p.id);
      } else if (to === 'private') {
        if (p.scope === 'marketplace') throw bad(`Aus dem ${NAMES.marktplatz} nimmt ein Admin das Plugin zurück.`);
        if (p.scope === 'agency' && u.role !== 'admin') throw new HttpError(403, 'Nur Admins nehmen die Agentur-weite Freigabe zurück.');
        db.run(`UPDATE plugins SET scope = 'private', run_as = NULL, updated_at = ? WHERE id = ?`, now(), p.id);
        // Back to the author alone: the sub-account install becomes private again, other sub-accounts lose it.
        db.run('DELETE FROM plugin_installs WHERE plugin_id = ? AND location_id <> ?', p.id, homeLoc);
        db.run('UPDATE plugin_installs SET user_id = ?, updated_at = ? WHERE plugin_id = ? AND location_id = ? AND user_id IS NULL', p.owner_user_id ?? u.id, now(), p.id, homeLoc);
      } else throw bad('Bereich: private, location oder agency.');
      return pluginBrief(getPlugin(app, p.id)!, u, ctx.locationId);
    });
    /** Switch the plugin on/off for this sub-account (or just for me, if it is private). */
    router.post('/api/plugins/:id/toggle', 'location', (ctx) => {
      const u = user(ctx);
      const p = seeing(u, ctx.locationId, ctx.params.id);
      const enabled = !!ctx.body?.enabled;
      const own = db.get<{ id: string; user_id: string | null }>('SELECT id, user_id FROM plugin_installs WHERE plugin_id = ? AND location_id = ? AND user_id = ?', p.id, ctx.locationId, u.id);
      if (own) db.run('UPDATE plugin_installs SET enabled = ?, updated_at = ? WHERE id = ?', enabled ? 1 : 0, now(), own.id);
      else {
        if (!isTeam(u)) throw new HttpError(403, 'Das Plugin gehört dem ganzen Sub-Account – dafür brauchst du das Recht „Einstellungen“.');
        const cur = db.get<{ id: string }>('SELECT id FROM plugin_installs WHERE plugin_id = ? AND location_id = ? AND user_id IS NULL', p.id, ctx.locationId);
        if (cur) db.run('UPDATE plugin_installs SET enabled = ?, updated_at = ? WHERE id = ?', enabled ? 1 : 0, now(), cur.id);
        else if (p.scope === 'agency') upsertInstall(app, { pluginId: p.id, locationId: ctx.locationId, userId: null, enabled, consent: getVersion(app, p.active_version_id)?.manifest.scopes ?? [], by: u.id });
        else throw notFound('Das Plugin ist hier nicht installiert.');
      }
      return pluginBrief(p, u, ctx.locationId);
    });
    /** Uninstall from this sub-account. `cleanup`: also remove the data the plugin stored and the records it created. */
    router.post('/api/plugins/:id/uninstall', 'location', async (ctx) => {
      const u = user(ctx);
      const p = seeing(u, ctx.locationId, ctx.params.id);
      const cleanup = !!ctx.body?.cleanup;
      const mine = db.get('SELECT id FROM plugin_installs WHERE plugin_id = ? AND location_id = ? AND user_id = ?', p.id, ctx.locationId, u.id);
      if (!mine && !isTeam(u)) throw new HttpError(403, 'Das Plugin gehört dem ganzen Sub-Account – dafür brauchst du das Recht „Einstellungen“.');
      if (p.scope === 'agency' && !mine) throw bad('Agentur-weite Plugins lassen sich hier nur ausschalten (Schalter), nicht deinstallieren.');
      db.run('DELETE FROM plugin_installs WHERE plugin_id = ? AND location_id = ? AND (user_id = ? OR (? = 1 AND user_id IS NULL))', p.id, ctx.locationId, u.id, isTeam(u) ? 1 : 0);
      let removed = { removed: 0, failed: 0 };
      if (cleanup) {
        removed = await removeCreated(app, p.id, ctx.locationId, u, ctx);
        db.run('DELETE FROM plugin_storage WHERE plugin_id = ? AND location_id = ?', p.id, ctx.locationId);
        db.run('DELETE FROM plugin_job_state WHERE plugin_id = ? AND location_id = ?', p.id, ctx.locationId);
      }
      return { ok: true, ...removed };
    });
    router.delete('/api/plugins/:id', 'location', (ctx) => {
      const u = user(ctx);
      const p = managing(u, ctx.locationId, ctx.params.id);
      if (p.scope === 'marketplace' && u.role !== 'admin') throw new HttpError(403, `Aus dem ${NAMES.marktplatz} löscht nur ein Admin.`);
      deletePlugin(app, p.id);
      return { ok: true };
    });
    /** One-click rollback: back to the version before (or the one named); also switches a killed plugin on again. */
    router.post('/api/plugins/:id/rollback', 'location', (ctx) => {
      const u = user(ctx);
      const p = managing(u, ctx.locationId, ctx.params.id);
      const r = rollbackPlugin(app, p, u, ctx.body?.version_id ? String(ctx.body.version_id) : undefined);
      return { ...r, plugin: pluginBrief(getPlugin(app, p.id)!, u, ctx.locationId) };
    });
    router.post('/api/plugins/:id/kill', 'admin', (ctx) => {
      const p = pluginOrThrow(app, ctx.params.id);
      killPlugin(app, p.id, String(ctx.body?.reason ?? '').slice(0, 200) || 'Von einem Admin abgeschaltet.');
      return { ok: true };
    });
    router.post('/api/plugins/:id/revive', 'admin', (ctx) => {
      const p = pluginOrThrow(app, ctx.params.id);
      revivePlugin(app, p.id);
      return { ok: true };
    });
    router.get('/api/plugins/:id/health', 'location', (ctx) => {
      const u = user(ctx);
      const p = managing(u, ctx.locationId, ctx.params.id);
      const rows = db.all('SELECT kind, detail, ms, created_at FROM plugin_events WHERE plugin_id = ? ORDER BY created_at DESC LIMIT 30', p.id);
      return { health: healthOf(app, p.id), events: rows, kill: loadPolicy(app).kill };
    });

    // --- export / import ------------------------------------------------------------------------------------------------------------
    router.get('/api/plugins/:id/export', 'location', (ctx) => {
      const u = user(ctx);
      const p = seeing(u, ctx.locationId, ctx.params.id);
      const v = resolveFor(app, p.id, u, ctx.locationId)?.version ?? getVersion(app, p.active_version_id);
      if (!v) throw bad('Das Plugin hat noch keine Version.');
      // Signed when this installation has its own signing key (PGHL_PLUGIN_SIGNING_KEY), otherwise plain.
      const body = JSON.stringify(maybeSign(exportBundle(v)), null, 2);
      return { __raw: true, status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${p.slug}-${v.version}.gohigh-plugin.json"`, 'cache-control': 'no-store' }, body } satisfies RawResult;
    });
    router.post('/api/plugins/import', 'location', async (ctx) => {
      const u = user(ctx);
      const can = mayBuild(loadPolicy(app), u, ctx.locationId);
      if (!can.ok) throw new HttpError(403, can.reason);
      const b = parseBundle(ctx.body?.bundle ?? ctx.body, trustedKeys(app));
      // A changed or forged bundle is refused; a signed one from the catalogue is a Pro feature; an unsigned one is „ungeprüft“ and needs the importer's explicit OK.
      if (b.signature.state === 'invalid') throw bad(b.signature.warning);
      if (b.signature.state === 'signed') requirePro(app, 'signed');
      else if (ctx.body?.accept_unverified !== true) throw bad(`${b.signature.warning} Bitte bestätige, dass du das Paket trotzdem installieren willst (accept_unverified).`);
      // The importer consents to what the plugin asks for, like for any install (the preview shows the list).
      const want = [...b.manifest.scopes].sort().join(',');
      if (!Array.isArray(ctx.body?.consent) || [...ctx.body.consent.map(String)].sort().join(',') !== want) throw bad('Bitte die angefragten Berechtigungen bestätigen.');
      const p = createPlugin(app, { manifest: b.manifest, ownerLocationId: ctx.locationId, ownerUserId: u.id, origin: 'import' });
      const { version, verification } = await storeVersion(app, p, { manifest: b.manifest, ui_html: b.ui_html, server_js: b.server_js, steps: b.steps, changelog: b.changelog || 'Importiert', source: 'import', meta: { signature: { state: b.signature.state, key_id: b.signature.key_id, label: b.signature.label, gohigh: b.signature.gohigh } } }, u, ctx.locationId);
      if (version.status !== 'checked') {
        deletePlugin(app, p.id);
        throw bad(`Die Prüfung ist fehlgeschlagen: ${verification.issues.filter((i) => i.level === 'error').map((i) => i.message).join(' ')}`);
      }
      activateVersion(app, p, version, u, version.manifest.scopes);
      upsertInstall(app, { pluginId: p.id, locationId: ctx.locationId, userId: u.id, consent: version.manifest.scopes, by: u.id });
      return { ...pluginBrief(getPlugin(app, p.id)!, u, ctx.locationId), intact: b.intact, signature: b.signature };
    });
    /** Dry-run of an import: shows what the bundle asks for (the consent screen), creates nothing. */
    router.post('/api/plugins/import/preview', 'location', (ctx) => {
      user(ctx);
      const b = parseBundle(ctx.body?.bundle ?? ctx.body, trustedKeys(app));
      return { signature: b.signature, pro_required: b.signature.state === 'signed' && !!proProblem(app, 'signed'), name: b.manifest.name, version: b.manifest.version, description: b.manifest.description, icon: b.manifest.icon, scopes: scopesOut(b.manifest.scopes), risk: riskOf(b.manifest.scopes), entries: entriesOf(b.manifest), intact: b.intact, consent_required: b.manifest.scopes };
    });

    // --- the bridge (UI side): host page → here ---------------------------------------------------------------------------
    router.post('/api/plugins/:id/call', 'location', async (ctx) => {
      const u = user(ctx);
      const a = resolveFor(app, ctx.params.id, u, ctx.locationId);
      if (!a) throw notFound('Das Plugin ist hier nicht aktiv.');
      if (limited(`${a.plugin.id}:${u.id}`, CALLS_PER_MINUTE)) throw new HttpError(429, 'Das Plugin ruft zu oft auf – bitte kurz warten.');
      const bridge = new Bridge({ app, plugin: a.plugin, manifest: a.manifest, locationId: ctx.locationId, user: u, baseCtx: ctx, source: 'ui' });
      const data = await bridge.call(ctx.body?.op, ctx.body?.args);
      return { data };
    });
    router.post('/api/plugins/:id/report', 'location', (ctx) => {
      const u = user(ctx);
      const a = resolveFor(app, ctx.params.id, u, ctx.locationId);
      if (!a || limited(`report:${a.plugin.id}:${u.id}`, 30)) return { ok: true };
      const message = String(ctx.body?.message ?? '').slice(0, 300) || 'Fehler';
      recordEvent(app, a.plugin.id, ctx.locationId, 'error', `${String(ctx.body?.entry ?? '').slice(0, 40)}: ${message}`);
      reportPluginError(app, a.plugin, ctx.locationId, message, String(ctx.body?.stack ?? ''));
      return { ok: true };
    });

    // --- the isolated UI: host page + sandboxed frame -----------------------------------------------------------------------
    const themeOf = (ctx: Ctx) => ({ dark: ctx.query.get('theme') === 'dark', brand: /^#[0-9a-f]{6}$/i.test(ctx.query.get('brand') ?? '') ? String(ctx.query.get('brand')) : '#2563eb' });
    const entryOf = (m: Manifest, raw: string | null): { kind: string; id: string; height: number } => {
      const [kind, id = 'main'] = String(raw ?? 'page').split(':');
      if (kind === 'panel') {
        const p = m.entries.panels?.find((x) => x.id === id);
        if (p) return { kind, id, height: p.height ?? 220 };
      } else if (kind === 'widget') {
        if (m.entries.widgets?.some((x) => x.id === id)) return { kind, id, height: 0 };
      } else if (m.entries.page) return { kind: 'page', id: 'main', height: 0 };
      throw notFound('Diesen Einstiegspunkt hat das Plugin nicht.');
    };
    const entityOf = (raw: string | null) => {
      const m = /^(contact|deal):([A-Za-z0-9_-]{1,64})$/.exec(String(raw ?? ''));
      return m ? { type: m[1], id: m[2] } : null;
    };
    const hostFor = (ctx: Ctx, a: { plugin: PluginRow; version: VersionRow; manifest: Manifest }, o: { demo: boolean; locationId: string; frameUrl: string }) => {
      const entry = entryOf(a.manifest, ctx.query.get('entry'));
      const ops = opsFor(a.manifest.scopes);
      const l = loc(o.locationId);
      const theme = themeOf(ctx);
      const built = buildHostPage({
        pluginId: a.plugin.id,
        name: a.plugin.name,
        version: a.version.version,
        frameUrl: o.frameUrl,
        callUrl: o.demo ? '' : `/api/plugins/${a.plugin.id}/call`,
        reportUrl: o.demo ? '' : `/api/plugins/${a.plugin.id}/report`,
        locationId: o.locationId,
        demo: o.demo,
        ops,
        samples: o.demo ? Object.fromEntries(ops.map((op) => [op, sampleFor(op, l?.timezone || 'Europe/Berlin')])) : {},
        context: { entry: { kind: entry.kind, id: entry.id }, entity: entityOf(ctx.query.get('entity')) ?? (o.demo && entry.kind === 'panel' ? { type: 'contact', id: 'demo-c1' } : null), today: ymdInTz(new Date(), l?.timezone || 'Europe/Berlin'), location: { name: o.demo ? 'Beispiel-Firma' : (l?.name ?? ''), timezone: l?.timezone || 'Europe/Berlin' }, plugin: { name: a.plugin.name, version: a.version.version }, demo: o.demo },
        theme,
        entry: { kind: entry.kind, id: entry.id },
        entity: entityOf(ctx.query.get('entity')),
        height: entry.height,
      });
      return html(built.html, 200, built.csp);
    };
    const frameQuery = (ctx: Ctx, locationId: string) => `locationId=${encodeURIComponent(locationId)}&theme=${ctx.query.get('theme') === 'dark' ? 'dark' : 'light'}`;
    /** A plugin in demo mode: anyone may look at what is in the Marktplatz or what they manage – with sample data only. */
    const demoTarget = (u: User, locationId: string, id: string) => {
      const p = getPlugin(app, id);
      if (!p || p.status !== 'active') return null;
      const v = getVersion(app, p.active_version_id);
      if (!v || v.status !== 'checked') return null;
      if (p.scope === 'marketplace' || canManage(u, p) || resolveFor(app, p.id, u, locationId)) return { plugin: p, version: v, manifest: v.manifest };
      return null;
    };
    router.get('/plugin-host/:id', 'location', (ctx) => {
      const u = user(ctx);
      const demo = ctx.query.get('demo') === '1';
      const a = demo ? demoTarget(u, ctx.locationId, ctx.params.id) : resolveFor(app, ctx.params.id, u, ctx.locationId);
      if (!a) return page('Dieses Plugin ist hier nicht aktiv.');
      if (!demo) recordEvent(app, a.plugin.id, ctx.locationId, 'open', ctx.query.get('entry') ?? 'page');
      try {
        return hostFor(ctx, a, { demo, locationId: ctx.locationId, frameUrl: `/plugin-frame/${a.version.id}?${frameQuery(ctx, ctx.locationId)}` });
      } catch (e) {
        return page((e as Error).message, e instanceof HttpError ? e.status : 500);
      }
    });
    const frameFor = (v: VersionRow, p: PluginRow, theme: 'light' | 'dark') => {
      const allowed = loadPolicy(app).allowed_hosts;
      const hosts = (v.manifest.externalHosts ?? []).filter((h) => allowed.includes(h));
      const doc = buildFrameDoc({ html: v.ui_html, title: p.name, theme, hosts });
      return html(doc.html, 200, doc.csp);
    };
    router.get('/plugin-frame/:vid', 'location', (ctx) => {
      const u = user(ctx);
      const v = getVersion(app, ctx.params.vid);
      const p = v && getPlugin(app, v.plugin_id);
      if (!v || !p || p.status !== 'active' || v.status !== 'checked') return page('Nicht verfügbar.');
      const resolved = resolveFor(app, p.id, u, ctx.locationId);
      const ok = resolved?.version.id === v.id || canManage(u, p) || (p.scope === 'marketplace' && p.active_version_id === v.id);
      if (!ok) return page('Nicht verfügbar.');
      return frameFor(v, p, ctx.query.get('theme') === 'dark' ? 'dark' : 'light');
    });

    // Preview for headless screenshots: a signed, short-lived link, sample data only, no session.
    const sign = (vid: string, exp: number) => createHmac('sha256', app.config.secret).update(`plugin-preview\n${vid}\n${exp}`).digest('base64url');
    const previewToken = (vid: string, ttlSec = 300) => {
      const exp = Math.floor(Date.now() / 1000) + ttlSec;
      return `${exp}.${sign(vid, exp)}`;
    };
    const tokenOk = (vid: string, t: string | null) => {
      const [exp, sig] = String(t ?? '').split('.');
      if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
      const want = Buffer.from(sign(vid, Number(exp)));
      const got = Buffer.from(sig);
      return want.length === got.length && timingSafeEqual(want, got);
    };
    app.services.pluginPreviewUrl = (versionId: string, o: { entry?: string; theme?: 'light' | 'dark'; entity?: string } = {}) => `${app.selfUrl}/plugin-preview/${versionId}?t=${previewToken(versionId)}&entry=${encodeURIComponent(o.entry ?? 'page')}&theme=${o.theme ?? 'light'}${o.entity ? `&entity=${o.entity}` : ''}`;
    router.get('/plugin-preview/:vid', 'public', (ctx) => {
      const v = getVersion(app, ctx.params.vid);
      const p = v && getPlugin(app, v.plugin_id);
      if (!v || !p || !tokenOk(v.id, ctx.query.get('t'))) return page('Nicht verfügbar.', 404);
      return hostFor(ctx, { plugin: p, version: v, manifest: v.manifest }, { demo: true, locationId: '', frameUrl: `/plugin-preview-frame/${v.id}?t=${encodeURIComponent(ctx.query.get('t')!)}&theme=${ctx.query.get('theme') === 'dark' ? 'dark' : 'light'}` });
    });
    router.get('/plugin-preview-frame/:vid', 'public', (ctx) => {
      const v = getVersion(app, ctx.params.vid);
      const p = v && getPlugin(app, v.plugin_id);
      if (!v || !p || !tokenOk(v.id, ctx.query.get('t'))) return page('Nicht verfügbar.', 404);
      return frameFor(v, p, ctx.query.get('theme') === 'dark' ? 'dark' : 'light');
    });

    // --- server logic: workflow action "Plugin-Aktion" ---------------------------------------------------------------------------
    /** Who a plugin's background work runs as: the person who installed it (for agency-wide: the admin who released it). */
    const runAs = (a: ActivePlugin, locationId: string): User | null => {
      const id = a.via === 'agency' ? (a.plugin.run_as ?? a.plugin.owner_user_id) : (a.install?.installed_by ?? a.plugin.owner_user_id);
      const row = id ? db.get('SELECT * FROM users WHERE id = ?', id) : null;
      const u = row ? userRow(row) : null;
      return u && mayOpen(u, locationId) ? u : null;
    };
    app.services.workflowActions = {
      ...(app.services.workflowActions ?? {}),
      /** step: { plugin: slug or id, action: id, input: { field: "text with {{merge fields}}" } } */
      plugin_action: async (run: any, step: any, vars: Record<string, any>) => {
        const ref = String(step.plugin ?? '');
        const p = getPlugin(app, ref) ?? getPluginBySlug(app, ref);
        if (!p) throw new Error('Plugin nicht gefunden');
        // Only plugins that are on for the whole sub-account run inside automations – never a private one.
        const a = resolveFor(app, p.id, undefined, run.location_id);
        if (!a) throw new Error(`Das Plugin „${p.name}“ ist in diesem Sub-Account nicht für alle aktiv (oder abgeschaltet).`);
        const action = a.manifest.entries.actions?.find((x) => x.id === step.action);
        if (!action) throw new Error(`Das Plugin hat keine Aktion „${String(step.action)}“.`);
        const u = runAs(a, run.location_id);
        if (!u) throw new Error('Der Nutzer, der das Plugin eingerichtet hat, ist nicht mehr verfügbar.');
        const input: Record<string, unknown> = {};
        for (const [k, v] of Object.entries((step.input && typeof step.input === 'object' ? step.input : {}) as Record<string, unknown>)) input[k] = typeof v === 'string' ? render(v, vars) : v;
        const c = vars.contact;
        if (c) input.contact = { id: c.id ?? run.contact_id, name: c.name ?? [c.first_name, c.last_name].filter(Boolean).join(' '), email: c.email ?? '' };
        const r = await runLogic(app, { target: { plugin: a.plugin, manifest: a.manifest, code: a.version.server_js, steps: a.version.steps }, kind: 'action', id: action.id, input, user: u, locationId: run.location_id });
        if (!r.ok) throw new Error(`Plugin „${p.name}“: ${r.error}`);
        return `Plugin „${p.name}“: Aktion „${action.label}“ ausgeführt${r.result ? ` – ${JSON.stringify(r.result).slice(0, 120)}` : ''}`;
      },
    };
    // The step has its own editor in the web app (werkstatt/WorkflowStep.tsx); the catalog only needs its description for the picker.
    registerActionMeta(app, [
      {
        type: 'plugin_action',
        label: 'Plugin-Aktion ausführen',
        category: 'apps',
        icon: 'puzzle',
        summary: 'Führt eine Aktion eines Plugins aus der Werkstatt oder dem Marktplatz aus.',
        doc: 'Nur Plugins, die im ganzen Sub-Account aktiv sind (nie ein privates). Die Aktion läuft mit den Rechten der Person, die das Plugin eingerichtet hat; Eingaben dürfen Platzhalter wie {{contact.first_name}} enthalten.',
        fields: [],
        custom: true,
        keywords: 'plugin werkstatt marktplatz mini-app',
      },
    ]);

    // --- scheduled jobs --------------------------------------------------------------------------------------------------------------
    const jobTargets = (): { a: ActivePlugin; locationId: string }[] => {
      const out = new Map<string, { a: ActivePlugin; locationId: string }>();
      const consider = (plugin: PluginRow, locationId: string) => {
        const key = `${plugin.id}:${locationId}`;
        if (out.has(key) || !loc(locationId)) return;
        // Sub-account-wide or agency-wide first, then a private install of one person.
        const people = db.all<{ user_id: string }>('SELECT user_id FROM plugin_installs WHERE plugin_id = ? AND location_id = ? AND enabled = 1 AND user_id IS NOT NULL', plugin.id, locationId);
        for (const who of [undefined, ...people.map((r) => ({ id: r.user_id }) as User)]) {
          const a = resolveFor(app, plugin.id, who, locationId);
          if (a) {
            if (a.manifest.entries.jobs?.length) out.set(key, { a, locationId });
            return;
          }
        }
      };
      for (const p of db.all<PluginRow>(`SELECT * FROM plugins WHERE status = 'active'`)) {
        for (const i of db.all<{ location_id: string }>('SELECT DISTINCT location_id FROM plugin_installs WHERE plugin_id = ? AND enabled = 1', p.id)) consider(p, i.location_id);
        if (p.scope === 'agency') for (const l of db.all<{ id: string }>('SELECT id FROM locations')) consider(p, l.id);
      }
      return [...out.values()];
    };
    let lastPrune = 0;
    const jobsTick = async (at = new Date()) => {
      let ran = 0;
      for (const { a, locationId } of jobTargets()) {
        const tz = loc(locationId)?.timezone || 'Europe/Berlin';
        for (const job of a.manifest.entries.jobs ?? []) {
          const st = db.get<{ next_run_at: string }>('SELECT next_run_at FROM plugin_job_state WHERE plugin_id = ? AND location_id = ? AND job_id = ?', a.plugin.id, locationId, job.id);
          if (!st) {
            db.insert('plugin_job_state', { plugin_id: a.plugin.id, location_id: locationId, job_id: job.id, last_run_at: null, next_run_at: nextRun(job, tz, at).toISOString() });
            continue;
          }
          if (st.next_run_at > at.toISOString() || ran >= 10) continue;
          ran++;
          db.run('UPDATE plugin_job_state SET last_run_at = ?, next_run_at = ? WHERE plugin_id = ? AND location_id = ? AND job_id = ?', at.toISOString(), nextRun(job, tz, at).toISOString(), a.plugin.id, locationId, job.id);
          const u = runAs(a, locationId);
          if (!u) {
            recordEvent(app, a.plugin.id, locationId, 'error', `${job.id}: Der Nutzer, der das Plugin eingerichtet hat, ist nicht mehr verfügbar.`);
            continue;
          }
          await runLogic(app, { target: { plugin: a.plugin, manifest: a.manifest, code: a.version.server_js, steps: a.version.steps }, kind: 'job', id: job.id, user: u, locationId });
        }
      }
      if (Date.now() - lastPrune > 6 * 3600_000) {
        lastPrune = Date.now();
        pruneEvents(app);
      }
      return ran;
    };
    app.services.pluginJobsTick = jobsTick;
    // Detached with its own lock: a slow job must not hold up the other modules' ticks.
    let jobsRunning = false;
    app.onTick(() => {
      if (jobsRunning) return;
      jobsRunning = true;
      void jobsTick()
        .catch((e) => console.error('[plugins] jobs', (e as Error).message))
        .finally(() => (jobsRunning = false));
    });
  },
};
