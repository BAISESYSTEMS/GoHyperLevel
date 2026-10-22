import type { App, Module } from '../core/app.js';
import { HttpError, bad, str } from '../core/http.js';
import { escapeHtml } from '../core/template.js';
import { addDaysYmd, ymdInTz } from '../core/time.js';
import { id, now, sha256 } from '../core/util.js';
import { logActivity } from '../services/contacts.js';
import { notifyTeam } from '../services/messaging.js';
import { openSecret, sealSecret } from './mail-sync.js';
import type { Tool } from './mcp.js';

/**
 * Google reviews in Reputation: once a day the place's rating, review count and newest reviews are
 * read and stored (deduplicated). New low ratings notify the team and every new review fires the
 * workflow trigger "Neue Google-Bewertung". Source: the Business Profile API when the sub-account has
 * connected its Google account (google-business module: all reviews, replies, posts), otherwise the
 * Places API (New) with an API key (5 newest reviews, no replying – the UI links to Google instead).
 */

const PLACES = 'https://places.googleapis.com/v1';
const DETAILS_MASK = 'id,displayName,formattedAddress,googleMapsUri,rating,userRatingCount,reviews';
const SEARCH_MASK = 'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.googleMapsUri';
const MASK = '••••••';
export const LOW_RATING = 3;
export const GOOGLE_REVIEW_TRIGGER = 'google_review.received';

const placeLinks = (placeId: string) => ({
  reviews_url: `https://search.google.com/local/reviews?placeid=${encodeURIComponent(placeId)}`,
  write_review_url: `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`,
  manage_url: 'https://business.google.com/reviews',
});

const fetcher = (app: App): typeof fetch => app.services.googleFetch ?? fetch;

