import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { signBody } from '../server/services/meta.js';
import { toolCatalog } from '../server/services/agent-tools.js';
import { installOutboundGuard, uninstallOutboundGuard } from '../server/services/outbound-guard.js';
import { MSG_DRAFT_TOOLS } from '../server/modules/msg-drafts.js';
import { draftAction } from '../web/src/pages/msg-drafts-model';

/** SMS/WhatsApp reply drafts (docs/team-inbox.md#sms-and-whatsapp-drafts): the agent/MCP stores them, never sends; the normal send path keeps its rules. */

const APP_SECRET = 'f1e2d3c4b5a6f7e8d9c0b1a2f3e4d5c6'; // oss-check: allow (fake test secret)
const WA_TOKEN = 'EAAGdrafttoken' + 'x'.repeat(40);
const graph: { method: string; path: string; body: any }[] = [];
const fake = async (input: string, init: RequestInit = {}) => {
  const u = new URL(String(input));
  const path = u.pathname.replace(/^\/v\d+\.\d+\//, '');
  const method = init.method ?? 'GET';
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  graph.push({ method, path, body });
  const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  if (method === 'GET' && path === '1111') return json({ id: '1111', display_phone_number: '+49 30 123456', verified_name: 'Test' });
  if (method === 'GET' && path === '2222') return json({ id: '2222', name: 'WABA' });
  if (method === 'POST' && path === '2222/subscribed_apps') return json({ success: true });
  if (method === 'POST' && path === '1111/messages') return json({ messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: `wamid.OUT${graph.length}` }] });
  return json({ error: { message: `unknown ${method} ${path}`, code: 100 } }, 400);
};

let t: Awaited<ReturnType<typeof startTestApp>>;
let locA = '';
let locB = '';
let anna = ''; // locA, has written on WhatsApp just now
let ben = ''; // locA, never wrote on WhatsApp
let noPhone = '';
let geheim = ''; // locB
let key = '';
let keyB = '';

const mcp = async (k: string, name: string, args: Record<string, unknown>) => {
  const r = await fetch(`${t.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const res = (await r.json()).result;
  return { error: !!res.isError, text: String(res.content?.[0]?.text ?? ''), data: res.isError ? null : JSON.parse(res.content[0].text) };
};
const messagesOf = (contactId: string) => t.app.db.all<any>('SELECT * FROM messages WHERE contact_id = ? ORDER BY created_at', contactId);
const login = async (email: string) => {
  t.api.clearCookie();
  expect((await t.api.post('/api/auth/login', { email, password: 'geheim123' })).status).toBe(200);
};
const waHook = (from: string, id: string, text: string) => {
  const raw = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: '2222', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '4930123456', phone_number_id: '1111' }, contacts: [{ profile: { name: 'Anna' }, wa_id: from }], messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }],
  });
  return t.api.raw(`/hooks/meta/${locA}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signBody(raw, APP_SECRET) }, body: raw });
};

beforeAll(async () => {
  installOutboundGuard();
  t = await startTestApp();
  t.app.services.metaFetch = fake;
  await t.setup();
  locA = t.api.location;
  expect((await t.api.put('/api/settings/meta', { wa_phone_number_id: '1111', wa_business_account_id: '2222', wa_token: WA_TOKEN, app_secret: APP_SECRET })).status).toBe(200);
  expect((await waHook('4915112345678', 'wamid.IN1', 'Hallo, habt ihr morgen Zeit?')).status).toBe(200);
  anna = t.app.db.get<any>(`SELECT contact_id FROM messages WHERE channel = 'whatsapp' AND direction = 'in'`).contact_id;
  ben = (await t.api.post('/api/contacts', { first_name: 'Ben', phone: '+4917099998888' })).data.id;
  noPhone = (await t.api.post('/api/contacts', { first_name: 'Ohne', email: 'ohne@example.com' })).data.id;
  key = (await t.api.post('/api/api-keys', { name: 'Entwürfe' })).data.key;
  locB = (await t.api.post('/api/locations', { name: 'Andere Firma' })).data.id;
  t.api.setLocation(locB);
  geheim = (await t.api.post('/api/contacts', { first_name: 'Geheim', phone: '+4916055554444' })).data.id;
  keyB = (await t.api.post('/api/api-keys', { name: 'B' })).data.key;
  t.api.setLocation(locA);
  await t.api.post('/api/users', { email: 'ohne-inbox@example.com', name: 'Ohne Inbox', password: 'geheim123', role: 'member', locations: [locA], permissions: ['contacts'] });
  await t.api.post('/api/users', { email: 'mit-inbox@example.com', name: 'Mit Inbox', password: 'geheim123', role: 'member', locations: [locA], permissions: ['contacts', 'conversations'] });
}, 60_000);
afterAll(async () => {
  await t.close();
  uninstallOutboundGuard();
});

