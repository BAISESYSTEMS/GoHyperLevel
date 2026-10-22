import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, createReadStream } from 'node:fs';
import { extname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHmac } from 'node:crypto';
import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { parseJson } from '../core/db.js';
import { render } from '../core/template.js';
import { id, now, safeEqual } from '../core/util.js';
import { safeFetch } from '../services/net.js';
import { notifyTeam } from '../services/messaging.js';
import { callRoute } from '../services/route-call.js';
import type { ReportSource } from '../services/report-engine.js';
import * as os from '../services/openshorts.js';
import * as rc from '../services/video-recycle.js';
import type { Tool } from './mcp.js';
import { parseRange } from './video-studio.js';

/**
 * Content-Recycling and Autopilot for the Video-Studio. Recycling: from a finished shorts job the AI
 * assistant (app.services.aiRun – counts on the sub-account's AI limit) writes a blog post, a
 * newsletter, social texts, a YouTube description, show notes, a community post and a lesson teaser
 * from the OpenShorts transcript; nothing leaves the "Recycling" tab without a click on „übernehmen“
 * (which goes through the regular routes of blog, campaigns, social planner, community and courses).
 * Autopilot: watches YouTube/podcast feeds per sub-account, starts a job for every new video, puts
 * the best clips into the Social Planner (drafts by default) and runs the recycling set as drafts.
 */

const MAX_CLIP_COPY = 400 * 1024 * 1024;
const AUTOPILOT_EVERY_MS = 10 * 60_000;

interface Autopilot {
  enabled: boolean;
  feeds: { id: string; type: 'youtube' | 'podcast'; url: string; label: string }[];
  mode: 'approve' | 'auto';
  top_n: number;
  times: string[];
  days: string[];
  integration_ids: string[];
  recycle: rc.RecycleKind[];
  funnel_id: string | null;
  options: Record<string, unknown>;
  notify_push: boolean;
  notify_email: boolean;
  max_per_day: number;
}
const AUTOPILOT_DEFAULT: Autopilot = {
  enabled: false,
  feeds: [],
  mode: 'approve',
  top_n: 3,
  times: ['10:00'],
  days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  integration_ids: [],
  recycle: ['blog', 'newsletter', 'linkedin', 'x_thread', 'instagram', 'facebook', 'youtube'],
  funnel_id: null,
  options: {},
  notify_push: true,
  notify_email: true,
  max_per_day: 3,
};

