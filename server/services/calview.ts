import type { App } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { addDaysYmd, daysBetweenYmd, ymdInTz, zonedToUtc } from '../core/time.js';
import type { CalendarRow } from '../modules/calendars.js';
import { limitBlocks, windowsFor } from './booking-rules.js';
import { availabilityOf, peopleOf } from './team-people.js';

/**
 * Calendar view (docs/booking.md#calendar-view): everything a day, week, month or team grid shows for a time range – the
 * appointments with their people, buffers around them, the bookable hours of each day, busy times of connected Google/Outlook/
 * iCal calendars, and out-of-office/HR absences – plus the conflict check behind drag & drop and booking from an empty slot.
 * All times are ISO instants; the browser draws them on the wall clock of the sub-account's time zone.
 */

export type Range = { from: string; to: string };
export type Interval = { start_at: string; end_at: string };

/** At most this many days per request (a month grid with its leading/trailing days is 42). */
export const MAX_DAYS = 62;
const MAX_APPOINTMENTS = 3000;

const parse = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string' || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

/** Columns other modules add to `appointments` (Team-Kalender: hosts, video, payment) – asked once per app. */
const columns = new WeakMap<App, Set<string>>();
export function apptColumns(app: App): Set<string> {
  let c = columns.get(app);
  if (!c) columns.set(app, (c = new Set(app.db.all<{ name: string }>('PRAGMA table_info(appointments)').map((x) => x.name))));
  return c;
}
const hasTable = (app: App, name: string) => !!app.db.get(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, name);

export function calendarsOf(app: App, locationId: string): CalendarRow[] {
  return app.db.all<CalendarRow>('SELECT * FROM calendars WHERE location_id = ? ORDER BY name', locationId).map((c) => parseJson(c, ['availability', 'settings']));
}

/** Team members per calendar (Team-Kalender), empty when that module is not there. */
export function membersByCalendar(app: App, locationId: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!hasTable(app, 'teamcal_members')) return out;
  for (const r of app.db.all<{ calendar_id: string; user_id: string }>(
    'SELECT m.calendar_id, m.user_id FROM teamcal_members m JOIN calendars k ON k.id = m.calendar_id WHERE k.location_id = ? ORDER BY m.position',
    locationId,
  )) {
    out.set(r.calendar_id, [...(out.get(r.calendar_id) ?? []), r.user_id]);
  }
  return out;
}

/** Who an appointment belongs to: its hosts, its assignee, or the one member of its calendar. */
export function peopleOfAppt(a: { host_ids?: string | null; assignee_id?: string | null; calendar_id: string }, members: Map<string, string[]>): string[] {
  const hosts = parse<string[]>(a.host_ids, []).filter((x) => typeof x === 'string');
  if (hosts.length) return hosts;
  if (a.assignee_id) return [a.assignee_id];
  const m = members.get(a.calendar_id) ?? [];
  return m.length === 1 ? m : [];
}

const overlaps = (a: Interval, s: number, e: number) => Date.parse(a.start_at) < e && Date.parse(a.end_at) > s;

/** The bookable windows of each day of the range per calendar, as ISO intervals (the grid shades everything else). */
export function hoursOf(cal: CalendarRow, fromYmd: string, toYmd: string): Interval[] {
  const out: Interval[] = [];
  for (let d = fromYmd; d <= toYmd; d = addDaysYmd(d, 1)) {
    for (const [f, t] of windowsFor(cal, d)) out.push({ start_at: zonedToUtc(d, f, cal.timezone).toISOString(), end_at: zonedToUtc(d, t, cal.timezone).toISOString() });
  }
  return out;
}

export interface ViewQuery {
  from: string;
  to: string;
  calendarIds?: string[];
  userIds?: string[];
  statuses?: string[];
  layers: Set<string>;
}

/** The days (YYYY-MM-DD in `tz`) a range touches, capped. */
export function rangeDays(r: Range, tz: string): { first: string; last: string } {
  const first = ymdInTz(new Date(r.from), tz);
  let last = ymdInTz(new Date(Date.parse(r.to) - 1), tz);
  if (last < first) last = first;
  if (daysBetweenYmd(first, last) > MAX_DAYS) last = addDaysYmd(first, MAX_DAYS);
  return { first, last };
}

