import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, type Ctx, type User } from '../core/http.js';
import { id as newId, now } from '../core/util.js';
import { loadFeedbackSettings } from '../services/feedback-store.js';
import { callCost } from '../services/werkstatt/aicost.js';
import { SPEC_SCHEMA, SPEC_SYSTEM, parseSpec, specUser } from '../services/werkstatt/generate.js';
import { healthOf } from '../services/werkstatt/health.js';
import { VERSION_RE, compareVersions } from '../services/werkstatt/manifest.js';
import { gateProblem } from '../services/werkstatt/models.js';
import { NAMES } from '../services/werkstatt/names.js';
import { budgetProblem, loadPolicy } from '../services/werkstatt/policy.js';
import { getPlugin, getVersion, type PluginRow } from '../services/werkstatt/store.js';
import { APP_VERSION } from '../version.js';

/**
 * Stage 3 „Kernfeature“: a popular plugin becomes part of the product. The admin action „Als Kernfeature
 * vorschlagen“ writes a specification (from the wish, the plugin's code and its usage), opens a GitHub issue for
 * a coding agent (`@codex` or `@claude`, repository configurable – reuses the GitHub token of the KI-Werkzeuge)
 * and tracks it: open → in progress → merged → shipped. When the core version ships, the plugin is marked „im Kern
 * enthalten“ and its installs migrate (switched off, data kept) or retire (removed). The coding agent is asked to
 * ship behind a feature flag (app.services.flags) so the admin can roll it out in stages.
 */

type Row = Record<string, any>;
const jsonOr = <T>(s: unknown, fallback: T): T => {
  try {
    return s === null || s === undefined ? fallback : (JSON.parse(String(s)) as T);
  } catch {
    return fallback;
  }
};

