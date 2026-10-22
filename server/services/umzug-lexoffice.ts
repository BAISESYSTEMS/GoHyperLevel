import type { Account, Batch, CountRow, PartKey, RActivity, RCompany, RContact, SourceDef, SourceField, StepCtx, StepDef } from './umzug-core.js';
import { documentActivity } from './umzug-crm.js';
import type { Json } from './umzug-flow.js';
import { UmzugError, VendorHttp } from './umzug-http.js';
import { counter } from './umzug-lib.js';
import { toIso } from './umzug-text.js';

/**
 * Lexware Office (formerly lexoffice; public API, https://api.lexware.io/v1, an API key): customers → contacts (a company becomes a company
 * with its contact person as contact), documents (invoices, credit notes, quotations, order confirmations, delivery notes, reminders) →
 * read-only entries in the contact's history: number, date, amount, status. They are NOT invoices of HyperLevel: they take no number of the
 * invoice ranges, are not frozen or sent, and change no bookkeeping – the originals (with their PDFs) stay at Lexware. The API allows
 * two requests a second and 25 entries per page; a 429 waits and retries.
 */

const API = 'https://api.lexware.io/v1';
const PAGE = 25;

const http = (creds: Record<string, string>, _meta: Record<string, string>, deps: { fetch?: any; sleep?: any; pauseMs?: number }) =>
  new VendorHttp({
    vendor: 'Lexware Office',
    base: API,
    headers: () => ({ authorization: `Bearer ${String(creds.token ?? '').trim()}` }),
    fetch: deps.fetch,
    sleep: deps.sleep,
    // two requests a second
    pauseMs: deps.pauseMs ?? 520,
    errorText: (b) => (typeof b?.message === 'string' ? b.message : Array.isArray(b?.IssueList) && b.IssueList[0]?.i18nKey ? String(b.IssueList[0].i18nKey) : undefined),
  });

async function* pages(h: VendorHttp, path: string, query: Record<string, unknown>, ctx: StepCtx, from = 0): AsyncGenerator<{ items: Json[]; next: number | undefined; total: number | undefined }> {
  for (let page = from; page < 100_000; page++) {
    if (ctx.cancelled()) return;
    const j = await h.get(path, { ...query, page, size: PAGE });
    const items: Json[] = Array.isArray(j?.content) ? j.content : [];
    const more = items.length > 0 && j?.last !== true && (j?.totalPages === undefined || page + 1 < Number(j.totalPages));
    yield { items, next: more ? page + 1 : undefined, total: Number.isFinite(Number(j?.totalElements)) ? Number(j.totalElements) : undefined };
    if (!more) return;
  }
}

const first = (o: Json | undefined, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = Array.isArray(o?.[k]) ? o![k].find((x: unknown) => typeof x === 'string' && x.trim()) : undefined;
    if (v) return String(v).trim();
  }
  return undefined;
};

// --- contacts ---------------------------------------------------------------------------------------------------

