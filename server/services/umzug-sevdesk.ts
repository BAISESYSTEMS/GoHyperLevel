import type { Account, Batch, CountRow, PartKey, RActivity, RCompany, RContact, SourceDef, SourceField, StepCtx, StepDef } from './umzug-core.js';
import { documentActivity } from './umzug-crm.js';
import type { Json } from './umzug-flow.js';
import { UmzugError, VendorHttp } from './umzug-http.js';
import { counter } from './umzug-lib.js';
import { toIso } from './umzug-text.js';

/**
 * sevDesk (REST API v1, https://my.sevdesk.de/api/v1, the account's API token): customers and prospects → contacts (an organisation
 * becomes a company and a contact of its own, its persons become contacts linked to it), invoices, credit notes, quotations, order
 * confirmations and delivery notes → read-only entries in the contact's history: number, date, amount, status. They are NOT invoices of
 * HyperLevel: they take no number of the invoice ranges, are not frozen or sent, and change no bookkeeping – the originals stay at sevDesk.
 * Pages by `limit` and `offset` (read until an empty page).
 */

const API = 'https://my.sevdesk.de/api/v1';
const PAGE = 100;
/** Contact categories of sevDesk: 2 supplier, 3 customer, 4 partner, 28 prospect. */
const SUPPLIER = '2';
const PROSPECT = '28';

const http = (creds: Record<string, string>, _meta: Record<string, string>, deps: { fetch?: any; sleep?: any; pauseMs?: number }) =>
  new VendorHttp({
    vendor: 'sevDesk',
    base: API,
    headers: () => ({ authorization: String(creds.token ?? '').trim() }),
    fetch: deps.fetch,
    sleep: deps.sleep,
    pauseMs: deps.pauseMs ?? 350,
    errorText: (b) => (typeof b?.error?.message === 'string' ? b.error.message : typeof b?.message === 'string' ? b.message : undefined),
  });

async function* paged(h: VendorHttp, path: string, query: Record<string, unknown>, ctx: StepCtx, from = 0): AsyncGenerator<{ items: Json[]; next: number | undefined }> {
  let offset = from;
  for (let i = 0; i < 100_000; i++) {
    if (ctx.cancelled()) return;
    const j = await h.get(path, { ...query, limit: PAGE, offset });
    const items: Json[] = Array.isArray(j?.objects) ? j.objects : [];
    if (!items.length) return;
    // The next page starts after what was received (a server may send fewer than asked for).
    offset += items.length;
    yield { items, next: offset };
  }
}

// --- contacts ---------------------------------------------------------------------------------------------------

interface Ways {
  emails: string[];
  phones: string[];
  address?: Json;
}

/** E-mail addresses and phone numbers per contact (the main one first) and the first address. */
async function waysOf(h: VendorHttp, ctx: StepCtx): Promise<Map<string, Ways>> {
  const out = new Map<string, Ways>();
  const get = (id: string) => out.get(id) ?? (out.set(id, { emails: [], phones: [] }), out.get(id)!);
  const rows: { id: string; type: string; value: string; main: boolean }[] = [];
  for await (const pg of paged(h, '/CommunicationWay', {}, ctx)) for (const w of pg.items) if (w.contact?.id && w.value) rows.push({ id: String(w.contact.id), type: String(w.type), value: String(w.value).trim(), main: String(w.main) === '1' || w.main === true });
  rows.sort((a, b) => Number(b.main) - Number(a.main));
  for (const r of rows) {
    if (r.type === 'EMAIL') get(r.id).emails.push(r.value);
    else if (r.type === 'PHONE' || r.type === 'MOBILE') get(r.id).phones.push(r.value);
  }
  try {
    for await (const pg of paged(h, '/ContactAddress', {}, ctx)) for (const a of pg.items) if (a.contact?.id && !get(String(a.contact.id)).address) get(String(a.contact.id)).address = a;
  } catch (e) {
    if (!(e instanceof UmzugError && e.skippable)) throw e;
  }
  return out;
}

