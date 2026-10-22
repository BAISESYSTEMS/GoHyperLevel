import type { App, Module } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { HttpError, bad, clampLimit, notFound, num, str, type Ctx } from '../core/http.js';
import { centsToMoney, id, now, slugify } from '../core/util.js';
import { addTags, getContact, logActivity, removeTags, upsertContact } from '../services/contacts.js';
import { issueForInvoice } from '../services/inv-stock.js';
import { notifyTeam, sendToContact } from '../services/messaging.js';
import { getSettings as mkSettings } from '../services/mk-settings.js';
import { bookInvoicePayment, registerPayPurpose, type PaySession } from '../services/pay-registry.js';
import type { SnapshotPart } from '../services/snapshots.js';
import { catalog, settingsOf, storeKey } from '../services/store-catalog.js';
import { CARRIERS, COUNTRY_NAMES, FULFILMENT, FULFILMENT_LABELS, ORDER_STATUS_LABELS, cleanSettings, trackingUrl, type Fulfilment } from '../services/store-model.js';
import { registerTriggers, type TriggerMeta } from '../services/wfx-kit.js';
import { ABANDONED_TAG } from './mk-abandoned.js';
import { createInvoice, sendInvoice } from './payments.js';
import { storePublicModule } from './store-public.js';
import { storeToolsModule } from './store-tools.js';
import { giftCardsModule } from './giftcards.js';
import { payRegistryModule } from './pay-registry.js';

/**
 * Online store (docs/store.md): products with variants (the CRM products and the inventory's articles and variants), collections,
 * flat-rate and weight-based shipping, the existing tax modes (DE/EU), orders that become paid GoBD invoices, take the goods out of
 * stock and fire workflow triggers (placed, paid, shipped), fulfilment with tracking numbers mailed to the buyer, and the abandoned-cart
 * reminder through the existing `checkout.abandoned` trigger. Admin routes /api/store (area "payments"); the public cart, checkout and
 * site blocks live in store-public.ts, MCP tools in store-tools.ts. Money is taken through the payment registry (pay-registry.ts).
 */

const SQL = `
CREATE TABLE store_settings (
  location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE, data TEXT NOT NULL DEFAULT '{}', slug TEXT UNIQUE, seq INTEGER NOT NULL DEFAULT 1000, updated_at TEXT NOT NULL
);
CREATE TABLE store_collections (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, name TEXT NOT NULL, slug TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(location_id, slug)
);
CREATE TABLE store_products (
  product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  published INTEGER NOT NULL DEFAULT 0, slug TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'physical', images TEXT NOT NULL DEFAULT '[]', weight_g INTEGER NOT NULL DEFAULT 0,
  collection_ids TEXT NOT NULL DEFAULT '[]', variant_prices TEXT NOT NULL DEFAULT '{}', position INTEGER NOT NULL DEFAULT 0, allow_backorder INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
CREATE INDEX store_products_loc ON store_products(location_id, published, position);
CREATE TABLE store_carts (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, items TEXT NOT NULL DEFAULT '[]', email TEXT NOT NULL DEFAULT '',
  contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE, country TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open', order_id TEXT, reminded_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX store_carts_due ON store_carts(status, updated_at);
CREATE INDEX store_carts_loc ON store_carts(location_id);
CREATE INDEX store_carts_contact ON store_carts(contact_id);
CREATE TABLE store_orders (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, number TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL, email TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '{}', items TEXT NOT NULL DEFAULT '[]', invoice_items TEXT NOT NULL DEFAULT '[]', tax_mode TEXT NOT NULL DEFAULT 'standard',
  shipping TEXT NOT NULL DEFAULT '{}', goods_cents INTEGER NOT NULL DEFAULT 0, shipping_cents INTEGER NOT NULL DEFAULT 0, tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0, gift_cents INTEGER NOT NULL DEFAULT 0, refunded_cents INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'EUR',
  status TEXT NOT NULL DEFAULT 'pending', fulfilment TEXT NOT NULL DEFAULT 'unfulfilled', carrier TEXT NOT NULL DEFAULT '', tracking_number TEXT NOT NULL DEFAULT '',
  tracking_url TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT '', pay_session_id TEXT, invoice_id TEXT, cart_id TEXT, note TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, paid_at TEXT, shipped_at TEXT, delivered_at TEXT, updated_at TEXT NOT NULL,
  UNIQUE(location_id, number)
);
CREATE INDEX store_orders_loc ON store_orders(location_id, created_at);
CREATE INDEX store_orders_state ON store_orders(location_id, status, fulfilment);
CREATE INDEX store_orders_contact ON store_orders(contact_id);
`;

const ORDER_JSON = ['address', 'items', 'invoice_items', 'shipping', 'meta'];
export const loadOrder = (app: App, locationId: string, orderId: string): any => parseJson(app.db.get('SELECT * FROM store_orders WHERE id = ? AND location_id = ?', orderId, locationId), ORDER_JSON);
/** User text that goes into a mail template: no {{placeholders}} of its own. */
const plain = (v: unknown) => String(v ?? '').replace(/[{}]/g, '');
const money = (c: number, cur: string) => centsToMoney(c, cur);

export const orderUrl = (app: App, o: { location_id: string; token: string }) => `${app.baseUrl()}/store/${encodeURIComponent(storeKey(app, o.location_id))}/order/${o.token}`;

