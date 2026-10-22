import type { App } from '../core/app.js';
import { HttpError, bad, str } from '../core/http.js';
import { addDaysYmd, hmInTz, ymdInTz } from '../core/time.js';
import { id, now } from '../core/util.js';
import { logActivity } from './contacts.js';
import { award, notify } from './community-actions.js';
import { extOf } from './community-ext.js';
import { awardBadge, badgeById } from './community-gamify.js';

/**
 * Challenges: a time-boxed task for the group ("30 Tage Schreiben"). Members join, check in once a day (optionally with a note),
 * get points for every check-in and a bonus when they reach the goal, and compete on a board of their own.
 * Days are calendar days in the sub-account's time zone; day 1 is `starts_on`.
 */

export interface Challenge {
  id: string;
  location_id: string;
  group_id: string;
  title: string;
  description: string;
  emoji: string;
  starts_on: string;
  ends_on: string;
  goal_days: number;
  status: 'draft' | 'active' | 'archived';
  points_checkin: number | null;
  points_complete: number | null;
  badge_id: string | null;
  require_note: number;
  reminder_hour: number | null;
  last_reminder_day: string;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  challenge_id: string;
  day: number;
  title: string;
  body: string;
}

export const MAX_DAYS = 366;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const validYmd = (s: string) => YMD.test(s) && ymdInTz(new Date(`${s}T12:00:00Z`), 'UTC') === s;

export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5);
export const totalDays = (c: Pick<Challenge, 'starts_on' | 'ends_on'>) => daysBetween(c.starts_on, c.ends_on) + 1;
export const tzOf = (app: App, locationId: string) => app.location(locationId)?.timezone || 'Europe/Berlin';
export const todayOf = (app: App, locationId: string, at = new Date()) => ymdInTz(at, tzOf(app, locationId));

export function cleanChallenge(app: App, g: { id: string; location_id: string }, input: any, cur: Partial<Challenge> = {}) {
  const b = input ?? {};
  const out: Record<string, any> = {};
  if (b.title !== undefined || !cur.title) out.title = str(b.title, 'Titel', { required: true, max: 120 });
  if (b.description !== undefined) out.description = str(b.description, 'Beschreibung', { max: 6000 });
  if (b.emoji !== undefined) out.emoji = [...String(b.emoji ?? '').trim()].slice(0, 2).join('');
  for (const k of ['starts_on', 'ends_on'] as const) {
    if (b[k] !== undefined || !cur[k]) {
      const v = String(b[k] ?? '').trim();
      if (!validYmd(v)) throw bad(`${k === 'starts_on' ? 'Start' : 'Ende'}: bitte ein Datum (JJJJ-MM-TT)`);
      out[k] = v;
    }
  }
  const start = out.starts_on ?? cur.starts_on;
  const end = out.ends_on ?? cur.ends_on;
  if (start && end) {
    if (end < start) throw bad('Das Ende liegt vor dem Start');
    if (daysBetween(start, end) + 1 > MAX_DAYS) throw bad(`Eine Challenge dauert höchstens ${MAX_DAYS} Tage`);
  }
  const days = start && end ? daysBetween(start, end) + 1 : 1;
  if (b.goal_days !== undefined || !cur.goal_days || out.starts_on || out.ends_on) {
    const raw = b.goal_days === undefined || b.goal_days === '' || b.goal_days === null ? (b.goal_days === undefined && cur.goal_days ? cur.goal_days : days) : Math.round(Number(b.goal_days));
    if (!Number.isFinite(raw) || raw < 1) throw bad('Ziel: mindestens 1 Tag');
    out.goal_days = Math.min(raw, days);
  }
  if (b.status !== undefined) {
    if (!['draft', 'active', 'archived'].includes(b.status)) throw bad('Status: draft, active oder archived');
    out.status = b.status;
  }
  for (const k of ['points_checkin', 'points_complete'] as const) {
    if (b[k] !== undefined) {
      if (b[k] === null || b[k] === '') out[k] = null;
      else {
        const n = Math.round(Number(b[k]));
        if (!Number.isFinite(n) || n < 0 || n > 1000) throw bad('Punkte: 0 bis 1000');
        out[k] = n;
      }
    }
  }
  if (b.badge_id !== undefined) {
    if (b.badge_id) {
      const badge = badgeById(app, g.location_id, String(b.badge_id));
      if (!badge || badge.group_id !== g.id) throw bad('Dieses Abzeichen gibt es in der Gruppe nicht');
      out.badge_id = badge.id;
    } else out.badge_id = null;
  }
  if (b.require_note !== undefined) out.require_note = b.require_note ? 1 : 0;
  if (b.reminder_hour !== undefined) {
    if (b.reminder_hour === null || b.reminder_hour === '') out.reminder_hour = null;
    else {
      const h = Math.round(Number(b.reminder_hour));
      if (!Number.isFinite(h) || h < 0 || h > 23) throw bad('Erinnerung: Stunde 0 bis 23');
      out.reminder_hour = h;
    }
  }
  return out;
}

