import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { areaAllowed } from '../services/canvas-cards.js';
import { callRoute, visibleLocations, type Loc } from '../services/mobile.js';

/**
 * The community on the phone (Android app, /api/mobile/community/*): what needs the team's attention (join requests, reported
 * posts and messages, messages from members), approving or rejecting a request, settling a report, answering a member and posting
 * as the team. Writes relay onto the regular /api/community routes, so rights, validation, events and the audit log are the same
 * as in the web app. Contract: docs/api.md → "Mobile-App".
 */

export const communityMobileModule: Module = {
  name: 'community-mobile',
  register(app) {
    const { db, router } = app;
    const inLoc = (ctx: Ctx, locationId: string): Ctx => ({ ...ctx, locationId });
    const ok = (ctx: Ctx, loc: string) => areaAllowed(app, inLoc(ctx, loc), '/api/community');

    /** Sub-accounts to read: ?location=all (default) or one the person may open. */
    const scope = (ctx: Ctx): Loc[] => {
      const want = String(ctx.query.get('location') ?? '').trim() || 'all';
      const visible = visibleLocations(app, ctx);
      if (want !== 'all') {
        const l = visible.find((x) => x.id === want);
        if (!l) {
          if (!db.get('SELECT id FROM locations WHERE id = ?', want)) throw notFound('Sub-Account nicht gefunden');
          throw new HttpError(403, 'Kein Zugriff auf diesen Sub-Account');
        }
        if (!ok(ctx, l.id)) throw new HttpError(403, 'Dieser Bereich ist für dich oder deinen Tarif nicht freigeschaltet');
        return [l];
      }
      return visible.filter((l) => ok(ctx, l.id));
    };
    /** The sub-account of a record, if the person may use the community there (never a hint that it exists elsewhere). */
    const ownLoc = (ctx: Ctx, table: string, id: string, what: string): Loc => {
      const row = db.get<{ location_id: string }>(`SELECT location_id FROM ${table} WHERE id = ?`, id);
      const loc = row && visibleLocations(app, ctx).find((l) => l.id === row.location_id && ok(ctx, l.id));
      if (!loc) throw notFound(what);
      return loc;
    };
    const relay = (ctx: Ctx) => {
      ctx.skipAfterWrite = true;
    };
    const limit = (ctx: Ctx, def = 30) => Math.min(Math.max(Math.round(Number(ctx.query.get('limit')) || def), 1), 100);

    // --- overview ---------------------------------------------------------------------------------------------------------------
    router.get('/api/mobile/community', 'user', (ctx) => {
      const locations = scope(ctx).map((l) => {
        const groups = db.all<any>(`SELECT id, name, slug, status FROM community_groups WHERE location_id = ? ORDER BY position, created_at`, l.id).map((g) => ({
          id: g.id,
          name: g.name,
          slug: g.slug,
          status: g.status,
          members: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM community_members WHERE group_id = ? AND banned_at IS NULL', g.id)!.n,
          pending_requests: db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM community_memberships WHERE group_id = ? AND status = 'pending'`, g.id)!.n,
          open_reports: db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM community_reports WHERE group_id = ? AND status = 'open'`, g.id)!.n,
        }));
        const dmReports = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM community_dm_reports WHERE location_id = ? AND status = 'open'`, l.id)!.n;
        const unread = db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM community_dm_messages m JOIN community_dm_threads t ON t.id = m.thread_id
           WHERE t.location_id = ? AND (t.contact_a = '_team' OR t.contact_b = '_team') AND m.sender_id != '_team' AND m.status = 'visible'
             AND m.created_at > COALESCE((SELECT last_read_at FROM community_dm_reads r WHERE r.thread_id = t.id AND r.contact_id = '_team'), '')`,
          l.id,
        )!.n;
        return { location_id: l.id, name: l.name, groups, open_dm_reports: dmReports, unread_team_messages: unread };
      });
      const sum = (f: (l: (typeof locations)[number]) => number) => locations.reduce((a, l) => a + f(l), 0);
      return {
        locations,
        totals: {
          pending_requests: sum((l) => l.groups.reduce((a, g) => a + g.pending_requests, 0)),
          open_reports: sum((l) => l.groups.reduce((a, g) => a + g.open_reports, 0) + l.open_dm_reports),
          unread_team_messages: sum((l) => l.unread_team_messages),
        },
      };
    });

    // --- join requests -----------------------------------------------------------------------------------------------------------
    router.get('/api/mobile/community/requests', 'user', async (ctx) => {
      const out: any[] = [];
      for (const l of scope(ctx)) {
        const rows: any[] = await callRoute(app, ctx, 'GET', `/api/community/requests?limit=${limit(ctx)}`, { locationId: l.id });
        for (const r of rows) out.push({ id: r.id, location_id: l.id, location_name: l.name, group_id: r.group_id, group_name: r.group_name, contact_id: r.contact_id, name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email, email: r.email, tier: r.tier_name ?? r.tier?.name ?? null, requested_at: r.requested_at, answers: r.answers ?? [] });
      }
      return out.sort((a, b) => String(a.requested_at).localeCompare(String(b.requested_at))).slice(0, limit(ctx));
    });
    router.post('/api/mobile/community/requests/:id', 'user', async (ctx) => {
      relay(ctx);
      const loc = ownLoc(ctx, 'community_memberships', ctx.params.id, 'Anfrage nicht gefunden');
      const action = String(ctx.body?.action ?? '');
      if (!['approve', 'reject'].includes(action)) throw bad('Aktion: approve oder reject');
      await callRoute(app, ctx, 'PATCH', `/api/community/memberships/${encodeURIComponent(ctx.params.id)}`, { locationId: loc.id, body: { action, note: ctx.body?.note ? str(ctx.body.note, 'Hinweis', { max: 300 }) : undefined } });
      return { ok: true };
    });

    // --- reports ---------------------------------------------------------------------------------------------------------------------
    router.get('/api/mobile/community/reports', 'user', async (ctx) => {
      const out: any[] = [];
      for (const l of scope(ctx)) {
        const rows: any[] = await callRoute(app, ctx, 'GET', '/api/community/reports?status=open', { locationId: l.id });
        for (const r of rows) out.push({ id: r.id, kind: r.kind, location_id: l.id, location_name: l.name, group_id: r.group_id, group_name: r.group_name, reason: r.reason, created_at: r.created_at, text: String(r.target?.title ? `${r.target.title}: ${r.target.body}` : r.target?.body ?? '').slice(0, 300), author: r.target?.author_name ?? '' });
        const dm: any[] = await callRoute(app, ctx, 'GET', '/api/community/dm-reports', { locationId: l.id });
        for (const r of dm) out.push({ id: r.id, kind: 'dm', location_id: l.id, location_name: l.name, group_id: null, group_name: '', reason: r.reason, created_at: r.created_at, text: String(r.message?.text ?? '').slice(0, 300), author: r.sender?.name ?? '' });
      }
      return out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, limit(ctx, 50));
    });
    router.post('/api/mobile/community/reports/:id', 'user', async (ctx) => {
      relay(ctx);
      const dm = ctx.query.get('kind') === 'dm';
      const loc = ownLoc(ctx, dm ? 'community_dm_reports' : 'community_reports', ctx.params.id, 'Meldung nicht gefunden');
      const action = String(ctx.body?.action ?? '');
      if (!(dm ? ['dismiss', 'remove', 'ban'] : ['dismiss', 'hide', 'delete']).includes(action)) throw bad(dm ? 'Aktion: dismiss, remove oder ban' : 'Aktion: dismiss, hide oder delete');
      await callRoute(app, ctx, 'PATCH', `/api/community/${dm ? 'dm-reports' : 'reports'}/${encodeURIComponent(ctx.params.id)}`, { locationId: loc.id, body: { action } });
      return { ok: true };
    });

    // --- messages with the team ---------------------------------------------------------------------------------------------------------
    router.get('/api/mobile/community/messages', 'user', async (ctx) => {
      const out: any[] = [];
      for (const l of scope(ctx)) {
        const rows: any[] = await callRoute(app, ctx, 'GET', '/api/community/messages', { locationId: l.id });
        for (const r of rows) out.push({ ...r, location_id: l.id, location_name: l.name });
      }
      return out.sort((a, b) => String(b.last_message_at).localeCompare(String(a.last_message_at))).slice(0, limit(ctx, 50));
    });
    router.get('/api/mobile/community/messages/:contactId', 'user', async (ctx) => {
      const loc = ownLoc(ctx, 'contacts', ctx.params.contactId, 'Kontakt nicht gefunden');
      return callRoute(app, ctx, 'GET', `/api/community/messages/${encodeURIComponent(ctx.params.contactId)}`, { locationId: loc.id });
    });
    router.post('/api/mobile/community/messages/:contactId', 'user', async (ctx) => {
      relay(ctx);
      const loc = ownLoc(ctx, 'contacts', ctx.params.contactId, 'Kontakt nicht gefunden');
      return callRoute(app, ctx, 'POST', `/api/community/messages/${encodeURIComponent(ctx.params.contactId)}`, { locationId: loc.id, body: { body: ctx.body?.body, from_name: ctx.body?.from_name } });
    });

    // --- post as the team ---------------------------------------------------------------------------------------------------------------------
    router.post('/api/mobile/community/posts', 'user', async (ctx) => {
      relay(ctx);
      const loc = ownLoc(ctx, 'community_groups', String(ctx.body?.group_id ?? ''), 'Gruppe nicht gefunden');
      const p = await callRoute(app, ctx, 'POST', `/api/community/groups/${encodeURIComponent(String(ctx.body.group_id))}/posts`, { locationId: loc.id, body: { title: ctx.body?.title, body: ctx.body?.body, channel_id: ctx.body?.channel_id, pinned: !!ctx.body?.pinned, notify: !!ctx.body?.notify } });
      return { id: p.id, title: p.title };
    });
  },
};
