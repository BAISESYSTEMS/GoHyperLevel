import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { setPostizFetch } from '../server/services/postiz.js';
import { HttpError } from '../server/core/http.js';
import * as rc from '../server/services/video-recycle.js';

/**
 * Content-Recycling and Autopilot of the Video-Studio with everything external faked: OpenShorts
 * (app.services.openshortsFetch, incl. EDL transcript), the AI assistant (app.services.aiRun/aiReady),
 * Postiz behind the social planner (setPostizFetch) and the feeds (app.services.feedFetch). Blog,
 * campaigns, community and courses are the real modules, reached through their own routes.
 */

const osCalls: string[] = [];
const osJobs = new Map<string, { status: string; result: any }>();
let osN = 0;
const edlGone = new Set<string>();
const clipMeta = (jobId: string, i: number, score: number) => ({
  start: 30 * i,
  end: 30 * i + 25,
  predicted_score: score,
  why: `Grund ${i}`,
  viral_hook_text: `Hook ${i}`,
  video_title_for_youtube_short: `Clip ${i}`,
  video_description_for_instagram: `Beschreibung ${i} #tipp`,
  video_url: `/videos/${jobId}/clip_${i}.mp4`,
});
const WORDS = [
  { w: 'Hallo', s: 0.2, e: 0.5 },
  { w: 'und', s: 0.6, e: 0.7 },
  { w: 'willkommen', s: 0.8, e: 1.2 },
  { w: '.', s: 1.2, e: 1.2 },
  { w: 'Heute', s: 31, e: 31.4 },
  { w: 'geht', s: 31.5, e: 31.8 },
  { w: 'es', s: 31.9, e: 32 },
  { w: 'um', s: 32.1, e: 32.3 },
  { w: 'Wandfarbe', s: 32.4, e: 33 },
];
const osFake = async (input: string, init: any = {}): Promise<Response> => {
  const u = new URL(input);
  const path = u.pathname;
  osCalls.push(`${init.method ?? 'GET'} ${path}`);
  const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  if (path === '/health') return json({ status: 'ok' });
  if (path === '/api/config') return json({ youtubeUrlEnabled: true, billingEnabled: false, jobRetentionSeconds: 86400 });
  if (path === '/api/me') return json({ detail: 'Not Found' }, 404);
  if (path === '/openapi.json') return json({ paths: { '/api/process': {}, '/api/status/{job_id}': {}, '/api/uploads': {} } });
  if (path === '/api/translate/languages') return json({ languages: { de: 'German' } });
  if (path === '/api/process') {
    const id = `rjob-${String(++osN).padStart(4, '0')}`;
    osJobs.set(id, { status: 'queued', result: null });
    return json({ job_id: id, status: 'queued' });
  }
  if (path.startsWith('/api/status/')) {
    const j = osJobs.get(path.split('/').pop()!);
    return j ? json({ status: j.status, logs: [], result: j.result }) : json({ detail: 'Job not found' }, 404);
  }
  const edl = path.match(/^\/api\/clip\/([\w-]+)\/(\d+)\/edl$/);
  if (edl) return edlGone.has(edl[1]) ? json({ detail: 'gone' }, 404) : json({ words: WORDS, segments: [], title: 'x' });
  const tr = path.match(/^\/api\/clip\/([\w-]+)\/(\d+)\/transcript$/);
  if (tr) return json({ captions: [{ text: 'Nur', startMs: 0, endMs: 200 }, { text: 'Clipwörter', startMs: 200, endMs: 600 }], durationSec: 25, language: 'de' });
  if (path.startsWith('/videos/')) {
    const bytes = Buffer.from('CLIP-BYTES-0123456789abcdef');
    return new Response(bytes, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.length) } });
  }
  return json({ detail: 'Not Found' }, 404);
};

const postiz: { path: string; body: any }[] = [];
const postizFake = (async (input: any, init: any = {}) => {
  const path = new URL(String(input)).pathname.replace('/api/public/v1', '');
  const body = init.body ? JSON.parse(init.body) : undefined;
  postiz.push({ path, body });
  const json = (d: any) => new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } });
  if (path === '/is-connected') return json({ connected: true });
  if (path === '/integrations')
    return json([
      { id: 'int-li', name: 'Firma LI', identifier: 'linkedin', picture: '', disabled: false },
      { id: 'int-x', name: 'Firma X', identifier: 'x', picture: '', disabled: false },
      { id: 'int-ig', name: 'Firma IG', identifier: 'instagram', picture: '', disabled: false },
      { id: 'int-fb', name: 'Firma FB', identifier: 'facebook', picture: '', disabled: false },
      { id: 'int-yt', name: 'Firma YT', identifier: 'youtube', picture: '', disabled: false },
    ]);
  if (path === '/upload-from-url') return json({ id: 'm1', path: 'https://postiz.test/u/1.mp4' });
  if (path === '/posts') return json([{ postId: `p${postiz.length}` }]);
  return json({});
}) as any;

