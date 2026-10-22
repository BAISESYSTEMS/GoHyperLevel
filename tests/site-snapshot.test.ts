import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { FF } from './site-fixtures.js';
import { applySnapshot, exportSnapshot, validateSnapshot } from '../server/services/snapshots.js';

/** Copying a site carries its layout, components, collections with entries and redirects – with every reference pointing at the copies. */

let t: Awaited<ReturnType<typeof startTestApp>>;
let home: string;
let other: string;
beforeAll(async () => {
  t = await startTestApp();
  const me = await t.setup();
  home = me.locations[0].id;
  other = (await t.api.post('/api/locations', { name: 'Zweite Firma' })).data.id;
  t.api.setLocation(home);
});
afterAll(() => t.close());

async function build() {
  const f = (await t.api.post('/api/funnels', { name: 'Original', kind: 'website', template: 'blank' })).data;
  const start = f.pages[0];
  const kontakt = (await t.api.post(`/api/funnels/${f.id}/pages`, { name: 'Kontakt', slug: 'kontakt' })).data;
  const nf = (await t.api.post(`/api/funnels/${f.id}/pages`, { name: 'Nicht gefunden', slug: 'weg' })).data;
  const comp = (await t.api.post('/api/site-components', { name: 'Kopfzeile', blocks: [{ type: 'heading', text: 'Mein Symbol', level: 2 }, { type: 'button', text: 'Kontakt', url: `page:${kontakt.id}` }] })).data;
  const col = (await t.api.post(`/api/funnels/${f.id}/collections`, { preset: 'team', with_samples: true })).data;
  expect((await t.api.post(`/api/funnels/${f.id}/redirects`, { source: '/alt', target: '/kontakt', code: 301 })).status).toBeLessThan(300);
  expect(
    (
      await t.api.patch(`/api/funnels/${f.id}`, {
        settings: {
          menus: { main: [{ label: 'Start', url: `page:${start.id}` }, { label: 'Kontakt', url: `page:${kontakt.id}` }] },
          header: { enabled: true, brand: 'Original', menu: 'main' },
          not_found: { page_id: nf.id, heading: 'Weg', text: '' },
        },
      })
    ).status,
  ).toBe(200);
  expect((await t.api.patch(`/api/funnel-pages/${kontakt.id}`, { layout: { header: false, lang: 'de', group: 'kontakt' } })).status).toBe(200);
  expect(
    (
      await t.api.patch(`/api/funnel-pages/${start.id}`, {
        blocks: [
          { id: 'c1', type: 'component', component_id: comp.id },
          { id: 'c2', type: 'collection', collection_id: col.id, heading: 'Team' },
          { id: 'b1', type: 'button', text: 'Weiter', url: `page:${kontakt.id}` },
        ],
      })
    ).status,
  ).toBe(200);
  return { f, start, kontakt, nf, comp, col };
}

