import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isIP } from 'node:net';
import type { App } from '../../core/app.js';
import { parseJson } from '../../core/db.js';
import { HttpError, bad, notFound } from '../../core/http.js';
import { id, now, sha256, slugify, token } from '../../core/util.js';
import { isPrivateIp } from '../net.js';
import { adapterFor, supports } from './index.js';
import { authFor, baseOf, checkUrl, ensureOk, gmFetch, hostIn } from './http.js';
import { ASPECTS, EXT, MAX_INPUT_BYTES, accepts, kindOf, maxBytesFor, sniff } from './media.js';
import {
  BYOK_MISSING,
  CAPABILITIES,
  CAPABILITY_LABEL,
  ProviderError,
  type AdapterCtx,
  type AiConnection,
  type AiConnectionsService,
  type Capability,
  type ConnectionSummary,
  type Cost,
  type GenInput,
  type HttpTemplate,
  type Output,
  type Ref,
  type Step,
  type WebhookIn,
} from './types.js';

/**
 * Job engine of the KI-Studio: a job is created by a request (studio, builders, workflow, MCP,
 * app), submitted right away in the background, then polled by `app.onTick` (or woken by the
 * provider's callback) until it is done. Results are downloaded (SSRF-guarded, size- and
 * type-checked) into HyperLevel's own storage, so provider URLs may expire; "In Mediathek" copies a
 * result into the media library (uploads). The key is looked up again on every step – revoking
 * a connection stops its jobs.
 */

export const TERMINAL = ['succeeded', 'failed', 'canceled'];
const MAX_ACTIVE_PER_LOCATION = 10;
const MAX_ATTEMPTS = 5;
const SOURCES = ['studio', 'builder', 'workflow', 'mcp', 'mobile', 'api'];

export const genDir = (app: App) => join(app.config.dataDir, 'genmedia');
const uploadsDir = (app: App) => join(app.config.dataDir, 'uploads');

export function fileUrl(app: App, file: string, download = false) {
  return `${app.baseUrl()}/genmedia/f/${file}${download ? '?download=1' : ''}`;
}

/** Whether providers can reach our callback URL (https on a public host). */
export function publicBase(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^\[|\]$/g, '');
    if (u.protocol !== 'https:' || h === 'localhost' || !h.includes('.') || /\.(local|internal|localhost|lan|home)$/i.test(h)) return false;
    return !(isIP(h) && isPrivateIp(h));
  } catch {
    return false;
  }
}

// --- BYOK registry --------------------------------------------------------------------------------

export function registry(app: App): AiConnectionsService | null {
  const s = app.services.aiConnections;
  return s && typeof s.resolve === 'function' ? (s as AiConnectionsService) : null;
}

export async function resolveConnection(app: App, locationId: string, cap: Capability, connectionId?: string | null): Promise<AiConnection> {
  const reg = registry(app);
  if (!reg) throw new HttpError(409, BYOK_MISSING);
  const conn = await reg.resolve(locationId, cap, connectionId || undefined);
  if (!conn) throw new HttpError(409, connectionId ? 'Diese KI-Verbindung gibt es nicht (mehr) oder sie kann das nicht – bitte unter Einstellungen → KI-Anbieter (BYOK) prüfen' : BYOK_MISSING);
  if (!conn.apiKey && conn.provider !== 'custom_http') throw new HttpError(409, 'Für diese KI-Verbindung ist kein Schlüssel hinterlegt');
  return conn;
}

/** Connections of the sub-account that can do `cap` (lenient about the registry's list shape). */
export async function listConnections(app: App, locationId: string, cap?: Capability): Promise<(ConnectionSummary & { capabilities: Capability[] })[]> {
  const reg = registry(app);
  if (!reg || typeof reg.list !== 'function') return [];
  const raw = ((await reg.list(locationId)) ?? []) as any[];
  return raw
    .map((c) => {
      const provider = String(c?.provider ?? '');
      const adapter = adapterFor(provider);
      const declared = Array.isArray(c?.capabilities) ? (c.capabilities as string[]).filter((x): x is Capability => (CAPABILITIES as string[]).includes(x)) : [];
      const caps = (declared.length ? declared : adapter.capabilities).filter((x) => supports(adapter, x));
      return { id: String(c?.id ?? c?.connectionId ?? ''), provider, label: String(c?.label ?? c?.name ?? adapter.label), model: c?.model ? String(c.model) : undefined, capabilities: caps };
    })
    .filter((c) => c.id && (!cap || c.capabilities.includes(cap)));
}

