import { describe, expect, it } from 'vitest';
import { LEVEL_LABEL, MIN_SAMPLE, THRESHOLDS, judge, rates, worse } from '../server/services/mk-reputation.js';
import { PLAN_INFO, WARMUP_PLANS, WARMUP_TARGET, dailyCap, niceRound, schedule, totalDays, warmupDay, warmupState } from '../server/services/mk-warmup.js';

describe('warm-up plan: daily caps that rise', () => {
  it('starts low, never falls and ends in "no cap"', () => {
    for (const plan of WARMUP_PLANS) {
      const days = schedule(plan);
      expect(days[0].cap).toBe(niceRound(PLAN_INFO[plan].start));
      for (let i = 1; i < days.length; i++) expect(days[i].cap, `${plan} day ${i + 1}`).toBeGreaterThanOrEqual(days[i - 1].cap);
      expect(days[days.length - 1].cap).toBeLessThan(WARMUP_TARGET);
      // After the schedule the sender is warmed up: no cap any more.
      expect(dailyCap(plan, days.length + 1)).toBeNull();
      expect(dailyCap(plan, 500)).toBeNull();
      expect(totalDays(plan)).toBe(days.length);
    }
  });

  it('the plans differ in speed: fast < standard < conservative days', () => {
    expect(totalDays('fast')).toBeLessThan(totalDays('standard'));
    expect(totalDays('standard')).toBeLessThan(totalDays('conservative'));
    expect(totalDays('standard')).toBeGreaterThanOrEqual(24);
    expect(totalDays('standard')).toBeLessThanOrEqual(32);
    expect(dailyCap('standard', 1)).toBe(50);
    expect(dailyCap('standard', 2)).toBe(65);
    expect(dailyCap('conservative', 1)).toBe(20);
    expect(dailyCap('fast', 1)).toBe(100);
    // Day 0 or a negative number counts as the first day.
    expect(dailyCap('standard', 0)).toBe(50);
  });

  it('rounds caps to numbers people recognise', () => {
    expect(niceRound(21)).toBe(20);
    expect(niceRound(87)).toBe(85);
    expect(niceRound(333)).toBe(330);
    expect(niceRound(2761)).toBe(2750);
    expect(niceRound(12_340)).toBe(12_500);
  });

  it('counts days in the sub-account time zone', () => {
    // 23:30 UTC is already the next day in Berlin (summer time).
    const started = '2026-06-10T21:30:00.000Z'; // 23:30 on the 10th in Berlin
    expect(warmupDay(started, new Date('2026-06-10T21:45:00.000Z'), 'Europe/Berlin')).toBe(1);
    expect(warmupDay(started, new Date('2026-06-10T22:30:00.000Z'), 'Europe/Berlin')).toBe(2);
    expect(warmupDay(started, new Date('2026-06-12T09:00:00.000Z'), 'Europe/Berlin')).toBe(3);
  });

  it('says how much may still go out today, and halves the cap when the numbers are bad', () => {
    const base = { plan: 'standard' as const, startedAt: '2026-06-01T08:00:00.000Z', at: new Date('2026-06-01T12:00:00.000Z'), tz: 'Europe/Berlin' };
    const day1 = warmupState({ ...base, sentToday: 20 });
    expect(day1).toMatchObject({ active: true, day: 1, cap: 50, remaining: 30, sent_today: 20, reduced: false, done: false, paused: false });
    expect(day1.upcoming[0]).toMatchObject({ day: 2, cap: 65, date: '2026-06-02' });
    expect(warmupState({ ...base, sentToday: 60 }).remaining).toBe(0);
    expect(warmupState({ ...base, sentToday: 0, trouble: true })).toMatchObject({ cap: 25, remaining: 25, reduced: true });
    // paused = the limit is off; done = the plan is through
    expect(warmupState({ ...base, sentToday: 0, paused: true })).toMatchObject({ active: false, paused: true, cap: null, remaining: null });
    const done = warmupState({ ...base, at: new Date('2026-09-01T12:00:00.000Z'), sentToday: 0 });
    expect(done).toMatchObject({ done: true, active: false, cap: null, remaining: null });
  });
});

describe('reputation: thresholds and warnings', () => {
  const counts = (o: Partial<Record<'sent' | 'bounced' | 'complained' | 'unsubscribed' | 'opened' | 'clicked', number>>) => ({ sent: 1000, bounced: 0, complained: 0, unsubscribed: 0, opened: 0, clicked: 0, ...o });

  it('computes the rates', () => {
    expect(rates(counts({ bounced: 20, complained: 2, unsubscribed: 5, opened: 400, clicked: 80 }))).toEqual({ bounce: 0.02, complaint: 0.002, unsubscribe: 0.005, open: 0.4, click: 0.08 });
    expect(rates({ sent: 0, bounced: 0, complained: 0, unsubscribed: 0, opened: 0, clicked: 0 }).bounce).toBe(0);
  });

  it('bounce: warn from 2 %, critical from 5 %', () => {
    expect(judge(counts({ bounced: 19 })).level).toBe('ok');
    const warn = judge(counts({ bounced: 20 }));
    expect(warn.level).toBe('warn');
    expect(warn.issues[0]).toMatchObject({ metric: 'bounce', level: 'warn' });
    expect(warn.issues[0].text).toContain('2 %');
    expect(judge(counts({ bounced: 50 })).level).toBe('critical');
  });

  it('complaints: warn from 0.1 %, critical from 0.3 % (the Gmail/Yahoo limit)', () => {
    expect(judge(counts({ complained: 0 })).level).toBe('ok');
    expect(judge(counts({ complained: 1 })).level).toBe('warn');
    expect(judge(counts({ complained: 2 })).level).toBe('warn');
    expect(judge(counts({ complained: 3 })).level).toBe('critical');
    expect(THRESHOLDS.complaint.critical).toBe(0.003);
  });

  it('unsubscribes: warn from 0.5 %, critical from 1 %', () => {
    expect(judge(counts({ unsubscribed: 4 })).level).toBe('ok');
    expect(judge(counts({ unsubscribed: 5 })).level).toBe('warn');
    expect(judge(counts({ unsubscribed: 10 })).level).toBe('critical');
  });

  it('the worst metric decides and every issue comes with a tip', () => {
    const j = judge(counts({ bounced: 60, complained: 1, unsubscribed: 6 }));
    expect(j.level).toBe('critical');
    expect(j.issues.map((i) => i.metric).sort()).toEqual(['bounce', 'complaint', 'unsubscribe']);
    for (const i of j.issues) expect(i.tip.length).toBeGreaterThan(30);
  });

  it('says "zu wenig Daten" for small sends, but still warns when complaints pile up', () => {
    expect(MIN_SAMPLE).toBe(100);
    const few = judge({ sent: 40, bounced: 10, complained: 1, unsubscribed: 3, opened: 5, clicked: 1 });
    expect(few.level).toBe('few');
    expect(few.issues).toEqual([]);
    expect(judge({ sent: 40, bounced: 0, complained: 2, unsubscribed: 0, opened: 5, clicked: 1 }).level).toBe('critical');
    expect(LEVEL_LABEL.few).toBe('zu wenig Daten');
  });

  it('orders levels', () => {
    expect(worse('ok', 'warn')).toBe('warn');
    expect(worse('critical', 'warn')).toBe('critical');
    expect(worse('few', 'ok')).toBe('few');
  });
});
