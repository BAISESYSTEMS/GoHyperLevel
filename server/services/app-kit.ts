import type { App } from '../core/app.js';
import { connectorFetch, readJson, type ConnectorConfig, type ConnectorField } from './connectors.js';
import type { SafeResponse } from './net.js';
import type { ActionOutcome } from './workflow-engine.js';
import { addToDate, fromWall, parseDate, wallClock } from './formatters.js';
import { assign, rowsOf, text, tzOf, type ActionMeta, type FieldDef } from './wfx-kit.js';

/**
 * Shared parts of the native app steps (Slack, Trello, HubSpot, Shopify …): one request helper that either calls the app's
 * API directly with the saved token (safeFetch, no internal targets) or – when the connector names a Nango integration
 * and Nango is set up – sends the same request through Nango, which owns the OAuth sign-in. Errors come back in German
 * with the app's name; results become run variables.
 */

export interface AppSpec {
  /** Shown in error messages. */
  name: string;
  base: (cfg: ConnectorConfig) => string;
  headers?: (cfg: ConnectorConfig) => Record<string, string>;
  /** Query parameters added to every request (Trello: key and token). */
  query?: (cfg: ConnectorConfig) => Record<string, string>;
  /** What Nango's base URL for this provider lacks compared to `base` (a path prefix such as `/api` or `/v3`). */
  nangoPrefix?: string;
}

export interface AppReq {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** application/x-www-form-urlencoded instead of JSON */
  form?: Record<string, string>;
  headers?: Record<string, string>;
  /** Statuses that are not errors (e.g. 404 when looking something up). */
  accept?: number[];
}

export interface AppResult {
  status: number;
  data: any;
}

export const NANGO_FIELD: ConnectorField = {
  key: 'nango_integration',
  label: 'Nango-Integration (OAuth statt Token)',
  max: 100,
  placeholder: 'z. B. trello',
  pattern: /^[A-Za-z0-9_.-]{1,100}$/,
  patternHint: 'Nur Buchstaben, Ziffern, Punkt, Minus und Unterstrich',
  help: 'Optional: Name der Integration in Nango (Apps → Nango). Dann laufen die Aufrufe über Nango mit OAuth und das Token-Feld bleibt leer.',
};

/** Which sign-in a saved connector uses. */
export const usesNango = (cfg: ConnectorConfig) => !!cfg.nango_integration?.trim();

export function qs(params: Record<string, string | number | boolean | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

/** One call to an app's API (see AppSpec). Throws an Error with a German message when the app says no. */
export async function appCall(app: App, locationId: string, cfg: ConnectorConfig, spec: AppSpec, req: AppReq): Promise<AppResult> {
  const method = req.method ?? 'GET';
  if (usesNango(cfg)) {
    const nango = app.services.nango;
    if (!nango?.config?.()) throw new Error(`${spec.name}: Nango ist nicht eingerichtet (Agentur → Integrationen → Nango) – oder die Nango-Integration im Feld entfernen und ein Token eintragen.`);
    const r = await nango.request(locationId, { integration: cfg.nango_integration.trim(), method, path: `${spec.nangoPrefix ?? ''}${req.path}`, query: Object.fromEntries(Object.entries(req.query ?? {}).filter(([, v]) => v !== undefined && v !== '')), body: req.form ?? req.body, headers: req.headers }, { source: 'workflow' });
    if (!r.ok && !(req.accept ?? []).includes(r.status)) throw new Error(`${spec.name} (Nango): ${method} ${req.path} → HTTP ${r.status} ${typeof r.data === 'string' ? r.data.slice(0, 160) : JSON.stringify(r.data ?? '').slice(0, 160)}`);
    return { status: r.status, data: r.data };
  }
  const query = { ...(spec.query?.(cfg) ?? {}), ...(req.query ?? {}) };
  const url = `${spec.base(cfg).replace(/\/$/, '')}${req.path}${qs(query)}`;
  const headers: Record<string, string> = { accept: 'application/json', ...(spec.headers?.(cfg) ?? {}), ...(req.headers ?? {}) };
  let body: string | undefined;
  if (req.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(req.form).toString();
  } else if (req.body !== undefined && method !== 'GET') {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(req.body);
  }
  const r = await connectorFetch(app)(url, { method, headers, body, timeoutMs: 20_000, maxBytes: 2 * 1024 * 1024 });
  const raw = await r.text();
  let data: any = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }
  if (r.ok || (req.accept ?? []).includes(r.status)) return { status: r.status, data };
  // readJson turns the status into the usual German message (401/403 → Zugriff verweigert …); apps put the reason in different places
  const reason = data && typeof data === 'object' ? (data.message ?? data.detail ?? data.error_description ?? data.error?.message ?? data.errors?.[0]?.message ?? data.errors?.[0] ?? data.title ?? (typeof data.error === 'string' ? data.error : undefined)) : undefined;
  const shim = { status: r.status, ok: false, headers: r.headers, text: async () => (reason !== undefined ? JSON.stringify({ message: typeof reason === 'string' ? reason : JSON.stringify(reason) }) : raw) } as SafeResponse;
  await readJson(shim, spec.name);
  throw new Error(`${spec.name} antwortet ${r.status}`);
}

