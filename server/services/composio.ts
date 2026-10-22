import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Composio (composio.dev) over its REST API v3.1 – plain fetch, no SDK. Every Composio HTTP call
 * HyperLevel makes lives in this file, plus the pure helpers for its webhooks (signature, payload
 * versions V1–V3). Tests swap the network for `app.services.composioFetch`.
 *
 * Based on Composio's published OpenAPI spec (Platform API v3.1, backend.composio.dev). Points that
 * could only be checked against the spec, not a live key, are marked ASSUMPTION – see
 * docs/connectors.md#what-to-verify-with-a-real-key.
 */

export const COMPOSIO_BASE = 'https://backend.composio.dev';
const API = '/api/v3.1';

/** Webhook events HyperLevel subscribes to (V3 payloads). */
export const WEBHOOK_EVENTS = ['composio.trigger.message', 'composio.connected_account.expired'];

/** One Composio user per sub-account: connected accounts and triggers are owned by it. */
export const userIdFor = (locationId: string) => `gohigh:${locationId}`;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class ComposioError extends Error {
  constructor(
    message: string,
    /** HTTP status we answer with (502 for upstream problems, 4xx passed through where it helps). */
    public status = 502,
    public slug = '',
    public retryable = false,
    /** Status Composio answered with (0 = no answer). */
    public upstream = 0,
  ) {
    super(message);
  }
}

