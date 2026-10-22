import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pinClock, startTestApp, unpinClock } from './helpers.js';
import type { AppEvent } from '../server/core/events.js';
import { requiredPermission } from '../server/core/permissions.js';
import { client } from './security-fixtures.js';
import { DEFAULT_DIALER, applyDisposition, callingWindow, cleanDialerSettings, dialVerdict, pickNext, type QueueItem, type Window } from '../server/services/dialer.js';

const SID = `AC${'0'.repeat(31)}1`;
const TOKEN = 'f'.repeat(32);
const TWILIO_NUMBER = '+4930123456';
const MOBILE = '+4915112345678';
const TZ = 'Europe/Berlin';
const MONDAY_10 = '2026-10-05T08:00:00Z';

const requests: { url: string; method: string; body: URLSearchParams }[] = [];
let callCounter = 700;
const callSid = (n: number) => `CA${String(n).padStart(32, '0')}`;
const fakeTwilio = (async (input: any, init: any = {}) => {
  const url = String(input);
  requests.push({ url, method: init.method ?? 'GET', body: new URLSearchParams(init.body ?? '') });
  const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  const path = url.replace(`https://api.twilio.com/2010-04-01/Accounts/${SID}`, '');
  if (path === '/Calls.json' && init.method === 'POST') return json({ sid: callSid(++callCounter), status: 'queued' }, 201);
  if (path.startsWith('/Calls.json?ParentCallSid=')) return json({ calls: [{ sid: callSid(999) }] });
  if (/^\/Calls\/CA\d{32}\.json$/.test(path) && init.method === 'POST') return json({ sid: path.slice(7, 41), status: 'in-progress' });
  return json({ message: 'not found' }, 404);
}) as unknown as typeof fetch;

describe('calling window (pure)', () => {
  const s = { ...DEFAULT_DIALER, from: '09:00', to: '19:00' };
  it('is open on working days within the hours, in the sub-account timezone', () => {
    expect(callingWindow(s, TZ, new Date(MONDAY_10)).open).toBe(true);
    expect(callingWindow(s, TZ, new Date('2026-10-05T16:59:00Z')).open).toBe(true); // 18:59
    expect(callingWindow(s, TZ, new Date('2026-10-05T17:00:00Z'))).toMatchObject({ open: false, reason: 'Anrufzeit endete um 19:00 Uhr' }); // 19:00
    expect(callingWindow(s, TZ, new Date('2026-10-05T06:30:00Z'))).toMatchObject({ open: false, reason: 'Anrufzeit beginnt um 09:00 Uhr', next: '2026-10-05T07:00:00.000Z' });
  });
  it('skips weekends and public holidays and says when it opens next', () => {
    const sat = callingWindow(s, TZ, new Date('2026-10-10T09:00:00Z'));
    expect(sat.open).toBe(false);
    expect(sat.reason).toContain('Wochentag');
    expect(sat.next).toBe('2026-10-12T07:00:00.000Z'); // Monday 09:00
    const holiday = callingWindow(s, TZ, new Date('2026-12-25T09:00:00Z'));
    expect(holiday).toMatchObject({ open: false });
    expect(holiday.reason).toContain('Feiertag (1. Weihnachtstag)');
    expect(holiday.next).toBe('2026-12-28T08:00:00.000Z');
    // Fronleichnam only counts with the right state.
    expect(callingWindow({ ...s, holiday_state: 'BY' }, TZ, new Date('2026-06-04T09:00:00Z')).open).toBe(false);
    expect(callingWindow({ ...s, holiday_state: 'BE' }, TZ, new Date('2026-06-04T09:00:00Z')).open).toBe(true);
    // With holidays switched off only the weekday rule counts (25 Dec 2026 is a Friday).
    expect(callingWindow({ ...s, skip_holidays: false }, TZ, new Date('2026-12-25T09:00:00Z')).open).toBe(true);
  });
});

