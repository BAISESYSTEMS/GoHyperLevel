import { escapeHtml as h } from '../core/template.js';
import type { Copy, Lang } from './landing-copy.js';

/**
 * Launch landing page: "Replaces your stack" – which tools one HyperLevel replaces, what the cheapest of each costs, and
 * the total (web/public/landing/replaces.json, every price with a source and the research date). Pure: parsing and HTML.
 * Tool names are plain text chips – no logos (third-party logos need permission). Prices stay in their own currency; a
 * converted total is only shown when the file brings one with its exchange-rate source.
 *
 * Schema: { as_of, rows: [{ id, label_de, label_en, coverage: full | partial | unique, coverage_note_de, coverage_note_en,
 *           tools: [{ name, plan, price_month, currency, billing, source }], min_price, min_currency }], excluded_rows, totals }
 */

export interface StackTool {
  name: string;
  plan: string;
  price: number | null;
  currency: string;
  billing: string;
  source: string;
}
export interface StackRow {
  id: string;
  label_de: string;
  label_en: string;
  coverage: 'full' | 'partial' | 'unique';
  note_de: string;
  note_en: string;
  tools: StackTool[];
  min_price: number | null;
  min_currency: string;
  /** false: shown, but not counted in the total (e.g. we use such a tool's provider rather than replace it). */
  in_total: boolean;
}
export interface Stack {
  as_of: string;
  rows: StackRow[];
  /** Sum of the cheapest tool per row, per currency (never converted here). */
  sums: Record<string, number>;
  /** The total in euros, converted here at the exchange rate the research names (with its source); only for EUR/USD. */
  converted?: { eur: number; rate: number; source: string; date?: string };
  /** The same for the rows we cover completely – the honest lower figure. */
  fullOnly?: { eur: number; rows: number };
  /** Rows counted in the total. */
  priced: number;
}

