import type { Module } from '../core/app.js';
import { bad, notFound, type RawResult } from '../core/http.js';
import { getGroup } from '../services/community.js';
import { MAX_POST_BYTES, MAX_POST_FILES, MAX_ROWS, exportMembersCsv, exportPostsJson, planMembers, planPosts, runMembers, runPosts, type MemberInput } from '../services/community-import.js';

/**
 * Moving in and out: CSV import of members (dry run first), Markdown posts, and exports of members (CSV) and posts (JSON).
 * Rules and column names: services/community-import.ts, the Skool route: docs/community.md.
 */

export const communityImportModule: Module = {
  name: 'community-import',
  register(app) {
    const { router } = app;
    const mustGroup = (loc: string, gid: string) => {
      const g = getGroup(app, loc, gid);
      if (!g) throw notFound('Gruppe nicht gefunden');
      return g as unknown as { id: string; location_id: string; name: string; slug: string; [k: string]: any };
    };
    const input = (b: any): MemberInput => ({ csv: b?.csv, mapping: b?.mapping && typeof b.mapping === 'object' ? b.mapping : undefined, date_order: b?.date_order, tier_id: b?.tier_id ? String(b.tier_id) : undefined, tier_map: b?.tier_map && typeof b.tier_map === 'object' ? b.tier_map : undefined });

    router.post('/api/community/groups/:id/import/members/preview', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      const plan = planMembers(app, g, input(ctx.body));
      // The first 300 rows (every problem first) are enough to check the mapping by eye.
      const shown = [...plan.items.filter((i) => i.state === 'invalid' || i.state === 'duplicate' || i.reason), ...plan.items.filter((i) => i.state !== 'invalid' && i.state !== 'duplicate' && !i.reason)].slice(0, 300);
      return { ...plan, items: shown.sort((a, b) => a.line - b.line), truncated: plan.items.length > shown.length, limit: MAX_ROWS };
    });
    router.post('/api/community/groups/:id/import/members', 'location', async (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      const b = ctx.body ?? {};
      if (b.confirm_rights !== true) throw bad('Bitte bestätige, dass du die Personen aus der Liste kontaktieren und speichern darfst (z. B. weil sie deiner Community selbst beigetreten sind)');
      const plan = planMembers(app, g, input(b));
      if (!plan.counts.new && !plan.counts.contact_exists) throw bad('Es gibt nichts zu importieren – alle Zeilen sind ungültig, doppelt oder schon Mitglied');
      const res = await runMembers(app, g, plan, { trigger_workflows: !!b.trigger_workflows, send_mail: !!b.send_mail, grant_tier_access: b.grant_tier_access !== false, import_points: !!b.import_points, by: ctx.user?.name ?? 'Import' });
      return { ...res, counts: plan.counts };
    });

    router.post('/api/community/groups/:id/import/posts/preview', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      const items = planPosts(app, g, { files: ctx.body?.files, channel_id: ctx.body?.channel_id ? String(ctx.body.channel_id) : undefined, keep_dates: ctx.body?.keep_dates !== false });
      return { total: items.length, ok: items.filter((i) => !i.problem).length, items: items.slice(0, 200).map((i) => ({ ...i, body: i.body.slice(0, 200) })), limit: { files: MAX_POST_FILES, bytes: MAX_POST_BYTES } };
    });
    router.post('/api/community/groups/:id/import/posts', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      const items = planPosts(app, g, { files: ctx.body?.files, channel_id: ctx.body?.channel_id ? String(ctx.body.channel_id) : undefined, keep_dates: ctx.body?.keep_dates !== false });
      return runPosts(app, g, items);
    });

    router.get('/api/community/groups/:id/export/members.csv', 'location', (ctx): RawResult => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      return { __raw: true, status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${g.slug}-mitglieder.csv"`, 'cache-control': 'no-store' }, body: exportMembersCsv(app, g) };
    });
    router.get('/api/community/groups/:id/export/posts.json', 'location', (ctx): RawResult => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      return { __raw: true, status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${g.slug}-beitraege.json"`, 'cache-control': 'no-store' }, body: JSON.stringify(exportPostsJson(app, g), null, 2) };
    });
  },
};
