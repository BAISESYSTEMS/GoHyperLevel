import type { App } from '../core/app.js';
import type { Row } from '../core/db.js';
import { HttpError, bad, notFound, clampLimit, type Ctx, type Route } from '../core/http.js';
import { id as newId, now, sha256 } from '../core/util.js';
import { TooBig, changedColumns, fingerprint, kidCounts, kidsText, sameValue, type Snapshot } from './undo-core.js';
import { clip, type Fmt, type UndoEntity } from './undo-table.js';

/**
 * The undo journal. Before a tracked write (a guard) it takes a snapshot of the records the request is
 * about to change; after the write succeeded (the after-write hook) it takes a second one and stores both –
 * only if something really changed. "Undo" puts the "before" snapshot back inside one transaction, after
 * checking that nobody changed the record since (otherwise 409 with a diff, and the person decides).
 * An undo is a journal entry itself, so it can be undone again (redo).
 *
 * Modules plug in with `app.services.undo.register(type, entity)` (what a record is, how to put it back) and
 * `app.services.undo.track(rule)` (which route changes which records). Nothing here knows a single table.
 */

export const DEFAULT_RETENTION_DAYS = 30;
export const MAX_TARGETS = 1000;
export const KEEP_CHANGES = 10;

export interface Target {
  entity?: string;
  id: string;
}
export interface TrackRule {
  method: string;
  /** The route pattern as registered, e.g. `/api/tasks/:id`. */
  pattern: string;
  /** Default entity type of the targets. */
  entity: string;
  /** Records the request changes (default: the `:id` of the path). Called before the write, with the parsed body. */
  targets?: (ctx: Ctx) => Target[];
  /** update (default), delete, move, status, bulk, merge, tag … – or decided per record from before/after. */
  action?: string | ((before: Snapshot | null, after: Snapshot | null, ctx: Ctx) => string);
  /** Take deep snapshots (everything a delete takes along). Default: DELETE routes. */
  deep?: boolean | ((ctx: Ctx) => boolean);
  /** Return false for changes that are not worth a journal entry or cannot be undone (e.g. sent invoices). */
  when?: (before: Snapshot | null, after: Snapshot | null, ctx: Ctx) => boolean;
  /** What cannot be taken back – shown with the entry ("E-Mail wurde bereits gesendet – nur der Status wird zurückgesetzt"). */
  notice?: string | ((before: Snapshot | null, after: Snapshot | null, ctx: Ctx) => string | undefined);
  /** Edits of the same person to the same record within this time are one entry (autosaves). */
  coalesceMs?: number;
  /** The route sets `ctx.skipAfterWrite` (autosaves): the entry is stored once the response is out. */
  quiet?: boolean;
  /** Label of the whole request when it changed several records ("12 Kontakte: Tag „x“ hinzugefügt"). */
  groupLabel?: (ctx: Ctx, rows: { entity: string; before: Snapshot | null; after: Snapshot | null; label: string }[]) => string;
}

export interface EntryRow {
  seq: number;
  id: string;
  location_id: string;
  at: string;
  user_id: string | null;
  actor: string;
  actor_kind: string;
  actor_ref: string;
  via: string;
  request_id: string;
  kind: 'change' | 'undo';
  action: string;
  entity: string;
  entity_id: string;
  area: string;
  label: string;
  group_label: string;
  contact_id: string | null;
  snap_before: string | null;
  snap_after: string | null;
  after_fp: string;
  changes: string;
  meta: string;
  deep: number;
  notice: string;
  restorable: number;
  reason: string;
  removes: number;
  reverts_id: string | null;
  undone_at: string | null;
  undone_by: string | null;
}

export interface Principal {
  kind: 'user' | 'app' | 'agent' | 'api_key' | 'agency_key' | 'mcp' | 'system';
  ref: string;
  userId: string | null;
  name: string;
}

interface Pending {
  rule: TrackRule;
  rid: string;
  items: { entity: string; id: string; before: Snapshot | null; tooBig?: boolean }[];
}

const VERBS: Record<string, string> = { update: 'geändert', delete: 'gelöscht', move: 'verschoben', status: 'Status geändert', tag: 'Tags geändert', merge: 'zusammengeführt', bulk: 'geändert' };
const esc = (s: string) => s.replace(/[%_\\]/g, (m) => `\\${m}`);

