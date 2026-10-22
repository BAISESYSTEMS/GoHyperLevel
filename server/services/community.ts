import type { App } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { ymdInTz, zonedToUtc } from '../core/time.js';
import type { Contact } from './contacts.js';

/**
 * Community (groups in the member portal): the rules shared by the admin module (community.ts),
 * the member pages (community-portal.ts) and tests – who may see a group, points and levels,
 * the word filter, mentions and image checks. Everything here is pure or read-only.
 */

export const ACCESS_MODES = ['all', 'courses', 'tags', 'join'] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

export interface GroupAccess {
  /** all = everyone who can log in to the member area; courses = members of these courses; tags = contacts with one of these tags;
   * join = people who joined through the community's public page (free, paid or by invitation – a membership that grants access). */
  mode: AccessMode;
  course_ids: string[];
  tags: string[];
}

export interface Level {
  name: string;
  points: number;
}

export interface GroupSettings {
  word_filter: string[];
  /** mask = replace with ***, block = refuse the post. */
  filter_mode: 'mask' | 'block';
  posts_per_hour: number;
  comments_per_hour: number;
  /** Hide a post or comment automatically after this many reports (0 = never). */
  auto_hide_reports: number;
  points: { post: number; comment: number; like: number };
  levels: Level[];
  /** Reaching a level unlocks a course (optional). */
  level_unlocks: { level: number; course_id: string }[];
}

/** Like Skool: level 1 at 0 points, then ever larger steps. */
export const DEFAULT_LEVEL_POINTS = [0, 5, 20, 65, 155, 515, 2015, 8015, 33015];
export const DEFAULT_LEVELS: Level[] = DEFAULT_LEVEL_POINTS.map((points, i) => ({ name: `Level ${i + 1}`, points }));
export const DEFAULT_SETTINGS: GroupSettings = {
  word_filter: [],
  filter_mode: 'mask',
  posts_per_hour: 5,
  comments_per_hour: 30,
  auto_hide_reports: 3,
  points: { post: 2, comment: 1, like: 1 },
  levels: DEFAULT_LEVELS,
  level_unlocks: [],
};

const list = (x: unknown, max = 100, len = 80) => (Array.isArray(x) ? [...new Set(x.map((t) => String(t).trim().slice(0, len)).filter(Boolean))].slice(0, max) : []);
const int = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
};

export function cleanGroupAccess(input: any, cur: Partial<GroupAccess> = {}): GroupAccess {
  const v = { ...cur, ...(input ?? {}) };
  const mode: AccessMode = ACCESS_MODES.includes(v.mode) ? v.mode : 'all';
  return { mode, course_ids: list(v.course_ids, 50), tags: list(v.tags, 50) };
}

export function cleanGroupSettings(input: any, cur: Partial<GroupSettings> = {}): GroupSettings {
  const base = { ...DEFAULT_SETTINGS, ...cur };
  const v = { ...base, ...(input ?? {}) };
  const pts = { ...DEFAULT_SETTINGS.points, ...base.points, ...(v.points ?? {}) };
  let levels: Level[] = Array.isArray(v.levels) && v.levels.length ? v.levels : base.levels;
  levels = levels.slice(0, 12).map((l: any, i: number) => ({ name: String(l?.name ?? '').trim().slice(0, 40) || `Level ${i + 1}`, points: i === 0 ? 0 : int(l?.points, 1, 10_000_000, 0) }));
  for (let i = 1; i < levels.length; i++) if (levels[i].points <= levels[i - 1].points) throw new Error(`Level ${i + 1} braucht mehr Punkte als Level ${i}`);
  return {
    word_filter: list(v.word_filter, 300, 60).map((w) => w.toLowerCase()),
    filter_mode: v.filter_mode === 'block' ? 'block' : 'mask',
    posts_per_hour: int(v.posts_per_hour, 0, 1000, DEFAULT_SETTINGS.posts_per_hour),
    comments_per_hour: int(v.comments_per_hour, 0, 5000, DEFAULT_SETTINGS.comments_per_hour),
    auto_hide_reports: int(v.auto_hide_reports, 0, 100, DEFAULT_SETTINGS.auto_hide_reports),
    points: { post: int(pts.post, 0, 1000, 2), comment: int(pts.comment, 0, 1000, 1), like: int(pts.like, 0, 1000, 1) },
    levels,
    level_unlocks: (Array.isArray(v.level_unlocks) ? v.level_unlocks : [])
      .map((u: any) => ({ level: int(u?.level, 1, levels.length, 0), course_id: String(u?.course_id ?? '').trim() }))
      .filter((u: { level: number; course_id: string }) => u.level > 0 && u.course_id)
      .slice(0, 20),
  };
}

/** 1-based level for a points total. */
export function levelFor(points: number, levels: Level[] = DEFAULT_LEVELS): number {
  let lvl = 1;
  levels.forEach((l, i) => {
    if (points >= l.points) lvl = i + 1;
  });
  return lvl;
}

