import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Ctx, type RawResult } from '../core/http.js';
import { now } from '../core/util.js';
import { cleanAccent, cleanIcon, cleanLine, emptySpec, LIMITS, normalizeSpec, parseSpec, type BoardState } from '../services/boards-model.js';
import { DEFAULT_EMBED_HOSTS, cleanHost } from '../services/boards-embed.js';
import { boardData, denial } from '../services/boards-data.js';
import { BoardsHub, type BoardSub } from '../services/boards-hub.js';
import { applyPatch, type PatchResult } from '../services/boards-patch.js';
import { boardOut, canRedo, canUndo, createBoard, deleteBoard, listVersions, loadBoard, redoBoard, restoreVersion, saveState, stateOf, undoBoard, versionOut, versionRow, visibleBoards, actorOf, type Access, type BoardRow, type VersionKind } from '../services/boards-store.js';
import { starterByKey, stateFromTemplate } from '../services/boards-templates.js';
import { CATEGORIES, boardWidgets } from '../services/boards-widgets.js';
import { registerCoreWidgets } from '../services/boards-widgets-core.js';
import { callRoute } from '../services/route-call.js';
import { loginOf, sweepOnLoginChange } from '../services/stream-login.js';
import { accessibleSpaces } from '../services/wiki-store.js';
import { PURPOSES } from './ai-assistant.js';

/**
 * Living Boards: workspaces a person composes from widgets – by dragging, or by saying what they want to see (the
 * prompt bar, modules/boards-compose.ts). Per sub-account, personal or shared, every change a version with undo, redo
 * and restore, changes live for everyone looking (SSE, like the Team-Chat). Widgets come from a registry other modules
 * can add to (`app.services.boardWidgets.register`), and every widget reads the data it shows with the *viewer's*
 * rights. Contract and widget API: docs/living-boards.md.
 */

