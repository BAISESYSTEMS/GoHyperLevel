**English** · [Deutsch](sites.de.md)

# Website builder: editor, templates, content, accessibility & analytics

Funnels and websites (*Funnels & websites* in the menu) consist of pages assembled from **sections, columns and blocks**. This chapter describes the editor, the design settings, the 23 templates, collections (CMS), redirects, search and languages, image optimization, the accessibility check (BFSG) and the analytics per funnel step. Domains, blog, A/B tests, order bumps and purchase links are covered in the [README](../README.md) and in [docs/stripe.md](stripe.md); the legal texts in [docs/consent.md](consent.md).

Everything here belongs to the area *Funnels & websites*; a login may only edit the pages of its own sub-accounts, and keys with read access can't change anything.

## The editor

You open a page under *Funnels & websites → Website → Pages*. The editor is on the left, the **live preview** on the right with a switch for **desktop, tablet (820 px) and phone (390 px)** – the preview is the real page at that width, so the columns wrap exactly the way they do for visitors.

- **Add:** tab *Sections* (column layouts: 1, 2, ⅓ + ⅔, ⅔ + ⅓, 3, 4 columns), *Blocks* (Hero, Call to action, Benefits, Flow, Numbers, Logos, Gallery, Testimonial, FAQ, Pricing, Form, Calendar, Product / checkout, Store: product list, Store: product detail, Countdown, Collection, Search, Custom code …) and *Components*. Clicking inserts where the selection suggests (into the selected column, after the selected block, after the selected section); **dragging** drops precisely.
- **Structure:** the page as a tree **section → row → columns (1–4) → blocks**. Everything can be reordered and moved **with drag & drop** (also rows into other sections and columns within a row); the arrows ↑ ↓ and the buttons for duplicating and removing do the same **without a mouse and on touch devices**. Collapsing keeps long pages manageable. **Ctrl/⌘ + Z** undoes steps, **Ctrl/⌘ + Y** (or Shift + Ctrl/⌘ + Z) restores them. A page may have up to 400 blocks and sections.
- **Inspector** for the selected element, in three tabs:
  - *Content* – the block's fields (texts, links, images, form, calendar, product, collection …); links point to a **page of this website** (they follow renames), an address, an anchor (`#preise`), `mailto:` or `tel:`.
  - *Style* – background and text color (from the design colors or your own), background image with darkening, **spacing top/bottom and left/right**, **border**, **corners**, shadow, alignment. If you set a text color with too little contrast, the inspector warns you right away.
  - *Devices* – **hide on desktop, tablet or phone**, **stack columns** from tablet, phone or never, **column width per device**, spacing per device and **font size per device** (in percent).
- **Save** makes the changes live. If you try to leave the page with unsaved changes, you are asked.
- **SEO, page layout, check** (below the inspector): title, description, preview image, noindex; hide the header or footer on this page (e.g. landing pages), language and **Create translation**; the **accessibility check of the draft** with a jump to the affected block.

Pages from before the layout editor are a flat list of blocks. They work unchanged; *Convert to sections* wraps every block in a section without extra spacing, so the look stays the same and columns become possible.

### Components (symbols)

A section or block you need on several pages (contact area, trust logos, price list) becomes a building block with **Save as component**. In its place on the page the component now sits; under *Components* you put it on further pages, edit it (the change takes effect **everywhere after saving**) or **detach it from the component** (a copy stays behind as normal blocks). If a component is deleted, the pages stay as they look: the places become normal blocks. A component can't contain itself (not even through another one). Components belong to the sub-account; when a website is copied to another account, the ones in use are copied along.

### Images

When uploading in the editor, the browser scales the image into **several widths (640, 1280, 1920 px)**, writes **WebP** where the browser can (checked via canvas), and stores width and height. The page gets `srcset` (phones load the small image), `width`/`height` (no jumping while loading), **`loading="lazy"`** below the first image and `fetchpriority="high"` for the first. Small files (under 250 KB) and animated GIFs are uploaded unchanged.

