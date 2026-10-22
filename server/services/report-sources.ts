import type { Db } from '../core/db.js';
import { creditClosedSql, paidRevenueSql } from './invoice-model.js';
import type { Lookup, ReportField, ReportJoin, ReportSource } from './report-engine.js';

/**
 * Built-in report sources. Each is a plain object: FROM clause, the column that holds the
 * sub-account, fields (dimensions, date fields, numbers) and calculated measures. All SQL here is
 * fixed code; user input only ever reaches the engine as bound parameters.
 *
 * Other modules add their own with a few lines (see docs/architecture.md → Berichte):
 *   app.services.reportSources = [...(app.services.reportSources ?? []), MY_SOURCE];
 */

// --- lookups ------------------------------------------------------------------------------------

const chunks = <T>(xs: T[], n = 400): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** id → label from a table (table and column names are constants in code). */
export function lookupTable(table: string, labelSql = 'name', idCol = 'id'): Lookup {
  return (db: Db, keys: string[]) => {
    const out = new Map<string, { label: string }>();
    for (const part of chunks(keys)) {
      for (const r of db.all(`SELECT ${idCol} AS id, ${labelSql} AS label FROM ${table} WHERE ${idCol} IN (${part.map(() => '?').join(', ')})`, ...part)) {
        out.set(String(r.id), { label: String(r.label ?? '') || String(r.id) });
      }
    }
    return out;
  };
}

export const userLookup = lookupTable('users', 'name');
export const contactLookup = lookupTable('contacts', `COALESCE(NULLIF(TRIM(first_name || ' ' || last_name), ''), NULLIF(email, ''), NULLIF(phone, ''), 'Unbekannt')`);
export const locationLookup = lookupTable('locations', 'name');

/** Pipeline stages in their pipeline order (funnels and stage charts keep that order). */
export const stageLookup: Lookup = (db, keys) => {
  const out = new Map<string, { label: string; order: number }>();
  const rows = db.all(
    `SELECT p.id pid, p.name pname, json_extract(s.value, '$.id') sid, json_extract(s.value, '$.name') sname, CAST(s.key AS INTEGER) pos
     FROM pipelines p, json_each(p.stages) s ORDER BY p.created_at, p.id`,
  );
  const wanted = new Set(keys);
  const hit = rows.filter((r) => wanted.has(String(r.sid)));
  const pipes = [...new Set(hit.map((r) => r.pid))];
  for (const r of hit) {
    out.set(String(r.sid), { label: pipes.length > 1 ? `${r.pname} · ${r.sname}` : String(r.sname), order: pipes.indexOf(r.pid) * 1000 + Number(r.pos) });
  }
  return out;
};

/** Default probability of the stage at `index` of `count` stages when none is set (e.g. 25/50/75 %). */
export const defaultStageProbability = (index: number, count: number) => Math.round(((index + 1) * 100) / (count + 1));

/** Probability (0–100) of an opportunity row aliased `o`: won 100, lost/abandoned 0, open = its stage's value. */
const PROB = `(CASE o.status WHEN 'won' THEN 100.0 WHEN 'lost' THEN 0.0 WHEN 'abandoned' THEN 0.0 ELSE COALESCE((
  SELECT COALESCE(json_extract(s.value, '$.probability'), ROUND((CAST(s.key AS INTEGER) + 1) * 100.0 / (json_array_length(p.stages) + 1)))
  FROM pipelines p, json_each(p.stages) s WHERE p.id = o.pipeline_id AND json_extract(s.value, '$.id') = o.stage_id), 0) END)`;

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
/** Midnight of today in the sub-account's zone (report-engine.ts): an invoice is overdue from the day after its due day. */
const TODAY = 'rpt_day_start()';

/** A recurring invoice (alias `s`) as monthly amount in euros, and whether it still runs. */
const MONTHLY = `(s.total_cents / 100.0 * CASE json_extract(s.recurring, '$.interval') WHEN 'week' THEN 52.0 / 12 WHEN 'quarter' THEN 1 / 3.0 WHEN 'year' THEN 1 / 12.0 ELSE 1 END)`;
const ACTIVE_SUB = `(COALESCE(json_extract(s.recurring, '$.active'), 0) = 1 AND (json_extract(s.recurring, '$.end_at') IS NULL OR json_extract(s.recurring, '$.end_at') > ${NOW}))`;

// --- field helpers ------------------------------------------------------------------------------

const date = (key: string, label: string, sql: string, extra: Partial<ReportField> = {}): ReportField => ({ key, label, type: 'date', sql, ...extra });
const text = (key: string, label: string, sql: string, extra: Partial<ReportField> = {}): ReportField => ({ key, label, type: 'string', sql, ...extra });
const choice = (key: string, label: string, sql: string, options: Record<string, string>, extra: Partial<ReportField> = {}): ReportField => ({ key, label, type: 'enum', sql, options, ...extra });
const flag = (key: string, label: string, sql: string, yes = 'Ja', no = 'Nein', extra: Partial<ReportField> = {}): ReportField => ({ key, label, type: 'boolean', sql: `(CASE WHEN ${sql} THEN 1 ELSE 0 END)`, options: { 1: yes, 0: no }, ...extra });
const number = (key: string, label: string, sql: string, format: ReportField['format'] = 'number', extra: Partial<ReportField> = {}): ReportField => ({ key, label, type: 'number', sql, format, ...extra });
const user = (key: string, label: string, sql: string, empty = 'Nicht zugewiesen'): ReportField => ({ key, label, type: 'string', sql, lookup: userLookup, empty });
const looked = (key: string, label: string, sql: string, lookup: Lookup, empty = '(ohne)'): ReportField => ({ key, label, type: 'string', sql, lookup, empty });

