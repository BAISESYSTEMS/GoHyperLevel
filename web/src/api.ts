/** Fetch wrapper: JSON in/out, CSRF header, current sub-account header, readable errors. */
import { fmtDate, fmtDateTime, fmtMoney, tr } from './i18n';

const t = tr('core');
let locationId = localStorage.getItem('pghl.location') ?? '';

export function setLocation(id: string) {
  locationId = id;
  try {
    localStorage.setItem('pghl.location', id);
  } catch {
    /* private mode */
  }
}
export const currentLocation = () => locationId;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** The whole JSON answer (a 409 from the undo journal carries `conflict` and the `diff`). */
    public data?: any,
  ) {
    super(message);
  }
}

/** Failed calls are announced (method, path, status, error text – never bodies) for the diagnostics of bug reports. */
const announce = (method: string, path: string, status: number, error: string) => typeof window !== 'undefined' && window.dispatchEvent(new CustomEvent('pghl:api-error', { detail: { method, path, status, error } }));

async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, {
      method,
      headers: {
        'x-pghl': '1',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(locationId ? { 'x-location-id': locationId } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch (e) {
    announce(method, path, 0, (e as Error).message || 'Netzwerkfehler'); // i18n-ignore (diagnostics for bug reports)
    throw e;
  }
  const type = r.headers.get('content-type') ?? '';
  const data = type.includes('json') ? await r.json() : await r.text();
  if (!r.ok) {
    if (r.status === 401 && !path.startsWith('/api/auth')) window.dispatchEvent(new Event('pghl:logout'));
    // The server's (German) text; ui.tsx shows it through serverText(), which translates the common ones.
    const message = (data && (data as any).error) || `Fehler ${r.status}`; // i18n-ignore
    announce(method, path, r.status, message);
    throw new ApiError(r.status, message, data);
  }
  // The undo journal names every change it recorded in the headers: the app offers "Rückgängig" (undo/Undo.tsx).
  const undoId = method !== 'GET' ? r.headers.get('x-undo-id') : null;
  if (undoId && typeof window !== 'undefined') {
    const dec = (v: string | null) => {
      try {
        return v ? decodeURIComponent(v) : '';
      } catch {
        return v ?? '';
      }
    };
    window.dispatchEvent(new CustomEvent('pghl:undo-entry', { detail: { id: undoId, label: dec(r.headers.get('x-undo-label')), notice: dec(r.headers.get('x-undo-notice')) } }));
  }
  // Live-Zusammenarbeit: a successful write – presence/client.ts tells the others on this page ("hat hier gerade gespeichert").
  if (method !== 'GET' && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('pghl:saved', { detail: { method, path } }));
  return data as T;
}

export const api = {
  get: <T = any>(p: string) => call<T>('GET', p),
  post: <T = any>(p: string, b: unknown = {}) => call<T>('POST', p, b),
  patch: <T = any>(p: string, b: unknown = {}) => call<T>('PATCH', p, b),
  put: <T = any>(p: string, b: unknown = {}) => call<T>('PUT', p, b),
  del: <T = any>(p: string) => call<T>('DELETE', p),
  /** Raw text (CSV export, HTML preview). */
  text: async (method: string, p: string, b?: unknown) => {
    const r = await fetch(p, { method, headers: { 'x-pghl': '1', 'x-location-id': locationId, ...(b ? { 'content-type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined });
    return r.text();
  },
};

// Numbers, money and dates follow the UI language (i18n/index.ts: de-DE for German, the browser's variant for English).
export const money = (cents: number, currency = 'EUR') => fmtMoney(cents, currency);
/** Sums per currency (`sumByCurrency` in format.ts) as "1.200,00 € · 300,00 $" – never added up; no sum at all is 0 in `fallback`. */
export const moneyList = (sums: [string, number][], fallback = 'EUR') => (sums.length ? sums.map(([c, v]) => money(v, c)).join(' · ') : money(0, fallback));
/** Whole-unit amount (deal values) in any currency, no decimals. */
export const amount = (v: number, currency = 'EUR') => fmtMoney((v || 0) * 100, currency || 'EUR', { maximumFractionDigits: 0 });
export const euro = (v: number) => fmtMoney((v || 0) * 100, 'EUR', { maximumFractionDigits: 0 });
export const dt = (s?: string | null) => (s ? fmtDateTime(s, { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–');
export const d = (s?: string | null) => (s ? fmtDate(s) : '–');
export const name = (c: any) => [c?.first_name, c?.last_name].filter(Boolean).join(' ') || c?.email || c?.phone || t('Unbekannt');
export const ago = (s?: string | null) => {
  if (!s) return '';
  const m = Math.round((Date.now() - new Date(s).getTime()) / 60000);
  if (m < 1) return t('gerade');
  if (m < 60) return t('vor {n} Min.', { n: m });
  if (m < 1440) return t('vor {n} Std.', { n: Math.round(m / 60) });
  return t('vor {n} T.', { n: Math.round(m / 1440) });
};

const MSG_STATUS: Record<string, string> = { queued: 'wartet', sent: 'gesendet', delivered: 'zugestellt', read: 'gelesen', logged: 'gespeichert (kein Versand)', failed: 'fehlgeschlagen', bounced: 'unzustellbar', complained: 'als Spam gemeldet', received: 'empfangen', draft: 'Entwurf', spam: 'Spam (blockiert)',
  // calls (channel "call")
  initiated: 'wird aufgebaut', ringing: 'klingelt', 'in-progress': 'läuft', completed: 'angenommen', missed: 'verpasst', voicemail: 'Voicemail', busy: 'besetzt', 'no-answer': 'nicht erreicht', canceled: 'abgebrochen' };
export const msgStatus = (s: string) => (MSG_STATUS[s] ? t(MSG_STATUS[s]) : s);
