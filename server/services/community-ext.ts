import type { App } from '../core/app.js';
import { bad } from '../core/http.js';
import { ymdInTz } from '../core/time.js';
import { now } from '../core/util.js';

/**
 * Settings and small per-member data of the community extensions (everything beyond the first community version):
 * per-group settings (messages, directory, map, points, welcome, live calls …), roles (admins and moderators among the
 * members), online presence, active days (for "daily active members"), profile extras (city, links) and push preferences.
 * Rules only – the pages and routes live in modules/community-*.ts.
 */

// --- group settings ---------------------------------------------------------------------------------

export interface ChecklistItem {
  id: string;
  label: string;
  /** Checked automatically for these kinds; `custom` is ticked by the member. */
  kind: 'profile' | 'intro' | 'post' | 'comment' | 'like' | 'challenge' | 'start_here' | 'custom';
  href?: string;
}

export interface ExtSettings {
  dms: { enabled: boolean; per_hour: number; new_per_day: number };
  directory: { enabled: boolean };
  map: { enabled: boolean };
  online: { enabled: boolean };
  points: { course: number; event: number; challenge_checkin: number; challenge_complete: number };
  leaderboard: { reset: 'none' | 'monthly' };
  start_here: { post_id: string; label: string };
  welcome: {
    dm: { enabled: boolean; sender: string; text: string };
    post: { enabled: boolean; channel_id: string; title: string; body: string };
    checklist: { enabled: boolean; days: number; items: ChecklistItem[] };
  };
  live: { jitsi_url: string };
  affiliate: { program_id: string };
  video: { upload: boolean };
}

export const DEFAULT_CHECKLIST: ChecklistItem[] = [
  { id: 'profile', label: 'Profil ausfüllen: Foto und ein paar Sätze über dich', kind: 'profile' },
  { id: 'intro', label: 'Dich der Gruppe vorstellen', kind: 'intro' },
  { id: 'comment', label: 'Einen Beitrag kommentieren', kind: 'comment' },
  { id: 'like', label: 'Einem Beitrag ein „Gefällt mir“ geben', kind: 'like' },
];

export const DEFAULT_EXT: ExtSettings = {
  dms: { enabled: true, per_hour: 30, new_per_day: 15 },
  directory: { enabled: true },
  map: { enabled: false },
  online: { enabled: true },
  points: { course: 10, event: 5, challenge_checkin: 2, challenge_complete: 20 },
  leaderboard: { reset: 'none' },
  start_here: { post_id: '', label: 'Hier starten' },
  welcome: {
    dm: { enabled: false, sender: '', text: 'Hallo {{name}}, schön, dass du da bist! Stell dich gern kurz in der Vorstellungsrunde vor – wir freuen uns auf dich.' },
    post: { enabled: false, channel_id: '', title: 'Willkommen, {{name}}!', body: 'Schön, dass du dabei bist, {{name}}! Sag kurz Hallo und erzähl uns, was dich hierher gebracht hat.' },
    checklist: { enabled: true, days: 30, items: DEFAULT_CHECKLIST },
  },
  live: { jitsi_url: '' },
  affiliate: { program_id: '' },
  video: { upload: true },
};

const int = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
};
const bool = (v: unknown, fallback: boolean) => (v === undefined || v === null ? fallback : v === true || v === 1 || v === '1' || v === 'true');
const text = (v: unknown, max: number, fallback = '') => (v === undefined || v === null ? fallback : String(v).replace(/\r\n?/g, '\n').trim().slice(0, max));

/** https:// address of a Jitsi server (no path, no credentials), or '' for the public one. */
export function cleanJitsiUrl(v: unknown): string {
  const s = String(v ?? '').trim().replace(/\/+$/, '');
  if (!s) return '';
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw bad('Jitsi-Adresse: bitte mit https:// angeben, z. B. https://meet.example.com');
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) throw bad('Jitsi-Adresse: nur https://server (ohne Pfad)');
  return u.origin;
}

const KINDS: ChecklistItem['kind'][] = ['profile', 'intro', 'post', 'comment', 'like', 'challenge', 'start_here', 'custom'];

export function cleanChecklist(v: unknown, fallback: ChecklistItem[]): ChecklistItem[] {
  if (!Array.isArray(v)) return fallback;
  const seen = new Set<string>();
  const out: ChecklistItem[] = [];
  for (const raw of v.slice(0, 12)) {
    const label = text(raw?.label, 120);
    if (!label) continue;
    let id = String(raw?.id ?? '').replace(/[^a-z0-9_-]/gi, '').slice(0, 30) || `i${out.length + 1}`;
    while (seen.has(id)) id = `${id}x`;
    seen.add(id);
    const kind = KINDS.includes(raw?.kind) ? raw.kind : 'custom';
    const href = text(raw?.href, 300);
    out.push({ id, label, kind, ...(href && /^(https:\/\/|\/)[^\s]*$/.test(href) ? { href } : {}) });
  }
  return out;
}

