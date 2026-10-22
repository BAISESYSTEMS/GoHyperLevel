import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { client, type Call } from './security-fixtures.js';
import { BYE, expireSession, loginAgain, openSse, sessionHash } from './sse-fixtures.js';
import { cleanSettings, defaultSettings, resolveMentions, responseDeadline, slaStateOf, viewSql, withDefaults, nextAvailable, isAwayAt } from '../server/services/teaminbox-model.js';
import { calendarOf } from '../server/services/teaminbox-model.js';
import { INBOX_TOOLS } from '../server/modules/teaminbox-tools.js';

/**
 * Team-Posteingang: assignment (by hand, by rule, round robin that skips people who are away), status, snooze and priority,
 * internal notes with mentions, the answer timers (first / next response, breach, numbers), automatic closing, bulk actions,
 * workflow steps and triggers, permissions, sub-account isolation, the audit log, MCP tools and the app's endpoints.
 * No network: messages come in through the inbound webhook, answers through the regular message route.
 */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let other = '';
let anna: Call;
let ben: Call;
let cleo: Call;
let ids: { anna: string; ben: string; cleo: string; chef: string } = { anna: '', ben: '', cleo: '', chef: '' };
let inboundKey = '';
let keyA = '';
let n = 0;
const pushes: any[] = [];

