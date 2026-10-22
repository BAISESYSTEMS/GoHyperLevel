import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App } from '../core/app.js';
import { contentMatches, extFor } from '../core/files.js';
import { HttpError, bad, notFound, type Ctx } from '../core/http.js';
import { id, now, sha256 } from '../core/util.js';
import { actorOf, isBot, teamUsers, userById, type Actor, type TeamUser } from './collab-actor.js';
import type { Fts } from './collab-fts.js';
import { extractRefs, isCardKind, markdownToText, renderChat, type CardKind } from './wiki-markdown.js';
import type { ChatHub, ChatSub } from './teamchat-hub.js';

/**
 * Data rules of the Team-Chat: channels (public/private per sub-account or agency-wide), direct and group
 * messages, who may read and write where, messages with threads, mentions, files, reactions and pins, unread
 * counters, retention. Routes (modules/teamchat.ts), slash commands, MCP tools and the mobile API all go
 * through these functions, so every entry point obeys the same rules.
 */

export interface ChannelRow {
  id: string;
  location_id: string | null;
  kind: 'public' | 'private' | 'dm' | 'group';
  name: string;
  topic: string;
  dm_key: string | null;
  created_by: string | null;
  created_by_name: string;
  slack_mirror: number;
  archived_at: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface MessageRow {
  id: string;
  channel_id: string;
  thread_id: string | null;
  author_id: string | null;
  author_name: string;
  kind: 'user' | 'agent' | 'bot' | 'system';
  via: string;
  body: string;
  mentions: string;
  meta: string;
  reply_count: number;
  last_reply_at: string | null;
  edited_at: string | null;
  deleted_at: string | null;
  pinned_at: string | null;
  pinned_by: string | null;
  created_at: string;
}
interface MemberRow {
  channel_id: string;
  user_id: string;
  role: 'owner' | 'member';
  notify: '' | 'all' | 'mentions' | 'none';
  last_read_at: string | null;
  joined_at: string;
}
export type Role = 'owner' | 'member' | 'reader';

export const LIMITS = { body: 8000, files: 10, fileBytes: 8 * 1024 * 1024, groupMax: 8, name: 40, channels: 200, pins: 100, perWindow: 20, window: 10_000 };
export const UPLOAD_TYPES = /^(image\/(png|jpeg|gif|webp)|application\/(pdf|zip)|text\/(plain|csv)|application\/vnd\.(openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)|oasis\.opendocument\.(text|spreadsheet|presentation)))$/;
export const EMOJI = /^(?:\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|[\u{1f3fb}-\u{1f3ff}])*|[#*0-9]️?⃣)$/u;

export const hubOf = (app: App) => app.services.chatHub as ChatHub;
export const ftsOf = (app: App) => app.services.chatFts as Fts;
export const filesDir = (app: App) => join(app.config.dataDir, 'teamchat-files');

// --- people --------------------------------------------------------------------------------------------

/** May this person use the chat in a sub-account (null: anywhere – direct messages)? */
export const mayChat = (u: TeamUser, locationId: string | null) =>
  u.role === 'admin' || (locationId === null ? u.locations.length > 0 : u.locations.includes(locationId)) ? u.role === 'admin' || !u.permissions || u.permissions.includes('teamchat') : false;

export const memberOf = (app: App, channelId: string, userId: string) => app.db.get<MemberRow>('SELECT * FROM teamchat_members WHERE channel_id = ? AND user_id = ?', channelId, userId);
export const memberIds = (app: App, channelId: string): string[] => app.db.all<{ user_id: string }>('SELECT user_id FROM teamchat_members WHERE channel_id = ?', channelId).map((r) => r.user_id);

/** Who can be addressed in a channel: its members, or – public – everybody with the chat in that sub-account. */
export function mentionable(app: App, ch: ChannelRow): { id: string; name: string }[] {
  if (ch.kind === 'public') {
    if (ch.location_id) return teamUsers(app, ch.location_id, 'teamchat').map((u) => ({ id: u.id, name: u.name }));
    return app.db
      .all<any>(`SELECT id, name FROM users WHERE role = 'admin' OR id IN (SELECT user_id FROM teamchat_members WHERE channel_id = ?)`, ch.id)
      .map((u) => ({ id: u.id, name: u.name }));
  }
  return app.db.all<any>('SELECT u.id, u.name FROM teamchat_members m JOIN users u ON u.id = m.user_id WHERE m.channel_id = ?', ch.id).map((u) => ({ id: u.id, name: u.name }));
}

// --- access --------------------------------------------------------------------------------------------

/**
 * What the caller is to a channel: owner/member (a row), reader (a public channel – may read, and joins by
 * posting) or nothing (404 – never a hint that it exists). Private channels and direct messages are for their
 * members only, agency admins included; keys and MCP connections of a sub-account reach its public channels.
 */
export function channelAccess(app: App, ctx: Ctx, ch: ChannelRow): Role | null {
  if (isBot(ctx)) return ch.kind === 'public' && ch.location_id !== null && ch.location_id === ctx.locationId ? 'reader' : null;
  const u = ctx.user!;
  const m = memberOf(app, ch.id, u.id);
  const own: Role | null = m ? (m.role === 'owner' ? 'owner' : 'member') : null;
  if (ch.kind === 'dm' || ch.kind === 'group') return own;
  // channels of a sub-account are only reachable from that sub-account (agency-wide ones from anywhere)
  if (ch.location_id !== null && ch.location_id !== ctx.locationId) return null;
  if (ch.kind === 'private') return own;
  if (ch.location_id !== null) return own ?? 'reader';
  return own ?? (u.role === 'admin' ? 'reader' : null);
}

export function loadChannel(app: App, ctx: Ctx, channelId: string, need: 'read' | 'member' | 'owner' = 'read'): { ch: ChannelRow; role: Role } {
  const ch = app.db.get<ChannelRow>('SELECT * FROM teamchat_channels WHERE id = ?', String(channelId));
  const role = ch ? channelAccess(app, ctx, ch) : null;
  if (!ch || !role) throw notFound('Kanal nicht gefunden');
  if (need === 'owner' && role !== 'owner' && !canModerate(ctx, ch, role)) throw new HttpError(403, 'Das darf nur, wer den Kanal angelegt hat (oder die Agentur)');
  if (need === 'member' && role === 'reader' && ch.kind !== 'public') throw new HttpError(403, 'Du bist kein Mitglied dieses Kanals');
  if (ctx.scope === 'read' && need !== 'read') throw new HttpError(403, 'Diese Verbindung darf nur lesen');
  return { ch, role };
}

/** Owners of a channel, and agency admins in public channels (never in private ones or direct messages). */
export const canModerate = (ctx: Ctx, ch: ChannelRow, role: Role) => role === 'owner' || (ch.kind === 'public' && !isBot(ctx) && ctx.user?.role === 'admin');

export const getMessage = (app: App, ch: ChannelRow, messageId: string) => {
  const m = app.db.get<MessageRow>('SELECT * FROM teamchat_messages WHERE id = ? AND channel_id = ?', String(messageId), ch.id);
  if (!m) throw notFound('Nachricht nicht gefunden');
  return m;
};

/** The channel a message lives in, if the caller may reach it. */
export function loadMessage(app: App, ctx: Ctx, messageId: string, need: 'read' | 'member' | 'owner' = 'read'): { msg: MessageRow; ch: ChannelRow; role: Role } {
  const msg = app.db.get<MessageRow>('SELECT * FROM teamchat_messages WHERE id = ?', String(messageId));
  if (!msg) throw notFound('Nachricht nicht gefunden');
  const { ch, role } = loadChannel(app, ctx, msg.channel_id, need);
  return { msg, ch, role };
}

/** Channels the caller sees in a sub-account: its public/private ones, agency-wide ones and their direct messages. */
export function visibleChannels(app: App, ctx: Ctx, opts: { archived?: boolean } = {}): { ch: ChannelRow; role: Role }[] {
  const arch = opts.archived ? 'archived_at IS NOT NULL' : 'archived_at IS NULL';
  const rows = app.db.all<ChannelRow>(
    isBot(ctx)
      ? `SELECT * FROM teamchat_channels WHERE location_id = ? AND kind = 'public' AND ${arch} ORDER BY name`
      : `SELECT * FROM teamchat_channels WHERE ${arch} AND (
           (location_id = ? AND kind IN ('public', 'private'))
           OR (location_id IS NULL AND kind IN ('public', 'private'))
           OR (kind IN ('dm', 'group') AND id IN (SELECT channel_id FROM teamchat_members WHERE user_id = ?))
         ) ORDER BY name`,
    ...(isBot(ctx) ? [ctx.locationId] : [ctx.locationId, ctx.user!.id]),
  );
  return rows.map((ch) => ({ ch, role: channelAccess(app, ctx, ch) as Role })).filter((x) => x.role);
}

// --- channels ----------------------------------------------------------------------------------------------

export const cleanChannelName = (v: unknown): string => {
  const n = String(v ?? '')
    .trim()
    .toLowerCase()
    .replace(/^#/, '')
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (n.length < 2) throw bad('Der Name braucht mindestens 2 Buchstaben oder Ziffern');
  if (n.length > LIMITS.name) throw bad(`Der Name ist zu lang (höchstens ${LIMITS.name} Zeichen)`);
  return n;
};

const nameTaken = (app: App, location: string | null, name: string, except = '') =>
  !!app.db.get(`SELECT 1 AS x FROM teamchat_channels WHERE location_id IS ? AND kind IN ('public', 'private') AND LOWER(name) = ? AND id != ?`, location, name, except);

export function addMember(app: App, channelId: string, userId: string, role: 'owner' | 'member' = 'member') {
  app.db.run('INSERT OR IGNORE INTO teamchat_members (channel_id, user_id, role, notify, last_read_at, joined_at) VALUES (?, ?, ?, ?, ?, ?)', channelId, userId, role, '', now(), now());
}

export function createChannel(app: App, ctx: Ctx, o: { name: string; kind: 'public' | 'private'; topic?: string; agency?: boolean; members?: string[] }): ChannelRow {
  if (isBot(ctx) || !ctx.user) throw new HttpError(403, 'Kanäle legen nur angemeldete Personen an');
  const location = o.agency ? null : ctx.locationId;
  if (o.agency && ctx.user.role !== 'admin') throw new HttpError(403, 'Kanäle für die ganze Agentur legt nur die Agentur an');
  const name = cleanChannelName(o.name);
  if (nameTaken(app, location, name)) throw bad(`Einen Kanal „${name}“ gibt es schon`);
  if ((app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM teamchat_channels WHERE location_id IS ?', location)?.n ?? 0) >= LIMITS.channels) throw bad(`Höchstens ${LIMITS.channels} Kanäle`);
  const ch: ChannelRow = { id: id(), location_id: location, kind: o.kind, name, topic: String(o.topic ?? '').slice(0, 250), dm_key: null, created_by: ctx.user.id, created_by_name: ctx.user.name, slack_mirror: 0, archived_at: null, last_message_at: null, created_at: now(), updated_at: now() };
  app.db.tx(() => {
    app.db.insert('teamchat_channels', ch);
    addMember(app, ch.id, ctx.user!.id, 'owner');
    for (const uid of new Set(o.members ?? [])) if (uid !== ctx.user!.id) addInvited(app, ctx, ch, uid);
  });
  return ch;
}

/** Adds a person to a channel if they may be there (access to that sub-account and the chat). */
export function addInvited(app: App, ctx: Ctx, ch: ChannelRow, userId: string): boolean {
  const u = userById(app, userId);
  if (!u || !mayChat(u, ch.location_id ?? ctx.locationId)) return false;
  addMember(app, ch.id, u.id);
  return true;
}

/** The direct message (2 people) or group (3–8) with exactly these people – created when it does not exist yet. */
export function directChannel(app: App, ctx: Ctx, userIds: string[]): ChannelRow {
  if (isBot(ctx) || !ctx.user) throw new HttpError(403, 'Direktnachrichten gibt es nur mit Anmeldung');
  const ids = [...new Set([ctx.user.id, ...userIds.map(String)])].sort();
  if (ids.length < 2) throw bad('Bitte mindestens eine andere Person wählen');
  if (ids.length > LIMITS.groupMax) throw bad(`Höchstens ${LIMITS.groupMax} Personen in einer Gruppe`);
  const people = ids.map((i) => userById(app, i));
  // everybody must be somebody this person can chat with here: the same sub-account (or the agency)
  for (const p of people) if (!p || !mayChat(p, ctx.locationId)) throw bad('Mit dieser Person kannst du hier nicht schreiben');
  const key = sha256(ids.join(',')).slice(0, 40);
  const have = app.db.get<ChannelRow>('SELECT * FROM teamchat_channels WHERE dm_key = ?', key);
  if (have) return have;
  const ch: ChannelRow = { id: id(), location_id: null, kind: ids.length === 2 ? 'dm' : 'group', name: '', topic: '', dm_key: key, created_by: ctx.user.id, created_by_name: ctx.user.name, slack_mirror: 0, archived_at: null, last_message_at: null, created_at: now(), updated_at: now() };
  app.db.tx(() => {
    app.db.insert('teamchat_channels', ch);
    for (const i of ids) addMember(app, ch.id, i, i === ctx.user!.id ? 'owner' : 'member');
  });
  return ch;
}

/** "#allgemein" for a sub-account that has no channel yet. */
export function ensureDefaultChannel(app: App, ctx: Ctx) {
  if (isBot(ctx) || !ctx.user || ctx.scope === 'read') return;
  if (app.db.get(`SELECT 1 AS x FROM teamchat_channels WHERE location_id = ? AND kind IN ('public', 'private')`, ctx.locationId)) return;
  const ch: ChannelRow = { id: id(), location_id: ctx.locationId, kind: 'public', name: 'allgemein', topic: 'Alles fürs Team', dm_key: null, created_by: null, created_by_name: 'HyperLevel', slack_mirror: 0, archived_at: null, last_message_at: null, created_at: now(), updated_at: now() };
  app.db.insert('teamchat_channels', ch);
  addMember(app, ch.id, ctx.user.id);
}

/** What a channel is called to a person: its name, or the other people of a direct message. */
export function channelLabel(app: App, ch: ChannelRow, viewerId: string | null): string {
  if (ch.kind === 'public' || ch.kind === 'private') return `#${ch.name}`;
  return app.db.all<{ name: string }>('SELECT u.name FROM teamchat_members m JOIN users u ON u.id = m.user_id WHERE m.channel_id = ? AND m.user_id != ? ORDER BY u.name', ch.id, viewerId ?? '').map((u) => u.name).join(', ') || 'Direktnachricht';
}

// --- counters --------------------------------------------------------------------------------------------------

/** Unread messages (top level, from others) and unread mentions per channel for one person. */
export function unreadCounts(app: App, userId: string, channelIds: string[]): Map<string, { unread: number; mentions: number }> {
  const out = new Map<string, { unread: number; mentions: number }>();
  if (!channelIds.length) return out;
  const marks = channelIds.map(() => '?').join(',');
  for (const r of app.db.all<{ channel_id: string; n: number }>(
    `SELECT m.channel_id, COUNT(*) AS n FROM teamchat_messages m JOIN teamchat_members tm ON tm.channel_id = m.channel_id AND tm.user_id = ?
     WHERE m.channel_id IN (${marks}) AND m.thread_id IS NULL AND m.deleted_at IS NULL AND m.kind != 'system' AND m.created_at > COALESCE(tm.last_read_at, tm.joined_at) AND (m.author_id IS NULL OR m.author_id != ?) GROUP BY m.channel_id`,
    userId,
    ...channelIds,
    userId,
  ))
    out.set(r.channel_id, { unread: r.n, mentions: 0 });
  for (const r of app.db.all<{ channel_id: string; n: number }>(
    `SELECT m.channel_id, COUNT(*) AS n FROM teamchat_messages m JOIN teamchat_members tm ON tm.channel_id = m.channel_id AND tm.user_id = ?
     WHERE m.channel_id IN (${marks}) AND m.deleted_at IS NULL AND m.created_at > COALESCE(tm.last_read_at, tm.joined_at) AND (m.author_id IS NULL OR m.author_id != ?)
       AND EXISTS (SELECT 1 FROM json_each(m.mentions) WHERE value = ?) GROUP BY m.channel_id`,
    userId,
    ...channelIds,
    userId,
    userId,
  )) {
    const cur = out.get(r.channel_id) ?? { unread: 0, mentions: 0 };
    cur.mentions = r.n;
    out.set(r.channel_id, cur);
  }
  return out;
}

export function markRead(app: App, channelId: string, userId: string) {
  const r = app.db.run('UPDATE teamchat_members SET last_read_at = ? WHERE channel_id = ? AND user_id = ?', now(), channelId, userId);
  return r.changes > 0;
}

// --- mentions ------------------------------------------------------------------------------------------------------

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Applies `fn` to the parts of a text outside fenced and inline code. */
export function outsideCode(text: string, fn: (s: string) => string): string {
  return text
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g)
    .map((part, i) => (i % 2 ? part : fn(part)))
    .join('');
}

/**
 * Mentions of a text: "[@Name](user:ID)" from the picker, plain "@Name" (full name, or a first name that is
 * unique in the channel) turned into that form, and @alle / @channel / @here for everybody. Only people who
 * can be addressed in this channel count – a private channel never reveals who is outside.
 */
export function resolveMentions(app: App, ch: ChannelRow, body: string, authorId: string | null): { body: string; ids: string[]; all: boolean } {
  const cands = mentionable(app, ch);
  const byId = new Map(cands.map((c) => [c.id, c.name]));
  const ids = new Set<string>();
  let all = false;
  const firstNames = new Map<string, string | null>();
  for (const c of cands) {
    const first = c.name.split(/\s+/)[0]?.toLowerCase();
    if (first && c.name.includes(' ')) firstNames.set(first, firstNames.has(first) ? null : c.id);
  }
  const names = new Map<string, string>(); // lower-case spelling → user id
  for (const c of cands) if (c.name) names.set(c.name.toLowerCase(), c.id);
  for (const [f, uid] of firstNames) if (uid && !names.has(f)) names.set(f, uid);
  const keys = [...names.keys(), 'alle', 'channel', 'here'].sort((a, b) => b.length - a.length).slice(0, 600);
  const re = keys.length ? new RegExp(`(^|[^\\p{L}\\p{N}\\[@])@(${keys.map(escRe).join('|')})(?![\\p{L}\\p{N}])`, 'giu') : null;
  const text = outsideCode(body, (part) => {
    for (const r of extractRefs(part).users) if (byId.has(r)) ids.add(r);
    if (!re) return part;
    return part.replace(re, (m, pre: string, who: string) => {
      const key = who.toLowerCase();
      if (['alle', 'channel', 'here'].includes(key) && !names.has(key)) {
        all = true;
        return m;
      }
      const uid = names.get(key);
      if (!uid) return m;
      ids.add(uid);
      return `${pre}[@${byId.get(uid)}](user:${uid})`;
    });
  });
  // the linked form is only valid for people of this channel
  const clean = outsideCode(text, (part) => part.replace(/\[([^\]\n]{0,200})\]\(user:([A-Za-z0-9_-]{1,64})\)/g, (m, label: string, uid: string) => (byId.has(uid) ? m : label)));
  let list = [...ids];
  if (all) list = [...new Set([...list, ...(ch.kind === 'public' ? cands.map((c) => c.id) : memberIds(app, ch.id))])];
  return { body: clean, ids: list.filter((u) => u !== authorId), all };
}

// --- records / cards in a message ------------------------------------------------------------------------------------------

/** Records a message refers to: "card:" references and links to this app's record pages (max 4). */
export function cardsOf(app: App, body: string): { kind: CardKind; id: string; label: string }[] {
  const out = extractRefs(body).cards.slice(0, 4);
  const base = app.baseUrl().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // this app's own address, or a bare "/app/…" path – a link to somebody else's site that happens to contain one is no record
  const re = new RegExp(`(?:${base}|(?<![\\w:/.@-]))/app/(contacts|companies|tickets|canvas|wiki)/([A-Za-z0-9_-]{1,64})(?![\\w-])`, 'g');
  const map: Record<string, CardKind> = { contacts: 'contact', companies: 'company', tickets: 'ticket', canvas: 'canvas', wiki: 'wiki' };
  for (const m of body.matchAll(re)) {
    const kind = map[m[1]];
    if (isCardKind(kind) && !out.some((c) => c.kind === kind && c.id === m[2]) && out.length < 4) out.push({ kind, id: m[2], label: '' });
  }
  return out;
}

// --- output ---------------------------------------------------------------------------------------------------------------------

const parse = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

export function messageOut(app: App, rows: MessageRow[]) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => '?').join(',');
  const reacts = new Map<string, Map<string, string[]>>();
  for (const r of app.db.all<{ message_id: string; user_id: string; emoji: string }>(`SELECT message_id, user_id, emoji FROM teamchat_reactions WHERE message_id IN (${marks}) ORDER BY created_at`, ...ids)) {
    const m = reacts.get(r.message_id) ?? new Map<string, string[]>();
    m.set(r.emoji, [...(m.get(r.emoji) ?? []), r.user_id]);
    reacts.set(r.message_id, m);
  }
  const files = new Map<string, any[]>();
  for (const f of app.db.all<any>(`SELECT id, message_id, name, mime, size FROM teamchat_files WHERE message_id IN (${marks}) ORDER BY created_at`, ...ids)) files.set(f.message_id, [...(files.get(f.message_id) ?? []), { id: f.id, name: f.name, mime: f.mime, size: f.size, image: String(f.mime).startsWith('image/'), url: `/api/team-chat/files/${f.id}` }]);
  return rows.map((m) => {
    const deleted = !!m.deleted_at;
    return {
      id: m.id,
      channel_id: m.channel_id,
      thread_id: m.thread_id,
      kind: m.kind,
      author: { id: m.author_id, name: m.author_name },
      body: deleted ? '' : m.body,
      html: deleted ? '' : renderChat(m.body),
      text: deleted ? '' : markdownToText(m.body),
      mentions: deleted ? [] : parse<string[]>(m.mentions, []),
      cards: deleted ? [] : cardsOf(app, m.body),
      files: deleted ? [] : (files.get(m.id) ?? []),
      reactions: deleted ? [] : [...(reacts.get(m.id) ?? [])].map(([emoji, users]) => ({ emoji, count: users.length, users })),
      reply_count: m.reply_count,
      last_reply_at: m.last_reply_at,
      edited_at: m.edited_at,
      deleted,
      pinned: !!m.pinned_at,
      pinned_at: m.pinned_at,
      via: m.via,
      meta: deleted ? {} : parse<Record<string, unknown>>(m.meta, {}),
      created_at: m.created_at,
    };
  });
}
export type MessageOut = ReturnType<typeof messageOut>[number];

