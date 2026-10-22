import { createHash } from 'node:crypto';
import type { Account, Batch, Consent, ConsentProof, CountRow, FieldType, PartKey, RContact, RMembership, RSmartList, RTagRec, RTemplate, SourceDef, SourceField, StdTarget, StepCtx, StepDef } from './umzug-core.js';
import { guessStd } from './umzug-core.js';
import { UmzugError, VendorHttp } from './umzug-http.js';
import { counter } from './umzug-lib.js';
import type { Json } from './umzug-flow.js';
import { toDay, toIso } from './umzug-text.js';

/**
 * Brevo (formerly Sendinblue; API v3, https://api.brevo.com/v3, header `api-key`): contacts with attributes, list membership and the
 * blocklist state (e-mail and SMS) → contacts + consent ledger (a confirmed double opt-in is told by the DOUBLE_OPT-IN attribute),
 * lists → tags, segments → tags and smart lists, SMTP templates → e-mail templates. Offset pagination: `limit` (max 1000 for contacts and
 * templates, 50 for lists and segments) + `offset`.
 */

const BASE = 'https://api.brevo.com/v3';
const PAGE = 1000;
const SMALL = 50;

const http = (creds: Record<string, string>, _meta: Record<string, string>, deps: { fetch?: any; sleep?: any; pauseMs?: number }) =>
  new VendorHttp({
    vendor: 'Brevo',
    base: BASE,
    headers: () => ({ 'api-key': creds.api_key ?? '' }),
    fetch: deps.fetch,
    sleep: deps.sleep,
    pauseMs: deps.pauseMs ?? 150,
    // Brevo says how long to wait in x-sib-ratelimit-reset (seconds); Retry-After comes first when there is one.
    retryHeaders: ['retry-after', 'x-sib-ratelimit-reset'],
    errorText: (b) => (typeof b?.message === 'string' ? b.message : typeof b?.code === 'string' ? b.code : undefined),
  });

/** Offset pages; `key` is the array's name in the response, `count` the total. The next offset is what was actually received (a server may clamp the page size). */
async function* pages(h: VendorHttp, path: string, key: string, ctx: StepCtx, query: Record<string, unknown> = {}, size = PAGE, start = 0): AsyncGenerator<{ items: any[]; next: number | undefined; total: number }> {
  for (let offset = start; ; ) {
    if (ctx.cancelled()) return;
    const j = await h.get(path, { limit: size, offset, ...query });
    const items: any[] = Array.isArray(j?.[key]) ? j[key] : [];
    const total = Number(j?.count ?? 0);
    const got = offset + items.length;
    const next = items.length > 0 && (total ? got < total : items.length >= size) ? got : undefined;
    yield { items, next, total };
    if (next === undefined) return;
    offset = next;
  }
}
async function everything(h: VendorHttp, path: string, key: string, ctx: StepCtx, query: Record<string, unknown> = {}, size = SMALL): Promise<any[]> {
  const out: any[] = [];
  for await (const pg of pages(h, path, key, ctx, query, size)) out.push(...pg.items);
  return out;
}
const total = async (h: VendorHttp, path: string, key: string, query: Record<string, unknown> = {}) => {
  const j = await h.get(path, { limit: 1, offset: 0, ...query });
  return Number(j?.count ?? (Array.isArray(j?.[key]) ? j[key].length : 0));
};

/** Default attribute names → our standard fields (Brevo calls the mobile number SMS). */
const STD_ATTR: Record<string, StdTarget> = { FIRSTNAME: 'first_name', LASTNAME: 'last_name', SMS: 'phone', COMPANY: 'company', ADDRESS: 'address', STREET: 'address', CITY: 'city', ZIP: 'postal_code', POSTCODE: 'postal_code', COUNTRY: 'country', DOB: 'date_of_birth', BIRTHDAY: 'date_of_birth', WEBSITE: 'website' };
const stdOf = (name: string): StdTarget | undefined => STD_ATTR[name.toUpperCase()] ?? guessStd(name);

