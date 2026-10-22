import { escapeHtml as h } from '../core/template.js';
import type { Copy, Lang } from './landing-copy.js';
import { usdToEur } from './landing-calc.js';

/**
 * Launch landing page: the feature × vendor matrix (landing section, /vergleich) and the "typical tool mix" of the savings
 * calculator, both read from one research file (web/public/landing/competitors.json – every cell with a source and the date
 * of the research). Pure: parsing, validation and HTML; the module reads the file.
 *
 * Schema: { as_of, vendors: [{ id, name, url, pricing: [{ plan, price_month, currency, notes }], source }],
 *           categories: [{ id, label_de, label_en, features: [{ id, label_de, label_en, cells: { <vendorId>: { v, note, source } } }] }] }
 * v is yes | partial | no | addon. Our own column is the vendor id `gohyperlevel` (older files call it `ghl0`).
 */

export type CellValue = 'yes' | 'partial' | 'no' | 'addon';
export interface Cell {
  v: CellValue;
  note?: string;
  source?: string;
}
export interface Vendor {
  id: string;
  name: string;
  url: string;
  pricing: { plan: string; price_month: number | null; currency: string; notes?: string }[];
  source: string;
}
export interface Feature {
  id: string;
  label_de: string;
  label_en: string;
  cells: Record<string, Cell>;
}
export interface Category {
  id: string;
  label_de: string;
  label_en: string;
  features: Feature[];
}
export interface Matrix {
  as_of: string;
  vendors: Vendor[];
  categories: Category[];
}

export const OUR_ID = 'gohyperlevel';
const VALUES: CellValue[] = ['yes', 'partial', 'no', 'addon'];
const ID = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const str = (v: unknown, max = 400) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const httpsUrl = (v: unknown) => {
  const s = str(v, 600);
  return /^https:\/\/[^\s"'<>]+$/i.test(s) ? s : '';
};

/** A research file → a clean matrix (unknown values dropped, links https only, `ghl0` renamed); undefined when unusable. */
export function parseMatrix(raw: unknown): Matrix | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, any>;
  const as_of = /^\d{4}-\d{2}-\d{2}$/.test(String(r.as_of ?? '')) ? String(r.as_of) : '';
  const rename = (id: unknown) => (id === 'ghl0' ? OUR_ID : String(id ?? '').toLowerCase());
  const vendors: Vendor[] = (Array.isArray(r.vendors) ? r.vendors : [])
    .map((v: any) => ({
      id: rename(v?.id),
      name: str(v?.name, 80),
      url: httpsUrl(v?.url),
      source: httpsUrl(v?.source),
      pricing: (Array.isArray(v?.pricing) ? v.pricing : []).slice(0, 12).map((p: any) => ({
        plan: str(p?.plan, 80),
        price_month: typeof p?.price_month === 'number' && Number.isFinite(p.price_month) && p.price_month >= 0 ? p.price_month : null,
        currency: /^[A-Z]{3}$/.test(String(p?.currency ?? '')) ? String(p.currency) : 'USD',
        notes: str(p?.notes, 300),
      })),
    }))
    .filter((v: Vendor) => ID.test(v.id) && v.name);
  const known = new Set(vendors.map((v) => v.id));
  const categories: Category[] = (Array.isArray(r.categories) ? r.categories : [])
    .map((c: any) => ({
      id: String(c?.id ?? '').toLowerCase(),
      label_de: str(c?.label_de, 80),
      label_en: str(c?.label_en, 80) || str(c?.label_de, 80),
      features: (Array.isArray(c?.features) ? c.features : [])
        .map((f: any) => {
          const cells: Record<string, Cell> = {};
          for (const [k, x] of Object.entries((f?.cells ?? {}) as Record<string, any>)) {
            const id = rename(k);
            if (!known.has(id) || !VALUES.includes(x?.v)) continue;
            cells[id] = { v: x.v, note: str(x?.note, 300) || undefined, source: httpsUrl(x?.source) || undefined };
          }
          return { id: String(f?.id ?? ''), label_de: str(f?.label_de, 120), label_en: str(f?.label_en, 120) || str(f?.label_de, 120), cells };
        })
        .filter((f: Feature) => f.label_de && Object.keys(f.cells).length),
    }))
    .filter((c: Category) => ID.test(c.id) && c.label_de && c.features.length);
  if (!as_of || vendors.length < 2 || !categories.length) return undefined;
  // Our column first, the others in the file's order.
  vendors.sort((a, b) => (a.id === OUR_ID ? -1 : b.id === OUR_ID ? 1 : 0));
  return { as_of, vendors, categories };
}