/** Validates settings from the editor or the API; `cur` is the stored state (unknown keys are dropped). */
export function cleanExt(input: any, cur: Partial<ExtSettings> = {}): ExtSettings {
  const base = mergeExt(cur);
  const v = input && typeof input === 'object' ? input : {};
  const w = v.welcome ?? {};
  const bw = base.welcome;
  return {
    dms: { enabled: bool(v.dms?.enabled, base.dms.enabled), per_hour: int(v.dms?.per_hour, 1, 600, base.dms.per_hour), new_per_day: int(v.dms?.new_per_day, 1, 500, base.dms.new_per_day) },
    directory: { enabled: bool(v.directory?.enabled, base.directory.enabled) },
    map: { enabled: bool(v.map?.enabled, base.map.enabled) },
    online: { enabled: bool(v.online?.enabled, base.online.enabled) },
    points: {
      course: int(v.points?.course, 0, 1000, base.points.course),
      event: int(v.points?.event, 0, 1000, base.points.event),
      challenge_checkin: int(v.points?.challenge_checkin, 0, 1000, base.points.challenge_checkin),
      challenge_complete: int(v.points?.challenge_complete, 0, 10_000, base.points.challenge_complete),
    },
    leaderboard: { reset: v.leaderboard?.reset === 'monthly' ? 'monthly' : v.leaderboard?.reset === 'none' ? 'none' : base.leaderboard.reset },
    start_here: { post_id: text(v.start_here?.post_id, 40, base.start_here.post_id), label: text(v.start_here?.label, 40, base.start_here.label) || 'Hier starten' },
    welcome: {
      dm: { enabled: bool(w.dm?.enabled, bw.dm.enabled), sender: text(w.dm?.sender, 60, bw.dm.sender), text: text(w.dm?.text, 2000, bw.dm.text) },
      post: { enabled: bool(w.post?.enabled, bw.post.enabled), channel_id: text(w.post?.channel_id, 40, bw.post.channel_id), title: text(w.post?.title, 200, bw.post.title), body: text(w.post?.body, 5000, bw.post.body) },
      checklist: { enabled: bool(w.checklist?.enabled, bw.checklist.enabled), days: int(w.checklist?.days, 1, 365, bw.checklist.days), items: cleanChecklist(w.checklist?.items, bw.checklist.items) },
    },
    live: { jitsi_url: v.live?.jitsi_url === undefined ? base.live.jitsi_url : cleanJitsiUrl(v.live.jitsi_url) },
    affiliate: { program_id: text(v.affiliate?.program_id, 40, base.affiliate.program_id) },
    video: { upload: bool(v.video?.upload, base.video.upload) },
  };
}

/** Stored (possibly partial or older) settings on top of the defaults. */
export function mergeExt(cur: any): ExtSettings {
  const c = cur && typeof cur === 'object' ? cur : {};
  const d = DEFAULT_EXT;
  return {
    dms: { ...d.dms, ...(c.dms ?? {}) },
    directory: { ...d.directory, ...(c.directory ?? {}) },
    map: { ...d.map, ...(c.map ?? {}) },
    online: { ...d.online, ...(c.online ?? {}) },
    points: { ...d.points, ...(c.points ?? {}) },
    leaderboard: { ...d.leaderboard, ...(c.leaderboard ?? {}) },
    start_here: { ...d.start_here, ...(c.start_here ?? {}) },
    welcome: {
      dm: { ...d.welcome.dm, ...(c.welcome?.dm ?? {}) },
      post: { ...d.welcome.post, ...(c.welcome?.post ?? {}) },
      checklist: { ...d.welcome.checklist, ...(c.welcome?.checklist ?? {}), items: Array.isArray(c.welcome?.checklist?.items) ? c.welcome.checklist.items : d.welcome.checklist.items },
    },
    live: { ...d.live, ...(c.live ?? {}) },
    affiliate: { ...d.affiliate, ...(c.affiliate ?? {}) },
    video: { ...d.video, ...(c.video ?? {}) },
  };
}

export function extOf(app: App, groupId: string): ExtSettings {
  const row = app.db.get<{ settings: string }>('SELECT settings FROM community_ext WHERE group_id = ?', groupId);
  let parsed: unknown = {};
  try {
    parsed = row ? JSON.parse(row.settings) : {};
  } catch {
    parsed = {};
  }
  return mergeExt(parsed);
}

export function saveExt(app: App, g: { id: string; location_id: string }, settings: ExtSettings) {
  app.db.run(
    'INSERT INTO community_ext (group_id, location_id, settings, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(group_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at',
    g.id,
    g.location_id,
    JSON.stringify(settings),
    now(),
  );
}

