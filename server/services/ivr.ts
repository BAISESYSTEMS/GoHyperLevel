import { bad } from '../core/http.js';
import { normalizePhone } from '../core/util.js';
import { addDaysYmd, hmInTz, weekdayKey, ymdInTz, type DayKey } from '../core/time.js';
import { E164, attrs, say, twiml, xml } from './twilio.js';

/**
 * Pure building blocks of the telephone menu (IVR): the flow definition and its validation, schedules with
 * holidays, the routing decisions (which node comes next for a key press) and the TwiML of the interactive nodes.
 * No database, no network – modules/telephony-ivr.ts feeds it and runs the webhooks.
 */

// --- flow definition ---------------------------------------------------------------------------------

export const NODE_TYPES = ['menu', 'schedule', 'say', 'forward', 'group', 'voicemail', 'ai', 'hangup'] as const;
export type NodeType = (typeof NODE_TYPES)[number];
export const NODE_LABEL: Record<NodeType, string> = {
  menu: 'Menü (Tastenauswahl)',
  schedule: 'Zeitplan (Öffnungszeiten, Feiertage)',
  say: 'Ansage',
  forward: 'Weiterleiten (Nummern, Personen)',
  group: 'Ruf-Gruppe oder Warteschlange',
  voicemail: 'Voicemail',
  ai: 'KI-Telefonagent',
  hangup: 'Auflegen',
};

export const MAX_NODES = 60;
export const MAX_HOPS = 25;
const KEYS = '0123456789*#';

interface Base {
  id: string;
  type: NodeType;
  /** Name in the builder and in the call's path ("Hauptmenü"). */
  label: string;
  /** Position on the builder's canvas. */
  pos?: { x: number; y: number };
}
export interface MenuNode extends Base {
  type: 'menu';
  say: string;
  audio_id: string;
  /** Key → node id. */
  options: Record<string, string>;
  /** Key → what the key does, read out nowhere – only for the builder. */
  option_labels: Record<string, string>;
  on_timeout: string;
  on_invalid: string;
  retries: number;
  timeout: number;
}
export interface ScheduleNode extends Base {
  type: 'schedule';
  /** Schedule id; '' = the sub-account's business hours of the telephony settings. */
  schedule_id: string;
  open: string;
  closed: string;
  holiday: string;
}
export interface SayNode extends Base {
  type: 'say';
  say: string;
  audio_id: string;
  next: string;
}
export interface ForwardNode extends Base {
  type: 'forward';
  say: string;
  numbers: string[];
  users: string[];
  timeout: number;
  on_fail: string;
}
export interface GroupNode extends Base {
  type: 'group';
  group_id: string;
  on_fail: string;
}
export interface VoicemailNode extends Base {
  type: 'voicemail';
  /** Name of the mailbox, shown in the call log and the notification ("Vertrieb"). */
  box: string;
  say: string;
  audio_id: string;
  /** The callback task of a message goes to this person. */
  assign_user: string;
}
export interface AiNode extends Base {
  type: 'ai';
  on_fail: string;
}
export interface HangupNode extends Base {
  type: 'hangup';
  say: string;
}
export type IvrNode = MenuNode | ScheduleNode | SayNode | ForwardNode | GroupNode | VoicemailNode | AiNode | HangupNode;
export interface IvrFlow {
  start: string;
  nodes: Record<string, IvrNode>;
}

/** What exists in the sub-account – node references are checked against it when a flow is saved. */
export interface FlowRefs {
  groups: Set<string>;
  users: Set<string>;
  audio: Set<string>;
  schedules: Set<string>;
}

