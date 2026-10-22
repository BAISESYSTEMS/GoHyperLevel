import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backupCheck, diskCheck, isSpike, tickCheck, webhookRequest } from '../server/services/ops-alerts.js';
import { startTestApp } from './helpers.js';

describe('health checks (pure)', () => {
  it('judges disk, scheduler and backup age', () => {
    expect(diskCheck({ percent: 9.5, free: 5e9 }).status).toBe('fail');
    expect(diskCheck({ percent: 15, free: 5e9 }).status).toBe('warn');
    expect(diskCheck({ percent: 50, free: 5e9 }).status).toBe('ok');
    expect(diskCheck(undefined).status).toBe('off');
    const now = Date.now();
    expect(tickCheck(now - 20_000, now - 3600_000, 15_000, now).status).toBe('ok');
    expect(tickCheck(now - 10 * 60_000, now - 3600_000, 15_000, now).status).toBe('fail');
    expect(tickCheck(undefined, now - 10_000, 15_000, now).status).toBe('ok');
    expect(tickCheck(undefined, now, 0, now).status).toBe('off');
    const off = { source: 'offsite' as const, maxMinutes: 120 };
    expect(backupCheck({ ...off, at: new Date(now - 30 * 60_000).toISOString() }, now - 864e5, now).status).toBe('ok');
    expect(backupCheck({ ...off, at: new Date(now - 3 * 3600_000).toISOString() }, now - 864e5, now)).toMatchObject({ status: 'fail', detail: expect.stringContaining('3 h alt') });
    expect(backupCheck(off, now - 60_000, now).status).toBe('ok');
    expect(backupCheck(off, now - 5 * 3600_000, now).status).toBe('fail');
    expect(backupCheck({ source: 'none', maxMinutes: 0 }, now, now).status).toBe('off');
    expect(isSpike(25, 100)).toBe(true);
    expect(isSpike(25, 10_000)).toBe(false);
    expect(isSpike(5, 5)).toBe(false);
  });

  it('formats the webhook for ntfy, Slack, Discord, Telegram and plain JSON', () => {
    const a = { key: 'disk_low', severity: 'critical' as const, title: 'Speicherplatz fast voll', body: 'Nur noch 8 % frei' };
    const ntfy = webhookRequest('https://ntfy.sh/mein-thema', a, 'HyperLevel');
    expect(ntfy.init.headers.priority).toBe('5');
    expect(ntfy.init.headers.title).toMatch(/^=\?UTF-8\?B\?/);
    expect(ntfy.init.body).toBe('Nur noch 8 % frei');
    expect(JSON.parse(webhookRequest('https://hooks.slack.com/services/T/B/x', a, 'HyperLevel').init.body).text).toContain('Speicherplatz fast voll');
    expect(JSON.parse(webhookRequest('https://discord.com/api/webhooks/1/x', a, 'HyperLevel').init.body).content).toContain('8 % frei');
    const tg = webhookRequest('https://api.telegram.org/bot123:abc/sendMessage?chat_id=-100', a, 'HyperLevel');
    expect(tg.url).not.toContain('chat_id');
    expect(JSON.parse(tg.init.body)).toMatchObject({ chat_id: '-100', text: expect.stringContaining('Speicherplatz') });
    expect(JSON.parse(webhookRequest('https://example.com/hook', { ...a, resolved: true }, 'HyperLevel').init.body)).toMatchObject({ key: 'disk_low', resolved: true, source: 'HyperLevel' });
  });
});

