# Dunning (Mahnwesen) and the billing page

**Umsatz → Mahnwesen** catches money that did not arrive, in two parts that share one settings page:

1. **Failed subscription and instalment payments.** A card is declined, Stripe retries, HyperLevel e-mails the buyer a link to a **hosted billing page** where the card is updated in a minute, reminds, and pauses the access if nothing helps. When the payment finally goes through, everything continues.
2. **Overdue invoices.** *Zahlungserinnerung*, *1. Mahnung* and *2. Mahnung* after days you choose, with a fee per level and default interest (§ 288 BGB), as an e-mail with a PDF – asking you first (**Freigabe**) or fully automatic. A payment stops everything at once.

Plus the **billing page** (`/abo/<link>`) where customers manage their subscriptions without a login. Everything is per sub-account, uses the sub-account's Stripe key and belongs to the area **Rechnungen & Zahlungen** (`payments`). Nothing is sent until you switch it on: the invoice part starts **off**.

- [Set up (self-hosters)](#set-up-self-hosters)
- [Failed subscription and instalment payments](#failed-subscription-and-instalment-payments)
- [The billing page](#the-billing-page)
- [Overdue invoices](#overdue-invoices)
- [Default interest and fees](#default-interest-and-fees)
- [Workflows, API and MCP](#workflows-api-and-mcp)
- [Limits and good to know](#limits-and-good-to-know)

## Set up (self-hosters)

- **Stripe connected** (*Einstellungen → Stripe*) and the **webhook** in the Stripe dashboard (*Developers → Webhooks*), URL `https://<your-domain>/hooks/stripe/<sub-account-id>`, with these events: `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `customer.subscription.updated`, `customer.subscription.deleted`, `checkout.session.completed` (the last one finishes a card update). The *Mahnwesen* page shows this list and warns when Stripe is not connected.
- **Stripe's own retries.** In the Stripe dashboard (*Settings → Billing → Subscriptions and emails → Manage failed payments*) switch on **Smart Retries** and choose how long Stripe keeps trying and what happens at the end. HyperLevel follows what Stripe does. Without Smart Retries, choose *HyperLevel (eigene Tage)* in the dunning settings: HyperLevel then pays the open invoice itself on the days you list (switch Stripe's retries off in that case so a card is not charged twice in a row).
- **Stripe's customer e-mails** (failed payment, card expiring) can stay on; HyperLevel's mail is the one with the link to your own billing page.
- **Optional: the Customer Portal.** *Settings → Billing → Customer portal* in Stripe. If you choose *Stripe-Kundenportal* for card updates and the portal is not set up, HyperLevel falls back to its own card page (Checkout in setup mode).
- **`PGHL_BASE_URL`** must be the public `https://` address (it is in every link). The signing key for the links is derived from the server secret – keep `data/` safe like the rest.
- **A sender** for e-mail (and SMS if you switch it on): *Einstellungen → Kanäle*. With the provider *log* messages are only recorded.
- **The background tick** (`PGHL_TICK_MS`, default 15 s) runs retries, reminders and the dunning run (every 30 minutes).

## Failed subscription and instalment payments

*Mahnwesen → Zahlungsausfälle.* A failed payment (Stripe `invoice.payment_failed`) of a subscription or an instalment plan opens a **case** for the contact and product:

1. **First message** at once: e-mail (optionally SMS) with the amount, the product and the **link to the billing page**. Texts are editable (*Einstellungen → Texte der E-Mails und SMS*).
2. **Reminders** on the days you set (default 0, 3 and 7 after the first failure). Each message is noted on the case before it is sent, so the background run never sends a message the webhook (or a click) is sending at that moment.
3. **Retries:** Stripe's Smart Retries – or HyperLevel's own on the days you list.
4. **Final:** when Stripe stops, or after *Zugang pausieren nach … Tagen* (default 14), the access is **paused** (or kept, your choice; instalment plans use their own setting) and the last message says so. Optionally the subscription is also cancelled at Stripe.
5. **Recovered:** when `invoice.paid` arrives the case is closed as *wieder bezahlt*, a paused access comes back, `dunning.recovered` runs. A card update through the billing page pays the open invoice immediately.

A case's dialog shows the history and offers *Erinnerung senden*, *Jetzt erneut einziehen*, *Zugang pausieren / fortsetzen* and *Fall schließen*. You can also create a **billing link** for any contact (*Abo-Link erzeugen*) and send it by e-mail or SMS.

## The billing page

`https://<your-domain>/abo/<link>` – a signed link for **one contact** that expires (default 30 days, adjustable); no login. It shows that person's subscriptions and instalment plans and their invoices (the total and – after a part payment, a credit note or a deducted partial invoice – what is still open; *gutgeschrieben* for one credited in full), and lets them:

- **Update the card** – through the Stripe Customer Portal or a Checkout page in setup mode (your choice). The new card becomes the default and open invoices are paid.
- **Pause, cancel, un-cancel and switch plan** – only where *Mahnwesen → Abo-Verwaltung* allows it for that product: *Kündigen erlaubt*, *Pausieren erlaubt*, whether a cancellation takes effect now or at the end of the paid period, and the list of products they may switch to (other active subscriptions in the same currency).

The member area shows an *Abo & Rechnungen* link for customers who have subscriptions. The page never shows another contact's data; wrong, expired or forged links show a neutral error, and the pages are rate-limited and `noindex`.

## Overdue invoices

*Mahnwesen → Rechnungen.* The run (every 30 minutes, or *Jetzt prüfen*) looks at invoices that are **sent**, have a due date in the past and a contact, and creates the next notice:

| Level | Default days after the due date | Fee | Time to pay |
| --- | --- | --- | --- |
| Zahlungserinnerung | 7 | 0 € | 7 days |
| 1. Mahnung | 21 | 5 € | 7 days |
| 2. Mahnung | 35 | 10 € | 5 days |

**Days are calendar days in the sub-account's time zone** (*Einstellungen → Firma*), never 24-hour blocks: an invoice due on
5 October counts as 1 day overdue from midnight on 6 October, whatever the hour on the invoice, and 0 days on the due day
itself – the same count drives the levels, the *Tage überfällig* in the lists, the interest days, the reports' *Überfällig*
and the workflow trigger *Rechnung überfällig*.

Levels, days, fees, deadlines and texts are editable; there are always three. A notice has the amounts (invoice, fees of earlier notices, fee, interest, flat fee, total) and a **PDF**; the e-mail contains the link to the PDF (`/mahnung/<token>/pdf`) and to the invoice's payment page. Placeholders: `{{invoice.number}}`, `{{invoice.total}}`, `{{invoice.due}}`, `{{invoice.url}}`, `{{notice.total}}`, `{{notice.fee}}` (this level's fee), `{{notice.prior_fees}}` (fees of the earlier notices), `{{notice.fees}}` (both), `{{notice.deadline}}`, `{{notice.pdf_url}}`.

**The claim grows with the levels.** A fee that was charged with an earlier notice is still owed, so a later notice claims it again as *Mahngebühren früherer Schreiben* – the 2. Mahnung of the defaults asks for invoice + 5 € + 10 € (+ interest, + flat fee between businesses). Only notices that actually went out count (one waiting for approval, failed or discarded adds nothing). Interest runs on the open invoice amount only, never on fees, and the 40 € flat fee is part of each notice once, not added up. If you set each level's fee as the total so far, switch *Mahngebühren früherer Schreiben in späteren Mahnungen mitfordern* (`carry_fees`) off.

**Betrieb:**

- **Aus** (default) – nothing is created. *Jetzt prüfen (Trockenlauf)* shows what would be due.
- **Mit Freigabe** – due notices wait under *Wartet auf Freigabe* (and you get a push message). Check the numbers, edit the text, **send** or **discard**. A notice goes out once: a second *Jetzt senden* while it is on its way (a double click, a colleague, a workflow step) is refused.
- **Automatisch** – due notices are sent right away.

Always in force: at least *Mindestabstand* days between two notices of one invoice (calendar days like the days overdue: with 3, a notice sent at 23:00 on 1 October allows the next one from midnight on 4 October, not only from 23:00), an optional minimum amount (compared with what is still **open**, so a short payment that leaves a few cents does not trigger a notice), **Mahnstopp** per invoice (e.g. a payment agreement), and the moment an invoice is paid pending notices are withdrawn. Every step is in the audit log. A notice that cannot be sent (no e-mail address, DND) shows the reason and can be sent again.

## Default interest and fees

With *Verzugszinsen berechnen* the notice adds interest from the due date: **base rate + 5 percentage points for consumers, + 9 for businesses** (§ 288 Abs. 1–2 BGB), from the level you choose. Between businesses the **40 € flat fee** (§ 288 Abs. 5 BGB) can be added. A customer counts as a business when the contact has a company (or you fix it to *immer Verbraucher/Unternehmen*).

> **Keep the base rate current.** The *Basiszinssatz* is published by the Bundesbank and changes on **1 January and 1 July**. HyperLevel does not look it up – the value in the settings (default 1,27 %) is your responsibility. Check it twice a year.
>
> This is not legal advice. Fees and interest must fit your contract; against consumers dunning fees are only allowed up to the costs actually incurred. Ask your lawyer when in doubt.

## Workflows, API and MCP

**Triggers:** *Zahlung fehlgeschlagen (Abo/Rate)* (`dunning.started`), *Mahnwesen: Zahlung endgültig fehlgeschlagen* (`dunning.final_failed`), *Mahnwesen: Zahlung nachträglich eingegangen* (`dunning.recovered`) – with a product filter; and *Mahnung zu Rechnung versendet* (`invoice.dunning_sent`, filter for a level). Event data includes `{{event.billing_url}}`, `{{event.product.name}}`, `{{event.amount_cents}}`, `{{event.attempts}}`.
**Actions:** *Karten-Update-Link senden* (`dunning_send_link`: the billing link by e-mail or SMS) and *Mahnung zur Rechnung senden* (`invoice_dunning_send`: send at once or put it in the approval list).

**API** (area `payments`):

| Route | |
| --- | --- |
| `GET/PUT /api/dunning/settings` | `{settings: {sub, inv}, defaults}`; PUT takes a partial document. |
| `GET /api/dunning/overview` | Counters, Stripe state, the events the webhook needs. |
| `GET /api/dunning/cases?status=`, `GET …/cases/:id` | Cases (`open`, `failed`, `recovered`, `closed`) with history. |
| `POST /api/dunning/cases/:id/remind \| retry \| close \| access` | Case actions. |
| `POST /api/dunning/billing-link` | `{contact_id, send?: "email"\|"sms"}` → `{url, expires_at}`. |
| `GET/PUT /api/dunning/products[/:id]` | What customers may do on the billing page. |
| `GET /api/dunning/notices?status=`, `PATCH …/:id`, `POST …/:id/send \| resend \| dismiss`, `GET …/:id/pdf` | Notices. |
| `GET /api/dunning/invoices`, `POST …/invoices/:id/notice \| hold`, `GET /api/dunning/preview`, `POST /api/dunning/run` | Overdue invoices, hold, preview, run (`{dry_run}`). |

**MCP tools:** `ghl_dunning_overview`, `ghl_dunning_send_link`, `ghl_dunning_run`, `ghl_dunning_notice`. **Mobile (read-only):** `GET /api/mobile/creator/dunning` ([docs/api.md](api.md)).

## Limits and good to know

- A case needs the Stripe webhook; without it HyperLevel does not know about failures. Invoice dunning works without Stripe.
- Only invoices (not offers) with status *sent*, something open and a due date are dunned. Credit notes, cancelled invoices and invoices credited in full never are; pending notices are withdrawn when an invoice is paid, cancelled or credited down to nothing.
- Dunning notices and the card-update messages are service messages: they are sent even when a contact has *Nicht stören* switched on (they are not marketing). SMS is optional and off by default.
- The PDF is generated on the server without extra libraries; the link in the e-mail is an unguessable token.
- Mahnwesen sends facts and amounts from your invoice – it never invents debts. Review the texts once before switching to *Automatisch*.
