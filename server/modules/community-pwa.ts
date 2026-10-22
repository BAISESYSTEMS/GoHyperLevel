import type { Module } from '../core/app.js';
import { HttpError, html, text, type RawResult } from '../core/http.js';
import { portalUrl } from '../services/courses.js';
import { getGroup } from '../services/community.js';
import { pushPrefs } from '../services/community-ext.js';
import { ICON_KINDS, iconPng, type IconKind } from '../services/community-icons.js';
import { OFFLINE_PATH, PWA_JS, headOf, manifestOf, offlineHtml, swJs } from '../services/community-pwa.js';
import { communityUi, kitOf, type PortalCtx } from '../services/community-ui.js';

/**
 * The member app: manifest, icons and service worker of every member area (client name, colour and logo), the offline page, the
 * script for the install banner and push, subscribing devices, and push messages for direct messages, mentions, replies,
 * announcements and (if wanted) every new post. Rules for the files: services/community-pwa.ts, icons: services/community-icons.ts.
 */

const CSS = `<style>
.cm-install{position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:60;max-width:520px;margin:0 auto;display:flex;gap:12px;align-items:center;background:var(--panel,#fff);color:var(--text,#111);border:1px solid var(--line,#e5e7eb);border-radius:16px;padding:12px 12px 12px 16px;box-shadow:0 12px 40px rgba(0,0,0,.22)}
.cm-install .ic{font-size:26px}.cm-install .tx{flex:1;min-width:0;font-size:14.5px;line-height:1.35}.cm-install .tx span{color:var(--muted,#64748b)}
.cm-install .go{min-height:44px;padding:0 18px;border-radius:12px;border:0;background:var(--brand,#2563eb);color:#fff;font:inherit;font-weight:700;cursor:pointer}
.cm-install .x{min-height:44px;min-width:44px;border:0;background:none;color:var(--muted,#64748b);font-size:18px;cursor:pointer;border-radius:12px}
.cm-install .go:hover,.cm-install .x:hover{filter:brightness(1.08)}.cm-install button:focus-visible{outline:3px solid var(--brand,#2563eb);outline-offset:2px}
@media (display-mode: standalone){.cm-install{display:none}}
@media (max-width:560px){.hd-link span{display:none}.hd-link{min-width:44px;min-height:44px;display:inline-flex;align-items:center;justify-content:center}}
</style>`;

const PUSH_KIND: Record<string, 'mentions' | 'replies' | 'announcements'> = { mention: 'mentions', comment: 'replies', reply: 'replies', announcement: 'announcements', event: 'announcements', challenge: 'announcements' };

