import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, str } from '../core/http.js';
import { id, normalizePhone, now } from '../core/util.js';
import {
  ADDRESS_SID,
  BUNDLE_SID,
  COUNTRY,
  CONSOLE,
  NUMBER_TYPES,
  NUMBER_TYPE_LABEL,
  mapAddresses,
  mapAvailable,
  mapBundles,
  mapPricing,
  regulatoryError,
  regulatoryRule,
  searchParams,
  twilioHostRequest,
  type NumberType,
} from '../services/twilio-numbers.js';
import { E164, NUMBER_SID, dialTwiml } from '../services/twilio.js';
import { recordNotice, telephonyConfig, twilioRequest, updateConfiguredNumbers, type CallRouteInput } from './telephony.js';

/**
 * Phone numbers of a sub-account: the registry (every number with its label, kind and where its calls go), buying and
 * releasing numbers through the connected Twilio account (search by country, area and type; the German address and
 * regulatory bundle are surfaced, not hidden) and the routing of an inbound call by the number that was dialled.
 * A number without a route behaves as before (ring the forwarding numbers and browsers, voicemail). Tracking numbers
 * and number pools for campaigns are rows of the same table (modules/telephony-dni.ts).
 */

export const ROUTE_KINDS = ['default', 'ivr', 'group', 'ai', 'voicemail', 'forward', 'user'] as const;
export type RouteKind = (typeof ROUTE_KINDS)[number];
export const ROUTE_LABEL: Record<RouteKind, string> = {
  default: 'Standard (Weiterleitung, Voicemail)',
  ivr: 'Telefonmenü (IVR)',
  group: 'Ruf-Gruppe oder Warteschlange',
  ai: 'KI-Telefonagent',
  voicemail: 'Direkt auf die Voicemail',
  forward: 'An eine feste Nummer',
  user: 'An eine Person (Browser-Telefon)',
};
export const KINDS = ['main', 'tracking', 'pool'] as const;

export interface NumberRow {
  id: string;
  location_id: string;
  number: string;
  sid: string;
  label: string;
  kind: (typeof KINDS)[number];
  country: string;
  number_type: string;
  route_kind: RouteKind;
  route_id: string;
  pool_id: string | null;
  source: string;
  medium: string;
  campaign: string;
  status: 'active' | 'released';
  address_sid: string;
  bundle_sid: string;
  price: string;
  purchased_at: string | null;
  released_at: string | null;
  created_at: string;
  updated_at: string;
}

/** What a number route does with a call: the module that owns the kind registers a handler in `app.services.callRouteKinds`. */
export type RouteHandler = (input: CallRouteInput & { number: NumberRow }) => string | undefined;

const COUNTRY_BY_PREFIX: [string, string][] = [['+49', 'DE'], ['+43', 'AT'], ['+41', 'CH']];
const countryOf = (n: string) => COUNTRY_BY_PREFIX.find(([p]) => n.startsWith(p))?.[1] ?? '';

