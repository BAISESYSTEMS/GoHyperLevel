import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startTestApp } from './helpers.js';
import { client, type Call } from './security-fixtures.js';
import { requiredPermission } from '../server/core/permissions.js';
import { parseTaskArgs } from '../server/modules/teamchat-commands.js';
import { BYE, expireSession, loginAgain, openSse } from './sse-fixtures.js';

const REAL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let other = '';
let admin: Call;
let adminOther: Call;
let maria: Call;
let vera: Call;
let nina: Call; // no chat right
let otto: Call; // other sub-account
let kai: Call;
const ids: Record<string, string> = {};
let key = '';
const realFetch = globalThis.fetch;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const channels = async (c: Call) => (await c('GET', '/api/team-chat/channels')).data.channels as any[];
const mkChannel = async (c: Call, name: string, kind = 'public', extra: Record<string, unknown> = {}) => {
  const r = await c('POST', '/api/team-chat/channels', { name, kind, ...extra });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
};
const say = async (c: Call, channel: string, body: string, extra: Record<string, unknown> = {}) => {
  const r = await c('POST', `/api/team-chat/channels/${channel}/messages`, { body, ...extra });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
};

/** An open SSE stream with a tiny reader. */
async function openStream(c: Call, clientId: string, location = loc) {
  const ctrl = new AbortController();
  const res = await realFetch(`${t.base}/api/team-chat/stream?clientId=${clientId}&locationId=${location}`, { headers: { cookie: c.cookie() }, signal: ctrl.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let pending: Promise<void> | undefined;
  const pump = () => {
    pending ??= reader.read().then(({ value, done }) => {
      pending = undefined;
      if (!done) buf += dec.decode(value);
    });
    return pending;
  };
  return {
    text: () => buf,
    async until(re: RegExp, ms = 3000) {
      const end = Date.now() + ms;
      while (!re.test(buf) && Date.now() < end) await Promise.race([pump(), sleep(100)]);
      return re.test(buf);
    },
    async quiet(re: RegExp, ms = 400) {
      const end = Date.now() + ms;
      while (Date.now() < end) await Promise.race([pump(), sleep(50)]);
      return !re.test(buf);
    },
    clear: () => (buf = ''),
    close: async () => {
      ctrl.abort();
      await reader.cancel().catch(() => {});
    },
  };
}

beforeAll(async () => {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error(`offline in tests: ${url}`);
    return realFetch(input, init);
  }) as typeof fetch;
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  other = (await t.api.post('/api/locations', { name: 'Andere Firma' })).data.id;
  admin = client(t.base, { cookie: t.api.cookie, 'x-pghl': '1', 'x-location-id': loc });
  adminOther = client(t.base, { cookie: t.api.cookie, 'x-pghl': '1', 'x-location-id': other });
  const mkUser = async (email: string, name: string, permissions: string[] | null, locations = [loc]) => {
    const u = await t.api.post('/api/users', { email, name, password: 'geheim-12345', role: 'member', locations, permissions });
    expect(u.status).toBe(200);
    const c = client(t.base, { 'x-pghl': '1', 'x-location-id': locations[0] });
    expect((await c('POST', '/api/auth/login', { email, password: 'geheim-12345' })).status).toBe(200);
    ids[name] = u.data.id;
    return c;
  };
  maria = await mkUser('maria@example.com', 'Maria Muster', ['teamchat', 'contacts', 'wiki']);
  vera = await mkUser('vera@example.com', 'Vera Vogel', ['teamchat']);
  nina = await mkUser('nina@example.com', 'Nina Nein', ['contacts']);
  otto = await mkUser('otto@example.com', 'Otto Anders', ['teamchat'], [other]);
  kai = await mkUser('kai@example.com', 'Kai Klein', ['teamchat']);
  ids.Chef = (await t.api.get('/api/me')).data.user.id;
  // the tests send far more than a person would: the limit is tested on its own
  t.app.services.chatRate = { max: 100_000 };
  key = (await t.api.post('/api/api-keys', { name: 'Claude' })).data.key;
}, 60_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  await t?.close();
});

describe('team chat: channels and access', () => {
  it('maps its routes to the teamchat area and creates #allgemein on first use', async () => {
    expect(requiredPermission('GET', '/api/team-chat/channels')).toBe('teamchat');
    expect((await nina('GET', '/api/team-chat/channels')).status).toBe(403);
    const list = await channels(admin);
    expect(list.map((c) => c.name)).toEqual(['allgemein']);
    expect(list[0]).toMatchObject({ kind: 'public', label: '#allgemein', joined: true, role: 'member' });
    ids.allgemein = list[0].id;
    // another sub-account gets its own
    const otherList = await channels(adminOther);
    expect(otherList.map((c) => c.name)).toEqual(['allgemein']);
    expect(otherList[0].id).not.toBe(ids.allgemein);
  });

  it('public channels are open to the sub-account, private ones to their members only – agency admins included', async () => {
    const pub = await mkChannel(maria, 'Marketing');
    expect(pub).toMatchObject({ name: 'marketing', role: 'owner' });
    ids.pub = pub.id;
    // anyone with the chat can read it and joins by writing
    expect((await vera('GET', `/api/team-chat/channels/${pub.id}/messages`)).status).toBe(200);
    expect((await channels(vera)).find((c) => c.id === pub.id)).toMatchObject({ joined: false, role: 'reader' });
    await say(vera, pub.id, 'Hallo zusammen');
    expect((await channels(vera)).find((c) => c.id === pub.id)).toMatchObject({ joined: true, role: 'member' });
    const priv = await mkChannel(maria, 'Gehaltsrunde', 'private');
    ids.priv = priv.id;
    for (const c of [vera, admin, kai]) {
      expect((await c('GET', `/api/team-chat/channels/${priv.id}`)).status).toBe(404);
      expect((await c('GET', `/api/team-chat/channels/${priv.id}/messages`)).status).toBe(404);
      expect((await c('POST', `/api/team-chat/channels/${priv.id}/messages`, { body: 'x' })).status).toBe(404);
      expect((await c('POST', `/api/team-chat/channels/${priv.id}/join`)).status).toBe(404);
      expect((await channels(c)).map((x) => x.id)).not.toContain(priv.id);
    }
    await say(maria, priv.id, 'Streng geheim: Bonus');
    // invited people can read from then on
    expect((await maria('POST', `/api/team-chat/channels/${priv.id}/members`, { user_ids: [ids['Vera Vogel'], ids['Otto Anders'], ids['Nina Nein']] })).data.added).toEqual([ids['Vera Vogel']]); // Otto: other sub-account, Nina: no chat right
    expect((await vera('GET', `/api/team-chat/channels/${priv.id}/messages`)).data.messages[0].text).toContain('Bonus');
    expect((await admin('GET', `/api/team-chat/channels/${priv.id}/messages`)).status).toBe(404);
    // people who are not in it cannot add themselves or others
    expect((await kai('POST', `/api/team-chat/channels/${priv.id}/members`, { user_ids: [ids['Kai Klein']] })).status).toBe(404);
    expect((await vera('POST', `/api/team-chat/channels/${pub.id}/join`)).status).toBe(200);
    expect((await vera('POST', `/api/team-chat/channels/${priv.id}/join`)).status).toBe(403); // member, but "join" is for public ones
  });

  it('names are unique and clean; only the owner (or the agency in public channels) manages a channel', async () => {
    expect((await maria('POST', '/api/team-chat/channels', { name: 'MARKETING' })).status).toBe(400);
    expect((await maria('POST', '/api/team-chat/channels', { name: '#' })).status).toBe(400);
    const c = await mkChannel(maria, '  Team Süd & Ost! ');
    expect(c.name).toBe('team-süd-ost');
    expect((await vera('PATCH', `/api/team-chat/channels/${c.id}`, { name: 'x1' })).status).toBe(403);
    expect((await vera('DELETE', `/api/team-chat/channels/${c.id}`)).status).toBe(403);
    // the agency may manage public channels, never private ones (it cannot even see them)
    expect((await admin('PATCH', `/api/team-chat/channels/${c.id}`, { topic: 'Von der Agentur' })).data.topic).toBe('Von der Agentur');
    expect((await admin('PATCH', `/api/team-chat/channels/${ids.priv}`, { topic: 'x' })).status).toBe(404);
    // everybody sets their own notification level (once they are in)
    expect((await vera('PATCH', `/api/team-chat/channels/${c.id}`, { notify: 'none' })).status).toBe(400);
    await vera('POST', `/api/team-chat/channels/${c.id}/join`);
    expect((await vera('PATCH', `/api/team-chat/channels/${c.id}`, { notify: 'none' })).data).toMatchObject({ notify: 'none', muted: true });
    expect((await vera('PATCH', `/api/team-chat/channels/${c.id}`, { notify: 'laut' })).status).toBe(400);
    // archive, then it is read-only
    await maria('PATCH', `/api/team-chat/channels/${c.id}`, { archived: true });
    expect((await channels(maria)).map((x) => x.id)).not.toContain(c.id);
    expect((await maria('GET', '/api/team-chat/channels?archived=1')).data.channels.map((x: any) => x.id)).toContain(c.id);
    expect((await maria('POST', `/api/team-chat/channels/${c.id}/messages`, { body: 'x' })).status).toBe(409);
    await maria('PATCH', `/api/team-chat/channels/${c.id}`, { archived: false });
    expect((await maria('DELETE', `/api/team-chat/channels/${c.id}`)).data.ok).toBe(true);
    expect((await maria('GET', `/api/team-chat/channels/${c.id}`)).status).toBe(404);
    // agency-wide channels: only the agency creates them; clients see them only when added
    expect((await maria('POST', '/api/team-chat/channels', { name: 'agentur', scope: 'agency' })).status).toBe(403);
    const ag = await mkChannel(admin, 'agentur-intern', 'public', { scope: 'agency' });
    expect(ag.scope).toBe('agency');
    expect((await channels(maria)).map((x) => x.id)).not.toContain(ag.id);
    expect((await maria('GET', `/api/team-chat/channels/${ag.id}/messages`)).status).toBe(404);
    expect((await channels(adminOther)).map((x) => x.id)).toContain(ag.id); // the agency sees it from every sub-account
  });
});

