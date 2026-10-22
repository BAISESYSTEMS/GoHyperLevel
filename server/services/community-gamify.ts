import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, str, type RawResult } from '../core/http.js';
import { addDaysYmd, ymdInTz, zonedToUtc } from '../core/time.js';
import { now } from '../core/util.js';
import { logActivity } from './contacts.js';
import { groupSettings, leaderboard, memberPoints, type Level } from './community.js';
import { award, notify } from './community-actions.js';

/**
 * Gamification on top of points and levels: badges (by hand or by rule), perks that unlock with a level (coupon code, file, link,
 * text), channels that open at a level or in a tier, and the calendar-month leaderboard with its archive.
 */

// --- badges ---------------------------------------------------------------------------------------------------------------

export const RULE_LABELS = {
  manual: 'Nur von Hand vergeben',
  points: 'Punkte gesammelt',
  level: 'Level erreicht',
  posts: 'Beiträge geschrieben',
  comments: 'Kommentare geschrieben',
  likes: 'Likes erhalten',
  courses: 'Kurse abgeschlossen',
  events: 'Live-Calls besucht',
  challenges: 'Challenges abgeschlossen',
  days: 'Tage Mitglied',
  streak: 'Tage in Folge aktiv',
} as const;
export type RuleType = keyof typeof RULE_LABELS;

export interface BadgeRule {
  type: RuleType;
  value: number;
}

export interface Badge {
  id: string;
  location_id: string;
  group_id: string;
  name: string;
  description: string;
  emoji: string;
  color: string;
  rule: BadgeRule;
  points: number;
  position: number;
  created_at: string;
  updated_at: string;
}

const COLORS = /^#[0-9a-f]{6}$/i;

export function cleanBadge(input: any, cur: Partial<Badge> = {}) {
  const b = input ?? {};
  const out: Record<string, any> = {};
  if (b.name !== undefined || !cur.name) out.name = str(b.name, 'Name', { required: true, max: 60 });
  if (b.description !== undefined) out.description = str(b.description, 'Beschreibung', { max: 300 });
  if (b.emoji !== undefined) out.emoji = [...String(b.emoji ?? '').trim()].slice(0, 2).join('');
  if (b.color !== undefined) {
    const c = String(b.color ?? '').trim();
    if (c && !COLORS.test(c)) throw bad('Farbe: bitte als #rrggbb angeben');
    out.color = c;
  }
  if (b.points !== undefined) {
    const n = Math.round(Number(b.points));
    if (!Number.isFinite(n) || n < 0 || n > 1000) throw bad('Bonuspunkte: 0 bis 1000');
    out.points = n;
  }
  if (b.rule !== undefined) {
    const type = String(b.rule?.type ?? 'manual') as RuleType;
    if (!(type in RULE_LABELS)) throw bad(`Regel: ${Object.keys(RULE_LABELS).join(', ')}`);
    const value = Math.round(Number(b.rule?.value ?? 0));
    if (type !== 'manual' && (!Number.isFinite(value) || value < 1 || value > 1_000_000)) throw bad('Regel: der Wert muss mindestens 1 sein');
    out.rule = { type, value: type === 'manual' ? 0 : value };
  }
  return out;
}

export function badgesOf(app: App, groupId: string): Badge[] {
  return app.db.all<any>('SELECT * FROM community_badges WHERE group_id = ? ORDER BY position, created_at', groupId).map((r) => parseJson(r, ['rule']) as Badge);
}

export function badgeById(app: App, locationId: string, badgeId: string): Badge | undefined {
  const r = app.db.get<any>('SELECT * FROM community_badges WHERE id = ? AND location_id = ?', badgeId, locationId);
  return r ? (parseJson(r, ['rule']) as Badge) : undefined;
}

