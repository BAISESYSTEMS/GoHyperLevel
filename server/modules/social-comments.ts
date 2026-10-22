import type { Module } from '../core/app.js';
import { HttpError, bad, clampLimit, notFound, str } from '../core/http.js';
import { id, now } from '../core/util.js';
import { withDefaults as aiDefaults } from '../services/ai-context.js';
import { getContact, logActivity, upsertContact } from '../services/contacts.js';
import { parseComments } from '../services/igcomments.js';
import { inboundGate } from '../services/inbound-gate.js';
import { getOrCreateConversation } from '../services/messaging.js';
import type { MetaChannel } from '../services/meta.js';
import { brandVoice } from '../services/review-replies.js';
import {
  CAN_HIDE,
  COMMENT_PLATFORMS,
  LINKEDIN_VERSION,
  PLATFORM_LABEL,
  REPLY_LIMIT,
  commentReplySystem,
  commentReplyUser,
  finishCommentReply,
  parseLinkedInComments,
  parseYouTubeThreads,
  type CommentIn,
  type CommentPlatform,
} from '../services/social-comments.js';
import { registerTriggers } from '../services/wfx-kit.js';
import type { Tool } from './mcp.js';

/**
 * Social comments inbox: comments under the sub-account's own Facebook and Instagram posts (the Meta webhook it already receives –
 * fields `feed` and `comments`, see docs/comment-to-dm.md) and, where a Nango connection exists, under its YouTube videos and
 * LinkedIn organisation posts (polled every 15 minutes) land in Konversationen as the channel "Kommentare": one message per comment
 * on the commenter's contact, with reply (public, under the comment), hide/show and an AI reply suggestion. Replies to Facebook and
 * Instagram go out with the token of the page that received the comment (several pages: modules/meta-channels.ts). Docs:
 * docs/social-comments.md.
 */

const CHANNEL = 'comment';
const POLL_MS = 15 * 60_000;
const SUGGEST_CAP = 60;
const TRIGGER = 'social_comment.received';
const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };

interface CommentRow {
  id: string;
  location_id: string;
  platform: CommentPlatform;
  account_id: string;
  post_id: string;
  comment_id: string;
  thread_id: string;
  author_id: string;
  author_name: string;
  text: string;
  permalink: string;
  contact_id: string | null;
  message_id: string | null;
  hidden: number;
  reply_text: string;
  reply_id: string;
  reply_message_id: string | null;
  replied_at: string | null;
  suggestion: string;
  created_at: string;
}

interface Settings {
  meta: boolean;
  youtube: boolean;
  linkedin: boolean;
  linkedin_org: string;
  youtube_since: string | null;
  linkedin_since: string | null;
  last_poll_at: string | null;
  last_error: string | null;
}

