# Team inbox: assignment, status, notes and answer deadlines

The conversation page (menu **Konversationen**) is a shared inbox for small teams: every conversation can have an owner, a status, a snooze time and a priority; colleagues write internal notes and mention each other; the page shows who else is looking at (or typing in) a conversation; and answer deadlines tell you what is overdue. Settings live under **Einstellungen → Team-Posteingang** (and behind the **Team & Regeln** button on the conversation page).

Nothing needs credentials. Notifications use what is already set up: push and the Android app (see [app.md](app.md)) and the sub-account's outgoing e-mail. Permissions: the conversations area for everyday work, the settings area for rules, deadlines and other people's availability.

Existing conversations are adopted on first start: what was read and quiet for a week counts as done, everything else is open and unassigned. Nothing is lost and nobody is notified.

## Views and the list

The rail on the left of the list shows how many conversations wait in each view:

| View | Shows |
| --- | --- |
| Mir zugewiesen | open, not snoozed, owned by you |
| Nicht zugewiesen | open, nobody owns it |
| Offen | everything open and not snoozed |
| Team | open conversations owned by a person or a team |
| Wartet auf Kontakt | status "waiting" |
| Zurückgestellt | snoozed until later |
| SLA gefährdet | answer deadline close or missed |
| Erwähnungen | internal notes that mention you and that you have not opened yet |
| Erledigt / Alle | closed / everything |

Each row shows the owner, priority (high and urgent), status, snooze time and, when a deadline is close or missed, a coloured chip. The checkbox on the left selects rows for **bulk actions** (assign, close, snooze). The view is remembered per browser.

The existing filters (search, channel, unread, starred, drafts, mailbox) combine with the views. `GET /api/conversations` accepts `view=`, `assignee=` (`me`, `none` or a user id), `status=` and `priority=` as well.

### Filters and message search

**Filter** under the search field folds out four more filters, like in the contact list: **tag** (the contact has it), **pipeline** and **stage** (the contact has an *open* deal there) and **owner** of the contact (*Meine Kontakte*, *Ohne Zuständigen* or a person). They combine with views, channel and mailbox; *Filter zurücksetzen* clears them. API: `tag=`, `pipeline_id=`, `stage_id=`, `owner=` on `GET /api/conversations`.

The search field looks at names, e-mail, phone and the last message. To search the **text of every message** (all channels, subject and body), type at least two characters and click *„…“ in allen Nachrichten suchen*: the hits show contact, channel, date and the passage with the words marked; a click opens the conversation. Word beginnings are enough (*rech* finds *Rechnung*), case and accents do not matter (*kuche* finds *Küche*), every word must appear. The filters above apply to the hits too, and so do record access, spam and private mailboxes. Under the hood: an SQLite FTS5 index kept by triggers on every message (`messages_fts`; existing messages are indexed once on first start – large databases in short slices in the background, the answer says `complete: false` until then), with a LIKE fallback where FTS5 is missing. API `GET /api/conversations/search?q=`, MCP `ghl_search_messages` (read-only).

### Keyboard

`J`/`K` next/previous conversation · `E` close or reopen · `A` assign to me · `S` snooze · `N` write an internal note · `R` write a reply · `X` mark for bulk actions · `/` search · `?` help. They are off while a field has the focus. Every control is at least 44 px high and has a visible focus state, so the page works with touch, eye tracking and pinch as well.

## Assignment

Above a thread: **Zuständig** (a person, a helpdesk team or nobody), **Mir zuweisen**, the status buttons, **Zurückstellen** and the priority. Every change appears in the thread as a grey line (who did what), is written to the audit log and starts the workflow triggers below. The new owner gets a push message (and optionally an e-mail).

**Automatic assignment** (Einstellungen → Team-Posteingang → Zuweisung):

- *Von Hand* – nobody is assigned automatically.
- *Reihum* – round robin through the pool. The pointer is kept per pool, so a rule that targets a team has its own turn order.
- *Geringste Auslastung* – whoever has the fewest open conversations.

The pool is everybody with the conversations area, one helpdesk team (Einstellungen → Service → Teams) or chosen people. Options: skip people who are away or paused; give the contact's owner (Kontakte → Zuständig) the conversation first; send the next message to somebody else when the owner is away; and "whoever answers an unassigned conversation owns it".