// --- input ------------------------------------------------------------------------------------------

const txt = (v: unknown, field: string, max: number) => {
  if (v === undefined || v === null) return '';
  const s = String(v).trim();
  if (s.length > max) throw bad(`${field} ist zu lang (max. ${max} Zeichen)`);
  return s;
};

function cleanParams(v: unknown): Record<string, any> | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  let o: any = v;
  if (typeof v === 'string') {
    try {
      o = JSON.parse(v);
    } catch {
      throw bad('Erweiterte Parameter: kein gültiges JSON');
    }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw bad('Erweiterte Parameter: bitte ein JSON-Objekt { … }');
  const s = JSON.stringify(o);
  if (s.length > 20_000) throw bad('Erweiterte Parameter: zu groß (max. 20 KB)');
  return JSON.parse(s, (k, val) => (k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : val));
}

/** A reference file from an upload, an earlier result or an https URL. */
function refOf(app: App, locationId: string, b: Record<string, any>, kind: 'image' | 'audio' | 'video'): Ref | undefined {
  const uploadId = b[`${kind}_upload_id`];
  const fileId = b[`${kind}_file`];
  const url = b[`${kind}_url`];
  if (uploadId) {
    const row = app.db.get('SELECT * FROM uploads WHERE id = ? AND location_id = ?', String(uploadId), locationId);
    if (!row) throw bad('Datei aus der Mediathek nicht gefunden');
    return { url: `${app.baseUrl()}/uploads/${row.file}`, mime: row.mime, name: row.name, local: { dir: 'uploads', file: row.file } };
  }
  if (fileId) {
    const row = app.db.get('SELECT * FROM genmedia_files WHERE file = ? AND location_id = ?', String(fileId), locationId);
    if (!row) throw bad('Datei nicht gefunden');
    return { url: fileUrl(app, row.file), mime: row.mime, name: row.name, local: { dir: 'genmedia', file: row.file } };
  }
  if (url) {
    const s = txt(url, 'Datei-Link', 2000);
    // Links to our own files are read locally (when they belong to this sub-account).
    const own = new RegExp(`^${app.baseUrl().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(uploads|genmedia/f)/([\\w.-]+)$`).exec(s);
    if (own) {
      const row = own[1] === 'uploads' ? app.db.get('SELECT * FROM uploads WHERE file = ? AND location_id = ?', own[2], locationId) : app.db.get('SELECT * FROM genmedia_files WHERE file = ? AND location_id = ?', own[2], locationId);
      if (row) return { url: s, mime: row.mime, name: row.name, local: { dir: own[1] === 'uploads' ? 'uploads' : 'genmedia', file: row.file } };
    }
    try {
      const u = checkUrl(s);
      if (u.protocol !== 'https:') throw new ProviderError('nur https');
    } catch {
      throw bad('Datei-Link: bitte eine öffentliche https://-Adresse angeben');
    }
    return { url: s };
  }
  return undefined;
}

export interface CreateIn {
  locationId: string;
  userId?: string | null;
  body: Record<string, any>;
  /** Internal callers only (workflow): where the result goes. */
  target?: Record<string, any> | null;
  source?: string;
}

function timeoutFor(cap: Capability): number {
  const env = Number(process.env.PGHL_GENMEDIA_TIMEOUT_MIN);
  const min = Number.isFinite(env) && env > 0 ? env : cap === 'video' ? 45 : cap === 'stt' ? 20 : 15;
  return min * 60_000;
}

