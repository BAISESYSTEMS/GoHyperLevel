**English** · [Deutsch](helpdesk.de.md)

# Service: tickets, SLAs, knowledge base, surveys & health score

HyperLevel's helpdesk – comparable to HubSpot Service Hub. The **Service** menu has *Tickets*, *Knowledge base* and *Surveys*; settings are under **Settings → Service**. Permissions: area **Service** (client logins need the “Service” checkbox); the service settings belong to the *Settings* area, health scores to *Contacts*. In SaaS mode, the plan must include the “Service” area (existing plans do not get it automatically – tick it under Agency → SaaS → Plan).

No credentials needed: replies go out through the sending method that is set up (Settings → Email & SMS, channels for WhatsApp); e-mail → ticket works through a forward to a webhook URL.

## Tickets

A ticket has a subject, description, **status** (a stage of a ticket pipeline), **priority** (low, normal, high, urgent), category, tags, **assignee** (login) and **team/queue**, contact (and an empty field `company_id` for a later company object), **source** (e-mail, chat, WhatsApp, SMS, form, portal, phone, manual, API, workflow), due date, internal notes and a **history** with customer messages, replies, notes, status, priority and assignment changes, SLA warnings and ratings.

**Pipelines:** the default is *New → In progress → Waiting for customer → Resolved → Closed*. Under *Settings → Service → Pipelines* you can create any number of pipelines with their own stages; each stage has a meaning (*New*, *Open*, *Waiting*, *Resolved*, *Closed*) and optionally “Pause SLA”.

**Views:** list or kanban (drag & drop between stages), filters by status, priority, assignee (“Assigned to me”, “Unassigned”), team, category, source, SLA (“expires soon”, “breached”) and search (subject, text, contact, `#number`). Filters can be saved as a **view** – for you only or for the team. **Bulk actions:** status, priority, assignment, team, tag, merge, delete.

**Merging:** duplicates (e.g. someone wrote twice) into one ticket: history, tags and contact move over, the others are closed and point to the target.

### Where tickets come from

| Way | How it works |
| --- | --- |
| Conversations | **Create ticket** button in the conversation – links the conversation and takes over the last customer message. If a ticket already exists, the button takes you there. |
| Support mailbox | *Settings → Service → Email → ticket*: enter the URL shown (`/hooks/<sub-account>/support-email?key=…`) as the target of a mail forward (Cloudflare Email Workers, ImprovMX, Mailgun Routes …; JSON or form with `from`, `to`, `subject`, `text`/`html`). Every e-mail becomes a ticket or lands in the sender's open ticket; if the service sends the same e-mail again (same `Message-Id`), it is only accepted once. |
| Normal incoming e-mails | same page: “Ticket if a rule matches” (to support address, subject contains, sender domain) or “every e-mail”. Optionally also e-mails from mailbox sync (IMAP) – from the moment you turn it on, no old e-mails. |
| Forms | Form → Settings → **Create a ticket for every submission** (priority, category, team). A “Subject”/“Concern” field becomes the subject, all answers the description. |
| Client portal | “My requests” in the member portal (see below). |
| Calls | Ticket button in the call list – with voicemail transcript, call linked. |
| API / MCP / workflow | `POST /api/tickets`, `ghl_create_ticket`, workflow action **Create ticket**. |

**Replies in the ticket** go out through the normal sending (e-mail, SMS, live chat, WhatsApp) to the contact, also appear in Conversations and carry `[Ticket #123]` in the subject for e-mail. If the customer replies (with this number, or on any channel as long as a ticket is open), the message lands in the ticket; *Waiting for customer* and *Resolved* then jump back to *In progress*. Optionally HyperLevel sends an **acknowledgement** (Settings → Service → Replies).

**Canned replies** with placeholders: `{{contact.first_name}}`, `{{contact.name}}`, `{{ticket.number}}`, `{{ticket.subject}}`, `{{ticket.status}}`, `{{agent.name}}`, `{{location.name}}` (fallback: `{{contact.first_name|du}}`). While you write, HyperLevel suggests matching **help articles** (a click inserts title and link).

### Assignment

*Settings → Service → Teams & assignment*: **Manual**, **Round robin in the default team** or **by category** (rule category → team or person, otherwise round robin). Teams have members and hand out tickets in turn; in a ticket, “↻ Next in the team” picks by hand. **Workload** (tab in Tickets): open, waiting, urgent and overdue tickets per person, those resolved in the last 7 days, unassigned ones.

