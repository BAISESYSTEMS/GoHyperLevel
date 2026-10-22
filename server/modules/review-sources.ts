import type { App, Module } from '../core/app.js';
import { HttpError, bad, clampLimit, notFound, str } from '../core/http.js';
import { openSecret, sealSecret } from '../core/secrets.js';
import { escapeHtml } from '../core/template.js';
import { id, now, safeEqual, token } from '../core/util.js';
import { logActivity } from '../services/contacts.js';
import { notifyTeam } from '../services/messaging.js';
import { safeFetch } from '../services/net.js';
import { MAX_REPLY } from '../services/review-replies.js';
import { reviewAdapter, reviewAdapters, reviewFromRecord, reviewsFromCsv, type AdapterCtx, type Http, type ReviewIn } from '../services/review-sources.js';
import type { Tool } from './mcp.js';

/**
 * Reviews from many platforms in Reputation. A connection per platform (adapter registry in services/review-sources.ts: Facebook,
 * Trustpilot, ProvenExpert, Yelp, Tripadvisor and the generic import for CSV/RSS/web hook) is synced daily; every review lands in
 * one table (`review_items`) with its rating, text, the owner's reply and an AI reply draft. New reviews fire the existing trigger
 * `review.received` (with `source`), low ratings notify the team, the review widget shows every source. Replies go out through the
 * platform's API where it allows that, otherwise the UI links to the platform. Google stays in its own module (google-reviews.ts,
 * Business Profile API). Docs: docs/reputation.md.
 */

const LOW = 3;
const DAY = 24 * 3600_000;
const MASK = '••••••';
const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };

interface Conn {
  id: string;
  location_id: string;
  source: string;
  label: string;
  config: string;
  secrets: string;
  hook_key: string;
  enabled: number;
  rating: number | null;
  total: number | null;
  name: string;
  profile_url: string;
  connected_at: string;
  last_sync_at: string | null;
  last_error: string | null;
}

