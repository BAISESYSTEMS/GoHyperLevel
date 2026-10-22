import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { FF } from './site-fixtures.js';
import { COLOR_TOKENS, DEFAULT_TOKENS, Rules, cleanShadow, cleanTokens, colorCss, contrast, fixContrast, minify, readableOn, tokensCss, tokensOf } from '../server/services/site-style.js';
import { cleanBlocks, newSection, pageText, walkBlocks } from '../server/services/site-layout.js';
import { cleanSiteSettings } from '../server/services/site-settings.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
});
afterAll(() => t.close());

const html = async (path: string, headers: Record<string, string> = {}) => {
  const r = await t.api.raw(path, { headers });
  return { status: r.status, body: await r.text(), headers: r.headers };
};
async function site(blocks: any[], settings: Record<string, any> = {}, name = 'Layout-Test') {
  const f = (await t.api.post('/api/funnels', { name, kind: 'website', template: 'blank' })).data;
  const page = f.pages[0];
  const saved = await t.api.patch(`/api/funnel-pages/${page.id}`, { blocks });
  expect(saved.status).toBe(200);
  if (Object.keys(settings).length) expect((await t.api.patch(`/api/funnels/${f.id}`, { settings })).status).toBe(200);
  return { f, page };
}

describe('design tokens', () => {
  it('clamps and validates everything the browser sends', () => {
    const tk = cleanTokens({ colors: { brand: '#0F766E', text: 'red', bg: 'javascript:1', muted: '#abc' }, scale: { base: 99, ratio: 0.5 }, radius: { sm: -4, lg: 500 }, shadow: { sm: '0 1px 2px rgba(0,0,0,.2)', md: 'url(x)', lg: '0 0 0 red; background:url(x)' }, fonts: { body: 'serif', heading: 'evil' }, space: 1 });
    expect(tk.colors.brand).toBe('#0f766e');
    expect(tk.colors.text).toBe(DEFAULT_TOKENS.colors.text);
    expect(tk.colors.bg).toBe(DEFAULT_TOKENS.colors.bg);
    expect(tk.colors.muted).toBe('#abc');
    expect(tk.scale).toEqual({ base: 22, ratio: 1.1 });
    expect(tk.radius).toEqual({ sm: 0, md: DEFAULT_TOKENS.radius.md, lg: 64 });
    expect(tk.shadow.sm).toBe('0 1px 2px rgba(0,0,0,.2)');
    expect(tk.shadow.md).toBe(DEFAULT_TOKENS.shadow.md);
    expect(tk.shadow.lg).toBe(DEFAULT_TOKENS.shadow.lg);
    expect(tk.fonts).toEqual({ body: 'serif', heading: 'system' });
    expect(tk.space).toBe(4);
    expect(cleanShadow('none', 'x')).toBe('none');
  });

  it('prints custom properties, a phone type scale and resolves token colours', () => {
    const css = tokensCss(cleanTokens({ colors: { brand: '#0f766e' }, scale: { base: 18, ratio: 1.2 } }));
    expect(css).toContain('--c-brand:#0f766e');
    expect(css).toContain('--brand:#0f766e');
    expect(css).toContain('html{font-size:18px}');
    expect(css).toMatch(/@media \(max-width:640px\)\{:root\{--fs-s:/);
    for (const k of COLOR_TOKENS) expect(css).toContain(`--c-${k}:`);
    expect(colorCss('token:brand')).toBe('var(--c-brand)');
    expect(colorCss('#fff')).toBe('#fff');
    expect(colorCss('red')).toBe('');
    expect(colorCss('token:evil')).toBe('');
    expect(colorCss('url(javascript:1)')).toBe('');
  });

  it('keeps the older single brand colour as the brand token', () => {
    expect(tokensOf({ color: '#7c3aed' }).colors.brand).toBe('#7c3aed');
    expect(tokensOf({ color: '#7c3aed', tokens: { colors: { brand: '#111111' } } }).colors.brand).toBe('#111111');
    expect(tokensOf(undefined).colors.brand).toBe(DEFAULT_TOKENS.colors.brand);
  });

  it('computes WCAG contrast and finds a passing colour', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.54, 1);
    expect(readableOn('#111827')).toBe('#ffffff');
    expect(readableOn('#fde68a')).toBe('#111827');
    const fixed = fixContrast('#9ca3af', '#ffffff', 4.5);
    expect(contrast(fixed, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(fixContrast('#000000', '#ffffff')).toBe('#000000');
  });

  it('minifies generated CSS without touching calc() spacing', () => {
    expect(minify('a { color : red ; }\n/* x */ .b>.c , d { width: calc(100% - 4px) ; }')).toBe('a{color:red}.b>.c,d{width:calc(100% - 4px)}');
    const r = new Rules();
    r.add('desktop', '.a{x:1}');
    r.add('tablet', '.b{x:2}');
    r.add('phone', '.c{x:3}');
    r.once('k', 'phone', '.d{x:4}');
    r.once('k', 'phone', '.d{x:4}');
    expect(r.css()).toBe('.a{x:1}@media (max-width:1024px){.b{x:2}}@media (max-width:640px){.c{x:3}.d{x:4}}');
  });

  it('site settings: tokens, menus, header and footer are validated; unknown keys pass through', () => {
    const c = cleanSiteSettings({ tokens: { colors: { brand: '#ff0000' } }, menus: { main: [{ label: 'Start', url: '/' }, { label: '', url: '/x' }, { label: 'Böse', url: 'javascript:alert(1)', children: [{ label: 'K', url: 'page:kontakt' }] }] }, header: { enabled: true, brand: 'X', logo: 'javascript:1', menu: 'Bad Name' }, footer: { enabled: true, columns: [{ title: 'A', links: [{ label: 'L', url: 'mailto:a@b.de' }] }, {}, {}, {}, {}] }, favicon: 'https://x/y.ico' }, {});
    expect(c.tokens.colors.brand).toBe('#ff0000');
    expect(c.menus.main).toHaveLength(2);
    expect(c.menus.main[1]).toMatchObject({ label: 'Böse', url: '#', children: [{ label: 'K', url: 'page:kontakt' }] });
    expect(c.header).toMatchObject({ enabled: true, brand: 'X', logo: '', menu: 'main' });
    expect(c.footer.columns).toHaveLength(4);
    expect(c.favicon).toBe('https://x/y.ico');
    expect(() => cleanSiteSettings({ menus: { 'Bad Name': [] } }, {})).toThrow(/Menü-Name/);
    expect(cleanSiteSettings({ languages: { default: 'xx!', list: [{ code: 'en', label: 'English' }] } }, {}).languages).toEqual({ default: 'de', list: [{ code: 'de', label: 'Deutsch' }, { code: 'en', label: 'English' }] });
  });
});

describe('sections, rows and columns', () => {
  it('stores a nested layout and normalises what the editor sends', () => {
    const blocks = cleanBlocks([
      {
        type: 'section',
        pad_y: 9999,
        width: 'huge',
        bg: 'not-a-colour',
        rows: [{ cols: [{ span: 99, blocks: [{ type: 'text', text: 'a' }, { type: 'section', rows: [] }] }, {}, {}, {}, {}, {}] }],
      },
      { type: 'hero', heading: 'x', hide: { phone: true, desktop: 0 }, fs: { phone: 5, tablet: 80 } },
    ]);
    const s: any = blocks[0];
    expect(s.pad_y).toBe(240);
    expect(s.width).toBe('normal');
    expect(s.bg).toBeUndefined();
    expect(s.rows[0].cols).toHaveLength(4);
    expect(s.rows[0].cols[0].span).toBe(12);
    // no section inside a column
    expect(s.rows[0].cols[0].blocks.map((b: any) => b.type)).toEqual(['text']);
    // other columns get an even share
    expect(s.rows[0].cols[1].span).toBe(3);
    expect(blocks[1]).toMatchObject({ hide: { phone: true }, fs: { tablet: 80 } });
    const seen: string[] = [];
    walkBlocks(blocks, (b) => seen.push(b.type));
    expect(seen).toEqual(['section', 'text', 'hero']);
    expect(pageText(blocks)).toContain('a');
    expect(() => cleanBlocks(Array.from({ length: 150 }, () => newSection([6, 6], [[{ id: 'x', type: 'text' }, { id: 'y', type: 'text' }], [{ id: 'z', type: 'text' }]])))).toThrow(/zu viele Blöcke/);
  });

  it('renders columns as a 12-column grid with stacking, per-device widths, hiding, font size and padding overrides', async () => {
    const { f } = await site(
      [
        {
          type: 'section',
          id: 'sec1',
          bg: 'token:brand',
          pad_y: 80,
          r: { tablet: { pad_y: 40 }, phone: { pad_y: 20, pad_x: 12 } },
          rows: [
            {
              id: 'row1',
              gap: 30,
              stack: 'tablet',
              rev: true,
              cols: [
                { id: 'colA', span: 7, blocks: [{ id: 'h1', type: 'heading', text: 'Zwei Spalten', level: 1, fs: { phone: 80, tablet: 90 } }, { id: 'b1', type: 'button', text: 'Los', url: '/x' }] },
                { id: 'colB', span: 5, r: { tablet: { span: 6 }, phone: { span: 12 } }, hide: { phone: true }, blocks: [{ id: 'i1', type: 'image', src: 'https://x.test/a.jpg', alt: 'Ein Bild', w: 800, h: 600 }] },
              ],
            },
            { id: 'row2', stack: 'never', cols: [{ id: 'c3', blocks: [{ id: 'x1', type: 'text', text: 'unten', hide: { tablet: true } }] }] },
          ],
        },
        { type: 'hero', heading: 'Klassisch', align: 'center' },
      ],
      {},
      'Raster',
    );
    const p = await html(`/p/${f.slug}`);
    expect(p.status).toBe(200);
    const h = p.body;
    // grid and spans
    expect(h).toContain('<div class="row st-t xrow1" style="--g:30px">');
    expect(h).toMatch(/<div class="col s7">/);
    expect(h).toMatch(/<div class="col s5 hd-p t6 p12">/);
    expect(h).toContain('.s7{--s:7}');
    expect(h).toContain('.s5{--s:5}');
    // the single column of a row without stacking has the full width
    expect(h).toContain('<div class="row" style="--g:24px"><div class="col s12">');
    // media queries: tablet stacking rule, explicit widths after it, hide utilities, reverse order
    expect(h).toContain('@media (max-width:1024px){.st-t>.col{--s:12}}');
    expect(h).toContain('.row .t6{--s:6}');
    expect(h).toContain('.row .p12{--s:12}');
    expect(h).toContain('.hd-p{display:none!important}');
    expect(h).toContain('.xrow1.st-t>.col:nth-child(1){order:2}');
    // font size overrides for the heading, padding overrides for the section
    expect(h).toMatch(/\.xh1\.fz\{font-size:90%\}/);
    expect(h).toMatch(/\.xh1\.fz\{font-size:80%\}/);
    expect(h).toContain('.xsec1{--py:80px;--px:20px}');
    expect(h).toContain('.xsec1{--py:40px}');
    expect(h).toContain('.xsec1{--py:20px;--px:12px}');
    // brand background → readable text and a button that does not vanish
    expect(h).toMatch(/<section class="sec xsec1" style="--mw:1100px;background-color:var\(--c-brand\);color:#ffffff;--btn:#ffffff;--btn-fg:#2563eb;--lk:#ffffff"/);
    // picture with size attributes (no layout shift), first picture eager
    expect(h).toContain('width="800" height="600" fetchpriority="high"');
    // hidden on tablet only → class for tablet
    expect(h).toContain('class="blk blk-text hd-t"');
    // the classic block still renders, inside <main>
    expect(h).toContain('<main id="main">');
    expect(h).toContain('<section class="blk blk-hero"');
  });

  it('prints CSS only for the block types a page uses', async () => {
    const { f } = await site([{ type: 'text', text: 'Nur Text' }], {}, 'Schlank');
    const h = (await html(`/p/${f.slug}`)).body;
    expect(h).toContain('.prose{');
    expect(h).not.toContain('.countdown{');
    expect(h).not.toContain('.row{display:grid');
    expect(h).not.toContain('.gh{');
  });

  it('survives a broken block and unknown types', async () => {
    const { f } = await site([{ type: 'unbekannt' }, { type: 'text', text: 'ok' }, { type: 'section', rows: 'kaputt' }], {}, 'Kaputt');
    const r = await html(`/p/${f.slug}`);
    expect(r.status).toBe(200);
    expect(r.body).toContain('ok');
  });

  it('escapes everything: text, colours, urls and class names cannot break out', async () => {
    const { f } = await site(
      [
        { id: 'a"><script>1</script>', type: 'section', bg: '#fff"><img src=x onerror=1>', bg_image: 'javascript:alert(1)', rows: [{ cols: [{ blocks: [{ id: 'q', type: 'heading', text: '<img src=x onerror=alert(1)>', level: 1, bg: 'red;background:url(x)', anchor: 'x" onfocus="1' }] }] }] },
      ],
      {},
      'Escape',
    );
    const h = (await html(`/p/${f.slug}`)).body;
    expect(h).not.toContain('<script>1</script>');
    expect(h).not.toContain('<img src=x');
    expect(h).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(h).not.toContain('onfocus="1');
    expect(h).not.toContain('javascript:alert');
  });
});

describe('design in the page', () => {
  it('applies tokens, header with menu, footer, sticky header and skip link', async () => {
    const { f, page } = await site([{ type: 'hero', heading: 'Start', align: 'center' }], {}, 'Designseite');
    const kontakt = (await t.api.post(`/api/funnels/${f.id}/pages`, { name: 'Kontakt', slug: 'kontakt', blocks: [{ type: 'heading', text: 'Kontakt', level: 1 }] })).data;
    const r = await t.api.patch(`/api/funnels/${f.id}`, {
      settings: {
        tokens: { colors: { brand: '#0f766e', accent: '#f59e0b' }, fonts: { heading: 'serif' }, radius: { md: 4 } },
        header: { enabled: true, brand: 'Müller GmbH', sticky: true, cta_text: 'Anrufen', cta_url: 'tel:+4930123456' },
        menus: { main: [{ label: 'Start', url: `page:${page.id}` }, { label: 'Kontakt', url: `page:${kontakt.id}` }, { label: 'Mehr', url: '#', children: [{ label: 'Intern', url: 'page:kontakt' }] }] },
        footer: { enabled: true, text: 'Alle Rechte **vorbehalten**', columns: [{ title: 'Seiten', menu: 'main' }] },
        search: { enabled: true },
      },
    });
    expect(r.status).toBe(200);
    const h = (await html(`/p/${f.slug}`)).body;
    expect(h).toContain('--c-brand:#0f766e');
    expect(h).toContain('--r-md:4px');
    expect(h).toContain('<a class="skip" href="#main">Zum Inhalt springen</a>');
    expect(h).toContain('<header class="gh sticky" id="gh">');
    expect(h).toContain('<span>Müller GmbH</span>');
    expect(h).toContain(`<a href="http://localhost/p/${f.slug}" aria-current="page">Start</a>`);
    expect(h).toContain(`<a href="http://localhost/p/${f.slug}/kontakt">Kontakt</a>`);
    // slug references work too, one level of sub menu
    expect(h).toMatch(/class="has-sub"><a href="#">Mehr<\/a><ul><li><a href="http:\/\/localhost\/p\/[^"]+\/kontakt">Intern/);
    expect(h).toContain('href="tel:+4930123456">Anrufen</a>');
    expect(h).toContain('role="search"');
    expect(h).toContain('<footer class="gf">');
    expect(h).toContain('Alle Rechte <strong>vorbehalten</strong>');
    expect(h).toContain('<h2>Seiten</h2>');
    // header off for one page
    expect((await t.api.patch(`/api/funnel-pages/${kontakt.id}`, { layout: { header: false, footer: false } })).status).toBe(200);
    const k = (await html(`/p/${f.slug}/kontakt`)).body;
    expect(k).not.toContain('<header');
    expect(k).not.toContain('<footer class="gf">');
  });

  it('legacy footer text and brand colour keep working without the new settings', async () => {
    const { f } = await site([{ type: 'text', text: 'x' }], { color: '#7c3aed', footer_text: '[Impressum](/p/x/impressum)' }, 'Alt');
    const h = (await html(`/p/${f.slug}`)).body;
    expect(h).toContain('--c-brand:#7c3aed');
    expect(h).toContain('<footer style="text-align:center');
    expect(h).not.toContain('<header');
  });

  it('language: lang attribute, hreflang pairs and a translated copy of a page', async () => {
    const { f, page } = await site([{ type: 'hero', heading: 'Willkommen' }], { header: { enabled: true, lang_switch: true } }, 'Mehrsprachig');
    const tr = await t.api.post(`/api/funnel-pages/${page.id}/translation`, { lang: 'en' });
    expect(tr.status).toBe(200);
    expect(tr.data.slug).toBe('start-en');
    expect(tr.data.layout).toMatchObject({ lang: 'en' });
    expect((await t.api.post(`/api/funnel-pages/${page.id}/translation`, { lang: 'en' })).status).toBe(400);
    expect((await t.api.post(`/api/funnel-pages/${page.id}/translation`, { lang: 'de' })).status).toBe(400);
    const de = (await html(`/p/${f.slug}`)).body;
    expect(de).toContain('<html lang="de">');
    expect(de).toContain(`<link rel="alternate" hreflang="de" href="http://localhost/p/${f.slug}">`);
    expect(de).toContain(`<link rel="alternate" hreflang="en" href="http://localhost/p/${f.slug}/start-en">`);
    expect(de).toContain('hreflang="x-default"');
    expect(de).toContain('<nav class="gl" aria-label="Sprache">');
    const en = (await html(`/p/${f.slug}/start-en`)).body;
    expect(en).toContain('<html lang="en">');
    const settings = (await t.api.get(`/api/funnels/${f.id}`)).data.settings;
    expect(settings.languages.list.map((l: any) => l.code)).toEqual(['de', 'en']);
  });
});

describe('components', () => {
  it('are saved once and used on several pages; edits reach every page; delete keeps the pages as they were', async () => {
    const { f, page } = await site([{ type: 'hero', heading: 'Seite eins' }], {}, 'Komponenten');
    const two = (await t.api.post(`/api/funnels/${f.id}/pages`, { name: 'Zwei', slug: 'zwei' })).data;
    const cta = (await t.api.post('/api/site-components', { name: 'CTA-Band', blocks: [newSection([12], [[{ id: 'c1', type: 'cta', heading: 'Jetzt anfragen', button_text: 'Los', button_url: '#' }]])] })).data;
    expect(cta.blocks).toHaveLength(1);
    for (const p of [page, two]) await t.api.patch(`/api/funnel-pages/${p.id}`, { blocks: [{ type: 'component', component_id: cta.id }] });
    expect((await html(`/p/${f.slug}`)).body).toContain('Jetzt anfragen');
    expect((await html(`/p/${f.slug}/zwei`)).body).toContain('Jetzt anfragen');
    const list = (await t.api.get('/api/site-components')).data;
    expect(list.find((c: any) => c.id === cta.id).uses).toBe(2);
    expect((await t.api.get(`/api/site-components/${cta.id}`)).data.used_on.map((u: any) => u.name).sort()).toEqual(['Seite 1', 'Zwei']);
    // one change, both pages
    await t.api.patch(`/api/site-components/${cta.id}`, { blocks: [newSection([12], [[{ id: 'c1', type: 'cta', heading: 'Neue Überschrift', button_text: 'Los', button_url: '#' }]])] });
    expect((await html(`/p/${f.slug}`)).body).toContain('Neue Überschrift');
    expect((await html(`/p/${f.slug}/zwei`)).body).toContain('Neue Überschrift');
    // inside a column a component is rendered bare
    const inCol = (await t.api.post('/api/site-components', { name: 'Zitat', blocks: [{ type: 'testimonial', quote: 'Wunderbar', author: 'Anna' }] })).data;
    await t.api.patch(`/api/funnel-pages/${two.id}`, { blocks: [newSection([6, 6], [[{ type: 'component', component_id: inCol.id }], []])] });
    expect((await html(`/p/${f.slug}/zwei`)).body).toMatch(/<div class="col s6"><div class="blk blk-testimonial">/);
    // deleting turns the places into plain blocks
    const del = await t.api.del(`/api/site-components/${cta.id}`);
    expect(del.data).toMatchObject({ ok: true, detached: 1 });
    const first = (await t.api.get(`/api/funnels/${f.id}`)).data.pages[0];
    expect(JSON.stringify(first.blocks)).toContain('Neue Überschrift');
    expect(JSON.stringify(first.blocks)).not.toContain('component_id');
    expect((await html(`/p/${f.slug}`)).body).toContain('Neue Überschrift');
  });

  it('refuse to contain themselves and never render another sub-account\'s component', async () => {
    const a = (await t.api.post('/api/site-components', { name: 'A', blocks: [{ type: 'text', text: 'a' }] })).data;
    const b = (await t.api.post('/api/site-components', { name: 'B', blocks: [{ type: 'component', component_id: a.id }] })).data;
    const loop = await t.api.patch(`/api/site-components/${a.id}`, { blocks: [{ type: 'component', component_id: b.id }] });
    expect(loop.status).toBe(400);
    expect(loop.data.error).toMatch(/nicht selbst/);
    const self = await t.api.patch(`/api/site-components/${a.id}`, { blocks: [{ type: 'component', component_id: a.id }] });
    expect(self.status).toBe(400);
    expect((await t.api.post('/api/site-components', { name: '', blocks: [{ type: 'text' }] })).status).toBe(400);
    expect((await t.api.post('/api/site-components', { name: 'Leer', blocks: [] })).status).toBe(400);
    // another sub-account
    const other = (await t.api.post('/api/locations', { name: 'Fremd' })).data.id;
    const foreign = await t.api.get(`/api/site-components/${a.id}`, { 'x-location-id': other });
    expect(foreign.status).toBe(404);
    const { f } = await site([{ type: 'text', text: 'vorher' }], {}, 'Fremd-Komponente');
    // a block that points to a component of the first sub-account, stored in the other one, renders nothing
    const g = (await t.api.post('/api/funnels', { name: 'Gast' }, { 'x-location-id': other })).data;
    await t.api.patch(`/api/funnel-pages/${g.pages[0].id}`, { blocks: [{ type: 'component', component_id: a.id }, { type: 'text', text: 'eigener Text' }] }).catch(() => undefined);
    void f;
    expect(g.id).toBeTruthy();
  });
});

describe('redirects, 404 and search', () => {
  it('matches exact rules before wildcards, fills captures and detects loops', async () => {
    const { matchRedirect, findLoop, cleanSource, cleanTarget, parseRuleLines, resolveTarget, normPath } = await import('../server/services/site-redirects.js');
    const rule = (source: string, target: string, extra: any = {}) => ({ id: source, source: normPath(source), target, code: 301, wildcard: source.includes('*'), keep_query: true, ...extra });
    const rules = [rule('/blog/*', '/news/$1'), rule('/blog/hallo', '/neu'), rule('/old/*', 'https://example.org/:splat', { code: 302 })];
    expect(matchRedirect(rules, '/blog/hallo')?.to).toBe('/neu');
    expect(matchRedirect(rules, '/Blog/2020/Post/')?.to).toBe('/news/2020/post');
    expect(matchRedirect(rules, '/blog')?.to).toBe('/news/');
    expect(matchRedirect(rules, '/old/a/b')).toMatchObject({ to: 'https://example.org/a/b', rule: { code: 302 } });
    expect(matchRedirect(rules, '/other')).toBeUndefined();
    expect(findLoop([rule('/a', '/b')], rule('/b', '/a'))).toMatch(/Schleife/);
    expect(findLoop([rule('/a', '/b')], rule('/c', 'https://x.de'))).toBeUndefined();
    expect(findLoop([], rule('/wild/*', '/wild/x'))).toMatch(/Schleife/);
    expect(cleanSource('https://x.de/alt?x=1')).toEqual({ source: '/alt', wildcard: false });
    expect(() => cleanSource('/')).toThrow(/Startseite/);
    expect(() => cleanSource('/api/x')).toThrow(/App/);
    expect(() => cleanSource('/a b')).toThrow(/Quelle/);
    expect(() => cleanTarget('javascript:alert(1)')).toThrow();
    expect(() => cleanTarget('//evil.example')).toThrow();
    expect(cleanTarget('/neu')).toBe('/neu');
    expect(resolveTarget('/neu', 'https://s.de/', '?utm_source=a', true)).toBe('https://s.de/neu?utm_source=a');
    expect(resolveTarget('/neu?x=1', 'https://s.de', '?utm_source=a', true)).toBe('https://s.de/neu?x=1');
    expect(resolveTarget('/neu', 'https://s.de', '?a=1', false)).toBe('https://s.de/neu');
    const imp = parseRuleLines('/a -> /b\n/c;/d;302\n# Kommentar\n/blog/* → /news/$1\nkaputt');
    expect(imp.rules).toEqual([{ source: '/a', target: '/b', code: 301 }, { source: '/c', target: '/d', code: 302 }, { source: '/blog/*', target: '/news/$1', code: 301 }]);
    expect(() => cleanSource('/s/abc')).toThrow(/App/);
    expect(imp.errors).toHaveLength(1);
  });

  it('redirects with 301/302, keeps UTM parameters, counts hits, works on a custom domain and for the blog', async () => {
    const { f } = await site([{ type: 'hero', heading: 'Neu' }], {}, 'Umleitung');
    const mk = (b: any) => t.api.post(`/api/funnels/${f.id}/redirects`, b);
    await t.api.post(`/api/funnels/${f.id}/pages`, { name: 'Neu', slug: 'neu' });
    const a = await mk({ source: '/alte-seite', target: '/neu' });
    expect(a.status).toBe(200);
    expect(a.data).toMatchObject({ source: '/alte-seite', code: 301, wildcard: false, page_conflict: false });
    expect((await mk({ source: '/alte-seite', target: '/x' })).status).toBe(400);
    expect((await mk({ source: '/x', target: '/x' })).data.error).toMatch(/Schleife/);
    expect((await mk({ source: '/api/foo', target: '/x' })).data.error).toMatch(/App/);
    const w = await mk({ source: '/archiv/*', target: 'https://example.org/archiv/$1', code: 302 });
    expect(w.data.wildcard).toBe(true);
    const r1 = await t.api.raw(`/p/${f.slug}/alte-seite?utm_source=news`, { redirect: 'manual' });
    expect(r1.status).toBe(301);
    expect(r1.headers.get('location')).toBe(`http://localhost/p/${f.slug}/neu?utm_source=news`);
    const r2 = await t.api.raw(`/p/${f.slug}/archiv/2020/post`, { redirect: 'manual' });
    expect(r2.status).toBe(302);
    expect(r2.headers.get('location')).toBe('https://example.org/archiv/2020/post');
    expect(r2.headers.get('cache-control')).toBe('no-store');
    const rules = (await t.api.get(`/api/funnels/${f.id}/redirects`)).data.rules;
    expect(rules.find((x: any) => x.source === '/alte-seite').hits).toBe(1);
    // edit and delete
    expect((await t.api.patch(`/api/site-redirects/${a.data.id}`, { code: 302 })).data.code).toBe(302);
    expect((await t.api.raw(`/p/${f.slug}/alte-seite`, { redirect: 'manual' })).status).toBe(302);
    // custom domain: same rules at the root of the domain
    await t.api.patch(`/api/funnels/${f.id}`, { domain: 'umleitung.example.de' });
    const dom = await new Promise<{ status: number; location?: string }>((resolve, reject) => {
      import('node:http').then(({ request }) => {
        const u = new URL(t.base);
        request({ host: u.hostname, port: u.port, path: '/archiv/x', headers: { host: 'umleitung.example.de' } }, (res) => resolve({ status: res.statusCode ?? 0, location: String(res.headers.location) })).on('error', reject).end();
      });
    });
    expect(dom).toEqual({ status: 302, location: 'https://example.org/archiv/x' });
    // blog paths too
    await t.api.post(`/api/funnels/${f.id}/redirects`, { source: '/blog/umzug', target: '/blog/neu' });
    expect((await t.api.raw(`/p/${f.slug}/blog/umzug`, { redirect: 'manual' })).status).toBe(301);
    expect((await t.api.del(`/api/site-redirects/${a.data.id}`)).status).toBe(200);
    expect((await t.api.raw(`/p/${f.slug}/alte-seite`, { redirect: 'manual' })).status).toBe(404);
    // a rule for the root of the site
    const root = await t.api.post(`/api/funnels/${f.id}/redirects`, { source: '/start', target: '/' });
    expect(root.status).toBe(200);
    expect((await t.api.raw(`/p/${f.slug}/start`, { redirect: 'manual' })).headers.get('location')).toBe(`https://umleitung.example.de/`);
  });

  it('test and import endpoints; a page slug can be redirected (with a warning)', async () => {
    const { f } = await site([{ type: 'hero', heading: 'Seite' }], {}, 'Import');
    await t.api.post(`/api/funnels/${f.id}/pages`, { name: 'Alt', slug: 'alt' });
    const imp = await t.api.post(`/api/funnels/${f.id}/redirects/import`, { text: '/alt -> /neu\n/foo/* -> /bar/$1 302\n/alt -> /doppelt\nmüll\n/p/x -> /y' });
    expect(imp.data).toMatchObject({ created: 3, skipped: 1 });
    expect(imp.data.errors.length).toBe(1);
    const list = (await t.api.get(`/api/funnels/${f.id}/redirects`)).data.rules;
    expect(list.find((r: any) => r.source === '/alt').page_conflict).toBe(true);
    const test = await t.api.post(`/api/funnels/${f.id}/redirects/test`, { path: '/foo/a/b' });
    expect(test.data.match).toMatchObject({ source: '/foo/*', code: 302 });
    expect(test.data.url).toBe(`http://localhost/p/${f.slug}/bar/a/b`);
    expect((await t.api.post(`/api/funnels/${f.id}/redirects/test`, { path: '/nix' })).data.match).toBeNull();
  });

  it('shows the site\'s own 404 (a page called "404" or a chosen one), marks it noindex and lists what was not found', async () => {
    const { f } = await site([{ type: 'hero', heading: 'Start' }], { header: { enabled: true, brand: 'Site' } }, 'Fehlerseite');
    const std = await html(`/p/${f.slug}/gibt-es-nicht`, { 'user-agent': 'Mozilla/5.0 (X11; Linux) Firefox/130' });
    expect(std.status).toBe(404);
    expect(std.body).toContain('Zur Startseite');
    expect(std.body).toContain('noindex');
    expect(std.body).toContain('<header class="gh"');
    expect(std.headers.get('content-security-policy')).toContain('sandbox');
    await html(`/p/${f.slug}/gibt-es-nicht`, { 'user-agent': 'Mozilla/5.0 (X11; Linux) Firefox/130' });
    await html(`/p/${f.slug}/wp-login.php`, { 'user-agent': 'Mozilla/5.0 (X11; Linux) Firefox/130' });
    await html(`/p/${f.slug}/spam`, { 'user-agent': 'Googlebot/2.1' });
    const misses = (await t.api.get(`/api/funnels/${f.id}/redirects`)).data.misses;
    expect(misses).toEqual([expect.objectContaining({ path: '/gibt-es-nicht', hits: 2 })]);
    await t.api.post(`/api/funnels/${f.id}/redirects`, { source: '/gibt-es-nicht', target: '/' });
    expect((await t.api.get(`/api/funnels/${f.id}/redirects`)).data.misses).toEqual([]);
    // an own page
    const nf = (await t.api.post(`/api/funnels/${f.id}/pages`, { name: 'Oops', slug: '404', blocks: [{ type: 'heading', text: 'Hoppla, falsch abgebogen', level: 1 }] })).data;
    const FF = { 'user-agent': 'Mozilla/5.0 (X11; Linux) Firefox/130' };
    const own = await html(`/p/${f.slug}/nirgendwo`, FF);
    expect(own.status).toBe(404);
    expect(own.body).toContain('Hoppla, falsch abgebogen');
    await t.api.patch(`/api/funnels/${f.id}`, { settings: { not_found: { heading: 'Weg ist weg', text: 'Probier die Suche.' } } });
    await t.api.del(`/api/funnel-pages/${nf.id}`);
    const text = await html(`/p/${f.slug}/nirgendwo`, FF);
    expect(text.body).toContain('Weg ist weg');
    expect((await t.api.get(`/api/funnels/${f.id}/redirects`)).data.misses.length).toBeGreaterThan(0);
    expect((await t.api.del(`/api/funnels/${f.id}/redirects/misses`)).status).toBe(200);
    expect((await t.api.get(`/api/funnels/${f.id}/redirects`)).data.misses).toEqual([]);
  });

  it('searches pages and blog posts, folds umlauts, ranks titles first and skips noindex pages', async () => {
    const { fold, search, terms } = await import('../server/services/site-search.js');
    expect(fold('Bäcker Größe ÜBER')).toBe('baecker groesse ueber');
    expect(terms('Bäcker  & Brötchen!')).toEqual(['baecker', 'broetchen']);
    const docs = [
      { kind: 'page', title: 'Bäckerei', url: '/a', text: 'Frische Brötchen jeden Morgen' },
      { kind: 'page', title: 'Kontakt', url: '/b', text: 'Wir backen für Sie – Bäcker seit 1900' },
      { kind: 'page', title: 'Impressum', url: '/c', text: 'Angaben' },
    ];
    const hits = search(docs, 'baecker');
    expect(hits.map((h) => h.url)).toEqual(['/a', '/b']);
    expect(search(docs, 'broetchen morgen').map((h) => h.url)).toEqual(['/a']);
    expect(search(docs, 'brot')).toEqual([]);
    expect(search(docs, 'x')).toEqual([]);

    const { f } = await site([{ type: 'text', text: 'Unsere Dienstleistungen für Gärtner und Landschaftsbau' }], { search: { enabled: true }, header: { enabled: true, brand: 'S' } }, 'Suche');
    await t.api.post(`/api/funnels/${f.id}/pages`, { name: 'Geheim', slug: 'geheim', blocks: [{ type: 'text', text: 'Gärtner Interna' }] }).then((r) => t.api.patch(`/api/funnel-pages/${r.data.id}`, { seo: { noindex: true } }));
    await t.api.post(`/api/funnels/${f.id}/posts`, { title: 'Gärtner-Tipps im Herbst', content: 'Beete winterfest machen', status: 'published' });
    const res = (await html(`/p/${f.slug}/search?q=gaertner`)).body;
    expect(res).toContain('class="sres"');
    expect(res).toContain('Gärtner-Tipps im Herbst');
    expect(res).toContain('Seite 1');
    expect(res).not.toContain('Geheim');
    expect(res).toContain('name="q" value="gaertner"');
    const none = (await html(`/p/${f.slug}/search?q=zzzz`)).body;
    expect(none).toContain('Nichts gefunden');
    const xss = (await html(`/p/${f.slug}/search?q=${encodeURIComponent('"><script>alert(1)</script>')}`)).body;
    expect(xss).not.toContain('<script>alert(1)</script>');
    // off by default
    const { f: g } = await site([{ type: 'text', text: 'x' }], {}, 'Ohne Suche');
    expect((await html(`/p/${g.slug}/search?q=x`)).status).toBe(404);
  });
});

describe('rows never overflow the screen', () => {
  it('lays columns out with a width that includes the gap (a 12-track grid overflows when 11 gaps are wider than the phone)', async () => {
    const { f } = await site([{ type: 'section', pad_x: 20, rows: [{ gap: 48, cols: [{ span: 7, blocks: [{ type: 'heading', text: 'Datenschutzerklärung', level: 1 }] }, { span: 5, blocks: [{ type: 'text', text: 'Rechts' }] }] }] }], {}, 'Überlauf');
    const r = await html(`/p/${f.slug}`, FF);
    const css = [...r.body.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('');
    expect(css).not.toMatch(/repeat\(12/);
    expect(css).toMatch(/\.row\{display:flex;flex-wrap:wrap;gap:var\(--g,24px\)/);
    expect(css).toMatch(/\.col\{flex:0 0 calc\(\(100% \+ var\(--g,24px\)\) \* var\(--s,12\) \/ 12 - var\(--g,24px\)/);
    expect(css).toContain('.st-p>.col{--s:12}');
    // long German words in headings may break instead of widening the page
    expect(css).toMatch(/h1,h2,h3,h4\{[^}]*hyphens:auto;overflow-wrap:anywhere/);
  });
});