const NODE_ID = /^[a-z0-9][a-z0-9_-]{0,23}$/;
const str = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
const clampInt = (v: unknown, min: number, max: number, d: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

export const emptyFlow = (): IvrFlow => ({ start: 'start', nodes: { start: { id: 'start', type: 'menu', label: 'Hauptmenü', say: 'Willkommen. Für den Vertrieb drücken Sie die 1, für den Support die 2.', audio_id: '', options: {}, option_labels: {}, on_timeout: '', on_invalid: '', retries: 2, timeout: 6 } } });

/** Validates a flow from the browser and returns the clean version. Throws a German error naming the node. */
export function cleanFlow(raw: unknown, refs: FlowRefs): IvrFlow {
  if (!raw || typeof raw !== 'object') throw bad('Ablauf fehlt');
  const r = raw as { start?: unknown; nodes?: unknown };
  const list = Array.isArray(r.nodes) ? r.nodes : r.nodes && typeof r.nodes === 'object' ? Object.values(r.nodes) : null;
  if (!list?.length) throw bad('Der Ablauf braucht mindestens einen Schritt');
  if (list.length > MAX_NODES) throw bad(`Höchstens ${MAX_NODES} Schritte pro Ablauf`);
  const nodes: Record<string, IvrNode> = {};
  const ids = new Set<string>();
  for (const n of list) {
    const id = str((n as any)?.id, 40);
    if (!NODE_ID.test(id)) throw bad(`Schritt-ID „${id}“ ungültig (Kleinbuchstaben, Ziffern, - und _, höchstens 24 Zeichen)`);
    if (ids.has(id)) throw bad(`Schritt-ID „${id}“ kommt doppelt vor`);
    ids.add(id);
  }
  const target = (v: unknown, where: string, optional = true): string => {
    const t = str(v, 40);
    if (!t) {
      if (!optional) throw bad(`${where}: Ziel fehlt`);
      return '';
    }
    if (!ids.has(t)) throw bad(`${where}: Das Ziel „${t}“ gibt es nicht`);
    return t;
  };
  const audio = (v: unknown, where: string) => {
    const a = str(v, 40);
    if (a && !refs.audio.has(a)) throw bad(`${where}: Die Audiodatei gibt es nicht (mehr)`);
    return a;
  };
  for (const n of list as any[]) {
    const id = str(n.id, 40);
    const type = n.type as NodeType;
    if (!NODE_TYPES.includes(type)) throw bad(`Schritt „${id}“: unbekannter Typ`);
    const label = str(n.label, 60) || NODE_LABEL[type].split(' (')[0];
    const where = `„${label}“`;
    const pos = n.pos && Number.isFinite(Number(n.pos.x)) && Number.isFinite(Number(n.pos.y)) ? { x: clampInt(n.pos.x, -5000, 5000, 0), y: clampInt(n.pos.y, -5000, 5000, 0) } : undefined;
    const base = { id, label, ...(pos ? { pos } : {}) };
    switch (type) {
      case 'menu': {
        const options: Record<string, string> = {};
        const option_labels: Record<string, string> = {};
        for (const [k, v] of Object.entries(n.options ?? {})) {
          if (k.length !== 1 || !KEYS.includes(k)) throw bad(`${where}: Taste „${k}“ gibt es nicht (0–9, * und #)`);
          options[k] = target(v, `${where}, Taste ${k}`, false);
          const l = str(n.option_labels?.[k], 60);
          if (l) option_labels[k] = l;
        }
        const sayText = str(n.say, 1000);
        const audio_id = audio(n.audio_id, where);
        if (!sayText && !audio_id) throw bad(`${where}: Bitte eine Ansage eintragen`);
        nodes[id] = { ...base, type, say: sayText, audio_id, options, option_labels, on_timeout: target(n.on_timeout, `${where}, keine Eingabe`), on_invalid: target(n.on_invalid, `${where}, falsche Eingabe`), retries: clampInt(n.retries, 0, 5, 2), timeout: clampInt(n.timeout, 3, 20, 6) };
        break;
      }
      case 'schedule': {
        const sid = str(n.schedule_id, 40);
        if (sid && !refs.schedules.has(sid)) throw bad(`${where}: Den Zeitplan gibt es nicht (mehr)`);
        nodes[id] = { ...base, type, schedule_id: sid, open: target(n.open, `${where}, geöffnet`, false), closed: target(n.closed, `${where}, geschlossen`, false), holiday: target(n.holiday, `${where}, Feiertag`) };
        break;
      }
      case 'say': {
        const sayText = str(n.say, 1000);
        const audio_id = audio(n.audio_id, where);
        if (!sayText && !audio_id) throw bad(`${where}: Bitte eine Ansage eintragen`);
        nodes[id] = { ...base, type, say: sayText, audio_id, next: target(n.next, `${where}, danach`) };
        break;
      }
      case 'forward': {
        const numbers = (Array.isArray(n.numbers) ? n.numbers : []).map((x: unknown) => normalizePhone(str(x, 30))).filter(Boolean);
        for (const num of numbers) if (!E164.test(num)) throw bad(`${where}: ${num} ist keine gültige Nummer (Format +49…)`);
        const users = [...new Set((Array.isArray(n.users) ? n.users : []).map((x: unknown) => str(x, 64)).filter(Boolean))] as string[];
        for (const u of users) if (!refs.users.has(u)) throw bad(`${where}: Die Person gibt es in diesem Sub-Account nicht`);
        if (!numbers.length && !users.length) throw bad(`${where}: Bitte mindestens eine Nummer oder Person eintragen`);
        nodes[id] = { ...base, type, say: str(n.say, 500), numbers: numbers.slice(0, 10), users: users.slice(0, 10), timeout: clampInt(n.timeout, 5, 60, 20), on_fail: target(n.on_fail, `${where}, niemand erreichbar`) };
        break;
      }
      case 'group': {
        const gid = str(n.group_id, 40);
        if (!refs.groups.has(gid)) throw bad(`${where}: Bitte eine Ruf-Gruppe oder Warteschlange wählen`);
        nodes[id] = { ...base, type, group_id: gid, on_fail: target(n.on_fail, `${where}, niemand erreichbar`) };
        break;
      }
      case 'voicemail': {
        const assign = str(n.assign_user, 64);
        if (assign && !refs.users.has(assign)) throw bad(`${where}: Die Person für die Rückruf-Aufgabe gibt es nicht`);
        nodes[id] = { ...base, type, box: str(n.box, 60) || label, say: str(n.say, 1000), audio_id: audio(n.audio_id, where), assign_user: assign };
        break;
      }
      case 'ai':
        nodes[id] = { ...base, type, on_fail: target(n.on_fail, `${where}, KI nicht verfügbar`) };
        break;
      case 'hangup':
        nodes[id] = { ...base, type, say: str(n.say, 500) };
        break;
    }
  }
  const start = str(r.start, 40);
  if (!nodes[start]) throw bad('Der Startschritt fehlt');
  return { start, nodes };
}

/** Problems that do not stop saving but are worth fixing: unreachable steps, menus without keys, endless loops. */
export function flowIssues(flow: IvrFlow): string[] {
  const out: string[] = [];
  const next = (n: IvrNode): string[] => {
    switch (n.type) {
      case 'menu':
        return [...Object.values(n.options), n.on_timeout, n.on_invalid].filter(Boolean);
      case 'schedule':
        return [n.open, n.closed, n.holiday].filter(Boolean);
      case 'say':
        return [n.next].filter(Boolean);
      case 'forward':
      case 'group':
      case 'ai':
        return [n.on_fail].filter(Boolean);
      default:
        return [];
    }
  };
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id) || !flow.nodes[id]) return;
    seen.add(id);
    for (const t of next(flow.nodes[id])) walk(t);
  };
  walk(flow.start);
  for (const n of Object.values(flow.nodes)) {
    if (!seen.has(n.id)) out.push(`„${n.label}“ ist von keinem Schritt aus erreichbar.`);
    if (n.type === 'menu' && !Object.keys(n.options).length) out.push(`Das Menü „${n.label}“ hat keine Taste.`);
    if (n.type === 'schedule' && n.open === n.closed) out.push(`„${n.label}“ führt geöffnet und geschlossen zum selben Schritt.`);
  }
  // A loop of non-interactive steps (say → say …) would never answer the caller.
  for (const n of Object.values(flow.nodes)) {
    if (n.type !== 'say' && n.type !== 'schedule') continue;
    const visited = new Set<string>();
    let cur: IvrNode | undefined = n;
    while (cur && (cur.type === 'say' || cur.type === 'schedule')) {
      if (visited.has(cur.id)) {
        out.push(`„${n.label}“ läuft im Kreis, ohne dass jemand etwas drücken kann.`);
        break;
      }
      visited.add(cur.id);
      cur = flow.nodes[cur.type === 'say' ? cur.next : cur.open];
    }
  }
  return [...new Set(out)];
}

