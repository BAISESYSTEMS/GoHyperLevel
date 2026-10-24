**English** · [Deutsch](reports.de.md)

# Reports & dashboards

Your own analyses across all areas – like HubSpot's reporting: freely assembled reports, several dashboards with a grid you can drag and resize, templates, sharing, TV mode and regular e-mails. Menu **Reports** (right below *Dashboard*; from the dashboard also through **Custom dashboards**). It needs no credentials and no extra package – the app draws all charts itself.

## Creating a report

**Reports → Create report** (or **+ Report**). You set things up on the left, and the preview on the right shows the result right away.

1. Choose the **data source** (see the table below).
2. **Chart type**: Number (with comparison to the previous period), Line, Area, Columns, Stacked, Bars, Pie, Donut, Funnel (e.g. pipeline stages), Heatmap (e.g. weekday × time of day), Table (sortable by clicking the column). When you switch, the builder sets matching groupings (Line → by date, Heatmap → weekday and hour, Funnel → stage).
3. **Measures** (up to 6): Count, calculated measures of the source (win rate, weighted revenue forecast, MRR, no-show rate …), sum/avg./min./max. of number fields, “Count unique”. Charts show the first measure (or all with the same unit), the table shows all.
4. **Group by** (up to 2): any field; date fields by day, week, month, quarter, year, weekday or time of day – always in the sub-account's time zone. Empty days/weeks show as 0. With two groupings, the second becomes the series (stacked); more than 8 series are combined into “Other”.
5. **Filters** (up to 20): is / is not / is one of / contains / starts with / is empty; for numbers greater/less/between; for dates in the period (e.g. “Last 30 days”) / before / after; yes/no; “has tag”.
6. **Period**: which date field (e.g. *Created on*, *Won on*, *Paid on*) and which period: Today, Yesterday, This/Last week, Last 7/30/90/365 days, This/Last month, This/Last quarter, This/Last year, Last 12 months, All time, or from–to. **Compare with the previous period** sets the preceding period against every value; “This month” (up to today) is compared with the same days of the previous month, “Last 30 days” with the 30 days before. **Keep this period on the dashboard** keeps the report independent of the dashboard period (e.g. “Open pipeline value” across all data).
7. **Sub-accounts**: “This sub-account only” or “All my sub-accounts (agency)” (agency view; every source has the group *Sub-account* for this).
8. **At most (top N)**: only the N largest groups.

At the top: switch between **Table/Chart**, **CSV** (for Excel: semicolon, decimal comma), **Go to dashboard** (existing or new), **Save to library** (name, description, visible to only me / team of this sub-account / all admins). Saved reports live under **Library**; other people's reports can be saved as a copy.

### Data sources

