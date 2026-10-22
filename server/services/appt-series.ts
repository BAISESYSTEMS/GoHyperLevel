import type { App } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, notFound } from '../core/http.js';
import { addDaysYmd, formatInTz, hmInTz, ymdInTz, zonedToUtc } from '../core/time.js';
import { id, now, token } from '../core/util.js';
import { beginBooking, type CalendarRow } from '../modules/calendars.js';
import { getContact, logActivity } from './contacts.js';
import { notifyTeam, sendToContact } from './messaging.js';
import { RecurrenceError, anchorRule, cleanApptRecurrence, cutBefore, describeRecurrence, endsBy, remainingCount, seriesDates, toRrule, type ApptRule } from './appt-recur.js';
import { apptColumns, checkTime, type Issue } from './calview.js';

/**
 * Recurring appointments (docs/booking.md#recurring-appointments). A series is a rule plus the first appointment's time of day and
 * length in the calendar's time zone; its appointments are ordinary rows of `appointments` (with `series_id`, `recurrence` and
 * `occurrence_date`), so reminders, follow-ups, the Google/Outlook sync and every list treat each one on its own. They are
 * written ahead on a rolling basis (HORIZON_DAYS) by the background tick. Edits and cancellations work on "only this", "this and
 * following" or "all"; an appointment moved on its own (here, in the app, by the sync) is an exception and keeps its time.
 */

export const HORIZON_DAYS = 90;
const MAX_BATCH = 400;
export type Scope = 'single' | 'following' | 'all';
const SCOPES: Scope[] = ['single', 'following', 'all'];
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface SeriesRow {
  id: string;
  location_id: string;
  calendar_id: string;
  contact_id: string | null;
  title: string;
  notes: string;
  rule: string;
  rrule: string;
  timezone: string;
  start_date: string;
  start_time: string;
  duration: number;
  assignee_id: string | null;
  host_ids: string | null;
  blocked: number;
  status: 'active' | 'ended' | 'cancelled';
  generated_until: string | null;
  parent_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const ruleOf = (s: SeriesRow): ApptRule => JSON.parse(s.rule);
export const horizonEnd = (tz: string, at = new Date()) => addDaysYmd(ymdInTz(at, tz), HORIZON_DAYS);
const startOf = (s: Pick<SeriesRow, 'start_time' | 'timezone'>, day: string) => zonedToUtc(day, s.start_time, s.timezone);
const endOf = (s: Pick<SeriesRow, 'start_time' | 'timezone' | 'duration'>, day: string) => new Date(startOf(s, day).getTime() + s.duration * 60_000);

function recurErr<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof RecurrenceError) throw bad(e.message);
    throw e;
  }
}

export function getSeries(app: App, locationId: string, seriesId: string): SeriesRow {
  const s = app.db.get<SeriesRow>('SELECT * FROM appointment_series WHERE id = ? AND location_id = ?', seriesId, locationId);
  if (!s) throw notFound('Serie nicht gefunden');
  return s;
}

export function seriesOut(s: SeriesRow) {
  const rule = ruleOf(s);
  return { ...s, rule, description: describeRecurrence(rule), blocked: !!s.blocked, host_ids: s.host_ids ? JSON.parse(s.host_ids) : [] };
}

const calOf = (app: App, locationId: string, calendarId: string) => {
  const cal = parseJson(app.db.get<CalendarRow>('SELECT * FROM calendars WHERE id = ? AND location_id = ?', calendarId, locationId), ['availability', 'settings']);
  if (!cal) throw bad('Kalender fehlt');
  return cal;
};

const duration = (v: unknown, fallback: number) => {
  const n = v === undefined || v === null || v === '' ? fallback : Math.round(Number(v));
  if (!Number.isFinite(n) || n < 5 || n > 24 * 60) throw bad('Dauer: 5 bis 1440 Minuten');
  return n;
};

