import { timingSafeEqual } from 'node:crypto';
import type { App, Module } from '../core/app.js';
import { domainAlias, normalizeDomain } from '../core/domains.js';
import { HttpError, bad, notFound, str, text } from '../core/http.js';
import { PERMISSIONS, cleanPermissions, requiredPermission, visibleLocations } from '../core/permissions.js';
import { isValidTz } from '../core/time.js';
import { hashPassword, id, now, slugify } from '../core/util.js';
import { applySnapshot, exportSnapshot, snapshotSummary, validateSnapshot } from '../services/snapshots.js';
import { createLocation } from './core.js';
import { sealSettings } from '../core/secrets.js';
import { locationStats, overviewExtras } from '../services/location-stats.js';

/** The white-label look of the whole app (agency level). */
export interface Branding {
  name: string;
  logo_url: string;
  /** Logo for dark surfaces (the sidebar when its colour is dark); empty = logo_url everywhere. */
  logo_dark_url: string;
  /** Square mark for the narrow sidebar (and the favicon fallback). */
  mark_url: string;
  mark_dark_url: string;
  favicon_url: string;
  /** 'no' hides the app name next to the logo. */
  show_name: string;
  color: string;
  login_title: string;
  login_text: string;
  support_email: string;
  /** Custom domain the agency's clients log in on (e.g. app.my-agency.com). */
  app_domain: string;
}

const DEFAULT_BRANDING: Branding = {
  name: 'HyperLevel',
  logo_url: '',
  logo_dark_url: '',
  mark_url: '',
  mark_dark_url: '',
  favicon_url: '',
  show_name: '',
  color: '#2563eb',
  login_title: '',
  login_text: '',
  support_email: '',
  app_domain: '',
};

export function getBranding(app: App): Branding {
  const row = app.db.get('SELECT value FROM agency_settings WHERE key = ?', 'branding');
  const b: Branding = { ...DEFAULT_BRANDING, ...(row ? JSON.parse(row.value) : {}) };
  // Saved before the rename with the old default name: show the new one.
  if (b.name === 'GoHigh' || b.name === 'HyperLevel') b.name = DEFAULT_BRANDING.name;
  return b;
}

const BRAND_TEXT = ['name', 'logo_url', 'logo_dark_url', 'mark_url', 'mark_dark_url', 'favicon_url', 'show_name', 'login_title', 'login_text', 'support_email'] as const;

/** A text field of the branding; image addresses must be http(s) or one of our own uploads (never javascript: or data:). */
function brandText(key: string, value: unknown): string {
  const v = str(value, key, { max: 1000 });
  if (key.endsWith('_url') && v && !/^(https?:\/\/|\/uploads\/)/i.test(v)) throw bad('Bild-Adresse muss mit https:// beginnen');
  return v;
}

/** A client's own look (logo, colour, login domain); empty values fall back to the agency branding. */
export function locationBranding(app: App, locationId: string): Partial<Branding> {
  return app.location(locationId)?.settings?.branding ?? {};
}

/** What the browser gets: agency branding, overlaid by the client's when one applies. */
export function effectiveBranding(app: App, locationId?: string) {
  const { app_domain: _d, ...pub } = getBranding(app);
  if (!locationId) return pub;
  const { app_domain: _ld, ...own } = locationBranding(app, locationId);
  const set = Object.fromEntries(Object.entries(own).filter(([, v]) => v !== '' && v !== undefined && v !== null));
  return { ...pub, ...set, location_id: locationId };
}

