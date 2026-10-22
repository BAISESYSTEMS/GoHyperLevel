import type { Module } from '../core/app.js';
import { HttpError, type Ctx, type RawResult } from '../core/http.js';
import { escapeHtml } from '../core/template.js';
import { dayOf, statusesOf, team, tzOf } from '../services/pm-core.js';
import type { Member, Portal } from './portal.js';

/**
 * "Meine Projekte" in the member portal (/portal/<id>/projects): the customer sees the boards of projects the
 * agency shared with them – read-only. A project is shown when it is switched to "Im Kundenportal zeigen" and
 * linked to the customer (contact, their company or a deal of theirs). Internal tasks, comments, time,
 * rates and attachments never show here.
 */

type Kit = {
  resolve: (key: string) => Portal | undefined;
  memberOf: (ctx: Ctx, p: Portal) => Member | undefined;
  page: (p: Portal, o: { title: string; body: string; member?: Member; status?: number; head?: string }) => RawResult;
  loginPage: (p: Portal, o?: { error?: string; status?: number; next?: string }) => RawResult;
  notFoundPage: (p: Portal, m?: Member) => RawResult;
  unknownPortal: () => RawResult;
};

const ICON = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="6" height="18" rx="1.5"/><rect x="11" y="3" width="6" height="11" rx="1.5"/><path d="M19 3v6"/></svg>';

const HEAD_CSS = `<style>
.pj-link{color:var(--text);text-decoration:none;font-weight:600;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.pj-link:hover{color:var(--brand)}
.pj-dash{margin-top:34px}.pj-dash h2{display:flex;align-items:center;gap:8px}
.pj-card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px 20px;display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}
.pj-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:18px}
.pj-tile{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px 20px;text-decoration:none;color:inherit;display:flex;flex-direction:column;gap:10px;border-top:4px solid var(--pc,var(--brand))}
.pj-tile:hover{box-shadow:0 14px 34px rgba(15,23,42,.10)}
.pj-tile h2{margin:0;font-size:19px}
.pj-meta{display:flex;justify-content:space-between;font-size:13px;color:var(--muted);gap:10px;flex-wrap:wrap}
.pj-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap;margin-bottom:6px}
.pj-stats{display:flex;gap:26px;flex-wrap:wrap;margin:14px 0 22px}
.pj-stats div{display:flex;flex-direction:column}.pj-stats strong{font-size:22px;line-height:1.1}.pj-stats span{font-size:13px;color:var(--muted)}
.pj-board{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(240px,1fr);gap:14px;overflow-x:auto;padding-bottom:10px;align-items:start}
.pj-col{background:var(--soft);border-radius:14px;padding:10px;min-width:0}
.pj-col h3{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:2px 4px 10px;font-size:14px}
.pj-col h3 i{width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:6px;background:var(--sc,var(--muted))}
.pj-col h3 span{font-weight:500;color:var(--muted);font-size:13px}
.pj-task{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:8px;overflow-wrap:anywhere}
.pj-task strong{display:block;font-weight:600}
.pj-task .m{font-size:12px;color:var(--muted);display:flex;gap:10px;flex-wrap:wrap;margin-top:4px}
.pj-task.done strong{text-decoration:line-through;color:var(--muted)}
.pj-late{color:#dc2626!important;font-weight:600}
.pj-ms{display:flex;gap:10px;align-items:center;padding:10px 0;border-top:1px solid var(--line)}
.pj-ms:first-child{border-top:0}.pj-ms .d{margin-left:auto;font-size:13px;color:var(--muted);white-space:nowrap}
@media (max-width:600px){.pj-link span{display:none}.pj-board{grid-auto-flow:row;grid-auto-columns:auto}}
</style>`;

