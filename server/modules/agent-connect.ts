import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Ctx, type User } from '../core/http.js';
import { id, now, sha256, token } from '../core/util.js';
import type { Tool } from './mcp.js';
import { simplifySchema, type AgentTool } from '../services/agent-tools.js';
import { bodyLocation } from '../services/mobile.js';
import { uiItems, userFromRow } from './agent.js';

/**
 * The agent outside the web chat:
 *  - "In ChatGPT / Claude nutzen": info for the MCP connector of the KI-Werkzeuge (OAuth, your own
 *    ChatGPT/Claude subscription does the chatting) and Custom GPT "Actions" – an OpenAPI 3.1 schema
 *    of a tool subset as REST endpoints under /api/agent/gpt-actions/* with a scoped bearer key
 *    (`gha_…`, per user and sub-account, read-only unless allowed; ChatGPT asks before every
 *    consequential operation).
 *  - MCP tools `ghl_list_agents` / `ghl_run_agent` (a custom agent by id within the caller's scope).
 *  - Mobile API for the Android app: `POST /api/mobile/agent` (+ confirm, list, conversation).
 */

const KEY_PREFIX = 'gha_';
const MAX_OPERATIONS = 30;
/** Agent-only tools that make no sense as REST actions (UI, uploads, own notes). */
const NOT_AS_ACTION = new Set(['navigate', 'ui_context', 'remember', 'import_contacts', 'web_fetch']);
const DEFAULT_ACTIONS = [
  'search_everything',
  'knowledge_search',
  'ghl_search_contacts',
  'ghl_get_contact',
  'ghl_upsert_contact',
  'ghl_add_note',
  'ghl_list_opportunities',
  'ghl_create_opportunity',
  'ghl_update_opportunity',
  'ghl_list_pipelines',
  'ghl_list_tasks',
  'ghl_create_task',
  'ghl_update_task',
  'ghl_complete_task',
  'ghl_list_appointments',
  'ghl_update_appointment',
  'ghl_list_conversations',
  'ghl_get_conversation',
  'ghl_draft_email',
  'ghl_draft_message',
  'ghl_dashboard',
  'ghl_list_tickets',
  'ghl_create_ticket',
  'create_report_from_question',
  'ghl_list_social_posts',
];

const MCP_TOOLS: Tool[] = [
  {
    name: 'ghl_list_agents',
    title: 'KI-Agenten auflisten',
    description: 'Die eigenen KI-Agenten eines Sub-Accounts (id, Name, Rolle, Modus) – für ghl_run_agent. Private Agenten nur für die Person, die sie angelegt hat.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } }, required: ['location_id'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call, a) => (await call.api('GET', '/api/agents', { location: a.location_id })).map((x: any) => ({ id: x.id, name: x.name, emoji: x.emoji, description: x.description, mode: x.mode, starters: x.starters })),
  },
  {
    name: 'ghl_run_agent',
    title: 'KI-Agent ausführen',
    description:
      'Führt einen eigenen KI-Agenten mit einem Auftrag aus (z. B. „Fasse die offenen Deals zusammen“). Der Agent arbeitet mit den Rechten der Person, die ihn angelegt hat, nur in diesem Sub-Account und in seinem Sicherheitsmodus; Aktionen, die eine Bestätigung brauchen, landen unter KI-Agenten → Freigaben. Kostet Tokens (Monatslimit des Sub-Accounts).',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID' }, agent_id: { type: 'string', description: 'aus ghl_list_agents' }, prompt: { type: 'string' } }, required: ['location_id', 'agent_id', 'prompt'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async (call, a) => {
      const r = await call.api('POST', '/api/agent/run', { location: a.location_id, body: { agent_id: a.agent_id, prompt: a.prompt } });
      return { status: r.status, text: r.text, error: r.error, waiting_for_approval: r.pending?.map((p: any) => p.summary) ?? [], conversation_id: r.conversation_id };
    },
  },
];

