import type { Module } from '../core/app.js';
import { cached } from '../core/cache.js';
import { toCsv } from '../core/csv.js';
import { bad, ymdParam, type Ctx, type RawResult } from '../core/http.js';
import { actorOf, getSettings, todayIn, tzOf } from '../services/pm-core.js';
import {
  addEntry,
  autoStopTimers,
  billableEntries,
  decideWeek,
  deleteEntry,
  invoiceFromTime,
  listEntries,
  listRates,
  myTimerState,
  pendingWeeks,
  reportOf,
  setRate,
  startTimer,
  stopTimer,
  submitWeek,
  timeUser,
  timesheetOf,
  unbilledSummary,
  updateEntry,
  viewerOf,
  type TimeFilter,
} from '../services/pm-time.js';

/**
 * Time tracking: timer (one per person), manual entries, weekly timesheets with optional approval, reports,
 * hourly rates and "In Rechnung stellen". Money lives under /api/pm/billing (area "Rechnungen & Produkte").
 */

const timeFilter = (q: URLSearchParams): TimeFilter => ({
  user_id: q.get('user_id') ?? undefined,
  project_id: q.get('project_id') ?? undefined,
  task_id: q.get('task_id') ?? undefined,
  from: ymdParam(q.get('from'), 'Von'),
  to: ymdParam(q.get('to'), 'Bis'),
  billable: q.get('billable') ?? undefined,
  billed: q.get('billed') ?? undefined,
  approval: q.get('approval') ?? undefined,
  limit: q.get('limit') ? Number(q.get('limit')) : undefined,
});

