/**
 * Canvas storage and the operation log: boards, elements (one row per element with a version),
 * access rules, operations (add / update / delete with last-writer-wins per element), snapshots and
 * placement helpers for agents. Used by the canvas modules (REST, integrations, public link, mobile).
 *
 * Concurrency model (see docs/canvas.md): every accepted change bumps the element's `version` and the
 * board's `seq`. Updates are merged field by field onto the current element, so two people changing
 * different properties of the same shape both win; for the same property the last write wins.
 * A client may send `baseVersion` – an older one is reported as `conflict` (applied anyway), or
 * refused with `strict: true` (compare-and-set). Deletions leave a tombstone so late updates do not
 * bring an element back; `add` with the same id restores it (undo).
 */

import type { App } from '../core/app.js';
import { HttpError, bad, notFound, type Ctx } from '../core/http.js';
import { id, now, sha256 } from '../core/util.js';
import { type Box, type CanvasElement, LIMITS, SceneError, createElement, elementBox, isId, sortByZ, unionBox, updateElement } from './canvas-model.js';
import { type CanvasHub, colorFor } from './canvas-hub.js';
import { type GraphSpec, type LayoutKind, type Direction, buildGraph, graphOfElements, layoutGraph } from './canvas-layout.js';

export interface BoardRow {
  id: string;
  location_id: string;
  name: string;
  description: string;
  team_access: 'edit' | 'view' | 'none';
  owner_id: string | null;
  owner_name: string;
  settings: string;
  seq: number;
  element_count: number;
  last_snapshot_at: string | null;
  created_at: string;
  updated_at: string;
  updated_by: string;
}

export type Access = 'owner' | 'edit' | 'view';
const RANK: Record<Access, number> = { view: 1, edit: 2, owner: 3 };

export interface Actor {
  id: string | null;
  name: string;
  kind: 'user' | 'agent';
}

const AGENT_VIA = new Set(['mcp', 'api_key', 'agency_key', 'agent']);

/** Who is acting: a person, or an agent/key (named after the key or the agent). */
export function actorOf(app: App, ctx: Ctx): Actor {
  const via = String(ctx.via ?? '');
  if (AGENT_VIA.has(via) || (!ctx.user && ctx.viaApiKey)) {
    if (ctx.user) return { id: ctx.user.id, name: ctx.user.name, kind: 'agent' };
    const bearer = String(ctx.req.headers.authorization ?? '').match(/^Bearer\s+(.+)$/i)?.[1];
    const key = bearer ? app.db.get<{ name: string }>('SELECT name FROM api_keys WHERE key_hash = ?', sha256(bearer)) : undefined;
    return { id: null, name: key ? `API: ${key.name}` : 'KI-App', kind: 'agent' };
  }
  return { id: ctx.user?.id ?? null, name: ctx.user?.name ?? 'Unbekannt', kind: 'user' };
}

/**
 * Access to a board. Keys and MCP connections of the sub-account act for the whole sub-account
 * (like every other API), agency admins own every board; members get the board's team access
 * and/or their personal role.
 */
export function accessOf(app: App, ctx: Ctx, b: BoardRow): Access | null {
  const u = ctx.user;
  if (!u) return ctx.viaApiKey ? 'edit' : null;
  if (u.role === 'admin') return 'owner';
  if (b.owner_id && b.owner_id === u.id) return 'owner';
  let best: Access | null = b.team_access === 'edit' ? 'edit' : b.team_access === 'view' ? 'view' : null;
  const m = app.db.get<{ role: string }>('SELECT role FROM canvas_members WHERE board_id = ? AND user_id = ?', b.id, u.id);
  if (m && (m.role === 'edit' || m.role === 'view') && (!best || RANK[m.role as Access] > RANK[best])) best = m.role as Access;
  return best;
}

/** The board if the caller may use it at the needed level (404 without any access – never a hint that it exists). */
export function loadBoard(app: App, ctx: Ctx, boardId: string, need: Access = 'view'): { board: BoardRow; access: Access } {
  const b = app.db.get<BoardRow>('SELECT * FROM canvas_boards WHERE id = ? AND location_id = ?', boardId, ctx.locationId);
  const access = b ? accessOf(app, ctx, b) : null;
  if (!b || !access) throw notFound('Board nicht gefunden');
  if (RANK[access] < RANK[need]) throw new HttpError(403, need === 'owner' ? 'Nur die Besitzerin/der Besitzer des Boards (oder die Agentur) darf das' : 'Nur Lesezugriff auf dieses Board');
  if (need !== 'view' && ctx.scope === 'read') throw new HttpError(403, 'Diese Verbindung darf nur lesen');
  return { board: b, access };
}

