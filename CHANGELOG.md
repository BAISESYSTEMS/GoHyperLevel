# Changelog

All notable changes to HyperLevel (formerly GoHigh, then GoHyperLevel) are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions were `0.0.N` up to 0.0.43; from 1.0.44 on they are `1.0.N`, one step per
production deploy. The Android app keeps its own version (`versionName` 1.0.x).

## [Unreleased]

## [1.0.67] – 2026-10-23

### Added
- Landingpage: aufklappbarer Funktionsvergleich unter den Preisen (Selbst gehostet, Solo, Team & Company, Agentur) mit Häkchen –
  passend zu den Berechtigungen der Tarife (White-Label, Kunden-Accounts, Domains und App nur Agentur, SaaS-Modus nur selbst gehostet).

### Changed
- Domain-Agent: `PGHL_AGENT_PREFIX` gibt jeder Instanz auf einem Server ihr eigenes Datei-Präfix (Standard `pghl-`), damit zwei
  Agenten (z. B. eine private Instanz und eine Cloud-Instanz) nie die nginx-Seiten des anderen entfernen.
- Positionierung „Kein weiteres AIOS – die Business-Schicht für deins“: Landingpage-Abschnitt, Hero-Badge und README sagen, dass sich
  jeder bestehende Agent oder AIOS-Harness per MCP und REST einfach andockt (Universaladapter).
- Zielgruppe überall „for agentic solopreneurs, agencies, small businesses & startups“ / „für agentische Solopreneure, Agenturen,
  kleine Unternehmen und Startups“: Hero-Zeile, Seitenbeschreibungen, Social-Karten (neu gerendert), README und README-Banner.

## [1.0.66] – 2026-10-23

### Changed
- Landingpage: der Hero rotiert wieder („Deine Plattform für KI-Agenten / Vertrieb & CRM / Funnels & Websites …“), darunter
  „für Solopreneure, Agenturen, kleine Unternehmen und Startups“ (EN: „for solopreneurs, agencies, small businesses & startups“).

### Fixed
- Landingpage: eine erzwungene Aktualisierung der GitHub-Sterne wartet auf einen schon laufenden Abruf und fragt danach neu
  (vorher gab sie dessen ältere Antwort zurück – ein gelegentlich roter Test).

## [1.0.65] – 2026-10-23

### Changed
- **Landing page, agentic first:** new tagline "The free, open-source growth OS for solopreneurs, agencies & small agentic
  businesses" (DE: „Das freie Open-Source-Wachstums-Betriebssystem …"); an "Integrates with your favorite tools" row of real
  integrations under the hero (CSS-only, pauses on hover/focus, still with reduced motion, each mark checked against the
  catalogue); new sections *One single source of truth* (agents fill the CRM over MCP/REST with the same rights, audit log and
  undo), *Jarvis*, *What makes HyperLevel different* (nine reasons), the Academy (14 chapters, 120+ module tours, 10 lessons),
  designs, XR and *Open source – and open for contributions*; the proof row counts MCP tools, workflow triggers and actions
  live; features, FAQ and the apps section updated (APK at `/downloads/hyperlevel.apk`, the HyperLevel mark on the download
  buttons, in the footer and as SVG favicon); optional screenshots `shot-jarvis|academy|themes|xr.webp` show once present, at
  their real size. Social cards re-rendered with the new tagline.
- Markenzeichen ohne hochgeladenes Logo ist überall das HyperLevel-Icon (`/icon.svg`) statt eines Anfangsbuchstabens: Seitenleiste,
  Login, OAuth-Freigabe und Logo-Vorschau – auch für die Demo („HyperLevel Demo“). Ein hochgeladenes Logo oder Zeichen gewinnt weiter.
- README- und Landing-Bilder neu gerendert (HyperLevel-Icon statt „G GoHigh“, ohne Erststart-Hinweise), dazu neu: Fokus-Modus mit
  Jarvis, Akademie, Designs nebeneinander und die 3D-Vorschau (XR); Canvas, Wiki und Team-Chat kommen jetzt auch aus dem Skript
  (`scripts/shots-kit.mjs`). PNGs auf 256 Farben (8,8 → 3,3 MB).

### Fixed
- Landing page research: our own cells and notes re-checked against the code (store with cart, PayPal and Mollie, reviews from
  several platforms, outbound AI calls, several signers, list and calendar views, visual workflow editor, Funnel AI, Office as
  *partial*, 350+ MCP tools); the *Warum wechseln?* paragraphs no longer name these as gaps; the test count is current.

## [1.0.64] – 2026-10-22

### Changed
- Android-App: Download heißt jetzt `/downloads/hyperlevel.apk` (die alte Adresse `gohigh.apk` bleibt für installierte Apps); die Seite
  `/android` zeigt das App-Icon bzw. das Agentur-Logo statt eines Anfangsbuchstabens.

### Fixed
- Wachstums-Briefing: antwortet das Ersatzmodell mit normalem Text statt im JSON-Format, wird die Antwort jetzt genutzt (die
  Zahlenprüfung bleibt) – bisher fiel das Briefing dann auf die Regel-Worte zurück.

## [1.0.63] – 2026-10-22

### Fixed
- Wachstums-Briefing: fehlgeschlagene KI-Aufrufe (Ausfall beim Anbieter) verbrauchen nicht mehr die vier KI-Formulierungen pro Tag – nur
  echte Antworten zählen.
- Wachstums-Briefing: eine KI-Formulierung, die eine Zahl aus dem letzten Briefing aufgreift (z. B. „seit 28 Tagen“), wird nicht mehr
  verworfen – auch diese Zahlen stammen aus den Daten; Verwerfen und Fehler stehen jetzt im Server-Log.

## [1.0.62] – 2026-10-22

### Added
- **Wachstumsidee „Lead-Fluss aufbauen“:** seit 28 Tagen kein neuer Kontakt → Lead-Magnet, Formular, Landingpage-Abschnitt und
  Willkommens-Mail als Entwurf, mit einem Klick an den Agenten.

### Changed
- **Jarvis formuliert mit KI:** Wochenbilanz und „Wachstums-Briefing jetzt ansehen“ gehen immer ans Sprachmodell – auch wenn es nichts
  Neues gibt (dann eine ehrliche Einschätzung aus Zahlen und Zielen des Steckbriefs mit einem Hebel für mehr Umsatz); Zahlen, die nicht
  in den Daten stehen, lassen weiter die Regel-Worte sprechen. Die Ziele aus dem Steckbrief gehören jetzt zu den Daten des Modells.

## [1.0.61] – 2026-10-22

### Added
- **Jarvis als Business Developer** (neue Standard-Rolle, „Assistent“ bleibt wählbar): denkt ans ganze Geschäft – Umsatz und Pipeline,
  Lead-Fluss, Kundenbindung, Marketing, Engpässe, Ziele aus dem Steckbrief –, antwortet mit Zahlen aus den Werkzeugen, ordnet nach
  €-Wirkung und endet mit 1–3 Schritten, die er vorbereitet; wiederholt nicht, was er in den letzten Tagen schon gesagt hat.
- **Wachstums-Briefing** (auf Wunsch einschaltbar, Standard aus): täglich zur eigenen Uhrzeit Top-3-Chancen und -Risiken mit €-Betrag
  und eine Wachstumsidee mit fertigem Entwurf, nur wenn es Neues gibt, nie in der Ruhezeit; montags die **Wochenbilanz** mit Umsatz,
  Leads, gewonnenen Deals, Abschlussquote und Pipeline gegenüber der Vorwoche. Zählungen folgen den Datensatz-Rechten.
- **Ersatzmodelle:** fällt ein Modell aus (5xx, 429, Überlastung, kie.ai „no_available_account“, Zeitüberschreitung), versucht der Agent
  einen zweiten Anlauf, dann das nächste Modell derselben Verbindung (kie.ai: Sonnet 5.5 → Sonnet 5 → Haiku 5.5), dann andere
  Verbindungen; pro Verwendung einstellbar. Antwortet kein Modell, antwortet Jarvis im Fokus-Modus aus den Zahlen.
- Lesendes MCP-Werkzeug `ghl_growth_review`, `GET /api/companion/growth`.

## [1.0.60] – 2026-10-22

### Added
- **Dateien im Kundenportal:** Dokumente eines Kontakts per „Im Portal freigeben“ für genau diesen Kunden freigeben; „Meine Dateien“ im
  Mitgliederbereich; optional Kunden-Uploads (Größe, Speicher, Typen einstellbar, max. 20/Tag), Downloads immer als Anhang; Agent/MCP
  `ghl_portal_files`, `ghl_portal_file_share`.
- **Formular-Mapping:** Formularfelder schreiben auch in Firma, Deal (Pipeline/Stufe, neu oder offener Deal) und eigene Objekte; geschützte
  Spalten (Zuständig, Quelle, Status, Stufe, IDs) sind gesperrt; Einfach-Modus unter „Weitere Felder“; Lese-Tool `ghl_form_mapping`.
- **Event-Tickets mit Ticketarten:** Kalender → Events & Tickets – bis zu 20 Arten je Event mit Preis, Kontingent, Verkaufsfenster und
  Höchstzahl; eigener QR je Ticket, Check-in mit Art, Bericht; kein Überverkauf (Transaktion); Zahlung über Stripe/PayPal/Mollie/Gutschein;
  Auslöser `tickets.ordered`; Tools `ghl_ticket_sales`, `ghl_ticket_event_save`, `ghl_event_ticket_checkin`.
- **Vermietung:** Kalender → Vermietung – Dinge mit Stückzahl nach Tagen oder Nächten buchen, Seite `/book/rent/<name>` mit Monatskalender,
  Preis + Kaution, keine Überbuchung, mehrtägige Termine in der Kalenderansicht; Tools `ghl_rental_availability`, `ghl_rental_book`,
  `ghl_rental_save`.

## [1.0.59] – 2026-10-22

### Added
- **SMS- und WhatsApp-Entwürfe:** der HyperLevel-Agent, eigene KI-Agenten und MCP-Assistenten legen mit `ghl_draft_message` einen
  Antwort-Entwurf per SMS oder WhatsApp in der Konversation ab, ohne zu verschicken. Im Posteingang steht er im Eingabefeld des Kanals
  (prüfen, ändern, mit einem Klick senden – „Nicht stören“, 24-Stunden-Fenster und Vorlagenpflicht gelten); was gerade getippt wird,
  überschreibt er nie („Neuer Entwurf verfügbar – übernehmen“). `POST /api/conversations/drafts`.
- **Smart Lists 2.0 für Kontakte:** gespeicherte Ansichten mit Suche, Filtern, Spalten (auch eigene Felder) und Sortierung, geteilt oder
  privat, Schnellwechsel über der Tabelle, „Verwalten“ (umbenennen, teilen, löschen), Sortieren nach jeder Spalte auf dem Server;
  Lese-Werkzeuge `ghl_smart_lists` und `ghl_smart_list_contacts`. Ohne geöffneten Kontakt zeigt die Liste die volle Tabelle.

### Fixed
- SMS-/WhatsApp-Entwürfe des Auto-Antworters ließen sich in der Sprechblase fälschlich als E-Mail senden.
- Private Smart Lists bleiben überall privat (Dialer, Kampagnen, Sequenzen, Umfragen, Werbe-Zielgruppen); eine gelöschte oder nicht
  freigegebene Liste wählt niemanden mehr aus statt alle Kontakte.

## [1.0.58] – 2026-10-22

### Added
- **Jarvis speaks through kie.ai:** the kie.ai connection now offers *Sprachausgabe* (ElevenLabs Turbo 2.5 / Multilingual v2 on kie's
  Market API) and can be picked as Jarvis's voice. `auto` is the ElevenLabs voice *Brian*, told the app's language (`language_code`), so
  German is spoken without an accent; kie's voice list is offered in the settings; speech tasks are polled every 0.8 s. "auto" now
  resolves per provider (Google: native Chirp 3 HD voice, kie.ai: Brian, others: their default) and the companion passes its language.

### Fixed
- **Login:** HyperLevel shows its app icon instead of the letter "H", centred with title and line above the form.

## [1.0.57] – 2026-10-22

### Fixed
- **„Die App konnte nicht starten“ zwischendurch:** the quick-settings button next to the logo measured itself inside a React state
  updater; when React ran that updater later (while rendering) the click event was already gone (`Cannot read properties of null
  (reading 'getBoundingClientRect')`) and the whole app fell to the start-up error page. It now measures on click. A source check
  (`tests/updater-events.test.ts`) keeps state updaters across the web app from reading the event again.

## [1.0.56] – 2026-10-22

### Added
- **Kacheln sortieren – überall:** tiles and cards are dragged into your own order on their whole surface, no drag handles
  (mouse/pen after 6 px, touch after a 350 ms long-press so swiping still scrolls; clicks and links keep working; Esc cancels;
  Alt+Shift+arrows move a focused tile with a screen-reader announcement; "Reihenfolge zurücksetzen" once changed). Covers the
  dashboard (key figures, cards, pipelines, plugin widgets – also in Einfach-Modus and behind "Mehr anzeigen"), Agentur → Projekte
  and the projects overview, about 50 key-figure rows and card lists across the app, and focus-mode tiles. The order is saved per
  person in the appearance preferences (`tile_order`, `PATCH /api/appearance`) with a browser copy for instant and offline use
  (`web/src/sortable/`, docs/theming.md#kacheln-sortieren).

### Security
- 1.0.55 security fixes from the wave-10 review are included (see 1.0.55).

## [1.0.55] – 2026-10-22

### Added
- **Einfach-Modus for forms and tables** (`web/src/areas/fields.tsx`): `MoreFields` (one "Weitere Felder" toggle that opens by itself
  when a field holds a value and stays open once opened), `ProOnly`, `SimpleOnly` and `useSimpleColumns` (essential columns plus a
  "Spalten" picker). Profi shows everything as before.
- **Einfach-Modus on the daily pages:** dashboard with four action tiles (open/overdue tasks, unread messages, upcoming appointments,
  open pipeline) and the next appointments, the rest behind "Mehr anzeigen"; contacts (4 columns, folded filters and bulk actions,
  5-field forms, side panels behind "Mehr zum Kontakt"), companies, deals, custom objects and calendar settings trimmed the same way.
- **Einfach-Modus in marketing and automation:** campaigns, workflow steps (catalogue steps show required fields plus at most five,
  retries/headers/auth/mapping folded), workflow settings, email designer ("Darstellung"), forms, blog, website settings, sequences,
  quizzes, NPS, webinars, courses, community groups and ads forms show the essentials first.
- **Einfach-Modus in Einstellungen and Agentur:** 8–10 of 29 settings tabs (by goal) and 6–7 of 22 agency tabs, the rest grouped and
  searchable under "Weitere Einstellungen" / "Weitere Bereiche"; **"Was muss ich einrichten?"** lists only what is still missing;
  technical fields (SMTP port, tracking, webhook URLs and secrets, Twilio IDs, SSO claims, number ranges, e-invoice options, limits,
  retention, Double-Opt-in texts …) folded on 20+ settings pages; webhook guides fold away once everything works. Guided tours
  unfold folded fields and tabs by themselves.
- **AI agents everywhere:** 20 new everyday tools (`server/modules/agent-ops-tools.ts`: change tasks; list/create/move/cancel
  appointments; update/tag/merge contacts; reply draft; invoice/quote draft; campaigns list/draft; workflows list/enroll/pause;
  form submissions; survey results; reviews; business settings), the route finder `ghl_api_routes` for everything else (writes still
  confirmed), a coverage matrix computed from the router with a justified exemption list and `tests/agent-coverage.test.ts`
  (every module reachable or exempt, schemas, confirmation rules, sub-account and role isolation); "Erledige das hier" from forms,
  funnels, workflows, courses, campaigns, contracts and webinars; slimmer tool results; read-only agents can read every area.
- **CRM, inbox and automation parity:** tags in bulk (usage, rename, merge, colour, file, delete – undoable, no tag workflows
  fired), inbox filters by tag/pipeline/stage/owner and full-text search across all messages, bulk owner for contacts, custom-field
  clean-up, documents on contacts and attachments on notes (`PGHL_CONTACT_DOCS_MB`), field change history for contacts and deals,
  Smart Tags on deal cards, "Prognose & Risiken" forecast, workflow folders and bulk actions, triggers "Ausgehende Nachricht
  gesendet" and "Teammitglied hat geantwortet", split-test auto-winner, company bulk actions (API/agent).
- **Booking, forms and commerce parity:** several signers with roles and order on contracts, service menu `/book/s/…` (service →
  person → time), several meeting lengths, several appointments in one booking, guests, conditional booking questions, QR tickets
  with check-in, "Meine Termine" in the customer portal, calendar AI tools, PDF of a form submission, save-and-continue for forms,
  single-use coupon codes, loyalty points with tiers and rewards, packing slips, abandoned checkouts with recovery links.
- **Sites, marketing and agency parity:** password-protected pages, text and sections from URL parameters, own font files, SEO check
  (per page, duplicates, any URL), Schema.org per page, take single pages offline and reorder, WordPress plugin per sub-account,
  conditional content `{{#if …}}` in e-mails/SMS/documents, social post approval by magic link and evergreen categories, video
  testimonials and bulk review requests, Google Ads lead forms, custom contact fields as report metrics, agency announcement
  banners, own roles with read-only areas, own wording of system mails, prompt optimizer for agents and the phone agent, courses
  drafted by AI.

### Changed
- **Jarvis speaks without an accent:** the default voice is `auto` – Google Chirp 3 HD `de-DE-Chirp3-HD-Iapetus` in German and
  `en-US-Chirp3-HD-Iapetus` in English (clear, native male voice); the 1.0.53 default `en-GB-Neural2-B` (it read German with an English
  accent) is read as `auto`. The browser fallback prefers a natural male voice of the app language (e.g. *Conrad* in Edge).
- Less noise in both modes: shorter hints, no empty "Noch kein …" sections, duplicate links removed; Settings no longer loads the
  agency page into its bundle.

### Security
- Agents can no longer reach the agency's AI keys and provider settings or people's personal ChatGPT/Claude logins through `ghl_api`.

## [1.0.54] – 2026-10-22

### Added
- **Jarvis live – Gesprächsmodus:** after a spoken question the microphone stays open for a follow-up window (companion settings →
  *Sprechen → Gesprächsmodus*: off, 5, **8** (default) or 15 s) – you simply keep talking. Voice activity detection in the browser
  (`web/src/companion/vad.ts`: Web Audio energy with an adaptive noise floor, ~150 ms of speech starts a turn, ~800 ms of silence
  ends it) sends the turn to the sub-account's speech to text (or the browser's recognition); the window closes silently in
  silence, *"danke Jarvis"* / *"stopp"* / *"das war's"*, Esc or ✕ end the conversation. A pill shows *hört zu / denkt nach /
  spricht* with a red *Mikro an* mark (also on the edge button); the wake word pauses meanwhile; reduced motion is respected.
- **Barge-in:** while Jarvis speaks the open microphone watches for your voice (higher threshold and ~250 ms, `echoCancellation`
  on) and stops the server audio and the browser voice at once, then listens; a click or **Space** interrupts too (*Unterbrechen
  erlaubt*, default on).
- **Spoken while the agent writes:** answers are spoken sentence by sentence as they stream (`SentenceSplitter`, abbreviations
  do not split); a longer task first gets a short, varied filler (*"Moment, ich schau nach …"*).
- **Hintergrundaufgaben:** agent runs live outside the focus page (`web/src/companion/tasks.ts`) – asking the agent something new
  while it works moves the running request to the background; a compact task list in focus mode, a spinner on the edge button, and
  *"Erledigt: …"* / *"Das hat nicht geklappt: …"* / *"… braucht deine Bestätigung"* by voice and toast when a background run ends.
- **Ereignis-Auslöser** (`server/modules/companion-live.ts`, registry `services/companion-triggers.ts`): new lead (`contact.created`),
  message unanswered for X minutes (scan, default 30, per person), invoice became overdue, appointment in 10 minutes, review with
  ≤ 2 stars (`review.received`), deal won/lost (`opportunity.status_changed`), payment failed (`payment.failed`), automation failed
  (scan) – listeners through `app.events` and an own scan in `onTick`, nothing added to other features. Per person: each trigger
  on/off and **Sofort** (spoken when the app is open, at most one spoken interrupt per 3 minutes, else a silent card; web push
  `companion_event` when closed; quiet hours → collected) or **Gesammelt** (into the next check-in: *"Seit dem letzten Check-in:
  …"*); only people with the area's right hear it, an assigned record only its owner; dedupe per record. Each message offers a next
  step; *Ja, bitte* or a spoken *"ja"* hands it to the agent, whose confirmation card still needs a click. The open app polls
  `GET /api/companion/live` (~15 s while visible).
- **Eigeninitiative** (`services/companion-initiative.ts`): on check-ins and on demand the model (`aiRun`, purpose
  `companion_initiative`, schema-constrained, logged in `ai_calls`, 30 per person and day) looks at the briefing, open deals, warm
  leads without an answer, customers who went quiet, today's appointments, the project's goals and up to five *gemerkte Hinweise*
  (Gedächtnis), and suggests opportunities, risks, growth steps and work it prepares in advance (reply, e-mail, task list, social
  post as a draft – text stored with the suggestion; accepting hands it to the agent as quoted data). Suggestions only point at
  records from the facts, spoken numbers must come from the data; tracked as offered / accepted / declined / ignored with cool-downs
  (72 h, declined 14 days, a record once a day) and light learning (declined kinds are dropped). Level *Zurückhaltend /
  Ausgewogen / Sehr proaktiv* sets frequency and whether strategic ideas come. For a new lead, a waiting message or a bad review the
  event can come with a prepared draft. Without an AI provider the rules suggest from *Was brennt?* (the settings say so).
- **Echtzeit-Stimme (optional):** *Sprach-Engine* → *Echtzeit – Gemini Live*: a pluggable realtime engine
  (`web/src/companion/realtime.ts`) streams 16 kHz PCM through our server (`POST /api/companion/live/session` → one-time ticket →
  WebSocket `/ws/companion-live`), which relays to the Gemini Live API with the sub-account's *Google Gemini* connection – the key
  never reaches the browser. Its tool `hyperlevel_agent` runs through the same agent path and confirmation card; the model is told a
  spoken "ja" confirms nothing. No connection or Gemini unreachable → a one-line hint and the classic voice. Protocol framing in
  `services/gemini-live.ts`.
- Companion settings: *Gesprächsmodus*, *Unterbrechen*, *Sprach-Engine* (tab *Sprechen*) and a new tab **Proaktiv** (initiative
  level, AI status, *Was schlägst du jetzt vor?*, triggers with priority, the unanswered threshold). New prefs `conversation_window`,
  `barge_in`, `voice_engine`, `live_connection_id`, `initiative`, `events`. Check-ins carry `digest`, `suggestions` and `offer`;
  other modules can add to a check-in via `app.services.companionCheckinHooks`.
- API: `GET /api/companion/live`, `GET/POST /api/companion/events/:id`, `GET /api/companion/suggestions`,
  `POST /api/companion/suggestions/:id`, `POST /api/companion/initiative/run`, `GET /api/companion/proactive`,
  `POST /api/companion/live/session`; push kind `companion_event`.
- Tests: `tests/companion-live.test.ts` (VAD and turn logic, end phrases, sentence splitting, PCM, trigger registry, routing, rate
  limit, dedupe, quiet hours, rights and assignment, the initiative with a fake model – schema output, cool-down, level gating,
  learning, rules fallback –, the Gemini Live framing against a fake Live server, the realtime proxy and its fallback).

## [1.0.53] – 2026-10-21

### Added
- **Jarvis speaks with Google's en-GB-Neural2-B** – the companion's voice is a preference per person and sub-account
  (`tts_provider`, `tts_connection_id`, `tts_voice` in `GET/PUT /api/companion/prefs`; default `google_speech` +
  `en-GB-Neural2-B`). Companion settings → *Sprechen*: *Wer spricht* lists the sub-account's connections that can speak, plus
  *Stimme des Sub-Accounts* and *Browserstimme*; *Stimme des Anbieters* offers the provider's voices (free text without the
  settings right); *Probehören*. Without a Google Cloud Speech connection the settings say how to add one (with a link to
  *KI-Anbieter*) and the browser speaks – a British male voice (*Google UK English Male*, any en-GB voice) for the default.
  The browser asks once per sub-account which connections can speak (cached); a failing server voice falls back to the browser;
  barge-in also drops audio that is still on its way. An English voice reads German text with an English accent (documented).
- `POST /api/voice/speak` takes optional `voice` (voice-id pattern, max 120), `provider` (preset id → its first connection with a
  key) or `connection_id` – only audio_tts connections of the caller's sub-account (another's or an unknown id: `404`; provider
  without connection: `409`); without them nothing changes. Same per-person limit and usage count. `GET /api/voice/prefs` lists the
  connections that can speak (`usable`, no keys).
