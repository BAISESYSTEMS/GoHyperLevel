import type { Module } from '../core/app.js';
import { bad, notFound } from '../core/http.js';
import { cancelSeries, createSeries, generateDue, getSeries, previewSeries, seriesOut, updateSeries, type SeriesRow } from '../services/appt-series.js';
import type { Tool } from './mcp.js';

/**
 * Recurring appointments (docs/booking.md#recurring-appointments): the table of series, `series_id`/`recurrence`/`occurrence_date`
 * on appointments, the routes to create, preview, change and cancel a series ("only this", "this and following", "all"), the
 * background job that writes the appointments ahead, and two MCP tools. The logic is in services/appt-series.ts and the pure rule
 * (RRULE subset) in services/appt-recur.ts.
 */

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const RULE = {
  type: 'object',
  description:
    'Wiederholung: {freq: daily|weekly|monthly, interval: jede n-te Einheit, weekdays: [0=So … 6=Sa] (wöchentlich), day_of_month (monatlich), end: {type: never|count|date, count, date: JJJJ-MM-TT}} – oder als RRULE-Text in rrule (FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;COUNT=10)',
  properties: {
    freq: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
    interval: { type: 'integer', minimum: 1 },
    weekdays: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 } },
    day_of_month: { type: 'integer', minimum: 1, maximum: 31 },
    end: { type: 'object' },
    rrule: { type: 'string' },
  },
};

export const SERIES_TOOLS: Tool[] = [
  {
    name: 'ghl_appointment_series_create',
    title: 'Terminserie anlegen',
    description:
      'Legt eine Terminserie für einen Kontakt an (z. B. wöchentlich dienstags 10:00, 10 Termine): start = ISO-Zeit des ersten Termins, recurrence = Regel (täglich, wöchentlich an Tagen, alle N Wochen, monatlich). Die Termine werden rollierend 90 Tage im Voraus angelegt; jeder bekommt seine Erinnerungen. Überschneidungen melden einen Fehler mit den Daten – force=true legt trotzdem an. Der Kontakt bekommt eine Bestätigung für die ganze Serie.',
    inputSchema: {
      type: 'object',
      properties: {
        ...LOC,
        calendar_id: { type: 'string' },
        contact_id: { type: 'string' },
        start: { type: 'string', description: 'ISO-Startzeit des ersten Termins' },
        duration: { type: 'integer', minimum: 5, maximum: 1440, description: 'Minuten (Standard: Dauer des Kalenders)' },
        recurrence: RULE,
        notes: { type: 'string' },
        force: { type: 'boolean' },
      },
      required: ['location_id', 'calendar_id', 'contact_id', 'start', 'recurrence'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: (call, a) =>
      call.api('POST', '/api/appointment-series', {
        location: a.location_id,
        body: { calendar_id: a.calendar_id, contact_id: a.contact_id, start: a.start, duration: a.duration, recurrence: a.recurrence, notes: a.notes, force: a.force },
      }),
  },
  {
    name: 'ghl_appointment_series_cancel',
    title: 'Terminserie absagen',
    description:
      'Sagt Termine einer Serie ab: scope single (nur dieser Termin), following (dieser und alle folgenden) oder all (alle kommenden). appointment_id ist bei single und following der Termin, ab dem abgesagt wird. Der Kontakt bekommt eine E-Mail für die ganze Serie.',
    inputSchema: {
      type: 'object',
      properties: { ...LOC, series_id: { type: 'string' }, scope: { type: 'string', enum: ['single', 'following', 'all'] }, appointment_id: { type: 'string' }, reason: { type: 'string' } },
      required: ['location_id', 'series_id', 'scope'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    run: (call, a) =>
      call.api('POST', `/api/appointment-series/${encodeURIComponent(String(a.series_id ?? ''))}/cancel`, {
        location: a.location_id,
        body: { scope: a.scope, appointment_id: a.appointment_id, reason: a.reason },
      }),
  },
];

export const appointmentSeriesModule: Module = {
  name: 'appointment-series',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE appointment_series (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
        contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
        title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
        rule TEXT NOT NULL, rrule TEXT NOT NULL, timezone TEXT NOT NULL,
        start_date TEXT NOT NULL, start_time TEXT NOT NULL, duration INTEGER NOT NULL,
        assignee_id TEXT, host_ids TEXT, blocked INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active', generated_until TEXT, parent_id TEXT,
        created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX appointment_series_loc ON appointment_series(location_id, status);
      CREATE INDEX appointment_series_due ON appointment_series(status, generated_until);
      ALTER TABLE appointments ADD COLUMN series_id TEXT REFERENCES appointment_series(id) ON DELETE SET NULL;
      ALTER TABLE appointments ADD COLUMN recurrence TEXT;
      ALTER TABLE appointments ADD COLUMN occurrence_date TEXT;
      ALTER TABLE appointments ADD COLUMN series_exception INTEGER NOT NULL DEFAULT 0;
      CREATE UNIQUE INDEX appointments_series_day ON appointments(series_id, occurrence_date) WHERE series_id IS NOT NULL;
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...SERIES_TOOLS];

    router.get('/api/appointment-series', 'location', (ctx) => {
      const where = ['location_id = ?'];
      const params: string[] = [ctx.locationId];
      for (const k of ['calendar_id', 'contact_id', 'status'] as const) {
        const v = ctx.query.get(k);
        if (v) {
          where.push(`${k} = ?`);
          params.push(v);
        }
      }
      return db.all<SeriesRow>(`SELECT * FROM appointment_series WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 500`, ...params).map(seriesOut);
    });
    router.post('/api/appointment-series/preview', 'location', (ctx) => {
      const p = previewSeries(app, ctx.locationId, ctx.body ?? {});
      return { rrule: p.rrule, description: p.description, first_date: p.dates[0], occurrences: p.occurrences, conflicts: p.conflicts.slice(0, 50) };
    });
    router.post('/api/appointment-series', 'location', (ctx) => createSeries(app, ctx.locationId, ctx.body ?? {}, { userId: ctx.user?.id ?? null }));
    router.get('/api/appointment-series/:id', 'location', (ctx) => {
      const s = getSeries(app, ctx.locationId, ctx.params.id);
      const appointments = db.all('SELECT id, start_at, end_at, status, occurrence_date, series_exception, manage_token FROM appointments WHERE series_id = ? ORDER BY start_at', s.id);
      return { series: seriesOut(s), appointments };
    });
    router.patch('/api/appointment-series/:id', 'location', (ctx) => updateSeries(app, ctx.locationId, ctx.params.id, ctx.body ?? {}));
    router.post('/api/appointment-series/:id/cancel', 'location', (ctx) => {
      if (!ctx.params.id) throw notFound();
      if (ctx.body?.scope !== undefined && !['single', 'following', 'all'].includes(ctx.body.scope)) throw bad('scope: single, following oder all');
      return cancelSeries(app, ctx.locationId, ctx.params.id, ctx.body ?? {});
    });

    // Rolling generation: every series is written 90 days ahead; checked every few minutes, not on every 15-second tick.
    let last = 0;
    app.onTick(() => {
      if (Date.now() - last < 5 * 60_000) return;
      last = Date.now();
      generateDue(app);
    });
  },
};
