import type { Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, notFound, str } from '../core/http.js';
import { bodyLocation, callRoute } from '../services/mobile.js';
import { CTA_LABEL, GOALS, KINDS } from '../services/ads-manager.js';
import type { Caller } from './mcp.js';

/**
 * MCP tools of the ads manager (HyperLevel Agent, Claude, ChatGPT, Codex), the AI copy suggestions of the wizard and the
 * native app's endpoints. Tools are thin relays onto the REST routes, so rights, limits and the audit log apply.
 * Safety: creating is always paused; pausing is free; switching on and budget changes never run from here – they
 * leave an approval that a person decides on in the app (services/ads-ops.ts `spend`).
 */

const obj = (props: Record<string, any>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const q = (params: Record<string, unknown>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : '';
};
const cents = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Math.round(Number(v) * 100));

const TOOLS = [
  {
    name: 'ghl_ads_accounts',
    title: 'Werbekonten (Meta & Google)',
    description:
      'Verbundene Werbekonten eines Sub-Accounts (Meta Ads, Google Ads): Konto, Währung, Facebook-Seite, Pixel, ob verwaltet werden darf – dazu Tageslimit, eigene Zielgruppen (aus Smart Lists), Sofortformulare und offene Freigaben. Keine Zugangsdaten. Die Ausgabe zeigt, welche IDs ghl_ads_create_campaign braucht.',
    inputSchema: obj({ ...LOC }, ['location_id']),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call: Caller, a: any) => {
      const [conns, audiences, forms, approvals] = await Promise.all([
        call.api('GET', '/api/ads/connections', { location: a.location_id }),
        call.api('GET', '/api/ads/audiences', { location: a.location_id }),
        call.api('GET', '/api/ads/leadforms', { location: a.location_id }),
        call.api('GET', '/api/ads/approvals', { location: a.location_id }),
      ]);
      const pick = (c: any) => ({ connected: c.connected, can_manage: c.can_manage, account: c.account, page: c.page, pixel_id: c.pixel_id, lead_ads: c.lead_ads, via: c.via, token_expires_at: c.token_expires_at, last_error: c.last_error });
      return {
        meta: pick(conns.meta),
        google: pick(conns.google),
        max_daily_budget_cents: conns.settings.max_daily_budget_cents,
        audiences: (audiences as any[]).map((x) => ({ id: x.id, platform: x.platform, kind: x.kind, name: x.name, status: x.status, size_sent: x.sent })),
        lead_forms: (forms as any[]).map((x) => ({ id: x.id, name: x.name })),
        pending_approvals: (approvals as any[]).map((x) => ({ id: x.id, summary: x.summary, requested_via: x.requested_via })),
      };
    },
  },
  {
    name: 'ghl_ads_create_campaign',
    title: 'Anzeigenkampagne anlegen (pausiert)',
    description:
      'Legt eine Anzeigenkampagne für Meta (Facebook/Instagram) oder Google Ads als ENTWURF an und liefert die Prüfung (Einstellungen, Warnungen, Fehler). Alles wird PAUSIERT angelegt – es wird kein Geld ausgegeben. Mit publish_paused=true wird die geprüfte Kampagne zusätzlich pausiert bei der Plattform angelegt; aktiviert wird sie nur von einer Person (ghl_ads_update_status erzeugt nur eine Freigabe). Beträge in der Währung des Kontos (z. B. 20 = 20 €). Meta: goal leads mit kind lead_form braucht lead_form_id, website-Anzeigen ein Bild (media_upload_ids aus der Mediathek). Google: kind search (keywords, headlines ≥3 à ≤30 Zeichen, descriptions ≥2 à ≤90) oder pmax.',
    inputSchema: obj(
      {
        ...LOC,
        platform: { type: 'string', enum: ['meta', 'google'] },
        name: { type: 'string' },
        goal: { type: 'string', enum: [...GOALS], description: 'leads, traffic, conversions oder reach (reach nur Meta)' },
        kind: { type: 'string', enum: [...KINDS], description: 'Meta: website | lead_form · Google: search | pmax' },
        daily_budget: { type: 'number', description: 'Tagesbudget in Kontowährung' },
        lifetime_budget: { type: 'number', description: 'Gesamtbudget (braucht end_date)' },
        start_date: { type: 'string', description: 'YYYY-MM-DD, leer = ab Aktivierung' },
        end_date: { type: 'string' },
        countries: { type: 'array', items: { type: 'string' }, description: 'Meta: Ländercodes, z. B. ["DE","AT"]' },
        locations: { type: 'array', items: { type: 'object' }, description: 'Orte [{type: country|region|city|zip|geo, key, name, country?, radius?}] – Schlüssel aus der Zielgruppen-Suche der Oberfläche; Google: type geo + Geo-Target-ID' },
        age_min: { type: 'integer' },
        age_max: { type: 'integer' },
        genders: { type: 'array', items: { type: 'string', enum: ['male', 'female'] } },
        interests: { type: 'array', items: { type: 'object' }, description: 'Meta-Interessen [{id, name}]' },
        audience_ids: { type: 'array', items: { type: 'string' }, description: 'IDs eigener Zielgruppen (ghl_ads_accounts → audiences)' },
        keywords: { type: 'array', items: { type: 'object' }, description: 'Google: [{text, match: BROAD|PHRASE|EXACT}]' },
        negative_keywords: { type: 'array', items: { type: 'string' } },
        languages: { type: 'array', items: { type: 'string' }, description: 'Google: z. B. ["de"]' },
        primary_text: { type: 'string', description: 'Meta: Haupttext' },
        headline: { type: 'string', description: 'Meta: Überschrift' },
        description: { type: 'string' },
        cta: { type: 'string', enum: Object.keys(CTA_LABEL) },
        funnel_id: { type: 'string', description: 'Zielseite: Funnel (UTM-Parameter werden automatisch ergänzt)' },
        page_id: { type: 'string', description: 'Seite des Funnels (leer = erste)' },
        url: { type: 'string', description: 'oder eine Zieladresse (https)' },
        media_upload_ids: { type: 'array', items: { type: 'string' }, description: 'Bilder/Videos aus der Mediathek (GET /api/uploads)' },
        headlines: { type: 'array', items: { type: 'string' } },
        long_headlines: { type: 'array', items: { type: 'string' } },
        descriptions: { type: 'array', items: { type: 'string' } },
        business_name: { type: 'string' },
        lead_form_id: { type: 'string', description: 'Sofortformular (ghl_ads_accounts → lead_forms)' },
        conversion_event: { type: 'string', description: 'Meta: PURCHASE, LEAD …' },
        publish_paused: { type: 'boolean', description: 'true = zusätzlich pausiert bei der Plattform anlegen' },
      },
      ['location_id', 'platform', 'name', 'goal'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async (call: Caller, a: any) => {
      const daily = cents(a.daily_budget);
      const life = cents(a.lifetime_budget);
      if (!daily && !life) throw new HttpError(400, 'daily_budget oder lifetime_budget angeben');
      const spec = {
        platform: a.platform,
        name: a.name,
        goal: a.goal,
        kind: a.kind,
        budget: daily ? { type: 'daily', amount_cents: daily } : { type: 'lifetime', amount_cents: life },
        schedule: { start: a.start_date, end: a.end_date },
        audience: { countries: a.countries, locations: a.locations, age_min: a.age_min, age_max: a.age_max, genders: a.genders, interests: a.interests, audience_ids: a.audience_ids, keywords: a.keywords, negative_keywords: a.negative_keywords, languages: a.languages },
        creative: {
          primary_text: a.primary_text,
          headline: a.headline,
          description: a.description,
          cta: a.cta,
          link: { funnel_id: a.funnel_id, page_id: a.page_id, url: a.url },
          media: (a.media_upload_ids ?? []).map((u: string) => ({ upload_id: u })),
          headlines: a.headlines,
          long_headlines: a.long_headlines,
          descriptions: a.descriptions,
          business_name: a.business_name,
        },
        lead_form_id: a.lead_form_id,
        conversion_event: a.conversion_event,
      };
      const draft = await call.api('POST', '/api/ads/campaigns', { location: a.location_id, body: { spec } });
      const rv = await call.api('GET', `/api/ads/campaigns/${draft.id}/review`, { location: a.location_id });
      const result: Record<string, any> = { campaign_id: draft.id, status: draft.status, ready: rv.ready, errors: rv.errors, warnings: rv.warnings, review: rv.rows, note: rv.note };
      if (a.publish_paused === true) {
        if (!rv.ready) {
          result.published = false;
          result.message = 'Nicht angelegt: erst die Fehler beheben (Entwurf bleibt gespeichert, mit der Oberfläche oder erneutem Aufruf korrigieren).';
        } else {
          const done = await call.api('POST', `/api/ads/campaigns/${draft.id}/publish`, { location: a.location_id, body: { review_hash: rv.hash } });
          Object.assign(result, { status: done.status, published: true, remote_id: done.remote_id, message: done.message });
        }
      } else result.message = 'Entwurf gespeichert. Prüfen und pausiert anlegen in der Oberfläche unter Anzeigen – oder erneut mit publish_paused=true.';
      return result;
    },
  },
  {
    name: 'ghl_ads_update_status',
    title: 'Kampagne pausieren / aktivieren',
    description:
      'Pausiert eine Kampagne (sofort, spart Geld) oder beantragt das Aktivieren. Aktivieren gibt Geld aus und läuft NIE direkt: es entsteht eine Freigabe, die eine Person in der Oberfläche (Anzeigen → Freigaben) bestätigen muss. campaign_id = ID aus ghl_ads_insights (id oder campaign_ref).',
    inputSchema: obj({ ...LOC, campaign_id: { type: 'string', description: 'HyperLevel-ID oder campaign_ref wie "meta:12345"' }, status: { type: 'string', enum: ['paused', 'active'] } }, ['location_id', 'campaign_id', 'status']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: (call: Caller, a: any) => call.api('POST', `/api/ads/campaigns/${encodeURIComponent(a.campaign_id)}/status`, { location: a.location_id, body: { status: a.status } }),
  },
  {
    name: 'ghl_ads_update_budget',
    title: 'Budget ändern (Freigabe nötig)',
    description:
      'Beantragt eine Budgetänderung einer Kampagne (Betrag in Kontowährung, z. B. 35 = 35 €). Läuft NIE direkt: es entsteht eine Freigabe, die eine Person in der Oberfläche (Anzeigen → Freigaben) bestätigen muss. Das Tageslimit des Sub-Accounts gilt.',
    inputSchema: obj({ ...LOC, campaign_id: { type: 'string' }, daily_budget: { type: 'number' }, lifetime_budget: { type: 'number' } }, ['location_id', 'campaign_id']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: (call: Caller, a: any) => {
      const daily = cents(a.daily_budget);
      const life = cents(a.lifetime_budget);
      if (!daily && !life) throw new HttpError(400, 'daily_budget oder lifetime_budget angeben');
      return call.api('POST', `/api/ads/campaigns/${encodeURIComponent(a.campaign_id)}/budget`, { location: a.location_id, body: { amount_cents: daily ?? life, type: daily ? 'daily' : 'lifetime' } });
    },
  },
  {
    name: 'ghl_ads_insights',
    title: 'Anzeigen-Kennzahlen',
    description: 'Kennzahlen aller Kampagnen im Zeitraum (YYYY-MM-DD, Standard 30 Tage): Status, Budget, Ausgaben, Klicks, CTR, Leads laut Plattform und im CRM, Kosten pro Lead, Umsatz, ROAS – mit den IDs für ghl_ads_update_status/-budget.',
    inputSchema: obj({ ...LOC, from: { type: 'string' }, to: { type: 'string' }, platform: { type: 'string', enum: ['meta', 'google'] }, model: { type: 'string', enum: ['first', 'last'], description: 'Leads zählen nach erstem/letztem Kontakt' } }, ['location_id']),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call: Caller, a: any) => call.api('GET', `/api/ads/insights${q({ from: a.from, to: a.to, platform: a.platform, model: a.model })}`, { location: a.location_id }),
  },
];

const COPY_SYSTEM = [
  'Du schreibst deutsche Anzeigentexte für bezahlte Werbung (Meta und Google).',
  'Regeln: konkret und ehrlich, keine übertriebenen Versprechen, keine Heilversprechen, keine Anspielung auf persönliche Eigenschaften der Leser (Gesundheit, Finanzen, Herkunft), keine Großbuchstaben-Schreierei, höchstens ein Ausrufezeichen.',
  'Halte die Zeichenlimits strikt ein. Jede Variante setzt einen anderen Schwerpunkt (Nutzen, Problem, Beweis, Angebot, Dringlichkeit).',
].join(' ');

export const adsToolsModule: Module = {
  name: 'ads-tools',
  register(app) {
    const { router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];

    // --- AI suggestions for the wizard ---------------------------------------------------------------------------
    const pageText = (locationId: string, funnelId: string, pageId: string) => {
      const f = app.db.get('SELECT id, name FROM funnels WHERE id = ? AND location_id = ?', funnelId, locationId);
      if (!f) return '';
      const p = pageId ? app.db.get('SELECT * FROM funnel_pages WHERE id = ? AND funnel_id = ?', pageId, f.id) : app.db.get('SELECT * FROM funnel_pages WHERE funnel_id = ? ORDER BY position, created_at LIMIT 1', f.id);
      const blocks: any[] = p ? parseJson({ ...p }, ['blocks']).blocks : [];
      const parts: string[] = [`Funnel: ${f.name}`, p ? `Seite: ${p.name}` : ''];
      for (const b of Array.isArray(blocks) ? blocks : []) {
        for (const k of ['title', 'headline', 'subtitle', 'text', 'body', 'cta', 'label']) if (typeof b?.[k] === 'string' && b[k].trim()) parts.push(String(b[k]).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300));
        if (Array.isArray(b?.items)) for (const it of b.items.slice(0, 6)) if (typeof it?.title === 'string') parts.push(it.title.slice(0, 120));
      }
      return parts.filter(Boolean).join('\n').slice(0, 2500);
    };

    const fit = (list: unknown, max: number, count: number, min = 1) => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const x of Array.isArray(list) ? list : []) {
        const t = String(x ?? '').replace(/\s+/g, ' ').trim();
        if (t.length < min || t.length > max || seen.has(t.toLowerCase())) continue;
        seen.add(t.toLowerCase());
        out.push(t);
        if (out.length >= count) break;
      }
      return out;
    };

    router.post('/api/ads/suggest', 'location', async (ctx) => {
      if (!app.services.aiRun) throw new HttpError(409, 'Der KI-Assistent ist nicht verfügbar');
      const b = ctx.body ?? {};
      const platform = b.platform === 'google' ? 'google' : 'meta';
      const goal = (GOALS as readonly string[]).includes(b.goal) ? b.goal : 'leads';
      const brief = str(b.brief, 'Beschreibung', { max: 1500 });
      const page = b.funnel_id ? pageText(ctx.locationId, String(b.funnel_id), String(b.page_id ?? '')) : '';
      if (!brief && !page) throw bad('Bitte kurz beschreiben, was beworben wird – oder eine Funnel-Seite wählen');
      const count = Math.min(Math.max(Math.round(Number(b.count ?? 5)) || 5, 1), 8);
      const meta = platform === 'meta';
      const schema = meta
        ? { type: 'object', properties: { primary_texts: { type: 'array', items: { type: 'string' } }, headlines: { type: 'array', items: { type: 'string' } }, descriptions: { type: 'array', items: { type: 'string' } } }, required: ['primary_texts', 'headlines', 'descriptions'], additionalProperties: false }
        : { type: 'object', properties: { headlines: { type: 'array', items: { type: 'string' } }, long_headlines: { type: 'array', items: { type: 'string' } }, descriptions: { type: 'array', items: { type: 'string' } }, keywords: { type: 'array', items: { type: 'string' } }, negative_keywords: { type: 'array', items: { type: 'string' } } }, required: ['headlines', 'descriptions', 'keywords'], additionalProperties: false };
      const limits = meta
        ? `Meta (Facebook/Instagram), Ziel ${goal}. Liefere ${count} Haupttexte (höchstens 125 Zeichen), ${count} Überschriften (höchstens 40 Zeichen) und ${count} Beschreibungen (höchstens 30 Zeichen).`
        : `Google Ads Suchnetzwerk, Ziel ${goal}. Liefere 10 Überschriften (höchstens 30 Zeichen), 3 lange Überschriften (höchstens 90 Zeichen), 4 Beschreibungen (höchstens 90 Zeichen), 12 passende Suchbegriffe (Keywords, ohne Anführungszeichen) und 8 ausschließende Suchbegriffe.`;
      const user = [COPY_SYSTEM, limits, brief ? `Was beworben wird:\n${brief}` : '', page ? `Inhalt der Zielseite:\n${page}` : ''].filter(Boolean).join('\n\n');
      const r = await app.services.aiRun({ locationId: ctx.locationId, purpose: 'ads_copy', user, schema, maxTokens: 1800, userId: ctx.user?.id ?? null, timeoutMs: 90_000 });
      let j: any = {};
      try {
        j = JSON.parse(r.text);
      } catch {
        throw new HttpError(502, 'Die KI hat keine verwertbaren Vorschläge geliefert – bitte noch einmal versuchen');
      }
      return meta
        ? { primary_texts: fit(j.primary_texts, 125, count), headlines: fit(j.headlines, 40, count), descriptions: fit(j.descriptions, 30, count) }
        : { headlines: fit(j.headlines, 30, 15, 3), long_headlines: fit(j.long_headlines, 90, 5, 5), descriptions: fit(j.descriptions, 90, 4, 10), keywords: fit(j.keywords, 80, 20), negative_keywords: fit(j.negative_keywords, 80, 10) };
    });

    // --- native app (bearer ghm_…): relays onto the routes ------------------------------------------------------------
    const loc = (ctx: any) => bodyLocation(app, ctx, ctx.query.get('location') ?? ctx.body?.location_id);

    router.get('/api/mobile/ads', 'user', async (ctx) => {
      const l = loc(ctx);
      const r = await callRoute(app, ctx, 'GET', '/api/ads/campaigns', { locationId: l.id });
      return {
        location_id: l.id,
        approvals_pending: r.approvals_pending,
        totals: r.totals ? { spend_cents: r.totals.spend_cents, clicks: r.totals.clicks, crm_leads: r.totals.crm_leads, cpl_cents: r.totals.cpl_cents } : null,
        campaigns: r.campaigns.filter((c: any) => c.id === null || c.status !== 'draft').map((c: any) => ({ ref: c.id ?? `${c.platform}:${c.remote_id}`, platform: c.platform, name: c.name, status: c.status, budget_cents: c.budget_cents, budget_type: c.budget_type, currency: c.currency, spend_cents: c.metrics?.spend_cents ?? 0, clicks: c.metrics?.clicks ?? 0, crm_leads: c.metrics?.crm_leads ?? 0, cpl_cents: c.metrics?.cpl_cents ?? null })),
      };
    });
    router.post('/api/mobile/ads/:ref/status', 'user', async (ctx) => {
      ctx.skipAfterWrite = true;
      const l = loc(ctx);
      return callRoute(app, ctx, 'POST', `/api/ads/campaigns/${encodeURIComponent(ctx.params.ref)}/status`, { locationId: l.id, body: { status: ctx.body?.status, confirm: ctx.body?.confirm === true } });
    });
    router.get('/api/mobile/ads/approvals', 'user', async (ctx) => callRoute(app, ctx, 'GET', '/api/ads/approvals', { locationId: loc(ctx).id }));
    router.post('/api/mobile/ads/approvals/:id/:decision', 'user', async (ctx) => {
      ctx.skipAfterWrite = true;
      if (ctx.params.decision !== 'approve' && ctx.params.decision !== 'reject') throw notFound();
      return callRoute(app, ctx, 'POST', `/api/ads/approvals/${encodeURIComponent(ctx.params.id)}/${ctx.params.decision}`, { locationId: loc(ctx).id, body: {} });
    });

  },
};
