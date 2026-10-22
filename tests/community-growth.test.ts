import { createECDH } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { sha256, token } from '../server/core/util.js';
import { addDaysYmd, ymdInTz } from '../server/core/time.js';
import { setPushFetch } from '../server/services/webpush.js';
import { analytics, cleanBroadcast, cleanSegment, segmentContacts } from '../server/services/community-growth.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let g: any;
let ch = '';
const people: Record<string, any> = {};
const cookies: Record<string, string> = {};
const pushes: { url: string; body: string }[] = [];
const iso = (daysAgo: number, hour = 10) => {
  const d = new Date(Date.now() - daysAgo * 864e5);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  t.app.services.memberMailer = async () => ({ status: 'sent' });
  t.app.services.communityMailer = async () => ({ status: 'sent' });
  setPushFetch(async (url, init) => {
    pushes.push({ url, body: Buffer.from(init.body).toString('base64') });
    return { status: 201, text: async () => '' };
  });
});
afterAll(async () => {
  setPushFetch();
  await t.close();
});

const settle = () => t.app.events.flush();
const base = () => `/portal/${loc}/community`;
function memberCookie(contactId: string) {
  const raw = token(32);
  t.app.db.run('INSERT INTO member_sessions (token_hash, location_id, contact_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', sha256(raw), loc, contactId, new Date().toISOString(), new Date(Date.now() + 864e5).toISOString());
  return `pm_${loc}=${raw}`;
}
const get = (path: string, cookie = '') => t.api.raw(path, { redirect: 'manual', headers: cookie ? { cookie } : {} });
const page = async (path: string, cookie: string) => {
  const r = await get(path, cookie);
  return { status: r.status, html: await r.text(), headers: r.headers };
};
const post = (path: string, data: Record<string, string> | [string, string][], cookie: string) =>
  t.api.raw(path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams(data as any).toString() });
const csrfOf = (html: string) => html.match(/name="csrf" value="([^"]+)"/)![1];
async function submit(pagePath: string, action: string, data: Record<string, string> | [string, string][], cookie: string) {
  const { html } = await page(pagePath, cookie);
  const fields: [string, string][] = Array.isArray(data) ? data : Object.entries(data);
  const r = await post(action, [['csrf', csrfOf(html)], ...fields], cookie);
  return { status: r.status, location: r.headers.get('location') ?? '', html: r.status === 200 || r.status >= 400 ? await r.text() : '' };
}
const gUrl = () => `${base()}/g/${g.slug}`;
const putExt = (body: any) => t.api.put(`/api/community/groups/${g.id}/ext`, body);
const visit = async (name: string) => (await page(gUrl(), cookies[name])).html;

describe('community growth', () => {
  it('sets up a group', async () => {
    for (const n of ['anna', 'ben', 'cara', 'dora', 'emil']) {
      people[n] = (await t.api.post('/api/contacts', { email: `${n}@example.de`, first_name: n[0].toUpperCase() + n.slice(1), tags: ['mitglied'] })).data;
      cookies[n] = memberCookie(people[n].id);
    }
    g = (await t.api.post('/api/community/groups', { name: 'Wachstum', access: { mode: 'tags', tags: ['mitglied'] } })).data;
    ch = g.channels[0].id;
    expect(g.slug).toBe('wachstum');
  });
});

