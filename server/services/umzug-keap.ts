import type { Account, Batch, Consent, CountRow, FieldType, PartKey, RCompany, RContact, RDeal, RMembership, RNote, RPipeline, RProduct, RTagRec, RTask, SourceDef, SourceField, StepCtx, StepDef } from './umzug-core.js';
import { UmzugError, VendorHttp } from './umzug-http.js';
import { first, stripHtml, toCents, toDay, toIso } from './umzug-text.js';

/**
 * Keap (REST v1, https://api.infusionsoft.com/crm/rest/v1, Service Account Key or OAuth access token):
 * contacts with e-mail status, phone numbers, addresses and custom fields, tags (and who has them), companies,
 * opportunities with their stages, notes, tasks, products. Paging goes by offset – the `next` links of
 * responses are never followed.
 */

const BASE = 'https://api.infusionsoft.com/crm/rest/v1';
const PAGE = 200;

const http = (creds: Record<string, string>, _meta: Record<string, string>, deps: { fetch?: any; sleep?: any; pauseMs?: number }) =>
  new VendorHttp({
    vendor: 'Keap',
    base: BASE,
    headers: (): Record<string, string> => (/^Bearer\s/i.test(creds.api_key ?? '') || creds.kind === 'oauth' ? { authorization: `Bearer ${String(creds.api_key ?? '').replace(/^Bearer\s+/i, '')}` } : { 'x-keap-api-key': creds.api_key ?? '' }),
    fetch: deps.fetch,
    sleep: deps.sleep,
    pauseMs: deps.pauseMs ?? 260,
    errorText: (b) => b?.message ?? b?.fault?.faultstring,
  });

async function* pages(h: VendorHttp, path: string, key: string, query: Record<string, unknown>, ctx: StepCtx, start = 0): AsyncGenerator<{ items: any[]; next: number | undefined; total: number }> {
  for (let offset = start; ; offset += PAGE) {
    if (ctx.cancelled()) return;
    const j = await h.get(path, { limit: PAGE, offset, ...query });
    const items: any[] = (Array.isArray(j) ? j : j[key]) ?? [];
    const total = Number(j.count ?? 0);
    const next = items.length === PAGE && (!total || offset + PAGE < total) ? offset + PAGE : undefined;
    yield { items, next, total };
    if (next === undefined) return;
  }
}
async function everything(h: VendorHttp, path: string, key: string, ctx: StepCtx, query: Record<string, unknown> = {}): Promise<any[]> {
  const out: any[] = [];
  for await (const pg of pages(h, path, key, query, ctx)) out.push(...pg.items);
  return out;
}
const stub = (h: VendorHttp, parts: PartKey[]): StepCtx => ({ http: h, creds: {}, meta: {}, cursor: undefined, cancelled: () => false, warn: () => undefined, limit: Infinity, options: { merge: 'fill' }, parts });

const keapType = (t: string): FieldType => (/^(date|datetime|year)/i.test(t) ? 'date' : /^(wholenumber|decimal|currency|percent)/i.test(t) ? 'number' : /^textarea/i.test(t) ? 'textarea' : /^(dropdown|radio|listbox|state|dayofweek|month)/i.test(t) ? 'select' : /^yesno/i.test(t) ? 'checkbox' : /^phone/i.test(t) ? 'phone' : /^email/i.test(t) ? 'email' : /^website/i.test(t) ? 'url' : 'text');

const CONSENT: Record<string, Consent> = { unengagedmarketable: 'ok', marketable: 'ok', nonmarketable: 'unsubscribed', unsubscribed: 'unsubscribed', bounced: 'bounced', lockedout: 'blocked', soft_bounce: 'ok', hardbounce: 'bounced', pending: 'pending', unconfirmed: 'pending', spam: 'complained', complained: 'complained' };

