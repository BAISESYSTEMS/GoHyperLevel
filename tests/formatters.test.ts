import { describe, expect, it } from 'vitest';
import { addBusinessDays, addToDate, dateOp, diffDates, endOf, formatDate, isBusinessDay, nextInWindow, numberOp, parseDate, parseNumber, roundTo, startOf, textOp } from '../server/services/formatters.js';

/** The formatter library behind the Formatter steps: text, numbers, dates (time zones, daylight saving, business days) and time windows. */

const BER = 'Europe/Berlin';
const iso = (d: Date | null) => d?.toISOString();

describe('text formatting', () => {
  it('changes case, trims, replaces and cuts', () => {
    expect(textOp('upper', 'abc')).toBe('ABC');
    expect(textOp('capitalize', 'hallo welt')).toBe('Hallo welt');
    expect(textOp('collapse_spaces', '  a   b \n c ')).toBe('a b c');
    expect(textOp('replace', 'a-b-c', '-', '+')).toBe('a+b+c');
    expect(textOp('replace', 'abc', '', 'x')).toBe('abc');
    expect(textOp('left', 'Hallo', 2)).toBe('Ha');
    expect(textOp('right', 'Hallo', 3)).toBe('llo');
    expect(textOp('right', 'Hallo', 0)).toBe('');
    expect(textOp('substring', 'Hallo Welt', 6, 2)).toBe('We');
    expect(textOp('truncate', 'Ein langer Satz hier', 7)).toBe('Ein lan…');
    expect(textOp('truncate', 'kurz', 10)).toBe('kurz');
    expect(textOp('pad_left', '7', 3, '0')).toBe('007');
    expect(textOp('initials', 'anna maria muster')).toBe('AMM');
    expect(textOp('first_word', '  Erika Muster ')).toBe('Erika');
    expect(textOp('last_word', 'Erika Muster')).toBe('Muster');
    expect(textOp('default', '  ', 'n/a')).toBe('n/a');
    expect(textOp('default', 'x', 'n/a')).toBe('x');
    expect(textOp('length', 'Äpfel')).toBe(5);
    expect(textOp('word_count', ' eins  zwei drei ')).toBe(3);
    expect(textOp('line_count', 'a\nb\r\nc')).toBe(3);
    expect(textOp('reverse', 'abc')).toBe('cba');
    expect(textOp('remove_diacritics', 'Crème brûlée')).toBe('Creme brulee');
    expect(textOp('slug', 'Hallo Welt')).toBe('hallo-welt');
    expect(textOp('url_encode', 'a b&c')).toBe('a%20b%26c');
    expect(textOp('url_decode', '%E4%F6')).toBe('%E4%F6'); // broken escapes stay as they are
  });

  it('splits and extracts', () => {
    expect(textOp('split', 'a,b,c', ',')).toEqual(['a', 'b', 'c']);
    expect(textOp('split', 'a,b,c', ',', 1)).toBe('b');
    expect(textOp('split', 'a,b,c', ',', -1)).toBe('c');
    expect(textOp('split', 'a,b', ',', 9)).toBe('');
    expect(textOp('extract_email', 'Schreib an a.b+x@mail.example.de bitte')).toBe('a.b+x@mail.example.de');
    expect(textOp('extract_phone', 'Ruf +49 170 1234567 an')).toBe('+49 170 1234567');
    expect(textOp('extract_number', 'Betrag: 1.234,50 EUR.')).toBe('1.234,50');
    expect(textOp('extract_url', 'Siehe https://example.com/a?b=1, danke')).toBe('https://example.com/a?b=1,');
    expect(textOp('extract', 'Bestellung #4711 ok', '#(\\d+)')).toBe('4711');
    expect(textOp('extract', 'nichts', '\\d+')).toBe('');
    expect(textOp('phone', '0170 123 456')).toBe('+49170123456');
    expect(textOp('phone', '0170 123 456', '+43')).toBe('+43170123456');
  });

  it('regular expressions are safe: no catastrophic patterns, bounded input and output', () => {
    expect(textOp('regex_replace', 'a1b22c333', '\\d+', '#')).toBe('a#b#c#');
    expect(() => textOp('regex_replace', 'aaaa', '(a+)+$', 'x')).toThrow();
    expect(() => textOp('extract', 'aaaa', '(a*)*b')).toThrow();
    expect(() => textOp('regex_replace', 'x', '(', 'y')).toThrow();
    expect(() => textOp('repeat', 'abcdefghij', 50_000)).toThrow(/zu lang/);
    expect(textOp('repeat', 'ab', 3)).toBe('ababab');
    expect(() => textOp('gibtsnicht', 'x')).toThrow(/Unbekannte Text-Aktion/);
  });

  it('strips html to readable text', () => {
    expect(textOp('strip_html', '<p>Hallo <b>Welt</b></p><script>alert(1)</script>').toString().replace(/\s+/g, ' ').trim()).toBe('Hallo Welt');
  });
});

