import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Ctx, type User } from '../core/http.js';
import { id as newId, now } from '../core/util.js';
import { parseScreenshot } from '../services/feedback.js';
import { callCost, modelInfo } from '../services/werkstatt/aicost.js';
import { CATEGORIES, SCOPES, newScopes, riskOf } from '../services/werkstatt/manifest.js';
import { NAMES } from '../services/werkstatt/names.js';
import { healthOf } from '../services/werkstatt/health.js';
import { licenseInfo, requirePro } from '../services/werkstatt/license.js';
import { gateProblem } from '../services/werkstatt/models.js';
import { compareReviews, secondState } from '../services/werkstatt/secondopinion.js';
import { EFFORT_LABELS, type EffortPlan } from '../services/ai-effort.js';
import { REVIEW_SCHEMA, REVIEW_SYSTEM, parseReview, reviewUser, type Review } from '../services/werkstatt/generate.js';
import { upsertInstall } from '../services/werkstatt/lifecycle.js';
import { verify, verificationText } from '../services/werkstatt/logic.js';
import { budgetProblem, loadPolicy } from '../services/werkstatt/policy.js';
import { autoChecks, mergeReview } from '../services/werkstatt/review.js';
import { probeSandbox } from '../services/werkstatt/sandbox.js';
import { captureScreenshot, screenshotsEnabled } from '../services/werkstatt/screenshot.js';
import { canManage, getPlugin, getVersion, versionsOf, type InstallRow, type PluginRow } from '../services/werkstatt/store.js';

/**
 * Marktplatz: where plugins are discovered and installed. Listing with categories, search, screenshots, ratings,
 * install counts; install per sub-account behind a permission consent screen; updates with a changelog (new
 * permissions need a new consent); uninstall (data removal optional, see plugins.ts). Curation: only admins
 * publish, after an automatic security review by an AI agent (checklist) and their own approval.
 */

const jsonOr = <T>(s: unknown, fallback: T): T => {
  try {
    return s === null || s === undefined ? fallback : (JSON.parse(String(s)) as T);
  } catch {
    return fallback;
  }
};

