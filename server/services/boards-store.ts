/**
 * Living Boards: storage and access. A board row holds its current state; every saved change is also a version row
 * with the whole state after it, the version it came from (`parent_n`) and who made it. The board points at its
 * current version (`head`): undo moves the head back along `parent_n`, redo moves it forward again (the undone versions
 * wait in `redo` until the next change), restore saves an old state as a new version. Nothing here is HTTP – the
 * routes, the agent and MCP all go through these functions, and every query carries the sub-account.
 */

import type { App } from '../core/app.js';
import { HttpError, notFound, type Ctx } from '../core/http.js';
import { id as newId, now, sha256 } from '../core/util.js';
import { LIMITS, parseSpec, type BoardState } from './boards-model.js';

export type Access = 'owner' | 'edit' | 'view';
const RANK: Record<Access, number> = { view: 1, edit: 2, owner: 3 };

export interface BoardRow {
  id: string;
  location_id: string;
  name: string;
  icon: string;
  accent: string;
  scope: 'personal' | 'shared';
  team_access: 'view' | 'edit';
  owner_id: string | null;
  owner_name: string;
  spec: string;
  head: number;
  seq: number;
  redo: string;
  template_key: string;
  created_at: string;
  updated_at: string;
  updated_by: string;
}
export interface VersionRow {
  id: string;
  board_id: string;
  location_id: string;
  n: number;
  parent_n: number | null;
  kind: string;
  summary: string;
  ops: string;
  state: string;
  prompt: string;
  actor_id: string | null;
  actor_name: string;
  via: string;
  created_at: string;
}
export type VersionKind = 'create' | 'edit' | 'agent' | 'api' | 'patch' | 'restore' | 'template';

export const stateOf = (b: BoardRow): BoardState => ({ name: b.name, icon: b.icon, accent: b.accent, spec: parseSpec(b.spec) });

const AGENT_VIA = new Set(['mcp', 'api_key', 'agency_key', 'agent']);
export interface Actor {
  id: string | null;
  name: string;
  /** What kind of caller: a person, the HyperLevel Agent, a key / MCP connection. */
  via: 'session' | 'agent' | 'mcp' | 'api_key' | 'agency_key' | 'app';
}
/** Who is acting: a person, the HyperLevel Agent on behalf of a person, or a key/MCP connection (named after the key). */
export function actorOf(app: App, ctx: Ctx): Actor {
  const via = (String(ctx.via ?? 'session') as Actor['via']) || 'session';
  if (AGENT_VIA.has(via) || (!ctx.user && ctx.viaApiKey)) {
    if (ctx.user) return { id: ctx.user.id.startsWith('key:') ? null : ctx.user.id, name: ctx.user.name, via };
    const bearer = String(ctx.req.headers.authorization ?? '').match(/^Bearer\s+(.+)$/i)?.[1];
    const key = bearer ? app.db.get<{ name: string }>('SELECT name FROM api_keys WHERE key_hash = ?', sha256(bearer)) : undefined;
    return { id: null, name: key ? `API: ${key.name}` : 'KI-App', via: via === 'session' ? 'api_key' : via };
  }
  return { id: ctx.user?.id ?? null, name: ctx.user?.name ?? 'Unbekannt', via };
}

/**
 * What a caller may do with a board: agency admins own every board; the owner owns theirs; everybody else sees
 * shared boards (editing only when the board allows the team to). Personal boards of other people do not exist for
 * them. A sub-account key acts for the whole sub-account: shared boards only.
 */
export function accessOf(ctx: Ctx, b: BoardRow): Access | null {
  const u = ctx.user;
  if (!u) return ctx.viaApiKey && b.scope === 'shared' ? (b.team_access === 'edit' ? 'edit' : 'view') : null;
  if (u.role === 'admin') return 'owner';
  if (b.owner_id && b.owner_id === u.id) return 'owner';
  if (b.scope !== 'shared') return null;
  return b.team_access === 'edit' ? 'edit' : 'view';
}

/** The board if the caller may use it at the needed level – 404 without any access, never a hint that it exists. */
export function loadBoard(app: App, ctx: Ctx, boardId: string, need: Access = 'view'): { board: BoardRow; access: Access } {
  const b = app.db.get<BoardRow>('SELECT * FROM boards WHERE id = ? AND location_id = ?', String(boardId), ctx.locationId);
  const access = b ? accessOf(ctx, b) : null;
  if (!b || !access) throw notFound('Board nicht gefunden');
  if (RANK[access] < RANK[need]) throw new HttpError(403, need === 'owner' ? 'Nur die Besitzerin bzw. der Besitzer des Boards (oder die Agentur) darf das' : 'Dieses Board ist für dich nur lesbar');
  if (need !== 'view' && ctx.scope === 'read') throw new HttpError(403, 'Diese Verbindung darf nur lesen');
  return { board: b, access };
}

