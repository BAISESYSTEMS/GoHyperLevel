import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App, LocationRow } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { HttpError, bad, type RawResult } from '../core/http.js';
import { escapeHtml } from '../core/template.js';
import { hmInTz, ymdInTz } from '../core/time.js';
import { id, now, slugify } from '../core/util.js';
import { getContact, logActivity, type Contact } from './contacts.js';
import { grantAccess } from './courses.js';
import { deliverEmail, type OutMail } from './messaging.js';
import { applyWordFilter, decodeImage, groupAccess, groupSettings, levelFor, memberPoints, mentionHandles, MAX_POST_IMAGES } from './community.js';
import { communityUi } from './community-ui.js';

/**
 * Everything that changes community data, shared by the member pages and the admin API:
 * posts, comments, likes, follows, points & levels, notifications, reports, uploads and the
 * daily email digest. Member input is validated and filtered here, never in the page code.
 */

export type Author = { kind: 'member'; contact: Contact } | { kind: 'team'; userId: string; name: string };

const TITLE_MAX = 200;
const BODY_MAX = 20_000;
const COMMENT_MAX = 5_000;

export const fileDir = (app: App) => join(app.config.dataDir, 'community');

// --- profiles -------------------------------------------------------------------------

export interface Profile {
  location_id: string;
  contact_id: string;
  handle: string;
  display_name: string;
  bio: string;
  avatar_file_id: string | null;
  digest: number;
  last_digest_at: string | null;
}

