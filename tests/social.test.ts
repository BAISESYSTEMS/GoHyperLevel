import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { setPostizFetch } from '../server/services/postiz.js';

/** A tiny fake Postiz: records calls, answers like the public API. */
const calls: { method: string; path: string; body: any; auth: string | null }[] = [];
let integrations = [
  { id: 'int-x', name: 'Malerei X', identifier: 'x', picture: '', disabled: false, profile: 'maler' },
  { id: 'int-li', name: 'Malerei LinkedIn', identifier: 'linkedin', picture: '', disabled: false, profile: null },
  { id: 'int-yt', name: 'Kanal', identifier: 'youtube', picture: '', disabled: false, profile: null },
  { id: 'int-agency', name: 'Agentur X', identifier: 'x', picture: '', disabled: false, profile: 'agentur' },
];
const posts: any[] = [];
const fake = (async (input: any, init: any = {}) => {
  const u = new URL(String(input));
  const path = u.pathname.replace('/api/public/v1', '');
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method ?? 'GET', path: path + u.search, body, auth: init.headers?.authorization ?? null });
  const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  if (init.headers?.authorization !== 'good-key') return json({ message: 'Unauthorized' }, 401);
  if (path === '/is-connected') return json({ connected: true });
  if (path === '/integrations') return json(integrations);
  if (path === '/upload-from-url') return json({ id: 'media-1', path: 'https://postiz.test/uploads/1.png' });
  if (path === '/posts' && init.method === 'POST') {
    const out = body.posts.map((p: any, i: number) => {
      const pid = `post-${posts.length + i + 1}`;
      return { pid, p };
    });
    for (const { pid, p } of out) posts.push({ id: pid, content: p.value[0].content, publishDate: body.date, state: body.type === 'draft' ? 'DRAFT' : 'QUEUE', releaseURL: null, group: 'g1', integration: { id: p.integration.id, providerIdentifier: 'x', name: 'n', picture: '' } });
    return json(out.map(({ pid, p }: any) => ({ postId: pid, integration: p.integration.id })));
  }
  if (path === '/posts') return json({ posts });
  if (path.startsWith('/posts/') && init.method === 'DELETE') {
    const i = posts.findIndex((p) => p.id === path.slice(7));
    if (i >= 0) posts.splice(i, 1);
    return json({ ok: true });
  }
  if (path.startsWith('/analytics/')) return json([{ label: 'Followers', data: [{ total: '120', date: '2026-10-01' }], percentageChange: 5 }]);
  if (path.startsWith('/social/')) return json({ url: 'https://twitter.com/i/oauth2/authorize?state=abc' });
  return json({ message: 'nope' }, 404);
}) as unknown as typeof fetch;

let t: Awaited<ReturnType<typeof startTestApp>>;
beforeAll(async () => {
  setPostizFetch(fake);
  t = await startTestApp();
  await t.setup();
});
afterAll(async () => {
  await t.close();
});

