import { HOOK_ACTIONS, HOOK_TRIGGERS, type HookField } from './rest-hooks.js';
import { APP_VERSION } from '../version.js';
import { SEPA_DOCS } from './openapi-sepa.js';
import { STORE_DOCS } from './openapi-store.js';

/**
 * OpenAPI 3.1 description of the public REST API and the REST hooks, generated from a
 * hand-written route catalogue (tests check every documented path exists in the router),
 * plus a dependency-free HTML reference page.
 */

type Schema = Record<string, any>;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const arr = (items: Schema) => ({ type: 'array', items });
const s = (description?: string, extra: Schema = {}) => ({ type: 'string', ...(description ? { description } : {}), ...extra });
const n = (description?: string, extra: Schema = {}) => ({ type: 'number', ...(description ? { description } : {}), ...extra });
const i = (description?: string) => ({ type: 'integer', ...(description ? { description } : {}) });
const b = (description?: string) => ({ type: 'boolean', ...(description ? { description } : {}) });
const obj = (properties: Record<string, Schema>, required: string[] = [], extra: Schema = {}) => ({ type: 'object', properties, ...(required.length ? { required } : {}), ...extra });
const anyObj = (description?: string) => ({ type: 'object', additionalProperties: true, ...(description ? { description } : {}) });

export interface Param {
  name: string;
  in: 'path' | 'query' | 'header';
  description?: string;
  required?: boolean;
  schema?: Schema;
}

export interface RouteDoc {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** OpenAPI path, e.g. /api/contacts/{id} */
  path: string;
  tag: string;
  summary: string;
  description?: string;
  /** key = Bearer API key (default), public = no auth, signed = public with signature/secret in the URL */
  auth?: 'key' | 'public' | 'signed';
  query?: Param[];
  body?: Schema;
  response?: Schema;
  operationId?: string;
}

const q = (name: string, description: string, schema: Schema = { type: 'string' }): Param => ({ name, in: 'query', description, schema });

