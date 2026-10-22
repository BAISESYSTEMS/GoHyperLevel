import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, redirect } from '../core/http.js';
import { escapeHtml } from '../core/template.js';
import { getGroup } from '../services/community.js';
import { extOf, saveExt } from '../services/community-ext.js';
import {
  BROADCAST_CHANNELS,
  analytics,
  checklistOf,
  cleanBroadcast,
  cleanSegment,
  markChecklist,
  runDueBroadcasts,
  segmentContacts,
  segmentSql,
  sendBroadcast,
  welcomeMember,
} from '../services/community-growth.js';
import { communityUi, kitOf } from '../services/community-ui.js';
import { getContact } from '../services/contacts.js';

/**
 * Growth: analytics, the welcome of new members (message, post, checklist, "Start here"), broadcasts to a segment by e-mail, push
 * and bell, the filter "member of community X" for contact lists and campaigns, and partner links for members. Rules and numbers:
 * services/community-growth.ts.
 */

const CSS = `<style>
.cm-onb{border-left:4px solid var(--brand)}.cm-onb h3{margin:0 0 4px}.cm-onb ul{list-style:none;margin:10px 0 0;padding:0}
.cm-onb li{display:flex;gap:10px;align-items:center;min-height:44px;border-top:1px solid var(--line)}.cm-onb li:first-child{border-top:0}
.cm-onb li .ck{width:24px;height:24px;border-radius:50%;border:2px solid var(--line);display:grid;place-items:center;flex:none;font-size:14px;color:#fff}
.cm-onb li.done .ck{background:#22c55e;border-color:#22c55e}.cm-onb li.done a,.cm-onb li.done span.t{text-decoration:line-through;color:var(--muted)}
.cm-onb li a,.cm-onb li span.t{flex:1;color:inherit;text-decoration:none;font-weight:500;padding:8px 0}.cm-onb li a:hover{color:var(--brand)}
.cm-onb li form{margin:0}.cm-onb .x{background:none;border:0;color:var(--muted);cursor:pointer;min-height:44px;min-width:44px;font-size:13px}
.cm-start{display:flex;gap:14px;align-items:center;flex-wrap:wrap;background:linear-gradient(135deg,var(--brand),#7c3aed);color:#fff;border-radius:16px;padding:16px 20px;border:0}
.cm-start .grow{flex:1;min-width:200px}.cm-start a.btn{background:#fff;color:#111;border-color:#fff}
.cm-start strong{font-size:17px}.cm-start .muted{color:rgba(255,255,255,.85)}
</style>`;

