import { createHash } from 'node:crypto';
import type { Account, Batch, Consent, ConsentProof, CountRow, FieldType, PartKey, RContact, RMembership, RReference, RSmartList, RTagRec, RTemplate, SourceDef, SourceField, StepCtx, StepDef } from './umzug-core.js';
import { UmzugError, VendorHttp } from './umzug-http.js';
import { cell, type Json } from './umzug-flow.js';
import { counter, paramOf, stubCtx, walkCount } from './umzug-lib.js';
import { toIso } from './umzug-text.js';

/**
 * Klaviyo (REST API, https://a.klaviyo.com/api, header `Authorization: Klaviyo-API-Key pk_…` plus a dated `revision`): profiles with
 * properties and their e-mail/SMS consent → contacts + consent ledger, lists and segments → tags (segments also as smart lists),
 * templates → e-mail templates, flows → a reference list in the wiki (they are not readable step by step). JSON:API pages with
 * `page[cursor]`; the cursor is taken out of `links.next`, the link itself is never followed.
 */

const BASE = 'https://a.klaviyo.com/api';
/** The API revision this importer was written against (Klaviyo supports each revision for a long time). */
export const KLAVIYO_REVISION = '2026-07-15';
const PROFILE_PAGE = 100;
/** The preview counts by walking pages (the API has no totals): at most this many. */
const COUNT_PAGES = 40;

const http = (creds: Record<string, string>, _meta: Record<string, string>, deps: { fetch?: any; sleep?: any; pauseMs?: number }) =>
  new VendorHttp({
    vendor: 'Klaviyo',
    base: BASE,
    headers: () => ({ authorization: `Klaviyo-API-Key ${creds.api_key ?? ''}`, revision: KLAVIYO_REVISION, accept: 'application/vnd.api+json' }),
    fetch: deps.fetch,
    sleep: deps.sleep,
    pauseMs: deps.pauseMs ?? 120,
    errorText: (b) => (Array.isArray(b?.errors) ? (b.errors[0]?.detail ?? b.errors[0]?.title) : undefined),
  });

interface Pg {
  items: any[];
  included: any[];
  next: string | undefined;
}
async function* pages(h: VendorHttp, path: string, query: Record<string, unknown>, ctx: StepCtx, after?: string): AsyncGenerator<Pg> {
  let cur = after;
  for (;;) {
    if (ctx.cancelled()) return;
    const j = await h.get(path, { ...query, ...(cur ? { 'page[cursor]': cur } : {}) });
    const next = paramOf(j?.links?.next, 'page[cursor]');
    yield { items: Array.isArray(j?.data) ? j.data : [], included: Array.isArray(j?.included) ? j.included : [], next };
    if (!next) return;
    cur = next;
  }
}
async function everything(h: VendorHttp, path: string, query: Record<string, unknown>, ctx: StepCtx): Promise<Pg[]> {
  const out: Pg[] = [];
  for await (const pg of pages(h, path, query, ctx)) out.push(pg);
  return out;
}

const PROFILE_QUERY = { 'page[size]': PROFILE_PAGE, 'additional-fields[profile]': 'subscriptions', sort: 'created' };
const MEMBER_QUERY = { 'page[size]': PROFILE_PAGE, 'fields[profile]': 'email' };

const SUPPRESSION: Record<string, string> = { UNSUBSCRIBE: 'hat sich abgemeldet', USER_SUPPRESSED: 'manuell gesperrt', HARD_BOUNCE: 'E-Mail unzustellbar', INVALID_EMAIL: 'E-Mail-Adresse ungültig', SPAM_COMPLAINT: 'Spam-Beschwerde' };
const EXPLICIT = /form|checkout|preference|shopify|popup|pop-up|landing|embed|survey/i;