// --- the menu's decision -----------------------------------------------------------------------------------------

export type MenuDecision =
  | { kind: 'go'; node: string; key: string }
  | { kind: 'repeat'; attempt: number; reason: 'timeout' | 'invalid' }
  | { kind: 'fallback'; node: string; reason: 'timeout' | 'invalid' };

/** What a key press (or silence: empty digits) does at a menu. `attempt` counts the repeats so far. */
export function menuDecision(node: MenuNode, digits: string, attempt: number): MenuDecision {
  const key = String(digits ?? '').trim().charAt(0);
  if (key && node.options[key]) return { kind: 'go', node: node.options[key], key };
  const reason = key ? 'invalid' : 'timeout';
  if (attempt < node.retries) return { kind: 'repeat', attempt: attempt + 1, reason };
  return { kind: 'fallback', node: (reason === 'invalid' ? node.on_invalid || node.on_timeout : node.on_timeout || node.on_invalid) || '', reason };
}

// --- schedules ---------------------------------------------------------------------------------------------------

export interface Interval {
  from: string;
  to: string;
}
export interface Holiday {
  /** YYYY-MM-DD, or MM-DD for every year. */
  date: string;
  name: string;
  closed: boolean;
  /** When not closed: these hours replace the weekday's. */
  intervals: Interval[];
}
export interface Schedule {
  hours: Record<DayKey, Interval[]>;
  holidays: Holiday[];
  german_holidays: { enabled: boolean; state: string };
}
export const DAY_KEYS: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const STATES: [string, string][] = [
  ['BW', 'Baden-Württemberg'],
  ['BY', 'Bayern'],
  ['BE', 'Berlin'],
  ['BB', 'Brandenburg'],
  ['HB', 'Bremen'],
  ['HH', 'Hamburg'],
  ['HE', 'Hessen'],
  ['MV', 'Mecklenburg-Vorpommern'],
  ['NI', 'Niedersachsen'],
  ['NW', 'Nordrhein-Westfalen'],
  ['RP', 'Rheinland-Pfalz'],
  ['SL', 'Saarland'],
  ['SN', 'Sachsen'],
  ['ST', 'Sachsen-Anhalt'],
  ['SH', 'Schleswig-Holstein'],
  ['TH', 'Thüringen'],
];
const HM = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;

