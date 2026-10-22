import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startTestApp } from './helpers.js';
import { setPostizFetch } from '../server/services/postiz.js';
import * as os from '../server/services/openshorts.js';
import { isPublicBase, looksLikeVideo } from '../server/modules/video-studio.js';

/**
 * Video-Studio against a fake OpenShorts (app.services.openshortsFetch): connection test (self-hosted
 * and hosted), jobs from a link and from a chunked upload, webhook signatures, polling, follow-up
 * steps, clip proxy, scheduling into the social planner, docs, rights, SaaS plans, workflows, MCP,
 * YouTube-Studio and AI Shorts. No real OpenShorts/Gemini/Postiz call is made.
 */

type Call = { method: string; path: string; body: any; headers: Record<string, string> };
const fakeOs = {
  calls: [] as Call[],
  jobs: new Map<string, { status: string; logs: string[]; result: any; body: any }>(),
  uploads: new Map<string, Buffer>(),
  paths: ['/api/uploads', '/api/uploads/{upload_id}', '/api/process', '/api/status/{job_id}', '/api/subtitle', '/api/translate', '/api/clip/rerender', '/api/thumbnail/upload', '/api/thumbnail/analyze', '/api/thumbnail/titles', '/api/thumbnail/generate', '/api/thumbnail/describe', '/api/saasshorts/analyze', '/api/saasshorts/generate', '/api/saasshorts/status/{job_id}'],
  n: 0,
  last(path: string) {
    return [...this.calls].reverse().find((c) => c.path === path);
  },
};
const clipMeta = (jobId: string, i: number, score: number) => ({
  start: 10 * i,
  end: 10 * i + 32.5,
  predicted_score: score,
  why: `Starker Hook ${i}`,
  viral_hook_text: `Hook ${i}`,
  video_title_for_youtube_short: `Titel ${i}`,
  video_description_for_tiktok: `TikTok ${i} #shorts #tipp`,
  video_description_for_instagram: `So geht das wirklich ${i} #Marketing #shorts`,
  video_url: `/videos/${jobId}/talk_clip_${i}.mp4`,
});

const fake = async (input: string, init: any = {}): Promise<Response> => {
  const u = new URL(input);
  const path = u.pathname;
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  let body: any = init.body;
  if (typeof body === 'string') body = JSON.parse(body);
  else if (body instanceof FormData) body = Object.fromEntries([...body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `file:${(v as Blob).size}`]));
  else if (body && typeof body.arrayBuffer === 'function') body = Buffer.from(await body.arrayBuffer());
  fakeOs.calls.push({ method, path: path + (u.search || ''), body, headers });
  const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  const hosted = u.hostname === 'api.openshorts.test';
  if (u.hostname === 'dashboard.test') return new Response('<html>', { status: 404 });
  if (hosted && path !== '/health' && path !== '/api/config' && headers.authorization !== 'Bearer osk_good') return json({ detail: 'Not authenticated' }, 401);
  if (path === '/health') return json({ status: 'ok' });
  if (path === '/api/config') return json({ youtubeUrlEnabled: true, billingEnabled: hosted, jobRetentionSeconds: 86400, localLlm: null });
  if (path === '/api/me') return hosted ? json({ plan: 'pro', minutes: { remaining: 90 } }) : json({ detail: 'Not Found' }, 404);
  if (path === '/openapi.json') return json({ paths: Object.fromEntries(fakeOs.paths.map((p) => [p, {}])) });
  if (path === '/api/translate/languages') return json({ languages: { de: 'German', en: 'English', es: 'Spanish' } });
  if (path === '/api/uploads' && method === 'POST') return json({ upload_id: 'slot-12345678', upload_url: 'http://elsewhere/api/uploads/slot-12345678', method: 'PUT', max_mb: 2048 });
  if (path.startsWith('/api/uploads/') && method === 'PUT') {
    fakeOs.uploads.set(path.split('/').pop()!, body);
    return json({ upload_id: path.split('/').pop(), bytes: body.length, duration_seconds: 300 });
  }
  if (path === '/api/process') {
    if (String(body.url ?? '').includes('kurz')) return json({ detail: 'This video is only 20s long — clip generation needs at least 45s.' }, 400);
    if (String(body.url ?? '').includes('lowres') && !body.force_low_quality) return json({ needs_confirmation: true, quality_check: { max_height: 360, min_height: 720 } });
    const jobId = `osjob-${String(++fakeOs.n).padStart(4, '0')}`;
    fakeOs.jobs.set(jobId, { status: 'queued', logs: [`Job ${jobId} queued.`], result: null, body });
    return json({ job_id: jobId, status: 'queued' });
  }
  if (path.startsWith('/api/status/')) {
    const j = fakeOs.jobs.get(path.split('/').pop()!);
    if (!j) return json({ detail: 'Job not found' }, 404);
    return json({ status: j.status, logs: j.logs, result: j.result, queue: j.status === 'queued' ? { position: 2, ahead: 1, eta_seconds: 240 } : null });
  }
  if (path === '/api/subtitle') return json({ success: true, new_video_url: `/videos/${body.job_id}/subtitled_1_${body.input_filename}` });
  if (path === '/api/translate') return headers['x-elevenlabs-key'] ? json({ success: true, new_video_url: `/videos/${body.job_id}/translated_${body.target_language}_${body.input_filename}` }) : json({ detail: 'Missing X-ElevenLabs-Key header' }, 400);
  if (path === '/api/clip/rerender') return json({ success: true, new_video_url: `/videos/${body.job_id}/rerender_${body.input_filename}` });
  if (path.startsWith('/videos/') || path.startsWith('/thumbnails/')) {
    if (path.includes('gone')) return json({ detail: 'Not Found' }, 404);
    const bytes = Buffer.from(path.startsWith('/thumbnails/') ? 'JPEGDATA' : 'VIDEO-BYTES-0123456789');
    const range = headers.range?.match(/bytes=(\d+)-(\d*)/);
    const type = path.startsWith('/thumbnails/') ? 'image/jpeg' : 'video/mp4';
    if (range) {
      const s = Number(range[1]);
      const e = range[2] ? Number(range[2]) : bytes.length - 1;
      return new Response(bytes.subarray(s, e + 1), { status: 206, headers: { 'content-type': type, 'content-range': `bytes ${s}-${e}/${bytes.length}`, 'content-length': String(e - s + 1) } });
    }
    return new Response(bytes, { status: 200, headers: { 'content-type': type, 'content-length': String(bytes.length) } });
  }
  if (path === '/api/thumbnail/upload') return json({ session_id: 'sess-12345678' });
  if (path === '/api/thumbnail/analyze') return json({ session_id: body.session_id, titles: ['Titel A', 'Titel B'], thumbnail_texts: ['A!', 'B!'], context: 'Worum es geht', language: 'de', recommended: ['Titel A'] });
  if (path === '/api/thumbnail/titles') return json({ titles: ['Neuer Titel'], thumbnail_texts: ['NEU'], language: 'de' });
  if (path === '/api/thumbnail/describe') return json({ description: 'Intro\n\n00:00 Start\n01:30 Hauptteil' });
  if (path === '/api/thumbnail/generate') return json({ thumbnails: [{ url: '/thumbnails/sess-12345678/thumb_1.jpg', text: 'WOW', why: 'Kontrast' }, { url: '/etc/passwd', text: 'x', why: 'y' }] });
  if (path === '/api/saasshorts/analyze') return json({ analysis: { product_name: 'Malerei Meier' }, scripts: [{ title: 'Skript 1', caption: 'Frische Wände #malerei', hashtags: ['#handwerk'], actor_description: 'Frau, 30' }] });
  if (path === '/api/saasshorts/generate') return headers['x-fal-key'] && headers['x-elevenlabs-key'] ? json({ job_id: 'ugc-12345678', status: 'processing' }) : json({ detail: 'Missing fal.ai API Key (X-Fal-Key header)' }, 400);
  if (path === '/api/saasshorts/status/ugc-12345678') return json({ status: 'completed', logs: ['done'], result: { video_url: '/videos/saas_ugc-12345678/final.mp4', duration: 23, script: { title: 'Skript 1', caption: 'Frische Wände #malerei', hashtags: ['handwerk'] } } });
  return json({ detail: 'Not Found' }, 404);
};

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const vs = () => t.app.services.videoStudio;
const events: any[] = [];