/** Answers like the AI with structured outputs – one shape per piece. */
const aiCalls: any[] = [];
let aiFail: HttpError | null = null;
const answer = (input: any) => {
  const props = Object.keys(input.schema?.properties ?? {});
  if (props.includes('markdown')) return { title: 'Wände richtig streichen', excerpt: 'Die wichtigsten Tipps aus dem Video.', markdown: 'Kurze Einleitung.\n\n## Vorbereitung\nAbkleben.\n\n## Streichen\nVon oben nach unten.', seo_title: 'Wände streichen – Tipps', seo_description: 'So gelingt es.', tags: ['Malerei', '#Tipps'] };
  if (props.includes('takeaways')) return { subject: 'Neues Video: Wände streichen', preheader: '3 Tipps', headline: 'Frische Wände', intro: 'Diese Woche zeigen wir, wie es geht.', takeaways: [{ title: 'Abkleben', text: 'Spart Zeit.' }, { title: 'Grundieren', text: 'Hält länger.' }, { title: 'Rollen', text: 'Gleichmäßig.' }], cta_label: 'Zum Video' };
  if (props.includes('tweets')) return { tweets: ['Hook: so streichst du Wände wie ein Profi', 'Tipp 1: abkleben', 'Tipp 2: grundieren', 'Ganzes Video im Profil'] };
  if (props.includes('caption')) return { caption: 'Wände streichen in 30 Sekunden', hashtags: ['malerei', '#diy', 'nicht-erlaubt!'] };
  if (props.includes('titles')) return { titles: Array.from({ length: 10 }, (_, i) => `Titel-Idee ${i + 1}`), intro: 'In diesem Video zeigen wir alles.', chapters: [{ time: '00:00', title: 'Intro' }, { time: '00:31', title: 'Wandfarbe' }, { time: 'kaputt', title: 'x' }], hashtags: ['malerei'] };
  if (props.includes('key_points')) return { title: 'Folge 12', summary: 'Es geht um Wandfarbe.', chapters: [{ time: '00:00', title: 'Start' }], key_points: ['Abkleben'], quotes: ['Hallo und willkommen.'] };
  if (props.includes('teaser')) return { title: 'Vorschau', teaser: 'In dieser Lektion lernst du streichen.' };
  if (props.includes('body')) return { title: 'Was ist euer bester Maler-Tipp?', body: 'Im Video zeigen wir drei Tipps. **Welcher ist eurer?**' };
  if (String(input.user).includes('LinkedIn')) return { text: 'Wände streichen ist kein Hexenwerk.\n\n#malerei' };
  return { text: 'Facebook: Frische Farbe für dein Zuhause!' };
};
const aiRun = async (input: any) => {
  aiCalls.push(input);
  if (aiFail) throw aiFail;
  return { text: '```json\n' + JSON.stringify(answer(input)) + '\n```', model: 'fake', usage: {}, ms: 1 };
};

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const vs = () => t.app.services.videoStudio;
const idle = async () => {
  await vs().idle();
  await vs().idle();
};
const pushes: any[] = [];
let realAiRun: any;
let realAiReady: any;

beforeAll(async () => {
  t = await startTestApp();
  t.app.services.openshortsFetch = osFake;
  setPostizFetch(postizFake);
  await t.setup();
  loc = t.api.location;
  await t.api.patch('/api/agency/video-studio', { url: 'http://openshorts:8000', max_active: 20 });
  await t.api.patch('/api/agency/social', { url: 'https://postiz.test', api_key: 'k' });
  for (const ch of ['int-li', 'int-x', 'int-ig', 'int-fb', 'int-yt']) await t.api.put(`/api/agency/social/channels/${ch}`, { location_id: loc });
  realAiRun = t.app.services.aiRun;
  realAiReady = t.app.services.aiReady;
  const realPush = t.app.services.pushNotify;
  t.app.services.pushNotify = (n: any) => (pushes.push(n), realPush?.(n));
});
afterAll(async () => {
  await t.close();
});

/** A finished job with three clips (scores 55, 91, 74). */
async function finishedJob(url = 'https://www.youtube.com/watch?v=abcdef123', title = 'Wände streichen') {
  const job = (await t.api.post('/api/video-studio/jobs', { url, title })).data;
  const osId = t.app.db.get('SELECT os_job_id FROM video_jobs WHERE id = ?', job.id)!.os_job_id;
  osJobs.set(osId, { status: 'completed', result: { clips: [clipMeta(osId, 1, 55), clipMeta(osId, 2, 91), clipMeta(osId, 3, 74)] } });
  await t.api.post(`/api/video-studio/jobs/${job.id}/refresh`);
  await idle();
  return (await t.api.get(`/api/video-studio/jobs/${job.id}`)).data;
}
const items = async (jobId: string) => (await t.api.get(`/api/video-studio/jobs/${jobId}/recycle?targets=0`)).data.items as any[];
const item = async (jobId: string, kind: string) => (await items(jobId)).find((i) => i.kind === kind);
const withBase = async <T>(base: string, fn: () => Promise<T>) => {
  const before = t.app.config.baseUrl;
  t.app.config.baseUrl = base;
  try {
    return await fn();
  } finally {
    t.app.config.baseUrl = before;
  }
};