async function describe(h: VendorHttp, parts: PartKey[]) {
  const counts: CountRow[] = [];
  const fields: SourceField[] = [];
  const warnings: string[] = [];
  const total = async (part: PartKey, key: string, label: string, path: string, k: string) => {
    try {
      const j = await h.get(path, { limit: 1 });
      counts.push({ part, key, label, total: Number(j.count ?? (Array.isArray(j) ? j.length : (j[k] ?? []).length)) });
    } catch (e) {
      counts.push({ part, key, label, total: null, error: (e as Error).message });
      if (e instanceof UmzugError && e.fatal) throw e;
    }
  };
  if (parts.includes('contacts')) {
    await total('contacts', 'contacts', 'Kontakte', '/contacts', 'contacts');
    await total('contacts', 'tags', 'Tags', '/tags', 'tags');
    fields.push(
      { ref: 'email', label: 'E-Mail', type: 'email', std: 'email', group: 'standard' },
      { ref: 'given_name', label: 'Vorname', type: 'text', std: 'first_name', group: 'standard' },
      { ref: 'family_name', label: 'Nachname', type: 'text', std: 'last_name', group: 'standard' },
      { ref: 'phone', label: 'Telefon', type: 'phone', std: 'phone', group: 'standard' },
      { ref: 'company', label: 'Firma', type: 'text', std: 'company', group: 'standard' },
      { ref: 'website', label: 'Webseite', type: 'url', std: 'website', group: 'standard' },
      { ref: 'birthday', label: 'Geburtstag', type: 'date', std: 'date_of_birth', group: 'standard' },
      { ref: 'job_title', label: 'Position', type: 'text', group: 'custom' },
      { ref: 'address.line1', label: 'Straße', type: 'text', std: 'address', group: 'standard' },
      { ref: 'address.locality', label: 'Ort', type: 'text', std: 'city', group: 'standard' },
      { ref: 'address.postal_code', label: 'PLZ', type: 'text', std: 'postal_code', group: 'standard' },
      { ref: 'address.country_code', label: 'Land', type: 'text', std: 'country', group: 'standard' },
      { ref: 'address.region', label: 'Bundesland', type: 'text', group: 'custom' },
    );
    try {
      const m = await h.get('/contacts/model');
      for (const f of m.custom_fields ?? []) fields.push({ ref: `cf:${f.id}`, label: String(f.label ?? f.field_name ?? f.id), type: keapType(String(f.field_type)), group: 'custom', options: (f.options ?? []).map((o: any) => String(o.label)) });
    } catch (e) {
      if (!(e instanceof UmzugError && e.skippable)) throw e;
      warnings.push(`Eigene Felder nicht lesbar: ${e.message}`);
    }
  }
  if (parts.includes('companies')) await total('companies', 'companies', 'Firmen', '/companies', 'companies');
  if (parts.includes('deals')) await total('deals', 'opportunities', 'Opportunities', '/opportunities', 'opportunities');
  if (parts.includes('notes')) await total('notes', 'notes', 'Notizen', '/notes', 'notes');
  if (parts.includes('tasks')) await total('tasks', 'tasks', 'Aufgaben', '/tasks', 'tasks');
  if (parts.includes('products')) await total('products', 'products', 'Produkte', '/products', 'products');
  return { counts, fields, warnings };
}

const emailOf = (c: any) => first<string>(...(c.email_addresses ?? []).map((e: any) => e.email));
const phoneOf = (c: any) => first<string>(...(c.phone_numbers ?? []).map((p: any) => p.number));

