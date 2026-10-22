import type { App } from '../core/app.js';
import { PayError, accountOf, amountValue, centsOf, payJson, type Account, type PayLine, type PayProvider, type PaySession, type ProviderState } from './pay-registry.js';

/**
 * Mollie through the Payments API (docs/payment-providers.md#mollie): iDEAL, SEPA bank transfer, cards, Klarna, Bancontact … – Mollie's
 * hosted page shows what is switched on in the Mollie dashboard (or the methods chosen per sub-account). Mollie's webhook carries
 * only the payment id; the state is always read back from the API with the sub-account's key, so a forged call cannot pay anything.
 * Klarna payments are authorised first and captured right away (the order is complete when it is paid).
 */

const API = 'https://api.mollie.com/v2';
export const MOLLIE_METHODS: [string, string][] = [
  ['ideal', 'iDEAL'],
  ['creditcard', 'Kreditkarte'],
  ['banktransfer', 'SEPA-Überweisung'],
  ['klarna', 'Klarna'],
  ['bancontact', 'Bancontact'],
  ['eps', 'eps'],
  ['paypal', 'PayPal (über Mollie)'],
  ['applepay', 'Apple Pay'],
];
export const isMollieKey = (k: string) => /^(test|live)_[A-Za-z0-9]{20,}$/.test(k);

