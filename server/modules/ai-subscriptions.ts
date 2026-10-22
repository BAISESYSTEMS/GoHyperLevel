import type { App, Module } from '../core/app.js';
import { HttpError, bad, type Ctx, type User } from '../core/http.js';
import { openSecret, sealSecret } from '../core/secrets.js';
import { id as newId, now } from '../core/util.js';
import { checkModel, needsTopModel } from '../services/werkstatt/modelgate.js';
import { loadPolicy } from '../services/werkstatt/policy.js';
import { completeText } from '../services/ai-compat.js';
import { MODEL_RE, type FetchLike, type Resolved } from '../services/ai-presets.js';
import { chatResponses } from '../services/chatgpt-responses.js';
import {
  OAuthError,
  REDIRECT_URI,
  RESOURCE,
  USAGE_URL,
  buildAuthorizeUrl,
  exchangeCode,
  isHostId,
  listPlanModels,
  newHostId,
  newPkce,
  parseCallback,
  planEnabled,
  planLabel,
  refreshCredentials,
  revoke,
  verifyIdToken,
  type Credentials,
  type Fetch,
} from '../services/chatgpt-oauth.js';
import type { Tool } from './mcp.js';
import type { Usage } from '../services/anthropic.js';

/**
 * Abo-Anmeldung: "Mit ChatGPT anmelden" – a ChatGPT Plus/Pro/Team plan as a PERSONAL model connection.
 *
 * Policy research (October 2026, sources in docs/ai-providers.md#subscription-sign-in):
 *  - OpenAI offers "Sign in with ChatGPT" (ChatGPT plan usage) to open-source and locally hosted apps; paid or remotely hosted
 *    apps need OpenAI's approval. HyperLevel is open source and usually self-hosted, so the feature is on by default there, and it is
 *    OFF on an installation that is run as a hosted service (PGHL_HOSTED=1) until the operator has OpenAI's approval
 *    (PGHL_CHATGPT_SIGNIN_APPROVED=1). An agency admin can switch it off in any case.
 *  - Anthropic does not permit third-party apps to offer Claude.ai login or to route requests through Free/Pro/Max credentials
 *    ("developers may not collect, store, or intermediate Claude.ai credentials"). There is therefore NO Claude sign-in here: Claude
 *    goes through the local bridge (Claude Code on the user's own computer, modules/agent-bridge.ts) or an API key.
 *
 * What is stored: per user one row with the tokens sealed (AES-256-GCM, services/secrets) – never returned to the browser, never
 * logged, never in the audit log. A subscription is personal by construction:
 *  - only the owner's browser session can use it (no API key, no MCP/mobile token, no other user, no agency admin),
 *  - only for what the owner switched on: their own agent chats, their own assistant actions, their own Werkstatt builds,
 *  - never for anything unattended: workflows, schedules, auto-replies, the chat bot, the phone agent, background jobs.
 *
 * `app.services.aiSubscriptions`: resolveFor / providerFor / chatModelsFor / fetchFor. Test hook: `app.services.aiSubscriptionsFetch`
 * (every request to auth.openai.com and api.openai.com goes through it).
 */

export const SUB_ID = 'sub:chatgpt';
const KIND = 'chatgpt';
const AGENCY_KEY = 'ai_subscriptions';
const PENDING_MS = 15 * 60_000;
const REFRESH_AHEAD_MS = 120_000;
const REFRESH_VALID_MS = 30 * 86_400_000;
/** What an `aiRun` call may be, to count as the person's own action (never workflow, chat bot, drafts, phone agent, MCP …). */
const ASSISTANT_PURPOSES = new Set(['suggest', 'summary', 'canvas', 'boards', 'wiki', 'ads_copy']);

export type Use = 'agent' | 'assistant' | 'werkstatt';
export const USES: { id: Use; label: string; hint: string }[] = [
  { id: 'agent', label: 'Meine KI-Agent-Chats', hint: 'Nur wenn du selbst im Browser mit dem Agenten schreibst – nie bei automatischen Läufen.' },
  { id: 'assistant', label: 'Meine KI-Assistent-Aktionen', hint: 'Antwortvorschläge, Zusammenfassungen und KI-Hilfen, die du selbst auslöst.' },
  { id: 'werkstatt', label: 'Meine Werkstatt-Aufträge', hint: 'Wenn du in der Werkstatt etwas bauen lässt – nur mit einem Spitzenmodell (Modell-Prüfung).' },
];

