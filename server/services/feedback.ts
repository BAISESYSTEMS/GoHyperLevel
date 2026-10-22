import { createHash } from 'node:crypto';
import { bad } from '../core/http.js';
import type { Stage } from './helpdesk.js';

/**
 * Pure building blocks of „Fehler & Wünsche“ (bug reports, wish list, automatic error capture):
 * categories, severities, the ticket pipeline, public status names, diagnostics sanitising,
 * error fingerprints, screenshot checks and a small rate limiter. No database, no app.
 */

// --- what users can send -------------------------------------------------------------------

export type FeedbackKind = 'bug' | 'question' | 'wish' | 'auto';

/** Ticket category (in the support sub-account) ↔ kind. */
export const CATEGORY_OF: Record<FeedbackKind, string> = { bug: 'Fehler', question: 'Frage', wish: 'Verbesserungswunsch', auto: 'Fehler' };
export const KIND_OF_CATEGORY: Record<string, FeedbackKind> = { fehler: 'bug', bug: 'bug', frage: 'question', question: 'question', verbesserungswunsch: 'wish', wunsch: 'wish', wish: 'wish' };
export const FEEDBACK_CATEGORIES = ['Fehler', 'Verbesserungswunsch', 'Frage'];
export const kindOfCategory = (v: unknown): FeedbackKind => KIND_OF_CATEGORY[String(v ?? '').trim().toLowerCase()] ?? 'bug';

/** Severity → label and ticket priority (drives the helpdesk SLA). */
export const SEVERITIES: [key: string, label: string, priority: string][] = [
  ['gering', 'Kleinigkeit', 'niedrig'],
  ['mittel', 'Stört bei der Arbeit', 'normal'],
  ['hoch', 'Blockiert mich', 'hoch'],
  ['kritisch', 'Kritisch – Daten falsch oder alle betroffen', 'dringend'],
];
export const severityPriority = (s: string) => SEVERITIES.find((x) => x[0] === s)?.[2] ?? 'normal';
export const cleanSeverity = (v: unknown) => (SEVERITIES.some((x) => x[0] === v) ? String(v) : 'mittel');

/** Areas of the wish list (filter). */
export const AREAS = ['CRM', 'Marketing', 'Websites & Funnels', 'Automationen', 'Service', 'Umsatz', 'KI', 'App', 'Agentur', 'Sonstiges'];
export const cleanArea = (v: unknown) => {
  const s = String(v ?? '').trim().toLowerCase();
  return AREAS.find((a) => a.toLowerCase() === s) ?? 'Sonstiges';
};

// --- pipeline & status ------------------------------------------------------------------------

export const PIPELINE_NAME = 'Fehler & Wünsche';

/** The dedicated ticket pipeline in the support sub-account. Stage ids are what the feature relies on. */
export const feedbackStages = (): Stage[] => [
  { id: 'neu', name: 'Neu', kind: 'new' },
  { id: 'bestaetigt', name: 'Bestätigt', kind: 'open' },
  { id: 'in_arbeit', name: 'In Arbeit', kind: 'open' },
  { id: 'behoben', name: 'Behoben', kind: 'resolved' },
  { id: 'ausgeliefert', name: 'Ausgeliefert', kind: 'closed' },
  { id: 'abgelehnt', name: 'Abgelehnt', kind: 'closed' },
  { id: 'duplikat', name: 'Duplikat', kind: 'closed' },
];
export const STAGE_IDS = feedbackStages().map((s) => s.id);

/** Public status keys. Bugs show the stage names; wishes their own board (Idee → Geplant → In Arbeit → Fertig). */
export type StatusKey = 'neu' | 'bestaetigt' | 'in_arbeit' | 'behoben' | 'ausgeliefert' | 'abgelehnt' | 'duplikat';
const BUG_LABEL: Record<StatusKey, string> = { neu: 'Neu', bestaetigt: 'Bestätigt', in_arbeit: 'In Arbeit', behoben: 'Behoben', ausgeliefert: 'Ausgeliefert', abgelehnt: 'Abgelehnt', duplikat: 'Duplikat' };
export const WISH_BOARD: [key: string, label: string][] = [
  ['idea', 'Idee'],
  ['planned', 'Geplant'],
  ['in_progress', 'In Arbeit'],
  ['done', 'Fertig'],
  ['declined', 'Abgelehnt'],
];
const WISH_OF: Record<StatusKey, string> = { neu: 'idea', bestaetigt: 'planned', in_arbeit: 'in_progress', behoben: 'done', ausgeliefert: 'done', abgelehnt: 'declined', duplikat: 'duplicate' };
/** Wish board key → stage id (what „Geplant“ etc. set on the ticket). */
export const STAGE_OF_WISH: Record<string, StatusKey> = { idea: 'neu', planned: 'bestaetigt', in_progress: 'in_arbeit', done: 'ausgeliefert', declined: 'abgelehnt', duplicate: 'duplikat' };
const TONE: Record<StatusKey, string> = { neu: 'blue', bestaetigt: 'purple', in_arbeit: 'yellow', behoben: 'green', ausgeliefert: 'green', abgelehnt: 'gray', duplikat: 'gray' };

