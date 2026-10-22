import type { Module } from '../core/app.js';
import { HttpError, notFound, redirect } from '../core/http.js';
import { escapeHtml } from '../core/template.js';
import { formatInTz } from '../core/time.js';
import { id, now } from '../core/util.js';
import { getGroup } from '../services/community.js';
import { CAN } from '../services/community-ext.js';
import {
  challengeBoard,
  challengeById,
  challengeCounts,
  checkIn,
  cleanChallenge,
  cleanTasks,
  daysBetween,
  dayStates,
  dueToday,
  joinChallenge,
  participantOf,
  phaseOf,
  rowOut,
  sendReminders,
  tasksOf,
  todayOf,
  totalDays,
  type Challenge,
} from '../services/community-challenges.js';
import { communityUi, kitOf, type PortalCtx, type PortalMember } from '../services/community-ui.js';

/**
 * Challenges: admin API and the member pages (list, detail with the day grid, today's task, check-in, board). Rules and points:
 * services/community-challenges.ts.
 */

const CSS = `<style>
.cm-ch{display:flex;gap:14px;align-items:center;flex-wrap:wrap}.cm-ch .grow{flex:1;min-width:200px}
.cm-chs{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;margin:0 0 22px}
.cm-chc{display:flex;flex-direction:column;gap:8px;text-decoration:none;color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px 18px}
.cm-chc:hover{border-color:var(--brand)}.cm-chc h3{margin:0;font-size:18px}.cm-chc .em{font-size:28px;line-height:1}
.cm-days{display:grid;grid-template-columns:repeat(auto-fill,minmax(38px,1fr));gap:6px;margin:10px 0 4px}
.cm-day{aspect-ratio:1;display:grid;place-items:center;border-radius:9px;font-size:12px;font-weight:700;background:var(--soft);color:var(--muted);min-height:34px}
.cm-day.done{background:var(--brand);color:#fff}.cm-day.today{outline:2px solid var(--brand);color:var(--text)}.cm-day.missed{text-decoration:line-through;opacity:.55}
.cm-task{border-left:4px solid var(--brand);background:var(--soft);border-radius:0 12px 12px 0;padding:12px 16px;margin:12px 0}
.cm-task h3{margin:0 0 4px;font-size:16px}
.cm-note{padding:10px 0;border-top:1px solid var(--line);display:flex;gap:10px}.cm-note:first-child{border-top:0}
.cm-ok{background:rgba(34,197,94,.14);border:1px solid rgba(34,197,94,.45);border-radius:12px;padding:10px 14px;margin:0 0 14px}
.cm-pr{display:flex;gap:18px;flex-wrap:wrap;margin:6px 0 2px}.cm-pr div{min-width:84px}.cm-pr b{display:block;font-size:24px;line-height:1.1}
</style>`;

