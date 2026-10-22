import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { resolveStatus } from '../server/modules/blog.js';
import { cssUrl, excerptOf, readingMinutes, renderMarkdown, stripMarkdown, videoEmbed } from '../server/services/markdown.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
let site: any;
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  site = (await t.api.post('/api/funnels', { name: 'Maler Meier', kind: 'website', template: 'website' })).data;
  await t.api.patch(`/api/funnels/${site.id}`, { settings: { site_name: 'Maler Meier', color: '#16a34a', description: 'Malerbetrieb in Köln', head_code: '<!-- tracking -->' } });
});
afterAll(async () => {
  await t.close();
});

/** fetch() can't set Host, so custom-domain requests go through node:http. */
const viaHost = (path: string, host: string) =>
  new Promise<{ status: number; body: string; type: string }>((resolve, reject) => {
    const u = new URL(t.base);
    request({ host: u.hostname, port: u.port, path, headers: { host } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b, type: String(res.headers['content-type']) }));
    })
      .on('error', reject)
      .end();
  });

describe('markdown', () => {
  it('renders the supported syntax and escapes everything else', () => {
    const out = renderMarkdown('# Titel\n\nText **fett** und *kursiv* mit [Link](https://x.de/?a=1&b=2).\n\n- eins\n- zwei\n\n1. a\n2. b\n\n> Zitat\n\n```\n<b>code</b>\n```\n\n<script>alert(1)</script>\n\n[böse](javascript:alert(1))\n\n![Bild](https://img.example/a.png)');
    expect(out).toContain('<h2>Titel</h2>');
    expect(out).toContain('<strong>fett</strong>');
    expect(out).toContain('<em>kursiv</em>');
    expect(out).toContain('href="https://x.de/?a=1&amp;b=2"');
    expect(out).toContain('<ul><li>eins</li><li>zwei</li></ul>');
    expect(out).toContain('<ol><li>a</li><li>b</li></ol>');
    expect(out).toContain('<blockquote><p>Zitat</p></blockquote>');
    expect(out).toContain('<pre><code>&lt;b&gt;code&lt;/b&gt;</code></pre>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('<img src="https://img.example/a.png" alt="Bild" loading="lazy">');
    expect(renderMarkdown('https://youtu.be/dQw4w9WgXcQ', { embeds: true })).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(renderMarkdown('https://youtu.be/dQw4w9WgXcQ')).toContain('<a href="https://youtu.be/dQw4w9WgXcQ"');
  });

  it('recognises video links and builds plain-text excerpts', () => {
    expect(videoEmbed('https://www.youtube.com/watch?v=abcdefghijk')).toEqual({ kind: 'iframe', src: 'https://www.youtube-nocookie.com/embed/abcdefghijk?rel=0' });
    expect(videoEmbed('https://vimeo.com/76979871')?.src).toBe('https://player.vimeo.com/video/76979871');
    expect(videoEmbed('https://cdn.example.com/kurs/lektion1.mp4')).toEqual({ kind: 'video', src: 'https://cdn.example.com/kurs/lektion1.mp4' });
    expect(videoEmbed('http://insecure.example/a.mp4')).toBeNull();
    expect(videoEmbed('https://example.com/page')).toBeNull();
    expect(stripMarkdown('## Hallo **Welt**\n\n- [Link](https://x.de)')).toBe('Hallo Welt Link');
    expect(excerptOf('Wort '.repeat(100), 30).endsWith('…')).toBe(true);
    expect(readingMinutes('wort '.repeat(1000))).toBe(5);
    expect(cssUrl("https://x.de/a'b).png")).toBe('https://x.de/a%27b%29.png');
    expect(cssUrl('javascript:alert(1)')).toBe('#');
  });
});

describe('blog status', () => {
  const at = new Date('2026-10-04T10:00:00Z');
  it('turns requests into draft / scheduled / published', () => {
    expect(resolveStatus('draft', null, at)).toEqual({ status: 'draft', publish_at: null, published_at: null });
    expect(resolveStatus('published', null, at)).toMatchObject({ status: 'published', published_at: at.toISOString() });
    expect(resolveStatus('published', '2026-10-10T08:00:00Z', at)).toMatchObject({ status: 'scheduled', publish_at: '2026-10-10T08:00:00.000Z', published_at: null });
    expect(resolveStatus('scheduled', '2026-10-01T08:00:00Z', at)).toMatchObject({ status: 'published', published_at: '2026-10-01T08:00:00.000Z' });
    expect(() => resolveStatus('scheduled', null, at)).toThrow(/datum/);
    expect(() => resolveStatus('irgendwas', null, at)).toThrow();
  });
});

describe('blog', () => {
  let post: any;

  it('keeps drafts private but previewable', async () => {
    const r = await t.api.post(`/api/funnels/${site.id}/posts`, { title: 'Wände streichen wie ein Profi', content: '## Vorbereitung\n\nAbkleben ist alles.', tags: ['Tipps', 'Innen'], cover_image: 'https://img.example/wand.jpg' });
    expect(r.status).toBe(200);
    post = r.data;
    expect(post).toMatchObject({ status: 'draft', slug: 'wande-streichen-wie-ein-profi', author: 'Chef' });
    expect((await t.api.get(`/p/${site.slug}/blog/${post.slug}`)).status).toBe(404);
    const prev = await t.api.get(new URL(post.preview_url).pathname + new URL(post.preview_url).search);
    expect(prev.status).toBe(200);
    expect(prev.data).toContain('Vorschau');
    expect(prev.data).toContain('noindex');
    expect((await t.api.get(`/p/${site.slug}/blog/${post.slug}?preview=falsch`)).status).toBe(404);
    // The index exists as soon as the site has a blog, but lists only published posts.
    const idx = await t.api.get(`/p/${site.slug}/blog`);
    expect(idx.status).toBe(200);
    expect(idx.data).not.toContain('Wände streichen');
  });

  it('gives every post a unique address', async () => {
    const a = (await t.api.post(`/api/funnels/${site.id}/posts`, { title: 'Farbe wählen' })).data;
    const b = (await t.api.post(`/api/funnels/${site.id}/posts`, { title: 'Farbe wählen' })).data;
    expect(a.slug).toBe('farbe-wahlen');
    expect(b.slug).toBe('farbe-wahlen-2');
    const clash = await t.api.patch(`/api/funnels/${site.id}/posts/${b.id}`, { slug: 'farbe-wahlen' });
    expect(clash.status).toBe(400);
    expect((await t.api.patch(`/api/funnels/${site.id}/posts/${b.id}`, { slug: 'Farbtöne im Herbst' })).data.slug).toBe('farbtone-im-herbst');
    expect((await t.api.post(`/api/funnels/${site.id}/posts`, { title: '' })).status).toBe(400);
    await t.api.del(`/api/funnels/${site.id}/posts/${a.id}`);
    await t.api.del(`/api/funnels/${site.id}/posts/${b.id}`);
  });

  it('publishes with canonical, Open Graph and structured data', async () => {
    const r = await t.api.patch(`/api/funnels/${site.id}/posts/${post.id}`, { status: 'published', excerpt: 'So wird es streifenfrei.', seo: { description: 'Profi-Tipps zum Streichen' } });
    expect(r.data.status).toBe('published');
    expect(r.data.published_at).toBeTruthy();
    const page = await t.api.get(`/p/${site.slug}/blog/${post.slug}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain('sandbox');
    const html = page.data as string;
    expect(html).toContain(`<link rel="canonical" href="http://localhost/p/${site.slug}/blog/${post.slug}">`);
    expect(html).toContain('<meta property="og:type" content="article">');
    expect(html).toContain('<meta property="og:image" content="https://img.example/wand.jpg">');
    expect(html).toContain('<meta property="og:description" content="Profi-Tipps zum Streichen">');
    expect(html).toContain('<meta property="article:tag" content="Tipps">');
    expect(html).toContain('"@type":"BlogPosting"');
    expect(html).toContain('<h2>Vorbereitung</h2>');
    expect(html).toContain('--brand: #16a34a');
    expect(html).toContain('<!-- tracking -->');
    expect(html).toContain('application/rss+xml');
    const list = (await t.api.get(`/api/funnels/${site.id}/posts`)).data;
    expect(list[0].views).toBe(1);
    // Saving again (the editor always sends status and date) keeps the publish date.
    const again = await t.api.patch(`/api/funnels/${site.id}/posts/${post.id}`, { status: 'published', publish_at: null, author: 'Paul' });
    expect(again.data.published_at).toBe(r.data.published_at);
    expect(again.data.author).toBe('Paul');
  });

  it('lists posts with tag filter and pagination', async () => {
    for (let i = 1; i <= 10; i++) await t.api.post(`/api/funnels/${site.id}/posts`, { title: `Beitrag ${i}`, content: `Text ${i}`, tags: i % 2 ? ['Außen'] : ['Innen'], status: 'published', publish_at: new Date(Date.now() - i * 864e5).toISOString() });
    const p1 = (await t.api.get(`/p/${site.slug}/blog`)).data as string;
    expect(p1).toContain('Wände streichen wie ein Profi');
    expect(p1).toContain('Seite 1 von 2');
    expect(p1).toContain(`href="http://localhost/p/${site.slug}/blog?page=2"`);
    expect(p1).toContain('<link rel="canonical" href="http://localhost/p/' + site.slug + '/blog">');
    const p2 = (await t.api.get(`/p/${site.slug}/blog?page=2`)).data as string;
    expect(p2).toContain('Beitrag 10');
    expect(p2).not.toContain('Beitrag 1<');
    const innen = (await t.api.get(`/p/${site.slug}/blog?tag=Innen`)).data as string;
    expect(innen).toContain('Beitrag 2');
    expect(innen).not.toContain('Beitrag 3<');
    expect(innen).toContain('Wände streichen');
    const info = (await t.api.get(`/api/funnels/${site.id}/blog`)).data;
    expect(info.tags.find((x: any) => x.tag === 'Außen').n).toBe(5);
    expect(info.rss_url).toBe(`http://localhost/p/${site.slug}/blog/rss.xml`);
  });

  it('schedules posts and publishes them on the tick', async () => {
    const future = new Date(Date.now() + 3 * 864e5).toISOString();
    const r = await t.api.post(`/api/funnels/${site.id}/posts`, { title: 'Frühjahrsputz', content: 'Bald.', status: 'published', publish_at: future });
    expect(r.data.status).toBe('scheduled');
    expect(r.data.published_at).toBeNull();
    expect((await t.api.get(`/p/${site.slug}/blog/fruhjahrsputz`)).status).toBe(404);
    expect((await t.api.post(`/api/funnels/${site.id}/posts`, { title: 'Ohne Datum', status: 'scheduled' })).status).toBe(400);
    await t.app.tick();
    expect((await t.api.get(`/api/funnels/${site.id}/posts/${r.data.id}`)).data.status).toBe('scheduled');
    const published: any[] = [];
    t.app.events.on('blog.post_published', (e) => void published.push(e.data));
    t.app.db.run('UPDATE blog_posts SET publish_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), r.data.id);
    await t.app.tick();
    await t.app.events.flush();
    const after = (await t.api.get(`/api/funnels/${site.id}/posts/${r.data.id}`)).data;
    expect(after.status).toBe('published');
    expect(after.published_at).toBe(t.app.db.get('SELECT publish_at FROM blog_posts WHERE id = ?', r.data.id)!.publish_at);
    expect(published.map((p) => p.postId)).toContain(r.data.id);
    expect((await t.api.get(`/p/${site.slug}/blog/fruhjahrsputz`)).status).toBe(200);
  });

  it('serves an RSS feed of published posts', async () => {
    await t.api.post(`/api/funnels/${site.id}/posts`, { title: 'Geheimer Entwurf', content: 'psst' });
    const r = await t.api.raw(`/p/${site.slug}/blog/rss.xml`);
    expect(r.headers.get('content-type')).toContain('application/rss+xml');
    const xml = await r.text();
    expect(xml).toMatch(/^<\?xml version="1.0"/);
    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain(`<atom:link href="http://localhost/p/${site.slug}/blog/rss.xml" rel="self"`);
    expect(xml).toContain(`<link>http://localhost/p/${site.slug}/blog/${post.slug}</link>`);
    expect(xml).toContain('<category>Tipps</category>');
    expect(xml).toContain('<description>So wird es streifenfrei.</description>');
    expect(xml).toContain('<content:encoded><![CDATA[');
    expect(xml).not.toContain('Geheimer Entwurf');
    expect((xml.match(/<item>/g) ?? []).length).toBe(12);
  });

  it('adds published posts to the sitemap and serves the blog on the custom domain', async () => {
    const hidden = (await t.api.post(`/api/funnels/${site.id}/posts`, { title: 'Nur intern', status: 'published', seo: { noindex: true } })).data;
    await t.api.patch(`/api/funnels/${site.id}`, { domain: 'maler-meier.de' });
    const sm = await viaHost('/sitemap.xml', 'maler-meier.de');
    expect(sm.body).toContain('<loc>https://maler-meier.de/</loc>');
    expect(sm.body).toContain('<loc>https://maler-meier.de/blog</loc>');
    expect(sm.body).toContain(`<loc>https://maler-meier.de/blog/${post.slug}</loc>`);
    expect(sm.body).not.toContain('nur-intern');
    expect(sm.body).not.toContain('geheimer-entwurf');
    const idx = await viaHost('/blog', 'www.maler-meier.de');
    expect(idx.status).toBe(200);
    expect(idx.body).toContain('<link rel="canonical" href="https://maler-meier.de/blog">');
    const one = await viaHost(`/blog/${post.slug}`, 'maler-meier.de');
    expect(one.body).toContain(`<link rel="canonical" href="https://maler-meier.de/blog/${post.slug}">`);
    expect((await viaHost('/blog/rss.xml', 'maler-meier.de')).body).toContain(`<link>https://maler-meier.de/blog/${post.slug}</link>`);
    expect((await viaHost(`/blog/${hidden.slug}`, 'maler-meier.de')).body).toContain('noindex');
    // Pages of the website still work next to the blog.
    expect((await viaHost('/impressum', 'maler-meier.de')).status).toBe(200);
  });

  it('creates drafts through MCP by default', async () => {
    const key = (await t.api.post('/api/agency/api-keys', { name: 'Claude' })).data.key;
    const call = async (name: string, args: any) => {
      const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
      const res = (await r.json()).result;
      return res.isError ? { error: res.content[0].text } : JSON.parse(res.content[0].text);
    };
    const made = await call('ghl_create_blog_post', { location_id: t.api.location, funnel_id: site.id, title: 'Von Claude geschrieben', content: '# Hallo\n\nText', tags: ['KI'] });
    expect(made).toMatchObject({ status: 'draft', title: 'Von Claude geschrieben', tags: ['KI'] });
    const listed = await call('ghl_list_blog_posts', { location_id: t.api.location, status: 'draft' });
    expect(listed.some((p: any) => p.id === made.id && p.website === 'Maler Meier')).toBe(true);
  });

  it('removes posts with their website', async () => {
    const other = (await t.api.post('/api/funnels', { name: 'Zweitseite', kind: 'website', template: 'blank' })).data;
    await t.api.post(`/api/funnels/${other.id}/posts`, { title: 'Weg damit', status: 'published' });
    await t.api.del(`/api/funnels/${other.id}`);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM blog_posts WHERE funnel_id = ?', other.id)!.n).toBe(0);
    // Sites without posts don't get a /blog page.
    const fresh = (await t.api.post('/api/funnels', { name: 'Ohne Blog', kind: 'website', template: 'blank' })).data;
    expect((await t.api.get(`/p/${fresh.slug}/blog`)).status).toBe(404);
  });
});