describe('recycling helpers', () => {
  it('turns the word timeline into a transcript with time marks', () => {
    expect(rc.transcriptFromWords(WORDS)).toBe('[00:00] Hallo und willkommen.\n[00:31] Heute geht es um Wandfarbe');
    expect(rc.fmtTime(3725)).toBe('1:02:05');
    const long = rc.transcriptFromWords(Array.from({ length: 5000 }, (_, i) => ({ w: `wort${i}`, s: i })), 30, 2000);
    expect(long.length).toBeLessThan(2100);
    expect(long).toContain('[…]');
  });

  it('cleans AI output and user edits per piece', () => {
    expect(rc.parseJsonAnswer('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => rc.parseJsonAnswer('nope')).toThrow(/JSON/);
    expect(rc.cleanContent('instagram', { caption: ' Hi ', hashtags: ['malerei', '#diy', 'kaputt!', 'diy'] })).toEqual({ caption: 'Hi', hashtags: ['#malerei', '#diy'] });
    expect(rc.cleanContent('x_thread', { tweets: ['a'.repeat(400), '', 'b'] }).tweets.map((x: string) => x.length)).toEqual([280, 1]);
    expect(rc.cleanContent('youtube', { titles: ['T'], chapters: [{ time: '0:00', title: 'A' }, { time: 'x', title: 'B' }] }).chapters).toEqual([{ time: '0:00', title: 'A' }]);
    expect(() => rc.assertUsable('blog', rc.cleanContent('blog', { title: 'x' }))).toThrow(/Text fehlt/);
    expect(rc.youtubeDescription({ intro: 'Intro', chapters: [{ time: '00:00', title: 'Start' }], hashtags: ['#a'] })).toBe('Intro\n\nKapitel:\n00:00 Start\n\n#a');
  });

  it('embeds the video after the introduction and builds a sendable newsletter', () => {
    expect(rc.blogMarkdown({ markdown: 'Intro.\n\n## A\nText' }, 'https://youtu.be/x')).toBe('Intro.\n\nhttps://youtu.be/x\n\n## A\nText');
    expect(rc.blogMarkdown({ markdown: '## A\nText' }, 'https://v/1.mp4')).toBe('https://v/1.mp4\n\n## A\nText');
    expect(rc.youtubeId('https://www.youtube.com/watch?v=abcdef123&t=4')).toBe('abcdef123');
    const d = rc.newsletterDesign(rc.cleanContent('newsletter', answer({ schema: { properties: { takeaways: 1 } } })), {
      videoUrl: 'https://youtu.be/abcdef123',
      videoThumb: 'https://i.ytimg.com/vi/abcdef123/hqdefault.jpg',
      clips: [{ title: 'Clip 1', url: 'https://gh/c1.mp4', thumb: 'https://gh/t1.jpg' }, { title: 'Clip 2', url: 'https://gh/c2.mp4', thumb: 'https://gh/t2.jpg' }],
      ctaUrl: 'https://youtu.be/abcdef123',
    });
    const blocks = d.sections.flatMap((s) => s.columns.flatMap((c) => c.blocks));
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'text', 'video', 'heading', 'text', 'heading', 'image', 'text', 'image', 'text', 'button', 'footer']);
    expect(d.settings.preheader).toBe('3 Tipps');
    expect(blocks[1].props.text).toContain('{{contact.first_name|du}}');
  });

  it('reads YouTube and podcast feeds and finds posting slots', () => {
    expect(rc.youtubeFeedUrl('UCabcdefghijklmnopqrstuv')).toBe('https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv');
    expect(rc.youtubeFeedUrl('https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv/videos')).toContain('channel_id=UCabcdefghijklmnopqrstuv');
    expect(rc.youtubeFeedUrl('https://www.youtube.com/@malerei')).toBeNull();
    expect(rc.youtubeFeedUrl('https://evil.example/channel/UCabcdefghijklmnopqrstuv')).toBeNull();
    const yt = rc.parseYouTubeFeed(ytFeed(['vid0000001', 'vid0000002']));
    expect(yt).toEqual([
      { id: 'vid0000001', title: 'Video vid0000001 &', url: 'https://www.youtube.com/watch?v=vid0000001', published: '2026-10-01T10:00:00+00:00', media: 'video' },
      { id: 'vid0000002', title: 'Video vid0000002 &', url: 'https://www.youtube.com/watch?v=vid0000002', published: '2026-10-01T10:00:00+00:00', media: 'video' },
    ]);
    const pod = rc.parsePodcastFeed(`<rss><channel>
      <item><title>Folge 1</title><guid>g1</guid><enclosure url="https://cdn.test/f1.mp3" type="audio/mpeg"/></item>
      <item><title><![CDATA[Folge 2]]></title><guid>g2</guid><enclosure url="https://cdn.test/f2.mp4" type="video/mp4"/></item>
      <item><title>Folge 3</title><link>https://youtu.be/abcdef123</link></item>
    </channel></rss>`);
    expect(pod.map((p) => [p.id, p.media, p.url])).toEqual([
      ['g1', 'audio', 'https://cdn.test/f1.mp3'],
      ['g2', 'video', 'https://cdn.test/f2.mp4'],
      ['https://youtu.be/abcdef123', 'video', 'https://youtu.be/abcdef123'],
    ]);
    // Friday 2026-10-02 12:00 Berlin → Fri 18:00, Mon 10:00, Mon 18:00 (no weekend).
    const slots = rc.nextSlots(3, { times: ['18:00', '10:00'], days: ['mon', 'tue', 'wed', 'thu', 'fri'], tz: 'Europe/Berlin', after: new Date('2026-10-02T10:00:00Z') });
    expect(slots.map((d) => d.toISOString())).toEqual(['2026-10-02T16:00:00.000Z', '2026-10-05T08:00:00.000Z', '2026-10-05T16:00:00.000Z']);
  });
});

function ytFeed(ids: string[]) {
  return `<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">${ids
    .map((id) => `<entry><id>yt:video:${id}</id><yt:videoId>${id}</yt:videoId><title>Video ${id} &amp;</title><link rel="alternate" href="https://www.youtube.com/watch?v=${id}"/><published>2026-10-01T10:00:00+00:00</published></entry>`)
    .join('')}</feed>`;
}

