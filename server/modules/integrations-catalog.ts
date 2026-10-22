import type { App, Module } from '../core/app.js';
import type { Ctx } from '../core/http.js';
import { CATALOG, CATEGORIES, aggregate, type CatalogEntry, type ProbeResult } from '../services/integrations-catalog.js';
import { callRoute } from '../services/route-call.js';
import { postizConfig } from './social.js';

/**
 * Integrations catalogue with live status. Every probe reads an existing status endpoint
 * in-process (same rights as the viewer) – nothing calls an external API. A module that is not
 * installed shows "nicht verfügbar"; agency settings show "Agentur" for client logins.
 */

export type Probe = (ctx: Ctx, loc: string) => Promise<ProbeResult> | ProbeResult;
const ok = (detail: string): ProbeResult => ({ status: 'ok', detail });
const partial = (detail: string): ProbeResult => ({ status: 'partial', detail });
const missing = (detail: string): ProbeResult => ({ status: 'missing', detail });
const info = (detail: string): ProbeResult => ({ status: 'info', detail });
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function probes(app: App) {
  const get = (ctx: Ctx, path: string, loc?: string) => callRoute(app, ctx, 'GET', path, {}, { locationId: loc });
  const hooks = (loc: string, source?: string) =>
    Number(app.db.get(`SELECT COUNT(*) n FROM rest_hooks WHERE location_id = ? AND status = 'active'${source ? ' AND source = ?' : ''}`, loc, ...(source ? [source] : []))?.n ?? 0);
  const viaApp = (source: string, name: string): Probe => (_ctx, loc) => {
    const n = hooks(loc, source);
    return n ? ok(`${plural(n, 'aktiver Auslöser', 'aktive Auslöser')} über ${name}`) : info(`Bereit – ${name} mit einem API-Schlüssel verbinden`);
  };

  const location: Record<string, Probe> = {
    stripe: async (ctx, loc) => {
      const r = await get(ctx, '/api/stripe', loc);
      if (!r.connected) return missing('Kein Stripe-Schlüssel');
      const who = `${r.account?.name || 'verbunden'} · ${r.live ? 'Live' : 'Testmodus'}`;
      return r.webhook_set ? ok(who) : partial(`${who} · Webhook-Secret fehlt`);
    },
    twilio: async (ctx, loc) => {
      const r = await get(ctx, '/api/telephony/settings', loc);
      if (r.ready) return ok(`Nummer ${r.effective_numbers?.[0] ?? ''}`.trim());
      const started = r.account_sid || r.auth_token_set || r.uses_sms_credentials;
      return started ? partial(`Fehlt: ${(r.missing ?? []).join(', ')}`) : missing('Keine Twilio-Zugangsdaten');
    },
    meta: async (ctx, loc) => {
      const r = await get(ctx, '/api/settings/meta', loc);
      const names: Record<string, string> = { whatsapp: 'WhatsApp', messenger: 'Messenger', instagram: 'Instagram' };
      const on = Object.keys(names).filter((k) => r[k]?.configured);
      if (on.length) return r.app_secret_set ? ok(on.map((k) => names[k]).join(', ')) : partial(`${on.map((k) => names[k]).join(', ')} · App-Secret fehlt (Webhooks)`);
      return r.app_secret_set ? partial('App-Secret da – noch kein Kanal') : missing('Kein Kanal verbunden');
    },
    email: async (ctx, loc) => {
      const l = await get(ctx, '/api/location', loc);
      const p = String(l.settings?.email?.provider ?? 'log');
      return p && p !== 'log' ? ok(`Versand über ${p.toUpperCase()}`) : missing('Nur Protokoll – E-Mails gehen nicht raus');
    },
    google_microsoft: async (ctx) => {
      const p = await get(ctx, '/api/oauth/providers');
      const apps = [p.google && 'Google', p.microsoft && 'Microsoft'].filter(Boolean) as string[];
      if (!apps.length) return missing('OAuth-App fehlt (Agentur)');
      const conns = await get(ctx, '/api/me/calendar-connections').catch(() => null);
      const list = Array.isArray(conns) ? conns : (conns?.connections ?? []);
      return list.length ? ok(`${plural(list.length, 'Kalender', 'Kalender')} verbunden (${apps.join(', ')})`) : partial(`${apps.join(', ')} bereit – noch kein Kalender verbunden`);
    },
    google_business: async (ctx, loc) => {
      const r = await get(ctx, '/api/google-reviews/business', loc);
      if (r.ready) return ok(r.location_title || 'verbunden');
      if (r.connected) return partial(r.needs_reconnect ? 'Neu verbinden' : 'Standort wählen');
      return missing(r.configured ? 'Noch nicht verbunden' : 'OAuth-App fehlt (Agentur)');
    },
    anthropic: async (ctx, loc) => {
      const r = await get(ctx, '/api/ai/settings', loc);
      if (!r.key_set && r.key_source !== 'server') return missing('Kein Anthropic-Schlüssel');
      const src = r.key_set ? `Schlüssel ${r.key_hint ?? ''}`.trim() : 'Server-Schlüssel';
      return r.settings?.enabled ? ok(`${src} · Assistent an`) : partial(`${src} · Assistent aus`);
    },
    mcp: async (ctx, loc) => {
      const keys = await get(ctx, '/api/api-keys', loc);
      return keys.length ? ok(plural(keys.length, 'API-Schlüssel', 'API-Schlüssel')) : info('Bereit – Schlüssel anlegen');
    },
    ads: async (ctx, loc) => {
      const list: any[] = await get(ctx, '/api/ads/accounts', loc);
      const on = list.filter((a) => a.connected).map((a) => (a.platform === 'meta' ? 'Meta Ads' : 'Google Ads'));
      return on.length ? ok(on.join(', ')) : missing('Kein Werbekonto verbunden');
    },
    zapier: viaApp('zapier', 'Zapier'),
    make: viaApp('make', 'Make'),
    n8n: viaApp('n8n', 'n8n'),
    rest_hooks: (_ctx, loc) => {
      const n = hooks(loc);
      const off = Number(app.db.get(`SELECT COUNT(*) n FROM rest_hooks WHERE location_id = ? AND status = 'disabled'`, loc)?.n ?? 0);
      const failed = Number(app.db.get(`SELECT COUNT(*) n FROM rest_hook_deliveries WHERE location_id = ? AND status IN ('failed','gone') AND created_at >= ?`, loc, new Date(Date.now() - 7 * 864e5).toISOString())?.n ?? 0);
      if (off || failed) return partial(`${plural(n, 'aktives Abo', 'aktive Abos')}${off ? `, ${off} deaktiviert` : ''}${failed ? `, ${failed} Fehlzustellungen (7 Tage)` : ''}`);
      return n ? ok(plural(n, 'aktives Abo', 'aktive Abos')) : info('Bereit – /api/hooks');
    },
    inbound_webhooks: (_ctx, loc) => {
      const n = Number(app.db.get(`SELECT COUNT(*) n FROM inbound_webhooks i JOIN workflows w ON w.id = i.workflow_id WHERE i.location_id = ? AND json_extract(w.trigger, '$.type') = 'webhook.received'`, loc)?.n ?? 0);
      return n ? ok(plural(n, 'Workflow', 'Workflows')) : info('Bereit – Auslöser „Webhook empfangen“');
    },
    hubspot: (_ctx, loc) => {
      const s = app.services.hubspotStatus?.(loc);
      if (!s) return info('Bereit');
      return s.connected ? ok(`Portal ${s.portal_id}${s.last_import_at ? ' · importiert' : ''}`) : info('Bereit – Private-App-Token eintragen');
    },
    ghl: () => info('Bereit'),
  };

  const agency: Record<string, Probe> = {
    email: async (ctx) => {
      const list: any[] = await get(ctx, '/api/agency/mail-accounts');
      return list.length ? ok(plural(list.length, 'IMAP-Postfach', 'IMAP-Postfächer')) : missing('Kein IMAP-Postfach');
    },
    google_microsoft: async (ctx) => {
      const r = await get(ctx, '/api/agency/oauth');
      const on = [r.google?.client_id && r.google?.secret_set && 'Google', r.microsoft?.client_id && r.microsoft?.secret_set && 'Microsoft'].filter(Boolean) as string[];
      return on.length ? ok(`OAuth-App: ${on.join(', ')}`) : missing('Keine OAuth-App eingetragen');
    },
    mcp: async (ctx) => {
      const keys: any[] = await get(ctx, '/api/agency/api-keys');
      return keys.length ? ok(plural(keys.length, 'Agentur-Schlüssel', 'Agentur-Schlüssel')) : info('Bereit – Agentur-Schlüssel anlegen');
    },
    norman: async (ctx) => {
      const keys: any[] = await get(ctx, '/api/agency/api-keys');
      let links = 0;
      try {
        links = Number(app.db.get(`SELECT COUNT(*) n FROM invoice_links WHERE provider = 'norman'`)?.n ?? 0);
      } catch {
        /* invoice links module missing */
      }
      if (links) return ok(`${plural(links, 'Rechnung', 'Rechnungen')} verknüpft`);
      return keys.length ? partial('Schlüssel da – noch keine Rechnung verknüpft') : missing('Kein Agentur-Schlüssel für Norman');
    },
    todoist: async (ctx) => {
      const r = await get(ctx, '/api/agency/todoist');
      if (!r.token_set) return missing('Kein Todoist-Token');
      return r.enabled ? ok(r.account?.name ? `Konto ${r.account.name}` : 'Abgleich an') : partial('Token da – Abgleich aus');
    },
    postiz: () => (postizConfig(app) ? ok('Postiz verbunden') : missing('Keine Postiz-Adresse/-Schlüssel')),
    supabase: async (ctx) => {
      const r = await get(ctx, '/api/agency/supabase');
      if (!r.key_set || !r.url) return missing('Keine Supabase-Zugangsdaten');
      if (r.state?.error) return partial(`Fehler: ${String(r.state.error).slice(0, 80)}`);
      return r.enabled ? ok('Spiegel läuft') : partial('Ausgeschaltet');
    },
  };
  return { location, agency };
}

