import type { App } from '../core/app.js';
import { HttpError, bad } from '../core/http.js';
import { addDaysYmd, ymdInTz, zonedToUtc } from '../core/time.js';
import type { CalendarRow } from '../modules/calendars.js';
import { availabilityOf, peopleOf, cleanWindows, type Windows } from './team-people.js';
import { chooseHost, gridStarts, isFree, teamSlots, withDefaults, type Iv, type MemberLoad, type SlotRules, type TeamCalConfig, type TeamSlot } from './teamcal-model.js';

/**
 * Team-Kalender, the database side: a calendar's settings and members, each member's busy times (their own appointments,
 * held slots, absences, the Google/Outlook calendars they connected), the load for a fair distribution, the free times of
 * a day and the choice of the host when somebody books.
 */

const parse = <T>(s: unknown, fallback: T): T => {
  try {
    return s ? (JSON.parse(String(s)) as T) : fallback;
  } catch {
    return fallback;
  }
};

export interface Member {
  user_id: string;
  name: string;
  email: string;
  weight: number;
  hours: Windows | null;
  position: number;
}

export function getConfig(app: App, calendarId: string): TeamCalConfig {
  const row = app.db.get<{ data: string }>('SELECT data FROM teamcal_config WHERE calendar_id = ?', calendarId);
  return withDefaults(row ? parse(row.data, {}) : {});
}
export const hasConfig = (app: App, calendarId: string) => !!app.db.get('SELECT 1 FROM teamcal_config WHERE calendar_id = ?', calendarId);

export function saveConfig(app: App, locationId: string, calendarId: string, cfg: TeamCalConfig) {
  app.db.run(
    `INSERT INTO teamcal_config (calendar_id, location_id, kind, data, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(calendar_id) DO UPDATE SET kind = excluded.kind, data = excluded.data, updated_at = excluded.updated_at`,
    calendarId,
    locationId,
    cfg.kind,
    JSON.stringify(cfg),
    new Date().toISOString(),
  );
}

export function membersOf(app: App, calendarId: string): Member[] {
  const rows = app.db.all<any>(
    `SELECT m.user_id, m.weight, m.hours, m.position, u.name, u.email FROM teamcal_members m JOIN users u ON u.id = m.user_id WHERE m.calendar_id = ? ORDER BY m.position, u.name`,
    calendarId,
  );
  return rows.map((r) => ({ user_id: r.user_id, name: r.name, email: r.email, weight: r.weight, hours: cleanWindows(parse(r.hours, null)), position: r.position }));
}

/** Replaces the members; only people who can use the calendars of this sub-account may be in. */
export function setMembers(app: App, locationId: string, calendarId: string, list: unknown) {
  if (!Array.isArray(list)) throw bad('Mitglieder als Liste');
  if (list.length > 50) throw bad('Höchstens 50 Mitglieder');
  const allowed = new Set(peopleOf(app, locationId, 'calendars').map((p) => p.id));
  const seen = new Set<string>();
  const rows = list.map((m: any, i: number) => {
    const uid = String(m?.user_id ?? '');
    if (!allowed.has(uid)) throw bad('Eine gewählte Person hat keinen Zugriff auf die Kalender dieses Sub-Accounts');
    if (seen.has(uid)) throw bad('Eine Person ist doppelt in der Liste');
    seen.add(uid);
    const w = Math.round(Number(m?.weight ?? 1));
    return { uid, weight: Number.isFinite(w) ? Math.min(10, Math.max(1, w)) : 1, hours: m?.hours === null || m?.hours === undefined ? null : cleanWindows(m.hours), position: i };
  });
  app.db.tx(() => {
    app.db.run('DELETE FROM teamcal_members WHERE calendar_id = ?', calendarId);
    for (const r of rows) app.db.run('INSERT INTO teamcal_members (calendar_id, location_id, user_id, weight, hours, position) VALUES (?, ?, ?, ?, ?, ?)', calendarId, locationId, r.uid, r.weight, r.hours ? JSON.stringify(r.hours) : null, r.position);
  });
}

export const rulesOf = (cal: CalendarRow, cfg: TeamCalConfig): SlotRules => ({
  duration: cal.duration,
  interval: cal.interval || cal.duration,
  before: cfg.buffer_before ?? cal.buffer,
  after: cfg.buffer_after ?? cal.buffer,
  minNoticeH: cal.min_notice,
  maxDays: cal.max_days,
  tz: cal.timezone,
  availability: cal.availability as Windows,
});

const hostIdsOf = (a: { assignee_id?: string | null; host_ids?: string | null }): string[] => {
  const list = parse<string[]>(a.host_ids, []);
  return list.length ? list : a.assignee_id ? [a.assignee_id] : [];
};

