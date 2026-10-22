import { useEffect, useState } from 'react';
import { api, currentLocation } from '../api';
import { enterFocus } from '../focus/store';
import type { Offer } from './live';

/**
 * Fokus-Modus mit Companion (docs/living-boards.md#fokus-modus-mit-companion) – the small part in the first download: the person's
 * companion settings (GET/PUT /api/companion/prefs, one copy per tab), the per-device wake-word switch, and the bus that brings the
 * person into focus mode with the companion listening – from the edge button, the shortcut or the wake word on any page. The focus
 * page attaches to the bus while it is open; until then a request waits (it is a lazy chunk). Storage may be blocked (private mode):
 * then the wake word is simply off.
 */

export interface CheckinPrefs {
  mode: 'off' | 'interval' | 'daily';
  minutes: number;
  times: string[];
  quiet_from: string;
  quiet_to: string;
  weekdays_only: boolean;
  only_changed: boolean;
  speak: boolean;
}
export interface CompanionPrefs {
  agent_id: string | null;
  name: string;
  wake_phrase: string;
  shortcut: boolean;
  read_aloud: boolean | null;
  voice_reply: boolean;
  browser_voice: string;
  /** the companion's voice: a provider of the BYOK registry ("google_speech" by default), "browser" or "account" (the sub-account's) */
  tts_provider: string;
  /** '' = the provider's first connection */
  tts_connection_id: string;
  /** default "auto" = the native Jarvis voice of the app language (de-DE-/en-US-Chirp3-HD-Iapetus) */
  tts_voice: string;
  tz: string;
  checkin: CheckinPrefs;
  /** Gesprächsmodus: seconds the microphone stays open after the companion spoke (0 = off) */
  conversation_window: number;
  barge_in: boolean;
  voice_engine: 'classic' | 'gemini_live';
  live_connection_id: string;
  initiative: 'low' | 'balanced' | 'high';
  events: { on: boolean; unanswered_minutes: number; triggers: Record<string, { on?: boolean; priority?: 'interrupt' | 'digest' }> };
  /** Business Developer (default) or the plain assistant – docs/living-boards.md#business-developer */
  role: 'business_developer' | 'assistant';
  /** Wachstums-Briefing – opt-in (`daily`, default off) at `time`, quiet hours respected; `weekly` = the Wochenbilanz on Mondays, follows `daily` */
  growth: { daily: boolean; time: string; weekly: boolean };
}
export interface CompanionState {
  prefs: CompanionPrefs;
  /** the effective name ("Jarvis" unless chosen otherwise or a custom agent answers) */
  name: string;
  wake_phrase: string;
  agent: { id: string | null; name: string; emoji: string };
  agent_missing: boolean;
  tz: string;
  intervals: number[];
  next_checkin: string | null;
  unseen: number;
  loaded: boolean;
  loc: string;
}

const DEFAULTS: CompanionState = {
  prefs: { agent_id: null, name: '', wake_phrase: '', shortcut: true, read_aloud: null, voice_reply: true, browser_voice: '', tts_provider: 'google_speech', tts_connection_id: '', tts_voice: 'auto', tz: '', checkin: { mode: 'off', minutes: 60, times: ['08:30'], quiet_from: '20:00', quiet_to: '08:00', weekdays_only: false, only_changed: true, speak: false }, conversation_window: 8, barge_in: true, voice_engine: 'classic', live_connection_id: '', initiative: 'balanced', events: { on: true, unanswered_minutes: 30, triggers: {} }, role: 'business_developer', growth: { daily: false, time: '08:00', weekly: true } },
  name: 'Jarvis',
  wake_phrase: 'Hey Jarvis',
  agent: { id: null, name: 'HyperLevel Agent', emoji: '✨' },
  agent_missing: false,
  tz: '',
  intervals: [5, 10, 15, 20, 30, 45, 60, 120, 180, 240],
  next_checkin: null,
  unseen: 0,
  loaded: false,
  loc: '',
};

let state: CompanionState = DEFAULTS;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
let loading: Promise<void> | null = null;

export const companion = () => state;

/** Loads the settings of the current sub-account once per tab (again after a switch, or with `force`). */
export function loadCompanion(force = false): Promise<void> {
  const loc = currentLocation();
  if (!force && state.loaded && state.loc === loc) return Promise.resolve();
  if (!force && loading) return loading;
  loading = api
    .get<Omit<CompanionState, 'loaded' | 'loc'>>('/api/companion/prefs')
    .then((r) => {
      state = { ...DEFAULTS, ...r, loaded: true, loc };
      emit();
    })
    .catch(() => {
      state = { ...DEFAULTS, loaded: true, loc };
      emit();
    })
    .finally(() => (loading = null));
  return loading;
}

export async function saveCompanion(patch: Partial<Omit<CompanionPrefs, 'checkin' | 'events' | 'growth'>> & { checkin?: Partial<CheckinPrefs>; events?: Partial<CompanionPrefs['events']>; growth?: Partial<CompanionPrefs['growth']> }): Promise<CompanionState> {
  const r = await api.put<Omit<CompanionState, 'loaded' | 'loc'>>('/api/companion/prefs', patch);
  state = { ...DEFAULTS, ...r, loaded: true, loc: currentLocation() };
  emit();
  return state;
}

export function setUnseen(n: number) {
  if (state.unseen === n) return;
  state = { ...state, unseen: n };
  emit();
}

