import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { ratingFromText, reviewsFromCsv, reviewsFromFeed } from '../server/services/review-sources.js';
import type { AppEvent } from '../server/core/events.js';

/** Reviews from many platforms: adapters against fake APIs, one table, triggers, AI drafts, replies, widget, DSGVO. */

const old = '2020-05-01T10:00:00.000Z';
const fresh = () => new Date(Date.now() + 60_000).toISOString();
const requests: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
let tpReviews: any[] = [{ id: 'tp1', stars: 5, title: 'Top', text: 'Alles bestens', language: 'de', createdAt: old, consumer: { displayName: 'Anna Alt' } }];
let yelpReviews: any[] = [
  { id: 'y1', rating: 4, text: 'Guter Laden', time_created: '2026-09-01 10:00:00', url: 'https://www.yelp.com/biz/x?hrid=y1', user: { name: 'Yuri' } },
  { id: 'y2', rating: 2, text: 'Naja', time_created: '2026-09-02 10:00:00', url: 'https://www.yelp.com/biz/x?hrid=y2', user: { name: 'Yvonne' } },
];
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
const fake = (async (input: any, init: any = {}) => {
  const url = String(input);
  requests.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: String(init.body ?? '') });
  const h = init.headers ?? {};
  if (url.startsWith('https://api.trustpilot.com/v1/business-units/find')) return h.apikey === 'tp-key' ? json({ id: 'bu1', displayName: 'Malerei Muster' }) : json({ message: 'Unauthorized' }, 401);
  if (url === 'https://api.trustpilot.com/v1/business-units/bu1') return json({ id: 'bu1', displayName: 'Malerei Muster', name: { identifying: 'malerei.example' }, score: { stars: 4.5, trustScore: 4.6 }, numberOfReviews: { total: 42 } });
  if (url.startsWith('https://api.trustpilot.com/v1/business-units/bu1/reviews')) return json({ reviews: tpReviews });
  if (url === 'https://api.trustpilot.com/v1/oauth/oauth-business-users-for-applications/accesstoken') return json({ access_token: 'tp-access', expires_in: 3600 });
  if (url === 'https://api.trustpilot.com/v1/private/reviews/tp2/reply') return h.authorization === 'Bearer tp-access' ? new Response(null, { status: 201 }) : json({ message: 'no' }, 401);
  if (url === 'https://api.yelp.com/v3/businesses/malerei-x') return json({ name: 'Malerei X', url: 'https://www.yelp.com/biz/malerei-x', rating: 3.5, review_count: 12 });
  if (url.startsWith('https://api.yelp.com/v3/businesses/malerei-x/reviews')) return json({ reviews: yelpReviews, total: 12 });
  if (url.startsWith('https://api.content.tripadvisor.com/api/v1/location/123/details')) return json({ name: 'Pension', web_url: 'https://www.tripadvisor.com/x', rating: '4.0', num_reviews: '88' });
  if (url.startsWith('https://api.content.tripadvisor.com/api/v1/location/123/reviews')) return json({ data: [{ id: 901, lang: 'de', published_date: old, rating: 5, url: 'https://www.tripadvisor.com/r901', text: 'Sehr schön', title: 'Urlaub', user: { username: 'reisende' } }] });
  if (url === 'https://www.provenexpert.com/api/v1/rating/summary/get') return h.authorization === `Basic ${Buffer.from('pe-id:pe-key').toString('base64')}` ? json({ status: 'success', ratingValue: 4.86, reviewCount: 57 }) : json({ status: 'error', errors: ['auth'] }, 401);
  if (url === 'https://feeds.example.com/jameda.xml')
    return new Response(`<?xml version="1.0"?><rss><channel><item><title>Sehr gut (5/5)</title><description><![CDATA[<p>Kompetent &amp; freundlich</p>]]></description><link>https://www.jameda.de/r/1</link><guid>j1</guid><pubDate>Mon, 05 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>`, { status: 200 });
  return json({ message: 'unknown' }, 404);
}) as unknown as typeof fetch;

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const events: AppEvent[] = [];
let aiPrompts: any[] = [];

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  t.app.services.reviewSourceFetch = fake;
  t.app.services.aiReady = () => null;
  t.app.services.aiRun = async (input: any) => (aiPrompts.push(input), { text: 'Vielen Dank für die ehrliche Rückmeldung!', model: 'fake' });
  t.app.events.on('*', (e) => void events.push(e));
});
afterAll(async () => t?.close());

