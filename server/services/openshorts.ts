import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError, bad } from '../core/http.js';
import { APP_VERSION } from '../version.js';

/**
 * Client for an OpenShorts instance (https://github.com/mutonby/openshorts, MIT) – self-hosted
 * (no auth, BYOK keys in its own environment) or the hosted API (api.openshorts.app, `osk_…` key).
 * Only the REST API is used; no OpenShorts code lives here. Pure helpers (options → request body,
 * clip parsing, progress from the log, webhook signatures) are exported for tests.
 */

export interface OsConfig {
  url: string;
  apiKey?: string;
  /** ElevenLabs and fal.ai stay BYOK even on the hosted API and only travel as request headers. */
  elevenlabsKey?: string;
  falKey?: string;
}
export type FetchLike = (input: string, init?: any) => Promise<Response>;

export interface OsRequest {
  json?: unknown;
  form?: FormData;
  /** Raw body (e.g. a Blob of the video file). */
  body?: unknown;
  contentType?: string;
  headers?: Record<string, string>;
  /** Whole request (default 20 s); for `stream` only until the response headers arrive. */
  timeoutMs?: number;
  stream?: boolean;
  elevenlabs?: boolean;
  fal?: boolean;
}

/** Normalises what people paste: trailing slashes, /docs, /api, /openapi.json. */
export function osBase(url: string): string {
  return String(url ?? '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(docs|api|openapi\.json|health)$/i, '')
    .replace(/\/+$/, '');
}

/** The backend address: http(s) only; internal Docker names (http://openshorts:8000) are fine – the agency sets it. */
export function cleanBaseUrl(raw: unknown): string {
  const url = osBase(String(raw ?? ''));
  if (!url) return '';
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw bad('Adresse ungültig – z. B. http://openshorts:8000 oder https://api.openshorts.app');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw bad('Adresse mit http:// oder https:// angeben');
  if (u.username || u.password) throw bad('Zugangsdaten gehören nicht in die Adresse – API-Schlüssel separat eintragen');
  if (url.length > 300) throw bad('Adresse ist zu lang');
  return url;
}

export async function osFetch(f: FetchLike, cfg: OsConfig, method: string, path: string, opts: OsRequest = {}): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': `HyperLevel-VideoStudio/${APP_VERSION}`, ...(opts.headers ?? {}) };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  if (opts.elevenlabs && cfg.elevenlabsKey) headers['x-elevenlabs-key'] = cfg.elevenlabsKey;
  if (opts.fal && cfg.falKey) headers['x-fal-key'] = cfg.falKey;
  let body: any;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    body = opts.body;
    if (opts.contentType) headers['content-type'] = opts.contentType;
  }
  const ms = opts.timeoutMs ?? 20_000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new DOMException('timeout', 'TimeoutError')), ms);
  const init: any = { method, headers, body, signal: ac.signal, redirect: 'manual' };
  if (body && typeof body.getReader === 'function') init.duplex = 'half';
  try {
    const r = await f(osBase(cfg.url) + path, init);
    if (opts.stream) clearTimeout(timer);
    else {
      // Keep the timer for the body: read it here so the timeout covers the whole request.
      const buf = await r.arrayBuffer();
      clearTimeout(timer);
      return new Response(buf.byteLength ? buf : null, { status: r.status, statusText: r.statusText, headers: r.headers });
    }
    return r;
  } catch (e) {
    clearTimeout(timer);
    const err = e as Error;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new HttpError(504, 'OpenShorts antwortet nicht (Zeitüberschreitung)');
    throw new HttpError(502, `OpenShorts nicht erreichbar: ${err.message}`);
  }
}

export async function osJson<T = any>(f: FetchLike, cfg: OsConfig, method: string, path: string, opts: OsRequest = {}): Promise<T> {
  const r = await osFetch(f, cfg, method, path, { ...opts, stream: false });
  const raw = await r.text();
  let data: any = raw;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    /* plain text */
  }
  if (!r.ok) throw osError(r.status, data);
  return data as T;
}

