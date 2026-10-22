import { promises as dns } from 'node:dns';
import type { Module } from '../core/app.js';
import { domainAlias, normalizeDomain } from '../core/domains.js';
import { html, notFound, redirect, type Ctx } from '../core/http.js';
import { now } from '../core/util.js';
import { messagePage } from '../core/page.js';
import { hostSafeSlug, sitesDomain, slugOfSitesHost, txtHas, verifyRecordName, verifyToken } from '../services/cloud-sites.js';
import { cloudEnabled, tenantOfLocation } from './cloud.js';

/**
 * Customer sites in cloud mode (docs/cloud.md#customer-sites-their-own-origin-and-verified-domains):
 *
 * 1. **Never on the login origin.** A customer's site (`/p/<slug>…`, its blog and help center) is not served on the app's address,
 *    the cloud domain or a login domain: such a request is redirected to `https://<slug>.<PGHL_CLOUD_SITES_DOMAIN>` (a separate
 *    registrable domain – a phishing page reported there cannot put the login domain on a block list), or to the site's verified
 *    custom domain; without either the page is not served. The operator's own sites are unaffected.
 * 2. **Custom domains only after verification.** A custom domain of a customer's site starts once the TXT record
 *    `_pghl-verify.<domain>` holds the value shown in the site settings (checked every 10 minutes and on demand). Until then the
 *    domain shows a "being verified" page and gets no certificate (`app.services.wantedDomains` leaves it out). Domains that were
 *    connected before this module existed count as verified once.
 *
 * Hooks: one rewrite in front of the funnels' one, a router wrapper on the `/p/:funnel` routes, wrappers around
 * `app.services.wantedDomains` and `app.services.domainStatus`. Test hook: `app.services.siteDomainTxt` (DNS TXT lookup).
 */

/** Paths a site's host passes through unchanged (forms, booking, uploads, tracking, chat, webinars) – the same list as the funnels' rewrite. */
const PASS = /^\/(f|book|uploads|uploads-opt|i|r|u|chat|l|t|s|w)\//;
const RECHECK_MS = 10 * 60_000;

interface Check {
  domain: string;
  location_id: string;
  method: string;
  verified_at: string | null;
  checked_at: string | null;
  error: string;
}

