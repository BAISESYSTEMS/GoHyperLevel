# Booking rules (limits, special days, reminders, follow-up)

This page covers the booking rules of a calendar, the [calendar view](#calendar-view) (day, week, month, team, agenda),
[recurring appointments](#recurring-appointments), the [service menu](#service-menu), [rentals](#rentals) and [booking by AI in chat](#ai-books-appointments).

Everything in the first sections is set in **Kalender → a calendar → Verfügbarkeit / Bestätigung & Erinnerung / Nachfassen** and lives in the calendar's `settings` (so `PATCH /api/calendars/:id` with `{settings: {…}}` sets it, see [api.md](api.md)). It works for the single-person calendars; team types (round robin, collective, classes – [team-calendars.md](team-calendars.md)) follow the hours and out-of-office entries of their members.

Already there before: duration, interval, **buffer** (minutes around every appointment), **minimum notice** (`min_notice`, hours) and how far ahead people may book (`max_days`).

## Limits per day and week

`limit_day` and `limit_week` (0 = unlimited, at most 500). Once the day's – or the Monday-to-Sunday week's – limit is reached, the whole day disappears from the offer on the booking page, the staff form, the phone agent and workflow bookings alike. Cancelled appointments and blocked times do not count. Staff can still book by hand with *force*; the public page cannot. Counting is per calendar and in the calendar's time zone.

## Special days (holidays and extra hours)

`date_overrides`: `{"2026-12-24": [], "2026-12-27": [["10:00", "12:00"]]}` – an empty list closes that day, windows **replace** the weekly hours of that date. At most 366 entries; past days are dropped when the calendar is saved. In the editor: **Verfügbarkeit → Abweichende Tage**.

## Reminders by e-mail and SMS

`reminders`: up to five entries `{hours, email, sms, subject?, body?, sms_body?}`, for example 24 hours and 1 hour before the start (hours from 0.25 to 720, no two at the same time).

- **E-mail** uses the calendar's reminder subject and text (`reminder_subject`, `reminder_body`); **SMS** uses `reminder_sms_body` or a short default with the date and the link to manage the appointment. Merge fields as in the confirmation: `{{contact.first_name|du}}`, `{{appointment.start_text}}`, `{{appointment.manage_url}}`, `{{calendar.name}}`, `{{location.name}}`.
- SMS goes out only when an **SMS provider** is set up for the sub-account (not just "log"), the contact has a phone number and has not switched on *Nicht stören*. The e-mail reminder is a service mail like the confirmation and ignores *Nicht stören*.
- Each reminder is sent **once per start time**; moving an appointment starts its reminders again. A reminder whose moment was **before the booking** is skipped (the confirmation just went out); when several are due at once (for example after downtime) only the closest one is sent.
- Calendars without a `reminders` list keep the single reminder (`reminder_hours`) they had; setting `reminders: null` returns to it.

## Follow-up and no-show

- `followup: {enabled, hours, email, sms, subject, body, sms_body}` – a thank-you `hours` after the **end** of a confirmed or attended appointment (not cancelled, not no-show). Only appointments that end after the message was switched on are written to, and one that is more than two days late is dropped.
- `noshow: {enabled, email, sms, subject, body, sms_body}` – goes out when you set an appointment to *nicht erschienen* (by hand, workflow or app), once per appointment, with `{{appointment.booking_url}}` to book again.

Both respect *Nicht stören* and use the sub-account's e-mail and SMS senders. Defaults are German and editable; `enabled_at` is set by the server.

## Limits of the build

Reminders and follow-ups run on the background tick (`PGHL_TICK_MS`, default 15 s). Workflows can do the same and more with the trigger *Termin beginnt bald* and the status triggers; these settings are the quick way for the common case.

## Calendar view

**Kalender → Kalenderansicht** (the first tab of the page; its own lazily loaded chunk). Views:

| View | What it shows |
| --- | --- |
| **Tag / Woche** | A time grid per day (Monday to Sunday), 07:00–20:00 and wider when something lies outside |
| **Monat** | Six weeks; up to four appointments per day, "+n weitere" opens the day |
| **Team** | One column per person for a day (filtered people, or everybody with the calendar area); appointments without a person (plain calendars) get a column "Ohne Person" |
| **Agenda** | A list of the next two weeks – the default on phones (below 700 px; week and team are hidden there, a round **+** books) |

- **Editing.** Drag an appointment to move it (to another day in the week view), drag its lower edge to change its length,
  click an empty slot to book (snaps to 15 minutes), click an appointment for the **drawer**: contact (link, e-mail, phone,
  conversation), notes, status (*bestätigt / erschienen / nicht erschienen / abgesagt* – cancelling a paid team-calendar
  appointment follows its refund rules), payment (the team calendar's payment, an invoice linked to the appointment or
  **Rechnung anlegen** – a draft with the calendar as the line, for people with the payments area), the series, and the links
  to reschedule and to cancel. In the month view appointments are dragged to another day (same time).
- **Moving uses the calendar's own reschedule logic.** A plain move of a confirmed appointment goes through the same code as
  *Verschieben* on the appointment list (slot rules, hosts of a team calendar, video link, the contact's "Termin verschoben"
  e-mail). A resize, a blocked time or a time off the calendar's slot grid is checked by the view and written through
  `PATCH /api/appointments/:id` (events, reminders, Google/Outlook sync as usual; the contact gets the same e-mail). If
  something is in the way – another appointment of the calendar or of a calendar sharing its availability, the buffer, the
  person's appointment in another calendar, a busy time of a connected calendar, the bookable hours, the day/week limit,
  an absence of the person – the drop answers with the reasons and **Trotzdem verschieben** overrides (staff decide).
- **Overlays.** Bookable hours (everything else is shaded), buffers (hatched), blocked times, busy times of connected Google/
  Outlook/iCal calendars ("belegt" – per calendar, and per person in the team view), out-of-office and approved HR absences,
  and as a switchable second layer **tasks with a due date** (from the tasks and project planning modules, people with the
  contacts area; date-only due dates in the all-day row).
- **Filters** by calendar, person and status; the choice and the view are remembered in the browser.
- **Keyboard.** ← → page, T today, D/W/M/P/A view, N new appointment, `?` shows the keys. Tab to an appointment, Enter opens it,
  Alt+↑/↓ moves it by 15 minutes, Alt+Shift+↑/↓ changes its length, Alt+←/→ moves it by a day.
- **Time zone.** Everything is drawn on the wall clock of the **sub-account's time zone**, whatever the browser's zone (a note
  says so when they differ); 10:00 stays 10:00 across a DST change, and the "today" line follows the same clock.

API (calendars area): `GET /api/calendar-view?from&to&calendars&users&status&layers` → `{timezone, days, calendars, users,
appointments (with people, series fields, contact name), buffers, hours, busy, absences}` (at most 62 days; `layers=busy,absences`
by default, `layers=` switches both off), `POST /api/calendar-view/check` `{calendar_id, start, end?, appointment_id?, blocked?}` →
`{ok, issues: [{kind, label, start_at, end_at}]}` (kinds `appointment`, `blocked`, `buffer`, `person`, `busy`, `hours`, `limit`,
`absence`), `POST /api/calendar-view/book` `{calendar_id, start, end?, contact_id | contact, notes?, blocked?, title?, force?}`
(409 with `issues` unless `force`), `POST /api/calendar-view/appointments/:id/move` `{start?, end?, force?, notify?}` →
`{appointment, via: reschedule|update|override, notified, issues}`, `GET /api/calendar-view/appointments/:id` (the drawer) and
`POST /api/calendar-view/appointments/:id/invoice` (payments area; once per appointment).

## Recurring appointments

In the booking dialog of the calendar view (**Wiederholen**) or with `POST /api/appointment-series`: an appointment that repeats
**daily, weekly on given days, every N weeks or monthly**, ending never, after a number of appointments or on a date – an RRULE
subset like the recurring tasks (`FREQ=DAILY|WEEKLY|MONTHLY`, `INTERVAL`, `BYDAY` without numbers, one `BYMONTHDAY`, `COUNT` or
`UNTIL`). A monthly series that starts on the 31st stays on the last day of shorter months.

- **Every appointment is a row of its own** with `series_id`, `recurrence` (the RRULE) and `occurrence_date`, so lists, the
  calendar view, workflows and the app treat it like any appointment. They are written **90 days ahead on a rolling basis**
  by the background tick (checked every 5 minutes); a series without an end keeps growing, one with an end stops.
- **Reminders per appointment.** The reminders, follow-ups and no-show messages of the calendar run for each appointment of a
  series on its own (they are keyed by start time). The contact gets **one** confirmation for the whole series, not one per
  appointment; `appointment.booked` fires once (for the first appointment, with `series`).
- **Edit or cancel "only this", "this and following" or "all"** (drawer → *Serie bearbeiten* / *abgesagt*, or dragging a
  series appointment to another time of the same day). *Only this* changes one appointment, which then keeps its own time
  (an exception – also when it was moved in the app, by the contact through the reschedule link or by the Google/Outlook
  sync). *This and following* splits the series: the old part ends the day before, the new part has the new time or rule
  (the total of a counted series is kept). *All* changes every future appointment that was not moved on its own; past ones
  stay. Appointments whose date no longer fits the new rule are removed, missing dates are written. Cancelling *this and
  following* or *all* sends one e-mail and one `appointment.status_changed` event (with `series: {id, scope, count}`).
- **Conflicts.** Creating a series checks every date up to the horizon; with overlaps the answer is 409 with the dates and
  reasons, `force: true` creates it anyway. Dates written later by the tick are not checked again.
- **Google/Outlook.** The two-way sync ([Google & Microsoft](self-hosting.md#google--microsoft-verbinden-oauth)) has no series support: every appointment of a
  series is written as a **single event** (moving one over there moves only that appointment – it becomes an exception here).
  The private `.ics` feed lists them as single events as well.

API: `POST /api/appointment-series/preview` `{calendar_id, start, duration?, recurrence}` → `{rrule, description, occurrences,
conflicts}`, `POST /api/appointment-series` `{calendar_id, start, duration?, recurrence, contact_id | contact | blocked, title?,
notes?, force?, notify?}`, `GET /api/appointment-series?calendar_id&contact_id&status`, `GET /api/appointment-series/:id` (with
its appointments), `PATCH /api/appointment-series/:id` `{scope: single|following|all, appointment_id, start_time?, duration?,
recurrence?, title?, notes?, notify?}`, `POST /api/appointment-series/:id/cancel` `{scope, appointment_id?, reason?, notify?}`.
`recurrence` is an RRULE string or `{freq, interval, weekdays (0 = Sunday), day_of_month, end: {type: never|count|date}}`.
MCP: `ghl_appointment_series_create`, `ghl_appointment_series_cancel`.

## Service menu

**Kalender → Leistungsmenüs** builds one public page with all your services (HighLevel's *Service Menu*): `/book/s/<kurzname>`
(`?embed=1` for an iframe). Visitors pick a **service** (grouped in categories, with duration, description and price), then a
**person** – on round-robin calendars "Egal – nächste freie Person" or one team member, whose free times alone are shown – then a
**day and time** and fill in their details and the calendar's questions.

- **A service is a booking calendar.** Duration, price (*Zahlung*), questions, consent text, team, buffers and limits stay in the
  calendar; the menu only groups and presents them. Inactive calendars disappear from the page by themselves.
- **Booking goes through the team-calendar pipeline** with the chosen person: questions and consent are checked on the server,
  paid calendars send the visitor to the payment (the slot is held), confirmation, video link, reminders and workflows are the
  calendar's own. The appointment's source is *Leistungsmenü*.
- **Weitere Felder** (folded in Einfach-Modus): introduction, short name, and whether visitors may pick the person at all.
- **API** (area calendars): `GET/POST /api/service-menus` (`{name, slug?, intro?, staff_choice?, active?, categories: [{name,
  calendar_ids}]}` – up to 20 categories with 30 services), `GET/PATCH/DELETE /api/service-menus/:id`; public `GET
  /api/public/service-menus/:slug`, `GET …/:slug/slots?calendar_id&host_id&from&days`, `POST …/:slug/book` `{calendar_id, host_id?,
  start, first_name, last_name?, email, phone?, notes?, answers?, consent}`. **MCP:** `ghl_service_menus`, `ghl_service_menu_save`.
- Conditional questions of a calendar ([team-calendars.md](team-calendars.md#questions)) show and hide on the menu page as well.
- **Limits:** no variants or add-ons per service (make a calendar per variant), one appointment per booking, no waiting list from
  the menu (the calendar's own page has it).

## Rentals

**Kalender → Vermietung** (HighLevel's *Rentals*): things with a quantity that customers book for a period – 3 e-bikes per day,
a holiday flat per night, 5 kayaks. Each item has its own public page `/book/rent/<kurzname>` (the calendar link `/book/<kurzname>`
shows the same page; `?embed=1` for an iframe).

- **Booking by date range.** Visitors pick the range in a month picker (or two date fields) that shows how many are free each
  day, choose how many they want, see the price and fill in their details. **Per night:** check-in day and check-out day – a
  check-out and the next check-in on the same day do not collide (same-day turnover). **Per day:** first and last day,
  both included; the item is out for whole days.
- **Availability = quantity minus the overlapping bookings**, the tightest day counts. Bookings that count: confirmed ones whose
  appointment is not cancelled, and unpaid ones while their reservation lasts. A **blocked time** drawn in the calendar view on
  the item's calendar (maintenance, own use) closes every day it touches. Check and write happen in one database transaction –
  parallel requests for the last unit cannot both get it.
- **Price** per day or night × length × number of items, plus an optional **Kaution** (deposit) per item. With a price the
  customer pays first on the pay page of the [payment registry](payment-providers.md) (Stripe, PayPal, Mollie, gift card – what
  the sub-account has set up); the range is held for 30 minutes. The payment confirms the booking and writes an invoice marked
  paid (rent with the usual tax rate, deposit as a line without tax). A payment that arrives after the reservation ran out is
  accepted while the range is still free, otherwise refunded and the team is told. Without a payment set-up a paid item cannot be
  booked online; the team can still book it with *Ohne Online-Zahlung buchen*. **Free items** are confirmed at once.
- **Each item is a booking calendar** (`settings.rental`, no weekly hours, so it is never offered as a time slot and stays out of
  service menus and routing forms). A booking is an **appointment from check-in to check-out time** (defaults: night 15:00–11:00,
  day 09:00–18:00): the calendar view draws it in the all-day row across its days (month and agenda list it on each day), the
  contact's timeline, workflows (`appointment.booked` with `meta.rental`), reminders and the **confirmation e-mail** are the
  calendar's. New items get rental texts; merge fields `{{appointment.rental_text}}` (range, nights/days, items),
  `{{appointment.rental_price}}`, `{{appointment.rental_qty}}`, `{{appointment.rental_from}}`, `{{appointment.rental_to}}`.
- **Cancelling.** The link in the confirmation shows the booking (range, items, amount) and lets the customer cancel until the
  start; the units are free again at once. Paid bookings are not refunded automatically – the team gets a notice to refund.
  The team cancels in the calendar view or the appointment list like any appointment.
- **Einfach-Modus:** name, quantity, per day/night and price are visible; description, deposit, minimum/maximum length, times,
  booking horizon and *online buchbar* sit behind **Weitere Felder** (opened by itself when one of them holds a value).
- **API** (area calendars): `GET/POST /api/rentals` (`{name, quantity, unit: day|night, price_cents, deposit_cents?, min_units?,
  max_units? (0 = no limit), checkin_time?, checkout_time?, max_days?, description?, active?}`), `GET/PATCH/DELETE /api/rentals/:id`
  (delete refuses with upcoming bookings unless `?force=1`), `GET /api/rentals/:id/availability?from&days` → `{days: [{date,
  free}]}`, `GET /api/rentals/:id/quote?from&to|days&qty` → `{ok, problem?, free, units, rent_cents, deposit_cents, total_cents,
  start_at, end_at}`, `GET /api/rentals/:id/bookings?all=1`, `POST /api/rentals/:id/book` `{from, to | days, qty?, contact_id |
  email + first_name, notes?, payment: require|waive}`. Public: `GET /api/public/rentals/:slug`, `…/:slug/availability`,
  `…/:slug/quote`, `POST …/:slug/book` `{from, to | days, qty, first_name, last_name?, email, phone?, notes?, consent}` →
  `{status: confirmed, booking, manage_url, ics_url}` or `{status: payment_required, checkout_url, expires_at}`. Dates are
  `YYYY-MM-DD`; `to` is the check-out day (night) or the last day (day).
- **MCP / agent:** `ghl_rental_availability` (read: items, free units per day, a quote for a range), `ghl_rental_book` (books;
  asks for confirmation first like `ghl_book_slot`, since the contact gets an e-mail or a pay link), `ghl_rental_save` (create or
  change an item).
- **Limits:** one item per booking (several items of the same kind are fine), no seasonal prices or weekend rates, no automatic
  deposit refund, no per-unit identities (which bike) – the quantity is a pool.

## Calendar AI

The agent (HyperLevel-Agent, Claude, ChatGPT … over MCP) can **set up a calendar from a sentence** and **explain a time**:

- `ghl_calendar_create` – "30-Minuten-Erstgespräch, Mo–Fr 9–17 Uhr, 24 Stunden Vorlauf, 15 Minuten Puffer" becomes a calendar with
  duration, grid, buffer, notice, horizon, time zone and weekly hours; the answer carries the booking link. A relay onto
  `POST /api/calendars`, so its checks and the audit log apply. Team, questions and payment are set in the app afterwards.
- `ghl_calendar_explain_slot` (read only) – is a start time bookable, and if not, why: another appointment (with its title), a
  buffer, the person's appointment in another calendar, a busy time of a connected Google/Outlook/iCal calendar, outside the hours,
  the day/week limit, an absence, the minimum notice, the booking horizon, off the slot grid, or nobody of the team free. With the
  free times of that day and the next free time, in the calendar's time zone. Same check as the calendar view's drag & drop.
- API (calendars area): `GET /api/calendar-ai/explain?calendar_id&start` → `{bookable, reasons: [{kind, text, detail?, start_at?,
  end_at?}], free_that_day, next_free, start_local}`.

## Appointments in the customer portal

The customer portal (*Mitgliederbereich*, `/portal/<id>`) gets **Meine Termine** as soon as a contact has an appointment (the last
90 days or upcoming): the next appointment on the start page, a link in the top bar and a page with the upcoming appointments (time
in the calendar's time zone, place or video link, status, **Verschieben oder absagen** – the appointment's own page, where the
calendar's cutoffs and refund rules apply), **Neuen Termin buchen** (the active service menus and booking calendars) and the past
appointments. A contact with an appointment may log in to the portal with the usual e-mail link, even without a course. Nothing can be
changed on the portal page itself.

## Tickets and check-in

Every booked appointment – a consultation, a class seat, an event – has a **ticket**: `/book/ticket/<token>` (linked from the
appointment's own page and from *Meine Termine* in the customer portal) with calendar, time, name, a **QR code** and a 10-character
**ticket code**. At the door the team scans the QR code with the phone: the ticket page opens, and a team member signed in to
HyperLevel in that browser taps *Für das Team: einchecken*. Without the page, the code works too (`POST /api/appointment-checkin`
`{code}` – the code, the full token or the ticket link; MCP `ghl_appointment_checkin`). Checking in sets the appointment to
**erschienen** through the normal appointment route (status event, workflows, reports); a second scan answers *schon eingecheckt*
with the time, a cancelled appointment is refused. `GET /api/appointment-checkin/summary?date=YYYY-MM-DD&calendar_id=` lists who is
checked in. Events with several ticket types, prices and quotas: see [Ticket types](#ticket-types) below. Not included: wallet passes.

## Ticket types

**Kalender → Events & Tickets** sells tickets for an event (a concert, a workshop, a party) without a booking calendar. An event has
a name, a start (and optional end), a place, a description and a currency; it has up to 20 **ticket types**:

| Field | Meaning |
| --- | --- |
| **Name** | e.g. *Stehplatz*, *VIP*, *Frühbucher* |
| **Preis** | gross per ticket; empty or 0 = free (paid types at least 0,50 €) |
| **Kontingent** | how many can be sold; empty = unlimited. When it is used up the type shows *Ausverkauft* |
| **Verkaufsstart / Verkaufsende** | optional sale window; without an end the sale stops when the event begins |
| **Höchstens je Bestellung** | optional limit per order (1–20, default 10) |

In Einfach-Modus only name, start, place and per type name, price and quota show; the sale window, the per-order limit, the
description, end, currency, tax rate and the link's short name are folded under *Weitere Felder* (they open by themselves when set).

**Buying.** The public page `/book/event/<slug>` (a plain form – it works without JavaScript) lists the types with price and state
(*noch 3*, *Verkauf ab …*, *Verkauf beendet*, *Ausverkauft*); the buyer picks a quantity per type, gives name and e-mail and orders.
The buyer becomes a contact (source *Event-Tickets: <event>*). Every ticket is a row of its own with its **own QR code and code**:
the order page `/book/event-order/<token>` shows all of them, `/book/event-ticket/<token>` one ticket with the type in large print;
the confirmation e-mail links both.

- **Free orders** are confirmed at once.
- **Paid orders** go through the payment registry like the store (Stripe, PayPal, Mollie, gift cards – [payment-providers.md](payment-providers.md)):
  the tickets are **held for 30 minutes** while the buyer pays and count against the quota; after the payment they are valid and a
  paid invoice is written (one line per type, the event's tax rate or the invoice default). An unpaid hold runs out and frees the
  tickets. A payment that arrives late is honoured while the quota still has room, otherwise it is refunded automatically and the
  team is told. Without a payment provider, paid types cannot be ordered.
- **No overselling.** The quota check and the reservation happen in one database transaction: when many people order the last
  tickets at the same time, exactly as many orders succeed as tickets are left; the others get *nur noch … verfügbar*.

**Check-in.** At the door scan the QR code (the ticket page has *Für das Team: einchecken*) or type the code: `POST
/api/ticket-events/checkin` `{code}` answers with holder, **ticket type** and event; a second scan says *schon eingecheckt*,
unpaid or cancelled tickets are refused. The appointment check-in (`POST /api/appointment-checkin`, MCP `ghl_appointment_checkin`)
accepts event-ticket codes too, so one scanner serves both.

**Report.** *Bericht* on the event (and `GET /api/ticket-events/:id/report`) counts per type: sold (of the quota), checked in, held
(payment running), left and revenue. `GET /api/ticket-events/:id/tickets` is the guest list with type, code and check-in time.

**API and agents.** `GET/POST /api/ticket-events`, `GET/PATCH/DELETE /api/ticket-events/:id` (with `types: [...]` the whole list is
set; a type that already has tickets can only be deactivated, an event with tickets only deactivated, not deleted). Public JSON:
`GET /api/public/ticket-events/:slug` and `POST /api/public/ticket-events/:slug/order` `{name, email, items: [{type_id, qty}]}` →
`{status, order_url, pay_url, tickets}`. MCP: `ghl_ticket_sales` (read: sales per type), `ghl_ticket_event_save` (create or change
an event with its types) and `ghl_event_ticket_checkin`. Trigger `tickets.ordered` fires when an order is confirmed. GDPR: orders
are part of the contact export; erasing a contact removes name and e-mail from its orders and keeps the counts.

## AI books appointments

The KI-Telefonagent's booking logic – free times from the calendar's own rules (hours, buffers, notice, limits, Google/Outlook
busy times, round robin / collective / seats of team calendars) and booking a free slot through the normal pipeline – is shared:

- **Website chat bot of the [KI-Assistent](ai-assistant.md#termine-buchen):** *KI-Assistent → Live-Chat-Bot → Termine buchen*
  switches it on. The bot gets the free times of the next two weeks, can look up a day and books once the visitor confirmed a
  time and gave name and e-mail (or phone). Its answer carries the confirmation.
- **Agents' auto-replies in every inbox channel** (e-mail, SMS, website chat, WhatsApp, Messenger, Instagram) and the agent chat:
  the agent's safety level **"Termin buchen"** ([agent.md](agent.md#safety-model)) lets it look up free times and book a free
  slot without a click – also after reading the customer's message – while every other change still asks. The reply itself
  stays a draft unless the agent is *Autonom*; "Autonom" agents may book in auto-replies too.
- **MCP / API:** `ghl_booking_slots`, `ghl_book_appointment`; `GET /api/ai-booking/slots?calendar_id&date&days`, `POST
  /api/ai-booking/book` `{calendar_id, contact_id, date, time, notes?, channel?, confirm?}`.

**Which calendars.** *KI-Assistent → Termine buchen → Kalender* (`GET/PUT /api/ai-booking/settings` `{chat_bot, calendars,
per_contact_day}`, settings area): all active calendars or a chosen few. Paid calendars and calendars with required questions
are never booked by the AI – those need the booking page. At most `per_contact_day` (default 2, up to 10) AI bookings per
contact in 24 hours and 30 per sub-account and hour; a calendar id the AI made up is refused, not swapped for another one.

**The confirmation** goes to the contact in the channel they last wrote in (chat bot: inside its answer) and always carries two
links: **Verschieben** – `/book/move/<token>`, the appointment page with the picker of free times open, for every calendar
(customers reschedule by the calendar's cutoff) – and **Absagen** – `/book/manage/<token>`. The calendar's own confirmation
e-mail and reminders go out as for any booking. Appointments booked this way have the source *KI-Assistent*, *KI-Agent*,
*KI-Buchung* (API) or *KI-Telefonagent*.