/** OpenShorts (FastAPI) errors → German messages; status codes stay meaningful for the caller. */
export function osError(status: number, data: any): HttpError {
  const code = status === 400 || status === 422 ? 400 : status === 401 || status === 403 ? 502 : [402, 404, 409, 413, 429].includes(status) ? status : 502;
  return new HttpError(code, osErrorMessage(status, data));
}

export function osErrorMessage(status: number, data: any): string {
  const detail = data && typeof data === 'object' ? (data.detail ?? data.error ?? data.message) : data;
  if (status === 401 || status === 403) return 'OpenShorts: API-Schlüssel fehlt oder ist ungültig';
  if (detail && typeof detail === 'object') {
    if (detail.error === 'quota_exceeded') return `OpenShorts: Minuten-Kontingent erschöpft (nötig ${detail.minutes_required ?? '?'}, übrig ${detail.minutes_remaining ?? 0})`;
    if (detail.error === 'no_plan') return 'OpenShorts: Das Konto braucht einen aktiven Tarif (oder eigene Schlüssel)';
    if (detail.error === 'plan_required') return 'OpenShorts: Diese Funktion gibt es nur in bezahlten Tarifen';
    const msg = detail.message ?? detail.error;
    return `OpenShorts (${status}): ${String(msg ?? JSON.stringify(detail)).slice(0, 300)}`;
  }
  const s = String(detail ?? '').trim();
  if (Array.isArray(detail)) return `OpenShorts (${status}): ${detail.map((d: any) => d?.msg ?? d).join(', ').slice(0, 300)}`;
  if (/X-Gemini-Key|Gemini/i.test(s) && /missing/i.test(s)) return 'In OpenShorts ist kein Gemini-Schlüssel hinterlegt (GEMINI_API_KEY oder LLM_BASE_URL in der OpenShorts-Umgebung setzen)';
  if (/ElevenLabs/i.test(s) && /missing/i.test(s)) return 'ElevenLabs-Schlüssel fehlt (Agentur → Integrationen → OpenShorts)';
  if (/fal\.ai/i.test(s) && /missing/i.test(s)) return 'fal.ai-Schlüssel fehlt (Agentur → Integrationen → OpenShorts)';
  const short = s.match(/only (\d+)s long/);
  if (short) return `Das Video ist nur ${short[1]} s lang – zu kurz, um daraus Clips zu schneiden`;
  if (/YouTube URL ingest is disabled/i.test(s)) return 'Diese OpenShorts-Instanz nimmt keine YouTube-Links an – bitte die Datei hochladen';
  if (/^This link is /i.test(s)) return 'Bitte den Link eines einzelnen Videos angeben (youtube.com/watch?v=… oder youtu.be/…), keine Playlist oder Kanalseite';
  if (/can't be processed|Invalid webhook_url/i.test(s)) return `OpenShorts kann diese Adresse nicht verarbeiten: ${s.replace(/^.*?:\s*/, '').slice(0, 200)}`;
  if (/File too large/i.test(s) || status === 413) return 'Die Datei ist zu groß für OpenShorts (max. 2 GB)';
  if (/Job not found|Session not found|not found/i.test(s) || status === 404) return 'In OpenShorts nicht (mehr) vorhanden – evtl. abgelaufen oder nach einem Neustart verloren';
  if (status === 429) return 'OpenShorts: zu viele Anfragen – bitte kurz warten';
  return `OpenShorts (${status}): ${s.slice(0, 300) || 'Fehler'}`;
}

// --- webhook signature --------------------------------------------------------------------

/** `X-OpenShorts-Signature: sha256=<hex hmac-sha256(body, secret)>` */
export function signBody(secret: string, body: string | Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}
export function verifySignature(secret: string, body: string | Buffer, header: unknown): boolean {
  if (!secret || typeof header !== 'string' || !header) return false;
  const want = Buffer.from(signBody(secret, body));
  const got = Buffer.from(header.trim());
  return want.length === got.length && timingSafeEqual(want, got);
}

// --- job options ----------------------------------------------------------------------------

export const LAYOUTS: Record<string, string> = {
  auto: 'Automatisch (KI wählt)',
  track: 'Gesicht verfolgen',
  general: 'Ganzes Bild (unscharfer Rand)',
  split: 'Zwei Sprecher übereinander',
  screencast: 'Bildschirm + Sprecher',
};
export const SUBTITLE_STYLES: Record<string, string> = {
  off: 'Keine',
  default: 'Standard',
  hormozi: 'Wort für Wort',
  pill: 'Lila Box',
  lime: 'Grüne Box',
  oneword: 'Ein großes Wort',
  clean: 'Dezent',
};
export const HOOK_STYLES: Record<string, string> = { pill: 'Weiße Box', classic: 'Klassisch', dark: 'Dunkel', yellow: 'Gelb', red: 'Rot', outline: 'Kontur', outline_yellow: 'Kontur gelb' };
export const FORMATS: Record<string, string> = { vertical: 'Hochkant 9:16', square: 'Quadratisch 1:1', horizontal: 'Quer 16:9' };
export const DEFAULT_LANGUAGES: Record<string, string> = { en: 'Englisch', de: 'Deutsch', es: 'Spanisch', fr: 'Französisch', it: 'Italienisch', pt: 'Portugiesisch', nl: 'Niederländisch', pl: 'Polnisch', tr: 'Türkisch' };

export interface JobOptions {
  clips: number | null;
  min_seconds: number | null;
  max_seconds: number | null;
  layout: string;
  subtitles: string;
  hook: boolean;
  hook_style: string;
  dub_language: string;
  format: string;
}

export function cleanOptions(raw: any = {}): JobOptions {
  const o = raw && typeof raw === 'object' ? raw : {};
  const int = (v: unknown, lo: number, hi: number, field: string) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) throw bad(`${field}: ${lo}–${hi}`);
    return Math.round(n);
  };
  const clips = int(o.clips, 1, 15, 'Anzahl Clips');
  const min = int(o.min_seconds, 5, 175, 'Mindestlänge (Sekunden)');
  const max = int(o.max_seconds, 10, 180, 'Höchstlänge (Sekunden)');
  if (min !== null && max !== null && max < min + 5) throw bad('Die Höchstlänge muss mindestens 5 Sekunden über der Mindestlänge liegen');
  const pick = (v: unknown, list: Record<string, string>, def: string, field: string) => {
    if (v === undefined || v === null || v === '') return def;
    if (!(String(v) in list)) throw bad(`${field}: ${Object.keys(list).join(', ')}`);
    return String(v);
  };
  const dub = String(o.dub_language ?? '').trim().toLowerCase();
  if (dub && !/^[a-z]{2,3}(-[a-z]{2,4})?$/.test(dub)) throw bad('Sprache für die Vertonung: Sprachcode wie de, en, es');
  return {
    clips,
    min_seconds: min,
    max_seconds: max,
    layout: pick(o.layout, LAYOUTS, 'auto', 'Layout'),
    subtitles: pick(o.subtitles, SUBTITLE_STYLES, 'default', 'Untertitel'),
    hook: o.hook === undefined ? true : o.hook === true || o.hook === 'true' || o.hook === 1 || o.hook === '1',
    hook_style: pick(o.hook_style, HOOK_STYLES, 'pill', 'Hook-Stil'),
    dub_language: dub,
    format: pick(o.format, FORMATS, 'vertical', 'Format'),
  };
}