/** Join on the contact of a row + the contact's fields as "Kontakt: …". */
export function contactJoin(fk: string): { joins: Record<string, ReportJoin>; fields: ReportField[] } {
  const g = { join: 'contact', group: 'Kontakt' };
  return {
    joins: { contact: { sql: `LEFT JOIN contacts jc ON jc.id = ${fk}` } },
    fields: [
      looked('contact', 'Kontakt', fk, contactLookup, 'Ohne Kontakt'),
      text('contact_source', 'Kontakt: Quelle', `jc.source`, { ...g, empty: 'Unbekannt' }),
      { key: 'contact_tags', label: 'Kontakt: Tags', type: 'tags', sql: 'jc.tags', ...g },
      text('contact_city', 'Kontakt: Stadt', 'jc.city', g),
      text('contact_country', 'Kontakt: Land', 'jc.country', g),
      text('contact_company', 'Kontakt: Firma', 'jc.company', g),
      { ...user('contact_owner', 'Kontakt: Zuständig', 'jc.assigned_to'), ...g },
      date('contact_created_at', 'Kontakt: Erstellt am', 'jc.created_at', g),
    ],
  };
}

const MSG_STATUS = { queued: 'Wartet', sent: 'Gesendet', delivered: 'Zugestellt', read: 'Gelesen', logged: 'Gespeichert', failed: 'Fehlgeschlagen', received: 'Empfangen' };
const CHANNELS = { email: 'E-Mail', sms: 'SMS', chat: 'Live-Chat', whatsapp: 'WhatsApp', messenger: 'Messenger', instagram: 'Instagram', call: 'Anruf' };
const INVOICE_STATUS = { draft: 'Entwurf', sent: 'Offen', paid: 'Bezahlt', accepted: 'Angenommen', void: 'Storniert', credited: 'Gutgeschrieben' };
/** The stored status, with an invoice closed by its credit notes (stored `void`) as `credited` – not "Storniert". */
const INVOICE_STATUS_SQL = `CASE WHEN ${creditClosedSql('i.')} THEN 'credited' ELSE i.status END`;

// --- sources ------------------------------------------------------------------------------------

const oppContact = contactJoin('o.contact_id');
const taskContact = contactJoin('t.contact_id');
const apptContact = contactJoin('a.contact_id');
const msgContact = contactJoin('m.contact_id');
const convContact = contactJoin('v.contact_id');
const callContact = contactJoin('k.contact_id');
const invContact = contactJoin('i.contact_id');
const formContact = contactJoin('f.contact_id');