export function orderOut(app: App, o: any) {
  return {
    ...o,
    status_label: ORDER_STATUS_LABELS[o.status] ?? o.status,
    fulfilment_label: FULFILMENT_LABELS[o.fulfilment as Fulfilment] ?? o.fulfilment,
    carrier_label: CARRIERS.find(([k]) => k === o.carrier)?.[1] ?? o.carrier,
    country_name: COUNTRY_NAMES[o.address?.country] ?? o.address?.country ?? '',
    status_url: orderUrl(app, o),
  };
}

const TRIGGERS: TriggerMeta[] = [
  {
    type: 'store.order_placed',
    label: 'Shop: Bestellung aufgegeben',
    category: 'payments',
    summary: 'Jemand hat im Online-Shop bestellt – die Zahlung steht noch aus.',
    doc: '{{event.order.number}}, {{event.order.total_cents}}, {{event.order.currency}}, {{event.order.items}} (Positionen) und {{event.order.status_url}} (Bestellstatus) stehen bereit.',
    fields: [{ key: 'product_id', label: 'Nur mit Produkt (ID)', type: 'text' }],
    sample: { orderId: 'o1', productIds: ['p1'], order: { number: 'B-1001', total_cents: 4490, currency: 'EUR', items: [{ name: 'Tasse', qty: 2 }], status_url: 'https://example.com/store/shop/order/abc' } },
    keywords: 'shop bestellung aufgegeben warenkorb kasse online-shop order',
  },
  {
    type: 'store.order_paid',
    label: 'Shop: Bestellung bezahlt',
    category: 'payments',
    summary: 'Die Zahlung einer Shop-Bestellung ist eingegangen – die Rechnung ist ausgestellt.',
    doc: '{{event.order.number}}, {{event.order.total_cents}}, {{event.invoiceId}}, {{event.provider}} (stripe, paypal, mollie, giftcard) und {{event.order.items}} stehen bereit – z. B. für eine Dankes-Serie oder ein Tag.',
    fields: [{ key: 'product_id', label: 'Nur mit Produkt (ID)', type: 'text' }],
    sample: { orderId: 'o1', invoiceId: 'i1', provider: 'paypal', productIds: ['p1'], order: { number: 'B-1001', total_cents: 4490, currency: 'EUR', items: [{ name: 'Tasse', qty: 2 }] } },
    keywords: 'shop bestellung bezahlt zahlung eingegangen online-shop order paid',
  },
  {
    type: 'store.order_shipped',
    label: 'Shop: Bestellung versendet',
    category: 'payments',
    summary: 'Eine Shop-Bestellung wurde als versendet markiert (mit Sendungsnummer).',
    doc: '{{event.order.number}}, {{event.order.carrier_label}}, {{event.order.tracking_number}} und {{event.order.tracking_url}} stehen bereit – z. B. für eine SMS oder eine Bewertungsanfrage ein paar Tage später.',
    fields: [],
    sample: { orderId: 'o1', order: { number: 'B-1001', carrier_label: 'DHL', tracking_number: '00340434161234567890', tracking_url: 'https://www.dhl.de/…' } },
    keywords: 'shop versendet versand sendungsnummer tracking paket',
  },
];