/** Plans, not add-ons ("Add-on: WhatsApp", "Add-ons"). */
const isPlan = (p: { plan: string }) => !/^add-?ons?\b/i.test(p.plan.trim());
/** Paid plans of a vendor, cheapest first (free plans and add-ons skipped); `match` prefers plans with that name. */
function paidPlans(v: Vendor, match?: RegExp) {
  const paid = v.pricing.filter((p) => p.price_month !== null && p.price_month > 0 && isPlan(p));
  const named = match ? paid.filter((p) => match.test(p.plan)) : [];
  return (named.length ? named : paid).sort((a, b) => a.price_month! - b.price_month!);
}

/** Lowest paid monthly price of a vendor (free plans and add-ons skipped), in euro cents; undefined without a usable price. */
export function entryPriceEurCents(v: Vendor, match?: RegExp): number | undefined {
  const pick = paidPlans(v, match)[0];
  if (!pick) return undefined;
  const eur = pick.currency === 'EUR' ? pick.price_month! : pick.currency === 'USD' ? usdToEur(pick.price_month!) : undefined;
  return eur === undefined ? undefined : Math.round(eur * 100);
}

/** The "typical tool mix" a small business pays for instead of one tool (the calculator's first mode). */
export const MIX: { key: string; ids: string[]; plan?: RegExp }[] = [
  { key: 'crm', ids: ['hubspot'], plan: /starter/i },
  { key: 'funnels', ids: ['clickfunnels'] },
  { key: 'courses', ids: ['kajabi'] },
  { key: 'booking', ids: ['calendly'] },
  { key: 'email', ids: ['mailchimp', 'activecampaign'] },
];
export interface MixTool {
  key: string;
  vendor: string;
  plan: string;
  /** The vendor's own price and currency (shown as is – never converted silently). */
  price: number;
  currency: string;
  /** In euro cents, for the total (dollar prices converted at the ECB rate the page names). */
  cents: number;
  source: string;
}
export function mixTools(m: Matrix | undefined): MixTool[] {
  if (!m) return [];
  const out: MixTool[] = [];
  for (const t of MIX) {
    for (const id of t.ids) {
      const v = m.vendors.find((x) => x.id === id);
      const cents = v && entryPriceEurCents(v, t.plan);
      if (!v || cents === undefined) continue;
      const pick = paidPlans(v, t.plan)[0];
      out.push({ key: t.key, vendor: v.name, plan: pick?.plan ?? '', price: pick?.price_month ?? 0, currency: pick?.currency ?? 'USD', cents, source: v.source || v.url });
      break;
    }
  }
  return out;
}

// --- HTML -------------------------------------------------------------------------------------------------------------

const SYMBOL: Record<CellValue | 'unlisted', string> = { yes: '✓', partial: '◐', no: '✗', addon: '＋', unlisted: '–' };

/**
 * A competitor's "no" that rests only on the feature not being listed is shown as "nicht ausgewiesen" (a grey dash), not ✗ –
 * and so is every "no" without a note (when in doubt, the friendlier reading). Our own "no" always stays ✗: where we lose,
 * we say so.
 */
const UNLISTED = /ausgewiesen|dokumentiert|genannt|gefunden|gelistet|angegeben|belegt|not (?:listed|documented|stated|mentioned|found)|unclear|unklar/i;
export function displayValue(vendorId: string, cell: Cell): CellValue | 'unlisted' {
  if (vendorId === OUR_ID || cell.v !== 'no') return cell.v;
  return !cell.note || UNLISTED.test(cell.note) ? 'unlisted' : 'no';
}

