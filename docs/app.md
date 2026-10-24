**English** · [Deutsch](app.de.md)

# Installing the app & push notifications

Two ways onto your phone: the installable web app (below) or the native [Android app](#android-app).

The interface is an installable web app (PWA): its own icon on the home screen or in the start menu, its own window without a browser bar, it starts offline too (with the data loaded last), and it reports news to your device by push.

## Installing

- **Chrome / Edge (Windows, Mac, Linux, Android):** “Install app” appears at the bottom – or use the install icon on the right of the address bar. There is also a button under **Settings → My account** as long as the browser offers it.
- **iPhone / iPad:** In Safari, tap *Share* → **“Add to Home Screen”**. On iOS, push works from 16.4 and only in the app installed this way.

Name, color and icon come from the branding (Agency → white label; on a client login domain, the client branding). The icon (blue square with two arrows) comes as `icon.svg` and as PNG in 192/512 px, plus a “maskable” variant.

## Turning on notifications

**Settings → My account → Notifications:** tick “Notifications on this device”, allow the browser prompt, “Send a test notification”. This applies per device; all devices with notifications are listed below and can be removed one by one.

What notifies you (can be turned off, applies to all your devices):

| Kind | When | To whom |
| --- | --- | --- |
| New messages | incoming e-mail, SMS, live chat (at most once every 30 seconds per conversation) | the person assigned to the contact, otherwise everyone with access to the sub-account's conversations |
| Website down / back online | website monitoring in the project profile | everyone with access to the sub-account |
| Tasks | assigned to you (by someone else, by workflow, API or MCP); every morning from 8 o'clock: what is due today | the assigned person |
| Payments and purchases | invoice paid through Stripe, product purchased | everyone with access to invoices |

A click on the notification opens the matching page (and switches to the right sub-account).

## Technical details & operations

- Push needs **HTTPS** (or `localhost`). No third-party services are involved: the app speaks Web Push (VAPID + encrypted messages per RFC 8291) directly with the browsers' push services (Google, Mozilla, Apple, Microsoft).
- The VAPID keys are created on first start and stored in the database (the private part encrypted). A backup contains them – after a move, existing subscriptions keep working.
- Optionally set `PGHL_PUSH_CONTACT=mailto:du@example.com` – the push services receive this contact address (default: the first admin's e-mail address).
- The service worker (`/sw.js`, scope `/app`) caches only the app itself and – for the offline start – the latest API responses of your own account; when you sign out, this cache is deleted. Public pages (booking, forms, invoices, funnels) are left alone. It only keeps files that really are what their name says (never an HTML page under a script name, never an error response), and serves the offline start page only if all the files it needs are in the cache. If the interface does not start, `/boot-guard.js` replaces the blank page after 10 seconds with “The app could not start” (Reload, Clear offline data) – see [Android app](android-app.md#if-the-page-stays-blank-troubleshooting).
- Other modules send their own notifications through `app.services.pushNotify({ locationId | userIds, kind, title, body, url, tag })`.

## Android app

Besides the web app there is a native Android app (package `org.gohigh.android` – your own package ID if you build it yourself –, name and colors from the branding, e.g. “HyperLevel”). It shows the inbox, tasks, appointments, deals, calls, figures and projects of **all** sub-accounts you have access to, brings home screen widgets and reports news as notifications. Everything else it opens as a web view of this interface.

### Installing

- On your phone, open **`https://<your-domain>/android`** (or scan the QR code on that page with the camera) → **Download app** → open `hyperlevel.apk` → for the browser, “Allow apps from this source” → **Install**. If Google Play Protect warns: “More details” → “Install anyway” (the app does not come from the Play Store).
- Sign in to the app with your usual credentials (also with a two-factor code). The app reports updates itself.
- Under **Settings → My account**, the **“App for your phone”** card at the top links to `/android`.

### Pairing & devices

After you sign in to the app, it exchanges its session once for a **device key** (`ghm_…`). It stays only on the phone; the server stores it as a SHA-256 hash and never shows it again. The key is valid only for the app interface (`/api/mobile/*`) and acts as the signed-in user – agency admins see all sub-accounts, client logins only their own and only the areas shared with them; the SaaS plan (hidden areas, paused account = read-only) applies exactly as in the browser.

**Settings → My account → Devices (app)** lists all paired phones (name, app version, last used, IP) with **Sign out**. Devices are also signed out on *Change password*, *Sign out all others*, and when an admin resets the login's password (*Team*) or signs it out everywhere (`POST /api/users/:id/sessions/revoke`). A signed-out device gets `401` and asks for a new sign-in. Every change made from the app appears in the change log with the channel **“App”**; each device is limited to 300 requests per minute.

### Widgets & notifications

- **Widgets** read `GET /api/mobile/summary` (new leads today/7 days, open deals and value, won this month, revenue today/month with a 30-day curve, open invoices, unread conversations, tasks today/overdue, appointments today, missed calls today, stars, websites online/offline, leads of the last 14 days), plus inbox, tasks, appointments, deals, calls, reviews, payments and social posts – each for all sub-accounts or just one. “Today” is the day in the time zone of the respective sub-account.
- **Notifications** are fetched by the app itself through `GET /api/mobile/feed?since=<cursor>` (no push service needed): new incoming messages (at most once every 30 seconds per conversation), missed calls, new leads/contacts, paid invoices, website down/back online, due tasks (at the due time, or at 8 o'clock on the due date, only for the assigned person) and new reviews. The first fetch returns only the cursor – no old notifications. This is stored only if at least one phone is paired, and for 14 days.
- A tap on a notification opens the matching page in the app, e.g. `/app/conversations?c=<id>&loc=<sub-account>`. **`?loc=`** first switches to the sub-account (if you may see it); `?c=` opens a conversation directly.

### Publishing a new app version (agency)

**Settings → My account → Devices (app) → Upload new app version:** choose the signed release APK, enter the version code (`versionCode`, must be at least as high as the current one; the same code replaces the build), version name and “What's new?”. By script this works with an admin sign-in or an agency key (write):

```bash
curl -X PUT https://crm.example.com/api/mobile/app \
  -H "Authorization: Bearer $AGENTUR_KEY" -H 'content-type: application/vnd.android.package-archive' \
  -H 'x-version-code: 4' -H 'x-version-name: 1.1.0' -H "x-changelog: $(printf 'Neue Widgets' | jq -sRr @uri)" \
  --data-binary @app-release.apk
```

The file (up to 200 MB) is stored under `<PGHL_DATA_DIR>/mobile-app/` (the last three versions), and the server computes the SHA-256 checksum. Right after that it is available at `/android`, `/downloads/hyperlevel.apk` (alias `/downloads/gohigh.apk`) and `GET /api/mobile/app` (the app's update check, with `min_supported_code` – older apps then require an update; optionally the header `x-min-supported-code`).

### App Links

`/.well-known/assetlinks.json` confirms to Android that links to this domain may open in the app. The default is the app's release certificate (`51:33:42:92:…:05:DF`) – nothing to do for that. For a different signing key: enter the SHA-256 fingerprint under *Upload new app version* (several, separated by commas), via `PUT /api/agency/mobile-app` `{cert_sha256, package_name, min_supported_code}`, or through the environment variable `PGHL_ANDROID_CERT_SHA256` (applies as long as nothing is entered in the agency). The file must be reachable on every domain whose links the app should open (main address and agency app domain).