describe('team chat: direct and group messages', () => {
  it('direct messages are for their two people only, found again, never for outsiders', async () => {
    const dm = await admin('POST', '/api/team-chat/dms', { user_ids: [ids['Maria Muster']] });
    expect(dm.status).toBe(200);
    expect(dm.data).toMatchObject({ kind: 'dm', label: 'Maria Muster', member_count: 2 });
    ids.dm = dm.data.id;
    // the same two people get the same conversation, whoever starts it
    expect((await maria('POST', '/api/team-chat/dms', { user_ids: [ids.Chef] })).data.id).toBe(dm.data.id);
    expect((await channels(maria)).find((c) => c.id === dm.data.id)).toMatchObject({ label: 'Chef' });
    await say(admin, dm.data.id, 'Kurze Frage unter uns');
    for (const c of [vera, kai]) {
      expect((await c('GET', `/api/team-chat/channels/${dm.data.id}/messages`)).status).toBe(404);
      expect((await c('POST', `/api/team-chat/channels/${dm.data.id}/messages`, { body: 'mitlesen' })).status).toBe(404);
      expect((await c('GET', '/api/team-chat/search?q=Frage')).data).toEqual([]);
    }
    expect((await maria('GET', `/api/team-chat/channels/${dm.data.id}/messages`)).data.messages[0].text).toBe('Kurze Frage unter uns');
    // not even through the other sub-account's door
    expect((await adminOther('GET', `/api/team-chat/channels/${dm.data.id}/messages`)).status).toBe(200); // Chef is a participant, so he reads it from anywhere
    expect((await otto('GET', `/api/team-chat/channels/${dm.data.id}/messages`)).status).toBe(404);
    // nobody can be added to a DM, a person cannot be chatted with across sub-accounts
    expect((await maria('POST', `/api/team-chat/channels/${dm.data.id}/members`, { user_ids: [ids['Vera Vogel']] })).status).toBe(400);
    expect((await maria('POST', '/api/team-chat/dms', { user_ids: [ids['Otto Anders']] })).status).toBe(400);
    expect((await maria('POST', '/api/team-chat/dms', { user_ids: [ids['Nina Nein']] })).status).toBe(400);
    expect((await maria('POST', '/api/team-chat/dms', { user_ids: [] })).status).toBe(400);
    expect((await maria('POST', '/api/team-chat/dms', { user_ids: ['gibtsnicht'] })).status).toBe(400);
  });

  it('group messages for three to eight people', async () => {
    const g = await maria('POST', '/api/team-chat/dms', { user_ids: [ids['Vera Vogel'], ids['Kai Klein']] });
    expect(g.data).toMatchObject({ kind: 'group', member_count: 3 });
    expect(g.data.label).toBe('Kai Klein, Vera Vogel');
    expect((await vera('POST', '/api/team-chat/dms', { user_ids: [ids['Maria Muster'], ids['Kai Klein']] })).data.id).toBe(g.data.id);
    await say(kai, g.data.id, 'Hallo Gruppe');
    expect((await admin('GET', `/api/team-chat/channels/${g.data.id}/messages`)).status).toBe(404);
    // leaving: gone from the list; the last one out removes the conversation
    await kai('POST', `/api/team-chat/channels/${g.data.id}/leave`);
    expect((await channels(kai)).map((c) => c.id)).not.toContain(g.data.id);
    expect((await kai('GET', `/api/team-chat/channels/${g.data.id}/messages`)).status).toBe(404);
  });
});

