/** Pure helpers of the Webinare pages (no React, no browser): fields that take minutes or mm:ss, deep edits, labels. Tested in tests/webinar-ui.test.ts. */

export const WEEKDAYS: [string, string][] = [
  ['mon', 'Mo'],
  ['tue', 'Di'],
  ['wed', 'Mi'],
  ['thu', 'Do'],
  ['fri', 'Fr'],
  ['sat', 'Sa'],
  ['sun', 'So'],
];

/** "45" → 2700 s, "45:30" → 2730, "1:05:00" → 3900, "90 min" → 5400; anything else → null. */
export function parseDuration(text: string): number | null {
  const s = String(text ?? '').trim().toLowerCase();
  if (!s) return null;
  const colon = /^(\d{1,3})(?::([0-5]?\d))(?::([0-5]?\d))?$/.exec(s);
  if (colon) {
    const [a, b, c] = [Number(colon[1]), Number(colon[2]), colon[3] === undefined ? undefined : Number(colon[3])];
    return c === undefined ? a * 60 + b : a * 3600 + b * 60 + c;
  }
  const plain = /^(\d{1,4})(?:[.,](\d{1,2}))?\s*(min|minuten|m)?$/.exec(s);
  if (plain) return Math.round((Number(plain[1]) + (plain[2] ? Number(`0.${plain[2]}`) : 0)) * 60);
  return null;
}

/** 2730 → "45:30", 3905 → "1:05:05". */
export function fmtDuration(sec: number): string {
  const n = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** A moment in the video from a field: empty = 0, otherwise like a duration ("30" = 30 minutes, "12:30" = 12 min 30 s). */
export const parseMoment = (text: string): number | null => (String(text ?? '').trim() === '' ? 0 : parseDuration(text));

/** Sets a value deep inside an object without changing the original ("settings.room.label"). */
export function setIn<T>(obj: T, path: string, value: unknown): T {
  const keys = path.split('.');
  const walk = (cur: any, i: number): any => {
    const key = keys[i];
    const base = Array.isArray(cur) ? [...cur] : { ...(cur ?? {}) };
    base[key] = i === keys.length - 1 ? value : walk(cur?.[key], i + 1);
    return base;
  };
  return walk(obj, 0);
}
export const getIn = (obj: any, path: string): any => path.split('.').reduce((cur, k) => (cur === null || cur === undefined ? undefined : cur[k]), obj);

export const percent = (v: number | null | undefined) => (v === null || v === undefined ? '–' : `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(v * 100)} %`);
export const euros = (cents: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format((cents || 0) / 100);

/** "Mo., 9. Nov., 19:00 MEZ" – a session start in a time zone. */
export function fmtSession(startIso: string, tz: string): string {
  const d = new Date(startIso);
  if (Number.isNaN(d.getTime())) return startIso;
  try {
    return new Intl.DateTimeFormat('de-DE', { timeZone: tz || undefined, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(d);
  } catch {
    return d.toLocaleString('de-DE');
  }
}

/** Time zones for the picker: all the browser knows, else a short list. */
export function zones(): string[] {
  const fallback = ['Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich', 'Europe/London', 'Europe/Paris', 'Europe/Madrid', 'Europe/Rome', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Tokyo', 'Australia/Sydney', 'UTC'];
  try {
    const all = (Intl as any).supportedValuesOf?.('timeZone') as string[] | undefined;
    return all?.length ? [...new Set([...fallback.slice(0, 5), ...all])] : fallback;
  } catch {
    return fallback;
  }
}

/** The label of a stored video source for the editor. */
export function videoLabel(v: any): string {
  switch (v?.type) {
    case 'upload':
      return `Hochgeladene Datei${v.name ? `: ${v.name}` : ''}`;
    case 'url':
      return `Link: ${v.url}`;
    case 'youtube':
      return `YouTube: ${v.id}`;
    case 'vimeo':
      return `Vimeo: ${v.id}`;
    case 'studio_clip':
      return `Video-Studio-Clip${v.title ? `: ${v.title}` : ''}`;
    case 'studio_upload':
      return `Video-Studio-Upload${v.name ? `: ${v.name}` : ''}`;
    default:
      return 'Noch kein Video';
  }
}

