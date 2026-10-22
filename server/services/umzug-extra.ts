import type { App } from '../core/app.js';
import { id, now, slugify } from '../core/util.js';
import { cleanProofUrl } from './consent.js';
import type { ConsentProof, RArticle, RContact, RConversation, RDoc, RKbCategory, RReference, RTicket, Rec, SourceKey } from './umzug-core.js';
import { upsertContact } from './contacts.js';
import { getOrCreateConversation } from './messaging.js';
import { addTicketEvent } from './tickets.js';
import { indexPage, purgeIds } from './wiki-store.js';
import { markdownToText } from './wiki-markdown.js';
import { clip, htmlToMarkdown, stripHtml } from './umzug-text.js';
import { PmWriter, undoPm } from './umzug-pm.js';
import { ObjectsWriter, undoObjects } from './umzug-objects.js';
import { BookingWriter, undoBooking } from './umzug-booking.js';

/**
 * Everything the switch-over importers write beyond the basics of umzug-write.ts, in one place so the shared writer stays small:
 * the consent ledger entries of imported contacts (legacy / confirmed / revoked, with the source named) and reference lists as
 * wiki pages. The Writer hands over what it knows through `Host` (id map, undo items, counters); nothing here emits an event, so
 * an import never starts a workflow. With `dry` set nothing is written – the same decisions are made and counted.
 */

export interface Host {
  getId(kind: string, ext: string): { local: string; extra: string | null } | undefined;
  setId(kind: string, ext: string, local: string, extra?: string | null): void;
  item(kind: string, local: string, ext: string, created: boolean, before?: unknown): void;
  stat(key: string, what: 'created' | 'updated' | 'skipped' | 'failed', n?: number): void;
  contactLocal(ext?: string): string | undefined;
  virtual: Set<string>;
}

export interface ExtraEnv {
  app: App;
  locationId: string;
  jobId: string;
  source: SourceKey;
  /** Namespace of the vendor account (ids are only unique inside it). */
  ns: string;
  label: string;
  dry: boolean;
  warn: (message: string) => void;
}

const REASON: Record<string, string> = { unsubscribed: 'hat sich abgemeldet', bounced: 'E-Mail unzustellbar', complained: 'Spam-Beschwerde', blocked: 'gesperrt' };

const proofList = (rec: RContact): ConsentProof[] => (rec.proof ? (Array.isArray(rec.proof) ? rec.proof : [rec.proof]) : []);

const day = (iso?: string) => (iso ? iso.slice(0, 10).split('-').reverse().join('.') : '');

export class ExtraWriter {
  private readonly app: App;
  private readonly db: App['db'];
  private readonly loc: string;
  private hasLedger: boolean | undefined;
  private hasWiki: boolean | undefined;
  private hasKnowledge: boolean | undefined;
  private spaces = new Map<string, { id: string }>();
  private readonly pm: PmWriter;
  private readonly objects: ObjectsWriter;
  private readonly booking: BookingWriter;

  constructor(
    private env: ExtraEnv,
    private host: Host,
  ) {
    this.app = env.app;
    this.db = env.app.db;
    this.loc = env.locationId;
    this.pm = new PmWriter(env, host);
    this.objects = new ObjectsWriter(env, host);
    this.booking = new BookingWriter(env, host);
  }

