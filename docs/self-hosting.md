# Selbst hosten

> English guides for every way to run HyperLevel (Docker, Coolify, Railway/Render, Hostinger, plain Node): [docs/deploy/](deploy/README.md). Alle Variablen mit Erklärung: [`.env.example`](../.env.example).

## Umgebung

Alle Variablen sind optional außer `PGHL_BASE_URL`; vieles lässt sich auch in der Oberfläche einstellen (dort gespeicherte Werte gehen in der Regel vor, die Variable gilt dann als Standard). Dieselben Variablen mit englischen Kommentaren zum Kopieren: [`.env.example`](../.env.example). `tests/docs.test.ts` prüft, dass jede `PGHL_*`-Variable, die der Servercode liest, hier steht.

### Grundlagen

| Variable | Bedeutung |
| --- | --- |
| `PGHL_BASE_URL` | Öffentliche Adresse für Links in Mails (Buchung, Rechnung, Abmelden). **Setzen.** |
| `PGHL_DOMAIN` | Domain für das mitgelieferte Caddy (`docker compose --profile caddy`) und das Traefik-Beispiel; wird von `scripts/install.sh` gesetzt |
| `PGHL_TIMEZONE` | Zeitzone des ersten Sub-Accounts und des nächtlichen Demo-Resets (Standard `Europe/Berlin`) |
| `PGHL_DATA_DIR` | Datenbank, Uploads, Schlüssel (Standard `./data`, im Container `/data`) |
| `PORT`, `PGHL_PORT` | Port (Standard 4700) |
| `PGHL_HOST`, `PGHL_WEB_DIR` | Lausch-Adresse (Standard `127.0.0.1`, mit `PGHL_BEHIND_PROXY=1` `0.0.0.0`) und Ordner der gebauten Oberfläche (Standard `./dist-web`) |
| `PGHL_BEHIND_PROXY=1` | Auf `0.0.0.0` lauschen und `X-Forwarded-For` vertrauen (hinter Traefik/Caddy) |
| `PGHL_PROXY_HOPS` | Wie viele Proxys `X-Forwarded-For` ergänzen (Standard 1; 2 z. B. mit Cloudflare vor Traefik). Die Besucher-Adresse ist der Eintrag, den der eigene Proxy angehängt hat – nie ein vom Browser mitgeschickter |
| `PGHL_TICK_MS` | Takt für Wartezeiten, Erinnerungen, geplante Kampagnen und Abgleiche (Standard 15000; `0` = aus) |
| `PGHL_VERSION`, `PGHL_BUILD` | Nur für Image-Bauer: Version, die Fehlermeldungen in der Diagnose nennen (Standard: `version` aus `package.json`), und eine Build-Kennung, die als `+<build>` angehängt wird ([docs/bug-reports.md](bug-reports.md)) |

### Erster Start

| Variable | Bedeutung |
| --- | --- |
| `PGHL_ADMIN_EMAIL`, `PGHL_ADMIN_PASSWORD` | Legt beim ersten Start den Admin an (sonst Einrichtung im Browser; das Passwort braucht mindestens 8 Zeichen) |
| `PGHL_ADMIN_NAME` | Anzeigename dieses Admins (Standard: die E-Mail-Adresse) |
| `PGHL_COMPANY_NAME` | Name des ersten Sub-Accounts (Standard „Meine Firma“) |

### Schlüssel und Sicherheit