// --- roles: admins and moderators among the members -----------------------------------------------------

export type Role = 'admin' | 'moderator';

export function roleOf(app: App, groupId: string, contactId: string): Role | null {
  const r = app.db.get<{ role: Role }>('SELECT role FROM community_roles WHERE group_id = ? AND contact_id = ?', groupId, contactId);
  return r?.role ?? null;
}

export const isStaffRole = (role: Role | null): role is Role => role === 'admin' || role === 'moderator';

export function staffOf(app: App, groupId: string) {
  return app.db.all<{ contact_id: string; role: Role; created_at: string; granted_by: string }>('SELECT contact_id, role, created_at, granted_by FROM community_roles WHERE group_id = ? ORDER BY role, created_at', groupId);
}

/** What a role may do in the portal. Admins can do everything moderators can. */
export const CAN = {
  /** Hide, show and delete other people's posts and comments; settle reports; pin posts. */
  moderate: (r: Role | null) => r === 'admin' || r === 'moderator',
  /** Write in team-only channels, post as team, answer join requests, ban members. */
  admin: (r: Role | null) => r === 'admin',
  /** Write in team-only channels. */
  writeAnnouncements: (r: Role | null) => r === 'admin' || r === 'moderator',
};

// --- presence and active days ---------------------------------------------------------------------------------

export const ONLINE_WINDOW_MS = 3 * 60_000;
const touched = new Map<string, number>();

/** Remembers that the member is looking at the community right now (at most one write every 45 s). */
export function touchPresence(app: App, locationId: string, contactId: string, at = Date.now()) {
  const key = `${locationId}:${contactId}`;
  if (at - (touched.get(key) ?? 0) < 45_000) return;
  touched.set(key, at);
  if (touched.size > 50_000) touched.clear();
  app.db.run(
    'INSERT INTO community_presence (location_id, contact_id, last_seen_at) VALUES (?, ?, ?) ON CONFLICT(location_id, contact_id) DO UPDATE SET last_seen_at = excluded.last_seen_at',
    locationId,
    contactId,
    new Date(at).toISOString(),
  );
}

/** Who of these members was active in the last minutes (and has not hidden it in the profile). */
export function onlineIds(app: App, locationId: string, contactIds: string[], at = Date.now()): Set<string> {
  if (!contactIds.length) return new Set();
  const since = new Date(at - ONLINE_WINDOW_MS).toISOString();
  const rows = app.db.all<{ contact_id: string }>(
    `SELECT p.contact_id FROM community_presence p LEFT JOIN community_profile_ext e ON e.location_id = p.location_id AND e.contact_id = p.contact_id
     WHERE p.location_id = ? AND p.last_seen_at >= ? AND COALESCE(e.show_online, 1) = 1 AND p.contact_id IN (${contactIds.map(() => '?').join(',')})`,
    locationId,
    since,
    ...contactIds,
  );
  return new Set(rows.map((r) => r.contact_id));
}

export function onlineCount(app: App, g: { id: string; location_id: string }, at = Date.now()): number {
  const since = new Date(at - ONLINE_WINDOW_MS).toISOString();
  return app.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM community_presence p JOIN community_members m ON m.group_id = ? AND m.contact_id = p.contact_id AND m.banned_at IS NULL
     LEFT JOIN community_profile_ext e ON e.location_id = p.location_id AND e.contact_id = p.contact_id
     WHERE p.location_id = ? AND p.last_seen_at >= ? AND COALESCE(e.show_online, 1) = 1`,
    g.id,
    g.location_id,
    since,
  )!.n;
}

const dayTouched = new Set<string>();

/** One row per member and day they used the community (daily active members in the analytics). */
export function touchActive(app: App, g: { id: string; location_id: string }, contactId: string, at = new Date()) {
  const tz = app.location(g.location_id)?.timezone || 'Europe/Berlin';
  const day = ymdInTz(at, tz);
  const key = `${g.id}:${contactId}:${day}`;
  if (dayTouched.has(key)) return;
  dayTouched.add(key);
  if (dayTouched.size > 100_000) dayTouched.clear();
  app.db.run('INSERT OR IGNORE INTO community_active_days (group_id, contact_id, day) VALUES (?, ?, ?)', g.id, contactId, day);
}

// --- profile extras ---------------------------------------------------------------------------------------------------

export interface ProfileExt {
  headline: string;
  city: string;
  country: string;
  links: { label: string; url: string }[];
  show_on_map: boolean;
  show_online: boolean;
  show_activity: boolean;
}

export const EMPTY_PROFILE_EXT: ProfileExt = { headline: '', city: '', country: '', links: [], show_on_map: false, show_online: true, show_activity: true };

export function profileExt(app: App, locationId: string, contactId: string): ProfileExt {
  const r = app.db.get<any>('SELECT * FROM community_profile_ext WHERE location_id = ? AND contact_id = ?', locationId, contactId);
  if (!r) return { ...EMPTY_PROFILE_EXT };
  let links: { label: string; url: string }[] = [];
  try {
    links = JSON.parse(r.links || '[]');
  } catch {
    links = [];
  }
  return { headline: r.headline, city: r.city, country: r.country, links, show_on_map: !!r.show_on_map, show_online: !!r.show_online, show_activity: !!r.show_activity };
}

export function cleanLinks(v: unknown): { label: string; url: string }[] {
  if (!Array.isArray(v)) return [];
  const out: { label: string; url: string }[] = [];
  for (const raw of v.slice(0, 5)) {
    const url = String(raw?.url ?? '').trim();
    if (!url) continue;
    let u: URL;
    try {
      u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`);
    } catch {
      throw bad(`Link „${url.slice(0, 40)}“ ist keine gültige Adresse`);
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad('Links müssen mit https:// beginnen');
    if (u.username || u.password) throw bad('Links ohne Zugangsdaten bitte');
    out.push({ label: text(raw?.label, 40) || u.hostname.replace(/^www\./, ''), url: u.href.slice(0, 300) });
  }
  return out;
}

