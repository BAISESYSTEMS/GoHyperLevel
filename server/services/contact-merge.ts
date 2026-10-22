import type { App } from '../core/app.js';
import type { Row } from '../core/db.js';
import { HttpError, bad, notFound } from '../core/http.js';
import { now } from '../core/util.js';
import { contactName, getContact, logActivity, type Contact } from './contacts.js';
import { tableMeta } from './undo-core.js';
import type { PartSpec } from './undo-table.js';

/**
 * Merging two contacts into one. Everything that points at the contact is carried over to the one that stays – deals, tasks, notes,
 * messages, appointments, invoices, quotes, consent proof, activities … – found by looking at the schema, so a table another module
 * adds later moves along without anyone listing it. What cannot move: rows keyed by the contact itself (memberships, lead scores …,
 * dropped with the second contact and counted in the preview) and finalised invoices (frozen by law: they lose the link, which
 * the person has to confirm). The two conversations become one. The journal (undo) gets every moved row, so "Rückgängig" puts
 * everything back (see contact-duplicates.ts, which registers the entity).
 */

export const MERGE_FIELDS: { key: string; label: string }[] = [
  { key: 'first_name', label: 'Vorname' },
  { key: 'last_name', label: 'Nachname' },
  { key: 'email', label: 'E-Mail' },
  { key: 'phone', label: 'Telefon' },
  { key: 'company', label: 'Firma' },
  { key: 'address', label: 'Adresse' },
  { key: 'postal_code', label: 'PLZ' },
  { key: 'city', label: 'Ort' },
  { key: 'country', label: 'Land' },
  { key: 'website', label: 'Website' },
  { key: 'source', label: 'Quelle' },
  { key: 'date_of_birth', label: 'Geburtstag' },
  { key: 'assigned_to', label: 'Zuständig' },
];

/** What the person reads in the preview for the tables that matter to them; everything else is counted as "weitere Verknüpfungen". */
export const TABLE_LABEL: Record<string, string> = {
  opportunities: 'Deals',
  tasks: 'Aufgaben',
  notes: 'Notizen',
  messages: 'Nachrichten',
  activities: 'Aktivitäten',
  appointments: 'Termine',
  invoices: 'Rechnungen',
  contracts: 'Verträge',
  tickets: 'Tickets',
  deal_quotes: 'Angebote',
  calls: 'Anrufe',
  form_submissions: 'Formular-Antworten',
  consent_events: 'Einwilligungs-Nachweise',
  sequence_enrollments: 'Sequenzen',
};

/** Tables that are never touched: the journal itself and the duplicate assistant's own memory. */
const EXCLUDE = new Set(['contacts', 'undo_entries', 'contact_dupe_ignores']);

export interface LinkTable {
  table: string;
  pk: string[];
  cols: string[];
  /** The columns undo has to set back (`contact_id`, and `conversation_id` where a table has one). */
  patch: string[];
  /** The table has an UPDATE trigger that may refuse a change (frozen invoices): rows move one by one. */
  guarded: boolean;
}

const cache = new WeakMap<object, { move: LinkTable[]; lost: string[] }>();

const touchesContactId = (sql: string): boolean => {
  const m = /UPDATE(?:\s+OF\s+([\w,\s]+?))?\s+ON\b/i.exec(sql);
  if (!m) return false;
  return m[1] === undefined ? true : /\bcontact_id\b/.test(m[1]);
};

