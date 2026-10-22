import { generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { DiscordGateway, parseMessage, verifyInteraction, type WsLike } from '../server/services/discord.js';
import { fromSlack, signSlack, slackQuote, verifySlack } from '../server/services/slack.js';

// --- fakes ---------------------------------------------------------------------------------------

const DISCORD_TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDE.abcdefghijklmnopqrstuvwxyz0123456789AB';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUBLIC_HEX = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(12).toString('hex');
const SLACK_TOKEN = 'xoxb-1111111111-2222222222222-abcdefghijklmnopqrstuvwx';
const SLACK_SECRET = '8f742231b10e8888abcd99yyyzzz85a5'.replace(/[yz]/g, 'a'); // oss-check: allow
const calls: { url: string; method: string; body: any }[] = [];
let slackTs = 1000;

const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
const fake = async (input: string, init: RequestInit = {}) => {
  const url = String(input);
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  const auth = String((init.headers as any)?.authorization ?? '');
  calls.push({ url, method: init.method ?? 'GET', body });
  if (url.startsWith('https://discord.com/api/v10/')) {
    if (auth !== `Bot ${DISCORD_TOKEN}`) return json({ message: '401: Unauthorized', code: 0 }, 401);
    const path = url.slice('https://discord.com/api/v10'.length);
    if (path === '/users/@me') return json({ id: '900000000000000001', username: 'gohigh-bot', bot: true });
    if (path === '/applications/@me') return json({ id: '900000000000000002', name: 'HyperLevel', verify_key: PUBLIC_HEX });
    if (path === '/users/@me/guilds') return json([{ id: '1' }, { id: '2' }]);
    if (path === '/users/@me/channels') return json({ id: '700000000000000001', type: 1 });
    if (path.startsWith('/applications/900000000000000002/commands')) return json(body.map((c: any, i: number) => ({ ...c, id: String(i) })));
    if (/^\/channels\/\d+\/messages$/.test(path)) {
      if (body.content === 'dm-blocked') return json({ message: 'Cannot send messages to this user', code: 50007 }, 403);
      return json({ id: `80000000000000${String(calls.length).padStart(4, '0')}`, channel_id: path.split('/')[2] });
    }
    return json({ message: 'unknown', code: 0 }, 404);
  }
  if (url.startsWith('https://slack.com/api/')) {
    if (auth !== `Bearer ${SLACK_TOKEN}`) return json({ ok: false, error: 'invalid_auth' });
    const method = url.slice('https://slack.com/api/'.length);
    if (method === 'auth.test') return json({ ok: true, team: 'Malerei Team', user_id: 'UBOT', user: 'gohigh' });
    if (method === 'chat.postMessage') return json({ ok: true, channel: body.channel, ts: `${++slackTs}.000100` });
    if (method === 'reactions.add') return json({ ok: true });
    return json({ ok: false, error: 'unknown_method' });
  }
  if (url.startsWith('https://hooks.slack.com/services/')) return new Response('ok', { status: 200 });
  return json({ error: 'unexpected' }, 500);
};

/** A fake WebSocket the gateway talks to; the test plays Discord. */
class FakeWs implements WsLike {
  static all: FakeWs[] = [];
  sent: any[] = [];
  onopen: WsLike['onopen'] = null;
  onmessage: WsLike['onmessage'] = null;
  onclose: WsLike['onclose'] = null;
  onerror: WsLike['onerror'] = null;
  closed = false;
  constructor(public url: string) {
    FakeWs.all.push(this);
  }
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {
    this.closed = true;
  }
  emit(p: unknown) {
    this.onmessage?.({ data: JSON.stringify(p) });
  }
  drop(code: number) {
    this.onclose?.({ code });
  }
}

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  t = await startTestApp();
  t.app.services.channelFetch = fake;
  t.app.services.discordSocket = (url: string) => new FakeWs(url);
  await t.setup();
  loc = t.api.location;
});
afterAll(async () => {
  for (const g of t.app.services.discordGateways?.values() ?? []) g.stop();
  await t.close();
});

