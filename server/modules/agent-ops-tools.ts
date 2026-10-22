import type { Module } from '../core/app.js';
import { HttpError } from '../core/http.js';
import { id } from '../core/util.js';
import type { Tool } from './mcp.js';
import { mappingSummary } from './form-mapping.js';

/**
 * Everyday operations for agents (docs/agent.md#abdeckung): the high-value actions a busy admin asks for most – tasks,
 * appointments, contacts, reply drafts, invoices, campaign drafts, workflows, form/survey results, reviews and the business
 * settings – as specific MCP tools, so models pick them reliably instead of composing ghl_api calls. Each one is a thin relay onto
 * the existing REST route (rights, sub-account, validation, events, undo journal and audit log apply unchanged). Outbound or hard
 * to undo (cancelling an appointment, marking a no-show, merging contacts, enrolling in or activating a workflow, booking with a
 * confirmation mail) is marked so the HyperLevel Agent always asks first; drafts never send, and the create/update tools pass on
 * only the fields their schema names. Results are trimmed to what a model needs.
 */

type Json = Record<string, any>;
const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const obj = (props: Json, required: string[] = []) => ({ type: 'object', properties: { ...LOC, ...props }, required, additionalProperties: false });
const RO = { readOnlyHint: true, openWorldHint: false };
const W = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const enc = encodeURIComponent;
const q = (params: Record<string, unknown>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : '';
};
const cut = (v: unknown, n = 300) => (typeof v === 'string' && v.length > n ? `${v.slice(0, n)}…` : v);
const name = (r: any) => [r?.first_name, r?.last_name].filter(Boolean).join(' ') || r?.name || r?.email || undefined;
const limitOf = (v: unknown, def: number, max: number) => Math.min(Math.max(Number(v) || def, 1), max);
const list = (r: any): any[] => (Array.isArray(r) ? r : (r?.items ?? r?.rows ?? []));
/**
 * Only the named arguments that were given: models may add properties the schema does not list (normalizeArgs keeps them), and
 * the routes accept more than a tool promises – a recurring auto-sent invoice, a payment link, replacing all tags.
 */
