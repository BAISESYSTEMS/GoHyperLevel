# Project planning & time tracking

Real project management inside every sub-account – lists, boards, calendar and Gantt over the same tasks, a
timer with timesheets, and invoices made from the hours. It extends the tasks HyperLevel always had (contacts
module, Todoist sync, mobile app, MCP) instead of living next to them: **every existing task is a planner task**,
and a task written by anything else (plain task list, workflows, Todoist, the Android app) shows up in the
planner without any change.

Menu: **Projektplanung** (`/app/pm`) and **Zeiterfassung** (`/app/time`), area "Kontakte & Aufgaben" (`contacts`).
Billing endpoints need the area "Rechnungen & Produkte" (`payments`) as well. No settings or environment
variables to set up; it uses the sub-account's invoice settings and member area.

## Projects and tasks

- **Projects** belong to a sub-account and can be linked to a contact, a company or a deal (`pm_projects`). Every
  sub-account has a default project **"Allgemein"** that takes all tasks without a project; the migration moved
  all tasks that existed before into it. It cannot be deleted or archived.
- **Statuses** are per project (default: Offen, In Arbeit, In Prüfung, Erledigt) and each belongs to a category
  `todo`, `active` or `done`. "Done" is derived from the category, so the plain `done` flag of the old task list
  and the status never disagree – a trigger keeps legacy writers in step both ways.
- **Sections** group tasks (phases), **custom fields** (text, number, date, select, checkbox, link) are per
  project or for all projects.
- **Tasks** have a title, description, priority (none … urgent), start and due date, an estimate, tags, one or more
  assignees, watchers, custom fields, checklists, attachments (links or files up to 8 MB; images, PDF, Office,
  text, CSV, ZIP – no HTML/SVG), comments with @mentions and an activity log. **Milestones** are tasks without duration.
- **Subtasks** nest up to 6 levels (at most 200 per task); a move keeps the whole subtree together, cycles and
  self-parenting are refused.
- **Dependencies** between tasks of one project: finish→start (default), start→start, finish→finish and
  start→finish, each with a lag in days (negative = overlap). Cycles are refused; moving a task pushes every
  dependent task (never pulls it earlier; finished tasks stay where they are).
- **Recurring tasks**: daily, weekly (weekdays), monthly (a fixed day, 31 = last day), yearly; counted from the due
  date (fixed rhythm) or from completion; ends never, after n times or on a date. Finishing a task creates the next one.
- **Dates** follow the app's convention: a date without a time is stored as `YYYY-MM-DDT00:00:00.000Z`; a time of
  day on a task is kept when only the day changes.
- **Project templates**: *Kunden-Onboarding* (17 tasks incl. subtasks) and *Website-Projekt* (18 tasks, 12
  dependencies, own statuses) are built in; any project can be saved as a template. Dates count from the start date
  you pick when you create the project; "duplicate project" copies structure, dependencies and sections.

## Views

All views read the same tasks, so a change shows everywhere. The address keeps the view and the open task
(`/app/pm/<project>?view=gantt&task=<id>`), `/app/pm/task/<id>` opens a task in its project.

| View | What it does |
| --- | --- |
| List | Group by section, status, assignee, priority or due date; sort; filters (person, status, priority, due, tag, search); subtasks nested; inline status/assignee/priority/date; quick add per group; drag a row onto another group; **bulk edit** (status, assignee, priority, section, due date, tags, delete) |
| Board | One column per status, drag cards between and within columns, quick add, estimate sum per column, keyboard moves (Alt + ←/→) |
| Calendar | Month or week, tasks as bars from start to due date, drag to move, click a day to add, "no date" panel to drag onto a day |
| Gantt | Bars with progress, **drag to move, drag the edges to resize, drag the end dot onto another task to link**, dependency arrows (click one to change type/lag or remove it), **critical path** in red with float, today line and weekends, zoom day/week/month, optional **baseline** (planned dates as a grey line below), conflicts marked, "automatically plan" (ASAP, with preview) |
| Workload | Estimates spread over the working days of each task, per person, against a weekly capacity; logged time as a bar |
| Meine Aufgaben | Everything assigned to you across all projects, grouped overdue / today / this week / later / no date, plus tasks you watch; start a timer from the row |
| Saved views | Any view with its filters, grouping and sorting – personal, or shared with the team by the leadership |