/** Elements of a board (without tombstones), in paint order. */
export function boardElements(app: App, boardId: string): CanvasElement[] {
  const rows = app.db.all<{ data: string; version: number; z: number }>('SELECT data, version, z FROM canvas_elements WHERE board_id = ? AND deleted = 0', boardId);
  return sortByZ(rows.map((r) => ({ ...(JSON.parse(r.data) as CanvasElement), version: r.version, z: r.z })));
}

export interface OpIn {
  op: 'add' | 'update' | 'delete';
  id?: string;
  element?: Record<string, any>;
  props?: Record<string, any>;
  baseVersion?: number;
}
export interface OpResult {
  id: string;
  status: 'ok' | 'conflict' | 'rejected' | 'missing' | 'deleted' | 'locked' | 'error';
  version?: number;
  error?: string;
}
export interface ApplyResult {
  seq: number;
  results: OpResult[];
  elements: CanvasElement[];
  deleted: string[];
}

const ELEMENT_BYTES = 256 * 1024;

/** Applies a batch of operations in one transaction and tells everyone watching. */
export function applyOps(app: App, ctx: Ctx, board: BoardRow, ops: OpIn[], o: { clientId?: string; strict?: boolean; force?: boolean } = {}): ApplyResult {
  if (!Array.isArray(ops)) throw bad('ops: Liste erwartet');
  if (ops.length > LIMITS.opsPerRequest) throw bad(`Höchstens ${LIMITS.opsPerRequest} Änderungen je Anfrage`);
  const actor = actorOf(app, ctx);
  const base = app.baseUrl();
  const at = now();
  const out = app.db.tx(() => {
    const cur = app.db.get<BoardRow>('SELECT * FROM canvas_boards WHERE id = ?', board.id)!;
    const seq = cur.seq + 1;
    let count = cur.element_count;
    let maxZ = Number(app.db.get<{ z: number }>('SELECT MAX(z) AS z FROM canvas_elements WHERE board_id = ? AND deleted = 0', board.id)?.z ?? 0);
    const results: OpResult[] = [];
    const changed = new Map<string, CanvasElement>();
    const deleted = new Set<string>();
    const row = (eid: string) => app.db.get<{ data: string; version: number; z: number; deleted: number }>('SELECT data, version, z, deleted FROM canvas_elements WHERE board_id = ? AND id = ?', board.id, eid);
    const save = (el: CanvasElement, version: number, isNew: boolean) => {
      const { version: _v, ...data } = el;
      const json = JSON.stringify(data);
      if (json.length > ELEMENT_BYTES) throw new SceneError('Element zu groß (max. 256 KB)');
      if (isNew) app.db.run('INSERT INTO canvas_elements (board_id, id, data, version, seq, z, deleted, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)', board.id, el.id, json, version, seq, el.z ?? 0, at, actor.name.slice(0, 200));
      else app.db.run('UPDATE canvas_elements SET data = ?, version = ?, seq = ?, z = ?, deleted = 0, updated_at = ?, updated_by = ? WHERE board_id = ? AND id = ?', json, version, seq, el.z ?? 0, at, actor.name.slice(0, 200), board.id, el.id);
      changed.set(el.id, { ...el, version });
      deleted.delete(el.id);
    };
    const remove = (eid: string, r: { version: number; data: string }) => {
      app.db.run('UPDATE canvas_elements SET deleted = 1, version = ?, seq = ?, updated_at = ?, updated_by = ? WHERE board_id = ? AND id = ?', r.version + 1, seq, at, actor.name.slice(0, 200), board.id, eid);
      changed.delete(eid);
      deleted.add(eid);
      count--;
    };
    for (const op of ops) {
      const eid = String(op?.id ?? op?.element?.id ?? '');
      try {
        if (op?.op === 'add') {
          const existing = isId(eid) ? row(eid) : undefined;
          const el = createElement({ ...(op.element ?? {}), ...(isId(eid) ? { id: eid } : {}) }, () => id(12), { base });
          if (existing && !existing.deleted) {
            if (o.strict && op.baseVersion !== undefined && op.baseVersion !== existing.version) {
              results.push({ id: el.id, status: 'rejected', version: existing.version });
              continue;
            }
            if (el.z === undefined || op.element?.z === undefined) el.z = existing.z;
            save(el, existing.version + 1, false);
            results.push({ id: el.id, status: op.baseVersion !== undefined && op.baseVersion !== existing.version ? 'conflict' : 'ok', version: existing.version + 1 });
            continue;
          }
          if (count >= LIMITS.elements) throw new SceneError(`Ein Board hat höchstens ${LIMITS.elements} Elemente`);
          if (op.element?.z === undefined) el.z = ++maxZ;
          else maxZ = Math.max(maxZ, el.z ?? 0);
          save(el, existing ? existing.version + 1 : 1, !existing);
          count++;
          results.push({ id: el.id, status: 'ok', version: existing ? existing.version + 1 : 1 });
        } else if (op?.op === 'update') {
          const r = isId(eid) ? row(eid) : undefined;
          if (!r) {
            results.push({ id: eid, status: 'missing' });
            continue;
          }
          if (r.deleted) {
            results.push({ id: eid, status: 'deleted', version: r.version });
            continue;
          }
          if (o.strict && op.baseVersion !== undefined && op.baseVersion !== r.version) {
            results.push({ id: eid, status: 'rejected', version: r.version });
            continue;
          }
          const curEl = { ...(JSON.parse(r.data) as CanvasElement), z: r.z };
          const props = op.props ?? {};
          // locked elements only change their lock/visibility/name unless the caller insists
          if (curEl.locked && !o.force && props.locked !== false && Object.keys(props).some((k) => !['locked', 'hidden', 'name', 'z'].includes(k))) {
            results.push({ id: eid, status: 'locked', version: r.version });
            continue;
          }
          const next = updateElement(curEl, props, { base });
          save(next, r.version + 1, false);
          results.push({ id: eid, status: op.baseVersion !== undefined && op.baseVersion !== r.version ? 'conflict' : 'ok', version: r.version + 1 });
        } else if (op?.op === 'delete') {
          const r = isId(eid) ? row(eid) : undefined;
          if (!r || r.deleted) {
            results.push({ id: eid, status: r ? 'deleted' : 'missing', version: r?.version });
            continue;
          }
          const el = JSON.parse(r.data) as CanvasElement;
          remove(eid, r);
          // a frame takes its contents with it
          if (el.type === 'frame') {
            for (const child of app.db.all<{ id: string; data: string; version: number }>('SELECT id, data, version FROM canvas_elements WHERE board_id = ? AND deleted = 0', board.id)) {
              if ((JSON.parse(child.data) as CanvasElement).frameId === eid) remove(child.id, child);
            }
          }
          results.push({ id: eid, status: 'ok', version: r.version + 1 });
        } else results.push({ id: eid, status: 'error', error: 'op: add, update oder delete' });
      } catch (e) {
        if (e instanceof SceneError || e instanceof HttpError) results.push({ id: eid, status: 'error', error: e.message });
        else throw e;
      }
    }
    if (changed.size || deleted.size) {
      app.db.run('UPDATE canvas_boards SET seq = ?, element_count = ?, updated_at = ?, updated_by = ? WHERE id = ?', seq, Math.max(0, count), at, actor.name.slice(0, 200), board.id);
      return { seq, results, elements: [...changed.values()], deleted: [...deleted] };
    }
    return { seq: cur.seq, results, elements: [], deleted: [] };
  });
  if (out.elements.length || out.deleted.length) {
    const hub: CanvasHub | undefined = app.services.canvasHub;
    hub?.publish(board.id, 'ops', { seq: out.seq, clientId: o.clientId ?? null, actor: { name: actor.name, kind: actor.kind }, elements: out.elements, deleted: out.deleted }, o.clientId);
    if (actor.kind === 'agent' && hub) {
      // the agent's cursor shows where it just worked
      const box = unionBox(out.elements.map(elementBox));
      if (box) hub.touch(board.id, { clientId: `agent:${sha256(actor.name).slice(0, 12)}`, name: actor.name, color: '#7048e8', kind: 'agent', x: box.x + box.w, y: box.y + box.h, sel: out.elements.slice(0, 50).map((e) => e.id), at: Date.now() });
    }
    maybeAutoSnapshot(app, board.id, actor);
  }
  return out;
}

