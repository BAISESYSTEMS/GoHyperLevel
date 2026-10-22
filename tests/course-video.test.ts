import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { fakeFfmpeg, fakeMp4, memberGet, memberJson, memberLogin, memberPost, urlsIn } from './creatordepth-helpers.js';
import { signMedia } from '../server/services/course-video.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
const ff = fakeFfmpeg();
const events: { type: string; data: any }[] = [];
let loc = '';
let course: any;
let lesson: any;
let lesson2: any;
let video: any;
let anna = '';
let ben = '';
let annaId = '';
let benId = '';

const settle = () => t.app.events.flush();
const jobs = () => t.app.services.courseVideoJobs.flush();
const putChunk = (id: string, offset: number, buf: Buffer) =>
  t.api.raw(`/api/courses/videos/${id}/upload?offset=${offset}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-pghl': '1', cookie: t.api.cookie, 'x-location-id': loc }, body: buf });
const lessonUrl = (l = lesson) => `/portal/${loc}/c/${course.slug}/${l.id}`;
const page = async (cookie: string, l = lesson) => {
  const r = await memberGet(t, lessonUrl(l), cookie);
  return { status: r.status, html: await r.text(), headers: r.headers };
};
const mediaUrl = (html: string, file: string) => urlsIn(html, new RegExp(`(?:src|poster)="([^"]*${file.replace('.', '\\.')}[^"]*)"`))[0];
const report = (cookie: string, body: Record<string, unknown>, headers: Record<string, string> = { 'x-course-player': '1' }, l = lesson) => memberJson(t, `${lessonUrl(l)}/playback`, body, cookie, headers);

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  t.app.services.courseMediaRun = ff.run;
  for (const type of ['lesson.completed', 'course.completed']) t.app.events.on(type, (e) => void events.push({ type, data: e.data }));
  course = (await t.api.post('/api/courses', { title: 'Video-Kurs' })).data;
  await t.api.patch(`/api/courses/${course.id}`, { status: 'published' });
  const mod = (await t.api.get(`/api/courses/${course.id}`)).data.modules[0];
  lesson = (await t.api.post(`/api/courses/${course.id}/lessons`, { module_id: mod.id, title: 'Mit Video' })).data;
  lesson2 = (await t.api.post(`/api/courses/${course.id}/lessons`, { module_id: mod.id, title: 'Ohne Video' })).data;
  annaId = (await t.api.post(`/api/courses/${course.id}/enrollments`, { email: 'anna@example.de', name: 'Anna' })).data.contact_id;
  benId = (await t.api.post(`/api/courses/${course.id}/enrollments`, { email: 'ben@example.de', name: 'Ben' })).data.contact_id;
  anna = await memberLogin(t, annaId);
  ben = await memberLogin(t, benId);
}, 60_000);
afterAll(() => t.close());

describe('upload', () => {
  it('reports what the server can do', async () => {
    const info = (await t.api.get('/api/courses/media/info')).data;
    expect(info).toMatchObject({ ffmpeg: true, stt: false, max_mb: 2048, chunk_size: 8 * 1024 * 1024 });
    ff.offline = true;
    expect((await t.api.get('/api/courses/media/info')).data.ffmpeg).toBe(false);
    ff.offline = false;
  });

  it('takes the file in parts, answers a repeated part, and says where to resume after a gap', async () => {
    const buf = fakeMp4(200);
    const start = await t.api.post('/api/courses/videos', { name: 'lektion-1.mp4', size: buf.length });
    expect(start.status).toBe(200);
    expect(start.data).toMatchObject({ chunk_size: 8 * 1024 * 1024, size: 200, received: 0 });
    const id = start.data.id;
    let r = await (await putChunk(id, 0, buf.subarray(0, 120))).json();
    expect(r).toMatchObject({ received: 120, complete: false });
    // the same part again (a retry after a timeout): same state, nothing appended
    r = await (await putChunk(id, 0, buf.subarray(0, 120))).json();
    expect(r).toMatchObject({ received: 120, complete: false });
    // a gap: 409 with the offset to resume at
    const gap = await putChunk(id, 150, buf.subarray(150));
    expect(gap.status).toBe(409);
    expect((await gap.json()).received).toBe(120);
    // more than announced
    expect((await putChunk(id, 120, Buffer.alloc(500))).status).toBe(400);
    r = await (await putChunk(id, 120, buf.subarray(120))).json();
    expect(r).toMatchObject({ received: 200, complete: true });
    await jobs();
    video = (await t.api.get(`/api/courses/videos/${id}`)).data;
    expect(video).toMatchObject({ status: 'complete', size: 200, has_poster: true });
    // ffmpeg's banner gave the duration, the poster frame came from ffmpeg
    expect(video.duration_sec).toBeCloseTo(754.6, 1);
    const stored = join(t.app.config.dataDir, 'course-videos');
    expect(existsSync(join(stored, `${id}.jpg`))).toBe(true);
    const list = (await t.api.get('/api/courses/videos')).data;
    expect(list.map((v: any) => v.id)).toContain(id);
  });

  it('refuses things that are not videos, too big or not allowed', async () => {
    expect((await t.api.post('/api/courses/videos', { name: 'virus.exe', size: 100 })).status).toBe(400);
    expect((await t.api.post('/api/courses/videos', { name: 'x.mp4', size: 0 })).status).toBe(400);
    const fake = await t.api.post('/api/courses/videos', { name: 'fake.mp4', size: 40 });
    const r = await putChunk(fake.data.id, 0, Buffer.from('<html><script>alert(1)</script></html>'));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/keine Videodatei/);
    expect((await t.api.get(`/api/courses/videos/${fake.data.id}`)).status).toBe(404);
    process.env.PGHL_COURSE_VIDEO_MB = '1';
    try {
      const big = await t.api.post('/api/courses/videos', { name: 'gross.mp4', size: 2 * 1024 * 1024 });
      expect(big.status).toBe(400);
      expect(big.data.error).toMatch(/PGHL_COURSE_VIDEO_MB/);
    } finally {
      delete process.env.PGHL_COURSE_VIDEO_MB;
    }
    // at most three unfinished uploads
    const open: string[] = [];
    for (let i = 0; i < 3; i++) open.push((await t.api.post('/api/courses/videos', { name: `o${i}.mp4`, size: 50 })).data.id);
    expect((await t.api.post('/api/courses/videos', { name: 'vier.mp4', size: 50 })).status).toBe(429);
    for (const id of open) await t.api.del(`/api/courses/videos/${id}`);
  });

  it('streams to the admin preview with ranges', async () => {
    const r = await t.api.raw(`/api/courses/videos/${video.id}/file?locationId=${loc}`, { headers: { cookie: t.api.cookie, range: 'bytes=0-9', 'x-pghl': '1' } });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe('bytes 0-9/200');
    expect((await r.arrayBuffer()).byteLength).toBe(10);
    expect((await t.api.raw(`/api/courses/videos/${video.id}/file?locationId=${loc}`)).status).toBe(401);
  });
});

describe('lesson and player', () => {
  it('attaches a video, chapters and the completion rule to a lesson', async () => {
    expect((await t.api.patch(`/api/courses/${course.id}/lessons/${lesson.id}`, { video_id: 'gibtsnicht' })).status).toBe(400);
    const r = await t.api.patch(`/api/courses/${course.id}/lessons/${lesson.id}`, { video_id: video.id, chapters: '0:00 Einstieg\n2:30 Hauptteil', complete_percent: 90 });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ video_id: video.id, complete_percent: 90, chapters: [{ t: 0, title: 'Einstieg' }, { t: 150, title: 'Hauptteil' }] });
    expect((await t.api.patch(`/api/courses/${course.id}/lessons/${lesson.id}`, { chapters: 'kein Zeitstempel' })).status).toBe(400);
    expect((await t.api.get(`/api/courses/videos/${video.id}`)).data.lessons.map((l: any) => l.id)).toEqual([lesson.id]);
    const full = (await t.api.get(`/api/courses/${course.id}`)).data;
    expect(full.modules[0].lessons.find((l: any) => l.id === lesson.id).chapters).toHaveLength(2);
  });

  it('renders the player with signed URLs, chapters and a script that the page may load', async () => {
    const p = await page(anna);
    expect(p.status).toBe(200);
    expect(p.html).toContain('class="cvp"');
    expect(p.html).toContain('data-t="150"');
    expect(p.html).toContain('<script src="/portal-course.js" defer></script>');
    expect(p.headers.get('content-security-policy')).toMatch(/script-src 'self'.*media-src 'self' https: blob:|media-src 'self' https: blob:.*|script-src 'self'/);
    expect(p.headers.get('content-security-policy')).toContain("script-src 'self'");
    const src = mediaUrl(p.html, 'video.mp4');
    expect(src).toMatch(new RegExp(`^/portal/${loc}/media/${video.id}/video\\.mp4\\?t=`));
    expect(mediaUrl(p.html, 'poster.jpg')).toContain('/poster.jpg?t=');
    // the script itself
    const js = await t.api.raw('/portal-course.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('javascript');
    const code = await js.text();
    expect(() => new Function(code)).not.toThrow();
    // a lesson without hosted video renders as before
    expect((await page(anna, lesson2)).html).not.toContain('class="cvp"');
  });

  it('streams only to the member the link was made for – with ranges, never to other sites', async () => {
    const p = await page(anna);
    const src = mediaUrl(p.html, 'video.mp4');
    const full = await memberGet(t, src, anna);
    expect(full.status).toBe(200);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(full.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await full.arrayBuffer()).subarray(4, 8).toString()).toBe('ftyp');
    const part = await memberGet(t, src, anna, { range: 'bytes=10-19', 'sec-fetch-site': 'same-origin' });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 10-19/200');
    expect((await part.arrayBuffer()).byteLength).toBe(10);
    expect((await memberGet(t, src, anna, { range: 'bytes=500-600' })).status).toBe(416);
    // no session, somebody else's session, a changed or an expired token, a foreign page
    expect((await memberGet(t, src, '')).status).toBe(401);
    expect((await memberGet(t, src, ben)).status).toBe(403);
    expect((await memberGet(t, src.replace(/t=./, 't=x'), anna)).status).toBe(403);
    const expired = signMedia(t.app, video.id, annaId, loc, -1000);
    expect((await memberGet(t, `/portal/${loc}/media/${video.id}/video.mp4?t=${encodeURIComponent(expired)}`, anna)).status).toBe(403);
    expect((await memberGet(t, src, anna, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await memberGet(t, src, anna, { referer: 'https://evil.example/seite' })).status).toBe(403);
    expect((await memberGet(t, src, anna, { referer: `http://${new URL(t.base).host}/portal/x` })).status).toBe(200);
    // a token for another video is no token for this one
    const other = signMedia(t.app, 'anderesvideo123', annaId, loc);
    expect((await memberGet(t, `/portal/${loc}/media/${video.id}/video.mp4?t=${encodeURIComponent(other)}`, anna)).status).toBe(403);
    expect((await memberGet(t, `/portal/${loc}/media/${video.id}/geheim.txt?t=${encodeURIComponent(signMedia(t.app, video.id, annaId, loc))}`, anna)).status).toBe(404);
    // the poster comes the same way
    const poster = await memberGet(t, mediaUrl(p.html, 'poster.jpg'), anna);
    expect(poster.status).toBe(200);
    expect(poster.headers.get('content-type')).toBe('image/jpeg');
  });

  it('keeps a link useless once the access is gone', async () => {
    const src = mediaUrl((await page(ben)).html, 'video.mp4');
    expect((await memberGet(t, src, ben)).status).toBe(200);
    await t.api.del(`/api/courses/${course.id}/enrollments/${benId}`);
    expect((await memberGet(t, src, ben)).status).toBe(404);
    await t.api.post(`/api/courses/${course.id}/enrollments`, { contact_id: benId });
    expect((await memberGet(t, src, ben)).status).toBe(200);
  });
});

