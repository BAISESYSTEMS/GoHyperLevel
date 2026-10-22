import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import type { AppEvent } from '../server/core/events.js';

const KEY = 'AIzaSyTestKey_0123456789abcdefghijklmno';
const PLACE = 'ChIJN1t_tDeuEmsRUsoyG83frY4';

const review = (n: number, rating: number, text: string, publishTime: string, author = `Person ${n}`) => ({
  name: `places/${PLACE}/reviews/R${n}`,
  relativePublishTimeDescription: 'vor einer Woche',
  rating,
  text: { text, languageCode: 'de' },
  originalText: { text, languageCode: 'de' },
  authorAttribution: { displayName: author, uri: `https://www.google.com/maps/contrib/${n}`, photoUri: `https://lh3.googleusercontent.com/a/${n}` },
  publishTime,
  googleMapsUri: `https://www.google.com/maps/reviews/data=R${n}`,
});

/** Fake Places API (New): the test changes `place` between syncs. */
const requests: { url: string; method: string; headers: Record<string, string>; body: any }[] = [];
let place: any = {};
const fakeGoogle = (async (input: any, init: any = {}) => {
  const url = String(input);
  requests.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
  const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  if (init.headers?.['X-Goog-Api-Key'] !== KEY) return json({ error: { code: 403, message: 'API key not valid. Please pass a valid API key.' } }, 403);
  if (url === 'https://places.googleapis.com/v1/places:searchText') {
    return json({ places: [{ id: PLACE, displayName: { text: 'Malerei Muster' }, formattedAddress: 'Hauptstr. 1, 10115 Berlin', rating: 4.6, userRatingCount: 12, googleMapsUri: 'https://maps.google.com/?cid=1' }] });
  }
  if (url === `https://places.googleapis.com/v1/places/${PLACE}?languageCode=de`) return json(place);
  return json({ error: { message: 'not found' } }, 404);
}) as unknown as typeof fetch;

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const events: AppEvent[] = [];
const old = new Date(Date.now() - 400 * 864e5).toISOString();

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  t.app.services.googleFetch = fakeGoogle;
  t.app.events.on('*', (e) => void events.push(e));
});
afterAll(async () => {
  await t.close();
});