describe('content recycling', () => {
  let job: any;

  it('explains what is missing while the AI assistant is not set up', async () => {
    job = await finishedJob();
    const r = (await t.api.get(`/api/video-studio/jobs/${job.id}/recycle`)).data;
    expect(typeof r.ai).toBe('string');
    expect(r.youtube).toBe(true);
    expect(r.kinds.find((k: any) => k.key === 'community')).toMatchObject({ available: false, reason: 'Keine Community-Gruppe' });
    expect(r.kinds.find((k: any) => k.key === 'lesson')).toMatchObject({ available: false, reason: 'Keine Kurs-Lektionen' });
    expect(r.targets.channels.map((c: any) => c.id)).toEqual(['int-li', 'int-x', 'int-ig', 'int-fb', 'int-yt']);
    const start = await t.api.post(`/api/video-studio/jobs/${job.id}/recycle`, {});
    expect(start.status).toBe(409);
    expect(start.data.error).toMatch(/KI-Assistent/);
    // Only finished jobs.
    const running = (await t.api.post('/api/video-studio/jobs', { url: 'https://youtu.be/laeuft', title: 'Läuft' })).data;
    t.app.services.aiRun = aiRun;
    t.app.services.aiReady = () => null;
    expect((await t.api.post(`/api/video-studio/jobs/${running.id}/recycle`, {})).data.error).toMatch(/fertig/);
  });

  it('writes every piece from the OpenShorts transcript in the background', async () => {
    const r = await t.api.post(`/api/video-studio/jobs/${job.id}/recycle`, { language: 'de' });
    expect(r.status).toBe(200);
    expect(r.data.items.map((i: any) => i.kind).sort()).toEqual(['blog', 'facebook', 'instagram', 'linkedin', 'newsletter', 'shownotes', 'x_thread', 'youtube']);
    expect(r.data.items.every((i: any) => i.status === 'generating')).toBe(true);
    await idle();
    const list = await items(job.id);
    expect(list.every((i) => i.status === 'ready')).toBe(true);
    expect(aiCalls).toHaveLength(8);
    const first = aiCalls[0];
    expect(first).toMatchObject({ locationId: loc, purpose: 'video_recycle', timeoutMs: 180_000 });
    expect(first.system[1].cache).toBe(true);
    expect(first.system[1].text).toContain('[00:31] Heute geht es um Wandfarbe');
    expect(first.system[1].text).toContain('Clip 2 (Viralität 91/100)');
    expect(first.system[0].text).toContain('auf Deutsch');
    // The transcript is fetched once (EDL of the first clip) and kept.
    expect(osCalls.filter((c) => c.endsWith('/edl'))).toHaveLength(1);
    expect(t.app.db.get('SELECT text FROM video_transcripts WHERE job_id = ?', job.id)!.text).toMatch(/^\[00:00\] Hallo/);
    const insta = list.find((i) => i.kind === 'instagram');
    expect(insta.content).toEqual({ caption: 'Wände streichen in 30 Sekunden', hashtags: ['#malerei', '#diy'] });
    expect(insta.text).toBe('Wände streichen in 30 Sekunden\n\n#malerei #diy');
    expect(list.find((i) => i.kind === 'youtube').content.chapters).toHaveLength(2);
    // Starting again while done only regenerates what is asked for.
    aiCalls.length = 0;
    await t.api.post(`/api/video-studio/jobs/${job.id}/recycle`, { kinds: ['facebook', 'bogus'] });
    await idle();
    expect(aiCalls).toHaveLength(1);
  });

  it('falls back to the clip transcripts when the source transcript is gone', async () => {
    const j = await finishedJob('https://example.com/talk.mp4', 'Ohne EDL');
    edlGone.add(t.app.db.get('SELECT os_job_id FROM video_jobs WHERE id = ?', j.id)!.os_job_id);
    aiCalls.length = 0;
    await t.api.post(`/api/video-studio/jobs/${j.id}/recycle`, { kinds: ['linkedin'] });
    await idle();
    expect(aiCalls[0].system[1].text).toContain('[00:30] Nur Clipwörter');
    expect((await t.api.get(`/api/video-studio/jobs/${j.id}/recycle`)).data.youtube).toBe(false);
  });

  it('edits, then takes over blog, newsletter, social drafts and YouTube description – only on click', async () => {
    expect(postiz.filter((p) => p.path === '/posts')).toHaveLength(0);
    expect(t.app.db.get('SELECT COUNT(*) n FROM blog_posts')!.n).toBe(0);
    const site = (await t.api.post('/api/funnels', { name: 'Website', kind: 'website' })).data;

    // Blog: edit, then a draft in the chosen website with the YouTube video after the introduction.
    const blog = await item(job.id, 'blog');
    const edited = await t.api.patch(`/api/video-studio/recycle/${blog.id}`, { content: { title: 'Wände streichen wie ein Profi' } });
    expect(edited.data).toMatchObject({ edited: 1, content: { title: 'Wände streichen wie ein Profi', excerpt: 'Die wichtigsten Tipps aus dem Video.' } });
    expect((await t.api.post(`/api/video-studio/recycle/${blog.id}/apply`, {})).data.error).toMatch(/Website/);
    const applied = await t.api.post(`/api/video-studio/recycle/${blog.id}/apply`, { funnel_id: site.id });
    expect(applied.status).toBe(200);
    expect(applied.data).toMatchObject({ status: 'applied', applied_label: 'Blog-Entwurf', applied_url: `funnels/${site.id}?tab=blog` });
    const post = t.app.db.get('SELECT * FROM blog_posts WHERE id = ?', applied.data.applied_ref)!;
    expect(post).toMatchObject({ status: 'draft', title: 'Wände streichen wie ein Profi', author: 'Chef', cover_image: 'https://i.ytimg.com/vi/abcdef123/hqdefault.jpg' });
    expect(post.content).toBe('Kurze Einleitung.\n\nhttps://www.youtube.com/watch?v=abcdef123\n\n## Vorbereitung\nAbkleben.\n\n## Streichen\nVon oben nach unten.');
    expect(JSON.parse(post.seo)).toMatchObject({ title: 'Wände streichen – Tipps', description: 'So gelingt es.' });
    expect(JSON.parse(post.tags)).toEqual(['Malerei', 'Tipps']);

    // Newsletter: campaign draft with video, takeaways, the clips as permanent HyperLevel links and a footer.
    const nl = await item(job.id, 'newsletter');
    const camp = (await t.api.post(`/api/video-studio/recycle/${nl.id}/apply`, {})).data;
    expect(camp).toMatchObject({ status: 'applied', applied_label: 'Kampagnen-Entwurf' });
    const c = t.app.db.get('SELECT * FROM campaigns WHERE id = ?', camp.applied_ref)!;
    expect(c).toMatchObject({ status: 'draft', subject: 'Neues Video: Wände streichen', channel: 'email' });
    const design = JSON.parse(c.design);
    const blocks = design.sections.flatMap((s: any) => s.columns.flatMap((col: any) => col.blocks));
    expect(blocks.find((b: any) => b.type === 'video').props).toMatchObject({ url: 'https://www.youtube.com/watch?v=abcdef123', thumbnail: 'https://i.ytimg.com/vi/abcdef123/hqdefault.jpg' });
    expect(blocks.some((b: any) => b.type === 'footer')).toBe(true);
    const clipLink = JSON.stringify(design).match(/http:\/\/localhost\/hooks\/openshorts\/clip\/[\w.-]+\.mp4/)![0];
    const served = await t.api.raw(clipLink.replace('http://localhost', ''));
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('video/mp4');
    expect(await served.text()).toBe('CLIP-BYTES-0123456789abcdef');
    const part = await t.api.raw(clipLink.replace('http://localhost', ''), { headers: { range: 'bytes=0-3' } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe('CLIP');
    expect((await t.api.raw(clipLink.replace('http://localhost', '').replace(/\.([\w-]{24})\./, '.AAAAAAAAAAAAAAAAAAAAAAAA.'))).status).toBe(404);
    // A copy on HyperLevel's disk: still there after OpenShorts deleted the job.
    const videoCalls = osCalls.filter((x) => x.startsWith('GET /videos/')).length;
    await t.api.raw(clipLink.replace('http://localhost', ''));
    expect(osCalls.filter((x) => x.startsWith('GET /videos/')).length).toBe(videoCalls);

    // X thread: a Postiz draft with the follow-ups as replies; a channel of the wrong platform is refused.
    const x = await item(job.id, 'x_thread');
    expect((await t.api.post(`/api/video-studio/recycle/${x.id}/apply`, { integration_ids: ['int-li'] })).data.error).toMatch(/passenden Kanal/);
    expect((await t.api.post(`/api/video-studio/recycle/${x.id}/apply`, { integration_ids: ['int-x'] })).data).toMatchObject({ status: 'applied', applied_label: 'Entwurf im Social Planner' });
    const thread = postiz.filter((p) => p.path === '/posts' && p.body).pop()!.body;
    expect(thread.type).toBe('draft');
    expect(thread.posts[0].integration).toEqual({ id: 'int-x' });
    expect(thread.posts[0].value.map((v: any) => v.content)).toEqual(['Hook: so streichst du Wände wie ein Profi', 'Tipp 1: abkleben', 'Tipp 2: grundieren', 'Ganzes Video im Profil']);
    expect(t.app.db.get(`SELECT * FROM social_posts WHERE source = 'Video-Recycling'`)).toMatchObject({ type: 'draft' });

    // LinkedIn text post.
    const li = await item(job.id, 'linkedin');
    await t.api.post(`/api/video-studio/recycle/${li.id}/apply`, { integration_ids: ['int-li', 'int-x'] });
    const liPost = postiz.filter((p) => p.path === '/posts' && p.body).pop()!.body;
    expect(liPost.posts.map((p: any) => p.integration.id)).toEqual(['int-li']);
    expect(liPost.posts[0].value[0].content).toContain('kein Hexenwerk');

    // Instagram carries the best clip as video – needs HyperLevel reachable by https for Postiz.
    const ig = await item(job.id, 'instagram');
    expect((await t.api.post(`/api/video-studio/recycle/${ig.id}/apply`, { integration_ids: ['int-ig'] })).data.error).toMatch(/https/);
    await withBase('https://gh.example.com', async () => {
      expect((await t.api.post(`/api/video-studio/recycle/${ig.id}/apply`, { integration_ids: ['int-ig'] })).status).toBe(200);
    });
    expect(postiz.filter((p) => p.path === '/upload-from-url').pop()!.body.url).toMatch(/^https:\/\/gh\.example\.com\/hooks\/openshorts\/media\/.+\.mp4$/);
    const igPost = postiz.filter((p) => p.path === '/posts' && p.body).pop()!.body;
    expect(igPost.posts[0].value[0]).toMatchObject({ content: 'Wände streichen in 30 Sekunden\n\n#malerei #diy', image: [{ id: 'm1' }] });

    // YouTube: description with chapters + 10 titles land in the YouTube-Studio tab.
    const yt = await item(job.id, 'youtube');
    const ytApplied = (await t.api.post(`/api/video-studio/recycle/${yt.id}/apply`, {})).data;
    expect(ytApplied.applied_label).toBe('Im YouTube-Studio');
    const task = (await t.api.get(`/api/video-studio/tasks/${ytApplied.applied_ref}`)).data;
    expect(task).toMatchObject({ kind: 'youtube', status: 'ready', refinable: false });
    expect(task.result.titles).toHaveLength(10);
    expect(task.result.description).toBe('In diesem Video zeigen wir alles.\n\nKapitel:\n00:00 Intro\n00:31 Wandfarbe\n\n#malerei');

    // Show notes become a project document (needs an https address of HyperLevel).
    const sn = await item(job.id, 'shownotes');
    expect((await t.api.post(`/api/video-studio/recycle/${sn.id}/apply`, {})).data.error).toMatch(/https/);
    await withBase('https://gh.example.com', async () => {
      expect((await t.api.post(`/api/video-studio/recycle/${sn.id}/apply`, {})).data.applied_label).toBe('Als Dokument im Projekt');
    });
    expect(t.app.db.get(`SELECT * FROM docs WHERE title = 'Shownotes: Folge 12'`)).toMatchObject({ location_id: loc, source: 'Video-Recycling' });

    // Facebook stays a suggestion until someone clicks.
    expect((await item(job.id, 'facebook')).status).toBe('ready');
  });

  it('posts to the community and puts the best clip into a course lesson', async () => {
    const group = (await t.api.post('/api/community/groups', { name: 'Maler-Community' })).data;
    const course = (await t.api.post('/api/courses', { title: 'Streichkurs' })).data;
    const mod = (await t.api.post(`/api/courses/${course.id}/modules`, { title: 'Grundlagen' })).data;
    const lesson = (await t.api.post(`/api/courses/${course.id}/lessons`, { module_id: mod.id, title: 'Werkzeug', body: 'Was du brauchst.' })).data;
    const r = (await t.api.get(`/api/video-studio/jobs/${job.id}/recycle`)).data;
    expect(r.targets.groups).toEqual([{ id: group.id, name: 'Maler-Community' }]);
    expect(r.targets.courses).toEqual([{ id: course.id, title: 'Streichkurs', lessons: expect.arrayContaining([{ id: lesson.id, title: 'Grundlagen · Werkzeug' }]) }]);
    expect(r.targets.funnels.map((f: any) => f.name)).toEqual(['Website']);
    await t.api.post(`/api/video-studio/jobs/${job.id}/recycle`, { kinds: ['community', 'lesson'] });
    await idle();

    const com = await item(job.id, 'community');
    expect((await t.api.post(`/api/video-studio/recycle/${com.id}/apply`, {})).data.error).toMatch(/Gruppe/);
    const posted = (await t.api.post(`/api/video-studio/recycle/${com.id}/apply`, { group_id: group.id })).data;
    expect(posted.applied_label).toBe('In der Community veröffentlicht');
    expect(t.app.db.get('SELECT * FROM community_posts WHERE id = ?', posted.applied_ref)).toMatchObject({ title: 'Was ist euer bester Maler-Tipp?' });

    const les = await item(job.id, 'lesson');
    const att = (await t.api.post(`/api/video-studio/recycle/${les.id}/apply`, { course_id: course.id, lesson_id: lesson.id })).data;
    expect(att.applied_label).toBe('Clip als Lektionsvideo');
    const after = t.app.db.get('SELECT * FROM course_lessons WHERE id = ?', lesson.id)!;
    expect(after.video_url).toMatch(/\/hooks\/openshorts\/clip\/.+\.mp4$/);
    expect(after.body).toBe('**Vorschau** – In dieser Lektion lernst du streichen.\n\n---\n\nWas du brauchst.');
    // Applying twice does not add the clip again.
    expect((await t.api.post(`/api/video-studio/recycle/${les.id}/apply`, { course_id: course.id, lesson_id: lesson.id })).data.applied_label).toBe('Schon in der Lektion');
  });

  it('stores clip thumbnails captured in the browser and serves them signed', async () => {
    const clip = job.clips[0];
    expect((await t.api.post(`/api/video-studio/clips/${clip.id}/thumb`, { data: 'data:image/png;base64,AAAA' })).status).toBe(400);
    const fakeJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(800, 1)]);
    expect((await t.api.post(`/api/video-studio/clips/${clip.id}/thumb`, { data: `data:image/jpeg;base64,${Buffer.alloc(800, 1).toString('base64')}` })).data.error).toMatch(/JPEG/);
    const r = await t.api.post(`/api/video-studio/clips/${clip.id}/thumb`, { data: `data:image/jpeg;base64,${fakeJpeg.toString('base64')}` });
    expect(r.data.thumb_url).toMatch(new RegExp(`^http://localhost/hooks/openshorts/thumb/${clip.id}\\.[\\w-]{24}\\.jpg$`));
    const img = await t.api.raw(r.data.thumb_url.replace('http://localhost', ''));
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/jpeg');
    expect((await t.api.get(`/api/video-studio/jobs/${job.id}`)).data.clips.find((c: any) => c.id === clip.id).thumb_url).toBe(r.data.thumb_url);
    expect((await t.api.raw(`/hooks/openshorts/thumb/${clip.id}.AAAAAAAAAAAAAAAAAAAAAAAA.jpg`)).status).toBe(404);
  });

  it('stops after the first AI limit error and keeps sub-accounts apart', async () => {
    aiFail = new HttpError(409, 'Das KI-Monatslimit dieses Sub-Accounts ist erreicht.');
    aiCalls.length = 0;
    await t.api.post(`/api/video-studio/jobs/${job.id}/recycle`, { kinds: ['facebook', 'linkedin', 'blog'] });
    await idle();
    expect(aiCalls).toHaveLength(1);
    const list = await items(job.id);
    for (const k of ['facebook', 'linkedin', 'blog']) expect(list.find((i) => i.kind === k)).toMatchObject({ status: 'failed', error: 'Das KI-Monatslimit dieses Sub-Accounts ist erreicht.' });
    aiFail = null;
    // A failed piece can still be filled in by hand.
    const fb = list.find((i) => i.kind === 'facebook');
    expect((await t.api.patch(`/api/video-studio/recycle/${fb.id}`, { content: { text: 'Selbst geschrieben' } })).data).toMatchObject({ status: 'ready', text: 'Selbst geschrieben' });

    const other = (await t.api.post('/api/locations', { name: 'Andere Firma' })).data;
    const h = { 'x-location-id': other.id };
    expect((await t.api.get(`/api/video-studio/jobs/${job.id}/recycle`, h)).status).toBe(404);
    expect((await t.api.post(`/api/video-studio/recycle/${fb.id}/apply`, {}, h)).status).toBe(404);
    expect((await t.api.del(`/api/video-studio/recycle/${fb.id}`)).data).toEqual({ ok: true });

    // Members need the social planner right (the whole Video-Studio is part of it).
    await t.api.post('/api/users', { email: 'crm@example.com', password: 'geheim123', name: 'CRM', locations: [loc], permissions: ['contacts'] });
    await t.api.post('/api/auth/login', { email: 'crm@example.com', password: 'geheim123' });
    try {
      expect((await t.api.get(`/api/video-studio/jobs/${job.id}/recycle`)).status).toBe(403);
      expect((await t.api.get('/api/video-studio/autopilot')).status).toBe(403);
    } finally {
      await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123' });
    }
  });
});