/** Boards the caller may open: their own personal ones and the shared ones (agency admins: `all` adds everybody's). */
export function visibleBoards(app: App, ctx: Ctx, opts: { all?: boolean } = {}): { board: BoardRow; access: Access }[] {
  const rows = app.db.all<BoardRow>('SELECT * FROM boards WHERE location_id = ? ORDER BY updated_at DESC LIMIT 500', ctx.locationId);
  const out: { board: BoardRow; access: Access }[] = [];
  for (const b of rows) {
    const access = accessOf(ctx, b);
    if (!access) continue;
    // Agency admins can open any personal board by its link, but lists show their own and the shared ones.
    if (!opts.all && b.scope === 'personal' && b.owner_id !== ctx.user?.id) continue;
    out.push({ board: b, access });
  }
  return out;
}

const redoOf = (b: BoardRow): number[] => {
  try {
    const v = JSON.parse(b.redo || '[]');
    return Array.isArray(v) ? v.filter((x) => Number.isInteger(x)) : [];
  } catch {
    return [];
  }
};

export const versionRow = (app: App, boardId: string, n: number): VersionRow | undefined => app.db.get<VersionRow>('SELECT * FROM board_versions WHERE board_id = ? AND n = ?', boardId, n);

export function canUndo(app: App, b: BoardRow): boolean {
  const cur = versionRow(app, b.id, b.head);
  return !!cur && cur.parent_n !== null && !!versionRow(app, b.id, cur.parent_n);
}
export const canRedo = (b: BoardRow): boolean => redoOf(b).length > 0;

export interface Created {
  board: BoardRow;
  version: VersionRow;
}

