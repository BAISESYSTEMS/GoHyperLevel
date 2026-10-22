import type { App } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { id, now, slugify, token as randomToken } from '../core/util.js';
import { cleanSteps } from '../modules/workflows.js';
import { ensureTags, getContact, logActivity, upsertContact, type Contact } from './contacts.js';
import {
  SOURCE_LABELS,
  fieldValue,
  parseTarget,
  type FieldType,
  type JobOptions,
  type Mapping,
  type Rec,
  type RCompany,
  type RContact,
  type RCourse,
  type RDeal,
  type REnrollment,
  type RForm,
  type RMembership,
  type RNote,
  type RPipeline,
  type RProduct,
  type RSmartList,
  type RTagRec,
  type RTask,
  type RTemplate,
  type RWorkflow,
  type RActivity,
  type SourceKey,
} from './umzug-core.js';
import { ExtraWriter } from './umzug-extra.js';
import { smartListById } from './smart-lists.js';
import { UNSUB_TOKEN, clip, cleanHtml, convertMergeTags, hasMergeTags, htmlToMarkdown, splitList, stripHtml, toDay } from './umzug-text.js';

/**
 * Applies normalised records to one sub-account. Idempotent through `umzug_ids` (vendor id → local id, per
 * vendor account), every created or merged row is noted in `umzug_items` for the undo, contacts are matched
 * by e-mail and phone, and nothing here emits events – imported contacts must not start workflows.
 * With `dry` set nothing is written: the same decisions are made and counted.
 */

export interface Stat {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}
export type Stats = Record<string, Stat>;

export interface WriterEnv {
  app: App;
  locationId: string;
  jobId: string;
  /** Namespace of the vendor account: ids are only unique inside it. */
  ns: string;
  source: SourceKey;
  mapping: Mapping;
  options: JobOptions;
  dry: boolean;
  stats: Stats;
  warn: (message: string) => void;
}

const CONSENT_LABEL: Record<string, string> = { unsubscribed: 'abgemeldet', bounced: 'unzustellbar', complained: 'Spam-Beschwerde', pending: 'unbestätigt', blocked: 'gesperrt' };
export const stageKey = (ext: string) => `um_${String(ext).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || id(6)}`;

type Local = { local: string; extra: string | null };

export class Writer {
  private readonly app: App;
  private readonly db: App['db'];
  private readonly loc: string;
  private readonly seen = new Set<string>();
  /** Dry run: what would exist by now. */
  private readonly virtual = new Set<string>();
  private fields = new Map<string, { type: string; label: string }>();
  private readonly knownTags = new Set<string>();
  private readonly label: string;
  /** Consent ledger entries, reference lists and the other kinds of the later importers (umzug-extra.ts). */
  private readonly extra: ExtraWriter;

  constructor(private env: WriterEnv) {
    this.app = env.app;
    this.db = env.app.db;
    this.loc = env.locationId;
    this.label = SOURCE_LABELS[env.source] ?? env.source;
    this.loadFields();
    this.extra = new ExtraWriter(
      { app: env.app, locationId: env.locationId, jobId: env.jobId, source: env.source, ns: env.ns, label: this.label, dry: env.dry, warn: env.warn },
      {
        getId: (k, e) => this.getId(k, e),
        setId: (k, e, l, x) => this.setId(k, e, l, x),
        item: (k, l, e, c, b) => this.item(k, l, e, c, b),
        stat: (k, w, n) => this.stat(k, w, n),
        contactLocal: (e) => this.contactLocal(e),
        virtual: this.virtual,
      },
    );
  }

  // --- id map and undo items -------------------------------------------------------------------

  private getId(kind: string, ext: string): Local | undefined {
    const r = this.db.get<{ local_id: string; extra: string | null }>('SELECT local_id, extra FROM umzug_ids WHERE location_id = ? AND ns = ? AND kind = ? AND ext_id = ?', this.loc, this.env.ns, kind, String(ext));
    return r ? { local: r.local_id, extra: r.extra } : this.env.dry && this.virtual.has(`${kind}:${ext}`) ? { local: `dry:${ext}`, extra: null } : undefined;
  }
  private setId(kind: string, ext: string, local: string, extra: string | null = null) {
    if (this.env.dry) return void this.virtual.add(`${kind}:${ext}`);
    this.db.run(
      `INSERT INTO umzug_ids (location_id, ns, kind, ext_id, local_id, extra, job_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(location_id, ns, kind, ext_id) DO UPDATE SET local_id = excluded.local_id, extra = excluded.extra, job_id = excluded.job_id, updated_at = excluded.updated_at`,
      this.loc,
      this.env.ns,
      kind,
      String(ext),
      local,
      extra,
      this.env.jobId,
      now(),
    );
  }
  /** Notes what this job did to a row; INSERT OR IGNORE keeps the first entry when a resumed job sees it again. */
  private item(kind: string, local: string, ext: string, created: boolean, before?: unknown) {
    if (this.env.dry) return;
    this.db.run('INSERT OR IGNORE INTO umzug_items (job_id, kind, local_id, ext_id, created, before) VALUES (?, ?, ?, ?, ?, ?)', this.env.jobId, kind, local, String(ext), created ? 1 : 0, before === undefined ? null : JSON.stringify(before));
  }
  private stat(key: string, what: keyof Stat, n = 1) {
    const s = (this.env.stats[key] ??= { created: 0, updated: 0, skipped: 0, failed: 0 });
    s[what] += n;
  }
  private exists(table: string, rowId: string) {
    return !!this.db.get(`SELECT 1 FROM ${table} WHERE id = ? AND location_id = ?`, rowId, this.loc);
  }

