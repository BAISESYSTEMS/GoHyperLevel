import type { App, Module } from '../core/app.js';
import { HttpError, type Ctx, type Route, type User } from '../core/http.js';
import { id, now } from '../core/util.js';
import { RateLimiter, cleanClientError, cleanDiagnostics, cleanUrl, fingerprint, normalizeMessage, redact, topFrame, type Diagnostics } from '../services/feedback.js';
import { autoCaptureOn, canonical, createItem, getItem, link, loadFeedbackSettings, roleLabel, serverVersion, setStatus, statusOf, ticketOf } from '../services/feedback-store.js';
import { addTicketEvent } from '../services/tickets.js';

/**
 * Automatic error capture for „Fehler & Wünsche“: uncaught browser errors (sent by the web app for
 * users who opted in – on by default for agency admins), errors from the Android app, and
 * unexpected server errors (via app.services.serverError, with stack, request id and route – never
 * request bodies). Each distinct error (fingerprint of normalised message + top stack frame) is
 * one ticket with an occurrence counter; a fixed error that comes back reopens its ticket.
 */

const MILESTONES = [10, 100, 1000, 10_000];
const SAMPLES = 10;

export interface CaptureInput {
  source: 'client' | 'server' | 'android';
  message: string;
  stack?: string;
  route?: string;
  user?: User | null;
  locationId?: string | null;
  requestId?: string;
  status?: number;
  diagnostics?: Diagnostics;
}

/** Browser noise that says nothing about our code. */
export function ignorable(e: { message: string; stack?: string; source?: string }): boolean {
  const m = String(e.message ?? '').trim();
  if (!m || m === 'Script error.' || m === 'Script error') return true;
  if (/ResizeObserver loop|Non-Error promise rejection captured|AbortError|The user aborted a request|Load failed$/i.test(m)) return true;
  return /(chrome|moz|safari(-web)?)-extension:\/\//.test(`${e.source ?? ''} ${e.stack ?? ''}`);
}

export function captureError(app: App, input: CaptureInput, newTickets: RateLimiter): { id: string; created: boolean; dropped?: boolean } | null {
  const { db } = app;
  const message = redact(input.message, 500) || 'Unbekannter Fehler';
  const stack = redact(input.stack ?? '', 6000);
  const fp = fingerprint(input.source, message, stack);
  const user = input.user ?? null;
  const optedIn = !!user && autoCaptureOn(app, user.id);
  const v = serverVersion(app);
  const sample = {
    at: now(),
    route: cleanUrl(input.route ?? '', 200) || undefined,
    request_id: input.requestId,
    status: input.status,
    role: user ? roleLabel(user) : undefined,
    location_id: input.locationId || undefined,
    version: input.source === 'android' ? input.diagnostics?.device?.app_version || input.diagnostics?.app_version : input.source === 'client' ? input.diagnostics?.build || undefined : v.version,
    browser: input.diagnostics?.user_agent ? input.diagnostics.user_agent.slice(0, 120) : undefined,
  };
  const existing = db.get('SELECT id FROM feedback_items WHERE fingerprint = ?', fp);
  if (existing) {
    const f = canonical(app, getItem(app, existing.id)!);
    const d: any = { ...(f.diagnostics ?? {}) };
    d.samples = [...(Array.isArray(d.samples) ? d.samples : []), sample].slice(-SAMPLES);
    if (input.locationId) {
      const locs = { ...(d.locations ?? {}) };
      if (locs[input.locationId] !== undefined || Object.keys(locs).length < 200) locs[input.locationId] = (Number(locs[input.locationId]) || 0) + 1;
      d.locations = locs;
    }
    db.run('UPDATE feedback_items SET occurrences = occurrences + 1, last_seen_at = ?, diagnostics = ?, updated_at = ? WHERE id = ?', now(), JSON.stringify(d), now(), f.id);
    if (optedIn) link(app, f.id, user!.id, input.locationId ?? null, 'affected');
    const n = f.occurrences + 1;
    const t = ticketOf(app, f);
    if (t && MILESTONES.includes(n)) {
      const users = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM feedback_links WHERE feedback_id = ?', f.id)!.n;
      addTicketEvent(app, t, 'note', { body: `Dieser Fehler ist jetzt ${n}× aufgetreten (${Object.keys(d.locations ?? {}).length} Sub-Accounts, ${users} Nutzer mit Fehlerberichten).`, data: { via: 'system', occurrences: n } });
    }
    // Fixed, but it happens again: back to work (the people affected only hear about the next fix).
    const st = statusOf(app, f, t);
    if (t && (st.key === 'behoben' || st.key === 'ausgeliefert')) {
      db.run('UPDATE feedback_items SET fixed_at = NULL WHERE id = ?', f.id);
      setStatus(app, f, 'bestaetigt', { via: 'system' }, { note: `Der Fehler tritt wieder auf${f.version ? ` (war behoben in Version ${f.version})` : ''}.` });
    }
    return { id: f.id, created: false };
  }
  // A storm of new errors (bad deploy) must not open hundreds of tickets: 30 new ones per hour.
  if (!newTickets.take('new')) return { id: '', created: false, dropped: true };
  const prefix = input.source === 'server' ? '[Server]' : input.source === 'android' ? '[Android]' : '[Browser]';
  const frame = topFrame(stack);
  const body = [
    `${input.source === 'server' ? 'Unerwarteter Server-Fehler' : input.source === 'android' ? 'Fehler in der Android-App' : 'Fehler im Browser'} – automatisch erfasst.`,
    '',
    `Meldung: ${message}`,
    frame ? `Stelle: ${frame}` : '',
    sample.route ? `Route: ${sample.route}` : '',
    input.requestId ? `Request-ID: ${input.requestId}` : '',
    sample.version ? `Version: ${sample.version}` : '',
    stack ? `\nStack:\n${stack.split('\n').slice(0, 25).join('\n')}` : '',
  ].filter((l) => l !== '').join('\n');
  const f = createItem(app, {
    kind: 'auto',
    user: optedIn ? user : null,
    originLocationId: input.locationId ?? null,
    title: `${prefix} ${normalizeMessage(message).slice(0, 150) || message.slice(0, 150)}`,
    body,
    platform: input.source === 'server' ? 'server' : input.source === 'android' ? 'android' : 'web',
    diagnostics: { ...(input.diagnostics ?? {}), message, stack, request_id: input.requestId, samples: [sample], locations: input.locationId ? { [input.locationId]: 1 } : {} } as any,
    fingerprint: fp,
    priority: input.source === 'server' ? 'hoch' : 'normal',
    tags: [input.source === 'server' ? 'server-fehler' : input.source === 'android' ? 'android-fehler' : 'browser-fehler'],
  });
  return { id: f.id, created: true };
}