/** Pause before retries (tests lower it). */
export const retry = { ms: 400 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Composio's error body `{error: {message, slug, suggested_fix}}` → German message + status. */
export function errorFor(status: number, body: any): ComposioError {
  const e = body?.error ?? body ?? {};
  const msg = String(e.message ?? e.detail ?? '').trim().slice(0, 300);
  const fix = String(e.suggested_fix ?? '').trim().slice(0, 200);
  const detail = msg ? `: ${msg}${fix ? ` (${fix})` : ''}` : '';
  const slug = String(e.slug ?? '');
  switch (status) {
    case 400:
    case 422:
      return new ComposioError(`Composio hat die Anfrage abgelehnt${detail}`, 400, slug, false, status);
    case 401:
      return new ComposioError('Der Composio-API-Schlüssel ist ungültig (Agentur → Integrationen oder Apps → Composio prüfen).', 502, slug, false, status);
    case 402:
      return new ComposioError(`Composio: Kontingent oder Guthaben aufgebraucht${detail}`, 402, slug, false, status);
    case 403:
      return new ComposioError(`Composio verweigert den Zugriff${detail}`, 403, slug, false, status);
    case 404:
      return new ComposioError(`Bei Composio nicht gefunden${detail}`, 404, slug, false, status);
    case 408:
      return new ComposioError('Die App hat bei Composio zu lange gebraucht – bitte erneut versuchen.', 504, slug, true, status);
    case 410:
      return new ComposioError(`Diese Aktion gibt es bei Composio nicht mehr${detail}`, 410, slug, false, status);
    case 429:
      return new ComposioError('Zu viele Anfragen bei Composio – bitte kurz warten.', 429, slug, true, status);
    default:
      return status >= 500
        ? new ComposioError(`Composio oder die App hat gerade ein Problem${detail}`, 503, slug, status !== 500 && status !== 501, status)
        : new ComposioError(`Fehler von Composio (${status})${detail}`, 502, slug, false, status);
  }
}

type Query = Record<string, string | number | boolean | undefined | null | string[]>;

export interface ClientOptions {
  apiKey: string;
  fetch?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
  /** Retries for 429/502/503/504 and lost connections (default 2). */
  retries?: number;
}

export interface Toolkit {
  slug: string;
  name: string;
  logo: string;
  description: string;
  categories: string[];
  tools_count: number;
  triggers_count: number;
  auth_schemes: string[];
  managed_auth: boolean;
  no_auth: boolean;
}

export interface ToolInfo {
  slug: string;
  name: string;
  description: string;
  toolkit: { slug: string; name: string; logo: string };
  tags: string[];
  no_auth: boolean;
  input_parameters?: Record<string, any>;
  output_parameters?: Record<string, any>;
}

export interface ExecuteResult {
  successful: boolean;
  data: unknown;
  error: string | null;
  log_id: string;
}

export function toolkitOut(t: any): Toolkit {
  const m = t?.meta ?? {};
  return {
    slug: String(t?.slug ?? ''),
    name: String(t?.name ?? t?.slug ?? ''),
    logo: typeof m.logo === 'string' && /^https:\/\//.test(m.logo) ? m.logo : '',
    description: String(m.description ?? '').slice(0, 400),
    categories: (Array.isArray(m.categories) ? m.categories : []).map((c: any) => String(c?.name ?? c?.slug ?? c?.id ?? '')).filter(Boolean),
    tools_count: Number(m.tools_count ?? 0) || 0,
    triggers_count: Number(m.triggers_count ?? 0) || 0,
    auth_schemes: Array.isArray(t?.auth_schemes) ? t.auth_schemes.map(String) : [],
    managed_auth: Array.isArray(t?.composio_managed_auth_schemes) && t.composio_managed_auth_schemes.length > 0,
    no_auth: !!t?.no_auth,
  };
}

export function toolOut(t: any, full = false): ToolInfo {
  const tk = t?.toolkit ?? {};
  return {
    slug: String(t?.slug ?? ''),
    name: String(t?.name ?? t?.slug ?? ''),
    description: String(t?.human_description || t?.description || '').slice(0, full ? 2000 : 300),
    toolkit: { slug: String(tk.slug ?? ''), name: String(tk.name ?? tk.slug ?? ''), logo: typeof tk.logo === 'string' && /^https:\/\//.test(tk.logo) ? tk.logo : '' },
    tags: Array.isArray(t?.tags) ? t.tags.map(String) : [],
    no_auth: !!t?.no_auth,
    ...(full ? { input_parameters: t?.input_parameters ?? { type: 'object', properties: {} }, output_parameters: t?.output_parameters ?? {} } : {}),
  };
}

/** A thin client: one method per Composio endpoint HyperLevel uses. */
export function composioClient(o: ClientOptions) {
  const doFetch: FetchLike = o.fetch ?? ((u, i) => fetch(u, i));
  const base = (o.baseUrl ?? COMPOSIO_BASE).replace(/\/$/, '');

  async function request<T = any>(method: string, path: string, opts: { query?: Query; body?: unknown; retries?: number; timeoutMs?: number } = {}): Promise<T> {
    const url = new URL(base + API + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined || v === null || v === '') continue;
      // ASSUMPTION: list filters (user_ids, toolkit_slugs …) as repeated keys; we only ever send one value.
      if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, x);
      else url.searchParams.set(k, String(v));
    }
    const max = opts.retries ?? o.retries ?? 2;
    for (let attempt = 0; ; attempt++) {
      let r: Response;
      try {
        r = await doFetch(url.toString(), {
          method,
          headers: { 'x-api-key': o.apiKey, accept: 'application/json', ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(opts.timeoutMs ?? o.timeoutMs ?? 30_000),
        });
      } catch (e) {
        const timeout = (e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError';
        // A timed-out write may have happened anyway – only reads are retried after a timeout.
        if (attempt < max && (!timeout || method === 'GET')) {
          await sleep(retry.ms * 3 ** attempt);
          continue;
        }
        throw new ComposioError(timeout ? 'Composio hat nicht rechtzeitig geantwortet – bitte erneut versuchen.' : 'Composio ist nicht erreichbar – bitte Internetverbindung des Servers prüfen.', 504, timeout ? 'timeout' : 'network', true);
      }
      const raw = await r.text();
      let data: any = null;
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch {
        /* not JSON */
      }
      if (r.ok) return data as T;
      const err = errorFor(r.status, data);
      if (err.retryable && attempt < max) {
        await sleep(retry.ms * 3 ** attempt);
        continue;
      }
      throw err;
    }
  }

  return {
    request,

    // --- catalogue ---------------------------------------------------------------------------
    /** GET /toolkits – sorted by usage, searchable, cursor-paginated. */
    async listToolkits(q: { search?: string; category?: string; cursor?: string; limit?: number } = {}): Promise<{ items: Toolkit[]; next_cursor: string | null; total: number }> {
      const r = await request('GET', '/toolkits', { query: { search: q.search, category: q.category, cursor: q.cursor, limit: q.limit ?? 48, sort_by: 'usage' } });
      return { items: (r?.items ?? []).map(toolkitOut), next_cursor: (r?.next_cursor as string | undefined) ?? null, total: Number(r?.total_items ?? r?.items?.length ?? 0) };
    },
    async categories(): Promise<{ id: string; name: string }[]> {
      const r = await request('GET', '/toolkits/categories');
      return (r?.items ?? []).map((c: any) => ({ id: String(c.id ?? c.slug ?? c.name), name: String(c.name ?? c.id) }));
    },
    async getToolkit(slug: string): Promise<Toolkit> {
      return toolkitOut(await request('GET', `/toolkits/${encodeURIComponent(slug)}`));
    },

    // --- auth configs & connected accounts ---------------------------------------------------
    /** GET /auth_configs?toolkit_slug= (enabled ones). */
    async listAuthConfigs(q: { toolkit?: string; limit?: number } = {}): Promise<{ items: { id: string; toolkit: string; managed: boolean; enabled: boolean; auth_scheme: string }[]; total: number }> {
      const r = await request('GET', '/auth_configs', { query: { toolkit_slug: q.toolkit, limit: q.limit ?? 50 } });
      return {
        items: (r?.items ?? []).map((a: any) => ({ id: String(a.id), toolkit: String(a.toolkit?.slug ?? ''), managed: !!a.is_composio_managed, enabled: a.status !== 'DISABLED', auth_scheme: String(a.auth_scheme ?? '') })),
        total: Number(r?.total_items ?? r?.items?.length ?? 0),
      };
    },
    /** POST /auth_configs with Composio-managed auth (Composio's own OAuth app). */
    async createManagedAuthConfig(toolkit: string): Promise<string> {
      const r = await request('POST', '/auth_configs', { body: { toolkit: { slug: toolkit }, auth_config: { type: 'use_composio_managed_auth' } }, retries: 0 });
      const id = r?.auth_config?.id;
      if (!id) throw new ComposioError('Composio hat keine Auth-Konfiguration angelegt.', 502);
      return String(id);
    },
    /** POST /connected_accounts/link – hosted "Connect Link"; Composio redirects back to callback_url. */
    async createLink(p: { authConfigId: string; userId: string; callbackUrl: string }): Promise<{ redirect_url: string; connected_account_id: string; expires_at: string }> {
      const r = await request('POST', '/connected_accounts/link', { body: { auth_config_id: p.authConfigId, user_id: p.userId, callback_url: p.callbackUrl }, retries: 0 });
      if (!r?.redirect_url || !/^https:\/\//.test(String(r.redirect_url))) throw new ComposioError('Composio hat keinen Anmelde-Link geliefert.', 502);
      return { redirect_url: String(r.redirect_url), connected_account_id: String(r.connected_account_id ?? ''), expires_at: String(r.expires_at ?? '') };
    },
    async listConnectedAccounts(q: { userId: string; toolkit?: string; limit?: number }): Promise<{ id: string; toolkit: string; status: string; status_reason: string; alias: string }[]> {
      const r = await request('GET', '/connected_accounts', { query: { user_ids: [q.userId], toolkit_slugs: q.toolkit ? [q.toolkit] : undefined, limit: q.limit ?? 100 } });
      return (r?.items ?? []).map((a: any) => ({ id: String(a.id), toolkit: String(a.toolkit?.slug ?? ''), status: String(a.status ?? ''), status_reason: String(a.status_reason ?? ''), alias: String(a.alias ?? a.word_id ?? '') }));
    },
    async getConnectedAccount(id: string) {
      const a = await request('GET', `/connected_accounts/${encodeURIComponent(id)}`);
      return { id: String(a?.id ?? id), toolkit: String(a?.toolkit?.slug ?? ''), status: String(a?.status ?? ''), status_reason: String(a?.status_reason ?? ''), user_id: String(a?.user_id ?? '') };
    },
    async deleteConnectedAccount(id: string): Promise<void> {
      await request('DELETE', `/connected_accounts/${encodeURIComponent(id)}`);
    },

    // --- tools ---------------------------------------------------------------------------------
    async listTools(q: { toolkit?: string; query?: string; toolSlugs?: string[]; limit?: number; cursor?: string } = {}): Promise<{ items: ToolInfo[]; next_cursor: string | null; total: number }> {
      const r = await request('GET', '/tools', { query: { toolkit_slug: q.toolkit, query: q.query, tool_slugs: q.toolSlugs?.length ? q.toolSlugs.join(',') : undefined, limit: q.limit ?? 50, cursor: q.cursor } });
      return { items: (r?.items ?? []).map((t: any) => toolOut(t, !!q.toolSlugs?.length)), next_cursor: (r?.next_cursor as string | undefined) ?? null, total: Number(r?.total_items ?? r?.items?.length ?? 0) };
    },
    async getTool(slug: string): Promise<ToolInfo> {
      return toolOut(await request('GET', `/tools/${encodeURIComponent(slug)}`), true);
    },
    /**
     * POST /tools/execute/{slug}. Composio answers 200 with `successful: false` when the app said no;
     * that is returned, not thrown. Only lost connections, 429 and 502–504 are retried.
     */
    async executeTool(slug: string, p: { userId: string; connectedAccountId?: string; arguments: Record<string, unknown> }): Promise<ExecuteResult> {
      const r = await request('POST', `/tools/execute/${encodeURIComponent(slug)}`, {
        body: { user_id: p.userId, ...(p.connectedAccountId ? { connected_account_id: p.connectedAccountId } : {}), arguments: p.arguments },
        timeoutMs: 120_000,
      });
      return { successful: r?.successful !== false && !r?.error, data: r?.data ?? null, error: r?.error ? String(r.error) : r?.successful === false ? 'Die App hat die Aktion abgelehnt.' : null, log_id: String(r?.log_id ?? '') };
    },

    // --- triggers --------------------------------------------------------------------------
    async listTriggerTypes(toolkit: string): Promise<TriggerType[]> {
      const r = await request('GET', '/triggers_types', { query: { toolkit_slugs: [toolkit], limit: 50 } });
      return (r?.items ?? []).map(triggerTypeOut);
    },
    async getTriggerType(slug: string) {
      return triggerTypeOut(await request('GET', `/triggers_types/${encodeURIComponent(slug)}`));
    },
    /** POST /trigger_instances/{slug}/upsert → trigger id. `egressUrl` sends this trigger's events to HyperLevel even if the project webhook points elsewhere. */
    async upsertTrigger(slug: string, p: { userId: string; connectedAccountId: string; config: Record<string, unknown>; egressUrl?: string }): Promise<string> {
      const r = await request('POST', `/trigger_instances/${encodeURIComponent(slug)}/upsert`, {
        body: { user_id: p.userId, connected_account_id: p.connectedAccountId, trigger_config: p.config, ...(p.egressUrl ? { egress_url: p.egressUrl } : {}) },
        retries: 0,
      });
      const id = r?.trigger_id;
      if (!id) throw new ComposioError('Composio hat keinen Auslöser angelegt.', 502);
      return String(id);
    },
    async setTriggerStatus(id: string, on: boolean): Promise<void> {
      await request('PATCH', `/trigger_instances/manage/${encodeURIComponent(id)}`, { body: { status: on ? 'enable' : 'disable' } });
    },
    async deleteTrigger(id: string): Promise<void> {
      await request('DELETE', `/trigger_instances/manage/${encodeURIComponent(id)}`);
    },

    // --- webhook subscription (one per Composio project) -------------------------------------
    async listWebhookSubscriptions(): Promise<WebhookSubscription[]> {
      const r = await request('GET', '/webhook_subscriptions');
      return (r?.items ?? []).map(subscriptionOut);
    },
    async createWebhookSubscription(url: string, events = WEBHOOK_EVENTS): Promise<WebhookSubscription> {
      return subscriptionOut(await request('POST', '/webhook_subscriptions', { body: { webhook_url: url, enabled_events: events, version: 'V3' }, retries: 0 }));
    },
    async updateWebhookSubscription(id: string, patch: { webhook_url?: string; enabled_events?: string[] }): Promise<WebhookSubscription> {
      return subscriptionOut(await request('PATCH', `/webhook_subscriptions/${encodeURIComponent(id)}`, { body: patch }));
    },
  };
}

export type ComposioClient = ReturnType<typeof composioClient>;

export interface WebhookSubscription {
  id: string;
  webhook_url: string;
  enabled_events: string[];
  version: string;
  secret: string;
}

const subscriptionOut = (s: any): WebhookSubscription => ({
  id: String(s?.id ?? ''),
  webhook_url: String(s?.webhook_url ?? ''),
  enabled_events: Array.isArray(s?.enabled_events) ? s.enabled_events.map(String) : [],
  version: String(s?.version ?? ''),
  secret: String(s?.secret ?? ''),
});

export interface TriggerType {
  slug: string;
  name: string;
  description: string;
  instructions: string;
  type: string;
  toolkit: string;
  config: Record<string, any>;
  payload: Record<string, any>;
}

function triggerTypeOut(t: any): TriggerType {
  return {
    slug: String(t?.slug ?? ''),
    name: String(t?.name ?? t?.slug ?? ''),
    description: String(t?.description ?? '').slice(0, 600),
    instructions: String(t?.instructions ?? '').slice(0, 1500),
    type: String(t?.type ?? ''),
    toolkit: String(t?.toolkit?.slug ?? ''),
    config: t?.config && typeof t.config === 'object' ? t.config : { type: 'object', properties: {} },
    payload: t?.payload && typeof t.payload === 'object' ? t.payload : {},
  };
}

// --- webhooks (pure) ---------------------------------------------------------------------------

/**
 * Composio signs like Standard Webhooks: `webhook-signature: v1,<base64 HMAC-SHA256>` over
 * `${webhook-id}.${webhook-timestamp}.${raw body}`, keyed with the subscription secret as UTF-8
 * (as in Composio's SDK). Several signatures may be space-separated. Timestamps older or newer than
 * `toleranceSec` are refused (replay protection).
 */
export function verifyWebhook(secret: string, h: { id?: string; timestamp?: string; signature?: string }, rawBody: string, opts: { toleranceSec?: number; nowSec?: number } = {}): boolean {
  if (!secret || !h.id || !h.timestamp || !h.signature || !rawBody) return false;
  const ts = Number(h.timestamp);
  if (!Number.isFinite(ts)) return false;
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > (opts.toleranceSec ?? 300)) return false;
  const want = createHmac('sha256', secret).update(`${h.id}.${h.timestamp}.${rawBody}`, 'utf8').digest('base64');
  const w = Buffer.from(want);
  for (const part of String(h.signature).split(' ')) {
    const [version, value] = part.split(',');
    if (version !== 'v1' || !value) continue;
    const g = Buffer.from(value);
    if (g.length === w.length && timingSafeEqual(g, w)) return true;
  }
  return false;
}

/** Signs a payload like Composio does (used by tests and the "Test-Ereignis" docs). */
export function signWebhook(secret: string, id: string, timestamp: string, rawBody: string): string {
  return `v1,${createHmac('sha256', secret).update(`${id}.${timestamp}.${rawBody}`, 'utf8').digest('base64')}`;
}

export interface IncomingEvent {
  type: string;
  id: string;
  triggerId: string;
  triggerSlug: string;
  connectedAccountId: string;
  userId: string;
  data: Record<string, any>;
}

const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});

