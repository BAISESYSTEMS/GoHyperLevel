import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SESSION_COOKIE, type App, type Module } from '../core/app.js';
import { HttpError, redirect, type Ctx, type RawResult } from '../core/http.js';
import { now, sha256, token } from '../core/util.js';
import { DEMO_EMAIL_DEFAULT, DEMO_PASSWORD_DEFAULT, seedDemo } from '../services/demo-seed.js';
import { blockedConnections, installOutboundGuard, outboundGuardActive } from '../services/outbound-guard.js';

/**
 * Demo mode (PGHL_DEMO_MODE=1) for a public try-it-out instance:
 *
 * - fills an empty database with fictional demo data (services/demo-seed.ts) and resets it every night
 *   (PGHL_DEMO_RESET_HOUR, default 3 o'clock in PGHL_TIMEZONE/Europe/Berlin);
 * - nothing leaves the server: every outgoing connection (e-mail, SMS, WhatsApp, social, payments,
 *   webhooks, AI, push …) is refused at the socket level and only logged (services/outbound-guard.ts);
 * - writes that would lock others out or configure real providers are refused with a clear message;
 * - the login page shows the demo login, every page a banner (GET /api/version → demo); public pages (websites, forms …) a
 *   note not to enter real data, and `X-Robots-Tag: noindex`;
 * - own domains (websites, client logins, help centre) cannot be connected – no certificate for a stranger's domain.
 *
 * Safety: a database that already has users but was not seeded by demo mode is never wiped.
 */

const RESET_KEY = 'last_reset_day';
const SEEDED_KEY = 'seeded_at';

