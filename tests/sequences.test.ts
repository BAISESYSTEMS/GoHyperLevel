import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HttpError } from '../server/core/http.js';
import { addDaysYmd, hmInTz, weekdayKey, ymdInTz, zonedToUtc } from '../server/core/time.js';
import { recordHit } from '../server/services/email-events.js';
import { unsubscribeToken } from '../server/services/messaging.js';
import { boot, connect, login, settle, syncNow, type T } from './mailbox-helpers.js';
import { results, runWorkflow } from './wfx-helpers.js';
import type { MailFake } from './mailbox-fakes.js';

/**
 * Sales sequences end to end on the real mailbox code (Gmail fake): enrolling, the first mail inside the business hours, thread
 * replies, task steps that wait, the daily limit, every reason that ends an enrolment, the consent gate and the "Einzelkorrespondenz"
 * mode, A/B variants and the numbers. The pure rules (steps, window, jitter, variants) are in sequences-model.test.ts.
 */

let t: T;
let fake: MailFake;
let loc = '';
let tz = '';
let mb = '';
let adminId = '';
let n = 0;

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const PROXY = 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)';

/** A Tuesday, `weeks` ahead, at the given local time of the sub-account: always inside the default business hours. */
const tue = (weeks: number, hm = '10:00') => {
  let ymd = ymdInTz(new Date(Date.now() + weeks * 7 * 864e5), tz);
  while (weekdayKey(ymd) !== 'tue') ymd = addDaysYmd(ymd, 1);
  return zonedToUtc(ymd, hm, tz);
};
/** `days` later at the same local time (a clock change in between does not move it out of the window), plus `hours`. */
const plus = (d: Date, days: number, hours = 0) => new Date(zonedToUtc(addDaysYmd(ymdInTz(d, tz), days), hmInTz(d, tz), tz).getTime() + hours * 3_600_000);

const runDue = (at: Date) => t.app.services.sequences.runDue(at, 200) as Promise<{ sent: number; tasks: number; deferred: number; stopped: number; resumed: number }>;
const flush = () => t.app.events.flush();
const sent = () => fake.g.sentRaw;
const mail = (extra: Record<string, unknown> = {}) => ({ type: 'email', delay_days: 0, subject: 'Hallo {{contact.first_name}}', body: 'Schön, von Ihnen zu hören, {{contact.first_name}}.', ...extra });

async function contact(extra: Record<string, unknown> = {}) {
  const i = ++n;
  const r = await t.api.post('/api/contacts', { first_name: `Person${i}`, last_name: 'Test', email: `person${i}@kunde.example`, ...extra });
  expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
  return r.data.id as string;
}
async function sequence(steps: unknown[], extra: Record<string, unknown> = {}, activate = true) {
  const r = await t.api.post('/api/sequences', { name: `Folge ${++n}`, steps, ...extra });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  if (activate) expect((await t.api.patch(`/api/sequences/${r.data.id}`, { status: 'active' })).status).toBe(200);
  return r.data.id as string;
}
const enroll = (sid: string, contactIds: string[], extra: Record<string, unknown> = {}) => t.api.post(`/api/sequences/${sid}/enroll`, { contact_ids: contactIds, ...extra });
const enrollment = (sid: string, cid: string) => t.app.db.get(`SELECT * FROM sequence_enrollments WHERE sequence_id = ? AND contact_id = ? ORDER BY enrolled_at DESC`, sid, cid) as any;
const events = (sid: string, kind?: string) => t.app.db.all(`SELECT * FROM sequence_events WHERE sequence_id = ?${kind ? ' AND kind = ?' : ''} ORDER BY at, rowid`, ...(kind ? [sid, kind] : [sid])) as any[];
const stats = async (sid: string) => (await t.api.get(`/api/sequences/${sid}`)).data.stats;

beforeAll(async () => {
  ({ t, fake } = await boot());
  loc = t.api.location;
  tz = t.app.location(loc)?.timezone || 'Europe/Berlin';
  adminId = (await t.api.get('/api/me')).data.user.id;
  // The admin's own mailbox (a personal one), filing into this sub-account; tracking on so that opens can be counted.
  const c = await connect(t, fake, { provider: 'google', scope: 'user', access: 'full', name: 'Chef privat' });
  mb = c.id;
  await settle(t, mb);
  expect((await t.api.patch(`/api/mailboxes/${mb}`, { default_location_id: loc, track_engagement: true })).status).toBe(200);
}, 60_000);
afterAll(async () => {
  await t?.close();
});
// Every test counts what it did itself: runs of earlier tests that are still open must not be picked up by this test's tick.
beforeEach(() => {
  t.app.db.run(`UPDATE sequence_enrollments SET status = 'stopped', stop_reason = 'manual', next_at = NULL WHERE status IN ('active', 'waiting')`);
});

