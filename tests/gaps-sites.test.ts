import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { buildSchema, checkSeo, faqOf, schemaScript, seoScore, siteSeoIssues } from '../server/services/site-seo.js';
import { fillUrlParams } from '../server/modules/site-dyntext.js';
import { cleanFamily, fontCss, fontFormat } from '../server/modules/site-fonts.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
});
afterAll(() => t.close());

const newSite = async (name: string) => (await t.api.post('/api/funnels', { name, kind: 'website' })).data;
const visit = async (path: string, init: RequestInit = {}) => {
  const r = await t.api.raw(path, { redirect: 'manual', ...init });
  return { status: r.status, html: await r.text(), headers: r.headers };
};

describe('SEO check (pure)', () => {
  it('finds missing title, description, h1, alt texts and thin pages', () => {
    const { facts, issues } = checkSeo('<html><head><title></title></head><body><img src="a.png"><p>kurz</p></body></html>');
    const rules = issues.map((i) => i.rule);
    expect(rules).toEqual(expect.arrayContaining(['title_missing', 'description_missing', 'h1_missing', 'img_alt', 'thin', 'schema']));
    expect(facts.images_without_alt).toBe(1);
    expect(issues[0].level).toBe('error');
    expect(seoScore(issues)).toBeLessThan(60);
  });
  it('a good page scores high; duplicates across pages are reported', () => {
    const words = Array.from({ length: 320 }, (_, i) => `Wort${i} text`).join(' ');
    const page = `<html><head><title>Malermeister in Köln – Angebot in 24 Stunden</title><meta name="description" content="Wir streichen Wohnungen und Büros in Köln: sauber, schnell und zum Festpreis. Jetzt kostenlos anfragen."><meta property="og:image" content="https://x/y.png"><script type="application/ld+json">{}</script></head><body><h1>Maler</h1><img src="a" alt="Team"><a href="/kontakt">Kontakt</a><p>${words}</p></body></html>`;
    const r = checkSeo(page, { host: 'example.de' });
    expect(r.issues).toEqual([]);
    expect(seoScore(r.issues)).toBe(100);
    expect(siteSeoIssues([{ name: 'A', facts: r.facts }, { name: 'B', facts: r.facts }]).map((i) => i.rule)).toEqual(['title_duplicate', 'description_duplicate']);
  });
  it('builds JSON-LD, reads FAQ blocks and cannot break out of the script tag', () => {
    const blocks = [{ type: 'section', children: [{ type: 'faq', items: [{ q: 'Was kostet es?', a: 'Nichts </script><b>' }] }] }];
    expect(faqOf(blocks)).toHaveLength(1);
    const faq = buildSchema('FAQPage', {}, { url: 'https://x.de/', blocks })!;
    expect((faq.mainEntity as any[])[0].name).toBe('Was kostet es?');
    expect(schemaScript(faq)).not.toContain('</script><b>');
    expect(buildSchema('Event', { name: 'Webinar' }, { url: 'https://x.de/' })).toBeNull();
    const lb = buildSchema('LocalBusiness', { name: 'Maler Müller', city: 'Köln', opening_hours: 'Mo-Fr 09:00-18:00', image: 'javascript:alert(1)' }, { url: 'https://x.de/' })!;
    expect(lb.address).toMatchObject({ addressLocality: 'Köln', addressCountry: 'DE' });
    expect(lb.image).toBeUndefined();
    expect(buildSchema('Product', { name: 'Kurs', price: '49,00' }, { url: 'https://x.de/' })!.offers).toMatchObject({ price: '49.00', priceCurrency: 'EUR' });
  });
});