async function run(p: Probe | undefined, ctx: Ctx, loc: string): Promise<ProbeResult | undefined> {
  if (!p) return undefined;
  try {
    return await p(ctx, loc);
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 404) return { status: 'unavailable', detail: 'Modul nicht installiert' };
    if (status === 403) return info('Wird von der Agentur eingerichtet');
    return { status: 'unavailable', detail: (e as Error).message.slice(0, 120) };
  }
}

const out = (e: CatalogEntry, r: ProbeResult) => ({ ...e, ...r });

/** Other modules add entries with their own probes: app.services.catalogExtra = [...(…), { entry, agency?, location? }]. */
export interface CatalogExtra {
  entry: CatalogEntry;
  agency?: Probe;
  location?: Probe;
}

export const integrationsCatalogModule: Module = {
  name: 'integrations-catalog',
  register(app) {
    const p = probes(app);
    const entries = (): CatalogEntry[] => {
      const extras: CatalogExtra[] = app.services.catalogExtra ?? [];
      for (const x of extras) {
        if (x.agency) p.agency[x.entry.key] = x.agency;
        if (x.location) p.location[x.entry.key] = x.location;
      }
      return [...CATALOG, ...extras.map((x) => x.entry)];
    };

    app.router.get('/api/integrations/catalog', 'location', async (ctx) => {
      const isAdmin = ctx.user?.role === 'admin';
      const items = [];
      for (const e of entries()) {
        const r = (await run(p.location[e.key], ctx, ctx.locationId)) ?? (isAdmin ? await run(p.agency[e.key], ctx, ctx.locationId) : undefined) ?? info('Wird von der Agentur eingerichtet');
        items.push(out(e, r));
      }
      return { scope: 'location', categories: CATEGORIES, items };
    });

    app.router.get('/api/agency/integrations/catalog', 'admin', async (ctx) => {
      const locs = app.db.all('SELECT id FROM locations ORDER BY name').map((l) => String(l.id));
      const items = [];
      for (const e of entries()) {
        const own = await run(p.agency[e.key], ctx, '');
        const perLocation = e.scope !== 'agency' && e.key !== 'google_microsoft' && p.location[e.key];
        let agg: ProbeResult | undefined;
        if (perLocation) {
          const results: ProbeResult[] = [];
          for (const l of locs) results.push((await run(p.location[e.key], ctx, l))!);
          agg = aggregate(results);
        }
        const r = own && agg ? { status: own.status === 'ok' || agg.status === 'ok' ? 'ok' : own.status, detail: `${own.detail} · ${agg.detail}` } : (own ?? agg ?? info('Bereit'));
        items.push(out(e, r as ProbeResult));
      }
      return { scope: 'agency', categories: CATEGORIES, locations: locs.length, items };
    });
  },
};