describe('import helpers', () => {
  it('reads ratings, CSV and feeds', () => {
    expect(ratingFromText('Note 4,5/5')).toBe(5);
    expect(ratingFromText('3 von 5 Sternen')).toBe(3);
    expect(ratingFromText('★★★★☆')).toBe(4);
    const csv = reviewsFromCsv('Name;Sterne;Kommentar;Datum\nKai Kunde;4;Gut beraten;2026-09-01\n;;;\n'.replace(/;/g, ','));
    expect(csv).toHaveLength(1);
    expect(csv[0]).toMatchObject({ author: 'Kai Kunde', rating: 4, text: 'Gut beraten', publishedAt: '2026-09-01T00:00:00.000Z' });
    const feed = reviewsFromFeed('<feed><entry><title>Bewertung 2/5</title><content>Lange gewartet</content><link href="https://x.example/r"/><id>e1</id><author><name>Eva</name></author></entry></feed>');
    expect(feed[0]).toMatchObject({ externalId: 'e1', author: 'Eva', rating: 2, link: 'https://x.example/r' });
  });
});

describe('review sources', () => {
  let tp = '';
  it('connects Trustpilot: key sealed, history imported quietly, rating shown', async () => {
    expect((await t.api.post('/api/review-sources', { source: 'nope' })).status).toBe(400);
    expect((await t.api.post('/api/review-sources', { source: 'trustpilot', domain: 'malerei.example' })).status).toBe(400);
    const r = await t.api.post('/api/review-sources', { source: 'trustpilot', domain: 'malerei.example', api_key: 'tp-key' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    tp = r.data.id;
    expect(r.data).toMatchObject({ source: 'trustpilot', rating: 4.5, total: 42, stored: 1, can_reply: false, secrets: { api_key: '••••••', api_secret: '' } });
    expect(r.data.profile_url).toBe('https://www.trustpilot.com/review/malerei.example');
    expect(JSON.stringify(t.app.db.all('SELECT * FROM review_connections'))).not.toContain('tp-key');
    expect(JSON.stringify((await t.api.get('/api/review-sources')).data)).not.toContain('tp-key');
    expect(events.filter((e) => e.type === 'review.received')).toHaveLength(0);
  });

  it('announces a new review once (trigger review.received with source), low ratings notify', async () => {
    const wf = (await t.api.post('/api/workflows', { name: 'Kritik', trigger: { type: 'review.received', config: { max_rating: 2 } }, steps: [{ type: 'wait', minutes: 1 }] })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    tpReviews = [...tpReviews, { id: 'tp2', stars: 1, title: 'Enttäuscht', text: 'Termin verpasst', language: 'de', createdAt: fresh(), consumer: { displayName: 'Bernd Böse' } }];
    expect((await t.api.post(`/api/review-sources/${tp}/sync`)).data).toMatchObject({ new: 1 });
    expect((await t.api.post(`/api/review-sources/${tp}/sync`)).data).toMatchObject({ new: 0 });
    await t.app.events.flush();
    const ev = events.filter((e) => e.type === 'review.received');
    expect(ev).toHaveLength(1);
    expect(ev[0].data).toMatchObject({ source: 'trustpilot', platform: 'Trustpilot', rating: 1, comment: 'Termin verpasst', author: 'Bernd Böse', low: true });
  });

  it('drafts an AI reply in the platform context and replies through the Trustpilot API', async () => {
    const item = (await t.api.get('/api/review-items?source=trustpilot&max_rating=2')).data.items[0];
    expect(item).toMatchObject({ external_id: 'tp2', can_reply: false, reply_link: 'https://businessapp.b2b.trustpilot.com/reviews/tp2' });
    const no = await t.api.post(`/api/review-items/${item.id}/reply`, { text: 'Danke' });
    expect(no.status).toBe(409);
    expect(no.data.reply_link).toContain('trustpilot');
    const d = await t.api.post(`/api/review-items/${item.id}/suggest-reply`, { instruction: 'Rückruf anbieten' });
    expect(d.status, JSON.stringify(d.data)).toBe(200);
    expect(d.data.item.reply_draft).toBe('Vielen Dank für die ehrliche Rückmeldung!');
    expect(aiPrompts.at(-1).system[0].text).toContain('auf eine Trustpilot-Bewertung');
    expect(aiPrompts.at(-1).user).toContain('Rückruf anbieten');
    await t.api.patch(`/api/review-sources/${tp}`, { api_secret: 'tp-secret', username: 'chef@malerei.example', password: 'pw-123456' });
    const r = await t.api.post(`/api/review-items/${item.id}/reply`, { text: 'Das tut uns leid – wir rufen Sie an.' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ reply_text: 'Das tut uns leid – wir rufen Sie an.', reply_draft: '' });
    const tok = requests.find((x) => x.url.endsWith('/accesstoken'))!;
    expect(tok.headers.authorization).toBe(`Basic ${Buffer.from('tp-key:tp-secret').toString('base64')}`);
    expect(new URLSearchParams(tok.body).get('grant_type')).toBe('password');
    expect(JSON.parse(requests.at(-1)!.body)).toEqual({ message: 'Das tut uns leid – wir rufen Sie an.' });
  });

  it('Yelp and Tripadvisor are read-only, Yelp keeps only the latest answer', async () => {
    const y = (await t.api.post('/api/review-sources', { source: 'yelp', business_id: 'malerei-x', api_key: 'yelp-key' })).data;
    expect(y).toMatchObject({ rating: 3.5, total: 12, stored: 2, mirror: true, can_reply: false });
    expect(requests.find((x) => x.url.includes('api.yelp.com'))!.headers.authorization).toBe('Bearer yelp-key');
    yelpReviews = yelpReviews.slice(0, 1);
    await t.api.post(`/api/review-sources/${y.id}/sync`);
    expect(t.app.db.all('SELECT external_id FROM review_items WHERE connection_id = ?', y.id)).toEqual([{ external_id: 'y1' }]);
    const item = (await t.api.get(`/api/review-items?connection_id=${y.id}`)).data.items[0];
    expect(item.reply_link).toBe('https://www.yelp.com/biz/x?hrid=y1');
    const ta = (await t.api.post('/api/review-sources', { source: 'tripadvisor', location_id: '123', api_key: 'ta-key' })).data;
    expect(ta).toMatchObject({ rating: 4, total: 88, stored: 1 });
    expect(requests.find((x) => x.url.includes('tripadvisor'))!.url).toContain('key=ta-key&language=de');
  });

  it('ProvenExpert gives the summary; the import adapter takes CSV, RSS and a web hook', async () => {
    const pe = (await t.api.post('/api/review-sources', { source: 'provenexpert', api_id: 'pe-id', api_key: 'pe-key', profile_url: 'https://www.provenexpert.com/malerei' })).data;
    expect(pe).toMatchObject({ rating: 4.9, total: 57, stored: 0 });
    expect((await t.api.post('/api/review-sources', { source: 'import', platform_label: 'Kununu', rss_url: 'http://unsicher.example/feed' })).status).toBe(400);
    const imp = (await t.api.post('/api/review-sources', { source: 'import', platform_label: 'Jameda', profile_url: 'https://www.jameda.de/praxis', rss_url: 'https://feeds.example.com/jameda.xml' })).data;
    expect(imp).toMatchObject({ label: 'Jameda', stored: 1 });
    expect(t.app.db.get('SELECT rating, text, link FROM review_items WHERE connection_id = ?', imp.id)).toEqual({ rating: 5, text: 'Kompetent & freundlich', link: 'https://www.jameda.de/r/1' });
    const csv = await t.api.post(`/api/review-sources/${imp.id}/import`, { csv: 'author,rating,text,date\nKai Kunde,4,Gut beraten,2026-09-01\nLea Leise,5,Super,2026-09-03' });
    expect(csv.data).toMatchObject({ fetched: 2, new: 0 });
    expect(imp.hook_url).toMatch(/\/hooks\/reviews\//);
    const path = new URL(imp.hook_url).pathname;
    expect((await t.api.raw(path.replace(/[^/]+$/, 'falsch'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404);
    const wh = await t.api.raw(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ author: 'Wanda Web', rating: 3, text: 'Ganz okay', date: fresh(), id: 'w1' }) });
    expect(wh.status).toBe(200);
    expect(await wh.json()).toMatchObject({ ok: true, new: 1 });
    const item = (await t.api.get(`/api/review-items?connection_id=${imp.id}`)).data.items.find((i: any) => i.external_id === 'w1');
    expect(item).toMatchObject({ platform: 'Jameda', can_reply: false, reply_link: 'https://www.jameda.de/praxis' });
  });

  it('sums up every platform and shows them in the review widget', async () => {
    const s = (await t.api.get('/api/review-items/summary')).data;
    expect(s.platforms.map((p: any) => p.label)).toEqual(expect.arrayContaining(['Trustpilot', 'Yelp', 'Tripadvisor', 'ProvenExpert', 'Jameda']));
    expect(s.overall.total).toBeGreaterThan(150);
    const html = await (await t.api.raw(`/r/widget/${loc}`)).text();
    expect(html).toContain('Trustpilot');
    expect(html).toContain('ProvenExpert');
    expect(html).toContain('Kompetent &amp; freundlich');
    expect(html).not.toContain('Termin verpasst'); // 1★ never in the widget
  });

  it('a review stays when its contact is erased – only the link goes', async () => {
    const c = (await t.api.post('/api/contacts', { first_name: 'Kai', last_name: 'Kunde', email: 'kai@example.com' })).data;
    t.app.db.run(`UPDATE review_items SET contact_id = ? WHERE author = 'Kai Kunde'`, c.id);
    expect((await t.api.post(`/api/contacts/${c.id}/erase`, { confirm: c.id })).status).toBe(200);
    expect(t.app.db.get(`SELECT contact_id FROM review_items WHERE author = 'Kai Kunde'`)).toEqual({ contact_id: null });
  });

  it('removing a connection removes its reviews', async () => {
    expect((await t.api.del(`/api/review-sources/${tp}`)).status).toBe(200);
    expect(t.app.db.get('SELECT COUNT(*) n FROM review_items WHERE connection_id = ?', tp)).toEqual({ n: 0 });
  });
});