/** Validates a request and stores the job (submitted in the background). */
export async function createJob(app: App, inp: CreateIn) {
  const { db } = app;
  const b = inp.body ?? {};
  const cap = String(b.capability ?? '') as Capability;
  if (!CAPABILITIES.includes(cap)) throw bad(`Art fehlt oder unbekannt (${CAPABILITIES.join(', ')})`);
  const connectionId = txt(b.connection_id, 'Verbindung', 120) || null;
  const conn = await resolveConnection(app, inp.locationId, cap, connectionId);
  const adapter = adapterFor(conn.provider);
  if (!supports(adapter, cap)) throw bad(`${adapter.label} kann „${CAPABILITY_LABEL[cap]}“ nicht – bitte eine andere Verbindung wählen`);
  const model = txt(b.model, 'Modell', 200) || conn.model || adapter.models[cap]?.[0]?.id || '';
  if (model && !/^[\w./:@+-]+$/.test(model)) throw bad('Modell-ID: nur Buchstaben, Ziffern und . / : @ + - _');

  const prompt = txt(b.prompt ?? b.text, cap === 'audio_tts' ? 'Text' : 'Prompt', cap === 'audio_tts' ? 10_000 : 8000);
  if (!prompt && cap !== 'stt' && !b.kie_task) throw bad(cap === 'audio_tts' ? 'Text fehlt' : 'Prompt fehlt');
  const input: GenInput = { prompt };
  const neg = txt(b.negative_prompt, 'Negativ-Prompt', 2000);
  if (neg) input.negative_prompt = neg;
  const aspect = txt(b.aspect_ratio, 'Seitenverhältnis', 10);
  if (aspect) {
    if (!ASPECTS.includes(aspect)) throw bad(`Seitenverhältnis: ${ASPECTS.join(', ')}`);
    input.aspect_ratio = aspect;
  }
  if (b.duration !== undefined && b.duration !== null && b.duration !== '') {
    const d = Number(b.duration);
    const max = cap === 'audio_music' ? 600 : cap === 'video' ? 60 : 600;
    if (!Number.isFinite(d) || d <= 0 || d > max) throw bad(`Dauer: 1 bis ${max} Sekunden`);
    input.duration = Math.round(d);
  }
  if (b.seed !== undefined && b.seed !== null && b.seed !== '') {
    const s = Number(b.seed);
    if (!Number.isInteger(s) || s < 0 || s > 4_294_967_295) throw bad('Seed: ganze Zahl ab 0');
    input.seed = s;
  }
  const voice = txt(b.voice, 'Stimme', 120);
  if (voice) {
    if (!/^[\w .:'()-]+$/.test(voice)) throw bad('Stimme ungültig');
    input.voice = voice;
  }
  const lang = txt(b.language, 'Sprache', 12);
  if (lang) input.language = lang;
  const params = cleanParams(b.params);
  if (params) input.params = params;

  // Reference media (upload, earlier result or link); an earlier job's result works too.
  if (b.ref_job_id) {
    const ref = db.get('SELECT results FROM genmedia_jobs WHERE id = ? AND location_id = ?', String(b.ref_job_id), inp.locationId);
    const r = ref ? (JSON.parse(ref.results || '[]') as any[])[Number(b.ref_index ?? 0)] : null;
    if (!r) throw bad('Referenz-Ergebnis nicht gefunden');
    const k = kindOf(r.mime);
    const ref2: Ref = { url: fileUrl(app, r.file), mime: r.mime, name: r.name, local: { dir: 'genmedia', file: r.file } };
    if (k === 'image') input.image = ref2;
    else if (k === 'audio') input.audio = ref2;
    else if (k === 'video') (cap === 'stt' ? (input.audio = ref2) : (input.video = ref2));
  }
  input.image = refOf(app, inp.locationId, b, 'image') ?? input.image;
  input.audio = refOf(app, inp.locationId, b, 'audio') ?? input.audio;
  input.video = refOf(app, inp.locationId, b, 'video') ?? input.video;
  if (cap === 'stt' && !input.audio && input.video) input.audio = input.video;
  if (cap === 'stt' && !input.audio) throw bad('Bitte eine Audio- oder Videodatei angeben');

  if (b.kie_task) {
    if (adapter.id !== 'kie') throw bad('„Kie-Task“ geht nur mit einer kie.ai-Verbindung');
    const t = typeof b.kie_task === 'string' ? cleanParams(b.kie_task) : b.kie_task;
    const endpoint = txt(t?.endpoint, 'Kie-Endpunkt', 200);
    if (!/^\/api\/[\w./-]+$/.test(endpoint) || endpoint.includes('..')) throw bad('Kie-Endpunkt: Pfad wie /api/v1/veo/generate angeben');
    const body = cleanParams(t?.body) ?? {};
    const poll = txt(t?.poll_path, 'Abfrage-Pfad', 200);
    if (poll && (!/^\/api\/[\w./-]+$/.test(poll) || poll.includes('..'))) throw bad('Abfrage-Pfad: Pfad wie /api/v1/veo/record-info angeben');
    input.kie_task = { endpoint, body, ...(poll ? { poll_path: poll } : {}) };
  }
  if (adapter.id === 'custom_http' && !conn.options?.template) {
    const tid = txt(b.template_id, 'Vorlage', 60);
    const tpl = tid ? db.get('SELECT id FROM genmedia_templates WHERE id = ? AND location_id = ?', tid, inp.locationId) : db.get('SELECT id FROM genmedia_templates WHERE location_id = ? AND capability = ? ORDER BY updated_at DESC LIMIT 1', inp.locationId, cap);
    if (!tpl) throw bad('Für den eigenen Anbieter bitte zuerst eine HTTP-Vorlage anlegen (KI-Studio → Eigene Anbieter)');
    input.template_id = tpl.id;
  }

  const active = Number(db.get(`SELECT COUNT(*) n FROM genmedia_jobs WHERE location_id = ? AND status IN ('queued','running')`, inp.locationId)?.n ?? 0);
  if (active >= MAX_ACTIVE_PER_LOCATION) throw new HttpError(429, `Höchstens ${MAX_ACTIVE_PER_LOCATION} laufende Aufträge je Sub-Account – bitte warten, bis einer fertig ist`);

  const source = SOURCES.includes(String(inp.source ?? b.source)) ? String(inp.source ?? b.source) : 'studio';
  const parent = b.parent_id ? db.get('SELECT id FROM genmedia_jobs WHERE id = ? AND location_id = ?', String(b.parent_id), inp.locationId) : null;
  const t = now();
  const row = {
    id: id(),
    location_id: inp.locationId,
    user_id: inp.userId ?? null,
    connection_id: conn.connectionId,
    provider: adapter.id === 'custom_http' && conn.provider !== 'custom_http' ? conn.provider : adapter.id,
    model,
    capability: cap,
    input,
    status: 'queued',
    provider_state: {},
    results: [],
    error: '',
    attempts: 0,
    polls: 0,
    next_run_at: t,
    timeout_at: new Date(Date.now() + timeoutFor(cap)).toISOString(),
    source,
    target: inp.target ?? null,
    target_result: '',
    library: b.library || inp.target ? 1 : 0,
    parent_id: parent?.id ?? null,
    created_at: t,
    updated_at: t,
  };
  db.insert('genmedia_jobs', row);
  return getJob(app, row.id)!;
}

// --- rows -------------------------------------------------------------------------------------------

export function getJob(app: App, jobId: string) {
  return parseJson(app.db.get('SELECT * FROM genmedia_jobs WHERE id = ?', jobId), ['input', 'provider_state', 'results', 'cost', 'target']) as any;
}

/** What the API shows (no provider state, no callback hash). */
export function jobOut(app: App, j: any) {
  const input: GenInput = j.input ?? { prompt: '' };
  const results = (j.results ?? []).map((r: any) => ({
    url: fileUrl(app, r.file),
    download_url: fileUrl(app, r.file, true),
    mime: r.mime,
    kind: kindOf(r.mime),
    size: r.size,
    name: r.name,
    upload_id: r.upload_id ?? null,
    library_url: r.upload_file ? `${app.baseUrl()}/uploads/${r.upload_file}` : null,
  }));
  return {
    id: j.id,
    location_id: j.location_id,
    capability: j.capability,
    capability_label: CAPABILITY_LABEL[j.capability as Capability] ?? j.capability,
    provider: j.provider,
    provider_label: adapterFor(j.provider).label,
    model: j.model,
    connection_id: j.connection_id,
    status: j.status,
    progress: j.progress ?? null,
    prompt: input.prompt,
    input: {
      prompt: input.prompt,
      negative_prompt: input.negative_prompt ?? '',
      aspect_ratio: input.aspect_ratio ?? '',
      duration: input.duration ?? null,
      seed: input.seed ?? null,
      voice: input.voice ?? '',
      language: input.language ?? '',
      params: input.params ?? null,
      image_url: input.image?.url ?? null,
      audio_url: input.audio?.url ?? null,
      kie_task: input.kie_task ?? null,
      template_id: input.template_id ?? null,
    },
    results,
    url: results[0]?.library_url ?? results[0]?.url ?? null,
    text: j.result_text ?? null,
    cost: j.cost ?? null,
    error: j.error || null,
    source: j.source,
    parent_id: j.parent_id ?? null,
    target_result: j.target_result || null,
    created_at: j.created_at,
    updated_at: j.updated_at,
    finished_at: j.finished_at ?? null,
  };
}

function setJob(app: App, jobId: string, patch: Record<string, any>) {
  app.db.update('genmedia_jobs', jobId, { ...patch, updated_at: now() });
}

// --- processing ---------------------------------------------------------------------------------------

const inflight = new Set<Promise<void>>();

/** Process a job soon (after the response went out). */
export function kick(app: App, jobId: string) {
  const p: Promise<void> = new Promise<void>((r) => setImmediate(r))
    .then(() => processJob(app, jobId))
    .catch((e) => console.error('[genmedia]', (e as Error).message))
    .finally(() => inflight.delete(p));
  inflight.add(p);
}

/** Waits until background work started by `kick` is done (tests, shutdown). */
export async function idle() {
  while (inflight.size) await Promise.all([...inflight]);
}

function templateOf(app: App, job: any, conn: AiConnection): HttpTemplate | null {
  if (conn.options?.template && typeof conn.options.template === 'object') return conn.options.template as HttpTemplate;
  const tid = job.input?.template_id;
  if (!tid) return null;
  const row = app.db.get('SELECT config FROM genmedia_templates WHERE id = ? AND location_id = ?', tid, job.location_id);
  return row ? (JSON.parse(row.config) as HttpTemplate) : null;
}

function localPath(app: App, ref: Ref): string | null {
  if (!ref.local) return null;
  const dir = ref.local.dir === 'uploads' ? uploadsDir(app) : genDir(app);
  if (!/^[\w.-]+$/.test(ref.local.file)) return null;
  return join(dir, ref.local.file);
}

export function adapterCtx(app: App, job: any, conn: AiConnection, callbackUrl: string | null): AdapterCtx {
  return {
    conn,
    model: job.model,
    capability: job.capability,
    input: job.input,
    callbackUrl,
    fetch: (url, init) => gmFetch(app, url, conn.options?.allow_private ? { ...init, allowPrivate: true } : init),
    async bytes(ref, maxBytes = MAX_INPUT_BYTES) {
      const p = localPath(app, ref);
      let data: Buffer;
      if (p) {
        if (!existsSync(p)) throw new ProviderError('Referenzdatei fehlt auf dem Server');
        if (statSync(p).size > maxBytes) throw new ProviderError(`Referenzdatei größer als ${Math.round(maxBytes / 1024 / 1024)} MB`);
        data = readFileSync(p);
      } else {
        const r = ensureOk(await gmFetch(app, ref.url, { maxBytes, timeoutMs: 120_000 }), 'Referenzdatei');
        data = r.body;
      }
      const mime = sniff(data, ref.mime ?? '');
      if (!mime) throw new ProviderError('Referenzdatei ist keine Bild-, Audio- oder Videodatei');
      return { data, mime };
    },
    template: adapterFor(conn.provider).id === 'custom_http' ? templateOf(app, job, conn) : null,
  };
}

type Phase = 'submit' | 'poll' | 'apply';

/** Claims, submits or polls one job. Safe to call concurrently (lease). */
export async function processJob(app: App, jobId: string): Promise<void> {
  const { db } = app;
  const claimed = db.run(`UPDATE genmedia_jobs SET lease_until = ? WHERE id = ? AND status IN ('queued','running') AND (lease_until IS NULL OR lease_until < ?)`, new Date(Date.now() + 10 * 60_000).toISOString(), jobId, now()).changes;
  if (!claimed) return;
  const job = getJob(app, jobId);
  let phase: Phase = job.status === 'queued' ? 'submit' : 'poll';
  try {
    if (Date.parse(job.timeout_at) < Date.now()) return void (await finishFailed(app, job, 'Zeitüberschreitung – der Anbieter hat nicht rechtzeitig geliefert'));
    const conn = await resolveConnection(app, job.location_id, job.capability, job.connection_id);
    const adapter = adapterFor(conn.provider);
    let callbackUrl: string | null = null;
    if (job.status === 'queued' && publicBase(app.baseUrl()) && (adapter.webhook || adapter.id === 'luma')) {
      const tok = token(24);
      setJob(app, job.id, { callback_hash: sha256(tok) });
      callbackUrl = `${app.baseUrl()}/hooks/genmedia/${tok}`;
    }
    const ctx = adapterCtx(app, job, conn, callbackUrl);
    let step: Step;
    if (job.provider_state?.pending_outputs) {
      // The provider already delivered; only the download/storage is left (never submit twice).
      const s = job.provider_state;
      phase = 'apply';
      step = { status: 'done', outputs: s.pending_outputs, text: s.pending_text ?? undefined, cost: s.pending_cost ?? undefined };
    } else if (job.status === 'queued') {
      setJob(app, job.id, { status: 'running' });
      step = await adapter.submit(ctx);
    } else {
      if (!adapter.poll) throw new ProviderError('Dieser Anbieter kann keinen Zwischenstand abfragen');
      step = await adapter.poll(ctx, job.provider_state ?? {});
    }
    phase = 'apply';
    await applyStep(app, job, step, conn);
  } catch (e) {
    await handleError(app, job, e, phase);
  } finally {
    db.run('UPDATE genmedia_jobs SET lease_until = NULL WHERE id = ?', jobId);
  }
}

/**
 * Retries with backoff: polls and downloads on any transient error; a submit only when the
 * provider itself answered 429/5xx (a timeout might have created the job already – no double charges).
 */
/** A job canceled (or finished) while a step was in flight stays as it is. */
const stillActive = (app: App, jobId: string) => ['queued', 'running'].includes(app.db.get('SELECT status FROM genmedia_jobs WHERE id = ?', jobId)?.status);

async function handleError(app: App, job: any, e: unknown, phase: Phase) {
  if (!stillActive(app, job.id)) return;
  const err = e as Error;
  const pe = e instanceof ProviderError ? e : null;
  const attempts = Number(job.attempts ?? 0) + 1;
  const transient = pe ? pe.retryable : !(e instanceof HttpError);
  const retry = attempts < MAX_ATTEMPTS && transient && (phase !== 'submit' || (!!pe && (pe.status === 429 || pe.status >= 500)));
  if (retry) {
    const wait = Math.min(300_000, 5000 * 2 ** attempts);
    setJob(app, job.id, { attempts, error: `Versuch ${attempts}: ${err.message}`.slice(0, 500), next_run_at: new Date(Date.now() + wait).toISOString(), ...(phase === 'submit' ? { status: 'queued' } : {}) });
    return;
  }
  await finishFailed(app, job, err.message || 'Unbekannter Fehler');
}

async function applyStep(app: App, job: any, step: Step, conn: AiConnection) {
  if (!stillActive(app, job.id)) return;
  if (step.status === 'pending') {
    const wait = Math.max(1500, Math.min(120_000, step.pollAfterMs ?? 5000));
    setJob(app, job.id, { status: 'running', provider_state: step.state ?? {}, progress: step.progress ?? null, attempts: 0, error: '', polls: Number(job.polls ?? 0) + 1, next_run_at: new Date(Date.now() + wait).toISOString() });
    return;
  }
  if (step.status === 'failed') return void (await finishFailed(app, job, step.error));
  let results: any[];
  try {
    results = step.outputs.length ? await storeOutputs(app, job, step.outputs, conn) : [];
  } catch (e) {
    if (e instanceof ProviderError && e.retryable) {
      // Keep what the provider delivered (URLs only – bytes were written or failed for good).
      const urls = step.outputs.filter((o): o is { url: string; mime?: string; auth?: boolean } => 'url' in o);
      setJob(app, job.id, { status: 'running', provider_state: { ...(job.provider_state ?? {}), pending_outputs: urls, pending_text: step.text ?? null, pending_cost: step.cost ?? null } });
    }
    throw e;
  }
  if (job.capability === 'stt' ? typeof step.text !== 'string' : !results.length) throw new ProviderError(job.capability === 'stt' ? 'Kein Text erhalten' : 'Ergebnis hat ein unerwartetes Format');
  setJob(app, job.id, { status: 'succeeded', results, result_text: step.text ?? null, cost: step.cost ?? null, error: '', progress: 100, finished_at: now(), next_run_at: null, provider_state: {} });
  const done = getJob(app, job.id);
  if (done.library) addToLibrary(app, done);
  await applyTarget(app, getJob(app, job.id));
  const out = jobOut(app, getJob(app, job.id));
  app.events.emit(job.location_id, 'genmedia.completed', { contactId: job.target?.contactId, jobId: job.id, capability: job.capability, model: job.model, provider: job.provider, url: out.url, urls: out.results.map((r: any) => r.library_url ?? r.url), text: out.text });
}

async function finishFailed(app: App, job: any, error: string) {
  setJob(app, job.id, { status: 'failed', error: String(error).slice(0, 1000), finished_at: now(), next_run_at: null });
  if (job.target?.type) setJob(app, job.id, { target_result: `Nicht ausgeführt: ${String(error).slice(0, 300)}` });
  app.events.emit(job.location_id, 'genmedia.failed', { contactId: job.target?.contactId, jobId: job.id, capability: job.capability, error: String(error).slice(0, 300) });
}

/** Downloads/writes every output, checks type and size, keeps it under data/genmedia. */
async function storeOutputs(app: App, job: any, outputs: Output[], conn: AiConnection) {
  const adapter = adapterFor(conn.provider);
  const base = baseOf(conn, adapter.defaultBase || 'https://invalid.local');
  let apiHost = '';
  try {
    apiHost = new URL(base).hostname;
  } catch {
    /* custom without base */
  }
  const trusted = [apiHost, ...(adapter.trustedHosts?.(base) ?? [])].filter(Boolean);
  const max = maxBytesFor(job.capability);
  const dir = genDir(app);
  mkdirSync(dir, { recursive: true });
  const stored: any[] = [];
  let rejected = '';
  for (const o of outputs.slice(0, 8)) {
    let data: Buffer;
    let hint = o.mime ?? '';
    if ('data' in o) data = o.data;
    else {
      const host = checkUrl(o.url).hostname;
      const headers = o.auth && hostIn(host, trusted) ? authFor(conn, adapter.defaultAuth).headers : {};
      const r = await gmFetch(app, o.url, { headers, maxBytes: max, timeoutMs: 300_000 });
      ensureOk(r, 'Download des Ergebnisses');
      data = r.body;
      hint ||= r.headers['content-type'] ?? '';
    }
    if (data.length > max) {
      rejected = `Ergebnis größer als ${Math.round(max / 1024 / 1024)} MB`;
      continue;
    }
    const mime = sniff(data, hint);
    if (!mime || !accepts(job.capability, mime)) {
      rejected = 'Ergebnis hat ein unerwartetes Format';
      continue;
    }
    const file = `${id(24)}${EXT[mime] ?? '.bin'}`;
    writeFileSync(join(dir, file), data);
    const name = `ki-${slugify(job.input?.prompt || CAPABILITY_LABEL[job.capability as Capability]).slice(0, 40)}${stored.length ? `-${stored.length + 1}` : ''}${EXT[mime] ?? ''}`;
    app.db.insert('genmedia_files', { file, location_id: job.location_id, job_id: job.id, kind: 'output', name, mime, size: data.length, created_at: now() });
    stored.push({ file, mime, size: data.length, name });
  }
  if (!stored.length && rejected) throw new ProviderError(rejected);
  return stored;
}

/** Copies results into the media library (uploads); idempotent. */
export function addToLibrary(app: App, job: any, index?: number) {
  const results: any[] = job.results ?? [];
  const out: any[] = [];
  mkdirSync(uploadsDir(app), { recursive: true });
  results.forEach((r, i) => {
    if (index !== undefined && i !== index) return;
    if (!r.upload_id) {
      const src = join(genDir(app), r.file);
      if (!existsSync(src)) return;
      const file = `${id(20)}${EXT[r.mime] ?? ''}`;
      copyFileSync(src, join(uploadsDir(app), file));
      const up = { id: id(), location_id: job.location_id, name: r.name || file, file, mime: r.mime, size: r.size, created_at: now() };
      app.db.insert('uploads', up);
      r.upload_id = up.id;
      r.upload_file = file;
    }
    out.push({ id: r.upload_id, name: r.name, mime: r.mime, size: r.size, file: r.upload_file, url: `${app.baseUrl()}/uploads/${r.upload_file}` });
  });
  app.db.update('genmedia_jobs', job.id, { results, updated_at: now() });
  return out;
}

/** Workflow targets: custom field, note on the contact, social post draft. */
async function applyTarget(app: App, job: any) {
  const t = job.target;
  if (!t?.type) return;
  const { db } = app;
  const out = jobOut(app, job);
  const value = job.capability === 'stt' ? String(job.result_text ?? '') : String(out.url ?? '');
  let result = '';
  try {
    if (t.type === 'field' && t.contactId) {
      const field = String(t.field ?? '');
      if (!field.startsWith('custom.') || field.length < 8) throw new Error('Nur eigene Felder (custom.…) können ein Ergebnis aufnehmen');
      const c = db.get('SELECT custom FROM contacts WHERE id = ? AND location_id = ?', t.contactId, job.location_id);
      if (!c) throw new Error('Kontakt nicht gefunden');
      const custom = c.custom ? JSON.parse(c.custom) : {};
      db.run('UPDATE contacts SET custom = ?, updated_at = ? WHERE id = ?', JSON.stringify({ ...custom, [field.slice(7)]: value.slice(0, 5000) }), now(), t.contactId);
      result = `${field} = ${value.slice(0, 80)}`;
    } else if (t.type === 'note' && t.contactId) {
      if (!db.get('SELECT id FROM contacts WHERE id = ? AND location_id = ?', t.contactId, job.location_id)) throw new Error('Kontakt nicht gefunden');
      const label = CAPABILITY_LABEL[job.capability as Capability];
      const links = out.results.map((r: any) => r.library_url ?? r.url).join('\n');
      const body = job.capability === 'stt' ? `Transkript (KI):\n${value}` : `${label} (KI, ${job.model || job.provider}): ${String(job.input?.prompt ?? '').slice(0, 200)}\n${links}`;
      db.insert('notes', { id: id(), location_id: job.location_id, contact_id: t.contactId, body: body.slice(0, 10_000), user_id: null, created_at: now() });
      result = 'Notiz mit Anhang angelegt';
    } else if (t.type === 'social_draft') {
      if (!app.services.socialPost) throw new Error('Social Planner ist nicht verfügbar');
      const video = job.capability === 'video';
      const uploadIds = video ? [] : out.results.filter((r: any) => r.kind === 'image' && r.upload_id).map((r: any) => r.upload_id);
      const post = await app.services.socialPost(job.location_id, {
        integrationIds: Array.isArray(t.integrationIds) ? t.integrationIds : [],
        content: String(t.content || job.input?.prompt || '').slice(0, 3000),
        type: 'draft',
        uploadIds,
        ...(video ? { mediaUrls: out.results.filter((r: any) => r.kind === 'video').map((r: any) => r.library_url ?? r.url), video: true } : {}),
        source: 'KI-Studio',
      });
      result = `Social-Entwurf angelegt (${post?.id ?? 'ok'})`;
    }
  } catch (e) {
    result = `Fehler: ${(e as Error).message}`.slice(0, 300);
  }
  if (result) setJob(app, job.id, { target_result: result });
}

/** The jobs due for a poll (or a first submit, or a retry). */
export async function pollDue(app: App, limit = 20) {
  const due = app.db.all(`SELECT id FROM genmedia_jobs WHERE status IN ('queued','running') AND (next_run_at IS NULL OR next_run_at <= ?) AND (lease_until IS NULL OR lease_until < ?) ORDER BY next_run_at LIMIT ?`, now(), now(), limit);
  for (const r of due) await processJob(app, r.id);
}

/** A provider called the per-job callback URL. */
export async function handleCallback(app: App, tok: string, req: WebhookIn): Promise<{ ok: true }> {
  if (!/^[\w-]{20,64}$/.test(tok)) throw notFound();
  const job = getJob(app, app.db.get('SELECT id FROM genmedia_jobs WHERE callback_hash = ?', sha256(tok))?.id ?? '');
  if (!job) throw notFound();
  if (TERMINAL.includes(job.status)) return { ok: true };
  let step: Step | null = null;
  try {
    const conn = await resolveConnection(app, job.location_id, job.capability, job.connection_id);
    const adapter = adapterFor(conn.provider);
    if (adapter.webhook) step = await adapter.webhook(adapterCtx(app, job, conn, null), job.provider_state ?? {}, req);
    if (step && step.status !== 'pending') {
      const claimed = app.db.run(`UPDATE genmedia_jobs SET lease_until = ? WHERE id = ? AND status IN ('queued','running') AND (lease_until IS NULL OR lease_until < ?)`, new Date(Date.now() + 10 * 60_000).toISOString(), job.id, now()).changes;
      if (claimed) {
        try {
          await applyStep(app, job, step, conn);
        } catch (e) {
          await handleError(app, job, e, 'apply');
        } finally {
          app.db.run('UPDATE genmedia_jobs SET lease_until = NULL WHERE id = ?', job.id);
        }
        return { ok: true };
      }
    }
  } catch (e) {
    if (e instanceof ProviderError && e.status === 401) throw new HttpError(401, e.message);
    if (e instanceof HttpError) return { ok: true };
  }
  // Not verifiable (or busy): ask the provider ourselves, right now.
  setJob(app, job.id, { next_run_at: now(), webhook_at: now() });
  kick(app, job.id);
  return { ok: true };
}

/** Deletes a job and its own files (copies in the media library stay). */
export function deleteJob(app: App, job: any) {
  for (const f of app.db.all('SELECT file FROM genmedia_files WHERE job_id = ?', job.id)) {
    rmSync(join(genDir(app), f.file), { force: true });
  }
  app.db.run('DELETE FROM genmedia_files WHERE job_id = ?', job.id);
  app.db.run('DELETE FROM genmedia_jobs WHERE id = ?', job.id);
}

export const costText = (c: Cost | null | undefined) => (c ? [c.amount !== undefined ? `${c.estimated ? '≈ ' : ''}${c.amount} ${c.unit ?? ''}`.trim() : '', c.note ?? ''].filter(Boolean).join(' · ') : '');