export function viewData(app: App, locationId: string, q: ViewQuery) {
  const loc = app.location(locationId);
  const tz = loc?.timezone || 'Europe/Berlin';
  const { first, last } = rangeDays(q, tz);
  const from = zonedToUtc(first, '00:00', tz).toISOString();
  const to = zonedToUtc(addDaysYmd(last, 1), '00:00', tz).toISOString();
  const cols = apptColumns(app);
  const allCals = calendarsOf(app, locationId);
  const members = membersByCalendar(app, locationId);
  const cals = q.calendarIds?.length ? allCals.filter((c) => q.calendarIds!.includes(c.id)) : allCals;
  const calIds = cals.map((c) => c.id);
  const users = peopleOf(app, locationId, 'calendars').map((u) => ({ id: u.id, name: u.name }));
  const userSet = q.userIds?.length ? new Set(q.userIds) : null;

  const extra = ['assignee_id', 'host_ids', 'meeting_url', 'payment'].filter((c) => cols.has(c)).map((c) => `a.${c}`);
  const statusSql = q.statuses?.length ? ` AND a.status IN (${q.statuses.map(() => '?').join(', ')})` : '';
  const rows = calIds.length
    ? app.db.all<any>(
        `SELECT a.id, a.calendar_id, a.contact_id, a.title, a.start_at, a.end_at, a.status, a.notes, a.source, a.series_id, a.recurrence, a.series_exception, a.occurrence_date${extra.length ? `, ${extra.join(', ')}` : ''},
                c.first_name, c.last_name, c.email, c.phone
         FROM appointments a LEFT JOIN contacts c ON c.id = a.contact_id
         WHERE a.location_id = ? AND a.calendar_id IN (${calIds.map(() => '?').join(', ')}) AND a.start_at < ? AND a.end_at > ?${statusSql}
         ORDER BY a.start_at LIMIT ${MAX_APPOINTMENTS}`,
        locationId,
        ...calIds,
        to,
        from,
        ...(q.statuses ?? []),
      )
    : [];
  const calById = new Map(allCals.map((c) => [c.id, c]));
  const appointments = rows
    .map((a) => {
      const people = peopleOfAppt(a, members);
      const pay = parse<any>(a.payment, null);
      return {
        id: a.id,
        calendar_id: a.calendar_id,
        contact_id: a.contact_id,
        title: a.title,
        start_at: a.start_at,
        end_at: a.end_at,
        status: a.status,
        notes: String(a.notes ?? '').slice(0, 300),
        source: a.source,
        series_id: a.series_id ?? null,
        recurrence: a.recurrence ?? null,
        series_exception: !!a.series_exception,
        people,
        contact_name: [a.first_name, a.last_name].filter(Boolean).join(' ') || a.email || '',
        email: a.email ?? '',
        phone: a.phone ?? '',
        meeting_url: a.meeting_url ?? '',
        payment_status: pay?.status ?? null,
      };
    })
    .filter((a) => !userSet || a.people.some((p) => userSet.has(p)));

  // Buffers: shaded blocks before and after every appointment of a calendar with a buffer.
  const buffers: (Interval & { appointment_id: string; calendar_id: string; side: 'before' | 'after' })[] = [];
  for (const a of appointments) {
    const buf = (calById.get(a.calendar_id)?.buffer ?? 0) * 60_000;
    if (!buf || a.status === 'cancelled') continue;
    buffers.push({ appointment_id: a.id, calendar_id: a.calendar_id, side: 'before', start_at: new Date(Date.parse(a.start_at) - buf).toISOString(), end_at: a.start_at });
    buffers.push({ appointment_id: a.id, calendar_id: a.calendar_id, side: 'after', start_at: a.end_at, end_at: new Date(Date.parse(a.end_at) + buf).toISOString() });
  }

  const hours: Record<string, Interval[]> = {};
  for (const c of cals) hours[c.id] = hoursOf(c, first, last);

  // Busy times of connected calendars (Google, Outlook, iCal) per booking calendar – and per person for the team view.
  const busy: (Interval & { calendar_id?: string; user_id?: string })[] = [];
  if (q.layers.has('busy')) {
    for (const c of cals) {
      const list: Interval[] = app.services.externalBusy?.(c, from, to) ?? [];
      const seen = new Set<string>();
      for (const b of list) {
        const k = `${b.start_at}|${b.end_at}`;
        if (seen.has(k)) continue;
        seen.add(k);
        busy.push({ calendar_id: c.id, start_at: b.start_at, end_at: b.end_at });
      }
    }
    if (hasTable(app, 'oauth_busy')) {
      const ids = (userSet ? users.filter((u) => userSet.has(u.id)) : users).slice(0, 50).map((u) => u.id);
      if (ids.length) {
        for (const b of app.db.all<any>(
          `SELECT DISTINCT c.user_id, b.start_at, b.end_at FROM oauth_busy b JOIN oauth_connections c ON c.id = b.connection_id
           WHERE c.purpose = 'calendar' AND c.user_id IN (${ids.map(() => '?').join(', ')}) AND b.end_at > ? AND b.start_at < ? LIMIT 2000`,
          ...ids,
          from,
          to,
        ))
          busy.push({ user_id: b.user_id, start_at: b.start_at, end_at: b.end_at });
      }
    }
  }

  // Out of office (Team) and approved absences (HR) of the people in view.
  const absences: (Interval & { user_id: string; note: string; source: string })[] = [];
  if (q.layers.has('absences')) {
    for (const u of (userSet ? users.filter((x) => userSet.has(x.id)) : users).slice(0, 50)) {
      for (const a of availabilityOf(app, locationId, u.id, from, to).away)
        if (overlaps(a, Date.parse(from), Date.parse(to))) absences.push({ user_id: u.id, start_at: a.start_at, end_at: a.end_at, note: a.note, source: a.source });
    }
  }

  return {
    timezone: tz,
    from,
    to,
    days: { first, last },
    now: new Date().toISOString(),
    calendars: allCals.map((c) => ({
      id: c.id,
      name: c.name,
      color: c.color,
      timezone: c.timezone,
      duration: c.duration,
      interval: c.interval,
      buffer: c.buffer,
      active: !!c.active,
      members: members.get(c.id) ?? [],
    })),
    users,
    appointments,
    buffers,
    hours,
    busy,
    absences,
  };
}

