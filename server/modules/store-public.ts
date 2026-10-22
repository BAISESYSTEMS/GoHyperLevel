import { randomBytes } from 'node:crypto';
import type { App, Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, html, notFound, str } from '../core/http.js';
import { jsonForScript, publicPage } from '../core/page.js';
import { escapeHtml } from '../core/template.js';
import { centsToMoney, id, normalizeEmail, now, token } from '../core/util.js';
import { upsertContact } from '../services/contacts.js';
import { checkVatId, type TaxMode } from '../services/invoice-model.js';
import { MIN_CENTS, checkoutSession, getSession, lapseSession, readyProviders, refreshSession, startSession } from '../services/pay-registry.js';
import { imgTag, miniMarkdown, siteBlocks, wrap, type BlockEnv } from '../services/site-blocks.js';
import { resolveHref } from '../services/site-url.js';
import { catalog, quoteProduct, settingsOf, storeByKey, storeKey, type CatalogProduct } from '../services/store-catalog.js';
import { COUNTRY_NAMES, EU, buildQuote, grossUnit, taxModeFor, type StoreSettings } from '../services/store-model.js';
import { invoiceSettings } from './payments.js';
import { cleanLaw } from './checkout-law.js';

/**
 * The public side of the online store (docs/store.md): the cart API (a server cart per browser token – the browser keeps the same
 * cart in localStorage), the quote (shipping, tax, gift card), the checkout page `/store/<key>/checkout` – an on-page order form
 * that pays through the payment registry – the order status page, and the site blocks "Produktliste" and "Produktdetail" whose
 * add-to-cart forms lead to the checkout. Funnel pages are sandboxed (no storage), so the blocks need no script at all.
 */

const nonce = () => randomBytes(16).toString('base64url');
const hits = new Map<string, number[]>();
function throttled(key: string, max: number, windowMs = 60 * 60_000): boolean {
  const t = Date.now();
  const list = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
  list.push(t);
  hits.set(key, list);
  if (hits.size > 20_000) hits.clear();
  return list.length > max;
}
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
type CartItem = { product_id: string; article_id: string | null; qty: number };

