import { SESSION_COOKIE, type App, type Module } from '../core/app.js';
import { HttpError, bad, html, notFound, redirect, str, type Ctx } from '../core/http.js';
import { messagePage } from '../core/page.js';
import { id, now, sha256, token } from '../core/util.js';
import { ComposioError, cleanAllow, composioClient, isAllowed, signLinkState, userIdFor, verifyLinkState, WEBHOOK_EVENTS, type ComposioClient, type ExecuteResult, type ToolInfo } from '../services/composio.js';
import { coerceArgs, renderArgs } from '../services/composio-schema.js';
import { contactVars, getContact } from '../services/contacts.js';
import type { CatalogExtra } from './integrations-catalog.js';
import { openSecret, sealSecret } from './mail-sync.js';

/**
 * Composio: 250+ apps (Slack, Notion, HubSpot, Shopify, Google Sheets …) with Composio's managed
 * sign-in. The agency enters one Composio API key (sealed); a sub-account may use its own. Every
 * sub-account is one Composio user (`gohigh:<locationId>`) and connects apps through Composio's
 * hosted Connect Link, which redirects back here. Other modules (workflow action, trigger, AI, MCP)
 * use `app.services.composio` – all HTTP to Composio goes through services/composio.ts.
 */

const KEY_RE = /^[A-Za-z0-9_\-.]{10,200}$/;
const TOOLKIT_RE = /^[a-z0-9_-]{1,80}$/i;
const TOOL_RE = /^[A-Za-z0-9_]{2,150}$/;
const LINK_TTL_MS = 30 * 60_000;
const NOT_SET = 'Composio ist noch nicht eingerichtet – Agentur → Integrationen → Einrichtung (oder Apps → Composio → Einstellungen).';

export type KeyScope = 'agency' | 'location';
export interface KeyInfo {
  key: string;
  scope: KeyScope;
  source: 'agency' | 'location' | 'env';
  hint: string;
}
interface WebhookState {
  id?: string;
  url?: string;
  secret?: string;
  ours?: boolean;
  checked_at?: string;
  refreshed_at?: string;
}
export interface Connection {
  id: string;
  location_id: string;
  toolkit: string;
  toolkit_name: string;
  logo: string;
  connected_account_id: string;
  auth_config_id: string;
  scope: KeyScope;
  status: string;
  status_reason: string;
  created_at: string;
  updated_at: string;
}
export interface ExecuteOptions {
  /** Merge-field values ({{contact.*}}, {{event.*}} …); without them the arguments are used as given. */
  vars?: Record<string, unknown>;
  /** AI and MCP callers: only tools on the sub-account's allow-list. */
  enforceAllow?: boolean;
  source: 'workflow' | 'ui' | 'api' | 'mcp' | 'ai';
}
export interface AppResult extends ExecuteResult {
  tool: string;
  toolkit: string;
  ms: number;
}

/** What the other Composio modules use (app.services.composio). */
export interface ComposioApi {
  keyInfo(loc: string): KeyInfo | null;
  requireKey(loc: string): KeyInfo;
  client(info: KeyInfo): ComposioClient;
  scopeKey(loc: string, info: KeyInfo): string;
  call<T>(fn: () => Promise<T>): Promise<T>;
  activeConnection(loc: string, toolkit: string, scope: KeyScope): Connection | undefined;
  connectionByAccount(connectedAccountId: string): Connection | undefined;
  getTool(info: KeyInfo, slug: string): Promise<ToolInfo>;
  allowOf(loc: string): string[];
  searchAllowed(loc: string, query: string, toolkit?: string, limit?: number): Promise<(ToolInfo & { allowed: boolean })[]>;
  execute(loc: string, tool: string, args: unknown, opts: ExecuteOptions): Promise<AppResult>;
  ensureWebhook(loc: string): Promise<{ url: string; egress?: string }>;
  webhookSecret(scopeKey: string): string | null;
  refreshWebhookSecret(scopeKey: string): Promise<boolean>;
  setStatus(connectedAccountId: string, status: string, reason?: string): void;
}

/** Composio's account status → ours. */
export function mapStatus(s: string): string {
  switch (s.toUpperCase()) {
    case 'ACTIVE':
      return 'active';
    case 'INITIATED':
    case 'INITIALIZING':
      return 'pending';
    case 'EXPIRED':
      return 'expired';
    case 'INACTIVE':
      return 'inactive';
    case 'REVOKED':
      return 'revoked';
    default:
      return 'failed';
  }
}

