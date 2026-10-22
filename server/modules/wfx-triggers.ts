import type { App, Module } from '../core/app.js';
import { parseRows } from '../core/db.js';
import { HttpError, notFound } from '../core/http.js';
import { addDaysYmd, isValidTz, zonedToUtc } from '../core/time.js';
import { id as newId, normalizeEmail, normalizePhone, now } from '../core/util.js';
import { sliceTimer } from '../core/perf.js';
import { VISITOR_COOKIE, verifyVisitor } from '../services/attribution.js';
import { addTags, getContact, upsertContact } from '../services/contacts.js';
import { wallClock } from '../services/formatters.js';
import { daysOverdue, overdueBefore } from '../services/invoice-model.js';
import { processRun, startWorkflow, triggerFiltersPass } from '../services/workflow-engine.js';
import { cronFires, diffContact, dueDays, fieldChangeMatches, fromWallMinute, monthDaysForToday, parseCron, wallMinute, yearOf } from '../services/wfx-triggers.js';
import { registerTriggers, type FieldDef, type TriggerMeta } from '../services/wfx-kit.js';

/**
 * Additional workflow triggers: field changed (old → new), birthday, anniversary, schedule (cron in the sub-account's
 * time zone), form abandoned, page visited, payment failed/refunded, subscription ended, appointment no-show/cancelled/
 * rescheduled/starts soon, conversation unanswered, invoice overdue, custom event (API/MCP/workflow) and
 * more events that already existed but were not offered as triggers. Every trigger also accepts the generic filters
 * (`filters`, `filter_expression`) that the engine checks. Docs: docs/workflow-actions.md#triggers.
 */

const SCAN_EVERY_MS = 55_000;

const F = {
  form: { key: 'form_id', label: 'Formular', type: 'form', help: 'Leer = jedes' } as FieldDef,
  calendar: { key: 'calendar_id', label: 'Kalender', type: 'calendar', help: 'Leer = jeder' } as FieldDef,
  product: { key: 'product_id', label: 'Produkt', type: 'text', help: 'Produkt-ID, leer = jedes' } as FieldDef,
  time: { key: 'time', label: 'Uhrzeit', type: 'time', default: '09:00' } as FieldDef,
  tz: { key: 'tz', label: 'Zeitzone', type: 'tz', help: 'Leer = Zeitzone des Sub-Accounts' } as FieldDef,
};

const contactSample = { id: 'c1', first_name: 'Erika', last_name: 'Muster', email: 'erika@example.com', tags: ['lead'], custom: {} };

