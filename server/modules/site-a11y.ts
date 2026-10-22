import type { App, Module } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { HttpError, notFound, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import { docToBlocks, docToHtml, docToMarkdown, LEGAL_NOTICE } from '../services/legal-texts.js';
import { blockContrast, checkDocument, checkFragment, group, statementDoc, summarize, tokenContrast, type A11yIssue } from '../services/site-a11y.js';
import { cleanBlocks, walkBlocks } from '../services/site-layout.js';
import { makeEnv, pageUrl, renderPage } from '../services/site-render.js';
import { cleanPageLayout, cleanSiteSettings } from '../services/site-settings.js';
import { tokensOf } from '../services/site-style.js';
import type { Tool } from './mcp.js';

/**
 * Barrierefreiheits-Prüfung (BFSG, EN 301 549 / WCAG 2.1 AA): checks the pages of a site the way visitors get them – alt texts,
 * heading order, form labels, link/button names, iframes, contrast, focus, language – with a fix hint per finding and the block
 * it sits in; drafts the "Erklärung zur Barrierefreiheit" from the result and the company data (never publishes without a click).
 * The automatic check is a start, not a certificate: the report lists what has to be tested by hand.
 */

const MANUAL = [
  'Die ganze Seite nur mit der Tastatur bedienen (Tab, Shift+Tab, Enter, Esc): Ist immer sichtbar, wo der Fokus ist? Kommt man überall hin?',
  'Auf 200 % vergrößern und auf dem Handy quer/hochkant ansehen: Geht nichts verloren, scrollt nichts seitwärts?',
  'Mit einem Screenreader (VoiceOver, NVDA) die wichtigsten Wege durchgehen: Formular ausfüllen, Termin buchen, Kaufen.',
  'Videos und Audio: Untertitel bzw. ein Transkript vorhanden? Nichts startet von allein mit Ton?',
  'Sind Texte verständlich geschrieben, Fehlermeldungen in Formularen klar und Pflichtfelder gekennzeichnet?',
  'Sind alle Informationen auch ohne Farbe verständlich (nicht nur „der rote Button“)?',
];

export const siteA11yModule: Module = {
  name: 'site-a11y',
  register(app: App) {
    const { db, router } = app;

    const funnelOr404 = (ctx: Ctx, fid = ctx.params.id) => {
      const f = parseJson(db.get('SELECT * FROM funnels WHERE id = ? AND location_id = ?', fid, ctx.locationId), ['settings']);
      if (!f) throw notFound('Website nicht gefunden');
      return f;
    };

    /** All findings for one page (draft or saved): document rules, per-block element rules, colours. */
    function checkPage(f: any, page: any, isFirst: boolean): A11yIssue[] {
      const full = renderPage(app, f, page, isFirst, { preview: true });
      const issues = checkDocument(full);
      const env = makeEnv(app, f, page, { preview: true });
      const blocks = Array.isArray(page.blocks) ? page.blocks : [];
      walkBlocks(blocks, (b, parent) => {
        if (b.type === 'section') return;
        let html = '';
        try {
          html = env.render([b], { bare: !!parent });
        } catch {
          return;
        }
        issues.push(...checkFragment({ html, block_id: b.id, block_type: b.type }));
      });
      issues.push(...blockContrast(blocks, tokensOf(f.settings)));
      // Header and footer are part of every page: findings there are reported once on the site level (see siteIssues).
      return issues;
    }

    /** Findings that belong to the site as a whole: the colour palette, the statement page. */
    function siteIssues(f: any, pages: any[]): A11yIssue[] {
      const out = tokenContrast(tokensOf(f.settings));
      if (!pages.some((p) => p.slug === 'barrierefreiheit')) {
        out.push({
          rule: 'statement',
          level: 'info',
          wcag: 'BFSG §14',
          message: 'Es gibt noch keine Erklärung zur Barrierefreiheit.',
          hint: 'Wer vom BFSG erfasst ist (Online-Handel, Buchungs- und Bezahlstrecken für Verbraucher), muss eine Erklärung veröffentlichen. Erstelle unten den Entwurf – Kleinstunternehmen mit reinen Dienstleistungen sind ausgenommen.',
        });
      }
      return out;
    }

    function report(ctx: Ctx, f: any, only?: string) {
      const rows = parseRows(db.all('SELECT * FROM funnel_pages WHERE funnel_id = ? ORDER BY position, created_at LIMIT 80', f.id), ['blocks', 'seo', 'layout']);
      const list = only ? rows.filter((p) => p.id === only) : rows;
      const pages = list.map((p) => {
        const all = checkPage(f, p, rows[0]?.id === p.id);
        return { id: p.id, name: p.name, slug: p.slug, url: pageUrl(app, f, p, rows[0]?.id === p.id), summary: summarize(all), issues: group(all) };
      });
      const site = siteIssues(f, rows);
      const flat = [...site, ...pages.flatMap((p) => p.issues)];
      return {
        checked_at: now(),
        standard: 'BFSG · EN 301 549 · WCAG 2.1 AA',
        site: { summary: summarize(site), issues: group(site) },
        pages,
        summary: summarize(flat),
        manual: MANUAL,
        statement: (() => {
          const p = rows.find((x) => x.slug === 'barrierefreiheit');
          return p ? { exists: true, page_id: p.id, url: pageUrl(app, f, p) } : { exists: false };
        })(),
      };
    }

    router.get('/api/funnels/:id/a11y', 'location', (ctx) => report(ctx, funnelOr404(ctx), ctx.query.get('page') || undefined));

    /** The editor's check of a draft: blocks, page layout and site settings that are not saved yet. */
    router.post('/api/funnel-pages/:id/a11y', 'location', (ctx) => {
      const p = parseJson(db.get('SELECT * FROM funnel_pages WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId), ['blocks', 'seo', 'layout']);
      if (!p) throw notFound('Seite nicht gefunden');
      const f = funnelOr404(ctx, p.funnel_id);
      const draft = ctx.body?.settings && typeof ctx.body.settings === 'object' ? { ...f, settings: { ...f.settings, ...cleanSiteSettings(ctx.body.settings, f.settings) } } : f;
      const layout = ctx.body?.layout && typeof ctx.body.layout === 'object' ? cleanPageLayout(ctx.body.layout, p.layout) : p.layout;
      const first = db.get<{ id: string }>('SELECT id FROM funnel_pages WHERE funnel_id = ? ORDER BY position, created_at LIMIT 1', f.id)?.id === p.id;
      const page = { ...p, layout, seo: { ...p.seo, ...(ctx.body?.seo ?? {}) }, blocks: ctx.body?.blocks ? cleanBlocks(ctx.body.blocks) : p.blocks };
      const issues = checkPage(draft, page, first);
      return { checked_at: now(), summary: summarize(issues), issues: group(issues) };
    });

    // --- the statement -----------------------------------------------------------------------------------------------------------
    router.post('/api/funnels/:id/a11y/statement', 'location', (ctx) => {
      if (ctx.scope === 'read') throw new HttpError(403, 'Dieser Schlüssel darf nur lesen');
      const f = funnelOr404(ctx);
      const r = report(ctx, f);
      const profile = app.services.legalTexts?.profile?.(ctx.locationId) as { company: string; email: string; phone: string; street: string; zip: string; city: string; website: string } | undefined;
      const date = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: app.location(ctx.locationId)?.timezone || 'Europe/Berlin' }).format(new Date());
      const doc = statementDoc({
        company: profile?.company ?? '',
        email: profile?.email ?? '',
        phone: profile?.phone ?? '',
        website: pageUrl(app, f),
        address: [profile?.street, [profile?.zip, profile?.city].filter(Boolean).join(' ')].filter(Boolean).join(', '),
        scope: f.kind === 'website' ? 'diese Website' : 'diese Seiten',
        date,
        issues: [...r.site.issues, ...r.pages.flatMap((p) => p.issues)] as A11yIssue[],
        pages: r.pages.filter((p) => p.slug !== 'barrierefreiheit').map((p) => p.name),
        notice: LEGAL_NOTICE,
      });
      const out: Record<string, any> = { doc, html: docToHtml(doc as any, { notice: true }), markdown: docToMarkdown(doc as any, { notice: true }), missing: doc.missing, notice: LEGAL_NOTICE };
      if (ctx.body?.apply === true) {
        const blocks = docToBlocks(doc as any).map((b) => ({ ...b, id: id(8) }));
        const page = parseJson(db.get('SELECT * FROM funnel_pages WHERE funnel_id = ? AND slug = ?', f.id, 'barrierefreiheit'), ['blocks', 'seo']);
        if (page) db.update('funnel_pages', page.id, { blocks, updated_at: now() });
        else {
          const pos = db.get<{ n: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM funnel_pages WHERE funnel_id = ?', f.id)!.n;
          const row = { id: id(), location_id: ctx.locationId, funnel_id: f.id, name: 'Barrierefreiheit', slug: 'barrierefreiheit', position: pos, blocks, seo: { title: doc.title }, layout: {}, created_at: now(), updated_at: now() };
          db.insert('funnel_pages', row);
          out.page = { id: row.id, url: pageUrl(app, f, row) };
        }
        if (page) out.page = { id: page.id, url: pageUrl(app, f, page) };
        db.run('UPDATE funnels SET updated_at = ? WHERE id = ?', now(), f.id);
      }
      return out;
    });

    // --- MCP ---------------------------------------------------------------------------------------------------------------------
    const TOOLS: Tool[] = [
      {
        name: 'ghl_site_a11y_check',
        title: 'Barrierefreiheits-Prüfung (BFSG)',
        description: 'Prüft die Seiten einer Website/eines Funnels automatisch auf Barrierefreiheit (Alternativtexte, Überschriften, Formular-Labels, Link-/Button-Namen, Kontraste, Sprache, Fokus) und liefert je Befund Hinweis und Block. Das ist eine Hilfe, kein Zertifikat – manuelle Prüfungen stehen unter `manual`.',
        inputSchema: { type: 'object', properties: { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID' }, funnel_id: { type: 'string', description: 'Website/Funnel-ID (aus GET /api/funnels)' }, page_id: { type: 'string', description: 'nur eine Seite' } }, required: ['location_id', 'funnel_id'], additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: false },
        run: (call, a) => call.api('GET', `/api/funnels/${encodeURIComponent(a.funnel_id)}/a11y${a.page_id ? `?page=${encodeURIComponent(a.page_id)}` : ''}`, { location: a.location_id }),
      },
    ];
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
  },
};
