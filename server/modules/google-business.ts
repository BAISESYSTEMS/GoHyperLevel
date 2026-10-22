import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, str } from '../core/http.js';
import { render } from '../core/template.js';
import { id, now } from '../core/util.js';
import { BusinessError, CTA_LABEL, CTA_TYPES, businessApi, isAccountName, isLocationName, type CtaType, type LocalPostInput } from '../services/google-business.js';
import { syncGoogleReviews, type ReviewInput, type ReviewMeta } from './google-reviews.js';
import type { Tool } from './mcp.js';
import { connectionOut, type OAuthConnection } from './oauth-connect.js';

/**
 * Google Business Profile for a sub-account (OAuth connection per location, see oauth-connect):
 * pick the business location, read all reviews with their replies (feeds google-reviews instead of
 * the Places API), reply / edit / delete replies from the Bewertungen page and publish local posts
 * (text, image, call-to-action) – also as workflow action "Google-Beitrag erstellen" and MCP tools.
 * Google must approve Business Profile API access for the Cloud project.
 */

export const GOOGLE_POST_ACTION = 'google_post';

const TOOLS: Tool[] = [
  {
    name: 'ghl_reply_google_review',
    title: 'Auf Google-Bewertung antworten',
    description:
      'Antwortet öffentlich auf eine Google-Rezension (oder ändert die Antwort; mit delete: true wird sie gelöscht). Braucht ein verbundenes Google-Unternehmensprofil. review_id kommt aus ghl_google_reviews.',
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' },
        review_id: { type: 'string', description: 'ID der Rezension (aus ghl_google_reviews)' },
        reply: { type: 'string', description: 'Antworttext (höflich, ohne persönliche Daten, max. 4096 Zeichen)' },
        delete: { type: 'boolean', description: 'true = vorhandene Antwort löschen' },
      },
      required: ['location_id', 'review_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: async (call, a) => {
      const path = `/api/google-reviews/${encodeURIComponent(a.review_id)}/reply`;
      if (a.delete) return call.api('DELETE', path, { location: a.location_id });
      return call.api('POST', path, { location: a.location_id, body: { comment: a.reply } });
    },
  },
  {
    name: 'ghl_create_google_post',
    title: 'Google-Beitrag erstellen',
    description: 'Veröffentlicht sofort einen Beitrag im Google-Unternehmensprofil des Projekts (Text, optional Bild-URL und Button). Braucht ein verbundenes Unternehmensprofil.',
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' },
        text: { type: 'string', description: 'Beitragstext, max. 1500 Zeichen' },
        image_url: { type: 'string', description: 'Optional: öffentlich erreichbare https-Bild-URL (JPG/PNG)' },
        cta_type: { type: 'string', enum: [...CTA_TYPES], description: 'Optional: Button – LEARN_MORE, BOOK, ORDER, SHOP, SIGN_UP oder CALL' },
        cta_url: { type: 'string', description: 'Ziel-URL des Buttons (nicht bei CALL)' },
      },
      required: ['location_id', 'text'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: (call, a) => call.api('POST', '/api/google-reviews/posts', { location: a.location_id, body: { summary: a.text, image_url: a.image_url, cta_type: a.cta_type, cta_url: a.cta_url } }),
  },
];

