import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LocationRow, Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { html, redirect, type Ctx, type RawResult } from '../core/http.js';
import { escapeHtml } from '../core/template.js';
import { normalizeEmail, now, sha256, token } from '../core/util.js';
import { getContact, logActivity } from '../services/contacts.js';
import { courseOutline, flatLessons, computeProgress, completedLessonIds, dripOrigin, isUnlocked, portalUrl, unlockAt, type OutlineLesson, type OutlineModule } from '../services/courses.js';
import { cssUrl, embedHtml, renderMarkdown, stripMarkdown, excerptOf, videoEmbed } from '../services/markdown.js';
import { deliverEmail, type OutMail } from '../services/messaging.js';

/**
 * The member portal (/portal/<sub-account id or slug>): passwordless login by email link, the
 * member's courses, a lesson player with drip, progress and "resume where you left off".
 * Member sessions are their own cookie per sub-account and never grant access to the admin app.
 *
 * Other member-area features (community) plug in through app.services: `portalKit` (lookup, session,
 * page frame), `portalHead` (extra styles), `portalHeader` (links in the top bar), `portalDashboard` (sections on the start page)
 * and `portalMemberCheck` (who may log in besides course members). Lessons are extended the same way: `lessonGates` (lock a lesson with
 * a reason, e.g. until a quiz is passed), `lessonExtras` (HTML after the lesson text, e.g. the quiz form) and `lessonCompleteBlock`
 * (a lesson that something else completes cannot be ticked off by hand) – see modules/quiz-portal.ts.
 *
 * Creator depth (hosted video, discussion, reviews, learning paths, cohorts, the installable app) plugs in the same way:
 * `lessonVideo` (the player of a hosted video instead of the embed), `courseExtras` (blocks on the course page: {top, bottom}),
 * (both get the page's query string as the last argument, for "saved" notices), `courseHead` / `courseScripts` (markup and script files on the member's course pages; the scripts get a CSP that allows our own
 * files only) and `courseKit` (seat lookup, completing a lesson) for modules that need the member's seat.
 */

const LINK_TTL_MS = 30 * 60_000;
const SESSION_DAYS = 30;
const LINKS_PER_EMAIL = 3; // per 15 minutes
const REQUESTS_PER_IP = 20; // per 15 minutes
const WINDOW_MS = 15 * 60_000;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const HEX = /^#[0-9a-f]{6}$/i;

export interface Portal {
  locationId: string;
  loc: LocationRow;
  base: string;
  title: string;
  name: string;
  color: string;
  logo: string;
  favicon: string;
  welcome: string;
  support: string;
}

export interface Member {
  contact: any;
  sessionHash: string;
}

const ICON = {
  check: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  dot: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="8"/></svg>',
  file: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>',
  left: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
  right: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
  mail: '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>',
};

