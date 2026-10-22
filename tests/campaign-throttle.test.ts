import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { requiredPermission } from '../server/core/permissions.js';
import { MAX_BATCH, allowedNow, batchSize, cleanSpeed, throttleInfo, warmupAdvice } from '../server/services/campaign-throttle.js';
import { durationText, etaText, speedValue } from '../web/src/campaign-throttle.js';

/** Sending speed per campaign: bounds, the allowance per tick, the ETA, the warm-up hint and the screens. */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const HOUR = 3600_000;

describe('speed (pure)', () => {
  it('accepts a whole number within the bounds, empty means standard', () => {
    expect(cleanSpeed(undefined)).toBeNull();
    expect(cleanSpeed(null)).toBeNull();
    expect(cleanSpeed('')).toBeNull();
    expect(cleanSpeed(0)).toBeNull();
    expect(cleanSpeed('250')).toBe(250);
    expect(cleanSpeed(10)).toBe(10);
    expect(cleanSpeed(50_000)).toBe(50_000);
    expect(() => cleanSpeed(9)).toThrow(/zwischen 10 und 50\.000/);
    expect(() => cleanSpeed(50_001)).toThrow(/zwischen/);
    expect(() => cleanSpeed(12.5)).toThrow(/ganze Zahl/);
    expect(() => cleanSpeed('schnell')).toThrow(/ganze Zahl/);
  });

  it('keeps the default batch inside 1 and 500', () => {
    expect(batchSize(30)).toBe(30);
    expect(batchSize(0)).toBe(1);
    expect(batchSize(-5)).toBe(1);
    expect(batchSize(99_999)).toBe(MAX_BATCH);
    expect(batchSize(undefined)).toBe(30);
    expect(batchSize('abc')).toBe(30);
  });

  it('lets the first message go at once and then keeps to the speed, without bursts after a pause', () => {
    const base = { speed: 3600, defaultBatch: 30, tickMs: 15_000, anchorAt: 0, sentSinceAnchor: 0 };
    expect(allowedNow({ ...base, speed: null, at: 0 })).toBe(30);
    expect(allowedNow({ ...base, at: 0 })).toBe(1);
    // after 15 s at 3600/h: 15 + 1 earned
    expect(allowedNow({ ...base, at: 15_000 })).toBe(16);
    expect(allowedNow({ ...base, at: 15_000, sentSinceAnchor: 16 })).toBe(0);
    // a pause of an hour: the backlog is paid out at twice the nominal batch (30) per tick, not at once
    expect(allowedNow({ ...base, at: HOUR })).toBe(30);
    // slow speeds still move: 60 per hour is one message per tick at most
    expect(allowedNow({ ...base, speed: 60, at: 2 * HOUR })).toBe(1);
    expect(allowedNow({ ...base, speed: 60, at: 2 * HOUR, sentSinceAnchor: 200 })).toBe(0);
    // never more than the hard batch limit
    expect(allowedNow({ ...base, speed: 50_000, tickMs: 600_000, at: 100 * HOUR })).toBe(MAX_BATCH);
  });

  it('works out the time it takes and when it is through', () => {
    const at = Date.parse('2026-10-05T10:00:00.000Z');
    const t = throttleInfo({ speed: 500, defaultBatch: 30, tickMs: 15_000, remaining: 1240, at });
    expect(t).toMatchObject({ speed_per_hour: 500, per_hour: 500, default_per_hour: 7200, batch_per_tick: 3, tick_seconds: 15, remaining: 1240, eta_minutes: 149 });
    expect(t.eta_at).toBe('2026-10-05T12:29:00.000Z');
    const d = throttleInfo({ speed: null, defaultBatch: 30, tickMs: 15_000, remaining: 3600, at });
    expect(d).toMatchObject({ speed_per_hour: null, per_hour: 7200, batch_per_tick: 30, eta_minutes: 30 });
    expect(throttleInfo({ speed: 100, defaultBatch: 30, tickMs: 15_000, remaining: 0, at })).toMatchObject({ eta_at: null, eta_minutes: null });
    // a slower server tick makes the default slower
    expect(throttleInfo({ speed: null, defaultBatch: 30, tickMs: 60_000, remaining: 1, at }).default_per_hour).toBe(1800);
  });

  it('warns new senders – only e-mail, only for bigger sends – and says what to do', () => {
    const w = warmupAdvice({ channel: 'email', sentTotal: 12, remaining: 1500, perHour: 7200 });
    expect(w).toMatchObject({ level: 'warn', sent_total: 12, recommended_per_hour: 60 });
    expect(w.advice).toContain('erst 12 E-Mails');
    expect(w.advice).toContain('höchstens 60 pro Stunde');
    expect(warmupAdvice({ channel: 'email', sentTotal: 12, remaining: 1500, perHour: 50 })).toMatchObject({ level: 'info' });
    expect(warmupAdvice({ channel: 'email', sentTotal: 12, remaining: 150, perHour: 7200 }).advice).toBeNull();
    expect(warmupAdvice({ channel: 'email', sentTotal: 5000, remaining: 5000, perHour: 7200 }).advice).toBeNull();
    expect(warmupAdvice({ channel: 'sms', sentTotal: 0, remaining: 5000, perHour: 7200 }).advice).toBeNull();
  });

  it('tells the time in plain German', () => {
    expect(durationText(0)).toBe('unter 1 Min.');
    expect(durationText(25)).toBe('25 Min.');
    expect(durationText(60)).toBe('1 Std.');
    expect(durationText(149)).toBe('2 Std. 29 Min.');
    expect(durationText(1440)).toBe('1 Tag');
    expect(durationText(3 * 1440 + 240)).toBe('3 Tage 4 Std.');
    const at = new Date('2026-10-05T10:00:00');
    expect(etaText(1240, 500, at)).toBe('Dauer ca. 2 Std. 29 Min. für 1.240 Empfänger – fertig gegen 12:29 Uhr.');
    expect(etaText(1000, 50, at)).toContain('fertig am');
    expect(etaText(0, 500, at)).toBe('');
    expect(speedValue('')).toBeNull();
    expect(speedValue(' 250 ')).toBe(250);
    expect(speedValue('9')).toBeNaN();
    expect(speedValue('60000')).toBeNaN();
    expect(speedValue('1,5')).toBeNaN();
  });
});

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let n = 0;
const tagFor = () => `seg${++n}`;

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
});
afterAll(() => t.close());

