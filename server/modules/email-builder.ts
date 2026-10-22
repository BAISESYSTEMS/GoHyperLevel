import type { Module } from '../core/app.js';
import { parseRows } from '../core/db.js';
import { HttpError, bad, notFound, str } from '../core/http.js';
import { render } from '../core/template.js';
import { id, normalizeEmail, now } from '../core/util.js';
import { contactVars, getContact } from '../services/contacts.js';
import { parseDesign } from '../services/email-design.js';
import { designIssues, normalizeDesign, renderEmailHtml, renderEmailText, type EmailDesign } from '../services/email-render.js';
import { STARTERS } from '../services/email-starters.js';
import { composeEmail, deliverEmail } from '../services/messaging.js';
import type { Tool } from './mcp.js';

/**
 * Drag-and-drop email builder: starter designs, reusable sections, server-side rendering and test
 * sends. Templates, campaigns and workflow steps store the `design` themselves (rendered on save,
 * see services/email-design.ts); this module only adds what the editor needs around them.
 */

const SAMPLE_CONTACT = { first_name: 'Max', last_name: 'Mustermann', name: 'Max Mustermann', full_name: 'Max Mustermann', email: 'max@example.com', phone: '+49 151 23456789', company_name: 'Musterfirma', custom: {} };

/** At most this many test mails per sub-account and 10 minutes (no misuse as a mail relay). */
const TEST_LIMIT = 20;
const testHits = new Map<string, number[]>();

const TOOLS: Tool[] = [
  {
    name: 'ghl_list_email_templates',
    title: 'E-Mail-Vorlagen',
    description: 'E-Mail- und SMS-Vorlagen eines Projekts (ohne HTML). has_design = mit dem Drag-and-drop-Builder gestaltet. Startvorlagen des Builders: starters.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call, a) => {
      const list: any[] = await call.api('GET', '/api/templates', { location: a.location_id });
      const starters: any[] = await call.api('GET', '/api/email-builder/starters', { location: a.location_id });
      return {
        templates: list.map((t) => ({ id: t.id, name: t.name, channel: t.channel, subject: t.subject, has_design: !!t.design, updated_at: t.updated_at })),
        starters: starters.map((s) => ({ key: s.key, name: s.name, description: s.description })),
      };
    },
  },
  {
    name: 'ghl_save_email_template',
    title: 'E-Mail-Vorlage speichern',
    description:
      'Legt eine E-Mail-Vorlage an (ohne id) oder ändert sie. Entweder body (Text oder HTML mit is_html) oder design (Builder-JSON: {settings: {width, background, contentBackground, fontFamily, textColor, linkColor, fontSize, preheader}, sections: [{columns: [{blocks: [{type: heading|text|image|button|divider|spacer|social|video|html|footer, props, style}]}], widths}]}) oder starter (Schlüssel aus ghl_list_email_templates → starters) als Ausgangspunkt. Text-Blöcke: **fett**, *kursiv*, [Link](https://…), Listen mit "- ". Platzhalter wie {{contact.first_name|du}} bleiben erhalten; das HTML rendert der Server.',
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'string' },
        id: { type: 'string', description: 'Vorlage ändern statt neu anlegen' },
        name: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
        is_html: { type: 'boolean' },
        design: { type: 'object' },
        starter: { type: 'string', enum: STARTERS.map((s) => s.key) },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async (call, a) => {
      let design = a.design;
      let subject = a.subject;
      if (!design && a.starter) {
        const st = STARTERS.find((s) => s.key === a.starter);
        if (!st) throw new HttpError(400, 'Unbekannte Startvorlage');
        design = st.build();
        subject ??= st.subject;
      }
      const body: Record<string, unknown> = { channel: 'email' };
      for (const [k, v] of Object.entries({ name: a.name, subject, body: a.body, is_html: a.is_html, design })) if (v !== undefined) body[k] = v;
      if (!a.id && !body.name) throw new HttpError(400, 'name fehlt');
      const saved = a.id ? await call.api('PATCH', `/api/templates/${encodeURIComponent(a.id)}`, { body, location: a.location_id }) : await call.api('POST', '/api/templates', { body, location: a.location_id });
      return { id: saved.id, name: saved.name, subject: saved.subject, has_design: !!saved.design, text: saved.body_text || undefined };
    },
  },
];