const typeOf = (a: Json): FieldType => (a.type === 'float' ? 'number' : a.type === 'date' ? 'date' : a.type === 'boolean' ? 'checkbox' : a.type === 'category' ? 'select' : /^SMS$|PHONE|LANDLINE|WHATSAPP/i.test(String(a.name)) ? 'phone' : 'text');

interface Attr {
  name: string;
  def: Json;
  labels: Map<string, string>;
}
async function attributes(h: VendorHttp): Promise<Attr[]> {
  const j = await h.get('/contacts/attributes');
  return (Array.isArray(j?.attributes) ? j.attributes : [])
    .filter((a: Json) => a?.name && (a.category === 'normal' || a.category === 'category' || a.category === undefined) && a.type !== 'id')
    .map((a: Json) => ({ name: String(a.name), def: a, labels: new Map<string, string>((Array.isArray(a.enumeration) ? a.enumeration : []).map((e: Json) => [String(e.value), String(e.label)])) }));
}

const yes = (v: unknown) => v === true || /^(1|yes|ja|true)$/i.test(String(v ?? ''));

/** E-mail and SMS blocklist state + the double opt-in attribute → consent and ledger lines. */
export function brevoConsent(c: Json): { consent: Consent; native?: string; proof: ConsentProof[] } {
  const proof: ConsentProof[] = [];
  const at = toIso(c.createdAt);
  let consent: Consent = 'ok';
  let native: string | undefined;
  if (c.emailBlacklisted) {
    consent = 'blocked';
    native = 'blocklisted';
    proof.push({ basis: 'revoked', at: toIso(c.modifiedAt), reason: 'steht bei Brevo auf der Sperrliste (abgemeldet, unzustellbar oder von Hand gesperrt)' });
  } else if (c.email) {
    const doi = yes(c.attributes?.['DOUBLE_OPT-IN']);
    proof.push(doi ? { basis: 'confirmed', at, method: 'Double-Opt-in (Attribut DOUBLE_OPT-IN = Ja)', note: 'Datum = Anlage des Kontakts bei Brevo' } : { basis: 'legacy', at, method: 'Kontakt in einer Brevo-Liste' });
  } else consent = 'unknown';
  if (c.smsBlacklisted) proof.push({ channel: 'sms', basis: 'revoked', at: toIso(c.modifiedAt), reason: 'steht bei Brevo auf der SMS-Sperrliste' });
  return { consent, native, proof };
}

async function describe(h: VendorHttp, parts: PartKey[]) {
  const counts: CountRow[] = [];
  const fields: SourceField[] = [];
  const warnings: string[] = [];
  const count = counter(counts);
  if (parts.includes('contacts')) {
    await count('contacts', 'contacts', 'Kontakte', () => total(h, '/contacts', 'contacts'));
    await count('contacts', 'lists', 'Listen (werden zu Tags „Liste: …“)', () => total(h, '/contacts/lists', 'lists'));
    fields.push({ ref: 'email', label: 'E-Mail', type: 'email', std: 'email', group: 'standard' });
    try {
      for (const a of await attributes(h)) {
        const std = stdOf(a.name);
        fields.push({ ref: `a:${a.name}`, label: a.name, type: typeOf({ ...a.def, name: a.name }), std, group: std ? 'standard' : 'custom', options: a.labels.size ? [...a.labels.values()] : undefined, preset: a.name === 'DOUBLE_OPT-IN' ? '' : undefined });
      }
    } catch (e) {
      if (!(e instanceof UmzugError && e.skippable)) throw e;
      warnings.push(`Kontaktattribute nicht lesbar: ${e.message}`);
    }
  }
  if (parts.includes('segments')) await count('segments', 'segments', 'Segmente', () => total(h, '/contacts/segments', 'segments'));
  if (parts.includes('templates')) await count('templates', 'templates', 'E-Mail-Vorlagen', () => total(h, '/smtp/templates', 'templates'));
  return { counts, fields, warnings };
}

