import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify, type ECDH } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { b64u, encryptPayload, fromB64u, generateVapidKeys, isPushEndpoint, setPushFetch, vapidAuthorization, vapidJwt } from '../server/services/webpush.js';

/** A browser's push subscription: its own P-256 key pair and auth secret. */
function device(endpoint: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, sub: { endpoint, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } } };
}

/** Receiver side of RFC 8291, written out with plain HMACs (independent of the sender's hkdf). */
function decrypt(body: Buffer, ua: ECDH, auth: Buffer): string {
  const hmac = (key: Buffer, ...data: Buffer[]) => createHmac('sha256', key).update(Buffer.concat(data)).digest();
  const salt = body.subarray(0, 16);
  expect(body.readUInt32BE(16)).toBe(4096);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const shared = ua.computeSecret(asPublic);
  const ikm = hmac(hmac(auth, shared), Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])).subarray(0, 12);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(-16));
  const plain = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
  let i = plain.length - 1;
  while (plain[i] === 0) i--;
  expect(plain[i]).toBe(2); // last-record delimiter
  return plain.subarray(0, i).toString('utf8');
}

const sent: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
let answer = 201;
const fakePush = async (url: string, init: { headers: Record<string, string>; body: Uint8Array }) => {
  sent.push({ url, headers: init.headers, body: Buffer.from(init.body) });
  return { status: answer, text: async () => (answer >= 400 ? 'gone' : '') };
};
const until = async (fn: () => boolean) => {
  for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
};