describe('number formatting', () => {
  it('reads German and English notation', () => {
    expect(parseNumber('1.234,56')).toBe(1234.56);
    expect(parseNumber('1,234.56')).toBe(1234.56);
    expect(parseNumber('12,5')).toBe(12.5);
    expect(parseNumber('1 234')).toBe(1234);
    expect(parseNumber('€ 12.50')).toBe(12.5);
    expect(parseNumber('1.234.567')).toBe(1234567);
    expect(parseNumber('(3)')).toBe(-3);
    expect(parseNumber('-4,5')).toBe(-4.5);
    expect(parseNumber('12 €')).toBe(12);
    expect(parseNumber(7)).toBe(7);
    expect(Number.isNaN(parseNumber('abc'))).toBe(true);
    expect(Number.isNaN(parseNumber(''))).toBe(true);
  });

  it('rounds without binary surprises and supports banker rounding', () => {
    expect(roundTo(1.005, 2)).toBe(1.01);
    expect(roundTo(2.675, 2)).toBe(2.68);
    expect(roundTo(-2.5, 0)).toBe(-3);
    expect(roundTo(2.5, 0, 'half_even')).toBe(2);
    expect(roundTo(3.5, 0, 'half_even')).toBe(4);
    expect(roundTo(1234.5678, 2)).toBe(1234.57);
    expect(numberOp('floor', '2.789', { digits: 2 })).toBe(2.78);
    expect(numberOp('ceil', '2.781', { digits: 2 })).toBe(2.79);
    expect(numberOp('abs', '-3')).toBe(3);
    expect(numberOp('sign', '-3')).toBe(-1);
    expect(numberOp('clamp', 15, { min: 0, max: 10 })).toBe(10);
    expect(numberOp('clamp', -5, { min: 0 })).toBe(0);
  });

  it('formats numbers, currencies and percentages the German way', () => {
    const plain = (s: string | number) => String(s).replace(/ | /g, ' ');
    expect(plain(numberOp('format', '1234.5'))).toBe('1.234,50');
    expect(plain(numberOp('format', '1234.5', { locale: 'en-US' }))).toBe('1,234.50');
    expect(plain(numberOp('format', '1234.5678', { digits: 1 }))).toBe('1.234,6');
    expect(plain(numberOp('currency', '1234.5'))).toBe('1.234,50 €');
    expect(plain(numberOp('currency', '99', { currency: 'usd', locale: 'en-US' }))).toBe('$99.00');
    expect(plain(numberOp('percent', '0.256'))).toBe('25,6 %');
    expect(numberOp('pad', 7, { width: 4 })).toBe('0007');
    expect(numberOp('fixed', '3.14159', { digits: 3 })).toBe('3.142');
    expect(numberOp('ordinal_de', '3.7')).toBe('3.');
    expect(numberOp('to_number', '1.234,5')).toBe(1234.5);
    expect(() => numberOp('round', 'viel')).toThrow(/keine Zahl/);
    expect(() => numberOp('gibtsnicht', 1)).toThrow(/Unbekannte Zahl-Aktion/);
  });
});