/** Basic auth header value. */
export const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

// --- step descriptions ------------------------------------------------------------------------------

export function appMeta(app: string, m: Omit<ActionMeta, 'category' | 'app' | 'icon'> & { icon?: string }): ActionMeta {
  return { category: 'apps', icon: 'apps', app, ...m };
}

/** Puts values of an app's answer into variables ("Ergebnis"-Zeilen) the way the workflow steps promise. */
export function setVars(out: ActionOutcome, values: Record<string, unknown>): ActionOutcome {
  out.vars = { ...(out.vars ?? {}), ...values };
  return out;
}

export const MAP_FIELD: FieldDef = {
  key: 'save_to',
  label: 'Ergebnis speichern in',
  type: 'target',
  help: 'Optional: z. B. die ID/den Link in ein Kontaktfeld legen (custom.trello_link). Immer auch als Variable verfügbar.',
};

/** Writes `value` where the step's "Ergebnis speichern in" says, if set. */
export function saveResult(out: ActionOutcome, step: any, value: unknown): ActionOutcome {
  if (String(step.save_to ?? '').trim()) assign(out, step.save_to, value);
  return out;
}

// --- "when" of an appointment-like step (Google Calendar, Zoom) -----------------------------------

export const WHEN_FIELDS: FieldDef[] = [
  { key: 'when', label: 'Zeitpunkt', type: 'select', options: [['in', 'In … ab jetzt'], ['at', 'Zu einem Datum']], default: 'in' },
  { key: 'amount', label: 'Menge', type: 'number', default: 1, showIf: { field: 'when', in: ['in'] } },
  { key: 'unit', label: 'Einheit', type: 'select', options: [['hours', 'Stunden'], ['days', 'Tage'], ['weeks', 'Wochen'], ['business_days', 'Werktage']], default: 'days', showIf: { field: 'when', in: ['in'] } },
  { key: 'date', label: 'Datum / Zeit', type: 'text', placeholder: '2026-12-01 14:00  ·  {{var.termin}}', showIf: { field: 'when', in: ['at'] } },
  { key: 'time', label: 'Uhrzeit (HH:mm)', type: 'time', default: '10:00', help: 'Leer = die Uhrzeit des berechneten Zeitpunkts.' },
  { key: 'duration', label: 'Dauer (Minuten)', type: 'number', default: 30 },
];

/** Start and end of the step's "Zeitpunkt" in the sub-account's time zone (DST-safe). Throws a German message for bad input. */
export function whenOf(app: App, locationId: string, step: any, vars: Record<string, any>): { start: Date; end: Date; minutes: number } {
  const tz = tzOf(app, locationId);
  let start: Date;
  if (step.when === 'at') {
    const d = parseDate(text(step.date, vars), tz);
    if (!d) throw new Error('Datum/Zeit ist ungültig');
    start = d;
  } else start = addToDate(new Date(), Number(step.amount ?? 1) || 0, String(step.unit ?? 'days'), tz);
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(step.time ?? ''))) {
    const [h, m] = String(step.time).split(':').map(Number);
    start = fromWall({ ...wallClock(start, tz), h, mi: m, s: 0 }, tz);
  }
  const minutes = Math.min(24 * 60, Math.max(5, Number(step.duration) || 30));
  return { start, end: new Date(start.getTime() + minutes * 60_000), minutes };
}

export { rowsOf, text };