export const defaultSchedule = (): Schedule => ({
  hours: Object.fromEntries(DAY_KEYS.map((d) => [d, ['sat', 'sun'].includes(d) ? [] : [{ from: '09:00', to: '17:00' }]])) as Schedule['hours'],
  holidays: [],
  german_holidays: { enabled: true, state: '' },
});

const cleanIntervals = (v: unknown, where: string): Interval[] =>
  (Array.isArray(v) ? v : []).slice(0, 4).map((i: any) => {
    const from = String(i?.from ?? '');
    const to = String(i?.to ?? '');
    if (!HM.test(from) || !HM.test(to) || from === '24:00') throw bad(`${where}: Uhrzeit bitte als HH:MM`);
    if (from === to) throw bad(`${where}: Beginn und Ende sind gleich`);
    return { from, to };
  });

/** Validates a schedule from the browser. */
export function cleanSchedule(raw: any, cur: Schedule = defaultSchedule()): Schedule {
  const out: Schedule = { hours: { ...cur.hours }, holidays: cur.holidays, german_holidays: { ...cur.german_holidays } };
  if (raw?.hours !== undefined) {
    if (!raw.hours || typeof raw.hours !== 'object') throw bad('Zeiten ungültig');
    for (const d of DAY_KEYS) if (raw.hours[d] !== undefined) out.hours[d] = cleanIntervals(raw.hours[d], `Zeiten ${d}`);
  }
  if (raw?.holidays !== undefined) {
    if (!Array.isArray(raw.holidays)) throw bad('Feiertage als Liste');
    if (raw.holidays.length > 100) throw bad('Höchstens 100 eigene Feiertage');
    out.holidays = raw.holidays.map((h: any) => {
      const date = String(h?.date ?? '').trim();
      if (!/^(\d{4}-)?(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(date)) throw bad('Feiertag: Datum als JJJJ-MM-TT oder MM-TT');
      const closed = h?.closed !== false;
      return { date, name: String(h?.name ?? '').trim().slice(0, 60) || 'Feiertag', closed, intervals: closed ? [] : cleanIntervals(h?.intervals, `Feiertag ${date}`) };
    });
  }
  if (raw?.german_holidays !== undefined) {
    const g = raw.german_holidays;
    const state = String(g?.state ?? '').toUpperCase();
    if (state && !STATES.some(([c]) => c === state)) throw bad('Bundesland unbekannt');
    out.german_holidays = { enabled: g?.enabled !== false, state };
  }
  return out;
}

/** Easter Sunday (Gregorian), as a UTC date at noon. */
export function easter(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day, 12));
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const plus = (d: Date, days: number) => new Date(d.getTime() + days * 864e5);

