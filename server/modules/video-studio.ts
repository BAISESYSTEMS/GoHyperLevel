import { appendFileSync, createReadStream, existsSync, mkdirSync, openAsBlob, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Ctx, type RawResult } from '../core/http.js';
import { parseJson } from '../core/db.js';
import { render } from '../core/template.js';
import { id, now, sha256, token } from '../core/util.js';
import { isPrivateIp } from '../services/net.js';
import type { ReportSource } from '../services/report-engine.js';
import { contactJoin } from '../services/report-sources.js';
import * as os from '../services/openshorts.js';
import type { CatalogExtra } from './integrations-catalog.js';
import { openSecret, sealSecret } from './mail-sync.js';
import type { Tool } from './mcp.js';

/**
 * Video-Studio: long video → AI-picked 9:16 shorts (OpenShorts) → review → Social Planner.
 * OpenShorts runs as its own service (self-hosted next to HyperLevel, or the hosted API); this module
 * only talks to its REST API: jobs per sub-account from a link or an upload (chunked into HyperLevel,
 * then streamed to OpenShorts' upload slot), a signed webhook per job plus polling in onTick, clips
 * proxied from OpenShorts (nothing big lands in the database), follow-up steps (captions style,
 * dubbing, framing), scheduling through the social module, workflow trigger/action, MCP tools and
 * report sources. Agency setup: Agentur → Integrationen → Einrichtung.
 */

const SETTINGS_KEY = 'openshorts';
const CHUNK = 8 * 1024 * 1024;
const DEFAULT_MAX_MB = 2048; // OpenShorts' own limit
const VIDEO_EXT = ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi'];
const ACTIVE = ['uploading', 'submitting', 'queued', 'processing', 'finishing'];
const TERMINAL = ['completed', 'failed'];
const POLL_MS = { normal: 20_000, withHook: 60_000 };
const MEDIA_TTL_S = 2 * 3600;
const SOURCE_TTL_S = 24 * 3600;

export const JOB_STATUS: Record<string, string> = {
  uploading: 'Wird übertragen',
  submitting: 'Wird gestartet',
  confirm: 'Rückfrage',
  queued: 'In der Warteschlange',
  processing: 'In Arbeit',
  finishing: 'Nachbearbeitung',
  completed: 'Fertig',
  failed: 'Fehlgeschlagen',
};

interface Info {
  mode: 'hosted' | 'selfhosted';
  features: os.OsFeatures;
  youtube_urls: boolean;
  local_llm: string | null;
  retention_hours: number | null;
  plan?: string | null;
  minutes_remaining?: number | null;
  languages?: Record<string, string>;
}
interface Stored {
  url?: string;
  key_sealed?: string;
  key_hint?: string;
  eleven_sealed?: string;
  eleven_hint?: string;
  fal_sealed?: string;
  fal_hint?: string;
  max_upload_mb?: number;
  max_active?: number;
  info?: Info;
  checked_at?: string;
  error?: string;
}

const hint = (s: string) => `…${s.slice(-4)}`;
const ext = (name: string) => extname(String(name || '')).toLowerCase().replace(/[^.a-z0-9]/g, '');

/** Whether OpenShorts (and Postiz) can reach HyperLevel: https on a public host name. */
export function isPublicBase(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^\[|\]$/g, '');
    if (u.protocol !== 'https:') return false;
    if (h === 'localhost' || /\.(local|internal|localhost|lan|home)$/i.test(h) || !h.includes('.')) return false;
    return !(isIP(h) && isPrivateIp(h));
  } catch {
    return false;
  }
}

/** First bytes of a video container (MP4/MOV ftyp, Matroska/WebM, AVI). */
export function looksLikeVideo(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') return true;
  if (buf.readUInt32BE(0) === 0x1a45dfa3) return true;
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'AVI ') return true;
  // QuickTime files without ftyp start with a moov/mdat/wide/free atom.
  return ['moov', 'mdat', 'wide', 'free', 'skip'].includes(buf.subarray(4, 8).toString('latin1'));
}

export function parseRange(header: unknown, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  let end = m[1] && m[2] ? Number(m[2]) : size - 1;
  end = Math.min(end, size - 1);
  if (start > end || start >= size) return null;
  start = Math.max(0, start);
  return { start, end };
}

