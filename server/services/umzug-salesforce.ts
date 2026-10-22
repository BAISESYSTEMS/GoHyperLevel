import type { Account, Batch, CountRow, FieldType, PartKey, RCompany, RContact, RDeal, RPipeline, RStage, RTask, SourceDef, SourceField, StdTarget, StepCtx, StepDef } from './umzug-core.js';
import { crmConsent, dealStatus, pipelineOf } from './umzug-crm.js';
import { UmzugError, VendorHttp, networkFetch } from './umzug-http.js';
import { counter } from './umzug-lib.js';
import type { Json } from './umzug-flow.js';
import { clip, toDay, toIso } from './umzug-text.js';

/**
 * Salesforce (REST API, https://<your org>.my.salesforce.com/services/data/v62.0, SOQL): accounts → companies, contacts and leads →
 * contacts (leads tagged, converted ones skipped), opportunities → deals (stages from OpportunityStage, the primary contact role as
 * the deal's contact), tasks → tasks. Credentials: the org's My Domain address and EITHER the client id and secret of an app with the
 * client-credentials flow OR an access token. The address must be a Salesforce host; nothing else is ever called. Records are read by
 * `Id` order in blocks (`WHERE Id > …`), so a paused job continues exactly there and no server link has to be followed.
 */

const VERSION = 'v62.0';
/** Records per query block (a test makes it small to exercise the paging). */
export const TUNING = { block: 500 };
const DRY_NOTE = 'API-Aufrufe zählen gegen das Tageslimit deiner Salesforce-Org (etwa 1 Aufruf je 500 Datensätze).';
const SF_HOST = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*\.(my\.salesforce\.com|my\.salesforce-setup\.com|salesforce\.com|force\.com|cloudforce\.com)$/;