describe('may this contact be called (pure)', () => {
  const open: Window = { open: true, reason: '', next: null };
  const base = { phone: MOBILE, dnd: false, channelDnd: '', consent: { allow: true, reason: '', confirmed: true }, consentPolicy: 'ledger' as const, attempts: 0, maxAttempts: 3, notBefore: '', window: open };
  it('checks in a fixed order and names the first reason', () => {
    expect(dialVerdict(base)).toEqual({ ok: true, code: '', reason: '' });
    expect(dialVerdict({ ...base, phone: '' })).toMatchObject({ ok: false, code: 'no_phone' });
    expect(dialVerdict({ ...base, dnd: true, window: { open: false, reason: 'x', next: null } })).toMatchObject({ code: 'dnd' });
    expect(dialVerdict({ ...base, channelDnd: 'Kontakt hat „Nicht stören“ für Anrufe' })).toMatchObject({ code: 'dnd', reason: 'Kontakt hat „Nicht stören“ für Anrufe' });
    expect(dialVerdict({ ...base, consent: { allow: false, reason: 'Einwilligung widerrufen', confirmed: false } })).toMatchObject({ code: 'consent', reason: 'Einwilligung widerrufen' });
    expect(dialVerdict({ ...base, window: { open: false, reason: 'Heute ist nicht angerufen: Feiertag (Neujahr)', next: null } })).toMatchObject({ code: 'hours', reason: expect.stringContaining('Neujahr') });
    expect(dialVerdict({ ...base, attempts: 3 })).toMatchObject({ code: 'attempts' });
    expect(dialVerdict({ ...base, notBefore: new Date(Date.now() + 60_000).toISOString() })).toMatchObject({ code: 'recent' });
  });
  it('the strict rule needs a confirmed consent (and the module)', () => {
    expect(dialVerdict({ ...base, consentPolicy: 'strict', consent: { allow: true, reason: '', confirmed: false } })).toMatchObject({ code: 'consent', reason: expect.stringContaining('bestätigte') });
    expect(dialVerdict({ ...base, consentPolicy: 'strict' }).ok).toBe(true);
    expect(dialVerdict({ ...base, consentPolicy: 'strict', consent: null })).toMatchObject({ code: 'consent' });
    expect(dialVerdict({ ...base, consent: null }).ok).toBe(true);
  });
});

