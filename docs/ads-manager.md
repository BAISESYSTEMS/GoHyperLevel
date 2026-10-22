# Ads manager (Meta & Google Ads)

Create, review and run ad campaigns for **Meta (Facebook and Instagram)** and **Google Ads** without leaving HyperLevel. The wizard builds the campaign, the review screen shows exactly what will be created, and everything goes live **paused**. Switching a campaign on and changing a budget are the only steps that spend money, and both need a person to confirm them – automations, API keys, MCP clients and the HyperLevel Agent can only ask.

Where: **Marketing → Anzeigen** (tabs *Kampagnen*, *Zielgruppen*, *Lead-Formulare*, *Regeln*, *Verbindungen*). Reporting (spend, CRM leads, cost per lead, ROAS per campaign) is the existing ads report – see [docs/growth.md](growth.md); the manager reuses it. Training for the team: **Akademie → Anzeigen: Meta & Google**.

What you get:

- **Connect** Meta and Google with a normal sign-in, then pick the ad account (and for Meta the Page and pixel) per sub-account.
- **Wizard** with five steps: goal, budget and schedule, audience, ad, review. Meta: website traffic/conversions, reach, and **Lead Ads** with an instant form created from HyperLevel. Google: **Search** (responsive search ads) and **Performance Max** basics.
- **Audiences** from smart lists (customer lists uploaded as SHA-256 hashes), Meta lookalikes, Google Customer Match, interests and locations from the platforms' own targeting search.
- **Creatives** from the media library or the KI-Studio, texts with AI suggestions (your own AI connection, character limits respected), call-to-action, link to a HyperLevel funnel page with UTM parameters added automatically.
- **Leads** from Meta instant forms become contacts (webhook, plus a poll every 10 minutes as a fallback) and start workflows.
- **Manage:** campaign list with metrics, pause/resume, budget change, duplicate, rules such as "pause when the cost per lead is above 25 €".
- **Safety:** paused by default, review hash, spend confirmation, approvals, daily limit, audit log (details below).
- **Offline conversions** back to Google Ads (won deals, forms, bookings, paid invoices; gclid/gbraid/wbraid plus hashed e-mail/phone for enhanced conversions for leads) – only with the contact's marketing consent.
- **MCP tools** `ghl_ads_accounts`, `ghl_ads_create_campaign`, `ghl_ads_update_status`, `ghl_ads_update_budget`, `ghl_ads_insights`, and endpoints for the native app.

## Connect Meta