// --- realtime ---------------------------------------------------------------------------------------------------------------------

/** Who gets a channel's events: its members – and everybody in the sub-account for a public channel. */
export function audienceOf(app: App, ch: ChannelRow): (s: ChatSub) => boolean {
  if (ch.kind === 'public') {
    if (ch.location_id) return (s) => s.locationId === ch.location_id;
    const members = new Set(memberIds(app, ch.id));
    return (s) => s.admin || members.has(s.userId);
  }
  const members = new Set(memberIds(app, ch.id));
  return (s) => members.has(s.userId) && (ch.location_id === null || s.locationId === ch.location_id);
}
export const publish = (app: App, ch: ChannelRow, event: string, data: unknown) => hubOf(app).publish(event, data, audienceOf(app, ch));

// --- posting -------------------------------------------------------------------------------------------------------------------------

const windows = new Map<string, number[]>();
/** At most 20 messages per ten seconds from one sender (`app.services.chatRate = { max, windowMs }` changes it, e.g. in tests). */
export function rateLimit(app: App, key: string) {
  const { max, windowMs } = { max: LIMITS.perWindow, windowMs: LIMITS.window, ...(app.services.chatRate ?? {}) };
  const t = Date.now();
  const list = (windows.get(key) ?? []).filter((x) => t - x < windowMs);
  if (list.length >= max) throw new HttpError(429, 'Zu viele Nachrichten – bitte kurz warten');
  list.push(t);
  windows.set(key, list);
  if (windows.size > 5000) windows.clear();
}

