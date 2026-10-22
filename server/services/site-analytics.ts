import { sha256 } from '../core/util.js';

/**
 * Site builder: funnel step analytics (pure helpers). Visits are counted without cookies and without storing anything personal:
 * a visitor is a hash of (secret, day, site, address, browser) – it changes every day, the raw address is never kept. A page view
 * is counted on the server, "time on page" and scroll depth arrive from a small beacon signed per page view.
 */

export const DEVICES = ['phone', 'tablet', 'desktop'] as const;
export type Device = (typeof DEVICES)[number];

/** Anonymous visitor of one day on one site – not linkable across days. */
export function visitorKey(secret: string, day: string, funnelId: string, ip: string, ua: string): string {
  return sha256(`${secret}:site:${day}:${funnelId}:${ip}:${ua}`).slice(0, 16);
}

export function deviceOf(ua: string): Device {
  const s = String(ua ?? '');
  if (/ipad|tablet|kindle|silk|playbook|(android(?!.*mobile))/i.test(s)) return 'tablet';
  if (/mobi|iphone|ipod|android|windows phone|blackberry/i.test(s)) return 'phone';
  return 'desktop';
}

/** The signed token the page's beacon sends back: proves the beat belongs to a page view we counted. */
export function beatToken(secret: string, pageId: string, visitor: string, day: string): string {
  return `${pageId}.${visitor}.${day}.${sha256(`${secret}:beat:${pageId}:${visitor}:${day}`).slice(0, 16)}`;
}
export function readBeat(secret: string, token: unknown): { pageId: string; visitor: string; day: string } | undefined {
  const [pageId, visitor, day, sig] = String(token ?? '').split('.');
  if (!pageId || !visitor || !/^\d{4}-\d{2}-\d{2}$/.test(day ?? '') || !sig) return undefined;
  return sha256(`${secret}:beat:${pageId}:${visitor}:${day}`).slice(0, 16) === sig ? { pageId, visitor, day } : undefined;
}

/** The inline beacon script: time with the page in view and the deepest scroll position, sent when the visitor leaves. */
export function beaconScript(token: string): string {
  return `<script>(function(){var a=0,l=Date.now(),m=0,k=${JSON.stringify(token)};function t(){var n=Date.now();if(!document.hidden)a+=n-l;l=n}function s(){t();var d=document.documentElement,x=Math.round(100*(window.scrollY+window.innerHeight)/Math.max(d.scrollHeight,1));if(x>m)m=x;try{navigator.sendBeacon('/api/public/site/beat',new Blob([JSON.stringify({k:k,s:Math.round(a/1000),m:Math.min(m,100)})],{type:'application/json'}))}catch(e){}}addEventListener('scroll',function(){var d=document.documentElement,x=Math.round(100*(window.scrollY+window.innerHeight)/Math.max(d.scrollHeight,1));if(x>m)m=x},{passive:true});document.addEventListener('visibilitychange',function(){if(document.hidden)s();else l=Date.now()});addEventListener('pagehide',s)})()</script>`;
}

export interface StepRow {
  page_id: string;
  name: string;
  slug: string;
  position: number;
  views: number;
  visitors: number;
  entries: number;
  continued: number;
  seconds: number;
  seconds_n: number;
  scroll: number;
  scroll_n: number;
}
export interface ConvRow {
  page_id: string;
  kind: string;
  n: number;
  cents: number;
}

const pct = (n: number, d: number) => (d > 0 ? Math.min(1, n / d) : 0);

export interface Step {
  page_id: string;
  name: string;
  slug: string;
  position: number;
  views: number;
  visitors: number;
  entries: number;
  continued: number;
  continue_rate: number;
  drop_off: number;
  conversions: { form: number; booking: number; purchase: number; total: number };
  conv_rate: number;
  revenue_cents: number;
  avg_seconds: number;
  avg_scroll: number;
}

/** Steps with their rates from the raw counts (the last step cannot "continue": its drop-off is 0). */
export function buildSteps(rows: StepRow[], convs: ConvRow[]): Step[] {
  const steps = rows.map((r, i): Step => {
    const mine = convs.filter((c) => c.page_id === r.page_id);
    const count = (k: string) => mine.filter((c) => c.kind === k).reduce((s, c) => s + c.n, 0);
    const conversions = { form: count('form'), booking: count('booking'), purchase: count('purchase'), total: mine.reduce((s, c) => s + c.n, 0) };
    const last = i === rows.length - 1;
    return {
      page_id: r.page_id,
      name: r.name,
      slug: r.slug,
      position: r.position,
      views: r.views,
      visitors: r.visitors,
      entries: r.entries,
      continued: last ? 0 : r.continued,
      continue_rate: last ? 0 : pct(r.continued, r.visitors),
      drop_off: last ? 0 : r.visitors ? 1 - pct(r.continued, r.visitors) : 0,
      conversions,
      conv_rate: pct(conversions.total, r.visitors),
      revenue_cents: mine.reduce((s, c) => s + c.cents, 0),
      avg_seconds: r.seconds_n ? Math.round(r.seconds / r.seconds_n) : 0,
      avg_scroll: r.scroll_n ? Math.round(r.scroll / r.scroll_n) : 0,
    };
  });
  return steps;
}

export interface Totals {
  visitors: number;
  views: number;
  /** visitors of the last step relative to the first (how many came all the way) */
  reach_last: number;
  conversions: number;
  conv_rate: number;
  revenue_cents: number;
}
export function totalsOf(steps: Step[], uniqueVisitors: number): Totals {
  const first = steps[0];
  const lastStep = steps[steps.length - 1];
  const conversions = steps.reduce((s, x) => s + x.conversions.total, 0);
  return {
    visitors: uniqueVisitors,
    views: steps.reduce((s, x) => s + x.views, 0),
    reach_last: first && lastStep && steps.length > 1 ? pct(lastStep.visitors, first.visitors) : 0,
    conversions,
    conv_rate: pct(conversions, uniqueVisitors),
    revenue_cents: steps.reduce((s, x) => s + x.revenue_cents, 0),
  };
}

/** `?from=&to=` (YYYY-MM-DD) with the last 30 days as default and at most one year. */
export function rangeOf(from: string | null, to: string | null, today: string, addDays: (ymd: string, n: number) => string): { from: string; to: string } {
  const ok = (s: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '');
  const end = ok(to) || today;
  let start = ok(from) || addDays(end, -29);
  if (start > end) start = end;
  if (start < addDays(end, -365)) start = addDays(end, -365);
  return { from: start, to: end };
}

/** Where a visit came from, as one short word for the source table. */
export function sourceWord(source: string, medium: string): string {
  if (!source || source === 'direct') return 'direkt';
  if (medium === 'organic') return `${source} (Suche)`;
  return source;
}