  /** Tags that do not exist yet (call before a write); recordTags notes them as created afterwards. */
  private freshTags(tags: string[]): string[] {
    const fresh: string[] = [];
    for (const t of tags) {
      if (this.knownTags.has(t)) continue;
      if (this.db.get('SELECT 1 FROM tags WHERE location_id = ? AND name = ?', this.loc, t)) this.knownTags.add(t);
      else fresh.push(t);
    }
    return fresh;
  }
  private recordTags(fresh: string[]) {
    for (const t of fresh) {
      const row = this.db.get<{ id: string }>('SELECT id FROM tags WHERE location_id = ? AND name = ?', this.loc, t);
      if (!row) continue;
      this.knownTags.add(t);
      this.item('tag', row.id, t, true);
      this.stat('tags', 'created');
    }
  }

  private loadFields() {
    this.fields = new Map(this.db.all<{ key: string; type: string; label: string }>('SELECT key, type, label FROM custom_fields WHERE location_id = ?', this.loc).map((f) => [f.key, { type: f.type, label: f.label }]));
  }

  // --- custom fields from the mapping -----------------------------------------------------------

  /** Creates the custom fields the mapping asks for (`new:<type>:<label>`); returns how many were new. */
  ensureFields(): number {
    let n = 0;
    const seenKeys = new Set<string>();
    for (const t of Object.values(this.env.mapping)) {
      const p = parseTarget(t);
      if (p.kind !== 'new' || seenKeys.has(p.key)) continue;
      seenKeys.add(p.key);
      if (this.fields.has(p.key)) {
        this.stat('custom_fields', 'updated');
        continue;
      }
      n++;
      this.stat('custom_fields', 'created');
      if (this.env.dry) continue;
      const rowId = id();
      this.db.run('INSERT OR IGNORE INTO custom_fields (id, location_id, key, label, type, options, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', rowId, this.loc, p.key, p.label, p.type, '[]', 100, now());
      this.item('custom_field', rowId, p.key, true);
      this.fields.set(p.key, { type: p.type, label: p.label });
    }
    return n;
  }

  // --- dispatch -------------------------------------------------------------------------------------

  apply(rec: Rec): void {
    switch (rec.kind) {
      case 'contact':
        return this.contact(rec);
      case 'tag':
        return this.tag(rec);
      case 'membership':
        return this.membership(rec);
      case 'smart_list':
        return this.smartList(rec);
      case 'company':
        return this.company(rec);
      case 'pipeline':
        return this.pipeline(rec);
      case 'deal':
        return this.deal(rec);
      case 'note':
        return this.note(rec);
      case 'task':
        return this.task(rec);
      case 'template':
        return this.template(rec);
      case 'product':
        return this.product(rec);
      case 'course':
        return this.course(rec);
      case 'enrollment':
        return this.enrollment(rec);
      case 'form':
        return this.form(rec);
      case 'workflow':
        return this.workflow(rec);
      case 'activity':
        return this.activity(rec);
      default:
        if (!this.extra.apply(rec)) throw new Error(`Unbekannte Art von Datensatz: ${(rec as { kind: string }).kind}`);
    }
  }

  // --- contacts -------------------------------------------------------------------------------------

  /** The contact input a record becomes under the mapping. */
  private contactInput(rec: RContact) {
    const fields: Record<string, string> = {};
    const custom: Record<string, string | number> = {};
    const tags: string[] = [...(rec.tags ?? [])];
    const notes: string[] = [];
    for (const [ref, raw] of Object.entries(rec.values)) {
      const t = parseTarget(this.env.mapping[ref]);
      switch (t.kind) {
        case 'std': {
          const v = fieldValue(Array.isArray(raw) ? raw[0] : raw, 'text');
          const val = v === undefined ? undefined : t.field === 'date_of_birth' ? toDay(v) : String(v);
          if (val !== undefined && !fields[t.field]) fields[t.field] = val;
          break;
        }
        case 'custom':
        case 'new': {
          const key = t.kind === 'custom' ? t.key : t.key;
          const type = this.fields.get(key)?.type ?? (t.kind === 'new' ? t.type : 'text');
          const v = fieldValue(raw, type);
          if (v !== undefined) custom[key] = v;
          break;
        }
        case 'tag': {
          // A cell like "a","b" or a;b holds several tags.
          const list = Array.isArray(raw) ? raw : splitList(raw);
          for (const x of list) {
            const s = String(x ?? '').trim();
            if (s && !/^(false|nein|no|0)$/i.test(s)) tags.push(`${t.prefix}${/^(true|ja|yes|1)$/i.test(s) && t.prefix ? '' : s}`.trim());
          }
          break;
        }
        case 'note': {
          const v = fieldValue(raw, 'textarea');
          if (v !== undefined && String(v).trim()) notes.push(String(v));
          break;
        }
      }
    }
    // A key that two source fields map to (merge field + custom field of the same name): first non-empty wins.
    if (rec.consent && rec.consent !== 'ok' && rec.consent !== 'unknown') tags.push(`${this.label}: ${CONSENT_LABEL[rec.consent] ?? rec.consent}`);
    if (this.env.options.tag) tags.push(this.env.options.tag);
    const dnd = !!rec.consent && rec.consent !== 'ok' && rec.consent !== 'unknown';
    return { fields, custom, tags: [...new Set(tags.map((t) => clip(t, 80)).filter(Boolean))], notes, dnd };
  }