/** `count` contacts with an e-mail address and one tag; returns a campaign for that tag. */
const campaign = async (count: number, extra: Record<string, unknown> = {}) => {
  const tag = tagFor();
  for (let i = 0; i < count; i++) t.app.db.insert('contacts', { id: `${tag}c${i}`, location_id: loc, first_name: `K${i}`, email: `${tag}-${i}@example.com`, tags: JSON.stringify([tag]), created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  const r = await t.api.post('/api/campaigns', { name: `Test ${tag}`, subject: 'Hallo', body: 'Text für {{contact.first_name}}', filter: { tags: [tag] }, ...extra });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
};
const stats = (id: string) => Object.fromEntries(t.app.db.all<any>('SELECT status, COUNT(*) n FROM campaign_recipients WHERE campaign_id = ? GROUP BY status', id).map((r) => [r.status, r.n]));
const send = (id: string) => t.api.post(`/api/campaigns/${id}/send`, {});

describe('campaign speed over the API', () => {
  it('refuses a speed outside the bounds and accepts it on create and change', async () => {
    const c = await campaign(1);
    expect(c.speed_per_hour).toBeNull();
    expect((await t.api.patch(`/api/campaigns/${c.id}`, { speed_per_hour: 5 })).status).toBe(400);
    expect((await t.api.patch(`/api/campaigns/${c.id}`, { speed_per_hour: 99_999 })).status).toBe(400);
    expect((await t.api.post('/api/campaigns', { name: 'x', speed_per_hour: 'schnell' })).status).toBe(400);
    expect((await t.api.patch(`/api/campaigns/${c.id}`, { speed_per_hour: 250 })).data.speed_per_hour).toBe(250);
    expect((await t.api.patch(`/api/campaigns/${c.id}`, { speed_per_hour: '' })).data.speed_per_hour).toBeNull();
    expect((await campaign(1, { speed_per_hour: 100 })).speed_per_hour).toBe(100);
  });

  it('keeps the old behaviour without a speed: a batch of 30 per tick, or the sub-account\'s own', async () => {
    const c = await campaign(40);
    const r = await send(c.id);
    expect(r.data.recipients).toBe(40);
    expect(stats(c.id)).toMatchObject({ sent: 30, pending: 10 });
    await t.app.tick();
    expect(stats(c.id)).toMatchObject({ sent: 40 });
    expect(t.app.db.get<any>('SELECT status FROM campaigns WHERE id = ?', c.id)!.status).toBe('sent');

    await t.api.patch('/api/location', { settings: { campaigns: { batch_size: 4 } } });
    const small = await campaign(10);
    await send(small.id);
    expect(stats(small.id)).toMatchObject({ sent: 4, pending: 6 });
    // a silly default is kept in range
    await t.api.patch('/api/location', { settings: { campaigns: { batch_size: 0 } } });
    const one = await campaign(3);
    await send(one.id);
    expect(stats(one.id)).toMatchObject({ sent: 1, pending: 2 });
    await t.api.patch('/api/location', { settings: { campaigns: { batch_size: 30 } } });
  });

  it('sends one message at once, then only what the speed earns – at most twice the nominal batch per tick', async () => {
    const c = await campaign(12, { speed_per_hour: 60 });
    await send(c.id);
    expect(stats(c.id)).toMatchObject({ sent: 1, pending: 11 });
    // nothing is earned within a moment
    await t.app.tick();
    await t.app.tick();
    expect(stats(c.id)).toMatchObject({ sent: 1, pending: 11 });
    // two hours later 60 per hour would allow 120: the cap lets one go per tick
    t.app.db.run('UPDATE campaigns SET throttle_at = ? WHERE id = ?', new Date(Date.now() - 2 * HOUR).toISOString(), c.id);
    await t.app.tick();
    expect(stats(c.id)).toMatchObject({ sent: 2, pending: 10 });
    await t.app.tick();
    expect(stats(c.id)).toMatchObject({ sent: 3, pending: 9 });

    // a faster one pays out a backlog in bigger steps, still capped (3600/h: 15 per tick, at most 30)
    const f = await campaign(100, { speed_per_hour: 3600 });
    await send(f.id);
    t.app.db.run('UPDATE campaigns SET throttle_at = ? WHERE id = ?', new Date(Date.now() - HOUR).toISOString(), f.id);
    const before = stats(f.id).sent ?? 0;
    await t.app.tick();
    expect((stats(f.id).sent ?? 0) - before).toBe(30);
  });

  it('finishes the campaign when the last message went out', async () => {
    const c = await campaign(2, { speed_per_hour: 10 });
    await send(c.id);
    expect(stats(c.id)).toMatchObject({ sent: 1, pending: 1 });
    t.app.db.run('UPDATE campaigns SET throttle_at = ? WHERE id = ?', new Date(Date.now() - HOUR).toISOString(), c.id);
    await t.app.tick();
    expect(t.app.db.get<any>('SELECT status FROM campaigns WHERE id = ?', c.id)!.status).toBe('sent');
    expect(stats(c.id)).toMatchObject({ sent: 2 });
  });

  it('changes the speed of a running campaign from now on (no debt for what was sent before)', async () => {
    const c = await campaign(100, { speed_per_hour: 5000 });
    await send(c.id);
    t.app.db.run('UPDATE campaigns SET throttle_at = ? WHERE id = ?', new Date(Date.now() - HOUR).toISOString(), c.id);
    await t.app.tick();
    const fast = stats(c.id).sent;
    expect(fast).toBeGreaterThan(5);
    expect(fast).toBeLessThan(100);
    // slow down: counted from now, so the next tick still sends (the first message of the new speed), not minus 5000
    const r = await t.api.put(`/api/campaigns/${c.id}/speed`, { speed_per_hour: 60 });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ speed_per_hour: 60, status: 'sending' });
    expect(r.data.throttle).toMatchObject({ per_hour: 60, remaining: 100 - fast });
    await t.app.tick();
    expect(stats(c.id).sent).toBe(fast + 1);
    await t.app.tick();
    expect(stats(c.id).sent).toBe(fast + 1);
    // back to the standard
    expect((await t.api.put(`/api/campaigns/${c.id}/speed`, { speed_per_hour: null })).data.speed_per_hour).toBeNull();
    await t.app.tick();
    expect(stats(c.id).sent).toBe(fast + 1 + 30);
  });

  it('refuses a speed for sent campaigns, bad values and other sub-accounts', async () => {
    const c = await campaign(1);
    await send(c.id);
    expect((await t.api.put(`/api/campaigns/${c.id}/speed`, { speed_per_hour: 100 })).status).toBe(400);
    const open = await campaign(1);
    expect((await t.api.put(`/api/campaigns/${open.id}/speed`, { speed_per_hour: 3 })).status).toBe(400);
    expect((await t.api.put('/api/campaigns/gibtsnicht/speed', { speed_per_hour: 100 })).status).toBe(404);
    const other = (await t.api.post('/api/locations', { name: 'Fremd' })).data.id;
    const foreign = await t.api.raw(`/api/campaigns/${open.id}/speed`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-pghl': '1', cookie: t.api.cookie, 'x-location-id': other }, body: JSON.stringify({ speed_per_hour: 100 }) });
    expect(foreign.status).toBe(404);
    expect(requiredPermission('PUT', `/api/campaigns/${open.id}/speed`)).toBe('campaigns');
  });

  it('shows the time it takes, the remaining messages and the hint for new senders', async () => {
    const c = await campaign(260);
    const d = (await t.api.get(`/api/campaigns/${c.id}`)).data;
    expect(d.throttle).toMatchObject({ speed_per_hour: null, per_hour: 7200, default_per_hour: 7200, batch_per_tick: 30, tick_seconds: 15, remaining: 260, eta_minutes: 3, min_speed: 10, max_speed: 50_000 });
    expect(d.warmup).toMatchObject({ level: 'warn', recommended_per_hour: 60, sent_total: 0 });
    expect(d.warmup.advice).toContain('aufwärmen');
    const slow = (await t.api.patch(`/api/campaigns/${c.id}`, { speed_per_hour: 50 })).data;
    expect(slow.speed_per_hour).toBe(50);
    const s = (await t.api.get(`/api/campaigns/${c.id}`)).data;
    expect(s.throttle).toMatchObject({ per_hour: 50, eta_minutes: 312 });
    expect(s.warmup.level).toBe('info');
    // contacts without e-mail or on "Nicht stören" are not counted as remaining
    t.app.db.run(`UPDATE contacts SET dnd = 1 WHERE id IN (SELECT id FROM contacts WHERE location_id = ? AND email LIKE ? LIMIT 60)`, loc, `${c.filter.tags[0]}-%`);
    expect((await t.api.get(`/api/campaigns/${c.id}`)).data.throttle.remaining).toBe(200);
    // while sending the remaining ones are the pending recipients
    const run = await campaign(5, { speed_per_hour: 10 });
    await send(run.id);
    const live = (await t.api.get(`/api/campaigns/${run.id}`)).data;
    expect(live.status).toBe('sending');
    expect(live.throttle).toMatchObject({ remaining: 4, per_hour: 10, eta_minutes: 24 });
    // a small send needs no hint
    expect(live.warmup.advice).toBeNull();
  });
});

describe('the screens', () => {
  it('offer the speed with the time it takes, the hint and live changes', () => {
    const ui = read('web/src/pages/CampaignThrottle.tsx');
    for (const needle of ['Versandgeschwindigkeit', 'Nachrichten pro Stunde', 'zum Aufwärmen', 'etaText', 'warmup']) expect(ui, needle).toContain(needle);
    const page = read('web/src/pages/Campaigns.tsx');
    expect(page).toContain('<ThrottleBox');
    expect(page).toContain('/speed');
    expect(page).toContain('speed_per_hour: data.speed_per_hour');
  });
});