export const pmTimeModule: Module = {
  name: 'pm-time',
  register(app) {
    const { router } = app;
    const who = (ctx: Ctx) => actorOf(ctx);
    const user = (ctx: Ctx, wanted?: unknown) => timeUser(app, ctx.locationId, who(ctx), wanted, viewerOf(ctx).manager);

    // --- timer ----------------------------------------------------------------------------------------
    router.get('/api/pm/timer', 'location', (ctx) => {
      const wanted = ctx.query.get('user_id');
      const viewer = viewerOf(ctx);
      const me = wanted && (viewer.manager || wanted === viewer.id) ? wanted : who(ctx).id;
      if (!me) return { running: null, today_seconds: 0 };
      const today = todayIn(tzOf(app, ctx.locationId));
      const todays = listEntries(app, ctx.locationId, { user_id: me, from: today, to: today, limit: 500 }, { id: me, manager: true });
      return { running: myTimerState(app, me, ctx.locationId), today_seconds: todays.reduce((s, e) => s + e.seconds, 0) };
    });
    router.post('/api/pm/timer/start', 'location', (ctx) => startTimer(app, ctx.locationId, user(ctx, ctx.body?.user_id), ctx.body ?? {}, who(ctx)));
    router.post('/api/pm/timer/stop', 'location', (ctx) => stopTimer(app, user(ctx, ctx.body?.user_id), ctx.body ?? {}));

    // --- entries --------------------------------------------------------------------------------------
    router.get('/api/pm/time', 'location', (ctx) => {
      const viewer = viewerOf(ctx);
      const f = timeFilter(ctx.query);
      return cached(app, ctx, 5_000, () => ({ entries: listEntries(app, ctx.locationId, f, viewer) }));
    });
    router.post('/api/pm/time', 'location', (ctx) => addEntry(app, ctx.locationId, user(ctx, ctx.body?.user_id), ctx.body ?? {}, who(ctx), viewerOf(ctx)));
    router.patch('/api/pm/time/:id', 'location', (ctx) => updateEntry(app, ctx.locationId, ctx.params.id, ctx.body ?? {}, viewerOf(ctx)));
    router.delete('/api/pm/time/:id', 'location', (ctx) => deleteEntry(app, ctx.locationId, ctx.params.id, viewerOf(ctx)));
    router.get('/api/pm/time/report', 'location', (ctx) => {
      const viewer = viewerOf(ctx);
      const f = { ...timeFilter(ctx.query), group: ctx.query.get('group') ?? undefined };
      return cached(app, ctx, 8_000, () => reportOf(app, ctx.locationId, f, viewer));
    });
    router.get('/api/pm/time/export.csv', 'location', (ctx): RawResult => {
      const entries = listEntries(app, ctx.locationId, { ...timeFilter(ctx.query), limit: 5000 }, viewerOf(ctx));
      const rows = entries.map((e) => [e.day, e.user_name, e.project_name, e.task_title, e.note, (e.seconds / 3600).toFixed(2).replace('.', ','), e.billable ? 'ja' : 'nein', e.approval, e.invoice_number ?? '']);
      const body = '\uFEFF' + toCsv([['Datum', 'Person', 'Projekt', 'Aufgabe', 'Notiz', 'Stunden', 'Abrechenbar', 'Freigabe', 'Rechnung'], ...rows]);
      return { __raw: true, status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="zeiten.csv"' }, body };
    });

    // --- timesheets -----------------------------------------------------------------------------------
    router.get('/api/pm/timesheet', 'location', (ctx) => {
      const viewer = viewerOf(ctx);
      const wanted = ctx.query.get('user_id');
      const target = wanted && wanted !== 'me' ? wanted : (viewer.id ?? '');
      if (!target) throw bad('Person angeben (user_id)');
      if (target !== viewer.id && !viewer.manager) throw bad('Wochenzettel anderer Personen sieht nur die Leitung');
      return timesheetOf(app, ctx.locationId, target, ctx.query.get('week') ?? '');
    });
    router.post('/api/pm/timesheet/submit', 'location', (ctx) => submitWeek(app, ctx.locationId, user(ctx, ctx.body?.user_id), String(ctx.body?.week ?? ''), who(ctx)));
    router.post('/api/pm/timesheet/decide', 'location', (ctx) => decideWeek(app, ctx.locationId, String(ctx.body?.user_id ?? ''), String(ctx.body?.week ?? ''), String(ctx.body?.decision ?? ''), String(ctx.body?.note ?? ''), who(ctx), viewerOf(ctx)));
    router.get('/api/pm/timesheet/pending', 'location', (ctx) => {
      if (!viewerOf(ctx).manager) return [];
      return pendingWeeks(app, ctx.locationId);
    });

    // --- billing (payments area) ----------------------------------------------------------------------
    const billingFilter = (q: URLSearchParams) => ({ project_id: q.get('project_id') ?? undefined, from: ymdParam(q.get('from'), 'Von'), to: ymdParam(q.get('to'), 'Bis'), user_id: q.get('user_id') ?? undefined, include_unapproved: q.get('include_unapproved') === '1' });
    router.get('/api/pm/billing/unbilled', 'location', (ctx) => unbilledSummary(app, ctx.locationId, billingFilter(ctx.query)));
    router.get('/api/pm/billing/entries', 'location', (ctx) => ({ entries: billableEntries(app, ctx.locationId, billingFilter(ctx.query)).map((e) => ({ id: e.id, user_id: e.user_id, project_id: e.project_id, task_title: e.task_title, note: e.note, seconds: e.seconds, started_at: e.started_at })) }));
    router.post('/api/pm/billing/invoice', 'location', (ctx) => invoiceFromTime(app, ctx.locationId, ctx.body ?? {}, who(ctx)));
    router.get('/api/pm/billing/rates', 'location', (ctx) => ({ rates: listRates(app, ctx.locationId), default_rate_cents: getSettings(app, ctx.locationId).default_rate_cents }));
    router.put('/api/pm/billing/rates', 'location', (ctx) => {
      if (!viewerOf(ctx).manager) throw bad('Stundensätze ändert nur die Leitung');
      return setRate(app, ctx.locationId, ctx.body ?? {});
    });

    // A cancelled invoice frees its time again: the entries can be billed on a new one.
    app.afterWrite.push((ctx, route, result: any) => {
      if (route.method === 'PATCH' && route.pattern === '/api/invoices/:id' && result?.status === 'void' && result.id) {
        app.db.run('UPDATE pm_time_entries SET invoice_id = NULL, billed_at = NULL WHERE invoice_id = ? AND location_id = ?', result.id, ctx.locationId);
      }
    });

    // --- background ----------------------------------------------------------------------------------
    let last = 0;
    app.onTick(() => {
      if (Date.now() - last < 5 * 60_000) return;
      last = Date.now();
      autoStopTimers(app);
    });
    app.services.pmTime = { autoStopTimers: (at?: Date) => autoStopTimers(app, at) };
  },
};