/** Busy times and load of every member around a day (UTC ms). `except`: an appointment that is being moved. */
export function memberLoads(app: App, cal: CalendarRow, cfg: TeamCalConfig, members: Member[], ymd: string, at: Date, except?: string): MemberLoad[] {
  if (!members.length) return [];
  const from = new Date(zonedToUtc(addDaysYmd(ymd, -1), '00:00', cal.timezone).getTime()).toISOString();
  const to = new Date(zonedToUtc(addDaysYmd(ymd, 2), '00:00', cal.timezone).getTime()).toISOString();
  const byUser = new Map<string, Iv[]>(members.map((m) => [m.user_id, []]));
  const push = (uid: string, s: string, e: string) => byUser.get(uid)?.push({ s: Date.parse(s), e: Date.parse(e) });
  const everyone = (s: string, e: string) => {
    for (const m of members) push(m.user_id, s, e);
  };
  // Appointments: the person's own (any calendar of the sub-account), and blocks of this calendar for everybody.
  for (const a of app.db.all<any>(
    `SELECT id, start_at, end_at, status, assignee_id, host_ids, calendar_id FROM appointments WHERE location_id = ? AND status != 'cancelled' AND end_at > ? AND start_at < ? AND (assignee_id IS NOT NULL OR host_ids IS NOT NULL OR (status = 'blocked' AND calendar_id = ?))`,
    cal.location_id,
    from,
    to,
    cal.id,
  )) {
    if (a.id === except) continue;
    if (a.status === 'blocked' && !a.assignee_id && !a.host_ids) everyone(a.start_at, a.end_at);
    else for (const h of hostIdsOf(a)) push(h, a.start_at, a.end_at);
  }
  // Slots held for a payment.
  const nowIso = at.toISOString();
  for (const h of app.db.all<any>(`SELECT id, start_at, end_at, host_ids FROM teamcal_holds WHERE location_id = ? AND status = 'pending' AND expires_at > ? AND end_at > ? AND start_at < ?`, cal.location_id, nowIso, from, to)) {
    if (h.id === except) continue;
    for (const uid of parse<string[]>(h.host_ids, [])) push(uid, h.start_at, h.end_at);
  }
  // Absences (out of office, approved leave) and Google/Outlook busy times of the connected calendars.
  for (const m of members) {
    const av = availabilityOf(app, cal.location_id, m.user_id, from, to);
    if (av.paused) byUser.get(m.user_id)!.push({ s: -Infinity, e: Infinity });
    for (const a of av.away) push(m.user_id, a.start_at, a.end_at);
    for (const b of app.db.all<{ start_at: string; end_at: string }>(
      `SELECT b.start_at, b.end_at FROM oauth_busy b JOIN oauth_connections c ON c.id = b.connection_id WHERE c.purpose = 'calendar' AND c.user_id = ? AND b.end_at > ? AND b.start_at < ?`,
      m.user_id,
      from,
      to,
    )) push(m.user_id, b.start_at, b.end_at);
  }
  // Load: bookings of this calendar from the last 30 days on (cancelled ones do not count), held slots included.
  const since = new Date(at.getTime() - 30 * 864e5).toISOString();
  const load = new Map<string, number>();
  for (const a of app.db.all<any>(`SELECT id, assignee_id, host_ids FROM appointments WHERE calendar_id = ? AND status NOT IN ('cancelled', 'blocked') AND start_at >= ?`, cal.id, since)) {
    if (a.id === except) continue;
    const h = hostIdsOf(a)[0];
    if (h) load.set(h, (load.get(h) ?? 0) + 1);
  }
  for (const h of app.db.all<any>(`SELECT id, host_ids FROM teamcal_holds WHERE calendar_id = ? AND status = 'pending' AND expires_at > ?`, cal.id, nowIso)) {
    const first = parse<string[]>(h.host_ids, [])[0];
    if (first && h.id !== except) load.set(first, (load.get(first) ?? 0) + 1);
  }
  return members.map((m) => ({ id: m.user_id, weight: cfg.distribution === 'weighted' ? m.weight : 1, windows: m.hours, busy: byUser.get(m.user_id) ?? [], load: load.get(m.user_id) ?? 0 }));
}

export interface DaySlots {
  slots: TeamSlot[];
  /** Group classes: starts that are full (for the waiting list). */
  full: string[];
  /** Group classes: free seats per start. */
  left: Record<string, number>;
}

/** Seats taken at an exact start (appointments and held slots), group classes. */
function taken(app: App, cal: CalendarRow, startIso: string, except?: string): number {
  const a = app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM appointments WHERE calendar_id = ? AND start_at = ? AND status NOT IN ('cancelled', 'blocked') AND id != ?`, cal.id, startIso, except ?? '')!.n;
  const h = app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM teamcal_holds WHERE calendar_id = ? AND start_at = ? AND status = 'pending' AND expires_at > ? AND id != ?`, cal.id, startIso, new Date().toISOString(), except ?? '')!.n;
  return a + h;
}

/** The free start times of one day (YYYY-MM-DD in the calendar's zone) for a team calendar; null = not a team type. */
export function slotsOfDay(app: App, cal: CalendarRow, cfg: TeamCalConfig, ymd: string, at = new Date(), except?: string): DaySlots | null {
  if (cfg.kind === 'single') return null;
  const r = rulesOf(cal, cfg);
  const members = membersOf(app, cal.id);
  if (cfg.kind === 'group') return groupDay(app, cal, cfg, members, r, ymd, at, except);
  const loads = memberLoads(app, cal, cfg, members, ymd, at, except);
  return { slots: teamSlots(cfg.kind, cfg.strategy, cfg.distribution === 'weighted', r, ymd, at, loads), full: [], left: {} };
}

