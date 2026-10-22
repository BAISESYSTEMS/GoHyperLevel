import type { Module } from '../core/app.js';
import { HttpError, type Ctx, type RawResult } from '../core/http.js';
import { escapeHtml } from '../core/template.js';
import { formatInTz } from '../core/time.js';
import type { Member, Portal } from './portal.js';

/**
 * "Meine Termine" in the customer portal (HighLevel parity, docs/booking.md#appointments-in-the-customer-portal): the customer sees
 * their upcoming and recent appointments with time, place or video link and the appointment's own page to reschedule or cancel
 * (the calendar's rules and cutoffs apply there), and books a new one – the active booking calendars and service menus of the
 * sub-account. A contact with an appointment may log in to the portal. Read-only here; every change goes through /book/manage.
 */

type Kit = {
  resolve: (key: string) => Portal | undefined;
  memberOf: (ctx: Ctx, p: Portal) => Member | undefined;
  page: (p: Portal, o: { title: string; body: string; member?: Member; status?: number; head?: string }) => RawResult;
  loginPage: (p: Portal, o?: { error?: string; status?: number; next?: string }) => RawResult;
  unknownPortal: () => RawResult;
};

const ICON = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>';
const HEAD = `<style>
.ap-link{color:var(--text);text-decoration:none;font-weight:600;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}.ap-link:hover{color:var(--brand)}
.ap-dash{margin-top:34px}.ap-dash h2,.ap-h{display:flex;align-items:center;gap:8px}
.ap-card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px 20px;display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:12px}
.ap-card .when{font-weight:700}.ap-card.past{opacity:.75}.ap-st{font-size:13px;color:var(--muted)}
.ap-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.ap-tile{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px 16px;text-decoration:none;color:inherit;display:block}.ap-tile:hover{border-color:var(--brand)}
@media (max-width:600px){.ap-link span{display:none}}
</style>`;
const STATUS: Record<string, string> = { confirmed: 'Bestätigt', showed: 'Wahrgenommen', noshow: 'Nicht erschienen', cancelled: 'Abgesagt' };

