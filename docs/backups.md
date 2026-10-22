# Backups, uptime and the status page

What keeps an instance recoverable and watched: the local daily snapshots, **off-site encrypted backups** with a monthly
restore test, `/healthz` with alerts by e-mail, push and webhook, and a public **status page**. Everything is built in and
configured through the environment; the state is shown under *Agentur → System → Betrieb*. For what to do when something goes
wrong, see the [incident runbook](incident-runbook.md).

| | Default | Recovery point (RPO) |
| --- | --- | --- |
| Local snapshot (`data/backups/`) | daily, 14 kept (`PGHL_BACKUP_KEEP`) | up to 24 h – and lost with the disk |
| Off-site backup (S3-compatible) | hourly, 48 hourly / 14 daily / 6 monthly kept | up to 1 h, survives the server |

## Local snapshots

Unchanged from earlier versions: once a day a consistent copy of the database (`VACUUM INTO` in a worker thread, so requests
keep being answered) lands in `data/backups/`. `PGHL_BACKUPS=0` turns it off, `PGHL_BACKUP_KEEP` sets how many stay. *Agentur →
System* and `GET /api/admin/backups` list them; `GET /api/admin/backup` downloads a fresh copy. These copies sit on the same disk
as the app: they help after a bad migration or a deleted record, not after a lost server.

## Off-site encrypted backups

Set five variables and restart – the first backup runs within a minute:

```bash
PGHL_BACKUP_S3_ENDPOINT=https://fsn1.your-objectstorage.com   # the provider's S3 endpoint
PGHL_BACKUP_S3_BUCKET=my-gohigh-backups                        # a bucket only for this
PGHL_BACKUP_S3_ACCESS_KEY=…
PGHL_BACKUP_S3_SECRET_KEY=…
PGHL_BACKUP_KEY=$(openssl rand -hex 32)                         # 32 bytes, hex or base64 – keep a copy somewhere else!
# optional
PGHL_BACKUP_S3_REGION=fsn1             # default us-east-1 (MinIO); the region your provider names
PGHL_BACKUP_S3_PREFIX=crm-prod         # folder in the bucket, for several instances in one bucket
PGHL_BACKUP_S3_PATH_STYLE=0            # 1 (default): https://endpoint/bucket/…, 0: https://bucket.endpoint/…
PGHL_BACKUP_INTERVAL_MIN=60            # 5 to 1440
PGHL_BACKUP_RETENTION=48,14,6          # hourly, daily, monthly
PGHL_BACKUP_FILES=0                    # only the database, not the upload folders
PGHL_BACKUP_PING_URL=https://hc-ping.com/<uuid>   # pinged after every backup (healthchecks.io and similar)
```

| Provider | Endpoint | Region | Notes |
| --- | --- | --- | --- |
| Hetzner Object Storage | `https://fsn1.your-objectstorage.com` (or `nbg1`, `hel1`) | `fsn1` … | another location than your server |
| Backblaze B2 | `https://s3.eu-central-003.backblazeb2.com` | `eu-central-003` | application key with access to one bucket |
| Hostinger Object Storage | the S3 endpoint shown in hPanel | as shown | prefer a different data centre than the VPS |
| Cloudflare R2 | `https://<account>.r2.cloudflarestorage.com` | `auto` | |
| MinIO (own second server) | `https://minio.example.com` | `us-east-1` | path style (default) |

Give the access key the rights *list, read, write and delete* on that one bucket and nothing else. Object lock or versioning
on the bucket protects against a compromised server deleting its own backups – the retention then needs a lifecycle rule
at the provider as well.

### What goes into the bucket

- `db/<stamp>.db.gz.enc` – a consistent copy of the whole database, compressed and encrypted.
- `files/<hash>.enc` – every file of the upload folders (all folders inside the data folder except `backups`), one object per
  file version, uploaded **once**; the object name is a hash, so file names never leave the server.
- `manifests/<stamp>.json.enc` – what belongs to a snapshot: the database object, the row counts of the main tables and the list
  of files with their objects.

The database files themselves, `data/secret` and `data/data.key` are **never** uploaded – keep those apart (password manager,
second medium). Without `data/data.key` the stored credentials in a restored database cannot be opened.

### Encryption and keys