  private contact(rec: RContact) {
    const key = `contact:${rec.ext}`;
    const inp = this.contactInput(rec);
    if (!inp.fields.email && !inp.fields.phone && !inp.fields.first_name && !inp.fields.last_name) {
      this.stat('contacts', 'skipped');
      return void this.env.warn(`Kontakt ${rec.ext} übersprungen: weder Name noch E-Mail noch Telefon`);
    }
    if (!inp.fields.source) inp.fields.source = `${this.label}-Import`;
    if (!inp.fields.company && rec.org_name) inp.fields.company = clip(rec.org_name, 200);
    const mapped = this.getId('contact', rec.ext);
    let existing: Contact | undefined = mapped && !mapped.local.startsWith('dry:') ? getContact(this.app, this.loc, mapped.local) : undefined;
    const ours = !!existing;
    if (!existing) {
      const email = inp.fields.email ? inp.fields.email.trim().toLowerCase() : '';
      if (email) existing = parseJson(this.db.get<Contact>('SELECT * FROM contacts WHERE location_id = ? AND email = ?', this.loc, email), ['tags', 'custom']);
      if (!existing && inp.fields.phone) {
        // upsertContact normalises phones; compare on the normalised form it would store.
        const probe = upsertProbePhone(inp.fields.phone);
        if (probe) existing = parseJson(this.db.get<Contact>('SELECT * FROM contacts WHERE location_id = ? AND phone = ?', this.loc, probe), ['tags', 'custom']);
      }
    }
    // Second sighting inside this job (the same person in two audiences): merge, don't overwrite.
    const again = this.seen.has(key);
    this.seen.add(key);
    const overwrite = ours ? !again : this.env.options.merge === 'overwrite';

    if (this.env.dry) {
      if (mapped) this.stat('contacts', 'updated');
      else if (existing) this.stat('contacts', 'updated');
      else this.stat('contacts', 'created');
      if (!mapped) this.virtual.add(key);
      this.extra.ledgerDry(rec);
      return;
    }

    const input: Record<string, any> = { tags: inp.tags, custom: {} as Record<string, any> };
    for (const [k, v] of Object.entries(inp.fields)) {
      if (k === 'source' && existing) continue;
      if (!existing || overwrite || !String((existing as any)[k] ?? '').trim()) input[k] = v;
    }
    for (const [k, v] of Object.entries(inp.custom)) {
      const cur = existing?.custom?.[k];
      if (!existing || overwrite || cur === undefined || cur === null || cur === '') input.custom[k] = v;
    }
    if (inp.dnd && !(existing?.dnd)) input.dnd = true;
    if (!existing && rec.created_at) input.created_at = rec.created_at;
    if (existing) input.id = existing.id;

    const before = existing && !ours ? snapshot(existing) : undefined;
    const fresh = this.freshTags(inp.tags);
    const { contact, created } = upsertContact(this.app, this.loc, input, { source: `${this.label}-Import`, quiet: true });
    this.recordTags(fresh);
    this.setId('contact', rec.ext, contact.id);
    this.item('contact', contact.id, rec.ext, created, before);
    this.stat('contacts', created ? 'created' : 'updated');
    this.extra.ledger(contact.id, rec, created);
    if (inp.dnd) logActivity(this.app, this.loc, contact.id, 'umzug.consent', `Einwilligung aus ${this.label} übernommen: ${CONSENT_LABEL[rec.consent!] ?? rec.consent}${rec.native_status ? ` (${rec.native_status})` : ''}`, { source: this.env.source, status: rec.native_status ?? rec.consent, at: rec.consent_at ?? null });
    for (const body of inp.notes) {
      const nid = id();
      this.db.insert('notes', { id: nid, location_id: this.loc, contact_id: contact.id, body: clip(body, 20_000), user_id: null, created_at: now() });
      this.item('note', nid, `${rec.ext}:note`, true);
    }
  }

  private contactLocal(ext?: string): string | undefined {
    if (!ext) return undefined;
    const m = this.getId('contact', ext);
    if (!m) return undefined;
    if (m.local.startsWith('dry:')) return m.local;
    return getContact(this.app, this.loc, m.local) ? m.local : undefined;
  }

  private tag(rec: RTagRec) {
    const name = clip(rec.name, 80).trim();
    if (!name) return;
    const had = this.db.get<{ id: string }>('SELECT id FROM tags WHERE location_id = ? AND name = ?', this.loc, name);
    if (had) return void this.stat('tags', 'updated');
    this.stat('tags', 'created');
    if (this.env.dry) return;
    const tid = id();
    this.db.run('INSERT OR IGNORE INTO tags (id, location_id, name, created_at) VALUES (?, ?, ?, ?)', tid, this.loc, name, now());
    this.item('tag', tid, name, true);
  }