const steps = (): StepDef[] => [
  {
    id: 'tags',
    label: 'Tags',
    part: 'contacts',
    async *run(ctx): AsyncGenerator<Batch> {
      const tags = await everything(ctx.http, '/tags', 'tags', ctx);
      yield { records: tags.map((t): RTagRec => ({ kind: 'tag', name: String(t.name) })), cursor: undefined };
    },
  },
  {
    id: 'companies',
    label: 'Firmen',
    part: 'companies',
    async *run(ctx): AsyncGenerator<Batch> {
      for await (const pg of pages(ctx.http, '/companies', 'companies', {}, ctx, Number(ctx.cursor ?? 0))) {
        const records: RCompany[] = pg.items.map((c) => ({ kind: 'company', ext: `co:${c.id}`, name: String(c.company_name ?? `Firma ${c.id}`), phone: c.phone_number?.number, website: c.website, address: c.address?.line1, city: c.address?.locality, postal_code: c.address?.postal_code, country: c.address?.country_code }));
        yield { records, cursor: pg.next, total: pg.total };
      }
    },
  },
  {
    id: 'contacts',
    label: 'Kontakte',
    part: 'contacts',
    async *run(ctx): AsyncGenerator<Batch> {
      for await (const pg of pages(ctx.http, '/contacts', 'contacts', { optional_properties: 'custom_fields,email_status,job_title,website,birthday,company', order: 'id' }, ctx, Number(ctx.cursor ?? 0))) {
        const records: RContact[] = pg.items.map((c) => {
          const values: Record<string, unknown> = { email: emailOf(c), given_name: c.given_name, family_name: c.family_name, phone: phoneOf(c), company: c.company?.company_name, website: c.website, birthday: toDay(c.birthday), job_title: c.job_title };
          const addr = (c.addresses ?? []).find((a: any) => a.field === 'BILLING') ?? c.addresses?.[0];
          if (addr) for (const k of ['line1', 'locality', 'postal_code', 'country_code', 'region']) values[`address.${k}`] = addr[k];
          for (const f of c.custom_fields ?? []) if (f.content !== null && f.content !== undefined && f.content !== '') values[`cf:${f.id}`] = f.content;
          const status = String(c.email_status ?? '');
          return { kind: 'contact', ext: `k:${c.id}`, values, consent: CONSENT[status.toLowerCase()] ?? (status ? 'unknown' : 'unknown'), native_status: status || undefined, created_at: toIso(c.date_created), org: c.company?.id ? `co:${c.company.id}` : undefined, org_name: c.company?.company_name };
        });
        yield { records, cursor: pg.next, total: pg.total };
      }
    },
  },
  {
    id: 'tag_members',
    label: 'Tags zuordnen',
    part: 'contacts',
    async *run(ctx): AsyncGenerator<Batch> {
      const tags = await everything(ctx.http, '/tags', 'tags', ctx);
      const cur = (ctx.cursor ?? { ti: 0, off: 0 }) as { ti: number; off: number };
      for (let ti = cur.ti; ti < tags.length; ti++) {
        for await (const pg of pages(ctx.http, `/tags/${tags[ti].id}/contacts`, 'contacts', {}, ctx, ti === cur.ti ? cur.off : 0)) {
          const records: RMembership[] = pg.items.map((x) => ({ kind: 'membership', contact: `k:${x.contact?.id ?? x.id}`, tags: [String(tags[ti].name)] }));
          yield { records, cursor: pg.next !== undefined ? { ti, off: pg.next } : ti + 1 < tags.length ? { ti: ti + 1, off: 0 } : undefined };
        }
      }
    },
  },
  {
    id: 'deals',
    label: 'Opportunities',
    part: 'deals',
    async *run(ctx): AsyncGenerator<Batch> {
      const cur = (ctx.cursor ?? { phase: 'pipes' }) as { phase: 'pipes' | 'deals'; off?: number };
      if (cur.phase === 'pipes') {
        // Keap has one opportunity pipeline: its stages come from the stage pipeline call (or from the opportunities seen).
        let stages: { ext: string; name: string; probability?: number }[] = [];
        try {
          const j = await ctx.http.get('/opportunity/stage_pipeline');
          const list: any[] = Array.isArray(j) ? j : (j.stages ?? j.stage_pipeline ?? []);
          stages = list.map((s: any) => ({ ext: `st:${s.id ?? s.stage_id}`, name: String(s.name ?? s.stage_name ?? s.id), probability: s.details?.probability !== undefined ? Number(s.details.probability) : undefined }));
        } catch (e) {
          if (!(e instanceof UmzugError && e.skippable)) throw e;
        }
        if (!stages.length) {
          const seen = new Map<string, string>();
          for await (const pg of pages(ctx.http, '/opportunities', 'opportunities', {}, ctx)) for (const o of pg.items) if (o.stage?.id !== undefined) seen.set(String(o.stage.id), String(o.stage.name ?? o.stage.id));
          stages = [...seen].map(([id, name]) => ({ ext: `st:${id}`, name }));
        }
        const pipeline: RPipeline = { kind: 'pipeline', ext: 'keap', name: 'Keap-Pipeline', stages };
        yield { records: [pipeline], cursor: { phase: 'deals', off: 0 } };
      }
      for await (const pg of pages(ctx.http, '/opportunities', 'opportunities', {}, ctx, cur.phase === 'deals' ? Number(cur.off ?? 0) : 0)) {
        const records: RDeal[] = pg.items.map((o) => {
          const stageName = String(o.stage?.name ?? '');
          const status = /won|gewonnen|closed won/i.test(stageName) ? 'won' : /lost|verloren/i.test(stageName) ? 'lost' : 'open';
          return {
            kind: 'deal',
            ext: `o:${o.id}`,
            name: String(o.opportunity_title ?? 'Opportunity'),
            value: Math.round(Number(o.projected_revenue_high ?? o.projected_revenue_low ?? 0)),
            pipeline: 'keap',
            stage: `st:${o.stage?.id}`,
            contact: o.contact?.id !== undefined ? `k:${o.contact.id}` : undefined,
            contact_hint: o.contact ? { name: [o.contact.first_name, o.contact.last_name].filter(Boolean).join(' ') || undefined, email: o.contact.email } : undefined,
            status,
            created_at: toIso(o.date_created),
          };
        });
        yield { records, cursor: pg.next !== undefined ? { phase: 'deals', off: pg.next } : undefined, total: pg.total };
      }
    },
  },
  {
    id: 'notes',
    label: 'Notizen',
    part: 'notes',
    async *run(ctx): AsyncGenerator<Batch> {
      for await (const pg of pages(ctx.http, '/notes', 'notes', {}, ctx, Number(ctx.cursor ?? 0))) {
        const records: RNote[] = pg.items.map((n) => ({ kind: 'note', ext: `n:${n.id}`, contact: n.contact_id !== undefined ? `k:${n.contact_id}` : undefined, body: [n.title, stripHtml(n.body ?? '')].filter(Boolean).join('\n'), at: toIso(n.date_created) }));
        yield { records, cursor: pg.next, total: pg.total };
      }
    },
  },
  {
    id: 'tasks',
    label: 'Aufgaben',
    part: 'tasks',
    async *run(ctx): AsyncGenerator<Batch> {
      for await (const pg of pages(ctx.http, '/tasks', 'tasks', {}, ctx, Number(ctx.cursor ?? 0))) {
        const records: RTask[] = pg.items.map((t) => ({ kind: 'task', ext: `t:${t.id}`, contact: t.contact?.id !== undefined ? `k:${t.contact.id}` : undefined, title: String(t.title ?? 'Aufgabe'), description: stripHtml(t.description ?? ''), due_at: toIso(t.due_date), done: !!t.completed, completed_at: toIso(t.completion_date), type: t.type }));
        yield { records, cursor: pg.next, total: pg.total };
      }
    },
  },
  {
    id: 'products',
    label: 'Produkte',
    part: 'products',
    async *run(ctx): AsyncGenerator<Batch> {
      for await (const pg of pages(ctx.http, '/products', 'products', {}, ctx, Number(ctx.cursor ?? 0))) {
        const records: RProduct[] = pg.items.map((p) => ({ kind: 'product', ext: `p:${p.id}`, name: String(p.product_name ?? `Produkt ${p.id}`), description: stripHtml([p.product_short_desc, p.product_desc].filter(Boolean).join('\n\n')), price_cents: toCents(p.product_price), active: p.active !== false, recurring: p.subscription_only ? { interval: 'month' } : undefined }));
        yield { records, cursor: pg.next, total: pg.total };
      }
    },
  },
];

