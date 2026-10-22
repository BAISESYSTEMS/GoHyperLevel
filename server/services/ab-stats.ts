/**
 * Statistics and helpers for A/B split tests: weighted assignment, bot detection, a two-proportion
 * z-test and the Bayesian probability that a variant beats the original (Beta(1,1) prior).
 */

/** Below this many visitors per variant, or conversions per pair, results are flagged as "too early". */
export const MIN_VISITORS = 100;
export const MIN_CONVERSIONS = 10;
/** Two-sided p-value below which a difference counts as significant (95 %). */
export const ALPHA = 0.05;

/** Picks a variant by weight (percent); `r` is a uniform random number in [0, 1). */
export function pickVariant<T extends { weight: number }>(variants: T[], r: number): T {
  const usable = variants.filter((v) => v.weight > 0);
  const list = usable.length ? usable : variants;
  const total = list.reduce((s, v) => s + (usable.length ? v.weight : 1), 0);
  let x = Math.min(Math.max(r, 0), 0.999999999) * total;
  for (const v of list) {
    x -= usable.length ? v.weight : 1;
    if (x < 0) return v;
  }
  return list[list.length - 1];
}

const BOT_UA =
  /bot\/|bot;|bot-|telegrambot|\+https?:|crawl|spider|slurp|bingpreview|facebookexternalhit|facebookcatalog|embedly|quora link preview|outbrain|pinterest|vkshare|w3c_validator|whatsapp|skypeuripreview|preview|headless|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|curl\/|wget|python|httpclient|okhttp|go-http-client|java\/|libwww|axios|node-fetch|undici|scrapy|phantomjs|selenium|puppeteer|playwright/i;

/** Crawlers, link previews, monitors, scripts and prefetches never count as visitors. */
export function isBot(userAgent: string | undefined, purpose = ''): boolean {
  const ua = String(userAgent ?? '').trim();
  if (ua.length < 12) return true;
  if (/prefetch|prerender|preview/i.test(purpose)) return true;
  return BOT_UA.test(ua);
}

/** Complementary error function (Numerical Recipes, fractional error < 1.2e-7). */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

/** Standard normal cumulative distribution Φ(x). */
export function normalCdf(x: number): number {
  return 0.5 * erfc(-x / Math.SQRT2);
}

/**
 * Two-proportion z-test (pooled), two-sided. `a` is the original, `b` the variant.
 * Returns null while one side has no visitors or nobody / everybody converted.
 */
export function zTest(a: { visitors: number; conversions: number }, b: { visitors: number; conversions: number }): { z: number; p: number } | null {
  const { visitors: n1, conversions: c1 } = a;
  const { visitors: n2, conversions: c2 } = b;
  if (n1 <= 0 || n2 <= 0) return null;
  const pooled = (c1 + c2) / (n1 + n2);
  if (pooled <= 0 || pooled >= 1) return null;
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  const z = (c2 / n2 - c1 / n1) / se;
  return { z, p: Math.min(1, 2 * (1 - normalCdf(Math.abs(z)))) };
}

/** ln Γ(x) for x > 0 (Lanczos, g = 7). */
export function lgamma(x: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

const logBeta = (a: number, b: number) => lgamma(a) + lgamma(b) - lgamma(a + b);

/**
 * P(rate of b > rate of a) with Beta(1 + conversions, 1 + misses) posteriors. Exact sum
 * (Evan Miller) for normal sizes, normal approximation for very large conversion counts.
 */
export function probabilityToBeat(a: { visitors: number; conversions: number }, b: { visitors: number; conversions: number }): number {
  const aA = 1 + a.conversions;
  const bA = 1 + Math.max(0, a.visitors - a.conversions);
  const aB = 1 + b.conversions;
  const bB = 1 + Math.max(0, b.visitors - b.conversions);
  if (aB > 5000) {
    const mean = (x: number, y: number) => x / (x + y);
    const vari = (x: number, y: number) => (x * y) / ((x + y) ** 2 * (x + y + 1));
    return normalCdf((mean(aB, bB) - mean(aA, bA)) / Math.sqrt(vari(aA, bA) + vari(aB, bB)));
  }
  const base = logBeta(aA, bA);
  let total = 0;
  for (let i = 0; i < aB; i++) total += Math.exp(logBeta(aA + i, bA + bB) - Math.log(bB + i) - logBeta(1 + i, bB) - base);
  return Math.min(1, Math.max(0, total));
}

export interface VariantCounts {
  id: string;
  key: string;
  is_control: boolean;
  visitors: number;
  conversions: number;
}

export interface VariantResult extends VariantCounts {
  /** Conversion rate 0..1. */
  rate: number;
  /** Relative change of the rate against the original (0.25 = +25 %); null for the original or when it has no conversions. */
  uplift: number | null;
  z: number | null;
  p_value: number | null;
  significant: boolean;
  /** Probability (0..1) that this variant converts better than the original. */
  prob_beat: number | null;
  /** too_early | better | worse | no_difference (the original: control). */
  verdict: 'control' | 'too_early' | 'better' | 'worse' | 'no_difference';
}

/** Rates, uplift and significance of every variant against the original. */
export function summarize(variants: VariantCounts[]): { variants: VariantResult[]; small_sample: boolean; leader: string | null } {
  const control = variants.find((v) => v.is_control) ?? variants[0];
  const rate = (v: VariantCounts) => (v.visitors ? v.conversions / v.visitors : 0);
  let small = false;
  const out = variants.map((v): VariantResult => {
    const r = rate(v);
    if (!control || v.id === control.id) return { ...v, rate: r, uplift: null, z: null, p_value: null, significant: false, prob_beat: null, verdict: 'control' };
    const enough = v.visitors >= MIN_VISITORS && control.visitors >= MIN_VISITORS && v.conversions + control.conversions >= MIN_CONVERSIONS;
    if (!enough) small = true;
    const zt = zTest(control, v);
    const cr = rate(control);
    const uplift = cr > 0 ? (r - cr) / cr : null;
    const significant = !!zt && zt.p < ALPHA && enough;
    return {
      ...v,
      rate: r,
      uplift,
      z: zt ? zt.z : null,
      p_value: zt ? zt.p : null,
      significant,
      prob_beat: probabilityToBeat(control, v),
      verdict: !enough ? 'too_early' : significant ? (r > cr ? 'better' : 'worse') : 'no_difference',
    };
  });
  const better = out.filter((v) => v.verdict === 'better').sort((x, y) => y.rate - x.rate)[0];
  const allWorse = out.length > 1 && out.every((v) => v.verdict === 'control' || v.verdict === 'worse');
  return { variants: out, small_sample: small, leader: better ? better.key : allWorse ? (control?.key ?? null) : null };
}