/** Reads the three payload versions into one shape (V3 is the default for new Composio projects). */
export function normalizeEvent(p: any): IncomingEvent | null {
  if (!p || typeof p !== 'object') return null;
  // V3: {id, type: "composio.trigger.message", metadata: {trigger_id, trigger_slug, connected_account_id, user_id}, data}
  if (typeof p.type === 'string' && p.type.startsWith('composio.')) {
    const m = obj(p.metadata);
    const d = obj(p.data);
    const lifecycle = p.type.startsWith('composio.connected_account.');
    return {
      type: p.type,
      id: String(p.id ?? ''),
      triggerId: String(m.trigger_id ?? m.trigger_nano_id ?? ''),
      triggerSlug: String(m.trigger_slug ?? ''),
      connectedAccountId: String(lifecycle ? (d.id ?? m.connected_account_id ?? '') : (m.connected_account_id ?? '')),
      userId: String(m.user_id ?? ''),
      data: d,
    };
  }
  // V2: {type: "github_push_event", data: {connection_nano_id, trigger_nano_id, user_id, …payload}}
  if (typeof p.type === 'string' && p.data && (p.data.trigger_nano_id || p.data.connection_nano_id || p.data.trigger_id)) {
    const { connection_id, connection_nano_id, trigger_nano_id, trigger_id, user_id, ...rest } = obj(p.data);
    return { type: 'composio.trigger.message', id: String(p.log_id ?? ''), triggerId: String(trigger_nano_id ?? trigger_id ?? ''), triggerSlug: String(p.type).toUpperCase(), connectedAccountId: String(connection_nano_id ?? connection_id ?? ''), userId: String(user_id ?? ''), data: rest };
  }
  // V1: {trigger_name, connection_id, trigger_id, payload}
  if (typeof p.trigger_name === 'string') {
    return { type: 'composio.trigger.message', id: String(p.log_id ?? ''), triggerId: String(p.trigger_id ?? ''), triggerSlug: p.trigger_name, connectedAccountId: String(p.connection_id ?? ''), userId: '', data: obj(p.payload) };
  }
  return null;
}