export const communityChallengesModule: Module = {
  name: 'community-challenges',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE community_challenges (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
        title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', emoji TEXT NOT NULL DEFAULT '🔥',
        starts_on TEXT NOT NULL, ends_on TEXT NOT NULL, goal_days INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'draft', points_checkin INTEGER, points_complete INTEGER,
        badge_id TEXT REFERENCES community_badges(id) ON DELETE SET NULL, require_note INTEGER NOT NULL DEFAULT 0,
        reminder_hour INTEGER DEFAULT 18, last_reminder_day TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX community_challenges_group ON community_challenges(group_id, status, starts_on);
      CREATE TABLE community_challenge_tasks (
        id TEXT PRIMARY KEY, challenge_id TEXT NOT NULL REFERENCES community_challenges(id) ON DELETE CASCADE,
        day INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', UNIQUE (challenge_id, day)
      );
      CREATE TABLE community_challenge_members (
        challenge_id TEXT NOT NULL REFERENCES community_challenges(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        joined_at TEXT NOT NULL, completed_at TEXT, checkins INTEGER NOT NULL DEFAULT 0, streak INTEGER NOT NULL DEFAULT 0,
        best_streak INTEGER NOT NULL DEFAULT 0, last_day TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (challenge_id, contact_id)
      );
      CREATE INDEX community_challenge_members_contact ON community_challenge_members(contact_id);
      CREATE TABLE community_challenge_checkins (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        challenge_id TEXT NOT NULL REFERENCES community_challenges(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        day TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', checked_at TEXT NOT NULL,
        UNIQUE (challenge_id, contact_id, day)
      );
      CREATE INDEX community_challenge_checkins_member ON community_challenge_checkins(location_id, contact_id, checked_at);
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
    const mustChallenge = (loc: string, cid: string) => {
      const c = challengeById(app, loc, cid);
      if (!c) throw notFound('Challenge nicht gefunden');
      return c;
    };

    // Reminders: once a day at the set hour.
    let lastRun = 0;
    app.onTick(() => {
      if (Date.now() - lastRun < 60_000) return;
      lastRun = Date.now();
      sendReminders(app);
    });

    // --- admin API --------------------------------------------------------------------------------------------------------------
    const out = (c: Challenge, withTasks = false) => ({
      ...rowOut(c),
      days: totalDays(c),
      phase: phaseOf(app, c),
      ...challengeCounts(app, c.id),
      ...(withTasks ? { tasks: tasksOf(app, c.id), board: challengeBoard(app, c.id, 20).map((r) => ({ ...r, name: nameOf(c.location_id, r.contact_id) })) } : {}),
    });
    const nameOf = (loc: string, cid: string) => db.get<{ display_name: string }>('SELECT display_name FROM community_profiles WHERE location_id = ? AND contact_id = ?', loc, cid)?.display_name ?? 'Mitglied';
    const saveTasks = (c: Challenge, input: unknown) => {
      const tasks = cleanTasks(input, totalDays(c));
      db.tx(() => {
        db.run('DELETE FROM community_challenge_tasks WHERE challenge_id = ?', c.id);
        for (const t of tasks) db.insert('community_challenge_tasks', { id: id(), challenge_id: c.id, ...t });
      });
    };
    router.get('/api/community/groups/:id/challenges', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      return db.all<Challenge>('SELECT * FROM community_challenges WHERE group_id = ? ORDER BY starts_on DESC LIMIT 200', g.id).map((c) => out(c));
    });
    router.post('/api/community/groups/:id/challenges', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      const f = cleanChallenge(app, g, ctx.body);
      const row = { id: id(), location_id: ctx.locationId, group_id: g.id, description: '', emoji: '🔥', status: 'draft', points_checkin: null, points_complete: null, badge_id: null, require_note: 0, reminder_hour: 18, last_reminder_day: '', ...f, created_at: now(), updated_at: now() };
      db.insert('community_challenges', row);
      const c = mustChallenge(ctx.locationId, row.id);
      if (ctx.body?.tasks !== undefined) saveTasks(c, ctx.body.tasks);
      return out(c, true);
    });
    router.get('/api/community/challenges/:cid', 'location', (ctx) => out(mustChallenge(ctx.locationId, ctx.params.cid), true));
    router.patch('/api/community/challenges/:cid', 'location', (ctx) => {
      const cur = mustChallenge(ctx.locationId, ctx.params.cid);
      const g = mustGroup(ctx.locationId, cur.group_id);
      db.update('community_challenges', cur.id, { ...cleanChallenge(app, g, ctx.body, cur), updated_at: now() });
      const c = mustChallenge(ctx.locationId, cur.id);
      if (ctx.body?.tasks !== undefined) saveTasks(c, ctx.body.tasks);
      else db.run('DELETE FROM community_challenge_tasks WHERE challenge_id = ? AND day > ?', c.id, totalDays(c));
      return out(c, true);
    });
    router.delete('/api/community/challenges/:cid', 'location', (ctx) => {
      const c = mustChallenge(ctx.locationId, ctx.params.cid);
      db.run('DELETE FROM community_challenges WHERE id = ?', c.id);
      return { ok: true };
    });
    router.get('/api/community/challenges/:cid/participants', 'location', (ctx) => {
      const c = mustChallenge(ctx.locationId, ctx.params.cid);
      return db
        .all<any>(`SELECT p.*, k.email FROM community_challenge_members p JOIN contacts k ON k.id = p.contact_id WHERE p.challenge_id = ? ORDER BY p.checkins DESC, p.joined_at LIMIT 1000`, c.id)
        .map((r) => ({ contact_id: r.contact_id, name: nameOf(c.location_id, r.contact_id), email: r.email, joined_at: r.joined_at, checkins: r.checkins, streak: r.streak, best_streak: r.best_streak, completed_at: r.completed_at }));
    });

    // --- member pages -------------------------------------------------------------------------------------------------------------
    const visibleIn = (gid: string) => db.all<Challenge>(`SELECT * FROM community_challenges WHERE group_id = ? AND status != 'draft' ORDER BY starts_on DESC LIMIT 100`, gid);
    ui.tabs.push((p, _m, g) => (visibleIn(g.id).length ? [{ key: 'challenges', href: `${kitOf(app).gHref(p, g)}/challenges`, label: '🔥 Challenges' }] : []));

    const range = (c: Challenge) => {
      const f = (ymd: string) => formatInTz(`${ymd}T12:00:00Z`, 'UTC', { weekday: undefined, hour: undefined, minute: undefined, year: undefined, day: 'numeric', month: 'short' });
      return `${f(c.starts_on)} – ${f(c.ends_on)}`;
    };
    const card = (p: PortalCtx, m: PortalMember, g: any, c: Challenge) => {
      const kit = kitOf(app);
      const me = participantOf(app, c.id, m.contact.id);
      const phase = phaseOf(app, c);
      const counts = challengeCounts(app, c.id);
      const pct = me ? Math.min(100, Math.round((me.checkins / Math.max(1, c.goal_days)) * 100)) : 0;
      const today = todayOf(app, c.location_id);
      const label = me?.completed_at ? 'Geschafft 🎉' : phase === 'upcoming' ? `Startet am ${range(c).split(' – ')[0]}` : phase === 'over' ? 'Beendet' : me ? (me.last_day === today ? 'Heute erledigt ✓' : 'Heute einchecken') : 'Mitmachen';
      return `<a class="cm-chc" href="${kit.gHref(p, g)}/challenges/${encodeURIComponent(c.id)}"><span class="em">${escapeHtml(c.emoji || '🔥')}</span><h3>${escapeHtml(c.title)}</h3><div class="muted small">${escapeHtml(range(c))} · ${totalDays(c)} Tage · ${counts.members} ${counts.members === 1 ? 'Teilnehmer' : 'Teilnehmer'}</div>${me ? `<div class="bar"><i style="width:${pct}%"></i></div><div class="muted small">${me.checkins} von ${c.goal_days} Tagen${me.streak > 1 ? ` · 🔥 ${me.streak} in Folge` : ''}</div>` : ''}<span class="btn${me && me.last_day === today ? ' ghost' : ''}" style="align-self:flex-start">${label}</span></a>`;
    };

    router.get('/portal/:p/community/g/:group/challenges', 'public', (ctx) =>
      kitOf(app).withGroup(ctx, (p, m, g) => {
        const kit = kitOf(app);
        const all = visibleIn(g.id);
        const by = (phase: string) => all.filter((c) => c.status === 'active' && phaseOf(app, c) === phase);
        const over = all.filter((c) => c.status === 'archived' || phaseOf(app, c) === 'over').slice(0, 12);
        const sec = (title: string, list: Challenge[]) => (list.length ? `<h2 style="margin:18px 0 10px">${title}</h2><div class="cm-chs">${list.map((c) => card(p, m, g, c)).join('')}</div>` : '');
        return kit.frame(p, m, `Challenges · ${g.name}`, `${kit.groupHead(p, g)}${kit.groupTabs(p, m, g, 'challenges')}${sec('Läuft gerade', by('running'))}${sec('Startet bald', by('upcoming'))}${sec('Beendet', over)}${all.length ? '' : '<div class="cm-box cm-empty"><p><strong>Gerade läuft keine Challenge.</strong></p></div>'}`);
      }),
    );

    const detail = (p: PortalCtx, m: PortalMember, g: any, c: Challenge, flash: { ok?: string; error?: string } = {}, status = 200) => {
      const kit = kitOf(app);
      const me = participantOf(app, c.id, m.contact.id);
      const phase = phaseOf(app, c);
      const today = todayOf(app, c.location_id);
      const dayNo = phase === 'running' ? daysBetween(c.starts_on, today) + 1 : 0;
      const tasks = new Map(tasksOf(app, c.id).map((t) => [t.day, t]));
      const task = dayNo ? tasks.get(dayNo) : undefined;
      const board = challengeBoard(app, c.id, 15);
      const rank = me && me.checkins ? challengeBoard(app, c.id, 5000).findIndex((r) => r.contact_id === m.contact.id) + 1 : 0;
      const counts = challengeCounts(app, c.id);
      const notes = db.all<any>(`SELECT k.contact_id, k.note, k.day, k.checked_at FROM community_challenge_checkins k JOIN community_members cm ON cm.group_id = ? AND cm.contact_id = k.contact_id AND cm.banned_at IS NULL WHERE k.challenge_id = ? AND k.note != '' ORDER BY k.checked_at DESC LIMIT 12`, g.id, c.id);
      const doneToday = !!me && me.last_day === today;
      const csrf = kit.tokenInput(m);
      const base = `${kit.gHref(p, g)}/challenges/${encodeURIComponent(c.id)}`;
      const form =
        c.status !== 'active' || phase === 'over'
          ? `<p class="muted">Diese Challenge ist beendet.${me?.completed_at ? ' Du hast sie geschafft 🎉' : ''}</p>`
          : phase === 'upcoming'
            ? `<p class="muted">Die Challenge startet am ${escapeHtml(range(c).split(' – ')[0])}.</p>${me ? '<p><strong>Du bist dabei.</strong></p>' : `<form method="post" action="${base}/join">${csrf}<button class="btn">Mitmachen</button></form>`}`
            : doneToday
              ? `<p><strong>Heute erledigt ✓</strong> – bis morgen!</p>`
              : `<form method="post" action="${base}/checkin">${csrf}<label for="note">${c.require_note ? 'Was hast du heute gemacht?' : 'Notiz (freiwillig)'}</label><textarea id="note" name="note" rows="2" maxlength="600" class="cm-in"${c.require_note ? ' required' : ''} placeholder="Ein, zwei Sätze für die Gruppe …"></textarea><p style="margin:10px 0 0"><button class="btn">Heute einchecken ✓</button></p></form>`;
      const medal = ['🥇', '🥈', '🥉'];
      return kit.frame(
        p,
        m,
        `${c.title} · ${g.name}`,
        `${kit.groupHead(p, g)}${kit.groupTabs(p, m, g, 'challenges')}<div class="crumb"><a href="${kit.gHref(p, g)}/challenges">Alle Challenges</a></div>
<div class="cm-grid"><section>
${flash.ok ? `<div class="cm-ok" role="status">${escapeHtml(flash.ok)}</div>` : ''}${flash.error ? `<div class="cm-err" role="alert">${escapeHtml(flash.error)}</div>` : ''}
<div class="cm-box"><h1 style="margin:0 0 4px">${escapeHtml(c.emoji || '🔥')} ${escapeHtml(c.title)}</h1><div class="muted small">${escapeHtml(range(c))} · ${totalDays(c)} Tage · Ziel: ${c.goal_days} Check-ins${dayNo ? ` · heute ist Tag ${dayNo}` : ''}</div>
${c.description ? `<div class="prose" style="margin-top:10px">${kit.renderText(p, c.description, false)}</div>` : ''}</div>
<div class="cm-box">${me ? `<div class="cm-pr"><div><b>${me.checkins}</b><span class="muted small">von ${c.goal_days} Tagen</span></div><div><b>${me.streak}</b><span class="muted small">in Folge</span></div>${rank ? `<div><b>#${rank}</b><span class="muted small">Platz</span></div>` : ''}</div>` : ''}
<div class="cm-days" role="img" aria-label="Deine Tage">${dayStates(app, c, m.contact.id, today).map((d) => `<span class="cm-day ${d.state}" title="Tag ${d.n}: ${escapeHtml(tasks.get(d.n)?.title ?? '')}">${d.n}</span>`).join('')}</div>
${task ? `<div class="cm-task"><h3>Heute · Tag ${dayNo}: ${escapeHtml(task.title)}</h3>${task.body ? `<div class="prose small">${kit.renderText(p, task.body, false)}</div>` : ''}</div>` : ''}
${form}</div>
${notes.length ? `<div class="cm-box"><h3>Aus der Gruppe</h3>${notes.map((n) => { const pr = kit.profile(p, n.contact_id); const name = pr?.display_name ?? 'Mitglied'; return `<div class="cm-note">${kit.avatar(p, name, pr, 's')}<div><strong>${escapeHtml(name)}</strong> <span class="muted small">· ${kit.when(p, n.checked_at)}</span><div class="prose small">${kit.renderText(p, n.note, true)}</div></div></div>`; }).join('')}</div>` : ''}
</section><aside class="cm-side"><div class="cm-box"><h3>Rangliste</h3>${board.length ? `<ol class="cm-lb">${board.map((r, i) => { const pr = kit.profile(p, r.contact_id); const name = pr?.display_name ?? 'Mitglied'; return `<li class="${r.contact_id === m.contact.id ? 'me' : ''}"><span class="r${i < 3 ? ' top' : ''}">${i < 3 ? medal[i] : i + 1}</span>${kit.avatar(p, name, pr, 's')}<a href="${pr ? `${kit.cbase(p)}/u/${encodeURIComponent(pr.handle)}` : '#'}" style="color:inherit;text-decoration:none;font-weight:600">${escapeHtml(name)}</a><span class="p">${r.checkins}</span></li>`; }).join('')}</ol>` : '<p class="muted small">Noch niemand eingecheckt – sei die Erste oder der Erste!</p>'}<p class="muted small" style="margin:10px 0 0">${counts.members} ${counts.members === 1 ? 'Person macht' : 'Personen machen'} mit${counts.done ? ` · ${counts.done} geschafft` : ''}</p></div></aside></div>`,
        status,
      );
    };

    const withChallenge = (ctx: any, fn: (p: PortalCtx, m: PortalMember, g: any, c: Challenge) => any) =>
      kitOf(app).withGroup(ctx, (p, m, g) => {
        const c = challengeById(app, p.locationId, ctx.params.cid);
        if (!c || c.group_id !== g.id || (c.status === 'draft' && !CAN.moderate(kitOf(app).roleOf(g, m.contact.id)))) return kitOf(app).errorPage(p, m, 'Diese Challenge gibt es nicht.', 404);
        return fn(p, m, g, c);
      });

    router.get('/portal/:p/community/g/:group/challenges/:cid', 'public', (ctx) =>
      withChallenge(ctx, (p, m, g, c) => {
        const ok = ctx.query.get('ok');
        return detail(p, m, g, c, { ok: ok === 'checkin' ? 'Check-in gespeichert – stark!' : ok === 'done' ? 'Geschafft! Du hast die Challenge abgeschlossen. 🎉' : ok === 'join' ? 'Du bist dabei!' : undefined });
      }),
    );
    router.post('/portal/:p/community/g/:group/challenges/:cid/join', 'public', (ctx) =>
      withChallenge(ctx, (p, m, g, c) => {
        try {
          joinChallenge(app, g, c, m.contact.id);
        } catch (e) {
          if (e instanceof HttpError) return detail(p, m, g, c, { error: e.message }, e.status);
          throw e;
        }
        return redirect(`${kitOf(app).gHref(p, g)}/challenges/${encodeURIComponent(c.id)}?ok=join`, 303);
      }),
    );
    router.post('/portal/:p/community/g/:group/challenges/:cid/checkin', 'public', (ctx) =>
      withChallenge(ctx, (p, m, g, c) => {
        let done = false;
        try {
          done = checkIn(app, g, c, m.contact.id, ctx.body?.note).completed;
        } catch (e) {
          if (e instanceof HttpError) return detail(p, m, g, c, { error: e.message }, e.status);
          throw e;
        }
        return redirect(`${kitOf(app).gHref(p, g)}/challenges/${encodeURIComponent(c.id)}?ok=${done ? 'done' : 'checkin'}`, 303);
      }),
    );

    // On the feed: a nudge for today's check-in, or a running challenge to join.
    ui.feedTop.push((p, m, g) => {
      const kit = kitOf(app);
      const due = dueToday(app, g.id, m.contact.id)[0];
      if (due) {
        const day = daysBetween(due.starts_on, todayOf(app, due.location_id)) + 1;
        return `<div class="cm-box cm-ch"><span style="font-size:28px">${escapeHtml(due.emoji || '🔥')}</span><div class="grow"><strong>Tag ${day} von ${totalDays(due)}: ${escapeHtml(due.title)}</strong><div class="muted small">Dein Check-in für heute wartet.</div></div><a class="btn" href="${kit.gHref(p, g)}/challenges/${encodeURIComponent(due.id)}">Einchecken</a></div>`;
      }
      const open = visibleIn(g.id).find((c) => c.status === 'active' && phaseOf(app, c) === 'running' && !participantOf(app, c.id, m.contact.id));
      if (!open) return '';
      return `<div class="cm-box cm-ch"><span style="font-size:28px">${escapeHtml(open.emoji || '🔥')}</span><div class="grow"><strong>${escapeHtml(open.title)}</strong><div class="muted small">Läuft gerade – mach mit!</div></div><a class="btn ghost" href="${kit.gHref(p, g)}/challenges/${encodeURIComponent(open.id)}">Ansehen</a></div>`;
    });
    ui.notificationTarget.push((p, n) => {
      if (n.kind !== 'challenge') return undefined;
      const c = n.post_id ? db.get<Challenge>('SELECT * FROM community_challenges WHERE id = ? AND location_id = ?', n.post_id, p.locationId) : undefined;
      const g = n.group_id ? db.get<any>('SELECT slug FROM community_groups WHERE id = ?', n.group_id) : undefined;
      return c && g ? `${p.base}/community/g/${encodeURIComponent(g.slug)}/challenges/${encodeURIComponent(c.id)}` : undefined;
    });
    ui.notificationIcon.push((k) => (k === 'challenge' ? '🔥' : undefined));
  },
};