beforeAll(async () => {
  t = await startTestApp();
  t.app.services.openshortsFetch = fake;
  await t.setup();
  loc = t.api.location;
  t.app.events.on('shorts.ready', (e) => void events.push(e));
});
afterAll(async () => {
  await t.close();
});

const setJob = (osId: string, patch: Partial<{ status: string; logs: string[]; result: any }>) => Object.assign(fakeOs.jobs.get(osId)!, patch);
const dueAll = () => t.app.db.run('UPDATE video_jobs SET polled_at = NULL');
const raw = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  t.api.raw(path, { ...init, headers: { cookie: t.api.cookie, 'x-pghl': '1', 'x-location-id': loc, ...(init.headers ?? {}) } });

describe('openshorts helpers', () => {
  it('builds the process body and follow-up steps from the options', () => {
    expect(os.osBase(' https://api.openshorts.app/docs/ ')).toBe('https://api.openshorts.app');
    expect(() => os.cleanBaseUrl('ftp://x')).toThrow(/http/);
    expect(() => os.cleanBaseUrl('http://user:pw@openshorts:8000')).toThrow(/Zugangsdaten/);
    expect(() => os.cleanOptions({ clips: 30 })).toThrow(/Anzahl Clips/);
    expect(() => os.cleanOptions({ min_seconds: 30, max_seconds: 32 })).toThrow(/5 Sekunden/);
    expect(() => os.cleanOptions({ layout: 'zoom' })).toThrow(/Layout/);
    const o = os.cleanOptions({ clips: '4', layout: 'general', subtitles: 'hormozi', hook: false, dub_language: 'EN' });
    expect(os.processBody(o, { url: 'https://youtu.be/x' }, { url: 'https://gh/h', secret: 's' })).toEqual({
      url: 'https://youtu.be/x', acknowledged: true, layouts: ['none'], output_format: 'vertical', captions: false, auto_hook: false, target_clips: 4, webhook_url: 'https://gh/h', webhook_secret: 's',
    });
    expect(os.postOps(o, true)).toEqual([{ op: 'framing', framing: 'full' }, { op: 'dub', language: 'en' }, { op: 'subtitles', preset: 'hormozi' }]);
    expect(os.postOps(o, false)).toEqual([{ op: 'framing', framing: 'full' }, { op: 'subtitles', preset: 'hormozi' }]);
    expect(os.postOps(os.cleanOptions({}), true)).toEqual([]);
    expect(os.processBody(os.cleanOptions({ min_seconds: '30', max_seconds: 60 }), { url: 'u' })).toMatchObject({ clip_min_seconds: 30, clip_max_seconds: 60 });
    expect(os.processBody(os.cleanOptions({ layout: 'split' }), { upload_id: 'u1' }, null, true)).toMatchObject({ upload_id: 'u1', layouts: ['split'], captions: true, auto_hook: true, auto_hook_style: 'pill', force_low_quality: true });
  });

  it('parses clips, hashtags, progress, errors and signatures', () => {
    const clips = os.parseClips({ clips: [clipMeta('j1', 3, 88), { ...clipMeta('j1', 1, 120), video_url: 'https://api.x/videos/j1/talk_clip_1.mp4?exp=1' }, { video_url: '/videos/j1/../../.env' }, { video_url: '/etc/passwd' }] });
    expect(clips.map((c) => [c.index, c.score, c.path])).toEqual([
      [2, 88, '/videos/j1/talk_clip_3.mp4'],
      [0, 100, '/videos/j1/talk_clip_1.mp4'],
    ]);
    expect(clips[0]).toMatchObject({ title: 'Titel 3', description: 'So geht das wirklich 3', hashtags: ['#marketing', '#shorts', '#tipp'], duration: 32.5, reason: 'Starker Hook 3' });
    expect(os.mediaPath('/thumbnails/s1/a.jpg')).toBe('/thumbnails/s1/a.jpg');
    expect(os.mediaPath('/videos/x/%2e%2e/a.mp4')).toBeNull();
    expect(os.progressOf('queued', [], 0, { position: 2, eta_seconds: 240 })).toEqual({ progress: 2, stage: 'In der Warteschlange (Platz 2, ca. 4 Min.)' });
    expect(os.progressOf('processing', ['🎙️  Transcribing video...'], 0).stage).toBe('Transkription');
    expect(os.progressOf('processing', ['🔥 Found 4 clips!', '✅ Clip 1 ready: x', '✅ Clip 2 ready: y'], 1)).toEqual({ progress: 70, stage: 'Clips werden geschnitten (2/4)' });
    expect(os.errorFromLogs(['Job started', '❌ Gemini Error: 429 quota', 'Process failed with exit code 1'])).toBe('Gemini Error: 429 quota');
    expect(os.osErrorMessage(400, { detail: 'Missing X-Gemini-Key header' })).toMatch(/Gemini-Schlüssel/);
    expect(os.osErrorMessage(402, { detail: { error: 'quota_exceeded', minutes_required: 9, minutes_remaining: 2 } })).toMatch(/nötig 9, übrig 2/);
    const sig = os.signBody('geheim', '{"a":1}');
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(os.verifySignature('geheim', '{"a":1}', sig)).toBe(true);
    expect(os.verifySignature('geheim', '{"a":2}', sig)).toBe(false);
    expect(os.verifySignature('', '{"a":1}', sig)).toBe(false);
    expect(isPublicBase('https://crm.example.com')).toBe(true);
    expect(isPublicBase('http://crm.example.com')).toBe(false);
    expect(isPublicBase('https://localhost')).toBe(false);
    expect(isPublicBase('https://10.0.0.5')).toBe(false);
    expect(looksLikeVideo(Buffer.from('\0\0\0\x18ftypmp42isom'))).toBe(true);
    expect(looksLikeVideo(Buffer.from('<html><body>hallo</body>'))).toBe(false);
  });
});

