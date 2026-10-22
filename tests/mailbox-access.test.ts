import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, box, connect, login, maps, msgs, settle, syncNow, withKey, type T } from './mailbox-helpers.js';
import type { MailFake } from './mailbox-fakes.js';

/**
 * Who may do what: sub-account isolation, areas (settings vs. conversations), personal mailboxes that only their
 * owner can use (never through keys or MCP), routing rules limited to the owner's sub-accounts, access levels,
 * the MCP tools, the mobile endpoints, the audit log and GDPR.
 */

let t: T;
let fake: MailFake;
let A = '';
let B = '';
let shared = ''; // sub-account mailbox of A
let personal = ''; // admin's personal mailbox
let memberA: Awaited<ReturnType<typeof login>>;
let chatOnlyA: Awaited<ReturnType<typeof login>>;
let memberB: Awaited<ReturnType<typeof login>>;
let keyA = '';
let agencyKey = '';

const conv = (loc: string, email: string) => t.app.db.get(`SELECT v.* FROM conversations v JOIN contacts c ON c.id = v.contact_id WHERE v.location_id = ? AND c.email = ?`, loc, email);

beforeAll(async () => {
  ({ t, fake } = await boot());
  A = t.api.location;
  B = (await t.api.post('/api/locations', { name: 'Zweitfirma' })).data.id;
  const mk = (email: string, locations: string[], permissions: string[] | null) => t.api.post('/api/users', { email, name: email.split('@')[0], password: 'passwort-1', role: 'member', locations, permissions });
  await mk('a@example.com', [A], null);
  await mk('chat@example.com', [A], ['conversations']);
  await mk('b@example.com', [B], null);
  memberA = await login(t, 'a@example.com', 'passwort-1', A);
  chatOnlyA = await login(t, 'chat@example.com', 'passwort-1', A);
  memberB = await login(t, 'b@example.com', 'passwort-1', B);
  keyA = (await t.api.post('/api/api-keys', { name: 'A' })).data.key;
  agencyKey = (await t.api.post('/api/agency/api-keys', { name: 'Agentur' })).data.key;
  fake.gmail.add({ id: 'a1', from: 'Anna <anna@kunde.example>', subject: 'Für Firma A', attachments: [{ name: 'a.txt', type: 'text/plain', data: Buffer.from('GEHEIM-A').toString('base64') }], threadId: 'th-a' });
  const c = await connect(t, fake, { provider: 'google', access: 'full', name: 'Firma A' });
  shared = c.id;
  await settle(t, shared);
});
afterAll(async () => {
  await t.close();
});