describe('welcome', () => {
  it('sends a message and a post to a new member, once, with their name', async () => {
    await putExt({ welcome: { dm: { enabled: true, sender: 'Sabine', text: 'Hallo {{name}}, willkommen in {{group}}!' }, post: { enabled: true, channel_id: ch, title: 'Neu hier: {{name}}', body: 'Sagt Hallo zu {{mention}}' } } });
    await visit('anna');
    await settle();
    const dm = t.app.db.get<any>(`SELECT m.* FROM community_dm_messages m WHERE m.body LIKE 'Hallo %'`);
    expect(dm.body).toBe('Hallo Anna, willkommen in Wachstum!');
    expect(dm.sender_name).toBe('Sabine');
    const inbox = await page(`${base()}/messages`, cookies.anna);
    expect(inbox.html).toContain('willkommen in Wachstum');
    const post = t.app.db.get<any>(`SELECT * FROM community_posts WHERE title = 'Neu hier: Anna'`);
    expect(post.body).toMatch(/Sagt Hallo zu @\S+/);
    expect(post.author_name).toBe('Sabine');
    // Visiting again does not welcome twice.
    await visit('anna');
    await settle();
    expect(t.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM community_dm_messages WHERE body LIKE 'Hallo Anna%'`)!.n).toBe(1);
    expect(t.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM community_posts WHERE title = 'Neu hier: Anna'`)!.n).toBe(1);
    // Off by default: nobody else is welcomed when both are off.
    await putExt({ welcome: { dm: { enabled: false }, post: { enabled: false } } });
    await visit('ben');
    await settle();
    expect(t.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM community_dm_messages WHERE body LIKE 'Hallo Ben%'`)!.n).toBe(0);
  });

  it('rejects settings that point somewhere else', async () => {
    expect((await putExt({ welcome: { post: { channel_id: 'fremd' } } })).status).toBe(400);
    expect((await putExt({ affiliate: { program_id: 'fremd' } })).status).toBe(400);
  });
});

describe('onboarding checklist and "Start here"', () => {
  it('shows the checklist to new members, ticks what they did and lets them hide it', async () => {
    const first = await visit('cara');
    expect(first).toContain('So startest du');
    expect(first).toContain('0 von 4');
    expect(first).toContain('/profile'); // link of the profile item
    const profile = await submit(`${base()}/profile`, `${base()}/profile`, { display_name: 'Cara', bio: 'Ich mache Podcasts und liebe Kaffee.' }, cookies.cara);
    expect(profile.status).toBe(200);
    const r = await submit(gUrl(), `${gUrl()}/posts`, { title: 'Hallo, ich bin Cara', body: 'Podcasterin', channel_id: ch }, cookies.cara);
    expect(r.status).toBe(303);
    const after = await visit('cara');
    expect(after).toContain('2 von 4'); // profile + intro
    const dismiss = await submit(gUrl(), `${gUrl()}/checklist/dismiss`, {}, cookies.cara);
    expect(dismiss.status).toBe(303);
    expect(await visit('cara')).not.toContain('So startest du');
  });

  it('supports custom items and ends after the window', async () => {
    await putExt({ welcome: { checklist: { enabled: true, days: 30, items: [{ id: 'regeln', label: 'Die Regeln gelesen', kind: 'custom' }, { id: 'like', label: 'Einen Beitrag liken', kind: 'like' }] } } });
    expect(await visit('dora')).toContain('Die Regeln gelesen');
    const html = await visit('dora');
    expect(html).toContain('0 von 2');
    expect((await submit(gUrl(), `${gUrl()}/checklist/regeln/done`, {}, cookies.dora)).status).toBe(303);
    expect(await visit('dora')).toContain('1 von 2');
    expect((await submit(gUrl(), `${gUrl()}/checklist/unbekannt/done`, {}, cookies.dora)).status).toBe(404);
    t.app.db.run('UPDATE community_members SET joined_at = ? WHERE group_id = ? AND contact_id = ?', iso(40), g.id, people.dora.id);
    expect(await visit('dora')).not.toContain('So startest du');
    // Off: not shown at all.
    await putExt({ welcome: { checklist: { enabled: false } } });
    expect(await visit('emil')).not.toContain('So startest du');
    await putExt({ welcome: { checklist: { enabled: true } } });
  });

  it('highlights the "Start here" post until it was read', async () => {
    const p = (await t.api.post(`/api/community/groups/${g.id}/posts`, { title: 'Willkommen – so funktioniert alles', body: 'Lies das zuerst', channel_id: ch, pinned: true })).data;
    await putExt({ start_here: { post_id: p.id, label: 'Hier starten' } });
    const before = await visit('ben');
    expect(before).toContain('Los geht’s');
    expect(before).toContain('Willkommen – so funktioniert alles');
    await page(`${gUrl()}/p/${p.id}`, cookies.ben); // opening it marks it read
    expect(await visit('ben')).not.toContain('Los geht’s');
  });
});

describe('segments and the member filter', () => {
  it('filters members by level, activity and tier – only inside this group', async () => {
    const today = ymdInTz(new Date(), 'Europe/Berlin');
    const mark = (c: any, daysAgo: number) => t.app.db.run('INSERT OR IGNORE INTO community_active_days (group_id, contact_id, day) VALUES (?, ?, ?)', g.id, c.id, addDaysYmd(today, -daysAgo));
    for (const n of ['anna', 'ben', 'cara', 'dora', 'emil']) await visit(n);
    t.app.db.run('DELETE FROM community_active_days WHERE group_id = ?', g.id); // only the days set here count
    mark(people.anna, 0);
    mark(people.ben, 20);
    mark(people.cara, 2);
    t.app.db.run('UPDATE community_members SET level = 3 WHERE group_id = ? AND contact_id = ?', g.id, people.cara.id);
    const ids = (seg: any) => segmentContacts(t.app, g, cleanSegment(t.app, g, seg)).map((c) => c.id).sort();
    const all = Object.values(people).map((p: any) => p.id).sort();
    expect(ids({})).toEqual(all);
    expect(ids({ min_level: 3 })).toEqual([people.cara.id]);
    expect(ids({ active_days: 7 })).toEqual([people.anna.id, people.cara.id].sort());
    expect(ids({ inactive_days: 7 })).toEqual(all.filter((i) => i !== people.anna.id && i !== people.cara.id));
    expect(() => cleanSegment(t.app, g, { tier_ids: ['fremd'] })).toThrow(/Stufen/);
    expect(() => cleanSegment(t.app, g, { min_level: 500 })).toThrow();
    // The same filter in the contact list and for campaigns.
    const list = await t.api.get(`/api/contacts?community_group=${g.id}&community_min_level=3`);
    expect(list.data.contacts.map((c: any) => c.id)).toEqual([people.cara.id]);
    const none = await t.api.get(`/api/contacts?community_group=gibtsnicht`);
    expect(none.data.contacts).toEqual([]);
    const outsider = (await t.api.post('/api/contacts', { email: 'draussen@example.de', first_name: 'Draussen' })).data;
    expect((await t.api.get(`/api/contacts?community_group=${g.id}`)).data.contacts.map((c: any) => c.id)).not.toContain(outsider.id);
    // Another sub-account never sees this group's members through the filter.
    const other = (await t.api.post('/api/locations', { name: 'Andere Firma' })).data;
    t.api.setLocation(other.id);
    await t.api.post('/api/contacts', { email: 'fremd@example.de', first_name: 'Fremd' });
    expect((await t.api.get(`/api/contacts?community_group=${g.id}`)).data.contacts).toEqual([]);
    t.api.setLocation(loc);
  });
});

describe('broadcasts', () => {
  it('previews a segment and validates what is sent', async () => {
    const pv = await t.api.post(`/api/community/groups/${g.id}/broadcasts/preview`, { segment: { min_level: 3 } });
    expect(pv.data).toEqual({ members: 1, email: 1, push: 0 });
    expect(() => cleanBroadcast(t.app, g, { subject: '', body: 'x' })).toThrow();
    expect(() => cleanBroadcast(t.app, g, { subject: 'x', body: 'y', channels: ['fax'] })).toThrow(/Kanäle/);
    expect((await t.api.post(`/api/community/groups/${g.id}/broadcasts`, { subject: 'Niemand', body: 'x', segment: { min_level: 9 } })).status).toBe(400);
  });

  it('sends e-mail through a campaign, push straight to devices and an entry in the bell', async () => {
    // Cara has a phone: a real-looking subscription (the push service itself is faked).
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const raw = t.app.services.contactPushRaw as any;
    raw.subscribe(loc, people.cara.id, { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: token(16) } }, 'test');
    expect(raw.devices(loc, people.cara.id)).toBe(1);
    expect(() => raw.subscribe(loc, people.cara.id, { endpoint: 'https://evil.example/push', keys: { p256dh: 'x', auth: 'y' } })).toThrow();
    const r = await t.api.post(`/api/community/groups/${g.id}/broadcasts`, { subject: 'Neuer Kurs ist da', body: 'Schaut **rein**!', channels: ['email', 'push', 'bell'], segment: { active_days: 7 } });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ recipients: 2, bell: 2, push: 1 });
    expect(r.data.email.campaign_id).toBeTruthy();
    await (t.app.services.communityPush as any)?.flush(); // a second push (bell hook plus channel) would show up here
    expect(pushes).toHaveLength(1);
    expect(pushes[0].url).toBe('https://fcm.googleapis.com/fcm/send/abc123');
    await t.app.tick();
    const camp = t.app.db.get<any>('SELECT * FROM campaigns WHERE id = ?', r.data.email.campaign_id);
    expect(camp.status).toBe('sent');
    expect(camp.body).toContain('<strong>rein</strong>');
    const rec = t.app.db.all<any>('SELECT contact_id, status FROM campaign_recipients WHERE campaign_id = ?', camp.id);
    expect(rec.map((x) => x.contact_id).sort()).toEqual([people.anna.id, people.cara.id].sort());
    expect(t.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM community_notifications WHERE kind = 'announcement' AND text = 'Neuer Kurs ist da'`)!.n).toBe(2);
    const hist = (await t.api.get(`/api/community/groups/${g.id}/broadcasts`)).data.broadcasts;
    expect(hist[0]).toMatchObject({ subject: 'Neuer Kurs ist da', recipients: 2, status: 'sent', channels: ['email', 'push', 'bell'] });
  });

  it('schedules a broadcast, takes it back and sends the due ones', async () => {
    const at = new Date(Date.now() + 3 * 36e5).toISOString();
    const a = await t.api.post(`/api/community/groups/${g.id}/broadcasts`, { subject: 'Später', body: 'Bis dann', channels: ['bell'], scheduled_at: at });
    expect(a.data.scheduled).toBe(true);
    const row = (await t.api.get(`/api/community/groups/${g.id}/broadcasts`)).data.broadcasts.find((b: any) => b.id === a.data.id);
    expect(row.status).toBe('scheduled');
    expect(t.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM community_notifications WHERE text = 'Später'`)!.n).toBe(0);
    expect((await t.api.del(`/api/community/broadcasts/${a.data.id}`)).status).toBe(200);
    expect((await t.api.del(`/api/community/broadcasts/${a.data.id}`)).status).toBe(400);
    const b = await t.api.post(`/api/community/groups/${g.id}/broadcasts`, { subject: 'Gleich', body: 'Bald', channels: ['bell'], scheduled_at: at });
    t.app.db.run('UPDATE community_broadcast_queue SET due_at = ? WHERE broadcast_id = ?', new Date(Date.now() - 1000).toISOString(), b.data.id);
    await t.app.tick();
    expect(t.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM community_notifications WHERE text = 'Gleich'`)!.n).toBe(5);
    expect(t.app.db.get<{ status: string }>('SELECT status FROM community_broadcasts WHERE id = ?', b.data.id)!.status).toBe('sent');
  });
});