export const NEW_TRIGGERS: TriggerMeta[] = [
  { type: 'field.changed', label: 'Feld geändert (alt → neu)', category: 'contact', summary: 'Ein Kontaktfeld oder eigenes Feld bekommt einen neuen Wert.', doc: 'Startet, wenn sich ein Feld wirklich ändert – egal ob im Kontakt, per Formular, Import, API oder durch einen Workflow. Feld leer = jedes Feld. Mit „von“ und „zu“ lässt sich ein bestimmter Übergang abfangen (z. B. Status von „offen“ zu „bezahlt“). Alter und neuer Wert stehen in {{event.old}} und {{event.new}}, der Feldname in {{event.field}}. Ein Workflow startet sich durch seine eigenen Änderungen nicht selbst, Ketten sind auf 4 Stufen begrenzt.', fields: [{ key: 'field', label: 'Feld', type: 'contact_field', help: 'Leer oder * = jedes Feld; eigene Felder als custom.<schlüssel>' }, { key: 'from', label: 'Alter Wert (optional)', type: 'text' }, { key: 'to', label: 'Neuer Wert (optional)', type: 'text' }, { key: 'to_empty', label: 'Nur wenn das Feld jetzt leer ist', type: 'bool' }], sample: { field: 'custom.status', old: 'offen', new: 'bezahlt', contact: contactSample }, keywords: 'field changed feld geändert alt neu wert custom' },
  { type: 'contact.owner_changed', label: 'Zuständiger geändert', category: 'contact', summary: 'Ein Kontakt bekommt einen anderen Zuständigen (Besitzer).', doc: 'Startet bei jeder Änderung von „Zuständig“, z. B. um dem neuen Mitarbeiter eine Aufgabe oder Mitteilung zu schicken. {{event.old}} und {{event.new}} enthalten die Nutzer-IDs.', fields: [], sample: { field: 'assigned_to', old: '', new: 'u1', contact: contactSample }, keywords: 'owner besitzer zuständig assigned' },
  { type: 'contact.birthday', label: 'Geburtstag', category: 'time', summary: 'Am Geburtstag des Kontakts – oder X Tage davor/danach – zur gewählten Uhrzeit.', doc: 'Liest „Geburtstag“ im Kontakt (JJJJ-MM-TT oder TT.MM.JJJJ). Versatz: negativ = Tage vor dem Geburtstag, positiv = danach. Jedes Jahr einmal je Kontakt, in der Zeitzone des Sub-Accounts; 29. Februar zählt in anderen Jahren am 28. {{event.age}} ist das Alter, wenn das Jahr bekannt ist. War der Server zur Uhrzeit aus, wird der Tag nachgeholt – bis 3 Tage zurück, nie doppelt, nur für Kontakte, die es da schon gab, und nicht für Tage, bevor der Workflow (wieder) aktiv war; {{event.late_days}} sagt dann, wie viele Tage zu spät.', fields: [{ key: 'offset_days', label: 'Tage davor (−) / danach (+)', type: 'number', default: 0 }, F.time, F.tz], sample: { date: '1990-11-02', age: 36, contact: contactSample }, keywords: 'birthday geburtstag jahrestag' },
  { type: 'contact.anniversary', label: 'Jahrestag (Kunde seit …)', category: 'time', summary: 'Jedes Jahr am Jahrestag eines Datums – standardmäßig „Kontakt seit“.', doc: 'Datumsfeld: „Kontakt angelegt“ (Standard), Geburtstag oder ein eigenes Datumsfeld (custom.<schlüssel>). Mindestens N Jahre (Standard 1), damit am Tag der Anlage nichts passiert. {{event.years}} nennt die Jahre. Ein verpasster Tag (Server aus) wird bis 3 Tage zurück nachgeholt, {{event.late_days}} = Tage zu spät.', fields: [{ key: 'field', label: 'Datum aus', type: 'text', default: 'created_at', placeholder: 'created_at  ·  date_of_birth  ·  custom.vertragsbeginn' }, { key: 'min_years', label: 'Mindestens Jahre', type: 'number', default: 1 }, { key: 'offset_days', label: 'Tage davor (−) / danach (+)', type: 'number', default: 0 }, F.time, F.tz], sample: { years: 2, date: '2024-11-02', contact: contactSample }, keywords: 'anniversary jubiläum jahrestag kunde seit' },
  { type: 'schedule.cron', label: 'Zeitplan (Cron)', category: 'time', summary: 'Startet nach Zeitplan für alle passenden Kontakte, z. B. montags um 9 Uhr.', doc: 'Fünf Felder: Minute Stunde Tag Monat Wochentag, z. B. „0 9 * * 1-5“ (werktags 9:00), „*/30 * * * *“ (alle 30 Minuten), „0 8 1 * *“ (am Ersten um 8:00) oder Kürzel wie @daily. Gerechnet wird in der Zeitzone des Sub-Accounts (oder der gewählten) – Sommerzeit-fest: eine Zeit, die es durch die Umstellung nicht gibt, läuft direkt danach, eine doppelte nur einmal. Beim Start laufen alle Kontakte, die zu den Filtern passen (Tags, Zusatzfilter), höchstens so viele wie „Maximal“ (bis 5000); ein Kontakt durchläuft den Workflow nur einmal, außer „mehrfach durchlaufen“ ist erlaubt. Verpasste Termine (Server aus) werden bis 10 Minuten nachgeholt.', fields: [{ key: 'cron', label: 'Zeitplan', type: 'text', default: '0 9 * * 1-5', required: true, placeholder: '0 9 * * 1-5' }, F.tz, { key: 'tags', label: 'Nur Kontakte mit allen Tags', type: 'tags' }, { key: 'any_tags', label: 'Nur Kontakte mit einem dieser Tags', type: 'tags' }, { key: 'exclude_tags', label: 'Ohne diese Tags', type: 'tags' }, { key: 'max', label: 'Maximal Kontakte je Start', type: 'number', default: 1000 }], sample: { cron: '0 9 * * 1', scheduled_for: '2026-11-02T08:00:00.000Z' }, keywords: 'cron schedule zeitplan wiederkehrend regelmäßig' },
  { type: 'form.abandoned', label: 'Formular abgebrochen', category: 'marketing', summary: 'Jemand hat E-Mail oder Telefon in ein Formular getippt, aber nicht abgeschickt.', doc: 'Sobald dieser Auslöser in einem aktiven Workflow steht, merkt sich das Formular Name, E-Mail und Telefon, sobald sie eingetippt sind (nur diese Felder). Wird es nach der eingestellten Zeit nicht abgeschickt, startet der Workflow – für den vorhandenen Kontakt oder einen neuen, der mit dem Tag „formular-abgebrochen“ angelegt wird, ohne dass „Kontakt angelegt“-Workflows laufen. Datenschutz: Nur einsetzen, wenn dein Formular dies im Hinweistext nennt. Gespeicherte Teilangaben werden nach 3 Tagen gelöscht.', fields: [F.form, { key: 'minutes', label: 'Abgebrochen nach … Minuten ohne Absenden', type: 'number', default: 30 }], sample: { formId: 'f1', form: { id: 'f1', name: 'Kontaktformular' }, partial: { email: 'erika@example.com', first_name: 'Erika' } }, keywords: 'abandoned abgebrochen formular warenkorb' },
  { type: 'page.visited', label: 'Seite besucht', category: 'marketing', summary: 'Ein bekannter Kontakt öffnet eine Seite deiner Funnels/Websites.', doc: 'Erkannt wird der Kontakt am Besucher-Cookie der Attribution (nur mit Einwilligung gesetzt) – also nach einem früheren Formular, Termin oder Kauf. Filter: Funnel, Seite oder Teil des Pfads. Je Kontakt und Seite höchstens einmal in 30 Minuten.', fields: [{ key: 'funnel_id', label: 'Funnel', type: 'text', help: 'Funnel-ID, leer = jeder' }, { key: 'page_id', label: 'Seite', type: 'text', help: 'Seiten-ID, leer = jede' }, { key: 'path_contains', label: 'Pfad enthält', type: 'text', placeholder: '/preise' }], sample: { funnelId: 'fn1', pageId: 'p1', page: { name: 'Preise', path: '/preise' }, url: '/p/mein-funnel/preise' }, keywords: 'page visit seite besucht website funnel tracking' },
  { type: 'payment.failed', label: 'Zahlung fehlgeschlagen', category: 'payments', summary: 'Eine Zahlung oder Abo-Verlängerung über Stripe schlägt fehl.', doc: 'Kommt von Stripe (Webhook-Ereignisse checkout.session.async_payment_failed und invoice.payment_failed müssen im Stripe-Webhook aktiviert sein). Ideal für eine Mahn-/Update-Mail. {{event.amount_cents}}, {{event.reason}} und – bei Abos – {{event.attempt}} sind verfügbar.', fields: [F.product], sample: { amount_cents: 4900, currency: 'EUR', reason: 'card_declined', attempt: 1, productId: 'p1' }, keywords: 'payment failed zahlung fehlgeschlagen stripe abo mahnung' },
  { type: 'payment.refunded', label: 'Zahlung erstattet', category: 'payments', summary: 'Eine Stripe-Zahlung wird ganz oder teilweise erstattet.', doc: 'Webhook-Ereignis charge.refunded. „Nur vollständige Erstattungen“ schließt Teilerstattungen aus. {{event.amount_cents}} ist der erstattete Betrag.', fields: [F.product, { key: 'full_only', label: 'Nur vollständige Erstattungen', type: 'bool' }], sample: { amount_cents: 4900, currency: 'EUR', full: true, productId: 'p1' }, keywords: 'refund erstattung rückerstattung' },
  { type: 'product.subscription_ended', label: 'Abo gekündigt / beendet', category: 'payments', summary: 'Ein Stripe-Abo endet (Kündigung oder zu viele fehlgeschlagene Zahlungen).', doc: 'Webhook-Ereignis customer.subscription.deleted. Der Kaufbezug (Tag, Kurszugang) wird dabei schon entfernt; hier lässt sich z. B. eine Rückgewinnungs-Mail senden.', fields: [F.product], sample: { productId: 'p1', subscription: 'sub_123' }, keywords: 'subscription abo gekündigt cancelled churn' },
  { type: 'appointment.noshow', label: 'Termin nicht wahrgenommen', category: 'sales', summary: 'Ein Termin wird als „nicht erschienen“ markiert.', doc: 'Kurzform von „Terminstatus geändert → nicht erschienen“, mit Kalenderfilter. {{appointment.*}} ist verfügbar.', fields: [F.calendar], sample: { status: 'noshow', calendarId: 'k1', appointment: { id: 'a1', title: 'Erstgespräch', start_at: '2026-11-02T09:00:00.000Z' } }, keywords: 'noshow no-show nicht erschienen' },
  { type: 'appointment.cancelled', label: 'Termin abgesagt', category: 'sales', summary: 'Ein Termin wird abgesagt (vom Kontakt oder vom Team).', doc: 'Kurzform von „Terminstatus geändert → abgesagt“, mit Kalenderfilter.', fields: [F.calendar], sample: { status: 'cancelled', calendarId: 'k1', appointment: { id: 'a1', title: 'Erstgespräch' } }, keywords: 'cancelled abgesagt storniert' },
  { type: 'appointment.rescheduled', label: 'Termin verschoben', category: 'sales', summary: 'Ein Termin bekommt einen neuen Zeitpunkt.', doc: '{{event.previousStart}} ist der alte Beginn, {{appointment.start_at}} der neue.', fields: [F.calendar], sample: { previousStart: '2026-11-02T09:00:00.000Z', calendarId: 'k1', appointment: { id: 'a1', title: 'Erstgespräch', start_at: '2026-11-03T09:00:00.000Z' } }, keywords: 'rescheduled verschoben umgebucht' },
  { type: 'appointment.starts_soon', label: 'Termin beginnt bald', category: 'sales', summary: 'X Minuten vor einem bestätigten Termin – für eigene Erinnerungen.', doc: 'Läuft einmal je Termin, wenn der Beginn innerhalb der eingestellten Minuten liegt (Standard 60). Ergänzt die eingebaute Terminerinnerung, z. B. mit SMS oder WhatsApp.', fields: [F.calendar, { key: 'minutes_before', label: 'Minuten vor Beginn', type: 'number', default: 60 }], sample: { minutesToStart: 58, calendarId: 'k1', appointment: { id: 'a1', title: 'Erstgespräch', start_at: '2026-11-02T09:00:00.000Z' } }, keywords: 'reminder erinnerung termin bald' },
  { type: 'task.overdue', label: 'Aufgabe überfällig', category: 'sales', summary: 'Eine Aufgabe zu einem Kontakt ist nicht rechtzeitig erledigt.', doc: 'Kommt von der Projektplanung: einmal je Aufgabe und Fälligkeit, sobald die Frist überschritten ist und die Aufgabe offen bleibt (Fristen ohne Uhrzeit zählen ab dem nächsten Tag); nur Aufgaben mit Kontakt starten den Workflow. {{event.task.title}} nennt die Aufgabe, {{event.projectId}} das Projekt. Typisch: Zuständigen erinnern oder eskalieren.', fields: [], sample: { task: { id: 't1', title: 'Angebot nachfassen', due_at: '2026-11-02T09:00:00.000Z', assigned_to: 'u1' }, projectId: 'p1' }, keywords: 'task aufgabe überfällig overdue frist projekt' },
  { type: 'conversation.unanswered', label: 'Nachricht unbeantwortet', category: 'messages', summary: 'Auf eine eingehende Nachricht gab es X Minuten lang keine Antwort.', doc: 'Prüft, ob die letzte Nachricht in einer Unterhaltung vom Kontakt kommt und seit der eingestellten Zeit (Standard 60 Minuten) niemand geantwortet hat. Einmal je Nachricht; Unterhaltungen, die älter als 7 Tage sind, werden nicht mehr gemeldet. Typisch: Team erinnern, Hinweis „wir melden uns“.', fields: [{ key: 'minutes', label: 'Unbeantwortet seit … Minuten', type: 'number', default: 60 }, { key: 'channel', label: 'Kanal', type: 'select', options: [['', 'Jeder'], ['email', 'E-Mail'], ['sms', 'SMS'], ['chat', 'Live-Chat'], ['whatsapp', 'WhatsApp'], ['telegram', 'Telegram']] }], sample: { minutes: 65, message: { id: 'm1', channel: 'email', subject: 'Frage', body: 'Hallo, haben Sie Zeit?' }, conversationId: 'cv1' }, keywords: 'unanswered unbeantwortet reaktionszeit sla antwort' },
  { type: 'invoice.overdue', label: 'Rechnung überfällig', category: 'payments', summary: 'Eine versendete Rechnung ist X Tage über das Zahlungsziel.', doc: 'Einmal je Rechnung, wenn sie noch nicht bezahlt ist und das Zahlungsziel um die eingestellten Tage (Standard 1) überschritten ist – Kalendertage in der Zeitzone des Sub-Accounts: 1 heißt ab dem Tag nach dem Fälligkeitstag, gleich um welche Uhrzeit. {{event.invoice.number}} und {{event.invoice.total_cents}} sind verfügbar – für Zahlungserinnerung und Mahnstufen mit mehreren Workflows.', fields: [{ key: 'days_overdue', label: 'Tage nach Fälligkeit', type: 'number', default: 1 }], sample: { invoice: { id: 'i1', number: 'RE-1001', total_cents: 11900, currency: 'EUR', due_at: '2026-10-20T00:00:00.000Z' }, daysOverdue: 3 }, keywords: 'invoice overdue mahnung zahlungserinnerung rechnung überfällig' },
  { type: 'event.custom', label: 'Eigenes Ereignis', category: 'system', summary: 'Ein eigenes Ereignis aus API, MCP, Zapier/Make oder einem anderen Workflow.', doc: 'Auslösen: POST /api/custom-events {name, contact_id|email|phone, data}, MCP-Werkzeug ghl_emit_event oder der Schritt „Eigenes Ereignis auslösen“. Name leer = jedes. Die Daten stehen unter {{event.<feld>}}.', fields: [{ key: 'name', label: 'Name des Ereignisses', type: 'text', placeholder: 'bestellung_versendet' }], sample: { name: 'bestellung_versendet', data: { bestellnummer: 'B-4711', summe: 129 }, bestellnummer: 'B-4711', summe: 129 }, keywords: 'custom event ereignis api webhook mcp' },
  { type: 'invoice.created', label: 'Wiederkehrende Rechnung erstellt', category: 'payments', summary: 'Eine Abo-/Serien-Rechnung wird automatisch erstellt.', doc: 'Entsteht, wenn eine wiederkehrende Rechnung ihren nächsten Termin erreicht. {{event.invoice.*}} ist verfügbar.', fields: [], sample: { recurring: true, invoice: { id: 'i2', number: 'RE-1002', total_cents: 4900 } }, keywords: 'invoice recurring abo rechnung erstellt' },
  { type: 'estimate.accepted', label: 'Angebot angenommen', category: 'payments', summary: 'Ein Kontakt nimmt ein Angebot an.', doc: 'Entsteht, wenn der Kontakt im Angebots-Link auf „Annehmen“ klickt. {{event.invoice.*}} enthält das Angebot.', fields: [], sample: { invoice: { id: 'a2', number: 'AN-1001', total_cents: 250000 } }, keywords: 'estimate angebot angenommen accepted' },
  { type: 'csat.received', label: 'Zufriedenheit bewertet (CSAT)', category: 'service', summary: 'Ein Kunde bewertet die Hilfe nach einem Ticket.', doc: '{{event.score}} (1–5) und {{event.comment}}; mit Zusatzfilter z. B. „event.score kleiner als 3“ → Rückruf-Aufgabe.', fields: [], sample: { score: 2, comment: 'Dauerte zu lange', ticketId: 't1' }, keywords: 'csat zufriedenheit umfrage ticket' },
  { type: 'nps.received', label: 'NPS-Antwort erhalten', category: 'service', summary: 'Ein Kontakt beantwortet eine NPS-Umfrage.', doc: '{{event.score}} (0–10) und {{event.comment}}; mit Zusatzfilter nach Promotern/Kritikern trennen.', fields: [], sample: { score: 9, comment: 'Gerne wieder', campaignId: 'n1' }, keywords: 'nps net promoter score umfrage' },
  { type: 'ads.lead', label: 'Neuer Lead aus Anzeige (Meta Lead Ads)', category: 'marketing', summary: 'Ein Lead aus einem Instant-Formular von Facebook oder Instagram ist als Kontakt angekommen.', doc: 'Kommt vom Anzeigen-Manager (Marketing → Anzeigen), sobald ein Lead importiert wurde. Filter für Formular, Kampagne und Plattform; leer = jeder Lead. {{event.campaignName}}, {{event.adName}}, {{event.formName}} und die Antworten des Formulars ({{event.answers}}) stehen im Ereignis, {{event.created}} sagt, ob der Kontakt neu war.', fields: [{ key: 'form_id', label: 'Formular-ID', type: 'text', help: 'Leer = jedes Formular' }, { key: 'campaign_id', label: 'Kampagnen-ID', type: 'text', help: 'Leer = jede Kampagne' }, { key: 'platform', label: 'Plattform', type: 'select', options: [['', 'Alle'], ['facebook', 'Facebook'], ['instagram', 'Instagram']] }], sample: { created: true, leadgenId: 'l1', platform: 'facebook', formId: 'f1', formName: 'Beratungsgespräch', campaignId: 'c1', campaignName: 'Herbst-Aktion', adId: 'a1', adName: 'Anzeige A', adsetName: 'Zielgruppe 1', organic: false, answers: { Name: 'Erika Muster' }, contact: contactSample }, keywords: 'anzeige lead meta facebook instagram instant formular ads' },
  { type: 'course.access_revoked', label: 'Kurszugang entzogen', category: 'content', summary: 'Der Zugang zu einem Kurs endet.', doc: 'Entsteht beim Entzug (manuell, Workflow, beendetes Abo). Kursfilter über die Zusatzfilter (event.courseId).', fields: [], sample: { courseId: 'k1', course: { id: 'k1', title: 'Onboarding' } }, keywords: 'course kurs zugang entzogen' },
];