/** The public holidays of a year: nationwide ones, plus the ones of `state` (two-letter code) when given. YYYY-MM-DD → name. */
export function germanHolidays(year: number, state = ''): Map<string, string> {
  const st = state.toUpperCase();
  const e = easter(year);
  const out = new Map<string, string>();
  const add = (date: string, name: string) => void out.set(date, name);
  add(`${year}-01-01`, 'Neujahr');
  add(ymd(plus(e, -2)), 'Karfreitag');
  add(ymd(plus(e, 1)), 'Ostermontag');
  add(`${year}-05-01`, 'Tag der Arbeit');
  add(ymd(plus(e, 39)), 'Christi Himmelfahrt');
  add(ymd(plus(e, 50)), 'Pfingstmontag');
  add(`${year}-10-03`, 'Tag der Deutschen Einheit');
  add(`${year}-12-25`, '1. Weihnachtstag');
  add(`${year}-12-26`, '2. Weihnachtstag');
  if (!st) return out;
  if (['BW', 'BY', 'ST'].includes(st)) add(`${year}-01-06`, 'Heilige Drei Könige');
  if (st === 'BE' || (st === 'MV' && year >= 2023)) add(`${year}-03-08`, 'Internationaler Frauentag');
  if (st === 'BB') {
    add(ymd(e), 'Ostersonntag');
    add(ymd(plus(e, 49)), 'Pfingstsonntag');
  }
  if (['BW', 'BY', 'HE', 'NW', 'RP', 'SL'].includes(st)) add(ymd(plus(e, 60)), 'Fronleichnam');
  if (st === 'SL') add(`${year}-08-15`, 'Mariä Himmelfahrt');
  if (st === 'TH') add(`${year}-09-20`, 'Weltkindertag');
  if (['BB', 'HB', 'HH', 'MV', 'NI', 'SN', 'ST', 'SH', 'TH'].includes(st)) add(`${year}-10-31`, 'Reformationstag');
  if (['BW', 'BY', 'NW', 'RP', 'SL'].includes(st)) add(`${year}-11-01`, 'Allerheiligen');
  if (st === 'SN') {
    // Buß- und Bettag: the Wednesday before 23 November.
    const nov23 = new Date(Date.UTC(year, 10, 23, 12));
    const back = ((nov23.getUTCDay() + 7 - 3) % 7) || 7;
    add(ymd(plus(nov23, -back)), 'Buß- und Bettag');
  }
  return out;
}

