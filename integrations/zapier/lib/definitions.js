'use strict';

/**
 * What the HyperLevel server offers (GET /api/hooks/triggers and /api/hooks/actions), as Zapier
 * definitions. Kept in sync with server/services/rest-hooks.ts by the repo's test suite.
 */

const CONTACT_SAMPLE = {
  id: 'con_123',
  first_name: 'Anna',
  last_name: 'Beispiel',
  email: 'anna@example.com',
  phone: '+4915112345678',
  company: 'Beispiel GmbH',
  tags: ['lead'],
  custom: { budget: '5000' },
  created_at: '2026-10-04T09:00:00.000Z',
};

const sample = (event, type, data = {}) => ({
  id: `sample_${event.replace(/\W/g, '_')}`,
  event,
  type,
  location_id: 'loc_123',
  occurred_at: '2026-10-04T09:00:00.000Z',
  contact_id: CONTACT_SAMPLE.id,
  contact: CONTACT_SAMPLE,
  data: { contactId: CONTACT_SAMPLE.id, ...data },
});

const OPP = { id: 'opp_123', name: 'Website-Relaunch', value: 4500, status: 'open', pipeline_id: 'pip_1', stage_id: 'stg_2' };
const APPT = { id: 'apt_123', title: 'Erstgespräch', start_at: '2026-10-06T09:00:00.000Z', end_at: '2026-10-06T09:30:00.000Z', status: 'confirmed' };

/** filter keys → Zapier input fields */
const FILTER_FIELDS = {
  tag: { key: 'tag', label: 'Nur dieser Tag', helpText: 'Leer = jeder Tag', dynamic: 'tag_list.id.name' },
  pipeline_id: { key: 'pipeline_id', label: 'Nur diese Pipeline', dynamic: 'pipeline_list.id.name' },
  stage_id: { key: 'stage_id', label: 'Nur diese Stufe', dynamic: 'stage_list.id.name' },
  form_id: { key: 'form_id', label: 'Nur dieses Formular', dynamic: 'form_list.id.name' },
  calendar_id: { key: 'calendar_id', label: 'Nur dieser Kalender', dynamic: 'calendar_list.id.name' },
  product_id: { key: 'product_id', label: 'Nur dieses Produkt', dynamic: 'product_list.id.name' },
  channel: { key: 'channel', label: 'Nur dieser Kanal', choices: { email: 'E-Mail', sms: 'SMS', chat: 'Live-Chat', whatsapp: 'WhatsApp', messenger: 'Messenger', instagram: 'Instagram' } },
  events: { key: 'events', label: 'Nur diese Ereignistypen', list: true, helpText: 'z. B. contact.created, invoice.paid – leer = alle' },
};

