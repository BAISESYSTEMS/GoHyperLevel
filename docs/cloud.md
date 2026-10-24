# Hosted cloud version (`PGHL_CLOUD_MODE=1`)

A solopreneur, a small team or an agency opens the operator's instance, picks a plan, pays and works
immediately – no installation, no server. Self-hosting stays free and complete; the cloud mode is for whoever
wants to **run this software as a service for other people** (the operator can be the project itself, an
agency or a hosting partner).

Prices (list prices per month, all configurable by the operator): **Self-hosted 0 €** (AGPL) · **Cloud Solo 49,99 €**
(1 user, contacts, funnels and workflows unlimited) · **Cloud Team & Company 99,99 €** (unlimited users; plan id
`cloud-team`) · **Cloud Agentur 199 €** (unlimited users, **white-label**, client sub-accounts, custom domains). Prices
are **net plus VAT** – Stripe Tax adds the tax at checkout (reverse charge for EU businesses with a VAT ID), and the pricing
page says so. Yearly: twelve months minus the yearly discount (default 20 %), **rounded down** to whole euros so the
customer never gets less than the advertised discount – 479 €, 959 € and 1.910 € a year with the defaults. **Every plan
has every feature – the one exception is white-label and client sub-accounts (with custom domains), which only the
Agentur plan has. There is no fee per user and no contact tiers.**

