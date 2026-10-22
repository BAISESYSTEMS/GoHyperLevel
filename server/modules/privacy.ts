import { existsSync, rmSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { App, Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { extFor } from '../core/files.js';
import { normalizeEmail, now } from '../core/util.js';
import { contactFiles } from '../services/contacts.js';
import type { Tool } from './mcp.js';

/**
 * GDPR helpers (Art. 15 access, Art. 17 erasure) for one contact – across every module:
 *
 * - Export: the contact plus every row of every table that points at it (`contact_id`), the form
 *   submissions, uploaded files (as metadata) – tokens, hashes and secrets left out.
 * - Erase: files on disk (form uploads, community images), rows that would survive the contact
 *   (tickets, form submissions, calls, appointments, attribution visitors, activity log…), partner
 *   records with the same e-mail, then the contact itself (everything with ON DELETE CASCADE goes
 *   with it). Invoices and signed contracts are kept – the law requires them (Art. 17(3)(b)) –
 *   and only lose the link to the contact.
 *
 * Other modules can add their own steps: app.services.privacyErase / privacyExport
 * (`(app, locationId, contact) => void | Record<string, unknown>`); an erase step runs inside the transaction. The person's files
 * that other modules keep come from `app.services.contactFiles` (services/contacts.ts) and are deleted after the commit.
 */

/**
 * Kept, only unlinked: legal retention (accounting, signed contracts, sent payment reminders – § 147 AO, § 257 HGB) and records
 * that are the agency's own business rather than the person's data (projects and retainers with their time and billing history,
 * payment plans whose payments point at invoices).
 */
const RETAIN = new Set([
  'invoices',
  'invoice_items',
  'contracts',
  'affiliate_commissions',
  'stripe_checkouts',
  'checkout_acceptances',
  'saas_subscriptions',
  'ai_calls',
  'google_reviews',
  'video_jobs',
  'dunning_notices',
  'plan_subscriptions',
  'pm_projects',
  'pm_retainers',
]);
/** Tables whose rows belong to the person through one of its records (child, column, parent with contact_id). */
const CHILDREN: [child: string, fk: string, parent: string][] = [
  ['form_files', 'submission_id', 'form_submissions'],
  ['ticket_events', 'ticket_id', 'tickets'],
  ['webinar_votes', 'registration_id', 'webinar_registrations'],
];
/** Columns never exported (credentials, capability links, hashes). */
const HIDDEN = /token|secret|hash|password|sealed|api_key|webhook_key|^key$/i;

interface Contact {
  id: string;
  location_id: string;
  email?: string;
  phone?: string;
  first_name?: string;
  last_name?: string;
  [k: string]: unknown;
}

function tables(app: App): { name: string; cols: string[] }[] {
  return app.db
    .all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' AND name != '_migrations'`)
    .map((t) => ({ name: t.name, cols: app.db.all<{ name: string }>(`PRAGMA table_info("${t.name}")`).map((c) => c.name) }));
}

/** How free text (audit log, timelines of other records) names the person: e-mail, full name, phone number. */
function mentionsOf(c: Contact): string[] {
  const full = [c.first_name, c.last_name].map((s) => String(s ?? '').trim()).filter(Boolean);
  const out = [String(c.email ?? '').trim(), full.length === 2 ? full.join(' ') : '', String(c.phone ?? '').trim()];
  return [...new Set(out.filter((s) => s.length >= 5))];
}

const clean = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([k]) => !HIDDEN.test(k)).map(([k, v]) => [k, typeof v === 'string' && /^[[{]/.test(v) ? safeJson(v) : v]));
function safeJson(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/**
 * Who asks for an export made in the app: a member (not an admin, not a key) does not get rows another person marked "Nur für mich"
 * (a `private` flag with `created_by` – the contact's documents), the same rule as the list they come from. Absent = everything
 * (the agency export, the service other modules call).
 */
export interface ExportViewer {
  userId: string | null;
  admin: boolean;
}

/** Everything stored about one contact in one sub-account. */
export function exportContact(app: App, locationId: string, contactId: string, viewer?: ExportViewer) {
  const contact = app.db.get<Contact>('SELECT * FROM contacts WHERE id = ? AND location_id = ?', contactId, locationId);
  if (!contact) throw notFound('Kontakt nicht gefunden');
  const data: Record<string, unknown[]> = {};
  for (const t of tables(app)) {
    if (t.name === 'contacts' || !t.cols.includes('contact_id')) continue;
    const scoped = t.cols.includes('location_id');
    const ownOnly = viewer && !viewer.admin && t.cols.includes('private') && t.cols.includes('created_by');
    const rows = app.db.all(
      `SELECT * FROM "${t.name}" WHERE contact_id = ?${scoped ? ' AND location_id = ?' : ''}${ownOnly ? ' AND (COALESCE(private, 0) = 0 OR created_by = ?)' : ''}`,
      contactId,
      ...(scoped ? [locationId] : []),
      ...(ownOnly ? [viewer.userId ?? ''] : []),
    );
    if (rows.length) data[t.name] = rows.map(clean);
  }
  for (const t of ['record_notes', 'record_activities', 'record_props']) {
    if (!tables(app).some((x) => x.name === t)) continue;
    const rows = app.db.all(`SELECT * FROM "${t}" WHERE object_key = 'contact' AND record_id = ? AND location_id = ?`, contactId, locationId);
    if (rows.length) data[t] = rows.map(clean);
  }
  // Rows that hang on the person's records rather than on the contact: the files of its form submissions (as a list), the
  // history of its tickets, its answers to webinar polls.
  for (const [child, fk, parent] of CHILDREN) {
    if (!tables(app).some((x) => x.name === child)) continue;
    const rows = app.db.all(`SELECT * FROM "${child}" WHERE "${fk}" IN (SELECT id FROM "${parent}" WHERE contact_id = ? AND location_id = ?) ORDER BY created_at`, contactId, locationId);
    if (rows.length) data[child] = rows.map(clean);
  }
  // Partner records and sign-ups that carry the same e-mail (no contact link).
  const email = normalizeEmail(contact.email);
  if (email) {
    for (const [table, col] of [['affiliates', 'email'], ['saas_signups', 'email'], ['buy_upsells', 'email']] as const) {
      const t = tables(app).find((x) => x.name === table);
      if (!t || !t.cols.includes(col)) continue;
      const rows = app.db.all(`SELECT * FROM "${table}" WHERE lower(${col}) = ?${t.cols.includes('location_id') ? ' AND location_id = ?' : ''}`, email, ...(t.cols.includes('location_id') ? [locationId] : []));
      if (rows.length) data[`${table} (E-Mail)`] = rows.map(clean);
    }
  }
  for (const fn of app.services.privacyExport ?? []) Object.assign(data, fn(app, locationId, contact) ?? {});
  return {
    generated_at: now(),
    location: { id: locationId, name: app.location(locationId)?.name ?? '' },
    contact: clean(contact),
    data,
    note: 'Auskunft nach Art. 15 DSGVO: alle gespeicherten Daten zu dieser Person in diesem Sub-Account. Dateien sind als Liste enthalten.',
  };
}

/** Erases one contact everywhere in a sub-account. Returns what happened per table (counts only). */
export function eraseContact(app: App, locationId: string, contactId: string) {
  const { db } = app;
  const contact = db.get<Contact>('SELECT * FROM contacts WHERE id = ? AND location_id = ?', contactId, locationId);
  if (!contact) throw notFound('Kontakt nicht gefunden');
  const all = tables(app);
  const has = (name: string) => all.some((t) => t.name === name);
  const report: Record<string, number> = {};
  const count = (k: string, n: number) => {
    if (n) report[k] = (report[k] ?? 0) + n;
  };
  const email = normalizeEmail(contact.email);
  // Read before the rows that know them go (community videos, course hand-ins, recordings, certificates, task attachments …).
  const files: string[] = contactFiles(app, locationId, contactId);

  db.tx(() => {
    // Files on disk first (their rows go below).
    if (has('form_files') && has('form_submissions')) {
      for (const f of db.all(`SELECT f.* FROM form_files f JOIN form_submissions s ON s.id = f.submission_id WHERE s.contact_id = ? AND f.location_id = ?`, contactId, locationId)) {
        // Stored under the checked type's extension (older uploads: the one from the file name).
        files.push(join(app.config.dataDir, 'form-files', `${f.id}${extFor(String(f.mime))}`));
        files.push(join(app.config.dataDir, 'form-files', `${f.id}${extname(String(f.name)).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin'}`));
        count('form_files', db.run('DELETE FROM form_files WHERE id = ?', f.id).changes);
      }
    }
    if (has('community_files')) {
      for (const f of db.all('SELECT * FROM community_files WHERE contact_id = ? AND location_id = ?', contactId, locationId)) {
        files.push(join(app.config.dataDir, 'community', String(f.file)));
        count('community_files', db.run('DELETE FROM community_files WHERE id = ?', f.id).changes);
      }
    }
    // Tickets the person opened: their texts are personal data (events and messages cascade).
    if (has('tickets')) count('tickets', db.run('DELETE FROM tickets WHERE contact_id = ? AND location_id = ?', contactId, locationId).changes);
    // Contracts that never went out (drafts, cancelled ones – the ones the contract module lets you delete) are not kept for the law.
    if (has('contracts')) count('contracts', db.run(`DELETE FROM contracts WHERE contact_id = ? AND location_id = ? AND status IN ('draft', 'void')`, contactId, locationId).changes);
    // Partner (affiliate) records of the same person: personal fields cleared, payouts stay for accounting.
    if (has('affiliates')) {
      const affs = db.all(`SELECT id FROM affiliates WHERE location_id = ? AND (contact_id = ? OR (? != '' AND lower(email) = ?))`, locationId, contactId, email, email);
      for (const a of affs) {
        if (has('affiliate_sessions')) db.run('DELETE FROM affiliate_sessions WHERE affiliate_id = ?', a.id);
        if (has('affiliate_login_tokens')) db.run('DELETE FROM affiliate_login_tokens WHERE affiliate_id = ?', a.id);
        db.run(`UPDATE affiliates SET name = 'Gelöscht (DSGVO)', email = ?, iban = '', paypal_email = '', login_ip_hash = '', contact_id = NULL, status = 'disabled' WHERE id = ?`, `deleted-${a.id}@invalid`, a.id);
        count('affiliates', 1);
      }
    }
    if (email) {
      if (has('saas_signups')) count('saas_signups', db.run(`UPDATE saas_signups SET name = '', email = ?, phone = '', ip = '' WHERE location_id = ? AND lower(email) = ?`, 'deleted@invalid', locationId, email).changes);
      if (has('buy_upsells')) count('buy_upsells', db.run(`UPDATE buy_upsells SET email = '' WHERE location_id = ? AND lower(email) = ?`, locationId, email).changes);
      if (has('stripe_checkouts')) db.run(`UPDATE stripe_checkouts SET email = '' WHERE location_id = ? AND contact_id = ?`, locationId, contactId);
    }
    // The audit log keeps that something happened, not who it was about: entries about the contact itself and every summary that
    // names the person ("Termin … – Dora Muster", "Zertifikat … für Dora Muster", the e-mail address, the phone number).
    const named = mentionsOf(contact);
    const anyNamed = named.map(() => ' OR instr(lower(summary), lower(?)) > 0').join('');
    count('audit_log', db.run(`UPDATE audit_log SET summary = '[gelöscht]' WHERE location_id = ? AND summary != '[gelöscht]' AND (entity_id = ?${anyNamed})`, locationId, contactId, ...named).changes);
    // Timelines of other records (the company the contact was linked to, the member a message went to) keep the event, not the name.
    for (const t of ['activities', 'record_activities']) {
      if (!has(t)) continue;
      for (const m of named) {
        count(t, db.run(`UPDATE "${t}" SET summary = replace(summary, ?, '[gelöscht]') WHERE location_id = ? AND instr(summary, ?) > 0`, m, locationId, m).changes);
        count(t, db.run(`UPDATE "${t}" SET summary = '[gelöscht]' WHERE location_id = ? AND instr(lower(summary), lower(?)) > 0`, locationId, m).changes);
      }
    }
    // Notes, activity and properties the relational CRM keeps per record (object "contact").
    for (const t of ['record_notes', 'record_activities', 'record_props']) if (has(t)) count(t, db.run(`DELETE FROM "${t}" WHERE object_key = 'contact' AND record_id = ? AND location_id = ?`, contactId, locationId).changes);
    for (const fn of app.services.privacyErase ?? []) fn(app, locationId, contact);
    // Every other row that points at the contact – also tables that would only set the link to NULL.
    for (const t of all) {
      if (t.name === 'contacts' || !t.cols.includes('contact_id')) continue;
      const scoped = t.cols.includes('location_id');
      const args = [contactId, ...(scoped ? [locationId] : [])];
      const where = `contact_id = ?${scoped ? ' AND location_id = ?' : ''}`;
      if (RETAIN.has(t.name)) db.run(`UPDATE "${t.name}" SET contact_id = NULL WHERE ${where}`, ...args);
      else count(t.name, db.run(`DELETE FROM "${t.name}" WHERE ${where}`, ...args).changes);
    }
    count('contacts', db.run('DELETE FROM contacts WHERE id = ? AND location_id = ?', contactId, locationId).changes);
  });
  for (const f of files) if (existsSync(f)) rmSync(f, { force: true });
  app.events.emit(locationId, 'contact.deleted', { contactId, erased: true });
  return { ok: true, erased: report, retained: [...RETAIN].filter(has) };
}

const TOOLS: Tool[] = [
  {
    name: 'ghl_contact_privacy_export',
    title: 'DSGVO-Auskunft für einen Kontakt',
    description: 'Alle gespeicherten Daten zu einem Kontakt (Art. 15 DSGVO) als JSON: Kontakt, Nachrichten, Termine, Formulare, Tickets, Community, Partner, Attribution …',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, contact_id: { type: 'string' } }, required: ['contact_id'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => call.api('GET', `/api/contacts/${encodeURIComponent(a.contact_id)}/privacy-export`, { location: a.location_id }),
  },
  {
    name: 'ghl_contact_erase',
    title: 'Kontakt nach DSGVO löschen',
    description:
      'Löscht einen Kontakt endgültig in allen Bereichen (Art. 17 DSGVO) – Nachrichten, Formulare, Dateien, Tickets, Community, Partnerdaten. Rechnungen/Verträge bleiben (gesetzliche Aufbewahrung). Nicht umkehrbar: confirm muss die E-Mail-Adresse des Kontakts (oder seine ID) sein.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, contact_id: { type: 'string' }, confirm: { type: 'string' } }, required: ['contact_id', 'confirm'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    run: (call, a) => call.api('POST', `/api/contacts/${encodeURIComponent(a.contact_id)}/erase`, { location: a.location_id, body: { confirm: a.confirm } }),
  },
];

export const privacyModule: Module = {
  name: 'privacy',
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    app.services.privacy = { exportContact: (loc: string, id: string) => exportContact(app, loc, id), eraseContact: (loc: string, id: string) => eraseContact(app, loc, id) };

    const confirmed = (ctx: Ctx, c: Contact) => {
      const v = str(ctx.body?.confirm, 'Bestätigung', { max: 320 }).toLowerCase();
      if (!v || (v !== String(c.id).toLowerCase() && v !== normalizeEmail(c.email))) throw bad('Zur Bestätigung die E-Mail-Adresse (oder die ID) des Kontakts eingeben');
    };

    // Both exports land in the audit log through the security module's export hook (app.afterRead).
    router.get('/api/contacts/:id/privacy-export', 'location', (ctx) => {
      const out = exportContact(app, ctx.locationId, ctx.params.id, { userId: ctx.user?.id ?? null, admin: ctx.user?.role === 'admin' || (!ctx.user && !!ctx.viaApiKey) });
      return { __raw: true, status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="dsgvo-auskunft-${ctx.params.id.replace(/[^\w-]/g, '')}.json"`, 'cache-control': 'no-store' }, body: JSON.stringify(out, null, 2) };
    });

    router.post('/api/contacts/:id/erase', 'location', (ctx) => {
      if (ctx.scope === 'read') throw new HttpError(403, 'Dieser Schlüssel darf nur lesen');
      const c = db.get<Contact>('SELECT * FROM contacts WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!c) throw notFound('Kontakt nicht gefunden');
      confirmed(ctx, c);
      return eraseContact(app, ctx.locationId, c.id);
    });

    // Agency: one request of a person who may be a contact in several sub-accounts.
    const byEmail = (email: string) => db.all<Contact>('SELECT * FROM contacts WHERE lower(email) = ? ORDER BY location_id', email);
    router.get('/api/agency/privacy/export', 'admin', (ctx) => {
      const email = normalizeEmail(ctx.query.get('email'));
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw bad('E-Mail-Adresse fehlt');
      const out = byEmail(email).map((c) => exportContact(app, c.location_id, c.id));
      return { __raw: true, status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="dsgvo-auskunft.json"', 'cache-control': 'no-store' }, body: JSON.stringify({ email, generated_at: now(), contacts: out }, null, 2) };
    });
    router.post('/api/agency/privacy/erase', 'admin', (ctx) => {
      const email = normalizeEmail(ctx.body?.email);
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw bad('E-Mail-Adresse fehlt');
      if (normalizeEmail(ctx.body?.confirm) !== email) throw bad('Zur Bestätigung die E-Mail-Adresse noch einmal eingeben');
      const results = byEmail(email).map((c) => ({ location_id: c.location_id, ...eraseContact(app, c.location_id, c.id) }));
      return { ok: true, contacts: results.length, results };
    });
  },
};