describe('SEO check and structured data (API)', () => {
  it('reports per page, stores a schema and serves it in the page head; MCP tools exist', async () => {
    const f = await newSite('SEO Seite');
    const r = await t.api.get(`/api/funnels/${f.id}/seo`);
    expect(r.status).toBe(200);
    expect(r.data.pages.length).toBe(f.pages.length);
    expect(r.data.pages[0].issues.some((i: any) => i.rule === 'description_missing')).toBe(true);
    const home = f.pages[0];
    const s0 = await t.api.get(`/api/funnel-pages/${home.id}/schema`);
    expect(s0.data.saved).toBe(false);
    expect(s0.data.suggestion.type).toBe('LocalBusiness');
    expect((await t.api.put(`/api/funnel-pages/${home.id}/schema`, { type: 'Event', data: {} })).status).toBe(400);
    const put = await t.api.put(`/api/funnel-pages/${home.id}/schema`, { type: 'LocalBusiness', data: { name: 'Testfirma', city: 'Berlin' } });
    expect(put.status).toBe(200);
    expect(put.data.json['@type']).toBe('LocalBusiness');
    const page = await visit(`/p/${f.slug}`);
    expect(page.html).toContain('application/ld+json');
    expect(page.html).toContain('"addressLocality":"Berlin"');
    const after = await t.api.get(`/api/funnels/${f.id}/seo?page=${home.id}`);
    expect(after.data.pages[0].schema_type).toBe('LocalBusiness');
    expect(after.data.pages[0].issues.some((i: any) => i.rule === 'schema')).toBe(false);
    await t.api.put(`/api/funnel-pages/${home.id}/schema`, { type: '' });
    expect((await visit(`/p/${f.slug}`)).html).not.toContain('application/ld+json');
    const tools = (t.app.services.mcpTools as any[]).map((x) => x.name);
    expect(tools).toEqual(expect.arrayContaining(['ghl_site_seo_check', 'ghl_site_schema_set', 'ghl_site_lock_set', 'ghl_site_lock_list']));
  });
});

describe('URL parameters as text', () => {
  it('replaces only text, escapes values and uses the fallback', () => {
    const q = new URLSearchParams('name=<b>Anna</b>&stadt=Köln');
    const html = '<title>Hallo {{url.name|Freund}}</title><a href="/x?{{url.name}}">{{url.stadt}}</a><script>var a="{{url.name}}"</script><p>{{ url.fehlt | du }}</p>';
    const out = fillUrlParams(html, q);
    expect(out).toContain('<title>Hallo &lt;b&gt;Anna&lt;/b&gt;</title>');
    expect(out).toContain('<a href="/x?">Köln</a>');
    expect(out).toContain('var a="{{url.name}}"');
    expect(out).toContain('<p>du</p>');
  });
  it('works on a served page and keeps it out of shared caches', async () => {
    const f = await newSite('Dyn Seite');
    await t.api.patch(`/api/funnel-pages/${f.pages[0].id}`, { blocks: [{ id: 'h1', type: 'hero', heading: 'Hallo {{url.vorname|Freund}}!', subheading: '' }] });
    const a = await visit(`/p/${f.slug}?vorname=Anna`);
    expect(a.html).toContain('Hallo Anna!');
    expect(a.headers.get('cache-control')).toMatch(/private/);
    expect((await visit(`/p/${f.slug}`)).html).toContain('Hallo Freund!');
    expect((await visit(`/p/${f.slug}?vorname=%3Cimg%20src%3Dx%3E`)).html).not.toContain('<img src=x>');
  });
  it('shows blocks by URL parameter (conditions only pick a branch)', async () => {
    const f = await newSite('Bedingt');
    await t.api.patch(`/api/funnel-pages/${f.pages[0].id}`, { blocks: [{ id: 'h1', type: 'hero', heading: '{{#if url.quelle == "facebook"}}Hallo Facebook-Fan{{else}}Willkommen{{/if}}', subheading: '' }] });
    expect((await visit(`/p/${f.slug}?quelle=facebook`)).html).toContain('Hallo Facebook-Fan');
    const other = (await visit(`/p/${f.slug}?quelle=google`)).html;
    expect(other).toContain('Willkommen');
    expect(other).not.toContain('Facebook-Fan');
  });
});