export function sevdeskContact(c: Json, ways: Ways | undefined): { company?: RCompany; contact: RContact } | undefined {
  const cat = String(c.category?.id ?? '');
  if (cat === SUPPLIER) return undefined;
  const orgName = c.name ? String(c.name).trim() : '';
  const addr = ways?.address ?? {};
  const base: Record<string, unknown> = {
    email: ways?.emails[0],
    phone: ways?.phones[0],
    address: addr.street,
    city: addr.city,
    postal_code: addr.zip,
    customer_number: c.customerNumber || undefined,
    vat_id: c.vatNumber || undefined,
    tax_number: c.taxNumber || undefined,
    note: c.description || undefined,
  };
  const parent = c.parent?.id ? String(c.parent.id) : undefined;
  const values = orgName ? { ...base, last_name: orgName, company: orgName } : { ...base, first_name: c.surename, last_name: c.familyname || c.surename };
  const rec: RContact = {
    kind: 'contact',
    ext: `c:${c.id}`,
    values,
    tags: cat === PROSPECT ? ['Interessent'] : undefined,
    consent: 'unknown',
    created_at: toIso(c.create),
    org: orgName ? `co:${c.id}` : parent ? `co:${parent}` : undefined,
    org_name: orgName || undefined,
    proof: [{ basis: 'none', method: 'Kontakt in sevDesk (sevDesk kennt keine Werbeeinwilligung)', channel: 'email' }],
  };
  return { company: orgName ? { kind: 'company', ext: `co:${c.id}`, name: orgName, address: addr.street, city: addr.city, postal_code: addr.zip, phone: ways?.phones[0], website: undefined } : undefined, contact: rec };
}

// --- documents --------------------------------------------------------------------------------------------------

const INVOICE_TYPE: Record<string, string> = { RE: 'Rechnung', WKR: 'Wiederkehrende Rechnung', SR: 'Stornorechnung', MA: 'Mahnung', TR: 'Teilrechnung', AR: 'Abschlagsrechnung', ER: 'Schlussrechnung' };
const ORDER_TYPE: Record<string, string> = { AN: 'Angebot', AB: 'Auftragsbestätigung', LI: 'Lieferschein' };
const PAY_STATUS: Record<string, string> = { '200': 'offen', '750': 'teilweise bezahlt', '1000': 'bezahlt' };
const ORDER_STATUS: Record<string, string> = { '200': 'versendet', '300': 'abgelehnt', '500': 'angenommen', '750': 'teilweise abgerechnet', '1000': 'abgerechnet' };

export const SEVDESK_KINDS = [
  { id: 'inv', path: '/Invoice', numberKey: 'invoiceNumber', dateKey: 'invoiceDate', label: (o: Json) => INVOICE_TYPE[String(o.invoiceType)] ?? 'Rechnung', status: (o: Json) => PAY_STATUS[String(o.status)] },
  { id: 'cn', path: '/CreditNote', numberKey: 'creditNoteNumber', dateKey: 'creditNoteDate', label: () => 'Gutschrift', status: (o: Json) => PAY_STATUS[String(o.status)] },
  { id: 'ord', path: '/Order', numberKey: 'orderNumber', dateKey: 'orderDate', label: (o: Json) => ORDER_TYPE[String(o.orderType)] ?? 'Auftrag', status: (o: Json) => ORDER_STATUS[String(o.status)] },
] as const;

const day = (v: unknown) => toIso(v)?.slice(0, 10);
const addDays = (ymd: string | undefined, n: number) => (ymd && Number.isFinite(n) && n > 0 ? new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10) : undefined);

export function sevdeskDocument(kind: (typeof SEVDESK_KINDS)[number], o: Json): RActivity | undefined {
  // Drafts (100) and deactivated recurring invoices (50) are no documents yet.
  if (!o?.id || !o?.contact?.id || ['50', '100'].includes(String(o.status))) return undefined;
  const date = day(o[kind.dateKey]);
  const total = o.sumGross === undefined || o.sumGross === '' ? undefined : Number(o.sumGross);
  const paid = o.paidAmount === undefined ? undefined : Number(o.paidAmount);
  return documentActivity({
    vendor: 'sevDesk',
    ext: `${kind.id}:${o.id}`,
    contact: `c:${o.contact.id}`,
    label: kind.label(o),
    number: o[kind.numberKey] ? String(o[kind.numberKey]) : undefined,
    date,
    due: kind.id === 'inv' ? addDays(date, Number(o.timeToPay)) : undefined,
    status: kind.status(o),
    total,
    open: total !== undefined && paid !== undefined && Number.isFinite(paid) && String(o.status) !== '1000' ? Math.max(0, Math.round((total - paid) * 100) / 100) : undefined,
    currency: o.currency || undefined,
  });
}

// --- steps ------------------------------------------------------------------------------------------------------