const TOOLS: Tool[] = [
  {
    name: 'ghl_review_sources',
    title: 'Bewertungen aller Plattformen',
    description:
      'Bewertungen von Facebook, Trustpilot, ProvenExpert, Yelp, Tripadvisor und importierten Plattformen (Jameda, Kununu …) eines Projekts: action list (Standard; Filter source, max_rating), summary (Note und Anzahl je Plattform inkl. Google und eigener Anfragen), suggest (KI-Antwortentwurf, veröffentlicht nichts) oder reply (öffentliche Antwort – nur wo die Plattform-API das erlaubt, sonst kommt reply_link). Google-Bewertungen: ghl_google_reviews.',
    inputSchema: {
      type: 'object',
      properties: {
        ...LOC,
        action: { type: 'string', enum: ['list', 'summary', 'suggest', 'reply'] },
        item_id: { type: 'string', description: 'ID der Bewertung (aus list)' },
        source: { type: 'string', description: 'facebook, trustpilot, provenexpert, yelp, tripadvisor oder import' },
        max_rating: { type: 'integer', minimum: 1, maximum: 5 },
        text: { type: 'string', description: 'Antworttext (bei reply)' },
        instruction: { type: 'string', description: 'Hinweis für den KI-Entwurf' },
      },
      required: ['location_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    klassFor: (a) => (!a.action || a.action === 'list' || a.action === 'summary' ? 'read' : 'write'),
    run: (call, a) => {
      const iid = encodeURIComponent(String(a.item_id ?? ''));
      switch (a.action ?? 'list') {
        case 'list': {
          const q = new URLSearchParams();
          if (a.source) q.set('source', String(a.source));
          if (a.max_rating) q.set('max_rating', String(a.max_rating));
          return call.api('GET', `/api/review-items?${q}`, { location: a.location_id });
        }
        case 'summary':
          return call.api('GET', '/api/review-items/summary', { location: a.location_id });
        case 'suggest':
          return call.api('POST', `/api/review-items/${iid}/suggest-reply`, { location: a.location_id, body: { instruction: a.instruction } });
        case 'reply':
          return call.api('POST', `/api/review-items/${iid}/reply`, { location: a.location_id, body: { text: a.text } });
        default:
          throw new Error('action: list, summary, suggest oder reply');
      }
    },
  },
];

const json = (s: string | null | undefined): Record<string, string> => {
  try {
    const v = JSON.parse(s || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};
const stars = (n: number) => '★'.repeat(Math.max(0, Math.min(5, Math.round(n)))) + '☆'.repeat(5 - Math.max(0, Math.min(5, Math.round(n))));

/** HTTP for the adapters: fixed API hosts; tests swap the network with app.services.reviewSourceFetch. */
function httpFor(app: App): Http {
  return async (url, init = {}) => {
    const f: typeof fetch = app.services.reviewSourceFetch ?? fetch;
    const headers: Record<string, string> = { accept: 'application/json', ...(init.headers ?? {}) };
    let body: string | undefined;
    if (init.json !== undefined) ((headers['content-type'] = 'application/json'), (body = JSON.stringify(init.json)));
    else if (init.form) ((headers['content-type'] = 'application/x-www-form-urlencoded'), (body = new URLSearchParams(init.form).toString()));
    let r: Response;
    try {
      r = await f(url, { method: init.method ?? 'GET', headers, body, signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      throw new HttpError(502, `${new URL(url).host} nicht erreichbar: ${(e as Error).message}`);
    }
    const raw = await r.text();
    let data: any = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }
    return { status: r.status, ok: r.ok, data, text: raw };
  };
}

export const reviewSourcesModule: Module = {
  name: 'review-sources',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE review_connections (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        source TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', config TEXT NOT NULL DEFAULT '{}', secrets TEXT NOT NULL DEFAULT '',
        hook_key TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, rating REAL, total INTEGER, name TEXT NOT NULL DEFAULT '', profile_url TEXT NOT NULL DEFAULT '',
        connected_at TEXT NOT NULL, last_sync_at TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX review_connections_loc ON review_connections(location_id);
      CREATE TABLE review_items (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        connection_id TEXT NOT NULL REFERENCES review_connections(id) ON DELETE CASCADE, source TEXT NOT NULL, external_id TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT '', author_url TEXT NOT NULL DEFAULT '', rating INTEGER, recommend INTEGER, title TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL DEFAULT '', language TEXT NOT NULL DEFAULT '', published_at TEXT, link TEXT NOT NULL DEFAULT '',
        reply_text TEXT NOT NULL DEFAULT '', reply_at TEXT, reply_draft TEXT NOT NULL DEFAULT '', reply_draft_at TEXT, reply_draft_source TEXT NOT NULL DEFAULT '',
        contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL, first_seen_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(connection_id, external_id)
      );
      CREATE INDEX review_items_loc ON review_items(location_id, published_at);
      CREATE INDEX review_items_contact ON review_items(contact_id);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    const http = httpFor(app);

    // --- connections ------------------------------------------------------------------------------------------------
    const connOf = (loc: string, key: string) => {
      const c = db.get<Conn>('SELECT * FROM review_connections WHERE id = ? AND location_id = ?', key, loc);
      if (!c) throw notFound('Verbindung nicht gefunden');
      return c;
    };
    const secretsOf = (c: Conn): Record<string, string> => {
      if (!c.secrets) return {};
      try {
        return json(openSecret(app, c.secrets));
      } catch {
        return {}; // the server secret changed: keys have to be entered again
      }
    };
    const labelOf = (c: Pick<Conn, 'source' | 'label' | 'config'>) => c.label || (c.source === 'import' ? json(c.config).platform_label : '') || reviewAdapter(c.source)?.label || c.source;
    const ctxFor = (c: Conn): AdapterCtx => {
      const config = json(c.config);
      return {
        config,
        secrets: secretsOf(c),
        http,
        graph: app.services.metaKit && config.page_id ? (method, path, body) => app.services.metaKit.graph(c.location_id, 'messenger', method, path, body, config.page_id) : undefined,
        fetchUrl: async (url) => {
          if (app.services.reviewSourceFetch) return (await http(url)).text;
          const r = await safeFetch(url, { headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' }, timeoutMs: 15_000, maxBytes: 2_000_000 });
          if (!r.ok) throw new Error(`Feed nicht abrufbar (${r.status})`);
          return r.text();
        },
      };
    };
    const connOut = (c: Conn) => {
      const a = reviewAdapter(c.source);
      const config = json(c.config);
      const secrets = secretsOf(c);
      const count = db.get<{ n: number; avg: number | null }>('SELECT COUNT(*) n, AVG(rating) avg FROM review_items WHERE connection_id = ?', c.id)!;
      return {
        id: c.id,
        source: c.source,
        label: labelOf(c),
        kind: a?.kind ?? 'import',
        config,
        secrets: Object.fromEntries((a?.fields ?? []).filter((f) => f.secret).map((f) => [f.key, secrets[f.key] ? MASK : ''])),
        enabled: !!c.enabled,
        rating: c.rating ?? (count.avg ? Math.round(count.avg * 10) / 10 : null),
        total: c.total ?? count.n,
        stored: count.n,
        name: c.name,
        profile_url: c.profile_url,
        can_reply: !!a?.reply && a.canReply({ config, secrets }, { external_id: '1', link: '' }),
        mirror: !!a?.mirror,
        hook_url: c.source === 'import' ? `${app.baseUrl()}/hooks/reviews/${c.id}/${c.hook_key}` : null,
        last_sync_at: c.last_sync_at,
        last_error: c.last_error,
      };
    };

    /** Validates a connection's fields against its adapter; secrets are sealed, a masked or empty secret keeps the stored one. */
    const cleanFields = (source: string, b: any, cur?: Conn) => {
      const a = reviewAdapter(source);
      if (!a) throw bad(`Unbekannte Plattform – möglich: ${reviewAdapters().map((x) => x.id).join(', ')}`);
      const config = cur ? json(cur.config) : {};
      const secrets = cur ? secretsOf(cur) : {};
      const src = b.config && typeof b.config === 'object' ? { ...b, ...b.config } : b;
      for (const f of a.fields) {
        const v = src[f.key];
        if (v === undefined) continue;
        if (f.secret) {
          if (v === null) delete secrets[f.key];
          else if (v !== '' && v !== MASK) secrets[f.key] = str(v, f.label, { max: 1000 }).trim();
        } else config[f.key] = str(v, f.label, { max: 500 }).trim();
      }
      for (const f of a.fields) if (f.required && !(f.secret ? secrets[f.key] : config[f.key])) throw bad(`${f.label} fehlt`);
      for (const k of ['profile_url', 'rss_url']) if (config[k] && !/^https:\/\/\S+$/.test(config[k])) throw bad(`${k === 'rss_url' ? 'Feed' : 'Profil-Link'}: nur https-Adressen`);
      if (source === 'facebook') {
        const ids = app.services.metaKit?.ids(cur?.location_id ?? b.__loc);
        if (!ids?.pages?.some((p: any) => p.page_id === config.page_id && p.messenger)) throw bad('Diese Facebook-Seite ist nicht unter Einstellungen → Kanäle verbunden');
      }
      return { config, secrets };
    };

    // --- storing what a fetch returned ------------------------------------------------------------------------------
    /** One review name that matches exactly one contact links the review to it (as for Google). */
    const matchContact = (loc: string, author: string): string | null => {
      if (!author.trim() || /^(anonym|.*-nutzer)$/i.test(author.trim())) return null;
      const rows = db.all(`SELECT id FROM contacts WHERE location_id = ? AND lower(trim(first_name || ' ' || last_name)) = lower(trim(?)) LIMIT 2`, loc, author);
      return rows.length === 1 ? rows[0].id : null;
    };

    /** Upserts reviews of a connection; new ones (after the connection existed) are announced once. */
    const store = (c: Conn, list: ReviewIn[], o: { mirror?: boolean; announce?: boolean } = {}) => {
      const label = labelOf(c);
      const firstSync = !db.get('SELECT 1 FROM review_items WHERE connection_id = ? LIMIT 1', c.id);
      const fresh: any[] = [];
      const seen = new Set<string>();
      for (const r of list) {
        const ext = String(r.externalId ?? '').slice(0, 300);
        if (!ext || seen.has(ext)) continue;
        seen.add(ext);
        const cur = db.get<{ id: string }>('SELECT id FROM review_items WHERE connection_id = ? AND external_id = ?', c.id, ext);
        const fields = {
          author: String(r.author ?? '').slice(0, 200),
          author_url: r.authorUrl ?? '',
          rating: r.rating,
          recommend: r.recommend === undefined || r.recommend === null ? null : r.recommend ? 1 : 0,
          title: r.title ?? '',
          text: r.text ?? '',
          language: r.language ?? '',
          published_at: r.publishedAt,
          link: r.link ?? '',
          ...(r.replyText !== undefined && r.replyText !== '' ? { reply_text: r.replyText, reply_at: r.replyAt ?? null } : {}),
        };
        if (cur) {
          db.update('review_items', cur.id, { ...fields, updated_at: now() });
          continue;
        }
        const row = { id: id(), location_id: c.location_id, connection_id: c.id, source: c.source, external_id: ext, ...fields, contact_id: matchContact(c.location_id, fields.author), first_seen_at: now(), updated_at: now() };
        db.insert('review_items', row);
        // Reviews written before the connection existed are history, not news (the first sync imports them quietly).
        const old = firstSync && (!r.publishedAt || r.publishedAt < c.connected_at);
        if (o.announce !== false && !old) fresh.push(row);
      }
      // Yelp/Tripadvisor terms: keep only what the latest answer contained.
      if (o.mirror) {
        const keep = [...seen];
        db.run(`DELETE FROM review_items WHERE connection_id = ?${keep.length ? ` AND external_id NOT IN (${keep.map(() => '?').join(',')})` : ''}`, c.id, ...keep);
      }
      for (const r of fresh) {
        const low = r.rating !== null && r.rating <= LOW;
        if (r.contact_id) logActivity(app, c.location_id, r.contact_id, 'review.received', `${label}-Bewertung: ${r.rating ? stars(r.rating) : ''}${r.text ? ` – ${String(r.text).slice(0, 80)}` : ''}`);
        if (low) void notifyTeam(app, c.location_id, `Neue ${label}-Bewertung: ${r.rating}★ von ${r.author}`, `${r.author} hat ${r.rating} von 5 Sternen gegeben:\n\n${r.text || '(ohne Text)'}\n\n${r.link ? `Ansehen: ${r.link}\n` : ''}Alle Bewertungen: ${app.baseUrl()}/app/reviews`);
        app.events.emit(c.location_id, 'review.received', { contactId: r.contact_id ?? undefined, reviewId: r.id, source: c.source, platform: label, rating: r.rating, comment: r.text, author: r.author, link: r.link, low });
      }
      return { fetched: list.length, new: fresh.length };
    };

    const sync = async (c: Conn) => {
      const a = reviewAdapter(c.source);
      if (!a) throw bad('Plattform nicht mehr verfügbar');
      try {
        const r = await a.fetch(ctxFor(c));
        const out = store(c, r.reviews, { mirror: a.mirror });
        db.run(
          'UPDATE review_connections SET rating = COALESCE(?, rating), total = COALESCE(?, total), name = COALESCE(NULLIF(?, \'\'), name), profile_url = COALESCE(NULLIF(?, \'\'), profile_url), last_sync_at = ?, last_error = NULL, updated_at = ? WHERE id = ?',
          r.rating ?? null,
          r.total ?? null,
          r.name ?? '',
          r.profileUrl ?? '',
          now(),
          now(),
          c.id,
        );
        return { ...out, rating: r.rating ?? null, total: r.total ?? null };
      } catch (e) {
        db.run('UPDATE review_connections SET last_sync_at = ?, last_error = ? WHERE id = ?', now(), String((e as Error).message).slice(0, 500), c.id);
        throw e instanceof HttpError ? e : new HttpError(502, (e as Error).message);
      }
    };

    // Daily sync per connection (failed ones again after an hour).
    let running = false;
    app.onTick(async () => {
      if (running) return;
      running = true;
      try {
        for (const c of db.all<Conn>(`SELECT * FROM review_connections WHERE enabled = 1 AND (source != 'import' OR json_extract(config, '$.rss_url') != '') LIMIT 500`)) {
          const age = c.last_sync_at ? Date.now() - Date.parse(c.last_sync_at) : Infinity;
          if (age < (c.last_error ? 3600_000 : DAY)) continue;
          await sync(c).catch(() => undefined);
        }
      } finally {
        running = false;
      }
    });

    // --- connection routes ------------------------------------------------------------------------------------------
    router.get('/api/review-sources', 'location', (ctx) => ({
      adapters: reviewAdapters().map((a) => ({ id: a.id, label: a.label, kind: a.kind, hint: a.hint, mirror: !!a.mirror, replies: !!a.reply, fields: a.fields })),
      connections: db.all<Conn>('SELECT * FROM review_connections WHERE location_id = ? ORDER BY created_at', ctx.locationId).map(connOut),
      facebook_pages: (app.services.metaKit?.ids(ctx.locationId)?.pages ?? []).filter((p: any) => p.messenger).map((p: any) => ({ page_id: p.page_id, page_name: p.page_name })),
    }));
    router.post('/api/review-sources', 'location', async (ctx) => {
      const source = str(ctx.body?.source, 'Plattform', { required: true, max: 40 });
      const { config, secrets } = cleanFields(source, { ...(ctx.body ?? {}), __loc: ctx.locationId });
      if (db.get<{ n: number }>('SELECT COUNT(*) n FROM review_connections WHERE location_id = ?', ctx.locationId)!.n >= 30) throw bad('Höchstens 30 Bewertungsquellen je Sub-Account');
      const row = {
        id: id(),
        location_id: ctx.locationId,
        source,
        label: str(ctx.body?.label, 'Name', { max: 80 }),
        config: JSON.stringify(config),
        secrets: Object.keys(secrets).length ? sealSecret(app, JSON.stringify(secrets)) : '',
        hook_key: token(18),
        enabled: 1,
        connected_at: now(),
        created_at: now(),
        updated_at: now(),
      };
      db.insert('review_connections', row);
      const c = connOf(ctx.locationId, row.id);
      // Fetch right away (quietly: what is there now is history) so the rating shows without waiting a day.
      let result: unknown = null;
      if (source !== 'import' || config.rss_url) result = await sync(c).catch((e) => ({ error: (e as Error).message }));
      return { ...connOut(connOf(ctx.locationId, row.id)), sync: result };
    });
    router.patch('/api/review-sources/:id', 'location', (ctx) => {
      const cur = connOf(ctx.locationId, ctx.params.id);
      const { config, secrets } = cleanFields(cur.source, ctx.body ?? {}, cur);
      const patch: Record<string, unknown> = { config: JSON.stringify(config), secrets: Object.keys(secrets).length ? sealSecret(app, JSON.stringify(secrets)) : '', updated_at: now(), last_error: null };
      if (ctx.body?.label !== undefined) patch.label = str(ctx.body.label, 'Name', { max: 80 });
      if (ctx.body?.enabled !== undefined) patch.enabled = ctx.body.enabled ? 1 : 0;
      db.update('review_connections', cur.id, patch);
      return connOut(connOf(ctx.locationId, cur.id));
    });
    router.delete('/api/review-sources/:id', 'location', (ctx) => {
      const cur = connOf(ctx.locationId, ctx.params.id);
      db.run('DELETE FROM review_items WHERE connection_id = ?', cur.id);
      db.run('DELETE FROM review_connections WHERE id = ?', cur.id);
      return { ok: true };
    });
    router.post('/api/review-sources/:id/sync', 'location', async (ctx) => sync(connOf(ctx.locationId, ctx.params.id)));
    /** CSV upload for the import adapter (header row: author/name, rating/sterne, text/kommentar, date/datum, link, id, reply). */
    router.post('/api/review-sources/:id/import', 'location', (ctx) => {
      const c = connOf(ctx.locationId, ctx.params.id);
      if (c.source !== 'import') throw bad('CSV-Import gibt es nur für Import-Quellen');
      const csv = str(ctx.body?.csv, 'CSV', { required: true, max: 3_000_000 });
      const list = reviewsFromCsv(csv, json(c.config).profile_url ?? '');
      if (!list.length) throw bad('Keine Bewertungen gefunden – erste Zeile mit Spaltennamen wie author, rating, text, date');
      // An upload is a look back: it is stored without announcing every old review.
      return store(c, list, { announce: ctx.body?.announce === true });
    });
    /** Web hook of an import source: one review or {reviews: [...]} as JSON (Zapier, Make, a scraper you run yourself). */
    router.post('/hooks/reviews/:id/:key', 'public', (ctx) => {
      const c = db.get<Conn>('SELECT * FROM review_connections WHERE id = ?', ctx.params.id);
      if (!c || c.source !== 'import' || !safeEqual(ctx.params.key, c.hook_key)) throw notFound();
      if (!c.enabled) throw new HttpError(409, 'Quelle ist abgeschaltet');
      const body = ctx.body ?? {};
      const raw: unknown[] = Array.isArray(body) ? body : Array.isArray(body.reviews) ? body.reviews : [body];
      const list = raw.slice(0, 200).map((r) => (r && typeof r === 'object' ? reviewFromRecord(r as Record<string, unknown>, json(c.config).profile_url ?? '') : null)).filter((x): x is ReviewIn => !!x);
      if (!list.length) throw bad('Keine Bewertung im Body (Felder: author, rating, text, date, link, id)');
      return { ok: true, ...store(c, list) };
    });

    // --- the unified list -----------------------------------------------------------------------------------------------
    const itemOf = (loc: string, key: string) => {
      const r = db.get<any>('SELECT * FROM review_items WHERE id = ? AND location_id = ?', key, loc);
      if (!r) throw notFound('Bewertung nicht gefunden');
      return r;
    };
    const itemOut = (r: any, conns: Map<string, Conn>) => {
      const c = conns.get(r.connection_id);
      const a = reviewAdapter(r.source);
      const config = c ? json(c.config) : {};
      const canReply = !!(c && a?.reply && a.canReply({ config, secrets: secretsOf(c) }, r));
      return { ...r, recommend: r.recommend === null ? null : !!r.recommend, platform: c ? labelOf(c) : r.source, can_reply: canReply, reply_link: a ? a.replyLink({ ...config, profile_url: config.profile_url || c?.profile_url || '' }, r) : r.link };
    };
    const connMap = (loc: string) => new Map(db.all<Conn>('SELECT * FROM review_connections WHERE location_id = ?', loc).map((c) => [c.id, c]));

    /** Rating and count per platform: the connected sources, Google (google-reviews) and the sub-account's own review requests. */
    const summary = (loc: string) => {
      const out: { source: string; label: string; rating: number | null; total: number; url: string }[] = [];
      for (const c of db.all<Conn>('SELECT * FROM review_connections WHERE location_id = ? AND enabled = 1 ORDER BY created_at', loc)) {
        const o = connOut(c);
        if (o.rating !== null || o.total) out.push({ source: c.source, label: o.label, rating: o.rating, total: Number(o.total ?? 0), url: o.profile_url });
      }
      try {
        const g = db.get<any>('SELECT place_id, rating, total FROM google_places WHERE location_id = ?', loc);
        if (g?.rating != null) out.unshift({ source: 'google', label: 'Google', rating: g.rating, total: Number(g.total ?? 0), url: g.place_id ? `https://search.google.com/local/reviews?placeid=${encodeURIComponent(g.place_id)}` : '' });
      } catch {
        /* google-reviews not loaded */
      }
      const own = db.get<{ n: number; avg: number | null }>('SELECT COUNT(*) n, AVG(rating) avg FROM review_requests WHERE location_id = ? AND rating IS NOT NULL', loc);
      if (own?.n) out.push({ source: 'own', label: 'Eigene Anfragen', rating: Math.round((own.avg ?? 0) * 10) / 10, total: own.n, url: '' });
      const rated = out.filter((x) => x.rating !== null && x.total > 0);
      const total = rated.reduce((s, x) => s + x.total, 0);
      return { platforms: out, overall: total ? { rating: Math.round((rated.reduce((s, x) => s + (x.rating ?? 0) * x.total, 0) / total) * 10) / 10, total } : null };
    };

    router.get('/api/review-items', 'location', (ctx) => {
      const where = ['location_id = ?'];
      const args: any[] = [ctx.locationId];
      const source = ctx.query.get('source');
      if (source && /^[a-z]{2,20}$/.test(source)) (where.push('source = ?'), args.push(source));
      const conn = ctx.query.get('connection_id');
      if (conn) (where.push('connection_id = ?'), args.push(conn));
      const max = Number(ctx.query.get('max_rating'));
      if (max >= 1 && max <= 5) (where.push('rating <= ?'), args.push(max));
      if (ctx.query.get('open') === '1') where.push(`reply_text = ''`);
      const conns = connMap(ctx.locationId);
      const items = db.all(`SELECT * FROM review_items WHERE ${where.join(' AND ')} ORDER BY COALESCE(published_at, first_seen_at) DESC LIMIT ?`, ...args, clampLimit(ctx.query.get('limit'), 100, 500)).map((r) => itemOut(r, conns));
      return { items, summary: summary(ctx.locationId) };
    });
    router.get('/api/review-items/summary', 'location', (ctx) => summary(ctx.locationId));

    // --- replies and AI drafts ----------------------------------------------------------------------------------------
    const draft = async (loc: string, r: any, o: { tone?: unknown; instruction?: string; source: 'ai' | 'auto'; userId?: string | null }) => {
      const svc = app.services.reviewReplies;
      if (!svc?.suggest) throw new HttpError(409, 'KI-Antworten sind nicht verfügbar');
      const c = connMap(loc).get(r.connection_id);
      const out = await svc.suggest(loc, { author: r.author, rating: r.rating ?? (r.recommend ? 5 : 1), text: [r.title, r.text].filter(Boolean).join('\n'), language: r.language, published_at: r.published_at, platform: c ? labelOf(c) : r.source }, { tone: o.tone, instruction: o.instruction, userId: o.userId });
      db.run('UPDATE review_items SET reply_draft = ?, reply_draft_at = ?, reply_draft_source = ?, updated_at = ? WHERE id = ?', out.text, now(), o.source, now(), r.id);
      return out;
    };
    router.post('/api/review-items/:id/suggest-reply', 'location', async (ctx) => {
      const r = itemOf(ctx.locationId, ctx.params.id);
      const out = await draft(ctx.locationId, r, { tone: ctx.body?.tone, instruction: str(ctx.body?.instruction, 'Hinweis', { max: 500 }), source: 'ai', userId: ctx.user?.id ?? null });
      return { ...out, item: itemOut(itemOf(ctx.locationId, r.id), connMap(ctx.locationId)) };
    });
    router.put('/api/review-items/:id/reply-draft', 'location', (ctx) => {
      const r = itemOf(ctx.locationId, ctx.params.id);
      const t = str(ctx.body?.text, 'Entwurf', { required: true, max: MAX_REPLY });
      db.run('UPDATE review_items SET reply_draft = ?, reply_draft_at = ?, reply_draft_source = ?, updated_at = ? WHERE id = ?', t, now(), r.reply_draft === t ? r.reply_draft_source : 'edited', now(), r.id);
      return itemOut(itemOf(ctx.locationId, r.id), connMap(ctx.locationId));
    });
    router.delete('/api/review-items/:id/reply-draft', 'location', (ctx) => {
      const r = itemOf(ctx.locationId, ctx.params.id);
      db.run(`UPDATE review_items SET reply_draft = '', reply_draft_at = NULL, reply_draft_source = '', updated_at = ? WHERE id = ?`, now(), r.id);
      return itemOut(itemOf(ctx.locationId, r.id), connMap(ctx.locationId));
    });
    /** Public reply through the platform's API; platforms without one answer 409 with the link to reply there. */
    router.post('/api/review-items/:id/reply', 'location', async (ctx) => {
      const r = itemOf(ctx.locationId, ctx.params.id);
      const t = str(ctx.body?.text, 'Antwort', { required: true, max: MAX_REPLY }).trim();
      const c = connMap(ctx.locationId).get(r.connection_id);
      const a = reviewAdapter(r.source);
      if (!c || !a) throw notFound('Verbindung nicht gefunden');
      const out = itemOut(r, connMap(ctx.locationId));
      if (!out.can_reply || !a.reply) throw new HttpError(409, `${labelOf(c)} erlaubt hier keine Antwort über die API – bitte auf der Plattform antworten`, { reply_link: out.reply_link });
      await a.reply(ctxFor(c), r, t).catch((e) => {
        throw e instanceof HttpError ? e : new HttpError(502, (e as Error).message);
      });
      db.run(`UPDATE review_items SET reply_text = ?, reply_at = ?, reply_draft = '', reply_draft_at = NULL, reply_draft_source = '', updated_at = ? WHERE id = ?`, t, now(), now(), r.id);
      return itemOut(itemOf(ctx.locationId, r.id), connMap(ctx.locationId));
    });
    // Auto-draft for new reviews when the reply settings say so (a draft only – never posted).
    app.events.on('review.received', async (e) => {
      const rid = String(e.data?.reviewId ?? '');
      if (!rid || !e.data?.source || !app.services.reviewReplies?.autoDraft?.(e.locationId)) return;
      const r = db.get<any>('SELECT * FROM review_items WHERE id = ? AND location_id = ?', rid, e.locationId);
      if (!r || r.reply_text || r.reply_draft) return;
      await draft(e.locationId, r, { source: 'auto' }).catch((err) => console.error(`[review-sources] auto-draft failed: ${(err as Error).message}`));
    });

    // DSGVO: a review stays public on its platform – erasing a contact only unlinks it (as for Google reviews).
    app.services.privacyErase = [...(app.services.privacyErase ?? []), (_app: App, loc: string, contact: { id: string }) => void db.run('UPDATE review_items SET contact_id = NULL WHERE location_id = ? AND contact_id = ?', loc, contact.id)];

    // The review widget (modules/reputation.ts) shows a badge per platform and the best reviews of every source.
    app.services.reviewWidgetParts = [
      ...(app.services.reviewWidgetParts ?? []),
      (loc: string): { header: string; cards: string[] } | undefined => {
        const conns = db.all<Conn>('SELECT * FROM review_connections WHERE location_id = ? AND enabled = 1 ORDER BY created_at', loc).map(connOut).filter((c) => c.rating !== null && Number(c.total) > 0);
        const items = db.all<any>(`SELECT * FROM review_items WHERE location_id = ? AND rating >= 4 AND text != '' ORDER BY COALESCE(published_at, first_seen_at) DESC LIMIT 9`, loc);
        if (!conns.length && !items.length) return undefined;
        const map = connMap(loc);
        const link = (url: string, label: string) => (/^https:\/\//.test(url) ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>` : escapeHtml(label));
        const header = conns.length
          ? `<div class="card" style="padding:12px 18px;margin-bottom:14px;display:flex;gap:18px;flex-wrap:wrap">${conns
              .map((c) => `<span><strong>${String(Number(c.rating).toFixed(1)).replace('.', ',')}</strong> <span style="color:#f59e0b" aria-label="${escapeHtml(String(c.rating))} von 5 Sternen">★</span> ${link(c.profile_url, c.label)} <span class="muted">(${Number(c.total)})</span></span>`)
              .join('')}</div>`
          : '';
        const cards = items.map((r) => {
          const c = map.get(r.connection_id);
          const body = r.text.length > 400 ? `${r.text.slice(0, 400)}…` : r.text;
          return `<div class="card" style="padding:18px"><div style="color:#f59e0b">${'★'.repeat(r.rating)}</div><p>${escapeHtml(body)}</p><p class="muted" style="font-size:13px">${escapeHtml(r.author)} · ${link(r.link, c ? labelOf(c) : r.source)}</p></div>`;
        });
        return { header, cards };
      },
    ];
  },
};