describe('the queue (pure)', () => {
  const item = (id: string, o: Partial<QueueItem> = {}): QueueItem => ({ id, status: 'pending', position: Number(id.replace(/\D/g, '')) || 0, next_at: null, callback_user: null, locked_by: null, locked_until: null, ...o });
  const at = new Date('2026-10-05T08:00:00Z');
  it('offers due callbacks first (the own ones before others), then due retries, then fresh entries in list order', () => {
    const items = [
      item('i3'),
      item('i1', { next_at: '2026-10-05T07:00:00.000Z' }), // a retry that is due
      item('i2', { status: 'callback', next_at: '2026-10-05T07:30:00.000Z', callback_user: 'u2' }),
      item('i4', { status: 'callback', next_at: '2026-10-05T07:45:00.000Z', callback_user: 'u1' }),
      item('i5', { status: 'callback', next_at: '2026-10-05T07:50:00.000Z' }),
      item('i6', { status: 'callback', next_at: '2026-10-05T09:00:00.000Z' }), // not due yet
    ];
    expect(pickNext(items, 'u1', at)?.id).toBe('i4');
    expect(pickNext(items.filter((i) => i.id !== 'i4'), 'u1', at)?.id).toBe('i5'); // somebody else's callback (u2) is not u1's
    expect(pickNext(items.filter((i) => !['i4', 'i5'].includes(i.id)), 'u1', at)?.id).toBe('i1');
    expect(pickNext(items.filter((i) => ['i3', 'i6'].includes(i.id)), 'u1', at)?.id).toBe('i3');
  });
  it('skips entries another person works on, done and blocked ones, and retries that are not due', () => {
    const later = '2026-10-05T10:00:00.000Z';
    const items = [item('i1', { locked_by: 'u2', locked_until: later }), item('i2', { status: 'done' }), item('i3', { status: 'blocked' }), item('i4', { next_at: later }), item('i5')];
    expect(pickNext(items, 'u1', at)?.id).toBe('i5');
    expect(pickNext([items[0]], 'u2', at)?.id).toBe('i1'); // the own lock is no obstacle
    expect(pickNext(items.slice(0, 4), 'u1', at)).toBeUndefined();
  });
  it('applies an outcome: final, callback, retry with a pause, and the last attempt', () => {
    const d = (kind: 'retry' | 'callback' | 'final') => ({ key: 'x', label: 'X', kind, positive: false, dnd: false, tag: '' });
    const o = { attempts: 0, maxAttempts: 3, retryMinutes: 120, at };
    expect(applyDisposition(d('final'), o)).toEqual({ status: 'done', attempts: 1, next_at: null, exhausted: false });
    expect(applyDisposition(d('callback'), { ...o, callbackAt: '2026-10-06T09:00:00.000Z' })).toMatchObject({ status: 'callback', next_at: '2026-10-06T09:00:00.000Z' });
    expect(applyDisposition(d('retry'), o)).toEqual({ status: 'pending', attempts: 1, next_at: '2026-10-05T10:00:00.000Z', exhausted: false });
    expect(applyDisposition(d('retry'), { ...o, attempts: 2 })).toEqual({ status: 'done', attempts: 3, next_at: null, exhausted: true });
  });
  it('validates the settings', () => {
    const cur = DEFAULT_DIALER;
    expect(cleanDialerSettings({ days: ['mon', 'sat', 'x'], from: '08:00', to: '20:00', max_attempts: 5 }, cur)).toMatchObject({ days: ['mon', 'sat'], from: '08:00', to: '20:00', max_attempts: 5 });
    expect(() => cleanDialerSettings({ days: [] }, cur)).toThrow(/Wochentag/);
    expect(() => cleanDialerSettings({ from: '20:00', to: '09:00' }, cur)).toThrow(/Ende der Anrufzeit/);
    expect(() => cleanDialerSettings({ holiday_state: 'XX' }, cur)).toThrow(/Bundesland/);
    expect(() => cleanDialerSettings({ consent_policy: 'egal' }, cur)).toThrow(/Einwilligungsregel/);
    expect(() => cleanDialerSettings({ dispositions: [{ key: 'ok', label: 'OK', kind: 'final' }] }, cur)).toThrow(/nicht mehr anrufen/);
    expect(() => cleanDialerSettings({ dispositions: [{ key: 'A b', label: 'x', kind: 'final', dnd: true }] }, cur)).toThrow(/Schlüssel/);
    expect(cleanDialerSettings({ dispositions: [{ key: 'stop', label: 'Stop', kind: 'final', dnd: true }, { key: 'hot', label: 'Heiß', kind: 'final', positive: true, tag: 'heiss' }] }, cur).dispositions).toHaveLength(2);
  });
});

