import type { App, Module } from '../core/app.js';
import { HttpError, bad, num, type Ctx } from '../core/http.js';
import { ymdInTz, zonedToUtc } from '../core/time.js';
import { now } from '../core/util.js';
import { DEFAULT_RETENTION_DAYS, createJournal } from '../services/undo-journal.js';

/**
 * Rückgängig, Verlauf and Papierkorb for the whole app (docs/undo.md).
 *
 * The journal itself is `services/undo-journal.ts`; this module is its home in the app: the table,
 * the hooks that watch every write (a guard takes the "before" snapshot, an after-write hook stores the entry),
 * the routes under /api/undo, the daily retention job and the GDPR step. What a record is and which routes
 * change it is registered by `modules/undo-entities.ts` (and any module may add its own through
 * `app.services.undo.register` / `.track`).
 *
 *   GET    /api/undo               my changes (scope=all: everyone's, admins), grouped per request
 *   GET    /api/undo/last          what Ctrl+Z would undo, and the undo it could repeat
 *   GET    /api/undo/trash         deleted records still restorable
 *   GET    /api/undo/:id/preview   dry run: conflicts with later changes
 *   POST   /api/undo/:id           restore ({force?, single?}); 409 + diff on conflict
 *   DELETE /api/undo/:id           empty one record from the trash for good (admins)
 *   DELETE /api/undo/trash         empty the whole trash (admins)
 *   GET/PUT /api/undo/settings     retention in days (default 30)
 *   GET    /api/undo/done-today    tasks completed today (the "Erledigt heute" filter)
 */
export const undoModule: Module = {
  name: 'undo',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE undo_entries (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        at TEXT NOT NULL,
        user_id TEXT, actor TEXT NOT NULL DEFAULT '', actor_kind TEXT NOT NULL DEFAULT 'user', actor_ref TEXT NOT NULL DEFAULT '',
        via TEXT NOT NULL DEFAULT '',
        request_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'change',
        action TEXT NOT NULL,
        entity TEXT NOT NULL, entity_id TEXT NOT NULL, area TEXT NOT NULL DEFAULT '',
        label TEXT NOT NULL DEFAULT '', group_label TEXT NOT NULL DEFAULT '',
        contact_id TEXT,
        snap_before TEXT, snap_after TEXT, after_fp TEXT NOT NULL DEFAULT '',
        changes TEXT NOT NULL DEFAULT '[]', meta TEXT NOT NULL DEFAULT '{}',
        deep INTEGER NOT NULL DEFAULT 0,
        notice TEXT NOT NULL DEFAULT '',
        restorable INTEGER NOT NULL DEFAULT 1, reason TEXT NOT NULL DEFAULT '',
        removes INTEGER NOT NULL DEFAULT 0,
        reverts_id TEXT,
        undone_at TEXT, undone_by TEXT
      );
      CREATE INDEX undo_loc_at ON undo_entries(location_id, at);
      CREATE INDEX undo_actor ON undo_entries(location_id, actor_ref, seq);
      CREATE INDEX undo_request ON undo_entries(request_id);
      CREATE INDEX undo_trash ON undo_entries(location_id, seq) WHERE removes = 1;
      CREATE INDEX undo_contact ON undo_entries(location_id, contact_id) WHERE contact_id IS NOT NULL;
      CREATE TABLE undo_settings (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
        retention_days INTEGER NOT NULL DEFAULT ${DEFAULT_RETENTION_DAYS}, updated_at TEXT NOT NULL
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const journal = createJournal(app);
    app.services.undo = journal;

    // Every tracked write: the "before" snapshot just ahead of the handler, the entry once it succeeded.
    app.guards.push((ctx, auth) => {
      if (auth === 'location') journal.before(ctx);
    });
    app.afterWrite.push((ctx, route) => journal.after(ctx, route));

    // Retention: once a day (and on start), entries past the sub-account's days are removed for good.
    let lastClean = 0;
    app.onTick(() => {
      if (Date.now() - lastClean < 864e5) return;
      lastClean = Date.now();
      journal.cleanup();
    });

    // DSGVO: erasing a contact empties the journal of everything about it.
    app.services.privacyErase = [...(app.services.privacyErase ?? []), (a: App, locationId: string, contact: { id: string }) => void journal.eraseContact(locationId, contact.id)];

    // --- reading ---------------------------------------------------------------------------------------
    router.get('/api/undo', 'location', (ctx) => journal.list(ctx, ctx.query));
    router.get('/api/undo/last', 'location', (ctx) => journal.last(ctx));
    router.get('/api/undo/trash', 'location', (ctx) => journal.trash(ctx, ctx.query));

    const mayConfigure = (ctx: Ctx) => ctx.user?.role === 'admin' || (!!ctx.user && (!ctx.user.permissions || ctx.user.permissions.includes('settings')));
    router.get('/api/undo/settings', 'location', (ctx) => ({ retention_days: journal.retentionDays(ctx.locationId), default_days: DEFAULT_RETENTION_DAYS, can_edit: mayConfigure(ctx) }));
    router.put('/api/undo/settings', 'location', (ctx) => {
      if (!mayConfigure(ctx)) throw new HttpError(403, 'Nur für Admins und Einstellungs-Berechtigte');
      const days = Math.round(num(ctx.body?.retention_days, NaN));
      if (!Number.isFinite(days) || days < 1 || days > 365) throw bad('Aufbewahrung: 1 bis 365 Tage');
      db.run('INSERT INTO undo_settings (location_id, retention_days, updated_at) VALUES (?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET retention_days = excluded.retention_days, updated_at = excluded.updated_at', ctx.locationId, days, now());
      return { retention_days: days, default_days: DEFAULT_RETENTION_DAYS, can_edit: true };
    });

    // The done list one click away: tasks (core and planner share the table) ticked off today, in the sub-account's day.
    router.get('/api/undo/done-today', 'location', (ctx) => {
      const tz = app.location(ctx.locationId)?.timezone || 'Europe/Berlin';
      const since = zonedToUtc(ymdInTz(new Date(), tz), '00:00', tz).toISOString();
      return db.all(
        `SELECT t.*, c.first_name, c.last_name, c.email FROM tasks t LEFT JOIN contacts c ON c.id = t.contact_id
         WHERE t.location_id = ? AND t.done = 1 AND t.completed_at >= ? ORDER BY t.completed_at DESC LIMIT 500`,
        ctx.locationId,
        since,
      );
    });

    router.get('/api/undo/:id/preview', 'location', (ctx) => journal.preview(ctx, ctx.params.id, ctx.query.get('single') === '1'));
    router.post('/api/undo/:id', 'location', (ctx) => journal.undo(ctx, ctx.params.id, { force: ctx.body?.force === true, single: ctx.body?.single === true }));
    router.delete('/api/undo/trash', 'location', (ctx) => journal.purge(ctx));
    router.delete('/api/undo/:id', 'location', (ctx) => journal.purge(ctx, ctx.params.id));
  },
};
