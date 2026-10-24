**English** · [Deutsch](growth.de.md)

# Growth: attribution, affiliates & ad reports

Three modules that work together:

- **Attribution** – where leads, customers and revenue come from (UTM, gclid/fbclid, referrer, entry page), first and last touchpoint on the contact, report per source/campaign/funnel. Without Google Analytics, without Meta Pixel: everything runs through your own server.
- **Affiliate manager** – partners promote with their own link (`?ref=<code>`), earn commission on sales and see their numbers in a small partner area.
- **Ad reports** – spend, clicks and leads from Meta Ads and Google Ads (read-only, daily), linked with attribution into cost per lead (CPL) and ROAS. Optionally the Conversions API reports leads and purchases back to Meta.
- **Ads manager** – create campaigns for Meta and Google Ads right in HyperLevel (paused, with a check and confirmation), manage them and fetch leads from lead ads as contacts. The manager sets UTM parameters automatically, the numbers appear in the same ad report – see [docs/ads-manager.md](ads-manager.md).

Menu: **Attribution** (under *Marketing*) and **Affiliates** (under *Revenue*). Permissions: the report belongs to the area *Dashboard*, tracking and ad account settings to *Settings*, affiliates to *Invoices & products*.

## Attribution

### What is captured

| Where | How |
| --- | --- |
| Funnel and website pages | On each request, the server reads UTM parameters (`utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`), click IDs (`gclid`, `gbraid`/`wbraid`, `fbclid`, `msclkid`, `ttclid`, `li_fat_id`), affiliate code (`ref`) and the referrer. The page gets a signed visitor token that forms, embedded appointment bookings, purchase links and the live chat send along. |
| Purchase links `/buy/…` | like funnel pages; the token runs through Stripe Checkout up to the purchase |
| Forms `/f/…` | the UTM parameters of the page the form is on |
| Appointment booking, live chat | token or the address of the page the booking or chat runs on |
| other websites (WordPress & co.) | with the script under *Attribution → Tracking & ad accounts* (see below) |

Without UTM: click ID → source of the ad platform (`google / cpc`, `facebook / social` …), known search engine → `organic`, social network → `social`, other website → `referral`, nothing at all → `(direkt)`. An affiliate link without UTM appears as `affiliate / affiliate`.

On the **contact** (card *Origin*) you find the first and last touchpoint with campaign, funnel and time, and below it the whole history. “Last touch” is the last *non-direct* visit before conversion (someone who first comes via Google and later types the address stays attributed to Google).

### Report

*Attribution → Report*: period (with 7/30/90 days and “Year”), grouped by **source**, **source / medium**, **campaign** or **funnel**, attributed by **first** or **last touch**. Per row: new leads (contacts created in the period), won deals with deal value (by the day they were won), paying customers and revenue (paid invoices incl. Stripe, by payment date). **CSV** downloads the table (with BOM, opens in Excel with umlauts intact).

Contacts without data (import, manual, without consent) appear as `(unbekannt)`.

### Filtering contacts & smart lists

In **Contacts** there are (as soon as data exists) filters for source and campaign, either first or last touch only; `(ohne Herkunft)` shows contacts without data. “Save filter” creates a smart list – campaigns to that smart list use the same filter. Via the API: `GET /api/contacts?attr_source=google&attr_campaign=Sommer&attr_touch=first`.

### UTM parameters in ads

- **Meta Ads** (ad → *URL parameters*): `utm_source=facebook&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_content={{ad.name}}`
- **Google Ads** (account → *Tracking template*): `{lpurl}?utm_source=google&utm_medium=cpc&utm_campaign={campaignid}` – auto-tagging (`gclid`) can stay on in addition.