/** The e-mail and SMS statements of a profile → contact consent (DND, tag) and ledger lines. */
export function klaviyoConsent(a: Json): { consent: Consent; native?: string; proof: ConsentProof[] } {
  const proof: ConsentProof[] = [];
  let consent: Consent = 'unknown';
  let native: string | undefined;
  const em = a?.subscriptions?.email?.marketing;
  if (em && typeof em === 'object') {
    const c = String(em.consent ?? '').toUpperCase();
    native = c ? c.toLowerCase() : undefined;
    const sup: Json[] = Array.isArray(em.suppression) ? em.suppression : [];
    const method = [em.method, em.method_detail].filter(Boolean).join(' – ') || undefined;
    if (sup.length) {
      const reason = String(sup[0].reason ?? '').toUpperCase();
      consent = /SPAM|COMPLAIN/.test(reason) ? 'complained' : /BOUNCE|INVALID/.test(reason) ? 'bounced' : /UNSUB/.test(reason) ? 'unsubscribed' : 'blocked';
      proof.push({ basis: 'revoked', at: toIso(sup[0].timestamp), reason: SUPPRESSION[reason] ?? `gesperrt (${reason.toLowerCase() || 'Suppression'})`, method });
    } else if (c === 'UNSUBSCRIBED') {
      consent = 'unsubscribed';
      proof.push({ basis: 'revoked', at: toIso(em.consent_timestamp ?? em.last_updated), reason: 'hat sich abgemeldet', method });
    } else if (c === 'SUBSCRIBED') {
      if (em.can_receive_email_marketing === false) {
        consent = 'blocked';
        proof.push({ basis: 'revoked', at: toIso(em.last_updated), reason: 'in Klaviyo nicht mehr erreichbar (can_receive_email_marketing = false)', method });
      } else {
        consent = 'ok';
        const explicit = em.double_optin === true || EXPLICIT.test(String(em.method ?? ''));
        proof.push({ basis: explicit ? 'confirmed' : 'legacy', at: toIso(em.consent_timestamp), method: [method, em.double_optin === true ? 'Double-Opt-in bestätigt' : undefined].filter(Boolean).join(', ') || undefined });
      }
    } else if (c === 'NEVER_SUBSCRIBED') proof.push({ basis: 'none', method });
  }
  const sms = a?.subscriptions?.sms?.marketing;
  if (sms && typeof sms === 'object') {
    const c = String(sms.consent ?? '').toUpperCase();
    const method = [sms.method, sms.method_detail].filter(Boolean).join(' – ') || undefined;
    if (c === 'SUBSCRIBED') proof.push({ channel: 'sms', basis: sms.double_optin === true || EXPLICIT.test(String(sms.method ?? '')) ? 'confirmed' : 'legacy', at: toIso(sms.consent_timestamp), method });
    else if (c === 'UNSUBSCRIBED') proof.push({ channel: 'sms', basis: 'revoked', at: toIso(sms.consent_timestamp ?? sms.last_updated), reason: 'hat sich abgemeldet', method });
  }
  return { consent, native, proof };
}

const guessType = (v: unknown): FieldType => (typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'checkbox' : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(T|$)/.test(v) ? 'date' : typeof v === 'string' && /^https?:\/\/\S+$/.test(v) ? 'url' : 'text');

