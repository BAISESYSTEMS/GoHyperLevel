import type { App, Module } from '../core/app.js';
import { escapeHtml } from '../core/template.js';
import { wrap, siteBlocks, type BlockEnv } from '../services/site-blocks.js';
import { miniMarkdown } from '../services/site-blocks.js';

/**
 * Product / checkout block for pages: shows a product of the sub-account (name, text, price including VAT, billing interval, a note on
 * VAT or § 19 UStG) with a button that leads to its buy page `/buy/<product>` – Stripe Checkout, order bump, discount codes, and the
 * checkout-law boxes (waiver, terms, the legally worded order button) all live there (modules/stripe.ts, buy-offers.ts, checkout-law.ts).
 * The block only links: the click itself is no order, so its text is "Zur Bestellung"; under the button it names the order button the
 * buyer will see on the next page. Links to the withdrawal information and the terms come from the legal pages of the sub-account.
 * The page the click came from travels as `fp` through the buy page into the Stripe metadata, so purchases count for their funnel step
 * (modules/site-analytics.ts).
 */

const CSS = `.pcard{max-width:520px;margin:0 auto;padding:1.5em;background:var(--c-bg);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--sh-md);text-align:left}.pcard.hl{border:2px solid var(--c-brand)}
.pcard .pbadge{display:inline-block;margin:0 0 .6em;padding:.15em .8em;border-radius:99px;background:var(--c-brand);color:var(--c-on-brand);font-size:.82em;font-weight:700}.pcard h3{margin:0 0 .3em;font-size:var(--fs-2)}.pcard .pdesc{margin:0 0 1em}
.pcard .pprice{font-size:var(--fs-3);font-weight:800;margin:0;line-height:1.1}.pcard .pprice span{font-size:.45em;font-weight:500;color:var(--muted)}.pcard .ptax{margin:.2em 0 1em;font-size:.85em;color:var(--muted)}
.pcard .pbump{margin:0 0 1em;padding:.6em .8em;border:1px dashed var(--c-brand);border-radius:var(--r-sm);font-size:.9em}.pcard .btn{width:100%}.pcard .plaw{margin:.9em 0 0;font-size:.8em;color:var(--muted)}.pcard .plaw a{color:inherit}`;

