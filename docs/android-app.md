**English** · [Deutsch](android-app.de.md)

# Android app “HyperLevel”

A native app for Android 8 (API 26) and newer. It shows the complete web app and puts everything important on the
home screen: 13 widgets, quick actions as small dialogs, notifications without Google services, and updates
straight from your own server. Developer info: [android/README.md](../android/README.md).

## Installing

1. On your phone, open `https://crm.example.com/android` (download page with a QR code) and download the APK.
2. Android asks once for “Install apps from this source” – allow it for the browser.
3. Open HyperLevel and sign in as usual. The app then connects by itself (the device appears under
   **Settings → My account → Devices (app)**) and asks for permission to send notifications.

The admin uploads new versions (`PUT /api/mobile/app`, see the API docs). The app checks daily and at startup,
shows “Update available”, downloads the APK, verifies the SHA-256 checksum and starts the installation. The first
time, you allow HyperLevel to “Install apps from this source”.

## The app

- **Web app in full screen** (`/app`): the login stays saved, file upload, downloads (exports too), microphone for
  the browser phone and the microphone button of the AI agent (Settings → Voice, [docs/voice.md](voice.md): the app asks for the permission the first time, playback without an extra tap), external links in a browser tab, the back button goes back.
- **Links** to `https://crm.example.com/app/…` (e-mails, chat) open directly in the app (App Links).
- **Quick menu** (round button at the bottom left): task, contact, note, voice note, call, reload, share link,
  report a bug, app settings. Long-press the app icon: New task, Voice note, New contact,
  Inbox, Report a bug.
- **App settings**: account and devices (sign out other devices), notifications by kind, widget refresh
  (15 min to 2 h), default project for new entries, Material You colors, Help & feedback, **Diagnostics**, version,
  update check, sign out. Tapping “Version” seven times unlocks developer options (server address, demo data).

## Reporting bugs & the wish list

Since version 1.0.1. The same tickets as in the web app (see [Bug reports & wishes](bug-reports.md)).

- **Report a bug**: in the quick menu, under **App settings → Help & feedback**, by long-pressing the app icon
  or – if turned on – by shaking the phone (“Shake to report”, off by default). Beforehand the app takes a
  screenshot of the current screen (the web view too); the form shows it as a preview (✕ removes it,
  “Choose image” picks an image from the gallery instead).
- **Form**: bug, improvement wish or question; what happened, what you expected, steps, how bad it is.
  Sent along – visible and removable one by one – are the device and Android version, the app version, the current page
  and the last 20 failed requests of the app (method, path, status, error text – never contents or keys).
  After sending, the app shows the ticket number.
- **Reports**: your own reports with status and unread replies; a tap opens the report in the web app
  (reply, add info, reopen).
- **Wish list**: all wishes by votes, new or status; the thumb votes (tapping again takes the vote
  back), “+ Wish” submits a new wish. The names of other users are not visible.
- **Crashes**: if the app crashes, it sends the error message and stack trace to
  `/api/mobile/client-errors` on the next start. The server keeps them only if “Report errors automatically” is on for the user.

## If the page stays blank (troubleshooting)

Since version 1.0.3 the app uses the whole screen: the web view extends under the camera cutout and the navigation bar, and the page keeps its content clear of them with `--sal`/`--sar`/`--sab`. Since version 1.0.2 the screen never stays silently blank. The app itself checks whether the web interface has started and
says so if not.

**“The page is not loading”** (a native screen over the web view) appears when
- the page was loaded but shows nothing after about 6 seconds (the web app has not started),
- the web app itself reports “The app could not start”,
- a page is still not finished loading after 30 seconds,
- the server answers with an error (e.g. 502 while the server restarts); with a certificate error (phone date/time
  wrong, foreign Wi-Fi), “No connection” appears instead, with the reason,
- the display's web process fails a second time within a minute (the first time, the app simply reloads the page
  with a new web view; the reason is shown on the screen).

The screen names the reason, the **latest errors** (console errors of the page, failed requests, checks)
and the **WebView version**. If the page does load after all, the screen disappears by itself. Four buttons:

| Button | What happens |
| --- | --- |
| Reload | reloads the page – or the start page if there is no page to reload |
| Clear cache & offline data | empties the cache, web storage and service worker of the web view (the sign-in stays) and reloads |
| Open in browser | opens the page in a browser tab – if it runs there, the problem is the phone's WebView |
| Send diagnostics | sends device, app and WebView version, status and latest errors to the team as a bug report (“Bug reports & wishes”, severity high); if the app is not connected, “Share” opens instead |