export const agencyModule: Module = {
  name: 'agency',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE agency_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE snapshots (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        source_location_id TEXT, data TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE domains (
        domain TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending', message TEXT NOT NULL DEFAULT '',
        checked_at TEXT, updated_at TEXT NOT NULL
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;

    // --- module permissions for members (client logins) ----------------------
    app.guards.push((ctx) => {
      const u = ctx.user;
      if (!u || u.role === 'admin' || !u.permissions) return;
      const need = requiredPermission(ctx.method, ctx.path);
      if (need && !u.permissions.includes(need)) throw new HttpError(403, `Kein Zugriff auf „${PERMISSIONS[need]}“`);
    });
    router.get('/api/permissions', 'user', () => PERMISSIONS);

    // --- white-label branding --------------------------------------------------
    const domainStatus = (d: string) => (d ? (db.get('SELECT status, message, checked_at FROM domains WHERE domain = ?', d) ?? { status: 'pending', message: '' }) : undefined);
    app.services.domainStatus = domainStatus;
    // Links in emails use the agency domain once its certificate is live.
    app.services.publicBaseUrl = () => {
      const d = getBranding(app).app_domain;
      return d && domainStatus(d)?.status === 'active' ? `https://${d}` : undefined;
    };

    const locationByDomain = (host: string) => {
      let d = '';
      try {
        d = normalizeDomain(host);
      } catch {
        return undefined;
      }
      return d ? db.get(`SELECT id FROM locations WHERE json_extract(settings, '$.branding.app_domain') = ?`, d)?.id : undefined;
    };
    // The login page on a client's own domain (crm.kunde.de) shows the client's branding.
    router.get('/api/branding', 'public', (ctx) => effectiveBranding(app, locationByDomain(String(ctx.req.headers.host ?? ''))));
    // After login, client users see their sub-account's branding; agency admins keep the agency's.
    router.get('/api/branding/me', 'user', (ctx) => {
      const u = ctx.user!;
      if (u.role === 'admin') return effectiveBranding(app, locationByDomain(String(ctx.req.headers.host ?? '')));
      const want = String(ctx.req.headers['x-location-id'] ?? '');
      return effectiveBranding(app, u.locations.includes(want) ? want : u.locations[0]);
    });
    router.get('/api/agency/locations/:id/branding', 'admin', (ctx) => {
      if (!app.location(ctx.params.id)) throw notFound();
      const b = { name: '', logo_url: '', logo_dark_url: '', mark_url: '', mark_dark_url: '', favicon_url: '', show_name: '', color: '', login_title: '', login_text: '', support_email: '', app_domain: '', ...locationBranding(app, ctx.params.id) };
      return { ...b, app_domain_status: domainStatus(b.app_domain) };
    });
    router.patch('/api/agency/locations/:id/branding', 'admin', (ctx) => {
      const loc = app.location(ctx.params.id);
      if (!loc) throw notFound();
      const b = ctx.body ?? {};
      const next: Partial<Branding> = { ...locationBranding(app, loc.id) };
      for (const k of BRAND_TEXT) if (b[k] !== undefined) next[k] = brandText(k, b[k]);
      if (b.color !== undefined) {
        if (b.color && !/^#[0-9a-f]{6}$/i.test(b.color)) throw bad('Farbe als #rrggbb');
        next.color = b.color || '';
      }
      if (b.app_domain !== undefined) {
        const d = normalizeDomain(b.app_domain);
        const taken =
          d &&
          (d === getBranding(app).app_domain ||
            db.get('SELECT id FROM funnels WHERE domain = ?', d) ||
            db.get(`SELECT id FROM locations WHERE id != ? AND json_extract(settings, '$.branding.app_domain') = ?`, loc.id, d));
        if (taken) throw bad('Diese Domain ist schon vergeben');
        next.app_domain = d;
      }
      db.run('UPDATE locations SET settings = ? WHERE id = ?', JSON.stringify(sealSettings(app, { ...loc.settings, branding: next }).value), loc.id);
      return { ...next, app_domain_status: domainStatus(next.app_domain ?? '') };
    });
    router.get('/api/agency/branding', 'admin', () => ({ ...getBranding(app), app_domain_status: domainStatus(getBranding(app).app_domain) }));
    router.patch('/api/agency/branding', 'admin', (ctx) => {
      const cur = getBranding(app);
      const b = ctx.body ?? {};
      const next: Branding = { ...cur };
      for (const k of BRAND_TEXT) if (b[k] !== undefined) next[k] = brandText(k, b[k]);
      if (b.color !== undefined) {
        if (!/^#[0-9a-f]{6}$/i.test(b.color)) throw bad('Farbe als #rrggbb');
        next.color = b.color;
      }
      if (b.app_domain !== undefined) next.app_domain = normalizeDomain(b.app_domain);
      if (!next.name) next.name = DEFAULT_BRANDING.name;
      db.run('INSERT INTO agency_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'branding', JSON.stringify(next));
      return { ...next, app_domain_status: domainStatus(next.app_domain) };
    });

    // --- agency overview ---------------------------------------------------------
    router.get('/api/agency/overview', 'admin', (ctx) =>
      // Grouped queries instead of ten per sub-account; cached until the next write (db.memo).
      visibleLocations(app, ctx.user, db.memo('agency:overview', 20_000, () => {
        const since = new Date(Date.now() - 30 * 864e5).toISOString();
        const stats = locationStats(app, undefined, since, ['contacts', 'deals', 'inbox', 'activity']);
        const extra = overviewExtras(app, since);
        const funnels = new Map<string, any[]>();
        for (const f of db.all('SELECT id, name, slug, domain, kind, location_id FROM funnels ORDER BY name')) {
          const { location_id, ...rest } = f;
          const list = funnels.get(location_id) ?? [];
          list.push({ ...rest, url: f.domain ? `https://${f.domain}` : `${app.baseUrl()}/p/${f.slug}`, domain_status: f.domain ? domainStatus(f.domain) : undefined });
          funnels.set(location_id, list);
        }
        return db.all('SELECT id, name, timezone, created_at FROM locations ORDER BY name').map((l) => {
          const s = stats.get(l.id);
          return {
            ...l,
            contacts: s?.contacts ?? 0,
            new_contacts: s?.new_contacts ?? 0,
            open_value: s?.open_value ?? 0,
            appointments: extra.appointments.get(l.id) ?? 0,
            unread: s?.unread ?? 0,
            submissions: extra.submissions.get(l.id) ?? 0,
            views: extra.views.get(l.id) ?? 0,
            users: extra.users.get(l.id) ?? 0,
            last_activity: s?.last_activity ?? null,
            funnels: funnels.get(l.id) ?? [],
          };
        });
      })),
    );

    /** New client: sub-account, optionally from a snapshot, optionally with its own login. */
    router.post('/api/agency/clients', 'admin', (ctx) => {
      const b = ctx.body ?? {};
      const name = str(b.name, 'Firmenname', { required: true, max: 120 });
      const tz = str(b.timezone, 'Zeitzone') || 'Europe/Berlin';
      if (!isValidTz(tz)) throw bad('Unbekannte Zeitzone');
      const snap = b.snapshot_id ? db.get('SELECT * FROM snapshots WHERE id = ?', b.snapshot_id) : undefined;
      if (b.snapshot_id && !snap) throw bad('Snapshot nicht gefunden');
      const login = b.user?.email ? b.user : undefined;
      if (login) {
        if (db.get('SELECT id FROM users WHERE email = ?', String(login.email).trim().toLowerCase())) throw bad('E-Mail für den Login ist schon vergeben');
        if (String(login.password ?? '').length < 8) throw bad('Passwort braucht mindestens 8 Zeichen');
      }
      const loc = createLocation(db, name, tz, { email: b.email, phone: b.phone, website: b.website, address: b.address });
      let created;
      if (snap) {
        const data = validateSnapshot(JSON.parse(snap.data));
        // The snapshot brings its own pipelines; drop the empty default one.
        if (data.pipelines.length) db.run('DELETE FROM pipelines WHERE location_id = ?', loc.id);
        created = applySnapshot(app, loc.id, data, { activateWorkflows: !!b.activate_workflows });
      }
      let user;
      if (login) {
        user = { id: id(), email: String(login.email).trim().toLowerCase(), name: str(login.name, 'Name') || name, role: 'member', locations: [loc.id], permissions: cleanPermissions(login.permissions), created_at: now() };
        db.insert('users', { ...user, password_hash: hashPassword(String(login.password)) });
      }
      return { location: loc, created, user };
    });

    // --- snapshots ---------------------------------------------------------------
    const out = (s: any) => {
      const data = JSON.parse(s.data);
      return { id: s.id, name: s.name, description: s.description, source_location_id: s.source_location_id, created_at: s.created_at, summary: snapshotSummary(validateSnapshot(data)) };
    };
    router.get('/api/snapshots', 'admin', () => db.all('SELECT * FROM snapshots ORDER BY created_at DESC').map(out));
    router.post('/api/snapshots', 'admin', (ctx) => {
      const locId = str(ctx.body.location_id, 'Sub-Account', { required: true });
      const loc = app.location(locId);
      if (!loc) throw notFound('Sub-Account nicht gefunden');
      const row = { id: id(), name: str(ctx.body.name, 'Name') || `${loc.name} (${new Date().toLocaleDateString('de-DE')})`, description: str(ctx.body.description, 'Beschreibung', { max: 2000 }), source_location_id: locId, data: JSON.stringify(exportSnapshot(app, locId)), created_at: now() };
      db.insert('snapshots', row);
      return out(row);
    });
    router.post('/api/snapshots/import', 'admin', (ctx) => {
      let data;
      try {
        data = validateSnapshot(typeof ctx.body.data === 'string' ? JSON.parse(ctx.body.data) : ctx.body.data);
      } catch (e) {
        throw bad((e as Error).message);
      }
      const row = { id: id(), name: str(ctx.body.name, 'Name') || 'Importierter Snapshot', description: str(ctx.body.description, 'Beschreibung', { max: 2000 }), source_location_id: null, data: JSON.stringify(data), created_at: now() };
      db.insert('snapshots', row);
      return out(row);
    });
    router.get('/api/snapshots/:id/download', 'admin', (ctx) => {
      const s = db.get('SELECT * FROM snapshots WHERE id = ?', ctx.params.id);
      if (!s) throw notFound();
      const r = text(JSON.stringify({ name: s.name, ...JSON.parse(s.data) }, null, 2), 'application/json; charset=utf-8');
      r.headers['content-disposition'] = `attachment; filename="snapshot-${slugify(s.name)}.json"`;
      return r;
    });
    router.post('/api/snapshots/:id/apply', 'admin', (ctx) => {
      const s = db.get('SELECT * FROM snapshots WHERE id = ?', ctx.params.id);
      if (!s) throw notFound();
      const locId = str(ctx.body.location_id, 'Sub-Account', { required: true });
      if (!app.location(locId)) throw notFound('Sub-Account nicht gefunden');
      return applySnapshot(app, locId, validateSnapshot(JSON.parse(s.data)), { activateWorkflows: !!ctx.body.activate_workflows });
    });
    router.delete('/api/snapshots/:id', 'admin', (ctx) => {
      db.run('DELETE FROM snapshots WHERE id = ?', ctx.params.id);
      return { ok: true };
    });

    /** Copy one funnel/website (with the forms and calendars its pages use) into another sub-account. */
    router.post('/api/funnels/:id/copy', 'location', (ctx) => {
      const f = db.get('SELECT id FROM funnels WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!f) throw notFound();
      const target = str(ctx.body.location_id, 'Ziel-Sub-Account') || ctx.locationId;
      const u = ctx.user;
      if (!app.location(target)) throw notFound('Sub-Account nicht gefunden');
      if (ctx.viaApiKey ? target !== ctx.locationId : u && u.role !== 'admin' && !u.locations.includes(target)) throw new HttpError(403, 'Kein Zugriff auf den Ziel-Sub-Account');
      return applySnapshot(app, target, exportSnapshot(app, ctx.locationId, { funnelIds: [f.id] }));
    });

    // --- custom domains + the host-side domain agent ------------------------------
    /** Every domain that should be served: funnel domains (and their www pair) plus the agency app domain. */
    const wantedDomains = () => {
      const list: { domain: string; kind: 'funnel' | 'app'; alias?: string; location_id?: string; name?: string }[] = [];
      for (const f of db.all('SELECT domain, location_id, name FROM funnels WHERE domain IS NOT NULL AND domain != ?', '')) list.push({ domain: f.domain, kind: 'funnel', alias: domainAlias(f.domain), location_id: f.location_id, name: f.name });
      const appDomain = getBranding(app).app_domain;
      if (appDomain) list.push({ domain: appDomain, kind: 'app' });
      for (const l of db.all(`SELECT id, name, json_extract(settings, '$.branding.app_domain') AS d FROM locations WHERE COALESCE(json_extract(settings, '$.branding.app_domain'), '') != ''`))
        list.push({ domain: l.d, kind: 'app', location_id: l.id, name: `${l.name} (Kunden-Login)` });
      return list;
    };
    // Other modules (tls-ask: Caddy on-demand certificates) read the same list.
    app.services.wantedDomains = wantedDomains;
    /**
     * Is this host used by something else already: the app itself, the agency's or a client's login domain, a site, a help center –
     * or reserved by a module (the cloud service's own domain, `app.services.domainReserved`)? One answer for every place that lets a
     * sub-account claim a host. The host decides which pages are served, so a claimed login domain would show the claimer's page
     * instead of the login (and the client's people could not sign in any more).
     */
    app.services.domainTaken = (domain: string, except: { funnel?: string; helpCenter?: string } = {}, ctx?: unknown): boolean => {
      const hosts = [domain, domainAlias(domain)].filter((h): h is string => !!h);
      const own = new URL(app.config.baseUrl).hostname;
      const agency = getBranding(app).app_domain;
      for (const h of hosts) {
        if (h === own || (agency && (h === agency || domainAlias(agency) === h))) return true;
        if (db.get(`SELECT 1 AS x FROM locations WHERE json_extract(settings, '$.branding.app_domain') = ?`, h)) return true;
        if (db.get('SELECT 1 AS x FROM funnels WHERE domain = ? AND id != ?', h, except.funnel ?? '')) return true;
        if (db.get(`SELECT 1 AS x FROM helpdesk_settings WHERE location_id != ? AND json_extract(data, '$.help_center.domain') = ?`, except.helpCenter ?? '', h)) return true;
      }
      return !!(app.services.domainReserved as ((d: string, ctx?: unknown) => boolean) | undefined)?.(domain, ctx);
    };
    router.get('/api/agency/domains', 'admin', () => ({
      server_ip: process.env.PGHL_SERVER_IP ?? '',
      agent: !!process.env.PGHL_AGENT_TOKEN,
      domains: wantedDomains().map((d) => ({ ...d, location: d.location_id ? app.location(d.location_id)?.name : undefined, ...domainStatus(d.domain) })),
    }));
    router.get('/api/domain-info', 'location', () => ({ server_ip: process.env.PGHL_SERVER_IP ?? '', agent: !!process.env.PGHL_AGENT_TOKEN }));

    const agentAuth = (ctx: { req: { headers: Record<string, any> } }) => {
      const want = process.env.PGHL_AGENT_TOKEN;
      const got = String(ctx.req.headers['x-agent-token'] ?? '');
      if (!want || got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) throw new HttpError(404, 'Nicht gefunden');
    };
    router.get('/api/agent/domains', 'public', (ctx) => {
      agentAuth(ctx);
      return { app_port: Number(process.env.PORT ?? 4700), domains: wantedDomains().map((d) => ({ domain: d.domain, alias: d.alias, kind: d.kind, ...domainStatus(d.domain) })) };
    });
    router.post('/api/agent/domains/report', 'public', (ctx) => {
      agentAuth(ctx);
      const d = normalizeDomain(ctx.body.domain);
      const status = ['active', 'pending_dns', 'error', 'removed'].includes(ctx.body.status) ? ctx.body.status : 'error';
      if (status === 'removed') db.run('DELETE FROM domains WHERE domain = ?', d);
      else
        db.run(
          `INSERT INTO domains (domain, status, message, checked_at, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(domain) DO UPDATE SET status = excluded.status, message = excluded.message, checked_at = excluded.checked_at, updated_at = excluded.updated_at`,
          d,
          status,
          str(ctx.body.message, 'Meldung', { max: 2000 }),
          now(),
          now(),
        );
      return { ok: true };
    });
  },
};
