import type { Account, Batch, CountRow, FieldType, PartKey, RCompany, RContact, RDeal, RNote, RPipeline, RStage, RTask, SourceDef, SourceField, StdTarget, StepCtx, StepDef } from './umzug-core.js';
import { crmConsent, dealStatus } from './umzug-crm.js';
import { UmzugError, VendorHttp, networkFetch } from './umzug-http.js';
import { counter } from './umzug-lib.js';
import type { Json } from './umzug-flow.js';
import { clip, stripHtml, toDay, toIso } from './umzug-text.js';

/**
 * Zoho CRM (REST API v6, https://www.zohoapis.<region>/crm/v6, OAuth with a refresh token): accounts → companies, contacts and leads →
 * contacts (leads tagged, converted ones skipped), deals → deals with the pipelines and stages of the account, tasks → tasks,
 * notes → notes. The user makes a "Self Client" in the Zoho API console and pastes client id, secret and the one-time code; connect()
 * exchanges the code for a refresh token and keeps that (sealed) instead – the code itself is useless after ten minutes. Only the
 * eight Zoho regions' hosts are ever called; pages by `page_token`.
 */

const REGIONS = ['com', 'eu', 'in', 'com.au', 'jp', 'ca', 'sa', 'cn'];
const PAGE = 200;
/** Zoho takes at most 50 fields per record call. */
const MAX_FIELDS = 50;