  private membership(rec: RMembership) {
    const local = this.contactLocal(rec.contact);
    if (!local) return void this.stat('memberships', 'skipped');
    this.stat('memberships', 'updated');
    if (this.env.dry || local.startsWith('dry:')) return;
    const c = getContact(this.app, this.loc, local)!;
    const add = rec.tags.map((t) => clip(t, 80).trim()).filter((t) => t && !c.tags.includes(t));
    if (!add.length) return;
    const fresh = this.freshTags(add);
    ensureTags(this.app, this.loc, add);
    this.recordTags(fresh);
    this.db.update('contacts', c.id, { tags: [...c.tags, ...add], updated_at: now() });
  }

  private smartList(rec: RSmartList) {
    const name = clip(rec.name, 100).trim() || 'Segment';
    const known = this.getId('smart_list', rec.ext);
    const filter = rec.tag ? { tags: [clip(rec.tag, 80)] } : {};
    // The importer acts for nobody: it only updates shared lists – one somebody made private since counts as missing (services/smart-lists.ts).
    if (known && smartListById(this.app, this.loc, known.local, { user: null })) {
      this.stat('smart_lists', 'updated');
      if (!this.env.dry) this.db.update('smart_lists', known.local, { name, filter });
      return;
    }
    this.stat('smart_lists', 'created');
    if (this.env.dry) return void this.virtual.add(`smart_list:${rec.ext}`);
    const sid = id();
    this.db.insert('smart_lists', { id: sid, location_id: this.loc, name, filter, created_at: now() });
    this.setId('smart_list', rec.ext, sid);
    this.item('smart_list', sid, rec.ext, true);
  }

  private company(rec: RCompany) {
    const svc = this.app.services.companies;
    const name = clip(rec.name, 200).trim() || `Firma ${rec.ext}`;
    if (typeof svc?.upsert !== 'function') {
      // No companies module: the contact keeps the name in its "Firma" field (see contact.org_name).
      this.setId('company', rec.ext, '', name);
      return void this.stat('companies', 'skipped');
    }
    const known = this.getId('company', rec.ext);
    if (this.env.dry) {
      this.stat('companies', known ? 'updated' : 'created');
      this.setId('company', rec.ext, '', name);
      return;
    }
    const r = svc.upsert(this.loc, {
      name,
      domain: rec.domain ?? '',
      website: rec.website ?? '',
      phone: rec.phone ?? '',
      address: rec.address ?? '',
      city: rec.city ?? '',
      postal_code: rec.postal_code ?? '',
      country: rec.country ?? '',
      industry: rec.industry ?? '',
      external_source: `umzug-${this.env.source}`,
      external_id: `${this.env.ns}:${rec.ext}`.slice(0, 120),
      existing_id: known?.local || undefined,
    });
    const cid = typeof r === 'string' ? r : r?.id;
    this.setId('company', rec.ext, cid ?? '', name);
    if (cid) this.item('company', cid, rec.ext, !!r?.created && !known);
    this.stat('companies', r?.created && !known ? 'created' : 'updated');
  }

  /** Links a contact to the company imported before (companies module); without one the name is already in "Firma". */
  linkCompany(contactExt: string, orgExt: string | undefined) {
    if (!orgExt || this.env.dry) return;
    const org = this.getId('company', orgExt);
    const local = this.contactLocal(contactExt);
    const svc = this.app.services.companies;
    if (!org?.local || !local || local.startsWith('dry:') || typeof svc?.linkContact !== 'function') return;
    try {
      svc.linkContact(this.loc, org.local, local);
    } catch {
      /* already linked */
    }
  }

  // --- pipelines and deals ---------------------------------------------------------------------------

  private pipeline(rec: RPipeline) {
    const name = clip(rec.name, 100).trim() || 'Pipeline';
    const stages = rec.stages.map((s) => ({ id: stageKey(s.ext), name: clip(s.name, 80) || 'Stufe', ...(s.probability !== undefined ? { probability: Math.max(0, Math.min(100, Math.round(s.probability))) } : {}) }));
    if (!stages.length) stages.push({ id: stageKey('start'), name: 'Neu' });
    const known = this.getId('pipeline', rec.ext);
    const row = known && !known.local.startsWith('dry:') ? parseJson(this.db.get('SELECT * FROM pipelines WHERE id = ? AND location_id = ?', known.local, this.loc), ['stages']) : undefined;
    if (this.env.dry) {
      this.stat('pipelines', row ? 'updated' : 'created');
      return void this.virtual.add(`pipeline:${rec.ext}`);
    }
    if (row) {
      // Stages a person added later stay.
      const keep = (row.stages ?? []).filter((s: any) => !String(s.id).startsWith('um_') && !stages.some((x) => x.id === s.id));
      this.db.run('UPDATE pipelines SET name = ?, stages = ? WHERE id = ?', name, JSON.stringify([...stages, ...keep]), row.id);
      this.setId('pipeline', rec.ext, row.id);
      return void this.stat('pipelines', 'updated');
    }
    const pid = id();
    this.db.insert('pipelines', { id: pid, location_id: this.loc, name, stages, created_at: now() });
    this.setId('pipeline', rec.ext, pid);
    this.item('pipeline', pid, rec.ext, true);
    this.stat('pipelines', 'created');
  }

