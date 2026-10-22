import { bad } from '../core/http.js';
import { hmInTz, isValidTz, weekdayKey, ymdInTz } from '../core/time.js';
import { id as newId } from '../core/util.js';
import { DAY_KEYS, defaultHours, slaDeadlines, type BusinessHours, type WorkCalendar } from './helpdesk-sla.js';

/**
 * Team-Posteingang: the vocabulary (status, priority, views), the per-sub-account settings with their
 * validation, mention parsing, SLA deadlines (built on the helpdesk's business-hours math) and the SQL for the views.
 * Pure – no database, no clock of its own – so the rules can be tested without an app.
 */

export const STATUSES = ['open', 'waiting', 'closed'] as const;
export type InboxStatus = (typeof STATUSES)[number];
export const STATUS_LABEL: Record<InboxStatus, string> = { open: 'Offen', waiting: 'Wartet auf Kontakt', closed: 'Erledigt' };

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type InboxPriority = (typeof PRIORITIES)[number];
export const PRIORITY_LABEL: Record<InboxPriority, string> = { low: 'Niedrig', normal: 'Normal', high: 'Hoch', urgent: 'Dringend' };
export const PRIORITY_RANK: Record<InboxPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export const VIEWS = ['all', 'open', 'mine', 'unassigned', 'team', 'waiting', 'done', 'snoozed', 'sla', 'mentions'] as const;
export type InboxView = (typeof VIEWS)[number];
export const VIEW_LABEL: Record<InboxView, string> = {
  all: 'Alle',
  open: 'Offen',
  mine: 'Mir zugewiesen',
  unassigned: 'Nicht zugewiesen',
  team: 'Team',
  waiting: 'Wartet auf Kontakt',
  done: 'Erledigt',
  snoozed: 'Zurückgestellt',
  sla: 'SLA gefährdet',
  mentions: 'Erwähnungen',
};

export const isStatus = (v: unknown): v is InboxStatus => (STATUSES as readonly string[]).includes(String(v));
export const isPriority = (v: unknown): v is InboxPriority => (PRIORITIES as readonly string[]).includes(String(v));
export const isView = (v: unknown): v is InboxView => (VIEWS as readonly string[]).includes(String(v));

// --- settings -----------------------------------------------------------------------------------

export type AssignTarget = { type: 'user' | 'team' | 'pool'; id: string };
export interface AssignRule {
  id: string;
  name: string;
  enabled: boolean;
  /** Channels (email, sms, chat, whatsapp …); empty = any. */
  channels: string[];
  /** Contact tags; the rule matches when the contact has at least one; empty = any. */
  tags: string[];
  target: AssignTarget;
  /** Priority to set on the conversation when the rule matches ('' = leave). */
  priority: '' | InboxPriority;
}

export interface InboxSettings {
  assignment: {
    /** manual: nobody is assigned automatically; round_robin: take turns; least_busy: fewest open conversations. */
    mode: 'manual' | 'round_robin' | 'least_busy';
    /** Who is in the default pool: everybody with access, one helpdesk team, or chosen people. */
    pool: 'all' | 'team' | 'users';
    team_id: string;
    user_ids: string[];
    respect_availability: boolean;
    /** The contact's owner (Kontakte → Zuständig) gets the conversation first when they are available. */
    prefer_contact_owner: boolean;
    /** A new message to a conversation whose assignee is away goes to somebody else. */
    reassign_when_away: boolean;
    /** Somebody answers an unassigned conversation: it is theirs. */
    assign_on_reply: boolean;
    rules: AssignRule[];
  };
  sla: {
    enabled: boolean;
    first_response_min: number;
    next_response_min: number;
    warn_percent: number;
    business_hours: boolean;
    notify_assignee: boolean;
    notify_email: boolean;
  };
  business_hours: BusinessHours;
  holidays: string[];
  /** Conversations nobody answered for this many days after our last message close themselves (0 = never). */
  auto_close_days: number;
  /** Our reply sets the status to "Wartet auf Kontakt". */
  reply_sets_waiting: boolean;
  notifications: { assign_push: boolean; assign_email: boolean; mention_email: boolean };
}