describe('team chat: messages', () => {
  it('pages through the history, edits and deletes with the right permissions', async () => {
    const ch = await mkChannel(maria, 'verlauf');
    for (let i = 1; i <= 7; i++) await say(maria, ch.id, `Nachricht ${i}`);
    let r = (await maria('GET', `/api/team-chat/channels/${ch.id}/messages?limit=3`)).data;
    expect(r.messages.map((m: any) => m.text)).toEqual(['Nachricht 5', 'Nachricht 6', 'Nachricht 7']);
    expect(r.has_more).toBe(true);
    r = (await maria('GET', `/api/team-chat/channels/${ch.id}/messages?limit=3&before=${r.messages[0].id}`)).data;
    expect(r.messages.map((m: any) => m.text)).toEqual(['Nachricht 2', 'Nachricht 3', 'Nachricht 4']);
    r = (await maria('GET', `/api/team-chat/channels/${ch.id}/messages?limit=3&before=${r.messages[0].id}`)).data;
    expect(r.messages.map((m: any) => m.text)).toEqual(['Nachricht 1']);
    expect(r.has_more).toBe(false);
    // edit: own messages only
    const m = await say(maria, ch.id, 'Tippfehler');
    const edited = await maria('PATCH', `/api/team-chat/messages/${m.id}`, { body: 'Korrigiert **fett**' });
    expect(edited.data).toMatchObject({ text: 'Korrigiert fett', html: expect.stringContaining('<strong>fett</strong>') });
    expect(edited.data.edited_at).toBeTruthy();
    expect((await vera('PATCH', `/api/team-chat/messages/${m.id}`, { body: 'geklaut' })).status).toBe(403);
    expect((await admin('PATCH', `/api/team-chat/messages/${m.id}`, { body: 'Agentur' })).status).toBe(403);
    expect((await maria('PATCH', `/api/team-chat/messages/${m.id}`, { body: '   ' })).status).toBe(400);
    // delete: author, channel owner, agency in public channels
    const v = await say(vera, ch.id, 'Von Vera');
    expect((await kai('DELETE', `/api/team-chat/messages/${v.id}`)).status).toBe(403);
    expect((await maria('DELETE', `/api/team-chat/messages/${v.id}`)).status).toBe(200); // Maria owns the channel
    const gone = (await maria('GET', `/api/team-chat/channels/${ch.id}/messages?limit=50`)).data.messages.find((x: any) => x.id === v.id);
    expect(gone).toMatchObject({ deleted: true, body: '', html: '', text: '' }); // a tombstone, the text is gone
    expect(t.app.db.get('SELECT body FROM teamchat_messages WHERE id = ?', v.id)!.body).toBe('');
    const w = await say(vera, ch.id, 'Noch eine');
    expect((await admin('DELETE', `/api/team-chat/messages/${w.id}`)).status).toBe(200);
    // not through the wrong channel
    expect((await vera('PATCH', `/api/team-chat/messages/${m.id}`, { body: 'x' })).status).toBe(403);
    // limits
    expect((await maria('POST', `/api/team-chat/channels/${ch.id}/messages`, { body: 'x'.repeat(8001) })).status).toBe(400);
    expect((await maria('POST', `/api/team-chat/channels/${ch.id}/messages`, { body: '  ' })).status).toBe(400);
  });

  it('threads, reactions and pins', async () => {
    const ch = await mkChannel(maria, 'diskussion');
    const root = await say(maria, ch.id, 'Wer macht den Entwurf?');
    const r1 = await say(vera, ch.id, 'Ich!', { thread_id: root.id });
    // a reply to a reply goes into the same thread
    const r2 = await say(maria, ch.id, 'Danke', { thread_id: r1.id });
    expect(r2.thread_id).toBe(root.id);
    const list = (await maria('GET', `/api/team-chat/channels/${ch.id}/messages`)).data.messages;
    expect(list.map((x: any) => x.id)).toEqual([root.id]); // replies are not in the channel flow
    expect(list[0]).toMatchObject({ reply_count: 2 });
    const th = (await vera('GET', `/api/team-chat/messages/${r2.id}/thread`)).data;
    expect(th.parent.id).toBe(root.id);
    expect(th.replies.map((x: any) => x.text)).toEqual(['Ich!', 'Danke']);
    // deleting a reply updates the count
    await vera('DELETE', `/api/team-chat/messages/${r1.id}`);
    expect((await maria('GET', `/api/team-chat/channels/${ch.id}/messages`)).data.messages[0].reply_count).toBe(1);
    expect((await maria('POST', `/api/team-chat/channels/${ch.id}/messages`, { body: 'x', thread_id: 'gibtsnicht' })).status).toBe(404);
    // reactions toggle per person
    let rx = await vera('POST', `/api/team-chat/messages/${root.id}/reactions`, { emoji: '👍' });
    expect(rx.data).toMatchObject({ active: true, reactions: [{ emoji: '👍', count: 1, users: [ids['Vera Vogel']] }] });
    rx = await maria('POST', `/api/team-chat/messages/${root.id}/reactions`, { emoji: '👍' });
    expect(rx.data.reactions[0].count).toBe(2);
    rx = await vera('POST', `/api/team-chat/messages/${root.id}/reactions`, { emoji: '👍' });
    expect(rx.data).toMatchObject({ active: false, reactions: [{ emoji: '👍', count: 1 }] });
    for (const bad of ['', 'abc', '<img>', '👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍']) expect((await vera('POST', `/api/team-chat/messages/${root.id}/reactions`, { emoji: bad })).status, bad).toBe(400);
    expect((await vera('POST', `/api/team-chat/messages/${root.id}/reactions`, { emoji: '❤️' })).status).toBe(200);
    // pins
    expect((await maria('POST', `/api/team-chat/messages/${root.id}/pin`)).data).toMatchObject({ pinned: true });
    expect((await vera('GET', `/api/team-chat/channels/${ch.id}/pins`)).data.map((x: any) => x.id)).toEqual([root.id]);
    await maria('DELETE', `/api/team-chat/messages/${root.id}/pin`);
    expect((await vera('GET', `/api/team-chat/channels/${ch.id}/pins`)).data).toEqual([]);
    // people outside the channel can neither react nor pin in a private one
    const priv = await mkChannel(maria, 'privat-reaktion', 'private');
    const pm = await say(maria, priv.id, 'intern');
    expect((await vera('POST', `/api/team-chat/messages/${pm.id}/reactions`, { emoji: '👍' })).status).toBe(404);
    expect((await vera('POST', `/api/team-chat/messages/${pm.id}/pin`)).status).toBe(404);
  });

  it('renders messages safely and links records as previews', async () => {
    const ch = await mkChannel(maria, 'sicherheit');
    const c = (await admin('POST', '/api/contacts', { first_name: 'Paula', last_name: 'Preview', email: 'paula@example.com' })).data;
    const m = await say(maria, ch.id, `<script>alert(1)</script> [x](javascript:alert(1)) ![i](https://x.test/a.png) **ok** http://localhost/app/contacts/${c.id} und [Karte](card:contact:${c.id})\n# keine Überschrift`);
    expect(m.html).not.toMatch(/<script|javascript:|onerror/i);
    expect(m.html).toContain('<strong>ok</strong>');
    expect(m.html).not.toContain('<h1');
    expect(m.cards).toEqual([{ kind: 'contact', id: c.id, label: 'Karte' }]);
    // a link to a record page of this app is a preview too; somebody else's site that has such a path is just a link
    const m2 = await say(maria, ch.id, 'Siehe http://localhost/app/tickets/abc123 und https://evil.example/app/contacts/zzz999');
    expect(m2.cards).toEqual([{ kind: 'ticket', id: 'abc123', label: '' }]);
    const m3 = await say(maria, ch.id, `Siehe /app/contacts/${c.id}`);
    expect(m3.cards).toEqual([{ kind: 'contact', id: c.id, label: '' }]);
    // previews show live data with the viewer's own rights
    const cards = (await maria('POST', '/api/team-chat/cards', { refs: [{ kind: 'contact', id: c.id }] })).data.cards;
    expect(cards[`contact:${c.id}`]).toMatchObject({ ok: true, title: 'Paula Preview' });
    const noRight = (await vera('POST', '/api/team-chat/cards', { refs: [{ kind: 'contact', id: c.id }] })).data.cards;
    expect(noRight[`contact:${c.id}`]).toMatchObject({ ok: false });
    expect(JSON.stringify(noRight)).not.toContain('Paula');
    const foreign = (await adminOther('POST', '/api/team-chat/cards', { refs: [{ kind: 'contact', id: c.id }] })).data.cards;
    expect(foreign[`contact:${c.id}`].ok).toBe(false);
  });

  it('limits the sending rate per person', async () => {
    const ch = await mkChannel(kai, 'tempo');
    // the real limit is 20 per ten seconds; a short window keeps the test quick
    t.app.services.chatRate = { max: 20, windowMs: 4000 };
    try {
      let blocked = 0;
      for (let i = 0; i < 26; i++) if ((await kai('POST', `/api/team-chat/channels/${ch.id}/messages`, { body: `schnell ${i}` })).status === 429) blocked++;
      // 20 are let through in total (Kai wrote one more message a moment ago, in another channel)
      expect(blocked).toBeGreaterThanOrEqual(6);
      expect(blocked).toBeLessThanOrEqual(7);
      // another person is not held back by Kai's burst
      expect((await maria('POST', `/api/team-chat/channels/${ch.id}/messages`, { body: 'ich schon' })).status).toBe(200);
      await sleep(4100);
      expect((await kai('POST', `/api/team-chat/channels/${ch.id}/messages`, { body: 'wieder' })).status).toBe(200);
    } finally {
      t.app.services.chatRate = { max: 100_000 };
    }
  });
});

