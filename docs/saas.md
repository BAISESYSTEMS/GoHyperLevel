**English** · [Deutsch](saas.de.md)

# SaaS mode: selling sub-accounts to your own customers

Like GoHighLevel's SaaS Configurator: you create **plans** (price, trial, areas, limits), customers book them themselves through a **sign-up page** in your white label and pay by **Stripe subscription** into your own Stripe account. After payment, a sub-account is created automatically from a snapshot, the customer gets their login and lands directly in their account. All under **Agency → SaaS**.

- **Overview:** MRR/ARR, active subscriptions, trials, open payments (of which paused), churn of the last 30 days, subscriptions and MRR per plan, upcoming renewals, latest events.
- **Plans:** name, description, monthly and yearly price, trial, snapshot, visible on the sign-up page (or hidden, only via the link `/signup?plan=<id>`), areas, limits, overage. `/signup` never shows or sells the plans of the hosted cloud (`cloud-solo`, `cloud-team`, `cloud-agency`, `cloud-agency-client` – [cloud.md](cloud.md)), not even by link: `/signup?plan=cloud-…` leads to `/cloud` in cloud mode, and a `POST` with it answers “Please choose a plan.”.
- **Customer subscriptions:** all sub-accounts with a plan, status, renewal and usage in the month; assign or change a plan (with or without Stripe), create a payment link, cancel. Below that, the sign-ups from the sign-up page (with “Resend invitation”).
- **Settings:** agency Stripe, sign-up page, grace period, costs and markup for overage.

In the sub-account, under **Settings → Subscription & billing**, the customer sees their plan, status, next renewal, usage and limits, and gets to the **Stripe customer portal** with one click (payment method, billing address, invoices, cancellation). Areas outside their plan are hidden in the menu.

## Setting up Stripe (10 minutes)

This is **your agency Stripe account** – separate from the Stripe that a sub-account connects under *Settings → Stripe* for its own invoices and buy links.

1. **Secret key:** Stripe dashboard → *Developers* → *API keys* → secret key (`sk_live_…`, `sk_test_…` to try things out). Enter it in the app under **Agency → SaaS → Settings** – the app checks it right away.
2. **Webhook:** Stripe dashboard → *Developers* → *Webhooks* → “Add endpoint”
   - URL: `https://<your-domain>/hooks/stripe-agency` (shown in the settings, ready to copy)
   - Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed` (optionally `checkout.session.async_payment_succeeded`, `customer.subscription.paused`, `customer.subscription.resumed`)
   - Enter the **signing secret** (`whsec_…`) in the settings.
3. **Customer portal:** Stripe dashboard → *Settings* → *Billing* → *Customer portal*, save once (this is where you decide whether customers may cancel, switch plans or download invoices). Without this step, Stripe rejects portal links.
4. **Dunning:** Stripe dashboard → *Settings* → *Billing* → *Subscriptions and emails*: turn on automatic payment retries (Smart Retries) and e-mails for failed payments. The app reacts to the result (see below).
5. **Create plans:** Agency → SaaS → Plans. When you save, the app creates in Stripe one **product** per plan and one **price** per interval (`metadata.saas_plan_id`). If an amount changes, a new price is created and the old one is archived – running subscriptions keep their price until you change the plan for them. With ↻ you sync a plan again.
6. **Turn on the sign-up page:** Settings → “Sign-up page active”, heading/text, optionally a terms link (the customer then has to tick it), default snapshot and which sub-account the invitation e-mails go through (its SMTP from *Settings → E-mail & SMS*).

The key and the signing secret are stored encrypted and never sent to the browser (only `sk_test_…abcd` as a hint).

**Testing:** In test mode, pay with the card `4242 4242 4242 4242`. Locally, the [Stripe CLI](https://docs.stripe.com/stripe-cli) forwards the webhooks: `stripe listen --forward-to localhost:4700/hooks/stripe-agency`.

## Sign-up: what happens

1. The customer opens `https://<your-domain>/signup` – in the look of your white label (name, logo, color, support address), on your app domain too. They choose a plan and monthly/yearly, and enter company, name, e-mail address (their login) and optionally a phone number.
2. “Create account” opens **Stripe Checkout** (subscription, with trial, coupon codes allowed). Free plans (price 0) skip Stripe.
3. Stripe reports the payment (`checkout.session.completed`) – or the customer comes back and the app asks Stripe itself. Then the following is created:
   - a **new sub-account** with the plan's snapshot (otherwise the default snapshot; workflows as drafts unless “activate right away” is on),
   - a **customer login** (a user with access to exactly this sub-account),
   - an **invitation e-mail** with a link to set the password (valid for 7 days, usable once),
   - the subscription entry (status `trialing`/`active`, Stripe customer, subscription, end of term).
4. In the same browser, it goes straight on to “Set password” and then, signed in, to `/app` – the customer lands in their account. Each event is processed only once; duplicate webhooks create nothing twice.

Protection: required fields are checked, already used e-mail addresses are rejected (“please sign in”), an invisible spam field, at most 10 attempts per hour and IP (free plans: 3 new accounts).

## Putting existing sub-accounts on a plan

Agency → SaaS → Customer subscriptions → **Plan**:

- **Assign without Stripe:** plan, interval and status (active, trial, payment open, paused, ended) by hand – e.g. for customers who pay by invoice. Limits and areas apply immediately.
- **Stripe payment link:** creates a Checkout link for the chosen plan that you send to the customer. After payment, the sub-account runs through Stripe.
- **Changing the plan on a running Stripe subscription:** switches the subscription at Stripe to the new price (prorated). The status then comes from Stripe.
- **Cancel:** at the end of the term (reversible) or immediately. **Remove plan** lifts all rules (for Stripe subscriptions only after they have ended).

Also via MCP: `ghl_set_location_plan` (`location_id`, `plan` as ID or name, optionally `interval`, `status`; without `plan` = remove) and `ghl_saas_overview`.

## How the restrictions work

Everything hangs on **one guard** (`server/modules/saas-gate.ts`) that runs on every request after sign-in – the feature modules themselves know nothing about it:

- **Areas:** Every API route belongs to an area (`server/core/permissions.ts`, the same mapping as for the permissions of client logins). If the area is not in the plan, the API answers **403** (“‘Courses & member area’ is not included in your plan ‘Starter’ …”), and the menu hides it. Simple lookup lists (e.g. a form or calendar list for other screens) stay readable. *Settings* is always on, so that “Subscription & billing” stays reachable.
- **Limits on creation:** contacts (`POST /api/contacts`, CSV import), funnels & websites (new and copied), courses and users (client logins with access to the sub-account; admins do not count). At the limit: **403** “Limit reached: Your plan ‘Starter’ includes 1,000 contacts. For more, please switch to a larger plan (Settings → Subscription & billing).” Saving an existing contact (same e-mail/phone) always works. Contacts from public forms, bookings or purchases are never discarded.
- **Usage per month:** e-mails, SMS and AI calls are counted per calendar month (UTC) – right before sending or the Claude call, including from workflows and campaigns (hook `app.services.usageGate`). Plan setting per kind: **block** (beyond that, the message is saved as “failed” with a note, or the AI call is rejected) or **bill on**.
- **Agency exempt:** agency admins and agency keys see all areas and can change data even in paused accounts (to help; sending and AI stay off there). Limits apply to everyone. Client logins and sub-account API keys are subject to all rules.

## Late payment, pause, cancellation

| Stripe reports | In the app |
| --- | --- |
| `invoice.payment_failed` / subscription `past_due` | Status **Payment open**, banner “Payment failed – please update by …” with a button to the customer portal; the **grace period** (default 7 days) starts once and is not extended by further failed attempts |
| Grace period over (the app checks itself) / subscription `unpaid` or `paused` | **paused**: everything stays readable, changes, sending and AI are blocked; only “Subscription & billing” works |
| `invoice.paid` | **active** again (banner gone) |
| Cancellation at the end of the term (`cancel_at_period_end`) | Note “Your subscription ends on …” with “Undo cancellation” |
| `customer.subscription.deleted` | **ended**: read-only from now on; counts in churn |

A banner also appears 7 days before a trial ends. Public pages (funnels, forms, bookings) keep running in paused accounts.

## Billing overage on

For plans set to “bill on”: after the end of the month, the app calculates per sub-account `(usage − included) × your cost per unit × (1 + markup)` and adds it as an **invoice item** (`/v1/invoiceitems`) to the running Stripe subscription – it appears on the next subscription invoice (“Overage e-mails 2026-09: 1,240 over the included allowance”). You set your cost per e-mail/SMS/AI call (in cents, fractions allowed) and the default markup in the settings; each plan can have its own markup. This runs hourly in the background, each month is billed exactly once per kind (idempotency key at Stripe); `POST /api/saas/usage/report` triggers it immediately.

## System mail texts

*Agency → Branding → System mail texts*: subject and text of the e-mails the system sends to people, in your own words – **Invitation** (sign-up link), **Sign-in link by e-mail**, **SaaS: Welcome & set password** and **SaaS: another account**. Placeholders such as `{{brand.name}}`, `{{user.name}}`, `{{location.name}}`, `{{plan.name}}`, `{{days}}` and conditions (`{{#if …}}`) work; `{{link}}` has to be in the text (otherwise it is not saved, and if the link is missing at send time, the default text goes out). *Default* restores the built-in text. API (agency): `GET /api/agency/system-mails`, `PUT|DELETE /api/agency/system-mails/:key`; module `server/modules/system-mails.ts` (`app.services.systemMail(key, fallback, vars)` – the senders in `magic-link.ts` and `saas-signup.ts` call it).

## Announcements for sub-accounts

*Agency → Clients → Announcements for sub-accounts*: a short notice that appears **at the top of the app** for your customers – maintenance tonight, a new feature, an invitation to a webinar. Per announcement: title, text, kind (Info, Success, Warning) and, under *More fields*, a link (`https://…` or a path in the app), period (from/to), only certain sub-accounts (empty = all), whether it can be dismissed and whether it is active. Whoever dismisses it does not see it again (per person); at most three at a time.

API (agency): `GET|POST /api/agency/banners`, `PATCH|DELETE /api/agency/banners/:id`; in the sub-account `GET /api/agency-banners/active`, `POST /api/agency-banners/:id/dismiss`. MCP (agency connection): `ghl_agency_banners`, `ghl_agency_banner_create`. Module `server/modules/agency-banners.ts`, interface via the slots `agency.clients` and `shell.banner`.

## API

See [docs/api.md](api.md#saas-mode).
