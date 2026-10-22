import type { Module } from '../core/app.js';
import { bad, notFound, redirect } from '../core/http.js';
import { escapeHtml } from '../core/template.js';
import { formatInTz } from '../core/time.js';
import { now } from '../core/util.js';
import { getGroup } from '../services/community.js';
import { createPost, notify, type Author } from '../services/community-actions.js';
import { OPEN_BEFORE_MIN, disableLive, enableLive, extOfEvent, jitsiBase, jitsiUrl, livePath, mustEvent, phaseOf, recordAttendance } from '../services/community-live.js';
import { communityUi, kitOf } from '../services/community-ui.js';
import { nameOf } from '../services/community-dm.js';

/**
 * Live calls: switch a calendar event to a Jitsi room, the page where members join (attendance, points, workflow event), a
 * reminder shortly before the start, and the recording as a post afterwards. Rules: services/community-live.ts.
 */

const CSS = `<style>
.cm-live{position:relative;aspect-ratio:16/9;min-height:360px;max-height:78vh;width:100%;border:0;border-radius:14px;background:#000;display:block}
.cm-livecard{text-align:center;padding:34px 20px}.cm-livecard h1{margin:0 0 6px}
.cm-pulse{display:inline-block;width:10px;height:10px;border-radius:50%;background:#e11d48;margin-right:6px;animation:cmpulse 1.4s infinite}
@keyframes cmpulse{0%{box-shadow:0 0 0 0 rgba(225,29,72,.6)}70%{box-shadow:0 0 0 10px rgba(225,29,72,0)}100%{box-shadow:0 0 0 0 rgba(225,29,72,0)}}
@media (prefers-reduced-motion:reduce){.cm-pulse{animation:none}}
</style>`;

