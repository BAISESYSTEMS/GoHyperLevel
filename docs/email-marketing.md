**English** · [Deutsch](email-marketing.de.md)

# E-mail marketing: tests, segments, templates and deliverability

Campaigns with the depth of Klaviyo, ActiveCampaign or Brevo – without extra services. Everything is under **Campaigns**: the tab *Campaigns* (with A/B test, reminder and send time in the draft), *Segments*, *Template gallery*, *Templates*, *Deliverability* and *Trigger links*. The pages load on their own, so the rest of the app doesn't get any bigger.

- [Simple mode](#simple-mode)
- [A/B tests](#ab-tests)
- [Reminder to non-openers](#reminder-to-non-openers)
- [Send at the best time](#send-at-the-best-time)
- [Segments by behavior](#segments-by-behavior)
- [WhatsApp campaigns with templates](#whatsapp-campaigns-with-templates)
- [Abandoned cart](#abandoned-cart)
- [Template gallery](#template-gallery)
- [Deliverability](#deliverability)
- [Preference center in the footer](#preference-center-in-the-footer)
- [REST API and MCP](#rest-api-and-mcp)
- [For developers](#for-developers)

## Simple mode

In [simple mode](theming.md#einfach-modus), the campaign draft shows only name, channel, subject, content, smart list,
tags, test and sending. Behind **More fields** you find: sender name and *Text is HTML*, segment as well as “With any of these
tags”/“Without tags”, **A/B test & reminder to non-openers** and **Send time per contact & speed**. Each area
opens by itself as soon as something is set in it. In the e-mail designer, colors, spacing, alignment and
button look of a block, a section and the whole e-mail are under **Appearance** (open as soon as something differs from the
default). Pro mode shows everything as before.

## A/B tests

In the draft of an **e-mail campaign** → card **A/B test** → *Test subject or content*.

| Setting | Meaning |
| --- | --- |
| Variants | A (original) and 1–3 more. Each variant has a **subject**, optionally a **sender name** (the address stays the same) and optionally **its own content** (in the e-mail designer; *Design its own content* starts with a copy of the original). A variant has to differ from the original in something. |
| Test group | 5–50% of the recipients (default 20%), split equally among the variants. The groups are random but repeatable (the same draft gives the same distribution). Each variant needs at least 2 recipients, otherwise the campaign goes to everyone without a test (the reason is shown in the result). |
| Winner by | **Opens** (people), **clicks** or **revenue** (paid invoices of the contact in the 14 days after the e-mail). The comparison is per recipient, not the raw count. Machine opens (Apple Mail, Gmail image proxy, scanners) never count. |
| Wait time | 1 hour to 14 days (default 24 hours). |

**Flow:** when sending, the test e-mails go to the test group and all other recipients wait (status *waiting for the winner*, the campaign shows *A/B test running*). After the wait time, the server determines the winner and sends it to everyone who waited. On a tie, the next measure decides (clicks, then opens), then the smaller letter; without a single event, the original goes out.

**Result:** in the campaign, the card *A/B test: result* shows for each variant sent, opened, clicked, buyers, revenue and an assessment against the original (“clearly better”, “no clear difference”, “too early”, probability of being better). While the test is waiting, you can **determine the winner right away** (automatically, or fix a variant with “Send B”). After that, the decision is final. In the draft, *Test* sends a specific variant to a test contact if you want.

## Reminder to non-openers

Card **Reminder to non-openers** in the draft (or later on a running or sent campaign): new **subject**, time (1 hour to 30 days, default 72 hours after sending ends), optionally a different sender name.

- Those who received the e-mail and **did not open or click it as a person** are reminded. A mail program loading images in the background doesn't count as an open – so these readers are not skipped by mistake.
- The reminder becomes a campaign of its own (marked *Reminder* in the list). It goes out only once and doesn't remind again. Anyone who has unsubscribed in the meantime, set “Do not disturb” or withdrawn consent is skipped, as with any campaign.
- On a campaign that has finished sending, there is also **Send to non-openers now**. Without non-openers, no reminder is created (the reason is shown in the card).

## Send at the best time

Under *Sending* → **Send time** → *At the best time per contact*. Within 24 hours, each contact gets the e-mail in the hour in which they usually open e-mails.

- The basis is the **opens by people** (table `email_events`, no machine opens) of the last months – per contact an hourly distribution in the project's time zone, smoothed over the neighboring hours (a single open at 3 a.m. doesn't make a best time).
- **Fallback:** contacts without data of their own get the most popular hour of the whole project, and with no data at all the *default sending hour* (*Deliverability → Settings*, default 10 a.m.).
- Sending is spread with a fixed minute offset that differs per contact (no rush on the full hour). Anyone already in their hour gets the e-mail immediately; all others in the next matching hour, after 24 hours at the latest. The time is calculated once at the start (for A/B tests when the winner is sent).
- *Show distribution* shows beforehand how many recipients fall on which hour and how much data there is. Daylight saving changes are taken into account per month; in the middle of a month an hour may be off.
- Can be combined with scheduling (*Scheduled for*) and with the warm-up plan.

## Segments by behavior

**Campaigns → Segments** (REST: `/api/segments`). A segment is a saved audience made of **conditions**, combined with *all* (AND) or *at least one* (OR) – groups can be nested up to 4 levels (at most 60 conditions), and every condition and every group can be reversed with *not*. At the bottom, the segment shows **live** how many contacts match, with examples.

| Condition | Example |
| --- | --- |
| E-mail behavior | has opened / clicked / not opened / received – any campaign or a specific one, in the last N days |
| Purchase | has bought (a specific product) / not bought, in the last N days |
| Page visited | entry page of a visit contains `/preise`, in the last N days (from the visitor tracking of [attribution](growth.md): funnels, websites, links with UTM) |
| Form | has submitted / not submitted a specific form |
| Tag, contact field | tag present; field is / contains / starts with / empty / greater than / before a date …, also custom fields |
| Consent | consent for e-mail, SMS or WhatsApp exists / is missing (the verdict of the send gate) |
| Last activity, created | within the last / longer ago than N days; never active |
| Interest in e-mails | active in the last N days / never opens although at least X e-mails arrived |
| Address check, Do not disturb | address is OK / risky / invalid / unchecked; has “Do not disturb” |
| Other segment | is a member of another saved segment |

**Quick starts** in the dialog: *Clicked but did not buy*, *Not opened for a long time*, *New on the list*, *Visited the pricing page, did not buy*, *Active readers*.

**Using them:**
- **In campaigns:** card *Recipients* → *Segment (behaviour)*. The segment is combined with tags and smart list (everything has to apply). The send gate applies as always: consent, “Do not disturb” and address check still come first.
- **In workflows:** triggers **Contact enters a segment** and **… leaves a segment** (`segment.entered`, `segment.left`). For this, turn on *Watch joins and leaves* on the segment; membership is recalculated every 5 minutes. When you turn it on (and after a changed definition), today's members are only noted and trigger nothing.
- *Start campaign* creates a draft from the segment right away; *View contacts* lists the members.

A segment can't be deleted while it is used by a draft, a scheduled or running campaign, an active workflow or another segment. If it is removed anyway, a campaign reaches nobody with it (never everyone).

## WhatsApp campaigns with templates

Channel **WhatsApp** in the campaign. What is sent is a **template approved** by Meta (the connection and the templates come from *Settings → Channels*, see [meta-channels.md](meta-channels.md)). The values for the template's placeholders may contain merge fields (`{{contact.first_name|du}}`).

- The server reads the **category** from Meta; it never comes from the browser. **Marketing** templates are advertising: only contacts with valid **WhatsApp consent** get the message (the [send gate](consent.md)). **Service templates (Utility)** need no advertising consent – “Do not disturb” and missing numbers stay excluded, though. **One-time-code templates (Authentication)** can't be sent as a campaign.
- Missing or unapproved templates, unfilled placeholders and a missing connection are rejected before sending with a clear message. The recipient count shows how many are skipped because of missing consent.
- Speed, scheduling and segments apply as with e-mail; A/B test, reminder and send time exist only for e-mail.

## Abandoned cart

Trigger **Checkout abandoned (abandoned cart)** (`checkout.abandoned`) and the workflow template **Abandoned cart series** (*Automations → New workflow*).

- Stripe reports `checkout.session.expired` when an unpaid payment page expires after 24 hours. **Enable this event in the Stripe webhook** (see [stripe.md](stripe.md)). Only product purchases of this project are considered, no invoice links.
- The contact is recognized by their e-mail address (from the checkout or the purchase link). Unknown addresses create a contact only if *Deliverability → Settings → Abandoned cart* allows it – default: no. Anyone who has bought the product in the meantime gets nothing.
- The **online store** ([store.md](store.md#abandoned-carts)) also reports `checkout.abandoned`: a cart with an e-mail address and no paid order after the set time (default 60 minutes). `{{event.recovery_url}}` then leads to the checkout with the cart, `{{event.source}}` is `store`.
- The contact gets the tag `warenkorbabbruch` (the purchase removes it again). The event contains `{{event.product_name}}`, `{{event.recovery_url}}` (link to the purchase page), `{{event.amount_cents}}` and `{{event.currency}}`.
- The template sends three e-mails from the template gallery (E-commerce: *Warenkorb: du hast etwas vergessen* (“Cart: you forgot something”), *noch unsicher?* (“still unsure?”), *letzte Erinnerung* (“last reminder”)) after 0, 2 and 5 days. After each wait, a goal checks whether the tag is still there; anyone who has bought in the meantime leaves the series. Advertising e-mails need valid consent here too.

## Template gallery

**Campaigns → Template gallery**: 60 ready-made, responsive German templates in 13 categories – Newsletter, Offer & discount, Welcome, Event & invitation, Webinar, Course & training, Invoice & payment, Holidays & seasons, B2B & sales, Coach & consulting, Trades & services, E-commerce, Feedback & reactivation.

- **Search** across name, description and keywords (umlaut-tolerant: “gruesse” finds “Grüße”); the numbers on the categories belong to the search.
- A click opens the **preview** (computer and smartphone, with sample data). *Create a new campaign with it* or *Save as your own template* (appears under *Templates*). In the campaign draft, *Choose from the gallery* takes the template into the current campaign (optionally with the template's subject).
- The templates are completely ordinary designs of the [e-mail designer](email-builder.md): you can change everything afterwards. They have preview text, a footer with address and unsubscribe link, sufficient contrast and large tap targets. *Sie* / *du* (formal/informal address) and *Service* (invoice, order – not advertising) are noted on the template.

## Deliverability

**Campaigns → Deliverability** (the check of SPF, DKIM and DMARC of the sender domain is in [deliverability.md](deliverability.md)).

**Reputation.** Bounce, complaint and unsubscribe rate of the campaign e-mails – overall, **per campaign, per recipient domain and per week** (30 days to 1 year):

| Value | Warning from | Critical from |
| --- | --- | --- |
| Bounces | 2% | 5% |
| Spam complaints | 0.1% | 0.3% |
| Unsubscribes | 0.5% | 1% |

Below 100 e-mails sent, rates are hardly meaningful (“too little data”); only several complaints warn early. Each warning says what to do. Unsubscribes are attributed to the last campaign e-mail the contact received in the 7 days before. The warning also appears in the campaign and in the sending window.

**Warm-up plan.** New sender domains need time. The plan (*Gentle* about 6 weeks from 20 e-mails/day, *Standard* about 4 weeks from 50, *Fast* about 2.5 weeks from 100) limits the **campaign e-mails per day** and raises the limit daily until normal operation. Campaigns stick to it when sending; whatever no longer fits goes out the next day, and contacts who opened e-mails most recently come first. If the values become critical, **the limit is halved**. *Pause* lifts the limit until you resume.

**List hygiene.**
- **Repeated soft bounces:** from 3 (adjustable 2–10) delivery failures in a row (90 days), the address is set to “Do not disturb” – automatically every hour or with a click (*Exclude all*).
- **Sunset segment:** contacts who have been receiving e-mails for N months (default 6) but never open or click, in an automatically created segment *Sunset: not opened for a long time* – optionally also with the tag `inaktiv`. Send a reactivation e-mail first, then clean up.

**Address check.** Checks spelling, whether the domain can receive e-mail (**MX**, with an A record as a fallback, “null MX” = invalid), **disposable domains**, **role addresses** (`info@`, `support@` …) and suggests a correction for typos in well-known domains (`gmial.com`). Result: *OK*, *risky* (arrives, but is a bad bet) or *invalid* (bounces). New contacts are checked in the background; campaigns leave out invalid addresses (adjustable for disposable and role addresses too). A DNS outage never makes an address invalid. *Tag invalid ones* gives them the tag *E-Mail prüfen* (“check e-mail”); *Check addresses by hand* tests up to 200 addresses immediately. The DNS queries only run on the running server (tests and offline runs check spelling and word lists).

**Settings:** soft-bounce limit, automatic exclusion, months until “inactive”, rules of the address check, default sending hour, abandoned cart for unknown addresses.

## Preference center in the footer

The [preference center](consent.md) (choose topics and channels instead of unsubscribing completely) is linked automatically in campaign e-mails **next to “Unsubscribe”** as long as *Settings → Consent → Advertising e-mails link the preferences page* is on. In the designer, the link text can be changed in the footer block (*Preferences link*); if you set your own link with `{{preferences_url}}`, you don't get a second one. The unsubscribe link stays in any case; tracking doesn't redirect either link.

## Conditional content

In every e-mail, SMS, workflow message and document with placeholders, you can tie sections to conditions – in the e-mail designer, simply write it into a text block:

```
{{#if contact.tags has "VIP"}}Dein VIP-Rabatt: 20 %{{else}}Jetzt 10 % sichern{{/if}}
{{#if contact.city == "Köln"}}Besuch uns in der Ehrenstraße!{{/if}}
{{#if contact.custom.budget >= 5000}}…{{/if}}   {{#unless contact.phone}}Bitte Telefonnummer nachtragen.{{/unless}}
```

- **Operators:** `==`, `!=`, `contains`/`enthält` (text contains), `has`/`hat` (list contains – e.g. tags), `>`, `>=`, `<`, `<=` (numbers); without an operator the field only has to be filled, `not`/`!` in front reverses it. Case doesn't matter. A word operator is preceded by a space (`contact.tags has "VIP"`, not `contact.tagshas "VIP"`).
- Blocks may be nested and have `{{else}}`; an incomplete block stays as it is (the message never breaks). Templates over 2 million characters are not evaluated and go out unchanged.
- On websites there is the same with the parameters of the link: `{{#if url.quelle == "facebook"}}…{{/if}}` ([sites.md](sites.md#seo--access)).
- Technically: `services/template-conditions.ts` (parser, pure, linear: a hand-written tag scanner instead of a regex with backtracking, so a crafted template can't block the server), hooked in through `templatePass` in `core/template.ts` by `modules/template-conditions.ts`; tests in `tests/gaps-sites-marketing.test.ts` and `tests/sec-w10b-template.test.ts`.

## REST API and MCP

| Endpoint | Purpose |
| --- | --- |
| `GET /api/campaigns/:id/ab` | Results of the A/B test (variants, rates, assessment, status) |
| `POST /api/campaigns/:id/ab/winner` `{key?}` | Determine the winner now (automatically without `key`), while the test is waiting |
| `POST/DELETE /api/campaigns/:id/resend` | Set up the reminder to non-openers (`{subject, after_hours, sender_name?, now?}`) or remove it |
| `GET /api/campaigns/:id/sto` | Distribution of the sending hours for the current recipient selection |
| `PATCH /api/campaigns/:id` | additionally `ab`, `resend`, `send_mode` (`now`/`sto`), `sender_name`, `wa_template` `{name, language, values}`; `filter.segment_id` |
| `GET/POST /api/segments`, `GET/PATCH/DELETE /api/segments/:id`, `GET /api/segments/meta`, `POST /api/segments/count`, `GET /api/segments/:id/contacts`, `POST /api/segments/:id/count` | Segments; `count` counts an unsaved definition `{definition}` |
| `GET /api/email-gallery?q=&category=`, `GET /api/email-gallery/:key`, `POST /api/email-gallery/:key/use` `{target: 'template'\|'campaign', campaign_id?, name?}` | Template gallery |
| `GET/POST/PUT/DELETE /api/deliverability/warmup` | Warm-up plan (`{plan: conservative\|standard\|fast, domain?}`, `{paused}`) |
| `GET /api/deliverability/reputation?days=` | Rates per campaign, domain, week with thresholds and warnings |
| `GET/PUT /api/deliverability/settings` | Settings for hygiene, address check, send time, abandoned cart |
| `GET /api/deliverability/hygiene`, `POST …/hygiene/suppress`, `POST …/hygiene/sunset` | Soft bounces and sunset |
| `POST /api/email-validation/check` `{emails}`, `GET …/summary`, `POST …/scan`, `GET …/issues?verdict=`, `POST …/tag` | Address check |

MCP tools: `ghl_campaign_ab_results` (A/B result and reminder), `ghl_list_segments`, `ghl_segment_count`, `ghl_save_segment`, `ghl_email_gallery` (list, search, take over a template), `ghl_deliverability_report`. Permissions: area *Campaigns*; segments and gallery can be viewed by everyone with read access.

## For developers

Logic and database are separate, every function has its own module – no function lives in `server.ts` or in state.

| File | Contents |
| --- | --- |
| `server/services/mk-ab.ts`, `mk-resend.ts` | Configuration, split, winner (pure) and the numbers from the database |
| `server/services/mk-sto.ts` | Hourly distribution, smoothing, best time, send time per contact |
| `server/services/mk-segments.ts`, `modules/mk-segments.ts` | Validate the definition, translate it into **one** SQL condition, count, watching |
| `server/services/campaign-run.ts` | Sending loop: audience, split, warm-up limit, send time, WhatsApp, winner, reminder |
| `server/services/mk-warmup.ts`, `mk-reputation.ts`, `mk-hygiene.ts`, `mk-validate.ts`, `modules/mk-deliverability.ts` | Deliverability |
| `server/services/mk-whatsapp.ts` | Check of a campaign's WhatsApp template |
| `server/services/mk-gallery*.ts`, `modules/mk-gallery.ts` | Templates (building blocks, themes, 60 designs), search, preview |
| `server/modules/mk-abandoned.ts` | Trigger `checkout.abandoned` through `app.services.stripeTaps` and the workflow template |
| `web/src/pages/Segments.tsx`, `EmailGallery.tsx`, `Deliverability*.tsx`, `CampaignAb.tsx`, `CampaignExtras.tsx` | Interface (segments, gallery and deliverability are only loaded when the tab is opened) |

**Every recipient exactly once:** before sending, the recipient is reserved (status *sending*); a second sending run at the same time – “Send” and the scheduler – skips them. A campaign is only finished when nothing is waiting and nothing is in flight any more. A message that was in flight during a server restart is not repeated (the provider may have accepted it already): after 30 minutes it appears in the list as *Error* with “Versand unterbrochen” (“sending interrupted”).

Tests: `tests/mk-*.test.ts` (A/B winner, reminder, send time, segments and counting, abandoned cart, warm-up limits, thresholds, address check, WhatsApp, gallery, preferences link) and tenant isolation in `tests/tenant-isolation.test.ts` (seeds in `tests/security-fixtures.ts`).
