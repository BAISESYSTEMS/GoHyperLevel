import { createECDH } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { sha256, token } from '../server/core/util.js';
import { iconPng, ICON_KINDS } from '../server/services/community-icons.js';
import { manifestOf, swJs } from '../server/services/community-pwa.js';
import { encodePng } from '../server/services/canvas-png.js';
import { setPushFetch } from '../server/services/webpush.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let g: any;
let ch = '';
let anna: any, ben: any;
let annaC = '', benC = '';
const sent: { cid: string; title: string; body: string; url?: string; tag?: string }[] = [];

beforeAll(async () => {
  t = await startTestApp();
  setPushFetch(async () => ({ status: 201, text: async () => '' })); // the push services never see a request
  await t.setup();
  loc = t.api.location;
  t.app.services.memberMailer = async () => ({ status: 'sent' });
  t.app.services.communityMailer = async () => ({ status: 'sent' });
  expect((await t.api.patch(`/api/agency/locations/${loc}/branding`, { name: 'Kaffeeschule Müller', color: '#b45309' })).status).toBe(200);
  anna = (await t.api.post('/api/contacts', { email: 'anna@example.de', first_name: 'Anna', tags: ['mitglied'] })).data;
  ben = (await t.api.post('/api/contacts', { email: 'ben@example.de', first_name: 'Ben', tags: ['mitglied'] })).data;
  g = (await t.api.post('/api/community/groups', { name: 'Barista-Club', access: { mode: 'tags', tags: ['mitglied'] } })).data;
  ch = g.channels[0].id;
  [annaC, benC] = [anna, ben].map((c) => memberCookie(c.id));
  await page(gUrl(), annaC);
  await page(gUrl(), benC);
  // The push service is replaced by a spy: what would go to the devices ends up in `sent`.
  const raw = t.app.services.contactPushRaw as any;
  const realSend = raw.send;
  raw.send = async (l: string, cid: string, p: any) => {
    sent.push({ cid, ...p });
    return realSend.call(raw, l, cid, p).catch(() => 0);
  };
});
afterAll(async () => {
  setPushFetch();
  await t.close();
});

const base = () => `/portal/${loc}`;
const gUrl = () => `${base()}/community/g/${g.slug}`;
function memberCookie(contactId: string) {
  const raw = token(32);
  t.app.db.run('INSERT INTO member_sessions (token_hash, location_id, contact_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', sha256(raw), loc, contactId, new Date().toISOString(), new Date(Date.now() + 864e5).toISOString());
  return `pm_${loc}=${raw}`;
}
const get = (path: string, cookie = '') => t.api.raw(path, { redirect: 'manual', headers: cookie ? { cookie } : {} });
const page = async (path: string, cookie = '') => {
  const r = await get(path, cookie);
  return { status: r.status, html: await r.text(), headers: r.headers };
};
const post = (path: string, data: Record<string, string> | [string, string][], cookie: string) =>
  t.api.raw(path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams(data as any).toString() });
const csrfOf = (html: string) => html.match(/name="csrf" value="([^"]+)"/)![1];
async function submit(pagePath: string, action: string, data: Record<string, string>, cookie: string) {
  const { html } = await page(pagePath, cookie);
  const r = await post(action, [['csrf', csrfOf(html)], ...Object.entries(data)], cookie);
  return { status: r.status, location: r.headers.get('location') ?? '', html: r.status === 200 || r.status >= 400 ? await r.text() : '' };
}
const device = (cookie: string, endpoint: string, headers: Record<string, string> = { 'x-community-pwa': '1' }) => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return t.api.raw(`${base()}/community/push`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, ...headers }, body: JSON.stringify({ subscription: { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: token(16) } } }) });
};
const handleOf = (c: any) => t.app.db.get<{ handle: string }>('SELECT handle FROM community_profiles WHERE contact_id = ?', c.id)!.handle;