export interface PostInput {
  body: string;
  threadId?: string | null;
  fileIds?: string[];
  kind?: MessageRow['kind'];
  meta?: Record<string, unknown>;
  /** A sender other than the caller (the agent's answer, a command's result). */
  as?: { id: string | null; name: string };
  /** Do not notify (command results, system lines). */
  quiet?: boolean;
  /** Takes the text as it is (the author already linked mentions). */
  raw?: boolean;
}

/** A timestamp later than every message of the channel – messages sent within one millisecond keep their order. */
function stampFor(app: App, channelId: string): string {
  const t = now();
  const last = app.db.get<{ t: string | null }>('SELECT MAX(created_at) AS t FROM teamchat_messages WHERE channel_id = ?', channelId)?.t;
  return last && t <= last ? new Date(Date.parse(last) + 1).toISOString() : t;
}

export function postMessage(app: App, ctx: Ctx, ch: ChannelRow, input: PostInput): { row: MessageRow; out: MessageOut; mentioned: string[] } {
  if (ch.archived_at) throw new HttpError(409, 'Dieser Kanal ist archiviert');
  const actor: Actor = actorOf(app, ctx);
  const files = [...new Set(input.fileIds ?? [])].slice(0, LIMITS.files);
  let body = String(input.body ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
  if (body.length > LIMITS.body) throw bad(`Die Nachricht ist zu lang (höchstens ${LIMITS.body.toLocaleString('de-DE')} Zeichen)`);
  if (!body && !files.length) throw bad('Die Nachricht ist leer');
  if (!input.quiet) rateLimit(app, `${actor.id ?? actor.name}`);
  let parent: MessageRow | undefined;
  if (input.threadId) {
    parent = app.db.get<MessageRow>('SELECT * FROM teamchat_messages WHERE id = ? AND channel_id = ?', String(input.threadId), ch.id);
    if (!parent || parent.deleted_at) throw notFound('Die Nachricht, auf die du antwortest, gibt es nicht mehr');
    // threads are one level deep: a reply to a reply goes to the same thread
    if (parent.thread_id) parent = app.db.get<MessageRow>('SELECT * FROM teamchat_messages WHERE id = ?', parent.thread_id) ?? parent;
  }
  const m = input.raw ? { body, ids: [] as string[], all: false } : resolveMentions(app, ch, body, actor.id);
  body = m.body;
  const row: MessageRow = {
    id: id(),
    channel_id: ch.id,
    thread_id: parent?.id ?? null,
    author_id: input.as ? input.as.id : actor.id,
    author_name: (input.as ? input.as.name : actor.name).slice(0, 200),
    kind: input.kind ?? (actor.kind === 'user' ? 'user' : actor.kind === 'agent' ? 'user' : 'bot'),
    via: String(ctx.via ?? ''),
    body,
    mentions: JSON.stringify(m.ids),
    meta: JSON.stringify(input.meta ?? {}),
    reply_count: 0,
    last_reply_at: null,
    edited_at: null,
    deleted_at: null,
    pinned_at: null,
    pinned_by: null,
    created_at: stampFor(app, ch.id),
  };
  // writing in a public channel joins it
  if (ch.kind === 'public' && actor.id && !input.as && !memberOf(app, ch.id, actor.id)) addMember(app, ch.id, actor.id);
  app.db.tx(() => {
    app.db.insert('teamchat_messages', row);
    app.db.run('UPDATE teamchat_channels SET last_message_at = ?, updated_at = ? WHERE id = ?', row.created_at, row.created_at, ch.id);
    if (parent) app.db.run('UPDATE teamchat_messages SET reply_count = reply_count + 1, last_reply_at = ? WHERE id = ?', row.created_at, parent.id);
    for (const fid of files) {
      const f = app.db.get<any>('SELECT * FROM teamchat_files WHERE id = ? AND channel_id = ? AND message_id IS NULL', fid, ch.id);
      if (!f || (f.uploader_id && f.uploader_id !== actor.id)) throw bad('Datei nicht gefunden – bitte neu hochladen');
      app.db.run('UPDATE teamchat_files SET message_id = ? WHERE id = ?', row.id, fid);
    }
    // the sender has read everything up to now
    if (actor.id) app.db.run('UPDATE teamchat_members SET last_read_at = ? WHERE channel_id = ? AND user_id = ?', row.created_at, ch.id, actor.id);
  });
  indexMessage(app, row);
  const [out] = messageOut(app, [row]);
  publish(app, ch, 'message', out);
  if (parent) {
    const [p] = messageOut(app, [app.db.get<MessageRow>('SELECT * FROM teamchat_messages WHERE id = ?', parent.id)!]);
    publish(app, ch, 'message-edit', p);
  }
  return { row, out, mentioned: input.quiet ? [] : m.ids };
}

export function indexMessage(app: App, row: Pick<MessageRow, 'id' | 'body' | 'deleted_at'>) {
  const r = app.db.get<{ r: number }>('SELECT rowid AS r FROM teamchat_messages WHERE id = ?', row.id);
  if (!r) return;
  if (row.deleted_at) ftsOf(app).remove(r.r);
  else ftsOf(app).upsert(r.r, { body: markdownToText(row.body) });
}

export function editMessage(app: App, ctx: Ctx, ch: ChannelRow, msg: MessageRow, text: string): { out: MessageOut; fresh: string[] } {
  const actor = actorOf(app, ctx);
  if (msg.deleted_at) throw bad('Die Nachricht wurde gelöscht');
  if (!actor.id || msg.author_id !== actor.id || msg.kind !== 'user') throw new HttpError(403, 'Nur eigene Nachrichten bearbeiten');
  const body0 = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!body0) throw bad('Die Nachricht ist leer');
  if (body0.length > LIMITS.body) throw bad(`Die Nachricht ist zu lang (höchstens ${LIMITS.body.toLocaleString('de-DE')} Zeichen)`);
  const m = resolveMentions(app, ch, body0, actor.id);
  const before = new Set(parse<string[]>(msg.mentions, []));
  app.db.run('UPDATE teamchat_messages SET body = ?, mentions = ?, edited_at = ? WHERE id = ?', m.body, JSON.stringify(m.ids), now(), msg.id);
  const fresh = app.db.get<MessageRow>('SELECT * FROM teamchat_messages WHERE id = ?', msg.id)!;
  indexMessage(app, fresh);
  const [out] = messageOut(app, [fresh]);
  publish(app, ch, 'message-edit', out);
  return { out, fresh: m.ids.filter((u) => !before.has(u)) };
}

