import type { Module } from '../core/app.js';
import { bad, notFound } from '../core/http.js';
import { dealLineSummary, dealLines, hasDealLines, mintLineId, setDealLines } from '../services/deal-lines.js';
import { getOpportunity } from '../services/opportunities.js';
import { LineError, cleanLines, type ProductRef } from '../services/sales-lines.js';
import { invoiceSettings } from './payments.js';
import type { Tool } from './mcp.js';

/**
 * Positionen am Deal (docs/sales.md): Produkte aus dem Katalog, Menge, Rabatt, Steuer – der Dealwert ist die Nettosumme. Der Wert
 * eines Deals mit Positionen wird nur noch über die Positionen geändert; die Angebote (modules/quotes.ts) bauen auf denselben
 * Positionen auf.
 */

const TOOLS: Tool[] = [
  {
    name: 'ghl_deal_lines',
    title: 'Positionen eines Deals',
    description: 'Die Positionen eines Deals (Produkt, Menge, Preis, Rabatt, Steuer) mit Summen. Nur lesen.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, deal_id: { type: 'string' } }, required: ['deal_id'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => call.api('GET', `/api/opportunities/${encodeURIComponent(a.deal_id)}/lines`, { location: a.location_id }),
  },
  {
    name: 'ghl_deal_set_lines',
    title: 'Positionen eines Deals setzen',
    description:
      'Ersetzt alle Positionen eines Deals; der Dealwert wird die Nettosumme (nach Rabatt). Jede Position: product_id (Katalog; Name, Preis, Steuer kommen sonst von dort) oder name + price_cents, qty, discount_type (percent|amount|none) + discount_value (Prozent bzw. Cent), tax_rate. Leere Liste entfernt die Positionen.',
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'string' },
        deal_id: { type: 'string' },
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              product_id: { type: 'string' },
              name: { type: 'string' },
              description: { type: 'string' },
              qty: { type: 'number' },
              price_cents: { type: 'number' },
              discount_type: { type: 'string', enum: ['none', 'percent', 'amount'] },
              discount_value: { type: 'number' },
              tax_rate: { type: 'number' },
            },
          },
        },
      },
      required: ['deal_id', 'lines'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (call, a) => call.api('PUT', `/api/opportunities/${encodeURIComponent(a.deal_id)}/lines`, { location: a.location_id, body: { lines: a.lines } }),
  },
];

export const dealLinesModule: Module = {
  name: 'deal-lines',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE deal_lines (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        deal_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE, position INTEGER NOT NULL DEFAULT 0,
        product_id TEXT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', qty REAL NOT NULL DEFAULT 1, unit TEXT NOT NULL DEFAULT '',
        price_cents INTEGER NOT NULL DEFAULT 0, discount_type TEXT NOT NULL DEFAULT 'none', discount_value REAL NOT NULL DEFAULT 0, tax_rate REAL NOT NULL DEFAULT 19
      );
      CREATE INDEX deal_lines_deal ON deal_lines(deal_id, position);
      CREATE INDEX deal_lines_loc ON deal_lines(location_id, product_id);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    // pipelines.ts and the opportunity service ask: may the amount of this deal be set by hand?
    app.services.dealValueLocked = (loc: string, dealId: string) => hasDealLines(app, loc, dealId);
    app.services.dealLines = { get: (loc: string, dealId: string) => dealLines(app, loc, dealId) };

    const product = (loc: string) => (pid: string): ProductRef | undefined => db.get<ProductRef>('SELECT id, name, description, price_cents, tax_rate FROM products WHERE id = ? AND location_id = ?', pid, loc);

    const must = (loc: string, dealId: string) => {
      const deal = getOpportunity(app, loc, dealId);
      if (!deal) throw notFound('Deal nicht gefunden');
      return deal as { id: string; contact_id: string; name: string; value: number; currency: string };
    };

    router.get('/api/opportunities/:id/lines', 'location', (ctx) => dealLineSummary(app, ctx.locationId, must(ctx.locationId, ctx.params.id)));

    router.put('/api/opportunities/:id/lines', 'location', (ctx) => {
      const deal = must(ctx.locationId, ctx.params.id);
      let lines;
      try {
        lines = cleanLines(ctx.body?.lines, { defaultTax: invoiceSettings(app, ctx.locationId).tax_rate, mint: mintLineId, product: product(ctx.locationId) });
      } catch (e) {
        if (e instanceof LineError) throw bad(e.message);
        throw e;
      }
      setDealLines(app, ctx.locationId, deal, lines);
      return dealLineSummary(app, ctx.locationId, must(ctx.locationId, ctx.params.id));
    });
  },
};