export const defaultSettings = (): InboxSettings => ({
  assignment: { mode: 'manual', pool: 'all', team_id: '', user_ids: [], respect_availability: true, prefer_contact_owner: true, reassign_when_away: true, assign_on_reply: true, rules: [] },
  sla: { enabled: false, first_response_min: 240, next_response_min: 480, warn_percent: 80, business_hours: true, notify_assignee: true, notify_email: false },
  business_hours: defaultHours(),
  holidays: [],
  auto_close_days: 0,
  reply_sets_waiting: false,
  notifications: { assign_push: true, assign_email: false, mention_email: true },
});

const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});
const strList = (v: unknown, max: number, len = 60): string[] => (Array.isArray(v) ? [...new Set(v.map((x) => String(x ?? '').trim().slice(0, len)).filter(Boolean))].slice(0, max) : []);
const int = (v: unknown, def: number, min: number, max: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function cleanHours(v: unknown, current: BusinessHours): BusinessHours {
  const out = { ...current };
  const src = obj(v);
  for (const d of DAY_KEYS) {
    const h = obj(src[d]);
    if (!Object.keys(h).length) continue;
    const from = String(h.from ?? current[d].from);
    const to = String(h.to ?? current[d].to);
    if (!HM.test(from) || !HM.test(to)) throw bad('Geschäftszeiten: Uhrzeiten als HH:MM angeben');
    out[d] = { open: h.open === true || h.open === 'true', from, to };
  }
  return out;
}

/** Stored settings (possibly from an older version or hand-edited) with every missing value filled in. */
export function withDefaults(stored: unknown): InboxSettings {
  const d = defaultSettings();
  const s = obj(stored);
  const a = obj(s.assignment);
  const sl = obj(s.sla);
  const n = obj(s.notifications);
  return {
    assignment: {
      mode: ['manual', 'round_robin', 'least_busy'].includes(a.mode) ? a.mode : d.assignment.mode,
      pool: ['all', 'team', 'users'].includes(a.pool) ? a.pool : d.assignment.pool,
      team_id: String(a.team_id ?? ''),
      user_ids: strList(a.user_ids, 200, 64),
      respect_availability: a.respect_availability !== false,
      prefer_contact_owner: a.prefer_contact_owner !== false,
      reassign_when_away: a.reassign_when_away !== false,
      assign_on_reply: a.assign_on_reply !== false,
      rules: (Array.isArray(a.rules) ? a.rules : []).slice(0, 50).map(cleanRuleLoose).filter((r): r is AssignRule => !!r),
    },
    sla: {
      enabled: sl.enabled === true,
      first_response_min: int(sl.first_response_min, d.sla.first_response_min, 1, 60 * 24 * 30),
      next_response_min: int(sl.next_response_min, d.sla.next_response_min, 1, 60 * 24 * 30),
      warn_percent: int(sl.warn_percent, d.sla.warn_percent, 1, 99),
      business_hours: sl.business_hours !== false,
      notify_assignee: sl.notify_assignee !== false,
      notify_email: sl.notify_email === true,
    },
    business_hours: cleanHoursLoose(s.business_hours, d.business_hours),
    holidays: strList(s.holidays, 200, 10).filter((x) => YMD.test(x)).sort(),
    auto_close_days: int(s.auto_close_days, 0, 0, 365),
    reply_sets_waiting: s.reply_sets_waiting === true,
    notifications: { assign_push: n.assign_push !== false, assign_email: n.assign_email === true, mention_email: n.mention_email !== false },
  };
}

function cleanHoursLoose(v: unknown, d: BusinessHours): BusinessHours {
  try {
    return cleanHours(v, d);
  } catch {
    return d;
  }
}

function cleanRuleLoose(r: unknown): AssignRule | null {
  try {
    return cleanRule(r);
  } catch {
    return null;
  }
}

export function cleanRule(v: unknown): AssignRule {
  const r = obj(v);
  const t = obj(r.target);
  const type = ['user', 'team', 'pool'].includes(t.type) ? (t.type as AssignTarget['type']) : 'pool';
  const target = { type, id: type === 'pool' ? '' : String(t.id ?? '').slice(0, 64) };
  if (type !== 'pool' && !target.id) throw bad('Regel: Ziel (Person oder Team) fehlt');
  return {
    id: /^[A-Za-z0-9_-]{4,40}$/.test(String(r.id ?? '')) ? String(r.id) : newId(10),
    name: String(r.name ?? '').trim().slice(0, 80) || 'Regel',
    enabled: r.enabled !== false,
    channels: strList(r.channels, 20, 20).map((c) => c.toLowerCase()),
    tags: strList(r.tags, 20, 60),
    target,
    priority: isPriority(r.priority) ? r.priority : '',
  };
}

/** Validates a settings update (PUT /api/inbox/settings) against the current values and returns the new ones. */
export function cleanSettings(body: unknown, current: InboxSettings): InboxSettings {
  const b = obj(body);
  const out: InboxSettings = JSON.parse(JSON.stringify(current));
  if (b.assignment !== undefined) {
    const a = obj(b.assignment);
    if (a.mode !== undefined) {
      if (!['manual', 'round_robin', 'least_busy'].includes(a.mode)) throw bad('Zuweisung: unbekannter Modus');
      out.assignment.mode = a.mode;
    }
    if (a.pool !== undefined) {
      if (!['all', 'team', 'users'].includes(a.pool)) throw bad('Zuweisung: unbekannter Personenkreis');
      out.assignment.pool = a.pool;
    }
    if (a.team_id !== undefined) out.assignment.team_id = String(a.team_id ?? '').slice(0, 64);
    if (a.user_ids !== undefined) {
      if (!Array.isArray(a.user_ids)) throw bad('Zuweisung: Personen als Liste');
      out.assignment.user_ids = strList(a.user_ids, 200, 64);
    }
    for (const k of ['respect_availability', 'prefer_contact_owner', 'reassign_when_away', 'assign_on_reply'] as const) if (a[k] !== undefined) out.assignment[k] = a[k] === true || a[k] === 'true';
    if (a.rules !== undefined) {
      if (!Array.isArray(a.rules)) throw bad('Regeln als Liste');
      if (a.rules.length > 50) throw bad('Höchstens 50 Regeln');
      out.assignment.rules = a.rules.map(cleanRule);
    }
  }
  if (b.sla !== undefined) {
    const s = obj(b.sla);
    if (s.enabled !== undefined) out.sla.enabled = s.enabled === true || s.enabled === 'true';
    if (s.first_response_min !== undefined) out.sla.first_response_min = int(s.first_response_min, out.sla.first_response_min, 1, 60 * 24 * 30);
    if (s.next_response_min !== undefined) out.sla.next_response_min = int(s.next_response_min, out.sla.next_response_min, 1, 60 * 24 * 30);
    if (s.warn_percent !== undefined) out.sla.warn_percent = int(s.warn_percent, out.sla.warn_percent, 1, 99);
    for (const k of ['business_hours', 'notify_assignee', 'notify_email'] as const) if (s[k] !== undefined) out.sla[k] = s[k] === true || s[k] === 'true';
  }
  if (b.business_hours !== undefined) out.business_hours = cleanHours(b.business_hours, out.business_hours);
  if (b.holidays !== undefined) {
    if (!Array.isArray(b.holidays)) throw bad('Feiertage als Liste (JJJJ-MM-TT)');
    const days = strList(b.holidays, 200, 10);
    if (days.some((x) => !YMD.test(x))) throw bad('Feiertage: Format JJJJ-MM-TT');
    out.holidays = days.sort();
  }
  if (b.auto_close_days !== undefined) out.auto_close_days = int(b.auto_close_days, 0, 0, 365);
  if (b.reply_sets_waiting !== undefined) out.reply_sets_waiting = b.reply_sets_waiting === true || b.reply_sets_waiting === 'true';
  if (b.notifications !== undefined) {
    const n = obj(b.notifications);
    for (const k of ['assign_push', 'assign_email', 'mention_email'] as const) if (n[k] !== undefined) out.notifications[k] = n[k] === true || n[k] === 'true';
  }
  return out;
}

/** Business-hours calendar of the inbox (own hours and holidays; the zone is the sub-account's). */
export function calendarOf(s: InboxSettings, tz: string): WorkCalendar {
  return { hours: s.business_hours, tz: isValidTz(tz) ? tz : 'Europe/Berlin', holidays: s.holidays };
}

// --- SLA deadlines -----------------------------------------------------------------------------

/** When the answer to a message received at `from` is due, and when the warning starts; null without an SLA. */
export function responseDeadline(s: InboxSettings, kind: 'first' | 'next', from: Date, cal: WorkCalendar): { due: string; warn: string } | null {
  if (!s.sla.enabled) return null;
  const min = kind === 'first' ? s.sla.first_response_min : s.sla.next_response_min;
  const d = slaDeadlines(from, { first_response_min: min, resolution_min: 0, business_hours: s.sla.business_hours }, cal, s.sla.warn_percent);
  return d.first_response_due_at && d.first_response_warn_at ? { due: d.first_response_due_at, warn: d.first_response_warn_at } : null;
}

export type SlaState = '' | 'ok' | 'warning' | 'breached';

/** State of the running answer timer of a conversation row. */
export function slaStateOf(row: { awaiting_since?: string | null; response_due_at?: string | null; response_warn_at?: string | null; inbox_status?: string; snoozed_until?: string | null }, at = new Date()): SlaState {
  if (!row.awaiting_since || !row.response_due_at || row.inbox_status === 'closed') return '';
  const t = at.getTime();
  if (row.snoozed_until && Date.parse(row.snoozed_until) > t) return 'ok';
  if (t >= Date.parse(row.response_due_at)) return 'breached';
  if (row.response_warn_at && t >= Date.parse(row.response_warn_at)) return 'warning';
  return 'ok';
}

// --- mentions ----------------------------------------------------------------------------------

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface Person {
  id: string;
  name: string;
}

/**
 * Mentions of a note: "[@Name](user:ID)" from the picker, and plain "@Name" (the whole name, or a first name that is
 * unique in the team) which is turned into the linked form. Only people of the sub-account count.
 */
export function resolveMentions(body: string, people: Person[], authorId?: string | null): { body: string; ids: string[] } {
  const byId = new Map(people.map((p) => [p.id, p.name]));
  const ids = new Set<string>();
  const names = new Map<string, string>();
  const firsts = new Map<string, string | null>();
  for (const p of people) {
    if (!p.name) continue;
    names.set(p.name.toLowerCase(), p.id);
    const first = p.name.split(/\s+/)[0]?.toLowerCase();
    if (first && p.name.includes(' ')) firsts.set(first, firsts.has(first) ? null : p.id);
  }
  for (const [f, uid] of firsts) if (uid && !names.has(f)) names.set(f, uid);
  let text = String(body ?? '');
  // The picker's linked form first (only for people of this sub-account; anything else becomes its plain label).
  text = text.replace(/\[@?([^\]\n]{0,200})\]\(user:([A-Za-z0-9_-]{1,64})\)/g, (m, label: string, uid: string) => {
    if (!byId.has(uid)) return `@${label.replace(/^@/, '')}`;
    ids.add(uid);
    return m;
  });
  const keys = [...names.keys()].sort((a, b) => b.length - a.length).slice(0, 400);
  if (keys.length) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}\\[@(])@(${keys.map(escRe).join('|')})(?![\\p{L}\\p{N}])`, 'giu');
    // Skip links already in linked form: split on them and rewrite the rest.
    text = text
      .split(/(\[@?[^\]\n]{0,200}\]\(user:[A-Za-z0-9_-]{1,64}\))/g)
      .map((part, i) =>
        i % 2
          ? part
          : part.replace(re, (m, pre: string, who: string) => {
              const uid = names.get(who.toLowerCase());
              if (!uid) return m;
              ids.add(uid);
              return `${pre}[@${byId.get(uid)}](user:${uid})`;
            }),
      )
      .join('');
  }
  return { body: text, ids: [...ids].filter((u) => u !== authorId) };
}

/** A note as plain text (links turned into "@Name"), for push and e-mail. */
export const plainNote = (body: string) => String(body ?? '').replace(/\[(@?[^\]\n]*)\]\(user:[^)]*\)/g, (_m, l: string) => (l.startsWith('@') ? l : `@${l}`));

// --- views (SQL on the alias `v` of conversations) -----------------------------------------------

export interface ViewSql {
  sql: string;
  params: (string | number)[];
}

/**
 * The WHERE part of a view. `at` is "now" as an ISO string: a conversation whose snooze has run out counts as awake even
 * before the scheduler tick has cleared the mark.
 */
export function viewSql(view: InboxView, userId: string | undefined, at: string): ViewSql | null {
  const awake = `v.inbox_status != 'closed' AND (v.snoozed_until IS NULL OR v.snoozed_until <= ?)`;
  switch (view) {
    case 'open':
      return { sql: awake, params: [at] };
    case 'mine':
      return userId ? { sql: `v.assignee_id = ? AND ${awake}`, params: [userId, at] } : { sql: '0', params: [] };
    case 'unassigned':
      return { sql: `v.assignee_id IS NULL AND ${awake}`, params: [at] };
    case 'team':
      return { sql: `(v.assignee_id IS NOT NULL OR v.team_id IS NOT NULL) AND ${awake}`, params: [at] };
    case 'waiting':
      return { sql: `v.inbox_status = 'waiting' AND (v.snoozed_until IS NULL OR v.snoozed_until <= ?)`, params: [at] };
    case 'done':
      return { sql: `v.inbox_status = 'closed'`, params: [] };
    case 'snoozed':
      return { sql: `v.inbox_status != 'closed' AND v.snoozed_until > ?`, params: [at] };
    case 'sla':
      return { sql: `v.inbox_status != 'closed' AND v.awaiting_since IS NOT NULL AND v.sla_state IN ('warning', 'breached') AND (v.snoozed_until IS NULL OR v.snoozed_until <= ?)`, params: [at] };
    case 'mentions':
      return userId
        ? { sql: `EXISTS (SELECT 1 FROM inbox_timeline t WHERE t.conversation_id = v.id AND t.type = 'note' AND EXISTS (SELECT 1 FROM json_each(t.mentions) WHERE value = ?) AND NOT EXISTS (SELECT 1 FROM inbox_mention_seen s WHERE s.note_id = t.id AND s.user_id = ?))`, params: [userId, userId] }
        : { sql: '0', params: [] };
    default:
      return null;
  }
}

/** The order of a view: SLA by urgency of the deadline, everything else newest message first (priority breaks ties on request). */
export function viewOrder(view: InboxView, byPriority = false): string {
  if (view === 'sla') return `COALESCE(v.response_due_at, '9999') ASC`;
  if (view === 'snoozed') return `v.snoozed_until ASC`;
  const prio = byPriority ? `CASE v.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, ` : '';
  return `${prio}v.last_message_at DESC`;
}

/** Is somebody away at `at`? A paused switch or one out-of-office entry is enough; working hours count only when given. */
export function isAwayAt(o: { paused?: boolean; away: { start_at: string; end_at: string }[]; hours?: Partial<Record<string, [string, string][]>> | null; tz?: string }, at: Date): boolean {
  if (o.paused) return true;
  const t = at.toISOString();
  if (o.away.some((a) => a.start_at <= t && a.end_at > t)) return true;
  if (o.hours && Object.keys(o.hours).length) {
    const tz = isValidTz(o.tz ?? '') ? o.tz! : 'Europe/Berlin';
    const windows = o.hours[weekdayKey(ymdInTz(at, tz))] ?? [];
    const hm = hmInTz(at, tz);
    return !windows.some(([from, to]) => hm >= from && hm < to);
  }
  return false;
}

/** The next person in `members` after `last` for whom `ok` holds (round robin); null when nobody qualifies. */
export function nextAvailable(members: string[], last: string | null | undefined, ok: (id: string) => boolean): string | null {
  if (!members.length) return null;
  const start = last ? members.indexOf(last) : -1;
  for (let i = 1; i <= members.length; i++) {
    const m = members[(start + i + members.length) % members.length];
    if (ok(m)) return m;
  }
  return null;
}
