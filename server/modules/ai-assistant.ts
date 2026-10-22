import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, num, str } from '../core/http.js';
import { render } from '../core/template.js';
import { id, normalizeEmail, now } from '../core/util.js';
import type { Effort, EffortPlan } from '../services/ai-effort.js';
import { AiError, MODELS, ZERO_USAGE, callClaude, checkKey, costMicros, type SystemBlock, type Usage } from '../services/anthropic.js';
import {
  BOT_SCHEMA,
  SUMMARY_SCHEMA,
  SUMMARY_TASK,
  botActive,
  botTask,
  budgetProblem,
  buildSystem,
  cleanSettings,
  contactBlock,
  handoffAfter,
  handoffBefore,
  isOpenAt,
  knowledgeBlock,
  missingLead,
  monthStart,
  nowLine,
  parseBotOutput,
  parseSummary,
  suggestTask,
  transcript,
  withDefaults,
  workflowTask,
  type AiSettings,
  type BotLead,
  type BotOutput,
} from '../services/ai-context.js';
import { CONTACT_FIELDS, contactName, getContact, logActivity, upsertContact, type Contact } from '../services/contacts.js';
import { getOrCreateConversation, notifyTeam, sendToContact } from '../services/messaging.js';
import { createOpportunity, getPipeline } from '../services/opportunities.js';
import { openSecret, sealSecret } from './mail-sync.js';
import type { Tool } from './mcp.js';
import { getProfile } from './projects.js';

/**
 * KI-Assistent (Conversation AI) per sub-account, on the Claude API with the customer's own key:
 * reply suggestions and summaries in Konversationen, an optional live-chat bot (off / outside
 * business hours / always) with handoff to the team and lead capture, AI drafts for inbound mail
 * (never sent automatically), a workflow action and an MCP tool. Every call is logged with tokens
 * and cost and checked against a monthly budget.
 */

/** The part of modules/ai-providers.ts that aiRun uses (kept structural, so either module can be left out). */
interface AltProvider {
  provider?: string;
  label: string;
  model: string;
  apiKey: string | null;
  call: (input: { system: SystemBlock[]; messages: { role: 'user' | 'assistant'; content: string }[]; maxTokens: number; schema?: Record<string, unknown>; timeoutMs?: number; effort?: Effort; strictEffort?: boolean }) => Promise<{ text: string; model: string; stopReason: string; usage: Usage; ms: number; costMicros: number; effort?: EffortPlan }>;
  cost: (model: string, usage: Usage) => number;
}

export const PURPOSES: Record<string, string> = {
  suggest: 'Antwortvorschlag',
  summary: 'Zusammenfassung',
  chat_bot: 'Live-Chat-Bot',
  email_draft: 'E-Mail-Entwurf',
  workflow: 'Workflow',
  workflow_builder: 'KI-Workflow-Builder',
  mcp: 'MCP',
  test: 'Verbindungstest',
  voice_agent: 'KI-Telefonagent',
  video_recycle: 'Video-Recycling',
  mobile_capture: 'App-Diktat',
  canvas: 'Canvas',
  review_reply: 'Bewertungsantwort',
};
const BOT_SOURCE = 'KI-Assistent';
const DRAFT_SOURCE = 'KI-Entwurf';
const BOT_HOURLY_CAP = 120;
const DRAFTS_HOURLY_CAP = 30;
const KEY_RE = /^sk-ant-[A-Za-z0-9_-]{20,}$/;