// --- snapshots -------------------------------------------------------------------------------------

export const AUTO_SNAPSHOT_MS = 30 * 60_000;
const KEEP_AUTO = 30;

export function createSnapshot(app: App, boardId: string, name: string, auto: boolean, actor: Actor): { id: string; element_count: number } {
  const b = app.db.get<BoardRow>('SELECT * FROM canvas_boards WHERE id = ?', boardId)!;
  const els = boardElements(app, boardId);
  const row = { id: id(), board_id: boardId, location_id: b.location_id, name: name.slice(0, 200), elements: JSON.stringify(els), element_count: els.length, seq: b.seq, auto: auto ? 1 : 0, created_by: actor.name.slice(0, 200), created_at: now() };
  app.db.insert('canvas_snapshots', row);
  app.db.run('UPDATE canvas_boards SET last_snapshot_at = ? WHERE id = ?', row.created_at, boardId);
  if (auto) app.db.run(`DELETE FROM canvas_snapshots WHERE board_id = ? AND auto = 1 AND id NOT IN (SELECT id FROM canvas_snapshots WHERE board_id = ? AND auto = 1 ORDER BY created_at DESC LIMIT ${KEEP_AUTO})`, boardId, boardId);
  return { id: row.id, element_count: row.element_count };
}

function maybeAutoSnapshot(app: App, boardId: string, actor: Actor) {
  const b = app.db.get<BoardRow>('SELECT last_snapshot_at, element_count FROM canvas_boards WHERE id = ?', boardId);
  if (!b || !b.element_count) return;
  if (b.last_snapshot_at && Date.now() - Date.parse(b.last_snapshot_at) < AUTO_SNAPSHOT_MS) return;
  createSnapshot(app, boardId, 'Automatisch gesichert', true, actor);
}

