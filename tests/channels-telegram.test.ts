import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { deepLink, parseUpdate, sendMethodFor, tgErrorText } from '../server/services/telegram.js';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1';
const calls: { url: string; method: string; body: any }[] = [];
let msgN = 100;
let blocked = false;

const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
const fake = async (input: string, init: RequestInit = {}) => {
  const url = String(input);
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ url, method: init.method ?? 'GET', body });
  if (url.startsWith(`https://api.telegram.org/file/bot${TOKEN}/`)) return new Response(Buffer.from('JPEG'), { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '4' } });
  const m = url.match(/^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/);
  if (!m) return json({ ok: false, description: 'not found' }, 404);
  if (m[1] !== TOKEN) return json({ ok: false, error_code: 401, description: 'Unauthorized' }, 401);
  switch (m[2]) {
    case 'getMe':
      return json({ ok: true, result: { id: 123456789, is_bot: true, first_name: 'Malerei Bot', username: 'malerei_bot' } });
    case 'setWebhook':
      return json({ ok: true, result: true });
    case 'getWebhookInfo':
      return json({ ok: true, result: { url: 'https://crm.example.com/hooks/telegram/x', pending_update_count: 2 } });
    case 'deleteWebhook':
      return json({ ok: true, result: true });
    case 'getFile':
      return json({ ok: true, result: { file_id: body.file_id, file_path: 'photos/file_1.jpg' } });
    case 'sendMessage':
    case 'sendPhoto':
    case 'sendDocument':
      if (blocked) return json({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }, 403);
      return json({ ok: true, result: { message_id: ++msgN, chat: { id: body.chat_id } } });
  }
  return json({ ok: false, description: `unknown ${m[2]}` }, 400);
};

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let secret = '';
let updateId = 1;
const update = (message: any) => ({ update_id: updateId++, message: { message_id: updateId * 10, date: Math.floor(Date.now() / 1000), chat: { id: 555001, type: 'private' }, from: { id: 555001, is_bot: false, first_name: 'Tina', last_name: 'Telegram', username: 'tina_t' }, ...message } });
const hook = (payload: unknown, token = secret, location = loc) =>
  t.api.raw(`/hooks/telegram/${location}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': token }, body: JSON.stringify(payload) });

beforeAll(async () => {
  t = await startTestApp();
  t.app.services.channelFetch = fake;
  await t.setup();
  loc = t.api.location;
});
afterAll(() => t.close());

describe('Telegram: pure helpers', () => {
  it('parses text, media, /start payloads and shared contacts', () => {
    const base = { update_id: 1, message: { message_id: 7, date: 1700000000, chat: { id: 42, type: 'private' }, from: { id: 42, first_name: 'Ann', username: 'ann!x' } } };
    expect(parseUpdate({ ...base, message: { ...base.message, text: 'Hallo' } })).toMatchObject({ chatId: '42', fromId: '42', name: 'Ann', username: 'annx', body: 'Hallo', start: null });
    expect(parseUpdate({ ...base, message: { ...base.message, text: '/start fb_herbst-24' } })?.start).toBe('fb_herbst-24');
    expect(parseUpdate({ ...base, message: { ...base.message, text: '/start' } })?.start).toBe('');
    expect(parseUpdate({ ...base, message: { ...base.message, text: '/start <script>' } })?.start).toBe('');
    const photo = parseUpdate({ ...base, message: { ...base.message, photo: [{ file_id: 'small_aaaaaaaaaa' }, { file_id: 'big_bbbbbbbbbbbb', file_size: 9 }], caption: 'Wand' } });
    expect(photo).toMatchObject({ body: 'Wand', media: { kind: 'image', file_id: 'big_bbbbbbbbbbbb' } });
    expect(parseUpdate({ ...base, message: { ...base.message, voice: { file_id: 'voice_cccccccccc', mime_type: 'audio/ogg' } } })).toMatchObject({ body: '🎤 Sprachnachricht', media: { kind: 'audio', voice: true } });
    expect(parseUpdate({ ...base, message: { ...base.message, document: { file_id: 'doc_dddddddddddd', file_name: 'Angebot.pdf', mime_type: 'application/pdf' } } })).toMatchObject({ body: '📄 Angebot.pdf', media: { kind: 'document', filename: 'Angebot.pdf' } });
    expect(parseUpdate({ ...base, message: { ...base.message, contact: { user_id: 42, phone_number: '491701234567', first_name: 'Ann' } } })?.phone).toBe('+491701234567');
    expect(parseUpdate({ ...base, message: { ...base.message, contact: { user_id: 99, phone_number: '491701234567' } } })?.phone).toBeUndefined();
    expect(parseUpdate({ update_id: 2, edited_message: base.message })).toBeNull();
    expect(parseUpdate({ ...base, message: { ...base.message, chat: { id: 'x' } } })).toBeNull();
  });

  it('builds deep links, picks the send method and translates errors', () => {
    expect(deepLink('malerei_bot', 'herbst24')).toBe('https://t.me/malerei_bot?start=herbst24');
    expect(deepLink('malerei_bot', 'bad campaign!')).toBe('https://t.me/malerei_bot');
    expect(sendMethodFor('https://x.de/a.JPG?x=1').method).toBe('sendPhoto');
    expect(sendMethodFor('https://x.de/doc.pdf').method).toBe('sendDocument');
    expect(sendMethodFor('https://x.de/v.ogg').method).toBe('sendVoice');
    expect(tgErrorText(403, 'Forbidden: bot was blocked by the user')).toBe('Kontakt hat den Bot blockiert');
    expect(tgErrorText(429, 'Too Many Requests', 7)).toContain('7 Sekunden');
  });
});

describe('Telegram: settings, webhook, inbox, workflows', () => {
  it('checks the token with getMe and never returns it', async () => {
    let r = await t.api.put('/api/settings/channels/telegram', { bot_token: 'nope' });
    expect(r.status).toBe(400);
    r = await t.api.put('/api/settings/channels/telegram', { bot_token: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawX' });
    expect(r.status).toBe(400);
    expect(r.data.error).toContain('Bot-Token ungültig');
    r = await t.api.put('/api/settings/channels/telegram', { bot_token: TOKEN, welcome: 'Hallo {{contact.first_name}}, schön dass du da bist!', start_tags: 'telegram-lead, neu' });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ configured: true, token_set: true, bot: { username: 'malerei_bot' }, link: 'https://t.me/malerei_bot', start_tags: ['telegram-lead', 'neu'] });
    expect(JSON.stringify(r.data)).not.toContain(TOKEN);
    const row = t.app.db.get(`SELECT secrets FROM channel_accounts WHERE location_id = ? AND channel = 'telegram'`, loc);
    expect(row.secrets).toMatch(/^v1:/);
    expect(row.secrets).not.toContain('AAHdq');
    secret = (await import('../server/services/channel-kit.js')).getAccount(t.app, loc, 'telegram')!.secrets.webhook_secret;
    expect(secret).toMatch(/^[\w-]{20,}$/);
    // http base URL: Telegram needs https
    r = await t.api.post('/api/settings/channels/telegram/webhook');
    expect(r.status).toBe(400);
    const link = await t.api.get('/api/settings/channels/telegram/link?campaign=herbst24');
    expect(link.data.link).toBe('https://t.me/malerei_bot?start=herbst24');
    const test = await t.api.post('/api/settings/channels/telegram/test');
    expect(test.data.info).toContain('@malerei_bot');
  });

  it('refuses updates without the secret token header', async () => {
    expect((await hook(update({ text: 'hi' }), 'wrong')).status).toBe(401);
    expect((await hook(update({ text: 'hi' }), '')).status).toBe(401);
    expect((await hook(update({ text: 'hi' }), secret, 'nolocation')).status).toBe(404);
  });

  it('a /start deep link creates the lead with the campaign as source and sends the welcome', async () => {
    let fired: any = null;
    t.app.events.on('telegram.started', (e) => void (fired = e.data));
    const r = await hook(update({ text: '/start herbst24' }));
    expect(r.status).toBe(200);
    await t.app.events.flush();
    const c = t.app.db.get(`SELECT * FROM contacts WHERE location_id = ? AND first_name = 'Tina'`, loc);
    expect(c).toBeTruthy();
    expect(c.source).toBe('Telegram');
    expect(JSON.parse(c.tags)).toEqual(expect.arrayContaining(['telegram', 'telegram-lead', 'neu']));
    expect(JSON.parse(c.custom).telegram).toBe('@tina_t');
    expect(fired).toMatchObject({ contactId: c.id, campaign: 'herbst24', created: true });
    const touch = t.app.db.get('SELECT * FROM attribution_contacts WHERE contact_id = ?', c.id);
    expect(touch).toMatchObject({ first_source: 'telegram', first_medium: 'bot', first_campaign: 'herbst24' });
    const welcome = calls.find((x) => x.url.endsWith('/sendMessage'));
    expect(welcome?.body).toMatchObject({ chat_id: '555001', text: 'Hallo Tina, schön dass du da bist!' });
    const msgs = t.app.db.all('SELECT * FROM messages WHERE contact_id = ? ORDER BY created_at', c.id);
    expect(msgs.map((m) => [m.channel, m.direction, m.status])).toEqual([
      ['telegram', 'in', 'received'],
      ['telegram', 'out', 'sent'],
    ]);
  });

  it('messages and photos land in the conversation; duplicates are dropped; media is proxied', async () => {
    let inbound = 0;
    t.app.events.on('message.inbound', (e) => void (e.data.message.channel === 'telegram' && inbound++));
    const u = update({ text: 'Was kostet ein Zimmer?' });
    await hook(u);
    await hook(u);
    await hook(update({ photo: [{ file_id: 'AgACAgIAAxkBAAIBc2' }], caption: 'So sieht es aus' }));
    await t.app.events.flush();
    expect(inbound).toBe(2);
    const c = t.app.db.get(`SELECT * FROM contacts WHERE location_id = ? AND first_name = 'Tina'`, loc);
    const conv = await t.api.get(`/api/conversations?channel=telegram`);
    expect(conv.data[0]).toMatchObject({ contact_id: c.id, last_channel: 'telegram', last_message: 'So sieht es aus' });
    const photo = t.app.db.get(`SELECT * FROM messages WHERE contact_id = ? AND channel_media IS NOT NULL AND direction = 'in'`, c.id);
    const media = await t.api.raw(`/api/messages/channels/media/${photo.id}?locationId=${loc}`, { headers: { cookie: t.api.cookie } });
    expect(media.status).toBe(200);
    expect(media.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await media.arrayBuffer()).toString()).toBe('JPEG');
    // groups stay out
    const before = t.app.db.get('SELECT COUNT(*) n FROM messages').n;
    await hook({ update_id: updateId++, message: { message_id: 1, date: 1, chat: { id: -100, type: 'group' }, from: { id: 9, first_name: 'G' }, text: 'hi' } });
    expect(t.app.db.get('SELECT COUNT(*) n FROM messages').n).toBe(before);
  });

  it('replies from the inbox (text and file link), via MCP channel list and workflows', async () => {
    const c = t.app.db.get(`SELECT * FROM contacts WHERE location_id = ? AND first_name = 'Tina'`, loc);
    const st = await t.api.get(`/api/messages/channels/status?contact_id=${c.id}`);
    expect(st.data.channels.telegram).toMatchObject({ configured: true, reachable: true, handle: '@tina_t' });
    let r = await t.api.post('/api/messages', { contact_id: c.id, channel: 'telegram', body: 'Ab 290 € pro Zimmer.' });
    expect(r.data).toMatchObject({ channel: 'telegram', status: 'sent' });
    r = await t.api.post('/api/messages', { contact_id: c.id, channel: 'telegram', body: 'Unser Angebot', media_url: 'https://example.com/angebot.pdf' });
    expect(r.data.status).toBe('sent');
    expect(calls.at(-1)).toMatchObject({ url: expect.stringContaining('/sendDocument'), body: { document: 'https://example.com/angebot.pdf', caption: 'Unser Angebot' } });
    r = await t.api.post('/api/messages', { contact_id: c.id, channel: 'telegram', body: 'x'.repeat(4097) });
    expect(r.status).toBe(400);
    blocked = true;
    r = await t.api.post('/api/messages', { contact_id: c.id, channel: 'telegram', body: 'Noch da?' });
    expect(r.data).toMatchObject({ status: 'failed', error: 'Kontakt hat den Bot blockiert' });
    blocked = false;
    // a contact who never started the bot
    const other = (await t.api.post('/api/contacts', { first_name: 'Ohne', email: 'ohne@example.com' })).data;
    r = await t.api.post('/api/messages', { contact_id: other.id, channel: 'telegram', body: 'Hi' });
    expect(r.status).toBe(400);
    // MCP ghl_send_message lists the channel
    const key = (await t.api.post('/api/api-keys', { name: 'mcp' })).data.key;
    const list = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const tools = (await list.json()).result.tools;
    expect(tools.find((x: any) => x.name === 'ghl_send_message').inputSchema.properties.channel.enum).toEqual(expect.arrayContaining(['telegram', 'discord', 'push', 'whatsapp']));
    expect(tools.some((x: any) => x.name === 'ghl_telegram_link')).toBe(true);
  });

  it('workflow action and trigger with campaign filter', async () => {
    const wf = await t.api.post('/api/workflows', {
      name: 'Telegram-Lead',
      status: 'active',
      trigger: { type: 'telegram.started', config: { campaign: 'messe' } },
      steps: [{ id: 's1', type: 'telegram_send', body: 'Danke {{contact.first_name}}! Hier unser Katalog.', media_url: 'https://example.com/katalog.png' }],
    });
    expect(wf.status).toBe(200);
    await t.api.patch(`/api/workflows/${wf.data.id}`, { status: 'active' });
    const n = calls.length;
    await hook({ update_id: updateId++, message: { message_id: 999, date: Math.floor(Date.now() / 1000), chat: { id: 777, type: 'private' }, from: { id: 777, first_name: 'Max' }, text: '/start herbst24' } });
    await t.app.events.flush();
    expect(calls.slice(n).some((x) => x.url.endsWith('/sendPhoto'))).toBe(false);
    await hook({ update_id: updateId++, message: { message_id: 1000, date: Math.floor(Date.now() / 1000), chat: { id: 778, type: 'private' }, from: { id: 778, first_name: 'Mia' }, text: '/start messe' } });
    await t.app.events.flush();
    const sent = calls.slice(n).find((x) => x.url.endsWith('/sendPhoto'));
    expect(sent?.body).toMatchObject({ chat_id: '778', photo: 'https://example.com/katalog.png', caption: 'Danke Mia! Hier unser Katalog.' });
  });

  it('shows up in the integrations catalogue and can be removed', async () => {
    const cat = await t.api.get('/api/integrations/catalog');
    expect(cat.data.items.find((x: any) => x.key === 'telegram')).toMatchObject({ status: 'partial' });
    const r = await t.api.del('/api/settings/channels/telegram');
    expect(r.status).toBe(200);
    expect(calls.at(-1)?.url).toContain('/deleteWebhook');
    expect((await t.api.get('/api/settings/channels/telegram')).data.configured).toBe(false);
  });
});