export const videoRecycleModule: Module = {
  name: 'video-recycle',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE video_recycle (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES video_jobs(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, status TEXT NOT NULL, content TEXT NOT NULL DEFAULT '{}', error TEXT, language TEXT NOT NULL DEFAULT 'auto',
        edited INTEGER NOT NULL DEFAULT 0, applied_ref TEXT, applied_url TEXT, applied_label TEXT, applied_at TEXT,
        origin TEXT NOT NULL DEFAULT 'manuell', user_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE (job_id, kind)
      );
      CREATE INDEX video_recycle_loc ON video_recycle(location_id, created_at);
      CREATE TABLE video_transcripts (
        job_id TEXT PRIMARY KEY REFERENCES video_jobs(id) ON DELETE CASCADE, text TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE video_job_plans (
        job_id TEXT PRIMARY KEY REFERENCES video_jobs(id) ON DELETE CASCADE, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        kinds TEXT NOT NULL DEFAULT '[]', autopilot INTEGER NOT NULL DEFAULT 0, feed_id TEXT, item_id TEXT,
        done INTEGER NOT NULL DEFAULT 0, note TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE video_autopilot (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE, settings TEXT NOT NULL DEFAULT '{}',
        state TEXT NOT NULL DEFAULT '{}', user_id TEXT, updated_at TEXT NOT NULL
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const base = join(app.config.dataDir, 'video-studio');
    const thumbDir = join(base, 'thumbs');
    const publicDir = join(base, 'public');
    const vs = () => {
      const s = app.services.videoStudio;
      if (!s) throw new HttpError(404, 'Video-Studio ist nicht installiert');
      return s;
    };
    const cfgOrFail = (): os.OsConfig => {
      const c = vs().config();
      if (!c) throw new HttpError(409, 'Video-Studio ist noch nicht verbunden (Agentur → Integrationen → Einrichtung)');
      return c;
    };
    const tableExists = (t: string) => !!db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, t);
    const sig = (purpose: string, ref: string) => createHmac('sha256', app.config.secret).update(`${purpose}:${ref}`).digest('base64url').slice(0, 24);
    const clipsOf = (jobId: string) => db.all(`SELECT * FROM video_clips WHERE job_id = ? AND status = 'ready' ORDER BY COALESCE(score, -1) DESC, os_index`, jobId);

    // --- clip thumbnails (captured in the browser) and permanent public copies ------------------
    const thumbFile = (clipId: string) => join(thumbDir, `${clipId}.jpg`);
    const thumbUrl = (clipId: string) => (existsSync(thumbFile(clipId)) ? `${app.baseUrl()}/hooks/openshorts/thumb/${clipId}.${sig('thumb', clipId)}.jpg` : null);
    app.services.videoClipThumb = thumbUrl;

    /** A clip that is linked publicly (blog, newsletter, lesson) is copied once to HyperLevel's disk – OpenShorts deletes jobs after its retention. */
    const publicClip = async (clip: any): Promise<string> => {
      const ext = (extname(clip.video_path).toLowerCase().match(/^\.(mp4|webm|mov|m4v)$/)?.[0] ?? '.mp4');
      const file = join(publicDir, `${clip.id}${ext}`);
      if (!existsSync(file)) {
        mkdirSync(publicDir, { recursive: true });
        const path = os.mediaPath(clip.video_path);
        if (!path) throw new HttpError(404, 'Clip-Pfad ungültig');
        const r = await os.osFetch(vs().fetch(), cfgOrFail(), 'GET', path.split('/').map(encodeURIComponent).join('/'), { stream: true, timeoutMs: 30_000 });
        if (!r.ok || !r.body) {
          await r.body?.cancel().catch(() => {});
          throw new HttpError(r.status === 404 ? 404 : 502, r.status === 404 ? 'Der Clip ist in OpenShorts nicht mehr vorhanden' : `OpenShorts liefert den Clip nicht (${r.status})`);
        }
        let size = 0;
        const limit = new Transform({
          transform(chunk, _enc, cb) {
            size += chunk.length;
            cb(size > MAX_CLIP_COPY ? new Error('Clip zu groß') : null, chunk);
          },
        });
        const tmp = `${file}.part`;
        try {
          await pipeline(Readable.fromWeb(r.body as any), limit, createWriteStream(tmp));
          renameSync(tmp, file);
        } catch (e) {
          rmSync(tmp, { force: true });
          throw new HttpError(502, `Clip konnte nicht gesichert werden: ${(e as Error).message}`);
        }
      }
      return `${app.baseUrl()}/hooks/openshorts/clip/${clip.id}.${sig('clip', clip.id)}${ext}`;
    };

    // --- transcript ---------------------------------------------------------------------------
    const transcriptOf = async (job: any): Promise<string> => {
      const cached = db.get('SELECT text FROM video_transcripts WHERE job_id = ?', job.id);
      if (cached) return cached.text;
      let text = '';
      const clips = db.all(`SELECT * FROM video_clips WHERE job_id = ? AND status = 'ready' ORDER BY os_index`, job.id);
      if (job.kind === 'clips' && job.os_job_id && clips.length) {
        const cfg = cfgOrFail();
        try {
          const edl: any = await os.osJson(vs().fetch(), cfg, 'GET', `/api/clip/${encodeURIComponent(job.os_job_id)}/${clips[0].os_index}/edl`, { timeoutMs: 60_000 });
          text = rc.transcriptFromWords(Array.isArray(edl?.words) ? edl.words : []);
        } catch {
          // Older instances or an expired source: the clips' own word lists still tell the story.
          const parts: string[] = [];
          for (const c of clips.slice(0, 12)) {
            try {
              const t: any = await os.osJson(vs().fetch(), cfg, 'GET', `/api/clip/${encodeURIComponent(job.os_job_id)}/${c.os_index}/transcript`, { timeoutMs: 30_000 });
              const words = (Array.isArray(t?.captions) ? t.captions : []).map((w: any) => String(w?.text ?? '')).filter(Boolean).join(' ');
              if (words) parts.push(`[${rc.fmtTime(Number(c.start_s) || 0)}] ${words}`);
            } catch {
              /* skip this clip */
            }
          }
          text = parts.join('\n');
        }
      }
      if (text) db.run('INSERT OR REPLACE INTO video_transcripts (job_id, text, created_at) VALUES (?, ?, ?)', job.id, text, now());
      return text;
    };

    // --- items ----------------------------------------------------------------------------------
    const itemOut = (r: any) => {
      const row = parseJson({ ...r }, ['content']);
      const k = row.kind as rc.RecycleKind;
      return { ...row, label: rc.RECYCLE_KINDS[k]?.label ?? k, text: row.status === 'ready' || row.status === 'applied' ? rc.asText(k, row.content ?? {}) : '' };
    };
    const itemsOf = (jobId: string) =>
      db
        .all('SELECT * FROM video_recycle WHERE job_id = ?', jobId)
        .map(itemOut)
        .sort((a, b) => rc.KIND_KEYS.indexOf(a.kind) - rc.KIND_KEYS.indexOf(b.kind));
    const getItem = (itemId: string, loc: string) => db.get('SELECT * FROM video_recycle WHERE id = ? AND location_id = ?', itemId, loc);

    /** Which pieces make sense in this sub-account (modules installed, something to attach to). */
    const availableKinds = (loc: string) =>
      rc.KIND_KEYS.map((k) => {
        const need = rc.RECYCLE_KINDS[k].needs;
        let reason = '';
        if (need === 'blog' && !tableExists('blog_posts')) reason = 'Blog-Modul fehlt';
        if (need === 'campaigns' && !tableExists('campaigns')) reason = 'Kampagnen fehlen';
        if (need === 'social' && !app.services.socialPost) reason = 'Social Planner fehlt';
        if (need === 'community' && (!tableExists('community_groups') || !db.get(`SELECT id FROM community_groups WHERE location_id = ? AND status = 'active'`, loc))) reason = 'Keine Community-Gruppe';
        if (need === 'courses' && (!tableExists('course_lessons') || !db.get('SELECT id FROM course_lessons WHERE location_id = ?', loc))) reason = 'Keine Kurs-Lektionen';
        return { key: k, label: rc.RECYCLE_KINDS[k].label, icon: rc.RECYCLE_KINDS[k].icon, draft: rc.RECYCLE_KINDS[k].draft, available: !reason, reason };
      });

    const aiProblem = (loc: string): string | null => {
      if (!app.services.aiRun) return 'Der KI-Assistent ist nicht installiert.';
      return app.services.aiReady?.(loc) ?? null;
    };

    /** Writes every item of the job that waits ("generating"), one after the other. */
    const generate = async (jobId: string) => {
      const job = vs().getJob(jobId);
      if (!job) return;
      const loc = app.location(job.location_id)!;
      const clips = clipsOf(job.id);
      let transcript = '';
      try {
        transcript = await transcriptOf(job);
      } catch {
        /* the clip infos still carry the gist */
      }
      for (let guard = 0; guard < 20; guard++) {
        const row = db.get(`SELECT * FROM video_recycle WHERE job_id = ? AND status = 'generating' ORDER BY created_at LIMIT 1`, jobId);
        if (!row) break;
        const kind = row.kind as rc.RecycleKind;
        const context: rc.RecycleContext = {
          title: job.title,
          sourceUrl: job.source_type === 'url' ? job.source_url : null,
          language: row.language || 'auto',
          locationName: loc.name,
          durationSec: null,
          clips: clips.map((c: any) => ({ title: c.title, description: c.description, start: c.start_s, end: c.end_s, score: c.score, hook: c.hook })),
        };
        try {
          const p = rc.promptFor(kind);
          const r = await app.services.aiRun({ locationId: job.location_id, purpose: 'video_recycle', system: rc.systemBlocks(context, transcript), user: p.user, schema: p.schema, maxTokens: p.maxTokens, timeoutMs: 180_000, userId: row.user_id ?? null });
          const content = rc.cleanContent(kind, rc.parseJsonAnswer(r.text));
          rc.assertUsable(kind, content);
          db.run(`UPDATE video_recycle SET status = 'ready', content = ?, error = NULL, edited = 0, updated_at = ? WHERE id = ?`, JSON.stringify(content), now(), row.id);
        } catch (e) {
          const msg = (e as Error).message.slice(0, 300);
          db.run(`UPDATE video_recycle SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`, msg, now(), row.id);
          // AI off, no key, monthly limit: the rest would fail the same way.
          if ((e as HttpError).status === 409) db.run(`UPDATE video_recycle SET status = 'failed', error = ?, updated_at = ? WHERE job_id = ? AND status = 'generating'`, msg, now(), jobId);
        }
      }
    };

    /** One generation loop per job – the UI, workflows and the autopilot share it (no double AI calls). */
    const loops = new Map<string, Promise<void>>();
    const runGenerate = (jobId: string, again = true): Promise<void> => {
      const cur = loops.get(jobId);
      if (cur) return cur;
      const p = (async () => {
        try {
          await generate(jobId);
        } finally {
          loops.delete(jobId);
        }
        // Pieces added while the loop was finishing.
        if (again && db.get(`SELECT id FROM video_recycle WHERE job_id = ? AND status = 'generating' LIMIT 1`, jobId)) await runGenerate(jobId, false);
      })();
      loops.set(jobId, p);
      return p;
    };

    /** Marks the pieces as "generating" and writes them in the background. */
    const startRecycle = (jobId: string, kinds: rc.RecycleKind[], opts: { language?: string; userId?: string | null; origin?: string }) => {
      const job = vs().getJob(jobId);
      if (!job) throw notFound('Job nicht gefunden');
      if (job.status !== 'completed') throw bad('Recycling geht, sobald der Job fertig ist');
      const problem = aiProblem(job.location_id);
      if (problem) throw new HttpError(409, `${problem} Recycling braucht den KI-Assistenten (Einstellungen → KI-Assistent).`);
      const avail = new Set(availableKinds(job.location_id).filter((k) => k.available).map((k) => k.key));
      const list = [...new Set(kinds)].filter((k) => avail.has(k));
      if (!list.length) throw bad('Keine passenden Inhalte gewählt');
      const language = opts.language && rc.LANGUAGES[opts.language] ? opts.language : 'auto';
      for (const kind of list) {
        const cur = db.get('SELECT id, status FROM video_recycle WHERE job_id = ? AND kind = ?', jobId, kind);
        if (cur?.status === 'generating') continue;
        if (cur) db.run(`UPDATE video_recycle SET status = 'generating', error = NULL, language = ?, origin = ?, user_id = ?, updated_at = ? WHERE id = ?`, language, opts.origin ?? 'manuell', opts.userId ?? null, now(), cur.id);
        else db.insert('video_recycle', { id: id(), job_id: jobId, location_id: job.location_id, kind, status: 'generating', language, origin: opts.origin ?? 'manuell', user_id: opts.userId ?? null, created_at: now(), updated_at: now() });
      }
      vs().bg(`recycle:${jobId}`, () => runGenerate(jobId));
      return itemsOf(jobId);
    };

    // --- übernehmen ---------------------------------------------------------------------------------
    /** An admin-like context for background work (autopilot, workflows): the user who set it up, else the first admin. */
    const background = new WeakSet<Ctx>();
    const systemCtx = (loc: string, userId?: string | null): Ctx => {
      const own = userId ? db.get('SELECT * FROM users WHERE id = ?', userId) : null;
      const allowed = own && (own.role === 'admin' || JSON.parse(own.locations || '[]').includes(loc));
      const u = (allowed ? own : null) || db.get(`SELECT * FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1`);
      const ctx: Ctx = {
        req: { headers: {} } as any,
        res: undefined as any,
        method: 'POST',
        url: new URL('http://local/'),
        path: '/',
        params: {},
        query: new URLSearchParams(),
        body: {},
        rawBody: '',
        locationId: loc,
        viaApiKey: false,
        via: 'session',
        ip: '',
        cookies: {},
        setCookie() {},
        user: u ? { id: u.id, email: u.email, name: 'Autopilot (Video-Studio)', role: u.role, locations: JSON.parse(u.locations || '[]'), permissions: u.permissions ? JSON.parse(u.permissions) : null } : undefined,
      };
      background.add(ctx);
      return ctx;
    };

    const socialChannels = async (ctx: Ctx): Promise<any[]> => {
      try {
        const r = await callRoute(app, ctx, 'GET', '/api/social');
        return Array.isArray(r?.channels) ? r.channels : [];
      } catch {
        return [];
      }
    };

    interface Target {
      funnel_id?: string;
      embed?: 'auto' | 'youtube' | 'clip' | 'none';
      integration_ids?: string[];
      type?: 'draft' | 'schedule';
      date?: string;
      group_id?: string;
      channel_id?: string;
      course_id?: string;
      lesson_id?: string;
    }
    const apply = async (ctx: Ctx, item: any, target: Target): Promise<{ ref: string | null; url: string | null; label: string }> => {
      const kind = item.kind as rc.RecycleKind;
      const c = rc.cleanContent(kind, typeof item.content === 'string' ? JSON.parse(item.content) : item.content);
      rc.assertUsable(kind, c);
      const job = vs().getJob(item.job_id);
      if (!job) throw notFound('Job nicht gefunden');
      const loc = job.location_id;
      const best = clipsOf(job.id)[0];
      const ytUrl = job.source_type === 'url' && rc.youtubeId(job.source_url) ? job.source_url : null;
      switch (kind) {
        case 'blog': {
          const fid = String(target.funnel_id ?? '');
          if (!fid) throw bad('Website für den Blog wählen');
          const embed = target.embed ?? 'auto';
          let video: string | null = null;
          if ((embed === 'auto' || embed === 'youtube') && ytUrl) video = ytUrl;
          else if (embed === 'clip' && best) video = await publicClip(best);
          else if (embed === 'auto' && best) video = await publicClip(best).catch(() => null);
          const yt = rc.youtubeId(ytUrl);
          const thumb = best ? thumbUrl(best.id) : null;
          const cover = yt ? `https://i.ytimg.com/vi/${yt}/hqdefault.jpg` : thumb?.startsWith('https://') ? thumb : undefined;
          const post = await callRoute(
            app,
            ctx,
            'POST',
            `/api/funnels/${encodeURIComponent(fid)}/posts`,
            {
              title: c.title,
              excerpt: c.excerpt,
              content: rc.blogMarkdown(c, video),
              tags: c.tags,
              seo: { title: c.seo_title, description: c.seo_description },
              status: 'draft',
              ...(cover ? { cover_image: cover } : {}),
              // Autopilot drafts are signed by the business, not by "Autopilot".
              ...(background.has(ctx) ? { author: app.location(loc)?.name ?? '' } : {}),
            },
            { locationId: loc },
          );
          return { ref: post.id, url: `funnels/${fid}?tab=blog`, label: 'Blog-Entwurf' };
        }
        case 'newsletter': {
          const clips = clipsOf(job.id).slice(0, 3);
          const linked = [];
          for (const x of clips) {
            const url = await publicClip(x).catch(() => null); // expired in OpenShorts: leave it out
            if (url) linked.push({ title: x.title, url, thumb: thumbUrl(x.id) });
          }
          const yt = rc.youtubeId(ytUrl);
          const design = rc.newsletterDesign(c, { videoUrl: ytUrl ?? linked[0]?.url ?? null, videoThumb: yt ? `https://i.ytimg.com/vi/${yt}/hqdefault.jpg` : (linked[0]?.thumb ?? null), clips: ytUrl ? linked : linked.slice(1), ctaUrl: ytUrl ?? linked[0]?.url ?? null });
          const camp = await callRoute(app, ctx, 'POST', '/api/campaigns', { name: `Newsletter: ${job.title}`.slice(0, 200), subject: c.subject, channel: 'email', design }, { locationId: loc });
          return { ref: camp.id, url: `campaigns/${camp.id}`, label: 'Kampagnen-Entwurf' };
        }
        case 'linkedin':
        case 'x_thread':
        case 'instagram':
        case 'facebook': {
          if (!app.services.socialPost) throw new HttpError(409, 'Der Social Planner ist nicht installiert');
          const platforms = rc.RECYCLE_KINDS[kind].platforms ?? [];
          const all = await socialChannels(ctx);
          const ids = (target.integration_ids ?? []).map(String).filter((x) => all.some((ch) => ch.id === x && platforms.includes(ch.identifier)));
          if (!ids.length) throw bad(`Einen passenden Kanal wählen (${platforms.join(', ')})`);
          const type = target.type === 'schedule' ? 'schedule' : 'draft';
          const input: Record<string, any> = { integrationIds: ids, type, date: target.date, userId: ctx.user?.id, source: 'Video-Recycling' };
          if (kind === 'x_thread') Object.assign(input, { content: c.tweets[0], thread: c.tweets.slice(1) });
          else if (kind === 'instagram') {
            if (!best) throw bad('Instagram braucht ein Video – der Job hat keinen Clip');
            if (!vs().isPublicBase()) throw bad('HyperLevel muss öffentlich per https erreichbar sein, damit Postiz den Clip abholen kann');
            Object.assign(input, { content: rc.asText(kind, c), mediaUrls: [vs().mediaUrl(best.id)], video: true, title: best.title });
          } else input.content = c.text;
          const post = await app.services.socialPost(loc, input);
          return { ref: post?.id ?? null, url: 'social', label: type === 'schedule' ? 'Im Social Planner geplant' : 'Entwurf im Social Planner' };
        }
        case 'youtube': {
          if (!tableExists('video_tasks')) throw new HttpError(409, 'Das YouTube-Studio ist nicht installiert');
          const taskId = id();
          db.insert('video_tasks', { id: taskId, location_id: loc, kind: 'youtube', title: job.title.slice(0, 200), status: 'ready', input: { from: 'recycling', job_id: job.id }, result: { titles: c.titles, recommended: c.titles.slice(0, 1), thumbnail_texts: [], description: rc.youtubeDescription(c), description_title: c.titles[0] ?? '', history: [] }, user_id: ctx.user?.id ?? null, created_at: now(), updated_at: now() });
          return { ref: taskId, url: 'video-studio/youtube', label: 'Im YouTube-Studio' };
        }
        case 'shownotes': {
          if (!app.services.saveDocs) throw new HttpError(409, 'Das Dokumente-Modul ist nicht installiert');
          if (!app.baseUrl().startsWith('https://')) throw bad('Dokumente brauchen eine https-Adresse von HyperLevel – Text bitte kopieren');
          const url = `${app.baseUrl()}/app/video-studio/${job.id}?tab=recycling&item=${item.id}`;
          app.services.saveDocs([{ url, title: `Shownotes: ${c.title || job.title}`.slice(0, 300), kind: 'doc', source: 'Video-Recycling', summary: rc.asText(kind, c).slice(0, 2000), location_id: loc }], { force: true });
          return { ref: null, url: 'project', label: 'Als Dokument im Projekt' };
        }
        case 'community': {
          const gid = String(target.group_id ?? '');
          if (!gid) throw bad('Community-Gruppe wählen');
          const post = await callRoute(app, ctx, 'POST', `/api/community/groups/${encodeURIComponent(gid)}/posts`, { title: c.title, body: c.body, ...(target.channel_id ? { channel_id: target.channel_id } : {}) }, { locationId: loc });
          return { ref: post.id, url: `community/${gid}`, label: 'In der Community veröffentlicht' };
        }
        case 'lesson': {
          const cid = String(target.course_id ?? '');
          const lid = String(target.lesson_id ?? '');
          if (!cid || !lid) throw bad('Kurs und Lektion wählen');
          if (!best) throw bad('Der Job hat keinen Clip');
          const course = await callRoute(app, ctx, 'GET', `/api/courses/${encodeURIComponent(cid)}`, {}, { locationId: loc });
          const lesson = (course.modules ?? []).flatMap((m: any) => m.lessons ?? []).find((l: any) => l.id === lid);
          if (!lesson) throw notFound('Lektion nicht gefunden');
          const url = await publicClip(best);
          if (lesson.video_url === url || String(lesson.body ?? '').includes(url)) return { ref: lid, url: `courses/${cid}`, label: 'Schon in der Lektion' };
          const teaser = `**${c.title || 'Vorschau'}** – ${c.teaser}`;
          // No video yet: the clip becomes the lesson's player; otherwise it is embedded above the text.
          const patch = lesson.video_url ? { body: `${teaser}\n\n${url}\n\n---\n\n${lesson.body ?? ''}`.trim().slice(0, 100_000) } : { video_url: url, body: `${teaser}\n\n---\n\n${lesson.body ?? ''}`.trim().slice(0, 100_000) };
          await callRoute(app, ctx, 'PATCH', `/api/courses/${encodeURIComponent(cid)}/lessons/${encodeURIComponent(lid)}`, patch, { locationId: loc });
          return { ref: lid, url: `courses/${cid}`, label: lesson.video_url ? 'Teaser in der Lektion' : 'Clip als Lektionsvideo' };
        }
      }
    };
    const markApplied = (item: any, r: { ref: string | null; url: string | null; label: string }) =>
      db.run(`UPDATE video_recycle SET status = 'applied', applied_ref = ?, applied_url = ?, applied_label = ?, applied_at = ?, updated_at = ? WHERE id = ?`, r.ref, r.url, r.label, now(), now(), item.id);

    // --- autopilot --------------------------------------------------------------------------------
    const apOf = (loc: string) => {
      const row = parseJson(db.get('SELECT * FROM video_autopilot WHERE location_id = ?', loc), ['settings', 'state']);
      return { settings: { ...AUTOPILOT_DEFAULT, ...(row?.settings ?? {}) } as Autopilot, state: (row?.state ?? {}) as Record<string, any>, user_id: row?.user_id as string | null };
    };
    const saveState = (loc: string, state: Record<string, any>) => db.run('UPDATE video_autopilot SET state = ?, updated_at = ? WHERE location_id = ?', JSON.stringify(state), now(), loc);
    const log = (state: Record<string, any>, text: string) => {
      state.log = [{ at: now(), text: text.slice(0, 300) }, ...(state.log ?? [])].slice(0, 30);
    };
    const feedFetch = (url: string) => (app.services.feedFetch ?? ((u: string) => safeFetch(u, { timeoutMs: 15_000, maxBytes: 5 * 1024 * 1024, headers: { accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml' } })))(url);

    const cleanAutopilot = (b: any, cur: Autopilot): Autopilot => {
      const next: Autopilot = { ...cur };
      if (b.enabled !== undefined) next.enabled = !!b.enabled;
      if (b.mode !== undefined) next.mode = b.mode === 'auto' ? 'auto' : 'approve';
      if (b.top_n !== undefined) next.top_n = Math.max(0, Math.min(10, Math.round(Number(b.top_n) || 0)));
      if (b.max_per_day !== undefined) next.max_per_day = Math.max(1, Math.min(10, Math.round(Number(b.max_per_day) || 3)));
      if (b.times !== undefined) {
        const t = (Array.isArray(b.times) ? b.times : String(b.times).split(/[\s,]+/)).map((x: unknown) => String(x).trim()).filter(Boolean);
        if (t.some((x: string) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(x))) throw bad('Uhrzeiten im Format HH:MM, z. B. 09:30');
        if (!t.length || t.length > 6) throw bad('1 bis 6 Uhrzeiten angeben');
        next.times = [...new Set<string>(t)].sort();
      }
      if (b.days !== undefined) {
        const d = (Array.isArray(b.days) ? b.days : []).map(String).filter((x: string) => rc.DAY_LABELS.some(([k]) => k === x));
        if (!d.length) throw bad('Mindestens einen Wochentag wählen');
        next.days = d;
      }
      if (b.integration_ids !== undefined) next.integration_ids = (Array.isArray(b.integration_ids) ? b.integration_ids : []).map(String).slice(0, 30);
      if (b.recycle !== undefined) next.recycle = (Array.isArray(b.recycle) ? b.recycle : []).filter(rc.isKind);
      if (b.funnel_id !== undefined) next.funnel_id = b.funnel_id ? String(b.funnel_id) : null;
      if (b.notify_push !== undefined) next.notify_push = !!b.notify_push;
      if (b.notify_email !== undefined) next.notify_email = !!b.notify_email;
      if (b.options !== undefined) {
        const o = os.cleanOptions(b.options ?? {});
        next.options = { clips: o.clips ?? undefined, layout: o.layout, subtitles: o.subtitles, hook: o.hook };
      }
      if (b.feeds !== undefined) {
        if (!Array.isArray(b.feeds) || b.feeds.length > 5) throw bad('Höchstens 5 Quellen');
        next.feeds = b.feeds.map((f: any) => {
          const type = f?.type === 'podcast' ? 'podcast' : 'youtube';
          const raw = str(f?.url, 'Quelle', { required: true, max: 500 });
          let url = raw;
          if (type === 'youtube') {
            const feed = rc.youtubeFeedUrl(raw);
            if (!feed) throw bad('YouTube: Kanal-ID (UC…) oder einen Link mit /channel/UC… angeben – @Namen gehen nicht (Kanal-ID steht unter „Teilen → Kanal-ID kopieren“)');
            url = feed;
          } else if (!/^https:\/\/\S+$/i.test(raw)) throw bad('Podcast: RSS-Adresse mit https:// angeben');
          return { id: typeof f?.id === 'string' && /^[A-Za-z0-9]{6,20}$/.test(f.id) ? f.id : id(10), type, url, label: str(f?.label, 'Name', { max: 80 }) || (type === 'youtube' ? 'YouTube-Kanal' : 'Podcast') };
        });
      }
      return next;
    };

    /** Looks for new videos in the sub-account's feeds; the first look only remembers what is there. */
    const checkFeeds = async (loc: string) => {
      const ap = apOf(loc);
      const s = ap.settings;
      const state = ap.state;
      state.feeds = state.feeds ?? {};
      state.last_run = now();
      if (!s.enabled || !s.feeds.length) return (saveState(loc, state), state);
      const today = new Date(Date.now() - 24 * 3600_000).toISOString();
      let budget = s.max_per_day - Number(db.get(`SELECT COUNT(*) n FROM video_job_plans WHERE location_id = ? AND autopilot = 1 AND created_at > ?`, loc, today)?.n ?? 0);
      for (const feed of s.feeds) {
        const st = (state.feeds[feed.id] = { seen: [], ...(state.feeds[feed.id] ?? {}) });
        st.last_checked = now();
        try {
          const r = await feedFetch(feed.url);
          if (!r.ok) throw new Error(`Feed antwortet mit ${r.status}`);
          const xml = await r.text();
          const entries = feed.type === 'youtube' ? rc.parseYouTubeFeed(xml) : rc.parsePodcastFeed(xml);
          if (!entries.length && !/<(feed|rss)\b/i.test(xml)) throw new Error('Kein RSS/Atom-Feed');
          st.last_error = null;
          if (!st.initialized) {
            st.seen = entries.map((e) => e.id).slice(0, 200);
            st.initialized = true;
            log(state, `${feed.label}: verbunden – ${entries.length === 1 ? '1 vorhandenes Video' : `${entries.length} vorhandene Videos`} gemerkt, ab jetzt kommt jedes neue dazu`);
            continue;
          }
          const fresh = entries.filter((e) => !st.seen.includes(e.id)).reverse();
          for (const e of fresh) {
            if (e.media !== 'video' || !e.url) {
              st.seen = [e.id, ...st.seen].slice(0, 200);
              log(state, `${feed.label}: „${e.title}“ übersprungen – ${e.media === 'audio' ? 'nur Audio, OpenShorts braucht ein Video' : 'kein Video-Link'}`);
              continue;
            }
            if (budget <= 0) {
              log(state, `${feed.label}: Tageslimit erreicht – „${e.title}“ folgt beim nächsten Durchlauf`);
              break;
            }
            try {
              const job = await vs().createJob(loc, { url: e.url, title: e.title, options: s.options, origin: 'Autopilot', user_id: ap.user_id });
              db.insert('video_job_plans', { job_id: job.id, location_id: loc, kinds: s.recycle, autopilot: 1, feed_id: feed.id, item_id: e.id, created_at: now() });
              st.seen = [e.id, ...st.seen].slice(0, 200);
              st.last_item = e.title;
              budget--;
              log(state, `${feed.label}: neues Video „${e.title}“ – Shorts-Job gestartet`);
            } catch (err) {
              const status = (err as HttpError).status;
              log(state, `${feed.label}: „${e.title}“ – ${(err as Error).message}`);
              if (status === 429 || status === 409) break; // retried next time
              st.seen = [e.id, ...st.seen].slice(0, 200);
            }
          }
        } catch (e) {
          st.last_error = (e as Error).message.slice(0, 200);
        }
      }
      saveState(loc, state);
      return state;
    };

    /** After an autopilot job: best clips into the planner, recycling as drafts, tell the team. */
    const autopilotAfter = async (job: any) => {
      const loc = job.location_id;
      const ap = apOf(loc);
      const s = ap.settings;
      const state = ap.state;
      const ctx = systemCtx(loc, ap.user_id);
      const tz = app.location(loc)?.timezone || 'Europe/Berlin';
      const notes: string[] = [];
      const channels = await socialChannels(ctx);
      const chosen = channels.filter((c) => s.integration_ids.includes(c.id) && !c.disabled);
      const videoChannels = chosen.filter((c) => c.video);
      const clips = clipsOf(job.id).slice(0, s.top_n);
      const type = s.mode === 'auto' ? 'schedule' : 'draft';
      const socialKinds = s.recycle.filter((k) => rc.SOCIAL_KINDS.includes(k));
      const after = new Date(Math.max(Date.now() + 3600_000, state.last_slot ? Date.parse(state.last_slot) : 0));
      const slots = rc.nextSlots(clips.length + socialKinds.length, { times: s.times, days: s.days, tz, after });
      let slot = 0;
      let planned = 0;
      if (clips.length && videoChannels.length) {
        for (const c of clips) {
          const at = slots[slot++];
          // Channels whose limit the clip's caption exceeds (X: 280) are left out for this clip.
          const caption = String(vs().captionOf(c) ?? '');
          const fits = videoChannels.filter((ch) => !ch.limit || caption.length <= ch.limit);
          if (fits.length < videoChannels.length) notes.push(`Clip „${c.title}“: Text zu lang für ${videoChannels.filter((ch) => !fits.includes(ch)).map((ch) => ch.label).join(', ')}`);
          if (!fits.length) continue;
          try {
            await vs().scheduleClip(loc, c.id, { integration_ids: fits.map((ch) => ch.id), type, date: at?.toISOString(), userId: ap.user_id, source: 'Autopilot' });
            planned++;
            // Drafts claim their slot too – once approved they go out at that time.
            if (at) state.last_slot = at.toISOString();
          } catch (e) {
            notes.push(`Clip „${c.title}“: ${(e as Error).message}`);
          }
        }
      } else if (clips.length) notes.push('Keine Kanäle mit Video gewählt – Clips liegen im Video-Studio');
      let recycled = 0;
      let drafts = 0;
      const kinds = s.recycle;
      if (kinds.length) {
        const problem = aiProblem(loc);
        if (problem) notes.push(`Recycling übersprungen: ${problem}`);
        else {
          try {
            startRecycle(job.id, kinds, { userId: ap.user_id, origin: 'Autopilot' });
          } catch (e) {
            notes.push(`Recycling: ${(e as Error).message}`);
          }
          await runGenerate(job.id);
          for (const item of db.all(`SELECT * FROM video_recycle WHERE job_id = ? AND status = 'ready'`, job.id)) {
            recycled++;
            const kind = item.kind as rc.RecycleKind;
            let target: Target | null = null;
            if (kind === 'blog' && s.funnel_id) target = { funnel_id: s.funnel_id, embed: 'auto' };
            else if (kind === 'newsletter') target = {};
            else if (rc.SOCIAL_KINDS.includes(kind)) {
              const ids = chosen.filter((c) => (rc.RECYCLE_KINDS[kind].platforms ?? []).includes(c.identifier)).map((c) => c.id);
              if (ids.length) {
                const at = slots[slot++];
                target = { integration_ids: ids, type, date: at?.toISOString() };
                if (at) state.last_slot = at.toISOString();
              }
            }
            if (!target) continue;
            try {
              markApplied(item, await apply(ctx, item, target));
              drafts++;
            } catch (e) {
              notes.push(`${rc.RECYCLE_KINDS[kind].label}: ${(e as Error).message}`);
            }
          }
        }
      }
      const summary = `${planned} ${planned === 1 ? 'Clip' : 'Clips'} ${type === 'schedule' ? 'eingeplant' : 'als Entwurf im Social Planner'}, ${recycled} Recycling-Inhalte (${drafts} als Entwurf übernommen)`;
      log(state, `„${job.title}“: ${summary}${notes.length ? ` – ${notes.length} Hinweise` : ''}`);
      saveState(loc, state);
      db.run('UPDATE video_job_plans SET note = ? WHERE job_id = ?', [summary, ...notes].join('\n').slice(0, 2000), job.id);
      const title = type === 'schedule' ? 'Autopilot: neue Shorts eingeplant' : 'Autopilot: neue Shorts zur Freigabe';
      const body = `${job.title}: ${summary}.${notes.length ? `\n\nHinweise:\n- ${notes.join('\n- ')}` : ''}`;
      if (s.notify_push) await Promise.resolve(app.services.pushNotify?.({ locationId: loc, kind: 'shorts', title, body: `${job.title}: ${summary}`, url: `/app/video-studio/${job.id}`, tag: `autopilot-${job.id}` })).catch(() => {});
      if (s.notify_email) await notifyTeam(app, loc, title, `${body}\n\n${app.baseUrl()}/app/video-studio/${job.id}`).catch(() => {});
    };

    app.services.videoStudioReady = [
      ...(app.services.videoStudioReady ?? []),
      async (job: any) => {
        const plan = db.get('SELECT * FROM video_job_plans WHERE job_id = ? AND done = 0', job?.id ?? '');
        if (!plan) return;
        db.run('UPDATE video_job_plans SET done = 1 WHERE job_id = ?', job.id);
        if (plan.autopilot) return autopilotAfter(job);
        const kinds = JSON.parse(plan.kinds || '[]').filter(rc.isKind);
        if (!kinds.length) return;
        try {
          startRecycle(job.id, kinds, { origin: job.origin || 'Workflow', userId: job.user_id ?? null });
          await runGenerate(job.id);
        } catch (e) {
          db.run('UPDATE video_job_plans SET note = ? WHERE job_id = ?', (e as Error).message.slice(0, 500), job.id);
        }
      },
    ];

    app.onTick(() => {
      for (const row of db.all(`SELECT location_id, state FROM video_autopilot WHERE json_extract(settings, '$.enabled') = 1`)) {
        const last = Date.parse(JSON.parse(row.state || '{}').last_run ?? '') || 0;
        if (Date.now() - last >= AUTOPILOT_EVERY_MS && vs().config()) vs().bg(`autopilot:${row.location_id}`, () => checkFeeds(row.location_id).then(() => undefined));
      }
      // Generation cut off by a restart (no loop running for the job): mark as failed so it can be started again.
      const stale = db.all(`SELECT id, job_id FROM video_recycle WHERE status = 'generating' AND updated_at < ?`, new Date(Date.now() - 15 * 60_000).toISOString());
      for (const r of stale.filter((x) => !loops.has(x.job_id))) db.run(`UPDATE video_recycle SET status = 'failed', error = 'Abgebrochen – bitte neu erzeugen' WHERE id = ?`, r.id);
    });

    app.services.videoRecycle = { startRecycle, generate: runGenerate, apply, checkFeeds, autopilotAfter, transcriptOf, publicClip, systemCtx };

    // --- routes -----------------------------------------------------------------------------------
    const jobOf = (ctx: Ctx) => {
      const j = vs().getJob(ctx.params.id, ctx.locationId);
      if (!j) throw notFound('Job nicht gefunden');
      return j;
    };
    const targets = async (ctx: Ctx) => {
      const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
        try {
          return await fn();
        } catch {
          return fallback;
        }
      };
      const funnels = await safe(async () => ((await callRoute(app, ctx, 'GET', '/api/funnels')) as any[]).filter((f) => f.kind === 'website').map((f) => ({ id: f.id, name: f.name })), [] as any[]);
      const groups = await safe(async () => ((await callRoute(app, ctx, 'GET', '/api/community/groups')) as any[]).filter((g) => g.status !== 'archived').map((g) => ({ id: g.id, name: g.name })), [] as any[]);
      const courses = await safe(async () => {
        const list = ((await callRoute(app, ctx, 'GET', '/api/courses')) as any[]).slice(0, 20);
        const out = [];
        for (const c of list) {
          const full = await callRoute(app, ctx, 'GET', `/api/courses/${encodeURIComponent(c.id)}`);
          out.push({ id: c.id, title: c.title, lessons: (full.modules ?? []).flatMap((m: any) => (m.lessons ?? []).map((l: any) => ({ id: l.id, title: `${m.title} · ${l.title}` }))) });
        }
        return out.filter((c) => c.lessons.length);
      }, [] as any[]);
      const channels = (await socialChannels(ctx)).filter((c) => !c.disabled).map((c) => ({ id: c.id, name: c.name, identifier: c.identifier, label: c.label, picture: c.picture, video: c.video }));
      return { funnels, groups, courses, channels };
    };

    router.get('/api/video-studio/jobs/:id/recycle', 'location', async (ctx) => {
      const j = jobOf(ctx);
      return { kinds: availableKinds(ctx.locationId), ai: aiProblem(ctx.locationId), languages: rc.LANGUAGES, items: itemsOf(j.id), targets: ctx.query.get('targets') === '0' ? undefined : await targets(ctx), public_base: vs().isPublicBase(), youtube: !!(j.source_type === 'url' && rc.youtubeId(j.source_url)) };
    });
    router.post('/api/video-studio/jobs/:id/recycle', 'location', (ctx) => {
      const j = jobOf(ctx);
      const kinds = Array.isArray(ctx.body.kinds) && ctx.body.kinds.length ? ctx.body.kinds.filter(rc.isKind) : availableKinds(ctx.locationId).filter((k) => k.available).map((k) => k.key);
      return { items: startRecycle(j.id, kinds, { language: ctx.body.language, userId: ctx.user?.id ?? null, origin: ctx.via === 'mcp' ? 'MCP' : ctx.viaApiKey ? 'API' : 'manuell' }) };
    });
    /** A link instead of a job: start shorts and recycle once they are done (workflows, MCP). */
    router.post('/api/video-studio/recycle', 'location', async (ctx) => {
      const kinds = (Array.isArray(ctx.body.kinds) && ctx.body.kinds.length ? ctx.body.kinds.filter(rc.isKind) : availableKinds(ctx.locationId).filter((k) => k.available).map((k) => k.key)) as rc.RecycleKind[];
      const job = await vs().createJob(ctx.locationId, { url: ctx.body.url, title: ctx.body.title, options: ctx.body.options, contact_id: ctx.body.contact_id, user_id: ctx.user?.id ?? null, origin: ctx.via === 'mcp' ? 'MCP' : ctx.viaApiKey ? 'API' : 'manuell' });
      db.insert('video_job_plans', { job_id: job.id, location_id: ctx.locationId, kinds, autopilot: 0, created_at: now() });
      return { job, kinds };
    });
    router.patch('/api/video-studio/recycle/:id', 'location', (ctx) => {
      const it = getItem(ctx.params.id, ctx.locationId);
      if (!it) throw notFound('Inhalt nicht gefunden');
      if (it.status === 'generating') throw new HttpError(409, 'Wird gerade erzeugt');
      const content = rc.cleanContent(it.kind, { ...JSON.parse(it.content || '{}'), ...(ctx.body.content ?? {}) });
      db.run(`UPDATE video_recycle SET content = ?, edited = 1, status = CASE WHEN status = 'failed' THEN 'ready' ELSE status END, error = NULL, updated_at = ? WHERE id = ?`, JSON.stringify(content), now(), it.id);
      return itemOut(getItem(it.id, ctx.locationId));
    });
    router.post('/api/video-studio/recycle/:id/apply', 'location', async (ctx) => {
      const it = getItem(ctx.params.id, ctx.locationId);
      if (!it) throw notFound('Inhalt nicht gefunden');
      if (!['ready', 'applied'].includes(it.status)) throw bad('Der Inhalt ist noch nicht fertig');
      const b = ctx.body ?? {};
      const target: Target = {
        funnel_id: b.funnel_id ? String(b.funnel_id) : undefined,
        embed: ['auto', 'youtube', 'clip', 'none'].includes(b.embed) ? b.embed : 'auto',
        integration_ids: Array.isArray(b.integration_ids) ? b.integration_ids.map(String) : undefined,
        type: 'draft',
        group_id: b.group_id ? String(b.group_id) : undefined,
        channel_id: b.channel_id ? String(b.channel_id) : undefined,
        course_id: b.course_id ? String(b.course_id) : undefined,
        lesson_id: b.lesson_id ? String(b.lesson_id) : undefined,
      };
      const r = await apply(ctx, it, target);
      markApplied(it, r);
      return itemOut(getItem(it.id, ctx.locationId));
    });
    router.delete('/api/video-studio/recycle/:id', 'location', (ctx) => {
      if (!db.run('DELETE FROM video_recycle WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId).changes) throw notFound('Inhalt nicht gefunden');
      return { ok: true };
    });

    router.post('/api/video-studio/clips/:id/thumb', 'location', (ctx) => {
      const c = db.get(`SELECT id FROM video_clips WHERE id = ? AND location_id = ? AND status = 'ready'`, ctx.params.id, ctx.locationId);
      if (!c) throw notFound('Clip nicht gefunden');
      const m = String(ctx.body.data ?? '').match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
      if (!m) throw bad('Erwarte ein JPEG als data:-URL');
      const buf = Buffer.from(m[1], 'base64');
      if (buf.length < 500 || buf.length > 600 * 1024) throw bad('Vorschaubild zu klein oder größer als 600 KB');
      if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) throw bad('Das ist kein JPEG');
      mkdirSync(thumbDir, { recursive: true });
      writeFileSync(thumbFile(c.id), buf);
      return { thumb_url: thumbUrl(c.id) };
    });
    router.get('/hooks/openshorts/thumb/:token', 'public', (ctx) => {
      const m = /^([A-Za-z0-9]{8,32})\.([\w-]{24})\.jpg$/.exec(String(ctx.params.token));
      if (!m || !safeEqual(m[2], sig('thumb', m[1])) || !existsSync(thumbFile(m[1]))) throw notFound();
      return { __raw: true, status: 200, headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' }, body: readFileSync(thumbFile(m[1])) };
    });
    router.get('/hooks/openshorts/clip/:token', 'public', (ctx) => {
      const m = /^([A-Za-z0-9]{8,32})\.([\w-]{24})\.(mp4|webm|mov|m4v)$/.exec(String(ctx.params.token));
      if (!m || !safeEqual(m[2], sig('clip', m[1]))) throw notFound();
      const file = join(publicDir, `${m[1]}.${m[3]}`);
      if (!existsSync(file)) throw notFound();
      const size = statSync(file).size;
      const type = m[3] === 'webm' ? 'video/webm' : m[3] === 'mov' ? 'video/quicktime' : 'video/mp4';
      const range = parseRange(ctx.req.headers.range, size);
      const headers: Record<string, string> = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' };
      if (range) return { __raw: true, status: 206, headers: { ...headers, 'content-range': `bytes ${range.start}-${range.end}/${size}`, 'content-length': String(range.end - range.start + 1) }, body: createReadStream(file, range) };
      return { __raw: true, status: 200, headers: { ...headers, 'content-length': String(size) }, body: createReadStream(file) };
    });
    // Files of clips that no longer exist (job deleted) go once a day.
    let lastSweep = 0;
    app.onTick(() => {
      if (Date.now() - lastSweep < 864e5) return;
      lastSweep = Date.now();
      for (const d of [thumbDir, publicDir]) {
        if (!existsSync(d)) continue;
        for (const f of readdirSync(d)) {
          const clipId = f.split('.')[0];
          if (!db.get('SELECT id FROM video_clips WHERE id = ?', clipId)) rmSync(join(d, f), { force: true });
        }
      }
    });

    router.get('/api/video-studio/autopilot', 'location', (ctx) => {
      const ap = apOf(ctx.locationId);
      return { settings: ap.settings, state: { feeds: ap.state.feeds ?? {}, last_run: ap.state.last_run ?? null, last_slot: ap.state.last_slot ?? null, log: ap.state.log ?? [] }, kinds: availableKinds(ctx.locationId), ai: aiProblem(ctx.locationId), public_base: vs().isPublicBase() };
    });
    router.put('/api/video-studio/autopilot', 'location', (ctx) => {
      const ap = apOf(ctx.locationId);
      const next = cleanAutopilot(ctx.body ?? {}, ap.settings);
      // The blog target must be one of this sub-account's websites (no references into other tenants).
      if (next.funnel_id && next.funnel_id !== ap.settings.funnel_id && !db.get('SELECT id FROM funnels WHERE id = ? AND location_id = ?', next.funnel_id, ctx.locationId)) throw bad('Website nicht gefunden');
      if (next.enabled && !next.feeds.length) throw bad('Mindestens eine Quelle (YouTube-Kanal oder Podcast) eintragen');
      if (next.enabled && !vs().config()) throw new HttpError(409, 'Video-Studio ist noch nicht verbunden (Agentur → Integrationen → Einrichtung)');
      // Feeds that were removed or changed start over (first look only remembers).
      const state = ap.state;
      state.feeds = Object.fromEntries(Object.entries(state.feeds ?? {}).filter(([fid]) => next.feeds.some((f) => f.id === fid && ap.settings.feeds.find((o) => o.id === fid)?.url === f.url)));
      db.run(
        `INSERT INTO video_autopilot (location_id, settings, state, user_id, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(location_id) DO UPDATE SET settings = excluded.settings, state = excluded.state, user_id = excluded.user_id, updated_at = excluded.updated_at`,
        ctx.locationId, JSON.stringify(next), JSON.stringify(state), ctx.user?.id ?? ap.user_id ?? null, now(),
      );
      return { settings: next };
    });
    router.post('/api/video-studio/autopilot/check', 'location', async (ctx) => {
      if (!apOf(ctx.locationId).settings.enabled) throw bad('Der Autopilot ist aus');
      const st = await checkFeeds(ctx.locationId);
      return { state: { feeds: st.feeds ?? {}, last_run: st.last_run, last_slot: st.last_slot ?? null, log: st.log ?? [] } };
    });

    // --- workflows, MCP, reports -------------------------------------------------------------------
    app.services.workflowActions = {
      ...(app.services.workflowActions ?? {}),
      video_recycle: async (run: any, step: any, vars: Record<string, any>) => {
        const all = availableKinds(run.location_id).filter((k) => k.available).map((k) => k.key);
        const kinds = (Array.isArray(step.kinds) && step.kinds.length ? step.kinds.filter(rc.isKind) : all) as rc.RecycleKind[];
        const jobId = render(String(step.job_id || '{{event.jobId}}'), vars).trim();
        if (jobId && vs().getJob(jobId, run.location_id)) {
          const items = startRecycle(jobId, kinds, { origin: 'Workflow' });
          return `Recycling gestartet (${items.filter((i: any) => i.status === 'generating').length} Inhalte, Freigabe im Video-Studio)`;
        }
        const url = render(String(step.url ?? ''), vars).trim();
        if (!url) throw new Error('Kein fertiger Job (z. B. {{event.jobId}} aus „Shorts fertig“) und kein Video-Link');
        const job = await vs().createJob(run.location_id, { url, title: render(String(step.title ?? ''), vars).trim(), contact_id: run.contact_id, origin: 'Workflow' });
        db.insert('video_job_plans', { job_id: job.id, location_id: run.location_id, kinds, autopilot: 0, created_at: now() });
        return `Shorts-Job gestartet – Recycling folgt, sobald er fertig ist`;
      },
    };
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    app.services.reportSources = [...(app.services.reportSources ?? []), REPORT];
  },
};

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const TOOLS: Tool[] = [
  {
    name: 'ghl_recycle_video',
    title: 'Video recyceln',
    description:
      'Content-Recycling im Video-Studio: aus einem fertigen Shorts-Job (job_id aus ghl_list_shorts_jobs) oder einem neuen Video-Link (url – erst Shorts, dann Recycling) schreibt der KI-Assistent Blog-Beitrag, Newsletter, LinkedIn/X/Instagram/Facebook-Texte, YouTube-Beschreibung mit 10 Titeln, Shownotes, Community-Beitrag, Lektion-Teaser. Alles bleibt Entwurf im Tab „Recycling“, bis jemand übernimmt. list=true zeigt den Stand eines Jobs. Zählt aufs KI-Monatslimit.',
    inputSchema: {
      type: 'object',
      properties: {
        ...LOC,
        job_id: { type: 'string' },
        url: { type: 'string', description: 'Statt job_id: Video-Link für einen neuen Job' },
        kinds: { type: 'array', items: { type: 'string', enum: rc.KIND_KEYS } },
        language: { type: 'string', enum: Object.keys(rc.LANGUAGES) },
        list: { type: 'boolean', description: 'Nur den Stand anzeigen' },
      },
      required: ['location_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async (call, a) => {
      const slim = (i: any) => ({ id: i.id, kind: i.kind, label: i.label, status: i.status, error: i.error, applied: i.applied_label, text: i.text ? String(i.text).slice(0, 4000) : undefined });
      if (a.job_id) {
        if (a.list) return ((await call.api('GET', `/api/video-studio/jobs/${encodeURIComponent(a.job_id)}/recycle?targets=0`, { location: a.location_id })).items ?? []).map(slim);
        const r = await call.api('POST', `/api/video-studio/jobs/${encodeURIComponent(a.job_id)}/recycle`, { location: a.location_id, body: { kinds: a.kinds, language: a.language } });
        return { started: (r.items ?? []).map(slim), hint: 'Läuft im Hintergrund – Stand mit list=true abfragen.' };
      }
      if (!a.url) throw new HttpError(400, 'job_id oder url angeben');
      const r = await call.api('POST', '/api/video-studio/recycle', { location: a.location_id, body: { url: a.url, kinds: a.kinds } });
      return { job_id: r.job.id, status: r.job.status, kinds: r.kinds, hint: 'Erst entstehen die Shorts, danach startet das Recycling von selbst.' };
    },
  },
];

const REPORT: ReportSource = {
  key: 'video_recycle',
  label: 'Video-Studio: Recycelte Inhalte',
  area: 'social',
  from: 'video_recycle r',
  location: 'r.location_id',
  dateField: 'created_at',
  requires: ['video_recycle'],
  countLabel: 'Anzahl Inhalte',
  fields: [
    { key: 'created_at', label: 'Erzeugt am', type: 'date', sql: 'r.created_at' },
    { key: 'applied_at', label: 'Übernommen am', type: 'date', sql: 'r.applied_at' },
    { key: 'kind', label: 'Art', type: 'enum', sql: 'r.kind', options: Object.fromEntries(rc.KIND_KEYS.map((k) => [k, rc.RECYCLE_KINDS[k].label])) },
    { key: 'status', label: 'Status', type: 'enum', sql: 'r.status', options: { generating: 'Wird erzeugt', ready: 'Bereit', applied: 'Übernommen', failed: 'Fehlgeschlagen' } },
    { key: 'applied', label: 'Übernommen', type: 'boolean', sql: `(CASE WHEN r.applied_at IS NOT NULL THEN 1 ELSE 0 END)`, options: { 1: 'Ja', 0: 'Nein' } },
    { key: 'edited', label: 'Bearbeitet', type: 'boolean', sql: '(CASE WHEN r.edited > 0 THEN 1 ELSE 0 END)', options: { 1: 'Ja', 0: 'Nein' } },
    { key: 'origin', label: 'Gestartet über', type: 'string', sql: 'r.origin' },
  ],
  calcs: [{ key: 'apply_rate', label: 'Übernahme-Quote', sql: '100.0 * SUM(r.applied_at IS NOT NULL) / NULLIF(COUNT(*), 0)', format: 'percent' }],
};

