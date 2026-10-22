import { describe, expect, it } from 'vitest';
import { RecurrenceError, anchorRule, cleanApptRecurrence, cutBefore, endsBy, parseRrule, remainingCount, seriesDates, toRrule } from '../server/services/appt-recur.js';

describe('appointment recurrence (RRULE subset)', () => {
  it('reads and writes the RRULE subset', () => {
    expect(parseRrule('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;COUNT=10')).toEqual({ freq: 'weekly', interval: 2, weekdays: [1, 4], end: { type: 'count', count: 10 } });
    expect(parseRrule('FREQ=MONTHLY;BYMONTHDAY=31;UNTIL=20270630T000000Z')).toEqual({ freq: 'monthly', interval: 1, day_of_month: 31, end: { type: 'date', date: '2027-06-30' } });
    const r = cleanApptRecurrence('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;COUNT=10')!;
    expect(toRrule(r)).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;COUNT=10');
    expect(toRrule(cleanApptRecurrence({ freq: 'daily' })!)).toBe('FREQ=DAILY');
    expect(toRrule(cleanApptRecurrence({ rrule: 'FREQ=MONTHLY;UNTIL=20261231' })!)).toBe('FREQ=MONTHLY;UNTIL=20261231');
    expect(cleanApptRecurrence('')).toBeNull();
    expect(cleanApptRecurrence(null)).toBeNull();
  });

  it('refuses what the subset does not cover', () => {
    const bad = (x: unknown) => () => cleanApptRecurrence(x);
    expect(bad('FREQ=YEARLY')).toThrow(RecurrenceError);
    expect(bad({ freq: 'yearly' })).toThrow('täglich, wöchentlich oder monatlich');
    expect(bad('FREQ=WEEKLY;BYDAY=1MO')).toThrow('BYDAY ungültig');
    expect(bad('FREQ=DAILY;BYDAY=MO')).toThrow('BYDAY nur bei FREQ=WEEKLY');
    expect(bad('FREQ=WEEKLY;BYSETPOS=1')).toThrow('BYSETPOS wird nicht unterstützt');
    expect(bad('FREQ=WEEKLY;COUNT=3;UNTIL=20270101')).toThrow('COUNT oder UNTIL');
    expect(bad({ freq: 'weekly', interval: 53 })).toThrow('zwischen 1 und 52');
    expect(bad({ freq: 'daily', end: { type: 'count', count: 501 } })).toThrow();
    expect(bad('kaputt')).toThrow(RecurrenceError);
    expect(bad(42)).toThrow(RecurrenceError);
  });

  it('lists the dates: weekly on given days, every N weeks, from a first day that may not fit', () => {
    const r = cleanApptRecurrence({ freq: 'weekly', interval: 2, weekdays: [1, 4], end: { type: 'count', count: 5 } })!;
    // 2026-10-14 is a Wednesday: the series starts on Thursday the 15th, Monday the 12th of the first week is already past.
    expect(seriesDates(r, '2026-10-14', '2027-12-31')).toEqual(['2026-10-15', '2026-10-26', '2026-10-29', '2026-11-09', '2026-11-12']);
    expect(seriesDates(cleanApptRecurrence({ freq: 'daily', interval: 3 })!, '2026-10-30', '2026-11-08')).toEqual(['2026-10-30', '2026-11-02', '2026-11-05', '2026-11-08']);
    // weekly without days: the first day's weekday
    expect(seriesDates(cleanApptRecurrence({ freq: 'weekly' })!, '2026-10-13', '2026-11-03')).toEqual(['2026-10-13', '2026-10-20', '2026-10-27', '2026-11-03']);
  });

  it('monthly on the 31st stays on the last day of shorter months instead of drifting', () => {
    const r = cleanApptRecurrence({ freq: 'monthly' })!;
    expect(seriesDates(r, '2027-01-31', '2027-05-31')).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31']);
    expect(anchorRule(r, '2027-01-31').day_of_month).toBe(31);
  });

  it('ends by count or date, cuts for "this and following", keeps the total count after a split', () => {
    const r = cleanApptRecurrence({ freq: 'weekly', end: { type: 'date', date: '2026-11-10' } })!;
    expect(seriesDates(r, '2026-10-13', '2027-01-01')).toEqual(['2026-10-13', '2026-10-20', '2026-10-27', '2026-11-03', '2026-11-10']);
    expect(endsBy(r, '2026-10-13', '2026-11-10')).toBe(true);
    expect(endsBy(r, '2026-10-13', '2026-11-03')).toBe(false);
    const cut = cutBefore(cleanApptRecurrence({ freq: 'weekly' })!, '2026-10-27');
    expect(cut.end).toEqual({ type: 'date', date: '2026-10-26' });
    expect(seriesDates(cut, '2026-10-13', '2027-01-01')).toEqual(['2026-10-13', '2026-10-20']);
    const counted = cleanApptRecurrence({ freq: 'weekly', end: { type: 'count', count: 6 } })!;
    expect(remainingCount(counted, '2026-10-13', '2026-10-27').end).toEqual({ type: 'count', count: 4 });
  });
});