export const cloudSitesModule: Module = {
  name: 'cloud-sites',
  migrations: [
    [
      '001-init',
      `CREATE TABLE site_domain_checks (
        domain TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, method TEXT NOT NULL DEFAULT 'txt',
        verified_at TEXT, checked_at TEXT, error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      );
      CREATE INDEX site_domain_checks_location ON site_domain_checks(location_id);`,
    ],
  ],
  register(app) {
    if (!cloudEnabled(app)) return;
    const { db, router } = app;
    const isTenant = (lid: string) => !!tenantOfLocation(app, lid);
    const funnelByHost = (host: string) => db.get<{ slug: string; location_id: string; domain: string }>('SELECT slug, location_id, domain FROM funnels WHERE domain = ? OR domain = ?', host, domainAlias(host) ?? host);
    const row = (domain: string) => db.get<Check>('SELECT * FROM site_domain_checks WHERE domain = ?', domain);
    const verified = (domain: string, lid: string) => {
      const r = row(domain);
      return !!r?.verified_at && r.location_id === lid;
    };
    /** The check row of a domain for this sub-account (a domain that moved to another sub-account starts over). */
    const ensure = (domain: string, lid: string): Check => {
      const r = row(domain);
      if (r && r.location_id === lid) return r;
      if (r) db.run('DELETE FROM site_domain_checks WHERE domain = ?', domain);
      db.insert('site_domain_checks', { domain, location_id: lid, method: 'txt', verified_at: null, checked_at: null, error: '', created_at: now() });
      return row(domain)!;
    };

    // Domains connected before verification existed keep working (once, at the first start with this module).
    if (!db.get(`SELECT 1 AS x FROM agency_settings WHERE key = 'cloud_sites_existing'`)) {
      db.tx(() => {
        for (const f of db.all<{ domain: string; location_id: string }>(`SELECT f.domain, f.location_id FROM funnels f JOIN cloud_locations c ON c.location_id = f.location_id WHERE COALESCE(f.domain, '') != ''`)) {
          db.run(`INSERT OR IGNORE INTO site_domain_checks (domain, location_id, method, verified_at, created_at) VALUES (?, ?, 'existing', ?, ?)`, f.domain, f.location_id, now(), now());
        }
        db.run(`INSERT INTO agency_settings (key, value) VALUES ('cloud_sites_existing', ?)`, JSON.stringify({ at: now() }));
      });
    }

    const lookup = async (name: string): Promise<string[][]> => {
      const fn = app.services.siteDomainTxt as ((n: string) => Promise<string[][]>) | undefined;
      try {
        return await (fn ?? ((n: string) => dns.resolveTxt(n)))(name);
      } catch {
        return [];
      }
    };
    async function check(domain: string, lid: string): Promise<Check> {
      ensure(domain, lid);
      const ok = txtHas(await lookup(verifyRecordName(domain)), verifyToken(app.config.secret, lid, domain));
      db.run('UPDATE site_domain_checks SET checked_at = ?, verified_at = COALESCE(verified_at, ?), error = ? WHERE domain = ?', now(), ok ? now() : null, ok ? '' : 'TXT-Eintrag noch nicht gefunden', domain);
      return row(domain)!;
    }
    const info = (domain: string, lid: string) => {
      const r = ensure(domain, lid);
      return { domain, required: true, verified: !!r.verified_at, method: r.method, record: { type: 'TXT', name: verifyRecordName(domain), value: verifyToken(app.config.secret, lid, domain) }, checked_at: r.checked_at, error: r.error };
    };

    // --- 1 + 2: hosts ------------------------------------------------------------------------------------------------
    app.rewrites.unshift((host, path) => {
      const sd = sitesDomain();
      if (sd && (host === sd || host.endsWith(`.${sd}`))) {
        const slug = slugOfSitesHost(host, sd);
        const f = slug ? db.get<{ slug: string; location_id: string }>('SELECT slug, location_id FROM funnels WHERE slug = ?', slug) : undefined;
        if (!f || !isTenant(f.location_id)) return '/_site/unknown';
        if (path.startsWith('/api/') || path.startsWith('/p/') || PASS.test(path)) return path;
        return `/p/${f.slug}${path === '/' ? '' : path}`;
      }
      const f = funnelByHost(host);
      if (f && isTenant(f.location_id) && !verified(f.domain, f.location_id)) return '/_site/pending';
      return undefined;
    });
    router.get('/_site/:kind', 'public', (ctx) => {
      const pending = ctx.params.kind === 'pending';
      const r = html(pending ? messagePage('Domain wird geprüft', 'Diese Website ist eingerichtet, die Domain aber noch nicht bestätigt. Sobald der Inhaber den DNS-Eintrag angelegt hat, ist sie hier erreichbar.') : messagePage('Nicht gefunden', 'Unter dieser Adresse gibt es keine Website.'), pending ? 503 : 404);
      r.headers['x-robots-tag'] = 'noindex';
      r.headers['cache-control'] = 'no-store';
      return r;
    });

    const hostOf = (ctx: Ctx) => String(ctx.req.headers.host ?? '').split(':')[0].toLowerCase();
    app.router.wrappers.push((route, next) =>
      route.auth === 'public' && route.pattern.startsWith('/p/:funnel')
        ? (ctx) => {
            const f = db.get<{ slug: string; location_id: string; domain: string | null }>('SELECT slug, location_id, domain FROM funnels WHERE slug = ?', ctx.params.funnel);
            if (!f || !isTenant(f.location_id)) return next(ctx);
            const host = hostOf(ctx);
            const sd = sitesDomain();
            const own = !!f.domain && (host === f.domain || host === domainAlias(f.domain));
            if (own || (sd && slugOfSitesHost(host, sd) === f.slug)) return next(ctx);
            // Anywhere else – the app's address, the cloud domain, a login domain, another customer's host: never here.
            const prefix = `/p/${f.slug}`;
            const rest = (ctx.path.startsWith(prefix) ? ctx.path.slice(prefix.length) : '') || '/';
            if (sd && hostSafeSlug(f.slug)) return redirect(`https://${f.slug}.${sd}${rest}${ctx.url.search}`, 301);
            if (f.domain && verified(f.domain, f.location_id)) return redirect(`https://${f.domain}${rest}${ctx.url.search}`, 301);
            const r = html(messagePage('Nicht hier', 'Diese Website ist nur über ihre eigene Adresse erreichbar.'), 404);
            r.headers['x-robots-tag'] = 'noindex';
            return r;
          }
        : next,
    );

    // Certificates: no unverified customer domain; every customer site's sites-domain host.
    const prevWanted = app.services.wantedDomains as (() => { domain: string; kind: string; alias?: string; location_id?: string; name?: string }[]) | undefined;
    app.services.wantedDomains = () => {
      const list = (prevWanted?.() ?? []).filter((d) => !(d.kind === 'funnel' && d.location_id && isTenant(d.location_id) && !verified(d.domain, d.location_id)));
      const sd = sitesDomain();
      if (sd) for (const f of db.all<{ slug: string; location_id: string; name: string }>('SELECT f.slug, f.location_id, f.name FROM funnels f JOIN cloud_locations c ON c.location_id = f.location_id')) if (hostSafeSlug(f.slug)) list.push({ domain: `${f.slug}.${sd}`, kind: 'site', location_id: f.location_id, name: f.name });
      return list;
    };
    // The site settings show what to do while a domain waits.
    const prevStatus = app.services.domainStatus as ((d: string) => unknown) | undefined;
    app.services.domainStatus = (d: string) => {
      const f = d ? funnelByHost(d) : undefined;
      if (f && f.domain === d && isTenant(f.location_id) && !verified(d, f.location_id)) {
        const i = info(d, f.location_id);
        return { status: 'unverified', message: `Domain bestätigen: TXT-Eintrag „${i.record.name}“ mit dem Wert „${i.record.value}“ anlegen. Die Seite startet nach der Prüfung (alle 10 Minuten oder sofort per „aktualisieren“).` };
      }
      return prevStatus?.(d);
    };

    // --- checks: every 10 minutes for waiting domains; on demand for the customer --------------------------------------
    let last = 0;
    app.onTick(async () => {
      if (Date.now() - last < RECHECK_MS) return;
      last = Date.now();
      let n = 0;
      for (const f of db.all<{ domain: string; location_id: string }>(`SELECT f.domain, f.location_id FROM funnels f JOIN cloud_locations c ON c.location_id = f.location_id WHERE COALESCE(f.domain, '') != ''`)) {
        if (verified(f.domain, f.location_id)) continue;
        await check(f.domain, f.location_id);
        if (++n >= 50) break;
      }
    });
    const ownDomain = (ctx: Ctx, raw: unknown) => {
      const d = normalizeDomain(raw);
      const f = d ? db.get<{ domain: string }>('SELECT domain FROM funnels WHERE location_id = ? AND domain = ?', ctx.locationId, d) : undefined;
      if (!f) throw notFound('Diese Domain ist keiner Website dieses Sub-Accounts zugeordnet');
      return f.domain;
    };
    router.get('/api/site-domain-check', 'location', (ctx) => {
      const d = ownDomain(ctx, ctx.query.get('domain'));
      return isTenant(ctx.locationId) ? info(d, ctx.locationId) : { domain: d, required: false, verified: true };
    });
    router.post('/api/site-domain-check', 'location', async (ctx) => {
      const d = ownDomain(ctx, ctx.body?.domain);
      if (!isTenant(ctx.locationId)) return { domain: d, required: false, verified: true };
      await check(d, ctx.locationId);
      return info(d, ctx.locationId);
    });
  },
};
