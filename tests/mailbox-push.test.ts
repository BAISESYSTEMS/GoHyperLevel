import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JwksCache, signJwt } from '../server/services/jose.js';
import { parseGraphNotices, parsePubSub, verifyPubSubJwt } from '../server/services/mailbox-push.js';
import { openSecret } from '../server/core/secrets.js';
import { boot, box, connect, msgs, settle, syncNow, type T } from './mailbox-helpers.js';
import type { MailFake } from './mailbox-fakes.js';

/**
 * Push: Gmail → Pub/Sub (Google-signed OIDC token pinned to audience + service account, or a shared secret),
 * Graph change notifications (validation handshake, clientState, lifecycle), registration and renewal, and the
 * polling fallback when push is not possible.
 */

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as object), kid: 'k1', alg: 'RS256', use: 'sig' };
const SA = 'push@my-project.iam.gserviceaccount.com';
const TOPIC = 'projects/my-project/topics/gmail-push';
const ENDPOINT = 'http://localhost/hooks/mailbox/gmail';

const claims = (extra: Record<string, unknown> = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return { iss: 'https://accounts.google.com', aud: ENDPOINT, email: SA, email_verified: true, sub: '1234567890', azp: '1234567890', iat: now, exp: now + 3600, ...extra };
};
const token = (extra: Record<string, unknown> = {}, key = privateKey, kid = 'k1') => signJwt(claims(extra), key, { alg: 'RS256', kid });

describe('Pub/Sub token check (pure)', () => {
  const jwks = () => new JwksCache(async () => ({ keys: [jwk] }));
  const verify = (tok: string, o: Partial<Parameters<typeof verifyPubSubJwt>[1]> = {}) => verifyPubSubJwt(tok, { jwks: jwks(), audience: ENDPOINT, serviceAccount: SA, ...o });

  it('accepts a Google-signed token for the audience and service account', async () => {
    await expect(verify(token())).resolves.toEqual({ email: SA });
    await expect(verify(token({ email: SA.toUpperCase() }), {})).resolves.toBeTruthy();
  });

  it('refuses everything else', async () => {
    const bad = async (tok: string, o: Parameters<typeof verify>[1] = {}) => expect(verify(tok, o)).rejects.toThrow();
    await bad(token({ aud: 'https://evil.example/hook' }));
    await bad(token({ email: 'other@my-project.iam.gserviceaccount.com' }));
    await bad(token({ email_verified: false }));
    await bad(token({ iss: 'https://evil.example' }));
    await bad(token({ exp: Math.floor(Date.now() / 1000) - 3600 }));
    await bad(token({ iat: Math.floor(Date.now() / 1000) + 3600 }));
    // Signed by someone else, with our kid.
    await bad(token({}, other.privateKey));
    await bad(token({}, privateKey, 'unknown-kid'));
    // No service account / audience configured: nothing is accepted.
    await bad(token(), { serviceAccount: '' });
    await bad(token(), { audience: '' });
    // alg none and garbage
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims())).toString('base64url')}.`;
    await bad(none);
    await bad('not-a-jwt');
    // An HMAC token made with the public key as secret ("alg confusion").
    const hs = `${Buffer.from('{"alg":"HS256","kid":"k1"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims())).toString('base64url')}.abc`;
    await bad(hs);
  });

  it('parses the Pub/Sub envelope and Graph notifications defensively', () => {
    const data = Buffer.from(JSON.stringify({ emailAddress: 'Inhaber@Gmail.Example', historyId: '77' })).toString('base64');
    expect(parsePubSub({ message: { data, messageId: 'm1' } })).toEqual({ address: 'inhaber@gmail.example', historyId: '77', messageId: 'm1' });
    expect(parsePubSub({})).toBeNull();
    expect(parsePubSub({ message: { data: 'nonsense' } })).toBeNull();
    expect(parsePubSub({ message: { data: Buffer.from('{"emailAddress":"x"}').toString('base64') } })).toBeNull();
    expect(parseGraphNotices({ value: [{ subscriptionId: 's1', clientState: 'c', changeType: 'created', resource: 'x' }, { nope: true }, null] })).toEqual([{ subscriptionId: 's1', clientState: 'c', changeType: 'created', lifecycleEvent: '', resource: 'x' }]);
    expect(parseGraphNotices(null)).toEqual([]);
  });
});