export const communityPwaModule: Module = {
  name: 'community-pwa',
  register(app) {
    const { db, router } = app;
    const ui = communityUi(app);
    const raw = () => app.services.contactPushRaw as { publicKey: string; send(loc: string, cid: string, p: { title: string; body: string; url?: string; tag?: string }): Promise<number>; devices(loc: string, cid: string): number; subscribe(loc: string, cid: string, s: unknown, ua?: string): void; unsubscribe(loc: string, cid: string, endpoint: string): boolean } | undefined;
    const pwa = (p: PortalCtx) => ({ base: p.base as string, name: String(p.name ?? p.title ?? ''), color: String(p.color ?? '') });

    ui.scripts.push('/portal-pwa.js');
    ui.head.push((p) => `${headOf(pwa(p), raw()?.publicKey)}${CSS}`);

    // --- files of the app -----------------------------------------------------------------------------------------------------------------
    const portalOf = (key: string): PortalCtx => {
      const p = kitOf(app).portal.resolve(key);
      if (!p) throw new HttpError(404, 'Diesen Mitgliederbereich gibt es nicht');
      return p;
    };
    router.get('/portal/:p/manifest.webmanifest', 'public', (ctx) => {
      const p = portalOf(ctx.params.p);
      const manifest = manifestOf(pwa(p));
      // The member app is more than the community when the sub-account has courses (modules/course-pwa.ts): app.services.memberAppManifest = [(manifest, portal) => void].
      for (const fn of (app.services.memberAppManifest ?? []) as ((m: ReturnType<typeof manifestOf>, p: PortalCtx) => void)[]) fn(manifest, p);
      const r = text(JSON.stringify(manifest), 'application/manifest+json; charset=utf-8');
      r.headers['cache-control'] = 'no-cache';
      return r;
    });
    router.get('/portal/:p/community-sw.js', 'public', (ctx) => {
      const p = portalOf(ctx.params.p);
      const r = text(swJs(pwa(p)), 'text/javascript; charset=utf-8');
      r.headers['cache-control'] = 'no-cache';
      r.headers['service-worker-allowed'] = `${p.base}/`;
      return r;
    });
    router.get('/portal/:p/icon/:file', 'public', (ctx): RawResult => {
      const p = portalOf(ctx.params.p);
      const kind = String(ctx.params.file).replace(/\.png$/, '') as IconKind;
      if (!(kind in ICON_KINDS)) throw new HttpError(404, 'Symbol nicht gefunden');
      return { __raw: true, status: 200, headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' }, body: iconPng({ name: pwa(p).name, color: pwa(p).color, logo: String(p.logo ?? '') }, kind) };
    });
    router.get(`/portal/:p/${OFFLINE_PATH}`, 'public', (ctx) => {
      const r = html(offlineHtml(pwa(portalOf(ctx.params.p))));
      r.headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
      r.headers['cache-control'] = 'no-cache';
      return r;
    });
    router.get('/portal-pwa.js', 'public', () => {
      const r = text(PWA_JS, 'text/javascript; charset=utf-8');
      r.headers['cache-control'] = 'public, max-age=3600';
      return r;
    });

    // --- devices ----------------------------------------------------------------------------------------------------------------------------
    /** A member's device: logged in, same origin and the app's own header (a cross-site page can't send it without our consent). */
    const withDevice = (ctx: any, fn: (p: PortalCtx, contactId: string, k: NonNullable<ReturnType<typeof raw>>) => unknown) => {
      const kit = kitOf(app);
      const p = kit.portal.resolve(ctx.params.p);
      const m = p && kit.portal.memberOf(ctx, p);
      const k = raw();
      if (!p || !m) throw new HttpError(401, 'Bitte neu anmelden');
      if (!k) throw new HttpError(503, 'Benachrichtigungen sind auf diesem Server nicht eingerichtet');
      if (ctx.req.headers['x-community-pwa'] !== '1' || (ctx.req.headers['sec-fetch-site'] && ctx.req.headers['sec-fetch-site'] !== 'same-origin')) throw new HttpError(403, 'Anfrage abgelehnt');
      return fn(p, m.contact.id, k);
    };
    router.post('/portal/:p/community/push', 'public', (ctx) =>
      withDevice(ctx, (p, cid, k) => {
        k.subscribe(p.locationId, cid, ctx.body?.subscription, String(ctx.req.headers['user-agent'] ?? ''));
        return { ok: true, devices: k.devices(p.locationId, cid) };
      }),
    );
    router.post('/portal/:p/community/push/unsubscribe', 'public', (ctx) =>
      withDevice(ctx, (p, cid, k) => ({ ok: true, removed: k.unsubscribe(p.locationId, cid, String(ctx.body?.endpoint ?? '')), devices: k.devices(p.locationId, cid) })),
    );

    // --- messages to devices ----------------------------------------------------------------------------------------------------------------
    const pending = new Set<Promise<unknown>>();
    app.services.communityPush = { flush: async () => void (await Promise.all([...pending])) };
    const fire = (loc: string, cid: string, title: string, body: string, url: string, tag: string) => {
      const k = raw();
      if (!k || !k.devices(loc, cid)) return;
      const job = k.send(loc, cid, { title, body, url, tag }).catch((e) => console.error('[community] push', (e as Error).message));
      pending.add(job);
      void job.finally(() => pending.delete(job));
    };
    const absPortal = (loc: string) => portalUrl(app, loc);

    /** Where a push leads: the hooks of the modules (DM thread, challenge …), else the post, else the group. */
    const urlOf = (g: any, cid: string, n: { kind: string; postId?: string; commentId?: string }) => {
      const base = absPortal(g.location_id);
      const row = { id: '', kind: n.kind, post_id: n.postId ?? null, comment_id: n.commentId ?? null, group_id: g.id, contact_id: cid, location_id: g.location_id };
      const hooked = ui.notificationTarget.map((fn) => fn({ locationId: g.location_id, base, loc: {} } as PortalCtx, row)).find(Boolean);
      if (hooked) return hooked;
      const gHref = `${base}/community/g/${encodeURIComponent(g.slug)}`;
      return n.postId ? `${gHref}/p/${encodeURIComponent(n.postId)}${n.commentId ? `#c-${encodeURIComponent(n.commentId)}` : ''}` : gHref;
    };

    ui.notified.push((g, ids, n) => {
      const pref = PUSH_KIND[n.kind];
      if (!pref || n.quiet) return; // likes, levels, badges and DMs (own path) do not push
      for (const cid of ids) {
        if (!pushPrefs(app, g.location_id, cid)[pref]) continue;
        fire(g.location_id, cid, n.actor ? `${n.actor} · ${g.name}` : g.name, n.text, urlOf(g, cid, n), `n-${g.id}-${n.kind}`);
      }
    });

    // Direct messages: every message pushes (a thread's bell entry only exists once), at most one push per thread every 20 seconds.
    const lastDm = new Map<string, number>();
    app.events.on('community.dm_received', (e) => {
      const d = e.data;
      if (d.toTeam || !d.contactId) return;
      const key = `${d.contactId}:${d.threadId}`;
      if (Date.now() - (lastDm.get(key) ?? 0) < 20_000) return;
      lastDm.set(key, Date.now());
      if (lastDm.size > 5000) lastDm.clear();
      if (!pushPrefs(app, e.locationId, d.contactId).dms) return;
      const g = db.get<any>(`SELECT g.* FROM community_groups g JOIN community_members m ON m.group_id = g.id AND m.contact_id = ? AND m.banned_at IS NULL WHERE g.location_id = ? AND g.status = 'active' ORDER BY g.position LIMIT 1`, d.contactId, e.locationId);
      if (!g) return;
      fire(e.locationId, d.contactId, String(d.from?.name ?? 'Neue Nachricht'), String(d.message?.text ?? ''), urlOf(g, d.contactId, { kind: 'dm', postId: d.threadId }), `dm-${d.threadId}`);
    });

    // New posts for members who asked for all of them (off by default).
    app.events.on('community.post_created', (e) => {
      const g = e.data.groupId ? getGroup(app, e.locationId, String(e.data.groupId)) : undefined;
      if (!g || !raw()) return;
      const closed = (cid: string) => ui.closedChannels.some((fn) => fn(g as any, cid, null).has(String(e.data.channelId)));
      const by = e.data.contactId ? db.get<{ display_name: string }>('SELECT display_name FROM community_profiles WHERE location_id = ? AND contact_id = ?', e.locationId, String(e.data.contactId))?.display_name : undefined;
      for (const m of db.all<{ contact_id: string }>('SELECT m.contact_id FROM community_members m JOIN community_push_prefs p ON p.location_id = m.location_id AND p.contact_id = m.contact_id AND p.posts = 1 WHERE m.group_id = ? AND m.banned_at IS NULL', g.id)) {
        if (m.contact_id === e.data.contactId || closed(m.contact_id)) continue;
        fire(e.locationId, m.contact_id, g.name, `${by ?? 'Team'}: ${String(e.data.post?.title ?? 'Neuer Beitrag')}`.slice(0, 200), urlOf(g, m.contact_id, { kind: 'post', postId: String(e.data.postId) }), `post-${e.data.postId}`);
      }
    });
  },
};