describe('dates: parsing and formatting', () => {
  it('reads ISO, German and epoch dates in the zone of the sub-account', () => {
    expect(iso(parseDate('2026-10-05', BER))).toBe('2026-10-04T22:00:00.000Z');
    expect(iso(parseDate('2026-10-05 14:30', BER))).toBe('2026-10-05T12:30:00.000Z');
    expect(iso(parseDate('05.10.2026 14:30', BER))).toBe('2026-10-05T12:30:00.000Z');
    expect(iso(parseDate('5.1.2026', BER))).toBe('2026-01-04T23:00:00.000Z');
    expect(iso(parseDate('2026-10-05T10:00:00+02:00', BER))).toBe('2026-10-05T08:00:00.000Z');
    expect(iso(parseDate('2026-10-05T10:00:00Z', 'Asia/Tokyo'))).toBe('2026-10-05T10:00:00.000Z');
    expect(iso(parseDate('2026-10-05 09:00', 'America/New_York'))).toBe('2026-10-05T13:00:00.000Z');
    expect(iso(parseDate(1790000000))).toBe('2026-09-21T14:13:20.000Z');
    expect(iso(parseDate('1790000000000'))).toBe('2026-09-21T14:13:20.000Z');
    expect(iso(parseDate('today', BER, new Date('2026-10-05T22:30:00Z')))).toBe('2026-10-05T22:00:00.000Z'); // already Tuesday in Berlin
    expect(parseDate('31.02.2026', BER)).toBeNull();
    expect(parseDate('2026-13-01', BER)).toBeNull();
    expect(parseDate('kein datum', BER)).toBeNull();
    expect(parseDate('', BER)).toBeNull();
  });

  it('formats in a zone with names, shortcuts and literal text', () => {
    const at = new Date('2026-12-31T13:30:00Z');
    expect(formatDate(at, 'datetime', BER)).toBe('31.12.2026 14:30');
    expect(formatDate(at, 'date', BER)).toBe('31.12.2026');
    expect(formatDate(at, 'long', BER)).toBe('Donnerstag, 31. Dezember 2026');
    expect(formatDate(at, 'long', BER, 'en')).toBe('Thursday, December 31, 2026');
    expect(formatDate(at, 'DD.MM.YY [um] HH:mm [Uhr]', BER)).toBe('31.12.26 um 14:30 Uhr');
    expect(formatDate(at, 'YYYY-MM-DD HH:mm Z', 'America/New_York')).toBe('2026-12-31 08:30 -05:00');
    expect(formatDate(new Date('2026-07-01T12:00:00Z'), 'HH:mm Z', BER)).toBe('14:00 +02:00');
    expect(formatDate(at, 'iso', BER)).toBe('2026-12-31T13:30:00.000Z');
    expect(formatDate(at, 'unix', BER)).toBe(String(Math.floor(at.getTime() / 1000)));
    expect(dateOp('convert_tz', '2026-07-01T12:00:00Z', { to_tz: 'America/New_York' })).toBe('2026-07-01T08:00:00-04:00');
    expect(dateOp('convert_tz', '2026-07-01T12:00:00Z', { to_tz: 'Kein/Ort' })).toBe('2026-07-01T14:00:00+02:00'); // unknown zone → default zone
    expect(dateOp('weekday', '2026-10-05', { tz: BER, lang: 'en' })).toBe('Monday');
    expect(dateOp('weekday', '2026-10-04', { tz: BER, pattern: 'number' })).toBe(7);
    expect(() => dateOp('format', 'nope')).toThrow(/kein Datum/);
  });
});

