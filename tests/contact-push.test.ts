import { createECDH, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { setPushFetch } from '../server/services/webpush.js';
import { signVisitor } from '../server/services/attribution.js';

const pushed: { url: string; headers: Record<string, string> }[] = [];
const device = () => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${randomBytes(8).toString('hex')}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
};

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  setPushFetch(async (url, init) => {
    pushed.push({ url, headers: init.headers });
    return { status: url.includes('gone') ? 410 : 201, text: async () => '' };
  });
});
afterAll(async () => {
  setPushFetch();
  await t.close();
});

describe('web push to contacts', () => {
  it('opt-in page and service worker only when switched on', async () => {
    expect((await t.api.raw(`/push/${loc}/subscribe`)).status).toBe(404);
    const r = await t.api.put('/api/settings/channels/push', { enabled: true, button: 'News', title: 'Neuigkeiten', text: 'Kurz und selten.' });
    expect(r.data).toMatchObject({ enabled: true, button: 'News', subscribers: 0 });
    const page = await t.api.raw(`/push/${loc}/subscribe?a=abc.def`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    const html = await page.text();
    expect(html).toContain('Neuigkeiten');
    expect(html).toContain('data-attr="abc.def"');
    expect(html).toContain(`/push/${loc}/subscribe.js`);
    expect((await t.api.raw(`/push/${loc}/sw.js`)).headers.get('content-type')).toContain('javascript');
  });

  it('stores subscriptions, links them via the visitor token or a later form, and sends', async () => {
    const bad = await t.api.raw(`/api/public/push/${loc}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subscription: { endpoint: 'https://evil.example/push', keys: device().keys } }) });
    expect(bad.status).toBe(400);
    // visitor known by attribution, contact created later by a form
    const contact = (await t.api.post('/api/contacts', { first_name: 'Pia', email: 'pia@example.com' })).data;
    const vid = 'visitor0123456789abcd';
    t.app.db.run('INSERT INTO attribution_visitors (location_id, visitor_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)', loc, vid, new Date().toISOString(), new Date().toISOString());
    const d1 = device();
    let r = await t.api.raw(`/api/public/push/${loc}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subscription: d1, attr: signVisitor('test-secret', vid) }) });
    expect(await r.json()).toEqual({ ok: true, linked: false });
    // the visitor fills in a form → attribution links → the subscription follows
    t.app.services.attribution.capture(undefined, loc, contact.id, 'form', { visitorId: vid });
    expect(t.app.db.get('SELECT contact_id FROM contact_push_subs WHERE endpoint = ?', d1.endpoint).contact_id).toBe(contact.id);
    // a second device of an already linked visitor is linked right away
    const d2 = { ...device(), endpoint: 'https://fcm.googleapis.com/fcm/send/gone-device' };
    r = await t.api.raw(`/api/public/push/${loc}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subscription: d2, attr: signVisitor('test-secret', vid) }) });
    expect(await r.json()).toEqual({ ok: true, linked: true });

    const st = await t.api.get(`/api/messages/channels/status?contact_id=${contact.id}`);
    expect(st.data.channels.push).toMatchObject({ reachable: true, devices: 2 });
    const sent = await t.api.post('/api/messages', { contact_id: contact.id, channel: 'push', subject: 'Neu im Shop', body: 'Herbst-Rabatt 20 %', url: 'https://example.com/shop' });
    expect(sent.data).toMatchObject({ channel: 'push', status: 'sent', devices: 1 });
    expect(pushed.map((p) => p.url)).toEqual([d1.endpoint, d2.endpoint]);
    expect(pushed[0].headers.authorization).toMatch(/^vapid t=.+, k=/);
    // the gone device was removed
    expect(t.app.db.get('SELECT COUNT(*) n FROM contact_push_subs WHERE contact_id = ?', contact.id).n).toBe(1);
  });

  it('workflow action „Push an Kontakt“ and the funnel bell', async () => {
    const contact = t.app.db.get(`SELECT * FROM contacts WHERE email = 'pia@example.com'`);
    const wf = await t.api.post('/api/workflows', { name: 'Push', trigger: { type: 'manual', config: {} }, steps: [{ id: 'p', type: 'push_contact', title: 'Hallo {{contact.first_name}}', body: 'Dein Termin ist bestätigt', url: 'https://example.com/termin' }] });
    expect(wf.status).toBe(200);
    await t.api.patch(`/api/workflows/${wf.data.id}`, { status: 'active' });
    const n = pushed.length;
    const r = await t.api.post(`/api/workflows/${wf.data.id}/enroll`, { contact_ids: [contact.id] });
    expect(r.status).toBe(200);
    await t.app.events.flush();
    for (let i = 0; i < 20 && pushed.length === n; i++) await new Promise((res) => setTimeout(res, 25));
    expect(pushed.length).toBe(n + 1);
    const msg = t.app.db.get(`SELECT * FROM messages WHERE contact_id = ? AND channel = 'push' ORDER BY created_at DESC LIMIT 1`, contact.id);
    expect(msg).toMatchObject({ subject: 'Hallo Pia', body: 'Dein Termin ist bestätigt', source: 'Workflow', status: 'sent' });
    // funnel pages get the bell button
    const f = (await t.api.post('/api/funnels', { name: 'Herbst' })).data;
    await t.api.post(`/api/funnels/${f.id}/pages`, { name: 'Start' });
    const page = await (await t.api.raw(`/p/${f.slug}`)).text();
    expect(page).toContain(`/push/${loc}/subscribe`);
    expect(page).toContain('🔔 News');
  });
});
