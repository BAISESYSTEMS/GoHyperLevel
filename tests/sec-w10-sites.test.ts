import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';

/**
 * Security review wave 10 – password-protected sites (server/modules/site-protect.ts, site search in site-routing.ts):
 * protected page text must not leak through the site search, a whole-site lock covers the site's blog, collections (CMS) and
 * search too, and the unlock limit (10 tries per address and lock in 10 minutes) holds against parallel requests.
 */

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
const unlockForm = (lock: string, password: string, back = '/') => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ lock, back, password }).toString(),
});

describe('site search and password-protected pages', () => {
  it('keeps the text of a page with its own password out of the search', async () => {
    const f = await newSite('Suche geschützt');
    const secret = f.pages[1];
    await t.api.patch(`/api/funnel-pages/${secret.id}`, { blocks: [{ id: 'h1', type: 'hero', heading: 'Mitgliederpreise Zwiebelkuchenrabatt', subheading: 'Nur für Mitglieder' }] });
    await t.api.patch(`/api/funnel-pages/${f.pages[0].id}`, { blocks: [{ id: 'h0', type: 'hero', heading: 'Willkommen Zwiebelkuchen offen', subheading: '' }] });
    await t.api.patch(`/api/funnels/${f.id}`, { settings: { search: { enabled: true } } });
    // Before the lock the page is found (the search works at all).
    expect((await visit(`/p/${f.slug}/search?q=zwiebelkuchenrabatt`)).html).toContain('Mitgliederpreise');
    const set = await t.api.put(`/api/funnels/${f.id}/locks`, { page_id: secret.id, password: 'sesam123' });
    expect(set.status).toBe(200);
    const hits = await visit(`/p/${f.slug}/search?q=zwiebelkuchenrabatt`);
    expect(hits.status).toBe(200);
    expect(hits.html).not.toContain('Mitgliederpreise');
    expect(hits.html).not.toContain('Zwiebelkuchenrabatt');
    expect(hits.html).not.toContain(`/${secret.slug}"`);
    // Open pages are still found.
    expect((await visit(`/p/${f.slug}/search?q=zwiebelkuchen`)).html).toContain('Willkommen Zwiebelkuchen offen');
    // Removing the lock brings the page back into the search.
    await t.api.del(`/api/funnels/${f.id}/locks/${set.data[0].id}`);
    expect((await visit(`/p/${f.slug}/search?q=zwiebelkuchenrabatt`)).html).toContain('Mitgliederpreise');
  });

  it('a whole-site lock also covers search, blog, collections and unknown paths – the right cookie opens them', async () => {
    const f = await newSite('Ganz geschützt');
    await t.api.patch(`/api/funnels/${f.id}`, { settings: { search: { enabled: true } } });
    const post = (await t.api.post(`/api/funnels/${f.id}/posts`, { title: 'Interner Ausblick Quartal', content: 'Vertraulicher Blogtext Kürbissuppe', status: 'published' })).data;
    expect(post.slug).toBeTruthy();
    const coll = (await t.api.post(`/api/funnels/${f.id}/collections`, { preset: 'projects', with_samples: true })).data;
    const items = (await t.api.get(`/api/site-collections/${coll.id}/items`)).data;
    const item = items[0];
    const paths = [`/p/${f.slug}/blog/${post.slug}`, `/p/${f.slug}/blog`, `/p/${f.slug}/blog/rss.xml`, `/p/${f.slug}/${coll.slug}`, `/p/${f.slug}/${coll.slug}/${item.slug}`, `/p/${f.slug}/search?q=kuerbissuppe`, `/p/${f.slug}/sitemap.xml`];
    // Open before the lock.
    expect((await visit(paths[0])).html).toContain('Kürbissuppe');
    expect((await visit(paths[4])).status).toBe(200);

    const set = await t.api.put(`/api/funnels/${f.id}/locks`, { password: 'ganzeseite' });
    expect(set.status).toBe(200);
    const lockId = set.data.find((l: any) => !l.page_id).id;
    for (const p of paths) {
      const r = await visit(p);
      expect(r.html, p).toContain('passwortgeschützt');
      expect(r.html, p).not.toContain('Kürbissuppe');
      expect(r.html, p).not.toContain('Interner Ausblick');
      expect(r.html, p).not.toContain(item.title);
      expect(r.headers.get('cache-control'), p).toContain('no-store');
      expect(r.headers.get('x-robots-tag'), p).toBe('noindex');
    }
    // Unknown paths do not reveal anything either; robots.txt stays readable.
    expect((await visit(`/p/${f.slug}/gibts/nicht`)).html).toContain('passwortgeschützt');
    expect((await visit(`/p/${f.slug}/robots.txt`)).html).toContain('User-agent');
    // The form sends the visitor back to the blog post after unlocking.
    const locked = await visit(paths[0]);
    expect(locked.html).toContain(`value="${lockId}"`);
    expect(locked.html).toContain(`value="${paths[0]}"`);

    const ok = await visit('/api/site-unlock', unlockForm(lockId, 'ganzeseite', paths[0]));
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe(paths[0]);
    const cookie = (ok.headers.get('set-cookie') ?? '').split(';')[0];
    const post2 = await visit(paths[0], { headers: { cookie } });
    expect(post2.status).toBe(200);
    expect(post2.html).toContain('Kürbissuppe');
    expect((await visit(paths[4], { headers: { cookie } })).html).toContain(item.title);
    expect((await visit(paths[5], { headers: { cookie } })).html).toContain('Interner Ausblick');
    expect((await visit(paths[1], { headers: { cookie } })).html).toContain('Interner Ausblick');

    // Removing the lock opens everything again.
    await t.api.del(`/api/funnels/${f.id}/locks/${lockId}`);
    expect((await visit(paths[0])).html).toContain('Kürbissuppe');
  });

  it('a page lock still wins over the site lock; page-only locks leave the rest of the site open', async () => {
    const f = await newSite('Seite und Site');
    const page = f.pages[1];
    const pageLock = (await t.api.put(`/api/funnels/${f.id}/locks`, { page_id: page.id, password: 'seite123' })).data[0];
    // Only a page lock: the blog stays open.
    const post = (await t.api.post(`/api/funnels/${f.id}/posts`, { title: 'Offener Beitrag', content: 'Öffentlicher Text', status: 'published' })).data;
    expect((await visit(`/p/${f.slug}/blog/${post.slug}`)).html).toContain('Öffentlicher Text');
    const site = (await t.api.put(`/api/funnels/${f.id}/locks`, { password: 'ganzeseite' })).data.find((l: any) => !l.page_id);
    const locked = await visit(`/p/${f.slug}/${page.slug}`);
    expect(locked.html).toContain(`value="${pageLock.id}"`);
    expect(locked.html).not.toContain(`value="${site.id}"`);
    const ok = await visit('/api/site-unlock', unlockForm(pageLock.id, 'seite123', `/p/${f.slug}/${page.slug}`));
    const cookie = (ok.headers.get('set-cookie') ?? '').split(';')[0];
    expect((await visit(`/p/${f.slug}/${page.slug}`, { headers: { cookie } })).html).not.toContain('passwortgeschützt');
    // The page cookie does not open the rest of the site.
    expect((await visit(`/p/${f.slug}/blog/${post.slug}`, { headers: { cookie } })).html).toContain('passwortgeschützt');
  });
});

