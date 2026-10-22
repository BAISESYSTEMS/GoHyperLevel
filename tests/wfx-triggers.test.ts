import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cronFires, cronMatches, diffContact, fieldChangeMatches, fromWallMinute, monthDaysForToday, parseCron, wallMinute } from '../server/services/wfx-triggers.js';
import { setStripeFetch, signStripePayload } from '../server/services/stripe.js';
import { signVisitor, VISITOR_COOKIE } from '../server/services/attribution.js';
import { wallClock } from '../server/services/formatters.js';
import { triggerMatches } from '../server/services/workflow-engine.js';
import { newApp, readRun, type T } from './wfx-helpers.js';

/** The additional triggers: pure helpers first, then each trigger end to end with a moved clock. */

describe('cron', () => {
  it('reads cron expressions and refuses nonsense in German', () => {
    expect(parseCron('0 9 * * 1-5').dow).toEqual(new Set([1, 2, 3, 4, 5]));
    expect([...parseCron('*/15 * * * *').minute]).toEqual([0, 15, 30, 45]);
    expect([...parseCron('0 8,12,18 * * *').hour]).toEqual([8, 12, 18]);
    expect([...parseCron('0 0 1 jan,jul *').month]).toEqual([1, 7]);
    expect(parseCron('0 9 * * MON-FRI').dow.has(5)).toBe(true);
    expect(parseCron('0 9 * * 7').dow.has(0)).toBe(true);
    expect(parseCron('@daily').source).toBe('0 0 * * *');
    expect(() => parseCron('0 9 * *')).toThrow(/fünf Felder/);
    expect(() => parseCron('61 9 * * *')).toThrow(/Minute/);
    expect(() => parseCron('0 25 * * *')).toThrow(/Stunde/);
    expect(() => parseCron('0 9 32 * *')).toThrow(/Tag/);
    expect(() => parseCron('0 9 * 13 *')).toThrow(/Monat/);
    expect(() => parseCron('0 9 * * 9')).toThrow(/Wochentag/);
    expect(() => parseCron('*/0 * * * *')).toThrow(/Schrittweite/);
    expect(() => parseCron('5-1 * * * *')).toThrow(/rückwärts/);
    expect(() => parseCron('a b c d e')).toThrow();
  });

  it('matches wall-clock minutes (day of month OR weekday when both are set)', () => {
    const c = parseCron('30 9 * * 1-5');
    expect(cronMatches(c, { y: 2026, mo: 11, d: 2, h: 9, mi: 30 })).toBe(true); // Monday
    expect(cronMatches(c, { y: 2026, mo: 11, d: 1, h: 9, mi: 30 })).toBe(false); // Sunday
    expect(cronMatches(c, { y: 2026, mo: 11, d: 2, h: 9, mi: 31 })).toBe(false);
    const either = parseCron('0 0 13 * 5'); // the 13th OR any Friday
    expect(cronMatches(either, { y: 2026, mo: 11, d: 13, h: 0, mi: 0 })).toBe(true);
    expect(cronMatches(either, { y: 2026, mo: 11, d: 6, h: 0, mi: 0 })).toBe(true);
    expect(cronMatches(either, { y: 2026, mo: 11, d: 4, h: 0, mi: 0 })).toBe(false);
  });

  const berlin = (iso: string) => wallMinute(wallClock(new Date(iso), 'Europe/Berlin'));
  it('fires a 02:30 job right after the spring gap and only once in the autumn double hour', () => {
    const c = parseCron('30 2 * * *');
    // 2026-03-29: clocks jump from 02:00 to 03:00 (01:00Z). From 01:59 CET to 03:00 CEST the wall minutes 02:00–02:59 are skipped.
    const before = berlin('2026-03-29T00:59:00Z'); // 01:59 CET
    const after = berlin('2026-03-29T01:00:00Z'); // 03:00 CEST
    const fires = cronFires(c, before, after);
    expect(fires).toHaveLength(1);
    expect(fromWallMinute(fires[0])).toMatchObject({ d: 29, h: 2, mi: 30 });
    // 2026-10-25: 03:00 CEST becomes 02:00 CET. The wall clock shows 02:30 twice (00:30Z and 01:30Z).
    let n = 0;
    let prev = berlin('2026-10-24T22:00:00Z');
    for (let t = Date.parse('2026-10-24T22:01:00Z'); t <= Date.parse('2026-10-25T03:00:00Z'); t += 60_000) {
      const w = berlin(new Date(t).toISOString());
      n += cronFires(c, prev, w).length;
      prev = Math.max(prev, w);
    }
    expect(n).toBe(1);
    // an ordinary day: exactly one fire between two checks 15 s apart that straddle the minute
    expect(cronFires(c, berlin('2026-05-05T00:29:50Z'), berlin('2026-05-05T00:30:05Z'))).toHaveLength(1);
  });
});

