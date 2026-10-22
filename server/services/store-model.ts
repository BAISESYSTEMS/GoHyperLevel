import { calcTotals, type LineItem, type TaxMode } from './invoice-model.js';

/**
 * The online store's arithmetic, without I/O (docs/store.md): settings with their defaults, shipping rates (flat or by weight, per
 * country, free above an amount), the tax treatment of an order from the existing invoice tax modes, and the quote – the invoice
 * lines of a cart, the shipping line(s) and the totals exactly as the invoice will compute them (VAT once per rate).
 */

export const EU = ['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK'];
export const COUNTRY_NAMES: Record<string, string> = {
  DE: 'Deutschland', AT: 'Österreich', CH: 'Schweiz', NL: 'Niederlande', BE: 'Belgien', LU: 'Luxemburg', FR: 'Frankreich', IT: 'Italien', ES: 'Spanien', PL: 'Polen',
  CZ: 'Tschechien', DK: 'Dänemark', SE: 'Schweden', FI: 'Finnland', IE: 'Irland', PT: 'Portugal', GR: 'Griechenland', HU: 'Ungarn', SK: 'Slowakei', SI: 'Slowenien',
  HR: 'Kroatien', RO: 'Rumänien', BG: 'Bulgarien', EE: 'Estland', LV: 'Lettland', LT: 'Litauen', CY: 'Zypern', MT: 'Malta', GB: 'Vereinigtes Königreich', US: 'USA', LI: 'Liechtenstein', NO: 'Norwegen',
};

export interface ShippingTier {
  up_to_g: number;
  price_cents: number;
}
export interface ShippingRate {
  id: string;
  name: string;
  /** flat: one price; weight: the first tier whose `up_to_g` covers the parcel. */
  type: 'flat' | 'weight';
  /** Price the buyer pays (gross) for a flat rate. */
  price_cents: number;
  tiers: ShippingTier[];
  /** ISO codes; empty = every country the store sells to. */
  countries: string[];
  /** Free above this goods value (gross); 0 = never. */
  free_over_cents: number;
  delivery: string;
}

export interface StoreSettings {
  enabled: boolean;
  name: string;
  slug: string;
  currency: string;
  countries: string[];
  shipping: ShippingRate[];
  order_prefix: string;
  /** Checkout asks to accept the terms (link from Einwilligung & Recht → Kaufseite). */
  terms_required: boolean;
  /** A cart with an e-mail and no order after this many minutes fires checkout.abandoned. */
  abandon_minutes: number;
  /** Gift cards sold in the store: months of validity, 0 = no expiry. */
  gift_valid_months: number;
  /** Who in the team gets a mail per paid order ('' = nobody). */
  notify_email: string;
  /** Text above the order button (e.g. delivery times). */
  checkout_note: string;
}

export const DEFAULT_SETTINGS: StoreSettings = {
  enabled: false,
  name: '',
  slug: '',
  currency: 'EUR',
  countries: ['DE', 'AT', 'CH'],
  shipping: [{ id: 'standard', name: 'Standardversand', type: 'flat', price_cents: 490, tiers: [], countries: [], free_over_cents: 0, delivery: '2–4 Werktage' }],
  order_prefix: 'B-',
  terms_required: true,
  abandon_minutes: 60,
  gift_valid_months: 0,
  notify_email: '',
  checkout_note: '',
};