const TRIGGERS = [
  { key: 'contact_created', event: 'contact.created', noun: 'Kontakt', label: 'Neuer Kontakt', description: 'Startet, wenn ein Kontakt angelegt wird.', filters: [], sample: sample('contact.created', 'contact.created') },
  { key: 'contact_updated', event: 'contact.updated', noun: 'Kontakt', label: 'Kontakt geändert', description: 'Startet, wenn sich Felder eines Kontakts ändern.', filters: [], sample: sample('contact.updated', 'contact.updated', { changed: ['phone'] }) },
  { key: 'contact_tagged', event: 'contact.tagged', noun: 'Kontakt', label: 'Tag hinzugefügt', description: 'Startet, wenn ein Kontakt einen Tag bekommt.', filters: ['tag'], sample: sample('contact.tagged', 'contact.tag_added', { tag: 'lead' }) },
  { key: 'opportunity_created', event: 'opportunity.created', noun: 'Opportunity', label: 'Neue Opportunity', description: 'Startet, wenn ein Deal angelegt wird.', filters: ['pipeline_id'], sample: sample('opportunity.created', 'opportunity.created', { opportunity: OPP }) },
  { key: 'opportunity_stage_changed', event: 'opportunity.stage_changed', noun: 'Opportunity', label: 'Pipeline-Stufe geändert', description: 'Startet, wenn ein Deal in eine andere Stufe wandert.', filters: ['pipeline_id', 'stage_id'], sample: sample('opportunity.stage_changed', 'opportunity.stage_changed', { opportunity: OPP, stageId: 'stg_2' }) },
  { key: 'opportunity_won', event: 'opportunity.won', noun: 'Opportunity', label: 'Deal gewonnen', description: 'Startet, wenn ein Deal gewonnen wird.', filters: ['pipeline_id'], sample: sample('opportunity.won', 'opportunity.status_changed', { opportunity: { ...OPP, status: 'won' }, status: 'won' }) },
  { key: 'opportunity_lost', event: 'opportunity.lost', noun: 'Opportunity', label: 'Deal verloren', description: 'Startet, wenn ein Deal verloren geht.', filters: ['pipeline_id'], sample: sample('opportunity.lost', 'opportunity.status_changed', { opportunity: { ...OPP, status: 'lost' }, status: 'lost' }) },
  { key: 'form_submitted', event: 'form.submitted', noun: 'Einsendung', label: 'Formular eingereicht', description: 'Startet, wenn ein Formular oder eine Umfrage abgeschickt wird.', filters: ['form_id'], sample: sample('form.submitted', 'form.submitted', { formId: 'frm_1', answers: { email: 'anna@example.com', nachricht: 'Bitte um Rückruf' } }) },
  { key: 'appointment_booked', event: 'appointment.booked', noun: 'Termin', label: 'Termin gebucht', description: 'Startet, wenn ein Termin gebucht wird.', filters: ['calendar_id'], sample: sample('appointment.booked', 'appointment.booked', { appointment: APPT, calendarId: 'cal_1' }) },
  { key: 'appointment_cancelled', event: 'appointment.cancelled', noun: 'Termin', label: 'Termin abgesagt', description: 'Startet, wenn ein Termin abgesagt wird.', filters: ['calendar_id'], sample: sample('appointment.cancelled', 'appointment.status_changed', { appointment: { ...APPT, status: 'cancelled' }, status: 'cancelled' }) },
  { key: 'invoice_paid', event: 'invoice.paid', noun: 'Rechnung', label: 'Rechnung bezahlt', description: 'Startet, wenn eine Rechnung bezahlt wird.', filters: [], sample: sample('invoice.paid', 'invoice.paid', { invoice: { id: 'inv_1', number: 'RE-1001', total_cents: 119000, currency: 'EUR', status: 'paid' } }) },
  { key: 'product_purchased', event: 'product.purchased', noun: 'Kauf', label: 'Produkt gekauft', description: 'Startet, wenn ein Produkt über einen Kauf-Link bezahlt wird.', filters: ['product_id'], sample: sample('product.purchased', 'product.purchased', { productId: 'prd_1', amount_cents: 19900, currency: 'EUR' }) },
  { key: 'task_completed', event: 'task.completed', noun: 'Aufgabe', label: 'Aufgabe erledigt', description: 'Startet, wenn eine Aufgabe erledigt wird.', filters: [], sample: sample('task.completed', 'task.completed', { task: { id: 'tsk_1', title: 'Angebot nachfassen', done: 1 } }) },
  { key: 'message_inbound', event: 'message.inbound', noun: 'Nachricht', label: 'Nachricht empfangen', description: 'Startet bei jeder eingehenden E-Mail, SMS, Chat- oder WhatsApp-Nachricht.', filters: ['channel'], sample: sample('message.inbound', 'message.inbound', { message: { id: 'msg_1', channel: 'email', subject: 'Anfrage', body: 'Hallo …' } }) },
  { key: 'call_missed', event: 'call.missed', noun: 'Anruf', label: 'Anruf verpasst', description: 'Startet, wenn ein eingehender Anruf nicht angenommen wird.', filters: [], sample: sample('call.missed', 'call.missed', { callId: 'call_1', from: '+4915112345678' }) },
  { key: 'review_received', event: 'review.received', noun: 'Bewertung', label: 'Bewertung erhalten', description: 'Startet, wenn eine Bewertung hereinkommt (auch Google).', filters: [], sample: sample('review.received', 'review.received', { rating: 5, comment: 'Super Service!' }) },
  { key: 'any_event', event: 'any', noun: 'Ereignis', label: 'Jedes Ereignis', description: 'Startet bei jedem Ereignis des Sub-Accounts (optional auf Typen begrenzt).', filters: ['events'], sample: sample('any', 'contact.created') },
];

const WHO = [
  { key: 'contact_id', label: 'Kontakt-ID', helpText: 'Oder E-Mail/Telefon angeben' },
  { key: 'email', label: 'E-Mail' },
  { key: 'phone', label: 'Telefon' },
];
const CONTACT_FIELDS = [
  { key: 'first_name', label: 'Vorname' },
  { key: 'last_name', label: 'Nachname' },
  { key: 'company', label: 'Firma' },
  { key: 'address', label: 'Adresse' },
  { key: 'city', label: 'Ort' },
  { key: 'postal_code', label: 'PLZ' },
  { key: 'country', label: 'Land' },
  { key: 'website', label: 'Website' },
  { key: 'source', label: 'Quelle' },
  { key: 'tags', label: 'Tags', list: true },
  { key: 'custom', label: 'Eigene Felder', dict: true, helpText: 'Schlüssel des eigenen Felds → Wert' },
];
const STATUS_CHOICES = { open: 'Offen', won: 'Gewonnen', lost: 'Verloren', abandoned: 'Aufgegeben' };

