# Payment providers: Stripe, PayPal and Mollie

Every sub-account can take money through **Stripe**, **PayPal** and **Mollie** – side by side. The providers sit behind one small interface (the *payment registry*), so invoices, buy links, bookings, forms and the [online store](store.md) all offer whatever is connected, and every payment is booked through the same invoice payment logic as before ([invoicing.md](invoicing.md)). [Gift cards](store.md#gift-cards) pay their part on the same way.

- [What each provider offers](#what-each-provider-offers)
- [Setting up PayPal](#setting-up-paypal)
- [Setting up Mollie](#setting-up-mollie)
- [Where buyers see the providers](#where-buyers-see-the-providers)
- [What happens when the money arrives](#what-happens-when-the-money-arrives)
- [Refunds](#refunds)
- [Security](#security)
- [API](#api)
- [For developers](#for-developers)
- [Limits](#limits)

## What each provider offers

| Provider | Methods | Set up under |
| --- | --- | --- |
| **Stripe** | Card, SEPA Direct Debit, Apple Pay, Google Pay, Klarna … (what is active in your Stripe dashboard) | *Einstellungen → Stripe & Zahlungen* (key and webhook as in [stripe.md](stripe.md)) |
| **PayPal** | PayPal balance, card, and **Pay Later** (*Später bezahlen* in 30 days, *Ratenzahlung*) for buyers PayPal finds eligible | *Einstellungen → Stripe & Zahlungen → PayPal* |
| **Mollie** | iDEAL, SEPA bank transfer, cards, Klarna, Bancontact, eps … (popular in Germany, Austria, Switzerland and the Netherlands) | *Einstellungen → Stripe & Zahlungen → Mollie* |

Credentials belong to one sub-account, are checked with the provider when you save them, are stored **sealed** (AES-256-GCM, like every other secret – `npm run rotate-secret` rotates them) and are never sent back to the browser – the settings page shows only the first and last characters.

Subscriptions (recurring products) and payment plans stay with Stripe – PayPal and Mollie take one-time payments.

## Setting up PayPal

1. [developer.paypal.com](https://developer.paypal.com) → *Apps & Credentials* → create an app (first in **Sandbox**, later **Live**). Copy the **Client ID** and the **Secret**.
2. In the same app add a **webhook** with the address shown in HyperLevel (`https://<your-domain>/hooks/paypal/<locationId>`) and the events `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.DECLINED`. Copy the **Webhook ID**.
3. In HyperLevel enter client ID, secret, webhook ID and the environment (*Sandbox* or *Live*) and press *Speichern und prüfen* – HyperLevel asks PayPal for an access token; wrong credentials are refused right away.
4. **Pay Later** is on by default: PayPal shows *Später bezahlen* and *Ratenzahlung* on its own page to buyers who qualify (PayPal decides; it needs no extra setting in HyperLevel). Switch the hint off if you do not want it advertised.

A payment is an **order** (Orders API v2, intent `CAPTURE`). The buyer approves it on PayPal's page; HyperLevel captures it as soon as they come back – or when `CHECKOUT.ORDER.APPROVED` arrives, whichever is first – and the capture settles the payment.

## Setting up Mollie

1. [my.mollie.com](https://my.mollie.com) → *Developers* → *API keys*: copy the **test** key (`test_…`) first, later the **live** key (`live_…`).
2. Enter it in HyperLevel and press *Speichern und prüfen* – HyperLevel lists the methods active on your account.
3. Optionally pick the methods HyperLevel offers (iDEAL, credit card, SEPA bank transfer, Klarna …); none picked = everything active in Mollie.

There is **no webhook to set up**: HyperLevel sends Mollie its address (`https://<your-domain>/hooks/mollie/<locationId>`) with every payment. Klarna wants order lines; the store sends them when they add up to the amount exactly (otherwise Klarna is not offered for that payment). Klarna payments are authorised first and captured right away.

## Where buyers see the providers

| Where | What changes |
| --- | --- |
| **Invoice page** (`/i/<token>`) | Next to Stripe's *Jetzt bezahlen* a second button *Mit PayPal, Mollie oder Gutschein bezahlen* leads to the **pay page**. Without Stripe the button is *Jetzt online bezahlen*. It asks for the **open amount**, like Stripe. |
| **Pay page** (`/pay/<id>`) | Amount, a field for a **gift-card code** and one button per connected provider. A gift card that covers everything settles the payment without a provider. |
| **Buy links** (`/buy/<product>`) | With PayPal or Mollie connected the page asks *Bezahlen mit* (Stripe, PayPal, Mollie). Order bump and discount codes apply to every provider; payment plans and subscriptions need Stripe. The purchase ends exactly like a Stripe one: contact, paid invoice, tag `kauf:<produkt>`, trigger *Produkt gekauft*. |
| **Forms** with a payment field | They lead to the buy page, so they get the same choice. |
| **Bookings** (team calendars with *pay at booking*) | With PayPal/Mollie connected or gift cards in use, the booking goes to the pay page instead of straight to Stripe; the slot is held the same way and becomes the appointment (with its paid invoice) once the money is there ([team-calendars.md](team-calendars.md)). |
| **Online store** | The checkout lists every connected provider ([store.md](store.md)). |

## What happens when the money arrives

- Every payment is a **pay session** (`pay_sessions`): purpose (invoice, store order, booking, product), the amount, the gift-card part, the provider and its reference. A webhook, the buyer's return and a provider's second event all end in one place, so a payment is **settled once** – a retried webhook never books twice.
- **Invoices** are booked through `recordPayment` of the invoice flow (finalising a draft on the way, GoBD number), with the rules of the Stripe payments: never more than is open, less is a part payment, any difference (too much, too little, another currency, nothing open any more) goes to the invoice's trail (`payment.mismatch`) and the contact's activity, so a refund is not forgotten. The payment method is the provider's name (*PayPal*, *Mollie*); a gift card is its own payment *Gutschein*.
- Coming back from the provider, HyperLevel asks it right away, so the invoice or order is paid even when the webhook is late or not set up.
- A session nobody pays lapses after two days (a payment *in progress*, e.g. a Mollie bank transfer, after 30 days); a held gift card is released then.

## Refunds

`POST /api/pay/sessions/:id/refund` (whole or `amount_cents`) refunds through the provider: Stripe refunds the PaymentIntent, PayPal the capture, Mollie the payment; `payment.refunded` fires for webhooks and workflows. Store orders have their own *Erstatten* (the gift-card part goes back onto the card). A refund **does not cancel the invoice** – write a credit note or a Stornorechnung for the VAT correction ([invoicing.md](invoicing.md#storno-and-credit-notes)).

## Security

- **PayPal webhooks** are verified by PayPal itself (`/v1/notifications/verify-webhook-signature` with the webhook ID); unverified calls are refused with 400. Each event is processed once.
- **Mollie webhooks** carry only a payment id; HyperLevel always reads the payment back from Mollie with the sub-account's key and checks that it belongs to the session – a forged call cannot pay anything.
- **Stripe** stays as it is: signed webhooks per sub-account ([stripe.md](stripe.md#was-beim-bezahlen-passiert)).
- The pay page and the gift-card field are rate-limited per address; gift-card codes have 80 bits of randomness.

## API

| Endpoint | |
| --- | --- |
| `GET /api/pay/providers` | Status of every provider (ready, methods, webhook address, options; no secrets) and Mollie's method list |
| `PUT /api/pay/providers/:id` | `paypal`: `{client_id, client_secret, webhook_id, mode: sandbox\|live, pay_later}` · `mollie`: `{api_key, methods}` – checked with the provider, then stored sealed (`••••••` keeps a stored secret) |
| `POST /api/pay/providers/:id/test` · `DELETE /api/pay/providers/:id` | Check the stored (or typed) credentials · disconnect |
| `GET /api/pay/sessions?purpose=&ref_id=&status=&provider=` · `GET /api/pay/sessions/:id` | Pay sessions (provider, reference, amounts, gift-card part, refunds) |
| `POST /api/pay/sessions/:id/refund` | `{amount_cents?}` – refund through the provider |

Public: `/pay/<id>` (pay page; `POST …/gift`, `POST …/go`, `GET …/return`, `GET …/cancel`), `POST /i/<token>/pay-options`, `POST /hooks/paypal/<locationId>`, `POST /hooks/mollie/<locationId>`. The provider routes belong to the area **settings**, the sessions and refunds to **payments**.

## For developers

The registry is `services/pay-registry.ts`; `modules/pay-registry.ts` keeps the tables (`pay_accounts`, `pay_sessions`, `pay_refs`, `pay_events`), the routes and the hooks into invoices, buy links and bookings.

- **A provider** is an object `{ id, label, methods(app, loc), ready(app, loc), create(app, session) → {provider_ref, url}, fetch(app, session) → state, refund(app, session, cents) }` registered with `registerPayProvider(app, provider)` – see `services/pay-stripe.ts`, `pay-paypal.ts`, `pay-mollie.ts`. Its webhook calls `applyState(app, session, state, providerId)`.
- **A purpose** says what paid money does: `registerPayPurpose(app, 'store_order', { settle(app, session, received), lapse?(app, session) })`. Built in: `invoice`, `product` (buy links, through `app.services.stripeBuy.completeProduct` with the provider's name), `teamcal_hold` (registered by `modules/teamcal.ts`), `store_order` (`modules/store.ts`). Registration is order-independent.
- **`app.services.payRegistry`** for other modules: `ready(loc)`, `choiceNeeded(loc)`, `start(input)`, `checkout(id, provider)`, `pageUrl(session)`, `get(id)`, `lapse(id)`, `refund(id, cents?)`, `refundAll(id)`, `label(provider)`. Bookings use it in `services/teamcal-pay.ts`; a session id (`ps_…`) stands where a Stripe PaymentIntent stood, so refunds and expiry go back to the registry.
- **`bookInvoicePayment(app, loc, invoiceId, {amount, currency, via, note})`** books money for an invoice with the Stripe rules.
- Hooks: `app.services.payBuy` (the buy page with another provider – `modules/stripe.ts` hands over), `buyPayNote` (the payment line of the buy page), the chained `invoicePayHtml`, the `stripeSessions` tap for registry sessions; UI slot `settings.payments` (`web/src/slots.tsx`).
- **Test hook:** `app.services.payFetch` replaces the network of PayPal and Mollie (fakes in `tests/pay-providers.test.ts`); Stripe keeps `setStripeFetch`.

## Limits

- No PayPal or Mollie **subscriptions** and no payment plans – recurring billing stays with Stripe.
- **PayPal Pay Later** is offered by PayPal on its page to eligible buyers; there is no separate Pay Later button and no on-site messaging banner.
- No **disputes / chargebacks** handling for PayPal and Mollie (see their dashboards); a refund made in the provider's dashboard is not mirrored into HyperLevel.
- Mollie's **Klarna** needs exact order lines; payments whose lines do not add up (a gift card in between) are offered without Klarna.
