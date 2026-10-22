import { readFileSync } from 'node:fs';
import type { Module } from '../core/app.js';
import { HttpError, bad, clampLimit, notFound, str, type Ctx, type RawResult } from '../core/http.js';
import { now } from '../core/util.js';
import { isBot, teamUsers, userById } from '../services/collab-actor.js';
import { resolveEmbeds } from '../services/collab-cards.js';
import { HIT_END, HIT_START, createFts, likePattern, matchExpr, plainSnippet, searchWords } from '../services/collab-fts.js';
import { getAccount } from '../services/channel-kit.js';
import { callRoute } from '../services/route-call.js';
import { CHANNEL_ID, isSlackWebhook } from '../services/slack.js';
import { loginOf, sweepOnLoginChange } from '../services/stream-login.js';
import { ChatHub } from '../services/teamchat-hub.js';
import { notifyMessage } from '../services/teamchat-notify.js';
import {
  LIMITS,
  addInvited,
  addMember,
  channelAccess,
  channelLabel,
  cleanChannelName,
  createChannel,
  deleteMessage,
  directChannel,
  editMessage,
  ensureDefaultChannel,
  filePath,
  ftsOf,
  loadChannel,
  loadMessage,
  markRead,
  mayChat,
  memberIds,
  memberOf,
  messageOut,
  postMessage,
  publish,
  purgeMessages,
  removeFiles,
  saveFile,
  setPinned,
  toggleReaction,
  unreadCounts,
  visibleChannels,
  type ChannelRow,
  type MessageRow,
  type Role,
} from '../services/teamchat-store.js';
import { markdownToText } from '../services/wiki-markdown.js';
import { PUSH_KINDS } from './push.js';

/**
 * Team-Chat: channels (public/private, per sub-account or agency-wide), direct and group messages, threads,
 * reactions, @mentions, files, edit/delete, pins, unread counters, search, typing and presence over SSE + POST,
 * notifications (app, web push, Android feed), link previews for CRM records, a retention setting and an optional
 * one-way copy to Slack. Slash commands (/aufgabe, /kontakt, /agent) are in teamchat-commands.ts, MCP tools in
 * teamchat-mcp.ts, the mobile API in collab-mobile.ts. Contract: docs/team-chat.md.
 */

const SETTINGS_DEFAULT = { retention_days: 0 };
export const RETENTION_CHOICES = [0, 30, 90, 180, 365];