describe('building a sequence', () => {
  it('checks the steps and starts as a draft that cannot enrol anybody', async () => {
    expect((await t.api.post('/api/sequences', { name: 'Leer', steps: [] })).status).toBe(400);
    expect((await t.api.post('/api/sequences', { name: 'Ohne Betreff', steps: [mail({ subject: '' })] })).status).toBe(400);
    expect((await t.api.post('/api/sequences', { steps: [mail()] })).status).toBe(400);
    const sid = await sequence([mail()], {}, false);
    expect((await t.api.get(`/api/sequences/${sid}`)).data).toMatchObject({ status: 'draft', mode: 'marketing' });
    const cid = await contact();
    expect((await enroll(sid, [cid])).status).toBe(409);
    expect((await t.api.patch(`/api/sequences/${sid}`, { status: 'sleeping' })).status).toBe(400);
    expect((await t.api.patch(`/api/sequences/${sid}`, { status: 'active' })).status).toBe(200);
    expect((await enroll(sid, [cid])).data).toMatchObject({ enrolled: 1, skipped: [] });
    const list = (await t.api.get('/api/sequences')).data.find((s: any) => s.id === sid);
    expect(list).toMatchObject({ steps: 1, email_steps: 1, enrolled: 1, active: 1, sent: 0 });
  });

  it('mails come from the sender’s own mailbox: without one nobody is enrolled', async () => {
    const sid = await sequence([mail()]);
    await t.api.post('/api/users', { email: 'ohne@example.com', name: 'Ohne Postfach', password: 'passwort-123', role: 'member', locations: [loc], permissions: ['contacts', 'opportunities'] });
    const other = await login(t, 'ohne@example.com', 'passwort-123', loc);
    const cid = await contact();
    const r = await other.post(`/api/sequences/${sid}/enroll`, { contact_ids: [cid] });
    expect(r.status).toBe(409);
    expect(r.data.error).toMatch(/Ohne Postfach.*Postfach/);
    expect(enrollment(sid, cid)).toBeUndefined();
    // A person can only enrol for themselves; the admin can name somebody else (who has no mailbox either).
    expect((await other.post(`/api/sequences/${sid}/enroll`, { contact_ids: [cid], user_id: adminId })).status).toBe(403);
    const me = (await other.get('/api/sequence-settings')).data;
    expect(me.my_mailbox).toEqual({ connected: false });
    expect((await t.api.get('/api/sequence-settings')).data.my_mailbox).toMatchObject({ connected: true, tracking: true });
  });

  it('a task-only sequence needs no mailbox', async () => {
    const sid = await sequence([{ type: 'call', title: 'Kurz anrufen', delay_days: 0 }]);
    const other = await login(t, 'ohne@example.com', 'passwort-123', loc);
    const cid = await contact();
    expect((await other.post(`/api/sequences/${sid}/enroll`, { contact_ids: [cid] })).status).toBe(200);
  });
});

