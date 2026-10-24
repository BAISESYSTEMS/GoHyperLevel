**English** · [Deutsch](todoist.de.md)

# Todoist sync

HyperLevel syncs the tasks of all sub-accounts with **your personal Todoist** – in both directions or only HyperLevel → Todoist. You set it up once for the whole agency under **Agency → Integrations → Setup → Todoist**.

## Structure: sections or projects

| Structure | What it looks like in Todoist | Suits |
| --- | --- | --- |
| **One project with sections** (default, recommended) | One project “HyperLevel” (name of your choice, or an existing project) with **one section per sub-account** inside it | Every plan – including the **free** one (max. 5 projects, 20 sections per project, so up to 20 sub-accounts) |
| One project per sub-account | One project per sub-account under a parent project “HyperLevel” | Todoist Pro/Business (up to 300 projects) |

**On the free Todoist plan, choose “One project with sections”.** With “One project per sub-account” you hit the wall after 5 projects (including the Inbox); HyperLevel then reports the limit in the status (see below) instead of trying again and again. Whether you have Pro is shown on the card after connecting (“free plan”).

## Setup

1. In Todoist: **Settings → Integrations → Developer** → copy the “API token”.
2. In HyperLevel: **Agency → Integrations → Setup → Todoist** → paste the token → **Save & test**. The token is checked against Todoist immediately (wrong token = error message, nothing is saved), then stored encrypted (AES-256-GCM with the key from `data/secret`) and never sent back to the browser.
3. Choose the settings:
   - **Direction:** *Both directions* or *HyperLevel → Todoist only* (changes in Todoist are then ignored).
   - **Which tasks:** *All tasks* or *Only tasks assigned to me* (“me” = the login that saved the token). This applies to new tasks; tasks that are already linked stay linked.
   - **Structure in Todoist:** “One project with sections” or “One project per sub-account” (see above).
   - With sections: **Todoist project** – *Automatic* uses a project with the **project name** (default `HyperLevel`) or creates exactly one; alternatively pick an existing project. A new project name renames the automatic project.
   - With sections: **Tasks without a section** – *Ignore* (default) or assign them to a sub-account (e.g. as an inbox: whatever you type directly into the project in Todoist ends up there).
   - With projects: **Parent project** (default `HyperLevel`): automatically created projects are placed under it; empty = top level.
   - **Label `ghp`** on tasks that come from HyperLevel (can be turned off).
4. **Section or project per sub-account:** *automatic* creates a section (or project) named after the sub-account – or uses an existing one with the same name; *Existing section/existing project …* picks one from your Todoist; *Do not sync* leaves the sub-account out. Sub-accounts without a setting of their own follow “Sub-accounts without a setting of their own”. If a sub-account is renamed, its automatic section is renamed with it.

**First connection:** With “One project with sections”, syncing starts right after “Save & test” (at most one project is created). With “One project per sub-account” it stays off until you tick **Sync active** – the card then tells you how many projects would be created. That way you never get a surprising number of projects.

“Disconnect” deletes the token and stops syncing; the tasks stay in both systems. If a token for a **different** Todoist account is saved later, linking starts over.

## What is synced

| HyperLevel | Todoist |
| --- | --- |
| Title | `content` |
| Description | `description` – with a link back appended (`↗ HyperLevel: https://<domain>/app/contacts/<id>` or `/app/tasks`), which is removed again when reading back |
| Due (date only) | all-day date |
| Due (with time) | fixed time in the sub-account's time zone; “floating” Todoist times are read in your Todoist time zone |
| Done / open again | check off (`item_close`) / reopen (`item_uncomplete`); recurring Todoist tasks jump to the next date when checked off, and that comes back the same way |
| Deleted | is deleted in Todoist |
| – | **Deleted** in Todoist → **not deleted** here, but marked as done and unlinked (entry in the log). Nothing gets lost; the task is listed under “Done”. |

New tasks in an assigned section (or project) arrive (with “Both directions”) as a task without a contact in the matching sub-account. Tasks in the project without a section only arrive if a sub-account is chosen under “Tasks without a section”; tasks in unassigned sections, in the Todoist Inbox or in other projects stay out, and so do tasks that are already done. Only open tasks are sent to Todoist as new.