/** A lexoffice contact as company (when it is one) and the HyperLevel contacts that stand for it. */
export function lexofficeContacts(c: Json): { company?: RCompany; contacts: RContact[] } {
  const addr = c.addresses?.billing?.[0] ?? c.addresses?.shipping?.[0] ?? {};
  const common: Record<string, unknown> = {
    address: addr.street,
    city: addr.city,
    postal_code: addr.zip,
    country: addr.countryCode,
    customer_number: c.roles?.customer?.number !== undefined ? String(c.roles.customer.number) : undefined,
    note: c.note,
  };
  const orgName = c.company?.name ? String(c.company.name) : undefined;
  const companyMail = first(c.emailAddresses, 'business', 'office', 'private', 'other');
  const companyPhone = first(c.phoneNumbers, 'business', 'office', 'mobile', 'private', 'other');
  const mk = (ext: string, v: Record<string, unknown>): RContact => {
    return { kind: 'contact', ext, values: { ...common, company: orgName, tax_number: c.company?.taxNumber, vat_id: c.company?.vatRegistrationId, ...v }, consent: 'unknown', org: orgName ? `co:${c.id}` : undefined, org_name: orgName, proof: [{ basis: 'none', method: 'Kunde in Lexware Office (Lexware kennt keine Werbeeinwilligung)', channel: 'email' }] };
  };
  if (orgName) {
    const persons: Json[] = Array.isArray(c.company?.contactPersons) ? c.company.contactPersons : [];
    // the primary person (else the first) is the contact the documents are filed under
    const main = persons.find((p) => p.primary) ?? persons[0];
    const rest = persons.filter((p) => p !== main);
    const contacts: RContact[] = [];
    contacts.push(main ? mk(`c:${c.id}`, { first_name: main.firstName, last_name: main.lastName || orgName, email: main.emailAddress ?? companyMail, phone: main.phoneNumber ?? companyPhone }) : mk(`c:${c.id}`, { last_name: orgName, email: companyMail, phone: companyPhone }));
    rest.forEach((p, i) => {
      if (p.emailAddress || p.firstName || p.lastName) contacts.push(mk(`c:${c.id}:${i + 1}`, { first_name: p.firstName, last_name: p.lastName, email: p.emailAddress, phone: p.phoneNumber, note: undefined, customer_number: common.customer_number }));
    });
    return {
      company: { kind: 'company', ext: `co:${c.id}`, name: orgName, address: addr.street, city: addr.city, postal_code: addr.zip, country: addr.countryCode, phone: companyPhone },
      contacts,
    };
  }
  const p = c.person ?? {};
  return { contacts: [mk(`c:${c.id}`, { first_name: p.firstName, last_name: p.lastName, email: first(c.emailAddresses, 'private', 'business', 'office', 'other'), phone: first(c.phoneNumbers, 'mobile', 'private', 'business', 'office', 'other') })] };
}

// --- documents --------------------------------------------------------------------------------------------------

const TYPE: Record<string, string> = { invoice: 'Rechnung', creditnote: 'Gutschrift', quotation: 'Angebot', orderconfirmation: 'Auftragsbestätigung', deliverynote: 'Lieferschein', downpaymentinvoice: 'Abschlagsrechnung', dunning: 'Mahnung' };
const STATUS: Record<string, string> = { open: 'offen', paid: 'bezahlt', paidoff: 'ausgeglichen', voided: 'storniert', overdue: 'überfällig', accepted: 'angenommen', rejected: 'abgelehnt', sepadebit: 'per Lastschrift', transferred: 'überwiesen' };
const VOUCHER_TYPES = Object.keys(TYPE).join(',');
// Drafts are no documents yet: they are not read.
const VOUCHER_STATUS = Object.keys(STATUS).join(',');

export function lexofficeDocument(v: Json): RActivity | undefined {
  if (!v?.id || !v?.contactId) return undefined;
  const type = String(v.voucherType ?? '').toLowerCase();
  return documentActivity({
    vendor: 'Lexware Office',
    ext: `v:${v.id}`,
    contact: `c:${v.contactId}`,
    label: TYPE[type] ?? String(v.voucherType ?? 'Beleg'),
    number: v.voucherNumber ? String(v.voucherNumber) : undefined,
    date: toIso(v.voucherDate)?.slice(0, 10),
    due: toIso(v.dueDate)?.slice(0, 10),
    status: STATUS[String(v.voucherStatus ?? '').toLowerCase()] ?? (v.voucherStatus ? String(v.voucherStatus) : undefined),
    total: v.totalAmount === undefined ? undefined : Number(v.totalAmount),
    open: v.openAmount === undefined ? undefined : Number(v.openAmount),
    currency: v.currency,
    contactName: v.contactName,
  });
}

// --- steps ------------------------------------------------------------------------------------------------------