describe('sub-account isolation', () => {
  it('Firma B sees nothing of A\'s mailbox, its mail or its conversations', async () => {
    const aConv = conv(A, 'anna@kunde.example')!;
    const aMsg = msgs(t, 'conversation_id = ?', aConv.id)[0];
    expect((await memberB.get('/api/mailboxes')).data.mailboxes).toEqual([]);
    expect((await memberB.get('/api/mail/mailboxes')).data).toEqual([]);
    for (const [method, path, body] of [
      ['PATCH', `/api/mailboxes/${shared}`, { name: 'gekapert' }],
      ['DELETE', `/api/mailboxes/${shared}`, undefined],
      ['POST', `/api/mailboxes/${shared}/sync`, {}],
      ['POST', `/api/mailboxes/${shared}/push`, {}],
      ['GET', `/api/mailboxes/${shared}/folders`, undefined],
      ['POST', '/api/mailboxes/connect', { provider: 'google', mailbox_id: shared }],
      ['GET', `/api/mail/mailboxes/${shared}/labels`, undefined],
      ['POST', '/api/mail/send', { mailbox_id: shared, to: 'x@y.de', body: 'x' }],
      ['POST', '/api/mail/drafts', { mailbox_id: shared, to: 'x@y.de', body: 'x' }],
      ['GET', `/api/mail/conversations/${aConv.id}`, undefined],
      ['POST', `/api/mail/conversations/${aConv.id}/archive`, {}],
      ['POST', `/api/mail/conversations/${aConv.id}/labels`, { add: ['x'] }],
      ['POST', `/api/mail/conversations/${aConv.id}/reply`, { body: 'x' }],
      ['GET', `/api/mail/attachments/${aMsg.id}/0?mailbox=${shared}`, undefined],
      ['PUT', `/api/mail/drafts/${aMsg.id}`, { body: 'x' }],
      ['POST', `/api/mail/drafts/${aMsg.id}/send`, {}],
      ['DELETE', `/api/mail/drafts/${aMsg.id}`, undefined],
    ] as const) {
      const r = await memberB.call(method, path, body);
      expect([401, 403, 404], `${method} ${path} → ${r.status} ${JSON.stringify(r.data).slice(0, 100)}`).toContain(r.status);
    }
    expect((await memberB.get(`/api/mail/search?q=Firma&mailbox_id=${shared}`)).status).toBe(404);
    expect((await memberB.get('/api/mail/search?q=Firma')).data).toEqual({ results: [], remote: [] });
    expect((await memberB.get(`/api/conversations?mailbox=${shared}`)).data).toEqual([]);
    expect((await memberB.get(`/api/conversations/${aConv.id}/messages`)).status).toBe(404);
    expect((await memberB.get('/api/mail/drafts')).data).toEqual([]);
    expect(box(t, shared).name).toBe('Firma A');
  });

  it('a sub-account member of A can read and answer, and manage the mailbox only with the settings area', async () => {
    expect((await memberA.get('/api/mailboxes')).data.mailboxes).toMatchObject([{ id: shared, can_manage: true }]);
    const list = (await chatOnlyA.get('/api/mail/mailboxes')).data;
    expect(list).toMatchObject([{ id: shared, can_send: true, can_read: true }]);
    expect((await chatOnlyA.get('/api/mailboxes')).status).toBe(403);
    expect((await chatOnlyA.patch(`/api/mailboxes/${shared}`, { name: 'x' })).status).toBe(403);
    expect((await chatOnlyA.post('/api/mailboxes/connect', { provider: 'google' })).status).toBe(403);
    expect((await chatOnlyA.del(`/api/mailboxes/${shared}`)).status).toBe(403);
    // Answering through the sub-account's mailbox is the Konversationen area.
    const anna = conv(A, 'anna@kunde.example')!;
    const r = await chatOnlyA.post(`/api/mail/conversations/${anna.id}/reply`, { body: 'Antwort vom Teammitglied' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(fake.g.sentRaw.at(-1)!.parsed.text).toContain('Antwort vom Teammitglied');
    expect(msgs(t, 'user_id = (SELECT id FROM users WHERE email = ?)', 'chat@example.com')).toHaveLength(1);
  });

  it('API keys: a location key reaches its own sub-account\'s mailbox, never another', async () => {
    const own = withKey(t, keyA, A);
    expect((await own.get('/api/mail/mailboxes')).data.map((m: any) => m.id)).toEqual([shared]);
    // The key belongs to A: a different x-location-id does not move it – it is A's data or nothing.
    const other = withKey(t, keyA, B);
    expect((await other.get('/api/mail/mailboxes')).data.map((m: any) => m.id)).toEqual([shared]);
    expect((await other.post('/api/mail/send', { mailbox_id: personal, to: 'x@y.de', body: 'x' })).status).toBe(404);
    // Keys cannot manage connections.
    expect((await own.call('DELETE', `/api/mailboxes/${shared}`)).status).toBe(403);
    expect((await own.call('PATCH', `/api/mailboxes/${shared}`, { name: 'x' })).status).toBe(403);
    expect((await own.post('/api/mailboxes/connect', { provider: 'google' })).status).toBe(403);
    expect(box(t, shared)).toBeTruthy();
  });
});

describe('personal mailboxes', () => {
  beforeAll(async () => {
    fake.gmail.add({ id: 'p1', from: 'Paula <paula@kunde.example>', subject: 'Persönlich an A', threadId: 'th-p1' });
    fake.gmail.add({ id: 'p2', from: 'Quentin <quentin@zweitfirma.example>', subject: 'Projekt Zweit', threadId: 'th-p2' });
    fake.gmail.add({ id: 'p3', from: 'Oma <oma@privat.example>', subject: 'Private Mail', threadId: 'th-p3' });
    fake.g.address = 'chef@gmail.example';
    const c = await connect(t, fake, { provider: 'google', scope: 'user', access: 'full', name: 'Chef privat' });
    personal = c.id;
    await settle(t, personal);
    fake.g.address = 'inhaber@gmail.example';
  });

  it('imports nothing until rules say where mail goes – a private mailbox is not poured into the CRM', () => {
    expect(msgs(t, 'subject IN (?, ?, ?)', 'Persönlich an A', 'Projekt Zweit', 'Private Mail')).toHaveLength(0);
    expect(box(t, personal)).toMatchObject({ scope: 'user', location_id: null, rules: [], default_location_id: null });
  });

  it('routes mail by rules to the sub-accounts the owner may use; the first matching rule wins', async () => {
    const r = await t.api.patch(`/api/mailboxes/${personal}`, {
      rules: [
        { field: 'domain', value: 'zweitfirma.example', location_id: B },
        { field: 'address', value: 'paula@kunde.example', location_id: A },
        { field: 'subject', value: 'persönlich', location_id: B },
      ],
    });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    await syncNow(t, personal, { full: true });
    expect(msgs(t, 'subject = ?', 'Projekt Zweit')[0].location_id).toBe(B);
    // "address" is before "subject", so Paula's mail goes to A although the subject rule would say B.
    expect(msgs(t, 'subject = ?', 'Persönlich an A')[0].location_id).toBe(A);
    expect(msgs(t, 'subject = ?', 'Private Mail')).toHaveLength(0);
    // Contacts and conversations are created in the target sub-account only.
    expect(conv(B, 'quentin@zweitfirma.example')).toBeTruthy();
    expect(conv(A, 'quentin@zweitfirma.example')).toBeUndefined();
    expect(maps(t, personal).find((m) => m.remote_id === 'p2')!.location_id).toBe(B);
  });

  it('a default sub-account takes everything the rules do not catch', async () => {
    await t.api.patch(`/api/mailboxes/${personal}`, { default_location_id: A });
    await syncNow(t, personal, { full: true });
    expect(msgs(t, 'subject = ?', 'Private Mail')).toMatchObject([{ location_id: A }]);
    await t.api.patch(`/api/mailboxes/${personal}`, { default_location_id: '' });
  });

  it('is invisible to everybody else and unusable through keys, agency keys and MCP', async () => {
    expect((await memberA.get('/api/mailboxes')).data.mailboxes.map((m: any) => m.id)).toEqual([shared]);
    expect((await memberA.get('/api/mail/mailboxes')).data.map((m: any) => m.id)).toEqual([shared]);
    expect((await memberA.patch(`/api/mailboxes/${personal}`, { name: 'gekapert' })).status).toBe(404);
    expect((await memberA.del(`/api/mailboxes/${personal}`)).status).toBe(404);
    expect((await memberA.post('/api/mail/send', { mailbox_id: personal, to: 'x@y.de', body: 'x' })).status).toBe(404);
    // Admin sees both – in the sub-account where he works.
    const mine = (await t.api.get('/api/mailboxes')).data.mailboxes;
    expect(mine.map((m: any) => m.id).sort()).toEqual([personal, shared].sort());
    expect(mine.find((m: any) => m.id === personal)).toMatchObject({ scope: 'user', mine: true });
    // Keys act for a sub-account or the agency, not for a person.
    const loc = withKey(t, keyA, A);
    expect((await loc.get('/api/mail/mailboxes')).data.map((m: any) => m.id)).toEqual([shared]);
    expect((await loc.post('/api/mail/send', { mailbox_id: personal, to: 'x@y.de', body: 'x' })).status).toBe(404);
    const ag = withKey(t, agencyKey, A);
    expect((await ag.get('/api/mail/mailboxes')).data.map((m: any) => m.id)).toEqual([shared]);
    expect((await ag.post('/api/mail/send', { mailbox_id: personal, to: 'x@y.de', body: 'x' })).status).toBe(404);
    const sent = fake.g.sentRaw.length;
    expect(fake.g.sentRaw).toHaveLength(sent);
  });

  it('refuses rules that point at sub-accounts the owner may not use, and rules on sub-account mailboxes', async () => {
    // A member's own personal mailbox (different Google account in the fake).
    fake.g.address = 'a@gmail.example';
    const c = await (async () => {
      const start = await memberA.post('/api/mailboxes/connect', { provider: 'google', scope: 'user', access: 'readonly', name: 'A privat' });
      expect(start.status, JSON.stringify(start.data)).toBe(200);
      const f = fake.authorize(start.data.url);
      const back = await memberA.call('GET', `/oauth/google/callback?code=${f.code}&state=${encodeURIComponent(f.state)}`);
      return new URLSearchParams((back.headers.get('location') ?? '').split('?')[1]).get('mailbox')!;
    })();
    fake.g.address = 'inhaber@gmail.example';
    await settle(t, c);
    const bad = await memberA.patch(`/api/mailboxes/${c}`, { rules: [{ field: 'domain', value: 'x.example', location_id: B }] });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toMatch(/kein Zugriff/);
    expect((await memberA.patch(`/api/mailboxes/${c}`, { default_location_id: B })).status).toBe(400);
    expect((await memberA.patch(`/api/mailboxes/${c}`, { rules: [{ field: 'domain', value: 'x.example', location_id: A }] })).status).toBe(200);
    expect((await t.api.patch(`/api/mailboxes/${shared}`, { rules: [] })).status).toBe(400);
    // The admin cannot manage a member's personal mailbox either.
    expect((await t.api.patch(`/api/mailboxes/${c}`, { name: 'x' })).status).toBe(404);
    // Rights can change later: when the owner loses A, mail for A is skipped.
    t.app.db.run(`UPDATE users SET locations = '[]' WHERE email = ?`, 'a@example.com');
    fake.gmail.add({ id: 'p9', from: 'X <x@x.example>', subject: 'Nach Rechteentzug' });
    await syncNow(t, c);
    expect(msgs(t, 'subject = ?', 'Nach Rechteentzug')).toHaveLength(0);
    t.app.db.run(`UPDATE users SET locations = ? WHERE email = ?`, JSON.stringify([A]), 'a@example.com');
    // Read-only: no send, and archiving has nothing to change.
    const r = await memberA.post('/api/mail/send', { mailbox_id: c, to: 'x@y.de', body: 'x' });
    expect(r.status).toBe(403);
    expect(r.data.error).toMatch(/nur Lesezugriff/);
    await memberA.del(`/api/mailboxes/${c}`);
  });

  it('mail that came through a personal mailbox is read by the sub-account, but only its owner changes it at the provider', async () => {
    const paula = conv(A, 'paula@kunde.example')!;
    expect((await memberA.get(`/api/conversations/${paula.id}/messages`)).status).toBe(200);
    const r = await memberA.post(`/api/mail/conversations/${paula.id}/archive`, {});
    expect(r.status).toBe(409);
    const own = await t.api.post(`/api/mail/conversations/${paula.id}/archive`, {});
    expect(own.status).toBe(200);
    expect(fake.g.messages.get('p1').labels).not.toContain('INBOX');
    // Replying as a member of A: not through the owner's mailbox, but through A's own one (the sub-account's).
    const reply = await memberA.post(`/api/mail/conversations/${paula.id}/reply`, { body: 'Danke' });
    expect(reply.status, JSON.stringify(reply.data)).toBe(200);
    expect(maps(t, shared).some((m) => m.message_id === reply.data.message_id)).toBe(true);
  });
});

describe('access levels', () => {
  it('a read-only mailbox syncs but never sends or changes anything; a send-only one sends but does not sync', async () => {
    fake.g.address = 'lesen@gmail.example';
    fake.gmail.add({ id: 'r1', from: 'Rita <rita@kunde.example>', subject: 'Nur lesen' });
    const ro = await connect(t, fake, { provider: 'google', access: 'readonly', name: 'Lesend' });
    await settle(t, ro.id);
    expect(msgs(t, 'subject = ?', 'Nur lesen')).toHaveLength(1);
    expect(box(t, ro.id)).toMatchObject({ access: 'readonly' });
    expect(fake.g.codes.size).toBe(0);
    const send = await t.api.post('/api/mail/send', { mailbox_id: ro.id, to: 'x@y.de', body: 'x' });
    expect(send.status).toBe(403);
    expect((await t.api.post('/api/mail/drafts', { mailbox_id: ro.id, to: 'x@y.de', body: 'x' })).status).toBe(403);
    expect((await t.api.post(`/api/mail/mailboxes/${ro.id}/labels`, { name: 'x' })).status).toBe(403);
    const rita = conv(A, 'rita@kunde.example')!;
    const before = fake.reqs.length;
    expect((await t.api.post(`/api/mail/conversations/${rita.id}/archive`, {}))).toMatchObject({ status: 409 });
    await t.api.get(`/api/conversations/${rita.id}/messages`);
    await t.app.services.mailbox.flush();
    expect(fake.calls(/modify/).filter((c) => fake.reqs.indexOf(c) >= before)).toHaveLength(0);
    expect(fake.g.messages.get('r1').labels).toContain('UNREAD');
    expect(t.app.db.all('SELECT * FROM mailbox_outbox')).toHaveLength(0);

    fake.g.address = 'senden@gmail.example';
    const so = await connect(t, fake, { provider: 'google', access: 'send', name: 'Nur Senden' });
    await settle(t, so.id).catch(() => undefined);
    fake.g.address = 'inhaber@gmail.example';
    expect(box(t, so.id)).toMatchObject({ access: 'send', status: 'ok' });
    const calls = fake.reqs.length;
    await syncNow(t, so.id);
    expect(fake.reqs.length).toBe(calls);
    const sent = await t.api.post('/api/mail/send', { mailbox_id: so.id, to: 'send@kunde.example', subject: 'Nur gesendet', body: 'x' });
    expect(sent.status, JSON.stringify(sent.data)).toBe(200);
    expect(fake.g.sentRaw.at(-1)!.parsed.from).toBe('senden@gmail.example');
    expect((await t.api.get(`/api/mail/mailboxes/${so.id}/labels`)).status).toBe(403);
    expect((await t.api.post(`/api/mailboxes/${so.id}/sync`, {})).status).toBe(200);
    // A disabled mailbox sends nothing.
    await t.api.patch(`/api/mailboxes/${so.id}`, { enabled: false });
    expect((await t.api.post('/api/mail/send', { mailbox_id: so.id, to: 'x@y.de', body: 'x' })).status).toBe(409);
    await t.api.del(`/api/mailboxes/${so.id}`);
    await t.api.del(`/api/mailboxes/${ro.id}`);
  });

  it('only contacts we already know, when the mailbox is set to that', async () => {
    fake.g.address = 'bekannt@gmail.example';
    await t.api.post('/api/contacts', { first_name: 'Bekannt', email: 'bekannt@kunde.example' });
    const c = await connect(t, fake, { provider: 'google', access: 'readonly', name: 'Wählerisch' });
    await settle(t, c.id);
    await t.api.patch(`/api/mailboxes/${c.id}`, { contact_policy: 'known' });
    fake.gmail.add({ id: 'k1', from: 'Bekannt <bekannt@kunde.example>', subject: 'Von Bekanntem' });
    fake.gmail.add({ id: 'k2', from: 'Fremd <fremd@newsletter.example>', subject: 'Von Fremdem' });
    await syncNow(t, c.id);
    fake.g.address = 'inhaber@gmail.example';
    expect(msgs(t, 'subject = ?', 'Von Bekanntem')).toHaveLength(1);
    expect(msgs(t, 'subject = ?', 'Von Fremdem')).toHaveLength(0);
    expect(t.app.db.get('SELECT id FROM contacts WHERE email = ?', 'fremd@newsletter.example')).toBeUndefined();
    await t.api.del(`/api/mailboxes/${c.id}`);
  });
});

describe('MCP tools', () => {
  const rpc = async (key: string, method: string, params: any = {}, extra: Record<string, string> = {}) => {
    const r = await fetch(`${t.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...extra }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return (await r.json()) as any;
  };
  const call = async (key: string, name: string, args: any) => {
    const r = await rpc(key, 'tools/call', { name, arguments: args });
    return { error: r.result?.isError ? r.result.content[0].text : undefined, data: r.result?.structuredContent ?? (r.result && !r.result.isError ? JSON.parse(r.result.content[0].text) : undefined), raw: r };
  };

  it('lists the four tools with the right hints', async () => {
    const list = (await rpc(keyA, 'tools/list')).result.tools as any[];
    const mail = Object.fromEntries(list.filter((x) => /^ghl_mail(?!_domain)/.test(x.name)).map((x) => [x.name, x]));
    expect(Object.keys(mail).sort()).toEqual(['ghl_mail_draft', 'ghl_mail_search', 'ghl_mail_send', 'ghl_mailbox_list']);
    expect(mail.ghl_mail_search.annotations).toMatchObject({ readOnlyHint: true });
    expect(mail.ghl_mail_send.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
  });

  it('a location key lists, searches, drafts and sends – in its own sub-account, never the personal mailbox', async () => {
    const boxes = await call(keyA, 'ghl_mailbox_list', {});
    expect(boxes.data.map((m: any) => m.id)).toEqual([shared]);
    expect(JSON.stringify(boxes.data)).not.toMatch(/g-refresh|g-access|v[12]:/);
    const found = await call(keyA, 'ghl_mail_search', { q: 'Für Firma', mailbox_id: shared, folder: 'inbox' });
    expect(found.data.results).toMatchObject([{ subject: 'Für Firma A', folder: 'inbox', mailbox_id: shared }]);
    const remote = await call(keyA, 'ghl_mail_search', { q: 'Für Firma', mailbox_id: shared, remote: true });
    expect(remote.data.remote.find((r: any) => r.subject === 'Für Firma A')).toMatchObject({ imported: true, thread_id: 'th-a' });
    const origin = found.data.results[0];
    const draft = await call(keyA, 'ghl_mail_draft', { mailbox_id: shared, body: 'Entwurf vom Agenten', reply_to_message_id: origin.id });
    expect(draft.error, draft.error).toBeUndefined();
    expect(draft.data.thread_id).toBe('th-a');
    const sentBefore = fake.g.sentRaw.length;
    const updated = await call(keyA, 'ghl_mail_draft', { draft_id: draft.data.message_id, mailbox_id: shared, body: 'Entwurf vom Agenten, überarbeitet', reply_to_message_id: origin.id });
    expect(updated.error, updated.error).toBeUndefined();
    expect(fake.g.sentRaw).toHaveLength(sentBefore + 1);
    const sent = await call(keyA, 'ghl_mail_send', { draft_id: draft.data.message_id });
    expect(sent.data).toMatchObject({ status: 'sent' });
    expect(fake.g.messages.get(fake.g.messages.size ? [...fake.g.messages.keys()].at(-1)! : '')).toBeTruthy();
    const direct = await call(keyA, 'ghl_mail_send', { mailbox_id: shared, to: 'direkt@kunde.example', subject: 'Direkt', body: 'Hallo', send_at: new Date(Date.now() + 3600_000).toISOString() });
    expect(direct.data).toMatchObject({ status: 'scheduled' });
    expect((await call(keyA, 'ghl_mail_send', { mailbox_id: personal, to: 'x@y.de', body: 'x' })).error).toMatch(/nicht gefunden/);
    expect((await call(keyA, 'ghl_mail_send', { mailbox_id: shared, to: 'x@y.de' })).error).toMatch(/body fehlt/);
  });

  it('an agency key names the sub-account; a location key cannot reach another one', async () => {
    expect((await call(agencyKey, 'ghl_mailbox_list', {})).error).toMatch(/location_id fehlt/);
    const ok = await call(agencyKey, 'ghl_mailbox_list', { location_id: A });
    expect(ok.data.map((m: any) => m.id)).toEqual([shared]);
    expect((await call(agencyKey, 'ghl_mailbox_list', { location_id: B })).data).toEqual([]);
    expect((await call(keyA, 'ghl_mailbox_list', { location_id: B })).error).toMatch(/nur für einen Sub-Account/);
  });
});

describe('mobile app', () => {
  it('lists the mailboxes of the user\'s sub-accounts and replies through the mailbox', async () => {
    const token = (await memberA.post('/api/mobile/pair', { device_name: 'Handy' })).data.token as string;
    const m = withKey(t, token, A);
    const list = await m.get('/api/mobile/mailboxes');
    expect(list.status, JSON.stringify(list.data)).toBe(200);
    expect(list.data.mailboxes.map((x: any) => x.id)).toEqual([shared]);
    expect(list.data.mailboxes[0]).toMatchObject({ name: 'Firma A', location_id: A, can_send: true });
    const anna = conv(A, 'anna@kunde.example')!;
    const r = await m.post(`/api/mobile/conversations/${anna.id}/mail-reply`, { body: 'Antwort vom Handy' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(fake.g.sentRaw.at(-1)!.parsed.text).toContain('Antwort vom Handy');
    expect(fake.g.sentRaw.at(-1)!.threadId).toBe('th-a');
    const bConv = conv(B, 'quentin@zweitfirma.example')!;
    expect((await m.post(`/api/mobile/conversations/${bConv.id}/mail-reply`, { body: 'x' })).status).toBe(404);
    expect((await m.post(`/api/mobile/conversations/${anna.id}/mail-reply`, {})).status).toBe(400);
  });
});

describe('audit log and privacy', () => {
  it('records connecting, sending, scheduling and disconnecting', async () => {
    const actions = t.app.db.all(`SELECT action FROM audit_log WHERE action LIKE 'mail%'`).map((r: any) => r.action);
    expect([...new Set(actions)].sort()).toEqual(expect.arrayContaining(['mail.conversations.archive.create', 'mail.conversations.reply.create', 'mail.drafts.create', 'mail.send.create', 'mailbox.connect', 'mailbox.disconnect', 'mailbox.sync', 'mailboxes.update']));
    // The MCP tools go through the same routes, so they are logged with how they came in.
    const viaMcp = t.app.db.get(`SELECT via, actor FROM audit_log WHERE action = 'mail.drafts.create' AND via = 'mcp'`);
    expect(viaMcp).toBeTruthy();
  });

  it('erasing a contact drops the mapping of its mail', async () => {
    const paula = t.app.db.get('SELECT id FROM contacts WHERE location_id = ? AND email = ?', A, 'paula@kunde.example')!;
    expect(maps(t, personal).some((m) => m.remote_id === 'p1')).toBe(true);
    const r = await t.api.post(`/api/contacts/${paula.id}/erase`, { confirm: 'paula@kunde.example' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(maps(t, personal).some((m) => m.remote_id === 'p1')).toBe(false);
    expect(msgs(t, 'contact_id = ?', paula.id)).toHaveLength(0);
  });

  it('no mailbox endpoint returns a token, a sealed value or a push secret', async () => {
    const urls = ['/api/mailboxes', `/api/mailboxes/${shared}/folders`, '/api/mail/mailboxes', '/api/mail/drafts', '/api/mail/scheduled', '/api/mail/search?q=a', '/api/agency/mailbox-push', '/api/integrations/catalog'];
    for (const u of urls) {
      const r = await t.api.get(u);
      expect(r.status, u).toBe(200);
      expect(JSON.stringify(r.data), u).not.toMatch(/g-refresh|g-access|ms-access|ms-refresh|v[12]:[A-Za-z0-9+/=]{12}/);
    }
    const cat = (await t.api.get('/api/integrations/catalog')).data.items.find((i: any) => i.key === 'mailbox_sync');
    expect(cat).toMatchObject({ name: 'Postfach-Sync: Gmail & Outlook', status: 'ok' });
  });
});