describe('power dialer', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  let loc = '';
  const events: AppEvent[] = [];
  const ids: Record<string, string> = {};
  let listId = '';
  let itemOf: Record<string, string> = {};

  const next = async (userId?: string) => (await t.api.post(`/api/dialer/lists/${listId}/next`, {})).data;
  const items = async () => (await t.api.get(`/api/dialer/lists/${listId}/items?limit=100`)).data as any[];

  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
    loc = t.api.location;
    t.app.services.twilioFetch = fakeTwilio;
    t.app.events.on('*', (e) => void events.push(e));
    await t.api.put('/api/telephony/settings', { account_sid: SID, auth_token: TOKEN, numbers: TWILIO_NUMBER, forward_to: MOBILE, hours_mode: 'always' });
    const mk = async (key: string, body: any) => (ids[key] = (await t.api.post('/api/contacts', body)).data.id);
    await mk('anna', { first_name: 'Anna', last_name: 'Alt', phone: '0170 1111111', tags: ['lead'] });
    await mk('ben', { first_name: 'Ben', phone: '0170 2222222', tags: ['lead'] });
    await mk('nophone', { first_name: 'Ohne', email: 'ohne@example.com', tags: ['lead'] });
    await mk('dnd', { first_name: 'Dana', phone: '0170 3333333', tags: ['lead'], dnd: true });
    await mk('revoked', { first_name: 'Rita', phone: '0170 4444444', tags: ['lead'] });
    await mk('chris', { first_name: 'Chris', phone: '0170 5555555', tags: ['lead'] });
    await mk('other', { first_name: 'Fremd', phone: '0170 6666666', tags: ['kunde'] });
    // Rita withdrew her consent for calls.
    expect((await t.api.post(`/api/contacts/${ids.revoked}/consent`, { action: 'revoked', channel: 'phone' })).status).toBeLessThan(300);
    const sl = (await t.api.post('/api/smart-lists', { name: 'Leads', filter: { tags: ['lead'] } })).data;
    ids.smart = sl.id;
    pinClock(MONDAY_10);
  });
  afterAll(async () => {
    unpinClock();
    await t.close();
  });

  it('builds a call list from a smart list: only people with a number, nothing twice', async () => {
    const r = await t.api.post('/api/dialer/lists', { name: 'Herbst-Leads', source: 'smart_list', smart_list_id: ids.smart });
    expect(r.status).toBe(200);
    listId = r.data.id;
    expect(r.data.sync).toMatchObject({ added: 5, no_phone: 1, total: 5 });
    expect(r.data.counts).toMatchObject({ total: 5, pending: 5 });
    itemOf = Object.fromEntries((await items()).map((i: any) => [i.name, i.id]));
    expect(Object.keys(itemOf).sort()).toEqual(['Anna Alt', 'Ben', 'Chris', 'Dana', 'Rita']);
    // A list is worked in the order of its source (newest contact first); the tests below need a fixed one.
    ['Anna Alt', 'Ben', 'Dana', 'Rita', 'Chris'].forEach((n, i) => t.app.db.run('UPDATE dialer_items SET position = ? WHERE id = ?', i + 1, itemOf[n]));
    // A new matching contact joins on "aktualisieren"; the others stay as they are.
    const late = (await t.api.post('/api/contacts', { first_name: 'Spät', phone: '0170 7777777', tags: ['lead'] })).data.id;
    ids.late = late;
    expect((await t.api.post(`/api/dialer/lists/${listId}/sync`)).data).toMatchObject({ added: 1, total: 6 });
    expect((await t.api.post('/api/dialer/lists', { name: 'x', source: 'smart_list', smart_list_id: 'fremd' })).status).toBe(400);
    expect((await t.api.post('/api/dialer/lists', { name: 'x', source: 'tags', tags: [] })).status).toBe(400);
    const manual = await t.api.post('/api/dialer/lists', { name: 'Auswahl', source: 'manual', contact_ids: [ids.anna, ids.nophone, 'gibtsnicht'] });
    expect(manual.data.sync).toMatchObject({ added: 1, no_phone: 1 });
    const byTags = await t.api.post('/api/dialer/lists', { name: 'Kunden', source: 'tags', tags: ['kunde'] });
    expect(byTags.data.counts.total).toBe(1);
  });

  it('offers the next callable contact and blocks the ones the rules forbid – with the reason', async () => {
    const first = await next();
    expect(first.item.contact).toMatchObject({ name: 'Anna Alt', phone: '+491701111111' });
    expect(first.item).toMatchObject({ attempts: 0, max_attempts: 3 });
    // Asking again without finishing gives the same entry back; skipping sends it to the end of the list.
    expect((await next()).item.id).toBe(first.item.id);
    await t.api.post(`/api/dialer/items/${first.item.id}/skip`);
    const second = await next();
    expect(second.item.contact.name).toBe('Ben');
    await t.api.post(`/api/dialer/items/${second.item.id}/skip`);
    // Dana ("Nicht stören") and Rita (consent withdrawn) are marked on the way; Chris is next.
    expect((await next()).item.contact.name).toBe('Chris');
    const after = await items();
    expect(after.find((i) => i.name === 'Dana')).toMatchObject({ status: 'blocked', blocked_reason: expect.stringContaining('Nicht stören') });
    expect(after.find((i) => i.name === 'Rita')).toMatchObject({ status: 'blocked', blocked_reason: expect.stringContaining('widerrufen') });
    // Another person is not offered the entry Chris is locked to.
    const other = await t.api.post(`/api/dialer/lists/${listId}/next`, {}, {});
    expect(other.data.item.contact.name).toBe('Chris'); // (the same login here – the lock is per person)
  });

  it('gives two people different contacts and refuses a call to an entry somebody else works on', async () => {
    await t.api.post('/api/users', { email: 'bea@example.com', password: 'passwort-b1', name: 'Bea', locations: [loc] });
    const bea = client(t.base, { 'x-pghl': '1', 'x-location-id': loc });
    expect((await bea('POST', '/api/auth/login', { email: 'bea@example.com', password: 'passwort-b1' })).status).toBe(200);
    const r = await bea('POST', `/api/dialer/lists/${listId}/next`, {});
    expect(r.data.item.contact.name).not.toBe('Chris'); // locked to the first person
    expect((await bea('POST', '/api/calls', { contact_id: ids.chris, dialer_item_id: itemOf['Chris'] })).data.error).toContain('jemand anderem');
    expect((await bea('POST', `/api/dialer/items/${itemOf['Chris']}/dial`)).data.error).toContain('jemand anderem');
    await bea('POST', `/api/dialer/items/${r.data.item.id}/skip`, {});
  });

  it('refuses the call itself on the server – click-to-call included – when the rules say no', async () => {
    // Dana: "Nicht stören".
    const danaItem = itemOf['Dana'];
    expect((await t.api.post(`/api/dialer/items/${danaItem}/dial`)).data.error).toContain('Nicht stören');
    const blocked = await t.api.post('/api/calls', { contact_id: ids.dnd, dialer_item_id: danaItem });
    expect(blocked.status).toBe(400);
    expect(blocked.data.error).toContain('Nicht stören');
    expect(t.app.db.get('SELECT COUNT(*) n FROM calls WHERE contact_id = ?', ids.dnd)!.n).toBe(0);
    expect((await t.api.post('/api/calls', { contact_id: ids.anna, dialer_item_id: 'gibtsnicht' })).data.error).toContain('nicht gefunden');
  });

  it('places the call for an allowed entry and ties it to the list entry', async () => {
    const annaItem = itemOf['Anna Alt'];
    const d = (await t.api.post(`/api/dialer/items/${annaItem}/dial`)).data;
    expect(d).toMatchObject({ ok: true, contact_id: ids.anna, number: '+491701111111' });
    requests.length = 0;
    const r = await t.api.post('/api/calls', { contact_id: ids.anna, dialer_item_id: annaItem });
    expect(r.status).toBe(200);
    expect(t.app.db.get('SELECT dialer_item_id FROM calls WHERE id = ?', r.data.id)!.dialer_item_id).toBe(annaItem);
    ids.annaCall = r.data.id;
  });

  it('an outcome ends the attempt: not reached waits two hours, then comes back; the third miss ends the entry', async () => {
    const annaItem = itemOf['Anna Alt'];
    const r = await t.api.post(`/api/dialer/items/${annaItem}/disposition`, { code: 'no_answer', note: 'Mailbox ohne Ansage', call_id: ids.annaCall });
    expect(r.data.item).toMatchObject({ status: 'pending', attempts: 1, disposition: 'no_answer' });
    // The clock keeps running after it was set: two hours after "now".
    expect(Math.abs(Date.parse(r.data.item.next_at) - Date.parse('2026-10-05T10:00:00Z'))).toBeLessThan(10_000);
    expect(t.app.db.get('SELECT disposition FROM calls WHERE id = ?', ids.annaCall)!.disposition).toBe('no_answer');
    expect(t.app.db.get('SELECT body FROM notes WHERE contact_id = ?', ids.anna)!.body).toContain('Mailbox ohne Ansage');
    await t.app.events.flush();
    expect(events.find((e) => e.type === 'dialer.disposition')!.data).toMatchObject({ contactId: ids.anna, disposition: 'no_answer', label: 'Nicht erreicht', attempts: 1 });
    expect((await t.api.post(`/api/dialer/items/${annaItem}/disposition`, { code: 'gibtsnicht' })).status).toBe(400);
    // Two hours later Anna is due again (and goes before fresh entries); two more misses use up the attempts.
    pinClock('2026-10-05T10:05:00Z');
    expect((await next()).item.contact.name).toBe('Anna Alt');
    await t.api.post(`/api/dialer/items/${annaItem}/disposition`, { code: 'busy' });
    pinClock('2026-10-05T12:10:00Z');
    expect((await next()).item.contact.name).toBe('Anna Alt');
    const last = await t.api.post(`/api/dialer/items/${annaItem}/disposition`, { code: 'no_answer' });
    expect(last.data.item).toMatchObject({ status: 'done', attempts: 3 });
    expect((await items()).find((i) => i.name === 'Anna Alt')).toMatchObject({ status: 'done', blocked_reason: 'Nach 3 Versuchen nicht erreicht' });
    pinClock(MONDAY_10);
  });

  it('a callback becomes a task for the person and is offered first once it is due', async () => {
    const ben = itemOf['Ben'];
    expect((await t.api.post(`/api/dialer/items/${ben}/disposition`, { code: 'callback' })).data.error).toContain('Datum und Uhrzeit');
    expect((await t.api.post(`/api/dialer/items/${ben}/disposition`, { code: 'callback', callback_at: '2020-01-01T10:00:00Z' })).data.error).toContain('Vergangenheit');
    const me = (await t.api.get('/api/me')).data.user.id;
    const r = await t.api.post(`/api/dialer/items/${ben}/disposition`, { code: 'callback', callback_at: '2026-10-06T07:00:00Z', callback_user: me, note: 'Nach dem Urlaub' });
    expect(r.data.item).toMatchObject({ status: 'callback', next_at: '2026-10-06T07:00:00.000Z' });
    const task = t.app.db.get('SELECT * FROM tasks WHERE contact_id = ? AND title LIKE ?', ids.ben, 'Rückruf:%')!;
    expect(task).toMatchObject({ assigned_to: me, due_at: '2026-10-06T07:00:00.000Z', done: 0 });
    expect(task.description).toContain('Nach dem Urlaub');
    expect((await t.api.get('/api/dialer/callbacks')).data).toEqual([expect.objectContaining({ name: 'Ben', due: false, user_id: me })]);
    // Not due yet: Chris is next. The next morning Ben comes first.
    expect((await next()).item.contact.name).toBe('Chris');
    pinClock('2026-10-06T07:30:00Z');
    expect((await next()).item.contact.name).toBe('Ben');
    expect((await t.api.get('/api/dialer/callbacks?mine=1')).data[0]).toMatchObject({ due: true });
    // Another outcome replaces the open task.
    await t.api.post(`/api/dialer/items/${ben}/disposition`, { code: 'booked', note: 'Termin Donnerstag' });
    expect(t.app.db.get('SELECT COUNT(*) n FROM tasks WHERE contact_id = ? AND title LIKE ?', ids.ben, 'Rückruf:%')!.n).toBe(0);
    expect(t.app.db.get('SELECT tags FROM contacts WHERE id = ?', ids.ben)!.tags).toContain('termin-vereinbart');
    pinClock(MONDAY_10);
  });

  it('"nicht mehr anrufen" withdraws the phone consent and stops every open entry of the contact', async () => {
    const other = (await t.api.post('/api/dialer/lists', { name: 'Zweite', source: 'manual', contact_ids: [ids.chris] })).data.id;
    const chris = itemOf['Chris'];
    await t.api.post(`/api/dialer/items/${chris}/disposition`, { code: 'do_not_call', note: 'Bitte nie wieder' });
    const state = (await t.api.get(`/api/contacts/${ids.chris}/consent`)).data;
    expect(JSON.stringify(state)).toContain('revoked');
    const secondItem = t.app.db.get('SELECT * FROM dialer_items WHERE list_id = ?', other)!;
    expect(secondItem).toMatchObject({ status: 'blocked', blocked_reason: 'Will nicht mehr angerufen werden' });
    expect((await t.api.post(`/api/calls`, { contact_id: ids.chris, dialer_item_id: secondItem.id })).status).toBe(400);
    // Re-checking the list does not bring the contact back while the withdrawal stands.
    await t.api.post(`/api/dialer/lists/${listId}/sync`);
    expect((await items()).find((i) => i.name === 'Chris')).toMatchObject({ status: 'done' });
  });

  it('keeps to calling hours, days and holidays', async () => {
    pinClock('2026-10-05T17:30:00Z'); // 19:30, after the hours
    const late = await next();
    expect(late).toMatchObject({ item: null, waiting: true });
    expect(late.reason).toContain('Anrufzeit endete um 19:00 Uhr');
    pinClock('2026-10-10T09:00:00Z'); // Saturday
    expect((await next()).reason).toContain('Wochentag');
    await t.api.put('/api/dialer/settings', { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'] });
    expect((await next()).waiting).not.toBe(true);
    await t.api.put('/api/dialer/settings', { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] });
    expect((await next()).waiting).not.toBe(true); // Saturday is fine now; holidays are covered by the pure tests above
    // A call placed outside the hours is refused on the server as well.
    pinClock('2026-10-05T17:30:00Z');
    await t.api.put('/api/dialer/settings', { days: ['mon', 'tue', 'wed', 'thu', 'fri'], skip_holidays: true });
    const late2 = t.app.db.get('SELECT * FROM dialer_items WHERE list_id = ? AND contact_id = ?', listId, ids.late)!;
    const refused = await t.api.post('/api/calls', { contact_id: late2.contact_id, dialer_item_id: late2.id });
    expect(refused.data.error).toContain('Außerhalb der Anrufzeiten');
    pinClock(MONDAY_10);
  });

  it('the strict rule only calls contacts with a confirmed phone consent', async () => {
    await t.api.put('/api/dialer/settings', { consent_policy: 'strict' });
    const sync = await t.api.post(`/api/dialer/lists/${listId}/sync`);
    expect(sync.status).toBe(200);
    const r = await next();
    expect(r.item).toBeNull();
    expect(await items()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Spät', status: 'blocked', blocked_reason: expect.stringContaining('bestätigte') })]));
    // A confirmed consent (the person said yes) and a refresh bring the contact back.
    await t.api.post(`/api/contacts/${ids.late}/consent`, { action: 'granted', channel: 'phone', purposes: ['marketing'], note: 'Am Telefon zugestimmt' });
    expect((await t.api.post(`/api/dialer/lists/${listId}/sync`)).data.released).toBe(1);
    expect((await next()).item.contact.name).toBe('Spät');
    await t.api.put('/api/dialer/settings', { consent_policy: 'ledger' });
  });

  it('leaves a pre-recorded message on the voicemail with one click', async () => {
    const noDrop = await t.api.post(`/api/dialer/calls/${ids.annaCall}/drop`, {});
    expect(noDrop.status).toBe(400);
    // A short WAV as the message.
    const wav = Buffer.alloc(44 + 1600);
    wav.write('RIFF', 0, 'latin1');
    wav.writeUInt32LE(36 + 1600, 4);
    wav.write('WAVEfmt ', 8, 'latin1');
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24);
    wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36, 'latin1');
    wav.writeUInt32LE(1600, 40);
    const up = await t.api.raw(`/api/telephony/audio?name=${encodeURIComponent('Nachricht Herbst')}&kind=drop&locationId=${loc}`, { method: 'POST', headers: { cookie: t.api.cookie, 'content-type': 'audio/wav', 'x-pghl': '1' }, body: wav });
    const drop = (await up.json()) as any;
    expect(up.status, JSON.stringify(drop)).toBe(200);
    expect(drop).toMatchObject({ kind: 'drop', mime: 'audio/wav' });
    // A call to Spät is running (click-to-call: his phone answered, the child leg is the contact).
    const spaet = t.app.db.get('SELECT * FROM dialer_items WHERE contact_id = ?', ids.late)!;
    const call = (await t.api.post('/api/calls', { contact_id: ids.late, dialer_item_id: spaet.id })).data;
    requests.length = 0;
    const r = await t.api.post(`/api/dialer/calls/${call.id}/drop`, { drop_id: drop.id });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const lookup = requests.find((x) => x.url.includes('ParentCallSid='))!;
    expect(lookup.url).toContain(call.sid);
    const upd = requests.find((x) => x.url.endsWith(`/Calls/${callSid(999)}.json`))!;
    expect(upd.method).toBe('POST');
    expect(upd.body.get('Twiml')).toBe(`<?xml version="1.0" encoding="UTF-8"?><Response><Play>${drop.url}</Play><Hangup/></Response>`);
    expect(r.data.item).toMatchObject({ disposition: 'voicemail_drop', attempts: 1, status: 'pending' });
    expect(t.app.db.get('SELECT disposition FROM calls WHERE id = ?', call.id)!.disposition).toBe('voicemail_drop');
    expect(t.app.db.get('SELECT summary FROM activities WHERE contact_id = ? AND type = ?', ids.late, 'call.voicemail_drop')!.summary).toContain('Nachricht Herbst');
    // The audio file cannot be removed while a list uses it, and only drops are accepted as messages.
    const l2 = await t.api.patch(`/api/dialer/lists/${listId}`, { drop_id: drop.id });
    expect(l2.data.drop_id).toBe(drop.id);
    expect((await t.api.patch(`/api/dialer/lists/${listId}`, { drop_id: 'weg' })).status).toBe(400);
    const stats = (await t.api.get('/api/dialer/stats?days=7')).data;
    expect(stats.calls).toBeGreaterThanOrEqual(2);
    expect(stats.dispositions.map((d: any) => d.key)).toEqual(expect.arrayContaining(['voicemail_drop']));
  });

  it('keeps its routes in the right areas and refuses another sub-account\'s entries', async () => {
    expect(requiredPermission('POST', '/api/dialer/lists/x/next')).toBe('conversations');
    expect(requiredPermission('PUT', '/api/dialer/settings')).toBe('settings');
    expect((await t.api.post('/api/dialer/items/gibtsnicht/disposition', { code: 'busy' })).status).toBe(404);
    expect((await t.api.get('/api/dialer/lists/gibtsnicht')).status).toBe(404);
    expect((await t.api.del(`/api/dialer/lists/${listId}`)).data.ok).toBe(true);
    expect(t.app.db.get('SELECT COUNT(*) n FROM dialer_items WHERE list_id = ?', listId)!.n).toBe(0);
  });
});