  private deal(rec: RDeal) {
    const pipe = this.getId('pipeline', rec.pipeline);
    if (!pipe) return void this.stat('deals', 'skipped'), void this.env.warn(`Deal „${clip(rec.name, 60)}“ übersprungen: Pipeline nicht übernommen`);
    let contact = this.contactLocal(rec.contact);
    if (!contact && rec.contact_hint?.email && !this.env.dry) {
      const { contact: c, created } = upsertContact(this.app, this.loc, { email: rec.contact_hint.email, name: rec.contact_hint.name, source: `${this.label}-Import` }, { source: `${this.label}-Import`, quiet: true });
      contact = c.id;
      this.item('contact', c.id, `deal:${rec.ext}`, created);
      this.stat('contacts', created ? 'created' : 'updated');
    }
    if (!contact) {
      this.stat('deals', 'skipped');
      this.stat('deals_without_contact', 'skipped');
      return;
    }
    const known = this.getId('deal', rec.ext);
    if (this.env.dry) {
      this.stat('deals', known ? 'updated' : 'created');
      return void this.virtual.add(`deal:${rec.ext}`);
    }
    const stageId = stageKey(rec.stage);
    const row = {
      pipeline_id: pipe.local,
      stage_id: stageId,
      contact_id: contact,
      name: clip(rec.name, 200) || 'Deal',
      value: Math.round(Number(rec.value) || 0),
      status: rec.status,
      source: `${this.label}-Import`,
      updated_at: now(),
    };
    // A stage the pipeline step did not create (deleted in the source meanwhile): first stage of the pipeline.
    const p = parseJson(this.db.get('SELECT stages FROM pipelines WHERE id = ?', pipe.local), ['stages']);
    if (!p?.stages?.some((s: any) => s.id === stageId)) row.stage_id = p?.stages?.[0]?.id ?? stageId;
    const there = known && this.db.get<{ id: string; stage_id: string }>('SELECT id, stage_id FROM opportunities WHERE id = ? AND location_id = ?', known.local, this.loc);
    if (there) {
      this.db.update('opportunities', there.id, { ...row, ...(there.stage_id !== row.stage_id ? { stage_changed_at: now() } : {}) });
      this.item('opportunity', there.id, rec.ext, false);
      return void this.stat('deals', 'updated');
    }
    const oid = id();
    this.db.insert('opportunities', { id: oid, location_id: this.loc, created_at: rec.created_at ?? now(), stage_changed_at: now(), ...row });
    this.setId('deal', rec.ext, oid);
    this.item('opportunity', oid, rec.ext, true);
    this.stat('deals', 'created');
  }

  // --- notes, tasks, history ----------------------------------------------------------------------------

  private contactOfDeal(ext?: string): string | undefined {
    if (!ext) return undefined;
    const d = this.getId('deal', ext);
    if (!d || d.local.startsWith('dry:')) return d ? d.local : undefined;
    return this.db.get<{ contact_id: string }>('SELECT contact_id FROM opportunities WHERE id = ? AND location_id = ?', d.local, this.loc)?.contact_id;
  }

  private note(rec: RNote) {
    const contact = this.contactLocal(rec.contact) ?? this.contactOfDeal(rec.deal);
    if (!contact) return void this.stat('notes', 'skipped');
    const body = clip(rec.body, 20_000).trim() || '(leer)';
    const known = this.getId('note', rec.ext);
    if (this.env.dry) {
      this.stat('notes', known ? 'updated' : 'created');
      return void this.virtual.add(`note:${rec.ext}`);
    }
    if (known && this.db.get('SELECT 1 FROM notes WHERE id = ? AND location_id = ?', known.local, this.loc)) {
      this.db.run('UPDATE notes SET body = ?, contact_id = ? WHERE id = ? AND location_id = ?', body, contact, known.local, this.loc);
      return void this.stat('notes', 'updated');
    }
    const nid = id();
    this.db.insert('notes', { id: nid, location_id: this.loc, contact_id: contact, body, user_id: null, created_at: rec.at ?? now() });
    this.setId('note', rec.ext, nid);
    this.item('note', nid, rec.ext, true);
    this.stat('notes', 'created');
  }

  private task(rec: RTask) {
    const contact = this.contactLocal(rec.contact) ?? this.contactOfDeal(rec.deal);
    const known = this.getId('task', rec.ext);
    if (this.env.dry) {
      this.stat('tasks', known ? 'updated' : 'created');
      return void this.virtual.add(`task:${rec.ext}`);
    }
    const title = clip(`${rec.type && !/^task$/i.test(rec.type) ? `${rec.type[0].toUpperCase()}${rec.type.slice(1)}: ` : ''}${rec.title || 'Aufgabe'}`, 300);
    const row = {
      contact_id: contact && !contact.startsWith('dry:') ? contact : null,
      title,
      description: clip(rec.description, 5000),
      due_at: rec.due_at ?? null,
      done: rec.done ? 1 : 0,
      completed_at: rec.done ? (rec.completed_at ?? rec.due_at ?? now()) : null,
    };
    if (known && this.db.get('SELECT 1 FROM tasks WHERE id = ? AND location_id = ?', known.local, this.loc)) {
      this.db.update('tasks', known.local, row, this.loc);
      return void this.stat('tasks', 'updated');
    }
    const tid = id();
    this.db.insert('tasks', { id: tid, location_id: this.loc, created_at: now(), assigned_to: null, ...row });
    this.setId('task', rec.ext, tid);
    this.item('task', tid, rec.ext, true);
    this.stat('tasks', 'created');
  }