export const marktplatzModule: Module = {
  name: 'marktplatz',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE plugin_media (
        id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL,
        auto INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE INDEX plugin_media_p ON plugin_media(plugin_id);
      CREATE TABLE plugin_reviews (
        id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, location_id TEXT NOT NULL, user_id TEXT NOT NULL, rating INTEGER NOT NULL,
        body TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (plugin_id, user_id)
      );
      CREATE TABLE plugin_security_reviews (
        id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, version_id TEXT NOT NULL, verdict TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
        checks TEXT NOT NULL DEFAULT '[]', model TEXT NOT NULL DEFAULT '', cost_micros INTEGER NOT NULL DEFAULT 0,
        created_by TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX plugin_security_reviews_p ON plugin_security_reviews(plugin_id, created_at);
      `,
    ],
    // The second opinion (a different top model) is a review of its own kind; both record the Denkstufe.
    ['002-review-kind', `ALTER TABLE plugin_security_reviews ADD COLUMN kind TEXT NOT NULL DEFAULT 'review'; ALTER TABLE plugin_security_reviews ADD COLUMN effort TEXT NOT NULL DEFAULT '';`],
  ],
  register(app) {
    const { db, router } = app;
    const P = () => app.services.plugins as any;
    const user = (ctx: Ctx): User => {
      if (!ctx.user) throw new HttpError(403, 'Der Marktplatz braucht eine Anmeldung (nicht einen API-Schlüssel).');
      return ctx.user;
    };
    const actor = (ctx: Ctx): User => ctx.user ?? { id: '', email: '', name: 'API-Schlüssel', role: 'member', locations: [ctx.locationId], permissions: null };
    /** Admin routes that act in a sub-account (AI budget, card of the plugin) need x-location-id like every other route. */
    const adminOnly = (ctx: Ctx) => {
      if (ctx.user?.role !== 'admin') throw new HttpError(403, 'Nur für Admins');
    };
    const isTeam = (u: User) => u.role === 'admin' || !u.permissions || u.permissions.includes('settings');
    const loc = (id: string) => app.location(id);

    const listed = (): PluginRow[] => db.all<PluginRow>(`SELECT * FROM plugins WHERE scope = 'marketplace' AND market_version_id IS NOT NULL AND status IN ('active', 'in_core', 'killed') ORDER BY published_at DESC`);
    const installRows = (pluginId: string, locationId: string, u: User): InstallRow[] =>
      db.all<any>('SELECT * FROM plugin_installs WHERE plugin_id = ? AND location_id = ? AND (user_id IS NULL OR user_id = ?)', pluginId, locationId, u.id).map((r) => ({ ...r, consent_scopes: jsonOr(r.consent_scopes, [] as string[]) }));
    const shots = (pluginId: string) => db.all<{ id: string }>('SELECT id FROM plugin_media WHERE plugin_id = ? ORDER BY auto, created_at', pluginId).map((m) => `/api/marktplatz/${pluginId}/screenshots/${m.id}`);

    const card = (p: PluginRow, u: User, locationId: string) => {
      const v = getVersion(app, p.market_version_id);
      const m = v?.manifest;
      const h = healthOf(app, p.id);
      const mine = installRows(p.id, locationId, u);
      const own = mine.find((i) => i.user_id === u.id) ?? mine.find((i) => i.user_id === null);
      const owner = u.role === 'admin' ? { user: p.owner_user_id ? (db.get('SELECT name FROM users WHERE id = ?', p.owner_user_id)?.name ?? '') : '', location: p.owner_location_id ? (loc(p.owner_location_id)?.name ?? '') : '' } : undefined;
      return {
        id: p.id,
        slug: p.slug,
        name: p.name,
        icon: p.icon,
        description: p.description,
        category: p.category,
        category_label: CATEGORIES.find(([k]) => k === p.category)?.[1] ?? p.category,
        version: v?.version ?? '',
        scopes: (m?.scopes ?? []).map((k) => ({ key: k, label: SCOPES[k]?.label ?? k, hint: SCOPES[k]?.hint ?? '', risk: SCOPES[k]?.risk ?? 'medium', write: !!SCOPES[k]?.write })),
        risk: riskOf(m?.scopes ?? []),
        has_ui: !!(m?.entries.page || m?.entries.panels?.length || m?.entries.widgets?.length),
        has_actions: !!m?.entries.actions?.length,
        has_jobs: !!m?.entries.jobs?.length,
        installs: h.installs,
        rating: h.rating,
        reviews: h.reviews,
        votes: h.votes,
        screenshots: shots(p.id),
        installed: !!own,
        installed_scope: own ? (own.user_id ? 'private' : 'location') : null,
        enabled: own ? own.enabled === 1 : false,
        update_available: !!own && !!own.version_id && own.version_id !== p.market_version_id,
        killed: p.status === 'killed',
        in_core: p.status === 'in_core',
        core_version: p.core_version,
        published_at: p.published_at,
        owner,
        health: u.role === 'admin' ? h : undefined,
      };
    };

    // --- discover ---------------------------------------------------------------------------------------------------------
    router.get('/api/marktplatz', 'location', (ctx) => {
      const u = actor(ctx);
      const q = String(ctx.query.get('q') ?? '').trim().toLowerCase().slice(0, 80);
      const cat = String(ctx.query.get('category') ?? '');
      const sort = String(ctx.query.get('sort') ?? 'popular');
      let rows = listed().filter((p) => p.status !== 'killed' || u.role === 'admin');
      if (cat) rows = rows.filter((p) => p.category === cat);
      if (q) rows = rows.filter((p) => `${p.name} ${p.description} ${CATEGORIES.find(([k]) => k === p.category)?.[1] ?? ''}`.toLowerCase().includes(q));
      const cards = rows.map((p) => card(p, u, ctx.locationId));
      if (sort === 'rating') cards.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.reviews - a.reviews);
      else if (sort === 'new') cards.sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)));
      else cards.sort((a, b) => b.installs - a.installs || (b.rating ?? 0) - (a.rating ?? 0));
      const counts = Object.fromEntries(CATEGORIES.map(([k]) => [k, listed().filter((p) => p.category === k && p.status !== 'killed').length]));
      return { plugins: cards, categories: CATEGORIES.map(([key, label]) => ({ key, label, count: counts[key] })), names: NAMES, can_install: isTeam(u), license: licenseInfo(app) };
    });
    router.get('/api/marktplatz/:id', 'location', (ctx) => {
      const u = actor(ctx);
      const p = getPlugin(app, ctx.params.id);
      if (!p || p.scope !== 'marketplace' || !p.market_version_id) throw notFound('Plugin nicht gefunden');
      const mv = getVersion(app, p.market_version_id)!;
      const changelog = versionsOf(app, p.id)
        .filter((v) => v.status === 'checked' && v.created_at <= mv.created_at)
        .slice(0, 10)
        .map((v) => ({ version: v.version, changelog: v.changelog, at: v.created_at }));
      const own = installRows(p.id, ctx.locationId, u)[0];
      const installedV = own?.version_id ? getVersion(app, own.version_id) : undefined;
      const newer = installedV ? changelog.filter((c) => c.at > installedV.created_at) : [];
      const added = installedV ? newScopes(installedV.manifest.scopes, mv.manifest.scopes) : [];
      return {
        ...card(p, u, ctx.locationId),
        long_description: p.description,
        entries: { page: mv.manifest.entries.page ?? null, panels: mv.manifest.entries.panels ?? [], widgets: mv.manifest.entries.widgets ?? [], actions: mv.manifest.entries.actions ?? [], jobs: mv.manifest.entries.jobs ?? [] },
        changelog,
        update: own && own.version_id && own.version_id !== p.market_version_id ? { from: installedV?.version ?? '', to: mv.version, changelog: newer, new_scopes: added.map((k) => ({ key: k, label: SCOPES[k]?.label ?? k, risk: SCOPES[k]?.risk ?? 'medium' })) } : null,
        my_review: db.get('SELECT rating, body FROM plugin_reviews WHERE plugin_id = ? AND user_id = ?', p.id, u.id) ?? null,
        can_review: !!own,
      };
    });

    // --- install, update ----------------------------------------------------------------------------------------------------
    const consentMatches = (given: unknown, scopes: string[]) => Array.isArray(given) && [...given.map(String)].sort().join(',') === [...scopes].sort().join(',');
    router.post('/api/marktplatz/:id/install', 'location', async (ctx) => {
      requirePro(app, 'marktplatz');
      const u = user(ctx);
      const p = getPlugin(app, ctx.params.id);
      if (!p || p.scope !== 'marketplace' || !p.market_version_id || p.status !== 'active') throw notFound('Plugin nicht gefunden');
      const v = getVersion(app, p.market_version_id)!;
      const scope = ctx.body?.scope === 'private' ? 'private' : 'location';
      if (scope === 'location' && !isTeam(u)) throw new HttpError(403, 'Für den ganzen Sub-Account brauchst du das Recht „Einstellungen“ – du kannst es auch nur für dich installieren.');
      // The consent screen: the install lists exactly the permissions the plugin asks for.
      if (!consentMatches(ctx.body?.consent, v.manifest.scopes)) throw bad('Bitte bestätige die Berechtigungen, die das Plugin anfragt.');
      const m = v.manifest;
      const policy = loadPolicy(app);
      if ((m.entries.actions?.length || m.entries.jobs?.length) && policy.server_logic === 'off') throw new HttpError(409, 'Server-Logik ist laut Richtlinie ausgeschaltet – dieses Plugin braucht sie.');
      if (m.server?.mode === 'script' && (policy.server_logic === 'declarative' || !(await probeSandbox()).ok)) throw new HttpError(409, 'Dieses Plugin braucht die Skript-Sandbox, die hier nicht verfügbar oder ausgeschaltet ist.');
      const hosts = m.externalHosts ?? [];
      if (hosts.some((h) => !policy.allowed_hosts.includes(h))) throw new HttpError(409, `Das Plugin nutzt externe Hosts, die ein Admin noch nicht freigegeben hat: ${hosts.filter((h) => !policy.allowed_hosts.includes(h)).join(', ')}.`);
      upsertInstall(app, { pluginId: p.id, locationId: ctx.locationId, userId: scope === 'private' ? u.id : null, versionId: v.id, consent: v.manifest.scopes, by: u.id });
      return card(p, u, ctx.locationId);
    });
    router.post('/api/marktplatz/:id/update', 'location', (ctx) => {
      requirePro(app, 'marktplatz');
      const u = user(ctx);
      const p = getPlugin(app, ctx.params.id);
      if (!p || p.scope !== 'marketplace' || !p.market_version_id) throw notFound('Plugin nicht gefunden');
      const v = getVersion(app, p.market_version_id)!;
      const rows = installRows(p.id, ctx.locationId, u).filter((i) => (i.user_id === null ? isTeam(u) : i.user_id === u.id));
      if (!rows.length) throw notFound('Das Plugin ist hier nicht installiert.');
      for (const i of rows) {
        const added = newScopes(i.consent_scopes, v.manifest.scopes);
        // New permissions need a new consent; unchanged ones update without asking again.
        if (added.length && !consentMatches(ctx.body?.consent, v.manifest.scopes)) throw bad('Die neue Version fragt zusätzliche Berechtigungen an – bitte bestätigen.');
        upsertInstall(app, { pluginId: p.id, locationId: ctx.locationId, userId: i.user_id, versionId: v.id, enabled: i.enabled === 1, consent: v.manifest.scopes, by: u.id });
      }
      return card(p, u, ctx.locationId);
    });

    // --- ratings and reviews ---------------------------------------------------------------------------------------------------
    // Reviews belong to the plugin, not only to its Marktplatz page: whoever tests a private plugin can rate it, and
    // the rating (with the votes of the wish) is what the admin sees before publishing.
    const reviewable = (u: User, locationId: string, id: string): PluginRow => {
      const p = getPlugin(app, id);
      if (!p) throw notFound('Plugin nicht gefunden');
      if (p.scope === 'marketplace' || u.role === 'admin' || installRows(p.id, locationId, u).length || canManage(u, p)) return p;
      throw notFound('Plugin nicht gefunden');
    };
    router.get('/api/marktplatz/:id/reviews', 'location', (ctx) => {
      const u = user(ctx);
      const p = reviewable(u, ctx.locationId, ctx.params.id);
      const rows = db.all<any>('SELECT r.*, u.name AS user_name FROM plugin_reviews r LEFT JOIN users u ON u.id = r.user_id WHERE r.plugin_id = ? ORDER BY r.updated_at DESC LIMIT 100', p.id);
      // Like the wish list: names and sub-accounts only for the agency.
      return rows.map((r) => ({ id: r.id, rating: r.rating, body: r.body, mine: r.user_id === u.id, author: u.role === 'admin' ? `${r.user_name ?? ''} (${loc(r.location_id)?.name ?? ''})` : r.user_id === u.id ? 'Du' : '', created_at: r.created_at, updated_at: r.updated_at }));
    });
    router.put('/api/marktplatz/:id/reviews', 'location', (ctx) => {
      const u = user(ctx);
      const p = reviewable(u, ctx.locationId, ctx.params.id);
      if (!installRows(p.id, ctx.locationId, u).length) throw new HttpError(403, 'Bewerten kann nur, wer das Plugin installiert hat.');
      const rating = Math.round(Number(ctx.body?.rating));
      if (!(rating >= 1 && rating <= 5)) throw bad('Bewertung: 1 bis 5 Sterne.');
      const body = str(ctx.body?.body, 'Text', { max: 1000 });
      db.run('INSERT INTO plugin_reviews (id, plugin_id, location_id, user_id, rating, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(plugin_id, user_id) DO UPDATE SET rating = excluded.rating, body = excluded.body, location_id = excluded.location_id, updated_at = excluded.updated_at', newId(), p.id, ctx.locationId, u.id, rating, body, now(), now());
      return { ok: true, health: healthOf(app, p.id) };
    });
    router.delete('/api/marktplatz/:id/reviews', 'location', (ctx) => {
      const u = user(ctx);
      const who = u.role === 'admin' && ctx.query.get('review') ? db.get<{ user_id: string }>('SELECT user_id FROM plugin_reviews WHERE id = ? AND plugin_id = ?', ctx.query.get('review'), ctx.params.id)?.user_id : u.id;
      if (who) db.run('DELETE FROM plugin_reviews WHERE plugin_id = ? AND user_id = ?', ctx.params.id, who);
      return { ok: true };
    });

    // --- screenshots ------------------------------------------------------------------------------------------------------------
    // 'user' (no sub-account needed): the app shows these with a plain <img src>, which cannot send x-location-id.
    router.get('/api/marktplatz/:id/screenshots/:mid', 'user', (ctx) => {
      const u = user(ctx);
      const p = getPlugin(app, ctx.params.id);
      if (!p || !(p.scope === 'marketplace' || canManage(u, p))) throw notFound('Bild nicht gefunden');
      const m = db.get<{ mime: string; data: Uint8Array }>('SELECT mime, data FROM plugin_media WHERE id = ? AND plugin_id = ?', ctx.params.mid, p.id);
      if (!m) throw notFound('Bild nicht gefunden');
      return { __raw: true, status: 200, headers: { 'content-type': m.mime, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" }, body: Buffer.from(m.data) };
    });
    router.post('/api/marktplatz/:id/screenshots', 'location', (ctx) => {
      const u = user(ctx);
      const p = getPlugin(app, ctx.params.id);
      if (!p || !canManage(u, p)) throw notFound('Plugin nicht gefunden');
      const img = parseScreenshot(ctx.body?.image, 400_000);
      if (db.get<{ n: number }>('SELECT COUNT(*) AS n FROM plugin_media WHERE plugin_id = ? AND auto = 0', p.id)!.n >= 4) throw bad('Höchstens vier eigene Bilder je Plugin.');
      const id = newId();
      db.insert('plugin_media', { id, plugin_id: p.id, mime: img.mime, size: img.buf.length, data: img.buf, auto: 0, created_at: now() });
      return { id, url: `/api/marktplatz/${p.id}/screenshots/${id}` };
    });
    router.delete('/api/marktplatz/:id/screenshots/:mid', 'location', (ctx) => {
      const u = user(ctx);
      const p = getPlugin(app, ctx.params.id);
      if (!p || !canManage(u, p)) throw notFound('Plugin nicht gefunden');
      db.run('DELETE FROM plugin_media WHERE id = ? AND plugin_id = ?', ctx.params.mid, p.id);
      return { ok: true };
    });
    /** Best effort: a headless browser opens the signed demo page (sample data) – only when an admin switched that on. */
    const autoShot = async (p: PluginRow): Promise<boolean> => {
      const v = getVersion(app, p.market_version_id ?? p.active_version_id);
      const hook = app.services.pluginScreenshot as ((url: string) => Promise<Buffer | null>) | undefined;
      if (!v || (!hook && !screenshotsEnabled())) return false;
      const m = v.manifest;
      if (!m.entries.page && !m.entries.widgets?.length && !m.entries.panels?.length) return false; // nothing to look at
      const entry = m.entries.page ? 'page' : m.entries.widgets?.length ? `widget:${m.entries.widgets[0].id}` : m.entries.panels?.length ? `panel:${m.entries.panels[0].id}` : 'page';
      const url = app.services.pluginPreviewUrl(v.id, { entry, entity: entry.startsWith('panel') ? 'contact:demo-c1' : undefined }) as string;
      const png = await (hook ?? captureScreenshot)(url);
      if (!png || png.length < 100) return false;
      db.run('DELETE FROM plugin_media WHERE plugin_id = ? AND auto = 1', p.id);
      db.insert('plugin_media', { id: newId(), plugin_id: p.id, mime: 'image/png', size: png.length, data: png, auto: 1, created_at: now() });
      return true;
    };
    router.post('/api/marktplatz/:id/screenshots/auto', 'admin', async (ctx) => {
      const p = getPlugin(app, ctx.params.id);
      if (!p) throw notFound('Plugin nicht gefunden');
      if (!(await autoShot(p))) throw new HttpError(409, 'Automatische Bilder sind nicht eingerichtet (PGHL_PLUGIN_SCREENSHOTS=1 und PGHL_CHROMIUM) oder die Aufnahme ist fehlgeschlagen – lade ein Bild hoch oder nutze die Live-Vorschau.');
      return { ok: true, screenshots: shots(p.id) };
    });

    // --- curation: security review, then an admin's approval --------------------------------------------------------------------
    const reviewRow = (r: any) => ({ id: r.id, kind: r.kind ?? 'review', version_id: r.version_id, version: getVersion(app, r.version_id)?.version ?? '', verdict: r.verdict, summary: r.summary, checks: jsonOr(r.checks, []), model: r.model, effort: jsonOr<any>(r.effort, null), cost_usd: r.cost_micros / 1e6, by: r.created_by ? (db.get('SELECT name FROM users WHERE id = ?', r.created_by)?.name ?? '') : '', created_at: r.created_at });
    type RunResult = { text: string; model?: string; usage?: any; costMicros?: number; effort?: EffortPlan };
    const aiRunner = () => app.services.aiRun as ((i: Record<string, unknown>) => Promise<RunResult>) | undefined;
    const aiProblem = (locationId: string, what: string) => {
      const problem = (app.services.aiReady?.(locationId) as string | null | undefined) ?? (aiRunner() ? null : 'Die KI ist nicht eingerichtet.');
      if (problem) throw new HttpError(409, `${what} braucht die KI: ${problem}`);
      const over = budgetProblem(app, loadPolicy(app), locationId, 0);
      if (over) throw new HttpError(409, over);
    };
    const checkedVersion = (p: PluginRow, id: unknown) => {
      const v = getVersion(app, String(id ?? '') || p.active_version_id);
      if (!v || v.plugin_id !== p.id || v.status !== 'checked') throw bad('Geprüft werden kann nur eine Version, die die automatische Prüfung bestanden hat.');
      return v;
    };
    /** One AI review (the checklist), merged with what the program finds out by itself, stored with model and Denkstufe. */
    const reviewOnce = async (ctx: Ctx, p: PluginRow, v: ReturnType<typeof getVersion> & {}, purpose: 'werkstatt_review' | 'werkstatt_review2', kind: 'review' | 'second_opinion') => {
      const files = { manifest: v.manifest, ui_html: v.ui_html, server_js: v.server_js, steps: v.steps };
      const verification = await verify(app, files, ctx.locationId);
      const auto = autoChecks(files, verification);
      const r = await aiRunner()!({ locationId: ctx.locationId, purpose, system: [{ text: REVIEW_SYSTEM, cache: true }], user: reviewUser({ ...files, staticReport: verification.ok ? 'Alle automatischen Prüfungen bestanden.' : verificationText(verification) }), schema: REVIEW_SCHEMA, maxTokens: 3000, timeoutMs: 180_000, userId: ctx.user!.id });
      const parsed = parseReview(r.text);
      if (!parsed.ok) throw new HttpError(502, `Die KI hat keine brauchbare Prüfung geliefert (${parsed.error}).`);
      const merged: Review = mergeReview(parsed.value, auto);
      const id = newId();
      const effort = r.effort ? { requested: r.effort.requested, applied: r.effort.applied, label: r.effort.applied ? EFFORT_LABELS[r.effort.applied] : '', note: r.effort.note } : null;
      db.insert('plugin_security_reviews', { id, plugin_id: p.id, version_id: v.id, kind, verdict: merged.verdict, summary: merged.summary, checks: merged.checks, model: r.model || modelInfo(app, ctx.locationId, purpose).model, effort: effort ? JSON.stringify(effort) : '', cost_micros: callCost(app, ctx.locationId, r), created_by: ctx.user!.id, created_at: now() });
      return reviewRow(db.get('SELECT * FROM plugin_security_reviews WHERE id = ?', id));
    };
    router.post('/api/marktplatz/:id/security-review', 'location', async (ctx) => {
      adminOnly(ctx);
      const p = getPlugin(app, ctx.params.id);
      if (!p) throw notFound('Plugin nicht gefunden');
      const v = checkedVersion(p, ctx.body?.version_id);
      aiProblem(ctx.locationId, 'Die Sicherheitsprüfung');
      // Only a top model judges code – the same gate as for writing it.
      const refused = gateProblem(app, ctx.locationId, 'werkstatt_review', ctx.user);
      if (refused) throw new HttpError(409, refused);
      return reviewOnce(ctx, p, v, 'werkstatt_review', 'review');
    });
    /** The publish dialog: both verdicts, and what is still missing (a second opinion, Pro). */
    const checkState = (p: PluginRow, locationId: string, user: User, versionId?: string) => {
      const v = getVersion(app, versionId || p.active_version_id);
      const rows = v ? db.all<any>('SELECT * FROM plugin_security_reviews WHERE version_id = ? ORDER BY created_at DESC', v.id).map(reviewRow) : [];
      const first = rows.find((r) => r.kind === 'review') ?? null;
      const second = rows.find((r) => r.kind === 'second_opinion') ?? null;
      return { version: v ? { id: v.id, version: v.version } : null, review: first, second_opinion: second, comparison: first && second ? compareReviews(first, second) : null, second_state: v ? secondState(app, locationId, v, user) : null, license: licenseInfo(app) };
    };
    router.get('/api/marktplatz/:id/publish-check', 'location', (ctx) => {
      adminOnly(ctx);
      const p = getPlugin(app, ctx.params.id);
      if (!p) throw notFound('Plugin nicht gefunden');
      return checkState(p, ctx.locationId, ctx.user!, String(ctx.query.get('version_id') ?? ''));
    });
    /** Pro: the same checklist answered independently by a different top model. */
    router.post('/api/marktplatz/:id/second-opinion', 'location', async (ctx) => {
      adminOnly(ctx);
      requirePro(app, 'second_opinion');
      const p = getPlugin(app, ctx.params.id);
      if (!p) throw notFound('Plugin nicht gefunden');
      const v = checkedVersion(p, ctx.body?.version_id);
      if (!db.get(`SELECT 1 FROM plugin_security_reviews WHERE version_id = ? AND kind = 'review'`, v.id)) throw new HttpError(409, 'Zuerst die Sicherheitsprüfung durchführen – die Zweitmeinung kommt danach.');
      const st = secondState(app, ctx.locationId, v, ctx.user);
      if (!st.available) throw new HttpError(409, st.reason);
      aiProblem(ctx.locationId, 'Die Zweitmeinung');
      await reviewOnce(ctx, p, v, 'werkstatt_review2', 'second_opinion');
      return checkState(p, ctx.locationId, ctx.user!, v.id);
    });
    router.get('/api/marktplatz/:id/security-reviews', 'admin', (ctx) => db.all('SELECT * FROM plugin_security_reviews WHERE plugin_id = ? ORDER BY created_at DESC LIMIT 20', ctx.params.id).map(reviewRow));
    router.post('/api/marktplatz/:id/publish', 'location', async (ctx) => {
      adminOnly(ctx);
      requirePro(app, 'marktplatz');
      const p = getPlugin(app, ctx.params.id);
      if (!p) throw notFound('Plugin nicht gefunden');
      if (p.status !== 'active') throw bad('Ein abgeschaltetes Plugin lässt sich nicht veröffentlichen.');
      const rev = db.get<any>('SELECT * FROM plugin_security_reviews WHERE id = ? AND plugin_id = ?', String(ctx.body?.review_id ?? ''), p.id);
      if (!rev) throw new HttpError(409, 'Zuerst die Sicherheitsprüfung durchführen.');
      const v = getVersion(app, rev.version_id);
      if (!v || v.status !== 'checked') throw bad('Diese Version ist nicht mehr gültig.');
      if (rev.verdict === 'fail') throw new HttpError(409, 'Die Sicherheitsprüfung ist durchgefallen – das Plugin wird nicht veröffentlicht.');
      // The second opinion (another top model) counts when it exists, and is required when Pro, a second model and the policy say so.
      const st = secondState(app, ctx.locationId, v, ctx.user);
      const second = db.get<any>(`SELECT * FROM plugin_security_reviews WHERE version_id = ? AND kind = 'second_opinion' ORDER BY created_at DESC LIMIT 1`, v.id);
      if (st.required && st.available && !second) throw new HttpError(409, 'Vor dem Veröffentlichen fehlt die Zweitmeinung eines anderen Spitzenmodells – bitte zuerst einholen (Richtlinie).');
      if (second?.verdict === 'fail') throw new HttpError(409, 'Die Zweitmeinung ist durchgefallen – das Plugin wird nicht veröffentlicht.');
      if (ctx.body?.approve !== true) throw bad(`Bitte bestätige die Veröffentlichung im ${NAMES.marktplatz} (approve).`);
      if ((rev.verdict === 'warn' || second?.verdict === 'warn') && ctx.body?.accept_warnings !== true) throw bad('Die Prüfung hat Hinweise – bitte bestätigen, dass du sie gelesen hast (accept_warnings).');
      // A review belongs to the exact content: edited code needs a new one.
      db.run(`UPDATE plugins SET scope = 'marketplace', market_version_id = ?, published_at = COALESCE(published_at, ?), published_by = ?, name = ?, icon = ?, description = ?, category = ?, updated_at = ? WHERE id = ?`, v.id, now(), ctx.user!.id, v.manifest.name, v.manifest.icon, v.manifest.description, v.manifest.category, now(), p.id);
      void autoShot(getPlugin(app, p.id)!).catch(() => false);
      // People who run an older version hear that an update is there.
      const people = db.all<{ installed_by: string }>(`SELECT DISTINCT installed_by FROM plugin_installs WHERE plugin_id = ? AND version_id IS NOT NULL AND version_id <> ? AND installed_by IS NOT NULL`, p.id, v.id).map((r) => r.installed_by);
      if (people.length) void Promise.resolve(app.services.pushNotify?.({ userIds: people, kind: 'plugin', title: `Update für „${v.manifest.name}“`, body: v.changelog || `Version ${v.version}`, url: `/app/marktplatz/${p.id}`, tag: `plugin-update-${p.id}` })).catch(() => {});
      return card(getPlugin(app, p.id)!, ctx.user!, ctx.locationId);
    });
    router.post('/api/marktplatz/:id/unpublish', 'admin', (ctx) => {
      const p = getPlugin(app, ctx.params.id);
      if (!p || p.scope !== 'marketplace') throw notFound('Plugin nicht gefunden');
      const hasLocal = db.get('SELECT 1 FROM plugin_installs WHERE plugin_id = ? AND user_id IS NULL', p.id);
      db.run(`UPDATE plugins SET scope = ?, market_version_id = NULL, updated_at = ? WHERE id = ?`, hasLocal ? 'location' : 'private', now(), p.id);
      return { ok: true };
    });

    // --- all plugins with health, for the agency ----------------------------------------------------------------------------------
    router.get('/api/marktplatz/admin/plugins', 'location', (ctx) => {
      adminOnly(ctx);
      return {
        plugins: db.all<PluginRow>('SELECT * FROM plugins ORDER BY updated_at DESC LIMIT 300').map((p) => {
          const last = db.get<any>('SELECT * FROM plugin_security_reviews WHERE plugin_id = ? ORDER BY created_at DESC LIMIT 1', p.id);
          return { ...P().pluginBrief(p, ctx.user!, ctx.locationId), health: healthOf(app, p.id), review: last ? reviewRow(last) : null, market_version: getVersion(app, p.market_version_id)?.version ?? '' };
        }),
      };
    });
  },
};
