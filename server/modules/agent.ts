import { timingSafeEqual } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, num, str, type Ctx, type RawResult, type User } from '../core/http.js';
import { formatInTz, ymdInTz } from '../core/time.js';
import { id, now, sha256, token } from '../core/util.js';
import { budgetProblem, monthStart, withDefaults } from '../services/ai-context.js';
import type { Usage } from '../services/anthropic.js';
import type { Msg, Part } from '../services/agent-llm.js';
import type { Effort } from '../services/ai-effort.js';
import { textCost, type FetchLike, type Resolved } from '../services/ai-presets.js';
import { lastAnswer, resumeLoop, runLoop, systemPrompt, type AgentConfig, type AgentEvent, type LoopState, type Outcome, type RunEnv } from '../services/agent-runtime.js';
import { MODES, agentForbidden, argsHash, type Klass, type Mode } from '../services/agent-safety.js';
import { ROUTE_RE, externalTools, makeCaller, toolCatalog, toolsFor, withExternal, type AgentTool, type MemoryNote, type UiContext } from '../services/agent-tools.js';
import { resolveRecord, routeRecord } from '../services/agent-context.js';
import { PURPOSES } from './ai-assistant.js';

/**
 * HyperLevel Agent (core): model connections per agency with per-sub-account override, the chat with
 * streaming (SSE), confirmations, conversation history per user, uploads, the agent's notes, usage
 * against the KI-Assistent's monthly limit, and `app.services.agent` – the one entry point the other
 * agent modules use (custom agents, automations, MCP, mobile, GPT actions, bridge).
 *
 * Every tool call runs in-process as the calling user (routes, guards, member areas, SaaS plan,
 * audit log as "KI-Agent (im Auftrag von …)", via "agent"); see services/agent-runtime.ts and
 * services/agent-safety.ts for the loop and the rules. Test hook: `app.services.agentFetch`.
 */

const AGENCY_KEY = 'agent';
const PENDING_TTL_MS = 30 * 60_000;
const DEFERRED_TTL_MS = 7 * 864e5;
const RUN_TIMEOUT_MS = 5 * 60_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const FILE_TYPES = /^(image\/(png|jpeg|webp|gif)|text\/(csv|plain|markdown)|application\/(json|vnd\.ms-excel|csv))$/;

export interface RunOptions {
  user: User;
  locationId: string;
  agentId?: string | null;
  conversationId?: string | null;
  /** Model picked in the chat: a BYOK connection id or "bridge" (the user's own subscription). */
  connection?: string | null;
  text: string;
  files?: string[];
  ui?: UiContext | null;
  source: 'chat' | 'focus' | 'mobile' | 'mcp' | 'workflow' | 'schedule' | 'inbound' | 'gpt';
  automatic: boolean;
  emit?: (ev: AgentEvent) => void;
  signal?: AbortSignal;
  /** The request the run belongs to (ip, headers for the audit log). */
  baseCtx?: Ctx;
  /** Overrides for special runs (auto-responder: read-only, no web, tainted from the start). */
  modeOverride?: Mode;
  toolFilter?: (t: AgentTool) => boolean;
  tainted?: boolean;
  title?: string;
}

export interface RunResult {
  conversation_id: string;
  run_id: string;
  status: Outcome['status'];
  text: string;
  error?: string;
  pending: { id: string; tool: string; title: string; summary: string; deferred: boolean; token?: string; args_hash: string }[];
  tools: { name: string; status: string }[];
}

interface LocSettings {
  default_mode: Mode;
  web_fetch: boolean;
  enabled: boolean;
}
interface AgencySettings {
  web_fetch_allowed: boolean;
  bridge_enabled: boolean;
  gpt_actions_enabled: boolean;
}

const DEFAULT_LOC: LocSettings = { default_mode: 'ask', web_fetch: false, enabled: true };
const DEFAULT_AGENCY: AgencySettings = { web_fetch_allowed: true, bridge_enabled: false, gpt_actions_enabled: true };

export const DEFAULT_AGENT: Omit<AgentConfig, 'mode'> = {
  id: null,
  name: 'HyperLevel Agent',
  emoji: '✨',
  description: 'Allround-Assistent für das ganze CRM: findet, fasst zusammen, legt an und erledigt Aufgaben im Auftrag des Nutzers.',
  instructions: '',
  confirmSensitive: true,
  tools: null,
  knowledge: { sources: [], text: '' },
  webFetch: false,
  maxSteps: 12,
  memory: true,
};
export const DEFAULT_STARTERS = ['Was ist heute wichtig?', 'Fasse die ungelesenen Nachrichten zusammen', 'Welche Deals stehen kurz vor dem Abschluss?', 'Lege eine Aufgabe für morgen an'];

/** A user as stored (for automations that act on behalf of the agent's owner). */
export function userFromRow(row: any): User {
  return { id: row.id, email: row.email, name: row.name, role: row.role, locations: JSON.parse(row.locations || '[]'), permissions: row.permissions ? JSON.parse(row.permissions) : null };
}

const mayOpen = (u: User, locId: string) => u.role === 'admin' || u.locations.includes(locId);

/** A request context for background work (no HTTP request behind it). */
export function backgroundCtx(user: User, locationId: string): Ctx {
  return {
    req: { headers: {} } as any,
    res: undefined as any,
    method: 'POST',
    url: new URL('http://local/'),
    path: '/',
    params: {},
    query: new URLSearchParams(),
    body: {},
    rawBody: '',
    locationId,
    viaApiKey: false,
    via: 'session',
    ip: '',
    cookies: {},
    setCookie() {},
    user,
  };
}

/** The context tools run under: same user and rights, shown in the audit log as the agent. */
function agentCtx(base: Ctx | undefined, user: User, locationId: string): Ctx {
  const b = base ?? backgroundCtx(user, locationId);
  return { ...b, user: { ...user, name: `KI-Agent (im Auftrag von ${user.name})`.slice(0, 200) }, via: 'agent' as Ctx['via'], viaApiKey: false, scope: undefined, locationId, skipAfterWrite: false };
}

