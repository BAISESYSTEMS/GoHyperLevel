**English** · [Deutsch](stripe.de.md)

# Stripe payments

Each sub-account connects **its own Stripe account**. After that:

- **Invoices:** The customer link (`/i/…`) of every open invoice shows **“Pay now (card, SEPA, Apple Pay …)”**. The button opens Stripe Checkout for the **open amount** with the customer's e-mail address: an untouched invoice with all its line items (gross, incl. VAT); if part of it is already paid, credited with a credit note or – on a final invoice – deducted through partial invoices, a single line **“Remaining balance invoice RE-…”** that names what was deducted (with the VAT note, as on the line items). If nothing is open any more, there is no button. After payment the invoice is set to **paid** (with the date and Stripe reference), the workflow trigger **“Invoice paid”** fires, and outgoing webhooks receive `invoice.paid` (with `via: "Stripe"`).
- **Products:** Every product has a public **buy link** `https://<domain>/buy/<product-id>` or, with a short name, `…/buy/online-kurs`. After a purchase: the contact is created or matched by e-mail address, a **paid invoice** is created (and sent by e-mail automatically if you want), the contact gets the tag **`kauf:<short-name>`** (e.g. for course unlocks) and the workflow trigger **“Product purchased”** fires (`product.purchased` with `contactId`, `productId`, `invoiceId`).
- **Subscription products** (monthly/yearly interval) run as Stripe subscriptions: every renewal creates a paid invoice here, and when the customer cancels, the purchase tag is removed again.
- In **Invoices & quotes**, “Stripe connected” shows the status and “via Stripe” marks invoices paid online; the invoice shows when it was paid and with which reference (link to the Stripe dashboard).

**Other payment providers:** Besides Stripe you can connect **PayPal** (including “Pay later”) and **Mollie** (iDEAL, SEPA bank transfer, cards, Klarna) – under *Settings → Stripe & payments*. The buy page then asks “Pay with”, invoices get a second button next to “Pay now” that leads to the payment page (where gift cards can be redeemed too), and the [online store](store.md) offers every connected provider. Subscriptions and payment plans stay with Stripe. Setup and flow: [payment-providers.md](payment-providers.md).

## Setup (5 minutes)

1. **Secret key:** Stripe dashboard → *Developers* → *API keys* → “Secret key” (`sk_live_…`; to try things out, use `sk_test_…` in test mode first). Enter it in the app under **Settings → Stripe** and save – the app checks the key right away (“Test connection” works at any time).
2. **Webhook:** Stripe dashboard → *Developers* → *Webhooks* → **“Add endpoint”**
   - Endpoint URL: `https://<your-domain>/hooks/stripe/<locationId>` – the finished address is shown under Settings → Stripe, ready to copy.
   - Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`; for subscription products also `invoice.paid` and `customer.subscription.deleted`. Optionally `charge.refunded` (workflow trigger “Payment refunded”), `invoice.payment_failed` and `checkout.session.async_payment_failed` (trigger “Payment failed”, [docs/workflow-actions.md](workflow-actions.md#triggers)) and `customer.subscription.deleted` (trigger “Subscription cancelled / ended”). `charge.refunded`: refunds report `payment.refunded` (webhooks/workflows) and reverse affiliate commissions ([docs/growth.md](growth.md#affiliate-manager)).
   - For the trigger **Checkout abandoned (cart abandonment)**, also add `checkout.session.expired` ([E-mail marketing](email-marketing.md#abandoned-cart)): with it, Stripe reports an unpaid payment page after 24 hours.
   - For [payment plans](payment-plans.md) and [dunning](dunning.md), also add: `invoice.payment_failed`, `invoice.payment_action_required`, `customer.subscription.updated` (and `invoice.paid`, `customer.subscription.deleted`, `checkout.session.completed` as above). For payment plans and subscriptions, set up **Smart Retries** in Stripe under *Settings → Subscriptions and emails → Failed payments*.
   - After creating it, reveal the endpoint's **signing secret** (`whsec_…`) and enter it under Settings → Stripe.
3. **Payment methods:** Stripe dashboard → *Settings* → *Payment methods*. Checkout automatically shows everything that is active there (card, SEPA direct debit, Apple Pay, Google Pay, Klarna …). Apple Pay needs no domain verification of its own with Stripe Checkout.

The key and the signing secret are stored encrypted and never sent back to the browser (only `sk_test_…abcd` as a hint). “Disconnect” deletes both; “Pay now” and buy links are then off.

## Buy links

Products → copy the **“Buy link”** on the product and adjust it with the gear icon:

| Setting | Effect |
| --- | --- |
| Short name | `/buy/<short-name>` instead of the product ID (unique across all sub-accounts) |
| Tag for buyers | Default `kauf:<short-name>` (without a short name: taken from the product name) |
| Redirect after purchase | e.g. the course page or a thank-you page (`https://…`); otherwise the app shows a thank-you page |
| Buy link active | Off = page not reachable |

