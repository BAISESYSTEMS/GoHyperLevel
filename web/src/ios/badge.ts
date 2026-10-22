import { useEffect, useSyncExternalStore } from 'react';
import { api } from '../api';

/**
 * The number on the app icon (Badging API – installed apps on iOS/iPadOS 16.4+, Android, desktop) and the unread count in the bottom
 * bar: what is unread across the sub-accounts the person may see (GET /api/app-badge). Refreshed when the app comes back to
 * the front, on navigation and every 90 s while visible; push messages carry the number too (web/public/sw.js), so the icon is
 * right while the app is closed. Tests: tests/ios-logic.test.ts.
 */

export interface BadgeNav {
  setAppBadge?: (n?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

/** 'set' with a number, 'clear' for nothing (a badge of 0 must remove the dot, not show "0"). */
export function badgeAction(n: number): { kind: 'set'; n: number } | { kind: 'clear' } {
  const v = Math.max(0, Math.min(999, Math.round(Number(n) || 0)));
  return v > 0 ? { kind: 'set', n: v } : { kind: 'clear' };
}

/** Applies it where the browser can. Never throws: no permission yet, or no Badging API. Returns whether something was done. */
export async function applyBadge(n: number, nav: BadgeNav = navigator as unknown as BadgeNav): Promise<boolean> {
  const a = badgeAction(n);
  try {
    if (a.kind === 'set' && nav.setAppBadge) return (await nav.setAppBadge(a.n), true);
    if (a.kind === 'clear' && nav.clearAppBadge) return (await nav.clearAppBadge(), true);
  } catch {
    /* iOS rejects it until notifications are allowed */
  }
  return false;
}

let unread = 0;
const subs = new Set<() => void>();
const set = (n: number) => {
  if (n === unread) return;
  unread = n;
  subs.forEach((f) => f());
};

/** Unread messages of the sub-account on screen (the bottom bar's number; the app icon counts all sub-accounts). */
export const useUnread = () => useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => unread, () => 0);

export async function refreshBadge(): Promise<void> {
  try {
    const r = await api.get<{ unread: number; total: number; here?: number }>('/api/app-badge');
    set(r.here ?? r.unread); // the bar shows the sub-account on screen, the icon all of them
    await applyBadge(r.total);
  } catch {
    /* offline or signed out: keep what we have */
  }
}

/** Mounted once in the app shell. */
export function useAppBadge(): void {
  useEffect(() => {
    let timer = 0;
    let later = 0;
    const visible = () => document.visibilityState !== 'hidden';
    const now = () => visible() && void refreshBadge();
    const soon = () => {
      clearTimeout(later);
      later = window.setTimeout(now, 1500);
    };
    const out = () => {
      set(0);
      void applyBadge(0);
    };
    now();
    timer = window.setInterval(now, 90_000);
    document.addEventListener('visibilitychange', now);
    window.addEventListener('focus', now);
    window.addEventListener('pageshow', now);
    window.addEventListener('online', now);
    window.addEventListener('pghl:nav', soon);
    window.addEventListener('pghl:badge', now);
    window.addEventListener('pghl:logout', out);
    return () => {
      clearInterval(timer);
      clearTimeout(later);
      document.removeEventListener('visibilitychange', now);
      window.removeEventListener('focus', now);
      window.removeEventListener('pageshow', now);
      window.removeEventListener('online', now);
      window.removeEventListener('pghl:nav', soon);
      window.removeEventListener('pghl:badge', now);
      window.removeEventListener('pghl:logout', out);
    };
  }, []);
}
