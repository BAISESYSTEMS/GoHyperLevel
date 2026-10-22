import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, redirect, text, type Ctx, type RawResult } from '../core/http.js';
import { escapeHtml } from '../core/template.js';
import { createReadStream } from 'node:fs';
import { statSync } from 'node:fs';
import { groupAccess, getGroup } from '../services/community.js';
import { CAN, extOf as extSettings, roleOf } from '../services/community-ext.js';
import { communityUi, kitOf, type Group, type PortalCtx, type PortalMember, type PostExtrasHook } from '../services/community-ui.js';
import {
  CHUNK,
  appendVideoChunk,
  castVote,
  cleanGifUrl,
  cleanPoll,
  cleanVideoLink,
  createPoll,
  pollOf,
  removeVideo,
  startVideoUpload,
  videoExists,
  videoHtml,
  videoPath,
  type PostVideo,
  type VideoUpload,
} from '../services/community-posts-ext.js';
import { parseRange } from '../services/webinar-video.js';
import { clientJs } from '../services/community-client.js';
import { parseJson } from '../core/db.js';

/**
 * Richer posts: polls, videos (a link, or a file uploaded in parts) and GIFs by link; filter chips above the feed (polls, videos,
 * pinned). Plugs into the feed and the composer through app.services.communityUi (services/community-ui.ts), so
 * community-portal.ts knows nothing about any of it.
 */

const CSS = `<style>
.cm-extras{display:flex;flex-direction:column;gap:8px}
.cm-extra{border:1px solid var(--line);border-radius:12px;background:var(--bg)}
.cm-extra>summary{list-style:none;cursor:pointer;padding:10px 14px;font-weight:600;display:flex;gap:8px;align-items:center;min-height:44px;border-radius:12px}
.cm-extra>summary::-webkit-details-marker{display:none}.cm-extra>summary:hover{color:var(--brand)}
.cm-extra[open]>summary{border-bottom:1px solid var(--line);border-radius:12px 12px 0 0}
.cm-extra .in{padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.cm-poll{border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin:14px 0;background:var(--bg)}
.cm-poll h3{margin:0 0 10px;font-size:16px}
.cm-poll .o{position:relative;display:flex;justify-content:space-between;gap:10px;border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:6px;overflow:hidden;background:var(--panel);min-height:44px;align-items:center}
.cm-poll .o i{position:absolute;inset:0 auto 0 0;background:var(--soft);z-index:0}
.cm-poll .o span{position:relative;z-index:1}.cm-poll .o.mine{border-color:var(--brand)}.cm-poll .o .n{font-weight:700;white-space:nowrap}
.cm-poll label.o{cursor:pointer}.cm-poll label.o input{width:20px;height:20px;accent-color:var(--brand);margin-right:10px;flex:none}
.cm-poll label.o>span:first-of-type{flex:1;display:flex;align-items:center}
.cm-poll .ft{font-size:13px;color:var(--muted);margin-top:6px}
.cm-card-tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
.cm-gif{max-width:100%;max-height:300px;border-radius:12px;display:block;margin-top:12px}
.cm-filter{display:flex;gap:8px;margin:0 0 12px;overflow-x:auto;scrollbar-width:none}
.cm-filter a{flex:none;padding:8px 14px;border-radius:99px;border:1px solid var(--line);background:var(--panel);color:inherit;text-decoration:none;font-size:14px;font-weight:600;min-height:40px;display:inline-flex;align-items:center}
.cm-filter a.on{background:var(--text);border-color:var(--text);color:var(--panel)}
.cm-vbar{height:8px;background:var(--soft);border-radius:99px;overflow:hidden}.cm-vbar i{display:block;height:100%;background:var(--brand)}
</style>`;