const cents = (v: unknown, max = 1_000_000_00) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= max ? n : 0;
};
const txt = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const country = (v: unknown) => {
  const c = String(v ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? c : '';
};

/** Settings from the stored JSON or a PUT body; unknown keys are dropped, every value is bounded. */
export function cleanSettings(input: any, base: StoreSettings = DEFAULT_SETTINGS): StoreSettings {
  const b = input && typeof input === 'object' ? input : {};
  const pick = <K extends keyof StoreSettings>(k: K) => (b[k] === undefined ? base[k] : b[k]);
  const countries = (Array.isArray(pick('countries')) ? pick('countries') : base.countries).map(country).filter((c: string) => /^[A-Z]{2}$/.test(c));
  const shipping = (Array.isArray(pick('shipping')) ? pick('shipping') : base.shipping).slice(0, 20).map((r: any, i: number) => ({
    id: /^[a-z0-9_-]{1,40}$/i.test(String(r?.id ?? '')) ? String(r.id) : `rate${i + 1}`,
    name: txt(r?.name, 80) || 'Versand',
    type: r?.type === 'weight' ? 'weight' : 'flat',
    price_cents: cents(r?.price_cents),
    tiers: (Array.isArray(r?.tiers) ? r.tiers : [])
      .slice(0, 20)
      .map((x: any) => ({ up_to_g: cents(x?.up_to_g, 1_000_000), price_cents: cents(x?.price_cents) }))
      .filter((x: ShippingTier) => x.up_to_g > 0)
      .sort((a: ShippingTier, z: ShippingTier) => a.up_to_g - z.up_to_g),
    countries: (Array.isArray(r?.countries) ? r.countries : []).map(country).filter((c: string) => /^[A-Z]{2}$/.test(c)),
    free_over_cents: cents(r?.free_over_cents),
    delivery: txt(r?.delivery, 80),
  })) as ShippingRate[];
  const ids = new Set<string>();
  for (const r of shipping) {
    while (ids.has(r.id)) r.id = `${r.id}x`;
    ids.add(r.id);
  }
  const slug = txt(pick('slug'), 60).toLowerCase();
  return {
    enabled: !!pick('enabled'),
    name: txt(pick('name'), 120),
    slug: /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/.test(slug) ? slug : '',
    currency: /^[A-Z]{3}$/.test(String(pick('currency'))) ? String(pick('currency')) : 'EUR',
    countries: [...new Set(countries)].slice(0, 60) as string[],
    shipping,
    order_prefix: txt(pick('order_prefix'), 10).replace(/[^A-Za-z0-9-]/g, '') || 'B-',
    terms_required: pick('terms_required') !== false,
    abandon_minutes: Math.min(7 * 24 * 60, Math.max(15, Math.round(Number(pick('abandon_minutes')) || 60))),
    gift_valid_months: Math.min(120, Math.max(0, Math.round(Number(pick('gift_valid_months')) || 0))),
    notify_email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(pick('notify_email'))) ? txt(pick('notify_email'), 200) : '',
    checkout_note: txt(pick('checkout_note'), 500),
  };
}

// --- products in the cart -------------------------------------------------------------------------------------------------

export type ProductKind = 'physical' | 'digital' | 'gift_card';
export interface QuoteProduct {
  product_id: string;
  article_id: string | null;
  name: string;
  variant: string;
  sku: string;
  /** Net price per unit (the invoice line's price). */
  net_cents: number;
  tax_rate: number;
  weight_g: number;
  kind: ProductKind;
  /** Units in stock, null = not tracked. */
  stock: number | null;
  image: string;
}

export const GIFT_NOTE = 'Mehrzweck-Gutschein – die Umsatzsteuer entsteht erst bei der Einlösung (§ 3 Abs. 15 UStG)';

/** Gross per unit as the buyer sees it (no VAT outside the regular tax treatment). */
export const grossUnit = (p: Pick<QuoteProduct, 'net_cents' | 'tax_rate' | 'kind'>, mode: TaxMode) => (mode === 'standard' && p.kind !== 'gift_card' ? p.net_cents + Math.round((p.net_cents * p.tax_rate) / 100) : p.net_cents);

/**
 * The tax treatment of an order, from the invoice tax modes: Kleinunternehmer stays § 19; physical goods to a country outside the EU
 * are an export (0 %); a business buyer in another EU country with a valid VAT ID gets an intra-community supply (0 %, only when the
 * seller has a VAT ID); everything else is taxed with the seller's rates (EU consumers below the OSS threshold – see docs).
 */
export function taxModeFor(o: { smallBusiness: boolean; country: string; sellerCountry: string; physical: boolean; buyerVat: boolean; sellerVat: boolean }): TaxMode {
  if (o.smallBusiness) return 'small_business';
  if (o.physical && o.country && !EU.includes(o.country)) return 'export';
  if (o.physical && o.buyerVat && o.sellerVat && EU.includes(o.country) && o.country !== o.sellerCountry) return 'ig_supply';
  return 'standard';
}