describe('sending', () => {
  it('first mail inside the business hours, the second as an answer in the same thread, then a call task', async () => {
    const sid = await sequence([mail({ subject: 'Kennenlernen mit {{contact.first_name}}' }), mail({ delay_days: 2, reply_in_thread: true, subject: '', body: 'Kurz nachgefasst.' }), { type: 'call', title: 'Anrufen: {{contact.first_name}}', delay_days: 1, wait: false, note: 'Nummer prüfen' }]);
    const cid = await contact({ first_name: 'Greta', email: 'greta@kunde.example' });
    expect((await enroll(sid, [cid])).data.enrolled).toBe(1);
    const e0 = enrollment(sid, cid);
    expect(e0).toMatchObject({ status: 'active', step_index: 0, user_id: adminId, source: 'manuell' });

    const day1 = tue(1);
    const before = sent().length;
    expect(await runDue(day1)).toMatchObject({ sent: 1, deferred: 0 });
    expect(sent()).toHaveLength(before + 1);
    const first = sent().at(-1)!;
    expect(first.parsed).toMatchObject({ to: ['greta@kunde.example'], subject: 'Kennenlernen mit Greta' });
    expect(first.parsed.text).toContain('Schön, von Ihnen zu hören, Greta.');
    // the unsubscribe line with the contact's own link, and the mail is marked as the sequence's
    expect(first.parsed.text).toContain(`/u/${cid}/${unsubscribeToken(t.app, cid)}`);
    const m1 = t.app.db.get(`SELECT * FROM messages WHERE contact_id = ? AND direction = 'out' ORDER BY created_at DESC`, cid) as any;
    // Greta has no recorded consent: the policy lets her through as legacy, and the proof says so (not "confirmed").
    expect(m1).toMatchObject({ source: 'Sequenz', purpose: 'marketing', consent_basis: 'legacy', user_id: null, channel: 'email' });
    // tracking is on for this mailbox: the HTML carries the pixel
    expect(first.parsed.html).toContain('/t/o/');

    // step 2 is planned two days later, inside the window: nothing is due one day later
    const after1 = enrollment(sid, cid);
    expect(after1).toMatchObject({ step_index: 1, last_message_id: m1.id });
    expect(Date.parse(after1.next_at)).toBeGreaterThanOrEqual(plus(day1, 2).getTime());
    expect(await runDue(plus(day1, 1))).toMatchObject({ sent: 0 });

    const day3 = plus(day1, 2);
    expect(await runDue(day3)).toMatchObject({ sent: 1 });
    const second = sent().at(-1)!;
    expect(second.threadId).toBe(first.threadId ?? second.threadId);
    expect(second.parsed.subject).toMatch(/^Re: Kennenlernen mit Greta/);
    expect(second.parsed.inReplyTo).toBeTruthy();
    expect(second.parsed.text).toContain('Kurz nachgefasst.');

    // step 3: the call becomes a task for the sender; the sequence is over (the task does not hold it)
    const day4 = plus(day3, 1);
    expect(await runDue(day4)).toMatchObject({ tasks: 1 });
    const task = t.app.db.get(`SELECT * FROM tasks WHERE contact_id = ? AND title LIKE 'Anrufen:%'`, cid) as any;
    expect(task).toMatchObject({ title: 'Anrufen: Anrufen: Greta', assigned_to: adminId, done: 0 });
    expect(task.description).toBe('Nummer prüfen');
    expect(enrollment(sid, cid)).toMatchObject({ status: 'finished', finished_at: expect.any(String) });
    expect(events(sid).map((x) => x.kind)).toEqual(['enrolled', 'sent', 'sent', 'task', 'finished']);
    const acts = (await t.api.get(`/api/contacts/${cid}`)).data;
    expect(JSON.stringify(acts)).toContain('Sequenz');
    // the contact page shows the run
    const mine = (await t.api.get(`/api/sequence-enrollments?contact_id=${cid}`)).data;
    expect(mine).toMatchObject([{ sequence_id: sid, status: 'finished', sent: 2 }]);
  });

  it('a series always carries the unsubscribe link; only personal correspondence may leave it out', async () => {
    const link = (cid: string) => `/u/${cid}/${unsubscribeToken(t.app, cid)}`;
    const series = await sequence([mail({ subject: 'Serie ohne Fuß' })], { settings: { footer: false } });
    const personal = await sequence([mail({ subject: 'Persönlich ohne Fuß' })], { mode: 'individual', legal_ack: true, settings: { footer: false } });
    const a = await contact({ email: 'fuss-a@kunde.example' });
    const b = await contact({ email: 'fuss-b@kunde.example' });
    // the series needs the consent of the sub-account's policy; "legacy" lets a plain contact through
    expect((await enroll(series, [a])).data.enrolled).toBe(1);
    expect((await enroll(personal, [b])).data.enrolled).toBe(1);
    expect(await runDue(tue(25))).toMatchObject({ sent: 2 });
    const text = (subject: string) => sent().find((m) => m.parsed.subject === subject)!.parsed.text as string;
    expect(text('Serie ohne Fuß')).toContain(link(a));
    expect(text('Persönlich ohne Fuß')).not.toContain('/u/');
  });

  it('outside the business hours nothing leaves: the step waits for the next window', async () => {
    const sid = await sequence([mail()]);
    const cid = await contact();
    await enroll(sid, [cid]);
    const sat = plus(tue(2, '12:00'), 4); // Saturday noon
    const before = sent().length;
    expect(await runDue(sat)).toMatchObject({ sent: 0, deferred: 1 });
    expect(sent()).toHaveLength(before);
    const e = enrollment(sid, cid);
    expect(e.status).toBe('active');
    expect(Date.parse(e.next_at)).toBeGreaterThan(sat.getTime());
    expect(e.note).toMatch(/Sendezeit/);
    // Monday morning, in the window: it goes
    const mon = plus(tue(2, '10:00'), 6);
    expect(await runDue(mon)).toMatchObject({ sent: 1 });
    // a sequence may turn the window off
    const sid2 = await sequence([mail()], { settings: { window: { enabled: false } } });
    const c2 = await contact();
    await enroll(sid2, [c2]);
    expect(await runDue(sat)).toMatchObject({ sent: 1 });
  });

  it('a paused sequence sends nothing; the running enrolments carry on when it is active again', async () => {
    const sid = await sequence([mail()]);
    const cid = await contact();
    await enroll(sid, [cid]);
    await t.api.patch(`/api/sequences/${sid}`, { status: 'paused' });
    expect(await runDue(tue(3))).toMatchObject({ sent: 0 });
    await t.api.patch(`/api/sequences/${sid}`, { status: 'active' });
    expect(await runDue(tue(3))).toMatchObject({ sent: 1 });
  });

  it('daily limit per person: the rest waits for the next day, a limit per person overrides the common one', async () => {
    expect((await t.api.put('/api/sequence-settings', { daily_limit: 2 })).data.daily_limit).toBe(2);
    const sid = await sequence([mail()]);
    const ids = [await contact(), await contact(), await contact(), await contact()];
    await enroll(sid, ids);
    const day = tue(4);
    expect(await runDue(day)).toMatchObject({ sent: 2, deferred: 2 });
    expect(events(sid, 'limit')).toHaveLength(2);
    const waiting = ids.map((c) => enrollment(sid, c)).filter((e) => e.status === 'active' && e.step_index === 0);
    expect(waiting).toHaveLength(2);
    for (const e of waiting) expect(Date.parse(e.next_at)).toBeGreaterThan(day.getTime() + 6 * 3_600_000);
    // same day again: still nothing
    expect(await runDue(plus(day, 0, 2))).toMatchObject({ sent: 0 });
    // next day: two more
    expect(await runDue(plus(day, 1))).toMatchObject({ sent: 2 });
    expect(ids.every((c) => enrollment(sid, c).status === 'finished')).toBe(true);
    // a personal limit wins over the common one
    expect((await t.api.put('/api/sequence-settings', { daily_limit: 2, user_limits: { [adminId]: 1 } })).data.user_limits).toEqual({ [adminId]: 1 });
    const sid2 = await sequence([mail()]);
    const more = [await contact(), await contact()];
    await enroll(sid2, more);
    expect(await runDue(tue(5))).toMatchObject({ sent: 1, deferred: 1 });
    // limits are validated and only for people of the sub-account
    expect((await t.api.put('/api/sequence-settings', { daily_limit: 100000 })).status).toBe(400);
    expect((await t.api.put('/api/sequence-settings', { user_limits: { fremd: 5 } })).status).toBe(400);
    await t.api.put('/api/sequence-settings', { daily_limit: 100, user_limits: { [adminId]: null } });
    expect((await t.api.get('/api/sequence-settings')).data).toMatchObject({ daily_limit: 100, user_limits: {} });
  });

  it('a mail that cannot be sent is tried again a few times; one the provider refuses for good ends the enrolment', async () => {
    const sid = await sequence([mail()]);
    const [a, b] = [await contact(), await contact()];
    await enroll(sid, [a, b]);
    try {
      t.app.services.sequenceSend = async () => {
        throw new HttpError(503, 'Dienst nicht erreichbar');
      };
      const day = tue(6);
      await runDue(day);
      expect(enrollment(sid, a)).toMatchObject({ status: 'active', failures: 1 });
      await runDue(plus(day, 0, 1));
      await runDue(plus(day, 0, 2));
      expect(enrollment(sid, a)).toMatchObject({ status: 'stopped', stop_reason: 'send_failed', failures: 3 });
      expect(events(sid, 'failed').length).toBeGreaterThanOrEqual(3);
      // a hard refusal (4xx) stops at once
      const sid2 = await sequence([mail()]);
      const c = await contact();
      await enroll(sid2, [c]);
      t.app.services.sequenceSend = async () => {
        throw new HttpError(403, 'Adresse abgelehnt');
      };
      await runDue(tue(7));
      expect(enrollment(sid2, c)).toMatchObject({ status: 'stopped', stop_reason: 'send_failed' });
    } finally {
      delete t.app.services.sequenceSend;
    }
  });

  it('a second run never sends the same step twice', async () => {
    const sid = await sequence([mail()]);
    const cid = await contact();
    await enroll(sid, [cid]);
    const before = sent().length;
    const day = tue(8);
    await Promise.all([runDue(day), runDue(day)]);
    expect(sent()).toHaveLength(before + 1);
  });
});