For the ad reports, `utm_campaign` must match the **campaign name** or the **campaign ID** (case doesn't matter).

### Embedding other websites

```html
<script src="https://<your-domain>/a/<locationId>/t.js" async></script>
```

The script (ready to copy under *Tracking & ad accounts*) reports the visit to `/api/public/attribution/<locationId>/touch`, stores the token only with consent in a cookie of its own on **this** website, and attaches it to links and iframes to forms (`/f/`), appointment bookings (`/book/`) and purchase links (`/buy/`); the live chat reads it as well.

Consent from your cookie banner:

```js
window.pghlConsent = true;        // before the script, or later:
pghl.consent(true);               // yes – the cookie is set
pghl.consent(false);              // no – the cookie is deleted
// alternatively the banner sets a cookie pghl_consent=1 (yes) or 0 (no)
```

### Consent on funnel pages

For security reasons, funnel pages run in a sandbox – scripts on the page can't set cookies there. That's why:

- Tick **“Show own small notice with ‘Agree / No’ on funnel pages (only with ‘Only with consent’)”**: a plain notice with *Agree / No, thanks* at the bottom of every funnel page (only in the mode “Only with consent” and as long as no choice has been made yet).
- or your own banner links to `<website>/pghl-consent?v=1` (yes) or `?v=0` (no), optionally with `&r=/page` as the return path (only paths on the same website). On the app domain the path is `/p/<funnel>/pghl-consent`, for purchase links `/a/consent?v=1&r=/buy/…`.
- **HyperLevel's cookie banner** (*Settings → Consent & legal → Cookie banner*, [docs/consent.md](consent.md#cookie-banner-cmp)) replaces the small notice: if it is turned on, only **one** banner appears. The visitor cookie `pghl_vid` is set when *Statistics* or *Marketing* is allowed; the choice is stored in the cookie `pghl_cmp` (with `pghl_consent` as a short form) and logged.

### Settings

*Attribution → Tracking & ad accounts → Tracking*:

| Setting | Effect |
| --- | --- |
| Capture origin | off = nothing is captured |
| Visitor cookie | **Only with consent** (default), **Always** (only with a legal basis of your own), **Never** |
| Cookie lifetime | 1–730 days, default 90 |
| Notice banner | see above |

## Privacy (GDPR, TDDDG)

- **No third-party tracking.** No third-party scripts are loaded; all data is in your database.
- **Cookie `pghl_vid`:** a random ID (no name, no e-mail), first-party, `HttpOnly`, `SameSite=Lax`, adjustable lifetime. It is **not** technically necessary – under § 25 TDDDG (formerly TTDSG) it needs consent. That's why “Only with consent” is the default. Choose “Always” only if you can properly justify another legal basis.
- **Cookie `pghl_consent`:** stores only the choice (yes/no), and is technically necessary for that.
- **Without consent**, nothing is stored on the device: the token exists only in the page that was opened. If someone submits a form on it, the origin of *this* visit is attributed to the new contact (the visitor sends the data along with the form). Direct visits without a cookie leave no record.
- **No means no:** with `pghl_consent=0` or Global Privacy Control enabled (`Sec-GPC: 1`, without an explicit yes), the visit isn't captured at all.
- **Data minimization:** entry page and referrer are stored without the query string (it sometimes contains e-mails or tokens). Visits that didn't turn into a contact are deleted by the app after the cookie lifetime expires. Link previews and crawlers are ignored.
- **Deletion:** when a contact is deleted, their whole origin history disappears with it (right to erasure).
- **Privacy policy**, suggested wording: *“We store on our own server which ad or website led you to us (campaign parameters, referring page, entry page). With your consent (Art. 6(1)(a) GDPR, § 25(1) TDDDG) we set a cookie of our own with a random identifier for this (lifetime 90 days). Data is not passed on to third parties.”* – plus the paragraphs on Meta Conversions API and affiliate program, if used.
- **Conversions API (Meta):** transmits e-mail, phone and name as a SHA-256 hash, as well as the click ID, to Meta. That is a transfer of personal data to Meta (USA, joint controllership) and needs **consent** and a note in the privacy policy. Off by default; when on, only contacts that came through Meta ads **and** whose consent “Tracking & cookies → Marketing” is confirmed (cookie banner or recorded by hand) are sent – as with the offline conversions for Google Ads. Without consent, the conversion appears in the list as *blocked*.
- **Offline conversions (Google Ads):** transmits click ID (gclid/gbraid/wbraid), value and – with enhanced conversions for leads – e-mail and phone as a SHA-256 hash to Google. HyperLevel only uploads contacts whose consent “Tracking & cookies → Marketing” is confirmed (checked at the event and right before the upload) and reports them with `consent.adUserData: GRANTED`. Don't forget the note in the privacy policy. Setup: [docs/ads-manager.md](ads-manager.md#offline-conversions-google-ads).
- **Ad reports** read only aggregated campaign numbers – no personal data.
- **Affiliate program:** the partners' name, e-mail and bank details are stored for settlement (Art. 6(1)(b) GDPR). Partners never see names or e-mails of the customers they referred, only date, type and amount of the commission.

## Affiliate manager

### Setup

1. **Affiliates → Programs → + Program**:
   - **Commission** as a percentage of net revenue or as a fixed amount per sale,
   - **Counts:** last or first click,
   - **Cookie lifetime** (how old the click may be at most when the lead arrives; the visitor cookie itself follows attribution, so set the lifetime there at least as long),
   - **Subscription renewals** (recurring commission yes/no),
   - **Payout from** (minimum amount), **holding period** (0 = approve by hand, otherwise automatically after N days, e.g. 14 for the right of withdrawal),
   - **Target link** of the partner links (empty = your first funnel), public sign-up, activate immediately, terms.
2. Share the **sign-up link** (`https://<domain>/affiliate/<program>/join`) or create partners by hand under *Affiliates → + Affiliate*. Every partner is also created as a contact with the tag `affiliate`.
3. Partners sign in to the **partner area** `https://<domain>/affiliate/<program>` with their e-mail (login link, valid for 30 minutes, single use, its own cookie – separate from admin and member logins). For this, SMTP sending must be set up under **Settings → Email & SMS**; *Send login link* on the affiliate sends it by hand.

In the partner area: personal link and code, clicks, leads, sales, commission open/approved/paid out, list of commissions and payouts, own payout details (IBAN or PayPal).

### How counting works

- **Click:** a request to a funnel/website page, a purchase link or a page with the tracking script with `?ref=<code>` of an active partner. The same visitor or the same connection counts at most once in 24 hours; clicks from the connection the partner last signed in with don't count. Visitor ID and connection hash of a click are deleted after two days; the click itself (page, referrer, counted) stays for the numbers.
- **Lead:** the visitor becomes a contact (form, appointment, chat, purchase) and has a partner click within the cookie lifetime. Once referred stays referred.
- **Self-referral** (same contact or same e-mail as the partner) isn't counted and appears in the activity.
- **Commission:** every paid invoice of a referred customer – set to paid by hand, paid through Stripe or bought through a purchase link – creates a commission (status *open*). Subscription renewals (Stripe subscription, recurring invoices) only if the program allows it. Each invoice counts only once.
- **Cancellation, refund, credit note:** a Stripe refund (`charge.refunded`, subscribe to it in the Stripe webhook in addition), a cancelled invoice or a **credit note / invoice correction** for the invoice → an open/approved commission is cancelled, and for a partial refund or partial credit note it is reduced proportionally (for credit notes in proportion to the credited net amount; a credit note that was already written before payment counts right when the commission is created). If the commission was already paid out or is in an open payout, it stays as it was, and a negative **chargeback** is created that is offset against the next payout – never more than was paid out. A refund and a credit note for the same money don't count twice (the larger reduction applies). A subscription cancellation only ends future commissions.

### Approving and paying out

1. *Commissions* (filter “Open”) → tick → **approve** (or automatically through the holding period).
2. *Payouts* → **Create payouts**: bundles all approved commissions per partner as soon as the total reaches the payout threshold.
3. Download the **CSV** (all open payouts with IBAN/PayPal) or **SEPA file** (`pain.001.001.03`, execution the next day) and upload it in online banking. The SEPA file uses your IBAN/BIC from **Settings → Invoices**; PayPal partners are only in the CSV.
4. After the transfer, click **Paid out** – the commissions then show as *paid out*.

Also: *Credit note / correction* for manual entries (also negative), *Cancel* for individual commissions.

### Workflows

Triggers **“New affiliate”** (`affiliate.created`) and **“Commission created”** (`affiliate.commission_created`); `contactId` is the partner's contact in each case (e.g. welcome e-mail, “You've earned commission”). Data: `affiliateId`, `programId`, `affiliate.{name, email, code, status, link, portal}` or `commissionId`, `amount_cents`, `kind`, `customerId`, `invoiceId`.