export function cleanTasks(input: unknown, days: number): { day: number; title: string; body: string }[] {
  if (!Array.isArray(input)) throw bad('Aufgaben: bitte eine Liste');
  const seen = new Set<number>();
  const out: { day: number; title: string; body: string }[] = [];
  for (const t of input.slice(0, MAX_DAYS)) {
    const day = Math.round(Number(t?.day));
    if (!Number.isFinite(day) || day < 1 || day > days) throw bad(`Aufgabe: Tag 1 bis ${days}`);
    if (seen.has(day)) throw bad(`Für Tag ${day} gibt es zwei Aufgaben`);
    seen.add(day);
    const title = str(t?.title, 'Aufgabe', { required: true, max: 160 });
    out.push({ day, title, body: str(t?.body, 'Beschreibung', { max: 2000 }) });
  }
  return out.sort((a, b) => a.day - b.day);
}

export const challengeById = (app: App, locationId: string, cid: string) => app.db.get<Challenge>('SELECT * FROM community_challenges WHERE id = ? AND location_id = ?', cid, locationId);
export const tasksOf = (app: App, cid: string) => app.db.all<Task>('SELECT * FROM community_challenge_tasks WHERE challenge_id = ? ORDER BY day', cid);

/** upcoming / running / over – by the calendar, independent of the status. */
export function phaseOf(app: App, c: Challenge, today = todayOf(app, c.location_id)): 'upcoming' | 'running' | 'over' {
  return today < c.starts_on ? 'upcoming' : today > c.ends_on ? 'over' : 'running';
}

export interface Participant {
  challenge_id: string;
  contact_id: string;
  joined_at: string;
  completed_at: string | null;
  checkins: number;
  streak: number;
  best_streak: number;
  last_day: string;
}

export const participantOf = (app: App, cid: string, contactId: string) => app.db.get<Participant>('SELECT * FROM community_challenge_members WHERE challenge_id = ? AND contact_id = ?', cid, contactId);

export function joinChallenge(app: App, g: any, c: Challenge, contactId: string): Participant {
  if (c.status !== 'active') throw new HttpError(409, 'Diese Challenge ist nicht geöffnet.');
  if (phaseOf(app, c) === 'over') throw new HttpError(409, 'Diese Challenge ist schon vorbei.');
  const cur = participantOf(app, c.id, contactId);
  if (cur) return cur;
  app.db.run('INSERT OR IGNORE INTO community_challenge_members (challenge_id, contact_id, location_id, joined_at, checkins, streak, best_streak, last_day) VALUES (?, ?, ?, ?, 0, 0, 0, \'\')', c.id, contactId, c.location_id, now());
  logActivity(app, c.location_id, contactId, 'community.challenge_joined', `Challenge „${c.title}“ gestartet`);
  app.events.emit(c.location_id, 'community.challenge_joined', { contactId, groupId: g.id, group: { id: g.id, name: g.name }, challenge: { id: c.id, title: c.title } });
  return participantOf(app, c.id, contactId)!;
}