const steps = (): StepDef[] => [
  {
    id: 'tags',
    label: 'Listen → Tags',
    part: 'contacts',
    async *run(ctx): AsyncGenerator<Batch> {
      const lists = await everything(ctx.http, '/contacts/lists', 'lists', ctx);
      yield { records: lists.map((l): RTagRec => ({ kind: 'tag', name: `Liste: ${l.name ?? l.id}` })), cursor: undefined };
    },
  },
  {
    id: 'contacts',
    label: 'Kontakte',
    part: 'contacts',
    async *run(ctx): AsyncGenerator<Batch> {
      const names = new Map<string, string>((await everything(ctx.http, '/contacts/lists', 'lists', ctx)).map((l) => [String(l.id), String(l.name ?? l.id)]));
      const attrs = new Map<string, Attr>((await attributes(ctx.http).catch(() => [])).map((a) => [a.name, a]));
      for await (const pg of pages(ctx.http, '/contacts', 'contacts', ctx, { sort: 'asc' }, PAGE, Number(ctx.cursor ?? 0))) {
        const records: RContact[] = pg.items.map((c) => {
          const values: Record<string, unknown> = { email: c.email };
          for (const [k, v] of Object.entries((c.attributes ?? {}) as Json)) {
            if (v === null || v === undefined || v === '') continue;
            const a = attrs.get(k);
            values[`a:${k}`] = a?.labels.size ? (a.labels.get(String(v)) ?? v) : a?.def.type === 'date' ? (toDay(v) ?? v) : v;
          }
          const gone = new Set<string>((Array.isArray(c.listUnsubscribed) ? c.listUnsubscribed : []).map(String));
          const tags = [
            ...(Array.isArray(c.listIds) ? c.listIds : []).filter((id: unknown) => !gone.has(String(id))).map((id: unknown) => `Liste: ${names.get(String(id)) ?? id}`),
            ...[...gone].map((id) => `Abgemeldet von Liste: ${names.get(id) ?? id}`),
          ];
          const x = brevoConsent(c);
          return { kind: 'contact', ext: `c:${c.id}`, values, tags, consent: x.consent, native_status: x.native, created_at: toIso(c.createdAt), proof: x.proof.length ? x.proof : undefined };
        });
        yield { records, cursor: pg.next, total: pg.total };
      }
    },
  },
  {
    id: 'segments',
    label: 'Segmente → Tags und Smart Lists',
    part: 'segments',
    async *run(ctx): AsyncGenerator<Batch> {
      const segs = await everything(ctx.http, '/contacts/segments', 'segments', ctx);
      const cur = (ctx.cursor ?? { si: 0, off: 0 }) as { si: number; off: number };
      for (let si = cur.si; si < segs.length; si++) {
        const sg = segs[si];
        const name = String(sg.segmentName ?? sg.name ?? sg.id);
        const tag = `Segment: ${name}`;
        if (si !== cur.si || cur.off === 0) {
          ctx.warn(`Segment „${name}“ ist bei Brevo eine Regel: übernommen als feste Liste der aktuellen Mitglieder (Tag „${tag}“), nicht als dynamische Regel`);
          yield { records: [{ kind: 'tag', name: tag } satisfies RTagRec, { kind: 'smart_list', ext: `s:${sg.id}`, name, tag } satisfies RSmartList], cursor: { si, off: 0 } };
        }
        for await (const pg of pages(ctx.http, '/contacts', 'contacts', ctx, { segmentId: sg.id, sort: 'asc' }, PAGE, si === cur.si ? cur.off : 0)) {
          const records: RMembership[] = pg.items.map((c) => ({ kind: 'membership', contact: `c:${c.id}`, tags: [tag] }));
          yield { records, cursor: pg.next !== undefined ? { si, off: pg.next } : si + 1 < segs.length ? { si: si + 1, off: 0 } : undefined };
        }
      }
    },
  },
  {
    id: 'templates',
    label: 'E-Mail-Vorlagen',
    part: 'templates',
    async *run(ctx): AsyncGenerator<Batch> {
      for await (const pg of pages(ctx.http, '/smtp/templates', 'templates', ctx, { sort: 'asc' }, PAGE, Number(ctx.cursor ?? 0))) {
        const records: RTemplate[] = pg.items.map((t) => ({ kind: 'template', ext: `t:${t.id}`, name: String(t.name ?? `Vorlage ${t.id}`), subject: String(t.subject ?? ''), html: String(t.htmlContent ?? '') }));
        for (const t of pg.items) if (!t.htmlContent) ctx.warn(`Vorlage „${String(t.name ?? t.id).slice(0, 60)}“ hat bei Brevo keinen HTML-Inhalt – bitte neu aufbauen`);
        yield { records, cursor: pg.next, total: pg.total };
      }
    },
  },
];