describe('dates: arithmetic across daylight saving time', () => {
  it('"+1 day" keeps the wall clock, "+24 hours" keeps the elapsed time', () => {
    const before = parseDate('2026-03-28 12:00', BER)!; // CET
    expect(iso(before)).toBe('2026-03-28T11:00:00.000Z');
    expect(iso(addToDate(before, 1, 'days', BER))).toBe('2026-03-29T10:00:00.000Z'); // 12:00 CEST, a 23-hour day
    expect(iso(addToDate(before, 24, 'hours', BER))).toBe('2026-03-29T11:00:00.000Z'); // 13:00 CEST
    expect(iso(addToDate(before, 1, 'weeks', BER))).toBe('2026-04-04T10:00:00.000Z');
    const autumn = parseDate('2026-10-24 12:00', BER)!; // CEST
    expect(iso(addToDate(autumn, 1, 'days', BER))).toBe('2026-10-25T11:00:00.000Z'); // 12:00 CET, a 25-hour day
    expect(iso(addToDate(autumn, 24, 'hours', BER))).toBe('2026-10-25T10:00:00.000Z'); // 11:00 CET
    expect(iso(addToDate(autumn, -1, 'days', BER))).toBe('2026-10-23T10:00:00.000Z');
    expect(iso(addToDate(before, 90, 'minutes', BER))).toBe('2026-03-28T12:30:00.000Z');
  });

  it('a time inside the spring gap moves to the first valid minute, an ambiguous autumn time resolves to the later one', () => {
    expect(iso(parseDate('2026-03-29 02:30', BER))).toBe('2026-03-29T01:30:00.000Z'); // 02:30 does not exist → 03:30 CEST
    expect(iso(parseDate('2026-03-29 03:30', BER))).toBe('2026-03-29T01:30:00.000Z');
    expect(iso(parseDate('2026-10-25 02:30', BER))).toBe('2026-10-25T01:30:00.000Z'); // 02:30 happens twice → the later (CET)
    expect(iso(parseDate('2026-10-25 01:30', BER))).toBe('2026-10-24T23:30:00.000Z');
    // a daily 02:30 job planned over the gap day lands at 03:30 local, the next day it is 02:30 again
    const gapDay = parseDate('2026-03-28 02:30', BER)!;
    expect(formatDate(addToDate(gapDay, 1, 'days', BER), 'datetime', BER)).toBe('29.03.2026 03:30');
    expect(formatDate(addToDate(gapDay, 2, 'days', BER), 'datetime', BER)).toBe('30.03.2026 02:30');
    // and in a zone without daylight saving nothing moves
    expect(iso(addToDate(parseDate('2026-03-28 12:00', 'Asia/Tokyo')!, 1, 'days', 'Asia/Tokyo'))).toBe('2026-03-29T03:00:00.000Z');
  });

  it('months and years clamp the day and keep the time', () => {
    expect(formatDate(addToDate(parseDate('2026-01-31 10:15', BER)!, 1, 'months', BER), 'datetime', BER)).toBe('28.02.2026 10:15');
    expect(formatDate(addToDate(parseDate('2028-01-31 10:15', BER)!, 1, 'months', BER), 'datetime', BER)).toBe('29.02.2028 10:15');
    expect(formatDate(addToDate(parseDate('2028-02-29 10:15', BER)!, 1, 'years', BER), 'datetime', BER)).toBe('28.02.2029 10:15');
    expect(formatDate(addToDate(parseDate('2026-11-30 10:15', BER)!, 3, 'months', BER), 'datetime', BER)).toBe('28.02.2027 10:15');
    expect(formatDate(addToDate(parseDate('2026-03-15 10:15', BER)!, -4, 'months', BER), 'datetime', BER)).toBe('15.11.2025 10:15');
    // a summer time, a month later in winter: the wall clock stays
    expect(iso(addToDate(parseDate('2026-09-30 12:00', BER)!, 1, 'months', BER))).toBe('2026-10-30T11:00:00.000Z');
    expect(() => addToDate(new Date(), 1, 'fortnights', BER)).toThrow(/Unbekannte Einheit/);
    expect(() => addToDate(new Date(), 1_000_000, 'days', BER)).toThrow(/zu groß/);
  });

  it('start and end of a day follow the real length of the day', () => {
    const springDay = parseDate('2026-03-29 15:00', BER)!;
    expect(iso(startOf(springDay, 'day', BER))).toBe('2026-03-28T23:00:00.000Z');
    expect(iso(endOf(springDay, 'day', BER))).toBe('2026-03-29T21:59:59.000Z'); // 23 hours later
    const autumnDay = parseDate('2026-10-25 15:00', BER)!;
    expect(iso(startOf(autumnDay, 'day', BER))).toBe('2026-10-24T22:00:00.000Z');
    expect(iso(endOf(autumnDay, 'day', BER))).toBe('2026-10-25T22:59:59.000Z'); // 25 hours later
    const wed = parseDate('2026-10-07 10:00', BER)!;
    expect(iso(startOf(wed, 'week', BER))).toBe('2026-10-04T22:00:00.000Z'); // Monday 5 Oct 00:00
    expect(iso(endOf(wed, 'week', BER))).toBe('2026-10-11T21:59:59.000Z');
    expect(iso(startOf(wed, 'month', BER))).toBe('2026-09-30T22:00:00.000Z');
    expect(iso(endOf(wed, 'month', BER))).toBe('2026-10-31T22:59:59.000Z'); // after the clocks went back
    expect(iso(startOf(wed, 'year', BER))).toBe('2025-12-31T23:00:00.000Z');
    expect(iso(startOf(wed, 'hour', BER))).toBe('2026-10-07T08:00:00.000Z');
    // Sunday belongs to the week that started on the Monday before
    expect(iso(startOf(parseDate('2026-10-11 12:00', BER)!, 'week', BER))).toBe('2026-10-04T22:00:00.000Z');
    expect(dateOp('start_of', '2026-10-07 10:00', { unit: 'day', tz: 'America/New_York' })).toBe('2026-10-07T04:00:00.000Z');
  });

  it('differences count whole calendar units of the zone', () => {
    const d = (s: string) => parseDate(s, BER)!;
    expect(diffDates(d('2026-03-28 12:00'), d('2026-03-29 12:00'), 'days', BER)).toBe(1); // 23 hours is still one day
    expect(diffDates(d('2026-03-28 12:00'), d('2026-03-29 12:00'), 'hours', BER)).toBe(23);
    expect(diffDates(d('2026-10-05 18:00'), d('2026-10-06 09:00'), 'days', BER)).toBe(0); // a partial day does not count
    expect(diffDates(d('2026-10-06 09:00'), d('2026-10-05 18:00'), 'days', BER)).toBe(0);
    expect(diffDates(d('2026-10-05 09:00'), d('2026-10-03 10:00'), 'days', BER)).toBe(-1);
    expect(diffDates(d('2026-01-31 10:00'), d('2026-02-28 09:00'), 'months', BER)).toBe(0);
    expect(diffDates(d('2026-01-31 10:00'), d('2026-03-31 10:00'), 'months', BER)).toBe(2);
    expect(diffDates(d('2020-02-29 00:00'), d('2026-02-28 00:00'), 'years', BER)).toBe(5);
    expect(diffDates(d('2026-10-05 08:00'), d('2026-10-19 08:00'), 'weeks', BER)).toBe(2);
    expect(dateOp('age', '1990-10-05', { other: '2026-10-04', tz: BER })).toBe(35);
    expect(dateOp('age', '1990-10-05', { other: '2026-10-05', tz: BER })).toBe(36);
  });
});