AES-256-GCM, streamed, with a fresh random IV per object; the header carries a key id, so a restore says "wrong key" instead of
"corrupt file". The key comes only from `PGHL_BACKUP_KEY`. **Lose the key and the backups are worthless** – store it in your
password manager and in the runbook's emergency envelope. To rotate it, put the old key into `PGHL_BACKUP_KEY_PREVIOUS`
(comma-separated, only used for reading) and a new one into `PGHL_BACKUP_KEY`; new backups use the new key, restores of older
ones still work. Once the oldest backup with the old key has aged out of the retention, drop it from `PGHL_BACKUP_KEY_PREVIOUS`.

### Retention

Grandfather–father–son: the newest snapshot of each of the last 48 hours, the last 14 days and the last 6 months that have one
(UTC) is kept, everything else is deleted after each backup. A file object goes once it disappeared locally before the oldest
kept snapshot was taken – until then a restore of an older snapshot can still bring it back. Mind your deletion promise: a deleted
customer can live on in backups for up to six months; say so in the AVV and the privacy policy (or shorten the retention).

### Restore

The restore never touches the running database. It writes a checked copy into a folder of its own:

```bash
npm run backup:restore -- --list                            # snapshots in the bucket, newest first
npm run backup:restore -- latest                            # → data/restore-latest/pghl.db, checked
npm run backup:restore -- 2026-10-10T14-00-00Z --files      # a given snapshot with all upload folders
npm run backup:restore -- ./download.db.gz.enc --to /srv/r  # an encrypted file downloaded by hand
# Docker:
docker compose run --rm gohigh node dist-server/server/cli/backup-restore.js latest --files --to /data/restore
```

Each restore runs SQLite's `integrity_check`, compares the row counts with the manifest and the size of every restored file, and
exits with code 1 on any problem. Then:

1. Stop the app (`docker compose stop gohigh`).
2. Move `pghl.db`, `pghl.db-wal` and `pghl.db-shm` in the data folder aside.
3. Put the restored `pghl.db` (and with `--files` the restored folders) into the data folder – or point `PGHL_DATA_DIR` at the
   restore folder.
4. On a new server: put back `data/secret` and `data/data.key` from your separate copy.
5. Start the app and check `/healthz`.

A new server from scratch (RTO about an hour once practised): install as in [deploy](deploy/README.md), set the same environment
including `PGHL_BACKUP_*`, run the restore with `--files`, switch over as above, move DNS.

### Monthly restore test

Every 30 days the app downloads the newest snapshot into a temporary folder, runs `integrity_check`, compares the row counts with
the manifest and decrypts a sample of 20 files. A failure raises a critical alert (below) and is retried daily until it passes.
*Agentur → System* shows the last test and has buttons for a backup and a test now.

## Uptime and alerts

### `/healthz`

| Check | Fails when |
| --- | --- |
| `db` | the database does not answer |
| `disk` | less than 10 % of the data folder's disk is free (a warning below 20 %) |
| `tick` | the background scheduler had no round for ten ticks and at least five minutes |
| `backup` | the newest off-site backup is older than 2 h (twice the interval if longer) – or, without off-site, the local one older than 26 h |

- `GET /healthz` → `200 ok`, or `200 degraded: disk, backup` when a check fails; `503` only when the database is down. That is what
  Docker's `HEALTHCHECK`, Railway, Render and Coolify use – an old backup must not make them restart the app.
- `GET /healthz?strict=1` → `503` as soon as any check fails. **Point external monitors here.**
- `GET /healthz?format=json` → `{status, checks: {db, disk, tick, backup}}` with statuses only (no numbers, nothing private).

### External monitoring

A check from inside the server cannot tell you the server is gone. Add one from outside:

- **UptimeRobot** – *New monitor → HTTP(s)*, URL `https://<your host>/healthz?strict=1`, interval 1–5 min, alert contacts with the
  mobile app. Optional second monitor on `/app` (the login page).
- **Better Stack (Uptime)** – *Create monitor → URL becomes unavailable*, same URL, escalation to phone/SMS; its status page can sit
  next to the built-in one and keeps working when the server is down.
