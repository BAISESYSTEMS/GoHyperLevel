import type { App } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { bad } from '../core/http.js';
import { slugify } from '../core/util.js';
import { invoiceSettings } from '../modules/payments.js';
import { DEFAULT_SETTINGS, cleanSettings, type ProductKind, type QuoteProduct, type StoreSettings } from './store-model.js';

/**
 * The store's reads (docs/store.md): settings per sub-account, the catalogue – CRM products with their store fields (published,
 * kind, images, weight, collections) and the stock articles of the inventory (the article linked to the product, its variants and
 * their stock) – in a fixed number of queries, never one per product.
 */

export interface Variant {
  article_id: string;
  label: string;
  sku: string;
  /** Units in stock; null = not tracked (always available). */
  stock: number | null;
  net_cents: number;
}

export interface CatalogProduct {
  id: string;
  location_id: string;
  name: string;
  description: string;
  net_cents: number;
  tax_rate: number;
  currency: string;
  active: boolean;
  recurring: string | null;
  slug: string;
  published: boolean;
  kind: ProductKind;
  images: string[];
  weight_g: number;
  collection_ids: string[];
  variant_prices: Record<string, number>;
  position: number;
  allow_backorder: boolean;
  /** The article linked to the product (no variants) – SKU and stock of the product itself. */
  article_id: string | null;
  sku: string;
  stock: number | null;
  variants: Variant[];
}

export function settingsOf(app: App, locationId: string): StoreSettings {
  const row = app.db.get<{ data: string }>('SELECT data FROM store_settings WHERE location_id = ?', locationId);
  let data: unknown = {};
  try {
    data = row ? JSON.parse(row.data) : {};
  } catch {
    data = {};
  }
  const s = cleanSettings(data, DEFAULT_SETTINGS);
  if (!s.name) s.name = app.location(locationId)?.name ?? '';
  return s;
}

/** The store's key in public links: its short name, else the sub-account id. */
export const storeKey = (app: App, locationId: string) => app.db.get<{ slug: string | null }>('SELECT slug FROM store_settings WHERE location_id = ?', locationId)?.slug || locationId;