describe('site parts of a snapshot', () => {
  it('copies a site into another sub-account with all references on the copies', async () => {
    const src = await build();
    const snap = validateSnapshot(JSON.parse(JSON.stringify(exportSnapshot(t.app, home, { funnelIds: [src.f.id] }))));
    const part = (snap as any).site_parts as any[];
    expect(part).toHaveLength(1);
    expect(part[0].components.map((c: any) => c.name)).toEqual(['Kopfzeile']);
    expect(part[0].collections[0].items.length).toBeGreaterThan(1);

    const made = applySnapshot(t.app, other, snap);
    const nf = made.funnels[0];
    expect(nf.id).not.toBe(src.f.id);

    // pages: layout and references
    const pages = t.app.db.all('SELECT * FROM funnel_pages WHERE funnel_id = ?', nf.id);
    const pStart = pages.find((p: any) => p.slug === src.start.slug)!;
    const pKontakt = pages.find((p: any) => p.slug === 'kontakt')!;
    const pWeg = pages.find((p: any) => p.slug === 'weg')!;
    expect(JSON.parse(pKontakt.layout)).toEqual({ header: false, lang: 'de', group: 'kontakt' });
    const blocks = JSON.parse(pStart.blocks);
    const newComp = t.app.db.get('SELECT * FROM site_components WHERE id = ?', blocks[0].component_id)!;
    expect(newComp.location_id).toBe(other);
    expect(newComp.id).not.toBe(src.comp.id);
    expect(JSON.parse(newComp.blocks)[1].url).toBe(`page:${src.kontakt.id}`); // components are location-wide: page links by id stay
    const newCol = t.app.db.get('SELECT * FROM site_collections WHERE id = ?', blocks[1].collection_id)!;
    expect(newCol.location_id).toBe(other);
    expect(newCol.funnel_id).toBe(nf.id);
    expect(newCol.id).not.toBe(src.col.id);
    expect(blocks[2].url).toBe(`page:${pKontakt.id}`);

    // items, settings, redirects
    const n = (cid: string) => t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM site_items WHERE collection_id = ?', cid)!.n;
    expect(n(newCol.id)).toBe(n(src.col.id));
    expect(t.app.db.all('SELECT id FROM site_items WHERE collection_id = ? AND location_id != ?', newCol.id, other)).toEqual([]);
    const settings = JSON.parse(t.app.db.get('SELECT settings FROM funnels WHERE id = ?', nf.id)!.settings);
    expect(settings.menus.main.map((m: any) => m.url)).toEqual([`page:${pStart.id}`, `page:${pKontakt.id}`]);
    expect(settings.not_found.page_id).toBe(pWeg.id);
    const reds = t.app.db.all('SELECT source, target, code, hits FROM site_redirects WHERE funnel_id = ?', nf.id);
    expect(reds).toEqual([{ source: '/alt', target: '/kontakt', code: 301, hits: 0 }]);

    // the source is untouched
    expect(JSON.parse(t.app.db.get('SELECT blocks FROM funnel_pages WHERE id = ?', src.start.id)!.blocks)[0].component_id).toBe(src.comp.id);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM site_components WHERE location_id = ?', home)!.n).toBeGreaterThanOrEqual(1);
  });

  it('shares components when the copy stays in the same sub-account, and the copy renders', async () => {
    const src = await build();
    const before = t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM site_components WHERE location_id = ?', home)!.n;
    const made = applySnapshot(t.app, home, exportSnapshot(t.app, home, { funnelIds: [src.f.id] }));
    expect(t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM site_components WHERE location_id = ?', home)!.n).toBe(before);
    const html = await (await t.api.raw(`/p/${made.funnels[0].slug}`, { headers: FF })).text();
    expect(html).toContain('Mein Symbol');
    expect(html).toContain('Team'); // the collection block resolves to the copied collection
    // the copied page links to the copied contact page, not the original's
    const copies = t.app.db.all('SELECT id, slug FROM funnel_pages WHERE funnel_id = ?', made.funnels[0].id);
    expect(copies.some((p: any) => p.slug === 'kontakt')).toBe(true);
    expect(html).toContain(`/p/${made.funnels[0].slug}/kontakt`);
  });

  it('copies only the selected site and tolerates snapshots from before the page builder', async () => {
    const src = await build();
    const other2 = (await t.api.post('/api/locations', { name: 'Dritte Firma' })).data.id;
    const old = JSON.parse(JSON.stringify(exportSnapshot(t.app, home, { funnelIds: [src.f.id] })));
    delete old.site_parts;
    const made = applySnapshot(t.app, other2, validateSnapshot(old));
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM site_collections WHERE funnel_id = ?', made.funnels[0].id)!.n).toBe(0);
    // an export of another site does not carry this one's parts
    const only = exportSnapshot(t.app, home, { funnelIds: ['gibtsnicht'] }) as any;
    expect(only.site_parts).toEqual([]);
  });

  it('keeps placeholders of the product templates and forms of collection templates', async () => {
    const f = (await t.api.post('/api/funnels', { name: 'Shop', kind: 'website', template: 'blank' })).data;
    const col = (await t.api.post(`/api/funnels/${f.id}/collections`, { preset: 'products', with_samples: true })).data;
    const detail = t.app.db.get('SELECT detail_blocks FROM site_collections WHERE id = ?', col.id)!.detail_blocks;
    expect(detail).toContain('{{product.id}}');
    const made = applySnapshot(t.app, other, exportSnapshot(t.app, home, { funnelIds: [f.id] }));
    const copy = t.app.db.get('SELECT detail_blocks FROM site_collections WHERE funnel_id = ?', made.funnels[0].id)!;
    expect(copy.detail_blocks).toContain('{{product.id}}');
  });
});
