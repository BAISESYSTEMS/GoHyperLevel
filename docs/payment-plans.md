# Payment plans (Ratenzahlung)

**Umsatz → Ratenzahlung** lets a customer pay a one-time product in instalments – "3 × 99,00 € monthly" next to "297,00 € once" on the buy page. Stripe collects the instalments and the subscription **ends by itself** after the last one; access follows the payments. If an instalment fails, the [dunning module](dunning.md) takes over and the plan decides what happens to the access.

Everything is per sub-account and uses the sub-account's own Stripe key ([Stripe](stripe.md)). The menu entry and the API belong to the area **Rechnungen & Zahlungen** (`payments`).

- [How it works](#how-it-works)
- [Set up (self-hosters)](#set-up-self-hosters)
- [Plans](#plans)
- [Purchases](#purchases)
- [What happens when a payment fails](#what-happens-when-a-payment-fails)
- [Workflows, API and MCP](#workflows-api-and-mcp)
- [Limits and good to know](#limits-and-good-to-know)

## How it works

1. You create a **plan** for a one-time product: number of instalments, amount per instalment (gross), interval, optionally a different first instalment, and what happens to the access on a default.
2. The product's **buy page** (`/buy/<slug>`) shows a choice *Zahlungsweise*: lump sum or one of the plans (`?plan=<id>` preselects one). Order bumps and the buyer's data work as usual.
3. A plan purchase is a **Stripe subscription** (Checkout, `mode=subscription`) with the instalment as the recurring price. The app counts the paid invoices and ends the subscription right after the last one (`cancel_at` is set as a safety net, so Stripe stops even if the app is offline).
4. The first payment creates the contact, the paid invoice/receipt and gives the usual **purchase tag** (this opens the course access of the product). Every following instalment is booked as a paid invoice, too, labelled *Rate 2/3* and so on.
5. After the last instalment the purchase is **completed** (`payment_plan.completed` runs); the access stays for good.

## Set up (self-hosters)

Nothing to install. You need:

- **Stripe connected** for the sub-account (*Einstellungen → Stripe*: secret key and the webhook secret).
- **The webhook** in the Stripe dashboard (*Developers → Webhooks → Add endpoint*), URL `https://<your-domain>/hooks/stripe/<sub-account-id>` (shown in *Einstellungen → Stripe*). Besides the events of [docs/stripe.md](stripe.md) the plans need: `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `customer.subscription.updated`, `customer.subscription.deleted`.
- **`PGHL_BASE_URL`** set to the public `https://` address (it is in the buy page and in every link).
- A product with a **one-time price**. Subscription products cannot have a plan.

Test with a Stripe test key (`sk_test_…`) and the card `4242 4242 4242 4242`. Stripe's *test clocks* let you move time forward to see the following instalments.

## Plans

*Ratenzahlung → Pläne*, grouped by product (up to six plans per product):

| Field | Meaning |
| --- | --- |
| Raten | 2 to 60 instalments. |
| Betrag je Rate | Gross amount per instalment (at least 0,50 €). |
| Abstand | Every 1–12 months or 1–52 weeks. |
| Erste Rate abweichend | Optional down payment (or a smaller first payment). It is charged on the first invoice through a one-off coupon or surcharge line. |
| Wenn eine Rate nicht eingezogen werden kann | *Zugang pausieren* (default, comes back with the next payment), *Zugang entziehen*, or *Zugang behalten* (only notify). |
| Auf der Kaufseite anbieten | Switch a plan off without deleting it. |

The editor shows the sum and warns when it differs from the product's single price – a surcharge for instalments is allowed but must be clear to the buyer. **Changing or deleting a plan never touches purchases that already exist**: every purchase keeps the terms it was bought with.

Coupons (discount codes) are not offered together with a plan; the buyer chooses "once" for a discount.

## Purchases

*Ratenzahlung → Käufe* lists every instalment purchase with progress (*2 von 6 Raten bezahlt*), status and access. A click opens the paid instalments with their invoices and the background jobs. Actions:

- **Zugang pausieren / fortsetzen** – by hand, without touching Stripe.
- **Plan beenden** – cancels the Stripe subscription; no further instalments are collected. The purchase becomes *beendet*.

Status: *läuft* (`active`), *abgeschlossen* (`completed`), *ausgefallen* (`defaulted`), *beendet* (`canceled`). Access: *aktiv*, *pausiert*, *entzogen*.

## What happens when a payment fails

1. Stripe's retry rules apply (Smart Retries – set in the Stripe dashboard, *Settings → Billing → Subscriptions and emails → Manage failed payments*). Each failed attempt counts on the purchase.
2. The [dunning module](dunning.md) opens a case, e-mails the buyer a link to the hosted billing page where the card can be updated, and sends reminders.
3. When Stripe gives up (or the subscription is cancelled) the purchase becomes **ausgefallen** and the plan's setting decides about the access. `payment_plan.defaulted` runs with the reason (`payment_failed`, `unpaid`, `canceled`) and the open amount.
4. If the buyer pays later (new card, paid invoice) the purchase continues and a **paused** access comes back. An access that was **revoked** (*Zugang entziehen*) does not come back by itself – use *Zugang fortsetzen* on the purchase.

## Workflows, API and MCP

**Triggers** (*Automationen*): *Ratenzahlung abgeschlossen* (`payment_plan.completed`) and *Ratenzahlung ausgefallen* (`payment_plan.defaulted`), both with a filter for one product. Event data: `{{event.plan.name}}`, `{{event.paid_cents}}`, `{{event.open_cents}}`, `{{event.installments}}`, `{{event.product.name}}`, `{{event.reason}}`, `{{event.access}}`.

**API** (area `payments`):

| Route | |
| --- | --- |
| `GET /api/payment-plans?product_id=` | Plans with counters (`running`, `completed`, `defaulted`). |
| `POST /api/payment-plans` | `{product_id, name?, installments, interval, interval_count, amount_cents, first_amount_cents?, on_default, active}`. |
| `PATCH` / `DELETE /api/payment-plans/:id` | Change or delete a plan (purchases keep their terms). |
| `GET /api/payment-plans/subscriptions?status=&contact_id=&limit=` | Purchases. `GET …/subscriptions/:id` adds payments and jobs. |
| `POST /api/payment-plans/subscriptions/:id/access` | `{on: true\|false}` – resume or pause the access. |
| `POST /api/payment-plans/subscriptions/:id/cancel` | End the plan at Stripe. |

**MCP tools:** `ghl_payment_plan_list`, `ghl_payment_plan_save`, `ghl_payment_plan_purchases`. **Mobile (read-only):** `GET /api/mobile/creator/payment-plans` ([docs/api.md](api.md)).

## Limits and good to know

- **Stripe only.** Currency is the product's currency. SEPA debit and cards both work; the payment methods are those you enabled in Stripe.
- **Taxes:** the plan amount is gross; the invoices show the product's tax rate like a normal purchase. This is not tax advice – check with your accountant how instalment sales are to be booked.
- Instalments are collected on the same day of the month (the day of the first payment; the 31st becomes the last day of shorter months).
- The shown number of instalments is final: to change the count of a running purchase, end it and sell a new plan.
- **An instalment never books more than the plan asks for.** A payment above the agreed instalment, or one Stripe collects after the last instalment (when the end of the subscription did not get through), is not booked as an instalment – no invoice *Rate 4 von 3* – but noted in the contact's activity and the audit log (`payment_plan.overpaid`, *bitte erstatten*), and Stripe is told again to end the subscription. Refund the surplus in Stripe.
- Every action – plan changes, access, cancel – is in the **audit log**.
