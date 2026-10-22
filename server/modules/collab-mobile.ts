import { readFileSync } from 'node:fs';
import type { Module } from '../core/app.js';
import { HttpError, bad, clampLimit, notFound, type Ctx, type RawResult } from '../core/http.js';
import { areaAllowed } from '../services/canvas-cards.js';
import { visibleLocations, type Loc } from '../services/mobile.js';
import { notifyMessage } from '../services/teamchat-notify.js';
import {
  channelAccess,
  channelLabel,
  filePath,
  loadChannel,
  markRead,
  memberOf,
  messageOut,
  postMessage,
  unreadCounts,
  visibleChannels,
  type ChannelRow,
  type MessageRow,
} from '../services/teamchat-store.js';
import { markdownToText, renderMarkdown } from '../services/wiki-markdown.js';
import { loadPage, pagePath, searchPages, type PageRow, type SpaceRow } from '../services/wiki-store.js';

/**
 * Mobile API of the Wiki and the Team-Chat (/api/mobile/chat/*, /api/mobile/wiki/*) for the Android app (device
 * token, same sub-accounts, member areas and SaaS plan as the web app; contract: docs/api.md → "Mobile-App"):
 * chat channels with unread counters, messages, posting and marking read, and reading wiki pages. New chat
 * messages also arrive on the notification feed (/api/mobile/feed, event type "chat").
 */