- Tests: `tests/companion-voice.test.ts` (speak route validation and cross-sub-account refusal, language code from the voice name,
  settings, the browser's plan and en-GB voice pick, the greeting for API keys).

### Fixed
- `ghl_briefing` (and the briefing/check-ins in general) greeted API-key callers with the key's label (*"Guten Abend, API:."*): a
  caller without a person's name (sub-account or agency key, *KI-App*, an e-mail address) is now greeted without a name
  (*"Guten Abend."*), and an agency key no longer borrows its creator's companion settings.
- A spoken reply for a connection other than the sub-account's voice no longer inherits that voice's saved voice/model/style
  (e.g. OpenAI "onyx" sent to Google).

## [1.0.52] – 2026-10-21

### Added
- **Fokus-Modus mit Companion** – focus mode and a voice companion are one mode: one entry at the top left (*Fokus · mit Jarvis*),
  one prompt, one voice. The companion is the HyperLevel Agent as the persona "Jarvis" or any custom agent the person may use
  (name and wake phrase follow it); settings per person and sub-account (`GET/PUT /api/companion/prefs`, chip under the prompt,
  ✕/Esc close).
- Three ways in on every page, all opening focus mode with the companion listening: the **edge button** on the right (idle,
  listening, thinking, speaking, unseen check-ins; hidden in focus mode, where the prompt's microphone is the companion),
  **Alt+J** (hold = push to talk, tap = hands-free until a pause; no clash with Strg/⌘+K, J, B, Z) and an opt-in **wake word**
  ("Hey Jarvis") with the browser's own continuous speech recognition – per device, only while the tab is visible, an
  always-visible green ear with one-click off, honest note that Chrome/Edge send the audio to Google/Microsoft and Safari to
  Apple; not offered in Firefox and most Android WebViews. Nothing is recorded or stored; only what follows the phrase is asked.
- Requests to *do* something are routed (focus intent detection: KI-Assistent or keyword rules) to the companion's agent inside
  focus mode: streamed answer, tool cards with undo and the confirmation card inline (`POST /api/agent/chat` with
  `source: "focus"`, history label *Fokus*, *Im Agent-Panel weiterführen*). Voice never confirms: a bare "ja" is not sent, a bare
  "nein" declines, anything else rejects the waiting action as before. Without a model, questions keep working by the rules and
  actions show the offer with a note.
- One voice for every answer (the view's sentence, the agent's final words, the confirmation question) – server voice or the
  browser's, a browser voice by name; barge-in by microphone, edge button, Alt+J, wake word or Esc. Hands-free recordings end on a
  pause (a voice-activity check on the microphone level in the page).
- **Was brennt?** – chip, wake phrase or "Lagebericht": the **Brennpunkte** (top 5 by urgency × impact, rules only, each read
  through the viewer's own routes and rights: overdue tasks and invoices, dunning, unread conversations with the longest wait,
  stale or past-close deals, the next appointments, tickets at/over the SLA, failed automation runs, website down, low stock,
  open approvals), **Wo geht's weiter** (1–3 next steps that one click hands to the agent – which still asks before anything goes
  out) and the hotspots' tiles. With the KI-Assistent a short mentor sentence and one strategic tip from the project's goals
  (purpose *Companion-Check-in*, 24 per person and day, numbers only from the data). `GET /api/companion/briefing`.
- **Proaktive Check-ins**: off / every 5–240 minutes or custom / fixed daily times (up to 6, in the person's time zone), quiet
  hours (default 20:00–08:00, for interval check-ins), weekdays only, "nur wenn sich etwas geändert hat" (default on). A
  scheduler checks once a minute, stores check-ins for 30 days (`companion_checkins`) and announces them as web push (kind
  *Check-ins des Companions*), in the Android feed and with a card at the edge button (optionally read aloud); opening one shows it
  as the focus view (`/app/focus?checkin=<id>`). `GET /api/companion/checkins[/:id]`, `POST …/:id/seen`,
  `POST /api/companion/checkins/run` ("Check-in jetzt ausprobieren"), history in the settings.
- MCP tool **`ghl_briefing`** (read-only): the same Brennpunkte and next steps for other agents, scoped like every tool.
- Tests: `tests/companion.test.ts` (schedule incl. time zones, quiet hours, grace window and dedupe, settings validation, wake
  phrase matcher, ranking, rights scoping, AI guard and cap, check-ins, MCP, the agent in focus mode never confirming by text).

### Changed
- `ghl_focus_view` is unchanged; the focus page's prompt, chip row and result area now host the companion. The old browser switch
  *Antworten vorlesen* is used until the person chooses in the companion settings.
- `startRecording` (web/src/agent/voice.ts) takes an optional silence check; `readAloud` a browser voice; the agent panel exports
  its event reducer, tool and confirmation cards for focus mode and opens a conversation by id (`pghl:agent` `conversationId`).

## [1.0.51] – 2026-10-21

### Added
- Cloud waitlist mode: `PGHL_CLOUD_WAITLIST=1` (or `0`), and automatically on while the cloud mode has no Stripe key. Nobody can
  sign up for the cloud, enter payment data or be charged: `POST /start`, the verification link, the Google return and, in cloud
  mode, the SaaS self-signup `/signup` answer 403 – no signup row, account, sub-account, mail or Stripe Checkout, also for direct
  calls. Existing customers keep working; a Checkout paid before the switch still completes.
- Waitlist form on the landing page (`#warteliste`, German and English), `/cloud` and `/start` (the waitlist page, German or
  English): `POST /api/public/cloud-waitlist` (JSON or a plain form post), with honeypot, signed time token, rate limits and a
  required consent with the privacy link. With `PGHL_LANDING_LOCATION` it posts into the HQ waitlist form (source
  „Cloud-Warteliste“, plan, Double-Opt-in); otherwise into a built-in list (`cloud_waitlist`: e-mail, optional name, plan,
  language, consent text and time, hashed IP) that never sends mail and notifies the admins by push.
- *Agentur → Cloud → Warteliste*: mode and reason, where entries go, the list with search, CSV export and delete
  (`GET /api/cloud/waitlist[.csv]`, `DELETE /api/cloud/waitlist/:id`, admins only).
- `GET /api/version` → `cloud.waitlist`, `GET /api/public/cloud/pricing` → `waitlist`.
- Demo without a login step: `/demo` signs the visitor in and opens the app (`?next=/app/…` for a page inside the app, anything
  else is ignored), the landing page's "Live-Demo testen" links there, and the demo's login page opens the demo by itself – only
  after signing out does it stay on the login page (for that tab).

### Changed
- In waitlist mode the landing page leads with *Kostenlos selbst hosten*; cloud plans keep their prices but are marked
  *Bald verfügbar* / *voraussichtlich*, every cloud button reads *Auf die Warteliste*, and trial, card, Stripe-Tax and "start now"
  wording is gone – hero, pricing, *Cloud oder selbst hosten?*, calculator, stack total, HighLevel table, FAQ, comparison notes,
  *Warum wechseln?*, app notes, meta and Open Graph texts. `/cloud` marks the plans as planned and swaps the trial and payment
  FAQ for waitlist answers.
- The cloud pages (`/cloud`, `/start`, legal pages) got a skip link.

### Fixed
- The SaaS reseller sign-up (`/signup`) no longer offers or sells the hosted cloud's plans (`cloud-solo|team|agency` and the
  price-less `cloud-agency-client`), whatever the mode: hidden-plan links to them redirect to `/cloud` in cloud mode, a `POST`
  with one is refused with „Bitte einen Tarif wählen.“ – before, a direct link or post could buy a cloud plan past `/start`
  (or get the free client plan) as soon as the SaaS sign-up was switched on. In waitlist mode the SaaS admin routes
  (`PUT /api/saas/locations/:id`, `…/checkout`) refuse cloud plans for sub-accounts that are not cloud customers (409).
- READMEs: the hosted cloud is planned, not open yet (waitlist on gohyperlevel.com).

## [1.0.50] – 2026-10-21

### Added
- Fokus-Modus: a *Fokus* button at the top left (route `/app/focus`) hides sidebar, top bar and bottom bar; a round button opens the
  menu as a drawer, *Fokus beenden* or Esc returns, the browser remembers the choice. Say or type a question and get an ephemeral view
  of Living Boards widgets – a short answer whose numbers come from the tiles, tiles that each name their source and link to it,
  suggestion chips, the last questions, push-to-talk, *Antworten vorlesen* (the sub-account's voice or the browser's), *Als Board
  speichern*, and *Im Agent fortsetzen* for requests to do something.
- `POST /api/focus/ask` (and the same as `GET` for agents), `GET /api/focus/status`: the KI-Assistent only picks widgets and settings in
  a strict schema (purpose *Fokus-Modus*, 40 per person and hour); without AI, after a failed or invalid answer, or over the limit,
  German/English keyword rules answer. Tiles are checked against the widget catalogue and read with the caller's rights and
  sub-account; nothing is written.
- MCP tool `ghl_focus_view` (read-only): the same view with its data for other agents.

## [1.0.49] – 2026-10-12

### Added
- Claude-Projekte umziehen: the agency-only MCP tool `ghl_import_claude_project` turns a claude.ai project into a sub-account
  (found by its exact name or created) – instructions as `CLAUDE.md` and in empty profile notes, knowledge files as project files,
  chat and artifact links under *Berichte & Artefakte*; running it again changes nothing.
- Project files per sub-account (text and binary, 10 MB per file, 200 files / 25 MB per call, `PGHL_PROJECT_FILES_MB` per
  sub-account, counted in the cloud's media storage): REST `/api/project-files`, MCP `ghl_upload_files`, `ghl_list_files`,
  `ghl_read_file`, `ghl_delete_file`, and a *Dateien* card on the project page. Downloads are always attachments with nosniff
  and a sandbox CSP.
- `ghl_api`: every REST route over MCP with the connection's own rights; sign-in, people, keys, tokens, passwords, 2FA, passkeys,
  sessions, OAuth grants, invitations and database backups are blocked (checked after resolving `..`, repeated slashes and escapes).

## [1.0.48] – 2026-10-11

### Changed
- Landing page: the apps section also shows XR headsets and display glasses (beta – spatial mode, workspace, boards and Canvas
  in WebXR), with an honest note on what was tested; the agency note there is calmer.

## [1.0.47] – 2026-10-11

### Fixed
- Popups from the top bar and "…" menus stay inside the window on phones (the team list opened to the left, off screen); one
  shared helper nudges them back and keeps them narrower than the screen.
- Android app 1.0.3: the web view runs edge to edge – no black strips beside the camera cutout in landscape or above the
  navigation bar; the page gets those insets as `--sal`/`--sar`/`--sab` and colours the strips like the sidebar and the page.

## [1.0.46] – 2026-10-11

### Fixed
- Quick menu behind the logo: it opens in its own layer at the button instead of inside the sidebar, which cut it off; it uses the
  theme's colours (it was white with light text in dark mode); Esc and a click outside close it.

## [1.0.45] – 2026-10-10

### Changed
- Landing page typography and calm: Inter Tight (variable, self-hosted) replaces Archivo Black, headings at weight 600 instead of black,
  lighter body text and buttons; the hero shows two buttons with the cloud and GitHub as quiet links and a single line of facts
  instead of six pills; the rotating word has room for descenders and a soft gold gradient; the "Replaces your stack" table marks
  coverage with coloured text instead of filled pills. Social cards re-rendered in the same font.

## [1.0.44] – 2026-10-10

### Added
- Gray-label apps, server side ([docs/apps.md](docs/apps.md)): `/.well-known/gohyperlevel-app.json` with name, logo, colours, API address and push mode from the white label; an instance directory for the operator's cloud (`PGHL_APP_DIRECTORY=1`: e-mail domain or agency code → instance, DNS-verified claims); native push to the apps (`POST /api/mobile/push-token`) through the operator's push relay (`PGHL_PUSH_RELAY=1`: per-instance tokens, sealed device tokens, generic payloads without content, rate limits, revocation) or with the instance's own FCM/APNs keys (`PGHL_PUSH_MODE=own`); `POST /api/mobile/share` (link, text or file → task); desktop updates served by the instance (`PUT /api/desktop/app`, `GET /api/desktop/update/…`).
- **AI Studio** ([docs/ai-studio.md](docs/ai-studio.md)): a chat-first app and website builder on the sub-account's own AI connection
  (BYOK). Projects with a per-project workspace on disk and a quota, an agent loop with seven tools (list/read/write/delete files,
  search, build, logs), React (Vite) and HTML templates, esbuild in a sandboxed child process (permission model, no environment,
  memory/time limits, own network namespace), a preview under a signed path with a sandboxing CSP, a snapshot per turn with restore,
  tokens and cost per turn under the monthly AI limit, ZIP export. API `/api/ai-studio`, page `/app/ai-studio` (lazy chunk),
  i18n namespace `aistudio`. Publishing, app API token and key-value store, point & edit and streaming are not built yet.
- **AI Studio, usable** ([docs/ai-studio.md](docs/ai-studio.md)): menu entry "AI Studio" with a Beta pill (under "Mehr" in the
  Einfach-Modus until used), a short Academy tour, an empty state "Verbinde deinen Claude-, OpenAI- oder OpenRouter-Key" with a link
  to the AI provider settings and three example prompts. **Publish** a project's build to `/apps/<slug>/` – static files with a
  sandboxing CSP, no cookies, path checks; republish, unpublish (404), audit log; optional `PGHL_APPS_ORIGIN` host and a custom
  domain per app on self-hosted installs (host rewrite, TLS ask list, reserved against other claims). `GET /api/ai-studio/setup`.

### Changed
- Einfach-Modus: a goal-based first-run setup "Was willst du tun?" (Leads & Vertrieb, Kurse & Community, Agentur, Rechnungen & Büro, Alles) for new logins and a one-time banner for existing ones; with goals chosen the sidebar shows at most ten core entries and everything else under a searchable "Mehr" with pinning, and areas used three times in 14 days move into the menu at the next session start (`/api/nav/usage`, docs/theming.md#einfach-modus).
- Page heads keep one primary action in view; the rest – on phones everything else, and destructive actions always – goes into a "⋯" menu, so headers no longer wrap on phones.
- A shared in-app confirm dialog (`confirmDialog`, ✕ and Esc, red for destructive questions) is available next to the native `confirmAsk`.
- Academy front and centre ([docs/academy.md](docs/academy.md#einstieg)): a welcome card "In 10 Minuten startklar – Academy starten" on the start page, in the demo and in the goal setup; "Lernen"/"Tour starten" links in the empty states of the main areas, the page heads of Dashboard, Agentur and Einstellungen, the help menu and the demo banner ("Geführte Tour starten"); Akademie is a fixed entry of the Einfach-Modus menu (now at most eleven core entries).
- Much richer demo data ([docs/demo-mode.md](docs/demo-mode.md)): the agency "Nordlicht Digital" (white-label) with five client sub-accounts – physiotherapy practice, electrician, online coach, SaaS start-up on the HQ template, coffee roastery with online store – each with coloured tags, custom fields and values, saved lists, deals with quotes, four weeks of appointments back and forth with a recurring series, e-mail/SMS/WhatsApp threads with notes, invoices in every state including an XRechnung, store orders and gift cards, a workflow with a paused step on the canvas, reviews from several platforms, call scripts, projects with a Gantt chart and time entries, Office documents, a webinar and 90 days of history. Deterministic, a few seconds, no outside API; test phone numbers `+49 30 1234 xxx`.
- Shorter name **HyperLevel** in the app (the domain stays gohyperlevel.com) and the original logo mark back in the sidebar and on the landing page; a saved branding with the old default name shows the new one.
- Quick menu behind the logo (top left): switch Einfach/Profi mode, light/dark/system design and language in one place, with links to the design settings and the Academy.
- Einfach-Modus: a goal-based first-run setup "Was willst du tun?" (Leads & Vertrieb, Kurse & Community, Agentur, Rechnungen & Büro, Alles) for new logins and a one-time banner for existing ones; with goals chosen the sidebar shows at most ten core entries and everything else under a searchable "Mehr" with pinning, and areas used three times in 14 days move into the menu at the next session start (`/api/nav/usage`, docs/theming.md#einfach-modus).
- Page heads keep one primary action in view; the rest – on phones everything else, and destructive actions always – goes into a "⋯" menu, so headers no longer wrap on phones.
- A shared in-app confirm dialog (`confirmDialog`, ✕ and Esc, red for destructive questions) is available next to the native `confirmAsk`.
- Landing page: rotating hero words ("Deine Plattform für …"), a deep-navy and warm-amber palette instead of the lime accent, a slow aurora behind the hero, new screenshots and social cards with the HyperLevel mark.

### Fixed
- AI Studio React builds in production: `esbuild-wasm`, `react` and `react-dom` are now runtime dependencies, so the Docker image
  (`npm prune --omit=dev`) keeps the build toolchain; esbuild-wasm runs in-process in the sandboxed child (same file on amd64 and arm64).

## [0.0.43] – 2026-10-10

### Added
- **Reviews from many platforms** ([docs/reputation.md](docs/reputation.md)): a review-source adapter registry in Reputation
  (`registerReviewAdapter` in `services/review-sources.ts`) with Facebook page ratings (Graph API with the page token), the
  Trustpilot Business API (replies with a business user), the ProvenExpert API (rating summary), Yelp Fusion and the Tripadvisor
  Content API (read only, only the latest answer kept) and a generic import for platforms without an API (CSV, RSS/Atom, a web
  hook per source – Jameda, Kununu …). One table `review_items`, daily sync, the existing trigger `review.received` with
  `source`/`platform`, team notice for low ratings, AI reply drafts through the KI-Antworten settings (tone, brand voice,
  auto-draft), reply through the API where allowed and a "reply on the platform" link elsewhere, every platform in the review
  widget (badge per platform + best reviews), a weighted summary incl. Google and own requests. API `/api/review-sources`,
  `/api/review-items`, `/hooks/reviews/:id/:key`, MCP `ghl_review_sources`, UI slot `reviews.panel`, i18n namespace `reviewsources`.
- **Social comments inbox** ([docs/social-comments.md](docs/social-comments.md)): comments under the sub-account's own Facebook and
  Instagram posts (Meta webhook fields `feed`/`comments`) and – through Nango – YouTube videos and LinkedIn organisation posts
  (polled every 15 minutes, only what comes after switching on) land in Konversationen as the channel *Kommentare*, one message
  per comment on the commenter's contact, with public reply, hide/show and an AI reply suggestion (UI slot `inbox.message`).
  Trigger `social_comment.received`, API `/api/social-comments`, MCP `ghl_social_comments`, i18n namespace `socialcomments`.
- **Several Facebook pages and Instagram accounts per sub-account** ([docs/meta-channels.md](docs/meta-channels.md#mehrere-seiten-und-instagram-konten)):
  the page part of the Meta config is now a list (`meta_pages`, migration `002-pages` moves existing configs and links existing
  identities to their page). Inbound messages are routed by page / Instagram account ID, the inbox shows the page as a
  sub-channel ("Messenger · Filiale Nord"), replies and other modules (`metaKit.graph(…, accountId)`) use that page's token.
  API `/api/settings/meta/pages`, the single-page fields of `PUT /api/settings/meta` edit the first page; i18n namespace `metapages`.
- **Outbound Voice AI calls** ([docs/voice.md](docs/voice.md#outbound-ai-calls)): the workflow action `voice_ai_call` (and
  `POST /api/voice-ai/outbound`, MCP `ghl_voice_ai_call`) has the KI-Telefonagent call a contact with a goal (qualify, book,
  remind) and a script – Twilio with answering-machine detection, the agent over `<Connect><Stream>` with the own voice where set
  up, an optional voicemail message. Gate: the power dialer's verdict (Nicht stören, consent – a confirmed phone consent for
  automated sales calls under § 7 Abs. 2 UWG –, calling hours, holidays) plus a daily limit. Result triggers
  `voice_ai_call.answered|booked|no_answer|voicemail`; transcript and summary on the contact's timeline. Hooks
  `voicePromptExtras`, `VoiceAgentInput.stage = 'outbound'`; i18n namespace `voiceout`.
- **Your own number as caller ID** ([docs/telephony.md](docs/telephony.md#your-own-number-as-caller-id)): Twilio Verified Caller
  IDs with the verification call (code shown in the app, signed status callback, list check as fallback), a default caller ID and
  `app.services.callerIds.pick()` for the browser phone (`callerId`), click-to-call (`from`), the power dialer (the list's sender)
  and outbound AI calls. API `/api/caller-ids`, i18n namespace `callerids`.
- **Off-site encrypted backups** ([docs/backups.md](docs/backups.md)): every hour (`PGHL_BACKUP_INTERVAL_MIN`) a consistent copy of
  the database (VACUUM INTO in a worker thread) and every new file of the upload folders go to S3-compatible storage (Hetzner,
  Backblaze, Hostinger, R2, MinIO – `PGHL_BACKUP_S3_*`), streamed and encrypted with AES-256-GCM (`PGHL_BACKUP_KEY`, earlier keys in
  `PGHL_BACKUP_KEY_PREVIOUS`); file names never leave the server. A small S3 client with hand-made SigV4 (multipart for big files),
  retention hourly 48 / daily 14 / monthly 6 (`PGHL_BACKUP_RETENTION`), a manifest per snapshot with row counts, and a ping for
  healthchecks.io (`PGHL_BACKUP_PING_URL`). `npm run backup:restore -- latest|<stamp>|<file> [--files] [--to <dir>]` restores into a
  folder of its own and checks `integrity_check`, row counts and file sizes; a **monthly restore test** does the same into a temp
  folder and alerts on failure. Status, runs and buttons under *Agentur → System → Betrieb*. Tested against a local fake S3 that
  verifies every signature.
- **Uptime and alerting** ([docs/backups.md](docs/backups.md#uptime-and-alerts)): `/healthz` now checks the database, free disk,
  scheduler lag and backup age (`degraded: …` with 200, 503 when the database is down; `?strict=1` answers 503 on any failing check
  for UptimeRobot, Better Stack or Uptime Kuma; `?format=json`). Alerts for disk below 10 %, a backup older than 2 h, a stalled
  scheduler, an error-rate spike and a failed restore test – by e-mail (`PGHL_ALERT_EMAIL`, default every admin), web push to admins
  and an optional webhook (`PGHL_ALERT_WEBHOOK`: ntfy, Slack, Discord, Telegram or JSON); once, reminded every 6 h, with an all-clear.
- **Public status page** `/status` ([docs/backups.md](docs/backups.md#status-page)): components, 90 days of daily uptime bars from
  the instance's own 5-minute health samples and the incidents written under *Agentur → System* (impact, components, public
  updates). Server-rendered without script, cookie or outside request; on in cloud mode, otherwise `PGHL_STATUS_PAGE=1`.
- **Abuse handling in cloud mode** ([docs/cloud.md](docs/cloud.md#abuse-handling)): a DSA notice-and-action form at `/abuse`
  (URL, substantiated explanation, name and e-mail, good-faith statement; receipt by e-mail, operator alert, customer matched by URL),
  decisions sent back to the reporter, and per-customer measures under *Agentur → Cloud → Missbrauch* – pause sending, take sites and
  forms offline, suspend the account – each with a statement of reasons to the owner. E-mail sending pauses by itself when more than
  0.1 % of a customer's last 500 mails were reported as spam or more than 5 % bounced.
- **Customer sites on their own origin, custom domains only after verification** ([docs/cloud.md](docs/cloud.md#customer-sites-their-own-origin-and-verified-domains)):
  in cloud mode a customer's site is never served on the login origin – it moves to `<slug>.<PGHL_CLOUD_SITES_DOMAIN>` or its custom
  domain –, and a custom domain starts only once a `_pghl-verify` TXT record proves it (no certificate before).
- **B2B-only signup switch** ([docs/cloud.md](docs/cloud.md#b2b-only-signup)), on by default: the signup needs the company name and a
  VAT ID or the confirmation of ordering as a business; stored in the customer's history. The AGB template says B2B only and names
  the abuse measures.
- **Incident runbook** ([docs/incident-runbook.md](docs/incident-runbook.md)): contacts, the first hour, the GDPR 72-hour steps with
  notice templates for the authority and customers, restore and key rotation.
- **Payment provider registry: Stripe, PayPal and Mollie** ([docs/payment-providers.md](docs/payment-providers.md)). Stripe becomes
  one provider behind a small interface (create a checkout, webhook → payment, refund); **PayPal** (Orders API v2 with intent
  CAPTURE, capture on return or `CHECKOUT.ORDER.APPROVED`, webhooks verified by PayPal, Pay Later for eligible buyers, refunds
  to the capture) and **Mollie** (Payments API: iDEAL, SEPA bank transfer, cards, Klarna with order lines; the unsigned webhook is
  read back from Mollie) join it. Credentials per sub-account, checked on save, stored sealed, never shown again (*Einstellungen →
  Stripe & Zahlungen*). Invoices get *Mit PayPal, Mollie oder Gutschein bezahlen* (pay page `/pay/<id>` with provider choice and
  gift-card field), buy links ask *Bezahlen mit* (order bump and discount codes apply; plans and subscriptions stay Stripe),
  forms follow the buy page, team-calendar bookings go through the pay page when PayPal/Mollie or gift cards are in use. Every
  payment is a pay session settled once and booked through `recordPayment` with the Stripe rules (never more than is open,
  differences in the invoice trail). API `/api/pay`, hooks `registerPayProvider`/`registerPayPurpose`/`payRegistry`, test hook
  `payFetch`.
- **Online store with cart** ([docs/store.md](docs/store.md)): products with variants and stock from *Lager & Einkauf*, collections,
  the site blocks *Shop: Produktliste* and *Shop: Produktdetail*, a cart in localStorage plus a server cart session, and an on-page
  checkout (`/store/<key>/checkout`: address, shipping method, VAT, gift card, payment provider, terms, the legally worded order
  button). Flat-rate and weight-based shipping per country with free-from amounts (shipping shares the VAT of the goods); the tax
  treatment comes from the invoice tax modes (DE rates, § 19, export outside the EU, intra-community supply with a VAT ID). Each
  paid order becomes a finalised invoice with a gap-free number (GoBD), takes the goods out of stock, mails the confirmation with
  the invoice and fires the new triggers `store.order_placed`, `store.order_paid`, `store.order_shipped`; order list with
  fulfilment status, carrier and tracking number (mailed to the buyer), refunds; abandoned carts fire the existing
  `checkout.abandoned` with a link back to the cart. API `/api/store`, `/api/public/store/<key>/cart|quote|checkout`, page
  *Umsatz → Online-Shop* (i18n namespace `store`).
- **Gift cards** ([docs/store.md](docs/store.md#gift-cards)): a product type with a code and an append-only balance ledger
  (database triggers), issued by hand or sold in the store, redeemed in the store checkout, on invoices and in booking payments;
  amounts are held while a payment runs and committed when it is complete. Treated as multi-purpose vouchers – VAT arises on
  redemption (§ 3 Abs. 15 UStG, noted on the sale's invoice line and in the docs); optional expiry. API `/api/gift-cards`, page
  *Umsatz → Gutscheine*.
- Store settings, collections and the products' store fields in **snapshots**; **DSGVO** export and erasure cover orders, carts
  and gift cards (orders stay as business records without the person's data); **MCP tools** `ghl_store_orders`,
  `ghl_store_order_status`, `ghl_gift_card_create`.
- **Calendar view: day, week, month, team and agenda** ([docs/booking.md](docs/booking.md#calendar-view)). The first tab of
  *Kalender* (a lazily loaded chunk of its own): a time grid per day or per person (team view), a month grid and an agenda on
  phones. Drag to move and resize – a plain move goes through the calendar's reschedule logic (slot rules, hosts, video link,
  the contact's e-mail), everything else is checked for conflicts (other appointments, buffers, the person's appointments,
  Google/Outlook/iCal busy times, bookable hours, day/week limits, absences) and can be forced; click an empty slot to book
  (with repetition), click an appointment for a drawer with contact, notes, status (showed / no-show / cancelled), payment and
  an invoice draft. Overlays for bookable hours, buffers, blocked times, busy times, out-of-office and HR absences and – as a
  switchable layer – tasks with a due date; filters by calendar, person and status, keyboard navigation (← → T D W M P A N,
  Alt+arrows on an appointment), a "today" line, everything in the sub-account's time zone and DST-safe. API
  `/api/calendar-view` (grid data, check, book, move, drawer, invoice). UI strings in the new i18n namespace `calview`.
- **Recurring appointments** ([docs/booking.md](docs/booking.md#recurring-appointments)): `series_id`, `recurrence` (RRULE
  subset like the recurring tasks: daily, weekly on given days, every N weeks, monthly; ending never, after N or on a date) and
  `occurrence_date` on appointments, a table `appointment_series`, appointments written 90 days ahead by the background tick,
  reminders per appointment, one confirmation and one event per series, edit or cancel "only this / this and following / all"
  (appointments moved on their own stay exceptions), conflict check with `force`. The Google/Outlook sync has no series support
  and writes every appointment as a single event (documented). API `/api/appointment-series`, MCP
  `ghl_appointment_series_create`, `ghl_appointment_series_cancel`.
- **AI books appointments directly in chat** ([docs/booking.md](docs/booking.md#ai-books-appointments)): the KI-Telefonagent's
  booking logic (free times, booking a free slot) as shared tools – the KI-Assistent's website chat bot (*Termine buchen*,
  per sub-account, which calendars) and the agents in the agent chat and their auto-replies in every inbox channel through the
  new safety level **"Termin buchen"** (books free slots without a click, everything else still asks). Never paid calendars or
  ones with required questions, at most a few bookings per contact and day. The confirmation goes to the contact's channel with
  links to reschedule (`/book/move/<token>`, for every calendar) and to cancel. API `/api/ai-booking`, MCP `ghl_booking_slots`,
  `ghl_book_appointment`; tests with stub models.
- **Workflows: visual canvas, copy and paste, paused steps, validation** ([docs/workflow-actions.md](docs/workflow-actions.md#the-canvas)).
  A **canvas editor** next to the list (*Ablauf → Liste | Canvas*) that edits the same step JSON: dotted grid, node cards with
  a coloured icon tile, title, on/off switch and ⋮ menu, header cards for Ja/Nein and split-test paths, END pills, a round
  **+** on every connector, drag to pan, wheel or pinch to zoom, a zoom stack and a minimap, keyboard navigation, sticky
  notes, a statistics overlay per step from the run counters, and the step's existing form in a right-hand drawer with
  *Abbrechen* / *Speichern*. Node positions are offsets from an auto-layout in `settings.layout` (cleaned by the server);
  the canvas is a lazy chunk without a new dependency and honours *prefers-reduced-motion*. **Copy and paste steps**
  between workflows, sub-accounts and tabs through a `gohigh-steps` clipboard in local storage – the copy is cleaned like an
  export, pasting gives new ids and checks references like the import (`POST /api/workflows/:id/copy|paste`); duplicate,
  move and delete from the same menu in both editors. **Pause single steps** (`disabled: true`): the engine skips them with a
  log line, also in test runs; a generic `workflowStepSkips` hook in the engine. **Validation on save**: required settings
  and gone jump targets are shown on the steps; `GET`/`PATCH /api/workflows/:id` answer with `issues`, and
  `POST /api/workflows/:id/validate` checks unsaved steps. UI strings in the new i18n namespace `wfcanvas` (English catalog).
- **Funnel & Website AI** ([docs/site-ai.md](docs/site-ai.md)). *Funnels & Websites → Mit KI erstellen*: a chat-style brief
  (suggestion chips, radio cards for landing page / funnel with steps / multi-page website, goal, tone, du/Sie, German or English,
  business, offer, audience) becomes a page plan (rename or trim pages), then block JSON in a simple section format that is checked
  against the site block registry and the sub-account's forms, calendars and products – block types, field types and lengths,
  choices, links between planned pages, real ids, one H1 per page, no legal pages – with up to three attempts and the problems fed
  back, the way the AI workflow builder checks against its catalogue. Review with a preview of every page in the chosen gallery
  design; applying creates the site as an **unpublished draft** (every public path answers 404 until *Veröffentlichen*) with the
  gallery's design tokens, a created form wired to the thank-you page, the calendar, and Impressum/Datenschutz/Widerruf from the
  legal page generator. In the page builder a **KI-Assistent side panel** (✕ and Esc, editor stays usable) works on the selected
  section or the whole page: command chips (shorter, add FAQ, du/Sie form, stress benefits, add a call to action) or free text, a
  review card with the section diff and a preview of the changed sections, and apply after a **restore point** into the editor as
  unsaved changes (undo, list of restore points); a rewritten section keeps its settings and the styling of every block it keeps.
  Model through the BYOK registry (new use "Funnel & Website AI", `sites`), a cost estimate before every request, the KI-Assistent's
  monthly limit respected. **AI writer** on the same service for blog posts and e-mail designer text blocks. MCP `ghl_site_generate`
  with a hint for the GoHigh Agent. Purple is reserved for AI accents. UI strings in the new i18n namespace `siteai` (English catalog).
- **KI-Agent mit KI erstellen** ([docs/agent.md](docs/agent.md#build-with-ai)), like Agent Studio's "Build with AI": a description
  becomes a custom-agent config (name, instructions, model, tools from the real tool catalogue, knowledge sources, safety mode, max
  steps, optional schedule), checked against the custom-agent schema and the tool registry (same ask-check-retry loop, routing,
  estimate and limit), reviewed and saved as a draft agent – private, schedule switched off, no auto-reply. Button on the KI-Agenten
  page, `POST /api/agent-ai/*`, MCP `ghl_agent_generate` (the GoHigh Agent may draft, not save, agents).
- **Custom Values** ([docs/custom-values.md](docs/custom-values.md)): global placeholders per sub-account with optional folders
  (*Einstellungen → Custom Values*). `{{custom_values.key}}` resolves in the central template renderer (a small namespace registry in
  `core/template.ts`), so it works in e-mails, SMS, workflow steps and documents, and on published site pages (escaped); values are
  strictly separate per sub-account. Snapshots carry them as placeholders (value only when marked), a client created from a snapshot
  sees which values still need filling; copying one website takes the keys its pages use. A form target "Custom Value setzen", undo
  for edits and deletes, REST (`/api/custom-values`, upsert by key), MCP `ghl_custom_values` / `ghl_custom_value_set`, i18n
  namespace `customvalues`.
- **Tag colours and categories** ([docs/api.md](docs/api.md), module `tag-meta`). Every tag can get a colour and a category;
  categories have their own colour (a tag without one shows its category's) and an order. *Einstellungen → Felder & Tags*
  groups the tags by category with a colour palette, a category picker and the contact count per tag. One shared chip
  component (`web/src/tag-chip.tsx`) shows the colours everywhere contact tags appear – contact list and contact page, the
  power dialer, trigger links. Colours and categories travel in snapshots (part `tag_meta`),
  category edits and deletes and a tag's colour/category change are in the undo journal. New routes `GET /api/tags/meta`,
  `PATCH /api/tags/:id`, `GET/POST /api/tag-categories`, `PATCH/DELETE /api/tag-categories/:id`; UI strings in the new i18n
  namespace `tags` with an English catalog.
- **Kanban comfort for pipelines** ([docs/api.md](docs/api.md), module `pipeline-board`). Stages get a colour in the
  pipeline editor (palette or own colour; stored in the stage as `color`, kept in snapshots and the undo journal of the
  pipeline): the board shows it as a dot and a top border of the stage header, which also shows the number of deals and
  their value (per currency). Stages fold to a narrow strip and columns are resized by dragging the edge (arrow keys on the
  focused handle, double-click or Home resets) – both remembered per person and pipeline in the browser. *Pipelines
  sortieren* orders the pipelines by drag & drop or arrow buttons for everyone in the sub-account (`POST
  /api/pipelines/order`, new column `pipelines.position`). Deal cards show the contact's tags as coloured chips.
- **Opportunity list view with smart lists, filters and bulk actions** ([docs/api.md](docs/api.md), module `deal-list`).
  *Opportunities* switches between **Board** and **Liste** (remembered in the browser). The list shows the deals of every
  pipeline in a table built from a new shared list-view block (`web/src/pages/ListKit.tsx`, i18n namespace `lists`):
  smart-list tabs (saved views per person or for the team through `/api/object-views`, a ★-pinned default, *+ Smart List*,
  *Änderungen speichern*), a column picker (tick, drag or arrows), sortable headers, advanced filters by field type on the
  deal's fields, its contact (name, e-mail, phone, company, tags) and custom deal properties, row selection with a bulk bar
  (stage – also into another pipeline –, owner, add/remove tags on the deals' contacts, delete, CSV of the selection) and a
  pager. Server: `GET /api/opportunities` takes `filters` (JSON, the filter engine of companies and objects), `sort`,
  `owner`, `stage_id`, `tag` and `limit`, and returns each deal's `props` and `contact_tags`; fields hidden from a person by
  record access can be neither filtered nor sorted by. New `POST /api/opportunities/bulk` (one undo entry per request,
  restricted people only touch deals they may see) and `GET /api/opportunities/export.csv` (same filters, optional
  `ids`). Companies and custom objects now use the shared (translated) column picker and filter rows.
- **Mark as spam and block sender** ([docs/team-inbox.md](docs/team-inbox.md#spam-and-blocked-senders), module
  `inbox-spam`). *Spam* in the conversation header blocks the contact (reason, note): new e-mails, SMS, WhatsApp/Messenger/
  Instagram, Telegram/Discord/Slack messages and synced mailbox mail are stored but archived silently through a new receive
  hook (`app.services.inboundGates`, `services/inbound-gate.ts` – message status `spam`, no unread badge, no
  `message.inbound`, so no workflow, auto reply or ticket), calls are rejected by the first call router without counting as
  missed, and the conversations move to the new inbox filter *Spam*, where *Entsperren* unblocks (undoable). Workflow steps
  `block_contact` and `unblock_contact`; routes `GET/POST /api/blocked-contacts`, `GET/DELETE /api/blocked-contacts/:contactId`.
  Blocks are part of the GDPR export and go with an erased contact and a deleted sub-account. UI strings in the new i18n
  namespace `spam`.
- **Call scripts in the dialer** ([docs/telephony.md](docs/telephony.md#call-scripts), module `call-scripts`). *Anrufe →
  Leitfäden* writes scripts of steps with placeholders and answer buttons that branch to other steps, scoped to power-dialer
  lists and/or pipelines (open deals) with an optional call scorecard. The browser phone and the power dialer show the matching
  script step by step through a new UI slot registry (`web/src/slots.tsx`, slot `call.panel`). Routes
  `GET/POST /api/call-scripts`, `PATCH/DELETE /api/call-scripts/:id`, `GET /api/call-scripts/for`; snapshot part
  `call_scripts`, undo for edits and deletes; i18n namespace `callscripts`.
- **Better notes** ([docs/api.md](docs/api.md), module `notes-plus`). Contact notes get a title, a colour, *Oben anheften*
  (pinned notes first) and Markdown written with the toolbar editor of the blog and courses; the server renders it with the
  wiki's escaping renderer and allow-list sanitiser (`html`). The notes tab searches this contact's notes or all notes (title,
  text, contact name). New `GET/POST /api/notes`, `PATCH /api/notes/:id` (undoable); the workflow step *Notiz hinzufügen*
  (`add_note`) takes `title`, `color` and `pinned` through the new hook `app.services.noteExtras`. i18n namespace `notes`.
- **Run your own company on the app (HQ)** ([docs/company-playbook.md](docs/company-playbook.md)). A built-in template
  *Software- & SaaS-Firma (HQ)* that loads into a sub-account in one click (*Agentur → Snapshots → Vorlagen*,
  `GET /api/snapshot-templates`, `POST /api/snapshot-templates/:id/apply`, admins, once per sub-account unless `again`):
  pipelines *Kunden (Cloud)* (Warteliste → Testphase → Kunde → Gekündigt / Rückgewinnung), *Agentur-Partner* and
  *Presse & Influencer*; fields plan, MRR, source, cloud/self-hosted, trial end, cancel reason, interval and cloud account;
  status/plan/source tags; forms *Warteliste & Newsletter* (Double-Opt-in), *Demo-Anfrage*, *Support* (tickets) and
  *Feature-Wunsch*; nine workflows as drafts (waitlist DOI → welcome series, trial onboarding day 0/1/3/7/12 with a
  check-in task, trial ends → offer, customer → clean-up, cancellation → winback, SLA at risk/breached, feature wish →
  roadmap tag, demo request → task); 14 German e-mails in an honest du-tone; products for the three cloud plans; helpdesk
  categories and auto-reply plus four draft help articles (Cloud vs. Self-Hosting, Preise, Umzug von HighLevel,
  DSGVO/AVV); a community skeleton; the dashboard *CEO-Cockpit (SaaS)* (MRR/ARR, trials, conversion, churn, sources,
  support SLA) and a project *CEO-Routinen* with recurring daily/weekly/monthly/quarterly/yearly tasks. Plain data in
  `server/services/hq-template.ts`; extras go through the normal routes, failures come back as warnings. Registry
  `app.services.builtinTemplates` for further templates; UI strings in the new i18n namespace `templates`.
- **Academy course *Deine Firma mit GoHyperLevel führen*** – ten lessons (setup, sales, marketing, service, finance,
  projects & time, AI & automation with approvals, KPIs & the 30-minute weekly CEO review, privacy & compliance,
  scaling), each with a 10-minute task in the app, as a group of its own with a badge; printable as
  [docs/kurs-firma-fuehren.md](docs/kurs-firma-fuehren.md), generated from the lessons and kept current by a test.
- **Landing page waitlist hook**: `GET/POST /api/public/landing/waitlist` posts the public landing page's sign-ups into
  the sub-account in `PGHL_LANDING_LOCATION` (form `PGHL_LANDING_FORM`, default the HQ template's waitlist form) through
  the forms module – validation, rate limit, Double-Opt-in, consent proof, attribution and workflows included;
  `app.services.landingWaitlist` for server-rendered pages.
- **Cloud → HQ CRM bridge** ([docs/cloud.md](docs/cloud.md#cloud--hq-crm-bridge)): with `PGHL_HQ_LOCATION`, tenant lifecycle
  events (signup, trial, trial ending, subscribed, plan change, failed payment/dunning, cancellation, deletion) create or
  update one contact and one deal in the operator's HQ pipeline with plan, MRR, interval, source and the cloud account
  id; an erased account anonymises the contact. New hook `app.services.cloudEventTaps` in the cloud module.
- **Office: documents, spreadsheets, presentations and PDFs** ([docs/office.md](docs/office.md), DE). A new area (menu
  *Office*, permission area `office`) for Word (.docx), Excel (.xlsx), PowerPoint (.pptx) and PDF files per sub-account,
  optionally linked to a contact, deal or project: create blank (or with starting text/rows) or upload, list with filters,
  download, rename, delete; every save is an **immutable version** with its author (a person, the GoHigh Agent on behalf
  of a person, or an API key) and a note, restore adds a new version; an **edit lock** with automatic expiry ("Anna
  bearbeitet gerade – schreibgeschützt öffnen", admins can take over), comments per file or version with @mentions and
  push notices, who has a file open through the live presence, a size limit and a quota per sub-account
  (`PGHL_OFFICE_MAX_MB`, `PGHL_OFFICE_QUOTA_MB`), audit log, DSGVO export and erasure (files of a contact go with it,
  every version on disk included; all files go with a deleted sub-account and are part of the cloud data export). Optional open-source **browser editors** (static WebAssembly builds from
  `PGHL_OFFICE_DIR`, served at `/office/app/<kind>/` with a strict CSP – `wasm-unsafe-eval`, own files only – in a
  sandboxed iframe without GoHigh's origin by default, `PGHL_OFFICE_SANDBOX`) with a small load/save bridge: the file is
  dropped into the editor as a synthetic drag & drop (the PDF editor reads a signed 10-minute link), the editor's save
  download is caught and stored as a new version (the presentation editor's own format is converted to .pptx). Headless
  **engines** (`PGHL_OFFICE_BIN_DIR`) behind an adapter that runs them on temp copies (no shell, time and size limits,
  minimal environment, file/URL parameters refused) power five MCP/agent tools – `ghl_office_list`, `ghl_office_read`,
  `ghl_office_create`, `ghl_office_edit` (engine commands or spreadsheet range writes), `ghl_office_export_pdf` – which
  respect the edit lock. Without editors or engines the area still manages files and the agent reads plain text. The
  upstream releases (pinned versions and checksums) are installed with `deploy/office/` (install script, Dockerfile on
  Debian, compose override, a source patch for the spreadsheet editor's browser crash on cell edits); attribution and
  licenses in `deploy/office/THIRD-PARTY.md`. UI strings in the new i18n namespace `office` with an English catalog.
- **Launch landing page** for gohyperlevel.com (`PGHL_LANDING=1`, off by default – [docs/landing.md](docs/landing.md)):
  `/` (English), `/de`, `/vergleich`, `/vergleich/highlevel` and `/sitemap.xml`, only on the instance's own host (any
  other host – client login domains, cloud sub-domains – keeps going to the app). Server-rendered, no cookies, nothing from
  third parties, its own CSP with one hash-allowed inline script, BFSG check and colour contrast in the tests. Hero with
  real demo screens, live counts from the code, "Replaces your stack" (tool chips, entry prices with sources), a savings
  calculator whose URL carries the result (share links for X, LinkedIn, Reddit; the shared number lands in `og:title`),
  "Built for AI agents" (MCP snippet from the docs), the feature × vendor matrix from dated, sourced research ("not stated"
  instead of ✗ where a vendor's page just does not mention a feature; our gaps stay visible), Cloud or self-hosted?,
  pricing with the white-label exception, the Android APK and the iPhone/iPad web app with QR codes, the one-command
  install with a copy button, FAQ and the non-affiliation disclaimer under every comparison. Social cards for DE and EN.
  New: `PGHL_LANDING`, `PGHL_LANDING_HOSTS`, `PGHL_LANDING_IMPRESSUM_URL`, `PGHL_LANDING_PRIVACY_URL`; `npm run
  landing:assets` regenerates screenshots and cards; `npm run build` counts the tests for the page.
- **Public demo hardening** ([docs/demo-mode.md](docs/demo-mode.md#running-demogohyperlevelcom)): in demo mode own
  domains (websites, client logins, help centre) cannot be connected – no certificate for a stranger's domain – and every
  public page carries the note "Demo-Instanz … keine echten Daten oder Passwörter eingeben" plus `X-Robots-Tag: noindex`.
  `PGHL_DEMO_BRAND` names the demo ("GoHyperLevel Demo"); a step-by-step setup for demo.gohyperlevel.com.
- **Cloud legal texts:** a new operator field *Hosting-Anbieter und Serverstandort* fills `{{operator.hosting}}` in the AVV
  (§ 7 and Anlage 2) and the privacy policy (new installs; saved texts keep their version).

### Changed
- **Renamed to GoHyperLevel** (formerly GoHigh; gohyperlevel.com, [github.com/BAISESYSTEMS/hyperlevel](https://github.com/BAISESYSTEMS/hyperlevel)):
  UI texts (de/en), page titles, the default brand name, e-mails, the PWA manifest, the landing page, the MCP server's and
  the OpenAPI title, the "GoHyperLevel Agent", the Android app label and the docs. Internal identifiers stay so existing
  installs keep working: `PGHL_*`/`GOHIGH_*` variables, `ghl_*` tools, database, cookie and file names, the `gohigh-steps`
  clipboard format, the npm/Android package names. A saved branding that still carries the old default name shows the new
  one; white-label names win as before. Docker image `ghcr.io/baisesystems/hyperlevel`, install script and badges point
  at the new repository.
- **Open-source readiness:** a [Contributor License Agreement](CLA.md) (Apache ICLA-based, allows dual licensing) signed
  through CLA Assistant Lite (`.github/workflows/cla.yml`, signatures stored in the repository), CONTRIBUTING with
  "questions go to Discussions" and no support guarantee, SECURITY with `security@gohyperlevel.com` and a supported-versions
  table, and the [partner program](docs/partner-program.md) (Konditionen vorläufig). `npm run oss:check -- --require-files`
  and the export now insist on `CLA.md`.
- **Cloud list prices:** Solo 49,99 €, **Team & Company** 99,99 € (was "Team", 79 €; plan id `cloud-team` unchanged),
  Agentur 199 € (was 299 €) per month, net plus VAT. The pricing page says "zzgl. USt. – Stripe Tax" in its own line,
  makes white-label the Agentur plan's headline and names the one exception to "every feature in every plan": white-label
  and client accounts only in Cloud Agentur. Operators who saved their own prices keep them.
- **Yearly prices are rounded down** to whole euros, so the advertised discount always holds (479 €, 959 €, 1.910 € with
  20 %).
- The cloud's white-label routes check their own entitlement (branding → white-label, domain → custom domain, clients →
  client accounts) instead of all checking for client accounts; Solo and Team & Company still get 403 on all of them.
- `/robots.txt` takes extra lines from modules (`app.services.robotsExtra`) – the landing page adds its sitemap.
- Prices in README, README.de, [docs/cloud.md](docs/cloud.md) (with a "Cloud or self-hosted?" table) and
  [docs/umzug.md](docs/umzug.md) follow the new list.

## [0.0.42] – 2026-10-09

### Added
- **English UI, phase 2.** English for: workflows and automations (builder, trigger and step settings, action picker,
  conditions, runs, test runs, versions, AI builder, error handling), the email designer, email marketing (campaigns,
  A/B tests, segments, template gallery, deliverability), funnels and websites (page builder, design, CMS, redirects,
  statistics, accessibility check, blog, A/B tests), forms and surveys, tasks and project planning with time
  tracking, budgets and profitability, reports and dashboards (and the shared charts), the helpdesk, the social
  planner, the wiki and team chat, and courses (editor, students, discussion, reviews, cohorts, analytics, video
  library, learning paths). Each area is a namespace of its own with a lazy catalog that `npm run i18n:check` keeps
  complete; German stays exactly as it was. Sentences that were glued together from pieces are now one text with
  placeholders, counts use plural forms, and percentages and decimals follow the language. Still German: the
  community and the other remaining pages, tours, handbook, public pages, e-mails, and content the server sends as data
  (workflow catalogue, gallery templates) – see [docs/translating.md](docs/translating.md#what-is-translated).
- **Live collaboration everywhere** ([docs/collaboration.md](docs/collaboration.md), DE): every page of the app now
  shows who of the team is there – avatars in the top bar ("Anna – bearbeitet gerade"), avatars next to the menu entry
  each colleague is in (click → page and *Hingehen*), a *Team ist hier* popover with everybody online, "Anna hat hier
  gerade gespeichert – Neu laden" and "Anna bearbeitet das gerade auch" banners, and live cursors (on by default on
  Canvas and Living Boards, opt-in elsewhere; on Canvas you can now *follow* a person's view). One SSE stream per tab
  (`/api/presence/stream`), heartbeat `POST /api/presence`, `GET /api/presence/team`, own switches
  (`/api/presence/prefs`: invisible, menu avatars, cursors) and a switch per sub-account (`/api/presence/settings`,
  area settings). Live state only – no table, history, log or audit line; sub-accounts strictly apart, API keys get
  403, hidden and invisible people never appear, a colleague's page only for people who may open its area.
- **English UI, phase 1.** A dependency-free language layer (`web/src/i18n`): German texts are the message ids, English
  comes from one lazy catalog per area (German users download none; about 1.5 KB gzip more in the first download),
  plural forms and numbers, money and dates through `Intl` in the active language, `<html lang>`, no raw keys ever (a
  missing text shows in German). Translated: app shell (menu, sidebar, top bar, command palette, bottom bar,
  notifications, undo toast), sign-in and 2FA, dashboard, contacts (list, contact page, new contact, CSV import),
  opportunities, conversations with the team inbox, calendars and bookings, settings (company, e-mail & SMS, fields &
  tags, team & users, sub-accounts, API, *Mein Konto* with sign-in methods, passkeys, notifications and calendar
  connections) and invoices, quotes and products, plus the most common
  generic server messages. Each person picks the language in *Einstellungen → Mein Konto* or the sidebar (saved at
  the user: `PUT /api/me/language`, `user.lang` in `/api/me`); the login page follows the browser (`Accept-Language`,
  `GET /api/language`) and has its own switch. `npm run i18n:check` (also in the tests) reports missing English texts
  in the areas declared complete, German texts left untranslated in them and stale catalog entries. Tours, the
  *Akademie*, the handbook and all other pages stay German for now – [docs/translating.md](docs/translating.md) explains
  how to translate a page or add a language.

### Fixed
- **Money, third pass** (amounts that came out wrong; `tests/data-correctness3.test.ts`):
  - **OVER-CHARGE – online payment asked for the whole invoice again:** *Jetzt bezahlen* opened Stripe Checkout for the invoice
    **total**, whatever was already settled: a partly paid invoice, one reduced by a credit note (Gutschrift) and a final invoice
    (Schlussrechnung) whose deducted partial invoices had been paid were charged in full a second time – and the webhook then
    marked the invoice paid whatever arrived. Checkout now charges exactly the **open amount** (the figure the invoice page, the
    GiroCode, dunning and SEPA use): an untouched invoice keeps its lines, otherwise one line *Restbetrag Rechnung RE-…* names
    what was taken off (VAT note as on the lines); with nothing open there is no button and starting a payment is refused. The
    webhook books what arrived and never more than is open – the open amount pays the invoice, less becomes a part payment, a
    surplus (a transfer or credit note between opening the page and paying), another currency or money for an invoice with
    nothing open is noted on the invoice's trail (`payment.mismatch`) and in the contact's activity for a refund; one payment
    reported several times is booked once. The PayPal.me link and SEPA collection already used the open amount (now tested); the
    accepted-quote page and the customer billing page (`/abo/…`) showed the total as open and now show what is open
    ([docs/stripe.md](docs/stripe.md#was-beim-bezahlen-passiert)). Payment plans: an instalment is booked for at most the agreed
    instalment, and one Stripe collects after the last (the end of the subscription did not get through) no longer becomes an
    invoice *Rate 4 von 3* – it is noted for a refund (`payment_plan.overpaid`) and the subscription is told to end again
    ([docs/payment-plans.md](docs/payment-plans.md#limits-and-good-to-know)).
  - **A Storno after a partial credit note credited too much:** an invoice with a Gutschrift could still be cancelled, and the
    Stornorechnung negated the full amount – together with the credit note more was credited (and booked) than the invoice was
    for. A Stornorechnung always reverses the whole invoice (§ 14 UStG practice), so it is now refused (409) once a credit note
    was finalised, with a message that names what is left and points to the new **Restbetrag gutschreiben** (button in the
    credit-note dialog, `remainder: true` on `POST /api/invoices/:id/credit-note` and `ghl_invoice_credit_note`): a credit note
    per tax rate for what is not credited yet – for a final invoice without the deducted partial invoices, like its Storno –
    exact to the cent where the VAT rounding allows, otherwise one cent short and saying so, never above
    ([docs/invoicing.md](docs/invoicing.md#storno-and-credit-notes)).
  - **The minimum gap between two Mahnungen counted 24-hour blocks:** with *Mindestabstand* 3 days, a notice sent at 23:00 on
    the 1st held the next one back until 23:00 on the 4th, so the morning run on the 4th skipped it and it went out late. The gap
    is now counted in calendar days of the sub-account's time zone, like the days overdue (shared helper `calendarDaysBetween`)
    ([docs/dunning.md](docs/dunning.md#overdue-invoices)).
- **Concurrency, double submits and retries** (what went wrong when the same thing happened twice or at the same time;
  `tests/races.test.ts`, `tests/races2.test.ts`):
  - **Workflow steps ran twice:** the scheduler took every run that had been "running" for five minutes for a crashed one
    and started it again from where it was picked up – while a slow step (an AI answer, a slow web hook) was still going,
    so the e-mails and SMS before it went out a second time. A run this process is still executing is never taken over
    now, and the progress is saved after every action, so a run left behind by a real crash goes on after the last step
    that finished instead of repeating all of them.
  - **Campaign mails twice to the same people:** *Senden* sends the first batch itself, and the scheduler's tick picked the
    same campaign up meanwhile – both read the same "pending" recipients, so the first batch (and every batch of a
    WhatsApp campaign started with a double click) went out twice. A recipient is now claimed before its message is sent;
    a message that was on its way when the server restarted is not sent again but listed as failed with "Versand
    unterbrochen" ([docs/email-marketing.md](docs/email-marketing.md#für-entwickler)).
  - **The same Mahnung twice:** *Jetzt senden* on a notice waiting for approval was not blocked while the mail was on its
    way, so a double click, two colleagues or a workflow step at the same moment mailed the customer the same notice (with
    its fees) twice. A notice that is being sent is refused a second time (409) ([docs/dunning.md](docs/dunning.md)).
  - **Failed subscription payments: the first message twice, reminders lost:** the card-update mail was written into the
    case only after it had been delivered, so the background run arriving meanwhile sent it again; and each message wrote
    the case's list back from an old copy, so one message could erase the entry of another (and be sent again later).
    A message is now noted on the case before it is sent, and the run reads each case afresh.
  - **Recurring invoices: an ended subscription came back:** the run read all due subscriptions first and then issued and
    mailed one invoice after the other. A subscription ended, paused or moved while the invoices before it were being
    sent (on the 1st of the month that takes a while) still got its invoice, and the old copy was written back – the
    subscription was active again. Each one is now read when its turn comes.
  - **Appointment reminders for cancelled appointments:** the reminder runs (the classic *Erinnerung … Stunden vorher* and
    the list of reminders, the follow-up and the no-show message) read the due appointments first and then mailed one
    after the other – an appointment cancelled or moved meanwhile still got its reminder, with the old time, and a
    follow-up could go to somebody just marked as no-show. Each appointment is now read when its turn comes, and the
    note of what was sent is added to the stored one instead of overwriting it from an old copy (a lost note sent the
    message again later).
  - **An invoice paid twice while a SEPA debit was on its way:** after a customer paid by SEPA Direct Debit in Stripe
    Checkout the invoice stays open for days until the bank confirms – and kept offering *Jetzt bezahlen*, which opened a
    new Checkout page, so the customer (or a colleague) could pay the same invoice again by card. While a payment is in
    progress the invoice now says so instead and opens no second page; when the debit fails it can be paid again. A
    double click on *Jetzt bezahlen* also made two Checkout sessions; it now gets the same one
    ([docs/stripe.md](docs/stripe.md)).
  - **Planned mails from a connected mailbox sent twice:** when Gmail or Outlook took a planned mail but the answer got
    lost (a timeout, a connection broken while waiting), the background job counted it as failed and sent it again five
    minutes later – up to three times. A send without any answer is no longer repeated but marked failed with a note to
    look in *Gesendet*; a refusal the provider answered (busy, rate limit) is still retried, a plain error (e.g. a bad
    address) no longer ([docs/mailbox-sync.md](docs/mailbox-sync.md)).
  - **Discount codes with a limit used more often than allowed:** a buy-link code counted its use only when the purchase
    was paid, minutes after the buyer had left for Stripe's page – everybody who started meanwhile (or a double submit) got
    the discount too, so a code "for the first 10" could go out 50 times on launch day. A limited code is now held while a
    buyer pays with it (that Checkout page expires after 31 minutes, an abandoned one frees the code again)
    ([docs/stripe.md](docs/stripe.md#order-bump-upsell-und-rabattcodes)).
  - **Team-Chat, inbox, Living Boards and canvas on a full server:** the stream was answered with 200 and an `error` event
    and ended at once, so every refused tab reconnected every three seconds (and the chat showed the same error toast each
    time). Like presence they now answer 503; the tab tries again when it is looked at again.
  - **Invoices and quotes mailed twice:** a double click on *Senden* (or two colleagues, or a workflow step at the same
    moment) sent the customer the same invoice, estimate or deal quote twice – the number was safe, the e-mail was not. While
    a document is on its way a second send of it is refused (409, "… wird gerade gesendet"); a deliberate resend afterwards
    works as before ([docs/invoicing.md](docs/invoicing.md#states-and-what-each-one-allows), [docs/sales.md](docs/sales.md)).
  - **Two satisfaction surveys for one ticket:** the CSAT survey was noted on the ticket only after it had been delivered, so a
    ticket solved, reopened by the customer's answer and solved again while the first survey was still on its way asked the
    customer a second time (and *Umfrage senden* clicked twice sent two). The survey is now noted before it is sent; a
    second manual send while one is on its way is refused (409) ([docs/helpdesk.md](docs/helpdesk.md#zufriedenheit-csat--nps)).
  - **Community invites and discount codes used more often than allowed:** like the buy-link codes, a community code counted
    its use only when the purchase was paid and an invite only when the person was in – minutes after they had left for
    Stripe's page, so everybody who joined or pressed *Jetzt kaufen* meanwhile (or at the same moment) got the invite or the
    discount too. A limited invite or code is now held by the Checkout page of the person paying with it (the page expires
    after 31 minutes, an abandoned one frees it again); the next person is told it is taken right now
    ([docs/community.md](docs/community.md#joining-public-page-tiers-invites-coupons)).
  - **Birthday and date workflows skipped after an outage:** *Geburtstag*, *Jahrestag* and *Datum erreicht* only looked at
    today, so a server that was off at the set time for a whole day (or a scan that straddled midnight with a late time)
    skipped that day's birthdays for good. A missed day is now caught up at the next scan, at most 3 days back, never twice
    for the same contact, date and year, only for contacts that existed then and not for days before the workflow was
    switched on or changed; `{{event.late_days}}` says how late ([docs/workflow-actions.md](docs/workflow-actions.md#triggers)).
  - **Mail provider reports lost after a failure:** the Amazon SES webhook marked an SNS notification as handled before
    processing it (Mailgun its token, every provider each report), so when processing failed – the database busy for a
    moment, a parse error – SNS's retry was answered "duplicate" and the bounce, complaint or inbound mail never arrived. Like
    the Stripe webhook, the mark is now taken back when processing fails, so the retry is handled
    ([docs/channels.md](docs/channels.md#email-providers)).
  - **Planned mailbox mails stuck in "sending":** a planned Gmail/Outlook mail that the server was sending when it crashed or
    restarted stayed *sending* forever – not shown as failed, not cancellable, nobody told. After 30 minutes it is now marked
    failed with the note to look in *Gesendet* (the mail may be out) and is never sent again automatically, like a send whose
    answer got lost ([docs/mailbox-sync.md](docs/mailbox-sync.md)).
  - **NPS surveys twice to the same people:** the NPS run read the waiting recipients and wrote each one down only after its
    message had gone out, so two runs at the same time asked the same people twice, and a restart in the middle of a send
    sent that message again. Like campaigns, a recipient is now claimed before the send; one that was on its way when the
    server stopped is listed as failed with "Versand unterbrochen" instead of being sent again
    ([docs/helpdesk.md](docs/helpdesk.md#zufriedenheit-csat--nps)).
- **Team-Chat, inbox and Living Boards: no reconnect ping-pong with many tabs.** A person's 9th tab still makes room by
  closing the oldest one, but that tab is now told `bye` and waits until it is looked at again instead of reconnecting and
  pushing the next tab out (same as presence).
- **Data correctness: money, dates and imports** (numbers that came out silently wrong; `tests/data-correctness.test.ts`):
  - **Invoice line amounts:** the PDF, the online invoice and the editor computed `quantity × price` in floating point, so
    1,15 × 29,90 € was printed as 34,38 € while the net total, the tax and the XRechnung used the correct 34,39 € – the
    lines did not add up to the total. All three now use the invoice maths (integer, half away from zero).
  - **Recurring invoices keep their day of the month:** each run computed the next date from the previous one, so a monthly
    invoice on the 31st moved to the 28th after February and stayed there (quarterly on the 30th likewise). The schedule now
    remembers its day (`recurring.day`) and returns to it after a short month.
  - **Dunning minimum amount:** *Nur Rechnungen ab* compared the invoice total, so an invoice of 119 € with 0,50 € left after
    a short payment still got a reminder (and later fees and interest). It now compares the amount that is still open
    ([docs/dunning.md](docs/dunning.md)).
  - **Accounting dates:** auto-posting took the UTC date of an invoice, its due date and its payments, so an invoice
    finalised at 00:30 on 1 January (Berlin) was booked into December of the old year – and into the wrong VAT return. It
    now books the date printed on the invoice and the payment's day in the sub-account's time zone; a plain payment date
    (bank import, API) is kept as that day in every time zone.
  - **Final invoices name their partial invoices with the right date:** "abzgl. Abschlagsrechnung … vom" on the online
    invoice and the PDF, and the preceding-invoice date (BT-26) in the XRechnung, used the UTC date – a partial invoice of
    00:30 on 1 March appeared as "vom 28.02.". New final invoices carry the date printed on the partial invoice.
  - **Buy links of a Kleinunternehmer:** a product that still had 19 % VAT on it was charged with VAT on the buy page,
    order bump and upsell (and the page said "ohne Umsatzsteuer"), while the invoice of the purchase is written without VAT –
    the customer paid 119 € for an invoice of 100 €. Outside the regular tax mode the checkout now charges the net price.
  - **Booking page across daylight saving time:** "next/previous week" moved the start day with the visitor's local clock
    on a UTC midnight, so in Germany the week jumped to Sunday when it crossed the end of March or October (e.g. from
    22 March to 28 instead of 29 March) and stayed a day off. Days are now moved in UTC, and the first week starts on the
    visitor's own today.
  - **Won and lost deals by close date:** the dashboard (won, won value, lost), the mobile summary (won this month) and the
    attribution report counted won deals by their last change, so a deal won months ago came back as "won in the last
    30 days" whenever someone renamed it or changed a field. They now use the close date (`closed_at`, as reports and
    quotas already did).
  - **Paid revenue with partial invoices:** the dashboard, the mobile summary and sparkline, the report measure *Bezahlter
    Umsatz*, attribution and the A/B revenue of campaigns summed the full total of a paid final invoice although its partial
    invoices had been paid and counted already – a 30 % partial invoice plus the final invoice showed 130 % of the order.
    They now count a final invoice without what it deducts, and a quote's legacy "paid" flag no longer counts as revenue.
  - **Settled invoices are not overdue:** an invoice paid in part and credited for the rest (Gutschrift) keeps the status
    "sent" with nothing open, yet the workflow trigger *Rechnung überfällig* still fired for it, and the mobile overdue
    count, the health score and the report's *Überfällig* / *Anzahl offen* counted it. They now require an open amount;
    open-amount sums no longer let a credited-beyond-payment invoice subtract from the total.
  - **Affiliate commission on final invoices:** a paid final invoice earned commission on its whole net amount although the
    partial invoices it deducts had earned theirs already (30 % + 100 % = 130 % commission). It now earns on its net
    without the deducted partial invoices.
  - **Billing time:** *In Rechnung stellen* rounded the hours of each invoice line to two decimals, so 20 minutes at
    90 €/h became 0,33 h = 29,70 € instead of 30 € – three such lines billed 89,10 € for an hour, less than the unbilled
    preview said. The quantity now keeps four decimals ([docs/projects.md](docs/projects.md)).
  - **CSV files from Excel keep their umlauts:** the contact, company/object and community imports read the chosen file as
    UTF-8 only, but German Excel saves "CSV (Trennzeichen-getrennt)" in Windows-1252 – "Müller" was imported as "M�ller".
    A file that is not valid UTF-8 is now read as Windows-1252 ([docs/objects.md](docs/objects.md)).
  - **Custom properties *Datum & Uhrzeit* and *Datum*:** a time without a zone ("24.12.2026 18:00" from a CSV import, the API
    or a migration) was read in the server's zone – UTC in the Docker image, so it showed as 19:00 in Berlin. It now means
    the sub-account's time zone. A date like "31.02.2026" was stored as is (JavaScript reads it as 3 March); it is refused now.
  - **Stock valuation on a key date:** the valuation "as of 31 December" ended at 23:59 UTC and took in goods moved in the
    first hour(s) of 1 January (Berlin) – wrong for the year-end inventory. It now ends at midnight in the sub-account's
    zone; the movement log's day filter likewise ([docs/backoffice.md](docs/backoffice.md)).
  - **Phone numbers written "+49 (0)30 …":** the trunk 0 after the country code was kept (+490301234567), so texts and calls
    to such numbers failed and the contact was not found again by "+49 30 …" (CSV import, forms, API). It is dropped now,
    also in "+49 0170 …" (Germany, Austria, Switzerland; Italy's 0 stays).
  - **Stornorechnung of a final invoice:** its PDF subtracted the deducted partial invoices from the negative total instead of
    adding them back (−1 190 € − 357 € = "Noch zu zahlen −1 547 €" where the online document said "Erstattungsbetrag
    −833 €"), and its XRechnung claimed the full 1 190 € as the amount due. Both now show the refund of 833 € (PDF row
    *Erstattungsbetrag*; BT-113 prepaid and BT-115 due in the e-invoice) ([docs/invoicing.md](docs/invoicing.md)).
  - **Payments confirmed from a bank statement:** a line that paid an invoice in full dated the payment (and "Bezahlt am")
    on the day somebody confirmed it, so September payments confirmed in October counted as October revenue. The invoice
    now gets the bank's booking day, like part payments and the ledger entry already did.
  - **Invoice lines with a negative quantity:** "Rabatt, Menge −1, 10 €" was stored with quantity 0, so the discount
    disappeared from the total without a message. The minus now moves to the price (−10 €), which is how a deduction line
    is stored and sent in the e-invoice.
- **Data correctness, follow-ups** (what the first pass left open; `tests/data-correctness2.test.ts`, `tests/cognee-bulk.test.ts`):
  - **Amounts in different currencies were added up:** the dashboard (*Umsatz bezahlt*, *offen*), the totals above the
    invoice list and the monthly recurring revenue of *Abos* summed cents of every currency and printed them in euros –
    100 EUR + 100 USD showed as "200 €". GoHigh has no exchange rates, so these totals are now shown per currency
    ("100,00 € · 100,00 $"); the API adds `revenue.by_currency` and keeps `revenue.paid`/`outstanding` for the main currency
    (`revenue.currency`, the one most invoices are in) ([docs/api.md](docs/api.md)). The list's *Bezahlt* also counted a paid
    final invoice with the partial invoices it deducts, like the dashboard did before.
  - **Days overdue were 24-hour blocks:** an invoice due yesterday at 23:00 was "0 days" overdue at 08:00 today, so a
    *Zahlungserinnerung* set for 1 day after the due date went out a day late (in the afternoon, when 24 hours had passed),
    the interest of a notice was a day short, and the workflow trigger *Rechnung überfällig* fired a day late. Days overdue
    are now calendar days in the sub-account's time zone everywhere – dunning levels, interest and *Tage überfällig*, the
    workflow trigger (and `{{event.daysOverdue}}`), the reports' *Überfällig* and *Überfällige Beträge*, the invoice list's
    badge (`days_overdue` in the API), the mobile app's overdue count and the health score. An invoice due today is no longer
    shown as overdue before the day is over ([docs/dunning.md](docs/dunning.md#overdue-invoices)).
  - **Later Mahnungen under-stated the claim:** each notice asked for the invoice, its own level's fee and the interest, so
    the 2. Mahnung (10 €) no longer mentioned the 5 € of the 1. Mahnung – a customer paying the 2. Mahnung in full still owed
    them, and the letter said otherwise. A later notice now claims the fees of the earlier notices that went out as
    *Mahngebühren früherer Schreiben* (row in the PDF and the notice, `{{notice.prior_fees}}` / `{{notice.fees}}`,
    `prior_fee_cents` in the API and the `invoice.dunning_sent` event). Interest still runs on the invoice only, the § 288
    flat fee is not added up, and *Mahngebühren früherer Schreiben … mitfordern* (`carry_fees`, on by default) switches it
    off for fees that are already meant as totals ([docs/dunning.md](docs/dunning.md#overdue-invoices)).
  - **Affiliate commission ignored credit notes:** a Gutschrift (Rechnungskorrektur) to a paid invoice left the partner's
    commission at the full amount – only a Stripe refund or a Storno took it back. A credit note now reduces the commission
    in proportion to the net it credits (all of it reverses it), and one written before the payment already counts when the
    commission is made. A commission that was paid out – or sits in an open payout, whose SEPA file may be at the bank – is
    no longer edited: a negative *Rückbuchung* is booked for the next payout instead, never more than was paid out (this
    also fixes a Stripe partial refund after payout clawing back the original amount instead of what was paid, and a refund
    reversing a commission inside an open payout without changing the payout's sum); once clawed back, later corrections stay
    clawbacks (also when the payout is deleted), and a Storno takes the rest back at once. A refund and a credit note for the
    same money no longer add up ([docs/growth.md](docs/growth.md#so-wird-gezählt)).
  - **An invoice credited in full stayed open for good:** with nothing paid and Gutschriften over the whole amount it kept the
    status "sent" – out of the overdue counts since the first pass, but listed as *offen*, payable through the Stripe link
    and the SEPA run, open to a Storno on top (which would credit it twice) and grouped as *Offen* in reports. The credit
    note that settles it now closes it: new state `credited` (*gutgeschrieben*), stored as `void` with `cancelled_at` like a
    cancelled invoice but without a Stornorechnung; pending dunning notices are withdrawn (also when an invoice is cancelled),
    the PDF stamp and the online invoice say *Gutgeschrieben*, reports show the status *Gutgeschrieben*. The bookkeeping keeps
    the invoice's entry (the credit notes reverse it; no Storno entry on top). Invoices credited in full before the update are
    closed by a migration ([docs/invoicing.md](docs/invoicing.md#storno-and-credit-notes)).
  - **Bulk delete with the Wissensgedächtnis on:** since a bulk delete sends one `contact.deleted` per contact, every one of
    them started a full cleanup pass over the sub-account's mapped records and a sync cycle of its own – 10 000 passes for
    10 000 contacts (about 45 s in the test, and as many cycles queued behind each other). The events of one bulk delete are
    now coalesced into one pass and one cycle ([docs/cognee.md](docs/cognee.md#erasure-and-deletion)).
- **Live collaboration: no reconnect loops, steadier presence** ([docs/collaboration.md](docs/collaboration.md#für-entwickler)): a person's
  11th tab still replaces the oldest one, but that tab is now told `bye` and waits until it is looked at again instead of reconnecting
  and pushing the next tab out (endless ping-pong with 11+ tabs); a full server answers 503 instead of a stream that ends at once and
  was retried every few seconds; a stream refused with an error is retried after 30 s, 60 s … 5 min; reconnects after a restart are
  spread over 5–10 s. A tab without a live stream no longer sends heartbeats, and after a sub-account switch it only reports for its
  own sub-account. Changing "Team im Menü zeigen" no longer makes the person vanish and reappear for everybody; a new cursor choice is
  passed on at once. Cursors relayed for the previous page right after a page change are no longer drawn. "Saved here" ignores
  writes from hidden tabs and more read-like or polling requests (checks, audience counts, AI drafts, job polling).
- **Live collaboration: the sidebar avatars work with the keyboard.** After a menu entry with colleagues, Tab reaches a "Who is in …"
  button (visible while focused); Enter or Space opens the people there with *Hingehen*, Esc closes and returns the focus
  (`aria-haspopup`, `aria-expanded`, `aria-controls`).
- **Accessibility sweep** (axe-core WCAG 2.1 A/AA over 30 main pages in light and dark, desktop and phone width: 168
  findings, 114 of them critical, down to 0; 36 more pages checked as well; `tests/a11y.test.ts` keeps it that way):
  - **Keyboard:** contact, invoice, workflow, form, ticket and other list rows, kanban cards (deals, tickets), inbox
    conversations, funnel/course/community cards, workflow steps and form fields open with Tab + Enter (`pressable()`
    in `ui.tsx`, with a visible focus ring) – before, a contact or a deal could not be opened without a mouse. A saved
    contact list's ✕ is a button of its own.
  - **Dialogs:** one focus layer for every dialog, the command palette (Ctrl+K), the board settings drawer and the phone
    menu: the focus moves in, Tab stays inside, Esc closes only the topmost dialog, and the focus returns to the button
    that opened it – also when the dialog's code was still loading or a field took the focus. The palette and the
    project switcher are announced as a searchable list (combobox, highlighted entry); the menu button says whether
    the menu is open.
  - **Names:** filter and toolbar selects without a visible label are named (an explicit label, else their
    placeholder); icon-only buttons (add task, previous/next month, canvas export/share on phones), hidden file inputs
    and progress bars got names; toasts are announced (errors right away); tabs say which one is active; the wiki page
    tree and the conversation thread have valid roles.
  - **Contrast:** status colours as text (overdue dates, points, "Live", warnings) reach 4.5:1 in every theme and mode
    (`--green/--red/--yellow` are made per theme; filled badges and buttons use `--*-fill`); links in running text and
    all plain links in dark mode are underlined; the time under sent messages, view counts, board badges, locked
    academy badges and empty booking days are readable; text fields inside chips and the phone dialer show a focus ring.
  - **Public booking page:** fields are linked to their labels, days say whether they are picked or have no free time,
    loading and errors are announced.
- **DSGVO completeness** (personal data that escaped the erasure, the access export, retention or the consent rules;
  `tests/privacy-coverage.test.ts`, [docs/security.md](docs/security.md#audit-log-and-privacy)):
  - **Erasing a contact deleted records the agency has to keep:** *DSGVO löschen* removed every row that pointed at the
    person – also the client's projects (with their tasks' time and cost history), retainers with their closed and billed
    months, payment plans with their payments (which point at invoices) and sent payment reminders (business letters,
    § 257 HGB / § 147 AO). They now stay like invoices and contracts, only without the link to the person, and the answer lists
    them under `retained`. Contracts, on the other hand, were all kept – also drafts that never went out; as documented, only
    contracts that were sent stay now (drafts and cancelled ones, which the contract module lets you delete, go).
  - **The person's name stayed in the audit log and in other records' timelines:** the erase blanked only audit entries
    that contained the e-mail address – "Termin … – Dora Muster", "Zertifikat … für Dora Muster" and every other summary
    with the name or phone number stayed for a year, and the linked company's timeline kept "Kontakt „Dora Muster“
    verknüpft". Audit entries about the contact or naming them (e-mail, full name, phone) are now blanked, and timelines of
    other records keep the event with `[gelöscht]` instead of the name.
  - **Web hook payloads kept the erased person:** REST hooks (Zapier, Make, n8n) store the last payloads of every event as
    samples – with the whole contact – and never age them out, the delivery log keeps them 30 days, and inbound web hooks
    keep the last five request bodies per workflow. Samples, deliveries (also those still waiting) and captured bodies that
    carry the person now go with the erase ([docs/integrations.md](docs/integrations.md)).
  - **Community direct messages survived the erase and were missing from the export:** conversations point at members by id
    without a foreign key (one side can be the team), so an erased member's messages, its name and the conversation stayed
    for the other side, together with the other members' bell entries naming it ("Anna M. hat … kommentiert"). The erase now
    deletes the person's conversations (messages, read marks, reports), its blocks and the bell entries about it or its
    posts; the *DSGVO-Auskunft* lists its conversations, blocks and reports
    ([docs/community.md](docs/community.md#privacy-and-safety-notes)).
  - **Files of an erased person stayed on disk:** the rows of a member's community videos, course hand-ins, the attachments
    of its tasks and its certificates went with the contact, the files did not – videos, uploaded documents and the cached
    certificate PDF (with the person's name) stayed in the data folder for good, no longer reachable by any cleanup. The same
    happened on a plain *Löschen* (one contact or in bulk), there also with the audio uploaded for call analysis. Modules now
    name a contact's files (`app.services.contactFiles`); both ways of deleting remove them after the rows.
  - **Call recordings and voicemails of an erased contact stayed at Twilio forever:** the erase removed the call rows – the
    only place that knew the recording ids – so neither the erase nor the retention job ever deleted the audio at Twilio.
    The ids are now queued in the erase and deleted at Twilio right after it; what Twilio does not confirm is retried every
    hour ([docs/telephony.md](docs/telephony.md)).
  - **The DSGVO-Auskunft missed what hangs on the person's records:** the list of files uploaded with its form submissions
    (the export promised them as a list), the history of its tickets (status changes, internal notes) and its answers to
    webinar polls only point at the submission, ticket or registration. They are part of the export now.
  - **The DSGVO-Auskunft missed the articles a contact supplies** (stock articles point at their supplier with their own
    column). They are listed now. The new test puts one row of the person into every table that points at a contact – a
    new module's table included – and checks that the export lists it, that the erase leaves no row pointing at the person
    and that the person's name, e-mail or phone number stays only in invoices, contracts, the books, the personnel file
    and stock documents.
  - **Deleting a sub-account left its people's files and part of its rows behind** (self-hosted, *Agentur → Sub-Accounts*):
    only rows with a foreign key went – web hook payloads (with whole contacts), tracked links and the like stayed, and so did
    every file: form uploads, HR documents, receipts, certificate PDFs, import files from other CRMs, call recordings. It now
    uses the same eraser as a deleted cloud customer; the media library (pictures other sub-accounts' pages may show) and the
    audit log stay. The eraser now also takes call-analysis audio, hold music and the scaled picture copies, no longer wipes
    the knowledge memory's deletion queue (the customer's Cognee datasets were never deleted) and reads a large sub-account
    row by row instead of all at once ([docs/cloud.md](docs/cloud.md), `tests/location-erase.test.ts`).
  - **A deleted team member's private data stayed:** only tables with a foreign key to the login were cleaned up – the
    person's AI assistant chats (with whatever customer data was discussed), uploads to the assistant, Custom-GPT keys,
    personal tokens for outside MCP servers, notification lists, private views and private reports stayed for good, and the
    person stayed assignee and watcher of tasks. They now go with the login (also in the cloud team and with a deleted client
    account); the team's records keep the name ([docs/security.md](docs/security.md#audit-log-and-privacy),
    `tests/user-erase.test.ts`).
  - **Sequence mails claimed a confirmed consent they did not have:** every mail of an advertising sequence was marked
    `consent_basis: confirmed`, also for contacts the policy only let through as *Altbestand ohne Nachweis* – the proof in
    the contact's consent tab and the message list overstated what the agency could show. The mark is now the real basis
    (`confirmed` or `legacy`), like campaigns and workflow mails.
  - **Satisfaction surveys and review requests ignored "Nicht stören" and the consent rules:** the CSAT survey after a solved
    ticket was sent as a service mail – also to contacts on *Nicht stören* or who had withdrawn their consent, and without an
    unsubscribe link – and review requests (by hand, from the workflow step *Bewertung anfragen*, from the API) passed as
    conversation, so the send gate never looked at them although a workflow e-mail with the same text would have been
    stopped. German courts count asking for feedback as advertising (BGH VI ZR 225/17), as the NPS already did: both now go
    through the gate as advertising (with unsubscribe link and header), a survey that may not go out is skipped with the
    reason (and no longer retried every minute), a review request that may not go out answers 400 / fails the step with the
    reason ([docs/consent.md](docs/consent.md#the-send-gate), [docs/helpdesk.md](docs/helpdesk.md)).
  - **Meta Conversions API sent leads without their consent:** hashed e-mail, phone and name of every lead who came from a
    Meta ad went to Meta, whatever the contact had said – the Google Ads offline conversions next to it already required the
    consent *Tracking & Cookies → Marketing* (cookie banner or recorded by hand). CAPI now asks the same ledger; a lead or
    purchase without it is listed as *blockiert* and never sent ([docs/growth.md](docs/growth.md)).
  - **"Nicht stören" for WhatsApp alone did not stop WhatsApp:** the workflow step *DND je Kanal* stored it, but only e-mail
    and SMS asked for it – WhatsApp messages and templates (campaigns too) still went out. They are stopped now with the
    reason.
  - **Trigger bookkeeping grew for ever:** the "already fired" marks of the date triggers (one row per contact, workflow
    and year) and of the scan triggers (per message, appointment, overdue invoice and abandoned form) were never deleted.
    They are kept while the trigger can still see the record and then removed
    ([docs/workflow-actions.md](docs/workflow-actions.md#triggers), `tests/retention-bookkeeping.test.ts`).
  - **Affiliate clicks kept the visitor's id and a hash of the address for good**, although they only serve to count a
    repeated click within 24 hours (leads come from the attribution touches). Both are cleared after two days; the click
    stays for the numbers ([docs/growth.md](docs/growth.md)).
  - **Web hook samples with whole contacts were kept for ever** when an event type or an inbound web hook went quiet (only a
    newer event replaced them). REST hook samples and the kept inbound request bodies now go after 30 days, like the
    delivery log ([docs/integrations.md](docs/integrations.md)).
- **API contract: what the docs, the OpenAPI description, the apps and the events promise** (`tests/api-contract.test.ts`,
  a contract pass in `tests/mcp-sweep.test.ts`):
  - **Appointments ignored the documented fields:** the OpenAPI description names `start_at`/`end_at` for
    `POST`/`PATCH /api/appointments`, the handlers read only `start`/`end` – a documented create answered "Ungültige
    Startzeit" and a documented reschedule answered 200 without moving the appointment. Both names work now, an end alone
    changes only the end, an end before the start is refused. A public booking with the documented `name` created a
    contact without a name; it is split now. The OpenAPI bodies of tasks (no `done` on create, no `contact_id` on change)
    and of the contact's `name` (only on create) now say what the server does.
  - **Deleting contacts in bulk sent no `contact.deleted`**, unlike the single delete: webhooks, REST hooks and the
    Wissensgedächtnis never heard of those deletions. A task dependency sent `task.updated` with the task's id where every
    other `task.updated` carries the task.
  - **Android: outgoing calls showed our own number.** The API says `"out"`, the app only knew `"outbound"`, so the call
    widget and the quick view named the Twilio number instead of the person called.
  - **Docs named routes that do not exist** – `DELETE` and `/test` for the push channel settings, `DELETE /api/ads/leadforms`
    without id, `PATCH` on `/api/campaigns` and `/api/templates` without id – and called three routes every login may use
    "nur Admins". Public routes of GoHigh's own pages and fourteen events that reach "*" webhooks (`contact.deleted`,
    `contact.merged`, `task.updated`, time tracking, `billing.*` …) were not documented at all ([docs/api.md](docs/api.md#webhooks)).
- **Second bug sweep** (harnesses over every MCP tool, workflow action and trigger, background job and inbound webhook:
  `tests/mcp-sweep.test.ts`, `tests/wfx-empty-config.test.ts`, `tests/scheduler-sweep.test.ts`, `tests/webhooks-replay.test.ts`):
  - **MCP arguments** ([docs/api.md](docs/api.md#mcp-server)): every tool call is checked against the tool's `inputSchema` – near-miss
    types are converted (`"5"`, `"false"`, a list sent as JSON text), wrong ones are a `-32602` with a German message instead of a crash text
    (`stage.toLowerCase is not a function` in `ghl_update_opportunity`, `a.updates.map is not a function` in the canvas tools); the in-app
    agent uses the same check. A call without tool name or with non-object arguments is a `-32602` too.
  - **MCP scope**: a key or OAuth connection for one sub-account gets `403` for a foreign `location_id` on every tool (`ghl_list_invoices`,
    `ghl_list_docs` and `ghl_list_dashboards` silently answered with the key's own sub-account); an agency connection without `location_id`
    is told so instead of "Kein Sub-Account gewählt (x-location-id)".
  - **Read-only connections** ([docs/security.md](docs/security.md)): read-only agency keys and OAuth grants could not run the read-only
    tools that compute with a POST (`ghl_run_report`, `ghl_calc_*`, `ghl_workflow_test_run`, `ghl_ai_suggest_reply`, `ghl_umzug_preview`).
  - **Reading is not "read"**: `ghl_get_conversation` and any key reading `GET /api/conversations/:id/messages` marked the conversation read
    for the team and pushed the read flag to Gmail/Outlook; only people do that now.
  - **Canvas**: an element the scene cannot use (`elements: [{}]`) was a 500 on `POST /api/canvas/:id/elements` and `POST /api/canvas`; now 400
    (and no half-made board).
  - **Workflows**: an *E-Mail senden* or *SMS senden* step without content sent a blank message – now a step error ("nichts gesendet");
    *Deal ändern* with a cleared value failed with „Wert „“ ist keine Zahl“; empty settings give "Kein Feld gewählt", "Kein Objekt gewählt",
    "Keine Sequenz gewählt", "Betrag fehlt" instead of messages with empty quotes. Static check: every trigger has a source, every emitted
    event is a trigger or a listed internal event.
  - **Background jobs**: the 30-second invoice adoption read the whole invoice table (`status NOT IN ('draft')` cannot use the partial index
    `invoices_unadopted`); a failing job is named in the log (`[tick] <module>: …`).
  - **Inbound webhooks** ([docs/integrations.md](docs/integrations.md#eingehende-webhooks)): a repeated SMS (`MessageSid`, gateway
    `messageId`) or forwarded mail (`Message-Id`) on `/hooks/:loc/sms|email` and the support mailbox was stored again (twice in the inbox, a
    second auto-reply); both workflow webhooks now take a repeated delivery id (`webhook-id`, `Idempotency-Key`, `X-GitHub-Delivery` …) once.
    `/hooks/workflow/:id` made empty contacts from a list, a text or a body without e-mail, phone or name (now 400), and the SMS URL accepted
    objects as sender and text.
- **Third bug sweep (public pages, e-mails, PDFs)** (a crawl of every public page at 375 px and 1440 px with script payloads in every
  query parameter and stored field, every e-mail the system sends rendered with sparse data, every invoice and dunning PDF with long
  data; `tests/public-sweep.test.ts`, one more browser test in `tests/form-browser.test.ts`):
  - **E-mails to contacts without a name** began with "Hallo ," (invoice, quote, dunning, double opt-in, SEPA pre-notification,
    purchase, contract, survey and ticket mails, and every own template with `{{contact.first_name|}}`): an empty merge field no
    longer leaves a gap before punctuation ("Hallo,", "Danke für deine Anfrage!").
  - **Credit note mail**: "deine Gutschrift … über -11,90 €" – now the amount without the minus.
  - **Unsubscribe link**: opening `/u/…` unsubscribed at once, so link scanners of mail gateways and anti-spam filters (they fetch
    every link of a mail, also the `List-Unsubscribe` header) unsubscribed people who never clicked. The link now opens a page with one
    button, *Ja, abmelden*; the one-click `POST` of mail clients (RFC 8058) is unchanged
    ([docs/deliverability.md](docs/deliverability.md#unsubscribe-header-rfc-8058)).
  - **Invoice PDF with long names** ([docs/invoicing.md](docs/invoicing.md#pdf-and-girocode)): the sender's name ran into the
    letterhead, a long company of the customer ran off the page and over the information block, long references covered their label,
    the recipient in the payment box ran under the GiroCode, the footer columns overlapped and a long footer text sat on the IBAN and
    BIC. Lines now get smaller, the address wraps inside the window (it is never cut); the address of the **dunning letter** no
    longer runs into the date. Emoji in names are left out instead of printing "?".
  - **Public pages on phones**: long words in headings (contract, booking page, legal pages) ran out of their card; long positions made
    the **quote page** 150 px wider than the phone.
  - **Legal pages written into a website** (Impressum, Datenschutz, Widerruf, Barrierefreiheit) had 96 px between every heading and its
    text.
  - **Forms with one question at a time**: after a typed answer, a question without a text field (stars, scale, NPS, choices) had no
    focus – Enter and the option letters did nothing until the visitor clicked; forms with several pages dropped the focus after Enter
    on the last field of a page. The focus now moves to the new screen.
  - **Review page** (`/r/…`): the stars could not be reached with the keyboard (now buttons with names), the comment field had no
    label, and a failed send still said "Vielen Dank".
  - **Chat widget**: the fields and the send button of the chat window had no names (placeholders only); the round button kept saying
    *Chat öffnen* while the chat was open.
- **Leftovers of the third bug sweep** (`tests/sweep3-leftovers.test.ts`):
  - **Double opt-in mail** ([docs/consent.md](docs/consent.md#double-opt-in)): it had a tracking pixel, tracked links and an
    "Abmelden" footer although the person has not consented yet (§ 25 TDDDG). The confirmation mail and its reminder are now never
    measured and carry no unsubscribe link.
  - **Service mails without "Abmelden"** ([docs/deliverability.md](docs/deliverability.md#unsubscribe-header-rfc-8058)): invoices,
    quotes, dunning letters (also the workflow step *Karten-Update-Link senden*), appointment confirmations, reminders and
    cancellations, SEPA and order mails are no advertising – their footer names the company only. Their opens are still measured
    by default; the new switch *Einstellungen → E-Mail & SMS → Öffnungen bei Geschäftsmails messen*
    (`settings.email.track_business_opens`, [docs/email-tracking.md](docs/email-tracking.md#settings)) leaves the pixel out of them.
  - **`/robots.txt` and `/favicon.ico`** on the app's domain answered with the web app's HTML page: now a real robots.txt (public
    pages open; the app, the API and personal links such as invoices, quotes, tracking and unsubscribe links closed) and the app icon
    ([docs/self-hosting.md](docs/self-hosting.md#eigene-domains)). Websites on their own domain keep their own robots.txt.
  - **Number-swap script** `/a/:loc/dni.js` (and the attribution snippet `t.js`) had no `Cache-Control` when switched off – both
    answers are now cached for 5 minutes.
  - **Booking confirmation as plain text**: an empty merge field on a line of its own (no meeting place) left two blank lines; such a
    line is now left out (every template).
  - **SEPA mandate request mail**: "Der Link gilt bis 4.11.2026" – now "04.11.2026" like the other mails.
  - **Booking, webinar and review pages** stayed empty or did nothing without JavaScript; they now say so (like the forms).

### Security
- **Live collaboration review** ([docs/collaboration.md](docs/collaboration.md#wer-was-sieht)):
  - **A presence stream no longer outlives its login.** Signing out, a revoked session ("sign out other devices", a new password), a
    changed or deleted person, removal from the sub-account or a deleted sub-account now end the stream at once (an expired session at
    the next 20-second check); before, an open tab kept receiving the team's whereabouts and cursors after its session was gone.
  - **No free text from one browser reaches the others.** The `title` a tab sent with its page was relayed to every colleague allowed to
    see that area – any member could push arbitrary text (or a record's name) into the colleagues' team list. It is now ignored; the
    reader's app names the page from its own menu.
  - **Invisible and hidden people get no cursors.** They send none, but could watch the others' cursors unseen; cursors now go only to
    receivers who are visible themselves. "On this page" only counts a receiver's tab in the stream's own sub-account.
  - **At most 300 presence messages per person and minute** (429): every heartbeat can fan out to every stream of the sub-account.
  - The sub-account switch (`PUT /api/presence/settings`) writes one readable audit line (`presence.settings.update`, on/off); presence
    itself and the personal choices stay unlogged.
- **Team-Chat, Team-Posteingang, Canvas and Living Boards streams no longer outlive their login**
  ([docs/security.md](docs/security.md#sign-in-and-sessions)): these live streams re-checked the person and the sub-account, never
  the session – after signing out, "sign out other devices", a revoked session, a new password (own or set by the admin) or an
  expired session, an open tab kept receiving chat messages, inbox events and board and canvas changes until it was closed. Like
  presence, every stream a person opens is now bound to the browser session (or the app's device token) it was opened with: it
  ends at once on signing out and revoking, an expired session at the next 20-second check, with `bye` so the browser does not
  reconnect in a loop (it tries once more when the tab is looked at again). A person's canvas stream is now also re-checked for
  access (removed from the sub-account, the right or the board taken away) – before, it never was; chat and inbox streams of a
  deleted sub-account end too. Streams opened with API keys or MCP connections end with their key (next entry). One shared check for every hub,
  presence included: `server/services/stream-login.ts`.
- **A live stream opened with a key ends when the key is revoked** ([docs/security.md](docs/security.md#sign-in-and-sessions)):
  a canvas (or other) stream opened with a sub-account or agency API key or an MCP connection kept receiving every change
  after the key had been deleted or the connection disconnected in *KI-Werkzeuge*. It is now bound to that key like a
  person's stream to their session: deleting the key or disconnecting the connection ends it at once with `bye`, an MCP
  access token that ran out at the next 20-second check.
- **Cloud sign-up: no account pre-hijacking** ([docs/cloud.md](docs/cloud.md#what-the-customer-gets), finding O-1 of
  [docs/security-review-2026-10.md](docs/security-review-2026-10.md#follow-up-fixes-after-0041)): the password typed into the form only counts
  when the verification link is opened in the browser that sent the form; anywhere else the link asks for the password and the form's one is
  discarded. The link is claimed by the first confirmation (afterwards it only continues in that browser), and the confirmation – or a Google
  sign-up – closes every other open sign-up for the address (links, passwords, browser bindings). Provisioning refuses an unverified sign-up.
- **Public input never changes who a contact is** (O-2, [docs/sales.md](docs/sales.md#duplicate-assistant)): forms, booking pages, team calendars,
  the chat widget and its AI, webinar registration, the AI phone agent's bookings, Stripe Checkout and Meta lead forms no longer overwrite a stored
  e-mail address or phone number (`upsertContact(…, { publicInput: true })`). A known number with another address creates a new contact (paired by
  the duplicate assistant), a differing number is noted on the timeline as an unverified alternative, and the chat widget shows a visitor only the
  messages since their own start – and its AI bot answers from that chat and the name only, not from the contact's other messages and data.
- **Disk quota for public form uploads** ([docs/forms.md](docs/forms.md#limits-and-settings)): `PGHL_PUBLIC_UPLOADS_MB` per sub-account (default
  2048) and, in the cloud, the plan's media storage, which now counts form files – 413 above the cap before anything is written, an e-mail and a
  bell/push notice to the sub-account at 90 % and 100 %.
- **"Today" in the sub-account's time zone** for the plugin workshop's sample data, the accounting's default report period and period year and the
  booking date of Stripe refunds (00:30 on 1 January in Berlin is the new year, not the old one).

## [0.0.41] – 2026-10-05

### Added
- **Documentation checks.** `npm run docs:check` (the same rules run in `tests/docs.test.ts`) verifies that every relative link and `#anchor`
  resolves, every `docs/*.md` page is linked and README.md indexes them all, every `PGHL_*` variable the server reads is in `.env.example` and
  `docs/self-hosting.md` (and no page names one that no code reads), every route family under `/api/` is named in a page, every workflow action
  and trigger type is listed in `docs/workflow-actions.md`, the README numbers (MCP tools, triggers, actions, tours, chapters, themes, widgets)
  never promise more than exists, the changelog has one heading per kind in a version, and German pages contain no English paragraphs.
  `npm run docs:gen` adds missing rows to the workflow lists and regenerates `docs/handbuch.md`.
- **ZUGFeRD 2.3 / Factur-X 1.07** ([docs/invoicing.md](docs/invoicing.md#zugferd--factur-x-pdf-with-the-xml-inside)): *ZUGFeRD-PDF* next to the
  XRechnung on finalised invoices and credit notes – the invoice PDF with the CII embedded as `factur-x.xml` (profile EN 16931) or
  `xrechnung.xml` (profile XRECHNUNG), `/AFRelationship /Alternative`, `/AF` and EmbeddedFiles on the catalog, XMP with PDF/A-3B
  identification and the Factur-X extension schema, sRGB ICC output intent – written by a post-processing step on the own PDF writer
  (no new dependency). Archived like the XRechnung; `GET /api/invoices/:id/zugferd`, MCP tool `ghl_invoice_zugferd`, setting
  *ZUGFeRD-PDF statt einfachem PDF anhängen* (`attach_zugferd`, off by default) and `attach_zugferd` per send. Limit: the base fonts are
  not embedded, so a strict PDF/A-3 validator flags the PDF part.
- **DATEV `document.xml`** ([docs/backoffice.md](docs/backoffice.md)): the documents ZIP carries DATEV's *Document v06.0* file for
  Belegtransfer / DATEV Unternehmen online (Rechnungseingang = booked receipts, Rechnungsausgang = invoices and credit notes with their
  sent PDF), and the EXTF Buchungsstapel links each booking to its document with `BEDI "<GUID>"` in the *Beleglink* column. Options
  `index=0`, `process=archive` and `beleglink=0`.
- **Lexware Office / sevDesk live sync** ([docs/integrations.md](docs/integrations.md#lexware-office-and-sevdesk-live-sync)), *Apps → Buchhaltung*:
  connection per sub-account (API key sealed, *Verbindung testen*, mapping options), every finalised invoice and credit note pushed
  automatically – customer upsert (stored link → customer number → e-mail → create), Lexware sales voucher with one item per tax rate,
  GoHigh's number and PDF; sevDesk invoice with all lines, tax rule and *marked sent*, credit notes as sevDesk credit notes – remote id in
  `invoice_links` (new provider `sevdesk`), payment status pulled every two hours and recorded through `recordPayment`. One job per
  document plus a lookup by number before creating (never twice), per-key rate limiter (Lexware 2 req/s), retries with backoff, error log
  with retry, backfill of older invoices. `safeFetch` accepts Buffer bodies (multipart uploads).
- **Google Ads offline conversions** ([docs/ads-manager.md](docs/ads-manager.md#offline-conversions-google-ads)), *Attribution → Tracking &
  Werbekonten*: deal won (value/currency), form submitted, appointment booked and invoice paid uploaded with UploadClickConversions –
  gclid/gbraid/wbraid from the attribution touches, enhanced conversions for leads with SHA-256-hashed e-mail/phone (Google's
  normalisation), order ids against duplicates, consent gate (ledger *Tracking → Marketing* confirmed, checked at the event and before the
  upload), queue with per-row partial-failure handling and backoff, dry run with `validate_only`, upload log.
- **Job costing & retainers** for projects ([docs/projects.md](docs/projects.md#job-costing-and-retainers)), new menu *Rentabilität*
  (lazy page) and *Budget & Kosten* in every project head:
  - **Budgets** in hours and/or money with alert thresholds (default 80 %/100 %); each threshold fires once – bell, push, app feed,
    audit line and the workflow trigger `project.budget_threshold` – and re-arms only when the use drops below it; burn-down chart.
  - **Internal cost rates** per person (plus a default, Leitung only) and **external costs** per project, optionally linked to a
    receipt of the bookkeeping.
  - **Profitability** per project or client: revenue (invoiced at the billed rate + closed retainer months + unbilled billable time),
    cost (hours × cost rate + external costs), margin in € and %, CSV export.
  - **Retainers**: monthly hour contingent at a fixed price per client or project, carry-over (none / up to N hours / unlimited),
    overage rate; the month close (manual or automatic) makes an invoice draft with fee + overage, carries the rest over and marks
    the month's time as billed (cancelling the invoice re-opens the month).
- **Internal approval of quotes** ([docs/sales.md](docs/sales.md#internal-approval)): an optional rule per sub-account – quotes above
  a net amount or discount need the approval of a role (admins, Leitung, finance, sales team leads); request, approve/reject with
  comment, notifications and audit log, workflow triggers `quote.approval_requested` / `quote.approval_decided`. The gate runs inside
  `sendQuote` (`app.services.quoteSendGates`), so web, API keys, MCP and workflows get `409 approval_required` until the current
  content is approved; the customer page and signature are unchanged.
- **SEPA direct debit and transfer files without Stripe** ([docs/sepa.md](docs/sepa.md)), new page *Umsatz → SEPA* (lazily loaded):
  - **Mandates** per contact on paper or **online** through a personal link (`/sepa/m/<token>`) with the German mandate text (CORE/B2B,
    recurring/one-off) and a proof of consent (time, IP network, browser fingerprint, SHA-256 of the text); creditor identifier with check
    digits, IBAN mod 97, BIC mandatory outside the EEA, unique mandate references, sequence types FRST → RCUR, OOFF, FNAL, revoke/suspend
    and expiry after 36 months without a collection.
  - **Collection runs** of open finalised invoices: preview grouped by scheme and sequence type with totals, **pre-notification** e-mails
    (14 days by default, at least 1 day – the period is written into the mandate text), **pain.008.001.08** file (control sums, MsgId,
    PmtInfId, invoice number as EndToEndId), *SEPA-Lastschrift eingereicht* in the invoice's audit trail and a Mahnstopp meanwhile.
  - **Paid / returned** collections through the invoice payment records (`recordPayment` / `revertPayment`): returns keep the reason code,
    block or end the mandate where the code says so and can bill the return fee as a draft invoice; withdrawing a rejected file restores
    the sequence state.
  - **pain.001.001.09** transfer files for booked, unpaid supplier invoices of the accounting and manual payout lists.
  - Workflow triggers `sepa.mandate_signed`, `sepa.returned`; read-only MCP tools `ghl_sepa_mandates`, `ghl_sepa_runs`; OpenAPI tag *SEPA*;
    Akademie tour *SEPA*.

### Changed
- **Documentation synced with 0.0.40.** README numbers: 240+ MCP tools (was 100), 140+ triggers and 130+ actions (was 94 / 120), 110+ module tours,
  30+ report sources, first download about 140 KB gzip, 4,500+ tests; pricing stated the same everywhere (self-hosted 0 €, cloud Solo 49 €,
  Team 79 €, Agentur 299 € incl. white-label, never per seat); the documentation table lists every page; `docs/self-hosting.md` documents all
  `PGHL_*` variables in groups and `.env.example` lists them all (no duplicates); `docs/workflow-actions.md` lists the 14 missing actions and 51
  missing triggers; `docs/api.md` names the route families that were undocumented (tags, smart lists, custom fields, products, reviews, search,
  webhooks, uploads, API keys, audit, locations, snapshots …); `docs/roadmap.md` no longer lists shipped work; English paragraphs on German
  pages were translated; the 0.0.35–0.0.40 changelog entries were merged to one `### Added` / `### Changed` / `### Fixed` each (feature entries that
  had landed under *Changed* moved to *Added*).
- The affiliate payout export (pain.001.001.03) and its IBAN check now use the shared SEPA builder (`services/sepa-xml.ts`) and the
  invoice module's IBAN helpers – same output.

### Fixed
- The links in `docs/handbuch.md` to the README pointed at the English README with German anchors; they now point at `README.de.md`. The Akademie
  step *Der Gesamt-Guide* said 13 chapters (there are 14), and the tour *Workflows: Schritte finden und einstellen* promised "über 100 Aktionen und
  rund 80 Auslöser".
- **Robustness and performance sweep** (found by fuzzing every route and by upgrading a 0.0.36 database with the current code):
  - **Scheduler:** a background job that hangs (a mail server or API that never answers) no longer holds up every job behind it – the tick moves on after 60 s (`jobBudgetMs`) and does not start the slow job again until it has finished; the tick timer can no longer get stuck after an error.
  - **Bad input is a 4xx, not a 500:** a literal `null` body, a malformed `%`-escape in a path or cookie, an object or array where a column wants text, a required column sent as `null` (400 with the column name), a duplicate (409), a link to a record that is gone (400), a frozen record guarded by a database trigger (409), dates that are not dates (`?from=zzz` on planner and time routes: 400), and a network failure towards another service (502) used to end in "Interner Fehler".
  - **Invoices:** one invoice that cannot be numbered and frozen no longer blocks all the invoices behind it, nor fills the log with 50 errors every 30 seconds.
  - **Segments:** with more than 40 watched segments the same 40 were checked forever; now the least recently checked come first, one segment at a time with a pause in between and at most 4 s per run.
  - **Backups:** two snapshots in the same second no longer fail (500); the database download is a worker-thread snapshot that is streamed instead of read into memory.
  - **Indexes** for the hourly housekeeping deletes (e-mail events, tracked links, form events, DNI sessions, voice turns, response log, community notifications, Composio and plugin logs: a scan of 2 M e-mail events took 236 ms, now 0.2 ms) and for the 15-second ticks of recurring invoices, ticket SLA and survey reminders; the hourly cleanup of unsent tracked links looks at the last four days only, and the community video cleanup reads the posts once instead of once per video.
- Found by crawling every page in a headless browser (phone and desktop, light and dark):
  - **Deal drawer** (*Opportunities*): on laptop-height screens the footer with *Speichern* ended below the screen and could not be reached.
  - **New contact:** the dialog stayed open on top of the new contact after saving, a second click saved a duplicate.
  - **Dialogs:** the ✕ was 31 px high on phones (a CSS variable only defined on creator pages); Tab and Shift+Tab now stay inside an open
    dialog instead of walking into the page behind it; the empty notification panel closes with Esc.
  - **Dark mode:** selected chips, tabs and tools of the canvas, AI gallery, team chat and agent panel used the raw button colour for text
    (2.7:1) – they use `--brand-text` now; links in the amber notices are readable.
  - **Public invoice page:** the items table no longer widens the page on a phone; cloud legal pages (AGB, AVV, Datenschutz) break long words.
  - **Demo data:** the two lost deals were refused (missing loss reason) and stayed open, so the demo showed no lost deals.
  - Accessible names for the timer chip on phones, due-date inputs, review checkboxes, invoice item inputs and the funnel page path.
  - New `node scripts/qa-smoke.mjs` repeats the layout checks in a real browser ([CONTRIBUTING.md](CONTRIBUTING.md)).
- **Leftovers of the crawl and the robustness sweep:**
  - **"Today" is the sub-account's day**, not the UTC date (which is still yesterday between 00:00 and 02:00 in Berlin): HR (vacation in the
    past, cancelling a started absence, *away today*, calendar start, carry-over expiry on 1 April, default year on 1 January, checklist due
    dates), affiliate payouts (reference month, CSV name, SEPA execution date = the next day), open items and the stock valuation export.
  - **HubSpot import:** checking the token tries once with an 8-second timeout and answers 502 with a clear message when HubSpot does not
    answer – it used to run the import's retry and backoff and hang for more than 15 seconds.
  - **Campaigns and templates:** a JSON array (or a bare string or number) as the whole request body is a 400 instead of a 500.
  - **Cloud signup** (`/start`): the empty form sent within the first seconds now shows what is missing instead of "Das ging zu schnell"; the
    time check still applies to every submission that would sign up.
  - **Touch:** the inbox channel chips, sortable table headers and the report-table headers on dashboards are 44 px high on touch screens.
  - **Contrast:** rating stars use a darker amber on light panels (5:1 instead of 2.15:1); "Leer" on an empty canvas tile is readable in dark mode.
  - Accessible names for the channel inputs of a community group and for Markdown text areas (*Beitritt → Über uns* and the other editors).

### Security
- **Security review of 0.0.37–0.0.40** (findings, exploit sketches and tests: [docs/security-review-2026-10.md](docs/security-review-2026-10.md#follow-up-review-versions-00370040)):
  - **Record access now covers what hangs on a contact in the conversation area.** The call log (list, search, one call, recording, notes, the
    browser phone's call controls), call intelligence (analyses, transcripts, scores), the **power dialer** (lists, entries, callbacks – *Nächster
    Kontakt* skips contacts the person may not open and no longer hands out their name, phone, e-mail and notes), AI phone sessions, drafts across
    threads, media files and mailbox attachments of a message, **bulk changes in the inbox**, segment members, campaign recipients, the phone app's
    call list and the *Anrufe* report source follow the rules. The **Cognee memory** no longer answers about contacts, notes and conversations for
    somebody who sees only part of them.
  - **Cloud: the operator needs the customer's consent for more than the sub-account routes.** Reports across all sub-accounts, the operator's audit log
    and user management (set a password, reset 2FA, sign out, delete a customer's login, or put a login into a customer's sub-account) now skip or
    refuse customers who have not opened their account for support.
  - **Cloud: storage fair use** counts course videos, community videos, call audio and meeting recordings, and refuses the big uploads that would pass
    the plan; community members can start only about three videos' worth of uploads a day.
  - **Hosts:** a site or help center can no longer be pointed at the app's own address, the agency's or a client's login domain, another help
    center, or (cloud) the service's domain and its sub-domains – the host decides which page is served.
  - Twilio webhooks accept only form bodies (a signature over the URL did not cover a JSON body); the pairing code of the local bridge comes from the
    system's random source; a number pool that shares its numbers no longer grows a row per anonymous visit.

## [0.0.40] – 2026-10-05

### Added
- **E-mail marketing in depth** ([docs/email-marketing.md](docs/email-marketing.md)), all under *Kampagnen* with lazily loaded pages:
  - **A/B tests** of subject, sender name or content on a 5–50 % test share; winner by human opens, clicks or revenue after a waiting time
    (machine opens never count), automatic send of the winner, results with significance, manual winner while it waits.
  - **Resend to non-openers** after N hours with a new subject (once, human opens only) and **send-time optimisation** ("zur besten Zeit
    je Kontakt" within 24 hours from each person's open history, fallback to the sub-account's best hour).
  - **Behaviour segments** with a live count (opened/clicked/not opened, visited a page, bought, form, tag, field, consent, last activity;
    nested AND/OR); saved segments as campaign audience and workflow triggers `segment.entered` / `segment.left`.
  - **WhatsApp template campaigns** (approved Meta templates, category from Meta, marketing templates respect the consent gate).
  - Workflow trigger **`checkout.abandoned`** from Stripe `checkout.session.expired` and the workflow template *Warenkorbabbruch-Serie*.
  - **Template gallery** with 60 responsive German designs in 13 categories, search and preview.
  - **Deliverability:** warm-up plan with rising daily caps (honoured by the campaign loop), reputation dashboard (bounce, complaint and
    unsubscribe rates per campaign, recipient domain and week with thresholds and warnings), list hygiene (repeated soft bounces →
    *Nicht stören*, sunset segment) and address validation (syntax, MX, disposable and role addresses).
  - Campaign footers link the preference centre next to *Abmelden*; footer block option *Einstellungs-Link*.
  - MCP tools `ghl_campaign_ab_results`, `ghl_list_segments`, `ghl_segment_count`, `ghl_save_segment`, `ghl_email_gallery`,
    `ghl_deliverability_report`; Akademie tour *E-Mail-Marketing*.
- **Telephony: call centre and conversation intelligence** ([docs/telephony.md](docs/telephony.md)), tabs of *Anrufe*:
  - **Telefonmenü (IVR) builder:** a tree of steps – greeting (text or your own recording), keys, schedule (business hours, German holidays per *Bundesland*, own holidays and special hours), say, forward to numbers and people, ring group or queue, **voicemail per branch** (own mailbox name and greeting, optional callback task), AI phone agent, hang up – with a **dry-run test** (keys and time), warnings for unreachable steps, and the path of every call in the call log. **Audio** files (MP3/WAV upload or spoken from text) for greetings, hold music and voicemail drops.
  - **Ring groups and queues:** all at once, in order or round robin; people ring in the browser phone only while reachable; queue with welcome, hold music (own file or a built-in melody), position announcements, longest wait and **overflow** (default, voicemail, number, other group, AI agent, hang up); numbers per group and a report (offered, answered, abandoned, waits, service level, answers per member).
  - **Call notes and transfer:** notes during and after a call (also in the contact's notes), **cold** hand-over and **announced** hand-over (the colleague hears who is calling and presses 1) to a colleague's browser or a number.
  - **Numbers:** a registry of every number with label, kind and route (default, menu, group, AI agent, voicemail box, forwarding, person); **buy** (search by country, type, area code and digits, pricing, German address and regulatory bundle explained and selected, explicit confirmation) and **release** over the Twilio API.
  - **Tracking numbers and dynamic number insertion:** a number per campaign, and pools whose number a website snippet swaps per visitor source (respects the cookie banner); calls are attributed through the existing attribution and the contact gets first/last touch; report *Anrufe nach Quelle* with CSV.
  - **Power dialer:** call lists from smart lists or tags, auto-advance, outcome codes (editable), notes, callbacks as tasks, **voicemail drop**; *Nicht stören*, consent (ledger or strict), calling hours, holidays and attempt limits are enforced **on the server** – also for the browser phone and click-to-call; *Nicht mehr anrufen* withdraws the phone consent. Trigger *Power-Dialer: Ergebnis*.
  - **Call intelligence** (opt-in): transcript per speaker for recorded calls (two channels), uploaded meeting recordings and pasted transcripts; talk-time ratio, longest monologue, questions, filler words, speech rate, keywords; AI summary, next step, **action items → tasks**, topics, objections and sentiment; summary in the contact's timeline and call log; trigger *Gespräch ausgewertet*; MCP tools `ghl_call_analyses`/`ghl_call_analysis`; hook `callSummaries`. **Scorecards** with weighted criteria, AI pre-score with reason and quote, manager review and a coaching report.
  - **Recording notice and retention:** the notice before a recorded call (inbound: the caller; outbound: the called person), with your own wording; retention periods for recordings and voicemails, deleted at Twilio as well.
  - Academy tours *Telefonmenü, Zeitpläne und Warteschlangen*, *Nummern kaufen, zuordnen und Anrufe nach Quelle*, *Power-Dialer* and *Gespräche auswerten*.
- **Website builder 2.0: sections, columns, design, 23 templates, CMS, accessibility and funnel analytics** ([docs/sites.md](docs/sites.md)):
  - **Layout and editor:** pages are built from **sections → rows → 1–4 columns → blocks** (the old flat lists keep working; *In Abschnitte umwandeln*
    keeps the look). The editor has a structure tree with **drag & drop** (plus ↑ ↓ / duplicate / remove buttons for touch and keyboard), undo/redo,
    an inspector (content · style · devices) and a **live preview for desktop, tablet and phone**. Per section, column and block: spacing, background
    (site colour or own), background image with overlay, border, corners, shadow, alignment; **hide per device**, **column stacking** (tablet / phone /
    never), **column width and section spacing per device** and **font size per device**. New blocks: call to action, steps, numbers, logos, gallery,
    **product / checkout**, **collection**, search, component. **Reusable components** (save a section or block once, use it on every page, edits apply
    everywhere; deleting one detaches the places).
  - **Design tokens and global chrome:** colours (nine, with a WCAG contrast check), nine system-font stacks, type scale, radius, shadows – emitted as CSS
    custom properties; a **global header and footer** per site with a **navigation menu editor** (named menus, one level of sub-items, links to pages that
    follow renames), skip link, mobile menu, sticky header, language switcher, search field and automatic links to Impressum, Datenschutz, Widerruf, AGB,
    Barrierefreiheit and the cookie settings.
  - **Template gallery:** **23 German templates** (13 websites: coach, craftsman, agency, SaaS, restaurant, practice, real estate, law & tax, fitness, photographer,
    salon, club, careers; 10 funnels: lead magnet, webinar, course sale, event, link in bio, newsletter, podcast, product launch, video sales letter, application)
    with a preview per page and device. *Apply* builds the site: pages, design, header/footer/menu, the collections it uses (with samples), a **form**
    (new, or one you choose, redirecting to the thank-you page), your calendar and product, and **Impressum / Datenschutz / Widerruf from the company data**
    (the Einwilligung-&-Recht generator); all or nothing, and the answer lists what is still missing. MCP tool `ghl_site_templates`.
  - **CMS collections:** custom fields (text, long text, number, image, link, e-mail, phone, date, yes/no, choice, tags, product, rating), presets for team, projects,
    products, testimonials, FAQ and jobs, entries with draft/published and order, **list block** (grid/list, filters, search, sort, paging, fixed filter),
    **detail pages with their own template** (`{{field}}` placeholders, product buy buttons), SEO, **`sitemap.xml`** and **site search** integration, event
    `site.item_published`.
  - **Redirects, 404, search, languages:** redirect manager (exact and wildcard `/blog/*` → `/magazin/$1`, 301/302/307/308, loop detection, test, bulk import,
    hit counters, list of unknown paths with one-click redirect); custom 404 page; site search (`/search`, umlaut-folded, title-weighted, rate-limited);
    **hreflang** and `<html lang>` for translated pages, translation copies from the editor.
  - **Images and speed:** sizes read from the file header for every upload (PNG, JPEG incl. EXIF turn, GIF, WebP) so each `<img>` has `width`/`height`;
    the editor scales uploads to several widths (WebP where the browser can write it) and writes `srcset`; below the first picture `loading="lazy"`; an optional
    server-side **image engine** (`sharp` when installed – detected, never required; `PGHL_IMAGE_ENGINE=off`) serves AVIF/WebP copies at `/uploads-opt/<width>/<file>`.
    Pages inline only the CSS of the blocks they use; budgets for every template (HTML ≤ 32 kB, gzip ≤ 8 kB, CSS ≤ 16 kB) are tested.
  - **Product / checkout block:** a card with price incl. VAT (or the § 19 UStG note), billing interval, order-bump and discount hints, linking to the buy page with the
    checkout-law button, withdrawal waiver and AGB box; the clicked page travels as `fp` into the Stripe metadata.
  - **Accessibility (BFSG / WCAG 2.1 AA):** a check of every page and of the editor's draft (alt texts, contrast, heading order, form labels, link names, language,
    skip link, iframes, tabindex, tables …) with the WCAG criterion, a **fix hint** and a jump to the block; a list of manual checks; a generated
    **draft of the Barrierefreiheitserklärung** from the company data and the findings (publishable as a page; not legal advice, micro-enterprise note). MCP tool `ghl_site_a11y_check`.
  - **Funnel analytics per step:** views → continued → conversions with drop-off, time on page, scroll depth, forms / bookings / purchases per step with revenue
    (Stripe `fp`), **A/B test per step**, revenue by the attribution report, devices, sources, days, CSV; counted **without cookies** (daily-rotating hash, no IP stored, bots
    and Do-Not-Track / GPC excluded, 180 days retention, configurable); board widget *Funnel-Auswertung*; MCP tool `ghl_funnel_analytics`.
  - **Copying a site** (agency snapshots, copy to another sub-account) carries the page layouts, components, collections with entries and redirects, with every reference
    (`component_id`, `collection_id`, `page:<id>` links, the custom 404 page) pointing at the copies.
  - Academy tours *Website-Baukasten* and *Sammlungen, Weiterleitungen, Barrierefreiheit & Statistik*; the *Funnels & Websites* tour points at the new editor.
  - New hooks in `app.services`: `siteBlocks`, `siteRedirect`, `siteResolve`, `siteSearchDocs`, `siteServe`, `siteNotFound`, `siteMissed`, `siteImages`, `imageEngine`.
  - New tables: `funnel_pages.layout`, `site_components`, `site_collections`, `site_items`, `site_redirects`, `site_misses`, `site_hits`, `site_conversions`.
- **Courses in depth** ([docs/courses.md](docs/courses.md)):
  - **Hosted course video:** resumable chunked upload (the community protocol, up to `PGHL_COURSE_VIDEO_MB`), storage under the data
    directory, **signed expiring links** bound to the member's session and enrolment (no hotlinking, same-origin only), HTTP **range
    requests**, poster frame, optional **ffmpeg** (feature-detected: faststart, **HLS** 360/720/1080p, AI audio cut – plain MP4 without it),
    **captions** (WebVTT/SRT upload, or AI transcription through the sub-account's speech provider), a player with **resume position per
    student**, playback speed, **chapters** and *complete at X % watched*.
  - **Lesson discussion** (threaded, *Kursleitung* badge, team and member notifications), **ratings & reviews** with moderation and a
    public reply, **learning paths** (a sequence of courses with unlock rules; access by tag, purchase or by hand), **cohorts** (start date,
    cohort-based drip, seats, automatic assignment, link into a community channel), **course analytics** (per-lesson drop-off, completion,
    watch time, retention curve, quiz scores, CSV) and an **installable member app** (courses + community).
  - Workflow triggers *Kommentar in einer Lektion*, *Kurs bewertet*, *Lernpfad freigeschaltet*, *Lernpfad abgeschlossen*, *Cohort beigetreten*.
- **Forms in depth** ([docs/forms.md](docs/forms.md)):
  - **One question at a time** layout (keyboard, progress bar, welcome screen, smooth transitions) on one engine with the classic layout;
    **logic jumps** by answer, numeric show-if rules, **scoring and calculator fields** (own safe formula parser – no `eval` – variables,
    results by score with tag or redirect, recalculated on the server), a **payment field** through the existing Stripe buy flow
    (`form.paid`), and the field types rating, NPS, scale/slider, signature, date range, ranking and picture choice.
  - **Themes** (ten presets, system fonts, colours, background image, contrast warnings), **per-field analytics** (views, drop-off, time,
    funnel – no cookies, no IP, *Do Not Track* respected, deleted after 180 days), optional **Cloudflare Turnstile** with the sub-account's own
    keys (off by default, honeypot stays, fails closed) and a **gallery of 26 German form templates**.
  - Workflow triggers *Formular ausgewertet* (`form.scored`) and *Formular bezahlt* (`form.paid`).
- Academy tours *Kurse & Mitgliederbereich* and *Formulare & Umfragen* cover the new areas; the member and form privacy export/erase
  includes watch progress, comments and reviews; the video folder is part of the tenant export and erase.
- **Umzug, second and third wave – 17 more importers, 24 in all** (`docs/umzug.md`): **systeme.io, Klaviyo, Brevo, KlickTipp, ManyChat, Zendesk, Intercom, Salesforce, Zoho CRM,
  monday.com, ClickUp, Notion, Airtable, Typeform, Calendly, Lexware Office (lexoffice) and sevDesk**, each through the tool's public API with a key entered in the
  UI only (sealed like every secret, never logged, never part of a hint), rate-limit handling (`Retry-After`, `X-RateLimit-Reset`, GraphQL complexity errors,
  Airtable's 30 seconds), pagination, preview with counts, dry run, an automatic field mapping, idempotent re-runs (external ids), progress, pause and resume, undo, and a
  German "Wechsel von …" guide per tool (what moves, what does not, how to get the key, why switch). The wizard, the MCP tools and the tests read one registry
  (`SOURCE_LABELS` in `umzug-core.ts`); a new source is one file plus two lines.
  - **Consent ledger:** sources that know more than "subscribed" write one ledger line per channel – a confirmed double opt-in is *granted* (dated), "subscribed" without proof
    is *legacy* (with the source named), unsubscribed, bounced, blocked and complained are *revoked*, "never opted in" and the CRM/support/accounting/form tools that know no
    advertising consent are *declined*; a pending opt-in writes nothing. Export files of these sources write it too. Nothing is sent and no workflow starts.
  - **Helpdesk and conversations:** Zendesk and Intercom tickets / conversations with every comment, in their original time, as tickets (no SLA timers, no mail) and as inbox
    history (nothing sent, nothing unread); help-center articles as knowledge-base **drafts**; internal notes as notes.
  - **Projects, wiki and tables:** monday.com boards, ClickUp lists and Notion databases with a status become **projects** with the old statuses, sections, project fields,
    tasks, subtasks, checklists and comments (assignees matched by e-mail); monday docs, ClickUp Docs and Notion pages become **wiki pages** with their hierarchy; Notion databases and
    Airtable tables become **custom objects** with typed properties, records and links (relations / linked records).
  - **Forms, bookings and documents:** Typeform forms (drafts) with every answer as an answer sheet and respondents as contacts; Calendly event types as **inactive calendars
    without messages** and all events as appointments; Lexware Office and sevDesk customers as contacts and companies and their invoices, credit notes and quotations as **read-only
    history entries** – no invoice of GoHigh, no number from the invoice ranges, nothing frozen or sent.
  - **Safe by construction:** imported items never send, notify or start anything; what a person changed since an import stays on a re-run; undo removes what the job created and keeps what
    people worked on since (a task with time or comments, a record with notes, a wiki page somebody edited, a calendar with other appointments) and says so. Undo now also removes
    history entries (`activities`) an import wrote.
  - **Platform:** `VendorHttp` learned `X-RateLimit-Reset` epochs, a first-retry wait (`retryBaseMs`) and "soft" limits answered with HTTP 200 (`softLimit`); `Account.secrets` stores what
    `connect()` exchanged (Zoho's refresh token) instead of the one-time code; password fields are kept exactly as typed.
- **Vertrieb à la HubSpot** ([docs/sales.md](docs/sales.md)) – one menu entry *Vertrieb* and seven modules (`server/modules/sales.ts`):
  - **Sequences** from the personal mailbox: up to 20 steps of e-mail, task, call and manual LinkedIn, waits in days, business-hours window and a
    daily limit per person (default 100, max 500, overridable per user), tokens, up to three A/B variants per mail, preview for a real contact.
    A sequence ends by itself on a **reply** (inbound event *and* a sweep of the mailbox over 14 days), a booked meeting, a deal that moves or
    closes, an unsubscribe, *Nicht stören*, a withdrawn consent or by hand. Series pass the **consent gate** and always carry the unsubscribe
    line; **Einzelkorrespondenz** needs a stored `legal_ack` (who, when) – legal note in the docs. Enrol from a contact, a list or tag, bulk or the
    workflow action; skipped people come back with a reason. Numbers count **human opens only**. Triggers `sequence.replied/finished/stopped`.
  - **Deal positions and quotes:** positions (product, quantity, discount, tax) set the deal value (net sum, locked against hand edits);
    quotes with variants, optional positions, validity, deposit or full payment on signature, and a public page `/q/<token>` where the customer
    chooses, ticks and signs – stored as a **signed contract** (reusing `contracts.ts`), a numbered estimate, then the deposit or full invoice with
    the Stripe link and later the final invoice that deducts the deposit. Triggers `quote.sent/viewed/accepted/declined/expired/paid`.
  - **Record access:** all / team / own for contacts, companies, deals, tasks and conversations, sales teams, hidden fields; one central
    `services/record-access.ts` plus a router `wrappers` hook (`core/http.ts`) – enforced in lists, get, search, dashboard, reports, exports, board
    widgets, the mobile API and the agent; off by default; keys, MCP and automations see everything (so a restricted person cannot create keys,
    webhooks, exports or imports). Leak tests for every route that returns these records.
  - **Duplicate assistant:** e-mail, phone in any notation, name at a company; merge field by field, everything linked moves along (found from the
    schema), the two conversations become one; the whole merge is **one undo entry**.
  - **Quotas and leaderboard** per person and team for a month or quarter (won value or won deals, counted by `closed_at` in the sub-account's time
    zone) with pace and weighted pipeline, visibility setting, and two living-board widgets.
  - **Meeting notes** on the deal and the hook `app.services.attachCallSummary` for the call-intelligence package (idempotent by `externalId`);
    trigger `meeting_note.added`.
  - MCP tools (`ghl_sequence_*`, `ghl_deal_lines`, `ghl_deal_set_lines`, `ghl_quote_*`, `ghl_contact_duplicates`, `ghl_quota_*`,
    `ghl_leaderboard`, `ghl_deal_meeting_note`, `ghl_sales_access`), REST docs, three Akademie tours, isolation seeds for every new table.
  - UI: lazy `Vertrieb` page with tabs, positions/quotes/notes in the deal drawer, sequence box and duplicate hint on the contact page.

### Changed
- **Recorded calls now announce the recording by default** (*Hinweis vor der Aufzeichnung*, on whenever call recording is on; switch it off or reword it under *Einstellungen → Telefonie → Aufzeichnung*). Click-to-call, the browser phone and the power dialer play it to the called person, inbound calls to the caller. Without recording nothing changes.
- `modules/funnels.ts` no longer holds the block code (moved to `services/site-*.ts`, blocks register through `siteBlocks`); public pages are rendered with minified inline CSS,
  design-token custom properties, a single `<main>` and the page language in `<html lang>`. Existing sites render as before (old colour, font, `<head>` code and footer text keep working).
- The page editor, design, collections, redirects, statistics, accessibility check and template gallery are lazy chunks (`web/src/pages/site/*`); the first download does not grow.
- The member area's content security policy allows scripts from its own origin on the pages that carry the course player or the app
  helper (other member pages stay script-free).
- `PGHL_FORMS_PER_MINUTE` makes the public form rate limit (20 per minute and address) adjustable.
- **Form pages are small again** ([docs/forms.md](docs/forms.md#the-browser-side-of-a-form-base-plus-parts)): the script and stylesheet of a public form are no longer
  one block of ~30 kB. A classic form gets a small base (answers, validation, submit), and every feature – pages and jumps, show-if, one question at a time,
  calculators, the ending, rating/NPS/slider, signature, ranking, date range, file upload, Turnstile, analytics, the abandoned-form capture – is a part of its
  own that the page carries only when the form uses it; the CSS is split per field type and layout and scoped by class instead of by form id. Everything is
  **minified at build time** (`npm run build` ends with `scripts/build-form-runtime.mjs`; esbuild is now a declared dev dependency; the server reads
  `dist-server/server/assets/forms/runtime.json`, so production images need no dev dependency). The contact page of a site made from the *coach* template went from
  44.7 kB (13.5 kB gzip, 21 kB script, 18 kB CSS) to 22 kB (7.5 kB gzip, 6.5 kB script, 10.4 kB CSS) – `tests/site-perf.test.ts` is green again with unchanged budgets.
  The page only reports half-typed e-mail/phone to the server while an active workflow *Formular abgebrochen* listens (the server stored nothing otherwise).
  Behaviour is otherwise the same (checked in a real browser, `tests/form-browser.test.ts`, opt in with `PGHL_BROWSER_TESTS=1`).

### Fixed
- **Forms: hidden things stay hidden.** The `hidden` attribute lost against `display:flex` / the page's button rule, so a *Zurück* button showed on a form with a single
  screen and on the first screen of a multi-page form, the progress bar stayed visible next to the welcome screen and after sending. One rule (`.pf [hidden]`)
  fixes it, and a form with one screen no longer writes the back button and the empty captcha box into the page (the form is 4 px shorter than before).

## [0.0.39] – 2026-10-05

### Added
- **iPhone, iPad and foldables: an excellent installable web app** (no native iOS app – [docs/ios-web-app.md](docs/ios-web-app.md)):
  - **Install and look:** home-screen meta, touch icons (120/152/167/180/1024) and **launch images for every current iPhone, iPad and
    foldable screen in light and dark** (including the **iPhone Duo**, folded and unfolded – third-party viewport figures, nothing depends on them),
    written into `index.html` at build time from one device table (`server/services/pwa-devices.ts`); the manifest (`id`, `scope`,
    `display: standalone`, `orientation: any`, maskable icon) and the pictures follow the agency's **white-label name, colour and logo**
    (`/pwa/icon/*`, `/pwa/splash/*`, drawn on the server, stock icons unchanged without branding).
  - **Install guide:** a friendly "Zum Home-Bildschirm hinzufügen" sheet with the Share icon drawn out, on iPhone and iPad in a browser only,
    remembered per person (later = 2 weeks, then 2 months, then never), never inside the installed or the Android app; the same guide in
    *Einstellungen → Mein Konto → iPhone & iPad*. Academy tour *iPhone & iPad: GoHigh als App*.
  - **Push on iOS 16.4+:** an explicit **Mitteilungen aktivieren** flow (install first → tap → allowed / blocked with the iOS setting named /
    reconnect), the permission asked from the tap itself; the service worker re-subscribes on `pushsubscriptionchange`, opens only paths
    inside `/app` and falls back to a new window when an old one cannot be focused. **Badge:** the unread count on the app icon (Badging API) from
    the app (`GET /api/app-badge`) and from a `badge` number in every push message.
  - **Native feel:** `viewport-fit=cover` with safe areas on header, bars, drawer, dialogs and floating buttons, `dvh` next to every `vh`,
    16 px fields on touch screens (pinch zoom stays), 44 px targets, no sticky hover, no page bounce, **pull-to-refresh** in the installed app,
    keyboard-aware layout (`visualViewport`), a **bottom bar** under 600 px, share sheet for invoices and exports, a guard against files
    replacing the app when dropped outside an upload area, `navigator.storage.persist()`, a smaller offline answer cache (80 entries), a
    proper offline page and safe-area padding in the boot guard's fallback page.
  - **iPad and foldables:** layout by width only – compact (< 600 px: Slide Over, 1/3 Split View, Duo folded), medium (sidebar rail, **list + record
    side by side from 720 px** for the inbox, contacts and tasks, deals as a drawer) and expanded; **fold and unfold keep route, scroll position, open
    dialog and menu, typed text, selection and focus** (checked in `npm run ios:shots`); defensive support for the Viewport Segments API.
    Hardware keyboard: **⌘N** (the page's main action) and **⌘/** (all shortcuts; holding ⌘ shows the short list) next to ⌘K, ⌘B, ⌘Z.
  - Tests: `tests/ios-pwa.test.ts`, `tests/ios-logic.test.ts`, `tests/service-worker-ios.test.ts`; `npm run ios:shots` renders iPhone/iPad/Duo
    screenshots (light and dark) in headless Chromium and runs the fold/unfold check.
- **Hosted cloud version** (`PGHL_CLOUD_MODE=1`, off by default; docs: [docs/cloud.md](docs/cloud.md)) – sign up, pay and work immediately on the operator's instance:
  - **Tenancy decision:** every customer is a sub-account (the isolation agencies and the SaaS mode already rely on) with a thin tenant layer on top – no database or process per customer. Billing reuses the SaaS subscription rows, statuses, usage gate and read-only mode.
  - **Public pages:** `/cloud` (Solo 49 €, Team 79 €, Agentur 299 € incl. white-label; monthly or yearly with a configurable discount; every feature in every plan, no fee per user; self-hosted 0 € link) and `/start` (company, plan, e-mail verification, password or Sign in with Google, optional coupon, versioned acceptance of AGB, AVV and Datenschutz). Both are cookie-free; protection without a captcha: honeypot, signed minimum fill time, per-address and per-e-mail rate limits, optional disposable-domain blocklist, no account enumeration.
  - **Billing:** Stripe Checkout with a trial (card optional or required, 14 days by default), Stripe Tax and tax-ID collection, promotion codes, webhooks for checkout, invoices, subscription changes and trial ending, customer portal, plan changes with proration, invoices in the app, cancellation with a reason. Dunning: failed payment, banner and e-mails, grace period, read-only, export offered and deletion scheduled, hard delete (all times configurable).
  - **Provisioning in seconds:** tenant, sub-account, owner login, starter pipeline and templates (or a snapshot), welcome e-mail, onboarding checklist, optional `<name>.<cloud-domain>` login address. Agentur: white-label, client sub-accounts, custom domains.
  - **Fair use, no feature locks:** Solo 1 user, Team and Agentur unlimited; operator-set limits for e-mails, SMS pass-through, AI calls and media storage, shown as meters in the customer's account; per metric block or bill at cost plus markup.
  - **Operator console** (*Agentur → Cloud*): MRR, ARR, churn, trial conversion, customers with filters and CSV, extend a trial, comp a plan, change a plan, open an account only while the customer allows it (logged in the customer's own audit log), delete; settings for prices, trial, fair use, dunning, Stripe, signup protection, domain and mail; editable AGB, AVV, Datenschutz and Impressum templates with versions (templates, not legal advice).
  - **Customer self-service** (*Einstellungen → Cloud-Konto*): plan and invoices, team, clients and white-label, data export as ZIP (JSON and CSV per table plus files, no secrets), support-access consent, AVV as PDF, delete account with a scheduled hard delete that removes every row, file and login.
  - **Isolation:** the attack harness in `tests/security-fixtures.ts` also fires at a second tenant and at the operator; operator admins are hidden from tenants' people lists and cannot open a tenant's sub-accounts without consent.
  - Small seams in shared code only: `app.services.saasEventTaps`, `cloudCompleteSignup`, `hideUser`/`hiddenUser()`, `hiddenLocations`/`visibleLocations()` (the operator's sub-account lists skip customers not open for support), `GET /api/version` → `cloud`. Akademie tours *Cloud-Betrieb* and *Dein Cloud-Konto*.
- **Rechnung 2.0 – GoBD, Storno, XRechnung, PDF** (Umsatz → Rechnungen, docs: [docs/invoicing.md](docs/invoicing.md)):
  - **Festschreiben:** an explicit state machine (*Entwurf → offen → teilweise bezahlt → bezahlt*, *storniert*, *verworfen*) with 409 for every illegal change. Finalising gives the **gap-free number** (atomic counter per range, safe under parallel requests), fixes the date and stores a **snapshot with SHA-256**; from then on lines, amounts, customer, tax treatment, number and date are frozen – by the API (409 naming the field) and by database triggers. Note, due date and payment link stay editable and are logged. Drafts have no number and can be deleted; finalised invoices cannot. Append-only **audit trail**, *Prüfsumme prüfen*, a pre-check dialog (errors block, warnings inform; optional strict mode).
  - **Nummernkreise** for invoices (`RE-`), credit notes (`GS-`), Stornos (`ST-`) and quotes (`AN-`): prefix, year in the number, yearly restart, digits, forward-only next number (*Einstellungen → Rechnungen*).
  - **Storno and credit notes:** *Stornieren* creates a Stornorechnung with its own number, a reference to the original and negated amounts; *Gutschrift* for parts (capped at the invoice). Both are booked **reversed** in the bookkeeping; symmetric rounding makes a Storno negate the invoice to the cent.
  - **Invoice fields:** Leistungsdatum or period, **Reverse Charge / innergemeinschaftliche Lieferung / Ausfuhr / § 19 / steuerfrei** with the mandatory note text, buyer **USt-IdNr.** (format and check digit, optional **VIES** lookup behind a setting), **Leitweg-ID**, buyer reference, **Skonto**, **Abschlags- und Schlussrechnung** (deducts finalised partial invoices), **Angebot → Rechnung** with a reference, units per line. VAT is rounded once per rate (EN 16931); old invoices keep their old rounding.
  - **Partial payments** (`invoice_payments`, with reversal instead of deletion), per-payment ledger entries, dunning and Stripe read the **open amount**.
  - **XRechnung 3.0 (EN 16931)** as **CII and UBL 2.1** (type codes 380, 381, 326; categories S, Z, E, AE, K, G with VATEX codes; structured Skonto; prepaid amount), checked by an **own rule validator** (mandatory terms, BR-CO-10…17, VAT breakdown, code lists, BR-DE) before any file is handed out; download buttons, *E-Rechnung prüfen*, optional attachment to the invoice mail, **immutable archive** (the receipt archive, SHA-256, retention note until the end of the issue year + 8). Fixtures for standard, reverse charge, § 19, credit note and final invoice.
  - **Invoice PDF on the server** (DIN 5008 Form B window, lines, VAT breakdown, terms, bank data, logo, Entwurf/Bezahlt/Storniert marks, multi-page) with a **GiroCode** (EPC069-12) – attached to the invoice mail, downloadable, also on the customer page `/i/<token>/pdf`, `/xml`.
  - **UI:** lock banner, *Festschreiben*, *Senden*, *Zahlung erfassen*, *Gutschrift*, *Stornieren*, *In Rechnung umwandeln* (every dialog with ✕ and Esc), state badges, new tab *Gutschriften*, legal fields card, documents and audit boxes, new *Rechnungen* settings (sender data, bank, tax defaults, checks, number ranges); Akademie tour *Rechnungen & Angebote* extended.
  - **MCP:** `ghl_invoice_finalise`, `ghl_invoice_cancel`, `ghl_invoice_credit_note`, `ghl_invoice_record_payment`, `ghl_invoice_xrechnung`, `ghl_quote_to_invoice`. Events `invoice.finalised`, `invoice.partially_paid`, `invoice.cancelled`.

### Changed
- The shell breakpoint moved from 860 px to 600 px: below 600 px the menu is a drawer with a bottom bar, from 600 px the sidebar stays as an icon rail
  (from 1024 px as before). The conversation list and a conversation are one pane at a time under 720 px.
- The old install card for iOS in `pwa.tsx` is replaced by the guided sheet; Chrome/Edge/Android keep the install prompt card.
- The settings page for notifications shows the next step instead of a checkbox until notifications are on.
- Existing sent, paid and cancelled invoices are **finalised by the update** (snapshot of what they printed, SHA-256, audit entry); counters continue after the highest issued number; drafts lose their number until they are finalised. Status changes that other modules make with raw SQL are adopted within 30 seconds. **Setting an invoice to `sent` or `paid` through the API finalises it** and `void` on a finalised invoice creates a Stornorechnung (409 instead of a silent flag where that is not allowed).
- `GET /api/invoices` rows carry `state`, `doc_title`, `open_cents`, `locked`; `number` is empty for drafts.

### Not included (next steps)
- **ZUGFeRD / PDF/A-3** (PDF with the XML embedded) – needs a PDF/A-capable library or sidecar; XRechnung (CII/UBL) is available now.
- The official KoSIT validator and transport via Peppol or the federal portals (ZRE/OZG-RE); see [docs/invoicing.md](docs/invoicing.md#limits-and-open-questions).

## [0.0.38] – 2026-10-05

### Added
- **Wissensgedächtnis (Cognee), Einstellungen → Gedächtnis / Agentur → Integrationen → Einrichtung:** connects a self-hosted [Cognee](https://github.com/topoteretes/cognee) server (Apache-2.0, REST API, written against 1.6.2) as a knowledge-graph memory, with strict data governance. **Connection (agency):** address, login with e-mail + password or API key (sealed at rest, never returned), *Verbindung testen* (health, access control, login, datasets), all sub-accounts at a glance, optional own Cognee login per sub-account. **Governance:** opt-in per sub-account (default off) and per data type – wiki & documents (default), notes, tickets/helpdesk/knowledge base, course content, conversations, contacts, remembered notes – with warnings on personal types; one dataset per sub-account and type (`gh_<locationId>_<type>`), bound to the sub-account in code (a foreign dataset is refused before a request exists) and covered by the tenant isolation harness; redaction of e-mail addresses, phone numbers and IBANs before sending (default on for notes, tickets, conversations, contacts); erasure follows the GDPR erase (queued in the erase transaction, retried while Cognee is offline), deleted/trashed/private records and replaced versions are deleted in Cognee, *„Daten in Cognee löschen“* when a type or the sub-account is switched off, deleting a sub-account deletes its datasets; audit entries `cognee.*` with counts, never content; a status panel with sync state, counts, errors and a prominent warning when the server runs without `ENABLE_BACKEND_ACCESS_CONTROL` (detected through the API; sending is blocked until fixed). **Sync:** incremental background job (cursor per kind of record, hash check, `add` then one background `cognify`, retries with 1–60 min backoff, `Retry-After`, never inside a request). **Use:** *„Gedächtnis fragen“* with sources, MCP tool `ghl_memory_recall` (also the in-app agent's tool; compact, ≤ 4 KB, scoped to the sub-account, output treated as untrusted) and `ghl_memory_remember`. Akademie tour *Wissensgedächtnis (Cognee)*; the optional `untrusted` flag on MCP tools. [docs/cognee.md](docs/cognee.md)
- **Campaign sending speed:** each campaign has its own **Versandgeschwindigkeit** (messages per hour: standard, 50 to 5,000 or a value between 10 and 50,000) in the *Versand* card, with the **time it takes and when it is through** for the reachable recipients, and a **warm-up hint** for new senders (fewer than 1,000 e-mails delivered so far and 200 or more recipients: start slow, increase daily; yellow above 60 per hour). The speed of a running campaign can be changed – it counts from that moment. Standard stays 30 messages per 15-second tick (sub-account setting `campaigns.batch_size`, now kept between 1 and 500); a speed sends the first message at once and never more than twice the nominal batch per tick. `speed_per_hour` on `POST/PATCH /api/campaigns`, `PUT /api/campaigns/:id/speed`, `throttle` and `warmup` on `GET /api/campaigns/:id`; migration `campaigns:003-throttle`; [docs/deliverability.md](docs/deliverability.md#sending-speed-and-warm-up-campaigns).
- **Workflow error handling:** per step **„Fehler ignorieren und weiter“** (logged as ignored, the run goes on even when the workflow stops on errors); per workflow **„Bei Fehler: anderen Workflow starten“** (same contact, with `{{event.error.message}}`, `{{event.error.step}}`, `{{event.error.workflow}}`; handler runs never start handlers), a **bell** (push, new kind *Workflow-Fehler*) and/or **e-mail** notice to the team with the failing step, the message and the contact (once per run, at most 10 per workflow and hour); a stopped run can be **repeated from the failed step** (*Verlauf → Ab Fehler wiederholen*, or all stopped runs at once) without redoing the steps before it. New event `workflow.step_failed` for webhooks; snapshots remap the error workflow, imports drop it. `POST /api/workflow-runs/:id/retry`, `POST /api/workflows/:id/retry-failed`; module `workflow-errors`; [docs/workflow-actions.md](docs/workflow-actions.md#error-handling).
- **Booking polish (Calendly parity)** – per calendar: **limits per day and per week** (the day, or the whole Monday-to-Sunday week, leaves the offer once reached; cancelled appointments do not count; staff can still force a booking), **date-specific hours** (*Abweichende Tage*: a closed day for holidays or other windows on one date), **up to five reminders** such as 24 h and 1 h before, each by **e-mail and/or SMS** (SMS only with a set-up provider, a phone number and no *Nicht stören*; once per start time, none for a moment that was before the booking, only the closest when several are due), a **follow-up** after the appointment and a **no-show message** with a link to book again. Older calendars keep their single reminder. Buffer and minimum notice were already there. Editor: new *Nachfassen* tab, *Verfügbarkeit* and *Bestätigung & Erinnerung* extended. Migration `calendars:002-reminders-sent`; module `booking-extras`; [docs/booking.md](docs/booking.md).
- **KI-Antwort vorschlagen for Google reviews:** a button under every review (Bewertungen) lets the KI-Assistent write a public reply in a chosen **tone** (freundlich, herzlich, professionell, sachlich, locker), **address** (Sie/du), the company's **brand voice** (the assistant's persona and facts), own hints and a signature line. The text lands as an **editable draft** ("KI-Entwurf – bitte prüfen"); only *Öffentlich antworten* posts it – without a connected business profile the draft is copied and pasted at Google. Optional **auto-draft for new reviews** (off by default; a draft only, never posted). Counts on the AI monthly limit (purpose *Bewertungsantwort*), at most 60 per hour and sub-account; the review text is treated as data (prompt-injection safe). `GET/PUT /api/google-reviews/reply-settings`, `POST /api/google-reviews/:id/suggest-reply`, `PUT/DELETE …/reply-draft`, MCP `ghl_suggest_review_reply`; module `review-replies`, migrations `google-reviews:003-reply-drafts`, `review-replies:001-init`.
- **QR codes for share links:** a small *QR-Code* button next to the booking page link, the Google review link (Einstellungen → Bewertungen and Bewertungen → Google), buy links, funnel and funnel-page links, trigger links and routing forms opens a dialog with a preview, **PNG and SVG download** (256 to 2048 px, own colour with a scan-contrast warning, robust error correction for stickers) and a **print sheet** (heading, large code, text, link; prints only the sheet). `GET /api/qr?url=…&format=png|svg&size&fg&bg&ec&margin&download&name` (signed-in users, only http(s) links or paths of this server, limits checked); module `qr`.
- **Deals like in HubSpot:** every deal has an **expected close date**, a **currency** (EUR, USD, CHF, GBP or any ISO code; amounts are never converted – the Kanban shows one sum per currency) and, when it is lost, a **required loss reason** chosen from a list per pipeline (*Pipeline bearbeiten → Verlustgründe*, default list when empty) or typed in. Cards show the close date (red when overdue) and the reason. Reports: new fields *Erwarteter Abschluss*, *Verlustgrund*, *Währung*, *Abschluss überfällig*, *Tage bis erwarteter Abschluss* and the measure *Verlorener Umsatz*; the Vertrieb dashboard gets *Prognose je erwartetem Abschlussmonat* and *Verlorene Deals nach Grund*, Living Boards the presets `forecast_by_close_month` and `lost_reasons`. MCP `ghl_create_opportunity` / `ghl_update_opportunity` / `ghl_list_opportunities`, REST hooks, workflow steps (reason field, falls back to "Per Automation") and the mobile API carry the new fields. Migration `pipelines:002-deal-close-fields`.
- **Einwilligung & Recht – provable consent and the German/EU must-haves** (*Einstellungen → Einwilligung & Recht*, docs: [docs/consent.md](docs/consent.md); templates and defaults, **not legal advice**):
  - **Consent ledger:** append-only events per contact × channel (e-mail, SMS, WhatsApp, phone, tracking) × purpose with source, time, IP network (/24 or /48 only), user-agent hash, the **versioned consent text** and a proof link; derived status *unknown / pending / confirmed / revoked* (legacy contacts without history stay usable under the default rule); *Nicht stören* counts as revoked and still works. New contact tab *Einwilligung* with history, manual record/withdrawal and PDF/CSV export; the proof is part of the DSGVO export; MCP tool `ghl_contact_consent`.
  - **Double opt-in** for forms, funnels, webinar registration, community sign-up, imports and the API – per sub-account and per form: HMAC-signed link on a confirm page (only the button confirms, scanners do not), reminder after *X* hours, expiry, own mail and page texts, timeline entries, workflow triggers `consent.confirmed` and `consent.revoked`. Forms count as opt-in only with a ticked consent field. CSV import can record *Altbestand*, *Einwilligung anderweitig belegt* or ask by double opt-in.
  - **Send gate** in `sendToContact`, campaigns (skipped with a reason; the audience count shows them), workflow e-mail/SMS steps and WhatsApp marketing templates: *Bestätigte + Altbestand* (default) or *Nur bestätigte*. Service messages are exempt and marked (`messages.purpose`, `messages.consent_basis`); workflow steps get *Service-Nachricht (keine Werbung)*. **Preference centre** (`/consent/p/…`) linked from the unsubscribe footer (`%%preferences_url%%`).
  - **Cookie banner (CMP)** of our own for funnels, websites, booking, buy, community pages and portals: categories necessary/statistics/marketing/external media, script blocking by `type="text/plain"` + `data-category`, embeds behind a placeholder, unknown third-party scripts blocked, **Google Consent Mode v2**, consent log (3 years), re-open button and `#cookie-settings` links, texts/colours/layout with live preview; replaces the attribution hint (one banner only) and the visitor cookie follows the choice. New core hook `app.services.htmlTransforms`.
  - **Legal text generators:** Impressum, Datenschutzerklärung (names only the modules and trackers in use), Widerrufsbelehrung, AVV and VVT drafts as PDF/HTML/Markdown/text with "keine Rechtsberatung – bitte prüfen", gaps marked `[bitte ergänzen: …]`, hosted copies at `/legal/<sub-account>/…`, prefilled legal pages for new websites and *In eine Website übernehmen*, optional eRecht24 placeholder (nothing is called). `app.services.legalTexts` for other modules.
  - **Checkout law (DE):** button "zahlungspflichtig bestellen" (§ 312j BGB) instead of "Jetzt kaufen", required AGB box, withdrawal link, waiver checkbox for digital content/services with wording, version, time and IP network stored with the order, VAT notes, confirmation mail.
  - Akademie tour *Einwilligung & Recht*; tests for the ledger, double opt-in, gate, proof export, banner blocking, Consent Mode, legal generation, checkout and tenant isolation.

### Changed
- The buy-page button reads "zahlungspflichtig bestellen" by default (set under *Einwilligung & Recht → Checkout*).
- Preference-centre links in mails are not routed through click tracking; the webinar docs no longer say "no double opt-in" (it is optional now).
- The first mail of the *Neuer Lead* workflow recipe is a service message; the follow-up is advertising and goes through the send rule.

## [0.0.37] – 2026-10-05

### Added
- **KI-Anbieter: 21 more presets** – every one checked against the provider's documentation and a live request (October 2026, `verified` on the preset): Requesty, Vercel AI Gateway, Cloudflare (Workers AI / AI Gateway), Nebius Token Factory, Novita AI, Hyperbolic, SambaNova Cloud, Featherless, Venice, Moonshot (Kimi), Zhipu GLM (Z.ai), Alibaba Qwen (Model Studio), MiniMax, Cohere (compatibility API), AI21 (Jamba), **kie.ai as a chat provider** (its Anthropic-compatible endpoint with Claude models) and the **EU providers IONOS AI Model Hub, STACKIT AI Model Serving, OVHcloud AI Endpoints, Scaleway Generative APIs and Mistral AI's EU endpoint**. Skipped: Lambda (Inference API winding down). OpenRouter and Mistral re-verified; OpenRouter now also sends `X-OpenRouter-Title`.
- **Provider gallery** (Einstellungen → KI-Anbieter): search, filters *EU-Hosting*, *günstig*, *schnell*, *lokal*, *Abo-Anmeldung* and the kind of provider; an **EU-Hosting badge** with the provider's own statement and its source (only where the documentation names the place of processing); "Konto anlegen ↗" partner links for every new provider; **Modelle & Preise**: the live model list with search, context size, vision/tool flags and **prices per million tokens** where the provider's list has them (OpenRouter, Vercel, Requesty, Novita, Venice, SambaNova, OVHcloud, Featherless) – also used for the cost estimate; the connection test no longer fails for providers without a model list. Large hit targets (44 px, 60 px in spatial mode).
- **Mit ChatGPT anmelden** – OpenAI's official "Sign in with ChatGPT" for open-source apps as a **personal** connection: PKCE and dynamic client registration, the 127.0.0.1 redirect pasted back (a web server cannot receive it), ID-token verification, tokens sealed per user, serialized automatic refresh with rotation, plan and expiry on the card, disconnect with revocation at OpenAI. Usable only by the owner's own browser session for their own agent chats (model "Mein ChatGPT-Abo"), assistant actions and Werkstatt builds (the model gate applies) – never by other users, the agency admin, API keys, MCP or app tokens, custom agents, workflows, schedules, auto-replies or background jobs. Agency off switch, **off by default on a hosted service** (`PGHL_HOSTED=1`) until the operator has OpenAI's approval (`PGHL_CHATGPT_SIGNIN_APPROVED=1`), `PGHL_SUBSCRIPTION_SIGNIN=off`. Audit entries `ai.subscription.*` without any token. New wire `responses` (OpenAI Responses API, `store: false`, streaming, namespaced tools).
- **Mit Claude verbinden** – no OAuth sign-in, because Anthropic does not allow third-party apps to offer Claude.ai login or to route requests through Free/Pro/Max credentials. Instead the **local bridge** (Claude Code on your own computer) got a polished dialog: one copyable command (macOS/Linux and Windows) that downloads, pairs and starts it, a pairing code with **QR code** and countdown, **live status** (connected, last seen, version), the **model per computer** (passed as `--model`/`-m`), clear limits (only while the computer is on, personal use only), reconnect with back-off and while an admin has switched it off. The **Codex CLI** has the same dialog for ChatGPT. The Anthropic API key (Console) is the second way.
- MCP tool `ghl_ai_providers` (providers with EU/price/speed tags, connections without keys, routing, sign-in availability); API `/api/ai-subscriptions/*`; docs: provider tables with sources, EU list, subscription sign-in with the legal position and sources in [docs/ai-providers.md](docs/ai-providers.md).
- **Community, Skool level and beyond (menu *Seiten → Community*, docs: [docs/community.md](docs/community.md)):**
  - **Public page and joining:** `/c/<name>` with cover or video, About text, search tags and up to three join questions; free or
    paid tiers (monthly, yearly, one-off, free trial days, grace period) backed by Stripe products, approval queue, invite links
    (`/c/<name>/i/<code>`, optionally skipping approval), discount codes, the opt-in directory `/communities`
    (`PGHL_COMMUNITY_DISCOVERY=0` switches it off), a new access mode *Beitritt über die Community-Seite*. Memberships run through
    request, approval, payment, trial, active, past due and ended.
  - **Members:** polls, video (link or chunked upload up to `PGHL_COMMUNITY_VIDEO_MB`, default 500 MB) and GIFs in posts, filter
    chips, direct messages (member to member and to the team, limits, block, report, team inbox), directory with online dots, member
    map without a map service, activity heatmap, richer profiles, roles *Admin* and *Moderator* with tools in the member area.
  - **Engagement:** rule-based and manual badges (with preview and bonus points), perks that unlock at a level (code, file up to
    8 MB, link, text), level- or tier-locked channels, a monthly leaderboard with a hall-of-fame archive, manual points, **challenges**
    (daily check-ins, streaks, board, reminders, badge and points), **live calls** on Jitsi Meet (`PGHL_JITSI_URL`) with attendance,
    points and the recording as a post.
  - **Growth:** numbers (members, MRR/ARR, churn, trial conversion, daily actives, top contributors, per group and overall), welcome
    message, welcome post, onboarding checklist and *Start here*, member segments with broadcasts by e-mail, bell and push (also
    scheduled), partner programme through the affiliates.
  - **Installable member app (PWA):** manifest, icons, offline page and service worker per client (name, colour and logo from the
    agency branding), install banner, Web Push for messages, mentions, replies, announcements, challenges and (opt-in) new posts.
  - **Import and export:** members from CSV with a dry run (column mapping, date order, tier mapping, quiet by default, rights
    confirmation), posts from Markdown files, member CSV and post JSON export, and a moving guide from Skool in the docs.
  - **Automation:** 9 new workflow triggers (member left, trial started, trial converted, join requested, challenge joined, challenge
    completed, badge earned, message received, live call attended), 4 new steps (grant a badge, send a message as the team, give
    points, post as the team); the steps *In Community aufnehmen* / *Aus Community entfernen* now work with memberships; contact
    filters `community_group`, `community_min_level`, `community_active_days`, `community_inactive_days`; MCP tools
    `ghl_community_members`, `ghl_community_post`, `ghl_community_stats`, `ghl_community_grant`; mobile endpoints
    `/api/mobile/community*` (requests, reports, messages, post as the team); Akademie tour *Community* extended; all routes in
    [docs/api.md](docs/api.md#community).
- **E-Mail-Tracking, dem man trauen kann:** every pixel load and link click is recorded as an event (`email_events`) and judged **human / proxy / scanner** with a reason – Apple Mail Privacy Protection (bare `Mozilla/5.0` or Apple's range), Gmail / Yahoo image proxies, security gateways and bots by User-Agent, `HEAD` requests, prefetch headers, an open within 5 s or a click within 10 s of sending, several different links within 2 s, clicks without browser headers. Only people count: `opened_at`, `clicked_at` and the counters, reports, lead score, health score, the activity log and the `email.opened` / `email.clicked` triggers; machines only raise the new `machine_open_count` / `machine_click_count` (and `tracked_links.machine_clicks`). A machine click still redirects, `HEAD` is answered like `GET`. Clicks are held for 2.5 s so a scanner's burst is recognised before a workflow can start. Campaign report, conversation and contact show the people's numbers plus a muted **"+N maschinell"** with an explanation (campaign report: reasons listed); reports gain *Maschinell geöffnet*. Stored per hit: the network of the address (IPv4 /24, IPv6 /48), a device class and a short hash of the User-Agent – never the address or the header; 400 days, capped per mail, part of the GDPR export and erasure. [docs/email-tracking.md](docs/email-tracking.md)
- **Verfolgen von Mail aus dem eigenen Postfach (opt-in):** *Öffnungen und Klicks verfolgen* per connected mailbox (off by default, hint about consent for 1:1 mail), a per-mail switch in the reply composer, audit entry `mailbox.tracking`; goes through the `instrumentEmail` hook (new mail, replies, scheduled sends; not drafts).
- **Zählpixel abschaltbar:** *Einstellungen → E-Mail & SMS → Öffnungen messen* (`settings.email.track_opens`, default on) – off inserts no pixel and keeps click tracking.

### Changed
- Model ids may start with `@` (Cloudflare's `@cf/…`). Providers in the group "Lokal & Proxy" (LiteLLM) count as *lokal* in the gallery filter. The chat and the quick-text provider accept a person's own connection (`aiProvider(locationId, purpose, userId)`), the Werkstatt's model gate checks the model that will really serve the person's build.
- The bridge script is version 1.1.0 (`--model`, `status` checks the connection, 403 from an admin switch no longer ends it).
- `opened_at`, `open_count`, `clicked_at`, `click_count` and `tracked_links.clicks` now count people only (columns and names unchanged). Numbers from before the update are not corrected; the old counters had no judgement attached. A click within 10 s of sending counts as a scanner – wait a moment when you test with yourself.

## [0.0.36] – 2026-10-05

### Added
- **Ratenzahlung (Umsatz → Ratenzahlung):** payment plans on one-time products (2–60 instalments, weekly or monthly, optional different first payment). The buy page offers lump sum or plan; Stripe collects the instalments as a subscription that ends by itself after the last one; each instalment is booked as a paid invoice; access follows the payments and is paused, revoked or kept on a default. Purchases with progress, pause the access, end the plan. Triggers `payment_plan.completed` / `payment_plan.defaulted`, MCP tools, mobile list. [docs/payment-plans.md](docs/payment-plans.md)
- **Mahnwesen (Umsatz → Mahnwesen):** failed subscription and instalment payments open a case with reminders and a link to a hosted **billing page** (`/abo/<link>`: update the card, invoices, pause, cancel, switch plan – as far as each product allows), Stripe Smart Retries or own retry days, access pause and recovery. Overdue invoices get Zahlungserinnerung, 1. and 2. Mahnung with fees and default interest (§ 288 BGB) and a PDF – off by default, with approval or automatic, hold per invoice. Triggers `dunning.started`, `dunning.final_failed`, `dunning.recovered`, `invoice.dunning_sent`; actions *Karten-Update-Link senden* and *Mahnung zur Rechnung senden*; MCP tools, mobile list. [docs/dunning.md](docs/dunning.md)
- **Quiz, Aufgaben und Zertifikate (Seiten → Quiz & Zertifikate):** quizzes as a lesson type (auto-graded, manual review of short answers, attempts, gate), assignments with text and private file hand-in and a review queue, certificates as server-made PDF with a public verification page; member-area pages, triggers `quiz.passed`, `quiz.failed`, `assignment.submitted`, `assignment.reviewed`, `certificate.issued`, action *Zertifikat ausstellen*, MCP tools, mobile review list. [docs/quizzes-certificates.md](docs/quizzes-certificates.md)
- **Kommentar-zu-DM (Marketing → Kommentar-zu-DM):** Instagram and Facebook comment keywords (and Instagram story replies) trigger a rotating public reply, one private reply with link and buttons, a contact, tags and a workflow; hourly limits per rule and account; trigger `igcomment.matched`; workflow action *Nachricht mit Buttons senden* for Instagram, Messenger and WhatsApp; MCP tool `ghl_ig_comment_rules`. [docs/comment-to-dm.md](docs/comment-to-dm.md)
- **KI-Workflow-Builder (Automationen → Mit KI erstellen / ändern):** a plain-language description becomes a workflow; the AI works from the live catalogue and the sub-account's ids, the answer is checked against the catalogue (up to three attempts), the dialog shows a diff and saves a **draft only** – never published. New AI-provider use **Workflows** for routing the builder to its own connection; MCP tool `ghl_workflow_generate`. [docs/workflow-ai.md](docs/workflow-ai.md)
- Akademie tours for all five features; mobile read endpoints `/api/mobile/creator/*`; hooks `stripeTaps`, `lessonGates`, `lessonExtras`, `lessonCompleteBlock`, `metaKit` (see [docs/architecture.md](docs/architecture.md)).
- **Team-Posteingang (Konversationen):** assignee (person or helpdesk team), status (open / waiting / done), snooze until a time
  (auto-reopen on time and on a new inbound message) and priority per conversation; views with live counts (mine, unassigned,
  team, waiting, snoozed, SLA at risk, mentions, done), bulk assign / close / snooze, keyboard shortcuts (J K E A S N R X / ?).
  Automatic assignment (manual, round robin, least busy; pool = everybody, a team or chosen people; rules by channel and tag;
  contact owner first; skips people who are paused, away, outside their hours or on approved HR leave), shared availability and
  out-of-office entries (`/api/team-people`), internal notes with @mentions (app, push, e-mail; never sent to the contact), live
  "Anna is typing…" warnings (server-sent events), first / next response deadlines in business hours with warning and breach
  highlighting, auto-close after N days. Workflow triggers `conversation.assigned`, `conversation.status_changed`,
  `conversation.sla_breached` and steps *Konversation zuweisen*, *Status setzen*, *Interne Notiz*; report sources
  *Team-Posteingang: Konversationen / Antworten* (response times, volume per person, SLA rate); MCP tools `ghl_inbox_queue`,
  `ghl_inbox_assign`, `ghl_inbox_set_status`, `ghl_inbox_note`; app endpoints under `/api/mobile/inbox` and
  `/api/mobile/conversations/:id/(team|assign|status|notes)`. Settings under *Einstellungen → Team-Posteingang*.
- **Team-Kalender:** calendar types round robin (even / weighted, maximum availability / equal distribution, respects members'
  own appointments, absences, hours and Google / Outlook busy times), collective (all hosts) and classes (seats, waiting list);
  booking-page questions (text, choice, checkbox, required, stored with the appointment); **pay at booking** with Stripe (full
  price or deposit; the slot is held, the appointment and a paid invoice exist only after the payment; late payments are
  refunded when the slot is gone; cancellation refunds automatic or manual); automatic **video links** (Google Meet and
  Microsoft Teams through the host's connected calendar, Zoom through the connector, or a fixed place); reschedule and cancel
  links with cutoffs and policy text; **routing forms** ("Wobei können wir helfen?" → calendar, the answer is stored with the
  booking); the round-robin host in the appointment payload and in e-mail variables; assigned appointments sync only to the
  host's calendar. MCP tools `ghl_calendar_types`, `ghl_book_slot`; app appointments carry `meeting_url` and `host_id`.
  Docs: [team-inbox.md](docs/team-inbox.md), [team-calendars.md](docs/team-calendars.md).
- **XR: Raum-Modus, Arbeitsfläche and boards in the headset** ([docs/xr.md](docs/xr.md)) – GoHigh is now built for Apple Vision Pro, Meta Quest,
  Android XR and display glasses (Xreal, Viture):
  - **Raum-Modus** (*Einstellungen → Darstellung*, preference `spatial`: *Automatisch* / *An* / *Aus*): a spatial UI mode as theme tokens and one stylesheet
    that loads only while it is on (`<html data-spatial="1">`): 60 px hit targets, roomy spacing, a larger type scale (also for pages that
    declare their own small text), a soft glow on gaze (hover) and `:focus-visible`, no hover-only actions, *Verschieben nach …* next to the
    drag handles (pipeline, tickets, planner board, board widgets), translucent glass whose text contrast is checked in every theme (AA, also
    over pure black and white; the Kontrast theme keeps 7:1), `prefers-reduced-motion` and `prefers-contrast`. Automatic on a detected
    Quest, Vision Pro, Android XR, Pico or Wolvic browser; auto-suggestion never fires on a desktop that merely has WebXR.
  - **Arbeitsfläche** (menu): 2–4 pages side by side for 21:9 / 32:9 (Inbox | Kontakt | Board | Agent by default), resizable splitters with keyboard
    support, any page in any panel, links open in the panel that already shows that kind of page, a pick in the inbox or pipeline updates the
    contact panel, saved per person (`/api/xr/workspace`), single-page navigation below 1000 px.
  - **In XR öffnen** on boards and canvases: WebXR `immersive-vr` / `immersive-ar` with an in-house WebGL2 renderer (no 3D library, lazy chunk of
    ≈ 18 KB gzip), widgets as floating panels on a curved wall, a canvas as a large plane, grab and move with controllers, hands or the
    mouse (saved per person: `/api/boards/:id/xr-layout`, `/api/canvas/:id/xr-layout`), live over the realtime streams, push-to-talk to the
    board prompt, a 3D preview with mouse orbit where there is no WebXR. Widget views are drawn by a simplified 2D renderer (numbers, lists,
    tables, bars and lines, notes) – embedded pages, plugin frames and quick actions are not drawn (documented limitation).
  - Web app manifest for headsets: `display_override`, any orientation, one window, a 1024 px icon (also the large `apple-touch-icon`), a shortcut to the
    Arbeitsfläche; install hints per device in the Raum-Modus card.
  - Akademie tour *Raum-Modus und XR*, a step in *Darstellung anpassen*; tests for detection, tokens, layouts, the layout API (isolation, permissions,
    seeded in the tenant isolation harness), geometry (arc placement, picking, grabbing), painters, scene interaction and push-to-talk.

### Changed
- The Stripe webhook hands every new, verified event to registered taps first (payment plans, dunning); the member portal lets modules lock lessons and add content after the lesson text; the Meta webhook hooks get the signed payload and sub-account.
- Cancelling a confirmed appointment from the appointment list now goes through *Absagen…* (reason, refund of a paid
  appointment, e-mail to the contact, seat to the waiting list) instead of a bare status change.

## [0.0.35] – 2026-10-05

### Added
- **Undo, history and trash (Rückgängig, Verlauf, Papierkorb):** every change to the main records is journaled before it
  happens (a snapshot of the changed rows only, plus the rows a delete takes along): tasks – core list and project planner –,
  contacts (edit, delete, tags, bulk), companies (incl. merge), deals (stage, won/lost), pipelines, notes, appointments,
  conversations and drafts, tickets, products, invoice drafts, forms, funnels and pages, tags; workflows, wiki pages and
  canvas boards use their own version histories ("restore previous version"). `POST /api/undo/:id` restores in one
  transaction, answers **409 with a diff** when the record changed since (`force` overwrites), groups bulk actions, and every
  undo is a journal entry itself, so it can be redone. Own changes for everyone, anyone's for admins, member areas and
  sub-account isolation apply; retention is 30 days (setting `PUT /api/undo/settings`, daily cleanup); erasing a contact for
  GDPR empties its journal entries. Irreversible side effects (sent e-mail/SMS, payments, ads, automations that reacted) are
  never pretended away: the entry says what stays and only the data is reset.
- **Web:** a toast after every journaled change ("Aufgabe „…“ erledigt · Rückgängig", 8 s, pauses on hover/focus, announced to
  screen readers), **Ctrl/⌘ + Z** and Ctrl+Shift+Z outside text fields, a conflict dialog, the **Verlauf** panel (top bar and
  command palette: by day, search, filter by kind, before → after, "Wiederherstellen"), the **Papierkorb** page (restore for 30
  days with what went with a record, "endgültig löschen" and retention for admins), the **Erledigt heute** tab in Aufgaben,
  larger hit targets, Akademie tour *Rückgängig, Verlauf und Papierkorb*.
- **Agents and phones:** MCP tools `ghl_undo_list` (filter by person, API key, MCP, GoHigh Agent) and `ghl_undo`; the
  GoHigh Agent's tool cards show **Rückgängig** after a write; mobile API `GET /api/mobile/undo/recent`,
  `POST /api/mobile/undo/:id`; every journaled write answers with `x-undo-id`, `x-undo-label` and `x-undo-notice` headers.
  See [docs/undo.md](docs/undo.md).
- **Android app 1.0.2 (versionCode 3) – never blank without a word.** A native watchdog records console errors
  (`onConsoleMessage`), failed main-frame and `/assets/` requests and, 6 s after a page finished, asks the page whether
  `#root` has content (a page that never finishes is reported after 30 s). If the web app did not start, the screen
  **"Die Seite lädt nicht"** covers the page with the reason, the last errors, the WebView package and version and the
  buttons *Neu laden*, *Cache & Offline-Daten löschen*, *Im Browser öffnen* and *Diagnose senden* (a high-severity bug
  report through the existing feedback API; the share sheet when the app is not connected). A WebView older than version
  92 gets a hint with a link to its Play Store page. It disappears by itself if the app comes up after all.
  **Einstellungen → Diagnose** shows WebView, server, last load status and errors (kept across restarts) and has
  *App zurücksetzen (Web-Daten)*. See [docs/android-app.md](docs/android-app.md#wenn-die-seite-leer-bleibt-fehlersuche).
- **Web boot guard** (`web/public/boot-guard.js`, plain ES5, first script of `index.html`): buffers early `error` /
  `unhandledrejection` events, failed script and stylesheet loads and CSP violations; the app sets
  `window.__pghlMounted = true` after its first render. Not mounted after 10 s (30 s while the download is still running
  without errors): a plain HTML page replaces the empty `#root` with the error text, *Neu laden* and *Offline-Daten
  löschen* (unregisters service workers, deletes caches); a controlling service worker is cleared once automatically
  first. The buffered errors go to the automatic error capture (`/api/feedback/client-errors`, grouped as
  "[Browser] App-Start fehlgeschlagen …", opt-in as before, once per page and 10 minutes per device).
- **Umzug (menu *Umzug*, *Einstellungen → Umzug*, *Agentur → Umzug*):** switch-over importers for **Mailchimp, ActiveCampaign,
  Kit (ConvertKit), Kajabi, Teachable, Keap and Pipedrive**, through each tool's public REST API (an API key, sealed like every
  integration secret, entered in the UI only) or from export files (CSV, TSV, JSON, HTML, ZIP; Windows-1252 and UTF-8). Wizard: source →
  connect or upload → preview with counts per part, warnings, an automatic field mapping that can be changed (new custom fields can be
  created on the fly) and options → dry run → import as a background job with progress, pause and resume → report with warnings.
  Idempotent (external ids per vendor account, contacts matched by e-mail or phone, fill or overwrite), unsubscribed/bounced people
  arrive as *Nicht stören* plus a tag, ActiveCampaign automations and Kit sequences become workflow drafts (*bitte prüfen*),
  segments become tags and smart lists, courses come with modules and lessons where the API provides them (a course-structure file
  where it does not). **Undo** takes an import back: created records are deleted, merged contacts are restored from a copy kept for
  30 days, changed or used ones are left and listed. Every import, dry run and undo is in the audit log; uploaded files are deleted
  after the import (14 days at the latest), the id map keeps no e-mail addresses (hashes), an erased contact leaves the id map.
  REST `/api/umzug*` (area *Einstellungen*), MCP tools `ghl_umzug_sources`, `ghl_umzug_preview`, `ghl_umzug_start`,
  `ghl_umzug_status`, `PGHL_UMZUG_MAX_MB` (default 50), Akademie tour *Umzug*, [docs/umzug.md](docs/umzug.md).
- **E-Mail-Zustellung prüfen (*Einstellungen → E-Mail-Zustellung*):** a wizard that checks SPF (one record, ends in an *all*, at most
  10 lookups, contains the provider), DKIM (selector per provider: Amazon SES, Postmark, Resend, Brevo, Mailgun, SMTP; with a connected
  provider account the expected records come from its API), DMARC (policy, reports, inheritance from the parent domain) and MX by DNS
  (`node:dns`), explains every finding in German and shows the DNS records to copy, with status badges and a re-check. The campaign
  send card shows the verdict and the send confirmation warns when the domain has problems. REST `/api/mail-domains*`, MCP tool
  `ghl_mail_domain_check`, Akademie tour, [docs/deliverability.md](docs/deliverability.md).
- **One-click unsubscribe (RFC 8058):** campaign, workflow and NPS e-mails carry `List-Unsubscribe` and
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (SMTP, Postmark, Resend, Brevo, Mailgun, SES); `POST /u/:contact/:token`
  unsubscribes with a single request (400 for a wrong token, exempt from the public-write rate limit); the link in the body stays.
  `OutMail.headers` and `SendInput.bulk` in the mail code.

### Changed
- `Db.tx` nests (savepoints) so a restore may use a module's own transaction; `HttpError` can carry extra JSON (`data`).
- `app.services.workflowVersions` exposes the workflow version helpers to the journal.
- **Service worker `v2`** (`web/public/sw.js`): hashed `/assets/*` files are cached only when they are what their name says
  (status 200, never an HTML page for a script or stylesheet); a missing file (404 after a deploy) is passed through and
  never cached; a poisoned cache entry is dropped and fetched again; the offline shell is served only when every file it
  names is cached (otherwise the offline page), and only a real `index.html` is kept (no hotspot login page); the install
  caches the shell only after all its files arrived; during a server restart (5xx) the complete cached shell is shown;
  `/theme-boot.js` and `/boot-guard.js` are network-first with an offline copy. The version bump makes every device drop
  what the old worker cached.
- Vite `build.target` is `chrome92, edge92, firefox90, safari15` (the Android WebView minimum): JavaScript output is
  identical to Vite's default, CSS grows by 32 bytes.
- Android: the WebView lives in a container view, so it can be replaced without touching the Compose tree.
- Demo mode now also blocks DNS queries made with the promise API's `Resolver` (`node:dns/promises`).

### Fixed
- **"Today" after midnight in the sub-account's time zone (22:00–24:00 UTC is already 00:00–02:00 in Berlin).** Several
  counters took the UTC date or the UTC midnight as the day, so users in Germany saw yesterday's numbers for two hours a
  night: the **ads manager** list and insights (`GET /api/ads/campaigns`, `/api/ads/insights`) ended their default range on the
  UTC date and dropped the new day's spend and CRM leads (now like `/api/ads/report`: the last 30 days up to the sub-account's
  today); the **dashboard** put a lead created at 00:30 on the previous day's bar and counted a task due *today* (a date
  without a time) as overdue from 02:00 on – leads are now counted per local day (the response carries `today`, the chart
  uses it) and **overdue** means one rule everywhere, as in the mobile app and the planner: a due date without a time is
  overdue the day after, a timed one at its time (also for the agency overview and project cards, per sub-account zone, and
  the overdue badge of whiteboard task cards); whiteboard AI tasks "due in N days" count from the sub-account's today; the
  web task list marks overdue by the sub-account's date. Report ranges, the mobile summary and task filters, date and
  birthday triggers and the Werkstatt birthday job already used the sub-account's zone.
- **Tests no longer depend on the time of day.** The mobile summary/task, ads campaign and Werkstatt birthday tests took
  "today" from the UTC date and failed between 22:00 and 24:00 UTC. `tests/day-boundary.test.ts` runs these cases (plus the
  dashboard, agency counters and whiteboard tasks) at fixed instants – 22:30 UTC and 12:00 UTC – and asserts the Berlin
  results; `PGHL_TEST_NOW=<ISO instant>` runs any test file at a fixed instant (see CONTRIBUTING).
- **Android app: blank screen with only the quick-menu button.** Three ways the main screen could stay empty are closed:
  after the system restored the app, `WebView.restoreState()` could return a history that is not `null` but empty, so the
  start page was never loaded; a lost render process (killed for memory, crashed) recreated the activity with that stale
  state instead of replacing the WebView; and *Neu laden* in the quick menu did nothing without a page (`reload()` needs
  one). The start page now loads whenever the restored history is missing, empty or has no current page, a lost render
  process gets a new WebView (the second loss within a minute shows an error screen with the reason), and *Neu laden*
  loads the start page when there is nothing to reload.
- **Web: a render error outside a page boundary left a blank page.** React unmounts the whole tree on an uncaught render
  error (shell, menu, login); a root error boundary now shows the plain "Die App konnte nicht starten" page and reports
  the error. The first screen's lone spinner offers *Neu laden* after 15 s instead of waiting forever.

## [0.0.34] – 2026-10-04

### Added
- **Living Boards (Boards in the menu, "Genius-Modulbaukasten"):** workspaces composed from widgets, personal or shared per
  sub-account. 13 built-in widgets – key figure (22 presets), chart (14 presets, or any saved report), list with saved
  filters (contacts, deals, tasks, tickets), pipeline mini-kanban, appointments, inbox, tasks you can tick off, wiki page,
  Markdown notes, embedded page (https allow-list, YouTube/Vimeo/Loom links rewritten), quick actions (start a workflow,
  open a form or page, create a task or contact), Gewinnrechner scenario and Werkstatt plugin widget. **Editor without a
  library:** pointer drag and resize with a snapped ghost and cells that glide (respects `prefers-reduced-motion`), the
  same grid maths as the server so what you see is what is saved, auto-scroll, keyboard moving and resizing with a live
  announcement, tablet (6 columns) and phone (one column with up/down buttons) arranged separately or derived, widget
  picker with search, settings panel drawn from the widget's declaration. **Tell the board what you want** (prompt bar,
  text or push-to-talk): the model answers with a patch in a strict schema, the engine validates it, the person sees a card
  (changes, before/after, risk) and confirms – low-risk layout changes can be applied at once (setting), spoken wishes
  and anything with an address or buttons never confirm by themselves; a missing widget offers *In der Werkstatt bauen
  lassen*. **Every change is a version** with undo, redo, history and restore (also for agent, MCP and API changes),
  changes show up live for everybody looking (SSE). Start page per person, five starter boards, board templates (config
  only) saved or published to the Marktplatz with a review and a consent screen, JSON export/import.
- **Every widget reads with the viewer's own rights** (the regular route runs as the person looking; a locked card names the
  missing right, no values in the page), sub-account isolation, audit log for every write.
- **`boardWidgets(app).register()`** – modules add widget types with a declaration and one server function (no browser
  code); docs/living-boards.md has the widget API and the notes for self-hosters.
- **MCP tools** `ghl_board_list`, `ghl_board_get`, `ghl_board_apply_patch` (`dry_run`, `expected_version`,
  `confirm_external`), `ghl_board_widgets`, `ghl_board_create`; the GoHigh Agent knows boards. Read-only
  `/api/mobile/boards*` for the native app. REST under `/api/boards` and `/api/board-templates` (docs/api.md).
- Akademie tour *Living Boards*; Marktplatz shelf with published board templates; admins manage the allowed embed hosts
  in Boards.

## [0.0.33] – 2026-10-04

### Added
- **Webinare (Marketing → Webinare):** automated webinars – a video plays at the appointment for everybody who registered.
  Appointments: fixed weekdays and times (daylight saving safe, in the webinar's zone), single dates, *just in time* (the
  next start every N minutes inside a daily window), *start right away*, blackout days, optional seats per session; times
  shown in the viewer's zone. Video from a chunked upload, an MP4/HLS link, YouTube/Vimeo or the Video-Studio. Registration
  page `/w/<slug>` (also `?embed=1` for funnel pages, and forms that register their senders): creates or updates the contact
  with tags, confirmation with `.ics` (attached with SMTP, linked everywhere) and a signed personal link, reminders (24 h, 1 h,
  15 min, start) by e-mail and optional SMS through the sub-account's senders, once each, never for moments before the
  registration. The room: waiting room with a countdown, video from the schedule's second (late joiners start mid-way, no
  skipping – the server's clock decides), questions into Konversationen (channel Chat, answers show up in the room), polls and
  an offer button at a chosen second (product, form or link; a deadline is real and closes the button for everybody), the
  recording with an expiry (48 h by default), a preview for the team.
- **Honest by design (UWG):** the room, registration page and recording always show *Automatisiertes Webinar* /
  *Aufzeichnung*; the wording can be changed but never to anything claiming *live*; automatic chat messages and the attendee
  counter are off by default, automatic messages carry the fixed note *Automatische Nachricht*, the counter is the real number.
- **Tracking, automations and numbers:** per registration registered / attended / watch share / left at / offer clicked /
  bought / recording watched – on the contact's timeline; workflow triggers `webinar.registered`, `webinar.attended`,
  `webinar.missed`, `webinar.watched_percent` (filter *minimum %*), `webinar.cta_clicked`, `webinar.replay_watched` and the
  action *Kontakt für Webinar anmelden*; analytics per webinar and session (show-up rate, watch time, drop-off curve, clicks,
  sales, revenue, polls). REST API under `/api/webinars` (area *Funnels & Websites*, every write in the audit log), MCP tools
  `ghl_webinar_list`, `ghl_webinar_get`, `ghl_webinar_register`, `ghl_webinar_stats`, mobile endpoints
  `/api/mobile/webinars*`, Akademie tour *Webinare*, [docs/webinars.md](docs/webinars.md).
- E-mail attachments: `OutMail.attachments` / `SendInput.attachments` (SMTP sends them; other senders may ignore them).
- Workflow field type `webinar` (a picker for the step and trigger forms).

## [0.0.32] – 2026-10-04

### Added
- **Werkstatt:** wishes are built by AI agents. *Bauen lassen* on a wish (and in the done screen of "Neuer Wunsch"): the
  AI proposes a plan – **Stufe 1 "Einrichtung"** from existing building blocks (workflows, fields, objects, reports,
  dashboards, agents, templates, forms, pipelines, tags; undoable) or **Stufe 2 "Mini-App"** (a plugin) – with required
  permissions and an estimated cost. The requester confirms, an admin approves by policy (notification in the app, push
  with *Freigeben/Ablehnen* buttons and email), the build runs with a live progress line and log, cost tracking and a
  monthly budget per sub-account, through `aiRun` (Anthropic, OpenAI or any OpenAI-compatible provider such as
  OpenRouter), with repair rounds when the model's answer is unusable. *Ändern lassen* writes new versions with history
  and rollback. Policy: who may build (admins by default, team, everyone – plus single people or sub-accounts), approval,
  budget, repair rounds, server logic, hosts, kill switch. Dry run (`/api/werkstatt/dry-run`) and
  `scripts/werkstatt-smoke.mjs` check a live instance without spending.
- **Plugins (really isolated):** manifest with scopes and entry points (menu page, contact/deal panel, dashboard widget,
  workflow action, scheduled job); UI in `<iframe sandbox="allow-scripts">` without `allow-same-origin` with a strict CSP
  and a postMessage bridge that checks manifest scopes and the user's own permissions and calls the API as that user;
  server logic in a child process under Node's permission model (memory cap, timeout, IPC to the bridge; own network
  namespace where available) or declarative steps; static checks and a sandbox self-test before activation; JSON
  export/import, four examples, kill switch on error spikes.
- **Marktplatz:** categories, search, live preview with sample data, screenshots, ratings, install per sub-account with a
  consent screen, updates with changelog, uninstall with optional cleanup; rollout scopes private → sub-account →
  agency-wide → Marktplatz; publishing needs an AI security review (checklist) and an admin's approval; health per plugin.
- **Stage 3:** *Als Kernfeature vorschlagen* writes a spec and opens a GitHub issue for `@codex` or `@claude` (repository
  configurable, clear hint without token); status tracking; "im Kern enthalten" migrates or retires the installs.
  **Feature flags** (`app.services.flags.enabled`): off → people → sub-accounts → percent → all, with an admin screen.
- MCP tools `ghl_list_plugins`, `ghl_install_plugin`, `ghl_build_from_wish`, `ghl_plugin_status`; the GoHigh Agent offers
  to build what its tools do not cover; workflow action *Plugin-Aktion*; the GitHub issue action can address `@claude`.
- **Werkstatt: Realtime Feature Lifecycle in the GoHigh Agent chat.** The agent recognises a feature wish and plans it
  (`ghl_build_from_wish`, planning only); the plan appears as a **card** (what is built, permissions, cost, model and
  Denkstufe) and the person confirms with the card's own button – the agent never confirms by itself. The same card shows
  the build live (step names), then an inline **sandboxed preview** with Öffnen / Ändern lassen / Version zurück /
  Verwerfen. Conversational changes make **version 2 with a diff summary** (`ghl_change_plugin`); admins run the
  lifecycle from the chat (`ghl_plugin_overview`, `ghl_plugin_admin`: approve, review, second opinion, publish, roll back,
  switch off, core proposal). New `ghl_discard_plugin`.
- **Mindest-Modell:** the Werkstatt only writes and reviews code with a top model – GPT-6 Sol, Astra, Claude Opus 5.5,
  Claude Fable 5.5 (OpenRouter prefixes, newer versions and own patterns supported; Stufe 1 may use the normal model).
  German refusal with a link to *KI-Anbieter*; own routing capabilities **Werkstatt** and **Werkstatt: Zweitmeinung**.
- **Denkstufe (reasoning effort):** one setting in *KI-Anbieter* (default `xhigh`, per capability, per sub-account) mapped
  per provider (Anthropic `output_config.effort`, OpenAI `reasoning.effort` / `reasoning_effort`, OpenRouter
  `reasoning`); a level a model cannot take is lowered and logged; the Werkstatt never goes below `high`; model and
  Denkstufe are shown on every build and version. (Everyday calls used `low` before – they now follow the setting.)
- **Sicherheitsnetz:** badge row per version (static, tests, review, second opinion, signature, model · Denkstufe), one
  smoke test per entry point, **second opinion by a different top model** before the Marktplatz (side by side in the
  publish dialog), latency as a kill criterion with note/push/email, **one-click rollback**, diff summaries; core
  proposals state that nothing is deployed automatically.
- **Signed plugins and Pro:** Ed25519 signed bundles (`scripts/werkstatt-sign.mjs`, trusted keys in the policy / env), „ungeprüft“
  warning for everything else; Marktplatz publish/install, signed installs, second opinion and the percent rollout are marked
  **Pro** behind `app.services.license.has('pro')` – a stub that says yes (no license system yet); documented in
  docs/werkstatt.md.
- Push notifications can carry up to two action buttons (`actions` in `pushNotify`); push kind "Werkstatt".
- Academy tours *Werkstatt* and *Marktplatz*; [docs/werkstatt.md](docs/werkstatt.md) (architecture, security model,
  writing a plugin by hand, manifest reference, tester guide).

## [0.0.31] – 2026-10-04

### Added
- **Voice layer (Einstellungen → Stimme):** bring your own speech providers on top of the AI providers – text to speech
  and speech to text with **OpenAI, ElevenLabs, Deepgram, Cartesia, AssemblyAI, Azure Speech, Google Cloud Speech,
  Gemini** or any **local OpenAI-compatible server** (Kokoro, Piper, Whisper), live voice lists plus free text,
  speed and style, *Stimme testen* and a microphone test. The new providers are KI-Studio adapters, so the studio,
  the workflow action *Text in Sprache* and MCP use them too; presets are marked *Live* where they can stream.
- **AI phone agent with its own voice:** setting *Twilio (Standard) / eigener Anbieter*. **Live** over Twilio Media
  Streams (own RFC 6455 endpoint, G.711 µ-law transcoding and voice activity detection in pure TypeScript, streaming
  STT → agent → streaming TTS, barge-in with `clear`, latency per turn on the settings page) or in **recorded turns**
  (`<Record>` → STT → agent → TTS → `<Play>`); any provider failure hands the call to Twilio's voices instead of
  silence. The stream is tied to its call by a signed token. Voicemails can be transcribed (and summarised) with the
  own speech recognition.
- **GoHigh Agent push-to-talk:** microphone button (tap or hold, MediaRecorder → server STT, editable text,
  optional auto-send), spoken replies with the own voice, Web Speech as fallback; voice never confirms a change.
  MCP tools `ghl_voice_get_settings`, `ghl_voice_update_settings`, `ghl_voice_list_voices`, `ghl_voice_test_voice`,
  `ghl_voice_transcribe`, `ghl_voice_phone_latency`; mobile endpoints `/api/mobile/voice/*`; Akademie tour
  *Stimme & Spracherkennung*; [docs/voice.md](docs/voice.md).

## [0.0.30] – 2026-10-04

### Added
- **Workflow depth: 120 actions and 94 triggers** ([docs/workflow-actions.md](docs/workflow-actions.md)). New actions:
  formatter for text, numbers and dates (time zones, daylight saving, business days), math, copy/set/clear fields, list and JSON
  helpers, a **sandboxed code step** (own tokenizer/parser/interpreter – no `eval`, documented limits), find / find-or-create
  contact, find deal, go-to and goal jump, **A/B/n split tests with statistics**, loops with a safe cap, drip, waits for a
  field condition / time window / date relative to a field / reply, **webhook with retries and response mapping**, per-run
  variables, internal notifications (app, push, e-mail, SMS), weighted round-robin assignment, deal / task / appointment
  updates, per-channel DND, tags by condition, remove from all workflows, invoice / payment link / contract from a template,
  community join/leave, social post drafts and five AI steps with structured output (classify, extract, sentiment,
  summarise, translate).
- **23 new triggers**: field changed (old/new), owner changed, birthday, anniversary, cron schedule per sub-account time zone,
  form abandoned, page visited, payment failed / refunded, subscription ended, invoice overdue / created, estimate accepted,
  appointment no-show / cancelled / rescheduled / starts soon, task overdue, conversation unanswered, custom events via API/MCP,
  CSAT, NPS, course access revoked. **Filters on every trigger** (field checks and an expression); rating triggers get `min_rating`.
- **23 native app steps without Composio**: Slack (bot token), Microsoft Teams, Trello, Asana, ClickUp, Airtable, Notion
  database items, Google Sheets rows, Google Calendar, HubSpot, Mailchimp, Brevo, Shopify, WooCommerce, Stripe, Calendly,
  Typeform and Zoom – API key or OAuth through Nango, all outbound calls through `safeFetch`.
- **Editor**: action picker with categories, search and inline docs, generated forms for steps, triggers grouped by topic,
  condition editor with all operators and an expression field, **test run with sample data**, run log with inputs and outputs
  per step, split-test results, **draft / publish with versions** (restore as draft), JSON import / export, Academy tours.
- API and MCP: `GET /api/workflow-catalog`, `POST /api/workflows/:id/test-run`, `GET /api/workflow-runs/:id`, versions, draft,
  publish, export/import, `POST /api/custom-events`; tools `ghl_workflow_catalog`, `ghl_workflow_test_run`,
  `ghl_workflow_export`, `ghl_workflow_import`, `ghl_emit_event`.

### Changed
- The workflow engine runs steps in a shared `execute()` (also used by test runs), supports flow outcomes (jumps, lanes,
  waits), per-run variables and a step cap per run (5 000, `settings.max_steps` up to 20 000).
- The README numbers for triggers and actions come from the registries; `tests/wfx-counts.test.ts` fails if they are overstated.
- The project planner's triggers (`task.created`, `task.status_changed`, `task.assigned`, `task.overdue`) and steps (`pm_*`) show up in
  the picker and the counts. The overdue scan lives in the planner (once per task and due date), so *Aufgabe überfällig* has a
  project filter instead of a grace time.
- `tests/wfx-sweep.test.ts` fires the event of every trigger and runs every action with its sample behind the outbound guard,
  so a step added later is covered the day it appears.

### Needs real credentials to verify
- The native app steps (their requests are pinned by mocked tests), Stripe webhook events `invoice.payment_failed`,
  `charge.refunded`, `customer.subscription.deleted` for the payment triggers, Google Sheets/Calendar connections.

## [0.0.29] – 2026-10-04

### Added
- **Back-Office** (new menu group, [docs/backoffice.md](docs/backoffice.md)): three areas in the same system for German small businesses, each with its own permission (`accounting`, `inventory`, `personal`).
  - **Buchhaltung light – preparation for the tax advisor** (not certified software, no GoBD certification, no ELSTER; the notice is shown in the app and the docs). SKR03/SKR04 chart, double-entry journal with immutable entries (storno instead of editing, SHA-256 hash chain, append-only audit trail, period lock, receipt archive with hash), VAT codes 19/7/0 %, intra-community, export, reverse charge, receipts inbox (upload, phone photo, mail forwarding webhook; XRechnung/ZUGFeRD read exactly, optional AI vision), auto-posting from invoices, payments and Stripe payouts/fees/refunds, bank CSV/CAMT.053 import with matching, EÜR, SuSa, BWA, VAT return key figures, open items, DATEV EXTF Buchungsstapel and documents ZIP.
  - **Lager & Einkauf**: articles with variants, SKU and EAN, places, movements with moving-average valuation, automatic goods issue for paid invoices, minimum-stock alerts (push + `stock.low` trigger), stock-taking, purchase orders with goods receipt.
  - **Personal**: employees (logins or not), sealed sensitive fields behind a second gate (admins and a listed few, browser session only, audited), absences with request → approval, vacation account with pro-rata entitlement, carry-over and public holidays per Bundesland, team calendar, onboarding/offboarding checklists, working-time overview and a hook for time tracking.
- MCP tools `ghl_booking_summary`, `ghl_euer_report`, `ghl_vat_overview`, `ghl_open_items`, `ghl_receipt_status`, `ghl_stock_levels`, `ghl_low_stock`, `ghl_stock_movement`, `ghl_create_absence_request`; workflow triggers `stock.low`, `purchase_order.received`, `receipt.received`, `receipt.booked`, `absence.requested`, `absence.approved`, `absence.rejected`; mobile endpoints for receipts, absences and low stock.
- Academy tours for the three areas. Back-Office has its own department colour, hideable menu entries, a place in the starter profiles and glyphs in the solid icon pack.
- The HR working-time overview shows the hours tracked in *Zeiterfassung* next to the target hours (`modules/backoffice-time.ts`).

## [0.0.28] – 2026-10-04

### Added
- **Project planning and time tracking** (menu *Projektplanung* and *Zeiterfassung*, area `contacts`; billing needs `payments`):
  projects per sub-account (linked to a contact, company or deal; every existing task moved into the default project
  "Allgemein"), custom statuses per project, sections, custom fields, tasks with nested subtasks, checklists, several
  assignees, watchers, tags, start/due date, estimates, dependencies (finish-to-start, start-to-start, finish-to-finish,
  start-to-finish with lag; cycles refused), recurring tasks, attachments and comments with @mentions. Views: list
  (grouping, sorting, filters, bulk edit), board with drag and drop, calendar, **Gantt** (drag to move/resize, draw
  dependencies, critical path, baseline, zoom day/week/month, automatic planning), workload per person, "Meine Aufgaben",
  saved views. Project templates ("Kunden-Onboarding", "Website-Projekt") and automations (status changed / completed /
  overdue → create task from template, move status, assign), workflow triggers `task.*` and actions `pm_*`. Time tracking
  with one running timer per person (global indicator), manual entries without overlaps, weekly timesheets with optional
  approval, billable flag and rates per person/project, reports by project/person/client, and **"In Rechnung stellen"**
  that creates an invoice draft (cancelling the invoice frees the hours). Read-only project boards in the customer portal,
  notifications (bell, push, Android feed), 17 MCP tools `ghl_pm_*`, mobile API `/api/mobile/pm/*`, academy tours,
  [docs/projects.md](docs/projects.md). The plain task list, Todoist sync, workflows and the app keep working unchanged.
- **Wiki – team knowledge next to the CRM** (menu *Wiki*, area `wiki`, [docs/wiki.md](docs/wiki.md)): spaces per sub-account
  with a nested page tree (drag & drop, move dialog for phones), a Markdown editor with toolbar, `/` block menu,
  `@mentions`, list continuation, uploads (paste/drop, content-checked) and a live preview rendered by the server;
  checklists that can be ticked in the reading view, tables, callouts, **live cards** for contacts, companies, deals,
  pipelines, tasks, tickets, Canvas boards, documents and other pages (the viewer's own rights); comments with
  replies, resolve and mentions; version history with line diff and restore; favourites; full-text search (SQLite
  FTS5 with `LIKE` fallback); templates (meeting notes, SOP, project brief, onboarding handbook); Markdown/HTML
  import; export as Markdown or PDF (built in, with sub-pages); trash with 30 days; read-only **share links**
  (revocable, strict CSP, no script) and **publishing to the help center** through the knowledge-base routes;
  AI summarise/rewrite/continue/translate/find tasks and "write a page from a prompt" (suggestions only);
  concurrent edits are detected (stale saves are refused with *Neu laden / Meine Fassung behalten*). Rendering is
  two-layer (escaping renderer + allow-list sanitiser) with a work budget. MCP tools `ghl_wiki_search`,
  `ghl_wiki_get`, `ghl_wiki_upsert_page`; mobile `GET /api/mobile/wiki/pages[/:id]`.
- **Team-Chat – internal messenger** (menu *Team-Chat* with unread badge, area `teamchat`, [docs/team-chat.md](docs/team-chat.md)):
  public and private channels per sub-account or agency-wide, direct messages and groups (up to 8), threads, emoji
  reactions, @mentions (`@alle`), files and inline images, pins, edit/delete, unread counters with a "Neu" line,
  message search, typing indicator and presence over SSE + POST, per-channel loudness (all / mentions / muted).
  Private channels and direct messages are readable by their members only – agency admins, keys and MCP included.
  Notifications by web push (kind `chat`) and on the Android app (feed type `chat`, new category *Team-Chat*) only
  while you are not looking at the chat. CRM link previews as live cards, *save as note on a contact*, `/aufgabe`
  (task from a sentence: "… morgen @Anna"), `/kontakt` and `/agent` (the GoHigh Agent answers in the channel with
  the asker's rights; changes wait for the asker's own, single-use confirmation). Retention per area
  (30/90/180/365 days, pinned stay), optional one-way copy to the Slack bridge, MCP tools `ghl_chat_post` /
  `ghl_chat_history` (public channels only), mobile `/api/mobile/chat/*`.
- Academy tours *Wiki* and *Team-Chat*; both areas are hideable menu entries with department colours, in the starter
  profiles (Agentur, Vertriebsteam) and in the solid icon pack.
- Tests: tree operations, versions and restore, search (FTS and fallback), share links (read-only, revocation), ~70
  XSS payloads through page/public/chat/comment rendering, chat permissions, SSE delivery, mentions → notifications,
  tenant isolation (the harnesses seed wiki pages and channels), agent confirmation.

### Changed
- The pages that fill the whole screen (Wiki, Team-Chat) size themselves to the room under the top bar instead of a
  fixed height, so they fit every theme and density.
- Demo mode also empties `teamchat-files` on its nightly reset.

## [0.0.27] – 2026-10-04

### Added
- **Gewinnrechner (Umsatz → Gewinnrechner):** what is left at which price and how many customers, after VAT,
  payment fees, running costs, acquisition costs and taxes. A pure engine shared by the browser, the API and MCP:
  flat price per company, per seat, per location with included units, step price and cap, size bands by team size and
  agency tiers, customer mix, annual discount, setup fees, add-ons; customers as a count or a growth curve with
  churn; USt 19/7/0 %, reverse charge, Kleinunternehmer; Stripe-style fees on the gross charge; fixed costs and CAC;
  taxes by legal form (ESt § 32a with editable, year-labelled parameters, Soli, Kirchensteuer, Gewerbesteuer with
  Hebesatz, Freibetrag and § 35 credit, GmbH with KSt) – always *Schätzung, keine Steuerberatung*. Heatmap matrix
  customers × prices with a metric selector, break-even, LTV/CAC, payback, MRR/ARR, 12/24/36-month projection,
  waterfall and tornado as hand-made SVG; six presets (GoHigh Staffel, Standort-Modell, SaaS pro Nutzer,
  Agentur-Retainer, Kurs/Community, Handwerk); scenarios per sub-account (save, compare, CSV).
- **Gewinnrechner API and agents:** `POST /api/calc/run`, `/api/calc/breakeven`, scenario CRUD, `/api/calc/compare`,
  CSV export, JSON Schema at `/api/calc/schema` (area *Rechnungen & Produkte*, calculations leave no audit entry);
  MCP tools `ghl_calc_run`, `ghl_calc_breakeven`, `ghl_calc_scenarios_list`, `ghl_calc_scenario_run`,
  `ghl_calc_scenario_save`; mobile endpoints `/api/mobile/calc/*`; Akademie tour *Gewinnrechner: Was bleibt übrig?*;
  [docs/gewinnrechner.md](docs/gewinnrechner.md).
- **Ads manager (Marketing → Anzeigen):** create and run **Meta (Facebook/Instagram)** and **Google Ads**
  campaigns inside GoHigh. Connect with a normal sign-in (agency Meta app and Google OAuth app + developer token
  once, ad account per sub-account; long-lived Meta tokens are extended automatically), then a five-step wizard
  (goal, budget and schedule, audience, ad, review): Meta traffic/conversions/reach and **Lead Ads** with
  instant forms, Google **Search (RSA)** and **Performance Max**. Audiences from smart lists (SHA-256 hashed
  with each platform's normalisation, consent required, do-not-disturb left out), Meta lookalikes, Google
  Customer Match, interests and locations from the platforms' targeting search, creatives from the media library
  or KI-Studio with AI copy suggestions, funnel links with UTM added automatically.
- **Lead Ads import:** Meta leads become contacts (tags, note, attribution) and start workflows – signed webhook
  `/hooks/ads/meta` plus a 10-minute poll as fallback; new workflow trigger *Neuer Lead aus Anzeige*.
- **Manage:** campaign list with spend, clicks, CRM leads, cost per lead and ROAS (reuses the ads report),
  pause/resume, budget change, duplicate, and rules such as "pause when the cost per lead is above X"
  (they can only pause or notify).
- **Safety:** everything is created paused, publishing is bound to the reviewed version (rollback on failure),
  switching on and budget changes need a person's confirmation, API keys, MCP and the GoHigh Agent can only file
  an approval that a person decides on, daily budget limit per sub-account, audit log for every spend-related step.
- **MCP tools** `ghl_ads_accounts`, `ghl_ads_create_campaign`, `ghl_ads_update_status`, `ghl_ads_update_budget`,
  `ghl_ads_insights`; mobile endpoints `/api/mobile/ads*`; Akademie tour *Anzeigen: Meta & Google*;
  [docs/ads-manager.md](docs/ads-manager.md) (Meta app and App Review, Google developer token access levels).
- **Mailbox sync with Gmail and Outlook / Microsoft 365 over the official APIs** (*Einstellungen → E-Mail & SMS →
  Postfach verbinden*): connect per user or per sub-account (several mailboxes, Microsoft shared mailboxes) with the
  agency's Google/Microsoft OAuth app (access levels *full* = `gmail.modify` + `gmail.send` / `Mail.ReadWrite` +
  `Mail.Send`, *read only*, *send only*; tokens sealed, refreshed automatically). First import with a configurable window
  (default 90 days), then Gmail `history.list` / Graph delta queries; **push** through Gmail `users.watch` + Cloud Pub/Sub
  (Google-signed OIDC token pinned to audience and service account, or a shared secret) and Graph change notifications
  (validation handshake, `clientState`, lifecycle events, renewal), polling every 3 minutes as the fallback. Threads, labels /
  folders, read, star and archive **both ways** (outbox with retries), attachments, contacts matched by e-mail, routing
  rules for personal mailboxes (limited to the owner's sub-accounts). **Answer from GoHigh through the user's own mailbox**
  in the same thread (`threadId` + `In-Reply-To`/`References`, Graph `createReply`), signature, attachments, scheduled
  send, drafts that sync both ways; workflow e-mails can go out through a connected mailbox (provider *Verbundenes
  Postfach*). Inbox: mailbox filter and folders, folder/label badges, archive, labels, reply box, attachment downloads.
  MCP tools `ghl_mailbox_list`, `ghl_mail_search`, `ghl_mail_draft`, `ghl_mail_send`; mobile API `GET /api/mobile/mailboxes`,
  `POST /api/mobile/conversations/:id/mail-reply`; academy tour; [docs/mailbox-sync.md](docs/mailbox-sync.md) (setup,
  redirect URIs, Google's restricted-scope policy with the options, Microsoft admin consent).
- Hooks `conversationFilters`, `conversationRows`, `messageRows` (conversation list and thread) and `oauthPurposes` (a module
  finishes the shared OAuth callback for its own purpose).

## [0.0.26] – 2026-10-04

### Added
- **Darstellung** (*Einstellungen → Darstellung*, per user, stored on the server): a gallery of **19 themes** with
  matched light and dark variants, *hell / dunkel / wie das System*, any **accent colour** (picker and presets;
  hover, soft tint, link text, focus ring and black/white text on the accent are derived automatically),
  **density** and **font size**. Every theme is checked for WCAG contrast in both modes (`tests/theme.test.ts`).
  No flash of the wrong theme: `theme-boot.js` paints the cached look before React starts.
- **Bereichsfarben**: every menu area has its own hue; intensity *Aus / Dezent / Klar / Vibrant* (dots and stripes,
  tinted items and page headers, gradient pill and header), three palettes (*Harmonisch, Regenbogen, Gedeckt*) that
  adapt to theme and mode, optional tinting of buttons/links/tabs on a department's pages.
- **Narrow sidebar**: icons only with tooltips and flyouts for sub-menus, **Ctrl/⌘ + B**, remembered per user;
  phones keep the drawer. **Six icon packs** (Linien, Fein, Kräftig, Eckig, Duotone, and the hand-made *Gefüllt*,
  which is loaded only when chosen).
- **Visible areas**: hide menu entries you do not use (they disappear from the menu, search, Ctrl+K and the
  dashboard; *Alle Bereiche anzeigen* brings them back) – a view, not a permission. **Starter profiles** (Agentur,
  Coach & Kurse, Lokales Business / Handwerk, E-Commerce, Vertriebsteam, Alles) with a preview, offered once to
  new accounts, in the Akademie and on the Darstellung page.
- **White-label look** (*Agentur → White-Label*, and per client): logos for light and dark sidebars, a square mark
  for the narrow sidebar, favicon, app name beside the logo (or not), live preview; PNG/JPEG/WebP/SVG uploads are
  checked – an SVG with scripts, event handlers or outside references is refused. **Default look for the logins
  with a lock per group** ("Nutzer dürfen … ändern"); agency admins are never locked.
- Akademie tour *Darstellung anpassen*, new steps in the white-label tour, [docs/theming.md](docs/theming.md)
  (how to add a theme, a department or an icon pack).

### Changed
- The agency's brand colour is now the accent of the *GoHigh Standard* theme instead of an inline override of
  everything; the account page's old hell/dunkel switch moved to *Darstellung* (an earlier choice is carried over).
- Text on filled accent colours (buttons, chat bubbles, active menu entries …) is black or white by contrast
  instead of always white; link text uses a separately derived, readable accent.
- Image addresses in the branding must start with `https://` (or point to our uploads).

## [0.0.25] – 2026-10-04

### Performance
- **Page load:** pages, editors, tours, the agent panel and the canvas are separate chunks (route-level
  `React.lazy` with a skeleton, hover/idle preloading); the first download (shell + login + dashboard) is
  114 KB gzip instead of 1.9 MB. On throttled 4G the login page paints after 1.2 s (was 10 s), the dashboard
  after 1.6 s (was 12.7 s). Build files are precompressed (brotli/gzip) and cached as `immutable`, API
  JSON and rendered pages over 1 KB are compressed, `HEAD` requests for assets work (they used to answer a
  `no-store` 404).
- **Server:** indexes for the dashboard, agency and mobile queries, one grouped query per table instead of nine
  per sub-account (`/api/agency/projects` 2.3 s → 15 ms), a read cache that is dropped on every write,
  SQLite `synchronous=NORMAL`, in-memory temp tables, 32 MB cache, 256 MB mmap, planner statistics kept fresh,
  streamed CSV export, background jobs in ~40 ms slices, daily backup in a worker thread. With 100k contacts,
  200k messages and 50 sub-accounts p95 at 10 parallel clients is under 200 ms for every key endpoint.
- **Monitoring:** *Agentur → System* and `GET /api/admin/metrics` (event-loop lag, slowest routes, slow
  requests, job times, SQLite settings, row counts); `PGHL_SLOW_REQUEST_MS`, `PGHL_SLOW_QUERY_MS`,
  `PGHL_SQLITE_CACHE_MB`, `PGHL_SQLITE_MMAP_MB`, `PGHL_RESULT_CACHE`.
- **Tools and docs:** `npm run perf:seed` (50 sub-accounts, 100k contacts, 20k deals, 200k messages, fictional),
  `npm run perf:bench` (p50/p95/p99 and requests per second), `scripts/perf-browser.mjs` (FCP/LCP on throttled 4G),
  budget tests for the bundle, headers, PRAGMAs and the queries, [docs/performance.md](docs/performance.md)
  (before/after, sizing guide, rules for modules).

## [0.0.24] – 2026-10-04

### Added
- **Canvas – infinite boards for drawing, planning and design** (menu *Canvas*, area `canvas`): per-sub-account
  boards with an SVG editor (pan/zoom/pinch, minimap, smart guides, shapes, arrows that stick to shapes with
  straight/elbow/curved routes, smoothed pen, text, sticky notes, frames with Desktop/Mobile/Social/A4/Slide
  presets, images from upload/paste/drop/media library/KI-Studio, icons, tables, charts, "Handgezeichnet" look,
  templates, Mermaid, layers, group/lock/align/distribute, undo/redo, comments with @mentions, realtime
  cursors over SSE, touch and pen). **Live CRM cards** (contact, company, deal, task, ticket, appointment,
  project, report, whole pipeline) with the viewer's own rights; sticky note → task/deal, workflow → diagram,
  flowchart → draft workflow, frames → funnel pages. **AI drawing** (flowchart, mind map, org chart, wireframe;
  explain selection, turn into tasks, tidy layout). Exports as PNG/SVG/PDF (own renderer, no extra packages)
  into the media library and on to social post, e-mail or funnel; read-only public links, versions with restore,
  team access and per-person roles; "Aufs Canvas" buttons on contact, company, ticket, pipeline and workflow pages. 10 MCP tools (`ghl_canvas_*`) – the GoHigh Agent, Claude and ChatGPT draw
  on boards live with a labelled agent cursor – plus `/api/mobile/canvases`. Academy tour, `docs/canvas.md`.

## [0.0.23] – 2026-10-04

### Added
- **Nango connector** next to Composio: agency Nango access (Cloud or self-hosted, sealed secret key,
  "Verbindung testen"), integrations "via Nango" in the catalogue, per-sub-account connect flow as a plain
  redirect (no popup, Android-safe), connection sync/status/disconnect, signed auth webhooks, workflow
  action "API-Aufruf über Nango", MCP tool `ghl_nango_request` and agent tool within a per-sub-account
  allow-list, optional `docker compose --profile nango` with licence notes (`deploy/nango/`).
- **External MCP servers (MCP client):** add any remote MCP server for the agency or a sub-account
  (presets for GitHub, Notion, Linear, Atlassian, Zapier, Make, Stripe, Supabase, Sentry, Cloudflare,
  AnythingMCP), Streamable HTTP with SSE fallback, bearer or OAuth 2.1 (discovery, DCR, PKCE, refresh;
  tokens per server, sub-account or user), tool checklist with rug-pull protection, SSRF guard and size
  limits, workflow action "MCP-Werkzeug ausführen", `app.services.agentToolSources` (the GoHigh Agent
  offers the tools; writes need a confirmation) and optional re-exposure on `/mcp` as `ext_<server>_<tool>`.

## [0.0.22] – 2026-10-04

### Added
- **GoHigh Agent:** in-app AI agent on every page (Ctrl/⌘+J) that works through all MCP tools with the
  user's own permissions, confirmation cards for writes/outbound actions, custom agents ("KI-Mitarbeiter")
  with templates, schedules, workflow action and auto-responder, Custom GPT actions (OpenAPI), local bridge
  to your own Codex CLI / Claude Code subscription, MCP `ghl_list_agents`/`ghl_run_agent`, mobile API.
- **Universal BYOK registry (KI-Anbieter):** any OpenAI-compatible model plus Anthropic, Gemini, OpenRouter,
  Groq, DeepSeek, Mistral, xAI, Azure, Ollama/LM Studio/vLLM and media providers, per-capability routing.
- **KI-Studio:** image, video, music, TTS and transcription with BYOK (fal.ai, kie.ai, Replicate, OpenAI,
  Gemini, Stability, ElevenLabs, Runway, Luma, custom HTTP template), job engine with signed callbacks,
  media library, editor buttons, workflow actions, 5 MCP tools, mobile API.
- Provider sign-up links ("Konto anlegen") next to every provider key field, with transparent, replaceable
  partner links (Agentur → Partner-Links, `/go/<provider>` click counts, `PGHL_REFERRALS`,
  `PGHL_REFERRALS_DISABLED`), MCP tool `ghl_provider_signup_link`.

## [0.0.21] – 2026-10-04

### Added
- **Bug reports & wish list:** "Fehler melden" (web + Android) as helpdesk tickets with screenshots and
  diagnostics, automatic error capture (browser, server 5xx, app crashes, grouped by fingerprint),
  "Meine Meldungen", a public wish list with voting, roadmap and "Was ist neu" changelog, MCP triage tools.
- **Security review** (38 findings fixed, see `docs/security-review-2026-10.md`): tenant-isolation test
  harness over every route, encrypted credentials with `npm run rotate-secret`, SSRF guard on every
  outbound fetch, `PGHL_PROXY_HOPS`, body limits and public rate limits, GDPR export/erase per contact.
- Android app 1.0.1 (bug reports, wish list, crash reports).
- **Open-source release preparation:** AGPL-3.0 `LICENSE`, `NOTICE` with third-party notices and a
  license checker (`npm run licenses`, fails CI on licenses incompatible with the AGPL),
  `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), `SECURITY.md`, issue and pull
  request templates, funding placeholder, Dependabot.
- **CI:** GitHub Actions for typecheck, tests, build, license and publication checks; Android build and
  unit tests when `android/` changes; multi-arch Docker image (amd64/arm64) to GHCR on version tags.
- **One-command install:** production `Dockerfile` (multi-stage, Alpine runtime, app runs unprivileged,
  health check), `docker-compose.yml` with optional Caddy (automatic HTTPS, on-demand certificates for
  custom domains via `GET /api/tls/ask`) and OpenShorts profiles, fully documented `.env.example`,
  `scripts/install.sh` (`curl | bash`), Render and Railway templates, deploy guides for Docker, Coolify,
  Railway/Render, Hostinger VPS and plain Node.
- **Demo mode** (`PGHL_DEMO_MODE=1`): fictional demo data across all modules, banner, demo login with a
  one-click "Demo öffnen", nightly reset, and a socket- and DNS-level guard so nothing leaves the server
  (e-mail, SMS, WhatsApp, social, payments, webhooks, AI are only logged). `npm run demo:seed` fills an
  empty data folder for screenshots.
- `GET /api/version` and the version in the sidebar footer.
- Publication tooling: `scripts/oss-check.mjs` (secrets, public IPs, private terms from a local
  denylist, forbidden files) and `scripts/oss-export.sh` (clean export of HEAD for a fresh public
  history), `docs/oss-audit.md`.
- English README with feature overview and comparison; the German README moved to `README.de.md`.

### Changed
- Package renamed to `gohigh`; the default brand is "GoHigh" everywhere (was "Private GHL").
- Android: package `org.gohigh.android`; server URL, application id and App Links host are build
  properties (`-PgohighBaseUrl`, `-PgohighApplicationId`). The server's `assetlinks.json` trusts no
  certificate until `PGHL_ANDROID_CERT_SHA256` (and optionally `PGHL_ANDROID_PACKAGE`) is configured.
- Deployment files for one specific server moved to `deploy/examples/` with placeholders; the old
  `compose.yaml` became `deploy/examples/hostinger/compose.yaml` (prebuilt image behind Traefik).
- OpenShorts compose expects GoHigh's network as `gohigh_default` by default.
- `.gitignore` anchors runtime folders to the repository root.

### Removed
- Server addresses, personal hostnames and private project names from code, tests and docs.

## [0.0.20] – 2026-10-04

### Added
- **Sign-in:** Google, Microsoft, GitHub and Apple login, OpenID Connect SSO with group mapping and
  per-domain enforcement, passkeys, magic links, sign-up/2FA/session policies.
- **Composio** (250+ apps per sub-account, workflow action + trigger, AI allow-list, `ghl_app_action`) and
  native Slack/Discord/Notion/Google Sheets connectors.
- **More channels:** Telegram, Discord, reply-from-Slack, e-mail via Resend/Postmark/SES/Brevo/Mailgun,
  SMS via seven.io/Bird/Vonage/Plivo, web push to contacts.

## [0.0.19] – 2026-10-04

### Added
- **KI-Werkzeuge:** one-click keys and setup for Codex, Claude Code, Cursor, ChatGPT and Claude.ai; MCP
  OAuth 2.1 (discovery, dynamic client registration, PKCE); Codex tasks per project; OpenAI as AI
  provider; workflow action "GitHub-Issue für Codex anlegen".

## [0.0.18]

State of the platform at the start of the open-source preparation – everything a small agency or
business needs in one self-hosted Node.js app with a single SQLite file:

### CRM & sales
- Contacts with tags, custom fields, smart lists, notes, tasks, activity timeline, CSV import/export,
  duplicate merging, do-not-disturb; companies and custom objects with typed properties, associations
  and labels; lead scoring with decay and thresholds.
- Pipelines with drag-and-drop Kanban, deal properties, won/lost; projects hub with uptime monitoring.
- Calendars with public booking pages, availability rules, reminders, `.ics`, two-way sync with Google
  Calendar and Outlook (OAuth) or iCal.

### Marketing
- Forms and multi-step surveys with conditions, file upload, consent and spam protection.
- Funnels and websites with a page builder, templates, SEO, custom domains, blog per website and A/B
  tests with significance statistics.
- E-mail/SMS campaigns with tracking, drag-and-drop e-mail builder, trigger links.
- Workflows with 55 triggers and 32 actions (e-mail, SMS, WhatsApp, waits, branches, webhooks, AI text,
  social posts, Google posts, course access, tickets, companies/records …) and 6 recipes.
- Social planner via self-hosted Postiz; Video-Studio (AI shorts via OpenShorts) with content recycling
  and a feed autopilot; attribution (UTM, click IDs, first/last touch); affiliate manager; Meta/Google Ads
  reporting with ROAS.

### Conversations & service
- Unified inbox: e-mail (incl. IMAP mailbox sync), SMS, live chat, WhatsApp Business, Messenger,
  Instagram; telephony via Twilio with browser phone, voicemail and an AI voice agent.
- AI assistant (Claude) for reply suggestions, summaries, chatbot hand-off and workflow texts with a
  monthly limit and call log.
- Helpdesk: tickets with pipelines, SLAs, assignment rules, canned replies, knowledge base with public
  help center, CSAT/NPS, customer health score.
- Reputation: review requests, review widget, Google reviews and Business Profile replies/posts.

### Revenue
- Products, invoices and offers (VAT, recurring invoices), contracts with e-signatures, Stripe checkout
  per sub-account with buy links, order bumps, one-click upsells and coupon codes; accounting hand-off
  links.

### Platform
- Agency mode with unlimited sub-accounts, client logins with per-area permissions, white-label branding
  and login domains, snapshots, SaaS mode (plans, limits, Stripe billing, signup page).
- Courses and member portal with drip content; communities with channels, points, levels and events.
- Reports and dashboards over 15+ data sources with templates and scheduled e-mails.
- Integrations: REST API with OpenAPI 3.1, outgoing webhooks, REST hooks for Zapier/Make/n8n (ready-made
  apps in `integrations/`), inbound webhook trigger, integrations catalogue, GoHighLevel and HubSpot
  importers, Supabase mirror, Todoist two-way sync.
- MCP server (`/mcp`) with 70+ tools for Claude and other AI clients.
- Installable PWA with web push; native Android app with 13 home-screen widgets.
- Security: 2FA, audit log, device sessions, account lockout, SSRF protection, upload checks, security
  headers, daily backups; guided in-app academy with tours and a practice sub-account.

[Unreleased]: https://github.com/your-org/gohigh/compare/v0.0.18...HEAD
[0.0.18]: https://github.com/your-org/gohigh/releases/tag/v0.0.18