/** Writes the series' appointments up to `until` that do not exist yet (and were not taken out on purpose). */
export function generate(app: App, s: SeriesRow, o: { until?: string; includePast?: boolean } = {}): string[] {
  if (s.status !== 'active') return [];
  const until = o.until ?? horizonEnd(s.timezone);
  const rule = ruleOf(s);
  const have = new Set(app.db.all<{ occurrence_date: string }>('SELECT occurrence_date FROM appointments WHERE series_id = ?', s.id).map((r) => r.occurrence_date));
  const dates = seriesDates(rule, s.start_date, until, MAX_BATCH);
  const cols = apptColumns(app);
  const team = cols.has('assignee_id') && cols.has('host_ids');
  const cutoff = Date.now() - 3600_000;
  const made: string[] = [];
  for (const d of dates) {
    if (have.has(d) || (s.generated_until && d <= s.generated_until)) continue;
    const start = startOf(s, d);
    if (!o.includePast && start.getTime() < cutoff) continue;
    const row: Record<string, unknown> = {
      id: id(),
      location_id: s.location_id,
      calendar_id: s.calendar_id,
      contact_id: s.contact_id,
      title: s.title,
      start_at: start.toISOString(),
      end_at: endOf(s, d).toISOString(),
      status: s.blocked ? 'blocked' : 'confirmed',
      notes: s.notes,
      source: 'Serie',
      manage_token: token(18),
      reminder_sent: 0,
      created_at: now(),
      series_id: s.id,
      recurrence: s.rrule,
      occurrence_date: d,
      ...(team ? { assignee_id: s.assignee_id, host_ids: s.host_ids } : {}),
    };
    const keys = Object.keys(row);
    // OR IGNORE: the unique (series_id, occurrence_date) index makes a second tick at the same moment harmless.
    if (app.db.run(`INSERT OR IGNORE INTO appointments (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map((k) => row[k] as any)).changes) made.push(row.id as string);
  }
  const ended = endsBy(rule, s.start_date, until);
  app.db.run('UPDATE appointment_series SET generated_until = ?, status = ?, updated_at = ? WHERE id = ?', until, ended ? 'ended' : 'active', now(), s.id);
  return made;
}

/** Background job: every active series is kept written ahead to the horizon. */
export function generateDue(app: App, at = new Date()): number {
  let n = 0;
  const due = app.db.all<SeriesRow>(`SELECT * FROM appointment_series WHERE status = 'active' ORDER BY generated_until LIMIT 200`);
  for (const s of due) {
    if (s.generated_until && s.generated_until >= horizonEnd(s.timezone, at)) continue;
    try {
      n += generate(app, s).length;
    } catch (e) {
      console.error('[appointment-series]', s.id, (e as Error).message);
    }
  }
  return n;
}

export interface SeriesInput {
  calendar_id?: unknown;
  start?: unknown;
  duration?: unknown;
  recurrence?: unknown;
  contact_id?: unknown;
  contact?: unknown;
  notes?: unknown;
  title?: unknown;
  blocked?: unknown;
  force?: unknown;
  notify?: unknown;
}

/** The dates (and what speaks against them) a new series would have up to the horizon. */
export function previewSeries(app: App, locationId: string, b: SeriesInput) {
  const cal = calOf(app, locationId, String(b.calendar_id ?? ''));
  const start = new Date(String(b.start ?? ''));
  if (Number.isNaN(start.getTime())) throw bad('Ungültige Startzeit');
  const rule0 = recurErr(() => cleanApptRecurrence(b.recurrence));
  if (!rule0) throw bad('Wiederholung fehlt');
  const first = ymdInTz(start, cal.timezone);
  const rule = recurErr(() => anchorRule(rule0, first));
  const shape = { start_time: hmInTz(start, cal.timezone), timezone: cal.timezone, duration: duration(b.duration, cal.duration) };
  const dates = seriesDates(rule, first, horizonEnd(cal.timezone), MAX_BATCH);
  if (!dates.length) throw bad('Diese Wiederholung ergibt keinen Termin');
  const occurrences = dates.map((d) => ({ date: d, start_at: startOf(shape, d).toISOString(), end_at: endOf(shape, d).toISOString() }));
  // Blocked times only clash with appointments; the bookable hours and limits do not apply to them.
  const conflicts = occurrences
    .map((o) => ({ ...o, issues: checkTime(app, cal, o.start_at, o.end_at).filter((i) => !b.blocked || ['appointment', 'blocked', 'person'].includes(i.kind)) }))
    .filter((c) => c.issues.length);
  return { cal, rule, first, shape, dates, occurrences, conflicts, rrule: toRrule(rule), description: describeRecurrence(rule) };
}

/** Creates a series and its first appointments; 409 with the conflicting dates unless `force`. */
export async function createSeries(app: App, locationId: string, b: SeriesInput, by: { userId?: string | null } = {}) {
  const p = previewSeries(app, locationId, b);
  if (p.conflicts.length && b.force !== true) {
    throw new HttpError(409, p.conflicts.length === 1 ? 'Ein Termin der Serie überschneidet sich' : `${p.conflicts.length} Termine der Serie überschneiden sich`, {
      conflicts: p.conflicts.slice(0, 50),
    });
  }
  const { cal, rule } = p;
  const blocked = b.blocked === true;
  let contact: Record<string, any> | null = null;
  if (!blocked) {
    if (b.contact_id) {
      const c = getContact(app, locationId, String(b.contact_id));
      if (!c) throw bad('Kontakt nicht gefunden');
      contact = { id: c.id };
    } else if (b.contact && typeof b.contact === 'object' && !Array.isArray(b.contact)) contact = b.contact as Record<string, any>;
    else throw bad('Kontakt fehlt');
  }
  const seriesId = id();
  const rrule = toRrule(rule);
  const firstDay = p.dates[0];
  const at = now();
  const row: SeriesRow = {
    id: seriesId,
    location_id: locationId,
    calendar_id: cal.id,
    contact_id: null,
    title:
      String(b.title ?? '')
        .trim()
        .slice(0, 300) || (blocked ? 'Blockiert' : cal.name),
    notes: String(b.notes ?? '').slice(0, 5000),
    rule: JSON.stringify(rule),
    rrule,
    timezone: cal.timezone,
    start_date: firstDay,
    start_time: p.shape.start_time,
    duration: p.shape.duration,
    assignee_id: null,
    host_ids: null,
    blocked: blocked ? 1 : 0,
    status: 'active',
    generated_until: firstDay,
    parent_id: null,
    created_by: by.userId ?? null,
    created_at: at,
    updated_at: at,
  };
  const cols = apptColumns(app);
  let firstAppt: any;
  app.db.tx(() => {
    app.db.insert('appointment_series', row as unknown as Record<string, unknown>);
    const start = startOf(row, firstDay);
    if (blocked) {
      firstAppt = {
        id: id(),
        location_id: locationId,
        calendar_id: cal.id,
        contact_id: null,
        title: row.title,
        start_at: start.toISOString(),
        end_at: endOf(row, firstDay).toISOString(),
        status: 'blocked',
        notes: row.notes,
        source: 'Serie',
        manage_token: token(18),
        created_at: at,
        series_id: seriesId,
        recurrence: rrule,
        occurrence_date: firstDay,
      };
      app.db.insert('appointments', firstAppt);
    } else {
      // The first appointment goes through the booking pipeline (contact, tags, opportunity, hosts of a team calendar).
      const booked = beginBooking(app, cal, {
        start: start.toISOString(),
        contact: contact!,
        notes: row.notes,
        source: 'Serie',
        skipCheck: true,
        extra: { series_id: seriesId, recurrence: rrule, occurrence_date: firstDay },
      });
      firstAppt = booked.appt;
      const end = endOf(row, firstDay).toISOString();
      if (end !== firstAppt.end_at) app.db.run('UPDATE appointments SET end_at = ? WHERE id = ?', end, firstAppt.id);
      const r = app.db.get<any>('SELECT * FROM appointments WHERE id = ?', firstAppt.id)!;
      firstAppt = r;
      const patch: Record<string, unknown> = { contact_id: r.contact_id, title: String(b.title ?? '').trim() ? row.title : r.title };
      if (cols.has('assignee_id')) patch.assignee_id = r.assignee_id ?? null;
      if (cols.has('host_ids')) patch.host_ids = r.host_ids ?? null;
      app.db.run(
        `UPDATE appointment_series SET ${Object.keys(patch)
          .map((k) => `${k} = ?`)
          .join(', ')} WHERE id = ?`,
        ...Object.values(patch).map((v) => (v as any) ?? null),
        seriesId,
      );
      if (patch.title !== r.title) app.db.run('UPDATE appointments SET title = ? WHERE id = ?', patch.title as string, r.id);
    }
    // At creation the dates between a first appointment in the past and today are written too (the team enters a running series).
    generate(app, getSeries(app, locationId, seriesId), { includePast: true });
  });
  const s = getSeries(app, locationId, seriesId);
  const appts = app.db.all<any>('SELECT * FROM appointments WHERE series_id = ? ORDER BY start_at', seriesId);
  if (!blocked && s.contact_id) {
    const first = appts[0];
    logActivity(app, locationId, s.contact_id, 'appointment.series', `Terminserie gebucht: ${describeRecurrence(rule)}, ab ${formatInTz(first.start_at, cal.timezone)}`);
    app.events.emit(locationId, 'appointment.booked', {
      contactId: s.contact_id,
      appointment: { ...first, ...(app.services.teamcalPayload?.(first) ?? {}) },
      calendarId: cal.id,
      series: { id: s.id, recurrence: s.rrule },
      meta: {},
    });
    if (b.notify !== false && cal.settings.confirmation_email !== false) void notifySeries(app, s, cal, 'booked').catch(() => undefined);
    if (cal.settings.notify_team)
      void notifyTeam(app, locationId, `Neue Terminserie: ${s.title}`, `${s.title}\n${describeRecurrence(rule)}, ab ${formatInTz(first.start_at, cal.timezone)} (${cal.timezone})`).catch(
        () => undefined,
      );
  }
  return { series: seriesOut(s), appointments: appts, conflicts: p.conflicts };
}

/** One e-mail to the contact for the whole series (booked, changed, cancelled) – never one per appointment. */
async function notifySeries(app: App, s: SeriesRow, cal: CalendarRow, what: 'booked' | 'changed' | 'cancelled', fromDay?: string) {
  if (!s.contact_id) return;
  const c = getContact(app, s.location_id, s.contact_id);
  if (!c?.email) return;
  const loc = app.location(s.location_id)!;
  const next = app.db.all<any>(
    `SELECT start_at, manage_token FROM appointments WHERE series_id = ? AND status = 'confirmed' AND start_at > ? ORDER BY start_at LIMIT 5`,
    s.id,
    new Date().toISOString(),
  );
  const list = next.map((a) => `- ${formatInTz(a.start_at, cal.timezone)}`).join('\n');
  const rule = describeRecurrence(ruleOf(s));
  const hello = `Hallo${c.first_name ? ` ${c.first_name}` : ''},\n\n`;
  const body =
    what === 'cancelled'
      ? `${hello}deine Terminserie „${cal.name}“ ist${fromDay ? ` ab dem ${formatInTz(zonedToUtc(fromDay, '12:00', cal.timezone), cal.timezone, { hour: undefined, minute: undefined })}` : ''} abgesagt.\n\nEinen neuen Termin findest du hier: ${app.baseUrl()}/book/${cal.slug}\n\n${loc.name}`
      : `${hello}${what === 'booked' ? 'deine Terminserie ist gebucht' : 'deine Terminserie wurde geändert'}: „${cal.name}“, ${rule} um ${s.start_time} Uhr (${cal.timezone}).${list ? `\n\nDie nächsten Termine:\n${list}` : ''}\n\nJeden Termin kannst du einzeln verwalten oder absagen – der Link steht in der Erinnerung vor dem Termin.${next[0] ? `\nNächster Termin: ${app.baseUrl()}/book/manage/${next[0].manage_token}` : ''}\n\n${loc.name}`;
  const subject = what === 'cancelled' ? `Terminserie abgesagt: ${cal.name}` : what === 'booked' ? `Terminserie bestätigt: ${cal.name}` : `Terminserie geändert: ${cal.name}`;
  await sendToContact(app, s.location_id, { contactId: c.id, channel: 'email', subject, body, source: 'Terminbestätigung', ignoreDnd: true });
}

const occurrenceOf = (app: App, s: SeriesRow, appointmentId: unknown) => {
  const a = app.db.get<any>('SELECT * FROM appointments WHERE id = ? AND series_id = ? AND location_id = ?', String(appointmentId ?? ''), s.id, s.location_id);
  if (!a) throw bad('Termin gehört nicht zu dieser Serie');
  return a;
};

/** Was this appointment moved on its own (not at the series' time any more)? */
const movedAlone = (a: any, prev: Pick<SeriesRow, 'start_time' | 'timezone' | 'duration'>) =>
  !!a.series_exception || !a.occurrence_date || a.start_at !== startOf(prev, a.occurrence_date).toISOString() || a.end_at !== endOf(prev, a.occurrence_date).toISOString();

/**
 * After the rule, time or length changed: the series' future appointments from `fromDay` on follow (moved, or removed when their
 * date is gone), appointments moved on their own stay as they are, and missing dates are written.
 */
function rebuild(app: App, s: SeriesRow, prev: Pick<SeriesRow, 'start_time' | 'timezone' | 'duration'>, fromDay: string, text: { title?: string; notes?: string }) {
  const want = new Set(seriesDates(ruleOf(s), s.start_date, horizonEnd(s.timezone), MAX_BATCH));
  const nowIso = new Date().toISOString();
  const rows = app.db.all<any>(`SELECT * FROM appointments WHERE series_id = ? AND occurrence_date >= ? AND start_at > ? AND status != 'cancelled'`, s.id, fromDay, nowIso);
  let moved = 0;
  let removed = 0;
  for (const a of rows) {
    const set: Record<string, unknown> = { recurrence: s.rrule };
    if (text.title !== undefined) set.title = text.title;
    if (text.notes !== undefined) set.notes = text.notes;
    if (!movedAlone(a, prev)) {
      if (!want.has(a.occurrence_date)) {
        app.db.run('DELETE FROM appointments WHERE id = ?', a.id);
        removed++;
        continue;
      }
      const start = startOf(s, a.occurrence_date).toISOString();
      const end = endOf(s, a.occurrence_date).toISOString();
      if (start !== a.start_at || end !== a.end_at) {
        Object.assign(set, { start_at: start, end_at: end, reminder_sent: 0 });
        moved++;
      }
    }
    const keys = Object.keys(set);
    app.db.run(`UPDATE appointments SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => set[k] as any), a.id);
  }
  // Dates of the new rule from `fromDay` on that have no appointment yet are written again.
  app.db.run('UPDATE appointment_series SET generated_until = ? WHERE id = ?', addDaysYmd(fromDay, -1) < s.start_date ? null : addDaysYmd(fromDay, -1), s.id);
  const made = generate(app, app.db.get<SeriesRow>('SELECT * FROM appointment_series WHERE id = ?', s.id)!);
  return { moved, removed, added: made.length };
}

