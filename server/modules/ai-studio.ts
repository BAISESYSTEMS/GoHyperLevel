import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Ctx, type RawResult } from '../core/http.js';
import { id, now } from '../core/util.js';
import { chatWithTools, type ChatRequest, type ChatResult } from '../services/agent-llm.js';
import { textCost, type FetchLike, type Resolved } from '../services/ai-presets.js';
import { MAX_VERSIONS, Workspace, buildProject, cleanPath, runTurn, starterFiles, stubChat, type Stack } from '../services/ai-studio.js';
import { budget } from '../services/site-ai-kit.js';
import { buildZip } from '../services/acc-datev.js';

/**
 * AI Studio (docs/ai-studio.md): chat-first builder of static apps and websites per sub-account. Projects, files, the agent turn
 * (BYOK connection of the sub-account, monthly AI limit, usage per turn), a snapshot per turn with restore, the sandboxed build,
 * the preview under a signed path with a sandboxing CSP, and the ZIP export. Test hooks: `aiStudioChat` (replaces the model call,
 * e.g. with `stubChat`), `aiStudioFetch` (HTTP of the model call).
 */

const PREVIEW_TTL_S = 4 * 3600;
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };
const PREVIEW_CSP = "sandbox allow-scripts allow-forms; default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'none'; frame-ancestors 'self'";

const busy = new Set<string>();