/** The number a rule counts for a member (before comparing it with the badge's value). */
export function statOf(app: App, g: { id: string; location_id: string }, contactId: string, type: RuleType): number {
  const n = (sql: string, ...p: any[]) => app.db.get<{ n: number }>(sql, ...p)?.n ?? 0;
  switch (type) {
    case 'points':
      return memberPoints(app, g.id, contactId);
    case 'level':
      return n('SELECT level AS n FROM community_members WHERE group_id = ? AND contact_id = ?', g.id, contactId);
    case 'posts':
      return n(`SELECT COUNT(*) AS n FROM community_posts WHERE group_id = ? AND contact_id = ? AND status = 'visible'`, g.id, contactId);
    case 'comments':
      return n(`SELECT COUNT(*) AS n FROM community_comments WHERE group_id = ? AND contact_id = ? AND status = 'visible'`, g.id, contactId);
    case 'likes':
      return n(`SELECT COALESCE((SELECT SUM(like_count) FROM community_posts WHERE group_id = ? AND contact_id = ?), 0) + COALESCE((SELECT SUM(like_count) FROM community_comments WHERE group_id = ? AND contact_id = ?), 0) AS n`, g.id, contactId, g.id, contactId);
    case 'courses':
      return n('SELECT COUNT(*) AS n FROM course_enrollments WHERE location_id = ? AND contact_id = ? AND completed_at IS NOT NULL', g.location_id, contactId);
    case 'events':
      return n('SELECT COUNT(*) AS n FROM community_event_attendance WHERE group_id = ? AND contact_id = ?', g.id, contactId);
    case 'challenges':
      return n('SELECT COUNT(*) AS n FROM community_challenge_members m JOIN community_challenges c ON c.id = m.challenge_id WHERE c.group_id = ? AND m.contact_id = ? AND m.completed_at IS NOT NULL', g.id, contactId);
    case 'days': {
      const j = app.db.get<{ joined_at: string }>('SELECT joined_at FROM community_members WHERE group_id = ? AND contact_id = ?', g.id, contactId)?.joined_at;
      return j ? Math.max(0, Math.floor((Date.now() - Date.parse(j)) / 864e5)) : 0;
    }
    case 'streak': {
      const tz = app.location(g.location_id)?.timezone || 'Europe/Berlin';
      const today = ymdInTz(new Date(), tz);
      const days = new Set(app.db.all<{ day: string }>('SELECT day FROM community_active_days WHERE group_id = ? AND contact_id = ? AND day >= ?', g.id, contactId, addDaysYmd(today, -400)).map((r) => r.day));
      let day = days.has(today) ? today : addDaysYmd(today, -1);
      let run = 0;
      while (days.has(day)) {
        run++;
        day = addDaysYmd(day, -1);
      }
      return run;
    }
    default:
      return 0;
  }
}

export interface Earned {
  badge: Badge;
  awarded_at: string;
  reason: string;
}

export function earnedBy(app: App, groupIds: string[], contactId: string): Earned[] {
  if (!groupIds.length) return [];
  return app.db
    .all<any>(
      `SELECT b.*, a.awarded_at, a.reason FROM community_badge_awards a JOIN community_badges b ON b.id = a.badge_id
       WHERE a.contact_id = ? AND b.group_id IN (${groupIds.map(() => '?').join(',')}) ORDER BY a.awarded_at DESC`,
      contactId,
      ...groupIds,
    )
    .map((r) => ({ badge: parseJson(r, ['rule']) as Badge, awarded_at: r.awarded_at, reason: r.reason }));
}

/** Gives a badge once. Notifies the member, logs it, pays the bonus points and starts workflows. */
export function awardBadge(app: App, g: any, contactId: string, badge: Badge, by = '', reason = ''): boolean {
  if (!app.db.get('SELECT 1 FROM community_members WHERE group_id = ? AND contact_id = ?', g.id, contactId)) throw new HttpError(409, 'Diese Person ist kein Mitglied der Gruppe');
  const r = app.db.run('INSERT OR IGNORE INTO community_badge_awards (badge_id, contact_id, location_id, group_id, awarded_at, awarded_by, reason) VALUES (?, ?, ?, ?, ?, ?, ?)', badge.id, contactId, g.location_id, g.id, now(), by, reason.slice(0, 300));
  if (!r.changes) return false;
  logActivity(app, g.location_id, contactId, 'community.badge', `Abzeichen „${badge.name}“ erhalten (${g.name})`);
  if (badge.points) award(app, g, contactId, badge.points, 'badge', badge.id);
  notify(app, g, [contactId], { kind: 'badge', text: `Neues Abzeichen: ${badge.emoji ? `${badge.emoji} ` : ''}${badge.name}` });
  app.events.emit(g.location_id, 'community.badge_earned', { contactId, groupId: g.id, group: { id: g.id, name: g.name }, badge: { id: badge.id, name: badge.name, emoji: badge.emoji }, by });
  return true;
}

