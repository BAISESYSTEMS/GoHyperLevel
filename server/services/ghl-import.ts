import type { App } from '../core/app.js';
import { id, now, slugify, token as randomToken } from '../core/util.js';
import { ensureTags, upsertContact } from './contacts.js';

/**
 * Pulls a GoHighLevel sub-account into this app: custom fields, tags, contacts, pipelines,
 * opportunities, calendars and appointments. Idempotent (re-running updates by external id).
 * The token is only held in memory for the run.
 */

const BASE = 'https://services.leadconnectorhq.com';
export const IMPORT_PARTS = ['custom_fields', 'tags', 'contacts', 'pipelines', 'opportunities', 'calendars', 'appointments'] as const;
export type ImportPart = (typeof IMPORT_PARTS)[number];

export class GhlClient {
  constructor(
    private token: string,
    private fetchImpl: typeof fetch = fetch,
    private pauseMs = 120,
  ) {}

  async req(path: string, init: { method?: string; body?: any; query?: Record<string, any> } = {}): Promise<any> {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await this.fetchImpl(url, {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${this.token}`,
          version: '2021-07-28',
          accept: 'application/json',
          ...(init.body ? { 'content-type': 'application/json' } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      if (r.status === 429) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok) throw new GhlError(r.status, j.message ? (Array.isArray(j.message) ? j.message.join(', ') : j.message) : `HTTP ${r.status}`, path);
      if (this.pauseMs) await sleep(this.pauseMs);
      return j;
    }
    throw new GhlError(429, 'Rate-Limit', path);
  }
}

export class GhlError extends Error {
  constructor(
    public status: number,
    message: string,
    public path: string,
  ) {
    super(`${message} (${path})`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the token can see: its locations and which data scopes work. */
export async function probeGhl(client: GhlClient, ghlLocationId?: string) {
  const out: { locations: { id: string; name: string; companyId?: string }[]; scopes: Record<string, boolean | string> } = { locations: [], scopes: {} };
  try {
    const j = await client.req('/locations/search', { query: { limit: 100 } });
    out.locations = (j.locations ?? []).map((l: any) => ({ id: l.id, name: l.name, companyId: l.companyId }));
  } catch (e) {
    out.scopes['locations'] = (e as Error).message;
  }
  const loc = ghlLocationId || out.locations[0]?.id;
  if (!loc) return out;
  if (!out.locations.length) {
    try {
      const j = await client.req(`/locations/${loc}`);
      out.locations = [{ id: j.location?.id ?? loc, name: j.location?.name ?? loc, companyId: j.location?.companyId }];
    } catch {
      /* sub-account token without locations.readonly */
    }
  }
  const checks: [string, string, Record<string, any>?][] = [
    ['contacts', '/contacts/', { locationId: loc, limit: 1 }],
    ['custom_fields', `/locations/${loc}/customFields`],
    ['tags', `/locations/${loc}/tags`],
    ['pipelines', '/opportunities/pipelines', { locationId: loc }],
    ['opportunities', '/opportunities/search', { location_id: loc, limit: 1 }],
    ['calendars', '/calendars/', { locationId: loc }],
  ];
  for (const [name, path, query] of checks) {
    try {
      await client.req(path, { query });
      out.scopes[name] = true;
    } catch (e) {
      out.scopes[name] = (e as Error).message;
    }
  }
  return out;
}

/** An agency token can mint a sub-account token (needs the oauth.write scope). */
export async function locationTokenFromAgency(client: GhlClient, companyId: string, locationId: string): Promise<string | undefined> {
  try {
    const j = await client.req('/oauth/locationToken', { method: 'POST', body: { companyId, locationId } });
    return j.access_token;
  } catch {
    return undefined;
  }
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const pad = (n: number) => String(n ?? 0).padStart(2, '0');

function mapFieldType(t: string): string {
  switch (t) {
    case 'LARGE_TEXT':
      return 'textarea';
    case 'NUMERICAL':
    case 'MONETORY':
      return 'number';
    case 'DATE':
      return 'date';
    case 'SINGLE_OPTIONS':
    case 'RADIO':
      return 'select';
    case 'CHECKBOX':
    case 'MULTIPLE_OPTIONS':
      return 'checkbox';
    case 'PHONE':
      return 'phone';
    default:
      return 'text';
  }
}

export interface ImportProgress {
  part: string;
  done: number;
  total?: number;
  log: string[];
  counts: Record<string, number>;
}

export async function importFromGhl(
  app: App,
  locationId: string,
  client: GhlClient,
  ghlLocationId: string,
  parts: ImportPart[],
  progress: ImportProgress = { part: '', done: 0, log: [], counts: {} },
) {
  const db = app.db;
  const say = (s: string) => progress.log.push(`${new Date().toLocaleTimeString('de-DE')} ${s}`);
  const count = (k: string, n = 1) => (progress.counts[k] = (progress.counts[k] ?? 0) + n);
  const fieldKeyById = new Map<string, string>();
  const want = (p: ImportPart) => parts.includes(p);

  // Custom fields first: contacts reference them by id.
  if (want('custom_fields') || want('contacts')) {
    progress.part = 'custom_fields';
    try {
      const j = await client.req(`/locations/${ghlLocationId}/customFields`);
      for (const f of j.customFields ?? []) {
        const key = String(f.fieldKey ?? f.name).replace(/^contact\./, '').replace(/[^a-z0-9_]/gi, '_').toLowerCase() || slugify(f.name).replace(/-/g, '_');
        fieldKeyById.set(f.id, key);
        if (!want('custom_fields')) continue;
        db.run(
          `INSERT INTO custom_fields (id, location_id, key, label, type, options, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(location_id, key) DO UPDATE SET label = excluded.label, type = excluded.type, options = excluded.options`,
          id(),
          locationId,
          key,
          f.name ?? key,
          mapFieldType(f.dataType),
          JSON.stringify(f.picklistOptions ?? []),
          Number(f.position) || 0,
          now(),
        );
        count('custom_fields');
      }
      say(`Eigene Felder: ${progress.counts.custom_fields ?? 0}`);
    } catch (e) {
      say(`Eigene Felder übersprungen: ${(e as Error).message}`);
    }
  }

  if (want('tags')) {
    progress.part = 'tags';
    try {
      const j = await client.req(`/locations/${ghlLocationId}/tags`);
      const names = (j.tags ?? []).map((t: any) => String(t.name)).filter(Boolean);
      ensureTags(app, locationId, names);
      count('tags', names.length);
      say(`Tags: ${names.length}`);
    } catch (e) {
      say(`Tags übersprungen: ${(e as Error).message}`);
    }
  }

  const contactIdByGhl = new Map<string, string>();
  for (const r of db.all('SELECT id, external_id FROM contacts WHERE location_id = ? AND external_id IS NOT NULL', locationId)) contactIdByGhl.set(r.external_id, r.id);

  const importContact = (c: any) => {
    const custom: Record<string, any> = {};
    for (const cf of c.customFields ?? c.customField ?? []) {
      const key = fieldKeyById.get(cf.id);
      if (key && cf.value !== undefined && cf.value !== null && cf.value !== '') custom[key] = Array.isArray(cf.value) ? cf.value.join(', ') : cf.value;
    }
    const existing = contactIdByGhl.get(c.id);
    const { contact } = upsertContact(
      app,
      locationId,
      {
        id: existing,
        first_name: c.firstName ?? '',
        last_name: c.lastName ?? '',
        email: c.email ?? '',
        phone: c.phone ?? '',
        company: c.companyName ?? '',
        address: c.address1 ?? '',
        city: c.city ?? '',
        postal_code: c.postalCode ?? '',
        country: c.country ?? '',
        website: c.website ?? '',
        source: c.source ?? 'GHL',
        date_of_birth: c.dateOfBirth ?? undefined,
        tags: c.tags ?? [],
        custom,
        dnd: !!c.dnd,
        created_at: c.dateAdded,
      },
      { source: 'GHL-Import', quiet: true },
    );
    db.run('UPDATE contacts SET external_id = ? WHERE id = ?', c.id, contact.id);
    contactIdByGhl.set(c.id, contact.id);
    count('contacts');
    return contact.id;
  };

  if (want('contacts')) {
    progress.part = 'contacts';
    progress.done = 0;
    try {
      let startAfterId: string | undefined;
      let startAfter: string | number | undefined;
      for (let page = 0; page < 10_000; page++) {
        const j = await client.req('/contacts/', { query: { locationId: ghlLocationId, limit: 100, startAfterId, startAfter } });
        const list = j.contacts ?? [];
        progress.total = j.meta?.total ?? progress.total;
        db.tx(() => list.forEach(importContact));
        progress.done += list.length;
        if (!list.length || !j.meta?.startAfterId || list.length < 100) break;
        startAfterId = j.meta.startAfterId;
        startAfter = j.meta.startAfter;
      }
      say(`Kontakte: ${progress.counts.contacts ?? 0}`);
    } catch (e) {
      say(`Kontakte abgebrochen: ${(e as Error).message}`);
    }
  }

  const pipelineByGhl = new Map<string, { id: string; stages: Map<string, string> }>();
  if (want('pipelines') || want('opportunities')) {
    progress.part = 'pipelines';
    try {
      const j = await client.req('/opportunities/pipelines', { query: { locationId: ghlLocationId } });
      for (const p of j.pipelines ?? []) {
        const stages = (p.stages ?? []).map((s: any) => ({ id: `g${String(s.id).slice(0, 20)}`, name: s.name }));
        const existing = db.get('SELECT id FROM pipelines WHERE location_id = ? AND external_id = ?', locationId, p.id);
        const pid = existing?.id ?? id();
        if (existing) db.run('UPDATE pipelines SET name = ?, stages = ? WHERE id = ?', p.name, JSON.stringify(stages), pid);
        else db.insert('pipelines', { id: pid, location_id: locationId, name: p.name, stages, external_id: p.id, created_at: now() });
        pipelineByGhl.set(p.id, { id: pid, stages: new Map((p.stages ?? []).map((s: any) => [s.id, `g${String(s.id).slice(0, 20)}`])) });
        count('pipelines');
      }
      say(`Pipelines: ${progress.counts.pipelines ?? 0}`);
    } catch (e) {
      say(`Pipelines übersprungen: ${(e as Error).message}`);
    }
  }

  if (want('opportunities')) {
    progress.part = 'opportunities';
    progress.done = 0;
    try {
      let startAfterId: string | undefined;
      let startAfter: string | number | undefined;
      for (let page = 0; page < 10_000; page++) {
        const j = await client.req('/opportunities/search', { query: { location_id: ghlLocationId, limit: 100, startAfterId, startAfter } });
        const list = j.opportunities ?? [];
        progress.total = j.meta?.total ?? progress.total;
        db.tx(() => {
          for (const o of list) {
            const p = pipelineByGhl.get(o.pipelineId);
            if (!p) continue;
            const ghlContactId = o.contactId ?? o.contact?.id;
            let contactId = contactIdByGhl.get(ghlContactId);
            if (!contactId && o.contact) contactId = importContact({ id: ghlContactId, firstName: o.contact.name, email: o.contact.email, phone: o.contact.phone, tags: o.contact.tags });
            if (!contactId) continue;
            const status = ['open', 'won', 'lost', 'abandoned'].includes(o.status) ? o.status : 'open';
            const row = { pipeline_id: p.id, stage_id: p.stages.get(o.pipelineStageId) ?? [...p.stages.values()][0], contact_id: contactId, name: o.name || 'Opportunity', value: Math.round(Number(o.monetaryValue) || 0), status, source: o.source ?? 'GHL', updated_at: now() };
            const existing = db.get('SELECT id FROM opportunities WHERE location_id = ? AND external_id = ?', locationId, o.id);
            if (existing) db.update('opportunities', existing.id, row);
            else db.insert('opportunities', { id: id(), location_id: locationId, external_id: o.id, created_at: o.createdAt ?? now(), stage_changed_at: now(), ...row });
            count('opportunities');
          }
        });
        progress.done += list.length;
        if (!list.length || !j.meta?.startAfterId || list.length < 100) break;
        startAfterId = j.meta.startAfterId;
        startAfter = j.meta.startAfter;
      }
      say(`Opportunities: ${progress.counts.opportunities ?? 0}`);
    } catch (e) {
      say(`Opportunities abgebrochen: ${(e as Error).message}`);
    }
  }

  const calendarByGhl = new Map<string, { id: string; duration: number }>();
  if (want('calendars') || want('appointments')) {
    progress.part = 'calendars';
    try {
      const j = await client.req('/calendars/', { query: { locationId: ghlLocationId } });
      const tz = app.location(locationId)!.timezone;
      for (const c of j.calendars ?? []) {
        const availability: Record<string, [string, string][]> = {};
        for (const oh of c.openHours ?? []) {
          for (const d of oh.daysOfTheWeek ?? []) {
            for (const h of oh.hours ?? []) (availability[DAY_KEYS[d]] ??= []).push([`${pad(h.openHour)}:${pad(h.openMinute)}`, `${pad(h.closeHour)}:${pad(h.closeMinute)}`]);
          }
        }
        const duration = Number(c.slotDuration) || 30;
        const existing = db.get('SELECT id FROM calendars WHERE location_id = ? AND external_id = ?', locationId, c.id);
        const row = { name: c.name, description: c.description ?? '', duration, interval: Number(c.slotInterval) || duration, buffer: Number(c.slotBuffer) || 0, availability: Object.keys(availability).length ? availability : undefined };
        let cid = existing?.id;
        if (cid) db.update('calendars', cid, row);
        else {
          cid = id();
          let slug = slugify(c.widgetSlug || c.name);
          for (let i = 2; db.get('SELECT id FROM calendars WHERE slug = ?', slug); i++) slug = `${slugify(c.name)}-${i}`;
          db.insert('calendars', {
            id: cid,
            location_id: locationId,
            slug,
            timezone: tz,
            settings: { confirmation_email: true, notify_team: true, reminder_hours: 24, ask_phone: true, ask_notes: true, tags: [] },
            external_id: c.id,
            created_at: now(),
            ...row,
            availability: row.availability ?? { mon: [['09:00', '17:00']], tue: [['09:00', '17:00']], wed: [['09:00', '17:00']], thu: [['09:00', '17:00']], fri: [['09:00', '15:00']] },
          });
        }
        calendarByGhl.set(c.id, { id: cid, duration });
        count('calendars');
      }
      say(`Kalender: ${progress.counts.calendars ?? 0}`);
    } catch (e) {
      say(`Kalender übersprungen: ${(e as Error).message}`);
    }
  }

  if (want('appointments')) {
    progress.part = 'appointments';
    const startTime = Date.now() - 365 * 864e5;
    const endTime = Date.now() + 365 * 864e5;
    for (const [ghlCal, cal] of calendarByGhl) {
      try {
        const j = await client.req('/calendars/events', { query: { locationId: ghlLocationId, calendarId: ghlCal, startTime, endTime } });
        db.tx(() => {
          for (const ev of j.events ?? []) {
            const status = ev.appointmentStatus === 'cancelled' ? 'cancelled' : ev.appointmentStatus === 'showed' ? 'showed' : ev.appointmentStatus === 'noshow' ? 'noshow' : 'confirmed';
            const row = { calendar_id: cal.id, contact_id: contactIdByGhl.get(ev.contactId) ?? null, title: ev.title || 'Termin', start_at: new Date(ev.startTime).toISOString(), end_at: new Date(ev.endTime).toISOString(), status };
            const existing = db.get('SELECT id FROM appointments WHERE location_id = ? AND external_id = ?', locationId, ev.id);
            if (existing) db.update('appointments', existing.id, row);
            else db.insert('appointments', { id: id(), location_id: locationId, external_id: ev.id, manage_token: randomToken(18), reminder_sent: 1, source: 'GHL-Import', notes: ev.notes ?? '', created_at: now(), ...row });
            count('appointments');
          }
        });
      } catch (e) {
        say(`Termine (${ghlCal}) übersprungen: ${(e as Error).message}`);
      }
    }
    say(`Termine: ${progress.counts.appointments ?? 0}`);
  }

  progress.part = 'fertig';
  return progress;
}