const defaultName = (c: Contact) => [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || 'Mitglied';

export function profileOf(app: App, locationId: string, contactId: string): Profile | undefined {
  return app.db.get<Profile>('SELECT * FROM community_profiles WHERE location_id = ? AND contact_id = ?', locationId, contactId);
}

/** Every member gets a profile with a unique @handle on first use. */
export function ensureProfile(app: App, locationId: string, contact: Contact): Profile {
  const cur = profileOf(app, locationId, contact.id);
  if (cur) return cur;
  const name = defaultName(contact);
  const root = slugify(name === 'Mitglied' ? `mitglied-${contact.id.slice(0, 4)}` : name).slice(0, 30) || 'mitglied';
  let handle = root;
  for (let i = 2; app.db.get('SELECT 1 FROM community_profiles WHERE location_id = ? AND handle = ?', locationId, handle); i++) handle = `${root}-${i}`;
  app.db.run(
    'INSERT OR IGNORE INTO community_profiles (location_id, contact_id, handle, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    locationId,
    contact.id,
    handle,
    name.slice(0, 60),
    now(),
    now(),
  );
  return profileOf(app, locationId, contact.id)!;
}

export function updateProfile(app: App, locationId: string, contact: Contact, input: { display_name?: unknown; bio?: unknown; digest?: unknown; avatar?: string; remove_avatar?: boolean }) {
  const p = ensureProfile(app, locationId, contact);
  const patch: Record<string, any> = { updated_at: now() };
  if (input.display_name !== undefined) {
    const n = String(input.display_name ?? '').replace(/\s+/g, ' ').trim();
    if (n.length < 2) throw bad('Anzeigename: mindestens 2 Zeichen');
    if (n.length > 60) throw bad('Anzeigename ist zu lang');
    if (/[<>@]/.test(n)) throw bad('Anzeigename: bitte ohne < > @');
    patch.display_name = n;
  }
  if (input.bio !== undefined) {
    const b = String(input.bio ?? '').trim();
    if (b.length > 500) throw bad('Über mich: höchstens 500 Zeichen');
    patch.bio = b;
  }
  if (input.digest !== undefined) patch.digest = input.digest ? 1 : 0;
  if (input.avatar) {
    const f = saveImage(app, locationId, contact.id, null, 'avatar', input.avatar, 2 * 1024 * 1024);
    if (p.avatar_file_id) removeFiles(app, [p.avatar_file_id]);
    patch.avatar_file_id = f.id;
  } else if (input.remove_avatar && p.avatar_file_id) {
    removeFiles(app, [p.avatar_file_id]);
    patch.avatar_file_id = null;
  }
  const keys = Object.keys(patch);
  app.db.run(`UPDATE community_profiles SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE location_id = ? AND contact_id = ?`, ...keys.map((k) => patch[k]), locationId, contact.id);
  return profileOf(app, locationId, contact.id)!;
}

// --- files ----------------------------------------------------------------------------

export function saveImage(app: App, locationId: string, contactId: string | null, groupId: string | null, kind: 'post' | 'avatar', dataUrl: string, maxBytes?: number) {
  let img;
  try {
    img = decodeImage(dataUrl, maxBytes);
  } catch (e) {
    throw bad((e as Error).message);
  }
  mkdirSync(fileDir(app), { recursive: true });
  const row = { id: id(), location_id: locationId, contact_id: contactId, group_id: groupId, kind, file: `${id(24)}${img.ext}`, mime: img.mime, size: img.buf.length, created_at: now() };
  writeFileSync(join(fileDir(app), row.file), img.buf);
  app.db.insert('community_files', row);
  return row;
}

/** Serves a stored image; callers check who may see it first. */
export function fileResponse(app: App, f: { file: string; mime: string }): RawResult | undefined {
  const path = join(fileDir(app), f.file);
  if (!existsSync(path)) return undefined;
  return {
    __raw: true,
    status: 200,
    headers: { 'content-type': f.mime, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'", 'content-disposition': 'inline' },
    body: readFileSync(path),
  };
}

export function removeFiles(app: App, ids: string[]) {
  for (const fid of ids) {
    const f = app.db.get('SELECT * FROM community_files WHERE id = ?', fid);
    if (!f) continue;
    rmSync(join(fileDir(app), f.file), { force: true });
    app.db.run('DELETE FROM community_files WHERE id = ?', fid);
  }
}

// --- membership, points & levels ------------------------------------------------------------

/** First visit: the member joins the group (trigger „Mitglied ist Gruppe beigetreten“). */
export function joinGroup(app: App, g: any, contact: Contact): boolean {
  const r = app.db.run('INSERT OR IGNORE INTO community_members (group_id, contact_id, location_id, joined_at, last_seen_at) VALUES (?, ?, ?, ?, ?)', g.id, contact.id, g.location_id, now(), now());
  if (!r.changes) {
    app.db.run('UPDATE community_members SET last_seen_at = ? WHERE group_id = ? AND contact_id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)', now(), g.id, contact.id, new Date(Date.now() - 5 * 60_000).toISOString());
    return false;
  }
  ensureProfile(app, g.location_id, contact);
  logActivity(app, g.location_id, contact.id, 'community.joined', `Community-Gruppe „${g.name}“ beigetreten`);
  app.events.emit(g.location_id, 'community.member_joined', { contactId: contact.id, groupId: g.id, group: { id: g.id, name: g.name } });
  return true;
}

/** Gives points and handles level-ups: one event per level, notification, course unlocks. */
export function award(app: App, g: any, contactId: string, points: number, reason: string, targetId: string, actorId = '') {
  if (!points) return;
  app.db.insert('community_points', { id: id(), location_id: g.location_id, group_id: g.id, contact_id: contactId, points, reason, target_id: targetId, actor_id: actorId, created_at: now() });
  checkLevel(app, g, contactId);
}

export function checkLevel(app: App, g: any, contactId: string) {
  const s = groupSettings(g);
  const member = app.db.get('SELECT level FROM community_members WHERE group_id = ? AND contact_id = ?', g.id, contactId);
  if (!member) return;
  const lvl = levelFor(memberPoints(app, g.id, contactId), s.levels);
  if (lvl <= member.level) return;
  app.db.run('UPDATE community_members SET level = ? WHERE group_id = ? AND contact_id = ?', lvl, g.id, contactId);
  for (let l = member.level + 1; l <= lvl; l++) {
    const name = s.levels[l - 1]?.name ?? `Level ${l}`;
    logActivity(app, g.location_id, contactId, 'community.level', `Community „${g.name}“: ${name} erreicht`);
    app.events.emit(g.location_id, 'community.level_reached', { contactId, groupId: g.id, level: l, level_name: name, group: { id: g.id, name: g.name } });
    notify(app, g, [contactId], { kind: 'level', text: `Glückwunsch! Du hast ${name} erreicht.` });
    for (const u of s.level_unlocks.filter((x) => x.level === l)) {
      try {
        grantAccess(app, g.location_id, u.course_id, contactId, 'community', g.id);
      } catch (e) {
        console.error('[community] level unlock', (e as Error).message);
      }
    }
  }
}

/** Posts or comments per member and hour (0 = no limit). */
export function checkRate(app: App, g: any, contactId: string, kind: 'post' | 'comment') {
  const s = groupSettings(g);
  const max = kind === 'post' ? s.posts_per_hour : s.comments_per_hour;
  if (!max) return;
  const table = kind === 'post' ? 'community_posts' : 'community_comments';
  const n = app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE group_id = ? AND contact_id = ? AND created_at > ?`, g.id, contactId, new Date(Date.now() - 36e5).toISOString())!.n;
  if (n >= max) throw new HttpError(429, kind === 'post' ? `Du kannst höchstens ${max} Beiträge pro Stunde schreiben – bitte später noch einmal.` : `Du kannst höchstens ${max} Kommentare pro Stunde schreiben – bitte später noch einmal.`);
}

// --- notifications ---------------------------------------------------------------------------

export function notify(app: App, g: any, contactIds: Iterable<string>, n: { kind: string; text: string; postId?: string; commentId?: string; actor?: string; quiet?: boolean }) {
  const sent: string[] = [];
  for (const cid of new Set(contactIds)) {
    if (n.kind === 'like' && app.db.get('SELECT 1 FROM community_notifications WHERE contact_id = ? AND kind = ? AND post_id IS ? AND comment_id IS ? AND read_at IS NULL', cid, 'like', n.postId ?? null, n.commentId ?? null)) continue;
    app.db.insert('community_notifications', { id: id(), location_id: g.location_id, contact_id: cid, group_id: g.id, kind: n.kind, post_id: n.postId ?? null, comment_id: n.commentId ?? null, actor: n.actor ?? '', text: n.text.slice(0, 300), created_at: now() });
    sent.push(cid);
  }
  // Web push and other channels of the extensions follow the bell.
  if (sent.length) for (const fn of communityUi(app).notified) fn(g, sent, n);
}

/** Only members that may still see the group get told about it. */
function stillMembers(app: App, g: any, ids: Iterable<string>): string[] {
  const out: string[] = [];
  for (const cid of new Set(ids)) {
    const c = getContact(app, g.location_id, cid);
    if (c && groupAccess(app, g, c) === 'ok') out.push(cid);
  }
  return out;
}

/** @handles in the text that belong to members who can see the group. */
function mentioned(app: App, g: any, text: string): string[] {
  const handles = mentionHandles(text);
  if (!handles.length) return [];
  const rows = app.db.all<{ contact_id: string }>(`SELECT contact_id FROM community_profiles WHERE location_id = ? AND handle IN (${handles.map(() => '?').join(',')})`, g.location_id, ...handles);
  return stillMembers(app, g, rows.map((r) => r.contact_id));
}

export const authorName = (app: App, locationId: string, a: Author) => (a.kind === 'team' ? a.name || 'Team' : ensureProfile(app, locationId, a.contact).display_name);

export function markRead(app: App, contactId: string, postId: string) {
  app.db.run('INSERT INTO community_reads (post_id, contact_id, read_at) VALUES (?, ?, ?) ON CONFLICT(contact_id, post_id) DO UPDATE SET read_at = excluded.read_at', postId, contactId, now());
}

// --- posts & comments ---------------------------------------------------------------------------

function cleanText(g: any, text: string, field: string, max: number, required: boolean, filter: boolean): string {
  const s = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!s && required) throw bad(`${field} fehlt`);
  if (s.length > max) throw bad(`${field} ist zu lang (höchstens ${max} Zeichen)`);
  if (!filter) return s;
  const st = groupSettings(g);
  const r = applyWordFilter(s, st.word_filter, st.filter_mode);
  if (r.blocked) throw bad('Dein Text enthält Wörter, die in dieser Gruppe nicht erlaubt sind.');
  return r.text;
}

export function getPost(app: App, groupId: string, postId: string) {
  return parseJson(app.db.get('SELECT * FROM community_posts WHERE id = ? AND group_id = ?', postId, groupId), ['images']);
}

export function createPost(app: App, g: any, channel: any, author: Author, input: { title?: unknown; body?: unknown; images?: string[] }, opts: { pinned?: boolean; notifyAll?: boolean; bypassLock?: boolean } = {}) {
  const member = author.kind === 'member';
  if (member) {
    if (channel.admin_only && !opts.bypassLock) throw new HttpError(403, 'In diesem Kanal schreibt nur das Team.');
    checkRate(app, g, author.contact.id, 'post');
  }
  const title = cleanText(g, String(input.title ?? ''), 'Titel', TITLE_MAX, true, member);
  const body = cleanText(g, String(input.body ?? ''), 'Text', BODY_MAX, false, member);
  const images = (input.images ?? []).slice(0, MAX_POST_IMAGES + 1);
  if (images.length > MAX_POST_IMAGES) throw bad(`Höchstens ${MAX_POST_IMAGES} Bilder pro Beitrag`);
  const name = authorName(app, g.location_id, author);
  const post = {
    id: id(),
    location_id: g.location_id,
    group_id: g.id,
    channel_id: channel.id,
    contact_id: member ? author.contact.id : null,
    user_id: member ? null : author.userId,
    author_name: name,
    title,
    body,
    images: [] as string[],
    pinned: opts.pinned && !member ? 1 : 0,
    created_at: now(),
    updated_at: now(),
    last_activity_at: now(),
  };
  app.db.tx(() => {
    post.images = images.map((d) => saveImage(app, g.location_id, member ? author.contact.id : null, g.id, 'post', d).id);
    app.db.insert('community_posts', post);
    if (member) {
      app.db.run('INSERT OR IGNORE INTO community_follows (post_id, contact_id, created_at) VALUES (?, ?, ?)', post.id, author.contact.id, now());
      markRead(app, author.contact.id, post.id);
    }
  });
  if (member) {
    award(app, g, author.contact.id, groupSettings(g).points.post, 'post', post.id);
    logActivity(app, g.location_id, author.contact.id, 'community.post', `Community-Beitrag „${title}“ in „${g.name}“`);
  }
  const short = title.length > 60 ? `${title.slice(0, 60)}…` : title;
  const tagged = mentioned(app, g, `${title}\n${body}`).filter((c) => c !== post.contact_id);
  notify(app, g, tagged, { kind: 'mention', postId: post.id, actor: name, text: `${name} hat dich in „${short}“ erwähnt` });
  if (opts.notifyAll && !member) {
    const all = app.db.all<{ contact_id: string }>('SELECT contact_id FROM community_members WHERE group_id = ? AND banned_at IS NULL', g.id).map((r) => r.contact_id);
    notify(app, g, stillMembers(app, g, all).filter((c) => !tagged.includes(c)), { kind: 'announcement', postId: post.id, actor: name, text: `${name}: „${short}“` });
  }
  app.events.emit(g.location_id, 'community.post_created', {
    ...(member ? { contactId: author.contact.id } : {}),
    groupId: g.id,
    channelId: channel.id,
    postId: post.id,
    post: { id: post.id, title, channel: channel.name, by_team: !member },
    group: { id: g.id, name: g.name },
  });
  return getPost(app, g.id, post.id)!;
}

export function editPost(app: App, g: any, post: any, input: { title?: unknown; body?: unknown }, byTeam: boolean) {
  const patch: Record<string, any> = { updated_at: now(), edited_at: now() };
  if (input.title !== undefined) patch.title = cleanText(g, String(input.title ?? ''), 'Titel', TITLE_MAX, true, !byTeam);
  if (input.body !== undefined) patch.body = cleanText(g, String(input.body ?? ''), 'Text', BODY_MAX, false, !byTeam);
  app.db.update('community_posts', post.id, patch);
  return getPost(app, g.id, post.id)!;
}

export function addComment(app: App, g: any, post: any, author: Author, input: { body?: unknown; parent_id?: unknown }) {
  const member = author.kind === 'member';
  if (post.status !== 'visible') throw bad('Dieser Beitrag ist ausgeblendet.');
  if (member) checkRate(app, g, author.contact.id, 'comment');
  const body = cleanText(g, String(input.body ?? ''), 'Kommentar', COMMENT_MAX, true, member);
  // One level of threads: a reply to a reply goes under the same top-level comment.
  const direct = input.parent_id ? app.db.get('SELECT * FROM community_comments WHERE id = ? AND post_id = ?', String(input.parent_id), post.id) : undefined;
  if (input.parent_id && !direct) throw bad('Kommentar nicht gefunden');
  const parent = direct?.parent_id ? app.db.get('SELECT * FROM community_comments WHERE id = ?', direct.parent_id) : direct;
  if (parent && parent.status !== 'visible') throw bad('Auf diesen Kommentar kann man nicht mehr antworten.');
  const name = authorName(app, g.location_id, author);
  const c = {
    id: id(),
    location_id: g.location_id,
    group_id: g.id,
    post_id: post.id,
    parent_id: parent?.id ?? null,
    contact_id: member ? author.contact.id : null,
    user_id: member ? null : author.userId,
    author_name: name,
    body,
    created_at: now(),
    updated_at: now(),
  };
  app.db.tx(() => {
    app.db.insert('community_comments', c);
    app.db.run(`UPDATE community_posts SET comment_count = (SELECT COUNT(*) FROM community_comments WHERE post_id = ? AND status = 'visible'), last_activity_at = ? WHERE id = ?`, post.id, now(), post.id);
    if (member) {
      app.db.run('INSERT OR IGNORE INTO community_follows (post_id, contact_id, created_at) VALUES (?, ?, ?)', post.id, author.contact.id, now());
      markRead(app, author.contact.id, post.id);
    }
  });
  if (member) award(app, g, author.contact.id, groupSettings(g).points.comment, 'comment', c.id);
  const me = member ? author.contact.id : '';
  const short = post.title.length > 50 ? `${post.title.slice(0, 50)}…` : post.title;
  const tagged = new Set(mentioned(app, g, body).filter((x) => x !== me));
  notify(app, g, tagged, { kind: 'mention', postId: post.id, commentId: c.id, actor: name, text: `${name} hat dich in einem Kommentar zu „${short}“ erwähnt` });
  // The author of the comment that was answered (before flattening) hears about the reply.
  const replyTo = direct?.contact_id && direct.contact_id !== me && !tagged.has(direct.contact_id) ? stillMembers(app, g, [direct.contact_id]) : [];
  notify(app, g, replyTo, { kind: 'reply', postId: post.id, commentId: c.id, actor: name, text: `${name} hat auf deinen Kommentar zu „${short}“ geantwortet` });
  const followers = app.db.all<{ contact_id: string }>('SELECT contact_id FROM community_follows WHERE post_id = ?', post.id).map((r) => r.contact_id);
  const rest = followers.filter((x) => x !== me && !tagged.has(x) && !replyTo.includes(x));
  notify(app, g, stillMembers(app, g, rest), { kind: 'comment', postId: post.id, commentId: c.id, actor: name, text: `${name} hat „${short}“ kommentiert` });
  return c;
}

/** Like / unlike a post or comment; the author gets (or loses) the like points. */
export function toggleLike(app: App, g: any, kind: 'post' | 'comment', target: any, contact: Contact): { liked: boolean; count: number } {
  if (target.contact_id === contact.id) throw bad('Eigene Beiträge kann man nicht liken.');
  if (target.status !== 'visible') throw bad('Ausgeblendet.');
  const table = kind === 'post' ? 'community_posts' : 'community_comments';
  const had = app.db.get('SELECT 1 FROM community_likes WHERE target_id = ? AND contact_id = ?', target.id, contact.id);
  app.db.tx(() => {
    if (had) app.db.run('DELETE FROM community_likes WHERE target_id = ? AND contact_id = ?', target.id, contact.id);
    else app.db.insert('community_likes', { target_id: target.id, contact_id: contact.id, kind, group_id: g.id, created_at: now() });
    app.db.run(`UPDATE ${table} SET like_count = (SELECT COUNT(*) FROM community_likes WHERE target_id = ?) WHERE id = ?`, target.id, target.id);
  });
  if (target.contact_id) {
    if (had) app.db.run(`DELETE FROM community_points WHERE reason = 'like' AND target_id = ? AND actor_id = ?`, target.id, contact.id);
    else {
      award(app, g, target.contact_id, groupSettings(g).points.like, 'like', target.id, contact.id);
      const name = ensureProfile(app, g.location_id, contact).display_name;
      const post = kind === 'post' ? target : app.db.get('SELECT id, title FROM community_posts WHERE id = ?', target.post_id);
      const short = post.title.length > 50 ? `${post.title.slice(0, 50)}…` : post.title;
      notify(app, g, stillMembers(app, g, [target.contact_id]), { kind: 'like', postId: post.id, commentId: kind === 'comment' ? target.id : undefined, actor: name, text: kind === 'post' ? `${name} gefällt dein Beitrag „${short}“` : `${name} gefällt dein Kommentar zu „${short}“` });
    }
  }
  const count = app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM community_likes WHERE target_id = ?', target.id)!.n;
  return { liked: !had, count };
}

export function toggleFollow(app: App, postId: string, contactId: string): boolean {
  if (app.db.run('DELETE FROM community_follows WHERE post_id = ? AND contact_id = ?', postId, contactId).changes) return false;
  app.db.run('INSERT INTO community_follows (post_id, contact_id, created_at) VALUES (?, ?, ?)', postId, contactId, now());
  return true;
}

// --- moderation ---------------------------------------------------------------------------

const recount = (app: App, postId: string) =>
  app.db.run(`UPDATE community_posts SET comment_count = (SELECT COUNT(*) FROM community_comments WHERE post_id = ? AND status = 'visible') WHERE id = ?`, postId, postId);

export function setHidden(app: App, kind: 'post' | 'comment', target: any, hidden: boolean, reason = '') {
  if (kind === 'post') app.db.run('UPDATE community_posts SET status = ?, hidden_reason = ?, pinned = CASE WHEN ? THEN 0 ELSE pinned END WHERE id = ?', hidden ? 'hidden' : 'visible', hidden ? reason : '', hidden ? 1 : 0, target.id);
  else {
    app.db.run('UPDATE community_comments SET status = ? WHERE id = ?', hidden ? 'hidden' : 'visible', target.id);
    recount(app, target.post_id);
  }
}

export function deletePost(app: App, post: any) {
  for (const h of communityUi(app).postExtras) h.remove?.(post);
  const comments = app.db.all<{ id: string }>('SELECT id FROM community_comments WHERE post_id = ?', post.id).map((r) => r.id);
  const targets = [post.id, ...comments];
  app.db.tx(() => {
    app.db.run(`DELETE FROM community_points WHERE target_id IN (${targets.map(() => '?').join(',')})`, ...targets);
    app.db.run(`DELETE FROM community_likes WHERE target_id IN (${targets.map(() => '?').join(',')})`, ...targets);
    app.db.run(`DELETE FROM community_reports WHERE target_id IN (${targets.map(() => '?').join(',')})`, ...targets);
    app.db.run('DELETE FROM community_notifications WHERE post_id = ?', post.id);
    app.db.run('DELETE FROM community_posts WHERE id = ?', post.id);
  });
  removeFiles(app, parseJson({ ...post }, ['images']).images ?? []);
}

export function deleteComment(app: App, comment: any) {
  const targets = [comment.id, ...app.db.all<{ id: string }>('SELECT id FROM community_comments WHERE parent_id = ?', comment.id).map((r) => r.id)];
  app.db.tx(() => {
    app.db.run(`DELETE FROM community_points WHERE target_id IN (${targets.map(() => '?').join(',')})`, ...targets);
    app.db.run(`DELETE FROM community_likes WHERE target_id IN (${targets.map(() => '?').join(',')})`, ...targets);
    app.db.run(`DELETE FROM community_reports WHERE target_id IN (${targets.map(() => '?').join(',')})`, ...targets);
    app.db.run(`DELETE FROM community_notifications WHERE comment_id IN (${targets.map(() => '?').join(',')})`, ...targets);
    app.db.run('DELETE FROM community_comments WHERE id = ?', comment.id);
    recount(app, comment.post_id);
  });
}

/** A member reports a post or comment; enough reports hide it until the team looks at it. */
export function report(app: App, g: any, kind: 'post' | 'comment', target: any, contactId: string, reason: unknown): { created: boolean; hidden: boolean } {
  if (target.contact_id === contactId) throw bad('Eigene Beiträge kann man nicht melden.');
  const r = app.db.run(
    'INSERT OR IGNORE INTO community_reports (id, location_id, group_id, kind, target_id, contact_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id(),
    g.location_id,
    g.id,
    kind,
    target.id,
    contactId,
    String(reason ?? '').trim().slice(0, 500),
    now(),
  );
  const open = app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM community_reports WHERE target_id = ? AND status = 'open'`, target.id)!.n;
  const limit = groupSettings(g).auto_hide_reports;
  let hidden = false;
  if (r.changes && limit && open >= limit && target.status === 'visible') {
    setHidden(app, kind, target, true, `${open} Meldungen`);
    hidden = true;
  }
  if (r.changes) logActivity(app, g.location_id, contactId, 'community.report', `${kind === 'post' ? 'Beitrag' : 'Kommentar'} in „${g.name}“ gemeldet`);
  return { created: r.changes > 0, hidden };
}

export function setBan(app: App, g: any, contactId: string, ban: boolean, opts: { reason?: string; by?: string; hideContent?: boolean } = {}) {
  if (ban) {
    app.db.run(
      `INSERT INTO community_members (group_id, contact_id, location_id, joined_at, banned_at, ban_reason, banned_by) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(group_id, contact_id) DO UPDATE SET banned_at = excluded.banned_at, ban_reason = excluded.ban_reason, banned_by = excluded.banned_by`,
      g.id,
      contactId,
      g.location_id,
      now(),
      now(),
      String(opts.reason ?? '').slice(0, 300),
      opts.by ?? '',
    );
    if (opts.hideContent) {
      app.db.run(`UPDATE community_posts SET status = 'hidden', hidden_reason = 'Mitglied gesperrt', pinned = 0 WHERE group_id = ? AND contact_id = ?`, g.id, contactId);
      const posts = app.db.all<{ post_id: string }>(`SELECT DISTINCT post_id FROM community_comments WHERE group_id = ? AND contact_id = ?`, g.id, contactId);
      app.db.run(`UPDATE community_comments SET status = 'hidden' WHERE group_id = ? AND contact_id = ?`, g.id, contactId);
      for (const p of posts) recount(app, p.post_id);
    }
    logActivity(app, g.location_id, contactId, 'community.banned', `Aus Community-Gruppe „${g.name}“ ausgeschlossen${opts.reason ? ` (${opts.reason})` : ''}`);
  } else {
    app.db.run(`UPDATE community_members SET banned_at = NULL, ban_reason = '', banned_by = '' WHERE group_id = ? AND contact_id = ?`, g.id, contactId);
    logActivity(app, g.location_id, contactId, 'community.unbanned', `Sperre in Community-Gruppe „${g.name}“ aufgehoben`);
  }
}

// --- daily digest ---------------------------------------------------------------------------

export interface CommunityConfig {
  digest_enabled: boolean;
  /** Local hour (0–23) from which the daily digest goes out. */
  digest_hour: number;
}
export const DEFAULT_CONFIG: CommunityConfig = { digest_enabled: true, digest_hour: 7 };

export function communityConfig(app: App, locationId: string): CommunityConfig {
  const row = parseJson(app.db.get('SELECT settings FROM community_config WHERE location_id = ?', locationId), ['settings']);
  return { ...DEFAULT_CONFIG, ...(row?.settings ?? {}) };
}

const DIGEST_KINDS = ['comment', 'reply', 'mention', 'announcement', 'level', 'event', 'dm', 'badge', 'challenge', 'perk'];

/**
 * Once a day (from the configured hour, in the sub-account's time zone) every member with unread
 * notifications that weren't mailed yet gets one summary email through the sub-account's SMTP.
 */
export async function runDigest(app: App, at = new Date(), portalUrl: (locationId: string) => string): Promise<number> {
  const mailer = (loc: LocationRow, mail: OutMail) => (app.services.communityMailer ?? deliverEmail)(loc, mail);
  let sent = 0;
  const locs = app.db.all<{ location_id: string }>(
    `SELECT DISTINCT location_id FROM community_notifications WHERE emailed_at IS NULL AND read_at IS NULL AND kind IN (${DIGEST_KINDS.map(() => '?').join(',')})`,
    ...DIGEST_KINDS,
  );
  for (const { location_id } of locs) {
    const cfg = communityConfig(app, location_id);
    const loc = app.location(location_id);
    if (!loc || !cfg.digest_enabled) continue;
    const tz = loc.timezone || 'Europe/Berlin';
    if (Number(hmInTz(at, tz).slice(0, 2)) < cfg.digest_hour) continue;
    const today = ymdInTz(at, tz);
    const people = app.db.all<{ contact_id: string }>(
      `SELECT DISTINCT contact_id FROM community_notifications WHERE location_id = ? AND emailed_at IS NULL AND read_at IS NULL AND kind IN (${DIGEST_KINDS.map(() => '?').join(',')})`,
      location_id,
      ...DIGEST_KINDS,
    );
    const base = portalUrl(location_id);
    const brand = loc.settings?.branding?.name || loc.name;
    for (const { contact_id } of people) {
      const contact = getContact(app, location_id, contact_id);
      const profile = profileOf(app, location_id, contact_id);
      if (!contact?.email || contact.dnd || (profile && !profile.digest)) continue;
      if (profile?.last_digest_at && ymdInTz(new Date(profile.last_digest_at), tz) === today) continue;
      const items = parseRows(
        app.db.all(
          `SELECT n.*, g.name AS group_name FROM community_notifications n LEFT JOIN community_groups g ON g.id = n.group_id
           WHERE n.location_id = ? AND n.contact_id = ? AND n.emailed_at IS NULL AND n.read_at IS NULL AND n.kind IN (${DIGEST_KINDS.map(() => '?').join(',')}) ORDER BY n.created_at DESC`,
          location_id,
          contact_id,
          ...DIGEST_KINDS,
        ),
        [],
      );
      if (!items.length) continue;
      const link = (n: any) => `${base}/community/notifications/${encodeURIComponent(n.id)}`;
      const shown = items.slice(0, 20);
      const hello = contact.first_name ? `Hallo ${contact.first_name}` : 'Hallo';
      const text = `${hello},\n\ndas ist neu in der Community:\n\n${shown.map((n) => `• ${n.text}${n.group_name ? ` (${n.group_name})` : ''}\n  ${link(n)}`).join('\n')}${items.length > shown.length ? `\n…und ${items.length - shown.length} weitere.` : ''}\n\nAlle Benachrichtigungen: ${base}/community/notifications\nDiese Zusammenfassung abbestellen: ${base}/community/profile\n\n${brand}`;
      const htmlMail = `<!doctype html><html><body style="margin:0;background:#f6f7fb;font-family:Arial,sans-serif;color:#0f172a"><div style="max-width:560px;margin:0 auto;padding:28px 18px"><div style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:26px">
<h2 style="margin:0 0 6px;font-size:20px">Neu in der Community</h2><p style="margin:0 0 18px;color:#64748b">${escapeHtml(hello)}, das ist seit gestern passiert:</p>
${shown.map((n) => `<p style="margin:0 0 12px;line-height:1.45"><a href="${escapeHtml(link(n))}" style="color:#0f172a;text-decoration:none"><strong>${escapeHtml(n.text)}</strong></a>${n.group_name ? `<br><span style="font-size:13px;color:#64748b">${escapeHtml(n.group_name)}</span>` : ''}</p>`).join('')}
${items.length > shown.length ? `<p style="color:#64748b">…und ${items.length - shown.length} weitere.</p>` : ''}
<p style="margin:22px 0 0"><a href="${escapeHtml(`${base}/community/notifications`)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-weight:bold;padding:11px 20px;border-radius:10px">Zur Community</a></p>
</div><p style="font-size:12px;color:#94a3b8;text-align:center">${escapeHtml(brand)} · <a href="${escapeHtml(`${base}/community/profile`)}" style="color:#94a3b8">Zusammenfassung abbestellen</a></p></div></body></html>`;
      try {
        await mailer(loc, { to: contact.email, subject: `${items.length} ${items.length === 1 ? 'Neuigkeit' : 'Neuigkeiten'} in der Community`, text, html: htmlMail });
      } catch (e) {
        console.error('[community] digest', (e as Error).message);
        continue;
      }
      app.db.run(`UPDATE community_notifications SET emailed_at = ? WHERE location_id = ? AND contact_id = ? AND emailed_at IS NULL AND read_at IS NULL`, now(), location_id, contact_id);
      ensureProfile(app, location_id, contact);
      app.db.run('UPDATE community_profiles SET last_digest_at = ? WHERE location_id = ? AND contact_id = ?', at.toISOString(), location_id, contact_id);
      sent++;
    }
  }
  return sent;
}
