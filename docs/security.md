# Security

HyperLevel is a multi-tenant CRM: one **agency** runs many **sub-accounts** (clients), each with member logins,
public pages (funnels, forms, booking, portals) and integrations. This page describes what we protect,
how, how to report a vulnerability, and how to harden your own installation. The latest review and its
findings are in [security-review-2026-10.md](security-review-2026-10.md).

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through the repository's
*Security → Report a vulnerability* (GitHub private vulnerability reporting). Include the affected version
or commit, the steps to reproduce and the impact you see. We aim to confirm within 3 working days, to ship
a fix for critical/high issues within 14 days, and to credit you in the advisory unless you prefer not to be
named. Please give us a reasonable time to fix before you publish, and do not access other people's data
beyond what is needed to show the problem.

## Threat model

| Who | Can do | Must never be able to |
| --- | --- | --- |
| Anyone on the internet | Open public pages, submit forms, book, chat, call webhooks | Read or change data, reach the server's internal network, exhaust the server |
| Visitor of a public page | Submit their own data | Run script in the app's origin (stored XSS), redirect elsewhere through our links |
| Portal member / affiliate (magic link) | Their own courses, tickets, community posts, partner data | See other members' private data or other sub-accounts |
| Client login (member of sub-account A) | The areas granted in sub-account A | Read or change sub-account B, agency settings, other users |
| Sub-account API key (`pghl_…`) / its MCP client | The API of its sub-account | Escape its sub-account, manage users or keys |
| Agency API key (`pghla_…`) / AI agents via MCP | Data of every sub-account (read-only keys: reads only) | Manage users, sessions, keys, personal connections, download database backups |
| Mobile device token (`ghm_…`) | `/api/mobile/*` as its user | Any other route |
| Third parties sending webhooks (Stripe, Twilio, Meta, Todoist, OpenShorts) | Deliver signed events | Forge events without the shared secret |
| Website owner's custom code (funnels/blog) | Run on their own pages | Read the app's cookies or call the API as the visitor |
| Someone with a database copy (backup, stolen disk) | Read business data | Read integration credentials or 2FA secrets (sealed; key lives outside the DB) |

Trust boundaries: agency ↔ sub-account, sub-account ↔ sub-account, public ↔ logged-in, server ↔ its internal
network (SSRF), app origin ↔ owner code (funnels are sandboxed).

## What is protected, and how