describe('field changes', () => {
  it('diffs standard and custom fields', () => {
    const before = { first_name: 'Erika', city: 'Köln', dnd: 0, custom: { status: 'offen', stufe: '1' } };
    const after = { first_name: 'Erika', city: 'Bonn', dnd: 1, custom: { status: 'bezahlt', neu: 'x' } };
    const d = diffContact(before, after);
    expect(d).toEqual(expect.arrayContaining([
      { field: 'city', old: 'Köln', new: 'Bonn' },
      { field: 'dnd', old: '0', new: '1' },
      { field: 'custom.status', old: 'offen', new: 'bezahlt' },
      { field: 'custom.stufe', old: '1', new: '' },
      { field: 'custom.neu', old: '', new: 'x' },
    ]));
    expect(d).toHaveLength(5);
    expect(diffContact({ dnd: 0 }, { dnd: '0' })).toEqual([]);
  });

  it('filters by field, old and new value', () => {
    const d = { field: 'custom.status', old: 'Offen', new: 'bezahlt' };
    expect(fieldChangeMatches({}, d)).toBe(true);
    expect(fieldChangeMatches({ field: '*' }, d)).toBe(true);
    expect(fieldChangeMatches({ field: 'custom.status', from: 'offen', to: 'BEZAHLT' }, d)).toBe(true);
    expect(fieldChangeMatches({ field: 'custom.status', to: 'offen' }, d)).toBe(false);
    expect(fieldChangeMatches({ field: 'city' }, d)).toBe(false);
    expect(fieldChangeMatches({ to_empty: true }, d)).toBe(false);
    expect(fieldChangeMatches({ to_empty: true }, { field: 'x', old: 'a', new: '' })).toBe(true);
  });

  it('counts 29 February as 28 February in other years', () => {
    expect(monthDaysForToday('2026-02-28')).toEqual(['02-28', '02-29']);
    expect(monthDaysForToday('2028-02-28')).toEqual(['02-28']);
    expect(monthDaysForToday('2026-03-01')).toEqual(['03-01']);
  });
});

