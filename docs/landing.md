# Landing page (`PGHL_LANDING=1`)

The project's public start page for **gohyperlevel.com**, served by the app itself – server-rendered, no cookies, no
tracking, nothing loaded from third parties. Off by default: without the flag none of its routes exist and `/` is the
web app (logged-out visitors land on the sign-in page at `/app`).

```bash
PGHL_LANDING=1                       # turn it on
PGHL_BASE_URL=https://gohyperlevel.com
PGHL_LANDING_HOSTS=gohyperlevel.de   # optional: more hosts that show it (the base host and its www twin always do)
PGHL_LANDING_IMPRESSUM_URL=…         # only without cloud mode – with it, /cloud/legal/impressum and …/datenschutz are linked
PGHL_LANDING_PRIVACY_URL=…           # also the privacy link next to the waitlist form's consent (cloud mode: …/datenschutz)
PGHL_CLOUD_WAITLIST=1                # optional: cloud waitlist mode – automatic in cloud mode without Stripe (below)
```

| Path | Page |
| --- | --- |
| `/` · `/de` | the landing page, English (primary, for X, Reddit and Hacker News links) and German; `/en` redirects to `/` |
| `/vergleich` · `/de/vergleich` | the full feature × vendor comparison |
| `/vergleich/highlevel` · `/de/vergleich/highlevel` | for people switching from HighLevel: price facts, what we offer instead, the importer |
| `/sitemap.xml` | the six pages (plus `/cloud` with cloud mode); `/robots.txt` names it |

**Only on the instance's own host.** A request for any other host – a client's white-label login domain, a cloud
sub-domain – is sent to `/app`, so no client ever sees the project's marketing page. Website and help-centre domains are
rewritten to their site before routing and are not affected.

**The product name** comes from *Agentur → Branding*; the shipped default ("HyperLevel") shows as **HyperLevel**. There is
no separate brand variable. **The mark** (`web/public/icon.svg`) stands wherever the brand shows: header, footer, the app
download buttons, the favicon (`/icon.svg`, `/favicon.ico`, `apple-touch-icon.png`) and the social cards – never a bare letter.

## What it shows

The home page leads with the agentic side, in this order:

1. **Hero** – "Your platform for" / "Deine Plattform für" with rotating words in gold (AI agents, sales & CRM, funnels &
   websites, email marketing, online courses, bookings, invoicing – pure CSS, one word at a time, the first one only with
   `prefers-reduced-motion`; every language needs the same number of words), who it is for as a smaller line below
   ("for agentic solopreneurs, agencies, small businesses & startups" / "für agentische Solopreneure, Agenturen, kleine Unternehmen und
   Startups"; screen readers get the whole sentence from the heading's label), a sub
   line on Jarvis and "one single source of truth", the three calls to action (live demo, self-host in one command,
   cloud), the GitHub link with the star count, a badge row (MCP, your own Claude/ChatGPT plan for your own chats …) and a
   crossfade of up to four real screens – `shot-jarvis.webp` first when it exists, then pipeline, inbox, workflow editor,
   website builder (still with `prefers-reduced-motion`).
2. **Integrates with your favorite tools** – an endless row of integration marks right under the hero
   (`server/services/landing-logos.ts`): only integrations that exist, each with where it lives (`via`: a key of the
   integrations catalogue or a file and a word in it – `tests/landing.test.ts` checks every one against the running app).
   No vendor the page compares against (competitors.json, replaces.json) and no AI lab's mark – Claude, OpenAI and Gemini are
   plain words; Zoom, DATEV, Outlook, Microsoft Teams, Mollie and Norman too. Marks from simple-icons 13.21.0 (CC0), inline
   SVG in one hidden sprite, monochrome in the hero's muted ink, the brand colour on the icon on hover (where it keeps 3:1
   on the ink). CSS only: the list twice in a row slides by its own width, hover or keyboard focus (the row is a focusable
   region) pauses it, edges fade out, `prefers-reduced-motion` shows a still, wrapped grid; the copy of the list is
   `aria-hidden`. Under it: "Logos are trademarks of their owners and show available integrations."