| Variable | Bedeutung |
| --- | --- |
| `PGHL_SECRET` | Optional: festes Signatur-Geheimnis statt `data/secret` (Abmelde-, Umfrage- und Tracking-Links; verschlüsselt auch gespeicherte Zugangsdaten, wenn es keinen Datenschlüssel gibt) – nie mehr ändern |
| `PGHL_DATA_KEY`, `PGHL_DATA_KEY_PREVIOUS` | Optional: Schlüssel für gespeicherte Zugangsdaten (64 Hex-Zeichen) bzw. frühere Schlüssel (komma-getrennt). Standard: `data/data.key` (von `npm run rotate-secret` angelegt), sonst abgeleitet aus `data/secret` |
| `PGHL_ALLOW_PRIVATE_FETCH=1` | Nur für reine LAN-Installationen: erlaubt ausgehende Abrufe (Webhooks, iCal, SMS-Gateway, SSO-Anbieter nur im Docker-Netz wie `http://keycloak:8080`) an interne Adressen – sonst gesperrt (SSRF-Schutz) |
| `PGHL_AUTH_BREAK_GLASS=1` | Notfall-Zugang: Admins dürfen sich trotz SSO-Pflicht, ausgeschaltetem Passwort-Login oder 2FA-Pflicht wieder mit Passwort anmelden – nur vorübergehend setzen ([docs/auth.md](auth.md#policies)) |
| `PGHL_PLUGIN_NETNS=off` | Werkstatt/Plugins: eigenen Netzwerk-Namensraum für Plugin-Skripte abschalten ([docs/werkstatt.md](werkstatt.md#configuration)) |
| `PGHL_PLUGIN_SIGNING_KEY`, `PGHL_PLUGIN_SIGNING_KEY_ID`, `PGHL_PLUGIN_TRUSTED_KEYS` | Werkstatt/Plugins: Signierschlüssel (PKCS#8-PEM) und Kennung, mit denen diese Installation ihre Plugin-Exporte signiert und sich selbst vertraut, sowie weitere vertrauenswürdige Herausgeber als JSON ([docs/werkstatt.md](werkstatt.md#configuration)) |

### Betrieb, Backup und Leistung

| Variable | Bedeutung |
| --- | --- |
| `PGHL_BACKUPS=0` | Tägliches automatisches Backup nach `data/backups/` abschalten |
| `PGHL_BACKUP_KEEP` | Wie viele tägliche Backups bleiben (Standard 14) |
| `PGHL_BACKUP_S3_ENDPOINT`, `PGHL_BACKUP_S3_BUCKET`, `PGHL_BACKUP_S3_ACCESS_KEY`, `PGHL_BACKUP_S3_SECRET_KEY`, `PGHL_BACKUP_KEY` | **Off-site-Backup**: stündlich verschlüsselt (AES-256-GCM) in S3-kompatiblen Speicher (Hetzner, Backblaze, Hostinger, R2, MinIO) – Datenbank und Upload-Ordner, monatlicher Restore-Test, Wiederherstellen mit `npm run backup:restore`. Der Schlüssel (`openssl rand -hex 32`) gehört getrennt gesichert – ohne ihn sind die Backups wertlos ([docs/backups.md](backups.md)) |
| `PGHL_BACKUP_S3_REGION`, `PGHL_BACKUP_S3_PREFIX`, `PGHL_BACKUP_S3_PATH_STYLE` | Off-site-Backup: Region (Standard `us-east-1`), Ordner im Bucket, Pfad-Stil (`1` Standard, `0` = Bucket als Subdomain) |
| `PGHL_BACKUP_KEY_PREVIOUS` | Frühere Backup-Schlüssel, durch Komma getrennt – nur zum Lesen älterer Backups nach einem Schlüsselwechsel |
| `PGHL_BACKUP_INTERVAL_MIN`, `PGHL_BACKUP_RETENTION`, `PGHL_BACKUP_FILES`, `PGHL_BACKUP_PING_URL` | Off-site-Backup: Abstand in Minuten (Standard 60), Aufbewahrung stündlich/täglich/monatlich (Standard `48,14,6`), `0` = ohne Upload-Ordner, Ping-Adresse nach jedem Backup (z. B. healthchecks.io; `/fail` bei Fehler) |
| `PGHL_ALERT_EMAIL`, `PGHL_ALERT_WEBHOOK`, `PGHL_ALERT_PUSH` | Alarme bei wenig Speicherplatz, zu altem Backup, hängenden Hintergrund-Aufgaben und vielen Serverfehlern: Empfänger (Standard alle Admins), Webhook für ntfy, Slack, Discord, Telegram oder JSON, `0` = kein Push an Admins ([docs/backups.md](backups.md#uptime-and-alerts)) |
| `PGHL_STATUS_PAGE` | Öffentliche Statusseite `/status` mit 90 Tagen Verfügbarkeit und Vorfällen: `1` = an, `0` = aus (Standard: an im Cloud-Modus) – [docs/backups.md](backups.md#status-page) |
| `PGHL_SLOW_REQUEST_MS`, `PGHL_SLOW_QUERY_MS`, `PGHL_SQLITE_CACHE_MB`, `PGHL_SQLITE_MMAP_MB`, `PGHL_RESULT_CACHE` | Performance: Grenze für das Protokoll langsamer Anfragen (Standard 300 ms), Abfrage-Messung (aus), SQLite-Cache (32 MB) und mmap (256 MB), Lese-Cache aus (`0`) – Anzeige unter *Agentur → System*, Hinweise zur Servergröße in [docs/performance.md](performance.md) |
| `PGHL_DEMO_MODE=1` | Öffentliche Demo: erfundene Daten in einem **leeren** Datenordner, nächtliches Zurücksetzen (`PGHL_DEMO_RESET_HOUR`, Standard 3 Uhr), nichts verlässt den Server, Demo-Login (`PGHL_DEMO_EMAIL`/`PGHL_DEMO_PASSWORD`, Standard `demo@example.com`/`demo1234`), Produktname der Demo `PGHL_DEMO_BRAND` (Standard „HyperLevel“ → „HyperLevel Demo“) – [docs/demo-mode.md](demo-mode.md) |
| `PGHL_CLOUD_MODE=1` | Gehostete Cloud-Version auf dieser Instanz: Preisseite `/cloud`, Anmeldung `/start`, Stripe-Abrechnung, Betreiber-Konsole unter *Agentur → Cloud* (Standard aus) – [docs/cloud.md](cloud.md) |
| `PGHL_CLOUD_SITES_DOMAIN` | Cloud-Modus: eigene Domain für die Websites der Kunden (`<slug>.<domain>`, DNS `*.<domain>` auf den Server) – Kunden-Websites laufen nie unter der Login-Adresse, eigene Domains der Kunden erst nach dem TXT-Eintrag ([docs/cloud.md](cloud.md#customer-sites-their-own-origin-and-verified-domains)) |
| `PGHL_CLOUD_DOMAIN`, `PGHL_CLOUD_TRIAL_DAYS`, `PGHL_CLOUD_CARD_REQUIRED` | Cloud-Modus: Kunden bekommen `<name>.<domain>` (leer: alle nutzen `PGHL_BASE_URL`), Testphase in Tagen (0–90, Standard 14) und ob Stripe schon bei der Anmeldung nach einer Karte fragt (`1`/`0`); die beiden letzten sind in der Konsole änderbar |
| `PGHL_HQ_LOCATION` | Cloud-Modus: Sub-Account des Betreibers (HQ), in dem jedes Kundenkonto als Kontakt und Deal in „Kunden (Cloud)“ mitläuft – Anmeldung, Testphase, Abo, Tarifwechsel, Mahnung, Kündigung; beim Löschen anonymisiert (leer = aus) – [docs/cloud.md](cloud.md#cloud--hq-crm-bridge) |
| `PGHL_LANDING_LOCATION`, `PGHL_LANDING_FORM` | Warteliste der Landingpage: Sub-Account und Formular-ID, in die `POST /api/public/landing/waitlist` einträgt (leeres Formular = das neueste „Warteliste & Newsletter“; leerer Sub-Account = aus) – [docs/company-playbook.md](company-playbook.md#landing-page-waitlist-dogfooding) |
| `PGHL_CLOUD_WAITLIST` | Warteliste statt Anmeldung: `1` = an (auch mit Stripe, und auf der Startseite ohne Cloud-Modus), `0` = aus; leer = an, solange der Cloud-Modus keinen Stripe-Schlüssel hat. Dann legt niemand ein Konto an oder bezahlt etwas; `/cloud`, `/start` und die Startseite zeigen Selbst-Hosting und das Wartelisten-Formular – [docs/cloud.md](cloud.md#waitlist-mode) |
| `PGHL_CLOUD_STRIPE_SECRET_KEY`, `PGHL_CLOUD_STRIPE_WEBHOOK_SECRET` | Cloud-Modus: Stripe-Zugang des Betreibers; wird einmal übernommen, solange unter *Agentur → SaaS → Einstellungen* nichts steht |
| `PGHL_LANDING=1` | Öffentliche Startseite des Projekts (gohyperlevel.com) unter `/` (Englisch), `/de`, `/vergleich`, `/vergleich/highlevel` und `/sitemap.xml` – nur auf der eigenen Adresse (`PGHL_BASE_URL`); jede andere Domain (Kunden-Login, Cloud-Subdomain) bleibt bei der App. Standard aus: dann ist `/` die Web-App – [docs/landing.md](landing.md) |
| `PGHL_LANDING_HOSTS` | Weitere Hosts mit Startseite, durch Komma getrennt (z. B. `gohyperlevel.de`); die eigene Adresse und ihr `www.`-Partner gehören immer dazu |
| `PGHL_LANDING_IMPRESSUM_URL`, `PGHL_LANDING_PRIVACY_URL` | Impressum und Datenschutzerklärung der Startseite, wenn der Cloud-Modus aus ist (mit Cloud-Modus verlinkt sie `/cloud/legal/impressum` und `/cloud/legal/datenschutz`) |

### KI

| Variable | Bedeutung |
| --- | --- |
| `PGHL_ANTHROPIC_API_KEY` | Optional: Anthropic-Schlüssel für den KI-Assistenten aller Sub-Accounts ohne eigenen Schlüssel (Monatslimit gilt je Sub-Account, [docs/ai-assistant.md](ai-assistant.md)) |
| `PGHL_OPENAI_API_KEY` | Optional: OpenAI-Schlüssel für den KI-Assistenten jedes Sub-Accounts, der OpenAI ohne eigenen oder Agentur-Schlüssel nutzt ([docs/ai-assistant.md](ai-assistant.md#ki-anbieter-anthropic-oder-openai)) |
| `PGHL_COMPOSIO_API_KEY` | Optional: Composio-Schlüssel der Agentur statt *Agentur → Integrationen → Einrichtung* ([docs/connectors.md](connectors.md)) |
| `PGHL_GENMEDIA_MAX_IMAGE_MB`, `PGHL_GENMEDIA_MAX_VIDEO_MB`, `PGHL_GENMEDIA_MAX_AUDIO_MB`, `PGHL_GENMEDIA_TIMEOUT_MIN` | KI-Studio: größtes Ergebnis, das gespeichert wird (Standard 30 / 200 / 60 MB), und nach wie vielen Minuten ein Auftrag aufgibt (Standard 15 / 20 / 45 je Art) – [docs/genmedia.md](genmedia.md) |
| `PGHL_SUBSCRIPTION_SIGNIN=off`, `PGHL_HOSTED=1`, `PGHL_CHATGPT_SIGNIN_APPROVED=1` | Abo-Anmeldung („Mit ChatGPT anmelden“): ganz ausschalten · diese Installation wird als gehosteter/bezahlter Dienst für andere betrieben (Anmeldung aus, bis OpenAI zugestimmt hat) · OpenAI hat zugestimmt ([docs/ai-providers.md](ai-providers.md#subscription-sign-in-mit-chatgpt-anmelden-mit-claude-verbinden)) |

### Integrationen

| Variable | Bedeutung |
| --- | --- |
| `PGHL_GOOGLE_CLIENT_ID`, `PGHL_GOOGLE_CLIENT_SECRET` | Optional: Google-OAuth-App für Kalender-Sync, Unternehmensprofil und Postfach-Sync, falls nicht unter *Agentur → Integrationen → Einrichtung* eingetragen ([Google & Microsoft verbinden](#google--microsoft-verbinden-oauth)) |
| `PGHL_MS_CLIENT_ID`, `PGHL_MS_CLIENT_SECRET`, `PGHL_MS_TENANT` | Optional: Microsoft-App (Entra ID) für den Outlook-Kalender und das Postfach; Mandant Standard `common` |
| `PGHL_GMAIL_PUBSUB_TOPIC` | Optional: Pub/Sub-Thema für Gmail-Push (`projects/<projekt>/topics/<name>`), falls nicht in den Postfach-Einstellungen eingetragen ([docs/mailbox-sync.md](mailbox-sync.md#gmail--cloud-pubsub)) |
| `PGHL_META_APP_ID`, `PGHL_META_APP_SECRET` | Optional: Meta-App der Agentur für den Anzeigen-Manager; gespeicherte Werte gehen vor ([docs/ads-manager.md](ads-manager.md)) |
| `PGHL_GOOGLE_ADS_DEVELOPER_TOKEN`, `PGHL_GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Optional: Developer-Token und Manager-Konto der Agentur für Google Ads; gespeicherte Werte gehen vor ([docs/ads-manager.md](ads-manager.md)) |
| `PGHL_NANGO_URL`, `PGHL_NANGO_SECRET_KEY`, `PGHL_NANGO_WEBHOOK_KEY`, `PGHL_NANGO_CONNECT_URL`, `PGHL_NANGO_ALLOW_PRIVATE=1` | Optional: Nango-Zugang statt *Agentur → Integrationen → Nango* (ohne URL Nango Cloud; `ALLOW_PRIVATE` für `http://nango-server:3003` im Docker-Netz). Selbst gehostetes Nango: `docker compose --profile nango` – [deploy/nango/](../deploy/nango/README.md), [docs/nango.md](nango.md) |
| `PGHL_POSTIZ_URL`, `PGHL_POSTIZ_KEY` | Optional: selbst gehostetes Postiz für den Social Planner, falls nicht unter *Agentur → Integrationen → Einrichtung* eingetragen ([Social Planner](#social-planner-postiz)) |
| `PGHL_OPENSHORTS_URL`, `PGHL_OPENSHORTS_KEY` | Optional: OpenShorts für das Video-Studio, falls nicht unter *Agentur → Integrationen → Einrichtung* eingetragen ([Video-Studio](#video-studio-openshorts)) |
| `PGHL_PUSH_CONTACT` | Kontaktadresse für Push-Dienste (Web Push/VAPID), z. B. `mailto:du@example.com` (Standard: E-Mail des ersten Admins) – siehe [App & Push](app.md) |
| `PGHL_PUSH_MODE` | Native Mitteilungen der Apps: `relay` (Standard, über das Push-Relay des Betreibers), `own` (eigene FCM-/APNs-Schlüssel, für eigene Marken-Apps) oder `off` – siehe [Apps](apps.md#push) |
| `PGHL_PUSH_RELAY_URL` | Adresse des Push-Relays (Standard `https://gohyperlevel.com`) – siehe [Apps](apps.md#push) |
| `PGHL_FCM_SERVICE_ACCOUNT`, `PGHL_APNS_KEY`, `PGHL_APNS_KEY_ID`, `PGHL_APNS_TEAM_ID`, `PGHL_APNS_TOPIC`, `PGHL_APNS_SANDBOX` | Eigene Push-Schlüssel (Pfad oder Inhalt): Firebase-Dienstkonto-JSON, APNs-Schlüssel (.p8) mit Key-ID, Team-ID und Bundle-ID; `PGHL_APNS_SANDBOX=1` für Entwicklungs-Builds. Gebraucht mit `PGHL_PUSH_MODE=own` und auf dem Relay – siehe [Apps](apps.md#push) |
| `PGHL_PUSH_RELAY`, `PGHL_PUSH_RELAY_RATE` | Nur die Cloud-Instanz des Betreibers: `1` schaltet das Push-Relay für die Gray-Label-App ein; Limit je Instanz in Mitteilungen pro Minute (Standard 600) – siehe [Apps](apps.md#push-relay) |
| `PGHL_APP_DIRECTORY` | Nur die Cloud-Instanz des Betreibers: `1` schaltet das Verzeichnis E-Mail-Domain/Agentur-Code → Instanz ein – siehe [Apps](apps.md#discovery) |

### Inhalte: Kurse, Community, Formulare, Webinare, Websites, Umzug

| Variable | Bedeutung |
| --- | --- |
| `PGHL_COURSE_VIDEO_MB`, `PGHL_COURSE_URL_TTL_MIN` | Kurse: größtes Kursvideo beim Hochladen in MB (Standard 2048) und wie lange die signierten Video-Links eines Mitglieds gelten (Minuten, Standard 360) – [docs/courses.md](courses.md) |
| `PGHL_FFMPEG`, `PGHL_FFPROBE`, `PGHL_COURSE_HLS`, `PGHL_COURSE_NO_FFMPEG` | Kurse: optionales ffmpeg (wird von selbst gefunden; Titelbild, HLS, KI-Untertitel), Pfade dazu, `PGHL_COURSE_HLS=1` wandelt jeden Upload in HLS, `PGHL_COURSE_NO_FFMPEG=1` schaltet ffmpeg ab |
| `PGHL_FORMS_PER_MINUTE` | Formulare: Einsendungen pro Minute und Adresse (Standard 20) – [docs/forms.md](forms.md) |
| `PGHL_PUBLIC_UPLOADS_MB` | Formulare: Speicher für Dateien, die Besucher über öffentliche Formulare hochladen, je Sub-Account in MB (Standard 2048, `0` = ohne eigene Grenze); darüber wird eine Einsendung mit Datei mit 413 abgelehnt, das Team hört bei 90 % und 100 % davon – [docs/forms.md](forms.md#limits-and-settings) |
| `PGHL_TESTIMONIALS_MB` | Video-Testimonials: Speicher für die Videos, die Kunden über die Sammelseite schicken, je Sub-Account in MB (Standard 2048, `0` = ohne eigene Grenze; in der Cloud zählt zusätzlich der Medien-Speicher des Tarifs); darüber nimmt die Sammelseite keine neuen Videos an (413) – [docs/reputation.md](reputation.md#video-testimonials) |
| `PGHL_COMMUNITY_DISCOVERY=0`, `PGHL_COMMUNITY_VIDEO_MB`, `PGHL_JITSI_URL` | Community: öffentliches Verzeichnis `/communities` für den ganzen Server abschalten, größtes Video je Beitrag in MB (Standard 500), Jitsi-Server für Live-Calls (Standard `https://meet.jit.si`) – [docs/community.md](community.md) |
| `PGHL_WEBINAR_MAX_MB` | Optional: größte Videodatei für ein Webinar in MB (Standard 4096) – siehe [Webinare](#webinare-automatisierte-webinare) |
| `PGHL_IMAGE_ENGINE=off` | Websites: den optionalen Bild-Motor (`sharp`, falls installiert) abschalten – [docs/sites.md](sites.md) |
| `PGHL_OFFICE_DIR`, `PGHL_OFFICE_BIN_DIR`, `PGHL_OFFICE_SANDBOX`, `PGHL_OFFICE_MAX_MB`, `PGHL_OFFICE_QUOTA_MB` | Office: Ordner mit den optionalen Browser-Editoren (je Art `docx/`, `xlsx/`, `pptx/`, `pdf/`) und den Engines (Kommandozeilenprogramme für Agent-Bearbeitung und PDF-Export), Sandbox der Editoren (`strict`, Standard, oder `same-origin`), größte Datei in MB (Standard 25) und Speicher je Sub-Account in MB (Standard 2048, `0` = ohne Grenze) – Einrichtung mit `deploy/office/` siehe [Office](#office-dokumente-tabellen-präsentationen-pdf) und [docs/office.md](office.md#einrichtung-server) |
| `PGHL_PROJECT_FILES_MB` | Projektdateien (Anweisungen, Wissensdateien und Repo-Dateien, die Claude über MCP ablegt): Speicher je Sub-Account in MB (Standard 1024, `0` = ohne eigene Grenze; in der Cloud zählt zusätzlich der Medien-Speicher des Tarifs) – siehe [docs/ai-tools.md](ai-tools.md#project-files) |
| `PGHL_CONTACT_DOCS_MB` | Dokumente am Kontakt und Anhänge an Notizen: Speicher je Sub-Account in MB (Standard 2048, `0` = ohne Grenze; je Datei höchstens 8 MB) – siehe [docs/sales.md](sales.md#crm-housekeeping) |
| `PGHL_APPS_ORIGIN` | AI Studio: eigener Host für veröffentlichte Apps, z. B. `https://apps.example.com` (DNS auf diesen Server; dort antworten nur `/apps/<adresse>/`, keine Cookies der App) – ohne die Variable liegen sie unter der Adresse der Installation – [docs/ai-studio.md](ai-studio.md#publish) |
| `PGHL_UMZUG_MAX_MB` | Optional: größte Export-Datei für den Umzug in MB (Standard 50, höchstens 500) – siehe [Umzug](#umzug-zu-hyperlevel) |

### Android, Domains, Partner-Links, Screenshots

| Variable | Bedeutung |
| --- | --- |
| `PGHL_ANDROID_CERT_SHA256`, `PGHL_ANDROID_PACKAGE` | Optional: SHA-256-Fingerabdruck(e) des Signatur-Zertifikats deiner Android-App (komma-getrennt) und ihre Paket-ID (Standard `org.gohigh.android`) für `/.well-known/assetlinks.json` – ohne Fingerabdruck sind App Links aus; die Einstellung der Agentur hat Vorrang – siehe [Android-App](app.md#android-app) |
| `PGHL_AGENT_TOKEN`, `PGHL_SERVER_IP` | Domain-Agent für eigene Kunden-Domains: gemeinsames Geheimnis zwischen App und Agent, öffentliche IP(s) des Servers ([Domain-Agent](#domain-agent)) |
| `PGHL_REFERRALS_DISABLED=1` | Nur schlichte Anmelde-Links der Anbieter: schaltet jeden Partner-Link hinter „Konto anlegen“ ab, was auch unter *Agentur → Partner-Links* steht ([Partner-Links](#partner-links)) |
| `PGHL_REFERRALS` | Optional: eigene Partner-Links als JSON, z. B. `{"kie":"https://kie.ai/?ref=me","stripe":""}` (`""` = schlichte Anmeldeseite); Einstellungen der Agentur gehen vor ([docs/referrals.md](referrals.md)) |
| `PGHL_PLUGIN_SCREENSHOTS=1`, `PGHL_CHROMIUM`, `PGHL_CHROMIUM_NO_SANDBOX=1` | Werkstatt/Marktplatz: Vorschaubilder automatisch mit einem Chromium auf dem Server aufnehmen (Standard aus), Pfad zum Chromium, Chromium ohne eigene Sandbox (nur in Wegwerf-Containern) – [docs/werkstatt.md](werkstatt.md#configuration) |

## Mit Docker (empfohlen)

```bash
curl -fsSL https://raw.githubusercontent.com/BAISESYSTEMS/hyperlevel/main/scripts/install.sh | bash
```

Das Skript fragt Domain und Admin-E-Mail, erzeugt Passwort und `PGHL_SECRET`, schreibt `.env` und startet `docker-compose.yml` mit Caddy (automatisches HTTPS). Von Hand: `cp .env.example .env`, Werte setzen, `docker compose --profile caddy up -d`. Ohne `PGHL_ADMIN_EMAIL`/`PGHL_ADMIN_PASSWORD` legst du das erste Konto im Browser an (Einrichtungsseite).

## Ohne Docker

```bash
npm ci && npm run build
PGHL_BASE_URL=https://crm.example.com PGHL_BEHIND_PROXY=1 npm start
```

Davor einen Reverse-Proxy mit HTTPS (Caddy: `crm.example.com { reverse_proxy 127.0.0.1:4700 }`) und als Dienst starten (systemd, pm2).

## Echtzeit hinter dem Reverse-Proxy (Team-Chat, Canvas)

Der Team-Chat ([docs/team-chat.md](team-chat.md)), die gemeinsamen Canvas-Boards und die Living Boards
([docs/living-boards.md](living-boards.md)) halten pro offenem Tab eine Verbindung per Server-Sent Events
(`/api/team-chat/stream`, `/api/canvas/<id>/stream`, `/api/boards/<id>/stream`). Caddy und Traefik reichen
sie ohne Zutun durch. Bei nginx brauchst du für diese Pfade `proxy_buffering off;` und ein großzügiges
`proxy_read_timeout` (HyperLevel sendet alle 20 Sekunden einen Herzschlag). Ist die Verbindung blockiert, funktioniert der
Chat weiter – Nachrichten erscheinen dann erst nach dem Senden oder Neuladen. Ein HyperLevel-Prozess bedient alle Streams
(bis 600 offene, 8 je Person); die Dateien des Chats liegen unter `data/teamchat-files` und sind im Backup enthalten.

## Eigene Domains

Funnels können eine eigene Domain bekommen (Funnel → Einstellungen & Domain). Die App erkennt die Domain am `Host`-Header und liefert den Funnel auf `/` aus. Für HTTPS muss der Proxy die Domain kennen:

- **Traefik:** in den Labels die Regel erweitern: ``traefik.http.routers.pghl.rule=Host(`crm.example.com`) || Host(`www.meine-seite.de`)`` und Container neu erstellen.
- **Caddy** (`docker compose --profile caddy`): nichts zu tun – [`deploy/caddy/Caddyfile`](../deploy/caddy/Caddyfile) holt Zertifikate beim ersten Aufruf (`on_demand_tls`) und fragt vorher `GET /api/tls/ask?domain=…`, ob HyperLevel die Domain kennt (Funnel-/Website-Domain samt `www`-Partner, Agentur- oder Kunden-Login-Domain).

**`robots.txt` und `favicon.ico`:** Auf der Domain der App (und Agentur-/Kunden-Login-Domains) liefert HyperLevel eine eigene `robots.txt` – öffentliche Seiten (Websites unter `/p/`, Formulare, Buchungs- und Webinar-Seiten, Hilfe-Center, Communities) sind frei, gesperrt sind `/app`, `/api/` und alle persönlichen oder einmaligen Links (Rechnungen, Angebote, Verträge, Tracking-, Abmelde- und Bestätigungslinks, Mitgliederbereich; Liste in `server/modules/root-files.ts`). `/favicon.ico` liefert das App-Symbol aus dem Build. Websites auf eigener Domain behalten ihre eigene `robots.txt` und `sitemap.xml`.

## Domain-Agent

Für Server mit **nginx + certbot auf dem Host**: der Dienst `domain-agent` (Vorlage in [`deploy/examples/nginx-domain-agent/`](../deploy/examples/nginx-domain-agent/)) betritt per `nsenter` den Host und

1. fragt die App alle 60 s nach den gewünschten Domains (Funnel-Domains samt `www`-Partner, Agentur-App-Domain),
2. wartet, bis das DNS auf `PGHL_SERVER_IP` zeigt,
3. schreibt `/etc/nginx/sites-available/pghl-<domain>` (Proxy auf die App), prüft mit `nginx -t`, lädt neu,
4. holt mit `certbot --nginx` das Zertifikat und meldet den Status zurück (sichtbar unter Agentur → Domains).

Er fasst nur Dateien `pghl-*` an, lehnt Domains ab, die eine andere Seite auf dem Server schon nutzt, prüft jede Domain gegen ein strenges Muster und ruft Befehle ohne Shell auf. Entfernte Domains räumt er wieder ab. Der Container läuft privilegiert (er ist dafür da, nginx auf dem Host zu verwalten).

| Variable | Bedeutung |
| --- | --- |
| `PGHL_AGENT_TOKEN` | Gemeinsames Geheimnis zwischen App und Agent (beide Dienste) |
| `PGHL_SERVER_IP` | Öffentliche IP(s) des Servers, komma-getrennt; wird Kunden auch als DNS-Ziel angezeigt |
| `PGHL_APP_PORT` | Port der App auf dem Host (Standard 4700) |
| `PGHL_AGENT_PREFIX` | Datei-Präfix der nginx-Seiten dieses Agenten (Standard `pghl-`) – eine zweite Instanz auf demselben Server bekommt ein eigenes (z. B. `ghyl-`), damit kein Agent die Seiten des anderen entfernt |

Ohne Agent (Traefik, Caddy, Dokploy…) laufen eigene Domains genauso, nur trägst du sie im Proxy ein.

## Off-site-Backup, Überwachung und Statusseite

Das tägliche Backup in `data/backups/` liegt auf derselben Platte wie die App. Für den Ernstfall gehört eine Kopie woandershin:
mit den Variablen `PGHL_BACKUP_S3_*` und `PGHL_BACKUP_KEY` sichert HyperLevel stündlich verschlüsselt in einen S3-kompatiblen Speicher,
prüft einmal im Monat selbst, ob sich die Sicherung wiederherstellen lässt, und stellt mit `npm run backup:restore -- latest --files`
in einen eigenen Ordner wieder her. Für eine externe Überwachung (UptimeRobot, Better Stack, Uptime Kuma) taugt
`/healthz?strict=1`; Alarme gehen per E-Mail, Push und Webhook raus. Status unter *Agentur → System → Betrieb*. Anleitung:
[docs/backups.md](backups.md), für den Ernstfall das [Incident-Runbook](incident-runbook.md).

## Updates

`git pull && docker compose up -d --build` (bzw. im Docker Manager mit `PGHL_REBUILD=1` neu erstellen). Datenbank-Migrationen laufen beim Start automatisch.

Das Image läuft seit Oktober 2026 als Benutzer `node` (nicht root, `cap_drop: ALL`). Bei einem Volume aus der Zeit davor einmal die Rechte übertragen: `docker compose run --rm -u root gohigh chown -R node:node /data`.

## Sicherheit & Schlüssel

Überblick, Bedrohungsmodell und Checkliste: [security.md](security.md).

- `data/secret` signiert Links, `data/data.key` (falls vorhanden) verschlüsselt gespeicherte Zugangsdaten. Beide gehören nicht in Backups, die du weitergibst – getrennt sichern.
- **Schlüssel wechseln** (nach einem Verdacht oder regelmäßig): Server stoppen, dann `npm run rotate-secret` (Docker: `docker compose run --rm gohigh node dist-server/server/cli/rotate-secret.js`). Alle gespeicherten Zugangsdaten werden mit einem neuen Schlüssel versiegelt, der alte bleibt in `data/data.key.previous` lesbar (für ältere Backups). `--dry-run` zählt nur, `--signing` erneuert zusätzlich `data/secret` (alte Abmelde-, Umfrage- und Tracking-Links funktionieren dann nicht mehr). Mit `PGHL_DATA_KEY` in der Umgebung schreibt das Werkzeug nichts, sondern gibt den neuen Schlüssel aus.
- Erster Admin am besten per `PGHL_ADMIN_EMAIL`/`PGHL_ADMIN_PASSWORD` – solange keiner existiert, wird Admin, wer die Einrichtungsseite zuerst öffnet.

## Kunden-Login-Domains

Unter **Agentur → Kunden → Branding** bekommt ein Kunde optional eine eigene Login-Domain (z. B. `crm.kunde.de`). Der Domain-Agent behandelt sie wie die App-Domain: A-Record auf `PGHL_SERVER_IP`, dann richtet er nginx und das Zertifikat ein. Die Login-Seite dort zeigt Logo, Farbe und Texte des Kunden; nach dem Login sehen Kunden-Logins überall das Kunden-Branding.

## Live-Chat, Verträge und Trigger-Links auf eigenen Domains

Auf Funnel-Domains werden `/chat/…`, `/s/…` (Verträge), `/l/…` (Trigger-Links) und `/t/…` (Mail-Tracking) unverändert an die App durchgereicht, damit die Widgets und Links auch dort funktionieren.

## Social Planner (Postiz)

Der Social Planner veröffentlicht über ein selbst gehostetes [Postiz](https://github.com/gitroomhq/postiz-app). Postiz läuft als eigener Dienst (eigene Updates, eigene Lizenz AGPL-3.0); HyperLevel nutzt nur dessen öffentliche API und übernimmt keinen Postiz-Code.

1. In Postiz unter **Einstellungen → Public API** einen Schlüssel erzeugen.
2. In HyperLevel **Agentur → Integrationen → Einrichtung**: Postiz-Adresse (z. B. `https://postiz.example.com`) und Schlüssel eintragen. Alternativ per Umgebung: `PGHL_POSTIZ_URL`, `PGHL_POSTIZ_KEY`.
3. Jeden Postiz-Kanal einem Sub-Account zuordnen. Verbindet ein Kunde im Social Planner selbst einen Kanal („+ Kanal verbinden“), wird der neue Kanal automatisch seinem Sub-Account zugeordnet.

Kunden sehen nur ihre eigenen Kanäle und Posts, die Postiz-Adresse nur Agentur-Admins. Text-Posts für Video-Plattformen (YouTube, TikTok) und Newsletter (Listmonk) plant man weiter direkt in Postiz; Clips aus dem [Video-Studio](video-studio.md) gehen auch auf YouTube Shorts und TikTok. Postiz begrenzt das Anlegen von Posts (je nach Version 30–90 pro Stunde); Listen werden kurz zwischengespeichert.

## Video-Studio (OpenShorts)

Das Video-Studio schneidet über ein [OpenShorts](https://github.com/mutonby/openshorts) (MIT) – als eigener Dienst neben HyperLevel oder die gehostete API von openshorts.app; HyperLevel nutzt nur dessen REST-API.

1. `cd deploy/openshorts && cp .env.example .env` – `GEMINI_API_KEY` (oder `LLM_BASE_URL` auf einen OpenAI-kompatiblen Server) und `GOHIGH_NETWORK` (Docker-Netz von HyperLevel, z. B. `gohigh_default`) eintragen.
2. `docker compose up -d --build` – CPU-Image, ein Job gleichzeitig, Standard 3 CPUs / 6 GB RAM und niedrigere CPU-Priorität als das CRM, kein offener Port. Rechnet mit 5–8 Minuten je 8 Minuten Video.
3. In HyperLevel **Agentur → Integrationen → Einrichtung → OpenShorts**: Adresse `http://openshorts:8000` → „Speichern & testen“.

HyperLevel muss per https öffentlich erreichbar sein, damit OpenShorts Fertig-Meldungen schicken (sonst nur Abfrage) und Postiz Clips abholen kann. Platz: Image ca. 4 GB, Modelle ca. 1 GB, Jobs je nach Länge (begrenzt mit `OUTPUT_MAX_GB`/`UPLOADS_MAX_GB`, Aufbewahrung `JOB_RETENTION_SECONDS`, Vorlage 7 Tage). Alles Weitere: [video-studio.md](video-studio.md).

## Office (Dokumente, Tabellen, Präsentationen, PDF)

Der Bereich *Office* läuft ohne Zusatz (Dateien, Versionen, Kommentare, Text lesen durch den Agenten). Für das Bearbeiten
im Browser und Agent-Bearbeitung/PDF-Export kommen optionale Open-Source-Editoren und -Engines dazu – nicht im HyperLevel-Image,
sondern per `docker compose -f docker-compose.yml -f deploy/office/docker-compose.office.yml up -d --build` (eigenes Image auf
Debian-Basis mit geprüften Releases) oder `deploy/office/install.sh` auf dem Server. Variablen, Release-Dateien, Sicherheit und
Grenzen: [docs/office.md](office.md#einrichtung-server).

## Webinare (automatisierte Webinare)

Nichts zu installieren – kein Zoom, kein Streaming-Server, keine WebSockets. Wichtig sind eine öffentliche `https://`-Adresse in `PGHL_BASE_URL` (steht in jedem Link der Bestätigungs- und Erinnerungs-Mails), ein E-Mail-/SMS-Sender im Sub-Account, der laufende Hintergrund-Takt (`PGHL_TICK_MS`: Erinnerungen und Abschluss der Termine) und Platz in `data/webinars/` für hochgeladene Videos. Ein Reverse-Proxy muss `PUT`-Bodies bis 8 MB und Range-Anfragen durchlassen (nginx: `client_max_body_size 16m;` und `proxy_buffering off;` für `/w/`). HLS in Chrome/Firefox braucht optional die Datei `data/webinar-assets/hls.min.js`. Einzelheiten, Grenzen (`PGHL_WEBINAR_MAX_MB`) und die Rechtslage (UWG): [docs/webinars.md](webinars.md#self-hosting).

## Umzug zu HyperLevel

Nichts zu installieren. Für die Anbindung per Schlüssel braucht der Server ausgehendes HTTPS zu `<dc>.api.mailchimp.com`, `*.api-us1.com` bzw. `*.activehosted.com`, `api.kit.com`, `api.kajabi.com`, `developers.teachable.com`, `api.infusionsoft.com`, `api.pipedrive.com` bzw. `<firma>.pipedrive.com`, `api.systeme.io`, `a.klaviyo.com`, `api.brevo.com`, `api.klicktipp.com`, `api.manychat.com`, `<subdomain>.zendesk.com`, `api.intercom.io` (EU: `api.eu.intercom.io`, Australien: `api.au.intercom.io`), der My-Domain-Adresse deiner Salesforce-Org (`<name>.my.salesforce.com`), `www.zohoapis.<region>` und `accounts.zoho.<region>`, `api.monday.com`, `api.clickup.com`, `api.notion.com`, `api.airtable.com`, `api.typeform.com` (EU: `api.eu.typeform.com`), `api.calendly.com`, `api.lexware.io` und `my.sevdesk.de` – Export-Dateien brauchen keine Verbindung nach außen. Ein Reverse-Proxy davor muss für `POST /api/umzug/files` Rümpfe bis `PGHL_UMZUG_MAX_MB` durchlassen. Hochgeladene Dateien liegen in `data/umzug/` (Rechte 0600), werden nach dem Import gelöscht und spätestens nach 14 Tagen; `data/` gehört wie immer ins Backup. Details: [umzug.md](umzug.md) (englisch).

## E-Mail-Zustellung prüfen

Nichts zu konfigurieren: Der Server fragt DNS selbst ab (`node:dns`, also muss der Container öffentliche Namen auflösen können – der Docker-Standard tut das) und bei verbundenen Versand-Anbietern deren API. `PGHL_BASE_URL` muss deine öffentliche `https://`-Adresse sein, denn sie steht in jedem Abmeldelink (One-Click-Abmeldung nach RFC 8058). Details: [deliverability.md](deliverability.md) (englisch).

## WhatsApp, Messenger & Instagram

Meta stellt Nachrichten an `https://<domain>/hooks/meta/<locationId>` zu (GET zum Prüfen, POST mit Signatur). Die Adresse muss öffentlich per https erreichbar sein und der Proxy muss den Rumpf unverändert durchreichen (sonst passt die Signatur nicht). Zugangsdaten trägt jeder Sub-Account unter **Einstellungen → Kanäle** ein; Anleitung: [meta-channels.md](meta-channels.md).

## Telefonie (Twilio)

**Einstellungen → Telefonie** (je Sub-Account). Du brauchst ein Twilio-Konto mit einer Telefonnummer (für deutsche Nummern verlangt Twilio einen Adressnachweis).

1. **Account SID** und **Auth Token** aus der Twilio-Konsole eintragen. Ist SMS schon über Twilio eingerichtet (*E-Mail & SMS*), nimmt die Telefonie diese Daten, solange die Felder leer bleiben. Der Token wird verschlüsselt gespeichert (AES-256-GCM mit dem Schlüssel aus `data/secret`) und nie wieder angezeigt.
2. **Nummern von Twilio laden → Verbinden**: trägt bei der Twilio-Nummer die beiden Webhooks ein (*A call comes in* → `/hooks/twilio/voice/<locationId>`, *Call status changes* → `/hooks/twilio/voice-status/<locationId>`, beide POST). Von Hand geht es unter Twilio → Phone Numbers → Nummer → Voice Configuration; die Adressen stehen in den Einstellungen.
3. **Weiterleiten an** = deine Handynummer (mehrere klingeln gleichzeitig), **Klingeldauer** kürzer als deine Handy-Mailbox, **Erreichbarkeit** (zu Geschäftszeiten / immer / nie), **Geschäftszeiten** je Wochentag in der Zeitzone des Sub-Accounts, **Ansage** (Platzhalter `{{location.name}}`, deutsche Computerstimme), Voicemail an/aus, Höchstlänge, Transkription (Twilio, bis 2 Minuten, zuverlässig nur auf Englisch), E-Mail ans Team bei Voicemail bzw. verpasstem Anruf.
4. **Testanruf an mein Handy** prüft Zugangsdaten und Nummern.

So läuft es:

- **Klick-Anruf** („Anrufen“ beim Kontakt, in Konversationen, „Zurückrufen“ in der Anrufliste): Twilio ruft zuerst dein Handy an, sagt „Verbinde mit …“ und verbindet dann mit dem Kontakt – der sieht deine Twilio-Nummer. API: `POST /api/calls {contact_id, record?}`.
- **Eingehend:** zu Geschäftszeiten klingelt dein Handy (der Anrufer wird als Nummer angezeigt); nimmt niemand ab oder ist geschlossen, kommen Ansage und Voicemail. Unbekannte Nummern werden als Kontakt angelegt (Quelle „Anruf“).
- **Anrufliste** (Menü *Anrufe*), Einträge mit Kanal „Anruf“ in Konversationen (verpasste Anrufe rot, Voicemail zum Anhören) und in der Kontakt-Timeline. Aufnahmen bleiben bei Twilio und werden nur über die App mit Anmeldung abgespielt (Twilio verlangt für Aufnahme-Links die Zugangsdaten); in der Anrufliste lassen sie sich löschen, auch bei Twilio.
- **Workflows:** Auslöser „Anruf verpasst“ (auch mit Voicemail), „Voicemail erhalten“ und „Anruf beendet“ (angenommen/verbunden, wahlweise nur ein- oder ausgehend). Die Vorlage „Verpasster Anruf: SMS zurück + Rückruf-Aufgabe“ schickt sofort eine SMS über den eingerichteten SMS-Anbieter.
- **Aufzeichnung** (Klick-Anrufe und/oder angenommene eingehende Anrufe) ist aus; nur mit Einwilligung aller Beteiligten einschalten (§ 201 StGB, DSGVO). Ist sie an, sagt die App vor dem Verbinden **standardmäßig einen Hinweis an** („Dieses Gespräch wird zur Qualitätssicherung aufgezeichnet …“ – eingehend dem Anrufer, ausgehend der angerufenen Person; Wortlaut und Ausschalten unter *Aufzeichnung*), und **Aufbewahrungsfristen** löschen Aufnahmen und Voicemails nach der gewählten Zeit auch bei Twilio.
- **Mehr als Weiterleitung:** Telefonmenü, Ruf-Gruppen und Warteschlangen, Nummern kaufen und freigeben, Tracking-Nummern, Power-Dialer und Gesprächsauswertung stehen in [docs/telephony.md](telephony.md).

Alle Twilio-Webhooks werden mit `X-Twilio-Signature` (HMAC-SHA1 über die volle URL und die sortierten POST-Parameter mit dem Auth Token) geprüft; ohne gültige Signatur antwortet die App mit 403. `PGHL_BASE_URL` muss deshalb genau die Adresse sein, die bei Twilio eingetragen ist. Kommt der letzte Status-Callback nie an (Nummer ohne Status-URL), wird ein offener Anruf nach Twilios 4-Stunden-Grenze abgeschlossen.

## Browser-Telefon (Twilio Voice SDK)

**Einstellungen → Telefonie → Browser-Telefon** (je Sub-Account, setzt die Twilio-Telefonie oben voraus). Damit telefoniert das Team direkt in der App über WebRTC – Headset empfohlen, die App muss per **HTTPS** laufen (oder `localhost`) und der Browser fragt beim ersten Anruf nach dem Mikrofon.

1. **API-Schlüssel:** Twilio-Konsole → *Account → API keys & tokens → Create API key* (Typ *Standard*). **API Key SID** (`SK…`) und **Secret** eintragen. Das Secret wird verschlüsselt gespeichert (AES-256-GCM mit dem Schlüssel aus `data/secret`) und nie wieder angezeigt; die App signiert damit kurzlebige Access Tokens (1 Stunde, JWT mit *VoiceGrant*, Identität je Nutzer und Sub-Account).
2. **TwiML App:** Twilio → *Voice → TwiML Apps → Create*: *Voice Request URL* = `https://<domain>/hooks/twilio/phone-out/<locationId>` (POST), optional *Status Callback URL* = `/hooks/twilio/voice-status/<locationId>`. Die **TwiML App SID** (`AP…`) eintragen. Je Sub-Account eine eigene App.
3. Bequemer: **Bei Twilio automatisch einrichten** legt fehlenden API-Schlüssel und TwiML-App mit Account SID und Auth Token an (bzw. trägt die Adressen bei der vorhandenen App ein).
4. **Eingehende Anrufe:** *Browser und Handy gleichzeitig*, *nur im Browser* (das Handy klingelt nur, wenn niemand im Browser erreichbar ist) oder *nur Handy* (Browser nur ausgehend). **Twilio-Standort** (Edge) nur ändern, wenn nötig – *Automatisch* nimmt den nächsten.
5. Haken **Browser-Telefon einschalten**, speichern.

So läuft es:

- Rechts unten erscheint der **Telefon-Knopf** (für alle mit Zugriff auf Konversationen): Wähltastatur, **Für eingehende Anrufe erreichbar** an/aus, Mikrofon/Lautsprecher/Klingelton wählen. Während eines Anrufs: Timer, **Stumm**, **Halten** (der Anrufer hört Wartemusik; *Fortsetzen* holt ihn zurück), **Tasten** (Tonwahl/DTMF), **Auflegen**. Das Fenster bleibt beim Wechseln der Seiten offen, der Anruf läuft weiter.
- **Anrufen** beim Kontakt, in Konversationen und **Zurückrufen**/**Wählen** in der Anrufliste telefonieren im Browser, sobald das Browser-Telefon bereit ist (sonst wie bisher Klick-Anruf übers Handy). Angezeigt wird die Twilio-Nummer des Sub-Accounts; Aufzeichnung folgt der Einstellung „Klick-Anrufe aufzeichnen“.
- **Eingehend** klingeln die Browser aller Nutzer, die gerade erreichbar sind (die App meldet das alle 45 Sekunden; nach 90 Sekunden ohne Meldung gilt man als weg), mit Name/Nummer im Popup: **Annehmen**, **Ablehnen**, ✕ bzw. Esc = hier nicht mehr klingeln.
- Alle Anrufe landen wie gewohnt in Anrufliste, Konversationen und Kontakt-Timeline (mit wer angenommen hat).
- **Halten** parkt den Gesprächspartner in einem Twilio-Konferenzraum (`hold-<Anruf-ID>`); die Browser-Verbindung endet und wird beim Fortsetzen neu aufgebaut. Legt der Gesprächspartner in der Warteschleife auf, verschwindet der gehaltene Anruf.
- Content-Security-Policy: die App erlaubt zusätzlich nur `wss://voice-js.<edge>.twilio.com` (Signalisierung) und `https://sdk.twilio.com` (Klingeltöne); Gesprächsqualitäts-Berichte an Twilio Insights sind aus. Das SDK wird erst geladen, wenn das Browser-Telefon an ist.

## KI-Telefonagent

**Einstellungen → Telefonie → KI-Telefonagent** (je Sub-Account). Claude nimmt Anrufe an, beantwortet Fragen aus dem Wissen des KI-Assistenten, bucht Termine, nimmt Nachrichten auf oder verbindet weiter. Voraussetzungen: Twilio-Telefonie (oben) und ein eingeschalteter [KI-Assistent](ai-assistant.md) mit Anthropic-Schlüssel – dessen Wissen (Fakten, Fragen & Antworten, Projekt-Steckbrief, Website-FAQ), Modell und Monatslimit gelten auch am Telefon.

**Einstellungen:**

- **Wann nimmt der Agent ab?** *Nie*, *wenn niemand abnimmt* (statt Voicemail – nach der Klingeldauer oder außerhalb der Geschäftszeiten), *außerhalb der Geschäftszeiten* (Zeiten der Telefonie) oder *immer*.
- **Begrüßung** (Platzhalter `{{location.name}}`, `{{contact.first_name}}`), **Persona** und **Anweisungen** (was er tun und lassen soll), **Verabschiedung**.
- **Stimme:** deutsche neuronale Stimmen von Amazon Polly (Vicki, Daniel) und Google (Neural2, WaveNet) über Twilios `<Say>`, Sprache `de-DE`.
- **Werkzeuge:** Termine buchen (gewählte Kalender, sonst alle aktiven, höchstens drei; danach SMS mit Termin und Absage-Link an die Anrufernummer), Buchungslink per SMS, Nachricht → Rückruf-Aufgabe, Weiterverbinden (eigene Nummer oder die Weiterleitung der Telefonie plus erreichbare Browser-Telefone), Opportunity bei Kaufinteresse (Pipeline/Stufe). Freie Zeiten und Buchen sind dieselbe Logik, die auch der Chat-Bot des KI-Assistenten und die KI-Agenten mit der Stufe „Termin buchen“ nutzen ([KI bucht Termine](booking.md#ai-books-appointments)).
- **Grenzen:** Höchstdauer (Standard 8 Minuten) und Höchstzahl Gesprächsrunden je Anruf (Standard 16); höchstens 30 KI-Anrufe pro Stunde und Sub-Account.
- **Benachrichtigung:** E-Mail mit Zusammenfassung an die Firmen-E-Mail und/oder Push.

**So läuft ein Anruf:** Twilio fragt `/hooks/twilio/voice/<locationId>`; nimmt der Agent ab, antwortet die App mit `<Gather input="speech" language="de-DE" speechTimeout="auto">` und der Begrüßung (der Anrufer darf dazwischenreden). Was Twilio erkannt hat, kommt an `/hooks/twilio/voice-ai/<locationId>`, die App fragt Claude (Kontakt, freie Termine der nächsten 14 Tage, bisheriger Verlauf, Anweisungen) und spricht die kurze Antwort mit dem nächsten `<Gather>`. Claude antwortet als festes JSON (`say`, `action`, `args`); erlaubt sind nur `none`, `check_slots`, `book_appointment`, `take_message`, `create_task`, `create_opportunity`, `send_booking_link`, `transfer`, `end_call` – je nach Einstellung. Der Server prüft jede Antwort streng (bekannte Aktion, Felder, echte Daten/Uhrzeiten, Namen, E-Mail) und bucht nur Zeiten, die laut Kalender wirklich frei sind (sonst bekommt Claude die freien Zeiten und fragt nach); die Terminbestätigung mit Datum und Uhrzeit spricht die App selbst. Zustand jedes Gesprächs: Tabelle `voice_ai_sessions`.

- **Stille:** einmal nachfragen, beim zweiten Mal freundlich auflegen.
- **Langsam:** Braucht Claude länger als 9 Sekunden, sagt der Agent „Einen Moment bitte“ und holt die Antwort über `/hooks/twilio/voice-ai-wait/<locationId>`; nach rund 30 Sekunden ohne Antwort geht es auf die Voicemail.
- **Fehler** (Claude nicht erreichbar, zweimal unbrauchbare Antwort, Monatslimit erreicht): der Anrufer kommt auf die Voicemail der Telefonie. Ist das Limit schon vorher erreicht oder der KI-Assistent aus, nimmt der Agent gar nicht erst ab.
- **Weiterverbinden:** `<Dial>` an Nummer bzw. Handy + Browser; nimmt niemand ab, meldet `/hooks/twilio/voice-ai-transfer/<locationId>` das zurück und der Agent nimmt eine Nachricht auf.

**Danach:** Zusammenfassung und nächster Schritt (ein weiterer Claude-Aufruf) stehen am Anruf (Anrufliste, Knopf **KI-Verlauf** mit dem ganzen Gespräch) und als Eintrag in Konversationen; beim Kontakt eine Notiz mit Verlauf und ein Timeline-Eintrag. Der Workflow-Auslöser **„KI-Anruf beendet“** (Filter nach Ergebnis: Termin gebucht, weiterverbunden, Nachricht, Opportunity, Aufgabe, Buchungslink, Fragen beantwortet, aufgelegt, Voicemail, Limit, Fehler) startet z. B. eine Danke-SMS. Unbekannte Anrufer werden als Kontakt angelegt; nennen sie ihren Namen, wird er ergänzt (vorhandene Angaben werden nie überschrieben).

**Eigene Stimme statt Twilio-Stimme (optional):** Unter **Einstellungen → Stimme** den Telefon-Weg auf „Eigener Anbieter“ stellen – dann sprechen und hören ElevenLabs, OpenAI, Deepgram, Cartesia, Azure, Google oder ein lokaler Sprachserver (deine Schlüssel unter *KI-Anbieter*). Live über einen Twilio-Media-Stream (schnell, Anrufer können unterbrechen) braucht eine öffentliche `https://`-Adresse und einen Reverse-Proxy, der WebSocket-Upgrades auf `/hooks/twilio/stream/…` durchlässt (Caddy: von Haus aus; nginx: `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`). Ohne das nimmt HyperLevel Aufnahme-Runden; fällt ein Anbieter aus, spricht Twilio weiter. Alles Weitere: [docs/voice.md](voice.md).

**Kosten:** Jede Gesprächsrunde ist ein Claude-Aufruf (Zweck „KI-Telefonagent“ unter KI-Assistent → Nutzung & Limit), dazu einer für die Zusammenfassung – mit Sonnet 5.5 grob ein bis zwei Cent pro Runde (Schätzung nach Listenpreis; Wissen und Regeln kommen aus dem Prompt-Cache). Alles zählt aufs Monatslimit des KI-Assistenten. Twilio berechnet zusätzlich die Gesprächsminuten, die Spracherkennung von `<Gather>` und die neuronalen Stimmen (pro Zeichen) sowie bei Weiterleitung die zweite Verbindung – aktuelle Preise in der Twilio-Konsole.

**Hinweise:** Sag in der Begrüßung offen, dass eine KI spricht. Der Agent nutzt nur das hinterlegte Wissen und erfindet keine Preise oder Termine; Gesagtes des Anrufers ist für ihn Information, keine Anweisung. Alle Webhooks prüfen `X-Twilio-Signature` (siehe oben).

## Google-Bewertungen

**Einstellungen → Bewertungen → Google-Bewertungen** (je Sub-Account).

1. In der [Google Cloud Console](https://console.cloud.google.com/) ein Projekt anlegen, **Places API (New)** aktivieren (Abrechnung muss eingerichtet sein; ein Abruf am Tag liegt im Gratis-Kontingent), unter *Anmeldedaten* einen API-Schlüssel erstellen und auf die Places API beschränken.
2. Schlüssel eintragen und mit **Place ID finden** (Firmenname + Ort, nutzt die Places-Textsuche) das eigene Unternehmen übernehmen – oder die Place ID (`ChIJ…`) direkt eintragen. Der Schlüssel wird verschlüsselt gespeichert.
3. Die App holt sofort und danach einmal am Tag Sterne, Anzahl und die neuesten Rezensionen (`GET https://places.googleapis.com/v1/places/<id>`, Feldmaske `rating,userRatingCount,reviews`). Google gibt pro Abruf höchstens 5 Rezensionen heraus; neue sammeln sich über die Zeit an, doppelte werden erkannt. Vorhandene Rezensionen beim Verbinden lösen nichts aus.

Unter **Bewertungen** stehen Google-Sterne und -Anzahl mit Verlauf und alle gespeicherten Rezensionen; neue mit 3★ oder weniger gehen als E-Mail an die Team-Adresse des Sub-Accounts. Jede neue Rezension löst den Workflow-Auslöser „Neue Google-Bewertung“ aus (Filter „nur bis Sterne“); Workflows starten, wenn der Name des Rezensenten genau einem Kontakt entspricht, ausgehende Webhooks bekommen das Ereignis `google_review.received` immer. Das Bewertungs-Widget zeigt zusätzlich die Google-Sterne und gute Google-Rezensionen.

**Antworten und Beiträge (Unternehmensprofil verbinden):** Unter **Einstellungen → Bewertungen → Google-Unternehmensprofil** „Mit Google verbinden“ (mit dem Google-Konto, das das Profil verwaltet) und den Standort wählen. Dann kommen die Rezensionen über die Business Profile API statt über die Places API – alle (nicht nur 5), mit den vorhandenen Antworten; bereits per Places API gespeicherte Rezensionen desselben Orts werden übernommen, nicht verdoppelt. Unter **Bewertungen** antwortest du direkt („Antworten“, „Bearbeiten“, „Löschen“ – die Antwort ist sofort öffentlich) und veröffentlichst **Google-Beiträge** (Text bis 1500 Zeichen, optional Bild-URL und Button wie „Buchen“ oder „Anrufen“). Dasselbe gibt es als Workflow-Aktion **„Google-Beitrag erstellen“** (Platzhalter erlaubt) und per MCP (`ghl_reply_google_review`, `ghl_create_google_post`). Voraussetzung: die Google-OAuth-App der Agentur ([unten](#google--microsoft-verbinden-oauth)) und die **Freischaltung der Business Profile APIs durch Google** für dieses Cloud-Projekt. Ohne Verbindung bleibt alles wie oben (Places API, „Auf Google antworten“ öffnet die Rezension bei Google). Der angezeigte Direktlink „Bewertung schreiben“ passt als *Öffentliches Bewertungsprofil* für Bewertungsanfragen.

**KI-Antwort vorschlagen (Voraussetzung: KI-Assistent eingerichtet):** Unter jeder Google-Rezension steht **„KI-Antwort vorschlagen“** (mit Tonfall-Auswahl): der KI-Assistent schreibt eine öffentliche Antwort im Ton deines Unternehmens und legt sie als **Entwurf** ins Antwortfeld – du prüfst, änderst und klickst selbst auf „Öffentlich antworten“. Die KI veröffentlicht **nie** etwas; ohne verbundenes Unternehmensprofil kopierst du den Entwurf und fügst ihn bei Google ein. Unter *Bewertungen → KI-Antworten: Tonfall und Stil* stellst du **Tonfall** (freundlich, herzlich, professionell, sachlich, locker), **Anrede** (Sie/du), **eigene Hinweise** („Nenne nie Preise“), eine **Grußformel** unter jeder Antwort und den Schalter **„Für neue Bewertungen automatisch einen Entwurf schreiben“** ein (Standard aus; es entsteht nur ein Entwurf, markiert als „KI-Entwurf – bitte prüfen“). Die **Markenstimme** kommt aus *Einstellungen → KI-Assistent* (Persona und Fakten zum Unternehmen). Die Regeln im Prompt: Sprache der Bewertung, 2–5 Sätze, auf ein Detail eingehen, bei Kritik entschuldigen ohne Schuldeingeständnis und ein Gespräch anbieten, keine persönlichen Daten, keine Versprechen, nichts erfinden; der Rezensionstext gilt nur als Daten. Jeder Vorschlag zählt aufs KI-Monatslimit (Zweck „Bewertungsantwort“ im Protokoll), höchstens 60 pro Stunde und Sub-Account. MCP: `ghl_suggest_review_reply` (Entwurf anlegen, veröffentlicht nichts), `ghl_google_reviews` zeigt `reply_draft`.

## Google & Microsoft verbinden (OAuth)

Eine OAuth-Schicht für drei Dinge: den **Zwei-Wege-Abgleich mit Google Kalender** und **Outlook/Microsoft 365** (je Login) und das **Google-Unternehmensprofil** (je Sub-Account). Die Agentur trägt ihre Apps einmal unter **Agentur → Integrationen → Einrichtung → Google & Microsoft (OAuth)** ein (oder per Umgebungsvariablen, siehe oben). Clientschlüssel und alle Tokens werden verschlüsselt gespeichert (AES-256-GCM mit dem Schlüssel aus `data/secret`) und nie an den Browser gegeben.

**Weiterleitungs-URI:** `https://<PGHL_BASE_URL>/oauth/google/callback` bzw. `/oauth/microsoft/callback` – genau so, wie sie unter *Integrationen* angezeigt wird (mit aktiver Agentur-App-Domain kommt deren Adresse dazu; beide eintragen). Verbinden klappt auf der Adresse, auf der man angemeldet ist (Haupt-Adresse oder Agentur-Domain), nicht auf Kunden-Login-Domains.

**Postfach-Sync:** dieselben Apps und Weiterleitungs-URIs dienen auch für Gmail/Outlook (zusätzliche Berechtigungen `gmail.modify`/`gmail.send` bzw. `Mail.ReadWrite`/`Mail.Send`; Googles Regeln für „eingeschränkte“ Bereiche und Microsofts Administratorzustimmung: [docs/mailbox-sync.md](mailbox-sync.md)).

**Anmelden mit Google/Microsoft:** dieselben Apps dienen auch als Login-Knopf (Agentur → Anmeldung). Dafür zusätzlich `https://<PGHL_BASE_URL>/auth/sso/google/callback` bzw. `/auth/sso/microsoft/callback` als Weiterleitungs-URI eintragen – Details, GitHub, Apple und eigene SSO-Anbieter in [docs/auth.md](auth.md).

### Google-App anlegen

1. [Google Cloud Console](https://console.cloud.google.com/) → Projekt wählen/anlegen → **APIs & Dienste → Bibliothek**: **Google Calendar API** aktivieren; für Bewertungen und Beiträge zusätzlich **My Business Account Management API**, **My Business Business Information API** und **Google My Business API** (v4, Rezensionen und Beiträge).
2. **OAuth-Zustimmungsbildschirm:** Typ *Extern*, App-Name, Support-Mail, autorisierte Domain (deine Domain). Bereiche: `openid`, `email`, `…/auth/calendar.events`, `…/auth/calendar.readonly` und für das Unternehmensprofil `…/auth/business.manage`. Solange die App im Status *Testen* ist, nur eingetragene Testnutzer; für alle Kunden „App veröffentlichen“ (Google prüft die Kalender-Bereiche).
3. **Anmeldedaten → Anmeldedaten erstellen → OAuth-Client-ID**, Typ *Webanwendung*, unter *Autorisierte Weiterleitungs-URIs* die URI von oben. Client-ID und Clientschlüssel unter *Integrationen* eintragen.
4. **Business Profile API freischalten lassen:** Die Business-Profile-APIs sind für neue Cloud-Projekte gesperrt (Kontingent 0). Über das [Antragsformular für den API-Zugriff](https://developers.google.com/my-business/content/prereqs) mit einem verifizierten Unternehmensprofil beantragen; die Freigabe dauert meist einige Tage. Bis dahin meldet die App „kein API-Zugriff … freigeschaltet“ – der Kalender-Abgleich ist davon nicht betroffen.

### Microsoft-App anlegen

1. [Microsoft Entra Admin Center](https://entra.microsoft.com/) → **App-Registrierungen → Neue Registrierung**: Name, unterstützte Kontotypen *Konten in allen Organisationsverzeichnissen und persönliche Microsoft-Konten* (Mandant `common`) – nur Geschäftskonten: `organizations`, nur die eigene Firma: deren Mandanten-ID. **Umleitungs-URI**: Plattform *Web*, URI von oben.
2. **API-Berechtigungen → Microsoft Graph → Delegierte Berechtigungen:** `Calendars.ReadWrite`, `offline_access`, `openid`, `email` (keine Administratorzustimmung nötig).
3. **Zertifikate & Geheimnisse → Neuer geheimer Clientschlüssel**; den *Wert* (nicht die ID) zusammen mit der *Anwendungs-ID (Client-ID)* und dem Mandanten unter *Integrationen* eintragen. Das Geheimnis läuft ab (max. 24 Monate) – rechtzeitig ein neues eintragen.

### So läuft der Abgleich

- **Verbinden:** *Einstellungen → Mein Konto → Mit Google verbinden / Mit Microsoft verbinden*. Ablauf: Authorization Code mit PKCE (S256), `state` signiert, 10 Minuten gültig, einmal nutzbar und an die Login-Sitzung gebunden. Danach wählen: welche Kalender auf Konflikte geprüft werden, in welchen Kalender gebuchte Termine eingetragen werden und für welche Buchungskalender das gilt.
- **Belegte Zeiten** der gewählten Kalender werden alle 5 Minuten geholt (Google `freeBusy`, Outlook `calendarView`; „frei“ markierte Termine zählen nicht) und blockieren die Buchungsseiten – zusammen mit eventuellen iCal-Adressen. Klappt ein Abruf nicht, bleiben die letzten bekannten Zeiten stehen (lieber ein blockierter Slot als eine Doppelbuchung).
- **Termine → Kalender:** neue, verschobene und abgesagte Termine (auch blockierte Zeiten) der verknüpften Buchungskalender werden angelegt, geändert (mit `If-Match`) bzw. gelöscht, die externe Termin-ID wird gespeichert. Anlegen ist idempotent (Google: feste Event-ID, Microsoft: `transactionId`); Fehler werden mit wachsendem Abstand (1 Minute bis 6 Stunden) wiederholt. Terminserien gehen als einzelne Termine hinüber, nicht als Serien-Event – wird einer dort verschoben, ändert sich hier nur dieser Termin ([Terminserien](booking.md#recurring-appointments)).
- **Kalender → Termine:** alle 3 Minuten werden Änderungen geholt (Google `syncToken`, Microsoft Delta-Link; keine öffentlichen Webhooks nötig). Wird ein von hier eingetragener Termin dort verschoben, wandert er hier mit; gelöscht → hier abgesagt (Workflow-Auslöser „Terminstatus geändert“ mit `source: google|microsoft`). Wurde auf beiden Seiten geändert, gewinnt die spätere Änderung; das steht im Protokoll der Verbindung.
- **Tokens:** Access-Tokens werden automatisch erneuert; ist der Zugriff widerrufen oder abgelaufen, zeigt *Mein Konto* „Neu verbinden“. **Trennen** widerruft den Zugriff bei Google (Microsoft bietet das nicht – dort unter [myaccount.microsoft.com → Datenschutz → Apps](https://myaccount.microsoft.com/) entfernen) und löscht die gespeicherten Tokens und den Abgleich-Stand; bereits eingetragene Termine bleiben im Kalender.

## E-Mail-Postfach (Gmail) anbinden

> Für Gmail und Outlook / Microsoft 365 gibt es die **native Anbindung über die offiziellen APIs** (OAuth, Push, Antworten im selben Thread, Archiv/Labels in beide Richtungen): [docs/mailbox-sync.md](mailbox-sync.md). Der IMAP-Abgleich unten bleibt für jeden anderen Anbieter.

**Agentur → Integrationen → Einrichtung → E-Mail-Postfächer → + Postfach.** Für Gmail: Server `imap.gmail.com`, Benutzer = Gmail-Adresse, Passwort = App-Passwort (Google-Konto → Sicherheit → Bestätigung in zwei Schritten → App-Passwörter). Das Passwort wird verschlüsselt gespeichert (AES-256-GCM mit dem Schlüssel aus `data/secret`).

Regeln ordnen Mails Projekten zu, z. B. „Domain ist sportbund.example → Laufclub“ oder „Text enthält hofladen → Hofladen Sonnenhof“. Die erste passende Regel gewinnt; Mails ohne Treffer werden ignoriert (außer ein Standard-Projekt ist gewählt). Beim ersten Abruf werden die letzten 30 Tage gelesen (höchstens 300 Mails je Ordner), danach nur Neues. Entwürfe, die im Postfach gesendet oder gelöscht wurden, verschwinden auch im CRM.

## Supabase-Spiegel

HyperLevel kann seine Daten laufend in eine Supabase spiegeln (nur in eine Richtung: HyperLevel → Supabase). So greifen andere Projekte, SQL-Auswertungen oder der Supabase-MCP auf Projekte, Kontakte, Deals, Aufgaben, Rechnungen und Dokumente zu.

1. In Supabase einmal das SQL ausführen, das unter **Agentur → Integrationen → Einrichtung → Supabase-Spiegel → „SQL für die Tabellen“** steht (legt `public.ghl_projects`, `ghl_contacts`, `ghl_opportunities`, `ghl_tasks`, `ghl_invoices`, `ghl_docs` sowie `ghl_companies`, `ghl_object_records` und `ghl_associations` an – nach einem Update mit neuen Tabellen das SQL einfach noch einmal ausführen, mit Row Level Security ohne Freigaben – nur der Service-Role-Key liest sie).
2. Adresse der Supabase (z. B. `https://db.deine-domain.de`) und den **Service-Role-Key** eintragen, „Speichern & testen“.
3. Alle 10 Minuten werden geänderte Zeilen übertragen, einmal pro Nacht alles (dabei werden in HyperLevel gelöschte Zeilen auch in Supabase entfernt). „Jetzt komplett abgleichen“ startet sofort einen vollen Lauf.

Der Key wird verschlüsselt gespeichert und nie an den Browser zurückgegeben.

## Todoist

Aufgaben-Abgleich mit deinem persönlichen Todoist (beide Richtungen oder nur HyperLevel → Todoist): Token unter Todoist → **Einstellungen → Integrationen → Entwickler** kopieren und in **Agentur → Integrationen → Einrichtung → Todoist** speichern & testen. Standard ist **ein** Todoist-Projekt „HyperLevel“ mit einem Abschnitt je Sub-Account – das passt auch in den kostenlosen Todoist-Plan (max. 5 Projekte); alternativ ein Projekt je Sub-Account (Todoist Pro). Kein Umgebungs-Eintrag nötig; der Token liegt verschlüsselt in der Datenbank. In Todoist gelöschte Aufgaben werden hier nur als erledigt markiert, nie gelöscht. Der optionale Webhook (`https://<domain>/hooks/todoist`, Client Secret aus der Todoist App Console) beschleunigt nur – ohne ihn wird alle 3 Minuten abgeglichen. Alles Weitere: [todoist.md](todoist.md).

## Mitgliederbereich (Kurse)

Der Mitgliederbereich läuft unter der App-Adresse (`PGHL_BASE_URL`, bzw. der Agentur-/Kunden-Login-Domain): `https://<domain>/portal/<sub-account>`. Mitglieder melden sich per Login-Link an, der mit dem SMTP-Zugang des Sub-Accounts verschickt wird (Einstellungen → E-Mail & SMS) – ohne SMTP geht keine Mail raus. Links gelten 30 Minuten und einmal; Sitzungen 30 Tage (Cookie `pm_<sub-account>`, nur für den Mitgliederbereich). Hinter einem Proxy `PGHL_BEHIND_PROXY=1` setzen, damit die Begrenzung der Login-Anfragen je IP greift. Downloads der Lektionen liefert der Mitgliederbereich nur an Mitglieder mit Zugang aus.

## Community

Die Community läuft im Mitgliederbereich unter `https://<domain>/portal/<sub-account>/community` – gleiche Anmeldung (Login-Link per E-Mail, Cookie `pm_<sub-account>`), gleiche Domain. Es gibt nichts extra zu installieren und keine Zugangsdaten einzutragen; nötig ist nur der SMTP-Versand des Sub-Accounts (Einstellungen → E-Mail & SMS) für Login-Links und die tägliche Zusammenfassung.

- **Wer darf rein:** Kursteilnehmer und alle Kontakte, die über eine Gruppe Zugang haben (Tag oder Kurs, *Community → Gruppe → Einstellungen → Zugang*). Gruppen mit „Alle im Mitgliederbereich“ öffnen den Login nicht für weitere Kontakte.
- **Bilder** der Mitglieder liegen unter `<PGHL_DATA_DIR>/community/` (nicht unter den öffentlichen Uploads) und werden nur an Mitglieder der Gruppe ausgeliefert; Avatare an angemeldete Mitglieder desselben Sub-Accounts. Erlaubt sind PNG, JPG, GIF und WebP bis 3 MB (Avatar 2 MB), der Dateiinhalt wird geprüft. Das Backup des Datenordners enthält sie automatisch.
- **Sicherheit:** Beiträge und Kommentare sind Markdown ohne HTML; fremde Bilder per `![…](…)` werden für Mitglieder zu Links (keine Tracking-Pixel). Formulare brauchen ein Token der Sitzung und dieselbe Herkunft. Die Community-Seiten laden genau ein eigenes Skript (`/portal-community.js`, Bildauswahl und Rückfragen) – alles funktioniert auch ohne JavaScript, nur das Hochladen von Bildern nicht.
- **Tägliche Zusammenfassung:** Der Hintergrund-Takt (`PGHL_TICK_MS`) prüft alle 10 Minuten, ob es nach der eingestellten Uhrzeit (Standard 07:00, Zeitzone des Sub-Accounts) ungelesene Benachrichtigungen gibt, und schickt jedem Mitglied höchstens eine Mail pro Tag. Abschalten unter *Community → Einstellungen*; Mitglieder bestellen sie im Profil ab. Kontakte mit „Nicht stören“ bekommen keine.
- **Limits:** Beiträge/Kommentare pro Mitglied und Stunde (Standard 5/30) und automatisches Ausblenden nach drei Meldungen sind je Gruppe einstellbar.
- **Snapshots/Kopieren:** Snapshots enthalten Blog-Beiträge, Kurse (ohne Teilnehmer) und die Struktur der Community-Gruppen (ohne Beiträge, Mitglieder und Termine). Beim Kopieren in einen anderen Sub-Account werden die Download-Dateien der Lektionen mitkopiert.

## Partner-Links

Neben den Schlüssel-Feldern der Anbieter zeigt HyperLevel **„Konto anlegen ↗“**. Einige dieser Links sind
Empfehlungslinks des HyperLevel-Betreuers – immer als „Partner-Link“ gekennzeichnet und über `/go/<anbieter>`
geleitet (gespeichert wird nur ein Klick-Zähler je Anbieter). Als Betreiber entscheidest du: unter
**Agentur → Partner-Links** ersetzen oder abschalten, mit `PGHL_REFERRALS` eigene setzen oder mit
`PGHL_REFERRALS_DISABLED=1` alle abschalten. Details: [docs/referrals.md](referrals.md).
