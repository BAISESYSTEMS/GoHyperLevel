import { existsSync, openAsBlob, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { parseJson, parseRows } from '../core/db.js';
import { id, now } from '../core/util.js';
import * as os from '../services/openshorts.js';

/**
 * Optional Video-Studio tabs on top of OpenShorts' API: YouTube-Studio (title ideas with a
 * refinement chat, description with chapters, AI thumbnails) and AI Shorts (UGC video from a
 * product URL or description). Long calls run in the background; the page polls the task.
 * Hidden by the page when the instance lacks the endpoints (features) or the BYOK keys.
 */

const STYLES = ['ugc', 'educational', 'shock', 'story', 'comparison'];

export const videoStudioToolsModule: Module = {
  name: 'video-studio-tools',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE video_tasks (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, busy TEXT,
        input TEXT NOT NULL DEFAULT '{}', result TEXT NOT NULL DEFAULT '{}', error TEXT, os_ref TEXT,
        user_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX video_tasks_loc ON video_tasks(location_id, kind, created_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const dir = join(app.config.dataDir, 'video-studio', 'uploads');
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
    const call = <T = any>(method: string, path: string, opts: os.OsRequest = {}) => os.osJson<T>(vs().fetch(), cfgOrFail(), method, path, opts);

    const getTask = (taskId: string, loc: string) => parseJson(db.get('SELECT * FROM video_tasks WHERE id = ? AND location_id = ?', taskId, loc), ['input', 'result']);
    const taskOf = (ctx: Ctx, kind: string) => {
      const t = getTask(ctx.params.id, ctx.locationId);
      if (!t || t.kind !== kind) throw notFound('Nicht gefunden');
      return t;
    };
    const out = (t: any) => {
      const r = { ...(t.result ?? {}) };
      // Thumbnails go through our proxy; OpenShorts' own paths stay internal.
      if (Array.isArray(r.thumbnails)) r.thumbnails = r.thumbnails.map((x: any, i: number) => ({ text: x.text, why: x.why, url: `/api/video-studio/youtube/${t.id}/thumbnails/${i}` }));
      const { os_ref: _ref, ...rest } = t;
      // Descriptions from Content-Recycling have no OpenShorts session to refine against.
      return { ...rest, result: r, refinable: !!t.os_ref };
    };
    const patchResult = (taskId: string, patch: Record<string, unknown>) => {
      const cur = parseJson(db.get('SELECT result FROM video_tasks WHERE id = ?', taskId), ['result'])?.result ?? {};
      db.run('UPDATE video_tasks SET result = ?, updated_at = ? WHERE id = ?', JSON.stringify({ ...cur, ...patch }), now(), taskId);
    };
    /** Runs one long OpenShorts call for a task in the background; busy shows what is running. */
    const work = (taskId: string, what: string, fn: () => Promise<void>) => {
      const t = db.get('SELECT busy FROM video_tasks WHERE id = ?', taskId);
      if (t?.busy) throw new HttpError(409, 'Läuft schon – bitte kurz warten');
      db.run('UPDATE video_tasks SET busy = ?, error = NULL, updated_at = ? WHERE id = ?', what, now(), taskId);
      vs().bg(`task:${taskId}`, async () => {
        try {
          await fn();
        } catch (e) {
          db.run('UPDATE video_tasks SET error = ?, updated_at = ? WHERE id = ?', (e as Error).message.slice(0, 300), now(), taskId);
          if (what === 'analyze' || what === 'scripts') db.run(`UPDATE video_tasks SET status = 'failed' WHERE id = ?`, taskId);
        } finally {
          db.run('UPDATE video_tasks SET busy = NULL, updated_at = ? WHERE id = ?', now(), taskId);
        }
      });
    };
    const takeUpload = (loc: string, uploadId: string, taskId: string) => {
      const up = db.get('SELECT * FROM video_uploads WHERE id = ? AND location_id = ?', uploadId, loc);
      if (!up) throw notFound('Upload nicht gefunden');
      if (up.status !== 'complete') throw bad('Der Upload ist noch nicht vollständig oder schon verwendet');
      db.run(`UPDATE video_uploads SET status = 'used', job_id = ?, updated_at = ? WHERE id = ?`, taskId, now(), up.id);
      return up;
    };
    // A restart drops running background calls: free the task so it can be retried.
    app.onTick(() => {
      db.run(`UPDATE video_tasks SET busy = NULL, error = 'Abgebrochen (Neustart) – bitte erneut versuchen', status = CASE WHEN status = 'analyzing' THEN 'failed' ELSE status END WHERE busy IS NOT NULL AND updated_at < ?`, new Date(Date.now() - 60 * 60_000).toISOString());
    });

    router.get('/api/video-studio/tasks', 'location', (ctx) => {
      const kind = ctx.query.get('kind');
      return parseRows(db.all(`SELECT * FROM video_tasks WHERE location_id = ?${kind ? ' AND kind = ?' : ''} ORDER BY created_at DESC LIMIT 50`, ctx.locationId, ...(kind ? [kind] : [])), ['input', 'result']).map(out);
    });
    router.get('/api/video-studio/tasks/:id', 'location', (ctx) => {
      const t = getTask(ctx.params.id, ctx.locationId);
      if (!t) throw notFound('Nicht gefunden');
      return out(t);
    });
    router.delete('/api/video-studio/tasks/:id', 'location', (ctx) => {
      if (!db.run('DELETE FROM video_tasks WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId).changes) throw notFound('Nicht gefunden');
      return { ok: true };
    });

    // --- YouTube-Studio --------------------------------------------------------------------------
    const needYoutube = () => {
      cfgOrFail();
      if (!vs().features().youtube_studio) throw bad('Diese OpenShorts-Instanz hat kein YouTube-Studio');
    };
    router.post('/api/video-studio/youtube', 'location', (ctx) => {
      needYoutube();
      const taskId = id();
      let url = '';
      let up: any = null;
      if (ctx.body.upload_id) up = takeUpload(ctx.locationId, String(ctx.body.upload_id), taskId);
      else {
        url = str(ctx.body.url, 'Video-Link', { required: true, max: 2000 });
        if (!/^https?:\/\/\S+$/i.test(url)) throw bad('Video-Link mit https:// angeben');
      }
      const title = str(ctx.body.title, 'Titel', { max: 200 }) || (up ? up.name : url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 80));
      db.insert('video_tasks', { id: taskId, location_id: ctx.locationId, kind: 'youtube', title, status: 'analyzing', input: { url: url || null, upload: up?.name ?? null }, result: {}, user_id: ctx.user?.id ?? null, created_at: now(), updated_at: now() });
      work(taskId, 'analyze', async () => {
        const form = new FormData();
        if (up) {
          const path = join(dir, up.file);
          if (!existsSync(path)) throw bad('Die hochgeladene Datei ist nicht mehr da');
          form.append('file', await openAsBlob(path, { type: 'application/octet-stream' }), up.name);
        } else form.append('url', url);
        const s = await call<any>('POST', '/api/thumbnail/upload', { form, timeoutMs: 3 * 3600_000 });
        if (up) rmSync(join(dir, up.file), { force: true });
        const sessionId = String(s?.session_id ?? '');
        if (!/^[A-Za-z0-9-]{8,64}$/.test(sessionId)) throw new HttpError(502, 'OpenShorts hat keine Sitzung geliefert');
        db.run('UPDATE video_tasks SET os_ref = ? WHERE id = ?', sessionId, taskId);
        const f2 = new FormData();
        f2.append('session_id', sessionId);
        // Waits for download + transcription on the OpenShorts side.
        const r = await call<any>('POST', '/api/thumbnail/analyze', { form: f2, timeoutMs: 60 * 60_000 });
        const strs = (v: unknown, max = 20) => (Array.isArray(v) ? v.slice(0, max).map((x) => String(x).slice(0, 300)) : []);
        patchResult(taskId, { titles: strs(r?.titles), thumbnail_texts: strs(r?.thumbnail_texts), recommended: strs(r?.recommended, 5), context: String(r?.context ?? '').slice(0, 3000), language: String(r?.language ?? '').slice(0, 10), history: [] });
        db.run(`UPDATE video_tasks SET status = 'ready', updated_at = ? WHERE id = ?`, now(), taskId);
      });
      return out(getTask(taskId, ctx.locationId));
    });
    const sessionOf = (t: any) => {
      if (t.status !== 'ready' || !t.os_ref) throw bad('Die Analyse ist noch nicht fertig');
      return String(t.os_ref);
    };
    router.post('/api/video-studio/youtube/:id/titles', 'location', (ctx) => {
      needYoutube();
      const t = taskOf(ctx, 'youtube');
      const session_id = sessionOf(t);
      const message = str(ctx.body.message, 'Wunsch', { required: true, max: 500 });
      work(t.id, 'titles', async () => {
        const r = await call<any>('POST', '/api/thumbnail/titles', { json: { session_id, message }, timeoutMs: 5 * 60_000 });
        const cur = getTask(t.id, ctx.locationId)?.result ?? {};
        patchResult(t.id, { titles: Array.isArray(r?.titles) ? r.titles.slice(0, 20).map((x: unknown) => String(x).slice(0, 300)) : cur.titles, thumbnail_texts: Array.isArray(r?.thumbnail_texts) ? r.thumbnail_texts.slice(0, 20) : cur.thumbnail_texts, history: [...(cur.history ?? []), message].slice(-20) });
      });
      return out(getTask(t.id, ctx.locationId));
    });
    router.post('/api/video-studio/youtube/:id/description', 'location', (ctx) => {
      needYoutube();
      const t = taskOf(ctx, 'youtube');
      const session_id = sessionOf(t);
      const title = str(ctx.body.title, 'Titel', { required: true, max: 300 });
      work(t.id, 'description', async () => {
        const r = await call<any>('POST', '/api/thumbnail/describe', { json: { session_id, title }, timeoutMs: 10 * 60_000 });
        patchResult(t.id, { description: String(r?.description ?? '').slice(0, 5000), description_title: title });
      });
      return out(getTask(t.id, ctx.locationId));
    });
    router.post('/api/video-studio/youtube/:id/thumbnails', 'location', (ctx) => {
      needYoutube();
      if (!vs().features().thumbnails) throw bad('Diese OpenShorts-Instanz erzeugt keine Thumbnails');
      const t = taskOf(ctx, 'youtube');
      const session_id = sessionOf(t);
      const title = str(ctx.body.title, 'Titel', { required: true, max: 300 });
      const prompt = str(ctx.body.prompt, 'Wunsch', { max: 500 });
      const count = Math.max(1, Math.min(4, Math.round(Number(ctx.body.count) || 3)));
      work(t.id, 'thumbnails', async () => {
        const form = new FormData();
        form.append('session_id', session_id);
        form.append('title', title);
        form.append('extra_prompt', prompt);
        form.append('count', String(count));
        form.append('burn_text', 'true');
        const r = await call<any>('POST', '/api/thumbnail/generate', { form, timeoutMs: 20 * 60_000 });
        const list = (Array.isArray(r?.thumbnails) ? r.thumbnails : []).map((x: any) => ({ path: os.mediaPath(x?.url), text: String(x?.text ?? '').slice(0, 200), why: String(x?.why ?? '').slice(0, 300) })).filter((x: any) => x.path);
        if (!list.length) throw new HttpError(502, 'OpenShorts hat keine Thumbnails geliefert (Gemini-Bildmodell verfügbar?)');
        patchResult(t.id, { thumbnails: list, thumbnail_title: title });
      });
      return out(getTask(t.id, ctx.locationId));
    });
    router.get('/api/video-studio/youtube/:id/thumbnails/:n', 'location', async (ctx) => {
      const t = taskOf(ctx, 'youtube');
      const item = (t.result?.thumbnails ?? [])[Number(ctx.params.n)];
      if (!item?.path) throw notFound('Thumbnail nicht gefunden');
      return vs().proxy(item.path, ctx, ctx.query.get('download') ? `thumbnail-${Number(ctx.params.n) + 1}.${item.path.split('.').pop()}` : undefined);
    });

    // --- AI Shorts (UGC) ----------------------------------------------------------------------------
    const needUgc = (forGenerate = false) => {
      const c = cfgOrFail();
      if (!vs().features().ai_shorts) throw bad('Diese OpenShorts-Instanz hat keine KI-Shorts');
      if (forGenerate && (!c.falKey || !c.elevenlabsKey)) throw bad('KI-Shorts brauchen fal.ai- und ElevenLabs-Schlüssel (Agentur → Integrationen → OpenShorts)');
      return c;
    };
    router.post('/api/video-studio/ugc', 'location', (ctx) => {
      needUgc();
      const url = str(ctx.body.url, 'Produkt-Link', { max: 1000 });
      const description = str(ctx.body.description, 'Beschreibung', { max: 3000 });
      if (!url && !description) throw bad('Produkt-Link oder Beschreibung angeben');
      if (url && !/^https?:\/\/\S+$/i.test(url)) throw bad('Produkt-Link mit https:// angeben');
      const language = ctx.body.language === 'es' ? 'es' : 'en';
      const style = STYLES.includes(ctx.body.style) ? ctx.body.style : 'ugc';
      const gender = ctx.body.actor_gender === 'male' ? 'male' : 'female';
      const num = Math.max(1, Math.min(3, Math.round(Number(ctx.body.num_scripts) || 3)));
      const taskId = id();
      db.insert('video_tasks', { id: taskId, location_id: ctx.locationId, kind: 'ugc', title: (url || description).replace(/^https?:\/\/(www\.)?/, '').slice(0, 80), status: 'analyzing', input: { url, description, language, style, actor_gender: gender, num_scripts: num }, result: {}, user_id: ctx.user?.id ?? null, created_at: now(), updated_at: now() });
      work(taskId, 'scripts', async () => {
        const r = await call<any>('POST', '/api/saasshorts/analyze', { json: { url: url || null, description: description || null, num_scripts: num, style, language, actor_gender: gender }, timeoutMs: 15 * 60_000 });
        const scripts = (Array.isArray(r?.scripts) ? r.scripts : []).slice(0, 3).filter((s: any) => s && typeof s === 'object');
        if (!scripts.length) throw new HttpError(502, 'OpenShorts hat keine Skripte geliefert');
        patchResult(taskId, { product: String(r?.analysis?.product_name ?? '').slice(0, 120), scripts: JSON.parse(JSON.stringify(scripts).slice(0, 200_000)), jobs: [] });
        db.run(`UPDATE video_tasks SET status = 'ready', updated_at = ? WHERE id = ?`, now(), taskId);
      });
      return out(getTask(taskId, ctx.locationId));
    });
    router.post('/api/video-studio/ugc/:id/generate', 'location', async (ctx) => {
      needUgc(true);
      const t = taskOf(ctx, 'ugc');
      if (t.status !== 'ready') throw bad('Die Skripte sind noch nicht fertig');
      const script = (t.result?.scripts ?? [])[Number(ctx.body.script_index)];
      if (!script) throw bad('Skript nicht gefunden');
      const mode = ctx.body.video_mode === 'premium' ? 'premium' : 'lowcost';
      const voice = ctx.body.voice_id ? str(ctx.body.voice_id, 'Stimme', { max: 64 }) : undefined;
      if (voice && !/^[\w-]+$/.test(voice)) throw bad('Stimme ungültig');
      const r = await call<any>('POST', '/api/saasshorts/generate', { json: { script, video_mode: mode, voice_id: voice, actor_description: script.actor_description ?? null, share_to_gallery: false }, fal: true, elevenlabs: true, timeoutMs: 60_000 });
      const osId = String(r?.job_id ?? '');
      if (!/^[A-Za-z0-9-]{8,64}$/.test(osId)) throw new HttpError(502, 'OpenShorts hat keine Job-ID geliefert');
      const job = vs().addUgcJob(ctx.locationId, { os_job_id: osId, title: String(script.title ?? t.title), user_id: ctx.user?.id ?? null });
      patchResult(t.id, { jobs: [...(t.result?.jobs ?? []), job.id] });
      return job;
    });
    router.get('/api/video-studio/ugc-voices', 'location', async () => {
      const c = needUgc();
      const r = await call<any>('GET', '/api/saasshorts/voices', { elevenlabs: !!c.elevenlabsKey, timeoutMs: 20_000 });
      return (Array.isArray(r?.voices) ? r.voices : []).slice(0, 100).map((v: any) => ({ id: String(v.voice_id ?? ''), name: String(v.name ?? '').slice(0, 80), category: String(v.category ?? '') })).filter((v: any) => /^[\w-]+$/.test(v.id));
    });
  },
};
