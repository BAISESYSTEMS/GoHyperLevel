import { createHmac, timingSafeEqual } from 'node:crypto';
import { centsToMoney } from '../core/util.js';
import { openCents } from './invoice-model.js';

/**
 * Minimal Stripe client on fetch (no SDK): form-encoded requests, webhook signatures and the
 * mapping of our invoice lines to Checkout line items.
 */

export class StripeError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = '',
  ) {
    super(message);
  }
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;
let stripeFetch: FetchLike = (url, init) => fetch(url, init);
/** Tests replace the network with a fake Stripe. */
export function setStripeFetch(fn?: FetchLike) {
  stripeFetch = fn ?? ((url, init) => fetch(url, init));
}

/** Stripe's bracket notation: {a: {b: 1}, c: [{d: 2}]} → a[b]=1&c[0][d]=2. */
export function formEncode(params: Record<string, any>): URLSearchParams {
  const out = new URLSearchParams();
  const walk = (v: any, key: string) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${key}[${i}]`));
    else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, key ? `${key}[${k}]` : k);
    else out.append(key, typeof v === 'boolean' ? String(v) : String(v));
  };
  walk(params, '');
  return out;
}

export async function stripeRequest<T = any>(secretKey: string, method: 'GET' | 'POST' | 'DELETE', path: string, params?: Record<string, any>, opts: { idempotencyKey?: string } = {}): Promise<T> {
  const query = method === 'GET' && params ? `?${formEncode(params)}` : '';
  const headers: Record<string, string> = { authorization: `Bearer ${secretKey}` };
  let body: string | undefined;
  if (method === 'POST') {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = formEncode(params ?? {}).toString();
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
  }
  let r: Response;
  try {
    r = await stripeFetch(`https://api.stripe.com${path}${query}`, { method, headers, body, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new StripeError(0, `Stripe nicht erreichbar: ${(e as Error).message}`);
  }
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j?.error?.message || `Stripe-Fehler ${r.status}`;
    throw new StripeError(r.status, r.status === 401 ? 'Stripe lehnt den Schlüssel ab (401) – bitte den Secret Key prüfen' : msg, j?.error?.code ?? '');
  }
  return j as T;
}

export const isSecretKey = (k: string) => /^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/.test(k);
export const isWebhookSecret = (k: string) => /^whsec_[A-Za-z0-9+/=_-]{10,}$/.test(k);
export const isLiveKey = (k: string) => /^(sk|rk)_live_/.test(k);
/** What the browser may see of a key: prefix and last four characters. */
export const keyHint = (k: string) => (k ? `${k.slice(0, k.indexOf('_', 3) + 1)}…${k.slice(-4)}` : '');

// --- webhook signatures --------------------------------------------------------

export function signStripePayload(rawBody: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex')}`;
}

export type SignatureCheck = { ok: true; t: number } | { ok: false; reason: string };

/**
 * Checks a Stripe-Signature header (`t=…,v1=…[,v1=…]`): HMAC-SHA256 over `${t}.${rawBody}` with the
 * endpoint's signing secret, constant-time compare, timestamp at most `toleranceSec` away.
 */
