import type { Module } from '../core/app.js';
import { HttpError, bad, str, type Ctx } from '../core/http.js';
import { now } from '../core/util.js';
import { ymdInTz } from '../core/time.js';
import { boardData, denial } from '../services/boards-data.js';
import { cleanLine, type BoardSpec } from '../services/boards-model.js';
import { boardWidgets, type View } from '../services/boards-widgets.js';
import { FOCUS_SYSTEM, factsOf, focusPrompt, focusSchema, focusTypes, noInventedNumbers, parseFocusAnswer, sourceOf, validateTiles, type FocusContext, type ValidTile } from '../services/focus-compose.js';
import { planRules, type Lang } from '../services/focus-rules.js';
import { callRoute } from '../services/route-call.js';
import { PURPOSES } from './ai-assistant.js';
import type { Tool } from './mcp.js';

/**
 * Fokus-Modus: HyperLevel as a source of truth you simply ask. A question – typed, spoken, or from another agent over MCP – becomes an
 * ephemeral view made of Living Boards widgets: a short spoken-style sentence plus tiles, each with its data and where that data
 * comes from. The model (KI-Assistent, purpose "focus") only picks widgets and settings in a strict schema; without a model, after
 * an invalid answer or over the hourly limit, German/English keyword rules do the same (services/focus-rules.ts). Every tile is
 * checked against the widget catalogue and read through the caller's own API routes, pinned to the caller's sub-account – so
 * nothing is invented and nothing is shown the caller could not open on its page. Read only: no route here writes CRM data (an AI
 * call is logged in ai_calls like every other). Asking for an action ("schick eine Mail …") gets a note and the offer to continue in
 * the HyperLevel Agent. Docs: docs/living-boards.md#fokus-modus.
 */

/** AI questions per person and hour (like the board wishes); beyond that the rules answer. */
const HOURLY = 40;
/** Questions per person and minute, AI or not (a runaway agent loop must not keep the server busy). */
const PER_MINUTE = 40;
const MAX_TEXT = 1000;

const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });

