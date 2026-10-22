import { rmSync } from 'node:fs';
import type { App } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { id, normalizeEmail, normalizePhone, now, uniq } from '../core/util.js';
import { maskRow, resolve, scopeClause, type Who } from './record-access.js';

export interface Contact {
  id: string;
  location_id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  company: string;
  address: string;
  city: string;
  postal_code: string;
  country: string;
  website: string;
  source: string;
  tags: string[];
  custom: Record<string, any>;
  dnd: number;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
  [k: string]: any;
}

export const CONTACT_FIELDS = ['first_name', 'last_name', 'email', 'phone', 'company', 'address', 'city', 'postal_code', 'country', 'website', 'source', 'assigned_to', 'date_of_birth'] as const;

/**
 * Files on disk that belong to a contact – modules register listers in `app.services.contactFiles`
 * (`(app, locationId, contactId) => string[]`, absolute paths under the data directory). Read them before the contact's rows go
 * (deleting the contact cascades the rows that know the file names) and remove them afterwards with `removeContactFiles`.
 */
export function contactFiles(app: App, locationId: string, contactId: string): string[] {
  const out: string[] = [];
  for (const fn of (app.services.contactFiles ?? []) as ((a: App, l: string, c: string) => string[])[]) {
    try {
      for (const f of fn(app, locationId, contactId) ?? []) if (typeof f === 'string' && f.startsWith(app.config.dataDir)) out.push(f);
    } catch (e) {
      console.error('[contacts] files:', (e as Error).message);
    }
  }
  return out;
}

export function removeContactFiles(files: string[]): void {
  for (const f of files) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* already gone or locked: nothing else to do */
    }
  }
}

export function getContact(app: App, locationId: string, contactId: string): Contact | undefined {
  return parseJson(app.db.get<Contact>('SELECT * FROM contacts WHERE id = ? AND location_id = ?', contactId, locationId), ['tags', 'custom']);
}

export function contactName(c: Partial<Contact> | undefined): string {
  if (!c) return '';
  return [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || c.phone || 'Unbekannt';
}

/** Template data for merge fields. */
export function contactVars(c: Contact | undefined) {
  if (!c) return {};
  return { ...c, name: contactName(c), full_name: contactName(c) };
}

export function logActivity(app: App, locationId: string, contactId: string | null, type: string, summary: string, data: Record<string, any> = {}) {
  app.db.insert('activities', { id: id(), location_id: locationId, contact_id: contactId, type, summary, data, created_at: now() });
  if (contactId) app.db.run('UPDATE contacts SET last_activity_at = ? WHERE id = ?', now(), contactId);
}

function clean(input: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const k of CONTACT_FIELDS) if (input[k] !== undefined && input[k] !== null) out[k] = String(input[k]).trim().slice(0, 500);
  // Common aliases from forms and imports.
  if (input.firstName !== undefined) out.first_name ??= String(input.firstName).trim();
  if (input.lastName !== undefined) out.last_name ??= String(input.lastName).trim();
  if (input.name && !out.first_name && !out.last_name) {
    const [first, ...rest] = String(input.name).trim().split(/\s+/);
    out.first_name = first;
    out.last_name = rest.join(' ');
  }
  if (out.email !== undefined) out.email = normalizeEmail(out.email);
  if (out.phone !== undefined) out.phone = normalizePhone(out.phone);
  return out;
}

/** The digits that make two notations of one number equal ("+49 151 1234567" = "0151 1234567"). */
const sameNumber = (a: string, b: string) => {
  const key = (p: string) => p.replace(/\D/g, '').replace(/^00|^0/, '').slice(-9);
  return a === b || (key(a).length >= 7 && key(a) === key(b));
};
const IDENTITY = ['email', 'phone'] as const;
const IDENTITY_LABEL: Record<(typeof IDENTITY)[number], string> = { email: 'E-Mail-Adresse', phone: 'Telefonnummer' };

/**
 * Creates a contact or merges into the one with the same email (then phone), like GHL's
 * "allow duplicate contacts: off". Emits contact.created / contact.updated / contact.tag_added.
 *
 * `publicInput`: the values come from somebody who has not proven who they are (public forms, booking pages, the chat widget, webinar
 * registration, the AI agents talking to visitors and callers, Stripe Checkout and Meta lead forms). Such input never changes the e-mail address or
 * phone number already stored on a contact (an empty one is filled), and a phone number only finds a contact when the input has no
 * e-mail address of its own – "known number + my address" creates a new contact that the duplicate check shows next to the old one.
 * A differing number on a contact found by its e-mail address is kept as an unverified alternative on the timeline (docs/sales.md#duplicate-assistant).
 */
