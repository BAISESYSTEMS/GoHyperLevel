import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';

// GET /api/events?since=<cursor>: one feed for agents instead of polling inbox, tasks and team chat.
describe('agent event feed', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  let grokId = '';
  let grokKey = '';
  let fullKey = '';
  const as = (key: string) => ({ authorization: `Bearer ${key}` });

  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
    const u = await t.api.post('/api/users', { email: 'grok@agents.test', password: 'agent12345', name: 'GrokBot', locations: [t.api.location], permissions: ['contacts', 'teamchat'] });
    grokId = u.data.id;
    grokKey = (await t.api.post('/api/api-keys', { name: 'GrokBot', user_id: grokId })).data.key;
    fullKey = (await t.api.post('/api/api-keys', { name: 'Claude' })).data.key;
  });
  afterAll(() => t.close());

  it('starts at "latest" and then only returns what is new, with a moving cursor', async () => {
    const start = await t.api.get('/api/events?since=latest', as(fullKey));
    expect(start.status).toBe(200);
    expect(start.data.events).toEqual([]);
    const c = (await t.api.post('/api/contacts', { first_name: 'Anna', last_name: 'Kunde', email: 'anna@kunde.test' })).data;
    t.app.events.emit(t.api.location, 'message.inbound', { contactId: c.id, contact: c, message: { id: 'm1', conversation_id: 'cv1', channel: 'email', subject: 'Frage', body: 'Hallo, wann kommt mein Buch?' } });
    await t.app.events.flush();
    const r = await t.api.get(`/api/events?since=${start.data.cursor}`, as(fullKey));
    expect(r.data.events).toHaveLength(1);
    expect(r.data.events[0]).toMatchObject({ type: 'message.inbound', contact_name: 'Anna Kunde', channel: 'email', subject: 'Frage', preview: 'Hallo, wann kommt mein Buch?' });
    expect(Number(r.data.cursor)).toBeGreaterThan(Number(start.data.cursor));
    expect((await t.api.get(`/api/events?since=${r.data.cursor}`, as(fullKey))).data.events).toEqual([]);
  });

  it('records tasks tagged "agent" and ignores the others', async () => {
    const before = (await t.api.get('/api/events?since=latest', as(fullKey))).data.cursor;
    const p = (await t.api.post('/api/pm/projects', { name: 'Agenten' })).data;
    await t.api.post('/api/pm/tasks', { project_id: p.id, title: 'Ohne Tag' });
    const task = (await t.api.post('/api/pm/tasks', { project_id: p.id, title: 'Newsletter schreiben', tags: ['Agent'] })).data;
    await t.app.events.flush();
    const r = await t.api.get(`/api/events?since=${before}&types=task.agent`, as(fullKey));
    expect(r.data.events.map((e: any) => [e.change, e.title])).toEqual([['created', 'Newsletter schreiben']]);
    expect(r.data.events[0].task_id).toBe(task.id);
  });

  it('shows a bound key only its areas and its own mentions; the cursor still moves past the rest', async () => {
    const before = (await t.api.get('/api/events?since=latest', as(grokKey))).data.cursor;
    t.app.events.emit(t.api.location, 'message.inbound', { contactId: null, contact: {}, message: { id: 'm2', channel: 'sms', body: 'geheim' } });
    await t.app.events.flush();
    const ch = (await t.api.post('/api/team-chat/channels', { name: 'agenten', kind: 'public' })).data.id;
    await t.api.post(`/api/team-chat/channels/${ch}/messages`, { body: '@GrokBot bitte die Kontakte von heute prüfen' });
    await t.app.services.collabIdle?.();
    const r = await t.api.get(`/api/events?since=${before}`, as(grokKey));
    expect(r.status).toBe(200);
    expect(r.data.events.map((e: any) => e.type)).toEqual(['chat.mention']); // no inbox: GrokBot has no "conversations"
    expect(r.data.events[0]).toMatchObject({ user_id: grokId, author: 'Chef', channel: 'agenten' });
    expect(r.data.events[0].text).toContain('bitte die Kontakte von heute prüfen');
    const all = await t.api.get(`/api/events?since=${before}`, as(fullKey));
    expect(all.data.events.map((e: any) => e.type)).toEqual(['message.inbound', 'chat.mention']);
    expect(r.data.cursor).toBe(all.data.cursor);
  });

  it('pages with limit and more, and rejects bad input', async () => {
    for (let i = 0; i < 3; i++) t.app.events.emit(t.api.location, 'message.inbound', { contact: {}, message: { id: `p${i}`, channel: 'chat', body: `Nr. ${i}` } });
    await t.app.events.flush();
    const all = (await t.api.get('/api/events?since=0&types=message.inbound', as(fullKey))).data.events.length;
    const first = await t.api.get('/api/events?since=0&types=message.inbound&limit=2', as(fullKey));
    expect(first.data.events).toHaveLength(2);
    expect(first.data.more).toBe(true);
    let seen = 2;
    let cur = first.data.cursor;
    for (;;) {
      const r = await t.api.get(`/api/events?since=${cur}&types=message.inbound&limit=2`, as(fullKey));
      seen += r.data.events.length;
      cur = r.data.cursor;
      if (!r.data.more) break;
    }
    expect(seen).toBe(all);
    expect((await t.api.get('/api/events?since=abc', as(fullKey))).status).toBe(400);
    expect((await t.api.get('/api/events?types=nope', as(fullKey))).status).toBe(400);
  });

  it('never shows another sub-account’s events or follow-ups', async () => {
    const other = (await t.api.post('/api/locations', { name: 'Fremdfirma' })).data.id;
    const mine = t.api.location;
    t.api.setLocation(other);
    const otherKey = (await t.api.post('/api/api-keys', { name: 'Fremd' })).data.key;
    t.api.setLocation(mine);
    const r = await t.api.get('/api/events?since=0', as(otherKey));
    expect(r.status).toBe(200);
    expect(r.data.events).toEqual([]);
    const anna = (await t.api.get('/api/contacts?q=Anna')).data.contacts[0].id;
    await t.api.put(`/api/contacts/${anna}/follow-up`, { at: `${new Date().getFullYear() + 1}-02-01` });
    expect((await t.api.get(`/api/contacts/${anna}/follow-up`, as(otherKey))).status).toBe(404);
    const put = await t.api.raw(`/api/contacts/${anna}/follow-up`, { method: 'PUT', headers: { 'content-type': 'application/json', ...as(otherKey) }, body: JSON.stringify({ at: `${new Date().getFullYear() + 1}-03-01` }) });
    expect(put.status).toBe(404);
    expect((await t.api.get('/api/follow-ups?state=all', as(otherKey))).data).toEqual([]);
  });

  it('is an MCP tool', async () => {
    const r = await t.api.raw('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${fullKey}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ghl_events_since', arguments: { since: 'latest' } } }),
    });
    const body = await r.json();
    expect(JSON.stringify(body)).toContain('cursor');
  });
});
