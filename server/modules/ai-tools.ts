import type { App, Module } from '../core/app.js';
import { HttpError, notFound, str, type Ctx } from '../core/http.js';
import { id, now, sha256, token } from '../core/util.js';

/**
 * "KI-Werkzeuge verbinden": one click creates a scoped key for Codex, Claude Code, Cursor & Co. – a
 * sub-account key (pghl_…) on the sub-account page, an agency key (pghla_…) only on the agency page
 * (admins) –, lists keys with "last used", revokes them, lists the apps connected via OAuth
 * (modules/mcp-oauth.ts) and tests a key with a real MCP initialize + tools/list against this instance.
 * The copy-paste setup snippets are built in the browser (web/src/pages/AiTools.tsx) from `mcp_url`.
 */

export const AI_TOOLS: Record<string, string> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  other: 'KI-Werkzeug',
};

type Filter = { locationId?: string; agency?: boolean };

/** Runs MCP initialize + tools/list with the key against our own /mcp (same code path as any client). */
export async function probeMcp(app: App, key: string) {
  const post = async (body: unknown) => {
    const r = await fetch(`${app.selfUrl}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await r.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { status: r.status, data };
  };
  const started = Date.now();
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gohigh-verbindungstest', version: '1.0.0' } } });
  if (init.status === 401) return { ok: false, step: 'initialize', error: 'Schlüssel ungültig oder widerrufen' };
  if (init.status !== 200 || !init.data?.result) return { ok: false, step: 'initialize', error: init.data?.error?.message ?? `HTTP ${init.status}` };
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools: any[] = list.data?.result?.tools ?? [];
  if (list.status !== 200 || !Array.isArray(list.data?.result?.tools)) return { ok: false, step: 'tools/list', error: list.data?.error?.message ?? `HTTP ${list.status}` };
  return {
    ok: true,
    server: init.data.result.serverInfo?.title ?? init.data.result.serverInfo?.name ?? '',
    protocol: init.data.result.protocolVersion,
    tools: tools.length,
    sample: tools.slice(0, 8).map((t) => t.name),
    ms: Date.now() - started,
  };
}

export const aiToolsModule: Module = {
  name: 'ai-tools',
  migrations: [
    [
      '001-init',
      `CREATE TABLE ai_tool_keys (
        key_id TEXT PRIMARY KEY, kind TEXT NOT NULL, tool TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL
      );`,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const mcpUrl = () => `${app.baseUrl()}/mcp`;
    const audit = (a: Record<string, unknown>) => app.services.audit?.(a);
    // Keys are made by a person signed in to the app – never by another key or token.
    const person = (ctx: Ctx) => {
      if (ctx.via !== 'session' || !ctx.user) throw new HttpError(403, 'Schlüssel nur mit Anmeldung im Browser anlegen');
      return ctx.user;
    };
    const toolOf = (v: unknown) => (typeof v === 'string' && v in AI_TOOLS ? v : 'other');
    const nameOf = (tool: string, label: unknown) => {
      const l = str(label, 'Name', { max: 60 }).replace(/[\u0000-\u001f]/g, '');
      return `${AI_TOOLS[tool]} – ${l || 'Gerät'}`;
    };
    const apps = (f: Filter) => (app.services.mcpOAuth?.list(f) ?? []) as unknown[];
    const revokeApp = (ctx: Ctx, grantId: string, f: Filter) => {
      person(ctx);
      if (!app.services.mcpOAuth?.revoke(grantId, f, ctx)) throw notFound('Verbindung nicht gefunden');
      return { ok: true };
    };

    // Integrations catalogue: status of keys and OAuth connections per sub-account / agency.
    const count = (sql: string, ...p: string[]) => Number(db.get(sql, ...p)?.n ?? 0);
    const status = (keys: number, apps: number) => {
      const parts = [keys && `${keys} Schlüssel`, apps && `${apps} ${apps === 1 ? 'App' : 'Apps'}`].filter(Boolean).join(' · ');
      return parts ? { status: 'ok' as const, detail: parts } : { status: 'info' as const, detail: 'Bereit – Schlüssel anlegen oder App verbinden' };
    };
    app.services.catalogExtra = [
      ...(app.services.catalogExtra ?? []),
      {
        entry: {
          key: 'ai_tools',
          name: 'Codex, ChatGPT, Claude & Cursor (KI-Werkzeuge)',
          category: 'KI',
          icon: 'aiTools',
          scope: 'both',
          setup: { location: 'settings/ai-tools', agency: 'agency/ai-tools' },
          description: 'OpenAI Codex (CLI/IDE), Claude Code, Cursor sowie ChatGPT- und Claude.ai-Konnektoren arbeiten über MCP direkt mit Kontakten, Deals, Aufgaben und Posteingang.',
          credentials: 'Ein Schlüssel je Werkzeug (ein Klick unter Einstellungen → KI-Werkzeuge) oder ohne Schlüssel per OAuth-Anmeldung (ChatGPT, Claude.ai, codex mcp login).',
          docs: 'docs/ai-tools.md',
          guide: ['Einstellungen → KI-Werkzeuge → Werkzeug und Gerät wählen → „Schlüssel erzeugen“.', 'Den angezeigten Schnipsel übernehmen (Codex: ~/.codex/config.toml, Claude Code: claude mcp add …, Cursor: mcp.json) und „Verbindung testen“.', 'ChatGPT/Claude.ai: Konnektor mit der MCP-Adresse anlegen, im Login den Sub-Account wählen und zulassen.'],
        },
        location: (_ctx: Ctx, loc: string) => status(count('SELECT COUNT(*) AS n FROM api_keys WHERE location_id = ?', loc), apps({ locationId: loc }).length),
        agency: () => status(count('SELECT COUNT(*) AS n FROM agency_api_keys'), apps({ agency: true }).length),
      },
    ];

    // --- sub-account ----------------------------------------------------------------------
    router.get('/api/ai-tools', 'location', (ctx) => ({
      mcp_url: mcpUrl(),
      oauth: !!app.services.mcpOAuth,
      tools: AI_TOOLS,
      keys: db.all(
        `SELECT k.id, k.name, k.prefix, k.created_at, k.last_used_at, m.tool FROM api_keys k LEFT JOIN ai_tool_keys m ON m.key_id = k.id
         WHERE k.location_id = ? ORDER BY k.created_at DESC`,
        ctx.locationId,
      ),
      apps: apps({ locationId: ctx.locationId }),
    }));
    /** Always a sub-account key (pghl_…), whoever asks and whatever the body says. */
    router.post('/api/ai-tools/keys', 'location', (ctx) => {
      const u = person(ctx);
      const tool = toolOf(ctx.body?.tool);
      const key = `pghl_${token(24)}`;
      const row = { id: id(), location_id: ctx.locationId, name: nameOf(tool, ctx.body?.label), key_hash: sha256(key), prefix: key.slice(0, 10), created_at: now() };
      db.insert('api_keys', row);
      db.insert('ai_tool_keys', { key_id: row.id, kind: 'location', tool, created_by: u.id, created_at: row.created_at });
      audit({ ctx, action: 'ai_tools.key.create', summary: row.name, entityId: row.id });
      return { id: row.id, name: row.name, prefix: row.prefix, tool, key, scope: 'location', mcp_url: mcpUrl() };
    });
    router.delete('/api/ai-tools/keys/:id', 'location', (ctx) => {
      person(ctx);
      const k = db.get('SELECT id, name FROM api_keys WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!k) throw notFound('Schlüssel nicht gefunden');
      db.run('DELETE FROM api_keys WHERE id = ?', k.id);
      db.run('DELETE FROM ai_tool_keys WHERE key_id = ?', k.id);
      return { ok: true, name: k.name };
    });
    router.delete('/api/ai-tools/apps/:id', 'location', (ctx) => revokeApp(ctx, ctx.params.id, { locationId: ctx.locationId }));
    /** MCP initialize + tools/list with a key of this sub-account. */
    router.post('/api/ai-tools/test', 'location', async (ctx) => {
      person(ctx);
      const key = str(ctx.body?.key, 'Schlüssel', { required: true, max: 200 });
      const k = key.startsWith('pghl_') ? db.get('SELECT location_id FROM api_keys WHERE key_hash = ?', sha256(key)) : undefined;
      if (!k) throw new HttpError(400, 'Unbekannter Schlüssel – bitte einen Sub-Account-Schlüssel (pghl_…) einfügen');
      if (k.location_id !== ctx.locationId) throw new HttpError(403, 'Dieser Schlüssel gehört zu einem anderen Sub-Account');
      return probeMcp(app, key);
    });

    // --- agency (admins only) ---------------------------------------------------------------
    router.get('/api/agency/ai-tools', 'admin', (ctx) => {
      person(ctx);
      return {
        mcp_url: mcpUrl(),
        oauth: !!app.services.mcpOAuth,
        tools: AI_TOOLS,
        keys: db.all(`SELECT k.id, k.name, k.prefix, k.scope, k.created_at, k.last_used_at, m.tool FROM agency_api_keys k LEFT JOIN ai_tool_keys m ON m.key_id = k.id ORDER BY k.created_at DESC`),
        apps: apps({ agency: true }),
      };
    });
    router.post('/api/agency/ai-tools/keys', 'admin', (ctx) => {
      const u = person(ctx);
      if (u.role !== 'admin') throw new HttpError(403, 'Nur für Admins');
      const tool = toolOf(ctx.body?.tool);
      const key = `pghla_${token(32)}`;
      const row = { id: id(), name: nameOf(tool, ctx.body?.label), prefix: key.slice(0, 12), key_hash: sha256(key), scope: ctx.body?.scope === 'read' ? 'read' : 'write', created_by: u.id, created_at: now() };
      db.insert('agency_api_keys', row);
      db.insert('ai_tool_keys', { key_id: row.id, kind: 'agency', tool, created_by: u.id, created_at: row.created_at });
      audit({ ctx, action: 'ai_tools.agency_key.create', summary: `${row.name} (${row.scope === 'read' ? 'nur lesen' : 'lesen & schreiben'})`, entityId: row.id });
      return { id: row.id, name: row.name, prefix: row.prefix, tool, key, scope: row.scope, mcp_url: mcpUrl() };
    });
    router.delete('/api/agency/ai-tools/keys/:id', 'admin', (ctx) => {
      person(ctx);
      const k = db.get('SELECT id, name FROM agency_api_keys WHERE id = ?', ctx.params.id);
      if (!k) throw notFound('Schlüssel nicht gefunden');
      db.run('DELETE FROM agency_api_keys WHERE id = ?', k.id);
      db.run('DELETE FROM ai_tool_keys WHERE key_id = ?', k.id);
      return { ok: true, name: k.name };
    });
    router.delete('/api/agency/ai-tools/apps/:id', 'admin', (ctx) => revokeApp(ctx, ctx.params.id, { agency: true }));
    router.post('/api/agency/ai-tools/test', 'admin', async (ctx) => {
      person(ctx);
      const key = str(ctx.body?.key, 'Schlüssel', { required: true, max: 200 });
      const known = key.startsWith('pghla_') ? db.get('SELECT id FROM agency_api_keys WHERE key_hash = ?', sha256(key)) : key.startsWith('pghl_') ? db.get('SELECT id FROM api_keys WHERE key_hash = ?', sha256(key)) : undefined;
      if (!known) throw new HttpError(400, 'Unbekannter Schlüssel (pghla_… oder pghl_…)');
      return probeMcp(app, key);
    });
  },
};
