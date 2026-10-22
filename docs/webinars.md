# Webinare (automated webinars)

**Marketing → Webinare** turns a video into a webinar that plays at an appointment – for everybody who registered, at the same time. It has a registration page, a confirmation with a calendar file, reminders by e-mail and SMS, a room with a countdown, questions, polls and an offer button, a recording, and numbers for every session. Webinars are **automated** and say so: the room is labelled *Automatisiertes Webinar* (and *Aufzeichnung* for the recording), never "live" – see [Honest by design](#honest-by-design-and-german-law-uwg).

Everything is per sub-account. The menu entry and the API use the area **Funnels & Websites** (member logins need it; the SaaS plan decides whether a sub-account has it).

- [How it works](#how-it-works)
- [Set up (self-hosters)](#self-hosting)
- [The editor](#the-editor)
- [Honest by design and German law (UWG)](#honest-by-design-and-german-law-uwg)
- [Tracking and automations](#tracking-and-automations)
- [Numbers](#numbers)
- [API, MCP tools and the app](#api-mcp-tools-and-the-app)
- [Data protection](#data-protection)
- [For developers](#for-developers)

## How it works

1. **Create** a webinar (Marketing → Webinare → *Neues Webinar*): title, description, presenter, a video and its length. It starts as a **draft** nobody can see.
2. **Choose appointments** (tab *Termine*): fixed weekdays and times, single dates, *just in time*, *start right away*, blackout days, seats per session. Sessions are never stored in advance – a session is just its start time, calculated from these rules; it exists once somebody registers.
3. **Publish.** The registration page is `https://<your-domain>/w/<slug>`; it also works as an embed (`?embed=1`) inside a funnel page (block *HTML*) and as a target for forms.
4. Somebody **registers**: a contact is created or updated (tags, source *Webinar: …*), a registration is stored, the confirmation goes out with the personal room link and a `.ics` file, `webinar.registered` runs.
5. **Reminders** go out (default: 24 h and 1 h before, 15 min before, at the start; e-mail, optional SMS).
6. At the appointment the person opens the **room** from the link: a **waiting room** with a countdown, then the video from the second the schedule is at (late joiners start in the middle, nobody can skip ahead), then the **end** with a link to the **recording** (open for 48 h by default).
7. During the session: questions land in **Konversationen**, polls and the **offer** appear at their second, everything is counted per person.
8. Shortly after the end each registration is booked: **watched share** and *left at* for those who were there, **missed** for those who were not – both start workflows.

### Appointments

| Mode | What it does |
| --- | --- |
| Fixed times | Chosen weekdays at one or more times, in the zone of the webinar (daylight saving safe – 19:00 stays 19:00). Offered up to *Wie weit im Voraus* days ahead. |
| Single dates | Any date and time, in addition to or instead of fixed times. |
| Just in time | The next start is always minutes away: every 5–720 minutes on the clock face, inside a daily window and on chosen weekdays (e.g. every 15 minutes from 9 to 21 o'clock). The next three starts are offered. |
| Start right away | "Jetzt starten": the session begins for this person when they register, and they land in the room immediately. Registering twice while it runs returns the same session. |
| Blackout days | Days (or ranges) without sessions; they also remove single dates. |
| Seats | *Plätze pro Termin* (0 = unlimited). A full session shows *ausgebucht*; cancelled registrations give their seat back. |
| Entry after the start | *nur pünktlich*, up to 5 / 15 / 30 / 60 minutes after the start, or until the end. Somebody who is already in stays in. Later arrivals see *Der Einlass ist geschlossen* and the recording after the end. |

Times are shown in the **viewer's time zone** (the browser's); e-mails use the zone the person registered in; the editor shows a preview of the next sessions.

### Video sources

| Source | Notes |
| --- | --- |
| **Upload** | Chunked (8 MB parts) so it works behind proxies; MP4, MOV, WebM, MKV, Ogg; the first bytes are checked. Stored in `data/webinars/`; streamed with byte ranges to people whose session is running (or whose recording is open) – never to the waiting room. The editor reads the length from the file. Limit 4 GB (`PGHL_WEBINAR_MAX_MB`). |
| **Link** | An `https://` link to an MP4/WebM file or an **HLS** playlist (`.m3u8`). |
| **YouTube / Vimeo** | Any link form or the id. Starts at the right second with controls hidden and a layer that blocks clicks; **no drift correction** (the players are not ours) – use a file when exact timing matters. |
| **Video-Studio** | A finished clip or an upload of the Video-Studio of the same sub-account. |

For a **file** the room is the clock: the video is set to the schedule's second at the start and every 2 seconds if it drifts more than 2.5 s; seeking is undone, there is no scrubber while the session runs. The recording is free playback with a scrubber and resumes where the viewer stopped.

## Self-hosting

Nothing to install. What matters:

- **`PGHL_BASE_URL`** must be the public `https://` address – it is in every link of the confirmation and reminders, and browsers only autoplay and sync reliably over HTTPS.
- **A sender.** Mail and SMS go through the sub-account's senders (*Einstellungen → Kanäle*). With the provider *log* nothing is sent (messages are only recorded) – fine for trying it out.
- **The background tick** (`PGHL_TICK_MS`, default 15 s) sends reminders and books finished sessions; keep the server running.
- **Uploads:** `data/webinars/` needs space for your videos (the editor refuses an upload when the disk would run below ~256 MB free). Back it up like the rest of `data/`. A reverse proxy must pass `PUT` bodies of 8 MB and **Range** requests (Caddy and Traefik do by default; nginx: `client_max_body_size 16m;`, and do not buffer the stream: `proxy_buffering off;` for `/w/`).
- **HLS in Chrome and Firefox** needs the small player library *hls.js*, which HyperLevel does not ship (no new dependencies). Safari, iOS and recent Android browsers play HLS natively. To support the others, download `hls.min.js` from the hls.js release page and save it as `data/webinar-assets/hls.min.js`; it is then served from your own domain at `/w/_hls.js` (no third-party request). Without it the room says that the browser cannot play HLS.
- **Content-Security-Policy:** the room loads video only from your server (and from the linked file's `https` host, and YouTube/Vimeo for embeds). Embeds in other sites are allowed for the registration page only.
- **Custom funnel domains** also serve `/w/…` (everything else on such a domain belongs to the funnel). Links in e-mails always use `PGHL_BASE_URL`.

Not needed: no Zoom, no streaming server, no WebSockets.

## The editor

In **Einfach-Modus** ([theming](theming.md#einfach-modus)) *Grunddaten* folds photo and address, *Termine* keeps fixed times, single dates and the preview in view (time zone, just in time, start right away, blackout days and seats behind one toggle), *Anmeldung* folds headline, button text, redirect and the behaviour tags. A folded part opens by itself when it differs from a new webinar.

Six tabs; **Speichern** saves the whole form, **Veröffentlichen** saves and publishes (it tells you what is missing: video, length, at least one appointment). *Zurück zum Entwurf* takes the page offline (registrations stay).

| Tab | What you set |
| --- | --- |
| **Grunddaten** | Title, description, presenter and photo, address (slug), the video source, the length. |
| **Termine** | Time zone, fixed times, single dates, just in time, start right away, blackout days, seats, entry after the start, and a live preview of the next sessions. |
| **Anmeldung** | Headline, button text, the consent text (required), phone (optional/required) and SMS consent, thank-you text or a redirect, tags (on registration and by behaviour: attended, missed, clicked the offer, bought, watched the recording), team notification, **forms that register their senders** for the next free session, link and embed code. |
| **Raum & Angebot** | The labels (see below), waiting and end texts, questions on/off, attendee counter, automatic chat messages, **polls**, the **offer** (a product, a form or a link; a moment in the video; an optional *real* deadline), the recording (on/off, how many hours), and **Raum testen** (a preview from any minute that counts nothing and also works for drafts). |
| **Erinnerungen** | Confirmation subject/text and the reminder list: each with minutes/hours/days before the start, e-mail and/or SMS, and its own texts. Merge fields: `{{contact.first_name|du}}`, `{{webinar.title}}`, `{{session.start_text}}`, `{{session.start_time}}`, `{{join_url}}`, `{{ics_url}}`, `{{cancel_url}}`, `{{replay_url}}`, `{{location.name}}`. |
| **Auswertung** | Numbers, drop-off curve, polls, the registrations (filter by session / present / absent) and the questions with a link into the inbox. |

Reminders are sent **once** per registration and channel, never for a moment that was before the person registered ("24 hours before" a minute after signing up), and not when the moment is more than 20 minutes past (a server that was off). SMS needs the person's consent (checkbox on the page, shown when they enter a number) and a phone number; **Nicht stören** is respected for reminders (the confirmation is transactional and always goes out).

The confirmation carries the `.ics` as an **attachment** with the SMTP sender and as a **link** (`/w/<slug>/ics?t=…`) with every sender. Calendar entries have a 15-minute alert and the personal link.

## Honest by design and German law (UWG)

An automated webinar that pretends to be live misleads the audience (irreführende geschäftliche Handlung, § 5 UWG; the same applies in other EU countries). HyperLevel builds the honesty in:

- The registration page, the room and the recording **always show a label**: *Automatisiertes Webinar* by default, *Aufzeichnung* for the recording. You can change the **wording** (*Webinar-Training*, *Training zum Abruf* …), but the settings **refuse anything that claims it is live** – "live", "Live-Webinar", "Livestream", "in Echtzeit", "Direktübertragung" in any spelling – in the labels, the waiting and end texts and the registration headline. Empty falls back to the default. The label also sits as a badge on the video itself.
- **Automatic chat messages are off by default.** When you switch them on, **every one carries the fixed note "Automatische Nachricht"** that cannot be turned off – they never look like contributions of real viewers. Real attendees' questions are never shown to other attendees.
- The **attendee counter is off by default.** When on, it shows the **real** number of people in the room (heartbeat in the last 45 seconds). There is no setting to boost or invent a number.
- A **countdown on the offer is real.** After the deadline the button stops working for everybody, also in the recording. There is no per-visitor timer that restarts, because "only 10 minutes left" for an offer that never ends is the classic case of misleading scarcity.
- The default texts say what happens: the video is played at the appointment, questions are answered by the team afterwards.
- Registration needs an explicit **consent checkbox**; the text is yours to word (purpose: the registration, reminders by e-mail; SMS has its own checkbox). Cancelling a seat is one click on a confirmation page (`{{cancel_url}}`).

The text of the title and description is yours – HyperLevel does not police editorial copy. This page is not legal advice.

## Tracking and automations

Per registration HyperLevel records: registered, **attended** (the first heartbeat while the video runs), **watch share** and **watch seconds**, **left at**, **clicked the offer**, **bought** (a purchase of the offer's product within 14 days of a click is booked to the webinar), **watched the recording**. The timeline of the contact shows each step (*Für Webinar angemeldet*, *Im Webinar*, *Webinar … 72 % gesehen*, *Angebot angeklickt*, *Nach dem Webinar gekauft*, *Aufzeichnung angesehen*, *verpasst*, *Frage*, *Umfrage*), and the tags of the *Anmeldung* tab are set.

Live watch time is measured by the **server's clock** from the heartbeats (every 20 seconds); what the browser reports cannot lengthen or shorten it. Only the recording trusts the reported position.

### Workflow triggers

All six also take the filter *Webinar* (empty = any webinar) and the generic filters of every trigger.

| Trigger | When | Extra data |
| --- | --- | --- |
| `webinar.registered` | A new registration (page, form, workflow, team, MCP) | |
| `webinar.attended` | First heartbeat while the video runs | `offset_s` – where in the video the person came in |
| `webinar.missed` | ~5 minutes after the session, for those who were never in the room | |
| `webinar.watched_percent` | ~5 minutes after the session, for those who were there – **filter *Mindestens … %*** | `percent`, `watched_s`, `left_at` |
| `webinar.cta_clicked` | First click on the offer button | `offer {title, url}` |
| `webinar.replay_watched` | The recording starts playing | `percent` |

Event data of all of them: `webinarId`, `webinar {id, title, slug}`, `registrationId`, `session {start, end, kind}` (`kind`: `fixed`, `date`, `jit`, `ondemand`), `join_url`, `replay_url`, plus the contact. Use `{{event.replay_url}}` in a "you missed it" mail.

### Workflow action

**Kontakt für Webinar anmelden** (`webinar_register`, category *Inhalte, Kurse & Community*): picks a webinar, registers the contact of the run for the **next free session** (or *Sofort starten*), sends the confirmation unless *keine Bestätigungs-E-Mail* is ticked, and sets `{{var.webinar_join_url}}` and `{{var.webinar_session}}`. Same contact, same session: nothing happens twice. The registration is written to the audit log (actor *Workflow*).

### Forms

*Anmeldung → Formulare, die anmelden*: whoever submits one of the ticked forms is registered for the next free session. The form needs an e-mail field.

## Numbers

Tab *Auswertung*, API `GET /api/webinars/:id/stats`, MCP `ghl_webinar_stats`:

- **Registrations** – seats that were not cancelled. **Attended** – were in the room while the video ran.
- **Show-up rate** – attended ÷ registrations of sessions that have **started** (open sessions do not drag it down).
- **Average watch time** – seconds per attendee, and as a share of the video.
- **Drop-off curve** – 21 points from start to end: the share of attendees who were in the room at that second (late joiners count from their entry).
- **Offer** – clicks (all) and people (first clicks), **sales** and **revenue** (only when the offer's target is a product and the buyer clicked first; revenue in cents).
- **Recording views**, **questions**, **poll results** (real counts).

Each session is a row (all "start right away" registrations form one row).

## API, MCP tools and the app

Team routes (login with `x-location-id`, sub-account API key or agency key; area *Funnels & Websites*; every write is in the audit log): the full list is under [Webinare in docs/api.md](api.md#webinare-automated-webinars).

**MCP tools** (read tools are read-only; registering sends a confirmation mail, so agents ask first):
`ghl_webinar_list`, `ghl_webinar_get`, `ghl_webinar_register`, `ghl_webinar_stats`.

**App:** `GET /api/mobile/webinars`, `/api/mobile/webinars/:id`, `/api/mobile/webinars/:id/stats` (read-only, same areas and sub-accounts as the web).

## Data protection

- A registration stores name, e-mail (and optionally phone) as a **contact**, the consent time and the viewer's time zone, and the viewing data above. It is part of the contact's **export and erasure** (DSGVO): erasing a contact deletes its registrations, questions and votes.
- **Double opt-in is optional.** Anybody can type an address into a registration page; the person then gets the confirmation with the personal link, and the link goes **only by e-mail** (for a session in the future the page itself never shows it), so a stranger cannot watch "as" somebody else. Pages limit registrations per address (20 a minute) and a hidden field catches simple bots. The registration itself is not held back, but **consent to webinar mail and SMS reminders** is recorded in the consent ledger (box text and version, time, IP network) and, if you switch on *Einstellungen → Einwilligung & Recht → Double-Opt-in → Webinar-Anmeldung*, only counts after the person clicked a confirmation link (one extra mail; trigger `consent.confirmed`). Details: [docs/consent.md](consent.md#double-opt-in).
- Pages are `noindex`, `no-store`, send no referrer, and load nothing from third parties – except YouTube (privacy-enhanced domain) or Vimeo (do-not-track) when you chose those as video source.
- The viewer link contains a signature (HMAC with the server secret); cancelling the registration revokes it.

## For developers

Modules (all registered near the end of `server/modules/index.ts`, no shared file holds webinar code):

| File | Purpose |
| --- | --- |
| `modules/webinars.ts` | Tables, team routes (`/api/webinars*`), the chunked upload, `app.services.webinars` (`get`, `tick`, `sweep`) |
| `modules/webinar-public.ts` | `/w/<slug>`, `/watch`, `/replay`, `/ics`, `/media`, `/go`, `/cancel`, `/w/_hls.js`, `/api/public/webinars/<slug>/*` |
| `modules/webinar-automation.ts` | Triggers + filters, the action, the form bridge, purchase attribution, the tick |
| `modules/webinar-tools.ts` | MCP tools, `/api/mobile/webinars*` |
| `services/webinar-schedule.ts` | **Pure**: sessions, blackout, just in time, the room clock |
| `services/webinar-model.ts` | Defaults, validation, honest-wording rules, signed tokens |
| `services/webinar-video.ts` | Pure: video sources, embeds, byte ranges |
| `services/webinar-register.ts` | Registration, confirmation, `.ics`, reminders |
| `services/webinar-track.ts` | Heartbeat, offer, questions, votes, end-of-session bookkeeping |
| `services/webinar-stats.ts`, `webinar-pages.ts`, `webinar-room-client.ts` | Numbers; the public HTML; the room's script and styles |
| `web/src/pages/Webinars.tsx`, `WebinarEditor.tsx`, `WebinarTabs.tsx`, `WebinarRoomTab.tsx`, `WebinarStats.tsx`, `WebinarKit.tsx` | The UI (lazy chunk) |

Test hooks: `app.services.webinarNow = () => ms` moves the module's clock (schedules, heartbeats, reminders, end-of-session); tests live in `tests/webinar-*.test.ts`. Mail and SMS are the sub-account's `log` provider in tests; nothing calls the network.
