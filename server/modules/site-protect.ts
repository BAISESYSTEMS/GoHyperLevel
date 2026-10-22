import { createHmac } from 'node:crypto';
import type { App, Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, html, notFound, redirect, type Ctx } from '../core/http.js';
import { publicPage } from '../core/page.js';
import { escapeHtml } from '../core/template.js';
import { hashPasswordAsync, id, now, safeEqual, verifyPasswordAsync } from '../core/util.js';
import type { Tool } from './mcp.js';

/**
 * Passwortgeschützte Seiten – docs/sites.md#password-protection. A password for one page or the whole site (members' price
 * lists, client previews, a staging site). Visitors see a small password form instead of the page; the right password sets a
 * signed cookie (7 days) for exactly that lock. Changing or removing the password ends every open access at once (the cookie
 * carries the lock's version). Protected pages are never cached and carry `noindex`. A whole-site lock also covers the site's
 * blog, collections, search, sitemap and 404; pages with their own lock never show up in the site search.
 */

const COOKIE_DAYS = 7;
const TRY_WINDOW = 10 * 60_000;
const MAX_TRIES = 10;
const tries = new Map<string, { n: number; at: number }>();
/**
 * At most 10 tries per address and lock in 10 minutes. Every try counts *before* the (slow, async) password check – check and
 * count happen in one synchronous step, so parallel requests can't all pass while the first ones are still being checked.
 * The right password clears the count (`triesDone`).
 */
function tooMany(key: string): boolean {
  const t = Date.now();
  if (tries.size > 5000) {
    for (const [k, e] of tries) if (t - e.at > TRY_WINDOW) tries.delete(k);
    // Still full: drop the oldest entries, never the whole table at once.
    for (const k of tries.keys()) {
      if (tries.size <= 4000) break;
      tries.delete(k);
    }
  }
  const e = tries.get(key);
  if (!e || t - e.at > TRY_WINDOW) {
    tries.set(key, { n: 1, at: t });
    return false;
  }
  e.n++;
  return e.n > MAX_TRIES;
}
const triesDone = (key: string) => void tries.delete(key);

export const lockCookieName = (lockId: string) => `pghl_sl_${lockId.replace(/[^A-Za-z0-9]/g, '')}`;
export const lockCookieValue = (secret: string, lockId: string, version: number) => createHmac('sha256', secret).update(`site-lock:${lockId}:${version}`).digest('base64url');

function lockForm(o: { lockId: string; back: string; hint: string; title: string; error?: string; color?: string }): string {
  const body = `<div class="wrap"><div class="card" style="max-width:420px;margin:12vh auto">
<h1>🔒 ${escapeHtml(o.title)}</h1>
<p class="muted">Diese Seite ist passwortgeschützt.${o.hint ? ` ${escapeHtml(o.hint)}` : ''}</p>
${o.error ? `<p role="alert" style="color:#b91c1c">${escapeHtml(o.error)}</p>` : ''}
<form method="post" action="/api/site-unlock">
<input type="hidden" name="lock" value="${escapeHtml(o.lockId)}">
<input type="hidden" name="back" value="${escapeHtml(o.back)}">
<label for="pw">Passwort</label>
<input id="pw" name="password" type="password" required autocomplete="current-password" autofocus>
<button type="submit" style="margin-top:12px">Öffnen</button>
</form></div></div>`;
  return publicPage({ title: o.title, body, color: o.color, head: '<meta name="robots" content="noindex, nofollow">' });
}

/** Only a path of this server (no `//host`, no scheme): the form never sends a visitor elsewhere. */
const safeBack = (v: unknown) => {
  const s = String(v ?? '/');
  return /^\/(?![/\\])[^\s]*$/.test(s) ? s.slice(0, 500) : '/';
};

