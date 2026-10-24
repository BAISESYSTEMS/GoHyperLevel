# Demo mode

Run a public "try it out" instance of HyperLevel – like the demo link in the README – without risking spam,
charges or leaked data.

```bash
# empty data folder!
PGHL_DEMO_MODE=1 PGHL_BASE_URL=https://demo.your-domain.com docker compose --profile caddy up -d
```

or set `PGHL_DEMO_MODE=1` in `.env`. What happens:

| | |
| --- | --- |
| **Demo data** | On the first start the empty database is filled with fictional data that shows several companies at once: the agency **Nordlicht Digital** (its own sub-account and the agency view) and five client sub-accounts that log in under the agency's name (white-label example) – the physiotherapy practice *Praxis Sonnenweg*, the electrician *Elektro Meyer*, the online coach *FitWerk Coaching* (course, community, webinar, affiliates), the SaaS start-up *Taktwerk Software* (built on the HQ template) and the coffee roastery *Rösterei Hafenbohne* with its online store. Each has ~30 contacts and companies with coloured tags, custom fields and custom values, saved lists, deals in every pipeline stage with quotes, tasks and coloured/pinned notes, appointments over the past and next four weeks plus a weekly series, inbox threads over e-mail, SMS and WhatsApp with internal notes, campaigns, workflows from every recipe (one with a paused step and a note on the canvas), a website with blog, a funnel, a form with entries, invoices (draft/sent/overdue/paid, an XRechnung with Leitweg-ID) and offers, reviews from several platforms, tickets and help-center articles, contracts and report dashboards whose numbers reach back 90 days. Where a business needs it: call scripts, projects with a Gantt chart and time entries, Office documents, store orders and gift cards, a custom object and a lead-scoring model. Names are invented, e-mail addresses use `example.com/.org/.net` or `.example`, phone numbers the test range `+49 30 1234 xxx`. Social posts are not seeded – the planner reads them from Postiz, an outside service. |
| **Banner** | Every page shows "Demo – Daten werden täglich zurückgesetzt". |
| **Demo login** | Nobody has to log in: `/demo` (the link the landing page uses) signs the visitor in and opens the app (`/demo?next=/app/…` opens a page inside the app; other targets are ignored), and the login page opens the demo by itself too. Whoever signs out gets the login page with the credentials and a one-click **Demo öffnen** button for the rest of that tab (no password typing, and strangers' wrong guesses can't lock the demo account). Default `demo@example.com` / `demo1234` (`PGHL_DEMO_EMAIL`, `PGHL_DEMO_PASSWORD`). |
| **Regular reset** | After each reset hour – `PGHL_DEMO_RESET_HOURS` (e.g. `3,11,19` for three times a day), else `PGHL_DEMO_RESET_HOUR` (default 3), in `PGHL_TIMEZONE` (default Europe/Berlin) – all data and uploads are wiped and the demo is seeded again. Visitors are signed out. |
| **Nothing leaves the server** | Every outgoing TCP connection and DNS lookup to anything but loopback is refused inside the process (`server/services/outbound-guard.ts`): e-mail (SMTP), SMS (Twilio/gateway), WhatsApp/Messenger/Instagram, social posts, Stripe, AI providers, webhooks, REST hooks, web push, calendar and mailbox sync, uptime checks. Attempts are only logged (`[demo] Verbindung nach außen blockiert: host:port`, and `GET /api/demo/outbox` for admins). E-mail and SMS to contacts show up as "gespeichert" (stored) in the conversations. |
| **Locked settings** | Writes that would lock other visitors out or configure real providers answer 403 "Im Demo-Modus nicht verfügbar": password/2FA/user changes, deleting sub-accounts, API keys, webhooks/REST hooks, e-mail/SMS provider settings, Stripe, telephony, AI keys, Google/Meta/ads accounts, agency integrations, imports, backups, push. Normal CRM work (contacts, deals, workflows, pages …) is allowed. |
| **No sign-ups** | Nobody can create an account: new logins (`/api/users`) and the SaaS sign-up settings are locked, the SaaS sign-up page `/signup` stays closed, and the cloud sign-up would need a confirmation e-mail that cannot leave the server. Visitors use the shared demo login. |
| **No own domains** | Connecting a domain to a website, a client login or a help centre is refused – otherwise a visitor could point a domain of theirs at the demo and the reverse proxy would fetch a certificate for it. |
| **Public pages are marked** | Every public page (websites, forms, booking, help centre …) starts with the note "Demo-Instanz: Alle Daten werden mehrmals täglich gelöscht. Bitte hier keine echten Daten oder Passwörter eingeben." and is sent with `X-Robots-Tag: noindex, nofollow` – a page built in the demo cannot pass for a real one or end up in search engines. |
| **Public pages only inside the demo** | Those pages are shown only to a visitor with a live demo session. Anyone else – e.g. someone who got a link to a demo page – sees a neutral notice ("Diese Seite gehört zur öffentlichen HyperLevel-Demo …", 403) with a link to open the demo. So nobody can use the demo to host a phishing page under its domain. |
| **Product name** | `PGHL_DEMO_BRAND` (e.g. `HyperLevel`) names the demo: "HyperLevel Demo" with the HyperLevel icon in the menu, "HyperLevel – Live-Demo" on the login page. It is part of the seed, so it survives every reset. |

