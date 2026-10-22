import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, DEFAULT_WINDOW, SequenceError, cleanSettings, cleanSteps, cleanWindow, dueAt, footerText, inWindow, jitterMinutes, nextSlot, pickVariant, type Window } from '../server/services/sequence-model.js';

let n = 0;
const mint = () => `st${String(++n).padStart(4, '0')}`;
const mail = (extra: Record<string, unknown> = {}) => ({ type: 'email', subject: 'Hallo {{contact.first_name|}}', body: 'Text', ...extra });

describe('steps', () => {
  it('keeps valid ids, mints the rest and fills sensible defaults', () => {
    const steps = cleanSteps([mail({ id: 'keep1234' }), { type: 'call', title: 'Anrufen' }, { type: 'linkedin', title: 'Vernetzen', wait: false }], mint);
    expect(steps.map((s) => s.id)).toEqual(['keep1234', expect.stringMatching(/^st/), expect.stringMatching(/^st/)]);
    expect(steps[0]).toMatchObject({ delay_days: 0, wait: false, reply_in_thread: false });
    // calls and tasks wait for the task by default, mails never
    expect(steps[1]).toMatchObject({ delay_days: 2, wait: true, max_wait_days: 7 });
    expect(steps[2].wait).toBe(false);
  });

  it('refuses what cannot work', () => {
    expect(() => cleanSteps([], mint)).toThrow(SequenceError);
    expect(() => cleanSteps('x', mint)).toThrow(SequenceError);
    expect(() => cleanSteps([mail({ subject: '' })], mint)).toThrow(/Betreff/);
    expect(() => cleanSteps([mail({ body: ' ' })], mint)).toThrow(/Text/);
    expect(() => cleanSteps([{ type: 'task', title: '' }], mint)).toThrow(/Titel/);
    expect(() => cleanSteps([{ type: 'sms' }], mint)).toThrow(/Art/);
    expect(() => cleanSteps(Array.from({ length: 21 }, () => mail()), mint)).toThrow(/Höchstens 20/);
  });

  it('clamps delays, never repeats an id and allows a thread reply without subject only after the first mail', () => {
    const steps = cleanSteps([mail({ id: 'dupl1234' }), mail({ id: 'dupl1234', delay_days: 9999, delay_hours: 99, subject: '', reply_in_thread: true })], mint);
    expect(new Set(steps.map((s) => s.id)).size).toBe(2);
    expect(steps[1]).toMatchObject({ delay_days: 120, delay_hours: 23, reply_in_thread: true });
    expect(() => cleanSteps([mail({ subject: '', reply_in_thread: true })], mint)).toThrow(/Betreff/);
  });

  it('variants: at most three, an empty field takes the main mail’s text', () => {
    const [s] = cleanSteps([mail({ variants: [{ subject: 'B-Betreff' }, { body: 'B-Text', label: 'Kurz' }, {}, { subject: 'D' }, { subject: 'E' }] })], mint);
    expect(s.variants).toHaveLength(3);
    expect(s.variants[0]).toMatchObject({ label: 'Variante B', subject: 'B-Betreff', body: 'Text' });
    expect(s.variants[1]).toMatchObject({ label: 'Kurz', subject: 'Hallo {{contact.first_name|}}', body: 'B-Text' });
  });
});