In addition, the server reads the **size of every uploaded image from the file header** (PNG, JPEG incl. EXIF rotation, GIF, WebP) – images from the media library that were inserted without a size also get `width` and `height`. If an **image engine** is available, the server also writes `srcset` copies itself under `/uploads-opt/<width>/<file>` (320, 640, 960, 1280, 1920 px), as **AVIF** or **WebP** if the browser accepts them (`Accept`), with a cache on disk (at most two at the same time). **`sharp`** is used as the engine if installed (`npm install sharp` – optional, detected at startup, never required; `PGHL_IMAGE_ENGINE=off` turns it off). Without an engine, `/uploads-opt` redirects to the original. The scaled copies contain no metadata (GPS position, camera).

## Design: colors, fonts, header, menus

*Funnels & websites → Website → Design* applies to the **whole website**; blocks refer to the colors (“Brand”, “Accent” …) instead of fixed values, so a change takes effect everywhere. On the right, the preview shows every change immediately.

- **Colors** (Brand, Accent, Text, Muted, Background, Surface, Line, Success, Error) with a **contrast check** (WCAG ratios for text on background, gray text, brand, white text on brand).
- **Fonts & sizes:** nine **system fonts** (nothing is loaded from elsewhere – that keeps the page fast and GDPR-clean), base size, scale of the headings (the phone scale is tighter), spacing unit. Your own font files: see [Own fonts](#own-fonts).
- **Corners & shadows** (small/medium/large).
- **Header:** name or logo, menu, button, **sticky**, search field, language switcher; with a skip link “Zum Inhalt springen” (skip to content) and a menu that becomes a hamburger on phones.
- **Menus:** any number of named menus (`main`, `footer` …) with entries, one level of submenu and order; an entry points to a page (follows renames) or an address.
- **Footer:** up to four columns (menu or your own links), text; links to **Impressum, Datenschutz, Widerruf, AGB and Barrierefreiheit** (imprint, privacy, withdrawal, terms and accessibility) appear automatically as soon as those pages exist, plus *Cookie settings* if the cookie banner is on.
- **Languages, search, 404 page, analytics:** see below.

The older settings (*Settings & domain*: brand color, font, code in the `<head>`, footer text) keep working. Code in the `<head>` is, as before, only loaded after consent in the cookie banner.

## Create with AI

*Funnels & websites → Create with AI* builds, from a short brief (company, offer, audience, tone, du/Sie, language, landing page / funnel / website), first a page plan, then the blocks of each page – checked against this builder's blocks and the sub-account's forms, calendars and products – and creates them as an **unpublished draft** (design of a gallery template, form, legal pages). In the editor, **AI assistant** opens a sidebar for commands on the selected section or the whole page (“shorter”, “add FAQ”, “in du form”) with preview, change list and restore point. Everything about it: [docs/site-ai.md](site-ai.md).

## Templates

*Funnels & websites → Browse templates* shows **23 German templates** with a preview per page, desktop and phone:

| Websites | Funnels |
| --- | --- |
| Coach & consulting, Craft business, Agency, SaaS & software, Restaurant & café, Practice & therapy, Real estate agent, Law firm & tax advisor, Fitness & studio, Photographer, Hairdresser & beauty, Club & initiative, Careers & jobs | Lead magnet, Webinar funnel, Course sale, Event, Link in bio, Newsletter, Podcast, Product launch, Video sales letter, Appointment funnel (application) |

Creating one produces the whole website: pages with sample texts (placeholders – please replace), design (colors, font, header and footer, menu), the required **collections with sample entries**, a **form** (newly created with a consent field, or an existing one you choose; after submitting it goes to the thank-you page), your **calendar** and your **product** in the right places and – where there is something to sell – the **legal pages Impressum, Datenschutz and Widerruf (imprint, privacy and withdrawal) generated from the company data** (*Consent & legal*, the same generator as there; if company data is missing, placeholders remain and the result says so). If a step fails, everything is rolled back. Afterwards the response lists **what is still missing** (create a calendar, choose a product, connect Stripe, enter company data).

All templates are built so that the automatic accessibility check finds no errors (contrasts, heading order, alt texts, form labels).

## Content (CMS)

*Funnels & websites → Website → Content (CMS)* (websites only). A **collection** is a list of similar entries with their own **fields**: text, long text (Markdown), number, image, link, e-mail, phone, date, yes/no, choice, tags, **product** (shows a purchase button) and rating. Templates for **team, projects & references, products, testimonials, FAQ and jobs** come with fields and sample entries.

- You maintain the **entries** in a table (draft/published, order, duplicate, search) and in a form that follows from the fields.
- **List:** the *Collection* block shows the published entries as a grid or list (1–4 columns) with **filters** (fields set to “offer as filter”) and search, sorting, pagination, a fixed filter (only entries with field = value) and a maximum count. Optionally there is a **list page** of its own at `/<path>`.
- **Detail pages** `/<collection>/<entry>` with a **template of their own**, which you build in the same editor. In texts there are **placeholders** `{{field}}` (for product fields also `{{field.name}}`, `.price`, `.url`, `.id`). Detail pages have their own SEO details (title, description, image), go into the **`sitemap.xml`** and into the **site search**; entries in draft are visible nowhere.
- When an entry is published, the event `site.item_published` fires (can be a workflow trigger).
- When a website is copied (agency snapshots, *Copy to another client…*), collections go along with their entries; references to pages, components, forms and products then point to the copies.

## Redirects, 404 page, search and languages

- **Redirects** (*Redirects*, websites only): exact paths and **patterns with a star** (`/blog/*` → `/magazin/$1`, also `:splat`), code **301 / 302 / 307 / 308**, optionally carry over the address parameters, note, counter. Exact paths take precedence over patterns; loops are rejected; a path that a page already has is flagged (the page wins). **Test** shows where a path leads; **Import** takes a list (`/alt /neu 301`, also from a spreadsheet). At most 500 rules per website. Targets are paths of the website or https addresses – paths of the app (`/api`, `/f`, `/book`, `/uploads` …) are reserved.
- **Addresses not found:** visited paths that don't exist (without bots and without crawler noise) appear with a counter in the list – a click on *Redirect …* creates the rule.
- **404 page:** under *Design → Search & error page* you choose **a page of your own** from the website (or a page with the path `404`); otherwise a plain notice appears in the page's design. The 404 page goes out with status code 404 and is `noindex`.
- **Site search** (*Design → Search & error page*): search field in the header and the page `/search` across pages, blog and collections; umlauts are folded, hits in the title count more, every request is limited per address. Pages with *noindex* and pages with their own **password protection** are not included; if the whole website is protected, `/search` is locked too.
- **Languages:** under *Design → Languages* you set up the default language and further languages; in the editor, *Page layout → Create translation* copies a page into another language (own path `<path>-en`, same group). Pages that belong together get **`hreflang`** references and `<html lang>`, and the header's language switcher links them. You do the translation of the texts yourself (or with the AI assistant) – this is a simple mechanism, not an automatic translator.

## Product / checkout

For the online store's cart there are two more blocks: **Store: product list** (published products, optionally a collection, with variants and “Add to cart”) and **Store: product detail** (one product with images, variants and quantity – without a chosen product, the one the product list links to with `?product=…`). Their buttons lead to the store's checkout – details in [store.md](store.md#on-your-website-the-blocks).

The block *Product / checkout* shows a product of the sub-account (name, text, **price incl. VAT**, interval for subscriptions, note on VAT or **§ 19 UStG**, order bump and discount code hint) with a button to the **purchase page** `/buy/<shortname>` (Stripe Checkout). Ordering happens there – with the **“order with obligation to pay”** button (“zahlungspflichtig bestellen”), terms checkbox and waiver of withdrawal for digital content from [Consent & legal](consent.md#checkout-rules-germany). The block itself orders nothing: its button says “Order now”, and below it is what the order button on the next page is called; the links to withdrawal information and terms come from the legal texts. Visitors see nothing as long as Stripe isn't connected or the product can't be bought; the editor says what is missing. The page the click came from runs along as `fp` into the Stripe metadata, so the purchase is attributed to the step in the analytics.

## Accessibility (BFSG)

*Funnels & websites → Accessibility* checks all pages of the website (and in the editor the unsaved draft) against the standard **BFSG · EN 301 549 · WCAG 2.1 AA** for: missing or empty **alt texts**, **contrasts** (color pairs of the design colors, texts on colored sections), **heading order** (one H1, no jumps), **form labels**, meaningless or missing **link texts**, buttons without a name, **page language** and page title, zoom lock, main area and skip link, embedded content without a title, videos (caption hint), focus, tab order, motion, table headers and duplicate IDs. Each finding has a severity (error, warning, hint), the WCAG criterion, a **hint on how to fix it**, and jumps to the block in the editor. The score 0–100 subtracts 10 per error and 3 per warning. Below it is the list **Check by hand** (keyboard operation, 200% zoom, screen reader, captions …) – automatic tests find only part of the problems.

**Accessibility statement:** *View draft* creates a draft from the company data (*Consent & legal → company data*) and the check results (date, conformity, known deficiencies, contact, note on the conciliation body) and, if you want, creates it as a page **“Barrierefreiheit”** (accessibility), which is linked automatically in the footer. This is a draft and not legal advice.

**Who is affected?** The BFSG has applied since June 28, 2025 to consumer services in electronic commerce (online shops, booking and payment flows), not to purely informational pages. **Micro-enterprises** (fewer than 10 employees and at most €2 million annual turnover or balance sheet total) are exempt for **services**. Whether that applies to you is for you or your legal counsel to decide; the check helps in any case, because the same things help people with disabilities and Google.

## Analytics per funnel step

*Funnels & websites → Website or funnel → Analytics* (7 days, 30 days, 90 days, 12 months; CSV export):

- **Visitors, views, conversions and rate, revenue.** Every page is a **step**: visitors, views, how many of them **click on to a later step** (on the same day) and the **bounce** in percent, average **time on page** and average scroll depth.
- **Conversions per step:** form submitted (via the address of the page the form was on), **appointment booked** (if exactly one page embeds the calendar) and **purchase** (via `fp` from the product block or the purchase link with `?fp=<page ID>`) – with revenue.
- **A/B test per step:** if a test is running for the page (the page's *A/B test* tab), variants, visitors, conversions, rate and uplift are shown right on the step.
- **Revenue by attribution** (*Attribution*): paid invoices incl. Stripe whose contacts came through this funnel, by first and last touch.
- Distribution by **devices** and **sources**, visitors per day. Dashboard block **“Funnel evaluation”** for the Living Boards and MCP tool `ghl_funnel_analytics`.

### Privacy of the counting

**No cookies are set and no IP addresses are stored**: a visitor is a **daily changing hash** of address and browser (with a secret salt of the server) – the next day the same visitor is a different one; there is no recognition across days. Bots are not counted, **“Do Not Track” and Global Privacy Control** are respected by default. What is stored is page, day, device (desktop/tablet/phone), source (as one word), time on page and scroll depth; the data is deleted after **180 days** (adjustable 30–730 days under *Design → Analytics*; the counting can also be turned off there). Even so, reach measurement belongs in the privacy policy; the generator under *Consent & legal* mentions it.

## SEO & access

*Funnels & websites → Website or funnel → SEO & access* bundles what concerns search engines and visitors:

- **SEO check** (*Check pages*): renders every page the way visitors get it and lists, per page, findings with a hint and a score (0–100): missing or too short/long **page title**, **meta description**, no or multiple **H1**, images without **alt text**, **little text** (under 300 words), no **internal links**, no **preview image**, no **structured data**, long path, `noindex`. Across all pages: **duplicate titles and descriptions**. MCP: `ghl_site_seo_check`.
- **Check any website** (under *More fields*): the same check for any public page on the web – a prospect's website (a hook for your offer) or the old site before a move – plus **HTTPS**, **mobile view** (`viewport`), language, status and load time. Fetched through the secured fetch (no internal addresses, at most 3 MB, 12 s). API `POST /api/seo-audit` `{url}`, MCP `ghl_seo_audit_url`.
- **Structured data (Schema.org)** per page: choose a type – *Local business*, *Organization*, *FAQ*, *Service*, *Product*, *Event*, *Article* – and fill in a few fields (prefilled from the company data; *FAQ* reads the page's FAQ blocks). The JSON-LD goes into the page's `<head>` when it is served. MCP: `ghl_site_schema_set`.
- **Password protection** for a page or the whole website (member price lists, customer preview, test page): visitors see a password field, the right password opens the page for 7 days (cookie only for this lock). A **new password ends all open accesses**; protected pages are never cached and carry `noindex`. A password for the **whole website** locks everything it serves – pages, blog (posts, overview, RSS), collections, search, `sitemap.xml` and the 404 page; only `robots.txt` and the **help center** under `/help` stay open (a product of its own in the sub-account with its own public address, not part of the website). A page's password takes precedence over the website's and opens only that page; pages with their own password never appear in the site search. At most 10 attempts per address and lock in 10 minutes (counted before the check, also for simultaneous requests; the right password resets the counter). MCP: `ghl_site_lock_set`, `ghl_site_lock_list`.
- **Pages: order & online:** sort pages with ↑/↓ (the first is the home page) and take individual pages **offline** – visitors get the website's 404 page, the domain and all other pages stay online; while it is offline, the page is set to `noindex` (the earlier setting comes back afterwards). API `GET /api/funnels/:id/pages-state`, `PUT /api/funnel-pages/:id/offline` `{offline}`, `POST /api/funnels/:id/reorder` `{page_ids}`; MCP `ghl_site_page_offline`.
- **Text from the link (URL parameters):** `{{url.name|Freund}}` in any text – whoever opens `…/angebot?name=Anna` reads “Anna”, everyone else “Freund”. Whole sections depending on the link: `{{#if url.quelle == "facebook"}}…{{else}}…{{/if}}` (operators as in e-mails, see [email-marketing.md](email-marketing.md#conditional-content)). Values from the link are only inserted between tags, HTML-escaped and truncated (never into attributes or scripts) – a crafted link can't inject markup.

### Own fonts

*Design → Own fonts*: upload font files (**WOFF2, WOFF, TTF, OTF**, up to 3 MB each, up to 40 per sub-account) and choose them as the font for the website's **body text** and **headings** – one file per weight/style. The files live on your server (`/site-fonts/…`, cached for a long time), nothing is loaded from third parties; the design's system font remains the fallback.

## Speed

Pages are built small and fast: only the **CSS of the blocks that appear on the page** (minified, **inline** in the `<head>` – no blocking stylesheet), **system fonts** instead of web fonts, no JavaScript framework (small scripts for menu, search, countdown and the analytics), `width`/`height` on every image and a reserved frame for videos (**no layout shift**), `loading="lazy"` for images and videos below the first screen, `<main>` and `lang`. The test suite checks budgets for all templates (HTML ≤ 32 kB, gzip ≤ 8 kB, CSS ≤ 16 kB, at most 1,200 elements; measured: largest template page ≈ 19 kB).

## For developers

- **Files:** `server/modules/funnels.ts` (pages, public serving, preview), `blog.ts`, and one module of its own per topic: `site-routing.ts` (redirects, search, translations, deep paths), `site-design.ts` (components, design data), `site-cms.ts` (collections), `site-product.ts` (product block), `site-a11y.ts` (check, statement), `site-analytics.ts` (analytics, board block, MCP), `site-templates.ts` (gallery), `site-media.ts` (image sizes, `/uploads-opt`), `site-snapshot.ts` (copying). The logic lives purely in `server/services/site-*.ts` (`site-blocks.ts` blocks, `site-layout.ts` sections/rows/columns, `site-render.ts` page, header and footer, `site-style.ts` design tokens and responsive CSS, `site-url.ts`, `site-settings.ts`, `site-redirects.ts`, `site-search.ts`, `site-a11y.ts`, `site-cms.ts`, `site-analytics.ts`, `site-images.ts`, `site-templates*.ts`). The interface: `web/src/pages/site/*` (`Editor`, `Tree`, `Inspector`, `Design`, `Cms`, `Redirects`, `A11y`, `Analytics`, `Templates`, `model.ts` as pure tree operations).
- **Custom blocks:** `siteBlocks(app).set(type, { type, css, render(env, block, opts) })` (`server/services/site-blocks.ts`). The CSS only goes onto pages that use the block; `env` brings design tokens, funnel, page, `preview` and `render` for nested blocks. Then register the block in the editor catalog (`web/src/pages/site/blocks.ts`) – a test checks that every catalog block has a server renderer.
- **Hooks in `app.services`:** `siteBlocks` (block registry), `siteRedirect(ctx, funnel, segments)` (redirect before the page), `siteResolve` (dynamic paths, e.g. collections), `siteSearchDocs` (documents for the search), `siteSearchHide` (page IDs that must not go into the search, e.g. password-protected ones), `siteSitemap` (addresses for the sitemap), `siteServe` (serving for other modules), `siteNotFound`/`siteMissed` (404 page and counter), `siteImages` (`dims`, `srcset`) and `imageEngine` (`{name, formats, resize}` – an engine other than `sharp`), plus the existing `pageServe`, `pageVisit`, `htmlTransforms`, `buyPageHtml`, `buyCheckout`, `boardWidgets`, `mcpTools`, `snapshotParts`.
- **Tables:** `funnel_pages.layout`, `site_components`, `site_collections`, `site_items`, `site_redirects`, `site_misses`, `site_hits`, `site_conversions`; all hang off the sub-account (`location_id`) and the website (`ON DELETE CASCADE`). The isolation tests (`tests/tenant-isolation.test.ts`, `tests/security.test.ts`) seed them through `tests/site-fixtures.ts`.
- **SEO & access, fonts:** `site-seo.ts` (check via `services/site-seo.ts` – `checkSeo`, `siteSeoIssues`, `buildSchema`, `schemaScript` –, table `site_schema`), `site-protect.ts` (table `site_locks`, form target `POST /api/site-unlock`, signed cookie per lock and version), `site-dyntext.ts` (`{{url.…}}` and `{{#if url.…}}`), `site-fonts.ts` (tables `site_fonts`, `site_font_use`, files under `data/site-fonts/`); all of them hook into serving through `app.services.pageServe`, registered with a single line `...gapsSitesModules` (`modules/gaps-sites.ts`). Tests: `tests/gaps-sites.test.ts`.
- **API:** all routes are in [docs/api.md](api.md#website-builder-funnels--websites); plus `GET /api/funnels/:id/seo`, `GET|PUT /api/funnel-pages/:id/schema`, `GET|PUT /api/funnels/:id/locks`, `DELETE /api/funnels/:id/locks/:lock`, `GET|POST /api/site-fonts`, `DELETE /api/site-fonts/:id`, `GET|PUT /api/site-fonts/use/:funnel`.
