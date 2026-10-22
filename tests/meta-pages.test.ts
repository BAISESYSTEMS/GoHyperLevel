import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { signBody } from '../server/services/meta.js';
import { MIGRATE_META_PAGES } from '../server/modules/meta-channels.js';

/** Several Facebook pages / Instagram accounts per sub-account: routing by page ID, the page as sub-channel, the right token. */

const APP_SECRET = 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6'; // oss-check: allow (fake test secret)
const TOKEN_A = 'EAAGpageA' + 'a'.repeat(40);
const TOKEN_B = 'EAAGpageB' + 'b'.repeat(40);
const calls: { method: string; url: string; body: any; token: string }[] = [];
let n = 0;
const fake = async (input: string, init: RequestInit = {}) => {
  const url = String(input);
  const method = init.method ?? 'GET';
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  const token = String((init.headers as any)?.authorization ?? '').replace('Bearer ', '');
  calls.push({ method, url, body, token });
  const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  if (token !== TOKEN_A && token !== TOKEN_B) return json({ error: { message: 'Invalid OAuth access token', code: 190 } }, 401);
  const path = new URL(url).pathname.replace(/^\/v\d+\.\d+\//, '');
  if (method === 'GET' && path === '1001') return json({ name: 'Malerei Nord' });
  if (method === 'GET' && path === '2002') return json({ name: 'Malerei Süd' });
  if (method === 'GET' && path === '2992') return json({ username: 'malerei.sued' });
  if (method === 'GET' && path === '7771') return json({ first_name: 'Nora', last_name: 'Nord' });
  if (method === 'GET' && path === '8882') return json({ first_name: token === TOKEN_B ? 'Sina' : 'FALSCH', last_name: 'Süd' });
  if (method === 'GET' && path === '9993') return json({ name: 'Ines Insta', username: 'ines.insta' });
  if (method === 'POST' && path === 'me/messages') return json({ recipient_id: body.recipient.id, message_id: `m_${++n}` });
  if (method === 'POST' && path.endsWith('/subscribed_apps')) return json({ success: true });
  return json({ error: { message: `unknown ${method} ${path}`, code: 100 } }, 400);
};

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const hook = (payload: unknown) => {
  const raw = JSON.stringify(payload);
  return t.api.raw(`/hooks/meta/${loc}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signBody(raw, APP_SECRET) }, body: raw });
};
const dm = (page: string, from: string, mid: string, text: string, object = 'page') => ({ object, entry: [{ id: page, time: Date.now(), messaging: [{ sender: { id: from }, recipient: { id: page }, timestamp: Date.now(), message: { mid, text } }] }] });
const last = (pred: (c: (typeof calls)[number]) => boolean) => [...calls].reverse().find(pred)!;

beforeAll(async () => {
  t = await startTestApp();
  t.app.services.metaFetch = fake;
  await t.setup();
  loc = t.api.location;
});
afterAll(async () => t?.close());

describe('several Facebook pages and Instagram accounts', () => {
  it('moves an old single-page config into the list (and the identities onto that page)', async () => {
    const other = (await t.api.post('/api/locations', { name: 'Altbestand' })).data.id as string;
    const at = new Date().toISOString();
    t.app.db.insert('meta_accounts', { location_id: other, page_id: '5005', page_name: 'Alte Seite', page_token: 'sealed-token', ig_account_id: '5995', ig_username: 'alt', app_secret: '', verify_token: 'verifyverify', created_at: at, updated_at: at });
    const contact = (await t.api.post('/api/contacts', { first_name: 'Alt' }, { 'x-location-id': other })).data;
    t.app.db.insert('meta_identities', { location_id: other, channel: 'messenger', external_id: '123456', contact_id: contact.id, name: 'Alt', created_at: at });
    t.app.db.raw.exec(MIGRATE_META_PAGES);
    expect(t.app.db.all('SELECT page_id, page_name, page_token, ig_account_id, ig_username FROM meta_pages WHERE location_id = ?', other)).toEqual([
      { page_id: '5005', page_name: 'Alte Seite', page_token: 'sealed-token', ig_account_id: '5995', ig_username: 'alt' },
    ]);
    expect(t.app.db.get('SELECT account_id FROM meta_identities WHERE location_id = ?', other)).toEqual({ account_id: '5005' });
    expect(t.app.db.get('SELECT page_id, page_token, ig_account_id FROM meta_accounts WHERE location_id = ?', other)).toEqual({ page_id: '', page_token: '', ig_account_id: '' });
    // Running it again changes nothing.
    t.app.db.raw.exec(MIGRATE_META_PAGES);
    expect(t.app.db.all('SELECT id FROM meta_pages WHERE location_id = ?', other)).toHaveLength(1);
  });

  it('keeps the single-page fields working and adds more pages, never showing a token', async () => {
    const s = (await t.api.put('/api/settings/meta', { app_secret: APP_SECRET, page_id: '1001', page_token: TOKEN_A })).data;
    expect(s.messenger).toMatchObject({ page_id: '1001', configured: true });
    expect(s.pages).toHaveLength(1);
    const p2 = await t.api.post('/api/settings/meta/pages', { page_id: '2002', ig_account_id: '2992', page_token: TOKEN_B });
    expect(p2.status, JSON.stringify(p2.data)).toBe(200);
    expect(p2.data).toMatchObject({ page_id: '2002', ig_account_id: '2992', token_set: true, messenger: true, instagram: true });
    expect((await t.api.post('/api/settings/meta/pages', { page_id: '2002', page_token: TOKEN_B })).status).toBe(400);
    expect((await t.api.post('/api/settings/meta/pages', { page_id: '3003' })).status).toBe(400);
    const all = (await t.api.get('/api/settings/meta')).data;
    expect(all.pages.map((p: any) => p.page_id)).toEqual(['1001', '2002']);
    expect(all.instagram).toMatchObject({ account_id: '2992', configured: true });
    expect(JSON.stringify(all)).not.toContain(TOKEN_B);
    expect(JSON.stringify(t.app.db.all('SELECT * FROM meta_pages'))).not.toContain(TOKEN_B);
    const test = (await t.api.post('/api/settings/meta/test')).data.results;
    expect(test.messenger.info).toBe('Seite „Malerei Nord“');
    expect(test['messenger:2002'].info).toBe('Seite „Malerei Süd“');
    expect(test['instagram:2002'].info).toBe('@malerei.sued');
    const sub = (await t.api.post('/api/settings/meta/subscribe')).data.results;
    expect(sub['messenger:2002'].ok).toBe(true);
    expect(last((c) => c.url.includes('2002/subscribed_apps')).token).toBe(TOKEN_B);
  });

  it('routes inbound messages by page ID and shows the page as a sub-channel', async () => {
    expect((await (await hook(dm('1001', '7771', 'm_a1', 'Hallo Nord'))).json()).messages).toBe(1);
    expect((await (await hook(dm('2002', '8882', 'm_b1', 'Hallo Süd'))).json()).messages).toBe(1);
    // the profile of a person who wrote to page B is read with page B's token
    expect(last((c) => c.url.includes('/8882?')).token).toBe(TOKEN_B);
    const a = t.app.db.get(`SELECT * FROM messages WHERE external_id = 'fb:m_a1'`);
    const b = t.app.db.get(`SELECT * FROM messages WHERE external_id = 'fb:m_b1'`);
    expect(a.source).toBe('Messenger · Malerei Nord');
    expect(b.source).toBe('Messenger · Malerei Süd');
    expect(t.app.db.get('SELECT first_name FROM contacts WHERE id = ?', b.contact_id)).toEqual({ first_name: 'Sina' });
    expect(t.app.db.get(`SELECT account_id FROM meta_identities WHERE external_id = '8882'`)).toEqual({ account_id: '2002' });
    // Instagram account of page B
    expect((await (await hook(dm('2992', '9993', 'ig_1', 'Hi von Insta', 'instagram'))).json()).messages).toBe(1);
    expect(t.app.db.get(`SELECT source FROM messages WHERE external_id = 'ig:ig_1'`)).toEqual({ source: 'Instagram · @malerei.sued' });
  });

  it('replies through the page the person wrote to', async () => {
    const b = t.app.db.get(`SELECT contact_id FROM messages WHERE external_id = 'fb:m_b1'`).contact_id;
    const a = t.app.db.get(`SELECT contact_id FROM messages WHERE external_id = 'fb:m_a1'`).contact_id;
    const status = (await t.api.get(`/api/messages/meta/status?contact_id=${b}`)).data.channels.messenger;
    expect(status).toMatchObject({ reachable: true, via: 'Malerei Süd' });
    expect((await t.api.post('/api/messages', { contact_id: b, channel: 'messenger', body: 'Gern!' })).data.status).toBe('sent');
    expect(last((c) => c.url.endsWith('/me/messages'))).toMatchObject({ token: TOKEN_B, body: { recipient: { id: '8882' } } });
    expect((await t.api.post('/api/messages', { contact_id: a, channel: 'messenger', body: 'Moin!' })).data.status).toBe('sent');
    expect(last((c) => c.url.endsWith('/me/messages')).token).toBe(TOKEN_A);
    const ig = t.app.db.get(`SELECT contact_id FROM messages WHERE external_id = 'ig:ig_1'`).contact_id;
    await t.api.post('/api/messages', { contact_id: ig, channel: 'instagram', body: 'Danke!' });
    expect(last((c) => c.url.endsWith('/me/messages')).token).toBe(TOKEN_B);
    // metaKit picks the page by account ID for other modules
    await t.app.services.metaKit.graph(loc, 'messenger', 'GET', '2002?fields=name', undefined, '2002');
    expect(last((c) => c.url.includes('/2002?')).token).toBe(TOKEN_B);
    expect(t.app.services.metaKit.ids(loc).pages).toHaveLength(2);
  });

  it('a removed page no longer sends – with a clear reason', async () => {
    const page = (await t.api.get('/api/settings/meta/pages')).data.find((p: any) => p.page_id === '2002');
    expect((await t.api.del(`/api/settings/meta/pages/${page.id}`)).status).toBe(200);
    const b = t.app.db.get(`SELECT contact_id FROM messages WHERE external_id = 'fb:m_b1'`).contact_id;
    const r = await t.api.post('/api/messages', { contact_id: b, channel: 'messenger', body: 'Hallo?' });
    expect(r.status).toBe(400);
    expect(r.data.error).toContain('nicht mehr verbunden');
    // and its messages are now unknown IDs
    expect((await (await hook(dm('2002', '8882', 'm_b2', 'Noch da?'))).json()).skipped).toBe(1);
  });
});