export const videoStudioModule: Module = {
  name: 'video-studio',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE video_jobs (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        kind TEXT NOT NULL DEFAULT 'clips', title TEXT NOT NULL DEFAULT '', source_type TEXT NOT NULL,
        source_url TEXT, source_name TEXT, upload_id TEXT, options TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, stage TEXT NOT NULL DEFAULT '', error TEXT,
        os_job_id TEXT, hook_hash TEXT, hook_sealed TEXT, webhook_at TEXT,
        contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL, user_id TEXT, origin TEXT NOT NULL DEFAULT 'manuell',
        attempts INTEGER NOT NULL DEFAULT 0, polled_at TEXT, completed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX video_jobs_loc ON video_jobs(location_id, created_at);
      CREATE INDEX video_jobs_status ON video_jobs(status);
      CREATE UNIQUE INDEX video_jobs_hook ON video_jobs(hook_hash);
      CREATE TABLE video_clips (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES video_jobs(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        os_index INTEGER NOT NULL, video_path TEXT NOT NULL, start_s REAL, end_s REAL, duration REAL, score INTEGER,
        reason TEXT NOT NULL DEFAULT '', hook TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '', hashtags TEXT NOT NULL DEFAULT '[]', edited INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'ready', ops TEXT NOT NULL DEFAULT '[]', op_status TEXT NOT NULL DEFAULT '', op_error TEXT,
        planned INTEGER NOT NULL DEFAULT 0, planned_at TEXT, doc_saved INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (job_id, os_index)
      );
      CREATE INDEX video_clips_loc ON video_clips(location_id, created_at);
      CREATE TABLE video_posts (
        id TEXT PRIMARY KEY, clip_id TEXT NOT NULL REFERENCES video_clips(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, social_post_id TEXT,
        channels INTEGER NOT NULL DEFAULT 0, type TEXT NOT NULL, publish_at TEXT NOT NULL, user_id TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX video_posts_loc ON video_posts(location_id, publish_at);
      CREATE TABLE video_uploads (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, file TEXT NOT NULL, size INTEGER NOT NULL, received INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open', job_id TEXT, user_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      `,
    ],
  ],
  register(app) {
    // OpenShorts job results (transcripts, clip lists) can exceed the 1 MB public default.
    app.services.bodyLimits = [...(app.services.bodyLimits ?? []), { match: (m: string, p: string) => m === 'POST' && /^\/hooks\/openshorts\/[^/]+$/.test(p), bytes: 12 * 1024 * 1024 }];
    const { db, router } = app;
    const dir = join(app.config.dataDir, 'video-studio', 'uploads');
    const fetchImpl = (): os.FetchLike => app.services.openshortsFetch ?? ((u: string, i?: any) => fetch(u, i));

    // --- settings ---------------------------------------------------------------------------
    const stored = (): Stored => {
      const row = db.get('SELECT value FROM agency_settings WHERE key = ?', SETTINGS_KEY);
      return row ? JSON.parse(row.value) : {};
    };
    const save = (v: Stored) => db.run('INSERT INTO agency_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', SETTINGS_KEY, JSON.stringify(v));
    const open = (sealed?: string) => {
      if (!sealed) return undefined;
      try {
        return openSecret(app, sealed);
      } catch {
        return undefined;
      }
    };
    const config = (): os.OsConfig | null => {
      const s = stored();
      const url = s.url || process.env.PGHL_OPENSHORTS_URL || '';
      if (!url) return null;
      return { url: os.osBase(url), apiKey: open(s.key_sealed) || process.env.PGHL_OPENSHORTS_KEY || undefined, elevenlabsKey: open(s.eleven_sealed), falKey: open(s.fal_sealed) };
    };
    const cfgOrFail = () => {
      const c = config();
      if (!c) throw new HttpError(409, 'Video-Studio ist noch nicht verbunden (Agentur → Integrationen → Einrichtung)');
      return c;
    };
    const info = (): Info | undefined => stored().info;
    const features = () => info()?.features ?? os.featuresOf(null);
    const maxUploadMb = () => Math.max(10, Math.min(DEFAULT_MAX_MB, Number(stored().max_upload_mb) || DEFAULT_MAX_MB));
    const maxActive = () => Math.max(1, Math.min(20, Number(stored().max_active) || 3));
    const masked = () => {
      const s = stored();
      const c = config();
      return {
        url: s.url || process.env.PGHL_OPENSHORTS_URL || '',
        key_set: !!c?.apiKey,
        key_hint: s.key_hint ?? (process.env.PGHL_OPENSHORTS_KEY ? 'Umgebung' : ''),
        elevenlabs_set: !!s.eleven_sealed,
        elevenlabs_hint: s.eleven_hint ?? '',
        fal_set: !!s.fal_sealed,
        fal_hint: s.fal_hint ?? '',
        max_upload_mb: maxUploadMb(),
        max_active: maxActive(),
        configured: !!c,
        info: s.info ?? null,
        checked_at: s.checked_at ?? null,
        error: s.error ?? null,
        webhooks: isPublicBase(app.baseUrl()),
        base_url: app.baseUrl(),
      };
    };

    /** Health, mode (self-hosted/hosted), key, features (from /openapi.json) and dubbing languages. */
    const testConnection = async (cfg: os.OsConfig): Promise<Info> => {
      const f = fetchImpl();
      const h = await os.osFetch(f, cfg, 'GET', '/health', { timeoutMs: 10_000 });
      if (!h.ok) throw new HttpError(502, h.status === 404 ? 'Unter dieser Adresse antwortet kein OpenShorts-Backend – die Adresse des Backends (Port 8000) angeben, nicht die des Dashboards' : `OpenShorts antwortet mit Status ${h.status}`);
      const conf = await os.osJson(f, cfg, 'GET', '/api/config', { timeoutMs: 10_000 }).catch(() => ({}) as any);
      const hosted = !!conf?.billingEnabled;
      if (hosted && !cfg.apiKey) throw bad('Für die gehostete API (openshorts.app) wird ein API-Schlüssel (osk_…) gebraucht');
      let plan: string | null = null;
      let minutes: number | null = null;
      if (cfg.apiKey) {
        const me = await os.osFetch(f, cfg, 'GET', '/api/me', { timeoutMs: 10_000 });
        if (me.status === 401 || me.status === 403) throw new HttpError(502, 'OpenShorts: API-Schlüssel ungültig');
        if (me.ok) {
          const j: any = await me.json().catch(() => ({}));
          plan = j?.plan ?? null;
          minutes = typeof j?.minutes?.remaining === 'number' ? j.minutes.remaining : null;
        }
      }
      let paths: string[] | null = null;
      try {
        const spec: any = await os.osJson(f, cfg, 'GET', '/openapi.json', { timeoutMs: 15_000 });
        if (spec?.paths && typeof spec.paths === 'object') paths = Object.keys(spec.paths);
      } catch {
        /* docs switched off: assume the full API */
      }
      const feats = os.featuresOf(paths);
      let languages: Record<string, string> | undefined;
      if (feats.translate) {
        try {
          const l: any = await os.osJson(f, cfg, 'GET', '/api/translate/languages', { timeoutMs: 10_000 });
          if (l?.languages && typeof l.languages === 'object') languages = Object.fromEntries(Object.entries(l.languages).slice(0, 80).map(([k, v]) => [String(k).slice(0, 10), String(v).slice(0, 60)]));
        } catch {
          /* optional */
        }
      }
      const retention = Number(conf?.jobRetentionSeconds);
      return {
        mode: hosted ? 'hosted' : 'selfhosted',
        features: feats,
        youtube_urls: conf?.youtubeUrlEnabled !== false,
        local_llm: conf?.localLlm?.model ? String(conf.localLlm.model).slice(0, 100) : null,
        retention_hours: Number.isFinite(retention) && retention > 0 ? Math.round(retention / 3600) : null,
        plan,
        minutes_remaining: minutes,
        languages,
      };
    };

    // --- background work (detached; tests await idle()) ---------------------------------------
    const busy = new Set<string>();
    const running = new Set<Promise<void>>();
    const bg = (key: string, fn: () => Promise<void>) => {
      if (busy.has(key)) return;
      busy.add(key);
      const p: Promise<void> = fn()
        .catch((e) => console.error('[video-studio]', key, (e as Error).message))
        .finally(() => {
          busy.delete(key);
          running.delete(p);
        });
      running.add(p);
    };

    // --- jobs -------------------------------------------------------------------------------
    const getJob = (jobId: string, loc?: string) => parseJson(db.get(`SELECT * FROM video_jobs WHERE id = ?${loc ? ' AND location_id = ?' : ''}`, jobId, ...(loc ? [loc] : [])), ['options']);
    const setJob = (jobId: string, patch: Record<string, unknown>) => db.update('video_jobs', jobId, { ...patch, updated_at: now() });
    const clipOut = (c: any) => {
      const row = parseJson({ ...c }, ['hashtags', 'ops']);
      return { ...row, ops: undefined, pending: Array.isArray(row.ops) ? row.ops.length : 0, video_url: `/api/video-studio/clips/${c.id}/video`, thumb_url: app.services.videoClipThumb?.(c.id) ?? null };
    };
    const jobOut = (j: any, withClips = false) => {
      const { hook_hash: _h, hook_sealed: _s, ...rest } = j;
      const counts = db.get(`SELECT COUNT(*) n, MAX(score) best, SUM(planned > 0) planned FROM video_clips WHERE job_id = ? AND status = 'ready'`, j.id);
      return {
        ...rest,
        options: typeof rest.options === 'string' ? JSON.parse(rest.options) : rest.options,
        status_label: JOB_STATUS[j.status] ?? j.status,
        webhook: !!_h,
        clips_count: Number(counts?.n ?? 0),
        best_score: counts?.best ?? null,
        planned_count: Number(counts?.planned ?? 0),
        ...(withClips ? { clips: db.all(`SELECT * FROM video_clips WHERE job_id = ? AND status = 'ready' ORDER BY COALESCE(score, -1) DESC, os_index`, j.id).map(clipOut) } : {}),
      };
    };

    const hookOf = (job: any): { url: string; secret: string } | null => {
      if (!job.hook_sealed) return null;
      const h = JSON.parse(open(job.hook_sealed) ?? '{}');
      return h.token && h.secret ? { url: `${app.baseUrl()}/hooks/openshorts/${h.token}`, secret: h.secret } : null;
    };

    const sign = (purpose: string, ref: string, exp: number) => createHmac('sha256', app.config.secret).update(`${purpose}:${ref}:${exp}`).digest('base64url').slice(0, 32);
    const verify = (purpose: string, ref: string, exp: number, sig: string) => {
      if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
      const want = Buffer.from(sign(purpose, ref, exp));
      const got = Buffer.from(String(sig));
      return want.length === got.length && timingSafeEqual(want, got);
    };
    /** Public, short-lived link to one clip (Postiz fetches the video from here). */
    const mediaUrl = (clipId: string) => {
      const exp = Math.floor(Date.now() / 1000) + MEDIA_TTL_S;
      return `${app.baseUrl()}/hooks/openshorts/media/${clipId}.${exp}.${sign('media', clipId, exp)}.mp4`;
    };
    const sourceUrl = (up: any) => {
      const exp = Math.floor(Date.now() / 1000) + SOURCE_TTL_S;
      return `${app.baseUrl()}/hooks/openshorts/source/${up.id}.${exp}.${sign('source', up.id, exp)}${ext(up.file) || '.mp4'}`;
    };

    /** POST /api/process – a job id, or the low-resolution question. */
    const submit = async (job: any, source: { url?: string; upload_id?: string }, forceLow = false) => {
      const cfg = cfgOrFail();
      const body = os.processBody(os.cleanOptions(job.options), source, hookOf(job), forceLow);
      const r: any = await os.osJson(fetchImpl(), cfg, 'POST', '/api/process', { json: body, timeoutMs: 150_000 });
      if (r?.needs_confirmation) {
        const q = r.quality_check ?? {};
        setJob(job.id, { status: 'confirm', progress: 0, stage: `Die Quelle gibt es nur in ${q.max_height ?? '?'}p (empfohlen ab ${q.min_height ?? 720}p) – trotzdem verarbeiten?` });
        return;
      }
      const osId = String(r?.job_id ?? '');
      if (!/^[A-Za-z0-9-]{8,64}$/.test(osId)) throw new HttpError(502, 'OpenShorts hat keine Job-ID geliefert');
      setJob(job.id, { os_job_id: osId, status: 'queued', progress: 2, stage: 'In der Warteschlange', error: null, polled_at: now() });
    };

    /** Upload → OpenShorts: its upload slot (streamed from disk), or a signed HyperLevel link for old versions. */
    const transfer = async (jobId: string) => {
      const job = getJob(jobId);
      if (!job || job.status !== 'uploading') return;
      const up = db.get('SELECT * FROM video_uploads WHERE id = ?', job.upload_id);
      const path = up ? join(dir, up.file) : '';
      if (!up || !existsSync(path)) {
        setJob(jobId, { status: 'failed', error: 'Die hochgeladene Datei ist nicht mehr da – bitte erneut hochladen', stage: 'Fehlgeschlagen' });
        return;
      }
      setJob(jobId, { attempts: Number(job.attempts) + 1, stage: 'Video wird an OpenShorts übertragen' });
      try {
        const cfg = cfgOrFail();
        const f = fetchImpl();
        if (features().uploads) {
          const slot: any = await os.osJson(f, cfg, 'POST', '/api/uploads', { json: { filename: up.name.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'video.mp4' }, timeoutMs: 30_000 });
          const slotId = String(slot?.upload_id ?? '');
          if (!/^[A-Za-z0-9-]{8,64}$/.test(slotId)) throw new HttpError(502, 'OpenShorts hat keinen Upload-Platz vergeben');
          if (slot.max_mb && up.size > Number(slot.max_mb) * 1024 * 1024) throw bad(`OpenShorts nimmt höchstens ${slot.max_mb} MB an`);
          const blob = await openAsBlob(path, { type: 'application/octet-stream' });
          // ~1 MB/s worst case, at least 2 minutes, at most 3 hours.
          const ms = Math.min(3 * 3600_000, Math.max(120_000, Math.ceil(up.size / 1_000_000) * 1000));
          await os.osJson(f, cfg, 'PUT', `/api/uploads/${encodeURIComponent(slotId)}`, { body: blob, contentType: 'application/octet-stream', timeoutMs: ms });
          await submit(getJob(jobId), { upload_id: slotId });
          rmSync(path, { force: true });
          db.run(`UPDATE video_uploads SET status = 'sent', updated_at = ? WHERE id = ?`, now(), up.id);
        } else {
          if (!isPublicBase(app.baseUrl())) throw bad('Diese OpenShorts-Version nimmt keine Dateien an und HyperLevel ist nicht öffentlich per https erreichbar – bitte einen Link verwenden');
          await submit(getJob(jobId), { url: sourceUrl(up) });
        }
      } catch (e) {
        setJob(jobId, { status: 'failed', stage: 'Fehlgeschlagen', error: (e as Error).message.slice(0, 300) });
      }
    };

    const activeCount = (loc: string) => Number(db.get(`SELECT COUNT(*) n FROM video_jobs WHERE location_id = ? AND status IN (${ACTIVE.map(() => '?').join(',')})`, loc, ...ACTIVE)?.n ?? 0);

    interface JobInput {
      url?: string;
      upload_id?: string;
      title?: string;
      options?: unknown;
      contact_id?: string | null;
      user_id?: string | null;
      origin?: string;
    }
    const createJob = async (loc: string, input: JobInput) => {
      cfgOrFail();
      const options = os.cleanOptions(input.options);
      if (activeCount(loc) >= maxActive()) throw new HttpError(429, `Höchstens ${maxActive()} laufende Jobs je Sub-Account – bitte warten, bis einer fertig ist`);
      const contactId = input.contact_id ? String(input.contact_id) : null;
      if (contactId && !db.get('SELECT id FROM contacts WHERE id = ? AND location_id = ?', contactId, loc)) throw bad('Kontakt nicht gefunden');
      let up: any = null;
      let url = '';
      if (input.upload_id) {
        up = db.get('SELECT * FROM video_uploads WHERE id = ? AND location_id = ?', String(input.upload_id), loc);
        if (!up) throw notFound('Upload nicht gefunden');
        if (up.status !== 'complete') throw bad(up.status === 'open' ? 'Der Upload ist noch nicht vollständig' : 'Dieser Upload wurde schon verwendet');
      } else {
        url = str(input.url, 'Video-Link', { required: true, max: 2000 });
        let u: URL;
        try {
          u = new URL(url);
        } catch {
          throw bad('Video-Link ungültig');
        }
        if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad('Video-Link mit https:// angeben');
        if (info()?.youtube_urls === false && os.isYouTube(url)) throw bad('Diese OpenShorts-Instanz nimmt keine YouTube-Links an – bitte die Datei hochladen');
      }
      const hookToken = isPublicBase(app.baseUrl()) ? token(24) : null;
      const job = {
        id: id(),
        location_id: loc,
        kind: 'clips',
        title: str(input.title, 'Titel', { max: 200 }) || (up ? up.name.replace(/\.[^.]+$/, '') : url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 80)),
        source_type: up ? 'upload' : 'url',
        source_url: up ? null : url,
        source_name: up ? up.name : null,
        upload_id: up ? up.id : null,
        options,
        status: up ? 'uploading' : 'submitting',
        progress: 0,
        stage: up ? 'Video wird an OpenShorts übertragen' : 'Wird gestartet',
        hook_hash: hookToken ? sha256(hookToken) : null,
        hook_sealed: hookToken ? sealSecret(app, JSON.stringify({ token: hookToken, secret: token(32) })) : null,
        contact_id: contactId,
        user_id: input.user_id ?? null,
        origin: input.origin ?? 'manuell',
        created_at: now(),
        updated_at: now(),
      };
      db.insert('video_jobs', job);
      if (up) {
        db.run(`UPDATE video_uploads SET status = 'used', job_id = ?, updated_at = ? WHERE id = ?`, job.id, now(), up.id);
        bg(`transfer:${job.id}`, () => transfer(job.id));
      } else {
        try {
          await submit(getJob(job.id), { url });
        } catch (e) {
          db.run('DELETE FROM video_jobs WHERE id = ?', job.id);
          throw e;
        }
      }
      return jobOut(getJob(job.id));
    };

    /** Clips from a status result: new ones are added, known ones keep the user's edits. */
    const upsertClips = (job: any, clips: os.ParsedClip[]) => {
      for (const c of clips) {
        const cur = db.get('SELECT * FROM video_clips WHERE job_id = ? AND os_index = ?', job.id, c.index);
        if (!cur) {
          db.insert('video_clips', {
            id: id(), job_id: job.id, location_id: job.location_id, os_index: c.index, video_path: c.path, start_s: c.start, end_s: c.end, duration: c.duration,
            score: c.score, reason: c.reason, hook: c.hook, title: c.title, description: c.description, hashtags: c.hashtags, created_at: now(), updated_at: now(),
          });
        } else if (cur.ops === '[]' && cur.video_path !== c.path && !cur.op_status) {
          // OpenShorts re-pointed the file (watermark removed after an upgrade, re-render in its dashboard).
          db.run('UPDATE video_clips SET video_path = ?, updated_at = ? WHERE id = ?', c.path, now(), cur.id);
        }
      }
    };

    const finish = (job: any) => {
      const fresh = getJob(job.id);
      if (!fresh || fresh.status === 'completed') return;
      setJob(job.id, { status: 'completed', progress: 100, stage: 'Fertig', completed_at: now(), error: null });
      const clips = db.all(`SELECT id, title, score FROM video_clips WHERE job_id = ? AND status = 'ready' ORDER BY COALESCE(score, -1) DESC`, job.id);
      const best = clips[0];
      void app.events.emit(job.location_id, 'shorts.ready', {
        ...(fresh.contact_id ? { contactId: fresh.contact_id } : {}),
        jobId: job.id,
        title: fresh.title,
        clips: clips.length,
        bestClipId: best?.id ?? null,
        bestClipTitle: best?.title ?? null,
        bestScore: best?.score ?? null,
        url: `${app.baseUrl()}/app/video-studio/${job.id}`,
      });
      if (fresh.user_id) {
        Promise.resolve(app.services.pushNotify?.({ userIds: [fresh.user_id], kind: 'shorts', title: 'Shorts fertig', body: `${fresh.title}: ${clips.length} Clips`, url: `/app/video-studio/${job.id}`, tag: `shorts-${job.id}` })).catch(() => {});
      }
      // Other modules continue from here (recycling, autopilot): app.services.videoStudioReady = [...(…), fn(job)].
      const hooks: ((j: any) => unknown)[] = app.services.videoStudioReady ?? [];
      if (hooks.length) bg(`ready:${job.id}`, async () => {
        for (const fn of hooks) await fn(getJob(job.id));
      });
    };

    const fail = (job: any, error: string) => {
      setJob(job.id, { status: 'failed', progress: 0, stage: 'Fehlgeschlagen', error: error.slice(0, 300) });
    };

    /** Pulls the job's status from OpenShorts (webhook, refresh button and the poller all end here). */
    const refreshJob = async (jobId: string) => {
      const job = getJob(jobId);
      if (!job || !job.os_job_id || !['queued', 'processing'].includes(job.status)) return job;
      const cfg = cfgOrFail();
      const ugc = job.kind === 'ugc';
      let r: any;
      try {
        r = await os.osJson(fetchImpl(), cfg, 'GET', ugc ? `/api/saasshorts/status/${encodeURIComponent(job.os_job_id)}` : `/api/status/${encodeURIComponent(job.os_job_id)}`, { timeoutMs: 20_000 });
      } catch (e) {
        if ((e as HttpError).status === 404) fail(job, 'OpenShorts kennt diesen Job nicht mehr (Neustart oder abgelaufen) – bitte neu starten');
        else setJob(jobId, { polled_at: now() });
        return getJob(jobId);
      }
      const status = String(r?.status ?? '');
      if (ugc) {
        if (status === 'completed') {
          const clip = os.parseUgcResult(r.result);
          if (!clip) return (fail(job, 'OpenShorts hat kein Video geliefert'), getJob(jobId));
          upsertClips(job, [clip]);
          finish(job);
        } else if (status === 'failed') fail(job, os.errorFromLogs(r.logs));
        else setJob(jobId, { status: 'processing', polled_at: now(), ...os.progressOf('processing', r.logs, 0) });
        return getJob(jobId);
      }
      const clips = os.parseClips(r?.result);
      if (clips.length) upsertClips(job, clips);
      if (status === 'completed') {
        if (!clips.length) return (fail(job, 'OpenShorts hat keine Clips erzeugt'), getJob(jobId));
        const options = os.cleanOptions(job.options);
        const ops = os.postOps(options, !!cfg.elevenlabsKey && features().translate).filter((o) => (o.op === 'framing' ? features().rerender : o.op === 'subtitles' ? features().subtitles : true));
        if (ops.length) {
          db.run(`UPDATE video_clips SET ops = ?, op_status = 'pending', updated_at = ? WHERE job_id = ? AND status = 'ready' AND ops = '[]' AND op_status = ''`, JSON.stringify(ops), now(), jobId);
          setJob(jobId, { status: 'finishing', progress: 98, stage: 'Nachbearbeitung (Bildausschnitt, Vertonung, Untertitel)', polled_at: now() });
          bg('ops', runOps);
        } else finish(job);
      } else if (status === 'failed') {
        fail(job, os.errorFromLogs(r?.logs));
      } else if (status === 'queued' || status === 'processing') {
        setJob(jobId, { status, polled_at: now(), ...os.progressOf(status, r?.logs, clips.length, r?.queue) });
      } else setJob(jobId, { polled_at: now() });
      return getJob(jobId);
    };

    // --- follow-up steps per clip (captions style, dubbing, framing) ----------------------------
    const applyOp = async (clip: any, op: os.ClipOp): Promise<string> => {
      const cfg = cfgOrFail();
      const input_filename = clip.video_path.split('/').pop();
      const base = { job_id: clip.os_job_id, clip_index: clip.os_index };
      let r: any;
      if (op.op === 'subtitles') r = await os.osJson(fetchImpl(), cfg, 'POST', '/api/subtitle', { json: { ...base, preset: op.preset, input_filename }, timeoutMs: 20 * 60_000 });
      else if (op.op === 'dub') {
        if (!cfg.elevenlabsKey) throw bad('Für die Vertonung fehlt der ElevenLabs-Schlüssel (Agentur → Integrationen)');
        r = await os.osJson(fetchImpl(), cfg, 'POST', '/api/translate', { json: { ...base, target_language: op.language, input_filename }, elevenlabs: true, timeoutMs: 40 * 60_000 });
      } else {
        if (clip.start_s === null || clip.end_s === null) throw bad('Für diesen Clip fehlen Start und Ende');
        const opts = os.cleanOptions(JSON.parse(clip.job_options || '{}'));
        r = await os.osJson(fetchImpl(), cfg, 'POST', '/api/clip/rerender', { json: { ...base, segments: [{ start: clip.start_s, end: clip.end_s }], framing: op.framing, reapply_captions: opts.subtitles !== 'off' && !opts.dub_language }, timeoutMs: 40 * 60_000 });
      }
      const path = os.mediaPath(r?.new_video_url);
      if (!path) throw new HttpError(502, 'OpenShorts hat keine neue Datei geliefert');
      return path;
    };

    let opsRunning = false;
    const runOps = async () => {
      if (opsRunning) return;
      opsRunning = true;
      try {
        for (let n = 0; n < 100; n++) {
          const clip = db.get(
            `SELECT c.*, j.os_job_id, j.options AS job_options FROM video_clips c JOIN video_jobs j ON j.id = c.job_id
             WHERE c.ops != '[]' AND c.status = 'ready' AND j.status IN ('finishing','completed') ORDER BY c.updated_at LIMIT 1`,
          );
          if (!clip) break;
          const ops: os.ClipOp[] = JSON.parse(clip.ops);
          db.run(`UPDATE video_clips SET op_status = 'running', updated_at = ? WHERE id = ?`, now(), clip.id);
          try {
            const path = await applyOp(clip, ops[0]);
            const rest = ops.slice(1);
            db.run(`UPDATE video_clips SET video_path = ?, ops = ?, op_status = ?, op_error = NULL, updated_at = ? WHERE id = ?`, path, JSON.stringify(rest), rest.length ? 'pending' : '', now(), clip.id);
          } catch (e) {
            db.run(`UPDATE video_clips SET ops = '[]', op_status = 'failed', op_error = ?, updated_at = ? WHERE id = ?`, (e as Error).message.slice(0, 300), now(), clip.id);
          }
        }
      } finally {
        opsRunning = false;
      }
      for (const j of db.all(`SELECT * FROM video_jobs WHERE status = 'finishing'`)) {
        if (!db.get(`SELECT 1 FROM video_clips WHERE job_id = ? AND status = 'ready' AND ops != '[]'`, j.id)) finish(j);
      }
    };

    // --- the poller and housekeeping -------------------------------------------------------------
    const pollDue = async () => {
      if (!config()) return;
      const t = Date.now();
      const jobs = db.all(`SELECT id, hook_hash, polled_at FROM video_jobs WHERE status IN ('queued','processing') ORDER BY polled_at LIMIT 25`);
      for (const j of jobs) {
        const every = j.hook_hash ? POLL_MS.withHook : POLL_MS.normal;
        if (j.polled_at && t - Date.parse(j.polled_at) < every) continue;
        try {
          await refreshJob(j.id);
        } catch (e) {
          console.error('[video-studio] poll', (e as Error).message);
        }
      }
    };
    const housekeeping = () => {
      // Uploads whose transfer was cut off by a restart are tried again (max. 3 times).
      for (const j of db.all(`SELECT id, attempts, updated_at FROM video_jobs WHERE status = 'uploading'`)) {
        if (busy.has(`transfer:${j.id}`)) continue;
        if (Number(j.attempts) >= 3) fail(j, 'Die Übertragung an OpenShorts ist mehrfach abgebrochen');
        else bg(`transfer:${j.id}`, () => transfer(j.id));
      }
      // A job stuck in "submitting" (crash during the call) is reported instead of hanging forever.
      for (const j of db.all(`SELECT id FROM video_jobs WHERE status = 'submitting' AND updated_at < ?`, new Date(Date.now() - 10 * 60_000).toISOString())) fail(j, 'Start abgebrochen – bitte erneut versuchen');
      const day = new Date(Date.now() - 24 * 3600_000).toISOString();
      const old = db.all(
        `SELECT u.* FROM video_uploads u LEFT JOIN video_jobs j ON j.id = u.job_id
         WHERE (u.status IN ('open','complete') AND u.updated_at < ?) OR (u.status = 'used' AND (j.id IS NULL OR j.status IN ('completed','failed')) AND u.updated_at < ?)`,
        day,
        new Date(Date.now() - 2 * 3600_000).toISOString(),
      );
      for (const u of old) {
        rmSync(join(dir, u.file), { force: true });
        db.run(`UPDATE video_uploads SET status = 'gone', updated_at = ? WHERE id = ?`, now(), u.id);
      }
      db.run(`DELETE FROM video_uploads WHERE status IN ('gone','sent') AND updated_at < ?`, new Date(Date.now() - 7 * 24 * 3600_000).toISOString());
    };
    app.onTick(() => {
      housekeeping();
      bg('poll', pollDue);
      if (db.get(`SELECT 1 FROM video_clips WHERE ops != '[]' AND status = 'ready'`) || db.get(`SELECT 1 FROM video_jobs WHERE status = 'finishing'`)) bg('ops', runOps);
    });

    /** Shared with the YouTube/AI-Shorts module, the workflow action, tests. */
    app.services.videoStudio = {
      config,
      info,
      features,
      fetch: fetchImpl,
      createJob,
      refreshJob,
      runOps,
      pollDue,
      bg,
      upsertClips,
      jobOut,
      getJob,
      mediaPath: os.mediaPath,
      mediaUrl,
      isPublicBase: () => isPublicBase(app.baseUrl()),
      scheduleClip: (loc: string, clipId: string, input: any) => scheduleClip(loc, clipId, input),
      captionOf: (c: any, override?: unknown) => captionOf(c, override),
      async idle() {
        for (let i = 0; i < 50 && running.size; i++) await Promise.all([...running]);
      },
      /** AI Shorts: a finished UGC render becomes a job with one clip (same review and planning). */
      addUgcJob(loc: string, input: { os_job_id: string; title: string; user_id?: string | null }) {
        const row = { id: id(), location_id: loc, kind: 'ugc', title: input.title.slice(0, 200) || 'KI-Short', source_type: 'ugc', options: {}, status: 'processing', progress: 5, stage: 'KI-Short wird erzeugt', os_job_id: input.os_job_id, user_id: input.user_id ?? null, origin: 'KI-Shorts', polled_at: now(), created_at: now(), updated_at: now() };
        db.insert('video_jobs', row);
        return jobOut(getJob(row.id));
      },
      proxy: (path: string, ctx: Ctx, download?: string) => proxyMedia(path, ctx.req.headers.range, download),
    };

    // --- media proxy --------------------------------------------------------------------------
    const proxyMedia = async (path: string, range: unknown, download?: string): Promise<RawResult> => {
      const cfg = cfgOrFail();
      const safe = os.mediaPath(path);
      if (!safe) throw notFound();
      const r = await os.osFetch(fetchImpl(), cfg, 'GET', safe.split('/').map(encodeURIComponent).join('/'), { headers: typeof range === 'string' && /^bytes=\d*-\d*$/.test(range) ? { range } : {}, stream: true, timeoutMs: 20_000 });
      if (r.status === 404) {
        await r.body?.cancel().catch(() => {});
        throw notFound('Die Datei ist in OpenShorts nicht mehr vorhanden (abgelaufen) – Job neu starten oder Aufbewahrung in OpenShorts verlängern');
      }
      if (!r.ok || !r.body) {
        await r.body?.cancel().catch(() => {});
        throw r.status === 416 ? new HttpError(416, 'Bereich ungültig') : os.osError(r.status, null);
      }
      const type = r.headers.get('content-type') ?? '';
      const headers: Record<string, string> = {
        'content-type': /^(video|image)\/[\w.+-]+$/.test(type.split(';')[0]) ? type.split(';')[0] : safe.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream',
        'accept-ranges': 'bytes',
        'cache-control': 'private, max-age=300',
        'x-content-type-options': 'nosniff',
      };
      for (const h of ['content-length', 'content-range', 'last-modified', 'etag']) {
        const v = r.headers.get(h);
        if (v) headers[h] = v;
      }
      if (download) headers['content-disposition'] = `attachment; filename="${download.replace(/[^\w.\- ]+/g, '_').slice(0, 100) || 'clip.mp4'}"`;
      return { __raw: true, status: r.status, headers, body: Readable.fromWeb(r.body as any) };
    };

    // --- routes: agency setup -------------------------------------------------------------------
    router.get('/api/agency/video-studio', 'admin', () => masked());
    router.patch('/api/agency/video-studio', 'admin', async (ctx) => {
      const cur = stored();
      const next: Stored = { ...cur };
      const b = ctx.body ?? {};
      if (b.url !== undefined) next.url = os.cleanBaseUrl(b.url);
      for (const [field, sealedKey, hintKey, label] of [
        ['api_key', 'key_sealed', 'key_hint', 'API-Schlüssel'],
        ['elevenlabs_key', 'eleven_sealed', 'eleven_hint', 'ElevenLabs-Schlüssel'],
        ['fal_key', 'fal_sealed', 'fal_hint', 'fal.ai-Schlüssel'],
      ] as const) {
        if (b[field] === null || b[`clear_${field}`]) {
          delete next[sealedKey];
          delete next[hintKey];
        } else if (b[field]) {
          const v = str(b[field], label, { max: 300 });
          if (/\s/.test(v)) throw bad(`${label} enthält Leerzeichen`);
          next[sealedKey] = sealSecret(app, v);
          next[hintKey] = hint(v);
        }
      }
      if (b.max_upload_mb !== undefined) next.max_upload_mb = Math.max(10, Math.min(DEFAULT_MAX_MB, Math.round(Number(b.max_upload_mb) || DEFAULT_MAX_MB)));
      if (b.max_active !== undefined) next.max_active = Math.max(1, Math.min(20, Math.round(Number(b.max_active) || 3)));
      const changedConn = next.url !== cur.url || next.key_sealed !== cur.key_sealed;
      save(next);
      if (changedConn) {
        const s = stored();
        delete s.info;
        delete s.checked_at;
        delete s.error;
        save(s);
        const cfg = config();
        if (cfg) {
          try {
            const i = await testConnection(cfg);
            save({ ...stored(), info: i, checked_at: now(), error: undefined });
          } catch (e) {
            save({ ...stored(), error: (e as Error).message, checked_at: now() });
          }
        }
      }
      return masked();
    });
    router.post('/api/agency/video-studio/test', 'admin', async (ctx) => {
      const saved = config();
      const url = ctx.body?.url ? os.cleanBaseUrl(ctx.body.url) : saved?.url;
      if (!url) throw bad('Adresse fehlt');
      const cfg: os.OsConfig = { ...(saved ?? {}), url, apiKey: ctx.body?.api_key ? String(ctx.body.api_key).trim() : saved?.apiKey };
      // A test of other values (address/key typed but not saved) never overwrites the saved state.
      const adhoc = !!(ctx.body?.url || ctx.body?.api_key);
      try {
        const i = await testConnection(cfg);
        if (!adhoc) save({ ...stored(), info: i, checked_at: now(), error: undefined });
        return { ok: true, info: i };
      } catch (e) {
        if (!adhoc) save({ ...stored(), error: (e as Error).message, checked_at: now() });
        throw e;
      }
    });

    // --- routes: the studio of one sub-account ---------------------------------------------------
    router.get('/api/video-studio', 'location', () => {
      const c = config();
      const i = info();
      return {
        configured: !!c,
        mode: i?.mode ?? null,
        features: features(),
        youtube_urls: i?.youtube_urls ?? true,
        retention_hours: i?.retention_hours ?? null,
        dubbing: !!c?.elevenlabsKey && features().translate,
        ai_shorts: !!c?.elevenlabsKey && !!c?.falKey && features().ai_shorts,
        languages: i?.languages && Object.keys(i.languages).length ? i.languages : os.DEFAULT_LANGUAGES,
        layouts: os.LAYOUTS,
        subtitle_styles: os.SUBTITLE_STYLES,
        hook_styles: os.HOOK_STYLES,
        formats: os.FORMATS,
        max_upload_mb: maxUploadMb(),
        chunk_size: CHUNK,
        max_active: maxActive(),
        public_base: isPublicBase(app.baseUrl()),
        social: !!app.services.socialPost,
        error: c ? (stored().error ?? null) : null,
      };
    });

    router.get('/api/video-studio/jobs', 'location', (ctx) => {
      const status = ctx.query.get('status');
      const kind = ctx.query.get('kind');
      const where = ['location_id = ?'];
      const params: any[] = [ctx.locationId];
      if (status === 'active') where.push(`status IN (${ACTIVE.map(() => '?').join(',')}, 'confirm')`), params.push(...ACTIVE);
      else if (status) where.push('status = ?'), params.push(status);
      if (kind) where.push('kind = ?'), params.push(kind);
      const limit = Math.min(200, Math.max(1, Number(ctx.query.get('limit')) || 100));
      return db.all(`SELECT * FROM video_jobs WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${limit}`, ...params).map((j) => jobOut(j, ctx.query.get('clips') === '1'));
    });
    router.post('/api/video-studio/jobs', 'location', async (ctx) =>
      createJob(ctx.locationId, {
        url: ctx.body.url,
        upload_id: ctx.body.upload_id,
        title: ctx.body.title,
        options: ctx.body.options ?? ctx.body,
        contact_id: ctx.body.contact_id,
        user_id: ctx.user?.id ?? null,
        origin: ctx.via === 'mcp' ? 'MCP' : ctx.viaApiKey ? 'API' : 'manuell',
      }),
    );
    router.get('/api/video-studio/jobs/:id', 'location', (ctx) => {
      const j = getJob(ctx.params.id, ctx.locationId);
      if (!j) throw notFound('Job nicht gefunden');
      return jobOut(j, true);
    });
    router.post('/api/video-studio/jobs/:id/refresh', 'location', async (ctx) => {
      if (!getJob(ctx.params.id, ctx.locationId)) throw notFound('Job nicht gefunden');
      await refreshJob(ctx.params.id);
      return jobOut(getJob(ctx.params.id), true);
    });
    router.post('/api/video-studio/jobs/:id/confirm', 'location', async (ctx) => {
      const j = getJob(ctx.params.id, ctx.locationId);
      if (!j) throw notFound('Job nicht gefunden');
      if (j.status !== 'confirm') throw bad('Keine Rückfrage offen');
      const source = j.source_type === 'url' ? { url: j.source_url } : null;
      if (!source) throw bad('Nur Link-Jobs fragen nach');
      setJob(j.id, { status: 'submitting', stage: 'Wird gestartet' });
      try {
        await submit(getJob(j.id), source, true);
      } catch (e) {
        fail(j, (e as Error).message);
        throw e;
      }
      return jobOut(getJob(j.id), true);
    });
    router.delete('/api/video-studio/jobs/:id', 'location', (ctx) => {
      const j = getJob(ctx.params.id, ctx.locationId);
      if (!j) throw notFound('Job nicht gefunden');
      const up = j.upload_id && db.get('SELECT * FROM video_uploads WHERE id = ?', j.upload_id);
      if (up) {
        rmSync(join(dir, up.file), { force: true });
        db.run('DELETE FROM video_uploads WHERE id = ?', up.id);
      }
      db.run('DELETE FROM video_jobs WHERE id = ?', j.id);
      return { ok: true };
    });

    // Chunked uploads (8 MB parts): robust behind proxies, never the whole file in memory.
    const prevLimit = app.services.rawBodyLimit;
    app.services.rawBodyLimit = (method: string, path: string, req: any, cookies: Record<string, string>): number | undefined =>
      method === 'PUT' && /^\/api\/video-studio\/uploads\/[A-Za-z0-9]{8,32}$/.test(path) && (cookies.pghl_session || req.headers.authorization) ? CHUNK + 4096 : prevLimit?.(method, path, req, cookies);

    router.post('/api/video-studio/uploads', 'location', (ctx) => {
      cfgOrFail();
      const name = str(ctx.body.name, 'Dateiname', { required: true, max: 200 });
      const size = Math.round(Number(ctx.body.size));
      if (!VIDEO_EXT.includes(ext(name))) throw bad(`Nur Videodateien (${VIDEO_EXT.join(', ')})`);
      if (!(size > 0)) throw bad('Dateigröße fehlt');
      if (size > maxUploadMb() * 1024 * 1024) throw bad(`Datei größer als ${maxUploadMb()} MB`);
      if (Number(db.get(`SELECT COUNT(*) n FROM video_uploads WHERE location_id = ? AND status = 'open'`, ctx.locationId)?.n ?? 0) >= 3) throw new HttpError(429, 'Es laufen schon 3 Uploads – bitte warten');
      mkdirSync(dir, { recursive: true });
      try {
        const fs = statfsSync(dir);
        if (fs.bavail * fs.bsize < size * 1.1 + 512 * 1024 * 1024) throw new HttpError(507, 'Nicht genug freier Speicher auf dem Server für diese Datei');
      } catch (e) {
        if (e instanceof HttpError) throw e;
      }
      const row = { id: id(), location_id: ctx.locationId, name, file: `${id(20)}${ext(name)}`, size, received: 0, status: 'open', user_id: ctx.user?.id ?? null, created_at: now(), updated_at: now() };
      writeFileSync(join(dir, row.file), '');
      db.insert('video_uploads', row);
      return { id: row.id, chunk_size: CHUNK, size, received: 0 };
    });
    router.put('/api/video-studio/uploads/:id', 'location', (ctx) => {
      const up = db.get('SELECT * FROM video_uploads WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!up) throw notFound('Upload nicht gefunden');
      if (up.status !== 'open') return { id: up.id, received: up.received, complete: up.status !== 'open' };
      const buf = ctx.rawBuffer;
      if (!buf?.length) throw bad('Daten fehlen (Teil der Datei als Rohdaten im Body)');
      if (buf.length > CHUNK) throw bad(`Höchstens ${CHUNK / 1024 / 1024} MB pro Teil`);
      const offset = Number(ctx.query.get('offset') ?? up.received);
      if (offset !== up.received) {
        if (offset + buf.length === up.received) return { id: up.id, received: up.received, complete: false };
        throw new HttpError(409, `Erwartet wird der Teil ab Byte ${up.received}`);
      }
      if (offset + buf.length > up.size) throw bad('Mehr Daten als angekündigt');
      if (offset === 0 && !looksLikeVideo(buf)) {
        rmSync(join(dir, up.file), { force: true });
        db.run('DELETE FROM video_uploads WHERE id = ?', up.id);
        throw bad('Das ist keine Videodatei (MP4, MOV, WebM, MKV, AVI)');
      }
      appendFileSync(join(dir, up.file), buf);
      const received = offset + buf.length;
      const complete = received === up.size;
      db.run('UPDATE video_uploads SET received = ?, status = ?, updated_at = ? WHERE id = ?', received, complete ? 'complete' : 'open', now(), up.id);
      return { id: up.id, received, complete };
    });
    router.delete('/api/video-studio/uploads/:id', 'location', (ctx) => {
      const up = db.get('SELECT * FROM video_uploads WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!up) throw notFound('Upload nicht gefunden');
      if (up.status === 'used') throw bad('Der Upload gehört zu einem Job');
      rmSync(join(dir, up.file), { force: true });
      db.run('DELETE FROM video_uploads WHERE id = ?', up.id);
      return { ok: true };
    });

    // --- clips ----------------------------------------------------------------------------------
    const clipOf = (ctx: Ctx) => {
      const c = db.get(`SELECT * FROM video_clips WHERE id = ? AND location_id = ? AND status = 'ready'`, ctx.params.id, ctx.locationId);
      if (!c) throw notFound('Clip nicht gefunden');
      return c;
    };
    router.get('/api/video-studio/clips/:id/video', 'location', async (ctx) => {
      const c = clipOf(ctx);
      return proxyMedia(c.video_path, ctx.req.headers.range, ctx.query.get('download') ? `${c.title || 'clip'}.mp4` : undefined);
    });
    router.patch('/api/video-studio/clips/:id', 'location', (ctx) => {
      const c = clipOf(ctx);
      const patch: Record<string, unknown> = { edited: 1, updated_at: now() };
      if (ctx.body.title !== undefined) patch.title = str(ctx.body.title, 'Titel', { required: true, max: 200 });
      if (ctx.body.description !== undefined) patch.description = str(ctx.body.description, 'Beschreibung', { max: 5000 });
      if (ctx.body.hashtags !== undefined) {
        const raw = Array.isArray(ctx.body.hashtags) ? ctx.body.hashtags.join(' ') : String(ctx.body.hashtags ?? '');
        patch.hashtags = [...new Set(raw.split(/[\s,]+/).map((t: string) => t.trim().replace(/^#*/, '')).filter(Boolean).map((t: string) => `#${t.toLowerCase()}`))].slice(0, 30);
        if ((patch.hashtags as string[]).some((t) => !/^#[\p{L}\p{N}_]{1,60}$/u.test(t))) throw bad('Hashtags: nur Buchstaben, Ziffern und _');
      }
      db.update('video_clips', c.id, patch);
      return clipOut(db.get('SELECT * FROM video_clips WHERE id = ?', c.id));
    });
    router.delete('/api/video-studio/clips/:id', 'location', (ctx) => {
      const c = clipOf(ctx);
      db.run(`UPDATE video_clips SET status = 'deleted', ops = '[]', updated_at = ? WHERE id = ?`, now(), c.id);
      return { ok: true };
    });
    router.post('/api/video-studio/clips/:id/edit', 'location', (ctx) => {
      const c = clipOf(ctx);
      const job = getJob(c.job_id);
      if (!job || job.kind !== 'clips' || job.status !== 'completed') throw bad('Nur fertige Clips aus Videos lassen sich nachbearbeiten');
      if (c.ops !== '[]') throw new HttpError(409, 'Dieser Clip wird gerade bearbeitet');
      const cfg = cfgOrFail();
      const b = ctx.body ?? {};
      let op: os.ClipOp;
      if (b.op === 'subtitles') {
        if (!(b.preset in os.SUBTITLE_STYLES) || b.preset === 'off') throw bad(`Untertitel-Stil: ${Object.keys(os.SUBTITLE_STYLES).filter((k) => k !== 'off').join(', ')}`);
        if (!features().subtitles) throw bad('Diese OpenShorts-Version kann Untertitel nicht neu setzen');
        op = { op: 'subtitles', preset: b.preset };
      } else if (b.op === 'dub') {
        const lang = String(b.language ?? '').toLowerCase();
        if (!/^[a-z]{2,3}(-[a-z]{2,4})?$/.test(lang)) throw bad('Sprache fehlt');
        if (!cfg.elevenlabsKey || !features().translate) throw bad('Vertonung braucht den ElevenLabs-Schlüssel (Agentur → Integrationen)');
        op = { op: 'dub', language: lang };
      } else if (b.op === 'framing') {
        if (!['full', 'track', 'auto'].includes(b.framing)) throw bad('Bildausschnitt: full, track oder auto');
        if (!features().rerender) throw bad('Diese OpenShorts-Version kann den Bildausschnitt nicht ändern');
        op = { op: 'framing', framing: b.framing };
      } else throw bad('Aktion: subtitles, dub oder framing');
      const ops: os.ClipOp[] = [op];
      // Dubbing replaces the audio: put the captions back on in the new language.
      if (op.op === 'dub' && b.subtitles && b.subtitles in os.SUBTITLE_STYLES && b.subtitles !== 'off') ops.push({ op: 'subtitles', preset: b.subtitles });
      db.run(`UPDATE video_clips SET ops = ?, op_status = 'pending', op_error = NULL, updated_at = ? WHERE id = ?`, JSON.stringify(ops), now(), c.id);
      bg('ops', runOps);
      return clipOut(db.get('SELECT * FROM video_clips WHERE id = ?', c.id));
    });

    const captionOf = (c: any, override?: unknown) => {
      const custom = String(override ?? '').trim();
      if (custom) return custom;
      const tags: string[] = JSON.parse(c.hashtags || '[]');
      return [c.description || c.title, tags.join(' ')].filter(Boolean).join('\n\n').trim();
    };
    /** Puts a clip into the Social Planner (also used by the autopilot): video by signed link, bookkeeping for reports. */
    const scheduleClip = async (loc: string, clipId: string, input: { integration_ids?: unknown; type?: unknown; date?: unknown; caption?: unknown; title?: unknown; userId?: string | null; source?: string }) => {
      const c = db.get(`SELECT * FROM video_clips WHERE id = ? AND location_id = ? AND status = 'ready'`, clipId, loc);
      if (!c) throw notFound('Clip nicht gefunden');
      if (!app.services.socialPost) throw new HttpError(409, 'Der Social Planner ist nicht installiert');
      if (!isPublicBase(app.baseUrl())) throw bad('HyperLevel muss öffentlich per https erreichbar sein, damit Postiz den Clip abholen kann');
      if (c.ops !== '[]') throw new HttpError(409, 'Der Clip wird gerade nachbearbeitet – bitte kurz warten');
      const ids = Array.isArray(input.integration_ids) ? input.integration_ids.map(String) : [];
      const type = ['now', 'schedule', 'draft'].includes(String(input.type)) ? String(input.type) : 'schedule';
      const content = captionOf(c, input.caption);
      if (content.length > 63_000) throw bad('Text ist zu lang');
      const post = await app.services.socialPost(loc, {
        integrationIds: ids,
        content,
        type,
        date: input.date,
        mediaUrls: [mediaUrl(c.id)],
        video: true,
        title: str(input.title, 'Titel', { max: 100 }) || c.title,
        userId: input.userId ?? undefined,
        source: input.source ?? 'Video-Studio',
      });
      const row = { id: id(), clip_id: c.id, location_id: loc, social_post_id: post?.id ?? null, channels: ids.length, type, publish_at: post?.publish_at ?? now(), user_id: input.userId ?? null, created_at: now() };
      db.insert('video_posts', row);
      db.run('UPDATE video_clips SET planned = planned + 1, planned_at = ?, updated_at = ? WHERE id = ?', row.publish_at, now(), c.id);
      return { ok: true, post, clip: clipOut(db.get('SELECT * FROM video_clips WHERE id = ?', c.id)) };
    };
    router.post('/api/video-studio/clips/:id/schedule', 'location', async (ctx) => {
      const c = clipOf(ctx);
      return scheduleClip(ctx.locationId, c.id, { ...ctx.body, userId: ctx.user?.id ?? null });
    });
    router.post('/api/video-studio/clips/:id/doc', 'location', (ctx) => {
      const c = clipOf(ctx);
      if (!app.services.saveDocs) throw new HttpError(409, 'Das Dokumente-Modul ist nicht installiert');
      if (!app.baseUrl().startsWith('https://')) throw bad('Dokumente brauchen eine https-Adresse von HyperLevel (PGHL_BASE_URL)');
      const tags: string[] = JSON.parse(c.hashtags || '[]');
      const summary = [c.description, tags.join(' '), c.score !== null ? `Viralität: ${c.score}/100${c.reason ? ` – ${c.reason}` : ''}` : '', c.duration ? `Länge: ${Math.round(c.duration)} s` : ''].filter(Boolean).join('\n').slice(0, 2000);
      const url = `${app.baseUrl()}/app/video-studio/${c.job_id}?clip=${c.id}`;
      app.services.saveDocs([{ url, title: `Short: ${c.title}`.slice(0, 300), kind: 'doc', source: 'Video-Studio', summary, location_id: ctx.locationId }], { force: true });
      db.run('UPDATE video_clips SET doc_saved = 1, updated_at = ? WHERE id = ?', now(), c.id);
      return { ok: true, url };
    });

    // --- public: webhook, signed media for Postiz, signed source for OpenShorts ------------------
    router.post('/hooks/openshorts/:token', 'public', async (ctx) => {
      const tok = String(ctx.params.token);
      if (!/^[\w-]{20,64}$/.test(tok)) throw notFound();
      const job = getJob(db.get('SELECT id FROM video_jobs WHERE hook_hash = ?', sha256(tok))?.id ?? '');
      if (!job) throw notFound();
      const h = hookOf(job);
      if (!h || !os.verifySignature(h.secret, ctx.rawBody, ctx.req.headers['x-openshorts-signature'])) throw new HttpError(401, 'Signatur ungültig');
      const body = ctx.body ?? {};
      if (body.job_id && job.os_job_id && String(body.job_id) !== job.os_job_id) throw bad('Falscher Job');
      setJob(job.id, { webhook_at: now() });
      if (TERMINAL.includes(job.status) || job.status === 'finishing') return { ok: true };
      try {
        await refreshJob(job.id);
      } catch (e) {
        console.error('[video-studio] webhook refresh', (e as Error).message);
      }
      // OpenShorts says it failed but the status call did not get through: trust the signed message.
      const after = getJob(job.id);
      if (body.event === 'job.failed' && after && !TERMINAL.includes(after.status)) fail(after, String(body.error ?? 'OpenShorts meldet einen Fehler').slice(-300));
      return { ok: true };
    });
    router.get('/hooks/openshorts/media/:token', 'public', async (ctx) => {
      const m = /^([A-Za-z0-9]{8,32})\.(\d{9,11})\.([\w-]{32})\.mp4$/.exec(String(ctx.params.token));
      if (!m || !verify('media', m[1], Number(m[2]), m[3])) throw notFound();
      const c = db.get(`SELECT * FROM video_clips WHERE id = ? AND status = 'ready'`, m[1]);
      if (!c) throw notFound();
      return proxyMedia(c.video_path, ctx.req.headers.range);
    });
    router.get('/hooks/openshorts/source/:token', 'public', (ctx) => {
      const m = /^([A-Za-z0-9]{8,32})\.(\d{9,11})\.([\w-]{32})\.[a-z0-9]{2,4}$/.exec(String(ctx.params.token));
      if (!m || !verify('source', m[1], Number(m[2]), m[3])) throw notFound();
      const up = db.get(`SELECT * FROM video_uploads WHERE id = ? AND status = 'used'`, m[1]);
      const path = up ? join(dir, up.file) : '';
      if (!up || !existsSync(path)) throw notFound();
      const size = statSync(path).size;
      const range = parseRange(ctx.req.headers.range, size);
      const headers: Record<string, string> = { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'content-disposition': `attachment; filename="video${ext(up.file)}"` };
      if (range) {
        headers['content-range'] = `bytes ${range.start}-${range.end}/${size}`;
        headers['content-length'] = String(range.end - range.start + 1);
        return { __raw: true, status: 206, headers, body: createReadStream(path, range) };
      }
      headers['content-length'] = String(size);
      return { __raw: true, status: 200, headers, body: createReadStream(path) };
    });

    // --- workflows, MCP, reports, catalogue -------------------------------------------------------
    app.services.workflowTriggers = [...(app.services.workflowTriggers ?? []), 'shorts.ready'];
    app.services.workflowActions = {
      ...(app.services.workflowActions ?? {}),
      shorts_create: async (run: any, step: any, vars: Record<string, any>) => {
        const url = render(String(step.url ?? ''), vars).trim();
        if (!url) throw new Error('Video-Link fehlt (z. B. {{contact.custom.video_url}})');
        const job = await createJob(run.location_id, {
          url,
          title: render(String(step.title ?? ''), vars).trim().slice(0, 200),
          options: { clips: step.clips || undefined, layout: step.layout || undefined, subtitles: step.subtitles || undefined, hook: step.hook !== false, dub_language: step.dub_language || undefined },
          contact_id: run.contact_id,
          origin: 'Workflow',
        });
        return `Shorts-Job gestartet (${job.title})`;
      },
    };
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    app.services.reportSources = [...(app.services.reportSources ?? []), ...REPORT_SOURCES];
    const catalog: CatalogExtra = {
      entry: {
        key: 'openshorts',
        name: 'OpenShorts (Video-Studio)',
        category: 'Marketing',
        icon: 'studio',
        scope: 'agency',
        setup: { agency: 'agency/integrations' },
        description: 'Lange Videos → KI-gewählte 9:16-Shorts mit Untertiteln, Review im Video-Studio und Planung im Social Planner.',
        credentials: 'Adresse der eigenen OpenShorts-Instanz (z. B. http://openshorts:8000) oder https://api.openshorts.app mit API-Schlüssel (osk_…) unter Agentur → Integrationen → Einrichtung. Gemini bzw. LLM_BASE_URL stehen in der OpenShorts-Umgebung; ElevenLabs/fal.ai optional hier.',
        docs: 'docs/video-studio.md',
        guide: [
          'OpenShorts neben HyperLevel starten: deploy/openshorts/docker-compose.yml (CPU, 1 Job gleichzeitig, Speicher begrenzt) – oder ein Konto auf openshorts.app anlegen.',
          'In der OpenShorts-Umgebung GEMINI_API_KEY setzen (kostenlos bei Google AI Studio) oder LLM_BASE_URL auf einen OpenAI-kompatiblen Server.',
          'Agentur → Integrationen → Einrichtung → OpenShorts: Adresse (selbst gehostet z. B. http://openshorts:8000) und ggf. API-Schlüssel eintragen, „Verbindung testen“.',
          'Im Sub-Account Marketing → Video-Studio: Link einfügen oder Video hochladen, Clips prüfen und im Social Planner einplanen.',
        ],
      },
      agency: () => {
        const c = config();
        if (!c) return { status: 'missing', detail: 'Keine OpenShorts-Adresse' };
        const s = stored();
        if (s.error) return { status: 'partial', detail: `Fehler: ${s.error.slice(0, 80)}` };
        if (!s.info) return { status: 'partial', detail: 'Gespeichert – Verbindung noch nicht getestet' };
        return { status: 'ok', detail: s.info.mode === 'hosted' ? `openshorts.app${s.info.plan ? ` · Tarif ${s.info.plan}` : ''}` : 'Selbst gehostet' };
      },
    };
    app.services.catalogExtra = [...(app.services.catalogExtra ?? []), catalog];
  },
};

// --- MCP tools ------------------------------------------------------------------------------------
const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const TOOLS: Tool[] = [
  {
    name: 'ghl_create_shorts',
    title: 'Shorts aus Video erstellen',
    description:
      'Startet im Video-Studio einen Job: OpenShorts schneidet aus einem langen Video (YouTube-Link oder direkte Videodatei-URL) KI-gewählte 9:16-Clips mit Untertiteln, Titel, Beschreibung und Hashtags. Dauert Minuten – Status und Clips mit ghl_list_shorts_jobs, einplanen mit ghl_schedule_clip. Nur Videos, an denen der Kunde die Rechte hat.',
    inputSchema: {
      type: 'object',
      properties: {
        ...LOC,
        url: { type: 'string', description: 'Link zum Video (YouTube oder direkte MP4-URL)' },
        title: { type: 'string' },
        clips: { type: 'integer', minimum: 1, maximum: 15, description: 'Ziel-Anzahl Clips (Standard: die KI entscheidet)' },
        layout: { type: 'string', enum: Object.keys(os.LAYOUTS) },
        subtitles: { type: 'string', enum: Object.keys(os.SUBTITLE_STYLES) },
        hook: { type: 'boolean', description: 'KI-Hook-Text in den ersten Sekunden einblenden (Standard true)' },
        dub_language: { type: 'string', description: 'Optional: Sprachcode für KI-Vertonung (braucht ElevenLabs)' },
        contact_id: { type: 'string', description: 'Optional: Kontakt, für den der Auslöser „Shorts fertig“ läuft' },
      },
      required: ['location_id', 'url'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: (call, a) => call.api('POST', '/api/video-studio/jobs', { location: a.location_id, body: { url: a.url, title: a.title, contact_id: a.contact_id, options: { clips: a.clips, layout: a.layout, subtitles: a.subtitles, hook: a.hook, dub_language: a.dub_language } } }),
  },
  {
    name: 'ghl_list_shorts_jobs',
    title: 'Video-Studio: Jobs und Clips',
    description: 'Shorts-Jobs eines Projekts mit Status/Fortschritt; mit job_id die Clips eines Jobs (id, Titel, Beschreibung, Hashtags, Viralität 0–100, Länge).',
    inputSchema: { type: 'object', properties: { ...LOC, job_id: { type: 'string' }, status: { type: 'string', enum: ['active', 'completed', 'failed', 'confirm'] } }, required: ['location_id'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call, a) => {
      const slim = (c: any) => ({ id: c.id, title: c.title, description: c.description, hashtags: c.hashtags, score: c.score, reason: c.reason, duration: c.duration, planned: c.planned });
      if (a.job_id) {
        const j = await call.api('GET', `/api/video-studio/jobs/${encodeURIComponent(a.job_id)}`, { location: a.location_id });
        return { id: j.id, title: j.title, status: j.status, progress: j.progress, stage: j.stage, error: j.error, clips: (j.clips ?? []).map(slim) };
      }
      const list: any[] = await call.api('GET', `/api/video-studio/jobs${a.status ? `?status=${encodeURIComponent(a.status)}` : ''}`, { location: a.location_id });
      return list.map((j) => ({ id: j.id, title: j.title, status: j.status, progress: j.progress, stage: j.stage, error: j.error, clips: j.clips_count, best_score: j.best_score, created_at: j.created_at }));
    },
  },
  {
    name: 'ghl_schedule_clip',
    title: 'Clip im Social Planner einplanen',
    description:
      'Plant einen Clip (id aus ghl_list_shorts_jobs) auf Kanälen des Projekts ein (IDs aus ghl_list_social_channels; YouTube/TikTok gehen hier auch). type: draft (Standard), schedule (braucht date als ISO-Zeit) oder now. caption ersetzt Beschreibung + Hashtags.',
    inputSchema: {
      type: 'object',
      properties: { ...LOC, clip_id: { type: 'string' }, integration_ids: { type: 'array', items: { type: 'string' }, minItems: 1 }, type: { type: 'string', enum: ['draft', 'schedule', 'now'] }, date: { type: 'string' }, caption: { type: 'string' }, title: { type: 'string' } },
      required: ['location_id', 'clip_id', 'integration_ids'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: (call, a) => call.api('POST', `/api/video-studio/clips/${encodeURIComponent(a.clip_id)}/schedule`, { location: a.location_id, body: { integration_ids: a.integration_ids, type: a.type ?? 'draft', date: a.date, caption: a.caption, title: a.title } }),
  },
];

// --- report sources ---------------------------------------------------------------------------------
const yesNo = { 1: 'Ja', 0: 'Nein' };
const jobContact = contactJoin('j.contact_id');
const REPORT_SOURCES: ReportSource[] = [
  {
    key: 'video_jobs',
    label: 'Video-Studio: Jobs',
    area: 'social',
    from: 'video_jobs j',
    location: 'j.location_id',
    dateField: 'created_at',
    requires: ['video_jobs'],
    countLabel: 'Anzahl Jobs',
    joins: jobContact.joins,
    fields: [
      { key: 'created_at', label: 'Erstellt am', type: 'date', sql: 'j.created_at' },
      { key: 'completed_at', label: 'Fertig am', type: 'date', sql: 'j.completed_at' },
      { key: 'status', label: 'Status', type: 'enum', sql: 'j.status', options: JOB_STATUS },
      { key: 'source_type', label: 'Quelle', type: 'enum', sql: 'j.source_type', options: { url: 'Link', upload: 'Datei', ugc: 'KI-Short' } },
      { key: 'origin', label: 'Gestartet über', type: 'string', sql: 'j.origin' },
      { key: 'clips', label: 'Clips', type: 'number', sql: `(SELECT COUNT(*) FROM video_clips c WHERE c.job_id = j.id AND c.status = 'ready')`, format: 'number' },
      { key: 'minutes', label: 'Dauer bis fertig', type: 'number', sql: '((julianday(j.completed_at) - julianday(j.created_at)) * 1440)', format: 'minutes' },
      ...jobContact.fields,
    ],
    calcs: [{ key: 'success_rate', label: 'Erfolgsquote', sql: `100.0 * SUM(j.status = 'completed') / NULLIF(SUM(j.status IN ('completed','failed')), 0)`, format: 'percent' }],
  },
  {
    key: 'video_clips',
    label: 'Video-Studio: Clips',
    area: 'social',
    from: 'video_clips c',
    location: 'c.location_id',
    where: `c.status = 'ready'`,
    dateField: 'created_at',
    requires: ['video_clips'],
    countLabel: 'Anzahl Clips',
    fields: [
      { key: 'created_at', label: 'Erstellt am', type: 'date', sql: 'c.created_at' },
      { key: 'score', label: 'Viralität (0–100)', type: 'number', sql: 'c.score', format: 'number' },
      { key: 'duration', label: 'Länge (Sekunden)', type: 'number', sql: 'c.duration', format: 'number' },
      { key: 'planned', label: 'Eingeplant', type: 'boolean', sql: '(CASE WHEN c.planned > 0 THEN 1 ELSE 0 END)', options: yesNo },
      { key: 'planned_at', label: 'Veröffentlichung', type: 'date', sql: 'c.planned_at' },
      { key: 'edited', label: 'Text bearbeitet', type: 'boolean', sql: '(CASE WHEN c.edited > 0 THEN 1 ELSE 0 END)', options: yesNo },
      { key: 'doc_saved', label: 'Als Dokument gespeichert', type: 'boolean', sql: '(CASE WHEN c.doc_saved > 0 THEN 1 ELSE 0 END)', options: yesNo },
      { key: 'title', label: 'Titel', type: 'string', sql: 'c.title', noGroup: true },
    ],
    calcs: [{ key: 'planned_rate', label: 'Anteil eingeplant', sql: '100.0 * SUM(c.planned > 0) / NULLIF(COUNT(*), 0)', format: 'percent' }],
  },
  {
    key: 'video_posts',
    label: 'Video-Studio: Veröffentlichte Clips',
    area: 'social',
    from: 'video_posts p',
    location: 'p.location_id',
    dateField: 'publish_at',
    requires: ['video_posts'],
    countLabel: 'Anzahl Posts',
    fields: [
      { key: 'publish_at', label: 'Veröffentlichung', type: 'date', sql: 'p.publish_at' },
      { key: 'created_at', label: 'Eingeplant am', type: 'date', sql: 'p.created_at' },
      { key: 'type', label: 'Art', type: 'enum', sql: 'p.type', options: { schedule: 'Geplant', now: 'Sofort', draft: 'Entwurf' } },
      { key: 'channels', label: 'Kanäle', type: 'number', sql: 'p.channels', format: 'number' },
      { key: 'score', label: 'Viralität des Clips', type: 'number', sql: '(SELECT c.score FROM video_clips c WHERE c.id = p.clip_id)', format: 'number' },
    ],
  },
];
