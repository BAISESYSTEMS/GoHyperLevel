import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { DEFAULT_HOUR, bestHour, histogram, localHour, minuteOf, planHours, sendAt, type Bucket } from '../server/services/mk-sto.js';
import { id } from '../server/core/util.js';

const TZ = 'Europe/Berlin';

describe('send-time optimisation: the hour of the day', () => {
  it('reads UTC hours on the sub-account clock, with summer and winter time', () => {
    expect(localHour(8, '2026-01', TZ)).toBe(9);
    expect(localHour(8, '2026-07', TZ)).toBe(10);
    expect(localHour(23, '2026-07', TZ)).toBe(1);
    expect(localHour(22, '2026-01', TZ)).toBe(23);
    expect(localHour(12, '2026-07', 'America/New_York')).toBe(8);
    expect(localHour(5, '2026-07', 'UTC')).toBe(5);
  });

  it('finds the best hour: most events, neighbours help a little, too little data says nothing', () => {
    const h = (spec: Record<number, number>) => Array.from({ length: 24 }, (_, i) => spec[i] ?? 0);
    expect(bestHour(h({ 9: 5, 15: 1 }))).toBe(9);
    // 9 sits between two busy hours: it wins over a lone peak of the same height.
    expect(bestHour(h({ 8: 2, 9: 3, 10: 2, 20: 3 }))).toBe(9);
    // a tie goes to the earlier hour
    expect(bestHour(h({ 7: 3, 18: 3 }))).toBe(7);
    // around midnight the hours are neighbours (23 and 0 together beat a lone 12; the tie goes to the earlier hour, 0)
    expect(bestHour(h({ 23: 3, 0: 3, 12: 4 }))).toBe(0);
    expect(bestHour(h({ 10: 2 }))).toBeNull();
    expect(bestHour(h({}))).toBeNull();
  });

  it('builds the histogram from buckets on the local clock', () => {
    const buckets: Bucket[] = [{ ym: '2026-07', h: 7, w: 3 }, { ym: '2026-01', h: 8, w: 2 }];
    const hist = histogram(buckets, TZ);
    expect(hist[9]).toBe(5); // 7 UTC in July = 9, 8 UTC in January = 9
    expect(hist.reduce((a, b) => a + b, 0)).toBe(5);
  });

  it('uses the contact\'s own hour, else the sub-account\'s, else the default', () => {
    const own: Bucket[] = [{ ym: '2026-07', h: 6, w: 4 }]; // 8:00 Berlin
    const one: Bucket[] = [{ ym: '2026-07', h: 15, w: 1 }]; // not enough for a trusted hour
    const none = planHours(new Map([['a', own], ['b', one]]), TZ);
    expect(none.own.get('a')).toBe(8);
    expect(none.own.has('b')).toBe(false);
    // 25 weighted events in total: enough for the sub-account's best hour
    const crowd = new Map<string, Bucket[]>();
    for (let i = 0; i < 7; i++) crowd.set(`c${i}`, [{ ym: '2026-07', h: 16, w: 4 }]); // 18:00 Berlin
    const account = planHours(crowd, TZ);
    expect(account).toMatchObject({ fallback: 18, fallback_from: 'account' });
    expect(none).toMatchObject({ fallback: DEFAULT_HOUR, fallback_from: 'default' });
    expect(planHours(new Map(), TZ, 7)).toMatchObject({ fallback: 7, fallback_from: 'default' });
  });

  it('picks a fixed minute per contact, spread over the hour', () => {
    expect(minuteOf('abc')).toBe(minuteOf('abc'));
    const minutes = new Set(Array.from({ length: 200 }, (_, i) => minuteOf(`contact-${i}`)));
    expect(minutes.size).toBeGreaterThan(40);
    for (const m of minutes) expect(m).toBeGreaterThanOrEqual(0), expect(m).toBeLessThan(60);
  });
});