/** The tables that point at a contact: those that move with a merge, and those that are dropped with the second contact. */
export function linkTables(app: App): { move: LinkTable[]; lost: string[] } {
  const hit = cache.get(app.db);
  if (hit) return hit;
  const { db } = app;
  const move: LinkTable[] = [];
  const lost: string[] = [];
  const guards = new Map<string, boolean>();
  for (const t of db.all<{ tbl_name: string; sql: string }>(`SELECT tbl_name, sql FROM sqlite_master WHERE type = 'trigger'`)) if (touchesContactId(t.sql)) guards.set(t.tbl_name, true);
  for (const { name } of db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)) {
    if (EXCLUDE.has(name)) continue;
    const m = tableMeta(db, name);
    if (!m.cols.includes('contact_id')) continue;
    if (m.pk.includes('contact_id')) {
      lost.push(name);
      continue;
    }
    move.push({ table: name, pk: m.pk, cols: m.cols, patch: ['contact_id', ...(m.cols.includes('conversation_id') ? ['conversation_id'] : [])], guarded: guards.has(name) });
  }
  const out = { move, lost };
  cache.set(app.db, out);
  return out;
}

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

export const CONV_SUMMARY = ['unread', 'starred', 'last_message', 'last_message_at', 'last_in_at', 'last_out_at', 'awaiting_since'];
const convSummaryCols = (app: App): string[] => {
  const cols = tableMeta(app.db, 'conversations').cols;
  return CONV_SUMMARY.filter((c) => cols.includes(c));
};

