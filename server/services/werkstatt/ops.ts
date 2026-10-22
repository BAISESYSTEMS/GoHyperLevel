import { bad } from '../../core/http.js';
import { addDaysYmd, ymdInTz } from '../../core/time.js';
import { CONTACT_FIELDS } from '../contacts.js';

/**
 * The only things a plugin can do: a fixed catalogue of operations. Each one names the scope the manifest
 * must contain and maps to one regular API route that runs *as the signed-in user* (same guards, member
 * areas, SaaS plan and audit log as a click in the app). There is no generic "call any route" – whatever
 * is not in this table is not reachable. The same table feeds the AI prompt, the docs and the self-test.
 */

type Args = Record<string, any>;
export interface OpCall {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
}
export interface OpDef {
  /** One line for the prompt and docs: signature → result. */
  doc: string;
  /** Scope the manifest must list (null = always allowed). */
  scope: string | null;
  write: boolean;
  /** route = an API route as the user; ai/storage = handled by the bridge itself. */
  kind: 'route' | 'ai' | 'storage';
  build?: (a: Args) => OpCall;
  /** Data for the demo/preview and the self-test (no real data is ever shown there). */
  sample: () => unknown;
  /** Rows this op creates, so uninstalling can remove them on request: `ref` identifies one, `remove` its DELETE route. */
  created?: { kind: string; label: string; ref: (result: any, args: Args) => string | undefined; remove: (ref: string) => string };
}

// --- argument helpers (every value is checked before it reaches a route) ---------------------------
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const OBJECT_KEY = /^p_[a-z0-9_]{1,60}$/;
const id = (a: Args, k = 'id'): string => {
  const v = String(a[k] ?? '');
  if (!ID.test(v)) throw bad(`„${k}“ fehlt oder ist ungültig.`);
  return v;
};
const optId = (a: Args, k: string): string | undefined => (a[k] === undefined || a[k] === null || a[k] === '' ? undefined : id(a, k));
const str = (a: Args, k: string, max = 500): string | undefined => (a[k] === undefined || a[k] === null ? undefined : String(a[k]).slice(0, max));
const reqStr = (a: Args, k: string, max = 500): string => {
  const v = str(a, k, max)?.trim();
  if (!v) throw bad(`„${k}“ fehlt.`);
  return v;
};
const int = (a: Args, k: string, min: number, max: number): number | undefined => {
  if (a[k] === undefined || a[k] === null || a[k] === '') return undefined;
  const n = Math.floor(Number(a[k]));
  if (!Number.isFinite(n)) throw bad(`„${k}“ muss eine Zahl sein.`);
  return Math.min(max, Math.max(min, n));
};
const oneOf = (a: Args, k: string, list: string[]): string | undefined => {
  if (a[k] === undefined || a[k] === null || a[k] === '') return undefined;
  const v = String(a[k]);
  if (!list.includes(v)) throw bad(`„${k}“ muss eines von ${list.join(', ')} sein.`);
  return v;
};
const iso = (a: Args, k: string): string | undefined => {
  const v = str(a, k, 40);
  if (v === undefined || v === '') return undefined;
  if (!/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v)) throw bad(`„${k}“ bitte als Datum 2025-01-31 oder 2025-01-31T09:00:00Z.`);
  return v;
};
const query = (p: Record<string, unknown>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : '';
};
const pick = (a: Args, keys: readonly string[], max = 500): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (a[k] !== undefined && a[k] !== null) out[k] = String(a[k]).slice(0, max);
  return out;
};
const customValues = (v: unknown): Record<string, unknown> | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw bad('„custom“ muss ein Objekt sein.');
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Args).slice(0, 50)) {
    if (!/^[a-z0-9_]{1,60}$/.test(k)) throw bad(`Eigenes Feld „${k}“: nur a-z, 0-9 und _.`);
    out[k] = typeof x === 'number' || typeof x === 'boolean' ? x : String(x ?? '').slice(0, 500);
  }
  return out;
};
const strList = (v: unknown, max = 20): string[] | undefined => (Array.isArray(v) ? v.slice(0, max).map((x) => String(x).slice(0, 80)) : undefined);

/**
 * The sample data's days are counted in the sub-account's time zone – the plugin's context says `today` in that zone, so a sample
 * birthday "today" must be today there too (between 00:00 and 02:00 in Berlin the UTC date is still yesterday). `sampleFor` sets it.
 */
