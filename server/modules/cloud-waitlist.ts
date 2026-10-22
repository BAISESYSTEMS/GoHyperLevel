import { createHmac, timingSafeEqual } from 'node:crypto';
import type { App, Module } from '../core/app.js';
import { toCsv } from '../core/csv.js';
import { HttpError, notFound, redirect, text, type Ctx, type RawResult } from '../core/http.js';
import { id, now } from '../core/util.js';
import { formTimeOk, isCloudPlanId } from '../services/cloud.js';
import {
  WAITLIST_SOURCE,
  WL_STATUS,
  WL_TEXT,
  backUrl,
  consentText,
  isBot,
  isWlState,
  parseWaitlist,
  safeBack,
  wlLang,
  wlPlan,
  wlText,
  type WaitlistEntry,
  type WaitlistView,
  type WlLang,
  type WlPlan,
  type WlState,
} from '../services/cloud-waitlist.js';
import { waitlistPage } from '../services/cloud-pages.js';
import { getBranding } from './agency.js';
import { cloudEnabled, cloudWaitlist, cloudWaitlistReason } from './cloud.js';
import { pageCtx, servePage } from './cloud-pages.js';
import { landingEnabled } from './landing.js';
import { landingConfig } from './landing-waitlist.js';

/**
 * Cloud waitlist (docs/cloud.md#waitlist-mode). While the waitlist mode is on (`PGHL_CLOUD_WAITLIST=1`, or the cloud mode without a
 * Stripe key), nobody can sign up for or pay for the cloud:
 *
 *  - the gate: a router wrapper refuses the signup routes (`POST /start`, the verification link, the Google return, and in cloud mode the
 *    SaaS self-signup `/signup`) with 403 – no cloud signup row, no account, no sub-account, no Stripe Checkout. Existing customers keep
 *    working: their account, billing and client-account routes are untouched, and a Checkout that was already paid still completes.
 *  - the form: `POST /api/public/cloud-waitlist` (JSON or a plain form post from the landing page, /cloud and /start). With
 *    `PGHL_LANDING_LOCATION` it goes through the landing waitlist hook into that sub-account's form (Double-Opt-in, consent proof,
 *    plan and source „Cloud-Warteliste“); otherwise into the built-in list below – e-mail, optional name, plan, language, the consent
 *    text with its time and a hashed IP. Honeypot, time token and rate limits either way; the built-in list never sends mail.
 *  - the list: `GET /api/cloud/waitlist`, `GET /api/cloud/waitlist.csv`, `DELETE /api/cloud/waitlist/:id` (admins only; Agentur → Cloud
 *    → Warteliste) – new entries notify the admins through the push notifications.
 *
 * The pages render the form through `app.services.cloudWaitlist` (`enabled`, `view`); landing.ts and cloud-pages.ts ask it.
 * Only the cloud mode and the landing page show the form, so without both nothing is registered (self-hosters see no route).
 */

const MAC_LABEL = 'cloud-waitlist';
const PER_IP_HOUR = 6;
const PER_EMAIL_HOUR = 3;
/** The plan options of the HQ template's „Warteliste & Newsletter“ form (services/hq-template.ts). */
const FORM_PLAN: Record<WlPlan, string> = { solo: 'Solo', team: 'Team & Company', agency: 'Agency' };

interface Row {
  id: string;
  email: string;
  name: string;
  plan: string;
  lang: string;
  source: string;
  consent_text: string;
  consent_at: string;
  ip_hash: string;
  created_at: string;
  updated_at: string;
}

/** The receiving form of the forms path (PGHL_LANDING_LOCATION), with what the page needs to know about it. */
function formsTarget(app: App) {
  const cfg = landingConfig(app);
  if (!cfg) return null;
  const fields: { name: string; type: string; label: string; required?: boolean; options?: string[] }[] = Array.isArray(cfg.form.fields) ? cfg.form.fields : [];
  const consentField = String(cfg.form.settings?.consent?.field ?? '') || fields.find((f) => f.type === 'consent')?.name || '';
  return {
    locationId: cfg.locationId,
    formId: String(cfg.form.id),
    needName: fields.some((f) => (f.name === 'first_name' || f.name === 'name') && f.required),
    consentLabel: String(fields.find((f) => f.name === consentField)?.label ?? ''),
    doi: cfg.form.settings?.consent?.doi === 'on',
    planOptions: (fields.find((f) => f.name === 'custom.plan')?.options ?? []).map(String),
    nameField: fields.some((f) => f.name === 'first_name') ? 'first_name' : 'name',
    consentField: consentField || 'consent',
  };
}