describe('Discord: pure helpers', () => {
  it('verifies Ed25519 interaction signatures', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const raw = JSON.stringify({ type: 1 });
    const sig = sign(null, Buffer.from(ts + raw), privateKey).toString('hex');
    expect(verifyInteraction(raw, sig, ts, PUBLIC_HEX)).toBe(true);
    expect(verifyInteraction(raw + ' ', sig, ts, PUBLIC_HEX)).toBe(false);
    expect(verifyInteraction(raw, sig, String(Number(ts) - 1000), PUBLIC_HEX)).toBe(false);
    expect(verifyInteraction(raw, 'ab'.repeat(64), ts, PUBLIC_HEX)).toBe(false);
    expect(verifyInteraction(raw, sig, ts, 'zz')).toBe(false);
  });

  it('parses messages and skips bots, webhooks and system messages', () => {
    const base = { id: '110000000000000001', channel_id: '120000000000000001', author: { id: '130000000000000001', username: 'lena.dc', global_name: 'Lena' }, content: 'Hi!', type: 0, timestamp: '2026-10-04T10:00:00Z' };
    expect(parseMessage(base)).toMatchObject({ authorId: '130000000000000001', name: 'Lena', username: 'lena.dc', body: 'Hi!', guildId: null });
    expect(parseMessage({ ...base, author: { ...base.author, bot: true } })).toBeNull();
    expect(parseMessage({ ...base, webhook_id: '1' })).toBeNull();
    expect(parseMessage({ ...base, type: 7 })).toBeNull();
    const img = parseMessage({ ...base, content: '', attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/wand.png?ex=1', content_type: 'image/png', filename: 'wand.png' }, { url: 'https://evil.example/x.png', filename: 'x.png' }] });
    expect(img).toMatchObject({ body: '📷 Bild', media: { kind: 'image', filename: 'wand.png' } });
  });

  it('gateway: identify, heartbeat, resume after a drop, stop on fatal codes', async () => {
    const seen: string[] = [];
    const gw = new DiscordGateway({ token: 'tok', socket: (u) => new FakeWs(u), onDispatch: (tt) => seen.push(tt) });
    FakeWs.all.length = 0;
    gw.start();
    const ws = FakeWs.all[0];
    ws.emit({ op: 10, d: { heartbeat_interval: 60_000 } });
    expect(ws.sent[0]).toMatchObject({ op: 2, d: { token: 'tok', intents: expect.any(Number) } });
    expect(ws.sent[0].d.intents & (1 << 15)).toBeTruthy();
    ws.emit({ op: 0, t: 'READY', s: 1, d: { session_id: 'sess1', resume_gateway_url: 'wss://resume.discord.gg' } });
    expect(gw.status).toBe('ready');
    ws.emit({ op: 1 });
    expect(ws.sent.at(-1)).toEqual({ op: 1, d: 1 });
    ws.drop(1006);
    expect(gw.status).toBe('connecting');
    await wait(1100);
    const ws2 = FakeWs.all[1];
    expect(ws2.url).toContain('resume.discord.gg');
    ws2.emit({ op: 10, d: { heartbeat_interval: 60_000 } });
    expect(ws2.sent[0]).toMatchObject({ op: 6, d: { session_id: 'sess1', seq: 1 } });
    ws2.drop(4014);
    expect(gw.status).toBe('error');
    expect(gw.error).toContain('Message Content');
    gw.stop();
    expect(seen).toContain('READY');
  });
});

describe('Discord: settings, gateway messages, replies, /support', () => {
  it('connects with the bot token and reads application id and public key', async () => {
    let r = await t.api.put('/api/settings/channels/discord', { bot_token: 'x' });
    expect(r.status).toBe(400);
    r = await t.api.put('/api/settings/channels/discord', { bot_token: DISCORD_TOKEN, channel_ids: '120000000000000009, 120000000000000008' });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ configured: true, bot: { name: 'gohigh-bot', app_id: '900000000000000002' }, public_key_set: true, channel_ids: ['120000000000000009', '120000000000000008'] });
    expect(r.data.invite_url).toContain('client_id=900000000000000002');
    expect(JSON.stringify(r.data)).not.toContain(DISCORD_TOKEN);
    expect((await t.api.put('/api/settings/channels/discord', { channel_ids: 'abc' })).status).toBe(400);
    const cmd = await t.api.post('/api/settings/channels/discord/commands');
    expect(cmd.data.commands).toEqual(['support']);
  });

  it('DMs and watched channels become conversations; others are ignored', async () => {
    const gw = t.app.services.discordGateways.get(loc);
    expect(gw).toBeTruthy();
    const ws = FakeWs.all.at(-1)!;
    ws.emit({ op: 10, d: { heartbeat_interval: 60_000 } });
    ws.emit({ op: 0, t: 'READY', s: 1, d: { session_id: 's', resume_gateway_url: 'wss://r.discord.gg' } });
    const author = { id: '130000000000000005', username: 'paula_dc', global_name: 'Paula' };
    ws.emit({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: { id: '110000000000000010', channel_id: '700000000000000001', author, content: 'Hallo per DM', type: 0 } });
    ws.emit({ op: 0, t: 'MESSAGE_CREATE', s: 3, d: { id: '110000000000000011', channel_id: '120000000000000009', guild_id: '1', author, content: 'Frage im Kanal', type: 0 } });
    ws.emit({ op: 0, t: 'MESSAGE_CREATE', s: 4, d: { id: '110000000000000012', channel_id: '120000000000000555', guild_id: '1', author, content: 'anderer Kanal', type: 0 } });
    ws.emit({ op: 0, t: 'MESSAGE_CREATE', s: 5, d: { id: '110000000000000013', channel_id: '700000000000000001', author: { ...author, bot: true }, content: 'bot', type: 0 } });
    await t.app.events.flush();
    const c = t.app.db.get(`SELECT * FROM contacts WHERE location_id = ? AND first_name = 'Paula'`, loc);
    expect(c.source).toBe('Discord');
    const bodies = t.app.db.all(`SELECT body FROM messages WHERE contact_id = ? ORDER BY created_at`, c.id).map((m) => m.body);
    expect(bodies).toEqual(['Hallo per DM', 'Frage im Kanal']);
  });

  it('replies as DM by default, in the channel when switched on', async () => {
    const c = t.app.db.get(`SELECT * FROM contacts WHERE location_id = ? AND first_name = 'Paula'`, loc);
    let r = await t.api.post('/api/messages', { contact_id: c.id, channel: 'discord', body: 'Gern geholfen!' });
    expect(r.data.status).toBe('sent');
    expect(calls.at(-1)).toMatchObject({ url: 'https://discord.com/api/v10/channels/700000000000000001/messages', body: { content: 'Gern geholfen!', allowed_mentions: { parse: [] } } });
    await t.api.put('/api/settings/channels/discord', { reply_in_channel: true });
    r = await t.api.post('/api/messages', { contact_id: c.id, channel: 'discord', body: 'Antwort im Kanal' });
    expect(calls.at(-1)).toMatchObject({ url: 'https://discord.com/api/v10/channels/120000000000000009/messages', body: { message_reference: { message_id: '110000000000000011' } } });
    r = await t.api.post('/api/messages', { contact_id: c.id, channel: 'discord', body: 'x'.repeat(2001) });
    expect(r.status).toBe(400);
    await t.api.put('/api/settings/channels/discord', { reply_in_channel: false });
    r = await t.api.post('/api/messages', { contact_id: c.id, channel: 'discord', body: 'dm-blocked' });
    expect(r.data).toMatchObject({ status: 'failed', error: expect.stringContaining('Direktnachrichten') });
  });

  it('/support slash command: signed interactions only', async () => {
    const send = (payload: any, opts: { bad?: boolean } = {}) => {
      const raw = JSON.stringify(payload);
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = sign(null, Buffer.from(ts + raw + (opts.bad ? 'x' : '')), privateKey).toString('hex');
      return t.api.raw(`/hooks/discord/${loc}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature-ed25519': sig, 'x-signature-timestamp': ts }, body: raw });
    };
    expect((await send({ type: 1 }, { bad: true })).status).toBe(401);
    expect(await (await send({ type: 1 })).json()).toEqual({ type: 1 });
    const r = await send({ id: '140000000000000001', type: 2, guild_id: '1', channel_id: '120000000000000009', member: { user: { id: '130000000000000077', username: 'otto' } }, data: { name: 'support', options: [{ name: 'nachricht', value: 'Mein Login geht nicht' }] } });
    expect(await r.json()).toMatchObject({ type: 4, data: { flags: 64 } });
    const m = t.app.db.get(`SELECT * FROM messages WHERE body = 'Mein Login geht nicht'`);
    expect(m).toMatchObject({ channel: 'discord', direction: 'in' });
  });
});

describe('Slack: team notifications and replies from threads', () => {
  it('pure: signature, quoting, Slack → plain text', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const raw = '{"type":"event_callback"}';
    const sig = signSlack(raw, ts, SLACK_SECRET);
    expect(verifySlack(raw, ts, sig, SLACK_SECRET)).toBe(true);
    expect(verifySlack(raw, String(Number(ts) - 600), signSlack(raw, String(Number(ts) - 600), SLACK_SECRET), SLACK_SECRET)).toBe(false);
    expect(verifySlack(raw + ' ', ts, sig, SLACK_SECRET)).toBe(false);
    expect(slackQuote('a <b>\nc')).toBe('> a &lt;b&gt;\n> c');
    expect(fromSlack('Hi <@U123> siehe <https://x.de|hier> &amp; <mailto:a@b.de|a@b.de> 5 &lt; 6')).toBe('Hi  siehe hier (https://x.de) & a@b.de 5 < 6');
  });

  it('validates and stores the settings without returning secrets', async () => {
    expect((await t.api.put('/api/settings/channels/slack', { bot_token: 'xoxp-nope' })).status).toBe(400);
    expect((await t.api.put('/api/settings/channels/slack', { channel: 'general' })).status).toBe(400);
    expect((await t.api.put('/api/settings/channels/slack', { webhook_url: 'https://evil.example/services/x' })).status).toBe(400);
    const r = await t.api.put('/api/settings/channels/slack', { mode: 'bot', bot_token: SLACK_TOKEN, signing_secret: SLACK_SECRET, channel: 'C0123ABCD' });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ configured: true, replies: true, team: 'Malerei Team', bot_token_set: true, signing_secret_set: true });
    expect(JSON.stringify(r.data)).not.toContain(SLACK_TOKEN);
    const test = await t.api.post('/api/settings/channels/slack/test');
    expect(test.data.info).toContain('C0123ABCD');
  });

  it('posts new customer messages as one thread per conversation', async () => {
    const n = calls.length;
    const sms = await t.api.raw(`/hooks/${loc}/sms?key=${(await t.api.get('/api/settings/inbound')).data.sms.split('key=')[1]}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: '+491701112233', body: 'Haben Sie morgen Zeit?' }) });
    expect(sms.status).toBe(200);
    await t.app.events.flush();
    await t.api.raw(`/hooks/${loc}/sms?key=${(await t.api.get('/api/settings/inbound')).data.sms.split('key=')[1]}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: '+491701112233', body: 'Gern vormittags.' }) });
    await t.app.events.flush();
    const posts = calls.slice(n).filter((c) => c.url.endsWith('chat.postMessage'));
    expect(posts).toHaveLength(2);
    expect(posts[0].body).toMatchObject({ channel: 'C0123ABCD' });
    expect(posts[0].body.text).toContain('über *SMS*');
    expect(posts[0].body.text).toContain('> Haben Sie morgen Zeit?');
    expect(posts[0].body.thread_ts).toBeUndefined();
    expect(posts[1].body.thread_ts).toBe(`${slackTs - 1}.000100`);
  });

  it('a thread reply goes to the customer on their channel; // stays internal; bad signatures are refused', async () => {
    const thread = t.app.db.get('SELECT * FROM slack_threads WHERE location_id = ?', loc);
    const event = (text: string, ts: string, extra: Record<string, unknown> = {}) => ({ type: 'event_callback', event_id: `Ev${ts}`, event: { type: 'message', channel: 'C0123ABCD', user: 'U777', text, ts, thread_ts: thread.thread_ts, ...extra } });
    const post = (payload: unknown, secret = SLACK_SECRET) => {
      const raw = JSON.stringify(payload);
      const ts = String(Math.floor(Date.now() / 1000));
      return t.api.raw(`/hooks/slack/${loc}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': signSlack(raw, ts, secret) }, body: raw });
    };
    expect(await (await post({ type: 'url_verification', challenge: 'abc123' })).json()).toEqual({ challenge: 'abc123' });
    expect((await post(event('Hi', '1.1'), 'f'.repeat(32))).status).toBe(401);
    let r = await post(event('Morgen um 10 Uhr passt &amp; ich bringe <https://x.de/farben|Farbmuster> mit', '2000.0001'));
    expect(r.status).toBe(200);
    const sent = t.app.db.get(`SELECT * FROM messages WHERE conversation_id = ? AND direction = 'out' ORDER BY created_at DESC LIMIT 1`, thread.conversation_id);
    expect(sent).toMatchObject({ channel: 'sms', source: 'Slack', body: 'Morgen um 10 Uhr passt & ich bringe Farbmuster (https://x.de/farben) mit' });
    expect(calls.at(-1)).toMatchObject({ url: 'https://slack.com/api/reactions.add', body: { timestamp: '2000.0001', name: 'white_check_mark' } });
    // the same event again (Slack retry) → nothing new
    const count = () => t.app.db.get(`SELECT COUNT(*) n FROM messages WHERE conversation_id = ? AND direction = 'out'`, thread.conversation_id).n;
    const before = count();
    await post(event('Morgen um 10 Uhr passt', '2000.0001'));
    await post(event('// intern: Preis noch klären', '2000.0002'));
    await post(event('vom Bot', '2000.0003', { bot_id: 'B1' }));
    expect(count()).toBe(before);
    // DND: the reply fails and Slack gets a warning in the thread
    t.app.db.run('UPDATE contacts SET dnd = 1 WHERE id = (SELECT contact_id FROM conversations WHERE id = ?)', thread.conversation_id);
    r = await post(event('Noch eine Frage?', '2000.0004'));
    expect(calls.at(-1)).toMatchObject({ url: 'https://slack.com/api/chat.postMessage', body: { thread_ts: thread.thread_ts, text: expect.stringContaining('Nicht gesendet') } });
  });

  it('webhook mode only notifies', async () => {
    const r = await t.api.put('/api/settings/channels/slack', { mode: 'webhook', webhook_url: 'https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXX' });
    expect(r.data).toMatchObject({ configured: true, mode: 'webhook', replies: false });
    const n = calls.length;
    await t.api.raw(`/hooks/${loc}/email?key=${(await t.api.get('/api/settings/inbound')).data.email.split('key=')[1]}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: 'Kim <kim@example.com>', subject: 'Angebot', text: 'Bitte Angebot schicken' }) });
    await t.app.events.flush();
    const hookCall = calls.slice(n).find((c) => c.url.startsWith('https://hooks.slack.com/'));
    expect(hookCall?.body.text).toContain('über *E-Mail*');
    const cat = await t.api.get('/api/integrations/catalog');
    expect(cat.data.items.find((x: any) => x.key === 'slack')).toMatchObject({ status: 'ok' });
    expect(cat.data.items.find((x: any) => x.key === 'discord')).toBeTruthy();
  });
});