export interface CheckinResult {
  checkin: { id: string; day: string; note: string };
  participant: Participant;
  completed: boolean;
  points: number;
}

/** A check-in for today. Joins on the first one. One per day; the goal triggers the bonus, the badge and the event. */
export function checkIn(app: App, g: any, c: Challenge, contactId: string, note: unknown, at = new Date()): CheckinResult {
  if (c.status !== 'active') throw new HttpError(409, 'Diese Challenge ist nicht geöffnet.');
  const today = todayOf(app, c.location_id, at);
  const phase = phaseOf(app, c, today);
  if (phase === 'upcoming') throw new HttpError(409, 'Die Challenge hat noch nicht begonnen.');
  if (phase === 'over') throw new HttpError(409, 'Die Challenge ist vorbei.');
  const text = String(note ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 600);
  if (c.require_note && text.length < 2) throw bad('Bitte schreib kurz dazu, was du heute gemacht hast.');
  joinChallenge(app, g, c, contactId);
  const rowId = id();
  const ins = app.db.run('INSERT OR IGNORE INTO community_challenge_checkins (id, location_id, challenge_id, contact_id, day, note, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)', rowId, c.location_id, c.id, contactId, today, text, at.toISOString());
  if (!ins.changes) throw new HttpError(409, 'Du hast heute schon eingecheckt – bis morgen!');
  const days = new Set(app.db.all<{ day: string }>('SELECT day FROM community_challenge_checkins WHERE challenge_id = ? AND contact_id = ?', c.id, contactId).map((r) => r.day));
  let streak = 0;
  for (let d = today; days.has(d); d = addDaysYmd(d, -1)) streak++;
  const prev = participantOf(app, c.id, contactId)!;
  const checkins = days.size;
  const done = checkins >= c.goal_days && !prev.completed_at;
  app.db.run('UPDATE community_challenge_members SET checkins = ?, streak = ?, best_streak = MAX(best_streak, ?), last_day = ?, completed_at = COALESCE(completed_at, ?) WHERE challenge_id = ? AND contact_id = ?', checkins, streak, streak, today, done ? at.toISOString() : null, c.id, contactId);
  const ext = extOf(app, g.id).points;
  let points = c.points_checkin ?? ext.challenge_checkin;
  if (points) award(app, g, contactId, points, 'challenge_checkin', rowId);
  if (done) {
    const bonus = c.points_complete ?? ext.challenge_complete;
    if (bonus) award(app, g, contactId, bonus, 'challenge_complete', c.id);
    points += bonus;
    logActivity(app, c.location_id, contactId, 'community.challenge_completed', `Challenge „${c.title}“ geschafft`);
    notify(app, g, [contactId], { kind: 'challenge', text: `Geschafft! Du hast die Challenge „${c.title}“ abgeschlossen.` });
    const badge = c.badge_id ? badgeById(app, c.location_id, c.badge_id) : undefined;
    if (badge) awardBadge(app, g, contactId, badge, '', `Challenge „${c.title}“`);
    app.events.emit(c.location_id, 'community.challenge_completed', { contactId, groupId: g.id, group: { id: g.id, name: g.name }, challenge: { id: c.id, title: c.title }, checkins });
  }
  logActivity(app, c.location_id, contactId, 'community.challenge_checkin', `Check-in „${c.title}“ (${checkins}/${c.goal_days})`);
  return { checkin: { id: rowId, day: today, note: text }, participant: participantOf(app, c.id, contactId)!, completed: done, points };
}