export const communityLiveModule: Module = {
  name: 'community-live',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE community_event_ext (
        event_id TEXT PRIMARY KEY REFERENCES community_events(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        live INTEGER NOT NULL DEFAULT 0, room TEXT NOT NULL DEFAULT '', recording_post_id TEXT NOT NULL DEFAULT '', reminded_at TEXT
      );
      CREATE TABLE community_event_attendance (
        event_id TEXT NOT NULL REFERENCES community_events(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        joined_at TEXT NOT NULL, PRIMARY KEY (event_id, contact_id)
      );
      CREATE INDEX community_event_attendance_member ON community_event_attendance(group_id, contact_id);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const ui = communityUi(app);
    ui.head.push(() => CSS);
    const mustGroup = (loc: string, gid: string) => {
      const g = getGroup(app, loc, gid);
      if (!g) throw notFound('Gruppe nicht gefunden');
      return g as unknown as { id: string; location_id: string; name: string; slug: string; [k: string]: any };
    };

    // --- admin API ----------------------------------------------------------------------------------------------------------------
    const liveOut = (g: any, e: any) => {
      const x = extOfEvent(app, e.id);
      return {
        event_id: e.id,
        live: !!x?.live,
        join_url: x?.live ? livePath(app, g, e.id) : null,
        jitsi_server: jitsiBase(app, g),
        attendees: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM community_event_attendance WHERE event_id = ?', e.id)!.n,
        recording_post_id: x?.recording_post_id || null,
      };
    };
    router.get('/api/community/groups/:id/live', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      return db.all<any>('SELECT * FROM community_events WHERE group_id = ? ORDER BY starts_at DESC LIMIT 200', g.id).map((e) => ({ ...liveOut(g, e), title: e.title, starts_at: e.starts_at, ends_at: e.ends_at }));
    });
    router.put('/api/community/events/:id/live', 'location', (ctx) => {
      const e = mustEvent(app, ctx.locationId, ctx.params.id);
      const g = mustGroup(ctx.locationId, e.group_id);
      if (ctx.body?.enabled === false) disableLive(app, g, e);
      else enableLive(app, g, e);
      return liveOut(g, mustEvent(app, ctx.locationId, e.id));
    });
    router.get('/api/community/events/:id/attendance', 'location', (ctx) => {
      const e = mustEvent(app, ctx.locationId, ctx.params.id);
      return db
        .all<any>('SELECT a.contact_id, a.joined_at, c.email FROM community_event_attendance a JOIN contacts c ON c.id = a.contact_id WHERE a.event_id = ? ORDER BY a.joined_at', e.id)
        .map((r) => ({ contact_id: r.contact_id, name: nameOf(app, ctx.locationId, r.contact_id), email: r.email, joined_at: r.joined_at }));
    });
    /** The recording as a post: a title, a video link (YouTube, Vimeo, Loom, MP4) or an uploaded file, and a channel. */
    router.post('/api/community/events/:id/recording', 'location', (ctx) => {
      const e = mustEvent(app, ctx.locationId, ctx.params.id);
      const g = mustGroup(ctx.locationId, e.group_id);
      const b = ctx.body ?? {};
      if (!b.video_url && !b.video_upload) throw bad('Bitte einen Video-Link (YouTube, Vimeo, Loom oder MP4) oder einen hochgeladenen Upload angeben');
      const ch = b.channel_id ? db.get<any>('SELECT * FROM community_channels WHERE id = ? AND group_id = ?', String(b.channel_id), g.id) : db.get<any>('SELECT * FROM community_channels WHERE group_id = ? AND admin_only = 0 ORDER BY position, created_at', g.id);
      if (!ch) throw bad('Kanal nicht gefunden');
      const author: Author = { kind: 'team', userId: ctx.user?.id ?? (ctx.via ?? 'api'), name: ctx.user?.name || 'Team' };
      const prepared = ui.postExtras.map((h) => h.fromApi?.({ video_url: b.video_url, video_upload: b.video_upload }, g));
      const post = createPost(app, g, ch, author, { title: b.title || `Aufzeichnung: ${e.title}`, body: b.body ?? `Hier ist die Aufzeichnung von „${e.title}“ zum Nachschauen.` }, { notifyAll: b.notify !== false });
      ui.postExtras.forEach((h, i) => h.attach?.(post, g, prepared[i], 'team'));
      db.run(
        `INSERT INTO community_event_ext (event_id, group_id, location_id, live, room, recording_post_id) VALUES (?, ?, ?, 0, '', ?)
         ON CONFLICT(event_id) DO UPDATE SET recording_post_id = excluded.recording_post_id`,
        e.id,
        g.id,
        g.location_id,
        post.id,
      );
      return { post_id: post.id };
    });

    // --- reminder shortly before the start -----------------------------------------------------------------------------------------
    app.onTick(() => {
      const soon = new Date(Date.now() + OPEN_BEFORE_MIN * 60_000).toISOString();
      for (const x of db.all<any>(`SELECT x.event_id, x.group_id FROM community_event_ext x JOIN community_events e ON e.id = x.event_id WHERE x.live = 1 AND x.reminded_at IS NULL AND e.starts_at <= ? AND e.starts_at > ?`, soon, now())) {
        db.run('UPDATE community_event_ext SET reminded_at = ? WHERE event_id = ?', now(), x.event_id);
        const e = db.get<any>('SELECT * FROM community_events WHERE id = ?', x.event_id);
        const g = db.get<any>('SELECT * FROM community_groups WHERE id = ? AND status = ?', x.group_id, 'active');
        if (!e || !g) continue;
        const members = db.all<{ contact_id: string }>('SELECT contact_id FROM community_members WHERE group_id = ? AND banned_at IS NULL', g.id).map((r) => r.contact_id);
        notify(app, g, members, { kind: 'event', text: `Gleich geht’s los: ${e.title}`, actor: 'Live-Call' });
      }
    });

    // --- member pages ---------------------------------------------------------------------------------------------------------------
    const whenText = (p: any, iso: string) => formatInTz(iso, kitOf(app).tz(p), { year: undefined });
    const livePage = (ctx: any) =>
      kitOf(app).withGroup(ctx, (p, m, g) => {
        const kit = kitOf(app);
        const e = db.get<any>('SELECT * FROM community_events WHERE id = ? AND group_id = ?', ctx.params.eid, g.id);
        const x = e && extOfEvent(app, e.id);
        if (!e || !x?.live) return kit.errorPage(p, m, 'Diesen Live-Call gibt es nicht.', 404);
        const ph = phaseOf(e);
        const base = `${kit.gHref(p, g)}/live/${encodeURIComponent(e.id)}`;
        const joined = !!db.get('SELECT 1 FROM community_event_attendance WHERE event_id = ? AND contact_id = ?', e.id, m.contact.id);
        const head = `${kit.groupHead(p, g)}${kit.groupTabs(p, m, g, 'events')}<div class="crumb"><a href="${kit.gHref(p, g)}/events">Kalender</a></div>`;
        const ics = `<a class="cm-btn" href="${kit.gHref(p, g)}/events/${encodeURIComponent(e.id)}/ics">In meinen Kalender</a>`;
        if (ph === 'on' && ctx.query.get('in') === '1' && joined) {
          const origin = jitsiBase(app, g);
          const name = nameOf(app, p.locationId, m.contact.id);
          const url = jitsiUrl(origin, x.room, e.title, name);
          const o = `"${origin}"`;
          const policy = ['camera', 'microphone', 'display-capture', 'fullscreen', 'autoplay', 'clipboard-write'].map((f) => `${f}=(self ${o})`).join(', ');
          return kit.frame(
            p,
            m,
            `${e.title} · Live`,
            `${head}<h1 style="margin:0 0 10px"><span class="cm-pulse"></span>${escapeHtml(e.title)}</h1><iframe class="cm-live" src="${escapeHtml(url)}" allow="camera; microphone; display-capture; fullscreen; autoplay; clipboard-write" allowfullscreen referrerpolicy="no-referrer" title="Live-Call ${escapeHtml(e.title)}"></iframe><p class="muted small" style="margin:10px 0 0">Läuft das Bild nicht (z. B. auf dem Handy)? <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Call in neuem Tab öffnen</a>. Videodaten laufen über ${escapeHtml(new URL(origin).host)}.</p>`,
            200,
            { frameSrc: [origin], permissions: policy },
          );
        }
        const rec = x.recording_post_id ? db.get<any>(`SELECT id, title FROM community_posts WHERE id = ? AND status = 'visible'`, x.recording_post_id) : undefined;
        let body: string;
        if (ph === 'on') {
          body = `<p><span class="cm-pulse"></span><strong>Der Call läuft.</strong></p><form method="post" action="${base}/join">${kit.tokenInput(m)}<button class="btn" style="font-size:17px;padding:14px 28px">Jetzt beitreten</button></form><p class="muted small" style="margin:12px 0 0">Beim Beitreten wird der Raum auf ${escapeHtml(new URL(jitsiBase(app, g)).host)} geladen. Kamera und Mikrofon fragt dein Browser erst dort ab.</p>`;
        } else if (ph === 'before') {
          body = `<p>Der Raum öffnet ${OPEN_BEFORE_MIN} Minuten vor dem Start.</p><p>${ics}</p>`;
        } else {
          body = rec ? `<p><strong>Die Aufzeichnung ist da.</strong></p><p><a class="btn" href="${kit.postHref(p, g, rec.id)}">Aufzeichnung ansehen</a></p>` : '<p>Der Call ist vorbei. Eine Aufzeichnung gibt es (noch) nicht.</p>';
        }
        return kit.frame(
          p,
          m,
          `${e.title} · Live-Call`,
          `${head}<div class="cm-box cm-livecard"><div class="muted small">Live-Call</div><h1>${escapeHtml(e.title)}</h1><div class="muted">${escapeHtml(whenText(p, e.starts_at))} Uhr</div>${e.description ? `<div class="prose small" style="margin:12px auto;max-width:560px;text-align:left">${kit.renderText(p, e.description, false)}</div>` : ''}${body}</div>`,
        );
      });
    router.get('/portal/:p/community/g/:group/live/:eid', 'public', livePage);
    router.post('/portal/:p/community/g/:group/live/:eid/join', 'public', (ctx) =>
      kitOf(app).withGroup(ctx, (p, m, g) => {
        const kit = kitOf(app);
        const e = db.get<any>('SELECT * FROM community_events WHERE id = ? AND group_id = ?', ctx.params.eid, g.id);
        const x = e && extOfEvent(app, e.id);
        if (!e || !x?.live) return kit.errorPage(p, m, 'Diesen Live-Call gibt es nicht.', 404);
        if (phaseOf(e) !== 'on') return redirect(`${kit.gHref(p, g)}/live/${encodeURIComponent(e.id)}`, 303);
        recordAttendance(app, g, e, m.contact.id);
        return redirect(`${kit.gHref(p, g)}/live/${encodeURIComponent(e.id)}?in=1`, 303);
      }),
    );

    // A banner on the feed while a call is on (or about to start).
    ui.feedTop.push((p, _m, g) => {
      const kit = kitOf(app);
      const e = db
        .all<any>(`SELECT e.* FROM community_events e JOIN community_event_ext x ON x.event_id = e.id AND x.live = 1 WHERE e.group_id = ? AND e.ends_at >= ? AND e.starts_at <= ? ORDER BY e.starts_at LIMIT 1`, g.id, now(), new Date(Date.now() + OPEN_BEFORE_MIN * 60_000).toISOString())
        .find((x) => phaseOf(x) === 'on');
      if (!e) return '';
      const live = e.starts_at <= now();
      return `<div class="cm-box cm-ch"><span class="cm-pulse"></span><div class="grow"><strong>${live ? 'Live jetzt' : 'Gleich live'}: ${escapeHtml(e.title)}</strong><div class="muted small">${live ? 'Der Call läuft – komm dazu.' : `Startet um ${escapeHtml(formatInTz(e.starts_at, kit.tz(p), { weekday: undefined, day: undefined, month: undefined, year: undefined }))} Uhr`}</div></div><a class="btn" href="${kit.gHref(p, g)}/live/${encodeURIComponent(e.id)}">${live ? 'Beitreten' : 'Zum Call'}</a></div>`;
    });
  },
};
