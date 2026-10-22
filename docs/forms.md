# Forms in depth (Typeform-style)

**Marketing → Formulare & Umfragen** has always created contacts, tags, opportunities and workflows from submissions. This page covers the depth added in the style of Typeform: **one question at a time**, **logic jumps**, **scoring and calculators**, a **payment field**, more **field types**, **themes**, **per-field analytics**, an optional **Cloudflare Turnstile**, and a **gallery of 26 German templates**. German UI, per sub-account.

- [Templates](#templates)
- [Layout: one question at a time](#layout-one-question-at-a-time)
- [Field types](#field-types)
- [Logic: show-if and jumps](#logic-show-if-and-jumps)
- [Scoring, calculators and results](#scoring-calculators-and-results)
- [Payment field](#payment-field)
- [Design](#design)
- [Analytics](#analytics)
- [PDF of a submission](#pdf-of-a-submission)
- [Save progress](#save-progress)
- [Spam protection](#spam-protection)
- [Field mapping: company, deal, custom object](#field-mapping)
- [Automations](#automations)
- [API](#api)
- [Data protection](#data-protection)
- [Limits and settings](#limits-and-settings)
- [For developers](#for-developers)

In **Einfach-Modus** ([theming](theming.md#einfach-modus)) a field shows type, label, *Speichern in*, options and *Pflichtfeld*;
placeholder, field key, *Zusätzlich speichern in* (company/deal/object), *Nur anzeigen, wenn…* and jumps sit behind **Weitere Felder** (open by themselves when set). The
*Einstellungen* tab keeps name, headline, thank-you text, tags and the team notification in view; description, button,
redirect, opportunity, notification address, consent, ticket and **Spam-Schutz** fold away. Profi shows everything.

## Templates

**Formulare → Vorlagen** opens 26 ready-made German forms; *Vorlage verwenden* creates your own copy (nothing is shared) and opens it. Edit it like any form.

| Category | Templates |
| --- | --- |
| Allgemein | Kontaktformular, Einverständnis mit Unterschrift |
| Vertrieb | Lead-Qualifizierung (with a score and three results), Immobilien-Anfrage |
| Umfragen | Kundenumfrage mit NPS, Kundenzufriedenheit (Sterne), Produkt-Feedback |
| Personal | Bewerbung (with file upload and consent), Mitarbeiterbefragung |
| Events | Event-Anmeldung, Webinar-Anmeldung, Kursanmeldung |
| Marketing | Quiz mit Auswertung (points and results), Newsletter-Anmeldung, Gewinnspiel |
| Handwerk & Dienstleistung | Angebotsanfrage Handwerk, Preisrechner Malerarbeiten (calculator), Terminanfrage, Umzugs-Angebot, Restaurant-Reservierung, Fitness-Probetraining, Steuerberater-Erstgespräch, Fotoshooting-Anfrage |
| Coaching | Coaching-Erstgespräch |
| Support | Reklamation und Support-Anfrage |
| Shop | Bestellung mit Zahlung (needs a product – you choose it when you use the template) |

Templates only use what a form can do: the consent checkbox is the DSGVO field of the editor, and the legal texts are placeholders you review (no legal advice).

## Layout: one question at a time

*Design & Ablauf → Layout*: **Klassisch** (all questions of a page below each other, pages with *Seitenumbruch*) or **Eine Frage nach der anderen** – one large question per screen with:

- a **progress bar** (can be switched off) and, optionally, a **welcome screen** before the first question;
- **keyboard use**: `Enter` for next, the letters A, B, C … pick an option, `Alt + ↑` back and `Alt + ↓` next; a choice can **advance automatically** (*Nach einer Auswahl automatisch zur nächsten Frage*);
- smooth slide/fade transitions that switch off for people with *reduce motion*;
- the same validation, show-if, scoring and spam protection as the classic layout – both layouts run on one engine.

The form works without a mouse and with a screen reader (labelled fields, focus moves to the new question, errors are announced). Hit targets are at least 44 px.

## Field types

New in the field picker next to text, e-mail, phone, multi-line, dropdown, radio, checkbox, date, number, DSGVO consent, file, hidden, heading and page break:

| Type | What it does | Answer is stored as |
| --- | --- | --- |
| Bewertung (Sterne) | 3–10 stars | the number |
| Weiterempfehlung (NPS) | 0–10 with labels at both ends | the number (9–10 promoters, 0–6 detractors in your own reports) |
| Skala / Schieberegler | from–to, step, buttons or slider, end labels | the number |
| Bildauswahl | options with a picture each, one or several | the chosen labels |
| Rangfolge | options in an order the visitor sets (arrow buttons – works with touch and keyboard) | the list, best first |
| Zeitraum | from–to date | `dd.mm.yyyy – dd.mm.yyyy` |
| Unterschrift | drawn with finger or mouse (PNG up to 200 KB) | a private file, visible in the submission |
| Zahlung (Stripe) | see [Payment field](#payment-field) | status and amount |
| Rechner | a live **calculated result** from a formula | the number |

Every field can carry a hint under the question. Answers are checked on the server per type (a rating must be within its range, a ranking must contain every option exactly once, …).

## Logic: show-if and jumps

- **Nur anzeigen, wenn …** now also compares numbers: *ist größer als*, *ist mindestens*, *ist kleiner als*, *ist höchstens* (next to *ist*, *ist nicht*, *enthält*, *ist ausgefüllt*, *ist leer*). A hidden question is neither shown, required nor counted.
- **Sprünge (Logik)** on a question: *Wenn die Antwort … ist, dann weiter zu …* – to a later question (one-question layout), a later page (classic) or the **end**. The first rule that matches wins; no match means the next question. Jumps only go **forward** (no loops – the editor refuses a backward jump with a clear message). Questions skipped by a jump are not asked, not required and do not count for scoring.
- The server follows the same path: it only accepts answers for questions the visitor could have reached.

## Scoring, calculators and results

- **Points:** every option of a choice question can give points (*Punkte für die Auswertung* on the field), numeric answers (number, stars, NPS, scale) can count with a **weight**. The sum is the variable `score`.
- **Variables** (*Punkte & Ergebnis*): your own named values computed from a formula, e.g. `quote = score / 40 * 100`.
- **Calculator fields** show a live result under the question and store it: `menge * 12,5`, `if(score >= 10, 1, 0)`. Formulas use the keys of other fields (the field editor offers them as buttons), `score` and your variables. Operators `+ − * / %`, parentheses, comparisons, `&&`, `||`, `? :`; functions `min, max, sum, avg, round, floor, ceil, abs, sqrt, pow, if`; decimal numbers with a dot or a comma (separate function arguments with a comma **and a space**: `min(a, 5)`). A choice counts as its points, a date range as its number of days, a consent box as 1/0. Division by zero gives 0. The formula language is a small parser of our own – **no `eval`**, nothing you type can run code.
- **Ergebnisse** (results): by the value of `score` or a variable (from … to …) a visitor sees a title and text (`{{score}}` inserts a value), is redirected, or the contact gets a **tag**. *Berechnete Werte anzeigen* shows the numbers after sending. The server calculates everything again and ignores what the browser claims.
- The submission list shows the points, the result and the payment state as badges.

## Payment field

Add **Zahlung (Stripe)** and choose a product (*Umsatz → Produkte*). The form stores its answers first; then the visitor is sent to the **existing buy page** of the product (Stripe Checkout – the same flow, invoice, tags and `product.purchased` as a normal purchase; nothing is rebuilt). A signed token (valid 24 hours) ties the checkout to the submission. When Stripe confirms the payment the submission turns **Bezahlt** and `form.paid` fires. The page needs a connected Stripe account (*Einstellungen → Stripe*); without it the form still stores the answer and says the payment is not set up. One payment field per form; the price always comes from the product, never from the browser.

## Design

*Design & Ablauf*: ten **presets** (Standard, Dunkel, Minimal, Warm, Ozean, Wald, Pastell, Elegant, Hoher Kontrast, Knallig), a **font** from five system font stacks (no external fonts are loaded – nothing is sent to a font service), colours for accent, text, card and background, a button text colour (automatic by default), roundness, left or centred, and a **background image** with a dark overlay. A warning appears when text, button or accent are hard to read (below WCAG AA 4.5 : 1). The design is scoped to the form, so a form inside a funnel page never restyles the page. The old single *Farbe* of a form keeps working until you pick a theme.

## Analytics

*Auswertung* (7/30/90/180 days): opened, started, submitted, completion and abandon rate, average time to submit; the **funnel** by question; **per question** views, answers, **where visitors leave**, and the average time per answer; the daily curve. It also names the question with the most drop-offs and the slowest one.

**Privacy-friendly by design:** no cookies, no IP address, no fingerprint – a random visit id is created per page load and lives only in memory. *Do Not Track* and *Global Privacy Control* switch it off completely. Only counts and timings per question are stored (no answers), they are deleted after 180 days, and *Auswertung zurücksetzen* wipes them right away. Because nothing personal is stored, no extra consent is needed for it – check this with your data protection officer for your setup.

## PDF of a submission

*Einsendungen* has a **PDF** link under each date: the submission as an A4 document – form name, date, contact, every question with
its answer (uploads as their private links), points/result and source – made by the server's own PDF writer (like invoices). Only
team members with the forms area can open it. API: `GET /api/forms/:id/submissions/:submissionId/pdf` (also with `?locationId=` for
a plain link) and `GET /api/forms/:id/submissions/:submissionId` (JSON with `pdf_url`). **MCP** (read only): `ghl_forms` (forms with
counts and links) and `ghl_form_submission_pdfs` (latest answers of a form with `pdf_url`; `ghl_form_submissions` gives the answers without PDF links).

## Save progress

*Layout & Ablauf → Fortschritt speichern* lets visitors stop and continue later:

- **Same device:** only when the visitor clicks **Auf diesem Gerät merken** (in the *Später weitermachen* box) are the answers kept
  in their browser (`localStorage`, 30 days) – nothing is stored while somebody merely types, so the next person on a shared device
  does not see them. Back on the form's page they are filled in again, with a note and **Neu beginnen** to start empty. Consent boxes,
  payment, signatures, files and hidden fields are never kept or filled in again (not in e-mail drafts either).
- **Später weitermachen** (below the form): the visitor types an e-mail address and gets a link `/f/<id>?resume=<token>` that brings
  the answers back on any device. The draft is stored for **30 days** (only the hash of the token, only the form's own fields, no
  files or signatures), then deleted by the background tick; sending the form removes it. No contact is created from a draft.
- Drafts are part of the DSGVO export of a contact with that address and are erased with it. API: `POST /api/public/forms/:id/draft`
  `{email, data}`, `GET`/`DELETE /api/public/forms/:id/draft/:token`.
- **Limits:** works on the form's own page (`/f/:id`, also embedded with `?embed=1`), not inside website blocks; a multi-page form
  starts on its first page with the answers filled in.

## Spam protection

A hidden **honeypot** field and a per-address rate limit are always on. Optionally **Cloudflare Turnstile** (off by default): create a widget in your Cloudflare account, enter the *Site Key* and *Secret Key* under *Einstellungen → Spam-Schutz* of any form (stored once per sub-account, the secret sealed and never shown again) and switch it on per form. The widget appears above the final send button; the token is checked on the server after the answers validate and is single-use. **If Cloudflare cannot be reached the form refuses submissions** (503 with a friendly message) – a captcha that lets everybody in when it is down protects nothing. Removing the keys switches Turnstile off in all forms.

**Data protection:** Turnstile loads `challenges.cloudflare.com` and sends the visitor's IP address to Cloudflare. Put it into your cookie/consent banner (as a necessary/security service) and your privacy policy. On a page of the funnel builder that runs forms inside a sandboxed frame the widget may not work – use the form's own page or a normal embed there.

## Field mapping

Like in HighLevel a field does not only fill the contact: *Speichern in* still picks the contact field, and **Zusätzlich speichern in**
(per field, under *Weitere Felder* in Einfach-Modus) writes the same answer into

- **Firma** – a standard field (name, domain, industry, size, phone, website, address, postal code, city, country, description) or a
  company property. The contact's primary company is used; otherwise the company with that domain or name; otherwise a new one is
  created and linked to the contact.
- **Deal** – name, value, currency, expected close, source or a deal property. Choose the pipeline and stage once for all deal
  fields and *Welcher Deal*: always a new deal, or the contact's open deal in that pipeline (a new one when there is none). A form
  with deal fields does not also create the plain *Opportunity anlegen* deal – there is one deal per submission.
- **Eigenes Objekt** – a property of a custom object ([objects.md](objects.md)). A new record linked to the contact, or (*Welcher
  Datensatz*) the contact's last linked record. A unique value that already exists updates that record – only when it is linked to
  this contact; a record of somebody else is never changed (the submission notes it).

Rules:

- **Protected fields are never written by a form**: owner/assignee, lifecycle phase, deal status, pipeline/stage (only the form's own
  choice), lost reason, ids and external ids. Saving a mapping to one of them is refused with a message; *Nutzer* and *Datei*
  properties cannot be mapped either. The same goes for the contact: a field key `assigned_to` (owner) is refused on save, also for hidden fields, whose value
  comes from the page; an older form that still has one is submitted without it and the submission notes it (`meta.mapping.errors`).
  `source` (lead source) stays allowed – it is attribution like the UTM values, and the landing page and cloud waitlist set it. A visitor's extra keys are
  ignored as before – only the form's fields count.
- **Existing records keep their values**: an answer fills an empty field; *Vorhandene Werte überschreiben* (per form) lets it
  replace stored values.
- Every answer is checked against its target before anything is stored (a number field into a deal value, a date, a select option);
  a wrong value is shown to the visitor like any other check. A new record needs every required property mapped – the editor
  says so on *Speichern*.
- Only with a contact (e-mail, phone or name in the form). The normal events fire – `company.created/updated`, `opportunity.created`
  (and `opportunity.updated` when an open deal is filled in), `record.created/updated` – so workflows run as for a change in the
  app. Where the submission wrote is kept in it (`meta.mapping`: company, deal and record ids, and anything that could not be written).
- Sub-accounts stay apart: pipelines, objects and properties are looked up in the form's own sub-account when it is saved and again
  at every submission – a copied form whose mapping points elsewhere writes nothing there.

API: `settings.mapping` on `POST /api/forms` and `PATCH /api/forms/:id` (`{fields: {<field id>: {target: company|opportunity|object, key, object?}},
deal: {mode: new|open, pipeline_id, stage_id}, objects: {<key>: {mode: new|linked}}, overwrite}`; `null` removes it),
`GET /api/forms/:id/mapping` (the mapping in words and every target the picker offers). Agents read it with `ghl_form_mapping`;
`ghl_list_forms` and `ghl_forms` show how many fields go where.

## Automations

New workflow triggers: **Formular ausgewertet** (`form.scored`: points/result, filter by form and result tag) and **Formular bezahlt** (`form.paid`: filter by form and product), next to the existing **Formular ausgefüllt**. Typical flows: *Quiz result → tag → matching e-mail sequence*, *Lead score ≥ 20 → task for sales*, *paid → welcome mail*.

## WordPress plugin

*Formulare → WordPress-Plugin → Plugin herunterladen* gives a small plugin (`hyperlevel-wordpress.zip`) with this sub-account's address baked in. In WordPress: *Plugins → Add New → Upload Plugin*. Then:

- `[hyperlevel_form id="…"]` embeds a form, `[hyperlevel_calendar slug="…"]` a booking calendar (auto-height iframes of the public pages; the card lists the ready shortcodes of every form and calendar under *Shortcodes*).
- *Settings → HyperLevel* switches on the **live-chat bubble** and the **attribution snippet** on every page (both off by default; put attribution into the site's cookie banner).
- The plugin stores nothing and sends nothing on its own – the visitor's browser loads the public pages as with a manual embed. The plugin name is the agency's brand name.

API `GET /api/wordpress-plugin` (download path, shortcodes), `GET /api/wordpress-plugin.zip`; MCP `ghl_wordpress_shortcodes`. Module `server/modules/wordpress-plugin.ts` (PHP template `pluginPhp`, ZIP via `services/zip-store.ts`).

## API

| Area | Routes |
| --- | --- |
| Forms | `GET/POST /api/forms`, `GET/PATCH/DELETE /api/forms/:id` (`fields`, `settings`; `settings` also takes `mode: classic|typeform`, `show_progress`, `auto_advance`, `welcome`, `theme`, `variables`, `endings`, `show_result`, `captcha: {enabled}`), `GET /api/forms/:id/submissions` |
| Fields | per field besides the old keys: `hint`, `jumps: [{op, value, goto}]` (`goto`: field id, `page:N` or `end`), `max` (stars), `min/max/step/style/labels` (scale, NPS), `images`, `multiple`, `points: {option: n}`, `weight`, `product_id` (payment), `formula`, `format` (calculator) |
| Templates | `GET /api/forms/templates`, `GET /api/forms/templates/:id`, `POST /api/forms/templates/:id/use` (`{name?, product_id?}`) |
| Themes | `GET /api/forms/themes` (presets, fonts) |
| Analytics | `GET /api/forms/:id/analytics?days=`, `DELETE /api/forms/:id/analytics` |
| Turnstile | `GET/PUT/DELETE /api/forms/captcha` (`{site_key, secret_key}`; the secret is never returned) |
| Public | `GET /f/:id`, `POST /api/public/forms/:id/submit` (answers as before; `_dur`, `_fs`, `cf-turnstile-response`; answers `{ok, id, result?, pay_url?}`), `POST /api/public/forms/:id/track` (anonymous counts) |

## Data protection

- Answers, signatures and files are personal data of the submitter: they are part of the contact's *Auskunft* and erased with the contact (DSGVO).
- Signatures and uploads are private files; only team members of the sub-account can open them.
- Form analytics hold no personal data (see above). The only third party is Cloudflare Turnstile, and only if you switch it on.
- Payments run entirely on Stripe's pages; the form never sees card data.

## Limits and settings

| Setting | Default | What |
| --- | --- | --- |
| `PGHL_FORMS_PER_MINUTE` | `20` | Submissions per minute per address (in memory, per server process). |
| `PGHL_PUBLIC_UPLOADS_MB` | `2048` | Disk space for the files and signatures visitors upload through public forms, **per sub-account** (`0` = no cap of its own). |

- **Upload quota.** Besides the request limits (12 MB per submission, 5 MB per file, 200 KB per signature, the per-minute brake) the files of
  public forms have a disk quota per sub-account: `PGHL_PUBLIC_UPLOADS_MB` and, in the hosted cloud, the plan's media storage (fair use) –
  form files count in that meter like every other upload ([cloud.md](cloud.md#fair-use-transparent-never-a-feature-lock)). A submission whose files would pass a cap
  is refused with **413** (*der Speicherplatz für Uploads ist voll*) before anything is written; a submission without a file still goes
  through. The sub-account is told at **90 %** and at **100 %** – an e-mail to the sub-account's address and a notice in the app (bell/push) –
  once per level until the usage drops below 90 % again (delete old submissions with files to make room). Module `public-upload-quota`,
  hook `app.services.publicUploadGate(locationId, bytes)` for other public uploads.
- **Who the contact is.** A form never changes the e-mail address or phone number already stored on a contact: an empty one is filled,
  a different number on a contact found by its e-mail address is noted on the timeline as an *unverified alternative*, and a known number
  with another e-mail address creates a new contact that the duplicate check pairs with the old one ([sales.md](sales.md#duplicate-assistant)).
- Up to 100 fields, 20 jump rules per field, 20 variables, 20 results; formulas up to 300 characters.
- Jumps only go forward; one payment field per form.
- Fonts are system stacks only (no web fonts – privacy and speed).
- A form with a payment field cannot confirm a payment by itself: it depends on the Stripe webhook of the product purchase being set up (*Einstellungen → Stripe*).

## For developers

- Services: `form-fields.ts` (field model, cleaning, answer checks), `form-logic.ts` (rules, screens, jumps, formula parser, scoring – pure; the browser gets the same logic as small ES5 files, kept in step by fuzz tests), `form-render.ts` (the markup of the public page), `form-runtime.ts` + `form-assets.ts` (which browser parts a form gets, and how they are minified), `form-themes.ts`, `form-templates.ts`, `form-analytics.ts`, `form-captcha.ts`.
- Modules: `forms` (CRUD, public page, submit), `form-mapping` (company/deal/object mapping: hooks `app.services.formMapping.clean/check/apply` called by `forms`), `form-library` (templates, themes, Turnstile keys), `form-analytics`, `form-payment` (hooks `buyPageHtml`/`buyCheckout` of the buy flow and the `product.purchased` listener).
- Tests: `form-runtime` (which parts a form gets, minified output, the esbuild-less fallback, lean rules), `form-browser` (a real Chromium through Playwright: classic, pages with jumps, one question at a time with score, Turnstile, upload – opt in with `PGHL_BROWSER_TESTS=1`), `form-logic` (rules, jumps, formulas, scoring – server vs. browser parity), `form-mapping` (each target, protected columns, isolation, unchanged old forms), `forms-depth` (templates, field types, jumps, scoring, themes, Turnstile with a mocked verify endpoint, payment with a mocked Stripe, analytics, rate limit).

### The browser side of a form: base plus parts

A public form must stay light on a website page (`tests/site-perf.test.ts` holds every template page to 32 kB of HTML, 8 kB gzip, 16 kB of CSS and 8 kB of inline script). So the script and the stylesheet are not one block: **a classic form gets a small base, and every feature adds its own part only when the form uses it.**

The sources are real files in `server/assets/forms/`; `server/services/form-runtime.ts` decides per form which of them go on the page.

| Script part | When the form gets it |
| --- | --- |
| `core` | always: answers, validation, submit (also to payment and thank-you address), honeypot field, Enter key |
| `rules` + `cond` | a question with *show if* (rules = the same matching as the server, `logic-rules.js`) |
| `nav` | several pages, a welcome screen or one question at a time: next/back, progress, jumps, `Alt + ↑ ↓` |
| `tf` | one question at a time: focus, advance after a choice, letters A, B, C … |
| `calc` | a calculator field (formulas as on the server, `logic-formula.js`) |
| `result` | an ending by score or *Ergebnis anzeigen* |
| `scale`, `sig`, `range`, `rank`, `file` | rating/NPS/scale/slider · signature · date range · ranking · file upload |
| `ts` | Turnstile switched on and keys present |
| `track` | analytics on (the default) |
| `partial` | the form has an e-mail or phone field **and** an active workflow *Formular abgebrochen* listens (the server stores nothing otherwise, so the page does not send anything either) |

The stylesheet works the same way (`base.css` plus `tf`, `choice`, `pics`, `stars`, `scale`, `slider`, `sig`, `rank`, `pay`, `calc` … – one file per field type or layout). Every rule sits under `.pf`, the root element of a form, so several forms on one page cannot disturb each other; colours, font and radius come from the `--pf-*` variables of the theme.

How the parts work together: the page script is `(function(){var CFG=…,SPEC=…,$={}; <part>(…) … $.run();})()`. `CFG` holds the few settings a part reads (defaults are left out), `SPEC` the rules as data (only for forms with show-if, several screens or a calculator), `$` is shared by the parts: a small event bus (`$.on('show', fn)` – events `refresh`, `show`, `leave`, `nav`, `pick`, `pre`, `data`, `sent`, `result`, `fail`) and a few helpers (`$.raw()`, `$.clearErr(q)`, `$.go()`, `$.next`). A part is a file `server/assets/forms/<name>.js` that listens and adds listeners; list it in `JS_PARTS` and in `planRuntime()` (and add a CSS file the same way) – nothing else in the code base changes. `/*@include file.js*/` pulls another asset into a part.

**Minified at build time.** `npm run build` ends with `scripts/build-form-runtime.mjs`: esbuild (a dev dependency) minifies every part and writes `dist-server/server/assets/forms/runtime.json` next to a copy of the sources. The running server only reads that file – production images run `npm ci && npm run build && npm prune --omit=dev`, so no dev dependency is needed at run time. From the source tree (`npm run dev`, tests) the parts are minified on first use with esbuild when it is installed, otherwise comments and indentation are stripped (valid, about 15 % larger). A classic contact form is about 3.5 kB of script plus 1 kB of analytics and 2.5 kB of CSS on the page; a form with every feature (one question at a time, scoring, calculator, signature, ranking, widgets, Turnstile) about 17 kB of script.
