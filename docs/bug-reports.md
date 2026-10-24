**English** · [Deutsch](bug-reports.de.md)

# Bug reports & wishes

Every login – agency admins as well as client logins that only see their own sub-account – can report
bugs, ask questions and wish for features in HyperLevel. Everything ends up as a **ticket in the helpdesk** of a
support sub-account of the agency (pipeline “Bug reports & wishes”); there is no second ticket store.
No credentials needed.

## Where reports go

*Agency → Bug reports & wishes → Support area for bug reports*: the sub-account whose tickets receive the reports.
By default, HyperLevel creates a sub-account of its own, **“HyperLevel Support”**, with the first report (named after
the white label, satisfaction survey off there). You can pick an existing one instead, e.g. the project
“My project” – new reports then go there, older ones stay where they are.

A one-time setup happens there:

- the ticket pipeline **Bug reports & wishes**: *New → Confirmed → In progress → Fixed → Shipped*, plus
  *Rejected* and *Duplicate* (stage IDs `neu`, `bestaetigt`, `in_arbeit`, `behoben`, `ausgeliefert`,
  `abgelehnt`, `duplikat`),
- the categories **Bug**, **Improvement request**, **Question**,
- the shared views **Bug reports & wishes** and **Automatically captured errors** in *Tickets*.

The **helpdesk SLA targets** apply as for any ticket (priority from the severity: Minor → low,
Annoying → normal, Blocking me → high, Critical → urgent). Wishes only have a deadline for the first reply,
none for implementation. Whoever reports becomes a **contact** in the support sub-account (by login e-mail address, tag
`GoHigh-Nutzer`, without triggering workflows) – they never get access to this sub-account.

## Reporting a bug

At the top right, **Feedback** (next to the “?” of the academy) → *Report a bug* – or, on any page,
<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd>. The window (✕ at the top right, <kbd>Esc</kbd> closes it) asks:

- **Kind:** bug, improvement request or question,
- **What happened?**, **What did you expect?**, **Steps to reproduce**, **How bad is it?**,
- **Screenshot** (optional): paste from the clipboard (<kbd>Ctrl</kbd>+<kbd>V</kbd>), choose a file or
  **Capture screen** (`getDisplayMedia`, if the browser can do it – the window hides itself while you do).
  PNG, JPG or WebP up to 3 MB; the browser shrinks large images first.
- **Diagnostic data** – attached automatically, can be viewed and removed one by one (or all together):
  page/URL, sub-account and role, web build, browser and system, window size, the last 20 errors in the browser
  (`window.onerror`/`unhandledrejection`) and the last 20 failed API calls (status, path,
  error text). **Never** request contents, form values, passwords or keys; the server cleans everything once
  more (tokens, `key=`/`token=` in URLs, e-mail addresses, card numbers, long random strings) and adds
  the server version, role and sub-account itself.

After that, HyperLevel shows the **ticket number**. The agency gets a push notification for new bugs and questions.

## My reports

*Feedback → My reports* (`/app/feedback`): only your own reports with status, the **public replies
from the team** (never internal notes), status changes and “Fixed in version …”. You can add info (with a screenshot too)
and **reopen** a finished or rejected report (it goes back to *New*).

When the status changes or the team replies, you get an **in-app notification** (red number on the
Feedback button), a **push notification** (kind “My reports & wishes”, can be turned off under My account), a
notification in the **Android app** and an **e-mail** (sent through the support sub-account's mail delivery, can be turned off under
My reports). Replies from the normal ticket view by e-mail are not sent twice.

## Wish list

*Feedback → Wish list* (`/app/wishes`) – for all users:

- **All wishes** of all users; only the agency sees the names of submitters and sub-accounts.
- **Submit:** title, description, area (CRM, Marketing, Websites & Funnels, Automations, Service, Revenue,
  AI, App, Agency, Other), optionally a screenshot (visible to everyone). Whoever submits automatically votes too.
- **Vote:** one vote per user, a second click takes it back. **Comments** are public (author
  “User”, “You” or “Team”); the author hears about new comments.
- **Search, filter** by area and status, **sort** by votes, new or status.
- **Roadmap:** *Idea → Planned → In progress → Done*, plus *Declined* with a reason. These are the same
  ticket stages (New → Confirmed → In progress → Shipped/Fixed, Rejected).
- When the status changes or a wish is implemented, **the author and everyone who voted** hear about it (app, push,
  e-mail). **Duplicates** are merged – votes and voters move along.

### What's new

*Wish list → What's new*: implemented wishes and fixed bugs, grouped by version. The titles of
bug reports stay private – only the line the team enters under “Fixed in version …” appears there (otherwise
“n bug fixes”). If there is something new since your last visit, the Feedback button shows a hint.

## Automatic error capture

- **Browser:** unhandled errors go – without contents – to `/api/feedback/client-errors` if the user
  allows it (*My reports → Report errors automatically*; on by default for admins, off for client logins).
  Noise such as `Script error.`, `ResizeObserver loop` or browser extensions is ignored.
