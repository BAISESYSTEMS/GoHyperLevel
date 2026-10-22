# Vertrieb (sales)

**Vertrieb** is the sales workbench of a sub-account: **sequences** that write to prospects from your own mailbox, **deal positions and quotes** a customer can compare, tick, sign and pay, **record-level access** with sales teams, an **assistant for duplicate contacts**, **quotas with a leaderboard**, and the hook that hangs **call and meeting summaries** on a deal.

Everything is per sub-account. The menu entry *Vertrieb* and the API use the area **Opportunities** (member logins need it; the SaaS plan decides whether a sub-account has it). The deal drawer (*Opportunities*) gets the positions, quotes and notes, the contact page the sequence box and the duplicate hint.

- [Sequences](#sequences)
- [Deal positions and quotes](#deal-positions-and-quotes)
- [Record access and teams](#record-access-and-teams)
- [Duplicate assistant](#duplicate-assistant)
- [Quotas and leaderboard](#quotas-and-leaderboard)
- [Meeting notes and the call-summary hook](#meeting-notes-and-the-call-summary-hook)
- [Several signers on a contract](#several-signers)
- [Workflows, MCP tools, API](#workflows-mcp-tools-api)
- [What you have to set up](#what-you-have-to-set-up)
- [Known limits](#known-limits)
- [For developers](#for-developers)

## Sequences

A sequence is a list of up to 20 steps for one person, each with a wait before it:

| Step | What happens |
|---|---|
| **E-Mail** | Sent from the **personal mailbox** of the responsible person (see [mailbox-sync.md](mailbox-sync.md)), so it lands in the normal sent folder and replies come back to the same inbox. Subject and text accept tokens (`{{first_name}}`, company, owner, deal …); up to three **A/B variants** per step are spread evenly over the people. |
| **Aufgabe** | Creates a task for the responsible person; the sequence waits until it is done (or its due date passes). |
| **Anruf** | A task "call …" with the contact's number and your notes. |
| **LinkedIn (manuell)** | A task to send the message or connection request yourself – nothing is automated on LinkedIn. |

**Timing.** Waits are whole days (max. 120). Mails go out **only inside the business window** you set (weekdays, hours, the sub-account's time zone, daylight saving safe) – a step that falls outside waits for the next slot. A **daily limit per person** (default 100, at most 500; admins can set one per user in `PUT /api/sequence-settings`) keeps the mailbox healthy; the rest waits for the next day.

**A sequence ends for a person** when they
- **reply** – detected from the inbound message event *and* by a sweep of the mailbox over the last 14 days, so replies that arrive without any workflow listening are caught too;
- **book a meeting**, if the sequence is set to stop on that;
- see their **deal change stage or close**, if set;
- **unsubscribe** or get *Nicht stören* – always;
- lose their **consent** – always;
- or someone ends it by hand (contact page, sequence page).

**Consent and the two modes.**
- **Serie** (default) is marketing mail: every send passes the consent gate ([consent.md](consent.md)) – no consent, no mail – and **always** carries the unsubscribe line with the person's own link (it cannot be switched off).
- **Einzelkorrespondenz** marks the sequence as personal 1:1 correspondence (follow-ups to people you have been in contact with). The mails are then treated like a conversation: no marketing consent is demanded, and the unsubscribe line is optional (on by default). **Legal note (no legal advice):** whether a message is "individual correspondence" or advertising is decided by German law (UWG § 7) and the courts, not by a toggle. Cold e-mail to businesses or private people without their consent is generally not allowed. Switching a sequence to this mode requires an explicit confirmation (`legal_ack: true`), which is stored with the person and the time. Use it only for follow-ups that are really personal and that you can justify; when in doubt, keep **Serie** and collect consent first. *Nicht stören*, unsubscribe and bounces are honoured in both modes.

**Enrolling.** From a contact page, from a list or tag in the sequence, in bulk (`POST /api/sequences/:id/enroll` with `contact_ids`), or by the workflow action **In Sequenz aufnehmen**. People who lack consent (Serie), have *Nicht stören*, no e-mail address or are already in the sequence are **skipped with a reason** that is shown, not silently dropped. The sender is the person who enrols (or the sequence's owner for automations); without a connected mailbox nothing is sent and the screen says so.

**Numbers.** Per sequence: enrolled, active, finished, stopped (and why), sent, opened, clicked, replied, meetings booked and the rates; per step and per variant: sent, opened, replied. **Opens count humans only**: mail-program prefetches and security scanners (see [email-tracking.md](email-tracking.md)) are filtered out, so the open rate is smaller than in most tools and honest. A reply is the number that matters.

**Preview.** `POST /api/sequences/:id/preview` renders a step for a real contact – tokens filled, unknown tokens flagged – without sending.

## Deal positions and quotes

### Positions on the deal

A deal can have **positions** (product from *Produkte* or free text, quantity, unit price, discount in % or amount, tax rate). Once a deal has positions its **value is the net sum** in whole currency units and can no longer be edited by hand – editing the positions is what changes it (an attempt to set the value returns `409` with that explanation). Removing all positions releases the value again. Amounts are computed in **cents** with the same rules as invoices ([invoicing.md](invoicing.md)); discounts are exported as negative lines.

### The quote

*Vertrieb → Angebote* (or *+ Angebot erstellen* in a deal) builds a quote from the deal's positions:

- **Positions** shared by all variants, **optional positions** the customer ticks on or off (price updates live), and up to six **variants** ("Basis", "Premium" …) of which one is recommended.
- **Gültig bis** (default 30 days); an expired quote can no longer be accepted – the page says so and asks the customer to get in touch for an extension. Revisions (*duplicate*) keep the history.
- **Bei Annahme fällig:** nothing, a **deposit** (percent or fixed net amount, per tax rate so the VAT stays right) or the **full amount**; optionally the deal is set to **won** on acceptance.
- **Senden** allocates the quote number (the estimate number sequence of [invoicing.md](invoicing.md)), mails the personal link and moves the deal on the timeline. While the mail is on its way a second *Senden* of the same quote (double click, a colleague) is refused with 409 instead of mailing the customer twice; sending again afterwards works.

The customer opens `/q/<token>` – a single clean page (also on a phone) with the variants, optional ticks, totals by tax rate, terms, validity and what is due. They **accept with their name and a signature drawn on the page** (mouse or finger), or decline with a reason. Acceptance:

1. stores the **signed contract** (the same record and checksum as *Verträge*, see `contracts.ts`; signature image, name, time, IP address and browser);
2. creates a numbered **estimate** (`accepted`) with exactly the chosen lines;
3. creates the **deposit invoice** (partial) or the **full invoice**, finalised and mailed, with the **Stripe payment link** on its invoice page when Stripe is connected ([stripe.md](stripe.md)) – "payment on signature";
4. later, **Schlussrechnung** (button on the quote) is the final invoice that deducts the deposit – via the existing estimate → invoice flow.

When the invoice is paid the quote shows **paid**. All of it is idempotent: pressing *Annehmen* twice, or a replayed request, creates nothing twice. After sending, only the validity can change (extending it re-opens an expired quote); for anything else *duplicate* starts a new revision, and *void* withdraws a quote.

## Internal approval

Optional, per sub-account (*Vertrieb → Angebote → Genehmigungsregel…*, admins and the Leitung only, signed in): quotes
above a **net amount** or with more than a **discount percentage** need the approval of someone with a given **role**
before they can be sent.

- **What counts:** the most expensive variant with every optional position ticked (net), and the highest discount of a
  single position or of the whole variant (credit lines included).
- **Who approves:** *Agentur-Admins*, *Leitung* (members with the settings area), *Rechnungen & Produkte* (payments area)
  or the **leads of a sales team**. Never the requester themselves, unless the rule allows approvers to approve their own
  quotes. Approving and rejecting only work for a person signed in to the web app or the Android app – not with an API
  key, MCP or the agent.
- **Flow:** the quote shows why approval is needed → *Genehmigung anfordern* (with a comment) notifies the approvers (bell,
  push, app feed) → *Genehmigen* or *Ablehnen* (a reason is required) notifies the requester. Every step is in the audit log
  (`quote.approval.requested|approved|rejected|withdrawn`, `quote.approval.rule`), and every blocked send attempt as
  `quote.approval.blocked`. Workflow triggers `quote.approval_requested` and `quote.approval_decided`.
- **The gate is in the send itself** (`sendQuote` runs `app.services.quoteSendGates`), so the web app, the API, the MCP tool
  `ghl_quote_send` and workflows all get `409` with `approval_required: true` until the quote is approved. An approval holds
  for exactly the content it was given for: editing positions, prices, texts or payment terms afterwards needs a new one.
  Re-sending a quote that already went out is not gated again.
- The customer's page, the signature and everything after acceptance are unchanged.

## Record access and teams

Off by default – nothing changes until somebody switches it on in *Vertrieb → Zugriff & Teams*.

For each record type – **contacts, companies, deals, tasks, conversations** – a rule says who sees what: **Alle**, **Nur das Team** (records owned by anybody who shares a sales team with the person, and their own) or **Nur eigene**. Rules can be set for everybody, for a person and for a team (the most specific wins; a person in several teams gets the widest of their teams' rules). **Unassigned records** can stay visible to everybody (the pool to claim from) or be hidden. Per record type, individual **fields can be hidden** (e-mail, phone, address, birthday, website, custom fields; deal value, source; task description; conversation preview) – hidden fields come back empty, and a hidden address hides city, postcode and country with it.

Enforcement is central (`server/services/record-access.ts`, wired once into the router by `modules/record-access.ts`), not per screen:

- **lists, counts and filters**, **get-by-id** (a record you may not see is a plain 404), **search**, **dashboard**, **reports**, **exports**, **board widgets**, the **project planner's** task lists, the **mobile API** and the **agent**/MCP when acting as the person;
- **writes** too: a restricted person cannot change, delete, associate or note what they cannot see, and cannot hand records to a hidden state;
- children follow the parent: notes, messages, activities, associations, lead and health scores, meeting notes – and in the conversation area the **call log** (list, search, one call by id or Twilio sid, recording, call notes, the browser phone's call controls), **call intelligence** (analyses, transcripts, scores), the **power dialer** (lists, entries, callbacks; *Nächster Kontakt* skips contacts the person may not open), the AI phone agent's sessions, drafts of all threads, media files and mailbox attachments of a message, bulk changes in the inbox, segment members, campaign recipients, the phone app's call list and the *Anrufe* report source;
- the **Cognee memory** answers a narrowed person nothing about contacts, notes and conversations (wiki, tickets, courses and remembered notes stay available).

**Not covered** (they are not on the five record types): see [Known limits](#known-limits).

**Who is exempt.** Admins, **API keys, MCP connections and automations** are not people with a team and see everything – which is why a restricted person may not create API keys, webhooks, Google-Sheets exports, imports or AI-app connections (they would be a way around the rules; the refusal says so). Agents and the mobile app act as the logged-in person and follow the rules.

**Teams** (*Vertrieb → Zugriff & Teams*, `/api/sales/teams`) group people; they are also what quotas and the leaderboard use.

## Duplicate assistant

*Vertrieb → Dubletten* lists groups of contacts that are probably the same person: same **e-mail** (case and `+tag` aside), same **phone number** in any notation (`0171…`, `+49 171…`, `0049…`), or the same **name at the same company**. Each group shows a confidence (sicher / wahrscheinlich), the contacts side by side and what hangs on them. **Nicht dieselbe Person** remembers the decision. The contact page shows the same hint when you open one of the pair.

**Zusammenführen:** pick who stays, then choose **field by field** which value wins (the better one is pre-selected; *Rollen tauschen* swaps the two). **Tags** from both are joined. Everything that points at the other contact moves to the one that stays – activities, notes, messages and conversations (the two conversations become one), tasks, deals, appointments, invoices, consent records, associations, enrolments, course access and so on (found from the schema, so tables added later follow automatically). Frozen (finalised) invoices cannot be re-pointed: the dialog says so and asks for confirmation before they are detached; their content stays unchanged. Anyone with a running sequence in both contacts keeps one enrolment.

**Undo.** A merge is one journal entry: **Rückgängig** (Strg+Z, or *Verlauf*, [undo.md](undo.md)) brings the second contact, its conversation and every moved row back exactly. What cannot be un-done is documented in [Known limits](#known-limits).

**Public input never decides who a contact is.** Everything a visitor types without logging in – public forms (also abandoned ones), booking pages and team calendars, the chat widget and its AI assistant, webinar registration, the AI phone agent, Stripe Checkout and Meta lead forms – never changes the **e-mail address or phone number** already stored on a contact. An empty field is filled. A different number on a contact found by its e-mail address stays as it was; the new number is noted on the timeline as an *unverified alternative* (*Abweichende Telefonnummer … nicht übernommen*), to adopt by hand. A **known number with another e-mail address** creates a new contact instead of replacing the stored address – the timeline says why (*Gleiche Telefonnummer wie ein bestehender Kontakt*), and this list pairs the two so you can merge them when it is the same person. A phone number alone (no e-mail in the submission) still finds its contact. The team's own changes (the app, the API, imports, automations) update the fields as before. A chat visitor who types a known address joins that contact's conversation, but the widget only shows the messages from their own start on, never the chats before, and the chat bot ([ai-assistant.md](ai-assistant.md)) answers from that chat and the name only – not from the contact's e-mails, SMS, stored numbers or deals.

## Quotas and leaderboard

*Vertrieb → Quoten & Rangliste*: a **target per person and per team** for a **month or quarter**, measured in **won value** or **won deals**. What counts is what a person **won in the period** (the deal's `closed_at`, counted in the sub-account's calendar and time zone) for its owner, in the quota's currency. Each row shows target, achieved, attainment, **pace** (reached / ahead / on track / behind, from the share of the period that has passed), the **weighted open pipeline** and what is still missing; teams add up their members. *Aus der Vorperiode übernehmen* copies last period's targets.

The **leaderboard** ranks people or teams (ties share a rank). Who sees whose numbers is a setting (`PUT /api/quota-settings`): **Alle sehen alle**, **Jeder nur sich und sein Team**, **Niemand (nur Admins)**; unset = everybody, except people whose deals are narrowed by record access, who then only see themselves. Setting quotas and the visibility needs an admin, or a member with the area *Einstellungen* whose records are not narrowed by record access.

Two **widgets for the living boards** ([living-boards.md](living-boards.md)): *Quote: Zielerreichung* (me or everybody) and *Rangliste* (people or teams) – with the same visibility rules, so a board never shows more than the page.

## Meeting notes and the call-summary hook

*Gesprächsnotizen* in the deal drawer: a person writes the summary of a call or meeting, optional follow-ups (one per line, optionally as tasks for the deal's owner). Each note is also written to the contact's timeline. Trigger **Gesprächsnotiz angelegt** (`meeting_note.added`) starts workflows.

**For producers (the telephony and call-intelligence package):** deliver a summary without knowing anything about deals:

```ts
const r = app.services.attachCallSummary?.(locationId, {
  contactId, dealId /* optional */, summary, title?, externalId?, source?: 'Anrufauswertung',
  durationSec?, at?, transcriptUrl?, actionItems?: string[], createTasks?: boolean,
});
// → { id, dealId, noteId, taskIds, duplicate }
```

The hook picks the contact's most recently changed **open deal** when `dealId` is missing (none: the note sits on the contact only). The same `externalId` from the same `source` twice changes nothing (`duplicate: true`). Over HTTP the same thing is `POST /api/meeting-notes` and the MCP tool `ghl_deal_meeting_note`.

## Smart Lists

**Kontakte** opens with a row of saved views above the table – *Alle Kontakte* plus every smart list you may see – so switching between lists is one click. A smart list stores the **search and filters** (tag, attribution, company, lead score, health), the **visible columns** (also *Firma*, *Ort*, *Letzte Aktivität* and every custom field, chosen and ordered under *Spalten*) and the **sort order**. Click any column head to sort by it (again to turn it round; empty values always come last) – this runs on the server, so it covers every page, also for custom fields (numbers sort as numbers).

- **+ Smart List** saves the current view; *Sichtbar für* is **Das ganze Team** (shared) or **Nur mich** (private – nobody else, not even an admin, sees it). Changing an open list shows *Änderungen speichern*.
- **Verwalten** renames, shares/unshares and deletes. A shared list can be changed by the person who made it and by admins; only its creator switches it between shared and private. Lists from before (and lists made with an API key) are shared and have no owner.
- **Record access** applies inside every list: a shared list shows each person only the contacts they may open, with hidden fields blanked.
- Campaigns, the power dialer, sequences, surveys and ad audiences keep using smart lists as before (they read the saved filter). Another person's **private** list counts as missing everywhere – it cannot be attached, previewed, refreshed or sent, and tag usage does not name it; a deleted or refused list in a campaign, call list or survey selects **nobody**, never everybody. Scheduled campaign sends run the list that was checked when it was attached and when sending started. Importers only update shared lists.
- With no contact open the list uses the full width with every chosen column; list and contact sit side by side only while a contact is open.
- **Agents:** `ghl_smart_lists` (the lists the person may see – with an API key only shared ones) and `ghl_smart_list_contacts` (a list's contacts with its filter and sort, paged, optionally `sort`/`dir`) are read tools and run without confirmation. API: `/api/smart-lists` ([api.md](api.md)).

Smart lists are not *segments*: segments ([email-marketing.md](email-marketing.md)) describe audiences by behaviour (opened, clicked, bought) for campaigns and workflow triggers; smart lists are saved table views of the contact list.

## Smart tags

**Opportunities → Board → Smart Tags** sets up rules that put a coloured chip on open deal cards (up to 60): *Wert ab* (value from), *Abschlussdatum überschritten*, *Ohne Abschlussdatum*, *Ohne Zuständigen*, *Länger in einer Stufe als … Tage* and *Keine Aktivität seit … Tagen* (the "rotting deal" hint – no change on the deal and nothing in the contact's timeline). The rules are evaluated when the board loads (record access applies: only deals the person may open, and *Wert ab* marks nothing for somebody whose deal amount is hidden), travel in snapshots and are readable for agents (`ghl_deal_smart_tags`). API: `/api/deal-smart-tags` ([api.md](api.md)).

## Forecast

**Opportunities → Prognose & Risiken** (folded above the board and the list) shows the open deals per expected close month – the total and the **weighted** value (value × the stage's win probability; without one set, by position like in the reports) – for six months, plus four cards that make a forecast unreliable: *Abschluss überfällig* (overdue deals count in the current month), *Ohne Abschlussdatum*, *Seit 14 Tagen ohne Aktivität* and *Ohne Zuständigen*, each with count, sum and the largest deals. On the board it follows the selected pipeline. Record access applies: only the deals the person may open count, and with the deal amount hidden every sum comes back as 0 (counts and dates stay). API `GET /api/deal-forecast?pipeline_id=&months=`, MCP `ghl_deal_forecast`.

## CRM housekeeping

- **Owner in bulk** – in the contact list, tick contacts and choose *Zuständig setzen…* → *Zuweisen* (or *Ohne Zuständigen*). Each contact fires *Zuständiger geändert*; one click in the history takes it back. MCP `ghl_contacts_assign_owner`.
- **Tags aufräumen** – *Einstellungen → Felder & Tags → Tags → Aufräumen* lists every tag with its use (contacts, workflows, smart lists; *ungenutzt* when none). Pick tags to rename, merge into one, colour, file in a category or delete. Renaming and merging change the names on the contacts without starting tag workflows; workflows and smart lists that still use the old name are named in the message. MCP `ghl_tags_usage`, `ghl_tags_bulk`.
- **Eigene Felder aufräumen** – *Einstellungen → Felder & Tags → Eigene Felder → Aufräumen* shows per field how many contacts hold a value and which forms and workflows use it; *Alle ungenutzten wählen* → *Löschen*. Fields still in use are kept unless you tick *Auch Felder in Gebrauch löschen*; values on the contacts always stay. MCP `ghl_custom_fields_usage`, `ghl_custom_fields_delete`.
- **Dokumente und Notiz-Anhänge** – the notes tab of a contact has *Datei anhängen* (photos, PDF, text, CSV, Word, Excel, PowerPoint, OpenDocument; 8 MB each). Under *Optionen* a file can go onto one of the notes (it then shows under that note) or be *Nur für mich sichtbar* (only you and admins see it). Files are never on a public link: they are served only to signed-in people who may see the contact, are deleted with the contact and listed (without content) in the DSGVO export (other people's *Nur für mich* files only in the export of an admin or an API key). Self-hosters can cap the space per sub-account with `PGHL_CONTACT_DOCS_MB` (default 2048, 0 = no cap). MCP `ghl_contact_documents`.
- **Änderungsverlauf** – every real change of a contact field or a deal field (stage, value, owner, close date …) appears in the contact's timeline with old → new value and who did it: a person, a workflow (by name), the API or the system. For fields that record access can hide (e-mail, phone, address, birthday, website, own fields, deal value and source) the timeline only says *geändert*; the values are in `GET /api/contacts/:id/field-history` and hidden from people who may not see the field (also a single hidden own field); changes of deals the person may not open are left out. MCP `ghl_field_history`.

## Files in the customer portal

Share a contact's documents with that contact in the customer portal (*Mitgliederbereich*, `/portal/<id>`) – HighLevel's portal file sharing.

- **Share:** in the contact's notes tab every document chip has a link button **Im Portal freigeben** (click again to withdraw). Upload first with *Datei anhängen*, then share. *Nur für mich* files cannot be shared (and a file made private later disappears from the portal). A contact with a shared file may log in to the portal.
- **The customer** sees **Meine Dateien** in the portal's top bar and *Neue Dateien für dich* on its start page; `/portal/<id>/documents` lists the shared files with *Herunterladen*. Each download is counted (shown on the chip); the first one is an activity on the contact (`portal.file_downloaded`).
- **Uploads back** (off by default): *Kurse → Mitgliederbereich → Dateien im Portal* → *Kunden dürfen Dateien hochladen*; under *Grenzen*: max. MB per file (1–8), storage per customer (default 50 MB), allowed types (PDF, images, Office files, text/CSV) and whether the contact's owner (or, without one, the admins) gets a notification. An upload lands on the contact as a normal document marked *vom Kunden*, with an activity and the event `portal.file_uploaded` (`contactId`, `documentId`, `name`, `mime`, `size`). At most 20 uploads per customer per day; the sub-account cap `PGHL_CONTACT_DOCS_MB` applies too.
- **Safety:** every lookup is by the logged-in member's own contact and sub-account – another contact's file id answers *Nicht gefunden*. Downloads always come as attachment with `nosniff` and a sandbox CSP. Uploads accept only the document types above (never HTML or SVG): the type comes from the file name, the content must match it (file signature; text files without markup), the form carries a session token and must come from the portal itself. There is no virus scanner – files are stored and served as they are.
- **API:** `GET /api/contacts/:id/portal-files` → `{files: [{doc_id, name, mime, size, source: team|customer, shared, shared_at, downloads, last_download_at}], portal_url, uploads}`, `PUT /api/contacts/:id/documents/:docId/portal` `{shared}`, `GET/PUT /api/portal-files/settings` `{uploads, max_mb, quota_mb, types: [pdf, images, office, text], notify}` (PUT for admins and people with the settings area). Portal: `GET /portal/:p/documents`, `GET /portal/:p/documents/:docId`, `POST /portal/:p/documents` (multipart form `csrf`, `file`). **MCP:** `ghl_portal_files` (read), `ghl_portal_file_share` (write). Module `server/modules/portal-files.ts`.

## Several signers

A contract (*Umsatz → Verträge*) can be signed by **several people with roles and an order** – e.g. *Kunde* first, then *Geschäftsführung*. Without signers nothing changes: the contact signs on the contract's link as before.

- **Set up** in the contract draft: *Mehrere Unterzeichner* (folded in Einfach-Modus) → role, name and e-mail per person (up to 10, the list order is the signing order) and **Nacheinander** (the next person is invited when the previous one signed) or **Alle gleichzeitig**. Saving the list does not send anything.
- **Senden** (the normal button) starts the run: every person gets an e-mail with a link of their own (`/sign/<token>`); the placeholders of the text are filled once, as before. An address that belongs to a contact goes through its conversation, any other address as a plain e-mail. *Erneut senden* reminds whoever is signing right now; each person also has an *Erinnern* button.
- **The signer's page** shows the frozen text, the list of signers with their state and – only when it is that person's turn – the signature pad. Every signature is stored with its own audit trail: typed name, drawn signature, time, IP address, device and the SHA-256 of the text.
- **Done:** when the last person signed, the contract is *unterschrieben*, the team is told, every signer gets a copy link (the page with all signatures, printable as PDF) and **Vertrag unterschrieben** (`contract.signed`, with `signers`) starts workflows. Each single signature fires **Vertrag: Unterzeichner hat unterschrieben** (`contract.signer_signed`: `signer.role`, `signer.name`, `remaining`). One person declining ends the contract (`contract.declined` with `signer`).
- The contract's own link (`/s/<token>`) shows the overview without a pad; the single-signer routes refuse such a contract. *Stornieren* stops all links.
- **API:** `GET/PUT /api/contracts/:id/signers` (`{mode: sequential|parallel, signers: [{role, name, email}]}` – drafts only; an empty list switches back), `POST /api/contracts/:id/signers/:signerId/remind`; public `GET /sign/:token`, `POST /api/public/sign/:token` `{name, agree, signature}`, `POST /api/public/sign/:token/decline` `{reason}`. **MCP:** `ghl_contract_signers` (read), `ghl_contract_signers_set` (`send: true` starts the run).
- **DSGVO:** signers are exported by e-mail address with the person's data; erasing a person removes their rows of contracts that were never signed – signed contracts are business records and keep their signatures, like the contract itself.

## Workflows, MCP tools, API

**Workflow triggers** (category *sales*): `sequence.replied`, `sequence.finished`, `sequence.stopped`, `quote.sent`, `quote.viewed`, `quote.accepted`, `quote.declined`, `quote.expired`, `quote.paid`, `quote.approval_requested`, `quote.approval_decided`, `meeting_note.added`. **Action:** *In Sequenz aufnehmen* (`sequence_enroll`).

**MCP tools** ([mcp-client.md](mcp-client.md) / `/mcp`): `ghl_sequence_list`, `ghl_sequence_stats`, `ghl_sequence_enroll`, `ghl_deal_lines`, `ghl_deal_set_lines`, `ghl_quote_list`, `ghl_quote_create`, `ghl_quote_send`, `ghl_contact_duplicates`, `ghl_quota_list`, `ghl_quota_set`, `ghl_leaderboard`, `ghl_deal_meeting_note`, `ghl_sales_access` (read only), `ghl_smart_lists` and `ghl_smart_list_contacts` (read only, see [Smart Lists](#smart-lists)).

**HTTP routes** (login with `x-location-id`, sub-account API key or agency key; the area is *Opportunities*):

| Part | Routes |
|---|---|
| Sequences | `GET/POST /api/sequences`, `GET/PATCH /api/sequences/:id`, `POST …/:id/enroll`, `GET …/:id/enrollments`, `POST …/:id/preview`, `GET /api/sequence-enrollments?contact_id=`, `POST /api/sequence-enrollments/:id/stop`, `GET/PUT /api/sequence-settings` |
| Positions | `GET/PUT /api/opportunities/:id/lines` |
| Quotes | `GET /api/quotes[?deal_id=&status=]`, `GET /api/quotes/stats`, `POST /api/quotes`, `GET/PATCH /api/quotes/:id`, `POST …/:id/preview\|send\|void\|duplicate\|invoice`; public: `GET /q/:token`, `POST /api/public/quotes/:token/preview\|accept\|decline` |
| Approval | `GET/PUT /api/quote-approvals/settings` (`{enabled, min_net_cents, max_discount_percent, approver_role: admin\|leitung\|finance\|team_lead, team_id?, self_approve}`; PUT signed in with the settings area), `GET /api/quote-approvals?status=pending`, `GET /api/quote-approvals/quotes/:quoteId`, `POST …/quotes/:quoteId/request` `{comment?}`, `POST /api/quote-approvals/:id/approve\|reject\|withdraw` `{comment}` |
| Duplicates | `GET /api/contact-duplicates[?min=high]`, `GET …/for?contact_id=`, `GET …/preview?keep_id=&from_id=`, `POST …/merge\|ignore\|unignore` |
| Quotas | `GET/PUT /api/quotas`, `POST /api/quotas/copy`, `GET /api/leaderboard`, `GET/PUT /api/quota-settings` |
| Notes | `GET /api/opportunities/:id/meeting-notes`, `POST /api/meeting-notes`, `DELETE /api/meeting-notes/:id` |
| Access | `GET/PUT /api/sales/access`, `GET /api/sales/access/me`, `GET/POST /api/sales/teams`, `PATCH/DELETE /api/sales/teams/:id` |

## What you have to set up

- **Sequences:** a **connected personal mailbox** per sender with *Tracking* on ([mailbox-sync.md](mailbox-sync.md)) – without a mailbox nothing is sent; without tracking there are no open counts (replies and clicks still work). A reachable address for unsubscribe links (`BASE_URL`, see [self-hosting.md](self-hosting.md)).
- **Quotes:** the seller data of *Einstellungen → Rechnungen* (name, address, tax number, bank) and number formats; for payment on signature a **Stripe** connection ([stripe.md](stripe.md)). A customer can still sign without Stripe – the invoice then goes out as a normal bank-transfer invoice.
- **Quotas:** a time zone and currency on the sub-account; targets per period.
- **Record access:** at least one sales team if you use the *Team* level; people need an owner on their contacts and deals for *Nur eigene* to mean anything.

No external call is made by any of this except what you already configured (your mailbox, Stripe).

## Known limits

- **Record access** covers contacts, companies, deals, tasks and conversations and what hangs on them. It does **not** (yet) filter invoices, contracts, appointments, tickets, tags or the planner's project counters – those areas have their own permission switches (*Berechtigungen*); keep a restricted person out of them if their content is sensitive. Counters and statistics (call statistics, counts next to a list) are totals of the sub-account, not narrowed; automations run with full access, so a restricted person should not get the *Automationen* area.
- **Merge undo** restores the contacts, their conversation and every moved row, but a sequence that **stopped because of a merge-time *Nicht stören*** stays stopped, and **sequence events** already written are kept as history.
- **Sequences** do not automate LinkedIn, do not rotate several mailboxes, and a reply that reaches a different mailbox than the sender's is only noticed if that mailbox is connected too.
- **Quotas** are counted per deal owner and period; deals without an owner appear in the leaderboard's "everyone" total but not in anyone's row. A deal's amount is the net sum of its positions in **whole units** (cents are kept in the positions and in the quote).
- **Quotes** are not legally binding documents by themselves: the drawn signature is a *simple* electronic signature with a checksum and audit trail, not a qualified one. Use a signature service for cases that require the written form.

## For developers

Everything plugs in through the registries as modules of its own; `server/modules/sales.ts` is the single line in `server/modules/index.ts`.

| Part | Module | Service (pure logic) |
|---|---|---|
| Record access | `modules/record-access.ts` | `services/record-access.ts` |
| Positions | `modules/deal-lines.ts` | `services/sales-lines.ts`, `services/deal-lines.ts` |
| Quotes | `modules/quotes.ts` | `services/quote-model.ts`, `quote-engine.ts`, `quote-page.ts` |
| Sequences | `modules/sequences.ts` | `services/sequence-model.ts`, `sequence-engine.ts` |
| Duplicates | `modules/contact-duplicates.ts` | `services/contact-dedupe.ts`, `contact-merge.ts` |
| Quotas | `modules/quotas.ts` | `services/quotas.ts` |
| Smart Lists 2.0 | `modules/smart-lists.ts` (in `crm-gaps.ts`; extends the `smart_lists` table of `modules/contacts.ts`, hook `app.services.contactOrder` used by `findContacts`) | `services/smart-lists.ts` (sort whitelist, columns, filter cleaning; `smartListById(app, locationId, id, ctx \| 'system')` / `smartListScope` – the one way any module loads a list) |
| Meeting notes | `modules/meeting-notes.ts` | – (hook `app.services.attachCallSummary`) |
| Internal approval | `modules/quote-approvals.ts` | `services/quote-approval.ts` (gate `app.services.quoteSendGates`) |
| Several signers | `modules/contract-signers.ts` (in `parity-booking.ts`; plugs into `contracts.ts` through router wrappers) | – |

- **Router wrappers.** `core/http.ts` has a `wrappers` hook: functions that wrap every handler of the router. The record-access module installs one that checks the record named by the path or the query, shapes the response and refuses the few routes that would leak. New routes that return the five record types need an entry in `RECORD_ROUTES`/`CHILD_ROUTES` (or a scoped list through `scopeClause()`); `tests/record-access-leaks.test.ts` fails when a listed route answers with a record the person may not see.
- **Hooks for other modules:** `app.services.recordAccess.resolve(ctx)`, `app.services.attachCallSummary`, `app.services.sequenceSend` (replace the real send in tests), `contracts.ts` exports `createSignedContract` for any module that needs a signed record.
- **Tests:** `tests/sequences-model.test.ts`, `sequences.test.ts`, `sales-lines.test.ts`, `quotes-model.test.ts`, `quotes.test.ts`, `contact-dedupe.test.ts`, `contact-duplicates.test.ts`, `quotas.test.ts`, `meeting-notes.test.ts`, `record-access.test.ts`, `record-access-leaks.test.ts`; isolation seeds for every new table in `tests/security-fixtures.ts`.
- **UI:** `web/src/pages/Sales*.tsx` (lazy chunk, `sales.css`), `ContactSales.tsx` (contact page), `SalesDeal.tsx` (deal drawer); Akademie tours in `web/src/tour/content/sales.ts`.
