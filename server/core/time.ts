/** Timezone helpers built on Intl, so no date library is needed. */

/** Intl.DateTimeFormat is expensive to construct (tens of µs) – one instance per locale + options. */
const formats = new Map<string, Intl.DateTimeFormat>();
function format(locale: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(opts)}`;
  let f = formats.get(key);
  if (!f) {
    if (formats.size > 500) formats.clear();
    formats.set(key, (f = new Intl.DateTimeFormat(locale, opts)));
  }
  return f;
}

/** Minutes the zone is ahead of UTC at the given instant (Berlin in summer: 120). */
export function tzOffsetMinutes(at: Date, tz: string): number {
  const parts = format('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

/** The instant at which the wall clock in `tz` shows `ymd` `hm`. */
export function zonedToUtc(ymd: string, hm: string, tz: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const [hh, mm] = hm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let off = tzOffsetMinutes(new Date(guess), tz);
  let t = guess - off * 60000;
  const off2 = tzOffsetMinutes(new Date(t), tz);
  if (off2 !== off) {
    off = off2;
    t = guess - off * 60000;
  }
  return new Date(t);
}

/** 'YYYY-MM-DD' of the instant in the zone. */
export function ymdInTz(at: Date, tz: string): string {
  return format('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type DayKey = (typeof DAY_KEYS)[number];

export function weekdayKey(ymd: string): DayKey {
  const [y, m, d] = ymd.split('-').map(Number);
  return DAY_KEYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

export function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Calendar days from `from` to `to` (both YYYY-MM-DD); negative when `to` is the earlier day. */
export function daysBetweenYmd(from: string, to: string): number {
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 864e5);
}

/** The instant (ISO) at which the local day `offsetDays` after the day of `at` in `tz` begins – `offsetDays` 0 is today's midnight. */
export function localDayStart(tz: string, at: Date = new Date(), offsetDays = 0): string {
  return zonedToUtc(addDaysYmd(ymdInTz(at, tz), offsetDays), '00:00', tz).toISOString();
}

export function formatInTz(at: Date | string, tz: string, opts: Intl.DateTimeFormatOptions = {}): string {
  return format('de-DE', {
    timeZone: tz,
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...opts,
  }).format(typeof at === 'string' ? new Date(at) : at);
}

export function hmInTz(at: Date, tz: string): string {
  return format('de-DE', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
}

export function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