/** Removes the files of messages from disk (their rows go with the message). */
export function removeFiles(app: App, rows: { file: string }[]) {
  for (const f of rows) rmSync(join(filesDir(app), f.file), { force: true });
}

export function deleteMessage(app: App, ctx: Ctx, ch: ChannelRow, role: Role, msg: MessageRow) {
  const actor = actorOf(app, ctx);
  const own = !!actor.id && msg.author_id === actor.id;
  if (!own && !canModerate(ctx, ch, role)) throw new HttpError(403, 'Nur eigene Nachrichten löschen');
  if (msg.deleted_at) return;
  const files = app.db.all<{ file: string }>('SELECT file FROM teamchat_files WHERE message_id = ?', msg.id);
  app.db.tx(() => {
    // a tombstone: the thread under it stays readable
    app.db.run(`UPDATE teamchat_messages SET deleted_at = ?, body = '', mentions = '[]', meta = '{}', pinned_at = NULL, pinned_by = NULL WHERE id = ?`, now(), msg.id);
    app.db.run('DELETE FROM teamchat_files WHERE message_id = ?', msg.id);
    app.db.run('DELETE FROM teamchat_reactions WHERE message_id = ?', msg.id);
    if (msg.thread_id) app.db.run('UPDATE teamchat_messages SET reply_count = MAX(0, reply_count - 1) WHERE id = ?', msg.thread_id);
  });
  removeFiles(app, files);
  indexMessage(app, { id: msg.id, body: '', deleted_at: now() });
  const [out] = messageOut(app, [app.db.get<MessageRow>('SELECT * FROM teamchat_messages WHERE id = ?', msg.id)!]);
  publish(app, ch, 'message-delete', { id: msg.id, channel_id: ch.id, thread_id: msg.thread_id, message: out });
}