export function createJournal(app: App) {
  const { db } = app;
  const entities = new Map<string, UndoEntity>();
  const rules = new Map<string, { rule: TrackRule; parts: string[]; literals: number }[]>();
  const pending = new WeakMap<Ctx, Pending>();
  const state = { enabled: true };

  // --- registry ----------------------------------------------------------------------------------------
  const register = (type: string, entity: UndoEntity) => void entities.set(type, entity);
  const track = (rule: TrackRule) => {
    const parts = rule.pattern.split('/').filter(Boolean);
    const list = rules.get(rule.method) ?? [];
    list.push({ rule, parts, literals: parts.filter((p) => !p.startsWith(':')).length });
    // The most specific pattern first: `/api/pm/tasks/bulk` before `/api/pm/tasks/:id`.
    list.sort((a, b) => b.literals - a.literals);
    rules.set(rule.method, list);
  };
  const match = (method: string, path: string): TrackRule | undefined => {
    const list = rules.get(method);
    if (!list) return undefined;
    const parts = path.split('/').filter(Boolean);
    for (const r of list) {
      if (r.parts.length !== parts.length) continue;
      let ok = true;
      for (let i = 0; i < parts.length && ok; i++) if (!r.parts[i].startsWith(':') && r.parts[i] !== parts[i]) ok = false;
      if (ok) return r.rule;
    }
    return undefined;
  };

  // --- who and how long --------------------------------------------------------------------------------------
  const bearerOf = (ctx: Ctx) => String(ctx.req?.headers?.authorization ?? '').match(/^Bearer\s+(.+)$/i)?.[1];
  const principals = new WeakMap<Ctx, Principal>();
  function principal(ctx: Ctx): Principal {
    let p = principals.get(ctx);
    if (!p) principals.set(ctx, (p = principalOf(ctx)));
    return p;
  }
  function principalOf(ctx: Ctx): Principal {
    const via = String(ctx.via ?? '');
    if (via === 'agent') return { kind: 'agent', ref: `u:${ctx.user?.id}`, userId: ctx.user?.id ?? null, name: ctx.user?.name ?? 'KI-Agent' };
    if (via === 'session' || via === 'app') return { kind: via === 'app' ? 'app' : 'user', ref: `u:${ctx.user?.id}`, userId: ctx.user?.id ?? null, name: ctx.user?.name ?? '' };
    // Keys (and MCP, which relays with a key): the key is the principal, never the person who made it.
    const bearer = bearerOf(ctx);
    const hash = bearer ? sha256(bearer) : '';
    const agency = hash ? db.get<{ id: string; name: string }>('SELECT id, name FROM agency_api_keys WHERE key_hash = ?', hash) : undefined;
    const loc = !agency && hash ? db.get<{ id: string; name: string }>('SELECT id, name FROM api_keys WHERE key_hash = ?', hash) : undefined;
    const key = agency ?? loc;
    const kind = via === 'mcp' ? 'mcp' : agency ? 'agency_key' : via === 'api_key' || loc ? 'api_key' : ctx.user ? 'user' : 'system';
    if (key) return { kind, ref: `${agency ? 'ak' : 'k'}:${key.id}`, userId: null, name: ctx.user?.name?.startsWith('API:') ? ctx.user.name : `API-Schlüssel „${key.name}“` };
    if (ctx.user) return { kind: kind === 'system' ? 'user' : kind, ref: `u:${ctx.user.id}`, userId: ctx.user.id, name: ctx.user.name };
    return { kind: 'system', ref: `x:${via || 'system'}`, userId: null, name: ctx.viaApiKey ? 'API-Schlüssel' : 'System' };
  }
  const isAdmin = (ctx: Ctx) => ctx.user?.role === 'admin';

  const retentionDays = (locationId: string): number => {
    const r = db.get<{ retention_days: number }>('SELECT retention_days FROM undo_settings WHERE location_id = ?', locationId);
    return Math.min(Math.max(Math.round(Number(r?.retention_days) || DEFAULT_RETENTION_DAYS), 1), 365);
  };
  const cutoff = (locationId: string, at = Date.now()) => new Date(at - retentionDays(locationId) * 864e5).toISOString();

  /** May this person undo changes in this area (member areas and the SaaS plan, like the routes themselves)? */
  function mayUseArea(ctx: Ctx, area: string): boolean {
    if (!area) return true;
    const u = ctx.user;
    if (!u) return !!ctx.viaApiKey;
    if (u.role === 'admin') return true;
    if (u.permissions && !u.permissions.includes(area)) return false;
    return !app.services.saasAreaBlocked?.(ctx.locationId, area);
  }
  const mine = (ctx: Ctx, e: Pick<EntryRow, 'user_id' | 'actor_ref'>) => {
    const p = principal(ctx);
    return e.actor_ref === p.ref || (!!p.userId && e.user_id === p.userId);
  };
  const may = (ctx: Ctx, e: Pick<EntryRow, 'user_id' | 'actor_ref' | 'area'>) => (isAdmin(ctx) || mine(ctx, e)) && mayUseArea(ctx, e.area);

  // --- formatting of before → after -----------------------------------------------------------------------------
  const tzOf = (locationId: string) => app.location(locationId)?.timezone || 'Europe/Berlin';
  const dateFmt = (iso: string, tz: string, time: boolean) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return new Intl.DateTimeFormat('de-DE', time ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: tz } : { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(d);
  };
  function show(v: unknown, fmt: Fmt | undefined, row: Row, tz: string): string {
    if (typeof fmt === 'function') return clip(fmt(v, row, app), 160);
    if (v === null || v === undefined || v === '') return '–';
    switch (fmt) {
      case 'bool':
        return v === 1 || v === true || v === '1' ? 'ja' : 'nein';
      case 'date':
        return dateFmt(String(v), tz, false);
      case 'datetime':
        return dateFmt(String(v), tz, true);
      case 'money':
        return new Intl.NumberFormat('de-DE', { style: 'currency', currency: String(row.currency || 'EUR') }).format(Number(v) / 100);
      case 'tags':
      case 'json': {
        try {
          const j = typeof v === 'string' ? JSON.parse(v) : v;
          if (Array.isArray(j)) return j.length ? clip(j.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', '), 160) : '–';
          return clip(JSON.stringify(j), 160);
        } catch {
          return clip(v, 160);
        }
      }
      default:
        return clip(v, 160);
    }
  }
  const SKIP_COLS = new Set(['id', 'location_id', 'created_at', 'updated_at', 'position']);
  const FIELD_LABELS: Record<string, string> = { title: 'Titel', name: 'Name', description: 'Beschreibung', status: 'Status', email: 'E-Mail', phone: 'Telefon', due_at: 'Fällig am', notes: 'Notizen' };

  function describeChanges(entity: UndoEntity, before: Snapshot | null, after: Snapshot | null, locationId: string): { k: string; l: string; from: string; to: string }[] {
    if (!before || !after) return [];
    const tz = tzOf(locationId);
    const skip = [...(entity.volatile ?? []), ...SKIP_COLS];
    const keys = changedColumns(before.row, after.row, entity.fields ? [] : skip).filter((k) => (entity.fields ? k in entity.fields : true));
    const out = keys.slice(0, KEEP_CHANGES).map((k) => {
      const f = entity.fields?.[k];
      return { k, l: f?.label ?? FIELD_LABELS[k] ?? k, from: show(before.row[k], f?.fmt, before.row, tz), to: show(after.row[k], f?.fmt, after.row, tz) };
    });
    // Parts (assignees, links …) changed: say so in one line.
    for (const [name, p] of Object.entries(after.parts ?? {})) {
      const b = before.parts?.[name];
      if (b && p.fp && !sameValue(b.rows, p.rows) && out.length < KEEP_CHANGES) out.push({ k: `parts.${name}`, l: PART_LABELS[name] ?? name, from: `${b.rows.length}`, to: `${p.rows.length}` });
    }
    return out;
  }
  const PART_LABELS: Record<string, string> = { assignees: 'Zuständige', watchers: 'Beobachter', associations: 'Verknüpfungen', notes: 'Notizen', activities: 'Aktivitäten', contacts: 'Kontakte' };

  const verbOf = (entity: UndoEntity, action: string, before: Snapshot | null, after: Snapshot | null) => entity.verb?.(before, after) ?? VERBS[action] ?? 'geändert';
  const entityOf = (type: string) => {
    const e = entities.get(type);
    if (!e) throw new HttpError(500, `Undo: unbekannte Art „${type}“`);
    return e;
  };

  // --- recording ----------------------------------------------------------------------------------------------------
  /** Guard: remember what the records look like before the handler runs. */
  function before(ctx: Ctx) {
    if (!state.enabled || ctx.method === 'GET' || !ctx.locationId) return;
    const rule = match(ctx.method, ctx.path);
    if (!rule) return;
    let targets: Target[];
    try {
      targets = rule.targets ? rule.targets(ctx) : ctx.params.id ? [{ id: ctx.params.id }] : [];
    } catch {
      return;
    }
    targets = targets.filter((t) => typeof t.id === 'string' && t.id);
    if (!targets.length || targets.length > MAX_TARGETS) return;
    const deep = typeof rule.deep === 'function' ? rule.deep(ctx) : (rule.deep ?? ctx.method === 'DELETE');
    const items: Pending['items'] = [];
    for (const t of targets) {
      const type = t.entity ?? rule.entity;
      const entity = entities.get(type);
      if (!entity) continue;
      try {
        items.push({ entity: type, id: t.id, before: entity.snapshot(t.id, ctx, deep ? 'deep' : 'before') });
      } catch (e) {
        if (e instanceof TooBig) items.push({ entity: type, id: t.id, before: null, tooBig: true });
        else console.error('[undo] snapshot', e);
      }
    }
    if (!items.length) return;
    pending.set(ctx, { rule, rid: newId(), items });
    // Routes that silence the after-write hooks (autosaves) still get their entry – when the answer has gone out.
    if (rule.quiet && ctx.res && typeof ctx.res.once === 'function') {
      ctx.res.once('finish', () => {
        try {
          if (pending.has(ctx) && ctx.skipAfterWrite && ctx.res.statusCode < 400) after(ctx, { pattern: rule.pattern } as Route);
        } catch (e) {
          console.error('[undo] quiet write', e);
        }
        pending.delete(ctx);
      });
    }
  }

  const insert = (e: Omit<EntryRow, 'seq'>) => {
    db.insert('undo_entries', e);
    return e;
  };

  /** After-write hook: store the entries of this request. */
  function after(ctx: Ctx, route: Route) {
    const p = pending.get(ctx);
    if (!p) return;
    pending.delete(ctx);
    if (p.rule.method !== ctx.method || p.rule.pattern !== route.pattern) return;
    const who = principal(ctx);
    const rows: { entity: string; before: Snapshot | null; after: Snapshot | null; label: string; entry: Omit<EntryRow, 'seq'> }[] = [];
    const at = now();
    for (const item of p.items) {
      const entity = entityOf(item.entity);
      let a: Snapshot | null;
      try {
        a = entity.snapshot(item.id, ctx, 'now');
      } catch (e) {
        console.error('[undo] snapshot after', e);
        continue;
      }
      const b = item.before;
      let fa = '';
      if (!item.tooBig) {
        if (!b && !a) continue;
        // Nothing but timestamps changed (the same value saved again): not worth an entry.
        fa = fingerprint(a, entity.volatile, false);
        if (b && a && fingerprint(b, entity.volatile, false) === fa) continue;
        if (p.rule.when && !p.rule.when(b, a, ctx)) continue;
        // A create is not undoable here (nothing existed before), and a record that appears is not ours to remove.
        if (!b) continue;
      }
      const action = typeof p.rule.action === 'function' ? p.rule.action(b, a, ctx) : (p.rule.action ?? (a ? 'update' : 'delete'));
      const basis = a ?? b;
      const noun = basis ? entity.label(basis) : `${entity.noun} ${item.id.slice(0, 6)}`;
      const notice = typeof p.rule.notice === 'function' ? p.rule.notice(b, a, ctx) : p.rule.notice;
      const verb = item.tooBig ? 'gelöscht' : verbOf(entity, action, b, a);
      rows.push({
        entity: item.entity,
        before: b,
        after: a,
        label: `${noun} ${verb}`,
        entry: {
          id: newId(),
          location_id: ctx.locationId,
          at,
          user_id: who.userId,
          actor: who.name.slice(0, 200),
          actor_kind: who.kind,
          actor_ref: who.ref,
          via: String(ctx.via ?? ''),
          request_id: p.rid,
          kind: 'change',
          action,
          entity: item.entity,
          entity_id: item.id,
          area: entity.area,
          label: `${noun} ${verb}`,
          group_label: '',
          contact_id: (basis && entity.contactId?.(basis)) || null,
          snap_before: item.tooBig ? null : JSON.stringify(b),
          snap_after: item.tooBig ? null : JSON.stringify(a),
          after_fp: fa,
          changes: JSON.stringify(item.tooBig ? [] : describeChanges(entity, b, a, ctx.locationId)),
          meta: JSON.stringify(b?.kids ? { kids: kidCounts(b.kids), kids_text: kidsText(kidCounts(b.kids)) } : {}),
          deep: b?.kids || b?.nulls ? 1 : 0,
          notice: (notice ?? '').slice(0, 300),
          restorable: item.tooBig ? 0 : 1,
          reason: item.tooBig ? 'Zu viele verknüpfte Datensätze – nicht im Papierkorb gespeichert' : '',
          removes: !a && b ? 1 : 0,
          reverts_id: null,
          undone_at: null,
          undone_by: null,
        },
      });
    }
    if (!rows.length) return;
    // Autosaves: the same person editing the same record within the window keeps one entry (the first "before").
    if (p.rule.coalesceMs && rows.length === 1) {
      const r = rows[0];
      const since = new Date(Date.now() - p.rule.coalesceMs).toISOString();
      const prev = db.get<EntryRow>(
        `SELECT * FROM undo_entries WHERE location_id = ? AND actor_ref = ? AND entity = ? AND entity_id = ? AND kind = 'change' AND undone_at IS NULL AND at >= ? ORDER BY seq DESC LIMIT 1`,
        ctx.locationId, r.entry.actor_ref, r.entry.entity, r.entry.entity_id, since,
      );
      if (prev && prev.snap_before) {
        const entity = entityOf(r.entity);
        const first = JSON.parse(prev.snap_before) as Snapshot;
        db.run('UPDATE undo_entries SET snap_after = ?, after_fp = ?, changes = ?, at = ?, label = ? WHERE seq = ?', r.entry.snap_after, r.entry.after_fp, JSON.stringify(describeChanges(entity, first, r.after, ctx.locationId)), at, r.entry.label, prev.seq);
        // Same entry as the toast before (an autosave): no new toast for every keystroke, but the agent's card still gets it.
        return announce(ctx, { ...prev, label: r.entry.label, notice: r.entry.notice }, false);
      }
    }
    if (rows.length > 1) {
      const entity = entityOf(rows[0].entity);
      const same = rows.every((r) => r.entity === rows[0].entity);
      const group = p.rule.groupLabel?.(ctx, rows) ?? `${rows.length} ${same ? (entity.plural ?? `${entity.noun}e`) : 'Datensätze'} ${verbOf(entity, rows[0].entry.action, rows[0].before, rows[0].after)}`;
      for (const r of rows) r.entry.group_label = group;
    }
    db.tx(() => {
      for (const r of rows) insert(r.entry);
    });
    // Nothing to offer when the entry cannot be restored (too big for the trash): no toast with a button that would fail.
    const head = rows.find((r) => r.entry.restorable) ?? undefined;
    if (head) announce(ctx, rows[0].entry.group_label ? { ...head.entry, label: rows[0].entry.group_label } : head.entry);
  }

  /** Tell the caller: response headers for the web app and the mobile app, and the agent's card. */
  function announce(ctx: Ctx, e: { id: string; label: string; notice?: string; group_label?: string }, headers = true) {
    const label = e.group_label || e.label;
    ctx.undoSink?.push({ id: e.id, label, notice: e.notice || undefined });
    const res = ctx.res;
    if (headers && res && !res.headersSent && typeof res.setHeader === 'function') {
      res.setHeader('x-undo-id', e.id);
      res.setHeader('x-undo-label', encodeURIComponent(label));
      if (e.notice) res.setHeader('x-undo-notice', encodeURIComponent(e.notice));
      else res.removeHeader('x-undo-notice');
    }
  }

  // --- reading --------------------------------------------------------------------------------------------------------
  const parse = <T>(s: string | null, fallback: T): T => {
    try {
      return s ? (JSON.parse(s) as T) : fallback;
    } catch {
      return fallback;
    }
  };
  const nameOf = (userId: string | null) => (userId ? db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', userId)?.name : undefined);

  function entryOut(ctx: Ctx, e: EntryRow, members?: EntryRow[]) {
    const entity = entities.get(e.entity);
    const expires = new Date(Date.parse(e.at) + retentionDays(e.location_id) * 864e5).toISOString();
    const group = members && members.length > 1 ? members : undefined;
    const redo = e.kind === 'undo' && !e.undone_at;
    return {
      id: e.id,
      request_id: e.request_id,
      at: e.at,
      kind: e.kind,
      action: e.action,
      entity: e.entity,
      entity_id: e.entity_id,
      noun: entity?.noun ?? e.entity,
      label: group ? (e.group_label || e.label) : e.label,
      actor: e.actor,
      actor_kind: e.actor_kind,
      via: e.via,
      mine: mine(ctx, e),
      count: group?.length ?? 1,
      items: group?.slice(0, 20).map((m) => ({ id: m.id, entity: m.entity, entity_id: m.entity_id, label: m.label })),
      changes: group ? group.slice(0, 3).flatMap((m) => parse(m.changes, [] as any[]).map((c: any) => ({ ...c, l: `${c.l}` }))).slice(0, KEEP_CHANGES) : parse(e.changes, []),
      notice: e.notice,
      undone_at: e.undone_at,
      undone_by: nameOf(e.undone_by) ?? e.undone_by,
      restorable: !!e.restorable,
      reason: e.reason,
      can_undo: !e.undone_at && !!e.restorable && may(ctx, e) && e.at >= cutoff(e.location_id),
      is_redo: redo,
      removes: !!e.removes,
      kids_text: parse<{ kids_text?: string }>(e.meta, {}).kids_text ?? '',
      expires_at: expires,
    };
  }

  function visibleFilter(ctx: Ctx, scope: string) {
    const where = ['location_id = ?'];
    const params: unknown[] = [ctx.locationId];
    if (!(scope === 'all' && isAdmin(ctx))) {
      // Sessions, the app and the agent all act as `u:<user id>`; a key is its own principal.
      where.push('actor_ref = ?');
      params.push(principal(ctx).ref);
    }
    // Areas the person may not use are not shown.
    const areas = [...new Set([...entities.values()].map((e) => e.area).filter(Boolean))].filter((a) => !mayUseArea(ctx, a));
    if (areas.length) {
      where.push(`area NOT IN (${areas.map(() => '?').join(',')})`);
      params.push(...areas);
    }
    where.push('at >= ?');
    params.push(cutoff(ctx.locationId));
    return { where, params };
  }

  function list(ctx: Ctx, q: URLSearchParams) {
    const { where, params } = visibleFilter(ctx, q.get('scope') ?? 'mine');
    const entity = q.get('entity');
    if (entity) (where.push('entity = ?'), params.push(entity));
    const actor = q.get('actor');
    if (actor && actor !== 'all') {
      if (actor === 'me') {
        const p = principal(ctx);
        where.push('actor_ref = ?');
        params.push(p.ref);
      } else (where.push('actor_kind = ?'), params.push(actor));
    }
    if (q.get('include') !== 'undone') where.push('undone_at IS NULL');
    const text = q.get('q')?.trim();
    if (text) (where.push(`(label LIKE ? ESCAPE '\\' OR group_label LIKE ? ESCAPE '\\' OR actor LIKE ? ESCAPE '\\')`), params.push(`%${esc(text)}%`, `%${esc(text)}%`, `%${esc(text)}%`));
    const before = q.get('before');
    if (before) (where.push('at < ?'), params.push(before));
    const limit = clampLimit(q.get('limit'), 50, 200);
    const heads = db.all<{ request_id: string }>(`SELECT request_id, MAX(seq) AS m FROM undo_entries WHERE ${where.join(' AND ')} GROUP BY request_id ORDER BY m DESC LIMIT ?`, ...(params as any[]), limit + 1);
    const ids = heads.slice(0, limit).map((h) => h.request_id);
    const rows = ids.length ? db.all<EntryRow>(`SELECT * FROM undo_entries WHERE location_id = ? AND request_id IN (${ids.map(() => '?').join(',')}) ORDER BY seq DESC`, ctx.locationId, ...ids) : [];
    const byReq = new Map<string, EntryRow[]>();
    for (const r of rows) byReq.set(r.request_id, [...(byReq.get(r.request_id) ?? []), r]);
    const items = ids.map((rid) => {
      const members = byReq.get(rid)!;
      return entryOut(ctx, members[members.length - 1] ?? members[0], members.length > 1 ? members : undefined);
    });
    return { items, has_more: heads.length > limit, retention_days: retentionDays(ctx.locationId) };
  }

  /** Deleted records still in the trash: entries whose change removed the record and that nobody has undone since. */
  function trash(ctx: Ctx, q: URLSearchParams) {
    // The trash is the team's: every deletion in the sub-account is listed (rights decide who may restore).
    const loc = [`location_id = ?`, 'removes = 1', 'undone_at IS NULL', 'at >= ?'];
    const lp: unknown[] = [ctx.locationId, cutoff(ctx.locationId)];
    const areas = [...new Set([...entities.values()].map((e) => e.area).filter(Boolean))].filter((a) => !mayUseArea(ctx, a));
    if (areas.length) (loc.push(`area NOT IN (${areas.map(() => '?').join(',')})`), lp.push(...areas));
    const entity = q.get('entity');
    if (entity) (loc.push('entity = ?'), lp.push(entity));
    const text = q.get('q')?.trim();
    if (text) (loc.push(`label LIKE ? ESCAPE '\\'`), lp.push(`%${esc(text)}%`));
    const rows = db.all<EntryRow>(`SELECT * FROM undo_entries WHERE ${loc.join(' AND ')} ORDER BY seq DESC LIMIT ?`, ...(lp as any[]), clampLimit(q.get('limit'), 100, 500));
    return {
      items: rows.map((r) => ({ ...entryOut(ctx, r), can_purge: isAdmin(ctx) })),
      retention_days: retentionDays(ctx.locationId),
      can_purge: isAdmin(ctx),
    };
  }

  /** The newest change of mine that can be undone, and – if nothing changed since – the undo I could repeat. */
  function last(ctx: Ctx) {
    const { where, params } = visibleFilter(ctx, 'mine');
    const base = `SELECT * FROM undo_entries WHERE ${where.join(' AND ')} AND undone_at IS NULL AND restorable = 1`;
    const change = db.get<EntryRow>(`${base} AND kind = 'change' ORDER BY seq DESC LIMIT 1`, ...(params as any[]));
    const redo = db.get<EntryRow>(`${base} AND kind = 'undo' ORDER BY seq DESC LIMIT 1`, ...(params as any[]));
    const members = (e: EntryRow | undefined) => (e ? db.all<EntryRow>('SELECT * FROM undo_entries WHERE location_id = ? AND request_id = ? ORDER BY seq DESC', e.location_id, e.request_id) : undefined);
    const out = (e: EntryRow | undefined) => (e ? entryOut(ctx, e, (members(e)?.length ?? 0) > 1 ? members(e) : undefined) : null);
    // A redo only makes sense until the next real change.
    return { undo: out(change), redo: redo && (!change || redo.seq > change.seq) ? out(redo) : null };
  }

  // --- undo -------------------------------------------------------------------------------------------------------------
  const load = (ctx: Ctx, entryId: string): EntryRow => {
    const e = db.get<EntryRow>('SELECT * FROM undo_entries WHERE id = ? AND location_id = ?', entryId, ctx.locationId);
    if (!e) throw notFound('Eintrag nicht gefunden');
    return e;
  };

  /** The entries one click undoes: everything one request changed (a bulk action, a merge), newest first. */
  function groupOf(e: EntryRow, single: boolean): EntryRow[] {
    if (single) return [e];
    return db.all<EntryRow>('SELECT * FROM undo_entries WHERE location_id = ? AND request_id = ? AND kind = ? AND undone_at IS NULL ORDER BY seq DESC', e.location_id, e.request_id, e.kind);
  }

  interface Diff {
    field: string;
    label: string;
    entry: string;
    now: string;
    restore: string;
  }
  /** What was changed since the entry (now vs. what the entry left) and what undoing would overwrite. */
  function diffOf(ctx: Ctx, e: EntryRow, cur: Snapshot | null): Diff[] {
    const entity = entityOf(e.entity);
    const tz = tzOf(e.location_id);
    const after = parse<Snapshot | null>(e.snap_after, null);
    const target = parse<Snapshot | null>(e.snap_before, null);
    if (!cur || !after) {
      return [{ field: '_exists', label: 'Datensatz', entry: after ? 'vorhanden' : 'gelöscht', now: cur ? 'vorhanden' : 'gelöscht', restore: target ? 'vorhanden' : 'gelöscht' }];
    }
    const keys = changedColumns(after.row, cur.row, [...(entity.volatile ?? []), ...SKIP_COLS]);
    const out: Diff[] = keys.slice(0, 12).map((k) => {
      const f = entity.fields?.[k];
      return { field: k, label: f?.label ?? FIELD_LABELS[k] ?? k, entry: show(after.row[k], f?.fmt, after.row, tz), now: show(cur.row[k], f?.fmt, cur.row, tz), restore: show(target?.row[k], f?.fmt, target?.row ?? cur.row, tz) };
    });
    for (const [name, part] of Object.entries(cur.parts ?? {})) {
      const a = after.parts?.[name];
      if (a && part.fp && !sameValue(a.rows, part.rows)) out.push({ field: `parts.${name}`, label: PART_LABELS[name] ?? name, entry: `${a.rows.length}`, now: `${part.rows.length}`, restore: `${target?.parts?.[name]?.rows.length ?? 0}` });
    }
    if (!sameValue(after.kids ?? null, cur.kids ?? null)) out.push({ field: '_kids', label: 'Verknüpfte Einträge', entry: kidsText(kidCounts(after.kids)) || '–', now: kidsText(kidCounts(cur.kids)) || '–', restore: kidsText(kidCounts(target?.kids)) || '–' });
    return out;
  }

  /** Dry run: does undoing conflict with later changes, and what is lost? */
  function preview(ctx: Ctx, entryId: string, single = false) {
    const e = load(ctx, entryId);
    guard(ctx, e);
    const group = groupOf(e, single);
    const conflicts: { id: string; label: string; diff: Diff[] }[] = [];
    for (const m of group) {
      if (!m.restorable) continue;
      const entity = entityOf(m.entity);
      const cur = entity.snapshot(m.entity_id, ctx, m.deep ? 'deep' : 'now');
      // What the entry stored decides whether children count (an undone delete stores them, an edit does not).
      if (fingerprint(cur, entity.volatile, !!parse<Snapshot | null>(m.snap_after, null)?.kids) !== m.after_fp) conflicts.push({ id: m.id, label: m.label, diff: diffOf(ctx, m, cur) });
    }
    return { id: e.id, label: group.length > 1 ? e.group_label || e.label : e.label, count: group.length, conflict: conflicts.length > 0, conflicts, notice: group.map((m) => m.notice).find(Boolean) ?? '' };
  }

  function guard(ctx: Ctx, e: EntryRow) {
    if (!may(ctx, e)) {
      if (!mayUseArea(ctx, e.area)) throw new HttpError(403, 'Dafür fehlt dir der Zugriff auf diesen Bereich');
      throw new HttpError(403, 'Du kannst nur deine eigenen Änderungen rückgängig machen – ein Admin kann alles');
    }
    if (e.at < cutoff(e.location_id)) throw new HttpError(410, 'Dieser Eintrag ist abgelaufen und kann nicht mehr wiederhergestellt werden');
    if (e.undone_at) throw new HttpError(409, 'Das wurde schon rückgängig gemacht');
    if (!e.restorable) throw new HttpError(422, e.reason || 'Diese Änderung lässt sich nicht rückgängig machen');
  }

  const friendly = (e: unknown): never => {
    const m = String((e as Error)?.message ?? e);
    if (/FOREIGN KEY/i.test(m)) throw new HttpError(409, 'Ein verknüpfter Datensatz existiert nicht mehr (z. B. der Kontakt wurde gelöscht) – stelle zuerst diesen wieder her');
    if (/UNIQUE|constraint/i.test(m)) throw new HttpError(409, 'Wiederherstellen geht nicht: Es gibt inzwischen einen Datensatz mit denselben Werten');
    if (e instanceof HttpError) throw e;
    throw new HttpError(500, `Wiederherstellen fehlgeschlagen: ${m}`);
  };

  /**
   * Put the "before" state back. `force` skips the conflict check (the person saw the diff and chose to).
   * Returns what was restored and the entry that undoes the undo (redo).
   */
  function undo(ctx: Ctx, entryId: string, opts: { force?: boolean; single?: boolean } = {}) {
    const head = load(ctx, entryId);
    guard(ctx, head);
    const group = groupOf(head, !!opts.single).filter((m) => m.restorable);
    if (!group.length) throw new HttpError(422, 'Diese Änderung lässt sich nicht rückgängig machen');
    if (!opts.force) {
      const pv = preview(ctx, entryId, !!opts.single);
      if (pv.conflict) {
        const first = pv.conflicts[0];
        throw new HttpError(409, `„${clip(first.label, 80)}“ wurde seit dieser Änderung erneut geändert – trotzdem wiederherstellen?`, {
          conflict: true,
          diff: pv.conflicts.flatMap((c) => c.diff.map((d) => ({ ...d, label: pv.conflicts.length > 1 ? `${clip(c.label, 40)}: ${d.label}` : d.label }))),
          conflicts: pv.conflicts,
          notice: pv.notice,
        });
      }
    }
    const who = principal(ctx);
    const rid = newId();
    const at = now();
    const created: EntryRow[] = [];
    const pairs: { entity: UndoEntity; target: Snapshot | null; current: Snapshot | null }[] = [];
    try {
      db.tx(() => {
        db.raw.exec('PRAGMA defer_foreign_keys = ON');
        for (const m of group) {
          const entity = entityOf(m.entity);
          const target = parse<Snapshot | null>(m.snap_before, null);
          const cur = entity.snapshot(m.entity_id, ctx, m.deep ? 'deep' : 'now');
          entity.restore(target, ctx, cur);
          const nowSnap = entity.snapshot(m.entity_id, ctx, m.deep ? 'deep' : 'now');
          const again = m.kind === 'undo' ? 'Wiederholt' : 'Rückgängig';
          const entry: Omit<EntryRow, 'seq'> = {
            id: newId(),
            location_id: m.location_id,
            at,
            user_id: who.userId,
            actor: who.name.slice(0, 200),
            actor_kind: who.kind,
            actor_ref: who.ref,
            via: String(ctx.via ?? ''),
            request_id: rid,
            kind: 'undo',
            action: m.action,
            entity: m.entity,
            entity_id: m.entity_id,
            area: m.area,
            label: `${again}: ${m.label}`,
            group_label: group.length > 1 ? `${again}: ${m.group_label || m.label}` : '',
            contact_id: m.contact_id,
            snap_before: JSON.stringify(cur),
            snap_after: JSON.stringify(nowSnap),
            after_fp: fingerprint(nowSnap, entity.volatile),
            changes: JSON.stringify(describeChanges(entity, cur, nowSnap, m.location_id)),
            meta: m.meta,
            deep: m.deep,
            notice: m.notice,
            restorable: 1,
            reason: '',
            removes: !nowSnap && cur ? 1 : 0,
            reverts_id: m.id,
            undone_at: null,
            undone_by: null,
          };
          insert(entry);
          created.push(entry as EntryRow);
          db.run('UPDATE undo_entries SET undone_at = ?, undone_by = ? WHERE id = ?', at, who.userId ?? who.ref, m.id);
          // Undoing an undo (redo) makes the original change current again.
          if (m.kind === 'undo' && m.reverts_id) db.run('UPDATE undo_entries SET undone_at = NULL, undone_by = NULL WHERE id = ?', m.reverts_id);
          pairs.push({ entity, target, current: cur });
        }
      });
    } catch (e) {
      friendly(e);
    }
    for (const p of pairs) {
      try {
        p.entity.afterRestore?.(ctx, p.target, p.current);
      } catch (e) {
        console.error('[undo] afterRestore', e);
      }
    }
    const label = group.length > 1 ? `${group.length} Einträge wiederhergestellt` : created[0].label;
    const redo = created[created.length - 1];
    return {
      ok: true,
      title: label,
      label,
      restored: created.map((c) => ({ id: c.reverts_id, entity: c.entity, entity_id: c.entity_id, label: c.label })),
      redo_id: redo?.id ?? null,
      notices: [...new Set(group.map((m) => m.notice).filter(Boolean))],
      skipped: group.length < groupOf(head, !!opts.single).length ? 1 : 0,
    };
  }

  /** Empty the trash for good (admins): the snapshot goes, so the record can no longer come back. */
  function purge(ctx: Ctx, entryId?: string) {
    if (!isAdmin(ctx)) throw new HttpError(403, 'Nur Admins können endgültig löschen');
    if (entryId) {
      const e = load(ctx, entryId);
      if (!e.removes || e.undone_at) throw bad('Das liegt nicht im Papierkorb');
      db.run('DELETE FROM undo_entries WHERE seq = ?', e.seq);
      return { ok: true, purged: 1 };
    }
    return { ok: true, purged: db.run('DELETE FROM undo_entries WHERE location_id = ? AND removes = 1 AND undone_at IS NULL', ctx.locationId).changes };
  }

  /** Daily job: entries older than the sub-account's retention are removed. */
  function cleanup(at = Date.now()): number {
    let n = 0;
    for (const l of db.all<{ id: string }>('SELECT DISTINCT location_id AS id FROM undo_entries')) n += db.run('DELETE FROM undo_entries WHERE location_id = ? AND at < ?', l.id, cutoff(l.id, at)).changes;
    return n;
  }

  /** GDPR: nothing about an erased contact stays in the journal. */
  function eraseContact(locationId: string, contactId: string): number {
    return db.run('DELETE FROM undo_entries WHERE location_id = ? AND contact_id = ?', locationId, contactId).changes;
  }

  return {
    get enabled() {
      return state.enabled;
    },
    set enabled(v: boolean) {
      state.enabled = v;
    },
    entities,
    register,
    track,
    match,
    before,
    after,
    principal,
    mayUseArea,
    list,
    trash,
    last,
    preview,
    undo,
    purge,
    cleanup,
    eraseContact,
    retentionDays,
    isAdmin,
  };
}

export type Journal = ReturnType<typeof createJournal>;