let sampleTz = 'Europe/Berlin';
const today = (tz = sampleTz) => {
  try {
    return ymdInTz(new Date(), tz);
  } catch {
    return ymdInTz(new Date(), 'Europe/Berlin');
  }
};
const md = (offsetDays = 0) => addDaysYmd(today(), offsetDays);
const SAMPLE_CONTACTS = () => [
  { id: 'demo-c1', first_name: 'Anna', last_name: 'Beispiel', email: 'anna@example.com', phone: '+49 30 1234567', company: 'Muster GmbH', city: 'Berlin', date_of_birth: `1988-${md(0).slice(5)}`, tags: ['kunde'], custom: {}, created_at: `${md(-30)}T09:00:00.000Z` },
  { id: 'demo-c2', first_name: 'Ben', last_name: 'Beispiel', email: 'ben@example.com', phone: '', company: 'Beispiel AG', city: 'Hamburg', date_of_birth: `1979-${md(3).slice(5)}`, tags: ['lead'], custom: {}, created_at: `${md(-12)}T09:00:00.000Z` },
  { id: 'demo-c3', first_name: 'Clara', last_name: 'Muster', email: 'clara@example.com', phone: '', company: '', city: 'München', date_of_birth: null, tags: [], custom: {}, created_at: `${md(-2)}T09:00:00.000Z` },
];
const SAMPLE_DEALS = () => [
  { id: 'demo-o1', name: 'Website-Relaunch', value: 8400, status: 'open', stage_id: 's2', pipeline_id: 'demo-p1', contact_id: 'demo-c1', first_name: 'Anna', last_name: 'Beispiel', updated_at: `${md(-1)}T10:00:00.000Z`, stage_changed_at: `${md(-2)}T10:00:00.000Z` },
  { id: 'demo-o2', name: 'Wartungsvertrag', value: 2400, status: 'open', stage_id: 's1', pipeline_id: 'demo-p1', contact_id: 'demo-c2', first_name: 'Ben', last_name: 'Beispiel', updated_at: `${md(-12)}T10:00:00.000Z`, stage_changed_at: `${md(-12)}T10:00:00.000Z` },
  { id: 'demo-o3', name: 'Beratung Q4', value: 1200, status: 'won', stage_id: 's3', pipeline_id: 'demo-p1', contact_id: 'demo-c3', first_name: 'Clara', last_name: 'Muster', updated_at: `${md(-5)}T10:00:00.000Z`, stage_changed_at: `${md(-5)}T10:00:00.000Z` },
];