describe('password-protected pages', () => {
  it('shows a form, unlocks with the right password and locks again when the password changes', async () => {
    const f = await newSite('Geheim');
    const page = f.pages[1];
    expect((await t.api.put(`/api/funnels/${f.id}/locks`, { page_id: page.id, password: 'ab' })).status).toBe(400);
    const set = await t.api.put(`/api/funnels/${f.id}/locks`, { page_id: page.id, password: 'sesam123', hint: 'Steht in der Einladung.' });
    expect(set.status).toBe(200);
    expect(set.data).toHaveLength(1);
    expect(JSON.stringify(set.data)).not.toContain('hash');
    const path = `/p/${f.slug}/${page.slug}`;
    const locked = await visit(path);
    expect(locked.html).toContain('passwortgeschützt');
    expect(locked.html).toContain('Steht in der Einladung.');
    expect(locked.html).not.toContain('Angaben gemäß');
    expect(locked.headers.get('cache-control')).toContain('no-store');
    // Other pages stay open.
    expect((await visit(`/p/${f.slug}`)).html).not.toContain('passwortgeschützt');
    const lockId = set.data[0].id;
    const form = (pw: string, back = path) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ lock: lockId, back, password: pw }).toString() });
    const wrong = await visit('/api/site-unlock', form('falsch'));
    expect(wrong.status).toBe(401);
    expect(wrong.html).toContain('stimmt nicht');
    const ok = await visit('/api/site-unlock', form('sesam123'));
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe(path);
    const cookie = (ok.headers.get('set-cookie') ?? '').split(';')[0];
    expect(cookie).toMatch(/^pghl_sl_/);
    const open = await visit(path, { headers: { cookie } });
    expect(open.html).not.toContain('passwortgeschützt');
    // Never sends the visitor to another host.
    expect((await visit('/api/site-unlock', form('sesam123', '//evil.example/x'))).headers.get('location')).toBe('/');
    // A new password ends the old access.
    await t.api.put(`/api/funnels/${f.id}/locks`, { page_id: page.id, password: 'neu-4567' });
    expect((await visit(path, { headers: { cookie } })).html).toContain('passwortgeschützt');
    // The whole site, then removing the locks.
    const site = await t.api.put(`/api/funnels/${f.id}/locks`, { password: 'ganzeseite' });
    expect(site.data).toHaveLength(2);
    expect((await visit(`/p/${f.slug}`)).html).toContain('passwortgeschützt');
    for (const l of site.data) expect((await t.api.del(`/api/funnels/${f.id}/locks/${l.id}`)).status).toBe(200);
    expect((await visit(path)).html).not.toContain('passwortgeschützt');
  });
});

describe('custom fonts', () => {
  const woff2 = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(60, 1)]);
  it('detects formats from bytes and builds safe CSS', () => {
    expect(fontFormat(woff2)).toBe('woff2');
    expect(fontFormat(Buffer.from('<html><script>alert(1)</script></html>'))).toBeUndefined();
    expect(cleanFamily('Brand"; } body{x:url(evil)')).toBe('Brand bodyxurlevil');
    const css = fontCss('https://app', [{ family: 'Brand', file: 'a.woff2', format: 'woff2', weight: 400, style: 'normal' }], { body: 'Brand' }, { body: 'sans-serif', heading: 'serif' });
    expect(css).toContain('@font-face{font-family:"Brand";src:url("https://app/site-fonts/a.woff2") format("woff2")');
    expect(css).toContain('--ff-body:"Brand",sans-serif');
  });
  it('uploads a font, uses it on a site and serves the file', async () => {
    const f = await newSite('Schrift');
    expect((await t.api.post('/api/site-fonts', { family: 'Brand', data: `data:font/woff2;base64,${Buffer.from('<svg onload=x>').toString('base64')}` })).status).toBe(400);
    const up = await t.api.post('/api/site-fonts', { family: 'Brand Sans', weight: 700, data: `data:font/woff2;base64,${woff2.toString('base64')}` });
    expect(up.status).toBe(200);
    expect(up.data.format).toBe('woff2');
    expect((await t.api.put(`/api/site-fonts/use/${f.id}`, { body: 'Unbekannt' })).status).toBe(400);
    expect((await t.api.put(`/api/site-fonts/use/${f.id}`, { body: 'Brand Sans', heading: '' })).data.body).toBe('Brand Sans');
    const page = await visit(`/p/${f.slug}`);
    expect(page.html).toContain('font-family:"Brand Sans"');
    expect(page.html).toContain('font-weight:700');
    const file = await t.api.raw(`/site-fonts/${up.data.file}`);
    expect(file.headers.get('content-type')).toBe('font/woff2');
    expect(file.headers.get('access-control-allow-origin')).toBe('*');
    expect((await t.api.del(`/api/site-fonts/${up.data.id}`)).status).toBe(200);
    expect((await visit(`/p/${f.slug}`)).html).not.toContain('Brand Sans');
  });
});