describe('analytics', () => {
  it('counts members, DAU, posts, contributors, MRR, churn and trials', async () => {
    const monthly = (await t.api.post('/api/products', { name: 'Club monatlich', price_cents: 2900, tax_rate: 0, recurring: 'month' })).data;
    const yearly = (await t.api.post('/api/products', { name: 'Club jährlich', price_cents: 24000, tax_rate: 0, recurring: 'year' })).data;
    const tier = (await t.api.post(`/api/community/groups/${g.id}/tiers`, { name: 'Pro', product_id: monthly.id, annual_product_id: yearly.id, trial_days: 7 })).data;
    const mk = (n: string, status: string, billing: string, extra: Record<string, any> = {}) => {
      const c = people[n];
      t.app.db.run('DELETE FROM community_memberships WHERE group_id = ? AND contact_id = ?', g.id, c.id);
      t.app.db.insert('community_memberships', { id: token(8), location_id: loc, group_id: g.id, contact_id: c.id, tier_id: tier.id, status, source: 'join', billing, answers: {}, joined_at: iso(10), requested_at: iso(10), created_at: iso(10), updated_at: iso(10), ...extra });
    };
    mk('anna', 'active', 'month');
    mk('ben', 'active', 'year');
    mk('cara', 'trialing', 'month', { trial_started_at: iso(3), trial_ends_at: iso(-4) });
    mk('dora', 'canceled', 'month', { joined_at: iso(20), canceled_at: iso(5), trial_started_at: iso(20), trial_ends_at: iso(13) });
    mk('emil', 'active', 'month', { trial_started_at: iso(12), trial_ends_at: iso(5), converted_at: iso(5) });
    t.app.db.run('DELETE FROM community_members WHERE group_id = ? AND contact_id = ?', g.id, people.dora.id);
    const a = (await t.api.get(`/api/community/groups/${g.id}/analytics?days=30`)).data;
    expect(a.range).toMatchObject({ days: 30, tz: 'Europe/Berlin' });
    expect(a.members).toHaveLength(30);
    expect(a.members.at(-1).total).toBe(a.totals.members);
    expect(a.totals.members).toBe(4); // Dora left
    // Revenue: Anna 29 € + Ben 240 € / 12 = 20 €; Emil converted: 29 €; Cara's trial is listed apart.
    expect(a.revenue).toMatchObject({ currency: 'EUR', mrr_cents: 2900 + 2000 + 2900, trial_mrr_cents: 2900, paying: 3, trialing: 1 });
    expect(a.revenue.arr_cents).toBe(a.revenue.mrr_cents * 12);
    expect(a.revenue.by_tier[0]).toMatchObject({ name: 'Pro', members: 4 });
    expect(a.churn).toMatchObject({ left: 1, paying_left: 1 });
    expect(a.churn.paying_rate).toBeGreaterThan(0);
    // Trials: Cara runs, Dora lost, Emil converted → 1 of 2 finished.
    expect(a.trials).toMatchObject({ started: 3, converted: 1, lost: 1, conversion_rate: 50 });
    expect(a.totals.posts).toBeGreaterThanOrEqual(3);
    expect(a.activity.reduce((n: number, d: any) => n + d.posts, 0)).toBe(a.totals.posts);
    expect(a.dau.at(-1).n).toBeGreaterThanOrEqual(1);
    expect(a.totals.mau).toBeGreaterThanOrEqual(1);
    expect(a.totals.engagement_rate).toBeGreaterThan(0);
    expect(a.top_contributors.length).toBeGreaterThan(0);
    expect(a.top_contributors[0]).toMatchObject({ points: expect.any(Number), posts: expect.any(Number) });
    expect(a.requests).toMatchObject({ pending: 0 });
    // Days are clamped, a short range is allowed, other groups are not readable.
    expect((await t.api.get(`/api/community/groups/${g.id}/analytics?days=9999`)).data.range.days).toBe(366);
    expect((await t.api.get(`/api/community/groups/${g.id}/analytics?days=1`)).data.range.days).toBe(7);
    expect((await t.api.get('/api/community/groups/gibtsnicht/analytics')).status).toBe(404);
    const ov = (await t.api.get('/api/community/overview')).data;
    expect(ov[0]).toMatchObject({ name: 'Wachstum', members: 4, mrr_cents: 7800 });
    expect(analytics(t.app, g, 30).totals.members).toBe(4);
  });
});

