import type { App, Module } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { bad, notFound, num, str, type Ctx } from '../core/http.js';
import { formatInTz } from '../core/time.js';
import { id, now, slugify } from '../core/util.js';
import { getContact } from '../services/contacts.js';
import { portalUrl } from '../services/courses.js';
import { cleanGroupAccess, cleanGroupSettings, getGroup, groupSettings, leaderboard, levelFor, memberPoints, PERIODS, type Period } from '../services/community.js';
import {
  DEFAULT_CONFIG,
  addComment,
  communityConfig,
  createPost,
  deleteComment,
  deletePost,
  editPost,
  fileResponse,
  getPost,
  notify,
  removeFiles,
  runDigest,
  setBan,
  setHidden,
  type Author,
} from '../services/community-actions.js';
import { communityUi } from '../services/community-ui.js';
import type { SnapshotPart } from '../services/snapshots.js';
import type { Tool } from './mcp.js';

/**
 * Community (like GHL Communities / Skool light), admin side: groups per sub-account with channels,
 * access by member area / course / tag, moderation (reports, hide, delete, ban, word filter, rate
 * limits), points & levels with leaderboard, community events, the daily digest, MCP tools and
 * workflow triggers. The member pages live in community-portal.ts, shared rules in
 * services/community.ts and services/community-actions.ts.
 */

const TOOLS: Tool[] = [
  {
    name: 'ghl_list_community_posts',
    title: 'Community-Beiträge',
    description: 'Neueste Beiträge der Community-Gruppen eines Projekts (ohne group_id: alle Gruppen) mit Gruppe, Kanal, Autor, Likes, Kommentaren und Status (visible, hidden).',
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'string', description: 'Sub-Account/Projekt-ID' },
        group_id: { type: 'string', description: 'Gruppen-ID (aus GET /api/community/groups)' },
        channel_id: { type: 'string' },
        status: { type: 'string', enum: ['visible', 'hidden'] },
        limit: { type: 'number', description: 'Standard 20, höchstens 100' },
      },
      required: ['location_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => {
      const qs = new URLSearchParams();
      for (const k of ['group_id', 'channel_id', 'status', 'limit']) if (a[k] !== undefined && a[k] !== '') qs.set(k, String(a[k]));
      return call.api('GET', `/api/community/posts${qs.size ? `?${qs}` : ''}`, { location: a.location_id });
    },
  },
  {
    name: 'ghl_create_community_post',
    title: 'Community-Beitrag schreiben',
    description:
      'Schreibt einen Beitrag als Team (Admin) in eine Community-Gruppe. body ist Markdown (**fett**, Listen, [Link](https://…)); @handle erwähnt Mitglieder. Ohne channel_id landet er im ersten Kanal. pinned heftet ihn oben an, notify benachrichtigt alle Mitglieder der Gruppe.',
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'string' },
        group_id: { type: 'string' },
        channel_id: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string', description: 'Markdown' },
        pinned: { type: 'boolean' },
        notify: { type: 'boolean' },
      },
      required: ['location_id', 'group_id', 'title', 'body'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: (call, a) =>
      call.api('POST', `/api/community/groups/${encodeURIComponent(a.group_id)}/posts`, {
        location: a.location_id,
        body: { channel_id: a.channel_id, title: a.title, body: a.body, pinned: !!a.pinned, notify: !!a.notify },
      }),
  },
];

const TRIGGERS = ['community.post_created', 'community.member_joined', 'community.level_reached'];

const cleanImage = (v: unknown, field = 'Bild') => {
  const s = str(v, field, { max: 1000 });
  if (s && !/^(https?:\/\/|\/)[^\s]*$/i.test(s)) throw bad(`${field}: bitte eine https://-Adresse`);
  return s;
};
const cleanLink = (v: unknown) => {
  const s = str(v, 'Link', { max: 1000 });
  if (s && !/^https:\/\/[^\s]+$/i.test(s)) throw bad('Link muss mit https:// beginnen (z. B. Zoom oder Jitsi)');
  return s;
};
const isoOf = (v: unknown, field: string) => {
  const t = Date.parse(String(v ?? ''));
  if (Number.isNaN(t)) throw bad(`${field}: ungültiges Datum`);
  return new Date(t).toISOString();
};

/** The ids of a sub-account's groups, channels and so on, checked in one place. */
function lookups(app: App) {
  const { db } = app;
  const mustGroup = (loc: string, gid: string) => {
    const g = getGroup(app, loc, gid);
    if (!g) throw notFound('Gruppe nicht gefunden');
    return g;
  };
  const mustChannel = (g: any, cid: string) => {
    const c = db.get('SELECT * FROM community_channels WHERE id = ? AND group_id = ?', cid, g.id);
    if (!c) throw notFound('Kanal nicht gefunden');
    return c;
  };
  const mustPost = (loc: string, pid: string) => {
    const p = parseJson(db.get('SELECT * FROM community_posts WHERE id = ? AND location_id = ?', pid, loc), ['images']);
    if (!p) throw notFound('Beitrag nicht gefunden');
    return { post: p, group: mustGroup(loc, p.group_id) };
  };
  const mustComment = (loc: string, cid: string) => {
    const c = db.get('SELECT * FROM community_comments WHERE id = ? AND location_id = ?', cid, loc);
    if (!c) throw notFound('Kommentar nicht gefunden');
    return { comment: c, group: mustGroup(loc, c.group_id) };
  };
  return { mustGroup, mustChannel, mustPost, mustComment };
}

