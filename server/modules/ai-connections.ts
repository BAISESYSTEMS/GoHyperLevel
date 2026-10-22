import type { App, Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Ctx, type User } from '../core/http.js';
import { monthStart, withDefaults } from '../services/ai-context.js';
import { DEFAULT_MODEL as CLAUDE_DEFAULT, type Usage } from '../services/anthropic.js';
import { chatWithTools, providerError, AgentError } from '../services/agent-llm.js';
import { completeText } from '../services/ai-compat.js';
import { cleanFallbacks, fallbackChain, isRetryable, targetLabel } from '../services/model-fallback.js';
import type { Effort } from '../services/ai-effort.js';
import {
  AUTH_STYLES,
  CAPABILITIES,
  CAPABILITY_LABELS,
  MODEL_RE,
  PRESETS,
  USAGES,
  USAGE_KEYS,
  capOf,
  checkBaseUrl,
  connectionHeaders,
  guardedFetch,
  headerAllowed,
  isCapability,
  isUsage,
  modelsUrl,
  parseModelList,
  presetById,
  presetOut,
  resolvedAuthStyle,
  textCost,
  type AuthStyle,
  type Capability,
  type ConnectionOptions,
  type FetchLike,
  type Resolved,
  type UsageKey,
} from '../services/ai-presets.js';
import { MAX_MODEL_INFOS, parseModelInfo, rememberPrices, type ModelInfo } from '../services/ai-model-info.js';
import { DEFAULT_MODEL as OPENAI_DEFAULT } from '../services/openai.js';
import { openSecret, sealSecret } from '../core/secrets.js';

/**
 * KI-Anbieter (BYOK) – the one registry of AI connections: any text model (OpenAI, Anthropic, Gemini,
 * OpenRouter, Groq, Together, Fireworks, DeepSeek, Mistral, xAI, Perplexity, Cerebras, Hugging Face,
 * Azure, Ollama, LM Studio, vLLM/LiteLLM, any OpenAI-compatible URL) and media providers (fal.ai,
 * kie.ai, Replicate, Stability, ElevenLabs, Runway, Luma, custom HTTP). Per agency, overridable per
 * sub-account; keys and extra headers sealed (sealSecret), never sent back to the browser.
 *
 * `app.services.aiConnections`:
 *  - list(locationId, capability?)               connections the sub-account can use (no secrets)
 *  - resolve(locationId, capOrUsage, id?)         { connectionId, provider, baseUrl, apiKey, headers, authStyle, model, … } | null
 *  - models(connectionId, locationId?)            live model list (cached 10 min) – free text is always allowed
 *  - textProvider(locationId, purpose?)           routes the KI-Assistent's quick texts (aiRun) to a connection
 *  - recordUsage / fetchFor
 * Resolve order: explicit id → the sub-account's routing → the sub-account's own connections → the
 * agency's routing → agency connections → keys the KI-Assistent already has (implicit, read-only).
 * Test hook: `app.services.aiConnectionsFetch`.
 */

const MODEL_CACHE_MS = 10 * 60_000;
const AGENCY = 'agency';

export interface ConnectionInfo {
  id: string;
  scope: 'agency' | 'location';
  location_id: string | null;
  provider: string;
  provider_label: string;
  label: string;
  base_url: string;
  auth_style: AuthStyle;
  auth_header: string;
  extra_header_names: string[];
  capabilities: Capability[];
  models: Partial<Record<Capability, string>>;
  /** Default model for the capability list() was asked for (or text / the first one). */
  model: string;
  webhook_secret_set: boolean;
  enabled: boolean;
  key_set: boolean;
  key_hint: string;
  options: ConnectionOptions;
  status: string;
  status_message: string;
  checked_at: string | null;
  /** Derived from the KI-Assistent's own settings (edit there). */
  implicit?: boolean;
  editable: boolean;
}

/** `fallbacks`: Ersatzmodelle of the same connection, tried in order when the model fails (services/model-fallback.ts). */
type Routing = Partial<Record<UsageKey, { connection_id: string; model?: string; fallbacks?: string[] }>>;