- **App start:** if the web app does not come up after 10 seconds (blank page, missing file, browser too old),
  `web/public/boot-guard.js` sends the collected errors (without contents) as “App start failed …” – one ticket per cause,
  like all browser errors, only for signed-in users with capture turned on, at most every 10 minutes per device.
  The same applies to rendering errors that no page caught (the whole interface would otherwise be blank).
- **Server:** unexpected errors (HTTP 500) are captured with stack, route and **request ID** – never with the
  request contents. The response to the browser contains the request ID (`request_id`, header `x-request-id`).
- **Android app:** crashes and errors of the app go the same way (device, app version). “Send diagnostics” on the
  error screen of the web view creates a bug report with the WebView version, status and the latest errors.
- **Grouping:** one ticket per error (fingerprint from the message without numbers/IDs and the top
  stack line without line number and build hash) with a counter, first/last occurrence, the last 10 occurrences and
  affected sub-accounts; at 10, 100, 1000 … occurrences, a note on the ticket. If a fixed error occurs
  again, the ticket goes back to *Confirmed*.
- **Limits:** 20 error reports per user in 10 minutes, at most 30 new error tickets per hour (a
  broken update does not cause a flood of tickets), at most 10 reports per page load in the browser.
- To turn it off: *Agency → Bug reports & wishes* (server errors and/or browser/app errors).

Affected users with capture turned on only hear when the error is **fixed**.

## Triage for the agency

In *Tickets* of the support sub-account (view “Bug reports & wishes”), each of these tickets shows the field
**Bug reports & wishes** on the right: diagnostics (page, versions – with a note if the browser had an old web version –,
browser/device, latest errors with stack, failed requests, latest occurrences with request ID), screenshots,
occurrences, reporter or affected users with role and sub-account, affected sub-accounts, votes and
voters, and what the reporter sees. Actions:

- **As a duplicate of …** – search for the original (title or #number); reporters, votes and occurrences move over, the
  ticket becomes “Duplicate”, and the reporters are told.
- **Fixed in version …** (for wishes “Done in version …”) – version, optionally a line for “What's new”,
  “already shipped” (otherwise status *Fixed*). All linked reporters are notified.
- **Reply publicly**, **Reject** (with a public reason), and for wishes **hide**.

You manage status, priority, assignees and internal notes as with any ticket – every status change
notifies the reporters. *Agency → Bug reports & wishes* lists open reports, top wishes (by votes) and the
most frequent errors.

**Reports:** sources *Bug reports* (kind, status, severity, platform, version, sub-account, reporter,
occurrences, days to fix; fix rate) and *Feature requests* (area, votes, status; implemented rate).

### Triaging with Claude or Codex (MCP)

With an agency key, the following are available on the MCP server:

| Tool | Purpose |
| --- | --- |
| `ghl_list_bug_reports` | Reports (`kind`: reports/bug/question/auto, `state`, `status`, `sort` incl. `occurrences`, `q`) |
| `ghl_get_bug_report` | everything for troubleshooting incl. diagnostics, stack, request IDs, history and internal notes |
| `ghl_update_bug_report` | `status`, `reason`, `reply` (public), `fixed_in` + `changelog`, `note` (internal), `duplicate_of` |
| `ghl_list_wishes` | Wishes by votes (`status`: idea/planned/in_progress/done/declined, `area`, `q`) |
| `ghl_update_wish` | `status`, `reason`, `reply`, `shipped_in` + `changelog`, `note`, `duplicate_of`, `hidden` |

Typical flow: `ghl_list_bug_reports {sort: "priority"}` → `ghl_get_bug_report` → fix the bug in the code →
`ghl_update_bug_report {fixed_in: "2.4.1", changelog: "…"}`.

## Android app

*App settings → Report a bug* or long-press the app icon → **Report a bug**; optionally
“Shake to report”. The form includes a screenshot of the current screen (removable), the device
(model, Android version), the app version and the app's latest failed API calls. Plus *My reports*
and a simple *Wish list* (vote, submit). Interface: `/api/mobile/bug-reports` and
`/api/mobile/wishes` ([docs/api.md](api.md#mobile-app)).

## API

All routes apply to every signed-in user (deliberately not in `permissions.ts`) and return only your own
reports or public wish data; the triage routes are admin-only. List: [docs/api.md](api.md#bug-reports--wishes).

## For developers

`server/modules/feedback.ts` (tables, routes for users and the app, notifications), `feedback-admin.ts`
(setting, triage, MCP, report sources), `feedback-capture.ts` (automatic capture,
`app.services.serverError`), data layer `server/services/feedback-store.ts` (uses `services/tickets.ts`),
pure building blocks in `services/feedback.ts`. Interface: `web/src/pages/Feedback.tsx` (button, form, My
reports), `Wishes.tsx`, `FeedbackAdmin.tsx` (field in the ticket, agency tab), ring buffer in
`web/src/feedback/diagnostics.ts` (`api.ts` reports failed API calls through the event `pghl:api-error`).
Test hooks: `app.services.feedbackMailer` (e-mails), `app.services.feedbackCaptureReset()` (limits).
