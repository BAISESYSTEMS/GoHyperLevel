import type { App, Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, html, notFound, num, redirect, str, type Ctx } from '../core/http.js';
import { jsonForScript, publicPage } from '../core/page.js';
import { escapeHtml } from '../core/template.js';
import { centsToMoney, id, now, token } from '../core/util.js';
import { addTags, logActivity } from '../services/contacts.js';
import { MIN_AMOUNT_CENTS, StripeError, lineItemParams, stripeRequest } from '../services/stripe.js';

/**
 * Sells more on Stripe buy links (/buy/<slug>), plugged into the buy hooks of stripe.ts:
 * - order bump: a second product as a checkbox on the buy page → second Checkout line, both on the invoice;
 * - one-click upsell after the purchase: the card is saved during Checkout (setup_future_usage=off_session),
 *   „Ja, hinzufügen“ charges it off-session; banks asking for 3-D Secure get a normal Checkout instead;
 * - discount codes (percent or amount, per product) and Stripe promotion codes on the Checkout page.
 */

const UPSELL_TTL_MS = 60 * 60_000;
const CODE = /^[A-Z0-9_-]{2,40}$/;

export const grossOfNet = (net: number, tax: number) => net + Math.round((net * tax) / 100);
/** The net amount whose gross (with per-line rounding like the invoice) is `gross`, as close as possible. */
export function netForGross(gross: number, tax: number): number {
  const n0 = Math.round(gross / (1 + tax / 100));
  for (const d of [0, 1, -1, 2, -2]) if (grossOfNet(n0 + d, tax) === gross) return n0 + d;
  return n0;
}
/** Negative net discount of a code on a net price (amount codes are gross, as the buyer sees them). */
export function couponNet(priceNet: number, tax: number, c: { kind: string; value: number }): number {
  const raw = c.kind === 'amount' ? Math.round(Number(c.value) / (1 + tax / 100)) : Math.round((priceNet * Number(c.value)) / 100);
  return -Math.min(Math.max(raw, 0), priceNet);
}
const normCode = (v: unknown) =>
  String(v ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');

const tries = new Map<string, number[]>();
function throttled(ip: string, max = 30, windowMs = 10 * 60_000) {
  const t = Date.now();
  const list = (tries.get(ip) ?? []).filter((x) => t - x < windowMs);
  list.push(t);
  tries.set(ip, list);
  if (tries.size > 20_000) tries.clear();
  return list.length > max;
}

export const buyOffersModule: Module = {
  name: 'buy-offers',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE buy_offers (
        product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        bump_product_id TEXT, bump_title TEXT NOT NULL DEFAULT '', bump_text TEXT NOT NULL DEFAULT '',
        upsell_product_id TEXT, upsell_title TEXT NOT NULL DEFAULT '', upsell_text TEXT NOT NULL DEFAULT '',
        stripe_promo INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
      );
      CREATE TABLE buy_coupons (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE, code TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'percent', value INTEGER NOT NULL, max_uses INTEGER, uses INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, UNIQUE(product_id, code)
      );
      CREATE TABLE buy_upsells (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        checkout_id TEXT NOT NULL UNIQUE, product_id TEXT NOT NULL, upsell_product_id TEXT NOT NULL,
        payment_intent TEXT, email TEXT NOT NULL DEFAULT '', carry TEXT NOT NULL DEFAULT '{}', continue_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open', upsell_payment_intent TEXT, fallback_session TEXT, invoice_id TEXT,
        error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, done_at TEXT, checked_at TEXT
      );
      CREATE INDEX buy_upsells_status ON buy_upsells(status);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const sb = () => app.services.stripeBuy as StripeBuy | undefined;
    const money = (c: number, cur: string) => centsToMoney(c, String(cur || 'EUR').toUpperCase());
    const offerOf = (productId: string) => db.get('SELECT * FROM buy_offers WHERE product_id = ?', productId);
    /** An active one-time product of the same sub-account and currency, for bumps and upsells. */
    const extraProduct = (pid: string | null | undefined, main: any) => {
      if (!pid) return undefined;
      const p = db.get('SELECT * FROM products WHERE id = ? AND location_id = ? AND active = 1', pid, main.location_id);
      return p && !p.recurring && p.currency === main.currency && p.id !== main.id ? p : undefined;
    };

    /**
     * A code with a limit counts its uses when a purchase is paid – but the buyer pays on Stripe's page minutes later. Until then the
     * use is *held*: by the Checkout page that carries the code (it expires after 31 minutes, a SEPA payment holds it until the bank
     * answers) and, while that page is being made, in memory. Without the hold every buyer who started before the first one finished
     * got the discount – a code "for the first 10" was used 50 times on launch day.
     */
    const HOLD_MS = 33 * 60_000;
    const making = new Map<string, Map<string, number>>();
    function heldUses(c: any): number {
      const rows = db.all<{ h: string | null }>(
        `SELECT json_extract(meta, '$.coupon_hold') AS h FROM stripe_checkouts WHERE product_id = ? AND json_extract(meta, '$.coupon_code') = ?
         AND (status = 'pending' OR (status IN ('open', 'processing') AND created_at > ?))`,
        c.product_id,
        c.code,
        new Date(Date.now() - HOLD_MS).toISOString(),
      );
      const holds = new Set<string>(rows.map((r, i) => r.h ?? `row-${i}`));
      // a hold in memory ends once its Checkout page is stored (from then on the row speaks for it) – or after two minutes
      const mem = making.get(c.id);
      for (const [hold, until] of mem ?? []) {
        if (until < Date.now() || db.get(`SELECT 1 AS x FROM stripe_checkouts WHERE product_id = ? AND json_extract(meta, '$.coupon_hold') = ?`, c.product_id, hold)) mem!.delete(hold);
        else holds.add(hold);
      }
      return holds.size;
    }

    function checkCoupon(product: any, raw: unknown): { coupon: any } | { error: string } {
      const code = normCode(raw);
      if (product.recurring) return { error: 'Rabattcodes gelten nur für Einmalkäufe' };
      const c = CODE.test(code) ? db.get('SELECT * FROM buy_coupons WHERE product_id = ? AND code = ?', product.id, code) : undefined;
      if (!c || !c.active) return { error: 'Diesen Rabattcode gibt es nicht' };
      if (c.expires_at && c.expires_at < now()) return { error: 'Dieser Rabattcode ist abgelaufen' };
      if (c.max_uses && c.uses >= c.max_uses) return { error: 'Dieser Rabattcode ist schon aufgebraucht' };
      if (c.max_uses && c.uses + heldUses(c) >= c.max_uses) return { error: 'Dieser Rabattcode ist gerade aufgebraucht – jemand bezahlt gerade damit. Wird der Kauf nicht abgeschlossen, ist er in einer halben Stunde wieder frei.' };
      return { coupon: c };
    }
    const couponLabel = (c: any, currency: string) => (c.kind === 'amount' ? `−${money(c.value, currency)}` : `−${c.value} %`);
    /** What the main line costs with a code: gross unit amount and the (negative) net discount. */
    function discounted(p: any, c: any) {
      const { tax } = sb()!.grossOf(p);
      const disc = couponNet(p.price_cents, tax, c);
      return { tax, disc, unit: grossOfNet(p.price_cents, tax) + grossOfNet(disc, tax) };
    }

    // --- buy page: bump checkbox, discount code, live total ---------------------------------
    app.services.buyPageHtml = [
      ...(app.services.buyPageHtml ?? []),
      (_ctx: Ctx, p: any, _link: any, key: string) => {
        if (!sb()) return '';
        const o = offerOf(p.id);
        const parts: string[] = [];
        const base = sb()!.grossOf(p).gross;
        const bump = extraProduct(o?.bump_product_id, p);
        if (bump) {
          const g = sb()!.grossOf(bump).gross;
          const title = o?.bump_title || `Ja, „${bump.name}“ für ${money(g, bump.currency)} dazunehmen`;
          const text = o?.bump_text || bump.description || '';
          parts.push(
            `<label class="check" style="border:2px dashed var(--brand);border-radius:10px;padding:12px 14px;margin:16px 0 0;background:#fffbea"><input type="checkbox" name="bump" value="1" data-bump="${g}"> <span><strong>${escapeHtml(title)}</strong>${text ? `<br><span class="muted" style="font-size:14px;font-weight:400">${escapeHtml(text)}</span>` : ''}</span></label>`,
          );
        }
        const coupons = !p.recurring && db.get('SELECT 1 AS x FROM buy_coupons WHERE product_id = ? AND active = 1 LIMIT 1', p.id);
        if (coupons) {
          parts.push(
            `<details style="margin:14px 0 0"><summary style="cursor:pointer;color:var(--muted);font-size:14px">Rabattcode eingeben</summary><div class="row" style="align-items:center;margin-top:8px"><input name="coupon" autocomplete="off" placeholder="Code" style="text-transform:uppercase"><button type="button" class="btn secondary" data-coupon style="flex:0 0 auto">Einlösen</button></div><div data-coupon-msg style="font-size:14px;margin-top:6px"></div></details>`,
          );
        } else if (o?.stripe_promo) {
          parts.push(`<p class="muted" style="font-size:13px;margin:12px 0 0">Gutscheincode? Den gibst du gleich auf der Bezahlseite ein.</p>`);
        }
        if (!bump && !coupons) return parts.join('');
        parts.push(`<p style="margin:14px 0 12px;font-size:15px">Gesamt: <strong data-total>${escapeHtml(money(base, p.currency))}</strong><span data-saved class="muted" style="font-size:13px"></span></p>`);
        const cfg = { key, base, currency: p.currency };
        parts.push(`<script>(function(){
const C=${jsonForScript(cfg)},f=document.currentScript.closest('form'),fmt=(c)=>new Intl.NumberFormat('de-DE',{style:'currency',currency:C.currency}).format(c/100);
let disc=0;const bump=f.querySelector('[data-bump]'),msg=f.querySelector('[data-coupon-msg]'),code=f.querySelector('[name=coupon]');
const draw=()=>{f.querySelector('[data-total]').textContent=fmt(C.base-disc+(bump&&bump.checked?Number(bump.dataset.bump):0));f.querySelector('[data-saved]').textContent=disc?' (du sparst '+fmt(disc)+')':'';};
if(bump)bump.addEventListener('change',draw);
const btn=f.querySelector('[data-coupon]');
if(btn)btn.addEventListener('click',async()=>{msg.textContent='';disc=0;if(!code.value.trim()){draw();return;}
 try{const r=await fetch('/api/public/buy/'+encodeURIComponent(C.key)+'/coupon?code='+encodeURIComponent(code.value));const j=await r.json();
 if(j.ok){disc=j.discount_cents;msg.style.color='#047857';msg.textContent='✓ '+j.code+': '+j.label;}else{msg.style.color='#b91c1c';msg.textContent=j.error||'Code ungültig';}}catch(e){msg.textContent='Prüfen gerade nicht möglich';}
 draw();});
if(code)code.addEventListener('keydown',(e)=>{if(e.key==='Enter'){e.preventDefault();btn.click();}});
})();</script>`);
        return parts.join('');
      },
    ];

    router.get('/api/public/buy/:key/coupon', 'public', (ctx) => {
      if (throttled(ctx.ip)) throw new HttpError(429, 'Zu viele Versuche – bitte kurz warten');
      const found = sb()?.resolveProduct(ctx.params.key);
      if (!found) throw notFound();
      const r = checkCoupon(found.p, ctx.query.get('code'));
      if ('error' in r) return { ok: false, error: r.error };
      const { unit } = discounted(found.p, r.coupon);
      const base = sb()!.grossOf(found.p).gross;
      if (unit < MIN_AMOUNT_CENTS) return { ok: false, error: 'Dieser Rabatt ist zu hoch für eine Online-Zahlung' };
      return { ok: true, code: r.coupon.code, label: couponLabel(r.coupon, found.p.currency), discount_cents: base - unit, total_cents: unit };
    });

    // --- Checkout: bump line, discount, saved card for the upsell ------------------------------
    app.services.buyCheckout = [
      ...(app.services.buyCheckout ?? []),
      (ctx: Ctx, { product: p, params, meta }: { product: any; params: Record<string, any>; meta: Record<string, any> }) => {
        if (!sb()) return;
        const o = offerOf(p.id);
        const body = ctx.body ?? {};
        const code = normCode(body.coupon);
        if (code) {
          const r = checkCoupon(p, code);
          if ('error' in r) throw bad(r.error);
          const { disc, unit } = discounted(p, r.coupon);
          if (unit < MIN_AMOUNT_CENTS) throw bad('Dieser Rabatt ist zu hoch für eine Online-Zahlung');
          const line = params.line_items[0];
          const label = couponLabel(r.coupon, p.currency);
          line.price_data.unit_amount = unit;
          line.price_data.product_data.description = [line.price_data.product_data.description, `Rabattcode ${r.coupon.code}: ${label}`].filter(Boolean).join(' · ').slice(0, 500);
          Object.assign(meta, { coupon_code: r.coupon.code, coupon_net_cents: disc, coupon_label: label });
          if (r.coupon.max_uses) {
            // the use is held from now on (see heldUses); the page expires so an abandoned purchase frees it again
            const hold = token(12);
            meta.coupon_hold = hold;
            if (!making.has(r.coupon.id)) making.set(r.coupon.id, new Map());
            making.get(r.coupon.id)!.set(hold, Date.now() + 2 * 60_000);
            params.expires_at = Math.floor(Date.now() / 1000) + 31 * 60;
          }
        } else if (o?.stripe_promo) params.allow_promotion_codes = true;

        const bump = extraProduct(o?.bump_product_id, p);
        if (bump && (body.bump === '1' || body.bump === 'on' || body.bump === true)) {
          const { tax, gross } = sb()!.grossOf(bump);
          const description = [bump.description, tax ? `inkl. ${String(tax).replace('.', ',')} % USt.` : ''].filter(Boolean).join(' · ').slice(0, 500) || undefined;
          params.line_items.push(...lineItemParams([{ name: bump.name, description, unit_amount: gross, quantity: 1 }], bump.currency));
          Object.assign(meta, {
            bump_product_id: bump.id,
            bump_name: String(bump.name).slice(0, 200),
            bump_price_cents: bump.price_cents,
            bump_tax_rate: tax,
            bump_tag: sb()!.tagOf(bump, sb()!.linkOf(bump.id)).slice(0, 200),
          });
        }

        if (params.mode === 'payment' && extraProduct(o?.upsell_product_id, p)) {
          params.payment_intent_data = { ...(params.payment_intent_data ?? {}), setup_future_usage: 'off_session' };
          params.customer_creation = 'always';
          meta.upsell = '1';
        }
      },
    ];

    // --- invoice: bump and discount lines ---------------------------------------------------
    app.services.buyInvoiceItems = [
      ...(app.services.buyInvoiceItems ?? []),
      (_locationId: string, session: any, items: any[]) => {
        const md = session.metadata ?? {};
        const main = items[0];
        const out = [...items];
        const net = Number(md.coupon_net_cents);
        if (md.coupon_code && net) out.push({ name: `Rabatt (${md.coupon_code})`, description: String(md.coupon_label ?? ''), qty: 1, price_cents: net, tax_rate: main.tax_rate });
        else {
          const d = Number(session.total_details?.amount_discount ?? 0);
          if (d > 0) out.push({ name: 'Gutschein (Stripe)', description: '', qty: 1, price_cents: netForGross(-d, main.tax_rate), tax_rate: main.tax_rate });
        }
        if (md.bump_product_id) {
          const b = db.get('SELECT description FROM products WHERE id = ?', md.bump_product_id);
          out.push({ name: String(md.bump_name || 'Zusatzprodukt'), description: b?.description ?? '', qty: 1, price_cents: Number(md.bump_price_cents) || 0, tax_rate: Number(md.bump_tax_rate) || 0 });
        }
        return out;
      },
    ];

    // The bump is a purchase of its own (tag, workflows); codes count their uses.
    app.events.on('product.purchased', (e) => {
      const d = e.data;
      const md = d.metadata ?? {};
      if (d.via) return;
      if (md.coupon_code) db.run('UPDATE buy_coupons SET uses = uses + 1 WHERE product_id = ? AND code = ?', md.product_id, md.coupon_code);
      if (!md.bump_product_id) return;
      const b = db.get('SELECT * FROM products WHERE id = ? AND location_id = ?', md.bump_product_id, e.locationId);
      const name = String(b?.name ?? md.bump_name ?? 'Zusatzprodukt');
      const tag = String(md.bump_tag || (sb() && b ? sb()!.tagOf(b, sb()!.linkOf(b.id)) : ''));
      const amount = grossOfNet(Number(md.bump_price_cents) || 0, Number(md.bump_tax_rate) || 0);
      if (d.contactId) {
        if (tag) addTags(app, e.locationId, d.contactId, [tag]);
        logActivity(app, e.locationId, d.contactId, 'product.purchased', `Gekauft (Order-Bump): ${name} (${money(amount, d.currency)})`);
      }
      app.events.emit(e.locationId, 'product.purchased', {
        contactId: d.contactId,
        productId: md.bump_product_id,
        product: { id: md.bump_product_id, name },
        invoiceId: d.invoiceId,
        amount_cents: amount,
        currency: d.currency,
        tag,
        sessionId: d.sessionId,
        metadata: md.ab ? { ab: md.ab } : {},
        via: 'order_bump',
      });
    });

    // --- one-click upsell ---------------------------------------------------------------------
    app.services.buyAfterPaid = [
      ...(app.services.buyAfterPaid ?? []),
      (ctx: Ctx, { checkout }: { checkout: any }) => {
        const md = checkout?.meta ?? {};
        if (!checkout || md.upsell !== '1' || md.upsell_of || checkout.mode !== 'payment') return undefined;
        let u = db.get('SELECT * FROM buy_upsells WHERE checkout_id = ?', checkout.id);
        if (!u) {
          const main = db.get('SELECT * FROM products WHERE id = ? AND location_id = ?', checkout.product_id, checkout.location_id);
          const up = main ? extraProduct(offerOf(main.id)?.upsell_product_id, main) : undefined;
          if (!main || !up || !checkout.payment_intent) return undefined;
          u = {
            id: id(24),
            location_id: checkout.location_id,
            checkout_id: checkout.id,
            product_id: main.id,
            upsell_product_id: up.id,
            payment_intent: checkout.payment_intent,
            email: checkout.email ?? '',
            carry: md.ab ? { ab: md.ab } : {},
            continue_url: `${ctx.path}?session_id=${encodeURIComponent(checkout.id)}`,
            status: 'open',
            created_at: now(),
          };
          db.insert('buy_upsells', u);
        }
        return u.status === 'open' ? redirect(`/upsell/${u.id}`, 303) : undefined;
      },
    ];

    const getUpsell = (token: string) => parseJson(/^[A-Za-z0-9]{24}$/.test(token) ? db.get('SELECT * FROM buy_upsells WHERE id = ?', token) : undefined, ['carry']);
    const expired = (u: any) => Date.now() - new Date(u.created_at).getTime() > UPSELL_TTL_MS;
    const page = (title: string, body: string, status = 200) => html(publicPage({ title, body: `<div class="wrap" style="max-width:560px"><div class="card">${body}</div></div>` }), status);
    const gone = () => page('Nicht gefunden', '<h1>Nicht gefunden</h1><p class="muted">Dieses Angebot gibt es nicht (mehr).</p>', 404);

    router.get('/upsell/:token', 'public', (ctx) => {
      const u = getUpsell(ctx.params.token);
      if (!u) return gone();
      if (u.status !== 'open' || expired(u)) return redirect(u.continue_url, 303);
      const up = db.get('SELECT * FROM products WHERE id = ? AND location_id = ?', u.upsell_product_id, u.location_id);
      const o = offerOf(u.product_id) ?? {};
      if (!up || !sb()) return redirect(u.continue_url, 303);
      const loc = app.location(u.location_id)!;
      const { tax, gross } = sb()!.grossOf(up);
      const small = !!loc.settings.invoices?.small_business;
      const t = escapeHtml(u.id);
      return page(
        o.upsell_title || up.name,
        `<p class="ok" style="margin:0 0 18px">✓ Danke, deine Bestellung ist eingegangen.</p>
  <p class="muted" style="margin:0 0 4px;text-transform:uppercase;font-size:12px;letter-spacing:.06em">Nur jetzt – passend dazu</p>
  <h1>${escapeHtml(o.upsell_title || up.name)}</h1>
  ${o.upsell_text || up.description ? `<p>${escapeHtml(o.upsell_text || up.description).replace(/\n/g, '<br>')}</p>` : ''}
  <p style="font-size:28px;font-weight:700;margin:18px 0 2px">${escapeHtml(money(gross, up.currency))}</p>
  <p class="muted" style="font-size:13px;margin-top:0">${small ? 'Gemäß § 19 UStG ohne Umsatzsteuer' : tax ? `inkl. ${String(tax).replace('.', ',')} % USt.` : ''}</p>
  <form method="post" action="/upsell/${t}/accept"><button type="submit" style="width:100%">Ja, hinzufügen – ${escapeHtml(money(gross, up.currency))}</button></form>
  <p class="muted" style="font-size:12px;text-align:center">Mit einem Klick, über die eben genutzte Zahlungsart. Du bekommst eine eigene Rechnung.</p>
  <form method="post" action="/upsell/${t}/decline" style="text-align:center"><button type="submit" class="btn secondary" style="background:none;border:0;color:var(--muted);text-decoration:underline;font-weight:400">Nein danke, weiter</button></form>`,
      );
    });

    router.post('/upsell/:token/decline', 'public', (ctx) => {
      const u = getUpsell(ctx.params.token);
      if (!u) return gone();
      db.run(`UPDATE buy_upsells SET status = 'declined', done_at = ? WHERE id = ? AND status = 'open'`, now(), u.id);
      return redirect(u.continue_url, 303);
    });

    router.post('/upsell/:token/accept', 'public', async (ctx) => {
      const u = getUpsell(ctx.params.token);
      if (!u) return gone();
      if (u.status !== 'open') return redirect(u.continue_url, 303);
      if (expired(u)) {
        db.run(`UPDATE buy_upsells SET status = 'expired', done_at = ? WHERE id = ? AND status = 'open'`, now(), u.id);
        return redirect(u.continue_url, 303);
      }
      // Only one click charges: whoever flips the status first goes on.
      if (!db.run(`UPDATE buy_upsells SET status = 'processing' WHERE id = ? AND status = 'open'`, u.id).changes) return redirect(u.continue_url, 303);
      const set = (patch: Record<string, any>) => db.update('buy_upsells', u.id, patch);
      const stripe = sb();
      const key = stripe?.secretKey(u.location_id) ?? '';
      const up = db.get('SELECT * FROM products WHERE id = ? AND location_id = ? AND active = 1', u.upsell_product_id, u.location_id);
      if (!stripe || !key || !up) {
        set({ status: 'failed', error: 'Stripe oder Produkt nicht verfügbar', done_at: now() });
        return redirect(u.continue_url, 303);
      }
      const { tax, gross } = stripe.grossOf(up);
      const meta: Record<string, any> = {
        location_id: u.location_id,
        product_id: up.id,
        product_name: String(up.name).slice(0, 200),
        price_cents: up.price_cents,
        tax_rate: tax,
        qty: 1,
        tag: stripe.tagOf(up, stripe.linkOf(up.id)).slice(0, 200),
        upsell_of: u.checkout_id,
        ...(u.carry ?? {}),
      };
      let customer = '';
      try {
        const first = await stripeRequest(key, 'GET', `/v1/payment_intents/${encodeURIComponent(u.payment_intent)}`);
        customer = String(typeof first.customer === 'string' ? first.customer : (first.customer?.id ?? ''));
        const method = String(typeof first.payment_method === 'string' ? first.payment_method : (first.payment_method?.id ?? ''));
        if (!customer || !method) throw new StripeError(402, 'Keine gespeicherte Zahlungsart', 'no_saved_method');
        const pi = await stripeRequest(
          key,
          'POST',
          '/v1/payment_intents',
          { amount: gross, currency: String(up.currency).toLowerCase(), customer, payment_method: method, off_session: true, confirm: true, description: String(up.name).slice(0, 200), metadata: meta },
          { idempotencyKey: `upsell-${u.id}` },
        );
        if (pi.status === 'succeeded') {
          const r = completeUpsell(app, u, pi, meta);
          set({ status: 'accepted', upsell_payment_intent: pi.id, invoice_id: r?.invoiceId ?? null, done_at: now() });
          return redirect(u.continue_url, 303);
        }
        if (pi.status === 'processing') {
          set({ status: 'pending', upsell_payment_intent: pi.id });
          return page(
            'Danke!',
            `<h1>Danke!</h1><p>Die Zahlung für „${escapeHtml(up.name)}“ wird bearbeitet. Sobald sie bestätigt ist, bekommst du deine Rechnung per E-Mail.</p><p><a class="btn" href="${escapeHtml(u.continue_url)}">Weiter</a></p>`,
          );
        }
        // Needs the buyer (3-D Secure) or another card: cancel this attempt, go through Checkout.
        if (pi.id) await stripeRequest(key, 'POST', `/v1/payment_intents/${encodeURIComponent(pi.id)}/cancel`).catch(() => undefined);
        return await fallback(u, up, gross, meta, customer, key, `Status ${pi.status}`);
      } catch (e) {
        if (e instanceof StripeError && (e.status === 0 || e.status >= 500)) {
          // Stripe not reachable: try again later with the same idempotency key (never charges twice).
          set({ status: 'open', error: e.message });
          return page(
            'Gerade nicht möglich',
            `<h1>Gerade nicht möglich</h1><p class="muted">Stripe ist gerade nicht erreichbar. Bitte versuche es gleich noch einmal.</p><p><a class="btn" href="/upsell/${escapeHtml(u.id)}">Noch einmal</a> <a class="btn secondary" href="${escapeHtml(u.continue_url)}">Ohne weiter</a></p>`,
            502,
          );
        }
        return await fallback(u, up, gross, meta, customer, key, (e as Error).message);
      }
    });

    /** 3-D Secure, declined card, no saved method: a normal Checkout for the upsell product. */
    async function fallback(u: any, up: any, gross: number, meta: Record<string, any>, customer: string, key: string, reason: string) {
      const stripe = sb()!;
      const base = app.baseUrl();
      const upKey = stripe.linkOf(up.id)?.slug || up.id;
      try {
        const tax = Number(meta.tax_rate) || 0;
        const session = await stripeRequest(
          key,
          'POST',
          '/v1/checkout/sessions',
          {
            mode: 'payment',
            line_items: lineItemParams(
              [{ name: up.name, description: [up.description, tax ? `inkl. ${String(tax).replace('.', ',')} % USt.` : ''].filter(Boolean).join(' · ').slice(0, 500) || undefined, unit_amount: gross, quantity: 1 }],
              up.currency,
            ),
            ...(customer ? { customer } : /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(u.email) ? { customer_email: u.email } : {}),
            client_reference_id: up.id,
            success_url: `${base}/buy/${encodeURIComponent(upKey)}/danke?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${base}${u.continue_url}`,
            metadata: meta,
            payment_intent_data: { metadata: { location_id: u.location_id, product_id: up.id }, description: String(up.name).slice(0, 200) },
          },
          { idempotencyKey: `upsell-fallback-${u.id}` },
        );
        if (!session?.url) throw new Error('Stripe hat keine Bezahlseite geliefert');
        stripe.recordCheckout({ id: session.id, location_id: u.location_id, product_id: up.id, url: session.url, amount_cents: gross, currency: up.currency, email: u.email, meta });
        db.update('buy_upsells', u.id, { status: 'fallback', fallback_session: session.id, error: String(reason).slice(0, 300) });
        return redirect(session.url, 303);
      } catch (e) {
        db.update('buy_upsells', u.id, { status: 'failed', error: String((e as Error).message).slice(0, 300), done_at: now() });
        return page('Nicht möglich', `<h1>Hat leider nicht geklappt</h1><p class="muted">${escapeHtml((e as Error).message)}</p><p><a class="btn" href="${escapeHtml(u.continue_url)}">Weiter</a></p>`, 400);
      }
    }

    // SEPA and other delayed methods: check pending upsell payments now and then.
    let checked = 0;
    app.onTick(async () => {
      if (Date.now() - checked < 10 * 60_000) return;
      checked = Date.now();
      for (const u of db.all(`SELECT * FROM buy_upsells WHERE status = 'pending' LIMIT 50`)) {
        const key = sb()?.secretKey(u.location_id);
        if (!key || !u.upsell_payment_intent) continue;
        try {
          const pi = await stripeRequest(key, 'GET', `/v1/payment_intents/${encodeURIComponent(u.upsell_payment_intent)}`);
          if (pi.status === 'succeeded') {
            const r = completeUpsell(app, parseJson(u, ['carry']), pi, pi.metadata ?? {});
            db.update('buy_upsells', u.id, { status: 'accepted', invoice_id: r?.invoiceId ?? null, done_at: now(), checked_at: now() });
          } else if (pi.status === 'canceled' || pi.status === 'requires_payment_method' || Date.now() - new Date(u.created_at).getTime() > 14 * 864e5) {
            db.update('buy_upsells', u.id, { status: 'failed', error: `Status ${pi.status}`, done_at: now(), checked_at: now() });
          } else db.update('buy_upsells', u.id, { checked_at: now() });
        } catch (e) {
          console.error('[buy-offers] Upsell prüfen', (e as Error).message);
        }
      }
    });

    // --- settings (Kauf-Link dialog) ----------------------------------------------------------
    const productOr404 = (ctx: Ctx) => {
      const p = db.get('SELECT * FROM products WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!p) throw notFound('Produkt nicht gefunden');
      return p;
    };
    const offerOut = (p: any) => {
      const o = offerOf(p.id);
      const stats = db.get(`SELECT COUNT(*) AS offered, SUM(status = 'accepted') AS accepted, SUM(status = 'declined') AS declined, SUM(status = 'fallback') AS fallback FROM buy_upsells WHERE product_id = ?`, p.id)!;
      return {
        product_id: p.id,
        bump_product_id: o?.bump_product_id ?? '',
        bump_title: o?.bump_title ?? '',
        bump_text: o?.bump_text ?? '',
        upsell_product_id: o?.upsell_product_id ?? '',
        upsell_title: o?.upsell_title ?? '',
        upsell_text: o?.upsell_text ?? '',
        stripe_promo: !!o?.stripe_promo,
        coupons: db.all('SELECT id, code, kind, value, max_uses, uses, expires_at, active, created_at FROM buy_coupons WHERE product_id = ? ORDER BY created_at', p.id).map((c) => ({ ...c, active: !!c.active })),
        upsells: { offered: Number(stats.offered) || 0, accepted: Number(stats.accepted) || 0, declined: Number(stats.declined) || 0, fallback: Number(stats.fallback) || 0 },
      };
    };

    router.get('/api/buy-offers/:id', 'location', (ctx) => offerOut(productOr404(ctx)));
    router.put('/api/buy-offers/:id', 'location', (ctx) => {
      const p = productOr404(ctx);
      const b = ctx.body ?? {};
      const pick = (field: string, label: string) => {
        const pid = str(b[field], label, { max: 40 });
        if (!pid) return null;
        const x = db.get('SELECT * FROM products WHERE id = ? AND location_id = ?', pid, ctx.locationId);
        if (!x) throw bad(`${label}: Produkt nicht gefunden`);
        if (x.id === p.id) throw bad(`${label}: bitte ein anderes Produkt wählen`);
        if (x.recurring) throw bad(`${label}: nur Einmal-Produkte (kein Abo)`);
        if (x.currency !== p.currency) throw bad(`${label}: gleiche Währung wie das Produkt nötig`);
        return x.id;
      };
      const bump = pick('bump_product_id', 'Order-Bump');
      const upsell = pick('upsell_product_id', 'Upsell');
      if (upsell && p.recurring) throw bad('Upsell: geht nur nach Einmalkäufen (nicht nach Abos)');
      const row = {
        product_id: p.id,
        location_id: ctx.locationId,
        bump_product_id: bump,
        bump_title: str(b.bump_title, 'Bump-Überschrift', { max: 200 }),
        bump_text: str(b.bump_text, 'Bump-Text', { max: 600 }),
        upsell_product_id: upsell,
        upsell_title: str(b.upsell_title, 'Upsell-Überschrift', { max: 200 }),
        upsell_text: str(b.upsell_text, 'Upsell-Text', { max: 2000 }),
        stripe_promo: b.stripe_promo ? 1 : 0,
        updated_at: now(),
      };
      db.run('DELETE FROM buy_offers WHERE product_id = ?', p.id);
      db.insert('buy_offers', row);
      return offerOut(p);
    });
    router.post('/api/buy-offers/:id/coupons', 'location', (ctx) => {
      const p = productOr404(ctx);
      if (p.recurring) throw bad('Rabattcodes gehen nur für Einmal-Produkte – für Abos die Stripe-Gutscheine nutzen');
      const b = ctx.body ?? {};
      const code = normCode(b.code);
      if (!CODE.test(code)) throw bad('Code: 2–40 Zeichen, nur Buchstaben, Ziffern, - und _');
      const kind = b.kind === 'amount' ? 'amount' : 'percent';
      const value = Math.round(num(b.value, 0));
      if (kind === 'percent' && (value < 1 || value > 100)) throw bad('Rabatt: 1 bis 100 %');
      if (kind === 'amount' && value < 1) throw bad('Rabatt: Betrag fehlt');
      const maxUses = b.max_uses ? Math.round(num(b.max_uses, 0)) : null;
      if (maxUses !== null && maxUses < 1) throw bad('Höchstens: mindestens 1');
      const exp = b.expires_at ? new Date(b.expires_at) : null;
      if (exp && Number.isNaN(exp.getTime())) throw bad('Ablaufdatum ungültig');
      if (db.get('SELECT id FROM buy_coupons WHERE product_id = ? AND code = ?', p.id, code)) throw bad('Diesen Code gibt es schon');
      db.insert('buy_coupons', { id: id(), location_id: ctx.locationId, product_id: p.id, code, kind, value, max_uses: maxUses, expires_at: exp ? exp.toISOString() : null, active: 1, created_at: now() });
      return offerOut(p);
    });
    router.patch('/api/buy-coupons/:id', 'location', (ctx) => {
      const c = db.get('SELECT * FROM buy_coupons WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!c) throw notFound('Code nicht gefunden');
      if (ctx.body.active !== undefined) db.run('UPDATE buy_coupons SET active = ? WHERE id = ?', ctx.body.active ? 1 : 0, c.id);
      return offerOut(db.get('SELECT * FROM products WHERE id = ?', c.product_id));
    });
    router.delete('/api/buy-coupons/:id', 'location', (ctx) => {
      const c = db.get('SELECT * FROM buy_coupons WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!c) throw notFound('Code nicht gefunden');
      db.run('DELETE FROM buy_coupons WHERE id = ?', c.id);
      return offerOut(db.get('SELECT * FROM products WHERE id = ?', c.product_id));
    });
  },
};

interface StripeBuy {
  secretKey(locationId: string): string;
  resolveProduct(key: string): { p: any; link: any } | undefined;
  grossOf(p: any): { tax: number; gross: number };
  linkOf(productId: string): any;
  tagOf(p: any, link: any): string;
  completeProduct(locationId: string, session: any): { handled: string; invoiceId?: string | null; contactId?: string | null };
  recordCheckout(row: { id: string; location_id: string; product_id: string; url: string; amount_cents: number; currency: string; email?: string; meta: Record<string, any> }): void;
}

/** A paid off-session PaymentIntent → paid invoice, tag, product.purchased (through the Stripe module). */
function completeUpsell(app: App, u: any, pi: any, meta: Record<string, any>) {
  const stripe = app.services.stripeBuy as StripeBuy | undefined;
  if (!stripe) return undefined;
  return stripe.completeProduct(u.location_id, {
    id: pi.id,
    object: 'payment_intent',
    metadata: { ...meta, location_id: u.location_id },
    amount_total: Number(pi.amount_received ?? pi.amount ?? 0),
    currency: pi.currency,
    payment_intent: pi.id,
    customer_details: { email: u.email },
    mode: 'payment',
  });
}