export const boardsModule: Module = {
  name: 'boards',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE boards (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, icon TEXT NOT NULL DEFAULT 'boards', accent TEXT NOT NULL DEFAULT '',
        scope TEXT NOT NULL DEFAULT 'personal', team_access TEXT NOT NULL DEFAULT 'view',
        owner_id TEXT, owner_name TEXT NOT NULL DEFAULT '',
        spec TEXT NOT NULL, head INTEGER NOT NULL DEFAULT 1, seq INTEGER NOT NULL DEFAULT 1, redo TEXT NOT NULL DEFAULT '[]',
        template_key TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX boards_loc ON boards(location_id, updated_at);
      CREATE TABLE board_versions (
        id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        n INTEGER NOT NULL, parent_n INTEGER, kind TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', ops TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL, prompt TEXT NOT NULL DEFAULT '',
        actor_id TEXT, actor_name TEXT NOT NULL DEFAULT '', via TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
        UNIQUE (board_id, n)
      );
      CREATE TABLE board_proposals (
        id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        user_id TEXT, prompt TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '', ops TEXT NOT NULL,
        base_n INTEGER NOT NULL, risk TEXT NOT NULL DEFAULT 'normal', status TEXT NOT NULL DEFAULT 'pending',
        unsupported TEXT NOT NULL DEFAULT '[]', via TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, expires_at TEXT NOT NULL, decided_at TEXT
      );
      CREATE INDEX board_proposals_board ON board_proposals(board_id, status);
      CREATE TABLE board_prefs (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        home_location_id TEXT, home_board_id TEXT, auto_apply TEXT NOT NULL DEFAULT 'layout', updated_at TEXT NOT NULL
      );
      CREATE TABLE board_templates (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        owner_id TEXT, owner_name TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'sonstiges', icon TEXT NOT NULL DEFAULT 'boards',
        scope TEXT NOT NULL DEFAULT 'location', widgets TEXT NOT NULL, accent TEXT NOT NULL DEFAULT '', integrity TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1, installs INTEGER NOT NULL DEFAULT 0, source_board_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, published_at TEXT, published_by TEXT
      );
      CREATE INDEX board_templates_loc ON board_templates(location_id, scope);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const hub = new BoardsHub();
    app.services.boardsHub = hub;
    Object.assign(PURPOSES, { boards: 'Living Boards' });

    // --- widget registry: the built-in widgets, plus whatever modules registered before us -------------------------------
    const reg = boardWidgets(app);
    registerCoreWidgets(reg);
    for (const d of (app.services.boardWidgetDefs ?? []) as Parameters<typeof reg.register>[0][]) reg.register(d);

    // --- addresses the embed widget may show: the built-in list plus the agency's own ------------------------------------------
    const HOSTS_KEY = 'boards_embed_hosts';
    const customHosts = (): string[] => {
      try {
        const v = JSON.parse(db.get<{ value: string }>('SELECT value FROM agency_settings WHERE key = ?', HOSTS_KEY)?.value ?? '[]');
        return Array.isArray(v) ? v.map(cleanHost).filter((h): h is string => !!h) : [];
      } catch {
        return [];
      }
    };
    const allowedHosts = () => [...new Set([...DEFAULT_EMBED_HOSTS, ...customHosts()])];
    app.services.boardsEmbedHosts = allowedHosts;

    const env = (locationId: string) => ({ reg, env: { app, locationId } });

    // --- helpers ---------------------------------------------------------------------------------------------------------
    const person = (ctx: Ctx) => {
      if (!ctx.user || ctx.via === 'agency_key' || ctx.via === 'api_key') throw new HttpError(403, 'Das geht nur mit persönlicher Anmeldung');
      return ctx.user;
    };
    const userRow = (id: string | null) => {
      if (!id) return undefined;
      const r = db.get<{ id: string; email: string; name: string; role: 'admin' | 'member'; locations: string; permissions: string | null }>('SELECT id, email, name, role, locations, permissions FROM users WHERE id = ?', id);
      return r && { id: r.id, email: r.email, name: r.name, role: r.role, locations: JSON.parse(r.locations || '[]') as string[], permissions: r.permissions ? (JSON.parse(r.permissions) as string[]) : null };
    };
    /** May this person still look at the board (right to the area, sub-account, board access)? */
    const mayWatch = (s: BoardSub): boolean => {
      const u = userRow(s.userId);
      if (!u) return false;
      if (u.role !== 'admin' && (!u.locations.includes(s.locationId) || (u.permissions && !u.permissions.includes('dashboard')))) return false;
      const b = db.get<BoardRow>('SELECT * FROM boards WHERE id = ? AND location_id = ?', s.boardId, s.locationId);
      if (!b) return false;
      return !!(u.role === 'admin' || b.owner_id === u.id || b.scope === 'shared');
    };
    hub.revalidate = mayWatch;

    const kindOf = (ctx: Ctx): VersionKind => {
      const via = actorOf(app, ctx).via;
      return via === 'session' || via === 'app' ? 'edit' : via === 'agent' ? 'agent' : 'api';
    };
    const homeId = (ctx: Ctx): string | null => {
      if (!ctx.user) return null;
      const p = db.get<{ home_board_id: string | null; home_location_id: string | null }>('SELECT home_board_id, home_location_id FROM board_prefs WHERE user_id = ?', ctx.user.id);
      return p && p.home_location_id === ctx.locationId ? p.home_board_id : null;
    };

    /** Tells everybody looking: the board now shows this version. */
    const publish = (board: BoardRow, ctx: Ctx, kind: string, summary: string, clientId = '') => {
      const actor = actorOf(app, ctx);
      hub.publish(board.id, 'board', {
        board_id: board.id,
        version: board.head,
        kind,
        summary,
        actor: actor.name,
        via: actor.via,
        client_id: clientId,
        updated_at: board.updated_at,
        state: stateOf(board),
        can_undo: canUndo(app, board),
        can_redo: canRedo(board),
      });
    };
    const audit = (ctx: Ctx, action: string, board: BoardRow, summary: string) => {
      ctx.skipAfterWrite = true;
      app.services.audit?.({ ctx, actor: actorOf(app, ctx).name, action, route: `${ctx.method} ${ctx.path.replace(board.id, ':id')}`, entityId: board.id, summary: `${board.name}: ${summary}` });
    };
    const full = (ctx: Ctx, b: BoardRow, access: Access) => boardOut(app, ctx, b, access, { full: true, home: homeId(ctx) === b.id, viewers: hub.viewers(b.id) });

    // --- the service other modules use ------------------------------------------------------------------------------------
    /** Applies a patch to a board for a caller and saves it as a version (or just checks it with dryRun). */
    const apply = (ctx: Ctx, board: BoardRow, ops: unknown, o: { dryRun?: boolean; expectedVersion?: number; strict?: boolean; summary?: string; prompt?: string; clientId?: string; kind?: VersionKind } = {}) => {
      if (o.expectedVersion !== undefined && o.expectedVersion !== board.head) throw new HttpError(409, `Das Board hat sich inzwischen geändert (jetzt Version ${board.head}) – bitte lade es neu und versuche es noch einmal.`);
      const strict = o.strict ?? actorOf(app, ctx).via !== 'session';
      const r: PatchResult = applyPatch(stateOf(board), ops, { ...env(board.location_id), strict });
      if (o.dryRun || !r.ok) return { result: r, saved: null as null | ReturnType<typeof saveState> };
      const before = JSON.stringify(stateOf(board));
      if (JSON.stringify(r.state) === before) return { result: r, saved: null };
      const saved = saveState(app, ctx, board, r.state, { kind: o.kind ?? kindOf(ctx), summary: o.summary ?? r.summary, ops: r.ops, prompt: o.prompt });
      publish(saved.board, ctx, saved.version.kind, saved.version.summary, o.clientId);
      audit(ctx, 'boards.patch', saved.board, saved.version.summary);
      return { result: r, saved };
    };
    app.services.boards = {
      registry: reg,
      hub,
      env,
      apply,
      publish,
      audit,
      load: (ctx: Ctx, id: string, need?: Access) => loadBoard(app, ctx, id, need),
      full,
      homeId,
      stateOf,
      data: (ctx: Ctx, board: BoardRow, ids?: string[]) => boardData(app, ctx, parseSpec(board.spec), reg, ids),
      list: (ctx: Ctx, all = false) => visibleBoards(app, ctx, { all }),
    };

    // --- catalogue, options, preferences (static paths first: they must win over /api/boards/:id) -----------------------------
    router.get('/api/boards/widgets', 'location', () => ({
      widgets: reg.catalogue(),
      categories: CATEGORIES.map(([key, label]) => ({ key, label })),
      limits: { widgets: LIMITS.widgets, ops: LIMITS.ops },
    }));

    /** Choices for the id fields of the settings panel, from the viewer's own data (guards apply). */
    router.get('/api/boards/options/:source', 'location', async (ctx) => {
      const call = (path: string) => callRoute(app, ctx, 'GET', path, {}, { quiet: true });
      const q = String(ctx.query.get('q') ?? '').trim().toLowerCase().slice(0, 60);
      const list = (rows: unknown, value: (r: any) => string, label: (r: any) => string, hint?: (r: any) => string) =>
        (Array.isArray(rows) ? rows : [])
          .slice(0, 200)
          .map((r: any) => ({ value: value(r), label: label(r), ...(hint ? { hint: hint(r) } : {}) }))
          .filter((o) => o.value && (!q || o.label.toLowerCase().includes(q)));
      switch (ctx.params.source) {
        case 'pipelines':
          return { options: list(await call('/api/pipelines'), (r) => r.id, (r) => r.name) };
        case 'stages': {
          const p = ((await call('/api/pipelines')) as any[]).find((x) => x.id === ctx.query.get('pipeline_id')) ?? (await call('/api/pipelines'))[0];
          return { options: list(p?.stages, (r) => r.id, (r) => r.name) };
        }
        case 'reports': {
          const r = await call('/api/reports/library');
          return { options: list(r?.reports ?? r, (x) => x.id, (x) => x.name, (x) => String(x.config?.viz ?? '')) };
        }
        case 'workflows':
          return { options: list(await call('/api/workflows'), (r) => r.id, (r) => r.name, (r) => (r.status === 'active' ? 'aktiv' : 'Entwurf')) };
        case 'forms':
          return { options: list(await call('/api/forms'), (r) => r.id, (r) => r.name) };
        case 'smart_lists':
          return { options: list(await call('/api/smart-lists'), (r) => r.id, (r) => r.name) };
        case 'calendars':
          return { options: list(await call('/api/calendars'), (r) => r.id, (r) => r.name) };
        case 'projects':
          return { options: list(await call('/api/pm/projects'), (r) => r.id, (r) => r.name) };
        case 'tags':
          return { options: list(await call('/api/tags'), (r) => r.name, (r) => r.name) };
        case 'scenarios':
          return { options: list(await call('/api/calc/scenarios'), (r) => r.id, (r) => r.name) };
        case 'wiki_pages': {
          // Only pages of spaces the viewer may open; the guard of the wiki area applies first.
          const why = denial(app, ctx, '/api/wiki');
          if (why) throw new HttpError(403, why);
          const spaces = accessibleSpaces(app, ctx).map((s) => s.space);
          if (!spaces.length) return { options: [] };
          const rows = db.all<{ id: string; title: string; space_id: string }>(
            `SELECT id, title, space_id FROM wiki_pages WHERE location_id = ? AND trashed_at IS NULL AND space_id IN (${spaces.map(() => '?').join(',')}) ${q ? 'AND lower(title) LIKE ?' : ''} ORDER BY updated_at DESC LIMIT 60`,
            ctx.locationId,
            ...spaces.map((s) => s.id),
            ...(q ? [`%${q}%`] : []),
          );
          const names = new Map(spaces.map((s) => [s.id, s.name]));
          return { options: rows.map((r) => ({ value: r.id, label: r.title, hint: names.get(r.space_id) ?? '' })) };
        }
        case 'plugins':
        case 'plugin_widgets': {
          const svc = app.services.plugins;
          if (!svc || !ctx.user) return { options: [] };
          const options = (svc.activeFor(ctx.user, ctx.locationId) as any[]).flatMap((a) => (a.manifest.entries.widgets ?? []).map((wd: any) => ({ value: `${a.plugin.slug}:${wd.id}`, label: `${a.plugin.name}: ${wd.title}`, hint: a.plugin.name })));
          return { options: options.filter((o) => !q || o.label.toLowerCase().includes(q)) };
        }
        default:
          throw notFound('Unbekannte Quelle');
      }
    });

    router.get('/api/boards/embed-hosts', 'location', (ctx) => ({ defaults: DEFAULT_EMBED_HOSTS, custom: customHosts(), can_edit: ctx.user?.role === 'admin' }));
    router.put('/api/boards/embed-hosts', 'admin', (ctx) => {
      const raw = ctx.body?.hosts;
      if (!Array.isArray(raw)) throw bad('hosts als Liste angeben');
      const hosts: string[] = [];
      for (const h of raw.slice(0, 40)) {
        const c = cleanHost(h);
        if (!c) throw bad(`„${String(h).slice(0, 60)}“ ist kein gültiger Host-Name (z. B. berichte.example.org)`);
        if (!DEFAULT_EMBED_HOSTS.includes(c) && !hosts.includes(c)) hosts.push(c);
      }
      db.run('INSERT INTO agency_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', HOSTS_KEY, JSON.stringify(hosts));
      return { defaults: DEFAULT_EMBED_HOSTS, custom: hosts, can_edit: true };
    });

    // The start page and the person's own settings.
    const prefsOf = (ctx: Ctx) => db.get<{ home_location_id: string | null; home_board_id: string | null; auto_apply: string }>('SELECT home_location_id, home_board_id, auto_apply FROM board_prefs WHERE user_id = ?', person(ctx).id);
    /** The home board if the person may still open it (it can have been deleted or made personal since). */
    const homeOut = (ctx: Ctx) => {
      const p = prefsOf(ctx);
      if (!p?.home_board_id || !p.home_location_id) return null;
      const u = ctx.user!;
      if (u.role !== 'admin' && !u.locations.includes(p.home_location_id)) return null;
      const there: Ctx = { ...ctx, locationId: p.home_location_id };
      if (denial(app, there, '/api/boards')) return null;
      const b = db.get<BoardRow>('SELECT * FROM boards WHERE id = ? AND location_id = ?', p.home_board_id, p.home_location_id);
      if (!b || !(b.owner_id === u.id || u.role === 'admin' || b.scope === 'shared')) return null;
      return { board_id: b.id, location_id: b.location_id, name: b.name, icon: b.icon };
    };
    const savePrefs = (ctx: Ctx, patch: { home_location_id?: string | null; home_board_id?: string | null; auto_apply?: string }) => {
      const u = person(ctx);
      const cur = prefsOf(ctx);
      const next = { home_location_id: cur?.home_location_id ?? null, home_board_id: cur?.home_board_id ?? null, auto_apply: cur?.auto_apply ?? 'layout', ...patch };
      db.run(
        'INSERT INTO board_prefs (user_id, home_location_id, home_board_id, auto_apply, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET home_location_id = excluded.home_location_id, home_board_id = excluded.home_board_id, auto_apply = excluded.auto_apply, updated_at = excluded.updated_at',
        u.id,
        next.home_location_id,
        next.home_board_id,
        next.auto_apply,
        now(),
      );
    };
    router.get('/api/boards/home', 'location', (ctx) => ({ home: homeOut(ctx), auto_apply: prefsOf(ctx)?.auto_apply ?? 'layout' }));
    router.put('/api/boards/home', 'location', (ctx) => {
      person(ctx);
      if (ctx.body?.board_id === null || ctx.body?.board_id === '') {
        savePrefs(ctx, { home_location_id: null, home_board_id: null });
        return { home: null };
      }
      const { board } = loadBoard(app, ctx, String(ctx.body?.board_id ?? ''));
      savePrefs(ctx, { home_location_id: board.location_id, home_board_id: board.id });
      return { home: homeOut(ctx) };
    });
    router.get('/api/boards/prefs', 'location', (ctx) => {
      person(ctx);
      return { auto_apply: prefsOf(ctx)?.auto_apply ?? 'layout', home: homeOut(ctx) };
    });
    router.put('/api/boards/prefs', 'location', (ctx) => {
      person(ctx);
      const v = String(ctx.body?.auto_apply ?? '');
      if (!['off', 'layout'].includes(v)) throw bad('auto_apply: off oder layout');
      savePrefs(ctx, { auto_apply: v });
      return { auto_apply: v };
    });

    // --- boards --------------------------------------------------------------------------------------------------------------
    router.get('/api/boards', 'location', (ctx) => {
      const all = ctx.query.get('all') === '1' && ctx.user?.role === 'admin';
      const home = homeId(ctx);
      const boards = visibleBoards(app, ctx, { all }).map(({ board, access }) => boardOut(app, ctx, board, access, { home: home === board.id, viewers: hub.viewers(board.id) }));
      return { boards, home: ctx.user ? homeOut(ctx) : null, auto_apply: ctx.user ? (prefsOf(ctx)?.auto_apply ?? 'layout') : 'off', limits: { boards: LIMITS.boardsPerLocation, personal: LIMITS.personalPerUser } };
    });

    /** What a new board starts from: nothing, a starter, a saved template of the sub-account / the Marktplatz, or a copy of a board. */
    const startFor = (ctx: Ctx, b: Record<string, any>, name: string): { state: BoardState; template: string; summary: string } => {
      const blank: BoardState = { name, icon: cleanIcon(b.icon), accent: cleanAccent(b.accent) ?? '', spec: emptySpec() };
      if (b.copy_of) {
        const { board } = loadBoard(app, ctx, String(b.copy_of));
        const st = stateOf(board);
        const r = stateFromTemplate({ name, icon: st.icon, accent: st.accent, widgets: st.spec.widgets.map((w) => ({ type: w.type, title: w.title, config: w.config, x: w.layout.lg.x, y: w.layout.lg.y, w: w.layout.lg.w, h: w.layout.lg.h })) }, { ...env(ctx.locationId), strict: false });
        if (r.errors.length) throw bad(r.errors[0]);
        return { state: r.state, template: '', summary: `Kopie von „${board.name}“` };
      }
      const key = String(b.template ?? '');
      if (!key) return { state: blank, template: '', summary: 'Board angelegt' };
      const starter = starterByKey(key);
      const saved = starter ? undefined : db.get<{ id: string; name: string; icon: string; accent: string; widgets: string; scope: string; location_id: string }>('SELECT id, name, icon, accent, widgets, scope, location_id FROM board_templates WHERE id = ?', key);
      if (!starter && !saved) throw notFound('Vorlage nicht gefunden');
      // A saved template belongs to its sub-account; only marketplace templates travel (and those need the consent route).
      if (saved && saved.location_id !== ctx.locationId) throw notFound('Vorlage nicht gefunden');
      const src = starter ?? { name: saved!.name, icon: saved!.icon, accent: saved!.accent, widgets: JSON.parse(saved!.widgets) };
      const r = stateFromTemplate({ name, icon: src.icon, accent: src.accent, widgets: src.widgets }, { ...env(ctx.locationId), strict: false });
      if (r.errors.length) throw bad(`Die Vorlage lässt sich hier nicht anlegen: ${r.errors[0]}`);
      return { state: r.state, template: key, summary: `Aus Vorlage „${src.name}“ angelegt` };
    };
    app.services.boardsStart = startFor;

    router.post('/api/boards', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const scope = b.scope === 'shared' ? 'shared' : 'personal';
      if (ctx.viaApiKey && !ctx.user && scope === 'personal') throw bad('Mit einem Schlüssel lassen sich nur geteilte Boards anlegen (scope: shared)');
      const starter = b.template ? starterByKey(String(b.template)) : undefined;
      const name = cleanLine(str(b.name, 'Name', { max: LIMITS.name * 2 }), LIMITS.name) || starter?.name || 'Neues Board';
      const total = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM boards WHERE location_id = ?', ctx.locationId)!.n;
      if (total >= LIMITS.boardsPerLocation) throw bad(`Ein Sub-Account hat höchstens ${LIMITS.boardsPerLocation} Boards`);
      if (ctx.user) {
        const mine = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM boards WHERE location_id = ? AND owner_id = ? AND scope = 'personal'", ctx.locationId, ctx.user.id)!.n;
        if (scope === 'personal' && mine >= LIMITS.personalPerUser) throw bad(`Du kannst höchstens ${LIMITS.personalPerUser} persönliche Boards haben`);
      }
      const start = startFor(ctx, b, name);
      const { board } = createBoard(app, ctx, { name, scope, team_access: b.team_access === 'edit' ? 'edit' : 'view', state: { ...start.state, name }, template_key: start.template, kind: start.template ? 'template' : 'create', summary: start.summary });
      return full(ctx, board, 'owner');
    });

    router.get('/api/boards/:id', 'location', (ctx) => {
      const { board, access } = loadBoard(app, ctx, ctx.params.id);
      return full(ctx, board, access);
    });

    router.patch('/api/boards/:id', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const { board, access } = loadBoard(app, ctx, ctx.params.id, 'edit');
      let cur = board;
      // Name, symbol and accent are part of the board's state (a version with undo) …
      const ops: Record<string, unknown>[] = [];
      if (b.name !== undefined || b.icon !== undefined) ops.push({ op: 'rename', ...(b.name !== undefined ? { name: b.name } : {}), ...(b.icon !== undefined ? { icon: b.icon } : {}) });
      if (b.accent !== undefined) ops.push({ op: 'theme', accent: b.accent });
      if (ops.length) {
        const r = apply(ctx, cur, ops, { strict: true, clientId: String(b.client_id ?? '') });
        if (!r.result.ok) throw bad(r.result.errors.join(' · '));
        if (r.saved) cur = r.saved.board;
      }
      // … who may see and change it is not.
      if (b.scope !== undefined || b.team_access !== undefined) {
        if (access !== 'owner') throw new HttpError(403, 'Nur die Besitzerin bzw. der Besitzer des Boards (oder die Agentur) darf das');
        if (b.scope !== undefined && !['personal', 'shared'].includes(b.scope)) throw bad('scope: personal oder shared');
        if (b.team_access !== undefined && !['view', 'edit'].includes(b.team_access)) throw bad('team_access: view oder edit');
        const scope = b.scope ?? cur.scope;
        const teamAccess = b.team_access ?? cur.team_access;
        db.run('UPDATE boards SET scope = ?, team_access = ?, updated_at = ? WHERE id = ? AND location_id = ?', scope, teamAccess, now(), cur.id, cur.location_id);
        cur = { ...cur, scope, team_access: teamAccess };
        // People who may no longer see it are cut off; the others learn the new rules.
        if (scope === 'personal') hub.publish(cur.id, 'access', { board_id: cur.id }, (s) => s.userId !== cur.owner_id && userRow(s.userId)?.role !== 'admin');
        hub.sweep();
        hub.publish(cur.id, 'access', { board_id: cur.id });
      }
      return full(ctx, cur, access);
    });

    router.delete('/api/boards/:id', 'location', (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id, 'owner');
      db.run('UPDATE board_prefs SET home_board_id = NULL, home_location_id = NULL WHERE home_board_id = ?', board.id);
      deleteBoard(app, board);
      hub.closeBoard(board.id);
      return { ok: true };
    });

    router.post('/api/boards/:id/duplicate', 'location', (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id);
      const name = cleanLine(str(ctx.body?.name, 'Name', { max: 200 }), LIMITS.name) || `${board.name} (Kopie)`.slice(0, LIMITS.name);
      const total = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM boards WHERE location_id = ?', ctx.locationId)!.n;
      if (total >= LIMITS.boardsPerLocation) throw bad(`Ein Sub-Account hat höchstens ${LIMITS.boardsPerLocation} Boards`);
      const scope = ctx.body?.scope === 'shared' ? 'shared' : 'personal';
      if (!ctx.user && scope === 'personal') throw bad('Mit einem Schlüssel lassen sich nur geteilte Boards anlegen (scope: shared)');
      const start = startFor(ctx, { copy_of: board.id }, name);
      const made = createBoard(app, ctx, { name, scope, team_access: 'view', state: { ...start.state, name }, kind: 'create', summary: start.summary });
      return full(ctx, made.board, 'owner');
    });

    // --- changing a board: one patch format for the editor, the agent, MCP and the API --------------------------------------------
    router.post('/api/boards/:id/patch', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const { board, access } = loadBoard(app, ctx, ctx.params.id, b.dry_run ? 'view' : 'edit');
      const expected = b.expected_version === undefined || b.expected_version === null ? undefined : Number(b.expected_version);
      if (expected !== undefined && !Number.isInteger(expected)) throw bad('expected_version muss eine ganze Zahl sein');
      // Whatever touches the outside (an embedded address, buttons that start things) is never changed by an agent, MCP or key
      // on its own: the caller has to say the person has confirmed it (confirm_external) – a second line behind the agent's cards.
      const veto = !b.dry_run && actorOf(app, ctx).via !== 'session' && b.confirm_external !== true;
      const r = apply(ctx, board, b.ops, { dryRun: !!b.dry_run || veto, expectedVersion: expected, strict: typeof b.strict === 'boolean' ? b.strict : undefined, summary: b.summary ? cleanLine(b.summary, 300) : undefined, clientId: String(b.client_id ?? '') });
      const res = r.result;
      if (veto && res.ok && res.risk === 'high') throw new HttpError(409, 'Dieses Update bettet eine Adresse ein oder legt Schnellaktions-Knöpfe an. Bitte frage die Person und bestätige das mit confirm_external: true.');
      if (veto && res.ok) {
        // not risky after all: apply for real
        const again = apply(ctx, board, b.ops, { expectedVersion: expected, strict: typeof b.strict === 'boolean' ? b.strict : undefined, summary: b.summary ? cleanLine(b.summary, 300) : undefined, clientId: String(b.client_id ?? '') });
        const current = again.saved?.board ?? board;
        return { ok: true, unchanged: !again.saved, version: current.head, changes: again.result.changes, summary: again.result.summary, risk: again.result.risk, created: again.result.created, board: full(ctx, current, access) };
      }
      if (b.dry_run) return { ok: res.ok, errors: res.errors, changes: res.changes, summary: res.summary, risk: res.risk, version: board.head };
      if (!res.ok) throw bad(res.errors.join(' · '));
      const current = r.saved?.board ?? board;
      return { ok: true, unchanged: !r.saved, version: current.head, changes: res.changes, summary: res.summary, risk: res.risk, created: res.created, board: full(ctx, current, access) };
    });

    /** The same check without saving – a pure read, so the agent may run it without a confirmation. */
    router.post('/api/boards/:id/preview', 'location', (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id);
      ctx.skipAfterWrite = true;
      const r = apply(ctx, board, ctx.body?.ops, { dryRun: true, strict: typeof ctx.body?.strict === 'boolean' ? ctx.body.strict : undefined });
      const res = r.result;
      return { ok: res.ok, errors: res.errors, changes: res.changes, summary: res.summary, risk: res.risk, version: board.head };
    });

    router.post('/api/boards/:id/undo', 'location', (ctx) => {
      const { board, access } = loadBoard(app, ctx, ctx.params.id, 'edit');
      const r = undoBoard(app, ctx, board);
      publish(r.board, ctx, 'undo', `Rückgängig: ${r.from.summary}`, String(ctx.body?.client_id ?? ''));
      audit(ctx, 'boards.undo', r.board, `Rückgängig: ${r.from.summary}`);
      return full(ctx, r.board, access);
    });
    router.post('/api/boards/:id/redo', 'location', (ctx) => {
      const { board, access } = loadBoard(app, ctx, ctx.params.id, 'edit');
      const r = redoBoard(app, ctx, board);
      publish(r.board, ctx, 'redo', `Wiederhergestellt: ${r.to.summary}`, String(ctx.body?.client_id ?? ''));
      audit(ctx, 'boards.redo', r.board, `Wiederhergestellt: ${r.to.summary}`);
      return full(ctx, r.board, access);
    });

    /** Tablet or phone back to the arrangement derived from the desktop one (they were arranged by hand until now). */
    router.post('/api/boards/:id/reset-layout', 'location', (ctx) => {
      const { board, access } = loadBoard(app, ctx, ctx.params.id, 'edit');
      const want = ctx.body?.bp;
      if (want !== 'md' && want !== 'sm') throw bad('bp: md oder sm');
      const bp: 'md' | 'sm' = want;
      const st = stateOf(board);
      if (!st.spec.custom?.[bp]) return full(ctx, board, access);
      const custom = { ...st.spec.custom };
      delete custom[bp];
      const widgets = st.spec.widgets.map((w) => {
        const layout = { ...w.layout };
        delete layout[bp];
        return { ...w, layout };
      });
      const spec = normalizeSpec({ ...st.spec, widgets, ...(Object.keys(custom).length ? { custom } : { custom: undefined }) }, (t) => reg.limits(t));
      const summary = `Anordnung für ${bp === 'md' ? 'Tablet' : 'Handy'} zurückgesetzt`;
      const saved = saveState(app, ctx, board, { ...st, spec }, { kind: kindOf(ctx), summary, ops: [] });
      publish(saved.board, ctx, saved.version.kind, summary, String(ctx.body?.client_id ?? ''));
      audit(ctx, 'boards.patch', saved.board, summary);
      return full(ctx, saved.board, access);
    });

    router.get('/api/boards/:id/versions', 'location', (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id);
      return { versions: listVersions(app, board, Number(ctx.query.get('limit')) || 100), head: board.head, can_undo: canUndo(app, board), can_redo: canRedo(board) };
    });
    router.get('/api/boards/:id/versions/:n', 'location', (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id);
      const v = versionRow(app, board.id, Number(ctx.params.n));
      if (!v) throw notFound('Version nicht gefunden');
      const st = JSON.parse(v.state) as BoardState;
      return { version: versionOut(v, board.head), state: { name: st.name, icon: st.icon, accent: st.accent, spec: parseSpec(st.spec) }, ops: JSON.parse(v.ops || '[]') };
    });
    router.post('/api/boards/:id/versions/:n/restore', 'location', (ctx) => {
      const { board, access } = loadBoard(app, ctx, ctx.params.id, 'edit');
      const saved = restoreVersion(app, ctx, board, Number(ctx.params.n));
      publish(saved.board, ctx, 'restore', saved.version.summary, String(ctx.body?.client_id ?? ''));
      audit(ctx, 'boards.restore', saved.board, saved.version.summary);
      return full(ctx, saved.board, access);
    });

    // --- what the widgets show, for the person asking ---------------------------------------------------------------------------
    router.get('/api/boards/:id/data', 'location', async (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id);
      const ids = String(ctx.query.get('ids') ?? '').split(',').filter(Boolean).slice(0, LIMITS.widgets);
      ctx.skipAfterWrite = true;
      return { data: await boardData(app, ctx, parseSpec(board.spec), reg, ids.length ? ids : undefined), version: board.head, at: now() };
    });

    // --- live: Server-Sent Events, like the Team-Chat ------------------------------------------------------------------------------
    router.get('/api/boards/:id/stream', 'location', (ctx): RawResult => {
      const u = person(ctx);
      const { board } = loadBoard(app, ctx, ctx.params.id);
      const clientId = String(ctx.query.get('clientId') ?? '');
      if (!/^[A-Za-z0-9_-]{6,64}$/.test(clientId)) throw bad('clientId fehlt');
      const stream = hub.subscribe({ clientId, boardId: board.id, locationId: ctx.locationId, userId: u.id, name: u.name, alive: loginOf(app, ctx) });
      // not a 200 stream that ends at once: the browser's EventSource gives up instead of retrying every few seconds
      if (!stream) throw new HttpError(503, 'Zu viele Live-Verbindungen – bitte später noch einmal');
      return { __raw: true, status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' }, body: stream };
    });

    // Boards go with their sub-account; open streams of a deleted sub-account end with the next check.
    app.onTick(() => hub.sweep());
    // A stream ends with the login it was opened with: at once when signing out or revoking, an expired session at the next check.
    sweepOnLoginChange(app, hub);
  },
};