async function describe(h: VendorHttp, parts: PartKey[]) {
  const counts: CountRow[] = [];
  const fields: SourceField[] = [];
  const warnings: string[] = [];
  const s = stubCtx(h, parts);
  const count = counter(counts);
  if (parts.includes('contacts')) {
    await count('contacts', 'profiles', 'Profile', () => walkCount(pages(h, '/profiles/', { 'page[size]': PROFILE_PAGE, sort: 'created' }, s), COUNT_PAGES));
    await count('contacts', 'lists', 'Listen (werden zu Tags „Liste: …“)', async () => (await walkCount(pages(h, '/lists/', {}, s))).n);
    fields.push(
      { ref: 'email', label: 'E-Mail', type: 'email', std: 'email', group: 'standard' },
      { ref: 'phone_number', label: 'Telefon', type: 'phone', std: 'phone', group: 'standard' },
      { ref: 'first_name', label: 'Vorname', type: 'text', std: 'first_name', group: 'standard' },
      { ref: 'last_name', label: 'Nachname', type: 'text', std: 'last_name', group: 'standard' },
      { ref: 'organization', label: 'Firma', type: 'text', std: 'company', group: 'standard' },
      { ref: 'title', label: 'Position', type: 'text', group: 'custom' },
      { ref: 'address1', label: 'Straße', type: 'text', std: 'address', group: 'standard' },
      { ref: 'city', label: 'Ort', type: 'text', std: 'city', group: 'standard' },
      { ref: 'zip', label: 'PLZ', type: 'text', std: 'postal_code', group: 'standard' },
      { ref: 'country', label: 'Land', type: 'text', std: 'country', group: 'standard' },
      { ref: 'region', label: 'Bundesland / Region', type: 'text', group: 'custom' },
      { ref: 'locale', label: 'Sprache', type: 'text', preset: '', group: 'custom' },
      { ref: 'external_id', label: 'Externe ID', type: 'text', preset: '', group: 'custom' },
    );
    // Klaviyo has no schema for profile properties: the first profiles show which ones are in use.
    try {
      const seen = new Map<string, { type: FieldType; sample: string[] }>();
      let walked = 0;
      for await (const pg of pages(h, '/profiles/', { 'page[size]': PROFILE_PAGE, sort: 'created' }, s)) {
        for (const p of pg.items) {
          for (const [k, v] of Object.entries((p.attributes?.properties ?? {}) as Json)) {
            if (k.startsWith('$') || v === null || v === undefined || v === '') continue;
            const e = seen.get(k) ?? { type: guessType(v), sample: [] };
            if (e.sample.length < 3) e.sample.push(typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v).slice(0, 60));
            seen.set(k, e);
          }
        }
        if (++walked >= 5 || pg.next === undefined) break;
      }
      for (const [k, e] of [...seen.entries()].slice(0, 100)) fields.push({ ref: `p:${k}`, label: k, type: e.type, sample: e.sample, group: 'custom' });
      if (seen.size) warnings.push(`Eigene Profil-Eigenschaften: die ersten Profile zeigen ${seen.size} verschiedene – weitere, die erst später vorkommen, kannst du nach dem Probelauf im Bericht nachziehen.`);
    } catch (e) {
      if (!(e instanceof UmzugError && e.skippable)) throw e;
      warnings.push(`Profil-Eigenschaften nicht lesbar: ${e.message}`);
    }
  }
  if (parts.includes('segments')) await count('segments', 'segments', 'Segmente', async () => (await walkCount(pages(h, '/segments/', {}, s))).n);
  if (parts.includes('templates')) await count('templates', 'templates', 'E-Mail-Vorlagen', () => walkCount(pages(h, '/templates/', { 'page[size]': 10 }, s)));
  if (parts.includes('reference')) await count('reference', 'flows', 'Flows', async () => (await walkCount(pages(h, '/flows/', { 'page[size]': 50 }, s))).n);
  return { counts, fields, warnings };
}

const TRIGGER: Record<string, string> = { metric: 'Ereignis (Metrik)', list: 'Zu Liste hinzugefügt', segment: 'Segment betreten', 'date based': 'Datum', 'price drop': 'Preissenkung', 'low inventory': 'Niedriger Bestand', unconfigured: 'nicht eingerichtet' };
const ACTION: Record<string, string> = { SEND_EMAIL: 'E-Mail', SEND_SMS: 'SMS', SEND_PUSH: 'Push', TIME_DELAY: 'Warten', CONDITIONAL_SPLIT: 'Verzweigung', TRIGGER_SPLIT: 'Verzweigung', AB_TEST: 'A/B-Test', UPDATE_PROFILE: 'Profil ändern', WEBHOOK: 'Webhook', BACK_IN_STOCK_DELAY: 'Warten', LIST_UPDATE: 'Listen ändern', FLOW_REFERENCE: 'Flow-Verweis', NOTIFICATION: 'Benachrichtigung' };