export function createBoard(app: App, ctx: Ctx, input: { name: string; scope: 'personal' | 'shared'; team_access: 'view' | 'edit'; state: BoardState; template_key?: string; kind?: VersionKind; summary?: string; ownerId?: string | null }): Created {
  const actor = actorOf(app, ctx);
  const t = now();
  const owner = input.ownerId !== undefined ? input.ownerId : actor.id;
  const board: BoardRow = {
    id: newId(),
    location_id: ctx.locationId,
    name: input.state.name,
    icon: input.state.icon,
    accent: input.state.accent,
    scope: input.scope,
    team_access: input.team_access,
    owner_id: owner,
    owner_name: owner ? (app.db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', owner)?.name ?? actor.name) : actor.name,
    spec: JSON.stringify(input.state.spec),
    head: 1,
    seq: 1,
    redo: '[]',
    template_key: input.template_key ?? '',
    created_at: t,
    updated_at: t,
    updated_by: actor.name.slice(0, 200),
  };
  const version: VersionRow = { id: newId(), board_id: board.id, location_id: board.location_id, n: 1, parent_n: null, kind: input.kind ?? 'create', summary: input.summary ?? 'Board angelegt', ops: '[]', state: JSON.stringify(input.state), prompt: '', actor_id: actor.id, actor_name: actor.name.slice(0, 200), via: actor.via, created_at: t };
  app.db.tx(() => {
    app.db.insert('boards', board);
    app.db.insert('board_versions', version);
  });
  return { board, version };
}

/** Saves a new state as the next version (the board's head moves to it, the redo stack is cleared). */
export function saveState(app: App, ctx: Ctx, board: BoardRow, next: BoardState, meta: { kind: VersionKind; summary: string; ops?: unknown; prompt?: string }): Created {
  const actor = actorOf(app, ctx);
  const t = now();
  const n = board.seq + 1;
  const version: VersionRow = { id: newId(), board_id: board.id, location_id: board.location_id, n, parent_n: board.head, kind: meta.kind, summary: meta.summary.slice(0, 500), ops: JSON.stringify(meta.ops ?? []).slice(0, 60_000), state: JSON.stringify(next), prompt: (meta.prompt ?? '').slice(0, LIMITS.prompt), actor_id: actor.id, actor_name: actor.name.slice(0, 200), via: actor.via, created_at: t };
  const updated: BoardRow = { ...board, name: next.name, icon: next.icon, accent: next.accent, spec: JSON.stringify(next.spec), head: n, seq: n, redo: '[]', updated_at: t, updated_by: actor.name.slice(0, 200) };
  app.db.tx(() => {
    app.db.insert('board_versions', version);
    app.db.run('UPDATE boards SET name = ?, icon = ?, accent = ?, spec = ?, head = ?, seq = ?, redo = ?, updated_at = ?, updated_by = ? WHERE id = ? AND location_id = ?', updated.name, updated.icon, updated.accent, updated.spec, n, n, '[]', t, updated.updated_by, board.id, board.location_id);
    // Old versions go, except the one the board stands on and the ones redo still needs.
    const old = n - LIMITS.versionsPerBoard;
    if (old > 0) app.db.run('DELETE FROM board_versions WHERE board_id = ? AND n <= ? AND n <> ?', board.id, old, n);
  });
  return { board: updated, version };
}

function moveHead(app: App, ctx: Ctx, board: BoardRow, to: VersionRow, redo: number[]): BoardRow {
  const actor = actorOf(app, ctx);
  const state = JSON.parse(to.state) as BoardState;
  const t = now();
  const spec = JSON.stringify(parseSpec(state.spec));
  app.db.run('UPDATE boards SET name = ?, icon = ?, accent = ?, spec = ?, head = ?, redo = ?, updated_at = ?, updated_by = ? WHERE id = ? AND location_id = ?', state.name, state.icon, state.accent, spec, to.n, JSON.stringify(redo), t, actor.name.slice(0, 200), board.id, board.location_id);
  return { ...board, name: state.name, icon: state.icon, accent: state.accent, spec, head: to.n, redo: JSON.stringify(redo), updated_at: t, updated_by: actor.name.slice(0, 200) };
}

/** One step back: the board shows the version it came from. */
export function undoBoard(app: App, ctx: Ctx, board: BoardRow): { board: BoardRow; from: VersionRow; to: VersionRow } {
  const cur = versionRow(app, board.id, board.head);
  const parent = cur?.parent_n != null ? versionRow(app, board.id, cur.parent_n) : undefined;
  if (!cur || !parent) throw new HttpError(409, 'Es gibt nichts mehr rückgängig zu machen');
  const next = app.db.tx(() => moveHead(app, ctx, board, parent, [...redoOf(board), cur.n].slice(-LIMITS.versionsPerBoard)));
  return { board: next, from: cur, to: parent };
}

/** One step forward again (only until the next change). */
export function redoBoard(app: App, ctx: Ctx, board: BoardRow): { board: BoardRow; from: VersionRow; to: VersionRow } {
  const stack = redoOf(board);
  const cur = versionRow(app, board.id, board.head);
  const n = stack[stack.length - 1];
  const target = n !== undefined ? versionRow(app, board.id, n) : undefined;
  if (!cur || !target) throw new HttpError(409, 'Es gibt nichts zum Wiederherstellen');
  const next = app.db.tx(() => moveHead(app, ctx, board, target, stack.slice(0, -1)));
  return { board: next, from: cur, to: target };
}

/** An old state saved as a new version (so the history stays and can itself be undone). */
export function restoreVersion(app: App, ctx: Ctx, board: BoardRow, n: number): Created {
  const v = versionRow(app, board.id, n);
  if (!v) throw notFound('Version nicht gefunden');
  const st = JSON.parse(v.state) as BoardState;
  return saveState(app, ctx, board, { name: st.name, icon: st.icon, accent: st.accent, spec: parseSpec(st.spec) }, { kind: 'restore', summary: `Version ${n} wiederhergestellt` });
}

export interface VersionOut {
  n: number;
  parent_n: number | null;
  kind: string;
  summary: string;
  prompt: string;
  actor: string;
  via: string;
  at: string;
  current: boolean;
  widgets: number;
}
export function versionOut(v: VersionRow, head: number): VersionOut {
  let widgets = 0;
  try {
    widgets = (JSON.parse(v.state).spec?.widgets ?? []).length;
  } catch {
    widgets = 0;
  }
  return { n: v.n, parent_n: v.parent_n, kind: v.kind, summary: v.summary, prompt: v.prompt, actor: v.actor_name, via: v.via, at: v.created_at, current: v.n === head, widgets };
}

export function listVersions(app: App, board: BoardRow, limit = 100): VersionOut[] {
  return app.db.all<VersionRow>('SELECT * FROM board_versions WHERE board_id = ? AND location_id = ? ORDER BY n DESC LIMIT ?', board.id, board.location_id, Math.min(Math.max(1, limit), LIMITS.versionsPerBoard)).map((v) => versionOut(v, board.head));
}

/** The compact thumbnail of a board for lists: the desktop cells with their types. */
function preview(b: BoardRow) {
  const spec = parseSpec(b.spec);
  return spec.widgets.slice(0, 40).map((w) => ({ type: w.type, ...w.layout.lg }));
}

export function boardOut(app: App, ctx: Ctx, b: BoardRow, access: Access, extra: { full?: boolean; home?: boolean; viewers?: { user_id: string | null; name: string }[] } = {}) {
  const spec = extra.full ? parseSpec(b.spec) : undefined;
  const base = {
    id: b.id,
    name: b.name,
    icon: b.icon,
    accent: b.accent,
    scope: b.scope,
    team_access: b.team_access,
    owner_id: b.owner_id,
    owner_name: b.owner_name,
    mine: !!ctx.user && b.owner_id === ctx.user.id,
    access,
    version: b.head,
    template_key: b.template_key,
    created_at: b.created_at,
    updated_at: b.updated_at,
    updated_by: b.updated_by,
    home: !!extra.home,
    viewers: extra.viewers ?? [],
  };
  if (!extra.full) return { ...base, widgets: parseSpec(b.spec).widgets.length, preview: preview(b) };
  return { ...base, widgets: spec!.widgets.length, spec, can_undo: canUndo(app, b), can_redo: canRedo(b) };
}

export function deleteBoard(app: App, board: BoardRow) {
  app.db.run('DELETE FROM boards WHERE id = ? AND location_id = ?', board.id, board.location_id);
}
