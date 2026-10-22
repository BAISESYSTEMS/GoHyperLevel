# Incident runbook

One page for the bad day: a data breach, a lost server, a leaked key, abuse on the platform. Written for a solo operator or a
small team running the hosted service ([cloud.md](cloud.md)) or a self-hosted instance with customer data. **Not legal advice** –
check the notification duties with your data protection officer or lawyer once, before you need them, and practise the restore
twice a year.

Print this page, fill in the contact table and keep it with the emergency envelope (backup key, `data/secret`, `data/data.key`,
admin password, 2FA recovery codes) somewhere outside the server.

## Contacts

| Who | For | How to reach |
| --- | --- | --- |
| Operator on call | everything below | phone, ntfy/Telegram alert channel (`PGHL_ALERT_WEBHOOK`) |
| Second person with access | when the first is unreachable; four-eyes on deletions | phone |
| Hosting provider (e.g. Hostinger) | server down, network, disk, snapshots | support ticket / phone from the contract |
| Object storage provider | backups, access keys | console and support |
| Domain registrar and DNS | DNS changes, domain hijack | console with 2FA |
| Mail provider (SMTP / API) | sending blocked, reputation, bounce reports | console |
| Stripe | payment data, compromised keys, disputes | dashboard → support |
| Data protection authority | breach notification (Art. 33 GDPR) | the online form of the authority of your state (e.g. a German *Landesdatenschutzbehörde*) |
| Lawyer / data protection officer | assessment, notifications, customer letters | phone |
| Police / BSI | criminal attacks, extortion | local police cybercrime unit; BSI reporting form for operators |

Keep the customers' contact list current: *Agentur → Cloud → Kunden → CSV* exports owners and e-mail addresses.

## The first hour

1. **Detect and note the time.** The moment you learn of it starts the 72 hours. Open an incident log (a text file outside the
   server): time, what you saw, who knows, every step you take.
