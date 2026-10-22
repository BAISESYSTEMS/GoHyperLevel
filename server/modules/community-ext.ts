import type { App, Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { now } from '../core/util.js';
import { getContact } from '../services/contacts.js';
import { getGroup } from '../services/community.js';
import { cleanExt, extOf, saveExt, staffOf, type Role } from '../services/community-ext.js';

/**
 * Settings of the community extensions per group (messages, directory, map, points for courses and events, monthly leaderboard,
 * welcome automation, live calls, affiliate programme) and the roles of members: admins and moderators.
 * Tables here (settings, roles, profile extras, presence, active days, push preferences) are shared by the other community-*.ts modules.
 */

export const communityExtModule: Module = {
  name: 'community-ext',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE community_ext (
        group_id TEXT PRIMARY KEY REFERENCES community_groups(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        settings TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
      );
      CREATE TABLE community_roles (
        group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        role TEXT NOT NULL, granted_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
        PRIMARY KEY (group_id, contact_id)
      );
      CREATE TABLE community_profile_ext (
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        headline TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '', links TEXT NOT NULL DEFAULT '[]',
        show_on_map INTEGER NOT NULL DEFAULT 0, show_online INTEGER NOT NULL DEFAULT 1, show_activity INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (location_id, contact_id)
      );
      CREATE TABLE community_presence (
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        last_seen_at TEXT NOT NULL, PRIMARY KEY (location_id, contact_id)
      );
      CREATE TABLE community_active_days (
        group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        day TEXT NOT NULL, PRIMARY KEY (group_id, contact_id, day)
      );
      CREATE INDEX community_active_days_day ON community_active_days(group_id, day);
      CREATE TABLE community_push_prefs (
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        dms INTEGER NOT NULL DEFAULT 1, mentions INTEGER NOT NULL DEFAULT 1, replies INTEGER NOT NULL DEFAULT 1,
        posts INTEGER NOT NULL DEFAULT 0, announcements INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (location_id, contact_id)
      );
      `,
    ],
  ],
  register(app) {
    const { router } = app;
    const mustGroup = (ctx: Ctx) => {
      const g = getGroup(app, ctx.locationId, ctx.params.id);
      if (!g) throw notFound('Gruppe nicht gefunden');
      return g;
    };

    router.get('/api/community/groups/:id/ext', 'location', (ctx) => extOf(app, mustGroup(ctx).id));
    router.put('/api/community/groups/:id/ext', 'location', (ctx) => {
      const g = mustGroup(ctx) as { id: string; location_id: string };
      const next = cleanExt(ctx.body, extOf(app, g.id));
      // Referenced rows must belong to this group / sub-account.
      const w = next.welcome.post;
      if (w.channel_id && !app.db.get('SELECT id FROM community_channels WHERE id = ? AND group_id = ?', w.channel_id, g.id)) throw bad('Kanal für den Willkommens-Beitrag nicht gefunden');
      if (next.start_here.post_id && !app.db.get('SELECT id FROM community_posts WHERE id = ? AND group_id = ?', next.start_here.post_id, g.id)) throw bad('Beitrag für „Hier starten“ nicht gefunden');
      if (next.affiliate.program_id && !app.db.get('SELECT id FROM affiliate_programs WHERE id = ? AND location_id = ?', next.affiliate.program_id, ctx.locationId)) throw bad('Partnerprogramm nicht gefunden');
      saveExt(app, g, next);
      return next;
    });

    // --- admins and moderators among the members ---------------------------------------------------------------------
    const staffOut = (groupId: string, locationId: string) =>
      staffOf(app, groupId).map((r) => {
        const c = getContact(app, locationId, r.contact_id);
        const pr = app.db.get<{ display_name: string; handle: string }>('SELECT display_name, handle FROM community_profiles WHERE location_id = ? AND contact_id = ?', locationId, r.contact_id);
        return { ...r, name: pr?.display_name || [c?.first_name, c?.last_name].filter(Boolean).join(' ') || c?.email || '', handle: pr?.handle ?? '', email: c?.email ?? '' };
      });
    router.get('/api/community/groups/:id/staff', 'location', (ctx) => staffOut(mustGroup(ctx).id, ctx.locationId));
    router.post('/api/community/groups/:id/staff', 'location', (ctx) => {
      const g = mustGroup(ctx);
      const role = String(ctx.body?.role ?? '') as Role;
      if (role !== 'admin' && role !== 'moderator') throw bad('Rolle: admin oder moderator');
      const contactId = str(ctx.body?.contact_id, 'Kontakt', { required: true });
      if (!getContact(app, ctx.locationId, contactId)) throw notFound('Kontakt nicht gefunden');
      if (!app.db.get('SELECT 1 FROM community_members WHERE group_id = ? AND contact_id = ? AND banned_at IS NULL', g.id, contactId)) throw new HttpError(400, 'Nur Mitglieder der Gruppe können Admin oder Moderator werden');
      app.db.run(
        'INSERT INTO community_roles (group_id, contact_id, location_id, role, granted_by, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(group_id, contact_id) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by',
        g.id,
        contactId,
        ctx.locationId,
        role,
        ctx.user?.name ?? ctx.via ?? '',
        now(),
      );
      return staffOut(g.id, ctx.locationId);
    });
    router.delete('/api/community/groups/:id/staff/:contactId', 'location', (ctx) => {
      const g = mustGroup(ctx);
      app.db.run('DELETE FROM community_roles WHERE group_id = ? AND contact_id = ?', g.id, ctx.params.contactId);
      return staffOut(g.id, ctx.locationId);
    });
  },
};

export type { App };