interface Pending {
  state: string;
  nonce: string;
  verifier: string;
}
interface AgencySettings {
  /** null = default (on, unless hosted). */
  chatgpt: boolean | null;
  host_id: string;
}

export interface SubscriptionService {
  resolveFor: (o: { user?: User; locationId: string; usage: Use; automatic?: boolean; via?: string }) => Resolved | null;
  providerFor: (o: { locationId: string; purpose?: string; userId?: string | null }) => unknown | null;
  chatModelsFor: (user: User, locationId: string) => { id: string; label: string; model: string; provider: string; vision: boolean }[];
  fetchFor: (r: Pick<Resolved, 'connectionId'>) => FetchLike;
  availability: () => { available: boolean; state: string; reason: string };
}
export const aiSubscriptions = (app: App): SubscriptionService | undefined => app.services.aiSubscriptions;

const MCP_TOOLS: Tool[] = [
  {
    name: 'ghl_ai_providers',
    title: 'KI-Anbieter und Abo-Anmeldung',
    description:
      'Übersicht über die KI-Anbieter von HyperLevel: der Katalog (Anbieter, Adresse, Modell-Liste ja/nein, Kennzeichnung „EU-Hosting“, günstig, schnell, lokal), die Verbindungen dieses Sub-Accounts (ohne Schlüssel) mit Status und Modellen, welches Modell wofür gilt, und der Stand der Abo-Anmeldung (Mit ChatGPT anmelden: verfügbar oder ausgeschaltet und warum; Claude: nur über Bridge oder API-Schlüssel). Liefert nie Schlüssel oder Token. filter: eu | cheap | fast | local | gateway; search: Text im Namen.',
    inputSchema: {
      type: 'object',
      properties: { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' }, filter: { type: 'string', enum: ['eu', 'cheap', 'fast', 'local', 'gateway'] }, search: { type: 'string' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call, a) => {
      const q = String(a.search ?? '').toLowerCase().trim();
      const filter = typeof a.filter === 'string' ? a.filter : '';
      const meta = await call.api('GET', '/api/ai-connections/presets');
      const providers = (meta.presets as any[])
        .filter((p) => p.group !== 'media' && p.group !== 'voice')
        .filter((p) => !filter || (filter === 'eu' ? !!p.eu : (p.tags ?? []).includes(filter)))
        .filter((p) => !q || `${p.label} ${p.id}`.toLowerCase().includes(q))
        .map((p) => ({ id: p.id, label: p.label, base_url: p.base_url, wire: p.wire, capabilities: p.capabilities, model_list: p.list_models, eu_hosting: p.eu ? { region: p.eu.region, source: p.eu.source } : null, tags: p.tags, verified: p.verified }));
      let connections: unknown[] = [];
      let routing: unknown = null;
      try {
        const c = await call.api('GET', '/api/ai-connections', { location: a.location_id });
        connections = (c.connections as any[]).map((x) => ({ id: x.id, provider: x.provider, label: x.label, scope: x.scope, enabled: x.enabled, status: x.status || 'ungeprüft', models: x.models, key_set: x.key_set }));
        routing = c.routing?.effective ?? null;
      } catch {
        /* no access to this sub-account's settings */
      }
      let subscription: unknown = null;
      try {
        subscription = (await call.api('GET', '/api/ai-subscriptions/overview', { location: a.location_id })).features;
      } catch {
        /* older server */
      }
      return { providers, connections, routing, subscription_sign_in: subscription, note: 'Keine Schlüssel oder Token in dieser Antwort. Abo-Verbindungen sind persönlich und nur im Browser des Besitzers nutzbar.' };
    },
  },
];

export const aiSubscriptionsModule: Module = {
  name: 'ai-subscriptions',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE ai_subscriptions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL,
        client_id TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL DEFAULT '',
        creds TEXT, scopes TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'connected', status_message TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '', werkstatt_model TEXT NOT NULL DEFAULT '', uses TEXT NOT NULL DEFAULT '{"agent":true,"assistant":true,"werkstatt":true}',
        access_expires_at TEXT, refresh_valid_until TEXT, connected_at TEXT, last_refreshed_at TEXT, last_used_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE (user_id, kind)
      );
      CREATE TABLE ai_subscription_pending (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, secret TEXT NOT NULL, client_id TEXT NOT NULL DEFAULT '',
        attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        PRIMARY KEY (user_id, kind)
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...MCP_TOOLS];
    const http = (): Fetch => (app.services.aiSubscriptionsFetch as Fetch | undefined) ?? ((u, i) => fetch(u, i));
    const json = <T>(v: string | null | undefined, fallback: T): T => {
      try {
        return v ? JSON.parse(v) : fallback;
      } catch {
        return fallback;
      }
    };
    const open = (sealed: string | null | undefined): string => {
      if (!sealed) return '';
      try {
        return openSecret(app, sealed);
      } catch {
        return '';
      }
    };
    const audit = (ctx: Ctx | undefined, user: Pick<User, 'id'> | null, action: string, summary: string) => app.services.audit?.({ ctx, action, summary, userId: user?.id ?? null, locationId: null, ...(ctx ? {} : { actor: 'System' }) });

    // --- feature switch ---------------------------------------------------------------------------------------------
    const settings = (): AgencySettings => {
      const v = json<Partial<AgencySettings>>(db.get('SELECT value FROM agency_settings WHERE key = ?', AGENCY_KEY)?.value, {});
      return { chatgpt: typeof v.chatgpt === 'boolean' ? v.chatgpt : null, host_id: isHostId(v.host_id) ? v.host_id : '' };
    };
    const saveSettings = (s: AgencySettings) => db.run('INSERT INTO agency_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', AGENCY_KEY, JSON.stringify(s));
    /** One id per installation (OpenAI's "agent host"): created on first use and kept. */
    const hostId = () => {
      const s = settings();
      if (s.host_id) return s.host_id;
      s.host_id = newHostId();
      saveSettings(s);
      return s.host_id;
    };
    const hosted = () => process.env.PGHL_HOSTED === '1' && process.env.PGHL_CHATGPT_SIGNIN_APPROVED !== '1';
    const availability = (): { available: boolean; state: 'on' | 'off_env' | 'hosted' | 'off_admin'; reason: string } => {
      if ((process.env.PGHL_SUBSCRIPTION_SIGNIN ?? '').toLowerCase() === 'off') return { available: false, state: 'off_env', reason: 'Der Server-Betreiber hat die Abo-Anmeldung ausgeschaltet (PGHL_SUBSCRIPTION_SIGNIN=off).' };
      if (hosted()) return { available: false, state: 'hosted', reason: 'Diese Installation wird als gehosteter Dienst betrieben. OpenAI gibt „Mit ChatGPT anmelden“ für bezahlte oder gehostete Apps nur nach eigener Freigabe frei – bis sie vorliegt, bitte die lokale Bridge (Codex CLI) oder einen API-Schlüssel nutzen.' };
      if (settings().chatgpt === false) return { available: false, state: 'off_admin', reason: 'Ein Agentur-Admin hat „Mit ChatGPT anmelden“ ausgeschaltet.' };
      return { available: true, state: 'on', reason: '' };
    };

    // --- rows ------------------------------------------------------------------------------------------------------------
    const rowOf = (userId: string): any => db.get('SELECT * FROM ai_subscriptions WHERE user_id = ? AND kind = ?', userId, KIND);
    const credsOf = (row: any): Credentials | null => {
      const v = open(row?.creds);
      return v ? json<Credentials | null>(v, null) : null;
    };
    const usesOf = (row: any): Record<Use, boolean> => ({ agent: true, assistant: true, werkstatt: true, ...json<Record<string, boolean>>(row?.uses, {}) });
    const patchRow = (rowId: string, patch: Record<string, unknown>) => {
      const keys = Object.keys(patch);
      db.run(`UPDATE ai_subscriptions SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => patch[k] as any), now(), rowId);
    };
    const mine = (userId: string) => {
      const row = rowOf(userId);
      if (!row) return null;
      const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
      const u = db.get<{ calls: number; input: number; output: number }>(`SELECT COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output FROM ai_connection_usage WHERE connection_id = ? AND day >= ?`, `${SUB_ID}:${row.id}`, since)!;
      return {
        kind: KIND,
        connected: row.status === 'connected',
        status: row.status,
        status_message: row.status_message,
        account_email: row.email,
        account_name: row.name,
        plan: row.plan,
        plan_label: planLabel(row.plan),
        model: row.model,
        werkstatt_model: row.werkstatt_model,
        uses: usesOf(row),
        access_expires_at: row.access_expires_at,
        refresh_valid_until: row.refresh_valid_until,
        connected_at: row.connected_at,
        last_refreshed_at: row.last_refreshed_at,
        last_used_at: row.last_used_at,
        last30: { calls: u.calls, input_tokens: u.input, output_tokens: u.output },
        usage_url: USAGE_URL,
      };
    };

    // --- token handling: refresh before it expires, one refresh at a time per sign-in ---------------------------------
    const locks = new Map<string, Promise<Credentials>>();
    const markExpired = (row: any, message: string) => {
      patchRow(row.id, { creds: null, status: 'expired', status_message: message.slice(0, 300), access_expires_at: null, refresh_valid_until: null });
      audit(undefined, { id: row.user_id }, 'ai.subscription.expired', 'ChatGPT-Anmeldung abgelaufen oder widerrufen – neue Anmeldung nötig');
    };
    /** Valid credentials of a row (refreshing when they expire within two minutes). Throws OAuthError (reauth = sign in again). */
    const fresh = async (rowId: string): Promise<{ row: any; creds: Credentials }> => {
      const row: any = db.get('SELECT * FROM ai_subscriptions WHERE id = ?', rowId);
      const creds = credsOf(row);
      if (!row || row.status !== 'connected' || !creds) throw new OAuthError('Dein ChatGPT-Abo ist nicht verbunden. Bitte unter Einstellungen → KI-Anbieter anmelden.', 'not_connected', 409, true);
      if (creds.expiresAt - Date.now() > REFRESH_AHEAD_MS) return { row, creds };
      let p = locks.get(row.id);
      if (!p) {
        p = (async () => {
          try {
            // A second request may have refreshed in the meantime.
            const latest = credsOf(db.get('SELECT * FROM ai_subscriptions WHERE id = ?', row.id)) ?? creds;
            if (latest.expiresAt - Date.now() > REFRESH_AHEAD_MS) return latest;
            const next = await refreshCredentials(http(), row.client_id, latest);
            // Persist the rotated refresh token first, then check who it belongs to.
            patchRow(row.id, { creds: sealSecret(app, JSON.stringify(next)), access_expires_at: new Date(next.expiresAt).toISOString(), refresh_valid_until: new Date(Date.now() + REFRESH_VALID_MS).toISOString(), last_refreshed_at: now(), status_message: '' });
            if (next.idToken && next.idToken !== latest.idToken) {
              try {
                const who = await verifyIdToken(http(), next.idToken, { clientId: row.client_id });
                if (row.subject && who.subject !== row.subject) throw new OAuthError('Die erneuerte Anmeldung gehört zu einem anderen ChatGPT-Konto. Bitte neu anmelden.', 'account_mismatch', 401, true);
              } catch (e) {
                // An unreachable key service does not make the identity invalid.
                if (e instanceof OAuthError && e.code !== 'identity_verification_unavailable') throw e;
              }
            }
            return next;
          } catch (e) {
            if (e instanceof OAuthError && e.reauth) markExpired(row, e.message);
            throw e;
          } finally {
            locks.delete(row.id);
          }
        })();
        locks.set(row.id, p);
      }
      const next = await p;
      return { row: db.get('SELECT * FROM ai_subscriptions WHERE id = ?', row.id) ?? row, creds: next };
    };

    let lastTouch = 0;
    const touch = (rowId: string) => {
      if (Date.now() - lastTouch < 30_000) return;
      lastTouch = Date.now();
      patchRow(rowId, { last_used_at: now() });
    };

    /** fetch for a resolved subscription: adds the current access token – and only ever sends it to api.openai.com/v1. */
    const fetchFor = (r: Pick<Resolved, 'connectionId'>): FetchLike => {
      const rowId = r.connectionId.startsWith(`${SUB_ID}:`) ? r.connectionId.slice(SUB_ID.length + 1) : '';
      return async (url, init = {}) => {
        if (!rowId || !url.startsWith(`${RESOURCE}/`)) throw new Error('Das ChatGPT-Abo darf nur für api.openai.com genutzt werden.');
        let auth: { creds: Credentials };
        try {
          auth = await fresh(rowId);
        } catch (e) {
          if (e instanceof OAuthError) throw new HttpError(e.status === 401 || e.reauth ? 409 : e.status, e.message);
          throw e;
        }
        const headers = Object.fromEntries(new Headers(init.headers as HeadersInit | undefined));
        headers.authorization = `Bearer ${auth.creds.accessToken}`;
        const res = await http()(url, { ...init, headers });
        touch(rowId);
        if (res.status === 401) patchRow(rowId, { status_message: 'ChatGPT hat die Anmeldung zuletzt nicht akzeptiert – bitte neu anmelden.' });
        return res;
      };
    };

    // --- resolution: who may use the subscription, for what ----------------------------------------------------------------
    const modelOf = (row: any, use: Use) => (use === 'werkstatt' ? row.werkstatt_model || row.model : row.model);
    const resolveFor: SubscriptionService['resolveFor'] = (o) => {
      // Personal: a logged-in person's own browser session, never automatic.
      if (!o.user || o.automatic) return null;
      if (o.usage === 'agent' && o.via !== 'session') return null;
      if (!availability().available) return null;
      const row = rowOf(o.user.id);
      if (!row || row.status !== 'connected' || !row.creds || !usesOf(row)[o.usage]) return null;
      const model = modelOf(row, o.usage);
      if (!model) return null;
      return { connectionId: `${SUB_ID}:${row.id}`, provider: 'chatgpt_plan', baseUrl: RESOURCE, apiKey: '', headers: {}, authStyle: 'none', model, label: 'Mein ChatGPT-Abo', wire: 'responses', capabilities: ['text', 'vision'], options: {} };
    };

    /** The provider `aiRun` calls for a person's own assistant / Werkstatt action (null = use the sub-account's routing as before). */
    const providerFor: SubscriptionService['providerFor'] = ({ locationId, purpose, userId }) => {
      if (!userId || !purpose) return null;
      const werkstatt = purpose.startsWith('werkstatt');
      if (!werkstatt && !ASSISTANT_PURPOSES.has(purpose)) return null;
      const user = db.get('SELECT id FROM users WHERE id = ?', userId);
      if (!user) return null;
      const target = resolveFor({ user: { id: userId } as User, locationId, usage: werkstatt ? 'werkstatt' : 'assistant' });
      if (!target) return null;
      // The Werkstatt only works with a top model – a personal model has to pass the same gate (otherwise the routing decides).
      if (werkstatt) {
        const gate = loadPolicy(app).model_gate;
        if (needsTopModel(purpose, gate) && !checkModel(target.model, gate).ok) return null;
      }
      return {
        provider: 'chatgpt_plan',
        label: target.label,
        model: target.model,
        apiKey: 'abo',
        keySource: 'registry' as const,
        connectionId: target.connectionId,
        call: async (input: any) => {
          const out = await completeText(target, input, fetchFor(target), { baseUrl: app.baseUrl(), name: 'HyperLevel' });
          app.services.aiConnections?.recordUsage(target.connectionId, locationId, out.usage, 0);
          return out;
        },
        cost: (_m: string, _u: Usage) => 0,
      };
    };

    const chatModelsFor: SubscriptionService['chatModelsFor'] = (user, locationId) => {
      const r = resolveFor({ user, locationId, usage: 'agent', via: 'session' });
      return r ? [{ id: SUB_ID, label: r.label, model: r.model, provider: r.provider, vision: true }] : [];
    };
    app.services.aiSubscriptions = { resolveFor, providerFor, chatModelsFor, fetchFor, availability } satisfies SubscriptionService;

    // --- routes ----------------------------------------------------------------------------------------------------------------
    /** Subscriptions belong to a person: only a browser session, never an API key, MCP token or app token. */
    const person = (ctx: Ctx): User => {
      if (!ctx.user || ctx.via !== 'session') throw new HttpError(403, 'Die Abo-Anmeldung ist persönlich und geht nur angemeldet im Browser (nicht mit einem API-Schlüssel).');
      return ctx.user;
    };
    const wrap = (e: unknown): never => {
      if (e instanceof OAuthError) throw new HttpError(e.reauth && e.status === 401 ? 409 : e.status, e.message);
      throw e;
    };
    const features = () => {
      const a = availability();
      return {
        chatgpt: { ...a, hosted: hosted(), redirect_uri: REDIRECT_URI, usage_url: USAGE_URL },
        claude: {
          available: false,
          oauth: false,
          reason: 'Anthropic erlaubt Drittanbietern keine Claude-Anmeldung in eigenen Apps und keine Anfragen über Free-, Pro- oder Max-Zugangsdaten. HyperLevel bietet deshalb keine „Mit Claude anmelden“-Funktion.',
          policy_url: 'https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use',
          paths: ['bridge', 'api_key'],
        },
      };
    };

    router.get('/api/ai-subscriptions', 'user', (ctx) => {
      const u = person(ctx);
      const a = settings();
      return {
        features: features(),
        chatgpt: mine(u.id),
        uses: USES,
        bridge: app.services.agentBridge?.statusFor?.(u.id) ?? null,
        notes: [
          'Das Abo gehört dir persönlich: Nur du kannst es hier nutzen – andere Personen, Agentur-Admins, API-Schlüssel, Workflows und automatische Läufe nie.',
          'Die Nutzung läuft über das Limit deines ChatGPT-Plans (bei Plus gilt ein gemeinsames 5-Stunden-Limit für alle Apps). Unter „Nutzung“ in ChatGPT legst du fest, wie viel diese App verbrauchen darf.',
        ],
        can_admin: u.role === 'admin',
        admin: u.role === 'admin' ? { chatgpt: a.chatgpt } : undefined,
      };
    });

    /** Overview for the MCP tool and the settings page – no personal data unless it is the signed-in person's own session. */
    router.get('/api/ai-subscriptions/overview', 'location', (ctx) => ({ features: features(), mine: ctx.user && ctx.via === 'session' ? mine(ctx.user.id) : null }));

    router.post('/api/ai-subscriptions/chatgpt/start', 'user', async (ctx) => {
      const u = person(ctx);
      const a = availability();
      if (!a.available) throw new HttpError(403, a.reason);
      const prev = rowOf(u.id);
      const pkce = newPkce();
      db.run('DELETE FROM ai_subscription_pending WHERE expires_at < ?', now());
      const recent = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE user_id = ? AND action = 'ai.subscription.start' AND at > ?`, u.id, new Date(Date.now() - 3_600_000).toISOString())?.n ?? 0;
      if (recent >= 12) throw new HttpError(429, 'Zu viele Anmeldeversuche – bitte in einer Stunde noch einmal.');
      let url: string;
      try {
        url = await buildAuthorizeUrl(http(), { clientId: prev?.client_id || undefined, hostId: hostId(), appName: String(app.services.brandName?.() ?? 'HyperLevel'), pkce, loginHint: prev?.email || undefined, reconsent: prev?.status === 'plan_disabled' });
      } catch (e) {
        return wrap(e);
      }
      const secret: Pending = { state: pkce.state, nonce: pkce.nonce, verifier: pkce.verifier };
      const expires = new Date(Date.now() + PENDING_MS).toISOString();
      db.run('INSERT INTO ai_subscription_pending (user_id, kind, secret, client_id, attempts, created_at, expires_at) VALUES (?, ?, ?, ?, 0, ?, ?) ON CONFLICT(user_id, kind) DO UPDATE SET secret = excluded.secret, client_id = excluded.client_id, attempts = 0, created_at = excluded.created_at, expires_at = excluded.expires_at', u.id, KIND, sealSecret(app, JSON.stringify(secret)), prev?.client_id ?? '', now(), expires);
      audit(ctx, u, 'ai.subscription.start', 'Anmeldung mit ChatGPT gestartet');
      ctx.skipAfterWrite = true;
      return { authorize_url: url, redirect_uri: REDIRECT_URI, expires_at: expires };
    });

    router.post('/api/ai-subscriptions/chatgpt/complete', 'user', async (ctx) => {
      const u = person(ctx);
      const a = availability();
      if (!a.available) throw new HttpError(403, a.reason);
      const pending: any = db.get('SELECT * FROM ai_subscription_pending WHERE user_id = ? AND kind = ?', u.id, KIND);
      if (!pending || pending.expires_at < now()) throw new HttpError(409, 'Die Anmeldung ist abgelaufen oder wurde nicht gestartet – bitte „Mit ChatGPT anmelden“ neu klicken.');
      if (pending.attempts >= 5) {
        db.run('DELETE FROM ai_subscription_pending WHERE user_id = ? AND kind = ?', u.id, KIND);
        throw new HttpError(429, 'Zu viele Versuche mit dieser Anmeldung – bitte neu starten.');
      }
      db.run('UPDATE ai_subscription_pending SET attempts = attempts + 1 WHERE user_id = ? AND kind = ?', u.id, KIND);
      const secret = json<Pending | null>(open(pending.secret), null);
      if (!secret) throw new HttpError(409, 'Die Anmeldung kann nicht fortgesetzt werden – bitte neu starten.');
      const f = http();
      try {
        const { code, clientId } = parseCallback(String(ctx.body?.callback ?? ''), secret.state, pending.client_id || undefined);
        // Keep the issued client id before the one-time code is spent, so a retry does not register a second app (spec).
        const prev = rowOf(u.id);
        const rowId = prev?.id ?? newId();
        if (!prev) db.insert('ai_subscriptions', { id: rowId, user_id: u.id, kind: KIND, client_id: clientId, status: 'pending', created_at: now(), updated_at: now() });
        else if (prev.client_id !== clientId) patchRow(rowId, { client_id: clientId });
        const { data, credentials } = await exchangeCode(f, { clientId, code, verifier: secret.verifier });
        if (typeof data.id_token !== 'string') throw new OAuthError('ChatGPT hat keine überprüfbare Identität geschickt. Bitte erneut anmelden.', 'invalid_id_token', 400);
        const who = await verifyIdToken(f, data.id_token, { clientId, nonce: secret.nonce });
        if (prev?.subject && prev.client_id === clientId && prev.subject !== who.subject) throw new OAuthError('Diese Anmeldung gehört zu einem anderen ChatGPT-Konto als die bisherige. Bitte zuerst trennen.', 'account_mismatch', 400);
        db.run('DELETE FROM ai_subscription_pending WHERE user_id = ? AND kind = ?', u.id, KIND);
        if (!planEnabled(credentials)) {
          // Signed in, but the person did not allow the use of their plan: keep the registration, drop the tokens.
          void revoke(f, clientId, credentials.refreshToken);
          patchRow(rowId, { creds: null, subject: who.subject, email: who.email, name: who.name, status: 'plan_disabled', status_message: 'Du hast dich angemeldet, aber die Nutzung deines ChatGPT-Abos nicht erlaubt.' });
          throw new OAuthError('Du hast dich angemeldet, aber die Nutzung deines ChatGPT-Abos in HyperLevel nicht erlaubt. Starte die Anmeldung neu und erlaube sie bei der Frage nach den Berechtigungen.', 'plan_not_granted', 400);
        }
        let models: { slug: string }[] = [];
        try {
          models = await listPlanModels(f, credentials.accessToken);
        } catch {
          /* the list can be loaded later; the person picks a model then */
        }
        const model = prev?.model && models.some((m) => m.slug === prev.model) ? prev.model : (models[0]?.slug ?? prev?.model ?? '');
        patchRow(rowId, {
          client_id: clientId,
          subject: who.subject,
          email: who.email,
          name: who.name,
          plan: who.plan,
          creds: sealSecret(app, JSON.stringify(credentials)),
          scopes: JSON.stringify(credentials.scopes),
          status: 'connected',
          status_message: '',
          model,
          access_expires_at: new Date(credentials.expiresAt).toISOString(),
          refresh_valid_until: new Date(Date.now() + REFRESH_VALID_MS).toISOString(),
          connected_at: now(),
          last_refreshed_at: now(),
        });
        audit(ctx, u, 'ai.subscription.connect', `ChatGPT-Abo verbunden${who.plan ? ` (Plan: ${planLabel(who.plan)})` : ''}`);
        ctx.skipAfterWrite = true;
        return { ok: true, chatgpt: mine(u.id) };
      } catch (e) {
        return wrap(e);
      }
    });

    router.patch('/api/ai-subscriptions/chatgpt', 'user', (ctx) => {
      const u = person(ctx);
      const row = rowOf(u.id);
      if (!row) throw new HttpError(404, 'Du hast kein ChatGPT-Abo verbunden.');
      const b = ctx.body ?? {};
      const patch: Record<string, unknown> = {};
      for (const k of ['model', 'werkstatt_model'] as const) {
        if (b[k] === undefined) continue;
        const m = String(b[k] ?? '').trim();
        if (m && !MODEL_RE.test(m)) throw bad('Modell: bitte die Modell-ID aus der Liste wählen.');
        patch[k] = m;
      }
      if (b.uses !== undefined) {
        if (!b.uses || typeof b.uses !== 'object') throw bad('Nutzung als {"agent": true, …}');
        const next = usesOf(row);
        for (const x of USES) if (b.uses[x.id] !== undefined) next[x.id] = !!b.uses[x.id];
        patch.uses = JSON.stringify(next);
      }
      if (Object.keys(patch).length) patchRow(row.id, patch);
      ctx.skipAfterWrite = true;
      return mine(u.id);
    });

    let modelCache = new Map<string, { at: number; models: { slug: string; name: string }[] }>();
    router.get('/api/ai-subscriptions/chatgpt/models', 'user', async (ctx) => {
      const u = person(ctx);
      const row = rowOf(u.id);
      if (!row || row.status !== 'connected') throw new HttpError(409, 'Dein ChatGPT-Abo ist nicht verbunden.');
      const hit = modelCache.get(u.id);
      if (hit && Date.now() - hit.at < 300_000 && ctx.query.get('refresh') !== '1') return { models: hit.models, cached: true };
      try {
        const { creds } = await fresh(row.id);
        const models = await listPlanModels(http(), creds.accessToken);
        modelCache.set(u.id, { at: Date.now(), models });
        return { models, cached: false };
      } catch (e) {
        return wrap(e);
      }
    });

    /** "Verbindung testen": refresh if needed and load the model list (free); `deep` sends one tiny request (uses a little of the plan). */
    router.post('/api/ai-subscriptions/chatgpt/test', 'user', async (ctx) => {
      const u = person(ctx);
      const row = rowOf(u.id);
      if (!row || row.status !== 'connected') throw new HttpError(409, 'Dein ChatGPT-Abo ist nicht verbunden.');
      const started = Date.now();
      try {
        const { creds } = await fresh(row.id);
        const models = await listPlanModels(http(), creds.accessToken);
        modelCache.set(u.id, { at: Date.now(), models });
        const out: { ok: boolean; message: string; models: number; model_found: boolean | null; reply?: string; ms?: number } = { ok: true, message: 'Verbindung funktioniert.', models: models.length, model_found: row.model ? models.some((m) => m.slug === row.model) : null };
        if (row.model && out.model_found === false) out.message = `Verbunden – aber „${row.model}“ steht nicht in der Modell-Liste deines Plans. Bitte ein anderes Modell wählen.`;
        else if (ctx.body?.deep && row.model) {
          const target = resolveFor({ user: u, locationId: ctx.locationId, usage: 'assistant' }) ?? { connectionId: `${SUB_ID}:${row.id}`, provider: 'chatgpt_plan', baseUrl: RESOURCE, headers: {}, options: {}, wire: 'responses' as const, model: row.model, capabilities: ['text'] };
          const r = await chatResponses({ connection: target as any, system: 'Du testest eine Verbindung.', messages: [{ role: 'user', content: [{ type: 'text', text: 'Antworte nur mit dem Wort: ok' }] }], tools: [], timeoutMs: 60_000 }, fetchFor(target));
          out.reply = r.text.slice(0, 80);
          out.message = 'Verbindung funktioniert – das Modell hat geantwortet.';
        }
        out.ms = Date.now() - started;
        patchRow(row.id, { status_message: '' });
        ctx.skipAfterWrite = true;
        return out;
      } catch (e) {
        if (e instanceof OAuthError || e instanceof HttpError) return wrap(e);
        throw new HttpError(502, (e as Error).message);
      }
    });

    router.delete('/api/ai-subscriptions/chatgpt', 'user', async (ctx) => {
      const u = person(ctx);
      const row = rowOf(u.id);
      if (!row) throw new HttpError(404, 'Du hast kein ChatGPT-Abo verbunden.');
      const creds = credsOf(row);
      let confirmed = false;
      if (creds && row.client_id) confirmed = await revoke(http(), row.client_id, creds.refreshToken);
      // Tokens are gone either way; the registration (client id) stays so the next sign-in reuses it (spec).
      patchRow(row.id, { creds: null, scopes: '[]', status: 'disconnected', status_message: '', access_expires_at: null, refresh_valid_until: null, model: '', werkstatt_model: '' });
      modelCache.delete(u.id);
      db.run('DELETE FROM ai_subscription_pending WHERE user_id = ? AND kind = ?', u.id, KIND);
      audit(ctx, u, 'ai.subscription.disconnect', `ChatGPT-Abo getrennt (Widerruf bei OpenAI ${confirmed ? 'bestätigt' : 'nicht bestätigt'})`);
      ctx.skipAfterWrite = true;
      return { ok: true, revoked: confirmed, note: confirmed ? '' : 'Lokal getrennt. Die Freigabe bei OpenAI konnte nicht bestätigt werden – du kannst die App unter chatgpt.com → Einstellungen → Nutzung entfernen.' };
    });

    // --- agency: the off switch -----------------------------------------------------------------------------------------------
    router.get('/api/ai-subscriptions/admin', 'admin', () => {
      const connected = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ai_subscriptions WHERE kind = ? AND status = 'connected'`, KIND)?.n ?? 0;
      return { chatgpt: settings().chatgpt ?? true, features: features(), connected_users: connected };
    });
    router.put('/api/ai-subscriptions/admin', 'admin', (ctx) => {
      const b = ctx.body ?? {};
      const s = settings();
      if (b.chatgpt !== undefined) {
        s.chatgpt = !!b.chatgpt;
        saveSettings(s);
        audit(ctx, ctx.user ?? null, 'ai.subscription.admin', `„Mit ChatGPT anmelden“ ${s.chatgpt ? 'eingeschaltet' : 'ausgeschaltet'}`);
      }
      ctx.skipAfterWrite = true;
      return { chatgpt: s.chatgpt ?? true, features: features() };
    });
  },
};
