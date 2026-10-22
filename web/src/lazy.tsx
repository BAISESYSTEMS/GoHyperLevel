import { Component, lazy, Suspense, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { tr, useT } from './i18n';

/**
 * Route-level code splitting. Pages (and the heavier parts of the app shell) load as their own chunks:
 *
 *   const { Contacts, ContactDetail } = lazyPages(() => import('./pages/Contacts'), 'Contacts', 'ContactDetail');
 *
 * Each returned component renders like the original (same props) inside a <Suspense>, and has
 * `preload()` – used on hover/idle so the next page is usually there before the click. A chunk that
 * fails to load after a deploy (the old file is gone) reloads the page once to get the new build.
 */

const RELOAD_KEY = 'pghl.chunk-reload';

/** Reload once per 30 s at most: a missing chunk usually means a new version was deployed. */
export function reloadForNewBuild(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < 30_000) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    /* storage blocked: reload anyway */
  }
  location.reload();
  return true;
}

if (typeof window !== 'undefined') {
  // Vite's own preload helper reports failed CSS/JS dependencies of a dynamic import here.
  window.addEventListener('vite:preloadError', (e) => {
    if (reloadForNewBuild()) e.preventDefault();
  });
}

type Preloadable = { preload: () => Promise<unknown> };
export type LazyPage<C> = C & Preloadable;

export function lazyPages<M extends Record<string, any>, K extends keyof M & string>(loader: () => Promise<M>, ...names: K[]): { [P in K]: LazyPage<M[P]> } {
  let pending: Promise<M> | undefined;
  const load = () =>
    (pending ??= loader().catch((e) => {
      pending = undefined;
      reloadForNewBuild();
      throw e;
    }));
  const out = {} as Record<string, unknown>;
  for (const name of names) {
    const C = lazy(() => load().then((m) => ({ default: m[name] as ComponentType<any> })));
    out[name] = Object.assign(C, { preload: load });
  }
  return out as { [P in K]: LazyPage<M[P]> };
}

/** Starts loading a lazy component's chunk (no-op for ordinary components). */
export function preload(...components: unknown[]) {
  for (const c of components) void (c as Partial<Preloadable>)?.preload?.().catch(() => undefined);
}

/**
 * Calls fn once the page has had `delay` ms to load its own data and the browser is idle (or after `timeout`
 * more ms). Background downloads started earlier would share the – possibly slow – connection with the
 * requests the visible page is waiting for. Skipped on save-data / 2G unless `always`. Returns a cancel function.
 */
export function whenIdle(fn: () => void, { delay = 0, timeout = 2000, always = false }: { delay?: number; timeout?: number; always?: boolean } = {}) {
  const conn = (navigator as any).connection;
  if (!always && (conn?.saveData || /(^|-)2g$/.test(conn?.effectiveType ?? ''))) return () => undefined;
  const w = window as any;
  let cancel = () => undefined as void;
  const timer = window.setTimeout(() => {
    if (typeof w.requestIdleCallback === 'function') {
      const id = w.requestIdleCallback(fn, { timeout });
      cancel = () => w.cancelIdleCallback(id);
    } else {
      const id = window.setTimeout(fn, Math.min(timeout, 1200));
      cancel = () => clearTimeout(id);
    }
  }, delay);
  return () => {
    clearTimeout(timer);
    cancel();
  };
}

/** Placeholder while a page's chunk loads – the tour engine waits while it is on screen. */
export function PageSkeleton() {
  const t = useT('core');
  return (
    <div className="page-skeleton" data-suspense="page" aria-busy="true" aria-label={t('Lädt')}>
      <div className="sk sk-title" />
      <div className="sk-row">
        <div className="sk sk-card" />
        <div className="sk sk-card" />
        <div className="sk sk-card" />
      </div>
      <div className="sk sk-block" />
    </div>
  );
}

/** A chunk that could not be loaded (offline, or replaced by a deploy within the reload guard). */
class ChunkBoundary extends Component<{ children: ReactNode; quiet?: boolean }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    if (this.props.quiet) return null;
    const t = tr('core');
    return (
      <div className="empty" role="alert">
        <p>{t('Dieser Bereich konnte nicht geladen werden – vielleicht gibt es gerade eine neue Version.')}</p>
        <button className="btn" onClick={() => location.reload()}>
          {t('Neu laden')}
        </button>
      </div>
    );
  }
}

/** A page boundary: skeleton while loading, a reload hint if the chunk fails. */
export function PageSuspense({ children }: { children: ReactNode }) {
  return (
    <ChunkBoundary>
      <Suspense fallback={<PageSkeleton />}>{children}</Suspense>
    </ChunkBoundary>
  );
}

/** Shell parts (buttons, panels) that may appear a moment later: no placeholder, nothing on failure. */
export function Later({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  return (
    <ChunkBoundary quiet>
      <Suspense fallback={fallback}>{children}</Suspense>
    </ChunkBoundary>
  );
}

/** Non-critical shell parts (help, agent, feedback, phone): mounted – and downloaded – a moment after the page, when idle. */
export function Deferred({ children, delay = 2500 }: { children: ReactNode; delay?: number }) {
  const [ready, setReady] = useState(false);
  useEffect(() => whenIdle(() => setReady(true), { delay, always: true }), []);
  return ready ? <Later>{children}</Later> : null;
}