function groupDay(app: App, cal: CalendarRow, cfg: TeamCalConfig, members: Member[], r: SlotRules, ymd: string, at: Date, except?: string): DaySlots {
  const out: DaySlots = { slots: [], full: [], left: {} };
  const loads = members.length ? memberLoads(app, cal, cfg, members, ymd, at, except) : [];
  // Other classes of this calendar that overlap a start block it – the same start is the same class.
  const from = new Date(zonedToUtc(addDaysYmd(ymd, -1), '00:00', cal.timezone).getTime()).toISOString();
  const to = new Date(zonedToUtc(addDaysYmd(ymd, 2), '00:00', cal.timezone).getTime()).toISOString();
  const own = app.db.all<{ id: string; start_at: string; end_at: string; host_ids: string | null; assignee_id: string | null }>(
    `SELECT id, start_at, end_at, host_ids, assignee_id FROM appointments WHERE calendar_id = ? AND status NOT IN ('cancelled') AND end_at > ? AND start_at < ?`,
    cal.id,
    from,
    to,
  );
  const others = (startMs: number, startIso: string) => own.some((a) => a.id !== except && a.start_at !== startIso && startMs - r.before * 60_000 < Date.parse(a.end_at) && startMs + (r.duration + r.after) * 60_000 > Date.parse(a.start_at));
  for (const t of gridStarts(r, ymd, at)) {
    const iso = new Date(t).toISOString();
    const n = taken(app, cal, iso, except);
    if (others(t, iso)) continue;
    if (n >= cfg.capacity) {
      if (cfg.waitlist) {
        out.full.push(iso);
        out.left[iso] = 0;
      }
      continue;
    }
    // The class's hosts: those already hosting this start, otherwise everybody must be free (and the person's own hours fit).
    const existing = own.find((a) => a.start_at === iso);
    const hosts = existing ? hostIdsOf(existing) : loads.map((m) => m.id);
    if (!existing && loads.length && !loads.every((m) => isFree(m, ymd, t, r))) continue;
    out.slots.push({ start: iso, hosts });
    out.left[iso] = cfg.capacity - n;
  }
  return out;
}

/** The slots of a day for any calendar as ISO strings (the core's rules for single calendars are applied by the caller). */
export const slotStarts = (d: DaySlots) => d.slots.map((s) => s.start);

export interface Picked {
  hosts: string[];
  assignee: string | null;
}

/**
 * Checks that `start` is bookable on a team calendar and decides who hosts: round robin takes the free member with the lowest
 * load per weight, collective everybody, a group class its existing hosts. Throws 409 when the time is gone. `skipCheck`
 * (the team books by hand) skips the availability test; `hostId` (the team picks) must be one of the members.
 */
export function pickHosts(app: App, cal: CalendarRow, cfg: TeamCalConfig, start: Date, o: { skipCheck?: boolean; hostId?: string; except?: string } = {}): Picked {
  const members = membersOf(app, cal.id);
  const ymd = ymdInTz(start, cal.timezone);
  const iso = start.toISOString();
  const day = o.skipCheck ? null : slotsOfDay(app, cal, cfg, ymd, new Date(), o.except);
  const slot = day?.slots.find((s) => s.start === iso);
  if (!o.skipCheck && !slot) throw new HttpError(409, day?.full.includes(iso) ? 'Dieser Termin ist leider ausgebucht' : 'Dieser Termin ist leider nicht mehr frei');
  if (o.hostId && !members.some((m) => m.user_id === o.hostId)) throw bad('Diese Person gehört nicht zu diesem Kalender');
  if (cfg.kind === 'collective' || cfg.kind === 'group') {
    const hosts = slot?.hosts ?? members.map((m) => m.user_id);
    return { hosts, assignee: o.hostId && hosts.includes(o.hostId) ? o.hostId : (hosts[0] ?? null) };
  }
  // round robin
  if (o.hostId && (!slot || slot.hosts.includes(o.hostId))) return { hosts: [o.hostId], assignee: o.hostId };
  if (o.hostId) throw new HttpError(409, 'Diese Person ist zu der Zeit nicht frei');
  const loads = memberLoads(app, cal, cfg, members, ymd, new Date(), o.except);
  const pool = slot ? loads.filter((m) => slot.hosts.includes(m.id)) : loads;
  const best = chooseHost(pool, cfg.distribution === 'weighted');
  if (!best) throw new HttpError(409, 'Dieser Termin ist leider nicht mehr frei');
  return { hosts: [best.id], assignee: best.id };
}

/** Display names of host ids. */
export function hostNames(app: App, ids: string[]): { id: string; name: string }[] {
  if (!ids.length) return [];
  const rows = app.db.all<{ id: string; name: string }>(`SELECT id, name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
  return ids.map((i) => ({ id: i, name: rows.find((r) => r.id === i)?.name ?? '' })).filter((h) => h.name);
}

export { parse as parseJsonSafe, hostIdsOf };