describe('team chat: files', () => {
  it('checks uploads, serves them to the channel only, and removes them with the message', async () => {
    const pub = await mkChannel(maria, 'dateien');
    const priv = await mkChannel(maria, 'dateien-privat', 'private');
    const up = await maria('POST', `/api/team-chat/channels/${priv.id}/files`, { name: 'foto.png', data: REAL_PNG });
    expect(up.status, JSON.stringify(up.data)).toBe(200);
    expect(up.data).toMatchObject({ name: 'foto.png', mime: 'image/png', image: true });
    // checks like the media library: real content, no SVG/HTML, size
    const html = `data:image/png;base64,${Buffer.from('<html><script>alert(1)</script>').toString('base64')}`;
    expect((await maria('POST', `/api/team-chat/channels/${priv.id}/files`, { name: 'x.png', data: html })).data.error).toContain('passt nicht');
    expect((await maria('POST', `/api/team-chat/channels/${priv.id}/files`, { name: 'x.svg', data: `data:image/svg+xml;base64,${Buffer.from('<svg onload="alert(1)"/>').toString('base64')}` })).status).toBe(400);
    expect((await maria('POST', `/api/team-chat/channels/${priv.id}/files`, { name: 'x.exe', data: `data:application/octet-stream;base64,${Buffer.from('MZ').toString('base64')}` })).status).toBe(400);
    expect((await maria('POST', `/api/team-chat/channels/${priv.id}/files`, { name: 'x.png', data: 'data:image/png;base64,' })).status).toBe(400);
    expect((await vera('POST', `/api/team-chat/channels/${priv.id}/files`, { name: 'foto.png', data: REAL_PNG })).status).toBe(404);
    const pdf = await maria('POST', `/api/team-chat/channels/${priv.id}/files`, { name: '../../Angebot Q4.pdf', data: `data:application/pdf;base64,${Buffer.from('%PDF-1.4\n%x').toString('base64')}` });
    expect(pdf.data.name).toBe('.._.._Angebot Q4.pdf'); // path separators never survive
    expect(pdf.data.name).not.toContain('/');
    // an unsent upload is only for the person who made it
    expect((await maria('GET', up.data.url)).status).toBe(200);
    // attach and send
    const msg = await say(maria, priv.id, 'Hier das Foto', { files: [up.data.id, pdf.data.id] });
    expect(msg.files.map((f: any) => f.name)).toEqual(['foto.png', pdf.data.name]);
    // a file can only be sent once, in its own channel
    expect((await maria('POST', `/api/team-chat/channels/${priv.id}/messages`, { body: 'nochmal', files: [up.data.id] })).status).toBe(400);
    const other1 = await maria('POST', `/api/team-chat/channels/${pub.id}/files`, { name: 'a.png', data: REAL_PNG });
    expect((await maria('POST', `/api/team-chat/channels/${priv.id}/messages`, { body: 'falscher Kanal', files: [other1.data.id] })).status).toBe(400);
    // served inline (image) or as a download (document), never sniffed, to members only
    const img = await realFetch(`${t.base}${up.data.url}`, { headers: { cookie: maria.cookie(), 'x-location-id': loc } });
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(img.headers.get('content-disposition')).toMatch(/^inline/);
    expect(img.headers.get('x-content-type-options')).toBe('nosniff');
    const doc = await realFetch(`${t.base}${pdf.data.url}`, { headers: { cookie: maria.cookie(), 'x-location-id': loc } });
    expect(doc.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(doc.headers.get('content-security-policy')).toContain('sandbox');
    for (const c of [vera, admin, otto, adminOther]) expect((await c('GET', up.data.url)).status).toBe(404);
    expect((await t.api.raw(up.data.url)).status).toBe(401);
    // deleting the message removes the files from disk and from the list
    const dir = join(t.app.config.dataDir, 'teamchat-files');
    const before = readdirSync(dir).length;
    await maria('DELETE', `/api/team-chat/messages/${msg.id}`);
    expect(readdirSync(dir).length).toBe(before - 2);
    expect((await maria('GET', up.data.url)).status).toBe(404);
    // unsent uploads older than a day are cleaned up
    t.app.db.run('UPDATE teamchat_files SET created_at = ? WHERE id = ?', new Date(Date.now() - 2 * 864e5).toISOString(), other1.data.id);
    await t.app.tick();
    expect(t.app.db.get('SELECT COUNT(*) n FROM teamchat_files WHERE id = ?', other1.data.id)!.n).toBe(0);
    expect(existsSync(join(dir, `${other1.data.id}.png`))).toBe(false);
  });
});

describe('team chat: mentions, unread counters and notifications', () => {
  let ch = '';
  beforeAll(async () => {
    ch = (await mkChannel(admin, 'projekt-x')).id;
    for (const c of [maria, vera, kai]) await c('POST', `/api/team-chat/channels/${ch}/join`);
    await sleep(15);
  });

  it('turns @names into mentions and tells only the people involved', async () => {
    t.app.db.run('DELETE FROM push_log');
    t.app.db.run('DELETE FROM mobile_feed');
    // an Android device exists, so the feed is filled
    await t.api.post('/api/mobile/pair', { device_name: 'Test' });
    const m = await say(admin, ch, 'Bitte prüfen @Maria Muster und @vera – danke');
    expect(m.mentions.sort()).toEqual([ids['Maria Muster'], ids['Vera Vogel']].sort());
    expect(m.body).toContain(`[@Maria Muster](user:${ids['Maria Muster']})`);
    expect(m.body).toContain(`[@Vera Vogel](user:${ids['Vera Vogel']})`); // a unique first name works too
    expect(m.html).toContain('wk-mention');
    await t.app.services.collabIdle();
    const pushed = t.app.db.all(`SELECT user_id, title, url FROM push_log WHERE kind = 'chat' ORDER BY user_id`);
    expect(pushed.map((p: any) => p.user_id).sort()).toEqual([ids['Maria Muster'], ids['Vera Vogel']].sort());
    expect(pushed[0].title).toBe('Chef hat dich in #projekt-x erwähnt');
    expect(pushed[0].url).toBe(`/app/team-chat/${ch}`);
    // Kai was not mentioned: no push for an ordinary channel message
    expect(pushed.some((p: any) => p.user_id === ids['Kai Klein'])).toBe(false);
    // …and the Android feed got "chat" events for exactly those two
    const feed = t.app.db.all(`SELECT type, user_id, title, deep_link FROM mobile_feed WHERE type = 'chat'`);
    expect(feed.map((f: any) => f.user_id).sort()).toEqual([ids['Maria Muster'], ids['Vera Vogel']].sort());
    expect(feed[0].deep_link).toContain(`/app/team-chat/${ch}`);
    // the author is never notified of their own message
    expect(pushed.some((p: any) => p.user_id === ids.Chef)).toBe(false);
  });

  it('@alle reaches everybody in the channel; code and strangers do not count', async () => {
    t.app.db.run('DELETE FROM push_log');
    const m = await say(admin, ch, '@alle Meeting um 10');
    expect(m.mentions.sort()).toEqual([ids['Kai Klein'], ids['Maria Muster'], ids['Vera Vogel']].sort());
    await t.app.services.collabIdle();
    expect(t.app.db.get(`SELECT COUNT(*) n FROM push_log WHERE kind = 'chat'`)!.n).toBe(3);
    t.app.db.run('DELETE FROM push_log');
    const code = await say(admin, ch, 'Ein `@Maria Muster` im Code und ```\n@Vera\n``` auch');
    expect(code.mentions).toEqual([]);
    // a private channel never reveals who is outside: mentions of non-members are plain text
    const priv = await mkChannel(admin, 'nur-chef-und-maria', 'private', { members: [ids['Maria Muster']] });
    const m2 = await say(admin, priv.id, 'Hallo @Kai Klein und @Maria');
    expect(m2.mentions).toEqual([ids['Maria Muster']]);
    expect(m2.body).toContain('@Kai Klein');
    expect(m2.body).not.toContain(`user:${ids['Kai Klein']}`);
    // forged links to outsiders are cleaned
    const forged = await say(admin, priv.id, `Hi [@Kai](user:${ids['Kai Klein']})`);
    expect(forged.mentions).toEqual([]);
    expect(forged.body).toBe('Hi @Kai');
  });

  it('counts unread messages and mentions per person and clears them when read', async () => {
    await maria('POST', `/api/team-chat/channels/${ch}/read`);
    await vera('POST', `/api/team-chat/channels/${ch}/read`);
    await sleep(15);
    // (writing marks everything before it as read, like in any chat: Vera writes first)
    await say(vera, ch, 'Drei von Vera');
    await sleep(15);
    await say(admin, ch, 'Eins');
    await say(admin, ch, 'Zwei für @Maria Muster');
    await sleep(5);
    let s = (await maria('GET', '/api/team-chat/summary')).data;
    expect(s.channels[ch]).toEqual({ unread: 3, mentions: 1 });
    // her own messages never count; Vera sees two
    s = (await vera('GET', '/api/team-chat/summary')).data;
    expect(s.channels[ch].unread).toBe(2);
    expect((await maria('GET', '/api/team-chat/channels')).data.channels.find((c: any) => c.id === ch)).toMatchObject({ unread: 3, mentions: 1 });
    // thread replies do not count as unread (only mentions in them would)
    const root = (await maria('GET', `/api/team-chat/channels/${ch}/messages`)).data.messages[0];
    await say(admin, ch, 'Antwort im Thread', { thread_id: root.id });
    expect((await maria('GET', '/api/team-chat/summary')).data.channels[ch].unread).toBe(3);
    await maria('POST', `/api/team-chat/channels/${ch}/read`);
    expect((await maria('GET', '/api/team-chat/summary')).data.channels[ch]).toBeUndefined();
    // muted channels keep their counter but stay out of the total
    await vera('PATCH', `/api/team-chat/channels/${ch}`, { notify: 'none' });
    s = (await vera('GET', '/api/team-chat/summary')).data;
    expect(s.channels[ch].unread).toBe(2);
    expect(s.unread).toBe(Object.entries(s.channels).filter(([cid]) => cid !== ch).reduce((n, [, c]: any) => n + c.unread, 0));
  });

  it('direct messages notify for every message; muted ones and people who are looking do not', async () => {
    const dm = (await admin('POST', '/api/team-chat/dms', { user_ids: [ids['Kai Klein']] })).data.id;
    t.app.db.run('DELETE FROM push_log');
    await say(admin, dm, 'Hast du kurz Zeit?');
    await t.app.services.collabIdle();
    expect(t.app.db.get(`SELECT title FROM push_log WHERE kind = 'chat' AND user_id = ?`, ids['Kai Klein'])).toMatchObject({ title: 'Chef' });
    // someone with a tab in the foreground reads it there – no push
    t.app.db.run('DELETE FROM push_log');
    const s = await openStream(kai, 'kai-tab-1');
    expect(await s.until(/event: hello/)).toBe(true);
    await kai('POST', '/api/team-chat/presence', { client_id: 'kai-tab-1', active: true });
    await say(admin, dm, 'Zweite Nachricht');
    await t.app.services.collabIdle();
    expect(t.app.db.get(`SELECT COUNT(*) n FROM push_log WHERE kind = 'chat'`)!.n).toBe(0);
    // tab in the background: push again
    await kai('POST', '/api/team-chat/presence', { client_id: 'kai-tab-1', active: false });
    await say(admin, dm, 'Dritte Nachricht');
    await t.app.services.collabIdle();
    expect(t.app.db.get(`SELECT COUNT(*) n FROM push_log WHERE kind = 'chat'`)!.n).toBe(1);
    // muted: nothing, not even a mention
    await kai('PATCH', `/api/team-chat/channels/${dm}`, { notify: 'none' });
    t.app.db.run('DELETE FROM push_log');
    await say(admin, dm, 'Vierte Nachricht');
    await t.app.services.collabIdle();
    expect(t.app.db.get(`SELECT COUNT(*) n FROM push_log WHERE kind = 'chat'`)!.n).toBe(0);
    await s.close();
  });

  it('people who left the sub-account get no notifications', async () => {
    const solo = await mkChannel(admin, 'ehemalige');
    await vera('POST', `/api/team-chat/channels/${solo.id}/join`);
    await vera('PATCH', `/api/team-chat/channels/${solo.id}`, { notify: 'all' });
    t.app.db.run('DELETE FROM push_log');
    t.app.db.run(`UPDATE users SET permissions = '["contacts"]' WHERE id = ?`, ids['Vera Vogel']);
    await say(admin, solo.id, 'Neuigkeiten');
    await t.app.services.collabIdle();
    expect(t.app.db.get(`SELECT COUNT(*) n FROM push_log WHERE user_id = ?`, ids['Vera Vogel'])!.n).toBe(0);
    t.app.db.run(`UPDATE users SET permissions = '["teamchat"]' WHERE id = ?`, ids['Vera Vogel']);
  });
});

describe('team chat: realtime (SSE + POST)', () => {
  it('delivers messages, edits, reactions, typing and presence to the right people only', async () => {
    const pub = await mkChannel(admin, 'live');
    const priv = await mkChannel(admin, 'live-privat', 'private', { members: [ids['Maria Muster']] });
    const sm = await openStream(maria, 'maria-1');
    const sv = await openStream(vera, 'vera-1');
    expect(await sm.until(/event: hello/)).toBe(true);
    expect(await sv.until(/event: hello/)).toBe(true);
    expect(sm.text()).toContain('"online"');
    // presence: Maria hears that Vera came online (and the other way round is in Vera's hello)
    expect(await sm.until(new RegExp(`event: presence\\ndata: .*${ids['Vera Vogel']}.*"online":true`))).toBe(true);
    expect(sv.text()).toContain(ids['Maria Muster']);
    sm.clear();
    sv.clear();
    // a public message reaches both
    const m = await say(admin, pub.id, 'Hallo live');
    expect(await sm.until(/event: message\ndata: .*"Hallo live"/)).toBe(true);
    expect(await sv.until(/event: message\ndata: .*"Hallo live"/)).toBe(true);
    expect(sm.text()).toMatch(/"channel_id":"/);
    // a private message reaches its members only
    sm.clear();
    sv.clear();
    await say(admin, priv.id, 'Nur für Maria');
    expect(await sm.until(/"Nur für Maria"/)).toBe(true);
    expect(await sv.quiet(/Nur für Maria|live-privat/)).toBe(true);
    // edit, reaction, delete
    await admin('PATCH', `/api/team-chat/messages/${m.id}`, { body: 'Hallo live (korrigiert)' });
    expect(await sv.until(/event: message-edit\ndata: .*korrigiert/)).toBe(true);
    await maria('POST', `/api/team-chat/messages/${m.id}/reactions`, { emoji: '🎉' });
    expect(await sv.until(/event: reaction\ndata: .*🎉/)).toBe(true);
    await admin('DELETE', `/api/team-chat/messages/${m.id}`);
    expect(await sv.until(/event: message-delete/)).toBe(true);
    // typing is announced, throttled, and only to the channel's audience
    sm.clear();
    sv.clear();
    await vera('POST', `/api/team-chat/channels/${pub.id}/typing`);
    expect(await sm.until(new RegExp(`event: typing\\ndata: .*"name":"Vera Vogel"`))).toBe(true);
    const typingCount = () => (sm.text().match(/event: typing/g) ?? []).length;
    await vera('POST', `/api/team-chat/channels/${pub.id}/typing`);
    await sleep(150);
    expect(typingCount()).toBe(1); // within two seconds: one signal
    expect((await vera('POST', `/api/team-chat/channels/${priv.id}/typing`)).status).toBe(404);
    // a person without access to the sub-account chat cannot open a stream; a key neither
    expect((await nina('GET', '/api/team-chat/stream?clientId=nina-tab-1')).status).toBe(403);
    expect((await realFetch(`${t.base}/api/team-chat/stream?clientId=key-tab-1`, { headers: { authorization: `Bearer ${key}` } })).status).toBe(403);
    // presence ends with the last stream
    sm.clear();
    await sv.close();
    expect(await sm.until(new RegExp(`event: presence\\ndata: .*${ids['Vera Vogel']}.*"online":false`), 4000)).toBe(true);
    expect((await maria('GET', '/api/team-chat/presence')).data.online).not.toContain(ids['Vera Vogel']);
    expect((await maria('GET', '/api/team-chat/presence')).data.online).toContain(ids['Maria Muster']);
    await sm.close();
  });

  it('shows presence only for people of the same sub-account and drops streams of people who lost access', async () => {
    const so = await openStream(otto, 'otto-1', other);
    const sm = await openStream(maria, 'maria-2');
    expect(await sm.until(/event: hello/)).toBe(true);
    expect(sm.text()).not.toContain(ids['Otto Anders']);
    expect((await maria('GET', '/api/team-chat/presence')).data.online).not.toContain(ids['Otto Anders']);
    expect((await maria('GET', '/api/team-chat/people')).data.map((p: any) => p.name)).not.toContain('Otto Anders');
    expect((await maria('GET', '/api/team-chat/people')).data.find((p: any) => p.name === 'Maria Muster')).toMatchObject({ online: true, me: true });
    // events of A never reach a stream of B
    await say(admin, ids.allgemein, 'Nur in Firma A');
    expect(await so.quiet(/Nur in Firma A/, 600)).toBe(true);
    const hub = t.app.services.chatHub;
    expect(hub.online(ids['Maria Muster'])).toBe(true);
    // somebody loses the right: the next check closes the stream – for good (`bye`: the browser does not reconnect)
    t.app.db.run(`UPDATE users SET permissions = '["contacts"]' WHERE id = ?`, ids['Maria Muster']);
    hub.sweep();
    expect(hub.online(ids['Maria Muster'])).toBe(false);
    expect(await sm.until(BYE)).toBe(true);
    t.app.db.run(`UPDATE users SET permissions = '["teamchat","contacts","wiki"]' WHERE id = ?`, ids['Maria Muster']);
    await so.close();
    await sm.close();
  });

  it('ends a stream with the login it was opened with: signed out, revoked, a new password, run out (no messages after the session)', async () => {
    const hub = t.app.services.chatHub;
    const again = () => loginAgain(t.base, loc, 'kai@example.com', 'geheim-12345');
    const open = async (c: { cookie: () => string }, clientId: string) => {
      const s = await openSse(`${t.base}/api/team-chat/stream?clientId=${clientId}&locationId=${loc}`, { cookie: c.cookie() });
      expect(await s.until(/event: hello/)).toBe(true);
      return s;
    };
    const own = await open(kai, 'kai-own-1');
    // signed out in another tab of the same browser: the stream ends at once, with `bye`
    const second = await again();
    const s1 = await open(second, 'kai-login-1');
    expect((await second('POST', '/api/auth/logout')).status).toBe(200);
    expect(await s1.until(BYE)).toBe(true);
    expect(await s1.ends()).toBe(true);
    // "sign out the other devices" (a lost laptop): its stream ends, the own one stays
    const third = await again();
    const s2 = await open(third, 'kai-login-2');
    expect((await kai('POST', '/api/me/sessions/revoke-others')).status).toBe(200);
    expect(await s2.until(BYE)).toBe(true);
    expect(await s2.ends()).toBe(true);
    // a new password signs the other devices out – and ends their streams
    const fourth = await again();
    const s3 = await open(fourth, 'kai-login-3');
    expect((await kai('POST', '/api/me/password', { current: 'geheim-12345', next: 'geheim-12345' })).status).toBe(200);
    expect(await s3.until(BYE)).toBe(true);
    // a session that ran out: the next check (every 20 s) ends its stream
    const fifth = await again();
    const s4 = await open(fifth, 'kai-login-4');
    expireSession(t.app.db, fifth.cookie());
    hub.sweep();
    expect(await s4.until(BYE)).toBe(true);
    // the own login was never touched: it stays and still gets the messages – the ended ones get nothing more
    expect(await own.quiet(/event: bye/)).toBe(true);
    await say(admin, ids.allgemein, 'Nach dem Abmelden');
    expect(await own.until(/Nach dem Abmelden/)).toBe(true);
    for (const s of [s1, s2, s3, s4]) expect(s.text()).not.toContain('Nach dem Abmelden');
    expect(hub.online(ids['Kai Klein'])).toBe(true);
    for (const s of [own, s1, s2, s3, s4]) await s.close();
  });

  it("a person's 9th tab makes the oldest one wait with `bye` instead of a reconnect ping-pong", async () => {
    const tabs = [];
    for (let i = 0; i < 9; i++) {
      const s = await openSse(`${t.base}/api/team-chat/stream?clientId=kai-tab-${i}&locationId=${loc}`, { cookie: kai.cookie() });
      expect(await s.until(/event: hello/)).toBe(true);
      tabs.push(s);
    }
    expect(await tabs[0].until(/event: bye\ndata: \{"reason":"tabs"\}/)).toBe(true);
    expect(await tabs[0].ends()).toBe(true);
    for (const s of tabs.slice(1)) expect(s.text()).not.toContain('event: bye');
    for (const s of tabs) await s.close();
  });
});

describe('team chat: sub-account isolation', () => {
  it('keeps channels, messages, files and search of one sub-account away from the other', async () => {
    const pub = await mkChannel(maria, 'nur-firma-a');
    const m = await say(maria, pub.id, 'Geheimnis-A Rhabarber');
    const up = await maria('POST', `/api/team-chat/channels/${pub.id}/files`, { name: 'a.png', data: REAL_PNG });
    await say(maria, pub.id, 'mit Datei', { files: [up.data.id] });
    for (const c of [otto, adminOther]) {
      expect((await channels(c)).map((x) => x.id)).not.toContain(pub.id);
      for (const [method, path, body] of [
        ['GET', `/api/team-chat/channels/${pub.id}`],
        ['GET', `/api/team-chat/channels/${pub.id}/messages`],
        ['POST', `/api/team-chat/channels/${pub.id}/messages`, { body: 'eingeschleust' }],
        ['POST', `/api/team-chat/channels/${pub.id}/join`],
        ['POST', `/api/team-chat/channels/${pub.id}/read`],
        ['POST', `/api/team-chat/channels/${pub.id}/files`, { name: 'x.png', data: REAL_PNG }],
        ['PATCH', `/api/team-chat/channels/${pub.id}`, { name: 'gekapert' }],
        ['DELETE', `/api/team-chat/channels/${pub.id}`],
        ['GET', `/api/team-chat/messages/${m.id}/thread`],
        ['PATCH', `/api/team-chat/messages/${m.id}`, { body: 'x' }],
        ['DELETE', `/api/team-chat/messages/${m.id}`],
        ['POST', `/api/team-chat/messages/${m.id}/reactions`, { emoji: '👍' }],
        ['POST', `/api/team-chat/messages/${m.id}/pin`],
        ['GET', up.data.url],
      ] as [string, string, unknown?][]) {
        const r = await c(method, path, body);
        expect(r.status, `${method} ${path}`).toBe(404);
        expect(r.text).not.toContain('Rhabarber');
      }
      expect((await c('GET', '/api/team-chat/search?q=rhabarber')).data).toEqual([]);
      expect(JSON.stringify((await c('GET', '/api/team-chat/summary')).data)).not.toContain(pub.id);
    }
    expect((await otto('GET', '/api/team-chat/channels', undefined, { 'x-location-id': loc })).status).toBe(403);
    // the other side has its own #allgemein with its own messages
    const ownOther = (await channels(otto)).find((c) => c.name === 'allgemein')!;
    await say(otto, ownOther.id, 'Hallo Firma B');
    expect((await maria('GET', `/api/team-chat/channels/${ownOther.id}/messages`)).status).toBe(404);
    expect((await maria('GET', '/api/team-chat/search?q=firma+b')).data).toEqual([]);
  });
});

describe('team chat: search', () => {
  it('finds messages in channels the caller may read, never in private or direct ones', async () => {
    const pub = await mkChannel(maria, 'suche');
    const priv = await mkChannel(maria, 'suche-privat', 'private');
    await say(maria, pub.id, 'Das Büro für Qualität ist umgezogen');
    await say(maria, priv.id, 'Büro-Geheimnis Zitronenbaum');
    const hits = async (c: Call, q: string) => (await c('GET', `/api/team-chat/search?q=${encodeURIComponent(q)}`)).data as any[];
    expect((await hits(vera, 'buro qualitat')).map((h) => h.channel)).toEqual(['#suche']);
    expect((await hits(vera, 'zitronenbaum'))).toEqual([]);
    const own = await hits(maria, 'zitronenbaum');
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ channel: '#suche-privat', author: 'Maria Muster' });
    expect(own[0].snippet).toContain('\u0001');
    expect((await hits(admin, 'zitronenbaum'))).toEqual([]);
    expect(await hits(vera, '')).toEqual([]);
    // deleted messages vanish from the index
    const m = await say(maria, pub.id, 'Flüchtiges Wort Quarkspeise');
    expect(await hits(vera, 'quarkspeise')).toHaveLength(1);
    await maria('DELETE', `/api/team-chat/messages/${m.id}`);
    expect(await hits(vera, 'quarkspeise')).toEqual([]);
    // LIKE fallback without FTS5
    const f = t.app.services.chatFts;
    f.ok = false;
    try {
      expect((await hits(vera, 'qualit büro')).map((h) => h.channel)).toEqual(['#suche']);
      expect(await hits(vera, 'zitronenbaum')).toEqual([]);
    } finally {
      f.ok = true;
    }
  });
});

