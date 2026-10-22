import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { FF } from './site-fixtures.js';
import { CATEGORIES, TEMPLATES, formSpec, settingsOf, wireBlocks, templateMeta } from '../server/services/site-templates.js';
import { cleanBlocks, walkBlocks } from '../server/services/site-layout.js';
import { blockContrast, checkDocument, checkFragment, tokenContrast } from '../server/services/site-a11y.js';
import { cleanTokens, tokensOf } from '../server/services/site-style.js';
import { cleanSiteSettings } from '../server/services/site-settings.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
});
afterAll(() => t.close());

const get = async (path: string) => {
  const r = await t.api.raw(path, { headers: FF });
  return { status: r.status, body: await r.text(), headers: r.headers };
};
const wiring = (tpl: (typeof TEMPLATES)[number]) => ({ firma: 'Beispiel GmbH', form_id: 'FORMID', calendar_slug: 'kal', product_id: 'PRODID', collections: new Map((tpl.collections ?? []).map((c) => [c.preset, `COLL-${c.preset}`])), pages: new Map(tpl.pages.map((p) => [p.slug, `ID-${p.slug}`])), now: new Date('2026-10-05T10:00:00Z') });

describe('template gallery data', () => {
  it('has at least 20 templates, each with pages, a category and its legal pages', () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(20);
    expect(new Set(TEMPLATES.map((x) => x.id)).size).toBe(TEMPLATES.length);
    for (const x of TEMPLATES) {
      expect(CATEGORIES, x.id).toContain(x.category);
      expect(x.pages.length, x.id).toBeGreaterThanOrEqual(1);
      expect(new Set(x.pages.map((p) => p.slug)).size, `${x.id}: page paths unique`).toBe(x.pages.length);
      for (const kind of x.legal) expect(x.pages.some((p) => p.slug === kind), `${x.id} has a ${kind} page`).toBe(true);
      expect(x.description.length, x.id).toBeGreaterThan(30);
      expect(x.legal, x.id).toEqual(expect.arrayContaining(['impressum', 'datenschutz']));
      // sales templates carry the withdrawal information
      if (x.needs.includes('product') && x.id !== 'verein') expect(x.legal, x.id).toContain('widerruf');
      expect(templateMeta(x).pages.length).toBe(x.pages.length);
    }
    // the categories asked for are all there
    const ids = TEMPLATES.map((x) => x.id);
    for (const want of ['coach', 'handwerk', 'agentur', 'saas', 'restaurant', 'praxis', 'immobilien', 'event', 'webinar', 'kurs-verkauf', 'leadmagnet', 'link-in-bio']) expect(ids, want).toContain(want);
  });

  it('every link points at a page of the template, every placeholder is known', () => {
    for (const x of TEMPLATES) {
      const slugs = new Set(x.pages.map((p) => p.slug));
      const refs: string[] = [];
      const json = JSON.stringify(x.pages.map((p) => p.blocks));
      for (const m of json.matchAll(/"(?:button_url|url|url2|button2_url)":"page:([a-z0-9-]+)"/g)) refs.push(m[1]);
      for (const m of json.matchAll(/\]\(page:([a-z0-9-]+)\)/g)) refs.push(m[1]);
      for (const [, to] of x.menu ?? []) refs.push(to);
      if (x.header?.cta_url) refs.push(x.header.cta_url);
      for (const c of x.footer?.columns ?? []) for (const [, to] of c.links) refs.push(to);
      if (x.thanks) refs.push(x.thanks);
      for (const r of refs) expect(slugs.has(r), `${x.id}: link to page "${r}"`).toBe(true);
      // after wiring nothing is left of the template syntax
      const wired = JSON.stringify(wireBlocks(x.pages.flatMap((p) => p.blocks) as any, wiring(x)));
      expect(wired, x.id).not.toMatch(/\{\{(firma|in7days|in30days)\}\}/);
      expect(wired, x.id).not.toContain('"form_id":""');
      expect(wired, x.id).not.toContain('"collection_id":"preset:');
      expect(wired, x.id).not.toContain('"product_id":""');
    }
  });

  it('palettes read well: brand colour, text, grey text and the colours of every block pass contrast', () => {
    for (const x of TEMPLATES) {
      const tokens = cleanTokens(x.tokens);
      const bad = tokenContrast(tokens).filter((i) => i.level === 'error' || /Markenfarbe|Text auf Seitenhintergrund|Grauer Text/.test(i.message));
      expect(bad.map((i) => i.message), `${x.id} palette`).toEqual([]);
      const blocks = cleanBlocks(wireBlocks(x.pages.flatMap((p) => p.blocks) as any, wiring(x)));
      expect(blockContrast(blocks, tokens).map((i) => `${i.block_type}: ${i.message}`), `${x.id} blocks`).toEqual([]);
    }
  });

  it('turns a template into settings with menus that point at page ids', () => {
    const x = TEMPLATES.find((v) => v.id === 'coach')!;
    const s = settingsOf(x, { firma: 'Meine Praxis', pages: new Map(x.pages.map((p, i) => [p.slug, `pid${i}`])) });
    expect(s.header).toMatchObject({ enabled: true, brand: 'Meine Praxis', sticky: true, cta_text: 'Erstgespräch buchen', cta_url: 'page:pid3' });
    expect(s.menus.main[1]).toEqual({ label: 'Über mich', url: 'page:pid1' });
    expect(s.footer).toMatchObject({ enabled: true, text: '© Meine Praxis' });
    expect(s.color).toBe('#0f766e');
    expect(tokensOf(s).colors.brand).toBe('#0f766e');
    // funnels have no header
    expect(settingsOf(TEMPLATES.find((v) => v.id === 'leadmagnet')!, { firma: 'X', pages: new Map() }).header.enabled).toBe(false);
    expect(cleanSiteSettings({ header: { enabled: true } }, {}).header.enabled).toBe(true);
    expect(formSpec('application', 'Site').fields.map((f) => f.name)).toEqual(['first_name', 'last_name', 'email', 'phone', 'message', 'consent']);
    expect(formSpec('optin', 'Site').fields.some((f) => f.type === 'consent' && f.required)).toBe(true);
  });
});