export const storePublicModule: Module = {
  name: 'store-public',
  register(app: App) {
    const { db, router } = app;
    const money = (c: number, cur: string) => centsToMoney(c, cur);
    const open = (key: string) => {
      const s = storeByKey(app, key);
      if (!s) throw notFound('Diesen Shop gibt es nicht (mehr)');
      return s;
    };
    const smallBusiness = (loc: string) => invoiceSettings(app, loc).tax_mode === 'small_business';
    const law = (loc: string) => {
      const l = cleanLaw(app.location(loc)?.settings.checkout_law);
      const profile = app.services.legalTexts?.profile?.(loc) as { company?: string; email?: string; street?: string } | undefined;
      const hosted = !!profile?.company && (!!profile.email || !!profile.street);
      return { terms_url: l.terms_url, withdrawal_url: l.withdrawal_url || (hosted ? String(app.services.legalTexts.hostedUrl(loc, 'widerruf')) : ''), button_text: l.button_text };
    };

    /** Cart lines from a request: known, published products of this store only, merged, at most 50 lines. */
    function cleanItems(products: CatalogProduct[], raw: unknown): { items: CartItem[]; removed: number } {
      const out: CartItem[] = [];
      let removed = 0;
      for (const it of (Array.isArray(raw) ? raw : []).slice(0, 100) as any[]) {
        const p = products.find((x) => x.id === String(it?.product_id ?? ''));
        const art = it?.article_id ? String(it.article_id) : null;
        if (!p || (p.variants.length && !p.variants.some((v) => v.article_id === art))) {
          removed++;
          continue;
        }
        const qty = Math.max(1, Math.min(99, Math.round(Number(it?.qty) || 1)));
        const article = p.variants.length ? art : null;
        const same = out.find((x) => x.product_id === p.id && x.article_id === article);
        if (same) same.qty = Math.min(99, same.qty + qty);
        else if (out.length < 50) out.push({ product_id: p.id, article_id: article, qty });
      }
      return { items: out, removed };
    }

    /** The quote of a cart for a country (and the tax treatment that country, the cart and a VAT ID mean). */
    function quoteOf(loc: string, settings: StoreSettings, products: CatalogProduct[], items: CartItem[], o: { country?: string; shipping_id?: string; vat_id?: string }) {
      const lines = items.map((it) => ({ p: quoteProduct(products.find((x) => x.id === it.product_id)!, it.article_id), qty: it.qty }));
      const country = String(o.country ?? '').toUpperCase().slice(0, 2) || settings.countries[0] || 'DE';
      const inv = invoiceSettings(app, loc);
      const vat = o.vat_id ? checkVatId(o.vat_id) : null;
      const seller = app.location(loc)?.settings.invoices ?? {};
      const mode: TaxMode = taxModeFor({
        smallBusiness: inv.tax_mode === 'small_business',
        country,
        sellerCountry: String(seller.country || 'DE').toUpperCase().slice(0, 2),
        physical: lines.some((l) => l.p.kind === 'physical'),
        buyerVat: !!vat?.valid && vat.country === country,
        sellerVat: !!checkVatId(seller.vat_id).valid,
      });
      return { quote: buildQuote({ items: lines, settings, mode, country, shipping_id: o.shipping_id }), country, vat: vat?.valid ? vat.normalized : '' };
    }
    /** What a gift card would pay of a total (preview; the checkout holds it for real). */
    function giftPreview(loc: string, code: string, total: number, currency: string): { gift_cents: number; gift_error: string } {
      if (!code) return { gift_cents: 0, gift_error: '' };
      const c = app.services.giftCards?.check(loc, code, currency);
      if (!c || c.available_cents <= 0) return { gift_cents: 0, gift_error: 'Dieser Gutschein ist ungültig, abgelaufen oder aufgebraucht' };
      let gift = Math.min(c.available_cents, total);
      const rest = total - gift;
      if (rest > 0 && rest < MIN_CENTS) gift = Math.max(0, total - MIN_CENTS);
      return { gift_cents: gift, gift_error: gift > 0 ? '' : 'Der Gutschein lässt sich für diesen kleinen Betrag nicht einlösen' };
    }
    const providersOf = (loc: string) => readyProviders(app, loc).map((p) => ({ id: p.id, label: p.label, methods: p.methods(app, loc) }));

    // --- cart (server session; the browser keeps it in localStorage too) ---------------------------------------------------------
    router.post('/api/public/store/:key/cart', 'public', (ctx) => {
      const { locationId: loc, settings } = open(ctx.params.key);
      if (throttled(`cart:${ctx.ip}`, 600)) throw new HttpError(429, 'Zu viele Anfragen – bitte kurz warten');
      const b = ctx.body ?? {};
      const products = catalog(app, loc, { publishedOnly: true });
      const tok = typeof b.token === 'string' && /^[A-Za-z0-9_-]{16,40}$/.test(b.token) ? b.token : '';
      let cart = tok ? parseJson(db.get<any>(`SELECT * FROM store_carts WHERE id = ? AND location_id = ? AND status = 'open'`, tok, loc), ['items']) : undefined;
      // A recovery link (?cart=…) brings the server's cart back when the browser has none.
      const raw = Array.isArray(b.items) && (b.items.length || !cart) ? b.items : (cart?.items ?? []);
      const { items, removed } = cleanItems(products, raw);
      const email = b.email !== undefined ? normalizeEmail(b.email) : (cart?.email ?? '');
      if (email && !EMAIL.test(email)) throw bad('Bitte eine gültige E-Mail-Adresse eingeben');
      if (!cart && items.length) {
        cart = { id: token(18), location_id: loc, items, email, country: '', status: 'open', created_at: now(), updated_at: now() };
        db.insert('store_carts', cart);
      } else if (cart) {
        // Changing the cart starts the abandoned-cart clock again.
        db.run('UPDATE store_carts SET items = ?, email = ?, updated_at = ?, reminded_at = NULL WHERE id = ?', JSON.stringify(items), email, now(), cart.id);
      }
      const q = items.length ? quoteOf(loc, settings, products, items, { country: b.country }).quote : null;
      return { token: cart?.id ?? '', items, removed, lines: q?.lines ?? [], goods_cents: q?.goods_cents ?? 0, currency: settings.currency };
    });

    router.post('/api/public/store/:key/quote', 'public', (ctx) => {
      const { locationId: loc, settings } = open(ctx.params.key);
      const b = ctx.body ?? {};
      const products = catalog(app, loc, { publishedOnly: true });
      const { items } = cleanItems(products, b.items);
      if (!items.length) throw bad('Der Warenkorb ist leer');
      const { quote, vat } = quoteOf(loc, settings, products, items, { country: b.country, shipping_id: b.shipping_id, vat_id: b.company ? b.vat_id : '' });
      const gift = giftPreview(loc, String(b.gift_code ?? '').slice(0, 40), quote.total_cents, settings.currency);
      return { ...quote, items: undefined, ...gift, due_cents: quote.total_cents - gift.gift_cents, vat_id: vat, providers: providersOf(loc), currency: settings.currency };
    });

    // --- checkout: the order, then the payment ------------------------------------------------------------------------------------
    router.post('/api/public/store/:key/checkout', 'public', async (ctx) => {
      const { locationId: loc, settings } = open(ctx.params.key);
      if (throttled(`checkout:${ctx.ip}`, 30)) throw new HttpError(429, 'Zu viele Bestellversuche – bitte in einer Stunde noch einmal');
      const b = ctx.body ?? {};
      const products = catalog(app, loc, { publishedOnly: true });
      const { items } = cleanItems(products, b.items);
      if (!items.length) throw bad('Der Warenkorb ist leer');
      const email = normalizeEmail(b.email);
      if (!EMAIL.test(email)) throw bad('Bitte eine gültige E-Mail-Adresse eingeben');
      const first = str(b.first_name, 'Vorname', { required: true, max: 80 });
      const last = str(b.last_name, 'Nachname', { required: true, max: 80 });
      const country = String(b.country ?? '').toUpperCase().slice(0, 2);
      if (!settings.countries.includes(country)) throw bad('In dieses Land liefern wir leider nicht');
      const company = str(b.company, 'Firma', { max: 120 });
      const { quote, vat } = quoteOf(loc, settings, products, items, { country, shipping_id: b.shipping_id, vat_id: company ? b.vat_id : '' });
      if (quote.problems.length) throw bad(quote.problems[0]);
      const address = { company, street: str(b.street, 'Straße', { required: quote.needs_shipping, max: 150 }), postal_code: str(b.postal_code, 'PLZ', { required: quote.needs_shipping, max: 12 }), city: str(b.city, 'Ort', { required: quote.needs_shipping, max: 80 }), country };
      const l = law(loc);
      if (l.terms_url && settings.terms_required && b.accept_terms !== true) throw bad('Bitte die AGB akzeptieren');
      const giftCode = String(b.gift_code ?? '').slice(0, 40);
      const gift = giftPreview(loc, giftCode, quote.total_cents, settings.currency);
      if (giftCode && gift.gift_error) throw bad(gift.gift_error);
      const due = quote.total_cents - gift.gift_cents;
      const providerId = String(b.provider ?? '');
      if (due > 0 && !readyProviders(app, loc).some((p) => p.id === providerId)) throw bad('Bitte eine Zahlungsart wählen');
      if (due > 0 && due < MIN_CENTS) throw bad('Der Betrag ist zu klein für eine Online-Zahlung');
      const recipientEmail = normalizeEmail(b.gift_recipient_email);
      if (recipientEmail && !EMAIL.test(recipientEmail)) throw bad('Die E-Mail für den Gutschein ist ungültig');
      const name = `${first} ${last}`;
      const phone = str(b.phone, 'Telefon', { max: 40 });
      const contact = upsertContact(app, loc, { email, first_name: first, last_name: last, phone: phone || undefined, company: company || undefined, address: address.street || undefined, postal_code: address.postal_code || undefined, city: address.city || undefined, country }, { source: 'Online-Shop', publicInput: true }).contact;
      const cartId = typeof b.token === 'string' && db.get('SELECT 1 AS x FROM store_carts WHERE id = ? AND location_id = ?', b.token, loc) ? b.token : null;
      if (cartId) db.run('UPDATE store_carts SET email = ?, contact_id = ?, updated_at = ? WHERE id = ?', email, contact.id, now(), cartId);
      const orderId = id();
      const orderToken = token(18);
      let number = '';
      const shippingCents = quote.shipping?.price_cents ?? 0;
      const session = db.tx(() => {
        const seq = db.get<{ seq: number }>('UPDATE store_settings SET seq = seq + 1 WHERE location_id = ? RETURNING seq', loc)!.seq;
        number = `${settings.order_prefix}${seq}`;
        db.insert('store_orders', {
          id: orderId,
          location_id: loc,
          number,
          token: orderToken,
          contact_id: contact.id,
          email,
          name,
          phone,
          address,
          items: quote.lines,
          invoice_items: quote.items,
          tax_mode: quote.mode,
          shipping: quote.shipping ?? {},
          goods_cents: quote.goods_cents,
          shipping_cents: shippingCents,
          tax_cents: quote.tax_cents,
          total_cents: quote.total_cents,
          gift_cents: gift.gift_cents,
          currency: settings.currency,
          status: 'pending',
          fulfilment: 'unfulfilled',
          cart_id: cartId,
          note: str(b.note, 'Anmerkung', { max: 1000 }),
          meta: {
            ...(vat ? { vat_id: vat } : {}),
            ...(recipientEmail || b.gift_message ? { gift_recipient: { name: str(b.gift_recipient_name, 'Empfänger', { max: 120 }), email: recipientEmail, message: str(b.gift_message, 'Nachricht', { max: 500 }) } } : {}),
            ...(l.terms_url && b.accept_terms === true ? { terms_url: l.terms_url, terms_accepted_at: now() } : {}),
            button_text: l.button_text,
          },
          created_at: now(),
          updated_at: now(),
        });
        const base = `${app.baseUrl()}/store/${encodeURIComponent(storeKey(app, loc))}`;
        const s = startSession(app, {
          locationId: loc,
          purpose: 'store_order',
          refId: orderId,
          amountCents: quote.total_cents,
          currency: settings.currency,
          description: `Bestellung ${number} – ${app.location(loc)?.name ?? ''}`.slice(0, 120),
          email,
          name,
          address: { name, street: address.street, postal_code: address.postal_code, city: address.city, country },
          lines: [...quote.lines.map((x) => ({ name: x.variant ? `${x.name} (${x.variant})` : x.name, qty: x.qty, unit_cents: x.unit_cents, tax_rate: quote.mode === 'standard' && x.kind !== 'gift_card' ? (products.find((p) => p.id === x.product_id)?.tax_rate ?? 0) : 0, sku: x.sku })), ...(shippingCents ? [{ name: `Versand: ${quote.shipping!.name}`, qty: 1, unit_cents: shippingCents, tax_rate: quote.mode === 'standard' ? (quote.items.find((i) => i.name.startsWith('Versand'))?.tax_rate ?? 0) : 0 }] : [])],
          returnUrl: `${base}/order/${orderToken}`,
          cancelUrl: `${base}/checkout`,
          giftCode: giftCode || undefined,
        });
        db.run('UPDATE store_orders SET pay_session_id = ?, gift_cents = ? WHERE id = ?', s.id, s.gift_cents, orderId);
        return s;
      });
      app.events.emit(loc, 'store.order_placed', { contactId: contact.id, orderId, productIds: [...new Set(items.map((i) => i.product_id))], order: { id: orderId, number, total_cents: quote.total_cents, currency: settings.currency, items: quote.lines, status_url: `${app.baseUrl()}/store/${encodeURIComponent(storeKey(app, loc))}/order/${orderToken}` } });
      let r: { url: string; settled?: boolean };
      try {
        r = await checkoutSession(app, session, session.amount_cents === 0 ? 'giftcard' : providerId);
      } catch (e) {
        // The provider did not make a page (down, refused): the order is cancelled and a held gift card is free again.
        lapseSession(app, getSession(app, session.id) ?? session, 'cancelled');
        throw e;
      }
      return { order: { number, token: orderToken }, redirect: r.settled ? `/store/${encodeURIComponent(storeKey(app, loc))}/order/${orderToken}` : r.url };
    });

    // --- pages -------------------------------------------------------------------------------------------------------------------------
    const CSS = `<style>
.ck{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);gap:20px;align-items:start}@media (max-width:820px){.ck{grid-template-columns:1fr}}
.ck h2{font-size:18px;margin:18px 0 8px}.ck h2:first-child{margin-top:0}.ck-line{display:flex;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line)}
.ck-line img{width:56px;height:56px;object-fit:cover;border-radius:8px;background:#f3f4f6}.ck-line .nm{flex:1;min-width:0}.ck-line .nm small{display:block;color:var(--muted)}
.ck-line input{width:64px;padding:6px}.ck-line button{background:none;color:var(--muted);padding:4px 8px;font-weight:400}.ck-sum td{border:0;padding:4px 0}.ck-sum td:last-child{text-align:right}
.ck-sum tr.tot td{font-weight:700;font-size:18px;border-top:1px solid var(--line);padding-top:10px}.ck-opt{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:6px 0;font-weight:400;cursor:pointer}
.ck-opt input{width:auto;margin-top:4px}.ck-opt span{flex:1}.ck-opt b{float:right}.ck-head{display:flex;align-items:center;gap:12px;margin-bottom:16px}.ck-head img{max-height:44px}
.ck .grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}@media (max-width:560px){.ck .grid2{grid-template-columns:1fr}}#go{width:100%;margin-top:14px;font-size:17px}
.pill{display:inline-block;padding:2px 10px;border-radius:99px;background:#eef2ff;font-size:13px}
</style>`;

    router.get('/store/:key/checkout', 'public', (ctx) => {
      const found = storeByKey(app, ctx.params.key);
      if (!found) return html(publicPage({ title: 'Nicht gefunden', body: '<div class="wrap"><div class="card"><h1>Nicht gefunden</h1><p class="muted">Diesen Shop gibt es nicht (mehr).</p></div></div>' }), 404);
      const { locationId: loc, settings } = found;
      const location = app.location(loc)!;
      const l = law(loc);
      const n = nonce();
      const data = {
        key: storeKey(app, loc),
        currency: settings.currency,
        countries: settings.countries.map((c) => [c, COUNTRY_NAMES[c] ?? c]),
        terms_url: settings.terms_required ? l.terms_url : '',
        withdrawal_url: l.withdrawal_url,
        button: l.button_text.charAt(0).toUpperCase() + l.button_text.slice(1),
        note: settings.checkout_note,
        small_business: smallBusiness(loc),
        gift: !!app.services.giftCards,
        eu: EU,
      };
      const body = `<div class="wrap" style="max-width:1000px">
<div class="ck-head">${location.logo_url ? `<img src="${escapeHtml(location.logo_url)}" alt="">` : ''}<h1 style="margin:0">${escapeHtml(settings.name || location.name)} · Kasse</h1></div>
<div class="ck">
<section class="card" aria-labelledby="h-cart"><h2 id="h-cart">Warenkorb</h2><div id="lines" aria-live="polite"></div><p id="empty" class="muted" hidden>Dein Warenkorb ist leer.</p><p><a id="back" href="#" class="muted">← Weiter einkaufen</a></p>
<table class="ck-sum" id="sum" aria-live="polite"></table></section>
<form class="card" id="f" novalidate>
<h2>Deine Angaben</h2>
<label for="email">E-Mail *</label><input id="email" name="email" type="email" autocomplete="email" required>
<div class="grid2"><div><label for="first_name">Vorname *</label><input id="first_name" autocomplete="given-name" required></div><div><label for="last_name">Nachname *</label><input id="last_name" autocomplete="family-name" required></div></div>
<label for="company">Firma (optional)</label><input id="company" autocomplete="organization">
<div id="vat-row" hidden><label for="vat_id">USt-IdNr. (Unternehmen in einem anderen EU-Land)</label><input id="vat_id" autocomplete="off" placeholder="z. B. ATU12345678"></div>
<div id="addr"><label for="street">Straße und Hausnummer *</label><input id="street" autocomplete="street-address">
<div class="grid2"><div><label for="postal_code">PLZ *</label><input id="postal_code" autocomplete="postal-code"></div><div><label for="city">Ort *</label><input id="city" autocomplete="address-level2"></div></div></div>
<label for="country">Land *</label><select id="country" autocomplete="country"></select>
<label for="phone">Telefon (optional)</label><input id="phone" type="tel" autocomplete="tel">
<div id="giftfor" hidden><h2>Gutschein verschenken (optional)</h2><p class="muted" style="margin:0">Ohne Angabe schicken wir den Gutschein an dich.</p>
<div class="grid2"><div><label for="gr_name">Name</label><input id="gr_name"></div><div><label for="gr_email">E-Mail</label><input id="gr_email" type="email"></div></div><label for="gr_msg">Nachricht</label><input id="gr_msg" maxlength="300"></div>
<div id="ship-box"><h2>Versand</h2><div id="ship" role="radiogroup" aria-label="Versandart"></div></div>
<div id="gift-box"><h2>Gutschein</h2><div class="row"><input id="gift" placeholder="Gutscheincode" autocomplete="off" aria-label="Gutscheincode"><button type="button" class="btn secondary" id="gift-btn" style="flex:0 0 auto">Einlösen</button></div><p id="gift-msg" class="muted" style="margin:6px 0 0"></p></div>
<div id="pay-box"><h2>Zahlung</h2><div id="pay" role="radiogroup" aria-label="Zahlungsart"></div></div>
<label for="note">Anmerkung zur Bestellung (optional)</label><input id="note" maxlength="500">
<p class="muted" id="ck-note" style="font-size:14px"></p>
<div id="terms-row" hidden><label class="check"><input type="checkbox" id="terms"> <span>Ich habe die <a id="terms-link" target="_blank" rel="noopener">Allgemeinen Geschäftsbedingungen</a> gelesen und akzeptiere sie.</span></label></div>
<p class="muted" id="wd" style="font-size:13px" hidden>Informationen zum <a id="wd-link" target="_blank" rel="noopener">Widerrufsrecht</a>.</p>
<button type="submit" id="go"></button><p class="error" id="err" role="alert"></p>
</form></div></div>
<script type="application/json" id="store-data">${jsonForScript(data)}</script>
<script nonce="${n}">${CHECKOUT_JS}</script>`;
      const r = html(publicPage({ title: `Kasse – ${settings.name || location.name}`, body, head: CSS, color: location.settings?.branding?.color || undefined }));
      r.headers['content-security-policy'] = `default-src 'none'; script-src 'nonce-${n}'; style-src 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'`;
      r.headers['cache-control'] = 'no-store';
      return r;
    });

    /** The buyer's page of an order: status, what was bought, tracking – and "Jetzt bezahlen" while the payment is open. */
    router.get('/store/:key/order/:token', 'public', async (ctx) => {
      const found = storeByKey(app, ctx.params.key);
      let o = found ? parseJson(db.get<any>('SELECT * FROM store_orders WHERE token = ? AND location_id = ?', ctx.params.token, found.locationId), ['items', 'address', 'shipping', 'meta']) : undefined;
      if (!found || !o) return html(publicPage({ title: 'Nicht gefunden', body: '<div class="wrap"><div class="card"><h1>Nicht gefunden</h1><p class="muted">Diese Bestellung gibt es nicht.</p></div></div>' }), 404);
      // Back from the provider before its webhook: ask once in a while.
      if (o.status === 'pending' && o.pay_session_id && !throttled(`ord:${ctx.ip}`, 120)) {
        const s = getSession(app, o.pay_session_id);
        if (s && s.provider_ref) await refreshSession(app, s).catch((e) => console.error('[store] refresh', (e as Error).message));
        o = parseJson(db.get<any>('SELECT * FROM store_orders WHERE id = ?', o.id), ['items', 'address', 'shipping', 'meta']);
      }
      const location = app.location(o.location_id)!;
      const s = o.pay_session_id ? getSession(app, o.pay_session_id) : undefined;
      const inv = o.invoice_id ? db.get<{ public_token: string; number: string; finalised_at: string | null }>('SELECT public_token, number, finalised_at FROM invoices WHERE id = ?', o.invoice_id) : undefined;
      const state =
        o.status === 'paid'
          ? `<p class="ok">Danke! Die Zahlung ist eingegangen.${o.fulfilment === 'shipped' ? ' Deine Bestellung ist unterwegs.' : o.fulfilment === 'delivered' ? ' Deine Bestellung wurde zugestellt.' : ''}</p>`
          : o.status === 'pending'
            ? s?.status === 'pending'
              ? '<p>Deine Zahlung wird bearbeitet (z. B. eine Überweisung oder Lastschrift). Sobald sie bestätigt ist, bekommst du eine E-Mail.</p>'
              : `<p>Die Zahlung steht noch aus.</p>${s && s.status === 'open' ? `<p><a class="btn" href="/pay/${escapeHtml(s.id)}">Jetzt bezahlen</a></p>` : ''}`
            : `<p class="muted">Diese Bestellung ist ${o.status === 'refunded' ? 'erstattet' : 'abgebrochen'}.</p>`;
      const rows = o.items.map((x: any) => `<tr><td>${x.qty} × ${escapeHtml(x.name)}${x.variant ? ` <span class="muted">(${escapeHtml(x.variant)})</span>` : ''}</td><td style="text-align:right">${escapeHtml(money(x.total_cents, o.currency))}</td></tr>`).join('');
      const tracking = o.tracking_number ? `<p>Sendungsnummer: <strong>${escapeHtml(o.tracking_number)}</strong>${o.tracking_url ? ` – <a href="${escapeHtml(o.tracking_url)}" target="_blank" rel="noopener">Sendung verfolgen</a>` : ''}</p>` : '';
      const body = `<div class="wrap" style="max-width:640px"><div class="card">
${location.logo_url ? `<img src="${escapeHtml(location.logo_url)}" alt="" style="max-height:44px;margin-bottom:10px">` : `<p class="muted" style="margin:0 0 6px">${escapeHtml(location.name)}</p>`}
<h1>Bestellung ${escapeHtml(o.number)}</h1>${state}${tracking}
<table>${rows}${o.shipping?.name ? `<tr><td>Versand: ${escapeHtml(o.shipping.name)}</td><td style="text-align:right">${escapeHtml(money(o.shipping_cents, o.currency))}</td></tr>` : ''}
<tr><td><strong>Gesamt</strong></td><td style="text-align:right"><strong>${escapeHtml(money(o.total_cents, o.currency))}</strong></td></tr>
${o.gift_cents ? `<tr><td class="muted">davon mit Gutschein</td><td style="text-align:right" class="muted">${escapeHtml(money(o.gift_cents, o.currency))}</td></tr>` : ''}</table>
${inv?.finalised_at ? `<p><a class="btn secondary" href="/i/${escapeHtml(inv.public_token)}">Rechnung ${escapeHtml(inv.number)} ansehen</a></p>` : ''}
</div></div>`;
      const r = html(publicPage({ title: `Bestellung ${o.number}`, body, color: location.settings?.branding?.color || undefined }));
      r.headers['cache-control'] = 'no-store';
      return r;
    });

    // --- site blocks ---------------------------------------------------------------------------------------------------------------------
    const CARD_CSS = `.sgrid{display:grid;gap:1.2em;grid-template-columns:repeat(var(--cols,3),minmax(0,1fr))}@media (max-width:760px){.sgrid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media (max-width:480px){.sgrid{grid-template-columns:1fr}}
.scard{display:flex;flex-direction:column;background:var(--c-bg);border:1px solid var(--line);border-radius:var(--r-lg);overflow:hidden;box-shadow:var(--sh-sm,none)}.scard .simg{aspect-ratio:1/1;background:var(--c-surface,#f3f4f6)}.scard .simg img{width:100%;height:100%;object-fit:cover;display:block}
.scard .sbody{padding:1em;display:flex;flex-direction:column;gap:.4em;flex:1}.scard h3{margin:0;font-size:1.05em}.scard .sprice{font-weight:800;font-size:1.15em;margin:0}.scard .stax{font-size:.78em;color:var(--muted);margin:0}
.scard form{margin-top:auto;display:flex;flex-direction:column;gap:.5em}.scard select{padding:.55em;border:1px solid var(--line);border-radius:var(--r-sm);font:inherit;background:var(--c-bg);color:inherit}.scard .btn{width:100%;text-align:center;border:0;cursor:pointer;font:inherit}.scard .sout{color:var(--muted);font-size:.9em}`;
    const DETAIL_CSS = `.sdetail{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:2em;align-items:start}@media (max-width:760px){.sdetail{grid-template-columns:1fr}}
.sdetail .sgal img{width:100%;border-radius:var(--r-lg);display:block}.sdetail .sthumbs{display:flex;gap:.5em;margin-top:.5em}.sdetail .sthumbs img{width:64px;height:64px;object-fit:cover;border-radius:var(--r-sm)}
.sdetail h1,.sdetail h2{margin:0 0 .3em}.sdetail .sprice{font-weight:800;font-size:1.6em;margin:0}.sdetail .stax{font-size:.78em;color:var(--muted);margin:0}.sdetail form{margin-top:1em;display:flex;flex-direction:column;gap:.6em}
.sdetail select,.sdetail input{padding:.55em;border:1px solid var(--line);border-radius:var(--r-sm);font:inherit;background:var(--c-bg);color:inherit}.sdetail .btn{width:100%;text-align:center;border:0;cursor:pointer;font:inherit}.sdetail .sqty{display:flex;gap:.5em;align-items:center}.sdetail .sqty input{width:5em}.sdetail .sout{color:var(--muted)}`;

    const env2store = (env: BlockEnv) => {
      const settings = settingsOf(app, env.locationId);
      return settings.enabled ? { settings, url: `${app.baseUrl()}/store/${encodeURIComponent(storeKey(app, env.locationId))}/checkout` } : undefined;
    };
    const taxNote = (env: BlockEnv, p: CatalogProduct, physical: boolean) => {
      const small = smallBusiness(env.locationId);
      const vat = p.kind === 'gift_card' ? 'Gutschein, umsatzsteuerfrei bei Kauf' : small ? 'Gemäß § 19 UStG ohne Umsatzsteuer' : p.tax_rate ? `inkl. ${String(p.tax_rate).replace('.', ',')} % USt.` : 'ohne Umsatzsteuer';
      return `${vat}${physical ? ', zzgl. Versand' : ''}`;
    };
    const priceOf = (env: BlockEnv, p: CatalogProduct) => {
      const mode: TaxMode = smallBusiness(env.locationId) ? 'small_business' : 'standard';
      const prices = (p.variants.length ? p.variants.map((v) => v.net_cents) : [p.net_cents]).map((net) => grossUnit({ net_cents: net, tax_rate: p.tax_rate, kind: p.kind }, mode));
      const min = Math.min(...prices);
      return `${prices.some((x) => x !== min) ? 'ab ' : ''}${money(min, p.currency)}`;
    };
    const soldOut = (p: CatalogProduct) => p.kind !== 'gift_card' && !p.allow_backorder && (p.variants.length ? p.variants.every((v) => v.stock !== null && v.stock <= 0) : p.stock !== null && p.stock <= 0);
    const variantSelect = (p: CatalogProduct, idp: string) =>
      p.variants.length
        ? `<label class="sr-only" for="${idp}">Variante</label><select id="${idp}" name="add_variant" required aria-label="Variante">${p.variants.map((v) => `<option value="${escapeHtml(v.article_id)}"${!p.allow_backorder && v.stock !== null && v.stock <= 0 ? ' disabled' : ''}>${escapeHtml(v.label)}${!p.allow_backorder && v.stock !== null && v.stock <= 0 ? ' – ausverkauft' : ''}</option>`).join('')}</select>`
        : '';
    const addForm = (url: string, p: CatalogProduct, inner: string, label: string) =>
      soldOut(p)
        ? '<p class="sout">Ausverkauft</p>'
        : `<form method="get" action="${escapeHtml(url)}" target="_top"><input type="hidden" name="add_product" value="${escapeHtml(p.id)}">${inner}<button type="submit" class="btn">${escapeHtml(label)}</button></form>`;
    const hint = (env: BlockEnv, b: any, o: { bare: boolean }, text: string) => (env.preview ? wrap(env, b, o.bare, `<p class="muted" style="text-align:center">${escapeHtml(text)}</p>`) : '');

    siteBlocks(app).set('store_products', {
      type: 'store_products',
      css: CARD_CSS,
      render: (env, b, o) => {
        const store = env2store(env);
        if (!store) return hint(env, b, o, 'Der Online-Shop ist noch nicht aktiviert (Umsatz → Online-Shop → Einstellungen).');
        let list = catalog(app, env.locationId, { publishedOnly: true });
        const col = String(b.collection ?? '').trim();
        if (col) {
          const c = db.get<{ id: string }>('SELECT id FROM store_collections WHERE location_id = ? AND (slug = ? OR id = ?)', env.locationId, col.toLowerCase(), col);
          list = c ? list.filter((p) => p.collection_ids.includes(c.id)) : [];
        }
        list = list.slice(0, Math.max(1, Math.min(48, Math.round(Number(b.limit) || 12))));
        if (!list.length) return hint(env, b, o, 'Noch keine veröffentlichten Produkte (Online-Shop → Produkte).');
        const detail = String(b.detail_url ?? '').trim();
        const cols = Math.max(1, Math.min(4, Math.round(Number(b.columns) || 3)));
        const cards = list
          .map((p, i) => {
            const link = detail ? `${resolveHref(env, detail)}${resolveHref(env, detail).includes('?') ? '&' : '?'}product=${encodeURIComponent(p.slug)}` : '';
            const image = p.images[0] ? imgTag(env, { src: p.images[0], alt: p.name, sizes: '(max-width:480px) 100vw, 33vw' }) : '';
            return `<article class="scard"><div class="simg">${link ? `<a href="${escapeHtml(link)}" tabindex="-1" aria-hidden="true">${image}</a>` : image}</div><div class="sbody"><h3>${link ? `<a href="${escapeHtml(link)}">${escapeHtml(p.name)}</a>` : escapeHtml(p.name)}</h3><p class="sprice">${escapeHtml(priceOf(env, p))}</p><p class="stax">${escapeHtml(taxNote(env, p, p.kind === 'physical'))}</p>${addForm(store.url, p, variantSelect(p, `v-${b.id}-${i}`), String(b.button_text || 'In den Warenkorb'))}</div></article>`;
          })
          .join('');
        return wrap(env, b, o.bare, `${b.heading ? `<h2>${escapeHtml(String(b.heading))}</h2>` : ''}<div class="sgrid" style="--cols:${cols}">${cards}</div>`, { wide: true });
      },
    });

    siteBlocks(app).set('store_product', {
      type: 'store_product',
      css: DETAIL_CSS,
      render: (env, b, o) => {
        const store = env2store(env);
        if (!store) return hint(env, b, o, 'Der Online-Shop ist noch nicht aktiviert (Umsatz → Online-Shop → Einstellungen).');
        const list = catalog(app, env.locationId, { publishedOnly: true });
        // A fixed product, or the one the product list links to (?product=<slug>) – one detail page for the whole store.
        const want = String(b.product_id || env.ctx?.query.get('product') || '').slice(0, 80);
        const p = list.find((x) => x.id === want || x.slug === want) ?? (env.preview ? list[0] : undefined);
        if (!p) return hint(env, b, o, 'Produkt wählen – oder die Seite aus der Produktliste mit ?product=… öffnen.');
        const imgs = p.images.map((src, i) => imgTag(env, { src, alt: i ? '' : p.name, eager: i === 0 }));
        const level = b.heading_level === '2' ? 'h2' : 'h1';
        const stock = p.variants.length ? '' : p.stock !== null && p.stock > 0 && p.stock <= 5 ? `<p class="stax">Nur noch ${p.stock} verfügbar</p>` : '';
        const body = `<div class="sdetail"><div class="sgal">${imgs[0] ?? ''}${imgs.length > 1 ? `<div class="sthumbs">${imgs.slice(1, 6).join('')}</div>` : ''}</div><div>
<${level}>${escapeHtml(String(b.heading || p.name))}</${level}><p class="sprice">${escapeHtml(priceOf(env, p))}</p><p class="stax">${escapeHtml(taxNote(env, p, p.kind === 'physical'))}</p>${stock}
${b.show_description === false || !p.description ? '' : `<div class="sdesc">${miniMarkdown(p.description)}</div>`}
${addForm(store.url, p, `${variantSelect(p, `v-${b.id}`)}<div class="sqty"><label for="q-${b.id}">Menge</label><input id="q-${b.id}" type="number" name="qty" min="1" max="99" value="1"></div>`, String(b.button_text || 'In den Warenkorb'))}</div></div>`;
        return wrap(env, b, o.bare, body, { wide: true });
      },
    });
  },
};