const steps = (): StepDef[] => [
  {
    id: 'contacts',
    label: 'Kunden → Kontakte und Firmen',
    part: 'contacts',
    async *run(ctx): AsyncGenerator<Batch> {
      for await (const pg of pages(ctx.http, '/contacts', { customer: true, sort: 'createdDate,ASC' }, ctx, Number(ctx.cursor) || 0)) {
        const records: (RCompany | RContact)[] = [];
        for (const c of pg.items.filter((x) => !x.archived)) {
          const x = lexofficeContacts(c);
          if (x.company) records.push(x.company);
          records.push(...x.contacts);
        }
        yield { records, cursor: pg.next, total: pg.total };
      }
    },
  },
  {
    id: 'documents',
    label: 'Belege → Verlauf der Kontakte',
    part: 'documents',
    async *run(ctx): AsyncGenerator<Batch> {
      for await (const pg of pages(ctx.http, '/voucherlist', { voucherType: VOUCHER_TYPES, voucherStatus: VOUCHER_STATUS, archived: false, sort: 'voucherDate,ASC' }, ctx, Number(ctx.cursor) || 0)) {
        const records = pg.items.map(lexofficeDocument).filter((x): x is RActivity => !!x);
        yield { records, cursor: pg.next, total: pg.total };
      }
    },
  },
];

// --- describe ---------------------------------------------------------------------------------------------------

const FIELDS: SourceField[] = [
  { ref: 'email', label: 'E-Mail', type: 'email', std: 'email', group: 'standard' },
  { ref: 'first_name', label: 'Vorname', type: 'text', std: 'first_name', group: 'standard' },
  { ref: 'last_name', label: 'Nachname', type: 'text', std: 'last_name', group: 'standard' },
  { ref: 'phone', label: 'Telefon', type: 'phone', std: 'phone', group: 'standard' },
  { ref: 'company', label: 'Firma', type: 'text', std: 'company', group: 'standard' },
  { ref: 'address', label: 'Straße', type: 'text', std: 'address', group: 'standard' },
  { ref: 'city', label: 'Ort', type: 'text', std: 'city', group: 'standard' },
  { ref: 'postal_code', label: 'PLZ', type: 'text', std: 'postal_code', group: 'standard' },
  { ref: 'country', label: 'Land', type: 'text', std: 'country', group: 'standard' },
  { ref: 'customer_number', label: 'Kundennummer', type: 'text', group: 'custom' },
  { ref: 'tax_number', label: 'Steuernummer', type: 'text', group: 'custom' },
  { ref: 'vat_id', label: 'USt-IdNr.', type: 'text', group: 'custom' },
  { ref: 'note', label: 'Notiz', type: 'textarea', preset: 'note', group: 'custom' },
];

async function describe(h: VendorHttp, parts: PartKey[]) {
  const counts: CountRow[] = [];
  const warnings: string[] = [];
  const count = counter(counts);
  const totalOf = async (path: string, query: Record<string, unknown>) => Number((await h.get(path, { ...query, page: 0, size: 1 }))?.totalElements ?? 0);
  if (parts.includes('contacts')) await count('contacts', 'contacts', 'Kunden (Lieferanten werden nicht übernommen)', () => totalOf('/contacts', { customer: true }));
  if (parts.includes('documents')) {
    await count('documents', 'documents', 'Belege (Rechnungen, Gutschriften, Angebote …, ohne Entwürfe)', () => totalOf('/voucherlist', { voucherType: VOUCHER_TYPES, voucherStatus: VOUCHER_STATUS, archived: false }));
    warnings.push('Die Belege kommen nur als Eintrag im Verlauf des Kontakts (Nummer, Datum, Betrag, Status) – nicht als Rechnungen in HyperLevel: Sie vergeben keine Rechnungsnummer, werden nicht festgeschrieben und ändern die Buchhaltung nicht. Die Originale mit PDF bleiben bei Lexware – vor dem Kündigen alles exportieren (Aufbewahrungspflicht: 8 bzw. 10 Jahre).');
  }
  if (parts.includes('contacts') || parts.includes('documents')) warnings.push('Lexware Office erlaubt zwei Anfragen pro Sekunde und 25 Einträge pro Seite – bei vielen Belegen dauert der Umzug entsprechend; er lässt sich pausieren und fortsetzen.');
  return { counts, fields: parts.includes('contacts') ? FIELDS : [], warnings };
}