const SCHEMAS: Record<string, Schema> = {
  Error: obj({ error: s('Fehlermeldung (Deutsch)') }, ['error']),
  Ok: obj({ ok: b() }),
  Contact: obj({
    id: s(),
    first_name: s(),
    last_name: s(),
    email: s(),
    phone: s('E.164, z. B. +4915112345678'),
    company: s(),
    address: s(),
    city: s(),
    postal_code: s(),
    country: s(),
    website: s(),
    source: s(),
    date_of_birth: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
    tags: arr(s()),
    custom: anyObj('Eigene Felder { schluessel: wert }'),
    dnd: i('1 = Nicht stören'),
    assigned_to: s('Nutzer-ID'),
    created_at: s(undefined, { format: 'date-time' }),
    updated_at: s(undefined, { format: 'date-time' }),
  }),
  ContactInput: obj({
    first_name: s(),
    last_name: s(),
    name: s('Nur beim Anlegen: wird in Vor-/Nachname geteilt (ohne first_name/last_name)'),
    email: s(),
    phone: s(),
    company: s(),
    address: s(),
    city: s(),
    postal_code: s(),
    country: s(),
    website: s(),
    source: s(),
    date_of_birth: s(),
    tags: arr(s()),
    custom: anyObj(),
    dnd: b(),
  }),
  Task: obj({ id: s(), contact_id: s(), title: s(), description: s(), due_at: s(undefined, { format: 'date-time' }), done: i(), assigned_to: s(), completed_at: s(), created_at: s() }),
  TaskInput: obj({ contact_id: s(), title: s(), description: s(), due_at: s(undefined, { format: 'date-time' }), assigned_to: s() }, ['title']),
  TaskPatch: obj({ title: s(), description: s(), due_at: s(undefined, { format: 'date-time' }), assigned_to: s(), done: b('true = erledigt (löst task.completed aus), false = wieder offen') }),
  Note: obj({ id: s(), contact_id: s(), body: s(), user_id: s(), created_at: s() }),
  Stage: obj({ id: s(), name: s() }),
  Pipeline: obj({ id: s(), name: s(), stages: arr(ref('Stage')), created_at: s() }),
  Opportunity: obj({ id: s(), pipeline_id: s(), stage_id: s(), contact_id: s(), name: s(), value: n('Wert in Euro'), status: s(undefined, { enum: ['open', 'won', 'lost', 'abandoned'] }), assigned_to: s(), source: s(), created_at: s(), updated_at: s() }),
  OpportunityInput: obj({ pipeline_id: s(), stage_id: s(), contact_id: s(), contact: ref('ContactInput'), name: s(), value: n(), status: s(undefined, { enum: ['open', 'won', 'lost', 'abandoned'] }), assigned_to: s(), source: s() }, ['pipeline_id']),
  Calendar: obj({ id: s(), name: s(), slug: s(), duration: i('Minuten'), timezone: s() }),
  Appointment: obj({ id: s(), calendar_id: s(), contact_id: s(), title: s(), start_at: s(undefined, { format: 'date-time' }), end_at: s(undefined, { format: 'date-time' }), status: s(undefined, { enum: ['confirmed', 'cancelled', 'showed', 'noshow'] }), notes: s() }),
  MessageInput: obj({ contact_id: s(), channel: s(undefined, { enum: ['email', 'sms', 'chat', 'whatsapp', 'messenger', 'instagram', 'telegram', 'discord', 'push'] }), subject: s('E-Mail-Betreff bzw. Titel einer Push-Nachricht'), body: s(), isHtml: b(), media_url: s('Telegram: https-Link zu Bild/PDF/Audio/Video'), url: s('Push: Link beim Antippen') }, ['contact_id', 'body']),
  Message: obj({ id: s(), conversation_id: s(), channel: s(), direction: s(), subject: s(), body: s(), status: s(), created_at: s() }),
  Workflow: obj({ id: s(), name: s(), status: s(undefined, { enum: ['draft', 'active', 'paused'] }), trigger: anyObj(), steps: arr(anyObj()), created_at: s() }),
  LineItem: obj({ name: s(), description: s(), qty: n(), price_cents: i('Netto je Einheit in Cent'), tax_rate: n('Prozent') }, ['name']),
  Invoice: obj({
    id: s(),
    kind: s(undefined, { enum: ['invoice', 'estimate', 'credit_note'] }),
    number: s('Leer bei Entwürfen – die Nummer vergibt erst das Festschreiben'),
    contact_id: s(),
    title: s(),
    items: arr(ref('LineItem')),
    currency: s(),
    total_cents: i(),
    status: s(undefined, { enum: ['draft', 'sent', 'paid', 'void', 'accepted'] }),
    state: s('Abgeleiteter Zustand (credited: vollständig gutgeschrieben, nichts bezahlt – geschlossen, gespeichert als void)', { enum: ['draft', 'open', 'partially_paid', 'paid', 'cancelled', 'credited', 'discarded', 'accepted'] }),
    doc_title: s('Rechnung, Abschlagsrechnung, Schlussrechnung, Stornorechnung, Gutschrift, Angebot'),
    locked: b('Festgeschrieben: Inhalt unveränderlich'),
    finalised_at: s(undefined, { format: 'date-time' }),
    doc_hash: s('SHA-256 der Momentaufnahme'),
    open_cents: i('Noch offen (Summe minus Zahlungen, Gutschriften, abgezogene Abschläge)'),
    days_overdue: i('Kalendertage nach dem Fälligkeitstag in der Zeitzone des Sub-Accounts (0 am Fälligkeitstag und wenn nichts offen ist)'),
    paid_cents: i(),
    tax_mode: s(undefined, { enum: ['standard', 'small_business', 'reverse_charge', 'ig_supply', 'export', 'tax_free'] }),
    tax_note: s('Pflichttext bei besonderer Steuerbehandlung'),
    supply_from: s('Leistungsdatum (JJJJ-MM-TT)'),
    supply_to: s('Ende des Leistungszeitraums'),
    buyer_vat_id: s(),
    leitweg_id: s(),
    buyer_ref: s(),
    skonto_percent: n(),
    skonto_days: i(),
    inv_type: s(undefined, { enum: ['standard', 'partial', 'final'] }),
    credit_type: s('Nur bei kind=credit_note', { enum: ['storno', 'credit'] }),
    ref_id: s('Bezug: Ursprungsrechnung (Storno, Gutschrift) oder Angebot'),
    due_at: s(),
    url: s('Kundenlink'),
    pdf_url: s(),
  }),
  InvoiceInput: obj(
    {
      kind: s(undefined, { enum: ['invoice', 'estimate'] }),
      contact_id: s(),
      title: s(),
      items: arr(ref('LineItem')),
      currency: s(),
      due_at: s(),
      notes: s(),
      tax_mode: s(undefined, { enum: ['standard', 'small_business', 'reverse_charge', 'ig_supply', 'export', 'tax_free'] }),
      tax_note: s(),
      supply_from: s(),
      supply_to: s(),
      buyer_vat_id: s(),
      leitweg_id: s(),
      buyer_ref: s(),
      skonto_percent: n(),
      skonto_days: i(),
      inv_type: s(undefined, { enum: ['standard', 'partial', 'final'] }),
      deduct_ids: arr(s()),
    },
    ['items'],
  ),
  Product: obj({ id: s(), name: s(), description: s(), price_cents: i(), currency: s() }),
  Tag: obj({ id: s(), name: s(), count: i() }),
  CustomField: obj({ id: s(), key: s(), label: s(), type: s(), options: arr(s()) }),
  Webhook: obj({ id: s(), url: s(), events: arr(s()), secret: s(), active: i(), last_status: s() }),
  HookTrigger: obj({ key: s(undefined, { enum: HOOK_TRIGGERS.map((t) => t.key) }), label: s(), description: s(), events: arr(s()), filters: arr(obj({ key: s(), label: s() })) }),
  HookSubscriptionInput: obj(
    {
      target_url: s('Ziel-URL (auch hookUrl/url/targetUrl)'),
      event: s('Auslöser-Schlüssel', { enum: HOOK_TRIGGERS.map((t) => t.key) }),
      filters: obj({ tag: s(), pipeline_id: s(), stage_id: s(), form_id: s(), calendar_id: s(), product_id: s(), channel: s(), events: arr(s()) }),
      source: s(undefined, { enum: ['zapier', 'make', 'n8n', 'api'] }),
      label: s(),
    },
    ['target_url', 'event'],
  ),
  HookSubscription: obj({ id: s(), event: s(), target_url: s(), filters: anyObj(), secret: s('Zum Prüfen von x-pghl-signature'), source: s(), label: s(), status: s(undefined, { enum: ['active', 'paused', 'disabled'] }), disabled_reason: s(), last_status: s(), last_delivery_at: s(), created_at: s() }),
  HookPayload: obj({
    id: s('Ereignis-ID (gleich für alle Abos eines Ereignisses, zum Entdoppeln)'),
    event: s('Auslöser-Schlüssel'),
    type: s('Ursprünglicher Ereignistyp, z. B. contact.tag_added'),
    location_id: s(),
    occurred_at: s(undefined, { format: 'date-time' }),
    contact_id: { type: ['string', 'null'] },
    contact: { anyOf: [ref('Contact'), { type: 'null' }] },
    data: anyObj('Rohdaten des Ereignisses'),
  }),
  HookDelivery: obj({ id: s(), hook_id: s(), target_url: s(), event_id: s(), event: s(), type: s(), status: s(undefined, { enum: ['pending', 'success', 'retrying', 'failed', 'gone', 'cancelled'] }), attempts: i(), next_attempt_at: s(), response_status: i(), error: s(), duration_ms: i(), created_at: s() }),
};

const fieldSchema = (f: HookField): Schema => {
  const base: Schema =
    f.type === 'number' ? { type: 'number' }
    : f.type === 'boolean' ? { type: 'boolean' }
    : f.type === 'array' ? { oneOf: [arr(f.key === 'items' ? anyObj() : s()), s()] }
    : f.type === 'object' ? anyObj()
    : f.type === 'datetime' ? { type: 'string', format: 'date-time' }
    : { type: 'string' };
  return { ...base, title: f.label, ...(f.help ? { description: f.help } : {}), ...(f.choices ? { enum: f.choices } : {}) };
};

const ID = (what: string) => `ID ${what}`;
const LIST_CONTACT_QUERY = [q('q', 'Suchtext (Name, E-Mail, Telefon, Firma)'), q('tag', 'Nur mit Tag (mehrfach möglich)'), q('notTag', 'Ohne Tag'), q('sort', 'name | activity'), q('limit', 'max. 500', { type: 'integer' }), q('offset', 'Versatz', { type: 'integer' })];

