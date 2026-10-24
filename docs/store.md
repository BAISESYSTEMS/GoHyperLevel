# Online store and gift cards

**Umsatz → Online-Shop** sells your products with a cart: products with variants and stock, collections, a product list and a product detail block for your website, a checkout that is an order form on the page (address, shipping method, tax, gift card, payment), and orders that become **paid invoices with a gap-free number**, take the goods out of stock and start workflows. **Umsatz → Gutscheine** issues gift cards that are redeemed in the store, on invoices and in bookings. Money is taken through Stripe, PayPal or Mollie ([payment-providers.md](payment-providers.md)).

- [Setting up](#setting-up)
- [Products, variants and stock](#products-variants-and-stock)
- [On your website: the blocks](#on-your-website-the-blocks)
- [Cart and checkout](#cart-and-checkout)
- [Shipping](#shipping)
- [Tax (DE/EU)](#tax-deeu)
- [Orders](#orders)
- [Packing slips](#packing-slips)
- [Abandoned carts](#abandoned-carts)
- [Gift cards](#gift-cards)
- [Single-use discount codes](#single-use-discount-codes)
- [Loyalty points](#loyalty-points)
- [Snapshots and DSGVO](#snapshots-and-dsgvo)
- [MCP tools](#mcp-tools)
- [API](#api)
- [For developers](#for-developers)
- [Limits](#limits)

## Setting up

1. Connect at least one payment provider (*Einstellungen → Stripe & Zahlungen*).
2. *Online-Shop → Einstellungen*: switch the store on, give it a name and a short name (`/store/<kurzname>/checkout`), pick the **delivery countries** and the **shipping rates**.
3. *Online-Shop → Produkte*: publish products (the products of *Umsatz → Produkte*). Variants and stock come from *Lager & Einkauf*.
4. Put the blocks **Shop: Produktliste** and **Shop: Produktdetail** on a page of your website (*Funnels & Websites*).
5. For the legal parts of the checkout set the terms address and the withdrawal information under *Einwilligung & Recht → Kaufseite* – the checkout uses the same order-button wording and links as the buy pages ([consent.md](consent.md)).

## Products, variants and stock

A store product **is a CRM product** (name, description, net price, VAT rate) with store fields: published, kind, images, weight, collections, position, *sell when out of stock*. Kinds:

| Kind | Shipping | Tax |
| --- | --- | --- |
| *Ware* (physical) | yes, weight counts for weight-based rates | product rate |
| *Digital* | no | product rate |
| *Gutschein* (gift card) | no | none when sold – see [gift cards](#gift-cards) |

**Variants reuse the inventory:** link an article to the product in *Lager & Einkauf* and add variants to it (size, colour …; each with its SKU and stock). The store shows them as a choice, with *ausverkauft* for variants without stock (unless *sell when out of stock*). A variant can have its own net price; otherwise it costs the product price. Without articles the product has no stock limit. Subscription products stay on buy links (Stripe subscription) and cannot be put in the cart.

**Collections** group products; the product list block shows one collection (by its short name) or all products.

## On your website: the blocks

| Block | Shows |
| --- | --- |
| **Shop: Produktliste** | A grid of published products (optionally one collection, 2–4 columns, a maximum): image, name, price (gross, *ab …* when variants differ), *inkl. … % USt., zzgl. Versand*, a variant choice and *In den Warenkorb*. With *Seite mit dem Block „Shop: Produktdetail“* each card links to that page with `?product=<kurzname>`. |
| **Shop: Produktdetail** | One product (chosen in the block, or the one the list links to – one detail page for all products): images, price, VAT note, stock hint, description, variants, quantity, *In den Warenkorb*. |

The buttons are plain forms to the store's checkout (`/store/<kurzname>/checkout?add_product=…&add_variant=…&qty=…`), so they work on sandboxed website pages and without JavaScript on the page.

## Cart and checkout

The checkout page (`/store/<kurzname>/checkout`) is one page: the **cart** (change quantities, remove lines), the buyer's details and **address**, the **shipping method**, a **gift-card code**, the **payment method**, the terms box and the order button (*Zahlungspflichtig bestellen* – the wording of *Einwilligung & Recht*). Prices, shipping, VAT and the total are quoted live by the server.

The cart lives in the browser (**localStorage**) and on the server (a **cart session** per browser token) – so a recovery link (`?cart=<token>`) brings it back on another device, and an abandoned cart with an e-mail can be reminded. Ordering creates the order, then sends the buyer to the provider; back from it, the **order page** (`/store/<kurzname>/order/<token>`) shows the status, the lines, the tracking number once shipped and the invoice.

## Shipping

Shipping rates (*Einstellungen → Versandarten*), prices gross:

- **flat** – one price, or **by weight** – tiers *up to … g* (a parcel heavier than the last tier cannot use the rate);
- per **country** (empty = every delivery country), **free above** a goods value, a delivery time text.

The buyer picks among the rates that serve their country. On the invoice shipping is an ancillary service and **shares the VAT of the goods**: with goods at 19 % and 7 % in one parcel the shipping price is split by the goods' net value per rate (German practice). The split is nudged by a cent where needed so the invoice total is exactly the goods plus the shipping price the buyer saw.

## Tax (DE/EU)

The order's tax treatment comes from the existing invoice tax modes ([invoicing.md](invoicing.md#fields-of-an-invoice)):

| Case | Treatment |
| --- | --- |
| *Kleinunternehmer* (§ 19 UStG) in the invoice settings | no VAT, with the § 19 note |
| Physical goods to a country **outside the EU** | *Ausfuhrlieferung* (0 %, export note) |
| A **business** in another EU country with a valid VAT ID (format check), goods, and your own VAT ID set | *innergemeinschaftliche Lieferung* (0 %, both VAT IDs on the invoice) |
| Everything else (Germany, EU consumers, digital products) | your rates per product (19 % / 7 %) |

> **OSS:** sales to consumers in other EU countries are taxed with the German rates. Above the EU-wide threshold of 10,000 € a year (§ 3c UStG) the destination country's rates apply and are declared through the One-Stop-Shop – HyperLevel does not switch the rates per country; ask your tax advisor and adjust the rates if you are above it.

## Orders

*Online-Shop → Bestellungen* lists the orders with payment state (*Zahlung offen, Bezahlt, Abgebrochen, Erstattet*) and fulfilment (*Offen, In Bearbeitung, Versendet, Zugestellt, Storniert*). When an order is paid:

1. a **paid invoice** is written and **finalised** (number from the invoice range, frozen – GoBD, [invoicing.md](invoicing.md)); the gift-card part and the provider's part are booked as payments. If the invoice cannot be finalised (e.g. *Streng prüfen* blocks), the order is still paid, the invoice stays a draft and the team is told;
2. the goods leave **stock** (one goods issue per invoice and article through *Lager & Einkauf* – the SKU is on the invoice line);
3. sold **gift cards** are issued and mailed;
4. the buyer gets the **confirmation with the invoice** (PDF as configured for invoices), the team an optional notification;
5. the workflow trigger **Shop: Bestellung bezahlt** starts (*Shop: Bestellung aufgegeben* started when the order was placed).

**Shipping an order:** pick the carrier (DHL, DPD, Hermes, GLS, UPS, Österreichische Post, other), enter the **tracking number** and *Als versendet markieren*: the tracking link is built for the carrier, the buyer gets a **mail with the tracking link** (switch off per order), and **Shop: Bestellung versendet** starts. **Refund** sends the money back through the provider (and the gift-card part onto the card), switches off unused gift cards the order sold and fires `payment.refunded`; the invoice stays – write a credit note or Stornorechnung for the VAT.

| Trigger | Event data |
| --- | --- |
| `store.order_placed` | `order.number`, `order.total_cents`, `order.items`, `order.status_url`, `productIds` (filter *Nur mit Produkt*) |
| `store.order_paid` | as above plus `invoiceId`, `provider` |
| `store.order_shipped` | `order.carrier_label`, `order.tracking_number`, `order.tracking_url` |

## Packing slips

In an order (*Bestellungen* → order, paid): **Packzettel** opens a PDF to print – sender, delivery address, order number and date,
shipping method, the lines with quantity, variant and article number and a tick box, the number of parts and the buyer's note; no
prices. *Abgebrochene Warenkörbe → Packzettel aller offenen Bestellungen* prints one page per paid order that is not shipped yet
(oldest first, up to 200). API: `GET /api/store/orders/:id/packing-slip`, `GET /api/store/packing-slips?open=1` or `?ids=a,b`.

**Pickup in store:** add a shipping rate with the price 0 and a name such as *Abholung im Laden* (delivery text: address and opening
hours) – the buyer picks it at the checkout and it shows on the packing slip; mark the order *Zugestellt* when it is collected.

## Abandoned carts

A cart with an e-mail (typed at the checkout) and no paid order after *Warenkorbabbruch nach* minutes (default 60) fires the **existing trigger `checkout.abandoned`** – the same as an expired Stripe checkout ([email-marketing.md](email-marketing.md#abandoned-cart)): the contact gets the tag `warenkorbabbruch`, the event carries `product_name`, `amount_cents` and `recovery_url` (the checkout with the cart). It fires once per cart, not for people who ordered meanwhile, and creates contacts for unknown addresses only when that is allowed under *Kampagnen → Zustellbarkeit*. A paid order removes the tag. Reminder mails are marketing and need consent, as always.

**Online-Shop → Abgebrochene Warenkörbe** lists the carts of the last 7/30/90 days with an e-mail address and no paid order of that
address since: contact, items, net value, whether the reminder already ran, and the link that restores the cart (to send by hand).
API `GET /api/store/abandoned?days=30` → `{count, value_cents, carts: [{email, contact_id, items, value_cents, reminded, recovery_url}]}`,
MCP `ghl_store_abandoned` (read only).

## Gift cards

*Umsatz → Gutscheine* – cards with a **code** (16 characters, no look-alike letters) and a **balance** kept in an **append-only ledger** (issue, redemption, refund, correction – database triggers forbid changing or deleting a line; corrections are new lines).

- **Issue** by hand (amount, optional expiry, recipient, message – the code can be mailed), or **sell** them in the store (product kind *Gutschein*: one card per unit sold, worth the price, mailed to the recipient the buyer names or to the buyer; validity from *Gutscheine gültig* in the store settings, 0 = no expiry).
- **Redeem** in the **store checkout**, on **invoices** (the pay page of an invoice, or *redeem* by hand with `invoice_id`), and in **booking payments** (the pay page of a paid booking). The amount is **held** on the card while the payment is running – two checkouts cannot spend the same balance – and committed when the payment is complete, released when it lapses. A rest too small for a provider (below 0,50 €) is avoided by taking a little less from the card.
- **Expiry is optional.** Expired and blocked cards cannot be redeemed; the balance stays visible.

> **VAT – multi-purpose vouchers (Mehrzweck-Gutscheine, § 3 Abs. 15 UStG).** HyperLevel treats every gift card as a *multi-purpose voucher*: it can be spent on goods and services with different VAT rates, so its sale is **not yet a taxable supply** – the invoice of a sold gift card shows it at 0 % with the note *die Umsatzsteuer entsteht erst bei der Einlösung (§ 3 Abs. 15 UStG)*. **VAT arises when the card is redeemed**: the order or invoice paid with it shows the goods with their full VAT, and the gift card is booked as a means of payment (*Gutschein*), not as a discount. *Single-purpose vouchers* (Einzweck-Gutscheine, § 3 Abs. 14 UStG – place and VAT known at the sale, taxed when sold) are not offered. The outstanding balance of unredeemed cards is a liability in the books. Not tax advice – check the treatment of your vouchers with your tax advisor.

## Single-use discount codes

Personal codes that work **once** on the buy page of a one-off product (*Produkt → Kaufseite*) – for a birthday mail, a win-back
series or a campaign with a code per person:

- **Workflow step** *Einmal-Rabattcode erstellen* (`coupon_create`): product, percent or amount (cents, gross), validity in days
  (default 30, 0 = no expiry), optional prefix. The code (e.g. `DANKE-7KQ2M9XA`, no look-alike letters) is in `{{var.coupon_code}}`
  and the expiry date in `{{var.coupon_expires}}` for the next step (e.g. *E-Mail senden*). The contact's timeline notes it.
- **In bulk:** `POST /api/coupon-codes` `{product_id, kind: percent|amount, value, valid_days?, prefix?, count (1–500), contact_id?}`
  → `{codes, expires_at}`; `GET /api/coupon-codes?product_id=` lists the issued codes with contact, source and whether they were used.
  **MCP:** `ghl_coupon_create`.
- Each code is an ordinary discount code of the buy page with *höchstens 1×*: the buy page checks, holds it while the buyer pays and
  counts the use as for any code ([buy-offers](stripe.md)). The store's cart takes gift cards, not discount codes (see Limits).

## Loyalty points

*Umsatz → Gutscheine → Treuepunkte* (off until switched on): customers collect points with **every paid invoice** – store orders,
buy links, paid bookings and normal invoices alike (`invoice.paid`, once per invoice; quotes and credit notes do not count).

- **Points per euro** of the invoice total (default 1). **Tiers** (default Bronze 0, Silber 500, Gold 2000) go by the points
  collected in total – spending points never costs the tier. **Rewards** (folded in Einfach-Modus): a number of points for a
  **single-use discount code** on a one-off product (percent or amount, valid 90 days – see above) or a **gift card** of a value.
- **Redeem** for a contact with `POST /api/loyalty/contacts/:id/redeem` `{reward_id}` (or the agent): the points are taken off and
  the code comes back to pass on. Correct by hand with `…/adjust` `{points, reason}`; the balance never drops below 0.
- **Workflows:** triggers **Treuepunkte gutgeschrieben** (`loyalty.points_earned`: `points`, `balance`, `lifetime`, `tier`, `reason`)
  and **Treue-Stufe erreicht** (`loyalty.tier_reached`: `tier`, `previous`; filter by tier), step **Treuepunkte gutschreiben**
  (`loyalty_points`, sets `var.loyalty_balance`) – e.g. points for a review or a referral.
- **API** (area payments): `GET/PUT /api/loyalty/settings` (`{enabled, points_per_euro, tiers: [{name, min_points}], rewards: [{id,
  name, points, kind: coupon|gift_card, product_id?, coupon_kind?, value}]}`), `GET /api/loyalty/contacts/:id` (balance, lifetime,
  tier, next tier, rewards, ledger), `POST …/adjust`, `POST …/redeem`, `GET /api/loyalty/members`. **MCP:** `ghl_loyalty_contact`,
  `ghl_loyalty_adjust`. The ledger belongs to the contact (exported and erased with it).
- **Limits:** no points page in the customer portal yet, no expiry of points, refunds do not take points back automatically (correct
  by hand).

## Snapshots and DSGVO

**Snapshots** (and copying a sub-account) take the store settings (switched off, without the short name), the collections and the products' store fields (published, kind, images, weight, collections) – the products themselves are already in snapshots. Orders, carts and gift cards are customer data and stay behind.

**DSGVO:** the export of a contact contains its orders (`store_orders`), carts and gift cards (also cards where the person is the recipient). Erasing a contact keeps the orders as business records (amounts, invoice link, country) but removes name, e-mail, phone, address and notes from them, deletes the carts and unlinks the gift cards (the money stays on the card; the person's data as a recipient goes). The invoices stay as the law requires ([security.md](security.md)).

## MCP tools

| Tool | |
| --- | --- |
| `ghl_store_orders` | Orders with status, fulfilment, tracking; filters `status`, `fulfilment` (`open` = paid and not shipped), `q` |
| `ghl_store_order_status` | One order (payment, invoice, gift cards); with `fulfilment`, `carrier`, `tracking_number` it sets the shipping status – `shipped` mails the buyer (`notify: false` without mail) |
| `ghl_gift_card_create` | Issues a gift card (`amount_cents`, `expires_at`, `recipient_*`, `message`, `send`) |
| `ghl_store_abandoned` | Abandoned carts with value and recovery link (read only) |
| `ghl_coupon_create` | Single-use discount codes for a buy page |
| `ghl_loyalty_contact` / `ghl_loyalty_adjust` | Loyalty balance, tier and rewards of a contact / give or take points, redeem a reward |

## API

| Endpoint | |
| --- | --- |
| `GET/PUT /api/store/settings` | Settings (`enabled`, `name`, `slug`, `countries`, `shipping`, `order_prefix`, `terms_required`, `abandon_minutes`, `gift_valid_months`, `notify_email`, `checkout_note`) with checkout URL and figures |
| `GET /api/store/products` · `PUT /api/store/products/:id` | The catalogue (products with store fields, variants and stock) · store fields of a product (`published`, `slug`, `kind`, `images`, `weight_g`, `collection_ids`, `variant_prices`, `position`, `allow_backorder`) |
| `GET/POST /api/store/collections` · `PATCH/DELETE /api/store/collections/:id` | Collections |
| `GET /api/store/orders?status=&fulfilment=&q=` · `GET/PATCH /api/store/orders/:id` | Orders · one order with payment, invoice and gift cards · fulfilment (`fulfilment`, `carrier`, `tracking_number`, `tracking_url`, `note`, `notify`) |
| `POST /api/store/orders/:id/refund` · `POST /api/store/orders/:id/resend` | Refund (whole, or `amount_cents` through the provider) · send the confirmation again |
| `GET/POST /api/gift-cards` · `GET/PATCH /api/gift-cards/:id` | Gift cards (`q`, `status`) · issue (`amount_cents`, `expires_at`, `contact_id`, `recipient_name`, `recipient_email`, `message`, `note`, `send`) · one card with ledger and holds · block / expiry / recipient |
| `POST /api/gift-cards/:id/adjust` · `POST /api/gift-cards/:id/send` | Correction (`amount_cents` ±, `note`) · mail the code again |
| `POST /api/gift-cards/check` · `POST /api/gift-cards/redeem` | Look up a code · redeem by hand (`code`, `amount_cents` or `invoice_id`) |

Public (no login): `POST /api/public/store/<key>/cart` (`token`, `items`, `email`), `POST /api/public/store/<key>/quote` (`items`, `country`, `shipping_id`, `gift_code`, `company`, `vat_id`), `POST /api/public/store/<key>/checkout` (buyer, address, `shipping_id`, `gift_code`, `provider`, `accept_terms`, gift recipient), the pages `/store/<key>/checkout` and `/store/<key>/order/<token>`. Area **payments** (`/api/store`, `/api/gift-cards`).

## For developers

`modules/store.ts` is one registry line (`...storeModules`) for five modules: `pay-registry.ts` ([payment-providers.md](payment-providers.md#for-developers)), `giftcards.ts`, `store.ts` (admin routes, the purpose `store_order`, triggers, abandoned carts, snapshot part `store`, DSGVO steps), `store-public.ts` (cart, quote, checkout, pages, the site blocks `store_products` and `store_product` through `siteBlocks(app)`), `store-tools.ts` (MCP). Pure logic: `services/store-model.ts` (settings, shipping, tax mode, quote – the quote is `calcTotals` of the invoice lines, so the invoice says the same), `services/store-catalog.ts` (catalogue with articles and stock in three queries), `services/giftcards.ts` (codes, ledger, holds). Hooks: `app.services.giftCards` (`hold`/`commit`/`release`/`refund`/`check`/`issue`/`send`/`payInvoice`/`activeIn`), `app.services.store` (`orderOut`, `loadOrder`, `orderUrl`). Stock goes out through `issueForInvoice` of `services/inv-stock.ts`. Tests: `tests/store.test.ts`, `tests/giftcards.test.ts`.

## Limits

- **One currency** per store (EUR by default) and the German VAT rates for EU consumers (see [OSS](#tax-deeu)).
- No **discount codes** in the cart (gift cards only; buy links keep their discount codes), no customer accounts, no product reviews, no digital downloads delivered by the store (send them with a workflow on *Shop: Bestellung bezahlt*).
- **Stock** is checked when the cart is quoted and at the order; it is taken out when the order is paid, not reserved while the buyer pays.
- No shipping labels or carrier APIs – you enter the tracking number. Shipping profiles per product and zones beyond "rate per country list" are not built.
- Gift cards are always multi-purpose vouchers; no single-purpose vouchers, no physical card printing.