/** "3 Std." / "2 Tagen" until a future time. */
function untilText(iso: string, at = Date.now()): string {
  const min = Math.max(1, Math.round((Date.parse(iso) - at) / 60_000));
  if (min < 60) return `${min} Min.`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} Std.`;
  return `${Math.round(h / 24)} Tagen`;
}

export const communityFeedModule: Module = {
  name: 'community-feed',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE community_post_ext (
        post_id TEXT PRIMARY KEY REFERENCES community_posts(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
        video TEXT NOT NULL DEFAULT '', gif_url TEXT NOT NULL DEFAULT '', event_id TEXT
      );
      CREATE TABLE community_polls (
        id TEXT PRIMARY KEY, post_id TEXT NOT NULL UNIQUE REFERENCES community_posts(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
        question TEXT NOT NULL, options TEXT NOT NULL, multi INTEGER NOT NULL DEFAULT 0, closes_at TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE community_poll_votes (
        poll_id TEXT NOT NULL REFERENCES community_polls(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        option_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (poll_id, contact_id, option_id)
      );
      CREATE TABLE community_videos (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
        contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE, name TEXT NOT NULL, file TEXT NOT NULL,
        size INTEGER NOT NULL, received INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const ui = communityUi(app);
    ui.head.push(() => CSS);
    ui.scripts.push('/portal-community-ext.js');

    // A member's video uploads go with the contact (foreign key) – the files on disk are deleted with it (erase or plain delete).
    app.services.contactFiles = [
      ...(app.services.contactFiles ?? []),
      (_a: unknown, loc: string, cid: string) => db.all<VideoUpload>('SELECT * FROM community_videos WHERE location_id = ? AND contact_id = ?', loc, cid).map((v) => videoPath(app, v)),
    ];

    router.get('/portal-community-ext.js', 'public', () => {
      const r = text(clientJs(), 'text/javascript; charset=utf-8');
      r.headers['cache-control'] = 'public, max-age=300';
      return r;
    });

    const ownHost = () => {
      try {
        return new URL(app.baseUrl()).hostname;
      } catch {
        return '';
      }
    };
    const extOfPost = (postId: string) => db.get<{ video: string; gif_url: string }>('SELECT video, gif_url FROM community_post_ext WHERE post_id = ?', postId);
    const videoOf = (postId: string): PostVideo | null => {
      const r = extOfPost(postId);
      if (!r?.video) return null;
      try {
        return JSON.parse(r.video) as PostVideo;
      } catch {
        return null;
      }
    };
    const mine = (uid: string, g: { id: string }, contactId: string | null): VideoUpload => {
      const up = db.get<VideoUpload>(`SELECT * FROM community_videos WHERE id = ? AND group_id = ? AND status = 'complete' AND COALESCE(contact_id, '') = ?`, uid, g.id, contactId ?? '');
      if (!up) throw bad('Video: Der Upload ist nicht fertig oder gehört nicht zu dir');
      return up;
    };

    interface Prepared {
      poll: ReturnType<typeof cleanPoll>;
      video: PostVideo | null;
      gif: string;
    }
    const prepare = (src: { poll?: any; video_url?: unknown; video_upload?: unknown; gif_url?: unknown }, g: Group, contactId: string | null): Prepared => {
      const poll = cleanPoll(src.poll);
      const upload = String(src.video_upload ?? '').trim();
      const link = cleanVideoLink(src.video_url);
      if (upload && link) throw bad('Video: entweder Link oder Datei');
      const file = upload ? mine(upload, g as any, contactId) : undefined;
      const video: PostVideo | null = file ? { kind: 'upload', upload_id: file.id, name: file.name } : link;
      if (video?.kind === 'upload' && !extSettings(app, g.id).video.upload) throw bad('Videos hochladen ist in dieser Gruppe ausgeschaltet – bitte einen Link einfügen.');
      const gif = cleanGifUrl(src.gif_url, { ownHost: ownHost() });
      return { poll, video, gif };
    };

    // --- the hook: composer, feed, post page, admin API -----------------------------------------------------------------------
    const pollView = (p: PortalCtx, m: PortalMember, g: Group, post: any, kit = kitOf(app)): string => {
      const poll = pollOf(app, post.id, m.contact.id);
      if (!poll) return '';
      const staff = CAN.moderate(roleOf(app, g.id, m.contact.id)) || post.contact_id === m.contact.id;
      const showResults = poll.voted || poll.closed || staff;
      const base = Math.max(poll.voters, 1);
      const action = `${kit.postHref(p, g, post.id)}/vote`;
      const results = poll.options.map((o) => `<div class="o${o.mine ? ' mine' : ''}"><i style="width:${Math.round((o.votes / base) * 100)}%"></i><span>${escapeHtml(o.text)}${o.mine ? ' ✓' : ''}</span><span class="n">${o.votes} · ${Math.round((o.votes / base) * 100)} %</span></div>`).join('');
      const form = `<form method="post" action="${action}">${kit.tokenInput(m)}${poll.options.map((o) => `<label class="o"><span><input type="${poll.multi ? 'checkbox' : 'radio'}" name="option" value="${escapeHtml(o.id)}"${o.mine ? ' checked' : ''}${poll.multi ? '' : ' required'}>${escapeHtml(o.text)}</span></label>`).join('')}<button class="btn" style="margin-top:6px">${poll.voted ? 'Antwort ändern' : 'Abstimmen'}</button></form>`;
      const foot = `${poll.voters} ${poll.voters === 1 ? 'Stimme' : 'Stimmen'}${poll.multi ? ' · Mehrfachauswahl' : ''}${poll.closes_at ? ` · ${poll.closed ? 'beendet' : `endet in ${untilText(poll.closes_at)}`}` : ''}`;
      return `<div class="cm-poll"><h3>📊 ${escapeHtml(poll.question)}</h3>${showResults ? results : ''}${showResults && !poll.closed ? `<details style="margin-top:8px"><summary class="cm-link" style="min-height:40px;display:flex;align-items:center">${poll.voted ? 'Antwort ändern' : 'Abstimmen'}</summary>${form}</details>` : showResults ? '' : form}<div class="ft">${escapeHtml(foot)}</div></div>`;
    };

    const hook: PostExtrasHook = {
      fields(_p, _m, g, d) {
        const opts = [0, 1, 2, 3, 4, 5].map((i) => `<input type="text" name="poll_option" maxlength="80" placeholder="Antwort ${i + 1}${i < 2 ? '' : ' (optional)'}" value="${escapeHtml(String(Array.isArray(d.poll_option) ? (d.poll_option[i] ?? '') : i === 0 ? (d.poll_option ?? '') : ''))}" aria-label="Antwort ${i + 1}">`).join('');
        const ext = extSettings(app, g.id);
        return `<div class="cm-extras">
