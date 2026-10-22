import type { Module } from '../core/app.js';
import { bad, notFound } from '../core/http.js';
import { escapeHtml } from '../core/template.js';
import { id, now } from '../core/util.js';
import { getGroup, groupSettings, levelFor, memberPoints } from '../services/community.js';
import { award } from '../services/community-actions.js';
import { CAN, extOf } from '../services/community-ext.js';
import {
  PERK_FILE_MAX,
  PERK_KINDS,
  RULE_LABELS,
  archiveMonths,
  archiveOf,
  badgeById,
  badgesOf,
  awardBadge,
  channelRules,
  cleanBadge,
  cleanPerk,
  cleanRule,
  closedByRules,
  earnedBy,
  evaluateBadges,
  perkFileResponse,
  perksOf,
  removePerkFile,
  revokeBadge,
  savePerkFile,
  statOf,
  unlocksAt,
  type Perk,
} from '../services/community-gamify.js';
import { notify } from '../services/community-actions.js';
import { communityUi, kitOf } from '../services/community-ui.js';
import { getContact } from '../services/contacts.js';

/**
 * Badges (by hand or by rule), perks and channels that open with a level, the monthly leaderboard and its archive – the admin API
 * and the member pages ("Vorteile", badges on the profile, "what opens next"). Rules: services/community-gamify.ts.
 */

const CSS = `<style>
.cm-badges{display:flex;gap:8px;flex-wrap:wrap}
.cm-badge{display:inline-flex;align-items:center;gap:6px;background:var(--soft);border:1px solid var(--line);border-radius:99px;padding:4px 12px 4px 5px;font-size:13.5px;font-weight:600;min-height:32px}
.cm-badge i{font-style:normal;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;background:var(--brand);color:#fff;font-size:14px}
.cm-perk{display:flex;gap:14px;align-items:flex-start;padding:14px 0;border-top:1px solid var(--line)}.cm-perk:first-child{border-top:0}
.cm-perk .ic{width:44px;height:44px;border-radius:12px;background:var(--soft);display:grid;place-items:center;font-size:22px;flex:none}
.cm-perk.locked{opacity:.62}.cm-perk .bd{flex:1;min-width:0}
.cm-code{display:inline-block;font:600 17px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--soft);border:1px dashed var(--brand);border-radius:10px;padding:9px 14px;margin:6px 0;user-select:all}
.cm-lvl{margin:0 0 16px}.cm-lvl>h3{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin:0 0 6px}.cm-lvl>h3 small{font-weight:500;color:var(--muted);font-size:13px}
</style>`;

const KIND_ICON: Record<string, string> = { coupon: '🎟️', file: '📥', link: '🔗', text: '📝' };