describe('resume, speed and completion at X % watched', () => {
  it('stores position and speed and starts the player there next time', async () => {
    expect((await report(anna, { position: 120, duration: 754, watched: 5, speed: 1.5 })).status).toBe(200);
    const html = (await page(anna)).html;
    expect(html).toContain('&quot;resume&quot;:120');
    expect(html).toContain('&quot;speed&quot;:1.5');
    expect(html).toContain('<option value="1.5" selected>1,5×</option>');
    // another member starts at the beginning
    expect((await page(ben)).html).toContain('&quot;resume&quot;:0');
  });

  it('accepts reports only from our player, same origin, logged in', async () => {
    expect((await report(anna, { position: 1 }, {})).status).toBe(403);
    expect((await report(anna, { position: 1 }, { 'x-course-player': '1', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await report('', { position: 1 })).status).toBe(401);
    expect((await memberJson(t, `${lessonUrl(lesson2)}/playback`, { position: 1 }, anna, { 'x-course-player': '1' })).status).toBe(404);
  });

  it('does not let the lesson be ticked off by hand while "complete at 90 %" is on', async () => {
    const before = await memberPost(t, `${lessonUrl()}/complete`, { done: '1' }, anna);
    expect(before.status).toBe(303);
    expect(t.app.db.get('SELECT cp.completed_at FROM course_progress cp JOIN course_enrollments e ON e.id = cp.enrollment_id WHERE e.contact_id = ? AND cp.lesson_id = ?', annaId, lesson.id)?.completed_at ?? null).toBeNull();
    const html = (await page(anna)).html;
    expect(html).not.toContain('Als erledigt markieren');
    expect(html).toMatch(/Gesehen: \d+ % von 90 %/);
  });

  it('completes the lesson at 90 % – and not by a report that claims it all in a second', async () => {
    // "I watched everything" right away: only the allowance counts
    const quick = await (await report(anna, { position: 750, duration: 754, furthest: 750, watched: 754, speed: 1.5 })).json();
    expect(quick.completed).toBe(false);
    expect(quick.watched_percent).toBeLessThan(5);
    // later, an honest player has really played it: allowed by the clock
    t.app.db.run(`UPDATE course_playback SET updated_at = ? WHERE lesson_id = ?`, new Date(Date.now() - 3 * 3600_000).toISOString(), lesson.id);
    const half = await (await report(anna, { position: 400, duration: 754, furthest: 400, watched: 400 })).json();
    expect(half.completed).toBe(false);
    expect(half.watched_percent).toBe(53);
    t.app.db.run(`UPDATE course_playback SET updated_at = ? WHERE lesson_id = ?`, new Date(Date.now() - 3 * 3600_000).toISOString(), lesson.id);
    const done = await (await report(anna, { position: 750, duration: 754, furthest: 750, watched: 700 })).json();
    expect(done).toMatchObject({ ok: true, completed: true, watched_percent: 93 });
    await settle();
    expect(events.some((e) => e.type === 'lesson.completed' && e.data.lessonId === lesson.id && e.data.contactId === annaId)).toBe(true);
    const html = (await page(anna)).html;
    expect(html).toContain('✓ Erledigt');
    // the finished video starts from the beginning next time
    expect(html).toContain('&quot;resume&quot;:0');
  });
});

describe('captions', () => {
  const VTT = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nHallo zusammen\n';
  it('takes WebVTT and SRT, rejects garbage, and serves them to members', async () => {
    const r = await t.api.post(`/api/courses/videos/${video.id}/captions`, { lang: 'de', label: 'Deutsch', vtt: VTT });
    expect(r.status).toBe(200);
    expect(r.data.captions).toEqual([expect.objectContaining({ lang: 'de', label: 'Deutsch', source: 'upload' })]);
    const srt = await t.api.post(`/api/courses/videos/${video.id}/captions`, { lang: 'en', vtt: '1\n00:00:00,000 --> 00:00:02,000\nHello' });
    expect(srt.data.captions.map((c: any) => c.lang)).toEqual(['de', 'en']);
    expect(srt.data.captions[1].label).toBe('English');
    expect((await t.api.post(`/api/courses/videos/${video.id}/captions`, { lang: 'de', vtt: 'kein Untertitel' })).status).toBe(400);
    expect((await t.api.post(`/api/courses/videos/${video.id}/captions`, { lang: 'xx yy', vtt: VTT })).status).toBe(400);
    expect((await t.api.post(`/api/courses/videos/${video.id}/captions`, { lang: 'fr', vtt: `WEBVTT\n\n${'x'.repeat(600 * 1024)}` })).status).toBe(400);
    // replacing a language
    const again = await t.api.post(`/api/courses/videos/${video.id}/captions`, { lang: 'de', label: 'Deutsch (neu)', vtt: VTT });
    expect(again.data.captions.filter((c: any) => c.lang === 'de')).toHaveLength(1);
    const html = (await page(anna)).html;
    expect(html).toContain('<track kind="captions" srclang="de" label="Deutsch (neu)"');
    const vtt = await memberGet(t, mediaUrl(html, 'cap-de.vtt'), anna);
    expect(vtt.status).toBe(200);
    expect(vtt.headers.get('content-type')).toContain('text/vtt');
    expect(await vtt.text()).toContain('Hallo zusammen');
    expect((await memberGet(t, mediaUrl(html, 'cap-de.vtt').replace('cap-de', 'cap-it'), anna)).status).toBe(404);
    // admin can read a track and delete it
    const cid = again.data.captions.find((c: any) => c.lang === 'en').id;
    expect((await t.api.get(`/api/courses/videos/${video.id}/captions/${cid}`)).data).toContain('Hello');
    expect((await t.api.del(`/api/courses/videos/${video.id}/captions/${cid}`)).data.captions.map((c: any) => c.lang)).toEqual(['de']);
    expect((await t.api.del(`/api/courses/videos/${video.id}/captions/nope`)).status).toBe(404);
  });

  it('writes AI captions through the speech-to-text connection when there is one – and says what is missing when there is not', async () => {
    const none = await t.api.post(`/api/courses/videos/${video.id}/captions/ai`, { language: 'de' });
    expect(none.status).toBe(409);
    expect(none.data.error).toMatch(/KI-Anbieter/);
    t.app.services.genmediaFetch = async (url: string) => {
      if (url.endsWith('/audio/transcriptions')) return new Response(JSON.stringify({ text: 'Das ist der erste Teil. Und das der zweite.' }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('{}', { status: 404 });
    };
    expect((await t.api.post('/api/ai-connections', { provider: 'openai', api_key: 'sk-test-course-1234567890', capabilities: ['stt'], models: { stt: 'gpt-4o-transcribe' } })).status).toBe(200);
    expect((await t.api.get('/api/courses/media/info')).data.stt).toBe(true);
    ff.offline = true;
    const noFfmpeg = await t.api.post(`/api/courses/videos/${video.id}/captions/ai`, { language: 'de' });
    expect(noFfmpeg.status).toBe(409);
    expect(noFfmpeg.data.error).toMatch(/ffmpeg/);
    ff.offline = false;
    const started = await t.api.post(`/api/courses/videos/${video.id}/captions/ai`, { language: 'en' });
    expect(started.status).toBe(200);
    expect(started.data).toMatchObject({ started: true, ai_status: 'running' });
    await jobs();
    const d = (await t.api.get(`/api/courses/videos/${video.id}`)).data;
    expect(d.ai_status).toBe('done');
    const ai = d.captions.find((c: any) => c.source === 'ai');
    expect(ai).toMatchObject({ lang: 'en', label: 'English' });
    const vtt = await t.api.get(`/api/courses/videos/${video.id}/captions/${ai.id}`);
    // two audio pieces → cues in both minutes
    expect(vtt.data).toContain('Das ist der erste Teil.');
    expect(vtt.data).toMatch(/00:01:\d\d\.\d{3} -->/);
  });
});

describe('poster, HLS and other server work', () => {
  it('takes a poster from ffmpeg or from an upload, and says so without ffmpeg', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const up = await t.api.post(`/api/courses/videos/${video.id}/poster`, { data: png });
    expect(up.status).toBe(200);
    const get = await t.api.raw(`/api/courses/videos/${video.id}/poster?locationId=${loc}`, { headers: { cookie: t.api.cookie, 'x-pghl': '1' } });
    expect(get.headers.get('content-type')).toBe('image/png');
    expect((await t.api.post(`/api/courses/videos/${video.id}/poster`, { data: 'data:image/png;base64,AAAA' })).status).toBe(400);
    expect((await t.api.post(`/api/courses/videos/${video.id}/poster`, { data: 'data:image/svg+xml;base64,PHN2Zz4=' })).status).toBe(400);
    expect((await t.api.post(`/api/courses/videos/${video.id}/poster`, { at: 30 })).status).toBe(200);
    ff.offline = true;
    const no = await t.api.post(`/api/courses/videos/${video.id}/poster`, { at: 30 });
    expect(no.status).toBe(409);
    ff.offline = false;
  });

  it('serves the MP4 straight when ffmpeg is missing and builds HLS when it is there', async () => {
    ff.offline = true;
    const no = await t.api.post(`/api/courses/videos/${video.id}/hls`, {});
    expect(no.status).toBe(409);
    expect(no.data.error).toMatch(/MP4-Datei direkt/);
    ff.offline = false;
    expect((await memberGet(t, `/portal/${loc}/media/${video.id}/hls/master.m3u8?t=${encodeURIComponent(signMedia(t.app, video.id, annaId, loc))}`, anna)).status).toBe(404);
    const r = await t.api.post(`/api/courses/videos/${video.id}/hls`, {});
    expect(r.status).toBe(200);
    expect(r.data.hls).toBe('pending');
    await jobs();
    expect((await t.api.get(`/api/courses/videos/${video.id}`)).data.hls).toBe('ready');
    const html = (await page(anna)).html;
    expect(html).toContain('type="application/vnd.apple.mpegurl"');
    const master = mediaUrl(html, 'master.m3u8');
    const m = await memberGet(t, master, anna);
    expect(m.status).toBe(200);
    expect(m.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    const body = await m.text();
    expect(body).toMatch(/\nv0\.m3u8\?t=/);
    const variant = body.split('\n').find((l) => l.startsWith('v1.m3u8'))!;
    const v1 = await memberGet(t, `/portal/${loc}/media/${video.id}/hls/${variant}`, anna);
    expect(v1.status).toBe(200);
    const seg = (await v1.text()).split('\n').find((l) => l.endsWith('') && l.startsWith('v1_000.ts'))!;
    const ts = await memberGet(t, `/portal/${loc}/media/${video.id}/hls/${seg}`, anna);
    expect(ts.status).toBe(200);
    expect(ts.headers.get('content-type')).toBe('video/mp2t');
    // names that are not in the folder or try to leave it
    const tok = `?t=${encodeURIComponent(signMedia(t.app, video.id, annaId, loc))}`;
    expect((await memberGet(t, `/portal/${loc}/media/${video.id}/hls/..%2Fsecret.ts${tok}`, anna)).status).toBe(404);
    expect((await memberGet(t, `/portal/${loc}/media/${video.id}/hls/passwd${tok}`, anna)).status).toBe(404);
    expect((await memberGet(t, `/portal/${loc}/media/${video.id}/hls/v9.m3u8${tok}`, anna)).status).toBe(404);
  });

  it('removes the video, its files and the link in lessons', async () => {
    const dir = join(t.app.config.dataDir, 'course-videos');
    expect(existsSync(join(dir, video.id, 'hls'))).toBe(true);
    expect((await t.api.del(`/api/courses/videos/${video.id}`)).status).toBe(200);
    expect(existsSync(join(dir, video.id, 'hls'))).toBe(false);
    expect(existsSync(join(dir, `${video.id}.jpg`))).toBe(false);
    expect(existsSync(join(dir, video.id))).toBe(false);
    expect((await t.api.get(`/api/courses/videos/${video.id}`)).status).toBe(404);
    const l = (await t.api.get(`/api/courses/${course.id}`)).data.modules[0].lessons.find((x: any) => x.id === lesson.id);
    expect(l.video_id).toBeNull();
    expect((await t.api.del(`/api/courses/videos/${video.id}`)).status).toBe(404);
  });
});