The link opens a small product page with the price (gross) and “Buy now” – with an order bump and a discount code field if set up (see below). Adding `?email=kunde@example.com` to the link pre-fills the e-mail address in Stripe (handy from funnels or e-mails).

## Order bump, upsell and discount codes

Also in the gear dialog of the buy link, saved with *Save*. It needs **no further keys and no further webhook events**.

| Setting | Effect |
| --- | --- |
| Order bump | A second product (one-time purchase, same currency) as a checkbox on the buy page, with its own text. When ticked → second line item in Stripe Checkout; the paid invoice contains both line items (each with its own tax rate). The contact gets both purchase tags, “Product purchased” fires for both products (the bump event carries `via: "order_bump"`). Also works for subscription products (the bump is charged once with the first payment). |
| One-click upsell | A product (one-time purchase) offered right after payment. For this, Checkout creates a Stripe customer and saves the payment method (`customer_creation=always`, `payment_intent_data.setup_future_usage=off_session`). “Yes, add it” charges without re-entering anything (PaymentIntent `off_session`, `confirm`); it creates its own paid invoice, with tag and “Product purchased” as for any purchase. If the bank asks for confirmation (3-D Secure, `authentication_required`) or the card is declined, the customer continues on a normal Stripe payment page for the upsell product (customer and e-mail pre-filled). “No thanks” leads to the thank-you page or to the redirect of the main product. The offer is valid for one hour and can be accepted only once. Only after one-time purchases (not after subscriptions). The dialog shows how often it was offered and accepted. |
| Discount codes | Your own codes per product: percent or fixed amount (gross), optionally with an expiry date and a maximum number of redemptions, and can be switched off. Buyers enter the code on the buy page (checked instantly, the total updates); Checkout charges the reduced price, and the invoice shows the discount as its own line. Applies to the main product, one-time purchases only. With a maximum, one redemption is reserved while a buyer is on the Stripe payment page: the page expires after 31 minutes, and if the purchase is not completed, the code is free again (a SEPA payment holds it until the bank responds) – so a code “for the first 10” goes out only ten times even with many simultaneous buyers. |
| Allow Stripe coupon codes | Shows the field for promotion codes on the Stripe payment page (`allow_promotion_codes`). You create the codes in the Stripe dashboard (*Product catalog → Coupons*). The discount Stripe grants appears on the invoice as a “Coupon (Stripe)” line. If one of your own discount codes is redeemed, the Stripe field is off. |

**For the upsell in the Stripe dashboard:** nothing extra – cards, Apple Pay, Google Pay and SEPA can be saved for later payments. With SEPA, the upsell payment is “processing” at first; the app asks Stripe every 10 minutes and issues the invoice as soon as the money is confirmed.

**A/B tests:** Buy links on funnel pages with a running A/B test automatically get the visitor ID (`?ab=…`); it travels through the buy page into the Checkout metadata so that the purchase is attributed to the right variant.

## What happens when someone pays

- Stripe reports the payment to `/hooks/stripe/<locationId>`. The signature (`Stripe-Signature`, HMAC-SHA256 over timestamp + body) is verified; older than 5 minutes or wrong → rejected.
- Each event is processed only once (Stripe repeats webhooks on errors). An invoice is never marked “paid” twice, and a purchase never creates two invoices.
- When the customer returns from Stripe, the app asks Stripe directly – so the invoice shows as paid immediately even if the webhook is still on its way.
- **SEPA direct debit** takes a few days: until Stripe confirms the money (`checkout.session.async_payment_succeeded`), the payment is “processing”. In the meantime the invoice shows a note that a payment is being processed instead of “Pay now”, and does not open a second payment page (the customer would pay twice); after three weeks without a response the button comes back. If it fails, that appears in the contact's activity, and the invoice can be paid online again.
- A double click on “Pay now” opens one payment page, not two; anyone who comes back within 30 minutes gets the same one (as long as the open amount is the same).
- What arrives is what gets booked – never more than is open: the open amount makes the invoice paid, anything less is booked as a **partial payment** (the invoice stays open with the remainder). If more arrives – for example because a bank transfer or credit note came in between opening the payment page and paying – only the open amount is booked. Every deviation (too much, too little, another currency, money for an invoice with nothing open) appears in the invoice's log (`payment.mismatch`) and in the contact's activity, so a refund is not forgotten. The same payment (webhook retry, PaymentIntent event, return from Stripe) is booked only once.
- Buy links and Stripe payments create **finalized** invoices with the next number of the invoice number range (GoBD, see [invoicing.md](invoicing.md)); a draft is finalized when it is paid. A refund in Stripe does not cancel the invoice by itself – you do that with “Cancel invoice” on the invoice (only for appointment bookings with payment does this happen automatically).

## Testing

In test mode (`sk_test_…`), pay with the test card `4242 4242 4242 4242`, any expiry date in the future and any security code. Locally, without a public address, the [Stripe CLI](https://docs.stripe.com/stripe-cli) forwards the webhooks:

```bash
stripe listen --forward-to localhost:4700/hooks/stripe/<locationId>
# shows a whsec_… – enter it under Settings → Stripe
```