  private activity(rec: RActivity) {
    const contact = this.contactLocal(rec.contact);
    if (!contact) return void this.stat('activities', 'skipped');
    const known = this.getId('activity', rec.ext);
    if (this.env.dry) {
      this.stat('activities', known ? 'updated' : 'created');
      return void this.virtual.add(`activity:${rec.ext}`);
    }
    if (known && this.db.get('SELECT 1 FROM activities WHERE id = ? AND location_id = ?', known.local, this.loc)) return void this.stat('activities', 'updated');
    const aid = id();
    this.db.insert('activities', { id: aid, location_id: this.loc, contact_id: contact, type: clip(rec.type, 60), summary: clip(rec.summary, 300), data: rec.data ?? {}, created_at: rec.at ?? now() });
    this.setId('activity', rec.ext, aid);
    this.item('activity', aid, rec.ext, true);
    this.stat('activities', 'created');
  }

  // --- templates, products, forms ---------------------------------------------------------------------------

  private template(rec: RTemplate) {
    const known = this.getId('template', rec.ext);
    const v = hasMergeTags(this.env.source) ? this.env.source : undefined;
    let html = cleanHtml(rec.html ?? '');
    let subject = rec.subject ?? '';
    const unknownTags = new Set<string>();
    if (v) {
      for (const f of ['html', 'subject'] as const) {
        const src = f === 'html' ? html : subject;
        const out = convertMergeTags(v, src);
        out.unknown.forEach((u) => unknownTags.add(u));
        if (f === 'html') html = out.text;
        else subject = out.text;
      }
    }
    if (unknownTags.size) this.env.warn(`Vorlage „${clip(rec.name, 60)}“: Platzhalter ohne Entsprechung bleiben stehen: ${[...unknownTags].slice(0, 5).join(', ')}`);
    const isHtml = /<[a-z][\s\S]*>/i.test(html);
    if (isHtml && !html.includes(UNSUB_TOKEN) && /<\/body>/i.test(html)) this.env.warn(`Vorlage „${clip(rec.name, 60)}“ enthält keinen Abmeldelink – HyperLevel fügt beim Versand eine Fußzeile hinzu`);
    const row = { name: clip(rec.name, 200) || 'Vorlage', channel: 'email', subject: clip(subject, 300), body: html || clip(rec.text, 200_000), is_html: isHtml ? 1 : 0, body_text: clip(rec.text || (isHtml ? stripHtml(html) : ''), 100_000), updated_at: now() };
    if (this.env.dry) {
      this.stat('templates', known ? 'updated' : 'created');
      return void this.virtual.add(`template:${rec.ext}`);
    }
    if (known && this.db.get('SELECT 1 FROM templates WHERE id = ? AND location_id = ?', known.local, this.loc)) {
      this.db.update('templates', known.local, row, this.loc);
      return void this.stat('templates', 'updated');
    }
    const tid = id();
    this.db.insert('templates', { id: tid, location_id: this.loc, created_at: now(), ...row });
    this.setId('template', rec.ext, tid);
    this.item('template', tid, rec.ext, true);
    this.stat('templates', 'created');
  }

  private product(rec: RProduct) {
    const known = this.getId('product', rec.ext);
    if (this.env.dry) {
      this.stat('products', known ? 'updated' : 'created');
      return void this.virtual.add(`product:${rec.ext}`);
    }
    const row = {
      name: clip(rec.name, 200) || 'Produkt',
      description: clip(rec.description, 5000),
      price_cents: Math.max(0, Math.round(rec.price_cents || 0)),
      currency: /^[A-Z]{3}$/.test(rec.currency ?? '') ? rec.currency : 'EUR',
      recurring: rec.recurring?.interval === 'year' ? 'year' : rec.recurring ? 'month' : null,
      active: rec.active === false ? 0 : 1,
    };
    if (rec.recurring && rec.recurring.interval === 'week') this.env.warn(`Produkt „${clip(rec.name, 60)}“ wird wöchentlich abgerechnet – HyperLevel kennt monatlich und jährlich; bitte prüfen`);
    if (known && this.db.get('SELECT 1 FROM products WHERE id = ? AND location_id = ?', known.local, this.loc)) {
      this.db.update('products', known.local, row, this.loc);
      return void this.stat('products', 'updated');
    }
    const pid = id();
    this.db.insert('products', { id: pid, location_id: this.loc, tax_rate: null, payment_link: null, created_at: now(), ...row });
    this.setId('product', rec.ext, pid);
    this.item('product', pid, rec.ext, true);
    this.stat('products', 'created');
  }