const TOOLS: Tool[] = [
  {
    name: 'ghl_ai_suggest_reply',
    title: 'KI-Antwortvorschlag',
    description:
      'Schreibt mit dem KI-Assistenten des Projekts einen Antwortvorschlag für eine Konversation (wird NICHT gesendet). conversation_id oder contact_id angeben; channel email|sms|chat (sonst wie die letzte Nachricht); instruction = optionaler Hinweis, z. B. „Termin nächste Woche anbieten“. Kostet Tokens und zählt aufs Monatslimit des Projekts.',
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' },
        conversation_id: { type: 'string' },
        contact_id: { type: 'string' },
        channel: { type: 'string', enum: ['email', 'sms', 'chat'] },
        instruction: { type: 'string' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: (call, a) =>
      call.api('POST', '/api/ai/suggest', {
        body: { conversation_id: a.conversation_id, contact_id: a.contact_id, channel: a.channel, instruction: a.instruction, purpose: 'mcp' },
        location: a.location_id,
      }),
  },
];

export const aiAssistantModule: Module = {
  name: 'ai-assistant',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE ai_settings (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
        data TEXT NOT NULL DEFAULT '{}', api_key TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE ai_calls (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost_micros INTEGER NOT NULL DEFAULT 0, ms INTEGER NOT NULL DEFAULT 0,
        contact_id TEXT, conversation_id TEXT, user_id TEXT, error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      );
      CREATE INDEX ai_calls_loc ON ai_calls(location_id, created_at);
      CREATE TABLE ai_conversations (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        bot_status TEXT NOT NULL DEFAULT 'active', handoff_reason TEXT NOT NULL DEFAULT '', handoff_at TEXT,
        bot_replies INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '', next_step TEXT NOT NULL DEFAULT '',
        summary_at TEXT, opportunity_id TEXT, task_id TEXT, answered_until TEXT, updated_at TEXT NOT NULL
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const fetchAi = (url: string, init: RequestInit) => ((app.services.aiFetch as typeof fetch | undefined) ?? fetch)(url, init);
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];

    // --- settings & key ---------------------------------------------------------------
    const load = (locId: string) => {
      const row = db.get('SELECT * FROM ai_settings WHERE location_id = ?', locId);
      return { settings: withDefaults(row ? JSON.parse(row.data) : null), sealed: (row?.api_key as string | null) ?? null };
    };
    const envKey = () => (process.env.PGHL_ANTHROPIC_API_KEY ?? '').trim();
    const keyFor = (locId: string): string | null => {
      const { sealed } = load(locId);
      if (sealed) {
        try {
          return openSecret(app, sealed);
        } catch {
          return null;
        }
      }
      return envKey() || null;
    };
    /** Another provider (OpenAI, modules/ai-providers.ts) chosen for this sub-account, or null = Claude. */
    const altProvider = (locId: string, purpose?: string, userId?: string | null): AltProvider | null => app.services.aiProvider?.(locId, purpose, userId) ?? null;
    /** Is a key there for the provider this sub-account uses? */
    const hasKey = (locId: string) => {
      const alt = altProvider(locId);
      return alt ? !!alt.apiKey : !!keyFor(locId);
    };
    const tzOf = (locId: string) => app.location(locId)?.timezone || 'Europe/Berlin';

    // --- usage log & budget ---------------------------------------------------------------
    const usageSince = (locId: string, since: string) =>
      db.get<{ calls: number; cost: number; tokens: number }>(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(cost_micros), 0) AS cost,
           COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens
         FROM ai_calls WHERE location_id = ? AND created_at >= ? AND status <> 'blocked'`,
        locId,
        since,
      )!;
    const logCall = (row: { locationId: string; purpose: string; model: string; status: 'ok' | 'error' | 'blocked'; usage?: Usage; ms?: number; contactId?: string | null; conversationId?: string | null; userId?: string | null; error?: string; cost?: number }) => {
      const usage = row.usage ?? ZERO_USAGE;
      const settingsModel = load(row.locationId).settings.model;
      db.insert('ai_calls', {
        id: id(),
        location_id: row.locationId,
        purpose: row.purpose,
        model: row.model,
        status: row.status,
        ...usage,
        cost_micros: row.cost ?? costMicros(row.model, usage, settingsModel),
        ms: row.ms ?? 0,
        contact_id: row.contactId ?? null,
        conversation_id: row.conversationId ?? null,
        user_id: row.userId ?? null,
        error: (row.error ?? '').slice(0, 500),
        created_at: now(),
      });
    };

    interface RunInput {
      locationId: string;
      purpose: string;
      user: string;
      system?: SystemBlock[];
      schema?: Record<string, unknown>;
      maxTokens?: number;
      /** Longer answers (e.g. a blog post from a video transcript) may need more than the default 60 s. */
      timeoutMs?: number;
      contactId?: string | null;
      conversationId?: string | null;
      userId?: string | null;
      /** Overrides the Denkstufe of the purpose (services/ai-effort.ts). */
      effort?: Effort;
    }
    const effortOf = (input: { locationId: string; purpose: string; effort?: Effort }) => {
      const c = app.services.aiEffort?.forPurpose(input.locationId, input.purpose) as { effort: Effort; strict: boolean } | undefined;
      return { effort: input.effort && !c?.strict ? input.effort : c?.effort, strictEffort: c?.strict };
    };
    /** One AI call: enabled + key + budget checks, the request, and a log row whatever happens. */
    const runAi = async (input: RunInput) => {
      const { settings } = load(input.locationId);
      if (!settings.enabled) throw new HttpError(409, 'Der KI-Assistent ist aus (Einstellungen → KI-Assistent).');
      const alt = altProvider(input.locationId, input.purpose, input.userId);
      const apiKey = alt ? alt.apiKey : keyFor(input.locationId);
      if (!apiKey) throw new HttpError(409, `Kein ${alt ? alt.label : 'Anthropic'}-API-Schlüssel hinterlegt (Einstellungen → KI-Assistent).`);
      const model = alt ? alt.model : settings.model;
      const base = { locationId: input.locationId, purpose: input.purpose, contactId: input.contactId, conversationId: input.conversationId, userId: input.userId };
      const used = usageSince(input.locationId, monthStart(tzOf(input.locationId)));
      const over = budgetProblem(settings, { cost_micros: used.cost, tokens: used.tokens });
      if (over) {
        logCall({ ...base, model, status: 'blocked', error: over });
        throw new HttpError(409, over);
      }
      // Optional plan limit (SaaS mode): counts the call or says why not.
      const gate: string | undefined = app.services.usageGate?.(input.locationId, 'ai');
      if (gate) {
        logCall({ ...base, model, status: 'blocked', error: gate });
        throw new HttpError(409, gate);
      }
      const request = {
        system: input.system ?? buildSystem(knowledgeFor(input.locationId, settings)),
        messages: [{ role: 'user' as const, content: input.user }],
        maxTokens: input.maxTokens ?? 4000,
        schema: input.schema,
        ...(input.timeoutMs ? { timeoutMs: Math.min(300_000, input.timeoutMs) } : {}),
        // Denkstufe: the agency's / sub-account's choice for this purpose (default xhigh; the adapters lower it to what the model takes).
        ...effortOf(input),
      };
      try {
        if (alt) {
          const r = await alt.call(request);
          logCall({ ...base, model: r.model, status: 'ok', usage: r.usage, ms: r.ms, cost: r.costMicros });
          return r;
        }
        const r = await callClaude({ apiKey, model: settings.model, ...request }, fetchAi);
        logCall({ ...base, model: r.model, status: 'ok', usage: r.usage, ms: r.ms });
        return r;
      } catch (e) {
        if (e instanceof AiError) {
          // Tokens billed by another provider are priced by it (unknown model → careful default).
          const cost = alt ? alt.cost(e.model || model, e.usage) : undefined;
          logCall({ ...base, model: e.model || model, status: 'error', usage: e.usage, error: e.message, cost });
          throw new HttpError(e.status, e.message);
        }
        logCall({ ...base, model, status: 'error', error: (e as Error).message });
        throw e;
      }
    };
    app.services.aiRun = runAi;
    /** Why no AI call would go through right now (off, no key, budget used up), or null – checked before taking a phone call. */
    app.services.aiReady = (locId: string): string | null => {
      const { settings } = load(locId);
      if (!settings.enabled) return 'Der KI-Assistent ist aus.';
      if (!hasKey(locId)) return `Kein ${altProvider(locId)?.label ?? 'Anthropic'}-API-Schlüssel hinterlegt.`;
      const used = usageSince(locId, monthStart(tzOf(locId)));
      return budgetProblem(settings, { cost_micros: used.cost, tokens: used.tokens });
    };

    // --- context ------------------------------------------------------------------------
    const faqBlocks = (locId: string): { q: string; a: string }[] => {
      const out = new Map<string, { q: string; a: string }>();
      let rows: any[] = [];
      try {
        rows = db.all('SELECT blocks FROM funnel_pages WHERE location_id = ? ORDER BY updated_at DESC LIMIT 300', locId);
      } catch {
        return [];
      }
      for (const r of rows) {
        let blocks: any[] = [];
        try {
          blocks = JSON.parse(r.blocks || '[]');
        } catch {
          continue;
        }
        for (const b of Array.isArray(blocks) ? blocks : []) {
          if (b?.type !== 'faq' || !Array.isArray(b.items)) continue;
          for (const it of b.items) {
            const q = String(it?.q ?? '').trim();
            const a = String(it?.a ?? '').trim();
            if (q && a && !out.has(q.toLowerCase())) out.set(q.toLowerCase(), { q: q.slice(0, 500), a: a.slice(0, 2000) });
          }
        }
      }
      return [...out.values()].slice(0, 60);
    };
    const profileOf = (locId: string) => {
      try {
        return getProfile(app, locId);
      } catch {
        return null;
      }
    };
    const knowledgeFor = (locId: string, s: AiSettings) => {
      const loc = app.location(locId)!;
      // Other modules add knowledge via app.services.aiKnowledge = [(locationId) => "# Abschnitt\n…"].
      const extra = (app.services.aiKnowledge ?? []).map((fn: (l: string) => string) => {
        try {
          return fn(locId);
        } catch {
          return '';
        }
      });
      return knowledgeBlock({ locationName: loc.name, website: loc.website, settings: s, profile: s.use_project_profile ? profileOf(locId) : null, faqs: s.use_faq_blocks ? faqBlocks(locId) : [], extra });
    };
    const openOpps = (contactId: string) =>
      db
        .all(`SELECT o.name, o.value, p.name AS pipeline FROM opportunities o JOIN pipelines p ON p.id = o.pipeline_id WHERE o.contact_id = ? AND o.status = 'open' ORDER BY o.updated_at DESC LIMIT 5`, contactId)
        .map((o) => `${o.name} (${o.pipeline}${o.value ? `, ${o.value} €` : ''})`);

    /** Conversation, contact and messages for a request naming a conversation or a contact. */
    const thread = (locId: string, b: { conversation_id?: unknown; contact_id?: unknown }) => {
      let conv: any;
      if (b.conversation_id) conv = db.get('SELECT * FROM conversations WHERE id = ? AND location_id = ?', String(b.conversation_id), locId);
      else if (b.contact_id) {
        conv = db.get('SELECT * FROM conversations WHERE contact_id = ? AND location_id = ?', String(b.contact_id), locId);
        if (!conv && !getContact(app, locId, String(b.contact_id))) throw notFound('Kontakt nicht gefunden');
      } else throw bad('conversation_id oder contact_id fehlt');
      if (b.conversation_id && !conv) throw notFound('Konversation nicht gefunden');
      const contactId = conv?.contact_id ?? String(b.contact_id);
      const contact = getContact(app, locId, contactId);
      if (!contact) throw notFound('Kontakt nicht gefunden');
      const messages = conv ? db.all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at', conv.id) : [];
      return { conv, contact, messages };
    };
    const userContext = (locId: string, contact: Contact, messages: any[], s: AiSettings, max = 20) => {
      const tz = tzOf(locId);
      return [contactBlock(contact, { opportunities: openOpps(contact.id) }), transcript(messages, tz, max), nowLine(tz, isOpenAt(s.business_hours, tz))].join('\n\n');
    };
    /**
     * What the website-chat bot sees. The person in the widget has not proven to be this contact – anybody can type a known address
     * (docs/security-review-2026-10.md, O-2) – so the bot gets this chat from the newest visitor's start and the name, never the
     * contact's e-mails, SMS, stored address, numbers or deals.
     */
    const visitorContext = (locId: string, contact: Contact, messages: any[], s: AiSettings) => {
      const tz = tzOf(locId);
      const since = db.get<{ at: string | null }>('SELECT MAX(created_at) AS at FROM chat_visitors WHERE location_id = ? AND contact_id = ?', locId, contact.id)?.at ?? '';
      const chat = messages.filter((m) => m.channel === 'chat' && m.created_at >= since);
      return [contactBlock({ first_name: contact.first_name, last_name: contact.last_name }), transcript(chat, tz, 20), nowLine(tz, isOpenAt(s.business_hours, tz))].join('\n\n');
    };
    const reSubject = (messages: any[]) => {
      const last = [...messages].reverse().find((m) => m.channel === 'email' && m.subject);
      if (!last) return '';
      return /^(re|aw|antw):/i.test(last.subject) ? last.subject : `Re: ${last.subject}`;
    };

    const suggest = async (locId: string, b: any, purpose: string, userId?: string | null) => {
      const { contact, conv, messages } = thread(locId, b);
      const { settings } = load(locId);
      const lastIn = [...messages].reverse().find((m) => m.direction === 'in');
      const channel = ['email', 'sms', 'chat'].includes(b.channel) ? b.channel : lastIn?.channel === 'chat' || lastIn?.channel === 'sms' ? lastIn.channel : contact.email ? 'email' : 'sms';
      const hint = str(b.instruction, 'Hinweis', { max: 500 });
      const loc = app.location(locId)!;
      const r = await runAi({
        locationId: locId,
        purpose,
        user: `${userContext(locId, contact, messages, settings)}\n\n${suggestTask(channel, loc.name, hint)}`,
        contactId: contact.id,
        conversationId: conv?.id ?? null,
        userId,
      });
      const text = r.text.replace(/^["„“]+|["“”]+$/g, '').trim();
      return { text, subject: channel === 'email' ? reSubject(messages) : '', channel, model: r.model, conversation_id: conv?.id ?? null, contact_id: contact.id };
    };

    // --- per-conversation bot state -------------------------------------------------------
    const stateOf = (locId: string, convId: string) => {
      let s = db.get('SELECT * FROM ai_conversations WHERE conversation_id = ?', convId);
      if (!s) {
        db.run('INSERT OR IGNORE INTO ai_conversations (conversation_id, location_id, updated_at) VALUES (?, ?, ?)', convId, locId, now());
        s = db.get('SELECT * FROM ai_conversations WHERE conversation_id = ?', convId);
      }
      return s!;
    };

    // --- routes: settings ---------------------------------------------------------------------
    const settingsOut = (locId: string) => {
      const { settings, sealed } = load(locId);
      let hint = '';
      if (sealed) {
        try {
          hint = `…${openSecret(app, sealed).slice(-4)}`;
        } catch {
          hint = '(nicht lesbar – bitte neu eintragen)';
        }
      }
      const tz = tzOf(locId);
      return {
        settings,
        key_set: !!sealed,
        key_hint: hint,
        key_source: sealed ? 'account' : envKey() ? 'server' : null,
        models: MODELS,
        timezone: tz,
        open_now: isOpenAt(settings.business_hours, tz),
        bot_active_now: botActive(settings, tz) && hasKey(locId),
        provider: altProvider(locId) ? { id: altProvider(locId)!.provider ?? 'openai', label: altProvider(locId)!.label, model: altProvider(locId)!.model } : { id: 'anthropic', label: 'Anthropic', model: settings.model },
        sources: { profile: !!(profileOf(locId)?.description || profileOf(locId)?.tagline), faq_count: faqBlocks(locId).length },
        usage: usageOut(locId, settings),
      };
    };
    const usageOut = (locId: string, settings: AiSettings) => {
      const since = monthStart(tzOf(locId));
      const u = usageSince(locId, since);
      return { since, calls: u.calls, cost_usd: u.cost / 1e6, tokens: u.tokens, limit_usd: settings.monthly_limit_usd, token_limit: settings.monthly_token_limit };
    };

    /** Whether the inbox should offer AI buttons (readable for everyone with access to the sub-account). */
    router.get('/api/ai/status', 'location', (ctx) => {
      const { settings } = load(ctx.locationId);
      return { enabled: settings.enabled && hasKey(ctx.locationId), bot_mode: settings.bot_mode, assistant_name: settings.assistant_name };
    });
    router.get('/api/ai/settings', 'location', (ctx) => settingsOut(ctx.locationId));
    router.put('/api/ai/settings', 'location', (ctx) => {
      const cur = load(ctx.locationId);
      const b = ctx.body ?? {};
      const next = cleanSettings(b, cur.settings);
      if (next.pipeline_id) {
        const p = getPipeline(app, ctx.locationId, next.pipeline_id);
        if (!p) throw bad('Pipeline nicht gefunden');
        if (next.stage_id && !p.stages.some((s: any) => s.id === next.stage_id)) throw bad('Stufe nicht gefunden');
      } else next.stage_id = '';
      if (next.create_opportunity && !next.pipeline_id) throw bad('Für Opportunities bitte eine Pipeline wählen');
      let sealed = cur.sealed;
      if (b.api_key === null || b.clear_key === true) sealed = null;
      else if (b.api_key) {
        const k = str(b.api_key, 'API-Schlüssel', { max: 300 });
        if (!KEY_RE.test(k)) throw bad('Das sieht nicht nach einem Anthropic-API-Schlüssel aus (beginnt mit sk-ant-).');
        sealed = sealSecret(app, k);
      }
      const alt = altProvider(ctx.locationId);
      if (next.enabled && (alt ? !alt.apiKey : !sealed && !envKey())) throw bad(`Zum Einschalten bitte zuerst einen ${alt ? 'OpenAI-' : ''}API-Schlüssel eintragen.`);
      db.run(
        'INSERT INTO ai_settings (location_id, data, api_key, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET data = excluded.data, api_key = excluded.api_key, updated_at = excluded.updated_at',
        ctx.locationId,
        JSON.stringify(next),
        sealed,
        now(),
      );
      return settingsOut(ctx.locationId);
    });
    /** Checks the key (typed or stored) against the Models API – costs no tokens. */
    router.post('/api/ai/test', 'location', async (ctx) => {
      const { settings } = load(ctx.locationId);
      const typed = str(ctx.body?.api_key, 'API-Schlüssel', { max: 300 });
      if (typed && !KEY_RE.test(typed)) throw bad('Das sieht nicht nach einem Anthropic-API-Schlüssel aus (beginnt mit sk-ant-).');
      const key = typed || keyFor(ctx.locationId);
      if (!key) throw bad('Bitte zuerst einen API-Schlüssel eintragen.');
      const model = MODELS.some((m) => m.id === ctx.body?.model) ? String(ctx.body.model) : settings.model;
      const t = Date.now();
      try {
        const r = await checkKey(key, model, fetchAi);
        logCall({ locationId: ctx.locationId, purpose: 'test', model, status: 'ok', ms: Date.now() - t, userId: ctx.user?.id });
        return { ok: true, model: r.model, name: r.name };
      } catch (e) {
        const err = e instanceof AiError ? e : new AiError((e as Error).message);
        logCall({ locationId: ctx.locationId, purpose: 'test', model, status: 'error', error: err.message, userId: ctx.user?.id });
        throw new HttpError(err.status, err.message);
      }
    });
    router.get('/api/ai/usage', 'location', (ctx) => {
      const { settings } = load(ctx.locationId);
      const month = usageOut(ctx.locationId, settings);
      const byPurpose = db.all(
        `SELECT purpose, COUNT(*) AS calls, COALESCE(SUM(cost_micros), 0) AS cost, COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens,
           COALESCE(SUM(cache_read_tokens), 0) AS cached
         FROM ai_calls WHERE location_id = ? AND created_at >= ? AND status <> 'blocked' GROUP BY purpose ORDER BY cost DESC`,
        ctx.locationId,
        month.since,
      );
      const recent = db.all(
        `SELECT id, purpose, model, status, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micros, ms, contact_id, conversation_id, error, created_at
         FROM ai_calls WHERE location_id = ? ORDER BY created_at DESC LIMIT ?`,
        ctx.locationId,
        Math.min(Math.max(1, num(ctx.query.get('limit'), 100)), 500),
      );
      return {
        month,
        purposes: PURPOSES,
        by_purpose: byPurpose.map((p) => ({ purpose: p.purpose, calls: p.calls, cost_usd: p.cost / 1e6, tokens: p.tokens, cached_tokens: p.cached })),
        recent: recent.map((r) => ({ ...r, cost_usd: r.cost_micros / 1e6 })),
      };
    });

    // --- routes: conversations ------------------------------------------------------------------
    router.post('/api/ai/suggest', 'location', async (ctx) => {
      const purpose = ctx.body?.purpose === 'mcp' || ctx.via === 'mcp' ? 'mcp' : 'suggest';
      return suggest(ctx.locationId, ctx.body ?? {}, purpose, ctx.user?.id ?? null);
    });
    router.post('/api/ai/summarize', 'location', async (ctx) => {
      const { conv, contact, messages } = thread(ctx.locationId, { conversation_id: str(ctx.body?.conversation_id, 'Konversation', { required: true }) });
      if (!messages.length) throw bad('Noch keine Nachrichten zum Zusammenfassen');
      const { settings } = load(ctx.locationId);
      const r = await runAi({
        locationId: ctx.locationId,
        purpose: 'summary',
        user: `${userContext(ctx.locationId, contact, messages, settings, 40)}\n\n${SUMMARY_TASK}`,
        schema: SUMMARY_SCHEMA,
        contactId: contact.id,
        conversationId: conv.id,
        userId: ctx.user?.id ?? null,
      });
      const parsed = parseSummary(r.text);
      if (!parsed.ok) throw new HttpError(502, `Die Zusammenfassung der KI war unbrauchbar (${parsed.error}) – bitte erneut versuchen.`);
      stateOf(ctx.locationId, conv.id);
      db.run('UPDATE ai_conversations SET summary = ?, next_step = ?, summary_at = ?, updated_at = ? WHERE conversation_id = ?', parsed.value.summary, parsed.value.next_step, now(), now(), conv.id);
      return { ...parsed.value, summary_at: now() };
    });
    const convOut = (locId: string, convId: string) => {
      const conv = db.get('SELECT id FROM conversations WHERE id = ? AND location_id = ?', convId, locId);
      if (!conv) throw notFound('Konversation nicht gefunden');
      const { settings } = load(locId);
      const s = db.get('SELECT * FROM ai_conversations WHERE conversation_id = ?', convId);
      return {
        enabled: settings.enabled && hasKey(locId),
        bot_mode: settings.bot_mode,
        bot_status: s?.bot_status ?? 'active',
        handoff_reason: s?.handoff_reason ?? '',
        handoff_at: s?.handoff_at ?? null,
        bot_replies: s?.bot_replies ?? 0,
        summary: s?.summary ?? '',
        next_step: s?.next_step ?? '',
        summary_at: s?.summary_at ?? null,
        opportunity_id: s?.opportunity_id ?? null,
        task_id: s?.task_id ?? null,
      };
    };
    router.get('/api/ai/conversations/:id', 'location', (ctx) => convOut(ctx.locationId, ctx.params.id));
    router.patch('/api/ai/conversations/:id', 'location', (ctx) => {
      convOut(ctx.locationId, ctx.params.id);
      const status = ctx.body?.bot_status;
      if (!['active', 'paused'].includes(status)) throw bad('bot_status: active oder paused');
      stateOf(ctx.locationId, ctx.params.id);
      if (status === 'active') db.run(`UPDATE ai_conversations SET bot_status = 'active', handoff_reason = '', handoff_at = NULL, bot_replies = 0, updated_at = ? WHERE conversation_id = ?`, now(), ctx.params.id);
      else db.run(`UPDATE ai_conversations SET bot_status = 'paused', updated_at = ? WHERE conversation_id = ?`, now(), ctx.params.id);
      return convOut(ctx.locationId, ctx.params.id);
    });

    // --- live-chat bot ------------------------------------------------------------------------
    const botSay = (locId: string, contactId: string, body: string) => sendToContact(app, locId, { contactId, channel: 'chat', body: `🤖 ${body}`, source: BOT_SOURCE });

    const handoff = async (locId: string, conv: any, contact: Contact, reason: string, s: AiSettings, lastText: string) => {
      db.run(`UPDATE ai_conversations SET bot_status = 'handoff', handoff_reason = ?, handoff_at = ?, updated_at = ? WHERE conversation_id = ?`, reason.slice(0, 300), now(), now(), conv.id);
      await botSay(locId, contact.id, s.handoff_message);
      logActivity(app, locId, contact.id, 'ai.handoff', `KI-Assistent hat an das Team übergeben: ${reason}`);
      void notifyTeam(
        app,
        locId,
        `Chat-Übergabe: ${contactName(contact)}`,
        `Der KI-Assistent hat ein Gespräch im Website-Chat an euch übergeben.\nGrund: ${reason}\n\nLetzte Nachricht:\n${lastText.slice(0, 1000)}\n\nAntworten: ${app.baseUrl()}/app/conversations/${conv.id}`,
      ).catch(() => undefined);
      app.events.emit(locId, 'ai.handoff', { contactId: contact.id, conversationId: conv.id, reason });
    };

    const captureLead = (locId: string, contact: Contact, lead: BotLead) => {
      const patch: Record<string, string> = {};
      const placeholder = !contact.first_name || contact.first_name === 'Website-Besucher';
      if (lead.first_name && placeholder) patch.first_name = lead.first_name;
      if (lead.last_name && !contact.last_name && (placeholder || lead.first_name.toLowerCase() === contact.first_name.toLowerCase())) patch.last_name = lead.last_name;
      if (lead.email && !contact.email) {
        const email = normalizeEmail(lead.email);
        // Merging two contacts is a human decision: don't take an address another contact already has.
        if (!db.get('SELECT id FROM contacts WHERE location_id = ? AND email = ? AND id <> ?', locId, email, contact.id)) patch.email = email;
      }
      if (lead.phone && !contact.phone) patch.phone = lead.phone;
      if (!Object.keys(patch).length) return contact;
      const { contact: updated } = upsertContact(app, locId, { id: contact.id, ...patch }, { source: 'Live-Chat', publicInput: true });
      const labels: Record<string, string> = { first_name: 'Vorname', last_name: 'Nachname', email: 'E-Mail', phone: 'Telefon' };
      logActivity(app, locId, contact.id, 'ai.lead', `KI-Assistent hat Kontaktdaten ergänzt: ${Object.keys(patch).map((k) => labels[k]).join(', ')}`);
      return updated;
    };

    const buyingIntent = async (locId: string, conv: any, contact: Contact, out: BotOutput, s: AiSettings) => {
      const st = stateOf(locId, conv.id);
      if (st.opportunity_id || st.task_id) return;
      const what = out.intent_summary || 'Kaufinteresse im Website-Chat';
      let oppId: string | null = null;
      let taskId: string | null = null;
      if (s.create_opportunity && s.pipeline_id) {
        const open = db.get(`SELECT id FROM opportunities WHERE contact_id = ? AND pipeline_id = ? AND status = 'open'`, contact.id, s.pipeline_id);
        if (open) oppId = open.id;
        else {
          try {
            oppId = createOpportunity(app, locId, { pipeline_id: s.pipeline_id, stage_id: s.stage_id || undefined, contact_id: contact.id, name: `${contactName(contact)} – ${what}`.slice(0, 120), source: BOT_SOURCE }).id;
          } catch (e) {
            console.error('[ai] Opportunity', (e as Error).message);
          }
        }
      }
      if (s.create_task) {
        taskId = id();
        db.insert('tasks', { id: taskId, location_id: locId, contact_id: contact.id, title: `Chat-Lead nachfassen: ${what}`.slice(0, 200), description: 'Vom KI-Assistenten erkannt: Kaufinteresse im Website-Chat.', due_at: now(), assigned_to: null, done: 0, created_at: now() });
      }
      if (!oppId && !taskId) return;
      db.run('UPDATE ai_conversations SET opportunity_id = ?, task_id = ?, updated_at = ? WHERE conversation_id = ?', oppId, taskId, now(), conv.id);
      logActivity(app, locId, contact.id, 'ai.intent', `KI-Assistent hat Kaufinteresse erkannt: ${what}`);
      void notifyTeam(app, locId, `Kaufinteresse im Chat: ${contactName(contact)}`, `${what}\n\n${oppId ? 'Opportunity angelegt. ' : ''}${taskId ? 'Aufgabe angelegt.' : ''}\n\n${app.baseUrl()}/app/conversations/${conv.id}`).catch(() => undefined);
    };

    /** Answers the newest chat message of a conversation, or hands it to the team. */
    const botTurn = async (locId: string, convId: string) => {
      const { settings } = load(locId);
      if (!botActive(settings, tzOf(locId)) || !hasKey(locId)) return;
      const conv = db.get('SELECT * FROM conversations WHERE id = ? AND location_id = ?', convId, locId);
      if (!conv) return;
      const st = stateOf(locId, convId);
      if (st.bot_status !== 'active') return;
      const messages = db.all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at', convId);
      // Chat messages from the visitor not answered yet (several may arrive while the model writes).
      const pending = messages.filter((m) => m.direction === 'in' && m.channel === 'chat' && (!st.answered_until || m.created_at > st.answered_until));
      if (!pending.length) return;
      const lastText = pending.map((m) => m.body).join('\n');
      // Someone from the team wrote here recently: the person handles it.
      if (messages.some((m) => m.direction === 'out' && m.user_id && Date.parse(m.created_at) > Date.now() - 2 * 3600_000)) return;
      let contact = getContact(app, locId, conv.contact_id);
      if (!contact) return;
      db.run('UPDATE ai_conversations SET answered_until = ?, updated_at = ? WHERE conversation_id = ?', pending[pending.length - 1].created_at, now(), convId);
      const recentReplies = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE location_id = ? AND source = ? AND created_at > ?`, locId, BOT_SOURCE, new Date(Date.now() - 3600_000).toISOString())!.n;
      const pre = recentReplies >= BOT_HOURLY_CAP ? 'Zu viele Bot-Antworten in dieser Stunde' : handoffBefore(lastText, { keywords: settings.handoff_keywords, botReplies: st.bot_replies, maxReplies: settings.max_bot_replies });
      if (pre) return handoff(locId, conv, contact, pre, settings, lastText);
      let raw: string;
      try {
        const contactId = contact.id;
        const ask = (user: string, schema: Record<string, unknown>) => runAi({ locationId: locId, purpose: 'chat_bot', user, schema, contactId, conversationId: convId });
        const prompt = `${visitorContext(locId, contact, messages, settings)}\n\n${botTask(settings, missingLead(contact))}`;
        // "Termin buchen" (modules/ai-booking.ts): with calendars released for the AI the bot may look up free times and book one.
        const turn = app.services.chatBotTurn as undefined | ((o: { locationId: string; contact: Contact; conversationId: string; prompt: string; schema: typeof BOT_SCHEMA; ask: typeof ask }) => Promise<{ text: string }>);
        const r = turn ? await turn({ locationId: locId, contact, conversationId: convId, prompt, schema: BOT_SCHEMA, ask }) : await ask(prompt, BOT_SCHEMA);
        raw = r.text;
      } catch (e) {
        return handoff(locId, conv, contact, `KI nicht verfügbar: ${(e as Error).message}`, settings, lastText);
      }
      const parsed = parseBotOutput(raw);
      if (!parsed.ok) return handoff(locId, conv, contact, `KI-Antwort unbrauchbar (${parsed.error})`, settings, lastText);
      const out = parsed.value;
      if (settings.lead_capture) contact = captureLead(locId, contact, out.lead);
      if (out.buying_intent) await buyingIntent(locId, conv, contact, out, settings);
      const post = handoffAfter(out, settings.min_confidence);
      if (post) return handoff(locId, conv, contact, post, settings, lastText);
      await botSay(locId, contact.id, out.reply);
      db.run('UPDATE ai_conversations SET bot_replies = bot_replies + 1, updated_at = ? WHERE conversation_id = ?', now(), convId);
    };

    // One turn per conversation at a time; messages arriving meanwhile get one more turn afterwards.
    const running = new Map<string, Promise<void>>();
    const again = new Set<string>();
    const queueBot = (locId: string, convId: string): Promise<void> => {
      const busy = running.get(convId);
      if (busy) {
        again.add(convId);
        return busy;
      }
      const p = (async () => {
        try {
          do {
            again.delete(convId);
            await botTurn(locId, convId);
          } while (again.has(convId));
        } catch (e) {
          console.error('[ai] Bot', e);
        } finally {
          running.delete(convId);
        }
      })();
      running.set(convId, p);
      return p;
    };

    /** Inbound mail (webhook): an AI reply draft next to it – never sent automatically. */
    const emailDraft = async (locId: string, msg: any) => {
      const { settings } = load(locId);
      if (!settings.enabled || !settings.email_drafts || !hasKey(locId)) return;
      const n = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ai_calls WHERE location_id = ? AND purpose = 'email_draft' AND created_at > ?`, locId, new Date(Date.now() - 3600_000).toISOString())!.n;
      if (n >= DRAFTS_HOURLY_CAP) return;
      try {
        const r = await suggest(locId, { conversation_id: msg.conversation_id, channel: 'email' }, 'email_draft');
        db.run(`DELETE FROM messages WHERE conversation_id = ? AND status = 'draft' AND source = ?`, msg.conversation_id, DRAFT_SOURCE);
        db.insert('messages', { id: id(), location_id: locId, conversation_id: msg.conversation_id, contact_id: msg.contact_id, channel: 'email', direction: 'out', subject: r.subject || (msg.subject ? `Re: ${msg.subject}` : ''), body: r.text, status: 'draft', error: '', source: DRAFT_SOURCE, user_id: null, created_at: now() });
      } catch {
        /* logged in ai_calls */
      }
    };

    app.events.on('message.inbound', async (e) => {
      const m = e.data.message;
      if (!m || m.direction !== 'in') return;
      if (m.channel === 'chat') await queueBot(e.locationId, m.conversation_id);
      else if (m.channel === 'email' && m.source === 'eingehend') await emailDraft(e.locationId, m);
    });

    // --- workflow action "KI-Text erzeugen" -----------------------------------------------------
    app.services.workflowActions = {
      ...(app.services.workflowActions ?? {}),
      ai_text: async (run: any, step: any, vars: Record<string, any>) => {
        const locId = run.location_id;
        const prompt = render(String(step.prompt ?? ''), vars).trim();
        if (!prompt) throw new Error('Prompt fehlt');
        const contact = getContact(app, locId, run.contact_id);
        if (!contact) throw new Error('Kontakt nicht gefunden');
        const conv = db.get('SELECT id FROM conversations WHERE location_id = ? AND contact_id = ?', locId, contact.id);
        const messages = conv ? db.all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at', conv.id) : [];
        const { settings } = load(locId);
        let text: string;
        try {
          text = (await runAi({ locationId: locId, purpose: 'workflow', user: `${userContext(locId, contact, messages, settings, 10)}\n\n${workflowTask(prompt)}`, contactId: contact.id, conversationId: conv?.id ?? null })).text.slice(0, 10_000);
        } catch (e) {
          throw new Error((e as Error).message);
        }
        const target = String(step.target ?? 'field');
        const short = text.length > 60 ? `${text.slice(0, 60)}…` : text;
        if (target === 'field') {
          const field = String(step.field ?? '');
          if (field.startsWith('custom.') && field.length > 7) {
            const c = getContact(app, locId, contact.id)!;
            db.update('contacts', contact.id, { custom: { ...c.custom, [field.slice(7)]: text }, updated_at: now() });
          } else if ((CONTACT_FIELDS as readonly string[]).includes(field) && !['assigned_to', 'date_of_birth', 'email', 'phone'].includes(field)) {
            db.update('contacts', contact.id, { [field]: text.slice(0, 500), updated_at: now() });
          } else throw new Error(`Feld ${field || '(leer)'} geht hier nicht`);
          return `${field} = ${short}`;
        }
        if (target === 'email_draft') {
          const cid = conv?.id ?? getOrCreateConversation(app, locId, contact.id);
          db.insert('messages', { id: id(), location_id: locId, conversation_id: cid, contact_id: contact.id, channel: 'email', direction: 'out', subject: render(String(step.subject ?? ''), vars).slice(0, 300), body: text, status: 'draft', error: '', source: DRAFT_SOURCE, user_id: null, created_at: now() });
          return `E-Mail-Entwurf angelegt: ${short}`;
        }
        if (target === 'note') {
          db.insert('notes', { id: id(), location_id: locId, contact_id: contact.id, body: text, user_id: null, created_at: now() });
          return `Notiz angelegt: ${short}`;
        }
        throw new Error('Ziel unbekannt');
      },
    };
  },
};