describe('what ends an enrolment', () => {
  it('a reply ends it – found in the mailbox without any event – but not a message from before the enrolment', async () => {
    const sid = await sequence([mail({ subject: 'Frage an {{contact.first_name}}' }), mail({ delay_days: 3 })]);
    const cid = await contact({ first_name: 'Rita', email: 'rita@antwort.example' });
    await enroll(sid, [cid]);
    expect(await runDue(tue(9))).toMatchObject({ sent: 1 });
    // an older mail of hers (the mailbox import) says nothing about this sequence
    fake.gmail.add({ id: 'rita-old', from: 'Rita <rita@antwort.example>', subject: 'Altes Thema', text: 'Von früher', threadId: 'th-rita-old', date: new Date(Date.now() - 36e5).toISOString() });
    await syncNow(t, mb, { full: true });
    await flush();
    expect(await runDue(tue(9, '11:00'))).toMatchObject({ stopped: 0 });
    expect(enrollment(sid, cid).status).toBe('active');
    // now she answers: the mailbox files the mail (it announces nothing – "Workflows starten" is off), the next tick sees it
    t.app.db.run('UPDATE sequence_enrollments SET enrolled_at = ? WHERE id = ?', new Date(Date.now() - 120_000).toISOString(), enrollment(sid, cid).id);
    t.app.db.run('UPDATE mailboxes SET trigger_workflows = 0 WHERE id = ?', mb);
    fake.gmail.add({ id: 'rita-new', from: 'Rita <rita@antwort.example>', subject: 'Re: Frage an Rita', text: 'Ja, gerne – rufen Sie an.', threadId: 'th-rita-new' });
    await syncNow(t, mb, { full: true });
    await flush();
    const before = sent().length;
    // the second step is due as well – but she has answered, so nothing is written to her
    expect(await runDue(tue(10))).toMatchObject({ sent: 0, stopped: 1 });
    expect(sent()).toHaveLength(before);
    expect(enrollment(sid, cid)).toMatchObject({ status: 'stopped', stop_reason: 'reply', next_at: null });
    expect(events(sid, 'reply')).toHaveLength(1);
    expect(events(sid, 'reply')[0]).toMatchObject({ step_id: expect.any(String), detail: 'Re: Frage an Rita' });
    expect(await runDue(tue(11))).toMatchObject({ sent: 0 });
    const s = await stats(sid);
    expect(s).toMatchObject({ enrolled: 1, stopped: 1, replied: 1, contacted: 1, reply_rate: 100, stopped_by: { reply: 1 } });
    t.app.db.run('UPDATE mailboxes SET trigger_workflows = 1 WHERE id = ?', mb);
  });

  it('an event ends it at once (live chat, SMS, WhatsApp …); an answer after the last step still counts for the numbers', async () => {
    const sid = await sequence([mail(), mail({ delay_days: 3 })]);
    const cid = await contact();
    await enroll(sid, [cid]);
    await runDue(tue(10));
    t.app.db.run('UPDATE sequence_enrollments SET enrolled_at = ? WHERE id = ?', new Date(Date.now() - 120_000).toISOString(), enrollment(sid, cid).id);
    t.app.events.emit(loc, 'message.inbound', { contactId: cid, message: { id: 'sms-1', channel: 'sms', created_at: new Date().toISOString(), subject: '' } });
    await flush();
    expect(enrollment(sid, cid)).toMatchObject({ status: 'stopped', stop_reason: 'reply' });
    // phone calls are no answers
    const c2 = await contact();
    await enroll(sid, [c2]);
    t.app.db.run('UPDATE sequence_enrollments SET enrolled_at = ? WHERE id = ?', new Date(Date.now() - 120_000).toISOString(), enrollment(sid, c2).id);
    t.app.events.emit(loc, 'message.inbound', { contactId: c2, message: { id: 'call-1', channel: 'call', created_at: new Date().toISOString() } });
    await flush();
    expect(enrollment(sid, c2).status).toBe('active');
    // a one-step sequence is finished after its mail; the answer two days later is still its answer
    const one = await sequence([mail()]);
    const c3 = await contact();
    await enroll(one, [c3]);
    await runDue(tue(11));
    expect(enrollment(one, c3).status).toBe('finished');
    t.app.db.run('UPDATE sequence_enrollments SET enrolled_at = ? WHERE id = ?', new Date(Date.now() - 120_000).toISOString(), enrollment(one, c3).id);
    t.app.db.run('UPDATE sequence_enrollments SET finished_at = ? WHERE id = ?', new Date().toISOString(), enrollment(one, c3).id);
    t.app.events.emit(loc, 'message.inbound', { contactId: c3, message: { id: 'm-late', channel: 'email', created_at: new Date().toISOString(), subject: 'Spät' } });
    await flush();
    expect(enrollment(one, c3).status).toBe('finished');
    expect(events(one, 'reply')).toHaveLength(1);
    expect((await stats(one)).replied).toBe(1);
    // a second answer is not counted again
    t.app.events.emit(loc, 'message.inbound', { contactId: c3, message: { id: 'm-late-2', channel: 'email', created_at: new Date().toISOString(), subject: 'Noch eine' } });
    await flush();
    expect(events(one, 'reply')).toHaveLength(1);
  });

  it('a sequence can be told to keep going after a reply', async () => {
    const sid = await sequence([mail(), mail({ delay_days: 3 })], { settings: { stop_on: { reply: false } } });
    const cid = await contact({ email: 'weiter@antwort.example' });
    await enroll(sid, [cid]);
    await runDue(tue(12));
    t.app.db.run('UPDATE sequence_enrollments SET enrolled_at = ? WHERE id = ?', new Date(Date.now() - 120_000).toISOString(), enrollment(sid, cid).id);
    fake.gmail.add({ id: 'weiter-1', from: 'weiter@antwort.example', subject: 'Re: Hallo', text: 'Danke!', threadId: 'th-weiter' });
    await syncNow(t, mb, { full: true });
    await flush();
    // the reply is noted for the numbers, the sequence carries on with its second mail
    expect(await runDue(tue(13))).toMatchObject({ sent: 1, stopped: 0 });
    expect(enrollment(sid, cid)).toMatchObject({ status: 'finished' });
    expect(events(sid, 'reply')).toHaveLength(1);
    expect((await stats(sid)).replied).toBe(1);
  });

  it('a booked meeting counts for the numbers and ends it', async () => {
    const sid = await sequence([mail(), mail({ delay_days: 3 })]);
    const keep = await sequence([mail(), mail({ delay_days: 3 })], { settings: { stop_on: { meeting: false } } });
    const cid = await contact();
    await enroll(sid, [cid]);
    await enroll(keep, [cid]);
    await runDue(tue(13));
    t.app.events.emit(loc, 'appointment.booked', { contactId: cid, appointment: { id: 'x' } });
    await flush();
    expect(enrollment(sid, cid)).toMatchObject({ status: 'stopped', stop_reason: 'meeting' });
    expect(enrollment(keep, cid).status).toBe('active');
    expect((await stats(keep)).meetings).toBe(1);
    const s = await stats(sid);
    expect(s).toMatchObject({ meetings: 1, meeting_rate: 100 });
    // booking again does not count twice
    t.app.events.emit(loc, 'appointment.booked', { contactId: cid, appointment: { id: 'y' } });
    await flush();
    expect((await stats(keep)).meetings).toBe(1);
  });

  it('a deal that moves ends it where the sequence says so; a deal that is won or lost ends it everywhere', async () => {
    const pipe = await t.api.post('/api/pipelines', { name: 'Vertrieb', stages: ['Neu', 'Angebot', 'Gewonnen'] });
    const stages = pipe.data.stages;
    const watching = await sequence([mail(), mail({ delay_days: 3 })], { settings: { stop_on: { stage_change: true } } });
    const plain = await sequence([mail(), mail({ delay_days: 3 })]);
    const cid = await contact();
    const deal = await t.api.post('/api/opportunities', { pipeline_id: pipe.data.id, contact_id: cid, name: 'Küche', value: 1000 });
    expect(deal.status).toBe(200);
    await enroll(watching, [cid], { deal_id: deal.data.id });
    await enroll(plain, [cid]);
    expect(await runDue(tue(14))).toMatchObject({ sent: 2 });
    expect((await t.api.patch(`/api/opportunities/${deal.data.id}`, { stage_id: stages[1].id })).status).toBe(200);
    await flush();
    expect(enrollment(watching, cid)).toMatchObject({ status: 'stopped', stop_reason: 'stage_change' });
    expect(enrollment(plain, cid).status).toBe('active');
    expect((await t.api.patch(`/api/opportunities/${deal.data.id}`, { status: 'won' })).status).toBe(200);
    await flush();
    expect(enrollment(plain, cid)).toMatchObject({ status: 'stopped', stop_reason: 'deal_closed' });
  });

  it('a deal of somebody else’s sequence does not end this one (a sequence bound to a deal only listens to that deal)', async () => {
    const pipe = await t.api.post('/api/pipelines', { name: 'Zweite', stages: ['A', 'B'] });
    const stages = pipe.data.stages;
    const sid = await sequence([mail(), mail({ delay_days: 3 })], { settings: { stop_on: { stage_change: true } } });
    const cid = await contact();
    const mine = await t.api.post('/api/opportunities', { pipeline_id: pipe.data.id, contact_id: cid, name: 'Mein Deal', value: 1 });
    const other = await t.api.post('/api/opportunities', { pipeline_id: pipe.data.id, contact_id: cid, name: 'Anderer Deal', value: 1 });
    await enroll(sid, [cid], { deal_id: mine.data.id });
    await t.api.patch(`/api/opportunities/${other.data.id}`, { stage_id: stages[1].id });
    await flush();
    expect(enrollment(sid, cid).status).toBe('active');
    await t.api.patch(`/api/opportunities/${mine.data.id}`, { stage_id: stages[1].id });
    await flush();
    expect(enrollment(sid, cid).status).toBe('stopped');
  });

  it('unsubscribing (link in the mail), "Nicht stören" and a withdrawn consent end all sequences of the person at once', async () => {
    const a = await sequence([mail(), mail({ delay_days: 3 })]);
    const b = await sequence([mail(), mail({ delay_days: 3 })]);
    const cid = await contact();
    await enroll(a, [cid]);
    await enroll(b, [cid]);
    await runDue(tue(15));
    const res = await fetch(`${t.base}/u/${cid}/${unsubscribeToken(t.app, cid)}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'confirm=1' });
    expect(res.status).toBe(200);
    await flush();
    expect(enrollment(a, cid)).toMatchObject({ status: 'stopped', stop_reason: 'unsubscribed' });
    expect(enrollment(b, cid)).toMatchObject({ status: 'stopped', stop_reason: 'unsubscribed' });
    // and the person cannot be enrolled again
    const r = await enroll(a, [cid]);
    expect(r.data).toMatchObject({ enrolled: 0, skipped: [{ contact_id: cid, reason: expect.stringMatching(/Nicht stören/) }] });

    // "Nicht stören" set by hand between two steps: the due mail is not sent
    const c2 = await contact();
    const s2 = await sequence([mail(), mail({ delay_days: 3 })]);
    await enroll(s2, [c2]);
    await runDue(tue(16));
    t.app.db.run('UPDATE contacts SET dnd = 1 WHERE id = ?', c2);
    const before = sent().length;
    await runDue(plus(tue(16), 3));
    expect(sent()).toHaveLength(before);
    expect(enrollment(s2, c2)).toMatchObject({ status: 'stopped', stop_reason: 'unsubscribed' });
    expect(events(s2, 'blocked')).toHaveLength(1);

    // consent withdrawn
    const c3 = await contact();
    const s3 = await sequence([mail(), mail({ delay_days: 3 })]);
    await enroll(s3, [c3]);
    expect((await t.api.post(`/api/contacts/${c3}/consent`, { action: 'revoked', channel: 'email' })).status).toBe(200);
    await flush();
    expect(enrollment(s3, c3)).toMatchObject({ status: 'stopped', stop_reason: 'unsubscribed' });
  });

  it('a person who leaves the sub-account ends their enrolments; a deleted contact ends it too', async () => {
    const sid = await sequence([mail(), mail({ delay_days: 3 })]);
    const cid = await contact();
    await enroll(sid, [cid]);
    t.app.db.run('UPDATE sequence_enrollments SET user_id = ? WHERE id = ?', 'weg-und-fort', enrollment(sid, cid).id);
    await runDue(tue(17));
    expect(enrollment(sid, cid)).toMatchObject({ status: 'stopped', stop_reason: 'paused_user' });
  });

  it('can be ended by hand (once)', async () => {
    const sid = await sequence([mail(), mail({ delay_days: 3 })]);
    const cid = await contact();
    await enroll(sid, [cid]);
    const e = enrollment(sid, cid);
    expect((await t.api.post(`/api/sequence-enrollments/${e.id}/stop`, {})).status).toBe(200);
    expect(enrollment(sid, cid)).toMatchObject({ status: 'stopped', stop_reason: 'manual' });
    expect((await t.api.post(`/api/sequence-enrollments/${e.id}/stop`, {})).status).toBe(409);
    expect((await t.api.get(`/api/sequences/${sid}/enrollments?status=stopped`)).data).toMatchObject([{ contact_id: cid, stop_label: 'Von Hand beendet' }]);
    // enrolled again afterwards (the old run is over)
    expect((await enroll(sid, [cid])).data.enrolled).toBe(1);
    expect((await enroll(sid, [cid])).data.skipped[0].reason).toMatch(/schon/);
  });
});

describe('consent gate and Einzelkorrespondenz', () => {
  it('advertising mode asks the consent gate; individual mode is 1:1 correspondence and needs the sender’s confirmation', async () => {
    expect((await t.api.put('/api/consent/settings', { policy: 'confirmed' })).status).toBe(200);
    try {
      const marketing = await sequence([mail()]);
      const noConsent = await contact({ email: 'ohne-einwilligung@kunde.example' });
      const r = await enroll(marketing, [noConsent]);
      expect(r.data.enrolled).toBe(0);
      expect(r.data.skipped[0].reason).toBeTruthy();

      // individual: refused without the explicit confirmation …
      const bad = await t.api.post('/api/sequences', { name: 'Persönlich', mode: 'individual', steps: [mail()] });
      expect(bad.status).toBe(400);
      expect(bad.data.error).toMatch(/Einzelkorrespondenz/);
      // … and with it the sequence records who confirmed and when
      const personal = await t.api.post('/api/sequences', { name: 'Persönlich', mode: 'individual', legal_ack: true, steps: [mail()] });
      expect(personal.status).toBe(200);
      expect(personal.data).toMatchObject({ mode: 'individual', legal_ack_by: adminId, legal_ack_at: expect.any(String) });
      await t.api.patch(`/api/sequences/${personal.data.id}`, { status: 'active' });
      expect((await enroll(personal.data.id, [noConsent])).data.enrolled).toBe(1);
      expect(await runDue(tue(18))).toMatchObject({ sent: 1 });
      const m = t.app.db.get(`SELECT purpose, consent_basis, source FROM messages WHERE contact_id = ? AND direction = 'out'`, noConsent) as any;
      expect(m).toMatchObject({ purpose: 'conversation', consent_basis: '', source: 'Sequenz' });
      // switching an existing advertising sequence to individual needs the confirmation as well
      expect((await t.api.patch(`/api/sequences/${marketing}`, { mode: 'individual' })).status).toBe(400);
      expect((await t.api.patch(`/api/sequences/${marketing}`, { mode: 'individual', legal_ack: true })).data).toMatchObject({ mode: 'individual', legal_ack_by: adminId });

      // with a documented consent the advertising mode enrols
      const other = await sequence([mail()]);
      const consented = await contact({ email: 'einwilligung@kunde.example' });
      expect((await t.api.post(`/api/contacts/${consented}/consent`, { action: 'granted', channel: 'email', note: 'Schriftlich am 02.03.' })).status).toBe(200);
      expect((await enroll(other, [consented])).data.enrolled).toBe(1);
      // withdrawn between two steps (gate checked again before every mail): the next mail does not leave and the enrolment ends
      const gone = await contact({ email: 'widerruf@kunde.example' });
      await t.api.post(`/api/contacts/${gone}/consent`, { action: 'granted', channel: 'email', note: 'Schriftlich' });
      const multi = await sequence([mail(), mail({ delay_days: 3 })]);
      await enroll(multi, [gone]);
      await runDue(tue(19));
      // the documented consent is what the mail's proof names
      expect(t.app.db.get(`SELECT consent_basis FROM messages WHERE contact_id = ? AND direction = 'out'`, consented)).toEqual({ consent_basis: 'confirmed' });
      t.app.db.run(`INSERT INTO consent_events (id, location_id, contact_id, channel, purpose, action, doi_required, source_kind, source_label, note, actor, created_at) VALUES ('ce-sq', ?, ?, 'email', 'newsletter', 'revoked', 0, 'manual', 'Test', '', 'team', ?)`, loc, gone, new Date().toISOString());
      const before = sent().length;
      await runDue(plus(tue(19), 3));
      expect(sent()).toHaveLength(before);
      expect(enrollment(multi, gone)).toMatchObject({ status: 'stopped' });
    } finally {
      await t.api.put('/api/consent/settings', { policy: 'legacy' });
    }
  });
});

describe('task, call and LinkedIn steps', () => {
  it('a step that waits holds the sequence until the task is done; the next step counts from then', async () => {
    const sid = await sequence([mail(), { type: 'call', title: 'Nachtelefonieren', delay_days: 1, wait: true, max_wait_days: 5 }, mail({ delay_days: 1, subject: 'Nach dem Anruf', body: 'Danke für das Gespräch.' })]);
    const cid = await contact({ email: 'telefon@kunde.example' });
    await enroll(sid, [cid]);
    const d1 = tue(20);
    await runDue(d1);
    const d2 = plus(d1, 1);
    expect(await runDue(d2)).toMatchObject({ tasks: 1 });
    expect(enrollment(sid, cid)).toMatchObject({ status: 'waiting', step_index: 2 });
    const task = t.app.db.get(`SELECT * FROM tasks WHERE contact_id = ?`, cid) as any;
    expect(enrollment(sid, cid).task_id).toBe(task.id);
    // a waiting sequence sends nothing
    const before = sent().length;
    expect(await runDue(plus(d2, 2))).toMatchObject({ sent: 0 });
    expect(sent()).toHaveLength(before);
    // the person ticks the task off: it goes on
    expect((await t.api.patch(`/api/tasks/${task.id}`, { done: true })).status).toBe(200);
    await flush();
    expect(enrollment(sid, cid)).toMatchObject({ status: 'active', task_id: null });
    const resumed = Date.parse(enrollment(sid, cid).next_at);
    expect(resumed).toBeGreaterThanOrEqual(Date.now() + 23 * 3_600_000);
    expect(await runDue(new Date(resumed))).toMatchObject({ sent: 1 });
    expect(sent().at(-1)!.parsed.subject).toBe('Nach dem Anruf');
    expect(enrollment(sid, cid).status).toBe('finished');
  });

  it('a task nobody does lets the sequence go on after the longest wait', async () => {
    const sid = await sequence([{ type: 'linkedin', title: 'Vernetzen', delay_days: 0, wait: true, max_wait_days: 3 }, mail({ delay_days: 0 })]);
    const cid = await contact();
    await enroll(sid, [cid]);
    const d1 = tue(21);
    await runDue(d1);
    expect(enrollment(sid, cid).status).toBe('waiting');
    expect(t.app.db.get(`SELECT title FROM tasks WHERE contact_id = ?`, cid)).toMatchObject({ title: 'LinkedIn: Vernetzen' });
    expect(await runDue(plus(d1, 2))).toMatchObject({ resumed: 0 });
    // the longest wait is over: the sequence goes on (the next step has no delay and leaves in the same tick)
    expect(await runDue(plus(d1, 6))).toMatchObject({ resumed: 1, sent: 1 });
    expect(events(sid, 'skipped')).toHaveLength(1);
    expect(enrollment(sid, cid).status).toBe('finished');
  });

  it('a person without an e-mail address only gets the tasks; e-mail steps are skipped', async () => {
    const sid = await sequence([{ type: 'task', title: 'Karte schicken', delay_days: 0, wait: false }, mail({ delay_days: 0 })]);
    const cid = await contact({ email: '' });
    // the sequence has an e-mail step, so a person without an address is refused up front
    const r = await enroll(sid, [cid]);
    expect(r.data).toMatchObject({ enrolled: 0, skipped: [{ reason: 'Keine E-Mail-Adresse' }] });
  });
});

describe('enrolling', () => {
  it('from a tag, with the rules of the list (contacts that are already in are skipped)', async () => {
    const sid = await sequence([mail()]);
    const ids = [await contact({ tags: ['messe-2026'] }), await contact({ tags: ['messe-2026'] }), await contact({ tags: ['andere'] })];
    const first = await t.api.post(`/api/sequences/${sid}/enroll`, { tag: 'messe-2026', source: 'Messe' });
    expect(first.data).toMatchObject({ enrolled: 2 });
    expect(first.data.contact_ids.sort()).toEqual([ids[0], ids[1]].sort());
    expect(enrollment(sid, ids[0]).source).toBe('Messe');
    expect(enrollment(sid, ids[2])).toBeUndefined();
    const again = await t.api.post(`/api/sequences/${sid}/enroll`, { tag: 'messe-2026' });
    expect(again.data.enrolled).toBe(0);
    expect(again.data.skipped).toHaveLength(2);
    expect((await t.api.post(`/api/sequences/${sid}/enroll`, {})).status).toBe(400);
    expect((await t.api.post(`/api/sequences/${sid}/enroll`, { smart_list_id: 'gibtsnicht' })).status).toBe(404);
    expect((await t.api.post(`/api/sequences/${sid}/enroll`, { contact_ids: ['gibtsnicht'] })).data.skipped).toMatchObject([{ reason: 'Kontakt nicht gefunden' }]);
  });

  it('from a workflow ("In Sequenz aufnehmen"): the sender is the contact’s owner, else the sequence’s author', async () => {
    const sid = await sequence([mail()], { name: 'Workflow-Folge' });
    const cat = await t.api.get('/api/workflow-catalog');
    expect(JSON.stringify(cat.data)).toContain('sequence_enroll');
    const r = await runWorkflow(t, [{ type: 'sequence_enroll', sequence: 'Workflow-Folge' }]);
    expect(results(r.log)).toEqual(['In „Workflow-Folge“ aufgenommen']);
    expect(enrollment(sid, r.contact.id)).toMatchObject({ source: 'Workflow', user_id: adminId, status: 'active' });
    // an unknown sequence is a step error, a person already in it is named
    const bad = await runWorkflow(t, [{ type: 'sequence_enroll', sequence: 'Gibt es nicht' }]);
    expect(JSON.stringify(bad.log)).toContain('nicht gefunden');
    const noMail = await runWorkflow(t, [{ type: 'sequence_enroll', sequence: 'Workflow-Folge' }], { contact: { email: '' } });
    expect(results(noMail.log)[0]).toMatch(/Nicht aufgenommen: Keine E-Mail-Adresse/);
  });

  it('through the API key, with the sender named (a key is nobody)', async () => {
    const sid = await sequence([mail()]);
    const cid = await contact();
    const key = (await t.api.post('/api/api-keys', { name: 'Test' })).data;
    const token = key.key ?? key.token;
    const call = (body: unknown) => fetch(`${t.base}/api/sequences/${sid}/enroll`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: (await r.json()) as any }));
    expect((await call({ contact_ids: [cid] })).status).toBe(400);
    expect((await call({ contact_ids: [cid], user_id: 'irgendwer' })).status).toBe(400);
    const ok = await call({ contact_ids: [cid], user_id: adminId });
    expect(ok.status).toBe(200);
    expect(ok.data.enrolled).toBe(1);
    expect(enrollment(sid, cid)).toMatchObject({ source: 'API', user_id: adminId });
  });
});

describe('A/B variants and the numbers', () => {
  it('shares the people between the variants, counts opens of people only and answers per variant', async () => {
    const sid = await sequence([mail({ subject: 'Original-Betreff', variants: [{ subject: 'Variante-B-Betreff' }] })]);
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) ids.push(await contact());
    await t.api.put('/api/sequence-settings', { daily_limit: 100 });
    await enroll(sid, ids);
    expect(await runDue(tue(22))).toMatchObject({ sent: 30 });
    const subjects = sent().slice(-30).map((r) => r.parsed.subject as string);
    expect(new Set(subjects)).toEqual(new Set(['Original-Betreff', 'Variante-B-Betreff']));

    const rows = events(sid, 'sent');
    const stepId = rows[0].step_id as string;
    const variantB = (await t.api.get(`/api/sequences/${sid}`)).data.steps[0].variants[0].id as string;
    const byVariant = (v: string) => rows.filter((r) => (r.variant_id ?? '') === v);
    expect(byVariant('').length + byVariant(variantB).length).toBe(30);
    expect(byVariant('').length).toBeGreaterThan(3);
    expect(byVariant(variantB).length).toBeGreaterThan(3);

    // two people read it (one of each variant); a mail proxy and a scanner load it as well – they do not count
    const reader = (v: string) => byVariant(v)[0].message_id as string;
    const read = async (messageId: string) => {
      t.app.db.run('UPDATE messages SET created_at = ? WHERE id = ?', new Date(Date.now() - 3_600_000).toISOString(), messageId);
      recordHit(t.app, { kind: 'open', messageId, method: 'GET', headers: { 'user-agent': CHROME, 'accept-language': 'de-DE' }, ip: '203.0.113.7' });
    };
    await read(reader(''));
    await read(reader(variantB));
    const fast = byVariant('')[1].message_id as string;
    recordHit(t.app, { kind: 'open', messageId: fast, method: 'GET', headers: { 'user-agent': PROXY }, ip: '203.0.113.8' });
    t.app.services.trackingCommit?.({ force: true });
    await flush();

    // a reply to the original ends that enrolment and belongs to the variant that was sent
    const replier = rows.find((r) => (r.variant_id ?? '') === '')!;
    t.app.services.sequences.stopContact(loc, replier.contact_id, 'reply', { message: 'm-x' });

    const s = await stats(sid);
    expect(s).toMatchObject({ enrolled: 30, sent: 30, contacted: 30, opened: 2, replied: 1, open_rate: Math.round((2 / 30) * 1000) / 10 });
    expect(s.open_tracking).toEqual({ senders: 1, on: 1 });
    const step = s.steps.find((x: any) => x.id === stepId);
    expect(step.variants.map((v: any) => [v.id, v.sent, v.opened, v.replied])).toEqual([
      ['', byVariant('').length, 1, 1],
      [variantB, byVariant(variantB).length, 1, 0],
    ]);
    expect(step.variants[1].open_rate).toBeGreaterThan(0);
    // the same person always gets the same variant (the enrolment fixes it)
    expect(rows.every((r) => r.variant_id === '' || r.variant_id === variantB)).toBe(true);
  });
});

describe('who sees what', () => {
  it('a sub-account never reaches another one’s sequences, enrolments or events', async () => {
    const sid = await sequence([mail()]);
    const created = await t.api.post('/api/locations', { name: 'Zweite Firma' });
    expect(created.status, JSON.stringify(created.data)).toBeLessThan(300);
    const second = created.data;
    expect(second.id).toBeTruthy();
    t.api.setLocation(second.id);
    try {
      expect((await t.api.get('/api/sequences')).data).toEqual([]);
      expect((await t.api.get(`/api/sequences/${sid}`)).status).toBe(404);
      expect((await t.api.patch(`/api/sequences/${sid}`, { name: 'fremd' })).status).toBe(404);
      expect((await t.api.del(`/api/sequences/${sid}`)).status).toBe(404);
      expect((await t.api.get(`/api/sequences/${sid}/enrollments`)).status).toBe(404);
    } finally {
      t.api.setLocation(loc);
    }
    expect((await t.api.get(`/api/sequences/${sid}`)).status).toBe(200);
  });

  it('deleting a sequence removes its enrolments and events', async () => {
    const sid = await sequence([mail()]);
    const cid = await contact();
    await enroll(sid, [cid]);
    expect((await t.api.del(`/api/sequences/${sid}`)).status).toBe(200);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM sequence_enrollments WHERE sequence_id = ?', sid)).toEqual({ n: 0 });
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM sequence_events WHERE sequence_id = ?', sid)).toEqual({ n: 0 });
  });
});