export function upsertContact(
  app: App,
  locationId: string,
  input: Record<string, any>,
  opts: { source?: string; tags?: string[]; quiet?: boolean; publicInput?: boolean } = {},
): { contact: Contact; created: boolean } {
  const fields = clean(input);
  const tags = uniq([...(Array.isArray(input.tags) ? input.tags : []), ...(opts.tags ?? [])].map((t) => String(t).trim()).filter(Boolean));
  const custom = input.custom && typeof input.custom === 'object' ? input.custom : {};

  let existing: Contact | undefined;
  if (input.id) existing = getContact(app, locationId, String(input.id));
  if (!existing && fields.email) existing = parseJson(app.db.get<Contact>('SELECT * FROM contacts WHERE location_id = ? AND email = ?', locationId, fields.email), ['tags', 'custom']);
  if (!existing && fields.phone && !(opts.publicInput && fields.email)) existing = parseJson(app.db.get<Contact>('SELECT * FROM contacts WHERE location_id = ? AND phone = ?', locationId, fields.phone), ['tags', 'custom']);

  if (!existing) {
    const c = {
      id: id(),
      location_id: locationId,
      first_name: '',
      last_name: '',
      email: '',
      phone: '',
      company: '',
      address: '',
      city: '',
      postal_code: '',
      country: '',
      website: '',
      ...fields,
      source: fields.source || opts.source || 'manuell',
      tags,
      custom,
      dnd: input.dnd ? 1 : 0,
      created_at: input.created_at || now(),
      updated_at: now(),
    };
    app.db.insert('contacts', c);
    ensureTags(app, locationId, tags);
    const contact = getContact(app, locationId, c.id)!;
    logActivity(app, locationId, c.id, 'contact.created', `Kontakt angelegt (${c.source})`);
    // Public input with a known number but another address: a contact of its own (see above); say why there are two.
    if (opts.publicInput && fields.email && fields.phone && app.db.get('SELECT 1 AS x FROM contacts WHERE location_id = ? AND phone = ? AND id <> ?', locationId, fields.phone, c.id)) {
      logActivity(app, locationId, c.id, 'contact.possible_duplicate', 'Gleiche Telefonnummer wie ein bestehender Kontakt mit anderer E-Mail-Adresse – nicht zusammengeführt (öffentliche Eingabe). Ist es dieselbe Person, in den Dubletten zusammenführen.', { phone: fields.phone, source: c.source });
    }
    if (!opts.quiet) {
      app.events.emit(locationId, 'contact.created', { contactId: c.id, contact });
      for (const t of tags) app.events.emit(locationId, 'contact.tag_added', { contactId: c.id, tag: t, contact });
    }
    return { contact, created: true };
  }

  const patch: Record<string, any> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== '' && k !== 'source') patch[k] = v;
  if (opts.publicInput) {
    for (const k of IDENTITY) {
      const had = String(existing[k] ?? '');
      const got = patch[k] as string | undefined;
      if (got === undefined || !had) continue;
      delete patch[k];
      if (k === 'phone' ? sameNumber(had, got) : had === got) continue;
      // Never overwritten from unproven input: the value stays visible to the team as an unverified alternative.
      const source = fields.source || opts.source || 'öffentliche Eingabe';
      logActivity(app, locationId, existing.id, 'contact.unverified_alternative', `Abweichende ${IDENTITY_LABEL[k]} aus „${source}“ nicht übernommen (unbestätigt): ${got}`, { field: k, value: got, source });
    }
  }
  const newTags = tags.filter((t) => !existing!.tags.includes(t));
  if (newTags.length) patch.tags = [...existing.tags, ...newTags];
  if (Object.keys(custom).length) patch.custom = { ...existing.custom, ...custom };
  if (input.dnd !== undefined) patch.dnd = input.dnd ? 1 : 0;
  patch.updated_at = now();
  app.db.update('contacts', existing.id, patch);
  ensureTags(app, locationId, newTags);
  const contact = getContact(app, locationId, existing.id)!;
  if (!opts.quiet) {
    app.events.emit(locationId, 'contact.updated', { contactId: contact.id, contact, previous: existing });
    for (const t of newTags) app.events.emit(locationId, 'contact.tag_added', { contactId: contact.id, tag: t, contact });
  }
  return { contact, created: false };
}

export function ensureTags(app: App, locationId: string, tags: string[]) {
  for (const t of tags) app.db.run('INSERT OR IGNORE INTO tags (id, location_id, name, created_at) VALUES (?, ?, ?, ?)', id(), locationId, t, now());
}

