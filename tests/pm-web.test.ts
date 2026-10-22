import { describe, expect, it } from 'vitest';
import { addDay, centsToEuros, dayOf, diffDay, eurosToCents, fmtHM, fmtHMS, fmtMinutes, isWeekend, isoWeek, mondayOf, parseDuration, relDay, timeOf, weekdayMon, zonedIso } from '../web/src/pages/pm-format';
import { dayOf as serverDayOf } from '../server/services/pm-core';

/** The planner's pure helpers in the browser: calendar days in the sub-account's zone, durations, local times. */

describe('days', () => {
  it('reads date-only values by their date and timed values in the sub-account zone', () => {
    expect(dayOf('2026-10-05T00:00:00.000Z', 'Pacific/Auckland')).toBe('2026-10-05');
    expect(dayOf('2026-10-05T23:30:00.000Z', 'Europe/Berlin')).toBe('2026-10-06');
    expect(dayOf('2026-10-05T23:30:00.000Z', 'America/Los_Angeles')).toBe('2026-10-05');
    expect(dayOf('2026-10-05T00:30:00.000Z', 'America/Los_Angeles')).toBe('2026-10-04');
    expect(dayOf(null, 'Europe/Berlin')).toBeNull();
    expect(dayOf('kaputt', 'Europe/Berlin')).toBeNull();
  });

  it('agrees with the server on every day', () => {
    const samples = ['2026-03-29T00:30:00.000Z', '2026-03-29T01:30:00.000Z', '2026-10-25T22:30:00.000Z', '2026-10-25T23:59:59.000Z', '2026-12-31T23:00:00.000Z', '2027-01-01T00:00:00.000Z', '2026-06-15T12:00:00.000Z'];
    for (const tz of ['Europe/Berlin', 'America/New_York', 'Asia/Kolkata', 'UTC']) for (const iso of samples) expect(dayOf(iso, tz), `${iso} in ${tz}`).toBe(serverDayOf(iso, tz));
  });

  it('does day arithmetic without time-zone surprises', () => {
    expect(addDay('2026-10-25', 1)).toBe('2026-10-26'); // the clock change in Europe is no problem for plain days
    expect(addDay('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDay('2028-02-28', 1)).toBe('2028-02-29');
    expect(diffDay('2026-10-01', '2026-10-31')).toBe(30);
    expect(diffDay('2026-10-05', '2026-10-01')).toBe(-4);
    expect(mondayOf('2026-10-04')).toBe('2026-09-28'); // a Sunday belongs to the week that began on Monday
    expect(mondayOf('2026-10-05')).toBe('2026-10-05');
    expect(weekdayMon('2026-10-05')).toBe(0);
    expect(isWeekend('2026-10-03')).toBe(true);
    expect(isWeekend('2026-10-05')).toBe(false);
  });

  it('numbers the weeks like ISO 8601', () => {
    expect(isoWeek('2026-01-01')).toBe(1);
    expect(isoWeek('2026-10-05')).toBe(41);
    expect(isoWeek('2026-12-31')).toBe(53);
    expect(isoWeek('2027-01-03')).toBe(53);
    expect(isoWeek('2027-01-04')).toBe(1);
  });

  it('names near days in words', () => {
    expect(relDay('2026-10-05', '2026-10-05')).toBe('Heute');
    expect(relDay('2026-10-06', '2026-10-05')).toBe('Morgen');
    expect(relDay('2026-10-04', '2026-10-05')).toBe('Gestern');
    expect(relDay('2026-10-09', '2026-10-05')).toMatch(/Fr.*09\.10\./);
  });
});

describe('local times', () => {
  it('turns a local day and time into the right instant, also around the clock change', () => {
    expect(zonedIso('2026-10-05', '09:00', 'Europe/Berlin')).toBe('2026-10-05T07:00:00.000Z'); // summer time, UTC+2
    expect(zonedIso('2026-12-01', '09:00', 'Europe/Berlin')).toBe('2026-12-01T08:00:00.000Z'); // winter time, UTC+1
    expect(zonedIso('2026-10-25', '01:30', 'Europe/Berlin')).toBe('2026-10-24T23:30:00.000Z'); // before the change at 03:00
    expect(zonedIso('2026-10-25', '04:00', 'Europe/Berlin')).toBe('2026-10-25T03:00:00.000Z'); // after it
    expect(zonedIso('2026-07-01', '12:00', 'America/New_York')).toBe('2026-07-01T16:00:00.000Z');
    expect(zonedIso('2026-07-01', '12:00', 'UTC')).toBe('2026-07-01T12:00:00.000Z');
  });

  it('shows the time of day of timed values only', () => {
    expect(timeOf('2026-10-05T12:30:00.000Z', 'Europe/Berlin')).toBe('14:30');
    expect(timeOf('2026-10-05T00:00:00.000Z', 'Europe/Berlin')).toBe('');
    expect(timeOf(null, 'Europe/Berlin')).toBe('');
  });
});

describe('durations and money', () => {
  it('reads durations the way people write them', () => {
    expect(parseDuration('1:30')).toBe(90);
    expect(parseDuration('0:45')).toBe(45);
    expect(parseDuration('2h')).toBe(120);
    expect(parseDuration('1,5h')).toBe(90);
    expect(parseDuration('1.5 Std')).toBe(90);
    expect(parseDuration('45m')).toBe(45);
    expect(parseDuration('45 min')).toBe(45);
    expect(parseDuration('45')).toBe(45);
    expect(parseDuration('1,5')).toBe(90);
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('bald')).toBeNull();
    expect(parseDuration('-5')).toBeNull();
  });

  it('writes durations', () => {
    expect(fmtMinutes(90)).toBe('1 Std. 30 Min.');
    expect(fmtMinutes(120)).toBe('2 Std.');
    expect(fmtMinutes(45)).toBe('45 Min.');
    expect(fmtMinutes(0)).toBe('');
    expect(fmtHM(5400)).toBe('1:30');
    expect(fmtHM(59)).toBe('0:00');
    expect(fmtHMS(3725)).toBe('01:02:05');
  });

  it('converts euros and cents without rounding errors', () => {
    expect(eurosToCents('95')).toBe(9500);
    expect(eurosToCents('95,50')).toBe(9550);
    expect(eurosToCents('0,1')).toBe(10);
    expect(eurosToCents('19.99')).toBe(1999);
    expect(eurosToCents('')).toBeNull();
    expect(eurosToCents('-3')).toBeNull();
    expect(eurosToCents('viel')).toBeNull();
    expect(centsToEuros(9550)).toBe('95,5');
    expect(centsToEuros(0)).toBe('0');
    expect(centsToEuros(null)).toBe('');
  });
});
