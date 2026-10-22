import type { App, Module } from '../core/app.js';
import { bad, notFound } from '../core/http.js';
import { addDaysYmd, formatInTz, ymdInTz } from '../core/time.js';
import { busyFor, computeSlots, type CalendarRow } from './calendars.js';
import type { Tool } from './mcp.js';
import { checkTime, type Issue } from '../services/calview.js';
import { getConfig, membersOf, slotsOfDay } from '../services/teamcal-engine.js';
import { calendarById } from '../services/teamcal-book.js';

/**
 * Kalender-KI (HighLevel "Calendar AI", docs/booking.md#calendar-ai): the agent sets up a calendar from a sentence and explains why a
 * time is (not) bookable. The diagnosis reuses the calendar's own rules – the free slots of the day (team calendars: per person), the
 * conflict check of the calendar view (other appointments, buffers, the person's other calendars, Google/Outlook busy times, hours,
 * day/week limits, absences) – plus minimum notice, booking horizon and the slot grid. `GET /api/calendar-ai/explain`, MCP
 * `ghl_calendar_explain_slot` and `ghl_calendar_create` (a relay onto POST /api/calendars, so every check of that route applies).
 */

const REASON: Record<Issue['kind'] | 'notice' | 'horizon' | 'grid' | 'past' | 'team' | 'inactive', string> = {
  appointment: 'Ein anderer Termin liegt in dieser Zeit',
  blocked: 'Die Zeit ist geblockt',
  buffer: 'Der Puffer vor/nach einem anderen Termin greift',
  person: 'Die Person hat in einem anderen Kalender einen Termin',
  busy: 'Im verbundenen Google-/Outlook-/iCal-Kalender belegt',
  hours: 'Außerhalb der buchbaren Zeiten',
  limit: 'Das Tages- oder Wochenlimit ist erreicht',
  absence: 'Die Person ist abwesend',
  notice: 'Zu kurzfristig (Mindestvorlauf)',
  horizon: 'Zu weit in der Zukunft (Buchungszeitraum)',
  grid: 'Liegt nicht im Startzeit-Raster des Kalenders',
  past: 'Liegt in der Vergangenheit',
  team: 'Niemand aus dem Team ist frei',
  inactive: 'Der Kalender ist deaktiviert',
};

/** Why `start` is (not) bookable on `cal`: the day's free starts and the reasons that apply. Pure reads. */
export function explainSlot(app: App, cal: CalendarRow, startIso: string, at = new Date()) {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) throw bad('Ungültige Startzeit');
  const end = new Date(start.getTime() + cal.duration * 60_000);
  const ymd = ymdInTz(start, cal.timezone);
  const cfg = getConfig(app, cal.id);
  const team = slotsOfDay(app, cal, cfg, ymd, at);
  const free = team ? team.slots.map((s) => s.start) : computeSlots(cal, ymd, busyFor(app, cal, ymd), at);
  const iso = start.toISOString();
  const bookable = !!cal.active && free.includes(iso);
  const reasons: { kind: string; text: string; detail?: string; start_at?: string; end_at?: string }[] = [];
  const add = (kind: keyof typeof REASON, extra: { detail?: string; start_at?: string; end_at?: string } = {}) => {
    if (!reasons.some((r) => r.kind === kind && r.detail === extra.detail && r.start_at === extra.start_at)) reasons.push({ kind, text: REASON[kind], ...extra });
  };
  if (!cal.active) add('inactive');
  if (!bookable) {
    if (start.getTime() < at.getTime()) add('past');
    else if (start.getTime() < at.getTime() + cal.min_notice * 3600_000) add('notice', { detail: `${cal.min_notice} Std. Vorlauf` });
    if (ymd > addDaysYmd(ymdInTz(at, cal.timezone), cal.max_days)) add('horizon', { detail: `${cal.max_days} Tage` });
    const people = cfg.kind === 'single' ? [] : membersOf(app, cal.id).map((m) => m.user_id);
    for (const i of checkTime(app, cal, iso, end.toISOString(), { people })) add(i.kind, { detail: i.label || undefined, start_at: i.start_at, end_at: i.end_at });
    if (!reasons.length) {
      if (!computeSlots(cal, ymd, [], at).includes(iso)) add('grid', { detail: `alle ${cal.interval} Min.` });
      else if (team) add('team');
    }
  }
  const fmt = (v: string) => formatInTz(v, cal.timezone, { weekday: undefined });
  let next: string | null = free.find((s) => s > iso) ?? null;
  for (let i = 1; !next && i <= 14; i++) {
    const d = addDaysYmd(ymd, i);
    const day = slotsOfDay(app, cal, cfg, d, at);
    next = (day ? day.slots.map((s) => s.start) : computeSlots(cal, d, busyFor(app, cal, d), at))[0] ?? null;
  }
  return {
    calendar: { id: cal.id, name: cal.name, timezone: cal.timezone, duration: cal.duration, kind: cfg.kind },
    start: iso,
    start_local: fmt(iso),
    bookable,
    reasons,
    free_that_day: free.slice(0, 24).map((s) => ({ start: s, local: fmt(s) })),
    next_free: next ? { start: next, local: fmt(next) } : null,
  };
}

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const DAY = { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'Zeitfenster wie [["09:00","12:00"],["13:00","17:00"]]; leer = geschlossen' };