export function mollieApi(app: App, acc: Account, method: 'GET' | 'POST', path: string, body?: unknown, idem?: string): Promise<any> {
  return payJson(app, 'Mollie', `${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${acc.secrets.api_key}`, 'content-type': 'application/json', accept: 'application/json', ...(idem ? { 'idempotency-key': idem } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const accOf = (app: App, locationId: string): Account => {
  const a = accountOf(app, locationId, 'mollie');
  if (!a?.secrets.api_key) throw new PayError(409, 'Mollie ist für diesen Sub-Account nicht eingerichtet');
  return a;
};

/** Proves the key (the list of active methods) – for the settings page. */
export async function testMollie(app: App, acc: Account): Promise<{ ok: true; mode: string; methods: string[] }> {
  const j = await mollieApi(app, acc, 'GET', '/methods');
  return { ok: true, mode: acc.secrets.api_key.startsWith('live_') ? 'live' : 'test', methods: (j?._embedded?.methods ?? []).map((m: any) => String(m.id)) };
}

/**
 * Order lines for Klarna (Mollie wants them, with the VAT in each line). Only sent when they add up to the amount exactly – a gift
 * card or rounding that does not fit leaves them out (then Klarna is not offered for that payment, the other methods are).
 */
export function mollieLines(lines: PayLine[] | undefined, amountCents: number, currency: string) {
  if (!lines?.length) return undefined;
  const out = lines.map((l) => {
    const total = Math.round(l.unit_cents * l.qty);
    const rate = Number(l.tax_rate ?? 0);
    const vat = Math.round((total * rate) / (100 + rate));
    return {
      description: l.name.slice(0, 100),
      quantity: Math.max(1, Math.round(l.qty)),
      unitPrice: { currency, value: amountValue(l.unit_cents) },
      totalAmount: { currency, value: amountValue(total) },
      vatRate: rate.toFixed(2),
      vatAmount: { currency, value: amountValue(vat) },
      ...(l.sku ? { sku: l.sku.slice(0, 64) } : {}),
      _total: total,
      _int: Number.isInteger(l.qty),
    };
  });
  if (out.some((l) => !l._int) || out.reduce((n, l) => n + l._total, 0) !== amountCents) return undefined;
  return out.map(({ _total, _int, ...l }) => l);
}

/** A Mollie payment → the registry's state. */
export function paymentState(p: any): ProviderState {
  const base = { amount_cents: p?.amount?.value !== undefined ? centsOf(p.amount.value) : undefined, currency: p?.amount?.currency, capture_ref: String(p?.id ?? '') };
  switch (p?.status) {
    case 'paid':
      return { status: 'paid', ...base };
    case 'authorized':
    case 'pending':
      return { status: 'pending', ...base };
    case 'expired':
      return { status: 'expired', ...base };
    case 'failed':
      return { status: 'failed', ...base };
    case 'canceled':
      return { status: 'cancelled', ...base };
    default:
      return { status: 'open', ...base };
  }
}

export const mollieProvider: PayProvider = {
  id: 'mollie',
  label: 'Mollie',
  methods: (app, locationId) => {
    const chosen: string[] = accountOf(app, locationId, 'mollie')?.options.methods ?? [];
    const list = chosen.length ? MOLLIE_METHODS.filter(([k]) => chosen.includes(k)) : MOLLIE_METHODS.slice(0, 4);
    return list.map(([, label]) => label);
  },
  ready: (app, locationId) => !!accountOf(app, locationId, 'mollie')?.secrets.api_key,
  async create(app: App, s: PaySession) {
    const acc = accOf(app, s.location_id);
    const base = app.baseUrl();
    const chosen: string[] = Array.isArray(acc.options.methods) ? acc.options.methods.filter((m: string) => MOLLIE_METHODS.some(([k]) => k === m)) : [];
    const lines = mollieLines(s.meta.lines, s.amount_cents, s.currency);
    const a = s.meta.address;
    const [given, ...family] = String(a?.name || s.meta.name || '').trim().split(/\s+/);
    const billing =
      lines && a?.street && a.postal_code && a.city && a.country && given && family.length
        ? { givenName: given, familyName: family.join(' '), email: s.meta.email || undefined, streetAndNumber: a.street, postalCode: a.postal_code, city: a.city, country: a.country }
        : undefined;
    const p = await mollieApi(
      app,
      acc,
      'POST',
      '/payments',
      {
        amount: { currency: s.currency, value: amountValue(s.amount_cents) },
        description: s.description.slice(0, 255) || 'Zahlung',
        redirectUrl: `${base}/pay/${s.id}/return`,
        cancelUrl: `${base}/pay/${s.id}/cancel`,
        webhookUrl: `${base}/hooks/mollie/${s.location_id}`,
        metadata: { pay_session: s.id },
        locale: 'de_DE',
        ...(chosen.length ? { method: chosen } : {}),
        ...(lines ? { lines } : {}),
        ...(billing ? { billingAddress: billing, shippingAddress: billing } : {}),
      },
      `pay-${s.id}-${s.amount_cents}`,
    );
    return { provider_ref: String(p?.id ?? ''), url: String(p?._links?.checkout?.href ?? '') };
  },
  async fetch(app: App, s: PaySession) {
    const acc = accOf(app, s.location_id);
    const p = await mollieApi(app, acc, 'GET', `/payments/${encodeURIComponent(s.provider_ref)}`);
    if (p?.metadata?.pay_session && p.metadata.pay_session !== s.id) throw new PayError(409, 'Die Mollie-Zahlung gehört zu einer anderen Zahlung');
    // Klarna: authorised – take the money now (the order or invoice is complete once it is paid).
    if (p?.status === 'authorized') {
      await mollieApi(app, acc, 'POST', `/payments/${encodeURIComponent(s.provider_ref)}/captures`, {}, `cap-${s.provider_ref}`).catch((e) => console.error('[mollie] capture', (e as Error).message));
    }
    return paymentState(p);
  },
  async refund(app: App, s: PaySession, amountCents: number) {
    const acc = accOf(app, s.location_id);
    const r = await mollieApi(app, acc, 'POST', `/payments/${encodeURIComponent(s.capture_ref || s.provider_ref)}/refunds`, { amount: { currency: s.currency, value: amountValue(amountCents) } }, `ref-${s.id}-${s.refunded_cents}-${amountCents}`);
    return { id: String(r?.id ?? '') };
  },
};
