import type { RouteDoc } from './openapi.js';

/** OpenAPI entries of the SEPA module (docs/sepa.md) – spread into ROUTE_DOCS of services/openapi.ts. */

const T = 'SEPA';
const str = (description?: string, extra: Record<string, unknown> = {}) => ({ type: 'string', ...(description ? { description } : {}), ...extra });
const int = (description?: string) => ({ type: 'integer', ...(description ? { description } : {}) });
const bool = (description?: string) => ({ type: 'boolean', ...(description ? { description } : {}) });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const arr = (items: unknown) => ({ type: 'array', items });
const q = (name: string, description: string) => ({ name, in: 'query' as const, description, schema: { type: 'string' } });

export const SEPA_DOCS: RouteDoc[] = [
  { method: 'get', path: '/api/sepa/overview', tag: T, summary: 'Überblick: Gläubiger-ID/Konto bereit?, Mandate, einziehbare Rechnungen, offene und zurückgegebene Lastschriften' },
  { method: 'get', path: '/api/sepa/settings', tag: T, summary: 'SEPA-Einstellungen, wirksame Gläubigerdaten und Rückgabegründe' },
  {
    method: 'put',
    path: '/api/sepa/settings',
    tag: T,
    summary: 'Gläubiger-ID (mit Prüfziffern), Empfängerkonto, Vorlauf der Vorabankündigung (1–60 Tage, Standard 14), Texte, Präfix der Mandatsreferenz',
    body: obj({ creditor_id: str(), creditor_name: str(), iban: str(), bic: str(), prenotify_days: int(), prenotify_email: bool(), prenotify_subject: str(), prenotify_body: str(), mandate_prefix: str(), batch_booking: bool(), capture_days: int(), default_scheme: str(undefined, { enum: ['CORE', 'B2B'] }), return_fee_cents: int() }),
  },
  { method: 'get', path: '/api/sepa/mandates', tag: T, summary: 'Mandate (IBAN maskiert)', query: [q('status', 'pending | active | suspended | ended'), q('contact_id', 'Kontakt'), q('q', 'Suche (Referenz, Inhaber, Kontakt)')] },
  {
    method: 'post',
    path: '/api/sepa/mandates',
    tag: T,
    summary: 'Papier-Mandat erfassen (sofort aktiv)',
    body: obj({ contact_id: str(), holder: str(), iban: str(), bic: str('Pflicht außerhalb des EWR'), signed_at: str('JJJJ-MM-TT'), signed_place: str(), scheme: str(undefined, { enum: ['CORE', 'B2B'] }), kind: str(undefined, { enum: ['RCUR', 'OOFF'] }), reference: str('leer = automatisch'), street: str(), postal_code: str(), city: str(), country: str() }, ['contact_id', 'holder', 'iban', 'signed_at']),
  },
  { method: 'post', path: '/api/sepa/mandates/request', tag: T, summary: 'Online-Mandat anfordern: Link zur Mandatsseite (optional per E-Mail)', body: obj({ contact_id: str(), scheme: str(undefined, { enum: ['CORE', 'B2B'] }), kind: str(undefined, { enum: ['RCUR', 'OOFF'] }), send: bool('Link per E-Mail an den Kontakt') }, ['contact_id']) },
  { method: 'get', path: '/api/sepa/mandates/{id}', tag: T, summary: 'Mandat mit voller IBAN, Text, Nachweis und Einzügen' },
  { method: 'patch', path: '/api/sepa/mandates/{id}', tag: T, summary: 'Notiz, „nächster Einzug ist der letzte“ (FNAL), vor dem ersten Einzug Inhaber/BIC', body: obj({ note: str(), final_next: bool(), holder: str(), bic: str() }) },
  { method: 'post', path: '/api/sepa/mandates/{id}/revoke', tag: T, summary: 'Mandat widerrufen', body: obj({ reason: str() }) },
  { method: 'post', path: '/api/sepa/mandates/{id}/reactivate', tag: T, summary: 'Gesperrtes Mandat wieder freigeben' },
  { method: 'post', path: '/api/sepa/mandates/{id}/link', tag: T, summary: 'Neuen Link für ein offenes Online-Mandat (der alte gilt nicht mehr)', body: obj({ send: bool() }) },
  { method: 'get', path: '/api/sepa/candidates', tag: T, summary: 'Einziehbare Rechnungen (festgeschrieben, offen, EUR, Kontakt mit aktivem Mandat) mit Sequenztyp' },
  { method: 'post', path: '/api/sepa/runs/preview', tag: T, summary: 'Vorschau eines Laufs: Gruppen je Sequenztyp, Summen, Fehler, frühestes Fälligkeitsdatum', body: obj({ invoice_ids: arr(str()), collection_date: str('JJJJ-MM-TT') }, ['invoice_ids']) },
  { method: 'post', path: '/api/sepa/runs', tag: T, summary: 'Lastschrift-Lauf anlegen und Vorabankündigungen senden', body: obj({ invoice_ids: arr(str()), collection_date: str('JJJJ-MM-TT'), notify: bool('false = Vorabankündigung anders zugestellt') }, ['invoice_ids', 'collection_date']) },
  { method: 'get', path: '/api/sepa/runs', tag: T, summary: 'Läufe (Verlauf)', query: [q('kind', 'debit | transfer')] },
  { method: 'get', path: '/api/sepa/runs/{id}', tag: T, summary: 'Lauf mit Posten' },
  { method: 'get', path: '/api/sepa/runs/{id}/xml', tag: T, summary: 'SEPA-Datei herunterladen (pain.008.001.08 bzw. pain.001.001.09)' },
  { method: 'post', path: '/api/sepa/runs/{id}/submit', tag: T, summary: 'Einreichen: XML erzeugen, Rechnungen „Lastschrift eingereicht“, FRST → RCUR' },
  { method: 'post', path: '/api/sepa/runs/{id}/notify', tag: T, summary: 'Vorabankündigung erneut senden (Entwurf)' },
  { method: 'post', path: '/api/sepa/runs/{id}/cancel', tag: T, summary: 'Lauf verwerfen (Entwurf) oder zurückziehen (Datei von der Bank abgelehnt)', body: obj({ reason: str() }) },
  { method: 'post', path: '/api/sepa/runs/{id}/paid', tag: T, summary: 'Alle eingereichten Posten als bezahlt markieren (Zahlung auf der Rechnung)', body: obj({ paid_at: str() }) },
  { method: 'post', path: '/api/sepa/items/{id}/paid', tag: T, summary: 'Einen Posten als bezahlt markieren', body: obj({ paid_at: str() }) },
  { method: 'post', path: '/api/sepa/items/{id}/return', tag: T, summary: 'Rücklastschrift: Zahlung zurücknehmen, Grund-Code, optionale Gebühr als Rechnungsentwurf', body: obj({ code: str('z. B. AM04, MD06, AC04'), note: str(), fee_cents: int(), fee_invoice: bool(), returned_at: str() }, ['code']) },
  { method: 'get', path: '/api/sepa/payables', tag: T, summary: 'Offene, gebuchte Eingangsrechnungen (Belege) für eine Überweisungsdatei' },
  {
    method: 'post',
    path: '/api/sepa/transfers',
    tag: T,
    summary: 'Überweisungsdatei (pain.001.001.09) aus Belegen und/oder einer Auszahlungsliste',
    body: obj({ execution_date: str('JJJJ-MM-TT'), receipt_ids: arr(str()), lines: arr(obj({ name: str(), iban: str(), bic: str(), amount_cents: int(), reference: str() }, ['name', 'iban', 'amount_cents'])), note: str() }),
  },
];
