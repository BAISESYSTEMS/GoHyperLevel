import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { connectStripe, fakeStripe } from './site-fixtures.js';
import { cleanData, cleanFields, cleanSettings, cleanValue, display, fillTemplate, listItems, PRESETS, type Field } from '../server/services/site-cms.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
const FF = { 'user-agent': 'Mozilla/5.0 (X11; Linux) Firefox/130' };
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
});
afterAll(() => t.close());

const get = async (path: string, headers: Record<string, string> = FF) => {
  const r = await t.api.raw(path, { headers });
  return { status: r.status, body: await r.text(), headers: r.headers };
};
const newSite = async (name = 'CMS-Test') => (await t.api.post('/api/funnels', { name, kind: 'website', template: 'blank' })).data;

describe('collection fields and values', () => {
  const fields: Field[] = [
    { key: 'title', label: 'Titel', type: 'text', required: true },
    { key: 'cat', label: 'Kategorie', type: 'select', options: ['A', 'B'], filterable: true },
    { key: 'tags', label: 'Tags', type: 'tags', filterable: true },
    { key: 'n', label: 'Zahl', type: 'number' },
    { key: 'on', label: 'Aktiv', type: 'bool', filterable: true },
    { key: 'img', label: 'Bild', type: 'image' },
    { key: 'day', label: 'Tag', type: 'date' },
    { key: 'mail', label: 'Mail', type: 'email' },
    { key: 'stars', label: 'Sterne', type: 'rating' },
  ];

  it('validates field definitions', () => {
    expect(cleanFields([{ key: 'Name', label: 'Name', type: 'text' }])[0].key).toBe('name');
    expect(() => cleanFields([{ key: 'id', type: 'text' }])).toThrow(/Feld-Schlüssel/);
    expect(() => cleanFields([{ key: '1abc', type: 'text' }])).toThrow(/Feld-Schlüssel/);
    expect(() => cleanFields([{ key: 'a', type: 'text' }, { key: 'a', type: 'text' }])).toThrow(/doppelt/);
    expect(() => cleanFields([{ key: 'a', type: 'select', options: [] }])).toThrow(/Option/);
    expect(() => cleanFields([])).toThrow(/Mindestens/);
    expect(cleanFields([{ key: 'a', type: 'bogus' }])[0].type).toBe('text');
    // only some types can be filtered
    expect(cleanFields([{ key: 'a', type: 'number', filterable: true }, { key: 'b', type: 'select', options: ['x'], filterable: true }]).map((f) => !!f.filterable)).toEqual([false, true]);
  });

  it('checks every type and hands back clean data', () => {
    const ok = cleanData(fields, { title: ' Hallo ', cat: 'A', tags: 'x, y,, x', n: '3,5', on: 'true', img: 'https://x.test/a.jpg', day: '2026-05-01', mail: 'a@b.de', stars: '4' });
    expect(ok).toEqual({ title: 'Hallo', cat: 'A', tags: ['x', 'y'], n: 3.5, on: true, img: 'https://x.test/a.jpg', day: '2026-05-01', mail: 'a@b.de', stars: 4 });
    const bad = (k: string, v: unknown) => () => cleanData(fields, { title: 'x', [k]: v });
    expect(bad('cat', 'Z')).toThrow(/Optionen/);
    expect(bad('img', 'javascript:alert(1)')).toThrow(/Adresse/);
    expect(bad('day', '31.12.2026')).toThrow(/Datum/);
    expect(bad('mail', 'kein-mail')).toThrow(/E-Mail/);
    expect(bad('n', 'abc')).toThrow(/Zahl/);
    expect(bad('stars', 9)).toThrow(/Sterne/);
    expect(() => cleanData(fields, {})).toThrow(/Titel/);
    // fields that were removed disappear, untouched fields keep their value on a partial update
    expect(cleanData(fields.slice(0, 2), { cat: 'B' }, undefined, { title: 'Alt', cat: 'A', alt: 1 })).toEqual({ title: 'Alt', cat: 'B' });
    expect(() => cleanValue({ key: 'p', label: 'P', type: 'product' }, 'x', () => false)).toThrow(/Produkt/);
    expect(cleanValue({ key: 'p', label: 'P', type: 'product' }, 'x', () => true)).toBe('x');
  });

  it('shows values the German way', () => {
    expect(display(fields[6], '2026-05-01')).toBe('01.05.2026');
    expect(display(fields[4], true)).toBe('Ja');
    expect(display(fields[3], 1234.5)).toBe('1.234,5');
    expect(display(fields[2], ['a', 'b'])).toBe('a, b');
    expect(display(fields[8], 3)).toBe('★★★☆☆');
  });

  it('fills {{placeholders}} in texts only – never in html blocks, keys or from record values', () => {
    const settings = cleanSettings({}, fields);
    const view = { id: '1', slug: 'hallo', url: 'https://s.de/x/hallo', data: { title: 'Hallo {{title}}', cat: 'A', day: '2026-05-01' } };
    const out: any = fillTemplate(
      [{ type: 'heading', text: '{{title}} – {{cat}} am {{day}} ({{ unbekannt }})' }, { type: 'html', html: '<p>{{title}}</p>' }, { type: 'button', url: '{{url}}', text: '{{collection}} / {{site}}' }],
      view,
      fields,
      settings,
      { collection: 'Projekte', site: 'Meine Seite' },
    );
    // a record value that contains a placeholder is not expanded a second time
    expect(out[0].text).toBe('Hallo {{title}} – A am 01.05.2026 ()');
    expect(out[1].html).toBe('<p>{{title}}</p>');
    expect(out[2]).toMatchObject({ url: 'https://s.de/x/hallo', text: 'Projekte / Meine Seite' });
  });

  it('filters, searches, sorts and pages a list', () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ data: { title: `Eintrag ${i}`, cat: i % 2 ? 'A' : 'B', tags: i % 5 === 0 ? ['neu'] : [], on: i < 3, n: 100 - i }, position: i, published_at: null }));
    expect(listItems(items, fields, { filters: { cat: 'A' } }).total).toBe(12);
    expect(listItems(items, fields, { filters: { tags: 'neu' } }).total).toBe(5);
    expect(listItems(items, fields, { filters: { on: '1' } }).total).toBe(3);
    // a field that is not filterable is ignored
    expect(listItems(items, fields, { filters: { n: '100' } }).total).toBe(25);
    expect(listItems(items, fields, { q: 'eintrag 1' }).total).toBe(11);
    const sorted = listItems(items, fields, { sort: 'n', dir: 'asc', per: 5 });
    expect(sorted.rows.map((r) => r.data.n)).toEqual([76, 77, 78, 79, 80]);
    expect(sorted.pages).toBe(5);
    expect(listItems(items, fields, { page: 99, per: 10 }).page).toBe(3);
  });

  it('ships six presets with valid fields, settings and detail templates', () => {
    expect(PRESETS.map((p) => p.key)).toEqual(['team', 'projects', 'products', 'testimonials', 'faq', 'jobs']);
    for (const p of PRESETS) {
      const f = cleanFields(p.fields);
      const s = cleanSettings(p.settings, f);
      expect(s.title_field, p.key).toBeTruthy();
      for (const sample of p.samples) expect(() => cleanData(f, sample), p.key).not.toThrow();
      expect(Array.isArray(p.detail())).toBe(true);
    }
  });
});