/** Replaces the board's content with a snapshot (as one batch: tombstones + restored elements). */
export function restoreSnapshot(app: App, ctx: Ctx, board: BoardRow, snapshotId: string, clientId?: string): ApplyResult {
  const snap = app.db.get<{ elements: string; name: string }>('SELECT elements, name FROM canvas_snapshots WHERE id = ? AND board_id = ?', snapshotId, board.id);
  if (!snap) throw notFound('Version nicht gefunden');
  const actor = actorOf(app, ctx);
  createSnapshot(app, board.id, `Vor Wiederherstellung von „${snap.name}“`, false, actor);
  const want = JSON.parse(snap.elements) as CanvasElement[];
  const keep = new Set(want.map((e) => e.id));
  const ops: OpIn[] = [
    ...boardElements(app, board.id).filter((e) => !keep.has(e.id)).map((e): OpIn => ({ op: 'delete', id: e.id })),
    ...want.map((e): OpIn => ({ op: 'add', id: e.id, element: e })),
  ];
  const r = applyOps(app, ctx, board, ops, { clientId, force: true });
  (app.services.canvasHub as CanvasHub | undefined)?.publish(board.id, 'reload', { seq: r.seq, reason: 'restore', actor: actor.name });
  return r;
}

// --- placement helpers (agents) ------------------------------------------------------------------------

/** A free spot to the right of everything on the board (or at the origin of an empty board). */
export function freeSpot(els: CanvasElement[], gap = 160): { x: number; y: number } {
  const box = unionBox(els.filter((e) => !e.hidden).map(elementBox));
  if (!box) return { x: 0, y: 0 };
  return { x: Math.round(box.x + box.w + gap), y: Math.round(box.y) };
}

export interface AddInput {
  elements: Record<string, any>[];
  /** Arrange the new shapes + arrows automatically. */
  layout?: { kind: LayoutKind; direction?: Direction; gap?: number };
  /** Top-left for elements without a position: {x,y} or "auto" (free spot right of the content). */
  origin?: { x: number; y: number };
}

