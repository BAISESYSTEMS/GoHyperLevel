import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';

/**
 * Security wave 10 – public video testimonial uploads (modules/video-testimonials.ts): the collect page is off until the
 * sub-account switches it on, a body is never read past the size announced at start, starts are rate-limited per address and
 * per sub-account, and a sub-account's videos have a disk quota (plus the cloud plan's media storage).
 */

type T = Awaited<ReturnType<typeof startTestApp>>;
const apps: T[] = [];
afterEach(async () => {
  delete process.env.PGHL_TESTIMONIALS_MB;
  while (apps.length) await apps.pop()!.close();
});

async function boot(enable = true) {
  const t = await startTestApp({ behindProxy: true });
  apps.push(t);
  await t.setup();
  if (enable) expect((await t.api.put('/api/video-testimonials/page', { active: true })).status).toBe(200);
  const slug = (await t.api.get('/api/video-testimonials')).data.page.slug as string;
  const start = (b: Record<string, unknown>, ip = '198.51.100.1') =>
    t.api.raw(`/testimonials/${slug}/start`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ name: 'Anna', consent: true, ...b }) });
  const put = (s: { id: string; token: string }, body: Buffer, ip = '198.51.100.1') => t.api.raw(`/testimonials/${slug}/upload/${s.id}?t=${encodeURIComponent(s.token)}`, { method: 'PUT', headers: { 'x-forwarded-for': ip }, body });
  return { t, slug, start, put };
}

const mp4 = (n: number) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(Math.max(0, n - 12), 7)]);

describe('video testimonials: collect page off by default', () => {
  it('takes no videos until the team switches the page on, then works end to end', async () => {
    const { t, slug, start, put } = await boot(false);
    expect((await t.api.get('/api/video-testimonials')).data.page.active).toBe(false);
    expect((await t.api.raw(`/testimonials/${slug}`)).status).toBe(404);
    expect((await start({ size: 300 })).status).toBe(404);

    // Saving only the texts leaves it off; switching it on opens it.
    await t.api.put('/api/video-testimonials/page', { title: 'Dein Video' });
    expect((await t.api.raw(`/testimonials/${slug}`)).status).toBe(404);
    await t.api.put('/api/video-testimonials/page', { active: true });
    expect((await t.api.raw(`/testimonials/${slug}`)).status).toBe(200);
    const s = await (await start({ size: 300 })).json();
    expect((await put(s, mp4(300))).status).toBe(200);
    expect((await t.api.get('/api/video-testimonials')).data.items).toMatchObject([{ status: 'pending', size: 300 }]);
  });
});

describe('video testimonials: size cap while streaming', () => {
  it('never reads more than the size announced at start', async () => {
    const { t, start, put } = await boot();
    const s = await (await start({ size: 300 })).json();
    expect((await put(s, mp4(5000))).status).toBe(413);
    expect((await t.api.get('/api/video-testimonials')).data.items).toEqual([]);
  });
  it('reads at most the normal public body limit for an unknown upload', async () => {
    const { slug, t } = await boot();
    const r = await t.api.raw(`/testimonials/${slug}/upload/abcdefgh12345678?t=falsch`, { method: 'PUT', headers: { 'x-forwarded-for': '198.51.100.2' }, body: mp4(2 * 1024 * 1024) });
    expect(r.status).toBe(413);
  });
  it('uses the token up on a failed upload', async () => {
    const { start, put } = await boot();
    const s = await (await start({ size: 300 })).json();
    expect((await put(s, Buffer.alloc(300, 1))).status).toBe(400);
    expect((await put(s, mp4(300))).status).toBe(404);
  });
  it('takes one body per token at a time', async () => {
    const { t, slug, start, put } = await boot();
    const s = await (await start({ size: 1000 })).json();
    const url = new URL(`${t.base}/testimonials/${slug}/upload/${s.id}?t=${encodeURIComponent(s.token)}`);
    const first = request(url, { method: 'PUT', headers: { 'content-length': '1000', 'x-forwarded-for': '198.51.100.1' } });
    const done = new Promise<number>((res, rej) => first.on('response', (r) => (r.resume(), res(r.statusCode!))).on('error', rej));
    try {
      first.write(mp4(1000).subarray(0, 100));
      await new Promise((r) => setTimeout(r, 150));
      expect((await put(s, mp4(1000))).status).toBe(409);
      first.end(mp4(1000).subarray(100));
      expect(await done).toBe(200);
    } finally {
      first.destroy();
    }
  });
});

describe('video testimonials: rate limits', () => {
  it('limits starts per address', async () => {
    const { start } = await boot();
    for (let i = 0; i < 10; i++) expect((await start({ size: 300 }, '203.0.113.7')).status).toBe(200);
    const r = await start({ size: 300 }, '203.0.113.7');
    expect(r.status).toBe(429);
    expect((await r.json()).error).toMatch(/Zu viele/);
    expect((await start({ size: 300 }, '203.0.113.8')).status).toBe(200);
  });
  it('limits starts per sub-account across addresses', async () => {
    const { start } = await boot();
    for (let i = 0; i < 30; i++) expect((await start({ size: 300 }, `192.0.2.${i + 1}`)).status).toBe(200);
    expect((await start({ size: 300 }, '192.0.2.200')).status).toBe(429);
  });
});

describe('video testimonials: storage quota', () => {
  it('refuses what would pass the sub-account quota, counting open uploads', async () => {
    process.env.PGHL_TESTIMONIALS_MB = String(1000 / 1048576);
    const { start, put } = await boot();
    expect((await start({ size: 1500 })).status).toBe(413);
    const a = await (await start({ size: 500 })).json();
    expect((await start({ size: 600 })).status).toBe(413);
    expect((await put(a, mp4(500))).status).toBe(200);
    const r = await start({ size: 600 });
    expect(r.status).toBe(413);
    expect((await r.json()).error).toMatch(/Speicher/);
    expect((await start({ size: 400 })).status).toBe(200);
  });
  it('honours the cloud plan media storage', async () => {
    const { t, start } = await boot();
    t.app.services.storageMeter = () => ({ used: 900, limit: 1000 });
    expect((await start({ size: 200 })).status).toBe(413);
    expect((await start({ size: 50 })).status).toBe(200);
  });
});