describe('collections on a website', () => {
  it('serves list, filters, record pages, sitemap and search from a preset; drafts stay private', async () => {
    const f = await newSite('Handwerk-CMS');
    const presets = (await t.api.get(`/api/funnels/${f.id}/collection-presets`)).data;
    expect(presets.presets).toHaveLength(6);
    const c = (await t.api.post(`/api/funnels/${f.id}/collections`, { preset: 'projects', with_samples: true })).data;
    expect(c).toMatchObject({ name: 'Projekte & Referenzen', slug: 'projekte', items: 3, published: 3 });
    expect(c.url).toBe(`http://localhost/p/${f.slug}/projekte`);

    const list = await get(`/p/${f.slug}/projekte`);
    expect(list.status).toBe(200);
    expect(list.body).toContain('Einfamilienhaus in Stadtnähe');
    expect(list.body).toContain('class="cfilter"');
    expect(list.body).toContain('Alle Kategorie');
    expect(list.headers.get('content-security-policy')).toContain('sandbox');
    const filtered = await get(`/p/${f.slug}/projekte?f_category=Sanierung`);
    expect(filtered.body).toContain('Altbau mit neuem Gesicht');
    expect(filtered.body).not.toContain('Einfamilienhaus in Stadtnähe');
    expect(filtered.body).toContain('class="chip on"');
    const searched = await get(`/p/${f.slug}/projekte?q=dachgeschoss`);
    expect(searched.body).toContain('Dachgeschoss-Ausbau');
    expect(searched.body).not.toContain('Altbau mit neuem Gesicht');
    // sort: newest first (date, desc)
    expect(list.body.indexOf('Einfamilienhaus')).toBeLessThan(list.body.indexOf('Altbau'));

    // a record page from the detail template
    const items = (await t.api.get(`/api/site-collections/${c.id}/items`)).data;
    const first = items.find((i: any) => i.title === 'Altbau mit neuem Gesicht');
    expect(first.url).toBe(`http://localhost/p/${f.slug}/projekte/${first.slug}`);
    const detail = await get(`/p/${f.slug}/projekte/${first.slug}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toContain('<h1>Altbau mit neuem Gesicht</h1>');
    expect(detail.body).toContain('<strong>Sanierung</strong> · 01.03.2026 · Muster GmbH');
    expect(detail.body).toContain('<title>Altbau mit neuem Gesicht</title>');
    expect(detail.body).toContain(`<link rel="canonical" href="http://localhost/p/${f.slug}/projekte/${first.slug}">`);
    expect(detail.body).toContain('Ihr Projekt ist das nächste?');
    // draft → 404, published → 200
    const draft = (await t.api.post(`/api/site-collections/${c.id}/items`, { data: { title: 'Geheimes Projekt', category: 'Neubau' }, status: 'draft' })).data;
    expect((await get(`/p/${f.slug}/projekte/${draft.slug}`)).status).toBe(404);
    expect((await get(`/p/${f.slug}/projekte`)).body).not.toContain('Geheimes Projekt');
    expect((await get(`/p/${f.slug}/sitemap.xml`)).body).not.toContain(draft.slug);
    await t.api.patch(`/api/site-items/${draft.id}`, { status: 'published' });
    expect((await get(`/p/${f.slug}/projekte/${draft.slug}`)).status).toBe(200);
    // sitemap and search
    const sm = (await get(`/p/${f.slug}/sitemap.xml`)).body;
    expect(sm).toContain(`<loc>http://localhost/p/${f.slug}/projekte</loc>`);
    expect(sm).toContain(`<loc>http://localhost/p/${f.slug}/projekte/${draft.slug}</loc>`);
    await t.api.patch(`/api/funnels/${f.id}`, { settings: { search: { enabled: true } } });
    expect((await get(`/p/${f.slug}/search?q=dachgeschoss`)).body).toContain('Dachgeschoss-Ausbau');
    // unknown records and collections are the site's 404
    expect((await get(`/p/${f.slug}/projekte/gibts-nicht`)).status).toBe(404);
    expect((await get(`/p/${f.slug}/nix/gibts-nicht`)).status).toBe(404);
    expect((await get(`/p/${f.slug}/projekte/a/b/c`)).status).toBe(404);
    // noindex collection stays out of sitemap and search
    await t.api.patch(`/api/site-collections/${c.id}`, { settings: { indexable: false } });
    expect((await get(`/p/${f.slug}/sitemap.xml`)).body).not.toContain('/projekte');
    expect((await get(`/p/${f.slug}/search?q=dachgeschoss`)).body).not.toContain('Dachgeschoss-Ausbau');
  });

  it('places a collection anywhere as a block, with limit, filter and layout', async () => {
    const f = await newSite('Team-Block');
    const c = (await t.api.post(`/api/funnels/${f.id}/collections`, { preset: 'team', with_samples: true })).data;
    await t.api.patch(`/api/funnel-pages/${f.pages[0].id}`, { blocks: [{ type: 'collection', collection_id: c.id, heading: 'Unser Team', limit: 2, columns: 2 }, { type: 'collection', collection_id: c.id, filter_field: 'department', filter_value: 'Service', layout: 'list', heading: 'Service' }] });
    const h = (await get(`/p/${f.slug}`)).body;
    expect(h).toContain('<h2>Unser Team</h2>');
    expect(h).toContain('style="--cc:2"');
    expect(h.match(/<article class="ccard/g)!.length).toBe(3);
    expect(h).toContain('cgrid lst');
    expect(h).toContain('Clara Probe');
    expect(h).toContain('.ccard{display:flex');
    // another site's collection renders nothing
    const g = await newSite('Anderer Block');
    await t.api.patch(`/api/funnel-pages/${g.pages[0].id}`, { blocks: [{ type: 'collection', collection_id: c.id, heading: 'Fremdes Team' }, { type: 'text', text: 'bleibt' }] });
    const gh = (await get(`/p/${g.slug}`)).body;
    expect(gh).not.toContain('Fremdes Team');
    expect(gh).toContain('bleibt');
  });

  it('guards paths, field types and limits', async () => {
    const f = await newSite('Regeln');
    await t.api.post(`/api/funnels/${f.id}/pages`, { name: 'Team', slug: 'team' });
    expect((await t.api.post(`/api/funnels/${f.id}/collections`, { preset: 'team' })).data.error).toMatch(/schon eine Seite/);
    expect((await t.api.post(`/api/funnels/${f.id}/collections`, { name: 'Blog', slug: 'blog', fields: [{ key: 'a', type: 'text' }] })).status).toBe(400);
    expect((await t.api.post(`/api/funnels/${f.id}/collections`, { name: 'Leer', fields: [] })).status).toBe(400);
    const c = (await t.api.post(`/api/funnels/${f.id}/collections`, { name: 'Dinge', fields: [{ key: 'name', label: 'Name', type: 'text', required: true }, { key: 'zahl', label: 'Zahl', type: 'number' }] })).data;
    expect(c.slug).toBe('dinge');
    expect((await t.api.post(`/api/funnels/${f.id}/collections`, { name: 'Dinge 2', slug: 'dinge', fields: [{ key: 'name', type: 'text' }] })).data.error).toMatch(/schon eine Sammlung/);
    const it = (await t.api.post(`/api/site-collections/${c.id}/items`, { data: { name: 'Eins' }, status: 'published' })).data;
    expect(it.slug).toBe('eins');
    expect((await t.api.post(`/api/site-collections/${c.id}/items`, { data: {} })).data.error).toMatch(/Name/);
    const dup = (await t.api.post(`/api/site-collections/${c.id}/items`, { data: { name: 'Eins' } })).data;
    expect(dup.slug).toBe('eins-2');
    expect((await t.api.patch(`/api/site-items/${dup.id}`, { slug: 'eins' })).status).toBe(400);
    // changing a field's type with records is refused, adding a field is fine
    const retype = await t.api.patch(`/api/site-collections/${c.id}`, { fields: [{ key: 'name', label: 'Name', type: 'longtext' }, { key: 'zahl', type: 'number' }] });
    expect(retype.status).toBe(400);
    const more = await t.api.patch(`/api/site-collections/${c.id}`, { fields: [{ key: 'name', label: 'Name', type: 'text', required: true }, { key: 'zahl', type: 'number' }, { key: 'extra', label: 'Extra', type: 'text' }] });
    expect(more.status).toBe(200);
    expect(more.data.fields).toHaveLength(3);
    const copy = (await t.api.post(`/api/site-items/${it.id}/duplicate`)).data;
    expect(copy).toMatchObject({ status: 'draft', slug: 'eins-kopie' });
    expect((await t.api.put(`/api/site-collections/${c.id}/order`, { ids: [copy.id, it.id, dup.id] })).status).toBe(200);
    expect((await t.api.get(`/api/site-collections/${c.id}/items`)).data.map((x: any) => x.slug)).toEqual(['eins-kopie', 'eins', 'eins-2']);
    // a record page keeps working for a record without the optional fields; text with markup is escaped
    await t.api.patch(`/api/site-items/${it.id}`, { data: { name: '<img src=x onerror=alert(1)>' } });
    const page = (await get(`/p/${f.slug}/dinge/eins`)).body;
    expect(page).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(page).not.toContain('<img src=x');
    // delete cascades
    expect((await t.api.del(`/api/site-collections/${c.id}`)).status).toBe(200);
    expect((await get(`/p/${f.slug}/dinge/eins`)).status).toBe(404);
  });

  it('product fields link to the buy page of a product of this sub-account only', async () => {
    fakeStripe();
    await connectStripe(t);
    const f = await newSite('Produkte-CMS');
    const prod = (await t.api.post('/api/products', { name: 'Coaching-Paket', price_cents: 49000 })).data;
    const c = (await t.api.post(`/api/funnels/${f.id}/collections`, { preset: 'products' })).data;
    const bad = await t.api.post(`/api/site-collections/${c.id}/items`, { data: { name: 'X', product: 'gibtsnicht' } });
    expect(bad.status).toBe(400);
    const it = (await t.api.post(`/api/site-collections/${c.id}/items`, { data: { name: 'Coaching', category: 'Beratung', description: 'Persönlich', product: prod.id }, status: 'published' })).data;
    const h = (await get(`/p/${f.slug}/angebote/${it.slug}`)).body;
    expect(h).toContain('<h1>Coaching</h1>');
    expect(h).toContain('Coaching-Paket');
    expect(h).toContain(`/buy/${prod.id}`);
    expect(h).toMatch(/\d{3},\d{2}\s€/);
    expect(h).toContain('Zur Bestellung');
    // the other sub-account's product id is refused
    const other = (await t.api.post('/api/locations', { name: 'Fremd-Shop' })).data.id;
    const foreign = (await t.api.post('/api/products', { name: 'Fremdprodukt', price_cents: 100 }, { 'x-location-id': other })).data;
    expect((await t.api.post(`/api/site-collections/${c.id}/items`, { data: { name: 'Y', product: foreign.id } })).status).toBe(400);
  });

  it('keeps collections of another sub-account out of reach', async () => {
    const f = await newSite('Isolation-CMS');
    const c = (await t.api.post(`/api/funnels/${f.id}/collections`, { preset: 'faq', with_samples: true })).data;
    const other = (await t.api.post('/api/locations', { name: 'Nachbar' })).data.id;
    const h = { 'x-location-id': other };
    expect((await t.api.get(`/api/site-collections/${c.id}`, h)).status).toBe(404);
    expect((await t.api.get(`/api/site-collections/${c.id}/items`, h)).status).toBe(404);
    expect((await t.api.get(`/api/funnels/${f.id}/collections`, h)).status).toBe(404);
    expect((await t.api.post(`/api/site-collections/${c.id}/items`, { data: { question: 'q', answer: 'a' } }, h)).status).toBe(404);
    const item = (await t.api.get(`/api/site-collections/${c.id}/items`)).data[0];
    expect((await t.api.patch(`/api/site-items/${item.id}`, { status: 'draft' })).status).toBe(200);
    const mine = t.api.location;
    t.api.setLocation(other);
    expect((await t.api.del(`/api/site-items/${item.id}`)).status).toBe(404);
    expect((await t.api.patch(`/api/site-items/${item.id}`, { status: 'published' })).status).toBe(404);
    expect((await t.api.del(`/api/site-collections/${c.id}`)).status).toBe(404);
    t.api.setLocation(mine);
    expect((await t.api.get(`/api/site-collections/${c.id}/items`)).data.length).toBe(2);
  });
});