**Not open yet? Waitlist mode.** Without a Stripe key – or with `PGHL_CLOUD_WAITLIST=1` – the cloud mode runs as a waitlist:
nobody can sign up, enter payment data or be charged, and `/cloud`, `/start` and the landing page offer self-hosting plus a
waitlist form instead ([waitlist mode](#waitlist-mode)). The project's own instance, gohyperlevel.com, runs like this until the
hosted service opens.

## Decision: how customers are separated

**Every customer (tenant) is a sub-account of the operator's instance – the isolation that already carries
agencies and the SaaS mode – plus a thin tenant layer on top. No separate database or process per customer.**

Options considered:

| Option | Isolation | Cost / risk | Verdict |
| --- | --- | --- | --- |
| One SQLite file + process per customer | strongest | each customer needs a process, a port, a backup, a migration run and routing; thousands of customers are not manageable on one box; every feature module would need to be multi-process safe | rejected: too much new operations surface for a first release |
| New `tenant_id` column on every table | strong if complete | touches every table, every query, every module – the exact "edit shared files" this project forbids, and one forgotten `WHERE` leaks data | rejected |
| **Sub-account per customer (`location_id`), tenant layer on top** | the guarantee that every table, the REST API, MCP, search, webhooks and the audit log already rely on, and which `tests/tenant-isolation.test.ts` and `tests/security-fixtures.ts` attack with every route | small: new tables only, hooks into existing registries | **chosen** |

How it fits together:

- A **tenant** (`cloud_tenants`) is one paying customer. It owns one **primary sub-account**; on the Agentur
  plan it can add **client sub-accounts** (`cloud_locations`) for its own customers.
- People are `users` with rows in `cloud_members` (role `owner` or `member`, optional `all_locations`).
  Customer logins are ordinary non-admin users – they never have the operator's admin role.
- **Billing sits on the primary sub-account's `saas_subscriptions` row**, so the existing SaaS machinery
  (statuses, usage gate, read-only mode, Stripe webhook, banner, usage metering) is reused unchanged. The three
  cloud plans are synced into `saas_plans` (all areas, limits only for users / e-mails / SMS / AI, never for
  contacts or features). Client sub-accounts get a price-less mirror of the owner's subscription so a paused
  owner pauses the clients too.
- The operator's own sub-accounts are not tenants; operator admins are walled off from tenants (see
  [Isolation](#isolation-and-support-access)).
- Everything lives in modules of its own (`server/modules/cloud*.ts`, `server/services/cloud*.ts`,
  `web/src/pages/Cloud*.tsx`); shared code only got registry hooks (see [Hooks](#hooks-for-module-authors)).

Consequence to be aware of: all customers share one SQLite file, one process and one instance's resources.
That is the same scale statement as the rest of the project (thousands of contacts per sub-account, a few
hundred to a few thousand tenants on one decent server). Beyond that, run several instances (each with its own
cloud domain) – nothing in the design prevents it.

## What the customer gets

1. **`/cloud`** – public pricing page (no cookies, no scripts needed): the three plans, monthly/yearly toggle,
   "all features in every plan – white-label and client accounts only in Cloud Agentur", "no fee per user", the VAT note
   ("net plus VAT, calculated by Stripe Tax"), a white-label section for the Agentur plan, "Cloud oder selbst hosten?" and
   the link to the self-hosting guide (0 €).
2. **`/start`** – signup: company name, e-mail, plan, interval, optional coupon, acceptance of **AGB, AVV and
   Datenschutz** (the accepted version of each is stored with a timestamp), password or **Sign in with Google**. B2B only by
   default: a VAT ID or the confirmation "I order as a business" is required ([B2B-only signup](#b2b-only-signup)).
   An e-mail with a confirmation link follows; confirming creates the account (after the trial / checkout).
   **No account and no password before the address is proven** (protection against account pre-hijacking): nothing
   exists until the link is confirmed, and the password from the form only counts when the link is opened in the
   browser that sent the form (a cookie set on submit binds them). Opened anywhere else – another device, or the
   inbox of somebody whose address a stranger typed in – the link asks for the password itself; whatever was typed
   into the form is thrown away. The link is valid for 24 hours and is claimed by the first confirmation: afterwards it
   only goes on in the browser that confirmed (e.g. when the payment page failed), and the confirmation closes every
   other open sign-up for that address (their links, passwords and browser bindings stop working). Sign-ups already at
   Stripe stay; provisioning refuses a second account for the address and cancels that subscription. With Google the
   address counts as proven, and the Google sign-up closes the open e-mail sign-ups for it the same way.
3. **Checkout** – with a card (default): Stripe Checkout with the trial, automatic tax and tax-ID collection;
   without a card (operator setting): the trial starts at once and the account turns read-only when it ends.
4. **Provisioning in seconds** – tenant, sub-account, owner login, default pipeline and templates (or the
   operator's snapshot), welcome e-mail, an onboarding checklist, and – with a cloud domain – `<name>.<cloud-domain>`
   as the login address.
5. **Settings → Cloud-Konto** – plan and usage, change plan (prorated by Stripe), billing portal, invoices,
   cancel (with an optional reason), team, clients and white-label (Agentur), **data export**, **support access
   consent**, **AVV download**, **delete account**.

### Fair use (transparent, never a feature lock)

Every plan has the same features. To protect the service from abuse there are operator-set limits per
sub-account, shown to the customer as meters in their account:

| Limit | Solo | Team & Company | Agentur |
| --- | --- | --- | --- |
| Users | 1 | unlimited | unlimited |
| E-mails per month | 10,000 | 50,000 | 50,000 |
| SMS per month | pass-through at cost | pass-through at cost | pass-through at cost |
| AI calls per month (operator's key) | 300 | 2,000 | 2,000 |
| Media storage | 5 GB | 25 GB | 25 GB |

Media storage counts everything a sub-account keeps on disk: media uploads, course and community videos, call audio,
meeting recordings and the files visitors send through public forms. Form uploads that would pass the plan are refused
with 413 and the customer is told at 90 % and 100 % ([forms.md](forms.md#limits-and-settings)).

All values are defaults; the operator changes them (empty = unlimited) under *Agentur → Cloud → Einstellungen →
Fair Use*, and chooses per metric whether reaching the limit **blocks** (with a notice) or **bills at cost plus
markup** on the next Stripe invoice. Own provider keys (SMTP, Twilio, "bring your own key" for AI) are not
counted against the operator. Contacts, funnels, workflows, courses … are never limited. Agentur: client
accounts are for the agency's own clients, not for reselling the software (fair use; optionally capped with
*Kunden-Accounts im Tarif Agentur*).

## Operator setup

### 1. Switch it on

```bash
PGHL_CLOUD_MODE=1                      # enables the modules, /cloud, /start, the console
PGHL_BASE_URL=https://cloud.example.com # must be public https – Stripe and the e-mail links use it
PGHL_CLOUD_DOMAIN=cloud.example.com    # optional: customers get <name>.cloud.example.com
PGHL_CLOUD_TRIAL_DAYS=14               # default 14 (0 = no trial, max 90); editable in the console
PGHL_CLOUD_CARD_REQUIRED=1             # 0 = trial without payment data
PGHL_CLOUD_STRIPE_SECRET_KEY=sk_live_… # optional – otherwise enter it in the UI (below)
PGHL_CLOUD_STRIPE_WEBHOOK_SECRET=whsec_…
PGHL_CLOUD_SITES_DOMAIN=example-sites.net  # customers' sites live on <slug>.example-sites.net, never on the login domain
```

Only `PGHL_CLOUD_MODE` is required. The other values seed the settings once; afterwards the console
(*Agentur → Cloud → Einstellungen*) is the source of truth. With the mode off, none of the routes exist and
`/cloud` and `/start` return 404. Until the Stripe key of step 2 is set, the instance stays in
[waitlist mode](#waitlist-mode) (no signup, no payment); `PGHL_CLOUD_WAITLIST=1` keeps it there after that, `=0` opens it
without Stripe (trials without a card only).

In cloud mode **leave the SaaS sign-up page `/signup` off** (*Agentur → SaaS → Einstellungen*); the console's
checklist warns if it is on. Self-serve signups run through `/start`. Either way `/signup` never shows or accepts the cloud
plans (`cloud-solo|team|agency`, `cloud-agency-client`): a link to one redirects to `/cloud`, a `POST` with one is refused.

### 2. Stripe

The cloud mode reuses the SaaS Stripe connection of the instance (the operator's **own** Stripe account –
never a customer's).

1. Stripe Dashboard → Developers → API keys: create a **restricted or secret key** and enter it under
   *Agentur → SaaS → Einstellungen* (stored sealed, never shown again) – or set
   `PGHL_CLOUD_STRIPE_SECRET_KEY`.
2. Developers → Webhooks → add endpoint `https://<your host>/hooks/stripe-agency` with the events
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `customer.subscription.trial_will_end`, `invoice.finalized`,
   `invoice.paid`, `invoice.payment_failed`. Copy the signing secret into the same settings page (or
   `PGHL_CLOUD_STRIPE_WEBHOOK_SECRET`). The console shows the exact URL and event list.
3. **Products and prices are created for you.** When the key is set, the three plans (monthly and yearly) are
   created in Stripe and kept in sync when you change a price. Changing a price only affects new subscriptions;
   running ones keep their price until the customer changes plan.
4. Optional: *Settings → Tax* in Stripe to switch on **Stripe Tax** (VAT, reverse charge for EU companies with a
   VAT ID). In the console, "Stripe Tax" and "USt-IdNr. abfragen" decide whether Checkout uses them.
5. Optional: create **promotion codes** in Stripe; customers enter them at signup or in Checkout.
6. Customers manage cards and see invoices in the **Stripe customer portal** (button in their account); the
   invoices are also listed in the app.

Test mode: use a `sk_test_…` key and a test webhook secret; nothing else changes. The automated tests never
call Stripe (all HTTP is mocked).

### 3. Domain and TLS

Without a cloud domain all customers use the instance's own address. With `PGHL_CLOUD_DOMAIN=cloud.example.com`
every new account gets `<name>.cloud.example.com` as its login domain (stored as the sub-account's white-label
app domain, so the existing domain handling applies):

- DNS: `*.cloud.example.com  A  <server IP>` (one wildcard record).
- TLS: the Caddy profile (`docker compose --profile caddy`) fetches each certificate on the first visit and asks
  `GET /api/tls/ask?domain=…` first – known sub-domains are answered with 200. No wildcard certificate needed.
- Agentur customers can add their own domain per sub-account (*Kunden & White-Label → Domain*): `A` record to the
  server, certificate follows by itself.
- Customer **sites** get an origin of their own: `PGHL_CLOUD_SITES_DOMAIN=example-sites.net` with
  `*.example-sites.net  A  <server IP>`; a site's custom domain starts after a TXT record proves it
  ([Customer sites](#customer-sites-their-own-origin-and-verified-domains)).

### 4. Sign in with Google (optional)

Set up Google sign-in as for the rest of the instance (*Einstellungen → Anmeldung (SSO)*). Add this
**authorized redirect URI** in the Google console: `https://<your host>/start/google/callback`. The console
shows the URI and whether Google is ready. Without it the signup page simply offers the password form.

### 5. Mail

Confirmation, welcome, invitation, trial and payment mails are sent from one sub-account of the operator's
(*Einstellungen → Absender der System-Mails*; default: the SaaS mail sender, else the oldest operator sub-account). Set
up e-mail sending there (SMTP/API, SPF/DKIM – see [deliverability.md](deliverability.md)). The overview
checklist tells you when no sender exists. Mail texts are German and live in `server/services/cloud-mail.ts`.

### 6. Legal texts

*Agentur → Cloud → Rechtliches* holds **AGB, AVV (Auftragsverarbeitungsvertrag), Datenschutzerklärung and
Impressum** as editable texts with placeholders (`{{operator.name}}`, `{{operator.address}}`, `{{operator.hosting}}`,
`{{customer.company}}`, `{{service}}`, `{{date}}`, `{{trial_days}}` …) filled from *Einstellungen → Anbieter*.
`{{operator.hosting}}` is the field *Hosting-Anbieter und Serverstandort*; the AVV (§ 7, Anlage 2) and the privacy policy
name it. For gohyperlevel.com that is the Hostinger VPS in **Frankfurt am Main, Germany** – enter the provider's legal name
from the hosting contract (an IP lookup is no proof of location). Texts saved before keep their version; add the line
there by hand.

> **The shipped texts are templates, not legal advice.** They are a starting point so you can see the
> structure; have a lawyer review and complete them before you accept real customers. The overview checklist
> stays red until no placeholder is open.

Every save creates a **new version**. New customers accept the current version at signup (stored with
version, time and tenant); existing customers get a banner to confirm after a change. The AVV is available to the
customer as a PDF with their company name filled in. The public pages are `/cloud/legal/agb|avv|datenschutz|impressum`.

### 7. Fair use, dunning, signup protection

All in *Agentur → Cloud → Einstellungen*: prices, yearly discount, trial days, card at start or not, limits and
overage behaviour, the times below, signup rate limit, disposable-address blocking and extra blocked domains,
status page, support e-mail, snapshot for new accounts.

## Billing lifecycle and data protection

```
trial ──► active ──► payment failed ──► (grace) ──► read-only ──► export offered +    ──► deleted
 │                    banner + mails     7 days      30 days       deletion scheduled     14 days later
 └─ no card: trial ends ──► read-only ─────────────────────────────┘ (same timeline)
```

Defaults, all configurable: grace **7 days** after the first failed payment, **30 days** read-only, then a mail
"export your data – deletion scheduled" and the hard delete **14 days** later. A customer who pays at any point
before the delete is back to normal at once. In read-only mode reads, the **export**, the billing page and
paying always work; writes get a clear message. A customer who **deletes their account** themselves gets a
confirmation mail and a **7-day** window to undo it (also configurable); the subscription ends immediately.

Mails: verification, welcome, invitation, trial ending (3 days before), trial ended, payment failed, payment
reminder (from day 3), read-only, deletion scheduled, self-delete, deleted, subscribed, cancellation, plan change.
Each is sent once (deduplicated) and listed in the tenant's event history.

**Deletion removes everything**: the tenant's sub-accounts and all rows that belong to them (including
messages, files in the upload folders, search indexes and domains), the customers' users and their personal
rows, and the Stripe subscription. What stays is a tombstone row without personal data (id, plan, dates) for the
operator's own books, and the audit entries of the operator's actions (written without names).

**Export** (`GET /api/cloud/export`, owner only, any time even when read-only) is a ZIP: one JSON and one CSV per
table (contacts, tasks, messages, invoices …), `team.json`, the uploaded files, a manifest and a short README
(`LIESMICH.txt`). Passwords, API keys, tokens and other secrets are never included.

## Operator console (*Agentur → Cloud*)

| Tab | What it does |
| --- | --- |
| Übersicht | MRR and ARR, paying customers, trials running, **trial → subscription conversion** (90 days), **churn** (30 days), customers per plan, recent events, and the setup checklist (Stripe, webhook, signup open, mail sender, legal texts, cloud domain) |
| Kunden | list with search and filters (status, plan), CSV export; per customer: history, **extend trial**, **comp a plan** (free, optionally for N months), **change plan**, note, **open account** (only with the customer's consent), **delete** (typed confirmation) |
| Einstellungen | prices, yearly discount, trial, card, fair use, overage, dunning times, Stripe URL/events, signup protection, cloud domain, mail sender, snapshot, provider details |
| Rechtliches | the four legal texts with versions, open placeholders and how many customers accepted the current version |
| Anmeldungen | signups that paid but could not be provisioned (retry); open signups are deleted after 7 days, failed ones after 30 |
| Missbrauch | notices from `/abuse` with the decision back to the reporter, accounts with a measure in place, the measures (pause sending, sites offline, suspend), the abuse address and the automatic pause ([Abuse handling](#abuse-handling)) |

Access control: every `/api/cloud/console/*` route is admin-only (customers get 403 from the router itself).
Statuses: **Testphase**, **Aktiv**, **Geschenkt**, **Zahlung offen**, **Schreibgeschützt**, **Gekündigt**,
**Löschung geplant**. MRR counts paying, non-comped subscriptions, yearly plans as a twelfth.

## Isolation and support access

- Customers never see other customers or the operator's data – the sub-account boundary plus a team/people list
  that hides the operator's admins from tenants (`hideUser`). The attack harness in
  `tests/security-fixtures.ts` (`crossTenantAttack`) and `tests/cloud-isolation.test.ts` fire every route of the
  app from a tenant login at a second tenant and the operator.
- **Operator access is opt-in by the customer.** Under *Daten & Konto → Support-Zugriff* the owner allows access
  for 1 hour, 24 hours, 7 or 30 days, or revokes it. Without it, operator admins get 403 on that tenant's
  sub-accounts and the agency-wide content lists (contacts, deals, tasks, documents, invoices, privacy) skip it.
  Every opening is written to the **customer's own audit log** ("Support hat das Konto geöffnet") and to the
  tenant's history. The same consent guards the other doors: **reports across all sub-accounts** and the
  operator's **audit log** skip customers who have not opened their account, and the operator's **user
  management** cannot set a password, reset 2FA, sign out or delete a customer's login – or add a login to a
  customer's sub-account – without it (the people list leaves the customers out).
- **Hosts are the operator's:** the cloud domain and every sub-domain of it, the login domains of all accounts, the
  app's own address and every connected domain can be claimed by one site or help center only – a customer cannot
  point a site at somebody else's login address (`app.services.domainTaken`, answered with "Diese Domain ist schon
  vergeben").
- **Fair use covers storage of all kinds:** the *Medien-Speicher* meter adds up media uploads, course videos,
  community videos, call audio and meeting recordings; an upload that would pass the plan is refused when it starts
  (course and community videos) or arrives (audio). Community members can start about three videos' worth of
  uploads per day.
- Honest limit: the operator runs the server and the database file. The consent toggle protects the product
  surface (UI, API, MCP); it is not end-to-end encryption. Say so in your AVV and your technical measures.
- Customers cannot reach agency routes (all `admin`-only) or other sub-accounts; client logins created by an
  Agentur customer get 403 on the cloud account routes.
- Signup protection without a captcha: hidden honeypot field, a minimum fill time (signed form token),
  per-address and per-e-mail rate limits, optional disposable-domain blocking, verification by e-mail with a
  confirm click (a link scanner opening the mail does not create anything), and **no account enumeration**
  (an existing address gets a "you already have an account" mail and the same screen). The pricing and signup
  pages set **no cookies**; a technical cookie (`pghl_cloud`) binds the browser to the signup only after the
  e-mail link was confirmed.
- Changes are audit-logged: plan changes, settings, legal versions, comp, trial extension, deletion, support access.

## Abuse handling

The Digital Services Act applies to small hosting services too: a point of contact, a notice mechanism, reasons for every
restriction. `modules/cloud-abuse.ts` provides the parts:

- **`/abuse`** – a public, cookie-free notice form (linked in the footer of the pricing, signup and legal pages and on the status
  page) with the fields of Art. 16 DSA: kind of violation, the exact URL(s), a substantiated explanation, name and e-mail (optional
  for child sexual abuse material) and the good-faith statement. The reporter gets a receipt with a reference number, the operator
  an alert (e-mail, push, webhook – [backups.md](backups.md#alerts)), and the notice is matched to the customer by its URL (site path,
  sites domain, custom domain, form, login domain). An abuse e-mail address for the form is set under *Missbrauch*.
- **Decisions** – under *Agentur → Cloud → Missbrauch* each notice gets a status (new, in review, actioned, rejected); closing it needs a
  reason, which goes to the reporter by e-mail (Art. 16(5)). Closed notices are deleted a year after the decision.
- **Measures per customer** – *pause sending* (e-mail and SMS fail with the reason, everything else works), *sites offline* (the
  customer's sites, blogs, help centers and forms answer 410), *suspend* (no customer route but the profile, the cloud account
  summary and the data export; sites and sending stop too). Each one needs a reason that goes to the owner as a statement of
  reasons (Art. 17), is logged in the customer's history and the operator's audit log, and is undone with one click.
- **Automatic pause** – every 10 minutes the last 500 sent e-mails of each customer are checked (from 100 on): more than **0.1 %**
  reported as spam or more than **5 %** bounced pauses the customer's sending, with the rate as the reason, a mail to the owner and an
  alert to the operator. After the operator resumes it only mails sent afterwards count. Off with the switch under *Missbrauch*.
- The AGB template names these measures and the notice form (§ 7).

## Customer sites: their own origin and verified domains

Phishing pages on website builders are common, and a Safe Browsing entry for the login domain would hit every customer. Two rules
(`modules/cloud-sites.ts`):

1. **Never on the login origin.** A customer's site is not served on the app's address, the cloud domain or a login domain. With
   `PGHL_CLOUD_SITES_DOMAIN=example-sites.net` (a registrable domain of its own – not a sub-domain of the login domain; ideally on the
   Public Suffix List) a request for `/p/<slug>` there is redirected to `https://<slug>.example-sites.net/…`, which serves the site
   (DNS: `*.example-sites.net` to the server; Caddy fetches the certificates through `/api/tls/ask`). Without a sites domain such a
   request is redirected to the site's verified custom domain or refused – set the sites domain before customers publish (the
   overview checklist asks for it). The operator's own sites are unaffected.
2. **Custom domains only after verification.** A custom domain of a customer's site starts once the TXT record
   `_pghl-verify.<domain>` holds the value shown in the site settings (`pghl-verify=…`, derived from the instance secret). The app
   checks waiting domains every 10 minutes and on *aktualisieren* (`POST /api/site-domain-check`); until then the domain shows a
   "being verified" page and gets no certificate. This stops a customer from taking over a domain whose DNS still points at the
   server. Domains connected before this rule existed count as verified.

## B2B-only signup

*Agentur → Cloud → Einstellungen → Stripe → Nur Unternehmen (B2B)*, **on by default**: the signup form asks for the company name (always
required) and a VAT ID or the confirmation "Ich bestelle als Unternehmen (§ 14 BGB)"; a consumer cannot finish the signup. The VAT ID
is checked for its format (Stripe Tax validates it at checkout when *USt-IdNr. abfragen* is on); the confirmation and the VAT ID are
stored in the customer's history (*Unternehmer bestätigt*). The AGB template states that the service is for businesses only and
that a contract with a consumer may be terminated – which spares you the consumer rules (withdrawal right, cancellation button,
OSS for EU consumers). Switching it off removes the questions; then those consumer rules apply to you.

## Agentur plan: client accounts and white-label

White-label is the Agentur plan's headline, and only this plan has it: `entitlements()` in `server/services/cloud.ts`
gives `white_label`, `client_accounts` and `custom_domain` to `agency` alone, and every white-label route checks its own
entitlement (`/api/cloud/branding` → white-label, `/api/cloud/domain` → custom domain, `/api/cloud/clients` → client
accounts) – Solo and Team & Company customers get 403 (`tests/cloud.test.ts`). It includes:

- the agency's own **name, logos (light/dark, mark, favicon) and colours**, login title and text – for the agency and for
  each client account;
- its own **login domain** and **custom domains for clients** (certificate on the first visit);
- the **installable app (PWA)** with the brand's name and icon – the manifest and the iPhone/iPad icons follow the login
  domain; a branded **Android APK** has to be built by the agency itself (`android/README.md`), it is not in any store;
- the brand instead of the operator's in the login, the app shell and the browser tab (a few built-in texts still name
  the product, e.g. the built-in agent's default name – the rename branch makes those follow the brand);
- **client sub-accounts** for the agency's own customers, and logins restricted to one client with
  the usual client areas. All client accounts are covered by the owner's subscription and share its status
(paused owner → clients read-only). Deleting a client account erases its data like a tenant deletion.

Not covered yet: running the *SaaS mode for the agency's own customers* (selling their own plans through their
own Stripe) – that stays an operator feature of a self-hosted instance. See [saas.md](saas.md). Pages and posts must
therefore not say "SaaS mode from 199 €": it is "white-label from 199 € in the cloud, SaaS mode self-hosted from 0 €".

## Cloud or self-hosted?

The short version of the comparison on `/cloud` and the landing page ([landing.md](landing.md)) – same software, every
feature; the difference is who runs the server:

| | Cloud (Solo 49,99 € · Team & Company 99,99 € · Agentur 199 €) | Self-hosted (0 €, AGPL) |
| --- | --- | --- |
| Start | an account in minutes, no server, Docker or Linux | one command on your server ([deploy](deploy/README.md)) |
| Updates, security patches | the operator installs them | yours ([self-hosting.md → Updates](self-hosting.md#updates)) |
| Backups | the operator's hourly encrypted off-site backups with a monthly restore test ([backups.md](backups.md)); your own ZIP export any time | yours ([self-hosting.md → Backup](self-hosting.md#operations-backup-and-performance), [backups.md](backups.md)) |
| TLS, domains, mail deliverability | handled; custom domains on the Agentur plan | yours ([deliverability.md](deliverability.md)) |
| Where the data is | the operator's server – gohyperlevel.com: planned in Frankfurt am Main, Germany (not open yet, [waitlist](#waitlist-mode)); AVV at signup | your server |
| White-label, SaaS mode | white-label on the Agentur plan; no SaaS mode | both included |
| Help | the operator's support address (*Agentur → Cloud → Einstellungen → Support-E-Mail*) | the community (GitHub Issues/Discussions) |

Switching: the cloud export (ZIP with JSON/CSV per table and the files) can be read back in part – contacts through the
CSV import; a one-click move between the cloud and a self-hosted instance (either way) does not exist yet.

## Waitlist mode

While the service is not open – no Stripe key yet, or on purpose – the cloud mode runs as a **waitlist**: nobody can sign
up, enter payment data or be charged, and the public pages lead with self-hosting and collect interest instead.

| `PGHL_CLOUD_WAITLIST` | |
| --- | --- |
| unset (default) | on while the cloud mode has no Stripe key (*Agentur → SaaS → Einstellungen* or `PGHL_CLOUD_STRIPE_SECRET_KEY`); entering the key opens the signup at once, without a restart |
| `1` | on, even with Stripe – and on the [landing page](landing.md#cloud-waitlist-mode) of an instance without cloud mode |
| `0` | off, even without Stripe (a test instance whose trials need no card; card-required signups still stop at "Bezahlung nicht möglich") |

**What is refused.** A router wrapper (`server/modules/cloud-waitlist.ts`) answers `POST /start`, `GET|POST
/start/verify/:token`, `GET /start/google/callback` and – in cloud mode – the SaaS self-signup `GET|POST /signup` with
**403** (the waitlist page, or JSON `{error, waitlist: true, waitlist_url}` for JSON callers; `GET /signup` redirects to `/start`). No
signup row, no account or sub-account, no verification mail, no Stripe Checkout – even for direct calls. Existing customers
are not touched: login, account, billing portal, plan changes and client accounts keep working, and a Checkout that was paid
before the switch still completes (webhook or `/start/done`). The agency's SaaS tools (`PUT /api/saas/locations/:id`,
`POST /api/saas/locations/:id/checkout`, the MCP tool on top) answer **409** when they would put a cloud plan on a sub-account
that is not already a cloud customer.

**What the pages show.** `/start` is the waitlist page (German; English with `?lang=en` or an English browser). `/cloud`
keeps the plans and prices but marks them *Bald verfügbar* and *voraussichtlich*, every button reads *Auf die Warteliste*
(with the plan preselected), and trial, card and payment wording, the "Beliebt" tag and the payment FAQ are gone. The landing
page leads with *Kostenlos selbst hosten* ([landing.md](landing.md#cloud-waitlist-mode)). `GET /api/version` says
`cloud.waitlist: true`, `GET /api/public/cloud/pricing` says `waitlist: true`.

**Where the sign-ups go.** With `PGHL_LANDING_LOCATION` into that sub-account's waitlist form through the
[landing waitlist hook](company-playbook.md#landing-page-waitlist-dogfooding): source „Cloud-Warteliste“, the plan in
`custom.plan`, the form's Double-Opt-in and consent proof – the page then shows the form's own consent text and asks for the
first name it requires. Without it into the **built-in list**: e-mail, optional name, plan, language, the consent text as
shown (with the privacy link) and its time, the IP only as a keyed hash; one row per address (a second sign-up updates plan
and language). Both ways: a honeypot, a signed time token (at least 2 seconds), 6 posts per IP and 3 per address an hour. The
built-in list **never sends mail**; a new entry reaches the admins as a push notification without the address. The consent
links `PGHL_LANDING_PRIVACY_URL`, else `/cloud/legal/datenschutz` – mention the waitlist (purpose, consent, deletion) in that
privacy policy.

**The list.** *Agentur → Cloud → Warteliste*: whether the mode is on and why, where entries go, the list with search, CSV
export and delete (access and erasure under the GDPR; export and delete land in the audit log). On a landing-page instance
without cloud mode there is no console tab – use the admin routes below (e.g. the CSV export). When the cloud opens, send
the launch notice yourself, once – the entries were collected without Double-Opt-in.

API: `GET /api/public/cloud-waitlist[?lang=en]` → `{enabled, via: forms|builtin, token, plans, consent, privacy_url, need_name, doi}`;
`POST /api/public/cloud-waitlist` with JSON `{email, name?, plan?: solo|team|agency, consent: true, lang?: de|en, wt}` (`wt` = the
token) → `{ok, state: ok|doi, message}`, or `{error, state}` with 400 (`email`, `consent`, `name`, `stale`), 429 (`rate`) or 404
(`closed`, mode off). A plain form post (the same fields plus `back`: `/`, `/de`, `/cloud` or `/start`) gets a 303 back to that
page with `?wl=<state>#warteliste`. Operator (admin): `GET /api/cloud/waitlist[?q=]`, `GET /api/cloud/waitlist.csv`,
`DELETE /api/cloud/waitlist/:id`.

## Cloud → HQ CRM bridge

Dogfooding: the operator runs the cloud business in its own sub-account, set up with the template *Software- & SaaS-Firma
(HQ)* ([company playbook](company-playbook.md#the-hq-template)). Set `PGHL_HQ_LOCATION` to that sub-account's id and every
tenant shows up there (`server/modules/cloud-hq-bridge.ts`):

| Cloud event | In the HQ |
| --- | --- |
| signup / trial started (`provisioned`, `trial_started`) | contact (e-mail, company, the owner's name) + deal in **Kunden (Cloud)** → *Testphase*, tag `status:testphase`, field *Testphase endet am* |
| trial ending (the 3-day reminder), trial extended | tag `testphase:endet-bald` (removed again on extension or subscription) |
| subscribed, trial converted, reactivated | *Kunde*, tag `status:kunde`, MRR on the contact and as the deal value |
| plan changed | plan, interval, MRR and the deal name updated |
| payment failed, read-only / payment recovered | tag `zahlung:offen` set / removed (dunning) |
| cancellation scheduled / undone, cancelled | tag `kuendigung:vorgemerkt`; on the end *Gekündigt / Rückgewinnung*, tag `status:gekuendigt`, the cancel reason in *Kündigungsgrund* |
| deletion scheduled / undone | tag `loeschung:geplant` |
| account erased (`deleted`) | the contact is **anonymised**: name, e-mail, company and the other personal fields are cleared, its notes, tasks, messages, conversations, form submissions and timeline deleted; plan, MRR, interval, source, dates and the pseudonymous account id stay (like the tenant's own tombstone) |

The stage always follows the subscription status (trialing → *Testphase*, active or past due → *Kunde*, cancelled or a
trial that ran out unpaid → *Gekündigt / Rückgewinnung*), so a missed event heals with the next one. Fields: *Tarif*,
*MRR*, *Abrechnung* (interval), *Quelle* (`Cloud-Anmeldung`, or `Landingpage` when the person came through the waitlist
first – matched by e-mail) and *Cloud-Konto (ID)*; nothing else of the customer's data is copied. Every event adds one
line to the contact's timeline. One contact and one deal per tenant (`cloud_hq_links`); the HQ's own workflows react to
the status tags once you activate them. A customer's sub-account is refused as HQ, and without `PGHL_CLOUD_MODE=1` the
bridge is off. It hangs on `app.services.cloudEventTaps` (below).

## Hooks for module authors

Cloud code is split into modules registered in `server/modules/index.ts` (`cloud`, `cloud-pages`,
`cloud-signup`, `cloud-billing`, `cloud-account`, `cloud-console`, and `cloud-waitlist`, which also runs for the landing page
without cloud mode). Shared files only got these small seams
(also listed in [architecture.md](architecture.md)):

- `app.services.saasEventTaps` – functions called after every handled Stripe event (the cloud billing module
  logs history and sends mails from here).
- `app.services.cloudEventTaps` – functions `(app, tenantId, type, detail)` called after every tenant event written by
  `logCloudEvent` and for the trial-ending reminder (`trial_ending`); synchronous, may run inside the hard delete's
  transaction, a failing tap is logged and never breaks billing (used by the [HQ bridge](#cloud--hq-crm-bridge)).
- `app.services.cloudCompleteSignup` – the SaaS webhook hands checkout sessions with `cloud_signup_id` to cloud.
- `app.services.hideUser(user, locationId)` and `hiddenUser()` in `server/core/permissions.ts` – people lists of a
  sub-account skip users that must not appear there (operator admins in tenants); `app.services.hiddenLocations(user)`
  and `visibleLocations()` – the operator's sub-account lists skip customers not open for support.
- `app.services.storageGate(locationId, bytes)` – refuses an upload that would pass the plan's media storage (403 for the
  team's own uploads); `app.services.storageMeter(locationId)` – `{ used, limit }` in bytes for gates that answer in their own
  words (public form uploads, `modules/public-upload-quota.ts`).
- `app.services.cloudMailer` – replace the mail transport (tests use it), `app.services.cloudFormMinMs` – the
  minimum fill time of the signup form (tests set it to 0), `app.services.cloud` – `info()`, `reconcile()`,
  `tenantOfLocation()`, `tenantOfUser()`, `resetLimits()`.
- `app.services.cloudWaitlist` – `enabled()`, `reason()`, `view({lang, back, plan?, state?})` (what a page needs to render the form),
  `via()`, `resetLimits()`; `app.services.cloudWaitlistMinMs` – the waitlist form's minimum fill time (tests set it to 0).
  `cloudWaitlist(app)` / `cloudWaitlistReason(app)` in `modules/cloud.ts` decide the mode; texts and the form's HTML are pure in
  `services/cloud-waitlist.ts`, the landing page's replacements in `services/landing-waitlist-copy.ts`.
- `GET /api/version` carries `cloud: { enabled, waitlist, signup_url, pricing_url }` so the web app shows the cloud pages.
- `app.services.cloudAbuse` (`flags`, `sendingBlocked`, `sitesBlocked`, `act`, `autoPause`) from `modules/cloud-abuse.ts`, which wraps
  `app.services.usageGate`, adds one guard and a router wrapper on the public `/p/:funnel…` and `/f/:id…` routes;
  `modules/cloud-sites.ts` adds a rewrite in front of the funnels' one, a router wrapper on `/p/:funnel…` and wraps
  `app.services.wantedDomains` and `app.services.domainStatus` (test hook `siteDomainTxt`). The `notice` kind of `cloud-mail.ts`
  carries free-form notices (statements of reasons, receipts).

## API

Customer (`user` routes): `GET /api/cloud/me|plans|team|clients|invoices|branding|legal|onboarding|avv|export`,
`POST /api/cloud/plan|subscribe|subscribe/confirm|portal|cancel|delete|delete/undo|legal/accept|team|clients`,
`PUT /api/cloud/branding|domain|support`, `PATCH|DELETE /api/cloud/team/:id`, `PATCH|DELETE /api/cloud/clients/:id`,
`GET|POST /api/site-domain-check` (verification of a site's custom domain).
Public: `GET /cloud`, `GET|POST /start`, `/start/verify/:token`, `/start/done`, `/start/google/callback`,
`/cloud/legal/:doc`, `GET /api/public/cloud/pricing`, `GET|POST /api/public/cloud-waitlist` ([waitlist mode](#waitlist-mode)). Operator (`admin`): `/api/cloud/console/overview|tenants|
tenants.csv|settings|legal|signups|reconcile|abuse`, `tenants/:id[/extend-trial|comp|plan|open|delete|abuse]`, `abuse/:id` and
`abuse/settings`; the waitlist `GET /api/cloud/waitlist[.csv]`, `DELETE /api/cloud/waitlist/:id`; public `GET|POST /abuse`. Details in
[api.md](api.md#cloud-mode).

## Operating it

- A background tick (`reconcile`, about once a minute) handles trial expiry and reminders, comped plans running
  out, payment reminders, read-only, the deletion schedule, self-deleted accounts and housekeeping. *Agentur →
  Cloud* has no button you must press; `POST /api/cloud/console/reconcile` runs it on demand.
- **Backups**: the SQLite file and the upload folders hold all customers together. Set up the **off-site encrypted
  backups** before the first paying customer – hourly to S3-compatible storage at another provider, retention 48 hourly /
  14 daily / 6 monthly, a monthly restore test, `npm run backup:restore` ([backups.md](backups.md)). The overview checklist
  stays red until they are configured. A restore brings back deleted customers; keep that in mind for the deletion promise in
  your AVV (deleted customers can remain in backups for up to six months with the default retention).
- **Uptime and alerts**: point an external monitor at `/healthz?strict=1`; alerts for disk, backup age, a stalled scheduler and
  error spikes go by e-mail, push and webhook ([backups.md → Uptime and alerts](backups.md#uptime-and-alerts)).
- **Status page**: `/status` is on in cloud mode – components, 90 days of uptime from the instance's own health samples and the
  incidents you write under *Agentur → System* ([backups.md → Status page](backups.md#status-page)). Enter its address (or an
  external status page) as *Status-Seite* in the settings; it is linked from the pricing page and the account.
- **Incidents**: the [incident runbook](incident-runbook.md) – contacts, the GDPR 72-hour steps with templates, restore, key rotation.

## Known limits and open questions

- One SQLite instance serves all customers (see above); scale out by running instances.
- The auto-pause looks at the last 500 sent mails: there one complaint is already 0.2 %, above the 0.1 % limit – a single spam
  report pauses the customer's sending until you resume it. That is deliberately strict for a new service; switch the automatic
  pause off under *Missbrauch* if it bites honest senders.
- Taken offline are sites, their blog and help center (`/p/…`) and forms (`/f/…`); booking pages, webinars and the members' area of
  a blocked customer stay up – suspend the account to stop its logins and sending as well.
- The operator has database-level access; consent covers the product surface only.
- The operator's sub-account lists (`/api/me` switcher, *Agentur → Projekte*, the agency overview and `/api/locations`)
  leave out customers that have not opened their account for support, so the operator lands in an own account and
  the console is the customer list. Other agency-wide views that aggregate across all accounts (reports, SaaS
  dashboard) can still count tenants; the SaaS dashboard also overcounts comped tenants' MRR – the cloud console's
  MRR is the one to read.
- Storage fair use counts the media uploads of a sub-account (the `uploads` table) and is enforced for uploads
  through `/api/uploads`; files other modules store (form files, generated media, …) are not counted.
- Deleted files are found by the ids in the names of files in the known data folders (`uploads`, `form-files`,
  `community`, `acc-docs`, `hr-docs`, `pm-files`, `teamchat-files`, `genmedia`, `call-intel`, `call-audio`,
  `office-files`, … – the list `FILE_DIRS` in `server/services/cloud-export.ts`, plus the scaled picture copies in
  `uploads-opt`); a module that stores files elsewhere has to be added to that list. Queued deletions for the knowledge memory (`cognee_deletions`, with the
  sub-account's own Cognee login) outlive the customer until Cognee has deleted its datasets.
- The Agentur plan does not yet include "SaaS mode for the agency's own customers".
- The legal templates need a lawyer; the product name in the shipped texts comes from the agency branding.
- Invoices for the subscription come from Stripe (Billing invoices with Stripe Tax); they are listed in the app but
  not turned into German GoBD invoices of the operator's bookkeeping.