describe('send-time optimisation: when a mail goes out', () => {
  // 2026-10-05 is in summer time: Berlin = UTC + 2.
  const berlin = (utc: string) => new Date(utc).toLocaleString('sv-SE', { timeZone: TZ }).replace(' ', 'T');

  it('later today when the hour is still to come', () => {
    const at = new Date('2026-10-05T07:30:00.000Z'); // 09:30 Berlin
    const t = sendAt(at, 14, TZ, 'c1');
    expect(berlin(t.toISOString()).slice(0, 13)).toBe('2026-10-05T14');
    expect(t.getTime()).toBeGreaterThan(at.getTime());
  });

  it('tomorrow when the hour is past', () => {
    const at = new Date('2026-10-05T13:00:00.000Z'); // 15:00 Berlin
    const t = sendAt(at, 14, TZ, 'c1');
    expect(berlin(t.toISOString()).slice(0, 13)).toBe('2026-10-06T14');
    expect(t.getTime() - at.getTime()).toBeLessThanOrEqual(24 * 3600_000);
  });

  it('at once inside the hour itself', () => {
    const at = new Date('2026-10-05T12:20:00.000Z'); // 14:20 Berlin
    expect(sendAt(at, 14, TZ, 'c1').getTime()).toBe(at.getTime());
  });

  it('never later than the window', () => {
    for (let h = 0; h < 24; h++) {
      const at = new Date('2026-10-05T10:07:00.000Z');
      const t = sendAt(at, h, TZ, `c${h}`);
      expect(t.getTime(), `hour ${h}`).toBeGreaterThanOrEqual(at.getTime());
      expect(t.getTime() - at.getTime(), `hour ${h}`).toBeLessThanOrEqual(24 * 3600_000);
    }
    // a shorter window cuts it off
    const at = new Date('2026-10-05T10:00:00.000Z');
    expect(sendAt(at, 8, TZ, 'x', 6).getTime()).toBe(at.getTime() + 6 * 3600_000);
  });

  it('survives the end of summer time (25-hour day)', () => {
    const at = new Date('2026-10-24T21:30:00.000Z'); // 23:30 Berlin, the night before the clocks go back
    const t = sendAt(at, 8, TZ, 'c1');
    expect(berlin(t.toISOString()).slice(0, 13)).toBe('2026-10-25T08');
    expect(t.getTime() - at.getTime()).toBeLessThanOrEqual(25 * 3600_000);
  });
});

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
});
afterAll(async () => t.close());

/** A contact with human opens at the given UTC hours (some days back, in the current month's past is not needed: 3 days ago is inside the 180 days). */
async function contactWithOpens(email: string, utcHours: number[]) {
  const c = (await t.api.post('/api/contacts', { email, first_name: email.split('@')[0] })).data;
  // The events belong to a message of this contact.
  const mid = id();
  t.app.db.insert('conversations', { id: `cv-${mid}`, location_id: loc, contact_id: c.id, unread: 0, last_message_at: new Date().toISOString(), created_at: new Date().toISOString() });
  t.app.db.insert('messages', { id: mid, location_id: loc, conversation_id: `cv-${mid}`, contact_id: c.id, channel: 'email', direction: 'out', subject: 'alt', body: 'x', status: 'sent', error: '', source: 'Kampagne: alt', created_at: new Date(Date.now() - 4 * 864e5).toISOString() });
  utcHours.forEach((h, i) => {
    const day = new Date(Date.now() - (3 + (i % 5)) * 864e5);
    day.setUTCHours(h, 12, 0, 0);
    t.app.db.insert('email_events', { id: id(), location_id: loc, message_id: mid, contact_id: c.id, kind: 'open', at: day.toISOString(), method: 'GET', ua_class: 'desktop', ua_hash: '', ip_prefix: '', classification: 'human', reason: '', applied: 1 });
  });
  return c;
}

