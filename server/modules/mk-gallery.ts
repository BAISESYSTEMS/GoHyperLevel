import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, str } from '../core/http.js';
import { id, now } from '../core/util.js';
import { designPatch } from '../services/email-design.js';
import { CATEGORIES, TEMPLATES, categoryLabel, metaOf, preview, searchTemplates, templateByKey } from '../services/mk-gallery.js';
import type { Tool } from './mcp.js';

/**
 * Template gallery (docs/email-marketing.md): about sixty finished German e-mail designs by occasion, searchable, with a preview. A
 * template is copied into the sub-account's own templates or onto a campaign draft – from there it is an ordinary design that is
 * edited in the designer. The designs live in code (services/mk-gallery*.ts), nothing is stored per sub-account until it is used.
 */

const TOOLS: Tool[] = [
  {
    name: 'ghl_email_gallery',
    title: 'E-Mail-Vorlagengalerie',
    description:
      'Die Vorlagengalerie: fertige deutsche E-Mail-Designs (Newsletter, Angebot, Willkommen, Event, Webinar, Kurs, Rechnung & Zahlung, Feiertage, B2B, Coach, Handwerk, E-Commerce, Feedback). Ohne use: Liste mit optionaler Suche (q) und Kategorie. Mit use (Schlüssel): legt daraus eine eigene E-Mail-Vorlage an (name optional), die sich im Designer weiter bearbeiten lässt.',
    inputSchema: {
      type: 'object',
      properties: { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID' }, q: { type: 'string', description: 'Suchwörter, z. B. „Rabatt“ oder „Webinar“' }, category: { type: 'string', enum: CATEGORIES.map((c) => c.key) }, use: { type: 'string', description: 'Schlüssel einer Vorlage aus der Liste' }, name: { type: 'string', description: 'Name der neuen Vorlage (mit use)' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    klassFor: (a) => (a.use ? 'write' : 'read'),
    run: async (call, a) => {
      if (a.use) {
        const made = await call.api('POST', `/api/email-gallery/${encodeURIComponent(a.use)}/use`, { location: a.location_id, body: { target: 'template', name: a.name } });
        return { template_id: made.template?.id, name: made.template?.name, subject: made.template?.subject };
      }
      const qs = new URLSearchParams();
      if (a.q) qs.set('q', a.q);
      if (a.category) qs.set('category', a.category);
      const r = await call.api('GET', `/api/email-gallery${qs.size ? `?${qs}` : ''}`, { location: a.location_id });
      return { count: r.templates.length, categories: r.categories.map((c: any) => ({ key: c.key, label: c.label, count: c.count })), templates: r.templates.map((t: any) => ({ key: t.key, name: t.name, category: t.category_label, description: t.description, subject: t.subject, formal: t.formal, service: t.service })) };
    },
  },
];

export const mkGalleryModule: Module = {
  name: 'mk-gallery',
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];

    router.get('/api/email-gallery', 'location', (ctx) => {
      const q = (ctx.query.get('q') ?? '').slice(0, 100);
      const category = ctx.query.get('category') ?? '';
      const found = searchTemplates(q, category);
      // The counts per category belong to the search (without the category filter), so the chips show what a click would give.
      const all = searchTemplates(q, '');
      return {
        total: TEMPLATES.length,
        categories: CATEGORIES.map((c) => ({ ...c, count: all.filter((t) => t.category === c.key).length })),
        templates: found.map(metaOf),
      };
    });

    /** One template with its design (for the editor and the API) and a finished preview with sample data. */
    router.get('/api/email-gallery/:key', 'location', (ctx) => {
      const t = templateByKey(ctx.params.key);
      if (!t) throw notFound('Vorlage nicht gefunden');
      const design = t.build();
      const loc = app.location(ctx.locationId);
      return { ...metaOf(t), design, ...preview(design, { name: loc?.name, address: loc?.address }, t.subject) };
    });

    /**
     * Copies a template: as the sub-account's own template (default) or onto a campaign that is still a draft or scheduled
     * (`campaign_id`; the subject is taken over when the campaign has none or `replace_subject` is set).
     */
    router.post('/api/email-gallery/:key/use', 'location', (ctx) => {
      const t = templateByKey(ctx.params.key);
      if (!t) throw notFound('Vorlage nicht gefunden');
      const design = t.build();
      if (ctx.body?.target === 'campaign' || ctx.body?.campaign_id) {
        const cid = str(ctx.body.campaign_id, 'Kampagne', { required: true });
        const c = db.get<any>('SELECT * FROM campaigns WHERE id = ? AND location_id = ?', cid, ctx.locationId);
        if (!c) throw notFound('Kampagne nicht gefunden');
        if (c.channel !== 'email') throw bad('Vorlagen aus der Galerie gibt es nur für E-Mail-Kampagnen');
        if (!['draft', 'scheduled'].includes(c.status)) throw new HttpError(400, 'Versendete Kampagnen lassen sich nicht ändern');
        const patch: Record<string, any> = { updated_at: now(), ...designPatch({ design }, { design: c.design }) };
        if (!c.subject || ctx.body.replace_subject) patch.subject = t.subject;
        db.update('campaigns', c.id, patch, ctx.locationId);
        return { campaign: { id: c.id, subject: patch.subject ?? c.subject }, template: metaOf(t) };
      }
      const name = str(ctx.body?.name, 'Name', { max: 200 }) || `${t.name} (${categoryLabel(t.category)})`;
      const row = { id: id(), location_id: ctx.locationId, name, channel: 'email', subject: t.subject, body: '', is_html: 1, created_at: now(), updated_at: now(), ...designPatch({ design }) };
      db.insert('templates', row);
      return { template: { id: row.id, name: row.name, subject: row.subject }, from: metaOf(t) };
    });
  },
};