const TOOLS: Tool[] = [
  {
    name: 'ghl_social_comments',
    title: 'Social-Kommentare',
    description:
      'Kommentare unter eigenen Facebook-, Instagram-, YouTube- und LinkedIn-Beiträgen (Kanal „Kommentare“ im Posteingang): action list (Standard, Filter platform und open=true für unbeantwortete), reply (öffentliche Antwort, text), hide (hidden true/false; LinkedIn kann nicht ausblenden) oder suggest (KI-Antwortvorschlag, veröffentlicht nichts). comment_id aus list.',
    inputSchema: {
      type: 'object',
      properties: {
        ...LOC,
        action: { type: 'string', enum: ['list', 'reply', 'hide', 'suggest'] },
        comment_id: { type: 'string' },
        text: { type: 'string', description: 'Antworttext (bei reply)' },
        hidden: { type: 'boolean', description: 'Ausblenden (true) oder wieder zeigen (false)' },
        platform: { type: 'string', enum: [...COMMENT_PLATFORMS] },
        open: { type: 'boolean', description: 'Nur unbeantwortete' },
      },
      required: ['location_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    klassFor: (a) => (!a.action || a.action === 'list' ? 'read' : 'write'),
    run: (call, a) => {
      const cid = encodeURIComponent(String(a.comment_id ?? ''));
      switch (a.action ?? 'list') {
        case 'list': {
          const q = new URLSearchParams();
          if (a.platform) q.set('platform', String(a.platform));
          if (a.open) q.set('status', 'open');
          return call.api('GET', `/api/social-comments?${q}`, { location: a.location_id });
        }
        case 'reply':
          return call.api('POST', `/api/social-comments/${cid}/reply`, { location: a.location_id, body: { text: a.text } });
        case 'hide':
          return call.api('POST', `/api/social-comments/${cid}/hide`, { location: a.location_id, body: { hidden: a.hidden !== false } });
        case 'suggest':
          return call.api('POST', `/api/social-comments/${cid}/suggest`, { location: a.location_id, body: {} });
        default:
          throw new Error('action: list, reply, hide oder suggest');
      }
    },
  },
];

export const socialCommentsModule: Module = {
  name: 'social-comments',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE social_comments (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        platform TEXT NOT NULL, account_id TEXT NOT NULL DEFAULT '', post_id TEXT NOT NULL DEFAULT '', comment_id TEXT NOT NULL, thread_id TEXT NOT NULL DEFAULT '',
        author_id TEXT NOT NULL DEFAULT '', author_name TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', permalink TEXT NOT NULL DEFAULT '',
        contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE, message_id TEXT, hidden INTEGER NOT NULL DEFAULT 0,
        reply_text TEXT NOT NULL DEFAULT '', reply_id TEXT NOT NULL DEFAULT '', reply_message_id TEXT, replied_at TEXT, replied_by TEXT,
        suggestion TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(location_id, platform, comment_id)
      );
      CREATE INDEX social_comments_loc ON social_comments(location_id, created_at);
      CREATE INDEX social_comments_contact ON social_comments(contact_id, created_at);
      CREATE INDEX social_comments_msg ON social_comments(message_id);
      CREATE TABLE social_comment_authors (
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, platform TEXT NOT NULL, author_id TEXT NOT NULL,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY (location_id, platform, author_id)
      );
      CREATE INDEX social_comment_authors_contact ON social_comment_authors(contact_id);
      CREATE TABLE social_comment_settings (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE, data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    registerTriggers(app, [
      {
        type: TRIGGER,
        label: 'Neuer Social-Kommentar (Facebook/Instagram/YouTube/LinkedIn)',
        category: 'messages',
        summary: 'Jemand hat unter einem eigenen Beitrag kommentiert – der Kommentar steht im Posteingang (Kanal „Kommentare“).',
        doc: 'Der Kontakt ist der Kommentierende (wird angelegt oder wiedererkannt). {{event.platform}} ist facebook, instagram, youtube oder linkedin, {{event.text}} der Kommentar, {{event.permalink}} der Link zum Beitrag. Typisch: Aufgabe fürs Social-Team, Tag, KI-Vorschlag prüfen lassen.',
        fields: [{ key: 'platform', label: 'Nur Plattform', type: 'select', options: COMMENT_PLATFORMS.map((p): [string, string] => [p, PLATFORM_LABEL[p]]) }],
        sample: { platform: 'instagram', text: 'Wie lange dauert so ein Umbau?', commentId: 'c1', postId: '1789…', permalink: 'https://www.instagram.com/p/…' },
        keywords: 'kommentar social facebook instagram youtube linkedin posteingang antwort',
      },
    ]);
    app.services.workflowTriggerFilters = { ...(app.services.workflowTriggerFilters ?? {}), [TRIGGER]: (c: any, d: any) => !c.platform || c.platform === d.platform };

    const kit = () => app.services.metaKit as
      | { accountFor(hook: string, secret: string, ch: MetaChannel, accountId: string): string | undefined; ids(loc: string): any; graph(loc: string, ch: MetaChannel, method: string, path: string, body?: unknown, accountId?: string): Promise<any> }
      | undefined;
    const metaChannel = (p: CommentPlatform): MetaChannel => (p === 'instagram' ? 'instagram' : 'messenger');

    // --- settings ---------------------------------------------------------------------------------------------------
    const settingsOf = (loc: string): Settings => {
      let d: any = {};
      try {
        d = JSON.parse(db.get<{ data: string }>('SELECT data FROM social_comment_settings WHERE location_id = ?', loc)?.data ?? '{}');
      } catch {
        d = {};
      }
      return { meta: d.meta !== false, youtube: !!d.youtube, linkedin: !!d.linkedin, linkedin_org: String(d.linkedin_org ?? ''), youtube_since: d.youtube_since ?? null, linkedin_since: d.linkedin_since ?? null, last_poll_at: d.last_poll_at ?? null, last_error: d.last_error ?? null };
    };
    const saveSettings = (loc: string, s: Settings) =>
      db.run('INSERT INTO social_comment_settings (location_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at', loc, JSON.stringify(s), now());
    /** The sub-account's active Nango connection for a provider (YouTube, LinkedIn). */
    const nangoConn = (loc: string, provider: 'youtube' | 'linkedin'): { integration: string } | undefined => {
      try {
        return (app.services.nango?.connections?.(loc) ?? []).find((c: any) => c.status === 'active' && (c.provider === provider || c.integration === provider));
      } catch {
        return undefined;
      }
    };
    const settingsOut = (loc: string) => {
      const s = settingsOf(loc);
      const ids = kit()?.ids(loc);
      return {
        ...s,
        sources: {
          facebook: { available: !!ids?.messenger, accounts: (ids?.pages ?? []).filter((p: any) => p.messenger).map((p: any) => p.page_name || p.page_id) },
          instagram: { available: !!ids?.instagram, accounts: (ids?.pages ?? []).filter((p: any) => p.instagram).map((p: any) => (p.ig_username ? `@${p.ig_username}` : p.ig_account_id)) },
          youtube: { available: !!nangoConn(loc, 'youtube'), via: 'nango' },
          linkedin: { available: !!nangoConn(loc, 'linkedin'), via: 'nango' },
        },
        webhook_fields: { page: 'feed', instagram: 'comments' },
      };
    };

    // --- contacts ---------------------------------------------------------------------------------------------------
    /** The commenter's contact: Facebook/Instagram share the identities of the Meta inbox (and Kommentar-zu-DM), the others their own map. */
    const contactFor = (loc: string, c: CommentIn): string => {
      const meta = c.platform === 'facebook' || c.platform === 'instagram';
      const ch = metaChannel(c.platform);
      const known = meta
        ? db.get<{ contact_id: string }>('SELECT contact_id FROM meta_identities WHERE location_id = ? AND channel = ? AND external_id = ?', loc, ch, c.authorId)
        : db.get<{ contact_id: string }>('SELECT contact_id FROM social_comment_authors WHERE location_id = ? AND platform = ? AND author_id = ?', loc, c.platform, c.authorId);
      if (known && getContact(app, loc, known.contact_id)) return known.contact_id;
      const username = c.platform === 'instagram' ? c.authorName.replace(/^@/, '') : '';
      const name = username ? `@${username}` : c.authorName || `${PLATFORM_LABEL[c.platform]}-Kontakt`;
      const contact = upsertContact(app, loc, { name, ...(username ? { custom: { instagram: `@${username}` } } : {}) }, { source: `${PLATFORM_LABEL[c.platform]}-Kommentar`, tags: [`${c.platform}-kommentar`] }).contact;
      if (!c.authorId) return contact.id;
      if (meta) db.run('INSERT OR IGNORE INTO meta_identities (location_id, channel, external_id, contact_id, name, created_at, account_id) VALUES (?, ?, ?, ?, ?, ?, ?)', loc, ch, c.authorId, contact.id, name.slice(0, 120), now(), c.accountId);
      else db.run('INSERT OR IGNORE INTO social_comment_authors (location_id, platform, author_id, contact_id, created_at) VALUES (?, ?, ?, ?, ?)', loc, c.platform, c.authorId, contact.id, now());
      return contact.id;
    };

    // --- one comment into the inbox ---------------------------------------------------------------------------------------
    const preview = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 140);
    const ingest = (loc: string, c: CommentIn): boolean => {
      if (!c.commentId || (c.authorId && c.authorId === c.accountId)) return false;
      if (db.get('SELECT 1 FROM social_comments WHERE location_id = ? AND platform = ? AND comment_id = ?', loc, c.platform, c.commentId)) return false;
      const contactId = contactFor(loc, c);
      const conversationId = getOrCreateConversation(app, loc, contactId);
      // Live comments keep our clock (sorting next to replies); late ones (polling) keep the platform's time.
      const at = c.at && Date.now() - Date.parse(c.at) > 120_000 ? c.at : now();
      const label = `${PLATFORM_LABEL[c.platform]}-Kommentar`;
      const row = { id: id(), location_id: loc, platform: c.platform, account_id: c.accountId, post_id: c.postId, comment_id: c.commentId, thread_id: c.threadId ?? '', author_id: c.authorId, author_name: c.authorName.slice(0, 120), text: c.text, permalink: c.permalink, contact_id: contactId, created_at: at, updated_at: now() };
      try {
        db.insert('social_comments', row);
      } catch (e) {
        if (/UNIQUE/i.test((e as Error).message)) return false;
        throw e;
      }
      const msg = { id: id(), location_id: loc, conversation_id: conversationId, contact_id: contactId, channel: CHANNEL, direction: 'in', subject: '', body: c.text || '(ohne Text)', status: 'received', error: '', source: label, external_id: `cm:${c.platform}:${c.commentId}`.slice(0, 300), created_at: at };
      db.insert('messages', msg);
      db.run('UPDATE social_comments SET message_id = ? WHERE id = ?', msg.id, row.id);
      const newer = db.get('SELECT 1 FROM messages WHERE conversation_id = ? AND created_at > ? AND id != ? LIMIT 1', conversationId, at, msg.id);
      if (newer) db.run('UPDATE conversations SET unread = unread + 1 WHERE id = ?', conversationId);
      else db.run('UPDATE conversations SET unread = unread + 1, last_message = ?, last_message_at = ? WHERE id = ?', preview(msg.body), at, conversationId);
      // Blocked senders (inbox-spam): archived silently, no event.
      const claim = inboundGate(app, { locationId: loc, contactId, channel: CHANNEL });
      if (claim) return (claim.archive(conversationId, msg.id), true);
      logActivity(app, loc, contactId, 'comment.received', `${label}: ${preview(c.text) || '(ohne Text)'}`);
      app.events.emit(loc, 'message.inbound', { contactId, contact: getContact(app, loc, contactId), message: msg });
      app.events.emit(loc, TRIGGER, { contactId, commentId: row.id, platform: c.platform, text: c.text, postId: c.postId, permalink: c.permalink });
      return true;
    };
    app.services.socialComments = { ingest };

    // Facebook (`feed`) and Instagram (`comments`) arrive on the Meta webhook the channels module receives.
    app.services.metaWebhookHooks = [
      ...(app.services.metaWebhookHooks ?? []),
      async ({ payload, secret, locationId }: { payload: any; secret: string; locationId: string }) => {
        for (const ev of parseComments(payload)) {
          const loc = kit()?.accountFor(locationId, secret, metaChannel(ev.platform), ev.accountId);
          if (!loc || !settingsOf(loc).meta) continue;
          ingest(loc, {
            platform: ev.platform,
            accountId: ev.accountId,
            commentId: ev.commentId,
            postId: ev.mediaId,
            authorId: ev.fromId,
            authorName: ev.fromUsername ? `@${ev.fromUsername}` : ev.fromName,
            text: ev.text,
            permalink: ev.platform === 'facebook' && ev.commentId ? `https://www.facebook.com/${encodeURIComponent(ev.commentId)}` : '',
            at: null,
          });
        }
      },
    ];

    // --- YouTube and LinkedIn through Nango ----------------------------------------------------------------------------
    const nango = async (loc: string, provider: 'youtube' | 'linkedin', method: string, path: string, query?: Record<string, string>, body?: unknown) => {
      const conn = nangoConn(loc, provider);
      if (!conn || !app.services.nango?.request) throw new HttpError(409, `${PLATFORM_LABEL[provider]} ist nicht über Nango verbunden (Apps → Nango)`);
      const headers = provider === 'linkedin' ? { 'LinkedIn-Version': LINKEDIN_VERSION, 'X-Restli-Protocol-Version': '2.0.0' } : undefined;
      const r = await app.services.nango.request(loc, { integration: conn.integration, method, path, query, headers, body }, { source: 'api' });
      if (!r.ok) throw new HttpError(502, `${PLATFORM_LABEL[provider]}: ${r.data?.error?.message || r.data?.message || `Fehler ${r.status}`}`);
      return r.data;
    };
    const pollYouTube = async (loc: string, since: string | null) => {
      const ch = await nango(loc, 'youtube', 'GET', '/youtube/v3/channels', { part: 'id,contentDetails', mine: 'true' });
      const channel = ch?.items?.[0];
      const uploads = channel?.contentDetails?.relatedPlaylists?.uploads;
      if (!uploads) return 0;
      const vids = await nango(loc, 'youtube', 'GET', '/youtube/v3/playlistItems', { part: 'contentDetails', playlistId: String(uploads), maxResults: '5' });
      let n = 0;
      for (const v of (vids?.items ?? []).slice(0, 5)) {
        const videoId = String(v?.contentDetails?.videoId ?? '');
        if (!videoId) continue;
        const threads = await nango(loc, 'youtube', 'GET', '/youtube/v3/commentThreads', { part: 'snippet', videoId, maxResults: '20', order: 'time', textFormat: 'plainText' });
        for (const c of parseYouTubeThreads(threads, String(channel.id ?? ''))) if (!since || (c.at ?? '') >= since) n += ingest(loc, c) ? 1 : 0;
      }
      return n;
    };
    const pollLinkedIn = async (loc: string, org: string, since: string | null) => {
      const posts = await nango(loc, 'linkedin', 'GET', '/rest/posts', { author: org, q: 'author', count: '5', sortBy: 'LAST_MODIFIED' });
      let n = 0;
      for (const p of (posts?.elements ?? []).slice(0, 5)) {
        const urn = String(p?.id ?? '');
        if (!urn) continue;
        const comments = await nango(loc, 'linkedin', 'GET', `/rest/socialActions/${encodeURIComponent(urn)}/comments`, { count: '20' });
        for (const c of parseLinkedInComments(comments, org, urn)) if (!since || (c.at ?? '') >= since) n += ingest(loc, c) ? 1 : 0;
      }
      return n;
    };
    const poll = async (loc: string) => {
      const s = settingsOf(loc);
      const errors: string[] = [];
      let n = 0;
      if (s.youtube && nangoConn(loc, 'youtube')) n += await pollYouTube(loc, s.youtube_since).catch((e) => (errors.push((e as Error).message), 0));
      if (s.linkedin && s.linkedin_org && nangoConn(loc, 'linkedin')) n += await pollLinkedIn(loc, s.linkedin_org, s.linkedin_since).catch((e) => (errors.push((e as Error).message), 0));
      saveSettings(loc, { ...settingsOf(loc), last_poll_at: now(), last_error: errors.length ? errors.join(' · ').slice(0, 500) : null });
      return { new: n, errors };
    };
    let polling = false;
    app.onTick(async () => {
      if (polling) return;
      polling = true;
      try {
        for (const r of db.all<{ location_id: string }>(`SELECT location_id FROM social_comment_settings WHERE json_extract(data, '$.youtube') = 1 OR json_extract(data, '$.linkedin') = 1 LIMIT 200`)) {
          const s = settingsOf(r.location_id);
          if (s.last_poll_at && Date.now() - Date.parse(s.last_poll_at) < POLL_MS) continue;
          await poll(r.location_id).catch(() => undefined);
        }
      } finally {
        polling = false;
      }
    });

    // --- API -------------------------------------------------------------------------------------------------------
    const commentOf = (loc: string, key: string) => {
      const c = db.get<CommentRow>('SELECT * FROM social_comments WHERE location_id = ? AND (id = ? OR message_id = ?)', loc, key, key);
      if (!c) throw notFound('Kommentar nicht gefunden');
      return c;
    };
    const commentOut = (c: CommentRow) => ({
      id: c.id,
      platform: c.platform,
      platform_label: PLATFORM_LABEL[c.platform],
      author: c.author_name,
      text: c.text,
      permalink: c.permalink,
      contact_id: c.contact_id,
      message_id: c.message_id,
      hidden: !!c.hidden,
      can_hide: CAN_HIDE[c.platform],
      reply: c.reply_text || null,
      replied_at: c.replied_at,
      suggestion: c.suggestion || null,
      limit: REPLY_LIMIT[c.platform],
      created_at: c.created_at,
    });

    router.get('/api/social-comments', 'location', (ctx) => {
      const where = ['location_id = ?'];
      const args: any[] = [ctx.locationId];
      const platform = ctx.query.get('platform');
      if (platform && (COMMENT_PLATFORMS as readonly string[]).includes(platform)) (where.push('platform = ?'), args.push(platform));
      if (ctx.query.get('status') === 'open') where.push(`reply_text = '' AND hidden = 0`);
      if (ctx.query.get('contact_id')) (where.push('contact_id = ?'), args.push(ctx.query.get('contact_id')));
      const rows = db.all<CommentRow>(`SELECT * FROM social_comments WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`, ...args, clampLimit(ctx.query.get('limit'), 50, 200));
      return { comments: rows.map(commentOut) };
    });

    router.get('/api/social-comments/settings', 'location', (ctx) => settingsOut(ctx.locationId));
    router.put('/api/social-comments/settings', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const s = settingsOf(ctx.locationId);
      if (b.meta !== undefined) s.meta = !!b.meta;
      // Switching a polled platform on starts with what comes next – older comments do not flood the inbox.
      if (b.youtube !== undefined) {
        if (b.youtube && !s.youtube) s.youtube_since = now();
        s.youtube = !!b.youtube;
      }
      if (b.linkedin_org !== undefined) {
        const org = str(b.linkedin_org, 'LinkedIn-Organisation', { max: 80 }).trim();
        const urn = /^\d{1,20}$/.test(org) ? `urn:li:organization:${org}` : org;
        if (urn && !/^urn:li:organization:\d{1,20}$/.test(urn)) throw bad('LinkedIn-Organisation: Zahl oder urn:li:organization:123');
        s.linkedin_org = urn;
      }
      if (b.linkedin !== undefined) {
        if (b.linkedin && !s.linkedin_org) throw bad('Für LinkedIn zuerst die Organisation eintragen');
        if (b.linkedin && !s.linkedin) s.linkedin_since = now();
        s.linkedin = !!b.linkedin;
      }
      saveSettings(ctx.locationId, s);
      return settingsOut(ctx.locationId);
    });
    router.post('/api/social-comments/poll', 'location', (ctx) => poll(ctx.locationId));

    /** Public reply under the comment, written to the conversation like any outgoing message. */
    router.post('/api/social-comments/:id/reply', 'location', async (ctx) => {
      const c = commentOf(ctx.locationId, ctx.params.id);
      const text = str(ctx.body?.text, 'Antwort', { required: true, max: REPLY_LIMIT[c.platform] }).trim();
      if (!text) throw bad('Antwort fehlt');
      let replyId = '';
      if (c.platform === 'facebook' || c.platform === 'instagram') {
        if (!kit()) throw new HttpError(409, 'Meta-Kanäle sind nicht verfügbar');
        const r = await kit()!.graph(ctx.locationId, metaChannel(c.platform), 'POST', c.platform === 'instagram' ? `${c.comment_id}/replies` : `${c.comment_id}/comments`, { message: text }, c.account_id);
        replyId = String(r?.id ?? '');
      } else if (c.platform === 'youtube') {
        const r = await nango(ctx.locationId, 'youtube', 'POST', '/youtube/v3/comments', { part: 'snippet' }, { snippet: { parentId: c.thread_id || c.comment_id, textOriginal: text } });
        replyId = String(r?.id ?? '');
      } else {
        const r = await nango(ctx.locationId, 'linkedin', 'POST', `/rest/socialActions/${encodeURIComponent(c.post_id)}/comments`, undefined, { actor: c.account_id, object: c.post_id, parentComment: c.comment_id, message: { text } });
        replyId = String(r?.commentUrn ?? r?.id ?? '');
      }
      const contactId = c.contact_id;
      let messageId: string | null = null;
      if (contactId && getContact(app, ctx.locationId, contactId)) {
        const conversationId = getOrCreateConversation(app, ctx.locationId, contactId);
        const msg = { id: id(), location_id: ctx.locationId, conversation_id: conversationId, contact_id: contactId, channel: CHANNEL, direction: 'out', subject: '', body: text, status: 'sent', error: '', source: `Antwort auf ${PLATFORM_LABEL[c.platform]}-Kommentar`, user_id: ctx.user?.id ?? null, created_at: now() };
        db.insert('messages', msg);
        db.run('UPDATE conversations SET last_message = ?, last_message_at = ? WHERE id = ?', preview(text), msg.created_at, conversationId);
        logActivity(app, ctx.locationId, contactId, 'comment.replied', `Öffentlich auf ${PLATFORM_LABEL[c.platform]} geantwortet`);
        messageId = msg.id;
      }
      db.run(`UPDATE social_comments SET reply_text = ?, reply_id = ?, reply_message_id = ?, replied_at = ?, replied_by = ?, suggestion = '', updated_at = ? WHERE id = ?`, text, replyId.slice(0, 300), messageId, now(), ctx.user?.id ?? null, now(), c.id);
      return commentOut(db.get<CommentRow>('SELECT * FROM social_comments WHERE id = ?', c.id)!);
    });

    router.post('/api/social-comments/:id/hide', 'location', async (ctx) => {
      const c = commentOf(ctx.locationId, ctx.params.id);
      const hidden = ctx.body?.hidden !== false;
      if (!CAN_HIDE[c.platform]) throw bad(`${PLATFORM_LABEL[c.platform]} erlaubt kein Ausblenden über die API – bitte auf der Plattform löschen`);
      if (c.platform === 'facebook' || c.platform === 'instagram') {
        if (!kit()) throw new HttpError(409, 'Meta-Kanäle sind nicht verfügbar');
        await kit()!.graph(ctx.locationId, metaChannel(c.platform), 'POST', c.comment_id, c.platform === 'instagram' ? { hide: hidden } : { is_hidden: hidden }, c.account_id);
      } else {
        await nango(ctx.locationId, 'youtube', 'POST', '/youtube/v3/comments/setModerationStatus', { id: c.comment_id, moderationStatus: hidden ? 'heldForReview' : 'published' });
      }
      db.run('UPDATE social_comments SET hidden = ?, updated_at = ? WHERE id = ?', hidden ? 1 : 0, now(), c.id);
      return commentOut(db.get<CommentRow>('SELECT * FROM social_comments WHERE id = ?', c.id)!);
    });

    /** An AI suggestion (KI-Assistent, monthly limit) – stored on the comment, never posted. */
    router.post('/api/social-comments/:id/suggest', 'location', async (ctx) => {
      const c = commentOf(ctx.locationId, ctx.params.id);
      const problem: string | null = (app.services.aiReady?.(ctx.locationId) as string | null | undefined) ?? (app.services.aiRun ? null : 'Der KI-Assistent ist nicht verfügbar.');
      if (problem || !app.services.aiRun) throw new HttpError(409, problem ?? 'Der KI-Assistent ist nicht verfügbar');
      const used = db.get<{ n: number }>(`SELECT COUNT(*) n FROM ai_calls WHERE location_id = ? AND purpose = 'social_comment_reply' AND created_at >= ?`, ctx.locationId, new Date(Date.now() - 3600_000).toISOString())!.n;
      if (used >= SUGGEST_CAP) throw new HttpError(429, 'Zu viele Vorschläge in kurzer Zeit – bitte in einer Stunde noch einmal');
      let voice = '';
      try {
        const row = db.get<{ data: string }>('SELECT data FROM ai_settings WHERE location_id = ?', ctx.locationId);
        const s = aiDefaults(row ? JSON.parse(row.data || '{}') : null);
        voice = brandVoice({ persona: s.persona, facts: s.facts });
      } catch {
        voice = '';
      }
      let formality: 'sie' | 'du' = 'sie';
      try {
        formality = db.get<{ formality: string }>('SELECT formality FROM review_reply_settings WHERE location_id = ?', ctx.locationId)?.formality === 'du' ? 'du' : 'sie';
      } catch {
        /* review replies not loaded */
      }
      const r = await app.services.aiRun({
        locationId: ctx.locationId,
        purpose: 'social_comment_reply',
        system: commentReplySystem({ locationName: app.location(ctx.locationId)!.name, platform: c.platform, voice, formality }),
        user: commentReplyUser({ author: c.author_name, text: c.text, platform: c.platform }, str(ctx.body?.instruction, 'Hinweis', { max: 500 })),
        maxTokens: 400,
        timeoutMs: 45_000,
        contactId: c.contact_id,
        userId: ctx.user?.id ?? null,
      });
      const text = finishCommentReply(r.text, c.platform);
      if (!text) throw new HttpError(502, 'Die KI hat keinen Text geliefert – bitte noch einmal versuchen');
      db.run('UPDATE social_comments SET suggestion = ?, updated_at = ? WHERE id = ?', text, now(), c.id);
      return { text, comment: commentOut(db.get<CommentRow>('SELECT * FROM social_comments WHERE id = ?', c.id)!) };
    });

    // The inbox shows reply / hide / suggestion on each comment (web/src/pages/SocialComments.tsx via the slot "inbox.message").
    app.services.messageRows = [
      ...(app.services.messageRows ?? []),
      (_ctx: unknown, conversationId: string, rows: any[]) => {
        if (!rows.some((m) => m.channel === CHANNEL && m.direction === 'in')) return rows;
        const byMsg = new Map(db.all<CommentRow>(`SELECT s.* FROM social_comments s JOIN messages m ON m.id = s.message_id WHERE m.conversation_id = ?`, conversationId).map((c) => [c.message_id, c]));
        return rows.map((m) => (byMsg.has(m.id) ? { ...m, comment: commentOut(byMsg.get(m.id)!) } : m));
      },
    ];
  },
};
