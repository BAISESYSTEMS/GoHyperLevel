import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { tr, useT } from './i18n';

const t = tr('core');

/**
 * Start-up safety net, the app's half of web/public/boot-guard.js:
 * - <MountFlag/> sets `window.__pghlMounted = true` once the first render is on screen. The boot guard (10 s) and the
 *   Android app look at it – without it the page counts as "did not start".
 * - <StartSpinner/> is the first screen while the session loads: after 15 s it offers Neu laden.
 * - <RootBoundary/> catches what no page boundary caught (shell, menu, login …). React unmounts the whole tree on an
 *   uncaught render error, which used to leave a blank page; now the same plain fallback page as the boot guard's
 *   is shown and the error is reported (automatic error capture, for users who allowed it).
 */

interface PghlBoot {
  errors: unknown[];
  clearOffline: () => Promise<unknown>;
  add: (kind: string, message: string, source?: string, line?: number, col?: number, stack?: string) => void;
  render: (target: HTMLElement, reason?: string) => void;
  report: (reason?: string, headline?: string) => boolean;
}

declare global {
  interface Window {
    __pghlMounted?: boolean;
    __pghlBoot?: PghlBoot;
  }
}

export function MountFlag() {
  useEffect(() => {
    window.__pghlMounted = true;
  }, []);
  return null;
}

/**
 * What the first screen shows while the session is being loaded. A request that never answers used to leave a tiny
 * spinner on an otherwise empty screen; after 15 s there is a message and a way out.
 */
export function StartSpinner() {
  const t = useT('core');
  const [slow, setSlow] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 15_000);
    return () => clearTimeout(t);
  }, []);
  const clear = async () => {
    setBusy(true);
    await window.__pghlBoot?.clearOffline();
    location.reload();
  };
  return (
    <>
      <div className="spinner" aria-label={t('Lädt')} />
      {slow && (
        <div className="empty" role="status">
          <p>{t('Das dauert länger als gewöhnlich – vielleicht ist die Verbindung schlecht.')}</p>
          <button className="btn" onClick={() => location.reload()}>
            {t('Neu laden')}
          </button>{' '}
          {window.__pghlBoot && (
            <button className="btn secondary" disabled={busy} onClick={clear}>
              {t('Offline-Daten löschen')}
            </button>
          )}
        </div>
      )}
    </>
  );
}

/** The fallback page: the guard's plain DOM when it is there (works without our CSS), else a React one. */
function BootFallback({ error }: { error: Error }) {
  const host = useRef<HTMLDivElement>(null);
  const boot = window.__pghlBoot;
  const text = `${error.name || 'Error'}: ${error.message}`;
  useEffect(() => {
    if (!boot || !host.current) return;
    boot.add('render', text, '', 0, 0, error.stack ?? '');
    boot.render(host.current, text);
    boot.report('Darstellungsfehler', text); // i18n-ignore (headline of the bug report)
  }, []);
  if (boot) return <div ref={host} />;
  return (
    <div className="empty" role="alert">
      <h1>{t('Die App konnte nicht starten')}</h1>
      <p>{text}</p>
      <button className="btn" onClick={() => location.reload()}>
        {t('Neu laden')}
      </button>
    </div>
  );
}

export class RootBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    window.__pghlMounted = false;
    console.error('Darstellungsfehler:', error, info.componentStack); // i18n-ignore
  }
  render() {
    return this.state.error ? <BootFallback error={this.state.error} /> : this.props.children;
  }
}