## SLAs

A target per priority for **first response** and **resolution** (hours, 8 h = one working day). “Business hours” counts only the opening hours of the sub-account (in its time zone, without public holidays/closing days), “around the clock” every minute. Default: urgent 1 h/1 day, high 4 h/3 days, normal 1 day/5 days, low 2/10 days. In a stage with “Pause SLA” (*Waiting for customer*), the resolution time stands still and then continues with the remaining time. If the priority changes, the new targets apply; if a resolved ticket is reopened, the resolution time starts over.

Timers appear in the list, kanban and the ticket (“Response in 3 h”, yellow “expires soon” from 75% of the time – adjustable, red “overdue”). The background clock writes warning and breach to the history, reports them by push and triggers the workflows **SLA about to expire** and **SLA breached**. Built-in escalation (can be turned off): notify the assignee by e-mail + push, raise the priority by one level, hand over to a team. More through a workflow (template “SLA breached: priority high + notify team”): action **Update / escalate ticket** (status, priority “one level higher”, team, assignee incl. round robin, note, notification) and **Notify team**.

**Workflow triggers:** ticket created, ticket status changed, ticket assigned, SLA about to expire, SLA breached, health score dropped – with filters (priority, category, pipeline, stage, assignee, first response/resolution, color). For every ticket to start the workflow, tick “Contact may enter more than once” in the workflow. In the workflow, the ticket data is available as `{{event.ticket.number}}`, `{{event.ticket.subject}}`, `{{event.ticket.url}}` etc.

## Dashboard

*Tickets → Overview*: open tickets by status, priority and assignee, unassigned ones, SLA breached / expiring soon, **SLA rate** (first response and resolution, met vs. missed), average first response and average resolution time, trend (open tickets per day, new vs. resolved), CSAT and NPS – for 7, 30 or 90 days.

## Knowledge base & help center

Categories and articles in Markdown (headings, lists, links, images, notices, code, video links) with preview, draft/published, tags as search terms, SEO title/description, `noindex`. Drafts can be viewed through a secret preview link.

You turn on the **help center** under *Settings → Service → Portal & help center* (address, title, greeting, color, SEO, “Nothing found?” note). It lives at `https://<your-domain>/help/<address>`, on every connected website domain of the sub-account under `/help` (also in its `sitemap.xml`) and optionally on a domain of its own (e.g. `help.company.com`, CNAME/A record pointing to the server). Visitors search (title, tags, text), browse by category, rate articles with “Was this helpful?” (once per visitor and day) and reach the client portal through “Submit a request”. Every page has a title, description, canonical, Open Graph tags and JSON-LD; `/help/<address>/sitemap.xml` lists all articles. Views and ratings appear in the article list.

Published articles flow automatically into the knowledge of the **AI assistant** (reply suggestions, chat bot); MCP searches with `ghl_search_kb`.

## Client portal “My requests”

In the member portal (`/portal/<sub-account>/tickets`, link at the top and a card on the home page): customers see their tickets with status (“Waiting for you”), read the team's replies, reply and submit new requests (subject, topic, message). They never see internal notes, assignments or SLA details. Contacts with a ticket (or course/community) may sign in; with “Every contact with an e-mail address may sign in”, every known contact. Forms in the portal are protected against foreign pages (origin + token).

## Satisfaction (CSAT) & NPS