**Outdated WebView.** The web interface is built for Chrome/WebView **92 or newer** (2021). If the installed
version is older, the screen shows a note with a button to the Play Store page of
“Android System WebView” (or Chrome, depending on which one provides the web view). On phones without a Play Store
(e.g. GrapheneOS, LineageOS), the WebView comes with the system updates or from the phone's own app store.

**Settings → Diagnostics** shows the same at any time: WebView (package and version, red if too old), server,
status of the last start (“Loaded · 3 min ago” or the reason for the error) and the latest errors. The status
stays visible even after the app restarts. “Send diagnostics” as above. **Reset app (web data)**
deletes the cache, offline data and the sign-in in the web view (sign in there again afterwards; widgets and
notifications stay connected, data on the server stays) and reloads the start page.

**In the browser too:** if the web app does not start there (nothing rendered after 10 seconds, e.g. because a file is missing
or the browser is too old), a simple page replaces the blank one: “The app could not start” with the
error text, **Reload** and **Clear offline data** (unregisters the service worker, deletes caches). If a
service worker is running on the blank page, it first cleans up once by itself and reloads. The collected errors go
– if the user has allowed automatic error reports – as a ticket “[Browser] App start failed …” to
the team (see [Bug reports & wishes](bug-reports.md)). Users who are signed out send nothing; then “Send diagnostics”
in the app or a look at Settings → Diagnostics helps.

**What else the app repairs by itself:** If Android restores the app in the background after it was closed and the
saved web state is empty or unusable, the app loads the start page. “Reload” in the quick menu works
even without a loaded page.

**For admins – shipping a new version:** with `x-min-supported-code` (see below) you can force older versions
to update. If the app is blank but starts, it offers the update on opening (dialog), even over the blank screen.

## Widgets

Long-press the home screen → Widgets → HyperLevel. When adding one, you choose the project (“All projects”
or one sub-account) and, depending on the widget, further options; you can change them later via “Edit widget”. Widgets show
the data loaded last right away (“3 min ago”), refresh in the background, after every action, when the app
opens and with the ↻ button.

| Widget | Sizes | What it does |
| --- | --- | --- |
| Cockpit | 2×2 – 5×3 | New leads today, open deals €, revenue this month, unread, tasks due, appointments, revenue curve 30 days |
| Inbox | 3×2 – 5×4 | Latest conversations with channel icon and unread dot; a tap opens the conversation, ↩ replies directly (channel selectable). Option: unread only |
| Tasks | 2×2 – 5×4 | Today & overdue (or week / all open) with real checkmarks; “+” creates a task (due date, project, dictation) |
| Appointments | 3×2 – 5×3 | Today and tomorrow; tap: call, navigate, open meeting, confirm, showed up/no-show, cancel |
| Pipeline | 4×2 – 5×3 | Stages with count and value, top deals; tap: change stage, won/lost |
| Projects | 3×2 – 5×4 | All projects with website status (green/red), open tasks, unread messages |
| Quick actions | 4×1, 2×2, 4×2 | Contact, task, note, call, voice note, invoice, inbox – selection adjustable |
| Revenue | 2×2 – 4×2 | Month, today, open invoices (overdue), curve |
| Calls | 3×2 – 5×3 | Missed calls with voicemail note and call back (phone or through HyperLevel/Twilio) |
| Reviews | 2×2 – 4×2 | Stars, count, 30-day change, new reviews, latest review |
| Voice note | 1×1, 2×1 | One tap, speak – becomes a task (with due date) or a note on the contact you name |
| Number | 1×1, 2×1 | One key figure of your choice with a trend arrow (e.g. leads today, revenue this month, unread) |
| Social | 3×2 – 4×3 | Next scheduled posts with time and channels |

When signed out, widgets show “Sign in to HyperLevel”; after a revocation (password change, “Sign out all”, device
removed), “Sign in again” – a tap opens the app; if the web login is still valid, it reconnects immediately.

## Notifications

The app polls `/api/mobile/feed` on every background refresh (every 15 minutes by default; Android may
stretch this in battery saver mode) and shows new events as a notification – without Firebase. Channels: messages,
team chat (direct messages and mentions), calls, leads, payments, websites, tasks, reviews, My reports (replies and status changes on
your own reports and wishes) – each kind can be turned off in the app settings, sounds in
the system settings. A tap opens the matching page in the right sub-account. The first fetch brings no
old notifications.