export const cloudWaitlistModule: Module = {
  name: 'cloud-waitlist',
  migrations: [
    [
      '001-init',
      `CREATE TABLE cloud_waitlist (
        id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL DEFAULT '', lang TEXT NOT NULL DEFAULT 'de',
        source TEXT NOT NULL DEFAULT '', consent_text TEXT NOT NULL, consent_at TEXT NOT NULL, ip_hash TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX cloud_waitlist_email ON cloud_waitlist(email);
      CREATE INDEX cloud_waitlist_created ON cloud_waitlist(created_at);`,
    ],
  ],
  register(app) {
    if (!cloudEnabled(app) && !landingEnabled()) return;
    const { db, router } = app;
    const enabled = () => cloudWaitlist(app);
    const brand = () => getBranding(app).name || 'HyperLevel';

    // --- time token and throttles ----------------------------------------------------------------------------------------
    const mac = (ts: string) => createHmac('sha256', app.config.secret).update(`${MAC_LABEL}:${ts}`).digest('hex').slice(0, 32);
    const token = () => {
      const ts = String(Date.now());
      return `${ts}.${mac(ts)}`;
    };
    const tokenOk = (tok: string) =>
      formTimeOk(
        tok,
        (ts, m) => {
          const want = Buffer.from(mac(ts));
          const got = Buffer.from(m);
          return want.length === got.length && timingSafeEqual(want, got);
        },
        Date.now(),
        app.services.cloudWaitlistMinMs ?? 2000,
      );
    const hits = new Map<string, number[]>();
    const throttled = (key: string, max: number, windowMs = 3600_000) => {
      const t = Date.now();
      const list = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
      list.push(t);
      hits.set(key, list);
      if (hits.size > 20_000) hits.clear();
      return list.length > max;
    };
    const ipHash = (ip: string) => createHmac('sha256', app.config.secret).update(`waitlist-ip:${ip}`).digest('hex').slice(0, 24);

    /** Privacy policy next to the consent: PGHL_LANDING_PRIVACY_URL, else the cloud's own (cloud mode). */
    const privacyUrl = () => {
      const env = String(process.env.PGHL_LANDING_PRIVACY_URL ?? '').trim();
      if (/^(https?:\/\/|\/)[^\s"'<>]*$/i.test(env) && !env.startsWith('//')) return env;
      return cloudEnabled(app) ? '/cloud/legal/datenschutz' : '';
    };

    const view = (o: { lang?: WlLang; back: string; plan?: unknown; state?: unknown }): WaitlistView => {
      const f = formsTarget(app);
      return {
        lang: o.lang ?? 'de',
        brand: brand(),
        back: safeBack(o.back),
        token: token(),
        plan: wlPlan(o.plan),
        privacyUrl: privacyUrl(),
        consentLabel: f?.consentLabel ?? '',
        needName: !!f?.needName,
        doi: !!f?.doi,
        state: isWlState(o.state) ? o.state : undefined,
      };
    };

    // --- storing ----------------------------------------------------------------------------------------------------------
    const admins = () => db.all<{ id: string }>(`SELECT id FROM users WHERE role = 'admin'`).map((r) => r.id);
    function notify(entry: WaitlistEntry) {
      const total = Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM cloud_waitlist')?.n ?? 0);
      const ids = admins();
      if (!ids.length || !app.services.pushNotify) return;
      // No address in the notification: it travels through push services; the list in the console has it.
      void Promise.resolve(
        app.services.pushNotify({
          userIds: ids,
          kind: 'cloud_waitlist',
          title: 'Neu auf der Cloud-Warteliste',
          body: `${entry.plan ? `Tarif: ${WL_TEXT.de.plans[entry.plan]} · ` : ''}${total} ${total === 1 ? 'Eintrag' : 'Einträge'} insgesamt`,
          url: '/app/agency/cloud?tab=waitlist',
          tag: 'cloud-waitlist',
          urgency: 'low',
        }),
      ).catch((e: Error) => console.error('[cloud-waitlist] push', e.message));
    }

    /** The built-in list: one row per address (a second sign-up updates plan, language and consent; nobody learns whether it existed). */
    function store(entry: WaitlistEntry, ctx: Ctx) {
      const t = wlText(entry.lang, brand());
      const at = now();
      const row = { email: entry.email, name: entry.name, plan: entry.plan, lang: entry.lang, source: WAITLIST_SOURCE, consent_text: consentText(t, privacyUrl()), consent_at: at, ip_hash: ipHash(ctx.ip), updated_at: at };
      const fresh = db.run(
        `INSERT INTO cloud_waitlist (id, email, name, plan, lang, source, consent_text, consent_at, ip_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(email) DO NOTHING`,
        id(),
        row.email,
        row.name,
        row.plan,
        row.lang,
        row.source,
        row.consent_text,
        row.consent_at,
        row.ip_hash,
        at,
        at,
      ).changes;
      if (fresh) return notify(entry);
      db.run(
        `UPDATE cloud_waitlist SET name = CASE WHEN ? = '' THEN name ELSE ? END, plan = CASE WHEN ? = '' THEN plan ELSE ? END, lang = ?, consent_text = ?, consent_at = ?, ip_hash = ?, updated_at = ? WHERE email = ?`,
        row.name,
        row.name,
        row.plan,
        row.plan,
        row.lang,
        row.consent_text,
        row.consent_at,
        row.ip_hash,
        at,
        row.email,
      );
    }

    /** The forms path: the HQ form (or PGHL_LANDING_FORM) through the landing waitlist hook – its own Double-Opt-in and consent proof. */
    async function forward(entry: WaitlistEntry, ctx: Ctx, f: NonNullable<ReturnType<typeof formsTarget>>, page: string) {
      const plan = entry.plan ? (f.planOptions.includes(FORM_PLAN[entry.plan]) ? FORM_PLAN[entry.plan] : WL_TEXT.de.plans[entry.plan]) : undefined;
      await app.services.landingWaitlist.submit(ctx, {
        email: entry.email,
        ...(entry.name ? { [f.nameField]: entry.name } : {}),
        [f.consentField]: true,
        ...(plan ? { plan } : {}),
        source: WAITLIST_SOURCE,
        _page: page,
      });
    }

    // --- the public endpoint ------------------------------------------------------------------------------------------------
    router.get('/api/public/cloud-waitlist', 'public', (ctx) => {
      if (!enabled()) return { enabled: false };
      const lang = wlLang(ctx.query.get('lang'));
      const v = view({ lang, back: '/' });
      const f = formsTarget(app);
      const t = wlText(lang, v.brand);
      return { enabled: true, via: f ? 'forms' : 'builtin', token: v.token, plans: Object.entries(t.plans).map(([key, name]) => ({ key, name })), consent: v.consentLabel || t.consent, privacy_url: v.privacyUrl, need_name: v.needName, doi: v.doi };
    });

    router.post('/api/public/cloud-waitlist', 'public', async (ctx) => {
      const b: Record<string, unknown> = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {};
      const json = /json/i.test(String(ctx.req.headers['content-type'] ?? ''));
      const lang = wlLang(b.lang);
      const back = safeBack(b.back);
      const answer = (state: WlState, detail?: string): unknown => {
        if (!json) return redirect(backUrl(back, state, lang), 303);
        const t = wlText(lang, brand());
        if (state === 'ok' || state === 'doi') return { ok: true, state, message: state === 'doi' ? `${t.ok} ${t.doi}` : t.ok };
        throw new HttpError(WL_STATUS[state], detail || t.errors[state], { state });
      };
      if (!enabled()) return answer('closed');
      // Bots fill the hidden field: answer like a success, keep nothing.
      if (isBot(b)) return answer('ok');
      if (!tokenOk(String(b.wt ?? ''))) return answer('stale');
      if (throttled(`ip:${ctx.ip}`, PER_IP_HOUR)) return answer('rate');
      const f = formsTarget(app);
      const parsed = parseWaitlist(b, { needName: !!f?.needName });
      if (!parsed.ok) return answer(parsed.error);
      if (throttled(`mail:${parsed.entry.email}`, PER_EMAIL_HOUR)) return answer('rate');
      if (f) {
        try {
          await forward(parsed.entry, ctx, f, back);
        } catch (e) {
          if (e instanceof HttpError && e.status === 429) return answer('rate');
          console.error('[cloud-waitlist] forms path', (e as Error).message);
          return answer('error', e instanceof HttpError && e.status < 500 ? e.message : undefined);
        }
        return answer(f.doi ? 'doi' : 'ok');
      }
      store(parsed.entry, ctx);
      return answer('ok');
    });

    app.services.cloudWaitlist = {
      enabled,
      reason: () => cloudWaitlistReason(app),
      view,
      via: () => (formsTarget(app) ? 'forms' : 'builtin'),
      resetLimits: () => hits.clear(),
    };

    // --- the gate: no signup, no account, no payment session while the waitlist is on -----------------------------------------
    const refuse = (ctx: Ctx): RawResult => {
      const lang: WlLang = wlLang(ctx.query.get('lang'));
      const t = wlText(lang, brand());
      if (/json/i.test(String(ctx.req.headers['content-type'] ?? '')) || /json/i.test(String(ctx.req.headers.accept ?? ''))) throw new HttpError(403, t.refused, { waitlist: true, waitlist_url: '/start' });
      return servePage(waitlistPage(pageCtx(app), { view: view({ lang, back: '/start', plan: ctx.body?.plan }), notice: t.refused }), 403);
    };
    /** The routes a new customer signs up or pays through (methods + patterns). */
    const SIGNUP: [string, string][] = [
      ['POST', '/start'],
      ['GET', '/start/verify/:token'],
      ['POST', '/start/verify/:token'],
      ['GET', '/start/google/callback'],
    ];
    /** On a cloud instance the SaaS self-signup would create a sub-account and a Checkout as well. */
    const SAAS: [string, string][] = [
      ['GET', '/signup'],
      ['POST', '/signup'],
    ];
    /** The agency's SaaS tools could put a cloud plan on any sub-account or open a Checkout for one (body.plan_id). */
    const SAAS_ADMIN: [string, string][] = [
      ['PUT', '/api/saas/locations/:id'],
      ['POST', '/api/saas/locations/:id/checkout'],
    ];
    const isSignup = (m: string, p: string) => SIGNUP.some(([a, b]) => a === m && b === p);
    const isSaas = (m: string, p: string) => SAAS.some(([a, b]) => a === m && b === p);
    const isSaasAdmin = (m: string, p: string) => SAAS_ADMIN.some(([a, b]) => a === m && b === p);
    router.wrappers.push((route, next) =>
      isSaasAdmin(route.method, route.pattern)
        ? (ctx) => {
            // An existing customer's sub-account keeps its plan changes; a new cloud subscription anywhere else waits for the cloud.
            if (enabled() && isCloudPlanId(ctx.body?.plan_id) && !app.services.cloud?.tenantOfLocation?.(ctx.params.id))
              throw new HttpError(409, 'Wartelisten-Modus: Cloud-Tarife gibt es nur für bestehende Cloud-Kunden – neue Cloud-Konten und -Zahlungen sind gesperrt.', { waitlist: true });
            return next(ctx);
          }
        : next,
    );
    router.wrappers.push((route, next) =>
      isSignup(route.method, route.pattern) || isSaas(route.method, route.pattern)
        ? (ctx) => {
            if (!enabled() || (isSaas(route.method, route.pattern) && !cloudEnabled(app))) return next(ctx);
            if (route.method === 'GET' && route.pattern === '/signup') return redirect('/start', 302);
            return refuse(ctx);
          }
        : next,
    );

    // --- the operator's list ----------------------------------------------------------------------------------------------------
    const target = () => {
      const f = formsTarget(app);
      if (!f) return null;
      return { location_id: f.locationId, location_name: app.location(f.locationId)?.name ?? '', form_id: f.formId, doi: f.doi };
    };
    router.get('/api/cloud/waitlist', 'admin', (ctx) => {
      const q = String(ctx.query.get('q') ?? '').trim().toLowerCase().slice(0, 100);
      const where = q ? `WHERE email LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\'` : '';
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const items = db.all<Row>(`SELECT id, email, name, plan, lang, source, consent_text, consent_at, created_at, updated_at FROM cloud_waitlist ${where} ORDER BY created_at DESC LIMIT 2000`, ...(q ? [like, like] : []));
      const total = Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM cloud_waitlist')?.n ?? 0);
      const byPlan = Object.fromEntries(db.all<{ plan: string; n: number }>('SELECT plan, COUNT(*) AS n FROM cloud_waitlist GROUP BY plan').map((r) => [r.plan || 'none', r.n]));
      return { enabled: enabled(), reason: cloudWaitlistReason(app), cloud: cloudEnabled(app), via: target() ? 'forms' : 'builtin', forms: target(), privacy_url: privacyUrl(), total, by_plan: byPlan, items };
    });
    // Export and delete land in the audit log by themselves (modules/security.ts logs every write and every .csv read).
    router.get('/api/cloud/waitlist.csv', 'admin', () => {
      const rows = db.all<Row>('SELECT * FROM cloud_waitlist ORDER BY created_at');
      const csv = toCsv([
        ['E-Mail', 'Name', 'Tarif', 'Sprache', 'Quelle', 'Einwilligung am', 'Einwilligungstext', 'Eingetragen am'],
        ...rows.map((r) => [r.email, r.name, r.plan ? WL_TEXT.de.plans[r.plan as WlPlan] ?? r.plan : '', r.lang, r.source, r.consent_at, r.consent_text, r.created_at]),
      ]);
      const r = text(`﻿${csv}`, 'text/csv; charset=utf-8');
      r.headers['content-disposition'] = `attachment; filename="cloud-warteliste-${new Date().toISOString().slice(0, 10)}.csv"`;
      r.headers['cache-control'] = 'no-store';
      return r;
    });
    router.delete('/api/cloud/waitlist/:id', 'admin', (ctx) => {
      if (!db.run('DELETE FROM cloud_waitlist WHERE id = ?', ctx.params.id).changes) throw notFound('Eintrag nicht gefunden');
      return { ok: true };
    });
  },
};