describe('unlock limit', () => {
  it('counts every try before the password check, so parallel requests cannot get past 10', async () => {
    const f = await newSite('Parallel geraten');
    const page = f.pages[1];
    const lockId = (await t.api.put(`/api/funnels/${f.id}/locks`, { page_id: page.id, password: 'richtig-123' })).data[0].id;
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => visit('/api/site-unlock', unlockForm(lockId, `falsch-${i}`))));
    const wrong = results.filter((r) => r.status === 401).length;
    const blocked = results.filter((r) => r.status === 429).length;
    expect(wrong).toBeLessThanOrEqual(10);
    expect(wrong + blocked).toBe(30);
    // Once over the limit even the right password waits.
    const after = await visit('/api/site-unlock', unlockForm(lockId, 'richtig-123'));
    expect(after.status).toBe(429);
    expect(after.html).toContain('Zu viele Versuche');
  });

  it('a right password still opens after a few wrong ones and starts the count again', async () => {
    const f = await newSite('Vertippt');
    const page = f.pages[1];
    const lockId = (await t.api.put(`/api/funnels/${f.id}/locks`, { page_id: page.id, password: 'richtig-456' })).data[0].id;
    for (let i = 0; i < 9; i++) expect((await visit('/api/site-unlock', unlockForm(lockId, `falsch-${i}`))).status).toBe(401);
    expect((await visit('/api/site-unlock', unlockForm(lockId, 'richtig-456'))).status).toBe(303);
    // The count starts again after the right password.
    for (let i = 0; i < 9; i++) expect((await visit('/api/site-unlock', unlockForm(lockId, `nochmal-${i}`))).status).toBe(401);
    expect((await visit('/api/site-unlock', unlockForm(lockId, 'richtig-456'))).status).toBe(303);
  });
});
