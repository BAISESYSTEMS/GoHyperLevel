import type { Module } from '../core/app.js';
import { HttpError, bad, redirect } from '../core/http.js';
import { escapeHtml } from '../core/template.js';
import { ymdInTz } from '../core/time.js';
import { now } from '../core/util.js';
import { getContact } from '../services/contacts.js';
import { excerptOf, stripMarkdown } from '../services/markdown.js';
import { deleteComment, deletePost, setHidden } from '../services/community-actions.js';
import { contributions, currentStreak, heatmapSvg } from '../services/community-activity.js';
import { CAN, extOf, onlineIds, profileExt, pushPrefs, roleOf, saveProfileExt, savePushPrefs, touchPresence, type Role } from '../services/community-ext.js';
import { approveMembership, communityMail, membershipById, pageOf, rejectMembership, tiersOf } from '../services/community-tiers.js';
import { communityUi, kitOf, type PortalMember } from '../services/community-ui.js';
import { parseJson } from '../core/db.js';
import { relTime } from '../services/community.js';

/**
 * Members: profile extras (headline, city, links, what others may see, push choices), the activity heatmap, "online now", and the
 * moderation tools for admins and moderators among the members (hide, delete, pin, settle reports, answer join requests).
 */

const CSS = `<style>
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--muted);vertical-align:middle}
.dot.on{background:#22c55e;box-shadow:0 0 0 2px var(--panel)}
.cm-mem{display:flex;gap:10px;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px 14px}
.cm-mem:hover{border-color:var(--brand)}.cm-memlink{display:flex;gap:12px;align-items:center;flex:1;min-width:0;color:inherit;text-decoration:none;position:relative}
.cm-memlink .dot{position:absolute;left:34px;top:34px}
.cm-toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 14px}.cm-toolbar .cm-in{width:auto;min-width:150px}.cm-toolbar .grow{flex:1;min-width:200px}
.cm-map{width:100%;height:auto;color:var(--text);display:block}.cm-map .mp{fill:var(--brand);fill-opacity:.85;stroke:var(--panel);stroke-width:2}.cm-map .mp:hover{fill-opacity:1}
.cm-links{display:flex;gap:12px;flex-wrap:wrap;margin:8px 0 0}.cm-links a{font-weight:600;text-decoration:none}
.cm-heat{width:100%;height:auto;max-width:760px}.cm-heat .hml{font-size:9px;fill:var(--muted)}
.hm0{fill:var(--line)}.hm1{fill:var(--brand);fill-opacity:.28}.hm2{fill:var(--brand);fill-opacity:.5}.hm3{fill:var(--brand);fill-opacity:.75}.hm4{fill:var(--brand)}
.cm-online{display:flex;gap:6px;flex-wrap:wrap}.cm-online a{text-decoration:none}
.cm-modbar{display:inline-flex;gap:6px;flex-wrap:wrap;align-items:center}.cm-modbar form{margin:0}
.cm-fieldset{border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:6px 0}.cm-fieldset legend{font-size:13px;font-weight:700;color:var(--muted);padding:0 6px}
.cm-check{display:flex;gap:10px;align-items:flex-start;font-size:15px;font-weight:500;color:var(--text);min-height:36px}.cm-check input{width:20px;height:20px;margin-top:2px;accent-color:var(--brand);flex:none}
</style>`;