const str = (v: unknown, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const httpsUrl = (v: unknown) => (/^https:\/\/[^\s"'<>]+$/i.test(str(v, 600)) ? str(v, 600) : '');
const money = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const cur = (v: unknown) => (/^[A-Z]{3}$/.test(String(v ?? '')) ? String(v) : 'USD');

/** The research file → a clean stack (https sources only, unknown coverage dropped); undefined when unusable. */
export function parseStack(raw: unknown): Stack | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, any>;
  const as_of = /^\d{4}-\d{2}-\d{2}$/.test(String(r.as_of ?? '')) ? String(r.as_of) : '';
  const rows: StackRow[] = (Array.isArray(r.rows) ? r.rows : [])
    .map((x: any) => {
      const tools: StackTool[] = (Array.isArray(x?.tools) ? x.tools : []).slice(0, 8).map((t: any) => ({ name: str(t?.name, 60), plan: str(t?.plan, 80), price: money(t?.price_month), currency: cur(t?.currency), billing: str(t?.billing, 60), source: httpsUrl(t?.source) })).filter((t: StackTool) => t.name);
      const cheapest = tools.filter((t) => t.price !== null).sort((a, b) => a.price! - b.price!)[0];
      return {
        id: str(x?.id, 60),
        label_de: str(x?.label_de, 100),
        label_en: str(x?.label_en, 100) || str(x?.label_de, 100),
        coverage: x?.coverage,
        note_de: str(x?.coverage_note_de, 400),
        note_en: str(x?.coverage_note_en, 400) || str(x?.coverage_note_de, 400),
        tools,
        min_price: money(x?.min_price) ?? cheapest?.price ?? null,
        min_currency: x?.min_currency ? cur(x.min_currency) : cheapest?.currency ?? 'USD',
        in_total: x?.in_total !== false,
      };
    })
    .filter((x: StackRow) => x.id && x.label_de && ['full', 'partial', 'unique'].includes(x.coverage) && (x.tools.length || x.coverage === 'unique'));
  if (!as_of || rows.length < 3) return undefined;
  const counted = (x: StackRow) => x.coverage !== 'unique' && x.in_total && x.min_price !== null;
  const sumOf = (list: StackRow[]) => {
    const out: Record<string, number> = {};
    for (const x of list.filter(counted)) out[x.min_currency] = Math.round(((out[x.min_currency] ?? 0) + x.min_price!) * 100) / 100;
    return out;
  };
  const sums = sumOf(rows);
  // Converted only with a named rate source (e.g. the ECB reference rate) and only for euros and dollars – computed here
  // from the rows, so a corrected row changes the total too. Otherwise the page shows the sums per currency.
  const t = r.totals && typeof r.totals === 'object' ? (r.totals as Record<string, any>) : {};
  const rate = money(t.fx_rate_usd_per_eur ?? t.fx_rate ?? t.ecb_rate);
  const source = httpsUrl(t.fx_source ?? t.rate_source ?? t.ecb_source);
  const toEur = (x: Record<string, number>) => (Object.keys(x).every((c) => c === 'EUR' || c === 'USD') ? Math.round(((x.USD ?? 0) / rate! + (x.EUR ?? 0)) * 100) / 100 : undefined);
  const eur = rate && source ? toEur(sums) : undefined;
  const converted = eur !== undefined ? { eur, rate: rate!, source, date: str(t.fx_date ?? t.rate_date, 10) || undefined } : undefined;
  const fullRows = rows.filter((x) => x.coverage === 'full');
  const fullEur = converted ? toEur(sumOf(fullRows)) : undefined;
  return { as_of, rows, sums, converted, fullOnly: fullEur !== undefined ? { eur: fullEur, rows: fullRows.length } : undefined, priced: rows.filter(counted).length };
}

const fmt = (locale: string, currency: string, n: number) => new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(n);

/** "1.234 $ + 56 €" – the sums per currency, dollars first. */
export function sumsText(s: Stack, locale: string): string {
  return Object.entries(s.sums)
    .sort((a, b) => (a[0] === 'USD' ? -1 : b[0] === 'USD' ? 1 : a[0].localeCompare(b[0])))
    .map(([c, n]) => fmt(locale, c, n))
    .join(' + ');
}

/** The section's table (cards on phones). `limit` keeps the first rows (the social card shows about eight). */
export function stackHtml(s: Stack | undefined, c: Copy, lang: Lang, brand: string, limit?: number): string {
  if (!s) return '';
  const label = (x: StackRow) => (lang === 'de' ? x.label_de : x.label_en);
  const note = (x: StackRow) => (lang === 'de' ? x.note_de : x.note_en);
  const rows = (limit ? s.rows.slice(0, limit) : s.rows)
    .map((x, i) => {
      const chips = x.tools.map((t) => `<li title="${h(t.price === null ? c.stack.onRequest : `${t.plan ? `${t.plan} · ` : ''}${fmt(c.locale, t.currency, t.price)}`)}">${h(t.name)}${t.price === null ? '<span class="sr"> – ' + h(c.stack.onRequest) + '</span>' : ''}</li>`).join('');
      const price = x.coverage === 'unique' || x.min_price === null ? '' : `${c.stack.from} ${fmt(c.locale, x.min_currency, x.min_price)}${x.in_total ? '' : '*'}`;
      const ours =
        x.coverage === 'full'
          ? `<span class="cov full">✓ ${h(c.stack.included)}</span>`
          : x.coverage === 'partial'
            ? `<span class="cov part" title="${h(note(x))}">◐ ${h(c.stack.partial)}</span>${note(x) ? `<small>${h(note(x))}</small>` : ''}`
            : `<span class="cov uniq">★ ${h(c.stack.unique.replace(/\{b\}/g, brand))}</span>${note(x) ? `<small>${h(note(x))}</small>` : ''}`;
      return `<tr class="${i % 2 ? 'odd' : 'even'}"><th scope="row" data-l="${h(c.stack.colFeature)}">${h(label(x))}</th><td data-l="${h(c.stack.colReplaces)}"><ul class="tchips">${chips}</ul></td><td class="pr" data-l="${h(c.stack.colPrice)}">${price ? h(price) : `<span class="np" title="${h(c.stack.noPrice)}">–<span class="sr"> ${h(c.stack.noPrice)}</span></span>`}</td><td class="us" data-l="${h(brand)}">${ours}</td></tr>`;
    })
    .join('');
  const total = s.converted ? `${c.stack.about} ${fmt(c.locale, 'EUR', Math.round(s.converted.eur))}` : sumsText(s, c.locale);
  const breakdown = `<em>${h(c.stack.cheapest)}${s.converted ? ` · ${h(sumsText(s, c.locale))}` : ''}</em>`;
  return `<div class="stackw"><div class="stackscroll"><table class="stack"><thead><tr><th scope="col">${h(c.stack.colFeature)}</th><th scope="col">${h(c.stack.colReplaces)}</th><th scope="col">${h(c.stack.colPrice)}</th><th scope="col" class="us">${h(brand)}</th></tr></thead><tbody>${rows}</tbody></table></div>
<div class="stacktotal" role="group" aria-label="${h(c.stack.total)}"><p><span>${h(c.stack.total)}</span><b>${h(total)}<small> ${h(c.stack.perMonth)}</small></b>${breakdown}</p><p class="arrow" aria-hidden="true">→</p><p class="ours"><span>${h(brand)}</span><b>${h(c.stack.totalUs)} <small>${h(c.stack.totalUsNote)}</small></b><em>${h(c.stack.totalCloud)}</em></p></div></div>`;
}

/** The footnote: date, sources, currencies, disclaimer. */
export function stackFoot(s: Stack, c: Copy, brand: string): string {
  const date = new Date(`${s.as_of}T12:00:00Z`).toLocaleDateString(c.locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const src = new Map<string, string>();
  for (const r of s.rows) for (const t of r.tools) if (t.source) src.set(t.source, t.name);
  const list = [...src.entries()].map(([u, n]) => `<a href="${h(u)}" rel="noopener nofollow">${h(n)}</a>`).join(', ');
  const fx = s.converted ? c.stack.converted(String(s.converted.rate), s.converted.source) : c.stack.noConversion;
  const full = s.fullOnly ? ` ${c.stack.fullOnly(s.fullOnly.rows, fmt(c.locale, 'EUR', Math.round(s.fullOnly.eur)))}` : '';
  const notCounted = s.rows.some((r) => !r.in_total && r.coverage !== 'unique') ? ` ${c.stack.notCounted}` : '';
  return `<p class="fine">${h(c.stack.foot(date, s.priced, s.rows.filter((r) => r.coverage !== 'unique').length))} ${list}. ${h(fx)}${h(full)}${h(notCounted)} ${h(c.stack.usage.replace(/\{b\}/g, brand))}</p><p class="fine">${h(c.disclaimer(date).replace(/\{b\}/g, brand))}</p>`;
}