describe('partner links for members', () => {
  it('links a program, lets members sign up and shows their link and numbers', async () => {
    const prog = (await t.api.post('/api/affiliates/programs', { name: 'Community-Partner', commission_value: 20, auto_approve: true })).data;
    expect((await t.api.put(`/api/community/groups/${g.id}/join/page`, { slug: 'wachstum-club', enabled: true })).status).toBe(200);
    expect((await t.api.put(`/api/community/groups/${g.id}/affiliate`, { program_id: 'fremd' })).status).toBe(404);
    expect((await t.api.put(`/api/community/groups/${g.id}/affiliate`, { program_id: prog.id, point_links: true })).data.program_id).toBe(prog.id);
    expect(t.app.db.get<{ landing_url: string }>('SELECT landing_url FROM affiliate_programs WHERE id = ?', prog.id)!.landing_url).toBe('http://localhost/c/wachstum-club');
    const admin = (await t.api.get(`/api/community/groups/${g.id}/affiliate`)).data;
    expect(admin.program).toMatchObject({ name: 'Community-Partner', active: true, affiliates: 0 });
    const tab = await visit('anna');
    expect(tab).toContain('Partner</a>');
    const invite = await page(`${gUrl()}/partner`, cookies.anna);
    expect(invite.html).toContain('Partner werden');
    expect(invite.html).toContain('20 % Provision');
    const noTerms = await post(`${gUrl()}/partner`, [['csrf', csrfOf(invite.html)]], cookies.anna);
    expect(noTerms.status).toBe(400);
    const signed = await submit(`${gUrl()}/partner`, `${gUrl()}/partner`, { accept: '1' }, cookies.anna);
    expect(signed.status).toBe(303);
    const mine = await page(`${gUrl()}/partner`, cookies.anna);
    expect(mine.html).toMatch(/value="http:\/\/localhost\/c\/wachstum-club\?ref=[a-z0-9]+"/);
    expect(mine.html).toContain('Klicks');
    expect(t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM affiliates WHERE contact_id = ?', people.anna.id)!.n).toBe(1);
    // A second sign-up does not make a second affiliate.
    await submit(gUrl(), `${gUrl()}/partner`, { accept: '1' }, cookies.anna);
    expect(t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM affiliates WHERE contact_id = ?', people.anna.id)!.n).toBe(1);
    // Without a program there is no tab and no page.
    await t.api.put(`/api/community/groups/${g.id}/affiliate`, { program_id: '' });
    expect((await page(`${gUrl()}/partner`, cookies.anna)).status).toBe(404);
    await settle();
  });
});