describe('ghl_draft_message (agent / MCP)', () => {
  it('is a plain write tool that never sends and returns no third-party text', () => {
    const tool = MSG_DRAFT_TOOLS.find((x) => x.name === 'ghl_draft_message')!;
    expect(tool.annotations.openWorldHint).toBe(false);
    expect(tool.untrusted).toBeFalsy();
    const admin = t.app.db.get('SELECT * FROM users WHERE role = ? LIMIT 1', 'admin');
    expect(toolCatalog(t.app, admin, {}).find((x) => x.name === 'ghl_draft_message')?.klass).toBe('write');
  });

  it('stores an SMS draft in the conversation – nothing goes out', async () => {
    const before = graph.length;
    const r = await mcp(key, 'ghl_draft_message', { contact_id: ben, channel: 'sms', body: 'Hallo Ben, morgen um 10 passt. Grüße' });
    expect(r.error, r.text).toBe(false);
    expect(r.data).toMatchObject({ ok: true, draft: true, sent: false, channel: 'sms', contact_id: ben, replaced: 0 });
    expect(r.data.link).toBe(`conversations/${r.data.conversation_id}`);
    const rows = messagesOf(ben);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'draft', channel: 'sms', direction: 'out', source: 'KI-Agent', provider_id: null });
    expect(graph.length).toBe(before);
    // the inbox finds it: drafts filter, thread, drafts list (with its channel)
    const list = (await t.api.get('/api/conversations?filter=drafts')).data;
    expect(list.map((c: any) => c.id)).toContain(r.data.conversation_id);
    const thread = (await t.api.get(`/api/conversations/${r.data.conversation_id}/messages`)).data;
    expect(thread.messages.find((m: any) => m.id === r.data.id)).toMatchObject({ status: 'draft', channel: 'sms' });
    expect((await t.api.get('/api/conversations/drafts')).data.find((d: any) => d.id === r.data.id)).toMatchObject({ channel: 'sms' });
  });

  it('a new draft replaces the previous one of the same channel', async () => {
    const r = await mcp(key, 'ghl_draft_message', { contact_id: ben, channel: 'sms', body: 'Neue Fassung' });
    expect(r.data.replaced).toBe(1);
    expect(messagesOf(ben).map((m) => [m.status, m.body])).toEqual([['draft', 'Neue Fassung']]);
  });

  it('WhatsApp: says whether the 24-hour window is open, sends nothing', async () => {
    const before = graph.length;
    const open = await mcp(key, 'ghl_draft_message', { contact_id: anna, channel: 'whatsapp', body: 'Ja, morgen ab 9 Uhr.' });
    expect(open.data).toMatchObject({ draft: true, channel: 'whatsapp', window_open: true });
    expect(open.data.hint).toBeUndefined();
    const closed = await mcp(key, 'ghl_draft_message', { contact_id: ben, channel: 'whatsapp', body: 'Hallo Ben' });
    expect(closed.data).toMatchObject({ draft: true, window_open: false });
    expect(closed.data.hint).toContain('24-Stunden-Fenster');
    expect(graph.length).toBe(before);
    expect(messagesOf(anna).filter((m) => m.direction === 'out').map((m) => m.status)).toEqual(['draft']);
  });

  it('takes a conversation id too, and refuses what does not fit', async () => {
    const conv = t.app.db.get<any>('SELECT id FROM conversations WHERE contact_id = ?', anna).id;
    const r = await mcp(key, 'ghl_draft_message', { conversation_id: conv, channel: 'sms', body: 'Per SMS' });
    expect(r.data).toMatchObject({ contact_id: anna, conversation_id: conv, channel: 'sms' });
    expect((await mcp(key, 'ghl_draft_message', { channel: 'sms', body: 'x' })).text).toContain('contact_id oder conversation_id');
    expect((await mcp(key, 'ghl_draft_message', { contact_id: noPhone, channel: 'sms', body: 'x' })).text).toContain('Telefonnummer');
    expect((await mcp(key, 'ghl_draft_message', { contact_id: ben, channel: 'sms', body: 'x'.repeat(1601) })).error).toBe(true);
    expect((await mcp(key, 'ghl_draft_message', { contact_id: ben, conversation_id: conv, channel: 'sms', body: 'x' })).text).toContain('passt nicht');
    expect((await t.api.post('/api/conversations/drafts', { contact_id: ben, channel: 'email', body: 'x' })).status).toBe(400);
    expect((await t.api.post('/api/conversations/drafts', { contact_id: ben, channel: 'sms', body: '   ' })).status).toBe(400);
  });
});