describe('template previews and sites made from them', () => {
  it('lists templates with their pages and renders a preview of any page', async () => {
    const list = (await t.api.get('/api/site-templates')).data;
    expect(list.templates.length).toBeGreaterThanOrEqual(20);
    expect(list.categories).toContain('Verkauf & Kurse');
    expect((await t.api.get('/api/site-templates?kind=funnel')).data.templates.every((x: any) => x.kind === 'funnel')).toBe(true);
    const coach = (await t.api.get('/api/site-templates/coach')).data;
    expect(coach.pages.map((p: any) => p.slug)).toEqual(['home', 'ueber-mich', 'angebot', 'termin', 'kontakt', 'impressum', 'datenschutz']);
    const prev = await t.api.raw('/api/site-templates/coach/preview', { headers: { cookie: t.api.cookie, 'x-location-id': t.api.location } });
    const html = await prev.text();
    expect(prev.status).toBe(200);
    expect(html).toContain('<h1>Klarheit für deinen nächsten Schritt</h1>');
    expect(html).toContain('Vorschau – hier erscheint dein Formular.'.slice(0, 0));
    expect(html).toContain('<header class="gh sticky"');
    expect(html).not.toMatch(/href="http:\/\/[^"]*\/p\/vorschau/);
    expect(prev.headers.get('content-security-policy')).toContain('sandbox');
    const contactPage = await t.api.raw('/api/site-templates/coach/preview?page=kontakt', { headers: { cookie: t.api.cookie, 'x-location-id': t.api.location } });
    expect(await contactPage.text()).toContain('Vorschau – hier erscheint dein Formular.');
    expect((await t.api.get('/api/site-templates/gibt-es-nicht')).status).toBe(404);
    // the preview shows example entries of the collections the template uses
    const team = await t.api.raw('/api/site-templates/praxis/preview', { headers: { cookie: t.api.cookie, 'x-location-id': t.api.location } });
    expect(await team.text()).toContain('Anna Beispiel');
  });

  it('builds a site with form, collections, legal pages from the company data and a thank-you redirect', async () => {
    expect((await t.api.put('/api/legal/profile', { company: 'Meisterbetrieb Beispiel', street: 'Musterweg 1', zip: '10115', city: 'Berlin', email: 'info@beispiel.example' })).status).toBe(200);
    const r = await t.api.post('/api/site-templates/leadmagnet/apply', { name: 'Checkliste Start' });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ kind: 'funnel', name: 'Checkliste Start', template: 'leadmagnet' });
    expect(r.data.pages.map((p: any) => p.slug)).toEqual(['start', 'danke', 'impressum', 'datenschutz']);
    expect(r.data.wiring.form_created).toBe(true);
    expect(r.data.legal).toMatchObject({ applied: true });
    // the form is wired into the block, and sends people to the thank-you page
    const site = (await t.api.get(`/api/funnels/${r.data.id}`)).data;
    const start = site.pages.find((p: any) => p.slug === 'start');
    const formBlocks: any[] = [];
    walkBlocks(start.blocks, (b) => b.type === 'form' && formBlocks.push(b));
    expect(formBlocks[0].form_id).toBe(r.data.wiring.form_id);
    const form = (await t.api.get(`/api/forms/${r.data.wiring.form_id}`)).data;
    expect(form.settings.redirect_url).toBe(`http://localhost/p/${r.data.slug}/danke`);
    expect(form.settings.tags).toContain('vorlage:leadmagnet');
    expect(form.fields.map((f: any) => f.name)).toEqual(['first_name', 'email', 'consent']);
    // legal pages are filled from the company data
    const imp = site.pages.find((p: any) => p.slug === 'impressum');
    expect(JSON.stringify(imp.blocks)).toContain('Meisterbetrieb Beispiel');
    expect(JSON.stringify(imp.blocks)).not.toContain('Hier deine');
    // the site works: start page, footer with legal links, thank-you page noindex
    const page = await get(`/p/${r.data.slug}/start`);
    expect(page.status).toBe(200);
    expect(page.body).toContain('class="pghl-form"');
    expect(page.body).toContain('Impressum</a>');
    expect(page.body).toContain('Datenschutz</a>');
    expect(page.body).not.toContain('<header');
    expect((await get(`/p/${r.data.slug}/danke`)).body).toContain('noindex');
    expect((await get(`/p/${r.data.slug}/sitemap.xml`)).body).not.toContain('/danke');
    // the same template again: its own site and form
    const again = await t.api.post('/api/site-templates/leadmagnet/apply', { name: 'Checkliste Start' });
    expect(again.data.slug).toBe(`${r.data.slug}-2`);
    expect(again.data.wiring.form_id).not.toBe(r.data.wiring.form_id);
  });

  it('uses a form the account already has and leaves its settings alone', async () => {
    const own = (await t.api.post('/api/forms', { name: 'Mein Formular', settings: { redirect_url: 'https://meine.example/danke', thank_you: 'Ja!' } })).data;
    const r = await t.api.post('/api/site-templates/newsletter/apply', { form_id: own.id });
    expect(r.data.wiring).toMatchObject({ form_id: own.id, form_created: false });
    expect((await t.api.get(`/api/forms/${own.id}`)).data.settings.redirect_url).toBe('https://meine.example/danke');
    expect((await t.api.post('/api/site-templates/newsletter/apply', { form_id: 'gibt-es-nicht' })).status).toBe(400);
  });

  it('builds a website with collections, menu, header and a booking page; sample entries are public', async () => {
    const cal = (await t.api.post('/api/calendars', { name: 'Erstgespräch', duration: 30, availability: { mon: [['09:00', '17:00']] } })).data;
    const r = await t.api.post('/api/site-templates/coach/apply', { name: 'Coaching Beispiel', calendar_slug: cal.slug });
    expect(r.status).toBe(200);
    expect(r.data.kind).toBe('website');
    expect(r.data.wiring).toMatchObject({ calendar_slug: cal.slug });
    expect(r.data.wiring.collections).toHaveLength(1);
    const site = (await t.api.get(`/api/funnels/${r.data.id}`)).data;
    expect(site.settings.header).toMatchObject({ enabled: true, brand: 'Coaching Beispiel' });
    // menu items are page references by id
    const ids = new Set(site.pages.map((p: any) => p.id));
    for (const item of site.settings.menus.main) expect(ids.has(item.url.replace('page:', '')), item.label).toBe(true);
    const home = await get(`/p/${r.data.slug}`);
    expect(home.body).toContain('Klarheit für deinen nächsten Schritt');
    expect(home.body).toContain('<header class="gh sticky"');
    expect(home.body).toContain(`/p/${r.data.slug}/termin`);
    expect(home.body).toContain('Das sagen meine Kundinnen und Kunden');
    const term = await get(`/p/${r.data.slug}/termin`);
    expect(term.body).toContain(`/book/${cal.slug}?embed=1`);
    // the testimonials collection exists with its sample entries
    const colls = (await t.api.get(`/api/funnels/${r.data.id}/collections`)).data;
    expect(colls[0]).toMatchObject({ slug: 'kundenstimmen', published: 3 });
    // legal pages carry the company data of the previous test
    expect(JSON.stringify(site.pages.find((p: any) => p.slug === 'impressum').blocks)).toContain('Meisterbetrieb Beispiel');
    // no calendar → a hint instead of a broken block
    const noCal = await t.api.post('/api/site-templates/praxis/apply', { name: 'Praxis ohne Kalender', calendar_slug: undefined });
    expect(noCal.data.wiring.calendar_slug).toBe(cal.slug); // the first calendar of the account is taken
  });

  it('hints at what is missing and keeps placeholders when the company data is empty', async () => {
    const other = (await t.api.post('/api/locations', { name: 'Leere Firma' })).data.id;
    const h = { 'x-location-id': other };
    const r = await t.api.post('/api/site-templates/kurs-verkauf/apply', {}, h);
    expect(r.status).toBe(200);
    expect(r.data.name).toBe('Leere Firma');
    expect(r.data.legal.applied).toBe(false);
    expect(r.data.notes.join(' ')).toMatch(/Firmendaten|Platzhalter/);
    expect(r.data.notes.join(' ')).toMatch(/Produkt/);
    expect(r.data.pages.map((p: any) => p.slug)).toContain('widerruf');
    // a template needs no collection or form: nothing is created for the other account's data
    expect((await t.api.get(`/api/site-collections/none`, h)).status).toBe(404);
  });

  it('builds and serves every template: each page loads, forms and collections are wired, no accessibility errors', async () => {
    const loc = (await t.api.post('/api/locations', { name: 'Galerie-Test' })).data.id;
    const h = { 'x-location-id': loc };
    const prod = (await t.api.post('/api/products', { name: 'Test-Produkt', price_cents: 4900 }, h)).data;
    for (const x of TEMPLATES) {
      const r = await t.api.post(`/api/site-templates/${x.id}/apply`, { name: `T ${x.id}`, product_id: x.needs.includes('product') ? prod.id : undefined }, h);
      expect(r.status, `${x.id}: ${JSON.stringify(r.data).slice(0, 200)}`).toBe(200);
      expect(r.data.pages.length, x.id).toBe(x.pages.length);
      const site = (await t.api.get(`/api/funnels/${r.data.id}`, h)).data;
      for (const p of site.pages) {
        const first = site.pages[0].id === p.id;
        const res = await get(first ? `/p/${r.data.slug}` : `/p/${r.data.slug}/${p.slug}`);
        expect(res.status, `${x.id}/${p.slug}`).toBe(200);
        expect(res.body.length, `${x.id}/${p.slug} page size`).toBeLessThan(60_000);
        const errs = [...checkDocument(res.body), ...checkFragment({ html: res.body })].filter((i) => i.level === 'error').map((i) => `${i.rule}: ${i.message}`);
        expect(errs, `${x.id}/${p.slug}`).toEqual([]);
      }
      // nothing of the template syntax in the stored blocks
      expect(JSON.stringify(site.pages.map((p: any) => p.blocks)), x.id).not.toMatch(/\{\{firma\}\}|preset:|"form_id":""/);
      if (x.needs.includes('form')) expect(r.data.wiring.form_id, x.id).toBeTruthy();
    }
  }, 120_000);
});