/** What the journal keeps with a merged contact so that undo can put the moved rows back (see contact-duplicates.ts). */
export function mergeParts(app: App, row: Row, heavy: boolean): PartSpec[] {
  const { db } = app;
  const parts: PartSpec[] = [];
  if (db.get(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'associations'`)) {
    parts.push({ name: 'associations', table: 'associations', pk: ['id'], mode: 'replace', where: { sql: `location_id = ? AND ((a_type = 'contact' AND a_id = ?) OR (b_type = 'contact' AND b_id = ?))`, params: [row.location_id, row.id, row.id] } });
  }
  const summary = convSummaryCols(app);
  if (summary.length) parts.push({ name: 'conversation', table: 'conversations', pk: ['id'], cols: summary, mode: 'patch', fp: false, where: { sql: 'location_id = ? AND contact_id = ?', params: [row.location_id, row.id] } });
  if (heavy) {
    for (const t of linkTables(app).move) {
      if (!t.pk.length) continue;
      parts.push({ name: t.table, table: t.table, pk: t.pk, cols: t.patch, mode: 'patch', fp: false, where: { sql: `${q('contact_id')} = ?`, params: [row.id] } });
    }
  }
  return parts;
}

/** Tables the journal must not walk when it follows foreign keys of a merged contact: their rows are moved, the parts bring them back. */
/** (The conversation is the exception: the second contact's one is deleted by the merge, so the journal has to bring it back itself.) */
export const skipKidsOf = (app: App): string[] => linkTables(app).move.map((t) => t.table).filter((t) => t !== 'conversations');

// --- looking before merging --------------------------------------------------------------------------------------------------------

const customOf = (c: Contact) => (c.custom && typeof c.custom === 'object' ? c.custom : {});
const filled = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== '';

export interface FieldRow {
  key: string;
  label: string;
  keep: unknown;
  from: unknown;
  differs: boolean;
  /** Which value the merge takes unless the person picks the other. */
  pick: 'keep' | 'from';
}

/** Field by field: the default is the kept contact's value, filled from the other where it is empty. */
export function compareFields(keep: Contact, from: Contact): { fields: FieldRow[]; custom: FieldRow[]; tags: { keep: string[]; from: string[]; merged: string[] } } {
  const row = (key: string, label: string, a: unknown, b: unknown): FieldRow => ({ key, label, keep: a ?? '', from: b ?? '', differs: filled(a) && filled(b) && String(a) !== String(b), pick: filled(a) || !filled(b) ? 'keep' : 'from' });
  const fields = MERGE_FIELDS.map((f) => row(f.key, f.label, (keep as any)[f.key], (from as any)[f.key]));
  const ck = customOf(keep);
  const cf = customOf(from);
  const custom = [...new Set([...Object.keys(ck), ...Object.keys(cf)])].map((k) => row(`custom.${k}`, k, ck[k], cf[k]));
  return { fields, custom, tags: { keep: keep.tags, from: from.tags, merged: [...new Set([...keep.tags, ...from.tags])] } };
}

export function countsFor(app: App, contactId: string) {
  const { move, lost } = linkTables(app);
  const labelled: Record<string, number> = {};
  let other = 0;
  for (const t of move) {
    const n = Number(app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${q(t.table)} WHERE contact_id = ?`, contactId)?.n ?? 0);
    if (!n) continue;
    if (TABLE_LABEL[t.table]) labelled[TABLE_LABEL[t.table]] = (labelled[TABLE_LABEL[t.table]] ?? 0) + n;
    else other += n;
  }
  let dropped = 0;
  for (const t of lost) dropped += Number(app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${q(t)} WHERE contact_id = ?`, contactId)?.n ?? 0);
  return { labelled, other, dropped };
}

/** Finalised invoices cannot change their customer. */
export const frozenInvoices = (app: App, contactId: string): number =>
  tableMeta(app.db, 'invoices').cols.includes('finalised_at') ? Number(app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM invoices WHERE contact_id = ? AND finalised_at IS NOT NULL', contactId)?.n ?? 0) : 0;

// --- merging -----------------------------------------------------------------------------------------------------------------------

export interface MergeInput {
  keepId: string;
  fromId: string;
  /** Per field (`custom.<key>` for custom fields): take the other contact's value. */
  picks?: Record<string, unknown>;
  userId?: string | null;
  /** The second contact's finalised invoices lose their link to a customer. */
  confirmDetach?: boolean;
}

export interface MergeResult {
  contact: Contact;
  moved: Record<string, number>;
  other: number;
  dropped: number;
  detached: number;
}

function moveRows(app: App, t: LinkTable, keepId: string, fromId: string): number {
  const { db } = app;
  if (!t.guarded) return db.run(`UPDATE OR IGNORE ${q(t.table)} SET contact_id = ? WHERE contact_id = ?`, keepId, fromId).changes;
  // A trigger may refuse a row (a finalised invoice): one by one, a refused row stays where it is.
  let n = 0;
  const ids = db.all<Row>(`SELECT ${t.pk.length ? t.pk.map(q).join(', ') : 'rowid AS rid'} FROM ${q(t.table)} WHERE contact_id = ?`, fromId);
  for (const r of ids) {
    const where = t.pk.length ? t.pk.map((c) => `${q(c)} = ?`).join(' AND ') : 'rowid = ?';
    const vals = t.pk.length ? t.pk.map((c) => r[c]) : [r.rid];
    try {
      n += db.tx(() => db.run(`UPDATE OR IGNORE ${q(t.table)} SET contact_id = ? WHERE ${where}`, keepId, ...vals).changes);
    } catch {
      /* stays with the second contact */
    }
  }
  return n;
}

/** Puts the second contact's messages into the kept contact's conversation and deletes the empty one. */
function mergeConversations(app: App, loc: string, keepId: string, fromId: string): void {
  const { db } = app;
  const fromConv = db.get<{ id: string }>('SELECT id FROM conversations WHERE location_id = ? AND contact_id = ?', loc, fromId);
  if (!fromConv) return;
  const keepConv = db.get<Row>('SELECT * FROM conversations WHERE location_id = ? AND contact_id = ?', loc, keepId);
  if (!keepConv) {
    db.run('UPDATE conversations SET contact_id = ? WHERE id = ?', keepId, fromConv.id);
    return;
  }
  db.run('UPDATE messages SET conversation_id = ?, contact_id = ? WHERE conversation_id = ?', keepConv.id, keepId, fromConv.id);
  // everything else that hangs on the conversation (the team inbox's timeline, response log …)
  for (const { name } of db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)) {
    if (name === 'conversations' || name === 'messages' || name === 'undo_entries') continue;
    if (tableMeta(db, name).cols.includes('conversation_id')) db.run(`UPDATE OR IGNORE ${q(name)} SET conversation_id = ? WHERE conversation_id = ?`, keepConv.id, fromConv.id);
  }
  const cols = tableMeta(db, 'conversations').cols;
  const last = db.get<{ body: string; created_at: string }>('SELECT body, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1', keepConv.id);
  const patch: Record<string, unknown> = {
    unread: Number(keepConv.unread ?? 0) + Number(db.get<{ unread: number }>('SELECT unread FROM conversations WHERE id = ?', fromConv.id)?.unread ?? 0),
    starred: Number(keepConv.starred) || Number(db.get<{ starred: number }>('SELECT starred FROM conversations WHERE id = ?', fromConv.id)?.starred) ? 1 : 0,
  };
  if (last) {
    patch.last_message_at = last.created_at;
    patch.last_message = String(last.body).replace(/\s+/g, ' ').slice(0, 140);
  }
  if (cols.includes('last_in_at')) patch.last_in_at = db.get<{ m: string | null }>(`SELECT MAX(created_at) AS m FROM messages WHERE conversation_id = ? AND direction = 'in' AND channel != 'call'`, keepConv.id)?.m ?? null;
  const sets = Object.keys(patch);
  db.run(`UPDATE conversations SET ${sets.map((k) => `${q(k)} = ?`).join(', ')} WHERE id = ?`, ...(sets.map((k) => patch[k]) as any[]), keepConv.id);
  db.run('DELETE FROM conversations WHERE id = ?', fromConv.id);
}

/** The links of the second contact (company, deals …) become links of the kept one. */
function mergeAssociations(app: App, loc: string, keepId: string, fromId: string): void {
  const svc = app.services.associations as { link(loc: string, a: any, b: any, o?: any): unknown } | undefined;
  const { db } = app;
  if (!svc || !db.get(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'associations'`)) return;
  for (const r of db.all<Row>(`SELECT * FROM associations WHERE location_id = ? AND ((a_type = 'contact' AND a_id = ?) OR (b_type = 'contact' AND b_id = ?))`, loc, fromId, fromId)) {
    const side = r.a_type === 'contact' && r.a_id === fromId ? { type: r.b_type, id: r.b_id } : { type: r.a_type, id: r.a_id };
    if (side.type === 'contact' && side.id === keepId) continue;
    const aIsFrom = r.a_type === 'contact' && r.a_id === fromId;
    try {
      // keep the direction of the original link
      svc.link(loc, aIsFrom ? { type: 'contact', id: keepId } : side, aIsFrom ? side : { type: 'contact', id: keepId }, { labels: JSON.parse(r.labels || '[]'), addLabels: true });
    } catch {
      /* a link the schema refuses is dropped with the contact */
    }
    if (r.primary_of && r.primary_of === fromId) db.run(`UPDATE associations SET primary_of = ? WHERE location_id = ? AND primary_of = ? AND id != ?`, keepId, loc, fromId, r.id);
  }
}

