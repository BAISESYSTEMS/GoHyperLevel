# Undo, history and trash

Back to the [README](../README.md).

Ticking off the wrong to-do, deleting a contact with its notes, dragging a deal into the wrong stage: in HyperLevel none of that is final. Every change to the main records is written to a **journal** before it happens. You get an **Undo** link right after the change, **Ctrl/⌘ + Z**, a **Verlauf** (history) of your last changes and a **Papierkorb** (trash) for deleted records. Agents and the Android app use the same journal.

## For people

| What | How |
| --- | --- |
| After every change | A message at the bottom: „Aufgabe „Angebot“ erledigt · **Rückgängig**“. It stays 8 seconds and stops counting down while the pointer or the keyboard focus is on it. After an undo it offers **Wiederholen** (redo). |
| Ctrl/⌘ + Z | Takes back your last change anywhere in the app – but not while you type in a text field (the field has its own undo) and not in the canvas editor (which has one of its own). Ctrl/⌘ + Shift + Z (or Ctrl + Y) repeats what you just undid. Screen readers announce every change and every undo. |
| **Verlauf** | The clock button in the top bar (also in the command palette, Ctrl+K): your last changes grouped by day, with search, a filter by kind and „Wiederherstellen“ on each entry. Every entry shows **before → after** for the key fields. Admins can switch to everyone's changes in the sub-account. |
| **Papierkorb** | Menu → Papierkorb (per sub-account): deleted records with what comes back with them („2 Notizen, 1 Aufgabe“) and how many days are left. Anyone with the right may restore; **admins** can also „Endgültig löschen“ (one record or everything) and set the retention. |
| **Erledigt heute** | A tab in Aufgaben: everything ticked off today, one click away. |
| Conflicts | If the record was changed again after the entry, nothing happens at first: a dialog shows **what changed since** (after the change / now / after restoring). „Trotzdem wiederherstellen“ overwrites, „Abbrechen“ keeps things as they are. |
| Bulk actions | One request is one group: tagging 40 contacts is one entry and one click takes all 40 back. |

All dialogs have a ✕ at the top right and close with Esc; buttons and tick boxes are at least 48 px (56 px on touch) so they work with eye tracking and pinch.

## What is covered