/**
 * Turns agent-friendly input into create operations:
 * - `ref`: a handle for the new element that later entries can use instead of an id
 * - `at`: {right_of|left_of|below|above: ref/id, gap?} – placed next to another element
 * - `in`: ref/id of a frame – placed inside it (next free row) and attached to it
 * - arrows/lines with `from`/`to` (ref/id) – bound at both ends
 * - no position at all: a tidy row (or the given `layout`) at a free spot
 */
export function planAdd(existing: CanvasElement[], input: AddInput, newId: () => string): { ops: OpIn[]; refs: Record<string, string> } {
  const list = (Array.isArray(input.elements) ? input.elements : []).slice(0, LIMITS.opsPerRequest);
  if (!list.length) throw bad('elements: mindestens ein Element');
  const refs: Record<string, string> = {};
  const byId = new Map(existing.map((e) => [e.id, e]));
  // ids first, so references work in any order
  const drafts = list.map((raw) => {
    const elId = isId(raw?.id) ? raw.id : newId();
    if (typeof raw?.ref === 'string' && raw.ref) refs[raw.ref.slice(0, 60)] = elId;
    return { raw: raw ?? {}, id: elId };
  });
  const resolve = (v: unknown): string | undefined => {
    if (typeof v !== 'string') return undefined;
    return refs[v] ?? (byId.has(v) || drafts.some((d) => d.id === v) ? v : undefined);
  };
  const made = new Map<string, CanvasElement>();
  const origin = input.origin ?? freeSpot(existing);
  let cursorX = origin.x;
  let rowY = origin.y;
  let rowH = 0;
  const placed: string[] = [];
  const ops: OpIn[] = [];
  const isLine = (t: string) => t === 'arrow' || t === 'line';
  // 1) shapes
  for (const d of drafts) {
    const { ref: _r, at, in: inFrame, from: _f, to: _t, ...rest } = d.raw;
    if (isLine(String(rest.type))) continue;
    const el = createElement({ ...rest, id: d.id }, newId);
    const hasPos = rest.x !== undefined && rest.y !== undefined;
    const frameId = resolve(inFrame);
    const frame = frameId ? (made.get(frameId) ?? byId.get(frameId)) : undefined;
    if (frame && frame.type === 'frame') {
      el.frameId = frame.id;
      if (!hasPos) {
        const kids = [...existing, ...made.values()].filter((e) => e.frameId === frame.id);
        const bottom = kids.length ? Math.max(...kids.map((k) => k.y + k.h)) : frame.y;
        el.x = frame.x + Math.max(16, (frame.w - el.w) / 2);
        el.y = bottom + (kids.length ? 24 : 32);
      }
    } else if (at && typeof at === 'object') {
      const keys = ['right_of', 'left_of', 'below', 'above'] as const;
      const k = keys.find((x) => at[x]);
      const targetId = k ? resolve(at[k]) : undefined;
      const t = targetId ? (made.get(targetId) ?? byId.get(targetId)) : undefined;
      if (!t) throw bad(`at: Element „${String(k ? at[k] : '').slice(0, 40)}“ nicht gefunden`);
      const gap = Number.isFinite(Number(at.gap)) ? Number(at.gap) : 80;
      if (k === 'right_of') (el.x = t.x + t.w + gap), (el.y = t.y + (t.h - el.h) / 2);
      if (k === 'left_of') (el.x = t.x - gap - el.w), (el.y = t.y + (t.h - el.h) / 2);
      if (k === 'below') (el.x = t.x + (t.w - el.w) / 2), (el.y = t.y + t.h + gap);
      if (k === 'above') (el.x = t.x + (t.w - el.w) / 2), (el.y = t.y - gap - el.h);
      if (t.frameId && !el.frameId) el.frameId = t.frameId;
    } else if (!hasPos) {
      // a row that wraps after ~1600 px
      if (cursorX > origin.x && cursorX + el.w > origin.x + 1600) {
        cursorX = origin.x;
        rowY += rowH + 60;
        rowH = 0;
      }
      el.x = cursorX;
      el.y = rowY;
      cursorX += el.w + 60;
      rowH = Math.max(rowH, el.h);
      placed.push(el.id);
    }
    made.set(el.id, el);
  }
  // 2) lines/arrows (bindings resolved)
  for (const d of drafts) {
    const { ref: _r, at: _a, in: _i, from, to, ...rest } = d.raw;
    if (!isLine(String(rest.type))) continue;
    const a = resolve(from ?? rest.start?.id);
    const b = resolve(to ?? rest.end?.id);
    if ((from && !a) || (to && !b)) throw bad(`Pfeil: Element „${String(!a ? from : to).slice(0, 40)}“ nicht gefunden`);
    const A = a ? (made.get(a) ?? byId.get(a)) : undefined;
    const B = b ? (made.get(b) ?? byId.get(b)) : undefined;
    const props: Record<string, any> = { ...rest, id: d.id };
    if (A && B) {
      const ax = A.x + A.w / 2;
      const ay = A.y + A.h / 2;
      props.x = ax;
      props.y = ay;
      props.points = [[0, 0], [B.x + B.w / 2 - ax, B.y + B.h / 2 - ay]];
      props.start = { id: A.id, ...(rest.start?.anchor ? { anchor: rest.start.anchor } : {}) };
      props.end = { id: B.id, ...(rest.end?.anchor ? { anchor: rest.end.anchor } : {}) };
    }
    const el = createElement(props, newId);
    if (el.z === undefined || rest.z === undefined) el.z = -1;
    made.set(el.id, el);
  }
  // 3) optional auto-layout of what was placed without coordinates
  if (input.layout && placed.length > 1) {
    const nodes = placed.map((pid) => made.get(pid)!);
    const g = graphOfElements([...nodes, ...[...made.values()].filter((e) => isLine(e.type))]);
    const pos = layoutGraph(g.nodes, g.edges, { kind: input.layout.kind, direction: input.layout.direction, gap: input.layout.gap });
    for (const n of nodes) if (pos[n.id]) {
      n.x = origin.x + pos[n.id].x;
      n.y = origin.y + pos[n.id].y;
    }
    for (const a of g.arrows) if (a.route === undefined || a.route === 'straight') a.route = input.layout.kind === 'mindmap' || input.layout.kind === 'radial' ? 'curved' : 'elbow';
  }
  for (const el of made.values()) ops.push({ op: 'add', element: el });
  return { ops, refs };
}

