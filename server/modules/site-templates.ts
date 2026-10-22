import type { App, Module } from '../core/app.js';
import { HttpError, bad, html, notFound, str, type Ctx } from '../core/http.js';
import { id, now, slugify } from '../core/util.js';
import { cleanBlocks } from '../services/site-layout.js';
import { pageUrl, renderPage } from '../services/site-render.js';
import { CATEGORIES, TEMPLATES, formSpec, settingsOf, templateMeta, templateOf, wireBlocks, type Wiring } from '../services/site-templates.js';
import { callRoute } from '../services/route-call.js';
import type { Tool } from './mcp.js';

/**
 * Template gallery: 23 German templates for websites and funnels (coach, craftsman, agency, SaaS, restaurant, practice, real estate,
 * law and tax firm, fitness, photographer, salon, club, careers, lead magnet, webinar, course sales, event, link in bio, newsletter,
 * podcast, product launch, video sales letter, application funnel). `POST /api/site-templates/:id/apply` builds the site: pages with
 * blocks, design tokens, header/footer/menu, the collections it uses (with sample entries), a form (or the one you pick) wired into
 * every form block, your calendar and product where the template has a place for them – and the legal pages from the company data
 * of the Einwilligung-&-Recht area (Impressum, Datenschutz, and Widerruf where something is sold).
 */

