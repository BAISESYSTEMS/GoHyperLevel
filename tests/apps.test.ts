import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { minimalMessage, RateLimiter, sectionOf, type NativeMessage } from '../server/services/native-push.js';
import { appConfig, cleanInstanceUrl, emailDomain, onColor } from '../server/services/app-brand.js';
import { compareVersions } from '../server/modules/desktop-app.js';

/**
 * Gray-label apps (docs/apps.md): discovery document, cloud directory, push relay (registration, minimal payloads, limits,
 * revocation) against a fake FCM/APNs, own keys, share, desktop updates. Two servers: `relay` plays the operator's cloud
 * instance (PGHL_PUSH_RELAY=1, PGHL_APP_DIRECTORY=1), `inst` a self-hosted instance that talks to it over HTTP.
 */

type Sent = { target: { provider: string; token: string }; msg: NativeMessage };
let relay: Awaited<ReturnType<typeof startTestApp>>;
let inst: Awaited<ReturnType<typeof startTestApp>>;
const sent: Sent[] = [];
const fakeTransport = {
  async send(target: { provider: string; token: string }, msg: NativeMessage) {
    sent.push({ target, msg });
    return target.token.includes('dead') ? { ok: false, gone: true, error: 'FCM 404' } : { ok: true };
  },
};
const ENV = ['PGHL_PUSH_RELAY', 'PGHL_APP_DIRECTORY', 'PGHL_PUSH_RELAY_URL', 'PGHL_PUSH_MODE'] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

let ghm = '';
let adminId = '';

