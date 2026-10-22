import { addDaysYmd, hmInTz, isValidTz, weekdayKey, ymdInTz, zonedToUtc } from '../core/time.js';
import { presetById } from './ai-presets.js';
import { TRIGGER_IDS, type TriggerPriority } from './companion-triggers.js';
import { VOICE_RE } from './voice-settings.js';

/**
 * Fokus-Modus mit Companion: one person's choices per sub-account – which agent answers (the built-in HyperLevel Agent as
 * "Jarvis" or one of their custom agents), its name and wake phrase, the shortcut, reading answers aloud, and the proactive
 * check-ins (interval or fixed times, quiet hours, weekdays only, only when something changed). Pure: validation, defaults and
 * the "is a check-in due now?" rule the scheduler in modules/companion.ts asks every minute. The wake word itself is switched on
 * per device in the browser (microphone permission is per device) and never stored here.
 */

export const DEFAULT_NAME = 'Jarvis';
/** Interval presets of the settings (minutes); any other number from 5 to 1440 is a custom interval. */
export const CHECKIN_INTERVALS = [5, 10, 15, 20, 30, 45, 60, 120, 180, 240] as const;
export const CHECKIN_MODES = ['off', 'interval', 'daily'] as const;
export type CheckinMode = (typeof CHECKIN_MODES)[number];
export const MAX_DAILY_TIMES = 6;
/**
 * The companion's own voice by default: Google Cloud Text-to-Speech, a native male voice in the language of the app –
 * "de-DE-Chirp3-HD-Iapetus" in German, "en-US-Chirp3-HD-Iapetus" in English (Chirp 3 HD, characterised as "clear"; no accent,
 * because each language gets a voice of its own). `tts_voice: 'auto'` picks it by language; any other value is a fixed voice.
 */
export const DEFAULT_TTS_PROVIDER = 'google_speech';
export const DEFAULT_TTS_VOICE = 'auto';
export const JARVIS_VOICES = { de: 'de-DE-Chirp3-HD-Iapetus', en: 'en-US-Chirp3-HD-Iapetus' } as const;
/** Earlier defaults that were never picked on purpose – read as 'auto' (1.0.53 used a British voice that read German with an accent). */
const LEGACY_DEFAULT_VOICES = new Set(['en-GB-Neural2-B']);
/**
 * Jarvis per speaking provider: Google's native voice of each language; on kie.ai the ElevenLabs voice "Brian"
 * (genmedia/kie.ts KIE_JARVIS_VOICE – Turbo 2.5 is told the language, so it speaks both without an accent).
 * Providers not listed get '' – their own default voice.
 */
export const JARVIS_PROVIDER_VOICES: Record<string, { de: string; en: string }> = {
  google_speech: JARVIS_VOICES,
  kie: { de: 'nPczCjzI2devNBz1zQrb', en: 'nPczCjzI2devNBz1zQrb' },
};
/** The voice to send to the provider: 'auto' (and the legacy default) → the Jarvis voice of that provider in the language. */
export const resolveTtsVoice = (voice: string, lang: 'de' | 'en' | string, provider: string = DEFAULT_TTS_PROVIDER): string => {
  if (voice !== 'auto' && !LEGACY_DEFAULT_VOICES.has(voice)) return voice;
  const v = JARVIS_PROVIDER_VOICES[provider];
  return v ? (lang === 'en' ? v.en : v.de) : '';
};
/** tts_provider value for "always the browser's own voice". */
export const BROWSER_TTS = 'browser';
/** tts_provider value for "the sub-account's own voice" (Einstellungen → Stimme / the person's agent voice), as before 1.0.53. */
export const ACCOUNT_TTS = 'account';
/** Follow-up window presets (seconds the microphone stays open after the companion spoke; 0 = turn-based as before 1.0.54). */
export const CONVERSATION_WINDOWS = [0, 5, 8, 15] as const;
export const DEFAULT_CONVERSATION_WINDOW = 8;
/** classic = speech to text → agent → text to speech; gemini_live = bidirectional audio through the server (Gemini Live API). */
export const VOICE_ENGINES = ['classic', 'gemini_live'] as const;
export type VoiceEngine = (typeof VOICE_ENGINES)[number];
/** Eigeninitiative: zurückhaltend / ausgewogen / sehr proaktiv (services/companion-initiative.ts). */
export const INITIATIVE_LEVELS = ['low', 'balanced', 'high'] as const;
export type InitiativeLevel = (typeof INITIATIVE_LEVELS)[number];
/** Rolle (docs/living-boards.md#business-developer): the holistic Business Developer (default) or the plain assistant. */
export const ROLES = ['business_developer', 'assistant'] as const;
export type CompanionRole = (typeof ROLES)[number];
export const DEFAULT_ROLE: CompanionRole = 'business_developer';
/**
 * Wachstums-Briefing – opt-in per person (default off): `daily` is the switch (at `time`, quiet hours respected, only when something
 * is new); `weekly` = on Mondays the Wochenbilanz instead – it follows the switch (nothing comes while `daily` is off).
 */