export const pmPortalModule: Module = {
  name: 'pm-portal',
  register(app) {
    const { db, router } = app;
    const kit = (): Kit => {
      const k = app.services.portalKit;
      if (!k) throw new HttpError(501, 'Mitgliederbereich nicht verfügbar');
      return k;
    };
    const base = (p: Portal) => `${p.base}/projects`;

    /** Projects shown to one customer. */
    const sharedWith = (locationId: string, contactId: string): any[] => {
      const companies: string[] = (app.services.associations?.list?.(locationId, { type: 'contact', id: contactId }, { type: 'company' }) ?? []).map((l: any) => l.record_id);
      const rows = db.all<any>(
        `SELECT p.* FROM pm_projects p LEFT JOIN opportunities o ON o.id = p.opportunity_id
         WHERE p.location_id = ? AND p.portal_visible = 1 AND p.status != 'archived' AND p.is_default = 0
           AND (p.contact_id = ? OR o.contact_id = ? ${companies.length ? `OR p.company_id IN (${companies.map(() => '?').join(',')})` : ''})
         ORDER BY p.name COLLATE NOCASE`,
        locationId,
        contactId,
        contactId,
        ...companies,
      );
      return rows;
    };
    const progressOf = (projectId: string) => {
      // internal tasks and everything below them stay out of the customer's numbers
      const r = db.get<{ total: number; done: number }>(
        `WITH RECURSIVE hidden(id) AS (
           SELECT id FROM tasks WHERE project_id = ? AND internal = 1
           UNION SELECT t.id FROM tasks t JOIN hidden h ON t.parent_id = h.id
         )
         SELECT COUNT(*) AS total, COALESCE(SUM(done), 0) AS done FROM tasks WHERE project_id = ? AND id NOT IN (SELECT id FROM hidden)`,
        projectId,
        projectId,
      )!;
      return { total: Number(r.total), done: Number(r.done), pct: r.total ? Math.round((Number(r.done) / Number(r.total)) * 100) : 0 };
    };
    const day = (p: Portal, iso: string | null) => {
      const d = dayOf(iso, tzOf(app, p.locationId));
      return d ? d.split('-').reverse().join('.') : '';
    };

    // --- portal hooks -------------------------------------------------------------------------------
    app.services.portalHeader = [...(app.services.portalHeader ?? []), (p: Portal, m: Member) => (sharedWith(p.locationId, m.contact.id).length ? `<a class="pj-link" href="${base(p)}" aria-label="Meine Projekte">${ICON}<span>Meine Projekte</span></a>` : '')];
    app.services.portalDashboard = [
      ...(app.services.portalDashboard ?? []),
      (p: Portal, m: Member) => {
        const list = sharedWith(p.locationId, m.contact.id);
        if (!list.length) return '';
        const open = list.map((x) => progressOf(x.id)).reduce((s, x) => s + (x.total - x.done), 0);
        return `<section class="pj-dash"><h2>${ICON} Meine Projekte</h2><div class="pj-card"><div><strong>${list.length} ${list.length === 1 ? 'Projekt' : 'Projekte'}</strong><div class="muted small">${open} ${open === 1 ? 'Aufgabe' : 'Aufgaben'} noch offen</div></div><a class="btn" href="${base(p)}">Projekte ansehen</a></div></section>`;
      },
    ];
    app.services.portalMemberCheck = [...(app.services.portalMemberCheck ?? []), (loc: string, cid: string) => sharedWith(loc, cid).length > 0];
    app.services.portalNextPrefixes = [...(app.services.portalNextPrefixes ?? []), 'projects'];

    const frame = (p: Portal, m: Member, title: string, body: string, status = 200) => kit().page(p, { title, body, member: m, status, head: HEAD_CSS });
    const withMember = (ctx: Ctx, fn: (p: Portal, m: Member) => RawResult) => {
      const k = kit();
      const p = k.resolve(ctx.params.p);
      if (!p) return k.unknownPortal();
      const m = k.memberOf(ctx, p);
      if (!m) return k.loginPage(p, { status: 401, next: ctx.path });
      return fn(p, m);
    };

    router.get('/portal/:p/projects', 'public', (ctx) =>
      withMember(ctx, (p, m) => {
        const list = sharedWith(p.locationId, m.contact.id);
        const tiles = list
          .map((x) => {
            const pr = progressOf(x.id);
            return `<a class="pj-tile" style="--pc:${escapeHtml(x.color)}" href="${base(p)}/${encodeURIComponent(x.id)}"><h2>${escapeHtml(x.name)}</h2>${x.description ? `<div class="muted small">${escapeHtml(String(x.description).slice(0, 160))}</div>` : ''}<div class="bar"><i style="width:${pr.pct}%"></i></div><div class="pj-meta"><span>${pr.done} von ${pr.total} Aufgaben erledigt</span>${x.due_at ? `<span>bis ${day(p, x.due_at)}</span>` : ''}</div></a>`;
          })
          .join('');
        return frame(p, m, 'Meine Projekte', `<div class="crumb"><a href="${p.base}">Start</a></div><h1>Meine Projekte</h1><p class="muted" style="margin:0 0 20px">So weit sind deine Projekte – immer aktuell.</p>${tiles ? `<div class="pj-grid">${tiles}</div>` : '<div class="panel empty"><h2>Noch kein Projekt freigegeben</h2><p class="muted">Sobald wir ein Projekt mit dir teilen, siehst du es hier.</p></div>'}`);
      }),
    );

    router.get('/portal/:p/projects/:id', 'public', (ctx) =>
      withMember(ctx, (p, m) => {
        const proj = sharedWith(p.locationId, m.contact.id).find((x) => x.id === ctx.params.id);
        if (!proj) return kit().notFoundPage(p, m);
        const tz = tzOf(app, p.locationId);
        const today = new Date().toISOString();
        const statuses = statusesOf(app, proj.id);
        const names = new Map(team(app, p.locationId).map((u) => [u.id, u.name.split(' ')[0]]));
        const tasks = db.all<any>('SELECT * FROM tasks WHERE project_id = ? AND internal = 0 AND parent_id IS NULL ORDER BY position, created_at LIMIT 500', proj.id);
        const subs = new Map(db.all<any>('SELECT parent_id, COUNT(*) AS n, COALESCE(SUM(done), 0) AS d FROM tasks WHERE project_id = ? AND internal = 0 AND parent_id IS NOT NULL GROUP BY parent_id', proj.id).map((r) => [r.parent_id, r]));
        const assignee = new Map<string, string[]>();
        for (const r of db.all<any>('SELECT a.task_id, a.user_id FROM pm_assignees a JOIN tasks t ON t.id = a.task_id WHERE t.project_id = ?', proj.id)) assignee.set(r.task_id, [...(assignee.get(r.task_id) ?? []), r.user_id]);
        const pr = progressOf(proj.id);
        const late = (t: any) => !t.done && t.due_at && (dayOf(t.due_at, tz) ?? '9999') < (dayOf(today, tz) ?? '');
        const card = (t: any) => {
          const s = subs.get(t.id);
          const who = (assignee.get(t.id) ?? []).map((u) => names.get(u)).filter(Boolean).join(', ');
          return `<div class="pj-task${t.done ? ' done' : ''}"><strong>${t.milestone ? '◆ ' : ''}${escapeHtml(t.title)}</strong><div class="m">${t.due_at ? `<span class="${late(t) ? 'pj-late' : ''}">${t.milestone ? 'am' : 'bis'} ${day(p, t.due_at)}</span>` : ''}${s ? `<span>${s.d}/${s.n} Unteraufgaben</span>` : ''}${who ? `<span>${escapeHtml(who)}</span>` : ''}</div></div>`;
        };
        const cols = statuses
          .map((st) => {
            const list = tasks.filter((t) => t.status_id === st.id);
            return `<div class="pj-col" style="--sc:${escapeHtml(st.color)}"><h3><span style="color:var(--text)"><i></i>${escapeHtml(st.name)}</span><span>${list.length}</span></h3>${list.map(card).join('') || '<div class="muted small" style="padding:4px 6px">Nichts</div>'}</div>`;
          })
          .join('');
        const milestones = tasks
          .filter((t) => t.milestone)
          .sort((a, b) => String(a.due_at ?? '9999').localeCompare(String(b.due_at ?? '9999')))
          .map((t) => `<div class="pj-ms"><span>${t.done ? '✓' : '◆'}</span><span${t.done ? ' style="text-decoration:line-through;color:var(--muted)"' : ''}>${escapeHtml(t.title)}</span><span class="d${late(t) ? ' pj-late' : ''}">${t.due_at ? day(p, t.due_at) : ''}</span></div>`)
          .join('');
        return frame(
          p,
          m,
          proj.name,
          `<div class="crumb"><a href="${p.base}">Start</a> / <a href="${base(p)}">Meine Projekte</a></div>
<div class="pj-head"><div><h1>${escapeHtml(proj.name)}</h1>${proj.description ? `<p class="muted" style="margin:4px 0 0;max-width:720px">${escapeHtml(String(proj.description).slice(0, 600))}</p>` : ''}</div></div>
<div class="pj-stats"><div><strong>${pr.pct} %</strong><span>erledigt</span></div><div><strong>${pr.done}/${pr.total}</strong><span>Aufgaben</span></div>${proj.due_at ? `<div><strong>${day(p, proj.due_at)}</strong><span>Zieltermin</span></div>` : ''}</div>
<div class="bar" style="margin-bottom:22px"><i style="width:${pr.pct}%"></i></div>
${milestones ? `<section class="panel" style="margin-bottom:22px"><h2>Meilensteine</h2>${milestones}</section>` : ''}
<div class="pj-board">${cols}</div>`,
        );
      }),
    );

  },
};
