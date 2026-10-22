import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { receiveChat } from '../server/services/channel-kit.js';
import { receiveMessage } from '../server/services/messaging.js';
import { startTestApp } from './helpers.js';

/** Mark as spam and block sender (modules/inbox-spam.ts): receive hook, call router, inbox filter, workflow steps, undo. */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let spammer: any;
let friend: any;
const inbound: string[] = [];
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  spammer = (await t.api.post('/api/contacts', { first_name: 'Spam', email: 'spam@example.com', phone: '+4915111111111' })).data;
  friend = (await t.api.post('/api/contacts', { first_name: 'Freund', email: 'freund@example.com' })).data;
  t.app.events.on('message.inbound', (e) => void inbound.push(e.data.contactId));
});
afterAll(() => t?.close());

const tick = () => new Promise((r) => setTimeout(r, 30));
const conversations = async (filter = 'all') => ((await t.api.get(`/api/conversations?filter=${filter}`)).data as any[]).map((c) => c.contact_id);

describe('blocking a sender', () => {
  it('blocks from the inbox and reports the state', async () => {
    receiveMessage(t.app, loc, { channel: 'email', from: 'spam@example.com', subject: 'Angebot', body: 'Kaufen Sie jetzt!' });
    await tick();
    expect(await conversations()).toContain(spammer.id);
    expect((await t.api.get(`/api/blocked-contacts/${spammer.id}`)).data).toMatchObject({ blocked: false });
    expect((await t.api.post('/api/blocked-contacts', { contact_id: spammer.id, reason: 'egal' })).status).toBe(400);
    const r = await t.api.post('/api/blocked-contacts', { contact_id: spammer.id, reason: 'spam', note: 'Werbung' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ blocked: true, reason: 'spam', note: 'Werbung', source: 'inbox' });
    expect((await t.api.get(`/api/blocked-contacts/${spammer.id}`)).data).toMatchObject({ blocked: true });
    expect((await t.api.get('/api/blocked-contacts')).data.map((b: any) => b.email)).toEqual(['spam@example.com']);
    // The existing conversation is archived: read, out of the inbox, under "Spam".
    expect(t.app.db.get('SELECT unread FROM conversations WHERE contact_id = ?', spammer.id)).toEqual({ unread: 0 });
    expect(await conversations()).not.toContain(spammer.id);
    expect(await conversations('spam')).toEqual([spammer.id]);
  });

  it('archives new e-mails and chat messages of a blocked sender silently – stored, unread 0, no event', async () => {
    inbound.length = 0;
    const msg = receiveMessage(t.app, loc, { channel: 'email', from: 'spam@example.com', subject: 'Nochmal', body: 'Letzte Chance!' });
    const chat = receiveChat(t.app, loc, { channel: 'telegram', externalUser: '777', name: 'Spam', externalId: 'tg:777:1', body: 'hi' });
    // The Telegram user is a new contact (not blocked yet): its message arrives normally.
    expect(chat).not.toBeNull();
    receiveMessage(t.app, loc, { channel: 'email', from: 'freund@example.com', subject: 'Hallo', body: 'Wie geht es?' });
    await tick();
    expect(t.app.db.get('SELECT status FROM messages WHERE id = ?', msg.id)).toEqual({ status: 'spam' });
    expect(t.app.db.get('SELECT unread FROM conversations WHERE contact_id = ?', spammer.id)).toEqual({ unread: 0 });
    expect(inbound).not.toContain(spammer.id);
    expect(inbound).toContain(friend.id);
    expect(t.app.db.get('SELECT blocked_messages FROM blocked_contacts WHERE contact_id = ?', spammer.id)).toEqual({ blocked_messages: 1 });
    // Blocking the Telegram contact: its next message is a "duplicate" for the channel (no welcome, no event).
    await t.api.post('/api/blocked-contacts', { contact_id: chat!.contact.id, reason: 'harassment' });
    inbound.length = 0;
    expect(receiveChat(t.app, loc, { channel: 'telegram', externalUser: '777', name: 'Spam', externalId: 'tg:777:2', body: 'hallo?' })).toBeNull();
    await tick();
    expect(inbound).toEqual([]);
    expect(t.app.db.get(`SELECT status FROM messages WHERE external_id = 'tg:777:2'`)).toEqual({ status: 'spam' });
  });

  it('rejects calls of a blocked contact before any other router, without a "missed call"', async () => {
    const at = new Date().toISOString();
    t.app.db.insert('calls', { id: 'spamcall0000001', location_id: loc, contact_id: spammer.id, sid: 'CAspam', direction: 'in', from_number: '+4915111111111', to_number: '+4930123456', status: 'ringing', started_at: at, updated_at: at });
    const missed: string[] = [];
    t.app.events.on('call.missed', (e) => void missed.push(e.data.callId));
    const router = t.app.services.callRouters[0];
    const call = t.app.db.get('SELECT * FROM calls WHERE id = ?', 'spamcall0000001');
    const out = router({ loc: t.app.location(loc), call, cfg: {}, open: true, params: {} });
    expect(out).toContain('<Reject reason="rejected"/>');
    expect(t.app.db.get('SELECT status, reason, ended_at IS NOT NULL AS ended FROM calls WHERE id = ?', 'spamcall0000001')).toEqual({ status: 'canceled', reason: 'blocked', ended: 1 });
    expect(t.app.db.get('SELECT blocked_calls FROM blocked_contacts WHERE contact_id = ?', spammer.id)).toEqual({ blocked_calls: 1 });
    // Somebody else's call is left to the other routers.
    t.app.db.insert('calls', { id: 'friendcall00001', location_id: loc, contact_id: friend.id, sid: 'CAfriend', direction: 'in', from_number: '+4915122222222', to_number: '+4930123456', status: 'ringing', started_at: at, updated_at: at });
    expect(router({ loc: t.app.location(loc), call: t.app.db.get('SELECT * FROM calls WHERE id = ?', 'friendcall00001'), cfg: {}, open: true, params: {} })).toBeUndefined();
    await tick();
    expect(missed).toEqual([]);
  });

  it('unblocks – and the undo journal can take the unblock back', async () => {
    const r = await t.api.del(`/api/blocked-contacts/${spammer.id}`);
    expect(r.status).toBe(200);
    expect((await t.api.get(`/api/blocked-contacts/${spammer.id}`)).data.blocked).toBe(false);
    expect(await conversations()).toContain(spammer.id);
    expect((await t.api.del(`/api/blocked-contacts/${spammer.id}`)).status).toBe(404);
    const undoId = r.headers.get('x-undo-id');
    expect(undoId).toBeTruthy();
    expect((await t.api.post(`/api/undo/${undoId}`, {})).status).toBe(200);
    expect((await t.api.get(`/api/blocked-contacts/${spammer.id}`)).data).toMatchObject({ blocked: true, reason: 'spam', blocked_calls: 1 });
  });

  it('workflow steps block and unblock the run\'s contact', async () => {
    const run = { id: 'r1', workflow_id: 'w1', location_id: loc, contact_id: friend.id, event: {} } as any;
    const res = await t.app.services.workflowActions.block_contact(run, { reason: 'other', note: 'für {{contact.first_name}}' }, { contact: { first_name: 'Freund' } }, {});
    expect(res.result).toMatch(/Blockiert/);
    expect(t.app.db.get('SELECT reason, note, source FROM blocked_contacts WHERE contact_id = ?', friend.id)).toEqual({ reason: 'other', note: 'für Freund', source: 'workflow' });
    expect((await t.app.services.workflowActions.unblock_contact(run, {}, {}, {})).result).toBe('Blockierung aufgehoben');
    expect((await t.app.services.workflowActions.unblock_contact(run, {}, {}, {})).result).toBe('War nicht blockiert');
    const catalog = (await t.api.get('/api/workflow-catalog')).data;
    expect(JSON.stringify(catalog)).toContain('block_contact');
  });

  it("never blocks another sub-account's contact", async () => {
    const other = (await t.api.post('/api/locations', { name: 'Fremd' })).data.id as string;
    t.api.setLocation(other);
    const foreign = (await t.api.post('/api/contacts', { email: 'fremd@example.com' })).data.id as string;
    t.api.setLocation(loc);
    expect((await t.api.post('/api/blocked-contacts', { contact_id: foreign })).status).toBe(404);
    expect((await t.api.get(`/api/blocked-contacts/${foreign}`)).status).toBe(404);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM blocked_contacts WHERE contact_id = ?', foreign)).toEqual({ n: 0 });
  });

  it('goes with the contact (GDPR erasure)', async () => {
    expect((await t.api.post(`/api/contacts/${spammer.id}/erase`, { confirm: spammer.id })).status).toBe(200);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM blocked_contacts WHERE contact_id = ?', spammer.id)).toEqual({ n: 0 });
  });
});
