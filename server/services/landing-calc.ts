/**
 * Launch landing page (PGHL_LANDING=1), pure part: the HighLevel list prices it compares against, the savings calculator and
 * the share links. No I/O.
 *
 * Every number here has a source and a date; the page prints both under the comparison. When HighLevel changes its price list,
 * update HL_PRICES and HL_AS_OF together (and the launch kit, docs/launch-kit.md).
 */

/** HighLevel's public price list, read on gohighlevel.com/pricing on this day (monthly list prices in US dollars). */
export const HL_AS_OF = '2026-10-09';
export const HL_SOURCE = 'https://www.gohighlevel.com/pricing';
export const HL_PRICES = {
  /** Starter: 3 sub-accounts. */
  starter: 97,
  /** Unlimited: unlimited sub-accounts, phone and e-mail rebilling without markup. */
  unlimited: 297,
  /** Agency Pro: SaaS mode (reselling under your own brand), rebilling with markup. */
  pro: 497,
  /** The white-label mobile app: an add-on per month (or part of Enterprise, price on request). */
  wlApp: 497,
} as const;
export const HL_STARTER_SUBACCOUNTS = 3;

/** ECB euro reference rate of HL_AS_OF: 1 EUR = 1.1206 USD (www.ecb.europa.eu, eurofxref). */
export const EUR_USD = 1.1206;
export const EUR_USD_AS_OF = '2026-10-09';
export const usdToEur = (usd: number) => usd / EUR_USD;

/** Our cloud list prices in cents (the defaults of services/cloud.ts; the page reads the operator's real prices when cloud mode is on). */
export interface OurPrices {
  solo: number;
  team: number;
  agency: number;
}

export type HlPlan = 'starter' | 'unlimited' | 'pro';
export type Hosting = 'self' | 'cloud';
export interface CalcInput {
  plan: HlPlan;
  /** Sub-accounts (client accounts) needed. */
  subs: number;
  /** A white-label mobile app is needed. */
  wlApp: boolean;
  hosting: Hosting;
}
export const CALC_DEFAULT: CalcInput = { plan: 'unlimited', subs: 10, wlApp: false, hosting: 'self' };
export const SUBS_MAX = 100;

export interface CalcResult {
  input: CalcInput;
  /** The HighLevel plan the input needs (Starter has 3 sub-accounts – more bump it to Unlimited). */
  hlPlan: HlPlan;
  hlBumped: boolean;
  hlMonthUsd: number;
  hlYearEur: number;
  /** What we cost: self-hosted 0 € (license; the server is the operator's), or the cloud plan that covers the input. */
  ourPlan: 'self' | 'solo' | 'team' | 'agency';
  ourMonthCents: number;
  ourYearEur: number;
  /** SaaS mode (reselling with own plans and Stripe) is self-hosted only: a cloud choice falls back to self-hosting. */
  saasSelfOnly: boolean;
  saveYearEur: number;
}

const clampInt = (v: unknown, min: number, max: number, dflt: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

/** The calculator's input from a query string (the shared link carries it), with safe defaults for anything odd. */
export function parseCalc(q: URLSearchParams): CalcInput {
  const plan = q.get('p');
  const hosting = q.get('h');
  return {
    plan: plan === 'starter' || plan === 'unlimited' || plan === 'pro' ? plan : CALC_DEFAULT.plan,
    subs: clampInt(q.get('n'), 1, SUBS_MAX, CALC_DEFAULT.subs),
    wlApp: q.get('app') === '1',
    hosting: hosting === 'cloud' ? 'cloud' : 'self',
  };
}

export const calcQuery = (i: CalcInput) => `p=${i.plan}&n=${i.subs}&app=${i.wlApp ? 1 : 0}&h=${i.hosting}`;
/** Did the visitor use the calculator (a shared link)? Then the page shows that result and its social text. */
export const hasCalcQuery = (q: URLSearchParams) => ['p', 'n', 'app', 'h'].some((k) => q.has(k));

export function calculate(input: CalcInput, ours: OurPrices): CalcResult {
  const hlBumped = input.plan === 'starter' && input.subs > HL_STARTER_SUBACCOUNTS;
  const hlPlan: HlPlan = hlBumped ? 'unlimited' : input.plan;
  const hlMonthUsd = HL_PRICES[hlPlan] + (input.wlApp ? HL_PRICES.wlApp : 0);
  const hlYearEur = Math.round(usdToEur(hlMonthUsd * 12));
  const saasSelfOnly = input.hosting === 'cloud' && hlPlan === 'pro';
  let ourPlan: CalcResult['ourPlan'] = 'self';
  if (input.hosting === 'cloud' && !saasSelfOnly) ourPlan = input.subs > 1 || input.wlApp ? 'agency' : 'team';
  const ourMonthCents = ourPlan === 'self' ? 0 : ours[ourPlan];
  const ourYearEur = Math.round((ourMonthCents * 12) / 100);
  return { input, hlPlan, hlBumped, hlMonthUsd, hlYearEur, ourPlan, ourMonthCents, ourYearEur, saasSelfOnly, saveYearEur: Math.max(0, hlYearEur - ourYearEur) };
}

/** Plain intent links – no SDK, no tracker, nothing loads before the visitor clicks. */
export function shareLinks(url: string, text: string): { x: string; linkedin: string; reddit: string } {
  const u = encodeURIComponent(url);
  return {
    x: `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${u}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${u}`,
    reddit: `https://www.reddit.com/submit?url=${u}&title=${encodeURIComponent(text)}`,
  };
}