| Source | Contents | Examples |
| --- | --- | --- |
| Contacts | Source, Owner, City, Tags, “Has opportunity”, “Is customer”, first/last source (attribution) | Leads per source, Lead → deal |
| Opportunities | Pipeline, Stage, Status, Value, Currency, Weighted value, Probability, Loss reason, Expected close (also “overdue”), Created/Won/Lost/Closed on, Days to close, contact fields | Pipeline value per stage, win rate, revenue forecast (also per close month), loss reasons, deal velocity |
| Tasks | Owner, open/done, overdue, due/done on | Tasks per user, completion rate |
| Appointments | Calendar, Status, Origin, Duration, Lead time | No-show rate, show rate, cancellation rate |
| Messages | Channel, Direction, Status, Sent by, opened/clicked (people only), opened by machines | Messages per channel, open rate |
| Conversations | unread, starred, started on | new conversations per week |
| Calls | Direction, Status, answered, Team member, Duration | Calls per user, answer rate, call minutes |
| Invoices & payments | Type, Status, overdue (from the day after the due date, in the sub-account's time zone), Subscription invoice, gross/net/tax, customer | paid revenue, open/overdue amounts |
| Revenue per product | Invoice lines with quantity and net revenue | Revenue per product |
| Subscriptions (MRR) | recurring invoices converted to a month | MRR, ARR, MRR per interval |
| Campaigns | Recipients per campaign | sent, open/click rate (people only; Apple Mail, proxies and scanners are listed separately as “Opened/Clicked by machines” – [docs/email-tracking.md](email-tracking.md)) |
| Form submissions | Form, contact fields | Submissions, conversion to deal/customer |
| Attribution (touchpoints) | Touchpoints by type, channel, source, medium, campaign, funnel | unique visitors per channel |
| Affiliate commissions | Partner, programme, status, amount | Commission per partner |
| Course enrolments | Course, status, started/completed | Completion rate |

In addition there are “Companies”, a source for each custom object with its properties, and “Lead scores” ([docs/objects.md](objects.md#snapshots-supabase-reports-import)). Other modules (e.g. tickets) can register sources of their own, see [architecture.md](architecture.md#reports-custom-data-sources).

### Custom contact fields

The custom fields of contacts (*Settings → Custom fields*) are available in the **Contacts** source under **Custom fields**: **number fields** as a measure (sum, avg., min, max – e.g. “Sum of budget per package”, also as a dashboard building block), **choice**, **yes/no**, **date** and text fields for grouping and filtering. Each field applies only in the sub-accounts where it was created; new or changed fields are available immediately. Technical details: `server/modules/report-custom-fields.ts` (extends the `contacts` source in `app.services.reportSources`, field key `cf_<key>`).

### Stage probability (weighted forecast)

**Opportunities → Edit pipeline**: to the right of each stage, the probability in % that a deal is won there. Empty = automatic by position (with 4 stages 20/40/60/80%). Won deals count as 100%, lost ones as 0%. The **revenue forecast (weighted)** is the sum of value × probability across all open deals. From now on the app records the won and lost date when the status changes; older deals use their last change.

### Expected close, loss reason and currency

Every deal has an optional **expected close date**, a **currency** (default EUR) and – when it is set to “Lost” – a **loss reason**. The date drives the forecast by month (Sales dashboard: *Forecast per expected close month*, Living Boards template `forecast_by_close_month`); the filter *Close overdue* shows open deals whose date has passed. You pick the reasons from the pipeline's list (**Opportunities → Edit pipeline → Loss reasons**, one reason per line; empty = default list) or write your own. *Lost deals by reason* (Sales dashboard, board template `lost_reasons`) groups by `lost_reason` with count and `calc:lost_value`. Amounts in different currencies are **not converted**: totals in the kanban appear side by side per currency, and in reports the grouping `currency` separates them.

The loss reason is **required** when switching to “Lost” – in the interface, through the API (`lost_reason`), MCP (`ghl_update_opportunity`), the REST hook `move_stage` and the mobile app. Workflow steps have a field “Loss reason”; if it stays empty, “Per Automation” is entered there (mobile app without an entry: “Per App”). Switching back to Open deletes the reason; deals lost before this update remain editable without a reason.

## Dashboards

**Reports → Dashboards** shows your default dashboard (or the first one); at the top left you switch between all dashboards you may see.

- **Filter row**: period (applies to all widgets without a fixed period), sub-account or all, Auto refresh (1/5/15/60 minutes), *With previous period*, reload.
- **Editing**: drag widgets by the handle, resize them at the bottom-right corner (12-column grid, the others move along), change the title directly, ✕ removes. With the keyboard: focus the handle, move with the arrow keys, resize with Shift. **+ Widget** fetches a saved report or opens the builder; the pencil on a widget edits it in the builder (**Update widget**).
- **Sharing**: only me, team of this sub-account or all admins. Shared dashboards are read-only for others, and each person sees **only numbers from the sub-accounts and areas they have access to themselves**. This is also where **As my default dashboard** is.
- **TV mode**: full screen for the screen in the office, refreshes at least every minute; Esc or ✕ ends it.
- On a phone, the widgets are stacked.

### Templates

**Reports → Templates → Dashboard from template** creates with one click:

- **Sales**: open pipeline value, weighted revenue forecast, win rate, deal velocity, pipeline value per stage (funnel), forecast per stage, won revenue per month, deals per owner.
- **Marketing**: new leads, lead → deal, form submissions, open rate, leads per source, leads per week, campaign performance, form conversion.
- **Revenue**: MRR, paid revenue, open and overdue invoices, revenue per month and product, open invoices per customer, MRR per interval.
- **Activity**: calls, outgoing messages, completed tasks, answer rate, calls/messages/tasks per user, heatmap of incoming messages.
- **Appointments**: appointments, no-show, show and cancellation rate, appointments per calendar and per week, no-show rate per calendar, heatmap.

## Schedules (report by e-mail)

On a dashboard, **By email**: daily, weekly (weekday) or monthly (day 1–28) at the chosen time, to up to 20 addresses. The e-mail contains the measures with the change from the previous period and every chart as a table with bars (no images, readable in any mail program) plus a link to the dashboard. Default period: yesterday / last week / last month. It is sent through the sub-account's e-mail delivery (**Settings → E-mail**, SMTP); without SMTP it is only logged. The numbers are calculated with the permissions of the person who created the schedule. **Reports → Schedules**: preview, send now, edit, pause, delete; the result of the last send is shown there too.

## Security & limits

- Every query is restricted to the user's sub-accounts (admins: all, client logins: their own, API keys of a sub-account: only that one); client logins need the *Dashboard* permission and the permission of the respective area (e.g. *Invoices & products* for revenue sources).
- SaaS plans: areas that a sub-account's plan does not include are also missing from its reports.
- All values are passed to the database as parameters, field names only from the source's fixed list. At most 1000 groups per report, and a query aborts after 8 seconds (“Narrow the period or filter”).

## API & MCP

REST under `/api/reports/*` (see [api.md](api.md)), MCP tools `ghl_run_report` (free-form report: source, measures, groupings, filters, period, comparison, agency view), `ghl_list_dashboards` and `ghl_get_dashboard` (all widgets with numbers, optionally another period).

```bash
# Pipeline value of open deals per stage
curl -X POST https://crm.example.com/api/reports/run -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"query":{"source":"opportunities","measures":["sum:value","calc:forecast"],"group_by":["stage"],"filters":[{"field":"status","op":"eq","value":"open"}],"range":"all"}}'
```