export const werkstattCoreModule: Module = {
  name: 'werkstatt-core',
  migrations: [
    [
      '001-init',
      `CREATE TABLE plugin_core (
        id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'spec',
        repo TEXT NOT NULL DEFAULT '', agent TEXT NOT NULL DEFAULT 'codex', github_location_id TEXT NOT NULL DEFAULT '',
        issue_number INTEGER, issue_url TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', spec TEXT NOT NULL DEFAULT '',
        flag TEXT NOT NULL DEFAULT '', prs TEXT NOT NULL DEFAULT '[]', target_version TEXT NOT NULL DEFAULT '', shipped_version TEXT NOT NULL DEFAULT '',
        core_action TEXT NOT NULL DEFAULT 'migrate', error TEXT NOT NULL DEFAULT '', last_checked_at TEXT, created_by TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX plugin_core_p ON plugin_core(plugin_id);`,
    ],
  ],
  register(app) {
    const { db, router } = app;
    /** Admin routes that act in a sub-account (AI budget, GitHub token) take x-location-id like every other route. */
    const adminOnly = (ctx: Ctx) => {
      if (ctx.user?.role !== 'admin') throw new HttpError(403, 'Nur für Admins');
    };
    const issues = () => app.services.githubIssues as { create: Function; status: Function; hasToken: (l: string) => boolean; defaultRepo: (l: string) => string } | undefined;
    const get = (id: string): Row => {
      const r = db.get('SELECT * FROM plugin_core WHERE id = ?', id);
      if (!r) throw notFound('Vorschlag nicht gefunden');
      return r;
    };
    const set = (id: string, patch: Row) => {
      const keys = Object.keys(patch);
      db.run(`UPDATE plugin_core SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => (patch[k] !== null && typeof patch[k] === 'object' ? JSON.stringify(patch[k]) : patch[k])), now(), id);
    };
    const out = (r: Row) => {
      const p = getPlugin(app, r.plugin_id);
      return { id: r.id, plugin_id: r.plugin_id, plugin: p?.name ?? '', status: r.status, repo: r.repo, agent: r.agent, title: r.title, spec: r.spec, issue_number: r.issue_number, issue_url: r.issue_url, flag: r.flag, prs: jsonOr(r.prs, []), target_version: r.target_version, shipped_version: r.shipped_version, core_action: r.core_action, error: r.error, last_checked_at: r.last_checked_at, created_at: r.created_at, updated_at: r.updated_at, health: p ? healthOf(app, p.id) : null };
    };

    /** Which sub-account's GitHub token and AI budget serve the proposal: the policy's, else the support sub-account, else the current one. */
    const githubLocation = (current: string): string => {
      const policy = loadPolicy(app);
      const candidates = [policy.core.location_id, loadFeedbackSettings(app).support_location_id, current].filter((x) => x && app.location(x));
      return candidates.find((l) => issues()?.hasToken(l)) ?? candidates[0] ?? current;
    };

    /** Whether an issue could be opened right now, and a readable hint when not (no token, no repository). */
    const githubStatus = (current: string, repoWanted = ''): { ready: boolean; hint: string; location: string } => {
      const gh = issues();
      const policy = loadPolicy(app);
      const locId = githubLocation(current);
      if (!gh) return { ready: false, location: locId, hint: 'GitHub ist in dieser Installation nicht verfügbar.' };
      if (!gh.hasToken(locId)) return { ready: false, location: locId, hint: `Es ist noch kein GitHub-Token hinterlegt${app.location(locId) ? ` (Sub-Account „${app.location(locId)!.name}“)` : ''}: Einstellungen → KI-Werkzeuge → „GitHub für Codex“ → Token eintragen. Die Spezifikation wird trotzdem erstellt; das Issue legst du danach unter Werkstatt → Kernfeatures an.` };
      const repo = repoWanted || policy.core.repo || gh.defaultRepo?.(locId) || '';
      if (!repo) return { ready: false, location: locId, hint: 'Es ist noch kein Repository festgelegt: Werkstatt → Richtlinien → Kernfeatures → „GitHub-Repository“ (besitzer/name) eintragen. Die Spezifikation wird trotzdem erstellt.' };
      return { ready: true, location: locId, hint: '' };
    };

    const issueBody = (p: PluginRow, spec: string, flag: string): { body: string; prompt: string } => {
      const v = getVersion(app, p.market_version_id ?? p.active_version_id);
      const wish = p.wish_id ? db.get<{ title: string }>('SELECT title FROM feedback_items WHERE id = ?', p.wish_id) : undefined;
      const h = healthOf(app, p.id);
      const body = [
        spec,
        '---',
        `**Ausgangspunkt:** Plugin „${p.name}“ (Version ${v?.version ?? '?'}) aus der ${NAMES.werkstatt}${wish ? `, Wunsch „${wish.title}“ (${app.baseUrl()}/app/wishes/${p.wish_id})` : ''}.`,
        `**Nutzung:** ${h.installs} Installation${h.installs === 1 ? '' : 'en'}, ${h.usage_30d} Nutzungen in 30 Tagen, ${h.errors_7d} Fehler in 7 Tagen, ${h.votes} Stimmen${h.rating !== null ? `, Bewertung ${h.rating}/5` : ''}.`,
        `**Kein automatisches Ausrollen:** Dieser Vorschlag wird nie von selbst ausgeliefert – der Pull Request braucht grüne CI (Typprüfung, Tests, Build) und ein Review durch einen Menschen, und das Feature startet ausgeschaltet.`,
        `**Feature-Flag:** Bitte hinter dem Flag \`${flag}\` einführen (\`app.services.flags.enabled('${flag}', { locationId, userId })\`), damit es stufenweise freigegeben werden kann (privat → Sub-Account → Prozent → alle).`,
        v ? `<details><summary>Manifest des Plugins</summary>\n\n\`\`\`json\n${JSON.stringify(v.manifest, null, 2)}\n\`\`\`\n</details>` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      return { body, prompt: `Setze die oben beschriebene Spezifikation als festen Bestandteil des Produkts um – als eigenes Modul (siehe docs/code-layout.md bzw. docs/architecture.md), mit deutscher Oberfläche, Tests, Dokumentation und hinter dem Feature-Flag ${flag}. Öffne dazu einen Pull Request.` };
    };

    const createIssue = async (r: Row, current: string): Promise<{ ok: boolean; error?: string }> => {
      const gh = issues();
      const p = getPlugin(app, r.plugin_id);
      const ready = githubStatus(current, r.repo);
      if (!gh || !p || !ready.ready) {
        set(r.id, { error: '' });
        return { ok: false, error: ready.hint || 'GitHub ist nicht eingerichtet.' };
      }
      const locId = r.github_location_id || githubLocation(current);
      const { body, prompt } = issueBody(p, r.spec, r.flag);
      try {
        const i = await gh.create(locId, { repo: r.repo || loadPolicy(app).core.repo || undefined, title: `[Kernfeature] ${r.title}`.slice(0, 240), body, prompt, labels: ['kernfeature', 'plugin'], agent: r.agent });
        set(r.id, { status: 'issue_open', issue_number: Number(i.number) || null, issue_url: i.url, repo: i.repo, github_location_id: locId, error: '' });
        db.run(`UPDATE plugins SET core_status = 'proposed', updated_at = ? WHERE id = ?`, now(), p.id);
        return { ok: true };
      } catch (e) {
        set(r.id, { error: (e as Error).message });
        return { ok: false, error: (e as Error).message };
      }
    };

    // 'location' + adminOnly (not 'admin'): the GitHub token lives in a sub-account, so the admin's current one counts.
    router.get('/api/werkstatt/core', 'location', (ctx) => {
      adminOnly(ctx);
      return { proposals: db.all('SELECT * FROM plugin_core ORDER BY created_at DESC LIMIT 100').map(out), core: loadPolicy(app).core, github: !!issues(), github_status: githubStatus(ctx.locationId) };
    });
    /** For the proposal dialog: can an issue be opened with the repository typed in? */
    router.get('/api/werkstatt/core/github', 'location', (ctx) => {
      adminOnly(ctx);
      return githubStatus(ctx.locationId, String(ctx.query.get('repo') ?? '').trim());
    });

    router.post('/api/werkstatt/plugins/:id/core-proposal', 'location', async (ctx) => {
      adminOnly(ctx);
      const p = getPlugin(app, ctx.params.id);
      if (!p) throw notFound('Plugin nicht gefunden');
      if (p.status === 'in_core') throw bad('Das Plugin ist schon im Kern enthalten.');
      const v = getVersion(app, p.market_version_id ?? p.active_version_id);
      if (!v) throw bad('Das Plugin hat keine Version.');
      if (db.get(`SELECT 1 FROM plugin_core WHERE plugin_id = ? AND status IN ('spec', 'issue_open', 'in_progress', 'merged')`, p.id)) throw bad('Für dieses Plugin läuft schon ein Vorschlag.');
      const policy = loadPolicy(app);
      const agent = ctx.body?.agent === 'claude' || ctx.body?.agent === 'codex' ? ctx.body.agent : policy.core.agent;
      const repo = String(ctx.body?.repo ?? policy.core.repo ?? '').trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/, '');
      const targetVersion = String(ctx.body?.target_version ?? '').trim();
      if (targetVersion && !VERSION_RE.test(targetVersion)) throw bad('Zielversion bitte als 0.0.25 angeben.');
      const coreAction = ctx.body?.core_action === 'retire' ? 'retire' : 'migrate';
      const run = app.services.aiRun as ((i: Record<string, unknown>) => Promise<{ text: string; usage?: any; costMicros?: number }>) | undefined;
      const problem = (app.services.aiReady?.(ctx.locationId) as string | null | undefined) ?? (run ? null : 'Die KI ist nicht eingerichtet.');
      if (problem) throw new HttpError(409, `Die Spezifikation braucht die KI: ${problem}`);
      const over = budgetProblem(app, policy, ctx.locationId, 0);
      if (over) throw new HttpError(409, over);
      const refused = gateProblem(app, ctx.locationId, 'werkstatt_spec', ctx.user ?? undefined);
      if (refused) throw new HttpError(409, refused);
      const wish = p.wish_id ? db.get<{ title: string; body: string }>('SELECT title, body FROM feedback_items WHERE id = ?', p.wish_id) : undefined;
      const h = healthOf(app, p.id);
      const usage = `${h.installs} Installation(en), ${h.usage_30d} Nutzungen in 30 Tagen, ${h.errors_7d} Fehler in 7 Tagen, ${h.votes} Stimmen, Bewertung ${h.rating ?? 'keine'} (${h.reviews}).`;
      const r = await run!({ locationId: ctx.locationId, purpose: 'werkstatt_spec', system: [{ text: SPEC_SYSTEM, cache: true }], user: specUser({ wish: wish ? `${wish.title}\n${wish.body}` : `(kein Wunsch verknüpft) ${p.description}`, manifest: v.manifest, ui_html: v.ui_html, server_js: v.server_js, steps: v.steps, usage }), schema: SPEC_SCHEMA, maxTokens: 6000, timeoutMs: 240_000, userId: ctx.user!.id });
      callCost(app, ctx.locationId, r);
      const parsed = parseSpec(r.text);
      if (!parsed.ok) throw new HttpError(502, `Die KI hat keine brauchbare Spezifikation geliefert (${parsed.error}).`);
      const flag = `core.${p.slug}`.slice(0, 59);
      (app.services.flags as { define?: Function } | undefined)?.define?.(flag, { description: `Kernfeature aus dem Plugin „${p.name}“` });
      const row = { id: newId(), plugin_id: p.id, status: 'spec', repo, agent, github_location_id: '', issue_number: null, issue_url: '', title: parsed.value.title, spec: parsed.value.spec, flag, prs: '[]', target_version: targetVersion, shipped_version: '', core_action: coreAction, error: '', last_checked_at: null, created_by: (ctx.user as User).id, created_at: now(), updated_at: now() };
      db.insert('plugin_core', row);
      const res = ctx.body?.create_issue === false ? { ok: true } : await createIssue(row, ctx.locationId);
      return { ...out(get(row.id)), issue_error: res.ok ? '' : res.error };
    });
    router.post('/api/werkstatt/core/:id/issue', 'location', async (ctx) => {
      adminOnly(ctx);
      const r = get(ctx.params.id);
      if (r.issue_number) throw bad('Das Issue gibt es schon.');
      const res = await createIssue(r, ctx.locationId);
      return { ...out(get(r.id)), issue_error: res.ok ? '' : res.error };
    });
    router.put('/api/werkstatt/core/:id', 'admin', (ctx) => {
      const r = get(ctx.params.id);
      const patch: Row = {};
      if (ctx.body?.target_version !== undefined) {
        const t = String(ctx.body.target_version).trim();
        if (t && !VERSION_RE.test(t)) throw bad('Zielversion bitte als 0.0.25 angeben.');
        patch.target_version = t;
      }
      if (ctx.body?.core_action !== undefined) patch.core_action = ctx.body.core_action === 'retire' ? 'retire' : 'migrate';
      if (Object.keys(patch).length) set(r.id, patch);
      return out(get(r.id));
    });
    router.delete('/api/werkstatt/core/:id', 'admin', (ctx) => {
      const r = get(ctx.params.id);
      db.run('DELETE FROM plugin_core WHERE id = ?', r.id);
      if (!db.get('SELECT 1 FROM plugin_core WHERE plugin_id = ? AND status IN (\'spec\', \'issue_open\', \'in_progress\', \'merged\', \'shipped\')', r.plugin_id)) db.run(`UPDATE plugins SET core_status = '' WHERE id = ? AND status <> 'in_core'`, r.plugin_id);
      return { ok: true };
    });

    // --- tracking -----------------------------------------------------------------------------------------------------------------
    const refresh = async (r: Row): Promise<Row> => {
      const gh = issues();
      if (!gh || !r.issue_number || !r.repo) return r;
      try {
        const st = await gh.status(r.github_location_id || githubLocation(''), r.repo, r.issue_number);
        const merged = st.prs.some((x: any) => x.merged);
        const status = merged ? 'merged' : st.closed ? 'closed' : st.prs.some((x: any) => x.state === 'open') ? 'in_progress' : 'issue_open';
        set(r.id, { status: r.status === 'shipped' ? 'shipped' : status, prs: st.prs, last_checked_at: now(), error: '' });
      } catch (e) {
        set(r.id, { last_checked_at: now(), error: (e as Error).message });
      }
      return get(r.id);
    };
    router.post('/api/werkstatt/core/:id/refresh', 'admin', async (ctx) => out(await refresh(get(ctx.params.id))));

    /** The core version shipped: the plugin is "im Kern enthalten", installs migrate (off, data kept) or retire (removed). */
    const ship = (r: Row, version: string, action: 'migrate' | 'retire') => {
      const p = getPlugin(app, r.plugin_id);
      if (!p) return;
      const people = db.all<{ installed_by: string }>('SELECT DISTINCT installed_by FROM plugin_installs WHERE plugin_id = ? AND installed_by IS NOT NULL', p.id).map((x) => x.installed_by);
      if (action === 'retire') {
        db.run('DELETE FROM plugin_installs WHERE plugin_id = ?', p.id);
        for (const t of ['plugin_storage', 'plugin_job_state', 'plugin_created']) db.run(`DELETE FROM ${t} WHERE plugin_id = ?`, p.id);
      } else db.run('UPDATE plugin_installs SET enabled = 0, updated_at = ? WHERE plugin_id = ?', now(), p.id);
      db.run(`UPDATE plugins SET status = 'in_core', core_status = 'shipped', core_version = ?, updated_at = ? WHERE id = ?`, version, now(), p.id);
      set(r.id, { status: 'shipped', shipped_version: version, core_action: action });
      if (people.length) void Promise.resolve(app.services.pushNotify?.({ userIds: people, kind: 'plugin', title: `„${p.name}“ ist jetzt ${NAMES.inCore}`, body: `Ab Version ${version} gehört die Funktion fest zu ${app.services.brandName?.() ?? 'HyperLevel'}.${action === 'migrate' ? ' Das Plugin ist abgeschaltet, die Daten bleiben erhalten.' : ''}`, url: '/app/marktplatz', tag: `plugin-core-${p.id}` })).catch(() => {});
    };
    router.post('/api/werkstatt/core/:id/ship', 'admin', (ctx) => {
      const r = get(ctx.params.id);
      const version = String(ctx.body?.version ?? '').trim();
      if (!VERSION_RE.test(version)) throw bad('Version bitte als 0.0.25 angeben.');
      ship(r, version, ctx.body?.action === 'retire' ? 'retire' : 'migrate');
      return out(get(r.id));
    });

    // Every half hour: ask GitHub about open proposals; a merged one with a target version ships when the app reaches it.
    let last = 0;
    const poll = async (force = false) => {
      if (!force && Date.now() - last < 30 * 60_000) return;
      last = Date.now();
      for (const r of db.all(`SELECT * FROM plugin_core WHERE status IN ('issue_open', 'in_progress', 'merged') ORDER BY updated_at LIMIT 20`)) {
        const cur = await refresh(r);
        if (cur.status === 'merged' && cur.target_version && compareVersions(APP_VERSION, cur.target_version) >= 0) ship(cur, cur.target_version, cur.core_action === 'retire' ? 'retire' : 'migrate');
      }
    };
    app.onTick(() => poll());
    app.services.werkstattCore = { poll, ship: (id: string, v: string, a: 'migrate' | 'retire') => ship(get(id), v, a) };
  },
};