/** Body of POST /api/process (JSON flavour of the endpoint). */
export function processBody(o: JobOptions, source: { url?: string; upload_id?: string }, hook?: { url: string; secret: string } | null, forceLow = false) {
  const layouts = o.layout === 'auto' ? ['auto'] : o.layout === 'split' ? ['split'] : o.layout === 'screencast' ? ['screencast'] : ['none'];
  const body: Record<string, unknown> = {
    ...(source.url ? { url: source.url } : { upload_id: source.upload_id }),
    acknowledged: true,
    layouts,
    output_format: o.format,
    // Dubbing first, captions afterwards (on the dubbed audio) – so none at render time then.
    captions: o.subtitles !== 'off' && !o.dub_language,
    auto_hook: o.hook,
  };
  if (o.hook) body.auto_hook_style = o.hook_style;
  if (o.clips !== null) body.target_clips = o.clips;
  if (o.min_seconds !== null) body.clip_min_seconds = o.min_seconds;
  if (o.max_seconds !== null) body.clip_max_seconds = o.max_seconds;
  if (hook) Object.assign(body, { webhook_url: hook.url, webhook_secret: hook.secret });
  if (forceLow) body.force_low_quality = true;
  return body;
}

export type ClipOp = { op: 'framing'; framing: 'full' | 'track' | 'auto' } | { op: 'dub'; language: string } | { op: 'subtitles'; preset: string };