/** Write routes that stay closed in demo mode: account takeover, real credentials, outbound integrations. */
const BLOCKED: [method: RegExp, path: RegExp][] = [
  [/./, /^\/api\/me\/(password|2fa)(\/|$)/],
  [/./, /^\/api\/users(\/|$)/],
  [/^DELETE$/, /^\/api\/locations\//],
  [/./, /^\/api\/api-keys(\/|$)/],
  [/./, /^\/api\/agency\/(api-keys|oauth|social|supabase|todoist|mail-accounts|video-studio|mobile-app|branding)(\/|$)/],
  [/./, /^\/api\/settings\/(meta|test-message)(\/|$)/],
  [/./, /^\/api\/(stripe|telephony|phone\/settings|phone\/setup|ai\/settings|google-reviews\/settings|ads\/accounts|saas\/settings|import|push|mobile\/app)(\/|$)/],
  [/./, /^\/api\/(webhooks|hooks)(\/|$)/],
  [/./, /^\/api\/admin\/backups(\/|$)/],
];

export const DEMO_BLOCKED_MESSAGE = 'Im Demo-Modus nicht verfügbar – Versand, Zugangsdaten und Integrationen sind abgeschaltet.';

/**
 * Own domains stay off: a visitor must not point a domain of theirs at the public demo – the reverse proxy would fetch a
 * certificate for it and serve the visitor's pages under it. Websites, client login domains and help centres.
 */
const DOMAIN_WRITES: [path: RegExp, pick: (body: any) => unknown][] = [
  [/^\/api\/funnels\/[^/]+$/, (b) => b?.domain],
  [/^\/api\/agency\/locations\/[^/]+\/branding$/, (b) => b?.app_domain],
  [/^\/api\/helpdesk\/settings$/, (b) => b?.help_center?.domain],
];

/** Shown on every public page of a demo (websites, forms, booking …): nobody should type real data or passwords into it. */
export const DEMO_PAGE_NOTE = 'Demo-Instanz: Alle Daten werden jede Nacht gelöscht. Bitte hier keine echten Daten oder Passwörter eingeben.';
const demoNoteHtml = () =>
  `<div role="note" data-pghl-demo style="position:relative;z-index:2147483647;margin:0;padding:8px 14px;background:#fff7d6;color:#3d2e00;border-bottom:1px solid #e9d27a;font:600 14px/1.4 system-ui,sans-serif;text-align:center">${DEMO_PAGE_NOTE}</div>`;

/** Adds the demo note right after <body …> (or at the very top when there is no body tag). */
export function withDemoNote(html: string): string {
  if (html.includes('data-pghl-demo')) return html;
  const m = /<body\b[^>]*>/i.exec(html);
  return m ? html.slice(0, m.index + m[0].length) + demoNoteHtml() + html.slice(m.index + m[0].length) : demoNoteHtml() + html;
}

export function demoEnabled(app: App): boolean {
  return app.config.demoMode ?? process.env.PGHL_DEMO_MODE === '1';
}

export function demoCredentials() {
  return { email: (process.env.PGHL_DEMO_EMAIL || DEMO_EMAIL_DEFAULT).toLowerCase(), password: process.env.PGHL_DEMO_PASSWORD || DEMO_PASSWORD_DEFAULT };
}

/** Is this write refused in demo mode? (GET/HEAD always pass; the seed itself passes.) */
export function demoBlocks(ctx: Pick<Ctx, 'method' | 'path' | 'body'> & { demoSeed?: boolean }): boolean {
  if (ctx.demoSeed || ctx.method === 'GET' || ctx.method === 'HEAD') return false;
  if (BLOCKED.some(([m, p]) => m.test(ctx.method) && p.test(ctx.path))) return true;
  // Profile edits are fine; switching the e-mail/SMS provider away from "nur speichern" is not.
  if (ctx.path === '/api/location' && ctx.body?.settings && ('email' in ctx.body.settings || 'sms' in ctx.body.settings)) return true;
  for (const [p, pick] of DOMAIN_WRITES) {
    const v = p.test(ctx.path) ? pick(ctx.body) : undefined;
    if (typeof v === 'string' && v.trim()) return true;
  }
  return false;
}

/** Local calendar day and hour in a time zone. */
function localDayHour(at: Date, timeZone: string): { day: string; hour: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(at).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** Empties every data table (keeps the migrations and the demo bookkeeping) and the upload folders. */
export function wipeData(app: App) {
  const virtual = app.db
    .all(`SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'`)
    .map((r: any) => String(r.name));
  // the shadow tables of a virtual table (FTS5: _data, _idx, _content, _docsize, _config) belong to it – emptying them by hand corrupts the index
  const shadow = (t: string) => virtual.some((v) => t.startsWith(`${v}_`));
  const tables = app.db
    .all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('_migrations', 'demo_state') AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'`)
    .map((r: any) => String(r.name))
    .filter((t: string) => !shadow(t));
  const q = (t: string) => `"${t.replace(/"/g, '')}"`;
  app.db.raw.exec('PRAGMA foreign_keys = OFF');
  try {
    app.db.tx(() => {
      for (const t of tables) app.db.run(`DELETE FROM ${q(t)}`);
    });
  } finally {
    app.db.raw.exec('PRAGMA foreign_keys = ON');
  }
  // resync each index with its (now empty) content: rebuild for content tables, delete-all for contentless ones
  for (const v of virtual) {
    try { app.db.run(`INSERT INTO ${q(v)}(${q(v)}) VALUES('rebuild')`); } catch {
      try { app.db.run(`INSERT INTO ${q(v)}(${q(v)}) VALUES('delete-all')`); } catch { /* not an FTS table */ }
    }
  }
  for (const dir of ['uploads', 'form-files', 'community', 'video-studio', 'mobile-app', 'teamchat-files']) {
    const full = join(app.config.dataDir, dir);
    if (!existsSync(full)) continue;
    for (const f of readdirSync(full)) rmSync(join(full, f), { recursive: true, force: true });
  }
}

export const demoModule: Module = {
  name: 'demo',
  migrations: [['001-init', `CREATE TABLE demo_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);`]],
  register(app) {
    const enabled = demoEnabled(app);
    const getState = (key: string) => app.db.get<{ value: string }>('SELECT value FROM demo_state WHERE key = ?', key)?.value;
    const setState = (key: string, value: string) => app.db.run('INSERT INTO demo_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
    const tz = () => process.env.PGHL_TIMEZONE || 'Europe/Berlin';
    const resetHour = () => Math.min(23, Math.max(0, Number(process.env.PGHL_DEMO_RESET_HOUR ?? 3) || 0));

    let busy: Promise<unknown> | null = null;
    let refused = false;
    /** Wipe + seed; refuses a database with real users that demo mode never seeded. */
    const reset = async (reason: string) => {
      if (busy) return busy;
      const hasUsers = !!app.db.get('SELECT id FROM users LIMIT 1');
      if (hasUsers && !getState(SEEDED_KEY)) {
        if (!refused) console.error('[demo] PGHL_DEMO_MODE=1, aber die Datenbank enthält echte Daten – sie wird NICHT zurückgesetzt. Demo-Modus nur mit leerem Datenordner starten.');
        refused = true;
        return null;
      }
      busy = (async () => {
        wipeData(app);
        const r = await seedDemo(app, demoCredentials());
        setState(SEEDED_KEY, now());
        setState(RESET_KEY, localDayHour(new Date(), tz()).day);
        console.log(`[demo] Demo-Daten ${reason}: ${r.locations.length} Sub-Accounts, ${r.ok} Schritte${r.failed.length ? `, ${r.failed.length} übersprungen` : ''}`);
        if (r.failed.length) console.warn('[demo] übersprungen:', r.failed.slice(0, 20).join(' | '));
        return r;
      })().finally(() => (busy = null));
      return busy;
    };
    app.services.demo = {
      enabled,
      reset,
      blocked: blockedConnections,
      info: () => (enabled ? { enabled: true, login: demoCredentials(), reset_hour: resetHour(), timezone: tz(), last_reset: getState(SEEDED_KEY) ?? null } : null),
    };

    if (!enabled) return;

    // Nothing leaves this server (process-wide, before any module sends anything).
    installOutboundGuard((b) => console.warn(`[demo] Verbindung nach außen blockiert: ${b.host}${b.port ? `:${b.port}` : ''}`));

    // Refuse writes that would lock other visitors out or configure real providers.
    app.guards.push((ctx) => {
      if (demoBlocks(ctx as Ctx & { demoSeed?: boolean })) throw new HttpError(403, DEMO_BLOCKED_MESSAGE);
    });

    // Public pages (websites, forms, booking, help centre …) carry a visible note and stay out of search engines – a page a
    // visitor builds in the demo must not pass for a real one.
    app.services.htmlTransforms = [
      ...(app.services.htmlTransforms ?? []),
      (_ctx: Ctx, r: RawResult) => {
        r.body = withDemoNote(String(r.body));
        r.headers['x-robots-tag'] = 'noindex, nofollow';
      },
    ];

    /** Signs the browser in as the demo user; false while the first seed is still running. */
    const enter = (ctx: Ctx) => {
      const u = app.db.get('SELECT id FROM users WHERE email = ?', demoCredentials().email);
      if (!u) return false;
      const t = token(32);
      app.db.insert('sessions', { token_hash: sha256(t), user_id: u.id, created_at: now(), expires_at: new Date(Date.now() + 864e5).toISOString() });
      app.services.onSessionStart?.(sha256(t), ctx, u.id);
      ctx.setCookie(SESSION_COOKIE, t, { maxAge: 86400 });
      return true;
    };

    // One click "Demo öffnen" (no password typing, no account lockout by strangers' wrong guesses).
    app.router.post('/api/demo/login', 'public', (ctx) => {
      if (!enter(ctx)) throw new HttpError(503, 'Die Demo wird gerade vorbereitet – bitte in ein paar Sekunden noch einmal.');
      return { ok: true };
    });

    // No click at all: the landing page's "Live-Demo testen" links here and lands in the app. Only paths inside the app
    // are accepted as `next` (no open redirect); while the first seed runs, the login page with its demo card answers.
    app.router.get('/demo', 'public', (ctx) => {
      const next = ctx.query.get('next') ?? '';
      const target = /^\/app(\/[^\\]*)?$/.test(next) && !next.includes('..') ? next : '/app';
      return enter(ctx) ? redirect(target) : redirect('/');
    });

    // What would have been sent (admins only, for curious visitors and for tests).
    app.router.get('/api/demo/outbox', 'admin', () => ({ guard: outboundGuardActive(), blocked: blockedConnections() }));

    // First seed as soon as the server listens (the seed talks to the app's own routes in-process).
    if (!getState(SEEDED_KEY)) {
      const wait = setInterval(() => {
        if (!app.selfUrl) return;
        clearInterval(wait);
        void reset('angelegt');
      }, 100);
      wait.unref();
    }

    // Nightly reset once the configured hour has passed in the demo's time zone.
    app.onTick(async () => {
      const { day, hour } = localDayHour(new Date(), tz());
      if (hour < resetHour() || getState(RESET_KEY) === day || !getState(SEEDED_KEY)) return;
      await reset('zurückgesetzt');
    });
  },
};