  private form(rec: RForm) {
    const known = this.getId('form', rec.ext);
    if (this.env.dry) {
      this.stat('forms', known ? 'updated' : 'created');
      return void this.virtual.add(`form:${rec.ext}`);
    }
    const TYPES = ['text', 'email', 'phone', 'textarea', 'select', 'radio', 'checkbox', 'date', 'number'];
    const fields = (rec.fields?.length ? rec.fields : [{ label: 'Vorname', type: 'text', required: true }, { label: 'E-Mail', type: 'email', required: true }]).slice(0, 60).map((f, i) => ({
      id: `f${i + 1}`,
      type: TYPES.includes(String(f.type)) ? String(f.type) : 'text',
      label: clip(f.label, 200) || `Feld ${i + 1}`,
      name: /e-?mail/i.test(f.label) ? 'email' : /vorname|first/i.test(f.label) ? 'first_name' : /nachname|last/i.test(f.label) ? 'last_name' : /telefon|phone/i.test(f.label) ? 'phone' : `field_${i + 1}`,
      required: !!f.required,
      options: (f.options ?? []).map(String).slice(0, 100),
      placeholder: '',
      value: '',
      show_if: null,
    }));
    fields.push({ id: `f${fields.length + 1}`, type: 'consent', label: 'Ich stimme der Verarbeitung meiner Daten gemäß Datenschutzerklärung zu.', name: 'consent', required: true, options: [], placeholder: '', value: '', show_if: null });
    const settings = { submit_text: 'Absenden', thank_you: 'Danke! Wir melden uns in Kürze.', tags: [], notify_team: true, umzug: { source: this.env.source, note: rec.note ?? 'Aus dem Umzug – bitte prüfen' } };
    const name = clip(`${rec.name} (aus ${this.label}, bitte prüfen)`, 120);
    if (known && this.exists('forms', known.local)) {
      this.db.update('forms', known.local, { name, fields, settings, updated_at: now() }, this.loc);
      return void this.stat('forms', 'updated');
    }
    const fid = id();
    this.db.insert('forms', { id: fid, location_id: this.loc, name, kind: 'form', fields, settings, created_at: now(), updated_at: now() });
    this.setId('form', rec.ext, fid);
    this.item('form', fid, rec.ext, true);
    this.stat('forms', 'created');
  }

  // --- courses -------------------------------------------------------------------------------------------------