describe('send-time optimisation in a campaign', () => {
  it('gives every recipient a send time within 24 hours and sends when it is due', async () => {
    const early = await contactWithOpens('frueh@example.com', [5, 5, 5, 6]);
    const late = await contactWithOpens('spaet@example.com', [18, 18, 19, 18]);
    const none = await contactWithOpens('neu@example.com', []);
    const camp = (await t.api.post('/api/campaigns', { name: 'Bestzeit', subject: 'Hallo', body: 'Hallo {{contact.first_name}}', send_mode: 'sto', filter: { tags: [] } })).data;
    expect(camp.send_mode).toBe('sto');

    // The preview: two have their own hour, the rest gets the fallback.
    const preview = (await t.api.get(`/api/campaigns/${camp.id}/sto`)).data;
    expect(preview).toMatchObject({ recipients: 3, own: 2, fallback: 1, fallback_hour: DEFAULT_HOUR, fallback_from: 'default', timezone: 'Europe/Berlin' });
    expect(preview.by_hour.reduce((a: number, b: number) => a + b, 0)).toBe(3);
    expect(preview.by_hour[DEFAULT_HOUR]).toBeGreaterThanOrEqual(1);

    const before = Date.now();
    const sent = await t.api.post(`/api/campaigns/${camp.id}/send`, {});
    expect(sent.status).toBe(200);
    const rows = t.app.db.all<{ contact_id: string; status: string; send_at: string | null }>('SELECT contact_id, status, send_at FROM campaign_recipients WHERE campaign_id = ?', camp.id);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.send_at, r.contact_id).toBeTruthy();
      const at = Date.parse(r.send_at!);
      expect(at).toBeGreaterThanOrEqual(before - 1000);
      expect(at - before).toBeLessThanOrEqual(24 * 3600_000 + 5000);
    }
    // Their own hours show (UTC 5 and 18 on the sub-account's clock, summer or winter time as of the month of the events).
    const ym = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 7);
    const hourOf = (cid: string) => Number(new Date(rows.find((r) => r.contact_id === cid)!.send_at!).toLocaleString('sv-SE', { timeZone: 'Europe/Berlin', hour: '2-digit', hour12: false }).slice(0, 2));
    expect(hourOf(early.id)).toBe(localHour(5, ym, TZ));
    expect(hourOf(late.id)).toBe(localHour(18, ym, TZ));
    expect(hourOf(none.id)).toBe(DEFAULT_HOUR);

    // Whoever is not due stays pending; the campaign keeps sending.
    const pending = rows.filter((r) => r.status === 'pending').length;
    expect((await t.api.get(`/api/campaigns/${camp.id}`)).data.status).toBe(pending ? 'sending' : 'sent');
    t.app.db.run(`UPDATE campaign_recipients SET send_at = ? WHERE campaign_id = ? AND status = 'pending'`, new Date(Date.now() - 1000).toISOString(), camp.id);
    await t.app.tick();
    const done = (await t.api.get(`/api/campaigns/${camp.id}`)).data;
    expect(done.status).toBe('sent');
    expect(done.stats.sent).toBe(3);
  });

  it('uses the sub-account default hour when there is no history at all', async () => {
    const put = await t.api.put('/api/deliverability/settings', { sto: { default_hour: 7 } });
    expect(put.data.sto.default_hour).toBe(7);
    const camp = (await t.api.post('/api/campaigns', { name: 'Ohne Daten', subject: 'x', body: 'y', send_mode: 'sto' })).data;
    // The earlier contacts have history, so the fallback hour is for those without.
    const preview = (await t.api.get(`/api/campaigns/${camp.id}/sto`)).data;
    expect(preview.fallback_hour).toBe(7);
  });

  it('send mode "sto" is for e-mail only and defaults to "now"', async () => {
    const sms = (await t.api.post('/api/campaigns', { name: 'SMS', channel: 'sms', body: 'x', send_mode: 'sto' })).data;
    expect(sms.send_mode).toBe('now');
    const mail = (await t.api.post('/api/campaigns', { name: 'Mail', subject: 'a', body: 'b' })).data;
    expect(mail.send_mode).toBe('now');
    const patched = (await t.api.patch(`/api/campaigns/${mail.id}`, { send_mode: 'sto' })).data;
    expect(patched.send_mode).toBe('sto');
    expect((await t.api.patch(`/api/campaigns/${mail.id}`, { send_mode: 'nope' })).data.send_mode).toBe('now');
  });
});