export interface ScheduleState {
  state: 'open' | 'closed' | 'holiday';
  /** German reason for the log ("Feiertag: Neujahr", "außerhalb der Zeiten"). */
  reason: string;
}

const covers = (iv: Interval, hm: string) => (iv.to > iv.from ? hm >= iv.from && hm < iv.to : hm >= iv.from);
/** The part of an overnight interval (22:00–02:00) that falls on the next day. */
const tail = (iv: Interval, hm: string) => iv.to <= iv.from && hm < iv.to;

/** Whether a schedule is open at `at` in the sub-account's timezone, with holidays (own entries first, then the German ones). */
export function scheduleState(s: Schedule, tz: string, at = new Date()): ScheduleState {
  const day = ymdInTz(at, tz);
  const hm = hmInTz(at, tz);
  const year = Number(day.slice(0, 4));
  const own = s.holidays.find((h) => h.date === day || h.date === day.slice(5));
  let holiday: { name: string; closed: boolean; intervals: Interval[] } | undefined = own;
  if (!holiday && s.german_holidays.enabled) {
    const name = germanHolidays(year, s.german_holidays.state).get(day);
    if (name) holiday = { name, closed: true, intervals: [] };
  }
  const prevDay = addDaysYmd(day, -1);
  const prevIntervals = s.hours[weekdayKey(prevDay)] ?? [];
  const intervals = holiday ? (holiday.closed ? [] : holiday.intervals) : (s.hours[weekdayKey(day)] ?? []);
  // Last night's overnight interval still runs (unless yesterday was a closed holiday).
  const prevOwn = s.holidays.find((h) => h.date === prevDay || h.date === prevDay.slice(5));
  const prevHoliday = prevOwn ?? (s.german_holidays.enabled && germanHolidays(Number(prevDay.slice(0, 4)), s.german_holidays.state).has(prevDay) ? { closed: true, intervals: [] as Interval[] } : undefined);
  const carry = (prevHoliday ? (prevHoliday.closed ? [] : prevHoliday.intervals) : prevIntervals).some((iv) => tail(iv, hm));
  if (carry || intervals.some((iv) => covers(iv, hm))) return { state: 'open', reason: holiday ? `Feiertag mit Sonderzeiten: ${holiday.name}` : '' };
  if (holiday?.closed) return { state: 'holiday', reason: `Feiertag: ${holiday.name}` };
  return { state: 'closed', reason: holiday ? `Feiertag: ${holiday.name} (außerhalb der Sonderzeiten)` : 'außerhalb der Öffnungszeiten' };
}

// --- TwiML of the interactive nodes -----------------------------------------------------------------------------

/** What a caller hears: a recorded file when there is one, else the text read by the German voice. */
export const speech = (text: string, audioUrl?: string) => (audioUrl ? `<Play>${xml(audioUrl)}</Play>` : say(text));

/** The inner part of a TwiML response (so an announcement can be put in front of another node's TwiML). */
export const innerOf = (t: string) => t.replace(/^<\?xml[^>]*\?>\s*/, '').replace(/^<Response>/, '').replace(/<\/Response>\s*$/, '');

/**
 * A menu: the prompt plays inside the <Gather> (a key press interrupts it); without input Twilio falls through to the
 * <Redirect>, which comes back with `timeout=1` so the webhook can repeat the menu or give up.
 */
export function menuTwiml(o: { prompt: string; action: string; timeoutUrl: string; seconds: number; before?: string }): string {
  return twiml(
    `${o.before ?? ''}<Gather${attrs({ input: 'dtmf', numDigits: 1, timeout: o.seconds, action: o.action, method: 'POST' })}>${o.prompt}</Gather><Redirect method="POST">${xml(o.timeoutUrl)}</Redirect>`,
  );
}

