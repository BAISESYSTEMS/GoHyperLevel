# Mailbox sync: Gmail and Outlook / Microsoft 365

HyperLevel can work with a mailbox **natively through the official APIs** of Google (Gmail API) and Microsoft (Graph) –
no IMAP, no SMTP passwords. (The older [IMAP sync](self-hosting.md#e-mail-postfach-gmail-anbinden) stays for any other
provider.)

- **Inbox, sent mail and drafts** become conversations and messages: the contact is matched by e-mail address, threads,
  attachments, labels/folders and the read, star and archive state come along.
- **Both ways:** archive, label, mark read/unread and star in HyperLevel – and it happens in Gmail/Outlook, and the other
  way round. Drafts too: create, edit, send and delete in either place.
- **Answer from HyperLevel through your own mailbox**, in the same thread (Gmail `threadId` + `In-Reply-To`/`References`,
  Graph `createReply`), with signature, attachments, a draft or **scheduled send**.
- **Push** where possible (Gmail → Cloud Pub/Sub, Graph change notifications), otherwise a poll every 3 minutes.
- **Workflow e-mails** can optionally go out through a connected mailbox (provider *Verbundenes Postfach*).
- **MCP tools** `ghl_mailbox_list`, `ghl_mail_search`, `ghl_mail_draft`, `ghl_mail_send` for the HyperLevel Agent, Claude and Codex.

Contents: [Setup](#setup-for-the-agency-once) · [Connecting](#connecting-a-mailbox) · [How the sync works](#how-the-sync-works) ·
[Sending](#sending-and-drafts) · [Push](#push-notifications) · [Policy and review](#google-restricted-scopes-and-what-to-do-about-them) ·
[Microsoft consent](#microsoft-permissions-and-admin-consent) · [Security](#security-and-privacy) · [API and MCP](#api-and-mcp) ·
[Troubleshooting](#troubleshooting) · [For developers](#for-developers)

## Setup for the agency (once)

The mailbox connection reuses the agency's Google and Microsoft OAuth apps (**Agentur → Integrationen → Einrichtung →
Google & Microsoft (OAuth)**, or `PGHL_GOOGLE_CLIENT_ID/SECRET`, `PGHL_MS_CLIENT_ID/SECRET/TENANT`). If calendar sync
already works, **the redirect URIs are already registered** – mail uses the same ones. What you add:

### Redirect URIs to register

| Where | URI |
| --- | --- |
| Google Cloud Console → Credentials → your OAuth client (type *Web application*) → *Authorized redirect URIs* | `https://<PGHL_BASE_URL>/oauth/google/callback` |
| Microsoft Entra → App registration → Authentication → platform *Web* → *Redirect URIs* | `https://<PGHL_BASE_URL>/oauth/microsoft/callback` |

With a live agency domain (white-label) its address is shown as a second URI in the same card – register both. The
address you are signed in on is the one the flow returns to. Nothing else is called by the browser.

Only for **push** (optional, see below) there are server-to-server addresses – these are *not* redirect URIs:

| Purpose | URL |
| --- | --- |
| Gmail Pub/Sub push endpoint | `https://<PGHL_BASE_URL>/hooks/mailbox/gmail` (the settings card shows it with the secret key appended) |
| Graph change notifications | `https://<PGHL_BASE_URL>/hooks/mailbox/graph` and `…/graph/lifecycle` (created automatically per mailbox) |

### Google: enable the API and add the scopes

1. In the Google Cloud project of your OAuth app: **APIs & Services → Library → Gmail API → Enable.** (For push also
   *Cloud Pub/Sub API*.)
2. **OAuth consent screen → Data access (scopes):** add
   - `…/auth/gmail.modify` (read, label, archive, draft, send – everything except permanent deletion),
   - `…/auth/gmail.send`,
   - `…/auth/gmail.readonly` (only needed for the *read-only* access level),
   - plus `openid` and `email` (already there for calendar/SSO).
3. Decide how the app is published – this matters, see [below](#google-restricted-scopes-and-what-to-do-about-them).

HyperLevel asks for exactly the scopes of the chosen **access level** when somebody connects:

| Access level | Gmail scopes | Microsoft Graph scopes (delegated) |
| --- | --- | --- |
| **Full** – read, send, manage | `gmail.modify`, `gmail.send` | `Mail.ReadWrite`, `Mail.Send`, `offline_access` |
| **Read only** – sync, never change or send | `gmail.readonly` | `Mail.Read`, `offline_access` |
| **Send only** – no sync (for workflow e-mails) | `gmail.send` | `Mail.Send`, `offline_access` |
| Shared mailbox (Microsoft) | – | the `.Shared` variants: `Mail.ReadWrite.Shared`, `Mail.Send.Shared` (or `Mail.Read.Shared`) |

Google lets people untick single permissions on the consent screen; if a required one is missing HyperLevel revokes the
grant and asks to connect again with all of them.

### Microsoft: app registration

In the same Entra app registration used for the calendar: **API permissions → Microsoft Graph → Delegated permissions**
→ add `Mail.ReadWrite`, `Mail.Send` (and, for shared mailboxes, `Mail.ReadWrite.Shared`, `Mail.Send.Shared`;
for read-only access `Mail.Read`). `offline_access`, `openid`, `email` are there already. See
[Microsoft permissions and admin consent](#microsoft-permissions-and-admin-consent).

## Connecting a mailbox

**Einstellungen → E-Mail & SMS → Postfach verbinden (Gmail / Outlook).** Choose

- the **provider** (Gmail / Google Workspace, Outlook / Microsoft 365; for Outlook optionally the address of a
  **shared mailbox** your account can open),
- **for whom:** *Dieser Sub-Account* (the whole team of that sub-account works in it; needs the settings area) or
  *Nur für mich* (a **personal** mailbox only you can use),
- the **access level** (full, read only, send only).

You are sent to Google/Microsoft, consent, and come back; the first import runs in the background ("wird importiert").
Several mailboxes per sub-account are fine, also several personal ones. The same account connected again keeps the
mailbox and all its settings (only the tokens are replaced).

| | Sub-account mailbox | Personal mailbox |
| --- | --- | --- |
| Mail is filed in | always that sub-account | the sub-accounts your **rules** point to (first matching rule wins; optional default sub-account; everything else is **not imported**) |
| Who can use it | everyone with *Konversationen* in the sub-account (read, answer, archive, label); *Einstellungen* to manage | only the owner, only in the browser or the app – **never through an API key, agency key or MCP** |
| Rules may target | – | only sub-accounts the owner may use (checked when saving *and* on every sync) |

A personal mailbox imports **nothing** until you add a rule or a default sub-account – so private mail never lands in the
CRM by accident. Mail that came through a personal mailbox is visible to the sub-account it was filed in (it is that
sub-account's CRM data), but only the owner can change it at the provider.

### Settings per mailbox

*Einstellungen* on the mailbox card: name, signature, **sync window** (30 days to a year, default 90), the **folder /
label picker**, sender filter (all senders, or only contacts that already exist), skipping Gmail's Promotions and Social
categories, whether new inbound mail may start workflows, **Öffnungen und Klicks verfolgen** (off by default – see below), the
routing rules, push status, and *Alles neu einlesen*.
Changing the folders or enlarging the window triggers a fresh read (known mail is recognised; nothing is duplicated).

- Gmail: system labels *Posteingang, Gesendet, Entwürfe*, your own labels, and *Alle E-Mails* (everything except Spam and
  Trash). Default: Inbox, Sent, Drafts.
- Outlook: the well-known folders (Inbox, Sent Items, Drafts, Archive) and your folders directly under Inbox. Default:
  Inbox, Sent Items, Drafts, Archive. Categories are the labels.

Spam / Junk and Trash / Deleted Items are never imported.

## How the sync works

| | Gmail | Outlook / Microsoft 365 |
| --- | --- | --- |
| First import | `users.messages.list` per chosen label inside the window; the `historyId` is taken **before** listing so nothing arriving meanwhile is missed | one `messages/delta` query per chosen folder, filtered by `receivedDateTime` |
| Afterwards | `users.history.list` from the stored `historyId` (messages added/deleted, labels added/removed) | the stored `deltaLink` of each folder |
| Cursor too old | HTTP 404 → the window is read again | HTTP 410 → that folder is read again |
| Ids | message id | immutable ids (`Prefer: IdType="ImmutableId"`), so a message keeps its id when moved |
| Bodies | `format=full`, charset-aware, plain text preferred | `Prefer: outlook.body-content-type="text"` |

- A long first import is spread over several runs (about 150 messages each) and resumes where it stopped.
- **Mapping:** one conversation per contact (as everywhere in HyperLevel); each remote message is one message in it. A
  `mailbox_messages` row keeps thread id, folder, labels, read/star flags, attachments and the RFC `Message-ID`.
- **Same mail twice** (a copy in a second mailbox, a mail sent from HyperLevel, a workflow e-mail coming back from *Sent*) is
  recognised by `Message-ID` / provider id and linked, not duplicated.
- **Flags, both ways.** Read, star, archive and labels you change in HyperLevel are applied to our copy at once and queued for the
  provider (an outbox with retries and back-off; a pending change is never overwritten by an older provider state). Changes
  at the provider arrive with the next sync/push. Opening a conversation marks its mail as read at the provider too.
  Archiving = Gmail: remove `INBOX`; Outlook: move to the *Archive* folder. Starring = Gmail `STARRED`; Outlook flag.
- **Deleted or trashed at the provider:** the message **stays in the conversation** (history is valuable) and is only
  marked; **unsent drafts** disappear here too.
- **Workflows:** new inbound mail after the first import emits `message.inbound` (like webhook mail). The import itself
  never does, and neither does mail older than 48 hours.
- **Helpdesk:** with *E-Mail → Ticket → include imported mail* the mails also become tickets (from switch-on, no flood).
- Limits that are kept on purpose: 100 000 characters of text per mail, 8 MB of attachments per mail we send, 50
  recipients.

Failures: network and provider trouble back off (3 minutes, doubling, up to an hour; `Retry-After` is respected). A revoked
or expired grant stops the mailbox and shows **neu verbinden**; the background job leaves it alone until reconnected.

## Sending and drafts

From a conversation: **Per Postfach antworten** (mailbox picker, To/Cc/Bcc, subject, text, attachments, signature, *Später
senden*, *Als Entwurf speichern*). The answer

- stays in the thread: Gmail gets `threadId`, `In-Reply-To` and `References` of the mail answered (and a `Re:` subject);
  Outlook uses `createReply` on the message (so Outlook keeps its conversation);
- is recorded in the contact's conversation as sent by the mailbox's name, and the copy that later shows up in *Sent* is
  recognised;
- gets the mailbox's **signature** (switchable per mail).

Also available: new mail from any mailbox (`POST /api/mail/send`), **scheduled send** (up to 90 days ahead; a background job
sends it; when Gmail/Outlook refuses it (busy, rate limit) it is tried again up to three times and then shown – but when the
send got no answer at all (a timeout, a connection lost while waiting) it is not repeated, because the mail may be out
already: it is marked failed with a note to look in *Sent*; the same happens to a mail the server was sending when it crashed
or restarted – after 30 minutes in *sending* it is marked failed with that note, never sent again automatically), and
**drafts that live in the mailbox**: create, change, send
and delete work in HyperLevel and show up in Gmail/Outlook, and drafts written there appear here (an edit in Gmail gives the
draft a new message id – the mapping follows).

**Open and click tracking (opt-in).** With *Öffnungen und Klicks verfolgen* switched on for the mailbox, mail sent from HyperLevel
through it (new mail, replies, scheduled sends) carries the same pixel and tracked links as campaign mail; the reply composer
has a switch to send a single mail untracked. Off by default, because tracking 1:1 mail may need the recipient's consent. Only
people count – Apple Mail, image proxies and link scanners are recognised and shown as "+N maschinell". Not tracked: drafts,
the text part, mail sent outside HyperLevel. Details and privacy: [docs/email-tracking.md](email-tracking.md).

Attachments: up to 10 files, 8 MB together per mail. Outlook files over 3 MB go through an upload session. Downloads of
received attachments are streamed from the provider on demand and always served as a plain download (`octet-stream`,
`Content-Disposition: attachment`, sandboxed).

### E-mails of the sub-account through a mailbox

*Einstellungen → E-Mail & SMS → Anbieter → Verbundenes Postfach*, choose one of the sub-account's mailboxes. Workflows,
campaigns and plain messages from the inbox then go through it (so they appear in its *Sent* folder). Unsubscribe footer
and tracking stay as they are. Gmail and Microsoft have their own sending limits (Gmail about 500 recipients a day for
free accounts, 2 000 for Workspace; Exchange Online 10 000 recipients a day, 30 a minute) – a mailbox is no bulk sender;
use an e-mail API provider for campaigns to many people.

## Push notifications

Without push the mailbox is polled every 3 minutes (every 15 minutes as a safety net when push is on). With push, mail
shows up in seconds.

### Gmail → Cloud Pub/Sub

1. In the Google Cloud project: create a **Pub/Sub topic**, e.g. `projects/my-project/topics/gmail-push`, and give the
   Google account **`gmail-api-push@system.gserviceaccount.com`** the role *Pub/Sub Publisher* on it.
2. Create a **push subscription** on that topic with the endpoint from *Agentur → Integrationen → Einrichtung → Postfach-Sync:
   Push* (`https://…/hooks/mailbox/gmail?key=…`).
3. Recommended: enable **authentication** on the subscription with a service account (give Pub/Sub's service agent the role
   *Service Account Token Creator* on it) and an audience (default: the endpoint URL without the key). Enter the
   **service account** (and a custom audience, if you set one) in the card. HyperLevel then verifies the Google-signed OpenID
   token on every call: signature (Google's published keys), issuer, expiry, **audience**, verified e-mail =
   the pinned **service account**. Without a service account only the shared secret in the URL is checked (constant-time
   comparison; rotate it with *Schlüssel erneuern*).
4. Enter the **topic** in the card and save. Every Gmail mailbox then starts a `users.watch` (also via *Einstellungen → Push
   (neu) einrichten*); HyperLevel renews it before the seven days are over.

A push is only a hint ("something changed", the history id); the sync itself reads through the API. Unknown addresses,
duplicate deliveries and unreadable bodies are acknowledged and ignored.

### Microsoft Graph change notifications

Needs a **public https address** (`PGHL_BASE_URL`). HyperLevel creates one subscription per mailbox on `me/messages` (or
`users/<shared>/messages`) with a random **`clientState`** (sealed), answers Microsoft's **validation handshake** (the
`validationToken` is echoed as plain text) and accepts notifications only with the matching `clientState` (otherwise `401`).
Subscriptions live less than 3 days; they are renewed in the background, and the **lifecycle** endpoint handles
`reauthorizationRequired` (renew), `subscriptionRemoved` (subscribe again) and `missed` (read now). If the subscription
cannot be created (no public address, firewall) the mailbox is polled and the card says why.

## Google restricted scopes and what to do about them

Google classifies Gmail scopes: **`gmail.modify` and `gmail.readonly` are "restricted"**, `gmail.send` is "sensitive".
For a **public production app** that stores restricted-scope data on a server (which HyperLevel does), Google requires
**OAuth app verification plus an annual security assessment (CASA, by an approved assessor)** – real effort and cost, and
the rules change, so check Google's current requirements before you plan around this.

What that means for you:

| Option | When it fits | Review? | Catch |
| --- | --- | --- | --- |
| **Your own agency app in "Testing" with test users** | you and your team/clients (up to 100 test users you list) | none | **Refresh tokens expire after 7 days** in testing mode – connect again weekly (the card shows *neu verbinden*) |
| **Internal app (Google Workspace)** | everyone is in one Workspace organisation; set the consent screen's user type to *Internal* | none | only accounts of that organisation; tokens do not expire |
| **Production, verified** | many external customers connect their Gmail | verification **and** CASA | cost, time, yearly re-assessment |
| **Send only** (`gmail.send`, access level *Send only*) | you only need to send through Gmail (workflow e-mails) | sensitive-scope verification, no CASA | no sync, no reading |
| **IMAP with an app password** (the older [IMAP sync](self-hosting.md#e-mail-postfach-gmail-anbinden)) | small setups, no OAuth app wanted | none | no push, no labels/flags both ways, no threaded replies |

For a self-hosting agency the usual answer is *Testing* (reconnect weekly) or *Internal*. An unverified production app is
limited to 100 users with a warning screen. The consent screen needs an app name, support e-mail and an authorised domain;
none of this is a HyperLevel limitation – it is Google's policy for Gmail data.

## Microsoft permissions and admin consent

Microsoft Graph **delegated mail permissions need no special review** from Microsoft: `Mail.ReadWrite`, `Mail.Send`,
`Mail.Read` and the `.Shared` variants can be requested by any registered app. Two things can still get in the way:

- **Tenant consent settings.** Many organisations only let users consent to a short list of low-risk permissions (or only
  to apps from *verified publishers*). Then a **tenant administrator must grant consent** once: Entra admin center →
  Enterprise applications → your app → Permissions → *Grant admin consent*, or send the admin
  `https://login.microsoftonline.com/<tenant>/adminconsent?client_id=<application id>`. The connect flow then works for every
  user of that tenant.
- **Shared mailboxes** need the `.Shared` scopes *and* that the signed-in person has **Full Access** (read/manage) or
  **Send As / Send on Behalf** (send) on the mailbox in the Exchange admin center. HyperLevel checks access when connecting.

Tenant setting: `common` accepts work and personal accounts, `organizations` only work accounts, or enter a tenant id.
The client secret of the app expires (at most 24 months) – create a new one before.

## Security and privacy

- Tokens (access and refresh) are sealed with AES-256-GCM like every stored credential and never leave the server; nothing
  in the API responses contains them (the secret-leak test covers the new routes).
- The OAuth flow uses PKCE (S256) and a signed `state` that expires after 10 minutes, is bound to the browser session and
  can be used once. Connecting needs a browser login; keys and MCP cannot connect or disconnect mailboxes.
- Sub-account isolation: every route filters by the sub-account; a mailbox of one sub-account is invisible to the others
  (also in the tenant-isolation test). Areas: managing = *Einstellungen*, working in the inbox = *Konversationen*.
- Personal mailboxes are only usable by their owner in a session or the app.
- The Pub/Sub token and Graph `clientState` checks are described above; the webhooks reveal nothing and acknowledge
  unusable bodies.
- Every write is in the audit log (`mailbox.connect`, `mailbox.disconnect`, `mailboxes.update`, `mail.send.create`,
  `mail.conversations.reply.create`, `mail.drafts.*`, `mail.send.scheduled`, `mailbox.tracking`, …).
- **Disconnecting** revokes the grant at Google (Microsoft has no way to revoke a single token – remove the app at
  *myaccount.microsoft.com → Privacy → Apps* too), stops push, and deletes tokens and the sync mapping. The mail already in the
  conversations **stays** (delete the contact – or use the GDPR erase – to remove it).
- GDPR: erasing a contact also removes the mapping rows of its mail; the mail in the mailbox itself belongs to the mailbox owner.
- Agent safety: the HyperLevel Agent treats mail as untrusted content; `ghl_mail_send` is a *sensitive* tool (it asks before it
  sends unless an admin switched that off), `ghl_mail_draft` only creates a draft.

## API and MCP

Routes (sub-account scoped, `x-location-id`; the *area* decides who may call them):

| Area | Route |
| --- | --- |
| Einstellungen | `GET /api/mailboxes` (mailboxes, providers, push readiness), `POST /api/mailboxes/connect` `{provider, scope: location\|user, access: full\|readonly\|send, name?, shared_address?, mailbox_id?}` → `{url}`, `PATCH /api/mailboxes/:id` `{name, enabled, window_days, folders[], rules[], default_location_id, contact_policy: all\|known, skip_promotions, trigger_workflows, signature}`, `DELETE /api/mailboxes/:id`, `POST /api/mailboxes/:id/sync` `{full?}`, `GET /api/mailboxes/:id/folders`, `POST /api/mailboxes/:id/push` `{enable}` |
| Agentur | `GET/PUT /api/agency/mailbox-push` `{gmail_topic, audience, service_account, rotate_secret}` |
| Konversationen | `GET /api/mail/mailboxes`, `GET/POST /api/mail/mailboxes/:id/labels`, `GET /api/mail/conversations/:id`, `POST /api/mail/conversations/:id/archive` `{archive, mailbox_id?}`, `POST …/labels` `{add[], remove[]}`, `POST …/reply`, `POST /api/mail/send`, `GET/POST /api/mail/drafts`, `PUT/DELETE /api/mail/drafts/:id`, `POST /api/mail/drafts/:id/send`, `GET /api/mail/scheduled`, `DELETE /api/mail/scheduled/:id`, `GET /api/mail/search?q&mailbox_id&folder&unread&label&limit&remote=1`, `GET /api/mail/attachments/:messageId/:index?mailbox=` |
| Public | `GET /oauth/<google\|microsoft>/callback` (shared with calendar and Business Profile), `POST /hooks/mailbox/gmail`, `POST /hooks/mailbox/graph` and `/hooks/mailbox/graph/lifecycle` |
| Inbox hooks | `GET /api/conversations?mailbox=<id\|any>&folder=inbox\|archive\|sent\|drafts\|all&label=<id>` filters by mailbox; rows carry `mail: {folder, labels, label_names, mailboxes}`; `GET /api/conversations/:id/messages` adds `mail` (folder, labels, flags, attachments with download URLs) to each message |
| Mobile app | `GET /api/mobile/mailboxes`, `POST /api/mobile/conversations/:id/mail-reply` `{body, subject?, mailbox_id?, send_at?, signature?}` |

Send body: `{mailbox_id, to, cc, bcc, subject, body, html?, attachments: [{filename, content_base64, content_type}], reply_to_message_id?, contact_id?, signature?, send_at?}`.

MCP tools (every tool is a relay onto these routes, so rights and the audit log apply):

- `ghl_mailbox_list` – the sub-account's mailboxes (never personal ones), status, abilities.
- `ghl_mail_search` – search synced mail (`q`, `mailbox_id`, `folder`, `unread`, `label`, `limit`), `remote=true` searches at Gmail/Outlook.
- `ghl_mail_draft` – create (or with `draft_id` change) a draft in the mailbox; nothing is sent.
- `ghl_mail_send` – send, answer in a thread (`reply_to_message_id`), send a draft (`draft_id`) or schedule (`send_at`).

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| "Die Agentur hat noch keine Google-App hinterlegt" | enter the OAuth app under *Agentur → Integrationen* |
| Google: *Access blocked* / "app not verified" | the account is not a **test user** of the app (Testing), or the app is *Internal* and the account is not in the organisation |
| Google: reconnect needed every week | the app is in *Testing*: refresh tokens expire after 7 days – use *Internal*, or publish and verify |
| Google: `Gmail API has not been used in project … or it is disabled` | enable the **Gmail API** in the Cloud project |
| Microsoft: "Need admin approval" | a tenant admin has to consent, see above |
| Outlook shared mailbox: "Kein Zugriff auf das gemeinsame Postfach" | the account needs Full Access / Send As on it |
| Mailbox shows **neu verbinden** | the grant was revoked or expired (password change, admin, 7-day testing limit): *Neu verbinden* on the card |
| Mail does not arrive in seconds | no push configured → polled every 3 minutes; see the push card |
| Nothing is imported from a personal mailbox | add a routing rule or a default sub-account |
| "Es gibt nichts zu archivieren" | the mail is in a mailbox you may not change (personal mailbox of someone else, read-only access) |
| Mail missing | outside the sync window, in a folder/label that is not selected, in Spam/Trash, or in Gmail's Promotions/Social (switch that off in the settings) |

## For developers

- Files: `server/modules/mailboxes.ts` (tables, OAuth connect, settings, sync job, inbox hooks, catalogue entry),
  `mailbox-mail.ts` (`/api/mail/*`, workflow transport, MCP tools, mobile), `mailbox-push.ts` (push endpoints, registration,
  renewal); `server/services/mailbox-sync.ts` (engine, outbox), `mailbox-gmail.ts` and `mailbox-graph.ts` (clients behind
  one `MailApi`), `mailbox-send.ts`, `mailbox-actions.ts`, `mailbox-access.ts`, `mailbox-push.ts` (token checks),
  `mailbox-kit.ts` (types, scopes, MIME); UI in `web/src/pages/Mailboxes.tsx`.
- OAuth: purpose `mail` of `oauth_connections`; `modules/oauth-connect.ts` hands the shared callback over to
  `app.services.oauthPurposes.mail`. Tokens come from `app.services.oauth.token(connectionId)`.
- Inbox hooks added to `modules/conversations.ts`: `app.services.conversationFilters`, `conversationRows`, `messageRows`.
  The provider `mailbox` plugs into `deliverEmail` through `app.services.emailTransports`.
- Tests use fake Gmail/Graph/OAuth endpoints (`tests/mailbox-fakes.ts`) through `app.services.oauthFetch`:
  `mailbox-gmail`, `mailbox-graph`, `mailbox-push`, `mailbox-graph-push`, `mailbox-access`, `mailbox-unit`. Nothing talks to
  the real services.
