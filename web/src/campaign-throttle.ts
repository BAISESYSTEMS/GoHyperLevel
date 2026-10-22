import { intlLocale, tr } from './i18n';

/** Helpers for the sending-speed box of campaigns (pure, tested without a browser). Texts in the UI language (campaigns catalog). */

/** Speeds offered in the list (messages per hour); anything between 10 and 50 000 can be typed. */
export const SPEEDS = [50, 100, 250, 500, 1000, 2500, 5000];
export const MIN_SPEED = 10;
export const MAX_SPEED = 50_000;

const de = (n: number) => n.toLocaleString(intlLocale());

/** "25 Min.", "2 Std. 29 Min.", "3 Tage 4 Std." – how long the sending takes. */
export function durationText(minutes: number): string {
  const t = tr('campaigns');
  const m = Math.max(0, Math.round(minutes));
  if (m < 1) return t('unter 1 Min.');
  if (m < 60) return t('{n} Min.', { n: m });
  if (m < 60 * 24) return m % 60 ? t('{h} Std. {m} Min.', { h: Math.floor(m / 60), m: m % 60 }) : t('{h} Std.', { h: Math.floor(m / 60) });
  const days = Math.floor(m / 1440);
  const hours = Math.round((m % 1440) / 60);
  return hours ? t.plural(days, { one: '{n} Tag {h} Std.', other: '{n} Tage {h} Std.' }, { h: hours }) : t.plural(days, { one: '{n} Tag', other: '{n} Tage' });
}

/** "Dauer ca. 2 Std. 29 Min. für 1.240 Empfänger – fertig gegen 14:35 Uhr." (with the day when it is not today). */
export function etaText(remaining: number, perHour: number, at: Date = new Date()): string {
  if (!(remaining > 0) || !(perHour > 0)) return '';
  const minutes = Math.ceil((remaining / perHour) * 60);
  const end = new Date(at.getTime() + minutes * 60_000);
  const sameDay = end.toDateString() === at.toDateString();
  const when = sameDay ? end.toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' }) : end.toLocaleString(intlLocale(), { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const t = tr('campaigns');
  const vars = { duration: durationText(minutes), n: de(remaining), when };
  return sameDay ? t.plural(remaining, { other: 'Dauer ca. {duration} für {n} Empfänger – fertig gegen {when} Uhr.' }, vars) : t.plural(remaining, { other: 'Dauer ca. {duration} für {n} Empfänger – fertig am {when} Uhr.' }, vars);
}

/** The value of the speed field as the server wants it: null for the standard, a whole number otherwise (NaN when invalid). */
export function speedValue(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= MIN_SPEED && n <= MAX_SPEED ? n : Number.NaN;
}
