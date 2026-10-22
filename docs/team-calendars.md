# Team calendars: round robin, collective, classes, questions, payment and video links

Booking calendars (menu **Kalender**) can do more than one person's free time: share bookings across a team, ask questions before the booking, take payment up front and create the video link. Open a calendar with **Bearbeiten**; the tabs **Typ & Team**, **Fragen**, **Zahlung** and **Video & Regeln** hold the new settings. Routing forms are a tab of the calendar page.

A calendar that uses none of this keeps its old booking page and behaviour byte for byte; the team page below is only used when a calendar needs it (a type other than "Einzeln", questions, payment, video or cancellation rules).

## Types

| Type | Behaviour |
| --- | --- |
| **Einzeln** | One calendar, one person or the team as a whole – as before. |
| **Round Robin** | A booking goes to one free person of the team. A time is offered while at least one member is free. |
| **Kollektiv** | Everybody listed must be free at the same time; one appointment, all of them are hosts. |
| **Gruppe / Klasse** | Several participants per start time (capacity), optional waiting list. The listed people lead the class. |

**Round robin** options: *Maximale Verfügbarkeit* offers every time at which someone is free; *Gleichmäßig verteilen* only offers a time while a free person is not more than one booking ahead of the least busy one (per weight). *Verteilung*: equal, or weighted (a member with weight 3 gets about three times as many bookings as one with weight 1). The person with the lowest load (bookings in the last 30 days plus those still held for payment) gets the next booking; ties go to the earlier one in the list.