/** Our stage key from a ticket's stage (other pipelines / renamed stages fall back on the stage kind). */
export function statusKey(stageId: string | null | undefined, kind: string | null | undefined): StatusKey {
  if (stageId && (STAGE_IDS as string[]).includes(stageId)) return stageId as StatusKey;
  if (kind === 'new') return 'neu';
  if (kind === 'resolved') return 'behoben';
  if (kind === 'closed') return 'ausgeliefert';
  return 'in_arbeit';
}

export function publicStatus(kind: FeedbackKind, stageId: string | null | undefined, stageKind: string | null | undefined) {
  const key = statusKey(stageId, stageKind);
  const done = ['behoben', 'ausgeliefert', 'abgelehnt', 'duplikat'].includes(key);
  if (kind === 'wish') {
    const w = WISH_OF[key];
    return { key, board: w, label: w === 'duplicate' ? 'Zusammengeführt' : (WISH_BOARD.find((b) => b[0] === w)?.[1] ?? 'Idee'), tone: TONE[key], done };
  }
  // A question is answered rather than fixed.
  const label = kind === 'question' && (key === 'behoben' || key === 'ausgeliefert') ? 'Beantwortet' : BUG_LABEL[key];
  return { key, board: '', label, tone: TONE[key], done };
}

/** A stage from what callers send: our stage id, a stage name, a wish board key or a ticket kind. */
export function stageFromInput(v: unknown): StatusKey | undefined {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return undefined;
  if ((STAGE_IDS as string[]).includes(s)) return s as StatusKey;
  if (STAGE_OF_WISH[s]) return STAGE_OF_WISH[s];
  const byName = (Object.entries(BUG_LABEL) as [StatusKey, string][]).find(([, l]) => l.toLowerCase() === s)?.[0];
  if (byName) return byName;
  const wishName = WISH_BOARD.find((b) => b[1].toLowerCase() === s)?.[0];
  if (wishName) return STAGE_OF_WISH[wishName];
  const kinds: Record<string, StatusKey> = { new: 'neu', open: 'bestaetigt', confirmed: 'bestaetigt', in_progress: 'in_arbeit', resolved: 'behoben', fixed: 'behoben', closed: 'ausgeliefert', shipped: 'ausgeliefert', rejected: 'abgelehnt', declined: 'abgelehnt', duplicate: 'duplikat' };
  return kinds[s];
}

// --- diagnostics -------------------------------------------------------------------------------

const SECRET_KEY = /pass(word)?|passwort|token|secret|api[_-]?key|apikey|auth|session|cookie|signature|^sig$|^code$|otp|^key$|jwt|credential|iban/i;

/** Takes secrets, emails, card numbers and long random strings out of free text (error messages, stacks, paths). */
export function redact(input: unknown, max = 2000): string {
  let s = typeof input === 'string' ? input : input === undefined || input === null ? '' : String(input);
  s = s.slice(0, max * 2);
  s = s
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [entfernt]')
    .replace(/\b(?:ghm|pghla|pghl|sk_live|sk_test|rk_live|pk_live|whsec|sk-ant|sk-proj|xox[abpr])[-_][A-Za-z0-9_-]{6,}/g, '[Schlüssel entfernt]')
    .replace(/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '[Token entfernt]')
    .replace(/((?:pass(?:word)?|passwort|token|secret|api[_-]?key|apikey|authorization|session|cookie|signature|otp)["']?\s*[:=]\s*["']?)[^\s"'&,;)}…]+/gi, '$1[entfernt]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[E-Mail]')
    .replace(/\b(?:\d[ -]?){13,19}\b/g, '[Nummer]')
    .replace(/\b[A-Za-z0-9+_-]{40,}={0,2}/g, '[entfernt]');
  return s.slice(0, max);
}