export const teamchatModule: Module = {
  name: 'teamchat',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE teamchat_channels (
        id TEXT PRIMARY KEY, location_id TEXT REFERENCES locations(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', topic TEXT NOT NULL DEFAULT '', dm_key TEXT,
        created_by TEXT, created_by_name TEXT NOT NULL DEFAULT '', slack_mirror INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT, last_message_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX teamchat_channels_loc ON teamchat_channels(location_id, kind);
      CREATE UNIQUE INDEX teamchat_channels_dm ON teamchat_channels(dm_key) WHERE dm_key IS NOT NULL;
      CREATE TABLE teamchat_members (
        channel_id TEXT NOT NULL REFERENCES teamchat_channels(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member', notify TEXT NOT NULL DEFAULT '', last_read_at TEXT, joined_at TEXT NOT NULL,
        PRIMARY KEY (channel_id, user_id)
      );
      CREATE INDEX teamchat_members_user ON teamchat_members(user_id);
      CREATE TABLE teamchat_messages (
        id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES teamchat_channels(id) ON DELETE CASCADE, thread_id TEXT,
        author_id TEXT, author_name TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'user', via TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL, mentions TEXT NOT NULL DEFAULT '[]', meta TEXT NOT NULL DEFAULT '{}',
        reply_count INTEGER NOT NULL DEFAULT 0, last_reply_at TEXT, edited_at TEXT, deleted_at TEXT,
        pinned_at TEXT, pinned_by TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX teamchat_messages_channel ON teamchat_messages(channel_id, created_at);
      CREATE INDEX teamchat_messages_thread ON teamchat_messages(thread_id, created_at) WHERE thread_id IS NOT NULL;
      CREATE INDEX teamchat_messages_pins ON teamchat_messages(channel_id) WHERE pinned_at IS NOT NULL;
      CREATE INDEX teamchat_messages_age ON teamchat_messages(created_at);
      CREATE TABLE teamchat_reactions (
        message_id TEXT NOT NULL REFERENCES teamchat_messages(id) ON DELETE CASCADE, user_id TEXT NOT NULL,
        emoji TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (message_id, user_id, emoji)
      );
      CREATE TABLE teamchat_files (
        id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES teamchat_channels(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES teamchat_messages(id) ON DELETE CASCADE, uploader_id TEXT, name TEXT NOT NULL,
        mime TEXT NOT NULL, size INTEGER NOT NULL, file TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX teamchat_files_msg ON teamchat_files(message_id);
      CREATE TABLE teamchat_settings (scope TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL);
      CREATE TABLE teamchat_agent_runs (
        message_id TEXT PRIMARY KEY REFERENCES teamchat_messages(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL REFERENCES teamchat_channels(id) ON DELETE CASCADE, location_id TEXT NOT NULL,
        asker_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running', pending_id TEXT, token_sealed TEXT, args_hash TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const hub = new ChatHub();
    app.services.chatHub = hub;
    app.services.chatFts = createFts(db, 'teamchat_fts', ['body']);
    ftsOf(app).backfill(() => db.all<{ r: number; body: string }>(`SELECT rowid AS r, body FROM teamchat_messages WHERE deleted_at IS NULL`).map((m) => ({ rowid: m.r, values: { body: markdownToText(m.body) } })));
    Object.assign(PUSH_KINDS, {
      chat: { label: 'Team-Chat: Direktnachrichten und Erwähnungen', perm: 'teamchat' },
      wiki: { label: 'Wiki: Erwähnungen und Kommentare', perm: 'wiki' },
    });
    hub.revalidate = (s) => {
      const u = userById(app, s.userId);
      return !!u && mayChat(u, s.locationId) && !!db.get('SELECT 1 AS x FROM locations WHERE id = ?', s.locationId);
    };
    // when someone is removed or loses the chat, their open streams close with the next heartbeat check; a stream also
    // ends with the login it was opened with – at once when signing out or revoking, an expired session at the next check
    sweepOnLoginChange(app, hub);

    // --- helpers --------------------------------------------------------------------------------------
    const quiet = (ctx: Ctx) => {
      ctx.skipAfterWrite = true;
    };
    const person = (ctx: Ctx) => {
      if (isBot(ctx) || !ctx.user) throw new HttpError(403, 'Das geht nur mit Anmeldung');
      return ctx.user;
    };
    /** Chat messages arrive in bursts: one audit line per sender, channel and ten minutes (the messages are the record). */
    const lastAudit = new Map<string, number>();
    const auditPost = (ctx: Ctx, ch: ChannelRow) => {
      const key = `${ctx.user?.id ?? ctx.via}:${ch.id}`;
      if (Date.now() - (lastAudit.get(key) ?? 0) < 10 * 60_000) return;
      lastAudit.set(key, Date.now());
      if (lastAudit.size > 5000) lastAudit.clear();
      app.services.audit?.({ ctx, action: 'chat.post', route: 'POST /api/team-chat/channels/:id/messages', entityId: ch.id, summary: `Nachricht in ${channelLabel(app, ch, ctx.user?.id ?? null)}` });
    };
    const log = (ctx: Ctx, action: string, route: string, ch: ChannelRow, entityId: string, summary: string) => {
      quiet(ctx);
      app.services.audit?.({ ctx, action, route, entityId, summary: `${summary} (${channelLabel(app, ch, ctx.user?.id ?? null)})` });
    };

    const channelOut = (ctx: Ctx, ch: ChannelRow, role: Role, counts?: Map<string, { unread: number; mentions: number }>) => {
      const me = ctx.user && !isBot(ctx) ? memberOf(app, ch.id, ctx.user.id) : undefined;
      const c = counts?.get(ch.id) ?? { unread: 0, mentions: 0 };
      const direct = ch.kind === 'dm' || ch.kind === 'group';
      const last = db.get<MessageRow>('SELECT * FROM teamchat_messages WHERE channel_id = ? AND thread_id IS NULL AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1', ch.id);
      return {
        id: ch.id,
        kind: ch.kind,
        name: ch.name,
        label: channelLabel(app, ch, ctx.user?.id ?? null),
        topic: ch.topic,
        scope: ch.location_id ? 'location' : 'agency',
        members: direct ? db.all<{ id: string; name: string }>('SELECT u.id, u.name FROM teamchat_members m JOIN users u ON u.id = m.user_id WHERE m.channel_id = ? ORDER BY u.name', ch.id) : undefined,
        member_count: Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM teamchat_members WHERE channel_id = ?', ch.id)?.n ?? 0),
        role,
        joined: !!me,
        notify: me?.notify || (direct ? 'all' : 'mentions'),
        muted: me?.notify === 'none',
        unread: me ? c.unread : 0,
        mentions: me ? c.mentions : 0,
        last_message_at: ch.last_message_at,
        preview: last ? { text: markdownToText(last.body).slice(0, 100) || (last.kind === 'agent' ? 'Antwort des Agenten' : '📎'), author: last.author_name } : null,
        archived: !!ch.archived_at,
        slack_mirror: !!ch.slack_mirror,
        created_by_name: ch.created_by_name,
        can: { manage: role === 'owner' || (ch.kind === 'public' && !isBot(ctx) && ctx.user?.role === 'admin'), post: !ch.archived_at && ctx.scope !== 'read' },
      };
    };
    app.services.teamchatChannelOut = channelOut;

    /** Is the Slack bridge of this sub-account set up (the chat can copy messages there)? */
    const slackReady = (loc: string) => {
      const a = getAccount(app, loc, 'slack');
      if (!a?.enabled) return false;
      return a.config.mode === 'webhook' ? isSlackWebhook(a.secrets.webhook_url ?? '') : !!a.secrets.bot_token && CHANNEL_ID.test(a.config.channel ?? '');
    };

    // --- channels -----------------------------------------------------------------------------------------
    router.get('/api/team-chat/channels', 'location', (ctx) => {
      ensureDefaultChannel(app, ctx);
      const list = visibleChannels(app, ctx, { archived: ctx.query.get('archived') === '1' });
      const counts = ctx.user && !isBot(ctx) ? unreadCounts(app, ctx.user.id, list.map((x) => x.ch.id)) : new Map();
      const out = list.map((x) => channelOut(ctx, x.ch, x.role, counts));
      return { channels: out, me: ctx.user && !isBot(ctx) ? { id: ctx.user.id, name: ctx.user.name, admin: ctx.user.role === 'admin' } : null, slack: slackReady(ctx.locationId) };
    });

    router.post('/api/team-chat/channels', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const kind = b.kind === 'private' ? 'private' : 'public';
      const ch = createChannel(app, ctx, { name: b.name, kind, topic: b.topic, agency: b.scope === 'agency', members: Array.isArray(b.members) ? b.members.map(String) : [] });
      return channelOut(ctx, ch, 'owner');
    });

    router.post('/api/team-chat/dms', 'location', (ctx) => {
      const ids = Array.isArray(ctx.body?.user_ids) ? ctx.body.user_ids.map(String) : ctx.body?.user_id ? [String(ctx.body.user_id)] : [];
      const ch = directChannel(app, ctx, ids);
      return channelOut(ctx, ch, channelAccess(app, ctx, ch) as Role);
    });

    router.get('/api/team-chat/channels/:id', 'location', (ctx) => {
      const { ch, role } = loadChannel(app, ctx, ctx.params.id);
      const members = db.all<{ id: string; name: string; role: string }>('SELECT u.id, u.name, m.role FROM teamchat_members m JOIN users u ON u.id = m.user_id WHERE m.channel_id = ? ORDER BY u.name', ch.id);
      return { ...channelOut(ctx, ch, role, ctx.user && !isBot(ctx) ? unreadCounts(app, ctx.user.id, [ch.id]) : undefined), members };
    });

    router.patch('/api/team-chat/channels/:id', 'location', (ctx) => {
      const { ch, role } = loadChannel(app, ctx, ctx.params.id);
      const b = ctx.body ?? {};
      const patch: Record<string, unknown> = {};
      const manage = ['name', 'topic', 'archived', 'slack_mirror'].some((k) => b[k] !== undefined);
      if (manage) {
        loadChannel(app, ctx, ch.id, 'owner');
        if (ch.kind === 'dm' || ch.kind === 'group') {
          if (b.name !== undefined || b.archived !== undefined || b.slack_mirror !== undefined) throw bad('Direktnachrichten lassen sich nicht umbenennen oder archivieren');
        }
        if (b.name !== undefined) {
          const name = cleanChannelName(b.name);
          if (db.get(`SELECT 1 AS x FROM teamchat_channels WHERE location_id IS ? AND kind IN ('public', 'private') AND LOWER(name) = ? AND id != ?`, ch.location_id, name, ch.id)) throw bad(`Einen Kanal „${name}“ gibt es schon`);
          patch.name = name;
        }
        if (b.topic !== undefined) patch.topic = String(b.topic).slice(0, 250);
        if (b.archived !== undefined) patch.archived_at = b.archived ? now() : null;
        if (b.slack_mirror !== undefined) {
          if (b.slack_mirror && (!ch.location_id || !slackReady(ch.location_id))) throw bad('Slack ist für diesen Sub-Account nicht eingerichtet (Einstellungen → Weitere Kanäle)');
          patch.slack_mirror = b.slack_mirror ? 1 : 0;
        }
        patch.updated_at = now();
        db.update('teamchat_channels', ch.id, patch);
      }
      // everybody may mute a channel or choose how loud it is for them
      if (b.notify !== undefined) {
        if (!['', 'all', 'mentions', 'none'].includes(String(b.notify))) throw bad('notify: all, mentions oder none');
        const u = person(ctx);
        if (!memberOf(app, ch.id, u.id)) throw bad('Erst dem Kanal beitreten');
        db.run('UPDATE teamchat_members SET notify = ? WHERE channel_id = ? AND user_id = ?', String(b.notify), ch.id, u.id);
      }
      const fresh = db.get<ChannelRow>('SELECT * FROM teamchat_channels WHERE id = ?', ch.id)!;
      if (manage) {
        log(ctx, 'chat.channel.update', 'PATCH /api/team-chat/channels/:id', fresh, ch.id, `Kanal geändert: ${Object.keys(patch).filter((k) => k !== 'updated_at').join(', ')}`);
        publish(app, fresh, 'channel', { id: fresh.id, change: 'updated' });
      }
      return channelOut(ctx, fresh, role);
    });

    router.delete('/api/team-chat/channels/:id', 'location', (ctx) => {
      const { ch } = loadChannel(app, ctx, ctx.params.id, 'owner');
      if (ch.kind === 'dm' || ch.kind === 'group') throw bad('Direktnachrichten lassen sich nicht löschen – nur verlassen');
      publish(app, ch, 'channel', { id: ch.id, change: 'deleted' });
      purgeMessages(app, db.all<{ id: string }>('SELECT id FROM teamchat_messages WHERE channel_id = ?', ch.id).map((m) => m.id));
      removeFiles(app, db.all<{ file: string }>('SELECT file FROM teamchat_files WHERE channel_id = ?', ch.id));
      db.run('DELETE FROM teamchat_channels WHERE id = ?', ch.id);
      return { ok: true, id: ch.id, name: ch.name };
    });

    router.post('/api/team-chat/channels/:id/join', 'location', (ctx) => {
      const u = person(ctx);
      const { ch } = loadChannel(app, ctx, ctx.params.id);
      if (ch.kind !== 'public') throw new HttpError(403, 'Diesem Kanal kannst du nur auf Einladung beitreten');
      addMember(app, ch.id, u.id);
      return channelOut(ctx, ch, channelAccess(app, ctx, ch) as Role);
    });
    router.post('/api/team-chat/channels/:id/leave', 'location', (ctx) => {
      const u = person(ctx);
      const { ch } = loadChannel(app, ctx, ctx.params.id);
      if (!memberOf(app, ch.id, u.id)) return { ok: true };
      db.run('DELETE FROM teamchat_members WHERE channel_id = ? AND user_id = ?', ch.id, u.id);
      // a channel without an owner passes to its longest member
      if (!db.get(`SELECT 1 AS x FROM teamchat_members WHERE channel_id = ? AND role = 'owner'`, ch.id)) db.run(`UPDATE teamchat_members SET role = 'owner' WHERE channel_id = ? AND user_id = (SELECT user_id FROM teamchat_members WHERE channel_id = ? ORDER BY joined_at LIMIT 1)`, ch.id, ch.id);
      // a direct message nobody is left in goes away
      if (ch.kind !== 'public' && ch.kind !== 'private' && !memberIds(app, ch.id).length) db.run('DELETE FROM teamchat_channels WHERE id = ?', ch.id);
      return { ok: true, id: ch.id, name: ch.name || undefined };
    });
    router.post('/api/team-chat/channels/:id/members', 'location', (ctx) => {
      const { ch } = loadChannel(app, ctx, ctx.params.id, 'member');
      if (ch.kind === 'dm') throw bad('Eine Direktnachricht hat genau zwei Personen – für mehr bitte eine Gruppe anlegen');
      if (ch.kind === 'group' && memberIds(app, ch.id).length + (Array.isArray(ctx.body?.user_ids) ? ctx.body.user_ids.length : 0) > LIMITS.groupMax) throw bad(`Höchstens ${LIMITS.groupMax} Personen in einer Gruppe`);
      const added: string[] = [];
      for (const uid of Array.isArray(ctx.body?.user_ids) ? ctx.body.user_ids.map(String).slice(0, 50) : []) if (!memberOf(app, ch.id, uid) && addInvited(app, ctx, ch, uid)) added.push(uid);
      if (added.length) publish(app, ch, 'channel', { id: ch.id, change: 'members' });
      return { ok: true, added, name: ch.name || undefined, id: ch.id };
    });
    router.delete('/api/team-chat/channels/:id/members/:userId', 'location', (ctx) => {
      const u = person(ctx);
      const { ch } = loadChannel(app, ctx, ctx.params.id, 'member');
      if (ctx.params.userId !== u.id) loadChannel(app, ctx, ch.id, 'owner');
      if (ch.kind === 'dm') throw bad('Aus einer Direktnachricht kann man nur selbst gehen');
      db.run('DELETE FROM teamchat_members WHERE channel_id = ? AND user_id = ?', ch.id, ctx.params.userId);
      publish(app, ch, 'channel', { id: ch.id, change: 'members' });
      return { ok: true, id: ch.id, name: ch.name || undefined };
    });

    // --- messages --------------------------------------------------------------------------------------------
    router.get('/api/team-chat/channels/:id/messages', 'location', (ctx) => {
      const { ch } = loadChannel(app, ctx, ctx.params.id);
      const limit = clampLimit(ctx.query.get('limit'), 50, 100);
      const before = ctx.query.get('before') ? db.get<MessageRow>('SELECT created_at, id FROM teamchat_messages WHERE id = ? AND channel_id = ?', String(ctx.query.get('before')), ch.id) : undefined;
      const rows = db.all<MessageRow>(
        `SELECT * FROM teamchat_messages WHERE channel_id = ? AND thread_id IS NULL ${before ? 'AND (created_at < ? OR (created_at = ? AND id < ?))' : ''} ORDER BY created_at DESC, id DESC LIMIT ?`,
        ch.id,
        ...(before ? [before.created_at, before.created_at, before.id] : []),
        limit + 1,
      );
      const me = ctx.user && !isBot(ctx) ? memberOf(app, ch.id, ctx.user.id) : undefined;
      return { messages: messageOut(app, rows.slice(0, limit).reverse()), has_more: rows.length > limit, last_read_at: me?.last_read_at ?? null };
    });

    router.post('/api/team-chat/channels/:id/messages', 'location', async (ctx) => {
      const { ch } = loadChannel(app, ctx, ctx.params.id, 'member');
      const b = ctx.body ?? {};
      const raw = String(b.body ?? '');
      const cmds = app.services.teamchatCommands as { match: (t: string) => boolean; run: (ctx: Ctx, ch: ChannelRow, text: string, threadId: string | null) => Promise<unknown> } | undefined;
      if (cmds?.match(raw) && !isBot(ctx)) {
        quiet(ctx);
        return cmds.run(ctx, ch, raw.trim(), b.thread_id ? String(b.thread_id) : null);
      }
      const files = Array.isArray(b.files) ? b.files.map(String) : [];
      const { row, out, mentioned } = postMessage(app, ctx, ch, { body: raw, threadId: b.thread_id ? String(b.thread_id) : null, fileIds: files });
      quiet(ctx);
      auditPost(ctx, ch);
      notifyMessage(app, ctx, ch, row, mentioned, { fileCount: files.length });
      return out;
    });

    router.get('/api/team-chat/messages/:id/thread', 'location', (ctx) => {
      const { msg } = loadMessage(app, ctx, ctx.params.id);
      const root = msg.thread_id ? db.get<MessageRow>('SELECT * FROM teamchat_messages WHERE id = ?', msg.thread_id) : msg;
      if (!root) throw notFound('Nachricht nicht gefunden');
      const replies = db.all<MessageRow>('SELECT * FROM teamchat_messages WHERE thread_id = ? ORDER BY created_at, id LIMIT 500', root.id);
      const [parent, ...rest] = messageOut(app, [root, ...replies]);
      return { parent, replies: rest };
    });

    router.patch('/api/team-chat/messages/:id', 'location', (ctx) => {
      const { msg, ch } = loadMessage(app, ctx, ctx.params.id, 'member');
      const { out, fresh } = editMessage(app, ctx, ch, msg, String(ctx.body?.body ?? ''));
      log(ctx, 'chat.edit', 'PATCH /api/team-chat/messages/:id', ch, msg.id, 'Nachricht bearbeitet');
      if (fresh.length) notifyMessage(app, ctx, ch, { ...msg, body: out.body, author_name: msg.author_name } as MessageRow, fresh);
      return out;
    });

    router.delete('/api/team-chat/messages/:id', 'location', (ctx) => {
      const { msg, ch, role } = loadMessage(app, ctx, ctx.params.id, 'member');
      deleteMessage(app, ctx, ch, role, msg);
      log(ctx, 'chat.delete', 'DELETE /api/team-chat/messages/:id', ch, msg.id, 'Nachricht gelöscht');
      return { ok: true, id: msg.id };
    });

    router.post('/api/team-chat/messages/:id/pin', 'location', (ctx) => {
      const { msg, ch } = loadMessage(app, ctx, ctx.params.id, 'member');
      const out = setPinned(app, ctx, ch, msg, true);
      log(ctx, 'chat.pin', 'POST /api/team-chat/messages/:id/pin', ch, msg.id, 'Nachricht angepinnt');
      return out;
    });
    router.delete('/api/team-chat/messages/:id/pin', 'location', (ctx) => {
      const { msg, ch } = loadMessage(app, ctx, ctx.params.id, 'member');
      const out = setPinned(app, ctx, ch, msg, false);
      log(ctx, 'chat.unpin', 'DELETE /api/team-chat/messages/:id/pin', ch, msg.id, 'Pin entfernt');
      return out;
    });
    router.get('/api/team-chat/channels/:id/pins', 'location', (ctx) => {
      const { ch } = loadChannel(app, ctx, ctx.params.id);
      return messageOut(app, db.all<MessageRow>('SELECT * FROM teamchat_messages WHERE channel_id = ? AND pinned_at IS NOT NULL AND deleted_at IS NULL ORDER BY pinned_at DESC LIMIT 100', ch.id));
    });

    router.post('/api/team-chat/messages/:id/reactions', 'location', (ctx) => {
      const { msg, ch } = loadMessage(app, ctx, ctx.params.id, 'member');
      quiet(ctx);
      const r = toggleReaction(app, ctx, ch, msg, String(ctx.body?.emoji ?? ''));
      return { active: r.active, reactions: r.out.reactions };
    });

    /** Keeps a chat message with the customer: as an internal note on the contact (the notes of the CRM). */
    router.post('/api/team-chat/messages/:id/note', 'location', async (ctx) => {
      const { msg, ch } = loadMessage(app, ctx, ctx.params.id);
      if (msg.deleted_at) throw bad('Die Nachricht wurde gelöscht');
      const contactId = str(ctx.body?.contact_id, 'Kontakt', { required: true, max: 40 });
      const text = markdownToText(msg.body).slice(0, 4000);
      const note = await callRoute(app, ctx, 'POST', `/api/contacts/${encodeURIComponent(contactId)}/notes`, { body: `Aus dem Team-Chat (${channelLabel(app, ch, ctx.user?.id ?? null)}) – ${msg.author_name}:\n${text}` });
      return { ok: true, note_id: note?.id, contact_id: contactId };
    });

    router.post('/api/team-chat/channels/:id/read', 'location', (ctx) => {
      quiet(ctx);
      const { ch } = loadChannel(app, ctx, ctx.params.id);
      if (ctx.user && !isBot(ctx) && markRead(app, ch.id, ctx.user.id)) hub.publish('read', { channel_id: ch.id }, (s) => s.userId === ctx.user!.id);
      return { ok: true };
    });

    router.post('/api/team-chat/channels/:id/typing', 'location', (ctx) => {
      quiet(ctx);
      const { ch } = loadChannel(app, ctx, ctx.params.id, 'member');
      const u = person(ctx);
      if (hub.typing(ch.id, u.id)) publish(app, ch, 'typing', { channel_id: ch.id, thread_id: ctx.body?.thread_id ? String(ctx.body.thread_id) : null, user_id: u.id, name: u.name });
      return { ok: true };
    });

    // --- files -----------------------------------------------------------------------------------------------------
    router.post('/api/team-chat/channels/:id/files', 'location', (ctx) => {
      const { ch } = loadChannel(app, ctx, ctx.params.id, 'member');
      if (ch.archived_at) throw new HttpError(409, 'Dieser Kanal ist archiviert');
      return saveFile(app, ctx, ch, ctx.body ?? {});
    });
    router.get('/api/team-chat/files/:id', 'location', (ctx): RawResult => {
      const f = db.get<any>('SELECT * FROM teamchat_files WHERE id = ?', ctx.params.id);
      if (!f) throw notFound('Datei nicht gefunden');
      loadChannel(app, ctx, f.channel_id);
      // a file that is not in a message yet belongs to the person who is about to send it
      if (!f.message_id && f.uploader_id !== ctx.user?.id) throw notFound('Datei nicht gefunden');
      const p = filePath(app, f.file);
      if (!p) throw notFound('Datei nicht gefunden');
      const image = /^image\/(png|jpeg|gif|webp)$/.test(f.mime);
      return {
        __raw: true,
        status: 200,
        headers: {
          'content-type': f.mime,
          'content-disposition': `${image && ctx.query.get('download') !== '1' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
          'cache-control': 'private, max-age=3600',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
        },
        body: readFileSync(p),
      };
    });

    // --- search, counters, people ---------------------------------------------------------------------------------------
    router.get('/api/team-chat/search', 'location', (ctx) => {
      const q = String(ctx.query.get('q') ?? '').trim();
      const words = searchWords(q);
      if (!words.length) return [];
      const only = ctx.query.get('channel_id');
      const chans = visibleChannels(app, ctx).filter((x) => !only || x.ch.id === only);
      if (!chans.length) return [];
      const ids = chans.map((c) => c.ch.id).slice(0, 400);
      const names = new Map(chans.map((c) => [c.ch.id, channelLabel(app, c.ch, ctx.user?.id ?? null)]));
      const marks = ids.map(() => '?').join(',');
      const limit = clampLimit(ctx.query.get('limit'), 30, 100);
      const f = ftsOf(app);
      let rows: any[] = [];
      if (f.ok) {
        try {
          rows = db.all<any>(
            `SELECT m.*, snippet(${f.table}, 0, '${HIT_START}', '${HIT_END}', '…', 16) AS snip FROM ${f.table} JOIN teamchat_messages m ON m.rowid = ${f.table}.rowid
             WHERE ${f.table} MATCH ? AND m.channel_id IN (${marks}) AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT ?`,
            matchExpr(q)!,
            ...ids,
            limit,
          );
        } catch (e) {
          console.error('[team-chat] fts', (e as Error).message);
          rows = [];
        }
      } else {
        rows = db.all<any>(`SELECT m.* FROM teamchat_messages m WHERE m.channel_id IN (${marks}) AND m.deleted_at IS NULL AND ${words.map(() => `m.body LIKE ? ESCAPE '\\'`).join(' AND ')} ORDER BY m.created_at DESC LIMIT ?`, ...ids, ...words.map(likePattern), limit);
      }
      return rows.map((r) => ({ id: r.id, channel_id: r.channel_id, channel: names.get(r.channel_id), thread_id: r.thread_id, author: r.author_name, created_at: r.created_at, snippet: r.snip && String(r.snip).includes(HIT_START) ? r.snip : plainSnippet(markdownToText(r.body), words, 140) }));
    });

    router.get('/api/team-chat/summary', 'location', (ctx) => {
      if (isBot(ctx) || !ctx.user) return { unread: 0, mentions: 0, channels: {} };
      ensureDefaultChannel(app, ctx);
      const list = visibleChannels(app, ctx);
      const counts = unreadCounts(app, ctx.user.id, list.map((x) => x.ch.id));
      let unread = 0;
      let mentions = 0;
      const channels: Record<string, { unread: number; mentions: number }> = {};
      for (const { ch } of list) {
        const c = counts.get(ch.id);
        if (!c || (!c.unread && !c.mentions)) continue;
        channels[ch.id] = c;
        // a muted channel keeps its counter but stays out of the total
        if (memberOf(app, ch.id, ctx.user.id)?.notify !== 'none') {
          unread += c.unread;
          mentions += c.mentions;
        }
      }
      return { unread, mentions, channels };
    });

    router.get('/api/team-chat/people', 'location', (ctx) => teamUsers(app, ctx.locationId, 'teamchat').map((u) => ({ id: u.id, name: u.name, admin: u.role === 'admin', online: hub.online(u.id), me: u.id === ctx.user?.id })));

    router.post('/api/team-chat/cards', 'location', async (ctx) => {
      quiet(ctx);
      return { cards: await resolveEmbeds(app, ctx, Array.isArray(ctx.body?.refs) ? ctx.body.refs : []) };
    });

    // --- realtime: SSE + POST -------------------------------------------------------------------------------------------
    router.get('/api/team-chat/stream', 'location', (ctx): RawResult => {
      const u = person(ctx);
      const clientId = String(ctx.query.get('clientId') ?? '');
      if (!/^[A-Za-z0-9_-]{6,64}$/.test(clientId)) throw bad('clientId fehlt');
      const mine = new Set(teamUsers(app, ctx.locationId, 'teamchat').map((p) => p.id));
      const stream = hub.subscribe({ clientId, userId: u.id, locationId: ctx.locationId, admin: u.role === 'admin', alive: loginOf(app, ctx), onlineIds: (ids) => ids.filter((x) => mine.has(x)) });
      // not a 200 stream that ends at once: the browser's EventSource gives up instead of retrying every few seconds
      if (!stream) throw new HttpError(503, 'Zu viele Live-Verbindungen – bitte später noch einmal');
      return { __raw: true, status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' }, body: stream };
    });
    /** "This tab is in the foreground / not": keeps push quiet for people who are reading. */
    router.post('/api/team-chat/presence', 'location', (ctx) => {
      quiet(ctx);
      const u = person(ctx);
      hub.touch(String(ctx.body?.client_id ?? ''), u.id, ctx.body?.active !== false);
      return { ok: true };
    });
    router.get('/api/team-chat/presence', 'location', (ctx) => {
      const mine = new Set(teamUsers(app, ctx.locationId, 'teamchat').map((p) => p.id));
      return { online: hub.onlineIds().filter((x) => mine.has(x)) };
    });

    // --- settings: retention ------------------------------------------------------------------------------------------------------
    const settingsOf = (scope: string) => {
      const row = db.get<{ data: string }>('SELECT data FROM teamchat_settings WHERE scope = ?', scope);
      try {
        return { ...SETTINGS_DEFAULT, ...(row ? JSON.parse(row.data) : {}) } as { retention_days: number };
      } catch {
        return { ...SETTINGS_DEFAULT };
      }
    };
    const scopeOf = (ctx: Ctx) => {
      if (ctx.query.get('scope') === 'agency') {
        if (ctx.user?.role !== 'admin' || isBot(ctx)) throw new HttpError(403, 'Nur für die Agentur');
        return '_agency';
      }
      return ctx.locationId;
    };
    router.get('/api/team-chat/settings', 'location', (ctx) => {
      const scope = scopeOf(ctx);
      return { ...settingsOf(scope), scope: scope === '_agency' ? 'agency' : 'location', choices: RETENTION_CHOICES, slack_available: scope !== '_agency' && slackReady(scope), can_edit: !isBot(ctx) && !!ctx.user && (ctx.user.role === 'admin' || !ctx.user.permissions || ctx.user.permissions.includes('settings')) };
    });
    router.put('/api/team-chat/settings', 'location', (ctx) => {
      const u = person(ctx);
      if (!(u.role === 'admin' || !u.permissions || u.permissions.includes('settings'))) throw new HttpError(403, 'Dafür fehlt das Recht „Einstellungen des Sub-Accounts“');
      const scope = scopeOf(ctx);
      const cur = settingsOf(scope);
      const days = ctx.body?.retention_days;
      if (days !== undefined) {
        const n = Math.round(Number(days));
        if (!Number.isFinite(n) || n < 0 || n > 3650 || (n > 0 && n < 7)) throw bad('Aufbewahrung: 0 (unbegrenzt) oder 7 bis 3650 Tage');
        cur.retention_days = n;
      }
      db.run('INSERT INTO teamchat_settings (scope, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(scope) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at', scope, JSON.stringify(cur), now());
      return { ...cur, scope: scope === '_agency' ? 'agency' : 'location' };
    });

    /** Deletes what is older than a sub-account's (or the agency's) retention setting; pinned messages stay. */
    const runRetention = () => {
      let removed = 0;
      for (const s of db.all<{ scope: string; data: string }>('SELECT scope, data FROM teamchat_settings')) {
        let days = 0;
        try {
          days = Number(JSON.parse(s.data).retention_days) || 0;
        } catch {
          days = 0;
        }
        if (!days) continue;
        const cutoff = new Date(Date.now() - days * 864e5).toISOString();
        const where = s.scope === '_agency' ? 'c.location_id IS NULL' : 'c.location_id = ?';
        const old = db.all<{ id: string }>(`SELECT m.id FROM teamchat_messages m JOIN teamchat_channels c ON c.id = m.channel_id WHERE ${where} AND m.created_at < ? AND m.pinned_at IS NULL LIMIT 500`, ...(s.scope === '_agency' ? [] : [s.scope]), cutoff).map((m) => m.id);
        if (!old.length) continue;
        // a thread ages with its first message
        const marks = old.map(() => '?').join(',');
        const replies = db.all<{ id: string }>(`SELECT id FROM teamchat_messages WHERE thread_id IN (${marks}) AND pinned_at IS NULL`, ...old).map((m) => m.id);
        purgeMessages(app, [...new Set([...old, ...replies])]);
        removed += old.length + replies.length;
      }
      return removed;
    };
    app.services.teamchatRetention = runRetention;
    let lastRetention = 0;
    app.onTick(() => {
      if (Date.now() - lastRetention < 30 * 60_000) return;
      lastRetention = Date.now();
      runRetention();
      // files that were uploaded but never sent
      const stale = db.all<{ id: string; file: string }>('SELECT id, file FROM teamchat_files WHERE message_id IS NULL AND created_at < ? LIMIT 200', new Date(Date.now() - 864e5).toISOString());
      removeFiles(app, stale);
      for (const f of stale) db.run('DELETE FROM teamchat_files WHERE id = ?', f.id);
    });

    app.services.teamchat = { post: postMessage, notify: notifyMessage, channelOut, hub, settleAgent: async () => app.services.collabIdle?.() };
  },
};