export const emailBuilderModule: Module = {
  name: 'email-builder',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE email_sections (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, section TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX email_sections_location ON email_sections(location_id, name);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];

    router.get('/api/email-builder/starters', 'location', () => STARTERS.map((s) => ({ key: s.key, name: s.name, description: s.description, subject: s.subject, design: s.build() })));

    /** Renders a design like the server does on save – for API users and checks before sending. */
    router.post('/api/email-builder/render', 'location', (ctx) => {
      const design = parseDesign(ctx.body.design);
      return { design, html: renderEmailHtml(design), text: renderEmailText(design), issues: designIssues(design, { campaign: !!ctx.body.campaign }) };
    });

    router.post('/api/email-builder/test', 'location', async (ctx) => {
      const loc = app.location(ctx.locationId)!;
      const to = normalizeEmail(str(ctx.body.to, 'Empfänger', { required: true, max: 200 }));
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw bad('Ungültige E-Mail-Adresse');
      const design: EmailDesign = parseDesign(ctx.body.design);
      const t = Date.now();
      const hits = (testHits.get(ctx.locationId) ?? []).filter((x) => t - x < 10 * 60_000);
      if (hits.length >= TEST_LIMIT) throw new HttpError(429, 'Zu viele Testmails – bitte in ein paar Minuten noch einmal');
      testHits.set(ctx.locationId, [...hits, t]);
      const contact = ctx.body.contact_id ? getContact(app, ctx.locationId, String(ctx.body.contact_id)) : undefined;
      if (ctx.body.contact_id && !contact) throw notFound('Kontakt nicht gefunden');
      const vars = { contact: contact ? contactVars(contact) : SAMPLE_CONTACT, location: loc };
      const mail = composeEmail({
        body: render(renderEmailHtml(design), vars, { escape: true }),
        text: render(renderEmailText(design), vars),
        isHtml: true,
        unsubUrl: `${app.baseUrl()}/`,
        company: loc.name,
        address: loc.address,
      });
      try {
        const r = await deliverEmail(loc, { to, subject: `[TEST] ${render(str(ctx.body.subject, 'Betreff', { max: 300 }) || 'Test-E-Mail', vars)}`, html: mail.html, text: mail.text });
        return { ...r, to };
      } catch (e) {
        throw bad(`Versand fehlgeschlagen: ${(e as Error).message}`);
      }
    });

    // --- reusable sections ---------------------------------------------------------------------
    const out = (r: any) => ({ ...r, section: typeof r.section === 'string' ? JSON.parse(r.section) : r.section });
    router.get('/api/email-builder/sections', 'location', (ctx) => parseRows(db.all('SELECT * FROM email_sections WHERE location_id = ? ORDER BY name', ctx.locationId), ['section']));
    router.post('/api/email-builder/sections', 'location', (ctx) => {
      const name = str(ctx.body.name, 'Name', { required: true, max: 120 });
      let section;
      try {
        section = normalizeDesign({ sections: [ctx.body.section] }).sections[0];
      } catch (e) {
        throw bad((e as Error).message);
      }
      if (!section) throw bad('Abschnitt fehlt');
      if ((db.get<{ n: number }>('SELECT COUNT(*) n FROM email_sections WHERE location_id = ?', ctx.locationId)?.n ?? 0) >= 200) throw bad('Höchstens 200 gespeicherte Abschnitte');
      const row = { id: id(), location_id: ctx.locationId, name, section, created_at: now() };
      db.insert('email_sections', row);
      return out(row);
    });
    router.delete('/api/email-builder/sections/:id', 'location', (ctx) => {
      if (!db.run('DELETE FROM email_sections WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId).changes) throw notFound();
      return { ok: true };
    });
  },
};