describe('team chat: retention, settings and Slack', () => {
  it('deletes what is older than the sub-account setting – pinned messages and other sub-accounts stay', async () => {
    const ch = await mkChannel(admin, 'aufbewahrung');
    const och = (await channels(otto)).find((c) => c.name === 'allgemein')!;
    const old = await say(admin, ch.id, 'Alt');
    const pinned = await say(admin, ch.id, 'Alt und angepinnt');
    const fresh = await say(admin, ch.id, 'Neu');
    const thread = await say(admin, ch.id, 'Antwort im alten Thread', { thread_id: old.id });
    const up = await admin('POST', `/api/team-chat/channels/${ch.id}/files`, { name: 'alt.png', data: REAL_PNG });
    const withFile = await say(admin, ch.id, 'Alt mit Datei', { files: [up.data.id] });
    const otherOld = await say(otto, och.id, 'Alt aber andere Firma');
    await admin('POST', `/api/team-chat/messages/${pinned.id}/pin`);
    const ago = new Date(Date.now() - 100 * 864e5).toISOString();
    for (const m of [old, pinned, withFile, otherOld]) t.app.db.run('UPDATE teamchat_messages SET created_at = ? WHERE id = ?', ago, m.id);
    // not set: nothing happens
    expect(t.app.services.teamchatRetention()).toBe(0);
    // settings: members without the settings right cannot change it
    expect((await vera('PUT', '/api/team-chat/settings', { retention_days: 90 })).status).toBe(403);
    expect((await admin('PUT', '/api/team-chat/settings', { retention_days: 3 })).status).toBe(400);
    expect((await admin('PUT', '/api/team-chat/settings', { retention_days: 'viel' })).status).toBe(400);
    expect((await admin('PUT', '/api/team-chat/settings', { retention_days: 90 })).data).toMatchObject({ retention_days: 90, scope: 'location' });
    expect((await vera('GET', '/api/team-chat/settings')).data).toMatchObject({ retention_days: 90, can_edit: false });
    expect(t.app.services.teamchatRetention()).toBe(3); // old, its thread reply, and the one with the file
    const left = (await admin('GET', `/api/team-chat/channels/${ch.id}/messages`)).data.messages.map((m: any) => m.text);
    expect(left).toEqual(['Alt und angepinnt', 'Neu']);
    expect(t.app.db.get('SELECT COUNT(*) n FROM teamchat_messages WHERE id = ?', thread.id)!.n).toBe(0);
    expect(existsSync(join(t.app.config.dataDir, 'teamchat-files', `${up.data.id}.png`))).toBe(false);
    expect((await channels(otto)).find((c) => c.id === och.id)).toBeTruthy();
    expect(t.app.db.get('SELECT COUNT(*) n FROM teamchat_messages WHERE id = ?', otherOld.id)!.n).toBe(1); // no setting there
    expect(t.app.db.get('SELECT COUNT(*) n FROM teamchat_messages WHERE id = ?', fresh.id)!.n).toBe(1);
    // the search index follows
    expect((await admin('GET', '/api/team-chat/search?q=alt+datei')).data).toEqual([]);
    // agency-wide settings: the agency only; they apply to agency channels and direct messages
    expect((await maria('GET', '/api/team-chat/settings?scope=agency')).status).toBe(403);
    expect((await admin('PUT', '/api/team-chat/settings?scope=agency', { retention_days: 30 })).data.scope).toBe('agency');
    const dm = (await admin('POST', '/api/team-chat/dms', { user_ids: [ids['Maria Muster']] })).data.id;
    const oldDm = await say(admin, dm, 'Alte Direktnachricht');
    t.app.db.run('UPDATE teamchat_messages SET created_at = ? WHERE id = ?', ago, oldDm.id);
    expect(t.app.services.teamchatRetention()).toBeGreaterThanOrEqual(1);
    expect(t.app.db.get('SELECT COUNT(*) n FROM teamchat_messages WHERE id = ?', oldDm.id)!.n).toBe(0);
    // the sub-account's channels are not touched by the agency setting
    expect(t.app.db.get('SELECT COUNT(*) n FROM teamchat_messages WHERE id = ?', pinned.id)!.n).toBe(1);
  });

  it('copies messages of switched-on channels to Slack, one way', async () => {
    const calls: { url: string; body: any }[] = [];
    t.app.services.channelFetch = async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response('ok', { status: 200 });
    };
    try {
      const ch = await mkChannel(admin, 'mit-slack');
      // not set up yet
      expect((await admin('PATCH', `/api/team-chat/channels/${ch.id}`, { slack_mirror: true })).status).toBe(400);
      expect((await admin('GET', '/api/team-chat/channels')).data.slack).toBe(false);
      await admin('PUT', '/api/settings/channels/slack', { mode: 'webhook', webhook_url: 'https://hooks.slack.com/services/T0000000/B0000000/abcdefghij1234567890' });
      expect((await admin('GET', '/api/team-chat/channels')).data.slack).toBe(true);
      expect((await admin('PATCH', `/api/team-chat/channels/${ch.id}`, { slack_mirror: true })).data.slack_mirror).toBe(true);
      expect((await vera('PATCH', `/api/team-chat/channels/${ch.id}`, { slack_mirror: false })).status).toBe(403);
      await say(admin, ch.id, 'Hallo <Slack> & Co');
      await t.app.services.collabIdle();
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('hooks.slack.com');
      expect(calls[0].body.text).toBe('*Chef* in #mit-slack: Hallo &lt;Slack&gt; &amp; Co');
      // other channels stay in the app; direct messages never go out
      const other1 = await mkChannel(admin, 'ohne-slack');
      await say(admin, other1.id, 'bleibt hier');
      const dm = (await admin('POST', '/api/team-chat/dms', { user_ids: [ids['Maria Muster']] })).data.id;
      expect((await admin('PATCH', `/api/team-chat/channels/${dm}`, { slack_mirror: true })).status).toBe(400);
      await say(admin, dm, 'privat');
      await t.app.services.collabIdle();
      expect(calls).toHaveLength(1);
      // a failing Slack never breaks the chat
      t.app.services.channelFetch = async () => new Response('nope', { status: 500 });
      await say(admin, ch.id, 'Slack ist kaputt');
      await t.app.services.collabIdle();
      expect((await admin('GET', `/api/team-chat/channels/${ch.id}/messages`)).data.messages.at(-1).text).toBe('Slack ist kaputt');
    } finally {
      delete t.app.services.channelFetch;
    }
  });
});

