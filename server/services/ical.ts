import { addDaysYmd, isValidTz, zonedToUtc } from '../core/time.js';

/** A busy period from an outside calendar. */
export interface BusyEvent {
  start_at: string;
  end_at: string;
  summary: string;
  uid: string;
}

/** Outlook writes Windows zone names; map the common ones. */
const WINDOWS_TZ: Record<string, string> = {
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris',
  'GMT Standard Time': 'Europe/London',
  'UTC': 'UTC',
  'Eastern Standard Time': 'America/New_York',
  'Pacific Standard Time': 'America/Los_Angeles',
};

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

function unfold(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function parseLine(line: string): Prop | undefined {
  const i = line.indexOf(':');
  if (i < 0) return undefined;
  const [name, ...params] = line.slice(0, i).split(';');
  const p: Record<string, string> = {};
  for (const kv of params) {
    const [k, v] = kv.split('=');
    if (k && v !== undefined) p[k.toUpperCase()] = v.replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params: p, value: line.slice(i + 1) };
}

/** An ICS date/time to an instant; all-day dates come back flagged. */
export function parseIcsDate(prop: Prop, fallbackTz: string): { at: Date; allDay: boolean } | undefined {
  const v = prop.value.trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return undefined;
  const ymd = `${m[1]}-${m[2]}-${m[3]}`;
  if (!m[4]) return { at: zonedToUtc(ymd, '00:00', fallbackTz), allDay: true };
  const hm = `${m[4]}:${m[5]}`;
  if (m[7]) return { at: new Date(`${ymd}T${hm}:${m[6] ?? '00'}Z`), allDay: false };
  let tz = prop.params.TZID ? WINDOWS_TZ[prop.params.TZID] ?? prop.params.TZID : fallbackTz;
  if (!isValidTz(tz)) tz = fallbackTz;
  return { at: zonedToUtc(ymd, hm, tz), allDay: false };
}

const DAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/**
 * Busy events between `from` and `to`. Handles single events, DAILY/WEEKLY/MONTHLY repeats with
 * INTERVAL, COUNT, UNTIL, BYDAY (weekly) and EXDATE; skips free (TRANSPARENT) and cancelled events.
 */
export function parseIcsBusy(text: string, from: Date, to: Date, fallbackTz = 'Europe/Berlin'): BusyEvent[] {
  const out: BusyEvent[] = [];
  let ev: Prop[] | null = null;
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') ev = [];
    else if (line === 'END:VEVENT') {
      if (ev) out.push(...expand(ev, from, to, fallbackTz));
      ev = null;
    } else if (ev) {
      const p = parseLine(line);
      if (p) ev.push(p);
    }
  }
  return out;
}

function expand(props: Prop[], from: Date, to: Date, tz: string): BusyEvent[] {
  const get = (n: string) => props.find((p) => p.name === n);
  if (get('TRANSP')?.value === 'TRANSPARENT' || get('STATUS')?.value === 'CANCELLED') return [];
  const dtstart = get('DTSTART');
  if (!dtstart) return [];
  const start = parseIcsDate(dtstart, tz);
  if (!start) return [];
  const dtend = get('DTEND');
  const end = dtend ? parseIcsDate(dtend, tz) : undefined;
  let duration = end ? end.at.getTime() - start.at.getTime() : start.allDay ? 864e5 : 0;
  const dur = get('DURATION')?.value.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/);
  if (!end && dur) duration = ((+dur[1] || 0) * 24 * 60 + (+dur[2] || 0) * 60 + (+dur[3] || 0)) * 60_000;
  if (duration <= 0) return [];
  const summary = get('SUMMARY')?.value ?? '';
  const uid = get('UID')?.value ?? '';
  const ex = new Set(
    props
      .filter((p) => p.name === 'EXDATE')
      .flatMap((p) => p.value.split(',').map((v) => parseIcsDate({ ...p, value: v }, tz)?.at.getTime()))
      .filter((x): x is number => typeof x === 'number'),
  );
  const push = (s: Date, list: BusyEvent[]) => {
    const e = new Date(s.getTime() + duration);
    if (e > from && s < to && !ex.has(s.getTime())) list.push({ start_at: s.toISOString(), end_at: e.toISOString(), summary, uid });
  };
  const list: BusyEvent[] = [];
  const rrule = get('RRULE');
  if (!rrule) {
    push(start.at, list);
    return list;
  }
  const r = Object.fromEntries(rrule.value.split(';').map((kv) => kv.split('=') as [string, string]));
  const freq = r.FREQ;
  const interval = Math.max(1, Number(r.INTERVAL) || 1);
  const count = r.COUNT ? Number(r.COUNT) : Infinity;
  const until = r.UNTIL ? parseIcsDate({ name: 'UNTIL', params: {}, value: r.UNTIL }, tz)?.at : undefined;
  const byDay = r.BYDAY ? r.BYDAY.split(',').map((d: string) => DAY.indexOf(d.slice(-2))).filter((d: number) => d >= 0) : [];
  if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(freq)) {
    push(start.at, list);
    return list;
  }
  // Walk occurrences in the event's wall-clock time so DST shifts keep the local hour.
  const localHm = new Intl.DateTimeFormat('de-DE', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(start.at);
  const localYmd = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(start.at);
  const at = (ymd: string) => (start.allDay ? zonedToUtc(ymd, '00:00', tz) : zonedToUtc(ymd, localHm, tz));
  let n = 0;
  const limit = 2000;
  if (freq === 'DAILY') {
    for (let i = 0; n < count && i < limit * interval; i += interval) {
      const s = at(addDaysYmd(localYmd, i));
      if (until && s > until) break;
      if (s > to) break;
      n++;
      push(s, list);
    }
  } else if (freq === 'WEEKLY') {
    const days = byDay.length ? byDay : [new Date(`${localYmd}T12:00:00Z`).getUTCDay()];
    const weekStart = addDaysYmd(localYmd, -new Date(`${localYmd}T12:00:00Z`).getUTCDay());
    outer: for (let w = 0; w < limit; w += interval) {
      for (const d of [...days].sort()) {
        const ymd = addDaysYmd(weekStart, w * 7 + d);
        if (ymd < localYmd) continue;
        const s = at(ymd);
        if ((until && s > until) || n >= count || s > to) break outer;
        n++;
        push(s, list);
      }
    }
  } else {
    const [y, m, d] = localYmd.split('-').map(Number);
    for (let i = 0; n < count && i < limit; i += interval) {
      const t = new Date(Date.UTC(y, m - 1 + i, d));
      if (t.getUTCDate() !== d) continue;
      const s = at(t.toISOString().slice(0, 10));
      if ((until && s > until) || s > to) break;
      n++;
      push(s, list);
    }
  }
  return list;
}

/** Appointments as an ICS feed for subscribing in Google/Outlook/Apple. */
export function icsFeed(name: string, events: { id: string; start_at: string; end_at: string; title: string; description?: string; status?: string }[]): string {
  const fmt = (s: string) => s.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (s: string) => s.replace(/[\;,]/g, (m) => '\\' + m).replace(/\n/g, '\\n');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//HyperLevel//DE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${esc(name)}`];
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      // Stable UID suffix (the project's first name): subscribed calendars must not see duplicates after an update.
      `UID:${e.id}@private-ghl`,
      `DTSTAMP:${fmt(new Date().toISOString())}`,
      `DTSTART:${fmt(e.start_at)}`,
      `DTEND:${fmt(e.end_at)}`,
      `SUMMARY:${esc(e.title)}`,
      ...(e.description ? [`DESCRIPTION:${esc(e.description)}`] : []),
      `STATUS:${e.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