| Area | Journaled | Restored by | Not taken back |
| --- | --- | --- | --- |
| Tasks (core list **and** project planner) | tick off / reopen, edit, status or drag in the planner, dates, delete (with subtasks, comments, attachments and assignees; time entries are linked again), bulk | row + assignees/watchers; a recurring task's completion also removes the next occurrence it created (while nobody has worked on it) | uploaded files of a deleted planner task (the attachment entry comes back, the file does not) |
| Todoist | – | an undo changes the task like any local edit; the sync pushes it a moment later. What the sync pulls from Todoist is never journaled, so nothing can loop | – |
| Contacts | edit, delete (with notes, tasks, deals, conversations, messages, appointments links, form submissions, tickets links … – every row the foreign keys remove or detach), tag add/remove, bulk (tag, DND, delete) | same ids, nothing re-sent | automations that reacted (e-mail/SMS already sent) – the entry says so when an active automation listens for that change |
| Companies | edit, delete, **merge** (both companies, their links, notes and activities come back) | row + links/notes/activities | – |
| Notes | delete | row | – |
| Deals | stage move, edit, won/lost, delete | row (incl. the derived `closed_at`) | automations that reacted |
| Pipelines | rename, stages (deals that were moved out of a removed stage go back), delete (with its deals) | row + where every deal was | – |
| Appointments | edit, reschedule, status, cancel, delete | row | cancellation messages that already went out |
| Conversations | star, „unread“ (marking as read is not journaled), delete a draft | row | sent messages cannot be deleted at all |
| Tickets | edit, status/close, bulk, delete | row | replies already sent |
| Products, forms, funnels and pages, tags | edit, delete (a funnel with its pages, a tag with the contacts that had it), a tag's colour and category | row + children | – |
| Tag categories | rename, colour, order, delete (the tags that were in it go back in) | row + the tags' links | – |
| Invoices | **drafts only**: edit, delete | row | a sent, paid or void invoice is never offered |
| Workflows | edit (name, trigger, steps), activate/pause, delete | the workflow's own **version history**: the entry names the version and a restore adds a new version | runs and mails already sent |
| Wiki pages | edits (autosaves of ten minutes are one entry), move to trash | the wiki's own restore and version history | a page purged for good |
| Canvas | boards changed by agents/MCP/API keys (a snapshot is secured first), rename, delete | the board's own snapshots | people editing in the browser use the editor's undo |
| Contact merges | *Vertrieb → Dubletten* and the contact page: the whole merge is one entry – the second contact, its conversation and every row that moved to the kept one come back ([sales.md](sales.md#duplicate-assistant)) | the entry itself (*Rückgängig*) | sequence stops caused by the merge-time *Nicht stören*, and sequence history already written, stay as they are |

### What can never be undone

Sent e-mails and SMS, payments, published ads and posts, calls, and everything an outside service did. Undo only resets **your data**, and says so, e.g. „Absage-Benachrichtigungen wurden eventuell schon gesendet – nur der Termin wird wiederhergestellt“ (appointment), „Die Automation „Willkommen“ kann darauf reagiert haben … bereits Gesendetes lässt sich nicht zurückholen“ (tag, stage, status or task changes while an active automation listens for them). The text shows in the toast, the Verlauf and the Papierkorb.

### Not covered (yet)

- Creating records (a new contact or task is not removed by Ctrl+Z – delete it, then undo the delete if needed).
- Changes made by saving a contact through `POST /api/contacts` (an upsert that updates an existing contact), by CSV imports and by public forms or bookings: use the contact's own edit, or the import's own report.
- Conversations have no closed/archived state in this version: the star, „unread“ and deleting a draft are journaled, and ticket status/close is.
- Writes that are not a user action: workflows, imports, the Todoist pull, Stripe webhooks, the scheduler. They have their own logs.
- Contacts have no merge feature in this version, so there is nothing to undo there; the company merge is covered.
- Dependent rescheduling in the planner (moving a task with „cascade“ shifts others): only the task you moved is restored.
- Deleting a whole planner project, sub-accounts, users, API keys, settings, integrations and credentials.
- More than 1,000 records in one request, or a delete that takes along more than 20,000 rows / 8 MB: the entry exists in the Verlauf („nicht im Papierkorb gespeichert“) but cannot be restored.
- Security tokens of a deleted contact (member-portal sessions and login links) are never copied into the journal, so a restored contact has to sign in again.

## Who may undo what

- **Your own changes** – yours means made by you in the browser, in the app, or by the HyperLevel Agent acting for you.
- **Admins** can undo anyone's in the sub-accounts they can open (the Verlauf's „Alle Änderungen im Sub-Account“, and the Papierkorb).
- **Areas apply**: a member who lost the area of an entry (for example Opportunities) neither sees nor restores it; a SaaS plan that excludes an area does the same.
- **Sub-account isolation**: an entry belongs to one sub-account; everyone else gets 404 – members, keys and admins working in another sub-account alike.
- **API keys** (and MCP connections) are their own actors: a key lists and undoes **its own** changes; an agency key acts like an admin.
- Every undo is an entry of the audit log (`undo.create`) and a journal entry itself.

## Retention and privacy

Entries and the trash are kept **30 days** (Papierkorb → Aufbewahrung, or `PUT /api/undo/settings`, 1–365). A daily job removes older entries; they cannot be restored once they are past the limit. The journal stores copies of the changed records (the snapshot, about 1.3 KB per entry), so it is covered by the same backups and by the privacy rules:

- **Erasing a contact for GDPR** (`POST /api/contacts/:id/erase`) also deletes every journal entry about it – nothing about an erased person stays in the Papierkorb.
- Deleted records stay restorable for the retention time; shorten it (or use „Endgültig löschen“) if your processing requires earlier deletion.

## API

All routes need a sub-account (`x-location-id`, or the sub-account key) and answer in German. `:id` is an entry id.

| Route | What |
| --- | --- |
| `GET /api/undo?scope=mine\|all&entity=&actor=&q=&include=undone&before=&limit=` | My changes (newest first, grouped per request). `scope=all` is for admins; for everyone else it is „mine“. `actor`: `me`, `user`, `agent`, `api_key`, `mcp`, `agency_key`, `app`. Items: `{id, at, label, entity, entity_id, actor, actor_kind, action, count, items?, changes: [{k, l, from, to}], notice, kind: change\|undo, undone_at, can_undo, restorable, reason, removes, expires_at}` |
| `GET /api/undo/last` | `{undo, redo}`: what Ctrl+Z would take back, and the undo it could repeat (until the next change) |
| `GET /api/undo/trash?entity=&q=` | Deleted records still restorable: the same items plus `kids_text` („2 Notizen, 1 Aufgabe“), `expires_at`, `can_purge` |
| `GET /api/undo/:id/preview` | Dry run: `{conflict, conflicts: [{id, label, diff}], notice}` |
| `POST /api/undo/:id` `{force?, single?}` | Restores the whole group (or only this entry with `single`) in **one transaction**. 409 + `{conflict: true, diff: [{field, label, entry, now, restore}], notice}` if the record changed since – repeat with `force: true` to overwrite. Answer: `{ok, label, restored, redo_id, notices}`; `redo_id` is the entry that undoes the undo. 403 not yours / no area, 404 unknown or another sub-account, 409 already undone, 410 expired, 422 not restorable |
| `DELETE /api/undo/:id`, `DELETE /api/undo/trash` | Admins: remove one record / everything from the trash for good |
| `GET/PUT /api/undo/settings` | `{retention_days}` (admins and members with the settings area) |
| `GET /api/undo/done-today` | Tasks completed today (the „Erledigt heute“ tab) |

Every successful write that was journaled answers with headers: `x-undo-id` (the entry), `x-undo-label` (URL-encoded „Aufgabe „…“ erledigt“) and, when something cannot be taken back, `x-undo-notice` (URL-encoded). The web app builds its toast from them; so can any client.

### Mobile API (Android snackbar)

| Route | What |
| --- | --- |
| `GET /api/mobile/undo/recent?location=all\|<id>&limit=20` | My recent changes over every sub-account the login can open (`location_id`, `location_name`, `can_undo` per item) – the data of an undo snackbar. Changes made through the app's own write routes carry the `x-undo-*` headers as well. |
| `POST /api/mobile/undo/:id` `{force?, single?}` | Undo one entry (same answer and errors as `POST /api/undo/:id`; a 409 carries `conflict` and `diff`). |

### MCP tools and the HyperLevel Agent

- `ghl_undo_list` – recent changes, filterable by `actor` (`me` = this key or login, `agent`, `api_key`, `mcp`, `user`, `all`), `entity`, `query`, `trash`, `include_undone`. Agency keys see every actor; a sub-account key sees its own changes.
- `ghl_undo` – restores one entry by `entry_id`. A conflict is **returned, not forced**: `{restored: false, conflict: true, diff}`; call again with `force: true` to overwrite. Bulk entries are taken back as a whole unless `single: true`.
- The agent can use both like any tool (class „write“: it asks first unless it runs autonomously). After an agent's write, its **tool card shows „Rückgängig“** (and the notice about anything that cannot be taken back); the call that changed a record is the one that carries the entry.

## For developers

The journal is a module (`server/modules/undo.ts`), the engine is `server/services/undo-journal.ts` (+ `undo-core.ts`, `undo-table.ts`). Nothing in it knows a table: records register themselves.

```ts
const undo = app.services.undo;
// What a record is and how to put it back (a table entity does the common case)
undo.register('task', tableEntity(app, { noun: 'Aufgabe', area: 'contacts', table: 'tasks', title: (r) => r.title, volatile: ['updated_at'] }));
// Which route changes which records
undo.track({ method: 'PATCH', pattern: '/api/tasks/:id', entity: 'task', action: (before, after) => (before?.row.done !== after?.row.done ? 'status' : 'update') });
```

- `register(type, { snapshot(id, ctx, mode), restore(target, ctx, current), label(snapshot) })` is the contract; optional `area`, `fields` (before → after), `volatile` (columns other code maintains), `verb`, `afterRestore` (safe side effects after the transaction, e.g. Todoist push), `contactId` (for the GDPR step). `mode` is `now`, `before` (ahead of a tracked write; the canvas secures a snapshot there) or `deep` (a delete: everything the foreign keys take along).
- `tableEntity` snapshots the row and – for deletes – walks the foreign keys (`ON DELETE CASCADE` rows and `SET NULL` links, parents first); `parts` are small related sets that travel with every snapshot (assignees, a company's links); `keep` lists columns an undo never overwrites. A restore sets only the columns that differ and never replaces a row (that would cascade).
- `track(rule)`: `targets(ctx)` (default `:id`; bulk routes list the body's ids), `deep`, `action`, `when` (skip changes that are not worth an entry or cannot be undone), `notice`, `coalesceMs` (autosaves), `groupLabel`, `quiet` (routes that silence the after-write hooks).
- A guard takes the „before“ snapshot just ahead of the handler, the after-write hook stores the entry – only if something really changed, so saving the same value again is free. The snapshot and the entry are cheap: **+0.2–0.4 ms per write**, about 1.3 KB per entry on a task or contact edit (measured over the loopback API: `PATCH /api/tasks/:id` 1.5 → 1.9 ms, `PATCH /api/contacts/:id` 2.4 → 2.9 ms). A delete walks about 50 foreign keys: ~10–40 ms for a contact with 30 children, the undo ~10 ms.
- Restores run in `db.tx`, which nests as savepoints, so modules may use their own transactions inside `restore`.
- Records with a version history keep it: `undo-versioned.ts` stores a pointer (workflows: the content hash of a `workflow_versions` row; canvas: a `canvas_snapshots` row) or the page text (wiki) and restores through the module's own functions.
- Tests: `tests/undo*.test.ts`. `app.services.undo.enabled = false` switches the journal off (benchmarks), `app.services.undo.cleanup(at)` runs the retention job with a clock.