const ACTIONS = [
  { key: 'create_contact', noun: 'Kontakt', label: 'Kontakt anlegen oder aktualisieren', description: 'Legt einen Kontakt an; bei gleicher E-Mail/Telefon wird er aktualisiert.', fields: [WHO[1], WHO[2], ...CONTACT_FIELDS] },
  { key: 'update_contact', noun: 'Kontakt', label: 'Kontakt aktualisieren', description: 'Ändert einen bestehenden Kontakt.', fields: [...WHO, { key: 'new_email', label: 'Neue E-Mail' }, ...CONTACT_FIELDS] },
  { key: 'add_tag', noun: 'Kontakt', label: 'Tag hinzufügen', description: 'Fügt einem Kontakt Tags hinzu (legt ihn bei Bedarf an).', fields: [...WHO, { key: 'tags', label: 'Tags', list: true, required: true, dynamic: 'tag_list.id.name' }] },
  { key: 'remove_tag', noun: 'Kontakt', label: 'Tag entfernen', description: 'Entfernt Tags von einem Kontakt.', fields: [...WHO, { key: 'tags', label: 'Tags', list: true, required: true, dynamic: 'tag_list.id.name' }] },
  {
    key: 'create_opportunity',
    noun: 'Opportunity',
    label: 'Opportunity anlegen',
    description: 'Legt einen Deal für einen Kontakt an.',
    fields: [...WHO, { key: 'first_name', label: 'Vorname (falls neu)' }, { key: 'last_name', label: 'Nachname (falls neu)' }, { key: 'pipeline', label: 'Pipeline', dynamic: 'pipeline_list.id.name' }, { key: 'stage', label: 'Stufe', dynamic: 'stage_list.id.name', helpText: 'ID oder Name der Stufe' }, { key: 'name', label: 'Name' }, { key: 'value', label: 'Wert (€)', type: 'number' }, { key: 'status', label: 'Status', choices: STATUS_CHOICES }],
  },
  { key: 'move_stage', noun: 'Opportunity', label: 'Opportunity verschieben', description: 'Setzt Stufe und/oder Status eines Deals.', fields: [{ key: 'opportunity_id', label: 'Opportunity-ID', required: true }, { key: 'stage', label: 'Stufe', dynamic: 'stage_list.id.name' }, { key: 'status', label: 'Status', choices: STATUS_CHOICES }] },
  { key: 'create_task', noun: 'Aufgabe', label: 'Aufgabe anlegen', description: 'Legt eine Aufgabe an, optional für einen Kontakt.', fields: [...WHO, { key: 'title', label: 'Titel', required: true }, { key: 'description', label: 'Beschreibung', type: 'text' }, { key: 'due_at', label: 'Fällig am', type: 'datetime' }] },
  { key: 'add_note', noun: 'Notiz', label: 'Notiz hinzufügen', description: 'Hängt eine Notiz an einen Kontakt.', fields: [...WHO, { key: 'body', label: 'Notiz', type: 'text', required: true }] },
  { key: 'send_message', noun: 'Nachricht', label: 'Nachricht senden', description: 'Schickt eine E-Mail, SMS, Chat- oder WhatsApp-Nachricht.', fields: [...WHO, { key: 'channel', label: 'Kanal', choices: { email: 'E-Mail', sms: 'SMS', chat: 'Live-Chat', whatsapp: 'WhatsApp', messenger: 'Messenger', instagram: 'Instagram' }, default: 'email' }, { key: 'subject', label: 'Betreff (E-Mail)' }, { key: 'body', label: 'Text', type: 'text', required: true }] },
  {
    key: 'create_invoice_draft',
    noun: 'Rechnung',
    label: 'Rechnungsentwurf anlegen',
    description: 'Legt eine Rechnung als Entwurf an (wird nicht verschickt).',
    fields: [...WHO, { key: 'title', label: 'Titel' }, { key: 'items', label: 'Positionen', required: true, children: [{ key: 'name', label: 'Position', required: true }, { key: 'qty', label: 'Menge', type: 'number' }, { key: 'price', label: 'Preis netto (€)', type: 'number' }, { key: 'tax_rate', label: 'USt. %', type: 'number' }] }, { key: 'due_at', label: 'Fällig am', type: 'datetime' }, { key: 'notes', label: 'Hinweise', type: 'text' }],
  },
];

module.exports = { TRIGGERS, ACTIONS, FILTER_FIELDS, CONTACT_SAMPLE };