/** Ranking of one challenge: check-ins, then the current streak, then who joined first. */
export function challengeBoard(app: App, cid: string, limit = 20) {
  return app.db.all<Participant>(
    `SELECT p.* FROM community_challenge_members p JOIN community_challenges c ON c.id = p.challenge_id
     JOIN community_members m ON m.group_id = c.group_id AND m.contact_id = p.contact_id AND m.banned_at IS NULL
     WHERE p.challenge_id = ? AND p.checkins > 0 ORDER BY p.checkins DESC, p.streak DESC, p.joined_at LIMIT ?`,
    cid,
    limit,
  );
}

export function challengeCounts(app: App, cid: string) {
  const r = app.db.get<{ members: number; done: number; checkins: number }>(
    'SELECT COUNT(*) AS members, COALESCE(SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS done, COALESCE(SUM(checkins), 0) AS checkins FROM community_challenge_members WHERE challenge_id = ?',
    cid,
  )!;
  return r;
}

/** Days of the challenge with the member's state: done, missed, today or still to come. */
export function dayStates(app: App, c: Challenge, contactId: string, today = todayOf(app, c.location_id)) {
  const done = new Set(app.db.all<{ day: string }>('SELECT day FROM community_challenge_checkins WHERE challenge_id = ? AND contact_id = ?', c.id, contactId).map((r) => r.day));
  const n = totalDays(c);
  return Array.from({ length: n }, (_x, i) => {
    const day = addDaysYmd(c.starts_on, i);
    return { n: i + 1, day, state: done.has(day) ? 'done' : day === today ? 'today' : day < today ? 'missed' : 'future' } as { n: number; day: string; state: 'done' | 'missed' | 'today' | 'future' };
  });
}

/** Challenges a member is in and has not checked into today – for the banner on the feed. */
export function dueToday(app: App, groupId: string, contactId: string) {
  return app.db
    .all<Challenge>(`SELECT c.* FROM community_challenges c JOIN community_challenge_members p ON p.challenge_id = c.id AND p.contact_id = ? WHERE c.group_id = ? AND c.status = 'active' ORDER BY c.starts_on`, contactId, groupId)
    .filter((c) => phaseOf(app, c) === 'running' && participantOf(app, c.id, contactId)!.last_day !== todayOf(app, c.location_id));
}

/** Once a day at the reminder hour: a bell entry (and push) for everybody who has not checked in yet. */
export function sendReminders(app: App, at = new Date()): number {
  let sent = 0;
  for (const c of app.db.all<Challenge>(`SELECT * FROM community_challenges WHERE status = 'active' AND reminder_hour IS NOT NULL`)) {
    const tz = tzOf(app, c.location_id);
    const today = ymdInTz(at, tz);
    if (c.last_reminder_day === today || phaseOf(app, c, today) !== 'running') continue;
    if (Number(hmInTz(at, tz).slice(0, 2)) < (c.reminder_hour ?? 0)) continue;
    const g = app.db.get<any>('SELECT * FROM community_groups WHERE id = ?', c.group_id);
    if (!g) continue;
    app.db.run('UPDATE community_challenges SET last_reminder_day = ? WHERE id = ?', today, c.id);
    const who = app.db
      .all<{ contact_id: string }>(
        `SELECT p.contact_id FROM community_challenge_members p JOIN community_members m ON m.group_id = ? AND m.contact_id = p.contact_id AND m.banned_at IS NULL
         WHERE p.challenge_id = ? AND p.last_day != ?`,
        c.group_id,
        c.id,
        today,
      )
      .map((r) => r.contact_id);
    if (!who.length) continue;
    const day = daysBetween(c.starts_on, today) + 1;
    notify(app, g, who, { kind: 'challenge', text: `Tag ${day} von „${c.title}“: Dein Check-in wartet.`, postId: c.id });
    sent += who.length;
  }
  return sent;
}

export const rowOut = (c: Challenge) => ({ ...c, require_note: !!c.require_note });