/** Server-sent events as a streamed response; the run goes on if the browser goes away. */
export function sseResponse(ctx: Ctx, start: (emit: (ev: AgentEvent) => void) => Promise<void>): RawResult {
  const stream = new PassThrough();
  const emit = (ev: AgentEvent) => {
    if (!stream.destroyed && !stream.writableEnded) stream.write(`data: ${JSON.stringify(ev)}\n\n`);
  };
  ctx.skipAfterWrite = true;
  const keepAlive = setInterval(() => !stream.destroyed && stream.write(': ping\n\n'), 15_000);
  keepAlive.unref?.();
  stream.write(': ok\n\n');
  void start(emit)
    .catch((e) => emit({ type: 'error', message: (e as Error).message, status: e instanceof HttpError ? e.status : 500 }))
    .finally(() => {
      clearInterval(keepAlive);
      if (!stream.destroyed) stream.end();
    });
  return { __raw: true, status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' }, body: stream };
}

const safeEqualHex = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export const agentModule: Module = {
  name: 'agent',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE agent_location_settings (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE, data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
      );
      CREATE TABLE agent_conversations (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, user_id TEXT NOT NULL,
        agent_id TEXT, connection TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'chat',
        messages TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'idle', error TEXT NOT NULL DEFAULT '',
        ui TEXT NOT NULL DEFAULT '{}', input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_micros INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX agent_conversations_user ON agent_conversations(user_id, location_id, updated_at);
      CREATE TABLE agent_pending (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL, agent_id TEXT, kind TEXT NOT NULL DEFAULT 'loop', call_id TEXT NOT NULL, tool TEXT NOT NULL,
        klass TEXT NOT NULL, args TEXT NOT NULL, args_hash TEXT NOT NULL, token_hash TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
        target TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', result TEXT, created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT
      );
      CREATE INDEX agent_pending_loc ON agent_pending(location_id, status);
      CREATE TABLE agent_files (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, user_id TEXT NOT NULL,
        name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE agent_memory (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, agent_key TEXT NOT NULL,
        text TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX agent_memory_key ON agent_memory(location_id, agent_key);
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, agent_id TEXT, user_id TEXT,
        conversation_id TEXT, source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running', steps INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cost_micros INTEGER NOT NULL DEFAULT 0,
        model TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL, finished_at TEXT
      );
      CREATE INDEX agent_runs_loc ON agent_runs(location_id, started_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    /** Routes that act as a person: sub-account API keys get a clean 403 instead of a crash. */
    const userOf = (ctx: Ctx): User => {
      if (!ctx.user) throw new HttpError(403, 'Nur mit Anmeldung (nicht mit einem API-Schlüssel)');
      return ctx.user;
    };
    Object.assign(PURPOSES, { agent: 'KI-Agent', agent_auto: 'KI-Agent (automatisch)' });

    // The agent never touches identities, keys or its own configuration – whatever the user could do.
    app.guards.push((ctx) => {
      if ((ctx.via as string) === 'agent' && agentForbidden(ctx.path)) throw new HttpError(403, 'Das darf der KI-Agent nicht – bitte selbst in der Oberfläche erledigen.');
    });

    // --- settings -------------------------------------------------------------------------------
    const agencySettings = (): AgencySettings => {
      const row = db.get('SELECT value FROM agency_settings WHERE key = ?', AGENCY_KEY);
      return { ...DEFAULT_AGENCY, ...(row ? JSON.parse(row.value) : {}) };
    };
    const locSettings = (locId: string): LocSettings => {
      const row = db.get('SELECT data FROM agent_location_settings WHERE location_id = ?', locId);
      const s = { ...DEFAULT_LOC, ...(row ? JSON.parse(row.data) : {}) };
      if (!MODES.includes(s.default_mode)) s.default_mode = 'ask';
      return s;
    };
    const tzOf = (locId: string) => app.location(locId)?.timezone || 'Europe/Berlin';
    const brand = () => (app.services.brandName?.() as string | undefined) ?? 'HyperLevel';

    // --- model (BYOK registry, modules/ai-connections.ts) ----------------------------------------------------
    /** The text connection for a run: the agent's own → routing "agent" → … (see aiConnections.resolve). */
    const resolveTarget = (locId: string, wanted?: string | null): Resolved | null => {
      const reg = app.services.aiConnections;
      if (!reg) return null;
      const pick = wanted && wanted !== 'bridge' ? reg.resolve(locId, 'agent', wanted) : null;
      const r: Resolved | null = pick ?? reg.resolve(locId, 'agent');
      return r && (r.wire === 'openai' || r.wire === 'anthropic') ? r : null;
    };
    const fetchFor = (r: Resolved): FetchLike => (r.provider === 'chatgpt_plan' ? app.services.aiSubscriptions.fetchFor(r) : undefined) ?? (app.services.agentFetch as FetchLike | undefined) ?? app.services.aiConnections.fetchFor(r);

    router.get('/api/agent/settings', 'location', (ctx) => ({ ...locSettings(ctx.locationId), agency: { web_fetch_allowed: agencySettings().web_fetch_allowed, bridge_enabled: agencySettings().bridge_enabled, gpt_actions_enabled: agencySettings().gpt_actions_enabled } }));
    router.put('/api/agent/settings', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const s = locSettings(ctx.locationId);
      if (b.default_mode !== undefined) {
        if (!MODES.includes(b.default_mode)) throw bad('Modus: read, ask, book oder auto');
        s.default_mode = b.default_mode;
      }
      if (b.web_fetch !== undefined) s.web_fetch = !!b.web_fetch;
      if (b.enabled !== undefined) s.enabled = !!b.enabled;
      db.run('INSERT INTO agent_location_settings (location_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at', ctx.locationId, JSON.stringify(s), now());
      return s;
    });
    router.get('/api/agent/agency-settings', 'admin', () => agencySettings());
    router.put('/api/agent/agency-settings', 'admin', (ctx) => {
      const b = ctx.body ?? {};
      const s = agencySettings();
      for (const k of ['web_fetch_allowed', 'bridge_enabled', 'gpt_actions_enabled'] as const) if (b[k] !== undefined) s[k] = !!b[k];
      db.run('INSERT INTO agency_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', AGENCY_KEY, JSON.stringify(s));
      return s;
    });

    // --- usage & budget ------------------------------------------------------------------------------
    const usageSince = (locId: string, since: string) =>
      db.get<{ cost: number; tokens: number }>(
        `SELECT COALESCE(SUM(cost_micros), 0) AS cost, COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens FROM ai_calls WHERE location_id = ? AND created_at >= ? AND status <> 'blocked'`,
        locId,
        since,
      )!;
    /** The KI-Assistent's monthly limit (cost and tokens) counts agent calls too; then the SaaS plan. */
    const budget = (locId: string): string | null => {
      try {
        const row = db.get('SELECT data FROM ai_settings WHERE location_id = ?', locId);
        const s = withDefaults(row ? JSON.parse(row.data || '{}') : null);
        const used = usageSince(locId, monthStart(tzOf(locId)));
        const over = budgetProblem(s, { cost_micros: used.cost, tokens: used.tokens });
        if (over) return over;
      } catch {
        /* no KI-Assistent tables */
      }
      return (app.services.usageGate?.(locId, 'ai') as string | undefined) ?? null;
    };
    /** One model call in the KI-Assistent's usage log (monthly limit) and in the connection's usage. */
    const logUsage = (r: { locationId: string; userId: string | null; purpose: string; model: string; usage: Usage; ms: number; status: 'ok' | 'error' | 'blocked'; error?: string; conn: Resolved }) => {
      const cost = textCost({ ...r.conn, model: r.model }, r.usage);
      if (r.status === 'ok' && !r.conn.connectionId.startsWith('implicit:')) app.services.aiConnections?.recordUsage(r.conn.connectionId, r.locationId, r.usage, cost);
      try {
        db.insert('ai_calls', {
          id: id(),
          location_id: r.locationId,
          purpose: r.purpose,
          model: `${r.conn.provider === 'anthropic' ? '' : `${r.conn.provider}:`}${r.model}`.slice(0, 120),
          status: r.status,
          ...r.usage,
          cost_micros: cost,
          ms: r.ms,
          contact_id: null,
          conversation_id: null,
          user_id: r.userId,
          error: (r.error ?? '').slice(0, 500),
          created_at: now(),
        });
      } catch (e) {
        console.error('[agent] usage log', (e as Error).message);
      }
      return cost;
    };

    // --- memory & files ---------------------------------------------------------------------------------
    const memoryKey = (agentId: string | null, userId: string) => agentId ?? `default:${userId}`;
    const memoryFor = (locId: string, agentId: string | null, userId: string) => {
      const key = memoryKey(agentId, userId);
      return {
        list: (): MemoryNote[] => db.all('SELECT id, text, created_at FROM agent_memory WHERE location_id = ? AND agent_key = ? ORDER BY created_at', locId, key),
        add: (text: string): MemoryNote => {
          const n = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM agent_memory WHERE location_id = ? AND agent_key = ?', locId, key)!.n;
          if (n >= 60) throw bad('Zu viele Notizen – bitte erst alte löschen (remember action delete).');
          const note = { id: id(), text, created_at: now() };
          db.insert('agent_memory', { ...note, location_id: locId, agent_key: key, created_by: userId });
          return note;
        },
        remove: (nid: string) => db.run('DELETE FROM agent_memory WHERE id = ? AND location_id = ? AND agent_key = ?', nid, locId, key).changes > 0,
      };
    };
    const fileFor = (locId: string, userId: string) => (fid: string) => {
      const f = db.get('SELECT name, mime, data FROM agent_files WHERE id = ? AND location_id = ? AND user_id = ?', fid, locId, userId);
      return f ? { name: f.name as string, mime: f.mime as string, data: Buffer.from(f.data as Uint8Array) } : null;
    };
    const textPreview = (data: Buffer) => {
      const t = data.toString('utf8');
      const lines = t.split(/\r?\n/);
      return `${lines.slice(0, 30).join('\n').slice(0, 4000)}${lines.length > 30 ? `\n… (${lines.length} Zeilen insgesamt)` : ''}`;
    };
    router.post('/api/agent/files', 'location', (ctx) => {
      const u = ctx.user;
      if (!u) throw new HttpError(403, 'Nur mit Anmeldung');
      const name = str(ctx.body?.name, 'Dateiname', { required: true, max: 200 }).replace(/[\\/]/g, '_');
      let mime = str(ctx.body?.mime, 'Typ', { max: 100 }).toLowerCase();
      if (!mime || mime === 'application/octet-stream') mime = /\.csv$/i.test(name) ? 'text/csv' : /\.(md|txt)$/i.test(name) ? 'text/plain' : /\.json$/i.test(name) ? 'application/json' : mime;
      if (!FILE_TYPES.test(mime)) throw bad('Erlaubt sind Bilder (PNG, JPG, WebP, GIF), CSV, Text, Markdown und JSON.');
      const data = Buffer.from(String(ctx.body?.data ?? ''), 'base64');
      if (!data.length) throw bad('Datei ist leer');
      if (data.length > MAX_FILE_BYTES) throw bad('Datei zu groß (höchstens 8 MB)');
      const row = { id: id(), location_id: ctx.locationId, user_id: u.id, name, mime, size: data.length, data, created_at: now() };
      db.insert('agent_files', row);
      return { id: row.id, name, mime, size: data.length, image: mime.startsWith('image/'), preview: mime.startsWith('image/') ? '' : textPreview(data).slice(0, 600) };
    });
    router.get('/api/agent/files/:id', 'location', (ctx) => {
      const f = ctx.user && fileFor(ctx.locationId, ctx.user.id)(ctx.params.id);
      if (!f) throw notFound('Datei nicht gefunden');
      return { __raw: true, status: 200, headers: { 'content-type': f.mime.startsWith('image/') ? f.mime : 'text/plain; charset=utf-8', 'cache-control': 'private, max-age=3600', 'content-disposition': 'inline' }, body: f.data };
    });
    router.get('/api/agent/memory', 'location', (ctx) => {
      const agentId = ctx.query.get('agent_id') || null;
      if (agentId) app.services.agentDefs?.config(agentId, userOf(ctx), ctx.locationId);
      return memoryFor(ctx.locationId, agentId, userOf(ctx).id).list();
    });
    router.delete('/api/agent/memory/:id', 'location', (ctx) => {
      const agentId = ctx.query.get('agent_id') || null;
      if (agentId) app.services.agentDefs?.config(agentId, userOf(ctx), ctx.locationId);
      if (!memoryFor(ctx.locationId, agentId, userOf(ctx).id).remove(ctx.params.id)) throw notFound();
      return { ok: true };
    });

    // --- agent configuration ------------------------------------------------------------------------------
    /** The built-in agent or a custom one (modules/agent-custom.ts) – checked for visibility. */
    const agentConfig = (agentId: string | null | undefined, user: User, locId: string): { cfg: AgentConfig; connectionId: string | null; model: string; ownerId: string | null } => {
      if (agentId) {
        const custom = app.services.agentDefs?.config(agentId, user, locId);
        if (!custom) throw notFound('Agent nicht gefunden');
        return custom;
      }
      const s = locSettings(locId);
      return { cfg: { ...DEFAULT_AGENT, mode: s.default_mode, webFetch: s.web_fetch && agencySettings().web_fetch_allowed }, connectionId: null, model: '', ownerId: null };
    };

    // --- conversations ------------------------------------------------------------------------------------
    const active = new Map<string, AbortController>();
    const getConv = (cid: string, userId: string, locId: string) => {
      const c = db.get('SELECT * FROM agent_conversations WHERE id = ? AND user_id = ? AND location_id = ?', cid, userId, locId);
      if (!c) throw notFound('Unterhaltung nicht gefunden');
      return c;
    };
    const storeMessages = (history: Msg[]): string => {
      const strip = history.map((m) => ({ ...m, content: m.content.map((p) => (p.type === 'image' && p.fileId ? { ...p, data: '' } : p)) }));
      let json = JSON.stringify(strip);
      // Very long chats: keep the newest turns (the model only sees the last ones anyway).
      while (json.length > 1_500_000 && strip.length > 4) {
        strip.splice(0, Math.max(2, Math.floor(strip.length / 4)));
        while (strip.length && !(strip[0].role === 'user' && !strip[0].content.some((p) => p.type === 'tool_result'))) strip.shift();
        json = JSON.stringify(strip);
      }
      return json;
    };

    /** Rejects a waiting confirmation when the user writes something else instead. */
    const dropAwaiting = (conv: any, history: Msg[], state: LoopState) => {
      const aw = state.awaiting;
      if (!aw) return;
      for (let i = aw.index; i < aw.calls.length; i++) {
        const c = aw.calls[i];
        aw.results.push({ type: 'tool_result', id: c.id, name: c.name, content: 'Nicht ausgeführt – der Nutzer hat stattdessen eine neue Nachricht geschrieben.', isError: true, meta: { status: 'rejected' } });
      }
      history.push({ role: 'user', content: aw.results });
      state.awaiting = null;
      db.run(`UPDATE agent_pending SET status = 'expired', decided_at = ? WHERE conversation_id = ? AND status = 'pending' AND kind = 'loop'`, now(), conv.id);
    };

    interface Prepared {
      env: RunEnv;
      conv: any;
      history: Msg[];
      state: LoopState;
      runId: string;
      totals: { input: number; output: number; cost: number; model: string };
      pending: RunResult['pending'];
      toolLog: RunResult['tools'];
    }

    /** Everything a run needs: agent, connection, tools, prompt, hooks – shared by new messages and confirmations. */
    const prepare = (o: { user: User; locationId: string; conv: any; agentId: string | null; connection?: string | null; automatic: boolean; source: string; emit: (ev: AgentEvent) => void; signal: AbortSignal; baseCtx?: Ctx; ui: UiContext | null; modeOverride?: Mode; toolFilter?: (t: AgentTool) => boolean; external?: AgentTool[] }): Prepared => {
      const { user, locationId: locId } = o;
      const loc = app.location(locId)!;
      const ac = agentConfig(o.agentId, user, locId);
      const cfg: AgentConfig = { ...ac.cfg, ...(o.modeOverride ? { mode: o.modeOverride } : {}) };
      const wanted = o.connection || ac.connectionId;
      // "Mein ChatGPT-Abo": personal, only in the owner's own browser chat (modules/ai-subscriptions.ts decides).
      const own = wanted === 'sub:chatgpt';
      const resolved = own ? (app.services.aiSubscriptions?.resolveFor({ user, locationId: locId, usage: 'agent', automatic: o.automatic, via: o.baseCtx?.via }) as Resolved | null) : resolveTarget(locId, wanted);
      if (own && !resolved) throw new HttpError(409, 'Dein ChatGPT-Abo ist nicht verbunden, nicht für den Agenten freigegeben oder hier nicht erlaubt (nur du selbst, im Browser-Chat). Prüfe Einstellungen → KI-Anbieter.');
      if (!resolved) throw new HttpError(409, 'Kein Text-Modell verbunden. Bitte unter Einstellungen → KI-Anbieter (BYOK) eine Verbindung anlegen – z. B. OpenAI, Anthropic, Gemini, OpenRouter, Groq oder ein lokales Modell (Ollama).');
      // A model picked in the chat beats the agent's own model choice.
      const conn: Resolved = { ...resolved, model: (o.connection ? '' : ac.model) || resolved.model };
      let tools = toolsFor(withExternal(toolCatalog(app, user, { webFetch: cfg.webFetch }), o.external ?? []), cfg.tools, cfg.mode);
      if (o.toolFilter) tools = tools.filter(o.toolFilter);
      const memory = memoryFor(locId, cfg.id, user.id);
      const tz = tzOf(locId);
      const history: Msg[] = JSON.parse(o.conv.messages || '[]');
      const state: LoopState = { steps: 0, tainted: false, ...JSON.parse(o.conv.state || '{}') };
      const runId = id();
      const totals = { input: 0, output: 0, cost: 0, model: conn.model };
      const pending: RunResult['pending'] = [];
      const toolLog: RunResult['tools'] = [];
      const ui = o.ui;
      const contextNote = [
        `[Kontext – nur zur Orientierung: ${formatInTz(new Date(), tz, { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })} (${tz})`,
        ui?.label || ui?.route ? `; Seite: ${ui.label || ui.route}${ui.label && ui.route?.includes('/') ? ` (${ui.route})` : ''}` : '',
        ui?.from ? `; geöffnet von: ${ui.from}` : '',
        ui?.entity ? `; ausgewählt: ${ui.entity.type} „${String(ui.entity.label ?? '').slice(0, 80)}“ (ID ${ui.entity.id})` : '',
        ']',
      ].join('');
      const purpose = o.automatic ? 'agent_auto' : 'agent';
      db.insert('agent_runs', { id: runId, location_id: locId, agent_id: cfg.id, user_id: user.id, conversation_id: o.conv.id, source: o.source, status: 'running', model: conn.model, started_at: now() });
      const env: RunEnv = {
        app,
        user,
        ctx: agentCtx(o.baseCtx, user, locId),
        locationId: locId,
        agent: cfg,
        connection: conn,
        effort: (app.services.aiEffort?.forCap(locId, 'agent') as { effort: Effort } | undefined)?.effort,
        tools,
        conversationId: o.conv.id,
        automatic: o.automatic,
        ui,
        system: systemPrompt({ brand: brand(), agent: cfg, user, locationName: loc.name, locationId: locId, today: ymdInTz(new Date(), tz), automatic: o.automatic, memory: cfg.memory ? memory.list() : [], knowledge: cfg.knowledge.text, extras: ((app.services.agentPromptExtras ?? []) as ((i: { user: User; locationId: string; automatic: boolean; source: string }) => string)[]).map((f) => f({ user, locationId: locId, automatic: o.automatic, source: o.source })).filter(Boolean) }),
        contextNote,
        emit: (ev) => {
          if (ev.type === 'tool_result') toolLog.push({ name: String(ev.name ?? ''), status: String(ev.status) });
          o.emit(ev);
        },
        signal: o.signal,
        fetch: fetchFor(conn),
        // Ersatzmodelle (services/model-fallback.ts): the routing's fallbacks or the provider's order, then other text connections
        fallbacks: own ? [] : ((app.services.aiConnections?.fallbackTargets?.(locId, 'agent', conn) as Resolved[] | undefined) ?? []),
        fetchFor,
        // no model at all answers: modules that can answer from the data by rules (e.g. the companion's growth review)
        rulesFallback: async () => {
          const last = [...history].reverse().find((m) => m.role === 'user' && m.content.some((x) => x.type === 'text'));
          const text = last ? last.content.map((x) => (x.type === 'text' ? x.text : '')).join(' ').trim() : '';
          for (const fn of (app.services.agentRulesFallback ?? []) as ((i: { user: User; locationId: string; source: string; automatic: boolean; text: string; ctx: Ctx }) => Promise<string | null>)[]) {
            const out = await fn({ user, locationId: locId, source: o.source, automatic: o.automatic, text, ctx: agentCtx(o.baseCtx, user, locId) }).catch(() => null);
            if (out) return out;
          }
          return null;
        },
        memory,
        file: fileFor(locId, user.id),
        deadline: Date.now() + RUN_TIMEOUT_MS,
        maxSteps: state.steps + cfg.maxSteps,
        hooks: {
          budget: () => budget(locId),
          usage: (r) => {
            const cost = logUsage({ locationId: locId, userId: user.id, purpose, model: r.model, usage: r.usage, ms: r.ms, status: r.status, error: r.error, conn: r.conn ?? conn });
            totals.input += r.usage.input_tokens + r.usage.cache_read_tokens + r.usage.cache_write_tokens;
            totals.output += r.usage.output_tokens;
            totals.cost += cost;
            totals.model = r.model;
          },
          createPending: (p) => {
            const tok = token(24);
            const pid = id();
            db.insert('agent_pending', {
              id: pid,
              conversation_id: o.conv.id,
              location_id: locId,
              user_id: user.id,
              agent_id: cfg.id,
              kind: p.deferred ? 'deferred' : 'loop',
              call_id: p.call.id,
              tool: p.tool.name,
              klass: p.klass,
              args: JSON.stringify(p.call.args),
              args_hash: p.hash,
              token_hash: sha256(tok),
              summary: p.summary.slice(0, 500),
              target: (p.target ?? '').slice(0, 300),
              created_at: now(),
              expires_at: new Date(Date.now() + (p.deferred ? DEFERRED_TTL_MS : PENDING_TTL_MS)).toISOString(),
            });
            pending.push({ id: pid, tool: p.tool.name, title: p.tool.title, summary: p.summary, deferred: p.deferred, ...(p.deferred ? {} : { token: tok }), args_hash: p.hash });
            if (p.deferred) app.events.emit(locId, 'agent.approval_needed', { pendingId: pid, agentId: cfg.id, tool: p.tool.name, summary: p.summary });
            return { id: pid, token: tok };
          },
        },
      };
      return { env, conv: o.conv, history, state, runId, totals, pending, toolLog };
    };

    const finish = (p: Prepared, outcome: Outcome, emit: (ev: AgentEvent) => void) => {
      const text = outcome.status === 'done' ? outcome.text : lastAnswer(p.history);
      const status = outcome.status === 'awaiting' ? 'awaiting' : outcome.status === 'error' || outcome.status === 'limit' ? 'error' : 'idle';
      db.run(
        `UPDATE agent_conversations SET messages = ?, state = ?, status = ?, error = ?, input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cost_micros = cost_micros + ?, updated_at = ? WHERE id = ?`,
        storeMessages(p.history),
        JSON.stringify({ steps: p.state.steps, tainted: p.state.tainted, awaiting: p.state.awaiting ?? null }),
        status,
        outcome.error ?? '',
        p.totals.input,
        p.totals.output,
        p.totals.cost,
        now(),
        p.conv.id,
      );
      db.run(
        'UPDATE agent_runs SET status = ?, steps = ?, input_tokens = ?, output_tokens = ?, cost_micros = ?, model = ?, error = ?, summary = ?, finished_at = ? WHERE id = ?',
        outcome.status,
        p.state.steps,
        p.totals.input,
        p.totals.output,
        p.totals.cost,
        p.totals.model,
        outcome.error ?? '',
        text.slice(0, 2000),
        now(),
        p.runId,
      );
      if (outcome.error) emit({ type: 'error', message: outcome.error });
      emit({ type: 'done', status: outcome.status, conversation_id: p.conv.id, run_id: p.runId, cost_usd: p.totals.cost / 1e6, input_tokens: p.totals.input, output_tokens: p.totals.output });
      return {
        conversation_id: p.conv.id,
        run_id: p.runId,
        status: outcome.status,
        text,
        ...(outcome.error ? { error: outcome.error } : {}),
        pending: p.pending,
        tools: p.toolLog,
      } satisfies RunResult;
    };

    /** Bridge connections run the user's own CLI on their computer (modules/agent-bridge.ts). */
    const runBridge = async (o: RunOptions, conv: any, emit: (ev: AgentEvent) => void, signal: AbortSignal): Promise<RunResult> => {
      const bridge = app.services.agentBridge;
      if (!bridge) throw new HttpError(409, 'Die Bridge ist nicht verfügbar.');
      if (o.automatic) throw new HttpError(409, 'Die Bridge läuft nur im Chat mit dir selbst – nicht für Automationen.');
      const history: Msg[] = JSON.parse(conv.messages || '[]');
      const state: LoopState = { steps: 0, tainted: false, ...JSON.parse(conv.state || '{}') };
      dropAwaiting(conv, history, state);
      history.push({ role: 'user', content: [{ type: 'text', text: o.text }] });
      const runId = id();
      db.insert('agent_runs', { id: runId, location_id: o.locationId, agent_id: o.agentId ?? null, user_id: o.user.id, conversation_id: conv.id, source: o.source, status: 'running', model: 'bridge', started_at: now() });
      emit({ type: 'start', conversation_id: conv.id, run_id: runId, bridge: true });
      const ac = agentConfig(o.agentId, o.user, o.locationId);
      const r: { text: string; parts: Part[]; results: Part[]; error?: string } = await bridge.run({ user: o.user, locationId: o.locationId, conversationId: conv.id, agent: ac.cfg, history, emit, signal, baseCtx: o.baseCtx, ui: o.ui ?? null });
      // Same shape as API runs: tool calls, their results, then the answer.
      const calls = r.parts.filter((p) => p.type === 'tool_call');
      if (calls.length) history.push({ role: 'assistant', content: calls }, { role: 'user', content: r.results });
      if (r.text) history.push({ role: 'assistant', content: [{ type: 'text', text: r.text }] });
      const status = r.error ? 'error' : 'done';
      db.run('UPDATE agent_conversations SET messages = ?, state = ?, status = ?, error = ?, updated_at = ? WHERE id = ?', storeMessages(history), JSON.stringify({ steps: 0, tainted: false, awaiting: null }), r.error ? 'error' : 'idle', r.error ?? '', now(), conv.id);
      db.run('UPDATE agent_runs SET status = ?, error = ?, summary = ?, finished_at = ? WHERE id = ?', status, r.error ?? '', r.text.slice(0, 2000), now(), runId);
      if (r.error) emit({ type: 'error', message: r.error });
      emit({ type: 'done', status, conversation_id: conv.id, run_id: runId });
      return { conversation_id: conv.id, run_id: runId, status, text: r.text, ...(r.error ? { error: r.error } : {}), pending: [], tools: [] };
    };

    /** One user message → agent run (streams events through `emit`). */
    const run = async (o: RunOptions): Promise<RunResult> => {
      const loc = app.location(o.locationId);
      if (!loc) throw notFound('Sub-Account nicht gefunden');
      if (!mayOpen(o.user, o.locationId)) throw new HttpError(403, 'Kein Zugriff auf diesen Sub-Account');
      if (!locSettings(o.locationId).enabled && !o.automatic) throw new HttpError(409, 'Der KI-Agent ist für diesen Sub-Account ausgeschaltet (Einstellungen → KI-Agent).');
      const text = str(o.text, 'Nachricht', { max: 20_000 });
      if (!text && !o.files?.length) throw bad('Nachricht fehlt');
      const emit = o.emit ?? (() => {});
      let conv: any = o.conversationId ? getConv(o.conversationId, o.user.id, o.locationId) : null;
      const agentId = conv ? conv.agent_id : (o.agentId ?? null);
      agentConfig(agentId, o.user, o.locationId); // visibility check before anything is stored
      if (!conv) {
        const row = { id: id(), location_id: o.locationId, user_id: o.user.id, agent_id: agentId, connection: o.connection ?? '', title: (o.title ?? text).replace(/\s+/g, ' ').slice(0, 80) || 'Neue Unterhaltung', source: o.source, created_at: now(), updated_at: now() };
        db.insert('agent_conversations', row);
        conv = db.get('SELECT * FROM agent_conversations WHERE id = ?', row.id);
      }
      if (active.has(conv.id)) throw new HttpError(409, 'Der Agent arbeitet in dieser Unterhaltung noch – bitte warten oder stoppen.');
      // Switching the model in the chat applies from this message on.
      if (o.connection !== undefined && o.connection !== null && o.connection !== conv.connection) {
        db.run('UPDATE agent_conversations SET connection = ? WHERE id = ?', o.connection, conv.id);
        conv.connection = o.connection;
      }
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      o.signal?.addEventListener('abort', onAbort, { once: true });
      active.set(conv.id, controller);
      db.run(`UPDATE agent_conversations SET status = 'running', ui = ?, updated_at = ? WHERE id = ?`, JSON.stringify(o.ui ?? {}), now(), conv.id);
      try {
        if ((conv.connection || agentConfig(agentId, o.user, o.locationId).connectionId) === 'bridge') return await runBridge({ ...o, agentId }, conv, emit, controller.signal);
        // External tools (MCP servers, Nango) of this sub-account/user – app.services.agentToolSources.
        const external = await externalTools(app, o.user, o.locationId);
        const p = prepare({ user: o.user, locationId: o.locationId, conv, agentId, connection: conv.connection || null, automatic: o.automatic, source: o.source, emit, signal: controller.signal, baseCtx: o.baseCtx, ui: o.ui ?? null, modeOverride: o.modeOverride, toolFilter: o.toolFilter, external });
        if (o.tainted) p.state.tainted = true;
        dropAwaiting(conv, p.history, p.state);
        const content: Part[] = [];
        if (text) content.push({ type: 'text', text });
        for (const fid of (o.files ?? []).slice(0, 6)) {
          const f = db.get('SELECT id, name, mime, data FROM agent_files WHERE id = ? AND location_id = ? AND user_id = ?', String(fid), o.locationId, o.user.id);
          if (!f) throw bad('Datei nicht gefunden');
          if (String(f.mime).startsWith('image/')) content.push({ type: 'image', fileId: f.id, mediaType: f.mime, name: f.name, data: '' });
          else content.push({ type: 'file', fileId: f.id, name: f.name, mime: f.mime, preview: textPreview(Buffer.from(f.data as Uint8Array)) });
        }
        p.history.push({ role: 'user', content });
        emit({ type: 'start', conversation_id: conv.id, run_id: p.runId, agent: { id: p.env.agent.id, name: p.env.agent.name, emoji: p.env.agent.emoji, mode: p.env.agent.mode }, model: { provider: p.env.connection.provider, model: p.env.connection.model } });
        let outcome: Outcome;
        try {
          outcome = await runLoop(p.env, p.history, p.state);
        } catch (e) {
          outcome = { status: 'error', text: '', error: (e as Error).message };
        }
        return finish(p, outcome, emit);
      } catch (e) {
        db.run(`UPDATE agent_conversations SET status = 'error', error = ?, updated_at = ? WHERE id = ? AND status = 'running'`, (e as Error).message.slice(0, 500), now(), conv.id);
        throw e;
      } finally {
        active.delete(conv.id);
        o.signal?.removeEventListener('abort', onAbort);
      }
    };

    /** A confirmation click: checks the one-time token (user, arguments, expiry), then resumes the run. */
    const confirm = async (o: { user: User; locationId: string; pendingId: string; token: string; approve: boolean; argsHash?: string; emit?: (ev: AgentEvent) => void; baseCtx?: Ctx; signal?: AbortSignal }): Promise<RunResult> => {
      const row = db.get('SELECT * FROM agent_pending WHERE id = ? AND location_id = ?', o.pendingId, o.locationId);
      if (!row || row.user_id !== o.user.id) throw new HttpError(403, 'Diese Bestätigung gehört nicht zu dir.');
      if (row.kind === 'deferred') throw bad('Freigaben aus Automationen bitte unter KI-Agenten → Freigaben entscheiden.');
      if (row.status !== 'pending') throw new HttpError(409, 'Diese Bestätigung wurde schon verwendet oder ist abgelaufen.');
      if (row.expires_at < now()) {
        db.run(`UPDATE agent_pending SET status = 'expired' WHERE id = ?`, row.id);
        throw new HttpError(410, 'Die Bestätigung ist abgelaufen – bitte den Auftrag neu geben.');
      }
      if (!o.token || !safeEqualHex(sha256(String(o.token)), row.token_hash)) throw new HttpError(403, 'Ungültiger Bestätigungs-Code.');
      if (o.argsHash && o.argsHash !== row.args_hash) throw bad('Die Aktion hat sich geändert – bitte erneut prüfen.');
      if (row.kind === 'bridge') {
        if (db.run(`UPDATE agent_pending SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'`, o.approve ? 'approved' : 'rejected', now(), o.user.id, row.id).changes !== 1) throw new HttpError(409, 'Schon entschieden.');
        app.services.agentBridge?.decided(row.id, o.approve);
        o.emit?.({ type: 'done', status: 'decided', conversation_id: row.conversation_id });
        return { conversation_id: row.conversation_id, run_id: '', status: 'done', text: '', pending: [], tools: [] };
      }
      const conv = getConv(row.conversation_id, o.user.id, o.locationId);
      const state: LoopState = JSON.parse(conv.state || '{}');
      const call = state.awaiting?.calls[state.awaiting.index];
      if (!state.awaiting || state.awaiting.pendingId !== row.id || !call || call.id !== row.call_id || argsHash(call.name, call.args) !== row.args_hash) throw new HttpError(409, 'Diese Bestätigung passt nicht mehr zum Stand der Unterhaltung.');
      // Single use: only the first request flips the row.
      if (db.run(`UPDATE agent_pending SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'`, o.approve ? 'approved' : 'rejected', now(), o.user.id, row.id).changes !== 1) throw new HttpError(409, 'Diese Bestätigung wurde schon verwendet.');
      if (active.has(conv.id)) throw new HttpError(409, 'Der Agent arbeitet in dieser Unterhaltung noch.');
      const emit = o.emit ?? (() => {});
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      o.signal?.addEventListener('abort', onAbort, { once: true });
      active.set(conv.id, controller);
      db.run(`UPDATE agent_conversations SET status = 'running', updated_at = ? WHERE id = ?`, now(), conv.id);
      try {
        const ui = (() => {
          try {
            return JSON.parse(conv.ui || '{}').route ? JSON.parse(conv.ui) : null;
          } catch {
            return null;
          }
        })();
        const external = await externalTools(app, o.user, o.locationId);
        const p = prepare({ user: o.user, locationId: o.locationId, conv, agentId: conv.agent_id, connection: conv.connection || null, automatic: false, source: conv.source, emit, signal: controller.signal, baseCtx: o.baseCtx, ui, external });
        emit({ type: 'start', conversation_id: conv.id, run_id: p.runId, resumed: true, agent: { id: p.env.agent.id, name: p.env.agent.name, emoji: p.env.agent.emoji, mode: p.env.agent.mode } });
        let outcome: Outcome;
        try {
          outcome = await resumeLoop(p.env, p.history, p.state, o.approve);
        } catch (e) {
          outcome = { status: 'error', text: '', error: (e as Error).message };
        }
        db.run('UPDATE agent_pending SET status = ? WHERE id = ?', o.approve ? 'done' : 'rejected', row.id);
        return finish(p, outcome, emit);
      } finally {
        active.delete(conv.id);
        o.signal?.removeEventListener('abort', onAbort);
      }
    };

    /** Runs one tool directly with the user's identity (GPT actions, approved deferred actions). */
    const runTool = async (o: { user: User; locationId: string; name: string; args: Record<string, unknown>; allow: 'read' | 'write' | 'sensitive'; baseCtx?: Ctx; agentId?: string | null; webFetch?: boolean }) => {
      const tool = withExternal(toolCatalog(app, o.user, { webFetch: !!o.webFetch }), o.name.startsWith('ext_') || o.name.startsWith('nango_') ? await externalTools(app, o.user, o.locationId) : []).find((t) => t.name === o.name);
      if (!tool) throw notFound(`Werkzeug ${o.name} nicht gefunden`);
      const klass: Klass = tool.klassFor?.(o.args) ?? tool.klass;
      const rank = { read: 0, internal: 0, write: 1, sensitive: 2 } as const;
      const allowRank = { read: 0, write: 1, sensitive: 2 } as const;
      if (rank[klass] > allowRank[o.allow]) throw new HttpError(403, klass === 'sensitive' ? 'Dieses Werkzeug versendet, löscht oder bezahlt – dafür fehlt die Freigabe.' : 'Dieser Zugang darf nur lesen.');
      const ctx = agentCtx(o.baseCtx, o.user, o.locationId);
      const memory = memoryFor(o.locationId, o.agentId ?? null, o.user.id);
      return tool.run(
        {
          app,
          ctx,
          user: o.user,
          locationId: o.locationId,
          agentId: o.agentId ?? null,
          conversationId: '',
          automatic: true,
          ui: null,
          caller: makeCaller(app, ctx, o.user, o.locationId, klass === 'sensitive' ? 'sensitive' : klass === 'write' ? 'write' : 'read'),
          emit: () => {},
          memory,
          file: fileFor(o.locationId, o.user.id),
          knowledge: { sources: [], text: '' },
        },
        o.args,
      );
    };

    app.services.agent = { run, confirm, runTool, resolveTarget, agentConfig, toolCatalog: (u: User, webFetch = false) => toolCatalog(app, u, { webFetch }), locSettings, agencySettings, sseResponse, userFromRow, backgroundCtx };

    // --- routes: chat ---------------------------------------------------------------------------------------
    const cleanUi = (v: any): UiContext | null => {
      if (!v || typeof v !== 'object') return null;
      const route = String(v.route ?? '').replace(/^\/?(app\/)?/, '').slice(0, 200);
      const e = v.entity && typeof v.entity === 'object' && /^[a-z_-]{2,30}$/.test(String(v.entity.type)) && /^[A-Za-z0-9_-]{1,64}$/.test(String(v.entity.id)) ? { type: String(v.entity.type), id: String(v.entity.id), label: String(v.entity.label ?? '').slice(0, 120) } : null;
      const from = String(v.from ?? '').replace(/^\/?(app\/)?/, '').slice(0, 200);
      return { route: ROUTE_RE.test(route) ? route : '', label: String(v.label ?? '').slice(0, 120), entity: e, ...(from && ROUTE_RE.test(from) ? { from } : {}) };
    };
    // "Erledige das hier" from any record page: the record the route names – or the page the companion was opened from – is
    // resolved here (with the user's rights) when the client did not send it, so the agent knows which record is meant.
    const withRecord = async (ui: UiContext | null, ctx: Ctx): Promise<UiContext | null> => {
      if (!ui || ui.entity) return ui;
      const route = routeRecord(ui.route) ? ui.route : ui.from && routeRecord(ui.from) ? ui.from : '';
      const r = route ? await resolveRecord(makeCaller(app, ctx, userOf(ctx), ctx.locationId, 'read'), route) : null;
      return r ? { ...ui, entity: r.entity } : ui;
    };
    router.post('/api/agent/chat', 'location', (ctx) => {
      const u = ctx.user;
      if (!u) throw new HttpError(403, 'Der Agent braucht eine Anmeldung (API-Schlüssel: POST /api/agent/run).');
      const b = ctx.body ?? {};
      return sseResponse(ctx, async (emit) => {
        await run({ user: u, locationId: ctx.locationId, agentId: b.agent_id || null, conversationId: b.conversation_id || null, connection: typeof b.connection === 'string' ? b.connection.slice(0, 80) : undefined, text: String(b.message ?? ''), files: Array.isArray(b.files) ? b.files.map(String) : [], ui: await withRecord(cleanUi(b.ui), ctx), source: b.source === 'focus' ? 'focus' : 'chat', automatic: false, emit, baseCtx: ctx });
      });
    });
    router.post('/api/agent/confirm', 'location', (ctx) => {
      const u = ctx.user;
      if (!u) throw new HttpError(403, 'Nur mit Anmeldung');
      const b = ctx.body ?? {};
      const pendingId = str(b.pending_id, 'Bestätigung', { required: true });
      // Fail fast (JSON error) before the stream starts.
      const row = db.get('SELECT user_id, status, kind FROM agent_pending WHERE id = ? AND location_id = ?', pendingId, ctx.locationId);
      if (!row || row.user_id !== u.id) throw new HttpError(403, 'Diese Bestätigung gehört nicht zu dir.');
      if (row.status !== 'pending') throw new HttpError(409, 'Diese Bestätigung wurde schon verwendet oder ist abgelaufen.');
      return sseResponse(ctx, async (emit) => {
        await confirm({ user: u, locationId: ctx.locationId, pendingId, token: String(b.token ?? ''), approve: b.approve === true, argsHash: b.args_hash ? String(b.args_hash) : undefined, emit, baseCtx: ctx });
      });
    });
    /** Non-streaming run for API keys and scripts (as the agent's owner; confirmations become approvals). */
    router.post('/api/agent/run', 'location', async (ctx) => {
      const b = ctx.body ?? {};
      const agentId = str(b.agent_id, 'Agent', { max: 64 }) || null;
      let user = ctx.user;
      if (!user || ctx.viaApiKey) {
        if (!agentId) throw bad('Mit einem Schlüssel bitte agent_id angeben (der Agent läuft mit den Rechten der Person, die ihn angelegt hat).');
        const owner = app.services.agentDefs?.owner(agentId, ctx.locationId, ctx.user ?? null);
        if (!owner) throw notFound('Agent nicht gefunden oder nicht freigegeben');
        user = owner;
      }
      ctx.skipAfterWrite = true;
      return run({ user: user!, locationId: ctx.locationId, agentId, text: str(b.prompt ?? b.message, 'Auftrag', { required: true, max: 20_000 }), source: ctx.via === 'mcp' ? 'mcp' : 'chat', automatic: true, baseCtx: ctx });
    });
    router.post('/api/agent/conversations/:id/stop', 'location', (ctx) => {
      const conv = getConv(ctx.params.id, ctx.user?.id ?? '', ctx.locationId);
      active.get(conv.id)?.abort();
      app.services.agentBridge?.stop?.(conv.id);
      ctx.skipAfterWrite = true;
      return { ok: true, stopped: active.has(conv.id) };
    });

    // --- routes: history ------------------------------------------------------------------------------------
    router.get('/api/agent/conversations', 'location', (ctx) =>
      db
        .all('SELECT id, agent_id, connection, title, source, status, cost_micros, created_at, updated_at FROM agent_conversations WHERE user_id = ? AND location_id = ? ORDER BY updated_at DESC LIMIT ?', ctx.user?.id ?? '', ctx.locationId, Math.min(num(ctx.query.get('limit'), 50), 200))
        .map((c) => ({ ...c, cost_usd: c.cost_micros / 1e6 })),
    );
    router.get('/api/agent/conversations/:id', 'location', (ctx) => {
      const conv = getConv(ctx.params.id, ctx.user?.id ?? '', ctx.locationId);
      const state: LoopState = JSON.parse(conv.state || '{}');
      let confirmCard: any = null;
      if (state.awaiting?.pendingId) {
        const row = db.get(`SELECT * FROM agent_pending WHERE id = ? AND status = 'pending' AND expires_at > ?`, state.awaiting.pendingId, now());
        if (row) {
          // A reload gets a fresh one-time token (the old one stops working).
          const tok = token(24);
          db.run('UPDATE agent_pending SET token_hash = ? WHERE id = ?', sha256(tok), row.id);
          const call = state.awaiting.calls[state.awaiting.index];
          confirmCard = { pending_id: row.id, token: tok, call_id: row.call_id, tool: row.tool, klass: row.klass, args: call?.args ?? JSON.parse(row.args), args_hash: row.args_hash, summary: row.summary, target: row.target, title: toolCatalog(app, userOf(ctx), { webFetch: true }).find((t) => t.name === row.tool)?.title ?? row.tool };
        }
      }
      return { id: conv.id, agent_id: conv.agent_id, connection: conv.connection, title: conv.title, status: active.has(conv.id) ? 'running' : conv.status, error: conv.error, source: conv.source, cost_usd: conv.cost_micros / 1e6, items: uiItems(JSON.parse(conv.messages || '[]')), confirm: confirmCard };
    });
    router.delete('/api/agent/conversations/:id', 'location', (ctx) => {
      const conv = getConv(ctx.params.id, ctx.user?.id ?? '', ctx.locationId);
      active.get(conv.id)?.abort();
      db.run('DELETE FROM agent_conversations WHERE id = ?', conv.id);
      db.run(`UPDATE agent_pending SET status = 'expired' WHERE conversation_id = ? AND status = 'pending' AND kind <> 'deferred'`, conv.id);
      return { ok: true };
    });

    // --- routes: approvals (deferred actions from automations) --------------------------------------------------
    const approvalOut = (r: any) => ({ id: r.id, tool: r.tool, klass: r.klass, args: JSON.parse(r.args), summary: r.summary, target: r.target, status: r.status, agent_id: r.agent_id, agent: r.agent_id ? (app.services.agentDefs?.name?.(r.agent_id) ?? 'Agent') : DEFAULT_AGENT.name, conversation_id: r.conversation_id, result: r.result ? JSON.parse(r.result) : null, created_at: r.created_at, expires_at: r.expires_at, decided_at: r.decided_at });
    router.get('/api/agent/approvals', 'location', (ctx) => {
      const u = userOf(ctx);
      const status = ctx.query.get('status') === 'all' ? '' : `AND status = 'pending' AND expires_at > '${now()}'`;
      return db
        .all(`SELECT * FROM agent_pending WHERE location_id = ? AND kind = 'deferred' ${status} ORDER BY created_at DESC LIMIT 100`, ctx.locationId)
        .filter((r) => u.role === 'admin' || r.user_id === u.id)
        .map(approvalOut);
    });
    router.post('/api/agent/approvals/:id', 'location', async (ctx) => {
      const u = ctx.user;
      if (!u) throw new HttpError(403, 'Nur mit Anmeldung');
      const row = db.get(`SELECT * FROM agent_pending WHERE id = ? AND location_id = ? AND kind = 'deferred'`, ctx.params.id, ctx.locationId);
      if (!row || (u.role !== 'admin' && row.user_id !== u.id)) throw notFound('Freigabe nicht gefunden');
      if (row.status !== 'pending' || row.expires_at < now()) throw new HttpError(409, 'Schon entschieden oder abgelaufen.');
      const approve = ctx.body?.approve === true;
      if (db.run(`UPDATE agent_pending SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'`, approve ? 'approved' : 'rejected', now(), u.id, row.id).changes !== 1) throw new HttpError(409, 'Schon entschieden.');
      ctx.skipAfterWrite = true;
      if (!approve) return approvalOut(db.get('SELECT * FROM agent_pending WHERE id = ?', row.id));
      try {
        const out = await runTool({ user: u, locationId: ctx.locationId, name: row.tool, args: JSON.parse(row.args), allow: row.klass === 'sensitive' ? 'sensitive' : 'write', baseCtx: ctx, agentId: row.agent_id });
        db.run(`UPDATE agent_pending SET status = 'done', result = ? WHERE id = ?`, JSON.stringify(out ?? { ok: true }).slice(0, 20_000), row.id);
      } catch (e) {
        db.run(`UPDATE agent_pending SET status = 'failed', result = ? WHERE id = ?`, JSON.stringify({ error: (e as Error).message }), row.id);
      }
      return approvalOut(db.get('SELECT * FROM agent_pending WHERE id = ?', row.id));
    });

    // --- routes: misc ----------------------------------------------------------------------------------------------
    router.get('/api/agent/tools', 'location', async (ctx) =>
      withExternal(toolCatalog(app, userOf(ctx), { webFetch: true }), await externalTools(app, userOf(ctx), ctx.locationId)).map((t) => ({ name: t.name, title: t.title, description: t.description.slice(0, 300), group: t.group, klass: t.klass, source: t.source })),
    );
    router.get('/api/agent/bootstrap', 'location', (ctx) => {
      const u = userOf(ctx);
      const resolved = resolveTarget(ctx.locationId);
      const s = locSettings(ctx.locationId);
      return {
        enabled: s.enabled,
        default_agent: { id: null, name: DEFAULT_AGENT.name, emoji: DEFAULT_AGENT.emoji, description: DEFAULT_AGENT.description, mode: s.default_mode, starters: DEFAULT_STARTERS },
        agents: app.services.agentDefs?.listFor(u, ctx.locationId) ?? [],
        connection: resolved ? { id: resolved.connectionId, provider: resolved.provider, label: resolved.label, model: resolved.model, vision: resolved.capabilities.includes('vision') } : null,
        // Models the chat can switch to: every text connection plus the user's own bridge (if paired).
        models: [...(app.services.aiConnections?.list(ctx.locationId, 'text', u) ?? []).map((c: any) => ({ id: c.id, label: c.label, model: c.models?.text ?? '', provider: c.provider, vision: c.capabilities.includes('vision') })), ...(app.services.aiSubscriptions?.chatModelsFor?.(u, ctx.locationId) ?? [])],
        bridge: app.services.agentBridge?.statusFor?.(u.id) ?? null,
        approvals: db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM agent_pending WHERE location_id = ? AND kind = 'deferred' AND status = 'pending' AND expires_at > ? ${u.role === 'admin' ? '' : 'AND user_id = ?'}`, ctx.locationId, now(), ...(u.role === 'admin' ? [] : [u.id]))!.n,
      };
    });
    /** Label for the context chip ("Kontakt: Max Mustermann") – only what the user may see. */
    router.get('/api/agent/context', 'location', async (ctx) => {
      const r = await resolveRecord(makeCaller(app, ctx, userOf(ctx), ctx.locationId, 'read'), String(ctx.query.get('route') ?? ''));
      return r ? { entity: r.entity, label: r.label } : { entity: null };
    });
    router.get('/api/agent/usage', 'location', (ctx) => {
      const since = monthStart(tzOf(ctx.locationId));
      const sum = (where: string, ...p: any[]) => db.get<{ calls: number; cost: number; tokens: number }>(`SELECT COUNT(*) AS calls, COALESCE(SUM(cost_micros),0) AS cost, COALESCE(SUM(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens),0) AS tokens FROM ai_calls WHERE location_id = ? AND created_at >= ? AND status <> 'blocked' ${where}`, ctx.locationId, since, ...p)!;
      const agentCalls = sum(`AND purpose IN ('agent', 'agent_auto')`);
      const all = sum('');
      const row = db.get('SELECT data FROM ai_settings WHERE location_id = ?', ctx.locationId);
      const s = withDefaults(row ? JSON.parse(row.data || '{}') : null);
      const byAgent = db.all(`SELECT agent_id, COUNT(*) AS runs, SUM(cost_micros) AS cost, SUM(input_tokens + output_tokens) AS tokens FROM agent_runs WHERE location_id = ? AND started_at >= ? GROUP BY agent_id ORDER BY cost DESC`, ctx.locationId, since);
      const byUser = db.all(`SELECT r.user_id, u.name, COUNT(*) AS runs, SUM(r.cost_micros) AS cost FROM agent_runs r LEFT JOIN users u ON u.id = r.user_id WHERE r.location_id = ? AND r.started_at >= ? GROUP BY r.user_id ORDER BY cost DESC`, ctx.locationId, since);
      const recent = db.all(`SELECT id, agent_id, source, status, steps, input_tokens, output_tokens, cost_micros, model, error, started_at FROM agent_runs WHERE location_id = ? ORDER BY started_at DESC LIMIT 50`, ctx.locationId);
      return {
        since,
        agent: { calls: agentCalls.calls, cost_usd: agentCalls.cost / 1e6, tokens: agentCalls.tokens },
        total: { calls: all.calls, cost_usd: all.cost / 1e6, tokens: all.tokens },
        limit_usd: s.monthly_limit_usd,
        token_limit: s.monthly_token_limit,
        by_agent: byAgent.map((a) => ({ agent_id: a.agent_id, name: a.agent_id ? (app.services.agentDefs?.name?.(a.agent_id) ?? 'Gelöschter Agent') : DEFAULT_AGENT.name, runs: a.runs, cost_usd: (a.cost ?? 0) / 1e6, tokens: a.tokens ?? 0 })),
        by_user: byUser.map((a) => ({ user_id: a.user_id, name: a.name ?? '–', runs: a.runs, cost_usd: (a.cost ?? 0) / 1e6 })),
        recent: recent.map((r) => ({ ...r, cost_usd: r.cost_micros / 1e6, agent: r.agent_id ? (app.services.agentDefs?.name?.(r.agent_id) ?? '–') : DEFAULT_AGENT.name })),
      };
    });

    // Old uploads and stale confirmations go away.
    let lastClean = 0;
    app.onTick(() => {
      if (Date.now() - lastClean < 3600_000) return;
      lastClean = Date.now();
      db.run('DELETE FROM agent_files WHERE created_at < ?', new Date(Date.now() - 30 * 864e5).toISOString());
      db.run(`UPDATE agent_pending SET status = 'expired' WHERE status = 'pending' AND expires_at < ?`, now());
      db.run('DELETE FROM agent_runs WHERE started_at < ?', new Date(Date.now() - 180 * 864e5).toISOString());
    });
  },
};

/** Conversation history → what the chat shows (messages, tool cards with status and links). */
export function uiItems(history: Msg[]) {
  const results = new Map<string, Extract<Part, { type: 'tool_result' }>>();
  for (const m of history) for (const p of m.content) if (p.type === 'tool_result') results.set(p.id, p);
  const items: any[] = [];
  for (const m of history) {
    if (m.role === 'user') {
      if (m.content.some((p) => p.type === 'tool_result')) continue;
      const text = m.content.filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text').map((p) => p.text).join('\n');
      const files = m.content.filter((p) => p.type === 'image' || p.type === 'file').map((p: any) => ({ id: p.fileId, name: p.name, mime: p.mediaType ?? p.mime, image: p.type === 'image' }));
      items.push({ role: 'user', text, files });
      continue;
    }
    const text = m.content.filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text').map((p) => p.text).join('');
    const tools = m.content
      .filter((p): p is Extract<Part, { type: 'tool_call' }> => p.type === 'tool_call')
      .map((c) => {
        const r = results.get(c.id);
        const meta = (r?.meta ?? {}) as Record<string, any>;
        const raw = r?.content ?? '';
        const inner = raw.replace(/^<tool_output[^>]*>\n?/, '').replace(/\n?<\/tool_output>$/, '');
        return { id: c.id, name: c.name, title: meta.title ?? c.name, klass: meta.klass, args: c.args, status: r ? (meta.status ?? (r.isError ? 'error' : 'ok')) : 'pending', links: meta.links ?? [], preview: inner.slice(0, 2000), error: meta.error, undo: meta.undo };
      });
    // A call still waiting for its confirmation is shown as the confirmation card, not as a tool card.
    const shown = tools.filter((t) => t.status !== 'pending');
    // Consecutive assistant turns (text, tools, text …) form one bubble; the text a model writes comes before its tool calls.
    const blocks = [...(text ? [{ kind: 'text', text }] : []), ...(shown.length ? [{ kind: 'tools', tools: shown }] : [])];
    const last = items[items.length - 1];
    if (last?.role === 'assistant') last.blocks.push(...blocks);
    else items.push({ role: 'assistant', blocks });
  }
  return items;
}