**Rules** run top to bottom, the first match wins. A rule matches by channel (e-mail, SMS, chat, WhatsApp …) and/or contact tags and then assigns a person, a team or the pool, optionally setting a priority.

**Availability** (Einstellungen → Team-Posteingang → Verfügbarkeit, or **Meine Verfügbarkeit** on the conversation page): everybody can pause new assignments, enter weekly working hours and out-of-office periods (quick buttons for today, tomorrow, 7 days). Approved absences of the Personal area (HR) count automatically. The same availability is used by round-robin calendars ([team-calendars.md](team-calendars.md)). Agency admins and members with the settings area can edit other people's entries.

## Status, snooze and priority

Status is **Offen**, **Wartet auf Kontakt** or **Erledigt**. A new inbound message reopens a closed or waiting conversation (and wakes a snoozed one). Optionally your own reply sets "Wartet auf Kontakt".

**Zurückstellen** hides a conversation until a time (presets: 1 or 3 hours, this evening, tomorrow 8:00, next Monday, a week, or your own time). It comes back at that time or earlier when the contact writes. Snoozed conversations do not run into answer deadlines; the timer continues from the wake-up.

Priority is low, normal, high or urgent. **Automatically close** (Einstellungen → Zeiten & Aufräumen) closes conversations nobody answered N days after our last message.

## Internal notes and mentions

**Interne Notiz schreiben** adds a note to the thread. Notes are yellow, dashed and labelled "nur fürs Team sichtbar": they are never sent to the contact, never part of the message list of the API, and they are exported and erased with the contact (GDPR). Typing `@` offers the team; a mentioned person is notified in the app and by push (and by e-mail, switchable) and finds the conversation under **Erwähnungen** until they open it. Authors delete their own notes, admins any.

## Who else is here

The page keeps one live connection (`GET /api/inbox/stream`, server-sent events) and reports every 15 seconds which conversation you look at. A colleague who opens the same conversation sees "Anna Schmidt sieht sich diese Konversation gerade an"; while Anna types a reply it becomes "Anna Schmidt schreibt gerade…" so two people do not answer the same message. Presence is kept in memory only (45 seconds) and nothing is stored. The live connection ends with the login it was opened with (signing out, a revoked session or a new password at once, an expired session within 20 seconds) and when the person loses the inbox or the sub-account.

## Answer deadlines (SLA)

Switch on under **Antwortfristen**. The **first response** deadline starts when a contact writes into an unanswered conversation; the **next response** deadline when they write again after our answer. The first human answer (a person, not an automatic mail or bot) ends it. A warning fires at a chosen share of the deadline, a miss marks the conversation red, notifies the owner (push, optionally e-mail) and starts the trigger *Antwortfrist im Posteingang überschritten*.