export function addTags(app: App, locationId: string, contactId: string, tags: string[]) {
  const c = getContact(app, locationId, contactId);
  if (!c) return;
  const add = uniq(tags.map((t) => t.trim()).filter((t) => t && !c.tags.includes(t)));
  if (!add.length) return;
  app.db.update('contacts', c.id, { tags: [...c.tags, ...add], updated_at: now() });
  ensureTags(app, locationId, add);
  const contact = getContact(app, locationId, contactId)!;
  for (const t of add) {
    logActivity(app, locationId, contactId, 'tag.added', `Tag „${t}“ hinzugefügt`);
    app.events.emit(locationId, 'contact.tag_added', { contactId, tag: t, contact });
  }
}

export function removeTags(app: App, locationId: string, contactId: string, tags: string[]) {
  const c = getContact(app, locationId, contactId);
  if (!c) return;
  const drop = tags.filter((t) => c.tags.includes(t));
  if (!drop.length) return;
  app.db.update('contacts', c.id, { tags: c.tags.filter((t) => !drop.includes(t)), updated_at: now() });
  const contact = getContact(app, locationId, contactId)!;
  for (const t of drop) {
    logActivity(app, locationId, contactId, 'tag.removed', `Tag „${t}“ entfernt`);
    app.events.emit(locationId, 'contact.tag_removed', { contactId, tag: t, contact });
  }
}

/** Contacts matching a smart-list style filter: tags (all of), any-of tags, search text. */
export function findContacts(app: App, locationId: string, f: { tags?: string[]; anyTags?: string[]; excludeTags?: string[]; q?: string; limit?: number; offset?: number; sort?: string; /** asc | desc for `sort` (else the column's natural order). */ dir?: string; query?: URLSearchParams; extra?: Record<string, unknown>; noTotal?: boolean; /** The person asking: the record-access rules (docs/sales.md) narrow the list and hide fields. Without it: everything (automations). */ who?: Who }) {
  const where = ['location_id = ?'];
  const params: any[] = [locationId];
  for (const t of f.tags ?? []) {
    where.push(`EXISTS (SELECT 1 FROM json_each(contacts.tags) WHERE value = ?)`);
    params.push(t);
  }
  if (f.anyTags?.length) {
    where.push(`EXISTS (SELECT 1 FROM json_each(contacts.tags) WHERE value IN (${f.anyTags.map(() => '?').join(',')}))`);
    params.push(...f.anyTags);
  }
  for (const t of f.excludeTags ?? []) {
    where.push(`NOT EXISTS (SELECT 1 FROM json_each(contacts.tags) WHERE value = ?)`);
    params.push(t);
  }
  if (f.q) {
    where.push(`(first_name || ' ' || last_name || ' ' || email || ' ' || phone || ' ' || company) LIKE ?`);
    params.push(`%${f.q}%`);
  }
  const access = f.who ? resolve(app, { ...f.who, locationId }) : null;
  const scope = scopeClause(access, 'contacts', 'contacts');
  if (scope) (where.push(scope.sql), params.push(...scope.params));
  // Filters other modules add (e.g. attribution source): app.services.contactFilters = [(f) => ({ sql, params }) | undefined].
  for (const fn of app.services.contactFilters ?? []) {
    const x = fn(f);
    if (x?.sql) (where.push(x.sql), params.push(...x.params));
  }
  // Sort orders other modules add (e.g. lead score): app.services.contactSorts = { key: (locationId) => 'ORDER BY sql' }.
  const extSort = f.sort ? app.services.contactSorts?.[f.sort] : undefined;
  // Any column incl. custom fields, either direction (modules/smart-lists.ts): `(locationId, key, dir) => { sql, params } | undefined`.
  const ordered: { sql: string; params: (string | number)[] } | undefined = !extSort && f.sort ? app.services.contactOrder?.(locationId, f.sort, f.dir ?? f.query?.get('dir') ?? '') : undefined;
  const order = extSort ? extSort(locationId) : ordered ? ordered.sql : f.sort === 'name' ? 'first_name, last_name' : f.sort === 'activity' ? 'last_activity_at DESC' : 'created_at DESC';
  // `noTotal`: callers that page through everything (the CSV export) skip the count – a full scan per page.
  const total = f.noTotal ? 0 : app.db.get<{ n: number }>(`SELECT COUNT(*) n FROM contacts WHERE ${where.join(' AND ')}`, ...params)!.n;
  const rows = app.db.all<Contact>(
    `SELECT * FROM contacts WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ...params,
    ...(ordered?.params ?? []),
    f.limit ?? 50,
    f.offset ?? 0,
  );
  return { total, contacts: rows.map((r) => maskRow(access, 'contacts', parseJson(r, ['tags', 'custom']))) };
}