export const collabMobileModule: Module = {
  name: 'collab-mobile',
  register(app) {
    const { db, router } = app;
    const inLoc = (ctx: Ctx, locationId: string): Ctx => ({ ...ctx, locationId });
    const wikiOk = (ctx: Ctx, loc: string) => areaAllowed(app, inLoc(ctx, loc), '/api/wiki');
    const chatOk = (ctx: Ctx, loc: string) => areaAllowed(app, inLoc(ctx, loc), '/api/team-chat');

    /** Sub-accounts to read: ?location=all (default) or one the person may open. */
    const scope = (ctx: Ctx, ok: (c: Ctx, l: string) => boolean): Loc[] => {
      const want = String(ctx.query.get('location') ?? '').trim() || 'all';
      const visible = visibleLocations(app, ctx);
      if (want !== 'all') {
        const l = visible.find((x) => x.id === want);
        if (!l) {
          if (!db.get('SELECT id FROM locations WHERE id = ?', want)) throw notFound('Sub-Account nicht gefunden');
          throw new HttpError(403, 'Kein Zugriff auf diesen Sub-Account');
        }
        if (!ok(ctx, l.id)) throw new HttpError(403, 'Dieser Bereich ist für dich oder deinen Tarif nicht freigeschaltet');
        return [l];
      }
      return visible.filter((l) => ok(ctx, l.id));
    };

    /** The sub-account to act in for a channel: its own, or – direct messages, agency channels – the first one that works. */
    const ctxForChannel = (ctx: Ctx, channelId: string): { ctx: Ctx; ch: ChannelRow; loc: Loc } => {
      const ch = db.get<ChannelRow>('SELECT * FROM teamchat_channels WHERE id = ?', channelId);
      if (!ch) throw notFound('Kanal nicht gefunden');
      const visible = visibleLocations(app, ctx).filter((l) => (ch.location_id ? l.id === ch.location_id : true) && chatOk(ctx, l.id));
      for (const l of visible) {
        const c = inLoc(ctx, l.id);
        if (channelAccess(app, c, ch)) return { ctx: c, ch, loc: l };
      }
      throw notFound('Kanal nicht gefunden');
    };

    // --- chat --------------------------------------------------------------------------------------------
    router.get('/api/mobile/chat/channels', 'user', (ctx) => {
      const seen = new Map<string, any>();
      for (const l of scope(ctx, chatOk)) {
        const c = inLoc(ctx, l.id);
        const list = visibleChannels(app, c);
        const counts = unreadCounts(app, ctx.user!.id, list.map((x) => x.ch.id));
        for (const { ch, role } of list) {
          if (seen.has(ch.id)) continue;
          const me = memberOf(app, ch.id, ctx.user!.id);
          const k = counts.get(ch.id) ?? { unread: 0, mentions: 0 };
          const last = db.get<MessageRow>('SELECT * FROM teamchat_messages WHERE channel_id = ? AND thread_id IS NULL AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1', ch.id);
          seen.set(ch.id, {
            id: ch.id,
            kind: ch.kind,
            label: channelLabel(app, ch, ctx.user!.id),
            topic: ch.topic,
            location_id: l.id,
            location_name: l.name,
            scope: ch.location_id ? 'location' : 'agency',
            joined: !!me,
            role,
            unread: me ? k.unread : 0,
            mentions: me ? k.mentions : 0,
            muted: me?.notify === 'none',
            last_message_at: ch.last_message_at,
            preview: last ? { text: markdownToText(last.body).slice(0, 100), author: last.author_name } : null,
          });
        }
      }
      return [...seen.values()].sort((a, b) => String(b.last_message_at ?? '').localeCompare(String(a.last_message_at ?? '')));
    });

    const mobileMessage = (m: ReturnType<typeof messageOut>[number]) => ({ ...m, files: m.files.map((f) => ({ ...f, url: `/api/mobile/chat/files/${f.id}` })) });

    router.get('/api/mobile/chat/channels/:id/messages', 'user', (ctx) => {
      const { ctx: c, ch } = ctxForChannel(ctx, ctx.params.id);
      loadChannel(app, c, ch.id);
      const limit = clampLimit(ctx.query.get('limit'), 30, 100);
      const thread = ctx.query.get('thread');
      if (thread) {
        const root = db.get<MessageRow>('SELECT * FROM teamchat_messages WHERE id = ? AND channel_id = ?', thread, ch.id);
        if (!root) throw notFound('Nachricht nicht gefunden');
        const replies = db.all<MessageRow>('SELECT * FROM teamchat_messages WHERE thread_id = ? ORDER BY created_at, id LIMIT 200', root.id);
        return { messages: messageOut(app, [root, ...replies]).map(mobileMessage), has_more: false };
      }
      const before = ctx.query.get('before') ? db.get<MessageRow>('SELECT created_at, id FROM teamchat_messages WHERE id = ? AND channel_id = ?', String(ctx.query.get('before')), ch.id) : undefined;
      const rows = db.all<MessageRow>(
        `SELECT * FROM teamchat_messages WHERE channel_id = ? AND thread_id IS NULL ${before ? 'AND (created_at < ? OR (created_at = ? AND id < ?))' : ''} ORDER BY created_at DESC, id DESC LIMIT ?`,
        ch.id,
        ...(before ? [before.created_at, before.created_at, before.id] : []),
        limit + 1,
      );
      return { messages: messageOut(app, rows.slice(0, limit).reverse()).map(mobileMessage), has_more: rows.length > limit };
    });

    router.post('/api/mobile/chat/channels/:id/messages', 'user', (ctx) => {
      const { ctx: c, ch } = ctxForChannel(ctx, ctx.params.id);
      loadChannel(app, c, ch.id, 'member');
      const b = ctx.body ?? {};
      const { row, out, mentioned } = postMessage(app, c, ch, { body: String(b.body ?? ''), threadId: b.thread_id ? String(b.thread_id) : null });
      notifyMessage(app, c, ch, row, mentioned);
      return mobileMessage(out);
    });

    router.post('/api/mobile/chat/channels/:id/read', 'user', (ctx) => {
      const { ctx: c, ch } = ctxForChannel(ctx, ctx.params.id);
      loadChannel(app, c, ch.id);
      markRead(app, ch.id, ctx.user!.id);
      return { ok: true, channel_id: ch.id };
    });

    router.get('/api/mobile/chat/files/:id', 'user', (ctx): RawResult => {
      const f = db.get<any>('SELECT * FROM teamchat_files WHERE id = ?', ctx.params.id);
      if (!f) throw notFound('Datei nicht gefunden');
      const { ctx: c } = ctxForChannel(ctx, f.channel_id);
      loadChannel(app, c, f.channel_id);
      const p = filePath(app, f.file);
      if (!p || (!f.message_id && f.uploader_id !== ctx.user!.id)) throw notFound('Datei nicht gefunden');
      const image = /^image\/(png|jpeg|gif|webp)$/.test(f.mime);
      return { __raw: true, status: 200, headers: { 'content-type': f.mime, 'content-disposition': `${image ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" }, body: readFileSync(p) };
    });

    // --- wiki (read) -----------------------------------------------------------------------------------------------
    router.get('/api/mobile/wiki/pages', 'user', (ctx) => {
      const q = String(ctx.query.get('q') ?? '').trim();
      const limit = clampLimit(ctx.query.get('limit'), 20, 50);
      const out: any[] = [];
      for (const l of scope(ctx, wikiOk)) {
        for (const h of searchPages(app, inLoc(ctx, l.id), q, { limit })) out.push({ id: h.id, title: h.title, icon: h.icon, space_name: h.space_name, location_id: l.id, location_name: l.name, updated_at: h.updated_at, snippet: markdownToText(h.snippet).replace(/[\u0001\u0002]/g, '').slice(0, 160) });
      }
      return out.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, limit);
    });

    router.get('/api/mobile/wiki/pages/:id', 'user', (ctx) => {
      const row = db.get<{ location_id: string }>('SELECT location_id FROM wiki_pages WHERE id = ?', ctx.params.id);
      const loc = row && visibleLocations(app, ctx).find((l) => l.id === row.location_id);
      // unknown, foreign or in an area the person lacks: the same "not found"
      if (!row || !loc || !wikiOk(ctx, loc.id)) throw notFound('Seite nicht gefunden');
      const c = inLoc(ctx, loc.id);
      const { page, space } = loadPage(app, c, ctx.params.id) as { page: PageRow; space: SpaceRow };
      const r = renderMarkdown(page.body, { publicView: true, baseLevel: 2 });
      return {
        id: page.id,
        title: page.title,
        icon: page.icon,
        space_name: space.name,
        path: [...pagePath(app, page).map((p) => p.title), page.title],
        markdown: page.body,
        html: r.html,
        text: page.text,
        toc: r.toc,
        version: page.version,
        updated_at: page.updated_at,
        updated_by: page.updated_by_name,
        location_id: loc.id,
        location_name: loc.name,
        web_url: `${app.baseUrl()}/app/wiki/${page.id}?loc=${loc.id}`,
      };
    });
    void bad;
  },
};
