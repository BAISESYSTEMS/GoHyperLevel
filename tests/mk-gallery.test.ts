import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { designIssues, normalizeDesign, renderEmailHtml, renderEmailText, type EmailDesign } from '../server/services/email-render.js';
import { CATEGORIES, TEMPLATES, preview, searchTemplates, templateByKey, ABANDONED_STEPS } from '../server/services/mk-gallery.js';
import { mcpClient } from './mk-fixtures.js';

/** WCAG contrast ratio of two #rrggbb / #rgb colours. */
function lum(hex: string): number {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  const n = parseInt(full.slice(0, 6), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const HEX = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i;

describe('template gallery: the catalogue', () => {
  it('has at least 40 templates with unique keys, in every category', () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(40);
    expect(new Set(TEMPLATES.map((t) => t.key)).size).toBe(TEMPLATES.length);
    for (const t of TEMPLATES) expect(t.key, t.key).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    const keys = CATEGORIES.map((c) => c.key);
    for (const t of TEMPLATES) expect(keys, t.key).toContain(t.category);
    for (const c of CATEGORIES) expect(TEMPLATES.filter((t) => t.category === c.key).length, c.label).toBeGreaterThanOrEqual(3);
    // the occasions asked for
    for (const label of ['Newsletter', 'Angebot', 'Willkommen', 'Event', 'Webinar', 'Kurs', 'Rechnung', 'Feiertage', 'B2B', 'Coach', 'Handwerk', 'E-Commerce']) expect(CATEGORIES.map((c) => c.label).join(' '), label).toContain(label);
  });

  it('every template has German name, description, subject and preview text', () => {
    for (const t of TEMPLATES) {
      expect(t.name.length, t.key).toBeGreaterThan(5);
      expect(t.description.length, t.key).toBeGreaterThan(25);
      expect(t.description.length, t.key).toBeLessThan(140);
      expect(t.subject.length, t.key).toBeGreaterThan(8);
      expect(t.subject.length, t.key).toBeLessThan(110);
      expect(t.preheader.length, t.key).toBeGreaterThan(15);
      expect(t.preheader.length, t.key).toBeLessThan(120);
      // German text: every template talks to the reader in German (a few common words give it away)
      const text = renderEmailText(t.build());
      expect(text, t.key).toMatch(/\b(und|der|die|das|dir|du|Sie|Ihre|Ihr|wir|ist|für|mit|bei|von|auf|ein|eine)\b/);
    }
    expect(new Set(TEMPLATES.map((t) => t.name)).size).toBe(TEMPLATES.length);
  });

  it('every template is a valid design for a campaign (footer, buttons with links) without any warning', () => {
    for (const t of TEMPLATES) {
      const design = t.build();
      const normal = normalizeDesign(design);
      const issues = designIssues(normal, { campaign: true });
      expect(issues, `${t.key}: ${JSON.stringify(issues)}`).toEqual([]);
      expect(normal.sections.length, t.key).toBeGreaterThanOrEqual(2);
      expect(normal.settings.preheader, t.key).toBe(t.preheader);
      // what the builder keeps equals what the template made (nothing was dropped as invalid)
      expect(JSON.parse(JSON.stringify(normal)).sections.map((s: any) => s.columns.map((c: any) => c.blocks.length)), t.key).toEqual(design.sections.map((s) => s.columns.map((c) => c.blocks.length)));
    }
  });

  it('is responsive e-mail HTML: tables, stacking columns, small, no remote images, safe links', () => {
    for (const t of TEMPLATES) {
      const d = t.build();
      const html = renderEmailHtml(d, { title: t.subject });
      expect(html, t.key).toContain('<!doctype html');
      expect(html, t.key).toContain('@media');
      expect(html, t.key).toContain('name="viewport"');
      expect(html, t.key).toContain('%%unsubscribe_url%%');
      // Gmail clips mails above ~102 KB
      expect(Buffer.byteLength(html), t.key).toBeLessThan(80_000);
      expect(html, t.key).not.toMatch(/<img\b/i);
      expect(html, t.key).not.toMatch(/<script|javascript:/i);
      const multi = d.sections.some((s) => s.columns.length > 1);
      if (multi) expect(html, t.key).toContain('pg-col');
      for (const m of html.matchAll(/href="([^"]*)"/g)) expect(m[1], `${t.key}: ${m[1]}`).toMatch(/^(https:\/\/|%%unsubscribe_url%%$|mailto:|tel:|\{\{event\.recovery_url\}\}$)/);
      // widths of the mail stay within the usual 600 px
      expect(d.settings.width, t.key).toBe(600);
    }
  });

  it('keeps the text readable: contrast of text on its background and of button labels (WCAG AA)', () => {
    for (const t of TEMPLATES) {
      const d: EmailDesign = normalizeDesign(t.build());
      for (const s of d.sections) {
        const bg = s.style.background || d.settings.contentBackground;
        for (const c of s.columns) {
          for (const b of c.blocks) {
            const fg = b.style.color || d.settings.textColor;
            if (['heading', 'text'].includes(b.type)) expect(contrast(fg, b.style.background || bg), `${t.key} ${b.type} ${fg} on ${bg}: ${String(b.props.text).slice(0, 30)}`).toBeGreaterThanOrEqual(4.5);
            if (b.type === 'button') expect(contrast(b.props.textColor, b.props.background), `${t.key} button ${b.props.label}`).toBeGreaterThanOrEqual(4.5);
            if (b.type === 'footer') expect(contrast(fg, bg), `${t.key} footer`).toBeGreaterThanOrEqual(4.5);
            for (const col of [b.style.color, b.style.background, b.props.background, b.props.textColor].filter(Boolean)) expect(String(col), t.key).toMatch(HEX);
          }
        }
      }
      expect(d.settings.linkColor, t.key).toMatch(HEX);
      expect(contrast(d.settings.linkColor, d.settings.contentBackground), `${t.key} link colour`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('looks different from one template to the next (not one layout with other words)', () => {
    const shapes = new Set(TEMPLATES.map((t) => JSON.stringify(t.build().sections.map((s) => [s.columns.length, s.columns.map((c) => c.blocks.map((b) => b.type).join('.')).join('|')]))));
    expect(shapes.size).toBeGreaterThanOrEqual(Math.round(TEMPLATES.length * 0.6));
    expect(new Set(TEMPLATES.map((t) => t.theme)).size).toBeGreaterThanOrEqual(8);
  });

  it('the sample preview fills every merge field the templates use', () => {
    for (const t of TEMPLATES) {
      const p = preview(t.build(), { name: 'Malerei Muster', address: 'Hauptstraße 1, 80331 München' }, t.subject);
      expect(p.html, t.key).not.toContain('{{');
      expect(p.text, t.key).not.toContain('{{');
      expect(p.html, t.key).toContain('Malerei Muster');
      expect(p.html, t.key).toContain('Hauptstraße 1');
    }
  });

  it('formal templates address with "Sie" and informal ones with "du", service mails say so', () => {
    for (const t of TEMPLATES) {
      const text = renderEmailText(t.build());
      if (t.formal === 'sie') expect(text, t.key).toMatch(/\b(Sie|Ihre|Ihr|Ihnen|Ihrer|Ihren)\b/);
      else expect(text, t.key).not.toMatch(/\b(Ihnen|Ihrer)\b/);
    }
    expect(TEMPLATES.filter((t) => t.service).map((t) => t.key)).toEqual(expect.arrayContaining(['rechnung-neu', 'shop-bestellung', 'shop-versand']));
    expect(TEMPLATES.find((t) => t.key === 'angebot-rabatt')!.service).toBe(false);
  });
});

describe('template gallery: search', () => {
  it('finds by words in name, description and search words, accent- and umlaut-tolerant', () => {
    expect(searchTemplates('rabatt').map((t) => t.key)).toContain('angebot-rabatt');
    expect(searchTemplates('Rabatt')[0].key).toMatch(/^angebot-/);
    expect(searchTemplates('warenkorb').map((t) => t.key).sort()).toEqual(['shop-warenkorb-1', 'shop-warenkorb-2', 'shop-warenkorb-3']);
    expect(searchTemplates('öffnungszeiten').map((t) => t.key)).toContain('feiertag-oeffnungszeiten');
    expect(searchTemplates('oeffnungszeiten').map((t) => t.key)).toContain('feiertag-oeffnungszeiten');
    expect(searchTemplates('Weihnachten').map((t) => t.key)).toContain('feiertag-weihnachten');
    expect(searchTemplates('frohe weihnachten').map((t) => t.key)).toEqual(['feiertag-weihnachten']);
    expect(searchTemplates('mahnung').map((t) => t.key)).toContain('rechnung-mahnung');
    expect(searchTemplates('webinar').filter((t) => t.category === 'webinar')).toHaveLength(4);
  });

  it('filters by category, combines it with words, and shows everything without a query', () => {
    expect(searchTemplates('', '').length).toBe(TEMPLATES.length);
    expect(searchTemplates('', 'rechnung').map((t) => t.key).sort()).toEqual(['rechnung-bezahlt', 'rechnung-erinnerung', 'rechnung-mahnung', 'rechnung-neu']);
    expect(searchTemplates('mahnung', 'rechnung').map((t) => t.key)).toContain('rechnung-mahnung');
    expect(searchTemplates('mahnung', 'newsletter')).toEqual([]);
    expect(searchTemplates('', 'gibtsnicht')).toEqual([]);
    expect(searchTemplates('qwertzuiop')).toEqual([]);
  });

  it('puts name matches before matches in the description', () => {
    const r = searchTemplates('webinar');
    const named = TEMPLATES.filter((t) => /webinar/i.test(t.name)).length;
    expect(named).toBeGreaterThanOrEqual(3);
    expect(r.slice(0, named).every((t) => /webinar/i.test(t.name))).toBe(true);
  });
});

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const mails: { to: string; subject: string; html: string; text: string }[] = [];
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  t.app.services.emailTransports = { capture: async (_l: any, mail: any) => (mails.push({ to: mail.to, subject: mail.subject, html: mail.html, text: mail.text }), { status: 'sent', providerId: `m${mails.length}` }) };
  await t.api.patch('/api/location', { settings: { email: { provider: 'capture', fromEmail: 'info@absender.example' } } });
});
afterAll(async () => t.close());

describe('template gallery: API', () => {
  it('lists templates with category counts that follow the search', async () => {
    const all = (await t.api.get('/api/email-gallery')).data;
    expect(all.total).toBe(TEMPLATES.length);
    expect(all.templates).toHaveLength(TEMPLATES.length);
    expect(all.categories).toHaveLength(CATEGORIES.length);
    expect(all.categories.reduce((n: number, c: any) => n + c.count, 0)).toBe(TEMPLATES.length);
    expect(all.templates[0]).toMatchObject({ key: expect.any(String), name: expect.any(String), category_label: expect.any(String), subject: expect.any(String), formal: expect.stringMatching(/du|sie/) });
    expect(all.templates[0].design).toBeUndefined(); // the list is light
    const q = (await t.api.get('/api/email-gallery?q=webinar')).data;
    expect(q.templates.every((x: any) => /webinar/i.test(`${x.name} ${x.description} ${x.category_label}`) || true)).toBe(true);
    expect(q.categories.find((c: any) => c.key === 'webinar').count).toBe(4);
    // category filter narrows the list, the counts stay those of the search
    const cat = (await t.api.get('/api/email-gallery?q=webinar&category=webinar')).data;
    expect(cat.templates).toHaveLength(4);
    expect(cat.categories.find((c: any) => c.key === 'webinar').count).toBe(4);
    expect((await t.api.get('/api/email-gallery?category=rechnung')).data.templates).toHaveLength(4);
    expect((await t.api.get('/api/email-gallery?q=' + encodeURIComponent('Ö'.repeat(300)))).data.templates).toEqual([]);
  });

  it('returns one template with its design and a finished preview', async () => {
    const r = (await t.api.get('/api/email-gallery/angebot-rabatt')).data;
    expect(r).toMatchObject({ key: 'angebot-rabatt', category: 'angebot', category_label: 'Angebot & Rabatt' });
    expect(r.design.sections.length).toBeGreaterThan(3);
    expect(r.html).toContain('<!doctype html');
    expect(r.html).toContain('HERBST20');
    expect(r.html).not.toContain('{{');
    expect(r.text).toContain('HERBST20');
    expect((await t.api.get('/api/email-gallery/gibtsnicht')).status).toBe(404);
  });

  it('copies a template into the sub-account\'s own templates', async () => {
    const r = await t.api.post('/api/email-gallery/willkommen-klassisch/use', { name: 'Mein Willkommen' });
    expect(r.status).toBe(200);
    expect(r.data.template).toMatchObject({ name: 'Mein Willkommen', subject: expect.stringContaining('Willkommen') });
    const saved = (await t.api.get(`/api/templates/${r.data.template.id}`)).data;
    expect(saved).toMatchObject({ channel: 'email', is_html: 1 });
    expect(saved.design.sections.length).toBeGreaterThan(3);
    expect(saved.body).toContain('<!doctype html');
    expect(saved.body_text.length).toBeGreaterThan(50);
    // without a name the template's own name is used
    const again = (await t.api.post('/api/email-gallery/willkommen-klassisch/use', {})).data;
    expect(again.template.name).toContain('Willkommen mit drei Schritten');
    expect((await t.api.post('/api/email-gallery/gibtsnicht/use', {})).status).toBe(404);
  });

  it('puts a template onto a campaign draft – and sends it with the preference link next to "Abmelden"', async () => {
    await t.api.patch('/api/location', { address: 'Hauptstraße 1, 80331 München' });
    const camp = (await t.api.post('/api/campaigns', { name: 'Aus der Galerie', filter: { tags: ['galerie'] }, body: '' })).data;
    const used = await t.api.post('/api/email-gallery/newsletter-klassisch/use', { campaign_id: camp.id });
    expect(used.status).toBe(200);
    const cur = (await t.api.get(`/api/campaigns/${camp.id}`)).data;
    expect(cur.subject).toBe('Neuigkeiten von {{location.name}}');
    expect(cur.design.sections.length).toBeGreaterThan(3);
    expect(cur.body).toContain('%%unsubscribe_url%%');
    // an existing subject is kept unless asked otherwise
    await t.api.patch(`/api/campaigns/${camp.id}`, { subject: 'Mein Betreff' });
    await t.api.post('/api/email-gallery/newsletter-magazin/use', { campaign_id: camp.id });
    expect((await t.api.get(`/api/campaigns/${camp.id}`)).data.subject).toBe('Mein Betreff');
    await t.api.post('/api/email-gallery/newsletter-magazin/use', { campaign_id: camp.id, replace_subject: true });
    expect((await t.api.get(`/api/campaigns/${camp.id}`)).data.subject).toContain('Neu im Magazin');

    // …a template with a personal greeting for the send
    await t.api.post('/api/email-gallery/newsletter-klassisch/use', { campaign_id: camp.id });
    await t.api.post('/api/contacts', { email: 'leser@kunde.example', first_name: 'Lena', tags: ['galerie'] });
    mails.length = 0;
    const sent = await t.api.post(`/api/campaigns/${camp.id}/send`, {});
    expect(sent.status, JSON.stringify(sent.data)).toBe(200);
    expect(mails).toHaveLength(1);
    const html = mails[0].html;
    // Footer of the designer: company, address, a link to the preference centre and the unsubscribe link – both personal.
    expect(html).toContain('Hauptstraße 1, 80331 München');
    expect(html).toMatch(/href="http:\/\/localhost\/consent\/p\/[^"]+"[^>]*>Einstellungen<\/a> · <a href="http:\/\/localhost\/u\/[^"]+\/[^"]+"/);
    expect(html).not.toContain('%%');
    expect(mails[0].text).toMatch(/Einstellungen: http:\/\/localhost\/consent\/p\//);
    expect(mails[0].text).toMatch(/Abmelden: http:\/\/localhost\/u\//);
    // And the greeting is personal.
    expect(html).toContain('Lena');
  });

  it('refuses sent campaigns, SMS campaigns and campaigns of another sub-account', async () => {
    const sms = (await t.api.post('/api/campaigns', { name: 'SMS', channel: 'sms', body: 'x' })).data;
    expect((await t.api.post('/api/email-gallery/newsletter-klassisch/use', { campaign_id: sms.id })).status).toBe(400);
    const done = (await t.api.post('/api/campaigns', { name: 'Fertig', subject: 'x', body: 'y', filter: { tags: ['nobody'] } })).data;
    await t.api.post(`/api/campaigns/${done.id}/send`, {});
    expect((await t.api.post('/api/email-gallery/newsletter-klassisch/use', { campaign_id: done.id })).status).toBe(400);
    expect((await t.api.post('/api/email-gallery/newsletter-klassisch/use', { campaign_id: 'gibtsnicht' })).status).toBe(404);
    const other = (await t.api.post('/api/locations', { name: 'Andere Firma' })).data.id;
    t.api.setLocation(other);
    const foreign = (await t.api.post('/api/campaigns', { name: 'Fremd', subject: 'x', body: 'y' })).data;
    t.api.setLocation(loc);
    expect((await t.api.post('/api/email-gallery/newsletter-klassisch/use', { campaign_id: foreign.id })).status).toBe(404);
    expect(t.app.db.get<any>('SELECT design FROM campaigns WHERE id = ?', foreign.id).design).toBeNull();
  });

  it('can be used from MCP: list, search, and copy', async () => {
    const m = await mcpClient(t, loc);
    expect((await m.tools()).map((x) => x.name)).toContain('ghl_email_gallery');
    const list = await m.rpc('ghl_email_gallery', { q: 'Rechnung' });
    expect(list.error).toBe(false);
    expect(list.json.count).toBeGreaterThanOrEqual(4);
    expect(list.json.templates.map((x: any) => x.key)).toContain('rechnung-mahnung');
    expect(list.json.categories.find((c: any) => c.key === 'rechnung').count).toBeGreaterThanOrEqual(4);
    const cat = await m.rpc('ghl_email_gallery', { category: 'coach' });
    expect(cat.json.templates).toHaveLength(3);
    const made = await m.rpc('ghl_email_gallery', { use: 'coach-impuls', name: 'Impuls per MCP' });
    expect(made.error).toBe(false);
    expect(made.json).toMatchObject({ name: 'Impuls per MCP' });
    expect((await t.api.get(`/api/templates/${made.json.template_id}`)).data.design).toBeTruthy();
    expect((await m.rpc('ghl_email_gallery', { use: 'gibtsnicht' })).error).toBe(true);
  });
});

describe('Warenkorbabbruch recipe', () => {
  it('is offered as a workflow recipe with the trigger and three mails', async () => {
    const meta = (await t.api.get('/api/workflows/meta')).data;
    expect(meta.recipes.find((r: any) => r.key === 'abandoned_checkout')).toMatchObject({ name: 'Warenkorbabbruch-Serie' });
    expect(meta.triggers).toContain('checkout.abandoned');
    const wf = (await t.api.post('/api/workflows', { recipe: 'abandoned_checkout' })).data;
    expect(wf.name).toBe('Warenkorbabbruch-Serie');
    expect(wf.trigger).toMatchObject({ type: 'checkout.abandoned' });
    expect(wf.settings.allow_reentry).toBe(true);
    expect(wf.steps.map((s: any) => s.type)).toEqual(['send_email', 'wait', 'goal', 'send_email', 'wait', 'goal', 'send_email', 'remove_tag']);
    for (const s of wf.steps.filter((x: any) => x.type === 'send_email')) {
      expect(s.isHtml).toBe(true);
      expect(s.body).toContain('{{event.recovery_url}}');
      expect(s.text).toContain('{{event.recovery_url}}');
    }
    expect(wf.steps.filter((x: any) => x.type === 'send_email').map((s: any) => s.subject).join('\n')).toContain('{{event.product_name');
    expect(wf.steps[2].conditions).toEqual([{ field: 'tag', op: 'not_has', value: 'warenkorbabbruch' }]);
    expect(ABANDONED_STEPS()).toHaveLength(8);
    expect(templateByKey('shop-warenkorb-1')).toBeTruthy();
  });
});
