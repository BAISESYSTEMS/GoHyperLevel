import { resolveTxt } from 'node:dns/promises';
import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import { appConfig, cleanCode, cleanDomain, cleanInstanceUrl, emailDomain, type PushInfo } from '../services/app-brand.js';
import { RateLimiter } from '../services/native-push.js';
import { brandKey, pwaBrand } from '../services/pwa-ios.js';
import { effectiveBranding } from './agency.js';

/**
 * Instance discovery for the gray-label app (docs/apps.md#discovery).
 *
 * - Every instance answers `GET /.well-known/gohyperlevel-app.json`: name, logo, colours, API address and push mode from the
 *   white-label settings (a client's own branding on its own domain). The app reads it before the login and after switching.
 * - The operator's cloud instance (`PGHL_APP_DIRECTORY=1`) also runs the directory the app asks when someone types an e-mail
 *   address or an agency code: `GET /api/app-directory/lookup?email=…|code=…`. Entries come from the operator
 *   (`/api/app-directory`, admin) or from the domain owner, proven by a DNS TXT record (`POST /api/app-directory/claim`).
 */

export const directoryEnabled = (env: NodeJS.ProcessEnv = process.env) => env.PGHL_APP_DIRECTORY === '1';
export const TXT_PREFIX = '_gohyperlevel-app';

type TxtResolver = (name: string) => Promise<string[][]>;
type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ status: number; json(): Promise<any> }>;

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
const json = (data: unknown, maxAge = 0, status = 200) => ({
  __raw: true as const,
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': maxAge ? `public, max-age=${maxAge}` : 'no-store', ...CORS },
  body: JSON.stringify(data),
});

