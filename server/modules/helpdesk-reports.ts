import type { Module } from '../core/app.js';
import type { Lookup, ReportField, ReportSource } from '../services/report-engine.js';
import { contactJoin, lookupTable, userLookup } from '../services/report-sources.js';

/**
 * Helpdesk numbers in Berichte & Dashboards: report sources for tickets (status, priority, owner,
 * category, dates, first-response/resolution minutes, SLA breaches), CSAT answers, NPS answers and
 * customer health scores – registered through app.services.reportSources.
 */

const date = (key: string, label: string, sql: string): ReportField => ({ key, label, type: 'date', sql });
const flag = (key: string, label: string, sql: string, yes = 'Ja', no = 'Nein'): ReportField => ({ key, label, type: 'boolean', sql: `(CASE WHEN ${sql} THEN 1 ELSE 0 END)`, options: { 1: yes, 0: no } });
const minutes = (from: string, to: string) => `((julianday(${to}) - julianday(${from})) * 1440)`;

const PRIORITIES = { niedrig: 'Niedrig', normal: 'Normal', hoch: 'Hoch', dringend: 'Dringend' };
const KINDS = { new: 'Neu', open: 'Offen', waiting: 'Wartet', resolved: 'Gelöst', closed: 'Geschlossen' };
const CSAT = { 1: '1 – sehr unzufrieden', 2: '2 – unzufrieden', 3: '3 – neutral', 4: '4 – zufrieden', 5: '5 – sehr zufrieden' };

/** Ticket stages ("<pipeline>:<stage>", stage ids repeat across pipelines) in pipeline order. */
const ticketStageLookup: Lookup = (db, keys) => {
  const out = new Map<string, { label: string; order: number }>();
  const rows = db.all(
    `SELECT p.id pid, p.name pname, json_extract(s.value, '$.id') sid, json_extract(s.value, '$.name') sname, CAST(s.key AS INTEGER) pos
     FROM ticket_pipelines p, json_each(p.stages) s ORDER BY p.position, p.created_at, p.id`,
  );
  const wanted = new Set(keys);
  const hit = rows.filter((r) => wanted.has(`${r.pid}:${r.sid}`));
  const pipes = [...new Set(hit.map((r) => r.pid))];
  for (const r of hit) out.set(`${r.pid}:${r.sid}`, { label: pipes.length > 1 ? `${r.pname} · ${r.sname}` : String(r.sname), order: pipes.indexOf(r.pid) * 1000 + Number(r.pos) });
  return out;
};

const FIRST_LATE = `(t.first_response_due_at IS NOT NULL AND (t.sla_first_state = 'breached' OR t.first_response_at > t.first_response_due_at))`;
const RESOLUTION_LATE = `(t.resolution_due_at IS NOT NULL AND (t.sla_resolution_state = 'breached' OR t.resolved_at > t.resolution_due_at))`;