const CSS = `
:root { --text:#0f172a; --muted:#64748b; --line:#e2e8f0; --bg:#f6f7fb; --panel:#fff; --ok:#059669; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --text:#e5e7eb; --muted:#94a3b8; --line:#1e293b; --bg:#0b1020; --panel:#111a2e; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--text); background: var(--bg); }
a { color: var(--brand); }
.top { background: var(--panel); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 5; }
.top .in { max-width: 1160px; margin: 0 auto; padding: 10px 20px; display: flex; align-items: center; gap: 14px; min-height: 60px; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 700; color: inherit; text-decoration: none; min-width: 0; }
.brand img { max-height: 36px; max-width: 170px; object-fit: contain; }
.brand .mark { width: 34px; height: 34px; border-radius: 10px; background: var(--brand); color: #fff; display: grid; place-items: center; flex: none; }
.brand span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.who { margin-left: auto; display: flex; gap: 12px; align-items: center; font-size: 14px; color: var(--muted); }
.who form { margin: 0; }
.linkbtn { background: none; border: 0; color: var(--brand); font: inherit; cursor: pointer; padding: 0; }
main { max-width: 1160px; margin: 0 auto; padding: 28px 20px 64px; }
h1 { font-size: clamp(25px, 3.4vw, 34px); line-height: 1.2; margin: 0 0 8px; letter-spacing: -.01em; }
h2 { font-size: 20px; margin: 0 0 10px; }
.muted { color: var(--muted); } .small { font-size: 14px; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; background: var(--brand); color: #fff; border: 0; border-radius: 10px; padding: 11px 18px; font: inherit; font-weight: 600; cursor: pointer; text-decoration: none; }
.btn:hover { filter: brightness(1.06); }
.btn.ghost { background: var(--panel); color: var(--text); border: 1px solid var(--line); }
.btn.ok { background: var(--ok); }
.btn.wide { width: 100%; }
.bar { height: 8px; background: var(--soft); border-radius: 99px; overflow: hidden; }
.bar > i { display: block; height: 100%; background: var(--brand); border-radius: 99px; }
.hello { margin-bottom: 24px; } .hello p { margin: 4px 0 0; max-width: 720px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px; }
.ccard { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; overflow: hidden; display: flex; flex-direction: column; text-decoration: none; color: inherit; transition: transform .15s, box-shadow .15s; }
.ccard:hover { transform: translateY(-2px); box-shadow: 0 14px 34px rgba(15,23,42,.10); }
.cover { aspect-ratio: 16 / 9; background: linear-gradient(135deg, var(--brand), #0f172a); background-size: cover; background-position: center; display: grid; place-items: center; color: rgba(255,255,255,.92); font-size: 46px; font-weight: 800; }
.ccard .body { padding: 16px 18px 18px; display: flex; flex-direction: column; gap: 10px; flex: 1; }
.ccard h2 { margin: 0; font-size: 19px; line-height: 1.3; }
.ccard .meta { display: flex; justify-content: space-between; font-size: 13px; color: var(--muted); }
.ccard .go { margin-top: auto; font-weight: 600; color: var(--brand); display: flex; align-items: center; gap: 6px; }
.pill { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; padding: 2px 9px; border-radius: 99px; background: var(--soft); color: var(--brand); }
.pill.ok { background: rgba(5,150,105,.14); color: var(--ok); }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 22px; }
.chead { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 28px; align-items: center; margin-bottom: 26px; }
.chead .cover { border-radius: 16px; }
.chead p { margin: 6px 0 14px; }
.stat { display: flex; gap: 10px; align-items: center; font-size: 14px; color: var(--muted); margin-bottom: 14px; }
.stat .bar { flex: 1; max-width: 260px; }
.mod { margin-bottom: 14px; padding: 0; overflow: hidden; }
.mod h2 { padding: 16px 20px 6px; font-size: 17px; display: flex; justify-content: space-between; gap: 10px; }
.mod h2 small { font-weight: 500; color: var(--muted); font-size: 13px; }
.li { display: flex; align-items: center; gap: 12px; padding: 11px 20px; text-decoration: none; color: inherit; border-top: 1px solid var(--line); }
.li:hover { background: var(--soft); }
.li .st { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; flex: none; background: var(--soft); color: var(--brand); }
.li.done .st { background: var(--ok); color: #fff; }
.li.locked { color: var(--muted); }
.li.locked .st { background: transparent; color: var(--muted); }
.li.current { background: var(--soft); font-weight: 600; }
.li .t { flex: 1; min-width: 0; }
.li .d { font-size: 13px; color: var(--muted); white-space: nowrap; }
.lesson { display: grid; grid-template-columns: 310px minmax(0, 1fr); gap: 28px; align-items: start; }
.toc { position: sticky; top: 80px; max-height: calc(100vh - 100px); overflow: auto; padding: 0; }
.toc summary { list-style: none; cursor: pointer; padding: 16px 20px; font-weight: 700; display: flex; justify-content: space-between; gap: 8px; }
.toc summary::-webkit-details-marker { display: none; }
.toc .mt { padding: 12px 20px 4px; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); border-top: 1px solid var(--line); }
.toc .li { padding: 9px 20px; border-top: 0; font-size: 15px; }
.toc .li .st { width: 22px; height: 22px; }
.crumb { font-size: 14px; color: var(--muted); margin-bottom: 6px; } .crumb a { color: var(--muted); }
.player { margin: 18px 0 22px; }
.md-video { position: relative; padding-top: 56.25%; border-radius: 14px; overflow: hidden; background: #000; margin: 0 0 18px; }
.md-video iframe, .md-video video { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
.prose { font-size: 17px; } .prose > :first-child { margin-top: 0; }
.prose h2 { font-size: 23px; margin: 28px 0 10px; } .prose h3 { font-size: 19px; margin: 22px 0 8px; } .prose h4 { font-size: 17px; margin: 18px 0 6px; }
.prose img { max-width: 100%; height: auto; border-radius: 12px; }
.prose blockquote { margin: 16px 0; padding: 4px 18px; border-left: 4px solid var(--brand); background: var(--soft); border-radius: 0 10px 10px 0; }
.prose code { background: var(--soft); padding: 1px 6px; border-radius: 6px; font-size: .9em; }
.prose pre { background: #0f172a; color: #e2e8f0; padding: 14px 16px; border-radius: 12px; overflow-x: auto; } .prose pre code { background: none; padding: 0; }
.prose hr { border: 0; border-top: 1px solid var(--line); margin: 26px 0; }
.files { margin-top: 26px; } .files a { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border: 1px solid var(--line); border-radius: 12px; margin-bottom: 8px; text-decoration: none; color: inherit; background: var(--panel); }
.files a:hover { border-color: var(--brand); } .files a svg { color: var(--brand); flex: none; }
.nav { display: flex; gap: 10px; align-items: center; justify-content: space-between; margin-top: 30px; padding-top: 20px; border-top: 1px solid var(--line); flex-wrap: wrap; }
.nav form { margin: 0; }
.locked-box { text-align: center; padding: 48px 22px; } .locked-box svg { width: 36px; height: 36px; color: var(--muted); }
.auth { min-height: calc(100vh - 140px); display: grid; place-items: center; }
.auth .panel { width: 100%; max-width: 420px; padding: 32px; text-align: center; }
.auth .logo { max-height: 54px; max-width: 220px; margin-bottom: 12px; }
.auth form { text-align: left; margin-top: 18px; }
.auth label { display: block; font-weight: 600; font-size: 14px; margin-bottom: 6px; }
.auth input { width: 100%; padding: 12px 13px; border: 1px solid var(--line); border-radius: 10px; font: inherit; background: var(--panel); color: var(--text); margin-bottom: 14px; }
.auth input:focus { outline: 2px solid var(--brand); outline-offset: 0; border-color: transparent; }
.auth .err { color: #dc2626; font-size: 14px; margin: -4px 0 12px; }
.auth .icon { color: var(--brand); margin-bottom: 6px; }
.notice { background: rgba(5,150,105,.12); color: var(--ok); padding: 12px 16px; border-radius: 12px; margin-bottom: 20px; font-weight: 600; }
.preview-flag { background: #fef3c7; color: #92400e; text-align: center; font-size: 13px; padding: 6px; }
.empty { text-align: center; padding: 56px 20px; }
@media (max-width: 900px) {
  .lesson { grid-template-columns: 1fr; } .lesson .toc { order: 2; position: static; max-height: none; }
  .chead { grid-template-columns: 1fr; } .chead .cover { order: -1; }
}
@media (max-width: 560px) { main { padding: 20px 14px 48px; } .who .name { display: none; } .nav > * { flex: 1 1 100%; } .nav > span { display: none; } .nav form { order: -1; } .nav .btn { width: 100%; } .auth .panel { padding: 24px 20px; } }
`;

const fmtDate = (d: Date, tz: string) => {
  try {
    return new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: tz }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
};
const duration = (min: number) => (min > 0 ? (min >= 60 ? `${Math.floor(min / 60)} Std. ${min % 60 ? `${min % 60} Min.` : ''}`.trim() : `${min} Min.`) : '');