describe('team chat: slash commands /aufgabe and /kontakt', () => {
  it('reads dates, assignees and titles of /aufgabe', () => {
    const o = { today: '2026-10-07', mentions: ['u1'] }; // a Wednesday
    expect(parseTaskArgs('Angebot schicken morgen', o)).toEqual({ title: 'Angebot schicken', due: '2026-10-08', assignee: 'u1' });
    expect(parseTaskArgs('Rechnung prüfen bis übermorgen für [@Anna](user:u1)', o)).toMatchObject({ title: 'Rechnung prüfen', due: '2026-10-09' });
    expect(parseTaskArgs('Telefonat am Freitag', o).due).toBe('2026-10-09');
    expect(parseTaskArgs('Bericht am Mittwoch', o).due).toBe('2026-10-14'); // today is Wednesday: next week
    expect(parseTaskArgs('Steuer bis 15.11.', o).due).toBe('2026-11-15');
    expect(parseTaskArgs('Steuer bis 15.03.', o).due).toBe('2027-03-15'); // passed: next year
    expect(parseTaskArgs('Messe 05.12.2026 planen', o)).toMatchObject({ title: 'Messe planen', due: '2026-12-05' });
    expect(parseTaskArgs('Test 2026-12-24', o).due).toBe('2026-12-24');
    expect(parseTaskArgs('Kein Datum hier', o).due).toBeNull();
    expect(parseTaskArgs('Morgenroutine planen', o).due).toBeNull(); // "Morgen" inside a word is not a date
    expect(parseTaskArgs('  ', o).title).toBe('');
  });

  it('creates a task with assignee and due date, as the person who typed it', async () => {
    const ch = await mkChannel(admin, 'befehle');
    await maria('POST', `/api/team-chat/channels/${ch.id}/join`);
    t.app.db.run('DELETE FROM push_log');
    const r = await admin('POST', `/api/team-chat/channels/${ch.id}/messages`, { body: '/aufgabe Angebot schicken übermorgen @Maria' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.command).toBe('aufgabe');
    const task = t.app.db.get<any>('SELECT * FROM tasks WHERE id = ?', r.data.task.id)!;
    expect(task).toMatchObject({ title: 'Angebot schicken', location_id: loc, assigned_to: ids['Maria Muster'] });
    expect(task.due_at).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00.000Z$/);
    expect(task.description).toContain('#befehle');
    // the message links the task as a live card
    expect(r.data.message.body).toContain(`(card:task:${task.id})`);
    expect(r.data.message.cards).toEqual([{ kind: 'task', id: task.id, label: 'Angebot schicken' }]);
    expect(r.data.message.meta).toMatchObject({ command: 'aufgabe', task_id: task.id });
    // the CRM's own task notification went to Maria (assignment) – the chat adds none
    await t.app.services.collabIdle();
    expect(t.app.db.all(`SELECT kind FROM push_log WHERE user_id = ?`, ids['Maria Muster']).map((x: any) => x.kind)).toEqual(['tasks']);
    // the task shows in the CRM and in the audit log
    expect((await admin('GET', '/api/tasks')).data.some((x: any) => x.id === task.id)).toBe(true);
    expect(t.app.db.get(`SELECT via FROM audit_log WHERE route = 'POST /api/tasks' ORDER BY at DESC LIMIT 1`)).toBeTruthy();
    // no title → a helpful error and nothing posted
    const before = (await admin('GET', `/api/team-chat/channels/${ch.id}/messages`)).data.messages.length;
    const bad = await admin('POST', `/api/team-chat/channels/${ch.id}/messages`, { body: '/aufgabe morgen' });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toContain('Titel');
    expect((await admin('GET', `/api/team-chat/channels/${ch.id}/messages`)).data.messages.length).toBe(before);
    // people without the CRM's task right cannot create tasks from the chat (the regular guard applies)
    await vera('POST', `/api/team-chat/channels/${ch.id}/join`);
    const denied = await vera('POST', `/api/team-chat/channels/${ch.id}/messages`, { body: '/aufgabe Heimlich' });
    expect(denied.status).toBe(403);
    expect(t.app.db.get(`SELECT COUNT(*) n FROM tasks WHERE title = 'Heimlich'`)!.n).toBe(0);
    // commands work in threads, and a text that only looks like one is just text
    const th = await admin('POST', `/api/team-chat/channels/${ch.id}/messages`, { body: '/aufgabe Im Thread erledigen', thread_id: r.data.message.id });
    expect(th.data.message.thread_id).toBe(r.data.message.id);
    const path = await say(admin, ch.id, '/etc/hosts prüfen');
    expect(path.text).toBe('/etc/hosts prüfen');
    expect((await say(admin, ch.id, '//aufgabe als Text')).text).toBe('//aufgabe als Text');
  });

  it('shares a contact as a card; asks when several match', async () => {
    const ch = await mkChannel(admin, 'kontakte-teilen');
    const a = (await admin('POST', '/api/contacts', { first_name: 'Karla', last_name: 'Kontakt', email: 'karla@kontakt.example', company: 'Kontakt AG' })).data;
    await admin('POST', '/api/contacts', { first_name: 'Karl', last_name: 'Kontakt', email: 'karl@kontakt.example' });
    const one = await admin('POST', `/api/team-chat/channels/${ch.id}/messages`, { body: '/kontakt karla' });
    expect(one.data.message.body).toBe(`👤 Kontakt: [Karla Kontakt](card:contact:${a.id})`);
    expect(one.data.message.cards).toEqual([{ kind: 'contact', id: a.id, label: 'Karla Kontakt' }]);
    // several: nothing is posted, the choices come back; "id:" picks one
    const many = await admin('POST', `/api/team-chat/channels/${ch.id}/messages`, { body: '/kontakt Kontakt' });
    expect(many.data.choices.map((c: any) => c.label).sort()).toEqual(['Karl Kontakt', 'Karla Kontakt']);
    expect(many.data.message).toBeUndefined();
    expect((await admin('POST', `/api/team-chat/channels/${ch.id}/messages`, { body: `/kontakt id:${a.id}` })).data.message.meta.contact_id).toBe(a.id);
    expect((await admin('POST', `/api/team-chat/channels/${ch.id}/messages`, { body: '/kontakt gibtsnicht' })).status).toBe(404);
    expect((await admin('POST', `/api/team-chat/channels/${ch.id}/messages`, { body: '/kontakt' })).status).toBe(400);
    // needs the contacts area; only contacts of this sub-account
    await vera('POST', `/api/team-chat/channels/${ch.id}/join`);
    expect((await vera('POST', `/api/team-chat/channels/${ch.id}/messages`, { body: '/kontakt karla' })).status).toBe(403);
    const b = (await adminOther('POST', '/api/contacts', { first_name: 'Nur', last_name: 'DrübenB', email: 'b@example.com' })).data;
    expect((await admin('POST', `/api/team-chat/channels/${ch.id}/messages`, { body: '/kontakt DrübenB' })).status).toBe(404);
    expect((await admin('POST', `/api/team-chat/channels/${ch.id}/messages`, { body: `/kontakt id:${b.id}` })).status).toBe(404);
  });

  it('API keys post plain text – a slash is no command for them', async () => {
    const ch = await mkChannel(admin, 'schluessel');
    const r = await realFetch(`${t.base}/api/team-chat/channels/${ch.id}/messages`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'x-location-id': loc, 'content-type': 'application/json' }, body: JSON.stringify({ body: '/aufgabe sollte Text bleiben' }) });
    expect(r.status).toBe(200);
    const m = await r.json();
    expect(m).toMatchObject({ text: '/aufgabe sollte Text bleiben', kind: 'bot', author: { id: null, name: 'API: Claude' } });
    expect(t.app.db.get(`SELECT COUNT(*) n FROM tasks WHERE title LIKE 'sollte%'`)!.n).toBe(0);
  });
});