**CSAT:** when a ticket is resolved or closed, the contact (optionally delayed) gets a signed link – by e-mail with five smiley buttons, otherwise by SMS. The page asks for 1–5 and a comment; only submitting counts (mail scanners that open links do not vote). The result is shown on the ticket, on the contact, in the dashboard and under *Surveys → Satisfaction* (average, share satisfied, response rate, distribution, comments). Event `csat.received`. The survey goes out once per ticket: it is noted on the ticket before it is sent – if the ticket is reopened and resolved again, no second one is sent (not even while the first is still on its way). *Send survey* on the ticket deliberately sends it once more; a double click on it is rejected while it is on its way. A satisfaction survey counts as advertising legally: contacts with “Do not disturb”, a withdrawal of consent or without consent under the [send gate](consent.md#the-send-gate) do not get one (not even by hand), and the e-mail carries the unsubscribe link.

**NPS:** *Surveys → Recommendation* → survey with a question, channel (e-mail/SMS), audience (tags or smart list) and text with `{{nps_link}}`. “Send” messages all matching contacts (without “Do not disturb”) in the background, “Message new contacts” later only the new ones. Every recipient is reserved before sending, so two runs at the same time do not message them twice; a message that was in flight during a restart is not sent again but counted as failed (“Sending interrupted”) after 30 minutes. Every link is personal and signed; answers (0–10 + reason) can be changed. NPS = % promoters (9–10) − % detractors (0–6). Event `nps.received`.

## Customer health score

0–100 per contact with a traffic light (green from 70, yellow from 40 – adjustable) from weighted signals: open tickets, overdue tickets (SLA), latest CSAT rating, latest NPS, days since the last activity, overdue invoices, deal status (won/open/lost in the last year) and e-mail engagement (opens/clicks in the last 90 days). Each signal yields 0–100 points; signals without data do not count. Weights, thresholds and “dropped from” are under *Settings → Service → Health score*.

The score is recalculated as soon as something relevant happens (ticket, rating, payment, deal, message, e-mail open) and otherwise every 12 hours in the background. It appears as a **column and filter** in *Contacts* (can also be saved in smart lists) and in the **Service** card on the contact page (with breakdown, tickets and surveys). If the color changes for the worse or the value falls by at least 15 points, the trigger **Health score dropped** starts (`health_score.dropped` with `score, band, previousScore, previousBand`).

## Reports & import

**Reports** (menu *Reports*): sources *Tickets* (status/stage, status kind, priority, category, source, assignee, team, pipeline, tags, created/first response/resolved/closed on, first response and resolution time in minutes, SLA breached – overall, first response, resolution –, CSAT; metrics SLA rate, resolution rate, average first response, average resolution time), *Satisfaction (CSAT)* (rating, satisfied yes/no, comment, assignee; average rating, share satisfied), *Recommendation (NPS)* (rating, promoter/passive/detractor, survey; NPS) and *Customer health score* (score, traffic light, change) – each with contact fields. Permissions: area *Service* (health score: *Contacts*).

**HubSpot import** (*Settings → Import*, part “Tickets”): HubSpot tickets become HyperLevel tickets – pipeline by name (otherwise the first), stage by name or meaning (“New” → New, “Waiting on contact” → Waiting for customer, “Waiting on us” → In progress, “Closed” → Closed), priority LOW/MEDIUM/HIGH/URGENT → low/normal/high/urgent, owner and contact as in the rest of the import, original creation date. A second run updates instead of duplicating (HubSpot ID on the ticket). Imported tickets get no SLA deadlines and trigger no workflows.

## API, MCP & events

Endpoints: [docs/api.md](api.md#service-helpdesk). MCP tools: `ghl_list_tickets`, `ghl_create_ticket`, `ghl_update_ticket`, `ghl_reply_ticket`, `ghl_search_kb`.

Events (webhooks and workflows, all with `ticketId` and `ticket: {id, number, subject, status, status_kind, stage_id, pipeline_id, priority, category, source, owner_id, team_id, url}`, `contactId` if a contact is attached): `ticket.created`, `ticket.status_changed` (`from, to, stageId, status, kind, previousKind`), `ticket.assigned` (`ownerId, teamId, previousOwnerId`), `sla.warning` / `sla.breached` (`slaKind: first_response|resolution, dueAt`). Plus `csat.received` (`ticketId, score, comment`), `nps.received` (`campaignId, score, comment`), `health_score.dropped`.

## For developers

Modules: `server/modules/tickets.ts` (tables, tickets, pipelines, teams, views, canned replies, settings, e-mail → ticket, forms, workflow actions, MCP), `helpdesk-sla.ts` (SLA clock, escalation, dashboard, workload), `knowledge-base.ts` (articles, help center, search, AI knowledge), `csat.ts` (CSAT, NPS), `health-score.ts`, `helpdesk-portal.ts` (via `app.services.portalKit`). Shared logic: `server/services/tickets.ts` (create/change/reply/merge, inbound routing), pure building blocks in `services/helpdesk.ts`, `services/helpdesk-sla.ts` (business-hours calculation) and `services/health-score.ts`. Other modules can create tickets through `app.services.helpdesk.createTicket/updateTicket`, imports go through `app.services.ticketsImport` (idempotent per `external_source` + `external_id`); `helpdesk-reports.ts` registers the report sources; new knowledge for the AI assistant comes in through `app.services.aiKnowledge`.
