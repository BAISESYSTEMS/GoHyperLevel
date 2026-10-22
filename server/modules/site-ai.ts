import type { Module } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { HttpError, bad, clampLimit, html, notFound, type Ctx } from '../core/http.js';
import { id, now, slugify } from '../core/util.js';
import type { SystemBlock } from '../services/anthropic.js';
import { auditLog, json, limiter } from '../services/creator-kit.js';
import { callRoute } from '../services/route-call.js';
import { AI_BLOCKS, h1Count, mergeSection, type AccountRefs } from '../services/site-ai-schema.js';
import {
  GOALS,
  LANGS,
  PAGE_TYPES,
  RULES_BLOCKS,
  RULES_PLAN,
  RULES_SECTION,
  SECTION_COMMANDS,
  STYLE_CHOICES,
  TONES,
  applySectionAnswer,
  briefProblem,
  briefText,
  catalogFor,
  checkPageSections,
  checkPages,
  checkPlan,
  checkSectionAnswer,
  cleanBrief,
  diffPage,
  estimateTokens,
  expectedPages,
  planText,
  refsText,
  sectionContext,
  styleOf,
  stylesText,
  type Brief,
  type DraftPage,
  type Plan,
} from '../services/site-ai.js';
import { askChecked, budget, estimate, modelInfo } from '../services/site-ai-kit.js';
import { siteBlocks, type Block } from '../services/site-blocks.js';
import { cleanBlocks } from '../services/site-layout.js';
import { pageUrl, renderPage } from '../services/site-render.js';
import { formSpec, settingsOf, wireBlocks, type Wiring } from '../services/site-templates.js';
import { PURPOSES } from './ai-assistant.js';
import type { Tool } from './mcp.js';
import { siteAiDraftsModule } from './site-ai-drafts.js';

/**
 * Funnel & Website AI (HighLevel's "Funnel & Website AI"): a brief – business, offer, audience, tone, language, page type
 * (landing page, funnel with steps, multi-page site) – becomes a page plan, then block JSON for every page. Both answers are
 * checked against the site block registry and the account (services/site-ai*.ts) with up to three attempts, shown with a
 * preview and a diff, and applied as a DRAFT only: a new site is created unpublished (modules/site-ai-drafts.ts keeps it off
 * the public web until "Veröffentlichen"), a page or section change lands in the editor as unsaved changes after a restore
 * point was taken. It reuses the gallery's design tokens, the form/calendar/product wiring and the legal page generator.
 * BYOK use "Funnel & Website AI" (`sites`), cost estimate before every request, the KI-Assistent's monthly limit applies.
 * MCP `ghl_site_generate`; the HyperLevel Agent gets it like every MCP tool plus a hint. Docs: docs/site-ai.md.
 */

const PURPOSE = 'site_builder';
const HOUR = 3600_000;
const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const obj = (props: Record<string, any>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });

export const EXAMPLES = [
  'Landingpage für meinen Malerbetrieb in Köln: kostenloses Angebot für Innenanstrich anfordern.',
  'Funnel für einen Online-Kurs „Social Media für Handwerker“: Opt-in für ein Gratis-Video, dann Verkaufsseite und Danke-Seite.',
  'Website für eine Physiotherapie-Praxis mit Leistungen, Team, Kontakt und Online-Terminbuchung.',
  'Landingpage für ein kostenloses Webinar über Steuern sparen für Selbstständige.',
];

interface RunRow {
  id: string;
  location_id: string;
  user_id: string | null;
  user_name: string;
  mode: 'site' | 'page' | 'section';
  funnel_id: string | null;
  page_id: string | null;
  section_id: string | null;
  prompt: string;
  brief: string;
  status: 'ok' | 'applied';
  attempts: number;
  model: string;
  tokens: number;
  cost_micros: number;
  estimate_micros: number;
  result: string;
  applied_funnel_id: string | null;
  applied_at: string | null;
  created_at: string;
}