**Moving:** A linked task that you drag to another section or project in Todoist stays in its previous sub-account here (and keeps being synced). When you change the structure or an assignment, tasks that are already linked stay where they are in Todoist; only new tasks go to the new target.

## When syncing happens

- **Every 3 minutes** HyperLevel fetches only the changes (`sync_token` of the Todoist Sync API), and **once a day** it re-reads everything (this also closes tasks that were completed/deleted in Todoist while nobody was looking).
- **Changes here** (interface, API, MCP) go out after about 2 seconds; tasks from workflows or the AI assistant are picked up by a short scan every 15 seconds.
- **Sync now** / **Full sync** starts a run immediately; so does the MCP tool `ghl_todoist_sync`.

If **both sides** have changed since the last sync, the later change wins (Todoist: `updated_at`; HyperLevel: time of the change). Every conflict is in the log.

## Safety and limits

- All writes run in batches (up to 100 commands per request) with a unique `uuid` – a repeated attempt creates nothing twice.
- On `429 Too Many Requests` the sync waits (`Retry-After`, otherwise 1, 2, 4, 8 s) and tries up to four times; after that, on the next run.
- **Safety stop:** If more than 25 linked tasks and more than half of all links suddenly go missing here (e.g. after an import error), nothing is deleted in Todoist, only unlinked.
- **Todoist limits** (free plan: 5 projects, 20 sections per project; task limits too): If creating something fails because of a limit, the status shows a red message “Todoist limit reached …” (and once in the log). After that HyperLevel **stops trying to create anything new** – changes to existing tasks keep running – until you click “Sync now”, change a setting or 24 hours have passed. Remedies: the “One project with sections” structure, pick existing projects/sections, set sub-accounts to “Do not sync”, or Todoist Pro.
- If an assigned project or section is deleted or archived in Todoist, HyperLevel sets the sub-account to “Do not sync” instead of creating it again; the tasks here stay unchanged (only unlinked). If the single project of the sections structure disappears, syncing is switched off completely until you pick a project and switch it on again.
- A task that fails five times is skipped until the next full sync (it appears in the log and in the status).
- A sub-account set to “Do not sync” freezes its links: nothing is sent or read any more, and nothing is deleted. When you switch to another project, tasks that are already linked stay in their previous Todoist project.
- Subtasks from Todoist arrive as normal tasks; priorities, labels (except `ghp`), comments and sections are not synced.

## Webhook (optional)

Without a webhook, the 3-minute poll is enough. For instant pickup from Todoist:

1. Todoist **App Console** (Settings → Integrations → Developer → App Console) → new app.
2. **Webhook URL:** `https://<your-domain>/hooks/todoist` (ready to copy in the “Webhook” section); choose the events `item:added`, `item:updated`, `item:completed`, `item:uncompleted`, `item:deleted` and activate.
3. Save the app's **client secret** in HyperLevel. Every delivery is verified through `X-Todoist-Hmac-SHA256` (Base64 HMAC-SHA256 of the raw body with the client secret); invalid ones are rejected.
4. Todoist only sends webhooks once your account has authorized the app via OAuth once (see the Todoist docs, “Webhook Activation & Personal Use”).

The webhook only triggers an earlier sync – the data itself always comes through the Sync API.

## Technical details

- `server/services/todoist.ts`: every HTTP call (Todoist API v1, `https://api.todoist.com/api/v1`: `POST /sync` for reading/writing, `GET /user` for the token test, `GET /projects` for the project picker), due-date conversion, webhook verification. Test hooks: `app.services.todoistFetch`, `app.services.todoistSleep`.
- `server/services/todoist-sync.ts`: the sync itself (projects, reading, conflicts, writing).
- `server/modules/todoist.ts`: settings, routes, schedule, webhook, MCP tools. Tables `todoist_projects` (assignment per sub-account: project columns for “one project per sub-account”, `section_*` for sections – both are kept when you switch), `todoist_links` (task ↔ Todoist ID, project/section, last hash of both sides, timestamps), `todoist_log` (log, the last 500 entries).
- `projects`, `sections` and `items` are read; `project_add`/`project_update`, `section_add`/`section_update`, `item_add` (with `section_id`), `item_update`, `item_close`, `item_uncomplete`, `item_delete` are written.

API (admins / agency keys only): see [api.md](api.md#todoist).