describe('/healthz and alerts', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  const mails: { to: string; subject: string; text: string }[] = [];
  const hooks: { url: string; body: string }[] = [];
  let disk = 50;
  beforeAll(async () => {
    process.env.PGHL_ALERT_WEBHOOK = 'https://hooks.slack.com/services/T000/B000/test';
    process.env.PGHL_ALERT_EMAIL = 'ops@example.com, bereitschaft@example.com';
    t = await startTestApp();
    await t.setup();
    t.app.services.opsDiskFree = () => ({ percent: disk, free: disk * 1e9, total: 100e9 });
    t.app.services.alertMailer = async (_loc: unknown, m: { to: string; subject: string; text: string }) => {
      mails.push(m);
      return { status: 'logged' };
    };
    t.app.services.alertFetch = async (url: string, init: { body: string }) => {
      hooks.push({ url, body: init.body });
      return new Response('ok');
    };
  });
  afterAll(async () => {
    delete process.env.PGHL_ALERT_WEBHOOK;
    delete process.env.PGHL_ALERT_EMAIL;
    await t?.close();
  });

  it('answers ok with every check passing, as text and JSON', async () => {
    const r = await t.api.raw('/healthz');
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('ok');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const j = await (await t.api.raw('/healthz?format=json')).json();
    expect(j).toEqual({ status: 'ok', checks: { db: 'ok', disk: 'ok', tick: 'off', backup: 'ok' } });
    // statuses only – no numbers or paths for the public
    expect(JSON.stringify(j)).not.toMatch(/\d{2,}|data/);
  });

  it('reports a failing check as degraded; strict mode answers 503 for external monitors', async () => {
    disk = 7;
    const plain = await t.api.raw('/healthz');
    expect(plain.status).toBe(200);
    expect(await plain.text()).toBe('degraded: disk');
    expect((await t.api.raw('/healthz?strict=1')).status).toBe(503);
    disk = 50;
    expect((await t.api.raw('/healthz?strict=1')).status).toBe(200);
  });

  it('alerts once by e-mail, push and webhook, reminds later and says when it is over', async () => {
    disk = 6;
    await t.app.services.ops.evaluate();
    await t.app.services.ops.evaluate();
    const disk1 = mails.filter((m) => m.subject.includes('Speicherplatz'));
    expect(disk1.map((m) => m.to).sort()).toEqual(['bereitschaft@example.com', 'ops@example.com']);
    expect(disk1[0].subject).toMatch(/^\[Alarm\]/);
    expect(hooks.filter((h) => h.body.includes('Speicherplatz'))).toHaveLength(1);
    const open = t.app.db.get<{ status: string; sent: string }>(`SELECT * FROM ops_alerts WHERE key = 'disk_low' AND status = 'firing'`)!;
    expect(open.sent).toContain('email: 2');
    expect(open.sent).toContain('webhook: ok');
    expect(open.sent).toMatch(/push: \d/);
    // six hours later: one reminder
    t.app.db.run(`UPDATE ops_alerts SET last_sent_at = ? WHERE key = 'disk_low'`, new Date(Date.now() - 7 * 3600_000).toISOString());
    await t.app.services.ops.evaluate();
    expect(mails.filter((m) => m.subject.includes('weiterhin'))).toHaveLength(2);
    disk = 40;
    await t.app.services.ops.evaluate();
    expect(mails.some((m) => m.subject.startsWith('[Behoben]'))).toBe(true);
    expect(t.app.db.get(`SELECT 1 AS x FROM ops_alerts WHERE key = 'disk_low' AND status = 'firing'`)).toBeUndefined();
  });

  it('notices an old backup and a stalled scheduler', async () => {
    t.app.services.opsStartedAt = Date.now() - 30 * 3600_000;
    const tickMs = t.app.config.tickMs;
    t.app.config.tickMs = 15_000;
    t.app.services.opsLastTick = () => Date.now() - 20 * 60_000;
    const r = await t.app.services.ops.evaluate();
    expect(r.checks.backup).toMatchObject({ status: 'fail' });
    expect(r.checks.tick).toMatchObject({ status: 'fail' });
    const keys = t.app.db.all<{ key: string }>(`SELECT key FROM ops_alerts WHERE status = 'firing'`).map((a) => a.key);
    expect(keys).toEqual(expect.arrayContaining(['backup_stale', 'tick_stalled']));
    expect((await t.api.raw('/healthz')).status).toBe(200);
    expect(await (await t.api.raw('/healthz?strict=1')).text()).toBe('degraded: tick, backup');
    delete t.app.services.opsStartedAt;
    delete t.app.services.opsLastTick;
    t.app.config.tickMs = tickMs;
    await t.app.services.ops.evaluate();
    expect(t.app.db.all(`SELECT key FROM ops_alerts WHERE status = 'firing'`)).toEqual([]);
  });

  it('spots a spike of unexpected server errors', async () => {
    t.app.router.get('/api/test-kaputt', 'public', () => {
      throw new Error('kaputt');
    });
    for (let i = 0; i < 22; i++) expect((await t.api.raw('/api/test-kaputt')).status).toBe(500);
    await t.app.services.ops.evaluate();
    expect(t.app.db.get(`SELECT * FROM ops_alerts WHERE key = 'error_spike' AND status = 'firing'`)).toBeTruthy();
  });

  it('one-off events are deduplicated; the admin page lists channels and alerts; test alert', async () => {
    expect(await t.app.services.opsAlert.eventAsync({ key: 'x_once', severity: 'warning', title: 'Einmal', body: 'b' })).toBe(true);
    expect(await t.app.services.opsAlert.eventAsync({ key: 'x_once', severity: 'warning', title: 'Einmal', body: 'b' })).toBe(false);
    const d = (await t.api.get('/api/admin/ops')).data;
    expect(d.channels).toMatchObject({ email: ['ops@example.com', 'bereitschaft@example.com'], email_from_env: true, webhook: 'hooks.slack.com' });
    expect(d.healthz).toMatch(/\/healthz\?strict=1$/);
    expect(d.recent.length).toBeGreaterThan(0);
    const test = (await t.api.post('/api/admin/ops/test-alert')).data;
    expect(test.sent).toMatchObject({ email: '2', webhook: 'ok' });
  });
});