describe('business days', () => {
  // 2 Oct 2026 is a Friday, 3 Oct a Saturday (Tag der Deutschen Einheit), 5 Oct a Monday
  it('skips weekends and holidays in both directions', () => {
    expect(isBusinessDay('2026-10-02')).toBe(true);
    expect(isBusinessDay('2026-10-03')).toBe(false);
    expect(isBusinessDay('2026-10-04')).toBe(false);
    expect(addBusinessDays('2026-10-02', 1)).toBe('2026-10-05');
    expect(addBusinessDays('2026-10-05', -1)).toBe('2026-10-02');
    expect(addBusinessDays('2026-10-05', 5)).toBe('2026-10-12');
    expect(addBusinessDays('2026-10-03', 1)).toBe('2026-10-05'); // from a Saturday
    expect(addBusinessDays('2026-10-02', 0)).toBe('2026-10-02');
    expect(addBusinessDays('2026-10-02', 1, new Set(['2026-10-05']))).toBe('2026-10-06');
    expect(isBusinessDay('2026-10-07', new Set(['2026-10-07']))).toBe(false);
  });

  it('works on instants: wall clock kept, DST crossed, holidays from the step', () => {
    const fri = parseDate('2026-03-27 15:00', BER)!; // the weekend with the clock change
    expect(iso(addToDate(fri, 1, 'business_days', BER))).toBe('2026-03-30T13:00:00.000Z'); // Monday 15:00 CEST
    expect(dateOp('add', '2026-10-02 10:00', { amount: 1, unit: 'business_days', tz: BER, holidays: ['2026-10-05'] })).toBe('2026-10-06T08:00:00.000Z');
    expect(dateOp('subtract', '2026-10-05 10:00', { amount: 1, unit: 'business_days', tz: BER })).toBe('2026-10-02T08:00:00.000Z');
    expect(dateOp('next_business_day', '2026-10-02 10:00', { tz: BER })).toBe('2026-10-05T08:00:00.000Z');
    expect(dateOp('is_business_day', '2026-10-03', { tz: BER })).toBe('nein');
    expect(dateOp('is_business_day', '2026-10-05', { tz: BER })).toBe('ja');
    expect(diffDates(parseDate('2026-10-05 08:00', BER)!, parseDate('2026-10-12 08:00', BER)!, 'business_days', BER)).toBe(5);
    expect(diffDates(parseDate('2026-10-12 08:00', BER)!, parseDate('2026-10-05 08:00', BER)!, 'business_days', BER)).toBe(-5);
    expect(dateOp('set_time', '2026-10-05 08:00', { time: '17:45', tz: BER })).toBe('2026-10-05T15:45:00.000Z');
    expect(() => dateOp('set_time', '2026-10-05', { time: '25:00' })).toThrow(/HH:mm/);
  });
});

