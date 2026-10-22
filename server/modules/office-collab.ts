import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, str } from '../core/http.js';
import { id, now } from '../core/util.js';
import { actorOf, teamUsers, track } from '../services/collab-actor.js';
import { LIMITS, LOCK_TTL_MS, activeLock, lockMessage, type LockRow } from '../services/office-model.js';
import { getFile } from '../services/office-store.js';

/**
 * Office collaboration (docs/office.md#zusammenarbeit): the edit lock ("ausgecheckt" – one person edits, everybody else opens
 * read-only; it ends on its own after LOCK_TTL_MS unless the open editor renews it, an admin may take it over) and comments per
 * file or version with @mentions (push/bell notice to the mentioned people and the file's author). Who has a file open shows through
 * the app-wide presence (page `office/<id>`, services/presence-model.ts) – nothing about it is stored here.
 */

interface CommentRow {
  id: string;
  file_id: string;
  location_id: string;
  version: number | null;
  parent_id: string | null;
  body: string;
  mentions: string;
  author_id: string | null;
  author_name: string;
  via: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

const commentOut = (c: CommentRow) => ({ ...c, mentions: JSON.parse(c.mentions || '[]') as string[] });

export const officeCollabModule: Module = {
  name: 'office-collab',
  register(app) {
    const { db, router } = app;

    // --- edit lock ---------------------------------------------------------------------------------------------------------
    router.get('/api/office/files/:id/lock', 'location', (ctx) => {
      const f = getFile(app, ctx.locationId, ctx.params.id);
      const l = activeLock(db.get<LockRow>('SELECT * FROM office_locks WHERE file_id = ?', f.id));
      return { lock: l ? { user_id: l.user_id, user_name: l.user_name, acquired_at: l.acquired_at, expires_at: l.expires_at, mine: !!ctx.user && l.user_id === ctx.user.id } : null };
    });

    /** Check out (or renew) the lock. A person only – keys and MCP connections cannot hold one. `take_over: true` (admins) breaks another's lock. */
    router.post('/api/office/files/:id/lock', 'location', (ctx) => {
      const f = getFile(app, ctx.locationId, ctx.params.id);
      const u = ctx.user;
      if (!u || ctx.viaApiKey) throw new HttpError(403, 'Nur angemeldete Personen können eine Datei zum Bearbeiten sperren');
      const cur = activeLock(db.get<LockRow>('SELECT * FROM office_locks WHERE file_id = ?', f.id));
      const takeOver = ctx.body?.take_over === true;
      if (cur && cur.user_id !== u.id) {
        if (!takeOver) throw new HttpError(423, lockMessage(cur), { locked_by: cur.user_name, locked_until: cur.expires_at });
        if (u.role !== 'admin') throw new HttpError(403, 'Nur Admins können die Sperre eines anderen übernehmen');
      }
      const at = new Date();
      const row: LockRow & { location_id: string } = {
        file_id: f.id,
        location_id: ctx.locationId,
        user_id: u.id,
        user_name: u.name.slice(0, 200),
        acquired_at: cur && cur.user_id === u.id ? cur.acquired_at : at.toISOString(),
        expires_at: new Date(at.getTime() + LOCK_TTL_MS).toISOString(),
      };
      db.run(
        `INSERT INTO office_locks (file_id, location_id, user_id, user_name, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(file_id) DO UPDATE SET user_id = excluded.user_id, user_name = excluded.user_name, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at`,
        row.file_id,
        row.location_id,
        row.user_id,
        row.user_name,
        row.acquired_at,
        row.expires_at,
      );
      return { lock: { user_id: row.user_id, user_name: row.user_name, acquired_at: row.acquired_at, expires_at: row.expires_at, mine: true }, name: f.name, renewed: !!(cur && cur.user_id === u.id) };
    });

    /** Check in: the holder (or an admin) releases the lock. */
    router.delete('/api/office/files/:id/lock', 'location', (ctx) => {
      const f = getFile(app, ctx.locationId, ctx.params.id);
      const cur = activeLock(db.get<LockRow>('SELECT * FROM office_locks WHERE file_id = ?', f.id));
      if (cur && cur.user_id !== ctx.user?.id && ctx.user?.role !== 'admin') throw new HttpError(403, 'Die Sperre gehört jemand anderem');
      db.run('DELETE FROM office_locks WHERE file_id = ?', f.id);
      return { ok: true, name: f.name };
    });

    // Expired locks are cleaned up now and then (they already count as free).
    app.onTick(() => {
      db.run('DELETE FROM office_locks WHERE expires_at < ?', new Date(Date.now() - 3600_000).toISOString());
    });

    // --- people (for @mentions) --------------------------------------------------------------------------------------------
    router.get('/api/office/people', 'location', (ctx) => teamUsers(app, ctx.locationId, 'office').map((u) => ({ id: u.id, name: u.name })));

    // --- comments -----------------------------------------------------------------------------------------------------------
    router.get('/api/office/files/:id/comments', 'location', (ctx) => {
      const f = getFile(app, ctx.locationId, ctx.params.id);
      return db.all<CommentRow>('SELECT * FROM office_comments WHERE file_id = ? ORDER BY created_at LIMIT 1000', f.id).map(commentOut);
    });

    router.post('/api/office/files/:id/comments', 'location', (ctx) => {
      const f = getFile(app, ctx.locationId, ctx.params.id);
      const b = ctx.body ?? {};
      const body = str(b.body, 'Kommentar', { required: true, max: LIMITS.comment });
      let version: number | null = null;
      if (b.version !== undefined && b.version !== null && b.version !== '') {
        version = Number(b.version);
        if (!Number.isInteger(version) || !db.get('SELECT 1 FROM office_versions WHERE file_id = ? AND version = ?', f.id, version)) throw bad('Version nicht gefunden');
      }
      let parent: CommentRow | undefined;
      if (b.parent_id) {
        parent = db.get<CommentRow>('SELECT * FROM office_comments WHERE id = ? AND file_id = ?', String(b.parent_id), f.id);
        if (!parent) throw bad('Kommentar, auf den geantwortet wird, nicht gefunden');
      }
      const actor = actorOf(app, ctx);
      const team = teamUsers(app, ctx.locationId, 'office');
      const lower = body.toLowerCase();
      // "@Vorname Nachname" (the picker inserts the full name) or an explicit list of ids
      const mentioned = new Set<string>(team.filter((u) => u.name && lower.includes(`@${u.name.toLowerCase()}`)).map((u) => u.id));
      if (Array.isArray(b.mentions)) for (const m of b.mentions) if (team.some((u) => u.id === m)) mentioned.add(String(m));
      const at = now();
      const row: CommentRow = { id: id(), file_id: f.id, location_id: ctx.locationId, version, parent_id: parent?.id ?? null, body, mentions: JSON.stringify([...mentioned]), author_id: actor.id, author_name: actor.name, via: String(ctx.via ?? ''), resolved_at: null, created_at: at, updated_at: at };
      db.insert('office_comments', row as unknown as Record<string, unknown>);
      const notify = new Set<string>(mentioned);
      if (f.created_by) notify.add(f.created_by);
      if (parent?.author_id) notify.add(parent.author_id);
      notify.delete(actor.id ?? '');
      const targets = [...notify].filter((uid) => team.some((u) => u.id === uid));
      if (targets.length && app.services.pushNotify) {
        track(app, Promise.resolve(app.services.pushNotify({ userIds: targets, kind: 'office', title: `${actor.name} hat „${f.name}“ kommentiert`.slice(0, 120), body: body.slice(0, 200), url: `/app/office/${f.id}?comment=${row.id}`, tag: `office-c:${row.id}` })));
      }
      return { ...commentOut(row), name: f.name, notified: targets.length };
    });

    router.patch('/api/office/files/:id/comments/:cid', 'location', (ctx) => {
      const f = getFile(app, ctx.locationId, ctx.params.id);
      const c = db.get<CommentRow>('SELECT * FROM office_comments WHERE id = ? AND file_id = ?', ctx.params.cid, f.id);
      if (!c) throw notFound('Kommentar nicht gefunden');
      const b = ctx.body ?? {};
      const patch: Record<string, unknown> = {};
      if (b.resolved !== undefined) {
        if (typeof b.resolved !== 'boolean') throw bad('resolved muss wahr oder falsch sein');
        patch.resolved_at = b.resolved ? now() : null;
      }
      if (b.body !== undefined) {
        if (!ctx.user || c.author_id !== ctx.user.id) throw new HttpError(403, 'Nur eigene Kommentare lassen sich ändern');
        patch.body = str(b.body, 'Kommentar', { required: true, max: LIMITS.comment });
      }
      if (!Object.keys(patch).length) return commentOut(c);
      patch.updated_at = now();
      db.update('office_comments', c.id, patch, ctx.locationId);
      return { ...commentOut(db.get<CommentRow>('SELECT * FROM office_comments WHERE id = ?', c.id)!), name: f.name };
    });

    router.delete('/api/office/files/:id/comments/:cid', 'location', (ctx) => {
      const f = getFile(app, ctx.locationId, ctx.params.id);
      const c = db.get<CommentRow>('SELECT * FROM office_comments WHERE id = ? AND file_id = ?', ctx.params.cid, f.id);
      if (!c) throw notFound('Kommentar nicht gefunden');
      if (c.author_id !== ctx.user?.id && ctx.user?.role !== 'admin') throw new HttpError(403, 'Nur eigene Kommentare lassen sich löschen');
      db.run('DELETE FROM office_comments WHERE (id = ? OR parent_id = ?) AND file_id = ?', c.id, c.id, f.id);
      return { ok: true, name: f.name };
    });
  },
};