export const BREVO: SourceDef = {
  key: 'brevo',
  label: 'Brevo',
  tagline: 'Kontakte mit Attributen, Listen, Sperrliste und Double-Opt-in, Segmente, Vorlagen',
  credentials: [{ key: 'api_key', label: 'API-Schlüssel (v3)', secret: true, placeholder: 'xkeysib-…', hint: 'Brevo → Konto (oben rechts) → „SMTP & API“ → „API-Schlüssel“ → „Neuen API-Schlüssel erstellen“' }],
  howto: [
    'In Brevo oben rechts auf deinen Namen → „SMTP & API“ → Reiter „API-Schlüssel“.',
    'Auf „Neuen API-Schlüssel erstellen“ klicken, einen Namen vergeben (z. B. „Umzug“) und den Schlüssel (beginnt mit xkeysib-) hier einfügen.',
    'Nach dem Umzug löschst du den Schlüssel dort wieder. Gelesen wird nur – in deinem Brevo-Konto ändert HyperLevel nichts.',
  ],
  limits: [
    'Gesendete Kampagnen, Statistiken und Berichte',
    'Automationen (Workflows) und Transaktionsmails – die API liefert sie nicht in einer nachbaubaren Form',
    'Anmeldeformulare und Landing Pages, Chat- und CRM-Daten von Brevo (Deals, Aufgaben)',
    'Segmente als Regel: sie werden zur festen Liste der aktuellen Mitglieder',
    'Warum jemand auf der Sperrliste steht (abgemeldet, unzustellbar, von Hand): die API unterscheidet es nicht – alle werden zu „Nicht stören“',
  ],
  parts: [
    { key: 'contacts', label: 'Kontakte, Attribute und Listen', on: true, note: 'Gesperrte Kontakte werden zu „Nicht stören“ plus Tag. Jede Liste wird zum Tag „Liste: …“. Ein bestätigtes Double-Opt-in (Attribut DOUBLE_OPT-IN) kommt als bestätigte Einwilligung in den Nachweis, alle anderen als Altbestand.' },
    { key: 'segments', label: 'Segmente → Tags und Smart Lists', on: true, note: 'Eine feste Liste der aktuellen Mitglieder, keine dynamische Regel.' },
    { key: 'templates', label: 'E-Mail-Vorlagen (HTML)', on: true },
  ],
  exports: [{ key: 'contacts', label: 'Kontakte-Export (CSV)', accept: ['.csv'], describe: 'Kontakte → „Exportieren“ (CSV). Die Spalte „EMAIL_BLACKLISTED“ bzw. „BLACKLISTED“ bestimmt, wer „Nicht stören“ bekommt.', part: 'contacts' }],
  http,
  async connect(creds, deps): Promise<Account> {
    const h = http(creds, {}, deps);
    const j = await h.get('/account');
    const email = String(j?.email ?? j?.organization?.email ?? '').toLowerCase();
    const label = String(j?.companyName ?? j?.organization?.name ?? j?.firstName ?? 'Brevo-Konto');
    // No e-mail address in the id map: a short hash tells accounts apart.
    const account = email ? `acct-${createHash('sha256').update(email).digest('hex').slice(0, 12)}` : `key-${createHash('sha256').update(String(creds.api_key ?? '')).digest('hex').slice(0, 10)}`;
    return { account, label: label.slice(0, 120), meta: {} };
  },
  describe: (h, parts) => describe(h, parts),
  steps: (parts) => steps().filter((s) => parts.includes(s.part)),
};