export const communityModule: Module = {
  name: 'community',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE community_groups (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, slug TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', cover_image TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active', position INTEGER NOT NULL DEFAULT 0,
        access TEXT NOT NULL DEFAULT '{}', settings TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(location_id, slug)
      );
      CREATE TABLE community_channels (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
        name TEXT NOT NULL, slug TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '',
        emoji TEXT NOT NULL DEFAULT '', admin_only INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(group_id, slug)
      );
      CREATE TABLE community_members (
        group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        joined_at TEXT NOT NULL, last_seen_at TEXT, level INTEGER NOT NULL DEFAULT 1,
        banned_at TEXT, ban_reason TEXT NOT NULL DEFAULT '', banned_by TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (group_id, contact_id)
      );
      CREATE TABLE community_profiles (
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        handle TEXT NOT NULL, display_name TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '', avatar_file_id TEXT,
        digest INTEGER NOT NULL DEFAULT 1, last_digest_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (location_id, contact_id), UNIQUE (location_id, handle)
      );
      CREATE TABLE community_posts (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL REFERENCES community_channels(id) ON DELETE CASCADE,
        contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE, user_id TEXT, author_name TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', images TEXT NOT NULL DEFAULT '[]',
        pinned INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'visible', hidden_reason TEXT NOT NULL DEFAULT '',
        like_count INTEGER NOT NULL DEFAULT 0, comment_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, edited_at TEXT, last_activity_at TEXT NOT NULL
      );
      CREATE INDEX community_posts_feed ON community_posts(group_id, status, pinned, last_activity_at);
      CREATE INDEX community_posts_author ON community_posts(contact_id, created_at);
      CREATE TABLE community_comments (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
        post_id TEXT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
        parent_id TEXT REFERENCES community_comments(id) ON DELETE CASCADE,
        contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE, user_id TEXT, author_name TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'visible', like_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX community_comments_post ON community_comments(post_id, created_at);
      CREATE INDEX community_comments_author ON community_comments(contact_id, created_at);
      CREATE TABLE community_likes (
        target_id TEXT NOT NULL, contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL, PRIMARY KEY (target_id, contact_id)
      );
      CREATE TABLE community_points (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, points INTEGER NOT NULL, reason TEXT NOT NULL,
        target_id TEXT NOT NULL DEFAULT '', actor_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      );
      CREATE INDEX community_points_board ON community_points(group_id, created_at);
      CREATE INDEX community_points_member ON community_points(group_id, contact_id);
      CREATE INDEX community_points_target ON community_points(target_id);
      CREATE TABLE community_follows (
        post_id TEXT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL, PRIMARY KEY (post_id, contact_id)
      );
      CREATE TABLE community_reads (
        post_id TEXT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        read_at TEXT NOT NULL, PRIMARY KEY (contact_id, post_id)
      );
      CREATE TABLE community_notifications (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        group_id TEXT REFERENCES community_groups(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, post_id TEXT, comment_id TEXT, actor TEXT NOT NULL DEFAULT '', text TEXT NOT NULL,
        created_at TEXT NOT NULL, read_at TEXT, emailed_at TEXT
      );
      CREATE INDEX community_notifications_member ON community_notifications(location_id, contact_id, read_at, created_at);
      CREATE TABLE community_reports (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, target_id TEXT NOT NULL, contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
        reason TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open', action TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, resolved_at TEXT, resolved_by TEXT NOT NULL DEFAULT '',
        UNIQUE (target_id, contact_id)
      );
      CREATE TABLE community_events (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
        title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,
        link TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX community_events_group ON community_events(group_id, starts_at);
      CREATE TABLE community_files (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        contact_id TEXT, group_id TEXT, kind TEXT NOT NULL, file TEXT NOT NULL, mime TEXT NOT NULL,
        size INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE community_config (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
        settings TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const ui = communityUi(app);
    const { mustGroup, mustChannel, mustPost, mustComment } = lookups(app);
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    app.services.workflowTriggers = [...(app.services.workflowTriggers ?? []), ...TRIGGERS];

    // GDPR erasure: other members' bell entries name the person ("Anna M. hat … kommentiert") and quote what it wrote – those about
    // its posts and comments, and those it is the actor of, go with it (its own entries go with the contact).
    app.services.privacyErase = [
      ...(app.services.privacyErase ?? []),
      (_a: unknown, loc: string, c: { id: string; first_name?: string; last_name?: string }) => {
        const names = new Set([db.get<{ display_name: string }>('SELECT display_name FROM community_profiles WHERE location_id = ? AND contact_id = ?', loc, c.id)?.display_name ?? '', [c.first_name, c.last_name].filter(Boolean).join(' ')].map((n) => n.trim()).filter((n) => n.length >= 3));
        db.run(
          `DELETE FROM community_notifications WHERE location_id = ? AND (post_id IN (SELECT id FROM community_posts WHERE location_id = ? AND contact_id = ?) OR comment_id IN (SELECT id FROM community_comments WHERE location_id = ? AND contact_id = ?)${[...names].map(() => ' OR actor = ?').join('')})`,
          loc,
          loc,
          c.id,
          loc,
          c.id,
          ...names,
        );
      },
    ];

    const groupUrl = (g: any) => `${portalUrl(app, g.location_id)}/community/g/${encodeURIComponent(g.slug)}`;
    const uniqueSlug = (table: 'community_groups' | 'community_channels', scope: string, base: string, except = '') => {
      const col = table === 'community_groups' ? 'location_id' : 'group_id';
      const root = slugify(base) || (table === 'community_groups' ? 'gruppe' : 'kanal');
      let slug = root;
      for (let i = 2; db.get(`SELECT id FROM ${table} WHERE ${col} = ? AND slug = ? AND id != ?`, scope, slug, except); i++) slug = `${root}-${i}`;
      return slug;
    };
    const team = (ctx: Ctx): Author => ({ kind: 'team', userId: ctx.user?.id ?? (ctx.via ?? 'api'), name: ctx.user?.name || 'Team' });
    const channels = (gid: string) => db.all('SELECT * FROM community_channels WHERE group_id = ? ORDER BY position, created_at', gid);
    const stats = (gid: string) =>
      db.get(
        `SELECT (SELECT COUNT(*) FROM community_members WHERE group_id = ? AND banned_at IS NULL) AS members,
                (SELECT COUNT(*) FROM community_posts WHERE group_id = ? AND status = 'visible') AS posts,
                (SELECT COUNT(*) FROM community_reports WHERE group_id = ? AND status = 'open') AS open_reports,
                (SELECT COUNT(*) FROM community_events WHERE group_id = ? AND ends_at >= ?) AS upcoming_events`,
        gid,
        gid,
        gid,
        gid,
        now(),
      );
    const groupOut = (g: any) => ({ ...g, settings: groupSettings(g), access: cleanGroupAccess(g.access), ...stats(g.id), url: groupUrl(g) });
    const settingsOrBad = (input: any, cur: any) => {
      try {
        return cleanGroupSettings(input, cur);
      } catch (e) {
        throw bad((e as Error).message);
      }
    };
    const checkCourses = (loc: string, ids: string[]) => {
      for (const cid of ids) if (!db.get('SELECT id FROM courses WHERE id = ? AND location_id = ?', cid, loc)) throw bad('Kurs nicht gefunden');
    };

    // --- settings (digest) --------------------------------------------------------------
    router.get('/api/community/settings', 'location', (ctx) => ({ ...communityConfig(app, ctx.locationId), portal_url: `${portalUrl(app, ctx.locationId)}/community` }));
    router.put('/api/community/settings', 'location', (ctx) => {
      const cur = communityConfig(app, ctx.locationId);
      const b = ctx.body ?? {};
      const next = {
        digest_enabled: b.digest_enabled === undefined ? cur.digest_enabled : !!b.digest_enabled,
        digest_hour: b.digest_hour === undefined ? cur.digest_hour : Math.min(Math.max(Math.round(num(b.digest_hour, DEFAULT_CONFIG.digest_hour)), 0), 23),
      };
      db.run('INSERT INTO community_config (location_id, settings, updated_at) VALUES (?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at', ctx.locationId, JSON.stringify(next), now());
      return { ...next, portal_url: `${portalUrl(app, ctx.locationId)}/community` };
    });

    // --- groups -------------------------------------------------------------------------
    router.get('/api/community/groups', 'location', (ctx) =>
      db
        .all('SELECT * FROM community_groups WHERE location_id = ? ORDER BY position, created_at', ctx.locationId)
        .map((g) => groupOut(parseJson(g, ['access', 'settings']))),
    );
    router.post('/api/community/groups', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const name = str(b.name, 'Name', { required: true, max: 120 });
      const access = cleanGroupAccess(b.access);
      checkCourses(ctx.locationId, access.course_ids);
      const g = {
        id: id(),
        location_id: ctx.locationId,
        name,
        slug: uniqueSlug('community_groups', ctx.locationId, b.slug || name),
        description: str(b.description, 'Beschreibung', { max: 2000 }),
        cover_image: cleanImage(b.cover_image, 'Titelbild'),
        status: 'active',
        position: db.get<{ n: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM community_groups WHERE location_id = ?', ctx.locationId)!.n,
        access,
        settings: settingsOrBad(b.settings, {}),
        created_at: now(),
        updated_at: now(),
      };
      db.tx(() => {
        db.insert('community_groups', g);
        // A sensible start: general chat, introductions and team-only announcements.
        const starters: [string, string, number][] = Array.isArray(b.channels) && b.channels.length ? b.channels.map((c: any) => [String(c?.name ?? c), '', c?.admin_only ? 1 : 0]) : [['Allgemein', '💬', 0], ['Vorstellungsrunde', '👋', 0], ['Ankündigungen', '📣', 1]];
        starters.slice(0, 20).forEach(([cname, emoji, adminOnly], i) => {
          const n = String(cname).trim().slice(0, 60) || `Kanal ${i + 1}`;
          db.insert('community_channels', { id: id(), location_id: ctx.locationId, group_id: g.id, name: n, slug: uniqueSlug('community_channels', g.id, n), emoji, admin_only: adminOnly, position: i, created_at: now(), updated_at: now() });
        });
      });
      return { ...groupOut(getGroup(app, ctx.locationId, g.id)), channels: channels(g.id) };
    });
    router.get('/api/community/groups/:id', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      return { ...groupOut(g), channels: channels(g.id) };
    });
    router.patch('/api/community/groups/:id', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      const b = ctx.body ?? {};
      const patch: Record<string, any> = { updated_at: now() };
      if (b.name !== undefined) patch.name = str(b.name, 'Name', { required: true, max: 120 });
      if (b.slug !== undefined) patch.slug = uniqueSlug('community_groups', ctx.locationId, String(b.slug || g.name), g.id);
      if (b.description !== undefined) patch.description = str(b.description, 'Beschreibung', { max: 2000 });
      if (b.cover_image !== undefined) patch.cover_image = cleanImage(b.cover_image, 'Titelbild');
      if (b.position !== undefined) patch.position = num(b.position);
      if (b.status !== undefined) {
        if (!['active', 'archived'].includes(b.status)) throw bad('Unbekannter Status');
        patch.status = b.status;
      }
      if (b.access !== undefined) {
        patch.access = cleanGroupAccess(b.access, g.access);
        checkCourses(ctx.locationId, patch.access.course_ids);
      }
      if (b.settings !== undefined) {
        patch.settings = settingsOrBad(b.settings, groupSettings(g));
        checkCourses(ctx.locationId, patch.settings.level_unlocks.map((u: any) => u.course_id));
      }
      db.update('community_groups', g.id, patch);
      return { ...groupOut(getGroup(app, ctx.locationId, g.id)), channels: channels(g.id) };
    });
    router.delete('/api/community/groups/:id', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      const files = db.all<{ id: string }>('SELECT id FROM community_files WHERE group_id = ?', g.id).map((r) => r.id);
      db.run('DELETE FROM community_groups WHERE id = ?', g.id);
      removeFiles(app, files);
      return { ok: true };
    });

    // --- channels -------------------------------------------------------------------------
    const channelFields = (b: any) => {
      const patch: Record<string, any> = {};
      if (b.name !== undefined) patch.name = str(b.name, 'Name', { required: true, max: 60 });
      if (b.description !== undefined) patch.description = str(b.description, 'Beschreibung', { max: 300 });
      if (b.category !== undefined) patch.category = str(b.category, 'Kategorie', { max: 40 });
      if (b.emoji !== undefined) patch.emoji = str(b.emoji, 'Emoji', { max: 8 });
      if (b.admin_only !== undefined) patch.admin_only = b.admin_only ? 1 : 0;
      return patch;
    };
    router.post('/api/community/groups/:id/channels', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      const f = channelFields({ name: ctx.body?.name ?? '', ...ctx.body });
      const c = {
        id: id(),
        location_id: ctx.locationId,
        group_id: g.id,
        description: '',
        category: '',
        emoji: '',
        admin_only: 0,
        ...f,
        slug: uniqueSlug('community_channels', g.id, f.name),
        position: db.get<{ n: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM community_channels WHERE group_id = ?', g.id)!.n,
        created_at: now(),
        updated_at: now(),
      };
      db.insert('community_channels', c);
      return c;
    });
    router.post('/api/community/groups/:id/channels/reorder', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      const ids = Array.isArray(ctx.body?.ids) ? ctx.body.ids.map(String) : [];
      const own = new Set(channels(g.id).map((c) => c.id));
      if (ids.some((x: string) => !own.has(x))) throw bad('Kanal gehört nicht zu dieser Gruppe');
      db.tx(() => ids.forEach((cid: string, i: number) => db.run('UPDATE community_channels SET position = ? WHERE id = ?', i, cid)));
      return channels(g.id);
    });
    router.patch('/api/community/groups/:id/channels/:cid', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      const c = mustChannel(g, ctx.params.cid);
      const patch = { ...channelFields(ctx.body ?? {}), updated_at: now() };
      if (ctx.body?.slug !== undefined) (patch as any).slug = uniqueSlug('community_channels', g.id, String(ctx.body.slug || c.name), c.id);
      db.update('community_channels', c.id, patch);
      return db.get('SELECT * FROM community_channels WHERE id = ?', c.id);
    });
    /** Deleting a channel deletes its posts – unless they move to another channel (?move_to=). */
    router.delete('/api/community/groups/:id/channels/:cid', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      const c = mustChannel(g, ctx.params.cid);
      if (channels(g.id).length <= 1) throw bad('Eine Gruppe braucht mindestens einen Kanal');
      const to = ctx.query.get('move_to');
      db.tx(() => {
        if (to) db.run('UPDATE community_posts SET channel_id = ? WHERE channel_id = ?', mustChannel(g, to).id, c.id);
        db.run('DELETE FROM community_channels WHERE id = ?', c.id);
      });
      return { ok: true };
    });

    // --- posts & comments -------------------------------------------------------------------
    const postOut = (p: any) => {
      const contact = p.contact_id ? getContact(app, p.location_id, p.contact_id) : undefined;
      return { ...p, ...Object.assign({}, ...ui.postExtras.map((h) => h.api?.(p) ?? {})), images: (p.images ?? []).map((f: string) => `/api/community/files/${f}`), by_team: !p.contact_id, contact: contact ? { id: contact.id, first_name: contact.first_name, last_name: contact.last_name, email: contact.email } : null, reports: db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM community_reports WHERE target_id = ? AND status = 'open'`, p.id)!.n };
    };
    const listPosts = (loc: string, q: URLSearchParams, groupId?: string) => {
      const where = ['p.location_id = ?'];
      const args: any[] = [loc];
      if (groupId) (where.push('p.group_id = ?'), args.push(groupId));
      for (const [k, col] of [['channel_id', 'p.channel_id'], ['status', 'p.status']] as const) {
        const v = q.get(k);
        if (v) (where.push(`${col} = ?`), args.push(v));
      }
      const term = q.get('q');
      if (term) (where.push('(p.title LIKE ? OR p.body LIKE ? OR p.author_name LIKE ?)'), args.push(`%${term}%`, `%${term}%`, `%${term}%`));
      const limit = Math.min(Math.max(num(q.get('limit'), 50), 1), 200);
      const offset = Math.max(num(q.get('offset'), 0), 0);
      return parseRows(
        db.all(
          `SELECT p.*, c.name AS channel_name, g.name AS group_name FROM community_posts p JOIN community_channels c ON c.id = p.channel_id JOIN community_groups g ON g.id = p.group_id
           WHERE ${where.join(' AND ')} ORDER BY p.pinned DESC, p.created_at DESC LIMIT ? OFFSET ?`,
          ...args,
          limit,
          offset,
        ),
        ['images'],
      ).map(postOut);
    };
    router.get('/api/community/posts', 'location', (ctx) => {
      const gid = ctx.query.get('group_id');
      if (gid) mustGroup(ctx.locationId, gid);
      if (!ctx.query.get('limit')) ctx.query.set('limit', '20');
      return listPosts(ctx.locationId, ctx.query, gid || undefined);
    });
    router.get('/api/community/groups/:id/posts', 'location', (ctx) => listPosts(ctx.locationId, ctx.query, mustGroup(ctx.locationId, ctx.params.id).id));
    router.post('/api/community/groups/:id/posts', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      const b = ctx.body ?? {};
      const ch = b.channel_id ? mustChannel(g, String(b.channel_id)) : channels(g.id)[0];
      if (!ch) throw bad('Die Gruppe hat keinen Kanal');
      // Poll, video and GIF are checked before the post exists.
      const prepared = ui.postExtras.map((h) => h.fromApi?.(b, g));
      const post = createPost(app, g, ch, team(ctx), { title: b.title, body: b.body }, { pinned: !!b.pinned, notifyAll: !!b.notify });
      ui.postExtras.forEach((h, i) => h.attach?.(post, g, prepared[i], 'team'));
      return postOut(post);
    });
    router.get('/api/community/posts/:id', 'location', (ctx) => {
      const { post } = mustPost(ctx.locationId, ctx.params.id);
      const comments = db.all('SELECT * FROM community_comments WHERE post_id = ? ORDER BY created_at', post.id);
      return { ...postOut(post), comments };
    });
    router.patch('/api/community/posts/:id', 'location', (ctx) => {
      const { post, group } = mustPost(ctx.locationId, ctx.params.id);
      const b = ctx.body ?? {};
      if (b.title !== undefined || b.body !== undefined) editPost(app, group, post, { title: b.title, body: b.body }, true);
      if (b.pinned !== undefined) db.run('UPDATE community_posts SET pinned = ? WHERE id = ?', b.pinned ? 1 : 0, post.id);
      if (b.channel_id !== undefined) db.run('UPDATE community_posts SET channel_id = ? WHERE id = ?', mustChannel(group, String(b.channel_id)).id, post.id);
      if (b.status !== undefined) {
        if (!['visible', 'hidden'].includes(b.status)) throw bad('Unbekannter Status');
        setHidden(app, 'post', post, b.status === 'hidden', str(b.reason, 'Grund', { max: 200 }) || 'vom Team');
        if (b.status === 'visible') db.run(`UPDATE community_reports SET status = 'dismissed', resolved_at = ?, resolved_by = ?, action = 'show' WHERE target_id = ? AND status = 'open'`, now(), ctx.user?.name ?? '', post.id);
      }
      return postOut(getPost(app, group.id, post.id));
    });
    router.delete('/api/community/posts/:id', 'location', (ctx) => {
      const { post } = mustPost(ctx.locationId, ctx.params.id);
      deletePost(app, post);
      return { ok: true };
    });
    router.post('/api/community/posts/:id/comments', 'location', (ctx) => {
      const { post, group } = mustPost(ctx.locationId, ctx.params.id);
      return addComment(app, group, post, team(ctx), { body: ctx.body?.body, parent_id: ctx.body?.parent_id });
    });
    router.patch('/api/community/comments/:id', 'location', (ctx) => {
      const { comment } = mustComment(ctx.locationId, ctx.params.id);
      if (!['visible', 'hidden'].includes(ctx.body?.status)) throw bad('Status: visible oder hidden');
      setHidden(app, 'comment', comment, ctx.body.status === 'hidden');
      return db.get('SELECT * FROM community_comments WHERE id = ?', comment.id);
    });
    router.delete('/api/community/comments/:id', 'location', (ctx) => {
      const { comment } = mustComment(ctx.locationId, ctx.params.id);
      deleteComment(app, comment);
      return { ok: true };
    });
    /** Images of member posts, for the admin (members get them through the portal). */
    router.get('/api/community/files/:id', 'location', (ctx) => {
      const f = db.get<{ file: string; mime: string }>('SELECT * FROM community_files WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      const r = f && fileResponse(app, f);
      if (!r) throw notFound();
      return r;
    });

    // --- members --------------------------------------------------------------------------
    router.get('/api/community/groups/:id/members', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      const s = groupSettings(g);
      const term = ctx.query.get('q');
      const rows = db.all(
        `SELECT m.*, k.first_name, k.last_name, k.email, pr.display_name, pr.handle,
           (SELECT COALESCE(SUM(points), 0) FROM community_points WHERE group_id = m.group_id AND contact_id = m.contact_id) AS points,
           (SELECT COUNT(*) FROM community_posts WHERE group_id = m.group_id AND contact_id = m.contact_id) AS posts,
           (SELECT COUNT(*) FROM community_comments WHERE group_id = m.group_id AND contact_id = m.contact_id) AS comments
         FROM community_members m JOIN contacts k ON k.id = m.contact_id
         LEFT JOIN community_profiles pr ON pr.location_id = m.location_id AND pr.contact_id = m.contact_id
         WHERE m.group_id = ?${ctx.query.get('banned') === '1' ? ' AND m.banned_at IS NOT NULL' : ''}${term ? ' AND (k.first_name LIKE ? OR k.last_name LIKE ? OR k.email LIKE ? OR pr.display_name LIKE ?)' : ''}
         ORDER BY m.banned_at IS NOT NULL, points DESC, m.joined_at LIMIT 2000`,
        g.id,
        ...(term ? [`%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`] : []),
      );
      return rows.map((r) => ({ ...r, level: levelFor(r.points, s.levels), level_name: s.levels[levelFor(r.points, s.levels) - 1]?.name }));
    });
    router.post('/api/community/groups/:id/members/:contactId/ban', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      if (!getContact(app, ctx.locationId, ctx.params.contactId)) throw notFound('Kontakt nicht gefunden');
      setBan(app, g, ctx.params.contactId, true, { reason: str(ctx.body?.reason, 'Grund', { max: 300 }), by: ctx.user?.name ?? '', hideContent: !!ctx.body?.hide_content });
      return { ok: true };
    });
    router.delete('/api/community/groups/:id/members/:contactId/ban', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      setBan(app, g, ctx.params.contactId, false);
      return { ok: true };
    });

    // --- reports ------------------------------------------------------------------------------
    router.get('/api/community/reports', 'location', (ctx) => {
      const status = ctx.query.get('status') ?? 'open';
      const gid = ctx.query.get('group_id');
      const rows = db.all(
        `SELECT r.*, g.name AS group_name, k.first_name, k.last_name, k.email FROM community_reports r JOIN community_groups g ON g.id = r.group_id
         LEFT JOIN contacts k ON k.id = r.contact_id
         WHERE r.location_id = ?${status === 'all' ? '' : ' AND r.status = ?'}${gid ? ' AND r.group_id = ?' : ''} ORDER BY r.created_at DESC LIMIT 500`,
        ctx.locationId,
        ...(status === 'all' ? [] : [status]),
        ...(gid ? [gid] : []),
      );
      return rows.map((r) => {
        const t = r.kind === 'post' ? db.get('SELECT id, title, body, status, author_name, contact_id, created_at, id AS post_id FROM community_posts WHERE id = ?', r.target_id) : db.get('SELECT id, body, status, author_name, contact_id, created_at, post_id FROM community_comments WHERE id = ?', r.target_id);
        return { ...r, target: t ?? null };
      });
    });
    router.patch('/api/community/reports/:id', 'location', (ctx) => {
      const r = db.get('SELECT * FROM community_reports WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!r) throw notFound('Meldung nicht gefunden');
      const action = String(ctx.body?.action ?? '');
      if (!['dismiss', 'hide', 'delete'].includes(action)) throw bad('Aktion: dismiss, hide oder delete');
      const table = r.kind === 'post' ? 'community_posts' : 'community_comments';
      const target = db.get(`SELECT * FROM ${table} WHERE id = ?`, r.target_id);
      // All open reports about the same item are settled together.
      const settle = (status: string) => db.run(`UPDATE community_reports SET status = ?, action = ?, resolved_at = ?, resolved_by = ? WHERE target_id = ? AND status = 'open'`, status, action, now(), ctx.user?.name ?? '', r.target_id);
      if (action === 'dismiss') {
        settle('dismissed');
        if (target?.status === 'hidden') setHidden(app, r.kind, target, false);
      } else if (action === 'hide') {
        settle('resolved');
        if (target) setHidden(app, r.kind, target, true, 'nach Meldung');
      } else {
        settle('resolved');
        if (target) r.kind === 'post' ? deletePost(app, parseJson(target, ['images'])) : deleteComment(app, target);
      }
      return { ok: true };
    });

    // --- events -----------------------------------------------------------------------------------
    const eventFields = (b: any, cur: any = {}) => {
      const patch: Record<string, any> = {};
      if (b.title !== undefined) patch.title = str(b.title, 'Titel', { required: true, max: 160 });
      if (b.description !== undefined) patch.description = str(b.description, 'Beschreibung', { max: 3000 });
      if (b.link !== undefined) patch.link = cleanLink(b.link);
      if (b.starts_at !== undefined) patch.starts_at = isoOf(b.starts_at, 'Beginn');
      if (b.ends_at !== undefined && b.ends_at !== '') patch.ends_at = isoOf(b.ends_at, 'Ende');
      const start = patch.starts_at ?? cur.starts_at;
      if (patch.starts_at && !patch.ends_at && !cur.ends_at) patch.ends_at = new Date(Date.parse(start) + 60 * 60_000).toISOString();
      const end = patch.ends_at ?? cur.ends_at;
      if (start && end && Date.parse(end) <= Date.parse(start)) throw bad('Das Ende muss nach dem Beginn liegen');
      return patch;
    };
    router.get('/api/community/groups/:id/events', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      const past = ctx.query.get('past') === '1';
      return db.all(`SELECT * FROM community_events WHERE group_id = ? AND ends_at ${past ? '<' : '>='} ? ORDER BY starts_at ${past ? 'DESC' : 'ASC'} LIMIT 200`, g.id, now());
    });
    router.post('/api/community/groups/:id/events', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      const b = ctx.body ?? {};
      if (!b.starts_at) throw bad('Beginn fehlt');
      const e: Record<string, any> = { id: id(), location_id: ctx.locationId, group_id: g.id, title: '', description: '', link: '', ...eventFields({ title: b.title ?? '', ...b }), created_at: now(), updated_at: now() };
      db.insert('community_events', e);
      if (b.notify) {
        const tz = app.location(ctx.locationId)?.timezone || 'Europe/Berlin';
        const when = formatInTz(e.starts_at, tz, { weekday: 'short', year: undefined });
        const all = db.all<{ contact_id: string }>('SELECT contact_id FROM community_members WHERE group_id = ? AND banned_at IS NULL', g.id).map((r) => r.contact_id);
        notify(app, g, all, { kind: 'event', text: `Neuer Termin: ${e.title} (${when})`, actor: ctx.user?.name ?? 'Team' });
      }
      return e;
    });
    router.patch('/api/community/events/:id', 'location', (ctx) => {
      const e = db.get('SELECT * FROM community_events WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!e) throw notFound('Termin nicht gefunden');
      db.update('community_events', e.id, { ...eventFields(ctx.body ?? {}, e), updated_at: now() });
      return db.get('SELECT * FROM community_events WHERE id = ?', e.id);
    });
    router.delete('/api/community/events/:id', 'location', (ctx) => {
      if (!db.run('DELETE FROM community_events WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId).changes) throw notFound('Termin nicht gefunden');
      return { ok: true };
    });

    // --- leaderboard -------------------------------------------------------------------------------
    router.get('/api/community/groups/:id/leaderboard', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      const period = (ctx.query.get('period') ?? 'all') as Period;
      if (!(period in PERIODS)) throw bad('Zeitraum: week, month oder all');
      const s = groupSettings(g);
      return leaderboard(app, g.id, period).map((r, i) => {
        const pr = db.get('SELECT display_name, handle FROM community_profiles WHERE location_id = ? AND contact_id = ?', ctx.locationId, r.contact_id);
        const total = period === 'all' ? r.points : memberPoints(app, g.id, r.contact_id);
        const lvl = levelFor(total, s.levels);
        return { rank: i + 1, contact_id: r.contact_id, points: r.points, total, level: lvl, level_name: s.levels[lvl - 1]?.name, display_name: pr?.display_name ?? '', handle: pr?.handle ?? '' };
      });
    });

    // --- snapshots: the group structure (channels, rules, levels) without posts or members --------
    const part: SnapshotPart = {
      key: 'community_groups',
      export: (_app, loc, only) =>
        only
          ? []
          : db.all('SELECT * FROM community_groups WHERE location_id = ? ORDER BY position, created_at', loc).map((g) => {
              const row = parseJson(g, ['access', 'settings']);
              return {
                id: row.id,
                name: row.name,
                slug: row.slug,
                description: row.description,
                cover_image: row.cover_image,
                status: row.status,
                position: row.position,
                access: row.access,
                settings: row.settings,
                channels: db.all('SELECT name, slug, description, category, emoji, admin_only, position FROM community_channels WHERE group_id = ? ORDER BY position, created_at', row.id),
              };
            }),
      prepare: (_app, items, maps) => {
        maps.communityGroups ??= new Map();
        for (const g of items) if (g.id) maps.communityGroups.set(String(g.id), id());
      },
      apply: (_app, loc, items, ctx) => {
        const courses = ctx.maps.courses ?? new Map<string, string>();
        const created: { id: string; name: string }[] = [];
        for (const raw of items) {
          const gid = (raw.id && ctx.maps.communityGroups?.get(String(raw.id))) || id();
          const access = cleanGroupAccess(raw.access);
          access.course_ids = access.course_ids.map((c) => courses.get(c) ?? '').filter(Boolean);
          let settings;
          try {
            settings = cleanGroupSettings(raw.settings ?? {});
          } catch {
            settings = cleanGroupSettings({});
          }
          settings.level_unlocks = settings.level_unlocks.map((u) => ({ ...u, course_id: courses.get(u.course_id) ?? '' })).filter((u) => u.course_id);
          const name = String(raw.name ?? 'Community').slice(0, 120);
          db.insert('community_groups', {
            id: gid,
            location_id: loc,
            name,
            slug: uniqueSlug('community_groups', loc, raw.slug || name),
            description: String(raw.description ?? '').slice(0, 2000),
            cover_image: String(raw.cover_image ?? '').slice(0, 1000),
            status: raw.status === 'archived' ? 'archived' : 'active',
            position: Number(raw.position) || 0,
            access,
            settings,
            created_at: now(),
            updated_at: now(),
          });
          const chs = Array.isArray(raw.channels) && raw.channels.length ? raw.channels : [{ name: 'Allgemein' }];
          chs.slice(0, 50).forEach((c: any, i: number) => {
            const cname = String(c?.name ?? '').slice(0, 60) || `Kanal ${i + 1}`;
            db.insert('community_channels', {
              id: id(),
              location_id: loc,
              group_id: gid,
              name: cname,
              slug: uniqueSlug('community_channels', gid, c?.slug || cname),
              description: String(c?.description ?? '').slice(0, 300),
              category: String(c?.category ?? '').slice(0, 40),
              emoji: String(c?.emoji ?? '').slice(0, 8),
              admin_only: c?.admin_only ? 1 : 0,
              position: Number(c?.position ?? i),
              created_at: now(),
              updated_at: now(),
            });
          });
          created.push({ id: gid, name });
        }
        ctx.created.community_groups = created;
      },
    };
    app.services.snapshotParts = [...(app.services.snapshotParts ?? []), part];

    // --- daily digest ----------------------------------------------------------------------------
    let lastDigest = 0;
    app.services.communityDigest = (at?: Date) => runDigest(app, at, (loc) => portalUrl(app, loc));
    app.onTick(async () => {
      if (Date.now() - lastDigest < 10 * 60_000) return;
      lastDigest = Date.now();
      await runDigest(app, new Date(), (loc) => portalUrl(app, loc));
      // Old read notifications don't need to stay forever.
      db.run('DELETE FROM community_notifications WHERE read_at IS NOT NULL AND created_at < ?', new Date(Date.now() - 90 * 864e5).toISOString());
    });

  },
};
