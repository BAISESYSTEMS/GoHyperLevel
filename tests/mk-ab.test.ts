import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { id as newId } from '../server/core/util.js';
import { cleanAbConfig, metricValue, pickWinner, planSplit, variantContent, type VariantStats } from '../server/services/mk-ab.js';
import { cleanResendConfig, dueAt, isDue } from '../server/services/mk-resend.js';
import { mcpClient, starterDesign } from './mk-fixtures.js';

const stat = (key: string, sent: number, opened: number, clicked = 0, revenue = 0, buyers = 0): VariantStats => ({ key, sent, opened, clicked, buyers, revenue_cents: revenue });

describe('A/B test setup', () => {
  const camp = { channel: 'email', subject: 'Hauptbetreff' };

  it('needs two variants that differ, e-mail only', () => {
    expect(cleanAbConfig(null, camp)).toBeNull();
    expect(cleanAbConfig({ enabled: false, variants: [{}, { subject: 'x' }] }, camp)).toBeNull();
    expect(() => cleanAbConfig({ enabled: true, variants: [{}] }, camp)).toThrow(/mindestens zwei/);
    expect(() => cleanAbConfig({ enabled: true, variants: [{}, {}] }, camp)).toThrow(/unterscheidet sich nicht/);
    expect(() => cleanAbConfig({ enabled: true, variants: [{}, { subject: 'Hauptbetreff' }] }, camp)).toThrow(/unterscheidet sich nicht/);
    expect(() => cleanAbConfig({ enabled: true, variants: [{}, { subject: 'x' }] }, { channel: 'sms' })).toThrow(/nur für E-Mail/);
  });

  it('keeps the letters A–D in order, clamps the share and the waiting time, defaults the measure', () => {
    const cfg = cleanAbConfig({ variants: [{ subject: 'ignored for A' }, { subject: 'B' }, { subject: 'C' }, { subject: 'D' }, { subject: 'E' }], test_percent: 99, wait_hours: 100_000, metric: 'nonsense' }, camp)!;
    expect(cfg.variants.map((v) => v.key)).toEqual(['A', 'B', 'C', 'D']);
    expect(cfg.variants[0]).toEqual({ key: 'A' });
    expect(cfg).toMatchObject({ enabled: true, test_percent: 50, wait_hours: 336, metric: 'opens' });
    expect(cleanAbConfig({ variants: [{}, { subject: 'B' }], test_percent: 1, wait_hours: 0, metric: 'revenue' }, camp)).toMatchObject({ test_percent: 5, wait_hours: 1, metric: 'revenue' });
    expect(cleanAbConfig({ variants: [{}, { subject: 'B' }] }, camp)).toMatchObject({ test_percent: 20, wait_hours: 24 });
  });

  it('a variant can change the sender name (cleaned for the From header) or the content', () => {
    const cfg = cleanAbConfig({ variants: [{}, { sender_name: 'Anna <von "Firma">\r\nBcc: x', design: starterDesign() }] }, camp)!;
    expect(cfg.variants[1].sender_name).toBe('Anna von FirmaBcc: x');
    expect(cfg.variants[1].sender_name).not.toMatch(/[<>"\r\n]/);
    expect(cfg.variants[1].body).toContain('<html');
    expect(cfg.variants[1].body_text).toBeTruthy();
    expect(cfg.variants[1].is_html).toBe(1);
    expect(() => cleanAbConfig({ variants: [{}, { design: 'kein json', subject: 'x' }] }, camp)).toThrow();
  });

  it('a variant mail is made of its own parts where it has them', () => {
    const base = { subject: 'S', body: 'Basis', body_text: 'Basis-Text', is_html: 0, sender_name: 'Firma', ab: cleanAbConfig({ variants: [{}, { subject: 'S2', sender_name: 'Anna' }, { design: starterDesign() }] }, camp) };
    expect(variantContent(base, 'A')).toMatchObject({ subject: 'S', body: 'Basis', sender_name: 'Firma', is_html: 0 });
    expect(variantContent(base, 'B')).toMatchObject({ subject: 'S2', body: 'Basis', sender_name: 'Anna' });
    const c = variantContent(base, 'C');
    expect(c.subject).toBe('S');
    expect(c.body).toContain('<html');
    expect(c.is_html).toBe(1);
    // no test, or an unknown key: the campaign itself
    expect(variantContent({ ...base, ab: null }, 'B').subject).toBe('S');
    expect(variantContent(base, '').subject).toBe('S');
  });
});

describe('A/B split', () => {
  const ids = Array.from({ length: 100 }, (_, i) => `contact-${i}`);

  it('splits the test share evenly over the variants and holds the rest back', () => {
    const s = planSplit(ids, ['A', 'B'], 20, 'camp-1');
    expect(s.test.size).toBe(20);
    expect(s.held).toHaveLength(80);
    const counts = [...s.test.values()].reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
    expect(counts).toEqual({ A: 10, B: 10 });
    // nobody is in both groups, nobody is lost
    expect(new Set([...s.test.keys(), ...s.held]).size).toBe(100);
    const three = planSplit(ids, ['A', 'B', 'C'], 30, 'camp-1');
    expect(three.test.size).toBe(30);
    expect(Object.values([...three.test.values()].reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {}))).toEqual([10, 10, 10]);
  });

  it('is random but repeatable: same seed same groups, another seed another', () => {
    const a = planSplit(ids, ['A', 'B'], 20, 'camp-1');
    expect([...planSplit(ids, ['A', 'B'], 20, 'camp-1').test]).toEqual([...a.test]);
    expect([...planSplit(ids, ['A', 'B'], 20, 'camp-2').test.keys()].sort()).not.toEqual([...a.test.keys()].sort());
    // not simply the first ones of the list
    expect([...a.test.keys()].every((k, i) => k === `contact-${i}`)).toBe(false);
  });

  it('gives every variant at least one contact, keeps something back, and refuses tiny audiences', () => {
    const s = planSplit(ids.slice(0, 20), ['A', 'B', 'C', 'D'], 5, 's');
    expect(s.test.size).toBe(4);
    expect(new Set(s.test.values()).size).toBe(4);
    expect(s.held).toHaveLength(16);
    const all = planSplit(ids.slice(0, 10), ['A', 'B'], 50, 's');
    expect(all.test.size).toBe(5);
    expect(all.held).toHaveLength(5);
    expect(planSplit(ids.slice(0, 3), ['A', 'B'], 20, 's').skipped).toMatch(/Zu wenige/);
    expect(planSplit(ids.slice(0, 7), ['A', 'B', 'C', 'D'], 20, 's').skipped).toBeTruthy();
    expect(planSplit([], ['A', 'B'], 20, 's').test.size).toBe(0);
  });
});

describe('A/B winner', () => {
  it('opens: the higher rate per recipient wins, not the higher count', () => {
    const p = pickWinner([stat('A', 100, 30), stat('B', 100, 41), stat('C', 200, 70)], 'opens');
    expect(p).toMatchObject({ winner: 'B', reason: 'best' });
    expect(p.values.B).toBeCloseTo(0.41);
    // C has the most opens but a lower rate than B
    expect(pickWinner([stat('A', 100, 30), stat('B', 100, 41), stat('C', 400, 140)], 'opens').winner).toBe('B');
  });

  it('clicks and revenue are measured per recipient too', () => {
    expect(pickWinner([stat('A', 100, 50, 5), stat('B', 100, 20, 9)], 'clicks').winner).toBe('B');
    expect(pickWinner([stat('A', 100, 50, 5, 90_000, 2), stat('B', 200, 60, 4, 150_000, 3)], 'revenue').winner).toBe('A'); // 900 vs 750 per recipient
    expect(metricValue(stat('A', 0, 0), 'opens')).toBe(0);
  });

  it('a tie is decided by the next measure, then by the lower letter', () => {
    const t1 = pickWinner([stat('A', 100, 40, 3), stat('B', 100, 40, 7)], 'opens');
    expect(t1).toMatchObject({ winner: 'B', reason: 'tie' });
    expect(pickWinner([stat('A', 100, 40, 5), stat('B', 100, 40, 5)], 'opens')).toMatchObject({ winner: 'A', reason: 'tie' });
    expect(pickWinner([stat('A', 100, 40, 5), stat('B', 100, 55, 5)], 'clicks').winner).toBe('B'); // clicks tie → opens
  });

  it('without a single event the original wins; a variant nobody got cannot win', () => {
    expect(pickWinner([stat('A', 50, 0), stat('B', 50, 0)], 'opens')).toMatchObject({ winner: 'A', reason: 'no_data' });
    expect(pickWinner([stat('A', 0, 0), stat('B', 50, 0)], 'opens')).toMatchObject({ winner: 'B', reason: 'no_data' });
    expect(pickWinner([stat('A', 50, 1), stat('B', 0, 0)], 'opens').winner).toBe('A');
  });
});

describe('resend setup', () => {
  it('needs a new subject, e-mail only, no resend of a resend', () => {
    const camp = { channel: 'email', subject: 'Erste Mail' };
    expect(cleanResendConfig(null, camp)).toBeNull();
    expect(cleanResendConfig({ enabled: false }, camp)).toBeNull();
    expect(() => cleanResendConfig({ enabled: true }, camp)).toThrow(/Betreff fehlt/);
    expect(() => cleanResendConfig({ subject: 'Erste Mail' }, camp)).toThrow(/unterscheiden/);
    expect(() => cleanResendConfig({ subject: 'Neu' }, { channel: 'sms', subject: 'x' })).toThrow(/nur für E-Mail/);
    expect(() => cleanResendConfig({ subject: 'Neu' }, { ...camp, parent_id: 'p' })).toThrow(/nicht noch einmal/);
    expect(cleanResendConfig({ subject: ' Hast du das gesehen? ', after_hours: 100_000, sender_name: 'Anna<>' }, camp)).toMatchObject({ enabled: true, subject: 'Hast du das gesehen?', after_hours: 720, sender_name: 'Anna', status: 'waiting' });
    expect(cleanResendConfig({ subject: 'Neu' }, camp)).toMatchObject({ after_hours: 72 });
  });

  it('is due after the waiting time from the end of the campaign, once', () => {
    const cfg = cleanResendConfig({ subject: 'Neu', after_hours: 48 }, { channel: 'email', subject: 'x' })!;
    const sent = '2026-10-01T10:00:00.000Z';
    expect(dueAt(cfg, sent)).toBe('2026-10-03T10:00:00.000Z');
    expect(isDue(cfg, sent, Date.parse('2026-10-03T09:59:59.000Z'))).toBe(false);
    expect(isDue(cfg, sent, Date.parse('2026-10-03T10:00:00.000Z'))).toBe(true);
    expect(isDue({ ...cfg, status: 'created' }, sent, Date.parse('2026-10-09T10:00:00.000Z'))).toBe(false);
    expect(isDue(cfg, null)).toBe(false);
    expect(isDue(null, sent)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const mails: { to: string; subject: string; fromName?: string; html: string }[] = [];

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  t.app.services.emailTransports = { capture: async (_l: any, mail: any) => (mails.push({ to: mail.to, subject: mail.subject, fromName: mail.fromName, html: mail.html }), { status: 'sent', providerId: `m${mails.length}` }) };
  await t.api.patch('/api/location', { settings: { email: { provider: 'capture', fromEmail: 'info@firma.example', fromName: 'Firma' } } });
});
afterAll(async () => t.close());

let seq = 0;
async function contacts(n: number, tag = 'ab') {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push((await t.api.post('/api/contacts', { email: `${tag}${++seq}@kunde.example`, first_name: `K${seq}`, tags: [tag] })).data.id);
  return out;
}
const camp = async (body: Record<string, unknown>) => {
  const r = await t.api.post('/api/campaigns', { name: 'Test', subject: 'Hauptbetreff', body: 'Hallo {{contact.first_name}}', ...body });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
};
const get = async (cid: string) => (await t.api.get(`/api/campaigns/${cid}`)).data;
const recipients = (cid: string) => t.app.db.all<{ contact_id: string; status: string; variant: string; message_id: string | null }>('SELECT contact_id, status, variant, message_id FROM campaign_recipients WHERE campaign_id = ?', cid);
const open = (messageId: string | null) => t.app.db.run('UPDATE messages SET opened_at = ? WHERE id = ?', new Date().toISOString(), messageId);
const later = (cid: string, patch: Record<string, unknown>) => {
  const c = t.app.db.get<{ ab: string }>('SELECT ab FROM campaigns WHERE id = ?', cid)!;
  t.app.db.run('UPDATE campaigns SET ab = ? WHERE id = ?', JSON.stringify({ ...JSON.parse(c.ab), ...patch }), cid);
};

describe('A/B test in a campaign', () => {
  it('sends the test share first, waits, then sends the winner to the rest', async () => {
    await contacts(20, 'abtest');
    mails.length = 0;
    const c = await camp({ filter: { tags: ['abtest'] }, ab: { enabled: true, variants: [{}, { subject: 'Zweiter Betreff', sender_name: 'Anna von Firma' }], test_percent: 50, metric: 'opens', wait_hours: 2 } });
    expect(c.ab).toMatchObject({ enabled: true, test_percent: 50, metric: 'opens', wait_hours: 2 });
    const sent = await t.api.post(`/api/campaigns/${c.id}/send`, {});
    expect(sent.status).toBe(200);

    // The test mails are out, the rest waits; the clock for the winner runs.
    let cur = await get(c.id);
    expect(cur.status).toBe('testing');
    expect(cur.stats).toMatchObject({ sent: 10, held: 10 });
    expect(cur.ab.phase).toBe('waiting');
    expect(Date.parse(cur.ab.decide_at) - Date.now()).toBeGreaterThan(110 * 60_000);
    expect(Date.parse(cur.ab.decide_at) - Date.now()).toBeLessThanOrEqual(2 * 3600_000);
    expect(mails).toHaveLength(10);
    const aMails = mails.filter((m) => m.subject === 'Hauptbetreff');
    const bMails = mails.filter((m) => m.subject === 'Zweiter Betreff');
    expect(aMails).toHaveLength(5);
    expect(bMails).toHaveLength(5);
    expect(bMails.every((m) => m.fromName === 'Anna von Firma')).toBe(true);
    expect(aMails.every((m) => !m.fromName)).toBe(true);
    const rows = recipients(c.id);
    expect(rows.filter((r) => r.variant === 'A' && r.status === 'sent')).toHaveLength(5);
    expect(rows.filter((r) => r.variant === 'B' && r.status === 'sent')).toHaveLength(5);
    expect(rows.filter((r) => r.status === 'held' && r.variant === '')).toHaveLength(10);

    // The results view: both variants, nothing opened yet, no winner.
    const res = (await t.api.get(`/api/campaigns/${c.id}/ab`)).data;
    expect(res).toMatchObject({ enabled: true, phase: 'waiting', held: 10, winner: null, metric: 'opens' });
    expect(res.variants.map((v: any) => [v.key, v.sent, v.opened])).toEqual([['A', 5, 0], ['B', 5, 0]]);
    expect(res.variants[1].subject).toBe('Zweiter Betreff');

    // People open B's mail more often; a machine open (open_count without opened_at) does not count.
    const b = rows.filter((r) => r.variant === 'B');
    const a = rows.filter((r) => r.variant === 'A');
    for (const r of b.slice(0, 4)) open(r.message_id);
    open(a[0].message_id);
    t.app.db.run('UPDATE messages SET machine_open_count = 3 WHERE id = ?', a[1].message_id);
    t.app.db.run('UPDATE messages SET machine_open_count = 3 WHERE id = ?', a[2].message_id);
    const live = (await t.api.get(`/api/campaigns/${c.id}/ab`)).data;
    expect(live.variants.map((v: any) => [v.key, v.opened, v.open_rate])).toEqual([['A', 1, 20], ['B', 4, 80]]);
    expect(live.best_now).toBe('B');

    // Before the time nothing happens.
    await t.app.tick();
    expect((await get(c.id)).status).toBe('testing');
    expect(recipients(c.id).filter((r) => r.status === 'held')).toHaveLength(10);

    // After the time the winner is chosen and goes to the rest.
    later(c.id, { decide_at: new Date(Date.now() - 1000).toISOString() });
    mails.length = 0;
    await t.app.tick();
    cur = await get(c.id);
    expect(cur.status).toBe('sent');
    expect(cur.ab).toMatchObject({ phase: 'winner', winner: 'B', decided_by: 'auto' });
    expect(cur.ab.snapshot).toHaveLength(2);
    expect(mails).toHaveLength(10);
    expect(mails.every((m) => m.subject === 'Zweiter Betreff' && m.fromName === 'Anna von Firma')).toBe(true);
    expect(recipients(c.id).filter((r) => r.status === 'sent')).toHaveLength(20);
    expect(recipients(c.id).filter((r) => r.variant === 'B')).toHaveLength(15);
    // The held ones are not counted in the test numbers.
    expect((await t.api.get(`/api/campaigns/${c.id}/ab`)).data.variants.map((v: any) => v.sent)).toEqual([5, 15]);
  });

  it('the winner can be chosen by hand while it waits', async () => {
    await contacts(12, 'abhand');
    const c = await camp({ filter: { tags: ['abhand'] }, ab: { variants: [{}, { subject: 'Variante B' }], test_percent: 50, wait_hours: 24 } });
    await t.api.post(`/api/campaigns/${c.id}/send`, {});
    expect((await get(c.id)).status).toBe('testing');
    mails.length = 0;
    expect((await t.api.post(`/api/campaigns/${c.id}/ab/winner`, { key: 'Z' })).status).toBe(400);
    const r = await t.api.post(`/api/campaigns/${c.id}/ab/winner`, { key: 'B' });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ winner: 'B', decided_by: 'manual' });
    await t.app.tick();
    expect(mails).toHaveLength(6);
    expect(mails.every((m) => m.subject === 'Variante B')).toBe(true);
    expect((await get(c.id)).status).toBe('sent');
    // Too late for another choice.
    expect((await t.api.post(`/api/campaigns/${c.id}/ab/winner`, { key: 'A' })).status).toBe(400);
  });

  it('without a single open the original goes out ("keine Daten")', async () => {
    await contacts(10, 'abnodata');
    const c = await camp({ filter: { tags: ['abnodata'] }, ab: { variants: [{}, { subject: 'Andere' }], test_percent: 50, wait_hours: 1 } });
    await t.api.post(`/api/campaigns/${c.id}/send`, {});
    later(c.id, { decide_at: new Date(Date.now() - 1000).toISOString() });
    mails.length = 0;
    await t.app.tick();
    const cur = await get(c.id);
    expect(cur.ab).toMatchObject({ winner: 'A', decided_by: 'fallback' });
    expect(mails.every((m) => m.subject === 'Hauptbetreff')).toBe(true);
    expect(cur.ab_results.note).toContain('keine Daten');
  });

  it('revenue decides when it is the measure: a paid invoice after the mail counts for its variant', async () => {
    await contacts(20, 'abrev');
    const c = await camp({ filter: { tags: ['abrev'] }, ab: { variants: [{}, { subject: 'Preis-Betreff' }], test_percent: 50, metric: 'revenue', wait_hours: 6 } });
    await t.api.post(`/api/campaigns/${c.id}/send`, {});
    const rows = recipients(c.id).filter((r) => r.variant === 'A');
    // One buyer in A (EUR 300), and plenty of opens in B (which do not matter for this measure).
    const buyer = rows[0].contact_id;
    t.app.db.insert('invoices', { id: newId(), location_id: loc, kind: 'invoice', number: `AB-${newId(6)}`, contact_id: buyer, title: 'Kauf', items: [], currency: 'EUR', subtotal_cents: 30000, tax_cents: 0, total_cents: 30000, status: 'paid', public_token: newId(20), issued_at: new Date().toISOString(), paid_at: new Date(Date.now() + 1000).toISOString(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    for (const r of recipients(c.id).filter((x) => x.variant === 'B')) open(r.message_id);
    const res = (await t.api.get(`/api/campaigns/${c.id}/ab`)).data;
    expect(res.variants[0]).toMatchObject({ key: 'A', buyers: 1, revenue_cents: 30000, revenue_per_recipient_cents: 6000 });
    expect(res.variants[1]).toMatchObject({ key: 'B', revenue_cents: 0, opened: 5 });
    later(c.id, { decide_at: new Date(Date.now() - 1000).toISOString() });
    await t.app.tick();
    expect((await get(c.id)).ab).toMatchObject({ winner: 'A', decided_by: 'auto' });
  });

  it('a paid invoice from before the mail, or from long after it, does not count', async () => {
    await contacts(10, 'abwin');
    const c = await camp({ filter: { tags: ['abwin'] }, ab: { variants: [{}, { subject: 'Fenster' }], test_percent: 50, metric: 'revenue', wait_hours: 6 } });
    await t.api.post(`/api/campaigns/${c.id}/send`, {});
    const [r0, r1] = recipients(c.id).filter((r) => r.variant === 'A');
    const mk = (contact: string, paidAt: string) => t.app.db.insert('invoices', { id: newId(), location_id: loc, kind: 'invoice', number: `W-${newId(6)}`, contact_id: contact, title: 'x', items: [], currency: 'EUR', subtotal_cents: 100, tax_cents: 0, total_cents: 5000, status: 'paid', public_token: newId(20), issued_at: paidAt, paid_at: paidAt, created_at: paidAt, updated_at: paidAt });
    mk(r0.contact_id, new Date(Date.now() - 86_400_000).toISOString());
    mk(r1.contact_id, new Date(Date.now() + 20 * 86_400_000).toISOString());
    const res = (await t.api.get(`/api/campaigns/${c.id}/ab`)).data;
    expect(res.variants[0].revenue_cents).toBe(0);
  });

  it('a very small audience is sent normally and says why there was no test', async () => {
    await contacts(3, 'abtiny');
    mails.length = 0;
    const c = await camp({ filter: { tags: ['abtiny'] }, ab: { variants: [{}, { subject: 'B' }] } });
    await t.api.post(`/api/campaigns/${c.id}/send`, {});
    const cur = await get(c.id);
    expect(cur.status).toBe('sent');
    expect(mails).toHaveLength(3);
    expect(mails.every((m) => m.subject === 'Hauptbetreff')).toBe(true);
    expect(cur.ab.skipped).toMatch(/Zu wenige/);
    expect(cur.ab_results.note).toMatch(/Zu wenige/);
  });

  it('cancelling a waiting test skips the held recipients', async () => {
    await contacts(10, 'abcancel');
    const c = await camp({ filter: { tags: ['abcancel'] }, ab: { variants: [{}, { subject: 'B' }], test_percent: 50 } });
    await t.api.post(`/api/campaigns/${c.id}/send`, {});
    await t.api.post(`/api/campaigns/${c.id}/cancel`, {});
    const rows = recipients(c.id);
    expect(rows.filter((r) => r.status === 'held')).toHaveLength(0);
    expect(rows.filter((r) => r.status === 'skipped')).toHaveLength(5);
    expect((await get(c.id)).status).toBe('sent');
  });

  it('refuses an A/B test on SMS and variants without a footer in the designer', async () => {
    const sms = await t.api.post('/api/campaigns', { name: 'SMS', channel: 'sms', body: 'x', ab: { variants: [{}, { subject: 'B' }] } });
    expect(sms.status).toBe(200);
    expect(sms.data.ab ?? null).toBeNull();
    const mail = await camp({ filter: { tags: ['nobody'] } });
    expect((await t.api.patch(`/api/campaigns/${mail.id}`, { ab: { variants: [{}, {}] } })).status).toBe(400);
    expect((await t.api.patch(`/api/campaigns/${mail.id}`, { channel: 'sms', ab: { variants: [{}, { subject: 'x' }] } })).data.ab).toBeNull();
  });

  it('a variant can be tried out with a test mail', async () => {
    const [cid] = await contacts(1, 'abtest-mail');
    const c = await camp({ filter: { tags: ['nobody'] }, ab: { variants: [{}, { subject: 'Variante B', sender_name: 'Berta' }] } });
    mails.length = 0;
    const r = await t.api.post(`/api/campaigns/${c.id}/test`, { contact_id: cid, variant: 'B' });
    expect(r.status).toBe(200);
    expect(mails[0]).toMatchObject({ subject: '[TEST] Variante B', fromName: 'Berta' });
  });
});

describe('resend to non-openers', () => {
  it('after the waiting time everybody who did not open gets the mail again under a new subject', async () => {
    const ids = await contacts(10, 'rs');
    mails.length = 0;
    const c = await camp({ filter: { tags: ['rs'] }, subject: 'Erste Mail', resend: { enabled: true, subject: 'Hast du das gesehen?', after_hours: 48 } });
    expect(c.resend).toMatchObject({ enabled: true, subject: 'Hast du das gesehen?', after_hours: 48, status: 'waiting' });
    await t.api.post(`/api/campaigns/${c.id}/send`, {});
    expect((await get(c.id)).status).toBe('sent');
    expect(mails).toHaveLength(10);

    // Four people opened or clicked; a machine open and an unopened mail are non-openers.
    const rows = recipients(c.id);
    for (const r of rows.slice(0, 3)) open(r.message_id);
    t.app.db.run('UPDATE messages SET clicked_at = ? WHERE id = ?', new Date().toISOString(), rows[3].message_id);
    t.app.db.run('UPDATE messages SET machine_open_count = 5 WHERE id = ?', rows[4].message_id);

    const info = (await get(c.id)).resend_info;
    expect(info).toMatchObject({ status: 'waiting', preview: 6 });
    expect(Date.parse(info.due_at)).toBeGreaterThan(Date.now() + 47 * 3600_000);

    // Not yet due.
    await t.app.tick();
    expect(t.app.db.all('SELECT id FROM campaigns WHERE parent_id = ?', c.id)).toHaveLength(0);

    // Due: the follow-up is created and sent in the same tick.
    t.app.db.run('UPDATE campaigns SET sent_at = ? WHERE id = ?', new Date(Date.now() - 49 * 3600_000).toISOString(), c.id);
    mails.length = 0;
    await t.app.tick();
    const children = t.app.db.all<any>('SELECT * FROM campaigns WHERE parent_id = ?', c.id);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ subject: 'Hast du das gesehen?', channel: 'email', status: 'sent', name: 'Test – Erinnerung' });
    expect(JSON.parse(children[0].filter)).toEqual({ resend_of: c.id });
    expect(mails).toHaveLength(6);
    expect(mails.every((m) => m.subject === 'Hast du das gesehen?')).toBe(true);
    const opened = new Set(rows.slice(0, 4).map((r) => r.contact_id));
    const got = new Set(t.app.db.all<{ contact_id: string }>('SELECT contact_id FROM campaign_recipients WHERE campaign_id = ?', children[0].id).map((r) => r.contact_id));
    for (const o of opened) expect(got.has(o)).toBe(false);
    expect(got.size).toBe(6);
    expect(new Set(ids).size).toBe(10);

    // Only once.
    const done = await get(c.id);
    expect(done.resend).toMatchObject({ status: 'created', child_id: children[0].id });
    await t.app.tick();
    expect(t.app.db.all('SELECT id FROM campaigns WHERE parent_id = ?', c.id)).toHaveLength(1);
  });

  it('skips people who unsubscribed or have no consent since', async () => {
    const ids = await contacts(4, 'rsdnd');
    const c = await camp({ filter: { tags: ['rsdnd'] }, subject: 'Mail', resend: { subject: 'Nochmal', after_hours: 1 } });
    await t.api.post(`/api/campaigns/${c.id}/send`, {});
    t.app.db.run('UPDATE contacts SET dnd = 1 WHERE id = ?', ids[0]);
    t.app.db.run('UPDATE campaigns SET sent_at = ? WHERE id = ?', new Date(Date.now() - 2 * 3600_000).toISOString(), c.id);
    mails.length = 0;
    await t.app.tick();
    expect(mails).toHaveLength(3);
    expect(mails.some((m) => m.to.startsWith('rsdnd') && m.to === t.app.db.get<{ email: string }>('SELECT email FROM contacts WHERE id = ?', ids[0])!.email)).toBe(false);
  });

  it('when everybody read it there is nobody to remind', async () => {
    await contacts(3, 'rsall');
    const c = await camp({ filter: { tags: ['rsall'] }, subject: 'Mail', resend: { subject: 'Nochmal', after_hours: 1 } });
    await t.api.post(`/api/campaigns/${c.id}/send`, {});
    for (const r of recipients(c.id)) open(r.message_id);
    t.app.db.run('UPDATE campaigns SET sent_at = ? WHERE id = ?', new Date(Date.now() - 2 * 3600_000).toISOString(), c.id);
    await t.app.tick();
    expect(t.app.db.all('SELECT id FROM campaigns WHERE parent_id = ?', c.id)).toHaveLength(0);
    expect((await get(c.id)).resend).toMatchObject({ status: 'skipped' });
  });

  it('can be set up for a campaign that is already sent, and started at once', async () => {
    await contacts(5, 'rsnow');
    const c = await camp({ filter: { tags: ['rsnow'] }, subject: 'Mail' });
    expect((await t.api.post(`/api/campaigns/${c.id}/resend`, { subject: 'Nochmal' })).status).toBe(400); // still a draft
    await t.api.post(`/api/campaigns/${c.id}/send`, {});
    expect((await t.api.post(`/api/campaigns/${c.id}/resend`, { subject: 'Mail' })).status).toBe(400); // same subject
    const set = await t.api.post(`/api/campaigns/${c.id}/resend`, { subject: 'Zweiter Versuch', after_hours: 24 });
    expect(set.status).toBe(200);
    expect(set.data.resend_info).toMatchObject({ subject: 'Zweiter Versuch', status: 'waiting', preview: 5 });
    mails.length = 0;
    const now = await t.api.post(`/api/campaigns/${c.id}/resend`, { subject: 'Zweiter Versuch', now: true });
    expect(now.status).toBe(200);
    expect(now.data.child_id).toBeTruthy();
    await t.app.tick();
    expect(mails).toHaveLength(5);
    expect(mails.every((m) => m.subject === 'Zweiter Versuch')).toBe(true);
    // Once created it cannot be created again or removed.
    expect((await t.api.post(`/api/campaigns/${c.id}/resend`, { subject: 'Dritter Versuch' })).status).toBe(400);
    expect((await t.api.del(`/api/campaigns/${c.id}/resend`)).status).toBe(400);
  });

  it('a draft keeps its setup in the campaign and can drop it again', async () => {
    const c = await camp({ filter: { tags: ['nobody'] }, subject: 'Mail', resend: { subject: 'Nochmal' } });
    expect(c.resend).toMatchObject({ enabled: true });
    expect((await t.api.patch(`/api/campaigns/${c.id}`, { resend: null })).data.resend).toBeNull();
    expect((await t.api.patch(`/api/campaigns/${c.id}`, { resend: { subject: 'Mail' } })).status).toBe(400);
  });
});

describe('A/B results over MCP', () => {
  it('lists the campaigns with a test and shows one in detail – read only, no content', async () => {
    const m = await mcpClient(t, loc);
    expect((await m.tools()).map((x) => x.name)).toContain('ghl_campaign_ab_results');
    const list = await m.rpc('ghl_campaign_ab_results');
    expect(list.error).toBe(false);
    const withTest = (list.json as any[]).filter((c) => c.ab);
    expect(withTest.length).toBeGreaterThan(0);
    const one = await m.rpc('ghl_campaign_ab_results', { campaign_id: withTest[0].id });
    expect(one.error).toBe(false);
    expect(one.json.ab.variants.length).toBeGreaterThanOrEqual(2);
    expect(one.json.ab.variants[0]).toHaveProperty('open_rate');
    expect(one.json).not.toHaveProperty('body');
    expect((await m.rpc('ghl_campaign_ab_results', { campaign_id: 'gibtsnicht' })).error).toBe(true);
  });
});
