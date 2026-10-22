import { createHash } from 'node:crypto';
import type { Account, Batch, Consent, ConsentProof, CountRow, FieldType, PartKey, RContact, RMembership, RTagRec, SourceDef, SourceField, StdTarget, StepDef } from './umzug-core.js';
import { consentOf } from './umzug-files.js';
import { UmzugError, VendorHttp, networkFetch } from './umzug-http.js';
import { counter } from './umzug-lib.js';
import type { Json } from './umzug-flow.js';
import { toIso } from './umzug-text.js';

/**
 * KlickTipp (REST API, https://api.klicktipp.com): subscribers with their fields, tags and status → contacts + consent ledger (a
 * confirmed opt-in is told by the opt-in time the subscriber carries), tags → tags. Login with the account's user name and password
 * (a session cookie, kept in memory only); subscribers are read in batches of 200 through the bulk call. The API lists active
 * subscribers – who unsubscribed is not in that list, so the export file is the way for them (see docs/umzug.md). Field keys are
 * `fieldFirstName`, `fieldCompanyName` … for the standard fields and `field<id>` for your own; KlickTipp gives no field types,
 * so dates (Unix seconds) are recognised by value and name.
 */

const BASE = 'https://api.klicktipp.com';
const BULK = 200;

interface Session {
  name: string;
  id: string;
}

