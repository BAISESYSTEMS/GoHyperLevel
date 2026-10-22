import type { Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, num, str } from '../core/http.js';
import { zonedToUtc, ymdInTz } from '../core/time.js';
import { id, now } from '../core/util.js';
import { AdsError, capiEvent, fetchGoogleAds, fetchMetaInsights, googleAccessToken, sendCapi, type AdsDay } from '../services/ads.js';
import { getContact } from '../services/contacts.js';
import type { TouchRow } from '../services/attribution.js';
import { googleCreds, loadConnection } from '../services/ads-store.js';
import { openSecret, sealSecret } from './mail-sync.js';

/**
 * Ads reporting (read-only): Meta Ads (Marketing API, long-lived/system-user token + ad account)
 * and Google Ads (developer token + OAuth refresh token + customer id) per sub-account. A daily
 * sync stores spend, impressions, clicks and platform leads per campaign and day; the report joins
 * them with attribution (utm_campaign = campaign name or id) for CPL and ROAS. Optionally sends
 * Lead/Purchase back to Meta's Conversions API with hashed e-mail/phone. Secrets are sealed.
 */

type Platform = 'meta' | 'google';
const PLATFORMS: Platform[] = ['meta', 'google'];
const SECRET_FIELDS: Record<Platform, string[]> = { meta: ['token', 'capi_token'], google: ['developer_token', 'client_id', 'client_secret', 'refresh_token'] };
const MASK = '••••••';
const SYNC_EVERY_MS = 23 * 3600_000;