const steps = (): StepDef[] => [
  {
    id: 'tags',
    label: 'Listen → Tags',
    part: 'contacts',
    async *run(ctx): AsyncGenerator<Batch> {
      const records: RTagRec[] = [];
      for (const pg of await everything(ctx.http, '/lists/', {}, ctx)) for (const l of pg.items) records.push({ kind: 'tag', name: `Liste: ${l.attributes?.name ?? l.id}` });
      yield { records, cursor: undefined };
    },
  },
  {
    id: 'contacts',
    label: 'Profile',
    part: 'contacts',
    async *run(ctx): AsyncGenerator<Batch> {
      for await (const pg of pages(ctx.http, '/profiles/', PROFILE_QUERY, ctx, ctx.cursor ? String(ctx.cursor) : undefined)) {
        const records: RContact[] = pg.items.map((p) => {
          const a: Json = p.attributes ?? {};
          const loc: Json = a.location ?? {};
          const values: Record<string, unknown> = { email: a.email, phone_number: a.phone_number, first_name: a.first_name, last_name: a.last_name, organization: a.organization, title: a.title, locale: a.locale, external_id: a.external_id, address1: [loc.address1, loc.address2].filter(Boolean).join(', ') || undefined, city: loc.city, zip: loc.zip, country: loc.country, region: loc.region };
          for (const [k, v] of Object.entries((a.properties ?? {}) as Json)) if (!k.startsWith('$') && v !== null && v !== undefined && v !== '') values[`p:${k}`] = v;
          const c = klaviyoConsent(a);
          return { kind: 'contact', ext: `p:${p.id}`, values, consent: c.consent, native_status: c.native, created_at: toIso(a.created), proof: c.proof.length ? c.proof : undefined };
        });
        yield { records, cursor: pg.next };
      }
    },
  },
  {
    id: 'list_members',
    label: 'Listen zuordnen',
    part: 'contacts',
    async *run(ctx): AsyncGenerator<Batch> {
      const lists = (await everything(ctx.http, '/lists/', {}, ctx)).flatMap((pg) => pg.items);
      const cur = (ctx.cursor ?? { li: 0 }) as { li: number; after?: string };
      for (let li = cur.li; li < lists.length; li++) {
        const l = lists[li];
        const tag = `Liste: ${l.attributes?.name ?? l.id}`;
        for await (const pg of pages(ctx.http, `/lists/${l.id}/profiles/`, MEMBER_QUERY, ctx, li === cur.li ? cur.after : undefined)) {
          const records: RMembership[] = pg.items.map((p) => ({ kind: 'membership', contact: `p:${p.id}`, tags: [tag] }));
          yield { records, cursor: pg.next ? { li, after: pg.next } : li + 1 < lists.length ? { li: li + 1 } : undefined };
        }
      }
    },
  },
  {
    id: 'segments',
    label: 'Segmente → Tags und Smart Lists',
    part: 'segments',
    async *run(ctx): AsyncGenerator<Batch> {
      const segs = (await everything(ctx.http, '/segments/', {}, ctx)).flatMap((pg) => pg.items);
      const cur = (ctx.cursor ?? { si: 0 }) as { si: number; after?: string };
      for (let si = cur.si; si < segs.length; si++) {
        const sg = segs[si];
        const name = String(sg.attributes?.name ?? sg.id);
        const tag = `Segment: ${name}`;
        if (si !== cur.si || !cur.after) {
          ctx.warn(`Segment „${name}“ ist in Klaviyo eine Regel: übernommen als feste Liste der aktuellen Mitglieder (Tag „${tag}“), nicht als dynamische Regel`);
          yield { records: [{ kind: 'tag', name: tag } satisfies RTagRec, { kind: 'smart_list', ext: `s:${sg.id}`, name, tag } satisfies RSmartList], cursor: { si, after: undefined } };
        }
        for await (const pg of pages(ctx.http, `/segments/${sg.id}/profiles/`, MEMBER_QUERY, ctx, si === cur.si ? cur.after : undefined)) {
          const records: RMembership[] = pg.items.map((p) => ({ kind: 'membership', contact: `p:${p.id}`, tags: [tag] }));
          yield { records, cursor: pg.next ? { si, after: pg.next } : si + 1 < segs.length ? { si: si + 1 } : undefined };
        }
      }
    },
  },
  {
    id: 'templates',
    label: 'E-Mail-Vorlagen',
    part: 'templates',
    async *run(ctx): AsyncGenerator<Batch> {
      for await (const pg of pages(ctx.http, '/templates/', { 'page[size]': 10, 'fields[template]': 'name,html,text,editor_type' }, ctx, ctx.cursor ? String(ctx.cursor) : undefined)) {
        const records: RTemplate[] = pg.items.map((t) => ({ kind: 'template', ext: `t:${t.id}`, name: String(t.attributes?.name ?? `Vorlage ${t.id}`), subject: '', html: String(t.attributes?.html ?? ''), text: t.attributes?.text ? String(t.attributes.text) : undefined }));
        for (const t of pg.items) if (!t.attributes?.html) ctx.warn(`Vorlage „${String(t.attributes?.name ?? t.id).slice(0, 60)}“ liefert kein HTML (Klaviyo-Editor) – bitte neu aufbauen`);
        yield { records, cursor: pg.next };
      }
    },
  },
  {
    id: 'flows',
    label: 'Flows → Referenzliste',
    part: 'reference',
    async *run(ctx): AsyncGenerator<Batch> {
      const rows: string[] = [];
      let n = 0;
      for await (const pg of pages(ctx.http, '/flows/', { 'page[size]': 50, include: 'flow-actions', 'fields[flow]': 'name,status,archived,trigger_type,created,updated', 'fields[flow-action]': 'action_type,status' }, ctx)) {
        const byId = new Map<string, Json>(pg.included.filter((x) => x.type === 'flow-action').map((x) => [String(x.id), x]));
        for (const f of pg.items) {
          n++;
          const a: Json = f.attributes ?? {};
          const ids: Json[] = f.relationships?.['flow-actions']?.data ?? [];
          const acts = ids.map((r) => byId.get(String(r.id))).filter(Boolean) as Json[];
          const kinds = acts.map((x) => ACTION[String(x.attributes?.action_type)] ?? String(x.attributes?.action_type ?? '?'));
          const count = (k: string) => kinds.filter((x) => x === k).length;
          const status = a.archived ? 'archiviert' : String(a.status ?? '–');
          rows.push(`| ${cell(a.name) || f.id} | ${cell(status)} | ${cell(TRIGGER[String(a.trigger_type ?? '').toLowerCase()] ?? a.trigger_type ?? '–')} | ${count('E-Mail')} E-Mail${count('E-Mail') === 1 ? '' : 's'}, ${count('SMS')} SMS, ${count('Warten')}× Warten, ${count('Verzweigung')}× Verzweigung | ${cell(kinds.join(' → ')) || '–'} |`);
        }
      }
      const body = [
        '# Flows aus Klaviyo',
        '',
        `Stand: ${new Date().toISOString().slice(0, 10)}. Diese Liste ist eine **Gedächtnisstütze**: die Schritte, Texte und Bedingungen eines Flows liefert die Klaviyo-API nicht in einer Form, aus der sich ein Workflow bauen ließe. Bau jeden aktiven Flow in HyperLevel als Workflow nach (Auslöser, E-Mails, Wartezeiten, Wenn/Sonst) und prüfe vor dem Kündigen, dass nichts fehlt.`,
        '',
        ...(rows.length ? ['| Flow | Status | Auslöser | Umfang | Ablauf |', '| --- | --- | --- | --- | --- |', ...rows] : ['_Im Konto gibt es keine Flows._']),
      ].join('\n');
      if (n) ctx.warn(`Flows: ${n} Flow${n === 1 ? '' : 's'} als Referenzliste im Wiki (Bereich „Umzug“) – nachbauen musst du sie selbst.`);
      yield { records: [{ kind: 'reference', ext: 'flows', title: 'Flows aus Klaviyo', body } satisfies RReference], cursor: undefined };
    },
  },
];

