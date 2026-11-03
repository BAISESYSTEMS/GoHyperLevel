import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';

// "Wiedervorlage am": a contact is put aside until a date and comes back by itself.
describe('contact follow-up', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  let anna = '';
  let ben = '';
  const later = `${new Date().getFullYear() + 1}-01-15`;
  const names = (r: any) => r.data.contacts.map((c: any) => c.first_name).sort();

  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
    anna = (await t.api.post('/api/contacts', { first_name: 'Anna', email: 'anna@kunde.test' })).data.id;
    ben = (await t.api.post('/api/contacts', { first_name: 'Ben', email: 'ben@kunde.test' })).data.id;
  });
  afterAll(() => t.close());

  it('hides a waiting contact with follow_up=hide and shows it under waiting', async () => {
    const r = await t.api.put(`/api/contacts/${anna}/follow-up`, { at: later, note: 'nach dem Urlaub nachfassen' });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ contact_id: anna, note: 'nach dem Urlaub nachfassen', due: false, set_by: 'Chef' });
    expect(r.data.due_at).toBe(`${new Date().getFullYear() + 1}-01-14T23:00:00.000Z`); // start of the day in Berlin (CET)
    expect(names(await t.api.get('/api/contacts'))).toEqual(['Anna', 'Ben']); // the API default is unchanged
    expect(names(await t.api.get('/api/contacts?follow_up=hide'))).toEqual(['Ben']);
    expect(names(await t.api.get('/api/contacts?follow_up=waiting'))).toEqual(['Anna']);
    expect((await t.api.get('/api/follow-ups?state=waiting')).data.map((f: any) => f.name)).toEqual(['Anna']);
    expect((await t.api.get('/api/follow-ups')).data).toEqual([]);
  });

  it('comes back at the date: due list, workflow event and the agents’ feed – once', async () => {
    const seen: any[] = [];
    t.app.events.on('contact.follow_up_due', (e) => void seen.push(e.data));
    const cursor = (await t.api.get('/api/events?since=latest')).data.cursor;
    await t.api.put(`/api/contacts/${ben}/follow-up`, { at: new Date(Date.now() - 1000).toISOString(), note: 'Angebot nachfassen' });
    expect(names(await t.api.get('/api/contacts?follow_up=hide'))).toEqual(['Ben']);
    expect(names(await t.api.get('/api/contacts?follow_up=due'))).toEqual(['Ben']);
    await t.app.tick();
    await t.app.tick();
    await t.app.events.flush();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ contactId: ben, note: 'Angebot nachfassen' });
    const feed = (await t.api.get(`/api/events?since=${cursor}&types=contact.follow_up`)).data.events;
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ contact_id: ben, contact_name: 'Ben', note: 'Angebot nachfassen' });
  });

  it('a reply from the contact brings it back at once', async () => {
    await t.api.put(`/api/contacts/${anna}/follow-up`, { at: later });
    t.app.events.emit(t.api.location, 'message.inbound', { contactId: anna, contact: {}, message: { id: 'r1', channel: 'email', body: 'Bin zurück!' } });
    await t.app.events.flush();
    expect(names(await t.api.get('/api/contacts?follow_up=due'))).toEqual(['Anna', 'Ben']);
  });

  it('can be cleared, checks input, and works over MCP via ghl_update_contact', async () => {
    expect((await t.api.put(`/api/contacts/${anna}/follow-up`, { at: 'irgendwann' })).status).toBe(400);
    expect((await t.api.put('/api/contacts/nope/follow-up', { at: later })).status).toBe(404);
    expect((await t.api.del(`/api/contacts/${anna}/follow-up`)).status).toBe(200);
    expect((await t.api.get(`/api/contacts/${anna}/follow-up`)).data.due_at).toBeNull();

    const key = (await t.api.post('/api/api-keys', { name: 'Agent' })).data.key;
    const mcp = async (name: string, args: Record<string, unknown>) => {
      const r = await t.api.raw('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      return JSON.stringify(await r.json());
    };
    expect(await mcp('ghl_update_contact', { contact_id: anna, follow_up_at: later, follow_up_note: 'Q1' })).toContain('Q1');
    expect((await t.api.get(`/api/contacts/${anna}/follow-up`)).data).toMatchObject({ note: 'Q1' });
    expect(await mcp('ghl_follow_ups', { state: 'waiting' })).toContain('Anna');
    await mcp('ghl_update_contact', { contact_id: anna, follow_up_at: null });
    expect((await t.api.get(`/api/contacts/${anna}/follow-up`)).data.due_at).toBeNull();
  });
});
