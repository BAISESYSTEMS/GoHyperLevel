import { createHmac } from 'node:crypto';
import type { AppEvent } from '../core/events.js';
import { sha256 } from '../core/util.js';

/**
 * REST hooks (Zapier/Make/n8n "instant triggers"): the catalogue of triggers and actions, how an
 * app event becomes a payload, filters, retry timing and the signature. Pure – the module does I/O.
 */

export type FilterKey = 'tag' | 'pipeline_id' | 'stage_id' | 'form_id' | 'calendar_id' | 'product_id' | 'channel' | 'events';

export interface HookTrigger {
  key: string;
  label: string;
  description: string;
  /** App event types that feed this trigger ('*' = every event). */
  events: string[];
  /** Extra condition on the event data (e.g. status won). */
  when?: (data: Record<string, any>) => boolean;
  filters: FilterKey[];
  /** Example of `data` for the sample endpoint when nothing has happened yet. */
  sample: Record<string, any>;
}

export const FILTER_LABELS: Record<FilterKey, string> = {
  tag: 'Nur dieser Tag',
  pipeline_id: 'Nur diese Pipeline (ID)',
  stage_id: 'Nur diese Stufe (ID)',
  form_id: 'Nur dieses Formular (ID)',
  calendar_id: 'Nur dieser Kalender (ID)',
  product_id: 'Nur dieses Produkt (ID)',
  channel: 'Nur dieser Kanal (email, sms, chat, whatsapp, messenger, instagram)',
  events: 'Nur diese Ereignisse (Liste, leer = alle)',
};

const SAMPLE_OPP = { id: 'opp_123', name: 'Website-Relaunch', value: 4500, status: 'open', pipeline_id: 'pip_1', stage_id: 'stg_2' };
const SAMPLE_APPT = { id: 'apt_123', title: 'Erstgespräch', start_at: '2026-10-06T09:00:00.000Z', end_at: '2026-10-06T09:30:00.000Z', status: 'confirmed', calendar_id: 'cal_1' };

