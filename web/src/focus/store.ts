import { useEffect } from 'react';
import { BASE, navigate } from '../ui';
import './shell.css';

/**
 * Fokus-Modus in the shell (docs/living-boards.md#fokus-modus): the route `focus` is the mode – sidebar, top bar and bottom bar
 * step aside, a round button opens the menu as a drawer. The browser remembers that the person is in it, so opening the app on
 * its bare address (a reload, the next morning) comes back to it; leaving it – "Fokus beenden", Esc, a menu entry, a link in a
 * tile – forgets it again. Storage can be blocked (private mode): then the mode simply is not remembered.
 */

const KEY = 'pghl.focus';
const FROM = 'pghl.focus.from';

const get = (k: string, store: () => Storage) => {
  try {
    return store().getItem(k);
  } catch {
    return null;
  }
};
const set = (k: string, v: string | null, store: () => Storage) => {
  try {
    if (v === null) store().removeItem(k);
    else store().setItem(k, v);
  } catch {
    /* storage blocked: nothing is remembered */
  }
};
const local = () => localStorage;
const session = () => sessionStorage;

export const rememberedFocus = () => get(KEY, local) === '1';
export const rememberFocus = (on: boolean) => set(KEY, on ? '1' : null, local);

/** Called once before the app renders: the bare app address goes straight back into focus mode when that was the last choice. */
export function resumeFocus() {
  if (typeof location === 'undefined' || location.pathname.replace(/\/+$/, '') !== BASE || location.search || !rememberedFocus()) return;
  history.replaceState(null, '', `${BASE}/focus`);
}

/** Into focus mode, remembering the page it was entered from (where "Fokus beenden" leads back to). */
export function enterFocus() {
  const here = location.pathname + location.search;
  if (!here.startsWith(`${BASE}/focus`)) set(FROM, here, session);
  rememberFocus(true);
  navigate('focus');
}

/** The app route (without the base path) focus mode was entered from – the companion's "das hier" – or undefined. */
export function focusFrom(): string | undefined {
  const from = get(FROM, session);
  if (!from || !from.startsWith(`${BASE}/`) || from.startsWith(`${BASE}/focus`)) return undefined;
  const route = from.slice(BASE.length + 1);
  // the inbox keeps the open conversation in ?c= (as the agent panel's currentRoute reads it)
  const c = route.startsWith('conversations?') ? new URLSearchParams(route.slice(route.indexOf('?'))).get('c') : null;
  return c ? `conversations/${c}` : route;
}

/** Back to the normal layout, on the page focus mode was entered from (or the start page). */
export function exitFocus() {
  rememberFocus(false);
  const from = get(FROM, session);
  set(FROM, null, session);
  navigate(from && from.startsWith(`${BASE}/`) && !from.startsWith(`${BASE}/focus`) ? from : BASE);
}

/** For the shell: whether the current route is focus mode; any other page the person goes to ends the remembered mode. */
export function useFocusMode(route: string[]): boolean {
  const on = route[0] === 'focus';
  const page = route[0] ?? '';
  useEffect(() => {
    // the bare start address says nothing (resumeFocus has already decided before the first render)
    if (page) rememberFocus(page === 'focus');
  }, [page]);
  return on;
}