export const communityGamifyModule: Module = {
  name: 'community-gamify',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE community_badges (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
        name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', emoji TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '',
        rule TEXT NOT NULL DEFAULT '{"type":"manual","value":0}', points INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX community_badges_group ON community_badges(group_id, position);
      CREATE TABLE community_badge_awards (
        badge_id TEXT NOT NULL REFERENCES community_badges(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
        awarded_at TEXT NOT NULL, awarded_by TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (badge_id, contact_id)
      );
      CREATE INDEX community_badge_awards_member ON community_badge_awards(contact_id, group_id);
      CREATE TABLE community_perks (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
        level INTEGER NOT NULL DEFAULT 2, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
        file TEXT NOT NULL DEFAULT '', filename TEXT NOT NULL DEFAULT '', mime TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX community_perks_group ON community_perks(group_id, level);
      CREATE TABLE community_leaderboard_archive (
        group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        month TEXT NOT NULL, rows TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, PRIMARY KEY (group_id, month)
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const ui = communityUi(app);
    ui.head.push(() => CSS);
    const mustGroup = (loc: string, gid: string) => {
      const g = getGroup(app, loc, gid);
      if (!g) throw notFound('Gruppe nicht gefunden');
      return g as unknown as { id: string; location_id: string; name: string; [k: string]: any };
    };
    const badgeOut = (b: any) => ({ ...b, awarded: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM community_badge_awards WHERE badge_id = ?', b.id)!.n });
    const mustBadge = (loc: string, bid: string) => {
      const b = badgeById(app, loc, bid);
      if (!b) throw notFound('Abzeichen nicht gefunden');
      return b;
    };

    // --- points for finished courses --------------------------------------------------------------------------------------------
    app.events.on('course.completed', (e) => {
      const contactId = String(e.data.contactId ?? '');
      const courseId = String(e.data.courseId ?? '');
      if (!contactId || !courseId) return;
      for (const g of db.all<any>(`SELECT g.* FROM community_groups g JOIN community_members m ON m.group_id = g.id AND m.contact_id = ? AND m.banned_at IS NULL WHERE g.location_id = ? AND g.status = 'active'`, contactId, e.locationId)) {
        const pts = extOf(app, g.id).points.course;
        if (pts && !db.get(`SELECT 1 FROM community_points WHERE group_id = ? AND contact_id = ? AND reason = 'course' AND target_id = ?`, g.id, contactId, courseId)) award(app, g, contactId, pts, 'course', courseId);
        evaluateBadges(app, g, contactId);
      }
    });
    // Badges by rule: when something happens that moves a counter.
    const recheck = (e: { locationId: string; data: Record<string, any> }) => {
      const g = e.data.groupId ? getGroup(app, e.locationId, String(e.data.groupId)) : undefined;
      if (g && e.data.contactId) evaluateBadges(app, g, String(e.data.contactId));
    };
    for (const t of ['community.post_created', 'community.level_reached', 'community.challenge_completed', 'community.event_attended']) app.events.on(t, recheck);

    // A level that opens something: the member hears about it.
    app.events.on('community.level_reached', (e) => {
      const g = e.data.groupId ? getGroup(app, e.locationId, String(e.data.groupId)) : undefined;
      if (!g) return;
      const u = unlocksAt(app, g, Number(e.data.level));
      // Courses open with their own message elsewhere; channels and perks are announced here.
      const parts = [...u.channels.map((c) => `Kanal ${c}`), ...u.perks.map((p) => p.title)];
      if (parts.length) notify(app, g, [String(e.data.contactId)], { kind: 'perk', text: `Neu freigeschaltet: ${parts.join(', ')}` });
    });

    // Hourly: the counters that no event moves (comments, likes, days, streaks) and the archive of finished months.
    let last = 0;
    app.onTick(() => {
      if (Date.now() - last < 3_600_000) return;
      last = Date.now();
      archiveMonths(app);
      const since = new Date(Date.now() - 2 * 864e5).toISOString();
      for (const g of db.all<any>(`SELECT DISTINCT g.* FROM community_groups g JOIN community_badges b ON b.group_id = g.id WHERE g.status = 'active' AND b.rule NOT LIKE '%"manual"%'`)) {
        for (const m of db.all<{ contact_id: string }>('SELECT contact_id FROM community_members WHERE group_id = ? AND banned_at IS NULL AND (last_seen_at >= ? OR joined_at >= ?) LIMIT 5000', g.id, since, since)) evaluateBadges(app, g, m.contact_id);
      }
    });

    // --- admin API: badges --------------------------------------------------------------------------------------------------------
    router.get('/api/community/groups/:id/badges', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      return { rules: RULE_LABELS, badges: badgesOf(app, g.id).map(badgeOut) };
    });
    router.post('/api/community/groups/:id/badges', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      if (db.get<{ n: number }>('SELECT COUNT(*) AS n FROM community_badges WHERE group_id = ?', g.id)!.n >= 60) throw bad('Es sind höchstens 60 Abzeichen pro Gruppe möglich');
      const f = cleanBadge(ctx.body);
      const row = { id: id(), location_id: ctx.locationId, group_id: g.id, description: '', emoji: '🏅', color: '', rule: { type: 'manual', value: 0 }, points: 0, position: db.get<{ n: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM community_badges WHERE group_id = ?', g.id)!.n, ...f, created_at: now(), updated_at: now() };
      db.insert('community_badges', row);
      return badgeOut(mustBadge(ctx.locationId, row.id));
    });
    router.patch('/api/community/badges/:bid', 'location', (ctx) => {
      const b = mustBadge(ctx.locationId, ctx.params.bid);
      db.update('community_badges', b.id, { ...cleanBadge(ctx.body, b), updated_at: now() });
      return badgeOut(mustBadge(ctx.locationId, b.id));
    });
    router.delete('/api/community/badges/:bid', 'location', (ctx) => {
      const b = mustBadge(ctx.locationId, ctx.params.bid);
      db.run('UPDATE community_challenges SET badge_id = NULL WHERE badge_id = ?', b.id);
      db.run('DELETE FROM community_badges WHERE id = ?', b.id);
      return { ok: true };
    });
    router.get('/api/community/badges/:bid/awards', 'location', (ctx) => {
      const b = mustBadge(ctx.locationId, ctx.params.bid);
      return db
        .all<any>(`SELECT a.contact_id, a.awarded_at, a.awarded_by, a.reason, c.first_name, c.last_name, c.email FROM community_badge_awards a JOIN contacts c ON c.id = a.contact_id WHERE a.badge_id = ? ORDER BY a.awarded_at DESC LIMIT 500`, b.id)
        .map((r) => ({ contact_id: r.contact_id, name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email, awarded_at: r.awarded_at, awarded_by: r.awarded_by, reason: r.reason }));
    });
    router.post('/api/community/badges/:bid/award', 'location', (ctx) => {
      const b = mustBadge(ctx.locationId, ctx.params.bid);
      const g = mustGroup(ctx.locationId, b.group_id);
      const cid = String(ctx.body?.contact_id ?? '');
      if (!getContact(app, ctx.locationId, cid)) throw notFound('Kontakt nicht gefunden');
      return { awarded: awardBadge(app, g, cid, b, ctx.user?.name ?? 'Team', String(ctx.body?.reason ?? '')) };
    });
    router.delete('/api/community/badges/:bid/award/:contactId', 'location', (ctx) => {
      const b = mustBadge(ctx.locationId, ctx.params.bid);
      return { removed: revokeBadge(app, b, ctx.params.contactId) };
    });
    /** Checks every member against the rules now (new rules apply to people who qualified earlier). */
    router.post('/api/community/groups/:id/badges/evaluate', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      let given = 0;
      for (const m of db.all<{ contact_id: string }>('SELECT contact_id FROM community_members WHERE group_id = ? AND banned_at IS NULL LIMIT 20000', g.id)) given += evaluateBadges(app, g, m.contact_id).length;
      return { awarded: given };
    });
    /** Points by hand (a bonus or a correction); shows up in the leaderboard and can raise a level. */
    router.post('/api/community/groups/:id/points', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      const cid = String(ctx.body?.contact_id ?? '');
      const pts = Math.round(Number(ctx.body?.points));
      if (!Number.isFinite(pts) || pts === 0 || Math.abs(pts) > 10_000) throw bad('Punkte: eine Zahl zwischen -10000 und 10000 (nicht 0)');
      if (!db.get('SELECT 1 FROM community_members WHERE group_id = ? AND contact_id = ?', g.id, cid)) throw notFound('Diese Person ist kein Mitglied der Gruppe');
      award(app, g, cid, pts, 'manual', String(ctx.body?.reason ?? '').slice(0, 120), ctx.user?.id ?? 'api');
      return { points: memberPoints(app, g.id, cid) };
    });
    router.get('/api/community/groups/:id/badges/preview', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      const type = String(ctx.query.get('type') ?? '') as keyof typeof RULE_LABELS;
      const value = Number(ctx.query.get('value') ?? 0);
      if (!(type in RULE_LABELS) || type === 'manual') throw bad('Regel unbekannt');
      let n = 0;
      for (const m of db.all<{ contact_id: string }>('SELECT contact_id FROM community_members WHERE group_id = ? AND banned_at IS NULL LIMIT 5000', g.id)) if (statOf(app, g, m.contact_id, type) >= value) n++;
      return { qualifying: n };
    });

    // --- admin API: perks and what opens at a level -----------------------------------------------------------------------------
    const perkOut = (p: Perk) => ({ id: p.id, level: p.level, kind: p.kind, title: p.title, body: p.kind === 'file' ? '' : p.body, note: p.note, filename: p.filename, size: p.size, has_file: !!p.file });
    const mustPerk = (loc: string, pid: string) => {
      const p = db.get<Perk>('SELECT * FROM community_perks WHERE id = ? AND location_id = ?', pid, loc);
      if (!p) throw notFound('Vorteil nicht gefunden');
      return p;
    };
    router.get('/api/community/groups/:id/perks', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      return { kinds: PERK_KINDS, perks: perksOf(app, g.id).map(perkOut), max_file_bytes: PERK_FILE_MAX };
    });
    router.post('/api/community/groups/:id/perks', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      if (perksOf(app, g.id).length >= 100) throw bad('Es sind höchstens 100 Vorteile pro Gruppe möglich');
      const f = cleanPerk(ctx.body, groupSettings(g).levels);
      const row: Perk = { id: id(), location_id: ctx.locationId, group_id: g.id, body: '', note: '', file: '', filename: '', mime: '', size: 0, created_at: now(), ...(f as any) };
      // The file is checked before anything is stored, so a refused file leaves no half-made perk behind.
      const saved = row.kind === 'file' && ctx.body?.file?.data ? savePerkFile(app, row, ctx.body.file.name, ctx.body.file.data) : {};
      db.insert('community_perks', { ...row, ...saved });
      return perkOut(mustPerk(ctx.locationId, row.id));
    });
    router.patch('/api/community/perks/:pid', 'location', (ctx) => {
      const p = mustPerk(ctx.locationId, ctx.params.pid);
      const g = mustGroup(ctx.locationId, p.group_id);
      const f = cleanPerk(ctx.body, groupSettings(g).levels, p);
      if (f.kind !== p.kind && f.kind !== 'file') removePerkFile(app, p);
      db.update('community_perks', p.id, f.kind !== p.kind && f.kind !== 'file' ? { ...f, file: '', filename: '', mime: '', size: 0 } : f);
      return perkOut(mustPerk(ctx.locationId, p.id));
    });
    router.put('/api/community/perks/:pid/file', 'location', (ctx) => {
      const p = mustPerk(ctx.locationId, ctx.params.pid);
      if (p.kind !== 'file') throw bad('Dieser Vorteil ist kein Download');
      const saved = savePerkFile(app, p, ctx.body?.name, ctx.body?.data);
      if (p.file && p.file !== saved.file) removePerkFile(app, p);
      db.update('community_perks', p.id, saved);
      return perkOut(mustPerk(ctx.locationId, p.id));
    });
    router.delete('/api/community/perks/:pid', 'location', (ctx) => {
      const p = mustPerk(ctx.locationId, ctx.params.pid);
      removePerkFile(app, p);
      db.run('DELETE FROM community_perks WHERE id = ?', p.id);
      return { ok: true };
    });

    router.get('/api/community/groups/:id/unlocks', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      const s = groupSettings(g);
      return s.levels.map((l, i) => ({ level: i + 1, name: l.name, points: l.points, ...(({ courses, channels, perks }) => ({ courses, channels, perks: perks.map(perkOut) }))(unlocksAt(app, g, i + 1)) }));
    });
    router.get('/api/community/groups/:id/channel-rules', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      const rules = new Map(channelRules(app, g.id).map((r) => [r.channel_id, r]));
      return db.all<any>('SELECT id, name, emoji, category, admin_only FROM community_channels WHERE group_id = ? ORDER BY position, created_at', g.id).map((c) => ({ channel_id: c.id, name: c.name, emoji: c.emoji, category: c.category, admin_only: !!c.admin_only, min_level: rules.get(c.id)?.min_level ?? 1, tier_ids: rules.get(c.id)?.tier_ids ?? [] }));
    });
    router.put('/api/community/channels/:cid/rules', 'location', (ctx) => {
      const ch = db.get<any>('SELECT * FROM community_channels WHERE id = ? AND location_id = ?', ctx.params.cid, ctx.locationId);
      if (!ch) throw notFound('Kanal nicht gefunden');
      const g = mustGroup(ctx.locationId, ch.group_id);
      const r = cleanRule(app, g, ctx.body);
      if (r.min_level <= 1 && !r.tier_ids.length) db.run('DELETE FROM community_channel_rules WHERE channel_id = ?', ch.id);
      else db.run('INSERT INTO community_channel_rules (channel_id, group_id, min_level, tier_ids) VALUES (?, ?, ?, ?) ON CONFLICT(channel_id) DO UPDATE SET min_level = excluded.min_level, tier_ids = excluded.tier_ids', ch.id, g.id, r.min_level, JSON.stringify(r.tier_ids));
      return { channel_id: ch.id, ...r };
    });
    router.get('/api/community/groups/:id/leaderboard/archive', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      return archiveOf(app, g.id).map((a: any) => ({
        month: a.month,
        rows: (a.rows as { contact_id: string; points: number }[]).map((r, i) => ({ rank: i + 1, ...r, name: db.get<{ display_name: string }>('SELECT display_name FROM community_profiles WHERE location_id = ? AND contact_id = ?', ctx.locationId, r.contact_id)?.display_name ?? '' })),
      }));
    });

    // --- hook: channels that are still closed to this member ---------------------------------------------------------------------
    ui.closedChannels.push((g, contactId) => closedByRules(app, g as any, contactId));

    // --- member pages -------------------------------------------------------------------------------------------------------------
    const perkCount = (gid: string) => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM community_perks WHERE group_id = ?', gid)!.n + db.get<{ n: number }>('SELECT COUNT(*) AS n FROM community_channel_rules WHERE group_id = ? AND min_level > 1', gid)!.n;
    ui.tabs.push((p, _m, g) => (perkCount(g.id) || groupSettings(g as any).level_unlocks.length ? [{ key: 'perks', href: `${kitOf(app).gHref(p, g)}/perks`, label: '🎁 Vorteile' }] : []));

    router.get('/portal/:p/community/g/:group/perks', 'public', (ctx) =>
      kitOf(app).withGroup(ctx, (p, m, g) => {
        const kit = kitOf(app);
        const s = groupSettings(g as any);
        const mine = memberPoints(app, g.id, m.contact.id);
        const myLvl = levelFor(mine, s.levels);
        const staff = CAN.moderate(kit.roleOf(g, m.contact.id));
        const blocks = s.levels
          .map((l, i) => {
            const level = i + 1;
            const u = unlocksAt(app, g, level);
            if (!u.courses.length && !u.channels.length && !u.perks.length) return '';
            const open = level <= myLvl || staff;
            const rows = [
              ...u.courses.map((c) => `<div class="cm-perk${open ? '' : ' locked'}"><span class="ic">🎓</span><div class="bd"><strong>Kurs: ${escapeHtml(c)}</strong><div class="muted small">${open ? 'Ist in deinem Kursbereich freigeschaltet.' : 'Öffnet sich automatisch.'}</div></div></div>`),
              ...u.channels.map((c) => `<div class="cm-perk${open ? '' : ' locked'}"><span class="ic">💬</span><div class="bd"><strong>Kanal: ${escapeHtml(c)}</strong><div class="muted small">${open ? 'Du findest ihn im Feed.' : 'Öffnet sich automatisch.'}</div></div></div>`),
              ...u.perks.map((pk) => {
                let body = '';
                if (open) {
                  if (pk.kind === 'coupon') body = `<div class="cm-code">${escapeHtml(pk.body)}</div>`;
                  else if (pk.kind === 'link') body = `<p style="margin:6px 0 0"><a class="btn" href="${escapeHtml(pk.body)}" target="_blank" rel="noopener noreferrer">Öffnen</a></p>`;
                  else if (pk.kind === 'file') body = pk.file ? `<p style="margin:6px 0 0"><a class="btn" href="${kit.gHref(p, g)}/perks/${encodeURIComponent(pk.id)}/download">Herunterladen${pk.filename ? ` (${escapeHtml(pk.filename)})` : ''}</a></p>` : '';
                  else body = `<div class="prose small">${kit.renderText(p, pk.body, false)}</div>`;
                }
                return `<div class="cm-perk${open ? '' : ' locked'}"><span class="ic">${KIND_ICON[pk.kind] ?? '🎁'}</span><div class="bd"><strong>${escapeHtml(pk.title)}</strong>${pk.note && open ? `<div class="muted small">${escapeHtml(pk.note)}</div>` : ''}${open ? body : `<div class="muted small">🔒 Wird mit Level ${level} freigeschaltet.</div>`}</div></div>`;
              }),
            ].join('');
            return `<section class="cm-box cm-lvl"><h3>${open ? '✅' : '🔒'} ${escapeHtml(l.name)} <small>ab ${l.points} Punkten${open ? '' : ` · noch ${Math.max(0, l.points - mine)}`}</small></h3>${rows}</section>`;
          })
          .join('');
        return kit.frame(p, m, `Vorteile · ${g.name}`, `${kit.groupHead(p, g)}${kit.groupTabs(p, m, g, 'perks')}<div style="max-width:760px"><p class="muted">Du bist auf Level ${myLvl} mit ${mine} Punkten. Mit jedem Level öffnet sich mehr.</p>${blocks || '<div class="cm-box cm-empty"><p>Hier gibt es noch keine Vorteile.</p></div>'}</div>`);
      }),
    );
    router.get('/portal/:p/community/g/:group/perks/:pid/download', 'public', (ctx) =>
      kitOf(app).withGroup(ctx, (p, m, g) => {
        const kit = kitOf(app);
        const pk = db.get<Perk>('SELECT * FROM community_perks WHERE id = ? AND group_id = ?', ctx.params.pid, g.id);
        const lvl = levelFor(memberPoints(app, g.id, m.contact.id), groupSettings(g as any).levels);
        if (!pk || pk.kind !== 'file' || (lvl < pk.level && !CAN.moderate(kit.roleOf(g, m.contact.id)))) return kit.errorPage(p, m, 'Diese Datei gibt es nicht oder sie ist noch gesperrt.', 404);
        return perkFileResponse(app, pk) ?? kit.errorPage(p, m, 'Die Datei fehlt.', 404);
      }),
    );

    // Badges on the profile, and what comes next in the side column.
    ui.profileView.push((_p, _m, groups, them) => {
      const e = earnedBy(app, groups.map((g) => g.id), them.id);
      if (!e.length) return '';
      return `<div class="cm-box" style="margin:0 0 18px"><strong>Abzeichen</strong><div class="cm-badges" style="margin-top:8px">${e.map((x) => `<span class="cm-badge" title="${escapeHtml(x.badge.description)}"><i${x.badge.color ? ` style="background:${escapeHtml(x.badge.color)}"` : ''}>${escapeHtml(x.badge.emoji || '🏅')}</i>${escapeHtml(x.badge.name)}</span>`).join('')}</div></div>`;
    });
    ui.side.push((p, m, g) => {
      const kit = kitOf(app);
      const s = groupSettings(g as any);
      const pts = memberPoints(app, g.id, m.contact.id);
      const lvl = levelFor(pts, s.levels);
      const next = lvl < s.levels.length ? unlocksAt(app, g, lvl + 1) : undefined;
      const items = next ? [...next.courses.map((c) => `🎓 ${c}`), ...next.channels.map((c) => `💬 ${c}`), ...next.perks.map((x) => `${KIND_ICON[x.kind] ?? '🎁'} ${x.title}`)] : [];
      const mine = earnedBy(app, [g.id], m.contact.id).slice(0, 6);
      const open = badgesOf(app, g.id).length - earnedBy(app, [g.id], m.contact.id).length;
      if (!items.length && !mine.length) return '';
      return `${items.length ? `<div class="cm-box"><h3>Bei Level ${lvl + 1} öffnet sich</h3><ul class="small" style="margin:0;padding-left:18px">${items.slice(0, 5).map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul><p class="muted small" style="margin:8px 0 0">Noch ${Math.max(0, (s.levels[lvl]?.points ?? 0) - pts)} Punkte · <a href="${kit.gHref(p, g)}/perks">alle Vorteile</a></p></div>` : ''}${mine.length ? `<div class="cm-box"><h3>Meine Abzeichen</h3><div class="cm-badges">${mine.map((x) => `<span class="cm-badge" title="${escapeHtml(x.badge.description)}"><i${x.badge.color ? ` style="background:${escapeHtml(x.badge.color)}"` : ''}>${escapeHtml(x.badge.emoji || '🏅')}</i>${escapeHtml(x.badge.name)}</span>`).join('')}</div>${open > 0 ? `<p class="muted small" style="margin:8px 0 0">${open} weitere zu holen</p>` : ''}</div>` : ''}`;
    });
    ui.notificationIcon.push((k) => (k === 'badge' ? '🏅' : k === 'perk' ? '🎁' : undefined));
    ui.notificationTarget.push((p, n) => {
      const g = n.group_id ? db.get<{ slug: string }>('SELECT slug FROM community_groups WHERE id = ?', n.group_id) : undefined;
      if (!g) return undefined;
      if (n.kind === 'perk') return `${p.base}/community/g/${encodeURIComponent(g.slug)}/perks`;
      if (n.kind === 'badge') {
        const h = db.get<{ handle: string }>('SELECT handle FROM community_profiles WHERE location_id = ? AND contact_id = ?', p.locationId, n.contact_id)?.handle;
        return h ? `${p.base}/community/u/${encodeURIComponent(h)}` : undefined;
      }
      return undefined;
    });
  },
};
