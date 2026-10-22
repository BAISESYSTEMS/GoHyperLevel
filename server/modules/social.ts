import type { App, Module } from '../core/app.js';
import { HttpError, bad, notFound, str } from '../core/http.js';
import { render } from '../core/template.js';
import { id, now } from '../core/util.js';
import { postiz, postizBase, type PostizConfig } from '../services/postiz.js';

/**
 * Social planner: plan and publish posts on the clients' social channels. The posting itself (OAuth
 * tokens, platform APIs, scheduler) is done by a self-hosted Postiz; this module talks to its public
 * API, keeps which channel belongs to which sub-account, and adds a workflow action.
 */

/** Platforms the simple composer can post to, with the settings Postiz needs for them. */
export const PROVIDERS: Record<string, { label: string; limit: number; settings: Record<string, any>; needsImage?: boolean }> = {
  x: { label: 'X (Twitter)', limit: 280, settings: { who_can_reply_post: 'everyone' } },
  linkedin: { label: 'LinkedIn', limit: 3000, settings: { post_as_images_carousel: false } },
  'linkedin-page': { label: 'LinkedIn-Seite', limit: 3000, settings: { post_as_images_carousel: false } },
  facebook: { label: 'Facebook', limit: 63206, settings: {} },
  instagram: { label: 'Instagram', limit: 2200, settings: { post_type: 'post', is_trial_reel: false, collaborators: [] }, needsImage: true },
  'instagram-standalone': { label: 'Instagram', limit: 2200, settings: { post_type: 'post', is_trial_reel: false, collaborators: [] }, needsImage: true },
  threads: { label: 'Threads', limit: 500, settings: {} },
  bluesky: { label: 'Bluesky', limit: 300, settings: {} },
  mastodon: { label: 'Mastodon', limit: 500, settings: {} },
  telegram: { label: 'Telegram', limit: 4096, settings: {} },
  gmb: { label: 'Google Unternehmensprofil', limit: 1500, settings: {} },
  nostr: { label: 'Nostr', limit: 10000, settings: {} },
  vk: { label: 'VK', limit: 10000, settings: {} },
};
/**
 * Video-only platforms: usable when a post carries a video (e.g. a clip from the Video-Studio).
 * `title` in the settings is filled from the post's title.
 */
export const VIDEO_PROVIDERS: Record<string, { label: string; limit: number; settings: Record<string, any> }> = {
  youtube: { label: 'YouTube Shorts', limit: 5000, settings: { type: 'public', selfDeclaredMadeForKids: 'no', tags: [] } },
  tiktok: { label: 'TikTok', limit: 2200, settings: { privacy_level: 'PUBLIC_TO_EVERYONE', duet: false, stitch: false, comment: true, autoAddMusic: 'no', brand_content_toggle: false, brand_organic_toggle: false, content_posting_method: 'DIRECT_POST' } },
};
/** Channels a client may connect from the planner (OAuth through Postiz). */
export const CONNECTABLE = ['x', 'linkedin', 'linkedin-page', 'facebook', 'instagram', 'instagram-standalone', 'threads', 'youtube', 'tiktok', 'pinterest', 'gmb'];

const TTL = { integrations: 120_000, posts: 60_000, analytics: 30 * 60_000 };

export function postizConfig(app: App): PostizConfig | null {
  const row = app.db.get('SELECT value FROM agency_settings WHERE key = ?', 'postiz');
  const v = row ? JSON.parse(row.value) : {};
  const url = v.url || process.env.PGHL_POSTIZ_URL || '';
  const api_key = v.api_key || process.env.PGHL_POSTIZ_KEY || '';
  return url && api_key ? { url, api_key } : null;
}