const ticketContact = contactJoin('t.contact_id');
const TICKETS: ReportSource = {
  key: 'tickets',
  label: 'Tickets',
  description: 'Helpdesk-Tickets mit Status, Priorität, Zuständigen, Antwort- und Lösungszeiten und SLA',
  area: 'helpdesk',
  from: 'tickets t',
  location: 't.location_id',
  where: 't.merged_into IS NULL',
  dateField: 'created_at',
  requires: ['tickets'],
  countLabel: 'Anzahl Tickets',
  joins: ticketContact.joins,
  fields: [
    date('created_at', 'Erstellt am', 't.created_at'),
    date('first_response_at', 'Erste Antwort am', 't.first_response_at'),
    date('resolved_at', 'Gelöst am', 't.resolved_at'),
    date('closed_at', 'Geschlossen am', 't.closed_at'),
    { key: 'status', label: 'Status (Stufe)', type: 'string', sql: `t.pipeline_id || ':' || t.stage_id`, lookup: ticketStageLookup },
    { key: 'status_kind', label: 'Status-Art', type: 'enum', sql: 't.status_kind', options: KINDS },
    { key: 'priority', label: 'Priorität', type: 'enum', sql: 't.priority', options: PRIORITIES },
    { key: 'category', label: 'Kategorie', type: 'string', sql: 't.category', empty: 'Ohne Kategorie' },
    { key: 'source', label: 'Quelle', type: 'string', sql: 't.source', empty: 'Unbekannt' },
    { key: 'owner', label: 'Zuständig', type: 'string', sql: 't.owner_id', lookup: userLookup, empty: 'Nicht zugewiesen' },
    { key: 'team', label: 'Team', type: 'string', sql: 't.team_id', lookup: lookupTable('helpdesk_teams', 'name'), empty: 'Ohne Team' },
    { key: 'pipeline', label: 'Ticket-Pipeline', type: 'string', sql: 't.pipeline_id', lookup: lookupTable('ticket_pipelines', 'name') },
    { key: 'tags', label: 'Tags', type: 'tags', sql: 't.tags' },
    { key: 'first_response_min', label: 'Erste Antwort (Minuten)', type: 'number', sql: `(CASE WHEN t.first_response_at IS NOT NULL THEN ${minutes('t.created_at', 't.first_response_at')} END)`, format: 'minutes' },
    { key: 'resolution_min', label: 'Lösungszeit (Minuten)', type: 'number', sql: `(CASE WHEN t.resolved_at IS NOT NULL THEN ${minutes('t.created_at', 't.resolved_at')} END)`, format: 'minutes' },
    flag('sla_breached', 'SLA verletzt', `${FIRST_LATE} OR ${RESOLUTION_LATE}`, 'Verletzt', 'Eingehalten'),
    flag('first_response_breached', 'SLA erste Antwort verletzt', FIRST_LATE, 'Verletzt', 'Eingehalten'),
    flag('resolution_breached', 'SLA Lösung verletzt', RESOLUTION_LATE, 'Verletzt', 'Eingehalten'),
    flag('open', 'Offen', `t.status_kind IN ('new','open','waiting')`, 'Offen', 'Erledigt'),
    { key: 'csat_score', label: 'CSAT-Bewertung', type: 'number', sql: 't.csat_score', format: 'number' },
    ...ticketContact.fields,
  ],
  calcs: [
    { key: 'sla_rate', label: 'SLA-Quote', sql: `100.0 * SUM(CASE WHEN (t.first_response_due_at IS NOT NULL OR t.resolution_due_at IS NOT NULL) AND NOT (${FIRST_LATE} OR ${RESOLUTION_LATE}) THEN 1 ELSE 0 END) / NULLIF(SUM(CASE WHEN t.first_response_due_at IS NOT NULL OR t.resolution_due_at IS NOT NULL THEN 1 ELSE 0 END), 0)`, format: 'percent', description: 'Anteil der Tickets mit SLA, bei denen weder erste Antwort noch Lösung zu spät waren' },
    { key: 'resolve_rate', label: 'Lösungsquote', sql: `100.0 * SUM(CASE WHEN t.status_kind IN ('resolved','closed') THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0)`, format: 'percent' },
    { key: 'avg_first_response', label: 'Ø erste Antwort', sql: `AVG(CASE WHEN t.first_response_at IS NOT NULL THEN ${minutes('t.created_at', 't.first_response_at')} END)`, format: 'minutes' },
    { key: 'avg_resolution', label: 'Ø Lösungszeit', sql: `AVG(CASE WHEN t.resolved_at IS NOT NULL THEN ${minutes('t.created_at', 't.resolved_at')} END)`, format: 'minutes' },
  ],
};

const csatContact = contactJoin('t.contact_id');
const CSAT_SOURCE: ReportSource = {
  key: 'csat_responses',
  label: 'Zufriedenheit (CSAT)',
  description: 'Bewertungen 1–5 nach gelösten Tickets',
  area: 'helpdesk',
  from: 'tickets t',
  location: 't.location_id',
  where: 't.csat_score IS NOT NULL',
  dateField: 'csat_at',
  requires: ['tickets'],
  countLabel: 'Anzahl Bewertungen',
  joins: csatContact.joins,
  fields: [
    date('csat_at', 'Bewertet am', 't.csat_at'),
    { key: 'score', label: 'Bewertung', type: 'number', sql: 't.csat_score', format: 'number' },
    { key: 'score_label', label: 'Bewertung (Stufe)', type: 'enum', sql: 'CAST(t.csat_score AS TEXT)', options: CSAT },
    flag('satisfied', 'Zufrieden (4–5)', 't.csat_score >= 4', 'Zufrieden', 'Nicht zufrieden'),
    { key: 'comment', label: 'Kommentar', type: 'string', sql: 't.csat_comment', noGroup: true },
    { key: 'owner', label: 'Zuständig', type: 'string', sql: 't.owner_id', lookup: userLookup, empty: 'Nicht zugewiesen' },
    { key: 'category', label: 'Kategorie', type: 'string', sql: 't.category', empty: 'Ohne Kategorie' },
    { key: 'priority', label: 'Priorität', type: 'enum', sql: 't.priority', options: PRIORITIES },
    ...csatContact.fields,
  ],
  calcs: [
    { key: 'avg_score', label: 'Ø Bewertung', sql: 'AVG(t.csat_score)', format: 'number' },
    { key: 'satisfied_rate', label: 'Anteil zufrieden', sql: '100.0 * SUM(CASE WHEN t.csat_score >= 4 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0)', format: 'percent' },
  ],
};

