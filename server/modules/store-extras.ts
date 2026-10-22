import type { App, Module } from '../core/app.js';
import { bad, notFound, num } from '../core/http.js';
import { formatInTz } from '../core/time.js';
import { A4, Page, latin, pdfOf } from '../services/creator-pdf.js';
import { catalog, settingsOf, storeKey } from '../services/store-catalog.js';
import type { Tool } from './mcp.js';

/**
 * Online-Shop fulfilment and recovery (HighLevel parity, docs/store.md#packing-slips): packing slips as PDF – one order, or every paid
 * order that still has to go out in one file to print – and the list of abandoned carts (carts with an e-mail address and no paid
 * order) with their value and the recovery link, plus an MCP tool for the agent. Reads only; the store module keeps the orders.
 */

const COUNTRY: Record<string, string> = { DE: 'Deutschland', AT: 'Österreich', CH: 'Schweiz', NL: 'Niederlande', BE: 'Belgien', FR: 'Frankreich', IT: 'Italien', ES: 'Spanien', LU: 'Luxemburg', PL: 'Polen', DK: 'Dänemark' };
const parse = (v: unknown, fb: any) => {
  try {
    return typeof v === 'string' ? JSON.parse(v) : (v ?? fb);
  } catch {
    return fb;
  }
};

/** One page per order: sender, ship-to address, order number and date, shipping method, the lines (no prices), the buyer's note. */
export function packingSlipPdf(app: App, locationId: string, orders: any[]): Buffer {
  const loc = app.location(locationId)!;
  const pages: Page[] = [];
  const L = 60;
  const W = A4.w - 120;
  for (const o of orders) {
    let page = new Page();
    pages.push(page);
    page.rect(0, 0, A4.w, 8, { fill: '#1e3a8a' });
    let y = 48;
    page.text(L, y, latin(loc.name), 11, { bold: true });
    if (loc.address) page.para(L, y + 16, latin(loc.address), W / 2, 9, { color: '#64748b' });
    page.text(A4.w - 60, y, latin('Packzettel'), 20, { bold: true, color: '#1e3a8a', anchor: 'end' });
    page.text(A4.w - 60, y + 28, latin(`Bestellung ${o.number}`), 11, { anchor: 'end' });
    page.text(A4.w - 60, y + 44, latin(formatInTz(o.created_at, loc.timezone, { weekday: undefined, hour: undefined, minute: undefined })), 10, { color: '#64748b', anchor: 'end' });
    y = 140;
    const a = parse(o.address, {});
    const shipTo = [a.name || o.name, a.company, a.street, [a.postal_code, a.city].filter(Boolean).join(' '), a.country && a.country !== 'DE' ? COUNTRY[a.country] || a.country : ''].filter(Boolean).join('\n');
    page.text(L, y, latin('Lieferadresse'), 9, { bold: true, color: '#475569' });
    y += 16;
    y += page.para(L, y, latin(shipTo || o.name || o.email || '–'), W / 2, 11) + 6;
    const ship = parse(o.shipping, {});
    if (ship?.name) {
      page.text(L, y, latin(`Versandart: ${ship.name}`), 10, { color: '#475569' });
      y += 16;
    }
    if (o.phone) {
      page.text(L, y, latin(`Telefon: ${o.phone}`), 10, { color: '#475569' });
      y += 16;
    }
    y += 14;
    page.rect(L, y, W, 22, { fill: '#f1f5f9' });
    page.text(L + 8, y + 5, latin('Menge'), 9.5, { bold: true });
    page.text(L + 70, y + 5, latin('Artikel'), 9.5, { bold: true });
    page.text(L + W - 8, y + 5, latin('Artikelnummer'), 9.5, { bold: true, anchor: 'end' });
    y += 30;
    let count = 0;
    for (const it of parse(o.items, []) as any[]) {
      if (y > A4.h - 120) {
        page = new Page();
        pages.push(page);
        y = 60;
      }
      const name = `${it.name}${it.variant ? ` (${it.variant})` : ''}`;
      page.text(L + 8, y, latin(`${it.qty} ×`), 10.5, { bold: true });
      const h = page.para(L + 70, y, latin(name), W - 200, 10.5);
      if (it.sku) page.text(L + W - 8, y, latin(it.sku), 10, { anchor: 'end', font: 'mono' });
      page.rect(L + W - 130, y + 2, 10, 10, { stroke: '#94a3b8' });
      y += Math.max(h, 16) + 6;
      page.line(L, y - 3, L + W, y - 3, { stroke: '#e2e8f0' });
      count += Number(it.qty) || 0;
    }
    y += 6;
    page.text(L, y, latin(`${count} Teile`), 10, { color: '#475569' });
    y += 24;
    if (o.note) {
      page.text(L, y, latin('Anmerkung des Käufers'), 9, { bold: true, color: '#475569' });
      y += 14;
      page.para(L, y, latin(o.note), W, 10);
    }
  }
  return pdfOf(pages, { title: orders.length === 1 ? `Packzettel ${orders[0].number}` : `Packzettel (${orders.length})` });
}

