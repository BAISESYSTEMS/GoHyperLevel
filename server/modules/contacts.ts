import { Readable } from 'node:stream';
import type { Module } from '../core/app.js';
import { gzipStream } from '../core/compress.js';
import { parseCsv, guessContactField, toCsv } from '../core/csv.js';
import { parseJson, parseRows } from '../core/db.js';
import { bad, html, notFound, num, str, clampLimit, type Ctx, type RawResult } from '../core/http.js';
import { messagePage, publicPage } from '../core/page.js';
import { escapeHtml } from '../core/template.js';
import { id, now, slugify } from '../core/util.js';
import {
  CONTACT_FIELDS,
  addTags,
  contactFiles,
  contactName,
  findContacts,
  getContact,
  logActivity,
  removeContactFiles,
  removeTags,
  upsertContact,
} from '../services/contacts.js';
import { unsubscribeToken } from '../services/messaging.js';
import { contactScopeClause, maskRow, resolve, scopeClause } from '../services/record-access.js';

export const contactsModule: Module = {
  name: 'contacts',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE contacts (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        first_name TEXT NOT NULL DEFAULT '', last_name TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', company TEXT NOT NULL DEFAULT '',
        address TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '', postal_code TEXT NOT NULL DEFAULT '',
        country TEXT NOT NULL DEFAULT '', website TEXT NOT NULL DEFAULT '', date_of_birth TEXT,
        source TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', custom TEXT NOT NULL DEFAULT '{}',
        dnd INTEGER NOT NULL DEFAULT 0, assigned_to TEXT, external_id TEXT,
        last_activity_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX contacts_loc_email ON contacts(location_id, email);
      CREATE INDEX contacts_loc_phone ON contacts(location_id, phone);
      CREATE INDEX contacts_loc_created ON contacts(location_id, created_at);
      CREATE TABLE tags (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(location_id, name)
      );
      CREATE TABLE custom_fields (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        key TEXT NOT NULL, label TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'text', options TEXT NOT NULL DEFAULT '[]',
        position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE(location_id, key)
      );
      CREATE TABLE notes (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        body TEXT NOT NULL, user_id TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE,
        title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', due_at TEXT, done INTEGER NOT NULL DEFAULT 0,
        assigned_to TEXT, created_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE TABLE activities (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        contact_id TEXT, type TEXT NOT NULL, summary TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
      );
      CREATE INDEX activities_contact ON activities(contact_id, created_at);
      CREATE TABLE smart_lists (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, filter TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;

    const listFilter = (ctx: Ctx) => {
      const q = ctx.query;
      return {
        q: q.get('q') ?? '',
        tags: q.getAll('tag').filter(Boolean),
        excludeTags: q.getAll('notTag').filter(Boolean),
        sort: q.get('sort') ?? '',
        limit: clampLimit(q.get('limit'), 50, 500),
        offset: num(q.get('offset'), 0),
        query: q,
        // Who asks: the record-access rules (modules/record-access.ts) narrow the list for people with a limited view.
        who: ctx,
      };
    };

    router.get('/api/contacts', 'location', (ctx) => findContacts(app, ctx.locationId, listFilter(ctx)));

    router.post('/api/contacts', 'location', (ctx) => {
      const b = ctx.body;
      if (!b.email && !b.phone && !b.first_name && !b.last_name && !b.name) throw bad('Name, E-Mail oder Telefon angeben');
      const { contact, created } = upsertContact(app, ctx.locationId, b, { source: ctx.viaApiKey ? 'API' : 'manuell' });
      // `consent` in the body (true or { channels, purposes, doi, text, proof_url, note }): the yes goes into the consent ledger (modules/consent.ts).
      if (b.consent) app.services.consent?.captureApi?.(ctx, ctx.locationId, contact.id, b.consent);
      return { ...contact, created };
    });

    // Streamed in pages of 1000 with a pause between them (a big export used to hold the server for seconds).
    router.get('/api/contacts/export.csv', 'location', (ctx) => {
      const filter = listFilter(ctx);
      const fields = db.all('SELECT key, label FROM custom_fields WHERE location_id = ? ORDER BY position', ctx.locationId);
      const header = [...CONTACT_FIELDS, 'tags', 'dnd', 'created_at', ...fields.map((f) => f.key)];
      const PAGE = 1000;
      const MAX = 100_000;
      async function* chunks() {
        yield '\uFEFF' + toCsv([header]);
        for (let offset = 0; offset < MAX; offset += PAGE) {
          const { contacts } = findContacts(app, ctx.locationId, { ...filter, limit: PAGE, offset, noTotal: true });
          if (!contacts.length) return;
          yield '\r\n' + toCsv(contacts.map((c) => [...CONTACT_FIELDS.map((k) => c[k] ?? ''), c.tags.join(', '), c.dnd ? 'ja' : '', c.created_at, ...fields.map((f) => c.custom?.[f.key] ?? '')]));
          if (contacts.length < PAGE) return;
          await new Promise<void>((r) => setImmediate(r));
        }
      }
      const out = gzipStream(ctx.req, { 'content-type': 'text/csv; charset=utf-8' }, Readable.from(chunks()));
      return { __raw: true, status: 200, headers: out.headers, body: out.body } satisfies RawResult;
    });

    router.post('/api/contacts/import', 'location', (ctx) => {
      const rows = parseCsv(String(ctx.body.csv ?? ''));
      if (rows.length < 2) throw bad('CSV braucht eine Kopfzeile und mindestens eine Zeile');
      const header = rows[0];
      const customKeys = new Set(db.all('SELECT key FROM custom_fields WHERE location_id = ?', ctx.locationId).map((r) => r.key));
      const mapping: Record<number, string> = {};
      header.forEach((h, i) => {
        const m = ctx.body.mapping?.[h] ?? guessContactField(h) ?? (customKeys.has(slugify(h).replace(/-/g, '_')) ? `custom.${slugify(h).replace(/-/g, '_')}` : undefined);
        if (m) mapping[i] = m;
      });
      const extraTags = String(ctx.body.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean);
      let created = 0;
      let updated = 0;
      let skipped = 0;
      const touched: string[] = [];
      db.tx(() => {
        for (const row of rows.slice(1)) {
          const input: Record<string, any> = { custom: {} };
          for (const [i, field] of Object.entries(mapping)) {
            const v = row[Number(i)]?.trim();
            if (!v) continue;
            if (field === 'tags') input.tags = v.split(/[,;|]/).map((t) => t.trim()).filter(Boolean);
            else if (field.startsWith('custom.')) input.custom[field.slice(7)] = v;
            else input[field] = v;
          }
          if (!input.email && !input.phone && !input.first_name && !input.name) {
            skipped++;
            continue;
          }
          const r = upsertContact(app, ctx.locationId, input, { source: 'CSV-Import', tags: extraTags, quiet: !ctx.body.triggerWorkflows });
          r.created ? created++ : updated++;
          touched.push(r.contact.id);
        }
      });
      // Consent of the imported contacts (modules/consent.ts): `consent` = legacy (default: no proof, "Altbestand"), confirmed (proven elsewhere, `consent_note` says how) or doi.
      const consent = app.services.consent?.importBatch?.(ctx.locationId, touched, { mode: ctx.body.consent, note: str(ctx.body.consent_note, 'Nachweis', { max: 1000 }), label: str(ctx.body.source_label, 'Quelle', { max: 120 }) || 'CSV-Import', actor: ctx.user?.id });
      return { created, updated, skipped, mapped: Object.values(mapping), ...(consent ? { consent } : {}) };
    });

    router.post('/api/contacts/bulk', 'location', (ctx) => {
      const ids: string[] = Array.isArray(ctx.body.ids) ? ctx.body.ids.map(String) : [];
      const tag = str(ctx.body.tag, 'Tag');
      let n = 0;
      for (const cid of ids) {
        if (!getContact(app, ctx.locationId, cid)) continue;
        if (ctx.body.action === 'add_tag' && tag) addTags(app, ctx.locationId, cid, [tag]);
        else if (ctx.body.action === 'remove_tag' && tag) removeTags(app, ctx.locationId, cid, [tag]);
        else if (ctx.body.action === 'delete') {
          const files = contactFiles(app, ctx.locationId, cid);
          if (db.run('DELETE FROM contacts WHERE id = ? AND location_id = ?', cid, ctx.locationId).changes) {
            removeContactFiles(files);
            // Like the single delete: webhooks, REST hooks and the modules that keep copies (Wissensgedächtnis) learn of it.
            app.events.emit(ctx.locationId, 'contact.deleted', { contactId: cid });
          }
        }
        else if (ctx.body.action === 'dnd') db.run('UPDATE contacts SET dnd = ? WHERE id = ?', ctx.body.value ? 1 : 0, cid);
        else throw bad('Unbekannte Aktion');
        n++;
      }
      return { count: n };
    });

    router.get('/api/contacts/:id', 'location', (ctx) => {
      const c = getContact(app, ctx.locationId, ctx.params.id);
      if (!c) throw notFound('Kontakt nicht gefunden');
      return {
        ...c,
        name: contactName(c),
        notes: db.all('SELECT n.*, u.name AS user_name FROM notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.contact_id = ? ORDER BY n.created_at DESC', c.id),
        tasks: db.all('SELECT * FROM tasks WHERE contact_id = ? ORDER BY done, due_at', c.id),
        activities: parseRows(db.all('SELECT * FROM activities WHERE contact_id = ? ORDER BY created_at DESC LIMIT 100', c.id), ['data']),
      };
    });

    router.patch('/api/contacts/:id', 'location', (ctx) => {
      const c = getContact(app, ctx.locationId, ctx.params.id);
      if (!c) throw notFound('Kontakt nicht gefunden');
      const b = ctx.body;
      const patch: Record<string, any> = {};
      for (const k of CONTACT_FIELDS) if (b[k] !== undefined) patch[k] = b[k] === null ? null : String(b[k]).trim();
      if (patch.email !== undefined) patch.email = String(patch.email).toLowerCase();
      if (b.custom && typeof b.custom === 'object') patch.custom = { ...c.custom, ...b.custom };
      if (b.dnd !== undefined) patch.dnd = b.dnd ? 1 : 0;
      patch.updated_at = now();
      db.update('contacts', c.id, patch);
      if (Array.isArray(b.tags)) {
        const next = b.tags.map(String);
        addTags(app, ctx.locationId, c.id, next.filter((t: string) => !c.tags.includes(t)));
        removeTags(app, ctx.locationId, c.id, c.tags.filter((t) => !next.includes(t)));
      }
      const contact = getContact(app, ctx.locationId, c.id)!;
      // `previous`: the contact before the change (trigger "Feld geändert" compares it with `contact`).
      app.events.emit(ctx.locationId, 'contact.updated', { contactId: c.id, contact, changed: Object.keys(patch), previous: c });
      return contact;
    });

    router.delete('/api/contacts/:id', 'location', (ctx) => {
      // The rows that know the person's files (uploads, recordings, certificates) go with the contact: read them first.
      const files = contactFiles(app, ctx.locationId, ctx.params.id);
      if (!db.run('DELETE FROM contacts WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId).changes) throw notFound();
      removeContactFiles(files);
      app.events.emit(ctx.locationId, 'contact.deleted', { contactId: ctx.params.id });
      return { ok: true };
    });

    router.post('/api/contacts/:id/tags', 'location', (ctx) => {
      if (!getContact(app, ctx.locationId, ctx.params.id)) throw notFound();
      if (Array.isArray(ctx.body.add)) addTags(app, ctx.locationId, ctx.params.id, ctx.body.add.map(String));
      if (Array.isArray(ctx.body.remove)) removeTags(app, ctx.locationId, ctx.params.id, ctx.body.remove.map(String));
      return getContact(app, ctx.locationId, ctx.params.id);
    });

    // --- notes --------------------------------------------------------------
    router.post('/api/contacts/:id/notes', 'location', (ctx) => {
      if (!getContact(app, ctx.locationId, ctx.params.id)) throw notFound();
      const note = { id: id(), location_id: ctx.locationId, contact_id: ctx.params.id, body: str(ctx.body.body, 'Notiz', { required: true, max: 20000 }), user_id: ctx.user?.id ?? null, created_at: now() };
      db.insert('notes', note);
      logActivity(app, ctx.locationId, ctx.params.id, 'note.added', 'Notiz hinzugefügt');
      return note;
    });
    router.delete('/api/notes/:id', 'location', (ctx) => {
      db.run('DELETE FROM notes WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      return { ok: true };
    });

    // --- tasks --------------------------------------------------------------
    router.get('/api/tasks', 'location', (ctx) => {
      const status = ctx.query.get('status');
      const where = status === 'done' ? 'AND t.done = 1' : status === 'all' ? '' : 'AND t.done = 0';
      // Record-access rules (modules/record-access.ts): a person with a limited view sees their own / their team's tasks.
      const access = resolve(app, ctx);
      const scope = scopeClause(access, 'tasks', 't');
      return db
        .all(
          `SELECT t.*, c.first_name, c.last_name, c.email FROM tasks t LEFT JOIN contacts c ON c.id = t.contact_id
           WHERE t.location_id = ? ${where}${scope ? ` AND ${scope.sql}` : ''} ORDER BY t.done, COALESCE(t.due_at, '9999'), t.created_at LIMIT 500`,
          ctx.locationId,
          ...(scope?.params ?? []),
        )
        .map((t) => (access ? maskRow(access, 'tasks', t) : t));
    });
    router.post('/api/tasks', 'location', (ctx) => {
      const t = {
        id: id(),
        location_id: ctx.locationId,
        contact_id: ctx.body.contact_id || null,
        title: str(ctx.body.title, 'Titel', { required: true, max: 300 }),
        description: str(ctx.body.description, 'Beschreibung', { max: 5000 }),
        due_at: ctx.body.due_at || null,
        assigned_to: ctx.body.assigned_to || ctx.user?.id || null,
        done: 0,
        created_at: now(),
      };
      if (t.contact_id && !getContact(app, ctx.locationId, t.contact_id)) throw bad('Kontakt nicht gefunden');
      db.insert('tasks', t);
      return t;
    });
    router.patch('/api/tasks/:id', 'location', (ctx) => {
      const patch: Record<string, any> = {};
      for (const k of ['title', 'description', 'due_at', 'assigned_to']) if (ctx.body[k] !== undefined) patch[k] = ctx.body[k];
      if (ctx.body.done !== undefined) {
        patch.done = ctx.body.done ? 1 : 0;
        patch.completed_at = ctx.body.done ? now() : null;
      }
      const wasDone = db.get('SELECT done FROM tasks WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId)?.done;
      if (!db.update('tasks', ctx.params.id, patch, ctx.locationId)) throw notFound();
      const task = db.get('SELECT * FROM tasks WHERE id = ?', ctx.params.id)!;
      if (!wasDone && task.done) app.events.emit(ctx.locationId, 'task.completed', { contactId: task.contact_id ?? undefined, task });
      return task;
    });
    router.delete('/api/tasks/:id', 'location', (ctx) => {
      db.run('DELETE FROM tasks WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      return { ok: true };
    });

    // --- tags ---------------------------------------------------------------
    router.get('/api/tags', 'location', (ctx) =>
      db.all(
        `SELECT t.id, t.name, (SELECT COUNT(*) FROM contacts c, json_each(c.tags) j WHERE c.location_id = t.location_id AND j.value = t.name) AS count
         FROM tags t WHERE t.location_id = ? ORDER BY t.name`,
        ctx.locationId,
      ),
    );
    router.post('/api/tags', 'location', (ctx) => {
      const name = str(ctx.body.name, 'Tag', { required: true, max: 80 });
      db.run('INSERT OR IGNORE INTO tags (id, location_id, name, created_at) VALUES (?, ?, ?, ?)', id(), ctx.locationId, name, now());
      return db.get('SELECT * FROM tags WHERE location_id = ? AND name = ?', ctx.locationId, name);
    });
    router.delete('/api/tags/:id', 'location', (ctx) => {
      const t = db.get('SELECT * FROM tags WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!t) throw notFound();
      db.tx(() => {
        db.run(
          `UPDATE contacts SET tags = (SELECT json_group_array(value) FROM json_each(contacts.tags) WHERE value != ?)
           WHERE location_id = ? AND EXISTS (SELECT 1 FROM json_each(contacts.tags) WHERE value = ?)`,
          t.name,
          ctx.locationId,
          t.name,
        );
        db.run('DELETE FROM tags WHERE id = ?', t.id);
      });
      return { ok: true };
    });

    // --- custom fields ------------------------------------------------------
    const FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'select', 'checkbox', 'email', 'phone', 'url'];
    router.get('/api/custom-fields', 'location', (ctx) => parseRows(db.all('SELECT * FROM custom_fields WHERE location_id = ? ORDER BY position, label', ctx.locationId), ['options']));
    router.post('/api/custom-fields', 'location', (ctx) => {
      const label = str(ctx.body.label, 'Bezeichnung', { required: true, max: 100 });
      const key = (str(ctx.body.key, 'Schlüssel') || slugify(label)).replace(/-/g, '_');
      if (!/^[a-z0-9_]+$/.test(key)) throw bad('Schlüssel nur a-z, 0-9 und _');
      if (db.get('SELECT id FROM custom_fields WHERE location_id = ? AND key = ?', ctx.locationId, key)) throw bad('Schlüssel existiert schon');
      const type = FIELD_TYPES.includes(ctx.body.type) ? ctx.body.type : 'text';
      const row = { id: id(), location_id: ctx.locationId, key, label, type, options: Array.isArray(ctx.body.options) ? ctx.body.options.map(String) : [], position: num(ctx.body.position), created_at: now() };
      db.insert('custom_fields', row);
      return row;
    });
    router.patch('/api/custom-fields/:id', 'location', (ctx) => {
      const patch: Record<string, any> = {};
      if (ctx.body.label !== undefined) patch.label = str(ctx.body.label, 'Bezeichnung', { required: true });
      if (ctx.body.type !== undefined && FIELD_TYPES.includes(ctx.body.type)) patch.type = ctx.body.type;
      if (Array.isArray(ctx.body.options)) patch.options = ctx.body.options.map(String);
      if (ctx.body.position !== undefined) patch.position = num(ctx.body.position);
      if (!db.update('custom_fields', ctx.params.id, patch, ctx.locationId)) throw notFound();
      return parseJson(db.get('SELECT * FROM custom_fields WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId), ['options']);
    });
    router.delete('/api/custom-fields/:id', 'location', (ctx) => {
      db.run('DELETE FROM custom_fields WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      return { ok: true };
    });

    // --- smart lists (saved views): routes in modules/smart-lists.ts (the table stays here) ------

    // --- activity feed ------------------------------------------------------
    router.get('/api/activities', 'location', (ctx) => {
      // A person with a limited view sees the activity of the contacts they may open.
      const scope = contactScopeClause(resolve(app, ctx), 'a.contact_id');
      return parseRows(
        db.all(
          `SELECT a.*, c.first_name, c.last_name, c.email FROM activities a LEFT JOIN contacts c ON c.id = a.contact_id
           WHERE a.location_id = ?${scope ? ` AND ${scope.sql}` : ''} ORDER BY a.created_at DESC LIMIT ?`,
          ctx.locationId,
          ...(scope?.params ?? []),
          clampLimit(ctx.query.get('limit'), 50, 200),
        ),
        ['data'],
      );
    });

    // --- one-click unsubscribe (linked from every email) --------------------
    const unsubscribe = (ctx: Ctx, contactId: string, tokenStr: string) => {
      const c = db.get('SELECT id, location_id FROM contacts WHERE id = ?', contactId);
      if (!c || tokenStr !== unsubscribeToken(app, contactId)) return false;
      db.run('UPDATE contacts SET dnd = 1, updated_at = ? WHERE id = ?', now(), c.id);
      logActivity(app, c.location_id, c.id, 'contact.unsubscribed', 'Vom E-Mail-Versand abgemeldet');
      // The consent ledger records the withdrawal with the proof data of this click (modules/consent.ts).
      app.services.consent?.unsubscribed?.(ctx, c.location_id, c.id);
      app.events.emit(c.location_id, 'contact.unsubscribed', { contactId: c.id });
      return true;
    };
    const unsubscribed = (contactId: string) => app.services.consent?.unsubscribedPage?.(contactId) ?? html(messagePage('Abgemeldet', 'Du bekommst von uns keine Nachrichten mehr.'));
    const invalid = (status = 200) => html(messagePage('Link ungültig', 'Dieser Abmeldelink ist nicht gültig.'), status);
    // The link in the mail opens a page with one button: opening it changes nothing. Link scanners of mail gateways and
    // anti-spam filters fetch every link of a mail (also the List-Unsubscribe header) with GET – that must not unsubscribe anybody.
    router.get('/u/:id/:token', 'public', (ctx) => {
      const c = db.get<{ id: string; location_id: string; dnd: number }>('SELECT id, location_id, dnd FROM contacts WHERE id = ?', ctx.params.id);
      if (!c || ctx.params.token !== unsubscribeToken(app, c.id)) return invalid();
      if (c.dnd) return unsubscribed(c.id);
      const loc = app.location(c.location_id);
      const prefs: string = app.services.consent?.prefsUrl?.(c.id) ?? '';
      const action = `/u/${encodeURIComponent(c.id)}/${encodeURIComponent(ctx.params.token)}`;
      const body = `<div class="wrap" style="max-width:560px"><div class="card">${loc ? `<p class="muted" style="margin:0 0 6px">${escapeHtml(loc.name)}</p>` : ''}<h1>Abmelden?</h1><p class="muted">Du bekommst dann keine E-Mails und SMS mehr von ${escapeHtml(loc?.name ?? 'uns')}.</p><form method="post" action="${escapeHtml(action)}"><input type="hidden" name="confirm" value="1"><button type="submit">Ja, abmelden</button></form>${prefs ? `<p style="margin-top:18px"><a href="${escapeHtml(prefs)}">Lieber nur einstellen, was ich bekomme</a></p>` : ''}</div></div>`;
      const r = html(publicPage({ title: 'Abmelden', body }));
      r.headers['cache-control'] = 'no-store';
      r.headers['x-robots-tag'] = 'noindex, nofollow';
      r.headers['referrer-policy'] = 'no-referrer';
      return r;
    });
    // The button on that page, and RFC 8058 one-click unsubscribe from mail clients (List-Unsubscribe + List-Unsubscribe-Post
    // headers, body "List-Unsubscribe=One-Click"): one POST, no page, no login. A wrong link is an error, not a silent success.
    router.post('/u/:id/:token', 'public', (ctx) => {
      const page = String(ctx.body?.confirm ?? '') === '1';
      if (!unsubscribe(ctx, ctx.params.id, ctx.params.token)) {
        if (page) return invalid(400);
        throw bad('Abmeldelink ungültig');
      }
      return page ? unsubscribed(ctx.params.id) : { ok: true };
    });
  },
};
