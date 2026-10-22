import { createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { id, now, slugify } from '../core/util.js';
import { bodyLocation, callRoute, checkArea, ownLocation } from '../services/mobile.js';
import { callRoute as relayRoute } from '../services/route-call.js';
import { cleanTemplate } from '../services/genmedia/custom-http.js';
import {
  TERMINAL,
  addToLibrary,
  adapterCtx,
  costText,
  createJob,
  deleteJob,
  genDir,
  getJob,
  handleCallback,
  idle,
  jobOut,
  kick,
  listConnections,
  pollDue,
  processJob,
  publicBase,
  registry,
  resolveConnection,
} from '../services/genmedia/engine.js';
import { adapterFor, catalogue } from '../services/genmedia/index.js';
import { ASPECTS, EXT, MAX_INPUT_BYTES, parseRange, sniff } from '../services/genmedia/media.js';
import { GENMEDIA_TOOLS, workflowActions } from '../services/genmedia/tools.js';
import { BYOK_MISSING, CAPABILITIES, CAPABILITY_LABEL, ProviderError, type Capability } from '../services/genmedia/types.js';

/**
 * KI-Studio: images, video, music, text-to-speech and transcription with the sub-account's own
 * provider keys (BYOK registry `app.services.aiConnections`, owned by the agent module). Jobs run in
 * the background (services/genmedia/engine.ts), one adapter per provider (services/genmedia/*.ts).
 * Hooks for other modules: `app.services.genmedia` ({create, get, process, pollDue, idle}),
 * MCP tools via `mcpTools`, workflow actions via `workflowActions`, trigger `genmedia.completed`.
 */

/** Members need one of these areas (images go into e-mails, funnels, posts, courses). */
const CONTENT_AREAS = ['social', 'funnels', 'campaigns', 'courses'];

export const genmediaModule: Module = {
  name: 'genmedia',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE genmedia_jobs (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, user_id TEXT,
        connection_id TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', capability TEXT NOT NULL,
        input TEXT NOT NULL, status TEXT NOT NULL, provider_state TEXT NOT NULL DEFAULT '{}', progress INTEGER,
        results TEXT NOT NULL DEFAULT '[]', result_text TEXT, cost TEXT, error TEXT NOT NULL DEFAULT '',
        attempts INTEGER NOT NULL DEFAULT 0, polls INTEGER NOT NULL DEFAULT 0, next_run_at TEXT, lease_until TEXT,
        timeout_at TEXT NOT NULL, callback_hash TEXT UNIQUE, webhook_at TEXT, source TEXT NOT NULL DEFAULT 'studio',
        target TEXT, target_result TEXT NOT NULL DEFAULT '', library INTEGER NOT NULL DEFAULT 0, parent_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT
      );
      CREATE INDEX genmedia_jobs_loc ON genmedia_jobs(location_id, created_at);
      CREATE INDEX genmedia_jobs_due ON genmedia_jobs(status, next_run_at);
      CREATE TABLE genmedia_files (
        file TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, job_id TEXT,
        kind TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', mime TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX genmedia_files_job ON genmedia_files(job_id);
      CREATE TABLE genmedia_templates (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, name TEXT NOT NULL,
        capability TEXT NOT NULL, config TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;

    app.services.genmedia = {
      create: (input: Parameters<typeof createJob>[1]) => createJob(app, input).then((j) => (kick(app, j.id), j)),
      get: (jobId: string) => getJob(app, jobId),
      out: (job: any) => jobOut(app, job),
      process: (jobId: string) => processJob(app, jobId),
      pollDue: () => pollDue(app),
      idle,
    };
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...GENMEDIA_TOOLS];
    app.services.workflowActions = { ...(app.services.workflowActions ?? {}), ...workflowActions(app) };
    app.services.workflowTriggers = [...(app.services.workflowTriggers ?? []), 'genmedia.completed'];
    app.onTick(() => pollDue(app));

    app.guards.push((ctx) => {
      if (!ctx.path.startsWith('/api/genmedia')) return;
      const u = ctx.user;
      if (u?.role === 'admin') return;
      if (u?.permissions && !CONTENT_AREAS.some((a) => u.permissions!.includes(a))) throw new HttpError(403, 'Kein Zugriff auf das KI-Studio');
      // SaaS plan: closed when the plan leaves out every content area.
      const blocked = app.services.saasAreaBlocked as ((loc: string, area: string) => boolean) | undefined;
      if (ctx.locationId && blocked && CONTENT_AREAS.every((a) => blocked(ctx.locationId, a))) throw new HttpError(403, 'Das KI-Studio ist in diesem Tarif nicht enthalten');
    });

    // Reference/audio inputs are only needed while their jobs run: drop them after 30 days.
    let lastSweep = 0;
    app.onTick(() => {
      if (Date.now() - lastSweep < 3600_000) return;
      lastSweep = Date.now();
      const old = db.all(`SELECT file FROM genmedia_files WHERE kind = 'input' AND created_at < ?`, new Date(Date.now() - 30 * 864e5).toISOString());
      for (const f of old) {
        rmSync(join(genDir(app), f.file), { force: true });
        db.run('DELETE FROM genmedia_files WHERE file = ?', f.file);
      }
    });

    const mine = (ctx: Ctx) => {
      const job = getJob(app, ctx.params.id);
      if (!job || job.location_id !== ctx.locationId) throw notFound('Auftrag nicht gefunden');
      return job;
    };
    const asBad = async <T>(fn: () => Promise<T> | T): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof ProviderError) throw new HttpError(e.retryable ? 502 : 400, e.message);
        throw e;
      }
    };

    // --- catalogue & connections ------------------------------------------------------------------
    router.get('/api/genmedia/meta', 'location', async (ctx) => {
      const reg = registry(app);
      const connections = reg ? await listConnections(app, ctx.locationId) : [];
      return {
        available: !!reg,
        message: !reg || !connections.length ? BYOK_MISSING : null,
        connections,
        providers: catalogue(),
        capabilities: CAPABILITIES.map((c) => ({ id: c, label: CAPABILITY_LABEL[c] })),
        aspects: ASPECTS,
        callbacks: publicBase(app.baseUrl()),
        templates: db.all('SELECT id, name, capability, updated_at FROM genmedia_templates WHERE location_id = ? ORDER BY name', ctx.locationId),
      };
    });
    router.get('/api/genmedia/connections', 'location', async (ctx) => {
      const cap = String(ctx.query.get('capability') ?? '') as Capability;
      if (!registry(app)) return { available: false, message: BYOK_MISSING, connections: [] };
      const connections = await listConnections(app, ctx.locationId, CAPABILITIES.includes(cap) ? cap : undefined);
      return { available: true, message: connections.length ? null : BYOK_MISSING, connections };
    });

    const voiceCache = new Map<string, { at: number; list: any[] }>();
    router.get('/api/genmedia/voices', 'location', async (ctx) => {
      const connId = String(ctx.query.get('connection_id') ?? '') || null;
      const conn = await resolveConnection(app, ctx.locationId, 'audio_tts', connId);
      const adapter = adapterFor(conn.provider);
      if (!adapter.voices) return { voices: [], free_text: true };
      const key = `${ctx.locationId}:${conn.connectionId}`;
      const hit = voiceCache.get(key);
      if (hit && Date.now() - hit.at < 10 * 60_000) return { voices: hit.list, free_text: true };
      const list = await asBad(() => adapter.voices!(adapterCtx(app, { model: '', capability: 'audio_tts', input: { prompt: '' } }, conn, null)));
      voiceCache.set(key, { at: Date.now(), list });
      return { voices: list, free_text: true };
    });

    // --- jobs -----------------------------------------------------------------------------------------
    router.get('/api/genmedia/jobs', 'location', (ctx) => {
      const cap = String(ctx.query.get('capability') ?? '');
      const status = String(ctx.query.get('status') ?? '');
      const limit = Math.max(1, Math.min(100, Number(ctx.query.get('limit')) || 40));
      const before = String(ctx.query.get('before') ?? '');
      const where = ['location_id = ?'];
      const args: any[] = [ctx.locationId];
      if (cap) {
        where.push('capability = ?');
        args.push(cap);
      }
      if (status === 'active') where.push(`status IN ('queued','running')`);
      else if (status) {
        where.push('status = ?');
        args.push(status);
      }
      if (before) {
        where.push('created_at < ?');
        args.push(before);
      }
      const rows = db.all(`SELECT * FROM genmedia_jobs WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`, ...args, limit);
      return rows.map((r) => jobOut(app, getJob(app, r.id)));
    });
    router.post('/api/genmedia/jobs', 'location', async (ctx) => {
      const job = await asBad(() => createJob(app, { locationId: ctx.locationId, userId: ctx.user?.id ?? null, body: ctx.body ?? {}, source: ctx.body?.source ?? (ctx.viaApiKey ? 'api' : 'studio') }));
      kick(app, job.id);
      return jobOut(app, job);
    });
    router.get('/api/genmedia/jobs/:id', 'location', (ctx) => {
      const j = jobOut(app, mine(ctx));
      return { ...j, cost_text: costText(j.cost) };
    });
    router.post('/api/genmedia/jobs/:id/rerun', 'location', async (ctx) => {
      const old = mine(ctx);
      const i = old.input ?? {};
      const body: Record<string, any> = {
        capability: old.capability,
        connection_id: old.connection_id,
        model: old.model,
        prompt: ctx.body?.prompt ?? i.prompt,
        negative_prompt: i.negative_prompt,
        aspect_ratio: i.aspect_ratio,
        duration: i.duration,
        voice: i.voice,
        language: i.language,
        params: i.params,
        kie_task: i.kie_task,
        template_id: i.template_id,
        parent_id: old.id,
        // A variation gets a new random seed; a plain re-run keeps the old one.
        seed: ctx.body?.variation ? Math.floor(Math.random() * 2 ** 31) : i.seed,
        image_url: i.image?.url,
        audio_url: i.audio?.url,
      };
      const job = await asBad(() => createJob(app, { locationId: ctx.locationId, userId: ctx.user?.id ?? null, body, source: old.source === 'workflow' ? 'studio' : old.source }));
      kick(app, job.id);
      return jobOut(app, job);
    });
    router.post('/api/genmedia/jobs/:id/cancel', 'location', async (ctx) => {
      const job = mine(ctx);
      if (TERMINAL.includes(job.status)) return jobOut(app, job);
      db.run(`UPDATE genmedia_jobs SET status = 'canceled', error = 'Abgebrochen', finished_at = ?, updated_at = ?, next_run_at = NULL WHERE id = ?`, now(), now(), job.id);
      try {
        const conn = await resolveConnection(app, job.location_id, job.capability, job.connection_id);
        const adapter = adapterFor(conn.provider);
        if (adapter.cancel && Object.keys(job.provider_state ?? {}).length) await adapter.cancel(adapterCtx(app, job, conn, null), job.provider_state);
      } catch {
        /* best effort */
      }
      return jobOut(app, getJob(app, job.id));
    });
    router.delete('/api/genmedia/jobs/:id', 'location', (ctx) => {
      const job = mine(ctx);
      if (!TERMINAL.includes(job.status)) throw bad('Läuft noch – bitte erst abbrechen');
      deleteJob(app, job);
      return { ok: true };
    });
    router.post('/api/genmedia/jobs/:id/library', 'location', (ctx) => {
      const job = mine(ctx);
      if (job.status !== 'succeeded' || !(job.results ?? []).length) throw bad('Kein fertiges Ergebnis');
      const index = ctx.body?.index !== undefined && ctx.body.index !== null ? Number(ctx.body.index) : undefined;
      if (index !== undefined && !(index >= 0 && index < job.results.length)) throw bad('Ergebnis nicht gefunden');
      return { uploads: addToLibrary(app, job, index) };
    });
    router.post('/api/genmedia/jobs/:id/social', 'location', async (ctx) => {
      const job = mine(ctx);
      if (job.status !== 'succeeded') throw bad('Kein fertiges Ergebnis');
      if (!['image', 'video'].includes(job.capability)) throw bad('Nur Bilder und Videos können in einen Social-Post');
      const content = str(ctx.body?.content, 'Text', { required: true, max: 63_000 });
      const ids = Array.isArray(ctx.body?.integration_ids) ? ctx.body.integration_ids.map(String) : [];
      const type = ['draft', 'now', 'schedule'].includes(ctx.body?.type) ? ctx.body.type : 'draft';
      const uploads = addToLibrary(app, job, ctx.body?.index !== undefined ? Number(ctx.body.index) : undefined);
      if (job.capability === 'image') {
        // Images go through the regular route (rights, SaaS plan, audit log of the social planner).
        return relayRoute(app, ctx, 'POST', '/api/social/posts', { integration_ids: ids, content, type, date: ctx.body?.date, upload_ids: uploads.filter((u) => u.mime.startsWith('image/')).slice(0, 4).map((u) => u.id) });
      }
      if (ctx.user) checkArea(app, ctx, ctx.locationId, 'social', 'POST');
      if (!app.services.socialPost) throw new HttpError(409, 'Social Planner ist nicht verfügbar');
      return app.services.socialPost(ctx.locationId, { integrationIds: ids, content, type, date: ctx.body?.date, mediaUrls: uploads.map((u) => u.url).slice(0, 1), video: true, title: str(ctx.body?.title, 'Titel', { max: 100 }), userId: ctx.user?.id, source: 'KI-Studio' });
    });

    // --- input files (reference images, audio for transcription) -------------------------------------
    const prevLimit = app.services.rawBodyLimit;
    app.services.rawBodyLimit = (method: string, path: string, req: any, cookies: Record<string, string>): number | undefined =>
      method === 'POST' && path === '/api/genmedia/inputs' && (cookies.pghl_session || req.headers.authorization) ? MAX_INPUT_BYTES + 1024 : prevLimit?.(method, path, req, cookies);
    router.post('/api/genmedia/inputs', 'location', (ctx) => {
      let buf = ctx.rawBuffer;
      let name = String(ctx.query.get('name') ?? '').trim();
      // Small files may come as JSON {name, data: "data:…;base64,…"} (API, app).
      if (!buf?.length && typeof ctx.body?.data === 'string') {
        const m = /^data:[\w/+.-]+;base64,(.+)$/s.exec(ctx.body.data);
        if (!m) throw bad('Erwarte Rohdaten oder eine data:-URL');
        buf = Buffer.from(m[1], 'base64');
        name = String(ctx.body.name ?? name);
      }
      if (!buf?.length) throw bad('Datei fehlt');
      if (buf.length > MAX_INPUT_BYTES) throw bad(`Datei größer als ${MAX_INPUT_BYTES / 1024 / 1024} MB`);
      const mime = sniff(buf, String(ctx.req.headers['content-type'] ?? ''));
      if (!mime) throw bad('Nur Bilder (PNG, JPG, WebP, GIF), Audio (MP3, WAV, M4A, OGG, FLAC) oder Video (MP4, MOV, WebM)');
      const dir = genDir(app);
      mkdirSync(dir, { recursive: true });
      const file = `${id(24)}${EXT[mime] ?? ''}`;
      writeFileSync(join(dir, file), buf);
      const clean = (name || `datei${EXT[mime] ?? ''}`).replace(/[^\w.\- äöüÄÖÜß]+/g, '_').slice(0, 120);
      db.insert('genmedia_files', { file, location_id: ctx.locationId, job_id: null, kind: 'input', name: clean, mime, size: buf.length, created_at: now() });
      return { file, name: clean, mime, size: buf.length, url: `${app.baseUrl()}/genmedia/f/${file}` };
    });

    // --- custom HTTP templates ("Eigene Anbieter") ----------------------------------------------------
    const tplOut = (r: any) => ({ id: r.id, name: r.name, capability: r.capability, config: JSON.parse(r.config), created_at: r.created_at, updated_at: r.updated_at });
    const tplBody = (ctx: Ctx) => {
      const name = str(ctx.body?.name, 'Name', { required: true, max: 100 });
      const capability = String(ctx.body?.capability ?? '') as Capability;
      if (!CAPABILITIES.includes(capability)) throw bad('Art fehlt');
      try {
        return { name, capability, config: cleanTemplate(ctx.body?.config) };
      } catch (e) {
        if (e instanceof ProviderError) throw bad(e.message);
        throw e;
      }
    };
    router.get('/api/genmedia/templates', 'location', (ctx) => db.all('SELECT * FROM genmedia_templates WHERE location_id = ? ORDER BY name', ctx.locationId).map(tplOut));
    router.post('/api/genmedia/templates', 'location', (ctx) => {
      if (Number(db.get('SELECT COUNT(*) n FROM genmedia_templates WHERE location_id = ?', ctx.locationId)?.n ?? 0) >= 50) throw bad('Höchstens 50 Vorlagen');
      const row = { id: id(), location_id: ctx.locationId, ...tplBody(ctx), created_at: now(), updated_at: now() };
      db.insert('genmedia_templates', row);
      return tplOut(db.get('SELECT * FROM genmedia_templates WHERE id = ?', row.id));
    });
    router.put('/api/genmedia/templates/:id', 'location', (ctx) => {
      if (!db.update('genmedia_templates', ctx.params.id, { ...tplBody(ctx), updated_at: now() }, ctx.locationId)) throw notFound('Vorlage nicht gefunden');
      return tplOut(db.get('SELECT * FROM genmedia_templates WHERE id = ?', ctx.params.id));
    });
    router.delete('/api/genmedia/templates/:id', 'location', (ctx) => {
      if (!db.run('DELETE FROM genmedia_templates WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId).changes) throw notFound('Vorlage nicht gefunden');
      return { ok: true };
    });

    // --- public: provider callbacks and the stored files -----------------------------------------------
    router.post('/hooks/genmedia/:token', 'public', async (ctx) => {
      try {
        return await handleCallback(app, String(ctx.params.token), { headers: ctx.req.headers as any, rawBody: ctx.rawBody, body: ctx.body });
      } catch (e) {
        if (e instanceof HttpError) throw e;
        console.error('[genmedia] callback', (e as Error).message);
        return { ok: true };
      }
    });
    router.get('/genmedia/f/:file', 'public', (ctx) => {
      const f = String(ctx.params.file);
      if (!/^[A-Za-z0-9]{16,40}\.[a-z0-9]{2,5}$/.test(f)) throw notFound();
      const row = db.get('SELECT * FROM genmedia_files WHERE file = ?', f);
      const path = row ? join(genDir(app), row.file) : '';
      if (!row || !existsSync(path)) throw notFound();
      const size = statSync(path).size;
      const download = ctx.query.get('download') === '1';
      const headers: Record<string, string> = {
        'content-type': row.mime,
        'accept-ranges': 'bytes',
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'",
        'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${slugify(row.name.replace(/\.[a-z0-9]+$/i, '')) || 'datei'}${EXT[row.mime] ?? ''}"`,
      };
      const range = parseRange(ctx.req.headers.range, size);
      if (range) {
        headers['content-range'] = `bytes ${range.start}-${range.end}/${size}`;
        headers['content-length'] = String(range.end - range.start + 1);
        return { __raw: true, status: 206, headers, body: createReadStream(path, range) };
      }
      headers['content-length'] = String(size);
      return { __raw: true, status: 200, headers, body: createReadStream(path) };
    });

    // --- native app (bearer ghm_…): relays onto the routes above ---------------------------------------
    router.post('/api/mobile/genmedia', 'user', async (ctx) => {
      ctx.skipAfterWrite = true;
      const b = ctx.body ?? {};
      const loc = bodyLocation(app, ctx, b.location_id);
      const { location_id: _l, ...body } = b;
      return callRoute(app, ctx, 'POST', '/api/genmedia/jobs', { locationId: loc.id, body: { ...body, source: 'mobile' } });
    });
    router.get('/api/mobile/genmedia/:id', 'user', async (ctx) => {
      const loc = ownLocation(app, ctx, 'genmedia_jobs', ctx.params.id, 'Auftrag nicht gefunden');
      return callRoute(app, ctx, 'GET', `/api/genmedia/jobs/${encodeURIComponent(ctx.params.id)}`, { locationId: loc.id });
    });
  },
};