## Time tracking

- **Timer**: one running timer per person (a database constraint); starting another stops the first at the same
  moment. A global indicator in the top bar shows the running timer on every page, also when it runs in another
  sub-account. Timers left running are stopped after `max_timer_hours` (default 16) and the person is notified.
- **Manual entries**: a duration on a day, or from–to times. Entries with clock times cannot overlap another entry of
  the same person (switch off in the settings); one entry is at most 24 hours. Only the leadership books time for other people.
- **Timesheets**: a week per person as a table (tasks × days). With "approval required" a person submits the week, the
  leadership approves or rejects it; submitted and approved weeks are locked, only approved time can be billed.
  Submitting and deciding notify the people involved.
- **Billable flag and rates**: entries are billable by default (per project). The hourly rate is looked up as: the
  entry's own rate → the person on the project → the project → the person → the sub-account default.
- **In Rechnung stellen** (area `payments`): turns the billable, finished, not yet invoiced entries of a project into
  an **invoice draft** with the invoices module – lines per task, person, project or entry, always split by rate,
  optionally rounded up to 5–60 minutes (the quantity in hours keeps four decimals, so 20 minutes bill as 0,3333 h), with the configured tax rate. Entries remember the rate and rounded time
  that went on the invoice and cannot be billed twice; **cancelling the invoice frees them again.**