describe('SEO audit of any website', () => {
  it('fetches a page and reports transport, mobile and content findings', async () => {
    const { createServer } = await import('node:http');
    const srv = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>Alte Seite</title></head><body><h1>Hallo</h1><img src="x.png"><p>Kurz.</p></body></html>');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as any).port;
    const before = process.env.PGHL_ALLOW_PRIVATE_FETCH;
    process.env.PGHL_ALLOW_PRIVATE_FETCH = '1';
    try {
      const r = await t.api.post('/api/seo-audit', { url: `http://127.0.0.1:${port}/` });
      expect(r.status).toBe(200);
      const rules = r.data.issues.map((i: any) => i.rule);
      expect(rules).toEqual(expect.arrayContaining(['https', 'viewport', 'lang', 'title_short', 'description_missing', 'img_alt']));
      expect(r.data.score).toBeLessThan(50);
      expect(r.data.issues[0].level).toBe('error');
    } finally {
      if (before === undefined) delete process.env.PGHL_ALLOW_PRIVATE_FETCH;
      else process.env.PGHL_ALLOW_PRIVATE_FETCH = before;
      srv.close();
    }
    // Internal targets stay blocked without the switch.
    expect((await t.api.post('/api/seo-audit', { url: `http://127.0.0.1:${port}/` })).status).toBe(400);
    expect((await t.api.post('/api/seo-audit', { url: '' })).status).toBe(400);
  });
});

describe('page management', () => {
  it('takes a single page offline (site 404, noindex restored after) and reorders pages', async () => {
    const f = await newSite('Verwaltung');
    const [home, imp, dsg] = f.pages;
    const off = await t.api.put(`/api/funnel-pages/${imp.id}/offline`, { offline: true });
    expect(off.data.find((p: any) => p.id === imp.id).offline).toBe(true);
    const gone = await visit(`/p/${f.slug}/${imp.slug}`);
    expect(gone.status).toBe(404);
    expect((await visit(`/p/${f.slug}`)).status).toBe(200);
    expect((await visit(`/p/${f.slug}/sitemap.xml`)).html).not.toContain(`/${imp.slug}<`);
    await t.api.put(`/api/funnel-pages/${imp.id}/offline`, { offline: false });
    expect((await visit(`/p/${f.slug}/${imp.slug}`)).status).toBe(200);
    const seo = (await t.api.get(`/api/funnels/${f.id}`)).data.pages.find((p: any) => p.id === imp.id).seo;
    expect(!!seo.noindex).toBe(false);
    expect((await t.api.post(`/api/funnels/${f.id}/reorder`, { page_ids: [dsg.id, home.id] })).status).toBe(400);
    const r = await t.api.post(`/api/funnels/${f.id}/reorder`, { page_ids: [dsg.id, home.id, imp.id] });
    expect(r.data.map((p: any) => p.id)).toEqual([dsg.id, home.id, imp.id]);
    expect(r.data[0].start).toBe(true);
  });
});
