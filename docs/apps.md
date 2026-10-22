# Apps: gray-label app, own-brand apps, push relay

Two ways to put HyperLevel on phones and desktops:

| | Gray-label app | Own-brand app |
| --- | --- | --- |
| Store listing | one neutral app (working name **Hyperdesk**), published under the operator's developer accounts | the agency's own app, name and icon, under the **agency's own** developer accounts |
| Branding | after the login: name, logo and colours of the agency (from *Agentur → Branding*) | built in |
| Server | any instance – found by e-mail address, instance address or QR code | fixed to the agency's instance |
| Push | through the operator's [push relay](#push-relay) (the push keys belong to the operator) | the agency's own FCM/APNs keys (`PGHL_PUSH_MODE=own`) |
| Apple | allowed: one app that many customers sign in to (like HighLevel's "LeadConnector") | required by guideline **4.2.6** for apps made from a template for one client: the client must submit it under their own account |

## Status in this release

Built and tested (`tests/apps.test.ts`): the server side – discovery document, cloud directory, push relay, native push to the
apps (relay or own keys), share endpoint and desktop updates. **Not built yet:** the first-run flow in the Android app, the
`ios/` app shell, the `desktop/` Tauri shell and the CI workflows for them and for own-brand builds. Until then the Android
app works as described in [android-app.md](android-app.md) (fixed server, feed polling).

## Discovery

Every instance answers `GET /.well-known/gohyperlevel-app.json` (public, CORS `*`, cached 5 minutes). On a client's own domain it
carries the client's branding.

```json
{
  "schema": 1, "name": "Muster Agentur", "short_name": "Muster",
  "logo": "https://crm.agentur.de/uploads/logo.png", "logo_dark": "…", "mark": null,
  "icon": "https://crm.agentur.de/pwa/icon/icon-512.png?v=…",
  "colors": { "primary": "#ffcc00", "on_primary": "#000000", "background": "#ffffff", "background_dark": "#0b1220" },
  "api_base": "https://crm.agentur.de", "web_url": "https://crm.agentur.de/app",
  "support_email": "hilfe@agentur.de",
  "push": { "mode": "relay", "content": "generic", "providers": ["fcm", "apns"] }
}
```

The app asks for an e-mail address, an instance address or a QR code (the QR code holds the instance address). For an e-mail
address it asks the operator's directory first and then tries `https://<domain>`, `https://app.<domain>`, `https://crm.<domain>`;
it always reads the well-known file from the instance named in `api_base` before showing the login. The login is the existing
mobile pairing (`POST /api/mobile/pair`, see [android-app.md](android-app.md)).

**Directory** (only on the operator's cloud instance, `PGHL_APP_DIRECTORY=1`):

| Route | Auth | |
| --- | --- | --- |
| `GET /api/app-directory/lookup?email=…` / `?domain=…` / `?code=…` | public, 60/min per address | `{instance_url, name, matched}` or 404; a sub-domain falls back to its parent |
| `GET/POST /api/app-directory`, `DELETE /api/app-directory/:id` | operator admin | entries `{kind: domain\|code, key, instance_url, name}` |
| `POST /api/app-directory/claim` | public, 10/min | `{domain, instance_url}`: needs the DNS TXT record `_gohyperlevel-app.<domain>` = `gohyperlevel-app=<instance_url>` and the instance's well-known file; an operator entry for the domain wins (409) |

## Push

The app sends its FCM (Android) or APNs (iOS) token to its instance: `POST /api/mobile/push-token`
`{provider: "fcm"|"apns", token, app_id}` with the device token `ghm_…` (`DELETE` removes it). From then on every push of the
instance (messages, tasks, payments, websites … – the same events and preferences as web push) also goes to the phones.

| `PGHL_PUSH_MODE` | What happens |
| --- | --- |
| `relay` (default) | through the operator's relay (`PGHL_PUSH_RELAY_URL`, default `https://gohyperlevel.com`); the instance registers itself on the first app token and keeps only opaque handles |
| `own` | straight to Google/Apple with `PGHL_FCM_SERVICE_ACCOUNT` and `PGHL_APNS_KEY`, `PGHL_APNS_KEY_ID`, `PGHL_APNS_TEAM_ID`, `PGHL_APNS_TOPIC` (`PGHL_APNS_SANDBOX=1` for development builds) – for own-brand apps |
| `off` | no native push; the Android app keeps polling its feed |

**Privacy.** By default a push carries **no content**: a generic title („Neue Nachricht“, „Neue Aufgabe“ …), no body, only the app
section (`/app/conversations`, no record ids) and the unread number. The app fetches the details from its own instance. An admin
may switch to short previews (`PATCH /api/agency/app-push {"content": "preview"}`: title ≤ 80, body ≤ 160 characters, plain text).
`GET /api/agency/app-push` shows mode, relay registration and device count; `POST /api/agency/app-push/relay/register` registers again.

## Push relay

On the operator's cloud instance `PGHL_PUSH_RELAY=1` turns on the relay; it holds the gray-label app's FCM/APNs keys (same
variables as above).

| Route | Auth | |
| --- | --- | --- |
| `POST /api/push-relay/instances` | public, 10 per address and hour | `{url, name}` → `{instance_id, token: "ghr_…"}` (stored hashed) |
| `GET /api/push-relay/status`, `DELETE /api/push-relay/instances/me` | `Bearer ghr_…` | own limits and counters; withdraw the own access (all handles die) |
| `POST /api/push-relay/devices`, `DELETE /api/push-relay/devices/:handle` | `Bearer ghr_…` | device token → handle (token stored sealed); a handle works only for the instance that registered it |
| `POST /api/push-relay/send` | `Bearer ghr_…` | `{handles[≤100], kind, title?, body?, url?, badge?, content?}` → result per handle; dead tokens come back as `gone` and are deleted |
| `GET /api/push-relay/admin/instances`, `POST …/:id/revoke` `{reason}`, `POST …/:id/restore`, `PATCH …/:id` `{rate_per_min}` | operator admin | manage instances |

The relay applies the privacy rules again (generic unless the instance sent `content: "preview"`), limits each instance to
`PGHL_PUSH_RELAY_RATE` messages a minute (default 600, per instance changeable) and each device to 30 a minute, and answers
revoked instances with 403 and the reason. Tests use a fake FCM/APNs (`app.services.nativePushTransport`).

## Share

`POST /api/mobile/share` (device token) `{location_id, url?, text?, title?, file?: {name, mime, data (Base64)}}` turns a shared link,
text or file (picture or PDF, ≤ 8 MB) into a task „Geteilt: …“ in the sub-account, the file stored in its uploads. Meant for the
iOS share extension and the Android share target.

## Desktop app

Updates come from the instance, like the signed APK: the admin uploads each platform's signed Tauri update bundle with
`PUT /api/desktop/app` (raw body; headers `x-version`, `x-target` = `windows|darwin|linux`, `x-arch`, `x-signature` = content of the
`.sig` file, optional `x-file-name`, `x-notes`). The app asks `GET /api/desktop/update/<target>/<arch>/<current version>` (204 = up to
date, else Tauri's JSON with `url` and `signature`); `GET /api/desktop/app` lists the newest bundle per platform.

## Store requirements

| | Apple App Store | Google Play |
| --- | --- | --- |
| Account | Apple Developer Program, **99 $/year**; as an **organisation** (needed to publish under a company name) with a **D-U-N-S number** | Google Play Console, **25 $ once**; organisation accounts need a D-U-N-S number as well, new personal accounts must run a closed test (12 testers, 14 days) before production |
| Review notes | a demo login on a demo instance (reviewers must be able to sign in), what the native features are (push, Face ID, share extension, widget – guideline 4.2 "minimum functionality") and that customers are businesses using their own CRM instance | data safety form (what the app stores: login, device token), a demo login, the reason for every sensitive permission |
| Gray-label | allowed as one app for many businesses; the app must work without a specific agency (discovery screen) | allowed |
| Own-brand | the agency must enrol and submit under **its own** account (guideline 4.2.6); the agency gives no third party its Apple ID | the agency's own Play Console account and signing key |