/** Follow-up steps per clip after the render: framing → dubbing → captions. */
export function postOps(o: JobOptions, canDub: boolean): ClipOp[] {
  const ops: ClipOp[] = [];
  if (o.layout === 'general') ops.push({ op: 'framing', framing: 'full' });
  const dub = !!o.dub_language && canDub;
  if (dub) ops.push({ op: 'dub', language: o.dub_language });
  if (o.subtitles !== 'off' && (o.subtitles !== 'default' || !!o.dub_language)) ops.push({ op: 'subtitles', preset: o.subtitles });
  return ops;
}

// --- results ----------------------------------------------------------------------------------

export interface ParsedClip {
  index: number;
  path: string;
  start: number | null;
  end: number | null;
  duration: number | null;
  score: number | null;
  reason: string;
  hook: string;
  title: string;
  description: string;
  hashtags: string[];
}

const MEDIA_PATH = /^\/(videos|thumbnails)\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._ -]+)+\.(mp4|webm|mov|m4v|jpg|jpeg|png|webp)$/i;

/** Only `/videos/…` and `/thumbnails/…` on the configured instance are ever proxied. */
export function mediaPath(v: unknown): string | null {
  let s = String(v ?? '').trim();
  if (/^https?:\/\//i.test(s)) {
    try {
      s = new URL(s).pathname;
    } catch {
      return null;
    }
  }
  s = s.split('?')[0];
  try {
    s = decodeURIComponent(s);
  } catch {
    return null;
  }
  if (s.includes('..') || !MEDIA_PATH.test(s)) return null;
  return s;
}

/** The clip's index in OpenShorts' metadata (rendered lists skip failed clips; file names keep it). */
export function clipIndexOf(path: string, fallback: number): number {
  const m = /_clip_(\d+)/.exec(path);
  return m ? Number(m[1]) - 1 : fallback;
}

