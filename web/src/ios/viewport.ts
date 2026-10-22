import { useSyncExternalStore } from 'react';
import { initPopoverClamp } from './popover-clamp';
import { COMPACT_QUERY, type SizeClass, isIosDevice, isNativeShell, isStandalone, keyboardInset, readSegments, sizeClass } from './platform';

/**
 * Puts what CSS cannot know on <html>, once per change (never a reload, never a remount – a window that is resized, a foldable that
 * opens or an iPad in Split View keeps its route, scroll position, open dialogs and typed text, docs/ios-web-app.md):
 *   data-size     compact | medium | expanded   by WIDTH only (phones, foldable folded, Slide Over | rail | full sidebar)
 *   data-keyboard "open" while the on-screen keyboard covers the page, with --kb-h, --vv-h, --vv-top for the visible part
 *   data-standalone / data-ios / data-shell    started from the home screen / iPhone-iPad / inside the Android app
 *   data-segments "2" and --hinge-gap          only where a browser reports a fold (Safari does not, nothing depends on it)
 * Everything is also readable in React: useSizeClass().
 */

let size: SizeClass = 'expanded';
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn));

/** The current width class; re-renders when the window crosses a boundary (not on every pixel). */
export const useSizeClass = (): SizeClass => useSyncExternalStore(subscribe, () => size, () => 'expanded');
export const currentSize = () => size;

let started = false;

/**
 * The conversation is scrolled by the whole thread in the phone layout and by its message list in the two-pane layout (two different
 * elements). Folding or unfolding must not throw the reader back to the top: remember how far down they are (as a share of what can
 * be scrolled) and give it to whichever of the two scrolls after the switch.
 */
const SCROLL_PAIR = ['.inbox .thread', '.inbox .msgs'];
let pairRatio: number | null = null;
function followScroll(win: Window) {
  win.document.addEventListener(
    'scroll',
    (e) => {
      const el = e.target as Element | null;
      if (!el || typeof el.matches !== 'function' || !SCROLL_PAIR.some((sel) => el.matches(sel))) return;
      const max = el.scrollHeight - el.clientHeight;
      if (max > 1) pairRatio = Math.min(1, Math.max(0, el.scrollTop / max));
    },
    { capture: true, passive: true },
  );
}
function restoreScroll(win: Window) {
  if (pairRatio === null) return;
  for (const sel of SCROLL_PAIR) {
    const el = win.document.querySelector<HTMLElement>(sel);
    if (!el || el.scrollHeight - el.clientHeight <= 1 || !/(auto|scroll)/.test(win.getComputedStyle(el).overflowY)) continue;
    el.scrollTop = pairRatio * (el.scrollHeight - el.clientHeight);
  }
}

export function initViewport(win: Window = window): void {
  if (started || typeof document === 'undefined') return;
  started = true;
  const root = document.documentElement;
  const nav = win.navigator as Navigator & { standalone?: boolean };
  const matches = (q: string) => !!win.matchMedia?.(q).matches;
  if (isIosDevice(nav)) root.dataset.ios = '1';
  if (isStandalone(nav, matches)) root.dataset.standalone = '1';
  if (isNativeShell(nav)) root.dataset.shell = 'android';
  initPopoverClamp(win);

  let frame = 0;
  const apply = () => {
    frame = 0;
    // Width of the window as CSS sees it (innerWidth includes a scrollbar; there is none on iOS).
    const next = sizeClass(win.innerWidth);
    root.dataset.size = next;
    const vv = win.visualViewport;
    const kb = vv ? keyboardInset({ innerHeight: win.innerHeight, vvHeight: vv.height, vvTop: vv.offsetTop, vvScale: vv.scale }) : 0;
    root.style.setProperty('--vv-h', `${Math.round(vv?.height ?? win.innerHeight)}px`);
    root.style.setProperty('--vv-top', `${Math.round(vv?.offsetTop ?? 0)}px`);
    root.style.setProperty('--kb-h', `${kb}px`);
    if (kb > 0) root.dataset.keyboard = 'open';
    else delete root.dataset.keyboard;
    const seg = readSegments(win as never);
    if (seg.count > 1) {
      root.dataset.segments = String(seg.count);
      root.dataset.fold = seg.fold ?? '';
      root.style.setProperty('--hinge-gap', `${seg.gap}px`);
    } else {
      delete root.dataset.segments;
      delete root.dataset.fold;
      root.style.removeProperty('--hinge-gap');
    }
    if (next !== size) {
      size = next;
      listeners.forEach((f) => f());
      // After React and the new layout have settled.
      win.requestAnimationFrame(() => win.requestAnimationFrame(() => restoreScroll(win)));
    }
  };
  const schedule = () => {
    if (!frame) frame = win.requestAnimationFrame(apply);
  };
  size = sizeClass(win.innerWidth);
  followScroll(win);
  apply();
  win.addEventListener('resize', schedule);
  win.addEventListener('orientationchange', schedule);
  win.visualViewport?.addEventListener('resize', schedule);
  win.visualViewport?.addEventListener('scroll', schedule);
  // A browser that exposes the fold (Chromium's Viewport Segments) fires this when it changes.
  win.matchMedia?.('(horizontal-viewport-segments: 2)').addEventListener?.('change', schedule);
  win.matchMedia?.(COMPACT_QUERY).addEventListener?.('change', schedule);

  // With the keyboard up, bring the field that has the focus into view inside its own scroll container (iOS only scrolls the page).
  win.document.addEventListener('focusin', (e) => {
    const el = e.target as HTMLElement | null;
    if (!el?.matches?.('input, textarea, select, [contenteditable="true"]')) return;
    win.setTimeout(() => {
      if (root.dataset.keyboard === 'open') el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 300);
  });
}

/** Asks the browser not to evict this app's storage (iOS 17+ honours it for apps on the home screen; harmless elsewhere). */
export function keepStorage(win: Window = window): void {
  try {
    if (win.document.documentElement.dataset.standalone === '1') void win.navigator.storage?.persist?.();
  } catch {
    /* not supported */
  }
}