/** The companion's settings, kept fresh across the tab. */
export function useCompanion(): CompanionState {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    subs.add(f);
    void loadCompanion();
    return () => void subs.delete(f);
  }, []);
  return state;
}

// --- the wake word: switched on per device -------------------------------------------------------------------------------------

const WAKE_KEY = 'pghl.companion.wake';
export const wakeOn = (): boolean => {
  try {
    return localStorage.getItem(WAKE_KEY) === '1';
  } catch {
    return false;
  }
};
export function setWake(on: boolean) {
  try {
    if (on) localStorage.setItem(WAKE_KEY, '1');
    else localStorage.removeItem(WAKE_KEY);
  } catch {
    /* storage blocked: the wake word stays off */
  }
  bus.set({ wake: on ? 'starting' : 'off' });
}
/** The browser has its own continuous speech recognition (Chrome, Edge, Safari) – the wake word needs it. */
export const canWake = () => typeof window !== 'undefined' && !!((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition);

// --- the bus -------------------------------------------------------------------------------------------------------------------

/** wake: the wake-word listener; activity: what the companion is doing right now (edge button, chip, prompt). */
export interface BusState {
  wake: 'off' | 'starting' | 'on' | 'paused' | 'error';
  wakeError: string;
  activity: 'idle' | 'hearing' | 'thinking' | 'speaking';
  /** what the wake-word listener heard after the wake phrase so far */
  partial: string;
  /** the prompt's own microphone is recording (the wake-word listener pauses meanwhile) */
  micBusy: boolean;
  /** a conversation (follow-up window, barge-in) or the realtime voice keeps the microphone open */
  conv: boolean;
}
interface Handlers {
  start: (mode: 'tap' | 'hold') => void;
  /** the shortcut was let go: end the recording, or – after a quick press (`asTap`) – keep listening until a pause */
  release: (asTap: boolean) => void;
  command: (text: string) => void;
  checkin: (id: string) => void;
  stopSpeaking: () => void;
  /** a proactive event or suggestion to show (and speak) in focus mode */
  proactive?: (o: Offer) => void;
  /** end the conversation and release the microphone */
  endConversation?: () => void;
}
type Pending = { listen?: 'tap' | 'hold'; command?: string; checkin?: string; offer?: Offer };

const busSubs = new Set<(s: BusState) => void>();
let handlers: Handlers | null = null;
let pending: Pending = {};

export const bus = {
  state: { wake: 'off', wakeError: '', activity: 'idle', partial: '', micBusy: false, conv: false } as BusState,
  set(patch: Partial<BusState>) {
    const next = { ...bus.state, ...patch };
    if (Object.keys(patch).every((k) => (bus.state as any)[k] === (next as any)[k])) return;
    bus.state = next;
    busSubs.forEach((f) => f(next));
  },
  on(fn: (s: BusState) => void) {
    busSubs.add(fn);
    return () => void busSubs.delete(fn);
  },
  /** The focus page while it is open; returns the detach function. Waiting requests are handed over at once. */
  attach(h: Handlers) {
    handlers = h;
    const p = pending;
    pending = {};
    if (p.checkin) h.checkin(p.checkin);
    if (p.offer) h.proactive?.(p.offer);
    if (p.command) h.command(p.command);
    else if (p.listen) h.start(p.listen);
    return () => {
      if (handlers === h) handlers = null;
    };
  },
  get attached() {
    return !!handlers;
  },
};

export function useBus(): BusState {
  const [s, set] = useState(bus.state);
  useEffect(() => bus.on(set), []);
  return s;
}

/** Edge button, shortcut: into focus mode (if not there yet) with the companion listening. `hold` ends with release(). */
export function summon(mode: 'tap' | 'hold' = 'tap') {
  if (bus.state.activity === 'speaking') handlers?.stopSpeaking();
  if (handlers) return handlers.start(mode);
  pending = { ...pending, listen: mode };
  enterFocus();
}
export function release(asTap = false) {
  if (handlers) return handlers.release(asTap);
  if (pending.listen === 'hold') pending.listen = 'tap';
}
/** The wake-word listener heard a command: it becomes the question (asked in focus mode). */
export function deliverCommand(text: string) {
  if (handlers) return handlers.command(text);
  pending = { ...pending, command: text, listen: undefined };
  enterFocus();
}
/** A check-in (notification, edge button): opened as the current view of focus mode. */
export function openCheckin(id: string) {
  if (handlers) return handlers.checkin(id);
  pending = { ...pending, checkin: id };
  enterFocus();
}
/** The wake word or the button while it speaks: stop talking (barge-in). */
export function interruptSpeaking() {
  handlers?.stopSpeaking();
}
/** A proactive offer picked at the edge button (or a push): shown and answered in focus mode. */
export function openOffer(o: Offer) {
  if (handlers?.proactive) return handlers.proactive(o);
  pending = { ...pending, offer: o };
  enterFocus();
}
/** Focus mode is open and can take a proactive offer itself. */
export const focusTakesOffers = () => !!handlers?.proactive;
/** The ✕ on the "Mikro an" pill, Esc: end the conversation. */
export function endConversation() {
  handlers?.endConversation?.();
}

/** "Was brennt?", "Lagebericht", "Briefing" … – the companion's briefing instead of a dashboard question. */
export const isBriefingAsk = (text: string) => /\b(was brennt|wo brennt|brennpunkte|lagebericht|lage ?bericht|briefing|what['’]?s (burning|on fire)|status report)\b/i.test(text.trim());