export interface SeriesPatch {
  scope?: unknown;
  appointment_id?: unknown;
  start_time?: unknown;
  duration?: unknown;
  recurrence?: unknown;
  title?: unknown;
  notes?: unknown;
  notify?: unknown;
}

/** Changes a series: "single" (one appointment, it becomes an exception), "following" (splits the series) or "all". */
export async function updateSeries(app: App, locationId: string, seriesId: string, b: SeriesPatch) {
  const s = getSeries(app, locationId, seriesId);
  if (s.status === 'cancelled') throw new HttpError(409, 'Diese Serie ist abgesagt');
  const scope = (SCOPES.includes(b.scope as Scope) ? b.scope : 'all') as Scope;
  if (b.start_time !== undefined && !HM.test(String(b.start_time))) throw bad('Uhrzeit als HH:MM angeben');
  const dur = b.duration !== undefined ? duration(b.duration, s.duration) : s.duration;
  const time = b.start_time !== undefined ? String(b.start_time) : s.start_time;
  const title = b.title !== undefined ? String(b.title).trim().slice(0, 300) || s.title : undefined;
  const notes = b.notes !== undefined ? String(b.notes).slice(0, 5000) : undefined;
  const cal = calOf(app, locationId, s.calendar_id);

  if (scope === 'single') {
    const a = occurrenceOf(app, s, b.appointment_id);
    const day = a.occurrence_date || ymdInTz(new Date(a.start_at), s.timezone);
    const start = zonedToUtc(day, time, s.timezone);
    const set: Record<string, unknown> = { series_exception: 1 };
    if (b.start_time !== undefined || b.duration !== undefined) Object.assign(set, { start_at: start.toISOString(), end_at: new Date(start.getTime() + dur * 60_000).toISOString(), reminder_sent: 0 });
    if (title !== undefined) set.title = title;
    if (notes !== undefined) set.notes = notes;
    const keys = Object.keys(set);
    app.db.run(`UPDATE appointments SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => set[k] as any), a.id);
    const next = app.db.get<any>('SELECT * FROM appointments WHERE id = ?', a.id)!;
    if (next.start_at !== a.start_at)
      app.events.emit(locationId, 'appointment.rescheduled', { contactId: a.contact_id, appointment: next, previousStart: a.start_at, calendarId: a.calendar_id, series: { id: s.id, scope } });
    return { series: seriesOut(s), appointment: next, moved: next.start_at !== a.start_at ? 1 : 0, removed: 0, added: 0 };
  }

  let rule = ruleOf(s);
  if (b.recurrence !== undefined) {
    const r = recurErr(() => cleanApptRecurrence(b.recurrence));
    if (!r) throw bad('Wiederholung fehlt – zum Beenden die Serie absagen');
    rule = r;
  }
  const prev = { start_time: s.start_time, timezone: s.timezone, duration: s.duration };
  const today = ymdInTz(new Date(), s.timezone);
  let result: { moved: number; removed: number; added: number };
  let target = s;
  if (scope === 'following') {
    const a = occurrenceOf(app, s, b.appointment_id);
    const day: string = a.occurrence_date;
    if (day <= s.start_date) return updateSeries(app, locationId, seriesId, { ...b, scope: 'all' });
    const nextRule = recurErr(() => anchorRule(b.recurrence !== undefined ? rule : remainingCount(ruleOf(s), s.start_date, day), day));
    const at = now();
    const split: SeriesRow = {
      ...s,
      id: id(),
      rule: JSON.stringify(nextRule),
      rrule: toRrule(nextRule),
      start_date: day,
      start_time: time,
      duration: dur,
      title: title ?? s.title,
      notes: notes ?? s.notes,
      status: 'active',
      generated_until: null,
      parent_id: s.id,
      created_at: at,
      updated_at: at,
    };
    app.db.tx(() => {
      const cut = cutBefore(ruleOf(s), day);
      app.db.run(
        'UPDATE appointment_series SET rule = ?, rrule = ?, status = ?, updated_at = ? WHERE id = ?',
        JSON.stringify(cut),
        toRrule(cut),
        endsBy(cut, s.start_date, addDaysYmd(day, -1)) ? 'ended' : 'active',
        at,
        s.id,
      );
      app.db.insert('appointment_series', split as unknown as Record<string, unknown>);
      app.db.run('UPDATE appointments SET series_id = ? WHERE series_id = ? AND occurrence_date >= ?', split.id, s.id, day);
      result = rebuild(app, split, prev, day, { title, notes });
    });
    target = getSeries(app, locationId, split.id);
  } else {
    const fromDay = today > s.start_date ? today : s.start_date;
    const anchored = recurErr(() => anchorRule(rule, s.start_date));
    app.db.tx(() => {
      app.db.run(
        'UPDATE appointment_series SET rule = ?, rrule = ?, start_time = ?, duration = ?, title = ?, notes = ?, status = ?, updated_at = ? WHERE id = ?',
        JSON.stringify(anchored),
        toRrule(anchored),
        time,
        dur,
        title ?? s.title,
        notes ?? s.notes,
        'active',
        now(),
        s.id,
      );
      result = rebuild(app, getSeries(app, locationId, s.id), prev, fromDay, { title, notes });
    });
    target = getSeries(app, locationId, s.id);
  }
  if (target.contact_id) logActivity(app, locationId, target.contact_id, 'appointment.series', `Terminserie geändert: ${describeRecurrence(ruleOf(target))} um ${target.start_time}`);
  if (b.notify !== false && (result!.moved || result!.removed || result!.added) && !target.blocked) void notifySeries(app, target, cal, 'changed').catch(() => undefined);
  return { series: seriesOut(target), ...result! };
}

export interface CancelInput {
  scope?: unknown;
  appointment_id?: unknown;
  reason?: unknown;
  notify?: unknown;
}

/** Cancels one appointment of a series, it and the following ones, or the whole series (one e-mail to the contact, one event). */
export async function cancelSeries(app: App, locationId: string, seriesId: string, b: CancelInput) {
  const s = getSeries(app, locationId, seriesId);
  const scope = (SCOPES.includes(b.scope as Scope) ? b.scope : 'all') as Scope;
  const reason = String(b.reason ?? '').slice(0, 300);
  const cal = calOf(app, locationId, s.calendar_id);
  if (scope === 'single') {
    const a = occurrenceOf(app, s, b.appointment_id);
    if (a.status !== 'cancelled') {
      // The same cancel as the calendar page (refund rules, notices, waiting list) when the Team-Kalender module is there.
      const cancel = app.services.appointmentCancel as undefined | ((a: any, o: { by: 'staff'; reason: string }) => Promise<unknown>);
      if (cancel && a.status === 'confirmed') await cancel(a, { by: 'staff', reason });
      else {
        app.db.run(`UPDATE appointments SET status = 'cancelled' WHERE id = ?`, a.id);
        const next = app.db.get<any>('SELECT * FROM appointments WHERE id = ?', a.id)!;
        if (a.contact_id) logActivity(app, locationId, a.contact_id, 'appointment.status_changed', `Termin abgesagt${reason ? `: ${reason}` : ''}`);
        app.events.emit(locationId, 'appointment.status_changed', { contactId: a.contact_id, appointment: next, status: 'cancelled', calendarId: a.calendar_id, series: { id: s.id, scope } });
      }
    }
    app.db.run('UPDATE appointments SET series_exception = 1 WHERE id = ?', a.id);
    return { series: seriesOut(getSeries(app, locationId, s.id)), cancelled: 1 };
  }
  const nowIso = new Date().toISOString();
  let day = ymdInTz(new Date(), s.timezone);
  if (scope === 'following') day = occurrenceOf(app, s, b.appointment_id).occurrence_date;
  const rows = app.db.all<any>(`SELECT * FROM appointments WHERE series_id = ? AND occurrence_date >= ? AND start_at > ? AND status IN ('confirmed', 'blocked') ORDER BY start_at`, s.id, day, nowIso);
  app.db.tx(() => {
    if (scope === 'all' || day <= s.start_date) app.db.run(`UPDATE appointment_series SET status = 'cancelled', updated_at = ? WHERE id = ?`, now(), s.id);
    else {
      const cut = cutBefore(ruleOf(s), day);
      app.db.run('UPDATE appointment_series SET rule = ?, rrule = ?, status = ?, updated_at = ? WHERE id = ?', JSON.stringify(cut), toRrule(cut), 'ended', now(), s.id);
    }
    for (const a of rows) app.db.run(`UPDATE appointments SET status = 'cancelled', series_exception = 1 WHERE id = ?`, a.id);
  });
  if (rows.length) {
    const first = app.db.get<any>('SELECT * FROM appointments WHERE id = ?', rows[0].id)!;
    if (s.contact_id) logActivity(app, locationId, s.contact_id, 'appointment.status_changed', `Terminserie abgesagt (${rows.length} Termine)${reason ? `: ${reason}` : ''}`);
    app.events.emit(locationId, 'appointment.status_changed', {
      contactId: s.contact_id,
      appointment: first,
      status: 'cancelled',
      calendarId: s.calendar_id,
      series: { id: s.id, scope, count: rows.length },
    });
    if (b.notify !== false && !s.blocked) void notifySeries(app, getSeries(app, locationId, s.id), cal, 'cancelled', scope === 'following' ? day : undefined).catch(() => undefined);
  }
  return { series: seriesOut(getSeries(app, locationId, s.id)), cancelled: rows.length };
}

export type { Issue };