/** The shipping rates that serve a country, with their price for this parcel. */
export function shippingOptions(rates: ShippingRate[], o: { country: string; weight_g: number; goods_gross_cents: number }): { id: string; name: string; price_cents: number; delivery: string }[] {
  const out: { id: string; name: string; price_cents: number; delivery: string }[] = [];
  for (const r of rates) {
    if (r.countries.length && !r.countries.includes(o.country)) continue;
    let price = r.price_cents;
    if (r.type === 'weight') {
      const tier = r.tiers.find((t) => o.weight_g <= t.up_to_g);
      if (!tier) continue; // too heavy for this rate
      price = tier.price_cents;
    }
    if (r.free_over_cents > 0 && o.goods_gross_cents >= r.free_over_cents) price = 0;
    out.push({ id: r.id, name: r.name, price_cents: price, delivery: r.delivery });
  }
  return out;
}

/**
 * Shipping as invoice lines: an ancillary service shares the VAT of what is shipped (German practice), so with several rates in the
 * parcel the price is split by the goods' net value per rate. The lines are net; the gross they add up to is the shipping price.
 */
export function shippingLines(name: string, gross: number, goods: { rate: number; net: number }[], mode: TaxMode): LineItem[] {
  if (gross <= 0) return [];
  if (mode !== 'standard') return [{ name, description: '', qty: 1, price_cents: gross, tax_rate: 0 }];
  const byRate = new Map<number, number>();
  for (const g of goods) byRate.set(g.rate, (byRate.get(g.rate) ?? 0) + g.net);
  const rates = [...byRate.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (!rates.length) rates.push([19, 1]);
  const W = rates.reduce((n, [, w]) => n + w, 0);
  let left = gross;
  return rates.map(([rate, w], i) => {
    const part = i === rates.length - 1 ? left : Math.round((gross * w) / W);
    left -= part;
    const net = Math.round((part * 100) / (100 + rate));
    return { name: rates.length > 1 ? `${name} (Anteil ${String(rate).replace('.', ',')} %)` : name, description: '', qty: 1, price_cents: net, tax_rate: rate };
  });
}

export interface QuoteInput {
  items: { p: QuoteProduct; qty: number }[];
  settings: StoreSettings;
  mode: TaxMode;
  country: string;
  shipping_id?: string;
}

export interface Quote {
  mode: TaxMode;
  lines: { product_id: string; article_id: string | null; name: string; variant: string; sku: string; qty: number; unit_cents: number; total_cents: number; kind: ProductKind; image: string; stock: number | null }[];
  items: LineItem[];
  needs_shipping: boolean;
  weight_g: number;
  goods_cents: number;
  shipping_options: { id: string; name: string; price_cents: number; delivery: string }[];
  shipping: { id: string; name: string; price_cents: number; delivery: string } | null;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  tax_groups: { rate: number; tax_cents: number }[];
  problems: string[];
}

/** A cart → invoice lines, shipping and totals (what the order's invoice will say, cent for cent). */
export function buildQuote(q: QuoteInput): Quote {
  const problems: string[] = [];
  const items: LineItem[] = [];
  const lines: Quote['lines'] = [];
  let weight = 0;
  let physical = false;
  const goods: { rate: number; net: number }[] = [];
  for (const { p, qty } of q.items) {
    const n = Math.max(1, Math.min(999, Math.round(qty)));
    if (p.stock !== null && p.stock < n) problems.push(p.stock <= 0 ? `„${p.name}${p.variant ? ` (${p.variant})` : ''}“ ist ausverkauft` : `Von „${p.name}${p.variant ? ` (${p.variant})` : ''}“ sind nur noch ${p.stock} da`);
    const gift = p.kind === 'gift_card';
    const rate = gift || q.mode !== 'standard' ? 0 : p.tax_rate;
    const description = [p.variant ? `Variante: ${p.variant}` : '', p.sku ? `[${p.sku}]` : '', gift ? GIFT_NOTE : ''].filter(Boolean).join(' · ');
    items.push({ name: p.name, description, qty: n, price_cents: p.net_cents, tax_rate: rate } as LineItem);
    const unit = grossUnit(p, q.mode);
    lines.push({ product_id: p.product_id, article_id: p.article_id, name: p.name, variant: p.variant, sku: p.sku, qty: n, unit_cents: unit, total_cents: unit * n, kind: p.kind, image: p.image, stock: p.stock });
    if (p.kind === 'physical') {
      physical = true;
      weight += p.weight_g * n;
      goods.push({ rate, net: p.net_cents * n });
    }
  }
  const goodsCents = lines.reduce((n, l) => n + l.total_cents, 0);
  const options = physical ? shippingOptions(q.settings.shipping, { country: q.country, weight_g: weight, goods_gross_cents: goodsCents }) : [];
  const shipping = physical ? (options.find((o) => o.id === q.shipping_id) ?? options[0] ?? null) : null;
  if (physical && !shipping) problems.push(q.country ? 'In dieses Land liefern wir leider nicht (keine passende Versandart)' : 'Bitte ein Lieferland wählen');
  if (shipping) {
    const ship = shippingLines(`Versand: ${shipping.name}`, shipping.price_cents, goods, q.mode);
    items.push(...ship);
    // VAT is rounded once per rate over all lines: nudge a shipping line's net by a cent or two so the invoice total is exactly
    // the goods plus the shipping price the buyer was shown (when no nudge fits, the cent stays – the invoice is still right).
    const target = goodsCents + shipping.price_cents;
    const first = items.length - ship.length;
    search: for (let i = first; i < items.length && calcTotals(items, q.mode).total_cents !== target; i++) {
      const base = items[i].price_cents;
      for (const d of [-1, 1, -2, 2, -3, 3]) {
        items[i] = { ...items[i], price_cents: base + d };
        if (calcTotals(items, q.mode).total_cents === target) break search;
      }
      items[i] = { ...items[i], price_cents: base };
    }
  }
  const t = calcTotals(items, q.mode);
  return {
    mode: q.mode,
    lines,
    items,
    needs_shipping: physical,
    weight_g: weight,
    goods_cents: goodsCents,
    shipping_options: options,
    shipping,
    subtotal_cents: t.subtotal_cents,
    tax_cents: t.tax_cents,
    total_cents: t.total_cents,
    tax_groups: t.groups.filter((g) => g.tax_cents).map((g) => ({ rate: g.rate, tax_cents: g.tax_cents })),
    problems,
  };
}

export const FULFILMENT = ['unfulfilled', 'processing', 'shipped', 'delivered', 'cancelled'] as const;
export type Fulfilment = (typeof FULFILMENT)[number];
export const FULFILMENT_LABELS: Record<Fulfilment, string> = { unfulfilled: 'Offen', processing: 'In Bearbeitung', shipped: 'Versendet', delivered: 'Zugestellt', cancelled: 'Storniert' };
export const ORDER_STATUS_LABELS: Record<string, string> = { pending: 'Zahlung offen', paid: 'Bezahlt', cancelled: 'Abgebrochen', refunded: 'Erstattet' };

/** A tracking link for the common carriers (the number is printed as it is otherwise). */
export function trackingUrl(carrier: string, number: string): string {
  const n = encodeURIComponent(number.trim());
  if (!n) return '';
  switch (carrier) {
    case 'dhl':
      return `https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=${n}`;
    case 'dpd':
      return `https://tracking.dpd.de/status/de_DE/parcel/${n}`;
    case 'hermes':
      return `https://www.myhermes.de/empfangen/sendungsverfolgung/sendungsinformation#${n}`;
    case 'gls':
      return `https://gls-group.com/DE/de/paketverfolgung?match=${n}`;
    case 'ups':
      return `https://www.ups.com/track?tracknum=${n}`;
    case 'post_at':
      return `https://www.post.at/s/sendungsdetails?snr=${n}`;
    default:
      return '';
  }
}
export const CARRIERS: [string, string][] = [['dhl', 'DHL'], ['dpd', 'DPD'], ['hermes', 'Hermes'], ['gls', 'GLS'], ['ups', 'UPS'], ['post_at', 'Österreichische Post'], ['other', 'Andere']];