export const googleBusinessModule: Module = {
  name: 'google-business',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE google_posts (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, gbp_name TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL, image_url TEXT NOT NULL DEFAULT '', cta_type TEXT NOT NULL DEFAULT '', cta_url TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT '', search_url TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', user_id TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX google_posts_loc ON google_posts(location_id, created_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];

    const conn = (loc: string): OAuthConnection | undefined => app.services.oauth?.business(loc);
    const needsReconnect = (c: OAuthConnection) => c.status === 'error' && /neu verbinden/.test(c.last_error ?? '');
    const ready = (loc: string) => {
      const c = conn(loc);
      return !!c && !needsReconnect(c) && isAccountName(c.settings.account) && isLocationName(c.settings.location);
    };
    const apiOf = (c: OAuthConnection) => businessApi(app.services.oauth.fetcher(), (force?: boolean) => app.services.oauth.token(c.id, force));
    const readyConn = (loc: string) => {
      const c = conn(loc);
      if (!c) throw new HttpError(409, 'Google-Unternehmensprofil ist nicht verbunden (Einstellungen → Bewertungen)');
      if (needsReconnect(c)) throw new HttpError(409, 'Google-Zugriff abgelaufen – bitte das Unternehmensprofil neu verbinden');
      if (!isAccountName(c.settings.account) || !isLocationName(c.settings.location)) throw new HttpError(409, 'Erst den Standort des Unternehmensprofils wählen (Einstellungen → Bewertungen)');
      return c;
    };
    const asHttp = (e: unknown): never => {
      if (e instanceof BusinessError) throw new HttpError(e.status === 400 ? 400 : 502, e.message);
      throw e;
    };
    const ensurePlaceRow = (loc: string) => {
      if (!db.get('SELECT 1 FROM google_places WHERE location_id = ?', loc)) db.insert('google_places', { location_id: loc, updated_at: now() });
    };

    const status = (loc: string) => {
      const c = conn(loc);
      if (!c) return { connected: false, ready: false, configured: !!app.services.oauth?.configured('google') };
      return {
        connected: true,
        ready: ready(loc),
        configured: !!app.services.oauth?.configured('google'),
        connection: connectionOut(c),
        account: c.settings.account ?? '',
        location: c.settings.location ?? '',
        location_title: c.settings.location_title ?? '',
        location_address: c.settings.location_address ?? '',
        needs_reconnect: needsReconnect(c),
      };
    };
    app.services.googleBusinessReady = ready;
    app.services.googleBusinessStatus = (loc: string) => {
      const s = status(loc);
      return s.connected ? { ready: s.ready, account_email: s.connection?.account_email ?? '', location_title: s.location_title ?? '', needs_reconnect: !!s.needs_reconnect } : null;
    };

    /** Reviews + rating from the Business Profile API, in the shape google-reviews stores. */
    app.services.googleBusinessFetch = async (loc: string): Promise<{ reviews: ReviewInput[]; meta: ReviewMeta }> => {
      const c = readyConn(loc);
      ensurePlaceRow(loc);
      let r;
      try {
        r = await apiOf(c).listReviews(c.settings.account, c.settings.location, 200);
      } catch (e) {
        return asHttp(e);
      }
      const link = c.settings.maps_url || 'https://business.google.com/reviews';
      const place = db.get('SELECT place_id FROM google_places WHERE location_id = ?', loc);
      return {
        reviews: r.reviews.map((x) => ({
          key: x.name,
          author: x.author,
          author_url: '',
          author_photo: x.author_photo,
          rating: x.rating,
          text: x.text,
          language: '',
          published_at: x.published_at,
          relative_time: '',
          link,
          reply_text: x.reply_text,
          reply_at: x.reply_at,
        })),
        meta: {
          place_id: c.settings.place_id || place?.place_id || '',
          connected_at: c.settings.location_at ?? c.created_at,
          rating: r.averageRating,
          total: r.totalReviewCount,
          place_name: c.settings.location_title,
          place_address: c.settings.location_address,
          maps_url: c.settings.maps_url || null,
          quiet_before: c.settings.location_at ?? c.created_at,
        },
      };
    };

    // --- connection: choose the business location ------------------------------------------
    router.get('/api/google-reviews/business', 'location', (ctx) => status(ctx.locationId));
    router.get('/api/google-reviews/business/locations', 'location', async (ctx) => {
      const c = conn(ctx.locationId);
      if (!c) throw new HttpError(409, 'Google-Unternehmensprofil ist nicht verbunden');
      const api = apiOf(c);
      try {
        const out = [];
        for (const acc of (await api.listAccounts()).slice(0, 5)) for (const l of await api.listLocations(acc.name)) out.push({ account: acc.name, account_title: acc.title, ...l });
        return out;
      } catch (e) {
        return asHttp(e);
      }
    });
    router.put('/api/google-reviews/business', 'location', async (ctx) => {
      const c = conn(ctx.locationId);
      if (!c) throw new HttpError(409, 'Google-Unternehmensprofil ist nicht verbunden');
      const account = String(ctx.body.account ?? '');
      const location = String(ctx.body.location ?? '');
      if (!isAccountName(account) || !isLocationName(location)) throw bad('Konto oder Standort ungültig');
      let found;
      try {
        found = (await apiOf(c).listLocations(account)).find((l) => l.name === location);
      } catch (e) {
        return asHttp(e);
      }
      if (!found) throw bad('Standort gehört nicht zu diesem Konto');
      const placeBefore = db.get('SELECT place_id FROM google_places WHERE location_id = ?', ctx.locationId)?.place_id ?? '';
      const changed = c.settings.location !== location;
      // Same place as the Places-API setup: keep its reviews (they are adopted, not duplicated).
      const reset = changed && !(found.place_id && found.place_id === placeBefore);
      app.services.oauth.setSettings(c.id, {
        ...c.settings,
        account,
        location,
        location_title: found.title,
        location_address: found.address,
        place_id: found.place_id,
        maps_url: found.maps_url,
        new_review_url: found.new_review_url,
        location_at: changed ? now() : (c.settings.location_at ?? now()),
      });
      ensurePlaceRow(ctx.locationId);
      if (reset) {
        // Another business: its reviews and history start fresh (like a new Place ID).
        db.run('DELETE FROM google_reviews WHERE location_id = ?', ctx.locationId);
        db.run('DELETE FROM google_review_stats WHERE location_id = ?', ctx.locationId);
        db.run(
          'UPDATE google_places SET place_id = ?, place_name = ?, place_address = ?, maps_url = ?, rating = NULL, total = NULL, connected_at = ?, last_sync_at = NULL, last_error = NULL, updated_at = ? WHERE location_id = ?',
          found.place_id || placeBefore,
          found.title,
          found.address,
          found.maps_url || null,
          now(),
          now(),
          ctx.locationId,
        );
      }
      const sync = await syncGoogleReviews(app, ctx.locationId).catch((e) => ({ error: (e as Error).message }));
      return { ...status(ctx.locationId), sync };
    });

    // --- replies --------------------------------------------------------------------------
    const reviewFor = (loc: string, rid: string) => {
      const r = db.get('SELECT * FROM google_reviews WHERE id = ? AND location_id = ?', rid, loc);
      if (!r) throw notFound('Bewertung nicht gefunden');
      const c = readyConn(loc);
      const m = String(r.review_key).match(/^(accounts\/[0-9]+)\/(locations\/[0-9]+)\/reviews\/([^/]+)$/);
      if (!m || m[1] !== c.settings.account || m[2] !== c.settings.location) throw new HttpError(409, 'Diese Bewertung stammt nicht aus dem verbundenen Unternehmensprofil – bitte erst „Jetzt abrufen“');
      return { r, c, reviewId: m[3] };
    };
    router.post('/api/google-reviews/:id/reply', 'location', async (ctx) => {
      const comment = str(ctx.body.comment, 'Antwort', { required: true, max: 4096 });
      const { r, c, reviewId } = reviewFor(ctx.locationId, ctx.params.id);
      let res;
      try {
        res = await apiOf(c).reply(c.settings.account, c.settings.location, reviewId, comment);
      } catch (e) {
        return asHttp(e);
      }
      // The posted reply replaces the draft (KI-Antwort vorschlagen).
      db.run(`UPDATE google_reviews SET reply_text = ?, reply_at = ?, reply_draft = '', reply_draft_at = NULL, reply_draft_source = '', updated_at = ? WHERE id = ?`, res.comment, res.updated_at ?? now(), now(), r.id);
      return db.get('SELECT * FROM google_reviews WHERE id = ?', r.id);
    });
    router.delete('/api/google-reviews/:id/reply', 'location', async (ctx) => {
      const { r, c, reviewId } = reviewFor(ctx.locationId, ctx.params.id);
      try {
        await apiOf(c).deleteReply(c.settings.account, c.settings.location, reviewId);
      } catch (e) {
        return asHttp(e);
      }
      db.run(`UPDATE google_reviews SET reply_text = '', reply_at = NULL, updated_at = ? WHERE id = ?`, now(), r.id);
      return db.get('SELECT * FROM google_reviews WHERE id = ?', r.id);
    });

    // --- local posts ------------------------------------------------------------------------
    const cleanPost = (b: any): LocalPostInput => {
      const summary = str(b.summary, 'Text', { required: true, max: 1500 });
      const image_url = str(b.image_url, 'Bild-URL', { max: 1000 });
      if (image_url && !/^https:\/\/[^\s]+$/.test(image_url)) throw bad('Bild-URL muss mit https:// beginnen');
      const cta_type = str(b.cta_type, 'Button') as CtaType | '';
      if (cta_type && !CTA_TYPES.includes(cta_type as CtaType)) throw bad('Unbekannter Button-Typ');
      const cta_url = str(b.cta_url, 'Button-Link', { max: 1000 });
      if (cta_type && cta_type !== 'CALL' && !/^https?:\/\/[^\s]+$/.test(cta_url)) throw bad(`Für „${CTA_LABEL[cta_type as CtaType]}“ fehlt der Link (https://…)`);
      return { summary, image_url, cta_type, cta_url: cta_type && cta_type !== 'CALL' ? cta_url : '' };
    };
    async function createPost(loc: string, input: LocalPostInput, source: string, userId?: string) {
      const c = readyConn(loc);
      let res;
      try {
        res = await apiOf(c).createPost(c.settings.account, c.settings.location, input);
      } catch (e) {
        return asHttp(e);
      }
      const row = { id: id(), location_id: loc, gbp_name: res.name, summary: input.summary, image_url: input.image_url ?? '', cta_type: input.cta_type ?? '', cta_url: input.cta_url ?? '', state: res.state, search_url: res.search_url, source, user_id: userId ?? null, created_at: now() };
      db.insert('google_posts', row);
      return row;
    }
    app.services.googlePost = createPost;

    router.get('/api/google-reviews/posts', 'location', (ctx) => db.all('SELECT * FROM google_posts WHERE location_id = ? ORDER BY created_at DESC LIMIT 50', ctx.locationId));
    router.post('/api/google-reviews/posts', 'location', (ctx) => createPost(ctx.locationId, cleanPost(ctx.body ?? {}), ctx.via === 'mcp' ? 'MCP' : ctx.viaApiKey ? 'API' : 'manuell', ctx.user?.id));
    router.delete('/api/google-reviews/posts/:id', 'location', async (ctx) => {
      const p = db.get('SELECT * FROM google_posts WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!p) throw notFound();
      if (p.gbp_name) {
        const c = readyConn(ctx.locationId);
        try {
          await apiOf(c).deletePost(p.gbp_name);
        } catch (e) {
          return asHttp(e);
        }
      }
      db.run('DELETE FROM google_posts WHERE id = ?', p.id);
      return { ok: true };
    });

    // Workflow action: e.g. "new 5-star review → thank-you post" or a weekly offer.
    app.services.workflowActions = {
      ...(app.services.workflowActions ?? {}),
      [GOOGLE_POST_ACTION]: async (run: any, step: any, vars: Record<string, any>) => {
        const input = cleanPost({ summary: render(String(step.body ?? ''), vars).slice(0, 1500), image_url: step.image_url, cta_type: step.cta_type, cta_url: render(String(step.cta_url ?? ''), vars) });
        const row = await createPost(run.location_id, input, 'Workflow');
        return `Google-Beitrag veröffentlicht${row.state ? ` (${row.state})` : ''}`;
      },
    };
  },
};