const npsContact = contactJoin('r.contact_id');
const NPS_SOURCE: ReportSource = {
  key: 'nps_responses',
  label: 'Weiterempfehlung (NPS)',
  description: 'Antworten 0–10 auf NPS-Umfragen',
  area: 'helpdesk',
  from: 'nps_responses r',
  location: 'r.location_id',
  dateField: 'updated_at',
  requires: ['nps_responses'],
  countLabel: 'Anzahl Antworten',
  joins: npsContact.joins,
  fields: [
    date('updated_at', 'Beantwortet am', 'r.updated_at'),
    { key: 'score', label: 'Bewertung', type: 'number', sql: 'r.score', format: 'number' },
    { key: 'group', label: 'Gruppe', type: 'enum', sql: `(CASE WHEN r.score >= 9 THEN 'promoter' WHEN r.score >= 7 THEN 'passive' ELSE 'detractor' END)`, options: { promoter: 'Promotor (9–10)', passive: 'Passiv (7–8)', detractor: 'Kritiker (0–6)' } },
    { key: 'campaign', label: 'Umfrage', type: 'string', sql: 'r.campaign_id', lookup: lookupTable('nps_campaigns', 'name') },
    { key: 'comment', label: 'Kommentar', type: 'string', sql: 'r.comment', noGroup: true },
    ...npsContact.fields,
  ],
  calcs: [
    { key: 'nps', label: 'NPS', sql: '100.0 * (SUM(CASE WHEN r.score >= 9 THEN 1 ELSE 0 END) - SUM(CASE WHEN r.score <= 6 THEN 1 ELSE 0 END)) / NULLIF(COUNT(*), 0)', format: 'number', description: '% Promotoren minus % Kritiker' },
    { key: 'avg_score', label: 'Ø Bewertung', sql: 'AVG(r.score)', format: 'number' },
  ],
};

const healthContact = contactJoin('h.contact_id');
const HEALTH_SOURCE: ReportSource = {
  key: 'health_scores',
  label: 'Kunden-Health-Score',
  description: 'Aktueller Health-Score je Kontakt (0–100, Ampel)',
  area: 'contacts',
  from: 'health_scores h',
  location: 'h.location_id',
  dateField: 'computed_at',
  requires: ['health_scores'],
  countLabel: 'Anzahl Kontakte',
  joins: healthContact.joins,
  fields: [
    date('computed_at', 'Berechnet am', 'h.computed_at'),
    { key: 'score', label: 'Health-Score', type: 'number', sql: 'h.score', format: 'number' },
    { key: 'band', label: 'Ampel', type: 'enum', sql: 'h.band', options: { green: 'Grün', yellow: 'Gelb', red: 'Rot' } },
    { key: 'change', label: 'Veränderung', type: 'number', sql: '(h.score - COALESCE(h.previous_score, h.score))', format: 'number' },
    ...healthContact.fields,
  ],
  calcs: [{ key: 'avg_score', label: 'Ø Health-Score', sql: 'AVG(h.score)', format: 'number' }],
};

export const HELPDESK_REPORT_SOURCES = [TICKETS, CSAT_SOURCE, NPS_SOURCE, HEALTH_SOURCE];

export const helpdeskReportsModule: Module = {
  name: 'helpdesk-reports',
  register(app) {
    app.services.reportSources = [...(app.services.reportSources ?? []), ...HELPDESK_REPORT_SOURCES];
  },
};
