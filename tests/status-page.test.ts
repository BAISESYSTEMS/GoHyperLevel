import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bucketOf, BUCKET_MS, currentStatus, dailyUptime } from '../server/services/status-page.js';
import { startTestApp } from './helpers.js';

describe('uptime from own samples (pure)', () => {
  it('counts missing samples as down, days before the first sample as no data', () => {
    const now = Date.parse('2026-10-10T12:00:00Z');
    const day = Date.parse('2026-10-09T00:00:00Z');
    const samples = [];
    // yesterday: all 288 slots, the jobs down for the first quarter
    for (let i = 0; i < 288; i++) samples.push({ bucket: bucketOf(day) + i, app: 1, jobs: i < 72 ? 0 : 1, backup: 1 });
    // today: half of the finished slots missing (server down)
    const todayFirst = bucketOf(Date.parse('2026-10-10T00:00:00Z'));
    for (let i = 0; i < 72; i++) samples.push({ bucket: todayFirst + i, app: 1, jobs: 1, backup: 1 });
    const u = dailyUptime(samples, { now, days: 5 });
    expect(u.days).toEqual(['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10']);
    expect(u.uptime.app.slice(0, 3)).toEqual([null, null, null]);
    expect(u.uptime.app[3]).toBe(1);
    expect(u.uptime.jobs[3]).toBe(0.75);
    expect(u.uptime.app[4]).toBe(0.5);
    expect(u.total.app).toBeCloseTo((288 + 72) / (288 + 144), 5);
    const latest = samples[samples.length - 1];
    expect(currentStatus('app', 'app', latest, [], latest.bucket * BUCKET_MS + 60_000)).toBe('ok');
    expect(currentStatus('app', 'app', latest, [], now)).toBe('unknown');
    expect(currentStatus('jobs', 'jobs', latest, [{ id: 'i', title: 'x', impact: 'major', components: ['jobs'], status: 'investigating', started_at: '', resolved_at: null, updates: [] }], now)).toBe('outage');
  });
});

describe('/status', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
  });
  afterAll(async () => {
    delete process.env.PGHL_STATUS_PAGE;
    await t?.close();
  });

  it('is off on a self-hosted install unless switched on', async () => {
    expect((await t.api.raw('/status')).status).toBe(404);
    process.env.PGHL_STATUS_PAGE = '1';
    const r = await t.api.raw('/status');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(r.headers.get('set-cookie')).toBeNull();
    const html = await r.text();
    expect(html).not.toMatch(/<script|https?:\/\/(?!127)/i);
    expect(html).toContain('Web-App &amp; API');
    expect(html).toContain('Datensicherung');
    expect(html).toContain('Noch keine Messwerte');
  });

  it('records a sample a minute through the health evaluation', async () => {
    await t.app.services.ops.evaluate();
    const s = t.app.db.get<{ bucket: number; app: number; jobs: number; backup: number }>('SELECT * FROM status_samples ORDER BY bucket DESC LIMIT 1')!;
    expect(s).toMatchObject({ bucket: bucketOf(Date.now()), app: 1, jobs: 1, backup: 1 });
    // a failing minute in the same slot wins
    t.app.services.statusPage.record({ checks: { db: { status: 'ok' }, tick: { status: 'fail' }, backup: { status: 'ok' } } });
    expect(t.app.db.get<{ jobs: number }>('SELECT jobs FROM status_samples WHERE bucket = ?', s.bucket)!.jobs).toBe(0);
    // 3 days of history for the bars
    for (let i = 1; i < 3 * 288; i++) t.app.db.run('INSERT OR IGNORE INTO status_samples (bucket, app, jobs, backup) VALUES (?, 1, 1, 1)', s.bucket - i);
    const html = await (await t.api.raw('/status')).text();
    expect(html).toMatch(/class="b ok"/);
    expect(html).toMatch(/class="b none"/);
  });

  it('shows incidents the operator writes, escaped, and moves resolved ones to the past', async () => {
    const created = await t.api.post('/api/admin/status-page/incidents', { title: 'E-Mail-Versand <b>verzögert</b>', impact: 'major', components: ['jobs'], status: 'investigating', message: 'Wir prüfen das.\nUpdate folgt.' });
    expect(created.status).toBe(200);
    expect(created.data).toMatchObject({ status: 'investigating', components: ['jobs'], updates: [{ body: 'Wir prüfen das.\nUpdate folgt.' }] });
    expect((await t.api.post('/api/admin/status-page/incidents', { title: 'x', impact: 'kaputt', message: 'y' })).status).toBe(400);
    expect((await t.api.post('/api/admin/status-page/incidents', { title: 'x', components: ['nope'], message: 'y' })).status).toBe(400);
    let html = await (await t.api.raw('/status')).text();
    expect(html).toContain('Aktuelle Vorfälle');
    expect(html).toContain('E-Mail-Versand &lt;b&gt;verzögert&lt;/b&gt;');
    expect(html).toContain('class="banner outage"');
    expect(html).toContain('Wir prüfen das.<br>Update folgt.');
    const done = await t.api.patch(`/api/admin/status-page/incidents/${created.data.id}`, { status: 'resolved', message: 'Behoben, alle Mails sind raus.' });
    expect(done.data.resolved_at).toBeTruthy();
    expect(done.data.updates).toHaveLength(2);
    html = await (await t.api.raw('/status')).text();
    expect(html).not.toContain('Aktuelle Vorfälle');
    expect(html).toContain('Behoben, alle Mails sind raus.');
    const admin = (await t.api.get('/api/admin/status-page')).data;
    expect(admin).toMatchObject({ enabled: true, url: expect.stringMatching(/\/status$/) });
    expect(admin.components.map((c: { key: string }) => c.key)).toEqual(['app', 'sites', 'jobs', 'backup']);
    expect(admin.past).toHaveLength(1);
    expect((await t.api.del(`/api/admin/status-page/incidents/${created.data.id}`)).status).toBe(200);
    expect((await t.api.get('/api/admin/status-page')).data.past).toHaveLength(0);
  });

  it('keeps incidents admin-only', async () => {
    t.api.clearCookie();
    expect((await t.api.get('/api/admin/status-page')).status).toBe(401);
    expect((await t.api.post('/api/admin/status-page/incidents', { title: 'x', message: 'y' })).status).toBe(401);
  });
});
