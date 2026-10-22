import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { FF } from './site-fixtures.js';

/**
 * Lighthouse-style budgets for pages of the site builder: small HTML with the CSS of the blocks the page uses inlined (nothing
 * render-blocking, no web fonts), room reserved for every picture and video so nothing shifts while loading, and one `<main>`.
 */

const BUDGET = {
  html: 32_000, // bytes, uncompressed (the largest template page measures ~19 kB)
  gzip: 8_000,
  css: 16_000,
  js: 8_000, // inline script: menu, search, countdown, beacon – and the form's submit script on pages with a real form (~5.5 kB)
  dom: 1_200, // elements
};

let t: Awaited<ReturnType<typeof startTestApp>>;
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
});
afterAll(() => t.close());

const sum = (html: string, tag: 'style' | 'script') => [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g'))].reduce((n, m) => n + m[1].length, 0);
const cssOf = (html: string) => [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');

function audit(html: string, label: string) {
  const errors: string[] = [];
  const size = Buffer.byteLength(html);
  if (size > BUDGET.html) errors.push(`HTML ${size} B > ${BUDGET.html}`);
  const gz = gzipSync(html).length;
  if (gz > BUDGET.gzip) errors.push(`gzip ${gz} B > ${BUDGET.gzip}`);
  if (sum(html, 'style') > BUDGET.css) errors.push(`CSS ${sum(html, 'style')} B > ${BUDGET.css}`);
  if (sum(html, 'script') > BUDGET.js) errors.push(`JS ${sum(html, 'script')} B > ${BUDGET.js}`);
  const dom = (html.match(/<[a-z][a-z0-9-]*[\s>/]/gi) ?? []).length;
  if (dom > BUDGET.dom) errors.push(`DOM ${dom} elements > ${BUDGET.dom}`);
  // nothing render-blocking or from elsewhere: no stylesheet links, no external scripts, no web fonts
  if (/<link\b[^>]*rel=["']?stylesheet/i.test(html)) errors.push('external stylesheet');
  if (/<script\b[^>]*\bsrc=/i.test(html)) errors.push('external script');
  if (/@font-face|fonts\.googleapis|fonts\.gstatic|@import/i.test(html)) errors.push('web font or @import');
  // document basics
  if (!/^<!doctype html>/i.test(html)) errors.push('no doctype');
  if (!/<html lang="[a-z]{2}/.test(html)) errors.push('no lang');
  if (!/<meta charset=/i.test(html) && !/<meta http-equiv="content-type"/i.test(html)) errors.push('no charset');
  if (!/<meta name="viewport" content="[^"]*width=device-width/.test(html)) errors.push('no viewport');
  if (!/<title>[^<]+<\/title>/.test(html)) errors.push('no title');
  if ((html.match(/<main\b/g) ?? []).length !== 1) errors.push('not exactly one <main>');
  // layout shift: every picture has its size; only the first may skip lazy loading; frames sit in a box with a ratio
  for (const m of html.matchAll(/<img\b[^>]*>/g)) {
    if (!/\bwidth="\d+"/.test(m[0]) || !/\bheight="\d+"/.test(m[0])) errors.push(`img without width/height: ${m[0].slice(0, 80)}`);
    if (!/\balt="/.test(m[0])) errors.push(`img without alt: ${m[0].slice(0, 80)}`);
  }
  const eager = [...html.matchAll(/<img\b[^>]*>/g)].filter((m) => !/loading="lazy"/.test(m[0]) && !/data-eager/.test(m[0]));
  if (eager.length > 2) errors.push(`${eager.length} pictures load eagerly`);
  for (const m of html.matchAll(/<iframe\b[^>]*>/g)) if (!/loading="lazy"/.test(m[0])) errors.push(`iframe not lazy: ${m[0].slice(0, 80)}`);
  if (/<iframe\b/.test(html) && !/aspect-ratio/.test(cssOf(html))) errors.push('iframe without a reserved box');
  // CSS is minified
  const css = cssOf(html);
  if (/\/\*|\n\s*\n|;\s*}/.test(css)) errors.push('CSS not minified');
  return errors.length ? `${label}: ${errors.join('; ')}` : '';
}

describe('template pages stay within the budgets', () => {
  it('every page of every template (previews)', async () => {
    const h = { cookie: t.api.cookie, 'x-location-id': t.api.location, 'x-pghl': '1' };
    const list = (await t.api.get('/api/site-templates')).data.templates as { id: string; pages: { slug: string }[] }[];
    expect(list.length).toBeGreaterThanOrEqual(20);
    const bad: string[] = [];
    let pages = 0;
    for (const tp of list) {
      const meta = (await t.api.get(`/api/site-templates/${tp.id}`)).data;
      for (const p of meta.pages) {
        const r = await t.api.raw(`/api/site-templates/${tp.id}/preview?page=${p.slug}`, { headers: h });
        const msg = audit(await r.text(), `${tp.id}/${p.slug}`);
        if (msg) bad.push(msg);
        pages++;
      }
    }
    expect(pages).toBeGreaterThan(50);
    expect(bad, bad.join('\n')).toEqual([]);
  }, 120_000);

  it('a site made from a template, as a visitor gets it', async () => {
    const made = (await t.api.post('/api/site-templates/coach/apply', { name: 'Perf Coaching', legal: false })).data;
    const home = await (await t.api.raw(`/p/${made.slug}`, { headers: FF })).text();
    expect(audit(home, 'coach (public)')).toBe('');
    const kontakt = await (await t.api.raw(`/p/${made.slug}/kontakt`, { headers: FF })).text();
    expect(audit(kontakt, 'coach/kontakt (public)')).toBe('');
  });
});

describe('critical CSS is the CSS of the blocks on the page', () => {
  async function page(blocks: any[]) {
    const f = (await t.api.post('/api/funnels', { name: `CSS ${Math.random()}`, kind: 'website', template: 'blank' })).data;
    expect((await t.api.patch(`/api/funnel-pages/${f.pages[0].id}`, { blocks })).status).toBe(200);
    return (await t.api.raw(`/p/${f.slug}`, { headers: FF })).text();
  }

  it('leaves out what the page does not use and adds it when it does', async () => {
    const plain = await page([{ type: 'heading', text: 'Nur eine Zeile', level: 1 }]);
    const rich = await page([{ type: 'heading', text: 'Mehr', level: 1 }, { type: 'faq', items: [{ q: 'Frage', a: 'Antwort' }] }, { type: 'pricing', items: [{ name: 'Basis', price: '9 €', features: 'A' }] }, { type: 'video', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }]);
    const a = cssOf(plain);
    const b = cssOf(rich);
    expect(a).not.toContain('details{');
    expect(a).not.toContain('.price{');
    expect(a).not.toContain('.video{');
    expect(b).toContain('details{');
    expect(b).toContain('.price{');
    expect(b).toContain('.video{');
    expect(a.length).toBeLessThan(b.length);
    expect(a.length).toBeLessThan(9_500);
    expect(audit(plain, 'plain')).toBe('');
    expect(audit(rich, 'rich')).toBe('');
  });

  it('puts the first picture first in line and defers the rest, all with room reserved', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0, 0, 4, 0, 0, 0, 2, 0, 8, 2, 0, 0, 0]), Buffer.alloc(8)]);
    const up = (await t.api.post('/api/uploads', { name: 'p', data: `data:image/png;base64,${png.toString('base64')}` })).data;
    const html = await page([
      { type: 'hero', heading: 'Titel', image: up.url, image_alt: 'Eins' },
      { type: 'image', src: up.url, alt: 'Zwei' },
      { type: 'gallery', items: [{ src: up.url, alt: 'Drei' }, { src: up.url, alt: 'Vier' }] },
      { type: 'logos', items: [{ src: up.url, alt: 'Fünf' }] },
    ]);
    const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
    expect(imgs.length).toBeGreaterThanOrEqual(5);
    expect(imgs[0]).toContain('fetchpriority="high"');
    expect(imgs[0]).not.toContain('loading="lazy"');
    for (const i of imgs.slice(1)) expect(i).toContain('loading="lazy"');
    for (const i of imgs) expect(i).toContain('width="1024" height="512"');
    expect(audit(html, 'images')).toBe('');
  });
});