/**
 * Finds a contact in an app event without a field mapping: the first e-mail address (preferring
 * keys named like "email"), a phone number under a phone-like key and names next to the e-mail
 * (Shopify customer, Typeform answers, Calendly invitee, Stripe billing details …).
 */
export function guessContact(data: unknown): Record<string, string> {
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const NAME_KEYS = ['first_name', 'firstName', 'given_name', 'givenName', 'firstname', 'last_name', 'lastName', 'family_name', 'familyName', 'lastname', 'name', 'full_name', 'fullName', 'display_name', 'displayName'];
  const candidates: { email: string; owner: Record<string, any>; keyed: boolean; named: boolean }[] = [];
  let phone = '';
  let seen = 0;
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || ++seen > 2000 || !v || typeof v !== 'object') return;
    const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>);
    for (const [k, x] of entries) {
      if (typeof x === 'string') {
        const s = x.trim();
        if (EMAIL.test(s) && s.length <= 200) {
          const owner = v as Record<string, any>;
          const named = NAME_KEYS.some((n) => typeof owner[n] === 'string' && owner[n].trim() && !EMAIL.test(owner[n]));
          candidates.push({ email: s, owner, keyed: /e-?mail/i.test(k), named });
        } else if (!phone && /phone|mobile|handy|telefon|tel$/i.test(k) && s.replace(/\D/g, '').length >= 6 && s.length <= 40) phone = s;
      } else if (typeof x === 'number' && !phone && /phone|mobile/i.test(k) && String(x).length >= 6) phone = String(x);
      else walk(x, depth + 1);
    }
  };
  walk(data, 0);
  const out: Record<string, string> = {};
  // The address under an "email" key wins; among those, the one next to a name (the customer object).
  const keyed = candidates.filter((c) => c.keyed);
  const pool = keyed.length ? keyed : candidates;
  const best = pool.find((c) => c.named) ?? pool[0];
  if (best) {
    out.email = best.email;
    const o = (best.named ? best : (candidates.find((c) => c.named && c.email.toLowerCase() === best.email.toLowerCase()) ?? best)).owner;
    const pick = (...keys: string[]) => keys.map((k) => o[k]).find((x) => typeof x === 'string' && x.trim())?.trim() ?? '';
    const first = pick('first_name', 'firstName', 'given_name', 'givenName', 'firstname');
    const last = pick('last_name', 'lastName', 'family_name', 'familyName', 'lastname');
    const full = pick('name', 'full_name', 'fullName', 'display_name', 'displayName');
    if (first) out.first_name = first.slice(0, 100);
    if (last) out.last_name = last.slice(0, 100);
    if (!first && !last && full && !EMAIL.test(full)) {
      const [a, ...rest] = full.split(/\s+/);
      out.first_name = a.slice(0, 100);
      if (rest.length) out.last_name = rest.join(' ').slice(0, 100);
    }
    const company = pick('company', 'company_name', 'companyName', 'organization');
    if (company) out.company = company.slice(0, 200);
    const p = pick('phone', 'phone_number', 'phoneNumber', 'mobile');
    if (p) phone = p;
  }
  if (phone) out.phone = phone.slice(0, 40);
  return out;
}

