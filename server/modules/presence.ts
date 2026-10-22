import type { App, Module } from '../core/app.js';
import { HttpError, bad, type Ctx, type RawResult, type User } from '../core/http.js';
import { hiddenUser } from '../core/permissions.js';
import { sealSettings } from '../core/secrets.js';
import { now } from '../core/util.js';
import { colorFor } from '../services/canvas-hub.js';
import { userById, type TeamUser } from '../services/collab-actor.js';
import { PresenceHub, type PresenceSub } from '../services/presence-hub.js';
import { CLIENT_ID_RE, cleanCursor, cleanPage, cleanPresencePrefs, presencePrefsOf, type PresencePrefs } from '../services/presence-model.js';
import { loginOf, sweepOnLoginChange } from '../services/stream-login.js';

/**
 * Live-Zusammenarbeit überall (docs/collaboration.md): who of the team is on which page of the app right now, who is
 * typing there, "Anna hat hier gerade gespeichert", and – for those who switch it on – live cursors.
 *
 *   GET  /api/presence/stream?clientId=   SSE per tab and sub-account (personal logins only)
 *   POST /api/presence                    heartbeat {clientId, page, title?, editing?, saved?, leaving?, x?, y? | pts?}
 *   GET  /api/presence/team               colleagues online in this sub-account and where (if the asker may see that area)
 *   GET/PUT /api/presence/prefs           own choices: invisible, avatars in the menu, cursors (stored per login)
 *   GET/PUT /api/presence/settings        the sub-account's switch (area settings)
 *
 * Presence itself is never stored or logged (no table, no audit line, no history) – only live state in memory that
 * expires after PRESENCE_TTL_MS. The preferences and the switch are ordinary settings.
 */

const ENABLED_TTL = 30_000;