export const FOCUS_TOOLS: Tool[] = [
  {
    name: 'ghl_focus_view',
    title: 'Fokus: Frage → fertige Ansicht',
    description:
      'Beantwortet eine Frage in Alltagssprache („Offene Deals“, „Umsatz diesen Monat“, „Was ist überfällig?“, „Termine heute“) mit einer fertigen Ansicht: say (ein Satz zum Vorlesen, mit Zahlen nur aus den gelesenen Daten) und tiles – Living-Boards-Widgets mit ihren aktuellen Daten (data: Kennzahl, Liste, Termine …) und ihrer Quelle (Bereich, Zeitraum, Link). Gelesen mit den Rechten der Verbindung im genannten Sub-Account, nur lesend – Aktionen führt das Werkzeug nie aus (action nennt sie nur). Mit KI-Assistent wählt die KI die Widgets, sonst feste Regeln (rules_only erzwingt sie). Gut als Einstieg, bevor man einzelne Listen-Werkzeuge bemüht.',
    inputSchema: obj(
      {
        location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' },
        question: { type: 'string', description: 'Die Frage, z. B. „Offene Deals über 5.000 €“ oder „Was ist heute überfällig?“' },
        history: { type: 'array', items: { type: 'string' }, description: 'Frühere Fragen (älteste zuerst) für Rückfragen wie „und nur meine?“' },
        lang: { type: 'string', enum: ['de', 'en'], description: 'Sprache von say und den Titeln (Standard de)' },
        rules_only: { type: 'boolean', description: 'Ohne KI, nur nach festen Regeln (kostet keine Tokens)' },
      },
      ['location_id', 'question'],
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
    // the inbox tile carries message previews: third-party text for the agent
    untrusted: true,
    run: async (call, a) => {
      const q = new URLSearchParams({ text: String(a.question) });
      if (a.lang) q.set('lang', String(a.lang));
      if (a.rules_only) q.set('rules', '1');
      for (const h of (Array.isArray(a.history) ? a.history : []).slice(-4)) q.append('history', String(h));
      // GET: the same answer as POST /api/focus/ask, and a read for read-only keys and the agent's read-only tools
      const r = await call.api('GET', `/api/focus/ask?${q}`, { location: a.location_id });
      return {
        say: r.say,
        source: r.source,
        ...(r.note ? { note: r.note } : {}),
        action: r.action,
        tiles: (r.tiles as any[]).map((t) => ({ type: t.type, title: t.title, config: t.config, source: t.source, data: t.data?.view })),
        link: '/app/focus',
      };
    },
  },
];

export const focusModule: Module = {
  name: 'focus',
  register(app) {
    const { db, router } = app;
    Object.assign(PURPOSES, { focus: 'Fokus-Modus' });
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...FOCUS_TOOLS];

    // --- limits per person -----------------------------------------------------------------------------------------------
    const hits = new Map<string, number[]>();
    const throttle = (ctx: Ctx) => {
      const key = ctx.user?.id ?? ctx.ip;
      const t = Date.now();
      const list = (hits.get(key) ?? []).filter((x) => t - x < 60_000);
      if (list.length >= PER_MINUTE) throw new HttpError(429, 'Zu viele Fragen in kurzer Zeit – bitte eine Minute warten');
      list.push(t);
      hits.set(key, list);
      if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => t - x < 60_000)) hits.delete(k);
    };
    const aiUsed = (ctx: Ctx) => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ai_calls WHERE location_id = ? AND purpose = 'focus' AND user_id IS ? AND created_at > ?", ctx.locationId, ctx.user?.id ?? null, new Date(Date.now() - 3600_000).toISOString())!.n;
    /** null when a question would go to the model, else why not ('off' = no AI here, 'limit' = hourly limit reached). */
    const aiBlock = (ctx: Ctx): 'off' | 'limit' | null => {
      if (!app.services.aiRun) return 'off';
      const why = app.services.aiReady ? (app.services.aiReady(ctx.locationId) as string | null) : null;
      if (why) return 'off';
      return aiUsed(ctx) >= HOURLY ? 'limit' : null;
    };

    /** The ids of the caller's own data the model may name – each list read with the caller's rights; a missing area is left out. */
    const viewerContext = async (ctx: Ctx): Promise<FocusContext> => {
      const get = async (path: string): Promise<{ id: string; name: string }[]> => {
        try {
          const r = await callRoute(app, ctx, 'GET', path, {}, { quiet: true });
          const list = (Array.isArray(r) ? r : (r?.reports ?? [])) as any[];
          return list.map((x) => ({ id: String(x.id), name: String(x.name ?? '') }));
        } catch {
          return [];
        }
      };
      const [pipelines, calendars, projects, smart_lists, reports] = await Promise.all([get('/api/pipelines'), get('/api/calendars'), get('/api/pm/projects'), get('/api/smart-lists'), get('/api/reports/library')]);
      return { pipelines, calendars, projects, smart_lists, reports };
    };

    const read = (ctx: Ctx, src: Record<string, any>, query: boolean) => {
      const text = cleanLine(str(src.text, 'Frage', { required: true, max: MAX_TEXT }), MAX_TEXT);
      if (text.length < 2) throw bad('Bitte sag kurz, was du wissen möchtest.');
      const rawHistory = query ? ctx.query.getAll('history') : Array.isArray(src.history) ? src.history : [];
      const history = rawHistory
        .filter((h: unknown) => typeof h === 'string')
        .map((h: string) => cleanLine(h, 200))
        .filter(Boolean)
        .slice(-4);
      const lang: Lang = src.lang === 'en' ? 'en' : 'de';
      const rulesOnly = query ? src.rules === '1' || src.rules === 'true' : src.rules_only === true;
      return { text, history, lang, rulesOnly };
    };

    /** The question → the view: the model's plan or the rules', checked, then read for the caller. Never writes CRM data. */
    const answer = async (ctx: Ctx, input: { text: string; history: string[]; lang: Lang; rulesOnly: boolean }) => {
      throttle(ctx);
      const reg = boardWidgets(app);
      const env = { app, locationId: ctx.locationId };
      let source: 'ai' | 'rules' = 'rules';
      let note: 'rules' | 'off' | 'limit' | 'error' | 'invalid' | null = input.rulesOnly ? 'rules' : aiBlock(ctx);
      let say = '';
      let action: string | null = null;
      let plan: ValidTile[] = [];
      if (!note) {
        try {
          const tz = app.location(ctx.locationId)?.timezone || 'Europe/Berlin';
          const types = focusTypes(reg);
          const prompt = focusPrompt({ today: ymdInTz(new Date(), tz), tz, person: ctx.user?.name ?? 'Unbekannt', lang: input.lang, catalogue: types.map((d) => reg.describe(d)), context: await viewerContext(ctx), history: input.history, request: input.text });
          const system = FOCUS_SYSTEM.replace('{brand}', String(app.services.brandName?.() ?? 'HyperLevel')).replace('{lang}', input.lang === 'en' ? 'Englisch' : 'Deutsch');
          const r = await app.services.aiRun({ locationId: ctx.locationId, purpose: 'focus', user: prompt, system: [{ text: system }], schema: focusSchema(types.map((d) => d.type)), maxTokens: 1500, timeoutMs: 45_000, userId: ctx.user?.id ?? null });
          const a = parseFocusAnswer(String(r?.text ?? ''));
          const checked = a ? validateTiles(a.tiles, reg, env, input.text, { fromModel: true }).tiles : [];
          const wants = a ? cleanLine(a.action, 300) : '';
          if (a && (checked.length || wants)) {
            source = 'ai';
            plan = checked;
            action = wants ? input.text : null;
            // the model knows no data: a sentence with a number the person did not say is not used
            const s = cleanLine(a.say, 300);
            say = s && noInventedNumbers(s, input.text) ? s : '';
          } else note = 'invalid';
        } catch {
          note = 'error';
        }
      }
      if (source === 'rules') {
        const p = planRules(input.text, input.lang, input.history);
        plan = validateTiles(p.tiles, reg, env, input.text).tiles;
        say = p.say;
        action = p.action;
      }
      // Read every tile as the caller, in the caller's sub-account (the same reader as a board's data).
      const spec: BoardSpec = { v: 1, widgets: plan.map((x, i) => ({ id: `wfocus${i + 1}`, type: x.type, title: x.title, config: x.config, layout: { lg: { x: 0, y: 0, w: x.w, h: x.h } } })) };
      const data = await boardData(app, ctx, spec, reg);
      const tiles = plan
        .map((x, i) => {
          const id = spec.widgets[i].id;
          const def = reg.get(x.type)!;
          const d = data[id];
          const view = d?.view as View | undefined;
          return { id, type: x.type, title: x.title || view?.title || def.label, config: x.config, w: x.w, h: x.h, optional: !!x.optional, source: sourceOf(def, x.config, view, input.lang), data: d };
        })
        // the general overview leaves out what the caller may not see; an explicit question keeps the locked card (it says why)
        .filter((x) => !(x.optional && x.data?.view?.kind === 'locked'))
        .map(({ optional: _o, ...x }) => x);
      if (!say) say = input.lang === 'en' ? 'Here is what I found.' : 'Das habe ich dazu gefunden.';
      const facts = factsOf(tiles.map((x) => ({ type: x.type, title: x.title, config: x.config, view: x.data?.view as View | undefined })), input.lang);
      if (facts.length) say = `${say.replace(/[.!?…]?$/, '.')} ${facts.join(', ')}.`;
      return { say, source, note, action, tiles, at: now() };
    };

    router.get('/api/focus/status', 'location', (ctx) => {
      const block = aiBlock(ctx);
      const why = block === 'off' ? ((app.services.aiReady?.(ctx.locationId) as string | null) ?? 'Der KI-Assistent ist nicht verfügbar.') : block === 'limit' ? `Du hast in der letzten Stunde schon ${HOURLY} Fragen an die KI gestellt – bis dahin antworten feste Regeln.` : null;
      return { ai: !block, reason: why, hourly: HOURLY, used: aiUsed(ctx), can_save: !denial(app, ctx, '/api/boards') };
    });

    router.post('/api/focus/ask', 'location', async (ctx) => {
      // a question changes nothing: no write hooks, no audit entry (an AI call is logged in ai_calls)
      ctx.skipAfterWrite = true;
      return answer(ctx, read(ctx, ctx.body ?? {}, false));
    });
    // The same as a read for agents and read-only keys (MCP ghl_focus_view): GET /api/focus/ask?text=…&history=…&lang=en&rules=1
    router.get('/api/focus/ask', 'location', async (ctx) => answer(ctx, read(ctx, Object.fromEntries(ctx.query.entries()), true)));
  },
};