/** Prices of a vendor for the price row: "ab 20 $". */
function priceText(v: Vendor, c: Copy): string {
  const paid = paidPlans(v)[0] ?? v.pricing.find((x) => x.price_month !== null && isPlan(x));
  if (!paid) return '–';
  const money = new Intl.NumberFormat(c.locale, { style: 'currency', currency: paid.currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: paid.price_month! % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(paid.price_month!);
  return `${c.matrix.from} ${money}`;
}

/** The CSS of the category chips (goes into the page's <style>): a checked chip hides the rows of the other categories. */
export const matrixCss = (m: Matrix | undefined, idp = 'cmp') =>
  (m?.categories ?? []).map((cat) => `.cmpw:has(#${idp}-c-${cat.id}:checked) tbody tr:not([data-cat="${cat.id}"]){display:none}`).join('');

/**
 * The matrix: sticky header row and first column, horizontal scroll on small screens, category chips that filter without
 * a script (radio inputs + :has), "Stand + Quellen" below. `full` (the /vergleich page) prints every cell's note under its
 * symbol, linked to the cell's source; the compact form (landing page) keeps the note as a tooltip and for screen readers.
 */
export function matrixHtml(m: Matrix | undefined, c: Copy, lang: Lang, brand: string, o: { idp?: string; full?: boolean } = {}): string {
  const idp = o.idp ?? 'cmp';
  if (!m) return `<p class="muted">${h(c.matrix.empty)}</p>`;
  const label = (x: { label_de: string; label_en: string }) => (lang === 'de' ? x.label_de : x.label_en);
  const vname = (v: Vendor) => (v.id === OUR_ID ? brand : v.name);
  const sources = new Map<string, string>();
  for (const v of m.vendors) if (v.source) sources.set(v.source, vname(v));
  const chips = [`<label class="chip"><input type="radio" name="${idp}-cat" value="" checked><span>${h(c.matrix.all)}</span></label>`]
    .concat(m.categories.map((cat) => `<label class="chip"><input type="radio" name="${idp}-cat" id="${idp}-c-${cat.id}" value="${cat.id}"><span>${h(label(cat))}</span></label>`))
    .join('');
  const head = `<tr><th scope="col" class="fcol">${h(c.matrix.vendorCol)}</th>${m.vendors.map((v) => `<th scope="col"${v.id === OUR_ID ? ' class="ours"' : ''}>${h(vname(v))}</th>`).join('')}</tr>`;
  const priceRow = `<tr class="price"><th scope="row" class="fcol">${h(c.matrix.priceRow)}</th>${m.vendors.map((v) => `<td${v.id === OUR_ID ? ' class="ours"' : ''}>${h(v.id === OUR_ID ? c.matrix.ourPrice : priceText(v, c))}</td>`).join('')}</tr>`;
  const word: Record<CellValue | 'unlisted', string> = { yes: c.matrix.yes, partial: c.matrix.partial, no: c.matrix.no, addon: c.matrix.addon, unlisted: c.matrix.unlisted };
  const body = m.categories
    .map((cat) => {
      const rows = cat.features.map((f) => {
        const cells = m.vendors
          .map((v) => {
            const cell = f.cells[v.id];
            const ours = v.id === OUR_ID ? ' ours' : '';
            if (!cell) return `<td class="na${ours}"><span class="sr">${h(c.matrix.unlisted)}</span><span aria-hidden="true">·</span></td>`;
            const d = displayValue(v.id, cell);
            if (cell.source) sources.set(cell.source, vname(v));
            const note = cell.note ?? '';
            const tip = note ? ` title="${h(`${word[d]}: ${note}`)}"` : d === 'unlisted' ? ` title="${h(word[d])}"` : '';
            const shown = o.full && note ? `<small class="cn">${cell.source ? `<a href="${h(cell.source)}" rel="noopener nofollow">${h(note)}</a>` : h(note)}</small>` : note ? `<span class="sr">: ${h(note)}</span>` : '';
            return `<td class="v-${d}${ours}"${tip}><span aria-hidden="true" class="sym">${SYMBOL[d]}</span><span class="sr">${h(word[d])}</span>${shown}</td>`;
          })
          .join('');
        return `<tr data-cat="${cat.id}"><th scope="row" class="fcol">${h(label(f))}</th>${cells}</tr>`;
      });
      return `<tr class="cat" data-cat="${cat.id}"><th scope="rowgroup" colspan="${m.vendors.length + 1}" class="fcol">${h(label(cat))}</th></tr>${rows.join('')}`;
    })
    .join('');
  const legend = (['yes', 'partial', 'addon', 'no', 'unlisted'] as const).map((v) => `<span class="v-${v}"><span aria-hidden="true">${SYMBOL[v]}</span> ${h(word[v])}</span>`).join('');
  const date = new Date(`${m.as_of}T12:00:00Z`).toLocaleDateString(c.locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const host = (u: string) => {
    const x = new URL(u);
    return x.hostname + x.pathname.replace(/\/$/, '');
  };
  const srcList = [...sources.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([u, n]) => `<li><a href="${h(u)}" rel="noopener nofollow">${h(n)}: ${h(host(u))}</a></li>`).join('');
  return `<div class="cmpw${o.full ? ' full' : ''}">
<div class="chips" role="group" aria-label="${h(c.matrix.h2)}">${chips}</div>
<div class="legend">${legend}</div>
<div class="cmpscroll" tabindex="0" role="region" aria-label="${h(c.matrix.h2)}"><table class="cmp"><thead>${head}</thead><tbody>${priceRow}${body}</tbody></table></div>
<p class="asof">${h(c.matrix.asOf(date))} · ${h(c.matrix.priceNote)} · ${h(c.disclaimer(date).replace(/\{b\}/g, brand))}</p>
<details class="srcs"><summary>${h(c.matrix.sources)} (${sources.size})</summary><ul>${srcList}</ul></details></div>`;
}