/** The catalogue: one entry per documented operation. */
export const ROUTE_DOCS: RouteDoc[] = [
  // Sub-Account
  { method: 'get', path: '/api/location', tag: 'Sub-Account', summary: 'Sub-Account des Schlüssels (Name, Zeitzone, Einstellungen ohne Geheimnisse)' },
  { method: 'get', path: '/api/hooks/me', tag: 'Sub-Account', summary: 'Verbindung testen (für Zapier/Make/n8n)', response: obj({ ok: b(), location: obj({ id: s(), name: s(), timezone: s() }), label: s() }) },
  { method: 'get', path: '/api/search', tag: 'Sub-Account', summary: 'Schnellsuche über Kontakte und Deals', query: [q('q', 'Suchtext')] },

  // Contacts
  { method: 'get', path: '/api/contacts', tag: 'Kontakte', summary: 'Kontakte suchen und auflisten', query: LIST_CONTACT_QUERY, response: obj({ total: i(), contacts: arr(ref('Contact')) }) },
  { method: 'post', path: '/api/contacts', tag: 'Kontakte', summary: 'Kontakt anlegen oder zusammenführen (gleiche E-Mail/Telefon)', body: ref('ContactInput'), response: ref('Contact') },
  { method: 'get', path: '/api/contacts/{id}', tag: 'Kontakte', summary: 'Kontakt mit Notizen, Aufgaben und Aktivitäten', response: ref('Contact') },
  { method: 'patch', path: '/api/contacts/{id}', tag: 'Kontakte', summary: 'Kontakt ändern (tags ersetzt die Liste)', body: ref('ContactInput'), response: ref('Contact') },
  { method: 'delete', path: '/api/contacts/{id}', tag: 'Kontakte', summary: 'Kontakt löschen', response: ref('Ok') },
  { method: 'post', path: '/api/contacts/{id}/tags', tag: 'Kontakte', summary: 'Tags hinzufügen/entfernen', body: obj({ add: arr(s()), remove: arr(s()) }), response: ref('Contact') },
  { method: 'post', path: '/api/contacts/{id}/notes', tag: 'Kontakte', summary: 'Notiz anhängen', body: obj({ body: s() }, ['body']), response: ref('Note') },
  { method: 'get', path: '/api/contacts/{id}/messages', tag: 'Kontakte', summary: 'Nachrichtenverlauf eines Kontakts' },
  { method: 'post', path: '/api/contacts/import', tag: 'Kontakte', summary: 'CSV-Import', body: obj({ csv: s('CSV-Text mit Kopfzeile'), mapping: anyObj('Spalte → Feld'), tags: s('Zusätzliche Tags, durch Komma getrennt') }, ['csv']) },
  { method: 'get', path: '/api/contacts/export.csv', tag: 'Kontakte', summary: 'CSV-Export (gleiche Filter wie die Liste)', query: LIST_CONTACT_QUERY },
  { method: 'delete', path: '/api/notes/{id}', tag: 'Kontakte', summary: 'Notiz löschen' },

  // Tasks
  { method: 'get', path: '/api/tasks', tag: 'Aufgaben', summary: 'Aufgaben (offen, erledigt oder alle)', query: [q('status', 'open (Standard) | done | all')], response: arr(ref('Task')) },
  { method: 'post', path: '/api/tasks', tag: 'Aufgaben', summary: 'Aufgabe anlegen', body: ref('TaskInput'), response: ref('Task') },
  { method: 'patch', path: '/api/tasks/{id}', tag: 'Aufgaben', summary: 'Aufgabe ändern oder erledigen (`done: true` löst task.completed aus)', body: ref('TaskPatch'), response: ref('Task') },
  { method: 'delete', path: '/api/tasks/{id}', tag: 'Aufgaben', summary: 'Aufgabe löschen' },

  // Pipelines & deals
  { method: 'get', path: '/api/pipelines', tag: 'Pipelines & Deals', summary: 'Pipelines mit Stufen', response: arr(ref('Pipeline')) },
  { method: 'post', path: '/api/pipelines', tag: 'Pipelines & Deals', summary: 'Pipeline anlegen', body: obj({ name: s(), stages: arr(obj({ id: s(), name: s() })) }, ['name']) },
  { method: 'patch', path: '/api/pipelines/{id}', tag: 'Pipelines & Deals', summary: 'Pipeline ändern', body: obj({ name: s(), stages: arr(ref('Stage')) }) },
  { method: 'delete', path: '/api/pipelines/{id}', tag: 'Pipelines & Deals', summary: 'Pipeline löschen' },
  { method: 'get', path: '/api/opportunities', tag: 'Pipelines & Deals', summary: 'Opportunities', query: [q('pipeline_id', 'Pipeline'), q('status', 'open | won | lost | abandoned | all')], response: arr(ref('Opportunity')) },
  { method: 'post', path: '/api/opportunities', tag: 'Pipelines & Deals', summary: 'Opportunity anlegen (contact_id oder contact)', body: ref('OpportunityInput'), response: ref('Opportunity') },
  { method: 'patch', path: '/api/opportunities/{id}', tag: 'Pipelines & Deals', summary: 'Stufe, Status, Wert ändern', body: obj({ stage_id: s(), pipeline_id: s(), status: s(), value: n(), name: s(), assigned_to: s() }), response: ref('Opportunity') },
  { method: 'delete', path: '/api/opportunities/{id}', tag: 'Pipelines & Deals', summary: 'Opportunity löschen' },

  // Calendars
  { method: 'get', path: '/api/calendars', tag: 'Kalender & Termine', summary: 'Kalender', response: arr(ref('Calendar')) },
  { method: 'get', path: '/api/appointments', tag: 'Kalender & Termine', summary: 'Termine im Zeitraum', query: [q('from', 'ISO-Datum'), q('to', 'ISO-Datum'), q('calendar_id', 'Kalender')], response: arr(ref('Appointment')) },
  { method: 'post', path: '/api/appointments', tag: 'Kalender & Termine', summary: 'Termin eintragen (Dauer und Titel vom Kalender; mit blocked: true eine Blockzeit von start_at bis end_at)', body: obj({ calendar_id: s(), contact_id: s(), contact: ref('ContactInput'), start_at: s('Beginn (ISO, auch als start)', { format: 'date-time' }), notes: s(), force: b('Auch außerhalb der freien Zeiten eintragen'), blocked: b('Blockzeit statt Termin'), end_at: s('Nur bei blocked: Ende (ISO, auch als end)', { format: 'date-time' }), title: s('Nur bei blocked') }, ['calendar_id', 'start_at']), response: ref('Appointment') },
  { method: 'patch', path: '/api/appointments/{id}', tag: 'Kalender & Termine', summary: 'Termin ändern, verschieben oder Status setzen', body: obj({ status: s(undefined, { enum: ['confirmed', 'cancelled', 'showed', 'noshow'] }), start_at: s('Neuer Beginn (ISO, auch als start) – die Dauer bleibt, außer end_at kommt mit', { format: 'date-time' }), end_at: s('Neues Ende (ISO, auch als end)', { format: 'date-time' }), title: s(), notes: s() }) },
  { method: 'get', path: '/api/public/calendars/{slug}/slots', tag: 'Öffentlich', summary: 'Freie Zeiten einer Buchungsseite', auth: 'public' },
  { method: 'post', path: '/api/public/calendars/{slug}/book', tag: 'Öffentlich', summary: 'Termin buchen (Buchungsseite)', auth: 'public', body: obj({ start: s('Beginn eines freien Termins (ISO, aus /slots)', { format: 'date-time' }), first_name: s(), last_name: s(), name: s('Statt first_name/last_name: wird geteilt'), email: s(), phone: s(), notes: s() }, ['start', 'email']) },

  // Messages
  { method: 'post', path: '/api/messages', tag: 'Nachrichten', summary: 'Nachricht senden (E-Mail, SMS, Chat, WhatsApp, Messenger, Instagram, Telegram, Discord, Push)', body: ref('MessageInput'), response: ref('Message') },
  { method: 'get', path: '/api/conversations', tag: 'Nachrichten', summary: 'Konversationen', query: [q('channel', 'Kanal-Filter')] },
  { method: 'get', path: '/api/conversations/{id}/messages', tag: 'Nachrichten', summary: 'Nachrichten einer Konversation' },

  // Workflows
  { method: 'get', path: '/api/workflows', tag: 'Workflows', summary: 'Workflows', response: arr(ref('Workflow')) },
  { method: 'post', path: '/api/workflows/{id}/enroll', tag: 'Workflows', summary: 'Kontakte in einen aktiven Workflow aufnehmen', body: obj({ contact_ids: arr(s()) }, ['contact_ids']), response: obj({ enrolled: i() }) },
  { method: 'post', path: '/hooks/workflow/{id}', tag: 'Eingehende Webhooks', summary: 'Klassischer Webhook-Auslöser (JSON mit email, phone, first_name …, tags)', auth: 'signed', query: [q('key', 'Schlüssel aus der Workflow-URL')] },
  {
    method: 'post',
    path: '/hooks/in/{token}',
    tag: 'Eingehende Webhooks',
    summary: '„Webhook empfangen“: beliebiges JSON mit Feldzuordnung',
    description: 'URL steht im Workflow-Auslöser. Optional HMAC-SHA256 über den Rohtext im Header `X-Signature-256: sha256=<hex>` (auch `X-Hub-Signature-256`, `X-Pghl-Hmac`). Begrenzt pro URL (Standard 60/Minute) – sonst 429.',
    auth: 'signed',
    body: anyObj('Beliebiges JSON'),
    response: obj({ ok: b(), contactId: s(), created: b(), enrolled: b(), captured: b() }),
  },

  // Templates & campaigns
  { method: 'get', path: '/api/templates', tag: 'Vorlagen & Kampagnen', summary: 'E-Mail-/SMS-Vorlagen' },
  { method: 'post', path: '/api/templates', tag: 'Vorlagen & Kampagnen', summary: 'Vorlage anlegen', body: obj({ name: s(), channel: s(), subject: s(), body: s(), design: anyObj() }) },
  { method: 'get', path: '/api/campaigns', tag: 'Vorlagen & Kampagnen', summary: 'Kampagnen' },
  { method: 'post', path: '/api/campaigns/{id}/send', tag: 'Vorlagen & Kampagnen', summary: 'Kampagne senden oder planen', body: obj({ scheduled_at: s() }) },
  { method: 'get', path: '/api/campaigns/{id}/ab', tag: 'Vorlagen & Kampagnen', summary: 'A/B-Test einer Kampagne: Ergebnisse je Variante' },
  { method: 'post', path: '/api/campaigns/{id}/ab/winner', tag: 'Vorlagen & Kampagnen', summary: 'A/B-Test: Gewinner jetzt bestimmen (ohne key automatisch)', body: obj({ key: s('Variante A–D') }) },
  { method: 'post', path: '/api/campaigns/{id}/resend', tag: 'Vorlagen & Kampagnen', summary: 'Erinnerung an Nicht-Öffner einrichten oder sofort senden', body: obj({ subject: s(), after_hours: n(), sender_name: s(), now: b() }) },
  { method: 'get', path: '/api/email-gallery', tag: 'Vorlagen & Kampagnen', summary: 'Vorlagengalerie (fertige deutsche E-Mail-Designs)', query: [q('q', 'Suchwörter'), q('category', 'Kategorie')] },
  { method: 'get', path: '/api/segments', tag: 'Segmente', summary: 'Gespeicherte Verhaltens-Segmente mit Mitgliederzahl' },
  { method: 'post', path: '/api/segments', tag: 'Segmente', summary: 'Segment anlegen', body: obj({ name: s(), description: s(), definition: anyObj('Gruppe aus Bedingungen (UND/ODER)'), watch: b('Beitritt und Austritt für Workflows beobachten') }, ['name']) },
  { method: 'post', path: '/api/segments/count', tag: 'Segmente', summary: 'Live-Zahl einer noch nicht gespeicherten Definition', body: obj({ definition: anyObj() }) },
  { method: 'get', path: '/api/deliverability/reputation', tag: 'Zustellbarkeit', summary: 'Bounce-, Beschwerde- und Abmelderate je Kampagne, Domain und Woche mit Warnungen', query: [q('days', '7–365 (Standard 90)')] },

  // Forms
  { method: 'get', path: '/api/forms', tag: 'Formulare', summary: 'Formulare' },
  { method: 'get', path: '/api/forms/{id}/submissions', tag: 'Formulare', summary: 'Einsendungen eines Formulars' },
  { method: 'get', path: '/api/forms/templates', tag: 'Formulare', summary: 'Formular-Vorlagen (26 deutsche Vorlagen)' },
  { method: 'post', path: '/api/forms/templates/{id}/use', tag: 'Formulare', summary: 'Vorlage als neues Formular anlegen', body: obj({ name: s(), product_id: s() }) },
  { method: 'get', path: '/api/forms/{id}/analytics', tag: 'Formulare', summary: 'Auswertung je Feld: Aufrufe, Abbrüche, Dauer, Trichter', query: [q('days', '7, 30, 90 oder 180 (Standard 30)')] },
  { method: 'post', path: '/api/public/forms/{id}/submit', tag: 'Öffentlich', summary: 'Formular absenden', auth: 'public', body: anyObj('Feldwerte') },

  // Payments
  { method: 'get', path: '/api/invoices', tag: 'Rechnungen & Produkte', summary: 'Rechnungen, Gutschriften und Angebote', query: [q('kind', 'invoice (Standard), credit_note oder estimate')], response: arr(ref('Invoice')) },
  { method: 'post', path: '/api/invoices', tag: 'Rechnungen & Produkte', summary: 'Rechnung/Angebot als Entwurf anlegen', body: ref('InvoiceInput'), response: ref('Invoice') },
  { method: 'get', path: '/api/invoices/{id}', tag: 'Rechnungen & Produkte', summary: 'Rechnung', response: ref('Invoice') },
  { method: 'patch', path: '/api/invoices/{id}', tag: 'Rechnungen & Produkte', summary: 'Rechnung ändern (festgeschrieben: nur Hinweistext, Fälligkeit, Zahlungslink – sonst 409) oder Status wechseln (folgt dem Zustandsautomaten)', body: obj({ status: s(undefined, { enum: ['draft', 'sent', 'paid', 'void', 'accepted'] }), items: arr(ref('LineItem')), due_at: s(), recurring: anyObj() }) },
  { method: 'post', path: '/api/invoices/{id}/send', tag: 'Rechnungen & Produkte', summary: 'Rechnung per E-Mail senden' },
  { method: 'post', path: '/api/invoices/{id}/finalise', tag: 'Rechnungen & Produkte', summary: 'Festschreiben: Nummer vergeben, Inhalt sperren, Momentaufnahme + SHA-256', response: ref('Invoice') },
  { method: 'get', path: '/api/invoices/{id}/precheck', tag: 'Rechnungen & Produkte', summary: 'Was das Festschreiben blockiert (errors) oder nur anmerkt (warnings)' },
  { method: 'post', path: '/api/invoices/{id}/storno', tag: 'Rechnungen & Produkte', summary: 'Stornorechnung erzeugen (eigene Nummer, Beträge negativ)', body: obj({ reason: s(), send: b('Stornorechnung gleich per E-Mail senden') }) },
  { method: 'post', path: '/api/invoices/{id}/credit-note', tag: 'Rechnungen & Produkte', summary: 'Gutschrift (Entwurf) zu einer festgeschriebenen Rechnung', body: obj({ items: arr(ref('LineItem')), reason: s() }) },
  { method: 'post', path: '/api/invoices/{id}/convert', tag: 'Rechnungen & Produkte', summary: 'Angebot in Rechnung umwandeln (Entwurf mit Bezug)', body: obj({ inv_type: s(undefined, { enum: ['standard', 'partial', 'final'] }) }) },
  { method: 'get', path: '/api/invoices/{id}/payments', tag: 'Rechnungen & Produkte', summary: 'Zahlungen einer Rechnung' },
  { method: 'post', path: '/api/invoices/{id}/payments', tag: 'Rechnungen & Produkte', summary: 'Zahlung erfassen (auch Teilzahlung, Skonto)', body: obj({ amount_cents: i(), paid_at: s(undefined, { format: 'date-time' }), method: s(), note: s(), skonto: b() }) },
  { method: 'post', path: '/api/invoices/{id}/payments/{pid}/revert', tag: 'Rechnungen & Produkte', summary: 'Zahlung zurücknehmen (Gegenzeile, nichts wird gelöscht)' },
  { method: 'get', path: '/api/invoices/{id}/pdf', tag: 'Rechnungen & Produkte', summary: 'Rechnungs-PDF (DIN 5008, GiroCode) vom Server' },
  { method: 'get', path: '/api/invoices/{id}/xrechnung', tag: 'Rechnungen & Produkte', summary: 'XRechnung 3.0 als XML (syntax=cii|ubl, format=json für JSON)', query: [q('syntax', 'cii (Standard) oder ubl'), q('format', 'json: XML im JSON')] },
  { method: 'get', path: '/api/invoices/{id}/zugferd', tag: 'Rechnungen & Produkte', summary: 'ZUGFeRD 2.3 / Factur-X: Rechnungs-PDF mit eingebetteter CII-XML (archiviert)', query: [q('profile', 'en16931 (Standard) oder xrechnung'), q('format', 'json: XML und Prüfsumme im JSON'), q('include_pdf', '1: mit format=json das PDF als Base64'), q('download', '1: als Download')] },
  { method: 'get', path: '/api/invoices/{id}/einvoice/check', tag: 'Rechnungen & Produkte', summary: 'Vorschau-Prüfung der E-Rechnung' },
  { method: 'get', path: '/api/invoices/{id}/documents', tag: 'Rechnungen & Produkte', summary: 'Archivierte Dateien der Rechnung (SHA-256, Aufbewahrung)' },
  { method: 'get', path: '/api/invoices/{id}/audit', tag: 'Rechnungen & Produkte', summary: 'Unveränderliches Protokoll der Rechnung' },
  { method: 'get', path: '/api/invoices/{id}/verify', tag: 'Rechnungen & Produkte', summary: 'Prüfsumme gegen die festgeschriebene Fassung prüfen' },
  { method: 'post', path: '/api/invoices/vat-check', tag: 'Rechnungen & Produkte', summary: 'USt-IdNr. prüfen (Format, optional VIES)', body: obj({ vat_id: s() }, ['vat_id']) },
  { method: 'get', path: '/api/invoice-settings', tag: 'Rechnungen & Produkte', summary: 'Rechnungs-Einstellungen, Nummernkreise, Steuerbehandlungen' },
  { method: 'put', path: '/api/invoice-settings', tag: 'Rechnungen & Produkte', summary: 'Absender, Bank, Steuer, Prüfungen und Nummernkreise speichern', body: anyObj() },
  { method: 'get', path: '/api/products', tag: 'Rechnungen & Produkte', summary: 'Produkte', response: arr(ref('Product')) },
  { method: 'get', path: '/api/subscriptions', tag: 'Rechnungen & Produkte', summary: 'Abo-Rechnungen' },
  { method: 'get', path: '/api/contracts', tag: 'Verträge', summary: 'Verträge und Vorlagen', query: [q('kind', 'template = nur Vorlagen')] },
  { method: 'post', path: '/api/contracts', tag: 'Verträge', summary: 'Vertrag aus Vorlage', body: obj({ template_id: s(), contact_id: s() }) },

  // Tags & fields
  { method: 'get', path: '/api/tags', tag: 'Tags & Felder', summary: 'Tags mit Anzahl', response: arr(ref('Tag')) },
  { method: 'post', path: '/api/tags', tag: 'Tags & Felder', summary: 'Tag anlegen', body: obj({ name: s() }, ['name']) },
  { method: 'get', path: '/api/custom-fields', tag: 'Tags & Felder', summary: 'Eigene Felder', response: arr(ref('CustomField')) },
  { method: 'post', path: '/api/custom-fields', tag: 'Tags & Felder', summary: 'Eigenes Feld anlegen', body: obj({ label: s(), key: s(), type: s(), options: arr(s()) }, ['label']) },

  // Outgoing webhooks (classic)
  { method: 'get', path: '/api/webhooks', tag: 'Webhooks', summary: 'Ausgehende Webhooks (jedes Ereignis als JSON-POST)', response: arr(ref('Webhook')) },
  { method: 'post', path: '/api/webhooks', tag: 'Webhooks', summary: 'Ausgehenden Webhook anlegen', body: obj({ url: s(), events: arr(s()) }, ['url']), response: ref('Webhook') },
  { method: 'delete', path: '/api/webhooks/{id}', tag: 'Webhooks', summary: 'Ausgehenden Webhook löschen' },

  // REST hooks
  { method: 'get', path: '/api/hooks/triggers', tag: 'REST-Hooks', summary: 'Verfügbare Auslöser', response: arr(ref('HookTrigger')) },
  { method: 'get', path: '/api/hooks/triggers/{key}/sample', tag: 'REST-Hooks', summary: 'Beispieldaten (die letzten echten Ereignisse, sonst ein Muster)', response: arr(ref('HookPayload')) },
  { method: 'get', path: '/api/hooks', tag: 'REST-Hooks', summary: 'Abos auflisten', query: [q('event', 'Auslöser'), q('source', 'zapier | make | n8n | api')], response: arr(ref('HookSubscription')) },
  { method: 'post', path: '/api/hooks', tag: 'REST-Hooks', summary: 'Abonnieren (subscribe)', body: ref('HookSubscriptionInput'), response: ref('HookSubscription') },
  { method: 'get', path: '/api/hooks/{id}', tag: 'REST-Hooks', summary: 'Abo lesen', response: ref('HookSubscription') },
  { method: 'patch', path: '/api/hooks/{id}', tag: 'REST-Hooks', summary: 'Abo pausieren/fortsetzen, Filter ändern', body: obj({ status: s(undefined, { enum: ['active', 'paused'] }), label: s(), filters: anyObj() }), response: ref('HookSubscription') },
  { method: 'delete', path: '/api/hooks/{id}', tag: 'REST-Hooks', summary: 'Abbestellen (unsubscribe)', response: ref('Ok') },
  { method: 'post', path: '/api/hooks/{id}/test', tag: 'REST-Hooks', summary: 'Beispiel-Ereignis sofort zustellen', response: ref('HookDelivery') },
  { method: 'get', path: '/api/hooks/deliveries', tag: 'REST-Hooks', summary: 'Zustell-Protokoll', query: [q('hook_id', 'Abo'), q('status', 'success | retrying | failed | gone | cancelled'), q('event', 'Auslöser'), q('limit', 'max. 200', { type: 'integer' }), q('offset', 'Versatz', { type: 'integer' })], response: obj({ total: i(), deliveries: arr(ref('HookDelivery')), counts_7d: anyObj() }) },
  { method: 'get', path: '/api/hooks/deliveries/{id}', tag: 'REST-Hooks', summary: 'Zustellung mit Payload und Antwort', response: ref('HookDelivery') },
  { method: 'post', path: '/api/hooks/deliveries/{id}/retry', tag: 'REST-Hooks', summary: 'Zustellung jetzt erneut senden', response: ref('HookDelivery') },
  { method: 'get', path: '/api/hooks/actions', tag: 'REST-Hook-Aktionen', summary: 'Verfügbare Aktionen mit Feldern' },
  ...HOOK_ACTIONS.map(
    (a): RouteDoc => ({
      method: 'post',
      path: `/api/hooks/actions/${a.key}`,
      tag: 'REST-Hook-Aktionen',
      summary: a.label,
      description: a.description,
      operationId: `action_${a.key}`,
      body: { type: 'object', properties: Object.fromEntries(a.fields.map((f) => [f.key, fieldSchema(f)])), required: a.fields.filter((f) => f.required).map((f) => f.key) },
    }),
  ),
  { method: 'get', path: '/api/hooks/search/contacts', tag: 'Suche', summary: 'Kontakt finden', query: [q('id', 'Kontakt-ID'), q('email', 'E-Mail'), q('phone', 'Telefon'), q('q', 'Suchtext')], response: arr(ref('Contact')) },
  { method: 'get', path: '/api/hooks/search/opportunities', tag: 'Suche', summary: 'Opportunity finden', query: [q('id', 'ID'), q('contact_id', 'Kontakt'), q('email', 'E-Mail des Kontakts'), q('status', 'Status'), q('q', 'Name enthält')], response: arr(ref('Opportunity')) },

  // Vertrieb (docs/sales.md)
  { method: 'get', path: '/api/sequences', tag: 'Vertrieb', summary: 'Vertriebs-Sequenzen mit Status und Kennzahlen' },
  { method: 'post', path: '/api/sequences', tag: 'Vertrieb', summary: 'Sequenz anlegen (Entwurf; „Einzelkorrespondenz“ braucht legal_ack)', body: obj({ name: s(), mode: s(undefined, { enum: ['marketing', 'individual'] }), legal_ack: b(), steps: arr(anyObj('type email|task|call|linkedin, delay_days, subject, body …')), settings: anyObj('Sendezeiten, Abbruchregeln') }, ['name', 'steps']) },
  { method: 'get', path: '/api/sequences/{id}', tag: 'Vertrieb', summary: 'Sequenz mit Schritten und Zahlen (Öffnungen nur von Menschen)' },
  { method: 'post', path: '/api/sequences/{id}/enroll', tag: 'Vertrieb', summary: 'Kontakte aufnehmen – übersprungene mit Grund zurück', body: obj({ contact_ids: arr(s()), tag: s(), smart_list_id: s(), user_id: s('Absender (mit Schlüssel nötig)'), deal_id: s(), source: s() }) },
  { method: 'get', path: '/api/opportunities/{id}/lines', tag: 'Vertrieb', summary: 'Positionen eines Deals mit Summen' },
  { method: 'put', path: '/api/opportunities/{id}/lines', tag: 'Vertrieb', summary: 'Positionen eines Deals setzen – der Dealwert folgt als Nettosumme', body: obj({ lines: arr(anyObj('name, qty, price_cents, discount_type none|percent|amount, discount_value, tax_rate, product_id')) }, ['lines']) },
  { method: 'get', path: '/api/quotes', tag: 'Vertrieb', summary: 'Angebote (nach deal_id oder status filtern)', query: [q('deal_id', 'Nur dieses Deal'), q('status', 'draft | sent | viewed | accepted | declined | expired | void')] },
  { method: 'post', path: '/api/quotes', tag: 'Vertrieb', summary: 'Angebot aus einem Deal anlegen (übernimmt dessen Positionen)', body: obj({ deal_id: s(), title: s() }, ['deal_id']) },
  { method: 'get', path: '/api/quotes/{id}', tag: 'Vertrieb', summary: 'Angebot mit Varianten, Summen und Link zur Angebotsseite' },
  { method: 'post', path: '/api/quotes/{id}/send', tag: 'Vertrieb', summary: 'Angebot nummerieren und per E-Mail senden', body: obj({ subject: s(), body: s(), channel: s(undefined, { enum: ['email', 'sms'] }), deliver: b('false = nur freigeben und den Link zurückgeben') }) },
  { method: 'get', path: '/api/contact-duplicates', tag: 'Vertrieb', summary: 'Mögliche Dubletten-Gruppen', query: [q('min', 'high = nur sichere')] },
  { method: 'get', path: '/api/quotas', tag: 'Vertrieb', summary: 'Quoten und Zielerreichung je Person und Team', query: [q('period', 'month | quarter'), q('metric', 'won_value | won_count'), q('start', 'Erster Tag der Periode (YYYY-MM-DD)')] },
  { method: 'get', path: '/api/leaderboard', tag: 'Vertrieb', summary: 'Rangliste nach Gewonnenem', query: [q('period', 'month | quarter'), q('metric', 'won_value | won_count'), q('scope', 'user | team')] },

  ...SEPA_DOCS,
  ...STORE_DOCS,

  // Spec itself
  { method: 'get', path: '/api/openapi.json', tag: 'Referenz', summary: 'Diese Beschreibung (OpenAPI 3.1)', auth: 'public' },
  { method: 'get', path: '/api/docs.html', tag: 'Referenz', summary: 'API-Referenz als Webseite', auth: 'public' },
];

