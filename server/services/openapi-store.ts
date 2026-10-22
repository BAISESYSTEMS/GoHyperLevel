import type { RouteDoc } from './openapi.js';

/** OpenAPI entries of the online store, gift cards and payment providers (docs/store.md, docs/payment-providers.md) – spread into ROUTE_DOCS. */

const S = 'Online-Shop';
const G = 'Gutscheine';
const P = 'Zahlungsanbieter';
const str = (description?: string, extra: Record<string, unknown> = {}) => ({ type: 'string', ...(description ? { description } : {}), ...extra });
const int = (description?: string) => ({ type: 'integer', ...(description ? { description } : {}) });
const bool = (description?: string) => ({ type: 'boolean', ...(description ? { description } : {}) });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const arr = (items: unknown) => ({ type: 'array', items });
const q = (name: string, description: string) => ({ name, in: 'query' as const, description, schema: { type: 'string' } });
const rate = obj({ id: str(), name: str(), type: str(undefined, { enum: ['flat', 'weight'] }), price_cents: int('brutto'), tiers: arr(obj({ up_to_g: int(), price_cents: int() })), countries: arr(str('ISO-Code')), free_over_cents: int(), delivery: str() });

export const STORE_DOCS: RouteDoc[] = [
  { method: 'get', path: '/api/store/settings', tag: S, summary: 'Shop-Einstellungen mit Link zur Kasse, Zahlungsarten und Kennzahlen' },
  {
    method: 'put',
    path: '/api/store/settings',
    tag: S,
    summary: 'Shop an/aus, Name, Kurzname, Lieferländer, Versandarten (pauschal/nach Gewicht), Bestellnummer, Warenkorbabbruch, Gutschein-Gültigkeit',
    body: obj({ enabled: bool(), name: str(), slug: str(), countries: arr(str()), shipping: arr(rate), order_prefix: str(), terms_required: bool(), abandon_minutes: int(), gift_valid_months: int('0 = unbegrenzt'), notify_email: str(), checkout_note: str() }),
  },
  { method: 'get', path: '/api/store/products', tag: S, summary: 'Produkte mit Shop-Feldern, Varianten (Lagerartikel) und Bestand' },
  {
    method: 'put',
    path: '/api/store/products/{id}',
    tag: S,
    summary: 'Shop-Felder eines Produkts',
    body: obj({ published: bool(), slug: str(), kind: str(undefined, { enum: ['physical', 'digital', 'gift_card'] }), images: arr(str()), weight_g: int(), collection_ids: arr(str()), variant_prices: obj({}), position: int(), allow_backorder: bool() }),
  },
  { method: 'get', path: '/api/store/collections', tag: S, summary: 'Kollektionen' },
  { method: 'post', path: '/api/store/collections', tag: S, summary: 'Kollektion anlegen', body: obj({ name: str(), slug: str(), description: str(), position: int() }, ['name']) },
  { method: 'patch', path: '/api/store/collections/{id}', tag: S, summary: 'Kollektion ändern', body: obj({ name: str(), slug: str(), description: str(), position: int() }) },
  { method: 'delete', path: '/api/store/collections/{id}', tag: S, summary: 'Kollektion löschen (Produkte bleiben)' },
  { method: 'get', path: '/api/store/orders', tag: S, summary: 'Bestellungen', query: [q('status', 'pending | paid | cancelled | refunded'), q('fulfilment', 'open | unfulfilled | processing | shipped | delivered | cancelled'), q('q', 'Nummer, E-Mail, Name, Sendungsnummer'), q('limit', 'höchstens 500')] },
  { method: 'get', path: '/api/store/orders/{id}', tag: S, summary: 'Bestellung mit Zahlung, Rechnung und verkauften Gutscheinen' },
  { method: 'patch', path: '/api/store/orders/{id}', tag: S, summary: 'Versandstatus, Versanddienstleister, Sendungsnummer (versendet → E-Mail an den Käufer, Auslöser store.order_shipped)', body: obj({ fulfilment: str(undefined, { enum: ['processing', 'shipped', 'delivered', 'cancelled'] }), carrier: str(), tracking_number: str(), tracking_url: str(), note: str(), notify: bool() }) },
  { method: 'post', path: '/api/store/orders/{id}/refund', tag: S, summary: 'Erstatten über den Zahlungsanbieter (ohne Betrag: alles, Gutschein-Anteil zurück auf den Gutschein)', body: obj({ amount_cents: int() }) },
  { method: 'post', path: '/api/store/orders/{id}/resend', tag: S, summary: 'Bestellbestätigung mit Rechnung erneut senden' },
  { method: 'get', path: '/api/gift-cards', tag: G, summary: 'Gutscheine', query: [q('q', 'Code, Name, E-Mail'), q('status', 'active | used | disabled')] },
  { method: 'post', path: '/api/gift-cards', tag: G, summary: 'Gutschein ausstellen (optional per E-Mail)', body: obj({ amount_cents: int(), currency: str(), expires_at: str(), contact_id: str(), recipient_name: str(), recipient_email: str(), message: str(), note: str(), code: str('leer = zufällig'), send: bool() }, ['amount_cents']) },
  { method: 'get', path: '/api/gift-cards/{id}', tag: G, summary: 'Gutschein mit Journal und Reservierungen' },
  { method: 'patch', path: '/api/gift-cards/{id}', tag: G, summary: 'Sperren/entsperren, Ablaufdatum, Empfänger, Notiz', body: obj({ status: str(undefined, { enum: ['active', 'disabled'] }), expires_at: str(), recipient_name: str(), recipient_email: str(), note: str() }) },
  { method: 'post', path: '/api/gift-cards/{id}/adjust', tag: G, summary: 'Guthaben korrigieren (neue Journalzeile)', body: obj({ amount_cents: int('positiv = aufladen, negativ = abziehen'), note: str() }, ['amount_cents', 'note']) },
  { method: 'post', path: '/api/gift-cards/{id}/send', tag: G, summary: 'Code erneut per E-Mail schicken' },
  { method: 'post', path: '/api/gift-cards/check', tag: G, summary: 'Code nachschlagen (Guthaben, Gültigkeit)', body: obj({ code: str() }, ['code']) },
  { method: 'post', path: '/api/gift-cards/redeem', tag: G, summary: 'Von Hand einlösen – mit invoice_id als Zahlung „Gutschein“ auf der Rechnung', body: obj({ code: str(), amount_cents: int(), invoice_id: str(), note: str() }, ['code']) },
  { method: 'get', path: '/api/pay/providers', tag: P, summary: 'Zahlungsanbieter (Stripe, PayPal, Mollie): verbunden, Zahlungsarten, Webhook-Adresse – ohne Geheimnisse' },
  { method: 'put', path: '/api/pay/providers/{id}', tag: P, summary: 'PayPal oder Mollie verbinden (wird beim Anbieter geprüft, verschlüsselt gespeichert)', body: obj({ client_id: str('PayPal'), client_secret: str('PayPal'), webhook_id: str('PayPal'), mode: str('PayPal: sandbox | live'), pay_later: bool('PayPal'), api_key: str('Mollie'), methods: arr(str('Mollie')) }) },
  { method: 'delete', path: '/api/pay/providers/{id}', tag: P, summary: 'Zahlungsanbieter trennen' },
  { method: 'post', path: '/api/pay/providers/{id}/test', tag: P, summary: 'Zugangsdaten prüfen' },
  { method: 'get', path: '/api/pay/sessions', tag: P, summary: 'Zahlungen über die Registry', query: [q('purpose', 'invoice | product | store_order | teamcal_hold'), q('ref_id', 'ID des Bezugs'), q('status', 'open | pending | paid | failed | expired | cancelled | refunded'), q('provider', 'stripe | paypal | mollie | giftcard')] },
  { method: 'get', path: '/api/pay/sessions/{id}', tag: P, summary: 'Eine Zahlung' },
  { method: 'post', path: '/api/pay/sessions/{id}/refund', tag: P, summary: 'Über den Anbieter erstatten (ganz oder amount_cents)', body: obj({ amount_cents: int() }) },
];