describe('team chat: notes, MCP tools and the mobile API', () => {
  it('keeps a chat message as an internal note on a contact', async () => {
    const ch = await mkChannel(admin, 'notizen');
    const c = (await admin('POST', '/api/contacts', { first_name: 'Nora', last_name: 'Notiz', email: 'nora@example.com' })).data;
    const m = await say(admin, ch.id, 'Nora möchte das Angebot erst im März');
    const r = await admin('POST', `/api/team-chat/messages/${m.id}/note`, { contact_id: c.id });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const notes = (await admin('GET', `/api/contacts/${c.id}`)).data.notes;
    expect(notes[0].body).toContain('Nora möchte das Angebot erst im März');
    expect(notes[0].body).toContain('#notizen');
    expect((await admin('POST', `/api/team-chat/messages/${m.id}/note`, { contact_id: 'gibtsnicht' })).status).toBe(404);
    // the CRM's own right is needed
    await vera('POST', `/api/team-chat/channels/${ch.id}/join`);
    expect((await vera('POST', `/api/team-chat/messages/${m.id}/note`, { contact_id: c.id })).status).toBe(403);
  });

  const rpc = async (name: string, args: Record<string, unknown>, bearer = key) => {
    const r = await realFetch(`${t.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { location_id: loc, ...args } } }) });
    return (await r.json()).result;
  };

  it('MCP: posts into public channels and reads history – never private or direct ones', async () => {
    const list = await realFetch(`${t.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const tools = (await list.json()).result.tools;
    expect(tools.map((x: any) => x.name)).toEqual(expect.arrayContaining(['ghl_chat_post', 'ghl_chat_history']));
    expect(tools.find((x: any) => x.name === 'ghl_chat_post').annotations.readOnlyHint).toBe(false);
    const ch = await mkChannel(admin, 'agenten');
    const posted = await rpc('ghl_chat_post', { channel: '#agenten', text: 'Bericht fertig – cc @Maria Muster' });
    expect(posted.isError, posted.content[0].text).toBe(false);
    expect(posted.structuredContent).toMatchObject({ channel: '#agenten', mentions: [ids['Maria Muster']], link: `/app/team-chat/${ch.id}` });
    const hist = await rpc('ghl_chat_history', { channel: ch.id, limit: 5 });
    expect(hist.structuredContent.messages.at(-1)).toMatchObject({ author: 'API: Claude', kind: 'bot', text: 'Bericht fertig – cc @Maria Muster' });
    const thread = await rpc('ghl_chat_post', { channel: 'agenten', text: 'Details im Thread', thread_id: posted.structuredContent.message_id });
    expect((await rpc('ghl_chat_history', { channel: 'agenten', thread_id: posted.structuredContent.message_id })).structuredContent.messages.map((m: any) => m.text)).toEqual(['Bericht fertig – cc @Maria Muster', 'Details im Thread']);
    void thread;
    expect((await rpc('ghl_chat_history', {})).structuredContent.channels.map((c: any) => c.name)).toEqual(expect.arrayContaining(['allgemein', 'agenten']));
    // private channels and DMs are not reachable for a key
    const priv = await mkChannel(admin, 'agenten-privat', 'private');
    const denied = await rpc('ghl_chat_post', { channel: priv.id, text: 'hallo' });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain('nicht gefunden');
    expect((await rpc('ghl_chat_history', { channel: 'agenten-privat' })).isError).toBe(true);
    // keys cannot create channels or use other sub-accounts
    const r = await realFetch(`${t.base}/api/team-chat/channels`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'x-location-id': loc, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'bot-kanal' }) });
    expect(r.status).toBe(403);
    const foreign = await realFetch(`${t.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ghl_chat_history', arguments: { location_id: other, channel: 'allgemein' } } }) });
    expect((await foreign.json()).result.isError).toBe(true);
    // the audit log names the key
    expect(t.app.db.get(`SELECT via FROM audit_log WHERE via = 'mcp' AND route LIKE '%team-chat%' LIMIT 1`)).toBeTruthy();
    // mentions from a key notify too
    await t.app.services.collabIdle();
    expect(t.app.db.get(`SELECT title FROM push_log WHERE kind = 'chat' AND user_id = ? ORDER BY created_at DESC LIMIT 1`, ids['Maria Muster'])).toMatchObject({ title: 'API: Claude hat dich in #agenten erwähnt' });
  });

  it('mobile API: channels with unread counters, messages, posting, reading – and the wiki pages', async () => {
    const pair = async (c: Call) => (await c('POST', '/api/mobile/pair', { device_name: 'Pixel' })).data.token as string;
    const dev = (token: string) => client(t.base, { authorization: `Bearer ${token}` });
    const phoneMaria = dev(await pair(maria));
    const phoneOtto = dev(await pair(otto));
    const phoneNina = dev(await pair(nina));
    const ch = await mkChannel(admin, 'unterwegs');
    await maria('POST', `/api/team-chat/channels/${ch.id}/join`);
    await sleep(15);
    await say(admin, ch.id, 'Neu für @Maria Muster');
    const list = (await phoneMaria('GET', '/api/mobile/chat/channels')).data as any[];
    const mine = list.find((c) => c.id === ch.id);
    expect(mine).toMatchObject({ label: '#unterwegs', unread: 1, mentions: 1, location_id: loc, joined: true });
    expect(list.find((c) => c.kind === 'dm')).toMatchObject({ label: 'Chef' }); // direct messages come along once
    // read history, post, mark read
    const msgs = (await phoneMaria('GET', `/api/mobile/chat/channels/${ch.id}/messages`)).data;
    expect(msgs.messages.at(-1)).toMatchObject({ text: 'Neu für @Maria Muster', author: { name: 'Chef' } });
    const sent = await phoneMaria('POST', `/api/mobile/chat/channels/${ch.id}/messages`, { body: 'Mache ich, **sofort**' });
    expect(sent.status).toBe(200);
    expect(sent.data.html).toContain('<strong>sofort</strong>');
    expect((await admin('GET', `/api/team-chat/channels/${ch.id}/messages`)).data.messages.at(-1)).toMatchObject({ text: 'Mache ich, sofort', author: { name: 'Maria Muster' } });
    // a slash is plain text here (no commands on the phone)
    expect((await phoneMaria('POST', `/api/mobile/chat/channels/${ch.id}/messages`, { body: '/aufgabe x' })).data.text).toBe('/aufgabe x');
    await phoneMaria('POST', `/api/mobile/chat/channels/${ch.id}/read`);
    expect((await phoneMaria('GET', '/api/mobile/chat/channels')).data.find((c: any) => c.id === ch.id).unread).toBe(0);
    // chat events are on the notification feed
    const feed = (await phoneMaria('GET', '/api/mobile/feed?since=0')).data;
    expect(feed.events.some((e: any) => e.type === 'chat' && e.deep_link.includes('/app/team-chat/'))).toBe(true);
    // isolation: another sub-account's phone, and a person without the area
    expect((await phoneOtto('GET', `/api/mobile/chat/channels/${ch.id}/messages`)).status).toBe(404);
    expect((await phoneOtto('POST', `/api/mobile/chat/channels/${ch.id}/messages`, { body: 'x' })).status).toBe(404);
    expect((await phoneOtto('GET', '/api/mobile/chat/channels')).data.map((c: any) => c.id)).not.toContain(ch.id);
    expect((await phoneNina('GET', '/api/mobile/chat/channels?location=' + loc)).status).toBe(403);
    expect((await phoneNina('GET', '/api/mobile/chat/channels')).data).toEqual([]);
    // wiki: search and read
    const sp = (await admin('POST', '/api/wiki/spaces', { name: 'Mobil' })).data.id;
    const page = (await admin('POST', '/api/wiki/pages', { space_id: sp, title: 'Mobile Seite', body: '## Hallo\n\nText mit **Gewicht** [@x](user:abc)' })).data;
    const found = (await phoneMaria('GET', '/api/mobile/wiki/pages?q=mobile')).data;
    expect(found[0]).toMatchObject({ id: page.id, title: 'Mobile Seite', location_id: loc, space_name: 'Mobil' });
    const read = (await phoneMaria('GET', `/api/mobile/wiki/pages/${page.id}`)).data;
    expect(read).toMatchObject({ title: 'Mobile Seite', markdown: expect.stringContaining('**Gewicht**'), path: ['Mobile Seite'], version: 1 });
    expect(read.html).toContain('<strong>Gewicht</strong>');
    expect(read.html).not.toContain('data-user'); // no live data in the app's HTML
    expect(read.web_url).toContain(`/app/wiki/${page.id}?loc=${loc}`);
    expect((await phoneOtto('GET', `/api/mobile/wiki/pages/${page.id}`)).status).toBe(404);
    expect((await phoneNina('GET', `/api/mobile/wiki/pages/${page.id}`)).status).toBe(404);
    expect((await phoneOtto('GET', '/api/mobile/wiki/pages?q=mobile')).data).toEqual([]);
    expect((await phoneMaria('GET', `/api/mobile/wiki/pages/gibtsnicht`)).status).toBe(404);
  });
});
