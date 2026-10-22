import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import { RULES, catalogText, checkAgent, type AgentDraft, type CatalogTool } from '../services/agent-ai.js';
import { auditLog, json, limiter } from '../services/creator-kit.js';
import { callRoute } from '../services/route-call.js';
import { askChecked, estimate, modelInfo } from '../services/site-ai-kit.js';
import { estimateTokens } from '../services/site-ai.js';
import { PURPOSES } from './ai-assistant.js';
import type { Tool } from './mcp.js';

/**
 * "KI-Agent mit KI erstellen" (HighLevel's Agent Studio "Build with AI"): a description becomes a custom-agent config – name,
 * instructions, model, tools picked from the real tool catalogue, knowledge sources, safety mode, max steps, optional schedule –
 * checked against the custom-agent schema and the tool registry (services/agent-ai.ts, up to three attempts), shown for review
 * and saved as a DRAFT agent: private, its schedule switched off and no auto-responder, until the owner switches it on.
 * Same model routing, cost estimate and monthly limit as the Funnel & Website AI (services/site-ai-kit.ts). MCP `ghl_agent_generate`.
 */

const PURPOSE = 'agent_builder';
export const EXAMPLES = [
  'Ein Vertriebs-Assistent, der neue Leads prüft, fehlende Angaben nachträgt und Nachfass-Aufgaben anlegt.',
  'Jeden Montag um 8 Uhr ein Bericht über offene Deals und überfällige Aufgaben per E-Mail.',
  'Ein Support-Agent, der Tickets beantwortet – nur Entwürfe, nichts versenden.',
];

const TOOLS: Tool[] = [
  {
    name: 'ghl_agent_generate',
    title: 'KI-Agent mit KI entwerfen',
    description:
      'Entwirft aus einer Beschreibung einen eigenen KI-Agenten: Name, Anweisungen, Werkzeuge aus dem echten Werkzeug-Katalog, Wissensquellen, Sicherheitsmodus, Schrittlimit und optional einen Zeitplan – geprüft gegen das Agenten-Schema (bis zu drei Versuche). Mit apply=true wird er als ENTWURF gespeichert (privat, Zeitplan aus), sonst nur Vorschau. Braucht eine angemeldete Person (Agenten gehören einer Person); der HyperLevel-Agent selbst entwirft nur – speichern muss die Person. Kostet KI-Tokens (Monatslimit des KI-Assistenten).',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID' }, prompt: { type: 'string', description: 'Was der Agent tun soll' }, apply: { type: 'boolean', description: 'true: als Entwurf speichern' } }, required: ['location_id', 'prompt'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    klassFor: () => 'write',
    run: async (call, a) => {
      const r = await call.api('POST', '/api/agent-ai/generate', { body: { prompt: a.prompt }, location: a.location_id });
      const applied = a.apply ? await call.api('POST', `/api/agent-ai/runs/${encodeURIComponent(r.run_id)}/apply`, { body: {}, location: a.location_id }) : null;
      return { run_id: r.run_id, config: r.config, summary: r.summary, notes: r.notes, warnings: r.warnings, cost_usd: r.cost_usd, applied: applied ? { agent_id: applied.id, name: applied.name, draft: true } : null };
    },
  },
];