const pick = (a: Json, keys: string[]): Json => Object.fromEntries(keys.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
/** Statuses ghl_update_appointment may set; cancelling is ghl_cancel_appointment (always confirmed). */
const APPT_STATUS = ['confirmed', 'showed', 'noshow'];
const CONTACT_PROPS: Json = {
  first_name: { type: 'string' },
  last_name: { type: 'string' },
  email: { type: 'string' },
  phone: { type: 'string' },
  company: { type: 'string' },
  address: { type: 'string' },
  city: { type: 'string' },
  postal_code: { type: 'string' },
  country: { type: 'string' },
  website: { type: 'string' },
  source: { type: 'string' },
  assigned_to: { type: 'string' },
  dnd: { type: 'boolean' },
  custom: { type: 'object' },
};

export const OPS_TOOLS: Tool[] = [
  // --- tasks ---------------------------------------------------------------------------------------------------------------
  {
    name: 'ghl_update_task',
    title: 'Aufgabe ändern',
    description: 'Ändert eine Aufgabe: Titel, Beschreibung, Fälligkeit (ISO 8601, leer = keine), zuständige Person (Nutzer-ID) oder erledigt/wieder offen (done).',
    inputSchema: obj({ task_id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, due_at: { type: 'string' }, assigned_to: { type: 'string' }, done: { type: 'boolean' } }, ['task_id']),
    annotations: { ...W, idempotentHint: true },
    run: (call, a) => {
      const body: Json = {};
      for (const k of ['title', 'description', 'due_at', 'assigned_to', 'done']) if (a[k] !== undefined) body[k] = k === 'due_at' && a[k] === '' ? null : a[k];
      return call.api('PATCH', `/api/tasks/${enc(a.task_id)}`, { location: a.location_id, body });
    },
  },
  // --- appointments --------------------------------------------------------------------------------------------------------
  {
    name: 'ghl_list_appointments',
    title: 'Termine auflisten',
    description: 'Termine im Zeitraum (from/to ISO, Standard: 7 Tage zurück bis 60 Tage voraus), optional je Kalender oder Kontakt. Kurzform mit ID, Zeit, Status, Kalender und Kontakt.',
    inputSchema: obj({ from: { type: 'string' }, to: { type: 'string' }, calendar_id: { type: 'string' }, contact_id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } }),
    annotations: RO,
    // titles and notes come from the public booking page
    untrusted: true,
    run: async (call, a) => {
      const rows = list(await call.api('GET', `/api/appointments${q({ from: a.from, to: a.to, calendar_id: a.calendar_id, contact_id: a.contact_id })}`, { location: a.location_id }));
      const n = limitOf(a.limit, 50, 200);
      return {
        total: rows.length,
        appointments: rows.slice(0, n).map((r) => ({ id: r.id, title: r.title || undefined, start_at: r.start_at, end_at: r.end_at, status: r.status, calendar: r.calendar_name, calendar_id: r.calendar_id, contact_id: r.contact_id || undefined, contact: name(r), notes: cut(r.notes, 200) || undefined })),
      };
    },
  },
  {
    name: 'ghl_create_appointment',
    title: 'Termin anlegen',
    description: 'Legt einen Termin für einen Kontakt in einem Kalender an (start ISO 8601; die Dauer kommt vom Kalender). force = auch außerhalb freier Zeiten. Der Kontakt bekommt die Terminbestätigung des Kalenders, wenn sie eingeschaltet ist. Für eine reine Blockzeit blocked = true mit title, start, end.',
    inputSchema: obj({ calendar_id: { type: 'string' }, contact_id: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, notes: { type: 'string' }, force: { type: 'boolean' }, blocked: { type: 'boolean' }, title: { type: 'string' } }, ['calendar_id', 'start']),
    // the contact gets a confirmation – outbound
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    klassFor: (a) => (a.blocked ? 'write' : 'sensitive'),
    run: (call, a) => {
      if (!a.blocked && !a.contact_id) throw new HttpError(400, 'contact_id fehlt (oder blocked = true für eine Blockzeit)');
      const body: Json = { calendar_id: a.calendar_id, start: a.start };
      for (const k of ['contact_id', 'end', 'notes', 'force', 'blocked', 'title']) if (a[k] !== undefined) body[k] = a[k];
      return call.api('POST', '/api/appointments', { location: a.location_id, body });
    },
  },
  {
    name: 'ghl_update_appointment',
    title: 'Termin verschieben/ändern',
    description: 'Verschiebt einen Termin (start ISO 8601; die Dauer bleibt, außer end ist angegeben) oder setzt Status confirmed|showed|noshow, Titel oder Notizen. Absagen: ghl_cancel_appointment.',
    inputSchema: obj({ appointment_id: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, status: { type: 'string', enum: APPT_STATUS }, title: { type: 'string' }, notes: { type: 'string' } }, ['appointment_id']),
    annotations: { ...W, idempotentHint: true },
    // "noshow" sends the calendar's no-show message to the contact right away – outbound, so it asks first (anything else is refused below)
    klassFor: (a) => (a.status == null || a.status === 'confirmed' || a.status === 'showed' ? 'write' : 'sensitive'),
    run: (call, a) => {
      if (a.status != null && !APPT_STATUS.includes(a.status)) throw new HttpError(400, 'Status nur confirmed, showed oder noshow – zum Absagen ghl_cancel_appointment');
      const body: Json = {};
      for (const k of ['start', 'end', 'status', 'title', 'notes']) if (a[k] !== undefined) body[k] = a[k];
      if (!Object.keys(body).length) throw new HttpError(400, 'Nichts zu ändern – start, end, status, title oder notes angeben');
      return call.api('PATCH', `/api/appointments/${enc(a.appointment_id)}`, { location: a.location_id, body });
    },
  },
  {
    name: 'ghl_cancel_appointment',
    title: 'Termin absagen',
    description: 'Sagt einen Termin ab (Status cancelled; der Termin bleibt in der Historie). Automationen zum Statuswechsel laufen an.',
    inputSchema: obj({ appointment_id: { type: 'string' } }, ['appointment_id']),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    run: (call, a) => call.api('PATCH', `/api/appointments/${enc(a.appointment_id)}`, { location: a.location_id, body: { status: 'cancelled' } }),
  },
  // --- contacts ------------------------------------------------------------------------------------------------------------
  {
    name: 'ghl_update_contact',
    title: 'Kontakt ändern',
    description: 'Ändert Felder eines bestimmten Kontakts (per ID): Name, E-Mail, Telefon, Firma, Adresse, Quelle, zuständige Person (assigned_to), dnd, eigene Felder (custom: {schluessel: wert}). Tags: ghl_tag_contact.',
    inputSchema: obj({ contact_id: { type: 'string' }, ...CONTACT_PROPS }, ['contact_id']),
    annotations: { ...W, idempotentHint: true },
    run: (call, a) => {
      const body = pick(a, Object.keys(CONTACT_PROPS));
      if ('dnd' in body) body.dnd = body.dnd ? 1 : 0;
      if (!Object.keys(body).length) throw new HttpError(400, 'Nichts zu ändern');
      return call.api('PATCH', `/api/contacts/${enc(a.contact_id)}`, { location: a.location_id, body });
    },
  },
  {
    name: 'ghl_tag_contact',
    title: 'Tags setzen',
    description: 'Fügt einem Kontakt Tags hinzu (add) und/oder entfernt welche (remove). Tag-Automationen laufen an.',
    inputSchema: obj({ contact_id: { type: 'string' }, add: { type: 'array', items: { type: 'string' } }, remove: { type: 'array', items: { type: 'string' } } }, ['contact_id']),
    annotations: { ...W, idempotentHint: true },
    run: async (call, a) => {
      if (!a.add?.length && !a.remove?.length) throw new HttpError(400, 'add oder remove angeben');
      const c = await call.api('POST', `/api/contacts/${enc(a.contact_id)}/tags`, { location: a.location_id, body: { add: a.add ?? [], remove: a.remove ?? [] } });
      return { id: c?.id, name: name(c), tags: c?.tags };
    },
  },
  {
    name: 'ghl_merge_contacts',
    title: 'Kontakte zusammenführen',
    description: 'Führt zwei Kontakte zusammen: from_id geht in keep_id auf (Nachrichten, Deals, Aufgaben, Notizen ziehen um, from_id wird gelöscht). Kandidaten liefert ghl_contact_duplicates. Nicht rückgängig zu machen.',
    inputSchema: obj({ keep_id: { type: 'string' }, from_id: { type: 'string' } }, ['keep_id', 'from_id']),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    run: async (call, a) => {
      const r = await call.api('POST', '/api/contact-duplicates/merge', { location: a.location_id, body: { keep_id: a.keep_id, from_id: a.from_id } });
      return { contact_id: r?.contact?.id, name: name(r?.contact), moved: r?.moved, dropped: r?.dropped };
    },
  },
  // --- conversations -------------------------------------------------------------------------------------------------------
  {
    name: 'ghl_draft_email',
    title: 'Antwort-Entwurf anlegen',
    description: 'Legt einen E-Mail-Entwurf an einen Kontakt in seiner Konversation ab (Status Entwurf – es wird nichts verschickt; der Nutzer prüft und sendet ihn im Posteingang). Zum echten Versand: ghl_send_message.',
    inputSchema: obj({ contact_id: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, ['contact_id', 'body']),
    annotations: W,
    run: async (call, a) => {
      const c = await call.api('GET', `/api/contacts/${enc(a.contact_id)}`, { location: a.location_id });
      if (!c?.email) throw new HttpError(400, 'Der Kontakt hat keine E-Mail-Adresse');
      const r = await call.api('POST', '/api/conversations/import', {
        location: a.location_id,
        body: { source: 'KI-Agent', messages: [{ external_id: `agent-draft-${id()}`, status: 'draft', direction: 'out', to: [c.email], subject: String(a.subject ?? ''), body: String(a.body), contact: { email: c.email } }] },
      });
      return { ok: !!r?.created, draft: true, contact_id: c.id, to: c.email, link: `contacts/${c.id}` };
    },
  },
  // --- invoices ------------------------------------------------------------------------------------------------------------
  {
    name: 'ghl_create_invoice',
    title: 'Rechnung/Angebot entwerfen',
    description:
      'Legt eine Rechnung (kind invoice) oder ein Angebot (kind estimate) als Entwurf an – nichts wird verschickt oder festgeschrieben (dafür ghl_invoice_finalise). items: [{name, qty, price_cents (netto in Cent), tax_rate?, description?}].',
    inputSchema: obj(
      {
        kind: { type: 'string', enum: ['invoice', 'estimate'] },
        contact_id: { type: 'string' },
        title: { type: 'string' },
        items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, qty: { type: 'number' }, price_cents: { type: 'number' }, tax_rate: { type: 'number' }, description: { type: 'string' } }, required: ['name'] } },
        currency: { type: 'string', description: 'ISO-Code, Standard EUR' },
        notes: { type: 'string' },
      },
      ['items'],
    ),
    annotations: W,
    run: async (call, a) => {
      // a draft only: no recurring schedule (it would finalise and send by itself), no payment link, no dates or legal fields
      const body = pick(a, ['kind', 'contact_id', 'title', 'items', 'currency', 'notes']);
      const inv = await call.api('POST', '/api/invoices', { location: a.location_id, body });
      return { id: inv?.id, kind: inv?.kind, number: inv?.number, status: inv?.status, title: inv?.title || undefined, contact_id: inv?.contact_id || undefined, total_cents: inv?.total_cents ?? inv?.total, currency: inv?.currency, link: `invoices/${inv?.id}` };
    },
  },
  // --- campaigns -----------------------------------------------------------------------------------------------------------
  {
    name: 'ghl_list_campaigns',
    title: 'Kampagnen auflisten',
    description: 'E-Mail-/SMS-Kampagnen mit Status (draft, scheduled, sending, sent …) und Kennzahlen. Optional status filtern.',
    inputSchema: obj({ status: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }),
    annotations: RO,
    run: async (call, a) => {
      const rows = list(await call.api('GET', '/api/campaigns', { location: a.location_id })).filter((c) => !a.status || c.status === a.status);
      return { total: rows.length, campaigns: rows.slice(0, limitOf(a.limit, 30, 100)).map((c) => ({ id: c.id, name: c.name, channel: c.channel, status: c.status, subject: c.subject || undefined, scheduled_at: c.scheduled_at || undefined, stats: c.stats, link: `campaigns/${c.id}` })) };
    },
  },
  {
    name: 'ghl_create_campaign',
    title: 'Kampagne entwerfen',
    description: 'Legt eine E-Mail- oder SMS-Kampagne als Entwurf an (name, channel, subject, body; filter = Zielgruppe wie in der Kampagnen-Ansicht, z. B. {"tags":["kunde"]}). Verschickt nichts – senden/planen macht der Nutzer in der Kampagne.',
    inputSchema: obj({ name: { type: 'string' }, channel: { type: 'string', enum: ['email', 'sms'] }, subject: { type: 'string' }, body: { type: 'string' }, filter: { type: 'object' } }, ['name']),
    annotations: W,
    // a draft is a plain change (the name only sounds outbound): sending stays a separate, confirmed step
    klassFor: () => 'write',
    run: async (call, a) => {
      const c = await call.api('POST', '/api/campaigns', { location: a.location_id, body: pick(a, ['name', 'channel', 'subject', 'body', 'filter']) });
      return { id: c?.id, name: c?.name, channel: c?.channel, status: c?.status, link: `campaigns/${c?.id}` };
    },
  },
  // --- workflows -----------------------------------------------------------------------------------------------------------
  {
    name: 'ghl_list_workflows',
    title: 'Automationen auflisten',
    description: 'Workflows (Automationen) mit Status (draft|active|paused), Auslöser und Zahl der Durchläufe.',
    inputSchema: obj({ status: { type: 'string', enum: ['draft', 'active', 'paused'] } }),
    annotations: RO,
    run: async (call, a) => {
      const rows = list(await call.api('GET', '/api/workflows', { location: a.location_id })).filter((w) => !a.status || w.status === a.status);
      return rows.slice(0, 100).map((w) => ({ id: w.id, name: w.name, status: w.status, trigger: w.trigger?.type ?? w.trigger, steps: Array.isArray(w.steps) ? w.steps.length : undefined, enrolled: w.enrolled, active_runs: w.active_runs, link: `workflows/${w.id}` }));
    },
  },
  {
    name: 'ghl_workflow_enroll',
    title: 'In Automation aufnehmen',
    description: 'Nimmt Kontakte in einen aktiven Workflow auf (contact_ids). Die Schritte laufen sofort an – auch Nachrichten an die Kontakte.',
    inputSchema: obj({ workflow_id: { type: 'string' }, contact_ids: { type: 'array', items: { type: 'string' }, maxItems: 100 } }, ['workflow_id', 'contact_ids']),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: (call, a) => call.api('POST', `/api/workflows/${enc(a.workflow_id)}/enroll`, { location: a.location_id, body: { contact_ids: a.contact_ids } }),
  },
  {
    name: 'ghl_workflow_set_status',
    title: 'Automation pausieren/aktivieren',
    description: 'Setzt den Status eines Workflows: paused (pausieren), active (aktivieren – reagiert ab dann auf seinen Auslöser und kann Nachrichten senden) oder draft.',
    inputSchema: obj({ workflow_id: { type: 'string' }, status: { type: 'string', enum: ['active', 'paused', 'draft'] } }, ['workflow_id', 'status']),
    annotations: { ...W, idempotentHint: true },
    // switching on means: from now on it acts (and may send) by itself
    klassFor: (a) => (a.status === 'active' ? 'sensitive' : 'write'),
    run: async (call, a) => {
      const w = await call.api('PATCH', `/api/workflows/${enc(a.workflow_id)}`, { location: a.location_id, body: { status: a.status } });
      return { id: w?.id, name: w?.name, status: w?.status };
    },
  },
  // --- forms, surveys, reviews ---------------------------------------------------------------------------------------------
  {
    name: 'ghl_list_forms',
    title: 'Formulare auflisten',
    description: 'Formulare mit Zahl der Einsendungen und öffentlicher Adresse; mapping = wie viele Felder in Firma/Deal/Objekt schreiben (Details: ghl_form_mapping).',
    inputSchema: obj({}),
    annotations: RO,
    run: async (call, a) => list(await call.api('GET', '/api/forms', { location: a.location_id })).slice(0, 100).map((f) => ({ id: f.id, name: f.name, submissions: f.submissions, url: f.url || undefined, link: `forms/${f.id}`, mapping: mappingSummary(f.settings) })),
  },
  {
    name: 'ghl_form_submissions',
    title: 'Formular-Einsendungen',
    description: 'Die neuesten Einsendungen eines Formulars (Zeit, Kontakt, eingegebene Felder). Inhalte stammen von Besuchern.',
    inputSchema: obj({ form_id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['form_id']),
    annotations: RO,
    untrusted: true,
    run: async (call, a) => {
      const rows = list(await call.api('GET', `/api/forms/${enc(a.form_id)}/submissions`, { location: a.location_id }));
      return {
        total: rows.length,
        submissions: rows.slice(0, limitOf(a.limit, 20, 100)).map((s) => ({ id: s.id, at: s.created_at, contact_id: s.contact_id || undefined, contact: name(s), data: Object.fromEntries(Object.entries(s.data ?? {}).map(([k, v]) => [k, cut(v, 500)])) })),
      };
    },
  },
  {
    name: 'ghl_survey_results',
    title: 'Umfrage-Ergebnisse',
    description: 'Ohne survey_id: Überblick über Zufriedenheit (CSAT) und NPS der letzten days Tage (Standard 90). Mit survey_id (NPS-Umfrage): die neuesten Antworten mit Wert und Kommentar.',
    inputSchema: obj({ survey_id: { type: 'string' }, days: { type: 'integer', minimum: 1, maximum: 730 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }),
    annotations: RO,
    untrusted: true,
    run: async (call, a) => {
      if (!a.survey_id) return call.api('GET', `/api/surveys/summary${q({ days: a.days })}`, { location: a.location_id });
      const rows = list(await call.api('GET', `/api/surveys/nps/${enc(a.survey_id)}/responses`, { location: a.location_id }));
      return { total: rows.length, responses: rows.slice(0, limitOf(a.limit, 30, 100)).map((r) => ({ score: r.score, comment: cut(r.comment, 500) || undefined, contact_id: r.contact_id, contact: name(r), at: r.updated_at })) };
    },
  },
  {
    name: 'ghl_list_reviews',
    title: 'Bewertungsanfragen',
    description: 'Bewertungsanfragen an Kunden mit Sternen, Kommentar und Status (eigene Bewertungen; Google-Rezensionen: ghl_google_reviews).',
    inputSchema: obj({ limit: { type: 'integer', minimum: 1, maximum: 100 } }),
    annotations: RO,
    untrusted: true,
    run: async (call, a) => {
      const r = await call.api('GET', '/api/reviews', { location: a.location_id });
      const rows = list(r?.requests ?? r?.reviews ?? r);
      return { ...(r && !Array.isArray(r) ? { stats: r.stats ?? r.summary } : {}), reviews: rows.slice(0, limitOf(a.limit, 30, 100)).map((x) => ({ id: x.id, rating: x.rating ?? undefined, comment: cut(x.feedback ?? x.comment, 400) || undefined, status: x.status, contact_id: x.contact_id, contact: name(x), at: x.responded_at ?? x.created_at })) };
    },
  },
  // --- settings ------------------------------------------------------------------------------------------------------------
  {
    name: 'ghl_settings_overview',
    title: 'Firmendaten & Einstellungen',
    description: 'Stammdaten des Sub-Accounts (Name, E-Mail, Telefon, Adresse, Website, Zeitzone) und welche Versandkanäle eingerichtet sind. Nur lesen; Zugangsdaten werden nie gezeigt.',
    inputSchema: obj({}),
    annotations: RO,
    run: async (call, a) => {
      const l = await call.api('GET', '/api/location', { location: a.location_id });
      const s = l?.settings ?? {};
      return {
        id: l?.id,
        name: l?.name,
        email: l?.email || undefined,
        phone: l?.phone || undefined,
        address: l?.address || undefined,
        website: l?.website || undefined,
        timezone: l?.timezone,
        channels: { email: !!(s.email && (s.email.provider || s.email.host || s.email.from)), sms: !!(s.sms && (s.sms.provider || s.sms.from)) },
        link: 'settings',
      };
    },
  },
];

export const agentOpsToolsModule: Module = {
  name: 'agent-ops-tools',
  register(app) {
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...OPS_TOOLS];
  },
};