export interface GrowthPrefs {
  daily: boolean;
  time: string;
  weekly: boolean;
}
export const defaultGrowth = (): GrowthPrefs => ({ daily: false, time: '08:00', weekly: true });
/** "Nachricht unbeantwortet" fires after this many minutes by default (5–1440). */
export const DEFAULT_UNANSWERED_MINUTES = 30;
const PROVIDER_RE = /^[a-z][a-z0-9_]{1,39}$/;
const CONN_RE = /^[A-Za-z0-9_-]{1,120}$/;
/** A provider of the BYOK registry that can speak (custom_http speaks through the media adapter although its preset lists images). */
export const ttsProviderOk = (id: string) => id === BROWSER_TTS || id === ACCOUNT_TTS || (PROVIDER_RE.test(id) && (id === 'custom_http' || !!presetById(id)?.capabilities.includes('audio_tts')));

export interface CheckinPrefs {
  mode: CheckinMode;
  /** interval mode: minutes between check-ins */
  minutes: number;
  /** daily mode: wall-clock times "HH:MM" (sorted, unique) */
  times: string[];
  /** quiet hours for interval check-ins ("20:00" – "08:00" wraps over midnight); fixed daily times are deliberate and always fire */
  quiet_from: string;
  quiet_to: string;
  weekdays_only: boolean;
  /** skip a check-in whose hotspots are the same as the last one's */
  only_changed: boolean;
  /** the open app reads a short greeting and the top item aloud */
  speak: boolean;
}

export interface CompanionPrefs {
  /** null = the built-in HyperLevel Agent (shown as the persona "Jarvis"), else a custom agent's id */
  agent_id: string | null;
  /** '' = the default: "Jarvis" for the built-in agent, the custom agent's own name otherwise */
  name: string;
  /** '' = "Hey <name>" */
  wake_phrase: string;
  shortcut: boolean;
  /** read every answer aloud; null = never chosen (the browser's old Fokus switch decides) */
  read_aloud: boolean | null;
  /** answer a spoken question aloud */
  voice_reply: boolean;
  /** a voice of the browser's speech synthesis by name ('' = automatic / the sub-account's voice) */
  browser_voice: string;
  /**
   * The companion's server voice: a provider of the BYOK registry (preset id, default "google_speech") or "browser" for the browser's
   * own voice or "account" for the sub-account's voice. Used when the sub-account has an audio_tts connection of that provider (`tts_connection_id`, else its first one).
   */
  tts_provider: string;
  /** '' = the provider's first connection of this sub-account */
  tts_connection_id: string;
  /** the provider's voice id (default "auto" = the native Jarvis voice of the language; '' = the provider's default) */
  tts_voice: string;
  /** the person's time zone for daily check-ins and quiet hours ('' = the sub-account's) */
  tz: string;
  checkin: CheckinPrefs;
  /** Gesprächsmodus: seconds the microphone stays open for a follow-up after the companion spoke (0 = off) */
  conversation_window: number;
  /** stop speaking as soon as the person talks (voice activity on the open microphone) */
  barge_in: boolean;
  voice_engine: VoiceEngine;
  /** '' = the sub-account's first Gemini connection with a key */
  live_connection_id: string;
  initiative: InitiativeLevel;
  /** Ereignis-Auslöser: master switch, the "unanswered" threshold and per-trigger overrides (on/off, priority) */
  events: EventPrefs;
  role: CompanionRole;
  growth: GrowthPrefs;
}

