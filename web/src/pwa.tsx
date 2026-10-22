import { useEffect, useState } from 'react';
import { api, currentLocation, setLocation } from './api';
import { navigate } from './ui';

/**
 * Installable app: service worker registration, the install prompt and Web Push on this device.
 * The worker lives at /sw.js with scope /app (public pages like /i/… or /book/… stay untouched).
 */

const SCOPE = '/app';

// Opened from a notification of another sub-account (…?loc=<id>): switch before the app loads.
try {
  const u = new URL(location.href);
  const loc = u.searchParams.get('loc');
  if (loc && /^[A-Za-z0-9_-]{4,64}$/.test(loc)) {
    setLocation(loc);
    u.searchParams.delete('loc');
    history.replaceState(null, '', u.pathname + u.search + u.hash);
  }
} catch {
  /* ignore */
}

// The browser offers installation early, often before React has mounted – keep the event.
let installEvent: any = null;
const installListeners = new Set<() => void>();
const changed = () => installListeners.forEach((f) => f());
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  changed();
});
window.addEventListener('appinstalled', () => {
  installEvent = null;
  changed();
});

export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
export const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function registerPwa() {
  if (!('serviceWorker' in navigator)) return;
  const register = () => navigator.serviceWorker.register('/sw.js', { scope: SCOPE }).catch(() => undefined);
  if (document.readyState === 'complete') void register();
  else window.addEventListener('load', () => void register(), { once: true });
  // A click on a notification while the app is open: go to the page (and sub-account) it is about.
  navigator.serviceWorker.addEventListener('message', (e) => {
    const d = e.data;
    if (d?.type !== 'navigate' || typeof d.url !== 'string' || !d.url.startsWith(SCOPE)) return;
    if (d.location_id && d.location_id !== currentLocation()) {
      setLocation(d.location_id);
      location.href = d.url;
      return;
    }
    navigate(d.url);
  });
  // Session gone: the offline copy of API answers must go too.
  window.addEventListener('pghl:logout', () => navigator.serviceWorker.controller?.postMessage({ type: 'logout' }));
}

/** The pending install prompt (Chrome, Edge, Android), or null. */
export function useInstallPrompt() {
  const [, setN] = useState(0);
  useEffect(() => {
    const f = () => setN((n) => n + 1);
    installListeners.add(f);
    return () => void installListeners.delete(f);
  }, []);
  return installEvent;
}

export async function promptInstall(): Promise<boolean> {
  if (!installEvent) return false;
  const e = installEvent;
  installEvent = null;
  changed();
  await e.prompt();
  const choice = await e.userChoice.catch(() => null);
  return choice?.outcome === 'accepted';
}

// --- push on this device -----------------------------------------------------------
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const s = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) => !!a && a.byteLength === b.length && new Uint8Array(a).every((x, i) => x === b[i]);

export async function deviceSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration(SCOPE);
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export async function enablePush(): Promise<PushSubscription> {
  if (!pushSupported()) throw new Error('Dieser Browser unterstützt keine Push-Benachrichtigungen');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied' ? 'Benachrichtigungen sind im Browser blockiert – bitte in den Website-Einstellungen erlauben' : 'Keine Erlaubnis erteilt');
  if (!(await navigator.serviceWorker.getRegistration(SCOPE))) await navigator.serviceWorker.register('/sw.js', { scope: SCOPE });
  const reg = await navigator.serviceWorker.ready;
  const key = keyBytes((await api.get<{ key: string }>('/api/push/public-key')).key);
  let sub = await reg.pushManager.getSubscription();
  // Made with another server key (e.g. after a reinstall): replace it.
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api.post('/api/push/subscribe', { subscription: sub.toJSON() });
  return sub;
}

export async function disablePush(): Promise<void> {
  const sub = await deviceSubscription();
  if (!sub) return;
  await api.del(`/api/push/subscribe?endpoint=${encodeURIComponent(sub.endpoint)}`).catch(() => undefined);
  await sub.unsubscribe().catch(() => undefined);
}

// --- install hint --------------------------------------------------------------------
const HINT_KEY = 'pghl.installHint';
const hintDismissed = () => {
  try {
    return Number(localStorage.getItem(HINT_KEY) ?? 0) > Date.now();
  } catch {
    return false;
  }
};

/**
 * Small card when the browser can install the app itself (Chrome, Edge, Android). iPhone and iPad have no install prompt: they get
 * the guided "Zum Home-Bildschirm hinzufügen" sheet instead (web/src/ios/InstallSheet.tsx).
 */
export function InstallHint() {
  const prompt = useInstallPrompt();
  const [hidden, setHidden] = useState(() => isStandalone() || hintDismissed());
  const close = () => {
    try {
      localStorage.setItem(HINT_KEY, String(Date.now() + 30 * 864e5));
    } catch {
      /* private mode */
    }
    setHidden(true);
  };
  if (hidden || !prompt) return null;
  return (
    <div className="install-hint" role="dialog" aria-label="App installieren">
      <img src="/pwa/icon/icon-180.png" alt="" width={40} height={40} />
      <div className="install-text">
        <strong>App installieren</strong>
        <span className="muted small">Startet wie eine App und meldet neue Nachrichten aufs Gerät.</span>
      </div>
      <button className="btn small" onClick={async () => ((await promptInstall()) ? setHidden(true) : close())}>
        Installieren
      </button>
      <button className="icon-btn" onClick={close} aria-label="Schließen">
        ✕
      </button>
    </div>
  );
}
