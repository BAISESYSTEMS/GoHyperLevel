# Reputation: reviews from many platforms

*Bewertungen* collects what people say about you: your own **review requests** (4–5 stars go on to your public profile, criticism stays internal), **Google** (Places API or the Business Profile with replies – see [integrations](integrations.md)) and – on this page – **every other platform**: Facebook, Trustpilot, ProvenExpert, Yelp, Tripadvisor and, through the import adapter, platforms without an API such as Jameda, Kununu or Golocal.

All of them end up in one list (*Bewertungen → Weitere Plattformen*) with the platform, the stars, the text and your reply. New reviews fire the existing workflow trigger **„Bewertung erhalten“** (`review.received`), low ratings notify the team, the **AI writes reply drafts** in your tone and brand voice, and the **review widget** for your website shows every platform.

- [Platforms](#platforms)
- [Connecting a platform](#connecting-a-platform)
- [Import: CSV, RSS and web hook](#import-csv-rss-and-web-hook)
- [New reviews, triggers and AI drafts](#new-reviews-triggers-and-ai-drafts)
- [Replying](#replying)
- [Review widget](#review-widget)
- [API and MCP](#api-and-mcp)
- [Review requests in bulk and reminders](#review-requests-in-bulk-and-reminders)
- [Video testimonials](#video-testimonials)
- [Privacy](#privacy)
- [For developers](#for-developers)

## Platforms

| Platform | How | What comes in | Reply from HyperLevel |
| --- | --- | --- | --- |
| **Facebook** | Graph API with the page token from *Einstellungen → Kanäle* (permission `pages_read_user_content`; to reply `pages_manage_engagement`) | Overall rating, count, recommendations/reviews (*recommends* = 5★, *does not recommend* = 1★) | **Yes** – a comment on the recommendation |
| **Trustpilot** | Trustpilot Business API: API key (public reviews); API secret + a business user's login to reply | TrustScore stars, count, the newest 100 reviews with your existing replies | **Yes**, with API secret and business user |
| **ProvenExpert** | ProvenExpert API (API ID + API key) | Overall rating and count (widget, statistics). Single reviews: export them as CSV from ProvenExpert and use the import | No – link to ProvenExpert |
| **Yelp** | Yelp Fusion API (API key), read only | Rating, count and the newest excerpts | No – link to biz.yelp.com |
| **Tripadvisor** | Tripadvisor Content API (API key; your domain on the key's allow-list), read only | Rating, count and the five newest reviews | No – link to the Management Center |
| **Import** (Jameda, Kununu, Golocal, …) | CSV upload, an RSS/Atom feed, or a web hook | Whatever you deliver | No – link to the profile you entered |

Yelp's and Tripadvisor's terms do not allow keeping their content: for these two HyperLevel keeps **only what the latest daily fetch returned** (older reviews drop out of the list).

Every connection is synced **once a day** (a failed fetch is retried after an hour); *Jetzt abrufen* fetches right away. Each sub-account can connect up to 30 sources, several of one platform too (e.g. two Trustpilot domains).

## Connecting a platform

*Bewertungen → Weitere Plattformen → + Plattform verbinden*, choose the platform, fill in the fields:

- **Facebook:** pick one of the pages connected under *Einstellungen → Kanäle* (several pages: [meta-channels.md](meta-channels.md#multiple-pages-and-instagram-accounts)). No extra key – the page token is used.
- **Trustpilot:** the domain as listed on Trustpilot (or the business unit ID) and the **API key** from the Trustpilot developer portal. For replies add the **API secret** and the e-mail and password of a business user with access to the account (HyperLevel fetches a short-lived token with the password grant for each reply; the password is sealed like every key).
- **ProvenExpert:** *API-ID* and *API-Key* from ProvenExpert (*Integration → API*), optionally your profile link.
- **Yelp:** the business ID or alias (the last part of `yelp.com/biz/<alias>`) and a Fusion API key.
- **Tripadvisor:** the location ID (the number after `-d` in the Tripadvisor URL) and a Content API key; add your server's domain to the key's allowed domains.

The first fetch runs right away and imports what is there **quietly** – older reviews are history, not news. Keys are stored sealed (AES-256-GCM) and shown as `••••••` only; a masked or empty field keeps the stored value.

## Import: CSV, RSS and web hook

An import source has a **platform name** (shown everywhere), an optional **profile link** (where you reply) and optionally an **RSS/Atom feed** (https only, fetched daily through the SSRF-safe fetcher; stars are read from texts like „4,5/5“, „4 von 5“ or ★★★★☆).

- **CSV:** *Import* on the source. Header row with `author`, `rating`, `text`, `date`, `link`, `id`, `title`, `reply` – German headers (`Name`, `Sterne`, `Kommentar`, `Datum`) work too. Up to 5,000 rows; rows without text and rating are skipped; the same `id` (or, without one, the same author + date + text) is stored once. An upload is a look back and announces nothing, unless you tick *Neue Bewertungen melden*.
- **Web hook:** every import source has its own address `https://<domain>/hooks/reviews/<source>/<key>` (shown in the import dialog). `POST` one review as JSON (`{author, rating, text, date, link, id}`) or `{reviews: [...]}` (up to 200). New ones are announced like synced reviews – handy for Zapier/Make or a scraper you run yourself.

## New reviews, triggers and AI drafts

- **Trigger „Bewertung erhalten“** (`review.received`) with the existing filters *mindestens / höchstens Sterne*; the event carries `{{event.source}}` (`trustpilot`, `facebook`, …), `{{event.platform}}` (the name), `{{event.rating}}`, `{{event.comment}}`, `{{event.author}}`, `{{event.link}}`, `{{event.low}}`. Google keeps its own trigger *Neue Google-Bewertung*.
- **Low ratings** (3★ and less) e-mail the team with the text and the link.
- A review whose author name matches exactly one contact is linked to it (timeline entry).
- **KI-Antwort vorschlagen** on a review writes a draft with the settings of [KI-Antworten](integrations.md) (*Einstellungen → Bewertungen*: tone, du/Sie, own hints, signature) and the KI-Assistent's persona and facts – the prompt names the platform. With *automatisch Entwürfe* on, every new review gets a draft by itself. Drafts are never posted on their own; they count towards the AI budget and share the hourly cap with Google.

## Replying

Where the platform's API allows it (Facebook, Trustpilot with a business user) *Öffentlich antworten* posts the reply and stores it on the review. Everywhere else the reply box offers *Auf <Plattform> antworten*: it copies your text and opens the review (or your profile) on the platform – paste and send it there. The API answers `409` with a `reply_link` in that case.

## Review widget

The embeddable widget (`/r/widget/<sub-account>`, *Bewertungen → Bewertungs-Widget*) now shows a badge per platform – rating, stars, count, link to the profile – and the best reviews (4★ and up, with text) of every source next to your own and Google's, each with a link to the platform.

## API and MCP

All under the sub-account. Connecting is area *Einstellungen*, the reviews area *Bewertungen*.

| Endpoint | |
| --- | --- |
| `GET /api/review-sources` | `{adapters: [{id, label, kind, hint, fields, replies, mirror}], connections: [...], facebook_pages}` – secrets come back as `••••••` |
| `POST /api/review-sources` | `{source, label?, …fields}` → the connection and the first `sync` result |
| `PATCH/DELETE /api/review-sources/:id` | change fields, `label`, `enabled`; delete (with its reviews) |
| `POST /api/review-sources/:id/sync` | fetch now → `{fetched, new, rating, total}` |
| `POST /api/review-sources/:id/import` | `{csv, announce?}` (import sources) |
| `GET /api/review-items?source=&connection_id=&max_rating=&open=1&limit=` | `{items: [{…, platform, can_reply, reply_link}], summary}` |
| `GET /api/review-items/summary` | rating and count per platform, incl. Google and your own requests, plus the weighted overall rating |
| `POST /api/review-items/:id/suggest-reply` | `{tone?, instruction?}` → AI draft |
| `PUT/DELETE /api/review-items/:id/reply-draft` | edit or drop the draft |
| `POST /api/review-items/:id/reply` | `{text}` – through the platform's API, else `409` with `reply_link` |
| `POST /hooks/reviews/:id/:key` | public web hook of an import source |

**MCP:** `ghl_review_sources` (`list`, `summary`, `suggest`, `reply`) next to `ghl_google_reviews` and `ghl_suggest_review_reply`.

## Review requests in bulk and reminders

*Bewertungen → Viele Kunden auf einmal fragen*: send the review request to every contact with a tag (e.g. `auftrag-erledigt`) by e-mail or SMS – at most 200 at once. Skipped, with the reason: contacts without an address for the channel and contacts asked within the last 90 days (adjustable). Under *Erinnerung & Abstand* a **reminder** goes out once when a request has no answer after N days (2–30, 0 = off; requests older than two more weeks are left alone). Sending uses the normal review request (your text, consent and suppression). API: `POST /api/reviews/request/bulk` `{tag | contact_ids, channel}`, `GET|PUT /api/reviews/request-settings` `{followup_days, skip_days}`; MCP `ghl_review_request_bulk`. Module `server/modules/review-requests-plus.ts`.

## Video testimonials

*Bewertungen → Video-Testimonials*: every sub-account has a **collect page** (*Link zur Sammelseite kopieren*, `/testimonials/<address>`). It is **off until you switch it on** (*Seite anpassen* → *Sammelseite nimmt Videos an*); pages switched on before stay on. A customer records a short video on the phone (the file field opens the camera) or picks a file, adds their name, an optional sentence and the **consent** to show it with their name, and sends it – one upload of at most 80 MB, WebM/MP4/MOV, checked by its bytes. Limits against abuse: the server reads no more than the size the page announced (the upload is cut off with 413 while it streams in), a failed upload uses its one-time link up, at most 10 videos an hour per visitor address and 30 an hour per sub-account, and a **disk quota** per sub-account (`PGHL_TESTIMONIALS_MB`, default 2048 MB, `0` = no cap of its own; in the hosted cloud the plan's media storage counts as well) – when it is full the page refuses new videos with 413 until you delete old ones. New videos arrive as **neu**; you watch them in the app and **approve**, **reject** or delete them. Only approved videos appear on the **video wall** (`/testimonials/<address>/wall`, embeddable as an iframe – code under *Video-Wand einbinden*) and are reachable by URL. *Seite anpassen* changes heading, introduction and thank-you text, or switches the collect page off. A new video fires the event `testimonial.received` (name, e-mail, text) for workflows and webhooks.

API: `GET /api/video-testimonials` (page + videos), `PUT /api/video-testimonials/page`, `PATCH /api/video-testimonials/:id` `{status: approved|rejected|pending}`, `DELETE /api/video-testimonials/:id`, `GET /api/video-testimonials/:id/video`. MCP: `ghl_video_testimonials`, `ghl_video_testimonial_review`. Module `server/modules/video-testimonials.ts` (tables `testimonial_pages`, `video_testimonials`; files under `data/testimonials/`), UI in the slot `reviews.panel`.

## Privacy

A review is public on its platform and belongs to the platform. HyperLevel stores the author name the platform shows, the stars, the text and links. When a linked contact is erased (DSGVO), the review stays and only the link to the contact is removed – as for Google reviews. Removing a source deletes its stored reviews.

## For developers

`server/services/review-sources.ts` holds the adapter registry – `registerReviewAdapter({id, label, kind, fields, hint, mirror?, fetch(ctx), canReply(ctx, review), reply?(ctx, review, text), replyLink(config, review)})` – and the built-in adapters plus the pure CSV/RSS parsers. An adapter gets `{config, secrets, http, graph?, fetchUrl?}`: `http` only talks to the platform's fixed host (test hook `app.services.reviewSourceFetch`), `graph` uses the page token of the Meta channels (`metaKit.graph` with the page ID), `fetchUrl` goes through `safeFetch`. `server/modules/review-sources.ts` stores connections (`review_connections`, secrets sealed) and reviews (`review_items`, unique per connection and external ID), runs the daily sync in the tick, fires `review.received`, adds itself to the review widget through `app.services.reviewWidgetParts` and drafts replies through `app.services.reviewReplies.suggest` (modules/review-replies.ts). Tests: `tests/review-sources.test.ts` (fake APIs only).

Endpoints follow the platforms' public documentation (October 2026) and are tested against fakes; please check with a real account once: Trustpilot's password grant for business users, the field names of ProvenExpert's rating summary, and Tripadvisor's domain allow-list for server-side calls.
