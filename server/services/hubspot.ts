import type { App } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { id, now, slugify } from '../core/util.js';
import { getContact, upsertContact } from './contacts.js';

/**
 * HubSpot → HyperLevel import: owners (→ users by email), contact properties (→ custom fields),
 * companies, contacts, lists (→ tags), deal pipelines and deals, notes, tasks, calls/e-mails/
 * meetings (→ activity history) and tickets (when a helpdesk module offers ticketsImport).
 * Idempotent through the hubspot_ids table, resumable through a saved cursor per step, and
 * gentle with HubSpot's limits (pause between calls, Retry-After / backoff on 429 and 5xx).
 */

const BASE = 'https://api.hubapi.com';

export const HUBSPOT_PARTS = ['owners', 'contacts', 'companies', 'deals', 'notes', 'tasks', 'engagements', 'tickets', 'lists'] as const;
export type HubSpotPart = (typeof HUBSPOT_PARTS)[number];
export const PART_LABELS: Record<HubSpotPart, string> = {
  owners: 'Owner → Nutzer (per E-Mail)',
  contacts: 'Kontakte inkl. Eigenschaften → eigene Felder',
  companies: 'Firmen',
  deals: 'Deals mit Pipelines und Stufen',
  notes: 'Notizen',
  tasks: 'Aufgaben',
  engagements: 'Anrufe, E-Mails, Meetings → Aktivitäten',
  tickets: 'Tickets (wenn ein Helpdesk-Modul da ist)',
  lists: 'Listen → Tags',
};

/** Steps in run order; a part may have several (engagements = calls, emails, meetings). */
const STEPS: { step: string; part: HubSpotPart }[] = [
  { step: 'owners', part: 'owners' },
  { step: 'properties', part: 'contacts' },
  { step: 'companies', part: 'companies' },
  { step: 'contacts', part: 'contacts' },
  { step: 'lists', part: 'lists' },
  { step: 'pipelines', part: 'deals' },
  { step: 'deals', part: 'deals' },
  { step: 'notes', part: 'notes' },
  { step: 'tasks', part: 'tasks' },
  { step: 'calls', part: 'engagements' },
  { step: 'emails', part: 'engagements' },
  { step: 'meetings', part: 'engagements' },
  { step: 'tickets', part: 'tickets' },
];

export function stepsFor(parts: HubSpotPart[]): string[] {
  // Deals, notes and history need the contacts' ids, lists need contacts too – contacts come along.
  return STEPS.filter((s) => parts.includes(s.part)).map((s) => s.step);
}

export class HubSpotError extends Error {
  constructor(
    public status: number,
    message: string,
    public path: string,
    public category?: string,
  ) {
    super(message);
  }
}

export interface HubSpotClientOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Pause after each successful call (HubSpot private apps: about 10 calls per second). */
  pauseMs?: number;
  maxRetries?: number;
  /** Per-call timeout (default 30 s). */
  timeoutMs?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class HubSpotClient {
  readonly waits: number[] = [];
  calls = 0;
  constructor(
    private token: string,
    private opts: HubSpotClientOptions = {},
  ) {}

  async req(method: string, path: string, init: { query?: Record<string, unknown>; body?: unknown } = {}): Promise<any> {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    const f = this.opts.fetch ?? fetch;
    const sleep = this.opts.sleep ?? realSleep;
    const max = this.opts.maxRetries ?? 6;
    for (let attempt = 0; ; attempt++) {
      this.calls++;
      let r: Response;
      try {
        r = await f(url, {
          method,
          headers: { authorization: `Bearer ${this.token}`, accept: 'application/json', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
        });
      } catch (e) {
        if (attempt >= max) throw new HubSpotError(0, `HubSpot nicht erreichbar: ${(e as Error).message}`, path);
        const wait = Math.min(1000 * 2 ** attempt, 30_000);
        this.waits.push(wait);
        await sleep(wait);
        continue;
      }
      if (r.status === 429 || r.status >= 500) {
        if (attempt >= max) throw new HubSpotError(r.status, r.status === 429 ? 'HubSpot-Limit erreicht – bitte später fortsetzen' : `HubSpot antwortet mit ${r.status}`, path);
        const ra = Number(r.headers.get('retry-after'));
        const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60_000) : Math.min(1000 * 2 ** attempt, 30_000);
        this.waits.push(wait);
        await sleep(wait);
        continue;
      }
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = r.status === 401 ? 'HubSpot-Token ungültig oder abgelaufen' : r.status === 403 ? `Fehlende Berechtigung (Scope) für ${path.split('?')[0]}` : r.status === 404 ? `Bei HubSpot nicht vorhanden (${path.split('?')[0]})` : j.message || `HTTP ${r.status}`;
        throw new HubSpotError(r.status, msg, path, j.category);
      }
      if (this.opts.pauseMs) await sleep(this.opts.pauseMs);
      return j;
    }
  }
}