2. **Status page.** *Agentur → System → Betrieb → Statusseite → Vorfall melden* – impact, components, a first sentence ("We are
   investigating …"). Update it at least every hour.
3. **Contain.** Depending on the case:
   - stop the app (`docker compose stop gohigh`) when data is leaking right now;
   - sign out every session: change the admin passwords, *Mein Konto → Angemeldete Geräte* for each admin, and rotate the
     signing secret (below) to end all sessions and links at once;
   - block the attacker: firewall rule, revoke the API key or app token (*Agentur → API & MCP*), suspend an abusing customer
     (*Agentur → Cloud → Missbrauch*);
   - rotate every key the attacker could have seen (below).
4. **Preserve evidence** before you clean up: copy the audit log (*Agentur → Protokoll*, export), the server logs
   (`docker compose logs --since 72h gohigh > incident.log`), a database snapshot (`GET /api/admin/backup`) and, if the server is
   compromised, a provider snapshot of the whole disk. Do not reboot a compromised server before taking that snapshot.
5. **Assess**: which data, how many people, which customers, since when, is it encrypted, is it still happening? Write it down.

## Personal data breach: the 72-hour clock

Two roles, two duties:

| Your role | For which data | Duty |
| --- | --- | --- |
| **Processor** (Art. 28 GDPR) | the CRM data your customers keep in their accounts | inform the affected customers (the controllers) **without undue delay** (Art. 33(2)) – the AVV template says within 24 hours – so they can meet their own 72 hours |
| **Controller** (Art. 24) | your own customers' account, contact and billing data | notify the **supervisory authority within 72 hours** (Art. 33(1)) unless the breach is unlikely to result in a risk; inform the **people affected** without undue delay when the risk is high (Art. 34) |

Steps:

1. **Hour 0–24**: contain, preserve, assess (above). Decide with your lawyer whether there is a risk to people's rights.
2. **Within 24 h**: e-mail the affected customers (template below) – facts known so far, what you did, what they should do, who
   to contact. Say what you do not know yet; send updates.
3. **Within 72 h**: notify the authority through its online form (template below). If facts are missing, notify anyway and add
   them later (Art. 33(4)). If you notify later than 72 h, give the reasons.
4. **High risk to people**: tell them directly (Art. 34) in clear language – or have the controller do it for processor data.
5. **Document every breach**, even the ones you do not notify (Art. 33(5)): what happened, effects, measures. Keep it with the
   incident log.

### Template: notice to the authority (Art. 33)

```text
Meldung einer Verletzung des Schutzes personenbezogener Daten nach Art. 33 DSGVO

Verantwortlicher: <Firma, Anschrift, Ansprechpartner, Telefon, E-Mail>
Zeitpunkt der Verletzung / Kenntnisnahme: <Datum, Uhrzeit> / <Datum, Uhrzeit>
Art der Verletzung: <z. B. unbefugter Zugriff auf die Datenbank, Verlust eines Datenträgers, Fehlversand>
Betroffene Daten: <Kategorien, z. B. Name, E-Mail, Rechnungsdaten> – ungefähre Zahl der Datensätze: <n>
Betroffene Personen: <Kategorien, z. B. Kunden, Interessenten> – ungefähre Zahl: <n>
Wahrscheinliche Folgen: <z. B. Phishing-Mails an Betroffene, Identitätsmissbrauch>
Ergriffene Maßnahmen: <Eindämmung, Schlüsselwechsel, Wiederherstellung, Information der Betroffenen>
Geplante Maßnahmen: <…>
Information der Betroffenen: <erfolgt am … / geplant / nicht erforderlich, weil …>
Nachmeldung folgt: <ja/nein>
```

### Template: notice to customers (as processor)

```text
Betreff: Sicherheitsvorfall bei <Dienst> – Information nach Art. 33 Abs. 2 DSGVO

Guten Tag,

am <Datum> haben wir festgestellt, dass <kurze Beschreibung>. Betroffen sind nach heutigem Stand <welche Daten> in deinem Konto
„<Firma>“ im Zeitraum <von – bis>.

Was wir getan haben: <Eindämmung, Schlüsselwechsel, Prüfung>.
Was du tun solltest: <z. B. Passwörter ändern, API-Schlüssel neu erzeugen, deine Kontakte informieren, falls du das Risiko als hoch
einschätzt – du bist für diese Daten Verantwortlicher und meldest ggf. selbst an deine Aufsichtsbehörde>.
Was wir noch nicht wissen: <…>. Wir melden uns spätestens am <Datum> wieder.

Ansprechpartner: <Name, E-Mail, Telefon>
```

## Restore

Full guide: [backups.md → Restore](backups.md#restore). In short:

1. Status page: incident "Wartung / Störung" for *Web-App & API*.
2. `npm run backup:restore -- --list`, pick the last snapshot **before** the damage (after a breach: before the attacker's first
   access, if you can tell).
3. `npm run backup:restore -- <stamp> --files --to /data/restore` – it checks integrity, row counts and files and stops on any problem.
4. Stop the app, swap in `pghl.db` and the folders, restore `data/secret` and `data/data.key` from the emergency envelope on a new
   server, start, check `/healthz?strict=1`, log in, spot-check a few customers.
5. Data written between the snapshot and the incident is lost (RPO ≤ 1 h with the hourly off-site backup). Tell the affected
   customers which time window to check.
6. A restore brings back customers deleted since that snapshot: delete them again (*Agentur → Cloud → Kunden*) and note it.

Lost server: new server with the same deploy, same environment (`PGHL_BACKUP_*` from the envelope), restore, move DNS (TTL low in
advance helps). Target: back online within 4 hours.

## Rotating keys

Rotate everything the attacker may have seen, newest-risk first. Note each rotation in the incident log.

| Key | How | Side effects |
| --- | --- | --- |
| Admin passwords, 2FA | each admin: new password, re-enrol 2FA; sign out other devices | – |
| Data key (`data/data.key` / `PGHL_DATA_KEY`) – seals SMTP passwords, API tokens, OAuth tokens | stop the app, `npm run rotate-secret`; with `PGHL_DATA_KEY` in the environment set the printed new key and keep the old one in `PGHL_DATA_KEY_PREVIOUS` | none for users; a leaked database stays readable with the old key, so also rotate the third-party secrets below |
| Signing secret (`data/secret` / `PGHL_SECRET`) – sessions, unsubscribe and tracking links | `npm run rotate-secret -- --signing` (or a new `PGHL_SECRET`) | every session ends; old unsubscribe, survey and tracking links stop working |
| Backup key (`PGHL_BACKUP_KEY`) | new key from `openssl rand -hex 32`; old one into `PGHL_BACKUP_KEY_PREVIOUS` until its backups aged out ([backups.md](backups.md#encryption-and-keys)) | backups already in the bucket stay encrypted with the old key – if the old key leaked together with bucket access, delete those backups after a fresh one exists |
| Object storage access key | create a new key at the provider, set `PGHL_BACKUP_S3_ACCESS_KEY`/`_SECRET_KEY`, restart, delete the old key | – |
| Stripe secret key and webhook secret | Stripe dashboard: roll the key, new webhook signing secret; enter both under *Agentur → SaaS → Einstellungen* | a short gap in webhooks – *Agentur → Cloud → Übersicht → reconcile* catches up |
| SMTP / mail API keys, Twilio, AI provider keys | new key at the provider, enter it in the settings, revoke the old one | – |
| API keys and app tokens of sub-accounts | *Agentur → API & MCP* and the connected apps: revoke and re-create; tell customers to do the same for their own keys | integrations need the new key |
| Server access (SSH keys, hosting account, registrar, DNS) | new SSH keys, remove old ones from `authorized_keys`; passwords and 2FA of every console | – |

## Abuse on the platform

A phishing site, spam or malware from a customer (cloud mode):

1. Check the notice under *Agentur → Cloud → Missbrauch* (or the alert). Open the reported URL in a private window – carefully.
2. Act proportionately: *Websites offline* for a phishing page, *Versand pausieren* for spam, *Konto sperren* for repeated or
   severe abuse. The reason goes to the customer (DSA Art. 17); be specific.
3. Close the notice with the decision – the reporter is told (DSA Art. 16(5)).
4. Phishing on your domains: request a review at Google Safe Browsing (Search Console) once the content is gone; customer sites
   live on their own sites domain (`PGHL_CLOUD_SITES_DOMAIN`), so the login domain is not affected.
5. Criminal content (child sexual abuse material, threats to life): take it offline at once, preserve evidence, report to the
   police (DSA Art. 18). Do not forward the material.

## Afterwards

Within two weeks: a short post-mortem (timeline, cause, what worked, what to change), close the status page incident with a
summary, check that every rotated key is really in use, update this runbook and the contact table.