const pdf = (body: Buffer, filename: string) => ({ __raw: true as const, status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${filename}"`, 'cache-control': 'private, no-store' }, body });

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };

export const STORE_EXTRA_TOOLS: Tool[] = [
  {
    name: 'ghl_store_abandoned',
    title: 'Abgebrochene Warenkörbe',
    description: 'Warenkörbe des Online-Shops mit E-Mail-Adresse, aber ohne bezahlte Bestellung: E-Mail, Kontakt, Wert (netto, Cent), Artikel, wann zuletzt geändert, ob die Erinnerung (Auslöser checkout.abandoned) schon lief, und der Link, der den Warenkorb wiederherstellt.',
    inputSchema: { type: 'object', properties: { ...LOC, days: { type: 'integer', minimum: 1, maximum: 90, description: 'Zeitraum in Tagen, Standard 30' } }, required: ['location_id'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => call.api('GET', `/api/store/abandoned?days=${encodeURIComponent(a.days ?? 30)}`, { location: a.location_id }),
  },
];

export const storeExtrasModule: Module = {
  name: 'store-extras',
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...STORE_EXTRA_TOOLS];

    router.get('/api/store/orders/:id/packing-slip', 'location', (ctx) => {
      const o = db.get<any>('SELECT * FROM store_orders WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!o) throw notFound('Bestellung nicht gefunden');
      return pdf(packingSlipPdf(app, ctx.locationId, [o]), `packzettel-${String(o.number).replace(/[^\w-]/g, '')}.pdf`);
    });
    /** Several at once: `ids=a,b,c`, or `open=1` = every paid order that is not shipped yet (oldest first, at most 200). */
    router.get('/api/store/packing-slips', 'location', (ctx) => {
      const ids = String(ctx.query.get('ids') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 200);
      const orders = ids.length
        ? db.all<any>(`SELECT * FROM store_orders WHERE location_id = ? AND id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at`, ctx.locationId, ...ids)
        : ctx.query.get('open') === '1'
          ? db.all<any>(`SELECT * FROM store_orders WHERE location_id = ? AND status = 'paid' AND fulfilment IN ('unfulfilled', 'processing') ORDER BY created_at LIMIT 200`, ctx.locationId)
          : [];
      if (!ids.length && ctx.query.get('open') !== '1') throw bad('ids oder open=1 angeben');
      if (!orders.length) throw notFound('Keine Bestellungen zum Packen');
      return pdf(packingSlipPdf(app, ctx.locationId, orders), `packzettel-${orders.length}.pdf`);
    });

    router.get('/api/store/abandoned', 'location', (ctx) => {
      const days = Math.min(Math.max(Math.round(num(ctx.query.get('days'), 30)), 1), 90);
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      const settings = settingsOf(app, ctx.locationId);
      const products = catalog(app, ctx.locationId);
      const key = encodeURIComponent(storeKey(app, ctx.locationId));
      const rows = db.all<any>(
        `SELECT c.id, c.email, c.contact_id, c.items, c.country, c.status, c.reminded_at, c.created_at, c.updated_at, k.first_name, k.last_name
         FROM store_carts c LEFT JOIN contacts k ON k.id = c.contact_id
         WHERE c.location_id = ? AND c.email != '' AND c.items != '[]' AND c.updated_at >= ? AND c.order_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM store_orders o WHERE o.location_id = c.location_id AND o.status = 'paid' AND lower(o.email) = lower(c.email) AND o.created_at >= c.created_at)
         ORDER BY c.updated_at DESC LIMIT 500`,
        ctx.locationId,
        since,
      );
      const carts = rows.map((r) => {
        const items = (parse(r.items, []) as { product_id: string; qty: number }[]).map((it) => {
          const p = products.find((x) => x.id === it.product_id);
          return { product_id: it.product_id, name: p?.name ?? '–', qty: Number(it.qty) || 1, net_cents: (p?.net_cents ?? 0) * (Number(it.qty) || 1) };
        });
        return {
          id: r.id,
          email: r.email,
          contact_id: r.contact_id,
          contact_name: [r.first_name, r.last_name].filter(Boolean).join(' ') || null,
          items,
          value_cents: items.reduce((n, i) => n + i.net_cents, 0),
          reminded: !!r.reminded_at,
          updated_at: r.updated_at,
          recovery_url: `${app.baseUrl()}/store/${key}/checkout?cart=${encodeURIComponent(r.id)}`,
        };
      });
      return { days, currency: settings.currency, count: carts.length, value_cents: carts.reduce((n, c) => n + c.value_cents, 0), carts };
    });
  },
};