export const BUILTIN_SOURCES: ReportSource[] = [
  {
    key: 'contacts',
    label: 'Kontakte',
    description: 'Leads und Kunden: Quelle, Zuständige, Tags, Herkunft.',
    area: 'contacts',
    from: 'contacts c',
    location: 'c.location_id',
    dateField: 'created_at',
    countLabel: 'Anzahl Kontakte',
    joins: { attr: { sql: 'LEFT JOIN attribution_contacts jac ON jac.contact_id = c.id', requires: ['attribution_contacts'] } },
    fields: [
      date('created_at', 'Erstellt am', 'c.created_at'),
      date('last_activity_at', 'Letzte Aktivität', 'c.last_activity_at'),
      text('source', 'Quelle', 'c.source', { empty: 'Unbekannt' }),
      user('assigned_to', 'Zuständig', 'c.assigned_to'),
      text('city', 'Stadt', 'c.city'),
      text('country', 'Land', 'c.country'),
      text('company', 'Firma', 'c.company'),
      { key: 'tags', label: 'Tags', type: 'tags', sql: 'c.tags' },
      flag('dnd', 'Nicht stören', 'c.dnd = 1'),
      flag('has_email', 'Hat E-Mail', `c.email != ''`),
      flag('has_phone', 'Hat Telefon', `c.phone != ''`),
      flag('has_opportunity', 'Hat Opportunity', 'EXISTS (SELECT 1 FROM opportunities xo WHERE xo.contact_id = c.id)'),
      flag('customer', 'Ist Kunde', `EXISTS (SELECT 1 FROM invoices xi WHERE xi.contact_id = c.id AND xi.status = 'paid')`, 'Kunde', 'Kein Kunde'),
      text('first_source', 'Erste Quelle (Attribution)', 'jac.first_source', { join: 'attr', group: 'Attribution', empty: 'Unbekannt' }),
      text('first_medium', 'Erstes Medium (Attribution)', 'jac.first_medium', { join: 'attr', group: 'Attribution', empty: 'Unbekannt' }),
      text('first_campaign', 'Erste Kampagne (Attribution)', 'jac.first_campaign', { join: 'attr', group: 'Attribution', empty: '(ohne)' }),
      text('last_source', 'Letzte Quelle (Attribution)', 'jac.last_source', { join: 'attr', group: 'Attribution', empty: 'Unbekannt' }),
    ],
    calcs: [
      { key: 'deal_rate', label: 'Lead → Deal', sql: '100.0 * SUM(CASE WHEN EXISTS (SELECT 1 FROM opportunities xo WHERE xo.contact_id = c.id) THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0)', format: 'percent', description: 'Anteil der Kontakte mit mindestens einer Opportunity' },
      { key: 'customer_rate', label: 'Lead → Kunde', sql: `100.0 * SUM(CASE WHEN EXISTS (SELECT 1 FROM invoices xi WHERE xi.contact_id = c.id AND xi.status = 'paid') THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0)`, format: 'percent' },
    ],
  },
  {
    key: 'opportunities',
    label: 'Opportunities',
    description: 'Deals mit Pipeline, Phase, Status, Wert (Währung wird nicht umgerechnet), erwartetem Abschluss, Verlustgrund, Gewinn-/Verlustdatum und Wahrscheinlichkeit.',
    area: 'opportunities',
    from: 'opportunities o',
    location: 'o.location_id',
    dateField: 'created_at',
    countLabel: 'Anzahl Deals',
    joins: oppContact.joins,
    fields: [
      date('created_at', 'Erstellt am', 'o.created_at'),
      date('closed_at', 'Abgeschlossen am', `COALESCE(o.closed_at, CASE WHEN o.status != 'open' THEN o.updated_at END)`),
      date('won_at', 'Gewonnen am', `CASE WHEN o.status = 'won' THEN COALESCE(o.closed_at, o.updated_at) END`),
      date('lost_at', 'Verloren am', `CASE WHEN o.status = 'lost' THEN COALESCE(o.closed_at, o.updated_at) END`),
      date('stage_changed_at', 'Phase geändert am', 'COALESCE(o.stage_changed_at, o.created_at)'),
      // Entered as a day; read as noon so ranges and month buckets never slip across midnight in any time zone.
      date('expected_close_date', 'Erwarteter Abschluss', `CASE WHEN o.expected_close_date IS NOT NULL THEN o.expected_close_date || 'T12:00:00.000Z' END`),
      looked('pipeline', 'Pipeline', 'o.pipeline_id', lookupTable('pipelines', 'name')),
      looked('stage', 'Phase', 'o.stage_id', stageLookup),
      choice('status', 'Status', 'o.status', { open: 'Offen', won: 'Gewonnen', lost: 'Verloren', abandoned: 'Aufgegeben' }),
      text('source', 'Quelle', 'o.source', { empty: 'Unbekannt' }),
      text('lost_reason', 'Verlustgrund', `CASE WHEN o.status = 'lost' THEN NULLIF(o.lost_reason, '') END`, { empty: 'Ohne Angabe' }),
      text('currency', 'Währung', `COALESCE(NULLIF(o.currency, ''), 'EUR')`),
      flag('close_overdue', 'Abschluss überfällig', `o.status = 'open' AND o.expected_close_date IS NOT NULL AND o.expected_close_date < date('now')`, 'Überfällig', 'Im Plan'),
      user('assigned_to', 'Zuständig', 'o.assigned_to'),
      number('value', 'Wert', 'o.value', 'money'),
      number('weighted_value', 'Gewichteter Wert', `(o.value * ${PROB} / 100.0)`, 'money'),
      number('probability', 'Wahrscheinlichkeit', PROB, 'percent'),
      number('days_to_expected_close', 'Tage bis erwarteter Abschluss', `(CASE WHEN o.status = 'open' AND o.expected_close_date IS NOT NULL THEN julianday(o.expected_close_date) - julianday('now') END)`, 'days'),
      number('days_to_close', 'Tage bis Abschluss', `(CASE WHEN o.status != 'open' THEN julianday(COALESCE(o.closed_at, o.updated_at)) - julianday(o.created_at) END)`, 'days'),
      number('age_days', 'Alter', `(julianday('now') - julianday(o.created_at))`, 'days'),
      number('days_in_stage', 'Tage in aktueller Phase', `(julianday('now') - julianday(COALESCE(o.stage_changed_at, o.created_at)))`, 'days'),
      ...oppContact.fields,
    ],
    calcs: [
      { key: 'win_rate', label: 'Win-Rate', sql: `100.0 * SUM(o.status = 'won') / NULLIF(SUM(o.status IN ('won', 'lost')), 0)`, format: 'percent', description: 'Gewonnen ÷ (gewonnen + verloren)' },
      { key: 'won_value', label: 'Gewonnener Umsatz', sql: `COALESCE(SUM(CASE WHEN o.status = 'won' THEN o.value END), 0)`, format: 'money' },
      { key: 'open_value', label: 'Offener Pipeline-Wert', sql: `COALESCE(SUM(CASE WHEN o.status = 'open' THEN o.value END), 0)`, format: 'money' },
      { key: 'forecast', label: 'Umsatzprognose (gewichtet)', sql: `COALESCE(SUM(CASE WHEN o.status = 'open' THEN o.value * ${PROB} / 100.0 END), 0)`, format: 'money', description: 'Offene Deals × Wahrscheinlichkeit ihrer Phase' },
      { key: 'lost_value', label: 'Verlorener Umsatz', sql: `COALESCE(SUM(CASE WHEN o.status = 'lost' THEN o.value END), 0)`, format: 'money', description: 'Summe der verlorenen Deals – nach Verlustgrund gruppieren' },
      { key: 'avg_won_value', label: 'Ø Wert gewonnener Deals', sql: `AVG(CASE WHEN o.status = 'won' THEN o.value END)`, format: 'money' },
      { key: 'velocity', label: 'Deal-Geschwindigkeit', sql: `AVG(CASE WHEN o.status = 'won' THEN julianday(COALESCE(o.closed_at, o.updated_at)) - julianday(o.created_at) END)`, format: 'days', description: 'Ø Tage von Anlage bis Gewinn' },
      { key: 'won_count', label: 'Gewonnene Deals', sql: `SUM(o.status = 'won')` },
      { key: 'lost_count', label: 'Verlorene Deals', sql: `SUM(o.status = 'lost')` },
    ],
  },
  {
    key: 'tasks',
    label: 'Aufgaben',
    description: 'Aufgaben je Nutzer, offen/erledigt, überfällig.',
    area: 'contacts',
    from: 'tasks t',
    location: 't.location_id',
    dateField: 'created_at',
    countLabel: 'Anzahl Aufgaben',
    joins: taskContact.joins,
    fields: [
      date('created_at', 'Erstellt am', 't.created_at'),
      date('due_at', 'Fällig am', 't.due_at'),
      date('completed_at', 'Erledigt am', 't.completed_at'),
      user('assigned_to', 'Zuständig', 't.assigned_to'),
      flag('done', 'Status', 't.done = 1', 'Erledigt', 'Offen'),
      flag('overdue', 'Überfällig', `t.done = 0 AND t.due_at IS NOT NULL AND t.due_at < ${NOW}`, 'Überfällig', 'Im Plan'),
      text('title', 'Titel', 't.title', { noGroup: true }),
      number('days_to_complete', 'Tage bis erledigt', '(julianday(t.completed_at) - julianday(t.created_at))', 'days'),
      ...taskContact.fields,
    ],
    calcs: [
      { key: 'done_count', label: 'Erledigt', sql: 'SUM(t.done = 1)' },
      { key: 'open_count', label: 'Offen', sql: 'SUM(t.done = 0)' },
      { key: 'completion_rate', label: 'Erledigungsquote', sql: '100.0 * SUM(t.done = 1) / NULLIF(COUNT(*), 0)', format: 'percent' },
    ],
  },
  {
    key: 'appointments',
    label: 'Termine',
    description: 'Gebuchte Termine je Kalender und Status, No-Show-Rate.',
    area: 'calendars',
    from: 'appointments a',
    location: 'a.location_id',
    where: `a.status != 'blocked'`,
    dateField: 'start_at',
    countLabel: 'Anzahl Termine',
    joins: apptContact.joins,
    fields: [
      date('start_at', 'Termin am', 'a.start_at'),
      date('created_at', 'Gebucht am', 'a.created_at'),
      looked('calendar', 'Kalender', 'a.calendar_id', lookupTable('calendars', 'name')),
      choice('status', 'Status', 'a.status', { confirmed: 'Bestätigt', showed: 'Erschienen', noshow: 'Nicht erschienen', cancelled: 'Abgesagt' }),
      text('source', 'Herkunft', 'a.source', { empty: 'Unbekannt' }),
      number('duration', 'Dauer', '((julianday(a.end_at) - julianday(a.start_at)) * 1440)', 'minutes'),
      number('lead_days', 'Vorlauf', '(julianday(a.start_at) - julianday(a.created_at))', 'days'),
      ...apptContact.fields,
    ],
    calcs: [
      { key: 'no_show_rate', label: 'No-Show-Rate', sql: `100.0 * SUM(a.status = 'noshow') / NULLIF(SUM(a.status IN ('showed', 'noshow')), 0)`, format: 'percent', description: 'Nicht erschienen ÷ (erschienen + nicht erschienen)' },
      { key: 'show_rate', label: 'Show-Rate', sql: `100.0 * SUM(a.status = 'showed') / NULLIF(SUM(a.status IN ('showed', 'noshow')), 0)`, format: 'percent' },
      { key: 'cancel_rate', label: 'Absagequote', sql: `100.0 * SUM(a.status = 'cancelled') / NULLIF(COUNT(*), 0)`, format: 'percent' },
      { key: 'noshow_count', label: 'Nicht erschienen', sql: `SUM(a.status = 'noshow')` },
    ],
  },
  {
    key: 'messages',
    label: 'Nachrichten',
    description: 'Ein- und ausgehende Nachrichten je Kanal, Nutzer, Öffnungen und Klicks.',
    area: 'conversations',
    from: 'messages m',
    location: 'm.location_id',
    where: `m.status != 'draft'`,
    dateField: 'created_at',
    countLabel: 'Anzahl Nachrichten',
    joins: msgContact.joins,
    fields: [
      date('created_at', 'Gesendet/empfangen am', 'm.created_at'),
      choice('channel', 'Kanal', 'm.channel', CHANNELS),
      choice('direction', 'Richtung', 'm.direction', { in: 'Eingehend', out: 'Ausgehend' }),
      choice('status', 'Status', 'm.status', MSG_STATUS),
      user('user', 'Gesendet von', 'm.user_id', 'Automatisch/System'),
      text('source', 'Herkunft', 'm.source', { empty: 'Direkt' }),
      // Opened / clicked are people; Apple Mail, mail-provider proxies and security scanners are counted apart (docs/email-tracking.md).
      flag('opened', 'Geöffnet', 'm.opened_at IS NOT NULL'),
      flag('clicked', 'Geklickt', 'm.clicked_at IS NOT NULL'),
      flag('machine_opened', 'Maschinell geöffnet (nicht gezählt)', 'm.machine_open_count > 0'),
      ...msgContact.fields,
    ],
    calcs: [
      { key: 'inbound', label: 'Eingehend', sql: `SUM(m.direction = 'in')` },
      { key: 'outbound', label: 'Ausgehend', sql: `SUM(m.direction = 'out')` },
      { key: 'open_rate', label: 'Öffnungsrate (E-Mail)', sql: `100.0 * SUM(m.opened_at IS NOT NULL) / NULLIF(SUM(m.direction = 'out' AND m.channel = 'email'), 0)`, format: 'percent' },
      { key: 'click_rate', label: 'Klickrate (E-Mail)', sql: `100.0 * SUM(m.clicked_at IS NOT NULL) / NULLIF(SUM(m.direction = 'out' AND m.channel = 'email'), 0)`, format: 'percent' },
      { key: 'machine_opened', label: 'Maschinell geöffnet (nicht gezählt)', sql: `SUM(m.direction = 'out' AND m.channel = 'email' AND m.machine_open_count > 0)` },
    ],
  },
  {
    key: 'conversations',
    label: 'Konversationen',
    description: 'Gespräche je Kontakt: neu, ungelesen, markiert.',
    area: 'conversations',
    from: 'conversations v',
    location: 'v.location_id',
    dateField: 'created_at',
    countLabel: 'Anzahl Konversationen',
    joins: convContact.joins,
    fields: [
      date('created_at', 'Begonnen am', 'v.created_at'),
      date('last_message_at', 'Letzte Nachricht', 'v.last_message_at'),
      flag('unread', 'Ungelesen', 'v.unread > 0', 'Ungelesen', 'Gelesen'),
      flag('starred', 'Markiert', 'v.starred = 1'),
      number('unread_count', 'Ungelesene Nachrichten', 'v.unread'),
      ...convContact.fields,
    ],
  },
  {
    key: 'calls',
    label: 'Anrufe',
    description: 'Telefonate je Richtung, Nutzer und Status mit Gesprächsdauer.',
    area: 'conversations',
    from: 'calls k',
    location: 'k.location_id',
    requires: ['calls'],
    dateField: 'started_at',
    countLabel: 'Anzahl Anrufe',
    joins: callContact.joins,
    fields: [
      date('started_at', 'Anruf am', 'k.started_at'),
      choice('direction', 'Richtung', 'k.direction', { in: 'Eingehend', out: 'Ausgehend' }),
      choice('status', 'Status', 'k.status', { completed: 'Angenommen', missed: 'Verpasst', voicemail: 'Voicemail', busy: 'Besetzt', 'no-answer': 'Nicht erreicht', canceled: 'Abgebrochen', failed: 'Fehlgeschlagen', ringing: 'Klingelt', 'in-progress': 'Läuft', initiated: 'Wird aufgebaut' }),
      flag('answered', 'Angenommen', 'k.answered = 1', 'Angenommen', 'Nicht angenommen'),
      user('user', 'Mitarbeiter', 'k.user_id', 'Ohne Zuordnung'),
      number('duration', 'Gesprächsdauer', '(k.duration / 60.0)', 'minutes'),
      ...callContact.fields,
    ],
    calcs: [
      { key: 'answer_rate', label: 'Annahmequote', sql: '100.0 * SUM(k.answered = 1) / NULLIF(COUNT(*), 0)', format: 'percent' },
      { key: 'minutes', label: 'Gesprächsminuten', sql: 'COALESCE(SUM(k.duration), 0) / 60.0', format: 'minutes' },
      { key: 'missed', label: 'Verpasst', sql: `SUM(k.direction = 'in' AND k.answered = 0)` },
    ],
  },
  {
    key: 'invoices',
    label: 'Rechnungen & Zahlungen',
    description: 'Rechnungen und Angebote: bezahlte und offene Beträge, Abo-Rechnungen.',
    area: 'payments',
    from: 'invoices i',
    location: 'i.location_id',
    dateField: 'issued_at',
    countLabel: 'Anzahl Belege',
    joins: invContact.joins,
    fields: [
      date('issued_at', 'Rechnungsdatum', 'i.issued_at'),
      date('paid_at', 'Bezahlt am', 'i.paid_at'),
      date('due_at', 'Fällig am', 'i.due_at'),
      choice('kind', 'Art', 'i.kind', { invoice: 'Rechnung', estimate: 'Angebot' }),
      choice('status', 'Status', INVOICE_STATUS_SQL, INVOICE_STATUS),
      flag('overdue', 'Überfällig', `i.kind = 'invoice' AND i.status = 'sent' AND i.total_cents - i.paid_cents - i.credited_cents - i.deducted_cents > 0 AND i.due_at < ${TODAY}`, 'Überfällig', 'Nicht überfällig'),
      flag('recurring', 'Abo-Rechnung', 'i.parent_id IS NOT NULL', 'Abo', 'Einmalig'),
      text('currency', 'Währung', 'i.currency'),
      number('total', 'Betrag (brutto)', '(i.total_cents / 100.0)', 'money'),
      number('net', 'Betrag (netto)', '(i.subtotal_cents / 100.0)', 'money'),
      number('tax', 'Steuer', '(i.tax_cents / 100.0)', 'money'),
      number('days_to_pay', 'Tage bis Zahlung', '(julianday(i.paid_at) - julianday(i.issued_at))', 'days'),
      ...invContact.fields,
    ],
    calcs: [
      { key: 'paid_amount', label: 'Bezahlter Umsatz', sql: `COALESCE(SUM(CASE WHEN i.status = 'paid' THEN ${paidRevenueSql('i.')} END), 0) / 100.0`, format: 'money' },
      { key: 'open_amount', label: 'Offene Rechnungen', sql: `COALESCE(SUM(CASE WHEN i.kind = 'invoice' AND i.status = 'sent' THEN MAX(0, i.total_cents - i.paid_cents - i.credited_cents - i.deducted_cents) END), 0) / 100.0`, format: 'money' },
      { key: 'overdue_amount', label: 'Überfällige Beträge', sql: `COALESCE(SUM(CASE WHEN i.kind = 'invoice' AND i.status = 'sent' AND i.due_at < ${TODAY} THEN MAX(0, i.total_cents - i.paid_cents - i.credited_cents - i.deducted_cents) END), 0) / 100.0`, format: 'money' },
      { key: 'open_count', label: 'Anzahl offen', sql: `SUM(i.kind = 'invoice' AND i.status = 'sent' AND i.total_cents - i.paid_cents - i.credited_cents - i.deducted_cents > 0)` },
    ],
  },
  {
    key: 'invoice_items',
    label: 'Umsatz je Produkt',
    description: 'Rechnungspositionen (Produkte/Leistungen) mit Menge und Netto-Umsatz.',
    area: 'payments',
    from: 'invoices i JOIN json_each(i.items) it',
    location: 'i.location_id',
    where: `i.kind = 'invoice' AND i.status != 'void'`,
    dateField: 'paid_at',
    countLabel: 'Anzahl Positionen',
    fields: [
      date('paid_at', 'Bezahlt am', 'i.paid_at'),
      date('issued_at', 'Rechnungsdatum', 'i.issued_at'),
      text('product', 'Produkt/Position', `json_extract(it.value, '$.name')`, { empty: '(ohne Namen)' }),
      choice('status', 'Rechnungsstatus', INVOICE_STATUS_SQL, INVOICE_STATUS),
      number('qty', 'Menge', `COALESCE(json_extract(it.value, '$.qty'), 1)`),
      number('revenue', 'Umsatz (netto)', `(COALESCE(json_extract(it.value, '$.qty'), 1) * COALESCE(json_extract(it.value, '$.price_cents'), 0) / 100.0)`, 'money'),
    ],
    calcs: [{ key: 'paid_revenue', label: 'Bezahlter Umsatz (netto)', sql: `COALESCE(SUM(CASE WHEN i.status = 'paid' THEN COALESCE(json_extract(it.value, '$.qty'), 1) * COALESCE(json_extract(it.value, '$.price_cents'), 0) END), 0) / 100.0`, format: 'money' }],
  },
  {
    key: 'subscriptions',
    label: 'Abos (MRR)',
    description: 'Wiederkehrende Rechnungen, auf den Monat umgerechnet.',
    area: 'payments',
    from: 'invoices s',
    location: 's.location_id',
    where: 's.recurring IS NOT NULL',
    dateField: 'created_at',
    countLabel: 'Anzahl Abos',
    fields: [
      date('created_at', 'Angelegt am', 's.created_at'),
      date('next_at', 'Nächste Rechnung', `json_extract(s.recurring, '$.next_at')`),
      choice('interval', 'Intervall', `json_extract(s.recurring, '$.interval')`, { week: 'Wöchentlich', month: 'Monatlich', quarter: 'Vierteljährlich', year: 'Jährlich' }),
      flag('active', 'Status', ACTIVE_SUB, 'Aktiv', 'Beendet'),
      looked('contact', 'Kunde', 's.contact_id', contactLookup, 'Ohne Kontakt'),
      number('monthly', 'Monatlicher Wert', MONTHLY, 'money'),
    ],
    calcs: [
      { key: 'mrr', label: 'MRR', sql: `COALESCE(SUM(CASE WHEN ${ACTIVE_SUB} THEN ${MONTHLY} END), 0)`, format: 'money', description: 'Monatlich wiederkehrender Umsatz aktiver Abos (brutto)' },
      { key: 'arr', label: 'ARR', sql: `COALESCE(SUM(CASE WHEN ${ACTIVE_SUB} THEN ${MONTHLY} END), 0) * 12`, format: 'money' },
      { key: 'active_count', label: 'Aktive Abos', sql: `SUM(CASE WHEN ${ACTIVE_SUB} THEN 1 ELSE 0 END)` },
    ],
  },
  {
    key: 'campaigns',
    label: 'Kampagnen',
    description: 'Empfänger je Kampagne: gesendet, geöffnet, geklickt.',
    area: 'campaigns',
    from: 'campaign_recipients r JOIN campaigns cp ON cp.id = r.campaign_id LEFT JOIN messages rm ON rm.id = r.message_id',
    location: 'cp.location_id',
    dateField: 'sent_at',
    countLabel: 'Empfänger',
    fields: [
      date('sent_at', 'Versendet am', 'COALESCE(r.sent_at, cp.sent_at, cp.started_at, cp.created_at)'),
      looked('campaign', 'Kampagne', 'r.campaign_id', lookupTable('campaigns', 'name')),
      choice('channel', 'Kanal', 'cp.channel', CHANNELS),
      choice('status', 'Empfänger-Status', 'r.status', { pending: 'Wartet', sent: 'Gesendet', failed: 'Fehlgeschlagen', skipped: 'Übersprungen' }),
      flag('opened', 'Geöffnet', 'rm.opened_at IS NOT NULL'),
      flag('clicked', 'Geklickt', 'rm.clicked_at IS NOT NULL'),
    ],
    calcs: [
      { key: 'sent', label: 'Gesendet', sql: `SUM(r.status = 'sent')` },
      { key: 'opened', label: 'Geöffnet', sql: 'SUM(rm.opened_at IS NOT NULL)' },
      { key: 'clicked', label: 'Geklickt', sql: 'SUM(rm.clicked_at IS NOT NULL)' },
      { key: 'open_rate', label: 'Öffnungsrate', sql: `100.0 * SUM(rm.opened_at IS NOT NULL) / NULLIF(SUM(r.status = 'sent'), 0)`, format: 'percent' },
      { key: 'click_rate', label: 'Klickrate', sql: `100.0 * SUM(rm.clicked_at IS NOT NULL) / NULLIF(SUM(r.status = 'sent'), 0)`, format: 'percent' },
      { key: 'machine_opened', label: 'Maschinell geöffnet (nicht gezählt)', sql: 'SUM(rm.machine_open_count > 0)' },
      { key: 'machine_clicked', label: 'Maschinell geklickt (nicht gezählt)', sql: 'SUM(rm.machine_click_count > 0)' },
    ],
  },
  {
    key: 'form_submissions',
    label: 'Formular-Einsendungen',
    description: 'Einsendungen je Formular und wie viele daraus Deals und Kunden wurden.',
    area: 'forms',
    from: 'form_submissions f',
    location: 'f.location_id',
    dateField: 'created_at',
    countLabel: 'Einsendungen',
    joins: formContact.joins,
    fields: [date('created_at', 'Eingegangen am', 'f.created_at'), looked('form', 'Formular', 'f.form_id', lookupTable('forms', 'name')), ...formContact.fields],
    calcs: [
      { key: 'contacts', label: 'Kontakte (eindeutig)', sql: 'COUNT(DISTINCT f.contact_id)' },
      { key: 'deal_rate', label: 'Conversion zu Deal', sql: '100.0 * COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM opportunities xo WHERE xo.contact_id = f.contact_id) THEN f.contact_id END) / NULLIF(COUNT(DISTINCT f.contact_id), 0)', format: 'percent', description: 'Anteil der Einsender mit Opportunity' },
      { key: 'customer_rate', label: 'Conversion zu Kunde', sql: `100.0 * COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM opportunities xo WHERE xo.contact_id = f.contact_id AND xo.status = 'won') OR EXISTS (SELECT 1 FROM invoices xi WHERE xi.contact_id = f.contact_id AND xi.status = 'paid') THEN f.contact_id END) / NULLIF(COUNT(DISTINCT f.contact_id), 0)`, format: 'percent', description: 'Anteil der Einsender mit gewonnenem Deal oder bezahlter Rechnung' },
    ],
  },
  {
    key: 'attribution',
    label: 'Attribution (Kontaktpunkte)',
    description: 'Besuche, Formulare, Termine und Käufe je Kanal, Quelle, Kampagne und Funnel.',
    area: 'dashboard',
    from: 'attribution_touches at',
    location: 'at.location_id',
    requires: ['attribution_touches'],
    dateField: 'created_at',
    countLabel: 'Kontaktpunkte',
    fields: [
      date('created_at', 'Zeitpunkt', 'at.created_at'),
      choice('kind', 'Art', 'at.kind', { visit: 'Besuch', form: 'Formular', booking: 'Termin', chat: 'Chat', purchase: 'Kauf' }),
      choice('channel', 'Kanal', 'at.channel', { direct: 'Direkt', referral: 'Verweis', campaign: 'Kampagne' }),
      text('source', 'Quelle', 'at.source', { empty: 'Unbekannt' }),
      text('medium', 'Medium', 'at.medium', { empty: '(ohne)' }),
      text('campaign', 'Kampagne', 'at.campaign', { empty: '(ohne)' }),
      text('landing_page', 'Einstiegsseite', 'at.landing_page', { empty: '(ohne)' }),
      looked('funnel', 'Funnel', 'at.funnel_id', lookupTable('funnels', 'name')),
      flag('has_contact', 'Mit Kontakt', 'at.contact_id IS NOT NULL'),
    ],
    calcs: [
      { key: 'visitors', label: 'Besucher (eindeutig)', sql: 'COUNT(DISTINCT at.visitor_id)' },
      { key: 'contacts', label: 'Kontakte (eindeutig)', sql: 'COUNT(DISTINCT at.contact_id)' },
    ],
  },
  {
    key: 'affiliate_commissions',
    label: 'Affiliate-Provisionen',
    description: 'Provisionen je Partner, Programm und Status.',
    area: 'payments',
    from: 'affiliate_commissions ac',
    location: 'ac.location_id',
    requires: ['affiliate_commissions'],
    dateField: 'created_at',
    countLabel: 'Provisionen',
    fields: [
      date('created_at', 'Erstellt am', 'ac.created_at'),
      date('approved_at', 'Freigegeben am', 'ac.approved_at'),
      date('paid_at', 'Ausgezahlt am', 'ac.paid_at'),
      looked('affiliate', 'Partner', 'ac.affiliate_id', lookupTable('affiliates', `COALESCE(NULLIF(name, ''), email)`)),
      looked('program', 'Programm', 'ac.program_id', lookupTable('affiliate_programs', 'name')),
      choice('status', 'Status', 'ac.status', { pending: 'Vorgemerkt', approved: 'Freigegeben', paid: 'Ausgezahlt', reversed: 'Storniert', void: 'Ungültig' }),
      choice('kind', 'Art', 'ac.kind', { sale: 'Verkauf', recurring: 'Wiederkehrend', clawback: 'Rückbuchung', manual: 'Manuell' }),
      number('amount', 'Provision', '(ac.amount_cents / 100.0)', 'money'),
      number('base', 'Umsatzbasis', '(ac.base_cents / 100.0)', 'money'),
    ],
  },
  {
    key: 'course_enrollments',
    label: 'Kurs-Einschreibungen',
    description: 'Teilnehmer je Kurs, gestartet und abgeschlossen.',
    area: 'courses',
    from: 'course_enrollments ce',
    location: 'ce.location_id',
    requires: ['course_enrollments'],
    dateField: 'enrolled_at',
    countLabel: 'Einschreibungen',
    fields: [
      date('enrolled_at', 'Eingeschrieben am', 'ce.enrolled_at'),
      date('completed_at', 'Abgeschlossen am', 'ce.completed_at'),
      date('last_seen_at', 'Zuletzt aktiv', 'ce.last_seen_at'),
      looked('course', 'Kurs', 'ce.course_id', lookupTable('courses', 'title')),
      choice('status', 'Status', 'ce.status', { active: 'Aktiv', revoked: 'Entzogen' }),
      text('source', 'Zugang über', 'ce.source', { empty: 'Unbekannt' }),
      flag('started', 'Begonnen', 'ce.started_at IS NOT NULL', 'Begonnen', 'Nicht begonnen'),
      flag('completed', 'Abgeschlossen', 'ce.completed_at IS NOT NULL', 'Abgeschlossen', 'Nicht abgeschlossen'),
    ],
    calcs: [
      { key: 'completion_rate', label: 'Abschlussquote', sql: '100.0 * SUM(ce.completed_at IS NOT NULL) / NULLIF(COUNT(*), 0)', format: 'percent' },
      { key: 'start_rate', label: 'Startquote', sql: '100.0 * SUM(ce.started_at IS NOT NULL) / NULLIF(COUNT(*), 0)', format: 'percent' },
    ],
  },
];

/** Every source also gets a "Sub-Account" group (agency reports). */
export function withLocationField(src: ReportSource): ReportSource {
  if (src.fields.some((f) => f.key === 'location')) return src;
  return { ...src, fields: [...src.fields, { key: 'location', label: 'Sub-Account', type: 'string', sql: src.location, lookup: locationLookup }] };
}
