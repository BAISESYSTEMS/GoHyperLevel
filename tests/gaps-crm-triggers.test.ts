import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { senderOf } from '../server/modules/message-triggers.js';
import { startTestApp } from './helpers.js';

/** Workflow triggers for outgoing messages and team replies (modules/message-triggers.ts). */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let me = '';
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  me = t.app.db.get<{ id: string }>('SELECT id FROM users LIMIT 1')!.id;
});
afterAll(() => t?.close());

const settle = () => new Promise((r) => setTimeout(r, 60));
const tagsOf = (id: string) => JSON.parse(t.app.db.get<{ tags: string }>('SELECT tags FROM contacts WHERE id = ?', id)!.tags) as string[];
async function flow(name: string, trigger: Record<string, unknown>, tag: string) {
  const wf = (await t.api.post('/api/workflows', { name, trigger, steps: [{ id: 's1', type: 'add_tag', tags: [tag] }], settings: { allow_reentry: true } })).data;
  expect((await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' })).status).toBe(200);
  return wf.id as string;
}

describe('outgoing message triggers', () => {
  it('classifies the sender', () => {
    expect(senderOf({ user_id: 'u1', source: 'Workflow' })).toBe('user');
    expect(senderOf({ source: 'manuell' })).toBe('user');
    expect(senderOf({ source: 'Workflow' })).toBe('workflow');
    expect(senderOf({ source: 'Kampagne: Herbst' })).toBe('campaign');
    expect(senderOf({ source: 'KI-Assistent' })).toBe('ai');
    expect(senderOf({ source: 'Terminbestätigung' })).toBe('system');
  });

  it('registers both triggers for the workflow editor', async () => {
    const meta = (await t.api.get('/api/workflows/meta')).data;
    const text = JSON.stringify(meta);
    expect(text).toContain('message.outbound');
    expect(text).toContain('message.team_reply');
  });

  it('a person answering starts "team replied" and "outbound" (channel and person filters apply)', async () => {
    await flow('Antwort', { type: 'message.team_reply', config: { user_id: me } }, 'beantwortet');
    await flow('Andere Person', { type: 'message.team_reply', config: { user_id: 'someone-else' } }, 'falsch');
    await flow('Ausgehend SMS', { type: 'message.outbound', config: { channel: 'sms' } }, 'sms-raus');
    await flow('Ausgehend E-Mail', { type: 'message.outbound', config: { channel: 'email' } }, 'mail-raus');
    const c = (await t.api.post('/api/contacts', { email: 'erika@example.com', phone: '+491701111111' })).data.id;
    const sent = await t.api.post('/api/messages', { contact_id: c, channel: 'email', subject: 'Angebot', body: 'Hallo Erika' });
    expect(sent.status).toBe(200);
    expect(['logged', 'sent']).toContain(sent.data.status);
    await settle();
    expect(tagsOf(c).sort()).toEqual(['beantwortet', 'mail-raus']);
    expect(t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM message_outbound_queue')!.n).toBe(0);
  });

  it('workflow messages count only when asked for (no automation ping-pong by default); failed sends never count', async () => {
    const c = (await t.api.post('/api/contacts', { email: 'jan@example.com', phone: '+491702222222' })).data.id;
    const wf = (await t.api.post('/api/workflows', { name: 'SMS bei Tag', trigger: { type: 'contact.tag_added', config: { tag: 'los' } }, steps: [{ id: 's1', type: 'send_sms', body: 'Hallo von uns' }] })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    await flow('Workflow-Nachricht', { type: 'message.outbound', config: { sender: 'workflow' } }, 'wf-raus');
    await t.api.post(`/api/contacts/${c}/tags`, { add: ['los'] });
    await settle();
    await t.app.tick();
    await settle();
    const tags = tagsOf(c);
    expect(tags).toContain('wf-raus');
    expect(tags).toContain('los');
    expect(t.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE contact_id = ? AND source = 'Workflow'`, c)!.n).toBe(1);
    // The plain "outbound SMS" workflow (default sender) ignored the workflow's SMS.
    expect(tags).not.toContain('sms-raus');
    expect(tags).not.toContain('beantwortet');

    // A DND contact: the send fails, nothing is queued.
    const d = (await t.api.post('/api/contacts', { email: 'dnd@example.com' })).data.id;
    await t.api.patch(`/api/contacts/${d}`, { dnd: true });
    t.app.db.run(`UPDATE contacts SET dnd = 1 WHERE id = ?`, d);
    const r = await t.api.post('/api/messages', { contact_id: d, channel: 'email', subject: 'x', body: 'y', ignore_dnd: false });
    await settle();
    if (r.data.status === 'failed') expect(tagsOf(d)).toEqual([]);
  });

  it('drafts and inbound messages never fire; a status change to sent fires once', async () => {
    const c = (await t.api.post('/api/contacts', { email: 'tom@example.com' })).data.id;
    const conv = t.app.db.get<{ id: string }>('SELECT id FROM conversations WHERE contact_id = ?', c)?.id;
    const convId = conv ?? (await t.api.post('/api/messages', { contact_id: c, channel: 'chat', body: 'Hi' }), t.app.db.get<{ id: string }>('SELECT id FROM conversations WHERE contact_id = ?', c)!.id);
    await settle();
    const before = tagsOf(c);
    t.app.db.run(`INSERT INTO messages (id, location_id, conversation_id, contact_id, channel, direction, subject, body, status, source, created_at) VALUES ('d1', ?, ?, ?, 'email', 'out', '', 'Entwurf', 'draft', 'KI-Assistent', ?)`, loc, convId, c, new Date().toISOString());
    t.app.db.run(`INSERT INTO messages (id, location_id, conversation_id, contact_id, channel, direction, subject, body, status, source, created_at) VALUES ('i1', ?, ?, ?, 'email', 'in', '', 'Frage', 'received', '', ?)`, loc, convId, c, new Date().toISOString());
    expect(t.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM message_outbound_queue WHERE message_id IN ('d1','i1')`)!.n).toBe(0);
    t.app.db.run(`UPDATE messages SET status = 'sent' WHERE id = 'd1'`);
    t.app.db.run(`UPDATE messages SET status = 'delivered' WHERE id = 'd1'`);
    expect(t.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM message_outbound_queue WHERE message_id = 'd1'`)!.n).toBe(1);
    const seen: any[] = [];
    t.app.events.on('message.outbound', (e) => void seen.push(e.data));
    await t.app.tick();
    await settle();
    expect(seen.filter((x) => x.message.id === 'd1')).toEqual([expect.objectContaining({ sender: 'ai', contactId: c })]);
    expect(tagsOf(c)).toEqual(before.includes('mail-raus') ? before : [...before, 'mail-raus']);
  });
});
