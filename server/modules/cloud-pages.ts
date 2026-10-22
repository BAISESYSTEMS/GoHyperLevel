import { createHmac, timingSafeEqual } from 'node:crypto';
import type { App, Module } from '../core/app.js';
import { html, notFound, type Ctx, type RawResult } from '../core/http.js';
import { renderMarkdown } from '../services/markdown.js';
import { entitlements, priceFor, PLAN_KEYS, formTimeOk } from '../services/cloud.js';
import { LEGAL_DOCS, isLegalDoc } from '../services/cloud-legal.js';
import { CSP, legalPage, pricingPage, signupPage, waitlistPage, type PageCtx, type PricingData, type SignupData } from '../services/cloud-pages.js';
import type { WaitlistView, WlLang } from '../services/cloud-waitlist.js';
import { getBranding } from './agency.js';
import { cloudBrand, cloudEnabled, cloudSettings, cloudSupport, fmtDay, legalCurrent, legalText } from './cloud.js';

/**
 * The public pages of the hosted service: pricing (/cloud), signup form (/start), the legal documents
 * (/cloud/legal/<agb|avv|datenschutz|impressum>) and the pricing as JSON for the operator's own website
 * (/api/public/cloud/pricing). No cookies, no scripts, no third-party requests on any of them.
 * In waitlist mode (modules/cloud-waitlist.ts) /cloud shows the plans as planned with the waitlist form, and /start is the
 * waitlist page – the signup form is not rendered at all.
 */

export function pageCtx(app: App): PageCtx {
  const b = getBranding(app);
  const s = cloudSettings(app);
  return {
    brand: { name: cloudBrand(app), logo_url: b.logo_url, color: b.color },
    status_url: s.status_url,
    docs_url: s.docs_url || 'https://github.com/gohyperlevel/gohyperlevel#readme',
    support_email: cloudSupport(app),
    legal: LEGAL_DOCS.map((doc) => ({ doc, version: legalCurrent(app, doc).version })),
  };
}

export function pricingData(app: App): PricingData {
  const s = cloudSettings(app);
  return {
    plans: (app.services.cloud.planCards() as PricingData['plans']),
    trial_days: s.trial_days,
    card_required: s.card_required,
    yearly_discount_percent: s.yearly_discount_percent,
    price_note: s.price_note,
    signup_open: s.signup_open,
    agency_max_clients: s.agency_max_clients,
    stripe_tax: s.stripe_tax,
    hosting: s.operator.hosting || undefined,
    b2b_only: s.b2b_only,
  };
}

/** Pages carry their own strict policy: no scripts at all. */
export const servePage = (body: string, status = 200): RawResult => {
  const r = html(body, status);
  r.headers['content-security-policy'] = CSP;
  r.headers['cache-control'] = 'no-store';
  return r;
};

const mac = (app: App, ts: string) => createHmac('sha256', app.config.secret).update(`cloud-form:${ts}`).digest('hex').slice(0, 32);
/** The time token of a freshly rendered signup form. */
export const formToken = (app: App) => {
  const ts = String(Date.now());
  return `${ts}.${mac(app, ts)}`;
};
export const formTokenOk = (app: App, tok: string, minMs: number = app.services.cloudFormMinMs ?? 2500) =>
  formTimeOk(
    tok,
    (ts, m) => {
      const want = Buffer.from(mac(app, ts));
      const got = Buffer.from(m);
      return want.length === got.length && timingSafeEqual(want, got);
    },
    Date.now(),
    minMs,
  );

/** The visitor's language for the waitlist page: ?lang=, else the browser's first choice (German unless it is English). */
const langOf = (ctx: Ctx): WlLang => {
  const q = ctx.query.get('lang');
  if (q === 'en' || q === 'de') return q;
  return /^\s*en\b/i.test(String(ctx.req.headers['accept-language'] ?? '')) ? 'en' : 'de';
};

export const cloudPagesModule: Module = {
  name: 'cloud-pages',
  register(app) {
    if (!cloudEnabled(app)) return;
    const { router } = app;
    /** The waitlist form for a page, when the waitlist mode is on. */
    const waitlist = (ctx: Ctx, back: string, lang: WlLang = 'de'): WaitlistView | undefined =>
      app.services.cloudWaitlist?.enabled() ? app.services.cloudWaitlist.view({ lang, back, plan: ctx.query.get('plan'), state: ctx.query.get('wl') }) : undefined;

    router.get('/cloud', 'public', (ctx) => servePage(pricingPage(pageCtx(app), { ...pricingData(app), waitlist: waitlist(ctx, '/cloud') })));

    router.get('/start', 'public', (ctx) => {
      const wl = waitlist(ctx, '/start', langOf(ctx));
      if (wl) return servePage(waitlistPage(pageCtx(app), { view: wl }));
      const q = (k: string) => String(ctx.query.get(k) ?? '').slice(0, 120);
      const d: SignupData = {
        ...pricingData(app),
        values: { plan: PLAN_KEYS.includes(q('plan') as any) ? q('plan') : 'team', interval: q('interval') === 'year' ? 'year' : 'month', company: '', name: '', email: '', coupon: q('coupon') },
        token: formToken(app),
        google: !!app.services.cloudGoogleReady?.(),
        closed: !cloudSettings(app).signup_open,
        canceled: q('canceled') === '1',
      };
      return servePage(signupPage(pageCtx(app), d));
    });

    router.get('/cloud/legal/:doc', 'public', (ctx) => {
      if (!isLegalDoc(ctx.params.doc)) throw notFound();
      const row = legalCurrent(app, ctx.params.doc);
      return servePage(legalPage(pageCtx(app), { doc: row.doc, html: renderMarkdown(legalText(app, row)), version: row.version, date: fmtDay(row.created_at) }));
    });

    router.get('/api/public/cloud/pricing', 'public', () => {
      const s = cloudSettings(app);
      return {
        currency: 'EUR',
        // Waitlist mode: nothing can be ordered yet – the prices are planned, signup_url shows the waitlist form.
        waitlist: !!app.services.cloudWaitlist?.enabled(),
        trial_days: s.trial_days,
        card_required: s.card_required,
        yearly_discount_percent: s.yearly_discount_percent,
        price_note: s.price_note,
        signup_url: `${app.baseUrl()}/start`,
        plans: PLAN_KEYS.map((k) => {
          const c = (app.services.cloud.planCards() as PricingData['plans']).find((p) => p.key === k)!;
          return { key: k, name: c.name, tagline: c.tagline, price_month_cents: priceFor(s, k, 'month'), price_year_cents: priceFor(s, k, 'year'), entitlements: entitlements(k, s), fair_use: c.fair_use, highlights: c.highlights };
        }),
      };
    });
  },
};
