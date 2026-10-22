import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { G_CLIENT, createFake } from './oauth-fakes.js';
import type { AppEvent } from '../server/core/events.js';
import { requiredPermission } from '../server/core/permissions.js';
import { localPostBody, normalizeReview } from '../server/services/google-business.js';

const PLACE = 'ChIJN1t_tDeuEmsRUsoyG83frY4';
const KEY = 'AIzaSyTestKey_0123456789abcdefghijklmno';
const old = new Date(Date.now() - 400 * 864e5).toISOString();

/** Places API (New) with one review – the setup before the Business Profile is connected. */
const places = (async () =>
  new Response(
    JSON.stringify({
      id: PLACE,
      displayName: { text: 'Malerei Muster' },
      rating: 5,
      userRatingCount: 1,
      reviews: [{ name: `places/${PLACE}/reviews/P1`, rating: 5, text: { text: 'Super Arbeit' }, originalText: { text: 'Super Arbeit' }, authorAttribution: { displayName: 'Anna Alt' }, publishTime: old }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch;

describe('Business Profile helpers', () => {
  it('maps reviews (stars, anonymous, Google translations, replies)', () => {
    expect(normalizeReview({ name: 'accounts/1/locations/2/reviews/R', reviewId: 'R', starRating: 'FOUR', reviewer: { isAnonymous: true }, comment: '(Translated by Google) Great\n\n(Original)\nToll gemacht', createTime: '2026-01-02T03:04:05Z' })).toMatchObject({
      rating: 4,
      author: 'Google-Nutzer',
      text: 'Toll gemacht',
      published_at: '2026-01-02T03:04:05.000Z',
      reply_text: '',
    });
    expect(normalizeReview({ name: 'x', starRating: 'STAR_RATING_UNSPECIFIED' })).toBeNull();
    expect(normalizeReview({ name: 'x', starRating: 'ONE', reviewer: { displayName: 'Bob' }, reviewReply: { comment: 'Sorry', updateTime: '2026-01-03T00:00:00Z' } })).toMatchObject({ rating: 1, author: 'Bob', reply_text: 'Sorry' });
  });

  it('builds local posts with optional image and button', () => {
    expect(localPostBody({ summary: 'Hallo' })).toEqual({ languageCode: 'de', summary: 'Hallo', topicType: 'STANDARD' });
    expect(localPostBody({ summary: 'Ruf an', cta_type: 'CALL', cta_url: 'https://x' })).toMatchObject({ callToAction: { actionType: 'CALL' } });
    expect(localPostBody({ summary: 'Ruf an', cta_type: 'CALL' }).callToAction).toEqual({ actionType: 'CALL' });
    expect(localPostBody({ summary: 'S', image_url: 'https://e.de/a.jpg', cta_type: 'BOOK', cta_url: 'https://e.de/b' })).toMatchObject({ media: [{ mediaFormat: 'PHOTO', sourceUrl: 'https://e.de/a.jpg' }], callToAction: { actionType: 'BOOK', url: 'https://e.de/b' } });
  });

  it('maps the new routes to permission areas', () => {
    expect(requiredPermission('PUT', '/api/google-reviews/business')).toBe('settings');
    expect(requiredPermission('GET', '/api/google-reviews/business/locations')).toBe('settings');
    expect(requiredPermission('POST', '/api/google-reviews/abc/reply')).toBe('reviews');
    expect(requiredPermission('POST', '/api/google-reviews/posts')).toBe('reviews');
  });
});

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const fake = createFake();
const events: AppEvent[] = [];
const calls = (re: RegExp, method?: string) => fake.reqs.filter((r) => re.test(r.url) && (!method || r.method === method));

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  t.app.services.oauthFetch = fake.fetch;
  t.app.services.googleFetch = places;
  t.app.events.on('*', (e) => void events.push(e));
  await t.api.put('/api/agency/oauth', { google: G_CLIENT });
});
afterAll(async () => {
  await t.close();
});

describe('Google Business Profile', () => {
  let annaId = '';

  it('starts with the Places API and offers to connect the profile', async () => {
    const r = await t.api.put('/api/google-reviews/settings', { api_key: KEY, place_id: PLACE });
    expect(r.data.sync).toMatchObject({ created: 1 });
    annaId = t.app.db.get(`SELECT id FROM google_reviews WHERE author = 'Anna Alt'`)!.id;
    expect((await t.api.get('/api/google-reviews/business')).data).toEqual({ connected: false, ready: false, configured: true });
    expect((await t.api.post(`/api/google-reviews/${annaId}/reply`, { comment: 'Danke' })).status).toBe(409);
  });

  it('connects the Google account for this sub-account (business.manage)', async () => {
    expect((await t.api.post('/api/oauth/start', { provider: 'microsoft', purpose: 'business', location_id: loc })).status).toBe(400);
    const r = await t.api.post('/api/oauth/start', { provider: 'google', purpose: 'business', location_id: loc });
    expect(new URL(r.data.url).searchParams.get('scope')).toBe('openid email https://www.googleapis.com/auth/business.manage');
    const f = fake.authorize(r.data.url);
    const back = await t.api.get(`/oauth/google/callback?code=${f.code}&state=${encodeURIComponent(f.state)}`);
    expect(back.headers.get('location')).toMatch(/^\/app\/settings\/reviews\?oauth=ok/);
    const s = (await t.api.get('/api/google-reviews/business')).data;
    expect(s).toMatchObject({ connected: true, ready: false, connection: { account_email: 'owner@example.com', location_id: loc, purpose: 'business' } });
    expect(JSON.stringify(s)).not.toMatch(/g-access|g-refresh|v1:/);
  });

  it('lists the business locations and refuses one from another account', async () => {
    const list = (await t.api.get('/api/google-reviews/business/locations')).data;
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ account: 'accounts/111', account_title: 'Malerei Muster', name: 'locations/222', title: 'Malerei Muster Berlin', address: 'Hauptstr. 1, 10115 Berlin', place_id: PLACE });
    expect((await t.api.put('/api/google-reviews/business', { account: 'accounts/111', location: 'locations/999' })).status).toBe(400);
    expect((await t.api.put('/api/google-reviews/business', { account: '../x', location: 'locations/222' })).status).toBe(400);
  });

  it('reads all reviews with replies and adopts the ones the Places API already had', async () => {
    fake.g.reviews = [
      { name: 'accounts/111/locations/222/reviews/R1', reviewId: 'R1', reviewer: { displayName: 'Anna Alt' }, starRating: 'FIVE', comment: 'Super Arbeit', createTime: old, updateTime: old },
      { name: 'accounts/111/locations/222/reviews/R2', reviewId: 'R2', reviewer: { displayName: 'Bernd Neu' }, starRating: 'TWO', comment: 'Zu spät gekommen', createTime: new Date(Date.now() + 5000).toISOString(), reviewReply: { comment: 'Das tut uns leid', updateTime: '2026-10-01T00:00:00Z' } },
      { name: 'accounts/111/locations/222/reviews/R3', reviewId: 'R3', reviewer: { isAnonymous: true }, starRating: 'SIX' },
      { name: 'accounts/111/locations/222/reviews/R4', reviewId: 'R4', reviewer: { isAnonymous: true }, starRating: 'FOUR', comment: '(Translated by Google) Great\n\n(Original)\nToll', createTime: old },
    ];
    events.length = 0;
    const r = await t.api.put('/api/google-reviews/business', { account: 'accounts/111', location: 'locations/222' });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ ready: true, location_title: 'Malerei Muster Berlin', sync: { rating: 4.3, total: 4, created: 2, new: 1 } });
    const rows = t.app.db.all('SELECT * FROM google_reviews WHERE location_id = ? ORDER BY author', loc);
    expect(rows.map((x) => [x.author, x.rating, x.text, x.reply_text])).toEqual([
      ['Anna Alt', 5, 'Super Arbeit', ''],
      ['Bernd Neu', 2, 'Zu spät gekommen', 'Das tut uns leid'],
      ['Google-Nutzer', 4, 'Toll', ''],
    ]);
    expect(rows[0]).toMatchObject({ id: annaId, review_key: 'accounts/111/locations/222/reviews/R1' });
    await t.app.events.flush();
    expect(events.filter((e) => e.type === 'google_review.received').map((e) => e.data.author)).toEqual(['Bernd Neu']);
    const g = (await t.api.get('/api/google-reviews')).data;
    expect(g).toMatchObject({ configured: true, business: { ready: true, account_email: 'owner@example.com', location_title: 'Malerei Muster Berlin' } });
  });

  it('replies, edits and deletes the reply', async () => {
    expect((await t.api.post(`/api/google-reviews/${annaId}/reply`, { comment: '' })).status).toBe(400);
    let r = await t.api.post(`/api/google-reviews/${annaId}/reply`, { comment: 'Danke, Anna!' });
    expect(r.data).toMatchObject({ reply_text: 'Danke, Anna!', reply_at: '2026-10-04T10:00:00.000Z' });
    const put = calls(/\/reviews\/R1\/reply$/, 'PUT').pop()!;
    expect(put.url).toBe('https://mybusiness.googleapis.com/v4/accounts/111/locations/222/reviews/R1/reply');
    expect(put.body).toEqual({ comment: 'Danke, Anna!' });
    expect(put.headers.authorization).toMatch(/^Bearer g-access-/);
    r = await t.api.post(`/api/google-reviews/${annaId}/reply`, { comment: 'Vielen Dank, Anna!' });
    expect(r.data.reply_text).toBe('Vielen Dank, Anna!');
    r = await t.api.del(`/api/google-reviews/${annaId}/reply`);
    expect(r.data).toMatchObject({ reply_text: '', reply_at: null });
    expect(calls(/\/reviews\/R1\/reply$/, 'DELETE')).toHaveLength(1);
    expect(fake.g.reviews[0].reviewReply).toBeUndefined();
  });

  it('publishes and deletes local posts', async () => {
    expect((await t.api.post('/api/google-reviews/posts', { summary: 'Aktion', cta_type: 'BOOK' })).status).toBe(400);
    expect((await t.api.post('/api/google-reviews/posts', { summary: 'Aktion', image_url: 'http://e.de/a.jpg' })).status).toBe(400);
    expect((await t.api.post('/api/google-reviews/posts', { summary: 'Aktion', cta_type: 'NOPE' })).status).toBe(400);
    const r = await t.api.post('/api/google-reviews/posts', { summary: 'Herbstaktion: 10 % auf Innenanstrich', image_url: 'https://example.com/herbst.jpg', cta_type: 'BOOK', cta_url: 'https://example.com/termin' });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ state: 'LIVE', source: 'manuell', cta_type: 'BOOK' });
    expect(calls(/\/localPosts$/, 'POST').pop()!.body).toEqual({
      languageCode: 'de',
      summary: 'Herbstaktion: 10 % auf Innenanstrich',
      topicType: 'STANDARD',
      callToAction: { actionType: 'BOOK', url: 'https://example.com/termin' },
      media: [{ mediaFormat: 'PHOTO', sourceUrl: 'https://example.com/herbst.jpg' }],
    });
    const call = await t.api.post('/api/google-reviews/posts', { summary: 'Ruf uns an', cta_type: 'CALL', cta_url: 'https://ignored' });
    expect(call.data.cta_url).toBe('');
    expect((await t.api.get('/api/google-reviews/posts')).data).toHaveLength(2);
    expect((await t.api.del(`/api/google-reviews/posts/${r.data.id}`)).data).toEqual({ ok: true });
    expect(calls(/\/localPosts\/\d+$/, 'DELETE')).toHaveLength(1);
    expect((await t.api.get('/api/google-reviews/posts')).data).toHaveLength(1);
  });

  it('offers the workflow action "Google-Beitrag erstellen"', async () => {
    expect((await t.api.get('/api/workflows/meta')).data.steps).toContain('google_post');
    const contact = (await t.api.post('/api/contacts', { first_name: 'Karla', email: 'karla@example.com' })).data;
    const wf = (await t.api.post('/api/workflows', { name: 'Danke-Post', trigger: { type: 'manual', config: {} }, steps: [{ id: 's1', type: 'google_post', body: 'Danke an {{contact.first_name}} für den Auftrag!', cta_type: 'LEARN_MORE', cta_url: 'https://example.com' }] })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    expect((await t.api.post(`/api/workflows/${wf.id}/enroll`, { contact_ids: [contact.id] })).data.enrolled).toBe(1);
    expect(calls(/\/localPosts$/, 'POST').pop()!.body).toMatchObject({ summary: 'Danke an Karla für den Auftrag!', callToAction: { actionType: 'LEARN_MORE', url: 'https://example.com' } });
    const runs = (await t.api.get(`/api/workflows/${wf.id}/runs`)).data;
    expect(JSON.stringify(runs)).toContain('Google-Beitrag veröffentlicht');
    expect(t.app.db.get(`SELECT source FROM google_posts ORDER BY created_at DESC LIMIT 1`)!.source).toBe('Workflow');
  });

  it('has MCP tools to reply and to post', async () => {
    const key = (await t.api.post('/api/api-keys', { name: 'mcp' })).data.key;
    const rpc = async (body: unknown) => (await t.api.raw('/mcp', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    const names = (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map((x: any) => x.name);
    expect(names).toEqual(expect.arrayContaining(['ghl_reply_google_review', 'ghl_create_google_post', 'ghl_google_reviews']));
    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ghl_google_reviews', arguments: { location_id: loc } } });
    const bernd = list.result.structuredContent.reviews.find((x: any) => x.author === 'Bernd Neu');
    expect(bernd).toMatchObject({ rating: 2, reply: 'Das tut uns leid' });
    const rep = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ghl_reply_google_review', arguments: { location_id: loc, review_id: bernd.id, reply: 'Wir melden uns persönlich.' } } });
    expect(rep.result.isError).toBe(false);
    expect(fake.g.reviews[1].reviewReply.comment).toBe('Wir melden uns persönlich.');
    const post = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ghl_create_google_post', arguments: { location_id: loc, text: 'Neu: Fassadenreinigung' } } });
    expect(post.result.isError).toBe(false);
    expect(post.result.structuredContent).toMatchObject({ source: 'MCP', state: 'LIVE' });
  });

  it('explains a missing API approval and syncs daily without the Places key', async () => {
    fake.g.gbpDenied = true;
    const r = await t.api.post('/api/google-reviews/sync');
    expect(r.status).toBe(502);
    expect(r.data.error).toContain('freigeschaltet');
    fake.g.gbpDenied = false;
    t.app.db.run('UPDATE google_places SET api_key = NULL, last_sync_at = ? WHERE location_id = ?', new Date(Date.now() - 25 * 3600_000).toISOString(), loc);
    const n = calls(/\/locations\/222\/reviews\?/, 'GET').length;
    await t.app.tick();
    expect(calls(/\/locations\/222\/reviews\?/, 'GET').length).toBe(n + 1);
    expect((await t.api.get('/api/google-reviews')).data.configured).toBe(true);
  });

  it('disconnects and falls back to links', async () => {
    const s = (await t.api.get('/api/google-reviews/business')).data;
    expect((await t.api.del(`/api/oauth/connections/${s.connection.id}`)).data).toMatchObject({ ok: true, revoked: true });
    expect((await t.api.get('/api/google-reviews/business')).data.connected).toBe(false);
    expect((await t.api.post(`/api/google-reviews/${annaId}/reply`, { comment: 'x' })).status).toBe(409);
    // Reviews and replies already stored stay visible.
    expect((await t.api.get('/api/google-reviews')).data.reviews.length).toBe(3);
  });
});