/** A URL or path without secrets in the query or fragment (token=…, key=…, #access_token=…). */
export function cleanUrl(input: unknown, max = 500): string {
  const raw = String(input ?? '').trim().slice(0, 2000);
  if (!raw) return '';
  // A screen name from the app ("Einstellungen") or a route pattern ("POST /api/x") is no URL.
  if (!/[/?#]/.test(raw) || /^[A-Z]+ \//.test(raw)) return redact(raw, max);
  try {
    const u = new URL(raw, 'http://local.invalid');
    for (const k of [...u.searchParams.keys()]) if (SECRET_KEY.test(k)) u.searchParams.set(k, '…');
    if (/token|key|secret|code|auth/i.test(u.hash)) u.hash = '';
    const out = raw.startsWith('/') || u.origin === 'http://local.invalid' ? `${u.pathname}${u.search}${u.hash}` : u.toString();
    return redact(decodeURI(out).replace(/…/g, '…'), max);
  } catch {
    return redact(raw.split('?')[0], max);
  }
}

const clip = (v: unknown, max: number) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : '');
const at = (v: unknown) => {
  const t = Date.parse(String(v ?? ''));
  return Number.isNaN(t) ? '' : new Date(t).toISOString();
};

export interface ClientError {
  message: string;
  stack: string;
  source: string;
  line: number;
  col: number;
  at: string;
  count?: number;
}
export interface ApiFailure {
  method: string;
  path: string;
  status: number;
  error: string;
  at: string;
}

export function cleanClientError(e: any): ClientError {
  return {
    message: redact(e?.message, 500) || 'Unbekannter Fehler',
    stack: redact(e?.stack, 4000),
    source: cleanUrl(e?.source, 300),
    line: Math.max(0, Math.min(10_000_000, Math.round(Number(e?.line) || 0))),
    col: Math.max(0, Math.min(10_000_000, Math.round(Number(e?.col) || 0))),
    at: at(e?.at),
    ...(Number(e?.count) > 1 ? { count: Math.min(9999, Math.round(Number(e.count))) } : {}),
  };
}

export function cleanApiFailure(e: any): ApiFailure {
  const method = clip(e?.method, 8).toUpperCase();
  return {
    method: /^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(method) ? method : 'GET',
    path: cleanUrl(e?.path ?? e?.url, 300),
    status: Math.max(0, Math.min(999, Math.round(Number(e?.status) || 0))),
    // Only the error text the server sent back – never request bodies.
    error: redact(e?.error ?? e?.message, 300),
    at: at(e?.at),
  };
}

export interface Diagnostics {
  url?: string;
  route?: string;
  location_id?: string;
  location_name?: string;
  role?: string;
  app_version?: string;
  build?: string;
  server_version?: string;
  user_agent?: string;
  os?: string;
  browser?: string;
  viewport?: string;
  screen?: string;
  language?: string;
  timezone?: string;
  online?: boolean;
  device?: { model?: string; manufacturer?: string; android?: string; sdk?: number; app_version?: string };
  errors?: ClientError[];
  api_errors?: ApiFailure[];
  [k: string]: unknown;
}

/** Whitelists and sanitises what a browser or the Android app sends along with a report. */
export function cleanDiagnostics(input: any): Diagnostics {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const d: Diagnostics = {};
  const set = (k: keyof Diagnostics, v: string) => v && ((d as any)[k] = v);
  set('url', cleanUrl(input.url));
  set('route', cleanUrl(input.route, 200));
  set('location_id', clip(input.location_id, 40));
  set('app_version', clip(input.app_version, 40));
  set('build', clip(input.build, 60));
  set('user_agent', clip(input.user_agent, 300));
  set('os', clip(input.os, 60));
  set('browser', clip(input.browser, 60));
  set('viewport', /^\d{1,5}\s*[x×]\s*\d{1,5}$/.test(String(input.viewport ?? '')) ? String(input.viewport).replace(/\s/g, '') : '');
  set('screen', /^\d{1,5}\s*[x×]\s*\d{1,5}(@[\d.]{1,4})?$/.test(String(input.screen ?? '')) ? String(input.screen).replace(/\s/g, '') : '');
  set('language', clip(input.language, 20));
  set('timezone', clip(input.timezone, 60));
  if (typeof input.online === 'boolean') d.online = input.online;
  if (input.device && typeof input.device === 'object') {
    const dv = input.device;
    d.device = {
      ...(clip(dv.model, 80) ? { model: clip(dv.model, 80) } : {}),
      ...(clip(dv.manufacturer, 60) ? { manufacturer: clip(dv.manufacturer, 60) } : {}),
      ...(clip(dv.android, 20) ? { android: clip(dv.android, 20) } : {}),
      ...(Number.isInteger(Number(dv.sdk)) && Number(dv.sdk) > 0 && Number(dv.sdk) < 1000 ? { sdk: Number(dv.sdk) } : {}),
      ...(clip(dv.app_version, 40) ? { app_version: clip(dv.app_version, 40) } : {}),
    };
  }
  if (Array.isArray(input.errors)) d.errors = input.errors.slice(-20).map(cleanClientError);
  if (Array.isArray(input.api_errors)) d.api_errors = input.api_errors.slice(-20).map(cleanApiFailure);
  return d;
}

// --- fingerprints (one ticket per distinct error) ----------------------------------------------

/** The message without the parts that change between occurrences (numbers, ids, quoted values). */
export function normalizeMessage(m: string): string {
  return String(m ?? '')
    .replace(/(["'`]).{0,200}?\1/g, '"…"')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '#')
    .replace(/\b[A-Za-z0-9]{16,}\b/g, '#')
    .replace(/\d+/g, '0')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** First stack frame as "function@file" without line numbers and build hashes (index-B2xk3mQ9.js → index.js). */
export function topFrame(stack: string): string {
  for (const line of String(stack ?? '').split('\n').slice(0, 30)) {
    // JVM (Android app): "at org.gohigh.android.widget.Kit.render(Kit.kt:42)"
    const jvm = line.match(/^\s*at\s+([\w$.<>]+)\(([\w$]+\.(?:kt|java)):\d+\)\s*$/);
    if (jvm) return `${jvm[1].split('.').slice(-2).join('.')}@${jvm[2]}`;
    const v8 = line.match(/^\s*at\s+(?:(.+?)\s+\()?(?:async\s+)?(.+?):\d+:\d+\)?\s*$/);
    const ff = !v8 && line.match(/^\s*([^@\s]*)@(.+?):\d+:\d+\s*$/);
    const m = v8 || ff;
    if (!m) continue;
    const file = m[2].replace(/^.*[\\/]/, '').replace(/\?.*$/, '').replace(/-[A-Za-z0-9_]{6,12}(?=\.\w+$)/, '');
    if (!file || /^(node:|internal)/.test(m[2])) continue;
    const fn = (m[1] || '').replace(/^Object\./, '').replace(/\s*\[as .+\]$/, '').slice(0, 80);
    return `${fn || '<anonym>'}@${file}`;
  }
  return '';
}

export function fingerprint(source: 'client' | 'server' | 'android', message: string, stack = ''): string {
  return createHash('sha256').update(`${source}|${normalizeMessage(message)}|${topFrame(stack)}`).digest('hex').slice(0, 24);
}

// --- screenshots ---------------------------------------------------------------------------------

export const SCREENSHOT_MAX = 3 * 1024 * 1024;
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};
export const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** A screenshot as data URL → bytes. PNG, JPEG or WebP, at most 3 MB, and the bytes must match the type. */
export function parseScreenshot(input: unknown, max = SCREENSHOT_MAX): { mime: string; buf: Buffer } {
  const m = String(input ?? '').match(/^data:([\w/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!m) throw bad('Screenshot bitte als Bild (data:-URL)');
  const mime = m[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : m[1].toLowerCase();
  if (!MAGIC[mime]) throw bad('Screenshot nur als PNG, JPG oder WebP');
  // Base64 is 4/3 of the bytes – refuse oversized input before decoding it.
  if (m[2].length > Math.ceil((max * 4) / 3) + 8) throw bad(`Screenshot ist größer als ${Math.round(max / 1024 / 1024)} MB`);
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > max) throw bad(`Screenshot ist größer als ${Math.round(max / 1024 / 1024)} MB`);
  if (buf.length < 16 || !MAGIC[mime](buf)) throw bad('Dateiinhalt passt nicht zum Bildtyp');
  return { mime, buf };
}

// --- rate limits -----------------------------------------------------------------------------------

/** Sliding-window counter per key (in memory – a restart forgets, which is fine for flood protection). */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private max: number,
    private windowMs: number,
  ) {}
  /** Counts a hit; false when the key is over its limit. */
  take(key: string, at = Date.now()): boolean {
    const list = (this.hits.get(key) ?? []).filter((t) => at - t < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(at);
    this.hits.set(key, list);
    if (this.hits.size > 20_000) this.hits.clear();
    return true;
  }
  reset() {
    this.hits.clear();
  }
}

/** The first line of a text as a subject. */
export function subjectOf(text: string, max = 120): string {
  const line = String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