describe('Gmail push over Pub/Sub', () => {
  let t: T;
  let fake: MailFake;
  let mb = '';
  let secret = '';

  beforeAll(async () => {
    ({ t, fake } = await boot());
    fake.jwks.keys.push(jwk);
    fake.gmail.add({ id: 'p1', from: 'start@kunde.example', subject: 'Vorher' });
    const c = await connect(t, fake, { provider: 'google', access: 'full', name: 'Push' });
    mb = c.id;
    await settle(t, mb);
  });
  afterAll(async () => {
    await t.close();
  });

  const push = (opts: { key?: string; bearer?: string; address?: string; body?: unknown } = {}) =>
    t.api.raw(`/hooks/mailbox/gmail${opts.key ? `?key=${opts.key}` : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}) },
      body: JSON.stringify(opts.body ?? { message: { data: Buffer.from(JSON.stringify({ emailAddress: opts.address ?? 'inhaber@gmail.example', historyId: '9999' })).toString('base64'), messageId: `m${Math.random()}` }, subscription: 'projects/p/subscriptions/s' }),
    });
  const until = async (fn: () => boolean, ms = 3000) => {
    for (let i = 0; i < ms / 15; i++) {
      if (fn()) return true;
      await new Promise((r) => setTimeout(r, 15));
    }
    return fn();
  };

  it('agency settings: validated, with the push URL (secret inside) shown to admins only', async () => {
    expect((await t.api.put('/api/agency/mailbox-push', { gmail_topic: 'kaputt' })).status).toBe(400);
    expect((await t.api.put('/api/agency/mailbox-push', { service_account: 'kein-mail' })).status).toBe(400);
    const r = await t.api.put('/api/agency/mailbox-push', { gmail_topic: TOPIC });
    expect(r.status).toBe(200);
    expect(r.data.gmail).toMatchObject({ topic: TOPIC, ready: true, jwt_ready: false, endpoint_url: ENDPOINT, effective_audience: ENDPOINT });
    secret = new URL(r.data.gmail.push_url).searchParams.get('key')!;
    expect(secret).toHaveLength(32);
    expect(r.data.graph.ready).toBe(false);
    expect(openSecret(t.app, JSON.parse(t.app.db.get(`SELECT value FROM agency_settings WHERE key = 'mailbox_push'`)!.value).secret)).toBe(secret);
    // A client login cannot read it.
    await t.api.post('/api/users', { email: 'kunde@example.com', name: 'Kunde', password: 'geheim123', role: 'member', locations: [t.api.location] });
    const { login } = await import('./mailbox-helpers.js');
    const member = await login(t, 'kunde@example.com', 'geheim123', t.api.location);
    expect((await member.get('/api/agency/mailbox-push')).status).toBe(403);
  });

  it('refuses a push without credentials or with a wrong secret', async () => {
    expect((await push()).status).toBe(401);
    expect((await push({ key: 'falsch' })).status).toBe(401);
    expect((await push({ key: `${secret}x` })).status).toBe(401);
    // A token alone is not enough while no service account is pinned.
    expect((await push({ bearer: token() })).status).toBe(401);
  });

  it('accepts the shared secret, answers at once and reads the mailbox in the background', async () => {
    fake.gmail.add({ id: 'p2', from: 'Neu <neu@kunde.example>', subject: 'Per Push' });
    const r = await push({ key: secret });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, mailboxes: 1 });
    expect(await until(() => msgs(t, 'subject = ?', 'Per Push').length === 1)).toBe(true);
  });

  it('ignores addresses it does not know and unreadable bodies (acknowledged, nothing happens)', async () => {
    expect(await (await push({ key: secret, address: 'fremd@gmail.example' })).json()).toEqual({ ok: true, mailboxes: 0 });
    expect(await (await push({ key: secret, body: { message: { data: '%%%' } } })).json()).toEqual({ ok: true, ignored: true });
  });

  it('accepts the Google-signed token once the service account is pinned – and only for the right audience and account', async () => {
    await t.api.put('/api/agency/mailbox-push', { service_account: SA });
    expect((await push({ bearer: token() })).status).toBe(200);
    expect((await push({ bearer: token({ aud: 'https://evil.example/x' }) })).status).toBe(401);
    expect((await push({ bearer: token({ email: 'x@my-project.iam.gserviceaccount.com' }) })).status).toBe(401);
    expect((await push({ bearer: token({}, other.privateKey) })).status).toBe(401);
    expect((await push({ bearer: token({ exp: Math.floor(Date.now() / 1000) - 7200 }) })).status).toBe(401);
    // A custom audience can be pinned.
    await t.api.put('/api/agency/mailbox-push', { audience: 'gohigh-gmail-push' });
    expect((await push({ bearer: token() })).status).toBe(401);
    expect((await push({ bearer: token({ aud: 'gohigh-gmail-push' }) })).status).toBe(200);
    await t.api.put('/api/agency/mailbox-push', { audience: '' });
    // Rotating the secret invalidates the old URL.
    const rotated = await t.api.put('/api/agency/mailbox-push', { rotate_secret: true });
    expect((await push({ key: secret })).status).toBe(401);
    secret = new URL(rotated.data.gmail.push_url).searchParams.get('key')!;
    expect((await push({ key: secret })).status).toBe(200);
  });

  it('registers the watch for the mailbox (topic, labels) and renews it before it expires', async () => {
    const r = await t.api.post(`/api/mailboxes/${mb}/push`, {});
    expect(r.data).toMatchObject({ ok: true, push: { active: true, kind: 'gmail_watch' } });
    expect(fake.g.watch).toMatchObject({ topicName: TOPIC, labelIds: ['INBOX', 'SENT', 'DRAFT'] });
    expect((await t.api.get('/api/mailboxes')).data.mailboxes[0].push).toMatchObject({ active: true, kind: 'gmail_watch', error: null });
    // Not due yet: nothing happens. Close to expiry: watch again.
    const calls = fake.calls(/\/watch$/).length;
    await t.app.services.mailboxPush.renewDue();
    expect(fake.calls(/\/watch$/).length).toBe(calls);
    t.app.db.run(`UPDATE mailboxes SET push = json_set(push, '$.expires_at', ?) WHERE id = ?`, new Date(Date.now() + 3600_000).toISOString(), mb);
    await t.app.services.mailboxPush.renewDue();
    expect(fake.calls(/\/watch$/).length).toBe(calls + 1);
    expect(Date.parse(box(t, mb).push.expires_at)).toBeGreaterThan(Date.now() + 5 * 864e5);
  });

  it('polling keeps working when push cannot be set up, and the reason is shown', async () => {
    await t.api.put('/api/agency/mailbox-push', { gmail_topic: '' });
    const r = await t.api.post(`/api/mailboxes/${mb}/push`, {});
    expect(r.status).toBe(409);
    expect(box(t, mb).push.error).toMatch(/Pub\/Sub-Thema/);
    fake.gmail.add({ id: 'p3', from: 'Poll <poll@kunde.example>', subject: 'Nur Abruf' });
    t.app.db.run('UPDATE mailboxes SET next_sync_at = ?, sync_due = 0 WHERE id = ?', new Date(Date.now() - 1000).toISOString(), mb);
    await t.app.tick();
    expect(msgs(t, 'subject = ?', 'Nur Abruf')).toHaveLength(1);
    await t.api.put('/api/agency/mailbox-push', { gmail_topic: TOPIC });
  });

  it('stops the watch when the mailbox is disconnected', async () => {
    await t.api.post(`/api/mailboxes/${mb}/push`, {});
    const stopped = fake.g.stopped;
    const r = await t.api.del(`/api/mailboxes/${mb}`);
    expect(r.data).toMatchObject({ ok: true, revoked: true });
    expect(fake.g.stopped).toBe(stopped + 1);
    expect(fake.g.revoked).toContain('g-refresh-1');
    expect(t.app.db.all('SELECT id FROM mailboxes')).toHaveLength(0);
    expect(t.app.db.all('SELECT * FROM mailbox_messages')).toHaveLength(0);
    // The mail stays in the conversations.
    expect(msgs(t, 'subject = ?', 'Per Push')).toHaveLength(1);
    expect(await (await push({ key: secret })).json()).toEqual({ ok: true, mailboxes: 0 });
    void syncNow;
  });
});