/** Event type → trigger filter (besides the generic `filters`). */
const FILTERS: Record<string, (c: Record<string, any>, d: Record<string, any>) => boolean> = {
  'field.changed': (c, d) => fieldChangeMatches(c, d),
  'event.custom': (c, d) => !String(c.name ?? '').trim() || String(c.name).trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '_') === d.name,
  'page.visited': (c, d) => (!c.funnel_id || c.funnel_id === d.funnelId) && (!c.page_id || c.page_id === d.pageId) && (!c.path_contains || String(d.url ?? d.page?.path ?? '').includes(String(c.path_contains))),
  'payment.failed': (c, d) => !c.product_id || c.product_id === d.productId,
  'payment.refunded': (c, d) => (!c.product_id || c.product_id === d.productId) && (!c.full_only || d.full === true),
  'product.subscription_ended': (c, d) => !c.product_id || c.product_id === d.productId,
  'appointment.noshow': (c, d) => !c.calendar_id || c.calendar_id === d.calendarId,
  'appointment.cancelled': (c, d) => !c.calendar_id || c.calendar_id === d.calendarId,
  'appointment.rescheduled': (c, d) => !c.calendar_id || c.calendar_id === d.calendarId,
};

const flowsOf = (app: App, type: string): any[] => parseRows(app.db.all(`SELECT * FROM workflows WHERE status = 'active' AND json_extract(trigger, '$.type') = ?`, type), ['steps', 'trigger', 'settings']);