## Ad reports (Meta Ads & Google Ads)

*Attribution → Tracking & ad accounts*. All keys are stored encrypted and never sent back to the browser. The app fetches the last 7 days every day (30 the first time), because the platforms correct numbers retroactively; “Fetch 30 days” and “Fetch now” are available at any time.

### Meta Ads

1. [Meta Business Suite](https://business.facebook.com/settings) → *Users → System users* → create a system user (the Employee role is enough), assign the **ad account** to it (permission *View ad account*).
2. *Generate token* for your Meta app with the permission **`ads_read`**, expiry “Never”.
3. Enter in the app: **ad account ID** (`act_1234567890` or just the digits) and the **token**. “Test connection” fetches the last 7 days.

What is read is `GET /v23.0/act_<id>/insights` (campaign level, per day): spend, impressions, clicks and leads (action `lead`). The API version can be changed if needed through `api_version` in `PUT /api/ads/accounts/meta`.

**Conversions API (optional):** enter the pixel/dataset ID from the Events Manager and tick the box; the token above then also needs access to the dataset (or you enter a separate CAPI token, Events Manager → Settings → *Generate access token*). What is sent is `Lead` (first contact from a form, appointment or chat) and `Purchase` (every paid invoice, with amount) as `action_source: system_generated` with hashed e-mail/phone/name, `external_id` and – if present – `fbc` from the `fbclid`. Each conversion goes out exactly once (`event_id` `lead_<contact>` / `purchase_<invoice>`); with the **test code** they appear under *Test events*. The “Sent conversions” list shows status and errors. Privacy: see above.

### Google Ads

The Google Ads API needs four things – set them up once, then it runs:

1. **Developer token:** Google Ads (manager account/MCC) → *Tools → API Center*. For your own accounts, “Explorer”/“Basic” access is enough; a test token only reads test accounts.
2. **OAuth client:** [Google Cloud Console](https://console.cloud.google.com) → create a project → enable the *Google Ads API* → *APIs & Services → Credentials → OAuth client ID* (type “Web application”, authorized redirect URI `https://developers.google.com/oauthplayground`). Note the client ID and client secret.
3. **Refresh token** (without a login form of its own, manually): [OAuth 2.0 Playground](https://developers.google.com/oauthplayground) → gear icon → *Use your own OAuth credentials* → enter client ID/secret → on the left enter the scope `https://www.googleapis.com/auth/adwords` → *Authorize APIs* with the Google account that has access to the ad account → *Exchange authorization code for tokens* → copy the **refresh token**. (If the OAuth consent screen is set to “Testing”, the token expires after 7 days – set it to “In production”.)
4. **Customer ID** of the ad account (`123-456-7890`, top right in Google Ads); if access runs through a manager account, also its ID as the **manager account ID**.

What is read is `googleAds:searchStream` (API `v21`, changeable through `api_version`): cost, impressions, clicks and conversions per campaign and day.

### CPL and ROAS

*Attribution → Ads: CPL & ROAS*: per campaign spend, clicks, CTR, leads according to the platform, **leads in the CRM** (contacts whose `utm_campaign` matches the campaign's name or ID – for Meta campaigns with source facebook/instagram, for Google with source google), **cost per lead** (spend ÷ CRM leads), **revenue** (paid invoices of these leads in the period) and **ROAS** (revenue ÷ spend). Above it, the spend per day. Leads count by last (default) or first touch, as you choose.

## API

| Area | Endpoints |
| --- | --- |
| Attribution | `GET /api/attribution/report?from&to&group=source\|source_medium\|campaign\|funnel&model=first\|last`, `GET /api/attribution/report.csv` (same parameters), `GET /api/attribution/sources`, `GET /api/contacts/:id/attribution`, `GET/PUT /api/attribution/settings` `{enabled, cookie: consent\|always\|never, cookie_days, banner, banner_text}`; filter `GET /api/contacts?attr_source&attr_medium&attr_campaign&attr_touch=first\|last` |
| Affiliates | `GET/POST /api/affiliates/programs`, `PATCH/DELETE /api/affiliates/programs/:id`, `GET/POST /api/affiliates` (`?program_id&status`), `PATCH/DELETE /api/affiliates/:id`, `POST /api/affiliates/:id/login-link`, `GET /api/affiliates/overview`, `GET /api/affiliates/commissions?status&affiliate_id`, `POST /api/affiliates/commissions` `{affiliate_id, amount_cents, note}`, `POST /api/affiliates/commissions/approve` `{ids}`, `POST /api/affiliates/commissions/:id/reverse`, `GET/POST /api/affiliates/payouts`, `POST /api/affiliates/payouts/:id/paid`, `DELETE /api/affiliates/payouts/:id`, `GET /api/affiliates/payouts/export.csv?ids=`, `GET /api/affiliates/payouts/sepa.xml?ids=` |
| Ads | `GET /api/ads/accounts`, `PUT/DELETE /api/ads/accounts/meta\|google`, `POST /api/ads/accounts/:platform/test`, `POST /api/ads/sync` `{platform?, days?}`, `GET /api/ads/report?from&to&model`, `GET /api/ads/capi-log` |
| Public | `GET /a/<locationId>/t.js`, `POST /api/public/attribution/<locationId>/touch` `{url, referrer, token?, consent?}`, `GET /a/consent?v=1\|0&r=`, `<website>/pghl-consent?v=1\|0&r=`, partner area `/affiliate/<program>` (+ `/join`, `/login`, `/auth`) |

MCP tools: `ghl_attribution_report` (leads, deals, revenue per source/campaign/funnel) and `ghl_list_affiliates` (partners with numbers, without bank details).