const TAG_ORDER = ['Sub-Account', 'Kontakte', 'Aufgaben', 'Pipelines & Deals', 'Kalender & Termine', 'Nachrichten', 'Workflows', 'Vorlagen & Kampagnen', 'Formulare', 'Rechnungen & Produkte', 'Verträge', 'SEPA', 'Vertrieb', 'Tags & Felder', 'Webhooks', 'REST-Hooks', 'REST-Hook-Aktionen', 'Suche', 'Eingehende Webhooks', 'Öffentlich', 'Referenz'];

const opId = (r: RouteDoc) => r.operationId ?? `${r.method}_${r.path.replace(/^\//, '').replace(/\{(\w+)\}/g, 'by_$1').replace(/[^a-zA-Z0-9]+/g, '_').replace(/_$/, '')}`;

export function buildOpenApi(baseUrl: string) {
  const paths: Record<string, Record<string, any>> = {};
  for (const r of ROUTE_DOCS) {
    const params: Param[] = [...(r.path.match(/\{(\w+)\}/g) ?? []).map((m): Param => ({ name: m.slice(1, -1), in: 'path', required: true, schema: { type: 'string' }, description: ID(m.slice(1, -1)) })), ...(r.query ?? [])];
    const op: Record<string, any> = {
      operationId: opId(r),
      tags: [r.tag],
      summary: r.summary,
      ...(r.description ? { description: r.description } : {}),
      ...(params.length ? { parameters: params } : {}),
      ...(r.body ? { requestBody: { required: true, content: { 'application/json': { schema: r.body } } } } : {}),
      responses: {
        '200': { description: 'OK', content: { 'application/json': { schema: r.response ?? anyObj() } } },
        ...(r.auth === 'public' ? {} : { '401': { description: 'Schlüssel fehlt oder ungültig', content: { 'application/json': { schema: ref('Error') } } } }),
        '400': { description: 'Ungültige Eingabe', content: { 'application/json': { schema: ref('Error') } } },
      },
    };
    if (r.auth === 'public' || r.auth === 'signed') op.security = [];
    (paths[r.path] ??= {})[r.method] = op;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'HyperLevel REST-API',
      version: APP_VERSION,
      description:
        'Öffentliche REST-API und REST-Hooks (Zapier, Make, n8n). Anmeldung mit `Authorization: Bearer <Schlüssel>`: Sub-Account-Schlüssel (`pghl_…`, Einstellungen → API & Webhooks) oder Agentur-Schlüssel (`pghla_…`, Agentur → API & MCP) plus Header `x-location-id`. Alle Antworten JSON, Fehler als `{ "error": "…" }`.',
    },
    servers: [{ url: baseUrl }],
    security: [{ bearerAuth: [] }],
    tags: TAG_ORDER.map((name) => ({ name })),
    paths,
    webhooks: {
      restHook: {
        post: {
          summary: 'Zustellung an eine abonnierte URL',
          description: `Header: x-pghl-signature = sha256(secret + body) (hex), x-pghl-event, x-pghl-delivery, x-pghl-hook, x-pghl-attempt. 2xx = zugestellt; 410 = Abo wird nach 3× deaktiviert; Netzwerkfehler, 408, 429 und 5xx werden bis zu 6× wiederholt (1 Min., 5 Min., 30 Min., 2 Std., 6 Std.). Auslöser: ${HOOK_TRIGGERS.map((t) => t.key).join(', ')}.`,
          requestBody: { content: { 'application/json': { schema: ref('HookPayload') } } },
          responses: { '200': { description: 'Angenommen' }, '410': { description: 'Ziel existiert nicht mehr' } },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'pghl_… (Sub-Account) oder pghla_… (Agentur, dann x-location-id nötig)' },
        locationHeader: { type: 'apiKey', in: 'header', name: 'x-location-id', description: 'Sub-Account bei Agentur-Schlüsseln' },
      },
      schemas: SCHEMAS,
    },
  };
}