describe('business hours', () => {
  const berlin: Window = { ...DEFAULT_WINDOW, tz: '' };
  const tz = 'Europe/Berlin';
  const at = (iso: string) => new Date(iso);

  it('knows when it is inside the window (Berlin time, summer and winter)', () => {
    // Mon 2026-06-01 09:30 Berlin = 07:30 UTC; Mon 2026-12-07 09:30 Berlin = 08:30 UTC
    expect(inWindow(at('2026-06-01T07:30:00Z'), berlin, tz)).toBe(true);
    expect(inWindow(at('2026-06-01T06:30:00Z'), berlin, tz)).toBe(false); // 08:30 local
    expect(inWindow(at('2026-06-01T15:00:00Z'), berlin, tz)).toBe(false); // 17:00 local: the end is exclusive
    expect(inWindow(at('2026-12-07T08:30:00Z'), berlin, tz)).toBe(true);
    expect(inWindow(at('2026-06-06T08:00:00Z'), berlin, tz)).toBe(false); // Saturday
    expect(inWindow(at('2026-06-06T08:00:00Z'), { ...berlin, enabled: false }, tz)).toBe(true);
  });

  it('moves a moment outside the window to the next opening (weekend, evening, before work)', () => {
    const w = { ...berlin };
    // Saturday noon → Monday 09:00 Berlin (07:00 UTC) without jitter
    expect(nextSlot(at('2026-06-06T10:00:00Z'), w, tz, '', 0).toISOString()).toBe('2026-06-08T07:00:00.000Z');
    // Friday 19:00 local → Monday
    expect(nextSlot(at('2026-06-05T17:00:00Z'), w, tz, '', 0).toISOString()).toBe('2026-06-08T07:00:00.000Z');
    // Tuesday 06:00 local → Tuesday 09:00
    expect(nextSlot(at('2026-06-02T04:00:00Z'), w, tz, '', 0).toISOString()).toBe('2026-06-02T07:00:00.000Z');
    // inside → unchanged
    const inside = at('2026-06-02T10:00:00Z');
    expect(nextSlot(inside, w, tz, 'x').getTime()).toBe(inside.getTime());
    // winter time: Monday 09:00 Berlin = 08:00 UTC
    expect(nextSlot(at('2026-12-05T10:00:00Z'), w, tz, '', 0).toISOString()).toBe('2026-12-07T08:00:00.000Z');
  });

  it('crosses the clock change correctly (Monday after the last Sunday of March)', () => {
    // Sat 2026-03-28 → Mon 2026-03-30 09:00 is CEST (+2) = 07:00 UTC
    expect(nextSlot(at('2026-03-28T12:00:00Z'), berlin, tz, '', 0).toISOString()).toBe('2026-03-30T07:00:00.000Z');
  });

  it('jitter is small, repeatable and stays inside the window', () => {
    expect(jitterMinutes('abc', 15)).toBe(jitterMinutes('abc', 15));
    for (const s of ['a', 'b', 'c', 'd', 'e', 'f']) expect(jitterMinutes(s, 15)).toBeLessThanOrEqual(15);
    const s = nextSlot(at('2026-06-06T10:00:00Z'), berlin, tz, 'enrolment-1');
    expect(s.getTime()).toBeGreaterThanOrEqual(at('2026-06-08T07:00:00Z').getTime());
    expect(s.getTime()).toBeLessThanOrEqual(at('2026-06-08T07:15:00Z').getTime());
    const narrow = cleanWindow({ days: ['mon'], from: '09:00', to: '09:20' });
    expect(nextSlot(at('2026-06-06T10:00:00Z'), narrow, tz, 'x', 15).getTime() - at('2026-06-08T07:00:00Z').getTime()).toBeLessThanOrEqual(5 * 60_000);
  });

  it('a step is due after its delay, inside the window', () => {
    // sent Friday 16:00 local, next step 2 days later = Sunday → Monday 09:00
    const sent = at('2026-06-05T14:00:00Z');
    expect(dueAt(sent, { delay_days: 2, delay_hours: 0 }, berlin, tz, '').getTime()).toBeGreaterThanOrEqual(at('2026-06-08T07:00:00Z').getTime());
    expect(dueAt(sent, { delay_days: 0, delay_hours: 2 }, { ...berlin, enabled: false }, tz, '').toISOString()).toBe('2026-06-05T16:00:00.000Z');
  });

  it('validates the window', () => {
    expect(cleanWindow({ days: ['mon', 'xyz', 'wed'], from: '08:00', to: '12:30', tz: 'Europe/Wien' }, (z) => z === 'Europe/Vienna')).toMatchObject({ days: ['mon', 'wed'], from: '08:00', to: '12:30', tz: '' });
    expect(() => cleanWindow({ from: '17:00', to: '09:00' })).toThrow(/vor/);
    expect(() => cleanWindow({ days: [] })).toThrow(/Wochentag/);
    expect(cleanWindow({ enabled: false, days: [] }).enabled).toBe(false);
    expect(cleanWindow(undefined)).toEqual(DEFAULT_WINDOW);
  });
});

describe('settings and variants', () => {
  it('merges settings over the current ones', () => {
    const s = cleanSettings({ stop_on: { stage_change: true, reply: false }, footer: false });
    expect(s.stop_on).toEqual({ reply: false, meeting: true, stage_change: true, deal_closed: true });
    expect(s.footer).toBe(false);
    expect(s.window).toEqual(DEFAULT_SETTINGS.window);
    expect(cleanSettings({ shared_mailbox: true }, undefined, s)).toMatchObject({ shared_mailbox: true, footer: false });
  });

  it('shares people evenly between the variants and gives the same person the same one', () => {
    const [step] = cleanSteps([mail({ id: 'ab123456', variants: [{ subject: 'B' }] })], mint);
    const counts = new Map<string, number>();
    for (let i = 0; i < 400; i++) {
      const v = pickVariant(step, `enrolment-${i}`);
      counts.set(v.id, (counts.get(v.id) ?? 0) + 1);
      expect(pickVariant(step, `enrolment-${i}`).id).toBe(v.id);
    }
    expect(counts.get('')!).toBeGreaterThan(150);
    expect(counts.get(step.variants[0].id)!).toBeGreaterThan(150);
    const [plain] = cleanSteps([mail()], mint);
    expect(pickVariant(plain, 'x')).toMatchObject({ id: '', subject: plain.subject });
  });

  it('the unsubscribe line names the link', () => {
    expect(footerText('https://x.example/u/1/2')).toContain('https://x.example/u/1/2');
  });
});