export const telephonyNumbersModule: Module = {
  name: 'telephony-numbers',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE phone_numbers (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        number TEXT NOT NULL, sid TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'main', country TEXT NOT NULL DEFAULT '', number_type TEXT NOT NULL DEFAULT '',
        route_kind TEXT NOT NULL DEFAULT 'default', route_id TEXT NOT NULL DEFAULT '',
        pool_id TEXT, source TEXT NOT NULL DEFAULT '', medium TEXT NOT NULL DEFAULT '', campaign TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active', address_sid TEXT NOT NULL DEFAULT '', bundle_sid TEXT NOT NULL DEFAULT '',
        price TEXT NOT NULL DEFAULT '', purchased_at TEXT, released_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(location_id, number)
      );
      CREATE INDEX phone_numbers_pool ON phone_numbers(pool_id, status);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const hook = (name: string, loc: string) => `${app.baseUrl()}/hooks/twilio/${name}/${loc}`;
    app.services.callRouteKinds ??= {} as Record<string, RouteHandler>;
    const kinds = app.services.callRouteKinds as Record<string, RouteHandler>;

    // --- registry --------------------------------------------------------------------------------------------------
    /** Numbers set up in the telephony settings (or by the SMS settings) become rows, so they can get a route and a label. */
    const syncRegistry = (locationId: string) => {
      const cfg = telephonyConfig(app, locationId);
      for (const n of cfg.numbers) {
        if (db.get('SELECT 1 FROM phone_numbers WHERE location_id = ? AND number = ?', locationId, n)) continue;
        db.insert('phone_numbers', { id: id(), location_id: locationId, number: n, country: countryOf(n), created_at: now(), updated_at: now() });
      }
    };
    const rowOf = (locationId: string, key: string) => db.get<NumberRow>('SELECT * FROM phone_numbers WHERE location_id = ? AND id = ?', locationId, key);

    const routeLabel = (locationId: string, kind: string, rid: string): string => {
      switch (kind) {
        case 'ivr':
          return db.get<{ name: string }>('SELECT name FROM ivr_flows WHERE id = ? AND location_id = ?', rid, locationId)?.name ?? '(gelöscht)';
        case 'group':
          return db.get<{ name: string }>('SELECT name FROM call_groups WHERE id = ? AND location_id = ?', rid, locationId)?.name ?? '(gelöscht)';
        case 'user':
          return db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', rid)?.name ?? '(gelöscht)';
        case 'forward':
        case 'voicemail':
          return rid;
        default:
          return '';
      }
    };

    const out = (locationId: string, r: NumberRow, calls: Map<string, number>) => ({
      id: r.id,
      number: r.number,
      label: r.label,
      kind: r.kind,
      country: r.country,
      number_type: r.number_type,
      route_kind: r.route_kind,
      route_id: r.route_id,
      route_label: routeLabel(locationId, r.route_kind, r.route_id),
      pool_id: r.pool_id,
      source: r.source,
      medium: r.medium,
      campaign: r.campaign,
      status: r.status,
      managed: !!r.sid,
      price: r.price,
      purchased_at: r.purchased_at,
      released_at: r.released_at,
      calls_30d: calls.get(r.number) ?? 0,
    });

    router.get('/api/telephony/registry', 'location', (ctx) => {
      syncRegistry(ctx.locationId);
      const since = new Date(Date.now() - 30 * 864e5).toISOString();
      const calls = new Map(db.all<{ to_number: string; n: number }>(`SELECT to_number, COUNT(*) n FROM calls WHERE location_id = ? AND direction = 'in' AND started_at >= ? GROUP BY to_number`, ctx.locationId, since).map((r) => [r.to_number, r.n]));
      const rows = db.all<NumberRow>(`SELECT * FROM phone_numbers WHERE location_id = ? AND status = 'active' ORDER BY kind, created_at`, ctx.locationId);
      const released = db.all<NumberRow>(`SELECT * FROM phone_numbers WHERE location_id = ? AND status = 'released' ORDER BY released_at DESC LIMIT 20`, ctx.locationId);
      return {
        numbers: rows.map((r) => out(ctx.locationId, r, calls)),
        released: released.map((r) => out(ctx.locationId, r, calls)),
        route_kinds: ROUTE_KINDS.map((k) => ({ key: k, label: ROUTE_LABEL[k] })),
        flows: db.all('SELECT id, name FROM ivr_flows WHERE location_id = ? ORDER BY name', ctx.locationId),
        groups: db.all('SELECT id, name, kind FROM call_groups WHERE location_id = ? ORDER BY name', ctx.locationId),
        pools: db.all('SELECT id, name FROM dni_pools WHERE location_id = ? ORDER BY name', ctx.locationId),
        ready: telephonyConfig(app, ctx.locationId).ready,
      };
    });

    router.patch('/api/telephony/registry/:id', 'location', (ctx) => {
      const r = rowOf(ctx.locationId, ctx.params.id);
      if (!r || r.status !== 'active') throw notFound('Nummer nicht gefunden');
      const b = ctx.body ?? {};
      const patch: Record<string, unknown> = {};
      if (b.label !== undefined) patch.label = str(b.label, 'Bezeichnung', { max: 80 });
      if (b.kind !== undefined) {
        if (!(KINDS as readonly string[]).includes(b.kind)) throw bad('Art: Hauptnummer, Tracking-Nummer oder Pool');
        patch.kind = b.kind;
        if (b.kind !== 'pool') patch.pool_id = null;
      }
      if (b.pool_id !== undefined && (patch.kind ?? r.kind) === 'pool') {
        const pid = str(b.pool_id, 'Pool', { max: 40 });
        if (!pid || !db.get('SELECT 1 FROM dni_pools WHERE id = ? AND location_id = ?', pid, ctx.locationId)) throw bad('Pool nicht gefunden');
        patch.pool_id = pid;
      }
      if ((patch.kind ?? r.kind) === 'pool' && !(patch.pool_id ?? r.pool_id)) throw bad('Bitte einen Pool wählen');
      for (const k of ['source', 'medium', 'campaign'] as const) if (b[k] !== undefined) patch[k] = str(b[k], k, { max: 100 }).toLowerCase();
      if (b.route_kind !== undefined || b.route_id !== undefined) {
        const kind = (b.route_kind ?? r.route_kind) as RouteKind;
        if (!ROUTE_KINDS.includes(kind)) throw bad('Ziel unbekannt');
        let rid = str(b.route_id ?? (kind === r.route_kind ? r.route_id : ''), 'Ziel', { max: 80 });
        if (kind === 'ivr' && !db.get('SELECT 1 FROM ivr_flows WHERE id = ? AND location_id = ?', rid, ctx.locationId)) throw bad('Telefonmenü nicht gefunden');
        if (kind === 'group' && !db.get('SELECT 1 FROM call_groups WHERE id = ? AND location_id = ?', rid, ctx.locationId)) throw bad('Ruf-Gruppe nicht gefunden');
        if (kind === 'forward') {
          rid = normalizePhone(rid);
          if (!E164.test(rid)) throw bad('Weiterleitung: keine gültige Nummer (Format +49…)');
          if (db.get('SELECT 1 FROM phone_numbers WHERE location_id = ? AND number = ? AND status = ?', ctx.locationId, rid, 'active')) throw bad('Die Weiterleitung darf nicht auf eine eigene Nummer zeigen');
        }
        if (kind === 'user') {
          const u = db.get<{ locations: string; role: string }>('SELECT locations, role FROM users WHERE id = ?', rid);
          if (!u || (u.role !== 'admin' && !JSON.parse(u.locations || '[]').includes(ctx.locationId))) throw bad('Person nicht gefunden');
        }
        if (kind === 'default') rid = '';
        patch.route_kind = kind;
        patch.route_id = rid;
      }
      if (Object.keys(patch).length) {
        patch.updated_at = now();
        db.update('phone_numbers', r.id, patch, ctx.locationId);
      }
      return out(ctx.locationId, rowOf(ctx.locationId, r.id)!, new Map());
    });

    // --- buy, search, release (Twilio) -----------------------------------------------------------------------------
    const needTwilio = (locationId: string) => {
      const cfg = telephonyConfig(app, locationId);
      if (!cfg.accountSid || !cfg.token) throw bad('Erst Account SID und Auth Token der Telefonie eintragen (Einstellungen → Telefonie)');
      return cfg;
    };
    const asType = (v: string | null): NumberType => {
      const t = (v || 'local') as NumberType;
      if (!(t in NUMBER_TYPES)) throw bad('Art: Ortsnummer, Mobilnummer oder gebührenfrei');
      return t;
    };
    const asCountry = (v: string | null) => {
      const c = String(v || 'DE').toUpperCase();
      if (!COUNTRY.test(c)) throw bad('Land als Zwei-Buchstaben-Kürzel (z. B. DE)');
      return c;
    };
    const twilioNotFound = (e: unknown) => e instanceof HttpError && (e.data as { twilio_code?: number } | undefined)?.twilio_code === 20404;

    /** Numbers Twilio has in stock for a country, type and area code. */
    router.get('/api/telephony/numbers/search', 'location', async (ctx) => {
      const cfg = needTwilio(ctx.locationId);
      const country = asCountry(ctx.query.get('country'));
      const type = asType(ctx.query.get('type'));
      const params = searchParams({ area_code: ctx.query.get('area_code') ?? '', contains: ctx.query.get('contains') ?? '', limit: Number(ctx.query.get('limit') ?? 20) });
      let numbers: ReturnType<typeof mapAvailable> = [];
      try {
        const j = await twilioRequest(app, cfg, 'GET', `/AvailablePhoneNumbers/${country}/${NUMBER_TYPES[type]}.json?${new URLSearchParams(params)}`);
        numbers = mapAvailable(j, type);
      } catch (e) {
        if (!twilioNotFound(e)) throw e;
        throw bad(`Twilio hat in ${country} keine ${NUMBER_TYPE_LABEL[type]}n zum Kauf.`);
      }
      return { country, type, numbers, rule: regulatoryRule(country), types: Object.entries(NUMBER_TYPE_LABEL).map(([key, label]) => ({ key, label })) };
    });

    /** Monthly prices of a country (best effort: the pricing API may be closed to the account). */
    router.get('/api/telephony/numbers/pricing', 'location', async (ctx) => {
      const cfg = needTwilio(ctx.locationId);
      const country = asCountry(ctx.query.get('country'));
      try {
        return { country, pricing: mapPricing(await twilioHostRequest(app, cfg, 'pricing', 'GET', `/v1/PhoneNumbers/Countries/${country}`)) };
      } catch {
        return { country, pricing: null };
      }
    });

    /** Addresses and regulatory bundles of the Twilio account – what a number in a regulated country needs. */
    router.get('/api/telephony/regulatory', 'location', async (ctx) => {
      const cfg = needTwilio(ctx.locationId);
      const country = asCountry(ctx.query.get('country'));
      const type = asType(ctx.query.get('type'));
      const rule = regulatoryRule(country);
      const problems: string[] = [];
      let addresses: ReturnType<typeof mapAddresses> = [];
      let bundles: ReturnType<typeof mapBundles> = [];
      try {
        addresses = mapAddresses(await twilioRequest(app, cfg, 'GET', `/Addresses.json?${new URLSearchParams({ IsoCountry: country, PageSize: '50' })}`));
      } catch (e) {
        problems.push(`Adressen ließen sich nicht laden: ${(e as Error).message}`);
      }
      try {
        const nt = type === 'toll_free' ? 'toll-free' : type;
        bundles = mapBundles(await twilioHostRequest(app, cfg, 'numbers', 'GET', '/v2/RegulatoryCompliance/Bundles', [['IsoCountry', country], ['NumberType', nt], ['PageSize', '50']]));
      } catch (e) {
        problems.push(`Regulatory Bundles ließen sich nicht laden: ${(e as Error).message}`);
      }
      const ready = (!rule?.address || addresses.length > 0) && (!rule?.bundle || bundles.some((b) => b.approved));
      return { country, type, rule, addresses, bundles, console: CONSOLE, ready, problems };
    });

    /** Buys a number and points its webhooks here. Costs money at Twilio, hence the explicit `confirm`. */
    router.post('/api/telephony/numbers/buy', 'location', async (ctx) => {
      const b = ctx.body ?? {};
      if (b.confirm !== true) throw bad('Bitte den Kauf bestätigen – die Nummer kostet bei Twilio eine monatliche Gebühr.');
      const number = String(b.phone_number ?? '').trim();
      if (!E164.test(number)) throw bad('Nummer ungültig (Format +49…)');
      const cfg = needTwilio(ctx.locationId);
      const kind = (b.kind ?? 'main') as (typeof KINDS)[number];
      if (!KINDS.includes(kind)) throw bad('Art: Hauptnummer, Tracking-Nummer oder Pool');
      let poolId: string | null = null;
      if (kind === 'pool') {
        poolId = str(b.pool_id, 'Pool', { required: true, max: 40 });
        if (!db.get('SELECT 1 FROM dni_pools WHERE id = ? AND location_id = ?', poolId, ctx.locationId)) throw bad('Pool nicht gefunden');
      }
      const addressSid = str(b.address_sid, 'Adresse', { max: 40 });
      const bundleSid = str(b.bundle_sid, 'Bundle', { max: 40 });
      if (addressSid && !ADDRESS_SID.test(addressSid)) throw bad('Adress-SID ungültig (beginnt mit AD)');
      if (bundleSid && !BUNDLE_SID.test(bundleSid)) throw bad('Bundle-SID ungültig (beginnt mit BU)');
      const existing = rowOf2(ctx.locationId, number);
      if (existing?.status === 'active') throw new HttpError(409, 'Diese Nummer gehört schon zu diesem Sub-Account');
      const loc = app.location(ctx.locationId)!;
      const label = str(b.label, 'Bezeichnung', { max: 80 }) || `${loc.name} ${number}`.slice(0, 80);
      const params: [string, string][] = [
        ['PhoneNumber', number],
        ['FriendlyName', label.slice(0, 64)],
        ['VoiceUrl', hook('voice', ctx.locationId)],
        ['VoiceMethod', 'POST'],
        ['StatusCallback', hook('voice-status', ctx.locationId)],
        ['StatusCallbackMethod', 'POST'],
        ...(addressSid ? [['AddressSid', addressSid] as [string, string]] : []),
        ...(bundleSid ? [['BundleSid', bundleSid] as [string, string]] : []),
      ];
      const country = COUNTRY.test(String(b.country ?? '').toUpperCase()) ? String(b.country).toUpperCase() : countryOf(number);
      let j: any;
      try {
        j = await twilioRequest(app, cfg, 'POST', '/IncomingPhoneNumbers.json', params);
      } catch (e) {
        const msg = regulatoryError((e as HttpError).data?.twilio_code, (e as Error).message, country);
        if (msg) throw new HttpError(400, msg, { regulatory: true, console: CONSOLE });
        throw e;
      }
      const sid = String(j.sid ?? '');
      if (!NUMBER_SID.test(sid)) throw new HttpError(502, 'Twilio hat die Nummer nicht eingerichtet');
      const bought = E164.test(String(j.phone_number ?? '')) ? String(j.phone_number) : number;
      const row = {
        id: existing?.id ?? id(),
        location_id: ctx.locationId,
        number: bought,
        sid,
        label,
        kind,
        country,
        number_type: asType(String(b.type ?? 'local')),
        pool_id: poolId,
        source: str(b.source, 'Quelle', { max: 100 }).toLowerCase(),
        medium: str(b.medium, 'Medium', { max: 100 }).toLowerCase(),
        campaign: str(b.campaign, 'Kampagne', { max: 100 }).toLowerCase(),
        status: 'active',
        address_sid: addressSid,
        bundle_sid: bundleSid,
        price: str(b.price, 'Preis', { max: 40 }),
        purchased_at: now(),
        released_at: null,
        route_kind: 'default',
        route_id: '',
        updated_at: now(),
      };
      if (existing) db.update('phone_numbers', existing.id, row, ctx.locationId);
      else db.insert('phone_numbers', { ...row, created_at: now() });
      if (kind === 'main') updateConfiguredNumbers(app, ctx.locationId, (list) => [...list, bought]);
      app.events.emit(ctx.locationId, 'phone_number.bought', { number: bought, kind });
      return out(ctx.locationId, rowOf(ctx.locationId, row.id)!, new Map());
    });
    const rowOf2 = (locationId: string, number: string) => db.get<NumberRow>('SELECT * FROM phone_numbers WHERE location_id = ? AND number = ?', locationId, number);

    /** Gives the number back to Twilio (it stops costing money and can ring nowhere). */
    router.post('/api/telephony/numbers/:id/release', 'location', async (ctx) => {
      if (ctx.body?.confirm !== true) throw bad('Bitte bestätigen – die Nummer geht an Twilio zurück und lässt sich nicht zurückholen.');
      const r = rowOf(ctx.locationId, ctx.params.id);
      if (!r || r.status !== 'active') throw notFound('Nummer nicht gefunden');
      if (!NUMBER_SID.test(r.sid)) throw bad('Diese Nummer wurde nicht hier gekauft – bitte in der Twilio-Konsole freigeben');
      const cfg = needTwilio(ctx.locationId);
      try {
        await twilioRequest(app, cfg, 'DELETE', `/IncomingPhoneNumbers/${r.sid}.json`);
      } catch (e) {
        // Already gone at Twilio: the registry follows.
        if (!twilioNotFound(e)) throw e;
      }
      db.run(`UPDATE phone_numbers SET status = 'released', released_at = ?, pool_id = NULL, route_kind = 'default', route_id = '', updated_at = ? WHERE id = ?`, now(), now(), r.id);
      updateConfiguredNumbers(app, ctx.locationId, (list) => list.filter((n) => n !== r.number));
      app.events.emit(ctx.locationId, 'phone_number.released', { number: r.number });
      return { ok: true };
    });

    // --- routing by the number that was dialled -----------------------------------------------------------------------
    app.services.callRouters = [
      ...(app.services.callRouters ?? []),
      (input: CallRouteInput): string | undefined => {
        const to = String(input.call.to_number ?? '');
        const n = to ? db.get<NumberRow>(`SELECT * FROM phone_numbers WHERE location_id = ? AND number = ? AND status = 'active'`, input.loc.id, to) : undefined;
        if (!n) return undefined;
        // The campaign's name stays on the call even when its route is the default one.
        if (n.route_kind === 'default' || !kinds[n.route_kind]) return undefined;
        db.run('UPDATE calls SET route_kind = ?, route_id = ? WHERE id = ?', n.route_kind, n.route_id, input.call.id);
        return kinds[n.route_kind]({ ...input, call: db.get('SELECT * FROM calls WHERE id = ?', input.call.id) ?? input.call, number: n });
      },
    ];

    const kit = () => app.services.telephonyKit;
    /** Rings numbers and/or browsers like the default flow does (recording notice included). */
    const ring = (i: CallRouteInput, numbers: string[], clients: { identity: string; params?: Record<string, string> }[]) => {
      const announce = i.cfg.s.record_inbound && i.cfg.s.record_announce;
      if (announce) db.run('UPDATE calls SET consent_announced = 1 WHERE id = ?', i.call.id);
      return dialTwiml({
        numbers,
        clients,
        timeout: i.cfg.s.ring_timeout,
        action: hook('voice-dial', i.loc.id),
        record: i.cfg.s.record_inbound,
        recordingCallback: `${hook('voice-recording', i.loc.id)}?kind=dial`,
        announce: announce ? recordNotice(i.cfg.s) : undefined,
      });
    };
    /** Straight to the KI-Telefonagent (even when its mode would not answer right now); without it the normal flow goes on. */
    kinds.ai = (i) => app.services.voiceAgent?.({ stage: 'inbound', loc: i.loc, call: i.call, open: i.open, force: true });
    kinds.voicemail = (i) => kit().voicemail(i.loc, i.cfg, i.call, { box: i.number.route_id, record: true });
    kinds.forward = (i) => (E164.test(i.number.route_id) ? ring(i, [i.number.route_id], []) : undefined);
    kinds.user = (i) => {
      const client = app.services.voiceUserClient?.(i.loc.id, i.number.route_id, i.call);
      // The person's browser is not open: the normal flow (voicemail, KI) takes over.
      return client ? ring(i, [], [client]) : undefined;
    };
  },
};