export const siteProtectModule: Module = {
  name: 'site-protect',
  migrations: [
    [
      '001-locks',
      `CREATE TABLE site_locks (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        funnel_id TEXT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
        page_id TEXT REFERENCES funnel_pages(id) ON DELETE CASCADE,
        password_hash TEXT NOT NULL, hint TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX site_locks_target ON site_locks(funnel_id, COALESCE(page_id, ''));`,
    ],
  ],
  register(app: App) {
    const { db, router } = app;
    const secret = app.config.secret;

    const funnelOr404 = (ctx: Ctx) => {
      const f = parseJson(db.get('SELECT * FROM funnels WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId), ['settings']);
      if (!f) throw notFound('Website nicht gefunden');
      return f;
    };
    const out = (l: any) => ({ id: l.id, page_id: l.page_id ?? null, hint: l.hint, updated_at: l.updated_at });
    const list = (fid: string) => db.all('SELECT * FROM site_locks WHERE funnel_id = ? ORDER BY page_id IS NOT NULL, updated_at', fid).map(out);

    router.get('/api/funnels/:id/locks', 'location', (ctx) => list(funnelOr404(ctx).id));
    /** Sets (or changes) the password of a page – or of the whole site without `page_id`. */
    router.put('/api/funnels/:id/locks', 'location', async (ctx) => {
      if (ctx.scope === 'read') throw new HttpError(403, 'Dieser Schlüssel darf nur lesen');
      const f = funnelOr404(ctx);
      const pageId = ctx.body?.page_id ? String(ctx.body.page_id) : null;
      if (pageId && !db.get('SELECT id FROM funnel_pages WHERE id = ? AND funnel_id = ?', pageId, f.id)) throw notFound('Seite nicht gefunden');
      const password = String(ctx.body?.password ?? '');
      const hint = String(ctx.body?.hint ?? '').trim().slice(0, 200);
      const existing = db.get<any>('SELECT * FROM site_locks WHERE funnel_id = ? AND COALESCE(page_id, \'\') = ?', f.id, pageId ?? '');
      if (!password && existing) {
        db.run('UPDATE site_locks SET hint = ?, updated_at = ? WHERE id = ?', hint, now(), existing.id);
        return list(f.id);
      }
      if (password.length < 4 || password.length > 200) throw bad('Das Passwort braucht mindestens 4 Zeichen');
      const hash = await hashPasswordAsync(password);
      if (existing) db.run('UPDATE site_locks SET password_hash = ?, hint = ?, version = version + 1, updated_at = ? WHERE id = ?', hash, hint, now(), existing.id);
      else db.insert('site_locks', { id: id(), location_id: ctx.locationId, funnel_id: f.id, page_id: pageId, password_hash: hash, hint, version: 1, updated_at: now() });
      return list(f.id);
    });
    router.delete('/api/funnels/:id/locks/:lock', 'location', (ctx) => {
      const f = funnelOr404(ctx);
      if (!db.run('DELETE FROM site_locks WHERE id = ? AND funnel_id = ?', ctx.params.lock, f.id).changes) throw notFound('Kein Passwortschutz');
      return list(f.id);
    });

    /** The form's target – on the app's host and on connected domains alike (/api/ paths pass the domain rewrite). */
    router.post('/api/site-unlock', 'public', async (ctx) => {
      const lock = db.get<any>('SELECT l.*, f.settings AS f_settings, p.name AS page_name, f.name AS site_name FROM site_locks l JOIN funnels f ON f.id = l.funnel_id LEFT JOIN funnel_pages p ON p.id = l.page_id WHERE l.id = ?', String(ctx.body?.lock ?? ''));
      const back = safeBack(ctx.body?.back);
      if (!lock) return redirect(back, 303);
      const key = `${ctx.ip}|${lock.id}`;
      const color = (() => {
        try {
          return JSON.parse(lock.f_settings || '{}').color;
        } catch {
          return undefined;
        }
      })();
      const title = lock.page_name || lock.site_name || 'Geschützte Seite';
      // Counted before the comparison (see tooMany); verifyPasswordAsync compares in constant time.
      if (tooMany(key)) {
        const r = html(lockForm({ lockId: lock.id, back, hint: lock.hint, title, color, error: 'Zu viele Versuche – bitte in einigen Minuten erneut.' }), 429);
        r.headers['cache-control'] = 'no-store';
        return r;
      }
      const ok = await verifyPasswordAsync(String(ctx.body?.password ?? ''), lock.password_hash);
      if (!ok) {
        const r = html(lockForm({ lockId: lock.id, back, hint: lock.hint, title, color, error: 'Das Passwort stimmt nicht.' }), 401);
        r.headers['cache-control'] = 'no-store';
        return r;
      }
      triesDone(key);
      ctx.setCookie(lockCookieName(lock.id), lockCookieValue(secret, lock.id, lock.version), { maxAge: COOKIE_DAYS * 86400 });
      return redirect(back, 303);
    });

    const lockedHeaders = () => ({ 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex' });
    const opened = (ctx: Ctx, lock: any) => safeEqual(ctx.cookies?.[lockCookieName(lock.id)] ?? '', lockCookieValue(secret, lock.id, lock.version));
    const formFor = (ctx: Ctx, f: any, lock: any, title: string) => lockForm({ lockId: lock.id, back: safeBack(`${ctx.url.pathname}${ctx.url.search}`), hint: lock.hint, title, color: f.settings?.color });

    // A page's own lock wins over the site's; the right cookie lets the page through.
    app.services.pageServe = [
      ...(app.services.pageServe ?? []),
      (ctx: Ctx, f: any, page: any) => {
        const locks = db.all<any>('SELECT id, page_id, hint, version FROM site_locks WHERE funnel_id = ? AND (page_id = ? OR page_id IS NULL)', f.id, page.id);
        if (!locks.length) return undefined;
        const lock = locks.find((l) => l.page_id) ?? locks[0];
        const headers = lockedHeaders();
        if (opened(ctx, lock)) return { headers };
        const form = formFor(ctx, f, lock, page.seo?.title || page.name || f.name);
        return { transform: () => form, headers };
      },
    ];

    // The whole-site lock covers everything else the site serves too – blog (posts, index, RSS), collections (CMS), search,
    // sitemap and 404 – not only its pages: the page pipeline and the blog ask app.services.siteRedirect before anything else
    // (modules/site-routing.ts). Pages keep their order of precedence (own lock before the site's, see pageServe above).
    // robots.txt and the consent switch stay reachable; the help center is the sub-account's own product with its own public
    // address (/help/<slug>) and is not part of a site's lock.
    const OPEN_PATHS = new Set(['robots.txt', 'pghl-consent', 'help']);
    const previousRedirect = app.services.siteRedirect as ((ctx: Ctx, f: any, segments: string[]) => unknown) | undefined;
    app.services.siteRedirect = (ctx: Ctx, f: any, segments: string[]) => {
      const site = f?.id ? db.get<any>('SELECT id, hint, version FROM site_locks WHERE funnel_id = ? AND page_id IS NULL', f.id) : undefined;
      if (site && !(segments.length === 1 && OPEN_PATHS.has(segments[0]))) {
        let lock = site;
        let title = String(f.settings?.site_name || f.name || 'Geschützte Seite');
        if (segments.length <= 1) {
          const page = parseJson(
            segments.length
              ? db.get('SELECT id, name, seo FROM funnel_pages WHERE funnel_id = ? AND slug = ?', f.id, segments[0])
              : db.get('SELECT id, name, seo FROM funnel_pages WHERE funnel_id = ? ORDER BY position, created_at LIMIT 1', f.id),
            ['seo'],
          );
          if (page) {
            lock = db.get<any>('SELECT id, hint, version FROM site_locks WHERE funnel_id = ? AND page_id = ?', f.id, page.id) ?? site;
            title = page.seo?.title || page.name || title;
          }
        }
        if (!opened(ctx, lock)) {
          const r = html(formFor(ctx, f, lock, title));
          Object.assign(r.headers, lockedHeaders());
          return r;
        }
      }
      return previousRedirect?.(ctx, f, segments);
    };

    // The site search never shows the text of a page with its own password (modules/site-routing.ts); under a whole-site lock
    // the search page itself is locked (above).
    app.services.siteSearchHide = [...(app.services.siteSearchHide ?? []), (f: any) => db.all<{ page_id: string }>('SELECT page_id FROM site_locks WHERE funnel_id = ? AND page_id IS NOT NULL', f.id).map((r) => r.page_id)];

    // --- MCP ---------------------------------------------------------------------------------------------------------------------
    const TOOLS: Tool[] = [
      {
        name: 'ghl_site_lock_list',
        title: 'Passwortschutz einer Website anzeigen',
        description: 'Listet, welche Seiten einer Website (oder die ganze Website, page_id null) passwortgeschützt sind – ohne Passwörter.',
        inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, funnel_id: { type: 'string' } }, required: ['location_id', 'funnel_id'], additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: false },
        run: (call, a) => call.api('GET', `/api/funnels/${encodeURIComponent(a.funnel_id)}/locks`, { location: a.location_id }),
      },
      {
        name: 'ghl_site_lock_set',
        title: 'Seite mit Passwort schützen',
        description: 'Setzt ein Passwort für eine Seite (page_id) oder die ganze Website (ohne page_id). Ein neues Passwort beendet alle offenen Zugänge.',
        inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, funnel_id: { type: 'string' }, page_id: { type: 'string' }, password: { type: 'string', minLength: 4 }, hint: { type: 'string' } }, required: ['location_id', 'funnel_id', 'password'], additionalProperties: false },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        run: (call, a) => call.api('PUT', `/api/funnels/${encodeURIComponent(a.funnel_id)}/locks`, { location: a.location_id, body: { page_id: a.page_id, password: a.password, hint: a.hint } }),
      },
    ];
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
  },
};