// --- HTML reference ------------------------------------------------------------------------

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const slug = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function resolve(spec: any, schema: any): any {
  if (schema?.$ref) return spec.components.schemas[schema.$ref.split('/').pop()];
  return schema;
}

function typeOf(spec: any, schema: any): string {
  if (!schema) return '';
  if (schema.$ref) return schema.$ref.split('/').pop();
  if (schema.oneOf) return schema.oneOf.map((x: any) => typeOf(spec, x)).join(' | ');
  if (schema.anyOf) return schema.anyOf.map((x: any) => typeOf(spec, x)).join(' | ');
  if (schema.type === 'array') return `${typeOf(spec, schema.items)}[]`;
  return Array.isArray(schema.type) ? schema.type.join(' | ') : (schema.type ?? '');
}

function fieldsTable(spec: any, schema: any): string {
  const sc = resolve(spec, schema);
  if (!sc?.properties) return sc?.description ? `<p class="muted">${esc(sc.description)}</p>` : '';
  const req: string[] = sc.required ?? [];
  const rows = Object.entries<any>(sc.properties)
    .map(([k, v]) => `<tr><td><code>${esc(k)}</code>${req.includes(k) ? ' <span class="req">Pflicht</span>' : ''}</td><td class="muted">${esc(typeOf(spec, v))}</td><td>${esc([v.title, v.description, v.enum ? `(${v.enum.join(', ')})` : ''].filter(Boolean).join(' – '))}</td></tr>`)
    .join('');
  return `<table><tbody>${rows}</tbody></table>`;
}