export function saveProfileExt(app: App, locationId: string, contactId: string, input: Partial<Record<keyof ProfileExt, unknown>>): ProfileExt {
  const cur = profileExt(app, locationId, contactId);
  const next: ProfileExt = {
    headline: input.headline === undefined ? cur.headline : text(input.headline, 80),
    city: input.city === undefined ? cur.city : text(input.city, 80),
    country: input.country === undefined ? cur.country : text(input.country, 60),
    links: input.links === undefined ? cur.links : cleanLinks(input.links),
    show_on_map: input.show_on_map === undefined ? cur.show_on_map : bool(input.show_on_map, false),
    show_online: input.show_online === undefined ? cur.show_online : bool(input.show_online, true),
    show_activity: input.show_activity === undefined ? cur.show_activity : bool(input.show_activity, true),
  };
  if (/[<>]/.test(`${next.headline}${next.city}${next.country}`)) throw bad('Bitte ohne < und > schreiben');
  app.db.run(
    `INSERT INTO community_profile_ext (location_id, contact_id, headline, city, country, links, show_on_map, show_online, show_activity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(location_id, contact_id) DO UPDATE SET headline = excluded.headline, city = excluded.city, country = excluded.country, links = excluded.links,
       show_on_map = excluded.show_on_map, show_online = excluded.show_online, show_activity = excluded.show_activity`,
    locationId,
    contactId,
    next.headline,
    next.city,
    next.country,
    JSON.stringify(next.links),
    next.show_on_map ? 1 : 0,
    next.show_online ? 1 : 0,
    next.show_activity ? 1 : 0,
  );
  return next;
}

// --- push preferences --------------------------------------------------------------------------------------------------

export interface PushPrefs {
  dms: boolean;
  mentions: boolean;
  replies: boolean;
  posts: boolean;
  announcements: boolean;
}
export const DEFAULT_PUSH_PREFS: PushPrefs = { dms: true, mentions: true, replies: true, posts: false, announcements: true };

export function pushPrefs(app: App, locationId: string, contactId: string): PushPrefs {
  const r = app.db.get<any>('SELECT * FROM community_push_prefs WHERE location_id = ? AND contact_id = ?', locationId, contactId);
  return r ? { dms: !!r.dms, mentions: !!r.mentions, replies: !!r.replies, posts: !!r.posts, announcements: !!r.announcements } : { ...DEFAULT_PUSH_PREFS };
}

export function savePushPrefs(app: App, locationId: string, contactId: string, input: Partial<Record<keyof PushPrefs, unknown>>): PushPrefs {
  const cur = pushPrefs(app, locationId, contactId);
  const next: PushPrefs = {
    dms: bool(input.dms, cur.dms),
    mentions: bool(input.mentions, cur.mentions),
    replies: bool(input.replies, cur.replies),
    posts: bool(input.posts, cur.posts),
    announcements: bool(input.announcements, cur.announcements),
  };
  app.db.run(
    `INSERT INTO community_push_prefs (location_id, contact_id, dms, mentions, replies, posts, announcements) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(location_id, contact_id) DO UPDATE SET dms = excluded.dms, mentions = excluded.mentions, replies = excluded.replies, posts = excluded.posts, announcements = excluded.announcements`,
    locationId,
    contactId,
    next.dms ? 1 : 0,
    next.mentions ? 1 : 0,
    next.replies ? 1 : 0,
    next.posts ? 1 : 0,
    next.announcements ? 1 : 0,
  );
  return next;
}