export const aiConnectionsModule: Module = {
  name: 'ai-connections',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE ai_connections (
        id TEXT PRIMARY KEY, location_id TEXT REFERENCES locations(id) ON DELETE CASCADE,
        provider TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', base_url TEXT NOT NULL DEFAULT '',
        api_key TEXT, auth_style TEXT NOT NULL DEFAULT 'bearer', auth_header TEXT NOT NULL DEFAULT '', extra_headers TEXT,
        capabilities TEXT NOT NULL DEFAULT '[]', models TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
        options TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT '', status_message TEXT NOT NULL DEFAULT '', checked_at TEXT,
        created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX ai_connections_loc ON ai_connections(location_id);
      CREATE TABLE ai_routing (scope TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL);
      CREATE TABLE ai_connection_usage (
        connection_id TEXT NOT NULL, location_id TEXT NOT NULL, day TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cost_micros INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (connection_id, location_id, day)
      );
      `,
    ],
    // Signing secret for provider callbacks (kie.ai webhookHmacKey), sealed like the key.
    ['002-webhook-secret', `ALTER TABLE ai_connections ADD COLUMN webhook_secret TEXT;`],
  ],
  register(app) {
    const { db, router } = app;
    const now = () => new Date().toISOString();
    const rid = () => `aic_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
    const fetchHook = (): FetchLike | undefined => app.services.aiConnectionsFetch as FetchLike | undefined;

    const open = (sealed: string | null | undefined): string => {
      if (!sealed) return '';
      try {
        return openSecret(app, sealed);
      } catch {
        return '';
      }
    };
    const json = <T>(v: string | null | undefined, fallback: T): T => {
      try {
        return v ? JSON.parse(v) : fallback;
      } catch {
        return fallback;
      }
    };

    // --- implicit connections: keys the KI-Assistent already has -------------------------------------------
    interface Raw {
      id: string;
      location_id: string | null;
      provider: string;
      label: string;
      base_url: string;
      apiKey: string;
      auth_style: AuthStyle;
      auth_header: string;
      extraHeaders: Record<string, string>;
      capabilities: Capability[];
      models: Partial<Record<Capability, string>>;
      enabled: boolean;
      options: ConnectionOptions;
      webhookSecret?: string;
      row?: any;
      implicit?: boolean;
    }
    const implicit = (locId: string): Raw[] => {
      const out: Raw[] = [];
      const base = (id: string, provider: 'anthropic' | 'openai', label: string, key: string, model: string, loc: string | null): Raw => ({
        id,
        location_id: loc,
        provider,
        label,
        base_url: presetById(provider)!.baseUrl,
        apiKey: key,
        auth_style: presetById(provider)!.auth,
        auth_header: '',
        extraHeaders: {},
        capabilities: ['text', 'vision'],
        models: { text: model, vision: model },
        enabled: true,
        options: {},
        implicit: true,
      });
      try {
        const ai = db.get('SELECT data, api_key FROM ai_settings WHERE location_id = ?', locId);
        const k = open(ai?.api_key);
        if (k) out.push(base('implicit:ai-anthropic', 'anthropic', 'Anthropic (aus dem KI-Assistenten)', k, withDefaults(json(ai?.data, null)).model || CLAUDE_DEFAULT, locId));
      } catch {
        /* no KI-Assistent */
      }
      try {
        const p = db.get('SELECT openai_model, openai_key FROM ai_provider_settings WHERE location_id = ?', locId);
        const k = open(p?.openai_key);
        if (k) out.push(base('implicit:ai-openai', 'openai', 'OpenAI (aus dem KI-Assistenten)', k, p?.openai_model || OPENAI_DEFAULT, locId));
        const a = json<any>(db.get('SELECT value FROM agency_settings WHERE key = ?', 'ai_provider')?.value, {});
        const ak = open(a.openai_key);
        if (ak) out.push(base('implicit:agency-openai', 'openai', 'OpenAI (Agentur, KI-Werkzeuge)', ak, a.openai_model || OPENAI_DEFAULT, null));
      } catch {
        /* no provider module */
      }
      const envA = (process.env.PGHL_ANTHROPIC_API_KEY ?? '').trim();
      if (envA) out.push(base('implicit:env-anthropic', 'anthropic', 'Anthropic (Server-Schlüssel)', envA, CLAUDE_DEFAULT, null));
      const envO = (process.env.PGHL_OPENAI_API_KEY ?? '').trim();
      if (envO) out.push(base('implicit:env-openai', 'openai', 'OpenAI (Server-Schlüssel)', envO, OPENAI_DEFAULT, null));
      return out;
    };

    const fromRow = (row: any): Raw => ({
      id: row.id,
      location_id: row.location_id,
      provider: row.provider,
      label: row.label,
      base_url: row.base_url || presetById(row.provider)?.baseUrl || '',
      apiKey: open(row.api_key),
      auth_style: AUTH_STYLES.includes(row.auth_style) ? row.auth_style : 'bearer',
      auth_header: row.auth_header ?? '',
      extraHeaders: json<Record<string, string>>(open(row.extra_headers) || null, {}),
      capabilities: json<string[]>(row.capabilities, []).filter(isCapability),
      models: json(row.models, {}),
      enabled: !!row.enabled,
      options: json(row.options, {}),
      webhookSecret: open(row.webhook_secret) || undefined,
      row,
    });

    /** Connections a sub-account can use: its own first, then the agency's, then implicit ones. */
    const rawFor = (locId: string, opts: { all?: boolean } = {}): Raw[] => {
      const rows = db.all('SELECT * FROM ai_connections WHERE location_id = ? OR location_id IS NULL ORDER BY location_id IS NULL, created_at', locId).map(fromRow);
      return [...rows, ...implicit(locId)].filter((c) => opts.all || c.enabled);
    };
    const routingOf = (scope: string): Routing => json(db.get('SELECT data FROM ai_routing WHERE scope = ?', scope)?.data, {});

    const modelFor = (c: Raw, cap: Capability, wanted?: string) => wanted || c.models[cap] || (cap === 'vision' ? c.models.text : '') || presetById(c.provider)?.models[cap]?.[0] || presetById(c.provider)?.models.text?.[0] || '';
    const toResolved = (c: Raw, cap: Capability, model?: string): Resolved => ({
      connectionId: c.id,
      provider: c.provider,
      baseUrl: c.base_url,
      apiKey: c.apiKey,
      headers: connectionHeaders({ provider: c.provider, authStyle: c.auth_style, authHeader: c.auth_header, apiKey: c.apiKey, extraHeaders: c.extraHeaders }),
      authStyle: resolvedAuthStyle(c.auth_style, c.provider, c.auth_header),
      model: modelFor(c, cap, model),
      label: c.label || presetById(c.provider)?.label || c.provider,
      wire: presetById(c.provider)?.wire ?? 'http',
      capabilities: c.capabilities,
      options: c.options,
      ...(c.webhookSecret ? { webhookSecret: c.webhookSecret } : {}),
    });

    /** The connection (and model) for a capability or routing key in a sub-account. */
    const resolve = (locId: string, key: string, connectionId?: string | null): Resolved | null => {
      const cap = capOf(key);
      if (!cap) return null;
      const list = rawFor(locId);
      const has = (c: Raw) => c.capabilities.includes(cap) || (cap === 'vision' && c.capabilities.includes('text') && !!presetById(c.provider)?.capabilities.includes('vision'));
      if (connectionId) {
        const c = list.find((x) => x.id === connectionId);
        return c && has(c) ? toResolved(c, cap) : null;
      }
      const usage = isUsage(key) ? key : null;
      const routed = (scope: string) => {
        const r = usage ? routingOf(scope)[usage] : undefined;
        // A sub-account may route to its own or an agency connection; the agency only to agency ones.
        const c = r && list.find((x) => x.id === r.connection_id && (scope === AGENCY ? !x.location_id || x.implicit : true));
        return c && has(c) ? toResolved(c, cap, r!.model) : null;
      };
      return (
        routed(locId) ??
        (() => {
          const c = list.find((x) => x.location_id === locId && !x.implicit && has(x));
          return c ? toResolved(c, cap) : null;
        })() ??
        routed(AGENCY) ??
        (() => {
          const c = list.find((x) => !x.location_id && !x.implicit && has(x));
          return c ? toResolved(c, cap) : null;
        })() ??
        (() => {
          const c = list.find((x) => x.implicit && has(x));
          return c ? toResolved(c, cap) : null;
        })()
      );
    };

    /**
     * Ersatzmodelle after `primary` for a usage: the routing's fallback models (sub-account first, then agency – only when that routing
     * points at the primary's connection), else the provider's default order, then the sub-account's other text connections.
     */
    const fallbackTargets = (locId: string, key: string, primary: Resolved): Resolved[] => {
      const usage = isUsage(key) ? key : null;
      const route = usage ? [routingOf(locId)[usage], routingOf(AGENCY)[usage]].find((r) => r?.connection_id === primary.connectionId) : undefined;
      const others = rawFor(locId)
        .filter((c) => c.capabilities.includes('text') && c.id !== primary.connectionId)
        .map((c) => toResolved(c, 'text'))
        .filter((r) => r.wire === 'openai' || r.wire === 'anthropic');
      return fallbackChain(primary, { models: route?.fallbacks, others });
    };

    /** fetch for a connection: test hook, plain fetch for fixed provider URLs, guarded fetch for user URLs. */
    const fetchFor = (r: Pick<Resolved, 'provider' | 'baseUrl' | 'options'>): FetchLike => {
      const hook = fetchHook();
      if (hook) return hook;
      const preset = presetById(r.provider);
      return !preset || preset.customUrl ? guardedFetch(!!r.options.allow_private) : (u, i) => fetch(u, i);
    };

    // --- usage per connection --------------------------------------------------------------------------------
    const recordUsage = (connectionId: string, locId: string, usage: Usage, costMicros: number) => {
      try {
        db.run(
          `INSERT INTO ai_connection_usage (connection_id, location_id, day, calls, input_tokens, output_tokens, cost_micros) VALUES (?, ?, ?, 1, ?, ?, ?)
           ON CONFLICT(connection_id, location_id, day) DO UPDATE SET calls = calls + 1, input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens, cost_micros = cost_micros + excluded.cost_micros`,
          connectionId,
          locId,
          now().slice(0, 10),
          usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens,
          usage.output_tokens,
          costMicros,
        );
      } catch (e) {
        console.error('[ai-connections] usage', (e as Error).message);
      }
    };

    // --- the KI-Assistent's quick texts through a routed connection ---------------------------------------------
    /** Only an explicit routing for "text"/"summary" changes aiRun; without one the KI-Assistent keeps its own choice. */
    /** Which routing keys serve an `aiRun` purpose, best first (the Werkstatt has its own, then falls back to "text"). */
    const chainFor = (purpose?: string): UsageKey[] => {
      if (purpose === 'workflow_builder') return ['workflows', 'text'];
      if (purpose === 'site_builder' || purpose === 'site_writer') return ['sites', 'text'];
      if (purpose === 'werkstatt_review2') return ['werkstatt_review'];
      if (purpose && purpose.startsWith('werkstatt')) return ['werkstatt', 'text'];
      return purpose === 'summary' ? ['summary', 'text'] : ['text'];
    };
    const textProvider = (locId: string, purpose?: string) => {
      const scopes = [locId, AGENCY];
      let r: Resolved | null = null;
      for (const scope of scopes) {
        for (const u of chainFor(purpose)) {
          const route = routingOf(scope)[u];
          if (!route) continue;
          r = resolve(locId, 'text', route.connection_id);
          if (r) {
            if (route.model) r = { ...r, model: route.model };
            break;
          }
        }
        if (r) break;
      }
      if (!r || (r.wire !== 'openai' && r.wire !== 'anthropic')) return null;
      const target = r;
      return {
        provider: target.provider,
        label: target.label,
        model: target.model,
        apiKey: target.apiKey || 'ohne-schluessel',
        keySource: 'registry' as const,
        connectionId: target.connectionId,
        call: async (input: { system: { text: string; cache?: boolean }[]; messages: { role: 'user' | 'assistant'; content: string }[]; maxTokens: number; schema?: Record<string, unknown>; timeoutMs?: number; effort?: Effort; strictEffort?: boolean }) => {
          // Ersatzmodelle: a busy or broken model hands over to the next one (services/model-fallback.ts)
          const chain = [target, ...fallbackTargets(locId, chainFor(purpose)[0] ?? 'text', target)];
          let firstErr: unknown = null;
          for (let i = 0; i < chain.length; i++) {
            const cur = chain[i];
            try {
              const out = await completeText(cur, input, fetchFor(cur), { baseUrl: app.baseUrl(), name: 'HyperLevel' });
              recordUsage(cur.connectionId, locId, out.usage, out.costMicros);
              if (i > 0) console.info(`[ai-connections] Ersatzmodell hat geantwortet: ${targetLabel({ ...cur, model: out.model })} (statt ${targetLabel(target)})`);
              return out;
            } catch (e) {
              firstErr ??= e;
              if (i === 0 && !isRetryable(e)) throw e;
              console.warn(`[ai-connections] ${targetLabel(cur)}: ${(e as Error).message}`);
            }
          }
          throw firstErr;
        },
        cost: (model: string, usage: Usage) => textCost({ ...target, model }, usage),
      };
    };

    // --- model lists ---------------------------------------------------------------------------------------------
    const modelCache = new Map<string, { at: number; models: string[]; details: ModelInfo[] }>();
    /** The list the browser gets: optionally filtered by a search text first (Featherless alone has 20 000+ models), then capped. */
    const shaped = (all: { models: string[]; details: ModelInfo[] }, q: string) => {
      const needle = q.trim().toLowerCase();
      const hit = (id: string, name?: string) => !needle || id.toLowerCase().includes(needle) || (name ?? '').toLowerCase().includes(needle);
      const details = all.details.filter((d) => hit(d.id, d.name)).slice(0, MAX_MODEL_INFOS);
      const models = (all.details.length ? details.map((d) => d.id) : all.models.filter((m) => hit(m)).slice(0, MAX_MODEL_INFOS));
      return { models, details, total: all.details.length || all.models.length };
    };
    const models = async (connectionId: string, locId?: string, opts: { refresh?: boolean; q?: string } = {}) => {
      const raw = locId ? rawFor(locId, { all: true }).find((c) => c.id === connectionId) : (() => {
        const row = db.get('SELECT * FROM ai_connections WHERE id = ?', connectionId);
        return row ? fromRow(row) : undefined;
      })();
      if (!raw) throw notFound('Verbindung nicht gefunden');
      const preset = presetById(raw.provider);
      const suggestions = [...new Set(Object.values(preset?.models ?? {}).flat())];
      const fallback = { models: suggestions, details: [] as ModelInfo[], total: suggestions.length };
      const url = modelsUrl({ provider: raw.provider, baseUrl: raw.base_url });
      if (!url) return { ...shaped(fallback, opts.q ?? ''), live: false, cached: false, free_text: true as const };
      const hit = modelCache.get(raw.id);
      if (hit && !opts.refresh && Date.now() - hit.at < MODEL_CACHE_MS) return { ...shaped(hit, opts.q ?? ''), live: true, cached: true, free_text: true as const };
      const r = toResolved(raw, raw.capabilities[0] ?? 'text');
      try {
        const res = await fetchFor(r)(url, { method: 'GET', headers: r.headers, signal: AbortSignal.timeout(15_000) });
        const data: any = await res.json().catch(() => null);
        if (!res.ok) throw providerError(raw.provider, res.status, String(data?.error?.message ?? data?.error ?? ''));
        const list = parseModelList(data);
        const details = parseModelInfo(preset?.infoKind, data);
        rememberPrices(raw.provider, details);
        const all = { at: Date.now(), models: list, details };
        modelCache.set(raw.id, all);
        return { ...shaped(list.length ? all : fallback, opts.q ?? ''), live: list.length > 0, cached: false, free_text: true as const };
      } catch (e) {
        return { ...shaped(fallback, opts.q ?? ''), live: false, cached: false, free_text: true as const, error: (e as Error).message };
      }
    };

    // --- public descriptors -----------------------------------------------------------------------------------------
    const info = (c: Raw, user: User | undefined, cap?: Capability | null): ConnectionInfo => {
      const mayEdit = !c.implicit && (c.location_id ? true : user?.role === 'admin');
      const showSecretHints = mayEdit;
      return {
        id: c.id,
        scope: c.location_id ? 'location' : 'agency',
        location_id: c.location_id,
        provider: c.provider,
        provider_label: presetById(c.provider)?.label ?? c.provider,
        label: c.label || presetById(c.provider)?.label || c.provider,
        base_url: c.base_url,
        auth_style: c.auth_style,
        auth_header: c.auth_header,
        extra_header_names: Object.keys(c.extraHeaders),
        capabilities: c.capabilities,
        models: c.models,
        model: modelFor(c, cap ?? (c.capabilities.includes('text') ? 'text' : (c.capabilities[0] ?? 'text'))),
        enabled: c.enabled,
        key_set: !!c.apiKey,
        key_hint: showSecretHints && c.apiKey ? `…${c.apiKey.slice(-4)}` : c.apiKey ? '••••' : '',
        webhook_secret_set: !!c.webhookSecret,
        // The HTTP template may name headers and addresses – only for people who may edit the connection.
        options: { api_version: c.options.api_version, price_in: c.options.price_in, price_out: c.options.price_out, allow_private: !!c.options.allow_private, ...(mayEdit && c.options.template ? { template: c.options.template } : {}) },
        status: c.row?.status ?? '',
        status_message: c.row?.status_message ?? '',
        checked_at: c.row?.checked_at ?? null,
        ...(c.implicit ? { implicit: true } : {}),
        editable: mayEdit,
      };
    };
    const list = (locId: string, capability?: string, user?: User): ConnectionInfo[] => {
      const cap = capability ? capOf(capability) : null;
      return rawFor(locId)
        .filter((c) => !cap || c.capabilities.includes(cap))
        .map((c) => info(c, user, cap));
    };

    app.services.aiConnections = { list, resolve, models, textProvider, recordUsage, fetchFor, fallbackTargets, presets: PRESETS };

    // --- validation ----------------------------------------------------------------------------------------------------
    const clean = (b: any, user: User, cur?: any) => {
      const provider: string = cur?.provider ?? String(b.provider ?? '');
      const preset = presetById(provider);
      if (!preset) throw bad('Unbekannter Anbieter');
      const prevOpts: ConnectionOptions = cur ? json(cur.options, {}) : {};
      const o: ConnectionOptions = { ...prevOpts };
      const ob = b.options ?? {};
      if (ob.api_version !== undefined) o.api_version = str(ob.api_version, 'API-Version', { max: 40 }) || undefined;
      for (const k of ['price_in', 'price_out'] as const) {
        if (ob[k] === undefined) continue;
        if (ob[k] === null || ob[k] === '') delete o[k];
        else {
          const v = Number(ob[k]);
          if (!Number.isFinite(v) || v < 0 || v > 1000) throw bad('Preis je Million Tokens: 0–1000 US-Dollar');
          o[k] = v;
        }
      }
      if (ob.template !== undefined) {
        if (ob.template === null || ob.template === '') delete o.template;
        else {
          if (provider !== 'custom_http') throw bad('Eine HTTP-Vorlage gibt es nur für „Benutzerdefiniert (HTTP)“.');
          let t: unknown = ob.template;
          if (typeof t === 'string') {
            try {
              t = JSON.parse(t);
            } catch {
              throw bad('HTTP-Vorlage: kein gültiges JSON.');
            }
          }
          if (!t || typeof t !== 'object' || Array.isArray(t)) throw bad('HTTP-Vorlage als JSON-Objekt {"url": "…", "body": "…"}');
          const tpl = t as Record<string, unknown>;
          if (typeof tpl.url !== 'string' || !tpl.url.trim() || tpl.url.length > 500) throw bad('HTTP-Vorlage: „url“ fehlt.');
          if (JSON.stringify(tpl).length > 16_000) throw bad('HTTP-Vorlage: höchstens 16 KB.');
          o.template = tpl;
        }
      }
      if (ob.allow_private !== undefined) {
        if (ob.allow_private && user.role !== 'admin') throw new HttpError(403, 'Lokale Netze darf nur ein Agentur-Admin freigeben.');
        o.allow_private = !!ob.allow_private;
      }
      const label = b.label !== undefined ? str(b.label, 'Name', { max: 80 }) : (cur?.label ?? '');
      let baseUrl: string = cur?.base_url ?? '';
      if (b.base_url !== undefined) baseUrl = str(b.base_url, 'Adresse', { max: 300 }).replace(/\/+$/, '');
      if (preset.customUrl) {
        if (!baseUrl) baseUrl = preset.baseUrl;
        if (!baseUrl) throw bad(provider === 'azure' ? 'Bitte die Adresse der Azure-Ressource eintragen (https://<name>.openai.azure.com).' : 'Bitte die Adresse des Servers eintragen (z. B. https://…/v1).');
        // Cloudflare and Alibaba presets carry a {placeholder} the person has to replace with an account or workspace id.
        if (/[{}]|%7[Bb]|%7[Dd]/.test(baseUrl)) throw bad('Die Adresse enthält noch einen Platzhalter in {geschweiften Klammern} – bitte durch deine Konto- bzw. Workspace-ID ersetzen.');
        const problem = checkBaseUrl(baseUrl, !!o.allow_private);
        if (problem) throw bad(problem);
      } else if (baseUrl && baseUrl !== preset.baseUrl) throw bad(`Für ${preset.label} ist die Adresse fest.`);
      else baseUrl = '';
      let authStyle: AuthStyle = cur?.auth_style ?? preset.auth;
      if (b.auth_style !== undefined) {
        if (!AUTH_STYLES.includes(b.auth_style)) throw bad('Anmeldung: bearer, x-api-key, key, header, query oder none');
        authStyle = b.auth_style;
      }
      if (authStyle === 'query' && preset.wire !== 'http') throw bad('Schlüssel in der Adresse (query) geht nur bei Bild-, Video- und Audio-Anbietern.');
      let authHeader: string = cur?.auth_header ?? '';
      if (b.auth_header !== undefined) authHeader = str(b.auth_header, 'Header', { max: 64 });
      if (authStyle === 'header' && !(authHeader || preset.authHeader)) throw bad('Bitte den Namen des Headers für den Schlüssel angeben.');
      if (authStyle === 'query' && !authHeader) throw bad('Bitte den Namen des URL-Parameters für den Schlüssel angeben (z. B. key).');
      if (authHeader && (authStyle === 'query' ? !/^[A-Za-z0-9_.-]{1,64}$/.test(authHeader) : !headerAllowed(authHeader))) throw bad(authStyle === 'query' ? 'Ungültiger Parameter-Name.' : 'Ungültiger Header-Name.');
      let extra: string | null = cur?.extra_headers ?? null;
      if (b.extra_headers !== undefined) {
        if (b.extra_headers === null) extra = null;
        else {
          if (typeof b.extra_headers !== 'object' || Array.isArray(b.extra_headers)) throw bad('Zusätzliche Header als {"Name": "Wert"}');
          const entries = Object.entries(b.extra_headers as Record<string, unknown>).slice(0, 10);
          const prev = json<Record<string, string>>(open(cur?.extra_headers) || null, {});
          const out: Record<string, string> = {};
          for (const [k, v] of entries) {
            if (!headerAllowed(k)) throw bad(`Header „${k}“ ist nicht erlaubt.`);
            // An empty value keeps the stored one (values are never shown again).
            const val = v === '' || v === undefined ? prev[k] : String(v);
            if (val !== undefined && val !== null) out[k] = String(val).slice(0, 500);
          }
          extra = Object.keys(out).length ? sealSecret(app, JSON.stringify(out)) : null;
        }
      }
      let caps: Capability[] = cur ? json<string[]>(cur.capabilities, []).filter(isCapability) : [...preset.capabilities];
      if (b.capabilities !== undefined) {
        if (!Array.isArray(b.capabilities)) throw bad('Fähigkeiten als Liste');
        caps = [...new Set(b.capabilities.filter(isCapability))] as Capability[];
      }
      if (!caps.length) throw bad('Bitte mindestens eine Fähigkeit wählen.');
      if (preset.wire === 'http' && caps.includes('text')) throw bad(`${preset.label} ist kein Text-Anbieter – für Text bitte eine OpenAI-kompatible Verbindung anlegen.`);
      let mdl: Partial<Record<Capability, string>> = cur ? json(cur.models, {}) : {};
      if (b.models !== undefined) {
        if (!b.models || typeof b.models !== 'object') throw bad('Modelle je Fähigkeit als {"text": "…"}');
        mdl = {};
        for (const [k, v] of Object.entries(b.models as Record<string, unknown>)) {
          if (!isCapability(k) || v === '' || v === null || v === undefined) continue;
          const m = String(v).trim();
          if (!MODEL_RE.test(m)) throw bad(`Modell „${m.slice(0, 40)}“: bitte die Modell-ID des Anbieters (Buchstaben, Ziffern, . _ - : / @ +).`);
          mdl[k] = m;
        }
      }
      if (b.model !== undefined && b.model !== '') {
        const m = String(b.model).trim();
        if (!MODEL_RE.test(m)) throw bad('Modell: bitte die Modell-ID des Anbieters.');
        mdl[caps.includes('text') ? 'text' : caps[0]] = m;
      }
      if (provider === 'azure' && caps.includes('text') && !mdl.text) throw bad('Bitte den Namen des Deployments als Text-Modell eintragen.');
      let sealed: string | null = cur?.api_key ?? null;
      if (b.api_key === null || b.clear_key === true) sealed = null;
      else if (typeof b.api_key === 'string' && b.api_key.trim()) {
        const k = b.api_key.trim();
        if (k.length > 1000 || /\s/.test(k)) throw bad('Der Schlüssel enthält Leerzeichen oder ist zu lang.');
        if (provider === 'anthropic' && !/^sk-ant-/.test(k)) throw bad('Das sieht nicht nach einem Anthropic-Schlüssel aus (beginnt mit sk-ant-).');
        sealed = sealSecret(app, k);
      }
      if (preset.keyRequired && !sealed) throw bad('Bitte den API-Schlüssel eintragen.');
      // Signing secret for provider callbacks (kie.ai): sealed, write-only; "" keeps, null clears.
      let webhook: string | null = cur?.webhook_secret ?? null;
      if (b.webhook_secret === null) webhook = null;
      else if (typeof b.webhook_secret === 'string' && b.webhook_secret.trim()) {
        if (preset.wire !== 'http') throw bad('Ein Webhook-Geheimnis gibt es nur bei Bild-, Video- und Audio-Anbietern.');
        const w = b.webhook_secret.trim();
        if (w.length > 500 || /\s/.test(w)) throw bad('Das Webhook-Geheimnis enthält Leerzeichen oder ist zu lang.');
        webhook = sealSecret(app, w);
      }
      const enabled = b.enabled !== undefined ? !!b.enabled : cur ? !!cur.enabled : true;
      return { provider, label, base_url: baseUrl, api_key: sealed, auth_style: authStyle, auth_header: authHeader, extra_headers: extra, webhook_secret: webhook, capabilities: JSON.stringify(caps), models: JSON.stringify(mdl), enabled: enabled ? 1 : 0, options: JSON.stringify(o) };
    };

    // --- routes -------------------------------------------------------------------------------------------------------------
    const editable = (ctx: Ctx) => {
      const row = db.get('SELECT * FROM ai_connections WHERE id = ?', ctx.params.id);
      if (!row || (row.location_id && row.location_id !== ctx.locationId)) throw notFound('Verbindung nicht gefunden');
      if (!row.location_id && ctx.user?.role !== 'admin') throw new HttpError(403, 'Agentur-Verbindungen verwaltet nur ein Admin.');
      return row;
    };
    const needUser = (ctx: Ctx): User => {
      if (!ctx.user) throw new HttpError(403, 'Nur mit Anmeldung');
      return ctx.user;
    };
    const usageByConnection = (locId: string, isAdmin: boolean) => {
      const since = monthStart(app.location(locId)?.timezone || 'Europe/Berlin').slice(0, 10);
      const rows = db.all(
        `SELECT connection_id, SUM(calls) AS calls, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cost_micros) AS cost FROM ai_connection_usage WHERE day >= ? ${isAdmin ? '' : 'AND location_id = ?'} GROUP BY connection_id`,
        since,
        ...(isAdmin ? [] : [locId]),
      );
      return Object.fromEntries(rows.map((r) => [r.connection_id, { calls: r.calls, input_tokens: r.input_tokens, output_tokens: r.output_tokens, cost_usd: (r.cost ?? 0) / 1e6 }]));
    };

    router.get('/api/ai-connections/presets', 'user', () => ({
      presets: PRESETS.map(presetOut),
      capabilities: CAPABILITIES.map((c) => ({ id: c, label: CAPABILITY_LABELS[c] })),
      usages: USAGE_KEYS.map((u) => ({ id: u, label: USAGES[u].label, capability: USAGES[u].cap })),
      auth_styles: AUTH_STYLES,
    }));
    router.get('/api/ai-connections', 'location', (ctx) => {
      const u = ctx.user;
      const all = rawFor(ctx.locationId, { all: true }).map((c) => info(c, u));
      const effective = Object.fromEntries(
        USAGE_KEYS.map((k) => {
          const r = resolve(ctx.locationId, k);
          return [k, r ? { connection_id: r.connectionId, label: r.label, model: r.model } : null];
        }),
      );
      return { connections: all, routing: { location: routingOf(ctx.locationId), agency: routingOf(AGENCY), effective }, usage: usageByConnection(ctx.locationId, u?.role === 'admin'), can_agency: u?.role === 'admin' };
    });
    router.post('/api/ai-connections', 'location', (ctx) => {
      const u = needUser(ctx);
      const agency = ctx.body?.scope === 'agency';
      if (agency && u.role !== 'admin') throw new HttpError(403, 'Agentur-Verbindungen verwaltet nur ein Admin.');
      const c = clean(ctx.body ?? {}, u);
      const row = { id: rid(), location_id: agency ? null : ctx.locationId, ...c, created_by: u.id, created_at: now(), updated_at: now() };
      db.insert('ai_connections', row);
      return info(fromRow(db.get('SELECT * FROM ai_connections WHERE id = ?', row.id)), u);
    });
    router.patch('/api/ai-connections/:id', 'location', (ctx) => {
      const u = needUser(ctx);
      const row = editable(ctx);
      const c = clean(ctx.body ?? {}, u, row);
      db.run(
        'UPDATE ai_connections SET label = ?, base_url = ?, api_key = ?, auth_style = ?, auth_header = ?, extra_headers = ?, webhook_secret = ?, capabilities = ?, models = ?, enabled = ?, options = ?, status = ?, updated_at = ? WHERE id = ?',
        c.label,
        c.base_url,
        c.api_key,
        c.auth_style,
        c.auth_header,
        c.extra_headers,
        c.webhook_secret,
        c.capabilities,
        c.models,
        c.enabled,
        c.options,
        '',
        now(),
        row.id,
      );
      modelCache.delete(row.id);
      return info(fromRow(db.get('SELECT * FROM ai_connections WHERE id = ?', row.id)), u);
    });
    router.delete('/api/ai-connections/:id', 'location', (ctx) => {
      const row = editable(ctx);
      db.run('DELETE FROM ai_connections WHERE id = ?', row.id);
      modelCache.delete(row.id);
      // Routing that pointed to it falls back to the next connection.
      for (const r of db.all('SELECT scope, data FROM ai_routing')) {
        const data: Routing = json(r.data, {});
        let changed = false;
        for (const k of Object.keys(data) as UsageKey[])
          if (data[k]?.connection_id === row.id) {
            delete data[k];
            changed = true;
          }
        if (changed) db.run('UPDATE ai_routing SET data = ?, updated_at = ? WHERE scope = ?', JSON.stringify(data), now(), r.scope);
      }
      return { ok: true, id: row.id, name: row.label || presetById(row.provider)?.label };
    });
    router.get('/api/ai-connections/:id/models', 'location', async (ctx) => models(ctx.params.id, ctx.locationId, { refresh: ctx.query.get('refresh') === '1', q: String(ctx.query.get('q') ?? '').slice(0, 80) }));

    /** Routing per usage (agent chat, quick texts, summaries, embeddings, images, video, TTS, transcription). */
    router.put('/api/ai-connections/routing', 'location', (ctx) => {
      const u = needUser(ctx);
      const b = ctx.body ?? {};
      const agency = b.scope === 'agency';
      if (agency && u.role !== 'admin') throw new HttpError(403, 'Die Agentur-Zuordnung ändert nur ein Admin.');
      const scope = agency ? AGENCY : ctx.locationId;
      const data = routingOf(scope);
      const entries: [string, any][] = b.usage ? [[String(b.usage), { connection_id: b.connection_id, model: b.model, fallbacks: b.fallbacks }]] : Object.entries(b.routing ?? {});
      for (const [usage, v] of entries) {
        if (!isUsage(usage)) throw bad(`Unbekannte Verwendung: ${usage}`);
        const cid = String(v?.connection_id ?? '');
        if (!cid) {
          delete data[usage];
          continue;
        }
        const c = rawFor(ctx.locationId, { all: true }).find((x) => x.id === cid && (agency ? !x.location_id : true));
        if (!c) throw bad('Verbindung nicht gefunden');
        if (!c.capabilities.includes(USAGES[usage].cap)) throw bad(`„${c.label || c.provider}“ kann kein ${CAPABILITY_LABELS[USAGES[usage].cap]}.`);
        const model = String(v?.model ?? '').trim();
        if (model && !MODEL_RE.test(model)) throw bad('Modell: bitte die Modell-ID des Anbieters.');
        let fallbacks: string[] = [];
        try {
          // not sent: kept while the routing stays on the same connection
          fallbacks = v?.fallbacks !== undefined ? cleanFallbacks(v.fallbacks, MODEL_RE) : data[usage]?.connection_id === cid ? (data[usage]?.fallbacks ?? []) : [];
        } catch (e) {
          throw bad((e as Error).message);
        }
        data[usage] = { connection_id: cid, ...(model ? { model } : {}), ...(fallbacks.length ? { fallbacks } : {}) };
      }
      db.run('INSERT INTO ai_routing (scope, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(scope) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at', scope, JSON.stringify(data), now());
      return { scope: agency ? 'agency' : 'location', routing: data };
    });

    /** "Verbindung testen": the model list (free) and, for text, a tiny request with one tool (does tool use work?). */
    router.post('/api/ai-connections/test', 'location', async (ctx) => {
      const u = needUser(ctx);
      const b = ctx.body ?? {};
      let raw: Raw;
      let row: any;
      if (b.id && !String(b.id).startsWith('implicit:')) {
        ctx.params.id = String(b.id);
        row = editable(ctx);
        // Unsaved edits in the form are tested too (nothing is stored).
        const edited = ['api_key', 'base_url', 'models', 'model', 'auth_style', 'auth_header', 'extra_headers', 'webhook_secret', 'options', 'capabilities'].some((k) => b[k] !== undefined && b[k] !== '');
        raw = fromRow(edited ? { ...row, ...clean(b, u, row) } : row);
      } else if (b.id) {
        const c = rawFor(ctx.locationId).find((x) => x.id === b.id);
        if (!c) throw notFound('Verbindung nicht gefunden');
        raw = c;
      } else raw = fromRow({ id: 'draft', location_id: ctx.locationId, ...clean(b, u), created_at: now() });
      const cap: Capability = isCapability(b.capability) && raw.capabilities.includes(b.capability) ? b.capability : raw.capabilities.includes('text') ? 'text' : raw.capabilities[0];
      const r = toResolved(raw, cap, b.model ? String(b.model) : undefined);
      const f = fetchFor(r);
      const started = Date.now();
      const out: { ok: boolean; message: string; models?: string[]; model_found?: boolean | null; tools?: boolean | null; ms?: number } = { ok: false, message: '' };
      let noList = false;
      try {
        const url = modelsUrl({ provider: r.provider, baseUrl: r.baseUrl });
        if (url) {
          const res = await f(url, { method: 'GET', headers: r.headers, signal: AbortSignal.timeout(15_000) });
          const data: any = await res.json().catch(() => null);
          // A provider without a model list (404/405) is not a broken connection: fall through to the chat test.
          if (res.status === 404 || res.status === 405) noList = true;
          else if (!res.ok) throw providerError(r.provider, res.status, String(data?.error?.message ?? data?.error ?? data?.detail ?? ''));
          else {
            const ids = parseModelList(data);
            const details = parseModelInfo(presetById(r.provider)?.infoKind, data);
            rememberPrices(r.provider, details);
            if (raw.id !== 'draft') modelCache.set(raw.id, { at: Date.now(), models: ids, details });
            out.models = ids.slice(0, 50);
            out.model_found = ids.length && r.model ? ids.some((m) => m === r.model || m.endsWith(`/${r.model}`)) : null;
          }
        }
        if (cap === 'text' && (b.deep || !url || noList) && (r.wire === 'openai' || r.wire === 'anthropic')) {
          const res = await chatWithTools(
            {
              connection: r,
              system: 'Du testest eine Verbindung. Rufe das Werkzeug ping auf.',
              messages: [{ role: 'user', content: [{ type: 'text', text: 'Bitte rufe jetzt das Werkzeug ping mit ok=true auf.' }] }],
              tools: [{ name: 'ping', description: 'Verbindungstest', inputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } }],
              maxTokens: 300,
              timeoutMs: 45_000,
              app: { baseUrl: app.baseUrl(), name: 'HyperLevel' },
            },
            f,
          );
          out.tools = res.toolCalls.some((c) => c.name === 'ping');
          if (raw.id !== 'draft') recordUsage(raw.id, ctx.locationId, res.usage, textCost({ ...r, model: res.model }, res.usage));
        }
        if ((!url || noList) && cap !== 'text') {
          out.ok = true;
          out.message = 'Gespeichert. Dieser Anbieter hat keine Modell-Liste zum Prüfen – der Schlüssel wird beim ersten Auftrag geprüft.';
          return out;
        }
        out.ok = true;
        out.ms = Date.now() - started;
        out.message =
          out.model_found === false
            ? `Verbunden – aber das Modell „${r.model}“ steht nicht in der Liste des Anbieters (Freitext ist trotzdem erlaubt).`
            : out.tools === false
              ? 'Verbunden – das Modell hat das Test-Werkzeug aber nicht benutzt. Für den KI-Agenten bitte ein Modell mit Werkzeug-Unterstützung (Tool Calling) wählen.'
              : 'Verbindung funktioniert.';
        if (row) db.run('UPDATE ai_connections SET status = ?, status_message = ?, checked_at = ? WHERE id = ?', out.model_found === false || out.tools === false ? 'warning' : 'ok', out.message, now(), row.id);
        return out;
      } catch (e) {
        const msg = (e as Error).message;
        if (row) db.run('UPDATE ai_connections SET status = ?, status_message = ?, checked_at = ? WHERE id = ?', 'error', msg.slice(0, 300), now(), row.id);
        throw new HttpError(e instanceof AgentError ? e.status : 502, msg);
      }
    });
  },
};

export type { Resolved } from '../services/ai-presets.js';
export type AiConnectionsService = {
  list: (locationId: string, capability?: string, user?: User) => ConnectionInfo[];
  resolve: (locationId: string, capability: string, connectionId?: string | null) => Resolved | null;
  /** Ersatzmodelle after `primary` for a usage (services/model-fallback.ts). */
  fallbackTargets: (locationId: string, usage: string, primary: Resolved) => Resolved[];
  models: (connectionId: string, locationId?: string, opts?: { refresh?: boolean; q?: string }) => Promise<{ models: string[]; details: ModelInfo[]; total: number; live: boolean; cached: boolean; free_text: true; error?: string }>;
  recordUsage: (connectionId: string, locationId: string, usage: Usage, costMicros: number) => void;
  fetchFor: (r: Pick<Resolved, 'provider' | 'baseUrl' | 'options'>) => FetchLike;
};
/** Typed access for other modules. */
export const aiConnections = (app: App): AiConnectionsService | undefined => app.services.aiConnections;