describe('Google reviews', () => {
  it('finds the Place ID with Places Text Search', async () => {
    expect((await t.api.post('/api/google-reviews/settings/find-place', { query: 'Malerei Muster Berlin' })).status).toBe(400);
    requests.length = 0;
    const r = await t.api.post('/api/google-reviews/settings/find-place', { query: 'Malerei Muster Berlin', api_key: KEY });
    expect(r.data).toEqual([{ place_id: PLACE, name: 'Malerei Muster', address: 'Hauptstr. 1, 10115 Berlin', rating: 4.6, total: 12, maps_url: 'https://maps.google.com/?cid=1' }]);
    expect(requests[0]).toMatchObject({ method: 'POST', body: { textQuery: 'Malerei Muster Berlin', languageCode: 'de', pageSize: 5 } });
    expect(requests[0].headers['X-Goog-FieldMask']).toContain('places.id');
  });

  it('stores the key sealed, never shows it, and imports existing reviews quietly', async () => {
    place = { id: PLACE, displayName: { text: 'Malerei Muster' }, rating: 4.5, userRatingCount: 12, googleMapsUri: 'https://maps.google.com/?cid=1', reviews: [review(1, 5, 'Super Arbeit!', old), review(2, 2, 'Zu spät gekommen', old)] };
    expect((await t.api.put('/api/google-reviews/settings', { api_key: 'kurz', place_id: PLACE })).status).toBe(400);
    requests.length = 0;
    const r = await t.api.put('/api/google-reviews/settings', { api_key: KEY, place_id: PLACE, place_name: 'Malerei Muster' });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ api_key: '••••••', api_key_set: true, place_id: PLACE, sync: { rating: 4.5, total: 12, created: 2, new: 0 } });
    expect(JSON.stringify((await t.api.get('/api/google-reviews/settings')).data)).not.toContain(KEY);
    expect(t.app.db.get('SELECT api_key FROM google_places WHERE location_id = ?', loc)!.api_key).toMatch(/^v1:/);
    expect(requests[0].url).toBe(`https://places.googleapis.com/v1/places/${PLACE}?languageCode=de`);
    expect(requests[0].headers['X-Goog-Api-Key']).toBe(KEY);
    expect(requests[0].headers['X-Goog-FieldMask']).toMatch(/rating.*userRatingCount.*reviews/);
    await t.app.events.flush();
    // Old reviews are history: no notification, no workflow trigger.
    expect(events.filter((e) => e.type === 'google_review.received')).toHaveLength(0);
  });

  it('deduplicates on later syncs and announces a new low rating', async () => {
    const contact = (await t.api.post('/api/contacts', { first_name: 'Karl', last_name: 'Kritisch', email: 'karl@example.com' })).data;
    const fresh = new Date().toISOString();
    place = { ...place, rating: 4.3, userRatingCount: 14, reviews: [review(1, 5, 'Super Arbeit! (bearbeitet)', old), review(2, 2, 'Zu spät gekommen', old), review(3, 2, 'Leider unzufrieden', fresh, 'Karl Kritisch'), review(4, 5, 'Top!', fresh)] };
    const r = await t.api.post('/api/google-reviews/sync');
    expect(r.data).toMatchObject({ rating: 4.3, total: 14, created: 2, new: 2 });
    // Same answer again: nothing new.
    expect((await t.api.post('/api/google-reviews/sync')).data).toMatchObject({ created: 0, new: 0 });
    await t.app.events.flush();
    const got = events.filter((e) => e.type === 'google_review.received');
    expect(got.map((e) => e.data.rating).sort()).toEqual([2, 5]);
    const low = got.find((e) => e.data.rating === 2)!;
    expect(low.data).toMatchObject({ contactId: contact.id, author: 'Karl Kritisch', low: true, link: 'https://www.google.com/maps/reviews/data=R3' });
    expect(t.app.db.all('SELECT review_key, notified FROM google_reviews WHERE location_id = ? ORDER BY review_key', loc).map((x) => [x.review_key.split('/').pop(), x.notified])).toEqual([
      ['R1', 0],
      ['R2', 0],
      ['R3', 1],
      ['R4', 0],
    ]);
    const data = (await t.api.get('/api/google-reviews')).data;
    expect(data).toMatchObject({ configured: true, rating: 4.3, total: 14, distribution: [0, 2, 0, 0, 2] });
    expect(data.reviews).toHaveLength(4);
    expect(data.reviews.find((x: any) => x.review_key.endsWith('R1')).text).toBe('Super Arbeit! (bearbeitet)');
    expect(data.trend).toHaveLength(1);
    expect(data.place.reviews_url).toBe(`https://search.google.com/local/reviews?placeid=${PLACE}`);
    const c = (await t.api.get(`/api/contacts/${contact.id}`)).data;
    expect(c.activities.some((a: any) => a.type === 'google_review.received')).toBe(true);
  });

  it('starts workflows with the trigger "Neue Google-Bewertung" filtered by stars', async () => {
    const wf = (await t.api.post('/api/workflows', { name: 'Kritik', trigger: { type: 'google_review.received', config: { max_rating: 3 } }, steps: [{ type: 'add_tag', tags: ['google-kritik'] }] })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    const contact = t.app.db.get(`SELECT id FROM contacts WHERE first_name = 'Karl'`)!;
    t.app.events.emit(loc, 'google_review.received', { contactId: contact.id, rating: 5 });
    await t.app.events.flush();
    expect((await t.api.get(`/api/contacts/${contact.id}`)).data.tags).not.toContain('google-kritik');
    t.app.events.emit(loc, 'google_review.received', { contactId: contact.id, rating: 2 });
    await t.app.events.flush();
    expect((await t.api.get(`/api/contacts/${contact.id}`)).data.tags).toContain('google-kritik');
  });

  it('syncs once a day on the scheduler and records errors', async () => {
    requests.length = 0;
    await t.app.tick();
    expect(requests).toHaveLength(0); // synced a moment ago
    t.app.db.run('UPDATE google_places SET last_sync_at = ? WHERE location_id = ?', new Date(Date.now() - 25 * 3600_000).toISOString(), loc);
    await t.app.tick();
    expect(requests).toHaveLength(1);
    await t.app.tick();
    expect(requests).toHaveLength(1);
    t.app.services.googleFetch = (async () => new Response(JSON.stringify({ error: { message: 'Quota exceeded' } }), { status: 429 })) as unknown as typeof fetch;
    expect((await t.api.post('/api/google-reviews/sync')).status).toBe(502);
    t.app.services.googleFetch = fakeGoogle;
    expect((await t.api.get('/api/google-reviews')).data.last_error).toBe('Google: Quota exceeded');
  });

  it('shows the Google rating in the review widget', async () => {
    const r = await t.api.raw(`/r/widget/${loc}`);
    const html = await r.text();
    expect(html).toContain('4,3');
    expect(html).toContain('14 Bewertungen auf Google');
    expect(html).toContain('Top!');
    expect(html).not.toContain('Leider unzufrieden');
  });
});