const steps = (): StepDef[] => [
  {
    id: 'contacts',
    label: 'Kunden und Interessenten → Kontakte und Firmen',
    part: 'contacts',
    async *run(ctx): AsyncGenerator<Batch> {
      const ways = await waysOf(ctx.http, ctx);
      const resume = ctx.cursor as { phase?: 'orgs' | 'persons'; offset?: number } | undefined;
      // Organisations first (all of them), then the persons, so every person can be linked to its company.
      for (const phase of ['orgs', 'persons'] as const) {
        if (resume?.phase === 'persons' && phase === 'orgs') continue;
        const from = resume?.phase === phase ? (resume.offset ?? 0) : 0;
        for await (const pg of paged(ctx.http, '/Contact', { depth: phase === 'orgs' ? 0 : 1 }, ctx, from)) {
          const records: (RCompany | RContact)[] = [];
          for (const c of pg.items) {
            const isOrg = !!String(c.name ?? '').trim();
            if (isOrg !== (phase === 'orgs')) continue;
            const x = sevdeskContact(c, ways.get(String(c.id)));
            if (!x) continue;
            if (x.company) records.push(x.company);
            records.push(x.contact);
          }
          yield { records, cursor: { phase, offset: pg.next } };
        }
        if (phase === 'orgs') yield { records: [], cursor: { phase: 'persons', offset: 0 } };
      }
    },
  },
  {
    id: 'documents',
    label: 'Belege → Verlauf der Kontakte',
    part: 'documents',
    async *run(ctx): AsyncGenerator<Batch> {
      const resume = ctx.cursor as { kind?: string; offset?: number } | undefined;
      let skipping = !!resume?.kind;
      for (const kind of SEVDESK_KINDS) {
        let from = 0;
        if (skipping) {
          if (kind.id !== resume!.kind) continue;
          skipping = false;
          from = resume!.offset ?? 0;
        }
        for await (const pg of paged(ctx.http, kind.path, {}, ctx, from)) {
          const records = pg.items.map((o) => sevdeskDocument(kind, o)).filter((x): x is RActivity => !!x);
          yield { records, cursor: { kind: kind.id, offset: pg.next } };
        }
        // the next kind starts from its beginning
        const next = SEVDESK_KINDS[SEVDESK_KINDS.indexOf(kind) + 1];
        if (next) yield { records: [], cursor: { kind: next.id, offset: 0 } };
      }
    },
  },
];

// --- describe ---------------------------------------------------------------------------------------------------

const FIELDS: SourceField[] = [
  { ref: 'email', label: 'E-Mail', type: 'email', std: 'email', group: 'standard' },
  { ref: 'first_name', label: 'Vorname', type: 'text', std: 'first_name', group: 'standard' },
  { ref: 'last_name', label: 'Nachname (bei Organisationen: Name)', type: 'text', std: 'last_name', group: 'standard' },
  { ref: 'phone', label: 'Telefon', type: 'phone', std: 'phone', group: 'standard' },
  { ref: 'company', label: 'Firma', type: 'text', std: 'company', group: 'standard' },
  { ref: 'address', label: 'Straße', type: 'text', std: 'address', group: 'standard' },
  { ref: 'city', label: 'Ort', type: 'text', std: 'city', group: 'standard' },
  { ref: 'postal_code', label: 'PLZ', type: 'text', std: 'postal_code', group: 'standard' },
  { ref: 'customer_number', label: 'Kundennummer', type: 'text', group: 'custom' },
  { ref: 'tax_number', label: 'Steuernummer', type: 'text', group: 'custom' },
  { ref: 'vat_id', label: 'USt-IdNr.', type: 'text', group: 'custom' },
  { ref: 'note', label: 'Beschreibung', type: 'textarea', preset: 'note', group: 'custom' },
];