export const OPS: Record<string, OpDef> = {
  'contacts.list': {
    doc: 'contacts.list({q?, tag?, limit?(1-500), offset?, sort?}) → {total, contacts:[{id, first_name, last_name, email, phone, company, city, date_of_birth, tags, custom, created_at}]}',
    scope: 'contacts:read', write: false, kind: 'route',
    build: (a) => ({ method: 'GET', path: `/api/contacts${query({ q: str(a, 'q', 200), tag: str(a, 'tag', 80), limit: int(a, 'limit', 1, 500), offset: int(a, 'offset', 0, 1_000_000), sort: oneOf(a, 'sort', ['name', 'activity']) })}` }),
    sample: () => ({ total: 3, contacts: SAMPLE_CONTACTS() }),
  },
  'contacts.get': {
    doc: 'contacts.get({id}) → contact with notes, tasks and recent activity',
    scope: 'contacts:read', write: false, kind: 'route',
    build: (a) => ({ method: 'GET', path: `/api/contacts/${id(a)}` }),
    sample: () => ({ ...SAMPLE_CONTACTS()[0], notes: [{ id: 'demo-n1', body: 'Wünscht ein Angebot bis Freitag.', created_at: `${md(-3)}T09:00:00.000Z` }, { id: 'demo-n2', body: 'Telefonat: zufrieden mit dem Support, fragt nach Schulung.', created_at: `${md(-8)}T09:00:00.000Z` }], tasks: [], activities: [] }),
  },
  'contacts.create': {
    doc: 'contacts.create({first_name?, last_name?, email?, phone?, company?, city?, date_of_birth?, tags?, custom?}) → contact (same e-mail = updates that contact)',
    scope: 'contacts:write', write: true, kind: 'route',
    build: (a) => ({ method: 'POST', path: '/api/contacts', body: { ...pick(a, CONTACT_FIELDS.filter((f) => f !== 'assigned_to')), ...(strList(a.tags) ? { tags: strList(a.tags) } : {}), ...(customValues(a.custom) ? { custom: customValues(a.custom) } : {}) } }),
    sample: () => ({ ...SAMPLE_CONTACTS()[2], created: true }),
    created: { kind: 'Kontakt', label: 'Kontakte', ref: (r) => (r?.created === true && typeof r.id === 'string' ? r.id : undefined), remove: (ref) => `/api/contacts/${ref}` },
  },
  'contacts.update': {
    doc: 'contacts.update({id, first_name?, last_name?, email?, phone?, company?, city?, date_of_birth?, custom?}) → contact',
    scope: 'contacts:write', write: true, kind: 'route',
    build: (a) => ({ method: 'PATCH', path: `/api/contacts/${id(a)}`, body: { ...pick(a, CONTACT_FIELDS.filter((f) => f !== 'assigned_to')), ...(customValues(a.custom) ? { custom: customValues(a.custom) } : {}) } }),
    sample: () => SAMPLE_CONTACTS()[0],
  },
  'contacts.tag': {
    doc: 'contacts.tag({id, add?:[tag], remove?:[tag]}) → contact',
    scope: 'contacts:write', write: true, kind: 'route',
    build: (a) => ({ method: 'POST', path: `/api/contacts/${id(a)}/tags`, body: { add: strList(a.add) ?? [], remove: strList(a.remove) ?? [] } }),
    sample: () => SAMPLE_CONTACTS()[0],
  },
  'notes.add': {
    doc: 'notes.add({contact_id, body}) → note',
    scope: 'notes:write', write: true, kind: 'route',
    build: (a) => ({ method: 'POST', path: `/api/contacts/${id(a, 'contact_id')}/notes`, body: { body: reqStr(a, 'body', 20_000) } }),
    sample: () => ({ id: 'demo-n3', contact_id: 'demo-c1', body: 'Notiz', created_at: new Date().toISOString() }),
    created: { kind: 'Notiz', label: 'Notizen', ref: (r) => (typeof r?.id === 'string' ? r.id : undefined), remove: (ref) => `/api/notes/${ref}` },
  },
  'tasks.list': {
    doc: 'tasks.list({status?: "open"|"done"|"all"}) → [{id, title, description, due_at, done, contact_id, first_name, last_name}]',
    scope: 'tasks:read', write: false, kind: 'route',
    build: (a) => ({ method: 'GET', path: `/api/tasks${query({ status: oneOf(a, 'status', ['open', 'done', 'all']) })}` }),
    sample: () => [{ id: 'demo-t1', title: 'Angebot nachfassen', description: '', due_at: `${md(1)}T09:00:00.000Z`, done: 0, contact_id: 'demo-c1', first_name: 'Anna', last_name: 'Beispiel' }],
  },
  'tasks.create': {
    doc: 'tasks.create({title, description?, due_at?(ISO), contact_id?}) → task',
    scope: 'tasks:write', write: true, kind: 'route',
    build: (a) => ({ method: 'POST', path: '/api/tasks', body: { title: reqStr(a, 'title', 300), ...(str(a, 'description', 5000) ? { description: str(a, 'description', 5000) } : {}), ...(iso(a, 'due_at') ? { due_at: iso(a, 'due_at') } : {}), ...(optId(a, 'contact_id') ? { contact_id: optId(a, 'contact_id') } : {}) } }),
    sample: () => ({ id: 'demo-t2', title: 'Beispiel-Aufgabe', description: '', due_at: null, done: 0, contact_id: null }),
    created: { kind: 'Aufgabe', label: 'Aufgaben', ref: (r) => (typeof r?.id === 'string' ? r.id : undefined), remove: (ref) => `/api/tasks/${ref}` },
  },
  'tasks.update': {
    doc: 'tasks.update({id, title?, description?, due_at?, done?}) → task',
    scope: 'tasks:write', write: true, kind: 'route',
    build: (a) => ({ method: 'PATCH', path: `/api/tasks/${id(a)}`, body: { ...(str(a, 'title', 300) !== undefined ? { title: str(a, 'title', 300) } : {}), ...(str(a, 'description', 5000) !== undefined ? { description: str(a, 'description', 5000) } : {}), ...(a.due_at !== undefined ? { due_at: iso(a, 'due_at') ?? null } : {}), ...(a.done !== undefined ? { done: !!a.done } : {}) } }),
    sample: () => ({ id: 'demo-t1', title: 'Angebot nachfassen', done: 1 }),
  },
  'conversations.list': {
    doc: 'conversations.list({filter?: "unread"|"starred", channel?, q?, limit?}) → [{id, contact_id, first_name, last_name, last_message, last_message_at, unread, last_channel}]',
    scope: 'conversations:read', write: false, kind: 'route',
    build: (a) => ({ method: 'GET', path: `/api/conversations${query({ filter: oneOf(a, 'filter', ['unread', 'starred']), channel: oneOf(a, 'channel', ['email', 'sms', 'chat', 'whatsapp', 'messenger', 'instagram', 'telegram', 'discord']), q: str(a, 'q', 200), limit: int(a, 'limit', 1, 200) })}` }),
    sample: () => [{ id: 'demo-v1', contact_id: 'demo-c1', first_name: 'Anna', last_name: 'Beispiel', last_message: 'Passt, danke!', last_message_at: new Date().toISOString(), unread: 1, last_channel: 'email' }],
  },
  'conversations.messages': {
    doc: 'conversations.messages({id}) → [{id, direction:"in"|"out", channel, body, created_at}]',
    scope: 'conversations:read', write: false, kind: 'route',
    build: (a) => ({ method: 'GET', path: `/api/conversations/${id(a)}/messages` }),
    sample: () => [{ id: 'demo-m1', direction: 'in', channel: 'email', body: 'Hallo, können wir den Termin verschieben?', created_at: `${md(-1)}T09:00:00.000Z` }, { id: 'demo-m2', direction: 'out', channel: 'email', body: 'Gern – wie wäre Donnerstag?', created_at: `${md(-1)}T10:00:00.000Z` }],
  },
  'opportunities.list': {
    doc: 'opportunities.list({pipeline_id?, status?: "open"|"won"|"lost"|"abandoned"|"all", contact_id?, q?}) → [{id, name, value, status, stage_id, pipeline_id, contact_id, first_name, last_name, updated_at, stage_changed_at}]',
    scope: 'opportunities:read', write: false, kind: 'route',
    build: (a) => ({ method: 'GET', path: `/api/opportunities${query({ pipeline_id: optId(a, 'pipeline_id'), status: oneOf(a, 'status', ['open', 'won', 'lost', 'abandoned', 'all']), contact_id: optId(a, 'contact_id'), q: str(a, 'q', 200) })}` }),
    sample: SAMPLE_DEALS,
  },
  'opportunities.update': {
    doc: 'opportunities.update({id, name?, value?, stage_id?, status?}) → opportunity',
    scope: 'opportunities:write', write: true, kind: 'route',
    build: (a) => ({ method: 'PATCH', path: `/api/opportunities/${id(a)}`, body: { ...(str(a, 'name', 200) !== undefined ? { name: str(a, 'name', 200) } : {}), ...(a.value !== undefined ? { value: Number(a.value) || 0 } : {}), ...(optId(a, 'stage_id') ? { stage_id: optId(a, 'stage_id') } : {}), ...(oneOf(a, 'status', ['open', 'won', 'lost', 'abandoned']) ? { status: oneOf(a, 'status', ['open', 'won', 'lost', 'abandoned']) } : {}) } }),
    sample: () => SAMPLE_DEALS()[0],
  },
  'pipelines.list': {
    doc: 'pipelines.list() → [{id, name, stages:[{id, name}]}]',
    scope: 'opportunities:read', write: false, kind: 'route',
    build: () => ({ method: 'GET', path: '/api/pipelines' }),
    sample: () => [{ id: 'demo-p1', name: 'Vertrieb', stages: [{ id: 's1', name: 'Neu' }, { id: 's2', name: 'Angebot' }, { id: 's3', name: 'Gewonnen' }] }],
  },
  'appointments.list': {
    doc: 'appointments.list({from?(ISO), to?(ISO), calendar_id?, contact_id?}) → [{id, start_at, end_at, status, title, first_name, last_name, calendar_name}]',
    scope: 'calendars:read', write: false, kind: 'route',
    build: (a) => ({ method: 'GET', path: `/api/appointments${query({ from: iso(a, 'from'), to: iso(a, 'to'), calendar_id: optId(a, 'calendar_id'), contact_id: optId(a, 'contact_id') })}` }),
    sample: () => [{ id: 'demo-a1', start_at: `${md(1)}T09:00:00.000Z`, end_at: `${md(1)}T09:30:00.000Z`, status: 'confirmed', title: 'Kennenlerngespräch', first_name: 'Anna', last_name: 'Beispiel', calendar_name: 'Beratung' }],
  },
  'companies.list': {
    doc: 'companies.list({q?, limit?, offset?}) → {total, companies:[{id, name, domain, industry, city}]}',
    scope: 'companies:read', write: false, kind: 'route',
    build: (a) => ({ method: 'GET', path: `/api/companies${query({ q: str(a, 'q', 200), limit: int(a, 'limit', 1, 500), offset: int(a, 'offset', 0, 1_000_000) })}` }),
    sample: () => ({ total: 1, companies: [{ id: 'demo-f1', name: 'Muster GmbH', domain: 'muster.example.com', industry: 'Handwerk', city: 'Berlin' }] }),
  },
  'companies.create': {
    doc: 'companies.create({name, domain?, phone?, industry?, city?, country?, website?}) → company',
    scope: 'companies:write', write: true, kind: 'route',
    build: (a) => ({ method: 'POST', path: '/api/companies', body: { name: reqStr(a, 'name', 200), ...pick(a, ['domain', 'phone', 'industry', 'city', 'country', 'website'], 200) } }),
    sample: () => ({ id: 'demo-f2', name: 'Neue Firma' }),
    created: { kind: 'Firma', label: 'Firmen', ref: (r) => (typeof r?.id === 'string' ? r.id : undefined), remove: (ref) => `/api/companies/${ref}` },
  },
  'tickets.list': {
    doc: 'tickets.list({q?, status?, limit?}) → {total, tickets:[{id, number, subject, status, priority, created_at}]}',
    scope: 'tickets:read', write: false, kind: 'route',
    build: (a) => ({ method: 'GET', path: `/api/tickets${query({ q: str(a, 'q', 200), status: str(a, 'status', 30), limit: int(a, 'limit', 1, 200) })}` }),
    sample: () => ({ total: 1, tickets: [{ id: 'demo-k1', number: 12, subject: 'Frage zur Rechnung', status: 'open', priority: 'normal', created_at: `${md(-1)}T09:00:00.000Z` }] }),
  },
  'invoices.list': {
    doc: 'invoices.list({kind?: "invoice"|"estimate"}) → [{id, number, status, total, currency, due_at, first_name, last_name}]',
    scope: 'invoices:read', write: false, kind: 'route',
    build: (a) => ({ method: 'GET', path: `/api/invoices${query({ kind: oneOf(a, 'kind', ['invoice', 'estimate']) })}` }),
    sample: () => [{ id: 'demo-i1', number: 'R-1001', status: 'sent', total: 119000, currency: 'EUR', due_at: `${md(7)}T00:00:00.000Z`, first_name: 'Anna', last_name: 'Beispiel' }],
  },
  'objects.types': {
    doc: 'objects.types() → [{key, singular, plural, properties:[…]}] of the sub-account’s own objects',
    scope: 'objects:read', write: false, kind: 'route',
    build: () => ({ method: 'GET', path: '/api/objects' }),
    sample: () => [{ key: 'p_projekte', singular: 'Projekt', plural: 'Projekte' }],
  },
  'objects.list': {
    doc: 'objects.list({key:"p_…", q?, limit?, offset?}) → {total, records:[{id, properties:{…}}]}',
    scope: 'objects:read', write: false, kind: 'route',
    build: (a) => {
      const key = String(a.key ?? '');
      if (!OBJECT_KEY.test(key)) throw bad('„key“ ist der interne Objektname, z. B. p_projekte.');
      return { method: 'GET', path: `/api/objects/${key}/records${query({ q: str(a, 'q', 200), limit: int(a, 'limit', 1, 500), offset: int(a, 'offset', 0, 1_000_000) })}` };
    },
    sample: () => ({ total: 1, records: [{ id: 'demo-r1', properties: { name: 'Projekt Alpha' } }] }),
  },
  'objects.create': {
    doc: 'objects.create({key:"p_…", properties:{…}}) → record',
    scope: 'objects:write', write: true, kind: 'route',
    build: (a) => {
      const key = String(a.key ?? '');
      if (!OBJECT_KEY.test(key)) throw bad('„key“ ist der interne Objektname, z. B. p_projekte.');
      return { method: 'POST', path: `/api/objects/${key}/records`, body: { properties: customValues(a.properties) ?? {} } };
    },
    sample: () => ({ id: 'demo-r2', properties: { name: 'Neu' }, created: true }),
    created: { kind: 'Datensatz', label: 'Datensätze', ref: (r, a) => (r?.created === true && typeof r.id === 'string' ? `${String(a.key)}:${r.id}` : undefined), remove: (ref) => `/api/objects/${ref.split(':')[0]}/records/${ref.split(':')[1]}` },
  },
  'reports.run': {
    doc: 'reports.run({query:{source, measures:["count"|"sum:field"], group_by?:[…], filters?:[…], range?}}) → {columns, rows, totals}',
    scope: 'reports:read', write: false, kind: 'route',
    build: (a) => {
      if (!a.query || typeof a.query !== 'object' || Array.isArray(a.query)) throw bad('„query“ fehlt.');
      if (JSON.stringify(a.query).length > 8000) throw bad('„query“ ist zu groß.');
      return { method: 'POST', path: '/api/reports/run', body: { query: a.query } };
    },
    sample: () => ({ columns: [{ key: 'count', label: 'Anzahl' }], rows: [{ count: 42 }], totals: { count: 42 } }),
  },
  'ai.complete': {
    doc: 'ai.complete({prompt, system?, max_tokens?(≤1500)}) → {text}  (uses the sub-account’s AI provider and counts against its monthly limit)',
    scope: 'ai:run', write: false, kind: 'ai',
    sample: () => ({ text: 'Beispiel-Zusammenfassung: Der Kontakt ist zufrieden, wünscht ein Angebot bis Freitag und fragt nach einer Schulung.' }),
  },
  'storage.get': { doc: 'storage.get({key, user?}) → value | null  (plugin storage; user:true = private to the current user)', scope: null, write: false, kind: 'storage', sample: () => null },
  'storage.set': { doc: 'storage.set({key, value, user?}) → {ok}  (value: any JSON, up to 64 KB; 100 keys per plugin and sub-account)', scope: null, write: true, kind: 'storage', sample: () => ({ ok: true }) },
  'storage.remove': { doc: 'storage.remove({key, user?}) → {ok}', scope: null, write: true, kind: 'storage', sample: () => ({ ok: true }) },
  'storage.list': { doc: 'storage.list({prefix?, user?}) → [{key, value}]', scope: null, write: false, kind: 'storage', sample: () => [] },
};