export const HOOK_TRIGGERS: HookTrigger[] = [
  { key: 'contact.created', label: 'Neuer Kontakt', description: 'Ein Kontakt wurde angelegt (Formular, API, Import, Chat …).', events: ['contact.created'], filters: [], sample: {} },
  { key: 'contact.updated', label: 'Kontakt geändert', description: 'Felder eines Kontakts haben sich geändert.', events: ['contact.updated'], filters: [], sample: { changed: ['phone'] } },
  { key: 'contact.tagged', label: 'Tag hinzugefügt', description: 'Ein Kontakt hat einen Tag bekommen.', events: ['contact.tag_added'], filters: ['tag'], sample: { tag: 'lead' } },
  { key: 'opportunity.created', label: 'Neue Opportunity', description: 'Ein Deal wurde angelegt.', events: ['opportunity.created'], filters: ['pipeline_id'], sample: { opportunity: SAMPLE_OPP, pipelineId: 'pip_1', stageId: 'stg_1' } },
  { key: 'opportunity.stage_changed', label: 'Pipeline-Stufe geändert', description: 'Ein Deal ist in eine andere Stufe gewandert.', events: ['opportunity.stage_changed'], filters: ['pipeline_id', 'stage_id'], sample: { opportunity: SAMPLE_OPP, fromStageId: 'stg_1', stageId: 'stg_2', pipelineId: 'pip_1' } },
  { key: 'opportunity.won', label: 'Deal gewonnen', description: 'Ein Deal wurde auf „gewonnen“ gesetzt.', events: ['opportunity.status_changed'], when: (d) => d.status === 'won', filters: ['pipeline_id'], sample: { opportunity: { ...SAMPLE_OPP, status: 'won' }, status: 'won', pipelineId: 'pip_1' } },
  { key: 'opportunity.lost', label: 'Deal verloren', description: 'Ein Deal wurde auf „verloren“ gesetzt.', events: ['opportunity.status_changed'], when: (d) => d.status === 'lost', filters: ['pipeline_id'], sample: { opportunity: { ...SAMPLE_OPP, status: 'lost' }, status: 'lost', pipelineId: 'pip_1' } },
  { key: 'form.submitted', label: 'Formular eingereicht', description: 'Ein Formular oder eine Umfrage wurde abgeschickt.', events: ['form.submitted'], filters: ['form_id'], sample: { formId: 'frm_1', answers: { email: 'anna@example.com', nachricht: 'Bitte um Rückruf' } } },
  { key: 'appointment.booked', label: 'Termin gebucht', description: 'Ein Termin wurde gebucht.', events: ['appointment.booked'], filters: ['calendar_id'], sample: { appointment: SAMPLE_APPT, calendarId: 'cal_1' } },
  { key: 'appointment.cancelled', label: 'Termin abgesagt', description: 'Ein Termin wurde abgesagt (auch über Google/Outlook).', events: ['appointment.status_changed'], when: (d) => d.status === 'cancelled', filters: ['calendar_id'], sample: { appointment: { ...SAMPLE_APPT, status: 'cancelled' }, status: 'cancelled', calendarId: 'cal_1' } },
  { key: 'invoice.paid', label: 'Rechnung bezahlt', description: 'Eine Rechnung wurde bezahlt (von Hand oder per Stripe).', events: ['invoice.paid'], filters: [], sample: { invoice: { id: 'inv_1', number: 'RE-1001', total_cents: 119000, currency: 'EUR', status: 'paid' } } },
  { key: 'product.purchased', label: 'Produkt gekauft', description: 'Ein Produkt wurde über einen Kauf-Link bezahlt.', events: ['product.purchased'], filters: ['product_id'], sample: { productId: 'prd_1', product: { id: 'prd_1', name: 'Online-Kurs' }, invoiceId: 'inv_1', amount_cents: 19900, currency: 'EUR' } },
  { key: 'task.completed', label: 'Aufgabe erledigt', description: 'Eine Aufgabe wurde als erledigt markiert.', events: ['task.completed'], filters: [], sample: { task: { id: 'tsk_1', title: 'Angebot nachfassen', done: 1, completed_at: '2026-10-04T10:00:00.000Z' } } },
  { key: 'message.inbound', label: 'Nachricht empfangen', description: 'Eine E-Mail, SMS, Chat- oder WhatsApp-Nachricht ist eingegangen.', events: ['message.inbound'], filters: ['channel'], sample: { message: { id: 'msg_1', channel: 'email', subject: 'Anfrage', body: 'Hallo, ich hätte eine Frage …' } } },
  { key: 'call.missed', label: 'Anruf verpasst', description: 'Ein eingehender Anruf wurde nicht angenommen.', events: ['call.missed'], filters: [], sample: { callId: 'call_1', direction: 'in', status: 'missed', from: '+4915112345678', to: '+4930123456' } },
  { key: 'review.received', label: 'Bewertung erhalten', description: 'Eine Bewertung kam herein (eigene Anfrage, Google oder eine weitere Plattform wie Trustpilot).', events: ['review.received', 'google_review.received'], filters: [], sample: { rating: 5, comment: 'Super Service!' } },
  { key: 'any', label: 'Jedes Ereignis', description: 'Alle Ereignisse des Sub-Accounts – optional auf eine Liste von Ereignistypen begrenzt.', events: ['*'], filters: ['events'], sample: {} },
];

export const triggerByKey = (key: string) => HOOK_TRIGGERS.find((t) => t.key === key);

/** Trigger keys an app event feeds (before subscription filters). */
export function triggersForEvent(e: Pick<AppEvent, 'type' | 'data'>): HookTrigger[] {
  return HOOK_TRIGGERS.filter((t) => (t.events.includes('*') || t.events.includes(e.type)) && (!t.when || t.when(e.data ?? {})));
}

/** Cleans the filters of a subscription to the ones its trigger supports. */
export function cleanFilters(trigger: HookTrigger, input: Record<string, any> = {}): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of trigger.filters) {
    const v = input[k];
    if (v === undefined || v === null || v === '') continue;
    if (k === 'events') {
      const list = (Array.isArray(v) ? v : String(v).split(',')).map((s) => String(s).trim()).filter((s) => /^[a-z_]+\.[a-z_.]+$/.test(s));
      if (list.length) out.events = list.slice(0, 50);
    } else out[k] = String(v).trim().slice(0, 200);
  }
  return out;
}

