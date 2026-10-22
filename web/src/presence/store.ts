import { useSyncExternalStore } from 'react';
import type { PresencePrefs } from '../../../server/services/presence-model';

/**
 * Live-Zusammenarbeit (docs/collaboration.md): the small shared state the shell reads – the sidebar's avatars, the top
 * bar – while the connection itself (presence/client.ts) and every component (presence/Presence.tsx) load as a chunk of
 * their own a moment after the page. Kept tiny on purpose: this file is part of the first download.
 */

/** A colleague's open tab, as the server lets this person see it (page null = only "online"). */
export interface Peer {
  id: string;
  user_id: string;
  name: string;
  color: string;
  page: string | null;
  title: string | null;
  editing: boolean;
  cursors: boolean;
}

export interface PresenceState {
  /** The stream is up and the sub-account has the feature on. */
  live: boolean;
  enabled: boolean;
  prefs: PresencePrefs;
  peers: Peer[];
  /** My own tab: the page I am on and whether I am typing there. */
  page: string;
  editing: boolean;
  /** The latest "saved here" by somebody else on my page (cleared on navigation). */
  saved: { name: string; page: string; at: number } | null;
}

let state: PresenceState = { live: false, enabled: true, prefs: { invisible: false, menu: true, cursors: 'boards' }, peers: [], page: '', editing: false, saved: null };
const listeners = new Set<() => void>();

export const presenceState = () => state;
export function setPresence(next: Partial<PresenceState>) {
  state = { ...state, ...next };
  for (const fn of listeners) fn();
}
const subscribe = (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn));
export const usePresence = () => useSyncExternalStore(subscribe, presenceState, presenceState);

/** One entry per person (several tabs: the one on a visible page wins). */
export function people(peers: Peer[]): Peer[] {
  const by = new Map<string, Peer>();
  for (const p of peers) {
    const cur = by.get(p.user_id);
    if (!cur || (!cur.page && p.page) || (p.editing && !cur.editing && p.page)) by.set(p.user_id, p);
  }
  return [...by.values()];
}

let lastPeers: Peer[] | null = null;
let lastByRoute = new Map<string, Peer[]>();
/** Menu route (first path segment) → the colleagues there, one entry per person. */
export function peersByRoute(peers: Peer[]): Map<string, Peer[]> {
  if (peers === lastPeers) return lastByRoute;
  const out = new Map<string, Peer[]>();
  for (const p of peers) {
    if (!p.page) continue;
    const r = p.page.split('/')[1] ?? '';
    const list = out.get(r) ?? [];
    if (!list.some((x) => x.user_id === p.user_id)) list.push(p);
    out.set(r, list);
  }
  lastPeers = peers;
  lastByRoute = out;
  return out;
}