/**
 * Routes a plugin's calls may reach (a guard checks every request made "via plugin" against this list, so a
 * mistake in an op can never open another route) – reads, the writes the ops need and the deletes of cleanup.
 */
export const PLUGIN_ROUTES: RegExp[] = [
  /^(GET|POST) \/api\/(contacts|tasks|companies)$/,
  /^(GET|PATCH|DELETE) \/api\/(contacts|tasks|companies)\/[A-Za-z0-9_-]{1,64}$/,
  /^POST \/api\/contacts\/[A-Za-z0-9_-]{1,64}\/(tags|notes)$/,
  /^DELETE \/api\/notes\/[A-Za-z0-9_-]{1,64}$/,
  /^GET \/api\/(conversations|opportunities|pipelines|appointments|tickets|invoices|objects)$/,
  /^GET \/api\/conversations\/[A-Za-z0-9_-]{1,64}\/messages$/,
  /^PATCH \/api\/opportunities\/[A-Za-z0-9_-]{1,64}$/,
  /^(GET|POST) \/api\/objects\/p_[a-z0-9_]{1,60}\/records$/,
  /^DELETE \/api\/objects\/p_[a-z0-9_]{1,60}\/records\/[A-Za-z0-9_-]{1,64}$/,
  /^POST \/api\/reports\/run$/,
];

export const OP_NAMES = Object.keys(OPS);
export const opScope = (op: string): string | null | undefined => OPS[op]?.scope;
/** Ops the manifest's scopes allow (the frame and the sandbox only offer these). */
export const opsFor = (scopes: string[]) => OP_NAMES.filter((n) => OPS[n].scope === null || scopes.includes(OPS[n].scope!));
/** Sample data of an operation (demo, preview, self-test); dates relative to today in `tz` (the sub-account's zone). */
export const sampleFor = (op: string, tz = 'Europe/Berlin'): unknown => {
  const before = sampleTz;
  sampleTz = tz || 'Europe/Berlin';
  try {
    return OPS[op]?.sample() ?? null;
  } finally {
    sampleTz = before;
  }
};
export { today as todayIso };

/** Short reference of every operation for the AI prompt and the docs. */
export function opsReference(): string {
  return OP_NAMES.map((n) => `- ${OPS[n].doc}${OPS[n].scope ? ` [scope ${OPS[n].scope}]` : ' [always allowed]'}`).join('\n');
}