describe('sending and discarding use the existing paths and rules', () => {
  it('WhatsApp outside the window: the draft text is refused by the send path and the draft stays', async () => {
    const draft = messagesOf(ben).find((m) => m.channel === 'whatsapp' && m.status === 'draft')!;
    const r = await t.api.post('/api/messages/meta', { contact_id: ben, channel: 'whatsapp', body: draft.body });
    expect(r.status).toBe(400);
    expect(r.data.error).toContain('24-Stunden-Fenster');
    expect(t.app.db.get('SELECT status FROM messages WHERE id = ?', draft.id)).toEqual({ status: 'draft' });
  });

  it('WhatsApp inside the window: sent like any reply, then the draft is removed', async () => {
    const draft = messagesOf(anna).find((m) => m.channel === 'whatsapp' && m.status === 'draft')!;
    const sent = (await t.api.post('/api/messages/meta', { contact_id: anna, channel: 'whatsapp', body: `${draft.body} Bis dann!` })).data;
    expect(sent.status).toBe('sent');
    expect(graph.at(-1)).toMatchObject({ method: 'POST', path: '1111/messages' });
    expect((await t.api.del(`/api/messages/${draft.id}`)).status).toBe(200);
    expect(t.app.db.get('SELECT id FROM messages WHERE id = ?', draft.id)).toBeUndefined();
    // a sent message is not a draft and cannot be discarded
    expect((await t.api.del(`/api/messages/${sent.id}`)).status).toBe(400);
  });

  it('SMS: sending goes through POST /api/messages (DND applies), discarding through DELETE', async () => {
    await t.api.patch(`/api/contacts/${ben}`, { dnd: 1 });
    const draft = messagesOf(ben).find((m) => m.channel === 'sms' && m.status === 'draft')!;
    const blocked = (await t.api.post('/api/messages', { contact_id: ben, channel: 'sms', body: draft.body })).data;
    expect(blocked.status).toBe('failed');
    expect(t.app.db.get('SELECT status FROM messages WHERE id = ?', draft.id)).toEqual({ status: 'draft' });
    await t.api.patch(`/api/contacts/${ben}`, { dnd: 0 });
    expect((await t.api.del(`/api/messages/${draft.id}`)).status).toBe(200);
    expect(messagesOf(ben).filter((m) => m.channel === 'sms').map((m) => m.status)).toEqual(['failed']);
  });
});

describe('sub-account isolation and rights', () => {
  it('a key of one sub-account cannot draft into, or see, another one', async () => {
    expect((await mcp(key, 'ghl_draft_message', { contact_id: geheim, channel: 'sms', body: 'x' })).error).toBe(true);
    expect((await mcp(key, 'ghl_draft_message', { location_id: locB, contact_id: geheim, channel: 'sms', body: 'x' })).error).toBe(true);
    expect(messagesOf(geheim)).toEqual([]);
    const own = await mcp(keyB, 'ghl_draft_message', { contact_id: geheim, channel: 'sms', body: 'Nur in B' });
    expect(own.error, own.text).toBe(false);
    // locA can neither use B's conversation nor discard B's draft
    expect((await mcp(key, 'ghl_draft_message', { conversation_id: own.data.conversation_id, channel: 'sms', body: 'x' })).error).toBe(true);
    expect((await t.api.post('/api/conversations/drafts', { conversation_id: own.data.conversation_id, channel: 'sms', body: 'x' })).status).toBe(404);
    expect((await t.api.del(`/api/messages/${own.data.id}`)).status).toBe(400);
    expect(t.app.db.get('SELECT status FROM messages WHERE id = ?', own.data.id)).toEqual({ status: 'draft' });
    expect((await t.api.get('/api/conversations/drafts')).data.some((d: any) => d.id === own.data.id)).toBe(false);
  });

  it('needs the area "Konversationen", like the e-mail drafts', async () => {
    await login('ohne-inbox@example.com');
    t.api.setLocation(locA);
    expect((await t.api.post('/api/conversations/drafts', { contact_id: ben, channel: 'sms', body: 'x' })).status).toBe(403);
    await login('mit-inbox@example.com');
    t.api.setLocation(locA);
    const r = await t.api.post('/api/conversations/drafts', { contact_id: ben, channel: 'sms', body: 'Von Mia', source: 'Mia' });
    expect(r.status).toBe(200);
    expect(t.app.db.get<any>('SELECT source, user_id FROM messages WHERE id = ?', r.data.id).source).toBe('Mia');
    await login('chef@example.com');
  });
});

describe('composer: a new draft never overwrites typed text (msg-drafts-model)', () => {
  it('fills an empty composer, or one that still holds the previous draft untouched', () => {
    expect(draftAction({ draftId: 'd1', current: '' })).toBe('fill');
    expect(draftAction({ draftId: 'd1', current: '  \n' })).toBe('fill');
    expect(draftAction({ draftId: 'd2', seenId: 'd1', appliedBody: 'Alter Entwurf', current: 'Alter Entwurf' })).toBe('fill');
  });
  it('only offers it when the person typed or changed something', () => {
    expect(draftAction({ draftId: 'd1', current: 'Hallo, ich' })).toBe('offer');
    expect(draftAction({ draftId: 'd2', seenId: 'd1', appliedBody: 'Alter Entwurf', current: 'Alter Entwurf, geändert' })).toBe('offer');
    expect(draftAction({ draftId: 'd2', seenId: 'd1', appliedBody: null, current: 'Eigener Text' })).toBe('offer');
  });
  it('does nothing without a new draft (polling the same draft, typing, a discarded draft)', () => {
    expect(draftAction({ draftId: undefined, current: '' })).toBe('none');
    expect(draftAction({ draftId: 'd1', seenId: 'd1', appliedBody: 'x', current: '' })).toBe('none');
    expect(draftAction({ draftId: 'd1', seenId: 'd1', appliedBody: 'x', current: 'x und mehr' })).toBe('none');
  });
});