export const communityMembersModule: Module = {
  name: 'community-members',
  register(app) {
    const { db, router } = app;
    const ui = communityUi(app);
    ui.head.push(() => CSS);

    // --- presence: the page script pings now and then while the tab is open -------------------------------------------------
    router.post('/portal/:p/community/ping', 'public', (ctx) => {
      const kit = kitOf(app);
      const p = kit.portal.resolve(ctx.params.p);
      const m = p && kit.portal.memberOf(ctx, p);
      if (!p || !m || ctx.req.headers['x-community-csrf'] !== kit.csrf(m)) return { __raw: true, status: 204, headers: {}, body: '' };
      touchPresence(app, p.locationId, m.contact.id);
      return { __raw: true, status: 204, headers: {}, body: '' };
    });

    // --- profile: extra fields, saved with the rest ----------------------------------------------------------------------------
    const anyMap = (m: PortalMember, locationId: string) => !!db.all<{ id: string }>(`SELECT g.id FROM community_groups g JOIN community_members cm ON cm.group_id = g.id WHERE g.location_id = ? AND cm.contact_id = ?`, locationId, m.contact.id).some((g) => extOf(app, g.id).map.enabled);
    ui.profileEdit.push((p, m) => {
      const e = profileExt(app, p.locationId, m.contact.id);
      const pp = pushPrefs(app, p.locationId, m.contact.id);
      const links = [...e.links, ...Array.from({ length: 5 }, () => ({ label: '', url: '' }))].slice(0, 5);
      const box = (name: string, on: boolean, label: string) => `<label class="cm-check"><input type="hidden" name="${name}" value="0"><input type="checkbox" name="${name}" value="1"${on ? ' checked' : ''}> ${label}</label>`;
      return `<label for="hl">Kurzbeschreibung</label><input id="hl" type="text" name="headline" maxlength="80" placeholder="z. B. Coach für Selbstständige" value="${escapeHtml(e.headline)}">
<div class="cm-row"><div class="grow"><label for="ci">Stadt</label><input id="ci" type="text" name="city" maxlength="80" value="${escapeHtml(e.city)}" autocomplete="address-level2"></div><div class="grow"><label for="co">Land</label><input id="co" type="text" name="country" maxlength="60" value="${escapeHtml(e.country)}" autocomplete="country-name"></div></div>
${anyMap(m, p.locationId) ? box('show_on_map', e.show_on_map, 'Mich auf der Mitglieder-Karte zeigen (nur die Stadt, nie die genaue Adresse)') : ''}
<fieldset class="cm-fieldset"><legend>Links auf deinem Profil</legend>${links.map((l, i) => `<div class="cm-row" style="margin-bottom:6px"><input type="text" name="link_label" maxlength="40" placeholder="Name (z. B. Website)" value="${escapeHtml(l.label)}" style="max-width:200px" aria-label="Link ${i + 1}: Name"><input type="text" name="link_url" maxlength="300" placeholder="https://…" value="${escapeHtml(l.url)}" class="grow" aria-label="Link ${i + 1}: Adresse"></div>`).join('')}</fieldset>
<fieldset class="cm-fieldset"><legend>Was andere sehen</legend>${box('show_online', e.show_online, 'Zeigen, wenn ich gerade online bin')}${box('show_activity', e.show_activity, 'Meine Aktivität (Kalender) auf dem Profil zeigen')}</fieldset>
<fieldset class="cm-fieldset"><legend>Benachrichtigungen aufs Gerät</legend><p class="cm-hint" style="margin:0 0 6px">Pushmitteilungen kommen nur auf Geräten an, auf denen du sie erlaubt hast.</p><div data-push-box></div>${box('push_dms', pp.dms, 'Neue Nachrichten')}${box('push_mentions', pp.mentions, 'Wenn mich jemand erwähnt')}${box('push_replies', pp.replies, 'Antworten auf meine Kommentare')}${box('push_announcements', pp.announcements, 'Ankündigungen des Teams')}${box('push_posts', pp.posts, 'Alle neuen Beiträge')}</fieldset>`;
    });
    ui.profileSave.push((p, m, b, forms) => {
      const flag = (name: string) => forms(name).includes('1');
      const has = (name: string) => forms(name).length > 0;
      const labels = forms('link_label');
      const urls = forms('link_url');
      saveProfileExt(app, p.locationId, m.contact.id, {
        headline: b.headline,
        city: b.city,
        country: b.country,
        links: urls.map((url, i) => ({ url, label: labels[i] ?? '' })).filter((l) => l.url.trim()),
        ...(has('show_on_map') ? { show_on_map: flag('show_on_map') } : {}),
        ...(has('show_online') ? { show_online: flag('show_online') } : {}),
        ...(has('show_activity') ? { show_activity: flag('show_activity') } : {}),
      });
      if (has('push_dms')) savePushPrefs(app, p.locationId, m.contact.id, { dms: flag('push_dms'), mentions: flag('push_mentions'), replies: flag('push_replies'), announcements: flag('push_announcements'), posts: flag('push_posts') });
    });

    // --- the heatmap on the profile --------------------------------------------------------------------------------------------------
    ui.profileView.push((p, m, _groups, them) => {
      const self = them.id === m.contact.id;
      const e = profileExt(app, p.locationId, them.id);
      if (!self && !e.show_activity) return '';
      const tz = (p.loc?.timezone as string) || 'Europe/Berlin';
      const map = contributions(app, p.locationId, them.id, tz);
      const total = [...map.values()].reduce((a, b) => a + b, 0);
      const today = ymdInTz(new Date(), tz);
      const streak = currentStreak(map, today);
      return `<div class="cm-box" style="margin:0 0 18px"><div class="cm-row" style="margin-bottom:6px"><strong class="grow">Aktivität</strong><span class="muted small">${total} ${total === 1 ? 'Beitrag' : 'Beiträge'} in den letzten 12 Monaten${streak > 1 ? ` · ${streak} Tage am Stück` : ''}</span></div>${heatmapSvg(map, today)}${self && !e.show_activity ? '<p class="cm-hint" style="margin:6px 0 0">Nur du siehst das, du hast es im Profil ausgeblendet.</p>' : ''}</div>`;
    });

    // --- "online now" in the side column ----------------------------------------------------------------------------------------------------
    ui.side.push((p, m, g) => {
      const ext = extOf(app, g.id);
      if (!ext.online.enabled) return '';
      const kit = kitOf(app);
      const ids = db.all<{ contact_id: string }>('SELECT contact_id FROM community_members WHERE group_id = ? AND banned_at IS NULL', g.id).map((r) => r.contact_id);
      const on = [...onlineIds(app, p.locationId, ids)];
      const shown = on.filter((c) => c !== m.contact.id).slice(0, 8);
      const others = on.length - (on.includes(m.contact.id) ? 1 : 0);
      return `<div class="cm-box"><h3><span class="dot on"></span> Online jetzt (${on.length})</h3>${shown.length ? `<div class="cm-online">${shown.map((cid) => { const pr = kit.profile(p, cid); return pr ? `<a href="${kit.cbase(p)}/u/${encodeURIComponent(pr.handle)}" title="${escapeHtml(pr.display_name)}">${kit.avatar(p, pr.display_name, pr, 's')}</a>` : ''; }).join('')}</div>${others > shown.length ? `<p class="muted small" style="margin:8px 0 0">und ${others - shown.length} weitere</p>` : ''}` : '<p class="muted small" style="margin:0">Gerade bist nur du hier.</p>'}</div>`;
    });

    // --- moderation by members with a role -----------------------------------------------------------------------------------------------------
    const roleOfM = (g: any, m: PortalMember): Role | null => roleOf(app, g.id, m.contact.id);
    const openReports = (g: any) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM community_reports WHERE group_id = ? AND status = 'open'`, g.id)!.n;
    const pendingJoins = (g: any) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM community_memberships WHERE group_id = ? AND status = 'pending'`, g.id)!.n;

    ui.tabs.push((p, m, g) => {
      const role = roleOfM(g, m);
      if (!CAN.moderate(role)) return [];
      const n = openReports(g) + (CAN.admin(role) ? pendingJoins(g) : 0);
      return [{ key: 'mod', href: `${kitOf(app).gHref(p, g)}/mod`, label: `Moderation${n ? ` <span class="cm-n">${n}</span>` : ''}` }];
    });

    const modBtn = (href: string, csrf: string, action: string, text: string, confirm = '') => `<form method="post" action="${href}"${confirm ? ` data-confirm="${escapeHtml(confirm)}"` : ''}><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="action" value="${action}"><button class="cm-link">${text}</button></form>`;

    ui.postActions.push((p, m, g, post, csrf) => {
      const role = roleOfM(g, m);
      if (!CAN.moderate(role)) return '';
      const href = `${kitOf(app).postHref(p, g, post.id)}/mod`;
      const own = post.contact_id === m.contact.id;
      return `<span class="cm-modbar" aria-label="Moderation">${modBtn(href, csrf, post.pinned ? 'unpin' : 'pin', post.pinned ? 'Lösen' : 'Anheften')}${own ? '' : `${modBtn(href, csrf, 'hide', 'Ausblenden', 'Beitrag für alle ausblenden?')}${modBtn(href, csrf, 'delete', 'Löschen', 'Beitrag mit allen Kommentaren endgültig löschen?')}`}</span>`;
    });
    ui.commentActions.push((p, m, g, post, c, csrf) => {
      const role = roleOfM(g, m);
      if (!CAN.moderate(role) || c.contact_id === m.contact.id || !c.contact_id) return '';
      const href = `${kitOf(app).gHref(p, g)}/c/${encodeURIComponent(c.id)}/mod`;
      void post;
      return `<span class="cm-modbar">${modBtn(href, csrf, 'hide', 'Ausblenden')}${modBtn(href, csrf, 'delete', 'Löschen', 'Kommentar löschen?')}</span>`;
    });

    router.post('/portal/:p/community/g/:group/p/:post/mod', 'public', (ctx) =>
      kitOf(app).withPost(ctx, (p, m, g, post) => {
        const kit = kitOf(app);
        if (!CAN.moderate(roleOfM(g, m))) return kit.errorPage(p, m, 'Das dürfen nur Moderatorinnen, Moderatoren und Admins.', 403);
        const action = String(ctx.body?.action ?? '');
        const href = kit.gHref(p, g);
        if (action === 'pin' || action === 'unpin') {
          db.run('UPDATE community_posts SET pinned = ? WHERE id = ?', action === 'pin' ? 1 : 0, post.id);
          return redirect(kit.postHref(p, g, post.id), 303);
        }
        if (action === 'hide') {
          setHidden(app, 'post', post, true, `von ${m.contact.first_name || 'Moderation'}`);
          return redirect(href, 303);
        }
        if (action === 'delete') {
          deletePost(app, post);
          return redirect(href, 303);
        }
        return kit.errorPage(p, m, 'Unbekannte Aktion.', 400);
      }),
    );
    router.post('/portal/:p/community/g/:group/c/:comment/mod', 'public', (ctx) =>
      kitOf(app).withComment(ctx, (p, m, g, c, post) => {
        const kit = kitOf(app);
        if (!CAN.moderate(roleOfM(g, m))) return kit.errorPage(p, m, 'Das dürfen nur Moderatorinnen, Moderatoren und Admins.', 403);
        const action = String(ctx.body?.action ?? '');
        if (action === 'hide') setHidden(app, 'comment', c, true);
        else if (action === 'delete') deleteComment(app, c);
        else return kit.errorPage(p, m, 'Unbekannte Aktion.', 400);
        return redirect(`${kit.postHref(p, g, post.id)}#kommentare`, 303);
      }),
    );

    const modPage = (ctx: any) =>
      kitOf(app).withGroup(ctx, (p, m, g) => {
        const kit = kitOf(app);
        const role = roleOfM(g, m);
        if (!CAN.moderate(role)) return kit.errorPage(p, m, 'Dieser Bereich ist für Moderatorinnen, Moderatoren und Admins.', 403);
        const csrf = kit.csrf(m);
        const reports = db.all<any>(`SELECT * FROM community_reports WHERE group_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 50`, g.id);
        const repHtml = reports
          .map((r) => {
            const t = r.kind === 'post' ? db.get<any>('SELECT id, title, body, author_name FROM community_posts WHERE id = ?', r.target_id) : db.get<any>('SELECT id, body, author_name, post_id FROM community_comments WHERE id = ?', r.target_id);
            if (!t) return '';
            const link = r.kind === 'post' ? kit.postHref(p, g, t.id) : `${kit.postHref(p, g, t.post_id)}#c-${t.id}`;
            return `<div class="cm-box" style="margin-bottom:10px"><div class="muted small">${r.kind === 'post' ? 'Beitrag' : 'Kommentar'} von ${escapeHtml(t.author_name)} · gemeldet ${relTime(r.created_at)}${r.reason ? ` · „${escapeHtml(r.reason)}“` : ''}</div><p style="margin:6px 0"><a href="${link}"><strong>${escapeHtml(t.title ?? excerptOf(stripMarkdown(t.body), 60))}</strong></a></p><p class="cm-excerpt">${escapeHtml(excerptOf(stripMarkdown(t.body), 220))}</p><div class="cm-modbar" style="gap:12px">${modBtn(`${kit.gHref(p, g)}/mod/report/${encodeURIComponent(r.id)}`, csrf, 'dismiss', 'In Ordnung')}${modBtn(`${kit.gHref(p, g)}/mod/report/${encodeURIComponent(r.id)}`, csrf, 'hide', 'Ausblenden')}${modBtn(`${kit.gHref(p, g)}/mod/report/${encodeURIComponent(r.id)}`, csrf, 'delete', 'Löschen', 'Endgültig löschen?')}</div></div>`;
          })
          .join('');
        const joins = CAN.admin(role) ? db.all<any>(`SELECT m.*, k.first_name, k.last_name, k.email FROM community_memberships m JOIN contacts k ON k.id = m.contact_id WHERE m.group_id = ? AND m.status = 'pending' ORDER BY m.requested_at LIMIT 50`, g.id) : [];
        const page = pageOf(app, g.id);
        const tiers = new Map(tiersOf(app, g.id).map((t) => [t.id, t.name]));
        const joinHtml = joins
          .map((j) => {
            const answers = parseJson(j, ['answers']).answers as Record<string, string>;
            const qa = (page?.questions ?? []).filter((q) => answers[q.id]).map((q) => `<div class="small"><span class="muted">${escapeHtml(q.label)}</span><br>${escapeHtml(answers[q.id])}</div>`).join('');
            return `<div class="cm-box" style="margin-bottom:10px"><strong>${escapeHtml([j.first_name, j.last_name].filter(Boolean).join(' ') || j.email)}</strong> <span class="muted small">· ${escapeHtml(tiers.get(j.tier_id) ?? '')} · ${relTime(j.requested_at)}</span>${qa}<div class="cm-modbar" style="gap:12px;margin-top:8px">${modBtn(`${kit.gHref(p, g)}/mod/join/${encodeURIComponent(j.id)}`, csrf, 'approve', 'Aufnehmen')}${modBtn(`${kit.gHref(p, g)}/mod/join/${encodeURIComponent(j.id)}`, csrf, 'reject', 'Ablehnen', 'Anfrage ablehnen?')}</div></div>`;
          })
          .join('');
        return kit.frame(
          p,
          m,
          `Moderation · ${g.name}`,
          `<div class="crumb"><a href="${kit.gHref(p, g)}">${escapeHtml(g.name)}</a></div><h1>Moderation</h1><p class="muted">Du bist ${role === 'admin' ? 'Admin' : 'Moderator'} in dieser Gruppe.</p>
<h2>Meldungen (${reports.length})</h2>${repHtml || '<div class="cm-box cm-empty">Keine offenen Meldungen. 🎉</div>'}
${CAN.admin(role) ? `<h2>Beitrittsanfragen (${joins.length})</h2>${joinHtml || '<div class="cm-box cm-empty">Keine offenen Anfragen.</div>'}` : ''}`,
        );
      });
    router.get('/portal/:p/community/g/:group/mod', 'public', modPage);

    router.post('/portal/:p/community/g/:group/mod/report/:rid', 'public', (ctx) =>
      kitOf(app).withGroup(ctx, (p, m, g) => {
        const kit = kitOf(app);
        if (!CAN.moderate(roleOfM(g, m))) return kit.errorPage(p, m, 'Das dürfen nur Moderatorinnen, Moderatoren und Admins.', 403);
        const r = db.get<any>('SELECT * FROM community_reports WHERE id = ? AND group_id = ?', ctx.params.rid, g.id);
        if (!r) return kit.errorPage(p, m, 'Meldung nicht gefunden.', 404);
        const action = String(ctx.body?.action ?? '');
        if (!['dismiss', 'hide', 'delete'].includes(action)) return kit.errorPage(p, m, 'Unbekannte Aktion.', 400);
        const table = r.kind === 'post' ? 'community_posts' : 'community_comments';
        const target = db.get<any>(`SELECT * FROM ${table} WHERE id = ?`, r.target_id);
        const settle = (status: string) => db.run(`UPDATE community_reports SET status = ?, action = ?, resolved_at = ?, resolved_by = ? WHERE target_id = ? AND status = 'open'`, status, action, now(), m.contact.first_name || 'Moderation', r.target_id);
        if (action === 'dismiss') {
          settle('dismissed');
          if (target?.status === 'hidden') setHidden(app, r.kind, target, false);
        } else if (action === 'hide') {
          settle('resolved');
          if (target) setHidden(app, r.kind, target, true, 'nach Meldung');
        } else {
          settle('resolved');
          if (target) r.kind === 'post' ? deletePost(app, parseJson(target, ['images'])) : deleteComment(app, target);
        }
        return redirect(`${kit.gHref(p, g)}/mod`, 303);
      }),
    );
    router.post('/portal/:p/community/g/:group/mod/join/:mid', 'public', (ctx) =>
      kitOf(app).withGroup(ctx, async (p, m, g) => {
        const kit = kitOf(app);
        if (!CAN.admin(roleOfM(g, m))) return kit.errorPage(p, m, 'Beitrittsanfragen beantworten nur Admins.', 403);
        const row = membershipById(app, p.locationId, ctx.params.mid);
        if (!row || row.group_id !== g.id) return kit.errorPage(p, m, 'Anfrage nicht gefunden.', 404);
        try {
          const action = String(ctx.body?.action ?? '');
          const by = m.contact.first_name || 'Admin';
          if (action === 'approve') await approveMembership(app, g as any, row, by);
          else if (action === 'reject') {
            if (row.status !== 'pending') throw bad('Diese Anfrage ist nicht mehr offen');
            rejectMembership(app, g as any, row, by);
            const c = getContact(app, p.locationId, row.contact_id);
            if (c?.email) await communityMail(app, p.locationId, c.email, `Dein Beitritt zu „${g.name}“`, [`Leider können wir deine Anfrage für „${g.name}“ im Moment nicht annehmen.`]);
          } else throw bad('Unbekannte Aktion');
        } catch (e) {
          if (e instanceof HttpError) return kit.errorPage(p, m, e.message, e.status);
          throw e;
        }
        return redirect(`${kit.gHref(p, g)}/mod`, 303);
      }),
    );
  },
};