3. **Counted, not claimed** – MCP tools, workflow triggers, workflow actions and integrations counted from the running
   code (the triggers and actions the way the workflow catalogue counts them), automated tests counted from the repository
   at build time.
4. **One single source of truth** (`#agentisch`) – agents fill the CRM: Claude, ChatGPT, Codex, Hermes, Cursor, Jarvis,
   your own agents and your team read and write the same database over MCP and the REST API, with the same permissions,
   audit log and undo; read-only keys; inside the app the agent asks before anything is sent, deleted or paid, and every MCP
   tool tells external clients whether it reads, writes or sends (so the client can ask). A small HTML diagram, no picture.
5. **Jarvis** (`#jarvis`) – the voice companion and business developer of focus mode ([living-boards.md](living-boards.md#fokus-modus-mit-companion)):
   growth briefing with top‑3 opportunities and risks in € (opt-in), weekly review, check-ins and event alerts, drafts that
   wait for a click (voice never confirms), conversation mode, the fallback chain. An example conversation drawn in HTML
   (no numbers, labelled as an example).
6. **What makes it different** (`#warum`) – nine cards: €0 per seat, one source of truth, Jarvis, your own Claude or ChatGPT
   plan (personal chats only – Claude through Claude Code on your computer via the bridge, ChatGPT with "Sign in with
   ChatGPT" on self-hosted installs; automations use API keys), XR, designs (live counts of themes and icon packs), the
   Academy, open & customizable, German & English/GDPR/e-invoices. Each title links to its section or docs page.
7. **Built for AI agents** (`#ki-agenten`) – the live MCP tool count, the Codex/Claude Code snippet from
   [ai-tools.md](ai-tools.md) and eight cards (the agent on every page, custom agents, MCP, AI workflow steps, the voice
   agent, drafts, BYOK with fallback chain, your own subscription).
8. **The Academy** (`#akademie`), **designs** (`#designs`) and **XR** (`#xr`) – spotlights with text and, once the screenshot
   exists, the picture beside it (`shot-academy.webp`, `shot-themes.webp`, `shot-xr.webp`). The Academy shows its numbers as
   tiles (14 chapters, 120+ module tours, 10 course lessons – `ACADEMY` in `landing-agentic-copy.ts`, checked against
   `web/src/tour/catalog.ts` by the test); XR says exactly what [xr.md](xr.md) says, including that it is a beta not yet
   tested on real hardware.
9. **Replaces your stack** – per function the tools it replaces (plain text chips, no logos), the
   cheapest entry price in the vendor's currency, and *Inklusive* / ◐ *Teilweise* (with the limit as a note, e.g. "no
   listings management") / *Nur bei HyperLevel*; a total bar ("your tool stack" per currency – dollars are not
   converted unless the research brings an ECB-based total with its source) against "€0 self-hosted · from €49.99 cloud".
   Stacked cards on phones. From `web/public/landing/replaces.json`; left out while the file is missing.
10. **Savings calculator** – two modes: a *typical tool mix* (HubSpot Starter, ClickFunnels, Kajabi, Calendly,
   Mailchimp/ActiveCampaign – entry prices from the comparison research) and *coming from HighLevel* (plan, sub-accounts,
   white-label mobile app). Self-hosted or cloud on our side. It is a GET form: the URL carries the input, the server
   renders the result (and puts it into `og:title`), so a shared link shows the same number. A small inline script makes
   it live and keeps the share links (plain X, LinkedIn and Reddit intent URLs) in step.
11. Features (sixteen cards from the README, the automation card with the live trigger and action counts), DACH strengths
   (GDPR, GoBD-minded invoicing, XRechnung/ZUGFeRD, SEPA, DATEV, hosting in Frankfurt, German & English), the HighLevel
   importer in three steps, HighLevel side by side, the comparison matrix, **Cloud or self-hosted?**, pricing,
   **white-label on the Agency plan**, apps, **Open source – and open for contributions** (links to CONTRIBUTING.md, the
   good first issues and the repository, the CLA note), the one-command install with a copy button, FAQ (with Jarvis, who
   maintains the data, AI optional, own subscription).
12. **Apps** – the Android APK from this server (`/downloads/hyperlevel.apk`, version, size and SHA-256 from the latest upload,
   QR code to `/android`, how to allow unknown sources), the iPhone/iPad web app (add to home screen, what works) and XR
   headsets and display glasses (a short card pointing to the XR spotlight). The download buttons carry the HyperLevel
   mark (`/icon.svg`); the iPhone/iPad card says there is no native iOS app yet. No
   store badges: neither app is in a store. The Android robot is used under CC BY 3.0 (attribution in the footer and in
   NOTICE); iPhone/iPad get a neutral device icon, never the Apple logo.

## Cloud waitlist mode

While the hosted cloud is not open – cloud mode without a Stripe key, or `PGHL_CLOUD_WAITLIST=1`
([cloud.md → Waitlist mode](cloud.md#waitlist-mode)) – the page sells nothing that cannot be bought:

- **Self-hosting first.** The hero's main button is *Kostenlos selbst hosten* / *Self-host for free* (to the install
  section), then the live demo, then *Cloud: auf die Warteliste* / *Cloud: join the waitlist*. Eyebrow, sub line, badges
  ("Dein Server, deine Daten" instead of "Gehostet in Frankfurt"), meta description and Open Graph texts say the same.
- **Plans stay, marked as planned.** The cloud cards carry *Bald verfügbar* and *voraussichtlich* before the price; their
  button *Auf die Warteliste* / *Join the waitlist* opens the page with the plan preselected in the form (`?plan=team#warteliste`).
  The self-hosted card has the primary button. No trial, card, Stripe Tax or "start now" wording anywhere.
- **The waitlist form** (`#warteliste`, below the prices): name (optional), e-mail, plan, a consent checkbox with the privacy
  link, a honeypot. It is a plain form post – no script, the CSP's `form-action 'self'` covers it – to
  `POST /api/public/cloud-waitlist`, which sends the visitor back with `?wl=ok` and the thank-you note
  ("Danke! Wir melden uns, sobald die Cloud startet." / "Thanks! We'll be in touch as soon as the cloud launches."), or with
  the error above the form. Pages with `?wl=` are served `no-store`. With `PGHL_LANDING_LOCATION` the form shows the HQ form's
  own consent text and requires the first name ([company-playbook.md](company-playbook.md#landing-page-waitlist-dogfooding)).
- **Everything else** that spoke of the cloud as available is reworded (`server/services/landing-waitlist-copy.ts`):
  *Cloud oder selbst hosten?* puts self-hosting first and marks the cloud column planned, the calculator says "Cloud
  (geplant)", the stack total "Cloud geplant", the HighLevel table "Cloud Solo geplant: 49,99 €", the FAQ answers (plus "Kann ich
  die Cloud schon nutzen?"), the white-label lead, the Android and iPhone notes, and the phrases of the *Warum wechseln?*
  paragraphs that quote cloud prices or Frankfurt hosting. Research notes about our cloud in the comparison matrix and the stack
  table get "(Cloud: geplant, noch nicht verfügbar)"; the matrix price row says "0 € · Cloud geplant".

Social shares get `og-waitlist-<lang>.png` instead of the card with "Cloud ab 49,99 €". There is no JSON-LD on the page, so
there are no `offers` to change.

## Claims and their sources

Everything on the page must be backed by the code or a dated source. When something changes, change it in one place:

| What | Where | Source |
| --- | --- | --- |
| HighLevel prices (Starter 97 $, Unlimited 297 $, Agency Pro 497 $, white-label mobile app 497 $ add-on) | `server/services/landing-calc.ts` (`HL_PRICES`, `HL_AS_OF`) | gohighlevel.com/pricing, read 2026-10-09 |
| USD → EUR | `EUR_USD` in the same file | ECB reference rate of 2026-10-09: 1 € = 1.1206 $ |
| Our prices | the cloud settings (with cloud mode) or the list prices in `server/services/cloud.ts` | [cloud.md](cloud.md) |
| Other vendors (matrix, tool mix) | `web/public/landing/competitors.json` – every cell with a source URL, `as_of` date | the research file; our own cells re-checked against the code on 2026-10-22 (SaaS mode self-hosted only; store with cart, PayPal and Mollie, reviews from several platforms, outbound AI calls, several signers, list and calendar views, visual workflow editor and Funnel AI exist; Office is *partial* – the browser editors are an optional install; 350+ MCP tools) |
| "Replaces your stack" | `web/public/landing/replaces.json` – every tool price with a source URL | the stack research; our own notes re-checked on 2026-10-22 (outbound AI calls, review platforms, several signers, 350+ MCP tools; store and Office exist but have no researched comparison prices yet, so they stay out of the table) |
| Counts | live: MCP tools, workflow triggers and actions (as the workflow catalogue counts them), integrations catalogue, themes and icon packs (`server/services/appearance-model.ts`); tests: `stats.json` from `scripts/landing-stats.mjs` | the code |
| Academy numbers | `ACADEMY` in `server/services/landing-agentic-copy.ts` (14 chapters, 120+ module tours without the course, 10 lessons, 10 groups) | `web/src/tour/catalog.ts` – the test fails when they drift |
| Integration marks | `LOGOS` in `server/services/landing-logos.ts`, each with `via` | the integrations catalogue (plus what modules add) or the named file |
| Texts (DE + EN) | `server/services/landing-copy.ts` and `landing-agentic-copy.ts` – one interface each, so a missing translation is a type error | – |

Rules the copy follows: factual comparative advertising (no logos of other vendors, no claims that cannot be shown, every
price with source and date, the disclaimer under every comparison and in the footer: *HyperLevel is an independent
open-source project and is not affiliated with HighLevel Inc. or the other vendors named*). Gaps are said plainly: SaaS
mode is part of self-hosting, not of the cloud; our branded app is an installable web app plus a self-built Android APK,
not a store app; the HighLevel importer moves contacts, custom fields, tags, pipelines, deals, calendars and appointments,
not funnels or workflows. Testimonials are left out until real quotes exist. Your own ChatGPT or Claude subscription is
always "for your own chats" (automations use API keys), XR always "beta", Jarvis's growth briefing always "you switch it
on". "Built with Claude" appears as plain words in the footer, never as a logo.

## The comparison research

`web/public/landing/competitors.json`:

```json
{ "as_of": "YYYY-MM-DD",
  "vendors": [{ "id": "highlevel", "name": "HighLevel", "url": "https://…", "source": "https://…/pricing",
                "pricing": [{ "plan": "Starter", "price_month": 97, "currency": "USD", "notes": "…" }] }],
  "categories": [{ "id": "crm", "label_de": "CRM", "label_en": "CRM",
                   "features": [{ "id": "pipelines", "label_de": "Pipelines", "label_en": "Pipelines",
                                  "cells": { "highlevel": { "v": "yes", "note": "…", "source": "https://…" } } }] }] }
```

`v` is `yes`, `partial`, `no` or `addon`. Our own column is the vendor `gohyperlevel` (`ghl0` is accepted). The page
validates the file (https links only, unknown values and vendors dropped, everything escaped) and hides the matrix while
it is missing or unusable. The tool-mix mode uses the cheapest paid plan of `hubspot` (a plan named "Starter"),
`clickfunnels`, `kajabi`, `calendly` and `mailchimp` or `activecampaign`.

## The stack research

`web/public/landing/replaces.json`:

```json
{ "as_of": "YYYY-MM-DD",
  "rows": [{ "id": "crm", "label_de": "CRM & Pipelines", "label_en": "CRM & pipelines", "coverage": "full",
             "coverage_note_de": "", "coverage_note_en": "",
             "tools": [{ "name": "HubSpot", "plan": "Starter", "price_month": 20, "currency": "USD", "billing": "per seat",
                         "source": "https://…" }],
             "min_price": 20, "min_currency": "USD" }],
  "excluded_rows": [], "totals": {} }
```

`coverage` is `full`, `partial` (the note says what is missing) or `unique` (what only we offer – for the MCP row:
self-hostable). A row with `"in_total": false` is shown with an asterisk but not counted. The page sums `min_price` per
currency itself and converts the total to euros only when `totals` names the rate (`fx_rate_usd_per_eur`) and its source
(`fx_source`); it also prints the lower figure for the fully covered rows and that usage costs at your own providers (SMS,
e-mail sending, AI, call minutes) come on top. Our own rows were checked against the code: the Office row is left out
(module not released), "AI chat & content" is partial and not counted (we use an AI provider, we don't replace one), the
MCP row says that other vendors have MCP servers too.

## Images

`npm run landing:assets` (after `npm run build`) seeds a fictional demo, sets the product name to HyperLevel, takes
the four hero screens at 1440×900 (`shot-workflow|inbox|funnel|pipeline.webp`) plus `shot-jarvis.webp` (focus mode with
Jarvis' briefing, first in the hero), `shot-academy.webp` (the Academy with a running tour – in German, like its tours),
`shot-themes.webp` (four looks side by side: standard, dark with duotone icons, area colours, a white-label logo) and
`shot-xr.webp` (a board in the 3D preview), converts them to WebP in Chromium (each well under 250 KB), renders the social
cards `og-en.png` and `og-de.png` (1200×630, the page's own font, the HyperLevel mark and the tagline) plus
`og-waitlist-en.png` and `og-waitlist-de.png` for the cloud waitlist mode ("Cloud bald verfügbar", no cloud price), and
refreshes `stats.json` (`--no-shots`: only the cards and the stats). Every screenshot is shown only while its file exists, at
the width and height read from the file's header; a picture that fails to load anyway hides its figure (the page's script),
and the spotlight text then takes the full width. Everything lands in `web/public/landing/`, which the build
copies to `dist-web/landing/`. The font is Inter Tight as a variable font (SIL OFL 1.1, served from the same folder – no font CDN); headings use weight 600, text 400.

## Security, speed, accessibility

- Own Content-Security-Policy: `default-src 'none'`, images, fonts and the form only from this host, styles inline, and
  exactly one inline script allowed by its SHA-256 hash. No cookies, `X-Frame-Options: DENY`.
- One HTML response plus the font and the images; the hero's first screen is loaded with priority, the others lazily.
  `Cache-Control: public, max-age=300`.
- The GitHub star count is fetched in the background (at most every 6 hours, 5 s timeout) and never on a visitor's request;
  it is left out when GitHub does not answer – or in demo mode, where nothing may leave the server.
- Semantic HTML (one `<main>`, skip link, headings in order, labelled form controls, table headers), WCAG AA contrast,
  works from 360 px wide. `tests/landing.test.ts` runs the BFSG check of the website builder (`services/site-a11y.ts`) on
  the rendered pages and checks the colour pairs, the CSP hash, the shared-link result and that the inline script computes
  the same numbers as the server.

## For developers

`server/modules/landing.ts` (routes, data, cache, screenshot sizes) with the pure parts in `server/services/landing-calc.ts`,
`landing-compare.ts`, `landing-copy.ts`, `landing-waitlist-copy.ts` (waitlist mode), `landing-page.ts`, `landing-agentic.ts`
with `landing-agentic-copy.ts` (one source of truth, Jarvis, the reasons, Academy, designs, XR, open source) and
`landing-logos.ts` (the integrations row). The waitlist form comes
from `app.services.cloudWaitlist.view()` (`server/modules/cloud-waitlist.ts`). Hooks: `app.services.robotsExtra` (lines for
`/robots.txt`, used for the `Sitemap:` line), `app.services.landingFetch` (test hook for the GitHub call),
`app.services.landing` (`refreshStars`, `stats`, `matrix`).