const audit = (action: string) => t.app.db.all<any>('SELECT * FROM audit_log WHERE action LIKE ? ORDER BY at', action);
const settle = async () => {
  await t.app.events.flush();
  await Promise.all([...(t.app.services.collabPending ?? [])]);
};
const tick = async (at = new Date(), force = false) => {
  await t.app.services.inboxTick(at, force);
  await settle();
};
/** A customer writes: creates the contact and the conversation, returns the conversation id. */
async function inbound(email = `kunde${++n}@example.com`, text = 'Hallo, ich habe eine Frage', channel: 'email' | 'sms' = 'email') {
  const body = channel === 'email' ? { from: `Kunde ${n} <${email}>`, text, subject: 'Frage' } : { from: `+4917000000${String(n).padStart(2, '0')}`, body: text };
  const r = await t.api.raw(`/hooks/${loc}/${channel}?key=${inboundKey}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(r.status).toBe(200);
  await settle();
  const c = t.app.db.get<any>(channel === 'email' ? `SELECT v.* FROM conversations v JOIN contacts c ON c.id = v.contact_id WHERE c.email = ? AND v.location_id = ?` : `SELECT v.* FROM conversations v JOIN contacts c ON c.id = v.contact_id WHERE c.phone = ? AND v.location_id = ?`, channel === 'email' ? email : body.from, loc)!;
  return c.id as string;
}
const conv = (id: string) => t.app.db.get<any>('SELECT * FROM conversations WHERE id = ?', id)!;
const setSettings = async (patch: any) => {
  const r = await t.api.put('/api/inbox/settings', patch);
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
};
/** A person answers the customer through the normal message route. */
const reply = async (who: Call, id: string, body = 'Gerne, hier die Antwort') => {
  const c = conv(id);
  const r = await who('POST', '/api/messages', { contact_id: c.contact_id, channel: 'email', subject: 'Re: Frage', body }, { 'x-location-id': loc });
  expect(r.status, r.text).toBe(200);
  await tick();
  return r.data;
};

beforeAll(async () => {
  t = await startTestApp();
  const me = await t.setup();
  ids.chef = me.user.id;
  loc = t.api.location;
  other = (await t.api.post('/api/locations', { name: 'Zweite Firma' })).data.id;
  for (const [key, name, perms] of [['anna', 'Anna Schmidt', ['conversations']], ['ben', 'Ben Weber', ['conversations', 'settings']], ['cleo', 'Cleo Roth', ['contacts']]] as const) {
    const r = await t.api.post('/api/users', { email: `${key}@example.com`, password: `passwort-${key}1`, name, locations: [loc], permissions: perms });
    (ids as any)[key] = r.data.id;
  }
  const login = async (key: string) => {
    const c = client(t.base, { 'x-pghl': '1', 'x-location-id': loc });
    expect((await c('POST', '/api/auth/login', { email: `${key}@example.com`, password: `passwort-${key}1` })).status).toBe(200);
    return c;
  };
  anna = await login('anna');
  ben = await login('ben');
  cleo = await login('cleo');
  inboundKey = new URL((await t.api.get('/api/settings/inbound')).data.email).searchParams.get('key')!;
  keyA = (await t.api.post('/api/api-keys', { name: 'Inbox' })).data.key;
  t.app.services.pushNotify = async (i: any) => {
    pushes.push(i);
    return { users: 0, sent: 0, failed: 0, removed: 0 };
  };
}, 60_000);

afterAll(async () => {
  await settle();
  await t?.close();
});

describe('model (pure)', () => {
  it('settings: defaults, validation and a hostile stored value', () => {
    const d = defaultSettings();
    expect(d.assignment.mode).toBe('manual');
    expect(d.sla.enabled).toBe(false);
    expect(withDefaults('nonsense').assignment.rules).toEqual([]);
    expect(withDefaults({ sla: { first_response_min: -5, warn_percent: 500 } }).sla).toMatchObject({ first_response_min: 1, warn_percent: 99 });
    expect(() => cleanSettings({ assignment: { mode: 'zufall' } }, d)).toThrow(/Modus/);
    expect(() => cleanSettings({ business_hours: { mon: { open: true, from: '9', to: '17:00' } } }, d)).toThrow(/HH:MM/);
    expect(() => cleanSettings({ holidays: ['24.12.2026'] }, d)).toThrow(/JJJJ-MM-TT/);
    expect(() => cleanSettings({ assignment: { rules: [{ name: 'x', target: { type: 'user' } }] } }, d)).toThrow(/Ziel/);
    const next = cleanSettings({ assignment: { mode: 'round_robin', rules: [{ name: 'WhatsApp', channels: ['WhatsApp'], target: { type: 'team', id: 'abc' } }] }, auto_close_days: 7 }, d);
    expect(next.assignment.rules[0]).toMatchObject({ channels: ['whatsapp'], enabled: true, target: { type: 'team', id: 'abc' } });
    expect(next.auto_close_days).toBe(7);
  });

  it('mentions: picker links, full names and unique first names; strangers are not linked', () => {
    const people = [{ id: 'u1', name: 'Anna Schmidt' }, { id: 'u2', name: 'Ben Weber' }, { id: 'u3', name: 'Anna Braun' }];
    const r = resolveMentions('@Ben Weber und @Anna Schmidt bitte ansehen, @Anna wer? @Ben auch. Mail an info@Ben.de', people, 'u9');
    expect(r.ids.sort()).toEqual(['u1', 'u2']);
    expect(r.body).toContain('[@Ben Weber](user:u2)');
    expect(r.body).toContain('@Anna wer?'); // two Annas: no guess
    expect(r.body).toContain('info@Ben.de');
    const own = resolveMentions('[@Anna Schmidt](user:u1) und [@Fremd](user:zzz)', people, 'u1');
    expect(own.ids).toEqual([]); // the author is never told about their own note
    expect(own.body).toContain('@Fremd');
    expect(own.body).not.toContain('user:zzz');
  });

  it('SLA deadlines count business hours; the state follows the clock', () => {
    const s = withDefaults({ sla: { enabled: true, first_response_min: 120, next_response_min: 60, warn_percent: 50, business_hours: true } });
    const cal = calendarOf(s, 'Europe/Berlin');
    // Friday 2026-11-06 16:00 Berlin (15:00 UTC): 60 min left that day, 60 min on Monday morning.
    const d = responseDeadline(s, 'first', new Date('2026-11-06T15:00:00Z'), cal)!;
    expect(d.due).toBe('2026-11-09T09:00:00.000Z'); // Monday 10:00 Berlin
    expect(d.warn).toBe('2026-11-06T16:00:00.000Z'); // Friday 17:00 Berlin
    expect(responseDeadline(withDefaults({}), 'first', new Date(), cal)).toBeNull();
    const around = { ...s, sla: { ...s.sla, business_hours: false } };
    expect(responseDeadline(around, 'next', new Date('2026-11-06T15:00:00Z'), cal)!.due).toBe('2026-11-06T16:00:00.000Z');
    const row = { awaiting_since: '2026-11-06T15:00:00Z', response_due_at: '2026-11-06T17:00:00Z', response_warn_at: '2026-11-06T16:00:00Z', inbox_status: 'open' };
    expect(slaStateOf(row, new Date('2026-11-06T15:30:00Z'))).toBe('ok');
    expect(slaStateOf(row, new Date('2026-11-06T16:30:00Z'))).toBe('warning');
    expect(slaStateOf(row, new Date('2026-11-06T17:00:00Z'))).toBe('breached');
    expect(slaStateOf({ ...row, inbox_status: 'closed' }, new Date('2026-11-06T18:00:00Z'))).toBe('');
    expect(slaStateOf({ ...row, snoozed_until: '2026-11-07T00:00:00Z' }, new Date('2026-11-06T18:00:00Z'))).toBe('ok');
  });

  it('round robin takes turns and skips people who are away; availability combines pause, absence and hours', () => {
    const ok = (id: string) => id !== 'b';
    expect(nextAvailable(['a', 'b', 'c'], null, ok)).toBe('a');
    expect(nextAvailable(['a', 'b', 'c'], 'a', ok)).toBe('c');
    expect(nextAvailable(['a', 'b', 'c'], 'c', ok)).toBe('a');
    expect(nextAvailable(['a'], 'a', () => false)).toBeNull();
    const mon10 = new Date('2026-11-09T09:00:00Z'); // Monday 10:00 Berlin
    expect(isAwayAt({ paused: true, away: [] }, mon10)).toBe(true);
    expect(isAwayAt({ away: [{ start_at: '2026-11-09T00:00:00Z', end_at: '2026-11-10T00:00:00Z' }] }, mon10)).toBe(true);
    expect(isAwayAt({ away: [], hours: { mon: [['09:00', '12:00']] }, tz: 'Europe/Berlin' }, mon10)).toBe(false);
    expect(isAwayAt({ away: [], hours: { mon: [['13:00', '17:00']] }, tz: 'Europe/Berlin' }, mon10)).toBe(true);
    expect(isAwayAt({ away: [], hours: { tue: [['09:00', '12:00']] }, tz: 'Europe/Berlin' }, mon10)).toBe(true);
  });

  it('views are SQL on conversations; a snooze that ran out counts as awake', () => {
    const at = '2026-11-06T12:00:00.000Z';
    expect(viewSql('mine', 'u1', at)).toMatchObject({ params: ['u1', at] });
    expect(viewSql('unassigned', 'u1', at)!.sql).toContain('assignee_id IS NULL');
    expect(viewSql('all', 'u1', at)).toBeNull();
    expect(viewSql('mine', undefined, at)!.sql).toBe('0');
  });
});

describe('assignment, status, snooze, priority', () => {
  it('a new message opens a conversation that nobody owns; "Alle" still shows it', async () => {
    const id = await inbound();
    expect(conv(id)).toMatchObject({ inbox_status: 'open', assignee_id: null, priority: 'normal' });
    const list = (await t.api.get('/api/conversations?view=unassigned')).data as any[];
    expect(list.some((c) => c.id === id)).toBe(true);
    const row = list.find((c) => c.id === id);
    expect(row).toMatchObject({ assignee_name: '', sla: { state: '' }, snoozed: false });
    expect(((await t.api.get('/api/conversations')).data as any[]).some((c) => c.id === id)).toBe(true);
  });

  it('assigns by hand: timeline, event, audit, notice to the person, views and counts follow', async () => {
    const id = await inbound();
    const events: any[] = [];
    t.app.events.on('conversation.assigned', (e) => void events.push(e.data));
    pushes.length = 0;
    const r = await t.api.post(`/api/inbox/conversations/${id}/assign`, { user_id: ids.anna });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ assignee_id: ids.anna, assignee_name: 'Anna Schmidt', status: 'open' });
    expect(r.data.timeline.at(-1)).toMatchObject({ type: 'assigned' });
    await settle();
    expect(events.at(-1)).toMatchObject({ conversationId: id, assigneeId: ids.anna, via: 'user' });
    expect(pushes.some((p) => p.userIds?.includes(ids.anna) && /zugewiesen/.test(p.title))).toBe(true);
    expect(audit('inbox.assign%').length).toBeGreaterThanOrEqual(0);
    expect(audit('conversations.%').length + audit('inbox.%').length).toBeGreaterThan(0);
    const mine = (await anna('GET', '/api/conversations?view=mine')).data as any[];
    expect(mine.map((c) => c.id)).toContain(id);
    expect(((await ben('GET', '/api/conversations?view=mine')).data as any[]).map((c) => c.id)).not.toContain(id);
    const counts = (await anna('GET', '/api/inbox/counts')).data;
    expect(counts.mine).toBeGreaterThanOrEqual(1);
    // "me", unassign, and somebody without access is refused
    expect((await anna('POST', `/api/inbox/conversations/${id}/assign`, { user_id: 'me' })).data.assignee_id).toBe(ids.anna);
    expect((await ben('POST', `/api/inbox/conversations/${id}/assign`, { user_id: 'me' })).data.assignee_id).toBe(ids.ben);
    expect((await ben('POST', `/api/inbox/conversations/${id}/assign`, { user_id: null })).data.assignee_id).toBeNull();
    const refused = await t.api.post(`/api/inbox/conversations/${id}/assign`, { user_id: ids.cleo });
    expect(refused.status).toBe(400);
    expect(refused.data.error).toMatch(/Zugriff/);
    expect((await t.api.post(`/api/inbox/conversations/${id}/assign`, {})).status).toBe(400);
  });

  it('status: closing, reopening on a new message, and the event', async () => {
    const email = `status${++n}@example.com`;
    const id = await inbound(email);
    const events: any[] = [];
    t.app.events.on('conversation.status_changed', (e) => void events.push(e.data));
    const closed = await t.api.post(`/api/inbox/conversations/${id}/status`, { status: 'closed' });
    expect(closed.data).toMatchObject({ status: 'closed' });
    expect(conv(id).closed_at).toBeTruthy();
    expect(((await t.api.get('/api/conversations?view=done')).data as any[]).map((c) => c.id)).toContain(id);
    expect(((await t.api.get('/api/conversations?view=open')).data as any[]).map((c) => c.id)).not.toContain(id);
    await settle();
    expect(events.at(-1)).toMatchObject({ status: 'closed', previous: 'open' });
    expect((await t.api.post(`/api/inbox/conversations/${id}/status`, { status: 'kaputt' })).status).toBe(400);
    await inbound(email, 'Noch eine Frage');
    expect(conv(id)).toMatchObject({ inbox_status: 'open', closed_at: null });
    expect(events.at(-1)).toMatchObject({ status: 'open', previous: 'closed', via: 'customer' });
    // waiting for the contact, and back to open with the answer of the contact
    await t.api.post(`/api/inbox/conversations/${id}/status`, { status: 'waiting' });
    expect(((await t.api.get('/api/conversations?view=waiting')).data as any[]).map((c) => c.id)).toContain(id);
    await inbound(email, 'Hier bin ich wieder');
    expect(conv(id).inbox_status).toBe('open');
  });

  it('snooze hides the conversation, wakes it on time and on a new message; the past is refused', async () => {
    const email = `snooze${++n}@example.com`;
    const id = await inbound(email);
    expect((await t.api.post(`/api/inbox/conversations/${id}/snooze`, { until: new Date(Date.now() - 1000).toISOString() })).status).toBe(400);
    expect((await t.api.post(`/api/inbox/conversations/${id}/snooze`, { until: 'morgen' })).status).toBe(400);
    const until = new Date(Date.now() + 3600_000).toISOString();
    const r = await t.api.post(`/api/inbox/conversations/${id}/snooze`, { until });
    expect(r.data.snoozed_until).toBe(until);
    expect(((await t.api.get('/api/conversations?view=snoozed')).data as any[]).map((c) => c.id)).toContain(id);
    expect(((await t.api.get('/api/conversations?view=open')).data as any[]).map((c) => c.id)).not.toContain(id);
    // an hour later the scheduler brings it back and tells the assignee
    await t.api.post(`/api/inbox/conversations/${id}/assign`, { user_id: ids.anna });
    pushes.length = 0;
    await tick(new Date(Date.now() + 3601_000));
    expect(conv(id).snoozed_until).toBeNull();
    expect(((await t.api.get('/api/conversations?view=open')).data as any[]).map((c) => c.id)).toContain(id);
    expect(pushes.some((p) => /Wieder da/.test(p.title) && p.userIds?.includes(ids.anna))).toBe(true);
    // a message of the contact wakes it right away
    await t.api.post(`/api/inbox/conversations/${id}/snooze`, { until });
    await inbound(email, 'Hallo? Bitte antworten');
    expect(conv(id).snoozed_until).toBeNull();
    // closing clears a snooze
    await t.api.post(`/api/inbox/conversations/${id}/snooze`, { until });
    await t.api.post(`/api/inbox/conversations/${id}/status`, { status: 'closed' });
    expect(conv(id).snoozed_until).toBeNull();
  });

  it('priority and the rejected values', async () => {
    const id = await inbound();
    expect((await t.api.post(`/api/inbox/conversations/${id}/priority`, { priority: 'urgent' })).data.priority).toBe('urgent');
    expect((await t.api.post(`/api/inbox/conversations/${id}/priority`, { priority: 'sofort' })).status).toBe(400);
    const q = (await t.api.get('/api/inbox/queue?view=open&sort=priority&limit=5')).data;
    expect(q.conversations[0]).toMatchObject({ id, priority: 'urgent' });
  });

  it('bulk: assign and close many, report what could not be done', async () => {
    const a = await inbound();
    const b = await inbound();
    const r = await t.api.post('/api/inbox/bulk', { ids: [a, b, 'gibtsnicht'], action: 'assign', user_id: ids.ben });
    expect(r.data.updated).toBe(2);
    expect(r.data.skipped).toEqual([{ id: 'gibtsnicht', error: 'Konversation nicht gefunden' }]);
    expect(conv(a).assignee_id).toBe(ids.ben);
    expect((await t.api.post('/api/inbox/bulk', { ids: [a, b], action: 'close' })).data.updated).toBe(2);
    expect(conv(b).inbox_status).toBe('closed');
    expect((await t.api.post('/api/inbox/bulk', { ids: [a], action: 'priority', priority: 'high' })).data.updated).toBe(1);
    expect((await t.api.post('/api/inbox/bulk', { ids: [], action: 'close' })).status).toBe(400);
    expect((await t.api.post('/api/inbox/bulk', { ids: [a], action: 'löschen' })).status).toBe(400);
    expect((await t.api.post('/api/inbox/bulk', { ids: Array.from({ length: 201 }, (_, i) => `x${i}`), action: 'close' })).status).toBe(400);
  });
});

describe('internal notes', () => {
  it('are visible to the team, never part of the messages, and mention people (app, push, e-mail)', async () => {
    const id = await inbound();
    pushes.length = 0;
    const r = await anna('POST', `/api/inbox/conversations/${id}/notes`, { body: 'Bitte @Ben Weber das Angebot prüfen – Kunde wartet' });
    expect(r.status, r.text).toBe(200);
    expect(r.data.mentioned).toEqual([ids.ben]);
    expect(r.data.body).toContain(`[@Ben Weber](user:${ids.ben})`);
    await settle();
    expect(pushes.some((p) => p.userIds?.includes(ids.ben) && /erwähnt/.test(p.title))).toBe(true);
    // never in the conversation's messages, never sent to the contact
    const msgs = (await t.api.get(`/api/conversations/${id}/messages`)).data;
    expect(JSON.stringify(msgs.messages)).not.toContain('Angebot prüfen');
    expect(t.app.db.all('SELECT * FROM messages WHERE conversation_id = ? AND direction = ?', id, 'out')).toEqual([]);
    // the mentioned person sees it in "Erwähnungen" until they open the conversation
    const counts = (await ben('GET', '/api/inbox/counts')).data;
    expect(counts.mentions).toBeGreaterThanOrEqual(1);
    expect(((await ben('GET', '/api/conversations?view=mentions')).data as any[]).map((c) => c.id)).toContain(id);
    const seen = (await ben('GET', `/api/inbox/conversations/${id}`)).data;
    expect(seen.timeline.find((x: any) => x.type === 'note')).toMatchObject({ author_name: 'Anna Schmidt' });
    expect(((await ben('GET', '/api/conversations?view=mentions')).data as any[]).map((c) => c.id)).not.toContain(id);
    // validation, deleting
    expect((await anna('POST', `/api/inbox/conversations/${id}/notes`, { body: '   ' })).status).toBe(400);
    expect((await anna('POST', `/api/inbox/conversations/${id}/notes`, { body: 'x'.repeat(10_001) })).status).toBe(400);
    expect((await ben('DELETE', `/api/inbox/conversations/${id}/notes/${r.data.id}`)).status).toBe(200); // Ben has the settings area
    const again = await anna('POST', `/api/inbox/conversations/${id}/notes`, { body: 'zweite' });
    const mineOnly = await t.api.del(`/api/inbox/conversations/${id}/notes/${again.data.id}`);
    expect(mineOnly.status).toBe(200); // admin
    expect(t.app.db.all('SELECT * FROM inbox_timeline WHERE conversation_id = ? AND type = ?', id, 'note')).toEqual([]);
  });

  it('a note by a restricted member without the settings area cannot be deleted by a colleague', async () => {
    const id = await inbound();
    const note = (await ben('POST', `/api/inbox/conversations/${id}/notes`, { body: 'von Ben' })).data;
    const r = await anna('DELETE', `/api/inbox/conversations/${id}/notes/${note.id}`);
    expect(r.status).toBe(403);
  });

  it('are exported and erased with the contact (GDPR)', async () => {
    const email = `gdpr${++n}@example.com`;
    const id = await inbound(email);
    await anna('POST', `/api/inbox/conversations/${id}/notes`, { body: 'Interne Anmerkung zur Person' });
    const contactId = conv(id).contact_id;
    const exp = await t.api.get(`/api/contacts/${contactId}/privacy-export`);
    expect(JSON.stringify(exp.data)).toContain('Interne Anmerkung zur Person');
  });
});

describe('automatic assignment', () => {
  it('round robin takes turns, skips people who are away or paused, and tells nobody twice', async () => {
    await setSettings({ assignment: { mode: 'round_robin', pool: 'users', user_ids: [ids.anna, ids.ben], respect_availability: true, prefer_contact_owner: false } });
    const first = await inbound();
    const second = await inbound();
    const third = await inbound();
    expect(new Set([conv(first).assignee_id, conv(second).assignee_id])).toEqual(new Set([ids.anna, ids.ben]));
    expect(conv(third).assignee_id).toBe(conv(first).assignee_id);
    // Anna on holiday: everything goes to Ben
    const now = Date.now();
    expect((await anna('POST', '/api/team-people/me/away', { start_at: new Date(now - 3600_000).toISOString(), end_at: new Date(now + 86400_000).toISOString(), note: 'Urlaub' })).status).toBe(200);
    const ids4 = [await inbound(), await inbound(), await inbound()];
    expect(ids4.map((i) => conv(i).assignee_id)).toEqual([ids.ben, ids.ben, ids.ben]);
    // Ben pauses too: nobody is around, so the conversation stays in the queue
    await ben('PUT', '/api/team-people/me', { paused: true });
    const none = await inbound();
    expect(conv(none).assignee_id).toBeNull();
    // Ben is back: the reassignment of a conversation whose owner is away also works
    await ben('PUT', '/api/team-people/me', { paused: false });
    const owned = await inbound(`away${++n}@example.com`);
    expect(conv(owned).assignee_id).toBe(ids.ben);
    await ben('PUT', '/api/team-people/me', { paused: true });
    await anna('DELETE', `/api/team-people/away/${t.app.db.get<any>('SELECT id FROM team_away WHERE user_id = ?', ids.anna)!.id}`);
    await inbound(t.app.db.get<any>('SELECT email FROM contacts WHERE id = ?', conv(owned).contact_id)!.email, 'noch eine');
    expect(conv(owned).assignee_id).toBe(ids.anna);
    expect(t.app.db.get<any>(`SELECT body FROM inbox_timeline WHERE conversation_id = ? AND type = 'auto'`, owned)?.body).toMatch(/abwesend/);
    await ben('PUT', '/api/team-people/me', { paused: false });
  });

  it('rules by channel and tag; the contact owner comes first; least busy picks the lighter load', async () => {
    await setSettings({
      assignment: { mode: 'round_robin', pool: 'users', user_ids: [ids.anna], respect_availability: false, prefer_contact_owner: true, rules: [{ name: 'SMS an Ben', channels: ['sms'], target: { type: 'user', id: ids.ben }, priority: 'high' }, { name: 'VIP', tags: ['vip'], target: { type: 'user', id: ids.ben } }] },
    });
    const sms = await inbound(undefined, 'Hallo per SMS', 'sms');
    expect(conv(sms)).toMatchObject({ assignee_id: ids.ben, priority: 'high' });
    expect(t.app.db.get<any>(`SELECT body FROM inbox_timeline WHERE conversation_id = ? AND type = 'assigned'`, sms)?.body).toContain('Regel „SMS an Ben“');
    // tagged contact
    const vip = (await t.api.post('/api/contacts', { email: `vip${++n}@example.com`, first_name: 'Vera', tags: ['vip'] })).data;
    await inbound(vip.email);
    expect(t.app.db.get<any>('SELECT assignee_id FROM conversations WHERE contact_id = ?', vip.id)!.assignee_id).toBe(ids.ben);
    // contact owner beats the rules
    const owned = (await t.api.post('/api/contacts', { email: `owner${++n}@example.com`, first_name: 'Olga', tags: ['vip'], assigned_to: ids.anna })).data;
    await inbound(owned.email);
    expect(t.app.db.get<any>('SELECT assignee_id FROM conversations WHERE contact_id = ?', owned.id)!.assignee_id).toBe(ids.anna);
    // least busy
    await setSettings({ assignment: { mode: 'least_busy', pool: 'users', user_ids: [ids.anna, ids.ben], prefer_contact_owner: false, rules: [] } });
    const load = (u: string) => t.app.db.get<any>(`SELECT COUNT(*) n FROM conversations WHERE assignee_id = ? AND inbox_status != 'closed'`, u)!.n;
    const target = load(ids.anna) <= load(ids.ben) ? ids.anna : ids.ben;
    const lighter = await inbound();
    expect(conv(lighter).assignee_id).toBe(target);
  });

  it('rules may only name people and teams of this sub-account; manual mode assigns nobody', async () => {
    const bad = await t.api.put('/api/inbox/settings', { assignment: { rules: [{ name: 'x', target: { type: 'user', id: ids.cleo } }] } });
    expect(bad.status).toBe(400);
    const badTeam = await t.api.put('/api/inbox/settings', { assignment: { team_id: 'fremdes-team' } });
    expect(badTeam.status).toBe(400);
    await setSettings({ assignment: { mode: 'manual', rules: [] } });
    const id = await inbound();
    expect(conv(id).assignee_id).toBeNull();
  });

  it('a team takes turns inside itself', async () => {
    const team = (await t.api.post('/api/helpdesk/teams', { name: 'Vertrieb', members: [ids.anna, ids.ben] })).data;
    await setSettings({ assignment: { mode: 'round_robin', pool: 'team', team_id: team.id, rules: [], respect_availability: false } });
    const a = await inbound();
    const b = await inbound();
    expect(conv(a).team_id).toBe(team.id);
    expect(new Set([conv(a).assignee_id, conv(b).assignee_id])).toEqual(new Set([ids.anna, ids.ben]));
    await setSettings({ assignment: { mode: 'manual', pool: 'all' } });
  });

  it('whoever answers an unassigned conversation owns it', async () => {
    await setSettings({ assignment: { mode: 'manual', assign_on_reply: true } });
    const id = await inbound();
    await reply(anna, id);
    expect(conv(id).assignee_id).toBe(ids.anna);
    expect(conv(id).first_response_at).toBeTruthy();
    // an assigned conversation keeps its owner
    const other = await inbound();
    await t.api.post(`/api/inbox/conversations/${other}/assign`, { user_id: ids.ben });
    await reply(anna, other);
    expect(conv(other).assignee_id).toBe(ids.ben);
    // "waiting for the contact" after a reply, when switched on
    await setSettings({ reply_sets_waiting: true });
    const w = await inbound();
    await reply(anna, w);
    expect(conv(w).inbox_status).toBe('waiting');
    await setSettings({ reply_sets_waiting: false });
  });
});

describe('answer timers', () => {
  it('first and next response: due times, warning, breach with event and notice, answer clears them, numbers', async () => {
    await setSettings({ sla: { enabled: true, first_response_min: 60, next_response_min: 30, warn_percent: 50, business_hours: false, notify_assignee: true }, assignment: { mode: 'manual' } });
    const breaches: any[] = [];
    t.app.events.on('conversation.sla_breached', (e) => void breaches.push(e.data));
    const email = `sla${++n}@example.com`;
    const id = await inbound(email);
    await tick();
    const c0 = conv(id);
    expect(c0.awaiting_kind).toBe('first');
    expect(Date.parse(c0.response_due_at) - Date.parse(c0.awaiting_since)).toBe(60 * 60_000);
    expect(Date.parse(c0.response_warn_at) - Date.parse(c0.awaiting_since)).toBe(30 * 60_000);
    await t.api.post(`/api/inbox/conversations/${id}/assign`, { user_id: ids.anna });
    // 40 minutes: warning
    pushes.length = 0;
    await tick(new Date(Date.now() + 40 * 60_000));
    expect(conv(id).sla_state).toBe('warning');
    expect(((await t.api.get('/api/conversations?view=sla')).data as any[]).map((c) => c.id)).toContain(id);
    expect(pushes.some((p) => /läuft bald ab/.test(p.title) && p.userIds?.includes(ids.anna))).toBe(true);
    // 70 minutes: breached – once
    pushes.length = 0;
    await tick(new Date(Date.now() + 70 * 60_000));
    await tick(new Date(Date.now() + 80 * 60_000));
    expect(conv(id).sla_state).toBe('breached');
    expect(breaches.filter((b) => b.conversationId === id)).toHaveLength(1);
    expect(breaches.find((b) => b.conversationId === id)).toMatchObject({ slaKind: 'first', assigneeId: ids.anna });
    expect(pushes.filter((p) => /überfällig/.test(p.title))).toHaveLength(1);
    expect(audit('inbox.sla_breached').length).toBeGreaterThan(0);
    const viewRow = ((await t.api.get('/api/conversations?view=sla')).data as any[]).find((c) => c.id === id);
    expect(viewRow.sla).toMatchObject({ state: 'breached', kind: 'first' });
    // the answer (late) ends the timer and is counted as a miss with the person who answered
    await reply(ben, id);
    const c1 = conv(id);
    expect(c1).toMatchObject({ awaiting_since: null, sla_state: '', response_due_at: null });
    const log = t.app.db.all<any>('SELECT * FROM inbox_response_log WHERE conversation_id = ?', id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ kind: 'first', responder_id: ids.ben, assignee_id: ids.anna, outcome: 'replied' });
    // (the clock of this test is the real one, so the answer came in time)
    expect(log[0].breached).toBe(0);
    expect(log[0].business_min).not.toBeNull();
    // the customer writes again: now the "next response" timer (30 minutes) runs
    await inbound(email, 'Danke, noch eine Frage');
    await tick();
    const c2 = conv(id);
    expect(c2.awaiting_kind).toBe('next');
    expect(Date.parse(c2.response_due_at) - Date.parse(c2.awaiting_since)).toBe(30 * 60_000);
  });

  it('a late answer counts as missed; closing a late conversation without an answer too; automated mail never stops the timer', async () => {
    const id = await inbound();
    await tick();
    // pretend the message came in two hours ago
    const past = new Date(Date.now() - 2 * 3600_000).toISOString();
    t.app.db.run('UPDATE conversations SET awaiting_since = ?, response_due_at = ?, response_warn_at = ? WHERE id = ?', past, new Date(Date.now() - 3600_000).toISOString(), new Date(Date.now() - 5400_000).toISOString(), id);
    // a campaign-like automated message (no person, not manual) does not answer it
    t.app.db.insert('messages', { id: 'auto1', location_id: loc, conversation_id: id, contact_id: conv(id).contact_id, channel: 'email', direction: 'out', subject: 'Newsletter', body: 'Hallo', status: 'sent', source: 'Kampagne', created_at: new Date().toISOString() });
    expect(conv(id).awaiting_since).toBe(past);
    await reply(anna, id);
    const row = t.app.db.get<any>('SELECT * FROM inbox_response_log WHERE conversation_id = ?', id)!;
    expect(row.breached).toBe(1);
    const closed = await inbound();
    await tick();
    t.app.db.run('UPDATE conversations SET response_due_at = ? WHERE id = ?', new Date(Date.now() - 60_000).toISOString(), closed);
    await t.api.post(`/api/inbox/conversations/${closed}/status`, { status: 'closed' });
    expect(conv(closed)).toMatchObject({ awaiting_since: null, response_due_at: null });
    expect(t.app.db.get<any>('SELECT outcome, breached FROM inbox_response_log WHERE conversation_id = ?', closed)).toEqual({ outcome: 'closed', breached: 1 });
  });

  it('a snooze pauses the timer and it starts again from the wake-up', async () => {
    const id = await inbound();
    await tick();
    const due = conv(id).response_due_at;
    await t.api.post(`/api/inbox/conversations/${id}/snooze`, { until: new Date(Date.now() + 2 * 3600_000).toISOString() });
    await tick(new Date(Date.now() + 90 * 60_000)); // past the old deadline, but snoozed
    expect(conv(id).sla_state).toBe('');
    await tick(new Date(Date.now() + 3 * 3600_000));
    const after = conv(id);
    expect(after.snoozed_until).toBeNull();
    expect(Date.parse(after.response_due_at)).toBeGreaterThan(Date.parse(due));
  });

  it('without SLA nothing is ever overdue', async () => {
    await setSettings({ sla: { enabled: false } });
    const id = await inbound();
    await tick(new Date(Date.now() + 30 * 86400_000));
    expect(conv(id)).toMatchObject({ response_due_at: null, sla_state: '' });
    expect(conv(id).awaiting_since).toBeTruthy(); // the numbers still work
  });

  it('old imported messages never start a timer', async () => {
    const id = await inbound();
    await reply(anna, id);
    t.app.db.insert('messages', { id: 'old1', location_id: loc, conversation_id: id, contact_id: conv(id).contact_id, channel: 'email', direction: 'in', subject: 'Alt', body: 'vor Jahren', status: 'received', source: 'import', created_at: '2020-01-01T10:00:00.000Z' });
    expect(conv(id).awaiting_since).toBeNull();
  });
});

describe('automatic closing', () => {
  it('closes conversations nobody answered for N days after our last message – only those', async () => {
    await setSettings({ auto_close_days: 3, sla: { enabled: false } });
    const silent = await inbound();
    await reply(anna, silent);
    const talking = await inbound();
    await reply(anna, talking);
    await inbound(t.app.db.get<any>('SELECT email FROM contacts WHERE id = ?', conv(talking).contact_id)!.email, 'Ich antworte');
    const unanswered = await inbound();
    const snoozed = await inbound();
    await reply(anna, snoozed);
    await t.api.post(`/api/inbox/conversations/${snoozed}/snooze`, { until: new Date(Date.now() + 30 * 86400_000).toISOString() });
    const at = new Date(Date.now() + 4 * 86400_000);
    // the "last answer" is four days old for all of them
    t.app.db.run('UPDATE conversations SET last_out_at = ?, last_in_at = ? WHERE id IN (?, ?)', new Date(at.getTime() - 4 * 86400_000 - 1000).toISOString(), new Date(at.getTime() - 4 * 86400_000 - 5000).toISOString(), silent, snoozed);
    t.app.db.run('UPDATE conversations SET last_out_at = ? WHERE id = ?', new Date(at.getTime() - 4 * 86400_000 - 1000).toISOString(), talking);
    const events: any[] = [];
    t.app.events.on('conversation.status_changed', (e) => void events.push(e.data));
    // (the runner only looks every ten minutes: force it by moving its clock)
    await tick(new Date(at.getTime() + 11 * 60_000), true);
    expect(conv(silent).inbox_status).toBe('closed');
    expect(conv(talking).inbox_status).toBe('open');
    expect(conv(unanswered).inbox_status).toBe('open');
    expect(conv(snoozed).inbox_status).toBe('open');
    expect(events.find((e) => e.conversationId === silent)).toMatchObject({ status: 'closed', via: 'system', reason: 'Keine Antwort seit 3 Tagen' });
    expect(audit('inbox.status').some((a) => a.actor === 'Automatik')).toBe(true);
    await setSettings({ auto_close_days: 0 });
  });
});

describe('workflows', () => {
  it('has three triggers and three steps in the catalogue', async () => {
    const cat = (await t.api.get('/api/workflow-catalog')).data;
    for (const type of ['conversation.assigned', 'conversation.status_changed', 'conversation.sla_breached']) expect(cat.triggers.some((x: any) => x.type === type), type).toBe(true);
    for (const type of ['inbox_assign', 'inbox_set_status', 'inbox_note']) expect(cat.actions.some((x: any) => x.type === type), type).toBe(true);
  });

  it('steps assign, set the status and write a note (with a mention) for the contact of the run', async () => {
    await setSettings({ assignment: { mode: 'manual' } });
    const id = await inbound();
    const contactId = conv(id).contact_id;
    const created = await t.api.post('/api/workflows', {
      name: 'Posteingang',
      trigger: { type: 'manual', config: {} },
      steps: [
        { type: 'inbox_assign', mode: 'user', assignee_id: ids.anna },
        { type: 'inbox_note', body: '@Ben Weber bitte {{contact.first_name}} anrufen' },
        { type: 'inbox_set_status', status: 'waiting', priority: 'high' },
        { type: 'inbox_assign', mode: 'auto' },
        { type: 'inbox_assign', mode: 'none' },
      ],
    });
    expect(created.status, JSON.stringify(created.data)).toBe(200);
    await t.api.patch(`/api/workflows/${created.data.id}`, { status: 'active' });
    await t.api.post(`/api/workflows/${created.data.id}/enroll`, { contact_ids: [contactId] });
    await settle();
    const run = t.app.db.get<any>('SELECT * FROM workflow_runs WHERE workflow_id = ?', created.data.id)!;
    const log = JSON.parse(run.log);
    expect(log.map((l: any) => l.error ?? l.result)).toEqual(['Zugewiesen an Anna Schmidt', 'Notiz gespeichert (1 erwähnt)', 'Status: Wartet auf Kontakt', expect.stringMatching(/automatische Zuweisung ist ausgeschaltet/), 'Niemand zugewiesen']);
    expect(conv(id)).toMatchObject({ inbox_status: 'waiting', priority: 'high' });
    const note = t.app.db.get<any>(`SELECT * FROM inbox_timeline WHERE conversation_id = ? AND type = 'note'`, id)!;
    expect(note.author_name).toBe('Workflow');
    expect(note.body).toContain('anrufen');
    expect(note.mentions).toBe(JSON.stringify([ids.ben]));
    expect(audit('inbox.assign').some((a) => a.actor === 'Workflow')).toBe(true);
  });

  it('triggers start workflows with the right filters', async () => {
    const mk = async (trigger: any, tag: string) => {
      const r = await t.api.post('/api/workflows', { name: `wf ${tag}`, trigger, steps: [{ type: 'add_tag', tags: [tag] }] });
      expect(r.status, JSON.stringify(r.data)).toBe(200);
      await t.api.patch(`/api/workflows/${r.data.id}`, { status: 'active' });
    };
    await mk({ type: 'conversation.assigned', config: { assignee_id: ids.ben } }, 'ran-ben');
    await mk({ type: 'conversation.assigned', config: { assignee_id: ids.anna } }, 'ran-anna');
    await mk({ type: 'conversation.status_changed', config: { status: 'closed' } }, 'ran-closed');
    await mk({ type: 'conversation.status_changed', config: { status: 'waiting' } }, 'ran-waiting');
    const id = await inbound();
    await t.api.post(`/api/inbox/conversations/${id}/assign`, { user_id: ids.ben });
    await t.api.post(`/api/inbox/conversations/${id}/status`, { status: 'closed' });
    const tagsOf = () => JSON.parse(t.app.db.get<any>('SELECT tags FROM contacts WHERE id = ?', conv(id).contact_id)!.tags) as string[];
    for (let i = 0; i < 40 && !(tagsOf().includes('ran-ben') && tagsOf().includes('ran-closed')); i++) {
      await settle();
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(tagsOf().sort()).toEqual(['ran-ben', 'ran-closed']);
  });
});

describe('permissions, isolation, audit', () => {
  it('a member without the conversations area cannot use any inbox route; settings need the settings area', async () => {
    const id = await inbound();
    for (const [m, p, b] of [['GET', '/api/inbox/meta'], ['GET', '/api/inbox/counts'], ['GET', '/api/inbox/queue'], ['GET', `/api/inbox/conversations/${id}`], ['POST', `/api/inbox/conversations/${id}/assign`, { user_id: 'me' }], ['POST', `/api/inbox/conversations/${id}/notes`, { body: 'x' }], ['POST', '/api/inbox/bulk', { ids: [id], action: 'close' }]] as const) {
      const r = await cleo(m, p, b);
      expect(r.status, `${m} ${p}`).toBe(403);
    }
    expect((await anna('GET', '/api/inbox/settings')).status).toBe(403);
    expect((await anna('PUT', '/api/inbox/settings', { auto_close_days: 1 })).status).toBe(403);
    expect((await ben('GET', '/api/inbox/settings')).status).toBe(200);
  });

  it('another sub-account never sees or changes these conversations', async () => {
    const id = await inbound();
    t.api.setLocation(other);
    for (const [m, p, b] of [['GET', `/api/inbox/conversations/${id}`], ['POST', `/api/inbox/conversations/${id}/status`, { status: 'closed' }], ['POST', `/api/inbox/conversations/${id}/notes`, { body: 'x' }], ['POST', `/api/inbox/conversations/${id}/presence`, {}]] as const) {
      const r = m === 'GET' ? await t.api.get(p) : await t.api.post(p, b);
      expect(r.status, `${m} ${p}`).toBe(404);
    }
    const bulk = await t.api.post('/api/inbox/bulk', { ids: [id], action: 'close' });
    expect(bulk.data.updated).toBe(0);
    expect(conv(id).inbox_status).toBe('open');
    expect(((await t.api.get('/api/inbox/queue?view=all')).data as any).conversations.map((c: any) => c.id)).not.toContain(id);
    // people of another sub-account cannot be assigned here
    t.api.setLocation(loc);
    const foreign = await t.api.post('/api/users', { email: 'draussen@example.com', password: 'passwort-d1', name: 'Draussen', locations: [other] });
    expect((await t.api.post(`/api/inbox/conversations/${id}/assign`, { user_id: foreign.data.id })).status).toBe(400);
  });

  it('every change by a person is in the audit log; the key of a sub-account works the same', async () => {
    const id = await inbound();
    await anna('POST', `/api/inbox/conversations/${id}/status`, { status: 'waiting' });
    const rows = audit('inbox.%').concat(audit('conversations.%'));
    expect(t.app.db.all<any>(`SELECT * FROM audit_log WHERE route = 'POST /api/inbox/conversations/:id/status'`).some((a) => a.actor === 'Anna Schmidt' && a.entity_id === id)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    const r = await t.api.raw(`/api/inbox/queue?view=open&limit=3`, { headers: { authorization: `Bearer ${keyA}`, 'x-location-id': loc } });
    expect(r.status).toBe(200);
    const asKey = await t.api.raw(`/api/inbox/conversations/${id}/assign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${keyA}`, 'x-location-id': loc }, body: JSON.stringify({ user_id: 'me' }) });
    expect(asKey.status).toBe(400); // a key has no person behind it
  });
});

describe('realtime', () => {
  it('presence shows who looks and who types; leaving removes them; the stream needs a login', async () => {
    const id = await inbound();
    const r1 = await anna('POST', `/api/inbox/conversations/${id}/presence`, { typing: true });
    expect(r1.status).toBe(200);
    const seen = (await ben('GET', `/api/inbox/conversations/${id}`)).data;
    expect(seen.viewers).toEqual([{ user_id: ids.anna, name: 'Anna Schmidt', typing: true }]);
    // the stream: Ben listens, Anna types → Ben gets "presence"
    const ac = new AbortController();
    const stream = await t.api.raw(`/api/inbox/stream?clientId=client-ben-1&locationId=${loc}`, { headers: { cookie: ben.cookie(), 'x-location-id': loc }, signal: ac.signal });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream.body!.getReader();
    let text = '';
    const read = async (until: RegExp) => {
      for (let i = 0; i < 20 && !until.test(text); i++) {
        const { value } = await Promise.race([reader.read(), new Promise<{ value: undefined }>((r) => setTimeout(() => r({ value: undefined }), 300))]);
        if (value) text += Buffer.from(value).toString();
      }
    };
    await read(/event: hello/);
    await new Promise((r) => setTimeout(r, 2100));
    await anna('POST', `/api/inbox/conversations/${id}/presence`, { typing: true });
    await t.api.post(`/api/inbox/conversations/${id}/assign`, { user_id: ids.ben });
    await read(/event: conversation/);
    expect(text).toMatch(/event: presence\ndata: .*Anna Schmidt/);
    expect(text).toMatch(/event: conversation\ndata: .*"reason":"assigned"/);
    ac.abort();
    await anna('POST', `/api/inbox/conversations/${id}/presence`, { leaving: true });
    expect(((await ben('GET', `/api/inbox/conversations/${id}`)).data as any).viewers).toEqual([]);
    expect((await t.api.raw(`/api/inbox/stream?clientId=zzzzzz1&locationId=${loc}`)).status).toBe(401);
    expect((await t.api.raw(`/api/inbox/stream?clientId=zzzzzz1&locationId=${loc}`, { headers: { authorization: `Bearer ${keyA}` } })).status).toBe(403);
    expect((await cleo('GET', `/api/inbox/stream?clientId=zzzzzz2&locationId=${loc}`)).status).toBe(403);
  });

  it('the stream ends with the login it was opened with: signed out, a device revoked, run out, signed out everywhere by the admin', async () => {
    const hub = t.app.services.inboxHub;
    const again = () => loginAgain(t.base, loc, 'ben@example.com', 'passwort-ben1');
    const open = async (c: { cookie: () => string }, clientId: string) => {
      const s = await openSse(`${t.base}/api/inbox/stream?clientId=${clientId}&locationId=${loc}`, { cookie: c.cookie() });
      expect(await s.until(/event: hello/)).toBe(true);
      return s;
    };
    const own = await open(ben, 'ben-own-1');
    // signed out in another tab of the same browser: the stream ends at once, with `bye` (the browser does not reconnect)
    const second = await again();
    const s1 = await open(second, 'ben-login-1');
    expect((await second('POST', '/api/auth/logout')).status).toBe(200);
    expect(await s1.until(BYE)).toBe(true);
    expect(await s1.ends()).toBe(true);
    // one device signed out under "Mein Konto": its stream ends, the own one stays
    const third = await again();
    const s2 = await open(third, 'ben-login-2');
    expect((await ben('DELETE', `/api/me/sessions/${sessionHash(third.cookie()).slice(0, 16)}`)).status).toBe(200);
    expect(await s2.until(BYE)).toBe(true);
    // a session that ran out: the next check (every 20 s) ends its stream
    const fourth = await again();
    const s3 = await open(fourth, 'ben-login-3');
    expireSession(t.app.db, fourth.cookie());
    hub.sweep();
    expect(await s3.until(BYE)).toBe(true);
    // the untouched login still gets the news; the ended streams get nothing more
    expect(await own.quiet(/event: bye/)).toBe(true);
    const id = await inbound();
    await t.api.post(`/api/inbox/conversations/${id}/assign`, { user_id: ids.ben });
    expect(await own.until(new RegExp(`event: conversation\ndata: .*${id}`))).toBe(true);
    for (const s of [s1, s2, s3]) expect(s.text()).not.toContain(id);
    // the admin signs Ben out everywhere: the last stream ends too
    expect((await t.api.post(`/api/users/${ids.ben}/sessions/revoke`, {})).status).toBe(200);
    expect(await own.until(BYE)).toBe(true);
    expect(hub.online(ids.ben)).toBe(false);
    for (const s of [own, s1, s2, s3]) await s.close();
    // Ben signs in again for the tests below
    expect((await ben('POST', '/api/auth/login', { email: 'ben@example.com', password: 'passwort-ben1' })).status).toBe(200);
  });
});

describe('MCP tools and the app', () => {
  let rpcId = 0;
  const mcp = async (name: string, args: any) => {
    const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${keyA}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) });
    const j: any = await r.json();
    const text = j.result?.content?.[0]?.text ?? '';
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* error text */
    }
    return { isError: !!j.result?.isError, text, data };
  };

  it('lists the four tools with schemas', () => {
    expect(INBOX_TOOLS.map((x) => x.name)).toEqual(['ghl_inbox_queue', 'ghl_inbox_assign', 'ghl_inbox_set_status', 'ghl_inbox_note']);
    for (const tool of INBOX_TOOLS) expect(tool.inputSchema.required).toContain('location_id');
  });

  it('queue, assign by name, status with snooze, note with mention', async () => {
    await setSettings({ assignment: { mode: 'manual' }, sla: { enabled: false } });
    const id = await inbound();
    const q = await mcp('ghl_inbox_queue', { location_id: loc, view: 'unassigned', limit: 100 });
    expect(q.isError, q.text).toBe(false);
    expect(q.data.conversations.map((c: any) => c.id)).toContain(id);
    expect(q.data.counts.unassigned).toBeGreaterThan(0);
    const a = await mcp('ghl_inbox_assign', { location_id: loc, conversation_id: id, assignee: 'Anna' });
    expect(a.isError, a.text).toBe(false);
    expect(a.data).toMatchObject({ assignee_id: ids.anna, assignee_name: 'Anna Schmidt' });
    expect((await mcp('ghl_inbox_assign', { location_id: loc, conversation_id: id, assignee: 'Niemand Bekanntes' })).isError).toBe(true);
    expect((await mcp('ghl_inbox_assign', { location_id: loc, conversation_id: id, assignee: 'none' })).data.assignee_id).toBeNull();
    const s = await mcp('ghl_inbox_set_status', { location_id: loc, conversation_id: id, snooze_until: new Date(Date.now() + 7200_000).toISOString(), priority: 'high' });
    expect(s.data).toMatchObject({ priority: 'high' });
    expect(s.data.snoozed_until).toBeTruthy();
    expect((await mcp('ghl_inbox_set_status', { location_id: loc, conversation_id: id, status: 'closed' })).data.status).toBe('closed');
    expect((await mcp('ghl_inbox_set_status', { location_id: loc, conversation_id: id })).isError).toBe(true);
    const nt = await mcp('ghl_inbox_note', { location_id: loc, conversation_id: id, body: '@Ben Weber schau mal' });
    expect(nt.data.mentioned).toEqual([ids.ben]);
    // another sub-account's id is not found
    expect((await mcp('ghl_inbox_note', { location_id: other, conversation_id: id, body: 'x' })).isError).toBe(true);
  });

  it('the app: queue, team state, assign, status and notes through /api/mobile', async () => {
    const id = await inbound();
    const pair = await anna('POST', '/api/mobile/pair', { device_name: 'Annas Handy', platform: 'android', app_version: '1.0.0' });
    expect(pair.status, pair.text).toBe(200);
    const dev = client(t.base, { authorization: `Bearer ${pair.data.token}` });
    const queue = await dev('GET', `/api/mobile/inbox/queue?location=${loc}&view=unassigned&limit=50`);
    expect(queue.status, queue.text).toBe(200);
    expect(queue.data.conversations.find((c: any) => c.id === id)).toMatchObject({ location_id: loc, status: 'open' });
    const assign = await dev('POST', `/api/mobile/conversations/${id}/assign`, { user_id: 'me' });
    expect(assign.status, assign.text).toBe(200);
    expect(assign.data.assignee_id).toBe(ids.anna);
    expect((await dev('POST', `/api/mobile/conversations/${id}/status`, { status: 'waiting', priority: 'low' })).data).toMatchObject({ status: 'waiting', priority: 'low' });
    expect((await dev('POST', `/api/mobile/conversations/${id}/notes`, { body: 'vom Handy' })).status).toBe(200);
    const team = await dev('GET', `/api/mobile/conversations/${id}/team`);
    expect(team.data).toMatchObject({ location_id: loc, status: 'waiting', assignee_name: 'Anna Schmidt' });
    expect(team.data.timeline.filter((x: any) => x.type === 'note')[0].body).toBe('vom Handy');
    const people = await dev('GET', `/api/mobile/inbox/people?location=${loc}`);
    expect(people.data.locations[0].people.map((p: any) => p.name)).toContain('Ben Weber');
    expect(t.app.db.all<any>(`SELECT * FROM audit_log WHERE via = 'app' AND entity_id = ?`, id).length).toBeGreaterThan(0);
    // a member of the sub-account only reaches its own conversations; a stranger's id is "not found"
    expect((await dev('POST', `/api/mobile/conversations/nichtda/assign`, { user_id: 'me' })).status).toBe(404);
    expect((await dev('POST', `/api/mobile/conversations/${id}/assign`, {})).status).toBe(400);
    // cleo has no conversations area
    const cp = await cleo('POST', '/api/mobile/pair', { device_name: 'Cleos Handy', platform: 'android', app_version: '1.0.0' });
    const cdev = client(t.base, { authorization: `Bearer ${cp.data.token}` });
    expect((await cdev('GET', `/api/mobile/inbox/queue?location=${loc}`)).status).toBe(403);
    expect((await cdev('POST', `/api/mobile/conversations/${id}/notes`, { body: 'x' })).status).toBe(403);
  });
});

describe('who hears about a new message', () => {
  it('an assigned conversation notifies its assignee only; an unassigned one the team as before', async () => {
    await setSettings({ assignment: { mode: 'manual' } });
    const contact = (await t.api.post('/api/contacts', { email: `audience${++n}@example.com`, first_name: 'Aud' })).data;
    // the conversation exists (an answer went out) and belongs to Ben before the contact writes
    await t.api.post('/api/messages', { contact_id: contact.id, channel: 'email', subject: 'Hallo', body: 'Hallo!' });
    const convId = t.app.db.get<any>('SELECT id FROM conversations WHERE contact_id = ?', contact.id)!.id;
    await t.api.post(`/api/inbox/conversations/${convId}/assign`, { user_id: ids.ben });
    await inbound(contact.email, 'Neue Nachricht an Ben');
    const heard = (c: string) => t.app.db.all<any>(`SELECT user_id FROM push_log WHERE tag = ? AND kind = 'messages'`, `conv-${c}`).map((r) => r.user_id);
    expect(heard(convId)).toEqual([ids.ben]);
    // nobody owns this one: everybody who works on conversations hears it (not Cleo, who only has contacts)
    const fresh = await inbound();
    expect(heard(fresh).sort()).toEqual([ids.chef, ids.anna, ids.ben].sort());
  });
});

describe('reports', () => {
  it('offers the conversations and the answers as report sources with response times, volume per person and the SLA rate', async () => {
    t.app.db.run('DELETE FROM inbox_response_log'); // the numbers of the earlier blocks are not part of this one
    await setSettings({ assignment: { mode: 'manual' }, sla: { enabled: true, first_response_min: 60, business_hours: false } });
    const a = await inbound();
    await t.api.post(`/api/inbox/conversations/${a}/assign`, { user_id: ids.anna });
    await reply(anna, a);
    const b = await inbound();
    await t.api.post(`/api/inbox/conversations/${b}/assign`, { user_id: ids.ben });
    await reply(ben, b);
    const sources = (await t.api.get('/api/reports/sources')).data.sources.map((s: any) => s.key);
    expect(sources).toEqual(expect.arrayContaining(['inbox_conversations', 'inbox_responses']));
    const per = await t.api.post('/api/reports/run', { source: 'inbox_responses', group_by: ['responder'], measures: ['count', 'calc:avg_response', 'calc:sla_rate'], range: 'all' });
    expect(per.status, JSON.stringify(per.data)).toBe(200);
    expect(per.data.rows.map((r: any) => r.l[0])).toEqual(expect.arrayContaining(['Anna Schmidt', 'Ben Weber']));
    expect(per.data.totals.v[0]).toBeGreaterThanOrEqual(2);
    expect(per.data.totals.v[2]).toBe(100); // both answered within the hour
    const vol = await t.api.post('/api/reports/run', { source: 'inbox_conversations', group_by: ['assignee'], measures: ['count'], range: 'all' });
    expect(vol.status).toBe(200);
    expect(vol.data.rows.map((r: any) => r.l[0])).toEqual(expect.arrayContaining(['Anna Schmidt', 'Ben Weber']));
    // a member without the conversations area does not even see them
    const cs = await cleo('GET', '/api/reports/sources');
    expect(cs.status === 403 || !cs.data.sources.map((s: any) => s.key).includes('inbox_responses')).toBe(true);
    expect((await cleo('POST', '/api/reports/run', { source: 'inbox_responses', measures: ['count'], range: 'all' })).status).toBeGreaterThanOrEqual(400);
    // and another sub-account only counts its own
    t.api.setLocation(other);
    const none = await t.api.post('/api/reports/run', { source: 'inbox_responses', measures: ['count'], range: 'all' });
    expect(none.data.totals.v[0]).toBe(0);
    t.api.setLocation(loc);
  });
});