export const LEXOFFICE: SourceDef = {
  key: 'lexoffice',
  label: 'Lexware Office (lexoffice)',
  tagline: 'Kunden als Kontakte und Firmen, Belege als Verlauf der Kontakte',
  credentials: [{ key: 'token', label: 'API-Schlüssel', secret: true, placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', hint: 'Lexware Office → Einstellungen → Öffentliche API (app.lexware.de/addons/public-api) → „Schlüssel erstellen“' }],
  howto: [
    'In Lexware Office (lexoffice) unter app.lexware.de/addons/public-api einen neuen API-Schlüssel erstellen und kopieren.',
    'Den Schlüssel hier einfügen. HyperLevel liest nur und ändert bei Lexware nichts.',
    'Nach dem Umzug den Schlüssel bei Lexware löschen. Wichtig: Rechnungen und Belege müssen gesetzlich 8 bzw. 10 Jahre aufbewahrt werden – exportiere sie (z. B. über den DATEV-Export oder die PDFs) und behalte den Zugang zur Buchhaltung, bevor du kündigst.',
  ],
  limits: [
    'Rechnungen, Gutschriften und alle anderen Belege kommen NICHT als Rechnungen in HyperLevel, sondern nur als Verlaufseintrag am Kontakt (Nummer, Datum, Betrag, Status) – ohne PDF, ohne Positionen, ohne Rechnungsnummer im Nummernkreis von HyperLevel',
    'Die Buchhaltung selbst: Belege der Lieferanten, Buchungen, Zahlungen, Konten, Umsatzsteuer-Voranmeldungen und Kassenbuch',
    'Artikel und Dienstleistungen, Dokumentvorlagen, wiederkehrende Rechnungen und Zahlungsbedingungen',
    'Lieferanten (nur Kunden werden übernommen) und archivierte Kontakte; Entwürfe von Belegen',
    'Lexware kennt keine Werbeeinwilligung: Kunden sind im Einwilligungs-Nachweis „ohne Werbeeinwilligung“ vermerkt – Rechnungen und Service gehen, Newsletter erst nach einer neuen Einwilligung',
  ],
  parts: [
    { key: 'contacts', label: 'Kunden → Kontakte und Firmen', on: true, note: 'Eine Firma wird Firma mit ihrer Hauptansprechperson als Kontakt (weitere Personen als weitere Kontakte); Kundennummer, Steuernummer und USt-IdNr. kommen als Felder mit.' },
    { key: 'documents', label: 'Belege → Verlauf der Kontakte (nur zur Ansicht)', on: true, note: 'Rechnungen, Gutschriften, Angebote, Auftragsbestätigungen, Lieferscheine und Mahnungen als Eintrag im Verlauf. Dazu gehört der Teil „Kunden“ (jetzt oder aus einem früheren Umzug).' },
  ],
  exports: [],
  http,
  async connect(creds, deps): Promise<Account> {
    const h = http(creds, {}, deps);
    const p = await h.get('/profile');
    if (!p?.organizationId) throw new UmzugError(401, 'Lexware Office: Zugangsdaten ungültig oder abgelaufen');
    return { account: `lx-${p.organizationId}`, label: String(p.companyName ?? 'Lexware Office'), meta: {} };
  },
  describe: (h, parts) => describe(h, parts),
  steps: (parts) => steps().filter((s) => parts.includes(s.part)),
};