  private tableThere(name: string): boolean {
    try {
      return !!this.db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name);
    } catch {
      return false;
    }
  }

  // --- the consent ledger ---------------------------------------------------------------------------------------------

  /**
   * Ledger lines for an imported contact, per statement of the source (RContact.proof): confirmed opt-in → `granted`, plain
   * "subscribed" → `legacy` (Altbestand: the note says where it came from), withdrawal → `revoked`, never opted in → `declined`.
   * A merged contact that already has a history on that channel keeps it – only withdrawals and "declined" are added. Re-runs
   * add nothing twice: the same action, channel and source (and time, when the vendor gave one) is not written again.
   */
  ledger(contactId: string, rec: RContact, created: boolean) {
    const proofs = proofList(rec);
    if (!proofs.length) return;
    if (this.hasLedger === undefined) this.hasLedger = this.tableThere('consent_events');
    if (!this.hasLedger) return;
    const contact = this.db.get<{ email: string; phone: string }>('SELECT email, phone FROM contacts WHERE id = ? AND location_id = ?', contactId, this.loc);
    if (!contact) return;
    const label = clip(`Umzug aus ${this.env.label}`, 200);
    for (const p of proofs) {
      const channel = p.channel ?? 'email';
      if (channel === 'email' ? !contact.email : !contact.phone) continue;
      const at = p.at && !Number.isNaN(Date.parse(p.at)) ? new Date(p.at).toISOString() : now();
      const action = p.basis === 'revoked' ? 'revoked' : p.basis === 'confirmed' ? 'granted' : p.basis === 'none' ? 'declined' : 'legacy';
      const adds = action === 'granted' || action === 'legacy';
      // A merged contact that already has a history in the ledger keeps it.
      if (adds && !created && this.db.get('SELECT 1 FROM consent_events WHERE contact_id = ? AND channel = ? LIMIT 1', contactId, channel)) continue;
      if (this.db.get(`SELECT 1 FROM consent_events WHERE contact_id = ? AND channel = ? AND action = ? AND source_label = ?${p.at ? ' AND created_at = ?' : ''} LIMIT 1`, contactId, channel, action, label, ...(p.at ? [at] : []))) continue;
      const purpose = action === 'granted' ? (channel === 'email' ? 'newsletter' : 'marketing') : '*';
      this.writeEvent(contactId, channel, action, purpose, at, label, this.note(rec, p), p.url ?? '');
    }
  }

  /** Dry run: how many ledger lines the import would write (one per statement with an address – the address is not checked here). */
  ledgerDry(rec: RContact) {
    const n = proofList(rec).length;
    if (!n) return;
    if (this.hasLedger === undefined) this.hasLedger = this.tableThere('consent_events');
    if (this.hasLedger) this.host.stat('consent_events', 'created', n);
  }

  private note(rec: RContact, p: ConsentProof): string {
    const channel = p.channel === 'sms' ? 'SMS' : 'E-Mail';
    const what =
      p.basis === 'revoked' ? `${channel}: ${p.reason ?? REASON[rec.consent ?? ''] ?? 'Widerruf'}` : p.basis === 'confirmed' ? `${channel}: Einwilligung beim alten Anbieter dokumentiert` : p.basis === 'none' ? `${channel}: dort nie für Werbung angemeldet` : `${channel}: als angemeldet geführt, aber ohne eigenen Nachweis (Altbestand)`;
    const parts = [`Übernommen aus ${this.env.label} – ${what}`];
    if (p.method) parts.push(`Art: ${p.method}`);
    if (p.at) parts.push(`Stand: ${day(p.at)}`);
    if (rec.native_status && p.basis !== 'revoked' && p.channel !== 'sms') parts.push(`Status dort: ${rec.native_status}`);
    if (p.note) parts.push(p.note);
    if (p.basis === 'legacy') parts.push('Der Nachweis liegt beim alten Anbieter – vor dem Löschen des Kontos dort exportieren');
    return clip(`${parts.join('. ')}.`, 1000);
  }

  private writeEvent(contactId: string, channel: string, action: string, purpose: string, at: string, label: string, note: string, url: string) {
    if (this.env.dry) return void this.host.stat('consent_events', 'created');
    const eid = id();
    this.db.insert('consent_events', {
      id: eid,
      location_id: this.loc,
      contact_id: contactId,
      channel,
      purpose,
      action,
      doi_required: 0,
      expires_at: null,
      source_kind: 'import',
      source_id: clip(this.env.jobId, 80),
      source_label: label,
      text_id: null,
      text_version: null,
      text_digest: '',
      ip_net: '',
      ua_digest: '',
      proof_url: cleanProofUrl(url),
      note,
      actor: 'umzug',
      doi_id: null,
      created_at: at,
    });
    this.host.item('consent_event', eid, `${contactId}:${channel}:${action}`, true);
    this.host.stat('consent_events', 'created');
  }

  // --- reference lists as wiki pages ----------------------------------------------------------------------------------

  apply(rec: Rec): boolean {
    switch (rec.kind) {
      case 'reference':
        this.reference(rec);
        return true;
      case 'ticket':
        this.ticket(rec);
        return true;
      case 'kb_category':
        this.kbCategory(rec);
        return true;
      case 'article':
        this.article(rec);
        return true;
      case 'conversation':
        this.conversation(rec);
        return true;
      case 'doc':
        this.doc(rec);
        return true;
      case 'project':
        this.pm.project(rec);
        return true;
      case 'pm_task':
        this.pm.task(rec);
        return true;
      case 'object_type':
        this.objects.type(rec);
        return true;
      case 'object_record':
        this.objects.record(rec);
        return true;
      case 'object_link':
        this.objects.link(rec);
        return true;
      case 'calendar':
        this.booking.calendar(rec);
        return true;
      case 'appointment':
        this.booking.appointment(rec);
        return true;
      case 'submission':
        this.booking.submission(rec);
        return true;
      default:
        return false;
    }
  }

  private ensureSpace(name = 'Umzug', icon = '📦', description = 'Referenzlisten aus dem Umzug: was sich nicht automatisch übernehmen ließ und neu gebaut werden muss.'): { id: string } {
    const cached = this.spaces.get(name);
    if (cached) return cached;
    const had = this.db.get<{ id: string }>('SELECT id FROM wiki_spaces WHERE location_id = ? AND name = ? ORDER BY created_at LIMIT 1', this.loc, name);
    if (had) {
      this.spaces.set(name, had);
      return had;
    }
    const sid = id();
    const pos = this.db.get<{ n: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM wiki_spaces WHERE location_id = ?', this.loc)!.n;
    this.db.insert('wiki_spaces', { id: sid, location_id: this.loc, name, icon, description, team_access: 'edit', owner_id: null, owner_name: 'Umzug', position: pos, created_at: now(), updated_at: now() });
    this.host.item('wiki_space', sid, `umzug-space:${name}`, true);
    const made = { id: sid };
    this.spaces.set(name, made);
    return made;
  }

  private reference(rec: RReference) {
    this.page({ idKind: 'reference', stat: 'references', itemKind: 'wiki_page', ext: rec.ext, title: rec.title, body: rec.body, icon: '📋', label: `Referenzliste „${clip(rec.title, 60)}“` });
  }

  /** A page of the old tool (Notion page, monday doc, ClickUp doc …) in a wiki space of its own, with its hierarchy. */
  private doc(rec: RDoc) {
    const name = clip(rec.space || this.env.label, 80) || this.env.label;
    this.page({ idKind: 'doc', stat: 'docs', itemKind: 'wiki_doc', ext: rec.ext, title: rec.title, body: rec.body, icon: rec.icon ?? '📄', label: `Seite „${clip(rec.title, 60)}“`, parent: rec.parent, space: { name, icon: '📄', description: `Seiten aus ${this.env.label}, beim Umzug übernommen.` } });
  }

  /**
   * One wiki page, written by the importer: new, or refreshed when it is still as the import left it (a page a person has edited
   * since stays as they left it). `parent` is the ext of another imported page of the same kind.
   */
  private page(o: { idKind: string; stat: string; itemKind: string; ext: string; title: string; body: string; icon: string; label: string; parent?: string; space?: { name: string; icon: string; description: string } }) {
    const known = this.host.getId(o.idKind, o.ext);
    if (this.env.dry) {
      this.host.stat(o.stat, known ? 'updated' : 'created');
      return void this.host.virtual.add(`${o.idKind}:${o.ext}`);
    }
    if (this.hasWiki === undefined) this.hasWiki = this.tableThere('wiki_pages') && this.tableThere('wiki_spaces');
    if (!this.hasWiki) {
      this.host.stat(o.stat, 'skipped');
      return void this.env.warn(`${o.label} nicht angelegt: das Wiki ist in dieser Installation nicht verfügbar`);
    }
    const author = clip(`Umzug (${this.env.label})`, 200);
    const title = clip(o.title, 200).trim() || 'Ohne Titel';
    const body = clip(o.body, 200_000);
    const page = known ? this.db.get<{ id: string; version: number; updated_by_name: string; trashed_at: string | null; space_id: string }>('SELECT id, version, updated_by_name, trashed_at, space_id FROM wiki_pages WHERE id = ? AND location_id = ?', known.local, this.loc) : undefined;
    if (page && !page.trashed_at) {
      if (page.updated_by_name !== author) {
        this.host.stat(o.stat, 'skipped');
        return;
      }
      this.db.tx(() => {
        this.db.run('UPDATE wiki_pages SET title = ?, body = ?, text = ?, version = version + 1, updated_at = ? WHERE id = ?', title, body, markdownToText(body), now(), page.id);
        this.db.insert('wiki_versions', { id: id(), page_id: page.id, location_id: this.loc, rev: page.version + 1, title, body, author_id: null, author_name: author, via: 'umzug', note: 'Umzug erneut ausgeführt', created_at: now(), saved_at: now() });
      });
      this.reindex(page.id);
      this.host.stat(o.stat, 'updated');
      return;
    }
    const parentRef = o.parent ? this.host.getId(o.idKind, o.parent) : undefined;
    const parentRow = parentRef && !parentRef.local.startsWith('dry:') ? this.db.get<{ id: string; space_id: string }>('SELECT id, space_id FROM wiki_pages WHERE id = ? AND location_id = ? AND trashed_at IS NULL', parentRef.local, this.loc) : undefined;
    // A page lives in the space of its parent; without one (or when the parent is gone) it goes to the top of the import's space.
    const space = parentRow ? { id: parentRow.space_id } : o.space ? this.ensureSpace(o.space.name, o.space.icon, o.space.description) : this.ensureSpace();
    const pid = id();
    const parentId = parentRow?.id ?? null;
    const pos = this.db.get<{ n: number }>(`SELECT COALESCE(MAX(position), -1) + 1 AS n FROM wiki_pages WHERE space_id = ? AND ${parentId ? 'parent_id = ?' : 'parent_id IS NULL'}`, space.id, ...(parentId ? [parentId] : []))!.n;
    this.db.tx(() => {
      this.db.insert('wiki_pages', { id: pid, location_id: this.loc, space_id: space.id, parent_id: parentId, position: pos, title, icon: o.icon, body, text: markdownToText(body), version: 1, trashed_at: null, kb_article_id: null, kb_version: null, created_by: null, created_by_name: author, updated_by: null, updated_by_name: author, created_at: now(), updated_at: now() });
      this.db.insert('wiki_versions', { id: id(), page_id: pid, location_id: this.loc, rev: 1, title, body, author_id: null, author_name: author, via: 'umzug', note: 'Aus dem Umzug', created_at: now(), saved_at: now() });
      this.db.run('UPDATE wiki_spaces SET updated_at = ? WHERE id = ?', now(), space.id);
    });
    this.reindex(pid);
    this.host.setId(o.idKind, o.ext, pid);
    this.host.item(o.itemKind, pid, o.ext, true);
    this.host.stat(o.stat, 'created');
  }

  // --- tickets ----------------------------------------------------------------------------------------------------

  /**
   * A ticket with its conversation through the helpdesk's own import (idempotent by vendor id, stage and priority mapped by meaning,
   * no SLA timers, no mails, no workflow events), then the comments as timeline entries with their original time. A comment that is
   * there already (a re-run) is not added again. Support contacts the import did not bring along are created from the ticket.
   */
  private ticket(rec: RTicket) {
    const known = this.host.getId('ticket', rec.ext);
    if (this.env.dry) {
      this.host.stat('tickets', known ? 'updated' : 'created');
      this.host.stat('ticket_comments', known ? 'updated' : 'created', rec.comments.length);
      return void this.host.virtual.add(`ticket:${rec.ext}`);
    }
    const imp = this.app.services.ticketsImport;
    if (typeof imp !== 'function') {
      this.host.stat('tickets', 'skipped');
      return void this.env.warn('Tickets übersprungen: in dieser Installation gibt es keinen Helpdesk');
    }
    let contact = this.host.contactLocal(rec.contact);
    if (contact?.startsWith('dry:')) contact = undefined;
    if (!contact && rec.contact_hint?.email) {
      const { contact: c, created } = upsertContact(this.app, this.loc, { email: rec.contact_hint.email, name: rec.contact_hint.name, source: `${this.env.label}-Import` }, { source: `${this.env.label}-Import`, quiet: true });
      contact = c.id;
      this.host.setId('contact', rec.contact ?? `email:${rec.contact_hint.email}`, c.id);
      this.host.item('contact', c.id, rec.contact ?? `email:${rec.contact_hint.email}`, created);
      this.host.stat('contacts', created ? 'created' : 'updated');
    }
    const r = imp(this.loc, {
      external_source: `umzug-${this.env.source}`,
      external_id: `${this.env.ns}:${rec.ext}`.slice(0, 120),
      subject: rec.subject,
      content: rec.description ?? '',
      stage: rec.status,
      priority: rec.priority,
      contact_id: contact ?? null,
      created_at: rec.created_at,
    }) as { id: string; created: boolean };
    this.host.setId('ticket', rec.ext, r.id);
    this.host.item('ticket', r.id, rec.ext, r.created);
    this.host.stat('tickets', r.created ? 'created' : 'updated');
    const update: Record<string, unknown> = { tags: [...new Set((rec.tags ?? []).map((t) => clip(t, 60)).filter(Boolean))].slice(0, 30) };
    // Only channels a reply can be sent on; the vendor's "web" or "api" would break the reply button.
    if (rec.channel && /^(email|sms|chat|whatsapp)$/.test(rec.channel)) update.channel = rec.channel;
    let lastCustomer = '';
    let lastAgent = '';
    for (const c of rec.comments) {
      const at = c.at && !Number.isNaN(Date.parse(c.at)) ? new Date(c.at).toISOString() : now();
      if (c.from === 'customer') lastCustomer = at > lastCustomer ? at : lastCustomer;
      else if (!c.internal) lastAgent = at > lastAgent ? at : lastAgent;
      if (this.db.get("SELECT 1 FROM ticket_events WHERE ticket_id = ? AND json_extract(data, '$.ext') = ? LIMIT 1", r.id, c.ext)) {
        this.host.stat('ticket_comments', 'updated');
        continue;
      }
      const type = c.internal ? 'note' : c.from === 'customer' ? 'customer_reply' : 'reply';
      const body = c.from === 'customer' || !c.author ? c.body : `${c.author}:\n\n${c.body}`;
      addTicketEvent(this.app, { id: r.id, location_id: this.loc }, type, { body: clip(body, 50_000), at, data: { ext: c.ext, via: 'import', author: c.author ?? null, channel: rec.channel ?? null } });
      this.host.stat('ticket_comments', 'created');
    }
    if (lastCustomer) update.last_customer_at = lastCustomer;
    if (lastAgent) update.last_agent_at = lastAgent;
    this.db.update('tickets', r.id, update, this.loc);
  }

  // --- help-center articles (knowledge base) ---------------------------------------------------------------------

  private slug(table: 'kb_articles' | 'kb_categories', wanted: string): string {
    const base = slugify(wanted).slice(0, 70) || 'artikel';
    let slug = base;
    for (let i = 2; this.db.get(`SELECT 1 FROM ${table} WHERE location_id = ? AND slug = ?`, this.loc, slug); i++) slug = `${base}-${i}`;
    return slug;
  }

  private hasKb(): boolean {
    if (this.hasKnowledge === undefined) this.hasKnowledge = this.tableThere('kb_articles') && this.tableThere('kb_categories');
    return this.hasKnowledge;
  }

  private kbCategory(rec: RKbCategory) {
    const known = this.host.getId('kb_category', rec.ext);
    if (this.env.dry) {
      this.host.stat('kb_categories', known ? 'updated' : 'created');
      return void this.host.virtual.add(`kb_category:${rec.ext}`);
    }
    if (!this.hasKb()) {
      this.host.stat('kb_categories', 'skipped');
      return;
    }
    const name = clip(rec.name, 120) || 'Allgemein';
    if (known && this.db.get('SELECT 1 FROM kb_categories WHERE id = ? AND location_id = ?', known.local, this.loc)) {
      this.host.stat('kb_categories', 'updated');
      return;
    }
    // A category of the same name that is already there is used, not doubled (and is not ours to delete).
    const same = this.db.get<{ id: string }>('SELECT id FROM kb_categories WHERE location_id = ? AND lower(name) = lower(?)', this.loc, name);
    if (same) {
      this.host.setId('kb_category', rec.ext, same.id);
      return void this.host.stat('kb_categories', 'updated');
    }
    const cid = id();
    const pos = this.db.get<{ n: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM kb_categories WHERE location_id = ?', this.loc)!.n;
    this.db.insert('kb_categories', { id: cid, location_id: this.loc, name, slug: this.slug('kb_categories', name), description: clip(rec.description, 500), position: pos, created_at: now(), updated_at: now() });
    this.host.setId('kb_category', rec.ext, cid);
    this.host.item('kb_category', cid, rec.ext, true);
    this.host.stat('kb_categories', 'created');
  }

  private article(rec: RArticle) {
    const known = this.host.getId('article', rec.ext);
    if (this.env.dry) {
      this.host.stat('articles', known ? 'updated' : 'created');
      return void this.host.virtual.add(`article:${rec.ext}`);
    }
    if (!this.hasKb()) {
      this.host.stat('articles', 'skipped');
      return void this.env.warn(`Artikel „${clip(rec.title, 60)}“ nicht angelegt: die Wissensdatenbank ist in dieser Installation nicht verfügbar`);
    }
    const body = clip(rec.markdown ?? htmlToMarkdown(rec.html ?? ''), 200_000);
    const cat = rec.category ? this.host.getId('kb_category', rec.category) : undefined;
    const categoryId = cat?.local && !cat.local.startsWith('dry:') && this.db.get('SELECT 1 FROM kb_categories WHERE id = ? AND location_id = ?', cat.local, this.loc) ? cat.local : null;
    const title = clip(rec.title, 200) || 'Artikel';
    const row = { title, body, excerpt: clip(stripHtml(rec.html ?? body).replace(/\s+/g, ' '), 200), category_id: categoryId, tags: [...new Set((rec.tags ?? []).map((t) => clip(t, 40)).filter(Boolean))].slice(0, 20), updated_at: now() };
    if (known && this.db.get('SELECT 1 FROM kb_articles WHERE id = ? AND location_id = ?', known.local, this.loc)) {
      this.db.update('kb_articles', known.local, row, this.loc);
      return void this.host.stat('articles', 'updated');
    }
    const aid = id();
    const pos = this.db.get<{ n: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM kb_articles WHERE location_id = ?', this.loc)!.n;
    this.db.insert('kb_articles', { id: aid, location_id: this.loc, slug: this.slug('kb_articles', title), status: 'draft', seo: {}, position: pos, views: 0, helpful_yes: 0, helpful_no: 0, author_id: null, published_at: null, created_at: rec.created_at ?? now(), ...row });
    this.host.setId('article', rec.ext, aid);
    this.host.item('kb_article', aid, rec.ext, true);
    this.host.stat('articles', 'created');
  }

  // --- conversations as inbox history -----------------------------------------------------------------------------

  /**
   * The messages of a conversation into the contact's thread (the inbox has one thread per contact): stored as received / sent with
   * their original time and the vendor id as external id (a re-run skips what is there), never sent, never unread. Internal notes
   * become notes on the contact. Threads the import had to open are noted for the undo.
   */
  private conversation(rec: RConversation) {
    const known = this.host.getId('conversation', rec.ext);
    if (this.env.dry) {
      this.host.stat('conversations', known ? 'updated' : 'created');
      this.host.stat('messages', known ? 'updated' : 'created', rec.messages.filter((m) => !m.internal).length);
      return void this.host.virtual.add(`conversation:${rec.ext}`);
    }
    let contact = this.host.contactLocal(rec.contact);
    if (contact?.startsWith('dry:')) contact = undefined;
    if (!contact && rec.contact_hint?.email) {
      const { contact: c, created } = upsertContact(this.app, this.loc, { email: rec.contact_hint.email, name: rec.contact_hint.name, source: `${this.env.label}-Import` }, { source: `${this.env.label}-Import`, quiet: true });
      contact = c.id;
      this.host.setId('contact', rec.contact ?? `email:${rec.contact_hint.email}`, c.id);
      this.host.item('contact', c.id, rec.contact ?? `email:${rec.contact_hint.email}`, created);
      this.host.stat('contacts', created ? 'created' : 'updated');
    }
    if (!contact) {
      this.host.stat('conversations', 'skipped');
      return;
    }
    const had = !!this.db.get('SELECT 1 FROM conversations WHERE location_id = ? AND contact_id = ?', this.loc, contact);
    const threadId = getOrCreateConversation(this.app, this.loc, contact);
    if (!had) this.host.item('thread', threadId, rec.ext, true);
    const channel = rec.channel === 'email' ? 'email' : 'chat';
    let added = 0;
    let first = true;
    for (const m of [...rec.messages].sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')))) {
      const at = m.at && !Number.isNaN(Date.parse(m.at)) ? new Date(m.at).toISOString() : now();
      const ext = `${this.env.ns}:${rec.ext}:${m.ext}`.slice(0, 190);
      if (m.internal) {
        if (this.host.getId('conversation_note', ext)) continue;
        const nid = id();
        this.db.insert('notes', { id: nid, location_id: this.loc, contact_id: contact, body: clip(`${this.env.label}-Notiz${m.author ? ` (${m.author})` : ''}: ${m.body}`, 20_000), user_id: null, created_at: at });
        this.host.setId('conversation_note', ext, nid);
        this.host.item('note', nid, ext, true);
        this.host.stat('conversation_notes', 'created');
        continue;
      }
      if (this.db.get('SELECT 1 FROM messages WHERE location_id = ? AND external_id = ?', this.loc, ext)) {
        this.host.stat('messages', 'updated');
        continue;
      }
      const mid = id();
      const inbound = m.from === 'customer';
      this.db.insert('messages', { id: mid, location_id: this.loc, conversation_id: threadId, contact_id: contact, channel, direction: inbound ? 'in' : 'out', subject: first && rec.subject ? clip(rec.subject, 300) : '', body: clip(!inbound && m.author ? `${m.author}: ${m.body}` : m.body, 100_000), status: inbound ? 'received' : 'sent', error: '', source: clip(`Import: ${this.env.label}`, 60), external_id: ext, created_at: at });
      this.host.item('message', mid, ext, true);
      this.host.stat('messages', 'created');
      first = false;
      added++;
    }
    this.host.setId('conversation', rec.ext, threadId);
    this.host.stat('conversations', added || !had ? 'created' : 'updated');
    // The thread's preview follows its newest message.
    const last = this.db.get<{ subject: string; body: string; created_at: string }>('SELECT subject, body, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1', threadId);
    if (last) this.db.run('UPDATE conversations SET last_message_at = ?, last_message = ? WHERE id = ?', last.created_at, clip(last.subject || last.body, 140), threadId);
  }

  private reindex(pageId: string) {
    if (!this.app.services.wikiFts) return;
    try {
      const row = this.db.get<any>('SELECT * FROM wiki_pages WHERE id = ?', pageId);
      if (row) indexPage(this.app, row);
    } catch {
      /* search index is rebuilt on the next start */
    }
  }
}

// --- undo -------------------------------------------------------------------------------------------------------------

export interface UndoHelpers {
  del(kind: string, n?: number): void;
  keep(kind: string, n?: number): void;
  gone: string[];
  notes: string[];
}

/** Takes back what ExtraWriter wrote: ledger entries (also those of contacts that were only merged), reference pages and their space. */
export function undoExtra(app: App, loc: string, items: { kind: string; local_id: string; ext_id: string; created: number }[], h: UndoHelpers) {
  const db = app.db;
  undoPm(app, loc, items, h);
  undoObjects(app, loc, items, h);
  undoBooking(app, loc, items, h);
  // History entries the import wrote on contacts (they carry no foreign key, so they would stay behind).
  for (const it of items.filter((i) => i.kind === 'activity' && i.created)) {
    if (db.run('DELETE FROM activities WHERE id = ? AND location_id = ?', it.local_id, loc).changes) h.del('activities');
  }
  for (const it of items.filter((i) => i.kind === 'consent_event' && i.created)) {
    try {
      if (db.run('DELETE FROM consent_events WHERE id = ? AND location_id = ?', it.local_id, loc).changes) h.del('consent_events');
    } catch {
      /* ledger not installed */
    }
  }
  // Tickets (their timeline goes with them), unless somebody has answered in them since.
  for (const it of items.filter((i) => i.kind === 'ticket' && i.created)) {
    try {
      if (db.get('SELECT 1 FROM ticket_events WHERE ticket_id = ? AND (user_id IS NOT NULL OR message_id IS NOT NULL) LIMIT 1', it.local_id)) {
        h.keep('tickets');
        h.notes.push('Ein Ticket bleibt, weil darin inzwischen geantwortet wurde.');
        continue;
      }
      if (db.run('DELETE FROM tickets WHERE id = ? AND location_id = ?', it.local_id, loc).changes) (h.del('tickets'), h.gone.push(it.local_id));
    } catch {
      /* helpdesk not installed */
    }
  }
  // Imported messages (and the threads the import had to open, if nothing else is in them).
  for (const it of items.filter((i) => i.kind === 'message' && i.created)) {
    try {
      if (db.run('DELETE FROM messages WHERE id = ? AND location_id = ?', it.local_id, loc).changes) h.del('messages');
    } catch {
      /* inbox not installed */
    }
  }
  for (const it of items.filter((i) => i.kind === 'thread' && i.created)) {
    try {
      if (db.get('SELECT 1 FROM messages WHERE conversation_id = ? LIMIT 1', it.local_id)) continue;
      db.run('DELETE FROM conversations WHERE id = ? AND location_id = ?', it.local_id, loc);
    } catch {
      /* inbox not installed */
    }
  }
  // Knowledge base: articles first, then the categories nobody uses any more.
  for (const it of items.filter((i) => i.kind === 'kb_article' && i.created)) {
    try {
      if (db.run('DELETE FROM kb_articles WHERE id = ? AND location_id = ?', it.local_id, loc).changes) (h.del('articles'), h.gone.push(it.local_id));
    } catch {
      /* knowledge base not installed */
    }
  }
  for (const it of items.filter((i) => i.kind === 'kb_category' && i.created)) {
    try {
      if (db.get('SELECT 1 FROM kb_articles WHERE category_id = ? LIMIT 1', it.local_id)) {
        h.keep('kb_categories');
        continue;
      }
      if (db.run('DELETE FROM kb_categories WHERE id = ? AND location_id = ?', it.local_id, loc).changes) (h.del('kb_categories'), h.gone.push(it.local_id));
    } catch {
      /* knowledge base not installed */
    }
  }
  // Wiki pages (reference lists and imported documents): pages somebody has edited, or that have pages of their own below them, stay.
  for (const [kind, stat, label] of [
    ['wiki_page', 'references', 'Eine Referenzliste im Wiki'],
    ['wiki_doc', 'docs', 'Eine importierte Wiki-Seite'],
  ] as const) {
    const made = new Set(items.filter((i) => i.kind === kind && i.created).map((i) => i.local_id));
    const cand = new Map<string, { parent: string | null }>();
    for (const tid of made) {
      const p = db.get<{ parent_id: string | null; updated_by_name: string }>('SELECT parent_id, updated_by_name FROM wiki_pages WHERE id = ? AND location_id = ?', tid, loc);
      if (!p) continue;
      if (!p.updated_by_name.startsWith('Umzug (')) {
        h.keep(stat);
        h.notes.push(`${label} bleibt, weil sie inzwischen bearbeitet wurde.`);
        continue;
      }
      cand.set(tid, { parent: p.parent_id });
    }
    // A page with a child that does not go keeps its place too – until nothing changes any more.
    for (let again = true; again; ) {
      again = false;
      for (const [tid] of cand) {
        const stranger = db.all<{ id: string }>('SELECT id FROM wiki_pages WHERE parent_id = ? AND location_id = ?', tid, loc).some((c) => !cand.has(c.id));
        if (!stranger) continue;
        cand.delete(tid);
        h.keep(stat);
        h.notes.push(`${label} bleibt, weil darunter eigene Seiten liegen.`);
        again = true;
      }
    }
    const purge = [...cand.keys()];
    for (const tid of purge) (h.del(stat), h.gone.push(tid));
    if (purge.length) purgeIds(app, purge);
  }
  for (const it of items.filter((i) => i.kind === 'wiki_space' && i.created)) {
    const left = db.get('SELECT 1 FROM wiki_pages WHERE space_id = ? LIMIT 1', it.local_id);
    if (left) continue;
    if (db.run('DELETE FROM wiki_spaces WHERE id = ? AND location_id = ?', it.local_id, loc).changes) h.del('wiki_spaces');
  }
}
