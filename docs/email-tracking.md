# E-mail tracking you can trust (opens and clicks)

HyperLevel measures opens (a 1×1 pixel) and clicks (links that go through `/t/c/<id>` and redirect) in campaign, workflow and inbox mail, and – opt-in – in mail you send from a connected mailbox. It also **tells people from machines**: Apple Mail Privacy Protection, Gmail's image proxy and corporate link scanners load pixels and follow links on their own, and counting those as "opened" and "clicked" made reports, lead scores and every workflow that reacts to them wrong. Now every hit is recorded with a verdict and a reason, **only people count**, and what the machines did is shown apart as **"+N maschinell"**.

- [What counts and what does not](#what-counts-and-what-does-not)
- [The rules](#the-rules)
- [Where you see it](#where-you-see-it)
- [Settings](#settings)
- [Mail from your own mailbox (opt-in)](#mail-from-your-own-mailbox-opt-in)
- [Privacy](#privacy)
- [Limits](#limits)
- [For developers](#for-developers)

## What counts and what does not

| Hit | Counts as | What happens |
| --- | --- | --- |
| **human** – looks like a person in a browser or mail app | opened / clicked | `messages.opened_at`, `open_count`, `clicked_at`, `click_count`, `tracked_links.clicks`; the contact's activity log; workflow triggers `email.opened` / `email.clicked`; lead score, health score, reports |
| **proxy** – a mail provider loaded the pixel for the recipient (Apple Mail Privacy Protection, Gmail, Yahoo …) | *maschinelle Öffnung* | only `messages.machine_open_count`; nothing else |
| **scanner** – a security gateway or bot followed a link or probed the pixel | *maschineller Klick* | only `messages.machine_click_count` and `tracked_links.machine_clicks`; nothing else |

A click that is recognised as a machine **still redirects** – a link is never broken. The same goes for `HEAD` requests (they get the redirect / the image headers, not a 404, so scanners do not flag your link as dead).

A person's click also counts as an open (many people block images). A machine click does not.

## The rules

Every hit is judged by `classifyHit` (`server/services/email-classify.ts`), most certain signal first. The first rule that matches wins:

| # | Signal | Verdict | Reason |
| --- | --- | --- | --- |
| 1 | `HEAD` request (pixel or link) | scanner | `head-request` |
| 2 | `Purpose` / `Sec-Purpose` / `X-Purpose` / `X-Moz` header says prefetch or preview | proxy | `prefetch` |
| 3 | User-Agent names a security product (Defender / Safe Links, Mimecast, Proofpoint, Barracuda, Forcepoint, Symantec, Sophos, Zscaler, Cisco IronPort, Fortinet, Kaspersky …) | scanner | `scanner-ua` |
| 4 | User-Agent is a mail provider's image proxy (`GoogleImageProxy`, `ggpht.com`, `YahooMailProxy`, …) | proxy | `proxy-ua` |
| 5 | User-Agent is a library, headless browser, crawler or link preview (`curl`, `python-requests`, `Go-http-client`, `HeadlessChrome`, `Slackbot`, `WhatsApp`, anything with `bot`, `crawler`, `spider`, `scanner` …) | scanner | `bot-ua` |
| 6 | **Opens only:** the User-Agent is exactly `Mozilla/5.0` (what Apple Mail Privacy Protection sends) or the address is in Apple's range `17.0.0.0/8` | proxy | `apple-mpp` | <!-- oss-check: allow -->
| 7 | No User-Agent at all | open: proxy, click: scanner | `no-user-agent` |
| 8 | An **open within 5 seconds** of sending (images are loaded on delivery, before anyone can read) | proxy | `fast-open` |
| 9 | A **click within 10 seconds** of sending | scanner | `fast-click` |
| 10 | A click on a **second, different link of the same mail within 2 seconds** – the earlier click(s) of that burst are re-judged too | scanner | `link-burst` |
| 11 | A click without `Accept-Language` (browsers always send it, HTTP libraries do not) | scanner | `no-browser-headers` |
| – | anything else | **human** | `human` |

The send time is the time the message was created (campaigns and messages: when it was queued, mailbox mail: when the provider accepted it).

**Clicks are held for 2.5 seconds** before they count. That is what lets rule 10 work: a scanner that looks like Chrome clicks all links within a moment, and the first click – judged alone as a person – is turned into a scanner click when the second arrives, *before* a workflow could have started. A person's click therefore shows up in the counters after about three seconds (the redirect itself is immediate). Opens count at once.

Apple Mail Privacy Protection is the hard case: when it is on, Apple fetches the pixel from its own servers whether or not the mail is read, with a bare `Mozilla/5.0` (rule 6) or from Apple's address range, and often within minutes of delivery. Those opens are removed. If the recipient turned the protection off, Apple Mail looks like any other app and counts as a person. Corporate scanners that use a plain Chrome or Edge User-Agent are caught by timing (rules 9, 10); a scanner that waits half a minute and clicks a single link cannot be told from a person.

## Where you see it

- **Campaign report** (*Kampagnen → eine gesendete Kampagne → Öffnungen & Klicks*): the rates and numbers are people; below, a muted **"+N maschinell"** (recipients that only had machine hits) with a tooltip that says what it means and lists the reasons ("Apple Mail Datenschutz: 12×, Sicherheits-Scanner: 3×"). Each link row shows its own `+N maschinell`. API: `GET /api/campaigns/:id/engagement` → `opened`, `clicked`, `open_rate`, `click_rate` (people), `machine_opened`, `machine_clicked` (recipients with only machine hits), `machine_open_events`, `machine_click_events`, `machine: [{reason, label, verdict, count}]`, `links: [{url, clicks, machine_clicks, people}]`.
- **Conversation and contact:** under every sent mail "geöffnet", "geklickt" (people) and a muted "+N maschinell". Messages carry `machine_open_count` and `machine_click_count` next to the existing columns.
- **Reports:** the sources *Nachrichten* and *Kampagnen* keep *Geöffnet*, *Geklickt*, *Öffnungsrate*, *Klickrate* (people) and gain *Maschinell geöffnet (nicht gezählt)* (and *Maschinell geklickt* for campaigns).
- **Workflows, lead scoring, health score** read the people-only columns and triggers – nothing to change in them.

Numbers from before the update are not corrected: the old counters were filled without any judgement and cannot be sorted afterwards (the User-Agent was never stored). From the update on, everything is judged.

## Settings

*Einstellungen → E-Mail & SMS → E-Mail-Versand*:

| Setting | Default | Effect |
| --- | --- | --- |
| **Öffnungen und Klicks messen** (`settings.email.tracking`) | on | off: no pixel, no link rewriting, for every mail of the sub-account (also mailbox mail) |
| **Öffnungen messen (Zählpixel einfügen)** (`settings.email.track_opens`) | on | off: **no pixel** is inserted, links are still tracked – the privacy-friendlier setting; opens are then simply not measured |
| **Öffnungen bei Geschäftsmails messen** (`settings.email.track_business_opens`) | on | off: no pixel in **business mails** – invoices, quotes, dunning letters, appointment confirmations, reminders and cancellations, SEPA and order mails (every mail sent as a service mail, `purpose: 'transactional'`); their links are still tracked. Campaign, workflow and conversation mails keep the pixel. On by default, so "has the customer opened the invoice?" keeps working as before |

**Never measured:** the double opt-in mail and its reminder – no pixel, no tracked links, whatever the switches say. The person has not consented yet ([docs/consent.md](consent.md#double-opt-in), § 25 TDDDG). Mails to users (sign-in link, invitation, cloud sign-up) are not tracked either.

## Mail from your own mailbox (opt-in)

Mail you send from HyperLevel through a connected Gmail / Outlook mailbox (new mail, replies from the inbox, scheduled sends) is **not tracked by default**. *Einstellungen → E-Mail & SMS →* the mailbox *→ Einstellungen → Öffnungen und Klicks verfolgen* turns it on for that mailbox. The hint next to the switch says it plainly: tracking 1:1 mail may need the recipient's consent – clear that first and mention it in your privacy notice.

- The reply composer shows the same switch for a tracking mailbox, so a single mail can go out untracked (`track: false` on `POST /api/mail/send` and the reply route; `track: true` never switches tracking on – the mailbox decides).
- The sub-account switches above still apply (tracking off = nothing is added).
- Not tracked: drafts (a draft you send later from Gmail or Outlook is the provider's, not ours), the plain-text part of a mail, and mail sent by other tools.
- Turning the switch on or off is written to the audit log (`mailbox.tracking`).
- Workflow and campaign mail that merely *use* a mailbox as the sender ("Verbundenes Postfach" as the e-mail provider) follow the sub-account switches, as before.

## Privacy

Per hit, `email_events` keeps: the message, the kind (open / click) and link, the time, the method, the verdict and reason, a short **device class** (`windows`, `ios`, `mac`, `bot`, `proxy`, `bare` …), a 12-character **one-way hash** of the User-Agent (to recognise the same client again), and the **network** of the address – IPv4 as `a.b.c.0/24`, IPv6 as `a:b:c::/48`. The full address is looked at once to judge the hit (Apple's range) and never stored; the User-Agent string is never stored.

- Events older than **400 days** are deleted (hourly job); the counters on the message stay.
- A message is capped at 300 events, so a leaked pixel address cannot fill the table.
- GDPR: the contact export (`/api/contacts/:id/privacy-export`) lists the events (without the hash); erasing the contact deletes events and tracked links.
- Opens and clicks of 1:1 mail may need consent (see above). Switching the pixel off keeps click tracking only.

## Limits

- It is a heuristic, not a lie detector. The rules are public and conservative; every verdict keeps its reason so you can see why a hit did not count.
- A person who clicks within 10 seconds of the send (a test mail to yourself) is judged a scanner. Wait a little for tests.
- Text-only mail has no pixel; people who block images never show up as opened (but their click does).
- Counts of unique recipients (`opened`, `clicked`) are per message; `open_count` counts every human load.

## For developers

- **Classification:** `server/services/email-classify.ts` – pure functions (`classifyHit`, `ipPrefix`, `uaClass`, `uaHash`, `isAppleIp`), constants `OPEN_FAST_MS`, `CLICK_FAST_MS`, `BURST_WINDOW_MS`, `BURST_MIN_LINKS`, and German `REASON_LABEL`. To teach it a new scanner or proxy, add the name to `SCANNER_UA` / `PROXY_UA` / `BOT_UA` and a case to `tests/email-tracking.test.ts`.
- **Recording:** `server/services/email-events.ts` – `recordHit` (judges and stores), `commitClicks` (applies clicks whose hold is over), `pruneEvents`, `machineBreakdown`. The module `server/modules/tracking.ts` owns the routes (`GET` and `HEAD` on `/t/o/:id` and `/t/c/:id`), the tables and the hooks.
- **Hooks (`app.services`):** `instrumentEmail({locationId, messageId, contactId?, html, purpose?}) → html` – adds tracked links and the pixel (respects `email.tracking` and `email.track_opens`, and `email.track_business_opens` for `purpose: 'transactional'`); `contactId` may be left out (the message knows its contact when a hit arrives). `sendToContact(…, { track: false })` skips the hook entirely (the double opt-in mail). Called by `sendToContact` and, for opted-in mailboxes, by `sendMail` in `services/mailbox-send.ts` – other features call the hook, never the module. `trackingCommit({force?})` applies waiting clicks at once (tests; the tick does it as a backstop).
- **Tables / columns:** `email_events` (`location_id`, `message_id` → `messages` (cascade), `contact_id`, `link_id`, `kind`, `at`, `method`, `ua_class`, `ua_hash`, `ip_prefix`, `classification` human | proxy | scanner, `reason`, `applied`); `messages.machine_open_count`, `messages.machine_click_count`, `tracked_links.machine_clicks`; `mailboxes.track_engagement`. `opened_at`, `open_count`, `clicked_at`, `click_count` and `tracked_links.clicks` keep their names and now mean people.
- **Tests:** `tests/email-tracking.test.ts` (rules, endpoints, privacy), `tests/email-tracking-mailbox.test.ts` (mailbox opt-in); the tenant-isolation fixtures seed events and a tracked link per sub-account.
