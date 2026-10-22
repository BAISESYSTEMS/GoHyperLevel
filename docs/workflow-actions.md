# Workflow actions and triggers

HyperLevel workflows start at a **trigger**, run through **steps** (actions, waits, branches) and can be tested, versioned and
moved between sub-accounts as JSON. The library is built in – no Composio or Zapier needed for the common work:

- **130+ actions**: formatter, math, a sandboxed code step, find/find-or-create contact, go-to and goal jumps, A/B/n split
  tests, loops with a safe cap, drip, waits (for a field condition, a time window, a date relative to a field), webhook with
  retries and response mapping, per-run variables, internal notifications, round-robin assignment, opportunities, tasks,
  appointments, DND, tags, invoices/payment links/contracts, community, AI steps and 23 native app steps.
- **140+ triggers** with filters on every one of them: field changed (old/new), birthday/anniversary, cron schedule, form
  abandoned, page visited, payment failed/refunded, subscription ended, no-show/rescheduled, task overdue, unanswered
  conversation, review rating, custom events from the API, and the older ones (tags, forms, deals, messages …).

The exact numbers are computed from the registries (`GET /api/workflow-catalog` → `counts`); `tests/wfx-counts.test.ts`
fails if either README promises more than exists, and `tests/docs.test.ts` fails when a type is missing from
[All actions](#all-actions) or [All triggers](#all-triggers) – `npm run docs:gen` adds the missing rows.

Contents: [The editor](#the-editor) · [The canvas](#the-canvas) · [Copy and paste](#copy-and-paste) ·
[Pause a step](#pause-a-step) · [Validation](#validation) · [Variables and results](#variables-and-results) ·
[Expression language](#expression-language) · [Formatter](#formatter) · [Flow control](#flow-control) ·
[Data and CRM steps](#data-and-crm-steps) · [AI steps](#ai-steps) · [HTTP request](#http-request) ·
[Native app steps](#native-app-steps) · [Triggers](#triggers) · [Trigger filters](#trigger-filters) ·
[Test runs](#test-runs) · [Run log](#run-log) · [Versions, draft and publish](#versions-draft-and-publish) ·
[Import and export](#import-and-export) · [Custom events](#custom-events) · [API and MCP](#api-and-mcp) ·
[Limits and safety](#limits-and-safety) · [Self-hoster setup](#self-hoster-setup) · [Adding your own step](#adding-your-own-step) ·
[All actions](#all-actions) · [All triggers](#all-triggers)

## The editor

Automationen → open a workflow.

- **+ Schritt** opens the **action picker**: categories on the left (with counts), search on top (name, description and
  keywords; ↑/↓ and Enter work without a mouse), and a documentation pane on the right that says what the action does, what
  it needs (for example a connection under *Apps → Direkt-Verbindungen*) and which variables it sets. Double-click or
  **+ Hinzufügen** inserts it.
- Steps that have no editor of their own get a **generated form** from the catalogue: text, numbers, selects, tags,
  weekdays, conditions, lists of rows, pickers for pipelines, stages, calendars, forms, team members, products, contract
  templates, community groups and social channels, a *Ergebnis speichern in* target (variable or contact field) and a
  code field with the function reference. Fields appear only while they matter (`showIf`). **Beispiel einfügen** fills a
  working example.
- Every step can get a **name** (shown in the flow and in the log) and has a collapsible documentation under its title.
- **Einfach-Modus** ([theming](theming.md#einfach-modus)): a step shows its action fields; its name, *Fehler ignorieren und
  weiter* and the fine-tuning sit behind **Weitere Felder** – *Text ist HTML* and *Service-Nachricht* (e-mail, SMS), the
  expression of *Wenn/Sonst* and *Ziel*, name/currency/close date of a new opportunity, the pipeline filter of
  *Opportunity-Status*, *Anlegen, wenn keine offene existiert*, the webhook method. Generated forms show the required
  fields and at most five others; retries, timeouts, headers, query, auth, response mapping and the like fold away
  (`splitCatalogFields` in `web/src/areas/marketing-fields.ts`). The toggle opens by itself when one of those fields
  differs from its default. *Einstellungen → Fehlerbehandlung* folds the same way. Profi shows everything.
- **Containers** hold steps of their own: *Wenn/Sonst* (Ja/Nein), *Split-Test* (up to five paths) and *Schleife*. Moving,
  removing and finding steps works inside them.
- The **trigger** is chosen from a list grouped by topic. Under it: what the trigger does, the data it brings
  (`{{event.…}}`), its own settings (for the newer triggers) and **Zusätzliche Filter** for every trigger.
- Header buttons: **Testlauf**, **Speichern**, **Aktivieren/Pausieren**. Tabs: *Ablauf*, *Verlauf*, *Versionen*,
  *Einstellungen* (with export and delete).
- **Liste | Canvas** above the flow switches between the list editor and the [visual canvas](#the-canvas). Both edit the same
  steps; the choice is remembered in the browser. Every step card has an on/off switch ([pause](#pause-a-step)) and a **⋮**
  menu: *Kopieren*, *Duplizieren*, *Verschieben …*, *Pausieren/Fortsetzen*, *Löschen* ([copy and paste](#copy-and-paste)).

Every dialog has a ✕ at the top right, closes with Esc, and puts the focus back where it was.

## The canvas

*Ablauf → Canvas* shows the workflow as a diagram, like HighLevel's Advanced Builder – the same step JSON as the list, so a change
in one editor is in the other at once.

- **Picture:** a dotted grid; white node cards with a coloured icon tile (colour = category), the step's name or summary, an
  on/off switch and a ⋮ menu; the trigger on top (a dashed *Auslöser hinzufügen* card when a workflow has none); header cards
  for the lanes of *Wenn/Sonst* (Ja/Nein), *Split-Test* (A · 50 % …) and *Schleife* (a dashed line goes back to the loop);
  lanes join again below; **END** pills where the flow stops; a round **+** on every connector inserts a step there (with
  something on the clipboard it offers *Einfügen* as well).
- **Moving around:** drag the background to pan, mouse wheel or two fingers (pinch) to zoom, the zoom stack bottom right
  (+, percent = back to 100 %, −, fit) and a minimap (click or drag to jump). Keys: ↑/↓ walk the steps in reading order (into
  lanes and out again), ←/→ jump to the nearest step at the side, Shift+arrows pan, Enter opens a step, + / − / 0 / F zoom and fit, P pauses, Ctrl/⌘+C / V / D copy, paste after
  the selected step and duplicate, Delete removes, N adds a note, Shift+F10 opens the step's menu, ? lists them all.
- **Arranging:** steps, lane headers, the trigger and notes can be dragged. Positions are stored in `settings.layout` as offsets
  from the automatic layout (`offsets[<step id> | trigger | <step id>/<lane>] = [dx, dy]`): moving a container moves its
  lanes with it, inserting a step keeps a hand-arranged canvas tidy, and a node without an offset sits where the
  auto-layout puts it. **Anordnen** drops all offsets (notes stay). Saved with the workflow like any other change.
- **Sticky notes** (*Notiz*, N, or right-click on the background) are nodes of their own with text, five colours and a size
  (`settings.layout.notes`); the engine never reads them.
- **Statistik** shows on every step what the existing run counters say – of the last 300 runs: ✓ passed, ⚠ errors, ↷ skipped
  (paused), ⏳ waiting there now.
- **Settings:** clicking a step opens its usual form in a drawer on the right with a sticky footer: *Abbrechen* discards,
  *Speichern* applies and saves the workflow. ✕ and Esc close it (asking first when something changed). Missing settings show
  on the node (red, with the count) and at the top of the drawer.
- The canvas is a chunk of its own (`web/src/workflow-canvas/WorkflowCanvas.tsx`, hand-rolled HTML + SVG, no new dependency),
  loaded only when someone opens it; animations are off with *prefers-reduced-motion*. The server keeps `settings.layout`
  within limits (800 offsets, 100 notes of 2 000 characters; offsets of deleted steps are dropped –
  `server/modules/workflow-canvas.ts`).

## Copy and paste

Steps travel between workflows – also between sub-accounts and browser tabs – through a clipboard in the browser's local storage
(format `gohigh-steps`, version 1):

```json
{ "format": "gohigh-steps", "version": 1, "steps": [ … ], "source": { "workflow_id": "…", "workflow": "…" }, "references": ["pipeline_id:…"] }
```

- **Kopieren** (⋮ menu or Ctrl/⌘+C on the canvas) copies a step with everything inside it. The server cleans the copy like an
  export: secrets of HTTP steps (authorization headers, passwords) are blanked.
- **Einfügen** appears at every insert position (list: next to *+ Schritt*; canvas: on the **+**) while the clipboard holds
  steps. Like the [import](#import-and-export), every step gets a **new id**, jumps between the pasted steps follow their new
  ids, a jump to a step that is neither pasted nor in this workflow is cleared, and references to pipelines, forms,
  calendars, workflows, products, groups, courses, links or templates that do not exist here come back as **warnings** to
  fix. Nothing is saved until the workflow is.
- **Duplizieren** puts a copy right after the step (new ids, without the clipboard); **Verschieben …** lets you pick any insert
  position, also inside another lane (Esc cancels); **Löschen** asks first.

## Pause a step

The switch on a step card (or *Pausieren* in its menu, P on the canvas) sets `disabled: true` on the step. The step stays where it
is, but the engine **skips** it: the run log gets the line *Übersprungen – Schritt ist pausiert* (`skipped: true`) and the flow
goes on with the next step. A paused container (*Wenn/Sonst*, *Split-Test*, *Schleife*) skips its lanes too; a jump onto a
paused step continues after it. Test runs show the skipped steps the same way (badge *übersprungen (pausiert)*). Paused steps
are drawn dashed and are not [validated](#validation).

## Split test winner

The step *Split-Test* has the option **Gewinner automatisch übernehmen**. While the workflow is active, the server checks it every ten minutes: once every path has at least 100 contacts, the paths together reached at least 10 goals, and the path with the best goal rate is ahead of every other path with statistical significance (two-proportion z-test, p < 0.05), that path gets 100 % and the others 0 %. The decision is stored on the step (`auto_winner_result`: path, goal rate, p, time) and taken only once; contacts already in a path stay there ("Immer derselbe Pfad"). Without goals in the paths there is nothing to compare – put a *Ziel* step into each path.

## Folders and bulk actions

Above the workflow list, **Ordner anlegen** starts folders; a folder can hold sub-folders (up to five levels, *+* next to the folder row creates one inside the selected folder). Clicking a folder shows its workflows and those of its sub-folders, *Ohne Ordner* the rest. ✎ renames, ✕ deletes a folder – its workflows and sub-folders move one level up, nothing is lost.

**Mehrere bearbeiten** opens a list of the workflows shown: tick several and move them into a folder, **activate**, **pause** or **delete** them together. Status changes and deletes run through the normal routes one by one, so each workflow gets the same [check](#validation) as when activated by hand – a workflow that fails it is reported by name, the others go on – and each change lands in the history (undo). Folders travel in snapshots (by name). API: `GET/POST /api/workflow-folders`, `PATCH/DELETE /api/workflow-folders/:id`, `POST /api/workflows/bulk` `{action: move|activate|pause|draft|delete, ids, folder_id}`; MCP `ghl_workflow_folders`, `ghl_workflow_bulk` (activate/delete need a confirmation in the agent).

## Validation

Saving checks the steps (`server/services/workflow-validate.ts`, the same rules in the browser): fields the catalogue marks as
required (only while they are shown), the older steps' essentials (e-mail without subject and text, SMS or note without text,
tags, field, wait duration or date, conditions with field and value, pipeline, status, task title, webhook URL, target
workflow, social channels, at least two split-test paths) and jump targets that no longer exist. Issues show on the step in
both editors (red, with the message) and – after the first save – update while you fix them. Saving a draft is never refused;
**Aktivieren** with incomplete steps asks first. The answers of `GET` and `PATCH /api/workflows/:id` carry
`issues: [{step, code, field?, params?, message}]`, and `POST /api/workflows/:id/validate` checks unsaved steps (`{steps}`).

## Variables and results

- Each run has its own **variables** (`{{var.name}}`; in conditions the field `var.name`). They survive waits and are
  stored with the run. Names starting with `_` are internal.
- Most steps have **Ergebnis speichern in**: a variable (`var.total`) or a contact field (`first_name`, `custom.budget`).
  Contact fields are written by the engine, and a real change triggers *Feld geändert* (see
  [Trigger filters](#trigger-filters) for the loop guards).
- Steps that look something up set well-known variables, shown as chips in the picker (for example `var.contact_found`,
  `var.found_contact.email`, `var.deal.value`, `var.replied`, `var.discount_code`).
- The event of the trigger is `{{event.…}}`, the appointment, opportunity or message of the event are `{{appointment.…}}` etc.
  Merge fields support a fallback: `{{contact.first_name|there}}`.

## Expression language

The steps *Code*, *Rechnen → Eigene Formel*, *Springe zu*, *Ziel-Sprung*, *Warten bis Bedingung*, *Tags je nach
Bedingung*, the conditions of *Wenn/Sonst* and the trigger filters accept a small expression language. It is **not
JavaScript**: a hand-written tokenizer, parser and interpreter (`server/services/expr.ts`) – no `eval`, no
`new Function`, no globals, no `process`/`require`, no prototypes or constructors, no network, no files. The program sees
deep copies of `contact`, `event`, `var` and `location` and a fixed set of functions.

```
Values       numbers, 'strings', "strings", `template ${strings}`, true, false, null, [lists], {objects}
Operators    + - * / % **   == != === !==   < <= > >=   in   && || ??   !  -  +   a ? b : c   x?.y   x[i]
Statements   let x = …;  x = …;  x += …;  if (…) { … } else { … }  for (let i of list) { … }  while (…) { … }
             break;  continue;  return …;        (a single expression is a program, too)
Lambdas      x => x * 2     (a, b) => a + b     only as values, e.g. map(list, x => x.name)
Writing      var.score = var.score + 1           changes the workflow variable; everything else stays local
```

Examples:

```
contact.custom.budget > 1000 && 'vip' in contact.tags
round(number(var.netto) * 1.19, 2)
let sum = 0; for (let line of var.lines) { sum += line.qty * line.price } return sum
iif(diff_days(today(), contact.custom.vertragsende) < 30, 'bald', 'später')
```

Functions (the editor lists them under *Ausdruckssprache: Funktionen und Beispiele*; names are lower-case):

`abs(zahl)`, `add_business(datum, n)`, `add_business_days(datum, n)`, `add_days(datum, n)`, `add_hours(datum, n)`, `add_months(datum, n)`, `avg(liste)`, `bool(wert)`, `capitalize(text)`, `ceil(zahl)`, `clamp(zahl, min, max)`, `coalesce(a, b, …)`, `concat(a, b, …)`, `contains(text|liste, wert)`, `count_if(liste, x => …)`, `date(wert)`, `diff(von, bis, einheit)`, `diff_days(von, bis)`, `ends_with(text, ende)`, `every(liste, x => …)`, `filter(liste, x => …)`, `find(liste, x => …)`, `first(liste)`, `flatten(liste)`, `floor(zahl)`, `format_currency(zahl, währung?)`, `format_date(datum, muster?, zeitzone?)`, `format_number(zahl, stellen?, sprache?)`, `get(objekt, "pfad.zum.feld", ersatz?)`, `group_count(liste, x => schlüssel)`, `iif(bedingung, dann, sonst)`, `int(wert)`, `is_empty(wert)`, `is_number(wert)`, `is_weekend(datum)`, `join(liste, trenner)`, `json_parse(text)`, `json_stringify(wert)`, `keys(objekt)`, `last(liste)`, `len(text|liste)`, `lower(text)`, `map(liste, x => …)`, `max(a, b, …)`, `min(a, b, …)`, `now()`, `number(wert)`, `pad_left(text, länge, füllzeichen?)`, `pad_right(text, länge, füllzeichen?)`, `phone(text, vorwahl?)`, `pow(basis, exponent)`, `random()`, `random_int(von, bis)`, `range(von, bis, schritt?)`, `reduce(liste, (summe, x) => …, start)`, `regex_match(text, muster, gruppe?)`, `regex_replace(text, muster, ersatz)`, `regex_test(text, muster, optionen?)`, `repeat(text, n)`, `replace(text, suche, ersatz)`, `reverse(liste)`, `round(zahl, stellen?)`, `slice(liste|text, von, bis?)`, `slug(text)`, `some(liste, x => …)`, `sort(liste, (a, b) => …?)`, `sort_by(liste, x => schlüssel)`, `split(text, trenner)`, `sqrt(zahl)`, `starts_with(text, anfang)`, `string(wert)`, `strip_html(text)`, `substr(text, start, länge?)`, `sum(liste)`, `title_case(text)`, `today()`, `trim(text)`, `unique(liste)`, `upper(text)`, `values(objekt)`, `weekday(datum)`


Methods work on values too – strings: `toUpperCase`, `toLowerCase`, `trim`, `startsWith`, `endsWith`, `split`, `replace`, `padStart`,
`padEnd`; lists: `join`, `map`, `filter`, `find`, `some`, `every`, `reduce`, `push`, `pop`; numbers: `toFixed`; any value: `includes`, `slice`,
`indexOf`, `toString`.

**Limits** (per evaluation): 8 000 characters of source, 4 000 syntax nodes, nesting 60, 20 000 evaluation steps
(`while (true) {}` ends with an error), 150 ms, call depth 40, strings of 100 000 characters, lists of 10 000 items,
200 000 characters of output. Keys named `__proto__`, `constructor` and `prototype` are refused. Regular expressions go
through a guard that rejects catastrophic patterns (nested quantifiers) and cuts the input at 10 000 characters. Errors are
German messages; in conditions an expression that fails counts as "no". Syntax is checked when the workflow is saved.

## Formatter

*Text formatieren*, *Zahl formatieren* and *Datum / Zeit* (`format_text`, `format_number`, `format_date`) apply one
operation and store the result.

- **Text**: upper/lower/capitalize/title case, trim, collapse spaces, replace, regex replace and extract, split (list, or
  one piece by position), extract e-mail/phone/number/URL, substring/left/right, length, truncate, pad, slug,
  URL-encode/decode, prepend/append, default, normalise phone number (`+49…`), first/last word, initials, reverse, strip
  HTML, remove diacritics, repeat, line/word count.
- **Number**: German and English notation are read (`1.234,56`, `1,234.56`, `€ 12.50`, `(3)`); round (half up, or
  banker's), floor/ceil with decimals, abs, format, currency, percent, pad with zeros, clamp, sign, ordinal, fixed. A lone
  `1.234` is read as 1.234 (decimal), `1.234.567` as 1 234 567.
- **Date/time**: add/subtract minutes, hours, days, weeks, months, years and **business days**; format with patterns
  (`DD.MM.YYYY HH:mm`, `dddd, D. MMMM YYYY`, shortcuts `date`, `datetime`, `time`, `long`, `iso`); convert between time
  zones; start/end of hour, day, week (Monday), month, year; difference in whole units; weekday; is/next business day;
  age; ISO and Unix; set the time. Holidays are one `YYYY-MM-DD` per line.

Time zone rules (all in `server/services/formatters.ts`, tested in `tests/formatters.test.ts`):

- Days, weeks, months, years and business days move the **wall clock** of the zone: "+1 day" at 12:00 stays 12:00 across a
  daylight-saving change even though that day has 23 or 25 hours. Minutes and hours are elapsed time.
- A local time that does not exist (spring gap) moves to the first valid minute; an ambiguous one (autumn) resolves to the
  later occurrence.
- Months clamp the day (31 Jan + 1 month = 28/29 Feb); differences count whole calendar units of the zone.
- The default zone is the sub-account's time zone.

## Flow control

| Step | Notes |
| --- | --- |
| *Springe zu Schritt* (`goto`) | Jumps to any step, optionally under a condition. At most `max_jumps` jumps (default 10, hard cap 100), then the flow simply continues. |
| *Ziel erreicht → springe* (`goal_jump`) | If the goal condition holds: jump to a step or end the flow. Counts as success in split-test statistics. |
| *Split-Test (A/B/n)* (`split_test`) | 2–5 paths with percentage weights; each path is a lane of steps, afterwards the flow continues together. "Immer derselbe Pfad" keeps a contact on its path on re-entry. `{{var.<name>}}` holds the path name. Assignments are stored for the statistics. |
| *Schleife* (`loop`) | Runs its steps for each item of a list (`{{var.items}}`, JSON, or one entry per line). `{{var.item}}` and `{{var.index}}` (names configurable). At most 100 items by default, 500 at most; the list is remembered when the loop starts. |
| *Tröpfchen-Freigabe* (`drip`) | N contacts per period (for example 20 per hour); a contact that arrives when the slot is full waits for the next one. |
| *Warten bis Bedingung* (`wait_until`) | Checks every N minutes (default 15). Optional time limit with continue / end / jump. |
| *Warten auf Zeitfenster* (`wait_window`) | Business hours: allowed weekdays, from–to in the zone, holidays skipped. Inside the window the flow continues immediately. |
| *Warten bis Datum (relativ)* (`wait_date`) | Waits until a date from the contact, event or a variable plus/minus an offset (minutes … business days) at an optional time; "every year" takes the next anniversary. |
| *Warten auf Antwort* (`wait_reply`) | Checks every N minutes for a reply of the contact; `{{var.replied}}` is yes/no after the wait. |

Engine guards: at most **5 000 steps per run** (`settings.max_steps` raises it to 20 000), so no loop or go-to chain runs
away; a run that needs many steps carries on in short passes instead of blocking the server. Loops re-enter their lanes;
every pass is logged.

## Data and CRM steps

*Variablen setzen*, *Mehrere Felder setzen*, *Felder leeren*, *Feld kopieren*, *Liste bearbeiten*, *JSON auslesen*, *Wert
zuordnen*, *Zufall*, *Code (Ausdruck)* and *Rechnen* cover data work. *Kontakt suchen* / *Kontakt suchen oder anlegen*
find a contact by e-mail, phone or a custom field and can **switch the run to the found contact**; *Deal suchen* sets
`var.deal.*`. *Deal ändern*, *Aufgabe ändern/abhaken*, *Termin anlegen*, *Termin ändern/absagen*, *DND je Kanal*, *Tags je
nach Bedingung*, *Nutzer zuweisen (Round-Robin)* (weighted, fair across restarts), *Aus allen Workflows entfernen*,
*Interne Benachrichtigung* (app, web push, e-mail to staff, SMS to fixed numbers), *Eigenes Ereignis auslösen*,
*Rechnung / Angebot erstellen*, *Zahlungslink erstellen*, *Vertrag aus Vorlage erstellen*, *In/Aus Community* and
*Social-Post-Entwurf (mit KI)* reuse the existing modules and their rules (permissions, audit log, DND, plan limits).

Per-channel **DND** is respected when sending from workflows, campaigns and the inbox: single channels (e-mail, SMS) are
blocked at send time; "all channels" sets the contact's general *Nicht stören*.

## AI steps

*KI: Text einordnen*, *Felder aus Text lesen*, *Stimmung erkennen*, *Zusammenfassen* and *Übersetzen* call the
sub-account's AI (`app.services.aiRun`) with a **JSON schema**, so the answer is structured and validated: classify returns one
label from your list (or several) plus a confidence, extract fills only fields that are really in the text, sentiment
returns positive/neutral/negative and a score, summarise and translate return text. The customer's text is passed between
markers as data; instructions inside it are ignored. All calls count against the monthly AI limit and are logged. Without an
AI assistant the step fails with a clear message.

## HTTP request

*HTTP-Anfrage (Webhook mit Antwort)* (`http_request`): method, URL, query, headers, JSON/form/text body and authentication
(bearer, basic or API-key header) with merge fields; up to 5 **retries** on 429, 5xx and connection errors with
exponential back-off (1, 2, 4 … s) that honours `Retry-After`. The response is available as `{{var.response.data.…}}`
(name configurable); **Antwort übernehmen** maps single values into variables or contact fields (`data.items.0.id`,
`$status`, `$text`, `$headers.name`). Requests go through `safeFetch`: internal and private targets are blocked. Header
values and passwords are masked in the run log and in exports. Put long-lived keys in *Apps → Direkt-Verbindungen* rather than in steps.

## Native app steps

Twenty-three steps for popular apps, **without Composio**, built on the connector framework
(`registerConnector`, see [connectors.md](connectors.md#adding-a-native-connector)). Credentials are saved per sub-account
under *Apps → Direkt-Verbindungen* (secrets sealed, never returned to the browser). Where an app signs in with OAuth you can
instead enter the name of a **Nango integration** in the field *Nango-Integration*; the step then calls the app through
Nango's proxy (see [connectors.md](connectors.md)). All outbound calls use `safeFetch`; in the run log tokens, keys and webhook
URLs are masked.

| App | Steps | Credentials (Apps → Direkt-Verbindungen) | Notes |
| --- | --- | --- | --- |
| Slack | `slack_post_message` | Bot token (`xoxb-…`, scope `chat:write`, `chat:write.public` for channels without invite), default channel | Thread replies via `{{var.slack_ts}}`; Slack's error codes are explained in German. Nango path prefix: none. |
| Microsoft Teams | `teams_post` | Webhook URL of a channel (Workflows "post to a channel when a webhook request is received", or the classic Incoming Webhook) | Posts an adaptive card with title, text and optional https button. Only Microsoft webhook hosts are accepted. |
| Trello | `trello_create_card` | API key + token, default list id | Due date, labels, position. Nango prefix `/1`. |
| Asana | `asana_create_task` | Personal access token, default project (or workspace) | Due date, assignee (`me`, e-mail or gid). Nango prefix `/api/1.0`. |
| ClickUp | `clickup_create_task` | Personal API token (`pk_…`), default list id | Priority 1–4, due date, assignee ids, tags. Nango prefix `/api/v2`. |
| Airtable | `airtable_create_record`, `airtable_update_record` | Personal access token (`pat…`, scopes `data.records:read/write`), default base id | Update by record id or by a lookup field; optional create-if-missing (upsert); `typecast` on. Nango prefix `/v0`. |
| Notion | `notion_create_item` | Token of the existing *Notion* connection | Reads the database schema and fills columns by type (title, rich text, number, select, multi-select, status, checkbox, date, e-mail, phone, URL); unknown columns and unsupported types are reported before anything is written. |
| Google Sheets | `gsheets_append_row`, `gsheets_update_row` | The existing *Google Sheets* connection ("Mit Google verbinden") | Values are written `RAW` (a leading `=` is text, not a formula). Update finds the row by a value in a column (case-insensitive) and can append when missing. |
| Google Calendar | `gcal_create_event` | A connected Google calendar of a team member (*Einstellungen → Mein Konto → Google- oder Outlook-Kalender*) or a Nango integration | Repeat-safe: the event id is derived from run and step, so a retry never creates a second event. With an attendee Google sends the invitation. Time zone and daylight saving follow the sub-account. |
| HubSpot | `hubspot_create_contact`, `hubspot_update_contact` | Private app token (`pat-…`, scopes `crm.objects.contacts.read/write`) | Create updates an existing contact on HubSpot's 409; update by id or e-mail with optional upsert. Empty fields are not sent. |
| Mailchimp | `mailchimp_add_member` | API key (`…-us21`; the data center is validated so it can never name another host) + default audience | Upsert by the MD5 member hash; `status_if_new` keeps unsubscribed members unsubscribed; double opt-in; tags; merge tags. Only for contacts with consent. Nango prefix `/3.0`. |
| Brevo | `brevo_add_contact` | API key | Creates or updates, adds to lists, phone number in international format. Only for contacts with consent. |
| Shopify | `shopify_create_discount`, `shopify_get_order` | Shop `name.myshopify.com`, Admin API token (`shpat_…`, `write_discounts`, `read_orders`), optional API version (default `2026-04`) | Admin GraphQL. The generated discount code is stable per run and step, so a retry does not create a second one. Orders by number (`#1001`) or id; a missing order sets `var.shopify_found` to false instead of failing. Orders older than 60 days need `read_all_orders`. |
| WooCommerce | `woocommerce_get_order` | Store URL (https), consumer key and secret (read) | Order status, total, items, payment method, e-mail. |
| Stripe | `stripe_create_customer`, `stripe_create_payment_link` | The sub-account's own Stripe key (*Einstellungen → Stripe*) | Customer reuses an existing one by e-mail; the payment link creates product → price → link, each with an idempotency key (one-off or subscription, adjustable quantity, redirect). The payment appears in Stripe, HyperLevel does not book it as an invoice – use *Rechnung erstellen / Zahlungslink* for that. With a live key these are real objects. |
| Calendly | `calendly_cancel_event` | Personal access token | Takes the event URI or id (for example from a Calendly webhook via *Webhook empfangen*). Cannot be undone. |
| Typeform | `typeform_get_response` | Personal access token (`responses:read`, `forms:read`), optional EU API address | By response id, by search term (for example the contact's e-mail) or the latest; answers as `{{var.typeform.<ref>}}` and `{{var.typeform_text}}`. |
| Zoom | `zoom_create_meeting` | Server-to-Server OAuth: account id, client id, client secret (scope `meeting:write:meeting:admin`), host e-mail | The token is cached for its lifetime. `{{var.zoom_join_url}}`, `{{var.zoom_meeting_id}}`, `{{var.zoom_password}}`; the host's start link is never stored. Zoom has no idempotency: a retry after an error can create a second meeting. |

Nango's base URL differs per provider; the steps add the path prefix that the provider's documented API needs. If a call through
Nango answers 404, compare the integration's base URL in Nango with the prefix above.

None of these steps can be verified without real credentials; the mocked tests (`tests/wfx-apps.test.ts`) pin down the
requests they send.

## Triggers

All triggers accept the **additional filters** below. Triggers that fire from time (*Zeitplan*, *Geburtstag*, *Jahrestag*,
*Termin beginnt bald*, *Nachricht unbeantwortet*, *Rechnung überfällig*, *Formular abgebrochen*) run per
workflow in the background scanner and fire **once** per contact/object (`wfx_fired`). (*Aufgabe überfällig* is
announced by the planner's own scan – see below.) These "already fired" marks are kept as long as the scan can still see the
record (unanswered messages 10 days, abandoned forms 7, overdue invoices 150, appointments and date triggers about a year),
then they are deleted.

Notes on the newer triggers:

- **Feld geändert** (`field.changed`): fires for real changes only – from the contact form, import, API, forms or a
  workflow. `{{event.field}}`, `{{event.old}}`, `{{event.new}}`; optional *from*/*to* values (case-insensitive). A workflow
  never starts itself with its own changes and chains stop at depth 4.
- **Zeitplan** (`schedule.cron`): five fields `m h dom mon dow`, lists, ranges, steps, names and macros (`@daily`). Evaluated on
  the **wall clock of the sub-account's time zone** (or a chosen one): a time inside the spring gap runs right after the gap, a
  doubled autumn hour fires once; missed ticks are caught up for 10 minutes. At each tick the workflow starts for all
  contacts matching the tag filters (up to *Maximal*, at most 5 000); a contact enters only once unless re-entry is allowed.
- **Geburtstag / Jahrestag**: once a year per contact at the chosen time in the zone; 29 February counts on 28 February in
  other years; offset in days before/after; `{{event.age}}` / `{{event.years}}`.
- **Missed days (server off)** – *Geburtstag*, *Jahrestag* and *Geburtstag / Datum erreicht* (`date.reached`): a day whose
  time passed while the server was off (or between two scans around midnight) is caught up at the next scan, **at most 3 days
  back** (`DATE_CATCH_UP_DAYS`, `server/services/wfx-triggers.ts`); older days are skipped. It never fires twice for the same
  contact, date and year (the same records as on time: `wfx_fired`, `date_trigger_fires`), only for contacts that existed on
  that day, and only for days after the workflow was last switched on or changed – a workflow switched on today, or paused over
  the day, does not send it afterwards. The run carries `{{event.late_days}}` (1–3), so a step can say "nachträglich".
- **Formular abgebrochen**: as soon as an active workflow with this trigger exists, the form remembers name, e-mail and phone
  while they are typed (nothing else) and starts the workflow when the form is not submitted after the set minutes. Partial
  entries are deleted after 3 days. Use it only if your form's privacy notice says so.
- **Seite besucht**: recognises the contact by the attribution visitor cookie (set with consent); at most once per contact
  and page in 30 minutes.
- **Zahlung fehlgeschlagen / erstattet, Abo beendet**: come from Stripe webhooks; see [Self-hoster setup](#self-hoster-setup).
- **Termin nicht wahrgenommen / abgesagt / verschoben / beginnt bald**, **Nachricht unbeantwortet**, **Rechnung überfällig**:
  short forms and scanners with a calendar or channel filter and grace times.
- **Rechnung überfällig** counts *Tage nach Fälligkeit* in **calendar days of the sub-account's time zone**, like the dunning
  levels: an invoice due yesterday at 23:00 is 1 day overdue at 08:00 today (the due day itself is 0). `{{event.daysOverdue}}`
  counts the same way; 0 days fires as soon as the due time has passed.
- **Aufgabe überfällig**, **Aufgabe angelegt**, **Aufgaben-Status geändert**, **Aufgabe zugewiesen**, **Aufgabe erledigt**:
  come from the project planner ([docs/projects.md](projects.md)); the overdue scan runs there (once per task and due date),
  and the settings offer a project filter (and status, category or person where it fits). Only tasks with a contact start a
  workflow. The steps *Aufgabe im Projekt anlegen*, *Aufgabe: Status setzen* and *Aufgabe zuweisen* act on those tasks.
- **Eigenes Ereignis**: see [Custom events](#custom-events).
- **Bewertung** triggers accept `min_rating` and `max_rating`.

### Outgoing messages

Two triggers react to the sending side of a conversation:

- **Ausgehende Nachricht gesendet** (`message.outbound`) – an e-mail, SMS, chat, WhatsApp or other message to the contact went out (sent, delivered, or recorded without a provider; failed sends and drafts do not count, calls have *Anruf beendet*). Filters: channel and **sender** – *Teammitglied*, *Kampagne*, *KI*, *System* (appointment confirmations, invoices …), *Workflow*. By default messages of workflows are left out, so two automations cannot keep triggering each other; choose *Workflow* or *Alle, auch Workflows* to include them. `{{event.sender}}`, `{{event.userName}}`, `{{event.message.body}}` are available.
- **Teammitglied hat geantwortet** (`message.team_reply`) – a person answered the contact (inbox, contact page, app, API/MCP). Filters: channel and person. Typical: stop a reminder sequence, close the conversation, move the deal.

Every path a message takes out (composer, workflows, campaigns, mailbox sync, channel modules) is covered: SQL triggers on the messages table note each message that turns *sent* in a small queue, which is emptied right after each request and on every tick.

## Trigger filters

Every trigger has **Zusätzliche Filter** in the editor, stored in the trigger config:

```json
{ "filters": [{ "field": "event.amount", "op": "gte", "value": "100" }], "filters_match": "all", "filter_expression": "contact.city == 'Köln'" }
```

`field` is a contact field (`tag`, `email`, `first_name`, or `contact.custom.<key>` for a custom field), `event.…` or `var.…`; `filters_match` is `all` or
`any`; `filter_expression` is an [expression](#expression-language) and wins over the list when set.

Condition operators (also used by *Wenn/Sonst*, *Springe zu*, *Warten bis* …): `has`, `not_has`, `equals`, `not_equals`,
`contains`, `starts_with`, `ends_with`, `in`, `not_in` (comma list), `empty`, `not_empty`, `gt`, `gte`, `lt`, `lte`, `between`
(`10, 20`), `regex` (guarded), `date_before`, `date_after` (`now` or a date).

## Test runs

**Testlauf** in the editor (or `POST /api/workflows/:id/test-run`, MCP `ghl_workflow_test_run`) plays the workflow through
with sample data without sending or changing anything:

- Steps that only compute (**formatter, math, code, variables, find, flow control, loops, split test, waits as "would wait
  until …"**) really run; their results appear in the log and in the variables at the end.
- Steps with side effects (messages, writes, API calls, AI) show **what they would do**: the rendered inputs, marked
  "nicht ausgeführt".
- Sample contact (Erika Muster) or a real contact that is only **read**; the event comes from the trigger's sample
  (editable JSON), plus optional preset variables. Unsaved changes can be tested without saving
  (`workflow: { trigger, steps, settings }`).
- Waits end the run with the status "würde warten"; the step cap and loop caps apply.

## Run log

*Verlauf → Protokoll* shows every step of a run with its **input**, **output**, the values it **set** and the time in
milliseconds (`GET /api/workflow-runs/:id`). Secrets (tokens, keys, passwords, webhook URLs, authorization headers) are
masked, long values are clipped. The run list itself carries only a slim log.

## Error handling

What happens when a step fails (**Einstellungen** of the workflow and the step's own editor):

- **Per step – "Fehler ignorieren und weiter"** (`continue_on_error: true`): the error is written to the run log (marked as ignored), the
  run goes on with the next step – also when the workflow stops on errors – and nothing is reported.
- **Per workflow – "Bei Fehler anhalten"** (`stop_on_error`) as before: the run stops at the failing step with the status *fehlgeschlagen*;
  without it, it logs the error and continues with the next step.
- **Per workflow – reaction** (`on_error_workflow_id`, `error_bell`, `error_email`), once per run for the first failing step that is not
  ignored (and again after a repeat that fails again):
  - **"Bei Fehler: anderen Workflow starten"** runs the chosen (active) workflow for the same contact. It sees the error as
    `{{event.error.message}}`, `{{event.error.step}}` (the step's name as in the editor), `{{event.error.workflow}}`,
    `{{event.error.step_type}}`, `{{event.error.run_id}}` and `{{event.error.stopped}}`; its trigger should be *Manuell*. A run that
    is itself an error handler never starts another one (no loops). The workflow can only be one of the same sub-account (copies
    of a snapshot point at the copied handler, imports drop the setting).
  - **Glocke** sends a push notification (kind *Workflow-Fehler*, switchable under *Mein Konto*) to everyone with access to the
    area *Automationen*; **E-Mail** goes to the company e-mail with the failing step, the message and the contact. At most 10 notices per
    workflow and hour.
- **Repeat from the failed step:** a stopped run offers **Ab Fehler wiederholen** in *Verlauf* (and **Alle ab dem Fehler wiederholen** for the
  whole workflow): it continues at the step that failed – the steps before it do not run again – after you fixed the step or its
  cause. `POST /api/workflow-runs/:id/retry`, `POST /api/workflows/:id/retry-failed` (at most 100, oldest first). Needs an active
  workflow; the step budget starts fresh. Runs that continued after an error (no stop on error) cannot be repeated – their
  later steps already ran.
- Outgoing webhooks and REST hooks get the event **`workflow.step_failed`** `{contactId, failure: {workflowId, workflowName, runId,
  stepId, stepType, step, message, stopped, at}}` for workflows with a reaction set up. Test runs report nothing.

## Versions, draft and publish

- Every saved change (editor, API, MCP, import) creates a **version** (hash-deduplicated, the last 50 are kept) with the
  user and a short summary ("2 Schritte neu · 1 geändert").
- **Entwurf**: *Versionen → Aktuellen Stand als Entwurf speichern* stores the editor state without touching the live workflow
  (`PUT /api/workflows/:id/draft`). **Entwurf veröffentlichen** (`POST …/publish`, optional note) replaces the workflow and
  becomes a version. *Als Entwurf wiederherstellen* puts an old version into the draft; nothing goes live until you publish.
- Saving in the editor stays immediate, as before – the draft is for bigger rebuilds that you test first.

## Import and export

*Einstellungen → Als JSON exportieren* (one workflow), *Alle exportieren* and *Importieren* on the list. The format is
`gohigh-workflow` (one) or `gohigh-workflows` (bundle), version 1:

```json
{ "format": "gohigh-workflow", "version": 1, "workflow": { "name": "…", "trigger": { "type": "…", "config": {} }, "steps": [], "settings": {} }, "references": ["pipeline_id:…"] }
```

Secrets in header rows and passwords of HTTP steps are blanked on export. On import all step ids are regenerated (go-to
targets are rewritten), the workflow is created as a **draft** (never active), and references to pipelines, forms,
calendars, workflows, products, groups, courses, links and templates that do not exist in the target sub-account come back as
**warnings**.

## Custom events

`POST /api/custom-events` with `{ "name": "bestellung_versendet", "email": "a@b.de", "create": true, "data": { … } }`
(contact by `contact_id`, `email` or `phone`; `create` makes the contact if needed; data up to 50 KB) fires the trigger
**Eigenes Ereignis** (name empty = any). The data is `{{event.<field>}}`. The same works from MCP (`ghl_emit_event`) and from the step
*Eigenes Ereignis auslösen*. Chains are limited to 4 levels and a workflow never starts itself.

## API and MCP

| Endpoint | Purpose |
| --- | --- |
| `GET /api/workflow-catalog?q=&category=&kind=&compact=1` | Actions and triggers with category, docs, fields, samples, function reference and counts |
| `POST /api/workflows/:id/test-run` | Dry run (see above) |
| `GET /api/workflow-runs/:id` | Full run log of one run |
| `GET /api/workflows/:id/split-stats` | Split-test results per path |
| `POST /api/workflow-runs/:id/retry`, `POST /api/workflows/:id/retry-failed` | Repeat a stopped run (or all of them) from the failed step |
| `GET /api/workflows/:id/versions`, `GET …/versions/:n`, `POST …/versions/:n/restore` | Versions |
| `GET/PUT/DELETE /api/workflows/:id/draft`, `POST /api/workflows/:id/publish` | Draft and publish |
| `GET /api/workflows/:id/export`, `GET /api/workflow-export`, `POST /api/workflow-import` | Export and import |
| `POST /api/workflows/:id/copy` `{steps}`, `POST /api/workflows/:id/paste` `{data, existing_ids?}` | [Copy and paste](#copy-and-paste): the clean `gohigh-steps` copy, and steps with new ids plus warnings |
| `POST /api/workflows/:id/validate` `{steps?}` | [Validation](#validation) of unsaved (or the stored) steps → `{ok, issues}` |
| `POST /api/custom-events` | Fire a custom event |
| `GET /api/connector-apps/google-calendars` | Google calendar connections usable by the Calendar step |
| `POST /api/public/forms/:id/partial` | Public beacon of the form-abandoned trigger (stores only while such a workflow is active) |

All routes belong to the permission area **Automationen** (`workflows`), are scoped to the sub-account of the session or API key
and end up in the audit log like every other write. MCP tools: `ghl_workflow_catalog`, `ghl_workflow_test_run`,
`ghl_workflow_export`, `ghl_workflow_import`, `ghl_emit_event`. There are no mobile-app endpoints for this feature – workflows are edited on a
desktop screen.

## Limits and safety

- Expression evaluator: see [Expression language](#expression-language). Regular expressions are guarded everywhere (text
  steps, conditions, form patterns of apps).
- Per run: 5 000 steps (raise with `settings.max_steps` to 20 000), loops 100/500 items, go-to 10/100 jumps, HTTP retries 5.
- The loop and go-to guards do not throw – they continue after the limit and say so in the log.
- Native app steps validate every host (Shopify `*.myshopify.com`, Mailchimp data center, Teams webhook hosts, https only for
  WooCommerce) and use `safeFetch`; the Stripe steps use the sub-account's own key with idempotency keys.
- Secrets never reach the browser, the run log or exports.

## Self-hoster setup

| Feature | What to set up |
| --- | --- |
| Payment triggers | In the Stripe webhook add `invoice.payment_failed`, `checkout.session.async_payment_failed`, `charge.refunded` and `customer.subscription.deleted` ([stripe.md](stripe.md)). |
| Google Sheets / Calendar steps | Agency → Integrationen: the Google OAuth app; add the redirect URI of Google Sheets (`/oauth/google/sheets/callback`) and enable the Sheets API; for Calendar connect a calendar under *Einstellungen → Mein Konto → Google- oder Outlook-Kalender* (needs the Calendar API). |
| App steps | Per sub-account under *Apps → Direkt-Verbindungen*; see the table above. For OAuth apps set up [Nango](connectors.md) and enter the integration name. |
| Form abandoned | Nothing – add the privacy notice to the form. The beacon is public but only stores while an active workflow uses the trigger. |
| AI steps | An AI connection or the agency's AI assistant (see [ai-providers.md](ai-providers.md)). |
| Cron/scanner triggers | Nothing – they run in the server's tick (the same as waits). Keep the server's clock and the sub-account's time zone correct. |

No new npm packages are used.

## Adding your own step

Modules register steps through the hooks on `app.services`:

- `workflowActions[type] = (run, step, vars, flowCtx) => string | ActionOutcome` – the handler.
- `workflowActionMeta[type]` – the description for the picker and the generated form (`ActionMeta`: label, category,
  summary, doc, `fields`, `provides`, `pure` (allowed in test runs), `needs`, `app`, `sample`).
- `workflowTriggers` (type names), `workflowTriggerMeta[type]` (`TriggerMeta` with `fields` and a `sample` event) and
  `workflowTriggerFilters[type] = (config, data) => boolean`.
- `workflowStepCleaners[type]` (and `'*'`) – normalise or reject a step when a workflow is saved.
- `workflowStepSkips` – a list of `(step) => reason | undefined`; a reason makes the engine skip the step with that log line
  (used by [pausing](#pause-a-step)).
- `registerActions` / `registerActionMeta` / `registerTriggers` in `server/services/wfx-kit.ts` do the bookkeeping.

An `ActionOutcome` may carry `result` (log line), `output`, `vars`, `fields` (contact fields to write), `goto`, `enter`
(a lane of a container), `wait_until`, `stay`, `end` and `contact_id` (switch contact). The code is split in
`server/services/wfx-*.ts` (data, flow, AI, HTTP, catalogue, triggers helpers) and `server/modules/wfx-*.ts`,
`connector-apps-*.ts`; none of it lives in `main.ts`, `server.ts`, the state store or `protocol.ts`.

**What the tests check for you.** `tests/wfx-counts.test.ts` fails when a registered step or trigger is missing from the
catalogue (or has no label, summary or category). `tests/wfx-sweep.test.ts` walks the catalogue: it fires the event of
**every** trigger (with its `sample`) and expects a run, and runs **every** action with its `sample` settings behind the
outbound guard, expecting a result or a readable German error – never a JavaScript error name or a stack frame. A new step
that has no `sample` is run with empty settings, so give it one. What a step actually does still needs its own test.

## All actions

### Ablauf & Logik

| Action (name in the UI) | Type | Sets |
| --- | --- | --- |
| Aus allen Workflows entfernen | `remove_all_workflows` |  |
| Aus Workflow entfernen | `remove_from_workflow` |  |
| Eigenes Ereignis auslösen | `emit_event` |  |
| Ende | `end` |  |
| In anderen Workflow | `add_to_workflow` |  |
| Schleife (für jedes Element) | `loop` | `var.item` `var.index` |
| Split-Test (A/B/n) | `split_test` |  |
| Springe zu Schritt | `goto` |  |
| Tröpfchen-Freigabe (Drip) | `drip` |  |
| Warten | `wait` |  |
| Warten auf Antwort | `wait_reply` | `var.replied` |
| Warten auf Zeitfenster | `wait_window` |  |
| Warten bis Bedingung | `wait_until` |  |
| Warten bis Datum (relativ) | `wait_date` |  |
| Wenn / Sonst | `if` |  |
| Ziel erreicht → springe | `goal_jump` |  |
| Ziel erreicht? → Ende | `goal` |  |

### Daten & Formatierung

| Action (name in the UI) | Type | Sets |
| --- | --- | --- |
| Code (Ausdruck) | `code` |  |
| Datum / Zeit | `format_date` |  |
| Feld kopieren | `copy_field` |  |
| Felder leeren | `clear_fields` |  |
| JSON auslesen | `json_extract` |  |
| Liste bearbeiten | `array_op` |  |
| Mehrere Felder setzen | `set_fields` |  |
| Rechnen | `math` |  |
| Text formatieren | `format_text` |  |
| Variablen setzen | `set_variable` |  |
| Wert zuordnen | `value_map` |  |
| Zahl formatieren | `format_number` |  |
| Zufall | `random_pick` |  |

### Kontakte & CRM

| Action (name in the UI) | Type | Sets |
| --- | --- | --- |
| Aufgabe ändern / abhaken | `update_task` |  |
| Aufgabe anlegen | `create_task` |  |
| Aufgabe im Projekt anlegen | `pm_create_task` |  |
| Aufgabe: Status setzen | `pm_move_task` |  |
| Aufgabe zuweisen | `pm_assign_task` |  |
| Datensätze verknüpfen | `associate_records` |  |
| DND je Kanal | `update_dnd` |  |
| Feld setzen | `update_field` |  |
| Firma/Datensatz ändern | `update_record` |  |
| Firma/Datensatz anlegen | `create_record` |  |
| Kontakt suchen | `find_contact` | `var.contact_found` `var.found_contact` |
| Kontakt suchen oder anlegen | `find_or_create_contact` | `var.contact_found` `var.contact_created` `var.found_contact` |
| Nicht stören | `set_dnd` |  |
| Notiz hinzufügen | `add_note` |  |
| Nutzer zuweisen (Round-Robin) | `assign_user` | `var.assigned_user` |
| Tag entfernen | `remove_tag` |  |
| Tag hinzufügen | `add_tag` |  |
| Tags je nach Bedingung | `tag_if` |  |
| Ticket ändern / eskalieren | `ticket_update` |  |
| Ticket anlegen | `ticket_create` |  |
| Als Spam markieren & blockieren | `block_contact` |  |
| Blockierung aufheben | `unblock_contact` |  |

### Vertrieb & Termine

| Action (name in the UI) | Type | Sets |
| --- | --- | --- |
| Deal ändern | `update_opportunity` |  |
| Deal suchen | `find_opportunity` | `var.deal_found` `var.deal` |
| Opportunity anlegen | `create_opportunity` |  |
| Opportunity verschieben | `move_opportunity` |  |
| Opportunity-Status | `set_opportunity_status` |  |
| Termin ändern / absagen | `update_appointment` |  |
| Termin anlegen | `create_appointment` | `var.appointment_id` |
| In Sequenz aufnehmen | `sequence_enroll` |  |

### Nachrichten & Benachrichtigungen

| Action (name in the UI) | Type | Sets |
| --- | --- | --- |
| Benachrichtigung an Slack/Discord | `chat_notify` |  |
| Bewertung anfragen | `review_request` |  |
| Discord senden | `discord_send` |  |
| E-Mail senden | `send_email` |  |
| Interne Benachrichtigung | `notify_user` |  |
| Push an Kontakt | `push_contact` |  |
| SMS senden | `send_sms` |  |
| Team benachrichtigen | `notify` |  |
| Telegram senden | `telegram_send` |  |
| WhatsApp senden | `whatsapp_send` |  |
| Konversation zuweisen | `inbox_assign` | `var.inbox_assignee` |
| Konversation: Status setzen | `inbox_set_status` |  |
| Interne Notiz an Konversation | `inbox_note` |  |
| Nachricht mit Buttons senden (Instagram/Messenger/WhatsApp) | `meta_buttons_send` |  |
| KI-Anruf starten (Voice AI) | `voice_ai_call` |  |

### Zahlung & Verträge

| Action (name in the UI) | Type | Sets |
| --- | --- | --- |
| Rechnung / Angebot erstellen | `invoice_create` | `var.invoice_url` `var.invoice_number` `var.invoice_id` |
| Vertrag aus Vorlage erstellen | `contract_send` | `var.contract_url` `var.contract_id` |
| Zahlungslink erstellen | `payment_link` | `var.payment_url` |
| Karten-Update-Link senden | `dunning_send_link` | `var.billing_url` |
| Mahnung zur Rechnung senden | `invoice_dunning_send` | `var.dunning_level` |
| Einmal-Rabattcode erstellen | `coupon_create` | `var.coupon_code` `var.coupon_expires` |
| Treuepunkte gutschreiben | `loyalty_points` | `var.loyalty_balance` |

### Inhalte, Kurse & Community

| Action (name in the UI) | Type | Sets |
| --- | --- | --- |
| Aus Community entfernen | `community_leave` |  |
| Google-Beitrag erstellen | `google_post` |  |
| In Community aufnehmen | `community_join` |  |
| Kurszugang entziehen | `course_revoke` |  |
| Kurszugang geben | `course_grant` |  |
| Shorts aus Video erstellen | `shorts_create` |  |
| Social-Post erstellen | `social_post` |  |
| Social-Post-Entwurf (mit KI) | `social_draft` |  |
| Video recyceln | `video_recycle` |  |
| Kontakt für Webinar anmelden | `webinar_register` | `var.webinar_join_url` `var.webinar_session` |
| Community-Abzeichen vergeben | `community_grant_badge` |  |
| Community-Nachricht senden (als Team) | `community_send_dm` |  |
| Community-Punkte vergeben | `community_award_points` |  |
| Community-Beitrag schreiben (als Team) | `community_post` |  |
| Zertifikat ausstellen | `certificate_issue` | `var.certificate_url` `var.certificate_pdf_url` `var.certificate_number` |

### KI

| Action (name in the UI) | Type | Sets |
| --- | --- | --- |
| KI-Agent ausführen | `agent_run` |  |
| KI-Bild generieren | `genmedia_image` |  |
| KI-Text erzeugen | `ai_text` |  |
| KI-Video generieren | `genmedia_video` |  |
| KI: Felder aus Text lesen | `ai_extract` |  |
| KI: Stimmung erkennen | `ai_sentiment` | `var.stimmung` `var.stimmung_wert` |
| KI: Text einordnen | `ai_classify` | `var.kategorie` `var.kategorie_sicherheit` |
| KI: Übersetzen | `ai_translate` | `var.uebersetzung` `var.uebersetzung_quelle` |
| KI: Zusammenfassen | `ai_summarize` | `var.zusammenfassung` |
| Text in Sprache | `genmedia_tts` |  |

### Webhooks & APIs

| Action (name in the UI) | Type | Sets |
| --- | --- | --- |
| GitHub-Issue für Codex anlegen | `github_issue` |  |
| HTTP-Anfrage (Webhook mit Antwort) | `http_request` | `var.response` |
| Webhook aufrufen | `webhook` |  |

### Apps (direkt)

| Action (name in the UI) | Type | Sets |
| --- | --- | --- |
| Airtable: Datensatz ändern | `airtable_update_record` | `var.airtable_record_id` `var.airtable_found` |
| Airtable: Datensatz anlegen | `airtable_create_record` | `var.airtable_record_id` |
| Asana: Aufgabe anlegen | `asana_create_task` | `var.asana_task_url` `var.asana_task_gid` |
| Brevo: Kontakt hinzufügen | `brevo_add_contact` | `var.brevo_contact_id` |
| Calendly: Termin absagen | `calendly_cancel_event` | `var.calendly_cancelled` |
| ClickUp: Aufgabe anlegen | `clickup_create_task` | `var.clickup_task_url` `var.clickup_task_id` |
| Google Kalender: Termin anlegen | `gcal_create_event` | `var.gcal_event_url` `var.gcal_event_id` |
| Google Sheets: Zeile ändern | `gsheets_update_row` | `var.sheet_row` |
| Google Sheets: Zeile anhängen | `gsheets_append_row` | `var.sheet_range` |
| HubSpot: Kontakt aktualisieren | `hubspot_update_contact` | `var.hubspot_contact_id` `var.hubspot_found` |
| HubSpot: Kontakt anlegen | `hubspot_create_contact` | `var.hubspot_contact_id` `var.hubspot_created` |
| Mailchimp: Zur Audience hinzufügen | `mailchimp_add_member` | `var.mailchimp_status` `var.mailchimp_member_id` |
| Notion-Seite ergänzen | `notion_append` |  |
| Notion: Datenbank-Eintrag anlegen | `notion_create_item` | `var.notion_page_url` `var.notion_page_id` |
| Shopify: Bestellung abrufen | `shopify_get_order` | `var.shopify_found` `var.shopify_order_status` `var.shopify_fulfillment` `var.shopify_order_total` `var.shopify_order_items` `var.shopify_order_email` |
| Shopify: Rabattcode erstellen | `shopify_create_discount` | `var.discount_code` `var.discount_id` |
| Slack: Nachricht in Kanal | `slack_post_message` | `var.slack_ts` `var.slack_channel` |
| Stripe: Kunde anlegen | `stripe_create_customer` | `var.stripe_customer_id` `var.stripe_customer_created` |
| Stripe: Zahlungslink erstellen | `stripe_create_payment_link` | `var.stripe_payment_link` `var.stripe_payment_link_id` |
| Teams: Nachricht in Kanal | `teams_post` |  |
| Trello: Karte anlegen | `trello_create_card` | `var.trello_card_url` `var.trello_card_id` |
| Typeform: Antwort abrufen | `typeform_get_response` | `var.typeform_found` `var.typeform` `var.typeform_text` `var.typeform_response_id` `var.typeform_hidden` |
| WooCommerce: Bestellung abrufen | `woocommerce_get_order` | `var.woo_found` `var.woo_order_status` `var.woo_order_total` `var.woo_order_items` `var.woo_order_email` |
| Zoom: Meeting anlegen | `zoom_create_meeting` | `var.zoom_join_url` `var.zoom_meeting_id` `var.zoom_password` |
| Plugin-Aktion ausführen | `plugin_action` |  |

### Apps (Composio, Nango, MCP)

| Action (name in the UI) | Type | Sets |
| --- | --- | --- |
| API-Aufruf über Nango | `nango_request` |  |
| App-Aktion ausführen (Composio) | `composio_action` |  |
| KI-Agent mit Apps (Composio) | `composio_ai` |  |
| MCP-Werkzeug ausführen | `mcp_tool` |  |

## All triggers

### Kontakt

| Trigger (name in the UI) | Type | Settings |
| --- | --- | --- |
| Kontakt angelegt | `contact.created` |  |
| Tag hinzugefügt | `contact.tag_added` |  |
| Tag entfernt | `contact.tag_removed` |  |
| Kontakt geändert | `contact.updated` |  |
| Kontakt hat sich abgemeldet | `contact.unsubscribed` |  |
| Firma angelegt | `company.created` |  |
| Firma geändert | `company.updated` |  |
| Firmen-Eigenschaft geändert | `company.property_changed` |  |
| Datensatz (eigenes Objekt) angelegt | `record.created` |  |
| Datensatz (eigenes Objekt) geändert | `record.updated` |  |
| Eigenschaft eines Datensatzes geändert | `record.property_changed` |  |
| Lead-Score erreicht Schwelle | `lead_score.threshold_reached` |  |
| Lead-Score geändert | `lead_score.changed` |  |
| Feld geändert (alt → neu) | `field.changed` | Feld, Alter Wert (optional), Neuer Wert (optional), Nur wenn das Feld jetzt leer ist |
| Zuständiger geändert | `contact.owner_changed` |  |
| Kontakt tritt einem Segment bei | `segment.entered` | Segment-ID (leer = jedes beobachtete Segment) |
| Kontakt verlässt ein Segment | `segment.left` | Segment-ID (leer = jedes beobachtete Segment) |
| Einwilligung bestätigt | `consent.confirmed` | Kanal, Zweck |
| Einwilligung widerrufen | `consent.revoked` | Kanal |

### Nachrichten & Anrufe

| Trigger (name in the UI) | Type | Settings |
| --- | --- | --- |
| Nachricht empfangen | `message.inbound` |  |
| E-Mail geöffnet | `email.opened` |  |
| Link in E-Mail geklickt | `email.clicked` |  |

Both e-mail triggers fire for **people only**: Apple Mail Privacy Protection, image proxies and link scanners are recognised and start nothing ([docs/email-tracking.md](email-tracking.md)).

| KI-Assistent übergibt an Team | `ai.handoff` |  |
| Anruf verpasst | `call.missed` |  |
| Voicemail erhalten | `call.voicemail` |  |
| Anruf beendet | `call.completed` |  |
| KI-Anruf beendet | `voice_ai.completed` |  |
| Telegram-Bot gestartet | `telegram.started` |  |
| E-Mail unzustellbar (Bounce) | `email.bounced` |  |
| E-Mail als Spam gemeldet | `email.complained` |  |
| Nachricht unbeantwortet | `conversation.unanswered` | Unbeantwortet seit … Minuten, Kanal |
| Konversation zugewiesen | `conversation.assigned` | Zugewiesen an |
| Konversation: Status geändert | `conversation.status_changed` | Neuer Status |
| Antwortfrist im Posteingang überschritten | `conversation.sla_breached` | Art der Frist |
| Power-Dialer: Anruf abgeschlossen | `dialer.disposition` | Ergebnis (Schlüssel) |
| Gespräch ausgewertet | `call.analyzed` | Stimmung |
| Neuer Social-Kommentar (Facebook/Instagram/YouTube/LinkedIn) | `social_comment.received` | Nur Plattform |
| KI-Anruf: angenommen | `voice_ai_call.answered` |  |
| KI-Anruf: Termin gebucht | `voice_ai_call.booked` |  |
| KI-Anruf: nicht erreicht | `voice_ai_call.no_answer` |  |
| KI-Anruf: Mailbox | `voice_ai_call.voicemail` |  |
| Ausgehende Nachricht gesendet | `message.outbound` | Kanal, Absender |
| Teammitglied hat geantwortet | `message.team_reply` | Kanal, Teammitglied |

### Termine & Vertrieb

| Trigger (name in the UI) | Type | Settings |
| --- | --- | --- |
| Termin gebucht | `appointment.booked` |  |
| Terminstatus geändert | `appointment.status_changed` |  |
| Opportunity angelegt | `opportunity.created` |  |
| Pipeline-Stufe geändert | `opportunity.stage_changed` |  |
| Opportunity-Status geändert | `opportunity.status_changed` |  |
| Aufgabe erledigt | `task.completed` |  |
| Mindestbestand unterschritten (Lager) | `stock.low` |  |
| Bestellung eingegangen (Einkauf) | `purchase_order.received` |  |
| Aufgabe angelegt (Projektplanung) | `task.created` | Projekt |
| Aufgaben-Status geändert (Projektplanung) | `task.status_changed` | Projekt, Status, Kategorie |
| Aufgabe zugewiesen (Projektplanung) | `task.assigned` | Projekt, Person |
| Projekt-Budget: Schwelle erreicht | `project.budget_threshold` | Nur für Projekt (ID), Budget, Nur bei Schwelle (%) |
| Angebot: Genehmigung angefragt | `quote.approval_requested` |  |
| Angebot: Genehmigung entschieden | `quote.approval_decided` |  |
| Termin nicht wahrgenommen | `appointment.noshow` | Kalender |
| Termin abgesagt | `appointment.cancelled` | Kalender |
| Termin verschoben | `appointment.rescheduled` | Kalender |
| Termin beginnt bald | `appointment.starts_soon` | Kalender, Minuten vor Beginn |
| Aufgabe überfällig | `task.overdue` | Projekt |
| Angebot gesendet | `quote.sent` |  |
| Angebot geöffnet | `quote.viewed` |  |
| Angebot angenommen und unterschrieben | `quote.accepted` |  |
| Angebot abgelehnt | `quote.declined` |  |
| Angebot abgelaufen | `quote.expired` |  |
| Angebots-Rechnung bezahlt | `quote.paid` |  |
| Antwort auf eine Sequenz | `sequence.replied` |  |
| Sequenz durchlaufen | `sequence.finished` |  |
| Sequenz beendet | `sequence.stopped` |  |
| Gesprächsnotiz angelegt | `meeting_note.added` |  |

### Zahlung

| Trigger (name in the UI) | Type | Settings |
| --- | --- | --- |
| Rechnung bezahlt | `invoice.paid` |  |
| Beleg eingegangen (Buchhaltung) | `receipt.received` |  |
| Beleg gebucht (Buchhaltung) | `receipt.booked` |  |
| Produkt gekauft | `product.purchased` |  |
| Vertrag unterschrieben | `contract.signed` |  |
| Vertrag abgelehnt | `contract.declined` |  |
| Vertrag: Unterzeichner hat unterschrieben | `contract.signer_signed` |  |
| Treuepunkte gutgeschrieben | `loyalty.points_earned` |  |
| Treue-Stufe erreicht | `loyalty.tier_reached` | `tier` |
| Neuer Affiliate | `affiliate.created` |  |
| Provision erstellt | `affiliate.commission_created` |  |
| Zahlung fehlgeschlagen | `payment.failed` | Produkt |
| Checkout abgebrochen (Warenkorbabbruch) | `checkout.abandoned` | Produkt |
| Zahlung erstattet | `payment.refunded` | Produkt, Nur vollständige Erstattungen |
| Abo gekündigt / beendet | `product.subscription_ended` | Produkt |
| Rechnung überfällig | `invoice.overdue` | Tage nach Fälligkeit |
| Wiederkehrende Rechnung erstellt | `invoice.created` |  |
| Angebot angenommen | `estimate.accepted` |  |
| Formular bezahlt | `form.paid` | Nur für Formular (ID), Nur für Produkt (ID) |
| Ratenzahlung abgeschlossen | `payment_plan.completed` | Nur für Produkt |
| Ratenzahlung ausgefallen | `payment_plan.defaulted` | Nur für Produkt |
| Zahlung fehlgeschlagen (Abo/Rate) | `dunning.started` | Nur für Produkt |
| Mahnwesen: Zahlung endgültig fehlgeschlagen | `dunning.final_failed` | Nur für Produkt |
| Mahnwesen: Zahlung nachträglich eingegangen | `dunning.recovered` | Nur für Produkt |
| Mahnung zu Rechnung versendet | `invoice.dunning_sent` | Nur Mahnstufe (Schlüssel, z. B. dunning2) |
| SEPA-Mandat erteilt | `sepa.mandate_signed` |  |
| SEPA-Lastschrift zurückgegeben | `sepa.returned` |  |
| Shop: Bestellung aufgegeben | `store.order_placed` | Nur mit Produkt (ID) |
| Shop: Bestellung bezahlt | `store.order_paid` | Nur mit Produkt (ID) |
| Shop: Bestellung versendet | `store.order_shipped` |  |
| Event-Tickets bestellt | `tickets.ordered` |  |

### Formulare, Seiten & Links

| Trigger (name in the UI) | Type | Settings |
| --- | --- | --- |
| Formular ausgefüllt | `form.submitted` |  |
| Trigger-Link geklickt | `link.clicked` |  |
| Formular abgebrochen | `form.abandoned` | Formular, Abgebrochen nach … Minuten ohne Absenden |
| Seite besucht | `page.visited` | Funnel, Seite, Pfad enthält |
| Neuer Lead aus Anzeige (Meta Lead Ads) | `ads.lead` | Formular-ID, Kampagnen-ID, Plattform |
| Formular ausgewertet (Punkte / Ergebnis) | `form.scored` | Nur für Formular (ID), Nur bei Ergebnis mit Tag |
| Für Webinar angemeldet | `webinar.registered` | Webinar |
| Im Webinar erschienen | `webinar.attended` | Webinar |
| Webinar verpasst | `webinar.missed` | Webinar |
| Webinar angesehen (Anteil) | `webinar.watched_percent` | Webinar, Mindestens … Prozent gesehen |
| Angebot im Webinar angeklickt | `webinar.cta_clicked` | Webinar |
| Webinar-Aufzeichnung angesehen | `webinar.replay_watched` | Webinar |
| Kommentar-Stichwort getroffen (Instagram/Facebook) | `igcomment.matched` | Nur Regel (ID), Nur Plattform |

### Zeit & Datum

| Trigger (name in the UI) | Type | Settings |
| --- | --- | --- |
| Geburtstag / Datum erreicht | `date.reached` |  |
| Geburtstag | `contact.birthday` | Tage davor (−) / danach (+), Uhrzeit, Zeitzone |
| Jahrestag (Kunde seit …) | `contact.anniversary` | Datum aus, Mindestens Jahre, Tage davor (−) / danach (+), Uhrzeit, Zeitzone |
| Zeitplan (Cron) | `schedule.cron` | Zeitplan, Zeitzone, Nur Kontakte mit allen Tags, Nur Kontakte mit einem dieser Tags, Ohne diese Tags, Maximal Kontakte je Start |

### Kurse, Community & Bewertungen

| Trigger (name in the UI) | Type | Settings |
| --- | --- | --- |
| Bewertung erhalten | `review.received` |  |
| Kurszugang erhalten | `course.enrolled` |  |
| Kurs begonnen | `course.started` |  |
| Lektion abgeschlossen | `lesson.completed` |  |
| Kurs abgeschlossen | `course.completed` |  |
| Neue Google-Bewertung | `google_review.received` |  |
| Community-Beitrag erstellt | `community.post_created` |  |
| Mitglied ist Gruppe beigetreten | `community.member_joined` |  |
| Level erreicht | `community.level_reached` |  |
| Kurszugang entzogen | `course.access_revoked` |  |
| Kommentar in einer Lektion | `course.comment_posted` | Nur für Kurs |
| Kurs bewertet | `course.review_posted` | Nur für Kurs, Mindestens Sterne |
| Lernpfad freigeschaltet | `course.path_enrolled` | Nur für Lernpfad (ID) |
| Lernpfad abgeschlossen | `course.path_completed` | Nur für Lernpfad (ID) |
| Cohort beigetreten | `course.cohort_joined` | Nur für Kurs |
| Mitglied hat die Community verlassen | `community.member_left` | Community-Gruppe |
| Testphase in der Community gestartet | `community.trial_started` | Community-Gruppe, Stufe (ID) |
| Testphase wurde zum Abo | `community.trial_converted` | Community-Gruppe, Stufe (ID) |
| Beitrittsanfrage gestellt | `community.join_requested` | Community-Gruppe |
| Challenge gestartet | `community.challenge_joined` | Community-Gruppe, Challenge (ID) |
| Challenge geschafft | `community.challenge_completed` | Community-Gruppe, Challenge (ID) |
| Abzeichen erhalten | `community.badge_earned` | Community-Gruppe, Abzeichen (ID) |
| Community-Nachricht erhalten | `community.dm_received` | Richtung |
| Live-Call besucht | `community.event_attended` | Community-Gruppe, Termin (ID) |
| Quiz bestanden | `quiz.passed` | Nur für Kurs, Nur für Quiz (ID) |
| Quiz nicht bestanden | `quiz.failed` | Nur für Kurs, Nur für Quiz (ID) |
| Aufgabe abgegeben | `assignment.submitted` | Nur für Kurs |
| Aufgabe geprüft | `assignment.reviewed` | Nur für Kurs, Nur Ergebnis |
| Zertifikat ausgestellt | `certificate.issued` | Nur für Kurs |

### Service & Tickets

| Trigger (name in the UI) | Type | Settings |
| --- | --- | --- |
| Ticket angelegt | `ticket.created` |  |
| Ticket-Status geändert | `ticket.status_changed` |  |
| Ticket zugewiesen | `ticket.assigned` |  |
| SLA läuft bald ab | `sla.warning` |  |
| SLA überschritten | `sla.breached` |  |
| Health-Score gesunken | `health_score.dropped` |  |
| Zufriedenheit bewertet (CSAT) | `csat.received` |  |
| NPS-Antwort erhalten | `nps.received` |  |

### System & Integrationen

| Trigger (name in the UI) | Type | Settings |
| --- | --- | --- |
| Manuell (Kontakt / Massenaktion) | `manual` |  |
| Abwesenheit beantragt (Personal) | `absence.requested` |  |
| Abwesenheit genehmigt (Personal) | `absence.approved` |  |
| Abwesenheit abgelehnt (Personal) | `absence.rejected` |  |
| Eingehender Webhook | `webhook` |  |
| Webhook empfangen (mit Feldzuordnung) | `webhook.received` |  |
| Shorts fertig (Video-Studio) | `shorts.ready` |  |
| App-Ereignis (Composio) | `composio.event` |  |
| KI-Medium fertig (KI-Studio) | `genmedia.completed` |  |
| Eigenes Ereignis | `event.custom` | Name des Ereignisses |