async function describe(h: VendorHttp, parts: PartKey[]) {
  const counts: CountRow[] = [];
  const warnings: string[] = [];
  const count = counter(counts);
  const totalOf = async (path: string, query: Record<string, unknown> = {}) => {
    const j = await h.get(path, { ...query, limit: 1, countAll: true });
    return Number.isFinite(Number(j?.total)) ? Number(j.total) : Array.isArray(j?.objects) ? j.objects.length : 0;
  };
  if (parts.includes('contacts')) await count('contacts', 'contacts', 'Kontakte (Organisationen und Personen; Lieferanten werden nicht übernommen)', () => totalOf('/Contact', { depth: 1 }));
  if (parts.includes('documents')) {
    await count('documents', 'invoices', 'Rechnungen (mit Entwürfen)', () => totalOf('/Invoice'));
    await count('documents', 'credit_notes', 'Gutschriften (mit Entwürfen)', () => totalOf('/CreditNote'));
    await count('documents', 'orders', 'Angebote, Auftragsbestätigungen und Lieferscheine (mit Entwürfen)', () => totalOf('/Order'));
    warnings.push('Die Belege kommen nur als Eintrag im Verlauf des Kontakts (Nummer, Datum, Betrag, Status) – nicht als Rechnungen in HyperLevel: Sie vergeben keine Rechnungsnummer, werden nicht festgeschrieben und ändern die Buchhaltung nicht. Die Originale mit PDF bleiben bei sevDesk – vor dem Kündigen alles exportieren (Aufbewahrungspflicht: 8 bzw. 10 Jahre). Entwürfe werden nicht übernommen.');
  }
  return { counts, fields: parts.includes('contacts') ? FIELDS : [], warnings };
}

export const SEVDESK: SourceDef = {
  key: 'sevdesk',
  label: 'sevDesk',
  tagline: 'Kunden als Kontakte und Firmen, Belege als Verlauf der Kontakte',
  credentials: [{ key: 'token', label: 'API-Token', secret: true, placeholder: '32 Zeichen', hint: 'sevDesk → Einstellungen → Benutzer → dein Benutzer → „API-Token“ (nur Administratoren sehen ihn)' }],
  howto: [
    'In sevDesk unter Einstellungen → Benutzer deinen Benutzer öffnen: dort steht der API-Token (32 Zeichen, nur für Administratoren sichtbar).',
    'Den Token hier einfügen. HyperLevel liest nur und ändert bei sevDesk nichts.',
    'Nach dem Umzug den Token bei sevDesk neu erzeugen. Wichtig: Rechnungen und Belege müssen gesetzlich 8 bzw. 10 Jahre aufbewahrt werden – exportiere sie (PDFs, DATEV-Export) und behalte den Zugang zur Buchhaltung, bevor du kündigst.',
  ],
  limits: [
    'Rechnungen, Gutschriften und alle anderen Belege kommen NICHT als Rechnungen in HyperLevel, sondern nur als Verlaufseintrag am Kontakt (Nummer, Datum, Betrag, Status) – ohne PDF, ohne Positionen, ohne Rechnungsnummer im Nummernkreis von HyperLevel',
    'Die Buchhaltung selbst: Belege der Lieferanten, Buchungen, Bankkonten und Transaktionen, Umsatzsteuer, Kassenbuch und Mahnwesen',
    'Produkte und Artikel, Vorlagen, wiederkehrende Rechnungen, Tags und eigene Kategorien; Entwürfe von Belegen',
    'Lieferanten (nur Kunden und Interessenten werden übernommen)',
    'sevDesk kennt keine Werbeeinwilligung: Kunden sind im Einwilligungs-Nachweis „ohne Werbeeinwilligung“ vermerkt – Rechnungen und Service gehen, Newsletter erst nach einer neuen Einwilligung',
  ],
  parts: [
    { key: 'contacts', label: 'Kunden und Interessenten → Kontakte und Firmen', on: true, note: 'Eine Organisation wird Firma und Kontakt, ihre Personen werden Kontakte der Firma; Interessenten bekommen den Tag „Interessent“. Kundennummer, Steuernummer und USt-IdNr. kommen als Felder mit.' },
    { key: 'documents', label: 'Belege → Verlauf der Kontakte (nur zur Ansicht)', on: true, note: 'Rechnungen, Gutschriften, Angebote, Auftragsbestätigungen und Lieferscheine als Eintrag im Verlauf. Dazu gehört der Teil „Kunden“ (jetzt oder aus einem früheren Umzug).' },
  ],
  exports: [],
  http,
  async connect(creds, deps): Promise<Account> {
    const h = http(creds, {}, deps);
    const j = await h.get('/Contact', { limit: 1, depth: 1 });
    // Every object names the client (the account) it belongs to – a stable, non-secret key.
    const client = j?.objects?.[0]?.sevClient?.id ?? (await h.get('/Invoice', { limit: 1 }))?.objects?.[0]?.sevClient?.id;
    return { account: client ? `sd-${client}` : 'sd-konto', label: client ? `sevDesk (Mandant ${client})` : 'sevDesk', meta: {} };
  },
  describe: (h, parts) => describe(h, parts),
  steps: (parts) => steps().filter((s) => parts.includes(s.part)),
};