export const storeModule: Module = {
  name: 'store',
  migrations: [['001-init', SQL]],
  register(app: App) {
    const { db, router } = app;
    registerTriggers(app, TRIGGERS);
    const filters = (app.services.workflowTriggerFilters ?? {}) as Record<string, (c: Record<string, any>, d: Record<string, any>) => boolean>;
    filters['store.order_placed'] = filters['store.order_paid'] = (c, d) => !c.product_id || (Array.isArray(d.productIds) && d.productIds.includes(c.product_id));
    app.services.workflowTriggerFilters = filters;
    const mine = (ctx: Ctx) => {
      const o = loadOrder(app, ctx.locationId, ctx.params.id);
      if (!o) throw notFound('Bestellung nicht gefunden');
      return o;
    };
    const event = (o: any) => ({ id: o.id, number: o.number, total_cents: o.total_cents, currency: o.currency, items: o.items, status: o.status, fulfilment: o.fulfilment, carrier_label: CARRIERS.find(([k]) => k === o.carrier)?.[1] ?? o.carrier, tracking_number: o.tracking_number, tracking_url: o.tracking_url, status_url: orderUrl(app, o) });

    // --- settings ---------------------------------------------------------------------------------------------------------------
    const settingsOut = (loc: string) => {
      const s = settingsOf(app, loc);
      const key = storeKey(app, loc);
      const stats = db.get<{ open: number; paid: number; revenue: number }>(
        `SELECT SUM(status = 'paid' AND fulfilment IN ('unfulfilled', 'processing')) AS open, SUM(status = 'paid') AS paid, COALESCE(SUM(CASE WHEN status = 'paid' THEN total_cents - refunded_cents ELSE 0 END), 0) AS revenue FROM store_orders WHERE location_id = ?`,
        loc,
      );
      return { ...s, key, checkout_url: `${app.baseUrl()}/store/${encodeURIComponent(key)}/checkout`, providers: app.services.payRegistry?.ready(loc) ?? [], stats: { to_ship: stats?.open ?? 0, paid: stats?.paid ?? 0, revenue_cents: stats?.revenue ?? 0 }, carriers: CARRIERS, countries: COUNTRY_NAMES };
    };
    router.get('/api/store/settings', 'location', (ctx) => settingsOut(ctx.locationId));
    router.put('/api/store/settings', 'location', (ctx) => {
      const next = cleanSettings(ctx.body ?? {}, settingsOf(app, ctx.locationId));
      if (ctx.body?.slug !== undefined && ctx.body.slug !== '' && !next.slug) throw bad('Kurzname: 3–60 Zeichen, Kleinbuchstaben, Ziffern und Bindestriche');
      if (next.slug && db.get('SELECT 1 AS x FROM store_settings WHERE slug = ? AND location_id != ?', next.slug, ctx.locationId)) throw bad('Dieser Kurzname ist schon vergeben');
      if (!next.countries.length) throw bad('Mindestens ein Lieferland');
      db.run(
        `INSERT INTO store_settings (location_id, data, slug, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET data = excluded.data, slug = excluded.slug, updated_at = excluded.updated_at`,
        ctx.locationId, JSON.stringify(next), next.slug || null, now(),
      );
      return settingsOut(ctx.locationId);
    });

    // --- products (the store fields of the CRM products) --------------------------------------------------------------------------
    router.get('/api/store/products', 'location', (ctx) => catalog(app, ctx.locationId));
    router.put('/api/store/products/:id', 'location', (ctx) => {
      const p = db.get<{ id: string; name: string; recurring: string | null }>('SELECT id, name, recurring FROM products WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!p) throw notFound('Produkt nicht gefunden');
      const b = ctx.body ?? {};
      const cur = parseJson(db.get<any>('SELECT * FROM store_products WHERE product_id = ?', p.id), ['images', 'collection_ids', 'variant_prices']);
      const published = b.published === undefined ? !!cur?.published : !!b.published;
      if (published && p.recurring) throw bad('Abo-Produkte gibt es nur über Kauf-Links (Stripe-Abo), nicht im Warenkorb');
      const slug = b.slug !== undefined ? slugify(String(b.slug)) : (cur?.slug ?? slugify(p.name));
      if (slug && db.get('SELECT 1 AS x FROM store_products WHERE location_id = ? AND slug = ? AND product_id != ?', ctx.locationId, slug, p.id)) throw bad('Diesen Kurznamen hat schon ein anderes Produkt');
      const images = b.images !== undefined ? (Array.isArray(b.images) ? b.images : []).map((x: unknown) => String(x).trim()).filter((x: string) => /^(https:\/\/|\/uploads)/.test(x) && x.length < 1000).slice(0, 12) : (cur?.images ?? []);
      const collections = b.collection_ids !== undefined ? (Array.isArray(b.collection_ids) ? b.collection_ids.map(String) : []) : (cur?.collection_ids ?? []);
      for (const c of collections) if (!db.get('SELECT 1 AS x FROM store_collections WHERE id = ? AND location_id = ?', c, ctx.locationId)) throw bad('Diese Kollektion gibt es nicht');
      const prices: Record<string, number> = {};
      const rawPrices = b.variant_prices !== undefined ? b.variant_prices : (cur?.variant_prices ?? {});
      for (const [k, v] of Object.entries(rawPrices && typeof rawPrices === 'object' ? rawPrices : {})) {
        if (v === '' || v === null || v === undefined) continue;
        const n = Math.round(Number(v));
        if (!Number.isInteger(n) || n < 0) throw bad('Variantenpreis ungültig');
        if (db.get('SELECT 1 AS x FROM inv_articles WHERE id = ? AND location_id = ?', k, ctx.locationId)) prices[k] = n;
      }
      const kind = b.kind !== undefined ? (['physical', 'digital', 'gift_card'].includes(b.kind) ? b.kind : 'physical') : (cur?.kind ?? 'physical');
      const row = {
        product_id: p.id,
        location_id: ctx.locationId,
        published: published ? 1 : 0,
        slug: slug || p.id,
        kind,
        images,
        weight_g: b.weight_g !== undefined ? Math.max(0, Math.min(1_000_000, Math.round(num(b.weight_g)))) : (cur?.weight_g ?? 0),
        collection_ids: [...new Set(collections)],
        variant_prices: prices,
        position: b.position !== undefined ? Math.round(num(b.position)) : (cur?.position ?? 0),
        allow_backorder: b.allow_backorder !== undefined ? (b.allow_backorder ? 1 : 0) : (cur?.allow_backorder ?? 0),
        updated_at: now(),
      };
      db.run('DELETE FROM store_products WHERE product_id = ?', p.id);
      db.insert('store_products', row);
      return catalog(app, ctx.locationId).find((x) => x.id === p.id);
    });

    // --- collections --------------------------------------------------------------------------------------------------------------
    router.get('/api/store/collections', 'location', (ctx) => db.all('SELECT * FROM store_collections WHERE location_id = ? ORDER BY position, name', ctx.locationId));
    const cleanCollection = (loc: string, b: any, curId = '') => {
      const name = str(b.name, 'Name', { required: true, max: 80 });
      const slug = slugify(b.slug || name);
      if (!slug) throw bad('Kurzname fehlt');
      if (db.get('SELECT 1 AS x FROM store_collections WHERE location_id = ? AND slug = ? AND id != ?', loc, slug, curId)) throw bad('Diesen Kurznamen hat schon eine Kollektion');
      return { name, slug, description: str(b.description, 'Beschreibung', { max: 1000 }), position: Math.round(num(b.position, 0)) };
    };
    router.post('/api/store/collections', 'location', (ctx) => {
      const row = { id: id(), location_id: ctx.locationId, ...cleanCollection(ctx.locationId, ctx.body ?? {}), created_at: now(), updated_at: now() };
      db.insert('store_collections', row);
      return row;
    });
    router.patch('/api/store/collections/:id', 'location', (ctx) => {
      const cur = db.get<any>('SELECT * FROM store_collections WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!cur) throw notFound('Kollektion nicht gefunden');
      db.update('store_collections', cur.id, { ...cleanCollection(ctx.locationId, { ...cur, ...(ctx.body ?? {}) }, cur.id), updated_at: now() }, ctx.locationId);
      return db.get('SELECT * FROM store_collections WHERE id = ?', cur.id);
    });
    router.delete('/api/store/collections/:id', 'location', (ctx) => {
      db.tx(() => {
        db.run('DELETE FROM store_collections WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
        db.run(`UPDATE store_products SET collection_ids = (SELECT COALESCE(json_group_array(value), '[]') FROM json_each(store_products.collection_ids) WHERE value != ?) WHERE location_id = ? AND instr(collection_ids, ?) > 0`, ctx.params.id, ctx.locationId, ctx.params.id);
      });
      return { ok: true };
    });

    // --- orders -----------------------------------------------------------------------------------------------------------------------
    router.get('/api/store/orders', 'location', (ctx) => {
      const where = ['location_id = ?'];
      const args: string[] = [ctx.locationId];
      const st = ctx.query.get('status');
      if (st && Object.hasOwn(ORDER_STATUS_LABELS, st)) (where.push('status = ?'), args.push(st));
      const ful = ctx.query.get('fulfilment');
      if (ful === 'open') where.push(`status = 'paid' AND fulfilment IN ('unfulfilled', 'processing')`);
      else if (ful && (FULFILMENT as readonly string[]).includes(ful)) (where.push('fulfilment = ?'), args.push(ful));
      const q = String(ctx.query.get('q') ?? '').trim().slice(0, 80);
      if (q) (where.push('(number LIKE ? OR email LIKE ? OR name LIKE ? OR tracking_number LIKE ?)'), args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`));
      const rows = parseRows(db.all(`SELECT * FROM store_orders WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${clampLimit(ctx.query.get('limit'), 100, 500)}`, ...args), ORDER_JSON);
      return rows.map((o) => orderOut(app, o));
    });
    router.get('/api/store/orders/:id', 'location', (ctx) => {
      const o = mine(ctx);
      const inv = o.invoice_id ? db.get<any>('SELECT id, number, status, total_cents, paid_cents, public_token FROM invoices WHERE id = ? AND location_id = ?', o.invoice_id, ctx.locationId) : null;
      const pay = o.pay_session_id ? app.services.payRegistry?.get(o.pay_session_id) : undefined;
      const cards = db.all('SELECT id, code, initial_cents, balance_cents, currency, recipient_email FROM gift_cards WHERE order_id = ? AND location_id = ?', o.id, ctx.locationId);
      return {
        ...orderOut(app, o),
        invoice: inv ? { id: inv.id, number: inv.number, status: inv.status, total_cents: inv.total_cents, url: `${app.baseUrl()}/i/${inv.public_token}` } : null,
        payment: pay ? { id: pay.id, provider: pay.provider, provider_label: app.services.payRegistry.label(pay.provider), status: pay.status, received_cents: pay.received_cents, gift_cents: pay.gift_cents, refunded_cents: pay.refunded_cents, provider_ref: pay.provider_ref } : null,
        gift_cards: cards,
      };
    });
    router.patch('/api/store/orders/:id', 'location', async (ctx) => {
      const o = mine(ctx);
      const b = ctx.body ?? {};
      const patch: Record<string, unknown> = { updated_at: now() };
      if (b.carrier !== undefined) patch.carrier = CARRIERS.some(([k]) => k === b.carrier) ? b.carrier : '';
      if (b.tracking_number !== undefined) patch.tracking_number = str(b.tracking_number, 'Sendungsnummer', { max: 60 }).replace(/\s+/g, '');
      if (b.note !== undefined) patch.note = str(b.note, 'Notiz', { max: 2000 });
      const carrier = String(patch.carrier ?? o.carrier);
      const tracking = String(patch.tracking_number ?? o.tracking_number);
      if (b.tracking_url !== undefined) {
        const u = str(b.tracking_url, 'Tracking-Link', { max: 500 });
        if (u && !/^https:\/\/\S+$/.test(u)) throw bad('Tracking-Link: bitte mit https:// angeben');
        patch.tracking_url = u;
      } else if (patch.carrier !== undefined || patch.tracking_number !== undefined) patch.tracking_url = trackingUrl(carrier, tracking);
      let shipped = false;
      if (b.fulfilment !== undefined) {
        if (!(FULFILMENT as readonly string[]).includes(b.fulfilment)) throw bad('Unbekannter Versandstatus');
        if (b.fulfilment !== 'cancelled' && o.status !== 'paid') throw new HttpError(409, 'Erst wenn die Bestellung bezahlt ist, lässt sie sich versenden');
        patch.fulfilment = b.fulfilment;
        if (b.fulfilment === 'shipped' && o.fulfilment !== 'shipped') {
          patch.shipped_at = now();
          shipped = true;
        }
        if (b.fulfilment === 'delivered') patch.delivered_at = now();
        if (b.fulfilment === 'cancelled' && o.status === 'pending') {
          patch.status = 'cancelled';
          if (o.pay_session_id) app.services.payRegistry?.lapse(o.pay_session_id, 'cancelled');
        }
      }
      db.update('store_orders', o.id, patch, ctx.locationId);
      const next = loadOrder(app, ctx.locationId, o.id);
      let mail: { status: string } | null = null;
      if (shipped) {
        if (o.contact_id) logActivity(app, ctx.locationId, o.contact_id, 'store.order_shipped', `Bestellung ${o.number} versendet${tracking ? ` (${tracking})` : ''}`);
        app.events.emit(ctx.locationId, 'store.order_shipped', { contactId: o.contact_id ?? undefined, orderId: o.id, order: event(next) });
        if (b.notify !== false && next.contact_id) mail = await shippedMail(next).catch((e) => ({ status: `failed: ${(e as Error).message}` }));
      }
      return { ...orderOut(app, next), mail };
    });
    router.post('/api/store/orders/:id/refund', 'location', async (ctx) => {
      const o = mine(ctx);
      if (o.status !== 'paid') throw new HttpError(409, 'Nur bezahlte Bestellungen lassen sich erstatten');
      const reg = app.services.payRegistry;
      if (!o.pay_session_id || !reg) throw new HttpError(409, 'Zu dieser Bestellung gibt es keine Online-Zahlung');
      const partial = ctx.body?.amount_cents !== undefined && ctx.body.amount_cents !== '';
      const r = partial ? { ...(await reg.refund(o.pay_session_id, Math.round(num(ctx.body.amount_cents)))), gift_cents: 0 } : await reg.refundAll(o.pay_session_id);
      const back = r.amount_cents + r.gift_cents;
      const full = !partial;
      db.run(`UPDATE store_orders SET refunded_cents = refunded_cents + ?, status = CASE WHEN ? THEN 'refunded' ELSE status END, fulfilment = CASE WHEN ? AND fulfilment IN ('unfulfilled', 'processing') THEN 'cancelled' ELSE fulfilment END, updated_at = ? WHERE id = ?`, back, full ? 1 : 0, full ? 1 : 0, now(), o.id);
      // Gift cards this order sold and nobody used yet are switched off with a full refund.
      if (full) db.run(`UPDATE gift_cards SET status = 'disabled', updated_at = ? WHERE order_id = ? AND location_id = ? AND balance_cents = initial_cents`, now(), o.id, ctx.locationId);
      if (o.contact_id) logActivity(app, ctx.locationId, o.contact_id, 'payment.refunded', `Bestellung ${o.number}: ${money(back, o.currency)} erstattet`);
      app.events.emit(ctx.locationId, 'payment.refunded', { contactId: o.contact_id ?? null, orderId: o.id, invoiceId: o.invoice_id ?? null, amount_cents: back, currency: o.currency, full });
      return { ...orderOut(app, loadOrder(app, ctx.locationId, o.id)), refund: r, hint: 'Die Rechnung bleibt bestehen – für eine Korrektur der Umsatzsteuer eine Gutschrift oder Stornorechnung erstellen.' };
    });
    router.post('/api/store/orders/:id/resend', 'location', async (ctx) => {
      const o = mine(ctx);
      if (o.status !== 'paid' || !o.invoice_id) throw new HttpError(409, 'Die Bestätigung gibt es erst, wenn die Bestellung bezahlt ist');
      await confirmationMail(o);
      return { ok: true };
    });

    // --- paying: the purpose of the payment registry ---------------------------------------------------------------------------------
    const lineText = (o: any) => [...o.items.map((l: any) => `${l.qty} × ${plain(l.name)}${l.variant ? ` (${plain(l.variant)})` : ''} – ${money(l.total_cents, o.currency)}`), o.shipping?.name ? `Versand: ${plain(o.shipping.name)} – ${money(o.shipping_cents, o.currency)}` : '', `Gesamt: ${money(o.total_cents, o.currency)}${o.gift_cents ? ` (davon ${money(o.gift_cents, o.currency)} mit Gutschein)` : ''}`].filter(Boolean).join('\n');
    const addressText = (o: any) => [plain(o.name), plain(o.address?.company), plain(o.address?.street), `${plain(o.address?.postal_code)} ${plain(o.address?.city)}`.trim(), COUNTRY_NAMES[o.address?.country] ?? plain(o.address?.country)].filter(Boolean).join('\n');

    async function confirmationMail(o: any) {
      if (!o.contact_id || !o.invoice_id) return;
      const inv = parseJson(db.get('SELECT * FROM invoices WHERE id = ?', o.invoice_id), ['items']);
      if (!inv) return;
      await sendInvoice(app, o.location_id, inv, {
        subject: `Deine Bestellung ${o.number} – vielen Dank!`,
        body: `Hallo {{contact.first_name|}},\n\nvielen Dank für deine Bestellung ${o.number} bei {{location.name}}. Die Zahlung ist eingegangen.\n\n${lineText(o)}\n${o.shipping?.name ? `\nLieferadresse:\n${addressText(o)}\n` : ''}\nDeine Rechnung: {{invoice.url}}\nBestellstatus: ${orderUrl(app, o)}\n\nViele Grüße\n{{location.name}}`,
      });
    }
    async function shippedMail(o: any) {
      const carrier = CARRIERS.find(([k]) => k === o.carrier)?.[1] ?? '';
      const c = getContact(app, o.location_id, o.contact_id);
      const body = `Hallo ${plain(c?.first_name ?? '')},\n\ndeine Bestellung ${o.number} ist unterwegs.${carrier || o.tracking_number ? `\n${carrier ? `Versand mit ${carrier}` : 'Sendungsnummer'}${o.tracking_number ? `${carrier ? ', Sendungsnummer' : ''}: ${o.tracking_number}` : ''}` : ''}${o.tracking_url ? `\nSendung verfolgen: ${o.tracking_url}` : ''}\n\nBestellstatus: ${orderUrl(app, o)}\n\nViele Grüße\n${app.location(o.location_id)?.name ?? ''}`;
      return sendToContact(app, o.location_id, { contactId: o.contact_id, channel: 'email', subject: `Deine Bestellung ${o.number} ist unterwegs`, body, source: 'Online-Shop', purpose: 'transactional', ignoreDnd: true });
    }

    /**
     * The money for an order arrived: the paid invoice (finalised, GoBD number) with the gift-card part and the provider's part as
     * payments, the goods out of stock, sold gift cards issued and mailed, triggers, the confirmation with the invoice. A booking
     * that fails (e.g. strict pre-check in the invoice settings) never loses the order: it is paid, the invoice stays a draft and
     * the team is told.
     */
    function completeOrder(s: PaySession, received: number) {
      const o = loadOrder(app, s.location_id, s.ref_id);
      if (!o || o.status === 'paid' || o.status === 'refunded') return;
      const loc = s.location_id;
      const via = app.services.payRegistry?.label(s.provider) ?? s.provider;
      if (received + s.gift_cents < o.total_cents) {
        db.run(`UPDATE store_orders SET meta = json_set(meta, '$.payment_mismatch', ?), updated_at = ? WHERE id = ?`, `${money(received + s.gift_cents, o.currency)} statt ${money(o.total_cents, o.currency)}`, now(), o.id);
        void notifyTeam(app, loc, `Bestellung ${o.number}: Betrag passt nicht`, `Für die Bestellung ${o.number} kamen ${money(received + s.gift_cents, o.currency)} statt ${money(o.total_cents, o.currency)} an (${via}). Bitte prüfen.`).catch(() => undefined);
        return;
      }
      let invoiceId: string | null = null;
      let invoiceError = '';
      try {
        invoiceId = createInvoice(app, loc, { kind: 'invoice', contact_id: o.contact_id, title: `Bestellung ${o.number}`, items: o.invoice_items, currency: o.currency, tax_mode: o.tax_mode, buyer_vat_id: o.meta?.vat_id || undefined, notes: `Online-Shop-Bestellung ${o.number}. Bezahlt über ${via}. Vielen Dank für deinen Einkauf!` }).id;
        if (s.gift_cents > 0 && s.gift_card_id) app.services.giftCards?.payInvoice(loc, invoiceId, s.gift_card_id, s.gift_cents, s.id);
        if (received > 0) bookInvoicePayment(app, loc, invoiceId, { amount: received, currency: s.currency, via, note: s.capture_ref || s.provider_ref });
      } catch (e) {
        invoiceError = (e as Error).message;
        console.error('[store] invoice', invoiceError);
      }
      db.run(
        `UPDATE store_orders SET status = 'paid', paid_at = ?, invoice_id = ?, provider = ?, pay_session_id = ?, meta = json_set(meta, '$.invoice_error', ?), updated_at = ? WHERE id = ?`,
        now(), invoiceId, s.provider, s.id, invoiceError, now(), o.id,
      );
      if (o.cart_id) db.run(`UPDATE store_carts SET status = 'ordered', order_id = ?, updated_at = ? WHERE id = ?`, o.id, now(), o.cart_id);
      const paid = loadOrder(app, loc, o.id);
      // Goods out of stock (once per invoice and article – the inventory's own listener on invoice.paid finds them done).
      if (invoiceId) {
        try {
          issueForInvoice(app, loc, { id: invoiceId, number: db.get<{ number: string }>('SELECT number FROM invoices WHERE id = ?', invoiceId)?.number ?? o.number, items: o.invoice_items });
        } catch (e) {
          console.error('[store] stock', (e as Error).message);
        }
      }
      // Gift cards the order sold: one card per unit, valid as set in the store settings.
      const gc = app.services.giftCards;
      const settings = settingsOf(app, loc);
      const recipient = paid.meta?.gift_recipient ?? {};
      for (const l of paid.items.filter((x: any) => x.kind === 'gift_card')) {
        for (let i = 0; i < l.qty && gc; i++) {
          const card = gc.issue(loc, {
            amount_cents: l.unit_cents,
            currency: o.currency,
            expires_at: settings.gift_valid_months ? new Date(Date.now() + settings.gift_valid_months * 30.44 * 864e5).toISOString() : null,
            contact_id: o.contact_id,
            recipient_name: recipient.name ?? '',
            recipient_email: recipient.email ?? '',
            message: recipient.message ?? '',
            source: 'store',
            order_id: o.id,
            note: `Bestellung ${o.number}`,
          });
          void gc.send(card, recipient.email ? plain(o.name) : '').catch((e: Error) => console.error('[store] gift card mail', e.message));
        }
      }
      if (o.contact_id) {
        removeTags(app, loc, o.contact_id, [ABANDONED_TAG]);
        logActivity(app, loc, o.contact_id, 'store.order_paid', `Bestellung ${o.number} bezahlt (${money(o.total_cents, o.currency)}, ${via})`);
      }
      app.events.emit(loc, 'store.order_paid', { contactId: o.contact_id ?? undefined, orderId: o.id, invoiceId, provider: s.provider, productIds: [...new Set(o.items.map((l: any) => l.product_id))], order: event(paid) });
      if (settings.notify_email) void notifyTeam(app, loc, `Neue Bestellung ${o.number}`, `${plain(o.name)} <${o.email}>\n\n${lineText(paid)}\n\n${app.baseUrl()}/app/shop`, settings.notify_email).catch(() => undefined);
      if (invoiceError) void notifyTeam(app, loc, `Bestellung ${o.number}: Rechnung nicht festgeschrieben`, `Die Bestellung ${o.number} ist bezahlt, die Rechnung blieb ein Entwurf: ${invoiceError}`).catch(() => undefined);
      else void confirmationMail(paid).catch((e) => console.error('[store] confirmation', (e as Error).message));
    }
    registerPayPurpose(app, 'store_order', {
      settle: (_a, s, received) => completeOrder(s, received),
      lapse: (_a, s) => void db.run(`UPDATE store_orders SET status = 'cancelled', updated_at = ? WHERE id = ? AND location_id = ? AND status = 'pending'`, now(), s.ref_id, s.location_id),
    });
    app.services.store = { orderOut: (o: any) => orderOut(app, o), loadOrder: (loc: string, oid: string) => loadOrder(app, loc, oid), orderUrl: (o: any) => orderUrl(app, o) };

    // --- abandoned carts: the existing trigger checkout.abandoned (modules/mk-abandoned.ts) ----------------------------------------------
    app.onTick(() => {
      const due = db.all<any>(`SELECT c.*, s.data AS settings FROM store_carts c JOIN store_settings s ON s.location_id = c.location_id WHERE c.status = 'open' AND c.email != '' AND c.reminded_at IS NULL AND c.updated_at < ? AND c.items != '[]' LIMIT 100`, new Date(Date.now() - 15 * 60_000).toISOString());
      for (const cart of due) {
        try {
          abandoned(cart);
        } catch (e) {
          console.error('[store] abandoned', (e as Error).message);
        }
      }
    });
    function abandoned(cart: any) {
      const loc = cart.location_id;
      const settings = settingsOf(app, loc);
      if (Date.parse(cart.updated_at) > Date.now() - settings.abandon_minutes * 60_000) return;
      db.run('UPDATE store_carts SET reminded_at = ? WHERE id = ?', now(), cart.id);
      if (!settings.enabled) return;
      let contactId: string | null = cart.contact_id ?? db.get<{ id: string }>('SELECT id FROM contacts WHERE location_id = ? AND email = ?', loc, cart.email)?.id ?? null;
      if (!contactId && mkSettings(app, loc).abandoned.create_contacts) contactId = upsertContact(app, loc, { email: cart.email }, { source: 'Online-Shop: Warenkorb abgebrochen' }).contact.id;
      if (!contactId) return;
      // Ordered and paid meanwhile (another cart, another device): nothing to remind.
      if (db.get(`SELECT 1 AS x FROM store_orders WHERE location_id = ? AND contact_id = ? AND status = 'paid' AND created_at >= ? LIMIT 1`, loc, contactId, cart.created_at)) return;
      const items: { product_id: string; qty: number }[] = JSON.parse(cart.items);
      const products = catalog(app, loc, { publishedOnly: true });
      const first = products.find((p) => p.id === items[0]?.product_id);
      const amount = items.reduce((n, it) => n + (products.find((p) => p.id === it.product_id)?.net_cents ?? 0) * (Number(it.qty) || 1), 0);
      const recovery = `${app.baseUrl()}/store/${encodeURIComponent(storeKey(app, loc))}/checkout?cart=${encodeURIComponent(cart.id)}`;
      addTags(app, loc, contactId, [ABANDONED_TAG]);
      logActivity(app, loc, contactId, 'checkout.abandoned', `Warenkorb im Online-Shop abgebrochen${first ? `: ${first.name}` : ''}`);
      app.events.emit(loc, 'checkout.abandoned', {
        contactId,
        productId: first?.id ?? '',
        product: { id: first?.id ?? '', name: first?.name ?? 'Warenkorb' },
        product_name: items.length > 1 ? `${first?.name ?? 'Produkt'} und ${items.length - 1} weitere` : (first?.name ?? 'Warenkorb'),
        amount_cents: amount,
        currency: settings.currency,
        checkoutId: cart.id,
        recovery_url: recovery,
        source: 'store',
      });
    }

    // --- snapshots: store settings, collections and the products' store fields --------------------------------------------------------------
    const part: SnapshotPart = {
      key: 'store',
      export: (_a, loc, only) => {
        if (only) return [];
        const s = settingsOf(app, loc);
        const items: Record<string, any>[] = [{ type: 'settings', data: { ...s, slug: '', enabled: false } }];
        for (const c of db.all<any>('SELECT * FROM store_collections WHERE location_id = ? ORDER BY position, name', loc)) items.push({ type: 'collection', id: c.id, name: c.name, slug: c.slug, description: c.description, position: c.position });
        for (const p of parseRows(db.all<any>('SELECT * FROM store_products WHERE location_id = ?', loc), ['images', 'collection_ids'])) items.push({ type: 'product', product_id: p.product_id, published: p.published, slug: p.slug, kind: p.kind, images: p.images, weight_g: p.weight_g, collection_ids: p.collection_ids, position: p.position, allow_backorder: p.allow_backorder });
        return items;
      },
      prepare: (_a, items, maps) => {
        maps.storeCollections = new Map();
        for (const it of items) if (it.type === 'collection' && typeof it.id === 'string') maps.storeCollections.set(it.id, id());
      },
      apply: (_a, loc, items, c) => {
        let n = 0;
        for (const it of items.slice(0, 2000)) {
          if (it.type === 'settings') {
            const s = cleanSettings(it.data ?? {}, settingsOf(app, loc));
            db.run(`INSERT INTO store_settings (location_id, data, slug, updated_at) VALUES (?, ?, NULL, ?) ON CONFLICT(location_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`, loc, JSON.stringify({ ...s, slug: '', enabled: false }), now());
          } else if (it.type === 'collection') {
            const nid = c.maps.storeCollections?.get(it.id) ?? id();
            const slug = slugify(String(it.slug || it.name || 'kollektion'));
            if (db.get('SELECT 1 AS x FROM store_collections WHERE location_id = ? AND slug = ?', loc, slug)) continue;
            db.insert('store_collections', { id: nid, location_id: loc, name: String(it.name ?? 'Kollektion').slice(0, 80), slug, description: String(it.description ?? '').slice(0, 1000), position: Number(it.position) || 0, created_at: now(), updated_at: now() });
          } else if (it.type === 'product') {
            const pid = c.maps.products?.get(String(it.product_id));
            if (!pid || !db.get('SELECT 1 AS x FROM products WHERE id = ? AND location_id = ?', pid, loc)) continue;
            const cols = (Array.isArray(it.collection_ids) ? it.collection_ids : []).map((x: string) => c.maps.storeCollections?.get(x)).filter(Boolean);
            const slug = slugify(String(it.slug ?? '')) || pid;
            db.run('DELETE FROM store_products WHERE product_id = ?', pid);
            db.insert('store_products', { product_id: pid, location_id: loc, published: it.published ? 1 : 0, slug: db.get('SELECT 1 AS x FROM store_products WHERE location_id = ? AND slug = ?', loc, slug) ? pid : slug, kind: ['physical', 'digital', 'gift_card'].includes(it.kind) ? it.kind : 'physical', images: Array.isArray(it.images) ? it.images.slice(0, 12) : [], weight_g: Math.max(0, Number(it.weight_g) || 0), collection_ids: cols, variant_prices: {}, position: Number(it.position) || 0, allow_backorder: it.allow_backorder ? 1 : 0, updated_at: now() });
            n++;
          }
        }
        c.created.store_products = n;
      },
    };
    app.services.snapshotParts = [...(app.services.snapshotParts ?? []), part];

    // --- DSGVO: orders are business records (amounts, invoice link) – the person's data in them goes, the carts go entirely ----------------
    app.services.privacyErase = [
      ...(app.services.privacyErase ?? []),
      (_a: App, loc: string, contact: { id: string; email?: string }) => {
        const email = String(contact.email ?? '').trim().toLowerCase();
        db.run(
          `UPDATE store_orders SET contact_id = NULL, email = '', name = '', phone = '', address = json_object('country', json_extract(address, '$.country')), note = '', meta = json_remove(meta, '$.gift_recipient', '$.vat_id'), updated_at = ? WHERE location_id = ? AND (contact_id = ? OR (? != '' AND lower(email) = ?))`,
          now(), loc, contact.id, email, email,
        );
        db.run(`DELETE FROM store_carts WHERE location_id = ? AND (contact_id = ? OR (? != '' AND lower(email) = ?))`, loc, contact.id, email, email);
      },
    ];
    app.services.privacyExport = [
      ...(app.services.privacyExport ?? []),
      (_a: App, loc: string, contact: { id: string; email?: string }) => {
        const email = String(contact.email ?? '').trim().toLowerCase();
        if (!email) return {};
        const rows = db.all('SELECT number, email, name, phone, address, items, total_cents, currency, status, fulfilment, tracking_number, created_at FROM store_orders WHERE location_id = ? AND lower(email) = ? AND (contact_id IS NULL OR contact_id != ?)', loc, email, contact.id);
        return rows.length ? { 'store_orders (E-Mail)': rows } : {};
      },
    ];
  },
};

/** One registry line in modules/index.ts: payment providers, gift cards, the store (admin, public pages, MCP tools). */
export const storeModules: Module[] = [payRegistryModule, giftCardsModule, storeModule, storePublicModule, storeToolsModule];