HyperLevel talks to the **Marketing API** (Graph API `v25.0`, see [API versions](#api-versions)). The agency creates a Meta app once; every sub-account then signs in with its own Facebook login, so the client's ad account stays the client's.

### Agency: the Meta app (once per installation)

1. Open [developers.facebook.com/apps](https://developers.facebook.com/apps) → **Create app** → use case *Other* → type **Business** → connect it to your Business Portfolio. (If you already created an app for [WhatsApp, Messenger and Instagram](meta-channels.md) you can reuse it: one app can carry all products.)
2. **Add products:** *Marketing API* and *Facebook Login for Business* (or *Facebook Login*).
3. **Facebook Login → Settings → Valid OAuth Redirect URIs:** add `https://<your-domain>/oauth/ads/meta/callback`. If the office is also reachable on an agency domain, add that address as well – the box **Agentur: Zugänge für alle Sub-Accounts** (below) lists every URI to register.
4. **App settings → Basic:** copy the **App ID** and **App Secret**.
5. In HyperLevel open **Marketing → Anzeigen → Verbindungen** and scroll to **Agentur: Zugänge für alle Sub-Accounts** (admin only) and enter App ID and App Secret. The secret is sealed with the server secret and never sent back to the browser. Self-hosters can set `PGHL_META_APP_ID` and `PGHL_META_APP_SECRET` instead; saved values win over the environment.

### Per sub-account: connect and choose

**Anzeigen → Verbindungen → Mit Meta verbinden.** Tick **Lead-Formulare** first if you want Lead Ads. Facebook asks for these permissions:

| Permission | Why |
| --- | --- |
| `ads_management` | create and change campaigns, ad sets, ads, audiences |
| `ads_read` | read reporting and campaign state |
| `business_management` | find the ad accounts and Pages of the Business Portfolio |
| `pages_show_list`, `pages_read_engagement`, `pages_manage_ads`, `pages_manage_metadata`, `leads_retrieval` | only if you tick **Lead-Formulare**: create instant forms, subscribe the Page to leads, read the leads |

Then pick the **ad account**, the **Facebook Page** the ads run as, optionally the **pixel**. HyperLevel exchanges the short-lived login for a long-lived token (about 60 days) and extends it automatically before it runs out; if Meta revokes it, the connection shows *neu verbinden* and nothing is changed behind your back. Disconnecting revokes the grant at Meta where possible and deletes the stored tokens and the cached reporting numbers; campaigns already created at Meta stay as they are (pause them first if you want them off).

### Development mode, roles and App Review

- **Development mode (the app is not live):** the app works for people who have a **role in the app** (admin, developer, tester) and for ad accounts and Pages those people own or manage. That is enough for your own agency's ad accounts and for testing everything in this document.
- **Serving other businesses:** as soon as a client who has no role in your app signs in, Meta requires **Advanced Access** for `ads_management`, `ads_read`, `business_management` and (for Lead Ads) the page permissions. Request it under **App Review → Permissions and features**, switch the app to **Live**, and complete **Business Verification** of your Business Portfolio. For `ads_management` Meta additionally asks for a minimum amount of successful Marketing API calls in a period before Advanced Access can be requested (shown in the review dialog; the threshold changes, so look it up there) – making calls in development mode with your own accounts counts.
- Provide Meta with a screencast of the flow (connect → wizard → paused campaign), the privacy policy URL and the data deletion URL. HyperLevel deletes stored tokens on disconnect.
- Meta apps and permissions change; the current rules are in the [Marketing API docs](https://developers.facebook.com/docs/marketing-api).

## Connect Google Ads

HyperLevel uses the **Google Ads API** over REST (`v25`, see [API versions](#api-versions)). Three things come from the agency once: a Google OAuth app, a **developer token** and, if you manage clients under a manager account, the **login customer ID**.

### Agency: OAuth app, developer token, manager account

1. **Google Cloud project:** create or reuse the project of your Google OAuth app (the same one that serves Gmail/Business Profile/Sheets). Enable the **Google Ads API** in *APIs & Services → Library*.
2. **OAuth client** (type *Web application*): add the redirect URI `https://<your-domain>/oauth/ads/google/callback`. The client ID and secret are the agency's Google app under **Agentur → Integrationen** (or `PGHL_GOOGLE_CLIENT_ID` / `PGHL_GOOGLE_CLIENT_SECRET`); the ads manager reuses them.
3. **OAuth consent screen:** add the scope `https://www.googleapis.com/auth/adwords`. It is a *sensitive* scope: while the consent screen is in *Testing*, only listed test users can sign in; for real clients publish the app and go through Google's verification.
4. **Developer token:** sign in to a Google Ads **manager account** (MCC; create one for free at ads.google.com/home/tools/manager-accounts) → **Tools → API Center** → apply for a token. Access levels (Google can rename or change them, check the API Center):
   - **Test account access** – every new token. It works with **test accounts only**; real accounts answer with `DEVELOPER_TOKEN_NOT_APPROVED`. Enough to try the whole flow: create a test manager account and test client accounts in the Google Ads help center.
   - **Explorer / Basic access** – needed for real accounts. Apply in the API Center (company details, a description of the tool, the design document or screenshots of the flow); the review can take a few days.
   - **Standard access** – higher quotas, only if you outgrow Basic.
5. In HyperLevel **Anzeigen → Verbindungen → Agentur: Zugänge für alle Sub-Accounts** enter the **developer token** and, if clients sit under your manager account, the **login customer ID** (10 digits, the MCC). Environment alternative: `PGHL_GOOGLE_ADS_DEVELOPER_TOKEN`, `PGHL_GOOGLE_ADS_LOGIN_CUSTOMER_ID`.

### Per sub-account

**Anzeigen → Verbindungen → Mit Google verbinden** → sign in with the Google account that has access to the client's Google Ads account → choose the **customer account** from the list (every account the login reaches). HyperLevel stores only the refresh token (sealed) and the chosen customer ID. If the chosen account is a client of the agency's manager account, that manager is used as login customer ID automatically; for any other manager the ID can be entered per connection (`PUT /api/ads/connections/google/selection` with `login_customer_id`).

Manual connections made before this feature (customer ID, developer token, refresh token typed in under **Einstellungen → Werbung**) keep working for reporting; to manage campaigns, connect via the button so the token carries the `adwords` scope.

## Build a campaign

**Anzeigen → Neue Kampagne.** Nothing exists at Meta or Google until the last step; the draft is saved in HyperLevel and can be edited, duplicated or deleted.

1. **Goal and platform.** *Leads*, *Besucher* (traffic), *Conversions* or *Reichweite* (reach, Meta only). Meta: *Website* or *Sofortformular*. Google: *Suche* (RSA) or *Performance Max*.
2. **Budget and schedule.** Daily or lifetime budget in the account currency, start and end date. A lifetime budget needs an end date. Google campaigns always run on a daily budget, so a lifetime budget is spread over the days of the run. The sub-account's **daily limit** (default 500 per day, a lifetime budget counts per day) caps any budget.
3. **Audience.**
   - *Meta:* countries, regions, cities and ZIP codes (searched live at Meta), age, gender, **interests** (targeting search), **custom audiences** and **lookalikes** from HyperLevel. Advantage+ audience expansion is switched off so the targeting is what you set. For EU targeting Meta requires the beneficiary and payer of the ads (DSA); the wizard has a section for both and falls back to the Page name with a warning.
   - *Google:* **keywords** with match types (broad, phrase, exact), negative keywords, locations (Geo Target IDs from the suggestion search), languages, and **Customer Match** lists.
4. **Ad.** Image or video from the media library or the KI-Studio, primary text, headline, description, call-to-action and the destination: pick a funnel page (UTM parameters are added automatically) or paste an https URL. **KI-Vorschläge** writes variants with your own AI connection (BYOK) and respects the platform limits: Meta: primary text is cut after about 125 characters, headline after about 40 (review warnings); Google RSA: 3–15 headlines up to 30 characters and 2–4 descriptions up to 90; Performance Max: at least 3 headlines, 1 long headline (up to 90), 2 descriptions (one up to 60), a business name (up to 25) and three images – landscape 1.91:1, square 1:1 and a logo 1:1. *Lead Ads:* choose or create the **instant form** (questions, privacy policy link, thank-you screen) in the *Lead-Formulare* tab.
5. **Review.** Every setting as it will be sent, the ad preview, the destination with the UTM parameters spelled out, warnings (small audience, missing pixel, text too long) and errors that block publishing. **Pausiert anlegen** creates campaign, ad set(s) and ad(s) at the platform with status **paused**.

### Tracking

Links get `utm_source` (`facebook` for Meta, `google`), `utm_medium` (`paid_social` / `cpc`) and `utm_campaign`. On Meta the values are set as `url_tags` with the `{{campaign.name}}`, `{{ad.name}}` and `{{adset.name}}` macros (campaign name, `utm_content` = ad, `utm_term` = ad set), so renamed ads still report under the right name; on Google a tracking template adds `{campaignid}` and `{keyword}`. Parameters the link already has are kept, and a link that already carries `utm_source` is left alone. The attribution module picks them up, so **Anzeigen**, [attribution](growth.md) and the ads report connect without further setup. Untick *UTM-Parameter automatisch anhängen* in the ad step if you need a bare link.

## Safety model

Ad platforms bill in real money, so the manager is deliberately strict.

- **Everything is created paused.** Campaigns, ad sets and ads reach Meta and Google with status *PAUSED*. Nothing runs, nothing is billed.
- **Review hash.** Publishing sends the hash of the reviewed spec. If the draft changed after the review (or the ad account changed), publishing answers `409` and the review has to be redone – what you approved is what gets created.
- **All or nothing.** Meta calls run in order (campaign, ad set, creative, ad); if one fails, everything created so far is deleted again. Google runs one atomic `mutate`.
- **Switching on and budget changes need a confirmation.** A signed-in person (web or app) gets a confirmation dialog that states the effect – *"Kampagne „X“ einschalten: bis zu 20,00 €/Tag"* or *"Tagesbudget von 20,00 € auf 35,00 € ändern"* – and the call carries `confirm: true`. Without it the server answers `409` with that sentence. Pausing is free and never asks.
- **Automations only ask.** API keys, agency keys, MCP clients and the HyperLevel Agent can create drafts (and pause), but a request to activate or change a budget never runs: it creates an **approval** (pending for 24 hours, one per campaign and change). A person approves or rejects it under **Anzeigen → Freigaben** (`POST /api/ads/approvals/:id/approve|reject`, humans only). The log records who asked (via which channel) and who approved.
- **Daily limit.** No budget above the sub-account limit (**Anzeigen → Verbindungen → Tageslimit**, default 500 in account currency; `PUT /api/ads/settings` with `max_daily_budget_cents`). Typos and over-eager agents hit the limit, not your card.
- **Rules can only pause or notify** – never switch on or raise a budget.
- **Audit log.** Every connect, publish, status change, budget change, approval, rule hit, audience upload and lead-import switch is written to the audit log (**Agentur → Protokoll**) and shown in the activity list of the ads manager.
- **Humans only:** connecting accounts, the agency settings, audience uploads and approvals are not available to API keys, agents or MCP; the HyperLevel Agent cannot reach `/api/ads/agency` or `/api/ads/connect` at all.
- **Isolation:** every row is bound to its sub-account; a client sees only its own connection, campaigns, audiences, leads and activity.

## Audiences from smart lists

**Anzeigen → Zielgruppen → + Zielgruppe.** Pick a smart list and a platform; the preview shows how many contacts can be sent, how many have no e-mail/phone and how many are opted out. You must tick that these contacts agreed to the use of their data for advertising (`consent: true`) – the upload is refused without it.

- Contacts with **Nicht stören** are never sent.
- Only **SHA-256 hashes** leave HyperLevel – no plain e-mail or phone numbers. Values are normalised first, per platform:
  - *Meta* (schema `EMAIL, PHONE, FN, LN, CT, ZIP, COUNTRY`): e-mail trimmed and lower-cased; phone reduced to digits with country code (no `+`, no leading `00`/`0`); names lower-case without punctuation and digits; ZIP without spaces and dashes; country as lower-case ISO alpha-2.
  - *Google Customer Match:* e-mail lower-cased (for `gmail.com`/`googlemail.com` also without dots and `+tags`), phone in E.164 including the `+`; address data only when first name, last name, country and ZIP are all present. Consent is sent as granted for ad user data and personalisation.
- Lists are uploaded in batches. **Jetzt übertragen** re-syncs a list with the smart list's current members (it adds, it does not remove people who left; the consent tick is asked again). **Löschen** removes the audience at the platform too, and is refused while a campaign uses it or lookalikes were made from it.
- **Lookalikes (Meta):** from a ready customer list, choose country and similarity (1–20 %). Meta needs a source list of at least 100 matched people from the target country; smaller lists produce an error from Meta.
- Google only lets you use a Customer Match list in Search campaigns after the list is large enough and the account is eligible (account history and policy compliance); the audience tab shows the platform's state.

## Lead Ads and lead import

Meta **instant forms** keep the lead on Facebook/Instagram until your system fetches it. HyperLevel fetches every lead and creates a contact.

1. **Anzeigen → Verbindungen → Mit Meta verbinden** with the option **Lead-Formulare** ticked (adds the page permissions and `leads_retrieval`), choose the Page.
2. **Anzeigen → Lead-Formulare → Lead-Import einschalten** (the *+ Formular* button creates instant forms). HyperLevel subscribes the Page to the `leadgen` field of your app (keeping whatever it already gets, such as `messages`) and starts polling.
3. **Webhook (agency, once per app):** in the Meta app open **Webhooks → Page** and set the **Callback URL** to `https://<your-domain>/hooks/ads/meta` and the **Verify Token** shown under **Agentur: Zugänge für alle Sub-Accounts**; subscribe to the `leadgen` field. (The same app can keep its WhatsApp/Messenger callback at `/hooks/meta/<locationId>`; leadgen events arriving there are handled too.) Every delivery is checked with the `X-Hub-Signature-256` header against the app secret; unsigned or wrongly signed deliveries are rejected with `401`, and the lead data is always fetched from Meta with the Page token – the payload itself is never trusted. A lead is routed only to the sub-account that owns the Page.
4. **Polling fallback:** every 10 minutes HyperLevel asks Meta for new leads of every form of the Page, so a missed webhook costs a delay, not a lead. **Jetzt abholen** does it on demand.

For each lead HyperLevel creates or updates the contact (matched by e-mail or phone like every contact import), maps `full_name`, `first_name`, `last_name`, `email`, `phone_number`, `company_name`, `city`, `zip_code`, `street_address`, `country` and `date_of_birth`, stores other questions (and `job_title`, `state`, `gender` …) as custom fields, writes the answers into a note, adds the tags (default `meta-lead`, editable), records the activity, and sets the attribution (source `facebook` or `instagram`, medium `paid_social`, campaign name, ad and ad set as `utm_campaign`, `utm_content`, `utm_term`). Each lead is imported **once** (idempotent by lead ID).

**Workflow trigger:** *Neuer Lead aus Anzeige (Meta Lead Ads)* (`ads.lead`) with filters for form, campaign and platform. The event carries the contact, form, campaign, ad and the answers.

In development mode Meta only delivers leads for people with a role in the app; test with Meta's *Lead Ads Testing Tool* (developers.facebook.com/tools/lead-ads-testing).

## Google lead forms

*Ads → Leads → Leads aus Google-Lead-Formularen → Verbinden* gives the sub-account its own **webhook URL** and a **key** (shown once). In Google Ads, open the lead form asset → *Lead delivery* → *Webhook integration*, paste both and click *Send test data*. Every lead becomes a contact (full name, e-mail, phone, company, address fields; the other answers as custom fields, tag `google-lead`, test data additionally `test-lead`), gets the attribution `google / cpc` with the click id, and fires the trigger **„Neuer Lead aus Anzeige“** (`ads.lead`, `platform: "Google"`). A lead id is imported once; a wrong key gets `401`. No Google Ads API access is needed – Google pushes the leads. *Neuer Schlüssel* replaces the key, *Trennen* stops the intake. API: `GET /api/ads/google-leads`, `POST /api/ads/google-leads/enable|disable`; webhook `POST /hooks/ads/google-leads/<sub-account>`; MCP `ghl_google_lead_forms`. Module `server/modules/ads-google-leads.ts`.

## Manage campaigns

**Anzeigen → Kampagnen** lists campaigns created in HyperLevel and, after a periodic refresh, the ones created at Meta/Google directly (read-only metrics, status and budget changes work for them as well, referenced as `meta:<id>` / `google:<id>`). Columns: status, budget, spend, clicks, CTR, leads on the platform, **leads in the CRM** (attribution), cost per lead, revenue and ROAS for the chosen period – the same numbers as the ads report.

- **Pause / resume.** Pause is immediate. Resume asks for confirmation (see above).
- **Budget.** Change daily or lifetime budget (confirmation, daily limit).
- **Duplicate.** Copies the spec into a new draft (paused, not yet at the platform).
- **Delete.** Only drafts (and failed attempts) can be deleted in HyperLevel. A campaign that exists at the platform is deleted there (Meta Ads Manager / Google Ads) – HyperLevel only pauses it.
- **Rules** (*Regeln*): "when *metric* is above/below *value* over the last *N* days (and spent at least *X*), then *pause* or *notify*". Metrics: cost per lead, cost per click, CTR, spend, leads. Evaluated every 30 minutes with fresh numbers, a 24 h cool-down per rule and campaign, a dry run (*Probelauf*) that changes nothing. Every hit is logged and emits `ads.rule_triggered` for workflows (e.g. a Slack message or a task). Cost per lead counts CRM leads first, then platform leads; without any lead the spend counts as the cost.

## Offline conversions (Google Ads)

The Google counterpart of the Meta Conversions API: what happens in the CRM goes back to Google Ads as a conversion, so Smart Bidding learns from real deals instead of form fills. Where: **Attribution → Tracking & Werbekonten → Google Ads: Offline-Conversions**. It uses the Google Ads connection above (developer token, OAuth client, refresh token, customer id and login customer id – all sealed in `ads_accounts`); there is nothing else to enter but the conversion actions.

1. In Google Ads: **Ziele → Conversions → Neue Conversion-Aktion → Import → CRM / Dateien / andere Datenquellen → Conversions aus Klicks verfolgen** (for enhanced conversions for leads: turn them on in the conversion settings and accept the customer data terms). Open the action and copy its id (`ctId` in the address bar) or the resource name `customers/1234567890/conversionActions/987654321`.
2. In HyperLevel tick the events and paste the action per event:

| Event | Fires on | Value |
| --- | --- | --- |
| Deal gewonnen | a deal is set to *won* (`opportunity.status_changed`) | deal value and currency |
| Formular abgeschickt | `form.submitted` (optionally only some form ids) | fixed value (optional) |
| Termin gebucht | `appointment.booked` | fixed value (optional) |
| Rechnung bezahlt | `invoice.paid` | invoice total and currency |

3. **Prüflauf (validate_only)** sends the waiting conversions – or, if none are waiting, a sample with a hashed test e-mail – with `validateOnly: true`: Google checks credentials, the action and every field and stores nothing; the dialog lists Google's answer per row.

**What is sent** (`POST customers/{id}:uploadClickConversions`, `partialFailure: true`): the conversion action, the time in the account's time zone (`yyyy-mm-dd hh:mm:ss+hh:mm`), the contact's newest Google click id of the last 90 days from the attribution touches – exactly one of `gclid`, `gbraid` or `wbraid` –, value and currency, `orderId` (`deal_<id>`, `form_<submission>`, `booking_<id>`, `invoice_<id>`; Google drops a second upload with the same order id) and `consent.adUserData: GRANTED`. With **erweiterte Conversions für Leads** on, the contact's e-mail and phone go along as `userIdentifiers` – normalised as Google specifies (e-mail trimmed and lower case, dots before the `@` removed for gmail.com/googlemail.com; phone in E.164 with `+`, national numbers get +49) and **SHA-256-hashed**; leads without a click id are then uploaded on the hashes alone. Identifiers are never sent next to a `gbraid`/`wbraid` (Google refuses that). Nothing in clear text leaves the server, and the queue stores no hashes – they are computed at upload time.

**Consent:** nothing is uploaded unless the contact's consent ledger shows **Tracking & Cookies → Marketing: bestätigt** (from the cookie banner when the visitor became a contact, or recorded by hand with proof). It is checked when the event happens (no consent → the row is logged as *ohne Einwilligung* and never sent) and again right before the upload (a withdrawal in between stops it). Without the consent module nothing is sent.

**Queue and errors:** one row per order id and action (`ads_gconv_queue`), uploaded at once and from the scheduler in batches of up to 200. Google's partial-failure answer is split per row: accepted → *hochgeladen*; *already exists / duplicate order id* → done; *click not found yet*, *conversion action younger than 6 hours*, *Google busy* → retried after 5 min, 30 min, 2 h, 6 h, 12 h; everything else (expired click, unknown action, action not eligible …) → *Fehler* with Google's reason in German. A whole request that fails (network, `5xx`, expired login) retries the batch the same way. The protocol on the card shows each row with event, contact, click id kind and status; **Erneut** queues a row again (consent is checked again). Rows older than 180 days are deleted.

API (sub-account, area *Einstellungen*): `GET /api/ads/conversions` (settings, connection, counts), `PUT /api/ads/conversions` `{enabled, config: {enhanced_leads, currency, events: {deal_won|form_submitted|booking|invoice_paid: {enabled, action, value?, form_ids?}}}}` (an action may be given as its numeric id), `GET /api/ads/conversions/log`, `POST /api/ads/conversions/run`, `POST /api/ads/conversions/:id/retry`, `POST /api/ads/conversions/validate` → `{ok, sample, results: [{order_id, event, ok, code, message}]}`. Code: `server/modules/ads-conversions.ts`, `server/services/ads-gconv.ts` (normalisation, payload, partial-failure parser); Google is mocked in tests through `app.services.adsFetch`.

## MCP tools and the HyperLevel Agent

| Tool | Purpose | Spends money? |
| --- | --- | --- |
| `ghl_ads_accounts` | connected ad accounts (no credentials), daily limit, audiences, instant forms, pending approvals | no (read-only) |
| `ghl_ads_create_campaign` | create a **paused draft** and return the review; with `publish_paused: true` also create it paused at the platform | no – always paused |
| `ghl_ads_update_status` | `paused` immediately; `active` creates an approval for a person | not by itself |
| `ghl_ads_update_budget` | creates an approval for a person | not by itself |
| `ghl_ads_insights` | metrics per campaign (spend, clicks, leads, CPL, ROAS) with the IDs the other tools take | no (read-only) |

Amounts are in the account currency (`20` = 20 €). The HyperLevel Agent uses the same tools and routes; anything under `/api/ads/campaigns|audiences|leadforms|rules|approvals` counts as a sensitive action there and asks the person before it runs, on top of the approval described above.

## API

All routes are scoped to the sub-account (`X-Location` or the signed-in project) and need the *Kampagnen* permission; reporting reads need *Dashboard*, connection settings need *Einstellungen*. Full list with bodies in [docs/api.md](api.md).

- Connections: `GET /api/ads/connections`, `POST /api/ads/connect/:platform/start`, `GET /oauth/ads/:platform/callback` (public, state-signed), `GET /api/ads/connections/:platform/options`, `PUT …/selection`, `DELETE /api/ads/connections/:platform`, `GET|PUT /api/ads/settings`, `GET|PUT /api/ads/agency` (admin).
- Campaigns: `GET /api/ads/overview`, `POST /api/ads/review`, `GET|POST /api/ads/campaigns`, `GET|PATCH|DELETE /api/ads/campaigns/:id`, `GET …/review`, `POST …/publish` `{review_hash}`, `POST …/status` `{status, confirm?}`, `POST …/budget` `{amount_cents, type, confirm?}`, `POST …/duplicate`, `GET /api/ads/insights`, `POST /api/ads/suggest` (AI copy).
- Approvals and log: `GET /api/ads/approvals`, `POST /api/ads/approvals/:id/approve|reject`, `GET /api/ads/activity`.
- Audiences and targeting: `GET|POST /api/ads/audiences`, `GET …/preview`, `POST …/:id/sync|lookalike`, `DELETE …/:id`, `GET /api/ads/targeting/interests|locations`.
- Leads: `GET|POST /hooks/ads/meta` (public: handshake and signed deliveries), `GET /api/ads/leads/status`, `POST …/enable|disable|poll`, `PUT …/settings`, `GET /api/ads/leads`, `GET|POST /api/ads/leadforms`, `DELETE /api/ads/leadforms/:id`.
- Rules: `GET|POST /api/ads/rules`, `PATCH|DELETE /api/ads/rules/:id`, `POST /api/ads/rules/run` `{dry_run?}`.
- Offline conversions (Google): `GET|PUT /api/ads/conversions`, `GET /api/ads/conversions/log`, `POST /api/ads/conversions/run|validate`, `POST /api/ads/conversions/:id/retry` – see [Offline conversions](#offline-conversions-google-ads).
- Native app: `GET /api/mobile/ads` (campaigns with metrics and open approvals), `POST /api/mobile/ads/:ref/status` (pause; resume with the confirmation flag), `GET /api/mobile/ads/approvals`, `POST /api/mobile/ads/approvals/:id/approve|reject`.

**Events** (workflow triggers, outgoing webhooks): `ads.lead` (also the workflow trigger *Neuer Lead aus Anzeige*), `ads.rule_triggered`, `ads.approval_requested`, `ads.campaign_activated`, `ads.campaign_paused`. Connect, disconnect, publish, audience and settings changes are audit-log entries (`ads.connect`, `ads.disconnect`, `ads.campaign.publish`, …).

## Self-hosting checklist

1. `PGHL_BASE_URL` is a public **https** address (Meta and Google call back to it).
2. Meta app created, redirect URI `…/oauth/ads/meta/callback` registered, App ID/Secret saved (or `PGHL_META_APP_ID`, `PGHL_META_APP_SECRET`).
3. For Lead Ads: webhook `…/hooks/ads/meta` with the verify token from **Agentur: Zugänge für alle Sub-Accounts**, field `leadgen` subscribed.
4. Google Cloud project with the Google Ads API enabled, OAuth client with redirect URI `…/oauth/ads/google/callback`, scope `adwords` on the consent screen.
5. Developer token (test access to try, Basic after the application) and, for a manager account, its ID – saved under **Agentur: Zugänge für alle Sub-Accounts** or `PGHL_GOOGLE_ADS_DEVELOPER_TOKEN`, `PGHL_GOOGLE_ADS_LOGIN_CUSTOMER_ID`.
6. For image and video ads, uploads must be reachable from the internet (a public https base URL); videos are fetched by the platform from a signed media link.
7. Set a sensible **Tageslimit** per sub-account and try the whole flow with a test account (Google) or your own ad account (Meta, development mode) – everything stays paused.

Secrets: the Meta app secret, developer token, access and refresh tokens are sealed with the server secret (AES-256-GCM) and masked in every response.

## Limitations

- One image **or** one video per ad (no carousels, no catalog ads, no Stories-only placements). Placements are automatic.
- Meta *special ad categories* (credit, employment, housing, social issues/politics) are not supported; the wizard creates campaigns with none declared and tells you to use Ads Manager for restricted categories. The same applies to political advertising in the EU: Google campaigns are declared as *not* containing EU political advertising.
- Google: Search (RSA) and Performance Max basics – no Display, Video, Shopping or Demand Gen builders; Performance Max uses your images and texts without asset-group audience signals. A lifetime budget becomes a daily budget.
- Video ads need a public https base URL and a file the platform accepts (MP4/MOV, within Meta's size limits).
- Customer Match and custom audiences depend on the platform's own eligibility rules and minimum list sizes.
- Currencies: the account currency is used as is; HyperLevel does not convert.
- The reporting sync of the existing ads module keeps its own API version defaults; the manager pins its own, see below.

## API versions

Meta Graph API `v25.0` and Google Ads API `v25` are pinned in `server/services/ads-store.ts`. Both platforms retire old versions on a published schedule, so check the changelogs from time to time. Override per connection with `config.api_version` (for example `v26.0` or `v26`) if you need to move earlier than the next release; the payload builders only use fields that are stable across versions.

## Troubleshooting

| Message | Cause and fix |
| --- | --- |
| *Bitte bestätigen: …* (`409`) | A person must send the confirmation – use the dialog in the app. Keys, MCP and the Agent can only create an approval. |
| *Die Kampagne wurde seit der Prüfung geändert* (`409`) on publish | The draft or account changed after the review – open the review again. |
| Meta `(#200)` / `(#10)` permission errors | The login lacks `ads_management`, or the app is in development mode and the user has no role in the app, or Advanced Access is missing. |
| Meta `Ad account is disabled` / payment error | Meta needs a valid payment method on the ad account; fix in Meta Business Settings. |
| *neu verbinden* | Token revoked or expired (password change, removed app). Connect again. |
| Google `DEVELOPER_TOKEN_NOT_APPROVED` | The token still has test access: use a test account or apply for Basic access. |
| Google `USER_PERMISSION_DENIED` | The login has no access to the customer, or a login customer ID is needed (the manager account of the client). |
| Google `AUTHENTICATION_ERROR` after a while | The refresh token was revoked, or the consent screen is in *Testing* (refresh tokens of test users expire after 7 days). Publish the app, then reconnect. |
| No leads arriving | Check **Lead-Formulare → Status**: Page connected with the lead option, `leadgen` subscribed, callback URL and verify token in the Meta app; **Jetzt abholen** shows whether polling finds them. |