describe('social planner (Postiz)', () => {
  it('is off until the agency connects Postiz, and checks the key', async () => {
    expect((await t.api.get('/api/social')).data.configured).toBe(false);
    expect((await t.api.post('/api/social/posts', { content: 'x', integration_ids: ['int-x'] })).status).toBe(409);
    expect((await t.api.patch('/api/agency/social', { url: 'https://postiz.test/', api_key: 'bad' })).status).toBe(502);
    expect((await t.api.patch('/api/agency/social', { url: 'http://postiz.test', api_key: 'good-key' })).status).toBe(400);
    const r = await t.api.patch('/api/agency/social', { url: 'https://postiz.test/api/public/v1', api_key: 'good-key' });
    expect(r.data).toMatchObject({ ok: true, url: 'https://postiz.test', key_set: true });
    const ag = (await t.api.get('/api/agency/social')).data;
    expect(ag.connected).toBe(true);
    expect(JSON.stringify(ag)).not.toContain('good-key');
    expect(ag.channels).toHaveLength(4);
  });

  it('shows a sub-account only its own channels and posts', async () => {
    expect((await t.api.get('/api/social')).data.channels).toHaveLength(0);
    for (const id of ['int-x', 'int-li', 'int-yt']) await t.api.put(`/api/agency/social/channels/${id}`, { location_id: t.api.location });
    const s = (await t.api.get('/api/social')).data;
    expect(s.channels.map((c: any) => c.id).sort()).toEqual(['int-li', 'int-x', 'int-yt']);
    expect(s.channels.find((c: any) => c.id === 'int-yt').supported).toBe(false);
    expect(s.postiz_url).toBe('https://postiz.test');

    // Validation: foreign channel, too long for X, unsupported platform, past date.
    expect((await t.api.post('/api/social/posts', { content: 'Hallo', integration_ids: ['int-agency'], type: 'now' })).status).toBe(400);
    expect((await t.api.post('/api/social/posts', { content: 'x'.repeat(281), integration_ids: ['int-x'], type: 'now' })).data.error).toContain('max. 280');
    expect((await t.api.post('/api/social/posts', { content: 'Video', integration_ids: ['int-yt'], type: 'now' })).status).toBe(400);
    expect((await t.api.post('/api/social/posts', { content: 'Hallo', integration_ids: ['int-x'], type: 'schedule', date: '2020-01-01T10:00:00Z' })).status).toBe(400);

    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const up = (await t.api.post('/api/uploads', { name: 'bild.png', data: png })).data;
    const when = new Date(Date.now() + 3 * 864e5).toISOString();
    calls.length = 0;
    const created = await t.api.post('/api/social/posts', { content: 'Frisch gestrichen! 🎨', integration_ids: ['int-x', 'int-li'], type: 'schedule', date: when, upload_ids: [up.id] });
    expect(created.status).toBe(200);
    expect(created.data.postiz_ids).toEqual(['post-1', 'post-2']);
    const upload = calls.find((c) => c.path === '/upload-from-url')!;
    expect(upload.body.url).toMatch(/^http:\/\/localhost\/uploads\//);
    const sent = calls.find((c) => c.path === '/posts' && c.method === 'POST')!.body;
    expect(sent).toMatchObject({ type: 'schedule', date: when, shortLink: false, tags: [] });
    expect(sent.posts[0]).toEqual({ integration: { id: 'int-x' }, value: [{ content: 'Frisch gestrichen! 🎨', image: [{ id: 'media-1', path: 'https://postiz.test/uploads/1.png' }] }], settings: { __type: 'x', who_can_reply_post: 'everyone' } });
    expect(sent.posts[1].settings).toEqual({ __type: 'linkedin', post_as_images_carousel: false });

    // A post on the agency's own channel must not show up for the client.
    posts.push({ id: 'post-agency', content: 'intern', publishDate: when, state: 'QUEUE', integration: { id: 'int-agency' } });
    const list = (await t.api.get('/api/social/posts?refresh=1')).data;
    expect(list.map((p: any) => p.id)).toEqual(['post-1', 'post-2']);
    expect((await t.api.del(`/api/social/posts/post-agency?date=${encodeURIComponent(when)}`)).status).toBe(404);
    expect((await t.api.del(`/api/social/posts/post-1?date=${encodeURIComponent(when)}`)).status).toBe(200);
    expect(posts.some((p) => p.id === 'post-1')).toBe(false);

    expect((await t.api.get('/api/social/analytics/int-x?days=30')).data[0].label).toBe('Followers');
    expect((await t.api.get('/api/social/analytics/int-agency')).status).toBe(404);
  });

  it('assigns a newly connected channel to the sub-account that connected it', async () => {
    const r = await t.api.post('/api/social/connect/x');
    expect(r.data.url).toContain('twitter.com');
    integrations = [...integrations, { id: 'int-new', name: 'Neu', identifier: 'x', picture: '', disabled: false, profile: 'neu' }];
    const s = (await t.api.get('/api/social?refresh=1')).data;
    expect(s.channels.map((c: any) => c.id)).toContain('int-new');
    expect(s.channels.map((c: any) => c.id)).not.toContain('int-agency');
    expect((await t.api.post('/api/social/connect/listmonk')).status).toBe(400);
    // One channel for two projects.
    const other = (await t.api.post('/api/locations', { name: 'Produkt' })).data.id;
    expect((await t.api.put('/api/agency/social/channels/int-x', { location_ids: [t.api.location, other] })).data.location_ids).toHaveLength(2);
    const ag = (await t.api.get('/api/agency/social')).data.channels.find((c: any) => c.id === 'int-x');
    expect(ag.location_ids.sort()).toEqual([t.api.location, other].sort());
    expect((await t.api.get('/api/social?refresh=1')).data.channels.map((c: any) => c.id)).toContain('int-x');
  });

  it('posts drafts from workflows', async () => {
    const c = (await t.api.post('/api/contacts', { email: 'fan@x.de', first_name: 'Frieda' })).data;
    const meta = (await t.api.get('/api/workflows/meta')).data;
    expect(meta.steps).toContain('social_post');
    const wf = (await t.api.post('/api/workflows', { name: 'Danke posten', trigger: { type: 'contact.tag_added', config: { tag: 'fan' } }, steps: [{ type: 'social_post', integration_ids: ['int-li'], body: 'Danke {{contact.first_name}} für dein Feedback!' }] })).data;
    expect(wf.id).toBeTruthy();
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    calls.length = 0;
    await t.api.post(`/api/contacts/${c.id}/tags`, { add: ['fan'] });
    await new Promise((r) => setTimeout(r, 100));
    const sent = calls.find((x) => x.path === '/posts' && x.method === 'POST')?.body;
    expect(sent?.type).toBe('draft');
    expect(sent?.posts[0].value[0].content).toBe('Danke Frieda für dein Feedback!');
  });

  it('keeps members without the social permission out', async () => {
    await t.api.post('/api/users', { email: 'nur-kontakte@x.de', password: 'geheim12345', locations: [t.api.location], permissions: ['contacts'] });
    t.api.clearCookie();
    await t.api.post('/api/auth/login', { email: 'nur-kontakte@x.de', password: 'geheim12345' });
    expect((await t.api.get('/api/social')).status).toBe(403);
    expect((await t.api.get('/api/agency/social')).status).toBe(403);
  });
});
