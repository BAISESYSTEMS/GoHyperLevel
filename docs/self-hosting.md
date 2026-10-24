**English** · [Deutsch](self-hosting.de.md)

# Self-hosting

> Step-by-step guides for every way to run HyperLevel (Docker, Coolify, Railway/Render, Hostinger, plain Node): [docs/deploy/](deploy/README.md). Every variable with an explanation: [`.env.example`](../.env.example).

## Environment

All variables are optional except `PGHL_BASE_URL`; much of it can also be set in the interface (values saved there usually win, the variable then acts as the default). The same variables with comments to copy: [`.env.example`](../.env.example). `tests/docs.test.ts` checks that every `PGHL_*` variable the server code reads is listed here.

### Basics

| Variable | Meaning |
| --- | --- |
| `PGHL_BASE_URL` | Public address for links in e-mails (booking, invoice, unsubscribe). **Set it.** |
| `PGHL_DOMAIN` | Domain for the bundled Caddy (`docker compose --profile caddy`) and the Traefik example; set by `scripts/install.sh` |
| `PGHL_TIMEZONE` | Time zone of the first sub-account and of the demo reset (default `Europe/Berlin`) |
| `PGHL_DATA_DIR` | Database, uploads, keys (default `./data`, `/data` in the container) |
| `PORT`, `PGHL_PORT` | Port (default 4700) |
| `PGHL_HOST`, `PGHL_WEB_DIR` | Listen address (default `127.0.0.1`, `0.0.0.0` with `PGHL_BEHIND_PROXY=1`) and folder of the built interface (default `./dist-web`) |
| `PGHL_BEHIND_PROXY=1` | Listen on `0.0.0.0` and trust `X-Forwarded-For` (behind Traefik/Caddy) |
| `PGHL_PROXY_HOPS` | How many proxies append to `X-Forwarded-For` (default 1; e.g. 2 with Cloudflare in front of Traefik). The visitor's address is the entry your own proxy appended – never one the browser sent |
| `PGHL_TICK_MS` | Clock for waits, reminders, scheduled campaigns and syncs (default 15000; `0` = off) |
| `PGHL_VERSION`, `PGHL_BUILD` | For image builders only: the version that error reports name (default: `version` from `package.json`), and a build id appended as `+<build>` ([docs/bug-reports.md](bug-reports.md)) |

### First start

| Variable | Meaning |
| --- | --- |
| `PGHL_ADMIN_EMAIL`, `PGHL_ADMIN_PASSWORD` | Creates the admin on the first start (otherwise setup happens in the browser; the password needs at least 8 characters) |
| `PGHL_ADMIN_NAME` | Display name of that admin (default: the e-mail address) |
| `PGHL_COMPANY_NAME` | Name of the first sub-account (default “Meine Firma”) |

### Keys and security