const TOOLS: Tool[] = [
  {
    name: 'ghl_site_generate',
    title: 'Funnel oder Website mit KI entwerfen',
    description:
      'Baut aus einer Beschreibung eine Landingpage, einen Funnel (mehrere Schritte) oder eine Website (mehrere Seiten): erst einen Seitenplan, dann die Blöcke jeder Seite – geprüft gegen die Blöcke des Website-Baukastens und die Formulare/Kalender/Produkte des Sub-Accounts (bis zu drei Versuche). Ergebnis: Plan, Seiten mit Abschnitten, Hinweise und Kosten. Mit apply=true wird daraus ein ENTWURF angelegt (nicht öffentlich, bis jemand im Editor „Veröffentlichen“ klickt) – inklusive Design, Formular, Impressum und Datenschutz aus den Firmendaten. Kostet KI-Tokens (Monatslimit des KI-Assistenten; Anbieter unter KI-Anbieter, Verwendung „Funnel & Website AI“).',
    inputSchema: obj(
      {
        ...LOC,
        prompt: { type: 'string', description: 'Was gebaut werden soll, z. B. „Landingpage für meinen Malerbetrieb in Köln, Ziel: Angebotsanfragen“' },
        page_type: { type: 'string', enum: [...PAGE_TYPES], description: 'landing (eine Seite), funnel (Schritte), website (mehrere Seiten); Standard landing' },
        goal: { type: 'string', enum: [...GOALS], description: 'leads (Formular), booking (Termin), sale (Produkt), info' },
        business: { type: 'string', description: 'Unternehmen, Branche, Ort' },
        offer: { type: 'string', description: 'Angebot' },
        audience: { type: 'string', description: 'Zielgruppe' },
        tone: { type: 'string', enum: [...TONES] },
        address: { type: 'string', enum: ['du', 'sie'] },
        language: { type: 'string', enum: [...LANGS] },
        pages: { type: 'string', description: 'Gewünschte Seiten/Schritte, durch Komma getrennt (optional)' },
        apply: { type: 'boolean', description: 'true: als Entwurf anlegen (Standard: nur Vorschau)' },
      },
      ['location_id', 'prompt'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    klassFor: () => 'write',
    run: async (call, a) => {
      const brief = { business: a.business, offer: a.offer, audience: a.audience, tone: a.tone, address: a.address, language: a.language, page_type: a.page_type, goal: a.goal, pages: a.pages, extra: a.prompt };
      const r = await call.api('POST', '/api/site-ai/generate', { body: { brief }, location: a.location_id });
      const applied = a.apply ? await call.api('POST', `/api/site-ai/runs/${encodeURIComponent(r.run_id)}/apply`, { body: {}, location: a.location_id }) : null;
      return {
        run_id: r.run_id,
        site_name: r.plan.site_name,
        style: r.plan.style,
        pages: r.pages.map((p: any) => ({ slug: p.slug, name: p.name, title: p.seo?.title, sections: p.sections })),
        notes: r.notes,
        warnings: r.warnings,
        attempts: r.attempts,
        cost_usd: r.cost_usd,
        applied,
        hint: applied ? 'Als Entwurf angelegt – nicht öffentlich. Im Editor prüfen und „Veröffentlichen“ klicken.' : 'Nur eine Vorschau. Mit apply=true (oder in der Oberfläche) als Entwurf anlegen.',
      };
    },
  },
];

export const siteAiModule: Module = {
  name: 'site-ai',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE site_ai_runs (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, user_id TEXT, user_name TEXT NOT NULL DEFAULT '',
        mode TEXT NOT NULL, funnel_id TEXT REFERENCES funnels(id) ON DELETE SET NULL, page_id TEXT REFERENCES funnel_pages(id) ON DELETE SET NULL, section_id TEXT,
        prompt TEXT NOT NULL DEFAULT '', brief TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'ok', attempts INTEGER NOT NULL DEFAULT 1,
        model TEXT NOT NULL DEFAULT '', tokens INTEGER NOT NULL DEFAULT 0, cost_micros INTEGER NOT NULL DEFAULT 0, estimate_micros INTEGER NOT NULL DEFAULT 0,
        result TEXT NOT NULL DEFAULT '{}', applied_funnel_id TEXT, applied_at TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX site_ai_runs_loc ON site_ai_runs(location_id, created_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    Object.assign(PURPOSES, { site_builder: 'Funnel & Website AI', site_writer: 'KI-Texter (Blog, E-Mail)' });
    const tooMany = limiter(30, HOUR);
    const writable = (ctx: Ctx) => {
      if (ctx.scope === 'read') throw new HttpError(403, 'Dieser Schlüssel darf nur lesen');
    };
    const registry = () => new Set(siteBlocks(app).keys());

    // --- context ---------------------------------------------------------------------------------------------------------
    const refsOf = (loc: string): AccountRefs => {
      const safe = <T>(fn: () => T, d: T) => {
        try {
          return fn();
        } catch {
          return d;
        }
      };
      return {
        form: safe(() => db.all<{ id: string; name: string }>('SELECT id, name FROM forms WHERE location_id = ? ORDER BY updated_at DESC LIMIT 30', loc), []),
        calendar: safe(() => db.all<{ slug: string; name: string }>('SELECT slug, name FROM calendars WHERE location_id = ? ORDER BY created_at LIMIT 30', loc), []),
        product: safe(() => db.all<{ id: string; name: string; price_cents: number; currency: string }>('SELECT id, name, price_cents, currency FROM products WHERE location_id = ? ORDER BY name LIMIT 30', loc).map((p) => ({ id: p.id, name: p.name, price: `${(Number(p.price_cents) / 100).toFixed(2).replace('.', ',')} ${p.currency || 'EUR'}` })), []),
      };
    };
    const system = (rules: string, refs: AccountRefs): SystemBlock[] => [{ text: `${rules}${catalogFor(registry())}`, cache: true }, { text: `KONTO (nur diese IDs gibt es)\n${refsText(refs)}` }];
    const funnelOf = (ctx: Ctx, fid: string) => {
      const f = parseJson(db.get('SELECT * FROM funnels WHERE id = ? AND location_id = ?', fid, ctx.locationId), ['settings']);
      if (!f) throw notFound('Website/Funnel nicht gefunden');
      return f;
    };
    const pagesOf = (fid: string) => parseRows(db.all('SELECT * FROM funnel_pages WHERE funnel_id = ? ORDER BY position, created_at', fid), ['blocks', 'seo', 'layout']);
    const pageOf = (ctx: Ctx, pid: string) => {
      const p = parseJson(db.get('SELECT * FROM funnel_pages WHERE id = ? AND location_id = ?', pid, ctx.locationId), ['blocks', 'seo', 'layout']);
      if (!p) throw notFound('Seite nicht gefunden');
      return p;
    };
    /** Links between pages: the editor stores `page:<id>`, the AI reads and writes `page:<path>`. */
    const relink = <T>(v: T, map: Map<string, string>): T => {
      const walk = (x: any): any => (typeof x === 'string' ? x.replace(/^page:(.+)$/, (m, k: string) => (map.has(k) ? `page:${map.get(k)}` : m)) : Array.isArray(x) ? x.map(walk) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)])) : x);
      return walk(v);
    };
    const briefFor = (ctx: Ctx, b: any, page?: any): Brief => {
      const brief = cleanBrief(b ?? {});
      if (!b?.language && page?.layout?.lang === 'en') brief.language = 'en';
      if (!brief.business) brief.business = app.location(ctx.locationId)?.name ?? '';
      return brief;
    };
    const currentBlocks = (raw: unknown, fallback: Block[]): Block[] => (Array.isArray(raw) ? cleanBlocks(raw) : fallback);
    /** Form, calendar and product blocks the AI left without an id get the empty placeholder the template wiring fills. */
    const REF_KEY: Record<string, string> = { form: 'form_id', calendar: 'calendar_slug', product: 'product_id' };
    const withRefSlots = (blocks: Block[]): Block[] => {
      const walk = (v: any): any => (Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? { ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])), ...(REF_KEY[v.type] && !v[REF_KEY[v.type]] ? { [REF_KEY[v.type]]: '' } : {}) } : v);
      return walk(blocks);
    };

    function saveRun(ctx: Ctx, r: Omit<RunRow, 'id' | 'location_id' | 'user_id' | 'user_name' | 'status' | 'applied_funnel_id' | 'applied_at' | 'created_at'>) {
      const rid = id();
      db.insert('site_ai_runs', { id: rid, location_id: ctx.locationId, user_id: ctx.user?.id ?? null, user_name: ctx.user?.name ?? '', status: 'ok', applied_funnel_id: null, applied_at: null, created_at: now(), ...r });
      return rid;
    }
    const gate = (ctx: Ctx, est: ReturnType<typeof estimate>) => {
      if (tooMany(ctx.locationId)) throw new HttpError(429, 'Zu viele KI-Entwürfe in kurzer Zeit – bitte in einigen Minuten erneut versuchen.');
      const ready: string | null = app.services.aiReady?.(ctx.locationId) ?? (app.services.aiRun ? null : 'Der KI-Assistent ist nicht verfügbar.');
      if (ready) throw new HttpError(409, ready);
      if (est.problem) throw new HttpError(409, est.problem);
    };
    const usd = (micros: number) => Math.round(micros) / 1e6;

    // --- estimates -------------------------------------------------------------------------------------------------------
    const siteEstimate = (ctx: Ctx, brief: Brief) =>
      estimate(app, ctx.locationId, PURPOSE, ctx.user?.id, estimateTokens({ mode: 'site', pages: expectedPages(brief), systemChars: RULES_BLOCKS.length + catalogFor(registry()).length + RULES_PLAN.length + stylesText().length, userChars: briefText(brief).length }));
    const pageEstimate = (ctx: Ctx, mode: 'page' | 'section', chars: number) => estimate(app, ctx.locationId, PURPOSE, ctx.user?.id, estimateTokens({ mode, systemChars: (mode === 'page' ? RULES_BLOCKS : RULES_SECTION).length + catalogFor(registry()).length, userChars: chars }));

    router.get('/api/site-ai/status', 'location', (ctx) => {
      const reason: string | null = app.services.aiReady?.(ctx.locationId) ?? (app.services.aiRun ? null : 'Der KI-Assistent ist nicht verfügbar.');
      const m = modelInfo(app, ctx.locationId, PURPOSE, ctx.user?.id);
      return {
        ready: !reason,
        reason,
        provider: { label: m.label, model: m.model, byok: m.byok },
        budget: budget(app, ctx.locationId),
        examples: EXAMPLES,
        options: { page_types: PAGE_TYPES, goals: GOALS, tones: TONES, languages: LANGS, styles: STYLE_CHOICES },
        commands: SECTION_COMMANDS.map((c) => ({ id: c.id, label: c.label })),
        blocks: Object.keys(AI_BLOCKS).filter((t) => registry().has(t)),
        limits: { per_hour: 30, attempts: 3 },
      };
    });

    router.post('/api/site-ai/estimate', 'location', (ctx) => {
      const b = ctx.body ?? {};
      if (b.mode === 'page' || b.mode === 'section') return pageEstimate(ctx, b.mode, String(b.prompt ?? '').length + 4000);
      return siteEstimate(ctx, cleanBrief(b.brief ?? {}));
    });

    // --- stage 1 + 2: a whole site ---------------------------------------------------------------------------------------
    async function planFor(ctx: Ctx, brief: Brief) {
      return askChecked<Plan>(app, ctx, {
        purpose: PURPOSE,
        what: 'Seitenplan',
        system: [{ text: `${RULES_PLAN}\n\nDESIGNS (style)\n${stylesText()}`, cache: true }],
        user: `BRIEFING\n${briefText(brief)}`,
        maxTokens: 2500,
        timeoutMs: 90_000,
        check: (raw) => {
          const r = checkPlan(raw, brief);
          return { value: r.plan, errors: r.errors, warnings: r.warnings };
        },
      });
    }

    router.post('/api/site-ai/plan', 'location', async (ctx) => {
      writable(ctx);
      const brief = briefFor(ctx, ctx.body?.brief);
      const problem = briefProblem(brief);
      if (problem) throw bad(problem);
      gate(ctx, siteEstimate(ctx, brief));
      const r = await planFor(ctx, brief);
      return { plan: r.value, warnings: r.warnings, attempts: r.attempts, model: r.model, cost_usd: usd(r.cost_micros) };
    });

    router.post('/api/site-ai/generate', 'location', async (ctx) => {
      writable(ctx);
      const brief = briefFor(ctx, ctx.body?.brief);
      const problem = briefProblem(brief);
      if (problem) throw bad(problem);
      const est = siteEstimate(ctx, brief);
      gate(ctx, est);
      // a plan the person reviewed (and maybe edited) skips stage 1
      let plan: Plan | undefined;
      let warnings: string[] = [];
      let attempts = 0;
      let cost = 0;
      let tokens = 0;
      if (ctx.body?.plan) {
        const checked = checkPlan(ctx.body.plan, brief);
        if (!checked.plan) throw bad(`Der Seitenplan ist nicht gültig: ${checked.errors.slice(0, 3).join(' · ')}`);
        plan = checked.plan;
      } else {
        const p = await planFor(ctx, brief);
        plan = p.value;
        warnings = p.warnings;
        attempts += p.attempts;
        cost += p.cost_micros;
        tokens += p.tokens;
      }
      const refs = refsOf(ctx.locationId);
      const r = await askChecked<{ pages: DraftPage[]; notes: string[] }>(app, ctx, {
        purpose: PURPOSE,
        what: 'Seiteninhalt',
        system: system(RULES_BLOCKS, refs),
        user: `BRIEFING\n${briefText(brief)}\n\nSEITENPLAN\n${planText(plan)}`,
        maxTokens: Math.min(16_000, 1500 + plan.pages.length * 2600),
        timeoutMs: 240_000,
        check: (raw) => {
          const c = checkPages(raw, plan!, { registry: registry(), refs });
          return { value: c.pages ? { pages: c.pages, notes: c.notes } : undefined, errors: c.errors, warnings: c.warnings };
        },
      });
      attempts += r.attempts;
      cost += r.cost_micros;
      tokens += r.tokens;
      warnings = [...warnings, ...r.warnings];
      const notes = [...r.value.notes, ...siteNotes(r.value.pages, refs, brief)];
      const result = { plan, pages: r.value.pages, notes, warnings };
      const rid = saveRun(ctx, { mode: 'site', funnel_id: null, page_id: null, section_id: null, prompt: brief.extra || `${brief.business} – ${brief.offer}`.slice(0, 2000), brief: JSON.stringify(brief), attempts, model: r.model, tokens, cost_micros: cost, estimate_micros: Math.round(est.usd * 1e6), result: JSON.stringify(result) });
      return { run_id: rid, mode: 'site', plan, pages: r.value.pages.map((p) => ({ ...p, sections: p.blocks.map((b) => String(b.name || b.type)) })), notes, warnings, attempts, model: r.model, cost_usd: usd(cost), estimate_usd: est.usd };
    });

    /** What the person still has to set up for the site to work (form, calendar, product, Stripe, company data). */
    function siteNotes(pages: DraftPage[], refs: AccountRefs, brief: Brief): string[] {
      const used = new Set<string>();
      for (const p of pages) JSON.stringify(p.blocks).replace(/"type":"(form|calendar|product)"/g, (_m, t) => (used.add(t), ''));
      const out: string[] = [];
      if (used.has('form') && !refs.form.length) out.push('Ein Formular (Name, E-Mail, Einwilligung) wird beim Anlegen erstellt – Felder unter „Formulare“ anpassen.');
      if (used.has('calendar') && !refs.calendar.length) out.push('Es gibt noch keinen Kalender: unter „Kalender“ anlegen und im Block „Kalender“ wählen.');
      if (used.has('product')) out.push(refs.product.length ? 'Prüfe im Block „Produkt“, ob das richtige Produkt gewählt ist (Stripe muss verbunden sein).' : 'Lege unter „Rechnungen → Produkte“ das Produkt an und wähle es im Block „Produkt“.');
      if (brief.language === 'en') out.push('Rechtstexte erzeugt HyperLevel auf Deutsch – für eine englische Seite bitte prüfen.');
      out.push('Texte in [eckigen Klammern] sind Platzhalter: durch echte Angaben ersetzen, keine erfundenen Kundenstimmen veröffentlichen.');
      return out;
    }

    // --- a page of an existing site (rewrite or fill), and section commands ---------------------------------------------
    router.post('/api/site-ai/page', 'location', async (ctx) => {
      writable(ctx);
      const page = pageOf(ctx, String(ctx.body?.page_id ?? ''));
      const f = funnelOf(ctx, page.funnel_id);
      const siblings = pagesOf(f.id);
      const toId = new Map(siblings.map((p) => [String(p.slug), String(p.id)]));
      const brief = briefFor(ctx, ctx.body?.brief, page);
      const prompt = String(ctx.body?.prompt ?? '').trim().slice(0, 2000);
      if (prompt.length < 6 && briefProblem(brief)) throw bad('Bitte beschreibe kurz, was auf der Seite stehen soll.');
      const before = currentBlocks(ctx.body?.current_blocks, page.blocks);
      const outline = before.length ? sectionOutline(before) : '';
      const user = `BRIEFING\n${briefText(brief)}\n\nSEITE: ${page.slug} „${page.name}“ der ${f.kind === 'website' ? 'Website' : 'Funnel'} „${f.name}“. Andere Seiten (für page:-Links): ${siblings.map((p) => p.slug).join(', ')}\n${outline ? `BISHERIGE GLIEDERUNG\n${outline}\n` : ''}\nAUFTRAG: ${prompt || 'Schreibe diese Seite passend zum Briefing.'}\n\nAntworte mit {"sections": [...], "summary": "ein Satz"}.`;
      const est = pageEstimate(ctx, 'page', user.length);
      gate(ctx, est);
      const refs = refsOf(ctx.locationId);
      const env = { registry: registry(), refs, pages: new Set(siblings.map((p) => String(p.slug))) };
      const r = await askChecked<{ blocks: Block[]; summary: string }>(app, ctx, {
        purpose: PURPOSE,
        what: 'Seiteninhalt',
        system: system(RULES_BLOCKS, refs),
        user,
        maxTokens: 6000,
        timeoutMs: 150_000,
        check: (raw) => {
          const c = checkPageSections(raw.sections ?? raw.pages?.[0]?.sections, env, `Seite „${page.slug}“`);
          return { value: c.errors.length ? undefined : { blocks: c.blocks, summary: String(raw.summary ?? '').slice(0, 300) }, errors: c.errors, warnings: c.warnings };
        },
      });
      const blocks = relink(r.value.blocks, toId);
      const diff = diffPage(before, blocks);
      const result = { blocks, summary: r.value.summary, warnings: r.warnings, diff };
      const rid = saveRun(ctx, { mode: 'page', funnel_id: f.id, page_id: page.id, section_id: null, prompt: prompt || briefText(brief).slice(0, 2000), brief: JSON.stringify(brief), attempts: r.attempts, model: r.model, tokens: r.tokens, cost_micros: r.cost_micros, estimate_micros: Math.round(est.usd * 1e6), result: JSON.stringify(result) });
      return { run_id: rid, mode: 'page', ...result, attempts: r.attempts, model: r.model, cost_usd: usd(r.cost_micros), estimate_usd: est.usd };
    });

    const sectionOutline = (blocks: Block[]) => blocks.map((b, i) => `${i + 1}. ${String(b.name || b.type)}`).join('\n');

    router.post('/api/site-ai/section', 'location', async (ctx) => {
      writable(ctx);
      const page = pageOf(ctx, String(ctx.body?.page_id ?? ''));
      const f = funnelOf(ctx, page.funnel_id);
      const siblings = pagesOf(f.id);
      const toSlug = new Map(siblings.map((p) => [String(p.id), String(p.slug)]));
      const toId = new Map(siblings.map((p) => [String(p.slug), String(p.id)]));
      const sectionId = String(ctx.body?.section_id ?? '');
      const preset = SECTION_COMMANDS.find((c) => c.id === ctx.body?.command);
      const command = (preset?.prompt ?? String(ctx.body?.prompt ?? '')).trim().slice(0, 600);
      if (command.length < 4) throw bad('Was soll mit dem Abschnitt passieren? (z. B. „kürzer“, „FAQ hinzufügen“, „in Du-Form“)');
      const before = currentBlocks(ctx.body?.current_blocks, page.blocks);
      const sc = sectionContext(before, sectionId);
      if (!sc) throw bad('Bitte einen Abschnitt der Seite wählen (Seiten ohne Abschnitte: erst „In Abschnitte umwandeln“).');
      const brief = briefFor(ctx, ctx.body?.brief, page);
      const user = `BRIEFING\n${briefText(brief)}\n\nSEITE (Gliederung, >> = gewählter Abschnitt)\n${sc.outline}\nAndere Seiten (für page:-Links): ${siblings.map((p) => p.slug).join(', ')}\n\nGEWÄHLTER ABSCHNITT\n${JSON.stringify(relink(sc.section, toSlug))}\n\nAUFTRAG: ${command}`;
      const est = pageEstimate(ctx, 'section', user.length);
      gate(ctx, est);
      const refs = refsOf(ctx.locationId);
      const env = { registry: registry(), refs, pages: new Set(siblings.map((p) => String(p.slug))) };
      const r = await askChecked(app, ctx, {
        purpose: PURPOSE,
        what: 'Abschnitt',
        system: system(RULES_SECTION, refs),
        user,
        maxTokens: 4000,
        timeoutMs: 120_000,
        check: (raw) => {
          const c = checkSectionAnswer(raw, before, sectionId, env);
          if (c.sections && !c.errors.length) {
            // the H1 rule over the whole page after the change
            const next = applySectionAnswer(before, sectionId, c.sections, mergeSection);
            if (h1Count(next) > 1) return { errors: ['Die Seite hätte danach mehr als eine H1 – neue Überschriften mit level 2 oder 3, kein zweiter Hero'], warnings: c.warnings };
          }
          return { value: c.sections ? { sections: c.sections, summary: c.summary } : undefined, errors: c.errors, warnings: c.warnings };
        },
      });
      const sections = relink(r.value.sections, toId);
      const blocks = applySectionAnswer(before, sectionId, sections, mergeSection);
      const diff = diffPage(before, blocks);
      const result = { sections, blocks, summary: r.value.summary, warnings: r.warnings, diff, command: preset?.id ?? '' };
      const rid = saveRun(ctx, { mode: 'section', funnel_id: f.id, page_id: page.id, section_id: sectionId, prompt: command, brief: JSON.stringify(brief), attempts: r.attempts, model: r.model, tokens: r.tokens, cost_micros: r.cost_micros, estimate_micros: Math.round(est.usd * 1e6), result: JSON.stringify(result) });
      return { run_id: rid, mode: 'section', blocks, summary: result.summary, warnings: r.warnings, diff, attempts: r.attempts, model: r.model, cost_usd: usd(r.cost_micros), estimate_usd: est.usd };
    });

    // --- runs, preview -----------------------------------------------------------------------------------------------------
    const runOf = (ctx: Ctx, rid: string) => {
      const r = db.get<RunRow>('SELECT * FROM site_ai_runs WHERE id = ? AND location_id = ?', rid, ctx.locationId);
      if (!r) throw notFound('KI-Entwurf nicht gefunden');
      return r;
    };
    router.get('/api/site-ai/runs', 'location', (ctx) => {
      const pid = ctx.query.get('page_id');
      const rows = db.all<RunRow>(`SELECT * FROM site_ai_runs WHERE location_id = ? ${pid ? 'AND page_id = ?' : ''} ORDER BY created_at DESC LIMIT ?`, ctx.locationId, ...(pid ? [pid] : []), clampLimit(ctx.query.get('limit'), 20, 100));
      return rows.map((r) => {
        const res = json<any>(r.result, {});
        return { id: r.id, mode: r.mode, funnel_id: r.funnel_id, page_id: r.page_id, prompt: r.prompt, status: r.status, attempts: r.attempts, model: r.model, cost_usd: usd(r.cost_micros), name: res.plan?.site_name ?? '', summary: res.summary ?? res.plan?.summary ?? '', applied_funnel_id: r.applied_funnel_id, applied_at: r.applied_at, user_name: r.user_name, created_at: r.created_at };
      });
    });
    router.get('/api/site-ai/runs/:id', 'location', (ctx) => {
      const r = runOf(ctx, ctx.params.id);
      return { id: r.id, mode: r.mode, status: r.status, prompt: r.prompt, brief: json(r.brief, {}), attempts: r.attempts, model: r.model, cost_usd: usd(r.cost_micros), estimate_usd: usd(r.estimate_micros), applied_funnel_id: r.applied_funnel_id, ...json<any>(r.result, {}) };
    });

    /** The proposal as a visitor would see it (nothing is created): a page of a new site in its design, or the changed page. */
    router.get('/api/site-ai/runs/:id/preview', 'location', (ctx) => {
      const r = runOf(ctx, ctx.params.id);
      const res = json<any>(r.result, {});
      let out: string;
      if (r.mode === 'site') {
        const pages: DraftPage[] = res.pages ?? [];
        const page = pages.find((p) => p.slug === ctx.query.get('page')) ?? pages[0];
        if (!page) throw notFound('Seite nicht gefunden');
        const t = styleOf(res.plan?.style) ?? styleOf('agentur')!;
        const w: Wiring = { firma: res.plan?.site_name ?? '', form_id: '', calendar_slug: '', product_id: '', collections: new Map(), pages: new Map(pages.map((p) => [p.slug, p.slug])), now: new Date() };
        const kind = json<any>(r.brief, {}).page_type === 'website' ? 'website' : 'funnel';
        const funnel = { id: '', location_id: ctx.locationId, slug: 'vorschau', domain: null, kind, name: w.firma, settings: siteSettings(t, w, pages, kind) };
        const list = pages.map((p, i) => ({ id: p.slug, name: p.name, slug: p.slug, position: i, seo: p.seo, layout: {} }));
        out = renderPage(app, funnel, { id: page.slug, name: page.name, slug: page.slug, seo: page.seo, layout: {}, blocks: cleanBlocks(wireBlocks(withRefSlots(page.blocks), w)) }, page.slug === pages[0].slug, { preview: true, pages: list });
      } else {
        const page = r.page_id ? parseJson(db.get('SELECT * FROM funnel_pages WHERE id = ? AND location_id = ?', r.page_id, ctx.locationId), ['blocks', 'seo', 'layout']) : null;
        if (!page) throw notFound('Seite nicht gefunden');
        const f = funnelOf(ctx, page.funnel_id);
        // a section command shows the sections it changes or adds – the rest of the page is as before
        const changed = new Set<string>((res.diff?.sections ?? []).filter((d: any) => d.change === 'new' || d.change === 'changed').map((d: any) => String(d.id)));
        const shown = r.mode === 'section' && changed.size ? (res.blocks ?? []).filter((b: any) => changed.has(String(b.id))) : (res.blocks ?? []);
        out = renderPage(app, f, { ...page, blocks: cleanBlocks(shown) }, false, { preview: true, bare: r.mode === 'section' && changed.size > 0 });
      }
      const h = html(out.replace(/href="http:\/\/[^"]*\/p\/vorschau[^"]*"/g, 'href="#"'));
      h.headers['content-security-policy'] = "sandbox allow-scripts; default-src 'none'; img-src https: data: http:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src 'none'";
      h.headers['cache-control'] = 'no-store';
      return h;
    });

    // --- apply: a new site as a draft, or a page change into the editor (after a restore point) -----------------------------
    /** Design, header (with the pages as menu on websites) and footer of a new site – the gallery template's tokens. */
    function siteSettings(t: NonNullable<ReturnType<typeof styleOf>>, w: Pick<Wiring, 'firma' | 'pages'>, pages: DraftPage[], kind: string) {
      const tpl = kind === 'website' ? { ...t, menu: pages.map((p) => [p.name, p.slug] as [string, string]), header: { ...(t.header ?? {}), cta_text: t.header?.cta_text ?? '', cta_url: t.header?.cta_url && w.pages.has(t.header.cta_url) ? t.header.cta_url : '#' }, footer: { text: '© {{firma}}' } } : { ...t, menu: undefined, header: undefined, footer: { text: '© {{firma}}' } };
      return settingsOf(tpl as any, w);
    }

    router.post('/api/site-ai/runs/:id/apply', 'location', async (ctx) => {
      writable(ctx);
      const r = runOf(ctx, ctx.params.id);
      if (r.mode === 'site' && r.status === 'applied') throw new HttpError(409, 'Dieser KI-Entwurf wurde schon angelegt.');
      return r.mode === 'site' ? createSite(ctx, r) : applyToPage(ctx, r);
    });

    async function createSite(ctx: Ctx, r: RunRow) {
      const res = json<any>(r.result, {});
      const brief = cleanBrief(json(r.brief, {}));
      const plan: Plan = res.plan;
      const pages: DraftPage[] = res.pages ?? [];
      if (!plan || !pages.length) throw new HttpError(409, 'Kein Entwurf gespeichert.');
      const loc = ctx.locationId;
      const t = styleOf(plan.style) ?? styleOf('agentur')!;
      const kind = brief.page_type === 'website' ? 'website' : 'funnel';
      const notes: string[] = [];
      const wiring: Wiring = { firma: plan.site_name, form_id: '', calendar_slug: '', product_id: '', collections: new Map(), pages: new Map(), now: new Date() };
      const json1 = JSON.stringify(pages);
      const needs = { form: /"type":"form"/.test(json1), calendar: /"type":"calendar"/.test(json1), product: /"type":"product"/.test(json1) };
      if (needs.calendar) wiring.calendar_slug = db.get<{ slug: string }>('SELECT slug FROM calendars WHERE location_id = ? ORDER BY created_at LIMIT 1', loc)?.slug ?? '';
      const legalKinds = ['impressum', 'datenschutz', ...(brief.goal === 'sale' || needs.product ? ['widerruf'] : [])];
      const LEGAL_PLACEHOLDER: Record<string, { name: string; blocks: Block[] }> = {
        impressum: { name: 'Impressum', blocks: [{ id: id(8), type: 'heading', text: 'Impressum', level: 1 }, { id: id(8), type: 'text', text: 'Angaben gemäß § 5 DDG\n\nName\nStraße\nPLZ Ort' }] },
        datenschutz: { name: 'Datenschutz', blocks: [{ id: id(8), type: 'heading', text: 'Datenschutzerklärung', level: 1 }, { id: id(8), type: 'text', text: 'Hier deine Datenschutzerklärung einfügen.' }] },
        widerruf: { name: 'Widerruf', blocks: [{ id: id(8), type: 'heading', text: 'Widerrufsbelehrung', level: 1 }, { id: id(8), type: 'text', text: 'Hier deine Widerrufsbelehrung einfügen.' }] },
      };
      const fid = id();
      const root = slugify(plan.site_name) || 'website';
      let slug = root;
      for (let i = 2; db.get('SELECT id FROM funnels WHERE slug = ?', slug); i++) slug = `${root}-${i}`;
      const pageIds = pages.map((p) => ({ ...p, pid: id() }));
      for (const p of pageIds) wiring.pages.set(p.slug, p.pid);
      db.insert('funnels', { id: fid, location_id: loc, name: plan.site_name, slug, kind, settings: {}, created_at: now(), updated_at: now() });
      // the draft mark first: the site never shows publicly before someone publishes it
      app.services.siteAiDrafts?.mark(loc, fid, r.id);
      let createdForm = false;
      try {
        if (needs.form) {
          try {
            const spec = formSpec(brief.goal === 'leads' && kind !== 'website' ? 'optin' : 'contact', plan.site_name);
            const form = await callRoute(app, ctx, 'POST', '/api/forms', { name: spec.name, fields: spec.fields, settings: { ...spec.settings, tags: ['ki-website'] } });
            wiring.form_id = form.id;
            createdForm = true;
          } catch (e) {
            notes.push(`Das Formular konnte nicht angelegt werden (${(e as Error).message}): wähle in den Formular-Blöcken ein Formular aus.`);
          }
        }
        db.update('funnels', fid, { settings: siteSettings(t, wiring, pages, kind) });
        db.tx(() => {
          pageIds.forEach((p, i) => db.insert('funnel_pages', { id: p.pid, location_id: loc, funnel_id: fid, name: p.name, slug: p.slug, position: i, blocks: cleanBlocks(wireBlocks(withRefSlots(p.blocks), wiring)), seo: { title: p.seo?.title || p.name, ...(p.seo?.description ? { description: p.seo.description } : {}) }, layout: {}, created_at: now(), updated_at: now() }));
          legalKinds.forEach((k, i) => {
            if (wiring.pages.has(k)) return;
            db.insert('funnel_pages', { id: id(), location_id: loc, funnel_id: fid, name: LEGAL_PLACEHOLDER[k].name, slug: k, position: pageIds.length + i, blocks: LEGAL_PLACEHOLDER[k].blocks, seo: { title: LEGAL_PLACEHOLDER[k].name, noindex: false }, layout: {}, created_at: now(), updated_at: now() });
          });
        });
        // after the form: to the thank-you page (only a form created here – a form the owner brought keeps its settings)
        const thanks = pageIds.find((p) => /^(danke|thanks|thank-you|bestaetigung)$/.test(p.slug));
        if (createdForm && thanks) {
          const f = db.get('SELECT * FROM funnels WHERE id = ?', fid)!;
          await callRoute(app, ctx, 'PATCH', `/api/forms/${wiring.form_id}`, { settings: { redirect_url: pageUrl(app, { ...f, settings: {} }, thanks) } });
        }
        let legal = { applied: false, kinds: [] as string[] };
        try {
          const lr = await callRoute(app, ctx, 'POST', `/api/legal/funnels/${fid}/apply`, { kinds: legalKinds, overwrite: true });
          legal = { applied: Array.isArray(lr?.pages) && lr.pages.length > 0, kinds: (lr?.pages ?? []).map((x: any) => x.kind) };
        } catch (e) {
          notes.push((e as Error).message);
        }
        if (!legal.applied) notes.push('Impressum und Datenschutz enthalten noch Platzhalter: trage unter „Einwilligung & Recht“ die Firmendaten ein und erzeuge die Texte dort mit einem Klick.');
        if (needs.calendar && !wiring.calendar_slug) notes.push('Lege unter „Kalender“ einen Kalender an und wähle ihn im Block „Kalender“.');
        db.run(`UPDATE site_ai_runs SET status = 'applied', applied_funnel_id = ?, applied_at = ? WHERE id = ?`, fid, now(), r.id);
        auditLog(app, ctx, loc, 'site_ai.apply', `KI-Entwurf „${plan.site_name}“ als unveröffentlichte ${kind === 'website' ? 'Website' : 'Funnel'} angelegt`, fid);
        const out = db.get('SELECT * FROM funnels WHERE id = ?', fid)!;
        return {
          ok: true,
          funnel_id: fid,
          draft: true,
          url: pageUrl(app, { ...out, settings: JSON.parse(out.settings || '{}') }),
          pages: db.all('SELECT id, name, slug, position FROM funnel_pages WHERE funnel_id = ? ORDER BY position', fid),
          wiring: { form_id: wiring.form_id, form_created: createdForm, calendar_slug: wiring.calendar_slug },
          legal,
          notes: [...(res.notes ?? []), ...notes],
          message: 'Als Entwurf angelegt – nicht öffentlich, bis du im Editor „Veröffentlichen“ klickst.',
        };
      } catch (e) {
        db.run('DELETE FROM funnels WHERE id = ?', fid);
        throw e;
      }
    }

    /** A page or section run: a restore point of what the editor shows now, then the new blocks for the editor (unsaved). */
    function applyToPage(ctx: Ctx, r: RunRow) {
      const res = json<any>(r.result, {});
      const page = r.page_id ? pageOf(ctx, r.page_id) : null;
      if (!page) throw new HttpError(409, 'Die Seite gibt es nicht mehr.');
      const current = currentBlocks(ctx.body?.current_blocks, page.blocks);
      let blocks: Block[] = res.blocks ?? [];
      if (r.mode === 'section') {
        if (!current.some((b) => b.id === r.section_id)) throw new HttpError(409, 'Den Abschnitt gibt es auf der Seite nicht mehr – bitte den Befehl noch einmal ausführen.');
        blocks = applySectionAnswer(current, String(r.section_id), res.sections ?? [], mergeSection);
      }
      blocks = cleanBlocks(blocks);
      const point = app.services.siteAiDrafts?.restorePoint(ctx, { page, blocks: current, runId: r.id, label: r.mode === 'section' ? `Vor KI: ${r.prompt.slice(0, 60)}` : 'Vor KI-Seitenentwurf' });
      db.run(`UPDATE site_ai_runs SET status = 'applied', applied_at = ? WHERE id = ?`, now(), r.id);
      return { ok: true, mode: r.mode, page_id: page.id, blocks, restore_point_id: point?.id ?? null, diff: diffPage(current, blocks), message: 'Im Editor übernommen – noch nicht gespeichert. „Speichern“ macht die Änderung live, der Wiederherstellungspunkt holt den alten Stand zurück.' };
    }

    // --- the HyperLevel Agent ---------------------------------------------------------------------------------------------------
    app.services.agentPromptExtras = [
      ...(app.services.agentPromptExtras ?? []),
      (i: { automatic: boolean }) =>
        i.automatic
          ? ''
          : [
              '# Funnels & Websites mit KI',
              'Soll eine Landingpage, ein Funnel oder eine Website entstehen („bau mir eine Landingpage für …“): ghl_site_generate mit prompt (und page_type, goal, language, falls bekannt). Zeig der Person Plan, Seiten, Hinweise und Kosten; erst nach ihrem Okay mit apply=true – das legt einen unveröffentlichten Entwurf an, den sie im Editor prüft und selbst veröffentlicht. Erfinde keine Fakten, Preise oder Kundenstimmen.',
            ].join('\n'),
    ];
    app.onTick(() => {
      db.run(`DELETE FROM site_ai_runs WHERE created_at < ? AND status = 'ok'`, new Date(Date.now() - 30 * 864e5).toISOString());
      db.run(`DELETE FROM site_ai_runs WHERE created_at < ?`, new Date(Date.now() - 180 * 864e5).toISOString());
    });
  },
};

/** One registry line (modules/index.ts): generation, then drafts, restore points and the writer. */
export const siteAiModules: Module[] = [siteAiModule, siteAiDraftsModule];
