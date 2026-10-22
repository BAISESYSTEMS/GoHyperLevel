import type { Module } from '../core/app.js';
import { bad, clampLimit, notFound, str, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import { getContact, logActivity } from '../services/contacts.js';
import { contactScopeClause, resolve } from '../services/record-access.js';
import { renderMarkdown } from '../services/wiki-markdown.js';

/**
 * Better notes (docs/api.md, Notizen): a title, a colour, pinning and Markdown on the contact notes, plus search across all
 * notes of a sub-account. The text is rendered on the server with the wiki's escaping renderer and allow-list sanitiser
 * (`html`), so the browser never interprets raw Markdown. The workflow step `add_note` takes `title`, `color` and `pinned`
 * through the hook `app.services.noteExtras`.
 */

export const NOTE_COLORS = ['', 'yellow', 'green', 'blue', 'red', 'purple', 'gray'] as const;
const cleanColor = (v: unknown) => (NOTE_COLORS.includes(String(v ?? '') as (typeof NOTE_COLORS)[number]) ? String(v ?? '') : null);

export const notesPlusModule: Module = {
  name: 'notes-plus',
  migrations: [
    [
      '001-init',
      `
      ALTER TABLE notes ADD COLUMN title TEXT NOT NULL DEFAULT '';
      ALTER TABLE notes ADD COLUMN color TEXT NOT NULL DEFAULT '';
      ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE notes ADD COLUMN updated_at TEXT;
      CREATE INDEX notes_location ON notes(location_id, created_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const out = (n: any) => ({ ...n, pinned: !!n.pinned, html: renderMarkdown(String(n.body ?? ''), { profile: 'chat' }).html });
    const fields = (b: any, partial: boolean) => {
      const f: Record<string, unknown> = {};
      if (!partial || b.body !== undefined) f.body = str(b.body, 'Notiz', { required: true, max: 20000 });
      if (b.title !== undefined) f.title = str(b.title, 'Titel', { max: 200 });
      if (b.color !== undefined) {
        const c = cleanColor(b.color);
        if (c === null) throw bad(`Farbe: ${NOTE_COLORS.filter(Boolean).join(', ')} oder leer`);
        f.color = c;
      }
      if (b.pinned !== undefined) f.pinned = b.pinned ? 1 : 0;
      return f;
    };

    // Notes of a contact (pinned first) or a search over all notes the person may see (title, text, contact name).
    router.get('/api/notes', 'location', (ctx) => {
      const where = ['n.location_id = ?'];
      const params: unknown[] = [ctx.locationId];
      const cid = ctx.query.get('contact_id');
      if (cid) (where.push('n.contact_id = ?'), params.push(cid));
      const q = String(ctx.query.get('q') ?? '').trim();
      if (q) {
        where.push(`(n.title || ' ' || n.body || ' ' || COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) LIKE ?`);
        params.push(`%${q.replace(/[%_]/g, '')}%`);
      }
      if (ctx.query.get('pinned') === '1') where.push('n.pinned = 1');
      const scope = contactScopeClause(resolve(app, ctx), 'n.contact_id');
      if (scope) (where.push(scope.sql), params.push(...scope.params));
      return db
        .all(
          `SELECT n.*, u.name AS user_name, c.first_name, c.last_name, c.email FROM notes n JOIN contacts c ON c.id = n.contact_id LEFT JOIN users u ON u.id = n.user_id
           WHERE ${where.join(' AND ')} ORDER BY n.pinned DESC, n.created_at DESC LIMIT ${clampLimit(ctx.query.get('limit'), 100, 500)}`,
          ...(params as string[]),
        )
        .map(out);
    });
    router.post('/api/notes', 'location', (ctx) => {
      const contactId = str(ctx.body?.contact_id, 'contact_id', { required: true, max: 64 });
      if (!getContact(app, ctx.locationId, contactId)) throw notFound('Kontakt nicht gefunden');
      const note = { id: id(), location_id: ctx.locationId, contact_id: contactId, title: '', color: '', pinned: 0, ...fields(ctx.body ?? {}, false), user_id: ctx.user?.id ?? null, created_at: now(), updated_at: now() };
      db.insert('notes', note);
      logActivity(app, ctx.locationId, contactId, 'note.added', 'Notiz hinzugefügt');
      return out(note);
    });
    router.patch('/api/notes/:id', 'location', (ctx: Ctx) => {
      const cur = db.get('SELECT * FROM notes WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!cur) throw notFound('Notiz nicht gefunden');
      db.update('notes', cur.id, { ...fields(ctx.body ?? {}, true), updated_at: now() }, ctx.locationId);
      return out(db.get('SELECT * FROM notes WHERE id = ?', cur.id));
    });

    // The workflow step add_note: title, colour and pinning (the engine adds these columns to the row it inserts).
    app.services.noteExtras = (step: any, t: (v: unknown) => string) => ({ title: t(step.title).slice(0, 200), color: cleanColor(step.color) ?? '', pinned: step.pinned ? 1 : 0, updated_at: now() });

    const undo = app.services.undo as { track(rule: unknown): void } | undefined;
    undo?.track({ method: 'PATCH', pattern: '/api/notes/:id', entity: 'note' });
  },
};
