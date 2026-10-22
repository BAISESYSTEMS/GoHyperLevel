# Consent & legal: provable opt-ins, cookie banner, legal texts, checkout rules

HyperLevel keeps a **consent ledger** per contact, channel and purpose, can ask for a **double opt-in**, checks the ledger before every advertising message (**send gate**), shows a **preference centre**, runs its own **cookie banner** (CMP, no third party), generates **drafts of the legal pages** (Impressum, Datenschutzerklärung, Widerrufsbelehrung, AVV, VVT) and adds the German **checkout rules** to buy pages.

> **No legal advice.** Everything in this area – texts, defaults, the way the status is derived – is a **template** for German and EU law (DSGVO Art. 6/7/13/28/30, UWG § 7, TDDDG § 25, BGB §§ 312j/312k/356, DDG § 5). It was written carefully, but it is not checked by a lawyer and cannot know your business. Have your Impressum, Datenschutzerklärung, AVV, consent texts and checkout texts reviewed by a lawyer or your data-protection officer before relying on them. The UI says the same on every page of this area.

- [Where to find it](#where-to-find-it)
- [The consent ledger](#the-consent-ledger)
- [Double opt-in](#double-opt-in)
- [The send gate](#the-send-gate)
- [Where consent comes in](#where-consent-comes-in)
- [Proof, export and the preference centre](#proof-export-and-the-preference-centre)
- [Cookie banner (CMP)](#cookie-banner-cmp)
- [Legal text generators](#legal-text-generators)
- [Checkout rules (Germany)](#checkout-rules-germany)
- [API and MCP](#api-and-mcp)
- [Data protection of the proof itself](#data-protection-of-the-proof-itself)
- [Open legal points](#open-legal-points)
- [For developers](#for-developers)

## Where to find it

| What | Where |
| --- | --- |
| Rules, double opt-in, overview, events, text versions | *Einstellungen → Einwilligung & Recht → Einwilligung* |
| Cookie banner editor with live preview and log | … → *Cookie-Banner* |
| Company data, services, document wizard | … → *Rechtstexte* |
| Buy page rules and stored acceptances | … → *Checkout* |
| Proof of one person | a contact → *Einwilligung* |
| Opt-in of a form | a form → *Einstellungen → Einwilligung für Werbung* |
| "Service-Nachricht (keine Werbung)" | a workflow step *E-Mail senden* / *SMS senden* |

The Akademie has a tour for it (*Einwilligung & Recht*).

## The consent ledger

Every statement is an **event** that is only ever added, never changed. The status is **derived** from the events.

**Channels:** `email`, `sms`, `whatsapp`, `phone`, `tracking` (the cookie banner writes here once a visitor becomes a contact).

**Purposes:** `newsletter`, `marketing`, `webinar`, `community`, `transactional`, `statistics`, `external_media`. The purpose `*` means "all purposes of this channel" (used by *unsubscribe* and legacy rows).

**Actions:** `granted`, `confirmed` (double opt-in clicked), `revoked`, `declined`, `expired` (a confirmation request ran out), `reset`, `legacy`.

**Fields of an event:** source (form, funnel, webinar, community, import, api, manual, unsubscribe, preferences, doi, checkout, cmp, system) with a label, time, **IP network** (only /24 for IPv4 and /48 for IPv6, never the full address), **user-agent hash** (first 16 hex digits of a SHA-256), the **consent text** as a version (`consent_texts`: the same wording is the same version, a changed wording is a new one – old events keep pointing at the old text), a **proof link** (the page where the box was ticked), a note and who recorded it.

**Status per channel and purpose:**

| Status | Meaning |
| --- | --- |
| `confirmed` | Consent given and, where double opt-in was asked, confirmed |
| `pending` | Consent given, confirmation still outstanding (the link is valid) |
| `revoked` | Withdrawn (or *Nicht stören*) |
| `unknown` | Nothing recorded. *Altbestand* (legacy) = no history of its own: e. g. contacts that existed before this feature or came in by an import without proof. A confirmation request that **expired** is `unknown` too, but **not** legacy |

For a channel the best status of the relevant purposes counts: `confirmed` before `pending` before `revoked` before `unknown`. A later event beats an earlier one of the same purpose. **DND keeps working**: *Nicht stören* counts as revoked for every channel, and a new `confirmed` from the person themselves (form, confirmation link, preference centre) lifts DND again; a team member's entry never does.

## Double opt-in

Settings: *Einwilligung & Recht → Einwilligung → Double-Opt-in*, **per sub-account** and overridable **per form**.

- **Sources** that ask for confirmation: forms, funnels and websites, webinar registration, community sign-up, imports and the API. Defaults: forms and funnels **on**, the rest off.
- **The mail** has a subject and text you can change. Placeholders: `{{contact.first_name}}`, `{{location.name}}`, `{{confirm_url}}`, `{{purpose_text}}`, `{{expires}}`, `{{consent_text}}`. `{{confirm_url}}` has to be in the text.
- **Nothing is measured before the consent** (§ 25 TDDDG, GDPR): the confirmation mail and its reminder carry **no tracking pixel and no tracked links**, whatever the [tracking settings](email-tracking.md#settings) say, and **no "Abmelden" footer** – it is a service mail, there is nothing to unsubscribe from yet (the footer names the company only).
- **The link** is signed (HMAC with the server secret), carries its expiry and opens a page with a **button** – only the button (a POST) confirms, so mail scanners that open links confirm nothing. Texts, button and the redirect after confirming are editable; the page is `noindex`, `no-store`, sends no referrer.
- **Reminder** after *X* hours (default 48, `0` = none), **expiry** after *Y* hours (default 168). An expired request creates an `expired` event; the person then needs to sign up again. Revoking cancels open requests.
- **Triggers and timeline:** workflow triggers `consent.confirmed` (filter by channel and purpose; fires immediately without double opt-in, otherwise after the click) and `consent.revoked`; every step appears on the contact's timeline.
- A first mail is tried up to four times; a mail that cannot be sent never counts as consent.

## The send gate

*Einstellungen → Einwilligung & Recht → Einwilligung → Versandregel für Werbung*:

| Rule | Who gets advertising |
| --- | --- |
| **Bestätigte Kontakte und Altbestand ohne Nachweis** (default, nothing changes for existing lists) | `confirmed` and legacy `unknown`. Not: `pending`, `revoked`, expired requests, DND |
| **Nur Kontakte mit bestätigter Einwilligung** (recommended) | only `confirmed` |

What is gated: **campaigns** (e-mail and SMS), **workflow steps** *E-Mail senden* / *SMS senden*, WhatsApp **marketing templates**, advertising **sequences**, and surveys and review requests – German courts count asking for feedback as advertising (BGH VI ZR 225/17): the **NPS** survey, the **satisfaction survey (CSAT)** after a ticket (also when it is sent again by hand) and **review requests** (by hand, from the workflow step *Bewertung anfragen* and from the API). For e-mail the purposes `newsletter` and `marketing` count, for SMS, WhatsApp and phone `marketing`. The workflow step *DND je Kanal* stops e-mail, SMS and WhatsApp on its own channel.

What is **not** gated: **service messages** – a workflow step with *Service-Nachricht (keine Werbung)* ticked, invoices, appointment mails, the double opt-in mail, replies in a conversation, messages a person writes by hand. They are marked `exempt` / `conversation`, so you can see what the system treated as advertising. A test mail to a team member is marked `override`.

Every message carries `purpose` (`marketing`, `transactional`, `conversation`) and `consent_basis` (`confirmed`, `legacy`, `exempt`, `override`, `blocked`). A blocked send is stored as skipped with the German reason, in campaigns per recipient, and the campaign page shows how many were skipped for missing consent.

The inquiry acknowledgment of the workflow recipe *Neuer Lead* is a service message; its follow-up is advertising and gated.

## Where consent comes in

| Source | How |
| --- | --- |
| **Forms** and funnel forms | Form → *Einstellungen → Einwilligung für Werbung*: switch on, pick the consent field (type *Einwilligung*), purposes, extra channels (SMS/WhatsApp), double opt-in *inherit / on / off*. Only a **ticked** consent field counts, its label is stored as the text. The plain "I agree to the processing" box is not an opt-in for advertising. A form on a funnel page is recorded as source *Funnel* with the page as proof link |
| **Webinar registration** | the consent box (and the SMS reminder box) of the registration page |
| **Community sign-up** | the consent box of the join page |
| **CSV import** | choose *Altbestand ohne Nachweis* (default; one `legacy` event with your source note), *Einwilligung liegt anderweitig vor* (events with the note you give) or *Double-Opt-in anfragen* (everybody gets the confirmation mail). Fields: `consent` (`legacy`, `confirmed`, `doi`), `consent_note`, `source_label` |
| **API** | `POST /api/contacts` with `consent: true` or `{ channels, purposes, doi, text, proof_url, note }` |
| **By hand** | the contact's *Einwilligung* tab: *Einwilligung erfassen* (needs the source note, e. g. "am Telefon am 12.03.") or *Widerruf erfassen* |
| **Unsubscribe link and preference centre** | a revoke event |

## Proof, export and the preference centre

- **Proof per contact** (contact → *Einwilligung*): status per channel and purpose, all events with source, time, text version (the wording is shown), IP network, proof link, open requests. **Export as PDF or CSV** (CSV with BOM for Excel). The same proof is part of the **DSGVO-Auskunft** (privacy export).
- **Preference centre** `/consent/p/<contact>/<token>` (signed link): the person switches channels and purposes on and off; every change is an event with source *Einstellungsseite*. Advertising mails link it in the footer next to *Abmelden* (switch off under *Einwilligung → Werbe-Mails verlinken die Einstellungsseite*); the placeholder `%%preferences_url%%` puts the link anywhere in a mail. Preference-centre links are not routed through click tracking.
- The **unsubscribe** page offers the preference centre after unsubscribing.

## Cookie banner (CMP)

*Einstellungen → Einwilligung & Recht → Cookie-Banner.* Our own consent manager for **funnels and websites, booking pages, forms, buy pages, community pages and customer portals**. Switched off by default.

- **Categories:** *Notwendig* (always on), *Statistik*, *Marketing*, *Externe Medien* – off until the visitor decides. Reject is as easy as accept (same look, one click), and the banner works without JavaScript.
- **Script blocking:** add `type="text/plain"` and `data-category="statistics|marketing|external_media"` to a script – it only runs after consent. Embeds (`<iframe data-category="external_media" data-src="…">`) show a placeholder with a button until allowed. YouTube, Vimeo, Google Maps and common trackers are recognised; **unknown third-party scripts** are blocked until *Marketing* is allowed (switchable). Scripts you write into the head code or HTML blocks are handled; HyperLevel's own visitor statistics (the `pghl_vid` cookie) follow *Statistik* or *Marketing*.
- **Google Consent Mode v2:** `ad_storage`, `ad_user_data`, `ad_personalization`, `analytics_storage` start as `denied` and are updated after the choice (inserted right after `<meta charset>`).
- **Choice and proof:** cookie `pghl_cmp=v<version>.<bits>.<id>` (180 days by default, 1–395), plus the compatibility cookie `pghl_consent`. Every decision is logged pseudonymously (version, choice, page, IP network, browser hash) and kept **3 years**; when the visitor later becomes a contact the choice goes into the ledger on the channel *Tracking*. A **Sec-GPC** signal is respected until the visitor decides.
- **Re-open and withdraw:** a small button (switch off if you like) and any `<a href="#cookie-settings">` link open the banner again. A changed wording or category creates a **new version** and everybody is asked again (or press *Alle neu fragen*).
- **Texts, colours, layout** (card left/middle/right, bar, centred dialog) are editable with a live preview. Links to your Datenschutzerklärung and Impressum are shown in the banner.
- **One banner only:** it replaces the older information line of the visitor statistics.

Not covered: the banner is added to pages HyperLevel serves. Forms or booking pages **embedded in another website** (iframe) get no banner of their own – the host page needs its own. Webinar-room videos from YouTube/Vimeo are not controlled by the banner.

## Legal text generators

*Einstellungen → Einwilligung & Recht → Rechtstexte.* Pure templates, no external call:

- **Company data** (prefilled from the sub-account) → *Rechtsform, Firma, Vertretung, Anschrift, Kontakt, Register, USt-ID, Verantwortliche/r (§ 18 MStV), Datenschutz, Streitbeilegung*. What is missing shows in the text as **`[bitte ergänzen: …]`** and in the list "Noch zu ergänzen" – nothing is invented.
- **Documents:** *Impressum*, *Datenschutzerklärung* (**module-aware**: it only names what you use – forms, funnels, webinars, community, calendars, e-mail tracking and the banner, Stripe, WhatsApp/Meta, tickets, affiliates, Google reviews, mailboxes, HR; plus trackers and embeds it finds in your page code. Wrong detection? Override per service), *Widerrufsbelehrung* (digital / service / goods, with the model form), *AVV* (Art. 28 DSGVO draft with TOMs and sub-processors, for customers whose data you process) and *VVT* (Art. 30 draft).
- **Output:** preview, **PDF, HTML, Markdown, plain text**, copy to the clipboard. Every export carries the "keine Rechtsberatung – bitte prüfen" notice.
- **Hosted copy:** `/legal/<sub-account>/impressum|datenschutz|widerruf` – used by forms, buy pages and the checkout; not published before company name and a way to reach you are set.
- **Websites:** a new website from the template gets prefilled Impressum and Datenschutz pages instead of "Hier einfügen"; for existing ones *In eine Website übernehmen* creates or replaces the pages (only where the placeholder text still stands, unless you overwrite) and links them in the footer together with *Cookie-Einstellungen*.
- **eRecht24 (optional, placeholder):** enable it and enter project and API key; **nothing is called** unless a module registers a provider (`app.services.legalTexts.providers`). By default HyperLevel's own templates are used. The key is stored encrypted and never shown again.
- **For other modules** (the hosted service's sign-up, for instance): `app.services.legalTexts` – `profile(locationId)`, `facts(locationId)`, `generate(locationId, kind, opts)`, `render(doc, format)`, `hostedUrl(locationId, kind)`, `prefill(...)`, `kinds`, `notice`.

## Checkout rules (Germany)

*Einstellungen → Einwilligung & Recht → Checkout.* Applies to buy pages (`/buy/<key>`) and what they open:

- **Button:** "zahlungspflichtig bestellen" (§ 312j Abs. 3 BGB) – replaces "Jetzt kaufen" / "Jetzt abonnieren". You can reword it, but it has to say *zahlungspflichtig/kostenpflichtig* plus an order verb, otherwise the setting is refused.
- **AGB:** with an AGB address set, a **required checkbox**; the version of the text and the time are stored with the order.
- **Widerruf:** link to your Widerrufsbelehrung (the hosted one by default). For **digital content** and **services** a second required checkbox asks for the start before the end of the withdrawal period (§ 356 Abs. 4/5 BGB); the exact wording, its version, time and IP network are **stored with the order** (*Gespeicherte Zustimmungen*). Type per product or as default: none, digital, service, goods.
- **VAT note** under the button: *§ 19 UStG* for small businesses (from the invoice settings) or "inklusive gesetzlicher Umsatzsteuer"; "Keine Versandkosten" for digital offers.
- After the purchase a **confirmation mail** repeats AGB and waiver (durable medium) and adds a note to the contact's timeline. Switch off if your invoice mail does that.

Switch the whole thing off with *Regeln auf Kaufseiten anwenden*; without the AGB address no AGB box appears.

## API and MCP

| Route | Purpose |
| --- | --- |
| `GET/PUT /api/consent/settings` | policy, double opt-in settings |
| `GET /api/consent/overview`, `/log`, `/texts`; `POST /api/consent/texts` | numbers, events, text versions |
| `GET/POST /api/contacts/:id/consent` | status and events; `{action: granted|revoked|reset, channel, purposes, note, text, proof_url, doi}` |
| `GET /api/contacts/:id/consent/proof` | full proof (JSON) |
| `POST /api/contacts/:id/consent/doi` | send / resend the confirmation request |
| `GET /api/contacts/:id/consent/export.csv`, `export.pdf` | proof export |
| `GET/PUT /api/cmp/settings`, `POST /api/cmp/reask`, `POST /api/cmp/preview`, `GET /api/cmp/log` | cookie banner |
| `GET/PUT /api/legal/profile`, `GET /api/legal/services`, `POST /api/legal/generate`, `GET /api/legal/export?kind=&format=`, `POST /api/legal/funnels/:id/apply` | legal texts |
| `GET/PUT /api/checkout-law/settings`, `GET /api/checkout-law/acceptances` | checkout rules |
| public: `/consent/confirm/<token>`, `/consent/p/<contact>/<token>`, `/legal/<sub-account>/<kind>` | confirmation page, preference centre, hosted legal pages |

All of them belong to the permission area *Einstellungen* and work inside the sub-account only. MCP tool: `ghl_contact_consent` (read-only proof of a contact).

## Data protection of the proof itself

- Minimised on purpose: IP **network** instead of the address, a **hash** of the user agent, the text as a **version**.
- **Erasure** of a contact deletes its ledger and open requests (the generic contact erase). Acceptances at checkout stay as accounting evidence but lose e-mail, IP network and browser hash. The cookie log is pseudonymous and deleted after 3 years.
- The privacy export contains the raw rows and a readable summary ("Einwilligungsnachweis").
- A proof link is stored only as a plain `http(s)` address or path and shown as a link; form and funnel captures store the page without query string or fragment.

## Open legal points

Decide these with your lawyer; HyperLevel does not claim to settle them:

1. **Confirmation mails to imported or hand-typed contacts** without prior contact can themselves be unsolicited advertising (UWG § 7). Use *Double-Opt-in anfragen* for imports only where there is a legal basis to ask.
2. The **waiver confirmation on a durable medium** relies on the confirmation mail of the checkout; invoices and their archiving belong to the invoice module.
3. The **Kündigungsbutton** for contracts concluded online (§ 312k BGB) is **not** covered.
4. **YouTube/Vimeo in the webinar room** and forms/booking pages embedded as iframes in a foreign site are not covered by the banner.
5. After an **erasure** the ledger is deleted; keeping a minimal proof for the defence of legal claims is not implemented.
6. **Legacy contacts** (policy *Altbestand*) are your risk: no proof exists. Switch to *Nur bestätigt* when your lists are clean.
7. WhatsApp: the marketing/service distinction follows the **template category** you chose at Meta.
8. All generated texts are **drafts**.

## For developers

Modules (each registers itself in `server/modules/index.ts`, none of them is called from another feature except through hooks):

| Module | Does |
| --- | --- |
| `consent.ts` | ledger tables (`consent_texts`, `consent_events`, `consent_doi`), routes, triggers, MCP tool, DOI tick, privacy export hook |
| `consent-capture.ts` | `app.services.consent.captureForm/captureWebinar/captureCommunity/importBatch/captureApi` |
| `consent-pages.ts` | public confirmation page and preference centre |
| `consent-banner.ts` | cookie banner: `cmp_log`, HTML transform, routes, `app.services.cmp` |
| `legal-pages.ts` | profile, facts, generators, hosted pages, `app.services.legalTexts` |
| `checkout-law.ts` | `checkout_acceptances`, buy-page boxes, button label, acceptance storage |

Logic is in `server/services/consent-model.ts` (pure: derivation, gate decision, signing, minimisation), `consent.ts`, `consent-proof.ts`, `cmp.ts` (pure), `legal-texts.ts` (pure), `legal-pdf.ts`.

Hooks on `app.services`:

- `consentGate({locationId, contact, channel, purpose, bulk, ignoreDnd, messageId, source})` → `{blocked?: string}` – called by `sendToContact` in `services/messaging.ts` and the WhatsApp sender. Pass `purpose: 'transactional'` for service messages and `purpose: 'marketing'` for advertising.
- `consent.*` – the capture hooks, `statusOf`, `allowMarketing(Many)`, `grant/revoke/reset`; callers use `?.` so the module stays optional.
- `cmp` – `attributionConsent`, `linkCmp`; `attribution.ts` asks it before it sets a cookie.
- `htmlTransforms` (core, `app.ts`) – a list of `(ctx, html) => html` applied to public GET pages (the banner uses it; wrap your own code in try/catch – a throw is swallowed and the page goes out unchanged).
- `buyButtonLabel(product, location)`, `buyPageHtml`, `buyCheckout` – checkout rules.
- `legalTexts` – see above.

Tests: `tests/consent-model.test.ts`, `consent.test.ts` (ledger, double opt-in, gate in campaigns and workflows, proof export), `cmp.test.ts` (script blocking in the rendered HTML, Consent Mode defaults), `legal.test.ts` (module-aware generation), `checkout-law.test.ts` (button text, waiver storage); isolation is covered by the seed in `tests/security-fixtures.ts`.