export interface TriggerPref {
  on: boolean;
  priority: TriggerPriority;
}
export interface EventPrefs {
  on: boolean;
  unanswered_minutes: number;
  /** only what differs from the trigger's defaults is stored */
  triggers: Partial<Record<string, Partial<TriggerPref>>>;
}

export const defaultEvents = (): EventPrefs => ({ on: true, unanswered_minutes: DEFAULT_UNANSWERED_MINUTES, triggers: {} });

export const defaultCheckin = (): CheckinPrefs => ({ mode: 'off', minutes: 60, times: ['08:30'], quiet_from: '20:00', quiet_to: '08:00', weekdays_only: false, only_changed: true, speak: false });
export const defaultPrefs = (): CompanionPrefs => ({ agent_id: null, name: '', wake_phrase: '', shortcut: true, read_aloud: null, voice_reply: true, browser_voice: '', tts_provider: DEFAULT_TTS_PROVIDER, tts_connection_id: '', tts_voice: DEFAULT_TTS_VOICE, tz: '', checkin: defaultCheckin(), conversation_window: DEFAULT_CONVERSATION_WINDOW, barge_in: true, voice_engine: 'classic', live_connection_id: '', initiative: 'balanced', events: defaultEvents(), role: DEFAULT_ROLE, growth: defaultGrowth() });