/** The org's host: https only, a Salesforce domain only. A Lightning address becomes the My Domain address. */
export function salesforceBase(input: unknown): string {
  let host = String(input ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');
  host = host.replace(/\.lightning\.force\.com$/, '.my.salesforce.com').replace(/\.my\.site\.com$/, '.my.salesforce.com');
  if (!SF_HOST.test(host)) throw new UmzugError(400, 'Die Adresse deiner Salesforce-Org sieht ungültig aus – erwartet wird die My-Domain-Adresse, z. B. https://meinefirma.my.salesforce.com');
  return `https://${host}`;
}

const http = (creds: Record<string, string>, _meta: Record<string, string>, deps: { fetch?: any; sleep?: any; pauseMs?: number }) => {
  const base = salesforceBase(creds.instance_url);
  let token = creds.access_token ?? '';
  let expires = token ? Infinity : 0;
  return new VendorHttp({
    vendor: 'Salesforce',
    base,
    headers: () => ({ authorization: `Bearer ${token}` }),
    fetch: deps.fetch,
    sleep: deps.sleep,
    pauseMs: deps.pauseMs ?? 100,
    errorText: (b) => (Array.isArray(b) ? (b[0]?.message ? `${b[0].errorCode}: ${b[0].message}` : undefined) : typeof b?.error_description === 'string' ? b.error_description : undefined),
    prepare: async () => {
      if (token && Date.now() < expires - 60_000) return;
      if (!creds.client_id || !creds.client_secret) throw new UmzugError(401, 'Salesforce: Der Zugriffs-Token ist abgelaufen – bitte einen neuen eintragen (oder Client-ID und Client-Secret verwenden)');
      const f = deps.fetch ?? networkFetch;
      let r;
      try {
        r = await f(`${base}/services/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: creds.client_id, client_secret: creds.client_secret }).toString() });
      } catch (e) {
        throw new UmzugError(0, `Salesforce nicht erreichbar: ${(e as Error).message}`);
      }
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok || !j.access_token) throw new UmzugError(401, `Salesforce: Anmeldung abgelehnt${j?.error_description ? ` (${String(j.error_description).slice(0, 120)})` : ''} – Client-ID, Client-Secret und „Client Credentials Flow“ mit einem Ausführungs-Benutzer prüfen`);
      token = String(j.access_token);
      // Sessions last two hours by default; renewed a little earlier.
      expires = Date.now() + 90 * 60_000;
    },
  });
};

const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** A SOQL query; a daily API limit is no "missing right" – the job stops and can be resumed tomorrow. */
async function soql(h: VendorHttp, query: string): Promise<{ records: Json[]; total: number }> {
  try {
    const j = await h.get(`/services/data/${VERSION}/query`, { q: query });
    return { records: Array.isArray(j?.records) ? j.records : [], total: Number(j?.totalSize ?? 0) };
  } catch (e) {
    if (e instanceof UmzugError && e.status === 403 && /REQUEST_LIMIT_EXCEEDED|TotalRequests/i.test(e.message)) throw new UmzugError(429, 'Salesforce: Das Tageslimit der API-Aufrufe ist erreicht – morgen mit „Fortsetzen“ weitermachen', e.path);
    throw e;
  }
}

const countOf = async (h: VendorHttp, sobject: string, where = '') => (await soql(h, `SELECT COUNT() FROM ${sobject}${where ? ` WHERE ${where}` : ''}`)).total;

interface SField {
  name: string;
  label: string;
  type: string;
  custom: boolean;
}
const BLOCKED = new Set(['address', 'location', 'base64', 'anyType', 'complexvalue', 'encryptedstring']);
/** Readable fields of an object (describe), or the given fallback when the describe call is not allowed. */
async function fieldsOf(h: VendorHttp, sobject: string): Promise<SField[] | undefined> {
  try {
    const j = await h.get(`/services/data/${VERSION}/sobjects/${sobject}/describe`);
    return (Array.isArray(j?.fields) ? j.fields : []).filter((f: Json) => f?.name && !BLOCKED.has(String(f.type))).map((f: Json) => ({ name: String(f.name), label: String(f.label ?? f.name), type: String(f.type), custom: !!f.custom }));
  } catch (e) {
    if (e instanceof UmzugError && e.skippable) return undefined;
    throw e;
  }
}

const FT = (t: string): FieldType => (/^(int|double|currency|percent|long)/.test(t) ? 'number' : t === 'date' || t === 'datetime' ? 'date' : t === 'boolean' ? 'checkbox' : t === 'email' ? 'email' : t === 'phone' ? 'phone' : t === 'url' ? 'url' : t === 'textarea' ? 'textarea' : t === 'picklist' ? 'select' : 'text');

const CONTACT_STD: Record<string, StdTarget> = { Email: 'email', FirstName: 'first_name', LastName: 'last_name', Phone: 'phone', MailingStreet: 'address', MailingCity: 'city', MailingPostalCode: 'postal_code', MailingCountry: 'country', Birthdate: 'date_of_birth', LeadSource: 'source', Website: 'website' };
/** A lead's address fields read like a contact's, so one mapping serves both. */
const LEAD_ADDRESS: Record<string, string> = { Street: 'MailingStreet', City: 'MailingCity', PostalCode: 'MailingPostalCode', Country: 'MailingCountry' };
const CONTACT_FIELDS = ['Id', 'FirstName', 'LastName', 'Email', 'Phone', 'MobilePhone', 'Title', 'Department', 'MailingStreet', 'MailingCity', 'MailingPostalCode', 'MailingCountry', 'AccountId', 'HasOptedOutOfEmail', 'DoNotCall', 'Birthdate', 'LeadSource', 'Description', 'CreatedDate'];
const LEAD_FIELDS = ['Id', 'FirstName', 'LastName', 'Company', 'Title', 'Email', 'Phone', 'MobilePhone', 'Street', 'City', 'PostalCode', 'Country', 'Website', 'Status', 'LeadSource', 'IsConverted', 'HasOptedOutOfEmail', 'DoNotCall', 'Description', 'CreatedDate'];
const LABELS: Record<string, string> = { MobilePhone: 'Mobiltelefon', Title: 'Position', Department: 'Abteilung', Description: 'Beschreibung', Status: 'Lead-Status', Company: 'Firma', DoNotCall: 'Nicht anrufen', LeadSource: 'Quelle', Birthdate: 'Geburtstag', MailingStreet: 'Straße', MailingCity: 'Ort', MailingPostalCode: 'PLZ', MailingCountry: 'Land', Street: 'Straße', City: 'Ort', PostalCode: 'PLZ', Country: 'Land', Website: 'Webseite', Phone: 'Telefon', Email: 'E-Mail', FirstName: 'Vorname', LastName: 'Nachname' };

/** The SOQL field list: the standard fields that exist plus the org's own (`__c`). */
const selectList = (std: string[], have: SField[] | undefined): string[] => (have ? [...std.filter((f) => have.some((x) => x.name === f)), ...have.filter((f) => f.custom).map((f) => f.name)] : std);

const dedupe = (a: string[]) => [...new Set(a)];

async function describe(h: VendorHttp, parts: PartKey[]) {
  const counts: CountRow[] = [];
  const fields: SourceField[] = [];
  const warnings: string[] = [];
  const count = counter(counts);
  if (parts.includes('contacts')) {
    await count('contacts', 'contacts', 'Kontakte', () => countOf(h, 'Contact'));
    await count('contacts', 'leads', 'Leads (ohne die schon umgewandelten)', () => countOf(h, 'Lead', 'IsConverted = false'));
    const cf = await fieldsOf(h, 'Contact');
    const lf = await fieldsOf(h, 'Lead');
    const add = (f: SField, std: StdTarget | undefined, ref: string) => {
      if (!fields.some((x) => x.ref === ref)) fields.push({ ref, label: LABELS[f.name] ?? f.label, type: FT(f.type), std, group: std ? 'standard' : 'custom' });
    };
    const base = (name: string): SField => ({ name, label: name, type: name === 'Email' ? 'email' : /Phone/.test(name) ? 'phone' : name === 'Birthdate' ? 'date' : 'string', custom: false });
    for (const name of ['Email', 'FirstName', 'LastName', 'Phone', 'MailingStreet', 'MailingCity', 'MailingPostalCode', 'MailingCountry']) add(base(name), CONTACT_STD[name], `f:${name}`);
    add(base('Company'), 'company', 'org_name');
    for (const name of ['MobilePhone', 'Title', 'Department', 'Description']) add(base(name), undefined, `f:${name}`);
    add(base('LeadSource'), 'source', 'f:LeadSource');
    add(base('Birthdate'), 'date_of_birth', 'f:Birthdate');
    fields.push({ ref: 'f:Website', label: 'Webseite', type: 'url', std: 'website', group: 'standard' });
    for (const f of [...(cf ?? []), ...(lf ?? [])]) if (f.custom) add(f, undefined, `f:${f.name}`);
    if (!cf) warnings.push('Die Feldliste der Kontakte ließ sich nicht lesen – es kommen die Standardfelder mit; eigene Felder fehlen.');
  }
  if (parts.includes('companies')) await count('companies', 'accounts', 'Accounts → Firmen', () => countOf(h, 'Account'));
  if (parts.includes('deals')) {
    await count('deals', 'stages', 'Phasen (Opportunity-Stufen)', async () => (await soql(h, 'SELECT MasterLabel FROM OpportunityStage WHERE IsActive = true')).records.length);
    await count('deals', 'opportunities', 'Opportunities → Deals', () => countOf(h, 'Opportunity'));
  }
  if (parts.includes('tasks')) await count('tasks', 'tasks', 'Aufgaben', () => countOf(h, 'Task'));
  warnings.push(DRY_NOTE);
  return { counts, fields, warnings };
}

/** Keyset reading: one block by Id after the cursor; `next` is the last Id (undefined once a block is not full). */
async function* blocks(h: VendorHttp, sobject: string, select: string[], ctx: StepCtx, where = '', after?: string): AsyncGenerator<{ items: Json[]; next: string | undefined }> {
  let cur = after;
  for (;;) {
    if (ctx.cancelled()) return;
    const w = [cur ? `Id > '${q(cur)}'` : '', where].filter(Boolean).join(' AND ');
    const { records } = await soql(h, `SELECT ${dedupe(select).join(', ')} FROM ${sobject}${w ? ` WHERE ${w}` : ''} ORDER BY Id ASC LIMIT ${TUNING.block}`);
    const next = records.length === TUNING.block ? String(records[records.length - 1].Id) : undefined;
    yield { items: records, next };
    if (!next) return;
    cur = next;
  }
}

/** Both contact kinds read the same way: standard fields as `f:<name>`, the org's own too. */
function contactValues(r: Json, orgName: string | undefined): Record<string, unknown> {
  const values: Record<string, unknown> = { org_name: orgName };
  for (const [k, v] of Object.entries(r)) {
    if (k === 'attributes' || k === 'Account' || v === null || v === undefined || v === '') continue;
    values[`f:${k}`] = k === 'Birthdate' ? toDay(v) : v;
  }
  return values;
}

const steps = (): StepDef[] => [
  {
    id: 'accounts',
    label: 'Accounts → Firmen',
    part: 'companies',
    async *run(ctx): AsyncGenerator<Batch> {
      const have = await fieldsOf(ctx.http, 'Account');
      const select = selectList(['Id', 'Name', 'Website', 'Phone', 'BillingStreet', 'BillingCity', 'BillingPostalCode', 'BillingCountry', 'Industry'], have).filter((f) => !f.endsWith('__c'));
      for await (const pg of blocks(ctx.http, 'Account', select, ctx, '', ctx.cursor ? String(ctx.cursor) : undefined)) {
        const records: RCompany[] = pg.items.map((a) => ({ kind: 'company', ext: `a:${a.Id}`, name: String(a.Name ?? `Account ${a.Id}`), website: a.Website || undefined, phone: a.Phone || undefined, address: a.BillingStreet || undefined, city: a.BillingCity || undefined, postal_code: a.BillingPostalCode || undefined, country: a.BillingCountry || undefined, industry: a.Industry || undefined }));
        yield { records, cursor: pg.next };
      }
    },
  },
  {
    id: 'contacts',
    label: 'Kontakte',
    part: 'contacts',
    async *run(ctx): AsyncGenerator<Batch> {
      const have = await fieldsOf(ctx.http, 'Contact');
      const select = [...selectList(CONTACT_FIELDS, have), 'Account.Name'];
      for await (const pg of blocks(ctx.http, 'Contact', select, ctx, '', ctx.cursor ? String(ctx.cursor) : undefined)) {
        const records: RContact[] = pg.items.map((c) => {
          const x = crmConsent('Salesforce', c.HasOptedOutOfEmail);
          const tags = c.DoNotCall ? ['Salesforce: Nicht anrufen'] : [];
          return { kind: 'contact', ext: `c:${c.Id}`, values: contactValues(c, c.Account?.Name), tags, consent: c.Email ? x.consent : 'unknown', native_status: x.native, created_at: toIso(c.CreatedDate), org: c.AccountId ? `a:${c.AccountId}` : undefined, org_name: c.Account?.Name ?? undefined, proof: c.Email ? x.proof : undefined };
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
      const have = await fieldsOf(ctx.http, 'Lead');
      const select = selectList(LEAD_FIELDS, have);
      for await (const pg of blocks(ctx.http, 'Lead', select, ctx, 'IsConverted = false', ctx.cursor ? String(ctx.cursor) : undefined)) {
        const records: RContact[] = pg.items.map((l) => {
          const x = crmConsent('Salesforce', l.HasOptedOutOfEmail);
          const values = contactValues(l, l.Company);
          for (const [from, to] of Object.entries(LEAD_ADDRESS)) if (l[from]) (values[`f:${to}`] = l[from], delete values[`f:${from}`]);
          return { kind: 'contact', ext: `l:${l.Id}`, values, tags: ['Salesforce: Lead', ...(l.Status ? [`Lead-Status: ${l.Status}`] : []), ...(l.DoNotCall ? ['Salesforce: Nicht anrufen'] : [])], consent: l.Email ? x.consent : 'unknown', native_status: x.native, created_at: toIso(l.CreatedDate), proof: l.Email ? x.proof : undefined };
        });
        yield { records, cursor: pg.next };
      }
    },
  },
  {
    id: 'deals',
    label: 'Phasen und Deals',
    part: 'deals',
    async *run(ctx): AsyncGenerator<Batch> {
      const cur = (ctx.cursor ?? { phase: 'pipe' }) as { phase: 'pipe' | 'deals'; after?: string };
      const have = await fieldsOf(ctx.http, 'Opportunity');
      const multi = !!have?.some((f) => f.name === 'CurrencyIsoCode');
      if (cur.phase === 'pipe') {
        const stages: RStage[] = (await soql(ctx.http, 'SELECT MasterLabel, SortOrder, DefaultProbability FROM OpportunityStage WHERE IsActive = true ORDER BY SortOrder ASC')).records.map((s) => ({ ext: `st:${s.MasterLabel}`, name: String(s.MasterLabel), probability: s.DefaultProbability !== undefined && s.DefaultProbability !== null ? Number(s.DefaultProbability) : undefined }));
        // Stages deals still use but the org no longer lists (retired stages).
        const seen = new Set<string>();
        for await (const pg of blocks(ctx.http, 'Opportunity', ['Id', 'StageName'], ctx)) for (const o of pg.items) seen.add(String(o.StageName ?? ''));
        const pipeline: RPipeline = pipelineOf('sf', 'Salesforce', stages, seen);
        yield { records: [pipeline], cursor: { phase: 'deals' } };
      }
      const select = dedupe([...selectList(['Id', 'Name', 'Amount', 'StageName', 'CloseDate', 'IsClosed', 'IsWon', 'AccountId', 'CreatedDate'], have), ...(multi ? ['CurrencyIsoCode'] : [])]);
      for await (const pg of blocks(ctx.http, 'Opportunity', select, ctx, '', cur.phase === 'deals' ? cur.after : undefined)) {
        const ids = pg.items.map((o) => `'${q(String(o.Id))}'`);
        const primary = new Map<string, string>();
        if (ids.length) for (const r of (await soql(ctx.http, `SELECT OpportunityId, ContactId, IsPrimary FROM OpportunityContactRole WHERE OpportunityId IN (${ids.join(',')}) ORDER BY IsPrimary DESC`)).records) if (!primary.has(String(r.OpportunityId))) primary.set(String(r.OpportunityId), String(r.ContactId));
        // No contact role: the oldest contact of the account stands in for the deal's contact.
        const accounts = dedupe(pg.items.filter((o) => !primary.has(String(o.Id)) && o.AccountId).map((o) => `'${q(String(o.AccountId))}'`));
        const byAccount = new Map<string, string>();
        if (accounts.length) for (const c of (await soql(ctx.http, `SELECT Id, AccountId FROM Contact WHERE AccountId IN (${accounts.join(',')}) ORDER BY CreatedDate ASC`)).records) if (!byAccount.has(String(c.AccountId))) byAccount.set(String(c.AccountId), String(c.Id));
        const records: RDeal[] = pg.items.map((o) => {
          const contact = primary.get(String(o.Id)) ?? (o.AccountId ? byAccount.get(String(o.AccountId)) : undefined);
          return { kind: 'deal', ext: `o:${o.Id}`, name: clip(o.Name, 200) || 'Opportunity', value: Math.round(Number(o.Amount ?? 0)), currency: multi && o.CurrencyIsoCode ? String(o.CurrencyIsoCode) : undefined, pipeline: 'sf', stage: `st:${o.StageName}`, contact: contact ? `c:${contact}` : undefined, org: o.AccountId ? `a:${o.AccountId}` : undefined, status: dealStatus({ closed: o.IsClosed, won: o.IsWon }, String(o.StageName ?? '')), created_at: toIso(o.CreatedDate) };
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
      const have = await fieldsOf(ctx.http, 'Task');
      const select = selectList(['Id', 'Subject', 'Status', 'ActivityDate', 'Description', 'IsClosed', 'WhoId', 'WhatId', 'Type', 'CreatedDate'], have).filter((f) => !f.endsWith('__c'));
      for await (const pg of blocks(ctx.http, 'Task', select, ctx, '', ctx.cursor ? String(ctx.cursor) : undefined)) {
        const records: RTask[] = pg.items.map((t) => {
          const who = String(t.WhoId ?? '');
          const what = String(t.WhatId ?? '');
          return { kind: 'task', ext: `t:${t.Id}`, title: clip(t.Subject, 300) || 'Aufgabe', description: clip(t.Description, 5000), due_at: t.ActivityDate ? toIso(`${t.ActivityDate}T09:00:00Z`) : undefined, done: t.IsClosed === true || t.Status === 'Completed', type: t.Type ?? undefined, contact: who.startsWith('003') ? `c:${who}` : who.startsWith('00Q') ? `l:${who}` : undefined, deal: what.startsWith('006') ? `o:${what}` : undefined };
        });
        yield { records, cursor: pg.next };
      }
    },
  },
];

export const SALESFORCE: SourceDef = {
  key: 'salesforce',
  label: 'Salesforce',
  tagline: 'Accounts, Kontakte, Leads, Opportunities mit Phasen, Aufgaben',
  credentials: [
    { key: 'instance_url', label: 'Adresse deiner Org', placeholder: 'https://meinefirma.my.salesforce.com', hint: 'Die My-Domain-Adresse aus der Adresszeile (bei Lightning ohne „.lightning.force.com“-Teil geht es auch)' },
    { key: 'client_id', label: 'Client-ID (Consumer Key)', optional: true, hint: 'Aus einer App mit „Client Credentials Flow“ – oder stattdessen unten einen Zugriffs-Token eintragen' },
    { key: 'client_secret', label: 'Client-Secret (Consumer Secret)', secret: true, optional: true },
    { key: 'access_token', label: 'Zugriffs-Token (statt Client-ID und Secret)', secret: true, optional: true, hint: 'Gilt nur ein paar Stunden – z. B. aus der Salesforce-CLI: „sf org display“' },
  ],
  howto: [
    'Am robustesten: In Salesforce unter Einrichtung → App-Manager → „Neue External Client App“ (oder verbundene App) anlegen, „Client Credentials Flow“ aktivieren, einen Ausführungs-Benutzer mit Leserechten wählen (Objekte Account, Contact, Lead, Opportunity, Task und die Metadaten) und Consumer Key und Secret hier eintragen.',
    'Schneller, aber nur für ein paar Stunden: einen Zugriffs-Token eintragen (z. B. mit der Salesforce-CLI: „sf org display“). Läuft er während des Umzugs ab, trägst du einen neuen ein und setzt mit „Fortsetzen“ fort.',
    'Dazu die Adresse deiner Org (My Domain, endet auf .my.salesforce.com). Gelesen wird nur – in Salesforce ändert HyperLevel nichts. Nach dem Umzug die App bzw. den Token widerrufen.',
  ],
  limits: [
    'Berichte, Dashboards, Flows und Apex-Automationen, Genehmigungsprozesse',
    'E-Mails und Anhänge (Dateien, Notizen als ContentNote) sowie der Aktivitätsverlauf außer Aufgaben',
    'Produkte, Preislisten, Angebote und Verträge; mehrere Verkaufsprozesse (alle Opportunities landen in einer Pipeline „Salesforce“)',
    'Kampagnen und Kampagnenmitglieder, Fälle (Cases), Berechtigungen und Teams',
    'Eine Werbeeinwilligung: Salesforce kennt nur das Opt-out-Feld – die Kontakte kommen ohne Einwilligung herein',
  ],
  parts: [
    { key: 'companies', label: 'Accounts → Firmen', on: true },
    { key: 'contacts', label: 'Kontakte und Leads (mit eigenen Feldern)', on: true, note: 'Leads bekommen das Tag „Salesforce: Lead“ (Lead-Status als Tag), schon umgewandelte werden übersprungen. Opt-out für E-Mails wird zu „Nicht stören“; alle anderen ohne Werbeeinwilligung.' },
    { key: 'deals', label: 'Opportunities → Deals mit Phasen', on: true, note: 'Die Phasen stammen aus der Salesforce-Konfiguration; Kontakt des Deals ist die primäre Kontaktrolle (sonst der älteste Kontakt des Accounts). Gewonnen/verloren aus „Closed Won“ / „Closed Lost“.' },
    { key: 'tasks', label: 'Aufgaben', on: true },
  ],
  exports: [
    { key: 'contacts', label: 'Kontakte oder Leads (CSV)', accept: ['.csv'], describe: 'Bericht oder Datenexport (CSV) – ohne API fehlen Firmen-Verknüpfung, Opportunities und Aufgaben.', part: 'contacts' },
    { key: 'deals', label: 'Opportunities (CSV)', accept: ['.csv'], describe: 'Bericht „Opportunities“ als CSV (Name, Betrag, Phase, Konto).', part: 'deals' },
  ],
  http,
  async connect(creds, deps): Promise<Account> {
    const base = salesforceBase(creds.instance_url);
    if (!creds.access_token && !(creds.client_id && creds.client_secret)) throw new UmzugError(400, 'Trage entweder Client-ID und Client-Secret oder einen Zugriffs-Token ein');
    const h = http(creds, {}, deps);
    const j = await h.get('/services/data/' + VERSION + '/limits');
    const host = base.replace(/^https:\/\//, '').replace(/\.my\.salesforce\.com$/, '');
    const left = Number(j?.DailyApiRequests?.Remaining ?? NaN);
    return { account: host.slice(0, 100), label: `${host}${Number.isFinite(left) ? ` · ${left.toLocaleString('de-DE')} API-Aufrufe heute frei` : ''}`.slice(0, 120), meta: {} };
  },
  describe: (h, parts) => describe(h, parts),
  steps: (parts) => steps().filter((s) => parts.includes(s.part)),
};