/** A public key (short name or sub-account id) → the sub-account of an enabled store. */
export function storeByKey(app: App, key: string): { locationId: string; settings: StoreSettings } | undefined {
  const k = String(key ?? '').slice(0, 80);
  const row = app.db.get<{ location_id: string }>('SELECT location_id FROM store_settings WHERE slug = ?', k.toLowerCase()) ?? app.db.get<{ location_id: string }>('SELECT location_id FROM store_settings WHERE location_id = ?', k);
  if (!row) return undefined;
  const settings = settingsOf(app, row.location_id);
  return settings.enabled ? { locationId: row.location_id, settings } : undefined;
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** The products of a sub-account with their store fields, articles, variants and stock. */
export function catalog(app: App, locationId: string, o: { publishedOnly?: boolean } = {}): CatalogProduct[] {
  const { db } = app;
  const defaultTax = invoiceSettings(app, locationId).tax_rate;
  const rows = db.all<any>(
    `SELECT p.*, s.published, s.slug AS store_slug, s.kind, s.images, s.weight_g, s.collection_ids, s.variant_prices, s.position, s.allow_backorder
     FROM products p LEFT JOIN store_products s ON s.product_id = p.id
     WHERE p.location_id = ?${o.publishedOnly ? ' AND s.published = 1 AND p.active = 1 AND p.recurring IS NULL' : ''}
     ORDER BY COALESCE(s.position, 0), p.name`,
    locationId,
  );
  if (!rows.length) return [];
  // One query for every stock article of the sub-account that belongs to a product (directly or as a variant of one).
  const arts = db.all<{ id: string; sku: string; name: string; variant: string; product_id: string | null; parent_id: string | null; track: number; qty: number }>(
    `SELECT a.id, a.sku, a.name, a.variant, a.product_id, a.parent_id, a.track, COALESCE((SELECT SUM(st.qty) FROM inv_stock st WHERE st.article_id = a.id), 0) AS qty
     FROM inv_articles a WHERE a.location_id = ? AND a.active = 1 AND (a.product_id IS NOT NULL OR a.parent_id IS NOT NULL) ORDER BY a.sku`,
    locationId,
  );
  const byId = new Map(arts.map((a) => [a.id, a]));
  const mainOf = new Map<string, (typeof arts)[number]>();
  for (const a of arts) if (a.product_id && !a.parent_id && !mainOf.has(a.product_id)) mainOf.set(a.product_id, a);
  const childrenOf = new Map<string, (typeof arts)[number][]>();
  for (const a of arts) {
    if (!a.parent_id) continue;
    const parent = byId.get(a.parent_id);
    const productId = parent?.product_id ?? a.product_id;
    if (!productId) continue;
    if (!childrenOf.has(productId)) childrenOf.set(productId, []);
    childrenOf.get(productId)!.push(a);
  }
  const stockOf = (a: { track: number; qty: number }) => (a.track ? Math.floor(num(a.qty) * 1000) / 1000 : null);
  return rows.map((r) => {
    const p = parseJson(r, ['images', 'collection_ids', 'variant_prices']);
    const prices: Record<string, number> = p.variant_prices && typeof p.variant_prices === 'object' ? p.variant_prices : {};
    const net = num(p.price_cents);
    const main = mainOf.get(p.id);
    const variants = (childrenOf.get(p.id) ?? []).map((a) => ({ article_id: a.id, label: a.variant || a.name, sku: a.sku, stock: stockOf(a), net_cents: Number.isInteger(prices[a.id]) ? prices[a.id] : net }));
    return {
      id: p.id,
      location_id: p.location_id,
      name: p.name,
      description: p.description ?? '',
      net_cents: net,
      tax_rate: p.tax_rate === null || p.tax_rate === undefined ? defaultTax : num(p.tax_rate),
      currency: p.currency || 'EUR',
      active: !!p.active,
      recurring: p.recurring ?? null,
      slug: p.store_slug || slugify(p.name) || p.id,
      published: !!p.published,
      kind: (['physical', 'digital', 'gift_card'].includes(p.kind) ? p.kind : 'physical') as ProductKind,
      images: Array.isArray(p.images) ? p.images.filter((x: unknown) => typeof x === 'string').slice(0, 12) : [],
      weight_g: num(p.weight_g),
      collection_ids: Array.isArray(p.collection_ids) ? p.collection_ids.map(String) : [],
      variant_prices: prices,
      position: num(p.position),
      allow_backorder: !!p.allow_backorder,
      article_id: main && !variants.length ? main.id : null,
      sku: main && !variants.length ? main.sku : '',
      stock: main && !variants.length ? stockOf(main) : null,
      variants,
    } satisfies CatalogProduct;
  });
}

/** One line of a cart → what the quote needs; the variant must be one of the product's (and is required when it has some). */
export function quoteProduct(p: CatalogProduct, articleId?: string | null): QuoteProduct {
  const v = p.variants.length ? p.variants.find((x) => x.article_id === articleId) : undefined;
  if (p.variants.length && !v) throw bad(`Bitte eine Variante von „${p.name}“ wählen`);
  const stock = v ? v.stock : p.stock;
  return {
    product_id: p.id,
    article_id: v?.article_id ?? p.article_id,
    name: p.name,
    variant: v?.label ?? '',
    sku: v?.sku ?? p.sku,
    net_cents: v?.net_cents ?? p.net_cents,
    tax_rate: p.tax_rate,
    weight_g: p.weight_g,
    kind: p.kind,
    stock: p.allow_backorder || p.kind === 'gift_card' ? null : stock,
    image: p.images[0] ?? '',
  };
}