## Privacy & security

- Login only on your own server; the app exchanges the sign-in once for a device key (`ghm_…`),
  which is valid only for `/api/mobile/*`, is stored encrypted in the Android Keystore and is not included in backups.
- “Sign out” in the app revokes the key on the server and deletes login cookies and cached data.
- Updates only over HTTPS and only with a matching SHA-256 checksum; Android additionally verifies the signature.

## For admins

- **App Links**: the server serves `/.well-known/assetlinks.json` for the package ID of your build (default
  `org.gohigh.android`, otherwise `PGHL_ANDROID_PACKAGE` or the agency setting) with the SHA-256 of your
  signing certificate (`PGHL_ANDROID_CERT_SHA256` or *Agency → Android app*). Without a fingerprint the file stays
  empty and links open in the browser. For your own build, see [android/README.md](../android/README.md).
- **Upload an APK**: `PUT /api/mobile/app` with `x-version-code`, `x-version-name`, `x-changelog`, optionally
  `x-min-supported-code` (older versions then have to update).
- The background refresh fetches only what placed widgets need (identical requests are merged).

## Public APK for everyone

The project's home page ([landing.md](landing.md)) offers the APK from gohyperlevel.com for download: a button to
`/downloads/hyperlevel.apk` (formerly `gohigh.apk`, kept as an alias) with the version, size and SHA-256 of the most recently uploaded file, a QR code to the `/android` page,
and instructions for “Allow apps from this source”. Download, checksum and self-update are the existing routes (see
above) – the only new thing is the spot on the home page.

**What is missing today:** (Server side for the gray-label app with server search, native push through the relay and branding after login: [apps.md](apps.md).) On first start the app does **not** ask for the server. It uses the
address entered at build time (`-PgohighBaseUrl` or `GOHIGH_BASE_URL`, `https://crm.example.com` if not given); it can only be changed
through the developer options (tap “Version” seven times). An APK that really works for everyone needs a
start screen with two paths – “HyperLevel Cloud” (the built-in address) or “Own server” (enter the address,
the app checks `GET /api/version` and stores it in `AppSettings.baseUrl`) – and a note that App Links only work for the
built-in domain (`/.well-known/assetlinks.json` names the certificate of this build). Until that exists:

- offer an APK on gohyperlevel.com that is built with the **cloud address** (it connects to the cloud),
- self-hosters download the APK of their own instance at `/android` (where the admin uploads their own build) or
  build it with their address,
- agencies build their branded APK themselves (own package ID, name and icon in the source code, own signing key).

The fix “outgoing calls show the number called” (commit `f2781b2`) is in the source code under `android/` and
reaches the APK with the next build.

**Building and shipping** (Android SDK 36, JDK 17 or newer; never check in the signing file):

```bash
cd android
export ANDROID_HOME=/path/to/android-sdk
export GOHIGH_BASE_URL=https://<cloud-address>          # the address the public APK connects to
export GOHIGH_APPLICATION_ID=<package-id>               # e.g. com.gohyperlevel.app – must match PGHL_ANDROID_PACKAGE
# raise versionCode/versionName in app/build.gradle.kts (today 4 / 1.0.3)
./gradlew test lintDebug
./gradlew assembleRelease -PsigningProps=/safe/place/signing.properties
$ANDROID_HOME/build-tools/36.0.0/apksigner verify --print-certs app/build/outputs/apk/release/app-release.apk
sha256sum app/build/outputs/apk/release/app-release.apk

# upload (agency key with write access, or signed in as admin)
curl -X PUT https://gohyperlevel.com/api/mobile/app \
  -H "Authorization: Bearer pghla_…" -H "content-type: application/vnd.android.package-archive" \
  -H "x-version-code: 4" -H "x-version-name: 1.0.3" -H "x-changelog: Ausgehende%20Anrufe%20zeigen%20die%20Nummer" \
  --data-binary @app/build/outputs/apk/release/app-release.apk
```

Then set `PGHL_ANDROID_PACKAGE` and `PGHL_ANDROID_CERT_SHA256` (fingerprint from `apksigner`) so that App Links
work, and check on the home page that the version, size and checksum are right.
