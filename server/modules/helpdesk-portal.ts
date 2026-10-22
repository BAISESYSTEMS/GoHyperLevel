import type { Module } from '../core/app.js';
import { HttpError, redirect, type Ctx, type RawResult } from '../core/http.js';
import { escapeHtml } from '../core/template.js';
import { formatInTz } from '../core/time.js';
import { safeEqual, sha256 } from '../core/util.js';
import { addCustomerMessage, createTicket, getTicketRow, loadHelpdeskSettings, sendAutoReply, ticketOut } from '../services/tickets.js';
import type { Member, Portal } from './portal.js';

/**
 * "Meine Anfragen" in the member portal (/portal/<id>/tickets): members see their tickets with
 * status, open new ones, read the team's answers and reply. Internal notes, assignments and SLA
 * details never show here. Plugs into the portal through app.services.portalKit and its hooks.
 */

type Kit = {
  resolve: (key: string) => Portal | undefined;
  memberOf: (ctx: Ctx, p: Portal) => Member | undefined;
  page: (p: Portal, o: { title: string; body: string; member?: Member; status?: number; head?: string }) => RawResult;
  loginPage: (p: Portal, o?: { error?: string; status?: number; next?: string }) => RawResult;
  notFoundPage: (p: Portal, m?: Member) => RawResult;
  unknownPortal: () => RawResult;
  sameOrigin: (ctx: Ctx) => boolean;
};

const ICON_INBOX = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>';

const HEAD_CSS = `<style>
.hd-link{color:var(--text);text-decoration:none;font-weight:600;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.hd-link:hover{color:var(--brand)}
.hd-dash{margin-top:34px}.hd-dash h2{display:flex;align-items:center;gap:8px}
.hd-card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px 20px;display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}
.hd-grid{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:24px;align-items:start}
.hd-list{padding:0;overflow:hidden}
.hd-row{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:14px 20px;border-top:1px solid var(--line);text-decoration:none;color:inherit}
.hd-row:first-child{border-top:0}.hd-row:hover{background:var(--soft)}
.hd-row .t{min-width:0}.hd-row strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hd-row .m{font-size:13px;color:var(--muted)}
.st{display:inline-flex;font-size:12px;font-weight:700;padding:3px 10px;border-radius:99px;white-space:nowrap;background:var(--soft);color:var(--brand)}
.st.waiting{background:rgba(217,119,6,.14);color:#b45309}.st.resolved,.st.closed{background:rgba(5,150,105,.14);color:var(--ok)}
.hd-form label{display:block;font-weight:600;font-size:14px;margin:12px 0 6px}
.hd-form input,.hd-form select,.hd-form textarea{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:10px;font:inherit;background:var(--panel);color:var(--text)}
.hd-form textarea{min-height:130px;resize:vertical}
.hd-form input:focus,.hd-form select:focus,.hd-form textarea:focus{outline:2px solid var(--brand);outline-offset:0;border-color:transparent}
.hd-form .btn{margin-top:14px}
.thread{display:flex;flex-direction:column;gap:12px;margin:18px 0}
.msg{max-width:86%;border:1px solid var(--line);border-radius:14px;padding:12px 16px;background:var(--panel);white-space:pre-wrap;word-break:break-word}
.msg.me{align-self:flex-end;background:var(--soft);border-color:transparent}
.msg .who{display:flex;justify-content:space-between;gap:12px;font-size:13px;color:var(--muted);margin-bottom:4px;white-space:normal}.msg .who span:last-child{white-space:nowrap}
.sys{align-self:center;font-size:13px;color:var(--muted)}
.hd-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap}
@media (max-width:900px){.hd-grid{grid-template-columns:1fr}}
@media (max-width:560px){.hd-link span{display:none}.msg{max-width:100%}.hd-row{padding:12px 14px}}
</style>`;

const KIND_LABEL: Record<string, string> = { new: 'Neu', open: 'In Bearbeitung', waiting: 'Wartet auf dich', resolved: 'Gelöst', closed: 'Geschlossen' };

