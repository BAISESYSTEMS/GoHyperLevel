# E-Mail-Zustellung prüfen (deliverability)

**Einstellungen → E-Mail-Zustellung** checks whether the domain you send mail from is set up the way Gmail, Yahoo, Microsoft and the others expect – **SPF, DKIM, DMARC and MX** – and shows the missing DNS records ready to copy, with German step-by-step instructions. The same verdict warns you in the send dialog of every campaign. Campaign and automation mails carry the one-click unsubscribe header (**RFC 8058**) automatically.

Reputation (bounce, complaint and unsubscribe rates), the warm-up plan, list hygiene and address checks live next to it under *Kampagnen → Zustellbarkeit* – see [email-marketing.md](email-marketing.md#zustellbarkeit).

It only *reads* public DNS (and, when you have connected your sending provider, that provider's own account of the domain). It never changes DNS, needs no DNS-provider login and no password.

- [What gets checked](#what-gets-checked)
- [The wizard](#the-wizard)
- [Providers and DKIM selectors](#providers-and-dkim-selectors)
- [Unsubscribe header (RFC 8058)](#unsubscribe-header-rfc-8058)
- [Warning in the campaign send dialog](#warning-in-the-campaign-send-dialog)
- [Set up (self-hosters)](#self-hosting)
- [REST API and MCP tool](#rest-api-and-mcp-tool)
- [For developers](#for-developers)

## What gets checked

| Check | OK means | Typical findings |
| --- | --- | --- |
| **SPF** | exactly one `v=spf1` record on the domain, ending in an `all`, at most **10 DNS lookups** (includes followed), and it contains your provider (e.g. `include:spf.brevo.com`) | no record; two records (SPF breaks with two – they must be merged); the provider's include is missing (the fix shows the *merged* record, not a second one); more than 10 lookups (permerror); `+all`; `ptr` |
| **DKIM** | a public key under the provider's selector (e.g. `brevo1._domainkey`), not revoked (`p=` empty), at least 1024 bit (2048 recommended) | no key; only some of several keys (Brevo needs 2, SES 3); revoked key; CNAME pointing nowhere; key shorter than 1024 bit |
| **DMARC** | a `v=DMARC1` record at `_dmarc.<domain>` (or inherited from the parent domain) with a policy | no record (Gmail and Yahoo require one from about 5,000 mails a day); `p=none` is accepted but only observes – the fix proposes `p=quarantine` step by step; no `rua=` address for reports; `pct` below 100 |
| **MX** | the domain has mail exchangers (so replies and bounces can arrive) | none (replies bounce); a *null* MX |
| **Return path** | the provider's bounce domain resolves (SES custom MAIL FROM, Mailgun) – a recommendation | missing record; only shown when the provider documents one |

The overall status is the worst of the required checks: **In Ordnung**, **Prüfen** (something to improve, mail still works) or **Fehler** (fix this – delivery is at risk). **Unklar** means the DNS lookup itself failed (timeout, SERVFAIL) – try again; it is never shown as an error of yours. Recommendations never turn the status red.

Subdomains inherit: for `news.kunde.de` a missing DMARC record is looked up on `kunde.de` before it counts as missing.

## The wizard

1. Open **Einstellungen → E-Mail-Zustellung**. The sender (from *Einstellungen → E-Mail & SMS*) is shown; *… jetzt prüfen* checks its domain. Another domain can be added below (up to 20 per sub-account), optionally with the provider and a DKIM selector.
2. Each domain shows an overall badge and one badge per check. *Details und Anleitung zeigen* explains every finding in German, what to do in order, and **the records to copy**: type, name/host (as DNS panels want it: `@` or relative like `_dmarc`) and value, each with a *Kopieren* button, plus the full name.
3. Create the records where your domain's DNS lives (your registrar, Cloudflare …). Changes usually show up within minutes, sometimes hours.
4. **Erneut prüfen** (at most one check every 3 seconds per domain, 40 per hour per sub-account). Repeat until everything is green.

*Anbieter* on a domain sets the sending provider and the DKIM selector; changing them clears the old verdict.

## Providers and DKIM selectors

The check knows what each provider needs and, when the provider's account is connected under *Einstellungen → E-Mail & SMS*, asks the provider's API for the exact records it expects (read-only):

| Provider | SPF include | DKIM | Extra |
| --- | --- | --- | --- |
| **Amazon SES** | `amazonses.com` | 3 CNAMEs `<token>._domainkey` (tokens from the SES API when connected) | optional custom MAIL FROM (MX + SPF) |
| **Postmark** | `spf.mtasv.net` | selector like `20240101120000pm` – enter it in *DKIM-Selektor* | – |
| **Resend** | `amazonses.com` | `resend._domainkey` (TXT, value from your Resend account) | – |
| **Brevo** | `spf.brevo.com` | `brevo1._domainkey`, `brevo2._domainkey` (CNAME) | – |
| **Mailgun** | `mailgun.org` | `smtp`, `mx` or `k1._domainkey` – or the selector from your account | tracking/receiving CNAME |
| **SMTP (own server)** | guessed from the host (Google Workspace, Microsoft 365, IONOS, Strato, mailbox.org, SendGrid, Mailjet, Zoho, all-inkl) | the host's usual selectors, otherwise common ones (`default`, `mail`, `selector1/2`, `google`, `s1/s2` …); enter the right one in *DKIM-Selektor* if none is found | – |

A connected mailbox (Gmail/Outlook) is checked like SMTP. In the *log* (test) mode nothing is sent and the check says so.

## Unsubscribe header (RFC 8058)

Every **campaign**, **workflow** and **NPS** e-mail gets

```
List-Unsubscribe: <https://<your-domain>/u/<contact>/<signed token>>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

so Gmail, Yahoo and Apple Mail show their own *Unsubscribe* button. The mail client sends **one `POST`** to that link (`List-Unsubscribe=One-Click` in the body): the contact is unsubscribed at once, with no page and no login. A wrong or tampered token answers 400. The link in the mail body stays (UWG/DSGVO): opening it (`GET`) shows a page with one button, *Ja, abmelden*, and changes nothing – link scanners of mail gateways and anti-spam filters fetch every link of a mail (the header's too) and must not unsubscribe anybody; the button sends `confirm=1` and shows the confirmation. The token is signed with the server secret; the endpoint is exempt from the public-write rate limit, so a mail provider's burst of one-click requests is not throttled. One-to-one mails (a reply in *Konversationen*) carry no such header.

**Service mails have no "Abmelden" link in the footer** – invoices, quotes, dunning letters, appointment confirmations, reminders and cancellations, SEPA mails, order confirmations and the double opt-in mail (everything sent as `purpose: 'transactional'`, or with *Nicht stören* overridden and not as bulk mail). They are no advertising, so there is nothing to unsubscribe from; the footer names company and address only. A link you write into such a mail yourself (`%%unsubscribe_url%%`) still works. Campaign, workflow, review-request and conversation mails keep the link.

The header is added by the sender code, so it works the same through SMTP, Postmark, Resend, Brevo, Mailgun and SES.

## Warning in the campaign send dialog

In a draft campaign (channel e-mail) the *Versand* card shows the verdict for the sender's domain: green when SPF, DKIM and DMARC are fine, a yellow or red box with the findings and a link to the wizard otherwise. *Jetzt senden* / *Planen* repeats the warning in its confirmation. The status is cached for 24 hours and refreshed when you open the page after that; it never blocks sending. An SMS campaign shows nothing.

## Sending speed and warm-up (campaigns)

Every campaign has its own **Versandgeschwindigkeit** (*Kampagnen → Kampagne → Versand*): *Standard* or 50, 100, 250, 500, 1,000, 2,500, 5,000 messages per hour, or a value of your own between 10 and 50,000. Standard is what the app always did – the sub-account's batch per background tick, **30 messages every 15 seconds** (about 7,200 per hour; `settings.campaigns.batch_size`, kept between 1 and 500, and `PGHL_TICK_MS` for the tick). The box shows how long the send will take for the reachable recipients and when it is through ("Dauer ca. 2 Std. 29 Min. für 1.240 Empfänger – fertig gegen 14:35 Uhr"); that is an estimate, slow mail servers or errors stretch it.

- **How it works:** with a speed, the first message goes out at once and then only what the speed has earned since it was set – at most **twice the nominal batch per tick**, so a pause (server down) never ends in a burst. Changing the speed of a **running** campaign (*Ergebnis → Versandgeschwindigkeit*, or `PUT /api/campaigns/:id/speed {speed_per_hour}`) counts from that moment on; empty/`null` returns to the standard.
- **Warm-up hint:** a sender that has delivered fewer than 1,000 e-mails so far and now sends to 200 or more people gets a hint in the box (yellow when the speed is above **60 per hour**): new addresses and domains need to "warm up" – start with a few mails a day, increase daily over two to four weeks, or write to a part of the list first (for example the recently active contacts) – otherwise mail lands in spam sooner. The hint is advice only; it never blocks. SMS campaigns have the speed but no warm-up hint.
- API: `speed_per_hour` on `POST /api/campaigns` and `PATCH /api/campaigns/:id`, `PUT /api/campaigns/:id/speed` `{speed_per_hour}` changes it while a campaign is still a draft, scheduled or sending (`null` = the default speed); `GET /api/campaigns/:id` returns `throttle` (`speed_per_hour`, `per_hour`, `default_per_hour`, `batch_per_tick`, `tick_seconds`, `remaining`, `eta_at`, `eta_minutes`, limits) and `warmup` (`sent_total`, `recommended_per_hour`, `advice`, `level`). Migration `campaigns:003-throttle`.

## Self-hosting

Nothing to configure: the check uses the server's DNS resolver (`node:dns`) and, for connected providers, HTTPS to their APIs. Make sure the container can resolve public names (the Docker default does) and – behind a firewall – allows UDP/TCP 53 to a resolver. In demo mode outgoing DNS is blocked, so the check answers *Unklar*.

Make sure `PGHL_BASE_URL` is your public `https://` address: it is part of every unsubscribe link.

## REST API and MCP tool

Routes (area *Einstellungen*, except `/api/mail-domains/status` which needs *Kampagnen*; every write is in the audit log): see [E-Mail-Zustellung in docs/api.md](api.md#e-mail-zustellung-mail-domains). MCP: `ghl_mail_domain_check` adds the domain if needed, checks it and returns the verdict, the findings and the records to create (without a domain it checks the sender's).

## For developers

| File | What it holds |
| --- | --- |
| `services/umzug-mailcheck.ts` | `checkDomain` with an injectable `DnsResolver` (so tests need no network), SPF/DKIM/DMARC/MX/return-path logic, provider tables, `systemResolver()` |
| `modules/umzug-mailcheck.ts` | Table `mail_domains`, the routes, provider facts (Resend, Brevo, Mailgun, SES APIs), rate limits |
| `services/messaging.ts` | `unsubscribeHeaders()` and where bulk mail gets them (`SendInput.bulk`, sources *Kampagne…*, *Workflow…*, *NPS…*) |
| `modules/contacts.ts` | `GET`/`POST /u/:id/:token` |
| `web/src/pages/UmzugZustellung.tsx`, `UmzugMailBanner.tsx` | The wizard and the banner of the send dialog |

**Tests** use `app.services.mailDns` (a fake resolver) and `app.services.mailCheckFetch` (fake provider APIs) – see `tests/umzug-mailcheck.test.ts`.