export function revokeBadge(app: App, badge: Badge, contactId: string): boolean {
  return app.db.run('DELETE FROM community_badge_awards WHERE badge_id = ? AND contact_id = ?', badge.id, contactId).changes > 0;
}

/** Checks the rule badges of a group for one member and awards what is due. */
export function evaluateBadges(app: App, g: any, contactId: string): Badge[] {
  const badges = badgesOf(app, g.id).filter((b) => b.rule.type !== 'manual');
  if (!badges.length) return [];
  const have = new Set(app.db.all<{ badge_id: string }>('SELECT badge_id FROM community_badge_awards WHERE contact_id = ? AND group_id = ?', contactId, g.id).map((r) => r.badge_id));
  const cache = new Map<RuleType, number>();
  const got: Badge[] = [];
  for (const b of badges) {
    if (have.has(b.id)) continue;
    if (!cache.has(b.rule.type)) cache.set(b.rule.type, statOf(app, g, contactId, b.rule.type));
    if ((cache.get(b.rule.type) ?? 0) >= b.rule.value) {
      try {
        if (awardBadge(app, g, contactId, b, '', 'Automatisch')) got.push(b);
      } catch {
        /* not a member (any more) */
      }
    }
  }
  return got;
}

// --- perks ----------------------------------------------------------------------------------------------------------------

export const PERK_KINDS = { coupon: 'Gutscheincode', file: 'Download', link: 'Link', text: 'Text' } as const;
export type PerkKind = keyof typeof PERK_KINDS;

export interface Perk {
  id: string;
  location_id: string;
  group_id: string;
  level: number;
  kind: PerkKind;
  title: string;
  body: string;
  note: string;
  file: string;
  filename: string;
  mime: string;
  size: number;
  created_at: string;
}

export function cleanPerk(input: any, levels: Level[], cur: Partial<Perk> = {}) {
  const b = input ?? {};
  const out: Record<string, any> = {};
  const kind = (b.kind ?? cur.kind ?? 'coupon') as PerkKind;
  if (!(kind in PERK_KINDS)) throw bad(`Art: ${Object.keys(PERK_KINDS).join(', ')}`);
  out.kind = kind;
  if (b.level !== undefined || !cur.level) {
    const l = Math.round(Number(b.level ?? 2));
    if (!Number.isFinite(l) || l < 1 || l > levels.length) throw bad(`Level: 1 bis ${levels.length}`);
    out.level = l;
  }
  if (b.title !== undefined || !cur.title) out.title = str(b.title, 'Titel', { required: true, max: 120 });
  if (b.note !== undefined) out.note = str(b.note, 'Hinweis', { max: 400 });
  if (b.body !== undefined || !cur.id) {
    const body = String(b.body ?? '').trim();
    if (kind === 'coupon') {
      if (!body) throw bad('Bitte den Gutscheincode eintragen');
      if (body.length > 80 || /\s/.test(body)) throw bad('Gutscheincode: höchstens 80 Zeichen, ohne Leerzeichen');
    } else if (kind === 'link') {
      let u: URL;
      try {
        u = new URL(body);
      } catch {
        throw bad('Link: bitte eine https://-Adresse');
      }
      if (u.protocol !== 'https:' || u.username || u.password) throw bad('Link: bitte eine https://-Adresse');
      out.body = u.href.slice(0, 600);
    } else if (kind === 'text') {
      if (!body) throw bad('Bitte den Text eintragen');
      if (body.length > 3000) throw bad('Text: höchstens 3000 Zeichen');
    }
    if (kind !== 'link') out.body = kind === 'file' ? '' : body;
  }
  return out;
}

export function perksOf(app: App, groupId: string): Perk[] {
  return app.db.all<Perk>('SELECT * FROM community_perks WHERE group_id = ? ORDER BY level, created_at', groupId);
}

const FILE_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  zip: 'application/zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  epub: 'application/epub+zip',
};
export const PERK_FILE_MAX = 8 * 1024 * 1024;
const perkDir = (app: App) => join(app.config.dataDir, 'community', 'perks');