  private course(rec: RCourse) {
    const known = this.getId('course', rec.ext);
    const lessonCount = rec.modules.reduce((n, m) => n + m.lessons.length, 0);
    if (this.env.dry) {
      this.stat('courses', known ? 'updated' : 'created');
      this.stat('lessons', known ? 'updated' : 'created', lessonCount);
      return void this.virtual.add(`course:${rec.ext}`);
    }
    let cid = known && this.exists('courses', known.local) ? known.local : '';
    const cover = /^https?:\/\/[^\s]+$/i.test(rec.cover ?? '') ? clip(rec.cover, 1000) : '';
    const title = clip(rec.title, 160) || 'Kurs';
    if (cid) {
      this.db.update('courses', cid, { title, description: clip(rec.description, 5000), ...(cover ? { cover_image: cover } : {}), updated_at: now() }, this.loc);
      this.stat('courses', 'updated');
    } else {
      cid = id();
      let slug = slugify(title) || 'kurs';
      for (let i = 2; this.db.get('SELECT 1 FROM courses WHERE location_id = ? AND slug = ?', this.loc, slug); i++) slug = `${slugify(title) || 'kurs'}-${i}`;
      const pos = this.db.get<{ n: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM courses WHERE location_id = ?', this.loc)!.n;
      this.db.insert('courses', { id: cid, location_id: this.loc, title, slug, description: clip(rec.description, 5000), cover_image: cover, status: 'draft', position: pos, access: { tags: [`kurs:${slug}`] }, settings: {}, created_at: now(), updated_at: now() });
      this.setId('course', rec.ext, cid);
      this.item('course', cid, rec.ext, true);
      this.stat('courses', 'created');
    }
    rec.modules.forEach((m, mi) => {
      const km = this.getId('module', `${rec.ext}/${m.ext}`);
      let mid = km && this.db.get('SELECT 1 FROM course_modules WHERE id = ? AND course_id = ?', km.local, cid) ? km.local : '';
      if (mid) this.db.update('course_modules', mid, { title: clip(m.title, 160) || `Modul ${mi + 1}`, position: mi, updated_at: now() });
      else {
        mid = id();
        this.db.insert('course_modules', { id: mid, location_id: this.loc, course_id: cid, title: clip(m.title, 160) || `Modul ${mi + 1}`, position: mi, drip_days: 0, published: 1, created_at: now(), updated_at: now() });
        this.setId('module', `${rec.ext}/${m.ext}`, mid);
        this.item('module', mid, `${rec.ext}/${m.ext}`, true);
      }
      m.lessons.forEach((l, li) => {
        const kl = this.getId('lesson', `${rec.ext}/${l.ext}`);
        const video = /^https?:\/\/[^\s]+$/i.test(l.video_url ?? '') ? clip(l.video_url, 1000) : '';
        const lrow = { module_id: mid, title: clip(l.title, 160) || `Lektion ${li + 1}`, position: li, video_url: video, body: clip(htmlToMarkdown(l.body ?? ''), 100_000), duration_min: Math.max(0, Math.round(l.duration_min ?? 0)), published: l.published === false ? 0 : 1, updated_at: now() };
        if (kl && this.db.get('SELECT 1 FROM course_lessons WHERE id = ? AND course_id = ?', kl.local, cid)) {
          this.db.update('course_lessons', kl.local, lrow);
          this.stat('lessons', 'updated');
        } else {
          const lid = id();
          this.db.insert('course_lessons', { id: lid, location_id: this.loc, course_id: cid, downloads: [], drip_days: 0, created_at: now(), ...lrow });
          this.setId('lesson', `${rec.ext}/${l.ext}`, lid);
          this.item('lesson', lid, `${rec.ext}/${l.ext}`, true);
          this.stat('lessons', 'created');
        }
      });
    });
  }

  private enrollment(rec: REnrollment) {
    const course = this.getId('course', rec.course);
    let contact = this.contactLocal(rec.contact);
    if (!course) return void this.stat('enrollments', 'skipped');
    if (!contact && rec.email && !this.env.dry) {
      const { contact: c, created } = upsertContact(this.app, this.loc, { email: rec.email, name: rec.name, source: `${this.label}-Import` }, { source: `${this.label}-Import`, quiet: true });
      contact = c.id;
      this.setId('contact', rec.contact ?? `email:${rec.email}`, c.id);
      this.item('contact', c.id, rec.contact ?? `email:${rec.email}`, created);
      this.stat('contacts', created ? 'created' : 'updated');
    }
    if (!contact) return void this.stat('enrollments', 'skipped');
    const known = this.getId('enrollment', rec.ext);
    if (this.env.dry) {
      this.stat('enrollments', known ? 'updated' : 'created');
      return void this.virtual.add(`enrollment:${rec.ext}`);
    }
    const cur = this.db.get<{ id: string }>('SELECT id FROM course_enrollments WHERE course_id = ? AND contact_id = ?', course.local, contact);
    let eid = cur?.id;
    if (eid) {
      this.db.run(`UPDATE course_enrollments SET completed_at = COALESCE(?, completed_at) WHERE id = ?`, rec.completed_at ?? null, eid);
      this.item('enrollment', eid, rec.ext, false);
      this.stat('enrollments', 'updated');
    } else {
      eid = id();
      this.db.insert('course_enrollments', { id: eid, location_id: this.loc, course_id: course.local, contact_id: contact, status: 'active', source: 'umzug', source_ref: this.env.source, enrolled_at: rec.enrolled_at ?? now(), started_at: rec.lessons_done?.length ? (rec.enrolled_at ?? now()) : null, completed_at: rec.completed_at ?? null, created_at: now() });
      this.setId('enrollment', rec.ext, eid);
      this.item('enrollment', eid, rec.ext, true);
      this.stat('enrollments', 'created');
    }
    for (const l of rec.lessons_done ?? []) {
      const lesson = this.getId('lesson', `${rec.course}/${l}`);
      if (!lesson) continue;
      this.db.run('INSERT OR IGNORE INTO course_progress (enrollment_id, lesson_id, completed_at, last_viewed_at) VALUES (?, ?, ?, ?)', eid, lesson.local, rec.completed_at ?? rec.enrolled_at ?? now(), now());
    }
  }

  // --- workflow drafts -------------------------------------------------------------------------------------------

  private workflow(rec: RWorkflow) {
    const known = this.getId('workflow', rec.ext);
    if (this.env.dry) {
      this.stat('workflows', known ? 'updated' : 'created');
      return void this.virtual.add(`workflow:${rec.ext}`);
    }
    const head = { type: 'add_note', body: `UMZUG – BITTE PRÜFEN: Entwurf aus ${this.label}. ${rec.warnings.length ? rec.warnings.join(' · ') : 'Alle Schritte wurden übernommen.'} Prüfe Auslöser, Texte und Verzweigungen, bevor du ihn aktivierst.` };
    let trigger = rec.trigger;
    let steps: any[];
    try {
      steps = cleanSteps([head, ...rec.steps]);
    } catch (e) {
      steps = cleanSteps([head, { type: 'add_note', body: `Schritte konnten nicht übernommen werden (${(e as Error).message}). Original: ${clip(JSON.stringify(rec.steps), 4000)}` }]);
    }
    const name = clip(`${rec.name} (aus ${this.label}, bitte prüfen)`, 200);
    const settings = { allow_reentry: false, stop_on_error: false, umzug: { source: this.env.source, ext: rec.ext, warnings: rec.warnings.slice(0, 50) } };
    if (!trigger?.type) trigger = { type: 'manual', config: {} };
    if (known && this.exists('workflows', known.local)) {
      // A draft a person already changed stays: only name and notes are refreshed while it is still a draft.
      const cur = this.db.get<{ status: string }>('SELECT status FROM workflows WHERE id = ?', known.local);
      if (cur?.status === 'draft') this.db.update('workflows', known.local, { name, trigger, steps, settings, updated_at: now() }, this.loc);
      return void this.stat('workflows', 'updated');
    }
    const wid = id();
    this.db.insert('workflows', { id: wid, location_id: this.loc, name, status: 'draft', trigger, steps, settings, webhook_key: randomToken(16), created_at: now(), updated_at: now() });
    this.setId('workflow', rec.ext, wid);
    this.item('workflow', wid, rec.ext, true);
    this.stat('workflows', 'created');
    for (const w of rec.warnings) this.env.warn(`Automation „${clip(rec.name, 60)}“: ${w}`);
  }
}

const snapshot = (c: Contact) => ({ first_name: c.first_name, last_name: c.last_name, email: c.email, phone: c.phone, company: c.company, address: c.address, city: c.city, postal_code: c.postal_code, country: c.country, website: c.website, date_of_birth: c.date_of_birth ?? null, source: c.source, tags: c.tags, custom: c.custom, dnd: c.dnd });

/** What upsertContact would store for a phone (same normalisation), so merging finds the contact. */
function upsertProbePhone(p: string): string {
  let s = p.trim().replace(/[^\d+]/g, '');
  if (!s) return '';
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  else if (s.startsWith('0')) s = `+49${s.slice(1)}`;
  else if (!s.startsWith('+') && s.length > 6) s = `+${s}`;
  return s;
}

export type { FieldType };