export const adsModule: Module = {
  name: 'ads',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE ads_accounts (
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, platform TEXT NOT NULL,
        config TEXT NOT NULL DEFAULT '{}', secrets TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
        last_sync_at TEXT, last_error TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (location_id, platform)
      );
      CREATE TABLE ads_daily (
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, platform TEXT NOT NULL, campaign_id TEXT NOT NULL,
        campaign_name TEXT NOT NULL DEFAULT '', date TEXT NOT NULL, spend_cents INTEGER NOT NULL DEFAULT 0, impressions INTEGER NOT NULL DEFAULT 0,
        clicks INTEGER NOT NULL DEFAULT 0, leads INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'EUR', updated_at TEXT NOT NULL,
        PRIMARY KEY (location_id, platform, campaign_id, date)
      );
      CREATE TABLE ads_capi_log (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, event_name TEXT NOT NULL, event_id TEXT NOT NULL,
        contact_id TEXT, status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, UNIQUE(location_id, event_id)
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    /** Test hook: tests replace the network for Meta and Google. */
    const fetcher = (): typeof fetch => app.services.adsFetch ?? fetch;

    const account = (locationId: string, platform: Platform): any => {
      const row: any = parseJson(db.get('SELECT * FROM ads_accounts WHERE location_id = ? AND platform = ?', locationId, platform), ['config']);
      if (!row) return undefined;
      let secrets: Record<string, string> = {};
      try {
        secrets = row.secrets ? JSON.parse(openSecret(app, row.secrets)) : {};
      } catch {
        secrets = {};
      }
      return { ...row, secrets };
    };
    // Google: per-connection values (manual setup) or the agency's Google app + developer token (OAuth connection of the ads manager).
    const gcreds = (locationId: string) => googleCreds(app, loadConnection(app, locationId, 'google'));
    const connected = (platform: Platform, a: any) => {
      if (platform === 'meta') return !!(a?.secrets.token && a?.config.ad_account_id);
      if (!a) return false;
      const g = gcreds(a.location_id);
      return !!(g.developerToken && g.refreshToken && g.clientId && g.clientSecret && a.config.customer_id);
    };
    const out = (locationId: string, platform: Platform) => {
      const a = account(locationId, platform);
      return {
        platform,
        connected: connected(platform, a),
        enabled: a ? !!a.enabled : false,
        config: a?.config ?? {},
        secrets: Object.fromEntries(SECRET_FIELDS[platform].map((k) => [k, a?.secrets[k] ? MASK : ''])),
        last_sync_at: a?.last_sync_at ?? null,
        last_error: a?.last_error ?? null,
        campaigns: db.get<{ n: number }>('SELECT COUNT(DISTINCT campaign_id) AS n FROM ads_daily WHERE location_id = ? AND platform = ?', locationId, platform)!.n,
      };
    };

    const cleanConfig = (platform: Platform, b: any, cur: any) => {
      const c: Record<string, any> = { ...cur };
      const digits = (v: unknown) => String(v ?? '').replace(/^act_/, '').replace(/[\s-]/g, '');
      if (platform === 'meta') {
        if (b.ad_account_id !== undefined) {
          c.ad_account_id = digits(b.ad_account_id);
          if (c.ad_account_id && !/^\d{5,25}$/.test(c.ad_account_id)) throw bad('Werbekonto-ID: nur Ziffern (act_123… geht auch)');
        }
        if (b.pixel_id !== undefined) {
          c.pixel_id = digits(b.pixel_id);
          if (c.pixel_id && !/^\d{5,25}$/.test(c.pixel_id)) throw bad('Pixel-/Dataset-ID: nur Ziffern');
        }
        if (b.capi_enabled !== undefined) c.capi_enabled = !!b.capi_enabled;
        if (b.capi_only_meta_leads !== undefined) c.capi_only_meta_leads = !!b.capi_only_meta_leads;
        if (b.test_event_code !== undefined) c.test_event_code = str(b.test_event_code, 'Test-Code', { max: 40 });
      } else {
        for (const k of ['customer_id', 'login_customer_id']) {
          if (b[k] === undefined) continue;
          c[k] = digits(b[k]);
          if (c[k] && !/^\d{10}$/.test(c[k])) throw bad('Kunden-ID: 10 Ziffern (123-456-7890)');
        }
      }
      if (b.api_version !== undefined) c.api_version = str(b.api_version, 'API-Version', { max: 10 });
      return c;
    };

    router.get('/api/ads/accounts', 'location', (ctx) => PLATFORMS.map((p) => out(ctx.locationId, p)));
    router.put('/api/ads/accounts/:platform', 'location', (ctx) => {
      const platform = ctx.params.platform as Platform;
      if (!PLATFORMS.includes(platform)) throw bad('Unbekannte Plattform');
      const cur = account(ctx.locationId, platform);
      const b = ctx.body ?? {};
      const config = cleanConfig(platform, b, cur?.config ?? {});
      const secrets = { ...(cur?.secrets ?? {}) };
      for (const k of SECRET_FIELDS[platform]) {
        const v = str(b[k], k, { max: 2000 });
        if (v && v !== MASK) secrets[k] = v;
      }
      if (config.capi_enabled && !config.pixel_id) throw bad('Für die Conversions API fehlt die Pixel-/Dataset-ID');
      db.run(
        `INSERT INTO ads_accounts (location_id, platform, config, secrets, enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(location_id, platform) DO UPDATE SET config = excluded.config, secrets = excluded.secrets, enabled = excluded.enabled, updated_at = excluded.updated_at`,
        ctx.locationId, platform, JSON.stringify(config), sealSecret(app, JSON.stringify(secrets)), b.enabled === false ? 0 : 1, now(),
      );
      return out(ctx.locationId, platform);
    });
    router.delete('/api/ads/accounts/:platform', 'location', (ctx) => {
      db.run('DELETE FROM ads_accounts WHERE location_id = ? AND platform = ?', ctx.locationId, ctx.params.platform);
      db.run('DELETE FROM ads_daily WHERE location_id = ? AND platform = ?', ctx.locationId, ctx.params.platform);
      return { ok: true };
    });

    // --- sync ----------------------------------------------------------------------------------------
    const ymd = (locationId: string, daysAgo: number) => ymdInTz(new Date(Date.now() - daysAgo * 864e5), app.location(locationId)?.timezone || 'Europe/Berlin');

    async function pull(locationId: string, platform: Platform, since: string, until: string): Promise<AdsDay[]> {
      const a = account(locationId, platform);
      if (!connected(platform, a)) throw new AdsError('Noch nicht vollständig verbunden');
      if (platform === 'meta') return fetchMetaInsights(fetcher(), { token: a!.secrets.token, adAccountId: a!.config.ad_account_id, since, until, version: a!.config.api_version });
      const g = gcreds(locationId);
      const accessToken = await googleAccessToken(fetcher(), { client_id: g.clientId, client_secret: g.clientSecret, refresh_token: g.refreshToken });
      return fetchGoogleAds(fetcher(), { developerToken: g.developerToken, accessToken, customerId: a!.config.customer_id, loginCustomerId: g.loginCustomerId || undefined, since, until, version: a!.config.api_version });
    }

    /** Fetches the last `days` days (numbers get corrected later, so they are always re-read) and upserts them. */
    async function sync(locationId: string, platform: Platform, days?: number) {
      const a = account(locationId, platform);
      const span = Math.min(Math.max(days ?? (a?.last_sync_at ? 7 : 30), 1), 90);
      try {
        const rows = await pull(locationId, platform, ymd(locationId, span - 1), ymd(locationId, 0));
        db.tx(() => {
          for (const r of rows)
            db.run(
              `INSERT INTO ads_daily (location_id, platform, campaign_id, campaign_name, date, spend_cents, impressions, clicks, leads, currency, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(location_id, platform, campaign_id, date) DO UPDATE SET campaign_name = excluded.campaign_name, spend_cents = excluded.spend_cents,
                 impressions = excluded.impressions, clicks = excluded.clicks, leads = excluded.leads, currency = excluded.currency, updated_at = excluded.updated_at`,
              locationId, platform, r.campaign_id, r.campaign_name, r.date, r.spend_cents, r.impressions, r.clicks, r.leads, r.currency, now(),
            );
          db.run('UPDATE ads_accounts SET last_sync_at = ?, last_error = NULL WHERE location_id = ? AND platform = ?', now(), locationId, platform);
        });
        return { rows: rows.length, campaigns: new Set(rows.map((r) => r.campaign_id)).size };
      } catch (e) {
        const msg = e instanceof AdsError ? e.message : `Abruf fehlgeschlagen: ${(e as Error).message}`;
        db.run('UPDATE ads_accounts SET last_sync_at = ?, last_error = ? WHERE location_id = ? AND platform = ?', now(), msg.slice(0, 500), locationId, platform);
        throw new HttpError(502, msg);
      }
    }
    app.services.adsSync = sync;

    router.post('/api/ads/accounts/:platform/test', 'location', async (ctx) => {
      const platform = ctx.params.platform as Platform;
      if (!PLATFORMS.includes(platform)) throw bad('Unbekannte Plattform');
      try {
        const rows = await pull(ctx.locationId, platform, ymd(ctx.locationId, 6), ymd(ctx.locationId, 0));
        return { ok: true, campaigns: new Set(rows.map((r) => r.campaign_id)).size, rows: rows.length };
      } catch (e) {
        throw new HttpError(e instanceof AdsError ? 400 : 502, (e as Error).message);
      }
    });
    router.post('/api/ads/sync', 'location', async (ctx) => {
      const list = ctx.body?.platform ? [ctx.body.platform as Platform] : PLATFORMS.filter((p) => connected(p, account(ctx.locationId, p)));
      if (!list.length) throw bad('Noch kein Werbekonto verbunden');
      const result: Record<string, unknown> = {};
      for (const p of list) result[p] = await sync(ctx.locationId, p, ctx.body?.days ? num(ctx.body.days, 7) : undefined);
      return result;
    });

    let ticking = false;
    app.onTick(async () => {
      if (ticking) return;
      ticking = true;
      try {
        const due = db.all('SELECT location_id, platform FROM ads_accounts WHERE enabled = 1 AND (last_sync_at IS NULL OR last_sync_at < ?)', new Date(Date.now() - SYNC_EVERY_MS).toISOString());
        for (const d of due) {
          if (!connected(d.platform, account(d.location_id, d.platform))) continue;
          await sync(d.location_id, d.platform).catch((e) => console.warn('[ads] sync', d.location_id, d.platform, (e as Error).message));
        }
      } finally {
        ticking = false;
      }
    });

    // --- report: spend × attribution ------------------------------------------------------------------
    /** Spend per campaign joined with attribution (CPL, ROAS); also used by the ads manager's campaign list. */
    const buildReport = (locationId: string, from: string, to: string, model: 'first' | 'last') => {
      const tz = app.location(locationId)?.timezone || 'Europe/Berlin';
      const campaigns = db.all(
        `SELECT platform, campaign_id, MAX(campaign_name) AS campaign_name, SUM(spend_cents) AS spend_cents, SUM(impressions) AS impressions, SUM(clicks) AS clicks,
           SUM(leads) AS platform_leads, MAX(currency) AS currency
         FROM ads_daily WHERE location_id = ? AND date >= ? AND date <= ? GROUP BY platform, campaign_id ORDER BY spend_cents DESC`,
        locationId, from, to,
      );
      // CRM side: leads and revenue per utm_campaign from the attribution module (if installed).
      const attr = app.services.attributionReport?.(locationId, { fromIso: zonedToUtc(from, '00:00', tz).toISOString(), toIso: new Date(zonedToUtc(to, '00:00', tz).getTime() + 864e5).toISOString(), group: 'campaign', model });
      // Key: platform of the utm_source (meta/google, '' = unknown) + campaign name or id in lower case.
      const platformOf = (source: string): string => (/^(facebook|fb|instagram|ig|meta|messenger|audience_network)$/.test(source) ? 'meta' : /^(google|adwords|youtube|gads)$/.test(source) ? 'google' : '');
      const byCampaign = new Map<string, { leads: number; revenue_cents: number; deals_won: number }>();
      for (const r of attr?.rows ?? []) {
        const k = String(r.campaign ?? '').trim().toLowerCase();
        if (!k) continue;
        const key = `${platformOf(String(r.source ?? ''))}|${k}`;
        const x = byCampaign.get(key) ?? { leads: 0, revenue_cents: 0, deals_won: 0 };
        x.leads += r.leads;
        x.revenue_cents += r.revenue_cents;
        x.deals_won += r.deals_won;
        byCampaign.set(key, x);
      }
      const used = new Set<string>();
      const rows = campaigns.map((c: any) => {
        const names = [...new Set([String(c.campaign_id).toLowerCase(), String(c.campaign_name).trim().toLowerCase()])];
        // Same platform first; campaigns tagged with another source (e.g. "partner") match by name alone.
        const keys = [...names.map((k) => `${c.platform}|${k}`), ...names.map((k) => `|${k}`)];
        const crm = { leads: 0, revenue_cents: 0, deals_won: 0 };
        for (const k of keys) {
          const m = byCampaign.get(k);
          if (!m || used.has(k)) continue;
          used.add(k);
          crm.leads += m.leads;
          crm.revenue_cents += m.revenue_cents;
          crm.deals_won += m.deals_won;
        }
        return {
          ...c,
          crm_leads: crm.leads,
          deals_won: crm.deals_won,
          revenue_cents: crm.revenue_cents,
          cpl_cents: crm.leads ? Math.round(c.spend_cents / crm.leads) : null,
          roas: c.spend_cents ? Math.round((crm.revenue_cents / c.spend_cents) * 100) / 100 : null,
          ctr: c.impressions ? Math.round((c.clicks / c.impressions) * 10000) / 100 : null,
        };
      });
      const t = rows.reduce((s, r) => ({ spend_cents: s.spend_cents + r.spend_cents, impressions: s.impressions + r.impressions, clicks: s.clicks + r.clicks, platform_leads: s.platform_leads + r.platform_leads, crm_leads: s.crm_leads + r.crm_leads, revenue_cents: s.revenue_cents + r.revenue_cents }), { spend_cents: 0, impressions: 0, clicks: 0, platform_leads: 0, crm_leads: 0, revenue_cents: 0 });
      const days = db.all('SELECT date, SUM(spend_cents) AS spend_cents, SUM(clicks) AS clicks FROM ads_daily WHERE location_id = ? AND date >= ? AND date <= ? GROUP BY date ORDER BY date', locationId, from, to);
      return {
        from,
        to,
        model,
        attribution: !!attr,
        rows,
        days,
        totals: { ...t, cpl_cents: t.crm_leads ? Math.round(t.spend_cents / t.crm_leads) : null, roas: t.spend_cents ? Math.round((t.revenue_cents / t.spend_cents) * 100) / 100 : null },
      };
    };
    app.services.adsReport = buildReport;
    router.get('/api/ads/report', 'location', (ctx) => {
      const ok = (s: string | null) => (s && /^\d{4}-\d\d-\d\d$/.test(s) ? s : '');
      const to = ok(ctx.query.get('to')) || ymd(ctx.locationId, 0);
      const from = ok(ctx.query.get('from')) || ymd(ctx.locationId, 29);
      if (from > to) throw bad('„Von“ liegt nach „Bis“');
      return buildReport(ctx.locationId, from, to, ctx.query.get('model') === 'last' ? 'last' : 'first');
    });

    // --- Meta Conversions API (optional) -------------------------------------------------------------
    router.get('/api/ads/capi-log', 'location', (ctx) => db.all('SELECT * FROM ads_capi_log WHERE location_id = ? ORDER BY created_at DESC LIMIT 100', ctx.locationId));

    const marketingConsent = (loc: string, contactId: string): boolean => {
      try {
        return app.services.consent?.status?.(loc, contactId)?.tracking?.purposes?.marketing?.status === 'confirmed';
      } catch {
        return false;
      }
    };
    async function sendConversion(locationId: string, contactId: string, ev: { name: 'Lead' | 'Purchase'; eventId: string; value?: number; currency?: string }) {
      const a = account(locationId, 'meta');
      if (!a?.enabled || !a.config.capi_enabled || !a.config.pixel_id) return;
      const tokenValue = a.secrets.capi_token || a.secrets.token;
      if (!tokenValue) return;
      const c = getContact(app, locationId, contactId);
      if (!c || (!c.email && !c.phone)) return;
      const touches: TouchRow[] = app.services.attribution?.touchesOf(locationId, contactId) ?? [];
      const click = [...touches].reverse().find((t) => t.fbclid);
      // Default: only people who came from a Meta ad (fbclid or utm_source facebook/instagram/meta) are sent.
      const fromMeta = !!click || touches.some((t) => /^(facebook|fb|instagram|ig|meta)$/.test(t.source));
      if (a.config.capi_only_meta_leads !== false && !fromMeta) return;
      if (db.get('SELECT 1 FROM ads_capi_log WHERE location_id = ? AND event_id = ?', locationId, ev.eventId)) return;
      // Hashed e-mail, phone and name go to Meta only with the contact's marketing consent (ledger channel "Tracking", purpose
      // "Marketing" – the cookie banner writes it), like the Google Ads offline conversions; no consent module = no consent.
      if (!marketingConsent(locationId, contactId)) {
        db.insert('ads_capi_log', { id: id(), location_id: locationId, event_name: ev.name, event_id: ev.eventId, contact_id: contactId, status: 'blocked', error: 'Keine Einwilligung (Marketing) – nicht gesendet', created_at: now() });
        return;
      }
      const logId = id();
      db.insert('ads_capi_log', { id: logId, location_id: locationId, event_name: ev.name, event_id: ev.eventId, contact_id: contactId, status: 'sending', created_at: now() });
      try {
        const event = capiEvent({
          eventName: ev.name,
          eventId: ev.eventId,
          eventTime: new Date(),
          email: c.email,
          phone: c.phone,
          firstName: c.first_name,
          lastName: c.last_name,
          externalId: c.id,
          fbclid: click?.fbclid,
          fbclidAt: click ? new Date(click.created_at) : undefined,
          sourceUrl: touches[touches.length - 1]?.landing_page || undefined,
          value: ev.value,
          currency: ev.currency,
        });
        await sendCapi(fetcher(), { pixelId: a.config.pixel_id, token: tokenValue, events: [event], testCode: a.config.test_event_code || undefined, version: a.config.api_version });
        db.run(`UPDATE ads_capi_log SET status = 'sent' WHERE id = ?`, logId);
      } catch (e) {
        db.run(`UPDATE ads_capi_log SET status = 'failed', error = ? WHERE id = ?`, (e as Error).message.slice(0, 500), logId);
      }
    }
    app.services.adsSendConversion = sendConversion;

    // Leads: the first form/booking/chat a contact comes from; purchases: every paid invoice.
    app.services.attributionHooks = [
      ...(app.services.attributionHooks ?? []),
      { onLink: ({ locationId, contactId, kind }: { locationId: string; contactId: string; kind: string }) => ['form', 'booking', 'chat'].includes(kind) && void sendConversion(locationId, contactId, { name: 'Lead', eventId: `lead_${contactId}` }) },
    ];
    app.events.on('invoice.paid', async (e) => {
      const inv = e.data.invoice;
      if (!inv?.contact_id || inv.kind !== 'invoice') return;
      await sendConversion(e.locationId, inv.contact_id, { name: 'Purchase', eventId: `purchase_${inv.id}`, value: inv.total_cents / 100, currency: inv.currency });
    });
  },
};