/** Stores the download of a perk (the admin sends it as a data URL or plain base64). */
export function savePerkFile(app: App, perk: Perk, name: unknown, data: unknown): Partial<Perk> {
  const filename = String(name ?? '').replace(/[\\/\0]/g, '_').replace(/[^\p{L}\p{N} ._()+-]/gu, '').trim().slice(0, 120);
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (!filename || !FILE_TYPES[ext]) throw bad(`Dateityp nicht erlaubt (erlaubt: ${Object.keys(FILE_TYPES).join(', ')})`);
  const m = /^data:[^;,]*;base64,(.*)$/s.exec(String(data ?? ''));
  const buf = Buffer.from(m ? m[1] : String(data ?? ''), 'base64');
  if (!buf.length) throw bad('Die Datei ist leer');
  if (buf.length > PERK_FILE_MAX) throw bad('Die Datei ist größer als 8 MB');
  mkdirSync(perkDir(app), { recursive: true });
  const file = `${perk.id}.${ext}`;
  writeFileSync(join(perkDir(app), file), buf);
  return { file, filename, mime: FILE_TYPES[ext], size: buf.length };
}

export function removePerkFile(app: App, perk: Pick<Perk, 'file'>) {
  if (perk.file) rmSync(join(perkDir(app), perk.file), { force: true });
}

export function perkFileResponse(app: App, perk: Perk): RawResult | undefined {
  if (!perk.file) return undefined;
  try {
    const body = readFileSync(join(perkDir(app), perk.file));
    return {
      __raw: true,
      status: 200,
      headers: {
        'content-type': perk.mime || 'application/octet-stream',
        'content-disposition': `attachment; filename="${perk.filename.replace(/[^\w. -]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(perk.filename)}`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
        'content-security-policy': "default-src 'none'; sandbox",
      },
      body,
    };
  } catch {
    return undefined;
  }
}

// --- channels that open with a level or a tier ---------------------------------------------------------------------------------

export interface ChannelRule {
  channel_id: string;
  group_id: string;
  min_level: number;
  tier_ids: string[];
}

export function channelRules(app: App, groupId: string): ChannelRule[] {
  return app.db.all<any>('SELECT * FROM community_channel_rules WHERE group_id = ?', groupId).map((r) => parseJson(r, ['tier_ids']) as ChannelRule);
}

export function cleanRule(app: App, g: { id: string; location_id: string }, input: any): { min_level: number; tier_ids: string[] } {
  const levels = groupSettings(g as any).levels.length || 9;
  const lvl = Math.round(Number(input?.min_level ?? 1));
  if (!Number.isFinite(lvl) || lvl < 1 || lvl > Math.max(levels, 9)) throw bad(`Level: 1 bis ${levels}`);
  const tiers: string[] = Array.isArray(input?.tier_ids) ? [...new Set<string>(input.tier_ids.map(String))] : [];
  if (tiers.length) {
    const ok = new Set(app.db.all<{ id: string }>('SELECT id FROM community_tiers WHERE group_id = ?', g.id).map((r) => r.id));
    for (const t of tiers) if (!ok.has(t)) throw bad('Eine der Stufen gehört nicht zu dieser Gruppe');
  }
  return { min_level: lvl, tier_ids: tiers };
}

/** channel id → why this member can't open it (levels and tiers). */
export function closedByRules(app: App, g: { id: string }, contactId: string): Map<string, string> {
  const out = new Map<string, string>();
  const rules = channelRules(app, g.id).filter((r) => r.min_level > 1 || r.tier_ids.length);
  if (!rules.length) return out;
  const lvl = app.db.get<{ level: number }>('SELECT level FROM community_members WHERE group_id = ? AND contact_id = ?', g.id, contactId)?.level ?? 1;
  const tier = app.db.get<{ tier_id: string | null }>('SELECT tier_id FROM community_memberships WHERE group_id = ? AND contact_id = ?', g.id, contactId)?.tier_id ?? '';
  for (const r of rules) {
    if (r.tier_ids.length && !r.tier_ids.includes(tier)) {
      const names = r.tier_ids.map((t) => app.db.get<{ name: string }>('SELECT name FROM community_tiers WHERE id = ?', t)?.name).filter(Boolean);
      out.set(r.channel_id, `Dieser Kanal gehört zu ${names.length > 1 ? 'den Stufen' : 'der Stufe'} ${names.map((n) => `„${n}“`).join(', ')}.`);
    } else if (lvl < r.min_level) {
      out.set(r.channel_id, `Dieser Kanal öffnet sich ab Level ${r.min_level}. Du bist auf Level ${lvl} – sammle Punkte mit Beiträgen, Kommentaren und Check-ins.`);
    }
  }
  return out;
}

// --- the calendar-month leaderboard ----------------------------------------------------------------------------------------

