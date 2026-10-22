import type { Module } from '../core/app.js';
import { HttpError } from '../core/http.js';
import type { Tool } from './mcp.js';

/**
 * MCP tools of the Team-Kalender (HyperLevel Agent, Claude, ChatGPT, Codex): the booking calendars with their type, team, questions,
 * price and video setting, and booking a slot – with round robin, collective hosts, capacity and payment handled by the same rules as
 * the public booking page. Thin relays onto the REST routes of modules/teamcal.ts (key, member areas and audit log apply).
 */

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const RO = { readOnlyHint: true, openWorldHint: false };
const W = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const q = (params: Record<string, unknown>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  return s.toString() ? `?${s}` : '';
};

const NOTE =
  'Typen: single (eine Person), round_robin (die Buchung geht reihum an eine freie Person des Teams), collective (alle Personen müssen frei sein, ein Termin mit allen), group (Gruppe/Klasse mit Plätzen und optionaler Warteliste). Zeiten sind ISO-Zeitstempel (UTC); zeige sie in der Zeitzone des Kalenders.';

export const TEAMCAL_TOOLS: Tool[] = [
  {
    name: 'ghl_calendar_types',
    title: 'Buchungskalender und freie Zeiten',
    description: `Die Buchungskalender („Termintypen“) eines Sub-Accounts mit Typ, Dauer, Team (Personen und Gewichte), Fragen der Buchungsseite (Anzahl), Preis (full oder deposit, Cent), Video-Setting (none, meet, zoom, teams, static) und Buchungslink. Mit calendar_id und from (YYYY-MM-DD) kommen auch die freien Zeiten der nächsten Tage – bei Round Robin mit den Personen, die dann frei wären, bei Gruppen mit den freien Plätzen. ${NOTE}`,
    inputSchema: obj({ ...LOC, calendar_id: { type: 'string', description: 'Nur dieser Kalender – mit freien Zeiten' }, from: { type: 'string', description: 'Erster Tag der freien Zeiten, YYYY-MM-DD (Standard heute)' }, days: { type: 'integer', minimum: 1, maximum: 14, description: 'Anzahl Tage, Standard 7' } }, ['location_id']),
    annotations: RO,
    run: async (call, a) => {
      if (a.calendar_id) {
        const [detail, slots] = await Promise.all([call.api('GET', `/api/team-calendars/${encodeURIComponent(a.calendar_id)}`, { location: a.location_id }), call.api('GET', `/api/team-calendars/${encodeURIComponent(a.calendar_id)}/slots${q({ from: a.from, days: a.days ?? 7 })}`, { location: a.location_id })]);
        const { config, ...summary } = detail;
        return { calendar: { ...summary, questions: (config.questions ?? []).map((x: any) => ({ id: x.id, label: x.label, type: x.type, required: x.required, options: x.options })), policy: config.policy_text, cancel_cutoff_hours: config.cancel_cutoff_hours }, ...slots, link: '/app/calendars' };
      }
      const types = await call.api('GET', '/api/team-calendars/types', { location: a.location_id });
      return { calendars: types, link: '/app/calendars' };
    },
  },
  {
    name: 'ghl_book_slot',
    title: 'Termin buchen',
    description: `Bucht einen freien Termin auf einem Buchungskalender für einen Kontakt (E-Mail und Vorname nötig; der Kontakt wird angelegt oder zusammengeführt). start ist ein Zeitpunkt aus ghl_calendar_types. Bei Round Robin wählt das System die Person nach den Regeln des Kalenders (host_id nur, wenn der Nutzer eine bestimmte Person will), bei Kollektiv sind alle dabei. Fragen der Buchungsseite beantwortest du mit answers ({frage_id: antwort}). Der Kontakt bekommt die Bestätigung per E-Mail – frage vorher, ob das gewollt ist. Kostenpflichtige Kalender: Es entsteht eine Zahlungsseite (status payment_required, checkout_url an den Kontakt geben); der Termin gilt erst nach der Zahlung. payment=waive bucht ohne Zahlung – nur auf ausdrücklichen Wunsch. Ist eine Gruppe ausgebucht, setzt waitlist=true auf die Warteliste. ${NOTE}`,
    inputSchema: obj(
      {
        ...LOC,
        calendar_id: { type: 'string', description: 'Kalender-ID (aus ghl_calendar_types)' },
        start: { type: 'string', description: 'ISO-Startzeit eines freien Termins' },
        email: { type: 'string' },
        first_name: { type: 'string' },
        last_name: { type: 'string' },
        phone: { type: 'string' },
        notes: { type: 'string', description: 'Anliegen / Notiz zum Termin' },
        answers: { type: 'object', description: 'Antworten auf die Fragen der Buchungsseite: {frage_id: text | true/false | [auswahl]}' },
        host_id: { type: 'string', description: 'Bestimmte Person als Gastgeber (Round Robin), nur auf Wunsch' },
        payment: { type: 'string', enum: ['require', 'waive'], description: 'require (Standard): bei kostenpflichtigen Terminen Zahlungsseite; waive: ohne Zahlung buchen' },
        waitlist: { type: 'boolean', description: 'Auf die Warteliste einer ausgebuchten Gruppe setzen' },
      },
      ['location_id', 'calendar_id', 'start', 'email', 'first_name'],
    ),
    annotations: W,
    run: async (call, a) => {
      const r = await call.api('POST', `/api/team-calendars/${encodeURIComponent(a.calendar_id)}/book`, { location: a.location_id, body: { start: a.start, email: a.email, first_name: a.first_name, last_name: a.last_name, phone: a.phone, notes: a.notes, answers: a.answers, host_id: a.host_id, payment: a.payment, waitlist: a.waitlist } });
      if (r.status === 'confirmed') {
        const ap = r.appointment;
        return { status: 'confirmed', appointment_id: ap.id, start_at: ap.start_at, end_at: ap.end_at, host: ap.assignee_name || null, hosts: (r.hosts ?? []).map((h: any) => h.name), meeting_url: r.meeting_url || null, manage_url: r.manage_url, link: '/app/calendars' };
      }
      if (r.status === 'payment_required') return { status: 'payment_required', checkout_url: r.checkout_url, expires_at: r.expires_at, due_cents: r.due_cents, currency: r.currency, hint: 'Den Link an den Kontakt geben – der Termin gilt nach der Zahlung. Bis dahin ist die Zeit reserviert.' };
      if (r.status === 'waitlisted') return { status: 'waitlisted', hint: 'Wird ein Platz frei, bekommt der Kontakt eine E-Mail mit einem Link zum Buchen.' };
      throw new HttpError(500, 'Unerwartete Antwort');
    },
  },
];

export const teamCalToolsModule: Module = {
  name: 'teamcal-tools',
  register(app) {
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TEAMCAL_TOOLS];
  },
};