export function mergeContacts(app: App, loc: string, o: MergeInput): MergeResult {
  const { db } = app;
  if (o.keepId === o.fromId) throw bad('Zweimal derselbe Kontakt');
  const keep = getContact(app, loc, o.keepId);
  const from = getContact(app, loc, o.fromId);
  if (!keep || !from) throw notFound('Kontakt nicht gefunden');
  const frozen = frozenInvoices(app, from.id);
  if (frozen && !o.confirmDetach) {
    throw new HttpError(409, `Der zweite Kontakt hat ${frozen} festgeschriebene ${frozen === 1 ? 'Rechnung' : 'Rechnungen'}. Festgeschriebene Rechnungen lassen sich nicht auf einen anderen Kontakt umstellen – sie würden beim Zusammenführen die Verknüpfung zum Kontakt verlieren. Behalte lieber den Kontakt mit den Rechnungen (Rollen tauschen) oder bestätige das Lösen der Verknüpfung.`, { code: 'frozen_invoices', count: frozen });
  }
  const picks = o.picks ?? {};
  const cmp = compareFields(keep, from);
  const wantFrom = (key: string, def: 'keep' | 'from') => (picks[key] === 'from' ? 'from' : picks[key] === 'keep' ? 'keep' : def);
  const patch: Record<string, unknown> = {};
  for (const f of cmp.fields) {
    const side = wantFrom(f.key, f.pick);
    const v = side === 'from' ? f.from : f.keep;
    // an empty pick never wipes a value the other contact has
    const value = filled(v) ? v : filled(side === 'from' ? f.keep : f.from) && picks[f.key] === undefined ? (side === 'from' ? f.keep : f.from) : v;
    if (String(value ?? '') !== String((keep as any)[f.key] ?? '')) patch[f.key] = value === '' && (f.key === 'date_of_birth' || f.key === 'assigned_to') ? null : value;
  }
  const custom: Record<string, unknown> = { ...customOf(keep) };
  for (const c of cmp.custom) {
    const side = wantFrom(c.key, c.pick);
    const k = c.key.slice('custom.'.length);
    const v = side === 'from' ? c.from : c.keep;
    if (filled(v)) custom[k] = v;
    else if (!filled(c.keep) && !filled(c.from)) delete custom[k];
  }
  if (JSON.stringify(custom) !== JSON.stringify(customOf(keep))) patch.custom = custom;
  if (cmp.tags.merged.length !== keep.tags.length) patch.tags = cmp.tags.merged;
  // "Nicht stören" of either contact holds for the merged one.
  if (from.dnd && !keep.dnd) patch.dnd = 1;

  const moved: Record<string, number> = {};
  let other = 0;
  let detached = 0;
  const counts = countsFor(app, from.id);
  db.tx(() => {
    for (const t of linkTables(app).move) {
      const before = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${q(t.table)} WHERE contact_id = ?`, from.id)?.n ?? 0);
      if (!before) continue;
      const n = moveRows(app, t, keep.id, from.id);
      if (TABLE_LABEL[t.table]) moved[TABLE_LABEL[t.table]] = (moved[TABLE_LABEL[t.table]] ?? 0) + n;
      else other += n;
      if (t.table === 'invoices') detached += before - n;
    }
    mergeConversations(app, loc, keep.id, from.id);
    mergeAssociations(app, loc, keep.id, from.id);
    // The second contact goes (rows keyed by it are dropped with it), then the kept one takes the chosen values – the e-mail or
    // number of the one that left may be exactly what the person picked.
    db.run('DELETE FROM contacts WHERE id = ? AND location_id = ?', from.id, loc);
    db.update('contacts', keep.id, { ...patch, updated_at: now() }, loc);
    logActivity(app, loc, keep.id, 'contact.merged', `„${contactName(from)}“ zusammengeführt`, {
      from: { id: from.id, first_name: from.first_name, last_name: from.last_name, email: from.email, phone: from.phone, company: from.company, address: from.address, city: from.city, postal_code: from.postal_code, tags: from.tags, custom: from.custom, assigned_to: from.assigned_to, created_at: from.created_at },
      moved,
      user_id: o.userId ?? null,
    });
  });
  const contact = getContact(app, loc, keep.id)!;
  // "Nicht stören" is not announced as a change: the consent ledger of the second contact came along with its proof, a second
  // "revoked" entry would only clutter it (and an undo could not take it back) – but running sequences must stop.
  if (patch.dnd) (app.services.sequences as { stopContact?: (l: string, c: string, r: string, o?: unknown) => void } | undefined)?.stopContact?.(loc, keep.id, 'unsubscribed', { detail: 'Nicht stören (zusammengeführt)' });
  app.events.emit(loc, 'contact.updated', { contactId: keep.id, contact, previous: keep, changed: ['merged', ...Object.keys(patch).filter((k) => k !== 'dnd')] });
  app.events.emit(loc, 'contact.merged', { contactId: keep.id, contact, fromId: from.id });
  return { contact, moved, other, dropped: counts.dropped, detached };
}