async function google(app: App, url: string, key: string, init: { method?: string; mask: string; body?: unknown }) {
  let r: Response;
  try {
    r = await fetcher(app)(url, {
      method: init.method ?? 'GET',
      headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': init.mask, ...(init.body ? { 'content-type': 'application/json' } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new HttpError(502, `Google nicht erreichbar: ${(e as Error).message}`);
  }
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(502, `Google: ${j?.error?.message || `Fehler ${r.status}`}`);
  return j;
}

/** One reviewer name that matches exactly one contact links the review to that contact. */
function matchContact(app: App, locationId: string, author: string): string | null {
  if (!author.trim()) return null;
  const rows = app.db.all(`SELECT id FROM contacts WHERE location_id = ? AND lower(trim(first_name || ' ' || last_name)) = lower(trim(?)) LIMIT 2`, locationId, author);
  return rows.length === 1 ? rows[0].id : null;
}

const stars = (n: number) => '★'.repeat(Math.max(0, Math.min(5, Math.round(n)))) + '☆'.repeat(5 - Math.max(0, Math.min(5, Math.round(n))));

/** A review from either source, ready to store. `reply_*` only comes from the Business Profile API. */
export interface ReviewInput {
  key: string;
  author: string;
  author_url: string;
  author_photo: string;
  rating: number;
  text: string;
  language: string;
  published_at: string | null;
  relative_time: string;
  link: string;
  reply_text?: string;
  reply_at?: string | null;
}

export interface ReviewMeta {
  place_id: string;
  connected_at: string | null;
  rating: number | null;
  total: number | null;
  place_name?: string;
  place_address?: string;
  maps_url?: string | null;
  /** Reviews published before this are history (never announced), e.g. when switching the source. */
  quiet_before?: string | null;
}

/** Stores reviews (new ones announced), the place's rating/count and the day's snapshot. */
export function storeGoogleReviews(app: App, locationId: string, list: ReviewInput[], meta: ReviewMeta) {
  const { db } = app;
  const place = db.get('SELECT * FROM google_places WHERE location_id = ?', locationId);
  const loc = app.location(locationId)!;
  const firstSync = !db.get('SELECT 1 FROM google_reviews WHERE location_id = ? LIMIT 1', locationId);
  const connectedAt = meta.connected_at ?? place?.connected_at ?? now();
  const fresh: any[] = [];
  let created = 0;
  for (const r of list) {
    let cur = db.get('SELECT id, rating, text FROM google_reviews WHERE location_id = ? AND review_key = ?', locationId, r.key);
    if (!cur && r.reply_text !== undefined) {
      // Switching from the Places API to the Business Profile API: adopt the same review instead of a duplicate.
      cur = db.get(`SELECT id, rating, text FROM google_reviews WHERE location_id = ? AND review_key LIKE 'places/%' AND author = ? AND text = ? LIMIT 1`, locationId, r.author, r.text);
      if (cur) db.run('UPDATE google_reviews SET review_key = ? WHERE id = ?', r.key, cur.id);
    }
    const reply = r.reply_text !== undefined ? { reply_text: r.reply_text, reply_at: r.reply_at ?? null } : {};
    if (cur) {
      // Reviewers can edit their review – keep the latest version, but don't announce it again.
      db.run('UPDATE google_reviews SET rating = ?, text = ?, relative_time = ?, link = ?, author_photo = ?, updated_at = ? WHERE id = ?', r.rating, r.text, r.relative_time, r.link, r.author_photo, now(), cur.id);
      if (r.reply_text !== undefined) db.run('UPDATE google_reviews SET reply_text = ?, reply_at = ? WHERE id = ?', r.reply_text, r.reply_at ?? null, cur.id);
      continue;
    }
    const row = {
      id: id(),
      location_id: locationId,
      place_id: meta.place_id,
      review_key: r.key,
      author: r.author,
      author_url: r.author_url,
      author_photo: r.author_photo,
      rating: r.rating,
      text: r.text,
      language: r.language,
      published_at: r.published_at,
      relative_time: r.relative_time,
      link: r.link,
      contact_id: matchContact(app, locationId, r.author),
      notified: 0,
      first_seen_at: now(),
      updated_at: now(),
      ...reply,
    };
    db.insert('google_reviews', row);
    created++;
    // Reviews that existed before the place was connected are history, not news.
    const old = meta.quiet_before && (!r.published_at || r.published_at < meta.quiet_before);
    if (!old && (!firstSync || (r.published_at && r.published_at >= connectedAt))) fresh.push(row);
  }
  const rating = meta.rating ?? place?.rating ?? null;
  const total = meta.total ?? place?.total ?? null;
  db.run(
    'UPDATE google_places SET rating = ?, total = ?, place_name = ?, place_address = ?, maps_url = ?, last_sync_at = ?, last_error = NULL, updated_at = ? WHERE location_id = ?',
    rating,
    total,
    String(meta.place_name || place?.place_name || '').slice(0, 300),
    String(meta.place_address || place?.place_address || '').slice(0, 500),
    meta.maps_url && /^https:\/\//.test(meta.maps_url) ? meta.maps_url : (place?.maps_url ?? null),
    now(),
    now(),
    locationId,
  );
  if (rating != null && total != null) {
    db.run(
      'INSERT INTO google_review_stats (location_id, day, rating, total) VALUES (?, ?, ?, ?) ON CONFLICT(location_id, day) DO UPDATE SET rating = excluded.rating, total = excluded.total',
      locationId,
      ymdInTz(new Date(), loc.timezone),
      rating,
      total,
    );
  }
  for (const r of fresh) {
    if (r.contact_id) logActivity(app, locationId, r.contact_id, 'google_review.received', `Google-Bewertung: ${stars(r.rating)}${r.text ? ` – ${r.text.slice(0, 80)}` : ''}`);
    if (r.rating <= LOW_RATING) {
      db.run('UPDATE google_reviews SET notified = 1 WHERE id = ?', r.id);
      void notifyTeam(app, locationId, `Neue Google-Bewertung: ${r.rating}★ von ${r.author}`, `${r.author} hat ${r.rating} von 5 Sternen gegeben:\n\n${r.text || '(ohne Text)'}\n\nAuf Google antworten: ${r.link}\nAlle Bewertungen: ${app.baseUrl()}/app/reviews`);
    }
    app.events.emit(locationId, GOOGLE_REVIEW_TRIGGER, { contactId: r.contact_id ?? undefined, reviewId: r.id, rating: r.rating, author: r.author, text: r.text, link: r.link, low: r.rating <= LOW_RATING, source: 'google' });
  }
  return { rating, total, fetched: list.length, created, new: fresh.length };
}

/** Reads rating, count and reviews (Business Profile API if connected, else Places API) and stores what is new. */
export async function syncGoogleReviews(app: App, locationId: string) {
  const { db } = app;
  const place = db.get('SELECT * FROM google_places WHERE location_id = ?', locationId);
  const business = !!app.services.googleBusinessReady?.(locationId);
  if (!business && (!place?.api_key || !place.place_id)) throw bad('Google-Bewertungen sind nicht eingerichtet (Google-Konto verbinden oder API-Schlüssel und Place ID)');
  let data: { reviews: ReviewInput[]; meta: ReviewMeta };
  try {
    data = business ? await app.services.googleBusinessFetch(locationId) : await fetchPlaces(app, place);
  } catch (e) {
    db.run('UPDATE google_places SET last_sync_at = ?, last_error = ? WHERE location_id = ?', now(), String((e as Error).message).slice(0, 500), locationId);
    throw e;
  }
  return storeGoogleReviews(app, locationId, data.reviews, data.meta);
}

/** Places API (New): rating, count and at most 5 reviews. */
async function fetchPlaces(app: App, place: any): Promise<{ reviews: ReviewInput[]; meta: ReviewMeta }> {
  const j = await google(app, `${PLACES}/places/${encodeURIComponent(place.place_id)}?languageCode=de`, openSecret(app, place.api_key), { mask: DETAILS_MASK });
  const links = placeLinks(place.place_id);
  const reviews: ReviewInput[] = [];
  for (const r of (Array.isArray(j.reviews) ? j.reviews : []).slice(0, 50)) {
    const rating = Math.round(Number(r?.rating));
    if (!(rating >= 1 && rating <= 5)) continue;
    const author = String(r.authorAttribution?.displayName ?? '').slice(0, 200) || 'Google-Nutzer';
    const published = r.publishTime && !Number.isNaN(Date.parse(r.publishTime)) ? new Date(r.publishTime).toISOString() : null;
    const text = String(r.originalText?.text ?? r.text?.text ?? '').slice(0, 5000);
    reviews.push({
      // The review's resource name is stable; older answers without it fall back to a content hash.
      key: String(r.name ?? '').slice(0, 300) || sha256(`${author}|${published ?? ''}|${text}`).slice(0, 40),
      author,
      author_url: /^https:\/\//.test(String(r.authorAttribution?.uri ?? '')) ? String(r.authorAttribution.uri) : '',
      author_photo: /^https:\/\//.test(String(r.authorAttribution?.photoUri ?? '')) ? String(r.authorAttribution.photoUri) : '',
      rating,
      text,
      language: String(r.originalText?.languageCode ?? r.text?.languageCode ?? ''),
      published_at: published,
      relative_time: String(r.relativePublishTimeDescription ?? ''),
      link: /^https:\/\//.test(String(r.googleMapsUri ?? '')) ? String(r.googleMapsUri) : links.reviews_url,
    });
  }
  return {
    reviews,
    meta: {
      place_id: place.place_id,
      connected_at: place.connected_at,
      rating: typeof j.rating === 'number' ? Math.round(j.rating * 10) / 10 : null,
      total: Number.isFinite(Number(j.userRatingCount)) ? Number(j.userRatingCount) : null,
      place_name: String(j.displayName?.text ?? ''),
      place_address: String(j.formattedAddress ?? ''),
      maps_url: /^https:\/\//.test(String(j.googleMapsUri ?? '')) ? j.googleMapsUri : null,
    },
  };
}

const TOOLS: Tool[] = [
  {
    name: 'ghl_google_reviews',
    title: 'Google-Bewertungen',
    description: 'Google-Bewertung eines Projekts: Durchschnitt, Anzahl, Verlauf und die zuletzt gespeicherten Rezensionen (ID, Autor, Sterne, Text, eigene Antwort, Link). Mit verbundenem Unternehmensprofil antwortet ghl_reply_google_review direkt.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } }, required: ['location_id'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call, a) => {
      const r = await call.api('GET', '/api/google-reviews', { location: a.location_id });
      return { configured: r.configured, place: r.place, rating: r.rating, total: r.total, change: r.change, last_sync_at: r.last_sync_at, business: r.business ?? null, reviews: r.reviews.slice(0, 30).map((x: any) => ({ id: x.id, author: x.author, rating: x.rating, text: x.text, published_at: x.published_at, link: x.link, reply: x.reply_text || null, reply_draft: x.reply_draft || null })) };
    },
  },
];

export const googleReviewsModule: Module = {
  name: 'google-reviews',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE google_places (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
        api_key TEXT, place_id TEXT NOT NULL DEFAULT '', place_name TEXT NOT NULL DEFAULT '', place_address TEXT NOT NULL DEFAULT '',
        maps_url TEXT, rating REAL, total INTEGER, connected_at TEXT, last_sync_at TEXT, last_error TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE google_reviews (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, place_id TEXT NOT NULL,
        review_key TEXT NOT NULL, author TEXT NOT NULL, author_url TEXT NOT NULL DEFAULT '', author_photo TEXT NOT NULL DEFAULT '',
        rating INTEGER NOT NULL, text TEXT NOT NULL DEFAULT '', language TEXT NOT NULL DEFAULT '', published_at TEXT, relative_time TEXT NOT NULL DEFAULT '',
        link TEXT NOT NULL DEFAULT '', contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL, notified INTEGER NOT NULL DEFAULT 0,
        first_seen_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(location_id, review_key)
      );
      CREATE INDEX google_reviews_loc ON google_reviews(location_id, published_at);
      CREATE TABLE google_review_stats (
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, day TEXT NOT NULL, rating REAL NOT NULL, total INTEGER NOT NULL,
        PRIMARY KEY (location_id, day)
      );
      `,
    ],
    // Replies (Business Profile API, see google-business.ts).
    ['002-replies', `ALTER TABLE google_reviews ADD COLUMN reply_text TEXT NOT NULL DEFAULT ''; ALTER TABLE google_reviews ADD COLUMN reply_at TEXT;`],
    // A reply written but not yet posted (KI-Antwort vorschlagen, modules/review-replies.ts): source ai | auto | edited.
    ['003-reply-drafts', `ALTER TABLE google_reviews ADD COLUMN reply_draft TEXT NOT NULL DEFAULT ''; ALTER TABLE google_reviews ADD COLUMN reply_draft_at TEXT; ALTER TABLE google_reviews ADD COLUMN reply_draft_source TEXT NOT NULL DEFAULT '';`],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    app.services.workflowTriggers = [...(app.services.workflowTriggers ?? []), GOOGLE_REVIEW_TRIGGER];

    const getPlace = (loc: string) => db.get('SELECT * FROM google_places WHERE location_id = ?', loc);
    const settingsOut = (loc: string) => {
      const p = getPlace(loc);
      return {
        api_key: p?.api_key ? MASK : '',
        api_key_set: !!p?.api_key,
        place_id: p?.place_id ?? '',
        place_name: p?.place_name ?? '',
        place_address: p?.place_address ?? '',
        connected_at: p?.connected_at ?? null,
        last_sync_at: p?.last_sync_at ?? null,
        last_error: p?.last_error ?? null,
        ...(p?.place_id ? placeLinks(p.place_id) : {}),
      };
    };

    router.get('/api/google-reviews', 'location', (ctx) => {
      const p = getPlace(ctx.locationId);
      const business = app.services.googleBusinessStatus?.(ctx.locationId) ?? null;
      const configured = !!(p?.api_key && p.place_id) || !!business?.ready;
      const reviews = db.all('SELECT * FROM google_reviews WHERE location_id = ? ORDER BY COALESCE(published_at, first_seen_at) DESC LIMIT 200', ctx.locationId);
      const trend = db.all('SELECT day, rating, total FROM google_review_stats WHERE location_id = ? ORDER BY day DESC LIMIT 120', ctx.locationId).reverse();
      // Change over the last 30 days (or since the first snapshot, if younger).
      const loc = app.location(ctx.locationId)!;
      const ref = trend.filter((t) => t.day <= addDaysYmd(ymdInTz(new Date(), loc.timezone), -30)).pop() ?? trend[0];
      const last = trend[trend.length - 1];
      return {
        configured,
        business,
        place: p?.place_id ? { id: p.place_id, name: p.place_name, address: p.place_address, maps_url: p.maps_url, ...placeLinks(p.place_id) } : null,
        rating: p?.rating ?? null,
        total: p?.total ?? null,
        last_sync_at: p?.last_sync_at ?? null,
        last_error: p?.last_error ?? null,
        trend,
        change: ref && last && ref.day !== last.day ? { since: ref.day, rating: Math.round((last.rating - ref.rating) * 10) / 10, total: last.total - ref.total } : null,
        distribution: [1, 2, 3, 4, 5].map((n) => reviews.filter((r) => r.rating === n).length),
        reviews,
      };
    });
    router.post('/api/google-reviews/sync', 'location', (ctx) => syncGoogleReviews(app, ctx.locationId));

    router.get('/api/google-reviews/settings', 'location', (ctx) => settingsOut(ctx.locationId));
    router.put('/api/google-reviews/settings', 'location', async (ctx) => {
      const b = ctx.body ?? {};
      const cur = getPlace(ctx.locationId);
      if (!cur) db.insert('google_places', { location_id: ctx.locationId, updated_at: now() });
      let changedKey = false;
      if (b.api_key === null) db.run('UPDATE google_places SET api_key = NULL WHERE location_id = ?', ctx.locationId);
      else if (typeof b.api_key === 'string' && b.api_key.trim() && b.api_key !== MASK) {
        const key = b.api_key.trim();
        if (!/^[A-Za-z0-9_-]{20,200}$/.test(key)) throw bad('API-Schlüssel ungültig (beginnt meist mit „AIza“)');
        db.run('UPDATE google_places SET api_key = ? WHERE location_id = ?', sealSecret(app, key), ctx.locationId);
        changedKey = true;
      }
      let changedPlace = false;
      if (b.place_id !== undefined) {
        const pid = str(b.place_id, 'Place ID', { max: 300 }).replace(/^places\//, '');
        if (pid && !/^[A-Za-z0-9_-]{10,300}$/.test(pid)) throw bad('Place ID ungültig (z. B. ChIJ…)');
        if (pid !== (cur?.place_id ?? '')) {
          changedPlace = true;
          // A different place: its reviews and history start fresh.
          db.run('DELETE FROM google_reviews WHERE location_id = ?', ctx.locationId);
          db.run('DELETE FROM google_review_stats WHERE location_id = ?', ctx.locationId);
          db.run(
            `UPDATE google_places SET place_id = ?, place_name = ?, place_address = ?, maps_url = NULL, rating = NULL, total = NULL, connected_at = ?, last_sync_at = NULL, last_error = NULL WHERE location_id = ?`,
            pid,
            str(b.place_name, 'Name', { max: 300 }),
            str(b.place_address, 'Adresse', { max: 500 }),
            pid ? now() : null,
            ctx.locationId,
          );
        }
      }
      db.run('UPDATE google_places SET updated_at = ? WHERE location_id = ?', now(), ctx.locationId);
      // Fetch right away so rating and reviews show up without waiting a day.
      const p = getPlace(ctx.locationId);
      let sync: unknown = null;
      if (p?.api_key && p.place_id && (changedPlace || changedKey || !p.last_sync_at || p.last_error)) sync = await syncGoogleReviews(app, ctx.locationId).catch((e) => ({ error: (e as Error).message }));
      return { ...settingsOut(ctx.locationId), sync };
    });
    router.delete('/api/google-reviews/settings', 'location', (ctx) => {
      db.run('DELETE FROM google_reviews WHERE location_id = ?', ctx.locationId);
      db.run('DELETE FROM google_review_stats WHERE location_id = ?', ctx.locationId);
      db.run('DELETE FROM google_places WHERE location_id = ?', ctx.locationId);
      return { ok: true };
    });
    /** "Place ID finden": Places Text Search with the stored (or just typed) key. */
    router.post('/api/google-reviews/settings/find-place', 'location', async (ctx) => {
      const query = str(ctx.body.query, 'Suchbegriff', { required: true, max: 200 });
      const typed = typeof ctx.body.api_key === 'string' && ctx.body.api_key !== MASK ? ctx.body.api_key.trim() : '';
      const stored = getPlace(ctx.locationId)?.api_key;
      const key = typed || (stored ? openSecret(app, stored) : '');
      if (!key) throw bad('Erst den API-Schlüssel eintragen');
      const j = await google(app, `${PLACES}/places:searchText`, key, { method: 'POST', mask: SEARCH_MASK, body: { textQuery: query, languageCode: 'de', pageSize: 5 } });
      return (Array.isArray(j.places) ? j.places : []).slice(0, 5).map((p: any) => ({
        place_id: String(p.id ?? ''),
        name: String(p.displayName?.text ?? ''),
        address: String(p.formattedAddress ?? ''),
        rating: typeof p.rating === 'number' ? p.rating : null,
        total: Number(p.userRatingCount ?? 0),
        maps_url: /^https:\/\//.test(String(p.googleMapsUri ?? '')) ? p.googleMapsUri : null,
      }));
    });

    /** Rating badge and the best Google reviews for the review widget (reputation module). */
    app.services.reviewWidgetGoogle = (locationId: string): { header: string; cards: string[] } | undefined => {
      const p = getPlace(locationId);
      if (!p?.place_id || p.rating == null) return undefined;
      const links = placeLinks(p.place_id);
      const header = `<div class="card" style="padding:16px 18px;margin-bottom:14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <strong style="font-size:28px">${String(Number(p.rating).toFixed(1)).replace('.', ',')}</strong>
        <span style="color:#f59e0b;font-size:20px" aria-label="${escapeHtml(String(p.rating))} von 5 Sternen">${stars(p.rating)}</span>
        <span class="muted">${Number(p.total ?? 0)} Bewertungen auf Google</span>
        <a href="${escapeHtml(links.reviews_url)}" target="_blank" rel="noopener" style="margin-left:auto">Alle auf Google ansehen</a></div>`;
      const cards = db
        .all(`SELECT * FROM google_reviews WHERE location_id = ? AND rating >= 4 AND text != '' ORDER BY COALESCE(published_at, first_seen_at) DESC LIMIT 6`, locationId)
        .map(
          (r) => `<div class="card" style="padding:18px"><div style="color:#f59e0b">${'★'.repeat(r.rating)}</div><p>${escapeHtml(r.text.length > 400 ? `${r.text.slice(0, 400)}…` : r.text)}</p>
          <p class="muted" style="font-size:13px">${r.author_url ? `<a href="${escapeHtml(r.author_url)}" target="_blank" rel="noopener">${escapeHtml(r.author)}</a>` : escapeHtml(r.author)} · <a href="${escapeHtml(r.link)}" target="_blank" rel="noopener">auf Google</a></p></div>`,
        );
      return { header, cards };
    };

    // Daily sync (failed attempts are retried after an hour).
    let running = false;
    app.onTick(async () => {
      if (running) return;
      running = true;
      try {
        const rows = db.all(`SELECT location_id, api_key, place_id, last_sync_at, last_error FROM google_places`);
        for (const r of rows) {
          if (!(r.api_key && r.place_id) && !app.services.googleBusinessReady?.(r.location_id)) continue;
          const age = r.last_sync_at ? Date.now() - Date.parse(r.last_sync_at) : Infinity;
          if (age < (r.last_error ? 3600_000 : 24 * 3600_000)) continue;
          await syncGoogleReviews(app, r.location_id).catch(() => undefined);
        }
      } finally {
        running = false;
      }
    });
  },
};