- **healthchecks.io** (dead man's switch) – create a check with period 1 h and grace 1 h, put its ping URL into
  `PGHL_BACKUP_PING_URL`: every successful backup pings it, a failed one pings `/fail`, a silent server raises the alarm.
- **Uptime Kuma** on a second small server – HTTP monitor on `/healthz?strict=1`, notifications via ntfy, Telegram or e-mail.

### Alerts

Once a minute the app evaluates the checks plus a **spike of unexpected server errors** (at least 20 in five minutes and 5 % of the
requests). Each problem alerts once, reminds every 6 hours while it lasts and reports when it is over. One-off alerts: a failed
restore test, abuse notices and automatic sending pauses in cloud mode.

| Channel | Setting |
| --- | --- |
| E-mail | `PGHL_ALERT_EMAIL=ops@example.com,oncall@example.com` (default: every admin's address), sent through the operator's oldest own sub-account – set up its SMTP |
| Web push | every admin's devices that allowed push notifications (*Mein Konto*, kind "Betrieb"); `PGHL_ALERT_PUSH=0` turns it off |
| Webhook | `PGHL_ALERT_WEBHOOK=` an ntfy topic (`https://ntfy.sh/<topic>`), a Slack or Discord incoming webhook, Telegram (`https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>`) or any URL that takes JSON `{source, key, severity, title, body, resolved, at}` |

*Agentur → System → Betrieb* lists the checks with details, the channels, the recent alerts and has a *Test-Alarm* button.

## Status page

`/status` is a public page on the instance: the components (*Web-App & API*, *Websites, Formulare & Buchungsseiten*,
*Automationen & Versand*, *Datensicherung*) with their current state, 90 days of uptime as daily bars and the incidents of the last
90 days. It is on by default in cloud mode and otherwise with `PGHL_STATUS_PAGE=1` (`0` turns it off). No script, no cookie, no
outside request.

- **Uptime comes from the instance's own samples**: one every 5 minutes from the health evaluation. A slot without a sample counts
  as down – the server could not even write it. Days are UTC.
- **Incidents** are written under *Agentur → System → Betrieb → Statusseite*: title, impact (minor, major, maintenance), affected
  components, status (investigating → identified → monitoring → resolved) and public updates. An open incident sets the component's
  state; resolved ones stay in the list for 90 days.
- Honest limit: the page runs on the server it reports on. When that server is down, so is the page – pair it with an external
  monitor (above) or an external status page, and enter that address as the *Status-Seite* in the cloud settings if you use one.

## API

Admin routes: `GET /api/admin/offsite-backup`, `POST /api/admin/offsite-backup/run|restore-test`, `GET /api/admin/offsite-backup/snapshots`,
`GET /api/admin/ops`, `POST /api/admin/ops/test-alert`, `GET /api/admin/status-page`, `POST /api/admin/status-page/incidents`,
`PATCH|DELETE /api/admin/status-page/incidents/:id` – details in [api.md](api.md#operations-backups-alerts-status-page).

## For developers

- `modules/offsite-backup.ts` (tables `backup_runs`, `backup_files`, schedule, restore test, routes) on top of
  `services/backup-offsite.ts` (configuration, layout, manifest, walking the upload folders, restore with checks – shared with
  `cli/backup-restore.ts`), `services/backup-crypto.ts` (AES-256-GCM streams), `services/s3-lite.ts` (S3 client with hand-made
  SigV4, multipart above 512 MB) and `services/backup-retention.ts` (pure retention plan). Test hooks: `offsiteS3`, `backupPingFetch`;
  `tests/s3-fake.ts` is a local S3 that checks every signature.
- `modules/ops-alerts.ts` wraps the `/healthz` route of `core.ts` (`router.wrappers`), chains `app.services.serverError` to count
  errors and offers `app.services.ops` (`health`, `evaluate`, `send`), `app.services.opsAlert.event(alert)` for one-off alerts and
  `app.services.opsEveryMinute` (functions run after each evaluation). Test hooks: `alertMailer`, `alertFetch`, `opsDiskFree`,
  `opsLastTick`, `opsStartedAt`.
- `modules/status-page.ts` (tables `status_samples`, `status_incidents`, `status_updates`) with the pure `services/status-page.ts`.
- UI: `web/src/pages/OpsPanel.tsx` through the slot `agency.system` (`web/src/slots.tsx`), i18n namespace `ops`.
