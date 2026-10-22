import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { validateSnapshot, snapshotSummary } from '../server/services/snapshots.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n%test\n').toString('base64');

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
});
afterAll(async () => {
  await t.close();
});

const db = () => t.app.db;
const count = (sql: string, ...args: any[]) => db().get<{ n: number }>(sql, ...args)!.n;

describe('blog posts, courses and community in snapshots and copies', () => {
  let src = '';
  let site: any, course: any, group: any, product: any, upload: any, wf: any;

  it('builds a source account with content', async () => {
    src = t.api.location;
    site = (await t.api.post('/api/funnels', { name: 'Meine Website', kind: 'website' })).data;
    await t.api.post(`/api/funnels/${site.id}/posts`, { title: 'Erster Artikel', content: '# Hallo\n\nText', status: 'published', tags: ['news'], seo: { title: 'SEO-Titel' } });
    await t.api.post(`/api/funnels/${site.id}/posts`, { title: 'Entwurf', content: 'kommt noch' });

    product = (await t.api.post('/api/products', { name: 'Kurs-Paket', price_cents: 9900 })).data;
    upload = (await t.api.post('/api/uploads', { name: 'Workbook.pdf', data: PDF })).data;
    course = (await t.api.post('/api/courses', { title: 'Starter-Kurs' })).data;
    const full = (await t.api.get(`/api/courses/${course.id}`)).data;
    const mod2 = (await t.api.post(`/api/courses/${course.id}/modules`, { title: 'Woche 2', drip_days: 7 })).data;
    await t.api.post(`/api/courses/${course.id}/lessons`, { module_id: mod2.id, title: 'Vertiefung', video_url: 'https://youtu.be/dQw4w9WgXcQ', downloads: [{ upload_id: upload.id, name: 'Arbeitsbuch' }], duration_min: 15 });
    await t.api.patch(`/api/courses/${course.id}`, { status: 'published', access: { tags: ['kurs:starter'], product_ids: [product.id] } });
    const anna = (await t.api.post('/api/contacts', { email: 'anna@example.de' })).data;
    await t.api.post(`/api/courses/${course.id}/enrollments`, { contact_id: anna.id });
    const enr = db().get('SELECT id FROM course_enrollments WHERE course_id = ?', course.id)!;
    db().run('INSERT INTO course_progress (enrollment_id, lesson_id, completed_at) VALUES (?, ?, ?)', enr.id, full.modules[0].lessons[0].id, new Date().toISOString());

    group = (await t.api.post('/api/community/groups', { name: 'Starter-Community', access: { mode: 'courses', course_ids: [course.id] }, settings: { word_filter: ['spam'], level_unlocks: [{ level: 2, course_id: course.id }] } })).data;
    await t.api.post(`/api/community/groups/${group.id}/channels`, { name: 'Erfolge', category: 'Austausch', emoji: '🏆' });
    await t.api.post(`/api/community/groups/${group.id}/posts`, { title: 'Willkommen', body: 'Hallo zusammen' });

    wf = (await t.api.post('/api/workflows', { name: 'Neuer Beitrag → Kurs', trigger: { type: 'community.post_created', config: { group_id: group.id } }, steps: [{ type: 'course_grant', course_id: course.id }] })).data;
    expect(count('SELECT COUNT(*) AS n FROM blog_posts WHERE location_id = ?', src)).toBe(2);
  });

  it('round-trips through a snapshot into a new client', async () => {
    const snap = (await t.api.post('/api/snapshots', { location_id: src, name: 'Vorlage' })).data;
    expect(snap.summary).toMatchObject({ funnels: 1, blog_posts: 2, courses: 1, lessons: 2, community_groups: 1, products: 1, workflows: 1 });

    const r = (await t.api.post('/api/agency/clients', { name: 'Neukunde', snapshot_id: snap.id })).data;
    const dst = r.location.id;
    expect(r.created.blog_posts).toBe(2);
    expect(r.created.courses).toHaveLength(1);
    expect(r.created.community_groups).toHaveLength(1);

    // Blog posts sit on the copied website, same addresses, status kept, no views.
    const newSite = db().get('SELECT * FROM funnels WHERE location_id = ?', dst)!;
    const posts = db().all('SELECT * FROM blog_posts WHERE location_id = ? ORDER BY title', dst);
    expect(posts.map((p) => [p.title, p.slug, p.status, p.funnel_id, p.views])).toEqual([
      ['Entwurf', 'entwurf', 'draft', newSite.id, 0],
      ['Erster Artikel', 'erster-artikel', 'published', newSite.id, 0],
    ]);
    expect(JSON.parse(posts[1].seo).title).toBe('SEO-Titel');

    // Course with modules and lessons, but no members or progress.
    const c = db().get('SELECT * FROM courses WHERE location_id = ?', dst)!;
    expect(c).toMatchObject({ title: 'Starter-Kurs', slug: 'starter-kurs', status: 'published' });
    expect(count('SELECT COUNT(*) AS n FROM course_modules WHERE course_id = ?', c.id)).toBe(2);
    const lessons = db().all('SELECT * FROM course_lessons WHERE course_id = ? ORDER BY position, created_at', c.id);
    expect(lessons.map((l) => l.title).sort()).toEqual(['Vertiefung', 'Willkommen']);
    expect(lessons.every((l) => l.location_id === dst)).toBe(true);
    expect(count('SELECT COUNT(*) AS n FROM course_enrollments WHERE course_id = ?', c.id)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM course_enrollments WHERE location_id = ?', dst)).toBe(0);
    // The download file now belongs to the new account.
    const dl = JSON.parse(lessons.find((l) => l.title === 'Vertiefung')!.downloads)[0];
    expect(dl.name).toBe('Arbeitsbuch');
    expect(dl.upload_id).not.toBe(upload.id);
    expect(db().get('SELECT location_id FROM uploads WHERE id = ?', dl.upload_id)!.location_id).toBe(dst);
    // Access: tags stay, the product points at the copied product.
    const access = JSON.parse(c.access);
    const newProduct = db().get('SELECT id FROM products WHERE location_id = ?', dst)!;
    expect(access).toMatchObject({ tags: ['kurs:starter'], product_ids: [newProduct.id] });

    // Community: structure without posts; references point at the copies.
    const g = db().get('SELECT * FROM community_groups WHERE location_id = ?', dst)!;
    expect(g).toMatchObject({ name: 'Starter-Community', slug: 'starter-community' });
    expect(JSON.parse(g.access)).toMatchObject({ mode: 'courses', course_ids: [c.id] });
    expect(JSON.parse(g.settings)).toMatchObject({ word_filter: ['spam'], level_unlocks: [{ level: 2, course_id: c.id }] });
    expect(db().all('SELECT name, category, admin_only FROM community_channels WHERE group_id = ? ORDER BY position', g.id)).toEqual([
      { name: 'Allgemein', category: '', admin_only: 0 },
      { name: 'Vorstellungsrunde', category: '', admin_only: 0 },
      { name: 'Ankündigungen', category: '', admin_only: 1 },
      { name: 'Erfolge', category: 'Austausch', admin_only: 0 },
    ]);
    expect(count('SELECT COUNT(*) AS n FROM community_posts WHERE location_id = ?', dst)).toBe(0);

    // The workflow's trigger and step follow the copies too (and starts as draft).
    const w = db().get('SELECT * FROM workflows WHERE location_id = ?', dst)!;
    expect(w.status).toBe('draft');
    expect(JSON.parse(w.trigger).config.group_id).toBe(g.id);
    expect(JSON.parse(w.steps)[0].course_id).toBe(c.id);
  });

  it('survives download and import as a file', async () => {
    const snap = (await t.api.get('/api/snapshots')).data[0];
    const file = await (await t.api.raw(`/api/snapshots/${snap.id}/download`, { headers: { cookie: t.api.cookie } })).text();
    const parsed = JSON.parse(file);
    expect(parsed.courses[0].modules[1].lessons[0]).toMatchObject({ title: 'Vertiefung', downloads: [{ name: 'Arbeitsbuch' }] });
    expect(JSON.stringify(parsed)).not.toContain('anna@example.de');
    expect(parsed.community_groups[0].channels).toHaveLength(4);
    expect(parsed.community_groups[0]).not.toHaveProperty('posts');
    const imported = (await t.api.post('/api/snapshots/import', { name: 'Import', data: file })).data;
    expect(imported.summary).toMatchObject({ blog_posts: 2, courses: 1, community_groups: 1 });
    const third = (await t.api.post('/api/locations', { name: 'Dritter Kunde' })).data;
    const r = (await t.api.post(`/api/snapshots/${imported.id}/apply`, { location_id: third.id })).data;
    expect(r.blog_posts).toBe(2);
    expect(count('SELECT COUNT(*) AS n FROM course_lessons WHERE location_id = ?', third.id)).toBe(2);
    expect(count('SELECT COUNT(*) AS n FROM community_channels WHERE location_id = ?', third.id)).toBe(4);

    // Older snapshots without the new parts still work.
    const old = validateSnapshot({ version: 1, funnels: [], forms: [] });
    expect(snapshotSummary(old)).toMatchObject({ blog_posts: 0, courses: 0, community_groups: 0 });
    expect(() => validateSnapshot({ version: 1, courses: 'kaputt' })).toThrow(/courses/);
  });

  it('copies a website with its blog posts to another sub-account', async () => {
    const target = (await t.api.post('/api/locations', { name: 'Ziel für Website' })).data;
    const r = (await t.api.post(`/api/funnels/${site.id}/copy`, { location_id: target.id })).data;
    expect(r.funnels).toHaveLength(1);
    expect(r.blog_posts).toBe(2);
    expect(r.courses).toEqual([]);
    expect(count('SELECT COUNT(*) AS n FROM blog_posts WHERE location_id = ? AND funnel_id = ?', target.id, r.funnels[0].id)).toBe(2);
    expect(count('SELECT COUNT(*) AS n FROM courses WHERE location_id = ?', target.id)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM community_groups WHERE location_id = ?', target.id)).toBe(0);
  });

  it('copies a course to another sub-account without members', async () => {
    const target = (await t.api.post('/api/locations', { name: 'Ziel für Kurs' })).data;
    expect((await t.api.post('/api/courses/gibtsnicht/copy', { location_id: target.id })).status).toBe(404);
    const r = (await t.api.post(`/api/courses/${course.id}/copy`, { location_id: target.id })).data;
    expect(r.courses).toHaveLength(1);
    const c = db().get('SELECT * FROM courses WHERE id = ?', r.courses[0].id)!;
    expect(c.location_id).toBe(target.id);
    expect(count('SELECT COUNT(*) AS n FROM course_lessons WHERE course_id = ?', c.id)).toBe(2);
    expect(count('SELECT COUNT(*) AS n FROM course_enrollments WHERE course_id = ?', c.id)).toBe(0);
    // Products are not copied along, so the purchase link is dropped.
    expect(JSON.parse(c.access)).toMatchObject({ tags: ['kurs:starter'], product_ids: [] });
    expect(count('SELECT COUNT(*) AS n FROM funnels WHERE location_id = ?', target.id)).toBe(0);
    // A second copy into the same account gets its own address.
    const again = (await t.api.post(`/api/courses/${course.id}/copy`, { location_id: target.id })).data;
    expect(again.courses[0].slug).toBe('starter-kurs-2');
    // Copies within the same account keep the download file.
    const same = (await t.api.post(`/api/courses/${course.id}/copy`, {})).data;
    const l = db().get(`SELECT downloads FROM course_lessons WHERE course_id = ? AND title = 'Vertiefung'`, same.courses[0].id)!;
    expect(JSON.parse(l.downloads)[0].upload_id).toBe(upload.id);
  });
});