export const portalModule: Module = {
  name: 'portal',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE member_login_tokens (
        token_hash TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, email TEXT NOT NULL,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, ip TEXT NOT NULL DEFAULT '', next TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX member_login_tokens_email ON member_login_tokens(location_id, email, created_at);
      CREATE TABLE member_sessions (
        token_hash TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_seen_at TEXT
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const uploadDir = join(app.config.dataDir, 'uploads');
    const ipHits = new Map<string, number[]>();
    const ipLimited = (ip: string) => {
      const t = Date.now();
      const list = (ipHits.get(ip) ?? []).filter((x) => t - x < WINDOW_MS);
      list.push(t);
      ipHits.set(ip, list);
      if (ipHits.size > 20_000) ipHits.clear();
      return list.length > REQUESTS_PER_IP;
    };
    /** Test hook: tests capture the login mail instead of sending it. */
    const mailer = (loc: LocationRow, mail: OutMail): Promise<{ status: string }> => (app.services.memberMailer ?? deliverEmail)(loc, mail);

    // --- portal lookup & branding ----------------------------------------------------
    const resolve = (key: string): Portal | undefined => {
      const row = parseJson(db.get('SELECT * FROM course_portals WHERE slug = ? OR location_id = ?', key, key), ['settings']);
      const loc = app.location(row?.location_id ?? key);
      if (!loc) return undefined;
      const s = row?.settings ?? {};
      const brand = loc.settings?.branding ?? {};
      const name = brand.name || loc.name;
      return {
        locationId: loc.id,
        loc,
        base: `/portal/${encodeURIComponent(row?.slug || loc.id)}`,
        title: s.title || `${name} – Mitgliederbereich`,
        name,
        color: [s.color, brand.color].find((c) => HEX.test(c ?? '')) ?? '#2563eb',
        logo: s.logo_url || brand.logo_url || loc.logo_url || '',
        favicon: brand.favicon_url || '',
        welcome: s.welcome || '',
        support: s.support_email || brand.support_email || loc.email || '',
      };
    };
    const cookieName = (p: Portal) => `pm_${p.locationId}`;
    /** After login, back to the page the member wanted (only pages of this portal). */
    const safeNext = (p: Portal, v: unknown) => {
      const s = String(v ?? '');
      // Other member pages register their path prefix (app.services.portalNextPrefixes, e.g. 'tickets').
      const extra = (app.services.portalNextPrefixes ?? []).some((x: string) => s === `${p.base}/${x}` || s.startsWith(`${p.base}/${x}/`));
      return (s.startsWith(`${p.base}/c/`) || s.startsWith(`${p.base}/community`) || extra) && /^[\w\-/%.]+$/.test(s) && !s.includes('..') && !s.includes('//') ? s : '';
    };

    const page = (p: Portal, opts: { title: string; body: string; member?: Member; status?: number; preview?: boolean; head?: string; scripts?: string[] }): RawResult => {
      const links = opts.member ? (app.services.portalHeader ?? []).map((fn: (p: Portal, m: Member) => string) => fn(p, opts.member!)).join('') : '';
      const who = opts.member
        ? `<div class="who">${links}<span class="name">${escapeHtml(opts.member.contact.first_name || opts.member.contact.email)}</span><form method="post" action="${p.base}/logout"><button class="linkbtn">Abmelden</button></form></div>`
        : '';
      const brand = p.logo ? `<img src="${escapeHtml(p.logo)}" alt="${escapeHtml(p.name)}">` : `<span class="mark">${escapeHtml(p.name.slice(0, 1).toUpperCase())}</span><span>${escapeHtml(p.name)}</span>`;
      const doc = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title === p.title ? p.title : `${opts.title} · ${p.title}`)}</title>
<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="same-origin"><meta name="theme-color" content="${p.color}">
${p.favicon ? `<link rel="icon" href="${escapeHtml(p.favicon)}">` : ''}
<style>:root{--brand:${p.color};--soft:${p.color}1f}@media (prefers-color-scheme: dark){:root{--soft:${p.color}33}}${CSS}</style>${(app.services.portalHead ?? []).map((fn: (p: Portal) => string) => fn(p)).join('')}${opts.head ?? ''}${(opts.scripts ?? []).map((src) => `<script src="${escapeHtml(src)}" defer></script>`).join('')}</head>
<body>${opts.preview ? '<div class="preview-flag">Vorschau – so sehen Mitglieder diese Lektion</div>' : ''}
<header class="top"><div class="in"><a class="brand" href="${opts.preview ? '#' : p.base}">${brand}</a>${who}</div></header>
<main>${opts.body}</main></body></html>`;
      const r = html(doc, opts.status ?? 200);
      Object.assign(r.headers, {
        'cache-control': 'no-store',
        'x-frame-options': 'DENY',
        'content-security-policy':
          "default-src 'none'; img-src * data:; media-src 'self' https: blob:; frame-src https://www.youtube-nocookie.com https://player.vimeo.com https://www.loom.com; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      });
      // Pages that bring script files of ours (video player, installable app): those files and this server only.
      if (opts.scripts?.length) r.headers['content-security-policy'] = r.headers['content-security-policy'].replace("default-src 'none';", "default-src 'none'; script-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self';");
      return r;
    };
    const notFoundPage = (p: Portal, member?: Member) =>
      page(p, { title: 'Nicht gefunden', member, status: 404, body: `<div class="panel empty"><h1>Nicht gefunden</h1><p class="muted">Diese Seite gibt es nicht oder du hast keinen Zugang.</p><a class="btn" href="${p.base}">Zu meinen Kursen</a></div>` });
    const unknownPortal = () => html('<!doctype html><meta charset="utf-8"><title>Nicht gefunden</title><p style="font-family:system-ui;padding:40px;text-align:center">Diesen Mitgliederbereich gibt es nicht.</p>', 404);

    // --- sessions ----------------------------------------------------------------------
    const memberOf = (ctx: Ctx, p: Portal): Member | undefined => {
      const raw = ctx.cookies[cookieName(p)];
      if (!raw) return undefined;
      const hash = sha256(raw);
      const s = db.get('SELECT * FROM member_sessions WHERE token_hash = ? AND location_id = ? AND expires_at > ?', hash, p.locationId, now());
      if (!s) return undefined;
      const contact = getContact(app, p.locationId, s.contact_id);
      if (!contact) return undefined;
      if (!s.last_seen_at || Date.now() - Date.parse(s.last_seen_at) > 5 * 60_000) db.run('UPDATE member_sessions SET last_seen_at = ? WHERE token_hash = ?', now(), hash);
      return { contact, sessionHash: hash };
    };
    // Browsers send Origin on form posts (or at least Sec-Fetch-Site); a foreign origin is refused.
    const sameOrigin = (ctx: Ctx) => {
      const o = ctx.req.headers.origin;
      if (ctx.req.headers['sec-fetch-site'] === 'same-origin' && (!o || o === 'null')) return true;
      if (!o || o === 'null') return !o;
      try {
        return new URL(String(o)).host === String(ctx.req.headers.host ?? '');
      } catch {
        return false;
      }
    };

    /** Creates a single-use login link (30 minutes) and mails it. */
    const sendLoginLink = async (locationId: string, contactId: string, ip = '', next = ''): Promise<{ status: string; link: string }> => {
      const p = resolve(locationId)!;
      const contact = getContact(app, locationId, contactId);
      if (!contact?.email) throw new Error('Kontakt hat keine E-Mail-Adresse');
      const raw = token(32);
      db.insert('member_login_tokens', { token_hash: sha256(raw), location_id: locationId, contact_id: contactId, email: contact.email, created_at: now(), expires_at: new Date(Date.now() + LINK_TTL_MS).toISOString(), ip, next });
      const link = `${portalUrl(app, locationId)}/auth?token=${encodeURIComponent(raw)}`;
      const hello = contact.first_name ? `Hallo ${contact.first_name}` : 'Hallo';
      const text = `${hello},\n\nhier ist dein Login-Link für „${p.title}“:\n${link}\n\nDer Link gilt 30 Minuten und funktioniert genau einmal. Wenn du ihn nicht angefordert hast, kannst du diese E-Mail ignorieren.\n\n${p.name}`;
      const htmlMail = `<!doctype html><html><body style="margin:0;background:#f6f7fb;font-family:Arial,sans-serif;color:#0f172a">
<div style="max-width:520px;margin:0 auto;padding:32px 20px"><div style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:28px">
<h2 style="margin:0 0 12px;font-size:20px">${escapeHtml(p.title)}</h2>
<p style="margin:0 0 20px;line-height:1.5">Hallo${contact.first_name ? ` ${escapeHtml(contact.first_name)}` : ''}, mit diesem Knopf meldest du dich an:</p>
<p style="margin:0 0 22px"><a href="${escapeHtml(link)}" style="display:inline-block;background:${p.color};color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:10px">Jetzt anmelden</a></p>
<p style="margin:0;font-size:13px;color:#64748b;line-height:1.5">Der Link gilt 30 Minuten und funktioniert genau einmal. Wenn du ihn nicht angefordert hast, ignoriere diese E-Mail einfach.</p>
</div><p style="font-size:12px;color:#94a3b8;text-align:center">${escapeHtml(p.name)}</p></div></body></html>`;
      const r = await mailer(p.loc, { to: contact.email, subject: `Dein Login-Link für ${p.title}`, text, html: htmlMail });
      logActivity(app, locationId, contactId, 'portal.login_link', 'Login-Link für den Mitgliederbereich gesendet');
      return { status: r.status, link };
    };
    app.services.sendMemberLoginLink = (locationId: string, contactId: string) => sendLoginLink(locationId, contactId);

    // --- member data -----------------------------------------------------------------
    type Seat = { enrollment: any; course: any; outline: OutlineModule[]; lessons: (OutlineLesson & { module: OutlineModule })[]; done: Set<string>; progress: ReturnType<typeof computeProgress>; /** What the drip counts from: the enrollment date, or the start of the member's cohort. */ origin: string };
    const seatFor = (enrollment: any, course: any): Seat => {
      const outline = courseOutline(app, course.id, { publishedOnly: true });
      const lessons = flatLessons(outline);
      const done = completedLessonIds(app, enrollment.id);
      return { enrollment, course, outline, lessons, done, progress: computeProgress(lessons.map((l) => l.id), done), origin: dripOrigin(app, enrollment) };
    };
    const seats = (p: Portal, contactId: string): Seat[] =>
      db
        .all(
          `SELECT e.*, c.id AS cid FROM course_enrollments e JOIN courses c ON c.id = e.course_id
           WHERE e.location_id = ? AND e.contact_id = ? AND e.status = 'active' AND c.status = 'published' ORDER BY c.position, c.created_at`,
          p.locationId,
          contactId,
        )
        .map((e) => seatFor(e, parseJson(db.get('SELECT * FROM courses WHERE id = ?', e.cid), ['access', 'settings'])));
    const seat = (p: Portal, contactId: string, courseSlug: string): Seat | undefined => seats(p, contactId).find((s) => s.course.slug === courseSlug);
    // Other modules may lock lessons (quiz/assignment gates): app.services.lessonGates = [(seat, lesson) => reason | undefined].
    const gateOf = (s: Seat, l: { id?: string }): string => {
      for (const fn of (app.services.lessonGates ?? []) as ((s: Seat, l: { id?: string }) => string | undefined)[]) {
        const why = fn(s, l);
        if (why) return why;
      }
      return '';
    };
    const open = (s: Seat, l: { id?: string; module: OutlineModule; drip_days: number }) => isUnlocked(s.origin, l.module.drip_days, l.drip_days) && !gateOf(s, l);
    /** Where "continue" goes: the last opened lesson if unfinished, else the first open unfinished one. */
    const resumeLesson = (s: Seat) => {
      const last = s.lessons.find((l) => l.id === s.enrollment.last_lesson_id);
      if (last && !s.done.has(last.id) && open(s, last)) return last;
      return s.lessons.find((l) => !s.done.has(l.id) && open(s, l)) ?? last ?? s.lessons[0];
    };
    /** Head markup and script files other modules add to the member's course pages (app.services.courseHead / courseScripts). */
    const courseAssets = (p: Portal) => ({ head: ((app.services.courseHead ?? []) as ((p: Portal) => string)[]).map((fn) => fn(p)).join(''), scripts: [...((app.services.courseScripts ?? []) as string[])] });
    const courseHref = (p: Portal, c: any) => `${p.base}/c/${encodeURIComponent(c.slug)}`;
    const lessonHref = (p: Portal, c: any, l: { id: string }) => `${courseHref(p, c)}/${encodeURIComponent(l.id)}`;
    const cover = (c: any, cls = 'cover') => `<div class="${cls}"${c.cover_image ? ` style="background-image:url('${cssUrl(c.cover_image)}')"` : ''}>${c.cover_image ? '' : escapeHtml(String(c.title).slice(0, 1).toUpperCase())}</div>`;
    const bar = (pct: number) => `<div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>`;

    const lessonRow = (p: Portal, s: Seat, l: OutlineLesson & { module: OutlineModule }, current = '') => {
      const unlocked = open(s, l);
      const done = s.done.has(l.id);
      const cls = ['li', done ? 'done' : '', unlocked ? '' : 'locked', l.id === current ? 'current' : ''].filter(Boolean).join(' ');
      const st = done ? ICON.check : unlocked ? (l.id === current ? ICON.play : ICON.dot) : ICON.lock;
      const right = unlocked ? duration(l.duration_min) : gateOf(s, l) ? 'gesperrt' : `ab ${fmtDate(unlockAt(s.origin, l.module.drip_days, l.drip_days), p.loc.timezone)}`;
      return `<a class="${cls}" href="${lessonHref(p, s.course, l)}"><span class="st">${st}</span><span class="t">${escapeHtml(l.title)}</span><span class="d">${escapeHtml(right)}</span></a>`;
    };

    // --- pages ------------------------------------------------------------------------
    const loginPage = (p: Portal, opts: { error?: string; email?: string; status?: number; next?: string } = {}) =>
      page(p, {
        title: 'Anmelden',
        status: opts.status,
        body: `<div class="auth"><div class="panel">
  ${p.logo ? `<img class="logo" src="${escapeHtml(p.logo)}" alt="">` : ''}
  <h1>${escapeHtml(p.title)}</h1>
  <p class="muted">${p.welcome ? escapeHtml(p.welcome) : 'Melde dich mit deiner E-Mail-Adresse an. Du bekommst einen Link, mit dem du ohne Passwort hineinkommst.'}</p>
  <form method="post" action="${p.base}/login">
    <label for="email">E-Mail-Adresse</label>
    <input id="email" name="email" type="email" required autocomplete="email" value="${escapeHtml(opts.email ?? '')}" placeholder="du@beispiel.de" autofocus>
    ${opts.error ? `<p class="err">${escapeHtml(opts.error)}</p>` : ''}
    ${opts.next ? `<input type="hidden" name="next" value="${escapeHtml(opts.next)}">` : ''}
    <button class="btn wide">Login-Link senden</button>
  </form>
  ${p.support ? `<p class="muted small" style="margin:18px 0 0">Fragen? <a href="mailto:${escapeHtml(p.support)}">${escapeHtml(p.support)}</a></p>` : ''}
</div></div>`,
      });

    const dashboard = (p: Portal, m: Member) => {
      const list = seats(p, m.contact.id);
      const cards = list
        .map((s) => {
          const started = !!(s.progress.done || s.enrollment.started_at);
          const label = s.progress.percent >= 100 ? 'Ansehen' : started ? 'Weiter' : 'Starten';
          // Started courses open right where the member left off.
          const resume = started && s.progress.percent < 100 ? resumeLesson(s) : undefined;
          return `<a class="ccard" href="${resume ? lessonHref(p, s.course, resume) : courseHref(p, s.course)}">${cover(s.course)}<div class="body">
  <h2>${escapeHtml(s.course.title)}</h2>
  ${s.course.description ? `<p class="muted small" style="margin:0">${escapeHtml(excerptOf(stripMarkdown(s.course.description), 140))}</p>` : ''}
  ${bar(s.progress.percent)}
  <div class="meta"><span>${s.progress.done} von ${s.progress.total} Lektionen</span>${s.progress.percent >= 100 ? `<span class="pill ok">${ICON.check} Abgeschlossen</span>` : `<span>${s.progress.percent} %</span>`}</div>
  <span class="go">${label} ${ICON.right}</span>
</div></a>`;
        })
        .join('');
      const first = m.contact.first_name ? `, ${escapeHtml(m.contact.first_name)}` : '';
      const extras = (app.services.portalDashboard ?? []).map((fn: (p: Portal, m: Member) => string) => fn(p, m)).join('');
      return page(p, {
        ...courseAssets(p),
        title: p.title,
        member: m,
        body: `<div class="hello"><h1>Hallo${first} 👋</h1>${p.welcome ? `<p class="muted">${escapeHtml(p.welcome)}</p>` : '<p class="muted">Hier findest du alle deine Kurse.</p>'}</div>
${list.length ? `<div class="grid">${cards}</div>` : extras ? '' : `<div class="panel empty"><h2>Noch kein Kurs freigeschaltet</h2><p class="muted">Sobald du Zugang zu einem Kurs hast, erscheint er hier.${p.support ? ` Fragen? <a href="mailto:${escapeHtml(p.support)}">${escapeHtml(p.support)}</a>` : ''}</p></div>`}${extras}`,
      });
    };

    const coursePage = (p: Portal, m: Member, s: Seat, notice = '', query = new URLSearchParams()) => {
      const next = resumeLesson(s);
      const totalMin = s.lessons.reduce((n, l) => n + (Number(l.duration_min) || 0), 0);
      const modules = s.outline
        .filter((mod) => mod.lessons.length)
        .map((mod) => {
          const doneHere = mod.lessons.filter((l) => s.done.has(l.id)).length;
          return `<section class="panel mod"><h2>${escapeHtml(mod.title)} <small>${doneHere}/${mod.lessons.length}</small></h2>${mod.lessons.map((l) => lessonRow(p, s, { ...l, module: mod })).join('')}</section>`;
        })
        .join('');
      const more = ((app.services.courseExtras ?? []) as ((p: Portal, m: Member, s: Seat, q: URLSearchParams) => { top?: string; bottom?: string } | undefined)[]).map((fn) => fn(p, m, s, query)).filter(Boolean) as { top?: string; bottom?: string }[];
      const cta = next
        ? `<a class="btn" href="${lessonHref(p, s.course, next)}">${s.progress.percent >= 100 ? 'Noch einmal ansehen' : s.progress.done || s.enrollment.started_at ? 'Weiter lernen' : 'Kurs starten'} ${ICON.right}</a>`
        : '';
      return page(p, {
        ...courseAssets(p),
        title: s.course.title,
        member: m,
        body: `${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ''}
<div class="crumb"><a href="${p.base}">Meine Kurse</a></div>
<div class="chead"><div>
  <h1>${escapeHtml(s.course.title)}</h1>
  ${s.course.description ? `<div class="prose muted">${renderMarkdown(s.course.description)}</div>` : ''}
  <div class="stat">${bar(s.progress.percent)}<span>${s.progress.percent} % · ${s.progress.done} von ${s.progress.total} Lektionen${totalMin ? ` · ${duration(totalMin)}` : ''}</span></div>
  ${cta}
</div>${cover(s.course)}</div>
${more.map((x) => x.top ?? '').join('')}
${modules || '<div class="panel empty"><p class="muted">Dieser Kurs hat noch keine Lektionen.</p></div>'}${more.map((x) => x.bottom ?? '').join('')}`,
      });
    };

    const lessonBody = (p: Portal, l: any, fileHref: (d: any) => string, hosted = '') => {
      const embed = l.video_url ? videoEmbed(l.video_url) : null;
      const video = hosted ? hosted : embed ? `<div class="player">${embedHtml(embed, l.title)}</div>` : l.video_url ? `<p><a class="btn ghost" href="${escapeHtml(l.video_url)}" target="_blank" rel="noopener">Video öffnen ${ICON.right}</a></p>` : '';
      const files = (l.downloads ?? []).length
        ? `<div class="files"><h2>Downloads</h2>${l.downloads.map((d: any) => `<a href="${fileHref(d)}">${ICON.file}<span>${escapeHtml(d.name)}</span></a>`).join('')}</div>`
        : '';
      return `${video}<div class="prose">${renderMarkdown(l.body ?? '', { embeds: true })}</div>${files}`;
    };

    const lessonPage = (p: Portal, m: Member, s: Seat, l: OutlineLesson & { module: OutlineModule }, query = new URLSearchParams()) => {
      const idx = s.lessons.findIndex((x) => x.id === l.id);
      const prev = s.lessons[idx - 1];
      const next = s.lessons[idx + 1];
      const toc = s.outline
        .filter((mod) => mod.lessons.length)
        .map((mod) => `<div class="mt">${escapeHtml(mod.title)}</div>${mod.lessons.map((x) => lessonRow(p, s, { ...x, module: mod }, l.id)).join('')}`)
        .join('');
      const side = `<details class="panel toc" open><summary><span>Kursinhalt</span><span class="muted small">${s.progress.percent} %</span></summary>${toc}</details>`;
      const head = `<div class="crumb"><a href="${p.base}">Meine Kurse</a> / <a href="${courseHref(p, s.course)}">${escapeHtml(s.course.title)}</a> / ${escapeHtml(l.module.title)}</div><h1>${escapeHtml(l.title)}</h1>${l.duration_min ? `<div class="muted small">${duration(l.duration_min)}</div>` : ''}`;
      if (!open(s, l)) {
        const at = fmtDate(unlockAt(s.origin, l.module.drip_days, l.drip_days), p.loc.timezone);
        const gate = gateOf(s, l);
        return page(p, {
          ...courseAssets(p),
          title: l.title,
          member: m,
          body: `<div class="lesson">${side}<article>${head}<div class="panel locked-box" style="margin-top:18px">${ICON.lock}<h2>Noch nicht freigeschaltet</h2><p class="muted">${gate && isUnlocked(s.origin, l.module.drip_days, l.drip_days) ? escapeHtml(gate) : `Diese Lektion steht dir ab dem <strong>${at}</strong> zur Verfügung.`}</p></div></article></div>`,
        });
      }
      const done = s.done.has(l.id);
      // Other modules add to a lesson (quiz, assignment): app.services.lessonExtras = [(p, member, seat, lesson) => { html, hideMark? } | undefined].
      const extras = ((app.services.lessonExtras ?? []) as ((p: Portal, m: Member, s: Seat, l: unknown, q: URLSearchParams) => { html: string; hideMark?: boolean } | undefined)[]).map((fn) => fn(p, m, s, l, query)).filter(Boolean) as { html: string; hideMark?: boolean }[];
      const extraHtml = extras.map((x) => x.html).join('');
      const markForm = extras.some((x) => x.hideMark) ? '<span></span>' : `<form method="post" action="${lessonHref(p, s.course, l)}/complete"><input type="hidden" name="done" value="${done ? '0' : '1'}"><button class="btn ${done ? 'ghost' : 'ok'}">${done ? `${ICON.check} Erledigt – zurücksetzen` : `${ICON.check} Als erledigt markieren`}</button></form>`;
      const nav = `<div class="nav">${prev ? `<a class="btn ghost" href="${lessonHref(p, s.course, prev)}">${ICON.left} Zurück</a>` : '<span></span>'}${markForm}${next ? `<a class="btn ghost" href="${lessonHref(p, s.course, next)}">Weiter ${ICON.right}</a>` : '<span></span>'}</div>`;
      const fileHref = (d: any) => `${p.base}/files/${encodeURIComponent(l.id)}/${encodeURIComponent(d.upload_id)}`;
      // A hosted video (modules/course-video.ts) brings its own player: app.services.lessonVideo = [(p, member, seat, lesson) => html | undefined].
      const hosted = ((app.services.lessonVideo ?? []) as ((p: Portal, m: Member, s: Seat, l: unknown) => string | undefined)[]).map((fn) => fn(p, m, s, l)).find(Boolean) ?? '';
      return page(p, { ...courseAssets(p), title: l.title, member: m, body: `<div class="lesson">${side}<article>${head}${lessonBody(p, l, fileHref, hosted)}${extraHtml}${nav}</article></div>` });
    };

    app.services.renderLessonPreview = (locationId: string, course: any, lesson: any): string => {
      const p = resolve(locationId)!;
      const head = `<div class="crumb">${escapeHtml(course.title)}</div><h1>${escapeHtml(lesson.title)}</h1>${lesson.duration_min ? `<div class="muted small">${duration(Number(lesson.duration_min))}</div>` : ''}`;
      return String(page(p, { title: lesson.title, preview: true, body: `<article style="max-width:860px;margin:0 auto">${head}${lessonBody(p, lesson, () => '#')}</article>` }).body);
    };

    // --- progress ---------------------------------------------------------------------
    const markViewed = (s: Seat, lessonId: string) => {
      const e = s.enrollment;
      db.run('INSERT INTO course_progress (enrollment_id, lesson_id, last_viewed_at) VALUES (?, ?, ?) ON CONFLICT(enrollment_id, lesson_id) DO UPDATE SET last_viewed_at = excluded.last_viewed_at', e.id, lessonId, now());
      db.run('UPDATE course_enrollments SET last_lesson_id = ?, last_seen_at = ? WHERE id = ?', lessonId, now(), e.id);
      if (!e.started_at && db.run('UPDATE course_enrollments SET started_at = ? WHERE id = ? AND started_at IS NULL', now(), e.id).changes) {
        logActivity(app, e.location_id, e.contact_id, 'course.started', `Kurs „${s.course.title}“ begonnen`);
        app.events.emit(e.location_id, 'course.started', { contactId: e.contact_id, courseId: s.course.id, course: { id: s.course.id, title: s.course.title } });
      }
    };
    const setDone = (s: Seat, l: OutlineLesson, done: boolean) => {
      const e = s.enrollment;
      if (!done) {
        db.run('UPDATE course_progress SET completed_at = NULL WHERE enrollment_id = ? AND lesson_id = ?', e.id, l.id);
        return;
      }
      const changed = db.run(
        'INSERT INTO course_progress (enrollment_id, lesson_id, completed_at, last_viewed_at) VALUES (?, ?, ?, ?) ON CONFLICT(enrollment_id, lesson_id) DO UPDATE SET completed_at = excluded.completed_at WHERE completed_at IS NULL',
        e.id,
        l.id,
        now(),
        now(),
      ).changes;
      if (!changed) return;
      const progress = computeProgress(s.lessons.map((x) => x.id), completedLessonIds(app, e.id));
      const course = { id: s.course.id, title: s.course.title };
      logActivity(app, e.location_id, e.contact_id, 'lesson.completed', `Lektion „${l.title}“ abgeschlossen (${s.course.title}, ${progress.percent} %)`);
      app.events.emit(e.location_id, 'lesson.completed', { contactId: e.contact_id, courseId: course.id, lessonId: l.id, course, lesson: { id: l.id, title: l.title }, progress });
      if (progress.total && progress.done >= progress.total && db.run('UPDATE course_enrollments SET completed_at = ? WHERE id = ? AND completed_at IS NULL', now(), e.id).changes) {
        logActivity(app, e.location_id, e.contact_id, 'course.completed', `Kurs „${s.course.title}“ abgeschlossen`);
        app.events.emit(e.location_id, 'course.completed', { contactId: e.contact_id, courseId: course.id, course });
      }
    };

    // --- routes -------------------------------------------------------------------------
    router.get('/portal/:p', 'public', (ctx) => {
      const p = resolve(ctx.params.p);
      if (!p) return unknownPortal();
      const m = memberOf(ctx, p);
      return m ? dashboard(p, m) : loginPage(p);
    });

    router.post('/portal/:p/login', 'public', async (ctx) => {
      const p = resolve(ctx.params.p);
      if (!p) return unknownPortal();
      if (!sameOrigin(ctx)) return loginPage(p, { error: 'Bitte die Seite neu laden und noch einmal versuchen.', status: 403 });
      if (ipLimited(ctx.ip)) return loginPage(p, { error: 'Zu viele Versuche – bitte in ein paar Minuten noch einmal.', status: 429 });
      const email = normalizeEmail(ctx.body?.email);
      if (!EMAIL_RE.test(email) || email.length > 200) return loginPage(p, { error: 'Bitte eine gültige E-Mail-Adresse eingeben.', email: String(ctx.body?.email ?? '').slice(0, 200), status: 400, next: safeNext(p, ctx.body?.next) });
      // Same answer whether or not the address is known (no account guessing).
      const known = db.get(
        `SELECT k.id, EXISTS (SELECT 1 FROM course_enrollments e WHERE e.contact_id = k.id AND e.status = 'active') AS enrolled
         FROM contacts k WHERE k.location_id = ? AND k.email = ?`,
        p.locationId,
        email,
      );
      // Course members, plus whoever another module lets in (e.g. community groups by tag).
      const contact = known && (known.enrolled || (app.services.portalMemberCheck ?? []).some((fn: (loc: string, cid: string) => boolean) => fn(p.locationId, known.id))) ? known : undefined;
      const recent = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM member_login_tokens WHERE location_id = ? AND email = ? AND created_at > ?', p.locationId, email, new Date(Date.now() - WINDOW_MS).toISOString())!.n;
      if (contact && recent < LINKS_PER_EMAIL) {
        try {
          await sendLoginLink(p.locationId, contact.id, ctx.ip, safeNext(p, ctx.body?.next));
        } catch (e) {
          console.error('[portal] login mail', e);
        }
      }
      return page(p, {
        title: 'E-Mail unterwegs',
        body: `<div class="auth"><div class="panel"><div class="icon">${ICON.mail}</div><h1>Schau in dein Postfach</h1>
<p class="muted">Wenn <strong>${escapeHtml(email)}</strong> für einen Kurs freigeschaltet ist, kommt gleich eine E-Mail mit deinem Login-Link. Er gilt 30 Minuten.</p>
<p class="muted small">Nichts angekommen? Schau im Spam-Ordner nach oder <a href="${p.base}">fordere einen neuen Link an</a>.</p></div></div>`,
      });
    });

    const tokenRow = (p: Portal, raw: string) =>
      raw ? db.get('SELECT * FROM member_login_tokens WHERE token_hash = ? AND location_id = ? AND used_at IS NULL AND expires_at > ?', sha256(raw), p.locationId, now()) : undefined;
    const badLink = (p: Portal) =>
      page(p, {
        title: 'Link ungültig',
        status: 400,
        body: `<div class="auth"><div class="panel"><h1>Link abgelaufen</h1><p class="muted">Dieser Login-Link ist abgelaufen oder wurde schon benutzt. Fordere einfach einen neuen an.</p><a class="btn wide" href="${p.base}">Neuen Link anfordern</a></div></div>`,
      });
    // Opening the link only shows a button: mail scanners that follow links can't use it up.
    router.get('/portal/:p/auth', 'public', (ctx) => {
      const p = resolve(ctx.params.p);
      if (!p) return unknownPortal();
      const raw = String(ctx.query.get('token') ?? '');
      const row = tokenRow(p, raw);
      if (!row) return badLink(p);
      return page(p, {
        title: 'Anmelden',
        body: `<div class="auth"><div class="panel">${p.logo ? `<img class="logo" src="${escapeHtml(p.logo)}" alt="">` : ''}<h1>Willkommen zurück</h1><p class="muted">Angemeldet wirst du als <strong>${escapeHtml(row.email)}</strong>.</p>
<form method="post" action="${p.base}/auth"><input type="hidden" name="token" value="${escapeHtml(raw)}"><button class="btn wide">Jetzt anmelden ${ICON.right}</button></form></div></div>`,
      });
    });
    router.post('/portal/:p/auth', 'public', (ctx) => {
      const p = resolve(ctx.params.p);
      if (!p) return unknownPortal();
      if (!sameOrigin(ctx)) return badLink(p);
      const raw = String(ctx.body?.token ?? '');
      const row = tokenRow(p, raw);
      // Single use: only the request that flips used_at gets a session.
      if (!row || !db.run('UPDATE member_login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?', now(), row.token_hash, now()).changes) return badLink(p);
      if (!getContact(app, p.locationId, row.contact_id)) return badLink(p);
      const sid = token(32);
      db.insert('member_sessions', { token_hash: sha256(sid), location_id: p.locationId, contact_id: row.contact_id, created_at: now(), expires_at: new Date(Date.now() + SESSION_DAYS * 864e5).toISOString(), last_seen_at: now() });
      ctx.setCookie(cookieName(p), sid, { maxAge: SESSION_DAYS * 86400 });
      logActivity(app, p.locationId, row.contact_id, 'portal.login', 'Im Mitgliederbereich angemeldet');
      return redirect(safeNext(p, row.next) || p.base, 303);
    });
    router.post('/portal/:p/logout', 'public', (ctx) => {
      const p = resolve(ctx.params.p);
      if (!p) return unknownPortal();
      const m = memberOf(ctx, p);
      if (m) db.run('DELETE FROM member_sessions WHERE token_hash = ?', m.sessionHash);
      ctx.setCookie(cookieName(p), '', { maxAge: 0 });
      return redirect(p.base, 303);
    });

    const withMember = (ctx: Ctx, fn: (p: Portal, m: Member) => RawResult | Promise<RawResult>) => {
      const p = resolve(ctx.params.p);
      if (!p) return unknownPortal();
      const m = memberOf(ctx, p);
      if (!m) return ctx.method === 'GET' ? loginPage(p, { status: 401, next: safeNext(p, ctx.path) }) : redirect(p.base, 303);
      return fn(p, m);
    };
    router.get('/portal/:p/c/:course', 'public', (ctx) =>
      withMember(ctx, (p, m) => {
        const s = seat(p, m.contact.id, ctx.params.course);
        if (!s) return notFoundPage(p, m);
        return coursePage(p, m, s, ctx.query.get('done') === '1' && s.progress.percent >= 100 ? '🎉 Glückwunsch – du hast den Kurs abgeschlossen!' : '', ctx.query);
      }),
    );
    router.get('/portal/:p/c/:course/:lesson', 'public', (ctx) =>
      withMember(ctx, (p, m) => {
        const s = seat(p, m.contact.id, ctx.params.course);
        const l = s?.lessons.find((x) => x.id === ctx.params.lesson);
        if (!s || !l) return notFoundPage(p, m);
        if (open(s, l)) markViewed(s, l.id);
        return lessonPage(p, m, s, l, ctx.query);
      }),
    );
    router.post('/portal/:p/c/:course/:lesson/complete', 'public', (ctx) =>
      withMember(ctx, (p, m) => {
        if (!sameOrigin(ctx)) return notFoundPage(p, m);
        const s = seat(p, m.contact.id, ctx.params.course);
        const l = s?.lessons.find((x) => x.id === ctx.params.lesson);
        if (!s || !l || !open(s, l)) return notFoundPage(p, m);
        // A lesson that a quiz or assignment decides about cannot be ticked off by hand (app.services.lessonCompleteBlock = [(seat, lesson) => boolean]).
        if (((app.services.lessonCompleteBlock ?? []) as ((s: Seat, l: unknown) => boolean)[]).some((fn) => fn(s, l))) return redirect(lessonHref(p, s.course, l), 303);
        const done = String(ctx.body?.done ?? '1') !== '0';
        setDone(s, l, done);
        if (!done) return redirect(lessonHref(p, s.course, l), 303);
        const after = seatFor(s.enrollment, s.course);
        if (after.progress.total && after.progress.done >= after.progress.total) return redirect(`${courseHref(p, s.course)}?done=1`, 303);
        const idx = s.lessons.findIndex((x) => x.id === l.id);
        const next = s.lessons.slice(idx + 1).find((x) => open(s, x));
        return redirect(next ? lessonHref(p, s.course, next) : courseHref(p, s.course), 303);
      }),
    );
    /** Lesson downloads only for members with access to that (unlocked) lesson. */
    router.get('/portal/:p/files/:lesson/:upload', 'public', (ctx) =>
      withMember(ctx, (p, m) => {
        const lesson = parseJson(db.get('SELECT * FROM course_lessons WHERE id = ? AND location_id = ? AND published = 1', ctx.params.lesson, p.locationId), ['downloads']);
        const course = lesson && db.get('SELECT slug FROM courses WHERE id = ?', lesson.course_id);
        const s = course && seat(p, m.contact.id, course.slug);
        const l = s?.lessons.find((x) => x.id === ctx.params.lesson);
        const d = l?.downloads.find((x) => x.upload_id === ctx.params.upload);
        const up = d && db.get('SELECT * FROM uploads WHERE id = ? AND location_id = ?', d.upload_id, p.locationId);
        const file = up && join(uploadDir, up.file);
        if (!s || !l || !open(s, l) || !up || !file || !existsSync(file)) return notFoundPage(p, m);
        const name = String(d.name || up.name).replace(/[^\w.\- ()äöüÄÖÜß]/g, '_');
        return {
          __raw: true,
          status: 200,
          headers: {
            'content-type': up.mime,
            'content-disposition': `${up.mime === 'application/pdf' || up.mime.startsWith('image/') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
            'cache-control': 'private, no-store',
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
          },
          body: readFileSync(file),
        } as RawResult;
      }),
    );

    app.services.portalKit = { resolve, memberOf, page, loginPage, notFoundPage, unknownPortal, sameOrigin };
    /** For modules that act on a member's seat in a course (player reports, discussion, reviews): look it up, check a lesson is open, tick it off. */
    app.services.courseKit = { seat, seatFor, open, setDone, lessonHref, courseHref, gateOf };

    // Expired links and sessions are cleaned up in the background.
    app.onTick(() => {
      db.run('DELETE FROM member_login_tokens WHERE expires_at < ?', new Date(Date.now() - 864e5).toISOString());
      db.run('DELETE FROM member_sessions WHERE expires_at < ?', now());
    });

  },
};