export const feedbackCaptureModule: Module = {
  name: 'feedback-capture',
  register(app) {
    const perUser = new RateLimiter(20, 10 * 60_000);
    const newTickets = new RateLimiter(30, 3600_000);
    /** Tests reset the limits between cases. */
    app.services.feedbackCaptureReset = () => (perUser.reset(), newTickets.reset());

    /**
     * Unexpected server error (core: app.ts → services.serverError): one grouped ticket, the answer
     * gets a request id the user can quote. Never throws.
     */
    app.services.serverError = (e: unknown, ctx: Ctx, route?: Route): string => {
      const requestId = id(12);
      try {
        if (!loadFeedbackSettings(app).capture_server) return requestId;
        const err = e instanceof Error ? e : new Error(String(e));
        captureError(
          app,
          {
            source: 'server',
            message: `${err.name && err.name !== 'Error' ? `${err.name}: ` : ''}${err.message}`,
            stack: err.stack ?? '',
            route: `${ctx.method} ${route?.pattern ?? ctx.path}`,
            user: ctx.user ?? null,
            locationId: ctx.locationId || null,
            requestId,
            status: 500,
            diagnostics: { route: `${ctx.method} ${route?.pattern ?? ctx.path}`, server_version: serverVersion(app).version, platform: 'server' },
          },
          newTickets,
        );
      } catch (err) {
        console.error('[feedback] capture', (err as Error).message);
      }
      return requestId;
    };

    /** Browser (web app) and Android app send their uncaught errors here – only for users who opted in. */
    const clientErrors = (ctx: Ctx) => {
      const user = ctx.user!;
      const s = loadFeedbackSettings(app);
      if (!s.capture_client || !autoCaptureOn(app, user.id)) return { ok: true, skipped: 'off', results: [] };
      const b = ctx.body ?? {};
      const list = (Array.isArray(b.errors) ? b.errors : [b]).slice(0, 5);
      const source = ctx.via === 'app' || b.platform === 'android' ? 'android' : 'client';
      const diagnostics = cleanDiagnostics(b.diagnostics ?? {});
      const loc = String(b.location_id ?? diagnostics.location_id ?? '').trim();
      const locationId = loc && app.location(loc) && (user.role === 'admin' || user.locations.includes(loc)) ? loc : null;
      const results: any[] = [];
      for (const raw of list) {
        const e = cleanClientError(raw);
        if (ignorable({ message: e.message, stack: e.stack, source: e.source })) {
          results.push({ skipped: 'ignored' });
          continue;
        }
        if (!perUser.take(user.id)) throw new HttpError(429, 'Zu viele Fehlerberichte – bitte kurz warten');
        const r = captureError(app, { source, message: e.message, stack: e.stack || (e.source ? `at ${e.source}:${e.line}:${e.col}` : ''), route: diagnostics.route || diagnostics.url, user, locationId, diagnostics: { ...diagnostics, errors: undefined, api_errors: diagnostics.api_errors?.slice(-5) } }, newTickets);
        results.push(r ? { id: r.id, created: r.created, dropped: r.dropped || undefined } : { skipped: 'error' });
      }
      return { ok: true, results };
    };
    app.router.post('/api/feedback/client-errors', 'user', clientErrors);
    // The Android app's device token only works under /api/mobile.
    app.router.post('/api/mobile/client-errors', 'user', clientErrors);
  },
};