export const siteProductModule: Module = {
  name: 'site-product',
  register(app: App) {
    const { db } = app;
    const money = (cents: number, cur: string) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: String(cur || 'EUR').toUpperCase() }).format(cents / 100);

    /** Product, price and link of a product that can be bought from this page (own sub-account, active, link on). */
    function offer(env: BlockEnv, productId: string) {
      const sb = app.services.stripeBuy;
      if (!sb || !productId) return undefined;
      const found = sb.resolveProduct(productId);
      if (!found || found.p.location_id !== env.locationId) return undefined;
      const { tax, gross } = sb.grossOf(found.p);
      // Stripe, or (one-time products) another provider of the payment registry – modules/pay-registry.ts.
      const other = !found.p.recurring && (app.services.payRegistry?.ready(env.locationId) ?? []).some((x: string) => x !== 'stripe');
      return { p: found.p, link: found.link, tax: Number(tax), gross: Number(gross), stripe: !!sb.secretKey(env.locationId) || other };
    }

    /** What a buyer is told about extras on the buy page: an order bump and discount codes (read-only, tables may be missing). */
    function extras(productId: string, locationId: string) {
      try {
        const o = db.get('SELECT * FROM buy_offers WHERE product_id = ? AND location_id = ?', productId, locationId);
        const bump = o?.bump_product_id ? db.get('SELECT name, price_cents, currency, tax_rate FROM products WHERE id = ? AND location_id = ? AND active = 1', o.bump_product_id, locationId) : undefined;
        const coupons = !!db.get('SELECT 1 AS x FROM buy_coupons WHERE product_id = ? AND active = 1 LIMIT 1', productId);
        return { bump, bumpTitle: String(o?.bump_title ?? ''), coupons: coupons || !!o?.stripe_promo };
      } catch {
        return { bump: undefined, bumpTitle: '', coupons: false };
      }
    }

    siteBlocks(app).set('product', {
      type: 'product',
      css: CSS,
      render: (env, b, o) => {
        const of = offer(env, String(b.product_id ?? ''));
        if (!of || !of.stripe) {
          // Visitors see nothing for a product that cannot be bought; the editor says what is missing.
          if (!env.preview) return '';
          // No product chosen yet (template preview, fresh block): show how the card will look.
          if (!b.product_id) return wrap(env, b, o.bare, `<div class="pcard${b.highlight ? ' hl' : ''}">${b.badge ? `<span class="pbadge">${escapeHtml(String(b.badge))}</span>` : ''}<h3>${escapeHtml(String(b.heading || 'Dein Produkt'))}</h3><div class="pdesc"><p>Name, Beschreibung und Preis kommen aus deinem Produkt.</p></div><p class="pprice">99,00 €<span></span></p><p class="ptax">inkl. 19 % USt.</p><a class="btn" href="#">${escapeHtml(String(b.button_text || 'Zur Bestellung'))}</a><p class="plaw">Vorschau – wähle im Block ein Produkt.</p></div>`);
          return wrap(env, b, o.bare, `<p class="muted" style="text-align:center">${!b.product_id || b.product_id.includes('{{') ? 'Produkt wählen' : of ? 'Stripe ist noch nicht verbunden – erst dann ist der Kauf-Button sichtbar.' : 'Dieses Produkt gibt es nicht (mehr) oder der Kauf-Link ist aus.'}</p>`);
        }
        const { p, link, tax, gross } = of;
        const loc = app.location(env.locationId);
        const small = !!loc?.settings.invoices?.small_business;
        const per = p.recurring === 'month' ? ' / Monat' : p.recurring === 'year' ? ' / Jahr' : '';
        const key = encodeURIComponent(link?.slug || p.id);
        const fp = /^[A-Za-z0-9]{1,40}$/.test(String(env.page?.id ?? '')) ? `?fp=${env.page.id}` : '';
        const law = (loc?.settings.checkout_law ?? {}) as { enabled?: boolean; button_text?: string; terms_url?: string; withdrawal_url?: string };
        const profile = app.services.legalTexts?.profile?.(env.locationId) as { company?: string; email?: string; street?: string } | undefined;
        const hosted = !!profile?.company && (!!profile.email || !!profile.street);
        const widerruf = law.withdrawal_url || (hosted ? (app.services.legalTexts.hostedUrl(env.locationId, 'widerruf') as string) : '');
        const links = [widerruf ? `<a href="${escapeHtml(widerruf)}" target="_blank" rel="noopener">Informationen zum Widerrufsrecht</a>` : '', law.terms_url ? `<a href="${escapeHtml(law.terms_url)}" target="_blank" rel="noopener">AGB</a>` : ''].filter(Boolean);
        const ex = b.show_bump === false ? { bump: undefined, bumpTitle: '', coupons: false } : extras(p.id, env.locationId);
        // what the checkout charges for the bump (the same rule as for the product: no VAT outside the regular tax mode)
        const bumpGross = ex.bump ? Number(app.services.stripeBuy.grossOf({ ...ex.bump, location_id: env.locationId }).gross) : 0;
        const text = String(b.text || p.description || '');
        const label = app.services.buyButtonLabel?.(p, loc) as string | undefined;
        const body = `<div class="pcard${b.highlight ? ' hl' : ''}">${b.badge ? `<span class="pbadge">${escapeHtml(String(b.badge))}</span>` : ''}${b.heading === '' ? '' : `<h3>${escapeHtml(String(b.heading || p.name))}</h3>`}${text ? `<div class="pdesc">${miniMarkdown(text)}</div>` : ''}<p class="pprice">${escapeHtml(money(gross, p.currency))}<span>${per}</span></p><p class="ptax">${small ? 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.' : tax ? `inkl. ${String(tax).replace('.', ',')} % USt.` : 'Preis ohne Umsatzsteuer'}</p>${ex.bump ? `<p class="pbump">${escapeHtml(ex.bumpTitle || `Optional dazu: ${ex.bump.name} für ${money(bumpGross, ex.bump.currency)}`)}</p>` : ''}<a class="btn" href="${escapeHtml(`${app.baseUrl()}/buy/${key}${fp}`)}">${escapeHtml(String(b.button_text || 'Zur Bestellung'))}</a><p class="plaw">${label ? `Auf der nächsten Seite bestellst du verbindlich mit „${escapeHtml(label)}“. ` : ''}${ex.coupons ? 'Einen Rabattcode gibst du dort ein. ' : ''}${links.length ? `${links.join(' · ')}` : ''}</p></div>`;
        return wrap(env, b, o.bare, body);
      },
    });

    // The page a buy link was clicked on goes along as `fp` (hidden field of the buy page → Stripe metadata).
    app.services.buyPageHtml = [
      ...(app.services.buyPageHtml ?? []),
      (ctx: { query: URLSearchParams }) => {
        const fp = ctx.query.get('fp');
        return fp && /^[A-Za-z0-9]{1,40}$/.test(fp) ? `<input type="hidden" name="fp" value="${fp}">` : '';
      },
    ];
    app.services.buyCheckout = [
      ...(app.services.buyCheckout ?? []),
      (ctx: { body?: Record<string, any> }, { meta }: { meta: Record<string, any> }) => {
        const fp = ctx.body?.fp;
        if (typeof fp === 'string' && /^[A-Za-z0-9]{1,40}$/.test(fp)) meta.fp = fp;
      },
    ];
  },
};