async function bearer(t: typeof relay, method: string, path: string, tok: string, body?: unknown) {
  const r = await t.api.raw(path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const type = r.headers.get('content-type') ?? '';
  return { status: r.status, data: (type.includes('json') ? await r.json() : await r.text()) as any, headers: r.headers };
}

beforeAll(async () => {
  process.env.PGHL_PUSH_RELAY = '1';
  process.env.PGHL_APP_DIRECTORY = '1';
  relay = await startTestApp({ baseUrl: 'https://cloud.example.com' });
  relay.app.services.nativePushTransport = fakeTransport;
  await relay.setup();
  delete process.env.PGHL_PUSH_RELAY;
  delete process.env.PGHL_APP_DIRECTORY;
  delete process.env.PGHL_PUSH_MODE;
  process.env.PGHL_PUSH_RELAY_URL = relay.base;
  inst = await startTestApp({ baseUrl: 'https://crm.agentur.de' });
  const me = await inst.setup();
  adminId = me.user?.id ?? me.id;
  await inst.api.patch('/api/agency/branding', { name: 'Muster Agentur', color: '#ffcc00', logo_url: '/uploads/logo.png', support_email: 'hilfe@agentur.de' });
  ghm = (await inst.api.post('/api/mobile/pair', { device_name: 'Testhandy' })).data.token;
});
afterAll(async () => {
  for (const k of ENV) if (saved[k] === undefined) delete process.env[k];
  else process.env[k] = saved[k];
  await inst?.close();
  await relay?.close();
});

describe('pure helpers', () => {
  it('keeps pushes free of content unless preview is chosen', () => {
    const m = minimalMessage({ kind: 'messages', title: 'Neue E-Mail von Max', body: 'Angebot 5.000 €', url: '/app/conversations/c1?x=1', tag: 'conv-c1', badge: 3 });
    expect(m).toEqual({ kind: 'messages', title: 'Neue Nachricht', body: '', url: '/app/conversations', badge: 3, tag: 'messages' });
    expect(minimalMessage({ kind: 'weird kind!', title: 'x' }).title).toBe('Neue Nachricht');
    const p = minimalMessage({ kind: 'tasks', title: '<b>Heute</b> fällig', body: 'x'.repeat(500), url: '//evil.example' }, 'preview');
    expect(p.title).toBe('Heute fällig');
    expect(p.body).toHaveLength(160);
    expect(p.url).toBe('/app');
    expect(sectionOf('https://evil.example/app')).toBe('/app');
  });
  it('counts per minute', () => {
    let t = 0;
    const l = new RateLimiter(() => t);
    expect(l.take('a', 2)).toBe(true);
    expect(l.take('a', 2)).toBe(true);
    expect(l.take('a', 2)).toBe(false);
    expect(l.take('b', 2, 3)).toBe(false);
    t = 60_000;
    expect(l.take('a', 2)).toBe(true);
  });
  it('builds the app config and parses addresses', () => {
    const c = appConfig({ name: 'X', color: '#ffcc00', logo_url: '/uploads/l.png', mark_url: 'javascript:alert(1)' }, 'https://crm.x.de', { mode: 'relay', content: 'generic', providers: ['fcm'] });
    expect(c.logo).toBe('https://crm.x.de/uploads/l.png');
    expect(c.mark).toBeNull();
    expect(c.colors.on_primary).toBe('#000000');
    expect(onColor('#1d4ed8')).toBe('#ffffff');
    expect(emailDomain('Max@Agentur.DE')).toBe('agentur.de');
    expect(emailDomain('kein-at')).toBe('');
    expect(cleanInstanceUrl('https://crm.x.de/')).toBe('https://crm.x.de');
    expect(cleanInstanceUrl('http://crm.x.de')).toBe('');
    expect(cleanInstanceUrl('https://crm.x.de/app')).toBe('');
    expect(compareVersions('1.10.0', '1.9.3')).toBeGreaterThan(0);
    expect(compareVersions('1.2.0-beta.1', '1.2.0')).toBeLessThan(0);
  });
});

describe('discovery', () => {
  it('serves the branding as /.well-known/gohyperlevel-app.json', async () => {
    const r = await inst.api.raw('/.well-known/gohyperlevel-app.json');
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    const j = (await r.json()) as any;
    expect(j).toMatchObject({
      schema: 1,
      name: 'Muster Agentur',
      logo: 'https://crm.agentur.de/uploads/logo.png',
      colors: { primary: '#ffcc00', on_primary: '#000000' },
      api_base: 'https://crm.agentur.de',
      web_url: 'https://crm.agentur.de/app',
      support_email: 'hilfe@agentur.de',
      push: { mode: 'relay', content: 'generic' },
    });
    expect(j.icon).toMatch(/^https:\/\/crm\.agentur\.de\/pwa\/icon\/icon-512\.png\?v=\w+$/);
  });
  it('has no directory unless PGHL_APP_DIRECTORY=1', async () => {
    expect((await inst.api.get('/api/app-directory/lookup?email=a@b.de')).status).toBe(404);
  });
  it('maps e-mail domains and agency codes to instances (operator entries)', async () => {
    expect((await relay.api.post('/api/app-directory', { kind: 'domain', key: 'agentur.de', instance_url: 'https://crm.agentur.de/app' })).status).toBe(400);
    expect((await relay.api.post('/api/app-directory', { kind: 'domain', key: 'agentur.de', instance_url: 'https://crm.agentur.de', name: 'Muster' })).status).toBe(200);
    expect((await relay.api.post('/api/app-directory', { kind: 'code', key: 'muster', instance_url: 'https://crm.agentur.de' })).status).toBe(200);
    const pub = (q: string) => relay.api.raw(`/api/app-directory/lookup?${q}`).then(async (r) => ({ status: r.status, data: (await r.json()) as any }));
    expect(await pub('email=max%40agentur.de')).toMatchObject({ status: 200, data: { instance_url: 'https://crm.agentur.de', name: 'Muster' } });
    expect((await pub('email=max%40mail.agentur.de')).data.matched).toEqual({ kind: 'domain', key: 'agentur.de' });
    expect((await pub('code=Muster')).data.instance_url).toBe('https://crm.agentur.de');
    expect((await pub('email=max%40unbekannt.de')).status).toBe(404);
    expect((await pub('email=quatsch')).status).toBe(400);
    // members of the public cannot add entries
    expect((await relay.api.raw('/api/app-directory', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
  });
  it('lets a domain owner claim a domain with a DNS TXT record', async () => {
    relay.app.services.dnsTxt = async (name: string) => (name === '_gohyperlevel-app.kunde.de' ? [['gohyperlevel-app=', 'https://crm.kunde.de']] : []);
    relay.app.services.appDirectoryFetch = async (url: string) => ({
      status: url === 'https://crm.kunde.de/.well-known/gohyperlevel-app.json' ? 200 : 404,
      json: async () => ({ schema: 1, api_base: 'https://crm.kunde.de', name: 'Kunde GmbH' }),
    });
    const claim = (domain: string, instance_url: string) => relay.api.raw('/api/app-directory/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domain, instance_url }) });
    expect((await claim('kunde.de', 'https://crm.kunde.de')).status).toBe(200);
    expect((await (await relay.api.raw('/api/app-directory/lookup?email=a%40kunde.de')).json() as any).name).toBe('Kunde GmbH');
    expect((await claim('fremd.de', 'https://crm.kunde.de')).status).toBe(400); // no TXT record
    relay.app.services.dnsTxt = async () => [['gohyperlevel-app=https://crm.kunde.de']];
    expect((await claim('agentur.de', 'https://crm.kunde.de')).status).toBe(409); // the operator's entry wins
  });
});

describe('push relay', () => {
  it('registers the instance on the first app token and keeps only a handle', async () => {
    const r = await bearer(inst, 'POST', '/api/mobile/push-token', ghm, { provider: 'fcm', token: 'fcm-token-aaaaaaaaaaaaaaaaaaaaaaaa', app_id: 'com.hyperdesk.app' });
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ ok: true, mode: 'relay' });
    const row = inst.app.db.get('SELECT * FROM app_push_tokens');
    expect(row.ref).toMatch(/^rh_/);
    expect(JSON.stringify(inst.app.db.all('SELECT * FROM app_push_tokens'))).not.toContain('fcm-token-aaaa');
    const status = (await inst.api.get('/api/agency/app-push')).data;
    expect(status).toMatchObject({ mode: 'relay', relay_registered: true, devices: 1 });
    const instances = (await relay.api.get('/api/push-relay/admin/instances')).data;
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({ url: 'https://crm.agentur.de', name: 'Muster Agentur', status: 'active', devices: 1 });
    // a browser session cannot register app tokens
    expect((await inst.api.post('/api/mobile/push-token', { provider: 'fcm', token: 'x'.repeat(30) })).status).toBe(403);
  });

  it('sends every push of the instance through the relay without content', async () => {
    sent.length = 0;
    await inst.app.services.pushNotify({ userIds: [adminId], kind: 'messages', title: 'Neue E-Mail von Max Mustermann', body: 'Geheimes Angebot über 5.000 €', url: '/app/conversations/conv123', tag: 'conv-conv123' });
    expect(sent).toHaveLength(1);
    expect(sent[0].target).toEqual({ provider: 'fcm', token: 'fcm-token-aaaaaaaaaaaaaaaaaaaaaaaa' });
    expect(sent[0].msg).toMatchObject({ title: 'Neue Nachricht', body: '', kind: 'messages', url: '/app/conversations' });
    expect(JSON.stringify(sent)).not.toMatch(/Max|Geheim|conv123/);
    expect(inst.app.db.get('SELECT last_ok_at FROM app_push_tokens').last_ok_at).toBeTruthy();
  });

  it('adds a preview only when the admin chose it', async () => {
    expect((await inst.api.patch('/api/agency/app-push', { content: 'preview' })).data.content).toBe('preview');
    sent.length = 0;
    await inst.app.services.pushNotify({ userIds: [adminId], kind: 'messages', title: 'Neue E-Mail von Max', body: 'Hallo', url: '/app/conversations/c9' });
    expect(sent[0].msg).toMatchObject({ title: 'Neue E-Mail von Max', body: 'Hallo', url: '/app/conversations/c9' });
    await inst.api.patch('/api/agency/app-push', { content: 'generic' });
    expect((await inst.api.raw('/.well-known/gohyperlevel-app.json').then((r) => r.json()) as any).push.content).toBe('generic');
  });

  it('isolates handles per instance, drops dead tokens and re-applies the privacy rules', async () => {
    const a = (await relay.api.raw('/api/push-relay/instances', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://a.example', name: 'A' }) }).then((r) => r.json())) as any;
    const b = (await relay.api.raw('/api/push-relay/instances', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://b.example', name: 'B' }) }).then((r) => r.json())) as any;
    expect(a.token).toMatch(/^ghr_/);
    expect(relay.app.db.get('SELECT token_hash FROM push_relay_instances WHERE id = ?', a.instance_id).token_hash).not.toBe(a.token);
    const h1 = (await bearer(relay, 'POST', '/api/push-relay/devices', a.token, { provider: 'apns', token: 'apns-token-bbbbbbbbbbbbbbbbbbbbbb' })).data.handle;
    const again = (await bearer(relay, 'POST', '/api/push-relay/devices', a.token, { provider: 'apns', token: 'apns-token-bbbbbbbbbbbbbbbbbbbbbb' })).data.handle;
    expect(again).toBe(h1);
    const dead = (await bearer(relay, 'POST', '/api/push-relay/devices', a.token, { provider: 'fcm', token: 'dead-token-cccccccccccccccccccccc' })).data.handle;
    // B cannot use A's handle
    sent.length = 0;
    const foreign = await bearer(relay, 'POST', '/api/push-relay/send', b.token, { handles: [h1], kind: 'messages' });
    expect(foreign.data.results[0]).toMatchObject({ ok: false, gone: true });
    expect(sent).toHaveLength(0);
    // generic unless asked otherwise, however much the instance sends
    const r = await bearer(relay, 'POST', '/api/push-relay/send', a.token, { handles: [h1, dead], kind: 'messages', title: 'Max schreibt: Geheim', body: 'Inhalt', url: '/app/conversations/x1', badge: 4 });
    expect(r.data.results).toEqual([{ handle: h1, ok: true }, { handle: dead, ok: false, gone: true, error: 'FCM 404' }]);
    expect(sent[0]).toEqual({ target: { provider: 'apns', token: 'apns-token-bbbbbbbbbbbbbbbbbbbbbb' }, msg: { kind: 'messages', title: 'Neue Nachricht', body: '', url: '/app/conversations', badge: 4 } });
    expect(relay.app.db.get('SELECT handle FROM push_relay_devices WHERE handle = ?', dead)).toBeUndefined();
    // raw device tokens are stored sealed
    expect(JSON.stringify(relay.app.db.all('SELECT * FROM push_relay_devices'))).not.toContain('apns-token-bbbb');
    expect((await bearer(relay, 'POST', '/api/push-relay/send', 'ghr_wrong', { handles: [h1] })).status).toBe(401);
  });

  it('rate limits per instance and lets the operator revoke and restore', async () => {
    const a = (await relay.api.raw('/api/push-relay/instances', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://c.example' }) }).then((r) => r.json())) as any;
    const h = (await bearer(relay, 'POST', '/api/push-relay/devices', a.token, { provider: 'fcm', token: 'fcm-token-dddddddddddddddddddddddd' })).data.handle;
    expect((await relay.api.patch(`/api/push-relay/admin/instances/${a.instance_id}`, { rate_per_min: 2 })).data.rate_per_min).toBe(2);
    const send = () => bearer(relay, 'POST', '/api/push-relay/send', a.token, { handles: [h], kind: 'tasks' });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    const limited = await send();
    expect(limited.status).toBe(429);
    expect(limited.data.error).toContain('2 Mitteilungen je Minute');
    expect((await bearer(relay, 'GET', '/api/push-relay/status', a.token)).data).toMatchObject({ rejected: 1, sent: 2, rate_per_min: 2 });

    expect((await relay.api.post(`/api/push-relay/admin/instances/${a.instance_id}/revoke`, { reason: 'Missbrauch' })).data.status).toBe('revoked');
    const denied = await bearer(relay, 'POST', '/api/push-relay/devices', a.token, { provider: 'fcm', token: 'fcm-token-eeeeeeeeeeeeeeeeeeeeeeee' });
    expect(denied.status).toBe(403);
    expect(denied.data.error).toContain('Missbrauch');
    expect((await relay.api.post(`/api/push-relay/admin/instances/${a.instance_id}/restore`)).data.status).toBe('active');
    expect((await bearer(relay, 'GET', '/api/push-relay/status', a.token)).status).toBe(200);
    // an instance can withdraw itself; its handles die with it
    expect((await bearer(relay, 'DELETE', '/api/push-relay/instances/me', a.token)).status).toBe(200);
    expect((await bearer(relay, 'GET', '/api/push-relay/status', a.token)).status).toBe(403);
    expect(relay.app.db.get('SELECT COUNT(*) n FROM push_relay_devices WHERE instance_id = ?', a.instance_id).n).toBe(0);
    // only the operator manages instances
    expect((await relay.api.raw('/api/push-relay/admin/instances')).status).toBe(401);
  });

  it('a revoked instance gets the reason when it pushes', async () => {
    const id = (await relay.api.get('/api/push-relay/admin/instances')).data.find((i: any) => i.url === 'https://crm.agentur.de').id;
    await relay.api.post(`/api/push-relay/admin/instances/${id}/revoke`, { reason: 'Rechnung offen' });
    sent.length = 0;
    await inst.app.services.pushNotify({ userIds: [adminId], kind: 'messages', title: 'x' });
    expect(sent).toHaveLength(0);
    await relay.api.post(`/api/push-relay/admin/instances/${id}/restore`);
  });

  it('limits registrations per address', async () => {
    let last = 200;
    for (let i = 0; i < 12 && last !== 429; i++) {
      last = (await relay.api.raw('/api/push-relay/instances', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: `https://n${i}.example` }) })).status;
    }
    expect(last).toBe(429);
  });
});

describe('own keys (PGHL_PUSH_MODE=own)', () => {
  it('sends straight to FCM/APNs with the instance keys', async () => {
    process.env.PGHL_PUSH_MODE = 'own';
    inst.app.services.nativePushTransport = fakeTransport;
    try {
      expect((await inst.api.raw('/.well-known/gohyperlevel-app.json').then((r) => r.json()) as any).push.mode).toBe('own');
      const r = await bearer(inst, 'POST', '/api/mobile/push-token', ghm, { provider: 'apns', token: 'apns-own-ffffffffffffffffffffffff' });
      expect(r.data).toEqual({ ok: true, mode: 'own' });
      expect(JSON.stringify(inst.app.db.all('SELECT ref FROM app_push_tokens'))).not.toContain('apns-own-ffff');
      sent.length = 0;
      await inst.app.services.pushNotify({ userIds: [adminId], kind: 'tasks', title: 'Neue Aufgabe für dich: Vertrag', url: '/app/tasks' });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ target: { provider: 'apns', token: 'apns-own-ffffffffffffffffffffffff' }, msg: { kind: 'tasks', title: 'Neue Aufgabe', body: '', url: '/app/tasks' } });
    } finally {
      delete process.env.PGHL_PUSH_MODE;
      delete inst.app.services.nativePushTransport;
    }
  });
});

describe('share from the phone', () => {
  it('turns a link and a picture into a task', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const r = await bearer(inst, 'POST', '/api/mobile/share', ghm, { location_id: inst.api.location, url: 'https://example.com/angebot', text: 'Bitte ansehen', file: { name: 'foto.png', mime: 'image/png', data: png } });
    expect(r.status).toBe(200);
    expect(r.data.file_url).toMatch(/\/uploads\/\w+\.png$/);
    const task = inst.app.db.get('SELECT * FROM tasks WHERE id = ?', r.data.task_id);
    expect(task.title).toBe('Geteilt: foto.png');
    expect(task.description).toContain('https://example.com/angebot');
    expect((await bearer(inst, 'POST', '/api/mobile/share', ghm, { location_id: inst.api.location })).status).toBe(400);
    expect((await bearer(inst, 'POST', '/api/mobile/share', ghm, { location_id: inst.api.location, url: 'javascript:alert(1)' })).status).toBe(400);
  });
});

describe('desktop updates', () => {
  const upload = (version: string, target: string, body: Buffer, extra: Record<string, string> = {}) =>
    inst.api.raw('/api/desktop/app', { method: 'PUT', headers: { cookie: inst.api.cookie, 'x-pghl': '1', 'content-type': 'application/octet-stream', 'x-version': version, 'x-target': target, 'x-arch': 'x86_64', 'x-signature': 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXk=', 'x-file-name': `app-${version}.AppImage`, ...extra }, body });
  it('serves the newest signed bundle to older apps', async () => {
    expect((await inst.api.raw('/api/desktop/update/linux/x86_64/1.0.0')).status).toBe(204);
    expect((await upload('1.1.0', 'linux', Buffer.from('bundle-1.1.0'))).status).toBe(200);
    expect((await upload('1.2.0', 'linux', Buffer.from('bundle-1.2.0'))).status).toBe(200);
    expect((await upload('1.2.0', 'beos', Buffer.from('x'))).status).toBe(400);
    expect((await upload('1.3.0', 'linux', Buffer.from('x'), { 'x-signature': '' })).status).toBe(400);
    const r = await inst.api.raw('/api/desktop/update/linux/x86_64/1.0.0');
    const j = (await r.json()) as any;
    expect(j).toMatchObject({ version: '1.2.0', signature: expect.stringMatching(/^dW50/) });
    expect(Buffer.from(await (await inst.api.raw(new URL(j.url).pathname)).arrayBuffer()).toString()).toBe('bundle-1.2.0');
    expect((await inst.api.raw('/api/desktop/update/linux/x86_64/1.2.0')).status).toBe(204);
    expect((await inst.api.raw('/api/desktop/update/windows/x86_64/1.0.0')).status).toBe(204);
    // without a login the upload is refused before the body is read
    expect((await inst.api.raw('/api/desktop/app', { method: 'PUT', headers: { 'x-version': '9.0.0' }, body: 'x' })).status).toBe(401);
  });
});