export const helpdeskPortalModule: Module = {
  name: 'helpdesk-portal',
  register(app) {
    const { db, router } = app;
    const kit = (): Kit => {
      const k = app.services.portalKit;
      if (!k) throw new HttpError(501, 'Mitgliederbereich nicht verfügbar');
      return k;
    };
    const enabled = (loc: string) => loadHelpdeskSettings(app, loc).portal.enabled;
    const base = (p: Portal) => `${p.base}/tickets`;
    const csrf = (m: Member) => sha256(`${app.config.secret}:helpdesk-form:${m.sessionHash}`).slice(0, 32);
    const tokenInput = (m: Member) => `<input type="hidden" name="csrf" value="${csrf(m)}">`;
    const tz = (p: Portal) => p.loc.timezone || 'Europe/Berlin';
    const when = (p: Portal, iso: string) => escapeHtml(formatInTz(iso, tz(p), { weekday: undefined }));
    const pill = (kind: string, label?: string) => `<span class="st ${escapeHtml(kind)}">${escapeHtml(label || KIND_LABEL[kind] || kind)}</span>`;
    const statusLabel = (t: any) => (t.status_kind === 'waiting' ? KIND_LABEL.waiting : t.status || KIND_LABEL[t.status_kind]);
    const mine = (p: Portal, m: Member) =>
      db
        .all(`SELECT * FROM tickets WHERE location_id = ? AND contact_id = ? AND merged_into IS NULL ORDER BY (status_kind IN ('new','open','waiting')) DESC, updated_at DESC LIMIT 200`, p.locationId, m.contact.id)
        .map((t) => ticketOut(app, t));

    const frame = (p: Portal, m: Member, title: string, body: string, status = 200) => kit().page(p, { title, body, member: m, status, head: HEAD_CSS });

    // --- portal hooks ----------------------------------------------------------------------------
    app.services.portalHeader = [
      ...(app.services.portalHeader ?? []),
      (p: Portal) => (enabled(p.locationId) ? `<a class="hd-link" href="${base(p)}" aria-label="Meine Anfragen">${ICON_INBOX}<span>Meine Anfragen</span></a>` : ''),
    ];
    app.services.portalDashboard = [
      ...(app.services.portalDashboard ?? []),
      (p: Portal, m: Member) => {
        // Only for members who already wrote to us – a course-only portal keeps its own start page (the top link stays).
        if (!enabled(p.locationId) || !db.get('SELECT 1 FROM tickets WHERE location_id = ? AND contact_id = ? LIMIT 1', p.locationId, m.contact.id)) return '';
        const open = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tickets WHERE location_id = ? AND contact_id = ? AND status_kind IN ('new','open','waiting') AND merged_into IS NULL`, p.locationId, m.contact.id)!.n;
        const waiting = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tickets WHERE location_id = ? AND contact_id = ? AND status_kind = 'waiting' AND merged_into IS NULL`, p.locationId, m.contact.id)!.n;
        return `<section class="hd-dash"><h2>${ICON_INBOX} Meine Anfragen</h2><div class="hd-card"><div>${open ? `<strong>${open} offene ${open === 1 ? 'Anfrage' : 'Anfragen'}</strong>${waiting ? `<div class="muted small">${waiting} ${waiting === 1 ? 'wartet' : 'warten'} auf deine Antwort</div>` : ''}` : '<strong>Alle Anfragen erledigt</strong><div class="muted small">Neue Frage oder ein Problem? Schreib uns jederzeit.</div>'}</div><a class="btn" href="${base(p)}">${open ? 'Anfragen ansehen' : 'Anfrage stellen'}</a></div></section>`;
      },
    ];
    app.services.portalMemberCheck = [
      ...(app.services.portalMemberCheck ?? []),
      (loc: string, cid: string) => {
        const s = loadHelpdeskSettings(app, loc).portal;
        if (!s.enabled) return false;
        return s.any_contact || !!db.get('SELECT 1 FROM tickets WHERE location_id = ? AND contact_id = ? LIMIT 1', loc, cid);
      },
    ];
    app.services.portalNextPrefixes = [...(app.services.portalNextPrefixes ?? []), 'tickets'];

    // --- helpers ---------------------------------------------------------------------------------
    const withMember = (ctx: Ctx, fn: (p: Portal, m: Member) => RawResult | Promise<RawResult>) => {
      const k = kit();
      const p = k.resolve(ctx.params.p);
      if (!p) return k.unknownPortal();
      const m = k.memberOf(ctx, p);
      if (!m) return ctx.method === 'GET' ? k.loginPage(p, { status: 401, next: ctx.path }) : redirect(p.base, 303);
      if (!enabled(p.locationId)) return k.notFoundPage(p, m);
      if (ctx.method !== 'GET' && (!k.sameOrigin(ctx) || !safeEqual(ctx.body?.csrf, csrf(m)))) return frame(p, m, 'Hinweis', `<div class="panel empty"><h1>Bitte neu laden</h1><p class="muted">Die Seite war zu lange offen. Bitte neu laden und noch einmal senden.</p><a class="btn" href="${base(p)}">Zu meinen Anfragen</a></div>`, 403);
      return fn(p, m);
    };
    const ticketOf = (p: Portal, m: Member, n: string) => {
      if (!/^\d{1,9}$/.test(n)) return undefined;
      const row = db.get('SELECT id FROM tickets WHERE location_id = ? AND contact_id = ? AND number = ?', p.locationId, m.contact.id, Number(n));
      const t = row ? getTicketRow(app, p.locationId, row.id) : undefined;
      return t?.merged_into ? getTicketRow(app, p.locationId, t.merged_into) : t;
    };

    const newForm = (p: Portal, m: Member, err = '', v: { subject?: string; body?: string; category?: string } = {}) => {
      const cats = loadHelpdeskSettings(app, p.locationId).categories;
      return `<section class="panel hd-form"><h2>Neue Anfrage</h2><form method="post" action="${base(p)}">${tokenInput(m)}
<label for="s">Betreff</label><input id="s" name="subject" maxlength="200" required value="${escapeHtml(v.subject ?? '')}" placeholder="Worum geht es?">
${cats.length ? `<label for="k">Thema</label><select id="k" name="category"><option value="">Bitte wählen…</option>${cats.map((c) => `<option${v.category === c ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('')}</select>` : ''}
<label for="b">Nachricht</label><textarea id="b" name="body" maxlength="20000" required placeholder="Beschreib dein Anliegen so genau wie möglich.">${escapeHtml(v.body ?? '')}</textarea>
${err ? `<p class="err" style="color:#dc2626">${escapeHtml(err)}</p>` : ''}<button class="btn wide">Anfrage senden</button></form></section>`;
    };

    const listPage = (p: Portal, m: Member, err = '', v = {}) => {
      const list = mine(p, m);
      const rows = list
        .map((t) => `<a class="hd-row" href="${base(p)}/${t.number}"><div class="t"><strong>${escapeHtml(t.subject)}</strong><div class="m">#${t.number} · aktualisiert ${when(p, t.updated_at)}</div></div>${pill(t.status_kind, statusLabel(t))}</a>`)
        .join('');
      return frame(
        p,
        m,
        'Meine Anfragen',
        `<div class="crumb"><a href="${p.base}">Start</a></div><h1>Meine Anfragen</h1><p class="muted" style="margin:0 0 20px">Hier siehst du alle deine Anfragen und unsere Antworten.</p>
<div class="hd-grid"><section class="panel hd-list">${rows || '<div class="empty"><h2>Noch keine Anfragen</h2><p class="muted">Sobald du uns schreibst, siehst du hier den Stand.</p></div>'}</section>${newForm(p, m, err, v)}</div>`,
      );
    };

    const PUBLIC_EVENTS = ['created', 'reply', 'auto_reply', 'customer_reply', 'status'];
    const detailPage = (p: Portal, m: Member, t: any, notice = '') => {
      const out = ticketOut(app, t);
      const events = db.all(`SELECT e.*, u.name AS user_name FROM ticket_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.ticket_id = ? AND e.type IN (${PUBLIC_EVENTS.map(() => '?').join(',')}) ORDER BY e.created_at, e.rowid`, t.id, ...PUBLIC_EVENTS);
      const team = escapeHtml(p.name);
      const items = events
        .map((e) => {
          const data = JSON.parse(e.data || '{}');
          if (e.type === 'created') return `<div class="msg me"><div class="who"><span>Du</span><span>${when(p, e.created_at)}</span></div>${escapeHtml(e.body || t.subject)}</div>`;
          if (e.type === 'customer_reply') return data.origin ? '' : `<div class="msg me"><div class="who"><span>Du</span><span>${when(p, e.created_at)}</span></div>${escapeHtml(e.body)}</div>`;
          if (e.type === 'reply' || e.type === 'auto_reply') return data.status === 'failed' ? '' : `<div class="msg"><div class="who"><span>${e.user_name ? `${escapeHtml(e.user_name)} · ${team}` : team}</span><span>${when(p, e.created_at)}</span></div>${escapeHtml(e.body.replace(/<[^>]+>/g, ''))}</div>`;
          if (e.type === 'status') return `<div class="sys">Status: ${escapeHtml(String(e.body).split('→').pop()?.trim() ?? '')} · ${when(p, e.created_at)}</div>`;
          return '';
        })
        .join('');
      const done = t.status_kind === 'resolved' || t.status_kind === 'closed';
      const csat = done && t.csat_score == null && app.services.csatLink ? `<p class="muted small">Wie zufrieden warst du? <a href="${escapeHtml(app.services.csatLink(t.id))}">Kurz bewerten</a></p>` : '';
      const reply =
        t.status_kind === 'closed'
          ? `<div class="panel"><p class="muted" style="margin:0">Diese Anfrage ist geschlossen. Hast du ein neues Anliegen? <a href="${base(p)}">Neue Anfrage stellen</a></p>${csat}</div>`
          : `<section class="panel hd-form"><h2>${done ? 'Noch etwas offen?' : 'Antworten'}</h2>${done ? '<p class="muted small" style="margin:0">Diese Anfrage ist gelöst. Wenn du antwortest, öffnen wir sie wieder.</p>' : ''}${csat}
<form method="post" action="${base(p)}/${t.number}/reply">${tokenInput(m)}<label for="r">Deine Nachricht</label><textarea id="r" name="body" maxlength="20000" required></textarea><button class="btn">Senden</button></form></section>`;
      return frame(
        p,
        m,
        `Anfrage #${t.number}`,
        `${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ''}<div class="crumb"><a href="${p.base}">Start</a> / <a href="${base(p)}">Meine Anfragen</a></div>
<div class="hd-head"><div><h1>${escapeHtml(t.subject)}</h1><div class="muted small">Anfrage #${t.number} · erstellt ${when(p, t.created_at)}</div></div>${pill(t.status_kind, statusLabel(out))}</div>
<div class="thread">${items}</div>${reply}`,
      );
    };

    // --- routes ------------------------------------------------------------------------------------
    router.get('/portal/:p/tickets', 'public', (ctx) => withMember(ctx, (p, m) => listPage(p, m)));
    router.post('/portal/:p/tickets', 'public', (ctx) =>
      withMember(ctx, async (p, m) => {
        const subject = String(ctx.body?.subject ?? '').trim().slice(0, 200);
        const body = String(ctx.body?.body ?? '').trim().slice(0, 20_000);
        const cats = loadHelpdeskSettings(app, p.locationId).categories;
        const category = cats.includes(String(ctx.body?.category ?? '')) ? String(ctx.body.category) : '';
        if (!subject || !body) return listPage(p, m, 'Bitte Betreff und Nachricht ausfüllen.', { subject, body, category });
        const t = createTicket(app, p.locationId, { subject, description: body, contact_id: m.contact.id, category, source: 'Portal', channel: m.contact.email ? 'email' : '' }, { via: 'portal' });
        await sendAutoReply(app, p.locationId, t.id).catch(() => null);
        return redirect(`${base(p)}/${t.number}?neu=1`, 303);
      }),
    );
    router.get('/portal/:p/tickets/:n', 'public', (ctx) =>
      withMember(ctx, (p, m) => {
        const t = ticketOf(p, m, ctx.params.n);
        if (!t) return kit().notFoundPage(p, m);
        return detailPage(p, m, t, ctx.query.get('neu') === '1' ? 'Danke! Deine Anfrage ist bei uns angekommen.' : ctx.query.get('ok') === '1' ? 'Deine Nachricht wurde gesendet.' : '');
      }),
    );
    router.post('/portal/:p/tickets/:n/reply', 'public', (ctx) =>
      withMember(ctx, (p, m) => {
        const t = ticketOf(p, m, ctx.params.n);
        if (!t || t.status_kind === 'closed') return kit().notFoundPage(p, m);
        const body = String(ctx.body?.body ?? '').trim().slice(0, 20_000);
        if (!body) return detailPage(p, m, t);
        const next = addCustomerMessage(app, t, { body, via: 'portal', channel: 'portal' });
        if (next.owner_id) void Promise.resolve(app.services.pushNotify?.({ userIds: [next.owner_id], kind: 'messages', title: `Antwort zu Ticket #${next.number}`, body: body.slice(0, 140), url: `/app/tickets/${next.id}`, tag: `ticket-${next.id}` })).catch(() => {});
        return redirect(`${base(p)}/${t.number}?ok=1`, 303);
      }),
    );
  },
};