// --- pure mapping helpers -----------------------------------------------------------------

export function mapPropertyType(p: { type?: string; fieldType?: string }): string {
  const ft = p.fieldType ?? '';
  switch (p.type) {
    case 'number':
      return 'number';
    case 'date':
    case 'datetime':
      return 'date';
    case 'bool':
      return 'checkbox';
    case 'enumeration':
      return ft === 'checkbox' || ft === 'booleancheckbox' ? 'checkbox' : 'select';
    case 'phone_number':
      return 'phone';
    default:
      return ft === 'textarea' ? 'textarea' : ft === 'phonenumber' ? 'phone' : 'text';
  }
}

export const fieldKey = (name: string) => String(name).toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || slugify(name).replace(/-/g, '_');

/** HubSpot dates come as YYYY-MM-DD, ISO or epoch milliseconds. */
export function toDay(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = /^\d{11,}$/.test(s) ? new Date(Number(s)) : new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}
export function toIso(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v);
  const d = /^\d{11,}$/.test(s) ? new Date(Number(s)) : new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function stripHtml(html: unknown): string {
  return String(html ?? '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Status of a deal from its stage (closed + probability) or the hs_is_closed_won flag. */
export function dealStatus(props: Record<string, any>, stage?: { metadata?: Record<string, any> }): 'open' | 'won' | 'lost' {
  if (props.hs_is_closed_won === 'true' || props.hs_is_closed_won === true) return 'won';
  const md = stage?.metadata ?? {};
  const closed = md.isClosed === 'true' || md.isClosed === true || props.hs_is_closed === 'true';
  if (!closed) return 'open';
  return Number(md.probability ?? 0) >= 1 ? 'won' : 'lost';
}

export const stageKey = (hsStageId: string) => `hs_${String(hsStageId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40)}`;

/** Readable value of an enumeration property (value → label, multi-values with ;). */
export function propValue(prop: { type?: string; options?: { label: string; value: string }[] } | undefined, raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  const s = String(raw);
  if (!prop) return s;
  if (prop.type === 'enumeration' && prop.options?.length) return s.split(';').map((v) => prop.options!.find((o) => o.value === v)?.label ?? v).join(', ');
  if (prop.type === 'bool') return s === 'true' ? 'ja' : s === 'false' ? 'nein' : s;
  if (prop.type === 'date' || prop.type === 'datetime') return toDay(s) ?? s;
  return s;
}

const STANDARD_CONTACT: Record<string, string> = {
  firstname: 'first_name',
  lastname: 'last_name',
  email: 'email',
  phone: 'phone',
  company: 'company',
  address: 'address',
  city: 'city',
  zip: 'postal_code',
  country: 'country',
  website: 'website',
  date_of_birth: 'date_of_birth',
};
/** HubSpot standard properties worth keeping as custom fields. */
const EXTRA_CUSTOM: Record<string, string> = { jobtitle: 'Position', lifecyclestage: 'Lebenszyklus-Phase', hs_lead_status: 'Lead-Status', industry: 'Branche', state: 'Bundesland', mobilephone: 'Mobiltelefon' };

// --- import runner ---------------------------------------------------------------------------

export interface HubSpotProgress {
  step: string;
  done_steps: string[];
  cursor: string | null;
  processed: number;
  counts: Record<string, number>;
  skipped: Record<string, number>;
  totals: Record<string, number>;
  notes: string[];
}

export const emptyProgress = (): HubSpotProgress => ({ step: '', done_steps: [], cursor: null, processed: 0, counts: {}, skipped: {}, totals: {}, notes: [] });

export interface RunHooks {
  save: (p: HubSpotProgress) => void;
  log: (line: string) => void;
  cancelled: () => boolean;
}

export class Cancelled extends Error {}

type IdMap = { get: (object: string, hsId: string) => { local_id: string; extra: string | null } | undefined; set: (object: string, hsId: string, localId: string, extra?: string | null) => void; count: (object: string) => number };

export function idMap(app: App, locationId: string): IdMap {
  return {
    get: (object, hsId) => app.db.get('SELECT local_id, extra FROM hubspot_ids WHERE location_id = ? AND object = ? AND hubspot_id = ?', locationId, object, String(hsId)) as any,
    set: (object, hsId, localId, extra = null) =>
      void app.db.run(
        `INSERT INTO hubspot_ids (location_id, object, hubspot_id, local_id, extra, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(location_id, object, hubspot_id) DO UPDATE SET local_id = excluded.local_id, extra = excluded.extra, updated_at = excluded.updated_at`,
        locationId,
        object,
        String(hsId),
        localId,
        extra,
        now(),
      ),
    count: (object) => Number(app.db.get('SELECT COUNT(*) n FROM hubspot_ids WHERE location_id = ? AND object = ?', locationId, object)?.n ?? 0),
  };
}

/** Optional companies module (parallel feature): upsert a company and link contacts. */
function companiesAdapter(app: App) {
  const c = app.services.companies;
  const a = app.services.associations;
  if (typeof c?.upsert !== 'function') return null;
  return {
    upsert: async (loc: string, input: Record<string, any>): Promise<string | undefined> => {
      const r = await c.upsert(loc, input);
      return typeof r === 'string' ? r : r?.id;
    },
    link: async (loc: string, companyId: string, contactId: string) => {
      if (typeof c.linkContact === 'function') await c.linkContact(loc, companyId, contactId);
      else if (typeof a?.link === 'function') await a.link(loc, { type: 'company', id: companyId }, { type: 'contact', id: contactId });
    },
  };
}

const firstAssoc = (o: any, kind: string): string[] => (o?.associations?.[kind]?.results ?? []).map((x: any) => String(x.id ?? x.toObjectId));

/** One object type, page by page from the saved cursor; `each` runs per record inside a transaction. */
async function paged(client: HubSpotClient, path: string, query: Record<string, unknown>, p: HubSpotProgress, hooks: RunHooks, each: (o: any) => void | Promise<void>) {
  let after = p.cursor ?? undefined;
  for (let page = 0; page < 100_000; page++) {
    if (hooks.cancelled()) throw new Cancelled('Pausiert');
    const j = await client.req('GET', path, { query: { limit: 100, archived: false, ...query, after } });
    const list: any[] = j.results ?? [];
    for (const o of list) await each(o);
    p.processed += list.length;
    after = j.paging?.next?.after;
    p.cursor = after ?? null;
    hooks.save(p);
    if (!after || !list.length) break;
  }
}

export async function runHubSpotImport(app: App, locationId: string, client: HubSpotClient, parts: HubSpotPart[], p: HubSpotProgress, hooks: RunHooks) {
  const db = app.db;
  const ids = idMap(app, locationId);
  const count = (k: string, n = 1) => (p.counts[k] = (p.counts[k] ?? 0) + n);
  const skip = (k: string, n = 1) => (p.skipped[k] = (p.skipped[k] ?? 0) + n);
  const note = (s: string) => {
    if (!p.notes.includes(s)) p.notes.push(s);
    hooks.log(s);
  };
  const companies = companiesAdapter(app);
  const userOf = (ownerId: unknown) => (ownerId ? ids.get('owner', String(ownerId))?.local_id || null : null);
  const contactOf = (hsIds: string[]) => {
    for (const h of hsIds) {
      const m = ids.get('contact', h);
      if (m && getContact(app, locationId, m.local_id)) return m.local_id;
    }
    return undefined;
  };

  const steps = stepsFor(parts);
  for (const step of steps) {
    if (p.done_steps.includes(step)) continue;
    if (p.step !== step) {
      p.step = step;
      p.cursor = null;
      p.processed = 0;
    }
    hooks.save(p);
    try {
      await runStep(step);
    } catch (e) {
      if (e instanceof Cancelled) throw e;
      if (e instanceof HubSpotError && (e.status === 403 || e.status === 404)) {
        note(`${step}: übersprungen – ${e.message}`);
      } else throw e;
    }
    p.done_steps.push(step);
    p.cursor = null;
    hooks.save(p);
  }
  p.step = 'fertig';
  hooks.save(p);
  return p;

  async function runStep(step: string) {
    switch (step) {
      case 'owners': {
        const users = new Map(db.all('SELECT id, email FROM users').map((u) => [String(u.email).toLowerCase(), String(u.id)]));
        await paged(client, '/crm/v3/owners', {}, p, hooks, (o) => {
          const uid = o.email ? users.get(String(o.email).toLowerCase()) : undefined;
          if (uid) {
            ids.set('owner', o.id, uid, o.email);
            count('owners');
          } else {
            skip('owners');
            note(`Owner ohne passenden Nutzer: ${[o.firstName, o.lastName].filter(Boolean).join(' ') || o.email || o.id}`);
          }
        });
        hooks.log(`Owner: ${p.counts.owners ?? 0} zugeordnet, ${p.skipped.owners ?? 0} ohne Nutzer`);
        return;
      }
      case 'properties': {
        const j = await client.req('GET', '/crm/v3/properties/contacts');
        let n = 0;
        db.tx(() => {
          for (const prop of j.results ?? []) {
            const extra = EXTRA_CUSTOM[prop.name];
            const custom = !prop.hubspotDefined && !prop.calculated && !prop.hidden;
            if (!custom && !extra) continue;
            const key = fieldKey(prop.name);
            const options = (prop.options ?? []).filter((o: any) => !o.hidden).map((o: any) => String(o.label));
            db.run(
              `INSERT INTO custom_fields (id, location_id, key, label, type, options, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(location_id, key) DO NOTHING`,
              id(),
              locationId,
              key,
              extra ?? String(prop.label || prop.name),
              mapPropertyType(prop),
              JSON.stringify(options),
              Number(prop.displayOrder) > 0 ? Number(prop.displayOrder) : 100,
              now(),
            );
            ids.set('property', prop.name, key, JSON.stringify({ type: prop.type, options: prop.options ?? [] }));
            n++;
          }
        });
        count('custom_fields', n);
        hooks.log(`Eigenschaften → eigene Felder: ${n}`);
        return;
      }
      case 'companies': {
        await paged(client, '/crm/v3/objects/companies', { properties: 'name,domain,website,phone,address,city,zip,country,industry' }, p, hooks, async (o) => {
          const pr = o.properties ?? {};
          const name = String(pr.name || pr.domain || `Firma ${o.id}`);
          let local = '';
          if (companies) {
            local =
              (await companies.upsert(locationId, {
                name,
                domain: pr.domain ?? '',
                website: pr.website || (pr.domain ? `https://${pr.domain}` : ''),
                phone: pr.phone ?? '',
                address: pr.address ?? '',
                city: pr.city ?? '',
                postal_code: pr.zip ?? '',
                country: pr.country ?? '',
                industry: pr.industry ?? '',
                external_source: 'hubspot',
                external_id: String(o.id),
                existing_id: ids.get('company', o.id)?.local_id || undefined,
              })) ?? '';
          }
          ids.set('company', o.id, local, name);
          count('companies');
        });
        if (!companies) note('Firmen: kein Firmen-Modul – der Firmenname wird beim Kontakt (Feld „Firma“) eingetragen');
        hooks.log(`Firmen: ${p.counts.companies ?? 0}`);
        return;
      }
      case 'contacts': {
        const props = db.all('SELECT hubspot_id, local_id, extra FROM hubspot_ids WHERE location_id = ? AND object = ?', locationId, 'property').map((r) => ({ name: String(r.hubspot_id), key: String(r.local_id), meta: r.extra ? JSON.parse(r.extra) : {} }));
        const wanted = [...new Set([...Object.keys(STANDARD_CONTACT), 'mobilephone', 'hubspot_owner_id', 'createdate', ...props.map((x) => x.name)])].slice(0, 250);
        const customByName = new Map(props.map((x) => [x.name, x]));
        await paged(client, '/crm/v3/objects/contacts', { properties: wanted.join(','), associations: 'companies' }, p, hooks, async (o) => {
          const pr = o.properties ?? {};
          const input: Record<string, any> = { source: 'HubSpot', tags: [] };
          for (const [hs, ours] of Object.entries(STANDARD_CONTACT)) if (pr[hs]) input[ours] = ours === 'date_of_birth' ? toDay(pr[hs]) : String(pr[hs]);
          if (!input.phone && pr.mobilephone) input.phone = String(pr.mobilephone);
          const owner = userOf(pr.hubspot_owner_id);
          if (owner) input.assigned_to = owner;
          const custom: Record<string, any> = {};
          for (const [name, c] of customByName) {
            const v = propValue(c.meta, pr[name]);
            if (v !== '') custom[c.key] = v;
          }
          if (Object.keys(custom).length) input.custom = custom;
          if (pr.createdate) input.created_at = toIso(pr.createdate);
          const compIds = firstAssoc(o, 'companies');
          if (!input.company && compIds.length) {
            const name = ids.get('company', compIds[0])?.extra;
            if (name) input.company = name;
          }
          const existing = ids.get('contact', o.id)?.local_id;
          const { contact } = db.tx(() => upsertContact(app, locationId, { ...input, id: existing }, { source: 'HubSpot-Import', quiet: true }));
          ids.set('contact', o.id, contact.id);
          if (companies) {
            for (const cid of compIds) {
              const local = ids.get('company', cid)?.local_id;
              if (local) await companies.link(locationId, local, contact.id).catch(() => undefined);
            }
          }
          count('contacts');
        });
        hooks.log(`Kontakte: ${p.counts.contacts ?? 0}`);
        return;
      }
      case 'lists': {
        let offset = 0;
        let lists: any[] = [];
        for (let page = 0; page < 1000; page++) {
          const j = await client.req('POST', '/crm/v3/lists/search', { body: { count: 100, offset, query: '' } });
          lists = lists.concat((j.lists ?? []).filter((l: any) => !l.objectTypeId || l.objectTypeId === '0-1'));
          if (!j.hasMore) break;
          offset = Number(j.offset) || offset + 100;
        }
        for (const l of lists) {
          if (hooks.cancelled()) throw new Cancelled('Pausiert');
          const tag = String(l.name ?? `Liste ${l.listId}`).trim().slice(0, 80);
          let after: string | undefined;
          let members = 0;
          for (let page = 0; page < 100_000; page++) {
            const j = await client.req('GET', `/crm/v3/lists/${l.listId}/memberships`, { query: { limit: 250, after } });
            db.tx(() => {
              for (const m of j.results ?? []) {
                const local = ids.get('contact', String(m.recordId ?? m))?.local_id;
                if (!local || !getContact(app, locationId, local)) continue;
                upsertContact(app, locationId, { id: local, tags: [tag] }, { quiet: true });
                members++;
              }
            });
            after = j.paging?.next?.after;
            if (!after) break;
          }
          ids.set('list', l.listId, tag, String(members));
          count('lists');
          count('list_members', members);
        }
        hooks.log(`Listen → Tags: ${p.counts.lists ?? 0} (${p.counts.list_members ?? 0} Zuordnungen)`);
        return;
      }
      case 'pipelines': {
        const j = await client.req('GET', '/crm/v3/pipelines/deals');
        db.tx(() => {
          for (const pl of j.results ?? []) {
            const stages = [...(pl.stages ?? [])].sort((a: any, b: any) => Number(a.displayOrder) - Number(b.displayOrder));
            const mapped = stages.map((s: any) => ({ id: stageKey(s.id), name: String(s.label ?? s.id) }));
            const existing = ids.get('pipeline', pl.id);
            const row = existing && parseJson(db.get('SELECT * FROM pipelines WHERE id = ? AND location_id = ?', existing.local_id, locationId), ['stages']);
            let pid: string;
            if (row) {
              const keep = (row.stages ?? []).filter((s: any) => !String(s.id).startsWith('hs_'));
              db.run('UPDATE pipelines SET name = ?, stages = ? WHERE id = ?', String(pl.label ?? 'HubSpot'), JSON.stringify([...mapped, ...keep]), row.id);
              pid = row.id;
            } else {
              pid = id();
              db.insert('pipelines', { id: pid, location_id: locationId, name: String(pl.label ?? 'HubSpot'), stages: mapped, created_at: now() });
            }
            ids.set('pipeline', pl.id, pid, JSON.stringify(stages.map((s: any) => ({ id: s.id, metadata: s.metadata ?? {} }))));
            count('pipelines');
          }
        });
        hooks.log(`Pipelines: ${p.counts.pipelines ?? 0}`);
        return;
      }
      case 'deals': {
        const pipes = new Map(
          db.all('SELECT hubspot_id, local_id, extra FROM hubspot_ids WHERE location_id = ? AND object = ?', locationId, 'pipeline').map((r) => [String(r.hubspot_id), { id: String(r.local_id), stages: JSON.parse(r.extra ?? '[]') as any[] }]),
        );
        await paged(client, '/crm/v3/objects/deals', { properties: 'dealname,amount,dealstage,pipeline,closedate,createdate,hubspot_owner_id,hs_is_closed_won,hs_is_closed', associations: 'contacts,companies' }, p, hooks, (o) => {
          const pr = o.properties ?? {};
          const pl = pipes.get(String(pr.pipeline ?? 'default')) ?? [...pipes.values()][0];
          if (!pl) return void skip('deals_no_pipeline');
          const contactId = contactOf(firstAssoc(o, 'contacts'));
          if (!contactId) return void skip('deals_no_contact');
          const stage = pl.stages.find((s) => s.id === pr.dealstage);
          const row = {
            pipeline_id: pl.id,
            stage_id: stage ? stageKey(stage.id) : stageKey(pl.stages[0]?.id ?? 'start'),
            contact_id: contactId,
            name: String(pr.dealname || 'Deal'),
            value: Math.round(Number(pr.amount) || 0),
            status: dealStatus(pr, stage),
            assigned_to: userOf(pr.hubspot_owner_id),
            source: 'HubSpot',
            updated_at: now(),
          };
          const existing = ids.get('deal', o.id)?.local_id;
          const there = existing && db.get('SELECT id, stage_id FROM opportunities WHERE id = ? AND location_id = ?', existing, locationId);
          if (there) db.update('opportunities', there.id, { ...row, ...(there.stage_id !== row.stage_id ? { stage_changed_at: now() } : {}) });
          else {
            const oid = id();
            db.insert('opportunities', { id: oid, location_id: locationId, created_at: toIso(pr.createdate) ?? now(), stage_changed_at: now(), ...row });
            ids.set('deal', o.id, oid);
          }
          count('deals');
        });
        hooks.log(`Deals: ${p.counts.deals ?? 0}${p.skipped.deals_no_contact ? ` (${p.skipped.deals_no_contact} ohne Kontakt übersprungen)` : ''}`);
        return;
      }
      case 'notes': {
        await paged(client, '/crm/v3/objects/notes', { properties: 'hs_note_body,hs_timestamp,hubspot_owner_id', associations: 'contacts,deals' }, p, hooks, (o) => {
          const pr = o.properties ?? {};
          let contactId = contactOf(firstAssoc(o, 'contacts'));
          if (!contactId) {
            const deal = firstAssoc(o, 'deals').map((d) => ids.get('deal', d)?.local_id).find(Boolean);
            contactId = deal ? db.get('SELECT contact_id FROM opportunities WHERE id = ?', deal)?.contact_id : undefined;
          }
          if (!contactId) return void skip('notes_no_contact');
          const body = stripHtml(pr.hs_note_body).slice(0, 20_000) || '(leer)';
          const existing = ids.get('note', o.id)?.local_id;
          if (existing && db.get('SELECT id FROM notes WHERE id = ?', existing)) db.run('UPDATE notes SET body = ?, contact_id = ? WHERE id = ?', body, contactId, existing);
          else {
            const nid = id();
            db.insert('notes', { id: nid, location_id: locationId, contact_id: contactId, body, user_id: userOf(pr.hubspot_owner_id), created_at: toIso(pr.hs_timestamp) ?? now() });
            ids.set('note', o.id, nid);
          }
          count('notes');
        });
        hooks.log(`Notizen: ${p.counts.notes ?? 0}`);
        return;
      }
      case 'tasks': {
        await paged(client, '/crm/v3/objects/tasks', { properties: 'hs_task_subject,hs_task_body,hs_task_status,hs_timestamp,hubspot_owner_id,hs_task_completion_date', associations: 'contacts' }, p, hooks, (o) => {
          const pr = o.properties ?? {};
          const done = String(pr.hs_task_status ?? '').toUpperCase() === 'COMPLETED';
          const row = {
            contact_id: contactOf(firstAssoc(o, 'contacts')) ?? null,
            title: String(pr.hs_task_subject || 'Aufgabe').slice(0, 300),
            description: stripHtml(pr.hs_task_body).slice(0, 5000),
            due_at: toIso(pr.hs_timestamp) ?? null,
            done: done ? 1 : 0,
            completed_at: done ? (toIso(pr.hs_task_completion_date) ?? toIso(pr.hs_timestamp) ?? now()) : null,
            assigned_to: userOf(pr.hubspot_owner_id),
          };
          const existing = ids.get('task', o.id)?.local_id;
          if (existing && db.get('SELECT id FROM tasks WHERE id = ?', existing)) db.update('tasks', existing, row);
          else {
            const tid = id();
            db.insert('tasks', { id: tid, location_id: locationId, created_at: now(), ...row });
            ids.set('task', o.id, tid);
          }
          count('tasks');
        });
        hooks.log(`Aufgaben: ${p.counts.tasks ?? 0}`);
        return;
      }
      case 'calls':
      case 'emails':
      case 'meetings': {
        const cfg = {
          calls: { props: 'hs_call_title,hs_call_body,hs_call_direction,hs_call_duration,hs_call_status,hs_timestamp', label: 'Anruf', title: 'hs_call_title', body: 'hs_call_body' },
          emails: { props: 'hs_email_subject,hs_email_text,hs_email_direction,hs_timestamp', label: 'E-Mail', title: 'hs_email_subject', body: 'hs_email_text' },
          meetings: { props: 'hs_meeting_title,hs_meeting_body,hs_meeting_start_time,hs_meeting_end_time,hs_timestamp', label: 'Meeting', title: 'hs_meeting_title', body: 'hs_meeting_body' },
        }[step]!;
        const type = `hubspot.${step.slice(0, -1)}`;
        await paged(client, `/crm/v3/objects/${step}`, { properties: cfg.props, associations: 'contacts' }, p, hooks, (o) => {
          const pr = o.properties ?? {};
          const contactId = contactOf(firstAssoc(o, 'contacts'));
          if (!contactId) return void skip(`${step}_no_contact`);
          const title = String(pr[cfg.title] ?? '').trim();
          const dir = pr.hs_call_direction ?? pr.hs_email_direction;
          const summary = `${cfg.label} (HubSpot)${title ? `: ${title}` : ''}`.slice(0, 300);
          const data = { hubspot_id: String(o.id), body: stripHtml(pr[cfg.body]).slice(0, 4000), direction: dir ?? null, duration_ms: pr.hs_call_duration ? Number(pr.hs_call_duration) : null, status: pr.hs_call_status ?? null };
          const at = toIso(pr.hs_timestamp ?? pr.hs_meeting_start_time) ?? now();
          const existing = ids.get(step, o.id)?.local_id;
          if (existing && db.get('SELECT id FROM activities WHERE id = ?', existing)) db.run('UPDATE activities SET summary = ?, data = ?, contact_id = ?, created_at = ? WHERE id = ?', summary, JSON.stringify(data), contactId, at, existing);
          else {
            const aid = id();
            db.insert('activities', { id: aid, location_id: locationId, contact_id: contactId, type, summary, data, created_at: at });
            ids.set(step, o.id, aid);
          }
          count(step);
        });
        hooks.log(`${cfg.label}s: ${p.counts[step] ?? 0}`);
        return;
      }
      case 'tickets': {
        const importer = app.services.ticketsImport;
        if (typeof importer !== 'function') {
          note('Tickets übersprungen – kein Helpdesk-Modul installiert (app.services.ticketsImport fehlt)');
          return;
        }
        const tp = await client.req('GET', '/crm/v3/pipelines/tickets').catch(() => ({ results: [] }));
        const labels = new Map<string, { pipeline: string; stages: Map<string, string> }>((tp.results ?? []).map((pl: any) => [String(pl.id), { pipeline: String(pl.label ?? ''), stages: new Map((pl.stages ?? []).map((s: any) => [String(s.id), String(s.label ?? s.id)])) }]));
        await paged(client, '/crm/v3/objects/tickets', { properties: 'subject,content,hs_pipeline,hs_pipeline_stage,hs_ticket_priority,createdate,hubspot_owner_id', associations: 'contacts' }, p, hooks, async (o) => {
          const pr = o.properties ?? {};
          const pl = labels.get(String(pr.hs_pipeline ?? ''));
          const r = await importer(locationId, {
            external_source: 'hubspot',
            external_id: String(o.id),
            existing_id: ids.get('ticket', o.id)?.local_id || undefined,
            subject: String(pr.subject || 'Ticket'),
            content: stripHtml(pr.content),
            pipeline: pl?.pipeline ?? '',
            stage: pl?.stages.get(String(pr.hs_pipeline_stage ?? '')) ?? String(pr.hs_pipeline_stage ?? ''),
            priority: String(pr.hs_ticket_priority ?? '').toLowerCase(),
            contact_id: contactOf(firstAssoc(o, 'contacts')) ?? null,
            assigned_to: userOf(pr.hubspot_owner_id),
            created_at: toIso(pr.createdate) ?? now(),
          });
          const local = typeof r === 'string' ? r : r?.id;
          if (local) ids.set('ticket', o.id, String(local));
          count('tickets');
        });
        hooks.log(`Tickets: ${p.counts.tickets ?? 0}`);
        return;
      }
    }
  }
}

/** Dry run: how many records each part has in HubSpot and how many are already here. */
export async function hubspotDryRun(app: App, locationId: string, client: HubSpotClient, parts: HubSpotPart[]) {
  const ids = idMap(app, locationId);
  const total = async (object: string) => {
    const j = await client.req('POST', `/crm/v3/objects/${object}/search`, { body: { limit: 1, properties: ['hs_object_id'] } });
    return Number(j.total ?? 0);
  };
  const rows: { part: HubSpotPart; object: string; label: string; hubspot: number | null; imported: number; error?: string }[] = [];
  const add = async (part: HubSpotPart, object: string, label: string, fn: () => Promise<number>, mapped = object.replace(/s$/, '')) => {
    try {
      rows.push({ part, object, label, hubspot: await fn(), imported: ids.count(mapped) });
    } catch (e) {
      rows.push({ part, object, label, hubspot: null, imported: ids.count(mapped), error: (e as Error).message });
      if (e instanceof HubSpotError && e.status === 401) throw e;
    }
  };
  if (parts.includes('owners'))
    await add('owners', 'owners', 'Owner', async () => {
      let n = 0;
      let after: string | undefined;
      for (let i = 0; i < 100; i++) {
        const j = await client.req('GET', '/crm/v3/owners', { query: { limit: 100, after } });
        n += (j.results ?? []).length;
        after = j.paging?.next?.after;
        if (!after) break;
      }
      return n;
    });
  if (parts.includes('companies')) await add('companies', 'companies', 'Firmen', () => total('companies'), 'company');
  if (parts.includes('contacts')) await add('contacts', 'contacts', 'Kontakte', () => total('contacts'));
  if (parts.includes('lists'))
    await add('lists', 'lists', 'Listen', async () => {
      const j = await client.req('POST', '/crm/v3/lists/search', { body: { count: 1, offset: 0, query: '' } });
      return Number(j.total ?? (j.lists ?? []).length);
    });
  if (parts.includes('deals')) {
    await add('deals', 'pipelines', 'Deal-Pipelines', async () => ((await client.req('GET', '/crm/v3/pipelines/deals')).results ?? []).length, 'pipeline');
    await add('deals', 'deals', 'Deals', () => total('deals'));
  }
  if (parts.includes('notes')) await add('notes', 'notes', 'Notizen', () => total('notes'));
  if (parts.includes('tasks')) await add('tasks', 'tasks', 'Aufgaben', () => total('tasks'));
  if (parts.includes('engagements')) {
    await add('engagements', 'calls', 'Anrufe', () => total('calls'), 'calls');
    await add('engagements', 'emails', 'E-Mails', () => total('emails'), 'emails');
    await add('engagements', 'meetings', 'Meetings', () => total('meetings'), 'meetings');
  }
  if (parts.includes('tickets')) await add('tickets', 'tickets', typeof app.services.ticketsImport === 'function' ? 'Tickets' : 'Tickets (werden übersprungen – kein Helpdesk-Modul)', () => total('tickets'));
  return rows.map((r) => ({ ...r, new: r.hubspot === null ? null : Math.max(0, r.hubspot - r.imported) }));
}