export const wfxTriggersModule: Module = {
  name: 'wfx-triggers',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE wfx_fired (kind TEXT NOT NULL, key TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (kind, key));
      CREATE INDEX wfx_fired_at ON wfx_fired(at);
      CREATE TABLE wfx_cron (
        workflow_id TEXT PRIMARY KEY REFERENCES workflows(id) ON DELETE CASCADE,
        last_wall INTEGER NOT NULL, pending TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE wfx_form_partials (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE, key TEXT NOT NULL,
        data TEXT NOT NULL, page TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open',
        started_at TEXT NOT NULL, last_at TEXT NOT NULL, UNIQUE (form_id, key)
      );
      CREATE INDEX wfx_form_partials_open ON wfx_form_partials(status, last_at);
      CREATE INDEX IF NOT EXISTS tasks_open_due ON tasks(done, due_at);
      CREATE INDEX IF NOT EXISTS appointments_status_start ON appointments(status, start_at);
      CREATE INDEX IF NOT EXISTS invoices_status_due ON invoices(status, due_at);
      CREATE INDEX IF NOT EXISTS conversations_loc_last ON conversations(location_id, last_message_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    registerTriggers(app, NEW_TRIGGERS);
    app.services.workflowTriggerFilters = { ...(app.services.workflowTriggerFilters ?? {}), ...FILTERS };
    const clock = () => (app.services.wfxNow ? new Date(Number(app.services.wfxNow())) : new Date());
    const tzOf = (loc: string, override?: unknown) => (typeof override === 'string' && override && isValidTz(override) ? override : app.location(loc)?.timezone || 'Europe/Berlin');

    /** Starts one workflow for one contact (filters, re-entry rules and the run included). */
    const fire = async (wf: any, contactId: string, data: Record<string, unknown>): Promise<boolean> => {
      const type = wf.trigger?.type;
      const e = { locationId: wf.location_id, type, data: { contactId, ...data }, at: now() };
      if (!triggerFiltersPass(app, wf.trigger, e)) return false;
      const rid = startWorkflow(app, wf, contactId, e.data);
      if (!rid) return false;
      await processRun(app, rid);
      return true;
    };
    /** Remembers that something fired (one run per record); false when it had fired before. */
    const once = (kind: string, key: string): boolean => db.run('INSERT OR IGNORE INTO wfx_fired (kind, key, at) VALUES (?, ?, ?)', kind, key, now()).changes > 0;

    // --- events derived from existing ones --------------------------------------------------------
    app.events.on('contact.updated', (e) => {
      const prev = e.data.previous;
      const cur = e.data.contact;
      const contactId = e.data.contactId;
      if (!prev || !cur || !contactId) return;
      const changes = diffContact(prev, cur);
      if (!changes.length) return;
      const carry = { ...(e.data.viaWorkflow ? { viaWorkflow: e.data.viaWorkflow } : {}), wfDepth: Number(e.data.wfDepth ?? 0) };
      for (const ch of changes.slice(0, 25)) {
        app.events.emit(e.locationId, 'field.changed', { contactId, contact: cur, field: ch.field, old: ch.old, new: ch.new, ...carry });
        if (ch.field === 'assigned_to') app.events.emit(e.locationId, 'contact.owner_changed', { contactId, contact: cur, field: ch.field, old: ch.old, new: ch.new, ...carry });
      }
    });
    app.events.on('appointment.status_changed', (e) => {
      const derived = e.data.status === 'noshow' ? 'appointment.noshow' : e.data.status === 'cancelled' ? 'appointment.cancelled' : '';
      if (derived && e.data.contactId) app.events.emit(e.locationId, derived, { ...e.data });
    });

    // --- page visited -----------------------------------------------------------------------------
    const seen = new Map<string, number>();
    app.services.pageVisit = [
      ...(app.services.pageVisit ?? []),
      (ctx: any, funnel: any, page: any, html: string) => {
        try {
          const vid = verifyVisitor(app.config.secret, ctx.cookies?.[VISITOR_COOKIE]);
          if (!vid) return html;
          const row = db.get<{ contact_id: string | null }>('SELECT contact_id FROM attribution_visitors WHERE location_id = ? AND visitor_id = ?', funnel.location_id, vid);
          if (!row?.contact_id) return html;
          const k = `${row.contact_id}:${page.id}`;
          if (Date.now() - (seen.get(k) ?? 0) < 30 * 60_000) return html;
          seen.set(k, Date.now());
          if (seen.size > 5000) seen.clear();
          app.events.emit(funnel.location_id, 'page.visited', { contactId: row.contact_id, funnelId: funnel.id, funnel: { id: funnel.id, name: funnel.name }, pageId: page.id, page: { id: page.id, name: page.name, path: page.path ?? page.slug ?? '' }, url: ctx.url?.pathname ?? '' });
        } catch {
          /* tracking must never break a page */
        }
        return html;
      },
    ];

    // --- form abandoned: partial entries -----------------------------------------------------------
    const partialKey = (data: { email?: string; phone?: string }) => (data.email ? `e:${normalizeEmail(data.email)}` : data.phone ? `p:${normalizePhone(data.phone)}` : '');
    const hits = new Map<string, number[]>();
    // Does an active workflow wait for abandoned entries of this form? The form page (forms.ts) only reports them then.
    const listening = (locationId: string, formId: string) => flowsOf(app, 'form.abandoned').some((w) => w.location_id === locationId && (!w.trigger.config?.form_id || w.trigger.config.form_id === formId));
    app.services.formAbandonListening = listening;
    router.post('/api/public/forms/:id/partial', 'public', (ctx) => {
      const list = (hits.get(ctx.ip) ?? []).filter((t) => Date.now() - t < 60_000);
      list.push(Date.now());
      hits.set(ctx.ip, list);
      if (hits.size > 5000) hits.clear();
      if (list.length > 30) throw new HttpError(429, 'Zu viele Anfragen');
      const form = db.get<any>('SELECT id, location_id, name FROM forms WHERE id = ?', ctx.params.id);
      if (!form) throw notFound();
      // Only while a workflow listens: no workflow, nothing is stored.
      if (!listening(form.location_id, form.id)) return { ok: true, tracked: false };
      const b = ctx.body ?? {};
      const email = typeof b.email === 'string' ? normalizeEmail(b.email) : '';
      const phone = typeof b.phone === 'string' ? normalizePhone(b.phone) : '';
      const okEmail = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email);
      const okPhone = phone.replace(/\D/g, '').length >= 7 && phone.length <= 20;
      if (!okEmail && !okPhone) return { ok: true, tracked: false };
      const data: Record<string, string> = {};
      if (okEmail) data.email = email;
      if (okPhone) data.phone = phone;
      for (const k of ['first_name', 'last_name', 'name', 'company']) if (typeof b[k] === 'string' && b[k].trim()) data[k] = b[k].trim().slice(0, 120);
      const key = partialKey(data);
      db.run(
        `INSERT INTO wfx_form_partials (id, location_id, form_id, key, data, page, status, started_at, last_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)
         ON CONFLICT(form_id, key) DO UPDATE SET data = excluded.data, page = excluded.page, last_at = excluded.last_at, status = CASE WHEN status = 'fired' THEN 'fired' ELSE 'open' END`,
        newId(),
        form.location_id,
        form.id,
        key,
        JSON.stringify(data),
        typeof b._page === 'string' ? b._page.slice(0, 300) : '',
        clock().toISOString(),
        clock().toISOString(),
      );
      return { ok: true, tracked: true };
    });
    // A submitted form is not abandoned (matched by the contact's e-mail/phone).
    app.events.on('form.submitted', (e) => {
      const c = e.data.contactId ? getContact(app, e.locationId, e.data.contactId) : undefined;
      const keys = [c?.email ? `e:${normalizeEmail(c.email)}` : '', c?.phone ? `p:${normalizePhone(c.phone)}` : ''].filter(Boolean);
      for (const k of keys) db.run(`UPDATE wfx_form_partials SET status = 'submitted' WHERE form_id = ? AND key = ? AND status = 'open'`, e.data.formId, k);
    });

    // --- scheduled scans ----------------------------------------------------------------------------
    const dateScan = async (type: string, at: Date) => {
      for (const wf of flowsOf(app, type)) {
        const c = wf.trigger.config ?? {};
        const tz = tzOf(wf.location_id, c.tz);
        const time = /^\d{2}:\d{2}$/.test(c.time ?? '') ? c.time : '09:00';
        // today once its time has come, and the days the scanner missed (server off) – see dueDays for the rule
        const seen = db.get<{ at: string }>(`SELECT at FROM wfx_fired WHERE kind = 'date-seen' AND key = ?`, wf.id)?.at;
        for (const run of dueDays(at, tz, time, seen, wf.updated_at)) await dateScanDay(type, wf, run.day, run.late);
        db.run(`INSERT INTO wfx_fired (kind, key, at) VALUES ('date-seen', ?, ?) ON CONFLICT(kind, key) DO UPDATE SET at = excluded.at`, wf.id, at.toISOString());
      }
    };
    /** One day of a birthday/anniversary workflow (`today`: the day it runs for; `late`: days it comes late, 0 = on time). */
    const dateScanDay = async (type: string, wf: any, today: string, late: number) => {
      const c = wf.trigger.config ?? {};
      if (!once('date-run', `${wf.id}:${today}`)) return;
      const offset = Math.trunc(Number(c.offset_days) || 0);
      // the day the date itself falls on: today minus the offset (3 days before → the date is 3 days ahead)
      const day = addDaysYmd(today, -offset);
      const mds = monthDaysForToday(day);
      const field = type === 'contact.birthday' ? 'date_of_birth' : String(c.field || 'created_at');
      const key = field.startsWith('custom.') ? field.slice(7) : '';
      if (key ? !/^[\w-]{1,60}$/.test(key) : !['date_of_birth', 'created_at'].includes(field)) return;
      const col = key ? `json_extract(custom, '$.${key}')` : field;
      const isoMd = `substr(${col}, 6, 5)`;
      const deMd = `substr(${col}, 4, 2) || '-' || substr(${col}, 1, 2)`;
      const rows = db.all<any>(
        `SELECT id, created_at, ${key ? `${col} AS d` : `${field} AS d`} FROM contacts WHERE location_id = ? AND COALESCE(${col}, '') != '' AND ((${col} LIKE '____-__-__%' AND ${isoMd} IN (${mds.map(() => '?').join(',')})) OR (${col} LIKE '__.__.____' AND ${deMd} IN (${mds.map(() => '?').join(',')}))) LIMIT 5000`,
        wf.location_id,
        ...mds,
        ...mds,
      );
      // a day caught up late only counts for contacts that existed on it
      const due = late ? zonedToUtc(today, /^\d{2}:\d{2}$/.test(c.time ?? '') ? c.time : '09:00', tzOf(wf.location_id, c.tz)).toISOString() : '';
      const pause = sliceTimer(40);
      for (const r of rows) {
        if (late && String(r.created_at) > due) continue;
        const born = yearOf(r.d);
        const years = born ? Number(day.slice(0, 4)) - born : null;
        if (type === 'contact.anniversary' && (years === null || years < Math.max(0, Number(c.min_years ?? 1)))) continue;
        if (type === 'contact.birthday' && years !== null && (years < 0 || years > 130)) continue;
        if (!once(`${type}`, `${wf.id}:${r.id}:${day.slice(0, 4)}`)) continue;
        // every year the same contact runs through again
        await fire({ ...wf, settings: { ...wf.settings, allow_reentry: true } }, r.id, { date: String(r.d).slice(0, 10), [type === 'contact.birthday' ? 'age' : 'years']: years, day, ...(late ? { late_days: late } : {}) });
        await pause();
      }
    };

    const unanswered = async (at: Date) => {
      for (const wf of flowsOf(app, 'conversation.unanswered')) {
        const minutes = Math.max(1, Number(wf.trigger.config?.minutes) || 60);
        const ch = String(wf.trigger.config?.channel ?? '');
        const rows = db.all<any>(
          `SELECT c.id AS conversation_id, c.contact_id, c.last_message_at, m.id AS message_id, m.channel, m.subject, m.body
           FROM conversations c JOIN messages m ON m.id = (SELECT id FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC, rowid DESC LIMIT 1)
           WHERE c.location_id = ? AND c.last_message_at <= ? AND c.last_message_at > ? AND m.direction = 'in' ${ch ? 'AND m.channel = ?' : ''} ORDER BY c.last_message_at LIMIT 200`,
          wf.location_id,
          new Date(at.getTime() - minutes * 60_000).toISOString(),
          new Date(at.getTime() - 7 * 864e5).toISOString(),
          ...(ch ? [ch] : []),
        );
        for (const r of rows) {
          if (!once('conversation.unanswered', `${wf.id}:${r.message_id}`)) continue;
          await fire(wf, r.contact_id, { conversationId: r.conversation_id, message: { id: r.message_id, channel: r.channel, subject: r.subject, body: r.body }, minutes: Math.round((at.getTime() - Date.parse(r.last_message_at)) / 60_000) });
        }
      }
    };

    const startsSoon = async (at: Date) => {
      for (const wf of flowsOf(app, 'appointment.starts_soon')) {
        const c = wf.trigger.config ?? {};
        const minutes = Math.max(1, Number(c.minutes_before) || 60);
        const rows = db.all<any>(`SELECT * FROM appointments WHERE location_id = ? AND status = 'confirmed' AND contact_id IS NOT NULL AND start_at > ? AND start_at <= ? ${c.calendar_id ? 'AND calendar_id = ?' : ''} ORDER BY start_at LIMIT 200`, wf.location_id, at.toISOString(), new Date(at.getTime() + minutes * 60_000).toISOString(), ...(c.calendar_id ? [c.calendar_id] : []));
        for (const a of rows) {
          if (!once('appointment.starts_soon', `${wf.id}:${a.id}:${a.start_at}`)) continue;
          await fire(wf, a.contact_id, { appointment: a, calendarId: a.calendar_id, minutesToStart: Math.round((Date.parse(a.start_at) - at.getTime()) / 60_000) });
        }
      }
    };

    const invoicesOverdue = async (at: Date) => {
      for (const wf of flowsOf(app, 'invoice.overdue')) {
        const days = Math.max(0, Math.floor(Number(wf.trigger.config?.days_overdue ?? 1)) || 0);
        // Days are calendar days of the sub-account: "1 day" is from midnight after the due day, not 24 hours after the due time
        // (an invoice due yesterday 23:00 is 1 day overdue at 08:00). 0 days = as soon as the due time has passed.
        const tz = tzOf(wf.location_id);
        const cutoff = days > 0 ? overdueBefore(tz, at, days) : at.toISOString();
        // something must still be open: an invoice settled by payments and a credit note stays "sent" but is not overdue
        const rows = db.all<any>(`SELECT * FROM invoices WHERE location_id = ? AND kind = 'invoice' AND status = 'sent' AND total_cents - paid_cents - credited_cents - deducted_cents > 0 AND contact_id IS NOT NULL AND due_at ${days > 0 ? '<' : '<='} ? AND due_at > ? ORDER BY due_at LIMIT 200`, wf.location_id, cutoff, new Date(at.getTime() - 120 * 864e5).toISOString());
        for (const i of rows) {
          if (!once('invoice.overdue', `${wf.id}:${i.id}`)) continue;
          await fire(wf, i.contact_id, { invoice: { ...i, items: undefined }, invoiceId: i.id, daysOverdue: daysOverdue(i.due_at, at, tz) });
        }
      }
    };

    const formsAbandoned = async (at: Date) => {
      db.run(`DELETE FROM wfx_form_partials WHERE last_at < ?`, new Date(at.getTime() - 3 * 864e5).toISOString());
      for (const wf of flowsOf(app, 'form.abandoned')) {
        const c = wf.trigger.config ?? {};
        const minutes = Math.max(1, Number(c.minutes) || 30);
        const rows = db.all<any>(`SELECT * FROM wfx_form_partials WHERE location_id = ? AND status = 'open' AND last_at <= ? ${c.form_id ? 'AND form_id = ?' : ''} ORDER BY last_at LIMIT 100`, wf.location_id, new Date(at.getTime() - minutes * 60_000).toISOString(), ...(c.form_id ? [c.form_id] : []));
        for (const p of rows) {
          if (!once('form.abandoned', `${wf.id}:${p.id}:${p.last_at}`)) continue;
          const data = JSON.parse(p.data);
          const form = db.get<any>('SELECT id, name FROM forms WHERE id = ?', p.form_id);
          // an existing contact is found, never changed; a new one is created quietly (no "Kontakt angelegt" workflows) and tagged
          // (public input: a phone number only counts when the visitor gave no e-mail address – services/contacts.ts)
          let contactId = (data.email ? db.get<any>('SELECT id FROM contacts WHERE location_id = ? AND email = ?', p.location_id, data.email)?.id : undefined) ?? (data.phone && !data.email ? db.get<any>('SELECT id FROM contacts WHERE location_id = ? AND phone = ?', p.location_id, data.phone)?.id : undefined);
          if (!contactId) {
            contactId = upsertContact(app, p.location_id, data, { source: `Formular abgebrochen: ${form?.name ?? ''}`, quiet: true, publicInput: true }).contact.id;
            addTags(app, p.location_id, contactId, ['formular-abgebrochen']);
          }
          await fire(wf, contactId, { formId: p.form_id, form: { id: p.form_id, name: form?.name ?? '' }, partial: data, page: p.page });
          db.run(`UPDATE wfx_form_partials SET status = 'fired' WHERE id = ?`, p.id);
        }
      }
    };

    // --- cron ---------------------------------------------------------------------------------------
    const cronBatch = async (wf: any, state: { key: string; last: string; count: number; fired_at: string }) => {
      const c = wf.trigger.config ?? {};
      const max = Math.min(5000, Math.max(1, Number(c.max) || 1000));
      const where = ['location_id = ?', 'id > ?'];
      const params: any[] = [wf.location_id, state.last];
      for (const t of Array.isArray(c.tags) ? c.tags : []) (where.push(`EXISTS (SELECT 1 FROM json_each(contacts.tags) WHERE value = ?)`), params.push(String(t)));
      if (Array.isArray(c.any_tags) && c.any_tags.length) (where.push(`EXISTS (SELECT 1 FROM json_each(contacts.tags) WHERE value IN (${c.any_tags.map(() => '?').join(',')}))`), params.push(...c.any_tags.map(String)));
      for (const t of Array.isArray(c.exclude_tags) ? c.exclude_tags : []) (where.push(`NOT EXISTS (SELECT 1 FROM json_each(contacts.tags) WHERE value = ?)`), params.push(String(t)));
      const rows = db.all<{ id: string }>(`SELECT id FROM contacts WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`, ...params, Math.min(25, max - state.count));
      const pause = sliceTimer(40);
      for (const r of rows) {
        await fire(wf, r.id, { cron: String(c.cron), schedule_key: state.key, scheduled_for: state.fired_at });
        state.last = r.id;
        state.count++;
        await pause();
      }
      return rows.length === 0 || state.count >= max;
    };

    const runCron = async (at: Date) => {
      for (const wf of flowsOf(app, 'schedule.cron')) {
        const c = wf.trigger.config ?? {};
        let cron;
        try {
          cron = parseCron(String(c.cron ?? ''));
        } catch {
          continue;
        }
        const tz = tzOf(wf.location_id, c.tz);
        const W = wallMinute(wallClock(at, tz));
        const row = db.get<{ last_wall: number; pending: string | null }>('SELECT last_wall, pending FROM wfx_cron WHERE workflow_id = ?', wf.id);
        let pending = row?.pending ? JSON.parse(row.pending) : null;
        if (!row) db.run('INSERT INTO wfx_cron (workflow_id, last_wall, pending, updated_at) VALUES (?, ?, NULL, ?)', wf.id, W, now());
        else if (W > row.last_wall) {
          const fires = cronFires(cron, Math.max(row.last_wall, W - 10), W);
          if (fires.length && !pending) {
            const m = fromWallMinute(fires[fires.length - 1]);
            const key = `${m.y}-${String(m.mo).padStart(2, '0')}-${String(m.d).padStart(2, '0')}T${String(m.h).padStart(2, '0')}:${String(m.mi).padStart(2, '0')}`;
            pending = { key, last: '', count: 0, fired_at: zonedToUtc(key.slice(0, 10), key.slice(11), tz).toISOString() };
          }
          db.run('UPDATE wfx_cron SET last_wall = ?, updated_at = ? WHERE workflow_id = ?', W, now(), wf.id);
        }
        if (pending) {
          const done = await cronBatch(wf, pending);
          db.run('UPDATE wfx_cron SET pending = ?, updated_at = ? WHERE workflow_id = ?', done ? null : JSON.stringify(pending), now(), wf.id);
        }
      }
    };

    let lastScan = 0;
    /** All scheduled triggers once (also what the tests call with a moved clock). */
    const runScans = async (at: Date = clock()) => {
      await runCron(at);
      await dateScan('contact.birthday', at);
      await dateScan('contact.anniversary', at);
      await unanswered(at);
      await startsSoon(at);
      await invoicesOverdue(at);
      await formsAbandoned(at);
      db.run(`DELETE FROM wfx_fired WHERE at < ? AND kind IN ('date-run')`, new Date(at.getTime() - 3 * 864e5).toISOString());
      // "Already fired" marks are only needed while the scan can still see the record (unanswered: 7 days back, abandoned forms:
      // 3 days, overdue invoices: 120 days, appointments: until they start) – then they would only pile up.
      for (const [kind, days] of [['conversation.unanswered', 10], ['form.abandoned', 7], ['invoice.overdue', 150], ['appointment.starts_soon', 400]] as const) {
        db.run('DELETE FROM wfx_fired WHERE kind = ? AND at < ?', kind, new Date(at.getTime() - days * 864e5).toISOString());
      }
    };
    app.services.wfxRunScans = runScans;
    app.onTick(async () => {
      // the cron minute is checked on every tick, the rest about once a minute
      if (Date.now() - lastScan >= SCAN_EVERY_MS) {
        lastScan = Date.now();
        await runScans();
      } else await runCron(clock());
    });
  },
};