/** Deletes messages for good (retention, channel removal): files on disk, search index, rows. */
export function purgeMessages(app: App, ids: string[]) {
  if (!ids.length) return;
  const marks = ids.map(() => '?').join(',');
  const files = app.db.all<{ file: string }>(`SELECT file FROM teamchat_files WHERE message_id IN (${marks})`, ...ids);
  for (const r of app.db.all<{ r: number }>(`SELECT rowid AS r FROM teamchat_messages WHERE id IN (${marks})`, ...ids)) ftsOf(app).remove(r.r);
  app.db.run(`DELETE FROM teamchat_messages WHERE id IN (${marks})`, ...ids);
  removeFiles(app, files);
}

export function toggleReaction(app: App, ctx: Ctx, ch: ChannelRow, msg: MessageRow, emoji: string): { active: boolean; out: MessageOut } {
  const actor = actorOf(app, ctx);
  if (!actor.id) throw new HttpError(403, 'Reaktionen gibt es nur mit Anmeldung');
  if (msg.deleted_at) throw bad('Die Nachricht wurde gelöscht');
  const e = String(emoji ?? '');
  if (!EMOJI.test(e) || e.length > 24) throw bad('Bitte ein Emoji wählen');
  const have = app.db.get('SELECT 1 AS x FROM teamchat_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', msg.id, actor.id, e);
  if (have) app.db.run('DELETE FROM teamchat_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', msg.id, actor.id, e);
  else {
    if ((app.db.get<{ n: number }>('SELECT COUNT(DISTINCT emoji) AS n FROM teamchat_reactions WHERE message_id = ?', msg.id)?.n ?? 0) >= 20) throw bad('Höchstens 20 verschiedene Reaktionen je Nachricht');
    app.db.insert('teamchat_reactions', { message_id: msg.id, user_id: actor.id, emoji: e, created_at: now() });
  }
  const [out] = messageOut(app, [app.db.get<MessageRow>('SELECT * FROM teamchat_messages WHERE id = ?', msg.id)!]);
  publish(app, ch, 'reaction', { message_id: msg.id, channel_id: ch.id, reactions: out.reactions });
  return { active: !have, out };
}