/** New elements with their own stacking (templates, graphs) go in front of everything that is there. */
export function liftZ(existing: CanvasElement[], els: CanvasElement[]): CanvasElement[] {
  if (!els.length) return els;
  const top = existing.length ? Math.max(...existing.map((e) => e.z ?? 0)) : 0;
  const low = Math.min(...els.map((e) => e.z ?? 0));
  return els.map((e) => ({ ...e, z: Math.round((top + 1 + (e.z ?? 0) - low) * 1000) / 1000 }));
}

/** Elements of a graph spec (nodes/edges) at a free spot. */
export function graphOps(existing: CanvasElement[], spec: GraphSpec, at?: { x: number; y: number }): { ops: OpIn[]; ids: Record<string, string>; box: Box } {
  const g = buildGraph(spec, () => id(12), at ?? freeSpot(existing));
  return { ops: liftZ(existing, g.elements).map((e) => ({ op: 'add', element: e })), ids: g.ids, box: g.box };
}

/** Updates that move existing elements into an automatic layout (top-left stays where it was). */
export function relayoutOps(existing: CanvasElement[], ids: string[] | undefined, o: { kind: LayoutKind; direction?: Direction; gap?: number }): OpIn[] {
  const want = ids?.length ? new Set(ids) : null;
  const pool = existing.filter((e) => !e.hidden && (!want || want.has(e.id)));
  const g = graphOfElements([...pool.filter((e) => e.type !== 'arrow' && e.type !== 'line' && (want || !e.frameId)), ...existing.filter((e) => e.type === 'arrow' || e.type === 'line')]);
  if (!g.nodes.length) throw bad('Keine Formen zum Anordnen');
  const before = unionBox(g.nodes.map((n) => elementBox(existing.find((e) => e.id === n.id)!)))!;
  const pos = layoutGraph(g.nodes, g.edges, o);
  const ops: OpIn[] = g.nodes.map((n) => ({ op: 'update', id: n.id, props: { x: before.x + pos[n.id].x, y: before.y + pos[n.id].y } }));
  const route = o.kind === 'mindmap' || o.kind === 'radial' ? 'curved' : o.kind === 'grid' ? 'straight' : 'elbow';
  for (const a of g.arrows) ops.push({ op: 'update', id: a.id, props: { route } });
  return ops;
}

export { colorFor };