export function filtersMatch(filters: Record<string, any>, e: Pick<AppEvent, 'type' | 'data'>): boolean {
  const d = e.data ?? {};
  for (const [k, v] of Object.entries(filters ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    switch (k as FilterKey) {
      case 'tag':
        if (d.tag !== v) return false;
        break;
      case 'pipeline_id':
        if ((d.pipelineId ?? d.opportunity?.pipeline_id) !== v) return false;
        break;
      case 'stage_id':
        if ((d.stageId ?? d.opportunity?.stage_id) !== v) return false;
        break;
      case 'form_id':
        if (d.formId !== v) return false;
        break;
      case 'calendar_id':
        if ((d.calendarId ?? d.appointment?.calendar_id) !== v) return false;
        break;
      case 'product_id':
        if (d.productId !== v) return false;
        break;
      case 'channel':
        if ((d.message?.channel ?? d.channel) !== v) return false;
        break;
      case 'events':
        if (Array.isArray(v) && v.length && !v.includes(e.type)) return false;
        break;
    }
  }
  return true;
}

const MAX_DATA_BYTES = 200_000;

/** The JSON a subscriber receives: flat top level (Zapier/Make map these fields), the raw event under `data`. */
export function buildPayload(triggerKey: string, e: AppEvent, eventId: string, contact?: Record<string, any> | null) {
  const { contact: _c, ...rest } = e.data ?? {};
  let data: Record<string, any> = rest;
  let truncated = false;
  if (JSON.stringify(rest).length > MAX_DATA_BYTES) {
    data = {};
    truncated = true;
  }
  return {
    id: eventId,
    event: triggerKey,
    type: e.type,
    location_id: e.locationId,
    occurred_at: e.at,
    contact_id: e.data?.contactId ?? null,
    contact: contact ?? null,
    data,
    ...(truncated ? { data_truncated: true } : {}),
  };
}

export const SAMPLE_CONTACT = {
  id: 'con_123',
  first_name: 'Anna',
  last_name: 'Beispiel',
  email: 'anna@example.com',
  phone: '+4915112345678',
  company: 'Beispiel GmbH',
  city: 'Berlin',
  country: 'DE',
  tags: ['lead'],
  custom: { budget: '5000' },
  source: 'Formular',
  created_at: '2026-10-04T09:00:00.000Z',
  updated_at: '2026-10-04T09:00:00.000Z',
};

/** A made-up payload for setup screens (Zapier "test trigger", Make "sample"). */
export function staticSample(trigger: HookTrigger, locationId: string) {
  return {
    id: `sample_${trigger.key.replace(/\W/g, '_')}`,
    event: trigger.key,
    type: trigger.events[0] === '*' ? 'contact.created' : trigger.events[0],
    location_id: locationId,
    occurred_at: '2026-10-04T09:00:00.000Z',
    contact_id: SAMPLE_CONTACT.id,
    contact: SAMPLE_CONTACT,
    data: { contactId: SAMPLE_CONTACT.id, ...trigger.sample },
    sample: true,
  };
}

/** Delays before attempt 2, 3, … (attempt 1 is immediate). */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
/** After this many 410 Gone answers in a row the subscription is switched off. */
export const GONE_LIMIT = 3;

export function retryDelayMs(attemptsDone: number): number | null {
  return attemptsDone >= MAX_ATTEMPTS ? null : RETRY_DELAYS_MS[Math.max(0, attemptsDone - 1)];
}

/** Network errors (0), timeouts, rate limits and server errors are worth another try; other 4xx are not. */
export const shouldRetry = (status: number) => status === 0 || status === 408 || status === 429 || status >= 500;

/** Same scheme as the outgoing webhooks: hex sha256(secret + body) in x-pghl-signature (kept for existing receivers). */
export const signBody = (secret: string, body: string) => sha256(secret + body);
/** Preferred: `sha256=<hex HMAC-SHA256(secret, body)>` in x-pghl-signature-256 (no length-extension, standard tooling). */
export const hmacSignature = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;

export type HookSource = 'zapier' | 'make' | 'n8n' | 'api';
export const HOOK_SOURCES: HookSource[] = ['zapier', 'make', 'n8n', 'api'];

export function detectSource(url: string, userAgent = '', explicit?: unknown): HookSource {
  if (typeof explicit === 'string' && (HOOK_SOURCES as string[]).includes(explicit)) return explicit as HookSource;
  let host = '';
  let path = '';
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    path = u.pathname;
  } catch {
    /* validated elsewhere */
  }
  const ua = userAgent.toLowerCase();
  if (host.endsWith('zapier.com') || ua.includes('zapier')) return 'zapier';
  if (host.endsWith('make.com') || host.endsWith('integromat.com') || ua.includes('make.com') || ua.includes('integromat')) return 'make';
  if (host.includes('n8n') || ua.includes('n8n') || /\/webhook(-test)?\//.test(path)) return 'n8n';
  return 'api';
}

// --- actions ------------------------------------------------------------------------

export interface HookField {
  key: string;
  label: string;
  type: 'string' | 'text' | 'number' | 'boolean' | 'datetime' | 'array' | 'object';
  required?: boolean;
  help?: string;
  choices?: string[];
}

export interface HookAction {
  key: string;
  label: string;
  description: string;
  fields: HookField[];
}

const WHO: HookField[] = [
  { key: 'contact_id', label: 'Kontakt-ID', type: 'string', help: 'Oder E-Mail/Telefon angeben' },
  { key: 'email', label: 'E-Mail', type: 'string' },
  { key: 'phone', label: 'Telefon', type: 'string' },
];
const CONTACT_FIELDS: HookField[] = [
  { key: 'first_name', label: 'Vorname', type: 'string' },
  { key: 'last_name', label: 'Nachname', type: 'string' },
  { key: 'company', label: 'Firma', type: 'string' },
  { key: 'address', label: 'Adresse', type: 'string' },
  { key: 'city', label: 'Ort', type: 'string' },
  { key: 'postal_code', label: 'PLZ', type: 'string' },
  { key: 'country', label: 'Land', type: 'string' },
  { key: 'website', label: 'Website', type: 'string' },
  { key: 'source', label: 'Quelle', type: 'string' },
  { key: 'tags', label: 'Tags', type: 'array', help: 'Liste oder durch Komma getrennt' },
  { key: 'custom', label: 'Eigene Felder', type: 'object', help: 'Objekt { feld_schluessel: wert }' },
];

export const HOOK_ACTIONS: HookAction[] = [
  { key: 'create_contact', label: 'Kontakt anlegen oder aktualisieren', description: 'Legt einen Kontakt an; gibt es E-Mail oder Telefon schon, wird er aktualisiert.', fields: [WHO[1], WHO[2], ...CONTACT_FIELDS] },
  { key: 'update_contact', label: 'Kontakt aktualisieren', description: 'Ändert einen bestehenden Kontakt (per ID, E-Mail oder Telefon gefunden).', fields: [...WHO, { key: 'new_email', label: 'Neue E-Mail', type: 'string' }, ...CONTACT_FIELDS] },
  { key: 'add_tag', label: 'Tag hinzufügen', description: 'Fügt Tags hinzu; ein unbekannter Kontakt mit E-Mail wird angelegt.', fields: [...WHO, { key: 'tags', label: 'Tags', type: 'array', required: true }] },
  { key: 'remove_tag', label: 'Tag entfernen', description: 'Entfernt Tags von einem Kontakt.', fields: [...WHO, { key: 'tags', label: 'Tags', type: 'array', required: true }] },
  {
    key: 'create_opportunity',
    label: 'Opportunity anlegen',
    description: 'Legt einen Deal an; Pipeline und Stufe per ID oder Name (Standard: erste Pipeline, erste Stufe).',
    fields: [...WHO, { key: 'first_name', label: 'Vorname (falls neu)', type: 'string' }, { key: 'last_name', label: 'Nachname (falls neu)', type: 'string' }, { key: 'pipeline', label: 'Pipeline (ID oder Name)', type: 'string' }, { key: 'stage', label: 'Stufe (ID oder Name)', type: 'string' }, { key: 'name', label: 'Name', type: 'string' }, { key: 'value', label: 'Wert', type: 'number' }, { key: 'currency', label: 'Währung (EUR, USD …)', type: 'string' }, { key: 'expected_close_date', label: 'Erwarteter Abschluss (JJJJ-MM-TT)', type: 'string' }, { key: 'status', label: 'Status', type: 'string', choices: ['open', 'won', 'lost', 'abandoned'] }, { key: 'lost_reason', label: 'Verlustgrund (Pflicht bei lost)', type: 'string' }],
  },
  { key: 'move_stage', label: 'Opportunity verschieben', description: 'Setzt Stufe und/oder Status eines Deals; bei „lost“ ist der Verlustgrund Pflicht.', fields: [{ key: 'opportunity_id', label: 'Opportunity-ID', type: 'string', required: true }, { key: 'stage', label: 'Stufe (ID oder Name)', type: 'string' }, { key: 'status', label: 'Status', type: 'string', choices: ['open', 'won', 'lost', 'abandoned'] }, { key: 'lost_reason', label: 'Verlustgrund (Pflicht bei lost)', type: 'string' }, { key: 'expected_close_date', label: 'Erwarteter Abschluss (JJJJ-MM-TT)', type: 'string' }] },
  { key: 'create_task', label: 'Aufgabe anlegen', description: 'Legt eine Aufgabe an, optional für einen Kontakt.', fields: [...WHO, { key: 'title', label: 'Titel', type: 'string', required: true }, { key: 'description', label: 'Beschreibung', type: 'text' }, { key: 'due_at', label: 'Fällig am', type: 'datetime' }] },
  { key: 'add_note', label: 'Notiz hinzufügen', description: 'Hängt eine Notiz an einen Kontakt; ein unbekannter Kontakt mit E-Mail wird angelegt.', fields: [...WHO, { key: 'body', label: 'Notiz', type: 'text', required: true }] },
  { key: 'send_message', label: 'Nachricht senden', description: 'Schickt eine E-Mail, SMS, Chat- oder WhatsApp-Nachricht an einen Kontakt.', fields: [...WHO, { key: 'channel', label: 'Kanal', type: 'string', choices: ['email', 'sms', 'chat', 'whatsapp', 'messenger', 'instagram'] }, { key: 'subject', label: 'Betreff (E-Mail)', type: 'string' }, { key: 'body', label: 'Text', type: 'text', required: true }] },
  {
    key: 'create_invoice_draft',
    label: 'Rechnungsentwurf anlegen',
    description: 'Legt eine Rechnung als Entwurf an (wird nicht verschickt).',
    fields: [...WHO, { key: 'title', label: 'Titel', type: 'string' }, { key: 'items', label: 'Positionen', type: 'array', required: true, help: '[{ "name": "Beratung", "qty": 2, "price": 120 }] – price in €, alternativ price_cents' }, { key: 'due_at', label: 'Fällig am', type: 'datetime' }, { key: 'notes', label: 'Hinweise', type: 'text' }, { key: 'currency', label: 'Währung', type: 'string' }],
  },
];

export const actionByKey = (key: string) => HOOK_ACTIONS.find((a) => a.key === key);

/** "a, b" or ["a","b"] → ["a","b"]. */
export function toList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((x) => x.trim()).filter(Boolean);
  return [];
}

/** Invoice lines from Zapier/Make: price in euros (or price_cents), qty defaults to 1. */
export function invoiceItems(v: unknown): { name: string; description: string; qty: number; price_cents: number; tax_rate?: number }[] {
  let list: any[] = [];
  if (Array.isArray(v)) list = v;
  else if (typeof v === 'string' && v.trim().startsWith('[')) {
    try {
      list = JSON.parse(v);
    } catch {
      list = [];
    }
  } else if (v && typeof v === 'object') list = [v];
  return list.slice(0, 200).map((it: any) => {
    const cents = it?.price_cents !== undefined ? Number(it.price_cents) : Math.round(Number(String(it?.price ?? 0).replace(',', '.')) * 100);
    return {
      name: String(it?.name ?? it?.title ?? 'Position'),
      description: String(it?.description ?? ''),
      qty: Number(it?.qty ?? it?.quantity ?? 1) || 1,
      price_cents: Number.isFinite(cents) ? Math.round(cents) : 0,
      ...(it?.tax_rate !== undefined ? { tax_rate: Number(it.tax_rate) } : {}),
    };
  });
}