const http = (creds: Record<string, string>, _meta: Record<string, string>, deps: { fetch?: any; sleep?: any; pauseMs?: number }) => {
  let session: Session | undefined;
  return new VendorHttp({
    vendor: 'KlickTipp',
    base: BASE,
    headers: () => ({ accept: 'application/json', ...(session ? { cookie: `${session.name}=${session.id}` } : {}) }),
    fetch: deps.fetch,
    sleep: deps.sleep,
    pauseMs: deps.pauseMs ?? 150,
    errorText: (b) => (Array.isArray(b) ? String(b[0] ?? '') : typeof b?.error === 'string' ? b.error : typeof b?.message === 'string' ? b.message : undefined),
    prepare: async () => {
      if (session) return;
      const f = deps.fetch ?? networkFetch;
      let r;
      try {
        r = await f(`${BASE}/account/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({ username: creds.username ?? '', password: creds.password ?? '' }).toString() });
      } catch (e) {
        throw new UmzugError(0, `KlickTipp nicht erreichbar: ${(e as Error).message}`);
      }
      const j: any = await r.json().catch(() => ({}));
      const sessid = j?.sessid ?? j?.data?.sessid;
      const name = j?.session_name ?? j?.data?.session_name;
      if (!r.ok || !sessid || !name) throw new UmzugError(401, 'KlickTipp: Benutzername oder Passwort ungültig');
      session = { name: String(name), id: String(sessid) };
    },
  });
};

/** A list the API sends as an array, as `{ data: [...] }` or as an object keyed by id. */
const listOf = (j: any): any[] => (Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : j && typeof j === 'object' ? Object.values(j.data ?? j) : []);
const mapOf = (j: any): Record<string, string> => {
  const m = j?.data && typeof j.data === 'object' && !Array.isArray(j.data) ? j.data : j;
  return m && typeof m === 'object' && !Array.isArray(m) ? Object.fromEntries(Object.entries(m).map(([k, v]) => [k, String(typeof v === 'object' && v ? ((v as Json).name ?? (v as Json).label ?? k) : v)])) : {};
};

/** Subscriber ids of the account (the API lists the active ones), ascending. */
async function subscriberIds(h: VendorHttp): Promise<string[]> {
  const j = await h.get('/subscriber');
  return listOf(j)
    .map((x) => String(typeof x === 'object' && x ? (x.id ?? x.subscriberid ?? '') : x))
    .filter((x) => /^\d+$/.test(x))
    .sort((a, b) => Number(a) - Number(b));
}

/** One batch of subscribers: the bulk call, or one call each when the account's API has no bulk call. */
async function loadBatch(h: VendorHttp, ids: string[], state: { single: boolean }): Promise<Json[]> {
  if (!state.single) {
    try {
      const j = await h.get(`/subscriber/bulk/${ids.join(',')}`);
      const d = j?.data ?? j;
      const out: Json[] = [];
      if (Array.isArray(d)) out.push(...d.filter((x) => x && typeof x === 'object'));
      else if (d && typeof d === 'object') for (const [k, v] of Object.entries(d)) if (v && typeof v === 'object') out.push({ id: k, ...(v as Json) });
      return out;
    } catch (e) {
      if (!(e instanceof UmzugError && [400, 404, 405, 406].includes(e.status))) throw e;
      state.single = true;
    }
  }
  const out: Json[] = [];
  for (const id of ids) {
    try {
      const j = await h.get(`/subscriber/${id}`);
      const d = j?.data && typeof j.data === 'object' && !Array.isArray(j.data) ? j.data : j;
      if (d && typeof d === 'object') out.push({ id, ...d });
    } catch (e) {
      if (!(e instanceof UmzugError && e.skippable)) throw e;
    }
  }
  return out;
}

const STD_FIELD: Record<string, StdTarget> = { fieldFirstName: 'first_name', fieldLastName: 'last_name', fieldCompanyName: 'company', fieldStreet1: 'address', fieldCity: 'city', fieldZip: 'postal_code', fieldCountry: 'country', fieldMobilePhone: 'phone', fieldWebsite: 'website', fieldBirthday: 'date_of_birth' };
const STD_LABEL: [string, string, FieldType][] = [
  ['fieldFirstName', 'Vorname', 'text'],
  ['fieldLastName', 'Nachname', 'text'],
  ['fieldCompanyName', 'Firma', 'text'],
  ['fieldStreet1', 'Straße', 'text'],
  ['fieldStreet2', 'Adresszusatz', 'text'],
  ['fieldCity', 'Ort', 'text'],
  ['fieldZip', 'PLZ', 'text'],
  ['fieldState', 'Bundesland', 'text'],
  ['fieldCountry', 'Land', 'text'],
  ['fieldMobilePhone', 'Mobiltelefon', 'phone'],
  ['fieldPrivatePhone', 'Telefon privat', 'phone'],
  ['fieldPhone', 'Telefon', 'phone'],
  ['fieldFax', 'Fax', 'phone'],
  ['fieldWebsite', 'Webseite', 'url'],
  ['fieldBirthday', 'Geburtstag', 'date'],
  ['fieldLeadValue', 'Lead-Wert', 'number'],
];

const EPOCH = (v: unknown) => (typeof v === 'number' || /^\d{9,11}$/.test(String(v ?? ''))) && Number(v) >= 100_000_000 && Number(v) < 4_102_444_800;
const DATE_NAME = /datum|date|geburt|birth|seit|bis\b|termin|ablauf|start|ende/i;
/** KlickTipp sends dates as Unix seconds and gives no field types: a number in that range in a field that sounds like a date is a date. */
export const asDay = (name: string, v: unknown): unknown => (EPOCH(v) && (DATE_NAME.test(name) || /^fieldBirthday$/.test(name)) ? (toIso(Number(v))?.slice(0, 10) ?? v) : v);

const ts = (v: unknown): string | undefined => (EPOCH(v) ? toIso(Number(v)) : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? toIso(v) : undefined);

/** Status, bounce state and opt-in time of a subscriber → consent and ledger line. */
export function klicktippConsent(o: Json): { consent: Consent; native?: string; proof: ConsentProof[] } {
  const status = String(o.status ?? o.state ?? '').trim();
  const bounce = String(o.bounce ?? '').trim();
  const at = ts(o.optin ?? o.optin_date ?? o.optin_timestamp ?? o.confirmed ?? o.date_optin);
  let consent: Consent = status ? (consentOf(status) ?? 'unknown') : 'ok';
  if (consent === 'ok' && /hard/i.test(bounce)) consent = 'bounced';
  const native = status || undefined;
  if (consent === 'pending') return { consent, native, proof: [] };
  if (consent === 'ok') {
    return { consent, native, proof: [at ? { basis: 'confirmed', at, method: 'Opt-in im KlickTipp-Anmeldeprozess bestätigt' } : { basis: 'legacy', at: ts(o.date ?? o.created ?? o.subscribed), method: 'Kontakt in KlickTipp' }] };
  }
  if (consent === 'unknown') return { consent, native, proof: [] };
  return { consent, native, proof: [{ basis: 'revoked', at: ts(o.unsubscribed ?? o.unsubscribed_date ?? o.date_unsubscribed) }] };
}

/** The ids of a tag list a subscriber carries: ids, `{id: name}` or `[{id, name}]`. */
const tagNamesOf = (raw: unknown, names: Map<string, string>): string[] => {
  const entries: [string, string | undefined][] = Array.isArray(raw) ? raw.map((x) => (x && typeof x === 'object' ? [String((x as Json).id ?? (x as Json).tagid ?? ''), (x as Json).name] : [String(x), undefined])) : raw && typeof raw === 'object' ? Object.entries(raw as Json).map(([k, v]) => [k, typeof v === 'string' ? v : undefined]) : [];
  return entries.map(([id, n]) => names.get(id) ?? n).filter((x): x is string => !!x);
};

export function klicktippContact(o: Json, tags: Map<string, string>, labels: Map<string, string> = new Map()): RContact {
  const values: Record<string, unknown> = { email: o.email ?? o.emailaddress, sms: o.smsnumber ?? o.sms_number ?? o.sms };
  for (const [k, v] of Object.entries(o)) {
    if (!/^field/.test(k) || v === null || v === undefined || v === '') continue;
    values[`f:${k}`] = asDay(`${k} ${labels.get(k) ?? ''}`, v);
  }
  const c = klicktippConsent(o);
  return { kind: 'contact', ext: `s:${o.id}`, values, tags: tagNamesOf(o.tags, tags), consent: c.consent, native_status: c.native, created_at: ts(o.date ?? o.created ?? o.subscribed ?? o.optin), proof: c.proof.length ? c.proof : undefined };
}

async function describe(h: VendorHttp, parts: PartKey[]) {
  const counts: CountRow[] = [];
  const fields: SourceField[] = [];
  const warnings: string[] = [];
  const count = counter(counts);
  if (parts.includes('contacts')) {
    await count('contacts', 'subscribers', 'Kontakte (aktive)', async () => (await subscriberIds(h)).length);
    await count('contacts', 'tags', 'Tags', async () => Object.keys(mapOf(await h.get('/tag'))).length);
    fields.push({ ref: 'email', label: 'E-Mail', type: 'email', std: 'email', group: 'standard' });
    const labels = new Map<string, string>(STD_LABEL.map(([k, l]) => [k, l]));
    try {
      for (const [k, name] of Object.entries(mapOf(await h.get('/field')))) if (!labels.has(k)) labels.set(k, name);
    } catch (e) {
      if (!(e instanceof UmzugError && e.skippable)) throw e;
      warnings.push(`Eigene Felder nicht lesbar: ${e.message}`);
    }
    const typeOf = new Map<string, FieldType>(STD_LABEL.map(([k, , t]) => [k, t]));
    for (const [k, label] of labels) fields.push({ ref: `f:${k}`, label, type: typeOf.get(k) ?? (DATE_NAME.test(label) ? 'date' : 'text'), std: STD_FIELD[k], group: STD_FIELD[k] ? 'standard' : 'custom' });
    fields.push({ ref: 'sms', label: 'SMS-Nummer', type: 'phone', group: 'custom' });
    warnings.push('KlickTipp nennt über die Schnittstelle nur aktive Kontakte: wer sich abgemeldet hat, fehlt in dieser Liste – diese Personen kommen über den CSV-Export (Spalte „Status“) dazu. Dezimalfelder liefert KlickTipp als ganze Zahl mal 100.');
  }
  return { counts, fields, warnings };
}

const steps = (): StepDef[] => [
  {
    id: 'tags',
    label: 'Tags',
    part: 'contacts',
    async *run(ctx): AsyncGenerator<Batch> {
      const tags = mapOf(await ctx.http.get('/tag'));
      yield { records: Object.values(tags).filter(Boolean).map((name): RTagRec => ({ kind: 'tag', name })), cursor: undefined };
    },
  },
  {
    id: 'contacts',
    label: 'Kontakte',
    part: 'contacts',
    async *run(ctx): AsyncGenerator<Batch> {
      const names = new Map(Object.entries(mapOf(await ctx.http.get('/tag').catch(() => ({})))));
      const labels = new Map(Object.entries(mapOf(await ctx.http.get('/field').catch(() => ({})))));
      const ids = await subscriberIds(ctx.http);
      const state = { single: false };
      for (let at = Number(ctx.cursor ?? 0); at < ids.length; at += BULK) {
        if (ctx.cancelled()) return;
        const got = await loadBatch(ctx.http, ids.slice(at, at + BULK), state);
        yield { records: got.map((o) => klicktippContact(o, names, labels)), cursor: at + BULK < ids.length ? at + BULK : undefined, total: ids.length };
      }
    },
  },
  {
    id: 'tag_members',
    label: 'Tags zuordnen',
    part: 'contacts',
    async *run(ctx): AsyncGenerator<Batch> {
      const tags = Object.entries(mapOf(await ctx.http.get('/tag')));
      for (let ti = Number(ctx.cursor ?? 0); ti < tags.length; ti++) {
        if (ctx.cancelled()) return;
        const [tagId, name] = tags[ti];
        const j = await ctx.http.req('POST', '/subscriber/tagged', { form: { tagid: tagId } });
        const ids = Array.isArray(j) || Array.isArray(j?.data) ? listOf(j).map((x) => String(typeof x === 'object' && x ? x.id : x)) : Object.keys(j?.data && typeof j.data === 'object' ? j.data : j && typeof j === 'object' ? j : {});
        const records: RMembership[] = ids.filter((id) => /^\d+$/.test(id)).map((id) => ({ kind: 'membership', contact: `s:${id}`, tags: [name] }));
        yield { records, cursor: ti + 1 < tags.length ? ti + 1 : undefined };
      }
    },
  },
];

export const KLICKTIPP: SourceDef = {
  key: 'klicktipp',
  label: 'KlickTipp',
  tagline: 'Kontakte mit Feldern und Tags, Opt-in-Status in den Einwilligungs-Nachweis',
  credentials: [
    { key: 'username', label: 'Benutzername', hint: 'Dein KlickTipp-Login (am besten ein eigener Benutzer nur für den Umzug)' },
    { key: 'password', label: 'Passwort', secret: true, password: true, hint: 'Das Passwort dieses Benutzers – es wird verschlüsselt gespeichert und nur für den Umzug gelesen' },
  ],
  howto: [
    'Die Schnittstelle ist im Tarif „Premium“ oder höher enthalten. Lege in KlickTipp unter „Konto“ → „Benutzer“ am besten einen eigenen Benutzer für den Umzug an – dann kannst du sein Passwort danach einfach ändern oder den Benutzer löschen.',
    'Trage hier Benutzername und Passwort dieses Benutzers ein. HyperLevel meldet sich damit an (es entsteht eine Sitzung, die nur im Arbeitsspeicher bleibt) und liest nur – in KlickTipp wird nichts geändert.',
    'Wer sich abgemeldet hat, steht nicht in der Liste der Schnittstelle. Exportiere diese Kontakte zusätzlich als CSV (Kontakte → „Exportieren“) und lade die Datei bei „Export-Datei hochladen“ hoch – der Status entscheidet dort, wer „Nicht stören“ bekommt.',
  ],
  limits: [
    'Abgemeldete Kontakte (die Schnittstelle liefert nur aktive – nimm dafür den CSV-Export)',
    'Smart-Tags (sie werden aus Regeln berechnet) und Tag-Abfragen mit Bedingungen',
    'E-Mail-Texte, Newsletter, Kampagnen und Automationen (der Kampagnen-Builder ist nicht lesbar – in HyperLevel als Workflow neu bauen)',
    'Anmeldeprozesse und Formulare, Landingpages und Statistiken',
    'Dezimalfelder (sie kommen als ganze Zahl mal 100) und die Feldtypen: KlickTipp nennt sie nicht, Datumsfelder werden am Wert erkannt',
  ],
  parts: [{ key: 'contacts', label: 'Kontakte, Felder und Tags', on: true, note: 'Ein bestätigtes Opt-in (mit Zeitpunkt) kommt als bestätigte Einwilligung in den Nachweis, alle anderen als Altbestand; „Ausstehend“ bleibt auf „Nicht stören“, bis die Person bestätigt.' }],
  exports: [{ key: 'contacts', label: 'Kontakte-Export (CSV)', accept: ['.csv'], describe: 'Kontakte → „Exportieren“ (CSV mit allen Feldern). Hier stehen auch Abgemeldete – die Spalte „Status“ bestimmt, wer „Nicht stören“ bekommt.', part: 'contacts' }],
  http,
  async connect(creds, deps): Promise<Account> {
    const h = http(creds, {}, deps);
    await h.get('/tag');
    const user = String(creds.username ?? '').trim().toLowerCase();
    return { account: `acct-${createHash('sha256').update(user).digest('hex').slice(0, 12)}`, label: 'KlickTipp-Konto', meta: {} };
  },
  describe: (h, parts) => describe(h, parts),
  steps: (parts) => steps().filter((s) => parts.includes(s.part)),
};