export const KLAVIYO: SourceDef = {
  key: 'klaviyo',
  label: 'Klaviyo',
  tagline: 'Profile mit Eigenschaften und Einwilligung (E-Mail und SMS), Listen, Segmente, Vorlagen und die Flow-Liste',
  credentials: [{ key: 'api_key', label: 'Privater API-Schlüssel', secret: true, placeholder: 'pk_…', hint: 'Klaviyo → Einstellungen → API Keys → „Create Private API Key“ (Lesezugriff reicht)' }],
  howto: [
    'In Klaviyo unten links auf dein Konto → „Settings“ → „API keys“.',
    'Bei „Private API Keys“ auf „Create Private API Key“, einen Namen vergeben (z. B. „Umzug“) und „Custom Key“ wählen: Lesezugriff (Read) auf Accounts, Profiles, Lists, Segments, Flows und Templates genügt.',
    'Den Schlüssel (beginnt mit pk_) hier einfügen. Nicht der „Public API Key“ – das sind nur sechs Zeichen. Nach dem Umzug löschst du den Schlüssel in Klaviyo wieder.',
  ],
  limits: [
    'Flows – sie kommen als Referenzliste ins Wiki (Auslöser, Umfang, Ablauf), nachbauen musst du sie selbst',
    'Ereignisse und Metriken (Käufe, Klicks, Öffnungen), Vorhersagen und Kundenwert',
    'Formulare, Pop-ups, Kampagnen und ihre Statistiken, Berichte',
    'Produktkatalog und Shop-Anbindungen (Shopify, WooCommerce …) – die verbindest du in HyperLevel neu',
    'Segmente als Regel: sie werden zur festen Liste der aktuellen Mitglieder',
  ],
  parts: [
    { key: 'contacts', label: 'Profile, Eigenschaften und Listen', on: true, note: 'Abgemeldete, gesperrte und unzustellbare Profile werden zu „Nicht stören“ plus Tag. Jede Liste wird zum Tag „Liste: …“. Die Einwilligung (E-Mail und SMS) geht mit Datum und Art in den Einwilligungs-Nachweis.' },
    { key: 'segments', label: 'Segmente → Tags und Smart Lists', on: true, note: 'Eine feste Liste der aktuellen Mitglieder, keine dynamische Regel.' },
    { key: 'templates', label: 'E-Mail-Vorlagen (HTML)', on: true },
    { key: 'reference', label: 'Flows → Referenzliste im Wiki', on: true, note: 'Name, Status, Auslöser und Ablauf als Gedächtnisstütze zum Nachbauen.' },
  ],
  exports: [{ key: 'contacts', label: 'Profil-Export (CSV)', accept: ['.csv'], describe: 'Listen & Segmente → Liste oder Segment öffnen → „Export“ (CSV). Ohne API fehlen Einwilligungs-Zeitpunkte, Listenzuordnung und Vorlagen.', part: 'contacts' }],
  http,
  async connect(creds, deps): Promise<Account> {
    const key = String(creds.api_key ?? '');
    if (!/^pk_/.test(key)) throw new UmzugError(400, 'Das ist nicht der private Schlüssel – er beginnt mit „pk_“ (der „Public API Key“ aus sechs Zeichen genügt nicht)');
    const h = http(creds, {}, deps);
    let id = '';
    let label = '';
    try {
      const j = await h.get('/accounts/');
      const a = Array.isArray(j?.data) ? j.data[0] : undefined;
      id = String(a?.id ?? '');
      label = String(a?.attributes?.contact_information?.organization_name ?? '');
    } catch (e) {
      // A key without the accounts scope still works for the rest: one harmless call proves it.
      if (!(e instanceof UmzugError && (e.status === 403 || e.status === 404))) throw e;
      await h.get('/lists/');
    }
    return { account: /^[A-Za-z0-9]{3,20}$/.test(id) ? id.toLowerCase() : `key-${createHash('sha256').update(key).digest('hex').slice(0, 10)}`, label: label || 'Klaviyo-Konto', meta: {} };
  },
  describe: (h, parts) => describe(h, parts),
  steps: (parts) => steps().filter((s) => parts.includes(s.part)),
};
