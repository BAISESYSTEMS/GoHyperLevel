import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSecret } from '../server/core/secrets.js';
import { boot, box, connect, msgs, settle, type T } from './mailbox-helpers.js';
import type { MailFake } from './mailbox-fakes.js';

/**
 * Microsoft Graph change notifications: the validation handshake, subscription per mailbox with a secret
 * clientState, notifications (only with the right clientState), lifecycle events, renewal, and the poll as a fallback.
 */

let t: T;
let fake: MailFake;
let mb = '';
const HOOK = '/hooks/mailbox/graph';
const until = async (fn: () => boolean, ms = 3000) => {
  for (let i = 0; i < ms / 15; i++) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return fn();
};
const post = (path: string, body: unknown, query = '') => t.api.raw(`${path}${query}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const notice = (extra: Record<string, unknown> = {}) => ({ value: [{ subscriptionId: box(t, mb).push.id, clientState: clientState(), changeType: 'created', resource: `Users/x/Messages/y`, resourceData: { id: 'y' }, subscriptionExpirationDateTime: new Date().toISOString(), tenantId: 't', ...extra }] });
const clientState = () => openSecret(t.app, box(t, mb).push.client_state);

beforeAll(async () => {
  // Microsoft only talks to public https addresses.
  ({ t, fake } = await boot({ baseUrl: 'https://crm.example.test' }));
  const c = await connect(t, fake, { provider: 'microsoft', access: 'full', name: 'Push' });
  mb = c.id;
  await settle(t, mb);
  const r = await t.api.post(`/api/mailboxes/${mb}/push`, {});
  expect(r.status, JSON.stringify(r.data)).toBe(200);
});
afterAll(async () => {
  await t.close();
});

describe('subscription', () => {
  it('is registered for the whole mailbox with a secret clientState and the two URLs; Graph validated our endpoint', () => {
    const sub = [...fake.ms.subs.values()][0];
    expect(sub).toMatchObject({ resource: 'me/messages', notificationUrl: 'https://crm.example.test/hooks/mailbox/graph', lifecycleNotificationUrl: 'https://crm.example.test/hooks/mailbox/graph/lifecycle' });
    expect(sub.clientState).toHaveLength(32);
    expect(sub.clientState).toBe(clientState());
    expect(Date.parse(sub.expirationDateTime) - Date.now()).toBeLessThanOrEqual(4230 * 60_000);
    expect(box(t, mb).push).toMatchObject({ kind: 'graph_subscription', id: sub.id });
    expect(box(t, mb).push.client_state).toMatch(/^v[12]:/);
  });

  it('never shows the clientState', async () => {
    const text = JSON.stringify((await t.api.get('/api/mailboxes')).data) + JSON.stringify((await t.api.get('/api/agency/mailbox-push')).data);
    expect(text).not.toContain(clientState());
    expect(text).not.toMatch(/v[12]:[A-Za-z0-9+/=]{10}/);
    expect((await t.api.get('/api/agency/mailbox-push')).data).toMatchObject({ graph: { ready: true }, active: { graph: 1 } });
  });
});

describe('validation handshake', () => {
  it('echoes the validationToken as plain text', async () => {
    const r = await post(HOOK, '', '?validationToken=abc%20def-123');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await r.text()).toBe('abc def-123');
    // Markup in the token stays text (plain type + nosniff).
    const x = await post(HOOK, '', `?validationToken=${encodeURIComponent('<script>alert(1)</script>')}`);
    expect(x.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(x.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await x.text()).toBe('<script>alert(1)</script>');
    const l = await post(`${HOOK}/lifecycle`, '', '?validationToken=life');
    expect(await l.text()).toBe('life');
  });
});

describe('notifications', () => {
  it('refuses notifications with a wrong or missing clientState, or for an unknown subscription', async () => {
    expect((await post(HOOK, notice({ clientState: 'falsch' }))).status).toBe(401);
    expect((await post(HOOK, notice({ clientState: '' }))).status).toBe(401);
    expect((await post(HOOK, notice({ subscriptionId: 'unbekannt' }))).status).toBe(401);
    const calls = fake.calls(/delta/).length;
    await new Promise((r) => setTimeout(r, 60));
    expect(fake.calls(/delta/).length).toBe(calls);
  });

  it('answers 202 at once and reads the mailbox', async () => {
    fake.graph.add('me', { id: 'n1', from: 'Neu <neu@kunde.example>', subject: 'Per Benachrichtigung' });
    const r = await post(HOOK, notice());
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ ok: true, accepted: 1 });
    expect(await until(() => msgs(t, 'subject = ?', 'Per Benachrichtigung').length === 1)).toBe(true);
  });

  it('a batch with one good and one forged notification still processes the good one', async () => {
    fake.graph.add('me', { id: 'n2', from: 'Zwei <zwei@kunde.example>', subject: 'Gemischte Meldung' });
    const good = notice().value[0];
    const r = await post(HOOK, { value: [{ ...good, clientState: 'falsch' }, good] });
    expect(r.status).toBe(202);
    expect(await until(() => msgs(t, 'subject = ?', 'Gemischte Meldung').length === 1)).toBe(true);
  });

  it('lifecycle: "missed" reads the mailbox, "reauthorizationRequired" renews, "subscriptionRemoved" subscribes again', async () => {
    fake.graph.add('me', { id: 'n3', from: 'Drei <drei@kunde.example>', subject: 'Nach Missed' });
    const lc = (event: string) => post(`${HOOK}/lifecycle`, { value: [{ subscriptionId: box(t, mb).push.id, clientState: clientState(), lifecycleEvent: event, resource: 'x' }] });
    expect((await lc('missed')).status).toBe(202);
    expect(await until(() => msgs(t, 'subject = ?', 'Nach Missed').length === 1)).toBe(true);
    const patches = fake.calls(/subscriptions\//, 'PATCH').length;
    expect((await lc('reauthorizationRequired')).status).toBe(202);
    expect(await until(() => fake.calls(/subscriptions\//, 'PATCH').length === patches + 1)).toBe(true);
    const oldId = box(t, mb).push.id;
    expect((await lc('subscriptionRemoved')).status).toBe(202);
    expect(await until(() => !!box(t, mb).push.id && box(t, mb).push.id !== oldId)).toBe(true);
    expect(fake.ms.subs.has(box(t, mb).push.id)).toBe(true);
  });
});

describe('renewal and fallback', () => {
  it('renews a subscription that runs out within a day; recreates it when Graph forgot it', async () => {
    t.app.db.run(`UPDATE mailboxes SET push = json_set(push, '$.expires_at', ?) WHERE id = ?`, new Date(Date.now() + 3600_000).toISOString(), mb);
    const id = box(t, mb).push.id;
    const before = fake.ms.subs.get(id)!.expirationDateTime;
    await t.app.services.mailboxPush.renewDue();
    expect(fake.ms.subs.get(id)!.expirationDateTime >= before).toBe(true);
    expect(Date.parse(box(t, mb).push.expires_at)).toBeGreaterThan(Date.now() + 24 * 3600_000);
    // Graph lost it.
    fake.ms.subs.delete(id);
    t.app.db.run(`UPDATE mailboxes SET push = json_set(push, '$.expires_at', ?) WHERE id = ?`, new Date(Date.now() + 3600_000).toISOString(), mb);
    await t.app.services.mailboxPush.renewDue();
    expect(box(t, mb).push.id).not.toBe(id);
    expect(fake.ms.subs.has(box(t, mb).push.id)).toBe(true);
  });

  it('falls back to polling – and says why – when Graph cannot reach the endpoint', async () => {
    fake.ms.selfUrl = 'http://127.0.0.1:1';
    const r = await t.api.post(`/api/mailboxes/${mb}/push`, {});
    expect(r.status).toBe(409);
    expect(box(t, mb).push.error).toMatch(/Subscription validation request failed/);
    expect((await t.api.get('/api/mailboxes')).data.mailboxes[0].push).toMatchObject({ active: false, error: expect.stringContaining('validation') });
    fake.ms.selfUrl = t.base;
    fake.graph.add('me', { id: 'n4', from: 'Vier <vier@kunde.example>', subject: 'Nur Abruf' });
    t.app.db.run('UPDATE mailboxes SET next_sync_at = ?, sync_due = 0 WHERE id = ?', new Date(Date.now() - 1000).toISOString(), mb);
    await t.app.tick();
    expect(msgs(t, 'subject = ?', 'Nur Abruf')).toHaveLength(1);
  });

  it('disconnecting removes the subscription at Microsoft', async () => {
    expect((await t.api.post(`/api/mailboxes/${mb}/push`, {})).status).toBe(200);
    const id = box(t, mb).push.id;
    expect(fake.ms.subs.has(id)).toBe(true);
    expect((await t.api.del(`/api/mailboxes/${mb}`)).data).toMatchObject({ ok: true, revoked: false });
    expect(fake.ms.subs.has(id)).toBe(false);
    const gone = await post(HOOK, { value: [{ subscriptionId: id, clientState: 'x' }] });
    expect(gone.status).toBe(401);
  });
});

describe('without a public https address', () => {
  it('push is off, polling is the plan', async () => {
    const plain = await boot();
    try {
      const c = await connect(plain.t, plain.fake, { provider: 'microsoft', access: 'full' });
      await settle(plain.t, c.id);
      expect((await plain.t.api.get('/api/agency/mailbox-push')).data.graph).toMatchObject({ ready: false });
      const r = await plain.t.api.post(`/api/mailboxes/${c.id}/push`, {});
      expect(r.status).toBe(409);
      expect(r.data.error).toMatch(/öffentliche https-Adresse/);
      expect(plain.fake.ms.subs.size).toBe(0);
    } finally {
      await plain.t.close();
    }
  });
});