export const KEAP: SourceDef = {
  key: 'keap',
  label: 'Keap',
  tagline: 'Kontakte mit Tags und Feldern, Firmen, Opportunities, Notizen, Aufgaben, Produkte',
  credentials: [{ key: 'api_key', label: 'Service Account Key (oder OAuth-Token)', secret: true, hint: 'Keap → Einstellungen → API → „Service Account Key“ erstellen' }],
  howto: ['In Keap: Einstellungen → „Keap Developer“ bzw. „API“ → „Service Account Key“ erstellen (Lesezugriff genügt).', 'Den Schlüssel hier einfügen. Ein OAuth-Access-Token (Anfang „Bearer …“) geht auch.', 'Kampagnen („Campaign Builder“) lassen sich über die REST-API nicht auslesen – sie musst du in HyperLevel als Workflow neu bauen.'],
  limits: ['Campaign Builder (Kampagnen) – nicht per REST-API lesbar','Rechnungen, Bestellungen und Abos','Formulare und Landing Pages','Pipeline-Stufen kommen aus der Konfiguration bzw. den vorhandenen Opportunities'],
  parts: [
    { key: 'contacts', label: 'Kontakte, Tags und Felder', on: true, note: 'E-Mail-Status „Unsubscribed/NonMarketable/Bounced“ → „Nicht stören“ plus Tag.' },
    { key: 'companies', label: 'Firmen', on: true },
    { key: 'deals', label: 'Opportunities → Deals', on: true },
    { key: 'notes', label: 'Notizen', on: true },
    { key: 'tasks', label: 'Aufgaben', on: true },
    { key: 'products', label: 'Produkte', on: true },
  ],
  exports: [
    { key: 'contacts', label: 'Kontakte-Export (CSV)', accept: ['.csv'], describe: 'Kontakte → Exportieren (Spalten wie „Email“, „First Name“, „Tags“).', part: 'contacts' },
    { key: 'deals', label: 'Opportunities-Export (CSV)', accept: ['.csv'], describe: 'CRM → Opportunities → Export.', part: 'deals' },
  ],
  http,
  async connect(creds, deps): Promise<Account> {
    const h = http(creds, {}, deps);
    const j = await h.get('/account/profile');
    return { account: String(j.email ?? j.name ?? j.business_name ?? 'keap').toLowerCase(), label: String(j.name ?? j.business_name ?? j.email ?? 'Keap'), meta: {} };
  },
  describe: (h, parts) => describe(h, parts),
  steps: (parts) => steps().filter((s) => parts.includes(s.part)),
};

void stub;
