import { amount, d } from '../api';

/** Small pure helpers shared by the deal board, the deal list and the Opportunities page. */

/** German labels (message ids of the deals catalog). */
export const LOST_TEXT: Record<string, string> = { won: 'gewonnen', lost: 'verloren', abandoned: 'aufgegeben' };
export const today = () => new Date().toISOString().slice(0, 10);

/** Sum of deal values per currency ("1.200 € + 500 $"): amounts in different currencies are never added up. */
export const sums = (items: { currency?: string; value?: number }[]) => {
  const m = new Map<string, number>();
  for (const o of items) m.set(o.currency || 'EUR', (m.get(o.currency || 'EUR') ?? 0) + (o.value || 0));
  return m.size ? [...m].map(([c, v]) => amount(v, c)).join(' + ') : amount(0);
};

/** Expected close date of an open deal as a short label; `late` when it has passed. */
export const closeInfo = (o: { expected_close_date?: string | null; status?: string }) =>
  o.expected_close_date ? { label: d(`${o.expected_close_date}T12:00:00`), late: o.status === 'open' && o.expected_close_date < today() } : null;