/** Points still missing to the next level (null at the top). */
export function nextLevel(points: number, levels: Level[] = DEFAULT_LEVELS): { level: number; name: string; missing: number } | null {
  const cur = levelFor(points, levels);
  const next = levels[cur];
  return next ? { level: cur + 1, name: next.name, missing: next.points - points } : null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Bad-word filter: whole words, case-insensitive (also with umlauts); `wort*` matches every word
 * starting with "wort". Returns the (masked) text and how many hits there were.
 */
export function applyWordFilter(text: string, words: string[], mode: 'mask' | 'block' = 'mask'): { text: string; hits: number; blocked: boolean } {
  const terms = words.map((w) => w.trim()).filter(Boolean);
  if (!terms.length || !text) return { text, hits: 0, blocked: false };
  const alt = terms.map((w) => (w.endsWith('*') ? `${escapeRe(w.slice(0, -1))}[\\p{L}\\p{N}]*` : escapeRe(w))).join('|');
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt})(?![\\p{L}\\p{N}])`, 'giu');
  let hits = 0;
  const out = text.replace(re, (m) => {
    hits++;
    return m[0] + '*'.repeat(Math.max(m.length - 1, 2));
  });
  return { text: mode === 'block' ? text : out, hits, blocked: mode === 'block' && hits > 0 };
}

/** @handles written in a text (handles are lowercase a-z, 0-9 and dashes). */
export function mentionHandles(text: string): string[] {
  const out = new Set<string>();
  for (const m of String(text ?? '').matchAll(/(^|[^\w@/.-])@([a-z0-9][a-z0-9-]{1,39})/gi)) out.add(m[2].toLowerCase());
  return [...out];
}

/** Members can't embed outside images (tracking pixels); their ![x](url) turns into a plain link. */
export const stripMarkdownImages = (md: string) => String(md ?? '').replace(/!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (_m, alt, u) => `[${alt || 'Bild'}](${u})`);

/** "vor 5 Min." – short German relative time. */
export function relTime(iso: string | null | undefined, at = Date.now()): string {
  if (!iso) return '';
  const m = Math.round((at - Date.parse(iso)) / 60_000);
  if (m < 1) return 'gerade eben';
  if (m < 60) return `vor ${m} Min.`;
  const h = Math.round(m / 60);
  if (h < 24) return `vor ${h} Std.`;
  const d = Math.round(h / 24);
  if (d < 30) return `vor ${d} ${d === 1 ? 'Tag' : 'Tagen'}`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `vor ${mo} ${mo === 1 ? 'Monat' : 'Monaten'}`;
  const y = Math.round(mo / 12);
  return `vor ${y} ${y === 1 ? 'Jahr' : 'Jahren'}`;
}

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
export const MAX_POST_IMAGES = 4;

/** The real type of an image from its first bytes (null = not one we accept; no SVG). */
export function sniffImage(buf: Buffer): (typeof IMAGE_TYPES)[number] | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** A `data:image/…;base64,…` upload → bytes, checked for size and real type. Throws a German message. */
export function decodeImage(dataUrl: string, maxBytes = MAX_IMAGE_BYTES): { mime: string; buf: Buffer; ext: string } {
  const m = String(dataUrl ?? '').match(/^data:([\w/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!m) throw new Error('Bild konnte nicht gelesen werden');
  if (!(IMAGE_TYPES as readonly string[]).includes(m[1])) throw new Error('Nur Bilder als PNG, JPG, GIF oder WebP');
  // Rough size check before decoding (base64 is 4/3 of the bytes).
  if (m[2].length * 0.74 > maxBytes + 1024) throw new Error(`Bild größer als ${Math.round(maxBytes / 1024 / 1024)} MB`);
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > maxBytes) throw new Error(`Bild größer als ${Math.round(maxBytes / 1024 / 1024)} MB`);
  const real = sniffImage(buf);
  if (!real || real !== m[1]) throw new Error('Dateiinhalt passt nicht zum Bildtyp');
  return { mime: real, buf, ext: { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }[real] };
}

// --- access ---------------------------------------------------------------------------

export function getGroup(app: App, locationId: string, groupId: string) {
  return parseJson(app.db.get('SELECT * FROM community_groups WHERE id = ? AND location_id = ?', groupId, locationId), ['access', 'settings']);
}

export const groupSettings = (g: any): GroupSettings => cleanGroupSettings(g?.settings ?? {});

const hasActiveEnrollment = (app: App, contactId: string, courseIds?: string[]) =>
  !!app.db.get(
    `SELECT 1 FROM course_enrollments WHERE contact_id = ? AND status = 'active'${courseIds ? ` AND course_id IN (${courseIds.map(() => '?').join(',') || "''"})` : ''} LIMIT 1`,
    contactId,
    ...(courseIds ?? []),
  );

/**
 * Does a membership of the public join page let the person in? Active and trial memberships do; a past-due one only for
 * the tier's grace days; one that is set to end (cancel at period end) until then.
 */
export function membershipGrants(app: App, m: { status: string; past_due_at: string | null; tier_id: string | null; cancel_at?: string | null } | undefined, at = Date.now()): boolean {
  if (!m) return false;
  if (m.cancel_at && Date.parse(m.cancel_at) <= at) return false;
  if (m.status === 'active' || m.status === 'trialing') return true;
  if (m.status === 'past_due' && m.past_due_at && m.tier_id) {
    const grace = app.db.get<{ grace_days: number }>('SELECT grace_days FROM community_tiers WHERE id = ?', m.tier_id)?.grace_days ?? 0;
    return grace > 0 && Date.parse(m.past_due_at) + grace * 864e5 > at;
  }
  return false;
}

/** Does the contact get in through this group's rule (ignoring bans and "all")? */
function ruleGrants(app: App, g: any, contact: Pick<Contact, 'id' | 'tags'>): boolean {
  const a: GroupAccess = cleanGroupAccess(g.access);
  if (a.mode === 'tags') return a.tags.some((t) => (contact.tags ?? []).includes(t));
  if (a.mode === 'courses') return a.course_ids.length > 0 && hasActiveEnrollment(app, contact.id, a.course_ids);
  if (a.mode === 'join') return membershipGrants(app, app.db.get('SELECT status, past_due_at, tier_id, cancel_at FROM community_memberships WHERE group_id = ? AND contact_id = ?', g.id, contact.id));
  return false;
}

/**
 * May the contact log in to the member area at all? Course members, and everyone a group lets in
 * by course or tag. ("all" groups don't let anyone in by themselves.)
 */
export function isPortalMember(app: App, locationId: string, contact: Pick<Contact, 'id' | 'tags'>): boolean {
  if (hasActiveEnrollment(app, contact.id)) return true;
  const groups = app.db.all(`SELECT * FROM community_groups WHERE location_id = ? AND status = 'active'`, locationId).map((g) => parseJson(g, ['access']));
  return groups.some((g) => ruleGrants(app, g, contact));
}

export type AccessResult = 'ok' | 'banned' | 'none';

/** Who sees a group: its access rule, never when banned, never archived groups. */
export function groupAccess(app: App, g: any, contact: Pick<Contact, 'id' | 'tags'>): AccessResult {
  if (!g || g.status !== 'active') return 'none';
  const a: GroupAccess = cleanGroupAccess(g.access);
  const ok = a.mode === 'all' ? isPortalMember(app, g.location_id, contact) : ruleGrants(app, g, contact);
  if (!ok) return 'none';
  const m = app.db.get('SELECT banned_at FROM community_members WHERE group_id = ? AND contact_id = ?', g.id, contact.id);
  return m?.banned_at ? 'banned' : 'ok';
}

/** The groups a contact may open, in order. */
export function accessibleGroups(app: App, locationId: string, contact: Pick<Contact, 'id' | 'tags'>) {
  return app.db
    .all(`SELECT * FROM community_groups WHERE location_id = ? AND status = 'active' ORDER BY position, created_at`, locationId)
    .map((g) => parseJson(g, ['access', 'settings']))
    .filter((g) => groupAccess(app, g, contact) === 'ok');
}

/** Points in a group since a date (or all-time). */
export function memberPoints(app: App, groupId: string, contactId: string, since?: string): number {
  return app.db.get<{ n: number }>(`SELECT COALESCE(SUM(points), 0) AS n FROM community_points WHERE group_id = ? AND contact_id = ?${since ? ' AND created_at >= ?' : ''}`, groupId, contactId, ...(since ? [since] : []))!.n;
}

export const PERIODS = { week: 7, month: 30, all: 0 } as const;
export type Period = keyof typeof PERIODS;

/** Leaderboard of a group: 7 days, 30 days or all-time. */
export function leaderboard(app: App, groupId: string, period: Period = 'all', limit = 50, at = Date.now()) {
  const days = PERIODS[period] ?? 0;
  let since = days ? new Date(at - days * 864e5).toISOString() : '';
  if (period === 'month') {
    // With the monthly reset (group setting of the community extras) "month" is the calendar month, not the last 30 days.
    const g = app.db.get<{ location_id: string; reset: string | null }>(`SELECT g.location_id, json_extract(e.settings, '$.leaderboard.reset') AS reset FROM community_groups g LEFT JOIN community_ext e ON e.group_id = g.id WHERE g.id = ?`, groupId);
    if (g?.reset === 'monthly') {
      const tz = app.location(g.location_id)?.timezone || 'Europe/Berlin';
      since = zonedToUtc(`${ymdInTz(new Date(at), tz).slice(0, 7)}-01`, '00:00', tz).toISOString();
    }
  }
  return app.db.all<{ contact_id: string; points: number }>(
    `SELECT p.contact_id, SUM(p.points) AS points FROM community_points p
     JOIN community_members m ON m.group_id = p.group_id AND m.contact_id = p.contact_id AND m.banned_at IS NULL
     WHERE p.group_id = ?${since ? ' AND p.created_at >= ?' : ''} GROUP BY p.contact_id HAVING SUM(p.points) > 0 ORDER BY points DESC, MIN(p.created_at) LIMIT ?`,
    groupId,
    ...(since ? [since] : []),
    limit,
  );
}
