import type { Ctx } from '../core/http.js';
import type { Module } from '../core/app.js';
import { bad, notFound, num, str, text } from '../core/http.js';
import { id, now } from '../core/util.js';
import { toCsv } from '../core/csv.js';
import { ymdInTz, zonedToUtc } from '../core/time.js';
import { CONSENT_COOKIE, VISITOR_COOKIE, parseTouch, sourceLabel, verifyVisitor } from '../services/attribution.js';
import { dniScript, formatDisplay, matchesSources, pickNumber } from '../services/dni.js';
import { E164 } from '../services/twilio.js';
import type { CallRouteInput } from './telephony.js';
import type { NumberRow } from './telephony-numbers.js';

/**
 * Tracking numbers and dynamic number insertion (DNI): which campaign made the phone ring. A static tracking number belongs
 * to one campaign (print ad, flyer, Google Business profile). A pool of numbers serves websites and funnels: a small
 * script swaps the number on the page for every visitor, every running visit gets its own number from the pool, and an
 * inbound call on that number is attributed to the visit's source, medium and campaign – on the call and, through the
 * existing attribution (modules/attribution.ts), on the contact (first and last touch, reports, deals, revenue). The script
 * respects the visitor's cookie choice like the tracking script and stores nothing personal: a random visit id, the source.
 */

interface PoolRow {
  id: string;
  location_id: string;
  name: string;
  enabled: number;
  default_number: string;
  fallback_number: string;
  session_minutes: number;
  attribution_minutes: number;
  sources: string;
  on_funnels: number;
  exhausted: 'fallback' | 'oldest';
  selector: string;
  created_at: string;
  updated_at: string;
}
interface SessionRow {
  id: string;
  location_id: string;
  pool_id: string;
  number_id: string;
  number: string;
  visitor_id: string;
  channel: string;
  source: string;
  medium: string;
  campaign: string;
  content: string;
  term: string;
  gclid: string;
  fbclid: string;
  landing_page: string;
  referrer: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  calls: number;
}