| Variable | Meaning |
| --- | --- |
| `PGHL_SECRET` | Optional: a fixed signing secret instead of `data/secret` (unsubscribe, survey and tracking links; also encrypts stored credentials when there is no data key) – never change it later |
| `PGHL_DATA_KEY`, `PGHL_DATA_KEY_PREVIOUS` | Optional: key for stored credentials (64 hex characters) and earlier keys (comma-separated). Default: `data/data.key` (created by `npm run rotate-secret`), otherwise derived from `data/secret` |
| `PGHL_ALLOW_PRIVATE_FETCH=1` | For LAN-only installations: allows outgoing requests (webhooks, iCal, SMS gateway, SSO providers only reachable inside the Docker network such as `http://keycloak:8080`) to internal addresses – blocked otherwise (SSRF protection) |
| `PGHL_AUTH_BREAK_GLASS=1` | Emergency access: admins may sign in with a password again despite required SSO, disabled password sign-in or required 2FA – set it only temporarily ([docs/auth.md](auth.md#policies)) |
| `PGHL_PLUGIN_NETNS=off` | Werkstatt/plugins: turns off the separate network namespace for plugin scripts ([docs/werkstatt.md](werkstatt.md#configuration)) |
| `PGHL_PLUGIN_SIGNING_KEY`, `PGHL_PLUGIN_SIGNING_KEY_ID`, `PGHL_PLUGIN_TRUSTED_KEYS` | Werkstatt/plugins: signing key (PKCS#8 PEM) and id this installation signs its plugin exports with and trusts itself, plus further trusted publishers as JSON ([docs/werkstatt.md](werkstatt.md#configuration)) |

### Operations, backup and performance

| Variable | Meaning |
| --- | --- |
| `PGHL_BACKUPS=0` | Turns off the automatic daily backup to `data/backups/` |
| `PGHL_BACKUP_KEEP` | How many daily backups to keep (default 14) |
| `PGHL_BACKUP_S3_ENDPOINT`, `PGHL_BACKUP_S3_BUCKET`, `PGHL_BACKUP_S3_ACCESS_KEY`, `PGHL_BACKUP_S3_SECRET_KEY`, `PGHL_BACKUP_KEY` | **Off-site backup**: hourly and encrypted (AES-256-GCM) to S3-compatible storage (Hetzner, Backblaze, Hostinger, R2, MinIO) – database and upload folder, a monthly restore test, restore with `npm run backup:restore`. Keep the key (`openssl rand -hex 32`) safe somewhere else – without it the backups are worthless ([docs/backups.md](backups.md)) |
| `PGHL_BACKUP_S3_REGION`, `PGHL_BACKUP_S3_PREFIX`, `PGHL_BACKUP_S3_PATH_STYLE` | Off-site backup: region (default `us-east-1`), folder in the bucket, path style (`1` default, `0` = bucket as a subdomain) |
| `PGHL_BACKUP_KEY_PREVIOUS` | Earlier backup keys, comma-separated – only to read older backups after a key change |
| `PGHL_BACKUP_INTERVAL_MIN`, `PGHL_BACKUP_RETENTION`, `PGHL_BACKUP_FILES`, `PGHL_BACKUP_PING_URL` | Off-site backup: interval in minutes (default 60), retention hourly/daily/monthly (default `48,14,6`), `0` = without the upload folder, a ping address after every backup (e.g. healthchecks.io; `/fail` on errors) |
| `PGHL_ALERT_EMAIL`, `PGHL_ALERT_WEBHOOK`, `PGHL_ALERT_PUSH` | Alerts on low disk space, a stale backup, stuck background jobs and many server errors: recipients (default all admins), a webhook for ntfy, Slack, Discord, Telegram or JSON, `0` = no push to admins ([docs/backups.md](backups.md#uptime-and-alerts)) |
| `PGHL_STATUS_PAGE` | Public status page `/status` with 90 days of uptime and incidents: `1` = on, `0` = off (default: on in cloud mode) – [docs/backups.md](backups.md#status-page) |
| `PGHL_SLOW_REQUEST_MS`, `PGHL_SLOW_QUERY_MS`, `PGHL_SQLITE_CACHE_MB`, `PGHL_SQLITE_MMAP_MB`, `PGHL_RESULT_CACHE` | Performance: threshold for the slow-request log (default 300 ms), query timing (off), SQLite cache (32 MB) and mmap (256 MB), read cache off (`0`) – shown under *Agency → System*, server sizing in [docs/performance.md](performance.md) |
| `PGHL_DEMO_MODE=1` | Public demo: fictional data in an **empty** data folder, regular resets (`PGHL_DEMO_RESET_HOURS`, e.g. `3,11,19`, else `PGHL_DEMO_RESET_HOUR`, default 3 o'clock), public pages only visible inside the demo, nothing leaves the server, demo login (`PGHL_DEMO_EMAIL`/`PGHL_DEMO_PASSWORD`, default `demo@example.com`/`demo1234`), the demo's product name `PGHL_DEMO_BRAND` (default “HyperLevel” → “HyperLevel Demo”) – [docs/demo-mode.md](demo-mode.md) |
| `PGHL_CLOUD_MODE=1` | Hosted cloud version on this instance: pricing page `/cloud`, sign-up `/start`, Stripe billing, operator console under *Agency → Cloud* (default off) – [docs/cloud.md](cloud.md) |
| `PGHL_CLOUD_SITES_DOMAIN` | Cloud mode: a separate domain for customers' websites (`<slug>.<domain>`, DNS `*.<domain>` to the server) – customer websites never run under the login address, customers' own domains only after the TXT record ([docs/cloud.md](cloud.md#customer-sites-their-own-origin-and-verified-domains)) |
| `PGHL_CLOUD_DOMAIN`, `PGHL_CLOUD_TRIAL_DAYS`, `PGHL_CLOUD_CARD_REQUIRED` | Cloud mode: customers get `<name>.<domain>` (empty: all use `PGHL_BASE_URL`), trial in days (0–90, default 14) and whether Stripe asks for a card at sign-up (`1`/`0`); the last two can be changed in the console |
| `PGHL_HQ_LOCATION` | Cloud mode: the operator's sub-account (HQ) in which every customer account runs along as a contact and deal in “Kunden (Cloud)” – sign-up, trial, subscription, plan change, dunning, cancellation; anonymised on deletion (empty = off) – [docs/cloud.md](cloud.md#cloud--hq-crm-bridge) |
| `PGHL_LANDING_LOCATION`, `PGHL_LANDING_FORM` | Landing page waitlist: sub-account and form id that `POST /api/public/landing/waitlist` writes to (empty form = the newest “Warteliste & Newsletter”; empty sub-account = off) – [docs/company-playbook.md](company-playbook.md#landing-page-waitlist-dogfooding) |
| `PGHL_CLOUD_WAITLIST` | Waitlist instead of sign-up: `1` = on (also with Stripe, and on the home page without cloud mode), `0` = off; empty = on as long as cloud mode has no Stripe key. Then nobody creates an account or pays; `/cloud`, `/start` and the home page show self-hosting and the waitlist form – [docs/cloud.md](cloud.md#waitlist-mode) |
| `PGHL_CLOUD_STRIPE_SECRET_KEY`, `PGHL_CLOUD_STRIPE_WEBHOOK_SECRET` | Cloud mode: the operator's Stripe access; taken over once as long as nothing is set under *Agency → SaaS → Settings* |
| `PGHL_LANDING=1` | The project's public home page (gohyperlevel.com) at `/` (English), `/de`, `/vergleich`, `/vergleich/highlevel` and `/sitemap.xml` – only on its own address (`PGHL_BASE_URL`); every other domain (customer login, cloud subdomain) stays with the app. Default off: `/` is then the web app – [docs/landing.md](landing.md) |
| `PGHL_LANDING_HOSTS` | Further hosts with the home page, comma-separated (e.g. `gohyperlevel.de`); its own address and its `www.` partner always belong to it |
| `PGHL_LANDING_IMPRESSUM_URL`, `PGHL_LANDING_PRIVACY_URL` | Legal notice and privacy policy of the home page when cloud mode is off (with cloud mode it links `/cloud/legal/impressum` and `/cloud/legal/datenschutz`) |

### AI

| Variable | Meaning |
| --- | --- |
| `PGHL_ANTHROPIC_API_KEY` | Optional: Anthropic key for the AI assistant of every sub-account without its own key (the monthly limit applies per sub-account, [docs/ai-assistant.md](ai-assistant.md)) |
| `PGHL_OPENAI_API_KEY` | Optional: OpenAI key for the AI assistant of every sub-account that uses OpenAI without its own or an agency key ([docs/ai-assistant.md](ai-assistant.md#ai-provider-anthropic-or-openai)) |
| `PGHL_COMPOSIO_API_KEY` | Optional: the agency's Composio key instead of *Agency → Integrations → Setup* ([docs/connectors.md](connectors.md)) |
| `PGHL_GENMEDIA_MAX_IMAGE_MB`, `PGHL_GENMEDIA_MAX_VIDEO_MB`, `PGHL_GENMEDIA_MAX_AUDIO_MB`, `PGHL_GENMEDIA_TIMEOUT_MIN` | AI Studio: the largest result that is stored (default 30 / 200 / 60 MB) and after how many minutes a job gives up (default 15 / 20 / 45 per kind) – [docs/genmedia.md](genmedia.md) |
| `PGHL_SUBSCRIPTION_SIGNIN=off`, `PGHL_HOSTED=1`, `PGHL_CHATGPT_SIGNIN_APPROVED=1` | Subscription sign-in (“Sign in with ChatGPT”): turn it off completely · this installation is run as a hosted/paid service for others (sign-in off until OpenAI has approved) · OpenAI has approved ([docs/ai-providers.md](ai-providers.md#subscription-sign-in-mit-chatgpt-anmelden-mit-claude-verbinden)) |

### Integrations

| Variable | Meaning |
| --- | --- |
| `PGHL_GOOGLE_CLIENT_ID`, `PGHL_GOOGLE_CLIENT_SECRET` | Optional: Google OAuth app for calendar sync, business profile and mailbox sync, unless set under *Agency → Integrations → Setup* ([Connect Google & Microsoft](#connect-google--microsoft-oauth)) |
| `PGHL_MS_CLIENT_ID`, `PGHL_MS_CLIENT_SECRET`, `PGHL_MS_TENANT` | Optional: Microsoft app (Entra ID) for the Outlook calendar and the mailbox; tenant default `common` |
| `PGHL_GMAIL_PUBSUB_TOPIC` | Optional: Pub/Sub topic for Gmail push (`projects/<project>/topics/<name>`), unless set in the mailbox settings ([docs/mailbox-sync.md](mailbox-sync.md#gmail--cloud-pubsub)) |
| `PGHL_META_APP_ID`, `PGHL_META_APP_SECRET` | Optional: the agency's Meta app for the ads manager; saved values win ([docs/ads-manager.md](ads-manager.md)) |
| `PGHL_GOOGLE_ADS_DEVELOPER_TOKEN`, `PGHL_GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Optional: the agency's developer token and manager account for Google Ads; saved values win ([docs/ads-manager.md](ads-manager.md)) |
| `PGHL_NANGO_URL`, `PGHL_NANGO_SECRET_KEY`, `PGHL_NANGO_WEBHOOK_KEY`, `PGHL_NANGO_CONNECT_URL`, `PGHL_NANGO_ALLOW_PRIVATE=1` | Optional: Nango access instead of *Agency → Integrations → Nango* (without a URL: Nango Cloud; `ALLOW_PRIVATE` for `http://nango-server:3003` inside the Docker network). Self-hosted Nango: `docker compose --profile nango` – [deploy/nango/](../deploy/nango/README.md), [docs/nango.md](nango.md) |
| `PGHL_POSTIZ_URL`, `PGHL_POSTIZ_KEY` | Optional: self-hosted Postiz for the social planner, unless set under *Agency → Integrations → Setup* ([Social planner](#social-planner-postiz)) |
| `PGHL_OPENSHORTS_URL`, `PGHL_OPENSHORTS_KEY` | Optional: OpenShorts for the video studio, unless set under *Agency → Integrations → Setup* ([Video studio](#video-studio-openshorts)) |
| `PGHL_PUSH_CONTACT` | Contact address for push services (Web Push/VAPID), e.g. `mailto:you@example.com` (default: the first admin's e-mail) – see [App & push](app.md) |
| `PGHL_PUSH_MODE` | Native notifications of the apps: `relay` (default, through the operator's push relay), `own` (your own FCM/APNs keys, for your own branded apps) or `off` – see [Apps](apps.md#push) |
| `PGHL_PUSH_RELAY_URL` | Address of the push relay (default `https://gohyperlevel.com`) – see [Apps](apps.md#push) |
| `PGHL_FCM_SERVICE_ACCOUNT`, `PGHL_APNS_KEY`, `PGHL_APNS_KEY_ID`, `PGHL_APNS_TEAM_ID`, `PGHL_APNS_TOPIC`, `PGHL_APNS_SANDBOX` | Your own push keys (path or content): Firebase service account JSON, APNs key (.p8) with key id, team id and bundle id; `PGHL_APNS_SANDBOX=1` for development builds. Needed with `PGHL_PUSH_MODE=own` and on the relay – see [Apps](apps.md#push) |
| `PGHL_PUSH_RELAY`, `PGHL_PUSH_RELAY_RATE` | Only the operator's cloud instance: `1` turns on the push relay for the gray-label app; limit per instance in notifications per minute (default 600) – see [Apps](apps.md#push-relay) |
| `PGHL_APP_DIRECTORY` | Only the operator's cloud instance: `1` turns on the directory e-mail domain/agency code → instance – see [Apps](apps.md#discovery) |

### Content: courses, community, forms, webinars, websites, switch-over

| Variable | Meaning |
| --- | --- |
| `PGHL_COURSE_VIDEO_MB`, `PGHL_COURSE_URL_TTL_MIN` | Courses: the largest course video on upload in MB (default 2048) and how long a member's signed video links stay valid (minutes, default 360) – [docs/courses.md](courses.md) |
| `PGHL_FFMPEG`, `PGHL_FFPROBE`, `PGHL_COURSE_HLS`, `PGHL_COURSE_NO_FFMPEG` | Courses: optional ffmpeg (found by itself; cover image, HLS, AI subtitles), paths to it, `PGHL_COURSE_HLS=1` converts every upload to HLS, `PGHL_COURSE_NO_FFMPEG=1` turns ffmpeg off |
| `PGHL_FORMS_PER_MINUTE` | Forms: submissions per minute and address (default 20) – [docs/forms.md](forms.md) |
| `PGHL_PUBLIC_UPLOADS_MB` | Forms: storage for files visitors upload through public forms, per sub-account in MB (default 2048, `0` = no own limit); above it a submission with a file is refused with 413, the team hears about it at 90 % and 100 % – [docs/forms.md](forms.md#limits-and-settings) |
| `PGHL_TESTIMONIALS_MB` | Video testimonials: storage for the videos customers send through the collection page, per sub-account in MB (default 2048, `0` = no own limit; in the cloud the plan's media storage counts as well); above it the collection page accepts no new videos (413) – [docs/reputation.md](reputation.md#video-testimonials) |
| `PGHL_COMMUNITY_DISCOVERY=0`, `PGHL_COMMUNITY_VIDEO_MB`, `PGHL_JITSI_URL` | Community: turn off the public directory `/communities` for the whole server, the largest video per post in MB (default 500), Jitsi server for live calls (default `https://meet.jit.si`) – [docs/community.md](community.md) |
| `PGHL_WEBINAR_MAX_MB` | Optional: the largest video file for a webinar in MB (default 4096) – see [Webinars](#webinars-automated-webinars) |
| `PGHL_IMAGE_ENGINE=off` | Websites: turn off the optional image engine (`sharp`, if installed) – [docs/sites.md](sites.md) |
| `PGHL_OFFICE_DIR`, `PGHL_OFFICE_BIN_DIR`, `PGHL_OFFICE_SANDBOX`, `PGHL_OFFICE_MAX_MB`, `PGHL_OFFICE_QUOTA_MB` | Office: folder with the optional browser editors (per kind `docx/`, `xlsx/`, `pptx/`, `pdf/`) and the engines (command-line programs for agent editing and PDF export), sandbox of the editors (`strict`, default, or `same-origin`), the largest file in MB (default 25) and storage per sub-account in MB (default 2048, `0` = no limit) – setup with `deploy/office/` see [Office](#office-documents-spreadsheets-presentations-pdf) and [docs/office.md](office.md#setup-server) |
| `PGHL_PROJECT_FILES_MB` | Project files (instructions, knowledge files and repo files Claude stores over MCP): storage per sub-account in MB (default 1024, `0` = no own limit; in the cloud the plan's media storage counts as well) – see [docs/ai-tools.md](ai-tools.md#project-files) |
| `PGHL_CONTACT_DOCS_MB` | Documents on a contact and attachments to notes: storage per sub-account in MB (default 2048, `0` = no limit; at most 8 MB per file) – see [docs/sales.md](sales.md#crm-housekeeping) |
| `PGHL_APPS_ORIGIN` | AI Studio: a separate host for published apps, e.g. `https://apps.example.com` (DNS to this server; only `/apps/<address>/` answers there, no cookies of the app) – without the variable they live under the installation's address – [docs/ai-studio.md](ai-studio.md#publish) |
| `PGHL_UMZUG_MAX_MB` | Optional: the largest export file for a switch-over in MB (default 50, at most 500) – see [Switching to HyperLevel](#switching-to-hyperlevel) |

### Android, domains, partner links, screenshots

| Variable | Meaning |
| --- | --- |
| `PGHL_ANDROID_CERT_SHA256`, `PGHL_ANDROID_PACKAGE` | Optional: SHA-256 fingerprint(s) of your Android app's signing certificate (comma-separated) and its package id (default `org.gohigh.android`) for `/.well-known/assetlinks.json` – without a fingerprint App Links are off; the agency setting wins – see [Android app](app.md#android-app) |
| `PGHL_AGENT_TOKEN`, `PGHL_SERVER_IP` | Domain agent for customers' own domains: shared secret between app and agent, public IP(s) of the server ([Domain agent](#domain-agent)) |
| `PGHL_REFERRALS_DISABLED=1` | Only the providers' plain sign-up links: turns off every partner link behind “Create account”, whatever is set under *Agency → Partner links* ([Partner links](#partner-links)) |
| `PGHL_REFERRALS` | Optional: your own partner links as JSON, e.g. `{"kie":"https://kie.ai/?ref=me","stripe":""}` (`""` = plain sign-up page); the agency's settings win ([docs/referrals.md](referrals.md)) |
| `PGHL_PLUGIN_SCREENSHOTS=1`, `PGHL_CHROMIUM`, `PGHL_CHROMIUM_NO_SANDBOX=1` | Werkstatt/Marktplatz: take preview images automatically with a Chromium on the server (default off), path to the Chromium, Chromium without its own sandbox (only in throwaway containers) – [docs/werkstatt.md](werkstatt.md#configuration) |

## With Docker (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/BAISESYSTEMS/GoHyperLevel/main/scripts/install.sh | bash
```

The script asks for the domain and the admin e-mail, generates a password and `PGHL_SECRET`, writes `.env` and starts `docker-compose.yml` with Caddy (automatic HTTPS). By hand: `cp .env.example .env`, set the values, `docker compose --profile caddy up -d`. Without `PGHL_ADMIN_EMAIL`/`PGHL_ADMIN_PASSWORD` you create the first account in the browser (setup page).

## Without Docker

```bash
npm ci && npm run build
PGHL_BASE_URL=https://crm.example.com PGHL_BEHIND_PROXY=1 npm start
```

Put a reverse proxy with HTTPS in front (Caddy: `crm.example.com { reverse_proxy 127.0.0.1:4700 }`) and run it as a service (systemd, pm2).

## Real time behind the reverse proxy (team chat, canvas)

The team chat ([docs/team-chat.md](team-chat.md)), the shared canvas boards and the Living Boards
([docs/living-boards.md](living-boards.md)) keep one Server-Sent Events connection per open tab
(`/api/team-chat/stream`, `/api/canvas/<id>/stream`, `/api/boards/<id>/stream`). Caddy and Traefik pass
them through without any setup. With nginx these paths need `proxy_buffering off;` and a generous
`proxy_read_timeout` (HyperLevel sends a heartbeat every 20 seconds). If the connection is blocked, the
chat keeps working – messages then only appear after sending or reloading. One HyperLevel process serves all streams
(up to 600 open, 8 per person); the chat's files live under `data/teamchat-files` and are part of the backup.

## Own domains

Funnels can get their own domain (funnel → settings & domain). The app recognises the domain from the `Host` header and serves the funnel at `/`. For HTTPS the proxy has to know the domain:

- **Traefik:** extend the rule in the labels: ``traefik.http.routers.pghl.rule=Host(`crm.example.com`) || Host(`www.my-site.com`)`` and recreate the container.
- **Caddy** (`docker compose --profile caddy`): nothing to do – [`deploy/caddy/Caddyfile`](../deploy/caddy/Caddyfile) fetches certificates on the first request (`on_demand_tls`) and first asks `GET /api/tls/ask?domain=…` whether HyperLevel knows the domain (funnel/website domain with its `www` partner, agency or customer login domain).

**`robots.txt` and `favicon.ico`:** On the app's domain (and agency/customer login domains) HyperLevel serves its own `robots.txt` – public pages (websites under `/p/`, forms, booking and webinar pages, help centre, communities) are allowed, `/app`, `/api/` and every personal or one-time link (invoices, quotes, contracts, tracking, unsubscribe and confirmation links, member area; list in `server/modules/root-files.ts`) are blocked. `/favicon.ico` serves the app icon from the build. Websites on their own domain keep their own `robots.txt` and `sitemap.xml`.

## Domain agent

For servers with **nginx + certbot on the host**: the `domain-agent` service (template in [`deploy/examples/nginx-domain-agent/`](../deploy/examples/nginx-domain-agent/)) enters the host via `nsenter` and

1. asks the app every 60 s for the wanted domains (funnel domains with their `www` partner, agency app domain),
2. waits until DNS points to `PGHL_SERVER_IP`,
3. writes `/etc/nginx/sites-available/pghl-<domain>` (proxy to the app), checks with `nginx -t`, reloads,
4. fetches the certificate with `certbot --nginx` and reports the status back (visible under Agency → Domains).

It only touches `pghl-*` files, refuses domains another site on the server already uses, checks every domain against a strict pattern and runs commands without a shell. It cleans up removed domains again. The container runs privileged (it exists to manage nginx on the host).

| Variable | Meaning |
| --- | --- |
| `PGHL_AGENT_TOKEN` | Shared secret between app and agent (both services) |
| `PGHL_SERVER_IP` | Public IP(s) of the server, comma-separated; also shown to customers as the DNS target |
| `PGHL_APP_PORT` | Port of the app on the host (default 4700) |
| `PGHL_AGENT_PREFIX` | File prefix of this agent's nginx sites (default `pghl-`) – a second instance on the same server gets its own (e.g. `ghyl-`) so that no agent removes the other one's sites |

Without the agent (Traefik, Caddy, Dokploy…) own domains work the same way, you just add them to the proxy yourself.

## Off-site backup, monitoring and status page

The daily backup in `data/backups/` sits on the same disk as the app. For an emergency a copy belongs somewhere else:
with the variables `PGHL_BACKUP_S3_*` and `PGHL_BACKUP_KEY` HyperLevel backs up hourly and encrypted to S3-compatible storage,
checks once a month by itself that the backup can be restored, and restores with `npm run backup:restore -- latest --files`
into a separate folder. For external monitoring (UptimeRobot, Better Stack, Uptime Kuma) use
`/healthz?strict=1`; alerts go out by e-mail, push and webhook. Status under *Agency → System → Operations*. Guide:
[docs/backups.md](backups.md), and for an emergency the [incident runbook](incident-runbook.md).

## Updates

`git pull && docker compose up -d --build` (or recreate it in the Docker manager with `PGHL_REBUILD=1`). Database migrations run automatically on start.

Since October 2026 the image runs as the user `node` (not root, `cap_drop: ALL`). With a volume from before that, hand over the permissions once: `docker compose run --rm -u root gohigh chown -R node:node /data`.

## Security & keys

Overview, threat model and checklist: [security.md](security.md).

- `data/secret` signs links, `data/data.key` (if present) encrypts stored credentials. Neither belongs in backups you pass on – back them up separately.
- **Rotating keys** (after a suspicion or regularly): stop the server, then `npm run rotate-secret` (Docker: `docker compose run --rm gohigh node dist-server/server/cli/rotate-secret.js`). All stored credentials are sealed with a new key, the old one stays readable in `data/data.key.previous` (for older backups). `--dry-run` only counts, `--signing` also renews `data/secret` (old unsubscribe, survey and tracking links then stop working). With `PGHL_DATA_KEY` in the environment the tool writes nothing and prints the new key instead.
- Create the first admin with `PGHL_ADMIN_EMAIL`/`PGHL_ADMIN_PASSWORD` if you can – as long as none exists, whoever opens the setup page first becomes admin.

## Customer login domains

Under **Agency → Clients → Branding** a client can optionally get its own login domain (e.g. `crm.client.com`). The domain agent treats it like the app domain: an A record to `PGHL_SERVER_IP`, then it sets up nginx and the certificate. The login page there shows the client's logo, colour and texts; after signing in, client logins see the client's branding everywhere.

## Live chat, contracts and trigger links on own domains

On funnel domains `/chat/…`, `/s/…` (contracts), `/l/…` (trigger links) and `/t/…` (mail tracking) are passed through to the app unchanged, so the widgets and links work there too.

## Social planner (Postiz)

The social planner publishes through a self-hosted [Postiz](https://github.com/gitroomhq/postiz-app). Postiz runs as a separate service (its own updates, its own licence AGPL-3.0); HyperLevel only uses its public API and takes over no Postiz code.

1. In Postiz, create a key under **Settings → Public API**.
2. In HyperLevel, **Agency → Integrations → Setup**: enter the Postiz address (e.g. `https://postiz.example.com`) and the key. Alternatively via the environment: `PGHL_POSTIZ_URL`, `PGHL_POSTIZ_KEY`.
3. Assign every Postiz channel to a sub-account. If a client connects a channel in the social planner themselves (“+ Connect channel”), the new channel is assigned to their sub-account automatically.

Clients only see their own channels and posts, only agency admins see the Postiz address. Text posts for video platforms (YouTube, TikTok) and newsletters (Listmonk) are still planned directly in Postiz; clips from the [video studio](video-studio.md) also go to YouTube Shorts and TikTok. Postiz limits creating posts (30–90 per hour depending on the version); lists are cached briefly.

## Video studio (OpenShorts)

The video studio cuts through an [OpenShorts](https://github.com/mutonby/openshorts) (MIT) – as a separate service next to HyperLevel or the hosted API of openshorts.app; HyperLevel only uses its REST API.

1. `cd deploy/openshorts && cp .env.example .env` – set `GEMINI_API_KEY` (or `LLM_BASE_URL` to an OpenAI-compatible server) and `GOHIGH_NETWORK` (HyperLevel's Docker network, e.g. `gohigh_default`).
2. `docker compose up -d --build` – CPU image, one job at a time, default 3 CPUs / 6 GB RAM and a lower CPU priority than the CRM, no open port. Expect 5–8 minutes per 8 minutes of video.
3. In HyperLevel, **Agency → Integrations → Setup → OpenShorts**: address `http://openshorts:8000` → “Save & test”.

HyperLevel has to be publicly reachable over https so that OpenShorts can send completion notices (otherwise only polling) and Postiz can fetch clips. Space: image about 4 GB, models about 1 GB, jobs depending on length (limited with `OUTPUT_MAX_GB`/`UPLOADS_MAX_GB`, retention `JOB_RETENTION_SECONDS`, template 7 days). Everything else: [video-studio.md](video-studio.md).

## Office (documents, spreadsheets, presentations, PDF)

The *Office* area works without anything extra (files, versions, comments, the agent reading the text). Editing
in the browser and agent editing/PDF export add optional open-source editors and engines – not in the HyperLevel image,
but via `docker compose -f docker-compose.yml -f deploy/office/docker-compose.office.yml up -d --build` (a separate Debian-based
image with verified releases) or `deploy/office/install.sh` on the server. Variables, release files, security and
limits: [docs/office.md](office.md#setup-server).

## Webinars (automated webinars)

Nothing to install – no Zoom, no streaming server, no WebSockets. What matters is a public `https://` address in `PGHL_BASE_URL` (it is in every link of the confirmation and reminder e-mails), an e-mail/SMS sender in the sub-account, the running background clock (`PGHL_TICK_MS`: reminders and closing the sessions) and space in `data/webinars/` for uploaded videos. A reverse proxy has to let `PUT` bodies up to 8 MB and range requests through (nginx: `client_max_body_size 16m;` and `proxy_buffering off;` for `/w/`). HLS in Chrome/Firefox optionally needs the file `data/webinar-assets/hls.min.js`. Details, limits (`PGHL_WEBINAR_MAX_MB`) and the legal side (UWG, German unfair competition law): [docs/webinars.md](webinars.md#self-hosting).

## Switching to HyperLevel

Nothing to install. To connect by key the server needs outgoing HTTPS to `<dc>.api.mailchimp.com`, `*.api-us1.com` or `*.activehosted.com`, `api.kit.com`, `api.kajabi.com`, `developers.teachable.com`, `api.infusionsoft.com`, `api.pipedrive.com` or `<company>.pipedrive.com`, `api.systeme.io`, `a.klaviyo.com`, `api.brevo.com`, `api.klicktipp.com`, `api.manychat.com`, `<subdomain>.zendesk.com`, `api.intercom.io` (EU: `api.eu.intercom.io`, Australia: `api.au.intercom.io`), your Salesforce org's My Domain address (`<name>.my.salesforce.com`), `www.zohoapis.<region>` and `accounts.zoho.<region>`, `api.monday.com`, `api.clickup.com`, `api.notion.com`, `api.airtable.com`, `api.typeform.com` (EU: `api.eu.typeform.com`), `api.calendly.com`, `api.lexware.io` and `my.sevdesk.de` – export files need no outside connection. A reverse proxy in front has to let `POST /api/umzug/files` bodies up to `PGHL_UMZUG_MAX_MB` through. Uploaded files live in `data/umzug/` (permissions 0600) and are deleted after the import, at the latest after 14 days; `data/` belongs in the backup as always. Details: [umzug.md](umzug.md).

## Checking e-mail deliverability

Nothing to configure: the server queries DNS itself (`node:dns`, so the container has to resolve public names – the Docker default does) and the APIs of connected sending providers. `PGHL_BASE_URL` has to be your public `https://` address, because it is in every unsubscribe link (one-click unsubscribe per RFC 8058). Details: [deliverability.md](deliverability.md).

## WhatsApp, Messenger & Instagram

Meta delivers messages to `https://<domain>/hooks/meta/<locationId>` (GET to verify, POST with a signature). The address has to be publicly reachable over https and the proxy has to pass the body through unchanged (otherwise the signature does not match). Every sub-account enters its credentials under **Settings → Channels**; guide: [meta-channels.md](meta-channels.md).

## Telephony (Twilio)

**Settings → Telephony** (per sub-account). You need a Twilio account with a phone number (for German numbers Twilio asks for proof of address).

1. Enter the **Account SID** and **Auth Token** from the Twilio console. If SMS is already set up through Twilio (*E-mail & SMS*), telephony uses those details as long as the fields stay empty. The token is stored encrypted (AES-256-GCM with the key from `data/secret`) and never shown again.
2. **Load numbers from Twilio → Connect**: sets the two webhooks on the Twilio number (*A call comes in* → `/hooks/twilio/voice/<locationId>`, *Call status changes* → `/hooks/twilio/voice-status/<locationId>`, both POST). By hand it is under Twilio → Phone Numbers → number → Voice Configuration; the addresses are shown in the settings.
3. **Forward to** = your mobile number (several ring at once), **ring time** shorter than your mobile voicemail, **availability** (during business hours / always / never), **business hours** per weekday in the sub-account's time zone, **greeting** (placeholder `{{location.name}}`, German computer voice), voicemail on/off, maximum length, transcription (Twilio, up to 2 minutes, reliable only in English), e-mail to the team on a voicemail or a missed call.
4. **Test call to my phone** checks credentials and numbers.

How it works:

- **Click to call** (“Call” on the contact, in conversations, “Call back” in the call list): Twilio first calls your mobile, says “Connecting to …” and then connects to the contact – who sees your Twilio number. API: `POST /api/calls {contact_id, record?}`.
- **Incoming:** during business hours your mobile rings (the caller is shown as a number); if nobody answers or it is closed, the greeting and voicemail follow. Unknown numbers are created as a contact (source “Call”).
- **Call list** (menu *Calls*), entries with the channel “Call” in conversations (missed calls in red, voicemail to listen to) and in the contact timeline. Recordings stay at Twilio and are only played through the app when signed in (Twilio requires the credentials for recording links); in the call list they can be deleted, at Twilio too.
- **Workflows:** triggers “Call missed” (also with voicemail), “Voicemail received” and “Call ended” (answered/connected, optionally incoming or outgoing only). The template “Missed call: SMS back + call-back task” immediately sends an SMS through the configured SMS provider.
- **Recording** (click-to-call calls and/or answered incoming calls) is off; only turn it on with the consent of everyone involved (§ 201 StGB, GDPR). When it is on, the app **plays a notice by default** before connecting (“This call is recorded for quality assurance …” – to the caller on incoming calls, to the person called on outgoing ones; wording and switching it off under *Recording*), and **retention periods** delete recordings and voicemails after the chosen time, at Twilio too.
- **More than forwarding:** phone menus, ring groups and queues, buying and releasing numbers, tracking numbers, the power dialer and conversation analysis are in [docs/telephony.md](telephony.md).

Every Twilio webhook is checked with `X-Twilio-Signature` (HMAC-SHA1 over the full URL and the sorted POST parameters with the auth token); without a valid signature the app answers 403. `PGHL_BASE_URL` therefore has to be exactly the address entered at Twilio. If the last status callback never arrives (a number without a status URL), an open call is closed after Twilio's 4-hour limit.

## Browser phone (Twilio Voice SDK)

**Settings → Telephony → Browser phone** (per sub-account, requires the Twilio telephony above). With it the team makes calls right in the app over WebRTC – a headset is recommended, the app has to run over **HTTPS** (or `localhost`) and the browser asks for the microphone on the first call.

1. **API key:** Twilio console → *Account → API keys & tokens → Create API key* (type *Standard*). Enter the **API Key SID** (`SK…`) and **Secret**. The secret is stored encrypted (AES-256-GCM with the key from `data/secret`) and never shown again; the app signs short-lived access tokens with it (1 hour, JWT with a *VoiceGrant*, identity per user and sub-account).
2. **TwiML app:** Twilio → *Voice → TwiML Apps → Create*: *Voice Request URL* = `https://<domain>/hooks/twilio/phone-out/<locationId>` (POST), optionally *Status Callback URL* = `/hooks/twilio/voice-status/<locationId>`. Enter the **TwiML App SID** (`AP…`). One app per sub-account.
3. Easier: **Set up at Twilio automatically** creates a missing API key and TwiML app with the Account SID and Auth Token (or enters the addresses on the existing app).
4. **Incoming calls:** *browser and mobile at once*, *browser only* (the mobile only rings when nobody is reachable in the browser) or *mobile only* (browser outgoing only). Only change the **Twilio location** (edge) when needed – *Automatic* takes the nearest.
5. Tick **Turn on browser phone** and save.

How it works:

- The **phone button** appears at the bottom right (for everyone with access to conversations): dial pad, **Reachable for incoming calls** on/off, choice of microphone/speaker/ringtone. During a call: timer, **Mute**, **Hold** (the caller hears hold music; *Resume* brings them back), **Keys** (DTMF), **Hang up**. The window stays open when switching pages, the call keeps running.
- **Call** on the contact, in conversations and **Call back**/**Dial** in the call list call from the browser as soon as the browser phone is ready (otherwise click to call over the mobile as before). The sub-account's Twilio number is shown; recording follows the setting “Record click-to-call calls”.
- **Incoming**, the browsers of all users who are currently reachable ring (the app reports this every 45 seconds; after 90 seconds without a report you count as away), with name/number in a popup: **Answer**, **Decline**, ✕ or Esc = stop ringing here.
- All calls land in the call list, conversations and contact timeline as usual (with who answered).
- **Hold** parks the other party in a Twilio conference room (`hold-<call id>`); the browser connection ends and is rebuilt on resume. If the other party hangs up while on hold, the held call disappears.
- Content Security Policy: the app additionally allows only `wss://voice-js.<edge>.twilio.com` (signalling) and `https://sdk.twilio.com` (ringtones); call quality reports to Twilio Insights are off. The SDK is only loaded when the browser phone is on.

## AI phone agent

**Settings → Telephony → AI phone agent** (per sub-account). Claude answers calls, answers questions from the AI assistant's knowledge, books appointments, takes messages or transfers the call. Requirements: Twilio telephony (above) and an enabled [AI assistant](ai-assistant.md) with an Anthropic key – its knowledge (facts, questions & answers, project profile, website FAQ), model and monthly limit also apply on the phone.

**Settings:**

- **When does the agent answer?** *Never*, *when nobody answers* (instead of voicemail – after the ring time or outside business hours), *outside business hours* (the telephony's hours) or *always*.
- **Greeting** (placeholders `{{location.name}}`, `{{contact.first_name}}`), **persona** and **instructions** (what it should and should not do), **farewell**.
- **Voice:** German neural voices from Amazon Polly (Vicki, Daniel) and Google (Neural2, WaveNet) through Twilio's `<Say>`, language `de-DE`.
- **Tools:** book appointments (chosen calendars, otherwise all active ones, at most three; afterwards an SMS with the appointment and a cancellation link to the caller's number), booking link by SMS, message → call-back task, transfer (own number or the telephony's forwarding plus reachable browser phones), opportunity on buying interest (pipeline/stage). Free slots and booking use the same logic as the AI assistant's chat bot and the AI agents with the “Book appointment” step ([AI books appointments](booking.md#ai-books-appointments)).
- **Limits:** maximum duration (default 8 minutes) and maximum number of conversation turns per call (default 16); at most 30 AI calls per hour and sub-account.
- **Notification:** e-mail with a summary to the company e-mail and/or push.

**How a call works:** Twilio asks `/hooks/twilio/voice/<locationId>`; if the agent answers, the app replies with `<Gather input="speech" language="de-DE" speechTimeout="auto">` and the greeting (the caller may interrupt). What Twilio recognised arrives at `/hooks/twilio/voice-ai/<locationId>`, the app asks Claude (contact, free slots in the next 14 days, the conversation so far, instructions) and speaks the short answer with the next `<Gather>`. Claude answers as fixed JSON (`say`, `action`, `args`); only `none`, `check_slots`, `book_appointment`, `take_message`, `create_task`, `create_opportunity`, `send_booking_link`, `transfer`, `end_call` are allowed – depending on the settings. The server checks every answer strictly (known action, fields, real dates/times, names, e-mail) and only books times that are really free according to the calendar (otherwise Claude gets the free times and asks again); the app speaks the booking confirmation with date and time itself. State of every conversation: table `voice_ai_sessions`.

- **Silence:** ask once more, hang up politely the second time.
- **Slow:** if Claude needs longer than 9 seconds, the agent says “One moment please” and fetches the answer through `/hooks/twilio/voice-ai-wait/<locationId>`; after about 30 seconds without an answer the call goes to voicemail.
- **Errors** (Claude unreachable, an unusable answer twice, monthly limit reached): the caller goes to the telephony's voicemail. If the limit is already reached beforehand or the AI assistant is off, the agent does not answer at all.
- **Transfer:** `<Dial>` to the number or mobile + browser; if nobody answers, `/hooks/twilio/voice-ai-transfer/<locationId>` reports it back and the agent takes a message.

**Afterwards:** a summary and next step (one more Claude call) are on the call (call list, button **AI transcript** with the whole conversation) and as an entry in conversations; on the contact a note with the transcript and a timeline entry. The workflow trigger **“AI call ended”** (filter by outcome: appointment booked, transferred, message, opportunity, task, booking link, questions answered, hung up, voicemail, limit, error) starts e.g. a thank-you SMS. Unknown callers are created as a contact; if they say their name, it is added (existing details are never overwritten).

**Your own voice instead of the Twilio voice (optional):** under **Settings → Voice** set the phone path to “Own provider” – then ElevenLabs, OpenAI, Deepgram, Cartesia, Azure, Google or a local speech server speak and listen (your keys under *AI providers*). Live through a Twilio media stream (fast, callers can interrupt) needs a public `https://` address and a reverse proxy that passes WebSocket upgrades on `/hooks/twilio/stream/…` (Caddy: out of the box; nginx: `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`). Without it HyperLevel uses recording rounds; if a provider fails, Twilio keeps speaking. Everything else: [docs/voice.md](voice.md).

**Costs:** every conversation turn is one Claude call (purpose “AI phone agent” under AI assistant → usage & limit), plus one for the summary – with Sonnet 5.5 roughly one to two cents per turn (estimate at list price; knowledge and rules come from the prompt cache). Everything counts towards the AI assistant's monthly limit. Twilio additionally charges the call minutes, the speech recognition of `<Gather>` and the neural voices (per character) and, when transferring, the second leg – current prices in the Twilio console.

**Notes:** say openly in the greeting that an AI is speaking. The agent only uses the stored knowledge and invents no prices or appointments; what the caller says is information for it, not an instruction. All webhooks check `X-Twilio-Signature` (see above).

## Google reviews

**Settings → Reviews → Google reviews** (per sub-account).

1. In the [Google Cloud Console](https://console.cloud.google.com/) create a project, enable the **Places API (New)** (billing has to be set up; one request a day stays within the free quota), create an API key under *Credentials* and restrict it to the Places API.
2. Enter the key and take over your business with **Find Place ID** (company name + city, uses the Places text search) – or enter the Place ID (`ChIJ…`) directly. The key is stored encrypted.
3. The app fetches stars, count and the newest reviews immediately and then once a day (`GET https://places.googleapis.com/v1/places/<id>`, field mask `rating,userRatingCount,reviews`). Google returns at most 5 reviews per request; new ones accumulate over time, duplicates are recognised. Existing reviews trigger nothing when connecting.

**Reviews** shows Google stars and count with history and every stored review; new ones with 3★ or less go as an e-mail to the sub-account's team address. Every new review fires the workflow trigger “New Google review” (filter “only up to stars”); workflows start when the reviewer's name matches exactly one contact, outgoing webhooks always get the event `google_review.received`. The review widget additionally shows the Google stars and good Google reviews.

**Replies and posts (connect the business profile):** under **Settings → Reviews → Google Business Profile** click “Connect with Google” (with the Google account that manages the profile) and choose the location. Reviews then come through the Business Profile API instead of the Places API – all of them (not only 5), with the existing replies; reviews of the same place already stored through the Places API are taken over, not duplicated. Under **Reviews** you reply directly (“Reply”, “Edit”, “Delete” – the reply is public immediately) and publish **Google posts** (text up to 1500 characters, optionally an image URL and a button such as “Book” or “Call”). The same exists as the workflow action **“Create Google post”** (placeholders allowed) and over MCP (`ghl_reply_google_review`, `ghl_create_google_post`). Requirements: the agency's Google OAuth app ([below](#connect-google--microsoft-oauth)) and **Google approving the Business Profile APIs** for this cloud project. Without the connection everything stays as above (Places API, “Reply on Google” opens the review at Google). The direct link “Write a review” shown there works as the *public review profile* for review requests.

**Suggest an AI reply (requires the AI assistant):** under every Google review there is **“Suggest AI reply”** (with a choice of tone): the AI assistant writes a public reply in your company's tone and puts it into the reply field as a **draft** – you check it, change it and click “Reply publicly” yourself. The AI **never** publishes anything; without a connected business profile you copy the draft and paste it at Google. Under *Reviews → AI replies: tone and style* you set the **tone** (friendly, warm, professional, matter-of-fact, casual), the **form of address** (formal/informal), **your own notes** (“Never mention prices”), a **sign-off** under every reply and the switch **“Write a draft for new reviews automatically”** (default off; only a draft is created, marked “AI draft – please check”). The **brand voice** comes from *Settings → AI assistant* (persona and facts about the company). The rules in the prompt: the review's language, 2–5 sentences, pick up one detail, apologise for criticism without admitting fault and offer a conversation, no personal data, no promises, invent nothing; the review text only counts as data. Every suggestion counts towards the monthly AI limit (purpose “Review reply” in the log), at most 60 per hour and sub-account. MCP: `ghl_suggest_review_reply` (creates a draft, publishes nothing), `ghl_google_reviews` shows `reply_draft`.

## Connect Google & Microsoft (OAuth)

One OAuth layer for three things: the **two-way sync with Google Calendar** and **Outlook/Microsoft 365** (per login) and the **Google Business Profile** (per sub-account). The agency enters its apps once under **Agency → Integrations → Setup → Google & Microsoft (OAuth)** (or via environment variables, see above). Client secrets and all tokens are stored encrypted (AES-256-GCM with the key from `data/secret`) and never handed to the browser.

**Redirect URI:** `https://<PGHL_BASE_URL>/oauth/google/callback` or `/oauth/microsoft/callback` – exactly as shown under *Integrations* (with an active agency app domain its address is added; enter both). Connecting works on the address you are signed in on (main address or agency domain), not on customer login domains.

**Mailbox sync:** the same apps and redirect URIs also serve Gmail/Outlook (additional scopes `gmail.modify`/`gmail.send` or `Mail.ReadWrite`/`Mail.Send`; Google's rules for “restricted” scopes and Microsoft's admin consent: [docs/mailbox-sync.md](mailbox-sync.md)).

**Sign in with Google/Microsoft:** the same apps also serve as a sign-in button (Agency → Sign-in). For that, additionally enter `https://<PGHL_BASE_URL>/auth/sso/google/callback` or `/auth/sso/microsoft/callback` as a redirect URI – details, GitHub, Apple and your own SSO providers in [docs/auth.md](auth.md).

### Create the Google app

1. [Google Cloud Console](https://console.cloud.google.com/) → choose/create a project → **APIs & Services → Library**: enable the **Google Calendar API**; for reviews and posts additionally the **My Business Account Management API**, **My Business Business Information API** and **Google My Business API** (v4, reviews and posts).
2. **OAuth consent screen:** type *External*, app name, support e-mail, authorised domain (your domain). Scopes: `openid`, `email`, `…/auth/calendar.events`, `…/auth/calendar.readonly` and for the business profile `…/auth/business.manage`. While the app is in *Testing*, only listed test users; for all customers “Publish app” (Google reviews the calendar scopes).
3. **Credentials → Create credentials → OAuth client ID**, type *Web application*, the URI from above under *Authorised redirect URIs*. Enter the client ID and client secret under *Integrations*.
4. **Get the Business Profile API approved:** the Business Profile APIs are blocked for new cloud projects (quota 0). Apply through the [API access request form](https://developers.google.com/my-business/content/prereqs) with a verified business profile; approval usually takes a few days. Until then the app reports “no API access … approved” – the calendar sync is not affected.

### Create the Microsoft app

1. [Microsoft Entra admin center](https://entra.microsoft.com/) → **App registrations → New registration**: name, supported account types *Accounts in any organisational directory and personal Microsoft accounts* (tenant `common`) – business accounts only: `organizations`, only your own company: its tenant ID. **Redirect URI**: platform *Web*, the URI from above.
2. **API permissions → Microsoft Graph → Delegated permissions:** `Calendars.ReadWrite`, `offline_access`, `openid`, `email` (no admin consent needed).
3. **Certificates & secrets → New client secret**; enter the *value* (not the ID) together with the *Application (client) ID* and the tenant under *Integrations*. The secret expires (max. 24 months) – enter a new one in time.

### How the sync works

- **Connect:** *Settings → My account → Connect with Google / Connect with Microsoft*. Flow: authorization code with PKCE (S256), `state` signed, valid for 10 minutes, single use and bound to the login session. Then choose which calendars are checked for conflicts, which calendar booked appointments are written to and which booking calendars this applies to.
- **Busy times** of the chosen calendars are fetched every 5 minutes (Google `freeBusy`, Outlook `calendarView`; events marked “free” do not count) and block the booking pages – together with any iCal addresses. If a fetch fails, the last known times stay (better a blocked slot than a double booking).
- **Appointments → calendar:** new, moved and cancelled appointments (blocked times too) of the linked booking calendars are created, changed (with `If-Match`) or deleted, the external event ID is stored. Creating is idempotent (Google: fixed event ID, Microsoft: `transactionId`); errors are retried with growing intervals (1 minute to 6 hours). Recurring series go over as individual appointments, not as a series event – if one is moved there, only that appointment changes here ([recurring appointments](booking.md#recurring-appointments)).
- **Calendar → appointments:** changes are fetched every 3 minutes (Google `syncToken`, Microsoft delta link; no public webhooks needed). If an appointment written from here is moved there, it moves here too; deleted → cancelled here (workflow trigger “Appointment status changed” with `source: google|microsoft`). If both sides changed, the later change wins; that is noted in the connection's log.
- **Tokens:** access tokens are renewed automatically; if access is revoked or expired, *My account* shows “Reconnect”. **Disconnect** revokes access at Google (Microsoft does not offer that – remove it there under [myaccount.microsoft.com → Privacy → Apps](https://myaccount.microsoft.com/)) and deletes the stored tokens and the sync state; appointments already written stay in the calendar.

## Connect an e-mail mailbox (Gmail)

> For Gmail and Outlook / Microsoft 365 there is the **native connection through the official APIs** (OAuth, push, replies in the same thread, archive/labels in both directions): [docs/mailbox-sync.md](mailbox-sync.md). The IMAP sync below remains for every other provider.

**Agency → Integrations → Setup → E-mail mailboxes → + Mailbox.** For Gmail: server `imap.gmail.com`, user = Gmail address, password = app password (Google account → Security → 2-Step Verification → App passwords). The password is stored encrypted (AES-256-GCM with the key from `data/secret`).

Rules assign e-mails to projects, e.g. “domain is sportbund.example → running club” or “text contains hofladen → Hofladen Sonnenhof”. The first matching rule wins; e-mails without a match are ignored (unless a default project is chosen). The first fetch reads the last 30 days (at most 300 e-mails per folder), afterwards only new ones. Drafts that were sent or deleted in the mailbox disappear from the CRM too.

## Supabase mirror

HyperLevel can continuously mirror its data into a Supabase (one direction only: HyperLevel → Supabase). That way other projects, SQL analyses or the Supabase MCP reach projects, contacts, deals, tasks, invoices and documents.

1. In Supabase, run once the SQL shown under **Agency → Integrations → Setup → Supabase mirror → “SQL for the tables”** (creates `public.ghl_projects`, `ghl_contacts`, `ghl_opportunities`, `ghl_tasks`, `ghl_invoices`, `ghl_docs` as well as `ghl_companies`, `ghl_object_records` and `ghl_associations` – after an update with new tables just run the SQL again; row level security without grants – only the service role key reads them).
2. Enter the Supabase address (e.g. `https://db.your-domain.com`) and the **service role key**, “Save & test”.
3. Changed rows are transferred every 10 minutes, everything once a night (rows deleted in HyperLevel are then removed in Supabase too). “Sync everything now” starts a full run immediately.

The key is stored encrypted and never returned to the browser.

## Todoist

Task sync with your personal Todoist (both directions or only HyperLevel → Todoist): copy the token under Todoist → **Settings → Integrations → Developer** and save & test it under **Agency → Integrations → Setup → Todoist**. The default is **one** Todoist project “HyperLevel” with one section per sub-account – that also fits the free Todoist plan (max. 5 projects); alternatively one project per sub-account (Todoist Pro). No environment entry needed; the token is stored encrypted in the database. Tasks deleted in Todoist are only marked done here, never deleted. The optional webhook (`https://<domain>/hooks/todoist`, client secret from the Todoist App Console) only speeds things up – without it the sync runs every 3 minutes. Everything else: [todoist.md](todoist.md).

## Member area (courses)

The member area runs under the app address (`PGHL_BASE_URL`, or the agency/customer login domain): `https://<domain>/portal/<sub-account>`. Members sign in with a login link sent through the sub-account's SMTP access (Settings → E-mail & SMS) – without SMTP no e-mail goes out. Links are valid for 30 minutes and once; sessions for 30 days (cookie `pm_<sub-account>`, only for the member area). Behind a proxy set `PGHL_BEHIND_PROXY=1` so that the limit on login requests per IP works. The member area only serves lesson downloads to members with access.

## Community

The community runs in the member area under `https://<domain>/portal/<sub-account>/community` – the same sign-in (login link by e-mail, cookie `pm_<sub-account>`), the same domain. There is nothing extra to install and no credentials to enter; all it needs is the sub-account's SMTP sending (Settings → E-mail & SMS) for login links and the daily digest.

- **Who gets in:** course participants and every contact with access through a group (tag or course, *Community → group → Settings → Access*). Groups with “Everyone in the member area” do not open the login to further contacts.
- **Images** of members live under `<PGHL_DATA_DIR>/community/` (not under the public uploads) and are only served to members of the group; avatars to signed-in members of the same sub-account. PNG, JPG, GIF and WebP up to 3 MB (avatar 2 MB) are allowed, the file content is checked. The backup of the data folder contains them automatically.
- **Security:** posts and comments are Markdown without HTML; external images via `![…](…)` become links for members (no tracking pixels). Forms need a session token and the same origin. The community pages load exactly one script of their own (`/portal-community.js`, image picker and confirmations) – everything also works without JavaScript, except uploading images.
- **Daily digest:** the background clock (`PGHL_TICK_MS`) checks every 10 minutes whether there are unread notifications after the configured time (default 07:00, the sub-account's time zone) and sends each member at most one e-mail a day. Turn it off under *Community → Settings*; members unsubscribe in their profile. Contacts with “Do not disturb” get none.
- **Limits:** posts/comments per member and hour (default 5/30) and automatic hiding after three reports can be set per group.
- **Snapshots/copying:** snapshots contain blog posts, courses (without participants) and the structure of the community groups (without posts, members and events). When copying into another sub-account, the lessons' download files are copied along.

## Partner links

Next to the providers' key fields HyperLevel shows **“Create account ↗”**. Some of these links are
referral links of the HyperLevel maintainer – always labelled “Partner link” and routed through `/go/<provider>`
(only one click counter per provider is stored). As the operator you decide: replace or turn them off under
**Agency → Partner links**, set your own with `PGHL_REFERRALS` or turn all of them off with
`PGHL_REFERRALS_DISABLED=1`. Details: [docs/referrals.md](referrals.md).