export const presenceModule: Module = {
  name: 'presence',
  migrations: [
    [
      '001-prefs',
      `CREATE TABLE presence_prefs (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
      );`,
    ],
  ],
  register(app: App) {
    const { router, db } = app;
    const hub = new PresenceHub();
    app.services.presenceHub = hub;

    // --- settings: the sub-account's switch and each person's choices -------------------------------------------------
    const enabledAt = new Map<string, { on: boolean; at: number }>();
    const enabled = (locationId: string): boolean => {
      const hit = enabledAt.get(locationId);
      if (hit && Date.now() - hit.at < ENABLED_TTL) return hit.on;
      const on = app.location(locationId)?.settings?.presence?.enabled !== false;
      enabledAt.set(locationId, { on, at: Date.now() });
      if (enabledAt.size > 5000) enabledAt.delete(enabledAt.keys().next().value!);
      return on;
    };

    const prefsCache = new Map<string, PresencePrefs>();
    const prefsOf = (userId: string): PresencePrefs => {
      const hit = prefsCache.get(userId);
      if (hit) return hit;
      const row = db.get<{ data: string }>('SELECT data FROM presence_prefs WHERE user_id = ?', userId);
      let stored: unknown = {};
      try {
        stored = row ? JSON.parse(row.data) : {};
      } catch {
        /* damaged row: defaults */
      }
      const p = presencePrefsOf(stored);
      prefsCache.set(userId, p);
      if (prefsCache.size > 5000) prefsCache.delete(prefsCache.keys().next().value!);
      return p;
    };

    /**
     * Presence is a person's: a browser session (also the Android app's WebView) or the app's device token. API keys,
     * MCP / OAuth apps, agency keys, the agent, plugins and the Werkstatt get 403 (like the inbox stream).
     */
    const person = (ctx: Ctx): User => {
      const u = ctx.user;
      if (!u || ctx.viaApiKey || (ctx.via !== 'session' && ctx.via !== 'app')) throw new HttpError(403, 'Live-Zusammenarbeit geht nur mit persönlicher Anmeldung');
      return u;
    };
    const viewerOf = (u: Pick<User, 'id' | 'role' | 'permissions'>) => ({ id: u.id, role: u.role, permissions: u.permissions });
    const clientIdOf = (v: unknown) => {
      const id = String(v ?? '');
      if (!CLIENT_ID_RE.test(id)) throw bad('clientId fehlt');
      return id;
    };

    // --- keeping the state honest -------------------------------------------------------------------------------------
    // A check round (every 20 s) touches every stream and tab: each person is looked up once per round.
    const people = new Map<string, TeamUser | undefined>();
    const fresh = (userId: string) => {
      if (!people.has(userId)) people.set(userId, userById(app, userId));
      return people.get(userId);
    };
    hub.beforeSweep = () => people.clear();
    const locationExists = (id: string) => !!db.get('SELECT 1 AS x FROM locations WHERE id = ?', id);
    const belongs = (u: TeamUser | undefined, locationId: string) => !!u && (u.role === 'admin' || u.locations.includes(locationId));

    hub.revalidate = (s: PresenceSub) => {
      const u = fresh(s.userId);
      if (!belongs(u, s.locationId) || !locationExists(s.locationId)) return false;
      // rights changed (area granted or taken): what this stream may see follows at once
      s.viewer = viewerOf(u!);
      return true;
    };
    hub.keep = (c) => enabled(c.locationId) && belongs(fresh(c.userId), c.locationId);

    const helloFor = (s: PresenceSub) => {
      const on = enabled(s.locationId);
      return { client_id: s.clientId, enabled: on, prefs: s.prefs, peers: on ? hub.peersFor(s) : [] };
    };

    // --- realtime ---------------------------------------------------------------------------------------------------
    router.get('/api/presence/stream', 'location', (ctx: Ctx): RawResult => {
      const u = person(ctx);
      const clientId = clientIdOf(ctx.query.get('clientId'));
      const taken = hub.sub(clientId) ?? hub.client(clientId);
      if (taken && taken.userId !== u.id) throw new HttpError(409, 'Diese Tab-Kennung gehört zu einer anderen Anmeldung');
      const stream = hub.subscribe({ clientId, userId: u.id, locationId: ctx.locationId, viewer: viewerOf(u), prefs: prefsOf(u.id), alive: loginOf(app, ctx) }, helloFor);
      // not a 200 stream: the browser's EventSource gives up instead of retrying every few seconds
      if (!stream) throw new HttpError(503, 'Zu viele Live-Verbindungen – bitte später noch einmal');
      return { __raw: true, status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' }, body: stream };
    });

    /** The heartbeat of a tab (~15 s and on every page change), plus "editing", "saved", "leaving" and cursor samples. */
    router.post('/api/presence', 'location', (ctx) => {
      // live state only: no undo journal, no audit line
      ctx.skipAfterWrite = true;
      const u = person(ctx);
      const b = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {};
      const clientId = clientIdOf(b.clientId);
      // every heartbeat can reach every stream of the sub-account: one person may not flood them
      if (!hub.allow(u.id)) throw new HttpError(429, 'Zu viele Live-Meldungen – bitte kurz warten');
      if (!enabled(ctx.locationId)) return { ok: true, enabled: false };
      const prev = hub.client(clientId);
      if (prev && prev.userId !== u.id) throw new HttpError(409, 'Diese Tab-Kennung gehört zu einer anderen Anmeldung');
      if (b.leaving === true) {
        if (prev) hub.remove(clientId);
        return { ok: true, enabled: true };
      }
      const page = cleanPage(b.page);
      if (!page) throw bad('Ungültige Seite');
      const prefs = prefsOf(u.id);
      const same = prev?.page === page;
      // `title` from older browsers is ignored: no free text from one person's browser goes out to the others
      const c = hub.report({
        clientId,
        userId: u.id,
        name: u.name.slice(0, 80),
        color: colorFor(u.id),
        locationId: ctx.locationId,
        page,
        editing: typeof b.editing === 'boolean' ? b.editing : same ? prev!.editing : false,
        silent: prefs.invisible || hiddenUser(app, u, ctx.locationId),
        prefs,
      });
      if (!c) throw new HttpError(409, 'Diese Tab-Kennung gehört zu einer anderen Anmeldung');
      if (b.saved === true) hub.saved(c);
      const pts = cleanCursor(b);
      if (pts.length) hub.cursor(c, pts);
      return { ok: true, enabled: true };
    });

    /** Colleagues online in this sub-account – one entry per person (their most recent tab), the page only where allowed. */
    router.get('/api/presence/team', 'location', (ctx) => {
      const u = person(ctx);
      const on = enabled(ctx.locationId);
      const me = { userId: u.id, locationId: ctx.locationId, viewer: viewerOf(u) };
      const best = new Map<string, { at: number; out: ReturnType<PresenceHub['viewFor']> }>();
      if (on)
        for (const c of hub.clientsIn(ctx.locationId)) {
          const out = hub.viewFor(me, c);
          if (!out) continue;
          const cur = best.get(c.userId);
          if (!cur || c.at > cur.at) best.set(c.userId, { at: c.at, out });
        }
      const list = [...best.values()]
        .map(({ out }) => ({ user_id: out!.user_id, name: out!.name, color: out!.color, page: out!.page, title: null, editing: out!.editing, online: true }))
        .sort((a, b) => a.name.localeCompare(b.name, 'de'));
      return { enabled: on, prefs: prefsOf(u.id), people: list };
    });

    // --- own choices ---------------------------------------------------------------------------------------------------
    router.get('/api/presence/prefs', 'user', (ctx) => prefsOf(person(ctx).id));
    router.put('/api/presence/prefs', 'user', (ctx) => {
      // a personal view setting: no audit line (who went invisible when is nobody's business)
      ctx.skipAfterWrite = true;
      const u = person(ctx);
      let change: Partial<PresencePrefs>;
      try {
        change = cleanPresencePrefs(ctx.body);
      } catch (e) {
        throw bad((e as Error).message);
      }
      const before = prefsOf(u.id);
      const next: PresencePrefs = { ...before, ...change };
      db.run('INSERT INTO presence_prefs (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at', u.id, JSON.stringify(next), now());
      prefsCache.set(u.id, next);
      hub.setPrefs(u.id, next);
      // gone invisible: gone for the others at once (visible again: the next heartbeat – the app sends one right away –
      // announces the tabs); a new cursor choice is told to the others; "menu" concerns nobody else
      if (next.invisible && !before.invisible) hub.removeWhere((c) => c.userId === u.id);
      else if (next.cursors !== before.cursors) hub.reannounce(u.id);
      return next;
    });

    // --- the sub-account's switch (area settings, see core/permissions.ts) ----------------------------------------------
    router.get('/api/presence/settings', 'location', (ctx) => ({ enabled: enabled(ctx.locationId) }));
    router.put('/api/presence/settings', 'location', (ctx) => {
      const on = ctx.body?.enabled;
      if (typeof on !== 'boolean') throw bad('enabled muss wahr oder falsch sein');
      const loc = app.location(ctx.locationId);
      if (!loc) throw bad('Sub-Account nicht gefunden');
      const was = loc.settings?.presence?.enabled !== false;
      db.run('UPDATE locations SET settings = ? WHERE id = ?', JSON.stringify(sealSettings(app, { ...loc.settings, presence: { ...(loc.settings.presence ?? {}), enabled: on } }).value), loc.id);
      enabledAt.set(ctx.locationId, { on, at: Date.now() });
      if (!on) hub.removeWhere((c) => c.locationId === ctx.locationId);
      hub.publish('settings', { enabled: on }, (s) => s.locationId === ctx.locationId);
      // a sub-account setting like any other: one audit line, saying what changed (instead of the generic one without it)
      ctx.skipAfterWrite = true;
      app.services.audit?.({ ctx, action: 'presence.settings.update', route: 'PUT /api/presence/settings', summary: `Live-Zusammenarbeit ${on ? 'eingeschaltet' : 'ausgeschaltet'}${was === on ? ' (unverändert)' : ''}` });
      return { enabled: on };
    });

    // Signed out, a session or device revoked, a person changed or removed, a sub-account deleted: the streams concerned
    // end now instead of at the next round (20 s). Every stream is bound to the login it was opened with (services/stream-login.ts).
    sweepOnLoginChange(app, hub);

    app.services.presence = { hub, enabled, prefsOf };
  },
};