describe('video studio (OpenShorts)', () => {
  it('stays off until the agency connects OpenShorts, then tests the connection', async () => {
    expect((await t.api.get('/api/video-studio')).data.configured).toBe(false);
    expect((await t.api.post('/api/video-studio/jobs', { url: 'https://youtu.be/abc' })).status).toBe(409);
    expect((await t.api.patch('/api/agency/video-studio', { url: 'ftp://openshorts' })).status).toBe(400);
    expect((await t.api.post('/api/agency/video-studio/test', { url: 'https://dashboard.test' })).data.error).toMatch(/Backend/);

    const r = await t.api.patch('/api/agency/video-studio', { url: 'http://openshorts:8000/docs', elevenlabs_key: 'el_secret_123', max_active: 20 });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ url: 'http://openshorts:8000', configured: true, key_set: false, elevenlabs_set: true, elevenlabs_hint: '…_123', error: null });
    expect(r.data.info).toMatchObject({ mode: 'selfhosted', youtube_urls: true, retention_hours: 24, features: { uploads: true, youtube_studio: true, ai_shorts: true, translate: true } });
    expect(JSON.stringify(r.data)).not.toContain('el_secret_123');
    const s = (await t.api.get('/api/video-studio')).data;
    expect(s).toMatchObject({ configured: true, mode: 'selfhosted', dubbing: true, ai_shorts: false, public_base: false });
    expect(s.languages).toMatchObject({ de: 'German' });

    const cat = (await t.api.get('/api/agency/integrations/catalog')).data.items.find((i: any) => i.key === 'openshorts');
    expect(cat).toMatchObject({ status: 'ok', category: 'Marketing', detail: 'Selbst gehostet' });
  });

  it('needs a valid osk_ key for the hosted API', async () => {
    expect((await t.api.post('/api/agency/video-studio/test', { url: 'https://api.openshorts.test' })).data.error).toMatch(/osk_/);
    expect((await t.api.post('/api/agency/video-studio/test', { url: 'https://api.openshorts.test', api_key: 'osk_bad' })).data.error).toMatch(/ungültig/);
    const ok = await t.api.post('/api/agency/video-studio/test', { url: 'https://api.openshorts.test', api_key: 'osk_good' });
    expect(ok.data).toMatchObject({ ok: true, info: { mode: 'hosted', plan: 'pro', minutes_remaining: 90 } });
    expect(fakeOs.last('/api/me')!.headers.authorization).toBe('Bearer osk_good');
    // A test of another address does not overwrite the saved connection.
    expect((await t.api.get('/api/agency/video-studio')).data.info.mode).toBe('selfhosted');
  });

  it('runs a job from a link: queue, progress, clips, completion and the "Shorts fertig" event', async () => {
    const r = await t.api.post('/api/video-studio/jobs', { url: 'https://www.youtube.com/watch?v=abc123', title: 'Podcast #12', options: { clips: 3, layout: 'split', hook: true } });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ status: 'queued', title: 'Podcast #12', source_type: 'url', webhook: false, origin: 'manuell' });
    const body = fakeOs.last('/api/process')!.body;
    expect(body).toMatchObject({ url: 'https://www.youtube.com/watch?v=abc123', acknowledged: true, layouts: ['split'], target_clips: 3, captions: true, auto_hook: true });
    expect(body.webhook_url).toBeUndefined();
    const job = r.data;
    const osId = t.app.db.get('SELECT os_job_id FROM video_jobs WHERE id = ?', job.id)!.os_job_id;

    setJob(osId, { status: 'processing', logs: ['Job started by worker.', '🎙️  Transcribing video...'] });
    let j = (await t.api.post(`/api/video-studio/jobs/${job.id}/refresh`)).data;
    expect(j).toMatchObject({ status: 'processing', progress: 20, stage: 'Transkription' });

    setJob(osId, { logs: ['🔥 Found 2 clips!', '✅ Clip 1 ready: a'], result: { clips: [clipMeta(osId, 1, 61)] } });
    dueAll();
    await t.app.tick();
    await vs().idle();
    j = (await t.api.get(`/api/video-studio/jobs/${job.id}`)).data;
    expect(j).toMatchObject({ status: 'processing', progress: 70, clips_count: 1 });

    setJob(osId, { status: 'completed', result: { clips: [clipMeta(osId, 1, 61), clipMeta(osId, 2, 93)] } });
    dueAll();
    await t.app.tick();
    await vs().idle();
    await t.app.events.flush();
    j = (await t.api.get(`/api/video-studio/jobs/${job.id}`)).data;
    expect(j).toMatchObject({ status: 'completed', progress: 100, clips_count: 2, best_score: 93 });
    expect(j.clips.map((c: any) => c.score)).toEqual([93, 61]);
    expect(j.clips[0]).toMatchObject({ title: 'Titel 2', hashtags: ['#marketing', '#shorts', '#tipp'], video_url: `/api/video-studio/clips/${j.clips[0].id}/video`, pending: 0 });
    expect(JSON.stringify(j)).not.toContain('hook_sealed');
    const ev = events.find((e) => e.data.jobId === job.id);
    expect(ev).toMatchObject({ type: 'shorts.ready', locationId: loc, data: { clips: 2, bestScore: 93, title: 'Podcast #12' } });
    expect(ev.data.contactId).toBeUndefined();

    // Too short: German error, nothing stored. Low resolution: asks first.
    const short = await t.api.post('/api/video-studio/jobs', { url: 'https://example.com/kurz.mp4' });
    expect(short.status).toBe(400);
    expect(short.data.error).toMatch(/nur 20 s lang/);
    const low = (await t.api.post('/api/video-studio/jobs', { url: 'https://example.com/lowres.mp4' })).data;
    expect(low).toMatchObject({ status: 'confirm' });
    expect(low.stage).toMatch(/360p/);
    expect((await t.api.post(`/api/video-studio/jobs/${low.id}/confirm`)).data.status).toBe('queued');
    expect(fakeOs.last('/api/process')!.body.force_low_quality).toBe(true);
    expect(t.app.db.get('SELECT COUNT(*) n FROM video_jobs')!.n).toBe(2);

    // Per sub-account limit for running jobs.
    await t.api.patch('/api/agency/video-studio', { max_active: 1 });
    expect((await t.api.post('/api/video-studio/jobs', { url: 'https://youtu.be/zzz' })).status).toBe(429);
    await t.api.patch('/api/agency/video-studio', { max_active: 20 });
  });

  it('verifies the per-job webhook and moves the job to its final state', async () => {
    const before = t.app.config.baseUrl;
    t.app.config.baseUrl = 'https://gh.example.com';
    try {
      const job = (await t.api.post('/api/video-studio/jobs', { url: 'https://youtu.be/webhook1', options: { subtitles: 'off', hook: false } })).data;
      expect(job.webhook).toBe(true);
      const body = fakeOs.last('/api/process')!.body;
      expect(body).toMatchObject({ captions: false, auto_hook: false });
      expect(body.webhook_url).toMatch(/^https:\/\/gh\.example\.com\/hooks\/openshorts\/[\w-]{20,}$/);
      expect(body.webhook_secret).toMatch(/^[\w-]{40,}$/);
      const hookPath = new URL(body.webhook_url).pathname;
      const osId = t.app.db.get('SELECT os_job_id FROM video_jobs WHERE id = ?', job.id)!.os_job_id;
      const payload = JSON.stringify({ event: 'job.completed', job_id: osId, status: 'completed', clips: [{ index: 0, title: 'x', video_url: 'https://x/videos/a.mp4' }] });
      const post = (p: string, b: string, sig?: string) => t.api.raw(p, { method: 'POST', headers: { 'content-type': 'application/json', ...(sig ? { 'x-openshorts-signature': sig } : {}) }, body: b });

      expect((await post(hookPath, payload)).status).toBe(401);
      expect((await post(hookPath, payload, os.signBody('falsch', payload))).status).toBe(401);
      expect((await post('/hooks/openshorts/unknowntoken0000000000000', payload, os.signBody(body.webhook_secret, payload))).status).toBe(404);
      const wrongJob = JSON.stringify({ event: 'job.completed', job_id: 'osjob-9999' });
      expect((await post(hookPath, wrongJob, os.signBody(body.webhook_secret, wrongJob))).status).toBe(400);

      setJob(osId, { status: 'completed', logs: ['done'], result: { clips: [clipMeta(osId, 1, 77)] } });
      expect((await post(hookPath, payload, os.signBody(body.webhook_secret, payload))).status).toBe(200);
      let j = (await t.api.get(`/api/video-studio/jobs/${job.id}`)).data;
      expect(j).toMatchObject({ status: 'completed', clips_count: 1 });
      expect(t.app.db.get('SELECT webhook_at FROM video_jobs WHERE id = ?', job.id)!.webhook_at).toBeTruthy();

      // A failed job: the error comes from OpenShorts' log.
      const job2 = (await t.api.post('/api/video-studio/jobs', { url: 'https://youtu.be/webhook2' })).data;
      const b2 = fakeOs.last('/api/process')!.body;
      const os2 = t.app.db.get('SELECT os_job_id FROM video_jobs WHERE id = ?', job2.id)!.os_job_id;
      setJob(os2, { status: 'failed', logs: ['Job started', '❌ Gemini Error: 429 RESOURCE_EXHAUSTED', 'Process failed with exit code 1'] });
      const p2 = JSON.stringify({ event: 'job.failed', job_id: os2, status: 'failed', clips: [], error: 'Gemini Error' });
      expect((await post(new URL(b2.webhook_url).pathname, p2, os.signBody(b2.webhook_secret, p2))).status).toBe(200);
      j = (await t.api.get(`/api/video-studio/jobs/${job2.id}`)).data;
      expect(j).toMatchObject({ status: 'failed' });
      expect(j.error).toMatch(/Gemini Error: 429/);
    } finally {
      t.app.config.baseUrl = before;
    }
  });

  it('polls as fallback and fails jobs OpenShorts no longer knows', async () => {
    const job = (await t.api.post('/api/video-studio/jobs', { url: 'https://youtu.be/lost' })).data;
    const osId = t.app.db.get('SELECT os_job_id FROM video_jobs WHERE id = ?', job.id)!.os_job_id;
    // Not due yet: polled a moment ago.
    await t.app.tick();
    await vs().idle();
    const polls = fakeOs.calls.filter((c) => c.path === `/api/status/${osId}`).length;
    expect(polls).toBe(0);
    fakeOs.jobs.delete(osId);
    dueAll();
    await t.app.tick();
    await vs().idle();
    const j = (await t.api.get(`/api/video-studio/jobs/${job.id}`)).data;
    expect(j.status).toBe('failed');
    expect(j.error).toMatch(/kennt diesen Job nicht mehr/);
  });

  it('takes a chunked upload and streams it to the OpenShorts upload slot', async () => {
    expect((await t.api.post('/api/video-studio/uploads', { name: 'notes.txt', size: 10 })).status).toBe(400);
    expect((await t.api.post('/api/video-studio/uploads', { name: 'big.mp4', size: 3 * 1024 * 1024 * 1024 })).data.error).toMatch(/2048 MB/);
    const video = Buffer.concat([Buffer.from('\0\0\0\x18ftypmp42isom'), Buffer.alloc(40, 7)]);
    const up = (await t.api.post('/api/video-studio/uploads', { name: 'Interview.mp4', size: video.length })).data;
    expect(up).toMatchObject({ chunk_size: 8 * 1024 * 1024, received: 0 });
    const put = (offset: number, b: Buffer) => raw(`/api/video-studio/uploads/${up.id}?offset=${offset}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: b });
    expect((await put(10, video.subarray(10, 20))).status).toBe(409);
    expect(await (await put(0, video.subarray(0, 20))).json()).toMatchObject({ received: 20, complete: false });
    expect(await (await put(0, video.subarray(0, 20))).json()).toMatchObject({ received: 20 }); // retried chunk
    expect((await t.api.post('/api/video-studio/jobs', { upload_id: up.id })).data.error).toMatch(/nicht vollständig/);
    expect(await (await put(20, video.subarray(20))).json()).toMatchObject({ received: video.length, complete: true });

    // Something that is not a video is refused at the first chunk.
    const fakeUp = (await t.api.post('/api/video-studio/uploads', { name: 'x.mp4', size: 30 })).data;
    expect((await raw(`/api/video-studio/uploads/${fakeUp.id}?offset=0`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from('<html>not a video at all...</html>') })).status).toBe(400);

    const job = (await t.api.post('/api/video-studio/jobs', { upload_id: up.id, options: { layout: 'auto' } })).data;
    expect(job).toMatchObject({ status: 'uploading', source_type: 'upload', title: 'Interview' });
    await vs().idle();
    const j = (await t.api.get(`/api/video-studio/jobs/${job.id}`)).data;
    expect(j.status).toBe('queued');
    expect(fakeOs.uploads.get('slot-12345678')!.equals(video)).toBe(true);
    expect(fakeOs.last('/api/process')!.body).toMatchObject({ upload_id: 'slot-12345678', layouts: ['auto'] });
    expect(fakeOs.last('/api/process')!.body.url).toBeUndefined();
    expect(fakeOs.last('/api/uploads')!.body).toEqual({ filename: 'Interview.mp4' });
    // The temporary file is gone once OpenShorts has it; the upload can't be used twice.
    expect(readdirSync(join(t.app.config.dataDir, 'video-studio', 'uploads')).filter((f) => f.endsWith('.mp4') && !f.startsWith('.')).length).toBeLessThanOrEqual(1);
    expect((await t.api.post('/api/video-studio/jobs', { upload_id: up.id })).data.error).toMatch(/schon verwendet/);
  });

  it('falls back to a signed HyperLevel download link for OpenShorts versions without upload slots', async () => {
    const before = t.app.config.baseUrl;
    t.app.config.baseUrl = 'https://gh.example.com';
    const paths = fakeOs.paths;
    fakeOs.paths = paths.filter((p) => !p.startsWith('/api/uploads'));
    try {
      await t.api.post('/api/agency/video-studio/test');
      expect((await t.api.get('/api/video-studio')).data.features.uploads).toBe(false);
      const video = Buffer.concat([Buffer.from('\0\0\0\x18ftypmp42isom'), Buffer.alloc(100, 1)]);
      const up = (await t.api.post('/api/video-studio/uploads', { name: 'clip.mov', size: video.length })).data;
      await raw(`/api/video-studio/uploads/${up.id}?offset=0`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: video });
      const job = (await t.api.post('/api/video-studio/jobs', { upload_id: up.id })).data;
      await vs().idle();
      expect((await t.api.get(`/api/video-studio/jobs/${job.id}`)).data.status).toBe('queued');
      const src = fakeOs.last('/api/process')!.body.url as string;
      expect(src).toMatch(/^https:\/\/gh\.example\.com\/hooks\/openshorts\/source\/[A-Za-z0-9]+\.\d+\.[\w-]{32}\.mov$/);
      const path = new URL(src).pathname;
      const full = await t.api.raw(path);
      expect(full.status).toBe(200);
      expect(Buffer.from(await full.arrayBuffer()).equals(video)).toBe(true);
      const part = await t.api.raw(path, { headers: { range: 'bytes=4-11' } });
      expect(part.status).toBe(206);
      expect(part.headers.get('content-range')).toBe(`bytes 4-11/${video.length}`);
      expect(await part.text()).toBe('ftypmp42');
      expect((await t.api.raw(path.replace(/\.[\w-]{32}\./, '.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.'))).status).toBe(404);
    } finally {
      fakeOs.paths = paths;
      t.app.config.baseUrl = before;
      await t.api.post('/api/agency/video-studio/test');
    }
  });

  it('streams clips with ranges, edits texts and runs follow-up steps', async () => {
    const job = (await t.api.post('/api/video-studio/jobs', { url: 'https://youtu.be/ops', options: { subtitles: 'hormozi', dub_language: 'en' } })).data;
    const osId = t.app.db.get('SELECT os_job_id FROM video_jobs WHERE id = ?', job.id)!.os_job_id;
    expect(fakeOs.last('/api/process')!.body.captions).toBe(false); // dubbing first, captions afterwards
    setJob(osId, { status: 'completed', result: { clips: [clipMeta(osId, 1, 50)] } });
    let j = (await t.api.post(`/api/video-studio/jobs/${job.id}/refresh`)).data;
    expect(j.status).toBe('finishing');
    await vs().idle();
    await vs().runOps();
    j = (await t.api.get(`/api/video-studio/jobs/${job.id}`)).data;
    expect(j.status).toBe('completed');
    const clip = j.clips[0];
    expect(t.app.db.get('SELECT video_path, ops, op_status FROM video_clips WHERE id = ?', clip.id)).toEqual({ video_path: `/videos/${osId}/subtitled_1_translated_en_talk_clip_1.mp4`, ops: '[]', op_status: '' });
    expect(fakeOs.last('/api/translate')!.headers['x-elevenlabs-key']).toBe('el_secret_123');
    expect(fakeOs.last('/api/subtitle')!.body).toEqual({ job_id: osId, clip_index: 0, preset: 'hormozi', input_filename: 'translated_en_talk_clip_1.mp4' });

    // Player: Range is passed through, download as attachment.
    const part = await raw(`/api/video-studio/clips/${clip.id}/video`, { headers: { range: 'bytes=0-4' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 0-4/22');
    expect(await part.text()).toBe('VIDEO');
    const dl = await raw(`/api/video-studio/clips/${clip.id}/video?download=1`);
    expect(dl.headers.get('content-disposition')).toMatch(/^attachment; filename="Titel 1\.mp4"/);
    expect(dl.headers.get('content-type')).toBe('video/mp4');
    // <video src> can't send headers: the sub-account comes as query parameter.
    expect((await t.api.raw(`/api/video-studio/clips/${clip.id}/video?locationId=${loc}`, { headers: { cookie: t.api.cookie } })).status).toBe(200);

    const e = await t.api.patch(`/api/video-studio/clips/${clip.id}`, { title: 'Mein Titel', description: 'Neu', hashtags: '#Handwerk, malerei #handwerk' });
    expect(e.data).toMatchObject({ title: 'Mein Titel', description: 'Neu', hashtags: ['#handwerk', '#malerei'], edited: 1 });
    expect((await t.api.patch(`/api/video-studio/clips/${clip.id}`, { hashtags: '#a-b' })).status).toBe(400);

    t.app.db.run(`UPDATE video_clips SET ops = '[{"op":"subtitles","preset":"clean"}]' WHERE id = ?`, clip.id);
    expect((await t.api.post(`/api/video-studio/clips/${clip.id}/edit`, { op: 'subtitles', preset: 'clean' })).status).toBe(409);
    t.app.db.run(`UPDATE video_clips SET ops = '[]' WHERE id = ?`, clip.id);
    const r = await t.api.post(`/api/video-studio/clips/${clip.id}/edit`, { op: 'framing', framing: 'full' });
    expect(r.data).toMatchObject({ pending: 1 });
    expect(['pending', 'running']).toContain(r.data.op_status);
    await vs().idle();
    await vs().runOps();
    expect(fakeOs.last('/api/clip/rerender')!.body).toMatchObject({ clip_index: 0, segments: [{ start: 10, end: 42.5 }], framing: 'full', reapply_captions: false });
    expect((await t.api.post(`/api/video-studio/clips/${clip.id}/edit`, { op: 'subtitles', preset: 'off' })).status).toBe(400);

    // A clip OpenShorts has already deleted (retention) says so.
    t.app.db.run(`UPDATE video_clips SET video_path = '/videos/gone/x_clip_1.mp4' WHERE id = ?`, clip.id);
    const gone = await raw(`/api/video-studio/clips/${clip.id}/video`);
    expect(gone.status).toBe(404);
    expect((await gone.json()).error).toMatch(/nicht mehr vorhanden/);

    expect((await t.api.del(`/api/video-studio/clips/${clip.id}`)).status).toBe(200);
    expect((await t.api.get(`/api/video-studio/jobs/${job.id}`)).data.clips).toHaveLength(0);
  });

  it('plans a clip in the social planner (video via signed link) and saves it as document', async () => {
    const job = (await t.api.post('/api/video-studio/jobs', { url: 'https://youtu.be/plan' })).data;
    const osId = t.app.db.get('SELECT os_job_id FROM video_jobs WHERE id = ?', job.id)!.os_job_id;
    setJob(osId, { status: 'completed', result: { clips: [clipMeta(osId, 1, 81)] } });
    const clip = (await t.api.post(`/api/video-studio/jobs/${job.id}/refresh`)).data.clips[0];

    expect((await t.api.post(`/api/video-studio/clips/${clip.id}/schedule`, { integration_ids: ['int-x'] })).data.error).toMatch(/öffentlich per https/);
    expect((await t.api.post(`/api/video-studio/clips/${clip.id}/doc`)).data.error).toMatch(/https/);

    const realPost = t.app.services.socialPost;
    const seen: any[] = [];
    t.app.services.socialPost = async (l: string, input: any) => {
      seen.push({ l, input });
      return { id: 'sp-1', publish_at: input.date, type: input.type };
    };
    const before = t.app.config.baseUrl;
    t.app.config.baseUrl = 'https://gh.example.com';
    try {
      const date = new Date(Date.now() + 86400_000).toISOString();
      const r = await t.api.post(`/api/video-studio/clips/${clip.id}/schedule`, { integration_ids: ['int-x', 'int-yt'], type: 'schedule', date });
      expect(r.status).toBe(200);
      expect(r.data.clip.planned).toBe(1);
      expect(seen[0].l).toBe(loc);
      expect(seen[0].input).toMatchObject({ integrationIds: ['int-x', 'int-yt'], type: 'schedule', date, video: true, title: 'Titel 1', source: 'Video-Studio', content: 'So geht das wirklich 1\n\n#marketing #shorts #tipp' });
      const media = seen[0].input.mediaUrls[0] as string;
      expect(media).toMatch(new RegExp(`^https://gh\\.example\\.com/hooks/openshorts/media/${clip.id}\\.\\d+\\.[\\w-]{32}\\.mp4$`));
      // Postiz fetches the clip from this public, signed, short-lived link.
      const got = await t.api.raw(new URL(media).pathname);
      expect(got.status).toBe(200);
      expect(await got.text()).toBe('VIDEO-BYTES-0123456789');
      expect((await t.api.raw(new URL(media).pathname.replace(clip.id, 'AAAAAAAAAAAAAAAA'))).status).toBe(404);
      expect(t.app.db.get('SELECT * FROM video_posts WHERE clip_id = ?', clip.id)).toMatchObject({ social_post_id: 'sp-1', channels: 2, type: 'schedule', publish_at: date });
      await t.api.post(`/api/video-studio/clips/${clip.id}/schedule`, { integration_ids: ['int-x'], type: 'draft', caption: 'Eigener Text' });
      expect(seen[1].input.content).toBe('Eigener Text');

      const d = await t.api.post(`/api/video-studio/clips/${clip.id}/doc`);
      expect(d.data.url).toBe(`https://gh.example.com/app/video-studio/${job.id}?clip=${clip.id}`);
      const doc = (await t.api.get('/api/docs')).data.find((x: any) => x.url === d.data.url);
      expect(doc).toMatchObject({ title: 'Short: Titel 1', kind: 'doc', source: 'Video-Studio' });
      expect(doc.summary).toMatch(/Viralität: 81\/100/);
    } finally {
      t.app.services.socialPost = realPost;
      t.app.config.baseUrl = before;
    }
  });

  it('hands the video to Postiz (YouTube/TikTok need a video) through the social module', async () => {
    const postiz: any[] = [];
    setPostizFetch((async (input: any, init: any = {}) => {
      const path = new URL(String(input)).pathname.replace('/api/public/v1', '');
      const body = init.body ? JSON.parse(init.body) : undefined;
      postiz.push({ path, body });
      const json = (d: any) => new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } });
      if (path === '/is-connected') return json({ connected: true });
      if (path === '/integrations') return json([{ id: 'int-yt', name: 'Kanal', identifier: 'youtube', picture: '', disabled: false }, { id: 'int-x', name: 'X', identifier: 'x', picture: '', disabled: false }]);
      if (path === '/upload-from-url') return json({ id: 'm1', path: 'https://postiz.test/u/1.mp4' });
      if (path === '/posts') return json([{ postId: 'p1', integration: 'int-yt' }]);
      return json({});
    }) as any);
    await t.api.patch('/api/agency/social', { url: 'https://postiz.test', api_key: 'k' });
    await t.api.put('/api/agency/social/channels/int-yt', { location_id: loc });
    await t.api.put('/api/agency/social/channels/int-x', { location_id: loc });
    const before = t.app.config.baseUrl;
    t.app.config.baseUrl = 'https://gh.example.com';
    try {
      const clip = t.app.db.get(`SELECT id FROM video_clips WHERE status = 'ready' AND location_id = ? LIMIT 1`, loc)!;
      // A plain text post to YouTube stays refused …
      expect((await t.api.post('/api/social/posts', { content: 'Hallo', integration_ids: ['int-yt'], type: 'now' })).status).toBe(400);
      // … a clip goes through with the YouTube title.
      const r = await t.api.post(`/api/video-studio/clips/${clip.id}/schedule`, { integration_ids: ['int-yt'], type: 'now', title: 'Mein Short' });
      expect(r.status).toBe(200);
      const upload = postiz.find((p) => p.path === '/upload-from-url');
      expect(upload.body.url).toMatch(/\/hooks\/openshorts\/media\/.+\.mp4$/);
      const created = postiz.find((p) => p.path === '/posts' && p.body);
      expect(created.body.posts[0]).toMatchObject({ integration: { id: 'int-yt' }, value: [{ image: [{ id: 'm1', path: 'https://postiz.test/u/1.mp4' }] }], settings: { __type: 'youtube', title: 'Mein Short', type: 'public' } });
    } finally {
      t.app.config.baseUrl = before;
    }
  });

  it('keeps sub-accounts apart and respects rights and SaaS plans', async () => {
    const other = (await t.api.post('/api/locations', { name: 'Zweitfirma' })).data.id;
    const job = t.app.db.get('SELECT id FROM video_jobs WHERE location_id = ? LIMIT 1', loc)!;
    t.api.setLocation(other);
    expect((await t.api.get(`/api/video-studio/jobs/${job.id}`)).status).toBe(404);
    expect((await t.api.get('/api/video-studio/jobs')).data).toEqual([]);
    t.api.setLocation(loc);

    await t.api.post('/api/users', { email: 'kunde@example.com', password: 'geheim123', name: 'Kunde', locations: [loc], permissions: ['contacts'] });
    await t.api.post('/api/users', { email: 'social@example.com', password: 'geheim123', name: 'Social', locations: [loc], permissions: ['social'] });
    const plan = (await t.api.post('/api/saas/plans', { name: 'Basis', features: ['dashboard', 'contacts', 'social'] })).data;
    const mini = (await t.api.post('/api/saas/plans', { name: 'Mini', features: ['dashboard', 'contacts'] })).data;
    const adminCookie = t.api.cookie;

    t.api.clearCookie();
    await t.api.post('/api/auth/login', { email: 'kunde@example.com', password: 'geheim123' });
    expect((await t.api.get('/api/video-studio')).status).toBe(403);
    expect((await t.api.get('/api/agency/video-studio')).status).toBe(403);

    t.api.clearCookie();
    await t.api.post('/api/auth/login', { email: 'social@example.com', password: 'geheim123' });
    const memberCookie = t.api.cookie;
    expect((await t.api.get('/api/video-studio/jobs')).status).toBe(200);

    // SaaS: a plan without the social planner locks the studio for client logins.
    const asAdmin = async (fn: () => Promise<unknown>) => {
      const c = t.api.cookie;
      t.api.clearCookie();
      await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123' });
      await fn();
      t.api.clearCookie();
      await t.api.post('/api/auth/login', { email: c === memberCookie ? 'social@example.com' : 'chef@example.com', password: 'geheim123' });
    };
    void adminCookie;
    await asAdmin(() => t.api.put(`/api/saas/locations/${loc}`, { plan_id: mini.id, status: 'active' }));
    const blocked = await t.api.get('/api/video-studio/jobs');
    expect(blocked.status).toBe(403);
    await asAdmin(() => t.api.put(`/api/saas/locations/${loc}`, { plan_id: plan.id, status: 'active' }));
    expect((await t.api.get('/api/video-studio/jobs')).status).toBe(200);

    t.api.clearCookie();
    await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123' });
  });

  it('adds the workflow trigger "Shorts fertig" and the action "Shorts aus Video erstellen"', async () => {
    const meta = (await t.api.get('/api/workflows/meta')).data;
    expect(meta.triggers).toContain('shorts.ready');
    expect(meta.steps).toContain('shorts_create');
    const contact = (await t.api.post('/api/contacts', { first_name: 'Vera', email: 'vera@example.com' })).data;
    const wf = (await t.api.post('/api/workflows', { name: 'Shorts fertig → Tag', trigger: { type: 'shorts.ready', config: {} }, steps: [{ id: 's1', type: 'add_tag', tags: ['shorts-fertig'] }] })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });

    const result = await t.app.services.workflowActions.shorts_create(
      { location_id: loc, contact_id: contact.id },
      { url: '{{contact.custom.video}}', title: 'Video von {{contact.first_name}}', clips: 2, layout: 'track' },
      { contact: { first_name: 'Vera', custom: { video: 'https://youtu.be/vera' } } },
    );
    expect(result).toMatch(/Video von Vera/);
    const job = t.app.db.get(`SELECT * FROM video_jobs WHERE title = 'Video von Vera'`)!;
    expect(job).toMatchObject({ contact_id: contact.id, origin: 'Workflow', status: 'queued' });
    expect(fakeOs.last('/api/process')!.body).toMatchObject({ url: 'https://youtu.be/vera', target_clips: 2, layouts: ['none'] });
    setJob(job.os_job_id, { status: 'completed', result: { clips: [clipMeta(job.os_job_id, 1, 70)] } });
    await t.api.post(`/api/video-studio/jobs/${job.id}/refresh`);
    await t.app.events.flush();
    expect((await t.api.get(`/api/contacts/${contact.id}`)).data.tags).toContain('shorts-fertig');
    await expect(t.app.services.workflowActions.shorts_create({ location_id: loc, contact_id: contact.id }, { url: '{{contact.custom.missing}}' }, { contact: {} })).rejects.toThrow(/Video-Link fehlt/);
  });

  it('offers the MCP tools ghl_create_shorts, ghl_list_shorts_jobs and ghl_schedule_clip', async () => {
    const key = (await t.api.post('/api/agency/api-keys', { name: 'Claude', scope: 'write' })).data.key;
    const rpc = async (method: string, params: any = {}) => {
      const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const out = await r.json();
      return out.result ?? { isError: true, content: [{ text: out.error?.message }] };
    };
    const names = (await rpc('tools/list')).tools.map((x: any) => x.name);
    expect(names).toEqual(expect.arrayContaining(['ghl_create_shorts', 'ghl_list_shorts_jobs', 'ghl_schedule_clip']));
    const tool = async (name: string, args: any) => {
      const r = await rpc('tools/call', { name, arguments: args });
      return { error: r.isError, data: r.isError ? r.content[0].text : JSON.parse(r.content[0].text) };
    };
    const created = await tool('ghl_create_shorts', { location_id: loc, url: 'https://youtu.be/mcp', clips: 5, subtitles: 'pill' });
    expect(created.error).toBe(false);
    expect(created.data).toMatchObject({ status: 'queued', origin: 'MCP' });
    const osId = t.app.db.get('SELECT os_job_id FROM video_jobs WHERE id = ?', created.data.id)!.os_job_id;
    setJob(osId, { status: 'completed', result: { clips: [clipMeta(osId, 1, 64)] } });
    await t.app.services.videoStudio.refreshJob(created.data.id);
    await vs().runOps();
    const list = await tool('ghl_list_shorts_jobs', { location_id: loc });
    expect(list.data.find((j: any) => j.id === created.data.id)).toMatchObject({ status: 'completed', clips: 1, best_score: 64 });
    const detail = await tool('ghl_list_shorts_jobs', { location_id: loc, job_id: created.data.id });
    expect(detail.data.clips[0]).toMatchObject({ title: 'Titel 1', score: 64 });

    const seen: any[] = [];
    const realPost = t.app.services.socialPost;
    t.app.services.socialPost = async (_l: string, input: any) => (seen.push(input), { id: 'sp-9', publish_at: new Date().toISOString() });
    const before = t.app.config.baseUrl;
    t.app.config.baseUrl = 'https://gh.example.com';
    try {
      const s = await tool('ghl_schedule_clip', { location_id: loc, clip_id: detail.data.clips[0].id, integration_ids: ['int-x'] });
      expect(s.error).toBe(false);
      expect(seen[0]).toMatchObject({ type: 'draft', integrationIds: ['int-x'], video: true });
      expect((await tool('ghl_create_shorts', { location_id: loc })).data).toMatch(/url/);
    } finally {
      t.app.services.socialPost = realPost;
      t.app.config.baseUrl = before;
    }
  });

  it('runs YouTube-Studio and AI Shorts in the background and hides unsafe paths', async () => {
    const y = (await t.api.post('/api/video-studio/youtube', { url: 'https://youtu.be/long' })).data;
    expect(y).toMatchObject({ kind: 'youtube', status: 'analyzing', busy: 'analyze' });
    await vs().idle();
    let task = (await t.api.get(`/api/video-studio/tasks/${y.id}`)).data;
    expect(task).toMatchObject({ status: 'ready', busy: null, result: { titles: ['Titel A', 'Titel B'], recommended: ['Titel A'], language: 'de' } });
    expect(task.os_ref).toBeUndefined();
    expect(fakeOs.last('/api/thumbnail/upload')!.body).toEqual({ url: 'https://youtu.be/long' });
    expect(fakeOs.last('/api/thumbnail/analyze')!.body).toEqual({ session_id: 'sess-12345678' });

    await t.api.post(`/api/video-studio/youtube/${y.id}/titles`, { message: 'kürzer bitte' });
    await vs().idle();
    await t.api.post(`/api/video-studio/youtube/${y.id}/description`, { title: 'Neuer Titel' });
    await vs().idle();
    await t.api.post(`/api/video-studio/youtube/${y.id}/thumbnails`, { title: 'Neuer Titel', count: 2 });
    await vs().idle();
    task = (await t.api.get(`/api/video-studio/tasks/${y.id}`)).data;
    expect(task.result).toMatchObject({ titles: ['Neuer Titel'], history: ['kürzer bitte'], description: 'Intro\n\n00:00 Start\n01:30 Hauptteil' });
    expect(task.result.thumbnails).toEqual([{ text: 'WOW', why: 'Kontrast', url: `/api/video-studio/youtube/${y.id}/thumbnails/0` }]);
    const img = await raw(task.result.thumbnails[0].url);
    expect(img.headers.get('content-type')).toBe('image/jpeg');
    expect(await img.text()).toBe('JPEGDATA');

    // AI Shorts: scripts work with Gemini only, rendering needs fal.ai + ElevenLabs.
    const u = (await t.api.post('/api/video-studio/ugc', { description: 'Malerbetrieb in Köln', language: 'de' })).data;
    await vs().idle();
    const ugc = (await t.api.get(`/api/video-studio/tasks/${u.id}`)).data;
    expect(ugc).toMatchObject({ status: 'ready', result: { product: 'Malerei Meier', scripts: [{ title: 'Skript 1' }] } });
    expect(fakeOs.last('/api/saasshorts/analyze')!.body).toMatchObject({ language: 'en', description: 'Malerbetrieb in Köln' });
    expect((await t.api.post(`/api/video-studio/ugc/${u.id}/generate`, { script_index: 0 })).data.error).toMatch(/fal\.ai/);
    await t.api.patch('/api/agency/video-studio', { fal_key: 'fal_secret_1' });
    expect((await t.api.get('/api/video-studio')).data.ai_shorts).toBe(true);
    const gen = (await t.api.post(`/api/video-studio/ugc/${u.id}/generate`, { script_index: 0, video_mode: 'premium' })).data;
    expect(gen).toMatchObject({ kind: 'ugc', status: 'processing', title: 'Skript 1' });
    expect(fakeOs.last('/api/saasshorts/generate')!.headers).toMatchObject({ 'x-fal-key': 'fal_secret_1', 'x-elevenlabs-key': 'el_secret_123' });
    expect(fakeOs.last('/api/saasshorts/generate')!.body).toMatchObject({ video_mode: 'premium', share_to_gallery: false });
    await vs().refreshJob(gen.id);
    const done = (await t.api.get(`/api/video-studio/jobs/${gen.id}`)).data;
    expect(done).toMatchObject({ status: 'completed', clips_count: 1 });
    expect(done.clips[0]).toMatchObject({ title: 'Skript 1', description: 'Frische Wände', hashtags: ['#handwerk', '#malerei'], duration: 23 });
  });

  it('reports jobs, clips and published clips', async () => {
    const sources = (t.app.services.reportSources as any[]).map((s) => s.key);
    expect(sources).toEqual(expect.arrayContaining(['video_jobs', 'video_clips', 'video_posts']));
    const r = await t.api.post('/api/reports/run', { source: 'video_jobs', measures: ['count'], group_by: ['status'], range: 'all' });
    expect(r.status).toBe(200);
    const byStatus = Object.fromEntries(r.data.rows.map((x: any) => [x.k[0], x.v[0]]));
    expect(byStatus.completed).toBeGreaterThanOrEqual(5);
    const p = await t.api.post('/api/reports/run', { source: 'video_posts', measures: ['count'], range: 'all' });
    expect(p.data.totals.v[0]).toBeGreaterThanOrEqual(3);
    expect(existsSync(join(t.app.config.dataDir, 'video-studio'))).toBe(true);
  });
});