export const appDiscoveryModule: Module = {
  name: 'app-discovery',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE app_directory (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, key TEXT NOT NULL, instance_url TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'admin', created_at TEXT NOT NULL, verified_at TEXT, UNIQUE (kind, key)
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;

    const locationByHost = (ctx: Ctx) => {
      const host = String(ctx.req.headers.host ?? '').split(':')[0].toLowerCase();
      return host ? db.get(`SELECT id FROM locations WHERE json_extract(settings, '$.branding.app_domain') = ?`, host)?.id : undefined;
    };
    /** The address the app should talk to: the client's own domain when the request came in on it, else the instance's. */
    const baseFor = (ctx: Ctx, locationId?: string) => {
      if (locationId) {
        const d = app.location(locationId)?.settings?.branding?.app_domain;
        if (d && app.services.domainStatus?.(d)?.status === 'active') return `https://${d}`;
      }
      return app.baseUrl();
    };
    const pushInfo = (): PushInfo => {
      const s = app.services.appPushStatus?.();
      return { mode: s?.mode ?? 'off', content: s?.content ?? 'generic', providers: s?.mode === 'own' ? s.own_providers : s?.mode === 'relay' ? ['fcm', 'apns'] : [] };
    };

    const wellKnown = (ctx: Ctx) => {
      const loc = locationByHost(ctx);
      const b = effectiveBranding(app, loc);
      const pb = pwaBrand(b);
      return json(appConfig(b, baseFor(ctx, loc), pushInfo(), pb.custom ? brandKey(pb) : ''), 300);
    };
    router.get('/.well-known/gohyperlevel-app.json', 'public', wellKnown);
    router.add('OPTIONS', '/.well-known/gohyperlevel-app.json', 'public', () => ({ __raw: true, status: 204, headers: CORS, body: '' }));

    // --- directory (operator's cloud instance only) ----------------------------------------------------------------------------
    if (!directoryEnabled()) return;
    const limiter = new RateLimiter();
    const resolver = (): TxtResolver => (app.services.dnsTxt as TxtResolver | undefined) ?? resolveTxt;
    const fetchFn = (): FetchLike => (app.services.appDirectoryFetch as FetchLike | undefined) ?? (fetch as unknown as FetchLike);
    const out = (r: any) => ({ id: r.id, kind: r.kind, key: r.key, instance_url: r.instance_url, name: r.name, source: r.source, created_at: r.created_at, verified_at: r.verified_at });

    router.get('/api/app-directory/lookup', 'public', (ctx) => {
      if (!limiter.take(`l:${ctx.ip}`, 60)) throw new HttpError(429, 'Zu viele Anfragen – bitte kurz warten');
      const q = ctx.query;
      const code = cleanCode(q.get('code'));
      const domain = emailDomain(q.get('email')) || cleanDomain(q.get('domain'));
      if (!code && !domain) throw bad('email, domain oder code angeben');
      // A sub-domain falls back to its parent ("mail.agentur.de" → "agentur.de").
      const parts = domain.split('.');
      const keys = code ? [['code', code]] : parts.slice(0, -1).map((_, i) => ['domain', parts.slice(i).join('.')]);
      for (const [kind, key] of keys) {
        const r = db.get('SELECT * FROM app_directory WHERE kind = ? AND key = ?', kind, key);
        if (r) return json({ instance_url: r.instance_url, name: r.name, matched: { kind, key } });
      }
      return json({ error: 'Keine Instanz für diese Adresse gefunden' }, 0, 404);
    });
    router.add('OPTIONS', '/api/app-directory/lookup', 'public', () => ({ __raw: true, status: 204, headers: CORS, body: '' }));

    router.get('/api/app-directory', 'admin', () => db.all('SELECT * FROM app_directory ORDER BY kind, key').map(out));
    router.post('/api/app-directory', 'admin', (ctx) => {
      const kind = ctx.body?.kind === 'code' ? 'code' : ctx.body?.kind === 'domain' ? 'domain' : '';
      if (!kind) throw bad('kind: domain oder code');
      const key = kind === 'code' ? cleanCode(ctx.body?.key) : cleanDomain(ctx.body?.key);
      if (!key) throw bad(kind === 'code' ? 'Code: 3–32 Zeichen, Buchstaben, Ziffern und -' : 'Ungültige Domain');
      const instance = cleanInstanceUrl(ctx.body?.instance_url);
      if (!instance) throw bad('instance_url: https://… ohne Pfad');
      const row = { id: id(), kind, key, instance_url: instance, name: str(ctx.body?.name, 'name', { max: 100 }), source: 'admin', created_at: now(), verified_at: now() };
      db.run(
        `INSERT INTO app_directory (id, kind, key, instance_url, name, source, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(kind, key) DO UPDATE SET instance_url = excluded.instance_url, name = excluded.name, source = 'admin', verified_at = excluded.verified_at`,
        row.id, row.kind, row.key, row.instance_url, row.name, row.source, row.created_at, row.verified_at,
      );
      return out(db.get('SELECT * FROM app_directory WHERE kind = ? AND key = ?', kind, key));
    });
    router.delete('/api/app-directory/:id', 'admin', (ctx) => {
      if (!db.run('DELETE FROM app_directory WHERE id = ?', ctx.params.id).changes) throw notFound();
      return { ok: true };
    });

    /**
     * The owner of a domain maps it to their instance without asking the operator: a TXT record
     * `_gohyperlevel-app.<domain>` with `gohyperlevel-app=<instance url>`, and the instance must answer its well-known file.
     */
    router.post('/api/app-directory/claim', 'public', async (ctx) => {
      if (!limiter.take(`c:${ctx.ip}`, 10)) throw new HttpError(429, 'Zu viele Anfragen – bitte kurz warten');
      const domain = cleanDomain(ctx.body?.domain);
      const instance = cleanInstanceUrl(ctx.body?.instance_url);
      if (!domain || !instance) throw bad('domain und instance_url (https://…) angeben');
      const want = `gohyperlevel-app=${instance}`;
      let records: string[][] = [];
      try {
        records = await resolver()(`${TXT_PREFIX}.${domain}`);
      } catch {
        /* no record */
      }
      if (!records.some((parts) => parts.join('').trim() === want)) throw bad(`TXT-Eintrag fehlt: ${TXT_PREFIX}.${domain} → "${want}"`);
      let cfg: any;
      try {
        const r = await fetchFn()(`${instance}/.well-known/gohyperlevel-app.json`, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
        cfg = r.status === 200 ? await r.json() : null;
      } catch {
        cfg = null;
      }
      if (!cfg || cfg.schema !== 1 || typeof cfg.api_base !== 'string') throw bad('Die Instanz antwortet nicht mit /.well-known/gohyperlevel-app.json');
      const prev = db.get(`SELECT * FROM app_directory WHERE kind = 'domain' AND key = ?`, domain);
      if (prev?.source === 'admin' && prev.instance_url !== instance) throw new HttpError(409, 'Diese Domain wurde vom Betreiber vergeben – bitte an den Support wenden');
      db.run(
        `INSERT INTO app_directory (id, kind, key, instance_url, name, source, created_at, verified_at) VALUES (?, 'domain', ?, ?, ?, 'dns', ?, ?)
         ON CONFLICT(kind, key) DO UPDATE SET instance_url = excluded.instance_url, name = excluded.name, verified_at = excluded.verified_at`,
        id(), domain, instance, String(cfg.name ?? '').slice(0, 100), now(), now(),
      );
      return out(db.get(`SELECT * FROM app_directory WHERE kind = 'domain' AND key = ?`, domain));
    });
  },
};