export const communityGrowthModule: Module = {
  name: 'community-growth',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE community_welcome (
        group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        sent_at TEXT NOT NULL, PRIMARY KEY (group_id, contact_id)
      );
      CREATE TABLE community_checklist (
        group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL, done_at TEXT NOT NULL, PRIMARY KEY (group_id, contact_id, item_id)
      );
      CREATE TABLE community_broadcasts (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
        subject TEXT NOT NULL, body TEXT NOT NULL, channels TEXT NOT NULL DEFAULT '[]', segment TEXT NOT NULL DEFAULT '{}',
        recipients INTEGER NOT NULL DEFAULT 0, campaign_id TEXT, push_devices INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'sent', scheduled_at TEXT, created_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, sent_at TEXT
      );
      CREATE INDEX community_broadcasts_group ON community_broadcasts(group_id, created_at);
      CREATE TABLE community_broadcast_queue (broadcast_id TEXT PRIMARY KEY REFERENCES community_broadcasts(id) ON DELETE CASCADE, due_at TEXT NOT NULL);
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
      return g as unknown as { id: string; location_id: string; name: string; slug: string; [k: string]: any };
    };

    // --- contact lists and campaigns: "member of community X" ----------------------------------------------------------------
    app.services.contactFilters = [
      ...(app.services.contactFilters ?? []),
      (f: any) => {
        const q = f?.query;
        const x = f?.extra ?? {};
        const gid = String(x.community_group ?? q?.get?.('community_group') ?? '');
        if (!gid) return undefined;
        const seg = x.community_segment ?? {
          min_level: Number(q?.get?.('community_min_level') ?? 0) || undefined,
          active_days: Number(q?.get?.('community_active_days') ?? 0) || undefined,
          inactive_days: Number(q?.get?.('community_inactive_days') ?? 0) || undefined,
        };
        // The group must belong to the same sub-account as the contacts (the subquery matches contacts.location_id).
        return segmentSql(app, gid, seg && typeof seg === 'object' ? seg : {});
      },
    ];

    // --- the welcome ------------------------------------------------------------------------------------------------------------
    app.events.on('community.member_joined', (e) => {
      const g = e.data.groupId ? getGroup(app, e.locationId, String(e.data.groupId)) : undefined;
      if (g && e.data.contactId) welcomeMember(app, g, String(e.data.contactId));
    });

    // --- admin API: analytics ----------------------------------------------------------------------------------------------------
    router.get('/api/community/groups/:id/analytics', 'location', (ctx) => analytics(app, mustGroup(ctx.locationId, ctx.params.id), Number(ctx.query.get('days') ?? 30)));
    router.get('/api/community/overview', 'location', (ctx) => {
      const days = Number(ctx.query.get('days') ?? 30);
      return db.all<any>(`SELECT * FROM community_groups WHERE location_id = ? AND status = 'active' ORDER BY position, created_at`, ctx.locationId).map((g) => {
        const a = analytics(app, g, days);
        return { group_id: g.id, name: g.name, members: a.totals.members, new_in_range: a.totals.new_in_range, mrr_cents: a.revenue.mrr_cents, currency: a.revenue.currency, dau_avg: a.totals.dau_avg, engagement_rate: a.totals.engagement_rate, pending_requests: a.requests.pending };
      });
    });

    // --- admin API: broadcasts ----------------------------------------------------------------------------------------------------
    const broadcastOut = (b: any) => ({ ...b, channels: JSON.parse(b.channels || '[]'), segment: JSON.parse(b.segment || '{}') });
    router.get('/api/community/groups/:id/broadcasts', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      return { channels: BROADCAST_CHANNELS, broadcasts: db.all<any>('SELECT * FROM community_broadcasts WHERE group_id = ? ORDER BY created_at DESC LIMIT 100', g.id).map(broadcastOut) };
    });
    router.post('/api/community/groups/:id/broadcasts/preview', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      const people = segmentContacts(app, g, cleanSegment(app, g, ctx.body?.segment));
      const raw = app.services.contactPushRaw as { devices(loc: string, cid: string): number } | undefined;
      return { members: people.length, email: people.filter((p) => p.email && !p.dnd).length, push: raw ? people.filter((p) => raw.devices(g.location_id, p.id) > 0).length : 0 };
    });
    router.post('/api/community/groups/:id/broadcasts', 'location', async (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      const input = cleanBroadcast(app, g, ctx.body);
      const r = await sendBroadcast(app, g, input, ctx.user?.name ?? 'Team');
      return r;
    });
    router.delete('/api/community/broadcasts/:bid', 'location', (ctx) => {
      const b = db.get<any>('SELECT * FROM community_broadcasts WHERE id = ? AND location_id = ?', ctx.params.bid, ctx.locationId);
      if (!b) throw notFound('Rundschreiben nicht gefunden');
      if (b.status !== 'scheduled') throw bad('Nur geplante Rundschreiben lassen sich zurücknehmen');
      db.run('DELETE FROM community_broadcast_queue WHERE broadcast_id = ?', b.id);
      if (b.campaign_id) db.run(`UPDATE campaigns SET status = 'draft' WHERE id = ? AND status = 'scheduled'`, b.campaign_id);
      db.run(`UPDATE community_broadcasts SET status = 'canceled' WHERE id = ?`, b.id);
      return { ok: true };
    });
    app.onTick(async () => void (await runDueBroadcasts(app)));

    // --- admin API: partner program of a community ----------------------------------------------------------------------------------
    const kit = () => app.services.affiliateKit as
      | { programOf(pid: string, loc: string): any; forContact(pid: string, cid: string): any; signUp(p: any, i: { name: string; email: string }): any; linkOf(p: any, a: any): string; statsOf(aid: string): any; portalUrl(p: any): string }
      | undefined;
    router.get('/api/community/groups/:id/affiliate', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      const pid = extOf(app, g.id).affiliate.program_id;
      const p = pid ? kit()?.programOf(pid, g.location_id) : undefined;
      return {
        program: p ? { id: p.id, name: p.name, commission_type: p.commission_type, commission_value: p.commission_value, landing_url: p.landing_url, active: !!p.active, signup_url: `${kit()?.portalUrl(p)}/join`, affiliates: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM affiliates WHERE program_id = ?', p.id)!.n } : null,
        programs: db.all<any>('SELECT id, name, commission_type, commission_value, active FROM affiliate_programs WHERE location_id = ? ORDER BY name', g.location_id),
        landing_url: `${app.baseUrl()}/c/${db.get<{ slug: string }>('SELECT slug FROM community_pages WHERE group_id = ?', g.id)?.slug ?? ''}`,
      };
    });
    /** Links the group to a program and points the program's links at the community's public page. */
    router.put('/api/community/groups/:id/affiliate', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      const pid = String(ctx.body?.program_id ?? '');
      if (pid) {
        const p = kit()?.programOf(pid, g.location_id);
        if (!p) throw notFound('Partnerprogramm nicht gefunden');
        const page = db.get<{ slug: string }>('SELECT slug FROM community_pages WHERE group_id = ? AND enabled = 1', g.id);
        if (ctx.body?.point_links && page) db.run('UPDATE affiliate_programs SET landing_url = ? WHERE id = ?', `${app.baseUrl()}/c/${page.slug}`, p.id);
      }
      saveExt(app, g, { ...extOf(app, g.id), affiliate: { program_id: pid } });
      return { program_id: pid };
    });

    // --- member pages: checklist, "Start here", partner ----------------------------------------------------------------------------
    ui.feedTop.push((p, m, g) => {
      const k = kitOf(app);
      const gh = k.gHref(p, g);
      const ext = extOf(app, g.id);
      const parts: string[] = [];
      const sp = ext.start_here.post_id ? db.get<{ id: string; title: string; status: string }>('SELECT id, title, status FROM community_posts WHERE id = ? AND group_id = ?', ext.start_here.post_id, g.id) : undefined;
      if (sp && sp.status === 'visible' && !db.get('SELECT 1 FROM community_reads WHERE post_id = ? AND contact_id = ?', sp.id, m.contact.id)) {
        parts.push(`<div class="cm-box cm-start"><span style="font-size:30px" aria-hidden="true">📌</span><div class="grow"><strong>${escapeHtml(ext.start_here.label)}</strong><div class="muted small">${escapeHtml(sp.title)}</div></div><a class="btn" href="${k.postHref(p, g, sp.id)}">Los geht’s</a></div>`);
      }
      const cl = checklistOf(app, g, m.contact.id, { profile: `${k.cbase(p)}/profile`, compose: `${gh}#schreiben`, start: sp ? k.postHref(p, g, sp.id) : gh, challenges: `${gh}/challenges`, feed: gh });
      if (cl && cl.window_open && !cl.dismissed && cl.done < cl.total) {
        const csrf = k.tokenInput(m);
        parts.push(`<div class="cm-box cm-onb"><div class="cm-row"><h3 class="grow">So startest du <span class="muted small">· ${cl.done} von ${cl.total}</span></h3><form method="post" action="${gh}/checklist/dismiss">${csrf}<button class="x" title="Checkliste ausblenden" aria-label="Checkliste ausblenden">Ausblenden</button></form></div><div class="bar"><i style="width:${Math.round((cl.done / cl.total) * 100)}%"></i></div><ul>${cl.items
          .map((it) => `<li class="${it.done ? 'done' : ''}"><span class="ck" aria-hidden="true">${it.done ? '✓' : ''}</span>${it.kind === 'custom' ? (it.done ? `<span class="t">${escapeHtml(it.label)}</span>` : `<form method="post" action="${gh}/checklist/${encodeURIComponent(it.id)}/done" style="flex:1">${csrf}<button class="cm-link" style="background:none;border:0;padding:8px 0;font:inherit;text-align:left;cursor:pointer;min-height:44px;font-weight:500;color:inherit">${escapeHtml(it.label)} – erledigt</button></form>`) : it.done ? `<span class="t">${escapeHtml(it.label)}</span>` : `<a href="${escapeHtml(it.href)}">${escapeHtml(it.label)}</a>`}</li>`)
          .join('')}</ul></div>`);
      }
      return parts.join('');
    });
    router.post('/portal/:p/community/g/:group/checklist/dismiss', 'public', (ctx) =>
      kitOf(app).withGroup(ctx, (p, m, g) => {
        markChecklist(app, g as any, m.contact.id, '_dismiss');
        return redirect(kitOf(app).gHref(p, g), 303);
      }),
    );
    router.post('/portal/:p/community/g/:group/checklist/:item/done', 'public', (ctx) =>
      kitOf(app).withGroup(ctx, (p, m, g) => {
        const it = extOf(app, g.id).welcome.checklist.items.find((x) => x.id === ctx.params.item && x.kind === 'custom');
        if (!it) return kitOf(app).errorPage(p, m, 'Diesen Punkt gibt es nicht.', 404);
        markChecklist(app, g as any, m.contact.id, it.id);
        return redirect(kitOf(app).gHref(p, g), 303);
      }),
    );

    const partnerProgram = (g: any) => {
      const pid = extOf(app, g.id).affiliate.program_id;
      const p = pid ? kit()?.programOf(pid, g.location_id) : undefined;
      return p && p.active ? p : undefined;
    };
    ui.tabs.push((p, _m, g) => (partnerProgram(g) ? [{ key: 'partner', href: `${kitOf(app).gHref(p, g)}/partner`, label: '🤝 Partner' }] : []));
    const money = (c: number, cur = 'EUR') => new Intl.NumberFormat('de-DE', { style: 'currency', currency: cur }).format(c / 100);
    const partnerPage = (ctx: any, flash = '') =>
      kitOf(app).withGroup(ctx, (p, m, g) => {
        const k = kitOf(app);
        const prog = partnerProgram(g);
        if (!prog) return k.errorPage(p, m, 'Hier gibt es kein Partnerprogramm.', 404);
        const aff = kit()!.forContact(prog.id, m.contact.id);
        const s = aff ? kit()!.statsOf(aff.id) : undefined;
        const terms = prog.commission_type === 'fixed' ? `${money(prog.commission_value)} pro Verkauf` : `${prog.commission_value} % Provision`;
        const body = !aff
          ? `<p>Empfiehl diese Community weiter und verdiene mit: <strong>${escapeHtml(terms)}</strong>${prog.recurring ? ' – auch bei jeder Folgezahlung' : ''}.</p>${prog.terms ? `<p class="muted small" style="white-space:pre-wrap">${escapeHtml(prog.terms)}</p>` : ''}<form method="post" action="${k.gHref(p, g)}/partner">${k.tokenInput(m)}<label class="cm-check" style="margin:8px 0"><input type="checkbox" name="accept" value="1" required> Ich akzeptiere die Bedingungen des Partnerprogramms.</label><button class="btn">Partner werden</button></form>`
          : aff.status !== 'active'
            ? '<p><strong>Deine Anmeldung wird geprüft.</strong> Sobald sie freigegeben ist, zählen deine Klicks und Verkäufe.</p>'
            : `<p>Dein persönlicher Link – jeder, der darüber beitritt und kauft, bringt dir Provision (<strong>${escapeHtml(terms)}</strong>).</p><input class="cm-in" readonly value="${escapeHtml(kit()!.linkOf(prog, aff))}" aria-label="Dein Partner-Link" onfocus="this.select()" style="width:100%">
<div class="cm-pr" style="margin-top:14px"><div><b>${s?.clicks ?? 0}</b><span class="muted small">Klicks</span></div><div><b>${s?.leads ?? 0}</b><span class="muted small">Anmeldungen</span></div><div><b>${s?.sales ?? 0}</b><span class="muted small">Verkäufe</span></div><div><b>${money((s?.pending_cents ?? 0) + (s?.approved_cents ?? 0))}</b><span class="muted small">offen</span></div><div><b>${money(s?.paid_cents ?? 0)}</b><span class="muted small">ausgezahlt</span></div></div>
<p style="margin-top:14px"><a class="btn ghost" href="${escapeHtml(kit()!.portalUrl(prog))}" target="_blank" rel="noopener noreferrer">Auszahlung &amp; Details im Partnerbereich</a></p>`;
        return k.frame(p, m, `Partner · ${g.name}`, `${k.groupHead(p, g)}${k.groupTabs(p, m, g, 'partner')}<div class="cm-box" style="max-width:720px"><h2 style="margin-top:0">Partner-Programm</h2>${flash ? `<div class="cm-ok">${escapeHtml(flash)}</div>` : ''}${body}</div>`);
      });
    router.get('/portal/:p/community/g/:group/partner', 'public', (ctx) => partnerPage(ctx));
    router.post('/portal/:p/community/g/:group/partner', 'public', (ctx) =>
      kitOf(app).withGroup(ctx, (p, m, g) => {
        const k = kitOf(app);
        const prog = partnerProgram(g);
        if (!prog) return k.errorPage(p, m, 'Hier gibt es kein Partnerprogramm.', 404);
        if (!ctx.body?.accept) return k.errorPage(p, m, 'Bitte bestätige die Bedingungen.', 400);
        if (!kit()!.forContact(prog.id, m.contact.id)) {
          const c = getContact(app, g.location_id, m.contact.id)!;
          try {
            kit()!.signUp(prog, { name: [c.first_name, c.last_name].filter(Boolean).join(' '), email: c.email });
          } catch (e) {
            return k.errorPage(p, m, (e as Error).message, e instanceof HttpError ? e.status : 400);
          }
        }
        return redirect(`${k.gHref(p, g)}/partner`, 303);
      }),
    );
  },
};