// --- conflicts -------------------------------------------------------------------------------------------------------------------

export type IssueKind = 'appointment' | 'blocked' | 'buffer' | 'person' | 'busy' | 'hours' | 'limit' | 'absence';
export interface Issue extends Interval {
  kind: IssueKind;
  /** What it is about: the other appointment's title, the absence note … (data, shown next to the translated kind). */
  label: string;
  id?: string;
}

/**
 * What speaks against putting an appointment of `cal` at [start, end): other appointments of the calendar (and calendars sharing
 * its availability), its buffer, the people's appointments in other calendars, busy times of connected calendars, the bookable
 * hours of the day, the day/week limit, and absences of the people. `except` = the appointment that is being moved.
 */
export function checkTime(app: App, cal: CalendarRow, startIso: string, endIso: string, o: { except?: string; people?: string[] } = {}): Issue[] {
  const s = Date.parse(startIso);
  const e = Date.parse(endIso);
  const issues: Issue[] = [];
  const buf = cal.buffer * 60_000;
  const group = cal.settings?.shared_group;
  const near = app.db.all<any>(
    `SELECT id, title, start_at, end_at, status FROM appointments
     WHERE location_id = ? AND status != 'cancelled' AND id != ? AND start_at < ? AND end_at > ?
       AND (calendar_id = ? ${group ? `OR calendar_id IN (SELECT id FROM calendars WHERE location_id = ? AND json_extract(settings, '$.shared_group') = ?)` : ''})
     ORDER BY start_at LIMIT 20`,
    cal.location_id,
    o.except ?? '',
    new Date(e + buf).toISOString(),
    new Date(s - buf).toISOString(),
    cal.id,
    ...(group ? [cal.location_id, group] : []),
  );
  for (const r of near) {
    const direct = overlaps(r, s, e);
    issues.push({ kind: direct ? (r.status === 'blocked' ? 'blocked' : 'appointment') : 'buffer', label: r.title, id: r.id, start_at: r.start_at, end_at: r.end_at });
  }
  const people = (o.people ?? []).filter(Boolean).slice(0, 20);
  const cols = apptColumns(app);
  if (people.length && cols.has('assignee_id') && cols.has('host_ids')) {
    const marks = people.map(() => '?').join(', ');
    for (const r of app.db.all<any>(
      `SELECT id, title, start_at, end_at FROM appointments
       WHERE location_id = ? AND status NOT IN ('cancelled') AND id != ? AND calendar_id != ? AND start_at < ? AND end_at > ?
         AND (assignee_id IN (${marks}) OR EXISTS (SELECT 1 FROM json_each(COALESCE(host_ids, '[]')) h WHERE h.value IN (${marks})))
       LIMIT 20`,
      cal.location_id,
      o.except ?? '',
      cal.id,
      endIso,
      startIso,
      ...people,
      ...people,
    ))
      issues.push({ kind: 'person', label: r.title, id: r.id, start_at: r.start_at, end_at: r.end_at });
  }
  const external: Interval[] = app.services.externalBusy?.(cal, startIso, endIso) ?? [];
  for (const b of external) if (overlaps(b, s, e)) issues.push({ kind: 'busy', label: '', start_at: b.start_at, end_at: b.end_at });
  const ymd = ymdInTz(new Date(s), cal.timezone);
  const inside = windowsFor(cal, ymd).some(([f, t]) => zonedToUtc(ymd, f, cal.timezone).getTime() <= s && e <= zonedToUtc(ymd, t, cal.timezone).getTime());
  if (!inside) issues.push({ kind: 'hours', label: '', start_at: startIso, end_at: endIso });
  const limit = limitBlocks(app, cal, ymd, o.except);
  if (limit.length) issues.push({ kind: 'limit', label: '', ...limit[0] });
  for (const uid of people) {
    const av = availabilityOf(app, cal.location_id, uid, new Date(s - 864e5).toISOString(), new Date(e + 864e5).toISOString());
    for (const a of av.away) if (overlaps(a, s, e)) issues.push({ kind: 'absence', label: a.note, start_at: a.start_at, end_at: a.end_at });
  }
  return issues;
}