export const portalAppointmentsModule: Module = {
  name: 'portal-appointments',
  register(app) {
    const { db, router } = app;
    const kit = (): Kit => {
      const k = app.services.portalKit;
      if (!k) throw new HttpError(501, 'Mitgliederbereich nicht verfügbar');
      return k;
    };
    const base = (p: Portal) => `${p.base}/appointments`;
    const since = () => new Date(Date.now() - 90 * 86_400_000).toISOString();
    const appointmentsOf = (loc: string, contactId: string) =>
      db.all<any>(
        `SELECT a.id, a.title, a.start_at, a.end_at, a.status, a.manage_token, a.meeting_url, c.name AS calendar, c.timezone, c.settings AS cal_settings
         FROM appointments a JOIN calendars c ON c.id = a.calendar_id
         WHERE a.location_id = ? AND a.contact_id = ? AND a.start_at >= ? AND a.status != 'blocked' ORDER BY a.start_at LIMIT 200`,
        loc,
        contactId,
        since(),
      );
    const hasAny = (loc: string, cid: string) => !!db.get(`SELECT 1 AS x FROM appointments WHERE location_id = ? AND contact_id = ? AND start_at >= ? AND status != 'blocked' LIMIT 1`, loc, cid, since());
    const when = (a: any) => formatInTz(a.start_at, a.timezone || 'Europe/Berlin');
    const place = (a: any) => {
      let s: any = {};
      try {
        s = JSON.parse(a.cal_settings || '{}');
      } catch {
        /* plain */
      }
      return a.meeting_url || s.meeting_location || '';
    };
    const card = (a: any, past: boolean) => {
      const where = place(a);
      const link = /^https?:\/\//.test(where) ? `<a href="${escapeHtml(where)}" target="_blank" rel="noopener noreferrer">${a.meeting_url ? 'Zum Videocall' : escapeHtml(where)}</a>` : escapeHtml(where);
      const manage = !past && a.status === 'confirmed' ? `<div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn secondary" href="/book/ticket/${encodeURIComponent(a.manage_token)}">Ticket</a><a class="btn secondary" href="/book/manage/${encodeURIComponent(a.manage_token)}">Verschieben oder absagen</a></div>` : '';
      return `<div class="ap-card${past ? ' past' : ''}"><div><div class="when">${escapeHtml(when(a))} Uhr</div><div>${escapeHtml(a.calendar)}${a.title && a.title !== a.calendar ? ` · ${escapeHtml(a.title)}` : ''}</div>${where ? `<div class="ap-st">${link}</div>` : ''}<div class="ap-st">${escapeHtml(STATUS[a.status] ?? a.status)}</div></div>${manage}</div>`;
    };

    app.services.portalHeader = [...(app.services.portalHeader ?? []), (p: Portal, m: Member) => (hasAny(p.locationId, m.contact.id) ? `<a class="ap-link" href="${base(p)}" aria-label="Meine Termine">${ICON}<span>Meine Termine</span></a>` : '')];
    app.services.portalHead = [...(app.services.portalHead ?? []), () => HEAD];
    app.services.portalDashboard = [
      ...(app.services.portalDashboard ?? []),
      (p: Portal, m: Member) => {
        const next = appointmentsOf(p.locationId, m.contact.id).find((a) => a.status === 'confirmed' && a.end_at >= new Date().toISOString());
        if (!next) return '';
        return `<section class="ap-dash"><h2>${ICON} Nächster Termin</h2>${card(next, false)}<a href="${base(p)}">Alle Termine</a></section>`;
      },
    ];
    app.services.portalMemberCheck = [...(app.services.portalMemberCheck ?? []), (loc: string, cid: string) => hasAny(loc, cid)];
    app.services.portalNextPrefixes = [...(app.services.portalNextPrefixes ?? []), 'appointments'];

    router.get('/portal/:p/appointments', 'public', (ctx) => {
      const k = kit();
      const p = k.resolve(ctx.params.p);
      if (!p) return k.unknownPortal();
      const m = k.memberOf(ctx, p);
      if (!m) return k.loginPage(p, { status: 401, next: ctx.path });
      const nowIso = new Date().toISOString();
      const list = appointmentsOf(p.locationId, m.contact.id);
      const upcoming = list.filter((a) => a.end_at >= nowIso && a.status !== 'cancelled');
      const past = list.filter((a) => !upcoming.includes(a)).reverse();
      const calendars = db.all<any>('SELECT name, slug, description, duration FROM calendars WHERE location_id = ? AND active = 1 ORDER BY name LIMIT 30', p.locationId);
      let menus: any[] = [];
      try {
        menus = db.all<any>('SELECT name, slug, intro FROM service_menus WHERE location_id = ? AND active = 1 ORDER BY name LIMIT 10', p.locationId);
      } catch {
        /* service menus not installed */
      }
      const book = [
        ...menus.map((x) => `<a class="ap-tile" href="/book/s/${encodeURIComponent(x.slug)}"><strong>${escapeHtml(x.name)}</strong>${x.intro ? `<div class="ap-st">${escapeHtml(String(x.intro).slice(0, 120))}</div>` : ''}</a>`),
        ...calendars.map((c) => `<a class="ap-tile" href="/book/${encodeURIComponent(c.slug)}"><strong>${escapeHtml(c.name)}</strong><div class="ap-st">${c.duration} Min.${c.description ? ` · ${escapeHtml(String(c.description).slice(0, 100))}` : ''}</div></a>`),
      ].join('');
      const body = `<div class="crumb"><a href="${p.base}">Start</a></div><h1>Meine Termine</h1>
${upcoming.length ? upcoming.map((a) => card(a, false)).join('') : '<div class="panel empty"><p class="muted">Gerade steht kein Termin an.</p></div>'}
${book ? `<h2 class="ap-h" style="margin-top:28px">${ICON} Neuen Termin buchen</h2><div class="ap-grid">${book}</div>` : ''}
${past.length ? `<h2 style="margin-top:28px">Vergangene Termine</h2>${past.map((a) => card(a, true)).join('')}` : ''}`;
      return k.page(p, { title: 'Meine Termine', body, member: m });
    });
  },
};