export const composioModule: Module = {
  name: 'composio',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE composio_settings (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
        api_key TEXT, key_hint TEXT NOT NULL DEFAULT '', webhook TEXT NOT NULL DEFAULT '{}',
        allow TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL
      );
      CREATE TABLE composio_connections (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        toolkit TEXT NOT NULL, toolkit_name TEXT NOT NULL DEFAULT '', logo TEXT NOT NULL DEFAULT '',
        connected_account_id TEXT NOT NULL, auth_config_id TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', status_reason TEXT NOT NULL DEFAULT '', nonce TEXT, user_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX composio_conn_loc ON composio_connections(location_id, toolkit);
      CREATE INDEX composio_conn_ca ON composio_connections(connected_account_id);
      CREATE TABLE composio_calls (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        tool TEXT NOT NULL, toolkit TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, ok INTEGER NOT NULL,
        error TEXT NOT NULL DEFAULT '', log_id TEXT NOT NULL DEFAULT '', ms INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE INDEX composio_calls_loc ON composio_calls(location_id, created_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;

    // --- keys & settings ------------------------------------------------------------------
    const agency = (): { api_key?: string; key_hint?: string; webhook?: WebhookState } => {
      const row = db.get('SELECT value FROM agency_settings WHERE key = ?', 'composio');
      return row ? JSON.parse(row.value) : {};
    };
    const saveAgency = (v: Record<string, unknown>) =>
      db.run('INSERT INTO agency_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'composio', JSON.stringify(v));
    const settings = (loc: string) => {
      const row = db.get('SELECT * FROM composio_settings WHERE location_id = ?', loc);
      return { api_key: (row?.api_key as string | null) ?? null, key_hint: String(row?.key_hint ?? ''), webhook: JSON.parse(row?.webhook || '{}') as WebhookState, allow: JSON.parse(row?.allow || '[]') as string[] };
    };
    const saveSettings = (loc: string, patch: Record<string, unknown>) => {
      if (!db.get('SELECT location_id FROM composio_settings WHERE location_id = ?', loc)) db.insert('composio_settings', { location_id: loc, updated_at: now() });
      const keys = Object.keys(patch);
      db.run(`UPDATE composio_settings SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE location_id = ?`, ...keys.map((k) => (typeof patch[k] === 'object' && patch[k] !== null ? JSON.stringify(patch[k]) : (patch[k] as string | null))), now(), loc);
    };
    const open = (sealed: string | null | undefined) => {
      if (!sealed) return '';
      try {
        return openSecret(app, sealed);
      } catch {
        return '';
      }
    };
    const envKey = () => (process.env.PGHL_COMPOSIO_API_KEY ?? '').trim();
    const agencyKey = (): KeyInfo | null => {
      const a = agency();
      const k = open(a.api_key);
      if (k) return { key: k, scope: 'agency', source: 'agency', hint: a.key_hint ?? '' };
      const e = envKey();
      return e ? { key: e, scope: 'agency', source: 'env', hint: `…${e.slice(-4)}` } : null;
    };
    const keyInfo = (loc: string): KeyInfo | null => {
      const s = settings(loc);
      const k = open(s.api_key);
      if (k) return { key: k, scope: 'location', source: 'location', hint: s.key_hint };
      return agencyKey();
    };
    const requireKey = (loc: string) => {
      const k = keyInfo(loc);
      if (!k) throw new HttpError(409, NOT_SET);
      return k;
    };
    const scopeKey = (loc: string, info: KeyInfo) => (info.scope === 'location' ? loc : 'agency');
    const client = (info: KeyInfo) => composioClient({ apiKey: info.key, fetch: app.services.composioFetch });
    const call = async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof ComposioError) throw new HttpError(e.status, e.message);
        throw e;
      }
    };
    const hintOf = (k: string) => `…${k.slice(-4)}`;
    const cleanKey = (v: unknown) => {
      const k = str(v, 'API-Schlüssel', { required: true, max: 200 });
      if (!KEY_RE.test(k)) throw bad('Der Composio-API-Schlüssel sieht nicht richtig aus (Composio → Settings → API Keys).');
      return k;
    };

    // --- small cache for catalogue reads ------------------------------------------------------
    const cache = new Map<string, { at: number; value: unknown }>();
    const cached = async <T>(info: KeyInfo, key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> => {
      const k = `${sha256(info.key).slice(0, 16)}:${key}`;
      const hit = cache.get(k);
      if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
      const value = await call(fn);
      if (cache.size > 500) cache.clear();
      cache.set(k, { at: Date.now(), value });
      return value;
    };

    // --- connections ---------------------------------------------------------------------------
    const connOut = (r: any) => ({
      id: r.id,
      toolkit: r.toolkit,
      toolkit_name: r.toolkit_name || r.toolkit,
      logo: r.logo,
      status: r.status,
      status_reason: r.status_reason,
      scope: r.scope,
      connected_account_id: r.connected_account_id,
      created_at: r.created_at,
      updated_at: r.updated_at,
    });
    const connections = (loc: string) => db.all(`SELECT * FROM composio_connections WHERE location_id = ? AND status <> 'removed' ORDER BY toolkit, created_at DESC`, loc);
    const activeConnection = (loc: string, toolkit: string, scope: KeyScope) =>
      db.get(`SELECT * FROM composio_connections WHERE location_id = ? AND toolkit = ? AND scope = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`, loc, toolkit.toLowerCase(), scope) as Connection | undefined;
    const connectionByAccount = (ca: string) => db.get('SELECT * FROM composio_connections WHERE connected_account_id = ?', ca) as Connection | undefined;
    const setStatus = (ca: string, status: string, reason = '') => db.run('UPDATE composio_connections SET status = ?, status_reason = ?, updated_at = ? WHERE connected_account_id = ?', status, reason.slice(0, 300), now(), ca);

    // --- tools ---------------------------------------------------------------------------------
    const getTool = (info: KeyInfo, slug: string) => {
      if (!TOOL_RE.test(slug)) throw bad('Unbekannte Aktion');
      return cached(info, `tool:${slug.toUpperCase()}`, 30 * 60_000, () => client(info).getTool(slug.toUpperCase()));
    };
    const allowOf = (loc: string) => settings(loc).allow;

    /** Tools an AI/MCP caller may see: explicit allow-list slugs plus searches inside whole allowed apps. */
    const searchAllowed = async (loc: string, query: string, toolkit?: string, limit = 25) => {
      const info = requireKey(loc);
      const allow = allowOf(loc);
      const q = query.trim().toLowerCase();
      const out = new Map<string, ToolInfo & { allowed: boolean }>();
      const apps = allow.filter((a) => a.endsWith(':*')).map((a) => a.slice(0, -2)).filter((k) => !toolkit || k === toolkit.toLowerCase());
      const slugs = allow.filter((a) => !a.endsWith(':*'));
      if (slugs.length) {
        const r = await cached(info, `tools:${slugs.join(',')}`, 10 * 60_000, () => client(info).listTools({ toolSlugs: slugs, limit: 100 }));
        for (const t of r.items) {
          if (toolkit && t.toolkit.slug !== toolkit.toLowerCase()) continue;
          if (q && !`${t.slug} ${t.name} ${t.description} ${t.toolkit.name}`.toLowerCase().includes(q)) continue;
          out.set(t.slug, { ...t, allowed: true });
        }
      }
      for (const k of apps.slice(0, 6)) {
        const r = await cached(info, `tools:${k}:${q}`, 10 * 60_000, () => client(info).listTools({ toolkit: k, query: q || undefined, limit: 20 }));
        for (const t of r.items) if (!out.has(t.slug)) out.set(t.slug, { ...t, allowed: true });
      }
      return [...out.values()].slice(0, limit);
    };

    const logCall = (loc: string, r: { tool: string; toolkit: string; source: string; ok: boolean; error?: string; log_id?: string; ms: number }) =>
      db.insert('composio_calls', { id: id(), location_id: loc, tool: r.tool, toolkit: r.toolkit, source: r.source, ok: r.ok ? 1 : 0, error: (r.error ?? '').slice(0, 500), log_id: r.log_id ?? '', ms: r.ms, created_at: now() });

    /** One app action: allow-list, connection, merge fields, schema check, call with retries, log row. */
    const execute = async (loc: string, slug: string, rawArgs: unknown, opts: ExecuteOptions): Promise<AppResult> => {
      const info = requireKey(loc);
      let tool: ToolInfo;
      try {
        tool = await getTool(info, slug);
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) throw bad(`Unbekannte Aktion: ${slug}`);
        throw e;
      }
      if (opts.enforceAllow && !isAllowed(allowOf(loc), tool.slug, tool.toolkit.slug)) throw new HttpError(403, `Die Aktion ${tool.slug} ist für KI & MCP nicht freigegeben (Apps → Composio → KI & MCP).`);
      const conn = tool.no_auth ? undefined : activeConnection(loc, tool.toolkit.slug, info.scope);
      if (!tool.no_auth && !conn) throw new HttpError(409, `${tool.toolkit.name || tool.toolkit.slug} ist in diesem Sub-Account nicht verbunden (Apps → Composio → Verbinden).`);
      const rendered = opts.vars ? renderArgs(rawArgs ?? {}, opts.vars) : (rawArgs ?? {});
      const { args, errors } = coerceArgs(tool.input_parameters, rendered);
      if (errors.length) throw bad(`Eingaben für ${tool.name} passen nicht: ${errors.slice(0, 6).join('; ')}`);
      const started = Date.now();
      try {
        const r = await client(info).executeTool(tool.slug, { userId: userIdFor(loc), connectedAccountId: conn?.connected_account_id, arguments: args });
        const ms = Date.now() - started;
        logCall(loc, { tool: tool.slug, toolkit: tool.toolkit.slug, source: opts.source, ok: r.successful, error: r.error ?? '', log_id: r.log_id, ms });
        return { ...r, tool: tool.slug, toolkit: tool.toolkit.slug, ms };
      } catch (e) {
        logCall(loc, { tool: tool.slug, toolkit: tool.toolkit.slug, source: opts.source, ok: false, error: (e as Error).message, ms: Date.now() - started });
        if (e instanceof ComposioError) {
          if (conn && e.upstream === 422) setStatus(conn.connected_account_id, 'error', e.message);
          throw new HttpError(e.status, e.message);
        }
        throw e;
      }
    };

    // --- webhook subscription (one per Composio project = per key) --------------------------------
    const webhookStore = (sk: string): WebhookState => (sk === 'agency' ? (agency().webhook ?? {}) : settings(sk).webhook);
    const saveWebhook = (sk: string, w: WebhookState) => (sk === 'agency' ? saveAgency({ ...agency(), webhook: w }) : saveSettings(sk, { webhook: w }));
    const hookUrl = (sk: string) => `${app.baseUrl()}/hooks/composio/${sk}`;
    const keyForScope = (sk: string): KeyInfo | null => {
      if (sk === 'agency') return agencyKey();
      const k = open(settings(sk).api_key);
      return k ? { key: k, scope: 'location', source: 'location', hint: '' } : null;
    };
    const ensureWebhook = async (loc: string) => {
      const info = requireKey(loc);
      const sk = scopeKey(loc, info);
      const url = hookUrl(sk);
      const cur = webhookStore(sk);
      if (cur.secret && cur.checked_at && Date.now() - Date.parse(cur.checked_at) < 6 * 3600_000) return { url, ...(cur.ours ? {} : { egress: url }) };
      const c = client(info);
      const subs = await call(() => c.listWebhookSubscriptions());
      let sub = subs[0];
      if (!sub) sub = await call(() => c.createWebhookSubscription(url));
      else if (!sub.enabled_events.includes('composio.trigger.message')) sub = await call(() => c.updateWebhookSubscription(sub!.id, { enabled_events: [...new Set([...sub!.enabled_events, ...WEBHOOK_EVENTS])] }));
      if (!sub.secret) throw new HttpError(502, 'Composio hat kein Webhook-Secret geliefert.');
      const ours = sub.webhook_url === url;
      saveWebhook(sk, { id: sub.id, url: sub.webhook_url, secret: sealSecret(app, sub.secret), ours, checked_at: now(), refreshed_at: now() });
      return { url, ...(ours ? {} : { egress: url }) };
    };
    const webhookSecret = (sk: string) => open(webhookStore(sk).secret) || null;
    /** After a failed signature: the secret may have been rotated in Composio – fetch it again (at most every 5 minutes). */
    const refreshWebhookSecret = async (sk: string) => {
      const cur = webhookStore(sk);
      if (cur.refreshed_at && Date.now() - Date.parse(cur.refreshed_at) < 5 * 60_000) return false;
      const info = keyForScope(sk);
      if (!info) return false;
      saveWebhook(sk, { ...cur, refreshed_at: now() });
      try {
        const sub = (await client(info).listWebhookSubscriptions())[0];
        if (!sub?.secret) return false;
        saveWebhook(sk, { ...cur, id: sub.id, url: sub.webhook_url, secret: sealSecret(app, sub.secret), ours: sub.webhook_url === hookUrl(sk), refreshed_at: now(), checked_at: now() });
        return true;
      } catch {
        return false;
      }
    };

    const api: ComposioApi = { keyInfo, requireKey, client, scopeKey, call, activeConnection, connectionByAccount, getTool, allowOf, searchAllowed, execute, ensureWebhook, webhookSecret, refreshWebhookSecret, setStatus };
    app.services.composio = api;

    // --- status & settings (sub-account) ------------------------------------------------------
    const view = (ctx: Ctx) => {
      const loc = ctx.locationId;
      const s = settings(loc);
      const info = keyInfo(loc);
      const a = agencyKey();
      return {
        configured: !!info,
        source: info?.source ?? null,
        scope: info?.scope ?? null,
        key_hint: info?.hint ?? '',
        override: !!s.api_key,
        override_hint: s.key_hint,
        agency_configured: !!a,
        user_id: userIdFor(loc),
        webhook_url: hookUrl(info ? scopeKey(loc, info) : 'agency'),
        allow: s.allow,
        connections: connections(loc).map(connOut),
        is_admin: ctx.user?.role === 'admin',
      };
    };
    router.get('/api/composio', 'location', (ctx) => view(ctx));
    router.put('/api/composio/settings', 'location', (ctx) => {
      if (ctx.body.api_key === null || ctx.body.api_key === '') saveSettings(ctx.locationId, { api_key: null, key_hint: '', webhook: {} });
      else if (ctx.body.api_key !== undefined) {
        const k = cleanKey(ctx.body.api_key);
        saveSettings(ctx.locationId, { api_key: sealSecret(app, k), key_hint: hintOf(k), webhook: {} });
      }
      return view(ctx);
    });
    const test = async (info: KeyInfo, sk: string) => {
      const c = client(info);
      const configs = await call(() => c.listAuthConfigs({ limit: 1 }));
      let webhook: { exists: boolean; ours: boolean } | null = null;
      try {
        const sub = (await c.listWebhookSubscriptions())[0];
        webhook = { exists: !!sub, ours: !!sub && sub.webhook_url === hookUrl(sk) };
      } catch {
        webhook = null;
      }
      return { ok: true, source: info.source, key_hint: info.hint, auth_configs: configs.total, webhook };
    };
    router.post('/api/composio/test', 'location', async (ctx) => {
      const info = requireKey(ctx.locationId);
      return test(info, scopeKey(ctx.locationId, info));
    });
    router.put('/api/composio/allow', 'location', (ctx) => {
      let allow: string[];
      try {
        allow = cleanAllow(ctx.body.allow);
      } catch (e) {
        throw bad((e as Error).message);
      }
      saveSettings(ctx.locationId, { allow });
      return { allow };
    });
    router.get('/api/composio/calls', 'location', (ctx) =>
      db.all('SELECT id, tool, toolkit, source, ok, error, log_id, ms, created_at FROM composio_calls WHERE location_id = ? ORDER BY created_at DESC LIMIT 100', ctx.locationId).map((r) => ({ ...r, ok: !!r.ok })),
    );

    // --- agency settings ----------------------------------------------------------------------
    const agencyView = () => {
      const a = agency();
      const info = agencyKey();
      const n = (sql: string) => Number(db.get(sql)?.n ?? 0);
      return {
        key_set: !!info,
        source: info?.source ?? null,
        key_hint: info?.hint ?? '',
        webhook_url: hookUrl('agency'),
        webhook: a.webhook?.id ? { id: a.webhook.id, url: a.webhook.url ?? '', ours: !!a.webhook.ours, checked_at: a.webhook.checked_at ?? null } : null,
        overrides: n(`SELECT COUNT(*) AS n FROM composio_settings WHERE api_key IS NOT NULL`),
        connections: n(`SELECT COUNT(*) AS n FROM composio_connections WHERE status = 'active'`),
        locations: n(`SELECT COUNT(DISTINCT location_id) AS n FROM composio_connections WHERE status = 'active'`),
      };
    };
    router.get('/api/agency/composio', 'admin', () => agencyView());
    router.put('/api/agency/composio', 'admin', (ctx) => {
      const k = cleanKey(ctx.body.api_key);
      saveAgency({ api_key: sealSecret(app, k), key_hint: hintOf(k), webhook: {} });
      return agencyView();
    });
    router.delete('/api/agency/composio', 'admin', () => {
      saveAgency({});
      return agencyView();
    });
    router.post('/api/agency/composio/test', 'admin', async () => {
      const info = agencyKey();
      if (!info) throw new HttpError(409, 'Noch kein Composio-API-Schlüssel eingetragen.');
      return test(info, 'agency');
    });

    // --- catalogue ------------------------------------------------------------------------------
    router.get('/api/composio/toolkits', 'location', async (ctx) => {
      const info = requireKey(ctx.locationId);
      const search = str(ctx.query.get('search'), 'Suche', { max: 100 });
      const category = str(ctx.query.get('category'), 'Kategorie', { max: 100 });
      const cursor = str(ctx.query.get('cursor'), 'Seite', { max: 500 });
      const r = await cached(info, `tk:${search.toLowerCase()}:${category}:${cursor}`, 10 * 60_000, () => client(info).listToolkits({ search: search || undefined, category: category || undefined, cursor: cursor || undefined }));
      const state = new Map<string, string>();
      for (const c of connections(ctx.locationId)) if (c.scope === info.scope && (!state.has(c.toolkit) || c.status === 'active')) state.set(c.toolkit, c.status);
      return { ...r, items: r.items.map((t) => ({ ...t, connection: state.get(t.slug) ?? null })) };
    });
    router.get('/api/composio/categories', 'location', async (ctx) => {
      const info = requireKey(ctx.locationId);
      return cached(info, 'categories', 6 * 3600_000, () => client(info).categories());
    });

    // --- connect (hosted Connect Link) -----------------------------------------------------------
    router.post('/api/composio/connections', 'location', async (ctx) => {
      const sid = ctx.cookies[SESSION_COOKIE];
      if (!sid || ctx.via !== 'session') throw new HttpError(403, 'Apps verbinden geht nur angemeldet im Browser.');
      const toolkit = str(ctx.body.toolkit, 'App', { required: true, max: 80 }).toLowerCase();
      if (!TOOLKIT_RE.test(toolkit)) throw bad('Unbekannte App');
      const loc = ctx.locationId;
      const info = requireKey(loc);
      const c = client(info);
      const tk = await cached(info, `toolkit:${toolkit}`, 3600_000, () => c.getToolkit(toolkit));
      if (tk.no_auth) throw bad(`${tk.name} braucht keine Verbindung – die Aktionen gehen sofort.`);
      const configs = await call(() => c.listAuthConfigs({ toolkit }));
      const usable = configs.items.filter((x) => x.enabled && x.toolkit === toolkit);
      let authConfigId = (usable.find((x) => x.managed) ?? usable[0])?.id;
      if (!authConfigId) {
        try {
          authConfigId = await c.createManagedAuthConfig(toolkit);
        } catch (e) {
          if (e instanceof ComposioError && e.status === 400) throw bad(`Für ${tk.name} gibt es bei Composio keine fertige Anmeldung. Leg im Composio-Dashboard unter „Auth Configs“ eine an (z. B. mit eigener OAuth-App) und versuch es erneut.`);
          throw e instanceof ComposioError ? new HttpError(e.status, e.message) : e;
        }
      }
      const nonce = token(18);
      const state = signLinkState(app.config.secret, { n: nonce, l: loc, u: ctx.user!.id, s: sha256(sid), e: Date.now() + LINK_TTL_MS });
      const link = await call(() => c.createLink({ authConfigId: authConfigId!, userId: userIdFor(loc), callbackUrl: `${app.baseUrl()}/composio/callback?state=${encodeURIComponent(state)}` }));
      db.run(`DELETE FROM composio_connections WHERE location_id = ? AND status = 'pending' AND created_at < ?`, loc, new Date(Date.now() - 24 * 3600_000).toISOString());
      const row = {
        id: id(),
        location_id: loc,
        toolkit,
        toolkit_name: tk.name.slice(0, 120),
        logo: tk.logo,
        connected_account_id: link.connected_account_id || `pending:${nonce}`,
        auth_config_id: authConfigId,
        scope: info.scope,
        status: 'pending',
        status_reason: '',
        nonce,
        user_id: ctx.user!.id,
        created_at: now(),
        updated_at: now(),
      };
      db.insert('composio_connections', row);
      app.services.audit?.({ ctx, action: 'composio.connect', summary: `App verbinden: ${tk.name}`, locationId: loc, entityId: row.id });
      return { url: link.redirect_url, id: row.id };
    });

    const back = (params: Record<string, string>) => redirect(`/app/apps/composio?${new URLSearchParams(params)}`);
    router.get('/composio/callback', 'public', async (ctx) => {
      const sid = ctx.cookies[SESSION_COOKIE];
      const user = sid ? db.get(`SELECT u.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`, sha256(sid), now()) : undefined;
      if (!user) return html(messagePage('Nicht angemeldet', 'Bitte zuerst anmelden und die App dann noch einmal verbinden.'), 401);
      let st;
      try {
        st = verifyLinkState(app.config.secret, String(ctx.query.get('state') ?? ''), sha256(sid!));
        if (st.u !== user.id) throw new Error('Das Verbinden gehört zu einer anderen Anmeldung');
      } catch (e) {
        return html(messagePage('Verbinden fehlgeschlagen', (e as Error).message), 400);
      }
      const row = db.get('SELECT * FROM composio_connections WHERE nonce = ?', st.n);
      if (!row || row.location_id !== st.l || row.user_id !== user.id || row.status !== 'pending') return back({ composio: 'error', msg: 'Dieser Anmelde-Link ist abgelaufen oder wurde schon benutzt – bitte noch einmal verbinden.' });
      db.run('UPDATE composio_connections SET nonce = NULL, updated_at = ? WHERE id = ?', now(), row.id);
      const fail = (msg: string) => {
        db.run(`UPDATE composio_connections SET status = 'failed', status_reason = ?, updated_at = ? WHERE id = ?`, msg.slice(0, 300), now(), row.id);
        return back({ composio: 'error', app: row.toolkit, msg });
      };
      if (ctx.query.get('status') === 'failed') return fail('Die Anmeldung bei der App wurde abgebrochen oder abgelehnt.');
      // Callback parameters alone prove nothing: the account must be the one this attempt created.
      const returned = String(ctx.query.get('connected_account_id') ?? ctx.query.get('connectedAccountId') ?? '');
      const placeholder = String(row.connected_account_id).startsWith('pending:');
      const expected = placeholder ? returned : row.connected_account_id;
      if (!expected || (returned && returned !== expected)) return fail('Die Rückmeldung von Composio passt nicht zu diesem Verbindungsversuch.');
      const info = keyInfo(row.location_id);
      if (!info || info.scope !== row.scope) return fail('Der Composio-Schlüssel wurde inzwischen geändert – bitte noch einmal verbinden.');
      try {
        // Without an id from the link call, the account must at least belong to this sub-account's Composio user.
        if (placeholder && !(await client(info).listConnectedAccounts({ userId: userIdFor(row.location_id), toolkit: row.toolkit })).some((a) => a.id === expected)) {
          return fail('Composio kennt dieses Konto für diesen Sub-Account nicht.');
        }
        const acc = await client(info).getConnectedAccount(expected);
        if (acc.toolkit && acc.toolkit !== row.toolkit) return fail('Composio meldet eine andere App als erwartet.');
        if (acc.user_id && acc.user_id !== userIdFor(row.location_id)) return fail('Composio meldet einen anderen Sub-Account als erwartet.');
        const status = mapStatus(acc.status);
        db.run('UPDATE composio_connections SET connected_account_id = ?, status = ?, status_reason = ?, updated_at = ? WHERE id = ?', acc.id || expected, status, acc.status_reason.slice(0, 300), now(), row.id);
        if (status === 'failed' || status === 'expired' || status === 'revoked') return back({ composio: 'error', app: row.toolkit, msg: acc.status_reason || 'Die Verbindung ist nicht aktiv.' });
        app.services.audit?.({ ctx, action: 'composio.connected', summary: `App verbunden: ${row.toolkit_name || row.toolkit}`, userId: user.id, locationId: row.location_id, entityId: row.id });
        return back({ composio: status === 'active' ? 'ok' : 'pending', app: row.toolkit });
      } catch (e) {
        return fail((e as Error).message);
      }
    });

    router.get('/api/composio/connections', 'location', async (ctx) => {
      const loc = ctx.locationId;
      if (ctx.query.get('refresh') === '1') {
        const info = requireKey(loc);
        const remote = await call(() => client(info).listConnectedAccounts({ userId: userIdFor(loc) }));
        const byId = new Map(remote.map((a) => [a.id, a] as const));
        for (const r of connections(loc)) {
          if (r.scope !== info.scope) continue;
          const a = byId.get(r.connected_account_id);
          if (a) db.run('UPDATE composio_connections SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?', mapStatus(a.status), a.status_reason.slice(0, 300), now(), r.id);
          else if (r.status === 'active' || Date.parse(r.created_at) < Date.now() - 3600_000) db.run(`UPDATE composio_connections SET status = 'removed', updated_at = ? WHERE id = ?`, now(), r.id);
        }
      }
      return connections(loc).map(connOut);
    });
    router.delete('/api/composio/connections/:id', 'location', async (ctx) => {
      const row = db.get('SELECT * FROM composio_connections WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!row) throw notFound();
      const info = keyInfo(ctx.locationId);
      if (info && info.scope === row.scope && !String(row.connected_account_id).startsWith('pending:')) {
        try {
          await client(info).deleteConnectedAccount(row.connected_account_id);
        } catch (e) {
          if (!(e instanceof ComposioError && e.status === 404)) throw new HttpError(e instanceof ComposioError ? e.status : 502, (e as Error).message);
        }
      }
      db.run('DELETE FROM composio_connections WHERE id = ?', row.id);
      app.services.composioTriggers?.onDisconnect?.(ctx.locationId, row.connected_account_id);
      app.services.audit?.({ ctx, action: 'composio.disconnect', summary: `App getrennt: ${row.toolkit_name || row.toolkit}`, locationId: ctx.locationId, entityId: row.id });
      return { ok: true };
    });

    // --- actions (tools) ---------------------------------------------------------------------------
    const machine = (ctx: Ctx) => ctx.via !== 'session';
    router.get('/api/composio/tools', 'location', async (ctx) => {
      const toolkit = str(ctx.query.get('toolkit'), 'App', { max: 80 }).toLowerCase();
      if (toolkit && !TOOLKIT_RE.test(toolkit)) throw bad('Unbekannte App');
      const search = str(ctx.query.get('search') ?? ctx.query.get('q'), 'Suche', { max: 200 });
      const allow = allowOf(ctx.locationId);
      if (machine(ctx)) return { items: await searchAllowed(ctx.locationId, search, toolkit || undefined, 30) };
      const info = requireKey(ctx.locationId);
      const r = await cached(info, `tools:${toolkit}:${search.toLowerCase()}`, 10 * 60_000, () => client(info).listTools({ toolkit: toolkit || undefined, query: search || undefined, limit: 60 }));
      return { items: r.items.map((t) => ({ ...t, allowed: isAllowed(allow, t.slug, t.toolkit.slug) })), total: r.total };
    });
    router.get('/api/composio/tools/:slug', 'location', async (ctx) => {
      const info = requireKey(ctx.locationId);
      const t = await getTool(info, ctx.params.slug);
      const allowed = isAllowed(allowOf(ctx.locationId), t.slug, t.toolkit.slug);
      if (machine(ctx) && !allowed) throw new HttpError(403, `Die Aktion ${t.slug} ist für KI & MCP nicht freigegeben.`);
      return { ...t, allowed, connected: t.no_auth || !!activeConnection(ctx.locationId, t.toolkit.slug, info.scope) };
    });
    router.post('/api/composio/execute', 'location', async (ctx) => {
      const tool = str(ctx.body.tool, 'Aktion', { required: true, max: 150 });
      const contactId = str(ctx.body.contact_id, 'Kontakt', { max: 64 });
      let vars: Record<string, unknown> | undefined;
      if (contactId) {
        const c = getContact(app, ctx.locationId, contactId);
        if (!c) throw notFound('Kontakt nicht gefunden');
        vars = { contact: contactVars(c), location: app.location(ctx.locationId) };
      }
      const r = await execute(ctx.locationId, tool, ctx.body.arguments ?? {}, { vars, enforceAllow: machine(ctx), source: ctx.via === 'mcp' ? 'mcp' : machine(ctx) ? 'api' : 'ui' });
      return { successful: r.successful, data: r.data, error: r.error, log_id: r.log_id, tool: r.tool, toolkit: r.toolkit, ms: r.ms };
    });

    // --- catalogue entry + housekeeping -----------------------------------------------------------
    const catalog: CatalogExtra = {
      entry: {
        key: 'composio',
        name: 'Composio (250+ Apps)',
        category: 'Automatisierung',
        icon: 'apps',
        scope: 'both',
        setup: { location: 'apps/composio', agency: 'agency/integrations' },
        description: 'Slack, Notion, HubSpot, Shopify, Google Sheets, Calendly & 250+ weitere Apps mit verwalteter Anmeldung – als Workflow-Aktion, App-Ereignis, für die KI und über MCP.',
        credentials: 'Composio-API-Schlüssel der Agentur unter Agentur → Integrationen → Einrichtung (optional ein eigener je Sub-Account unter Apps → Composio); Apps verbinden je Sub-Account mit „Verbinden“.',
        docs: 'docs/connectors.md',
        guide: [
          'Bei composio.dev ein Konto anlegen (es gibt einen kostenlosen Einstieg) und unter Settings → API Keys einen Projekt-Schlüssel erzeugen.',
          'Schlüssel unter Agentur → Integrationen → Einrichtung → Composio eintragen und „Verbindung testen“.',
          'Im Sub-Account Apps → Composio: App suchen, „Verbinden“ – die Anmeldung läuft bei Composio, danach geht es zurück zu HyperLevel.',
          'In Workflows die Aktion „App-Aktion ausführen (Composio)“ oder den Auslöser „App-Ereignis (Composio)“ nutzen.',
        ],
      },
      location: (_ctx, loc) => {
        const info = keyInfo(loc);
        if (!info) return { status: 'missing', detail: 'Kein Composio-Schlüssel' };
        const on = db.all(`SELECT DISTINCT toolkit_name, toolkit FROM composio_connections WHERE location_id = ? AND status = 'active' AND scope = ?`, loc, info.scope);
        if (!on.length) return { status: 'info', detail: 'Bereit – noch keine App verbunden' };
        const names = on.map((r) => r.toolkit_name || r.toolkit);
        return { status: 'ok', detail: `${names.length} ${names.length === 1 ? 'App' : 'Apps'}: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ' …' : ''}` };
      },
      agency: () => {
        const info = agencyKey();
        return info ? { status: 'ok', detail: `Agentur-Schlüssel ${info.hint}${info.source === 'env' ? ' (Umgebung)' : ''}` } : { status: 'missing', detail: 'Kein Composio-Schlüssel' };
      },
    };
    app.services.catalogExtra = [...(app.services.catalogExtra ?? []), catalog];

    app.onTick(() => void db.run('DELETE FROM composio_calls WHERE created_at < ?', new Date(Date.now() - 30 * 864e5).toISOString()));
  },
};

/** Typed access for the other Composio modules. */
export const composioApi = (app: App): ComposioApi | undefined => app.services.composio;