describe('app files', () => {
  it('serves a manifest with the client name, colour, icons and start page', async () => {
    const r = await get(`${base()}/manifest.webmanifest`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/manifest+json');
    const m = await r.json();
    expect(m).toMatchObject({ name: 'Kaffeeschule Müller', short_name: 'Kaffeeschule', display: 'standalone', theme_color: '#b45309', start_url: `${base()}/community?source=app`, scope: `${base()}/`, id: `${base()}/community` });
    expect(m.icons.map((i: any) => [i.sizes, i.purpose])).toEqual([['192x192', 'any'], ['512x512', 'any'], ['512x512', 'maskable']]);
    for (const i of m.icons) expect(i.src.startsWith(`${base()}/icon/`)).toBe(true);
    expect(manifestOf({ base: '/portal/x', name: '', color: 'rot' }).theme_color).toBe('#2563eb');
    expect((await get('/portal/gibtsnicht/manifest.webmanifest')).status).toBe(404);
  });

  it('draws PNG icons in the brand colour, with a maskable variant, and a logo when it is an embedded image', async () => {
    const sizes: Record<string, number> = { '192': 192, '512': 512, maskable: 512, apple: 180, favicon: 64 };
    for (const [kind, size] of Object.entries(sizes)) {
      const r = await get(`${base()}/icon/${kind}.png`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('image/png');
      const buf = Buffer.from(await r.arrayBuffer());
      expect(buf.subarray(1, 4).toString()).toBe('PNG');
      expect(buf.readUInt32BE(16)).toBe(size);
      expect(buf.readUInt32BE(20)).toBe(size);
    }
    expect((await get(`${base()}/icon/42.png`)).status).toBe(404);
    expect(Object.keys(ICON_KINDS)).toHaveLength(5);
    const letter = iconPng({ name: 'Müller', color: '#b45309' }, '192');
    expect(letter.equals(iconPng({ name: 'Müller', color: '#b45309' }, '192'))).toBe(true);
    expect(letter.equals(iconPng({ name: 'Zander', color: '#b45309' }, '192'))).toBe(false);
    expect(letter.equals(iconPng({ name: 'Müller', color: '#0f766e' }, '192'))).toBe(false);
    // A logo that is an embedded PNG replaces the letter; anything else (a link, junk) falls back to the letter.
    const logo = encodePng({ w: 4, h: 4, data: new Uint8Array(4 * 4 * 4).fill(40) });
    const withLogo = iconPng({ name: 'Müller', color: '#b45309', logo: `data:image/png;base64,${logo.toString('base64')}` }, '192');
    expect(withLogo.equals(letter)).toBe(false);
    expect(iconPng({ name: 'Müller', color: '#b45309', logo: 'https://example.com/logo.png' }, '192').equals(letter)).toBe(true);
    expect(iconPng({ name: 'Müller', color: '#b45309', logo: 'data:image/png;base64,AAAA' }, '192').equals(letter)).toBe(true);
  });

  it('serves the service worker, the offline page and the page script', async () => {
    const sw = await get(`${base()}/community-sw.js`);
    expect(sw.status).toBe(200);
    expect(sw.headers.get('content-type')).toContain('javascript');
    expect(sw.headers.get('service-worker-allowed')).toBe(`${base()}/`);
    const js = await sw.text();
    expect(js).toContain(`var BASE="${base()}"`);
    expect(js).toContain("addEventListener('push'");
    expect(js).toContain("addEventListener('notificationclick'");
    expect(swJs({ base: '/portal/a"b', name: 'x', color: '#000000' })).toContain('"/portal/a\\"b"');
    const off = await page(`${base()}/offline`);
    expect(off.status).toBe(200);
    expect(off.html).toContain('Du bist gerade offline');
    expect(off.html).toContain('Kaffeeschule Müller');
    expect(off.headers.get('content-security-policy')).toContain("default-src 'none'");
    const script = await get('/portal-pwa.js');
    expect(script.status).toBe(200);
    expect(await script.text()).toContain('beforeinstallprompt');
  });

  it('puts manifest, icons and the script on every community page', async () => {
    const r = await page(gUrl(), annaC);
    expect(r.html).toContain(`<link rel="manifest" href="${base()}/manifest.webmanifest">`);
    expect(r.html).toContain(`rel="apple-touch-icon" href="${base()}/icon/apple.png"`);
    expect(r.html).toContain('name="apple-mobile-web-app-capable"');
    expect(r.html).toContain('name="community-push-key"');
    expect(r.html).toContain('<script src="/portal-pwa.js" defer>');
    const csp = r.headers.get('content-security-policy')!;
    expect(csp).toContain("manifest-src 'self'");
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("script-src 'self'");
    // The member home and the course pages are part of the app as well (courses and community in one place): our own files only.
    const home = await page(base(), annaC);
    expect(home.html).toContain(`<link rel="manifest" href="${base()}/manifest.webmanifest">`);
    expect(home.headers.get('content-security-policy')).toContain("script-src 'self'");
    // Pages for people who are not logged in keep their strict policy (no scripts).
    const login = await page(base());
    expect(login.headers.get('content-security-policy')).not.toContain('script-src');
  });
});

describe('devices', () => {
  it('registers a device only for a logged-in member with the app header', async () => {
    const ep = 'https://fcm.googleapis.com/fcm/send/anna-1';
    expect((await device('', ep)).status).toBe(401);
    expect((await device(annaC, ep, {})).status).toBe(403);
    expect((await device(annaC, ep, { 'x-community-pwa': '1', 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await device(annaC, 'https://evil.example/push/1')).status).toBe(400);
    const ok = await device(annaC, ep);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, devices: 1 });
    expect(t.app.db.get<{ contact_id: string }>('SELECT contact_id FROM contact_push_subs WHERE endpoint = ?', ep)!.contact_id).toBe(anna.id);
    // The same device logging in as somebody else moves to that member.
    await device(benC, ep);
    expect(t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM contact_push_subs WHERE endpoint = ?', ep)!.n).toBe(1);
    expect(t.app.db.get<{ contact_id: string }>('SELECT contact_id FROM contact_push_subs WHERE endpoint = ?', ep)!.contact_id).toBe(ben.id);
    await device(annaC, ep);
    const un = await t.api.raw(`${base()}/community/push/unsubscribe`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: benC, 'x-community-pwa': '1' }, body: JSON.stringify({ endpoint: ep }) });
    expect((await un.json()).removed).toBe(false); // Ben no longer owns it
    const un2 = await t.api.raw(`${base()}/community/push/unsubscribe`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: annaC, 'x-community-pwa': '1' }, body: JSON.stringify({ endpoint: ep }) });
    expect((await un2.json()).removed).toBe(true);
    expect((await device(annaC, 'https://fcm.googleapis.com/fcm/send/anna-1')).status).toBe(200);
    expect((await device(benC, 'https://fcm.googleapis.com/fcm/send/ben-1')).status).toBe(200);
  });

  it('shows the switch for this device in the profile', async () => {
    const r = await page(`${base()}/community/profile`, annaC);
    expect(r.html).toContain('data-push-box');
    expect(r.html).toContain('push_dms');
  });
});