**Safety:** demo mode never wipes a database that has users but was not created by demo mode – it logs an
error and leaves the data alone. Use a fresh data folder (or volume) for a demo instance. Turn off the daily
backups there (`PGHL_BACKUPS=0`) – there is nothing worth keeping.

## Running demo.gohyperlevel.com

The public demo linked from the landing page ([landing.md](landing.md)) is its own small instance – never the production
or cloud instance, never their data folder.

1. **DNS:** `demo.gohyperlevel.com  A  <server IP>` (and `AAAA` if the server has IPv6). No wildcard: the demo serves
   no customer domains.
2. **A folder of its own** with the repository (or just `docker-compose.yml` and `.env`) and an **empty** data volume:

   ```bash
   mkdir -p /srv/ghyl-demo && cd /srv/ghyl-demo
   git clone https://github.com/BAISESYSTEMS/GoHyperLevel.git . && cp .env.example .env
   ```

3. **`.env`** – only these:

   ```bash
   PGHL_DEMO_MODE=1
   PGHL_BASE_URL=https://demo.gohyperlevel.com
   PGHL_DOMAIN=demo.gohyperlevel.com     # Caddy fetches the certificate
   PGHL_DEMO_BRAND=HyperLevel
   PGHL_DEMO_RESET_HOURS=3,11,19         # reset after 03:00, 11:00 and 19:00 …
   PGHL_TIMEZONE=Europe/Berlin           # … Berlin time
   PGHL_BACKUPS=0                        # nothing worth keeping
   ```

   Do **not** set `PGHL_CLOUD_MODE`, `PGHL_LANDING`, Stripe, SMTP, Twilio or AI keys there: they would be blocked anyway,
   and a demo must not look as if it could send.
4. **Start** under its own compose project name, so it never touches another instance's containers or volumes:

   ```bash
   docker compose -p ghyl-demo --profile caddy up -d
   ```

   If the server already runs a reverse proxy for the production instance, leave out `--profile caddy` and route
   `demo.gohyperlevel.com` to this container's port instead (see [deploy](deploy/README.md)).
5. **Check** after the first start (the seed takes a few seconds): `https://demo.gohyperlevel.com/demo` lands in the
   app, after signing out the login page shows "Demo öffnen" and the credentials, every page the banner, `GET /api/version` → `demo.enabled: true`; as the demo admin, `GET /api/demo/outbox`
   lists the connections that were blocked. The next morning `demo.last_reset` has moved on.
6. **Updates:** `git pull && docker compose -p ghyl-demo up -d --build` – the demo data is re-seeded at the next reset
   anyway. Uptime monitoring may call `/healthz`.

## Demo data without demo mode

For screenshots or local exploration you can seed an empty folder once and run it like a normal install:

```bash
npm run demo:seed -- --data-dir ./demo-data     # refuses a folder that has real data
PGHL_DATA_DIR=./demo-data npm start             # login: demo@example.com / demo1234
npm run demo:seed -- --data-dir ./demo-data --reset   # wipe and seed again (only demo folders)
```

The seed itself also runs with outgoing connections blocked. `npm run screenshots` uses it to render the
README images with headless Chromium.

## How it is built (for contributors)

- `server/services/demo-seed.ts` creates everything through the app's own routes in-process (`callRoute`
  as the demo admin), so the data always matches what the screens create; it yields to the event loop
  between steps, so a running server keeps answering during a reset. The companies are data in
  `server/services/demo-seed-data.ts`, the showcases per business (quotes, XRechnung, series, WhatsApp, paused
  workflow step, review platforms, call scripts, projects, Office, webinar, store, course) in
  `server/services/demo-seed-extras.ts`; only store orders and WhatsApp messages – which would need a payment or an
  outside service – are written directly. The content is deterministic (seeded random numbers, dates relative to
  today), the run takes a few seconds and calls no outside API; a database that already holds the demo is not
  seeded twice.
- In the demo the banner offers **Geführte Tour starten** and the start page the Academy welcome card
  ([academy.md](academy.md#getting-started)).
- `server/modules/demo.ts` registers the guard (`app.guards`, including the domain rule), the nightly reset
  (`app.onTick`), the demo login, the note and `noindex` on public pages (`app.services.htmlTransforms`) and
  `app.services.demo` (`info`, `reset`, `blocked`).
- `GET /api/version` returns `demo: { enabled, login, reset_hour, timezone, last_reset }`; the web app shows
  the banner (`web/src/demo.tsx`).
- Tests: `tests/demo.test.ts` checks the seed, the write rules (domains included), closed sign-ups, the note on public
  pages, the nightly reset, the safety rule and that no connection to a non-loopback host ever reaches the network (a spy
  behind the guard).