export const agentConnectModule: Module = {
  name: 'agent-connect',
  migrations: [
    [
      '001-init',
      `CREATE TABLE agent_gpt_keys (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, user_id TEXT NOT NULL,
        name TEXT NOT NULL, prefix TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, tools TEXT NOT NULL DEFAULT '[]',
        allow_write INTEGER NOT NULL DEFAULT 0, allow_sensitive INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_used_at TEXT
      );`,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const svc = () => app.services.agent;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...MCP_TOOLS];

    /** A tool catalogue as a client login sees it (no agency-only tools, location fixed by the key). */
    const memberView: User = { id: '', email: '', name: '', role: 'member', locations: [], permissions: null };
    const actionTools = (): AgentTool[] => (svc().toolCatalog(memberView, false) as AgentTool[]).filter((t) => !NOT_AS_ACTION.has(t.name));

    // --- Custom GPT actions --------------------------------------------------------------------------------
    const keyOut = (k: any) => ({ id: k.id, name: k.name, prefix: k.prefix, tools: JSON.parse(k.tools), allow_write: !!k.allow_write, allow_sensitive: !!k.allow_sensitive, created_at: k.created_at, last_used_at: k.last_used_at, openapi_url: `${app.baseUrl()}/api/agent/gpt-actions/openapi.json?k=${k.id}` });
    const pickTools = (v: unknown): string[] => {
      const known = new Set(actionTools().map((t) => t.name));
      const list = Array.isArray(v) && v.length ? v.map(String) : DEFAULT_ACTIONS;
      const out = [...new Set(list.filter((n) => known.has(n)))].slice(0, MAX_OPERATIONS);
      if (!out.length) throw bad('Bitte mindestens ein Werkzeug wählen.');
      return out;
    };
    /** Routes that act as a person: sub-account API keys get a clean 403 instead of a crash. */
    const userOf = (ctx: Ctx): User => {
      if (!ctx.user) throw new HttpError(403, 'Nur mit Anmeldung (nicht mit einem API-Schlüssel)');
      return ctx.user;
    };
    router.get('/api/agent/gpt-actions/keys', 'location', (ctx) => {
      const u = userOf(ctx);
      return db.all('SELECT * FROM agent_gpt_keys WHERE location_id = ? ORDER BY created_at DESC', ctx.locationId).filter((k) => u.role === 'admin' || k.user_id === u.id).map(keyOut);
    });
    router.get('/api/agent/gpt-actions/tools', 'location', () => actionTools().map((t) => ({ name: t.name, title: t.title, group: t.group, klass: t.klass, default: DEFAULT_ACTIONS.includes(t.name) })));
    router.post('/api/agent/gpt-actions/keys', 'location', (ctx) => {
      const u = ctx.user;
      if (!u || ctx.via !== 'session') throw new HttpError(403, 'Schlüssel bitte angemeldet im Browser anlegen.');
      if (svc().agencySettings().gpt_actions_enabled === false) throw new HttpError(403, 'Custom-GPT-Aktionen sind für diese Agentur ausgeschaltet.');
      const b = ctx.body ?? {};
      if (b.allow_sensitive && u.role !== 'admin') throw new HttpError(403, 'Versenden, Löschen und Zahlungen kann nur ein Agentur-Admin freigeben.');
      const key = `${KEY_PREFIX}${token(32)}`;
      const row = { id: id(), location_id: ctx.locationId, user_id: u.id, name: str(b.name, 'Name', { max: 80 }) || 'Custom GPT', prefix: key.slice(0, 12), key_hash: sha256(key), tools: JSON.stringify(pickTools(b.tools)), allow_write: b.allow_write ? 1 : 0, allow_sensitive: b.allow_write && b.allow_sensitive ? 1 : 0, created_at: now() };
      db.insert('agent_gpt_keys', row);
      return { ...keyOut(row), key };
    });
    router.delete('/api/agent/gpt-actions/keys/:id', 'location', (ctx) => {
      const u = userOf(ctx);
      const k = db.get('SELECT * FROM agent_gpt_keys WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!k || (u.role !== 'admin' && k.user_id !== u.id)) throw notFound('Schlüssel nicht gefunden');
      db.run('DELETE FROM agent_gpt_keys WHERE id = ?', k.id);
      return { ok: true, id: k.id, name: k.name };
    });

    /** OpenAPI 3.1 for a Custom GPT: one POST operation per tool (the schema holds no secrets). */
    const openapi = (toolNames: string[], locationName: string) => {
      const tools = actionTools().filter((t) => toolNames.includes(t.name));
      const paths: Record<string, unknown> = {};
      for (const t of tools) {
        const schema = simplifySchema(t.inputSchema);
        schema.type = 'object';
        schema.properties ??= {};
        paths[`/api/agent/gpt-actions/tools/${t.name}`] = {
          post: {
            operationId: t.name,
            summary: t.title.slice(0, 80),
            description: t.description.replace(/\s+/g, ' ').slice(0, 300),
            'x-openai-isConsequential': t.klass !== 'read',
            requestBody: { required: true, content: { 'application/json': { schema } } },
            responses: {
              '200': { description: 'Ergebnis', content: { 'application/json': { schema: { type: 'object', properties: { result: {} }, additionalProperties: true } } } },
              '401': { description: 'Schlüssel fehlt oder ungültig' },
              '403': { description: 'Nicht erlaubt (nur lesen, fehlende Rechte)' },
            },
          },
        };
      }
      return {
        openapi: '3.1.0',
        info: { title: `HyperLevel – ${locationName}`.slice(0, 100), version: '1.0.0', description: 'CRM-Aktionen für einen Custom GPT: Kontakte, Deals, Aufgaben, Posteingang, Tickets, Berichte. Jede Aktion läuft mit den Rechten des Schlüssels und landet im Protokoll.' },
        servers: [{ url: app.baseUrl() }],
        paths,
        components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } }, schemas: {} },
        security: [{ bearerAuth: [] }],
      };
    };
    router.get('/api/agent/gpt-actions/openapi.json', 'public', (ctx) => {
      const k = ctx.query.get('k') ? db.get('SELECT * FROM agent_gpt_keys WHERE id = ?', String(ctx.query.get('k'))) : null;
      const loc = k ? app.location(k.location_id) : null;
      const doc = openapi(k ? JSON.parse(k.tools) : DEFAULT_ACTIONS, loc?.name ?? 'CRM');
      return { __raw: true, status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' }, body: JSON.stringify(doc, null, 2) };
    });
    app.services.agentOpenApi = openapi;

    /** One action call from ChatGPT: bearer gha_ key → tool as the key's user, limited to its sub-account and tools. */
    router.post('/api/agent/gpt-actions/tools/:name', 'public', async (ctx) => {
      const bearer = String(ctx.req.headers.authorization ?? '').match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
      const fail = (status: number, error: string) => ({ __raw: true as const, status, headers: { 'content-type': 'application/json; charset=utf-8', ...(status === 401 ? { 'www-authenticate': 'Bearer realm="gpt-actions"' } : {}) }, body: JSON.stringify({ error }) });
      if (!bearer.startsWith(KEY_PREFIX)) return fail(401, 'Authorization: Bearer gha_… fehlt');
      const k = db.get('SELECT * FROM agent_gpt_keys WHERE key_hash = ?', sha256(bearer));
      if (!k) return fail(401, 'Ungültiger Schlüssel');
      const tools: string[] = JSON.parse(k.tools);
      if (!tools.includes(ctx.params.name)) return fail(403, 'Dieses Werkzeug ist für den Schlüssel nicht freigegeben');
      const owner = db.get('SELECT * FROM users WHERE id = ?', k.user_id);
      if (!owner) return fail(401, 'Die Person hinter dem Schlüssel gibt es nicht mehr');
      const full = userFromRow(owner);
      if (full.role !== 'admin' && !full.locations.includes(k.location_id)) return fail(403, 'Kein Zugriff mehr auf diesen Sub-Account');
      const user: User = { ...full, name: `${full.name} (Custom GPT)`, role: 'member', locations: [k.location_id], permissions: full.role === 'admin' ? null : full.permissions };
      db.run('UPDATE agent_gpt_keys SET last_used_at = ? WHERE id = ?', now(), k.id);
      const args = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {};
      try {
        const result = await svc().runTool({ user, locationId: k.location_id, name: ctx.params.name, args, allow: k.allow_sensitive ? 'sensitive' : k.allow_write ? 'write' : 'read', baseCtx: { ...ctx, locationId: k.location_id } as Ctx });
        return { __raw: true, status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ result: result ?? { ok: true } }).slice(0, 200_000) };
      } catch (e) {
        return fail(e instanceof HttpError ? e.status : 500, (e as Error).message);
      }
    });

    // --- "In ChatGPT / Claude nutzen" ---------------------------------------------------------------------------
    router.get('/api/agent/connect', 'location', (ctx) => {
      const a = svc().agencySettings();
      return {
        mcp_url: `${app.baseUrl()}/mcp`,
        oauth: Array.isArray(app.services.mcpAuth) && app.services.mcpAuth.length > 0,
        ai_tools_page: ctx.user?.role === 'admin' ? 'agency/ai-tools' : 'settings/ai-tools',
        gpt_actions: { enabled: a.gpt_actions_enabled !== false, openapi_url: `${app.baseUrl()}/api/agent/gpt-actions/openapi.json`, max_operations: MAX_OPERATIONS },
        bridge: { enabled: !!a.bridge_enabled, ...(app.services.agentBridge?.statusFor?.(ctx.user?.id ?? '') ?? {}) },
      };
    });

    // --- mobile API (Android app, bearer ghm_) -----------------------------------------------------------------------
    const mobileOut = (r: any) => ({
      conversation_id: r.conversation_id,
      status: r.status,
      text: r.text,
      error: r.error ?? null,
      tools: r.tools,
      confirmation: r.pending.find((p: any) => !p.deferred) ?? null,
      approvals: r.pending.filter((p: any) => p.deferred).map((p: any) => ({ id: p.id, summary: p.summary })),
    });
    router.get('/api/mobile/agent', 'user', (ctx) => {
      const loc = bodyLocation(app, ctx, ctx.query.get('location'));
      const u = userOf(ctx);
      return {
        default_agent: { id: null, name: 'HyperLevel Agent', emoji: '✨' },
        agents: app.services.agentDefs?.listFor(u, loc.id) ?? [],
        connection: (() => {
          const r = svc().resolveTarget(loc.id);
          return r ? { label: r.label, model: r.model } : null;
        })(),
        conversations: db.all('SELECT id, agent_id, title, status, updated_at FROM agent_conversations WHERE user_id = ? AND location_id = ? ORDER BY updated_at DESC LIMIT 20', u.id, loc.id),
      };
    });
    router.get('/api/mobile/agent/conversations/:id', 'user', (ctx) => {
      const loc = bodyLocation(app, ctx, ctx.query.get('location'));
      const c = db.get('SELECT * FROM agent_conversations WHERE id = ? AND user_id = ? AND location_id = ?', ctx.params.id, userOf(ctx).id, loc.id);
      if (!c) throw notFound('Unterhaltung nicht gefunden');
      return { id: c.id, title: c.title, status: c.status, items: uiItems(JSON.parse(c.messages || '[]')) };
    });
    router.post('/api/mobile/agent', 'user', async (ctx) => {
      const b = ctx.body ?? {};
      const loc = bodyLocation(app, ctx, b.location_id);
      ctx.skipAfterWrite = true;
      const r = await svc().run({ user: userOf(ctx), locationId: loc.id, agentId: b.agent_id || null, conversationId: b.conversation_id || null, text: str(b.message, 'Nachricht', { required: true, max: 20_000 }), source: 'mobile', automatic: false, baseCtx: ctx });
      return mobileOut(r);
    });
    router.post('/api/mobile/agent/confirm', 'user', async (ctx) => {
      const b = ctx.body ?? {};
      const loc = bodyLocation(app, ctx, b.location_id);
      ctx.skipAfterWrite = true;
      const r = await svc().confirm({ user: userOf(ctx), locationId: loc.id, pendingId: str(b.pending_id, 'Bestätigung', { required: true }), token: String(b.token ?? ''), approve: b.approve === true, baseCtx: ctx });
      return mobileOut(r);
    });
  },
};