function cleanTriggerMap(v: unknown): EventPrefs['triggers'] {
  const out: EventPrefs['triggers'] = {};
  for (const [k, raw] of Object.entries(obj(v))) {
    if (!TRIGGER_IDS.includes(k)) continue;
    const o = obj(raw);
    const t: Partial<TriggerPref> = {};
    if (typeof o.on === 'boolean') t.on = o.on;
    if (o.priority === 'interrupt' || o.priority === 'digest') t.priority = o.priority;
    if (Object.keys(t).length) out[k] = t;
  }
  return out;
}
const windowOk = (n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 30;

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
/** One line of plain text: no control characters, no markup brackets, single spaces. */
export const cleanName = (v: unknown, max: number) =>
  String(v ?? '')
    .replace(/[\u0000-\u001f\u007f<>{}[\]`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** "Hey Jarvis" for "Jarvis" – the wake phrase that follows the companion's name. */
export const wakePhraseFor = (name: string) => `Hey ${cleanName(name, 40) || DEFAULT_NAME}`;

function cleanTimes(v: unknown): string[] {
  const list = (Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter((x) => HM.test(x));
  return [...new Set(list)].sort().slice(0, MAX_DAILY_TIMES);
}

/** Stored JSON over the defaults (unknown keys dropped, wrong types replaced). */
export function withPrefDefaults(stored: unknown): CompanionPrefs {
  const d = defaultPrefs();
  const s = obj(stored);
  const c = obj(s.checkin);
  const dc = d.checkin;
  const minutes = Number(c.minutes);
  const times = cleanTimes(c.times);
  return {
    agent_id: typeof s.agent_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s.agent_id) ? s.agent_id : null,
    name: cleanName(s.name, 40),
    wake_phrase: cleanName(s.wake_phrase, 60),
    shortcut: bool(s.shortcut, d.shortcut),
    read_aloud: typeof s.read_aloud === 'boolean' ? s.read_aloud : null,
    voice_reply: bool(s.voice_reply, d.voice_reply),
    browser_voice: cleanName(s.browser_voice, 120),
    tts_provider: typeof s.tts_provider === 'string' && ttsProviderOk(s.tts_provider) ? s.tts_provider : d.tts_provider,
    tts_connection_id: typeof s.tts_connection_id === 'string' && CONN_RE.test(s.tts_connection_id) ? s.tts_connection_id : '',
    tts_voice: typeof s.tts_voice === 'string' && (s.tts_voice === '' || VOICE_RE.test(s.tts_voice)) ? (LEGACY_DEFAULT_VOICES.has(s.tts_voice) ? DEFAULT_TTS_VOICE : s.tts_voice) : d.tts_voice,
    tz: typeof s.tz === 'string' && s.tz && s.tz.length <= 64 && isValidTz(s.tz) ? s.tz : '',
    checkin: {
      mode: CHECKIN_MODES.includes(c.mode) ? c.mode : dc.mode,
      minutes: Number.isInteger(minutes) && minutes >= 5 && minutes <= 1440 ? minutes : dc.minutes,
      times: times.length ? times : dc.times,
      quiet_from: HM.test(String(c.quiet_from)) ? String(c.quiet_from) : dc.quiet_from,
      quiet_to: HM.test(String(c.quiet_to)) ? String(c.quiet_to) : dc.quiet_to,
      weekdays_only: bool(c.weekdays_only, dc.weekdays_only),
      only_changed: bool(c.only_changed, dc.only_changed),
      speak: bool(c.speak, dc.speak),
    },
    conversation_window: windowOk(s.conversation_window) ? s.conversation_window : d.conversation_window,
    barge_in: bool(s.barge_in, d.barge_in),
    voice_engine: VOICE_ENGINES.includes(s.voice_engine) ? s.voice_engine : d.voice_engine,
    live_connection_id: typeof s.live_connection_id === 'string' && CONN_RE.test(s.live_connection_id) ? s.live_connection_id : '',
    initiative: INITIATIVE_LEVELS.includes(s.initiative) ? s.initiative : d.initiative,
    events: (() => {
      const e = obj(s.events);
      const m = Number(e.unanswered_minutes);
      return { on: bool(e.on, true), unanswered_minutes: Number.isInteger(m) && m >= 5 && m <= 1440 ? m : DEFAULT_UNANSWERED_MINUTES, triggers: cleanTriggerMap(e.triggers) };
    })(),
    role: ROLES.includes(s.role) ? s.role : DEFAULT_ROLE,
    growth: (() => {
      const g = obj(s.growth);
      const dg = defaultGrowth();
      return { daily: bool(g.daily, dg.daily), time: HM.test(String(g.time)) ? String(g.time) : dg.time, weekly: bool(g.weekly, dg.weekly) };
    })(),
  };
}

/** A patch from the browser over the current prefs; throws an Error with a message for people on invalid input. */
export function cleanPrefs(body: unknown, cur: CompanionPrefs): CompanionPrefs {
  const b = obj(body);
  const out: CompanionPrefs = JSON.parse(JSON.stringify(cur));
  if (b.agent_id !== undefined) {
    if (b.agent_id === null || b.agent_id === '') out.agent_id = null;
    else if (typeof b.agent_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(b.agent_id)) out.agent_id = b.agent_id;
    else throw new Error('Unbekannter Agent');
  }
  if (b.name !== undefined) out.name = cleanName(b.name, 40);
  if (b.wake_phrase !== undefined) {
    const p = cleanName(b.wake_phrase, 60);
    if (p && p.replace(/[^\p{L}]/gu, '').length < 4) throw new Error('Das Weckwort ist zu kurz – mindestens vier Buchstaben, z. B. „Hey Jarvis“.');
    out.wake_phrase = p;
  }
  for (const k of ['shortcut', 'voice_reply'] as const) if (b[k] !== undefined) out[k] = b[k] === true;
  if (b.read_aloud !== undefined) out.read_aloud = b.read_aloud === null ? null : b.read_aloud === true;
  if (b.browser_voice !== undefined) out.browser_voice = cleanName(b.browser_voice, 120);
  if (b.tts_provider !== undefined) {
    const v = b.tts_provider === null || b.tts_provider === '' ? DEFAULT_TTS_PROVIDER : String(b.tts_provider);
    if (!ttsProviderOk(v)) throw new Error('Unbekannter Anbieter für die Stimme');
    if (v !== out.tts_provider && b.tts_connection_id === undefined) out.tts_connection_id = '';
    out.tts_provider = v;
  }
  if (b.tts_connection_id !== undefined) {
    const v = b.tts_connection_id === null ? '' : String(b.tts_connection_id);
    if (v && !CONN_RE.test(v)) throw new Error('Unbekannte Verbindung');
    out.tts_connection_id = v;
  }
  if (b.tts_voice !== undefined) {
    const v = String(b.tts_voice ?? '').trim();
    if (v && !VOICE_RE.test(v)) throw new Error('Stimme: ungültige Zeichen');
    out.tts_voice = v;
  }
  if (out.tts_provider === BROWSER_TTS || out.tts_provider === ACCOUNT_TTS) out.tts_connection_id = '';
  if (b.tz !== undefined) {
    const tz = String(b.tz ?? '');
    if (tz && (tz.length > 64 || !isValidTz(tz))) throw new Error('Unbekannte Zeitzone');
    out.tz = tz;
  }
  const c = obj(b.checkin);
  if (b.checkin !== undefined) {
    if (c.mode !== undefined) {
      if (!CHECKIN_MODES.includes(c.mode)) throw new Error('Check-ins: aus, im Abstand oder zu festen Uhrzeiten');
      out.checkin.mode = c.mode;
    }
    if (c.minutes !== undefined) {
      const m = Number(c.minutes);
      if (!Number.isInteger(m) || m < 5 || m > 1440) throw new Error('Abstand der Check-ins: 5 bis 1440 Minuten');
      out.checkin.minutes = m;
    }
    if (c.times !== undefined) {
      if (!Array.isArray(c.times) || c.times.some((x: unknown) => !HM.test(String(x).trim()))) throw new Error('Uhrzeiten bitte als HH:MM, z. B. 08:30');
      const times = cleanTimes(c.times);
      if (!times.length) throw new Error('Mindestens eine Uhrzeit');
      if (c.times.length > MAX_DAILY_TIMES) throw new Error(`Höchstens ${MAX_DAILY_TIMES} Uhrzeiten am Tag`);
      out.checkin.times = times;
    }
    for (const k of ['quiet_from', 'quiet_to'] as const) {
      if (c[k] === undefined) continue;
      if (!HM.test(String(c[k]))) throw new Error('Ruhezeit bitte als HH:MM');
      out.checkin[k] = String(c[k]);
    }
    for (const k of ['weekdays_only', 'only_changed', 'speak'] as const) if (c[k] !== undefined) out.checkin[k] = c[k] === true;
  }
  if (b.conversation_window !== undefined) {
    const n = Number(b.conversation_window);
    if (!windowOk(n)) throw new Error('Gesprächsmodus: 0 bis 30 Sekunden');
    out.conversation_window = n;
  }
  if (b.barge_in !== undefined) out.barge_in = b.barge_in === true;
  if (b.voice_engine !== undefined) {
    if (!VOICE_ENGINES.includes(b.voice_engine)) throw new Error('Unbekannte Sprach-Engine');
    out.voice_engine = b.voice_engine;
  }
  if (b.live_connection_id !== undefined) {
    const v = b.live_connection_id === null ? '' : String(b.live_connection_id);
    if (v && !CONN_RE.test(v)) throw new Error('Unbekannte Verbindung');
    out.live_connection_id = v;
  }
  if (b.initiative !== undefined) {
    if (!INITIATIVE_LEVELS.includes(b.initiative)) throw new Error('Eigeninitiative: zurückhaltend, ausgewogen oder sehr proaktiv');
    out.initiative = b.initiative;
  }
  if (b.role !== undefined) {
    if (!ROLES.includes(b.role)) throw new Error('Rolle: Business Developer oder Assistent');
    out.role = b.role;
  }
  if (b.growth !== undefined) {
    const g = obj(b.growth);
    if (g.time !== undefined) {
      if (!HM.test(String(g.time))) throw new Error('Uhrzeit des Wachstums-Briefings bitte als HH:MM, z. B. 08:00');
      out.growth.time = String(g.time);
    }
    for (const k of ['daily', 'weekly'] as const) if (g[k] !== undefined) out.growth[k] = g[k] === true;
  }
  if (b.events !== undefined) {
    const e = obj(b.events);
    if (e.on !== undefined) out.events.on = e.on === true;
    if (e.unanswered_minutes !== undefined) {
      const m = Number(e.unanswered_minutes);
      if (!Number.isInteger(m) || m < 5 || m > 1440) throw new Error('Unbeantwortet nach 5 bis 1440 Minuten');
      out.events.unanswered_minutes = m;
    }
    if (e.triggers !== undefined) {
      for (const [k, raw] of Object.entries(obj(e.triggers))) {
        if (!TRIGGER_IDS.includes(k)) throw new Error('Unbekannter Auslöser');
        const o = obj(raw);
        if (o.priority !== undefined && o.priority !== 'interrupt' && o.priority !== 'digest') throw new Error('Priorität: sofort oder gesammelt');
      }
      const merged = { ...out.events.triggers };
      for (const [k, v] of Object.entries(cleanTriggerMap(e.triggers))) merged[k] = { ...merged[k], ...v };
      out.events.triggers = merged;
    }
  }
  return out;
}

/** Whether `hm` lies in the quiet hours from–to (to before from = over midnight; equal = no quiet hours). */
export function inQuiet(hm: string, from: string, to: string): boolean {
  if (from === to) return false;
  return from < to ? hm >= from && hm < to : hm >= from || hm < to;
}

/** How late a fixed check-in may still be delivered (a server that was down at 08:30 still sends it at 09:15, not at noon). */
export const DAILY_GRACE_MS = 2 * 3600_000;

/**
 * Is a check-in due at `now`? `lastAt` = when the last one was evaluated (sent or skipped as unchanged). Interval check-ins wait
 * out the quiet hours; fixed times fire once per slot within DAILY_GRACE_MS; "weekdays only" skips Saturday and Sunday for both.
 */
export function checkinDue(c: CheckinPrefs, o: { now: Date; tz: string; lastAt: string | null }): { due: boolean; slot: string } {
  const none = { due: false, slot: '' };
  if (c.mode === 'off') return none;
  const tz = o.tz && isValidTz(o.tz) ? o.tz : 'Europe/Berlin';
  const ymd = ymdInTz(o.now, tz);
  const day = weekdayKey(ymd);
  if (c.weekdays_only && (day === 'sat' || day === 'sun')) return none;
  const hm = hmInTz(o.now, tz);
  const last = o.lastAt ? new Date(o.lastAt).getTime() : 0;
  if (c.mode === 'interval') {
    if (inQuiet(hm, c.quiet_from, c.quiet_to)) return none;
    // 30 s of slack: the scheduler looks once a minute
    if (last && o.now.getTime() - last < c.minutes * 60_000 - 30_000) return none;
    return { due: true, slot: `i:${ymd}T${hm}` };
  }
  for (const t of [...c.times].sort().reverse()) {
    if (t > hm) continue;
    const at = zonedToUtc(ymd, t, tz).getTime();
    if (o.now.getTime() - at > DAILY_GRACE_MS) return none;
    return last >= at ? none : { due: true, slot: `d:${ymd}T${t}` };
  }
  return none;
}

/** The next moment a check-in could come (for the settings' "Nächster Check-in" line); null when off. */
export function nextCheckin(c: CheckinPrefs, o: { now: Date; tz: string; lastAt: string | null }): Date | null {
  if (c.mode === 'off') return null;
  const tz = o.tz && isValidTz(o.tz) ? o.tz : 'Europe/Berlin';
  if (c.mode === 'interval') {
    // the interval's end, then over the weekend (to Monday) and the quiet hours (to their end) – a few jumps at most
    let t = new Date(Math.max(o.now.getTime(), o.lastAt ? new Date(o.lastAt).getTime() + c.minutes * 60_000 : o.now.getTime()));
    for (let i = 0; i < 12; i++) {
      if (checkinDue(c, { now: t, tz, lastAt: o.lastAt }).due) return t;
      const ymd = ymdInTz(t, tz);
      const day = weekdayKey(ymd);
      if (c.weekdays_only && (day === 'sat' || day === 'sun')) t = zonedToUtc(addDaysYmd(ymd, day === 'sat' ? 2 : 1), '00:00', tz);
      else if (inQuiet(hmInTz(t, tz), c.quiet_from, c.quiet_to)) {
        const end = zonedToUtc(ymd, c.quiet_to, tz);
        t = end.getTime() > t.getTime() ? end : zonedToUtc(addDaysYmd(ymd, 1), c.quiet_to, tz);
      } else t = new Date(t.getTime() + 60_000);
    }
    return null;
  }
  const today = ymdInTz(o.now, tz);
  for (let d = 0; d < 8; d++) {
    const ymd = addDaysYmd(today, d);
    const day = weekdayKey(ymd);
    if (c.weekdays_only && (day === 'sat' || day === 'sun')) continue;
    for (const t of c.times) {
      const at = zonedToUtc(ymd, t, tz);
      if (at.getTime() > o.now.getTime()) return at;
    }
  }
  return null;
}