describe('triggers end to end', () => {
  let t: T;
  let loc = '';
  const events: { type: string; data: any }[] = [];
  beforeAll(async () => {
    t = await newApp();
    loc = t.api.location;
    for (const type of ['field.changed', 'contact.owner_changed', 'appointment.noshow', 'appointment.cancelled', 'appointment.rescheduled', 'payment.failed', 'event.custom', 'page.visited']) t.app.events.on(type, (e) => void events.push({ type, data: e.data }));
  });
  afterAll(() => t.close());
  afterEach(() => {
    delete t.app.services.wfxNow;
  });
  const at = (iso: string) => (t.app.services.wfxNow = () => Date.parse(iso));
  const scans = async () => {
    await t.app.services.wfxRunScans();
    await t.app.events.flush();
  };
  const mk = async (trigger: { type: string; config?: Record<string, unknown> }, steps: any[] = [{ type: 'set_variable', rows: [{ name: 'ran', value: 'ja' }] }], settings: Record<string, unknown> = {}) => {
    const r = await t.api.post('/api/workflows', { name: `t ${trigger.type} ${Math.random()}`, trigger: { type: trigger.type, config: trigger.config ?? {} }, steps, settings });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    await t.api.patch(`/api/workflows/${r.data.id}`, { status: 'active' });
    return r.data as any;
  };
  const runs = (wfId: string) => t.app.db.all('SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY created_at', wfId).map((r: any) => ({ ...r, vars: JSON.parse(r.vars), event: JSON.parse(r.event), log: JSON.parse(r.log) }));
  const contact = async (c: Record<string, unknown> = {}) => (await t.api.post('/api/contacts', { first_name: 'Erika', email: `e${Math.random().toString(36).slice(2, 9)}@example.com`, ...c })).data;

  it('offers every new trigger in the editor list with a label and sample', async () => {
    const meta = (await t.api.get('/api/workflows/meta')).data;
    const cat = (await t.api.get('/api/workflow-catalog?kind=triggers')).data;
    for (const type of ['field.changed', 'contact.birthday', 'contact.anniversary', 'schedule.cron', 'form.abandoned', 'page.visited', 'payment.failed', 'payment.refunded', 'product.subscription_ended', 'appointment.noshow', 'appointment.rescheduled', 'appointment.cancelled', 'appointment.starts_soon', 'task.overdue', 'conversation.unanswered', 'invoice.overdue', 'event.custom', 'contact.owner_changed']) {
      expect(meta.triggers, type).toContain(type);
      const m = cat.triggers.find((x: any) => x.type === type);
      expect(m?.label, type).toBeTruthy();
      expect(m?.sample, type).toBeTruthy();
    }
  });

  it('starts on "Feld geändert" with old and new value, from the API and from forms', async () => {
    const wf = await mk({ type: 'field.changed', config: { field: 'custom.status', to: 'bezahlt' } }, [{ type: 'add_note', body: '{{event.field}}: {{event.old}} → {{event.new}}' }], { allow_reentry: true });
    const c = await contact({ custom: { status: 'offen' } });
    await t.api.patch(`/api/contacts/${c.id}`, { custom: { status: 'in Prüfung' } });
    await t.app.events.flush();
    expect(runs(wf.id)).toHaveLength(0); // other value: filtered
    await t.api.patch(`/api/contacts/${c.id}`, { custom: { status: 'bezahlt' }, city: 'Köln' });
    await t.app.events.flush();
    expect(runs(wf.id)).toHaveLength(1);
    expect(t.app.db.get('SELECT body FROM notes WHERE contact_id = ?', c.id)!.body).toBe('custom.status: in Prüfung → bezahlt');
    // the same value again is no change
    await t.api.patch(`/api/contacts/${c.id}`, { custom: { status: 'bezahlt' } });
    await t.app.events.flush();
    expect(events.filter((e) => e.type === 'field.changed' && e.data.contactId === c.id && e.data.field === 'custom.status')).toHaveLength(2);
    // an upsert (form/import) counts too
    await t.api.post('/api/contacts', { email: c.email, custom: { status: 'offen' } });
    await t.api.post('/api/contacts', { email: c.email, custom: { status: 'bezahlt' } });
    await t.app.events.flush();
    expect(runs(wf.id)).toHaveLength(2);
  });

  it('a workflow that changes a field does not trigger itself, but can trigger another one (depth-limited)', async () => {
    const self = await mk({ type: 'field.changed', config: { field: 'custom.zaehler' } }, [{ type: 'math', operation: 'add', a: '{{contact.custom.zaehler}}', b: '1', save_to: 'custom.zaehler' }], { allow_reentry: true });
    const c = await contact();
    await t.api.patch(`/api/contacts/${c.id}`, { custom: { zaehler: '1' } });
    await t.app.events.flush();
    const mine = runs(self.id).filter((r: any) => r.contact_id === c.id);
    expect(mine).toHaveLength(1); // started by the edit, its own change did not start it again
    expect(JSON.parse(t.app.db.get('SELECT custom FROM contacts WHERE id = ?', c.id)!.custom).zaehler).toBe('2');
    // A and B change each other's field: stops at the depth limit instead of looping for ever
    const a = await mk({ type: 'field.changed', config: { field: 'custom.a' } }, [{ type: 'math', operation: 'add', a: '{{contact.custom.b}}', b: '1', save_to: 'custom.b' }], { allow_reentry: true });
    const b = await mk({ type: 'field.changed', config: { field: 'custom.b' } }, [{ type: 'math', operation: 'add', a: '{{contact.custom.a}}', b: '1', save_to: 'custom.a' }], { allow_reentry: true });
    const d = await contact();
    await t.api.patch(`/api/contacts/${d.id}`, { custom: { a: '1' } });
    for (let i = 0; i < 8; i++) await t.app.events.flush();
    const total = runs(a.id).length + runs(b.id).length;
    expect(total).toBeGreaterThanOrEqual(2);
    expect(total).toBeLessThanOrEqual(8);
  });

  it('fires "Zuständiger geändert"', async () => {
    const wf = await mk({ type: 'contact.owner_changed' });
    const c = await contact();
    const me = (await t.api.get('/api/me')).data.user.id;
    await t.api.patch(`/api/contacts/${c.id}`, { assigned_to: me });
    await t.app.events.flush();
    expect(runs(wf.id).filter((r: any) => r.contact_id === c.id)).toHaveLength(1);
  });

  it('starts on custom events from the API, with the name filter and from a workflow step', async () => {
    const any = await mk({ type: 'event.custom' }, [{ type: 'set_variable', rows: [{ name: 'nr', value: '{{event.bestellnummer}}' }] }]);
    const only = await mk({ type: 'event.custom', config: { name: 'Bestellung Versendet' } });
    const c = await contact();
    const r = await t.api.post('/api/custom-events', { name: 'Bestellung Versendet', contact_id: c.id, data: { bestellnummer: 'B-1' } });
    expect(r.data).toMatchObject({ ok: true, name: 'bestellung_versendet', contactId: c.id });
    await t.app.events.flush();
    expect(runs(any.id)[0].vars.nr).toBe('B-1');
    expect(runs(only.id)).toHaveLength(1);
    const other = await contact();
    await t.api.post('/api/custom-events', { name: 'etwas_anderes', email: other.email });
    await t.app.events.flush();
    expect(runs(only.id).filter((x: any) => x.contact_id === other.id)).toHaveLength(0);
    expect(runs(any.id).filter((x: any) => x.contact_id === other.id)).toHaveLength(1);
    // by e-mail, creating the contact on request; errors
    expect((await t.api.post('/api/custom-events', { name: 'x', email: 'neu-event@example.com' })).status).toBe(404);
    expect((await t.api.post('/api/custom-events', { name: 'x', email: 'neu-event@example.com', create: true })).status).toBe(200);
    expect((await t.api.post('/api/custom-events', { name: '', contact_id: c.id })).status).toBe(400);
    expect((await t.api.post('/api/custom-events', { name: 'x' })).status).toBe(400);
    expect((await t.api.post('/api/custom-events', { name: 'x', contact_id: 'nope' })).status).toBe(404);
    // the workflow step
    const emitter = await mk({ type: 'manual' }, [{ type: 'emit_event', name: 'aus_workflow', data: '{"n": 5}' }]);
    const chained = await mk({ type: 'event.custom', config: { name: 'aus_workflow' } }, [{ type: 'set_variable', rows: [{ name: 'n', value: '{{event.n}}' }] }]);
    const e = await contact();
    await t.api.post(`/api/workflows/${emitter.id}/enroll`, { contact_ids: [e.id] });
    await t.app.events.flush();
    expect(runs(chained.id)[0].vars.n).toBe(5);
  });

  it('uses the generic filters on any trigger (fields, event data, expression)', async () => {
    const wf = await mk({ type: 'contact.created', config: { filters: [{ field: 'city', op: 'equals', value: 'Köln' }, { field: 'tag', op: 'has', value: 'vip' }], filters_match: 'all' } });
    const expr = await mk({ type: 'event.custom', config: { name: 'kauf', filter_expression: 'number(event.summe) >= 100 && contains(contact.email, "@firma.de")' } });
    const yes = await contact({ city: 'Köln', tags: ['vip'] });
    const no = await contact({ city: 'Bonn', tags: ['vip'] });
    await t.app.events.flush();
    expect(runs(wf.id).map((r: any) => r.contact_id)).toEqual([yes.id]);
    void no;
    const big = await contact({ email: 'k1@firma.de' });
    const small = await contact({ email: 'k2@firma.de' });
    const wrong = await contact({ email: 'k3@gmail.com' });
    for (const [c, summe] of [[big, 250], [small, 20], [wrong, 500]] as const) await t.api.post('/api/custom-events', { name: 'kauf', contact_id: c.id, data: { summe } });
    await t.app.events.flush();
    expect(runs(expr.id).map((r: any) => r.contact_id)).toEqual([big.id]);
    // a broken expression never starts anything
    const broken = await mk({ type: 'event.custom', config: { name: 'kaputt', filter_expression: '1 +' } });
    await t.api.post('/api/custom-events', { name: 'kaputt', contact_id: big.id });
    await t.app.events.flush();
    expect(runs(broken.id)).toHaveLength(0);
  });

  it('filters review triggers by minimum and maximum stars', () => {
    const e = (rating: number) => ({ locationId: 'l', type: 'review.received', data: { rating }, at: '' });
    const trig = { type: 'review.received', config: { min_rating: 4, max_rating: 5 } };
    expect(triggerMatches(trig, e(5))).toBe(true);
    expect(triggerMatches(trig, e(4))).toBe(true);
    expect(triggerMatches(trig, e(3))).toBe(false);
    expect(triggerMatches({ type: 'review.received', config: { min_rating: 5 } }, e(4))).toBe(false);
    expect(triggerMatches({ type: 'review.received', config: { max_rating: 3 } }, e(1))).toBe(true);
  });

  it('derives no-show, cancelled and rescheduled from appointments', async () => {
    const cal = (await t.api.post('/api/calendars', { name: 'Beratung' })).data;
    const c = await contact();
    const noshow = await mk({ type: 'appointment.noshow', config: { calendar_id: cal.id } });
    const cancelled = await mk({ type: 'appointment.cancelled' });
    const moved = await mk({ type: 'appointment.rescheduled' }, [{ type: 'set_variable', rows: [{ name: 'alt', value: '{{event.previousStart}}' }, { name: 'neu', value: '{{appointment.start_at}}' }] }]);
    const start = new Date(Date.now() + 5 * 864e5).toISOString();
    const appt = (await t.api.post('/api/appointments', { calendar_id: cal.id, contact_id: c.id, start, force: true })).data;
    expect(appt.id).toBeTruthy();
    await t.api.patch(`/api/appointments/${appt.id}`, { start: new Date(Date.parse(start) + 864e5).toISOString() });
    await t.app.events.flush();
    expect(runs(moved.id)).toHaveLength(1);
    expect(runs(moved.id)[0].vars.alt).toBe(start);
    await t.api.patch(`/api/appointments/${appt.id}`, { status: 'noshow' });
    await t.app.events.flush();
    expect(runs(noshow.id)).toHaveLength(1);
    expect(runs(cancelled.id)).toHaveLength(0);
    const second = (await t.api.post('/api/appointments', { calendar_id: cal.id, contact_id: (await contact()).id, start, force: true })).data;
    await t.api.patch(`/api/appointments/${second.id}`, { status: 'cancelled' });
    await t.app.events.flush();
    expect(runs(cancelled.id)).toHaveLength(1);
    expect(runs(noshow.id)).toHaveLength(1);
    // a wrong calendar does not match
    const other = (await t.api.post('/api/calendars', { name: 'Anderer' })).data;
    const third = (await t.api.post('/api/appointments', { calendar_id: other.id, contact_id: (await contact()).id, start: new Date(Date.parse(start) + 3600e3).toISOString(), force: true })).data;
    await t.api.patch(`/api/appointments/${third.id}`, { status: 'noshow' });
    await t.app.events.flush();
    expect(runs(noshow.id)).toHaveLength(1);
  });

  it('starts "Termin beginnt bald" once per appointment', async () => {
    at('2026-11-02T08:00:00Z');
    const cal = (await t.api.post('/api/calendars', { name: 'Bald' })).data;
    const c = await contact();
    const wf = await mk({ type: 'appointment.starts_soon', config: { minutes_before: 60, calendar_id: cal.id } }, [{ type: 'set_variable', rows: [{ name: 'min', value: '{{event.minutesToStart}}' }] }]);
    t.app.db.insert('appointments', { id: 'ap-soon', location_id: loc, calendar_id: cal.id, contact_id: c.id, title: 'Test', start_at: '2026-11-02T08:50:00.000Z', end_at: '2026-11-02T09:20:00.000Z', status: 'confirmed', notes: '', source: 'x', manage_token: 'tok-soon', reminder_sent: 0, created_at: new Date().toISOString() });
    t.app.db.insert('appointments', { id: 'ap-late', location_id: loc, calendar_id: cal.id, contact_id: c.id, title: 'Später', start_at: '2026-11-02T12:00:00.000Z', end_at: '2026-11-02T12:30:00.000Z', status: 'confirmed', notes: '', source: 'x', manage_token: 'tok-late', reminder_sent: 0, created_at: new Date().toISOString() });
    await scans();
    expect(runs(wf.id)).toHaveLength(1);
    expect(runs(wf.id)[0].vars.min).toBe(50);
    await scans();
    expect(runs(wf.id)).toHaveLength(1);
  });

  it('starts "Aufgabe überfällig" (announced by the planner) once per task, only for tasks with a contact that are still open', async () => {
    const c = await contact();
    const wf = await mk({ type: 'task.overdue', config: {} }, [{ type: 'add_note', body: 'Überfällig: {{event.task.title}}' }], { allow_reentry: true });
    await t.api.post('/api/tasks', { contact_id: c.id, title: 'Angebot nachfassen', due_at: '2026-11-02T09:00:00.000Z' });
    await t.api.post('/api/tasks', { contact_id: c.id, title: 'Noch nicht fällig', due_at: '2026-11-02T11:30:00.000Z' });
    await t.api.post('/api/tasks', { title: 'Ohne Kontakt', due_at: '2026-11-02T09:00:00.000Z' });
    const done = (await t.api.post('/api/tasks', { contact_id: c.id, title: 'Schon erledigt', due_at: '2026-11-02T09:00:00.000Z' })).data;
    await t.api.patch(`/api/tasks/${done.id}`, { done: true });
    const at10 = new Date('2026-11-02T10:00:00Z');
    t.app.services.pmScan.overdue(at10);
    await t.app.events.flush();
    expect(t.app.db.all('SELECT body FROM notes WHERE contact_id = ?', c.id).map((n: any) => n.body)).toEqual(['Überfällig: Angebot nachfassen']);
    t.app.services.pmScan.overdue(at10);
    await t.app.events.flush();
    expect(t.app.db.all('SELECT body FROM notes WHERE contact_id = ?', c.id)).toHaveLength(1);
    expect(runs(wf.id)).toHaveLength(1);
  });

  it('starts "Nachricht unbeantwortet" only when the last message is the contact\'s and old enough', async () => {
    at('2026-11-02T10:00:00Z');
    const waiting = await contact();
    const answered = await contact();
    const fresh = await contact();
    const wf = await mk({ type: 'conversation.unanswered', config: { minutes: 60 } }, [{ type: 'set_variable', rows: [{ name: 'min', value: '{{event.minutes}}' }, { name: 'text', value: '{{event.message.body}}' }] }]);
    const mkConv = (c: any, msgs: [string, string, string][]) => {
      const cid = `cv-${c.id}`;
      t.app.db.insert('conversations', { id: cid, location_id: loc, contact_id: c.id, unread: 1, last_message_at: msgs[msgs.length - 1][2], created_at: msgs[0][2] });
      msgs.forEach(([dir, body, when], i) => t.app.db.insert('messages', { id: `m-${c.id}-${i}`, location_id: loc, conversation_id: cid, contact_id: c.id, channel: 'email', direction: dir, subject: '', body, status: dir === 'in' ? 'received' : 'sent', error: '', source: 'x', created_at: when }));
    };
    mkConv(waiting, [['in', 'Haben Sie Zeit?', '2026-11-02T08:30:00.000Z']]);
    mkConv(answered, [['in', 'Frage', '2026-11-02T08:00:00.000Z'], ['out', 'Antwort', '2026-11-02T08:20:00.000Z']]);
    mkConv(fresh, [['in', 'Neu', '2026-11-02T09:50:00.000Z']]);
    await scans();
    expect(runs(wf.id).map((r: any) => r.contact_id)).toEqual([waiting.id]);
    expect(runs(wf.id)[0].vars).toMatchObject({ min: 90, text: 'Haben Sie Zeit?' });
    at('2026-11-02T11:00:00Z');
    await scans();
    expect(runs(wf.id).map((r: any) => r.contact_id).sort()).toEqual([waiting.id, fresh.id].sort());
    await scans();
    expect(runs(wf.id)).toHaveLength(2);
  });

  it('starts "Rechnung überfällig" for sent, unpaid invoices past their due date', async () => {
    at('2026-11-10T10:00:00Z');
    const c = await contact();
    const wf = await mk({ type: 'invoice.overdue', config: { days_overdue: 3 } }, [{ type: 'set_variable', rows: [{ name: 'nr', value: '{{event.invoice.number}}' }, { name: 'tage', value: '{{event.daysOverdue}}' }] }]);
    const inv = (n: string, status: string, due: string) => t.app.db.insert('invoices', { id: `inv-${n}`, location_id: loc, kind: 'invoice', number: n, contact_id: c.id, title: '', items: '[]', currency: 'EUR', subtotal_cents: 100, tax_cents: 0, total_cents: 100, status, notes: '', public_token: `tok-${n}`, issued_at: due, due_at: due, created_at: due, updated_at: due });
    inv('X-1', 'sent', '2026-11-05T00:00:00.000Z');
    inv('X-2', 'sent', '2026-11-09T00:00:00.000Z');
    inv('X-3', 'paid', '2026-11-01T00:00:00.000Z');
    await scans();
    const r = runs(wf.id);
    expect(r).toHaveLength(1);
    expect(r[0].vars).toMatchObject({ nr: 'X-1', tage: 5 });
  });

  it('starts birthdays once a year at the chosen time in the sub-account time zone, with an offset', async () => {
    const day = await contact({ date_of_birth: '1990-11-02' });
    const german = await contact({ date_of_birth: '02.11.1985' });
    const leap = await contact({ date_of_birth: '2000-02-29' });
    const before = await contact({ date_of_birth: '1992-11-05' });
    const wf = await mk({ type: 'contact.birthday', config: { time: '09:00' } }, [{ type: 'set_variable', rows: [{ name: 'age', value: '{{event.age}}' }] }]);
    const wf3 = await mk({ type: 'contact.birthday', config: { offset_days: -3, time: '09:00' } });
    // 08:30 Berlin (07:30Z): not yet
    at('2026-11-02T07:30:00Z');
    await scans();
    expect(runs(wf.id)).toHaveLength(0);
    // 09:05 Berlin
    at('2026-11-02T08:05:00Z');
    await scans();
    expect(runs(wf.id).map((r: any) => [r.contact_id, r.vars.age]).sort()).toEqual([[day.id, 36], [german.id, 41]].sort());
    expect(runs(wf3.id).map((r: any) => r.contact_id)).toEqual([before.id]); // three days before the 5th
    await scans();
    expect(runs(wf.id)).toHaveLength(2);
    // 29 February is celebrated on the 28th in 2026 (no leap year)
    at('2026-02-28T09:30:00Z');
    await scans();
    expect(runs(wf.id).map((r: any) => r.contact_id)).toContain(leap.id);
    // next year the same contact runs through again
    at('2027-11-02T09:30:00Z');
    await scans();
    expect(runs(wf.id).filter((r: any) => r.contact_id === day.id)).toHaveLength(2);
  });

  it('starts anniversaries ("Kunde seit") from the creation date, at least N years', async () => {
    const old = await contact();
    const fresh = await contact();
    t.app.db.run('UPDATE contacts SET created_at = ? WHERE id = ?', '2023-11-02T08:00:00.000Z', old.id);
    t.app.db.run('UPDATE contacts SET created_at = ? WHERE id = ?', '2026-11-02T08:00:00.000Z', fresh.id);
    const wf = await mk({ type: 'contact.anniversary', config: { time: '09:00' } }, [{ type: 'set_variable', rows: [{ name: 'jahre', value: '{{event.years}}' }] }]);
    at('2026-11-02T10:00:00Z');
    await scans();
    const r = runs(wf.id).filter((x: any) => x.contact_id === old.id || x.contact_id === fresh.id);
    expect(r.map((x: any) => [x.contact_id, x.vars.jahre])).toEqual([[old.id, 3]]);
  });

  it('runs the schedule for matching contacts once per scheduled minute, in slices, with limits', async () => {
    const a = await contact({ tags: ['news'] });
    const b = await contact({ tags: ['news'] });
    const x = await contact({ tags: ['news', 'stopp'] });
    const wf = await mk({ type: 'schedule.cron', config: { cron: '0 9 * * 1-5', tags: ['news'], exclude_tags: ['stopp'] } }, [{ type: 'set_variable', rows: [{ name: 'k', value: '{{event.schedule_key}}' }] }]);
    // first look at the schedule only notes the time: nothing runs retroactively
    at('2026-11-02T07:59:30Z'); // 08:59:30 Berlin, Monday
    await scans();
    expect(runs(wf.id)).toHaveLength(0);
    at('2026-11-02T08:00:10Z'); // 09:00:10
    await scans();
    const done = runs(wf.id).filter((r: any) => [a.id, b.id, x.id].includes(r.contact_id));
    expect(done.map((r: any) => r.contact_id).sort()).toEqual([a.id, b.id].sort());
    expect(done[0].vars.k).toBe('2026-11-02T09:00');
    expect(done[0].event.scheduled_for).toBe('2026-11-02T08:00:00.000Z');
    await scans();
    expect(runs(wf.id).filter((r: any) => r.contact_id === a.id)).toHaveLength(1);
    // Saturday 09:00 does not match
    at('2026-11-07T08:00:10Z');
    await scans();
    expect(runs(wf.id).filter((r: any) => r.contact_id === a.id)).toHaveLength(1);
    // with re-entry and a cap
    const again = await mk({ type: 'schedule.cron', config: { cron: '*/10 * * * *', tags: ['news'], max: 1 } }, [{ type: 'set_variable', rows: [{ name: 'k', value: '1' }] }], { allow_reentry: true });
    at('2026-11-09T10:00:05Z');
    await scans();
    at('2026-11-09T10:10:05Z');
    await scans();
    expect(runs(again.id)).toHaveLength(1);
    expect(runs(again.id)[0].contact_id).toBeTruthy();
    // a catch-up of only ten minutes: a long pause does not replay old minutes
    at('2026-11-10T10:00:05Z');
    await scans();
    expect(runs(again.id).length).toBeLessThanOrEqual(2);
  });

  it('handles an invalid schedule quietly and refuses it only when it is used', async () => {
    const wf = await mk({ type: 'schedule.cron', config: { cron: 'kaputt' } });
    at('2026-11-02T08:00:10Z');
    await scans();
    expect(runs(wf.id)).toHaveLength(0);
  });

  it('abandoned forms: stored only while a workflow listens, never for submitted forms, contact found or created quietly', async () => {
    const form = (await t.api.post('/api/forms', { name: 'Kontakt', fields: [{ name: 'email', label: 'E-Mail', type: 'email', required: true }, { name: 'first_name', label: 'Vorname', type: 'text' }] })).data;
    const beacon = (body: Record<string, unknown>) => t.api.raw(`/api/public/forms/${form.id}/partial`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    // nobody listens yet
    expect(await beacon({ email: 'vorab@example.com' })).toEqual({ ok: true, tracked: false });
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM wfx_form_partials')!.n).toBe(0);
    const created: string[] = [];
    t.app.events.on('contact.created', (e) => void created.push(e.data.contactId));
    const wf = await mk({ type: 'form.abandoned', config: { form_id: form.id, minutes: 30 } }, [{ type: 'set_variable', rows: [{ name: 'mail', value: '{{event.partial.email}}' }, { name: 'form', value: '{{event.form.name}}' }] }]);
    at('2026-11-02T10:00:00Z');
    expect(await beacon({ email: 'Abbruch@Example.com', first_name: 'Anna', zusatz: 'ignoriert' })).toEqual({ ok: true, tracked: true });
    expect(await beacon({ email: 'kaputt' })).toEqual({ ok: true, tracked: false });
    expect(await beacon({ email: 'fertig@example.com' })).toMatchObject({ tracked: true });
    const stored = t.app.db.all('SELECT data FROM wfx_form_partials').map((r: any) => JSON.parse(r.data));
    expect(stored.find((d: any) => d.email === 'abbruch@example.com')).toEqual({ email: 'abbruch@example.com', first_name: 'Anna' });
    // someone submits properly
    await t.api.raw(`/api/public/forms/${form.id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'fertig@example.com' }) });
    await t.app.events.flush();
    // known contact stays untouched
    const known = await contact({ email: 'bekannt@example.com', first_name: 'Bernd' });
    await beacon({ email: 'bekannt@example.com', first_name: 'Anders' });
    const before = created.length;
    await scans(); // 0 minutes later: not yet
    expect(runs(wf.id)).toHaveLength(0);
    at('2026-11-02T10:31:00Z');
    t.app.db.run('UPDATE wfx_form_partials SET last_at = ?', '2026-11-02T10:00:00.000Z');
    await scans();
    const r = runs(wf.id);
    expect(r).toHaveLength(2); // Anna (new) and Bernd (known); the one who submitted is excluded
    const anna = t.app.db.get(`SELECT * FROM contacts WHERE email = 'abbruch@example.com'`)!;
    expect(JSON.parse(anna.tags)).toContain('formular-abgebrochen');
    expect(created.length).toBe(before); // no "Kontakt angelegt" workflow for the quiet create
    expect(t.app.db.get('SELECT first_name FROM contacts WHERE id = ?', known.id)!.first_name).toBe('Bernd');
    expect(r.find((x: any) => x.contact_id === anna.id)!.vars).toMatchObject({ mail: 'abbruch@example.com', form: 'Kontakt' });
    await scans();
    expect(runs(wf.id)).toHaveLength(2);
    // the form page carries the beacon script
    const page = await (await t.api.raw(`/f/${form.id}`)).text();
    expect(page).toContain('/partial');
  });

  it('starts "Seite besucht" for contacts the visitor cookie identifies', async () => {
    const c = await contact();
    const hook = [...t.app.services.pageVisit].pop();
    const vid = 'visitorid00000001';
    t.app.db.run(`INSERT INTO attribution_visitors (location_id, visitor_id, contact_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`, loc, vid, c.id, new Date().toISOString(), new Date().toISOString());
    const wf = await mk({ type: 'page.visited', config: { path_contains: '/preise' } }, [{ type: 'set_variable', rows: [{ name: 'seite', value: '{{event.page.name}}' }] }]);
    const ctx = (path: string, cookie?: string) => ({ cookies: cookie ? { [VISITOR_COOKIE]: cookie } : {}, url: new URL(`http://x${path}`) });
    const funnel = { id: 'fn1', name: 'Mein Funnel', location_id: loc };
    hook(ctx('/p/mein-funnel/preise', signVisitor(t.app.config.secret, vid)), funnel, { id: 'pg1', name: 'Preise', path: '/preise' }, '<html></html>');
    hook(ctx('/p/mein-funnel/start', signVisitor(t.app.config.secret, vid)), funnel, { id: 'pg2', name: 'Start', path: '/start' }, '<html></html>');
    hook(ctx('/p/mein-funnel/preise'), funnel, { id: 'pg1', name: 'Preise', path: '/preise' }, '<html></html>'); // unknown visitor
    hook(ctx('/p/mein-funnel/preise', signVisitor(t.app.config.secret, vid)), funnel, { id: 'pg1', name: 'Preise', path: '/preise' }, '<html></html>'); // within 30 minutes
    await t.app.events.flush();
    expect(runs(wf.id)).toHaveLength(1);
    expect(runs(wf.id)[0].vars.seite).toBe('Preise');
    expect(events.filter((e) => e.type === 'page.visited' && e.data.contactId === c.id)).toHaveLength(2);
  });
});

describe('Stripe: payment failed, refunded, subscription ended', () => {
  const KEY = 'sk_test_51FakeKeyForTests000abcd';
  const WHSEC = 'whsec_testSigningSecret0000000';
  let t: T;
  let loc = '';
  const seen: { type: string; data: any }[] = [];
  const fake = (async (url: string, init: any) => {
    const u = new URL(url);
    const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/v1/account') return json({ id: 'acct_1', settings: { dashboard: { display_name: 'Test' } }, charges_enabled: true });
    return json({ error: { message: 'unknown' } }, 404);
  }) as any;
  beforeAll(async () => {
    setStripeFetch(fake);
    t = await newApp();
    loc = t.api.location;
    await t.api.put('/api/stripe', { secret_key: KEY, webhook_secret: WHSEC });
    for (const type of ['payment.failed', 'payment.refunded', 'product.subscription_ended']) t.app.events.on(type, (e) => void seen.push({ type, data: e.data }));
  });
  afterAll(async () => {
    setStripeFetch();
    await t.close();
  });
  const hook = async (event: any) => {
    const raw = JSON.stringify(event);
    const r = await t.api.raw(`/hooks/stripe/${loc}`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(raw, WHSEC) }, body: raw });
    await t.app.events.flush();
    return r.json() as Promise<any>;
  };

  it('fires payment.failed for a failed invoice payment and for a failed subscription renewal', async () => {
    const c = (await t.api.post('/api/contacts', { first_name: 'Zora', email: 'zora@example.com' })).data;
    const prod = (await t.api.post('/api/products', { name: 'Abo', price_cents: 1000, tax_rate: 0, recurring: 'month' })).data;
    t.app.db.run(`INSERT INTO stripe_checkouts (id, location_id, kind, product_id, contact_id, mode, amount_cents, currency, status, email, subscription, created_at) VALUES ('cs_x', ?, 'product', ?, ?, 'subscription', 1000, 'EUR', 'paid', 'zora@example.com', 'sub_9', ?)`, loc, prod.id, c.id, new Date().toISOString());
    const meta = { location_id: loc, product_id: prod.id };
    const r = await hook({ id: 'evt_f1', type: 'invoice.payment_failed', data: { object: { id: 'in_f1', amount_due: 1000, currency: 'eur', attempt_count: 2, parent: { subscription_details: { subscription: 'sub_9', metadata: meta } } } } });
    expect(r.handled).toBe('payment_failed');
    expect(seen.filter((s) => s.type === 'payment.failed')[0].data).toMatchObject({ contactId: c.id, productId: prod.id, amount_cents: 1000, attempt: 2, subscription: 'sub_9' });
    // another sub-account's metadata is ignored
    expect((await hook({ id: 'evt_f2', type: 'invoice.payment_failed', data: { object: { id: 'in_f2', parent: { subscription_details: { subscription: 'sub_9', metadata: { location_id: 'other' } } } } } })).handled).toBe('ignored');
    // a workflow with the product filter
    const wf = await t.api.post('/api/workflows', { name: 'Mahnung', trigger: { type: 'payment.failed', config: { product_id: prod.id } }, steps: [{ type: 'add_note', body: 'Zahlung fehlgeschlagen: {{event.amount_cents}}' }] });
    expect(wf.status).toBe(200);
    await t.api.patch(`/api/workflows/${wf.data.id}`, { status: 'active' });
    await hook({ id: 'evt_f3', type: 'invoice.payment_failed', data: { object: { id: 'in_f3', amount_due: 1000, currency: 'eur', parent: { subscription_details: { subscription: 'sub_9', metadata: meta } } } } });
    expect(t.app.db.all('SELECT body FROM notes WHERE contact_id = ?', c.id).map((n: any) => n.body)).toEqual(['Zahlung fehlgeschlagen: 1000']);
  });

  it('fires payment.failed for a failed async invoice payment', async () => {
    const c = (await t.api.post('/api/contacts', { first_name: 'Yan', email: 'yan@example.com' })).data;
    const inv = (await t.api.post('/api/invoices', { contact_id: c.id, items: [{ name: 'Leistung', qty: 1, price_cents: 5000 }] })).data;
    const before = seen.filter((s) => s.type === 'payment.failed').length;
    await hook({ id: 'evt_a1', type: 'checkout.session.async_payment_failed', data: { object: { id: 'cs_a1', metadata: { location_id: loc, invoice_id: inv.id }, payment_status: 'unpaid' } } });
    const got = seen.filter((s) => s.type === 'payment.failed').slice(before);
    expect(got).toHaveLength(1);
    expect(got[0].data).toMatchObject({ contactId: c.id, invoiceId: inv.id, reason: 'async_payment_failed' });
  });

  it('trigger filters know the product and full refunds', async () => {
    const { triggerMatches } = await import('../server/services/workflow-engine.js');
    const f = t.app.services.workflowTriggerFilters;
    const e = (type: string, data: any) => ({ locationId: 'l', type, data, at: '' });
    expect(triggerMatches({ type: 'payment.refunded', config: { full_only: true } }, e('payment.refunded', { full: false }), f)).toBe(false);
    expect(triggerMatches({ type: 'payment.refunded', config: { full_only: true } }, e('payment.refunded', { full: true }), f)).toBe(true);
    expect(triggerMatches({ type: 'payment.refunded', config: { product_id: 'p2' } }, e('payment.refunded', { productId: 'p1' }), f)).toBe(false);
    expect(triggerMatches({ type: 'product.subscription_ended', config: { product_id: 'p1' } }, e('product.subscription_ended', { productId: 'p1' }), f)).toBe(true);
  });
});
void readRun;
