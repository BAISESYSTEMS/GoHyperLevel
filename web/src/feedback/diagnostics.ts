import { currentLocation } from '../api';

/**
 * Client side of „Fehler & Wünsche“: two small ring buffers (last uncaught errors and last failed
 * API calls – status, path and the server's error text, never request bodies), the diagnostics block
 * a report carries, and the opt-in automatic error report (batched, throttled, sanitised again on
 * the server).
 */

export interface ClientErr {
  message: string;
  stack: string;
  source: string;
  line: number;
  col: number;
  at: string;
  count?: number;
}
export interface ApiErr {
  method: string;
  path: string;
  status: number;
  error: string;
  at: string;
}

const MAX = 20;
const errors: ClientErr[] = [];
const apiErrors: ApiErr[] = [];
let autoOn = false;
let installed = false;
const queue: ClientErr[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let sentThisPage = 0;

const SECRET = /([?&#](?:token|key|secret|code|password|auth|session|sig|signature|otp)=)[^&#]*/gi;
const scrub = (s: string, max: number) =>
  String(s ?? '')
    .replace(SECRET, '$1…')
    .replace(/Bearer\s+[\w.~+/=-]+/gi, 'Bearer …')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[E-Mail]')
    .slice(0, max);

function push<T>(list: T[], item: T) {
  list.push(item);
  if (list.length > MAX) list.splice(0, list.length - MAX);
}

function record(e: Omit<ClientErr, 'at'>) {
  const last = errors[errors.length - 1];
  if (last && last.message === e.message && last.source === e.source && last.line === e.line) {
    last.count = (last.count ?? 1) + 1;
    last.at = new Date().toISOString();
  } else push(errors, { ...e, message: scrub(e.message, 500), stack: scrub(e.stack, 4000), source: scrub(e.source, 300), at: new Date().toISOString() });
  if (autoOn) enqueue(errors[errors.length - 1]);
}

function enqueue(e: ClientErr) {
  // At most 10 automatic reports per page view; the server groups and rate-limits as well.
  if (sentThisPage >= 10 || queue.some((q) => q.message === e.message && q.source === e.source)) return;
  queue.push(e);
  clearTimeout(timer);
  timer = setTimeout(flush, 2500);
}

async function flush() {
  const batch = queue.splice(0, 5);
  if (!batch.length) return;
  sentThisPage += batch.length;
  try {
    await fetch('/api/feedback/client-errors', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pghl': '1' },
      credentials: 'same-origin',
      body: JSON.stringify({ errors: batch, location_id: currentLocation(), diagnostics: collectDiagnostics({ errors: false }) }),
    });
  } catch {
    /* offline – not worth retrying */
  }
  if (queue.length) timer = setTimeout(flush, 5000);
}

/** Called once at start: listens for uncaught errors, rejected promises and failed API calls. */
export function installDiagnostics() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (ev) => {
    const err = ev.error as Error | undefined;
    record({
      message: err?.message ? `${err.name ?? 'Error'}: ${err.message}` : String(ev.message ?? 'Fehler'),
      stack: err?.stack ?? '',
      source: ev.filename ?? '',
      line: ev.lineno ?? 0,
      col: ev.colno ?? 0,
    });
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason;
    // Failed API calls are already in the other list (and expected in the UI).
    if (r && typeof r === 'object' && 'status' in r && r.name !== 'TypeError') return;
    record({ message: r instanceof Error ? `${r.name}: ${r.message}` : `Unbehandelt: ${String(r).slice(0, 300)}`, stack: r instanceof Error ? (r.stack ?? '') : '', source: '', line: 0, col: 0 });
  });
  window.addEventListener('pghl:api-error', (ev) => {
    const d = (ev as CustomEvent).detail ?? {};
    // Never the feedback endpoints themselves (no loops), never request bodies.
    if (String(d.path ?? '').startsWith('/api/feedback/client-errors')) return;
    push(apiErrors, { method: String(d.method ?? 'GET'), path: scrub(d.path, 300), status: Number(d.status) || 0, error: scrub(d.error, 300), at: new Date().toISOString() });
  });
}

export function setAutoCapture(on: boolean) {
  autoOn = on;
}

/** Build id of the running web app: the hash of the main script (changes with every deploy). */
export function buildId(): string {
  const src = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.getAttribute('src') ?? '';
  return src.match(/index-([\w-]+)\.js/)?.[1] ?? 'dev';
}

function browserInfo(ua: string): { browser: string; os: string } {
  const os =
    /Android ([\d.]+)/.exec(ua)?.[0] ??
    (/iPhone|iPad/.test(ua)
      ? `iOS ${/OS ([\d_]+)/.exec(ua)?.[1]?.replace(/_/g, '.') ?? ''}`.trim()
      : /Windows NT 10/.test(ua)
        ? 'Windows 10/11'
        : /Mac OS X ([\d_]+)/.test(ua)
          ? `macOS ${/Mac OS X ([\d_]+)/.exec(ua)![1].replace(/_/g, '.')}`
          : /Linux/.test(ua)
            ? 'Linux'
            : 'Unbekannt');
  const m = /(Edg|OPR|Firefox|Chrome|Version)\/([\d.]+)/.exec(ua);
  const name = m ? (({ Edg: 'Edge', OPR: 'Opera', Version: /Safari/.test(ua) ? 'Safari' : 'Browser' } as Record<string, string>)[m[1]] ?? m[1]) : 'Browser';
  return { browser: m ? `${name} ${m[2].split('.')[0]}` : name, os };
}

export interface DiagnosticsBlock {
  url: string;
  route: string;
  location_id: string;
  location_name?: string;
  role?: string;
  build: string;
  user_agent: string;
  browser: string;
  os: string;
  viewport: string;
  screen: string;
  language: string;
  timezone: string;
  online: boolean;
  errors: ClientErr[];
  api_errors: ApiErr[];
}

export function collectDiagnostics(opts: { errors?: boolean } = {}): DiagnosticsBlock {
  const ua = navigator.userAgent;
  const { browser, os } = browserInfo(ua);
  return {
    url: scrub(location.href, 500),
    route: location.pathname,
    location_id: currentLocation(),
    build: buildId(),
    user_agent: ua.slice(0, 300),
    browser,
    os,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    screen: `${screen.width}x${screen.height}@${Math.round((window.devicePixelRatio || 1) * 100) / 100}`,
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    online: navigator.onLine,
    errors: opts.errors === false ? [] : errors.slice(-MAX),
    api_errors: apiErrors.slice(-MAX),
  };
}

/** Test/debug helper: what is in the buffers right now. */
export const diagnosticsCounts = () => ({ errors: errors.length, api: apiErrors.length });