function example(baseUrl: string, method: string, path: string, op: any, spec: any): string {
  const url = `${baseUrl}${path.replace(/\{(\w+)\}/g, '<$1>')}`;
  const auth = op.security && !op.security.length ? '' : ' \\\n  -H "Authorization: Bearer $KEY"';
  const body = op.requestBody ? resolve(spec, op.requestBody.content['application/json'].schema) : undefined;
  let data = '';
  if (body?.properties) {
    const ex: Record<string, any> = {};
    for (const k of (body.required?.length ? body.required : Object.keys(body.properties)).slice(0, 3)) ex[k] = body.properties[k]?.enum?.[0] ?? (typeOf(spec, body.properties[k]).endsWith('[]') ? [] : typeOf(spec, body.properties[k]) === 'number' ? 1 : '…');
    data = ` \\\n  -H 'content-type: application/json' -d '${JSON.stringify(ex)}'`;
  }
  return `curl -X ${method.toUpperCase()} "${url}"${auth}${data}`;
}

export function renderDocsHtml(spec: ReturnType<typeof buildOpenApi>, brand = 'HyperLevel'): string {
  const base = spec.servers[0].url;
  const byTag = new Map<string, { method: string; path: string; op: any }[]>();
  for (const [path, ops] of Object.entries(spec.paths)) for (const [method, op] of Object.entries<any>(ops)) (byTag.get(op.tags[0]) ?? byTag.set(op.tags[0], []).get(op.tags[0])!).push({ method, path, op });
  const tags = spec.tags.map((t) => t.name).filter((t) => byTag.has(t));
  const toc = tags.map((t) => `<a href="#${slug(t)}">${esc(t)} <span class="muted">${byTag.get(t)!.length}</span></a>`).join('');
  const sections = tags
    .map((t) => {
      const ops = byTag
        .get(t)!
        .map(({ method, path, op }) => {
          const params = (op.parameters ?? []).filter((p: Param) => p.in !== 'path');
          return `<details class="op" id="${esc(op.operationId)}"><summary><span class="m ${method}">${method.toUpperCase()}</span> <code>${esc(path)}</code> <span class="sum">${esc(op.summary)}</span>${op.security && !op.security.length ? ' <span class="pub">ohne Schlüssel</span>' : ''}</summary>
<div class="body">${op.description ? `<p>${esc(op.description).replace(/`([^`]+)`/g, '<code>$1</code>')}</p>` : ''}
${params.length ? `<h4>Parameter</h4><table><tbody>${params.map((p: Param) => `<tr><td><code>${esc(p.name)}</code></td><td class="muted">${esc(p.in)}</td><td>${esc(p.description)}</td></tr>`).join('')}</tbody></table>` : ''}
${op.requestBody ? `<h4>Body (JSON)</h4>${fieldsTable(spec, op.requestBody.content['application/json'].schema)}` : ''}
<h4>Beispiel</h4><pre>${esc(example(base, method, path, op, spec))}</pre></div></details>`;
        })
        .join('\n');
      return `<section id="${slug(t)}"><h2>${esc(t)}</h2>${ops}</section>`;
    })
    .join('\n');
  const triggers = HOOK_TRIGGERS.map((tr) => `<tr><td><code>${esc(tr.key)}</code></td><td>${esc(tr.label)}</td><td class="muted">${esc(tr.description)}</td></tr>`).join('');
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(brand)} – API-Referenz</title><meta name="robots" content="noindex">
<style>
:root{--bg:#f6f7fb;--panel:#fff;--text:#111827;--muted:#6b7280;--line:#e5e7eb;--brand:#2563eb;--code:#f1f5f9;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0b1020;--panel:#121a2e;--text:#e5e7eb;--muted:#94a3b8;--line:#233049;--brand:#60a5fa;--code:#0f172a;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
.wrap{display:grid;grid-template-columns:240px 1fr;max-width:1200px;margin:0 auto;gap:24px;padding:24px 16px}
nav{position:sticky;top:16px;align-self:start;display:flex;flex-direction:column;gap:2px;max-height:calc(100vh - 32px);overflow:auto}
nav a{color:var(--text);text-decoration:none;padding:5px 10px;border-radius:8px;display:flex;justify-content:space-between}nav a:hover{background:var(--panel)}
h1{font-size:24px;margin:0 0 6px}h2{font-size:18px;margin:28px 0 10px}h4{margin:14px 0 6px;font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.muted{color:var(--muted)}code{font:12px ui-monospace,Menlo,monospace;background:var(--code);padding:1px 5px;border-radius:5px}
pre{background:var(--code);padding:10px 12px;border-radius:8px;overflow-x:auto;font:12px/1.5 ui-monospace,Menlo,monospace;white-space:pre}
.card,.op{background:var(--panel);border:1px solid var(--line);border-radius:10px}.card{padding:16px}.op{margin:8px 0}
.op summary{cursor:pointer;padding:10px 12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;list-style:none}.op summary::-webkit-details-marker{display:none}
.op .body{padding:0 14px 12px;border-top:1px solid var(--line)}.sum{color:var(--muted)}
.m{font:700 11px ui-monospace,Menlo,monospace;padding:3px 7px;border-radius:6px;color:#fff;min-width:58px;text-align:center}
.m.get{background:#059669}.m.post{background:#2563eb}.m.patch{background:#d97706}.m.put{background:#7c3aed}.m.delete{background:#dc2626}
.pub,.req{font-size:11px;font-weight:600;padding:1px 7px;border-radius:99px;background:var(--code);color:var(--muted)}.req{color:#b45309}
table{width:100%;border-collapse:collapse}td{padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}tr:last-child td{border-bottom:0}
a{color:var(--brand)}
@media (max-width:800px){.wrap{grid-template-columns:1fr}nav{position:static;max-height:none;flex-direction:row;flex-wrap:wrap}}
</style></head><body><div class="wrap"><nav><strong style="padding:5px 10px">${esc(brand)} API</strong>${toc}<a href="/api/openapi.json">openapi.json ↗</a></nav><main>
<h1>API-Referenz</h1><p class="muted">Basis-URL <code>${esc(base)}</code> · OpenAPI 3.1: <a href="/api/openapi.json">/api/openapi.json</a> (z. B. für Postman, Insomnia oder n8n importieren)</p>
<div class="card"><h4 style="margin-top:0">Anmeldung</h4><p>Header <code>Authorization: Bearer pghl_…</code> – Schlüssel unter <b>Einstellungen → API &amp; Webhooks</b> (gilt für einen Sub-Account). Agentur-Schlüssel (<code>pghla_…</code>, <b>Agentur → API &amp; MCP</b>) zusätzlich mit <code>x-location-id: &lt;Sub-Account-ID&gt;</code>. Fehler kommen als <code>{"error":"…"}</code> mit HTTP-Status.</p>
<h4>REST-Hooks (Zapier, Make, n8n)</h4><p><code>POST /api/hooks</code> mit <code>{"target_url":"https://…","event":"contact.created"}</code> abonniert einen Auslöser, <code>DELETE /api/hooks/&lt;id&gt;</code> bestellt ab. Jede Zustellung trägt <code>x-pghl-signature = sha256(secret + body)</code>; Wiederholungen nach 1 Min., 5 Min., 30 Min., 2 Std. und 6 Std.; nach drei Antworten mit 410 wird das Abo deaktiviert.</p>
<table><tbody>${triggers}</tbody></table></div>
${sections}</main></div></body></html>`;
}