// --- link state (pure) -------------------------------------------------------------------------

export interface LinkState {
  /** Random id of the pending connection. */
  n: string;
  /** Sub-account and login that started it, plus a hash of their session. */
  l: string;
  u: string;
  s: string;
  /** Expiry, ms since epoch. */
  e: number;
}

const b64 = (b: Buffer) => b.toString('base64url');
const stateMac = (secret: string, data: string) => b64(createHmac('sha256', `${secret}:composio-link`).update(data).digest());

export function signLinkState(secret: string, p: LinkState): string {
  const data = b64(Buffer.from(JSON.stringify(p)));
  return `${data}.${stateMac(secret, data)}`;
}

export function verifyLinkState(secret: string, state: string, sessionHash: string, nowMs = Date.now()): LinkState {
  const [data, mac] = String(state ?? '').split('.');
  if (!data || !mac) throw new Error('Ungültige Rückkehr von Composio (state fehlt)');
  const want = Buffer.from(stateMac(secret, data));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) throw new Error('Ungültige Rückkehr von Composio (state passt nicht)');
  let p: LinkState;
  try {
    p = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Ungültige Rückkehr von Composio');
  }
  if (!p || typeof p.e !== 'number' || p.e < nowMs) throw new Error('Das Verbinden hat zu lange gedauert – bitte noch einmal starten');
  const a = Buffer.from(String(p.s ?? ''));
  const b = Buffer.from(sessionHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('Das Verbinden gehört zu einer anderen Anmeldung – bitte noch einmal starten');
  return p;
}

/** Allow-list entries: a tool slug (GMAIL_SEND_EMAIL) or a whole app (`gmail:*`). */
export function isAllowed(allow: string[], tool: string, toolkit: string): boolean {
  const t = tool.toUpperCase();
  const k = toolkit.toLowerCase();
  return allow.some((a) => a === t || (k && a === `${k}:*`));
}

export function cleanAllow(input: unknown): string[] {
  if (!Array.isArray(input)) throw new Error('allow muss eine Liste sein');
  const out = new Set<string>();
  for (const raw of input.slice(0, 500)) {
    const s = String(raw ?? '').trim();
    if (/^[a-z0-9_-]{1,80}:\*$/i.test(s)) out.add(s.toLowerCase());
    else if (/^[A-Za-z0-9_]{2,150}$/.test(s)) out.add(s.toUpperCase());
    else if (s) throw new Error(`Ungültiger Eintrag: ${s.slice(0, 60)}`);
  }
  return [...out];
}
