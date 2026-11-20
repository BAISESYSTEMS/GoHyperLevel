import { useEffect, useState } from 'react';
import type { FirstRunPlan } from './first-run-model';

/**
 * The wizard's answers for the "Erste Schritte" card – per person and browser (localStorage), like the academy hint and the
 * setup checklist. Nothing here is a setting: losing it only means the card shows the academy hint instead.
 */

const key = (userId: string) => `hl.firstrun.${userId}`;
const hideKey = (userId: string) => `hl.firstrun.hide.${userId}`;
const EVENT = 'hl:firstrun';

export function readPlan(userId: string): FirstRunPlan | null {
  try {
    const raw = localStorage.getItem(key(userId));
    const p = raw ? JSON.parse(raw) : null;
    return p && typeof p.data === 'string' && typeof p.success === 'string' ? p : null;
  } catch {
    return null;
  }
}

export function savePlan(userId: string, plan: FirstRunPlan) {
  try {
    localStorage.setItem(key(userId), JSON.stringify(plan));
    localStorage.removeItem(hideKey(userId));
  } catch {
    /* private window: the card falls back to the academy hint */
  }
  // a dashboard that is already open behind the wizard shows the card right away
  window.dispatchEvent(new Event(EVENT));
}


/** The saved answers, updated when the wizard finishes while the page is open. */
export function usePlan(userId: string): FirstRunPlan | null {
  const [plan, setPlan] = useState(() => readPlan(userId));
  useEffect(() => {
    const on = () => setPlan(readPlan(userId));
    on();
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, [userId]);
  return plan;
}

export function planHidden(userId: string): boolean {
  try {
    return localStorage.getItem(hideKey(userId)) === '1';
  } catch {
    return false;
  }
}

export function hidePlan(userId: string) {
  try {
    localStorage.setItem(hideKey(userId), '1');
  } catch {
    /* private window: hidden until the next reload */
  }
}

/** `?<name>` in the address bar – an intent like "open the import right away" (FirstRun → Kontakte, Formulare, Kalender). */
export function useIntent(name: string): boolean {
  const [on] = useState(() => typeof location !== 'undefined' && new URLSearchParams(location.search).has(name));
  // Taken once: a reload or the back button must not open the dialog again.
  useEffect(() => {
    if (!on) return;
    const q = new URLSearchParams(location.search);
    q.delete(name);
    const rest = q.toString();
    history.replaceState(history.state, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return on;
}