export function zohoRegion(v: unknown): string {
  const r = String(v ?? '').trim().toLowerCase().replace(/^\.|^zoho\.|^https?:\/\/(www\.)?(accounts\.)?zoho(apis)?\./, '').replace(/[/?#].*$/, '') || 'com';
  if (!REGIONS.includes(r)) throw new UmzugError(400, `Die Zoho-Region ist eine von: ${REGIONS.join(', ')} – so endet die Adresse, mit der du dich bei Zoho anmeldest (zoho.eu → eu)`);
  return r;
}

const accountsHost = (region: string) => `https://accounts.zoho.${region}`;

async function token(creds: Record<string, string>, region: string, fetchFn: any, grant: Record<string, string>): Promise<any> {
  const f = fetchFn ?? networkFetch;
  let r;
  try {
    r = await f(`${accountsHost(region)}/oauth/v2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({ client_id: creds.client_id ?? '', client_secret: creds.client_secret ?? '', ...grant }).toString() });
  } catch (e) {
    throw new UmzugError(0, `Zoho nicht erreichbar: ${(e as Error).message}`);
  }
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.error || !j.access_token) throw new UmzugError(401, `Zoho: Anmeldung abgelehnt${j?.error ? ` (${String(j.error).slice(0, 80)})` : ''} – Client-ID, Client-Secret, Region und den Code prüfen (der Code gilt nur zehn Minuten und nur einmal)`);
  return j;
}

const http = (creds: Record<string, string>, _meta: Record<string, string>, deps: { fetch?: any; sleep?: any; pauseMs?: number }) => {
  const region = zohoRegion(creds.data_center);
  let access = '';
  let expires = 0;
  return new VendorHttp({
    vendor: 'Zoho CRM',
    base: `https://www.zohoapis.${region}/crm/v6`,
    headers: () => ({ authorization: `Zoho-oauthtoken ${access}` }),
    fetch: deps.fetch,
    sleep: deps.sleep,
    pauseMs: deps.pauseMs ?? 200,
    errorText: (b) => (typeof b?.message === 'string' ? `${b.code ?? ''} ${b.message}`.trim() : Array.isArray(b?.data) && b.data[0]?.message ? String(b.data[0].message) : undefined),
    prepare: async () => {
      if (access && Date.now() < expires - 60_000) return;
      if (!creds.refresh_token) throw new UmzugError(401, 'Zoho: Es fehlt der Refresh-Token – bitte neu verbinden');
      const j = await token(creds, region, deps.fetch, { grant_type: 'refresh_token', refresh_token: creds.refresh_token });
      access = String(j.access_token);
      expires = Date.now() + Number(j.expires_in ?? 3600) * 1000;
    },
  });
};

interface ZField {
  api: string;
  label: string;
  type: string;
  custom: boolean;
  options: string[];
}
async function fieldsOf(h: VendorHttp, module: string): Promise<ZField[] | undefined> {
  try {
    const j = await h.get('/settings/fields', { module });
    return (Array.isArray(j?.fields) ? j.fields : []).filter((f: Json) => f?.api_name).map((f: Json) => ({ api: String(f.api_name), label: String(f.field_label ?? f.api_name), type: String(f.data_type ?? 'text'), custom: !!f.custom_field, options: Array.isArray(f.pick_list_values) ? f.pick_list_values.map((o: Json) => String(o.display_value ?? o.actual_value)) : [] }));
  } catch (e) {
    if (e instanceof UmzugError && e.skippable) return undefined;
    throw e;
  }
}
const FT = (t: string): FieldType => (/^(integer|bigint|double|currency|percent|decimal)/.test(t) ? 'number' : /^(date|datetime)$/.test(t) ? 'date' : t === 'boolean' ? 'checkbox' : t === 'email' ? 'email' : t === 'phone' ? 'phone' : t === 'website' ? 'url' : /textarea/.test(t) ? 'textarea' : /^picklist$/.test(t) ? 'select' : 'text');
const SKIP_TYPES = new Set(['lookup', 'ownerlookup', 'userlookup', 'multiselectlookup', 'subform', 'fileupload', 'imageupload', 'profileimage', 'autonumber', 'formula', 'rollup_summary', 'multi_module_lookup']);

const CONTACT_STD = ['First_Name', 'Last_Name', 'Email', 'Phone', 'Mobile', 'Title', 'Department', 'Mailing_Street', 'Mailing_City', 'Mailing_Zip', 'Mailing_Country', 'Email_Opt_Out', 'Date_of_Birth', 'Lead_Source', 'Description', 'Account_Name', 'Created_Time'];
const LEAD_STD = ['First_Name', 'Last_Name', 'Company', 'Email', 'Phone', 'Mobile', 'Title', 'Street', 'City', 'Zip_Code', 'Country', 'Website', 'Lead_Status', 'Lead_Source', 'Email_Opt_Out', 'Description', 'Created_Time', 'Converted__s'];
const LEAD_ADDRESS: Record<string, string> = { Street: 'Mailing_Street', City: 'Mailing_City', Zip_Code: 'Mailing_Zip', Country: 'Mailing_Country' };
const STD: Record<string, StdTarget> = { Email: 'email', First_Name: 'first_name', Last_Name: 'last_name', Phone: 'phone', Mailing_Street: 'address', Mailing_City: 'city', Mailing_Zip: 'postal_code', Mailing_Country: 'country', Date_of_Birth: 'date_of_birth', Lead_Source: 'source', Website: 'website' };
const LABELS: Record<string, string> = { Mobile: 'Mobiltelefon', Title: 'Position', Department: 'Abteilung', Description: 'Beschreibung', Phone: 'Telefon', Email: 'E-Mail', First_Name: 'Vorname', Last_Name: 'Nachname', Mailing_Street: 'Straße', Mailing_City: 'Ort', Mailing_Zip: 'PLZ', Mailing_Country: 'Land', Date_of_Birth: 'Geburtstag', Lead_Source: 'Quelle', Website: 'Webseite' };

/** The `fields` parameter: the standard fields that exist plus the account's own, at most 50. */
function select(std: string[], have: ZField[] | undefined): string[] {
  if (!have) return std.slice(0, MAX_FIELDS);
  const ok = std.filter((f) => have.some((x) => x.api === f) || f === 'Account_Name' || f === 'Converted__s');
  const own = have.filter((f) => f.custom && !SKIP_TYPES.has(f.type)).map((f) => f.api);
  return [...new Set([...ok, ...own])].slice(0, MAX_FIELDS);
}

/** Pages by `page_token` (200 per page); the token comes out of `info`, never a link. */
async function* pages(h: VendorHttp, module: string, fields: string[], ctx: StepCtx, query: Record<string, unknown> = {}, after?: string): AsyncGenerator<{ items: Json[]; next: string | undefined }> {
  let cur = after;
  for (;;) {
    if (ctx.cancelled()) return;
    const j = await h.get(`/${module}`, { fields: fields.join(','), per_page: PAGE, sort_by: 'id', sort_order: 'asc', ...query, ...(cur ? { page_token: cur } : {}) });
    const items: Json[] = Array.isArray(j?.data) ? j.data : [];
    const next = j?.info?.more_records && j?.info?.next_page_token ? String(j.info.next_page_token) : undefined;
    yield { items, next };
    if (!next) return;
    cur = next;
  }
}
const countOf = async (h: VendorHttp, module: string) => Number((await h.get(`/${module}/actions/count`))?.count ?? 0);

async function describe(h: VendorHttp, parts: PartKey[]) {
  const counts: CountRow[] = [];
  const fields: SourceField[] = [];
  const warnings: string[] = [];
  const count = counter(counts);
  if (parts.includes('contacts')) {
    await count('contacts', 'contacts', 'Kontakte', () => countOf(h, 'Contacts'));
    await count('contacts', 'leads', 'Leads', () => countOf(h, 'Leads'));
    const cf = await fieldsOf(h, 'Contacts');
    const lf = await fieldsOf(h, 'Leads');
    const add = (ref: string, label: string, type: FieldType, std?: StdTarget) => {
      if (!fields.some((x) => x.ref === ref)) fields.push({ ref, label, type, std, group: std ? 'standard' : 'custom' });
    };
    add('f:Email', 'E-Mail', 'email', 'email');
    for (const name of ['First_Name', 'Last_Name', 'Phone', 'Mailing_Street', 'Mailing_City', 'Mailing_Zip', 'Mailing_Country']) add(`f:${name}`, LABELS[name] ?? name, 'text', STD[name]);
    add('org_name', 'Firma', 'text', 'company');
    add('f:Mobile', 'Mobiltelefon', 'phone');
    add('f:Title', 'Position', 'text');
    add('f:Department', 'Abteilung', 'text');
    add('f:Description', 'Beschreibung', 'textarea');
    add('f:Lead_Source', 'Quelle', 'text', 'source');
    add('f:Date_of_Birth', 'Geburtstag', 'date', 'date_of_birth');
    add('f:Website', 'Webseite', 'url', 'website');
    for (const f of [...(cf ?? []), ...(lf ?? [])]) if (f.custom && !SKIP_TYPES.has(f.type)) add(`f:${f.api}`, f.label, FT(f.type));
    if (!cf) warnings.push('Die Feldliste der Kontakte ließ sich nicht lesen – es kommen die Standardfelder mit; eigene Felder fehlen.');
    if ((cf ?? []).filter((f) => f.custom).length + CONTACT_STD.length > MAX_FIELDS) warnings.push(`Zoho erlaubt höchstens ${MAX_FIELDS} Felder je Abruf – bei mehr eigenen Feldern kommen die ersten mit.`);
  }
  if (parts.includes('companies')) await count('companies', 'accounts', 'Accounts → Firmen', () => countOf(h, 'Accounts'));
  if (parts.includes('deals')) await count('deals', 'deals', 'Deals', () => countOf(h, 'Deals'));
  if (parts.includes('tasks')) await count('tasks', 'tasks', 'Aufgaben', () => countOf(h, 'Tasks'));
  if (parts.includes('notes')) await count('notes', 'notes', 'Notizen', () => countOf(h, 'Notes'));
  return { counts, fields, warnings };
}

const idOf = (v: unknown): string | undefined => (v && typeof v === 'object' && (v as Json).id ? String((v as Json).id) : undefined);
const nameOf = (v: unknown): string | undefined => (v && typeof v === 'object' && (v as Json).name ? String((v as Json).name) : undefined);

function values(r: Json, orgName: string | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { org_name: orgName };
  for (const [k, v] of Object.entries(r)) {
    if (v === null || v === undefined || v === '' || k.startsWith('$') || k === 'Account_Name' || k === 'Owner' || k === 'id') continue;
    out[`f:${k}`] = typeof v === 'object' ? ((v as Json).name ?? JSON.stringify(v)) : k === 'Date_of_Birth' ? toDay(v) : v;
  }
  return out;
}

const steps = (): StepDef[] => [
  {
    id: 'accounts',
    label: 'Accounts → Firmen',
    part: 'companies',
    async *run(ctx): AsyncGenerator<Batch> {
      for await (const pg of pages(ctx.http, 'Accounts', ['Account_Name', 'Website', 'Phone', 'Billing_Street', 'Billing_City', 'Billing_Code', 'Billing_Country', 'Industry'], ctx, {}, ctx.cursor ? String(ctx.cursor) : undefined)) {
        const records: RCompany[] = pg.items.map((a) => ({ kind: 'company', ext: `a:${a.id}`, name: String(a.Account_Name ?? `Account ${a.id}`), website: a.Website || undefined, phone: a.Phone || undefined, address: a.Billing_Street || undefined, city: a.Billing_City || undefined, postal_code: a.Billing_Code || undefined, country: a.Billing_Country || undefined, industry: a.Industry || undefined }));
        yield { records, cursor: pg.next };
      }
    },
  },
  {
    id: 'contacts',
    label: 'Kontakte',
    part: 'contacts',
    async *run(ctx): AsyncGenerator<Batch> {
      const fields = select(CONTACT_STD, await fieldsOf(ctx.http, 'Contacts'));
      for await (const pg of pages(ctx.http, 'Contacts', fields, ctx, {}, ctx.cursor ? String(ctx.cursor) : undefined)) {
        const records: RContact[] = pg.items.map((c) => {
          const x = crmConsent('Zoho CRM', c.Email_Opt_Out);
          return { kind: 'contact', ext: `c:${c.id}`, values: values(c, nameOf(c.Account_Name)), consent: c.Email ? x.consent : 'unknown', native_status: x.native, created_at: toIso(c.Created_Time), org: idOf(c.Account_Name) ? `a:${idOf(c.Account_Name)}` : undefined, org_name: nameOf(c.Account_Name), proof: c.Email ? x.proof : undefined };
        });
        yield { records, cursor: pg.next };
      }
    },
  },
  {
    id: 'leads',
    label: 'Leads',
    part: 'contacts',
    async *run(ctx): AsyncGenerator<Batch> {
      const fields = select(LEAD_STD, await fieldsOf(ctx.http, 'Leads'));
      for await (const pg of pages(ctx.http, 'Leads', fields, ctx, {}, ctx.cursor ? String(ctx.cursor) : undefined)) {
        const records: RContact[] = pg.items
          .filter((l) => l.Converted__s !== true)
          .map((l) => {
            const x = crmConsent('Zoho CRM', l.Email_Opt_Out);
            const v = values(l, l.Company ? String(l.Company) : undefined);
            for (const [from, to] of Object.entries(LEAD_ADDRESS)) if (l[from]) (v[`f:${to}`] = l[from], delete v[`f:${from}`]);
            return { kind: 'contact', ext: `l:${l.id}`, values: v, tags: ['Zoho: Lead', ...(l.Lead_Status ? [`Lead-Status: ${l.Lead_Status}`] : [])], consent: l.Email ? x.consent : 'unknown', native_status: x.native, created_at: toIso(l.Created_Time), proof: l.Email ? x.proof : undefined };
          });
        yield { records, cursor: pg.next };
      }
    },
  },
  {
    id: 'deals',
    label: 'Pipelines und Deals',
    part: 'deals',
    async *run(ctx): AsyncGenerator<Batch> {
      const cur = (ctx.cursor ?? { phase: 'pipes' }) as { phase: 'pipes' | 'deals'; after?: string };
      const outcome = new Map<string, 'won' | 'lost' | 'open'>();
      let pipes: RPipeline[] = [];
      try {
        const layouts = ((await ctx.http.get('/settings/layouts', { module: 'Deals' }))?.layouts ?? []) as Json[];
        const byName = new Map<string, RPipeline>();
        for (const l of layouts) {
          const j = await ctx.http.get('/settings/pipeline', { layout_id: l.id });
          for (const p of Array.isArray(j?.pipeline) ? j.pipeline : []) {
            const name = String(p.display_value ?? 'Pipeline');
            const stages: RStage[] = (Array.isArray(p.maps) ? p.maps : []).slice().sort((a: Json, b: Json) => Number(a.sequence_number ?? 0) - Number(b.sequence_number ?? 0)).map((m: Json) => {
              const kind = `${m.forecast_type ?? ''} ${m.forecast_category?.name ?? ''}`;
              outcome.set(`${name}\u0000${m.display_value}`, /won/i.test(kind) ? 'won' : /lost/i.test(kind) ? 'lost' : 'open');
              return { ext: `st:${name}:${m.display_value}`, name: String(m.display_value), probability: m.probability !== undefined && m.probability !== null ? Number(m.probability) : undefined };
            });
            if (!byName.has(name)) byName.set(name, { kind: 'pipeline', ext: `pl:${name}`, name, stages });
          }
        }
        pipes = [...byName.values()];
      } catch (e) {
        if (!(e instanceof UmzugError && e.skippable)) throw e;
        ctx.warn('Die Pipelines von Zoho ließen sich nicht lesen – die Phasen werden aus den Deals zusammengestellt');
      }
      // Pipelines and stages that only deals mention (or all of them when the settings are closed).
      const seen = new Map<string, Set<string>>();
      for await (const pg of pages(ctx.http, 'Deals', ['Pipeline', 'Stage'], ctx)) {
        for (const d of pg.items) {
          const pn = String(d.Pipeline ?? 'Zoho');
          if (!seen.has(pn)) seen.set(pn, new Set());
          seen.get(pn)!.add(String(d.Stage ?? ''));
        }
      }
      for (const [name, stages] of seen) {
        let p = pipes.find((x) => x.name === name);
        if (!p) pipes.push((p = { kind: 'pipeline', ext: `pl:${name}`, name, stages: [] }));
        for (const st of stages) if (st && !p.stages.some((s) => s.name === st)) p.stages.push({ ext: `st:${name}:${st}`, name: st });
      }
      if (cur.phase === 'pipes') yield { records: pipes, cursor: { phase: 'deals' } };
      const fields = ['Deal_Name', 'Amount', 'Stage', 'Pipeline', 'Closing_Date', 'Account_Name', 'Contact_Name', 'Probability', 'Currency', 'Lead_Source', 'Created_Time'];
      for await (const pg of pages(ctx.http, 'Deals', fields, ctx, {}, cur.phase === 'deals' ? cur.after : undefined)) {
        const records: RDeal[] = pg.items.map((d) => {
          const pipe = String(d.Pipeline ?? 'Zoho');
          const stage = String(d.Stage ?? '');
          const known = outcome.get(`${pipe}\u0000${stage}`);
          const status = known && known !== 'open' ? known : dealStatus({}, stage);
          return { kind: 'deal', ext: `d:${d.id}`, name: clip(d.Deal_Name, 200) || 'Deal', value: Math.round(Number(d.Amount ?? 0)), currency: d.Currency ? String(d.Currency) : undefined, pipeline: `pl:${pipe}`, stage: `st:${pipe}:${stage}`, contact: idOf(d.Contact_Name) ? `c:${idOf(d.Contact_Name)}` : undefined, contact_hint: nameOf(d.Contact_Name) ? { name: nameOf(d.Contact_Name) } : undefined, org: idOf(d.Account_Name) ? `a:${idOf(d.Account_Name)}` : undefined, status, created_at: toIso(d.Created_Time) };
        });
        yield { records, cursor: pg.next ? { phase: 'deals', after: pg.next } : undefined };
      }
    },
  },
  {
    id: 'tasks',
    label: 'Aufgaben',
    part: 'tasks',
    async *run(ctx): AsyncGenerator<Batch> {
      for await (const pg of pages(ctx.http, 'Tasks', ['Subject', 'Due_Date', 'Status', 'Description', 'Who_Id', 'What_Id', '$se_module', 'Created_Time'], ctx, {}, ctx.cursor ? String(ctx.cursor) : undefined)) {
        const records: RTask[] = pg.items.map((t) => ({
          kind: 'task',
          ext: `t:${t.id}`,
          title: clip(t.Subject, 300) || 'Aufgabe',
          description: clip(t.Description, 5000),
          due_at: t.Due_Date ? toIso(`${t.Due_Date}T09:00:00Z`) : undefined,
          done: /completed|abgeschlossen|erledigt/i.test(String(t.Status ?? '')),
          contact: idOf(t.Who_Id) ? `c:${idOf(t.Who_Id)}` : undefined,
          deal: idOf(t.What_Id) && t.$se_module === 'Deals' ? `d:${idOf(t.What_Id)}` : undefined,
        }));
        yield { records, cursor: pg.next };
      }
    },
  },
  {
    id: 'notes',
    label: 'Notizen',
    part: 'notes',
    async *run(ctx): AsyncGenerator<Batch> {
      for await (const pg of pages(ctx.http, 'Notes', ['Note_Title', 'Note_Content', 'Parent_Id', '$se_module', 'Created_Time'], ctx, {}, ctx.cursor ? String(ctx.cursor) : undefined)) {
        const records: RNote[] = [];
        for (const n of pg.items) {
          const parent = idOf(n.Parent_Id);
          const mod = String(n.$se_module ?? '');
          const body = [n.Note_Title, stripHtml(n.Note_Content ?? '')].filter(Boolean).join('\n\n').trim();
          if (!parent || !body) continue;
          if (mod === 'Contacts') records.push({ kind: 'note', ext: `n:${n.id}`, contact: `c:${parent}`, body, at: toIso(n.Created_Time) });
          else if (mod === 'Leads') records.push({ kind: 'note', ext: `n:${n.id}`, contact: `l:${parent}`, body, at: toIso(n.Created_Time) });
          else if (mod === 'Deals') records.push({ kind: 'note', ext: `n:${n.id}`, deal: `d:${parent}`, body, at: toIso(n.Created_Time) });
        }
        yield { records, cursor: pg.next };
      }
    },
  },
];

export const ZOHO: SourceDef = {
  key: 'zoho',
  label: 'Zoho CRM',
  tagline: 'Accounts, Kontakte, Leads, Deals mit Pipelines und Phasen, Aufgaben, Notizen',
  credentials: [
    { key: 'data_center', label: 'Region', placeholder: 'com, eu, in, com.au, jp, ca, sa oder cn', optional: true, hint: 'So endet die Adresse deines Zoho-Logins (zoho.eu → eu); leer = com' },
    { key: 'client_id', label: 'Client-ID', hint: 'Zoho API-Konsole → „Self Client“ → Client-ID' },
    { key: 'client_secret', label: 'Client-Secret', secret: true, hint: 'Dort ebenfalls unter „Client Secret“' },
    { key: 'code', label: 'Code (Grant Token)', secret: true, hint: 'Im Self Client: Reiter „Generate Code“ – Scope ZohoCRM.modules.READ,ZohoCRM.settings.READ, Dauer 10 Minuten. HyperLevel tauscht ihn sofort gegen einen Refresh-Token' },
  ],
  howto: [
    'Öffne die Zoho-API-Konsole deiner Region (z. B. api-console.zoho.eu) → „Self Client“. Dort stehen Client-ID und Client-Secret.',
    'Im Reiter „Generate Code“ als Scope „ZohoCRM.modules.READ,ZohoCRM.settings.READ“ eintragen, eine Dauer von 10 Minuten wählen und einen Code erzeugen.',
    'Region, Client-ID, Client-Secret und den Code hier eintragen – innerhalb der zehn Minuten. HyperLevel tauscht den Code sofort gegen einen Refresh-Token (verschlüsselt gespeichert) und liest nur. Nach dem Umzug widerrufst du die Zugriffe im Zoho-Konto unter „Verbundene Apps“.',
  ],
  limits: [
    'Berichte, Dashboards, Workflow-Regeln, Blueprints und Makros',
    'E-Mails, Anhänge und Dateien sowie der Aktivitätsverlauf außer Aufgaben und Notizen (Notizen an Accounts bleiben bei Zoho)',
    'Produkte, Angebote, Aufträge, Rechnungen, Kampagnen',
    'Pro Abruf höchstens 50 Felder: bei mehr eigenen Feldern kommen die ersten mit',
    'Eine Werbeeinwilligung: Zoho kennt nur das Opt-out-Feld – die Kontakte kommen ohne Einwilligung herein',
  ],
  parts: [
    { key: 'companies', label: 'Accounts → Firmen', on: true },
    { key: 'contacts', label: 'Kontakte und Leads (mit eigenen Feldern)', on: true, note: 'Leads bekommen das Tag „Zoho: Lead“ (Lead-Status als Tag), umgewandelte werden übersprungen. Opt-out für E-Mails wird zu „Nicht stören“; alle anderen kommen ohne Werbeeinwilligung.' },
    { key: 'deals', label: 'Deals mit Pipelines und Phasen', on: true, note: 'Pipelines und Phasen stammen aus der Zoho-Konfiguration; gewonnen/verloren nach der Phasen-Art.' },
    { key: 'tasks', label: 'Aufgaben', on: true },
    { key: 'notes', label: 'Notizen (an Kontakten, Leads und Deals)', on: true },
  ],
  exports: [
    { key: 'contacts', label: 'Kontakte oder Leads (CSV)', accept: ['.csv'], describe: 'Kontakte → „Exportieren“ (CSV) – ohne API fehlen Firmen-Verknüpfung, Deals, Aufgaben und Notizen.', part: 'contacts' },
    { key: 'deals', label: 'Deals (CSV)', accept: ['.csv'], describe: 'Deals → „Exportieren“ (Deal-Name, Betrag, Phase, Pipeline).', part: 'deals' },
  ],
  http,
  async connect(creds, deps): Promise<Account> {
    const region = zohoRegion(creds.data_center);
    let refresh = creds.refresh_token ?? '';
    let first: any;
    if (!refresh) {
      if (!creds.code) throw new UmzugError(400, 'Es fehlt der Code (Grant Token) aus dem Self Client');
      first = await token(creds, region, deps.fetch, { grant_type: 'authorization_code', code: creds.code });
      refresh = String(first.refresh_token ?? '');
      if (!refresh) throw new UmzugError(400, 'Zoho hat keinen Refresh-Token geliefert – der Code muss frisch sein und mit „Generate Code“ im Self Client erzeugt werden');
    }
    const kept: Record<string, string> = { data_center: region, client_id: String(creds.client_id ?? ''), client_secret: String(creds.client_secret ?? ''), refresh_token: refresh };
    const h = http(kept, {}, deps);
    const j = await h.get('/org');
    const org: Json = Array.isArray(j?.org) ? j.org[0] : {};
    const id = String(org.zgid ?? org.id ?? '');
    return { account: /^\d{3,25}$/.test(id) ? `org-${id}` : `org-${region}-${kept.client_id.slice(-8)}`.toLowerCase().replace(/[^a-z0-9.-]/g, ''), label: String(org.company_name ?? 'Zoho-CRM-Organisation').slice(0, 120), meta: {}, secrets: kept };
  },
  describe: (h, parts) => describe(h, parts),
  steps: (parts) => steps().filter((s) => parts.includes(s.part)),
};