export const aiStudioModule: Module = {
  name: 'ai-studio',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE studio_projects (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, stack TEXT NOT NULL DEFAULT 'react', connection_id TEXT NOT NULL DEFAULT '',
        build_status TEXT NOT NULL DEFAULT '', build_log TEXT NOT NULL DEFAULT '', built_at TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cost_micros INTEGER NOT NULL DEFAULT 0,
        created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX studio_projects_loc ON studio_projects(location_id, updated_at);
      CREATE TABLE studio_turns (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, created_by TEXT, prompt TEXT NOT NULL,
        reply TEXT NOT NULL DEFAULT '', tools TEXT NOT NULL DEFAULT '[]', files TEXT NOT NULL DEFAULT '[]', error TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '', thought_ms INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0, cost_micros INTEGER NOT NULL DEFAULT 0, version INTEGER, created_at TEXT NOT NULL
      );
      CREATE INDEX studio_turns_project ON studio_turns(project_id, created_at);
      CREATE TABLE studio_versions (
        project_id TEXT NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        n INTEGER NOT NULL, label TEXT NOT NULL DEFAULT '', files INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, n)
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const ws = (p: { id: string; location_id: string }) => new Workspace(app.config.dataDir, p.location_id, p.id);
    const project = (ctx: Ctx) => {
      const p = db.get<any>('SELECT * FROM studio_projects WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!p) throw notFound('Projekt nicht gefunden');
      return p;
    };

    // --- versions ------------------------------------------------------------------------------------------------
    const snapshot = (p: any, label: string): number => {
      const w = ws(p);
      const map = w.readAll();
      const n = (db.get<{ n: number }>('SELECT COALESCE(MAX(n), 0) AS n FROM studio_versions WHERE project_id = ?', p.id)?.n ?? 0) + 1;
      w.saveVersion(n, map);
      db.insert('studio_versions', { project_id: p.id, location_id: p.location_id, n, label: label.slice(0, 120), files: Object.keys(map).length, bytes: Object.values(map).reduce((s, c) => s + Buffer.byteLength(c), 0), created_at: now() });
      for (const old of db.all<{ n: number }>('SELECT n FROM studio_versions WHERE project_id = ? ORDER BY n DESC LIMIT -1 OFFSET ?', p.id, MAX_VERSIONS)) {
        w.dropVersion(old.n);
        db.run('DELETE FROM studio_versions WHERE project_id = ? AND n = ?', p.id, old.n);
      }
      return n;
    };
    const build = async (p: any) => {
      const r = await buildProject(ws(p), p.stack as Stack);
      db.run('UPDATE studio_projects SET build_status = ?, build_log = ?, built_at = ?, updated_at = ? WHERE id = ?', r.ok ? 'ok' : 'error', [...r.errors, ...r.log].join('\n').slice(0, 8000), now(), now(), p.id);
      return r;
    };

    // --- preview: signed path, sandboxed ---------------------------------------------------------------------------
    const sign = (pid: string, exp: number) => createHmac('sha256', app.config.secret).update(`ai-studio-preview\n${pid}\n${exp}`).digest('base64url').slice(0, 32);
    const previewPath = (pid: string) => {
      const exp = Math.floor(Date.now() / 1000) + PREVIEW_TTL_S;
      return `/studio-preview/${pid}.${exp}.${sign(pid, exp)}/`;
    };
    const servePreview = (ctx: Ctx): RawResult => {
      const [pid, exp, sig] = String(ctx.params.token).split('.');
      const want = pid && exp ? Buffer.from(sign(pid, Number(exp))) : Buffer.alloc(0);
      if (!sig || Number(exp) < Date.now() / 1000 || want.length !== Buffer.from(sig).length || !timingSafeEqual(want, Buffer.from(sig))) throw notFound('Vorschau abgelaufen – bitte neu laden');
      const p = db.get<any>('SELECT id, location_id FROM studio_projects WHERE id = ?', pid);
      if (!p) throw notFound();
      const dist = ws(p).dist;
      const rel = [ctx.params.a, ctx.params.b].filter(Boolean).join('/') || 'index.html';
      let file = normalize(join(dist, rel));
      if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) file = join(dist, 'index.html');
      if (!existsSync(file)) throw notFound('Noch kein Build');
      const type = TYPES[extname(file)] ?? 'application/octet-stream';
      let body: string | Buffer = readFileSync(file);
      if (type.startsWith('text/html')) body = body.toString('utf8').replace(/<head>/i, `<head>\n<base href="/studio-preview/${ctx.params.token}/">`);
      return { __raw: true, status: 200, headers: { 'content-type': type, 'content-security-policy': PREVIEW_CSP, 'cache-control': 'no-store', 'x-frame-options': 'SAMEORIGIN' }, body };
    };
    router.get('/studio-preview/:token', 'public', servePreview);
    router.get('/studio-preview/:token/:a', 'public', servePreview);
    router.get('/studio-preview/:token/:a/:b', 'public', servePreview);

    // --- projects ----------------------------------------------------------------------------------------------------
    const view = (p: any) => ({ ...p, cost_usd: p.cost_micros / 1e6 });
    /** Whether a turn can run: a text connection of the sub-account (or the install) speaking OpenAI or Anthropic, or the test stub. */
    const aiReady = (loc: string) => {
      const r = app.services.aiConnections?.resolve(loc, 'text') as Resolved | null | undefined;
      return !!app.services.aiStudioChat || r?.wire === 'openai' || r?.wire === 'anthropic';
    };
    router.get('/api/ai-studio/setup', 'location', (ctx) => ({ ai_ready: aiReady(ctx.locationId), settings_path: 'settings/ai-providers' }));
    router.get('/api/ai-studio/projects', 'location', (ctx) => db.all('SELECT * FROM studio_projects WHERE location_id = ? ORDER BY updated_at DESC', ctx.locationId).map(view));
    router.post('/api/ai-studio/projects', 'location', async (ctx) => {
      const name = str(ctx.body?.name, 'Name', { required: true, max: 80 });
      const stack: Stack = ctx.body?.stack === 'html' ? 'html' : 'react';
      if ((db.get<{ n: number }>('SELECT COUNT(*) AS n FROM studio_projects WHERE location_id = ?', ctx.locationId)?.n ?? 0) >= 50) throw bad('Höchstens 50 Projekte je Sub-Account.');
      const p = { id: id(), location_id: ctx.locationId, name, stack, connection_id: str(ctx.body?.connection_id, 'Verbindung', { max: 64 }), created_by: ctx.user?.id ?? null, created_at: now(), updated_at: now() };
      db.insert('studio_projects', p);
      ws(p).replaceAll(starterFiles(stack, name));
      snapshot(p, 'Vorlage');
      await build(p);
      return view(db.get('SELECT * FROM studio_projects WHERE id = ?', p.id));
    });
    router.get('/api/ai-studio/projects/:id', 'location', (ctx) => {
      const p = project(ctx);
      const w = ws(p);
      return {
        project: view(p),
        files: w.files(),
        usage: w.usage(),
        turns: db.all('SELECT * FROM studio_turns WHERE project_id = ? ORDER BY created_at', p.id).map((t: any) => ({ ...t, tools: JSON.parse(t.tools), files: JSON.parse(t.files), cost_usd: t.cost_micros / 1e6 })),
        versions: db.all('SELECT n, label, files, bytes, created_at FROM studio_versions WHERE project_id = ? ORDER BY n DESC', p.id),
        preview_url: previewPath(p.id),
        connections: (app.services.aiConnections?.list(ctx.locationId, 'text') ?? []).map((c: any) => ({ id: c.id, label: c.label, model: c.model })),
        budget: budget(app, ctx.locationId),
        ai_ready: aiReady(ctx.locationId),
      };
    });
    router.patch('/api/ai-studio/projects/:id', 'location', (ctx) => {
      const p = project(ctx);
      const name = ctx.body?.name !== undefined ? str(ctx.body.name, 'Name', { required: true, max: 80 }) : p.name;
      const conn = ctx.body?.connection_id !== undefined ? str(ctx.body.connection_id, 'Verbindung', { max: 64 }) : p.connection_id;
      db.run('UPDATE studio_projects SET name = ?, connection_id = ?, updated_at = ? WHERE id = ?', name, conn, now(), p.id);
      return view(db.get('SELECT * FROM studio_projects WHERE id = ?', p.id));
    });
    router.delete('/api/ai-studio/projects/:id', 'location', (ctx) => {
      const p = project(ctx);
      db.run('DELETE FROM studio_projects WHERE id = ?', p.id);
      ws(p).destroy();
      return { ok: true };
    });
    router.get('/api/ai-studio/projects/:id/file', 'location', (ctx) => {
      const p = project(ctx);
      const path = cleanPath(ctx.query.get('path'));
      return { path, content: ws(p).read(path) };
    });
    router.put('/api/ai-studio/projects/:id/file', 'location', (ctx) => {
      const p = project(ctx);
      const bytes = ws(p).write(ctx.body?.path, String(ctx.body?.content ?? ''));
      db.run('UPDATE studio_projects SET updated_at = ? WHERE id = ?', now(), p.id);
      return { ok: true, bytes };
    });
    router.post('/api/ai-studio/projects/:id/build', 'location', async (ctx) => build(project(ctx)));
    router.post('/api/ai-studio/projects/:id/versions/:n/restore', 'location', async (ctx) => {
      const p = project(ctx);
      const n = Number(ctx.params.n);
      if (!db.get('SELECT 1 AS x FROM studio_versions WHERE project_id = ? AND n = ?', p.id, n)) throw notFound('Version nicht gefunden');
      const w = ws(p);
      w.replaceAll(w.loadVersion(n));
      const version = snapshot(p, `Wiederhergestellt: Version ${n}`);
      const b = await build(p);
      return { ok: true, version, build: b };
    });
    router.get('/api/ai-studio/projects/:id/export', 'location', (ctx) => {
      const p = project(ctx);
      const files = Object.entries(ws(p).readAll()).map(([name, c]) => ({ name, data: Buffer.from(c) }));
      const slug = String(p.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
      return { __raw: true, status: 200, headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${slug}.zip"` }, body: buildZip(files) } satisfies RawResult;
    });

    // --- the agent turn ----------------------------------------------------------------------------------------------
    const logCall = (locationId: string, userId: string | null, conn: Resolved, r: ChatResult, cost: number) => {
      if (!conn.connectionId.startsWith('implicit:') && !conn.connectionId.startsWith('stub')) app.services.aiConnections?.recordUsage(conn.connectionId, locationId, r.usage, cost);
      try {
        db.insert('ai_calls', { id: id(), location_id: locationId, purpose: 'ai_studio', model: `${conn.provider}:${r.model}`.slice(0, 120), status: 'ok', ...r.usage, cost_micros: cost, ms: r.ms, contact_id: null, conversation_id: null, user_id: userId, error: '', created_at: now() });
      } catch {
        /* the KI-Assistent is not built in */
      }
    };
    router.post('/api/ai-studio/projects/:id/turns', 'location', async (ctx) => {
      const p = project(ctx);
      const prompt = str(ctx.body?.prompt, 'Nachricht', { required: true, max: 8000 });
      const stub = app.services.aiStudioChat as ((req: ChatRequest) => Promise<ChatResult>) | undefined;
      const resolved: Resolved | null = app.services.aiConnections?.resolve(ctx.locationId, 'text', p.connection_id || undefined) ?? null;
      const target = resolved ?? (stub ? ({ connectionId: 'stub', provider: 'stub', baseUrl: '', apiKey: '', headers: {}, authStyle: 'none', model: 'stub-1', label: 'Stub', wire: 'openai', capabilities: ['text'], options: {} } as unknown as Resolved) : null);
      if (!target || (target.wire !== 'openai' && target.wire !== 'anthropic')) throw new HttpError(409, 'Kein Text-Modell verbunden – bitte unter Einstellungen → KI-Anbieter eine Verbindung (Claude, OpenAI, OpenRouter …) anlegen.');
      if (busy.has(p.id)) throw new HttpError(409, 'In diesem Projekt läuft schon eine Anfrage.');
      busy.add(p.id);
      try {
        const fetchImpl = (app.services.aiStudioFetch as FetchLike | undefined) ?? app.services.aiConnections?.fetchFor(target);
        const history = db.all<{ prompt: string; reply: string }>('SELECT prompt, reply FROM studio_turns WHERE project_id = ? ORDER BY created_at DESC LIMIT 6', p.id).reverse();
        const out = await runTurn(
          {
            chat: stub ?? ((req) => chatWithTools(req, fetchImpl)),
            target,
            ws: ws(p),
            stack: p.stack,
            build: () => build(p),
            logs: () => String(db.get<{ build_log: string }>('SELECT build_log FROM studio_projects WHERE id = ?', p.id)?.build_log ?? ''),
            budgetProblem: () => budget(app, ctx.locationId).problem ?? ((app.services.usageGate?.(ctx.locationId, 'ai') as string | undefined) || null),
            record: (r) => {
              const cost = target.provider === 'stub' ? Math.round(r.usage.input_tokens * 3 + r.usage.output_tokens * 15) : textCost({ ...target, model: r.model || target.model }, r.usage);
              logCall(ctx.locationId, ctx.user?.id ?? null, target, r, cost);
              return cost;
            },
          },
          prompt,
          history,
        );
        if (out.error && !out.tools.length && !out.input_tokens) throw new HttpError(402, out.error);
        const version = out.changed ? snapshot(p, prompt) : null;
        const turn = { id: id(), project_id: p.id, location_id: p.location_id, created_by: ctx.user?.id ?? null, prompt, reply: out.reply, tools: JSON.stringify(out.tools), files: JSON.stringify(out.files), error: out.error, model: out.model, thought_ms: out.thought_ms, input_tokens: out.input_tokens, output_tokens: out.output_tokens, cost_micros: out.cost_micros, version, created_at: now() };
        db.insert('studio_turns', turn);
        db.run('UPDATE studio_projects SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cost_micros = cost_micros + ?, updated_at = ? WHERE id = ?', out.input_tokens, out.output_tokens, out.cost_micros, now(), p.id);
        return { ...turn, tools: out.tools, files: out.files, cost_usd: out.cost_micros / 1e6 };
      } finally {
        busy.delete(p.id);
      }
    });
    app.services.aiStudio = { stubChat };
  },
};