Deadlines count **business hours** (own weekly hours and holidays in Zeiten & Aufräumen) or round the clock; the calculation is the same as for helpdesk tickets ([helpdesk.md](helpdesk.md#slas)). Phone calls never start a timer, and imported old messages never do (a message older than two days when it arrives is ignored).

## Workflows

| | |
| --- | --- |
| Triggers | `conversation.assigned` (optional filter: assignee), `conversation.status_changed` (filter: new status), `conversation.sla_breached` (filter: first / next) |
| Steps | **Konversation zuweisen** (a person, automatically by the rules, or nobody), **Konversation: Status setzen** (open, waiting, closed, snooze, priority), **Interne Notiz** (with @mentions) |

Typical uses: send a satisfaction survey two days after "Erledigt", tell the boss when a deadline is missed, raise the priority of every message from a tagged contact. The steps act on the conversation of the run's contact and are named "Workflow" in the thread.

## Social comments

Comments under your Facebook, Instagram, YouTube and LinkedIn posts are an inbox channel of their own (*Kommentare*): assignment, deadlines and views treat them like messages, and each comment has *Antworten* (public), *Ausblenden* and *KI-Vorschlag* – see [social-comments.md](social-comments.md).

## SMS and WhatsApp drafts

The HyperLevel Agent, a custom agent or an outside assistant over MCP can prepare a reply as a **draft** instead of sending it:
`ghl_draft_message` (`contact_id` or `conversation_id`, `channel` `sms`|`whatsapp`, `body`) – the counterpart of
`ghl_draft_email`. It is a plain change (class *write*, so it follows the agent's confirmation level) and **never sends**.
A new draft replaces the previous one of the same author and channel in that conversation.

In **Konversationen** the draft opens right in the composer of its conversation, in its channel, with a line saying where it
came from: check it, change it if needed, press **Senden** – one click. A draft never overwrites what someone is typing: it only fills an empty
composer (or one still holding the previous draft untouched), otherwise a note **Neuer Entwurf verfügbar – übernehmen** swaps
it in on click. Sending uses the normal send path with all its rules:
DND asks first, SMS goes through the configured provider, and WhatsApp free text only goes out inside the **24-hour window**
(outside it the draft text stays visible and only an approved template can be sent; the tool result says `window_open` and
gives the agent a hint). After a successful send the draft disappears; **Verwerfen** (in the composer or in the thread bubble)
deletes it and can be taken back in the Verlauf. Drafts show under the list filter **Entwürfe** like e-mail drafts.

API: `POST /api/conversations/drafts` (`{contact_id | conversation_id, channel, body, source?}`, body up to 1,600 characters for
SMS and 4,096 for WhatsApp; the contact needs a phone number), discard with `DELETE /api/messages/:id` (drafts only), list with
`GET /api/conversations/drafts` (now with `channel`). Permission area *Konversationen*; everything stays in its sub-account.
Module `msg-drafts`.

## Spam and blocked senders

**Spam** in the header of a conversation marks the contact as spam and blocks it (reason: spam, harassment or other, plus an
optional note). From then on:

- Its new messages – e-mail and SMS, WhatsApp, Messenger and Instagram, Telegram, Discord and Slack, mail synced from Gmail
  or Outlook – are stored but **archived silently**: status *Spam (blockiert)*, no unread badge, no notification, and no
  `message.inbound` event, so no workflow, auto reply, AI answer or ticket reacts. STOP still switches DND on.
- Its **calls are rejected** before any telephone menu, ring group, queue or AI phone agent takes them; they are not counted
  as missed (no notice, no *missed call* workflow).
- Its conversations leave the inbox (read and closed) and show up under the list filter **Spam**. The header there shows
  how many messages and calls were intercepted and offers **Entsperren**; an unblock can be taken back in the Verlauf.

Workflows: the steps **Als Spam markieren & blockieren** (`block_contact`, reason and note) and **Blockierung aufheben**
(`unblock_contact`). API: `GET/POST /api/blocked-contacts` (`{contact_id, reason: spam|harassment|other, note}`; the
list carries the contact's name, e-mail and phone and the counters `blocked_messages`, `blocked_calls`),
`GET/DELETE /api/blocked-contacts/:contactId` (state, unblock). Permission area *Konversationen*. A block belongs to the
contact: it is part of the GDPR export, goes with an erased contact and with a deleted sub-account.

For developers: the receive hook `app.services.inboundGates` (`services/inbound-gate.ts`) is asked by every inbound path; a
gate that claims a message gets it to archive and the caller fires no event. The block's call router is put first into
`app.services.callRouters` (module `inbox-spam`).

## Reports

Two sources for [reports](reports.md): **Team-Posteingang: Konversationen** (volume per person, status, priority, time to first response, open rate) and **Team-Posteingang: Antworten** (every answered message with response time in business hours, responder, deadline and whether it was met; measures: average and longest response time, SLA rate). **Einstellungen → Team-Posteingang → Auswertung** shows the headline numbers and a per-person table for a chosen period.

## MCP tools and the app

MCP (HyperLevel Agent, Claude, ChatGPT, Codex): `ghl_inbox_queue` (list a view), `ghl_inbox_assign` (a person by id, e-mail or name, `me` or `none`), `ghl_inbox_set_status` (status, snooze, priority) and `ghl_inbox_note`. They use the same routes, permissions and audit log as the web page.

App endpoints (`/api/mobile/…`, device token): see [api.md](api.md#team-inbox-and-team-calendars).

## Self-hosting notes

- No new environment variables or services. The live connection is a normal HTTP response; behind a reverse proxy switch buffering off for `/api/inbox/stream` (the response carries `X-Accel-Buffering: no`, which nginx honours).
- The scheduler (every 15 seconds) wakes snoozed conversations, evaluates deadlines and closes quiet conversations. After a long downtime it catches up on the next run; deadlines are computed from stored times, not from counters.
- Push for assignments and mentions needs the push set-up described in [app.md](app.md); without it the notices appear in the app feed only.
