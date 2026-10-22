import type { CountRow, PartKey, StepCtx } from './umzug-core.js';
import { UmzugError, type VendorHttp } from './umzug-http.js';

/**
 * Plumbing the newer importers (umzug-<vendor>.ts of "Umzug Welle 2") have in common: a context for the preview calls, count rows
 * that never stop the preview for a part the plan does not offer, a page walker for counting when the API has no totals, and
 * a few small parsers. Nothing vendor-specific lives here.
 */

/** The context the preview's calls run in (it is not a job: nothing is cancelled, nothing is limited). */
export const stubCtx = (http: VendorHttp, parts: PartKey[]): StepCtx => ({ http, creds: {}, meta: {}, cursor: undefined, cancelled: () => false, warn: () => undefined, limit: Infinity, options: { merge: 'fill' }, parts });

/**
 * `count(part, key, label, fn)` appends a row to `counts`. `fn` returns the number, or `{ n, capped }` when counting stopped at the cap
 * ("mindestens"). A failing call is shown on its row; only wrong credentials (401) end the preview.
 */
export function counter(counts: CountRow[]) {
  return async (part: PartKey, key: string, label: string, fn: () => Promise<number | { n: number; capped?: boolean }>) => {
    try {
      const r = await fn();
      const n = typeof r === 'number' ? r : r.n;
      counts.push({ part, key, label: typeof r === 'object' && r.capped ? `${label} (mindestens)` : label, total: n });
    } catch (e) {
      counts.push({ part, key, label, total: null, error: (e as Error).message });
      if (e instanceof UmzugError && e.fatal) throw e;
    }
  };
}

/** Counts items by walking a page generator, at most `cap` pages (very big accounts are counted "mindestens"). */
export async function walkCount(gen: AsyncGenerator<{ items: unknown[]; next: unknown }>, cap = 60): Promise<{ n: number; capped: boolean }> {
  let n = 0;
  let pages = 0;
  for await (const pg of gen) {
    n += pg.items.length;
    if (++pages >= cap && pg.next !== undefined) return { n, capped: true };
  }
  return { n, capped: false };
}

/** "Anna Maria Alt" → first / last. */
export function nameParts(name: unknown): { first?: string; last?: string } {
  const p = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  return { first: p[0], last: p.length > 1 ? p.slice(1).join(' ') : undefined };
}

/** A parameter of a URL a vendor handed back (a "next" link): only the value is used, never the host. */
export function paramOf(link: unknown, name: string): string | undefined {
  if (typeof link !== 'string' || !link) return undefined;
  try {
    return new URL(link, 'https://invalid.example').searchParams.get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Stable short key for a vendor account made of something non-secret (a host, a subdomain, an account id). */
export const accountKey = (v: unknown, fallback: string): string => {
  const s = String(v ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return /^[a-z0-9][a-z0-9._-]{1,118}$/.test(s) ? s : fallback;
};

/** A priority word in German or English ("Critical", "Hoch", "medium", "niedrig") → 0..4 of the planner (undefined: not a priority word). */
export function priorityWord(label: unknown): number | undefined {
  const l = String(label ?? '').toLowerCase();
  if (/critical|urgent|dringend|kritisch|blocker|höchste|p0|p1/.test(l)) return 4;
  if (/high|hoch|wichtig/.test(l)) return 3;
  if (/medium|mittel|normal|p2/.test(l)) return 2;
  if (/low|niedrig|gering|p3/.test(l)) return 1;
  return undefined;
}

/** A value from a response, made safe to sit inside a URL path (an id never opens a second path segment). */
export const seg = (v: unknown): string => encodeURIComponent(String(v ?? ''));