// --- dry run -------------------------------------------------------------------------------------------------------

export interface SimStep {
  node: string;
  label: string;
  type: NodeType;
  /** What the caller hears or what happens ("Taste 2 → Support", "Feiertag: Neujahr"). */
  note: string;
}
export interface SimResult {
  steps: SimStep[];
  /** Where the call ends up: a node type, "waiting" (the menu waits for a key), "default" (the normal flow) or "loop". */
  end: NodeType | 'waiting' | 'default' | 'loop';
}

/**
 * Walks a flow the way a call would, with the given key presses and at the given time – the builder's "Testlauf" and the
 * tests use it. `keys` are consumed one per menu (an empty string is "no input"); `defaultOpen` answers the schedule node
 * that uses the telephony settings' business hours.
 */
export function simulate(flow: IvrFlow, o: { keys: string[]; at: Date; tz: string; schedules: Record<string, Schedule>; defaultOpen: boolean }): SimResult {
  const steps: SimStep[] = [];
  const keys = [...o.keys];
  let id = flow.start;
  let attempt = 0;
  const push = (n: IvrNode, note: string) => steps.push({ node: n.id, label: n.label, type: n.type, note });
  for (let hop = 0; hop < MAX_HOPS * 2; hop++) {
    const n = flow.nodes[id];
    if (!n) return { steps, end: 'default' };
    switch (n.type) {
      case 'menu': {
        if (!steps.length || steps[steps.length - 1].node !== n.id || attempt === 0) push(n, n.say || 'Aufnahme');
        if (!keys.length) return { steps, end: 'waiting' };
        const key = keys.shift()!;
        const d = menuDecision(n, key, attempt);
        if (d.kind === 'go') {
          steps.push({ node: n.id, label: n.label, type: 'menu', note: `Taste ${d.key}${n.option_labels[d.key] ? ` → ${n.option_labels[d.key]}` : ''}` });
          id = d.node;
          attempt = 0;
        } else if (d.kind === 'repeat') {
          steps.push({ node: n.id, label: n.label, type: 'menu', note: d.reason === 'invalid' ? `Taste ${key || '?'} gibt es nicht – Menü wird wiederholt` : 'Keine Eingabe – Menü wird wiederholt' });
          attempt = d.attempt;
        } else {
          steps.push({ node: n.id, label: n.label, type: 'menu', note: d.reason === 'invalid' ? 'Zu viele falsche Eingaben' : 'Keine Eingabe' });
          if (!d.node) return { steps, end: 'default' };
          id = d.node;
          attempt = 0;
        }
        break;
      }
      case 'schedule': {
        const s = n.schedule_id ? o.schedules[n.schedule_id] : undefined;
        const st: ScheduleState = s ? scheduleState(s, o.tz, o.at) : { state: o.defaultOpen ? 'open' : 'closed', reason: o.defaultOpen ? '' : 'außerhalb der Öffnungszeiten' };
        push(n, st.state === 'open' ? 'geöffnet' : st.reason || 'geschlossen');
        id = st.state === 'open' ? n.open : st.state === 'holiday' ? n.holiday || n.closed : n.closed;
        break;
      }
      case 'say':
        push(n, n.say || 'Aufnahme');
        if (!n.next) return { steps, end: 'say' };
        id = n.next;
        break;
      case 'forward':
        push(n, [...n.numbers, ...n.users.map(() => 'Browser-Telefon')].join(', '));
        return { steps, end: 'forward' };
      case 'group':
        push(n, 'Ruf-Gruppe');
        return { steps, end: 'group' };
      case 'voicemail':
        push(n, `Voicemail „${n.box}“`);
        return { steps, end: 'voicemail' };
      case 'ai':
        push(n, 'KI-Telefonagent');
        return { steps, end: 'ai' };
      case 'hangup':
        push(n, n.say || 'Auflegen');
        return { steps, end: 'hangup' };
    }
  }
  return { steps, end: 'loop' };
}