describe('workflows, MCP and reports', () => {
  it('adds the workflow action "Video recyceln" (finished job or new link)', async () => {
    expect((await t.api.get('/api/workflows/meta')).data.steps).toContain('video_recycle');
    const job = await finishedJob('https://youtu.be/wf0000001', 'Workflow-Video');
    aiCalls.length = 0;
    const msg = await t.app.services.workflowActions.video_recycle({ location_id: loc, contact_id: null }, { kinds: ['linkedin', 'facebook'] }, { event: { jobId: job.id } });
    expect(msg).toMatch(/Recycling gestartet \(2 Inhalte/);
    await idle();
    expect((await items(job.id)).map((i) => [i.kind, i.status, i.origin])).toEqual(expect.arrayContaining([['linkedin', 'ready', 'Workflow'], ['facebook', 'ready', 'Workflow']]));

    // With a link: shorts first, the recycling starts by itself once they are done.
    const msg2 = await t.app.services.workflowActions.video_recycle({ location_id: loc, contact_id: null }, { job_id: '', url: '{{contact.custom.video}}', kinds: ['x_thread'] }, { contact: { custom: { video: 'https://youtu.be/wf0000002' } } });
    expect(msg2).toMatch(/Recycling folgt/);
    const j2 = t.app.db.get(`SELECT * FROM video_jobs WHERE source_url = 'https://youtu.be/wf0000002'`)!;
    expect(j2.origin).toBe('Workflow');
    osJobs.set(j2.os_job_id, { status: 'completed', result: { clips: [clipMeta(j2.os_job_id, 1, 80)] } });
    await t.api.post(`/api/video-studio/jobs/${j2.id}/refresh`);
    await idle();
    expect((await items(j2.id)).map((i) => [i.kind, i.status])).toEqual([['x_thread', 'ready']]);
    await expect(t.app.services.workflowActions.video_recycle({ location_id: loc }, { job_id: 'nope' }, {})).rejects.toThrow(/kein Video-Link/);
  });

  it('offers the MCP tool ghl_recycle_video', async () => {
    const key = (await t.api.post('/api/agency/api-keys', { name: 'Claude', scope: 'write' })).data.key;
    const rpc = async (method: string, params: any = {}) => {
      const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const out = await r.json();
      return out.result ?? { isError: true, content: [{ text: out.error?.message }] };
    };
    expect((await rpc('tools/list')).tools.map((x: any) => x.name)).toContain('ghl_recycle_video');
    const call = async (args: any) => {
      const r = await rpc('tools/call', { name: 'ghl_recycle_video', arguments: args });
      return r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text);
    };
    const job = await finishedJob('https://youtu.be/mcp000001', 'MCP-Video');
    const started = await call({ location_id: loc, job_id: job.id, kinds: ['facebook'] });
    expect(started.started).toEqual([expect.objectContaining({ kind: 'facebook', status: 'generating' })]);
    await idle();
    const list = await call({ location_id: loc, job_id: job.id, list: true });
    expect(list).toEqual([expect.objectContaining({ kind: 'facebook', status: 'ready', text: 'Facebook: Frische Farbe für dein Zuhause!' })]);
    expect(t.app.db.get('SELECT origin FROM video_recycle WHERE job_id = ?', job.id)!.origin).toBe('MCP');
    const fromUrl = await call({ location_id: loc, url: 'https://youtu.be/mcp000002', kinds: ['blog'] });
    expect(fromUrl).toMatchObject({ status: 'queued', kinds: ['blog'] });
    expect((await call({ location_id: loc })).error).toMatch(/job_id oder url/);
  });

  it('reports recycled pieces', async () => {
    expect((t.app.services.reportSources as any[]).map((s) => s.key)).toContain('video_recycle');
    const r = await t.api.post('/api/reports/run', { source: 'video_recycle', measures: ['count', 'calc:apply_rate'], group_by: ['kind'], range: 'all' });
    expect(r.status).toBe(200);
    const byKind = Object.fromEntries(r.data.rows.map((x: any) => [x.k[0], x.v]));
    expect(byKind.blog[0]).toBeGreaterThanOrEqual(1);
    expect(byKind.youtube[1]).toBe(100);
  });
});