<details class="cm-extra"${d.poll_question ? ' open' : ''}><summary>📊 Umfrage hinzufügen</summary><div class="in"><input type="text" name="poll_question" maxlength="200" placeholder="Deine Frage" value="${escapeHtml(String(d.poll_question ?? ''))}" aria-label="Frage der Umfrage">${opts}<label class="cm-pick"><input type="checkbox" name="poll_multi" value="1"${d.poll_multi ? ' checked' : ''}> Mehrere Antworten erlauben</label><label class="cm-hint" for="pd">Endet nach</label><select id="pd" name="poll_days" aria-label="Dauer der Umfrage"><option value="0">offen, ohne Ende</option><option value="1">1 Tag</option><option value="3">3 Tagen</option><option value="7">7 Tagen</option></select></div></details>
<details class="cm-extra"${d.video_url ? ' open' : ''}><summary>▶ Video hinzufügen</summary><div class="in"><input type="text" name="video_url" maxlength="500" placeholder="YouTube-, Vimeo-, Loom- oder MP4-Link" value="${escapeHtml(String(d.video_url ?? ''))}" aria-label="Video-Link">${ext.video.upload ? '<label class="cm-pick cm-btn" data-video-pick hidden>Datei hochladen<input type="file" accept="video/mp4,video/quicktime,video/webm,video/x-matroska,video/ogg" hidden></label><input type="hidden" name="video_upload" value=""><div class="cm-hint" data-video-state></div>' : ''}</div></details>
<details class="cm-extra"${d.gif_url ? ' open' : ''}><summary>GIF hinzufügen</summary><div class="in"><input type="text" name="gif_url" maxlength="500" placeholder="Link zu einem GIF (Giphy, Tenor, Imgur)" value="${escapeHtml(String(d.gif_url ?? ''))}" aria-label="GIF-Link"><span class="cm-hint">Am einfachsten: auf giphy.com das GIF öffnen und den Link der Seite einfügen.</span></div></details></div>`;
      },
      fromForm(ctx, g, m) {
        const b = ctx.body ?? {};
        const kit = kitOf(app);
        return prepare({ poll: { question: b.poll_question, options: kit.formAll(ctx, 'poll_option'), multi: b.poll_multi, days: b.poll_days }, video_url: b.video_url, video_upload: b.video_upload, gif_url: b.gif_url }, g, m.contact.id);
      },
      fromApi(body, g) {
        return prepare({ poll: body.poll, video_url: body.video_url, video_upload: body.video_upload, gif_url: body.gif_url }, g, null);
      },
      attach(post, g, prepared) {
        const x = prepared as Prepared | undefined;
        if (!x || (!x.poll && !x.video && !x.gif)) return;
        if (x.poll) createPoll(app, post, x.poll);
        if (x.video || x.gif) db.run('INSERT OR REPLACE INTO community_post_ext (post_id, location_id, group_id, video, gif_url) VALUES (?, ?, ?, ?, ?)', post.id, post.location_id, g.id, x.video ? JSON.stringify(x.video) : '', x.gif);
      },
      card(p, m, g, post) {
        const kit = kitOf(app);
        const poll = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM community_polls WHERE post_id = ?', post.id)!.n;
        const ext = extOfPost(post.id);
        if (!poll && !ext) return '';
        const tags: string[] = [];
        if (poll) {
          const v = pollOf(app, post.id, m.contact.id)!;
          tags.push(`<span class="cm-tag">📊 Umfrage · ${v.voters} ${v.voters === 1 ? 'Stimme' : 'Stimmen'}${v.closed ? ' · beendet' : ''}</span>`);
        }
        if (ext?.video) tags.push('<span class="cm-tag">▶ Video</span>');
        void p;
        void kit;
        return `${tags.length ? `<div class="cm-card-tags">${tags.join('')}</div>` : ''}${ext?.gif_url ? `<a href="${kitOf(app).postHref(p, g, post.id)}"><img class="cm-gif" src="${escapeHtml(ext.gif_url)}" alt="GIF" loading="lazy" referrerpolicy="no-referrer"></a>` : ''}`;
      },
      full(p, m, g, post) {
        const kit = kitOf(app);
        const v = videoOf(post.id);
        const ext = extOfPost(post.id);
        const video = v ? `<div style="margin:14px 0">${videoHtml(v, (uid) => `${kit.cbase(p)}/video/${encodeURIComponent(uid)}`, post.title)}</div>` : '';
        const gif = ext?.gif_url ? `<img class="cm-gif" src="${escapeHtml(ext.gif_url)}" alt="GIF" loading="lazy" referrerpolicy="no-referrer">` : '';
        return `${video}${gif}${pollView(p, m, g, post)}`;
      },
      api(post) {
        const poll = pollOf(app, post.id, null);
        const ext = extOfPost(post.id);
        return { poll: poll ? { question: poll.question, options: poll.options.map((o) => ({ text: o.text, votes: o.votes })), multi: poll.multi, closes_at: poll.closes_at, voters: poll.voters } : null, video: videoOf(post.id), gif_url: ext?.gif_url || null };
      },
      remove(post) {
        const v = videoOf(post.id);
        if (v?.kind === 'upload') removeVideo(app, v.upload_id);
      },
    };
    ui.postExtras.push(hook);

    ui.feedFilters.push(() => [
      { key: 'polls', label: '📊 Umfragen', where: 'id IN (SELECT post_id FROM community_polls)' },
      { key: 'videos', label: '▶ Videos', where: "id IN (SELECT post_id FROM community_post_ext WHERE video != '')" },
      { key: 'pinned', label: 'Angeheftet', where: 'pinned = 1' },
    ]);

    // --- voting --------------------------------------------------------------------------------------------------------------
    router.post('/portal/:p/community/g/:group/p/:post/vote', 'public', (ctx) =>
      kitOf(app).withPost(ctx, (p, m, g, post) => {
        const kit = kitOf(app);
        try {
          const poll = db.get<{ id: string }>('SELECT id FROM community_polls WHERE post_id = ?', post.id);
          if (!poll) throw notFound('Umfrage nicht gefunden');
          castVote(app, poll.id, m.contact.id, kit.formAll(ctx, 'option'));
        } catch (e) {
          if (e instanceof HttpError) return kit.errorPage(p, m, e.message, e.status);
          throw e;
        }
        return redirect(`${kit.postHref(p, g, post.id)}#umfrage`, 303);
      }),
    );

    // --- video files: parts in, ranges out -------------------------------------------------------------------------------------------
    const prevLimit = app.services.rawBodyLimit;
    app.services.rawBodyLimit = (method: string, path: string, req: any, cookies: Record<string, string>): number | undefined => {
      if (method === 'PUT' && /^\/portal\/[^/]+\/community\/g\/[^/]+\/video\/upload\/[A-Za-z0-9]{8,32}$/.test(path) && Object.keys(cookies).some((k) => k.startsWith('pm_'))) return CHUNK + 4096;
      if (method === 'PUT' && /^\/api\/community\/groups\/[A-Za-z0-9]{8,32}\/video\/upload\/[A-Za-z0-9]{8,32}$/.test(path) && (cookies.pghl_session || req.headers.authorization)) return CHUNK + 4096;
      return prevLimit?.(method, path, req, cookies);
    };

    // From the portal: a member starts an upload and sends the parts (the page script does it; the CSRF token rides in a header).
    router.post('/portal/:p/community/g/:group/video/upload', 'public', (ctx) =>
      kitOf(app).withGroup(ctx, (_p, m, g) => {
        const kit = kitOf(app);
        if (!extSettings(app, g.id).video.upload) return json({ error: 'Hochladen ist in dieser Gruppe ausgeschaltet' }, 403);
        try {
          const up = startVideoUpload(app, g as any, m.contact.id, String(ctx.body?.name ?? ''), Math.round(Number(ctx.body?.size)));
          return json({ id: up.id, chunk_size: CHUNK, size: up.size, received: 0 });
        } catch (e) {
          if (e instanceof HttpError) return json({ error: e.message }, e.status);
          throw e;
        } finally {
          void kit;
        }
      }),
    );
    router.put('/portal/:p/community/g/:group/video/upload/:uid', 'public', (ctx) => {
      const kit = kitOf(app);
      const p = kit.portal.resolve(ctx.params.p);
      const m = p && kit.portal.memberOf(ctx, p);
      if (!p || !m) return json({ error: 'Nicht angemeldet' }, 401);
      // Raw bodies have no form token: the header carries it, and must come from our own pages.
      if (ctx.req.headers['x-community-csrf'] !== kit.csrf(m)) return json({ error: 'Die Seite war zu lange offen. Bitte neu laden.' }, 403);
      const g = parseJson(db.get<any>('SELECT * FROM community_groups WHERE location_id = ? AND slug = ?', p.locationId, ctx.params.group), ['access', 'settings']);
      if (!g || groupAccess(app, g, m.contact) !== 'ok') return json({ error: 'Kein Zugang' }, 403);
      const up = db.get<VideoUpload>('SELECT * FROM community_videos WHERE id = ? AND group_id = ? AND contact_id = ?', ctx.params.uid, g.id, m.contact.id);
      if (!up) return json({ error: 'Upload nicht gefunden' }, 404);
      try {
        return json(appendVideoChunk(app, up, Number(ctx.query.get('offset') ?? up.received), ctx.rawBuffer ?? Buffer.alloc(0)));
      } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status);
        throw e;
      }
    });
    // From the team: same thing through the API.
    router.post('/api/community/groups/:id/video/upload', 'location', (ctx) => {
      const g = getGroup(app, ctx.locationId, ctx.params.id);
      if (!g) throw notFound('Gruppe nicht gefunden');
      const up = startVideoUpload(app, g as any, null, String(ctx.body?.name ?? ''), Math.round(Number(ctx.body?.size)));
      return { id: up.id, chunk_size: CHUNK, size: up.size, received: 0 };
    });
    router.put('/api/community/groups/:id/video/upload/:uid', 'location', (ctx) => {
      const g = getGroup(app, ctx.locationId, ctx.params.id);
      const up = g && db.get<VideoUpload>('SELECT * FROM community_videos WHERE id = ? AND group_id = ? AND contact_id IS NULL', ctx.params.uid, g.id);
      if (!up) throw notFound('Upload nicht gefunden');
      return appendVideoChunk(app, up, Number(ctx.query.get('offset') ?? up.received), ctx.rawBuffer ?? Buffer.alloc(0));
    });

    const MIME: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg', '.mkv': 'video/x-matroska' };
    const json = (body: unknown, status = 200): RawResult => ({ __raw: true, status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify(body) });
    const stream = (path: string, ctx: Ctx, mime: string): RawResult => {
      const size = statSync(path).size;
      const head: Record<string, string> = { 'content-type': mime, 'accept-ranges': 'bytes', 'cache-control': 'private, no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'" };
      const wanted = ctx.req.headers.range;
      const range = parseRange(wanted, size);
      if (wanted && !range) return { __raw: true, status: 416, headers: { ...head, 'content-range': `bytes */${size}` }, body: '' };
      if (range) return { __raw: true, status: 206, headers: { ...head, 'content-range': `bytes ${range.start}-${range.end}/${size}`, 'content-length': String(range.end - range.start + 1) }, body: createReadStream(path, range) };
      return { __raw: true, status: 200, headers: { ...head, 'content-length': String(size) }, body: createReadStream(path) };
    };
    router.get('/portal/:p/community/video/:id', 'public', (ctx) =>
      kitOf(app).withMember(ctx, (p, m) => {
        const up = db.get<VideoUpload>(`SELECT * FROM community_videos WHERE id = ? AND location_id = ? AND status = 'complete'`, ctx.params.id, p.locationId);
        const g = up && parseJson(db.get<any>('SELECT * FROM community_groups WHERE id = ?', up.group_id), ['access', 'settings']);
        if (!up || !g || groupAccess(app, g, m.contact) !== 'ok' || !videoExists(app, up)) return kitOf(app).errorPage(p, m, 'Das Video gibt es nicht (mehr) oder du hast keinen Zugang.', 404);
        return stream(videoPath(app, up), ctx, MIME[extOf(up.file)] ?? 'video/mp4');
      }),
    );
    const extOf = (name: string) => (/\.[a-z0-9]{2,5}$/i.exec(name) ?? [''])[0].toLowerCase();

    // Uploads nobody attached to a post are removed after a day.
    let swept = 0;
    app.onTick(() => {
      if (Date.now() - swept < 3600_000) return;
      swept = Date.now();
      const before = new Date(Date.now() - 864e5).toISOString();
      const old = db.all<VideoUpload>('SELECT * FROM community_videos WHERE created_at < ?', before);
      if (!old.length) return;
      // One look at the posts instead of one per upload (a LIKE over every post for every video was videos × posts every hour).
      const used = new Set<string>();
      for (const r of db.all<{ video: string }>(`SELECT video FROM community_post_ext WHERE video LIKE '%"upload_id"%'`)) {
        try {
          const id = JSON.parse(r.video)?.upload_id;
          if (typeof id === 'string') used.add(id);
        } catch {
          /* not JSON: not a reference */
        }
      }
      for (const up of old) if (!used.has(up.id)) removeVideo(app, up.id);
    });
  },
};