export function splitHashtags(text: string): { text: string; tags: string[] } {
  const tags = [...new Set((String(text ?? '').match(/#[\p{L}\p{N}_]+/gu) ?? []).map((t) => t.toLowerCase()))];
  const rest = String(text ?? '')
    .replace(/#[\p{L}\p{N}_]+/gu, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+\n/g, '\n')
    .trim();
  return { text: rest, tags };
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

export function parseClips(result: any): ParsedClip[] {
  const list: any[] = Array.isArray(result?.clips) ? result.clips : [];
  const out: ParsedClip[] = [];
  const seen = new Set<number>();
  list.forEach((c, i) => {
    const path = mediaPath(c?.video_url);
    if (!path) return;
    const index = clipIndexOf(path, i);
    if (seen.has(index)) return;
    seen.add(index);
    const start = num(c.start);
    const end = num(c.end);
    const tiktok = String(c.video_description_for_tiktok ?? '');
    const insta = String(c.video_description_for_instagram ?? '');
    const desc = splitHashtags(insta || tiktok);
    const tags = [...new Set([...desc.tags, ...splitHashtags(tiktok).tags])].slice(0, 15);
    const score = num(c.predicted_score ?? c.score ?? c.virality_score);
    out.push({
      index,
      path,
      start,
      end,
      duration: start !== null && end !== null && end > start ? Math.round((end - start) * 10) / 10 : null,
      score: score === null ? null : Math.max(0, Math.min(100, Math.round(score))),
      reason: String(c.why ?? c.reason ?? '').slice(0, 500),
      hook: String(c.viral_hook_text ?? '').slice(0, 200),
      title: String(c.video_title_for_youtube_short ?? c.title ?? `Clip ${index + 1}`).slice(0, 200),
      description: desc.text.slice(0, 2000),
      hashtags: tags,
    });
  });
  return out;
}

/** UGC result (AI Shorts) → one clip. */
export function parseUgcResult(result: any): ParsedClip | null {
  const path = mediaPath(result?.video_url);
  if (!path) return null;
  const s = result?.script ?? {};
  const cap = splitHashtags(String(s.caption ?? ''));
  const tags = [...new Set([...(Array.isArray(s.hashtags) ? s.hashtags.map((h: unknown) => `#${String(h).replace(/^#/, '')}`.toLowerCase()) : []), ...cap.tags])].slice(0, 15);
  const duration = num(result?.duration);
  return { index: 0, path, start: 0, end: duration, duration, score: null, reason: '', hook: String(s.hook_text ?? '').slice(0, 200), title: String(s.title ?? 'KI-Short').slice(0, 200), description: cap.text.slice(0, 2000), hashtags: tags };
}

/** Rough progress (0–100) and a German stage from OpenShorts' status, log lines and ready clips. */
export function progressOf(status: string, logs: unknown, ready: number, queue?: { position?: number; eta_seconds?: number } | null): { progress: number; stage: string } {
  if (status === 'completed') return { progress: 100, stage: 'Fertig' };
  if (status === 'failed') return { progress: 0, stage: 'Fehlgeschlagen' };
  if (status === 'queued') {
    const eta = queue?.eta_seconds ? `, ca. ${Math.max(1, Math.round(queue.eta_seconds / 60))} Min.` : '';
    return { progress: 2, stage: queue?.position ? `In der Warteschlange (Platz ${queue.position}${eta})` : 'In der Warteschlange' };
  }
  const lines = (Array.isArray(logs) ? logs : []).map(String);
  const text = lines.join('\n');
  const found = [...text.matchAll(/Found (\d+) clips/g)].pop();
  if (found) {
    const total = Number(found[1]) || 1;
    const done = Math.min(total, Math.max(ready, new Set([...text.matchAll(/Clip (\d+) ready/g)].map((m) => m[1])).size));
    return { progress: Math.min(97, 45 + Math.round((50 * done) / total)), stage: `Clips werden geschnitten (${done}/${total})` };
  }
  if (/Analyzing with|silent video|Analysing/i.test(text)) return { progress: 35, stage: 'KI sucht die besten Momente' };
  if (/Transcrib/i.test(text)) return { progress: 20, stage: 'Transkription' };
  if (/Download/i.test(text)) return { progress: 8, stage: 'Video wird geladen' };
  return { progress: 5, stage: 'Wird gestartet' };
}

/** Last meaningful error line of a failed job. */
export function errorFromLogs(logs: unknown, fallback = 'OpenShorts meldet einen Fehler'): string {
  const lines = (Array.isArray(logs) ? logs : []).map((l) => String(l).replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').trim()).filter(Boolean);
  const hit = [...lines].reverse().find((l) => /error|failed|fehler|❌|could not|no clips|not /i.test(l) && !/^Process failed with exit code/i.test(l)) ?? lines[lines.length - 1];
  return (hit || fallback).slice(0, 300);
}

/** Feature flags from the instance's OpenAPI paths (null = unknown → assume everything). */
export function featuresOf(paths: string[] | null) {
  const has = (p: string) => (paths ? paths.includes(p) : true);
  return {
    uploads: has('/api/uploads'),
    youtube_studio: has('/api/thumbnail/analyze') && has('/api/thumbnail/describe'),
    thumbnails: has('/api/thumbnail/generate'),
    ai_shorts: has('/api/saasshorts/generate'),
    translate: has('/api/translate'),
    subtitles: has('/api/subtitle'),
    rerender: has('/api/clip/rerender'),
  };
}
export type OsFeatures = ReturnType<typeof featuresOf>;

export const isYouTube = (url: string) => /^https?:\/\/([a-z0-9-]+\.)?(youtube\.com|youtu\.be)\//i.test(url);