export const agentAiModule: Module = {
  name: 'agent-ai',
  migrations: [
    [
      '001-init',
      `CREATE TABLE agent_ai_runs (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, user_id TEXT NOT NULL, prompt TEXT NOT NULL DEFAULT '',
        result TEXT NOT NULL DEFAULT '{}', cost_micros INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'ok', applied_agent_id TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX agent_ai_runs_loc ON agent_ai_runs(location_id, created_at);`,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    Object.assign(PURPOSES, { agent_builder: 'KI-Agent mit KI erstellen' });
    const tooMany = limiter(20, 3600_000);
    const userOf = (ctx: Ctx) => {
      if (!ctx.user) throw new HttpError(403, 'Nur mit Anmeldung – ein KI-Agent gehört einer Person.');
      return ctx.user;
    };
    const catalogOf = (ctx: Ctx): CatalogTool[] => ((app.services.agent?.toolCatalog?.(userOf(ctx), true) ?? []) as any[]).map((t) => ({ name: t.name, title: t.title, group: t.group, klass: t.klass }));

    router.get('/api/agent-ai/status', 'location', (ctx) => {
      const reason: string | null = app.services.aiReady?.(ctx.locationId) ?? (app.services.aiRun ? null : 'Der KI-Assistent ist nicht verfügbar.');
      const m = modelInfo(app, ctx.locationId, PURPOSE, ctx.user?.id);
      return { ready: !reason && !!app.services.agent, reason: reason ?? (app.services.agent ? null : 'Der KI-Agent ist nicht verfügbar.'), provider: { label: m.label, model: m.model, byok: m.byok }, examples: EXAMPLES };
    });

    router.post('/api/agent-ai/generate', 'location', async (ctx) => {
      const user = userOf(ctx);
      if (ctx.scope === 'read') throw new HttpError(403, 'Dieser Schlüssel darf nur lesen');
      const prompt = typeof ctx.body?.prompt === 'string' ? ctx.body.prompt.trim().slice(0, 4000) : '';
      if (prompt.length < 12) throw bad('Beschreibe in ein bis zwei Sätzen, was der Agent tun soll.');
      const tools = catalogOf(ctx);
      if (!tools.length) throw new HttpError(409, 'Der KI-Agent ist nicht verfügbar.');
      const system = [{ text: `${RULES}\n\nWERKZEUG-KATALOG (name · Titel (read = liest, write = ändert, sensitive = versendet/löscht/bezahlt))\n${catalogText(tools)}`, cache: true }];
      const est = estimate(app, ctx.locationId, PURPOSE, user.id, estimateTokens({ mode: 'write', systemChars: system[0].text.length, userChars: prompt.length }));
      if (tooMany(ctx.locationId)) throw new HttpError(429, 'Zu viele KI-Entwürfe in kurzer Zeit – bitte in einigen Minuten erneut versuchen.');
      const ready: string | null = app.services.aiReady?.(ctx.locationId) ?? (app.services.aiRun ? null : 'Der KI-Assistent ist nicht verfügbar.');
      if (ready || est.problem) throw new HttpError(409, (ready ?? est.problem)!);
      const catalog = new Map(tools.map((t) => [t.name, t]));
      let extra = { summary: '', notes: [] as string[] };
      const r = await askChecked<AgentDraft>(app, ctx, {
        purpose: PURPOSE,
        what: 'Agenten-Entwurf',
        system,
        user: `BESCHREIBUNG\n${prompt}`,
        maxTokens: 5000,
        timeoutMs: 120_000,
        check: (raw) => {
          const c = checkAgent(raw, catalog);
          extra = { summary: c.summary, notes: c.notes };
          return { value: c.draft, errors: c.errors, warnings: c.warnings };
        },
      });
      const result = { config: r.value, summary: extra.summary, notes: extra.notes, warnings: r.warnings };
      const rid = id();
      db.insert('agent_ai_runs', { id: rid, location_id: ctx.locationId, user_id: user.id, prompt, result: JSON.stringify(result), cost_micros: r.cost_micros, status: 'ok', applied_agent_id: null, created_at: now() });
      return { run_id: rid, ...result, tools: r.value.tools.map((n) => catalog.get(n)), attempts: r.attempts, model: r.model, cost_usd: r.cost_micros / 1e6, estimate_usd: est.usd };
    });

    /** Saves the proposal as a draft agent of the asker: private, schedule off, no auto-responder. */
    router.post('/api/agent-ai/runs/:id/apply', 'location', async (ctx) => {
      const user = userOf(ctx);
      const run = db.get<any>('SELECT * FROM agent_ai_runs WHERE id = ? AND location_id = ? AND user_id = ?', ctx.params.id, ctx.locationId, user.id);
      if (!run) throw notFound('KI-Entwurf nicht gefunden');
      if (run.status === 'applied') throw new HttpError(409, 'Dieser KI-Entwurf wurde schon gespeichert.');
      const c = json<any>(run.result, {}).config as AgentDraft;
      const { schedule, ...rest } = c;
      const agent = await callRoute(app, ctx, 'POST', '/api/agents', { ...rest, visibility: 'private', responder: { enabled: false, channels: [], mode: 'draft', outside_hours: false }, schedules: schedule ? [{ ...schedule, enabled: false }] : [] });
      db.run(`UPDATE agent_ai_runs SET status = 'applied', applied_agent_id = ? WHERE id = ?`, agent.id, run.id);
      auditLog(app, ctx, ctx.locationId, 'agent_ai.apply', `KI-Entwurf „${c.name}“ als privater Agent gespeichert (Zeitplan aus)`, agent.id);
      return { ...agent, draft: true, message: 'Als Entwurf gespeichert: privat, Zeitplan ausgeschaltet. Prüfen, testen und dann einschalten oder teilen.' };
    });

    app.onTick(() => {
      db.run('DELETE FROM agent_ai_runs WHERE created_at < ?', new Date(Date.now() - 30 * 864e5).toISOString());
    });
  },
};
