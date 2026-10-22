# Telephony: menus, queues, numbers, power dialer and call intelligence

**Anrufe** is the call log of a sub-account – and, on top of the Twilio setup in [self-hosting](self-hosting.md#telefonie-twilio), a small call centre:

- a **telephone menu** (IVR) with greeting, keys, business hours and holidays, voicemail per branch and hand-over to a person, a ring group, a queue or the [AI phone agent](self-hosting.md#ki-telefonagent),
- **ring groups and queues** (all at once, in order, round robin; hold music, longest wait, overflow) and **call transfer** with notes during the call,
- **numbers**: buy and release them from Twilio inside the app, point each one somewhere, **tracking numbers** per campaign and **dynamic number insertion** (a number per visitor source on your website),
- a **power dialer** for call lists that respects *Nicht stören*, consent and calling hours on the server,
- **call intelligence**: transcript, summary, action items, topics, sentiment, talk-time ratio and filler words for recorded calls and uploaded meeting recordings, and **scorecards** with an AI pre-score and manager review,
- the **recording notice** (everybody is told before a call is recorded) and **retention** of recordings and voicemails.

Everything works per sub-account with the sub-account's own Twilio credentials, nothing calls anybody by itself, and nothing is bought or sent without a click. The pages are tabs of **Anrufe**: *Anrufliste*, *Power-Dialer*, *Gespräche*, *Telefonmenü*, *Nummern* (the last two need the area *Einstellungen*). Without any of this set up, calls behave as before.

- [Set up](#set-up)
- [Telephone menu (IVR)](#telephone-menu-ivr)
- [Schedules and holidays](#schedules-and-holidays)
- [Ring groups and queues](#ring-groups-and-queues)
- [During a call: notes and hand-over](#during-a-call-notes-and-hand-over)
- [Numbers, buying and release](#numbers-buying-and-release)
- [Tracking numbers and dynamic number insertion](#tracking-numbers-and-dynamic-number-insertion)
- [Power dialer](#power-dialer)
- [Call intelligence](#call-intelligence)
- [Scorecards](#scorecards)
- [Recording notice and retention](#recording-notice-and-retention)
- [Workflows, API and MCP](#workflows-api-and-mcp)
- [For developers](#for-developers)
- [Limits and good to know](#limits-and-good-to-know)

## Set up

1. **Twilio** as described in [self-hosting](self-hosting.md#telefonie-twilio) (*Einstellungen → Telefonie*: Account SID, Auth Token, numbers). Numbers bought inside the app get their webhooks set automatically; for numbers bought elsewhere use *Verbinden* in the same settings page.
2. **Browser phone** (optional, [docs](self-hosting.md#browser-telefon-twilio-voice-sdk)): needed to ring people in groups and to hand a call to a colleague's browser. People who are offline, away or on another call are skipped.
3. **A public `https://` address** (`PGHL_BASE_URL`): Twilio calls `/hooks/twilio/…`, every webhook is signed and checked.
4. **For call intelligence:** a speech-to-text connection (*Einstellungen → KI-Verbindungen*, capability *Sprache zu Text*) and – for summary, action items and scores – the [AI assistant](ai-assistant.md).
5. **For dynamic number insertion:** the pool's script on your website (funnels and landing pages of the sub-account get it automatically).

## Telephone menu (IVR)

*Anrufe → Telefonmenü → Menüs.* A menu is a set of **steps**, drawn as a tree. Click a step to edit it; where it leads next is a choice from the existing steps (or **＋ a new step**).

| Step | What it does |
| --- | --- |
| *Menü* | Plays a greeting (read by the German voice or your own recording), waits for **one key** (0–9, `*`, `#`), repeats up to *Wiederholungen* times, then follows *keine Eingabe* / *falsche Taste*. |
| *Zeitplan* | Branches on a [schedule](#schedules-and-holidays): *geöffnet*, *geschlossen*, *Feiertag*. Without a schedule it uses the business hours of *Einstellungen → Telefonie*. |
| *Ansage* | Plays a message, then continues. |
| *Weiterleiten* | Rings numbers and the browsers of chosen people at once; *niemand erreichbar* leads on. |
| *Gruppe* | Hands the call to a [ring group or queue](#ring-groups-and-queues). |
| *Voicemail* | A **mailbox of its own** (*Vertrieb*, *Support*): greeting, recording, notification with the box name, optional callback task for a person. |
| *KI-Telefonagent* | The AI phone agent takes the call (even when its mode would not answer now); if it is off or fails, the next step runs. |
| *Auflegen* | A last sentence, then the call ends. |

The path a call took (*Hauptmenü › Taste 2 Support*) is written onto the call and shown in the call log. **Testlauf** walks the *saved* menu with key presses ("1", "12", `_` for "no input") at a chosen time without dialling anyone – ideal for checking holidays and evenings. The builder warns about unreachable steps, menus without keys and loops that never ask for a key.

A number leads to a menu via *Nummern → Nummer → Wohin führt ein Anruf?*. Nothing is kept between requests: the position in the menu travels in the signed webhook URL, so a restart never drops a caller.

## Schedules and holidays

*Telefonmenü → Zeitpläne.* Per weekday one to four periods (a lunch break is two periods; an overnight period such as 22:00–02:00 runs until the next morning), **statutory holidays** of Germany (fixed ones plus the Easter-based ones, per *Bundesland*; the *Buß- und Bettag* only in Saxony) and **own entries**: `12-24` repeats every year, `2026-12-24` applies once, each *geschlossen* or with special hours. Own entries beat the statutory ones. All times are in the sub-account's timezone.

## Ring groups and queues

*Telefonmenü → Gruppen & Warteschlangen.* Members are **people** (they ring in the browser phone while they are reachable, not away and not on another call) and **numbers** (always).

- **Distribution:** *alle gleichzeitig*, *der Reihe nach* (fixed order) or *reihum* (round robin: whoever took the last call goes to the end).
- **Ruf-Gruppe:** one round of ringing, then the **overflow**.
- **Warteschlange:** the caller hears an optional welcome, then **hold music** (your own file under *Audio* or a built-in melody) and their **position**, while the members are tried again – until the *längste Wartezeit*. Callers are served first come, first served.
- **Overflow:** the normal flow (AI agent or voicemail), a voicemail with its own greeting and box, a number, another group, the AI phone agent or hang up.
- **Zahlen** per group: calls offered, answered, abandoned while waiting, average and longest wait, share answered within 20 s, answers per member.

The queue is built from plain webhooks (a `<Dial>` attempt, a hold segment, a redirect back), not from Twilio Queues, so it needs no extra Twilio resource and works the same with the browser phone and with numbers.

## During a call: notes and hand-over

In the browser phone (and for every call in the call log):

- **Notiz:** a note written during or after the call stays with the call (with the second it was written at) **and** appears in the contact's notes and timeline.
- **Übergeben** to a colleague (their browser phone must be open) or any number, in two ways:
  - **Sofort weiterleiten** (*cold*): the other party is redirected at once; if nobody answers, an inbound caller gets the normal voicemail.
  - **Mit Ansage** (*announced*, "warm"): the call is put on hold, the colleague is rung, hears *who* is calling and your note, and presses **1** to accept – then joins the caller. Any other key, no key or an unreachable colleague leaves the caller on hold with you.
- The hand-over, the new owner and the outcome are recorded on the call and the contact's timeline. It cannot be handed to a group (use a number or a person).

## Numbers, buying and release

*Anrufe → Nummern.* Every number of the sub-account has a **label**, a **kind** (*Hauptnummer*, *Tracking-Nummer*, *Pool-Nummer*) and a **route**: *normaler Ablauf* (forward to your mobile and browsers during business hours, else AI agent or voicemail), *Telefonmenü*, *Ruf-Gruppe*, *KI-Telefonagent*, *Voicemail* (a box), *Weiterleitung* (a number) or *Person* (their browser phone).

**Buy a number** (*Nummer kaufen*): search by country, type (*Ortsnummer*, *Mobilnummer*, *Gebührenfrei*), area code and wanted digits; Twilio's stock and monthly price are shown; you pick one, set label and use, and confirm explicitly. **Nothing is bought without the confirmation checkbox** (the API insists on `confirm: true`). The number gets its webhooks set and joins the sub-account.

**Germany (and Austria, Switzerland):** Twilio sells numbers there only with an **address** in the country and an **approved regulatory bundle** (proof of business or identity, reviewed by Twilio within a few working days). Both are created once in the Twilio console (*Phone Numbers → Regulatory Compliance*); the dialog lists the addresses and bundles of the account, pre-selects the only fitting one, says exactly what is missing and links to the console. If Twilio still refuses, its reason is shown with an explanation in German.

**Release** gives a number back to Twilio (after a confirmation) – it stops costing money and cannot be recovered. Numbers that were not bought here must be released in the Twilio console. Released numbers are listed for reference.

## Tracking numbers and dynamic number insertion

Two ways to know which campaign made the phone ring:

1. **Static tracking numbers** – a number printed on a flyer, an ad or a van: set *Art = Tracking-Nummer* and *Quelle / Medium / Kampagne*. Every call on it carries them.
2. **Pools** (*dynamic number insertion*, DNI) – your website shows each visitor a number from a pool, chosen by where they came from. *Nummern → Pools für die Website → Neuer Pool*:
   - *Nummer, wie sie auf der Website steht*: the number as written in your pages (any way of writing it) – it is replaced for visitors of the chosen sources; everybody else keeps the normal number,
   - *Nur für diese Quellen*: e.g. `google/cpc`, `facebook`, `newsletter` (empty = every visitor with a campaign or search-engine origin),
   - how long a visit holds a number (*Besuch zählt*), how long after leaving a call is still attributed, what happens when all numbers are in use (*Ersatznummer* or share the oldest) and an optional CSS area,
   - put the **snippet** `<script src="https://<your-domain>/a/<sub-account-id>/dni.js?pool=<pool-id>" async></script>` in the `<head>` of your site; funnel and landing pages of the sub-account get it automatically (switch off per pool). Browsers and CDNs keep the script for 5 minutes (`Cache-Control: public, max-age=300`, like the attribution snippet `t.js`), so switching a pool on or off shows within that time.

The script replaces the number in page text and in `tel:` links (also text that appears later on single-page sites); mark any element with `data-pghl-phone` to have it replaced regardless of how the number is written. It follows the **cookie banner**: when the visitor refuses (or sends *Global Privacy Control*) nothing is requested and the normal number stays.

The visitor's origin comes from the **existing attribution** of the app (UTM parameters, `gclid`/`fbclid`, referrer, signed visitor token). When someone calls a pool number during or shortly after the visit, the call is tied to that visit and the contact gets the same first/last touch as from a form, so *Attribution* reports, deals and revenue by source include the call.

*Anrufe nach Quelle* (below the pools; CSV export): calls, answered, missed, average duration and callers by source, campaign or number. Limits: each visitor holds one number at a time; if a pool is smaller than the number of simultaneous visitors, the rest see the *Ersatznummer* (their calls count as "ohne Quelle").

## Power dialer

*Anrufe → Power-Dialer.* A **call list** comes from a *Smart List* or a *Tag* (only contacts with a phone number). *Starten* offers one contact after the other: *Anrufen* (in the browser phone, otherwise click-to-call to your mobile), then the **outcome** – *Interessiert*, *Termin vereinbart*, *Rückruf vereinbart*, *Nicht erreicht*, *Besetzt*, *Mailbox*, *Falsche Nummer*, *Kein Interesse*, *Nicht mehr anrufen* (the codes are editable) – with a note. The next contact follows automatically after a short pause (*Automatisch weiter*).

- **The server decides** who may be called – for the dialer, for the browser phone and for click-to-call alike, in this order: has a number → not *Nicht stören* → no channel-level do-not-disturb → **consent** (the sub-account's consent rule, or *streng*: only a confirmed phone consent) → **calling window** (days, hours, optionally no statutory holidays) → attempts left (default 3) → pause after the last attempt. Blocked contacts are marked with the reason and checked again when the list is synced.
- **Rückruf vereinbart** needs a date and time and becomes a **task** for you (or a colleague) at that time; due callbacks come first in the list.
- ***Nicht mehr anrufen*** withdraws the contact's phone consent in the ledger, stops every open entry of that contact in all lists and tags the contact.
- **Mailbox:** *Nachricht abspielen* plays a recording you chose for the list (*Telefonmenü → Audio*, kind *Voicemail-Drop*) to the answering machine and hangs up; the entry gets the outcome *Nachricht hinterlassen*.
- Two people never get the same contact; an entry left open (browser closed) is released after a few minutes. **Meine Rückrufe** and the stats (calls, reached, successes) are on the overview.
- Outcomes are workflow triggers (*Power-Dialer: Ergebnis*, filter by code) and events; every outcome lands in the contact's timeline.

> Cold calls to consumers need prior express consent in Germany, to businesses at least presumed consent (§ 7 UWG). The dialer enforces what you record – the legal assessment of your lists stays with you.

## Your own number as caller ID

*Einstellungen → Telefonie → Eigene Nummer als Absender*: call out with your **existing landline or mobile number** instead of the Twilio number (Twilio *Verified Caller IDs*).

1. *Nummer bestätigen*, enter the number (`+49…`) and an optional label → *Bestätigungsanruf starten*. HyperLevel asks Twilio for a verification (`OutgoingCallerIds`), Twilio **calls that number** and HyperLevel shows a **six-digit code**.
2. Pick up and type the code. Twilio reports the result to a signed status callback (`/hooks/twilio/caller-id-status/<sub-account>`); *Prüfen* asks Twilio's list in case the callback did not arrive. A number already verified in the Twilio console is taken over.
3. Choose the **Standard-Absender** (a Twilio number or a verified one). It applies to the **browser phone**, **click-to-call** and the **power dialer** (a list's own sender wins) and to [outbound AI calls](voice.md#outbound-ai-calls). Click-to-call takes `from`, the browser phone the call parameter `callerId`; anything that is neither a Twilio number of the sub-account nor verified falls back to the default.

Only the caller ID changes: calls still run through Twilio (and cost the same), and calls *to* your own number keep arriving where they did. Removing a number deletes the verification at Twilio too. API (area *Einstellungen*): `GET /api/caller-ids`, `POST /api/caller-ids` `{number, name}` → `{status: pending, validation_code}`, `POST /api/caller-ids/:id/check`, `PUT /api/caller-ids/default` `{number}`, `DELETE /api/caller-ids/:id`. Other modules ask `app.services.callerIds.pick(locationId, wanted)` / `.allowed(locationId)`.

## Call scripts

*Anrufe → Leitfäden* (settings right): scripts made of steps – a text with placeholders (`{{contact.first_name}}`,
`{{contact.company}}`, `{{location.name}}` …, with fallbacks like `{{contact.first_name|du}}`) and answer buttons that jump to
another step or end the script (branches). A script applies to chosen power-dialer lists and/or to contacts with an open deal in
chosen pipelines; one without either applies everywhere else. It may name a call scorecard ([Scorecards](#scorecards)), which the
panel links. During a call the **browser phone** and the **power dialer** show the matching script (list first, then pipeline,
then the general one; another one can be picked) through the UI slot `call.panel` (`web/src/slots.tsx`) – one step at a time,
with *Zurück*. API: `GET/POST /api/call-scripts` (`{name, steps: [{id, title, text, options: [{label, next}]}], dialer_list_ids,
pipeline_ids, scorecard_id, active}`), `PATCH/DELETE /api/call-scripts/:id`, `GET /api/call-scripts/for?contact_id=&list_id=`
(the script for a call with the contact filled in, plus `others` and `scorecard`). Scripts travel in snapshots (pipelines point
at the copies; lists and scorecards stay behind) and edits and deletes are in the undo journal (module `call-scripts`).

## Call intelligence

*Anrufe → Gespräche.* Analyses of **recorded calls** (*Anrufliste → ✨*, or automatically) and **uploaded meeting recordings** or pasted **transcripts** (Teams, Zoom, Meet):

1. **Transcript.** Recorded calls have two audio channels; each side is transcribed separately, so the transcript is labelled *Mitarbeiter* / *Gegenüber* (an uploaded single-channel recording or a pasted transcript has no speaker separation). Long recordings are cut into pieces for the speech provider.
2. **Counted, no AI needed:** talk-time ratio and longest monologue (measured on the audio), number of turns, words, questions, filler words per 100 words (built-in list plus your own), speech rate, keywords and a word-list sentiment.
3. **AI analysis** (the AI assistant, purpose *Gesprächsanalyse*; limits and logs as everywhere): title, summary, next step, **action items** (who, by when), topics, objections and sentiment. If the AI is unavailable, the counted part stays and *Erneut versuchen* repeats the analysis.
4. **Effects:** the summary is written to the **contact's timeline** (and the call log), action items become **tasks** with one click (or automatically for your own side), the trigger *Gespräch ausgewertet* fires, and other modules can read the summaries (`app.services.callSummaries`).

**Privacy by default.** The analysis of every recorded call is **off**: it sends audio to the speech provider you chose. Switch it on under *Einstellungen* (*Jedes aufgezeichnete Gespräch automatisch auswerten*) only when the recording is lawful and the provider is in your privacy notice and processing agreement. Uploading a recording requires the checkbox that **everybody was informed and agreed**. Uploaded audio is deleted after the transcript exists; the analyses follow your retention setting (*Aufbewahrung in Tagen*); an erased contact (GDPR) takes its analyses and audio with it.

Per person the page shows calls, talk share, filler words and scorecard average – for coaching, not for ranking. Works councils and data protection rules for employee evaluation are yours to check.

## Scorecards

*Gespräche → Scorecards.* A scorecard has **criteria** with a weight (1–10) and a scale (*Ja/Nein* or *1 bis 5*); templates for sales and customer service are included. **KI bewertet vor** reads the transcript and proposes a score per criterion with a **reason and a quote** (a criterion that does not apply is left out). A **manager** (administrators and people with access to *Einstellungen*) reviews: per criterion the manager's score counts, otherwise the AI's; the total (0–100) follows, the AI's proposal stays visible. A *Standard-Scorecard* is pre-scored automatically after each analysis. *Auswertung* shows per criterion and per person where coaching is needed.

## Recording notice and retention

*Einstellungen → Telefonie → Aufzeichnung.* Recording a call is allowed in Germany only when everybody knows (§ 201 StGB, GDPR). Hence:

- **Hinweis vor der Aufzeichnung** (on by default when recording is on): the *caller* of an inbound call hears the notice before being connected; for outbound calls (click-to-call, browser phone, power dialer) the *called person* hears it before the call is bridged. The wording is yours (*Wortlaut des Hinweises*, default: "Dieses Gespräch wird zur Qualitätssicherung aufgezeichnet. Wenn Sie damit nicht einverstanden sind, beenden Sie bitte jetzt das Gespräch."). The call records that the notice was played. Switching the notice off shows a warning – then everybody must have agreed beforehand.
- **Aufbewahrung:** *Aufnahmen löschen nach … Tagen* and *Voicemails löschen nach … Tagen* (0 = keep). An hourly job deletes the recording **at Twilio** and clears it and its transcript in the call log (the call itself stays); if Twilio is unreachable it tries again. Twilio's own storage settings are separate.
- **DSGVO-Löschung** of a contact deletes its recordings and voicemails **at Twilio** too, right after the erase; ids Twilio does not confirm stay queued (`call_recording_purges`) and are retried every hour.

## Workflows, API and MCP

**Triggers:** *Anruf verpasst*, *Voicemail erhalten*, *Anruf beendet* (as before), *Power-Dialer: Ergebnis* (filter: outcome code), *Gespräch ausgewertet* (filter: sentiment). **Events:** `call.recorded`, `call.transferred`, `call.analyzed`, `call.scored`, `dialer.disposition`, `dialer.voicemail_drop`, `phone_number.bought`, `phone_number.released`. **MCP:** `ghl_call_analyses`, `ghl_call_analysis` (read only) next to `ghl_list_calls`.

| Area | Endpoints |
| --- | --- |
| Menus | `GET/POST /api/telephony/ivr`, `GET/PUT/DELETE /api/telephony/ivr/:id`, `POST /api/telephony/ivr/:id/simulate` `{keys, at}`, `GET /api/telephony/ivr/meta` |
| Schedules | `GET/POST /api/telephony/schedules`, `PUT/DELETE /api/telephony/schedules/:id`, `GET /api/telephony/schedules/holidays?year&state` |
| Groups and queues | `GET/POST /api/telephony/groups`, `GET/PUT/DELETE /api/telephony/groups/:id`, `GET /api/telephony/groups/:id/stats`, `GET /api/telephony/groups/meta` |
| Audio | `GET/POST /api/telephony/audio` (raw MP3/WAV with `?name&kind`, or `{name, kind, text}`), `PATCH/DELETE /api/telephony/audio/:id` |
| Numbers | `GET /api/telephony/registry`, `PATCH /api/telephony/registry/:id`, `GET /api/telephony/numbers/search?country&type&area_code&contains`, `GET /api/telephony/numbers/pricing`, `GET /api/telephony/regulatory`, `POST /api/telephony/numbers/buy` (`confirm: true`), `POST /api/telephony/numbers/:id/release` (`confirm: true`) |
| Tracking | `GET/POST /api/telephony/dni/pools`, `PUT/DELETE /api/telephony/dni/pools/:id`, `PUT /api/telephony/dni/pools/:id/numbers`, `GET /api/telephony/tracking/report(.csv)?group=source|campaign|number&from&to`; public `GET /a/:loc/dni.js`, `POST /api/public/dni/:loc/session` |
| During a call | `GET/POST /api/calls/:id/notes`, `DELETE /api/calls/:id/notes/:noteId`, `POST /api/phone/calls/:id/transfer` `{to: {type: user|number, id}, mode: cold|warm, note}`, `GET /api/phone/calls/:id/transfer`, `GET /api/phone/colleagues` |
| Power dialer | `GET/PUT /api/dialer/settings`, `GET/POST /api/dialer/lists`, `GET/PATCH/DELETE /api/dialer/lists/:id`, `POST …/sync`, `GET …/items`, `POST …/next`, `POST /api/dialer/items/:id/dial|skip|disposition`, `POST /api/dialer/calls/:callId/drop`, `GET /api/dialer/callbacks`, `GET /api/dialer/stats` |
| Call intelligence | `GET /api/call-intel`, `GET /api/call-intel/stats`, `GET/PUT /api/call-intel/settings`, `POST /api/call-intel/upload` (raw audio, `?consent=1`), `POST /api/call-intel/text`, `POST /api/call-intel/calls/:callId/analyze`, `GET/PATCH/DELETE /api/call-intel/:id`, `POST …/retry`, `POST/PATCH …/action-items/:n[/task]` |
| Scorecards | `GET/POST /api/call-scorecards`, `PUT/DELETE /api/call-scorecards/:id`, `GET /api/call-scorecards/templates`, `GET /api/call-scorecards/:id/report`, `POST/GET /api/call-intel/:id/scores`, `PUT /api/call-intel/:id/scores/:sid/review` |

Menus, numbers, queues, tracking and scorecard management belong to the area *Einstellungen* (`settings`); the call-related routes, the dialer and the analyses to *Konversationen* (`conversations`).

## For developers

New features plug in through the registries; the telephony modules are `telephony-audio`, `telephony-numbers`, `telephony-ivr`, `telephony-queues`, `telephony-dni`, `telephony-calls`, `dialer`, `call-intel`, `call-scorecards` (pure logic in `services/ivr.ts`, `call-groups.ts`, `call-audio.ts`, `twilio-numbers.ts`, `dni.ts`, `dialer.ts`, `call-intel.ts`). Hooks in `app.services`:

- `callRouters` – list of `(input: {loc, call, cfg, open, params}) => TwiML | undefined`; the first answer takes an inbound call before the AI agent and the default forward (numbers' routes run through it).
- `callRouteKinds` – `{kind: (input & {number}) => TwiML | undefined}` for what a number can point at (`ivr`, `group`, `ai`, `voicemail`, `forward`, `user`); a module adds its own kind.
- `callInbound` – list of `(input) => void` run when an inbound call row is created (tracking attribution).
- `telephonyKit` – `hookRoute(name, fn)` (signed webhook under `/hooks/twilio/<name>/:loc`), `hook(name, loc)`, `callBySid`, `voicemail(loc, cfg, call, {greeting, box, record})`, `unanswered`, `isOpenNow`, `settleDial` – what the modules share.
- `callGroups.enter`, `voiceUserClient(loc, userId, call)` (a person's browser as a dial target, `null` when unavailable), `audioUsage` (list of `(loc, audioId) => reason | undefined` that stop a file from being deleted).
- `dialer` – `authorize(loc, itemId, userId)` (→ `{ok, reason, itemId, from}` – `from` is the list's caller ID), `verdict`, `settings`; the browser phone, `POST /api/calls` and the outbound AI calls ask it before a call.
- `callerIds` – `pick(loc, wanted)` and `allowed(loc)`: the caller ID of a call (Twilio numbers and verified own numbers, module `caller-ids`).
- `callIntel` (`enqueueCall`, `idle`), `callScorecards.score`, `callSummaries` (`list`, `get`, `subscribe` – a module can attach summaries to deals) and `telephonyRetention.sweep(loc)`.
- `VoiceAgentInput.force` lets a route hand a call to the AI agent regardless of its mode.
- Test hooks: `twilioFetch` (all Twilio REST, pricing and numbers hosts), the speech and AI hooks of the voice and AI modules.

The webhooks created here are `ivr`, `ivr-dial`, `group-dial`, `group-wait`, `phone-transfer`, `voice-announce` and `audio/:file`; all but the audio file check Twilio's signature. Tests: `tests/ivr-core.test.ts`, `telephony-routing.test.ts`, `telephony-dni.test.ts`, `dialer.test.ts`, `call-intel.test.ts`, `telephony-calls.test.ts` (no real call, number or speech/AI request – the isolation seeds are in `tests/security-fixtures.ts`).

## Limits and good to know

- A queue and a hand-over run on webhooks: they need the public address and a reachable server; a restart drops nothing (state lives in the database and the signed URLs).
- **Warm transfer** is "announced": the colleague answers a screening prompt and then joins the caller in a hold room; it is not a three-way conference with the person handing over.
- A call that rings a person's *browser* needs that person's browser phone open; otherwise only numbers ring and the flow continues with the overflow.
- Speaker separation needs a recording with a channel per party (calls recorded through the app have it). Uploads and pasted transcripts are analysed as one text; the transcript of a call is the two sides one after the other, not interleaved by time.
- Dynamic number insertion replaces text of the page and `tel:` links; a number inside an image or a PDF cannot be swapped (use `data-pghl-phone` on text elements).
- Buying and releasing numbers costs or saves money at Twilio; prices shown are Twilio's list prices and may differ from your invoice.
- Predictive dialling and answering-machine detection are not included: a person dials and decides.