export const siteTemplatesModule: Module = {
  name: 'site-templates',
  register(app: App) {
    const { db, router } = app;
    const writable = (ctx: Ctx) => {
      if (ctx.scope === 'read') throw new HttpError(403, 'Dieser Schlüssel darf nur lesen');
    };
    const tplOr404 = (idv: string) => {
      const t = templateOf(idv);
      if (!t) throw notFound('Vorlage nicht gefunden');
      return t;
    };

    router.get('/api/site-templates', 'location', (ctx) => {
      const kind = ctx.query.get('kind');
      return { categories: CATEGORIES, templates: TEMPLATES.filter((t) => !kind || t.kind === kind).map(templateMeta) };
    });
    router.get('/api/site-templates/:id', 'location', (ctx) => templateMeta(tplOr404(ctx.params.id)));

    /** The template as a visitor would see it (no site is created): with example content, mock form and calendar. */
    router.get('/api/site-templates/:id/preview', 'location', (ctx) => {
      const t = tplOr404(ctx.params.id);
      const slug = String(ctx.query.get('page') || t.pages[0].slug);
      const page = t.pages.find((p) => p.slug === slug) ?? t.pages[0];
      const w: Wiring = { firma: 'Ihr Unternehmen', form_id: '', calendar_slug: '', product_id: '', collections: new Map((t.collections ?? []).map((c) => [c.preset, `preset:${c.preset}`])), pages: new Map(t.pages.map((p) => [p.slug, p.slug])), now: new Date() };
      const funnel = { id: '', location_id: ctx.locationId, slug: 'vorschau', domain: null, kind: t.kind, name: t.name, settings: settingsOf(t, w) };
      const pages = t.pages.map((p, i) => ({ id: p.slug, name: p.name, slug: p.slug, position: i, seo: p.seo ?? {}, layout: p.layout ?? {} }));
      const full = renderPage(app, funnel, { id: page.slug, name: page.name, slug: page.slug, seo: page.seo ? wireSeo(page.seo, w.firma) : {}, layout: page.layout ?? {}, blocks: cleanBlocks(wireBlocks(page.blocks as any, w)) }, page.slug === t.pages[0].slug, { preview: true, pages });
      // Links lead nowhere in a preview (the frame would show the app's 404).
      const r = html(full.replace(/href="http:\/\/[^"]*\/p\/vorschau[^"]*"/g, 'href="#"'));
      r.headers['content-security-policy'] = "sandbox allow-scripts; default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src 'none'";
      r.headers['cache-control'] = 'no-store';
      return r;
    });

    const wireSeo = (seo: Record<string, any>, firma: string) => Object.fromEntries(Object.entries(seo).map(([k, v]) => [k, typeof v === 'string' ? v.replace(/\{\{firma\}\}/g, firma) : v]));
    const uniqueSlug = (base: string) => {
      const root = slugify(base) || 'website';
      let slug = root;
      for (let i = 2; db.get('SELECT id FROM funnels WHERE slug = ?', slug); i++) slug = `${root}-${i}`;
      return slug;
    };

    /** Creates a site from a template. Everything the template needs from the account is created or taken from the request. */
    router.post('/api/site-templates/:id/apply', 'location', async (ctx) => {
      writable(ctx);
      const t = tplOr404(ctx.params.id);
      const b = ctx.body ?? {};
      const firma = str(b.name, 'Name', { max: 120 }) || (app.location(ctx.locationId)?.name ?? t.name);
      const fid = id();
      const slug = uniqueSlug(b.slug || firma);
      const notes: string[] = [];
      const loc = ctx.locationId;

      // What the account contributes: the chosen form / calendar / product – or a new form, when the template has a form.
      const own = (table: string, col: string, v: unknown) => (typeof v === 'string' && v ? db.get(`SELECT * FROM ${table} WHERE ${col} = ? AND location_id = ?`, v, loc) : undefined);
      const wiring: Wiring = { firma, form_id: '', calendar_slug: '', product_id: '', collections: new Map(), pages: new Map(), now: new Date() };
      let createdForm = false;
      if (t.needs.includes('form')) {
        const chosen = own('forms', 'id', b.form_id);
        if (b.form_id && !chosen) throw bad('Formular nicht gefunden');
        wiring.form_id = chosen?.id ?? '';
      }
      if (t.needs.includes('calendar')) {
        const chosen = own('calendars', 'slug', b.calendar_slug) ?? (b.calendar_slug ? undefined : db.get('SELECT * FROM calendars WHERE location_id = ? ORDER BY created_at LIMIT 1', loc));
        if (b.calendar_slug && !chosen) throw bad('Kalender nicht gefunden');
        wiring.calendar_slug = chosen?.slug ?? '';
        if (!chosen) notes.push('Du hast noch keinen Kalender: lege unter „Kalender“ einen an und wähle ihn im Block „Kalender“.');
      }
      if (t.needs.includes('product')) {
        const chosen = own('products', 'id', b.product_id);
        if (b.product_id && !chosen) throw bad('Produkt nicht gefunden');
        wiring.product_id = chosen?.id ?? '';
        if (!chosen) notes.push('Wähle im Block „Produkt“ das Produkt, das hier verkauft wird (Rechnungen → Produkte; Stripe verbinden, damit der Kauf-Button erscheint).');
      }

      db.insert('funnels', { id: fid, location_id: loc, name: firma, slug: uniqueSlug(slug), kind: t.kind, settings: {}, created_at: now(), updated_at: now() });
      try {
        if (t.needs.includes('form') && !wiring.form_id) {
          try {
            const spec = formSpec(t.form, firma);
            const form = await callRoute(app, ctx, 'POST', '/api/forms', { name: spec.name, fields: spec.fields, settings: { ...spec.settings, tags: [`vorlage:${t.id}`] } });
            wiring.form_id = form.id;
            createdForm = true;
          } catch (e) {
            notes.push(`Das Formular konnte nicht angelegt werden (${(e as Error).message}): wähle in den Formular-Blöcken ein Formular aus.`);
          }
        }
        // pages first (ids), then collections (they hold block references), then the pages' blocks
        const pageIds = t.pages.map((p) => ({ ...p, pid: id() }));
        for (const p of pageIds) wiring.pages.set(p.slug, p.pid);
        for (const c of t.collections ?? []) {
          const created = await callRoute(app, ctx, 'POST', `/api/funnels/${fid}/collections`, { preset: c.preset, name: c.name, slug: c.slug, singular: c.singular, with_samples: b.samples !== false && c.samples !== false });
          wiring.collections.set(c.preset, created.id);
        }
        const settings = settingsOf(t, wiring);
        db.update('funnels', fid, { settings });
        db.tx(() => {
          pageIds.forEach((p, i) => {
            db.insert('funnel_pages', { id: p.pid, location_id: loc, funnel_id: fid, name: p.name, slug: p.slug, position: i, blocks: cleanBlocks(wireBlocks(p.blocks as any, wiring)), seo: wireSeo({ title: p.name, ...(p.seo ?? {}) }, firma), layout: p.layout ?? {}, created_at: now(), updated_at: now() });
          });
        });
        // After the form: to the thank-you page (only for a form this step created – a form the owner brought keeps its settings).
        if (createdForm && t.thanks) {
          const to = pageIds.find((p) => p.slug === t.thanks);
          const f = db.get('SELECT * FROM funnels WHERE id = ?', fid)!;
          if (to) await callRoute(app, ctx, 'PATCH', `/api/forms/${wiring.form_id}`, { settings: { redirect_url: pageUrl(app, { ...f, settings: {} }, to) } });
        }
        // Legal pages: the generator fills them from the company data; without it the placeholders stay and say so.
        let legal: { applied: boolean; kinds: string[]; message: string } = { applied: false, kinds: [], message: '' };
        if (b.legal !== false && t.legal.length) {
          try {
            const r = await callRoute(app, ctx, 'POST', `/api/legal/funnels/${fid}/apply`, { kinds: t.legal, overwrite: true });
            legal = { applied: Array.isArray(r?.pages) && r.pages.length > 0, kinds: (r?.pages ?? []).map((x: any) => x.kind), message: '' };
          } catch (e) {
            legal.message = (e as Error).message;
          }
          if (!legal.applied) notes.push(legal.message || 'Impressum und Datenschutz enthalten noch Platzhalter: trage unter „Einwilligung & Recht“ die Firmendaten ein und erzeuge die Texte dort mit einem Klick.');
        }
        const out = db.get('SELECT * FROM funnels WHERE id = ?', fid)!;
        const f = JSON.parse(JSON.stringify({ ...out, settings: JSON.parse(out.settings || '{}') }));
        return {
          ...f,
          url: pageUrl(app, f),
          template: t.id,
          pages: db.all('SELECT id, name, slug, position FROM funnel_pages WHERE funnel_id = ? ORDER BY position', fid),
          wiring: { form_id: wiring.form_id, form_created: createdForm, calendar_slug: wiring.calendar_slug, product_id: wiring.product_id, collections: [...wiring.collections.values()] },
          legal,
          notes,
        };
      } catch (e) {
        // A half-built site is worse than none: take everything back (pages and collections go with the site).
        db.run('DELETE FROM funnels WHERE id = ?', fid);
        throw e;
      }
    });

    const TOOLS: Tool[] = [
      {
        name: 'ghl_site_templates',
        title: 'Website- und Funnel-Vorlagen',
        description: 'Listet die Vorlagen der Galerie (Coach, Handwerk, Agentur, SaaS, Restaurant, Praxis, Immobilien, Kanzlei, Fitness, Fotograf, Salon, Verein, Karriere, Lead-Magnet, Webinar, Kurs-Verkauf, Event, Link-in-Bio, Newsletter, Podcast, Produkt-Launch, Video-Sales-Letter, Termin-Funnel) oder legt aus einer Vorlage eine neue Website/einen Funnel an (apply: true, template_id) – inklusive Formular, Rechtstexten und Sammlungen.',
        inputSchema: { type: 'object', properties: { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID' }, template_id: { type: 'string' }, apply: { type: 'boolean', description: 'true: Website aus der Vorlage anlegen' }, name: { type: 'string', description: 'Name der neuen Website (Standard: Name des Projekts)' } }, required: ['location_id'], additionalProperties: false },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        run: (call, a) => (a.apply && a.template_id ? call.api('POST', `/api/site-templates/${encodeURIComponent(a.template_id)}/apply`, { location: a.location_id, body: { name: a.name } }) : call.api('GET', '/api/site-templates', { location: a.location_id })),
      },
    ];
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
  },
};
