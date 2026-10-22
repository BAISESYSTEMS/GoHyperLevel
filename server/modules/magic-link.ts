import type { LocationRow, Module } from '../core/app.js';
import { HttpError, str, type Ctx } from '../core/http.js';
import { escapeHtml } from '../core/template.js';
import { now, sha256, token } from '../core/util.js';
import { emailDomain, hostMethods, signupAllowed } from '../services/login-policy.js';
import { deliverEmail, type OutMail } from '../services/messaging.js';
import { getBranding } from './agency.js';
import { safeNext } from './login-policy.js';

/**
 * Passwordless login by e-mail: a single-use link, valid 15 minutes, rate limited per address and IP.
 * The link opens the app (`/app/?magic=…`, an App Link in the Android app); signing in takes one more
 * click there, so mail scanners that open links don't use it up. Also sends invite links (sign-up mode
 * "invite"), valid for days. The answer never tells whether an account exists.
 */

const LOGIN_TTL = 15 * 60_000;
const MAX_PER_EMAIL = 3;
const WINDOW = 15 * 60_000;

export const magicLinkModule: Module = {
  name: 'magic-link',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE magic_links (
        token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, user_id TEXT, kind TEXT NOT NULL DEFAULT 'login',
        origin TEXT NOT NULL, next TEXT NOT NULL DEFAULT '/app', ip TEXT NOT NULL DEFAULT '',
        expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX magic_links_email ON magic_links(email, created_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const lp = () => app.services.loginPolicy;
    const mailer = (loc: LocationRow, mail: OutMail): Promise<{ status: string }> => (app.services.authMailer ?? deliverEmail)(loc, mail);

    /** Whose e-mail settings send the link: chosen in the login settings, else the client of this domain, the user's first sub-account, the oldest one. */
    function sender(user: any, locationId?: string): LocationRow | undefined {
      const want = lp().get().mail_location_id;
      if (want && app.location(want)) return app.location(want);
      if (locationId) return app.location(locationId);
      const mine: string[] = user ? JSON.parse(user.locations || '[]') : [];
      if (mine[0] && app.location(mine[0])) return app.location(mine[0]);
      const first = db.get('SELECT id FROM locations ORDER BY created_at LIMIT 1');
      return first ? app.location(first.id) : undefined;
    }

    function create(email: string, o: { userId: string | null; kind: 'login' | 'invite'; origin: string; next: string; ttlMs: number; ip: string }) {
      const t = token(32);
      db.insert('magic_links', { token_hash: sha256(t), email, user_id: o.userId, kind: o.kind, origin: o.origin, next: safeNext(o.next), ip: o.ip, expires_at: new Date(Date.now() + o.ttlMs).toISOString(), created_at: now() });
      return `${o.origin}/app/?magic=${t}`;
    }

    async function send(to: string, user: any, locationId: string | undefined, subject: string, text: string, link: string) {
      const loc = sender(user, locationId);
      if (!loc) return 'skipped';
      const htmlBody = `<!doctype html><html><body style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2937">${escapeHtml(text)
        .replace(/\n/g, '<br>')
        .replace(escapeHtml(link), `<a href="${escapeHtml(link)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Anmelden</a>`)}</body></html>`;
      try {
        return (await mailer(loc, { to, subject, text, html: htmlBody })).status;
      } catch (e) {
        console.error('[magic-link]', (e as Error).message);
        return 'failed';
      }
    }

    app.services.magicLink = {
      async sendInvite(email: string, origin: string, days: number) {
        const b = getBranding(app);
        const link = create(email, { userId: null, kind: 'invite', origin, next: '/app', ttlMs: days * 864e5, ip: '' });
        const text = `Hallo,\n\ndu bist zu ${b.name} eingeladen. Mit diesem Link meldest du dich an (${days} Tage gültig, einmal nutzbar):\n${link}\n\nViele Grüße\n${b.name}`;
        // The agency's own wording, if set (modules/system-mails.ts).
        const m = app.services.systemMail?.('invite', { subject: `Einladung zu ${b.name}`, text }, { brand: b, link, days }) ?? { subject: `Einladung zu ${b.name}`, text };
        return send(email, null, undefined, m.subject, m.text, link);
      },
    };

    const ipHits = new Map<string, number[]>();
    const throttleIp = (ip: string) => {
      const t = Date.now();
      const list = (ipHits.get(ip) ?? []).filter((x) => t - x < WINDOW);
      list.push(t);
      ipHits.set(ip, list);
      if (ipHits.size > 20_000) ipHits.clear();
      return list.length > 10;
    };

    router.post('/api/auth/magic-link', 'public', async (ctx) => {
      const h = lp().hostInfo(ctx);
      if (!hostMethods(lp().get(), h.locationId).magic_link) throw new HttpError(403, 'Anmelden per E-Mail-Link ist hier ausgeschaltet');
      if (throttleIp(ctx.ip)) throw new HttpError(429, 'Zu viele Anfragen – bitte in ein paar Minuten noch einmal');
      const email = str(ctx.body.email, 'E-Mail', { required: true, max: 200 }).toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) throw new HttpError(400, 'Bitte eine gültige E-Mail-Adresse angeben');
      const sso = app.services.ssoEnforced?.(email);
      if (sso && !lp().breakGlass()) throw new HttpError(403, `Für @${emailDomain(email)} ist die Anmeldung über „${sso.label}“ vorgeschrieben`);
      const answer = { ok: true, message: 'Wenn es ein Konto für diese Adresse gibt, ist der Link unterwegs. Er gilt 15 Minuten.' };
      const recent = db.get<{ n: number }>('SELECT COUNT(*) n FROM magic_links WHERE email = ? AND created_at > ?', email, new Date(Date.now() - WINDOW).toISOString())!.n;
      if (recent >= MAX_PER_EMAIL) return answer;
      const user = db.get('SELECT * FROM users WHERE email = ?', email);
      // Unknown address: only when an invite or an allowed domain would create the account on first login.
      if (!user && !signupAllowed(lp().get(), email, !!lp().inviteOf(email))) return answer;
      const b = getBranding(app);
      const link = create(email, { userId: user?.id ?? null, kind: 'login', origin: h.origin, next: String(ctx.body.next ?? '/app'), ttlMs: LOGIN_TTL, ip: ctx.ip });
      const text = `Hallo${user?.name ? ` ${user.name}` : ''},\n\nhier ist dein Anmelde-Link für ${b.name}. Er gilt 15 Minuten und nur einmal:\n${link}\n\nDu hast keinen Link angefordert? Dann ignoriere diese E-Mail einfach.\n\n${b.name}`;
      const m = app.services.systemMail?.('magic_login', { subject: `Dein Anmelde-Link für ${b.name}`, text }, { brand: b, link, user: { name: user?.name ?? '' } }) ?? { subject: `Dein Anmelde-Link für ${b.name}`, text };
      const status = await send(email, user, h.locationId, m.subject, m.text, link);
      app.services.audit?.({ ctx, action: 'login.magic_link', summary: `${email} (${status})`, userId: user?.id });
      return answer;
    });

    const valid = (t: unknown) => (typeof t === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(t) ? db.get('SELECT * FROM magic_links WHERE token_hash = ?', sha256(t)) : undefined);
    const usable = (row: any): row is Record<string, any> => !!row && !row.used_at && row.expires_at > now();

    /** Who the link signs in (shown before the click), without using it up. */
    router.post('/api/auth/magic-link/peek', 'public', (ctx) => {
      const row = valid(ctx.body.token);
      if (!usable(row)) throw new HttpError(410, 'Dieser Link ist abgelaufen oder wurde schon benutzt – fordere einfach einen neuen an');
      return { email: row.email, invite: row.kind === 'invite' };
    });

    router.post('/api/auth/magic-link/consume', 'public', (ctx: Ctx) => {
      const t = String(ctx.body.token ?? '');
      const row = valid(t);
      if (!usable(row) || !db.run('UPDATE magic_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?', now(), row.token_hash, now()).changes) {
        throw new HttpError(410, 'Dieser Link ist abgelaufen oder wurde schon benutzt – fordere einfach einen neuen an');
      }
      let user = db.get('SELECT * FROM users WHERE email = ?', row.email);
      if (user && row.user_id && user.id !== row.user_id) throw new HttpError(410, 'Dieser Link gilt nicht mehr');
      if (!user) {
        user = lp().provision(row.email, '', row.kind === 'invite' ? 'Einladung' : 'E-Mail-Link');
        if (!user) throw new HttpError(403, 'Für diese Adresse gibt es kein Konto');
      }
      db.run('UPDATE magic_links SET used_at = ? WHERE email = ? AND used_at IS NULL AND kind = ?', now(), row.email, 'login');
      return lp().finish(ctx, user, { method: 'magic', next: row.next });
    });

    app.onTick(() => void db.run('DELETE FROM magic_links WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)', new Date(Date.now() - 864e5).toISOString(), new Date(Date.now() - 864e5).toISOString()));
  },
};