/** The checkout page's script: the cart in localStorage + the server cart, live quote (shipping, tax, gift card), the order. */
const CHECKOUT_JS = `(function(){
var D=JSON.parse(document.getElementById('store-data').textContent);var KEY='ghl-cart-'+D.key;var $=function(i){return document.getElementById(i)};
var fmt=function(c){return new Intl.NumberFormat('de-DE',{style:'currency',currency:D.currency}).format((c||0)/100)};
var st={token:'',items:[]};try{var sv=JSON.parse(localStorage.getItem(KEY)||'null');if(sv&&Array.isArray(sv.items))st=sv}catch(e){}
var q=new URLSearchParams(location.search);var add=q.get('add_product');
if(add){var art=q.get('add_variant')||null;var n=Math.max(1,Math.min(99,parseInt(q.get('qty')||'1',10)||1));var ex=st.items.filter(function(i){return i.product_id===add&&(i.article_id||null)===art})[0];if(ex)ex.qty=Math.min(99,ex.qty+n);else st.items.push({product_id:add,article_id:art,qty:n})}
var rec=q.get('cart');if(rec&&!st.items.length)st.token=rec;
try{if(document.referrer&&document.referrer.indexOf('/store/')<0)sessionStorage.setItem(KEY+'-back',document.referrer)}catch(e){}
if(add||rec)history.replaceState(null,'',location.pathname);
var back=null;try{back=sessionStorage.getItem(KEY+'-back')}catch(e){}$('back').onclick=function(e){e.preventDefault();if(back)location.href=back;else history.back()};
function save(){try{localStorage.setItem(KEY,JSON.stringify(st))}catch(e){}}
function post(p,b){return fetch('/api/public/store/'+encodeURIComponent(D.key)+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}).then(function(r){return r.json().catch(function(){return{}}).then(function(j){if(!r.ok)throw new Error(j.error||'Fehler');return j})})}
function el(t,a,txt){var e=document.createElement(t);if(a)for(var k in a)e.setAttribute(k,a[k]);if(txt!==undefined)e.textContent=txt;return e}
D.countries.forEach(function(c){$('country').appendChild(el('option',{value:c[0]},c[1]))});
$('go').textContent=D.button;if(D.note)$('ck-note').textContent=D.note;
if(D.terms_url){$('terms-row').hidden=false;$('terms-link').href=D.terms_url}if(D.withdrawal_url){$('wd').hidden=false;$('wd-link').href=D.withdrawal_url}
if(!D.gift)$('gift-box').hidden=true;
var quote=null,gift='',lines=[];
function setItems(j){st.token=j.token||st.token;st.items=j.items||[];lines=j.lines||[];save();renderCart()}
function renderCart(){var box=$('lines');box.textContent='';$('empty').hidden=st.items.length>0;$('f').hidden=!st.items.length;
lines.forEach(function(l,i){var row=el('div',{'class':'ck-line'});if(l.image)row.appendChild(el('img',{src:l.image,alt:''}));else row.appendChild(el('img',{alt:'',src:'data:image/gif;base64,R0lGODlhAQABAAAAACw='}));
var nm=el('div',{'class':'nm'});nm.appendChild(el('strong',null,l.name));if(l.variant)nm.appendChild(el('small',null,l.variant));nm.appendChild(el('small',null,fmt(l.unit_cents)+' / Stück'));row.appendChild(nm);
var inp=el('input',{type:'number',min:'1',max:'99',value:String(l.qty),'aria-label':'Menge '+l.name});inp.onchange=function(){st.items[i].qty=Math.max(1,Math.min(99,parseInt(inp.value,10)||1));sync()};row.appendChild(inp);
row.appendChild(el('span',{style:'min-width:80px;text-align:right'},fmt(l.total_cents)));var rm=el('button',{type:'button','aria-label':l.name+' entfernen'},'✕');rm.onclick=function(){st.items.splice(i,1);sync()};row.appendChild(rm);box.appendChild(row)});
$('giftfor').hidden=!lines.some(function(l){return l.kind==='gift_card'})}
function sel(name){var c=document.querySelector('input[name='+name+']:checked');return c?c.value:''}
function renderSum(){var t=$('sum');t.textContent='';if(!quote){$('ship-box').hidden=true;$('pay-box').hidden=true;return}
var tr=function(a,b,cls){var r=el('tr',cls?{'class':cls}:null);r.appendChild(el('td',null,a));r.appendChild(el('td',null,b));t.appendChild(r)};
tr('Zwischensumme',fmt(quote.goods_cents));if(quote.shipping)tr('Versand ('+quote.shipping.name+')',quote.shipping.price_cents?fmt(quote.shipping.price_cents):'kostenlos');
tr('Gesamt',fmt(quote.total_cents),'tot');(quote.tax_groups||[]).forEach(function(g){tr('enthaltene USt. '+String(g.rate).replace('.',',')+' %',fmt(g.tax_cents))});
if(quote.mode==='small_business')tr('Gemäß § 19 UStG ohne Umsatzsteuer','');if(quote.mode==='export')tr('Steuerfreie Ausfuhr','');if(quote.mode==='ig_supply')tr('Steuerfreie innergemeinschaftliche Lieferung','');
if(quote.gift_cents){tr('Gutschein','−'+fmt(quote.gift_cents));tr('Noch zu zahlen',fmt(quote.due_cents),'tot')}
$('gift-msg').textContent=gift?(quote.gift_error||('Gutschein: '+fmt(quote.gift_cents)+' werden angerechnet')):'';
$('addr').hidden=!quote.needs_shipping;$('ship-box').hidden=!quote.needs_shipping;var s=$('ship');var cur=sel('ship');s.textContent='';
(quote.shipping_options||[]).forEach(function(o){var lab=el('label',{'class':'ck-opt'});var r=el('input',{type:'radio',name:'ship',value:o.id});if(quote.shipping&&quote.shipping.id===o.id)r.checked=true;r.onchange=requote;lab.appendChild(r);var sp=el('span',null,o.name+(o.delivery?' · '+o.delivery:''));sp.appendChild(el('b',null,o.price_cents?fmt(o.price_cents):'kostenlos'));lab.appendChild(sp);s.appendChild(lab)});
var p=$('pay');var pc=sel('pay');p.textContent='';$('pay-box').hidden=quote.due_cents<=0;(quote.providers||[]).forEach(function(o,i){var lab=el('label',{'class':'ck-opt'});var r=el('input',{type:'radio',name:'pay',value:o.id});if(pc?pc===o.id:i===0)r.checked=true;lab.appendChild(r);var sp=el('span');sp.appendChild(el('strong',null,o.id==='stripe'?'Karte, SEPA, Apple Pay':o.label));sp.appendChild(el('br'));sp.appendChild(el('small',{'class':'muted'},o.methods.join(' · ')));lab.appendChild(sp);p.appendChild(lab)});
if(!(quote.providers||[]).length&&quote.due_cents>0)p.appendChild(el('p',{'class':'error'},'Gerade ist keine Online-Zahlung eingerichtet.'));
$('err').textContent=(quote.problems||[])[0]||''}
function requote(){if(!st.items.length){quote=null;renderSum();return Promise.resolve()}
return post('/quote',{items:st.items,country:$('country').value,shipping_id:sel('ship'),gift_code:gift,vat_id:$('vat_id').value,company:$('company').value}).then(function(j){quote=j;renderSum()}).catch(function(e){$('err').textContent=e.message})}
function sync(extra){var b={token:st.token,items:st.items};if(extra)for(var k in extra)b[k]=extra[k];return post('/cart',b).then(setItems).then(requote).catch(function(e){$('err').textContent=e.message})}
$('country').onchange=function(){$('vat-row').hidden=!($('company').value&&D.eu.indexOf($('country').value)>=0);requote()};
$('company').oninput=function(){$('vat-row').hidden=!($('company').value&&D.eu.indexOf($('country').value)>=0)};$('vat_id').onchange=requote;
$('gift-btn').onclick=function(){gift=$('gift').value.trim();requote()};
$('email').onchange=function(){var v=$('email').value.trim();if(st.token&&/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(v))post('/cart',{token:st.token,items:st.items,email:v}).catch(function(){})};
$('f').onsubmit=function(e){e.preventDefault();var btn=$('go');btn.disabled=true;$('err').textContent='';
var v=function(i){return $(i).value.trim()};
post('/checkout',{token:st.token,items:st.items,email:v('email'),first_name:v('first_name'),last_name:v('last_name'),company:v('company'),vat_id:v('vat_id'),street:v('street'),postal_code:v('postal_code'),city:v('city'),country:$('country').value,phone:v('phone'),shipping_id:sel('ship'),gift_code:gift,provider:sel('pay'),accept_terms:$('terms').checked,note:v('note'),gift_recipient_name:v('gr_name'),gift_recipient_email:v('gr_email'),gift_message:v('gr_msg')})
.then(function(j){try{localStorage.removeItem(KEY)}catch(x){}location.href=j.redirect}).catch(function(x){$('err').textContent=x.message;btn.disabled=false})};
renderCart();sync();})();`;
