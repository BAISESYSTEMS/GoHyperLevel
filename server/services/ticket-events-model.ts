import { bad } from '../core/http.js';

/**
 * Ticket types of an event (docs/booking.md#ticket-types): pure rules – cleaning the admin's input, whether a type is on sale right
 * now, how many a buyer may take, and the order's lines. The module (modules/ticket-events.ts) does the reserving inside one
 * transaction; everything here is side-effect free so tests can check it without a server.
 */

export const MAX_TYPES = 20;
/** Tickets in one order, whatever a type allows (each ticket is its own QR code, page and check-in). */
export const MAX_PER_ORDER = 20;
export const CURRENCIES = ['EUR', 'CHF', 'USD', 'GBP'] as const;
/** How long a paid order holds its tickets while the buyer pays. */
export const HOLD_MINUTES = 30;

export interface TicketEventRow {
  id: string;
  location_id: string;
  name: string;
  slug: string;
  description: string;
  venue: string;
  starts_at: string;
  ends_at: string | null;
  currency: string;
  tax_rate: number | null;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface TicketTypeRow {
  id: string;
  event_id: string;
  location_id: string;
  name: string;
  description: string;
  /** Gross per ticket (incl. VAT); 0 = free. */
  price_cents: number;
  /** null = no limit. */
  quota: number | null;
  sale_start: string | null;
  sale_end: string | null;
  max_per_order: number | null;
  position: number;
  active: number;
}

const isoOrNull = (v: unknown, field: string): string | null => {
  if (v === undefined || v === null || v === '') return null;
  const t = Date.parse(String(v));
  if (!Number.isFinite(t)) throw bad(`${field}: kein gültiger Zeitpunkt`);
  return new Date(t).toISOString();
};
const intOrNull = (v: unknown, field: string, min: number, max: number): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${field}: ganze Zahl von ${min} bis ${max}`);
  return n;
};
const text = (v: unknown, field: string, max: number, required = false): string => {
  const s = v === undefined || v === null ? '' : String(v).trim();
  if (required && !s) throw bad(`${field} fehlt`);
  if (s.length > max) throw bad(`${field} ist zu lang`);
  return s;
};

/** The event's own fields from a request body (`partial` for PATCH: only what is sent). */
export function cleanEvent(b: Record<string, any>, partial = false): Partial<TicketEventRow> {
  const out: Partial<TicketEventRow> = {};
  const has = (k: string) => !partial || b[k] !== undefined;
  if (has('name')) out.name = text(b.name, 'Name', 200, true);
  if (has('description')) out.description = text(b.description, 'Beschreibung', 4000);
  if (has('venue')) out.venue = text(b.venue, 'Ort', 300);
  if (has('starts_at')) {
    const s = isoOrNull(b.starts_at, 'Beginn');
    if (!s) throw bad('Beginn fehlt');
    out.starts_at = s;
  }
  if (has('ends_at')) out.ends_at = isoOrNull(b.ends_at, 'Ende');
  if (has('currency')) {
    const c = String(b.currency ?? 'EUR').toUpperCase();
    if (!(CURRENCIES as readonly string[]).includes(c)) throw bad(`Währung: ${CURRENCIES.join(', ')}`);
    out.currency = c;
  }
  if (has('tax_rate')) out.tax_rate = b.tax_rate === undefined || b.tax_rate === null || b.tax_rate === '' ? null : num(b.tax_rate, 'Steuersatz', 0, 30);
  if (b.active !== undefined) out.active = b.active ? 1 : 0;
  if (out.starts_at && out.ends_at && Date.parse(out.ends_at) < Date.parse(out.starts_at)) throw bad('Das Ende liegt vor dem Beginn');
  return out;
}

function num(v: unknown, field: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`${field}: ${min} bis ${max}`);
  return n;
}

export interface TypeInput {
  id?: string;
  name: string;
  description: string;
  price_cents: number;
  quota: number | null;
  sale_start: string | null;
  sale_end: string | null;
  max_per_order: number | null;
  active: number;
}

/** One ticket type from the admin (or an agent). Prices are gross cents; the providers' minimum applies to paid types. */
export function cleanType(b: Record<string, any>, minPaidCents = 50): TypeInput {
  const price = b.price_cents === undefined || b.price_cents === '' || b.price_cents === null ? 0 : Number(b.price_cents);
  if (!Number.isInteger(price) || price < 0 || price > 10_000_000) throw bad('Preis: ganze Cent von 0 bis 100.000 €');
  if (price > 0 && price < minPaidCents) throw bad(`Preis: 0 (kostenlos) oder mindestens ${(minPaidCents / 100).toFixed(2).replace('.', ',')} €`);
  const out: TypeInput = {
    id: b.id ? String(b.id) : undefined,
    name: text(b.name, 'Name der Ticketart', 120, true),
    description: text(b.description, 'Beschreibung der Ticketart', 500),
    price_cents: price,
    quota: intOrNull(b.quota, 'Kontingent', 0, 100_000),
    sale_start: isoOrNull(b.sale_start, 'Verkaufsstart'),
    sale_end: isoOrNull(b.sale_end, 'Verkaufsende'),
    max_per_order: intOrNull(b.max_per_order, 'Höchstens je Bestellung', 1, MAX_PER_ORDER),
    active: b.active === undefined ? 1 : b.active ? 1 : 0,
  };
  if (out.sale_start && out.sale_end && Date.parse(out.sale_end) <= Date.parse(out.sale_start)) throw bad(`„${out.name}“: Verkaufsende liegt vor dem Verkaufsstart`);
  return out;
}

export function cleanTypes(list: unknown, minPaidCents = 50): TypeInput[] {
  if (!Array.isArray(list)) throw bad('Ticketarten: Liste erwartet');
  if (list.length > MAX_TYPES) throw bad(`Höchstens ${MAX_TYPES} Ticketarten je Event`);
  return list.map((x) => cleanType(x && typeof x === 'object' ? x : {}, minPaidCents));
}

export type SaleState = 'on_sale' | 'not_yet' | 'ended' | 'sold_out' | 'inactive';

/** Whether a type can be bought at `at`, and how many are left (`left` null = no limit). */
export function saleState(t: Pick<TicketTypeRow, 'active' | 'quota' | 'sale_start' | 'sale_end'>, taken: number, at: Date, eventStart?: string): { state: SaleState; left: number | null } {
  const left = t.quota === null ? null : Math.max(0, t.quota - taken);
  if (!t.active) return { state: 'inactive', left };
  const ms = at.getTime();
  if (t.sale_start && ms < Date.parse(t.sale_start)) return { state: 'not_yet', left };
  // Without its own end, sale stops when the event begins.
  const end = t.sale_end ?? eventStart ?? null;
  if (end && ms >= Date.parse(end)) return { state: 'ended', left };
  if (left === 0) return { state: 'sold_out', left };
  return { state: 'on_sale', left };
}

/** The most a buyer may pick of this type right now. */
export function maxPick(t: Pick<TicketTypeRow, 'max_per_order'>, left: number | null): number {
  return Math.max(0, Math.min(t.max_per_order ?? 10, MAX_PER_ORDER, left ?? MAX_PER_ORDER));
}

export const SALE_LABEL: Record<SaleState, string> = { on_sale: 'Im Verkauf', not_yet: 'Verkauf noch nicht gestartet', ended: 'Verkauf beendet', sold_out: 'Ausverkauft', inactive: 'Nicht im Verkauf' };

/** `{type_id: qty}` or `[{type_id, qty}]` from a request (a form sends `qty_<type id>` fields) → clean pairs, at least one ticket. */
export function cleanPicks(b: Record<string, any>): { type_id: string; qty: number }[] {
  const raw: { type_id: string; qty: unknown }[] = [];
  if (Array.isArray(b.items)) for (const it of b.items) raw.push({ type_id: String(it?.type_id ?? ''), qty: it?.qty });
  for (const [k, v] of Object.entries(b)) if (k.startsWith('qty_')) raw.push({ type_id: k.slice(4), qty: v });
  const by = new Map<string, number>();
  for (const r of raw) {
    if (!r.type_id) continue;
    const q = r.qty === '' || r.qty === undefined ? 0 : Number(r.qty);
    if (!Number.isInteger(q) || q < 0 || q > MAX_PER_ORDER) throw bad('Anzahl: ganze Zahl');
    if (q) by.set(r.type_id, (by.get(r.type_id) ?? 0) + q);
  }
  const out = [...by].map(([type_id, qty]) => ({ type_id, qty }));
  const total = out.reduce((n, x) => n + x.qty, 0);
  if (!total) throw bad('Bitte mindestens ein Ticket wählen');
  if (total > MAX_PER_ORDER) throw bad(`Höchstens ${MAX_PER_ORDER} Tickets je Bestellung`);
  return out;
}

/** The 10-character code printed under the QR code (like the appointment tickets). */
export const ticketCode = (token: string) => token.slice(0, 10).toUpperCase();
