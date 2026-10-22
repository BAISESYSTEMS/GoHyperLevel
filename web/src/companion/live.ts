import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * Jarvis meldet sich (1.0.54): the open app asks GET /api/companion/live every ~15 seconds while the tab is visible (that is also how
 * the server knows the companion is open – an event is then spoken instead of pushed). New interrupts ("Neuer Lead: Lea …") and the
 * initiative's open suggestions land in this small store; the edge button and focus mode show them and offer the next step. A spoken
 * offer may be answered with "ja" – that only hands the step to the HyperLevel Agent, whose confirmation card still needs a click.
 */

export interface NextAction {
  label: string;
  prompt?: string;
  url?: string;
  entity?: { type: string; id: string; label: string };
}
export interface LiveSuggestion {
  id: string;
  kind: string;
  title: string;
  say: string;
  draft_type: string;
  draft: string;
  entity: { type: string; id: string; label: string } | null;
  source: 'ai' | 'rules';
  status: string;
}
export interface LiveEvent {
  id: string;
  kind: string;
  title: string;
  say: string;
  route: 'speak' | 'card' | 'push' | 'digest';
  action: NextAction | null;
  suggestion: LiveSuggestion | null;
  created_at: string;
}
/** The last thing the companion offered aloud – "ja" / "nein" answers it for two minutes. */
export interface Offer {
  title: string;
  say: string;
  eventId?: string;
  suggestionId?: string;
  action?: NextAction | null;
  at: number;
  /** say it aloud when shown (an interrupt), else just show it */
  speak?: boolean;
  /** picked with "Ja, bitte" outside focus mode: accept at once */
  accept?: boolean;
}
export interface LiveState {
  events: LiveEvent[];
  suggestions: LiveSuggestion[];
  offer: Offer | null;
}

const POLL_MS = 15_000;
export const OFFER_MS = 2 * 60_000;
let state: LiveState = { events: [], suggestions: [], offer: null };
const subs = new Set<(s: LiveState) => void>();
const fresh = new Set<(e: LiveEvent) => void>();

export const liveStore = {
  get state() {
    return state;
  },
  set(patch: Partial<LiveState>) {
    state = { ...state, ...patch };
    subs.forEach((f) => f(state));
  },
  on(fn: (s: LiveState) => void) {
    subs.add(fn);
    return () => void subs.delete(fn);
  },
  /** each new event once (the layer or focus mode speaks/shows it) */
  onEvent(fn: (e: LiveEvent) => void) {
    fresh.add(fn);
    return () => void fresh.delete(fn);
  },
};

export function useLive(): LiveState {
  const [s, set] = useState(state);
  useEffect(() => liveStore.on(set), []);
  return s;
}

/** Polls while the tab is visible; returns the stop function. */
export function startLivePoll(): () => void {
  let alive = true;
  const poll = async () => {
    if (!alive || document.hidden) return;
    const r = await api.get<{ events: LiveEvent[]; suggestions: LiveSuggestion[] }>('/api/companion/live').catch(() => null);
    if (!alive || !r) return;
    const known = new Set(state.events.map((e) => e.id));
    const added = r.events.filter((e) => !known.has(e.id));
    liveStore.set({ events: [...added, ...state.events].slice(0, 5), suggestions: r.suggestions });
    for (const e of added) fresh.forEach((f) => f(e));
  };
  void poll();
  const timer = setInterval(() => void poll(), POLL_MS);
  const vis = () => !document.hidden && void poll();
  document.addEventListener('visibilitychange', vis);
  return () => {
    alive = false;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', vis);
  };
}

export const offerFrom = (e: LiveEvent): Offer => ({ title: e.title, say: e.say, eventId: e.id, suggestionId: e.suggestion?.id, action: e.action, at: Date.now(), speak: e.route === 'speak' });
export const offerFromSuggestion = (s: LiveSuggestion): Offer => ({ title: s.title, say: s.say, suggestionId: s.id, at: Date.now() });
export const offerOpen = (o: Offer | null) => !!o && Date.now() - o.at < OFFER_MS;

/** What to do on a "yes": the agent's prompt and record (a suggestion's draft travels as quoted data), or a page. */
export async function acceptOffer(o: Offer): Promise<{ prompt?: string; entity?: NextAction['entity'] | null; label: string; url?: string } | null> {
  liveStore.set({ offer: null, events: state.events.filter((e) => e.id !== o.eventId), suggestions: state.suggestions.filter((s) => s.id !== o.suggestionId) });
  if (o.eventId) void api.post(`/api/companion/events/${o.eventId}`, { status: 'done' }).catch(() => undefined);
  if (o.suggestionId) {
    const r = await api.post<{ prompt?: string; entity?: any; label?: string }>(`/api/companion/suggestions/${o.suggestionId}`, { status: 'accepted' }).catch(() => null);
    if (r?.prompt) return { prompt: r.prompt, entity: r.entity ?? null, label: r.label || o.title };
  }
  const a = o.action;
  if (!a) return null;
  return a.prompt ? { prompt: a.prompt, entity: a.entity ?? null, label: a.label } : a.url ? { url: a.url, label: a.label } : null;
}

export function declineOffer(o: Offer) {
  liveStore.set({ offer: null, events: state.events.filter((e) => e.id !== o.eventId), suggestions: state.suggestions.filter((s) => s.id !== o.suggestionId) });
  if (o.eventId) void api.post(`/api/companion/events/${o.eventId}`, { status: 'dismissed' }).catch(() => undefined);
  if (o.suggestionId) void api.post(`/api/companion/suggestions/${o.suggestionId}`, { status: 'declined' }).catch(() => undefined);
}