### Sign-in and sessions
- **Passwords**: scrypt N=2^15, r=8, p=3 (OWASP's 32 MiB profile), per-user salt; older hashes are upgraded at
  the next login. Hashing runs off the event loop with a concurrency cap. New passwords: 8–1024 characters.
- **Brute force**: 5 failures per address → 1 minute pause; 10 failures per account in 15 minutes lock the
  account (wrong 2FA codes count too, from any address); changing the password with a session is throttled
  the same way. Unknown e-mails cost the same scrypt run (no account probing by timing).
- **Sessions**: 32 random bytes, only the SHA-256 is stored; cookie `HttpOnly`, `SameSite=Lax`, `Secure` when
  `PGHL_BASE_URL` is https, 30 days. A login drops any session id the browser brought along (fixation). A new
  password (own or set by the admin) signs the person out everywhere; devices can be listed and revoked.
- **Live streams end with their login**: every Server-Sent-Events stream a person opens (Team-Chat, Team-Posteingang,
  Canvas, Living Boards, presence) is bound to the session – or the app's device token – it was opened with. Signing
  out, a revoked session or device and a new password end it at once, an expired session at the next check (every
  20 s); the stream's last event is `bye`, so the browser does not reconnect on its own. A stream opened with a key is
  bound to that key: deleting the sub-account or agency API key, or disconnecting the MCP connection (or its access
  token running out), ends it the same way (`server/services/stream-login.ts`).
- **2FA**: TOTP (secret stored sealed), each code works once, 8 hashed backup codes; admins can reset it.
- **Invites / magic links**: 32 random bytes, hashed, expiring, single use (claimed atomically).

### CSRF and CORS
- Cookie-authenticated writes need the header `x-pghl: 1` (a cross-site form can't set it; a cross-site script
  would need a CORS preflight, which the API never allows).
- Portals (courses, community, help desk, affiliates) use their own cookies, check `Origin`/`Sec-Fetch-Site` and
  a per-session form token.
- CORS `*` (without credentials) only on `/api/public/*` and `/hooks/*`; the API and `/mcp` send no CORS headers.

### Authorization and tenant isolation
- Every route declares `public`, `user`, `admin` or `location`. `location` routes resolve the sub-account from
  the login (`x-location-id` must be one of the user's) or from the key (a sub-account key is bound to one).
  Every query filters by that sub-account.
- Member areas (`server/core/permissions.ts`) are enforced by a guard on every request; SaaS plans the same way.
- <a id="roles"></a>**Own roles** (*Einstellungen → Team → Rollen*, `server/modules/role-templates.ts`): a role is a named set of areas plus
  the areas its members may only **read** – a second guard refuses every non-GET request to a read-only area ("Nur Lesezugriff auf …").
  Presets: Vertrieb, Marketing, Kundenservice, Buchhaltung, Assistenz (nur lesen). Assigning a role sets the members' areas; editing the
  role updates everyone who has it; editing a member's areas by hand (Team → Bearbeiten) takes them out of the role; deleting a role
  keeps everyone's current areas. Admins are never restricted. API (admin): `GET|POST /api/role-templates`, `PATCH|DELETE
  /api/role-templates/:id`, `POST /api/role-templates/:id/assign` `{user_ids}`, `POST /api/role-templates/unassign`; MCP `ghl_role_templates`.
  Roles are changed only with a login: agency keys and OAuth connections may read them but every write is refused (keys manage data, not people).
- Agency keys act like an admin on data but are refused on users, `me`, sessions, keys, `auth`, OAuth, push,
  mobile pairing and database backups; read-only keys can only read. A read-only key or OAuth connection may still run the
  read-only MCP tools that ask with a POST (reports, calculations, a workflow dry run): the MCP relay marks those calls with a one-time
  token only the server process knows, so the marker cannot be sent from outside.
- In-process calls (`callRoute`, MCP relay, mobile API) re-run the same checks.
- **Test**: `tests/tenant-isolation.test.ts` enumerates every registered route and lets a member, a key, a device
  token and MCP of sub-account A try every id of sub-account B (path, query, body, natural keys like url/e-mail).
- **Record-level access** (contacts, companies, deals, tasks, conversations – off by default, [sales.md](sales.md#record-access-and-teams)):
  one router wrapper checks the record a path, query or body names, child rows (notes, messages, calls, analyses,
  dialer entries, media) follow their parent, and lists drop what a person may not open. **Test**:
  `tests/record-access-leaks.test.ts` lets a person limited to their own records fire every route at another
  person's records (with seeds for the data that hangs on a contact: calls, analyses, dialer entries, AI phone
  sessions, drafts, media), and `tests/sec-review-access.test.ts` pins the routes the harness cannot see by marker.
- **Hosted cloud**: the operator reaches a customer's data only while the customer allows support – sub-account
  routes, agency lists, cross-account reports, the audit log and user management all check it
  (`tests/sec-review-cloud.test.ts`, [cloud.md](cloud.md#isolation-and-support-access)). A host (custom domain)
  belongs to one site, help center or login: `app.services.domainTaken` decides, for everybody.

### Input and output
- Server-rendered pages escape every value (`escapeHtml`); `tests/xss.test.ts` stores a payload in every text and
  opens every public page (anonymous, member, affiliate) with every id it can find.
- Markdown is escaped first, links only `http(s)`, `/`, `#`, `mailto:`, `tel:`; external links get
  `rel="noopener"`; the parser is linear on hostile input.
- **Wiki and Team-Chat** render Markdown on the server in two independent layers (an escaping renderer that
  writes only its own tags and checks every URL, then an allow-list sanitiser over the finished HTML) with a work
  budget per render; the shared Wiki page (`/wiki/s/<token>`) is sent with `default-src 'none'` (no script),
  `noindex` and `no-referrer`. `tests/wiki-render.test.ts` runs ~70 hostile payloads through page, public, chat
  and comment rendering; `tests/xss.test.ts` and `tests/tenant-isolation.test.ts` cover the stored pages and channels.
- Funnel and blog pages may carry the owner's custom code, so they are served with `Content-Security-Policy:
  sandbox …` (opaque origin: no cookies, no API access as the visitor).
- CSP: the app shell `default-src 'self'; script-src 'self'; frame-ancestors 'none'…`; portals and help center
  `default-src 'none'` with exceptions; other server pages at least `object-src 'none'; base-uri 'self'`.
  Modules can add origins to the app CSP only as plain `https://`/`wss://` hosts (`app.services.cspExtra`).
- SQL is always parameterised; identifiers come from code or strict allow-lists (`KEY_RE`).
- Uploads: allow-listed types, the bytes must match the type (magic bytes), no SVG/HTML, stored with an
  extension derived from the checked type, served with `nosniff` and a restrictive CSP; form files only to
  logged-in users, inline only for images/PDF.
- CSV exports prefix cells starting with `= + - @` (formula injection); mail headers never carry line breaks;
  redirects only to same-site paths without control characters.

### Outbound requests (SSRF)
User-supplied URLs (webhooks, REST hooks, workflow HTTP steps, iCal import, SMS gateway, uptime checks, feeds)
go through `safeFetch`: http(s) only, the **resolved** IP is checked on connect (no DNS rebinding) against
private, loopback, link-local, CGNAT, documentation, multicast and transition ranges incl. IPv4-mapped IPv6,
redirects (max. 3) are checked again and lose `Authorization`/`Cookie` when they leave the origin, responses are
size-capped and time-boxed. `PGHL_ALLOW_PRIVATE_FETCH=1` turns the check off (only for LAN-only installs).

### Secrets at rest
- Integration credentials (SMTP/IMAP passwords, Twilio, Stripe, Meta, Google, OAuth tokens, AI keys, HubSpot,
  Todoist, Supabase, ads), 2FA secrets and webhook signing secrets are sealed with AES-256-GCM.
- Key: `data/data.key` (or `PGHL_DATA_KEY`), otherwise derived from `data/secret`. **`npm run rotate-secret`**
  creates a new key and re-seals every stored value (`--dry-run` to count, `--signing` to also replace the signing
  secret – old unsubscribe/survey links then stop working). Old keys stay readable via `data.key.previous`.
- Secrets never go back to the browser (masked as `••••••`); `tests/secret-leaks.test.ts` calls every GET route with
  every id and fails on any stored credential or sealed value in a response.
- API keys, session ids, device tokens, magic links and backup codes are stored only as hashes.

### Webhook signatures (inbound)
| Source | Check |
| --- | --- |
| Stripe (per sub-account and agency) | `Stripe-Signature` HMAC-SHA256, 5-minute tolerance |
| Twilio (voice, SMS status, browser phone, voice AI) | `X-Twilio-Signature` over URL + params |
| Meta (WhatsApp, Messenger, Instagram) | `X-Hub-Signature-256` with the app secret (unsigned → refused) |
| Todoist | `X-Todoist-Hmac-SHA256` |
| OpenShorts | `sha256=` HMAC per job |
| "Webhook empfangen" (`/hooks/in/:token`) | secret URL + optional HMAC (`X-Signature-256`), rate limit per URL |
| Inbound SMS/mail, support mail, workflow webhooks | secret key in the URL |

All comparisons are constant-time. Outgoing webhooks and REST hooks carry `x-pghl-signature-256:
sha256=<HMAC-SHA256(secret, body)>` (preferred) plus the older `x-pghl-signature` (`sha256(secret + body)`).

### Abuse and denial of service
- A request without valid credentials is refused on its headers, before its body is read.
- Bodies: 1 MB on public routes (larger only where needed: form uploads, inbound mail, community images, MCP with
  a valid key), 12 MB behind a login; raw uploads (APK, videos) only for authorised uploaders.
- Rate limits: 900 API requests/min per address, 120 public writes/min per address, plus per-feature limits
  (login, forms, chat, sign-up, magic links, coupons, inbound webhooks, device tokens).
- Timeouts: headers 20 s, request 5 min, keep-alive 5 s; outbound calls time-boxed; report queries have a
  time limit and row cap; page sizes are clamped.
- SQLite: WAL, `busy_timeout`, `secure_delete`, `trusted_schema=OFF`.

### Transport and headers
HSTS (with an https base URL), `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`,
`X-Frame-Options: DENY` + `frame-ancestors 'none'` + `Cross-Origin-Opener-Policy` for the app; forms and
booking pages stay embeddable on purpose. The client address is the right-most `X-Forwarded-For` entry added by
your proxy (`PGHL_PROXY_HOPS`), never one a client made up.

### Audit log and privacy
- Every authenticated write is logged (who, how – session, API key, agency key, MCP, app – from where, which
  sub-account), plus logins, failed logins, lockouts, failed 2FA, rights changes (with the changed fields) and
  every export/download/backup. Entries are kept for one year.
- GDPR: **DSGVO-Auskunft** (`GET /api/contacts/:id/privacy-export`) exports everything about one person;
  **DSGVO-Löschung** (`POST /api/contacts/:id/erase`) removes them from every module (files on disk included: form
  uploads, community pictures and videos, course hand-ins, task attachments, cached certificate PDFs, call-analysis audio,
  and call recordings and voicemails at Twilio);
  invoices, signed contracts and sent payment reminders are kept for legal retention without the link, and so are
  the agency's own records about the client (projects, retainers, payment plans). Audit entries about the person or naming
  them (e-mail, full name, phone) keep the action but lose the summary, and other records' timelines say `[gelöscht]`
  instead of the name. Agency-wide by e-mail:
  `/api/agency/privacy/export|erase`. MCP: `ghl_contact_privacy_export`, `ghl_contact_erase`.
- **Deleting a login** (a team member, a cloud team member or the logins of a deleted client account) also removes what was
  private to the person: AI assistant chats with their uploads and pending confirmations, Custom-GPT keys, personal tokens for
  outside MCP servers, login and connect leftovers, the own notification lists, private views and reports, and the person's
  places as task assignee and watcher (`server/services/user-erase.ts`). Sessions, passkeys, devices, presence settings, push
  subscriptions, OAuth connections and personal mailboxes go through their foreign keys. What the person did for the team
  (messages, notes, comments, tasks, time entries, the audit log) stays with the name on it.
- The **Wissensgedächtnis (Cognee)** ([docs/cognee.md](cognee.md)) sends data to a Cognee server only for sub-accounts that
  opted in, per data type, into datasets named after the sub-account (a dataset of another sub-account is refused in code
  before a request is made); e-mail addresses, phone numbers and IBANs can be redacted first. **DSGVO-Löschung** queues the
  deletion of the contact's data items in Cognee in the same transaction; record deletions, switching a type off and deleting a
  sub-account follow. Logins to Cognee are sealed at rest and never returned; every push, search and deletion is audited
  (counts only). HyperLevel warns about, and by default does not feed, a server without access control.
- The **undo journal** (Rückgängig, Verlauf, Papierkorb – [docs/undo.md](undo.md)) keeps copies of changed and deleted
  records for 30 days (setting 1–365, daily cleanup). People undo their own changes, admins anyone's within their
  sub-accounts, and a member sees only entries of areas they may use; entries never cross sub-accounts. Credentials of a
  deleted person (portal sessions, login links) are not copied; **DSGVO-Löschung** removes the contact's journal entries
  too. Deleted records stay restorable for the retention time unless an admin uses *Endgültig löschen*.
- Private channels and direct messages of the Team-Chat are readable by their members only – agency admins,
  API keys and MCP connections included (they reach public channels of one sub-account); the retention setting
  deletes old messages and their files.
- Daily backups (14 kept by default) still contain erased people until they rotate out – keep that in your
  privacy notice or shorten `PGHL_BACKUP_KEEP`.

### Supply chain
`package-lock.json` pins every package with an integrity hash (`npm ci`). `npm audit --omit=dev`: 0 known
issues at the time of the review. The Docker image runs as the unprivileged `node` user; the compose file drops
all capabilities. CI workflows should pin third-party actions by commit SHA.

## Hardening checklist for self-hosters

- [ ] Serve only over HTTPS and set `PGHL_BASE_URL=https://…` (enables `Secure` cookies and HSTS).
- [ ] Behind a reverse proxy: `PGHL_BEHIND_PROXY=1`, and `PGHL_PROXY_HOPS` = number of proxies that append to
      `X-Forwarded-For` (1 for Traefik/Caddy/nginx alone, 2 with Cloudflare in front). Never expose port 4700
      directly when you trust the header (the compose file binds it to 127.0.0.1).
- [ ] Create the first admin with `PGHL_ADMIN_EMAIL`/`PGHL_ADMIN_PASSWORD` – until an admin exists, whoever opens
      the setup page first becomes admin.
- [ ] Turn on 2FA for every admin; give client logins only the areas they need.
- [ ] Give AI agents and automations **read-only** agency keys or sub-account keys, one per tool, and revoke
      unused ones (Agentur → API & MCP).
- [ ] Protect the data folder: `data/secret` and `data/data.key` decrypt your stored credentials. Back them up
      separately from database backups, never commit them, keep backups encrypted and off-site.
- [ ] After a suspected leak of a backup or the data folder: rotate integration credentials at the providers, then
      `npm run rotate-secret` (stop the server first).
- [ ] Docker: the image runs as `node`. Upgrading from an older image that ran as root:
      `docker compose run --rm -u root crm chown -R node:node /data` once.
- [ ] Leave `PGHL_ALLOW_PRIVATE_FETCH` unset unless the install is LAN-only.
- [ ] Keep Node.js 22 and the image up to date; run `npm audit --omit=dev` after updates.
- [ ] Review the audit log (Agentur → Protokoll) for failed logins, lockouts and exports.
- [ ] Set up SPF/DKIM/DMARC for the sending domains you configure.
- [ ] The optional domain agent runs privileged on the host – only enable it on a server you dedicate to HyperLevel.