describe('Web Push crypto', () => {
  it('reproduces the RFC 8291 test vector', () => {
    const body = encryptPayload('When I grow up, I want to be a watermelon', 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg', {
      asPrivate: fromB64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
      salt: fromB64u('DGv6ra1nlYgDCS1FRnbzlw'),
    });
    expect(b64u(body)).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('encrypts so the browser can decrypt it', () => {
    const d = device('https://fcm.googleapis.com/fcm/send/x');
    const body = encryptPayload('{"title":"Hallo Ü"}', d.sub.keys.p256dh, d.sub.keys.auth);
    expect(decrypt(body, d.ecdh, d.auth)).toBe('{"title":"Hallo Ü"}');
    expect(() => encryptPayload('x', 'AAAA', d.sub.keys.auth)).toThrow();
    expect(() => encryptPayload('x'.repeat(5000), d.sub.keys.p256dh, d.sub.keys.auth)).toThrow();
  });

  it('signs a VAPID JWT (ES256) the push service can verify', () => {
    const keys = generateVapidKeys();
    expect(fromB64u(keys.publicKey)).toHaveLength(65);
    expect(fromB64u(keys.privateKey)).toHaveLength(32);
    const jwt = vapidJwt('https://fcm.googleapis.com', 'mailto:chef@example.com', keys, 1_790_000_000);
    const [h, c, s] = jwt.split('.');
    expect(JSON.parse(fromB64u(h).toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(fromB64u(c).toString())).toEqual({ aud: 'https://fcm.googleapis.com', exp: 1_790_000_000 + 12 * 3600, sub: 'mailto:chef@example.com' });
    const sig = fromB64u(s);
    expect(sig).toHaveLength(64); // raw r||s, not DER
    const pub = fromB64u(keys.publicKey);
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, sig)).toBe(true);
    const header = vapidAuthorization('https://updates.push.services.mozilla.com/wpush/v2/abc', 'mailto:a@b.de', keys);
    expect(header).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${keys.publicKey}$`));
    expect(JSON.parse(fromB64u(header.slice(8).split('.')[1]).toString()).aud).toBe('https://updates.push.services.mozilla.com');
  });

  it('only talks to known push services', () => {
    for (const ok of ['https://fcm.googleapis.com/fcm/send/a', 'https://updates.push.services.mozilla.com/wpush/v2/a', 'https://wns2-par02p.notify.windows.com/w/?token=a', 'https://web.push.apple.com/abc']) expect(isPushEndpoint(ok)).toBe(true);
    for (const bad of ['http://fcm.googleapis.com/a', 'https://evil.example.com/a', 'https://fcm.googleapis.com.evil.com/a', 'https://127.0.0.1/a', 'https://fcm.googleapis.com:8443/a', 'nonsense']) expect(isPushEndpoint(bad)).toBe(false);
  });
});

describe('push notifications', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  let loc = '';
  let me: any;
  const mine = device('https://fcm.googleapis.com/fcm/send/admin-phone');
  beforeAll(async () => {
    setPushFetch(fakePush as any);
    t = await startTestApp();
    me = (await t.setup()).user;
    loc = t.api.location;
  });
  afterAll(async () => {
    setPushFetch();
    await t.close();
  });
  const last = () => sent[sent.length - 1];
  const payloadOf = (s: (typeof sent)[number], d = mine) => JSON.parse(decrypt(s.body, d.ecdh, d.auth));

  it('hands out the VAPID key and stores subscriptions per user', async () => {
    const k = (await t.api.get('/api/push/public-key')).data.key;
    expect(fromB64u(k)).toHaveLength(65);
    expect(t.app.db.get('SELECT public_key FROM push_keys').public_key).toBe(k);
    expect(t.app.db.get('SELECT private_key FROM push_keys').private_key).toMatch(/^v1:/); // sealed
    expect((await t.api.post('/api/push/subscribe', { subscription: { ...mine.sub, endpoint: 'https://evil.example.com/x' } })).status).toBe(400);
    expect((await t.api.post('/api/push/subscribe', { subscription: { ...mine.sub, keys: { p256dh: 'AAAA', auth: 'BBBB' } } })).status).toBe(400);
    expect((await t.api.post('/api/push/test')).status).toBe(400); // nothing subscribed yet
    const r = await t.api.post('/api/push/subscribe', { subscription: mine.sub });
    expect(r.status).toBe(200);
    expect(r.data.devices).toHaveLength(1);
    await t.api.post('/api/push/subscribe', { subscription: mine.sub }); // idempotent
    const st = (await t.api.get('/api/push')).data;
    expect(st.devices).toHaveLength(1);
    expect(st.prefs).toEqual({ messages: true, uptime: true, tasks: true, payments: true, feedback: true, canvas: true, chat: true, courses: true, wiki: true, werkstatt: true, inbox: true, booking: true, workflows: true, office: true, ops: true, checkin: true, companion_event: true });
    expect(Object.keys(st.kinds).sort()).toEqual(['booking', 'canvas', 'chat', 'checkin', 'companion_event', 'courses', 'feedback', 'inbox', 'messages', 'office', 'ops', 'payments', 'tasks', 'uptime', 'werkstatt', 'wiki', 'workflows']);
  });

  it('sends an encrypted test notification with VAPID headers', async () => {
    const r = await t.api.post('/api/push/test');
    expect(r.data).toMatchObject({ users: 1, sent: 1, failed: 0 });
    const s = last();
    expect(s.url).toBe(mine.sub.endpoint);
    expect(s.headers['content-encoding']).toBe('aes128gcm');
    expect(s.headers.ttl).toBe('86400');
    expect(s.headers.authorization).toMatch(/^vapid t=.+, k=.+$/);
    expect(payloadOf(s)).toMatchObject({ title: 'Test-Benachrichtigung', url: '/app/settings/account', kind: 'test' });
    expect((await t.api.get('/api/push/latest')).data).toMatchObject({ title: 'Test-Benachrichtigung' });
  });

  it('pushes new inbound messages to the team, once per conversation burst', async () => {
    const urls = (await t.api.get('/api/settings/inbound')).data;
    const n = sent.length;
    await t.api.raw(urls.sms.replace('http://localhost', ''), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: '+491701234567', body: 'Hallo, haben Sie morgen Zeit?' }) });
    await t.app.events.flush();
    expect(sent.length).toBe(n + 1);
    const p = payloadOf(last());
    expect(p.title).toBe('Neue SMS von +491701234567');
    expect(p.body).toBe('Hallo, haben Sie morgen Zeit?');
    expect(p.url).toMatch(/^\/app\/conversations\/\w+$/);
    expect(p.location_id).toBe(loc);
    await t.api.raw(urls.sms.replace('http://localhost', ''), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: '+491701234567', body: 'Noch was' }) });
    await t.app.events.flush();
    expect(sent.length).toBe(n + 1);

    // Turned off in the preferences: nothing.
    expect((await t.api.put('/api/push/prefs', { messages: false })).data.messages).toBe(false);
    await t.api.raw(urls.sms.replace('http://localhost', ''), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: '+491709999999', body: 'Hallo' }) });
    await t.app.events.flush();
    expect(sent.length).toBe(n + 1);
    await t.api.put('/api/push/prefs', { messages: true });
  });

  it('pushes when a website goes down', async () => {
    t.app.events.emit(loc, 'website.down', { website: 'https://kunde.de', status: 503, ms: 120 });
    await t.app.events.flush();
    const p = payloadOf(last());
    expect(p).toMatchObject({ title: '⚠️ Testfirma ist nicht erreichbar', url: '/app/project', kind: 'uptime' });
    expect(p.body).toContain('503');
    expect(last().headers.urgency).toBe('high');
  });

  it('pushes tasks assigned to someone else and the ones due today', async () => {
    const member = (await t.api.post('/api/users', { email: 'mia@example.com', password: 'geheim123', name: 'Mia', role: 'member', locations: [loc] })).data;
    const phone = device('https://updates.push.services.mozilla.com/wpush/v2/mia');
    t.app.db.run('INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)', 'sub-mia', member.id, phone.sub.endpoint, phone.sub.keys.p256dh, phone.sub.keys.auth, new Date().toISOString());

    const n = sent.length;
    await t.api.post('/api/tasks', { title: 'Selbst erledigen' }); // assigned to me by default: no push
    const task = (await t.api.post('/api/tasks', { title: 'Angebot nachfassen', assigned_to: member.id, due_at: '2026-10-09T09:00:00.000Z' })).data;
    await until(() => sent.length > n);
    expect(sent.length).toBe(n + 1);
    expect(last().url).toBe(phone.sub.endpoint);
    expect(payloadOf(last(), phone)).toMatchObject({ title: 'Neue Aufgabe für dich', body: 'Angebot nachfassen · fällig 09.10.', url: '/app/tasks' });
    await t.api.patch(`/api/tasks/${task.id}`, { title: 'Angebot nachfassen!' }); // same assignee: no repeat
    await new Promise((r) => setTimeout(r, 30));
    expect(sent.length).toBe(n + 1);

    // Created by a workflow (no request): found by the scheduler.
    t.app.db.run('INSERT INTO tasks (id, location_id, title, description, due_at, assigned_to, done, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)', 'wf-task', loc, 'Rückruf', '', null, member.id, new Date().toISOString());
    // Due today (10:00 in Berlin), one summary per person and day.
    const at = new Date('2026-10-05T08:00:00.000Z');
    t.app.db.run('INSERT INTO tasks (id, location_id, title, description, due_at, assigned_to, done, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)', 'due-1', loc, 'Rechnung schreiben', '', '2026-10-05T00:00:00.000Z', member.id, '2026-10-01T08:00:00.000Z');
    t.app.db.run('INSERT INTO tasks (id, location_id, title, description, due_at, assigned_to, done, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)', 'due-2', loc, 'Website prüfen', '', '2026-10-05T15:00:00.000Z', member.id, '2026-10-01T08:00:00.000Z');
    t.app.db.run('INSERT INTO tasks (id, location_id, title, description, due_at, assigned_to, done, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)', 'due-3', loc, 'Morgen', '', '2026-10-06T09:00:00.000Z', member.id, '2026-10-01T08:00:00.000Z');
    await t.app.services.scanTaskPushes(new Date('2026-10-05T05:00:00.000Z')); // fixed instant before the 08:00 summary, so the real date never matters
    await until(() => sent.length > n + 1);
    expect(payloadOf(last(), phone).title).toBe('Neue Aufgabe für dich');
    const before = sent.length;
    await t.app.services.scanTaskPushes(new Date('2026-10-05T05:00:00.000Z')); // 07:00 in Berlin: too early
    expect(sent.length).toBe(before);
    await t.app.services.scanTaskPushes(at);
    expect(sent.length).toBe(before + 1);
    expect(payloadOf(last(), phone)).toMatchObject({ title: '2 Aufgaben heute fällig', body: 'Rechnung schreiben · Website prüfen' });
    await t.app.services.scanTaskPushes(at);
    expect(sent.length).toBe(before + 1);
  });

  it('drops subscriptions the push service reports as gone', async () => {
    answer = 410;
    const r = await t.app.services.pushNotify({ userIds: [me.id], kind: 'test', title: 'x' });
    answer = 201;
    expect(r).toMatchObject({ sent: 0, removed: 1 });
    expect((await t.api.get('/api/push')).data.devices).toHaveLength(0);
    await t.api.post('/api/push/subscribe', { subscription: mine.sub });
    expect((await t.api.del(`/api/push/subscribe?endpoint=${encodeURIComponent(mine.sub.endpoint)}`)).data.devices).toHaveLength(0);
  });

  it('serves a web app manifest with the branding', async () => {
    const r = await t.api.raw('/manifest.webmanifest');
    expect(r.headers.get('content-type')).toContain('application/manifest+json');
    const m = await r.json();
    expect(m).toMatchObject({ start_url: '/app', scope: '/app', display: 'standalone', name: 'HyperLevel', short_name: 'HyperLevel' });
    expect(m.icons.map((i: any) => i.sizes)).toEqual(['192x192', '512x512', '1024x1024', '512x512', 'any']);
    // headsets and glasses: their own window, one window, any orientation (docs/xr.md)
    expect(m).toMatchObject({ display_override: ['standalone', 'minimal-ui'], orientation: 'any', launch_handler: { client_mode: ['navigate-existing', 'auto'] } });
    expect(m.shortcuts.map((s: any) => s.url)).toContain('/app/workspace');
    expect(m.icons.some((i: any) => i.purpose === 'maskable')).toBe(true);
    await t.api.patch('/api/agency/branding', { name: 'HyperLevel', color: '#1d4ed8' });
    expect(await (await t.api.raw('/manifest.webmanifest')).json()).toMatchObject({ name: 'HyperLevel', short_name: 'HyperLevel', theme_color: '#1d4ed8' });
  });
});