export function setPinned(app: App, ctx: Ctx, ch: ChannelRow, msg: MessageRow, pinned: boolean) {
  const actor = actorOf(app, ctx);
  if (msg.deleted_at) throw bad('Die Nachricht wurde gelöscht');
  if (pinned && (app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM teamchat_messages WHERE channel_id = ? AND pinned_at IS NOT NULL', ch.id)?.n ?? 0) >= LIMITS.pins) throw bad(`Höchstens ${LIMITS.pins} angepinnte Nachrichten`);
  app.db.run('UPDATE teamchat_messages SET pinned_at = ?, pinned_by = ? WHERE id = ?', pinned ? now() : null, pinned ? actor.name : null, msg.id);
  const [out] = messageOut(app, [app.db.get<MessageRow>('SELECT * FROM teamchat_messages WHERE id = ?', msg.id)!]);
  publish(app, ch, 'message-edit', out);
  return out;
}

// --- files -----------------------------------------------------------------------------------------------------------------------------

export function saveFile(app: App, ctx: Ctx, ch: ChannelRow, o: { name: unknown; data: unknown }) {
  const actor = actorOf(app, ctx);
  const name = String(o.name ?? '').replace(/[\\/\u0000-\u001f]+/g, '_').trim().slice(0, 200);
  if (!name) throw bad('Dateiname fehlt');
  const m = String(o.data ?? '').match(/^data:([\w/+.-]+);base64,(.+)$/);
  if (!m) throw bad('Erwarte eine data:-URL');
  const mime = m[1];
  // No SVG or HTML: even served by us they could carry script.
  if (!UPLOAD_TYPES.test(mime)) throw bad('Erlaubt: Bilder (PNG, JPG, GIF, WebP), PDF, Text/CSV, Office-Dokumente und ZIP');
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) throw bad('Die Datei ist leer');
  if (buf.length > LIMITS.fileBytes) throw bad('Datei größer als 8 MB');
  if (!contentMatches(mime, buf)) throw bad('Dateiinhalt passt nicht zum Dateityp');
  mkdirSync(filesDir(app), { recursive: true });
  const fid = id();
  const file = `${fid}${extFor(mime)}`;
  writeFileSync(join(filesDir(app), file), buf);
  app.db.insert('teamchat_files', { id: fid, channel_id: ch.id, message_id: null, uploader_id: actor.id, name, mime, size: buf.length, file, created_at: now() });
  return { id: fid, name, mime, size: buf.length, image: mime.startsWith('image/'), url: `/api/team-chat/files/${fid}` };
}

export const filePath = (app: App, file: string) => {
  const p = join(filesDir(app), file);
  return existsSync(p) ? p : null;
};