- **Reports**: hours by project, person, client (the project's customer), task, day or week, with the billable share
  and a CSV export. Members only see their own time, the leadership everyone's.

## Job costing and retainers

What a project earns and costs, next to the hours. Menu **Rentabilität** (`/app/profit`, area "Rechnungen & Produkte") and
the **Budget & Kosten** button in every project head. Nothing to set up; it reads the rates, time entries and invoices that
are already there. Margins and internal cost rates are only shown to the Leitung (agency admins and members with the
`settings` area).

### Budgets

- A project gets an **hour budget** (all logged time of the project counts), a **money budget** (the billable value of the
  time: invoiced lines at their billed rate and rounded time, the rest at the current bill rate – optionally plus the
  external costs) or both. Changing a budget needs the Leitung.
- **Alert thresholds** in percent (default 80 % and 100 %, up to five). Each threshold **fires once**: a notification in the
  bell, by web push and in the Android app's feed (to the people chosen in the budget, or the project owner and the
  Leitung), an audit line `pm.budget.threshold` and the workflow trigger **`project.budget_threshold`** (filters: project,
  hours/money, threshold; it starts for the project's customer). A threshold is armed again only when the use falls below
  it (more budget, deleted time), so it can fire a second time when it is reached again.
- Thresholds are checked right after time is logged and after every cost or budget change; a background check every
  10 minutes catches edits that send no event (deleted entries, changed rates).
- The project head shows the use as bars with the numbers in text (*Im Rahmen*, *Schwelle erreicht*, *Überschritten*); the
  window shows a **burn-down** (remaining hours or euros per day, weekly beyond 120 days, with a straight plan line to the
  project's due date).

### Cost rates and external costs

- **Internal cost rate** per person (what an hour costs you: salary, overhead) – separate from the bill rate – plus a
  default for everyone without one. Only the Leitung sees and changes them. Time of people without any cost rate counts
  with 0 € and the report says so.
- **External costs** per project (date, description, category, net amount). People with the area "Buchhaltung" can link a
  **receipt of the bookkeeping** (Belege, [backoffice.md](backoffice.md#receipts-inbox-belege)) instead of typing it: the
  description, date and net amount are taken from it, and a receipt hangs on one project at most. The receipt itself is
  never changed. Members change or delete only their own costs, the Leitung all of them.

### Profitability

Per project or per client (the project's customer, as in the hour reports), for a date range:

- **Revenue** = time on valid invoices (at the billed rate and rounded time) + the net amount of **closed retainer months** +
  billable time **not invoiced yet** (hours rounded like billing × the current rate). Time that a running retainer covers is
  shown as hours ("im laufenden Retainer") and counts once its month is closed. Cancelled invoices do not count.
- **Cost** = logged hours × internal cost rate + external costs.
- **Margin** in euros and in percent of the revenue, totals, a hint where cost rates are missing, and a **CSV export**
  (`/api/pm/billing/profitability/export.csv`, German number format, logged in the audit log like every export).
- A **Budgets** tab lists every budgeted project with its traffic light.

### Retainers

A retainer is a **monthly hour contingent at a fixed price** for a client – for one project, or for all projects of that
client (Rentabilität → Retainer):

- **Contingent** (hours per month), **price per month**, **overage rate** (empty = overage is not charged), **carry-over**:
  unused hours lapse, are carried over **up to N hours**, or carried over completely; first and optional last month.
- **Closing a month** (button, or automatically on the first background run after the month when *automatisch
  abschließen* is on): billable, finished time of the month in the retainer's projects that is not on another invoice yet
  (rounded like billing) is counted against contingent + carry-over. The result is an **invoice draft** with the invoices
  module: the fee and – if hours went over and there is a rate – an overage line in hours. The remaining hours are carried
  into the next month by the rule. The month's time entries then point at that invoice, so "In Rechnung stellen" cannot bill
  them again; **cancelling the invoice frees them and re-opens the month**.
- Months are closed **in order** and only once they are over. With "approval required" the close refuses while time of the
  month is not approved (or takes it along when asked to).
- One running retainer per project. A retainer with closed months can be ended but not deleted.

### Routes

All under `/api/pm/billing/` (area `payments`; L = Leitung only):

| | |
| --- | --- |
| Budgets | `GET /budgets` (all), `GET /budgets/:projectId`, `PUT /budgets/:projectId` L `{hours?, amount_cents?, thresholds?, include_costs?, notify?}`, `DELETE /budgets/:projectId` L, `GET /burndown/:projectId` |
| Costs | `GET/PUT /cost-rates` L `{user_id, cost_cents \| null}` or `{default_cost_cents}`, `GET /costs?project_id&from&to`, `POST /costs` `{project_id, description, amount_cents, day?, category?, receipt_id?}`, `PATCH/DELETE /costs/:id`, `GET /receipts?q=` (area `accounting` too) |
| Profitability | `GET /profitability?group=project\|client&from&to&project_id` L, `GET /profitability/export.csv` L |
| Retainers | `GET /retainers?project_id&contact_id&status`, `POST /retainers` L, `GET/PATCH/DELETE /retainers/:id` (PATCH/DELETE L), `GET /retainers/:id/preview?month`, `POST /retainers/:id/close` `{month?, include_unapproved?}` |

Events: `project.budget_threshold` (workflow trigger), `retainer.closed`.

## Automations

Per project (or for all projects), under *Einstellungen → Automationen*:

- **When**: status changed, task completed, task overdue, task created, task assigned – optionally only for a status,
  category, tag, minimum priority, assignee or words in the title.
- **Then**: create a task (from a task template or with a title; `{{title}}` is the triggering task), set the status,
  assign a person, set the priority, add a tag, notify people.
- A chain of automations is limited to three levels and no rule runs twice in one chain, so rules cannot loop. Every run
  is written to the audit log; the rule shows how often it ran and the last error.
- The same events are **workflow triggers** (`task.created`, `task.status_changed`, `task.completed`, `task.overdue`,
  `task.assigned`, with filters for project, status and person) and there are workflow actions **pm_create_task**,
  **pm_move_task** and **pm_assign_task**.

## Customer portal

A project with *Im Kundenportal freigeben* appears in the member area under **Meine Projekte** (`/portal/<name>/projects`)
for the linked customer – the contact itself, contacts of a linked company, or the contact of a linked deal. It is
read-only: progress, milestones and a board of the tasks. Tasks marked *Nur intern* (and everything below them),
comments, time entries, estimates and rates are never shown. Archived and unshared projects are not found (404).

## Notifications

Mentions, assignments, tasks due today and overdue, comments on tasks you watch, timesheet decisions and automatic
timer stops go to the bell in the top bar, to the web push of the push module (the first assignee only gets the push
module's own assignment push) and to the Android app's feed. Nobody is notified about their own changes.

## Permissions, isolation, audit

- Every route needs the area `contacts`; `/api/pm/billing/*` needs `payments` (budgets, costs, retainers and the
  profitability report included; cost rates, margins and budget/retainer changes only for the Leitung). Billing settings (default rate, rounding,
  tax) can only be changed by someone who has the `payments` area. "Leitung" = agency admins and members with the
  `settings` area: they change settings, rates, approve timesheets and see everyone's time.
- Everything is scoped to the sub-account (`location_id`): ids from another sub-account answer 404/400, and the
  tenant-isolation test suite attacks every route with seeded planner data. Every write is in the audit log.
- Limits: 6 levels, 200 subtasks per task, 40 attachments per task (8 MB each), 20 statuses and 100 sections per
  project, 2000 tasks per project list, 500 tasks per bulk edit.

## MCP tools (17)

`ghl_pm_team`, `ghl_pm_list_projects`, `ghl_pm_get_project`, `ghl_pm_create_project`, `ghl_pm_list_tasks`,
`ghl_pm_get_task`, `ghl_pm_create_task` (with nested `subtasks` in one call; people by name, e-mail or id),
`ghl_pm_update_task`, `ghl_pm_move_task`, `ghl_pm_comment`, `ghl_pm_add_dependency`, `ghl_pm_gantt`,
`ghl_pm_log_time`, `ghl_pm_timer`, `ghl_pm_timesheet_summary`, `ghl_pm_invoice_time`, `ghl_pm_my_tasks`.
They run with the key's sub-account, the area rights of the key's user and the audit log. A key has no person of its
own: tools that book time or show "my tasks" take a `user_id`. The reports module gets two sources, `time_entries`
and `pm_projects`.

## Mobile API

`/api/mobile/pm/*` for the Android app (same device tokens and per-area rights as the rest of the mobile API): my open
tasks across sub-accounts, a task with statuses/subtasks/comments, status change, comment, the running timer
(start/stop) and the notification list – see [API → Mobile-App](api.md#mobile-app).

## Data model and REST API

Tables `pm_projects`, `pm_statuses`, `pm_sections`, `pm_custom_fields`, `pm_assignees`, `pm_watchers`,
`pm_dependencies`, `pm_comments`, `pm_attachments`, `pm_activity`, `pm_views`, `pm_templates`, `pm_automations`,
`pm_notifications`, `pm_settings`, `pm_time_entries`, `pm_rates`, `pm_timesheets` (job costing: `pm_budgets`,
`pm_cost_rates`, `pm_cost_settings`, `pm_costs`, `pm_retainers`, `pm_retainer_periods`) next to the extended `tasks` table
(`project_id`, `section_id`, `parent_id`, `status_id`, `priority`, `start_at`, `estimate_minutes`, tags, custom
values, checklists, recurrence …). Code: `server/modules/pm*.ts`, `server/services/pm-*.ts` (scheduling math, hierarchy
rules and recurrence are pure modules the web app shares), UI `web/src/pages/Pm*.tsx`. Job costing: `modules/pm-costing.ts`
(budgets, costs, profitability) and `modules/pm-retainers.ts` with the logic in `services/pm-costing.ts`,
`services/pm-retainers.ts` and the pure maths in `services/pm-costing-model.ts` (thresholds, retainer month, margin,
burn-down); UI `PmProfit.tsx` (Rentabilität), `PmBudget.tsx` (project head), tests `tests/pm-costing.test.ts`. Hooks:
`app.services.pmCosting.checkBudget/checkAll`, `app.services.pmRetainers.autoClose`. The routes under `/api/pm/`
(projects, tasks, comments, attachments, dependencies, `gantt`, `workload`, `my-tasks`, `views`, `automations`,
`templates`, `timer`, `time`, `timesheet`, `billing`) are listed in `server/modules/pm.ts` and `pm-time.ts`; list
endpoints take the filters of the list view as query parameters.