export const socialModule: Module = {
  name: 'social',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE social_channels (
        integration_id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, assigned_at TEXT NOT NULL
      );
      CREATE TABLE social_connects (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, provider TEXT NOT NULL,
        known TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE social_posts (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, postiz_ids TEXT NOT NULL,
        integration_ids TEXT NOT NULL, content TEXT NOT NULL, type TEXT NOT NULL, publish_at TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT '', user_id TEXT, created_at TEXT NOT NULL
      );
      `,
    ],
    [
      // A channel may serve several projects (e.g. one X account for the agency and a product).
      '002-multi-project',
      `
      CREATE TABLE social_channels_new (
        integration_id TEXT NOT NULL, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, assigned_at TEXT NOT NULL,
        PRIMARY KEY (integration_id, location_id)
      );
      INSERT INTO social_channels_new SELECT integration_id, location_id, assigned_at FROM social_channels;
      DROP TABLE social_channels;
      ALTER TABLE social_channels_new RENAME TO social_channels;
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const cache = new Map<string, { at: number; data: any }>();
    const cached = async <T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> => {
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < ttl) return hit.data;
      const data = await load();
      cache.set(key, { at: Date.now(), data });
      return data;
    };
    const dropCache = (prefix: string) => {
      for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
    };
    const cfgOrFail = () => {
      const c = postizConfig(app);
      if (!c) throw new HttpError(409, 'Social Planner ist noch nicht verbunden (Agentur → Integrationen)');
      return c;
    };

    /** All Postiz channels; hands newly connected ones to the sub-account that started the connection. */
    const allChannels = async (fresh = false): Promise<any[]> => {
      const cfg = cfgOrFail();
      if (fresh) dropCache('integrations');
      const list: any[] = await cached('integrations', TTL.integrations, () => postiz(cfg, 'GET', '/integrations'));
      const assigned = new Set(db.all('SELECT integration_id FROM social_channels').map((r) => r.integration_id));
      const since = new Date(Date.now() - 60 * 60_000).toISOString();
      db.run('DELETE FROM social_connects WHERE created_at < ?', since);
      for (const c of db.all('SELECT * FROM social_connects ORDER BY created_at')) {
        const known = new Set(JSON.parse(c.known));
        const added = list.find((i) => !assigned.has(i.id) && !known.has(i.id) && i.identifier === c.provider);
        if (!added) continue;
        db.run('INSERT OR IGNORE INTO social_channels (integration_id, location_id, assigned_at) VALUES (?, ?, ?)', added.id, c.location_id, now());
        db.run('DELETE FROM social_connects WHERE id = ?', c.id);
        assigned.add(added.id);
      }
      return list;
    };
    const channelsOf = async (locationId: string, fresh = false) => {
      const list = await allChannels(fresh);
      const mine = new Set(db.all('SELECT integration_id FROM social_channels WHERE location_id = ?', locationId).map((r) => r.integration_id));
      return list
        .filter((i) => mine.has(i.id))
        .map((i) => ({ id: i.id, name: i.name, identifier: i.identifier, picture: i.picture, profile: i.profile, disabled: !!i.disabled, supported: !!PROVIDERS[i.identifier], video: !!VIDEO_PROVIDERS[i.identifier] || (!!PROVIDERS[i.identifier] && i.identifier !== 'gmb'), limit: PROVIDERS[i.identifier]?.limit ?? VIDEO_PROVIDERS[i.identifier]?.limit ?? null, label: PROVIDERS[i.identifier]?.label ?? VIDEO_PROVIDERS[i.identifier]?.label ?? i.identifier }));
    };
    const postsBetween = async (from: string, to: string, fresh = false): Promise<any[]> => {
      const cfg = cfgOrFail();
      const key = `posts:${from}:${to}`;
      if (fresh) cache.delete(key);
      const r = await cached(key, TTL.posts, () => postiz(cfg, 'GET', `/posts?startDate=${encodeURIComponent(from)}&endDate=${encodeURIComponent(to)}`));
      return r?.posts ?? [];
    };

    /** Creates (or schedules) one post on several of the sub-account's channels. */
    /**
     * `mediaUrls` + `video`: another module hands over a video by a public (signed) URL that Postiz
     * fetches itself, e.g. a Video-Studio clip; then YouTube/TikTok work too and `title` is the
     * YouTube title. `thread`: follow-up parts posted as replies (an X thread).
     */
    const createPost = async (locationId: string, input: { integrationIds: string[]; content: string; type: string; date?: string; uploadIds?: string[]; userId?: string; source?: string; mediaUrls?: string[]; video?: boolean; title?: string; thread?: string[] }) => {
      const cfg = cfgOrFail();
      const type = ['now', 'schedule', 'draft'].includes(input.type) ? input.type : 'schedule';
      const content = String(input.content ?? '').trim();
      if (!content) throw bad('Text fehlt');
      const mine = await channelsOf(locationId);
      const ids = [...new Set((input.integrationIds ?? []).map(String))];
      if (!ids.length) throw bad('Mindestens einen Kanal wählen');
      const video = !!input.video && !!input.mediaUrls?.length;
      const thread = (input.thread ?? []).map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 24);
      const chosen = ids.map((cid) => {
        const c = mine.find((m) => m.id === cid);
        if (!c) throw bad('Kanal gehört nicht zu diesem Sub-Account');
        if (video ? !c.video : !c.supported) throw bad(`${c.label}: bitte direkt in Postiz posten`);
        if (c.disabled) throw bad(`${c.name} ist in Postiz deaktiviert`);
        if (c.limit && content.length > c.limit) throw bad(`Zu lang für ${c.label}: ${content.length} von max. ${c.limit} Zeichen`);
        const long = thread.findIndex((t) => c.limit && t.length > c.limit);
        if (long >= 0) throw bad(`Teil ${long + 2} ist zu lang für ${c.label} (max. ${c.limit} Zeichen)`);
        return c;
      });
      let date = new Date().toISOString();
      if (type === 'schedule') {
        const d = new Date(String(input.date ?? ''));
        if (Number.isNaN(d.getTime())) throw bad('Zeitpunkt fehlt');
        if (d.getTime() < Date.now() + 60_000) throw bad('Der Zeitpunkt liegt in der Vergangenheit');
        date = d.toISOString();
      } else if (type === 'draft' && input.date) {
        const d = new Date(String(input.date));
        if (!Number.isNaN(d.getTime())) date = d.toISOString();
      }
      // Images: only this sub-account's own uploads, handed to Postiz by URL.
      const uploads = (input.uploadIds ?? []).slice(0, 4).map((u) => {
        const row = db.get(`SELECT * FROM uploads WHERE id = ? AND location_id = ? AND mime LIKE 'image/%'`, String(u), locationId);
        if (!row) throw bad('Bild nicht gefunden');
        return `${app.baseUrl()}/uploads/${row.file}`;
      });
      if (input.mediaUrls?.length) uploads.push(...input.mediaUrls.slice(0, 4));
      for (const c of chosen) if (PROVIDERS[c.identifier]?.needsImage && !uploads.length) throw bad(`${c.label} braucht ein Bild`);
      const title = String(input.title ?? '').trim().slice(0, 100) || content.slice(0, 100);
      const media: { id: string; path: string }[] = [];
      for (const url of uploads) {
        const m = await postiz<any>(cfg, 'POST', '/upload-from-url', { url });
        media.push({ id: m.id, path: m.path });
      }
      const res = await postiz<any[]>(cfg, 'POST', '/posts', {
        type,
        date,
        shortLink: false,
        tags: [],
        posts: chosen.map((c) => ({
          integration: { id: c.id },
          value: [{ content, image: media }, ...thread.map((t) => ({ content: t, image: [] }))],
          settings: { __type: c.identifier, ...(PROVIDERS[c.identifier]?.settings ?? { ...VIDEO_PROVIDERS[c.identifier]?.settings, title }) },
        })),
      });
      const row = {
        id: id(),
        location_id: locationId,
        postiz_ids: (Array.isArray(res) ? res : []).map((p) => p.postId).filter(Boolean),
        integration_ids: chosen.map((c) => c.id),
        content: thread.length ? [content, ...thread].join('\n\n') : content,
        type,
        publish_at: date,
        source: input.source ?? 'manuell',
        user_id: input.userId ?? null,
        created_at: now(),
      };
      db.insert('social_posts', row);
      dropCache('posts:');
      return row;
    };
    app.services.socialPost = createPost;

    // Workflow action: e.g. a new 5-star review becomes a post draft.
    app.services.workflowActions = {
      ...(app.services.workflowActions ?? {}),
      social_post: async (run: any, step: any, vars: Record<string, any>) => {
        const r = await createPost(run.location_id, {
          integrationIds: Array.isArray(step.integration_ids) ? step.integration_ids : [],
          content: render(String(step.body ?? ''), vars),
          type: step.mode === 'now' ? 'now' : 'draft',
          source: 'Workflow',
        });
        return r.type === 'now' ? 'veröffentlicht' : 'Entwurf in Postiz';
      },
    };

    // --- agency: connection + which channel belongs to which client -------------------
    router.get('/api/agency/social', 'admin', async () => {
      const row = db.get('SELECT value FROM agency_settings WHERE key = ?', 'postiz');
      const saved = row ? JSON.parse(row.value) : {};
      const cfg = postizConfig(app);
      const out: any = { url: saved.url || process.env.PGHL_POSTIZ_URL || '', key_set: !!cfg, connected: false, channels: [] };
      if (!cfg) return out;
      try {
        const list = await allChannels(true);
        const owners = new Map<string, string[]>();
        for (const r of db.all('SELECT integration_id, location_id FROM social_channels')) owners.set(r.integration_id, [...(owners.get(r.integration_id) ?? []), r.location_id]);
        out.connected = true;
        out.channels = list.map((i) => ({ id: i.id, name: i.name, identifier: i.identifier, picture: i.picture, profile: i.profile, disabled: !!i.disabled, supported: !!PROVIDERS[i.identifier], location_ids: owners.get(i.id) ?? [], location_id: owners.get(i.id)?.[0] ?? null }));
      } catch (e) {
        out.error = (e as Error).message;
      }
      return out;
    });
    router.patch('/api/agency/social', 'admin', async (ctx) => {
      const row = db.get('SELECT value FROM agency_settings WHERE key = ?', 'postiz');
      const cur = row ? JSON.parse(row.value) : {};
      const next = { ...cur };
      if (ctx.body.url !== undefined) {
        const url = postizBase(str(ctx.body.url, 'Adresse', { max: 300 }));
        if (url && !/^https:\/\/[^/\s]+/.test(url)) throw bad('Adresse mit https:// angeben');
        next.url = url;
      }
      if (ctx.body.api_key) next.api_key = str(ctx.body.api_key, 'API-Schlüssel', { max: 300 });
      if (next.url && next.api_key) {
        const ok = await postiz<any>({ url: next.url, api_key: next.api_key }, 'GET', '/is-connected');
        if (!ok?.connected) throw bad('Postiz meldet: Schlüssel nicht verbunden');
      }
      db.run('INSERT INTO agency_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'postiz', JSON.stringify(next));
      cache.clear();
      return { ok: true, url: next.url ?? '', key_set: !!(next.url && next.api_key) };
    });
    router.put('/api/agency/social/channels/:id', 'admin', (ctx) => {
      // location_ids replaces the whole list; location_id (single) stays supported.
      const ids: string[] = Array.isArray(ctx.body.location_ids) ? ctx.body.location_ids.map(String) : ctx.body.location_id ? [String(ctx.body.location_id)] : [];
      for (const l of ids) if (!app.location(l)) throw notFound('Sub-Account nicht gefunden');
      db.run('DELETE FROM social_channels WHERE integration_id = ?', ctx.params.id);
      for (const l of new Set(ids)) db.run('INSERT INTO social_channels (integration_id, location_id, assigned_at) VALUES (?, ?, ?)', ctx.params.id, l, now());
      return { ok: true, location_ids: [...new Set(ids)] };
    });

    // --- the planner of one sub-account ------------------------------------------------
    router.get('/api/social', 'location', async (ctx) => {
      const cfg = postizConfig(app);
      if (!cfg) return { configured: false, channels: [], providers: PROVIDERS, connectable: CONNECTABLE };
      return {
        configured: true,
        channels: await channelsOf(ctx.locationId, ctx.query.get('refresh') === '1'),
        providers: PROVIDERS,
        connectable: CONNECTABLE,
        // The Postiz address only for the agency (clients see the white-labelled planner).
        postiz_url: ctx.user?.role === 'admin' ? postizBase(cfg.url) : undefined,
      };
    });
    router.get('/api/social/posts', 'location', async (ctx) => {
      const from = new Date(ctx.query.get('from') || Date.now() - 7 * 864e5);
      const to = new Date(ctx.query.get('to') || Date.now() + 35 * 864e5);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) throw bad('Zeitraum ungültig');
      if (to.getTime() - from.getTime() > 93 * 864e5) throw bad('Höchstens drei Monate auf einmal');
      const mine = new Set((await channelsOf(ctx.locationId)).map((c) => c.id));
      const posts = await postsBetween(from.toISOString(), to.toISOString(), ctx.query.get('refresh') === '1');
      return posts
        .filter((p) => mine.has(p.integration?.id))
        .map((p) => ({ id: p.id, content: p.content, publishDate: p.publishDate, state: p.state, releaseURL: p.releaseURL, group: p.group, integration: p.integration }))
        .sort((a, b) => String(a.publishDate).localeCompare(String(b.publishDate)));
    });
    router.post('/api/social/posts', 'location', async (ctx) =>
      createPost(ctx.locationId, {
        integrationIds: Array.isArray(ctx.body.integration_ids) ? ctx.body.integration_ids : [],
        content: str(ctx.body.content, 'Text', { required: true, max: 63_000 }),
        type: String(ctx.body.type ?? 'schedule'),
        date: ctx.body.date,
        uploadIds: Array.isArray(ctx.body.upload_ids) ? ctx.body.upload_ids : [],
        userId: ctx.user?.id,
      }),
    );
    router.delete('/api/social/posts/:id', 'location', async (ctx) => {
      const cfg = cfgOrFail();
      const at = new Date(ctx.query.get('date') || '');
      if (Number.isNaN(at.getTime())) throw bad('Datum des Posts fehlt');
      const mine = new Set((await channelsOf(ctx.locationId)).map((c) => c.id));
      const posts = await postsBetween(new Date(at.getTime() - 2 * 864e5).toISOString(), new Date(at.getTime() + 2 * 864e5).toISOString(), true);
      const p = posts.find((x) => x.id === ctx.params.id);
      if (!p || !mine.has(p.integration?.id)) throw notFound('Post nicht gefunden');
      if (p.state === 'PUBLISHED') throw bad('Schon veröffentlicht – bitte direkt auf der Plattform löschen');
      await postiz(cfg, 'DELETE', `/posts/${encodeURIComponent(p.id)}`);
      dropCache('posts:');
      return { ok: true };
    });
    router.get('/api/social/analytics/:integration', 'location', async (ctx) => {
      const cfg = cfgOrFail();
      if (!(await channelsOf(ctx.locationId)).some((c) => c.id === ctx.params.integration)) throw notFound('Kanal nicht gefunden');
      const days = [7, 30, 90].includes(Number(ctx.query.get('days'))) ? Number(ctx.query.get('days')) : 30;
      return cached(`analytics:${ctx.params.integration}:${days}`, TTL.analytics, () => postiz(cfg, 'GET', `/analytics/${encodeURIComponent(ctx.params.integration)}?date=${days}`));
    });
    // Connect a new channel: Postiz hands out the platform's login link; the new channel is then
    // assigned to this sub-account automatically (see allChannels).
    router.post('/api/social/connect/:provider', 'location', async (ctx) => {
      const cfg = cfgOrFail();
      if (!CONNECTABLE.includes(ctx.params.provider)) throw bad('Diese Plattform lässt sich hier nicht verbinden');
      const known = (await allChannels(true)).map((i) => i.id);
      const r = await postiz<any>(cfg, 'GET', `/social/${encodeURIComponent(ctx.params.provider)}`);
      if (!r?.url) throw new HttpError(502, 'Postiz hat keinen Login-Link geliefert');
      db.insert('social_connects', { id: id(), location_id: ctx.locationId, provider: ctx.params.provider, known, created_at: now() });
      return { url: r.url };
    });
  },
};
