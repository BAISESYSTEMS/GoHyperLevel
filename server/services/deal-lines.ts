import type { App } from '../core/app.js';
import { id, now } from '../core/util.js';
import { logActivity } from './contacts.js';
import { dealAmount, lineAmounts, salesTotals, type SalesLine } from './sales-lines.js';

/**
 * The positions of a deal (products from the catalogue, quantity, discount, tax). The deal's amount is the net sum of its positions:
 * whenever the positions change the amount of the deal is written in one go, so the pipeline, the forecast, the reports and the
 * quotas all keep reading the one number (`opportunities.value`, whole currency units).
 */

export interface DealLineRow extends SalesLine {
  position: number;
}

export function dealLines(app: App, loc: string, dealId: string): DealLineRow[] {
  return app.db.all<DealLineRow>(
    `SELECT id, position, product_id, name, description, qty, unit, price_cents, discount_type, discount_value, tax_rate FROM deal_lines WHERE deal_id = ? AND location_id = ? ORDER BY position, rowid`,
    dealId,
    loc,
  );
}

export const hasDealLines = (app: App, loc: string, dealId: string): boolean => !!app.db.get('SELECT 1 AS x FROM deal_lines WHERE deal_id = ? AND location_id = ? LIMIT 1', dealId, loc);

/** The lines with their amounts and the totals – what the deal drawer shows. */
export function dealLineSummary(app: App, loc: string, deal: { id: string; value: number; currency: string }) {
  const lines = dealLines(app, loc, deal.id);
  const t = salesTotals(lines);
  return {
    deal_id: deal.id,
    currency: deal.currency,
    amount: deal.value,
    locked: lines.length > 0,
    lines: lines.map((l) => ({ ...l, ...lineAmounts(l) })),
    totals: { list_cents: t.list_cents, discount_cents: t.discount_cents, net_cents: t.subtotal_cents, tax_cents: t.tax_cents, total_cents: t.total_cents, groups: t.groups },
  };
}

/**
 * Replaces the positions and writes the deal's amount (the net sum, whole units). An empty list takes the positions away; the
 * amount then stays where it was, and the deal is free to be edited by hand again.
 */
export function setDealLines(app: App, loc: string, deal: { id: string; contact_id: string; name: string }, lines: SalesLine[]): { amount: number | null } {
  const { db } = app;
  let amount: number | null = null;
  db.tx(() => {
    db.run('DELETE FROM deal_lines WHERE deal_id = ? AND location_id = ?', deal.id, loc);
    lines.forEach((l, i) =>
      db.insert('deal_lines', { id: l.id, location_id: loc, deal_id: deal.id, position: i, product_id: l.product_id, name: l.name, description: l.description, qty: l.qty, unit: l.unit, price_cents: l.price_cents, discount_type: l.discount_type, discount_value: l.discount_value, tax_rate: l.tax_rate }),
    );
    if (lines.length) {
      amount = dealAmount(salesTotals(lines).subtotal_cents);
      db.run('UPDATE opportunities SET value = ?, updated_at = ? WHERE id = ? AND location_id = ?', amount, now(), deal.id, loc);
    }
  });
  logActivity(app, loc, deal.contact_id, 'opportunity.lines', lines.length ? `„${deal.name}“: ${lines.length} Position${lines.length === 1 ? '' : 'en'}, Wert ${amount} (netto)` : `„${deal.name}“: Positionen entfernt`);
  return { amount };
}

export const mintLineId = () => id(8);