const tzOf = (app: App, locationId: string) => app.location(locationId)?.timezone || 'Europe/Berlin';

export const monthKeyOf = (at: Date, tz: string) => ymdInTz(at, tz).slice(0, 7);
export function shiftMonth(key: string, by: number): string {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
export const monthStart = (key: string, tz: string) => zonedToUtc(`${key}-01`, '00:00', tz);

export const MONTHS_DE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
export const monthLabel = (key: string) => `${MONTHS_DE[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;

export function boardBetween(app: App, groupId: string, from: Date, to: Date, limit = 50) {
  return app.db.all<{ contact_id: string; points: number }>(
    `SELECT p.contact_id, SUM(p.points) AS points FROM community_points p
     JOIN community_members m ON m.group_id = p.group_id AND m.contact_id = p.contact_id AND m.banned_at IS NULL
     WHERE p.group_id = ? AND p.created_at >= ? AND p.created_at < ? GROUP BY p.contact_id HAVING SUM(p.points) > 0 ORDER BY points DESC, MIN(p.created_at) LIMIT ?`,
    groupId,
    from.toISOString(),
    to.toISOString(),
    limit,
  );
}

export type BoardPeriod = 'week' | 'month' | 'all' | 'last';

/** The ranking for a tab of the leaderboard page: with the monthly reset "month" is the calendar month and "last" the one before. */
export function boardOf(app: App, g: { id: string; location_id: string }, period: BoardPeriod, limit = 30) {
  if (period === 'last') {
    const tz = tzOf(app, g.location_id);
    const key = shiftMonth(monthKeyOf(new Date(), tz), -1);
    return boardBetween(app, g.id, monthStart(key, tz), monthStart(shiftMonth(key, 1), tz), limit);
  }
  return leaderboard(app, g.id, period, limit);
}

/** Writes the final ranking of finished months (once) and tells the top three. */
export function archiveMonths(app: App, at = new Date()): number {
  let n = 0;
  for (const g of app.db.all<any>(`SELECT g.* FROM community_groups g JOIN community_ext e ON e.group_id = g.id WHERE g.status = 'active' AND json_extract(e.settings, '$.leaderboard.reset') = 'monthly'`)) {
    const tz = tzOf(app, g.location_id);
    const last = shiftMonth(monthKeyOf(at, tz), -1);
    if (app.db.get('SELECT 1 FROM community_leaderboard_archive WHERE group_id = ? AND month = ?', g.id, last)) continue;
    const rows = boardBetween(app, g.id, monthStart(last, tz), monthStart(shiftMonth(last, 1), tz), 10);
    app.db.run('INSERT OR IGNORE INTO community_leaderboard_archive (group_id, location_id, month, rows, created_at) VALUES (?, ?, ?, ?, ?)', g.id, g.location_id, last, JSON.stringify(rows), now());
    n++;
    rows.slice(0, 3).forEach((r, i) => notify(app, g, [r.contact_id], { kind: 'level', text: `${['🥇', '🥈', '🥉'][i]} Platz ${i + 1} im ${monthLabel(last)} – ${r.points} Punkte. Glückwunsch!` }));
  }
  return n;
}

export function archiveOf(app: App, groupId: string) {
  return app.db.all<any>('SELECT month, rows, created_at FROM community_leaderboard_archive WHERE group_id = ? ORDER BY month DESC LIMIT 24', groupId).map((r) => parseJson(r, ['rows']));
}

/** What opens at a level: courses, channels, perks – for the overview boxes. */
export function unlocksAt(app: App, g: any, level: number): { courses: string[]; channels: string[]; perks: Perk[] } {
  const s = groupSettings(g);
  const courses = s.level_unlocks.filter((u) => u.level === level).map((u) => app.db.get<{ title: string }>('SELECT title FROM courses WHERE id = ?', u.course_id)?.title).filter((x): x is string => !!x);
  const channels = channelRules(app, g.id)
    .filter((r) => r.min_level === level)
    .map((r) => app.db.get<{ name: string; emoji: string }>('SELECT name, emoji FROM community_channels WHERE id = ?', r.channel_id))
    .filter((c): c is { name: string; emoji: string } => !!c)
    .map((c) => `${c.emoji ? `${c.emoji} ` : ''}${c.name}`);
  return { courses, channels, perks: perksOf(app, g.id).filter((p) => p.level === level) };
}