/** Characters a CSS selector for extra elements may contain (it is sent to the browser as data, never as code). */
const SELECTOR = /^[\w\s.#\[\]="'>,:*~+()^$|-]{0,200}$/;
const intlOf = (e164: string) => (e164.startsWith('+49') ? `+49 ${formatDisplay(e164).slice(1)}` : formatDisplay(e164));

/** Running visits per pool that get a session row of their own (see the public session route). */
export const MAX_ACTIVE = 5000;

export const telephonyDniModule: Module = {
  name: 'telephony-dni',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE dni_pools (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        default_number TEXT NOT NULL DEFAULT '', fallback_number TEXT NOT NULL DEFAULT '',
        session_minutes INTEGER NOT NULL DEFAULT 30, attribution_minutes INTEGER NOT NULL DEFAULT 120,
        sources TEXT NOT NULL DEFAULT '[]', on_funnels INTEGER NOT NULL DEFAULT 1, exhausted TEXT NOT NULL DEFAULT 'fallback',
        selector TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX dni_pools_loc ON dni_pools(location_id);
      CREATE TABLE dni_sessions (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        pool_id TEXT NOT NULL REFERENCES dni_pools(id) ON DELETE CASCADE, number_id TEXT NOT NULL, number TEXT NOT NULL,
        visitor_id TEXT NOT NULL DEFAULT '', channel TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '',
        medium TEXT NOT NULL DEFAULT '', campaign TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', term TEXT NOT NULL DEFAULT '',
        gclid TEXT NOT NULL DEFAULT '', fbclid TEXT NOT NULL DEFAULT '', landing_page TEXT NOT NULL DEFAULT '', referrer TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX dni_sessions_number ON dni_sessions(number_id, last_seen_at);
      CREATE INDEX dni_sessions_pool ON dni_sessions(pool_id, expires_at);
      CREATE INDEX dni_sessions_visitor ON dni_sessions(location_id, pool_id, visitor_id);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const sourcesOf = (p: Pick<PoolRow, 'sources'>): string[] => {
      try {
        const v = JSON.parse(p.sources);
        return Array.isArray(v) ? v.map(String) : [];
      } catch {
        return [];
      }
    };
    const poolRow = (locationId: string, key: string) => db.get<PoolRow>('SELECT * FROM dni_pools WHERE id = ? AND location_id = ?', key, locationId);
    const poolNumbers = (p: PoolRow) => db.all<NumberRow>(`SELECT * FROM phone_numbers WHERE location_id = ? AND pool_id = ? AND status = 'active' ORDER BY created_at`, p.location_id, p.id);
    const scriptUrl = (p: PoolRow) => `${app.baseUrl()}/a/${p.location_id}/dni.js?pool=${p.id}`;

    const poolOut = (p: PoolRow) => {
      const numbers = poolNumbers(p);
      const t = now();
      const since = new Date(Date.now() - 30 * 864e5).toISOString();
      const active = db.get<{ n: number }>('SELECT COUNT(*) n FROM dni_sessions WHERE pool_id = ? AND expires_at > ?', p.id, t)!.n;
      const calls = db.get<{ n: number }>(`SELECT COUNT(*) n FROM calls WHERE location_id = ? AND started_at >= ? AND tracking_number_id IN (SELECT id FROM phone_numbers WHERE pool_id = ?)`, p.location_id, since, p.id)!.n;
      return {
        id: p.id,
        name: p.name,
        enabled: !!p.enabled,
        default_number: p.default_number,
        fallback_number: p.fallback_number,
        session_minutes: p.session_minutes,
        attribution_minutes: p.attribution_minutes,
        sources: sourcesOf(p),
        on_funnels: !!p.on_funnels,
        exhausted: p.exhausted,
        selector: p.selector,
        numbers: numbers.map((n) => ({ id: n.id, number: n.number, label: n.label })),
        sessions_active: active,
        calls_30d: calls,
        snippet: `<script src="${scriptUrl(p)}" async></script>`,
        created_at: p.created_at,
      };
    };

    const cleanPool = (b: any, cur?: PoolRow) => {
      const out: Record<string, unknown> = {};
      if (b.name !== undefined || !cur) out.name = str(b.name ?? cur?.name, 'Name', { required: true, max: 80 });
      if (b.enabled !== undefined) out.enabled = b.enabled ? 1 : 0;
      for (const k of ['default_number', 'fallback_number'] as const) {
        if (b[k] === undefined) continue;
        const v = String(b[k] ?? '').trim();
        // The number as printed on the site: any way of writing it, but it must be a phone number.
        if (v && !/^\+?[\d\s()/.-]{5,25}$/.test(v)) throw bad(`${k === 'default_number' ? 'Nummer auf der Website' : 'Ersatznummer'}: keine Telefonnummer`);
        out[k] = v;
      }
      if (b.session_minutes !== undefined) out.session_minutes = Math.min(Math.max(Math.round(num(b.session_minutes, 30)), 5), 240);
      if (b.attribution_minutes !== undefined) out.attribution_minutes = Math.min(Math.max(Math.round(num(b.attribution_minutes, 120)), 0), 1440);
      if (b.sources !== undefined) {
        if (!Array.isArray(b.sources)) throw bad('Quellen als Liste');
        out.sources = JSON.stringify(b.sources.map((s: unknown) => String(s).trim().toLowerCase().slice(0, 60)).filter((s: string) => /^[\w*.-]+(\/[\w*.-]+)?$/.test(s)).slice(0, 30));
      }
      if (b.on_funnels !== undefined) out.on_funnels = b.on_funnels ? 1 : 0;
      if (b.exhausted !== undefined) {
        if (b.exhausted !== 'fallback' && b.exhausted !== 'oldest') throw bad('Wenn alle Nummern vergeben sind: Ersatznummer oder älteste teilen');
        out.exhausted = b.exhausted;
      }
      if (b.selector !== undefined) {
        const sel = String(b.selector ?? '').trim();
        if (!SELECTOR.test(sel)) throw bad('CSS-Selektor enthält unerlaubte Zeichen');
        out.selector = sel;
      }
      return out;
    };

    // --- API: pools ----------------------------------------------------------------------------------------------------
    router.get('/api/telephony/dni/pools', 'location', (ctx) => db.all<PoolRow>('SELECT * FROM dni_pools WHERE location_id = ? ORDER BY name', ctx.locationId).map(poolOut));
    router.post('/api/telephony/dni/pools', 'location', (ctx) => {
      const patch = cleanPool(ctx.body ?? {});
      const row = { id: id(), location_id: ctx.locationId, created_at: now(), updated_at: now(), ...patch };
      db.insert('dni_pools', row);
      return poolOut(poolRow(ctx.locationId, row.id)!);
    });
    router.put('/api/telephony/dni/pools/:id', 'location', (ctx) => {
      const p = poolRow(ctx.locationId, ctx.params.id);
      if (!p) throw notFound('Pool nicht gefunden');
      db.update('dni_pools', p.id, { ...cleanPool(ctx.body ?? {}, p), updated_at: now() }, ctx.locationId);
      return poolOut(poolRow(ctx.locationId, p.id)!);
    });
    router.delete('/api/telephony/dni/pools/:id', 'location', (ctx) => {
      const p = poolRow(ctx.locationId, ctx.params.id);
      if (!p) throw notFound('Pool nicht gefunden');
      // The numbers stay (and keep their calls' history) as plain tracking numbers.
      db.run(`UPDATE phone_numbers SET kind = 'tracking', pool_id = NULL, updated_at = ? WHERE location_id = ? AND pool_id = ?`, now(), ctx.locationId, p.id);
      db.run('DELETE FROM dni_pools WHERE id = ?', p.id);
      return { ok: true };
    });
    /** Puts numbers of this sub-account into the pool (and takes the ones not listed out). */
    router.put('/api/telephony/dni/pools/:id/numbers', 'location', (ctx) => {
      const p = poolRow(ctx.locationId, ctx.params.id);
      if (!p) throw notFound('Pool nicht gefunden');
      const ids: string[] = (Array.isArray(ctx.body?.number_ids) ? ctx.body.number_ids : []).map(String).slice(0, 100);
      db.tx(() => {
        db.run(`UPDATE phone_numbers SET kind = 'tracking', pool_id = NULL, updated_at = ? WHERE location_id = ? AND pool_id = ?`, now(), ctx.locationId, p.id);
        for (const nid of ids) db.run(`UPDATE phone_numbers SET kind = 'pool', pool_id = ?, updated_at = ? WHERE id = ? AND location_id = ? AND status = 'active'`, p.id, now(), nid, ctx.locationId);
      });
      return poolOut(poolRow(ctx.locationId, p.id)!);
    });

    // --- the visitor's side ---------------------------------------------------------------------------------------------
    router.get('/a/:loc/dni.js', 'public', (ctx) => {
      const loc = app.location(ctx.params.loc);
      const pool = loc ? poolRow(loc.id, ctx.query.get('pool') ?? '') : undefined;
      // Both answers are cached briefly like the attribution snippet (/a/:loc/t.js): switching the pool on or off shows within 5 minutes.
      const r = text(!loc || !pool?.enabled ? '/* number swap off */' : dniScript({ locationId: loc.id, poolId: pool.id, consentCookie: CONSENT_COOKIE, visitorCookie: VISITOR_COOKIE }), 'text/javascript; charset=utf-8');
      r.headers['cache-control'] = 'public, max-age=300';
      return r;
    });

    /** Link previews and crawlers are not visitors. */
    const isBot = (ctx: Ctx) => /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|whatsapp|telegram|curl|wget|python-requests/i.test(String(ctx.req.headers['user-agent'] ?? ''));
    const hits = new Map<string, number[]>();
    const shown = (number: string, extra: Record<string, unknown> = {}) => ({ number, display: number ? formatDisplay(number) : '', display_intl: number ? intlOf(number) : '', ...extra });

    /**
     * A visit asks for its number. The answer is the number to show (or none = leave the page as it is). No cookie is set here;
     * the browser keeps the session id in the tab. Visitors who said no, bots and visits that do not qualify get no swap.
     */
    router.post('/api/public/dni/:loc/session', 'public', (ctx) => {
      const t0 = Date.now();
      const list = (hits.get(ctx.ip) ?? []).filter((x) => t0 - x < 60_000);
      list.push(t0);
      hits.set(ctx.ip, list);
      if (hits.size > 20_000) hits.clear();
      if (list.length > 120) return shown('');
      const loc = app.location(ctx.params.loc);
      const b = ctx.body ?? {};
      const pool = loc ? poolRow(loc.id, String(b.pool ?? '')) : undefined;
      if (!loc || !pool?.enabled || isBot(ctx)) return shown('');
      const attr = app.services.attribution?.settings?.(loc.id);
      const denied = b.consent === 'denied' || (String(ctx.req.headers['sec-gpc'] ?? '') === '1' && b.consent !== 'granted');
      // Tracking off or refused: the page keeps the number it has (or the fallback, when one is set).
      if ((attr && attr.enabled === false) || denied) return shown(pool.fallback_number.startsWith('+') ? pool.fallback_number : '');
      const touch = parseTouch({ url: str(b.url, 'URL', { max: 2000 }), referrer: str(b.referrer, 'Referrer', { max: 2000 }), selfHosts: [] });
      if (!matchesSources(sourcesOf(pool), touch)) return shown('', { qualified: false });
      const visitorId = verifyVisitor(app.config.secret, b.token);
      const sid = /^[A-Za-z0-9]{16}$/.test(String(b.sid ?? '')) ? String(b.sid) : '';
      const t = now();
      const numbers = poolNumbers(pool).map((n) => ({ id: n.id, number: n.number }));
      // A pool that shares its numbers when all are busy would otherwise grow by one row per anonymous visit (and every visit reads them all):
      // past MAX_ACTIVE running sessions a visit still gets a number, but no new session.
      const active = db.all<SessionRow>('SELECT * FROM dni_sessions WHERE pool_id = ? AND expires_at > ? LIMIT ?', pool.id, t, MAX_ACTIVE + 1).map((s) => ({ id: s.id, number_id: s.number_id, visitor_id: s.visitor_id, last_seen_ms: Date.parse(s.last_seen_at) }));
      const lastUsed = new Map(db.all<{ number_id: string; at: string }>('SELECT number_id, MAX(last_seen_at) at FROM dni_sessions WHERE pool_id = ? GROUP BY number_id', pool.id).map((r) => [r.number_id, Date.parse(r.at)]));
      const pick = pickNumber({ numbers, active, lastUsed, sid, visitorId, exhausted: pool.exhausted });
      const expires = new Date(Date.now() + pool.session_minutes * 60_000).toISOString();
      const fallback = E164.test(pool.fallback_number) ? pool.fallback_number : '';
      if (!pick.number) return shown(fallback, { sid: '', default_number: pool.default_number, selector: pool.selector, pool_empty: true });
      let session = pick.reuse?.id;
      if (session) {
        db.run('UPDATE dni_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', t, expires, session);
      } else if (active.length > MAX_ACTIVE) {
        return shown(pick.number.number, { sid: '', default_number: pool.default_number, selector: pool.selector, shared: true });
      } else {
        session = id(16);
        db.insert('dni_sessions', {
          id: session,
          location_id: loc.id,
          pool_id: pool.id,
          number_id: pick.number.id,
          number: pick.number.number,
          visitor_id: visitorId,
          channel: touch.channel,
          source: touch.source,
          medium: touch.medium,
          campaign: touch.campaign,
          content: touch.content,
          term: touch.term,
          gclid: touch.gclid,
          fbclid: touch.fbclid,
          landing_page: touch.landing_page,
          referrer: str(b.referrer, 'Referrer', { max: 500 }),
          created_at: t,
          last_seen_at: t,
          expires_at: expires,
        });
      }
      return shown(pick.number.number, { sid: session, default_number: pool.default_number, selector: pool.selector, shared: pick.shared });
    });

    // Funnels and websites hosted here get the swap without a copied snippet.
    app.services.pageVisit = [
      ...(app.services.pageVisit ?? []),
      (_ctx: Ctx, funnel: { location_id: string }, _page: unknown, html: string) => {
        const pool = db.get<PoolRow>('SELECT * FROM dni_pools WHERE location_id = ? AND enabled = 1 AND on_funnels = 1 ORDER BY created_at LIMIT 1', funnel.location_id);
        if (!pool || !poolNumbers(pool).length || !html.includes('</body>')) return html;
        return html.replace('</body>', `<script src="${scriptUrl(pool)}" async></script></body>`);
      },
    ];

    // --- an inbound call: whose visit was this? -------------------------------------------------------------------------
    app.services.callInbound = [
      ...(app.services.callInbound ?? []),
      (i: CallRouteInput) => {
        const n = db.get<NumberRow>(`SELECT * FROM phone_numbers WHERE location_id = ? AND number = ? AND status = 'active' AND kind IN ('tracking', 'pool')`, i.loc.id, String(i.call.to_number ?? ''));
        if (!n) return;
        let attr: { source: string; medium: string; campaign: string; params: Record<string, string>; page: string; referrer: string; visitorId: string } | null = null;
        if (n.kind === 'tracking') {
          // A number printed for one campaign: every call on it comes from there.
          const source = n.source || 'telefon';
          attr = { source, medium: n.medium || 'tracking-nummer', campaign: n.campaign, params: { utm_source: source, utm_medium: n.medium || 'tracking-nummer', ...(n.campaign ? { utm_campaign: n.campaign } : {}) }, page: '', referrer: '', visitorId: '' };
        } else if (n.pool_id) {
          const pool = poolRow(i.loc.id, n.pool_id);
          const s = db.get<SessionRow>('SELECT * FROM dni_sessions WHERE number_id = ? ORDER BY last_seen_at DESC LIMIT 1', n.id);
          // The person may have left the page before dialling: the session counts a while after it ended.
          const limit = s ? Date.parse(s.expires_at) + (pool?.attribution_minutes ?? 120) * 60_000 : 0;
          if (s && Date.now() <= limit) {
            db.run('UPDATE dni_sessions SET calls = calls + 1 WHERE id = ?', s.id);
            attr = {
              source: s.source,
              medium: s.medium,
              campaign: s.campaign,
              params: s.channel === 'campaign' ? { utm_source: s.source, utm_medium: s.medium, utm_campaign: s.campaign, utm_content: s.content, utm_term: s.term, gclid: s.gclid, fbclid: s.fbclid } : {},
              page: s.landing_page,
              referrer: s.referrer,
              visitorId: s.visitor_id,
            };
          }
        }
        db.run('UPDATE calls SET tracking_number_id = ?, attr_source = ?, attr_medium = ?, attr_campaign = ?, updated_at = ? WHERE id = ?', n.id, attr?.source ?? '', attr?.medium ?? '', attr?.campaign ?? '', now(), i.call.id);
        // The contact gets the same first/last touch as from a form: reports, deals and revenue by source include the call.
        if (attr && i.call.contact_id) app.services.attribution?.capture?.(undefined, i.loc.id, i.call.contact_id, 'call', { visitorId: attr.visitorId || undefined, page: attr.page, referrer: attr.referrer, params: attr.params });
      },
    ];

    // Visits nobody called from are not needed for long.
    let cleaned = 0;
    app.onTick(() => {
      if (Date.now() - cleaned < 3600_000) return;
      cleaned = Date.now();
      db.run('DELETE FROM dni_sessions WHERE last_seen_at < ?', new Date(Date.now() - 35 * 864e5).toISOString());
    });

    // --- report: calls by campaign --------------------------------------------------------------------------------------
    const range = (ctx: Ctx) => {
      const tz = app.location(ctx.locationId)?.timezone || 'Europe/Berlin';
      const today = ymdInTz(new Date(), tz);
      const ok = (s: string | null) => (s && /^\d{4}-\d\d-\d\d$/.test(s) ? s : '');
      const to = ok(ctx.query.get('to')) || today;
      const from = ok(ctx.query.get('from')) || ymdInTz(new Date(Date.parse(`${to}T12:00:00Z`) - 29 * 864e5), tz);
      if (from > to) throw bad('„Von“ liegt nach „Bis“');
      return { from, to, fromIso: zonedToUtc(from, '00:00', tz).toISOString(), toIso: new Date(zonedToUtc(to, '00:00', tz).getTime() + 864e5).toISOString() };
    };
    const report = (ctx: Ctx) => {
      const r = range(ctx);
      const group = ctx.query.get('group') === 'number' ? 'number' : ctx.query.get('group') === 'campaign' ? 'campaign' : 'source';
      const dims = group === 'number' ? ['c.to_number'] : group === 'campaign' ? ['c.attr_source', 'c.attr_medium', 'c.attr_campaign'] : ['c.attr_source'];
      const sel = dims.map((d, i) => `COALESCE(${d}, '') AS d${i}`).join(', ');
      const rows = db.all<any>(
        `SELECT ${sel}, COUNT(*) calls, SUM(c.answered) answered, SUM(CASE WHEN c.direction = 'in' AND c.answered = 0 THEN 1 ELSE 0 END) missed,
           COALESCE(AVG(CASE WHEN c.answered = 1 THEN c.duration END), 0) avg_duration,
           COUNT(DISTINCT c.contact_id) callers
         FROM calls c WHERE c.location_id = ? AND c.direction = 'in' AND c.started_at >= ? AND c.started_at < ? AND (c.tracking_number_id IS NOT NULL OR c.attr_source <> '')
         GROUP BY ${dims.map((_d, i) => `d${i}`).join(', ')} ORDER BY calls DESC`,
        ctx.locationId,
        r.fromIso,
        r.toIso,
      );
      const labels = new Map(db.all<{ number: string; label: string }>('SELECT number, label FROM phone_numbers WHERE location_id = ?', ctx.locationId).map((n) => [n.number, n.label]));
      const list = rows.map((x) => ({
        key: dims.map((_d, i) => x[`d${i}`]).join('|'),
        label: group === 'number' ? `${x.d0}${labels.get(x.d0) ? ` (${labels.get(x.d0)})` : ''}` : [sourceLabel(x.d0), group === 'campaign' ? x.d1 : '', group === 'campaign' ? x.d2 : ''].filter((v, i) => i === 0 || v).join(' / ') || '(ohne Quelle)',
        calls: Number(x.calls),
        answered: Number(x.answered ?? 0),
        missed: Number(x.missed ?? 0),
        avg_duration: Math.round(Number(x.avg_duration ?? 0)),
        callers: Number(x.callers ?? 0),
      }));
      const sessions = db.get<{ n: number }>('SELECT COUNT(*) n FROM dni_sessions WHERE location_id = ? AND created_at >= ? AND created_at < ?', ctx.locationId, r.fromIso, r.toIso)!.n;
      return { from: r.from, to: r.to, group, rows: list, totals: { calls: list.reduce((n, x) => n + x.calls, 0), answered: list.reduce((n, x) => n + x.answered, 0), missed: list.reduce((n, x) => n + x.missed, 0), visits: sessions } };
    };
    router.get('/api/telephony/tracking/report', 'location', (ctx) => report(ctx));
    router.get('/api/telephony/tracking/report.csv', 'location', (ctx) => {
      const r = report(ctx);
      const out = text('﻿' + toCsv([['Quelle', 'Anrufe', 'Angenommen', 'Verpasst', 'Ø Dauer (s)', 'Anrufer'], ...r.rows.map((x) => [x.label, x.calls, x.answered, x.missed, x.avg_duration, x.callers])]), 'text/csv; charset=utf-8');
      out.headers['content-disposition'] = `attachment; filename="anrufe-nach-quelle-${r.from}-${r.to}.csv"`;
      return out;
    });
  },
};