describe('push messages', () => {
  const flush = async () => {
    await t.app.events.flush();
    await (t.app.services.communityPush as any).flush();
  };
  const mine = (cid: string) => sent.filter((s) => s.cid === cid);

  it('pushes a direct message once per thread and half a minute, to the member who wants it', async () => {
    const r = await submit(`${base()}/community/messages/${handleOf(anna)}`, `${base()}/community/messages/${handleOf(anna)}`, { body: 'Hast du kurz Zeit für ein Rezept?' }, benC);
    expect(r.status).toBe(303);
    await flush();
    expect(mine(anna.id)).toHaveLength(1);
    expect(mine(anna.id)[0]).toMatchObject({ title: 'Ben', body: 'Hast du kurz Zeit für ein Rezept?' });
    expect(mine(anna.id)[0].url).toBe(`http://localhost/portal/${loc}/community/messages/${handleOf(ben)}`);
    await submit(`${base()}/community/messages/${handleOf(anna)}`, `${base()}/community/messages/${handleOf(anna)}`, { body: 'Noch eine Zeile' }, benC);
    await flush();
    expect(mine(anna.id)).toHaveLength(1); // throttled
    // A member who switched messages off hears nothing.
    await submit(`${base()}/community/profile`, `${base()}/community/profile`, { display_name: 'Anna', push_dms: '0', push_mentions: '1', push_replies: '1', push_announcements: '1', push_posts: '0' }, annaC);
    expect(t.app.db.get<{ dms: number }>('SELECT dms FROM community_push_prefs WHERE contact_id = ?', anna.id)!.dms).toBe(0);
    await t.api.post(`/api/community/messages/${anna.id}`, { body: 'Team hier' });
    await flush();
    expect(mine(anna.id)).toHaveLength(1);
    await submit(`${base()}/community/profile`, `${base()}/community/profile`, { display_name: 'Anna', push_dms: '1', push_mentions: '1', push_replies: '1', push_announcements: '1', push_posts: '0' }, annaC);
  });

  it('pushes mentions and replies with a link to the post, honouring each choice', async () => {
    const p = await submit(gUrl(), `${gUrl()}/posts`, { title: 'Welche Bohne?', body: `Was meint ihr, @${handleOf(ben)}?`, channel_id: ch }, annaC);
    expect(p.status).toBe(303);
    const pid = p.location.split('/p/')[1];
    await flush();
    const m = mine(ben.id).find((s) => s.body.includes('Welche Bohne') || s.body.includes('erwähnt'));
    expect(m).toBeTruthy();
    expect(m!.url).toContain(`/community/g/${g.slug}/p/${pid}`);
    expect(m!.title).toContain('Barista-Club');
    const before = mine(anna.id).length;
    await submit(`${gUrl()}/p/${pid}`, `${gUrl()}/p/${pid}/comments`, { body: 'Ich nehme die Äthiopische.' }, benC);
    await flush();
    expect(mine(anna.id).length).toBe(before + 1);
    expect(mine(anna.id).at(-1)!.url).toContain(`/p/${pid}`);
    // Likes do not push.
    const like = await submit(`${gUrl()}/p/${pid}`, `${gUrl()}/p/${pid}/like`, {}, benC);
    expect(like.status).toBe(303);
    await flush();
    expect(mine(anna.id).length).toBe(before + 1);
  });

  it('pushes announcements, and new posts only to members who asked for every post', async () => {
    const n = (await t.api.post(`/api/community/groups/${g.id}/posts`, { title: 'Neuer Workshop', body: 'Am Samstag', channel_id: ch, notify: true })).data;
    await flush();
    expect(mine(ben.id).some((s) => s.body.includes('Neuer Workshop'))).toBe(true);
    const all = sent.length;
    await submit(`${gUrl()}/posts`.replace('/posts', ''), `${gUrl()}/posts`, { title: 'Ein ganz normaler Beitrag', body: 'x', channel_id: ch }, annaC);
    await flush();
    expect(sent.slice(all).some((s) => s.body.includes('normaler Beitrag'))).toBe(false);
    await submit(`${base()}/community/profile`, `${base()}/community/profile`, { display_name: 'Ben', push_dms: '1', push_mentions: '1', push_replies: '1', push_announcements: '1', push_posts: '1' }, benC);
    const all2 = sent.length;
    await submit(gUrl(), `${gUrl()}/posts`, { title: 'Noch ein Beitrag', body: 'y', channel_id: ch }, annaC);
    await flush();
    const got = sent.slice(all2).filter((s) => s.cid === ben.id);
    expect(got).toHaveLength(1);
    expect(got[0].body).toBe('Anna: Noch ein Beitrag');
    expect(sent.slice(all2).some((s) => s.cid === anna.id)).toBe(false); // not to the author
    void n;
  });

  it('does not push into channels that are closed for the member', async () => {
    const vip = (await t.api.post(`/api/community/groups/${g.id}/channels`, { name: 'Profis' })).data;
    await t.api.put(`/api/community/channels/${vip.id}/rules`, { min_level: 5 });
    const all = sent.length;
    await t.api.post(`/api/community/groups/${g.id}/posts`, { title: 'Nur für Profis', body: 'geheim', channel_id: vip.id });
    await flush();
    expect(sent.slice(all).some((s) => s.body.includes('Nur für Profis'))).toBe(false);
  });
});