describe('autopilot', () => {
  const feeds = new Map<string, string>();
  beforeAll(() => {
    t.app.services.feedFetch = async (url: string) => {
      const xml = feeds.get(url);
      return { ok: !!xml, status: xml ? 200 : 404, headers: {}, text: async () => xml ?? '' };
    };
  });
  const CH = 'UCmalerei0000000000000000'.slice(0, 24);
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${CH}`;

  it('validates the settings', async () => {
    const empty = (await t.api.get('/api/video-studio/autopilot')).data;
    expect(empty.settings).toMatchObject({ enabled: false, mode: 'approve', top_n: 3, times: ['10:00'] });
    expect((await t.api.put('/api/video-studio/autopilot', { enabled: true })).data.error).toMatch(/Quelle/);
    expect((await t.api.put('/api/video-studio/autopilot', { feeds: [{ type: 'youtube', url: 'https://www.youtube.com/@malerei' }] })).data.error).toMatch(/Kanal-ID/);
    expect((await t.api.put('/api/video-studio/autopilot', { feeds: [{ type: 'podcast', url: 'http://feed.test/rss' }] })).data.error).toMatch(/https/);
    expect((await t.api.put('/api/video-studio/autopilot', { times: ['25:00'] })).data.error).toMatch(/HH:MM/);
    expect((await t.api.post('/api/video-studio/autopilot/check')).data.error).toMatch(/aus/);
  });

  it('starts a job for every new video, plans the best clips as drafts and recycles them', async () => {
    feeds.set(feedUrl, ytFeed(['ap00000001', 'ap00000002']));
    const saved = await t.api.put('/api/video-studio/autopilot', {
      enabled: true,
      feeds: [{ type: 'youtube', url: CH, label: 'Malerei-Kanal' }],
      top_n: 2,
      times: ['09:00', '17:30'],
      days: ['mon', 'wed', 'fri'],
      integration_ids: ['int-yt', 'int-li', 'int-x'],
      recycle: ['linkedin', 'x_thread', 'youtube'],
      options: { clips: 4 },
    });
    expect(saved.status).toBe(200);
    expect(saved.data.settings.feeds[0]).toMatchObject({ type: 'youtube', url: feedUrl, label: 'Malerei-Kanal' });
    // First look only remembers what is already there.
    const jobsBefore = t.app.db.get('SELECT COUNT(*) n FROM video_jobs')!.n;
    let st = (await t.api.post('/api/video-studio/autopilot/check')).data.state;
    expect(st.log[0].text).toMatch(/2 vorhandene Videos gemerkt/);
    expect(t.app.db.get('SELECT COUNT(*) n FROM video_jobs')!.n).toBe(jobsBefore);

    // A new upload → a shorts job with the autopilot's options.
    feeds.set(feedUrl, ytFeed(['ap00000003', 'ap00000001', 'ap00000002']));
    st = (await t.api.post('/api/video-studio/autopilot/check')).data.state;
    expect(st.log[0].text).toMatch(/neues Video „Video ap00000003 &“/);
    const job = t.app.db.get(`SELECT * FROM video_jobs WHERE source_url = 'https://www.youtube.com/watch?v=ap00000003'`)!;
    expect(job).toMatchObject({ origin: 'Autopilot', status: 'queued' });
    expect(JSON.parse(job.options).clips).toBe(4);
    // Seen once, never twice.
    await t.api.post('/api/video-studio/autopilot/check');
    expect(t.app.db.get(`SELECT COUNT(*) n FROM video_jobs WHERE source_url LIKE '%ap00000003'`)!.n).toBe(1);

    // Job done → top 2 clips as Postiz drafts on the slots, recycling as drafts, the team hears about it.
    const postsBefore = postiz.filter((p) => p.path === '/posts' && p.body).length;
    aiCalls.length = 0;
    await withBase('https://gh.example.com', async () => {
      osJobs.set(job.os_job_id, { status: 'completed', result: { clips: [clipMeta(job.os_job_id, 1, 40), clipMeta(job.os_job_id, 2, 95), clipMeta(job.os_job_id, 3, 70)] } });
      await t.api.post(`/api/video-studio/jobs/${job.id}/refresh`);
      await idle();
    });
    const created = postiz.filter((p) => p.path === '/posts' && p.body).slice(postsBefore).map((p) => p.body);
    expect(created).toHaveLength(4); // 2 clips + LinkedIn + X thread
    expect(created.every((b) => b.type === 'draft')).toBe(true);
    const clipPosts = created.filter((b) => b.posts.some((p: any) => p.integration.id === 'int-yt'));
    expect(clipPosts).toHaveLength(2);
    const dates = created.map((b) => new Date(b.date));
    const tz = t.app.location(loc)!.timezone || 'Europe/Berlin';
    const local = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
    for (const d of dates) expect(local(d)).toMatch(/^(Mon|Wed|Fri) (09:00|17:30)$/);
    expect(new Set(dates.map((d) => d.getTime())).size).toBe(4);
    const its = await items(job.id);
    expect(its.map((i) => [i.kind, i.status, i.origin]).sort()).toEqual([
      ['linkedin', 'applied', 'Autopilot'],
      ['x_thread', 'applied', 'Autopilot'],
      ['youtube', 'ready', 'Autopilot'],
    ]);
    expect(aiCalls).toHaveLength(3);
    expect(pushes.pop()).toMatchObject({ locationId: loc, title: 'Autopilot: neue Shorts zur Freigabe', url: `/app/video-studio/${job.id}` });
    const ap = (await t.api.get('/api/video-studio/autopilot')).data;
    expect(ap.state.log[0].text).toMatch(/2 Clips als Entwurf im Social Planner, 3 Recycling-Inhalte \(2 als Entwurf übernommen\)/);
    // Drafts claim their slots: the next video continues after the last one.
    expect(ap.state.last_slot).toBe(new Date(Math.max(...dates.map((d) => d.getTime()))).toISOString());
    expect(t.app.db.get('SELECT * FROM video_job_plans WHERE job_id = ?', job.id)).toMatchObject({ autopilot: 1, done: 1 });
  });

  it('plans for real with „automatisch einplanen“ and skips audio-only podcast episodes', async () => {
    const pod = 'https://feed.test/podcast.xml';
    const item = (g: string, type: string, url: string) => `<item><title>${g}</title><guid>${g}</guid><enclosure url="${url}" type="${type}"/></item>`;
    feeds.set(pod, `<rss><channel>${item('e1', 'audio/mpeg', 'https://cdn.test/e1.mp3')}</channel></rss>`);
    const cur = (await t.api.get('/api/video-studio/autopilot')).data.settings;
    await t.api.put('/api/video-studio/autopilot', { ...cur, mode: 'auto', top_n: 1, recycle: [], feeds: [...cur.feeds, { type: 'podcast', url: pod, label: 'Podcast' }] });
    await t.api.post('/api/video-studio/autopilot/check');
    feeds.set(pod, `<rss><channel>${item('e3', 'video/mp4', 'https://cdn.test/e3.mp4')}${item('e2', 'audio/mpeg', 'https://cdn.test/e2.mp3')}${item('e1', 'audio/mpeg', 'https://cdn.test/e1.mp3')}</channel></rss>`);
    const st = (await t.api.post('/api/video-studio/autopilot/check')).data.state;
    expect(st.log.map((l: any) => l.text)).toEqual(expect.arrayContaining([expect.stringMatching(/„e2“ übersprungen – nur Audio/), expect.stringMatching(/neues Video „e3“/)]));
    const job = t.app.db.get(`SELECT * FROM video_jobs WHERE source_url = 'https://cdn.test/e3.mp4'`)!;
    const before = postiz.filter((p) => p.path === '/posts' && p.body).length;
    await withBase('https://gh.example.com', async () => {
      osJobs.set(job.os_job_id, { status: 'completed', result: { clips: [clipMeta(job.os_job_id, 1, 60)] } });
      await t.api.post(`/api/video-studio/jobs/${job.id}/refresh`);
      await idle();
    });
    const created = postiz.filter((p) => p.path === '/posts' && p.body).slice(before).map((p) => p.body);
    expect(created).toHaveLength(1);
    expect(created[0].type).toBe('schedule');
    expect(pushes.pop()).toMatchObject({ title: 'Autopilot: neue Shorts eingeplant' });
    expect((await t.api.get('/api/video-studio/autopilot')).data.state.last_slot).toBe(new Date(created[0].date).toISOString());
  });

  it('respects the daily limit and runs on the tick', async () => {
    const cur = (await t.api.get('/api/video-studio/autopilot')).data.settings;
    await t.api.put('/api/video-studio/autopilot', { ...cur, max_per_day: 1 });
    feeds.set(feedUrl, ytFeed(['ap00000004', 'ap00000003', 'ap00000001', 'ap00000002']));
    t.app.db.run(`UPDATE video_autopilot SET state = json_set(state, '$.last_run', '2000-01-01T00:00:00.000Z')`);
    await t.app.tick();
    await idle();
    const st = (await t.api.get('/api/video-studio/autopilot')).data.state;
    expect(st.log[0].text).toMatch(/Tageslimit erreicht/);
    expect(t.app.db.get(`SELECT COUNT(*) n FROM video_jobs WHERE source_url LIKE '%ap00000004'`)!.n).toBe(0);
    await t.api.put('/api/video-studio/autopilot', { enabled: false });
  });
});

void realAiRun;
void realAiReady;