describe('time windows (business hours)', () => {
  const win = { days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '09:00', to: '17:00' };
  const next = (s: string, w = win) => iso(nextInWindow(parseDate(s, BER)!, w, BER));

  it('returns now inside the window and the next opening otherwise', () => {
    expect(next('2026-10-07 10:00')).toBe('2026-10-07T08:00:00.000Z'); // Wednesday, inside
    expect(next('2026-10-07 09:00')).toBe('2026-10-07T07:00:00.000Z'); // the opening minute counts as inside
    expect(next('2026-10-07 17:00')).toBe('2026-10-08T07:00:00.000Z'); // closing minute: tomorrow 09:00
    expect(next('2026-10-07 18:30')).toBe('2026-10-08T07:00:00.000Z');
    expect(next('2026-10-07 06:00')).toBe('2026-10-07T07:00:00.000Z'); // before opening: same day
    expect(next('2026-10-09 18:00')).toBe('2026-10-12T07:00:00.000Z'); // Friday evening → Monday
    expect(next('2026-10-03 12:00')).toBe('2026-10-05T07:00:00.000Z'); // Saturday → Monday
  });

  it('skips holidays and follows the zone through the clock change', () => {
    expect(next('2026-10-09 18:00', { ...win, holidays: ['2026-10-12'] })).toBe('2026-10-13T07:00:00.000Z');
    // winter: the same 09:00 is one hour later in UTC
    expect(next('2026-12-01 20:00')).toBe('2026-12-02T08:00:00.000Z');
    // opening hours that start inside the spring gap open at the first valid minute
    expect(iso(nextInWindow(new Date('2026-03-28T20:00:00Z'), { days: ['sun'], from: '02:30', to: '05:00' }, BER))).toBe('2026-03-29T01:30:00.000Z');
    // the same instant is "after hours" in Berlin but "inside" in New York
    const at = new Date('2026-10-07T16:00:00Z');
    expect(iso(nextInWindow(at, win, BER))).toBe('2026-10-08T07:00:00.000Z');
    expect(iso(nextInWindow(at, win, 'America/New_York'))).toBe(at.toISOString());
  });

  it('refuses nonsense windows and reports a window that can never open', () => {
    expect(() => nextInWindow(new Date(), { from: '17:00', to: '09:00' }, BER)).toThrow(/vor „bis“/);
    expect(nextInWindow(new Date('2026-10-07T10:00:00Z'), { days: ['nope'] }, BER)).toBeNull();
    expect(iso(nextInWindow(new Date('2026-10-07T21:00:00Z'), { from: '00:00', to: '24:00', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] }, BER))).toBe('2026-10-07T21:00:00.000Z');
  });
});