export const CALENDAR_AI_TOOLS: Tool[] = [
  {
    name: 'ghl_calendar_explain_slot',
    title: 'Warum ist diese Zeit (nicht) buchbar?',
    description:
      'Erklärt für einen Buchungskalender, ob eine Startzeit buchbar ist und warum nicht: anderer Termin, Puffer, Termin der Person in einem anderen Kalender, Google/Outlook belegt, außerhalb der Zeiten, Tages-/Wochenlimit, Abwesenheit, Mindestvorlauf, Buchungszeitraum, Raster, niemand aus dem Team frei. Dazu die freien Zeiten des Tages und die nächste freie Zeit. start ist ein ISO-Zeitstempel; nenne Zeiten in der Zeitzone des Kalenders (start_local).',
    inputSchema: obj({ ...LOC, calendar_id: { type: 'string', description: 'Kalender-ID (aus ghl_calendar_types)' }, start: { type: 'string', description: 'ISO-Startzeit, z. B. 2026-11-03T09:00:00+01:00' } }, ['location_id', 'calendar_id', 'start']),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => call.api('GET', `/api/calendar-ai/explain?calendar_id=${encodeURIComponent(a.calendar_id)}&start=${encodeURIComponent(a.start)}`, { location: a.location_id }),
  },
  {
    name: 'ghl_calendar_create',
    title: 'Buchungskalender anlegen',
    description:
      'Legt einen Buchungskalender an – z. B. aus „30-Minuten-Erstgespräch, Mo–Fr 9–17 Uhr, 24 Stunden Vorlauf, 15 Minuten Puffer“. Rückgabe mit Buchungslink (url). Team, Fragen und Zahlung danach in der App (Kalender → Bearbeiten). Frage vor dem Anlegen nach, wenn Dauer oder Zeiten unklar sind.',
    inputSchema: obj(
      {
        ...LOC,
        name: { type: 'string' },
        description: { type: 'string', description: 'Text auf der Buchungsseite' },
        duration: { type: 'integer', minimum: 5, maximum: 720, description: 'Dauer in Minuten' },
        interval: { type: 'integer', minimum: 5, maximum: 720, description: 'Startzeit-Raster in Minuten (Standard = Dauer)' },
        buffer: { type: 'integer', minimum: 0, maximum: 240, description: 'Puffer vor/nach Terminen in Minuten' },
        min_notice: { type: 'integer', minimum: 0, maximum: 720, description: 'Mindestvorlauf in Stunden (Standard 4)' },
        max_days: { type: 'integer', minimum: 1, maximum: 730, description: 'Wie viele Tage im Voraus buchbar (Standard 60)' },
        timezone: { type: 'string', description: 'IANA-Zeitzone, Standard die des Sub-Accounts' },
        availability: { type: 'object', properties: Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, DAY])), additionalProperties: false, description: 'Buchbare Zeiten je Wochentag (mon … sun); fehlende Tage sind geschlossen' },
      },
      ['location_id', 'name', 'duration'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async (call, a) => {
      const { location_id, ...body } = a;
      const r = await call.api('POST', '/api/calendars', { location: location_id, body });
      return { id: r.id, name: r.name, duration: r.duration, interval: r.interval, buffer: r.buffer, min_notice: r.min_notice, max_days: r.max_days, timezone: r.timezone, availability: r.availability, url: r.url, link: '/app/calendars' };
    },
  },
];

export const calendarAiModule: Module = {
  name: 'calendar-ai',
  register(app) {
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...CALENDAR_AI_TOOLS];
    app.router.get('/api/calendar-ai/explain', 'location', (ctx) => {
      const cal = calendarById(app, String(ctx.query.get('calendar_id') ?? ''));
      if (!cal || cal.location_id !== ctx.locationId) throw notFound('Kalender nicht gefunden');
      return explainSlot(app, cal, String(ctx.query.get('start') ?? ''));
    });
  },
};