export function verifyStripeSignature(rawBody: string, header: string | undefined, secret: string, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)): SignatureCheck {
  if (!header) return { ok: false, reason: 'Stripe-Signature fehlt' };
  if (!secret) return { ok: false, reason: 'Kein Signing-Secret hinterlegt' };
  let t = NaN;
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') t = Number(v);
    else if (k === 'v1') sigs.push(v);
  }
  if (!Number.isInteger(t) || t <= 0) return { ok: false, reason: 'Zeitstempel fehlt' };
  if (!sigs.length) return { ok: false, reason: 'Keine v1-Signatur' };
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest();
  const match = sigs.some((s) => {
    if (!/^[0-9a-f]{64}$/i.test(s)) return false;
    const got = Buffer.from(s, 'hex');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  if (!match) return { ok: false, reason: 'Signatur stimmt nicht' };
  if (Math.abs(nowSec - t) > toleranceSec) return { ok: false, reason: 'Zeitstempel zu alt' };
  return { ok: true, t };
}

// --- Checkout ------------------------------------------------------------------

export interface InvoiceLike {
  number: string;
  title?: string;
  kind?: string;
  currency: string;
  total_cents: number;
  /** What already settles part of the invoice (the invoice row's columns): payments, credit notes, deducted partial invoices. */
  paid_cents?: number | null;
  credited_cents?: number | null;
  deducted_cents?: number | null;
  items: { name: string; description?: string; qty: number; price_cents: number; tax_rate: number }[];
}

export interface CheckoutLine {
  name: string;
  description?: string;
  unit_amount: number;
  quantity: number;
}

const fmtQty = (q: number) => String(Math.round(q * 1000) / 1000).replace('.', ',');

/** "inkl. 19 % USt." for the rates of the invoice's lines ("inkl. 19 % / 7 % USt." when mixed; nothing without tax). */
function vatText(items: InvoiceLike['items']): string {
  const rates = [...new Set((items ?? []).map((it) => Number(it.tax_rate) || 0).filter((r) => r > 0))].sort((a, b) => b - a);
  return rates.length ? `inkl. ${rates.map((r) => `${String(r).replace('.', ',')} %`).join(' / ')} USt.` : '';
}

/**
 * Invoice lines as Checkout line items, gross (incl. tax), so Stripe charges exactly what the invoice still asks for: its open
 * amount (services/invoice-model.ts openCents – the figure the invoice page, the GiroCode, dunning and SEPA use). An untouched
 * invoice keeps its lines: fractional quantities become one line with the line total; discounts (negative lines) or any
 * rounding gap fall back to a single line for the whole invoice. Once something settled part of it – a payment, a credit note
 * (Gutschrift), the partial invoices a final invoice deducts – it is one line "Restbetrag Rechnung …" that names what was
 * taken off. Nothing open: no lines.
 */
export function invoiceLineItems(inv: InvoiceLike): CheckoutLine[] {
  const open = openCents(inv);
  if (open <= 0) return [];
  if (open < inv.total_cents) {
    const money = (c: number) => centsToMoney(c, inv.currency.toUpperCase());
    const less = [
      inv.deducted_cents ? `Abschlagsrechnungen ${money(inv.deducted_cents)}` : '',
      inv.paid_cents ? `bereits bezahlt ${money(inv.paid_cents)}` : '',
      inv.credited_cents ? `Gutschriften ${money(inv.credited_cents)}` : '',
    ].filter(Boolean);
    const description = [`Rechnungsbetrag ${money(inv.total_cents)}${less.length ? ` abzgl. ${less.join(', ')}` : ''}`, vatText(inv.items)].filter(Boolean).join(' · ').slice(0, 500);
    return [{ name: `Restbetrag Rechnung ${inv.number}`.slice(0, 250), description, unit_amount: open, quantity: 1 }];
  }
  const lines: CheckoutLine[] = [];
  let sum = 0;
  let simple = true;
  for (const it of inv.items ?? []) {
    const net = Math.round(it.qty * it.price_cents);
    const gross = net + Math.round((net * (it.tax_rate || 0)) / 100);
    sum += gross;
    if (gross < 0) simple = false;
    if (gross === 0) continue;
    const tax = it.tax_rate ? `inkl. ${String(it.tax_rate).replace('.', ',')} % USt.` : '';
    const description = [it.description, tax].filter(Boolean).join(' · ').slice(0, 500) || undefined;
    if (Number.isInteger(it.qty) && it.qty > 0 && gross % it.qty === 0) lines.push({ name: it.name.slice(0, 250), description, unit_amount: gross / it.qty, quantity: it.qty });
    else lines.push({ name: `${fmtQty(it.qty)} × ${it.name}`.slice(0, 250), description, unit_amount: gross, quantity: 1 });
  }
  if (!simple || sum !== inv.total_cents || !lines.length || lines.length > 100) {
    return [{ name: `Rechnung ${inv.number}`, description: inv.title || undefined, unit_amount: inv.total_cents, quantity: 1 }];
  }
  return lines;
}

/** Stripe's smallest charge is about 0.50 in most currencies. */
export const MIN_AMOUNT_CENTS = 50;

export function lineItemParams(lines: CheckoutLine[], currency: string, recurring?: 'month' | 'year') {
  return lines.map((l) => ({
    quantity: l.quantity,
    price_data: {
      currency: currency.toLowerCase(),
      unit_amount: l.unit_amount,
      product_data: { name: l.name, ...(l.description ? { description: l.description } : {}) },
      ...(recurring ? { recurring: { interval: recurring } } : {}),
    },
  }));
}

/** The dashboard page of a payment (test or live). */
export function dashboardUrl(ref: string, live: boolean): string {
  const base = `https://dashboard.stripe.com${live ? '' : '/test'}`;
  if (ref.startsWith('pi_')) return `${base}/payments/${ref}`;
  if (ref.startsWith('sub_')) return `${base}/subscriptions/${ref}`;
  if (ref.startsWith('cs_')) return `${base}/checkout/sessions/${ref}`;
  return base;
}