A member counts as **free** when they have no appointment of their own at that time (on any calendar of the sub-account, as host or as one of the hosts), are not paused or out of office ([availability](team-inbox.md#assignment) – approved absences of the Personal area count too), work at that time (optional own hours per calendar: *Zeiten*), and have no busy time in their connected **Google or Outlook calendar** (the connections under Einstellungen → Mein Konto → Kalender; link them to the booking calendar with **Meinen Kalender verknüpfen**, which also writes the person's own appointments there).

Appointments with a host are written only to the host's connected calendar (a collective appointment to every host's), not to every connected calendar that listens to the booking calendar.

**Buffers** and **minimum notice** are per calendar (Allgemein); the team tab can override the buffers before and after. Held payment slots and class seats are respected by every calendar of the same people.

## Booking page and API

`/book/<slug>` is rendered on the server (the day and time picker is one small inline script, no framework), uses large touch targets, labels every field, announces results to screen readers and fits a phone. Visitors choose a day and time, fill in the contact details and the questions, accept the consent text and book. After booking they get a confirmation with the video link, a calendar file (.ics), and a **management link** to reschedule or cancel (`/book/manage/<token>`). The plain public API (`POST /api/public/calendars/:slug/book`) cannot be used to skip required questions or payment; it answers 400 and points to the booking page.

JSON for your own front end: `GET /api/public/team-calendars/:slug/slots?from=YYYY-MM-DD&days=7` and `POST /api/public/team-calendars/:slug/book`. Staff use `GET /api/team-calendars/:id/slots` and `POST /api/team-calendars/:id/book` (`host_id` picks a person, `payment: "waive"` books a paid calendar without payment, no consent box).

## Questions

Up to 20 per calendar: short text, long text, choice, multiple choice, checkbox; each can be required and carry a help text. Answers are validated on the server (unknown options are refused, nothing unasked is stored), stored with the appointment (`answers`), appended to its notes and available in workflows and e-mails as `{{appointment.answers_text}}`.

**Conditional questions** (*Bedingung*, folded in Einfach-Modus): a question can be asked only when an earlier choice, multiple-choice
or yes/no question got one of the chosen answers – e.g. *„Wie hast du uns gefunden?“* only for *Neukunde: Ja*, *Kennzeichen* only when
*Parkplatz nötig* is ticked. The booking page shows and hides it live; the server applies the same rule: a question that was not
asked is neither required nor stored, whatever is sent. In the API a question takes `show_if: {id, values}` (the earlier question's
id and the answers that show it; yes/no questions use `Ja`/`Nein`); a condition on a later question, a text question or an answer
that does not exist is refused.

## Several meeting lengths

*Video & Regeln → Mehrere Termindauern* (folded in Einfach-Modus): further lengths in minutes (e.g. `60, 90`, up to 6) besides the
calendar's own duration, which stays the first choice. The booking page shows *Dauer* as a choice above the days; the free times are
computed for the chosen length (`GET /api/public/team-calendars/:slug/slots?duration=90`) and the booking takes it (`duration` in
`POST …/book`; any other length is refused). Moving the appointment – by the customer or the team – keeps its length. Not for paid
calendars (one price per calendar) and not for classes; for different prices use a calendar per length, e.g. in a
[service menu](booking.md#service-menu).

## Several appointments at once

*Video & Regeln → Mehrere Termine auf einmal* (folded in Einfach-Modus): **Termine je Buchung** up to 5 (1 = as before). After
picking a time the visitor can choose *Weitere Zeit hinzufügen* and books all chosen times with one form – e.g. a package of three
sessions. Each time is booked through the normal pipeline (questions, consent, hosts, video link, confirmation, workflows – one
confirmation per appointment); if one of them is no longer free, the ones already booked in that request are cancelled again, so it
is **all or none**. Times may not overlap. Unpaid calendars only, not for classes. API: `POST
/api/public/team-calendars/:slug/book-many` with the fields of `…/book` and `starts: [ISO, …]` → `{status, appointments: [{id,
start_at, manageUrl, icsUrl}]}`.

## Guests

*Video & Regeln → Gäste* (folded in Einfach-Modus): **Gäste je Buchung** (0–10, default 0 = off; not for group classes, where every
participant books a seat). The booking page then has a field *Gäste (optional)* for e-mail addresses; the server checks them (valid,
distinct, not the person booking, at most the limit) and refuses guests on calendars without the setting. About **10 minutes** after
the booking – also after a paid hold, and only while the appointment still stands (a booking cancelled right away invites nobody) –
every guest gets an **invitation** in the business's name with a fixed text: calendar, time, place or video link, the calendar file
attached; nothing the person booking typed and no link to manage the booking. Limits against misuse: at most **10 guest addresses per
IP and hour** on the public booking page (then 429 – booking without guests still works) and **50 invitations per sub-account and
hour** (more go out the next hour). Guests are **not made
contacts** – only the person who booked agreed to be stored; they are kept with the appointment by address (`GET
/api/appointments/:id/guests`, `guests` in the appointment list) and exported and erased with a contact of that address. API: `guests:
["a@example.com"]` in `POST /api/public/team-calendars/:slug/book`, `guests_max` in the calendar's team settings.

## Pay at booking (Stripe)

Needs Stripe set up (Einstellungen → Stripe, [stripe.md](stripe.md)) with a **webhook** that includes `checkout.session.completed` and `checkout.session.expired`. Choose *Voller Preis vorab* or *Anzahlung vorab*, the gross price, currency (EUR, CHF, USD, GBP), tax rate (empty = the invoice default), the invoice line, how long the slot is held (at least 30 minutes, a Stripe Checkout limit) and the refund policy.

Flow: the visitor picks a time and fills in the form → the slot (and its host) is **held** and the visitor is sent to Stripe Checkout → **only after the payment** the appointment is created (status confirmed), a **paid invoice** is written (deposit: the invoice covers the deposit, the rest is due on site) and the confirmation goes out. The return page also asks Stripe itself, so the visitor sees the confirmation even if the webhook is late. Unpaid holds expire and release the slot. A payment that arrives after expiry is honoured if the slot is still free, otherwise it is **refunded** automatically and the team is told.

**PayPal, Mollie and gift cards:** with PayPal or Mollie connected, or gift cards in use in the sub-account, the visitor goes to the **pay page** instead of straight to Stripe: they pick the provider and can redeem a gift card (a card that covers the price books the appointment without a provider). The hold, the confirmation and the paid invoice work the same; refunds go back through that provider and onto the card ([payment-providers.md](payment-providers.md#where-buyers-see-the-providers)).

**Cancelling:** the management page cancels within the cutoff (*Absagen bis … Stunden vorher*). With the refund policy *Automatisch* the money goes back through Stripe and the invoice is voided; *Manuell* marks the payment "Erstattung offen" and tells the team (refund in the Stripe dashboard); *Keine* keeps it. Staff can cancel any time from the appointment list (**Absagen…**) and decide on the refund. A failed automatic refund is reported to the team, never to the customer. The **policy text** (Video & Regeln) is shown on the booking page and the management page.

## Video links

Per calendar: none, **Google Meet**, **Zoom**, **Microsoft Teams** or a fixed place or link (the calendar's *Ort / Meeting-Link*).

- *Meet* and *Teams* are created in the **host's** connected Google / Outlook calendar (event with conference data, `conferenceDataVersion=1` / `isOnlineMeeting`), with the same deterministic event id the calendar sync uses, so the sync adopts the event instead of duplicating it. The host needs a connected account with write access (the OAuth app of the self-hoster, see [app.md](app.md) and the calendar tab *Google/Outlook-Sync*). Meet rooms that Google is still creating are asked for again and sent to the customer when ready.
- *Zoom* uses the Zoom connector (Apps → Direct connections) and its meeting step.
- If no link can be made the fixed place stands in and the team is told why. Cancelling or moving an appointment updates or removes the event.

The link is stored as `meeting_url`, shown in the appointment list, the confirmation e-mail (`{{calendar.meeting_location}}` / `{{appointment.meeting_url}}`), the .ics file and the app.

## Rescheduling

The management page offers free times of the same calendar. The host stays when free, otherwise another team member takes over. The reminder is reset, hosts are notified and the event `appointment.rescheduled` fires. Staff reschedule from the appointment list (**Verschieben**). The switches *online absagen / verschieben* and the cutoffs apply to customers only.

## Classes and the waiting list

A class start shows its free seats; a full start is no longer offered. With **Warteliste** a visitor can queue for a full start. When a seat frees up (cancellation, expired payment hold) the first person on the list gets an e-mail with a link that books the seat for 24 hours – first to book wins. On paid classes that link leads through the payment first; the entry is "booked" when the money arrives.

## Routing forms

**Kalender → Routing-Formulare:** a page `/book/r/<slug>` asks one question ("Wobei können wir helfen?") with up to 12 answers; each answer leads to a calendar. The chosen answer is stored with the appointment (`answers`, label = the question) so the team sees why somebody booked. Use the link on your website, or embed it with `?embed=1`.

## Workflows, reports, MCP, app

- Triggers (`appointment.booked`, `appointment.rescheduled`, `appointment.status_changed`, reminders) keep working. The appointment in the payload now has `assignee_id`, `assignee_name`, `hosts`, `meeting_url`, `answers` and `payment` – "assign the follow-up to the host" is a one-liner with the round-robin result.
- E-mail variables: `{{appointment.host_name}}`, `{{appointment.host_names}}`, `{{appointment.meeting_url}}`, `{{appointment.answers_text}}`.
- MCP: `ghl_calendar_types` (calendars with type, team, questions, price, video; with `calendar_id` also the free times and their hosts) and `ghl_book_slot` (book for a contact; round robin picks the host, `host_id` overrides, `payment: "waive"` on request; paid calendars return a Stripe link instead of a booking).
- App: the appointment list returns `meeting_url` (the video link first) and `host_id`; see [api.md](api.md#team-inbox-and-team-calendars).
- GDPR: held bookings and waiting-list entries are exported and erased with the contact; invoices follow the usual retention rules.
- Security: all management routes need the calendars area and stay inside the sub-account; the public routes validate every input, are rate limited and escape everything they print.

## Self-hosting checklist

1. **Stripe key and webhook** (for payment): events `checkout.session.completed` and `checkout.session.expired` on `https://<your host>/hooks/stripe/<sub-account id>` (shown in Einstellungen → Stripe).
2. **Google / Microsoft OAuth app** (for Meet, Teams and busy times): configured once for the instance; every host connects their account (Einstellungen → Mein Konto). Google needs the Calendar API enabled and the `calendar.events` scope; Microsoft `Calendars.ReadWrite`.
3. **Zoom** (optional): the Zoom connector under Apps.
4. Nothing else: no new services, packages or environment variables. The scheduler (every 15 seconds) releases expired holds, offers freed class seats and fetches Meet links that were still pending.
