import type { App, Module } from '../core/app.js';
import { bad, str } from '../core/http.js';
import { id, now } from '../core/util.js';
import { logActivity, upsertContact } from '../services/contacts.js';
import { getOrCreateConversation } from '../services/messaging.js';

/**
 * Bring existing mail (e.g. a Gmail export, read via the Gmail API by an assistant) into
 * Konversationen: contacts are matched by e-mail, every message is stored once (by its external id),
 * and unsent drafts show up as drafts in the thread.
 */

const DIRECTIONS = ['in', 'out'];

function addrOf(v: unknown): { email: string; name: string } {
  const s = String(v ?? '').trim();
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  return { name: '', email: s.toLowerCase() };
}

export interface ImportOptions {
  tags?: string[];
  ownAddress?: string;
  source?: string;
}

/** Stores mail once per external id, matched to contacts; used by the import API and the IMAP sync. */
export function importMessages(app: App, locationId: string, list: any[], opts: ImportOptions = {}) {
  const { db } = app;
  const tags = (opts.tags ?? []).map(String).slice(0, 10);
  const own = String(opts.ownAddress ?? '').toLowerCase();
  const sourceLabel = String(opts.source ?? '').slice(0, 60) || 'E-Mail-Import';
  let created = 0;
  let skipped = 0;
  const contacts = new Set<string>();
  const touched = new Set<string>();
  for (const m of list) {
    const externalId = String(m.external_id ?? '').slice(0, 200);
    if (!externalId) throw bad('external_id fehlt');
    if (db.get('SELECT id FROM messages WHERE location_id = ? AND external_id = ?', locationId, externalId)) {
      skipped++;
      continue;
    }
    const draft = m.status === 'draft';
    const direction = draft ? 'out' : DIRECTIONS.includes(m.direction) ? m.direction : addrOf(m.from).email === own ? 'out' : 'in';
    const party = direction === 'in' ? addrOf(m.from) : addrOf(Array.isArray(m.to) ? m.to[0] : m.to);
    const email = (m.contact?.email ? String(m.contact.email).toLowerCase() : party.email).trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      skipped++;
      continue;
    }
    const { contact } = upsertContact(
      app,
      locationId,
      { email, name: m.contact?.name || party.name || undefined, company: m.contact?.company || undefined, website: m.contact?.website || undefined },
      { source: sourceLabel, tags, quiet: true },
    );
    contacts.add(contact.id);
    const conversationId = getOrCreateConversation(app, locationId, contact.id);
    const at = m.date && !Number.isNaN(new Date(m.date).getTime()) ? new Date(m.date).toISOString() : now();
    const body = String(m.body ?? '').slice(0, 100_000);
    db.insert('messages', {
      id: id(),
      location_id: locationId,
      conversation_id: conversationId,
      contact_id: contact.id,
      channel: 'email',
      direction,
      subject: String(m.subject ?? '').slice(0, 300),
      body,
      status: draft ? 'draft' : direction === 'in' ? 'received' : 'sent',
      error: '',
      source: sourceLabel,
      external_id: externalId,
      created_at: at,
    });
    if (direction === 'in' && !draft && m.unread) db.run('UPDATE conversations SET unread = unread + 1 WHERE id = ?', conversationId);
    touched.add(conversationId);
    created++;
  }
  // The thread's preview follows its newest message (imported mail may be older than the thread).
  for (const cid of touched) {
    const last = db.get('SELECT subject, body, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1', cid);
    if (last) db.run('UPDATE conversations SET last_message_at = ?, last_message = ? WHERE id = ?', last.created_at, String(last.subject || last.body).slice(0, 140), cid);
  }
  for (const cid of contacts) logActivity(app, locationId, cid, 'email.imported', 'E-Mails importiert');
  return { ok: true, created, skipped, contacts: contacts.size };
}

export const emailImportModule: Module = {
  name: 'email-import',
  migrations: [
    [
      '001-external-id',
      `ALTER TABLE messages ADD COLUMN external_id TEXT;
       CREATE UNIQUE INDEX messages_external ON messages(location_id, external_id) WHERE external_id IS NOT NULL;`,
    ],
  ],
  register(app) {
    const { db, router } = app;

    router.post('/api/conversations/import', 'location', (ctx) => {
      const list = Array.isArray(ctx.body.messages) ? ctx.body.messages : null;
      if (!list) throw bad('messages fehlt');
      if (list.length > 500) throw bad('Höchstens 500 Nachrichten pro Aufruf');
      for (const m of list) str(m.external_id, 'external_id', { required: true, max: 200 });
      return importMessages(app, ctx.locationId, list, {
        tags: Array.isArray(ctx.body.tags) ? ctx.body.tags : [],
        ownAddress: ctx.body.own_address,
        source: str(ctx.body.source, 'Quelle', { max: 60 }),
      });
    });

    // Drafts across all threads (to send or discard).
    router.get('/api/conversations/drafts', 'location', (ctx) =>
      db.all(
        `SELECT m.id, m.channel, m.subject, m.body, m.created_at, m.contact_id, m.conversation_id, c.first_name, c.last_name, c.email, c.company
         FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE m.location_id = ? AND m.status = 'draft' ORDER BY m.created_at DESC LIMIT 500`,
        ctx.locationId,
      ),
    );
    router.delete('/api/messages/:id', 'location', (ctx) => {
      const n = db.run(`DELETE FROM messages WHERE id = ? AND location_id = ? AND status = 'draft'`, ctx.params.id, ctx.locationId).changes;
      if (!n) throw bad('Nur Entwürfe lassen sich löschen');
      return { ok: true };
    });
  },
};
