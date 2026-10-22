# Team-Chat – talk to your team inside HyperLevel

The Team-Chat is the internal messenger of a sub-account (and, if you want, of the whole agency): **channels**
(public or private), **direct messages and small groups**, **threads**, emoji reactions, @mentions, files,
pinned messages, search, typing indicators and presence. It is wired into the CRM: pasting a link to a contact or
ticket shows a **live card**, `/aufgabe` creates a task, `/kontakt` shares a contact, `/agent` asks the HyperLevel
Agent in the channel. Notifications arrive as in-app counters, **web push** and on the **Android app**.

Menu: **Team-Chat** (`/app/team-chat`, area `teamchat` in the member rights) with an unread badge. No extra
service, no npm package, nothing to install: the realtime part is one Server-Sent-Events stream per open tab
(*SSE for what the server tells you, ordinary POST requests for everything you do*).

It does not replace the customer conversations (**Konversationen** – that is the inbox for customers) and it does
not duplicate other pieces:

| Existing piece | How the chat uses it |
| --- | --- |
| Tasks | `/aufgabe` calls the task route as you (same rights, same audit log); chat cards show the task live. |
| Contacts, companies, tickets, Canvas, Wiki | Cards in messages (pasted links to `/app/contacts/…`, `/app/tickets/…` etc., or the share button); a message can be saved as an **internal note** on a contact (*… → Als Notiz an einem Kontakt speichern*). |
| Slack bridge | Optional **one-way copy** of a channel to the Slack channel set up under *Einstellungen → Weitere Kanäle → Slack* (see below). |
| Web push, Android feed | Push kind `chat`, feed event type `chat` – see notifications. |
| HyperLevel Agent | `/agent` runs the agent with *your* rights; anything it wants to change waits for *your* click. |

## Using it

| Do | How |
| --- | --- |
| Send | Enter sends, Shift + Enter starts a new line. A message is Markdown-light: `**bold**`, `*italic*`, `` `code` ``, code blocks, lists, quotes, links. |
| Mention | `@` and a name (or the picker); `@alle` (also `@channel`, `@here`) addresses everybody in the channel. |
| Reply in a thread | Hover a message → ↳. Replies stay together; the channel shows "3 Antworten". Threads are one level deep. |
| React | Hover → 😀＋, or click an existing reaction. One reaction per person and emoji. |
| Pin | *… → Anpinnen* (up to 100 per channel); the pin button in the header lists them. |
| Edit / delete | *…* → *Bearbeiten* (own messages) / *Löschen* (own; channel owners and – in public channels – agency admins for others). A deleted message leaves a "gelöscht" line, its text, files and reactions are gone. |
| Files | Paperclip, paste or drop (up to 10 per message, 8 MB each; PNG, JPEG, GIF, WebP, PDF, text/CSV, Office, ZIP – SVG/HTML refused). Images show inline. |
| Search | The field above the channel list: finds messages in every channel and conversation you may read; a hit jumps to the message. |
| Unread | Bold names and counters (red = you were mentioned); a "Neu" line marks where you stopped reading. The menu entry shows the total of channels that are not muted. |
| Mute / loudness | Bell in the header per channel: *Alle Nachrichten*, *Nur Erwähnungen*, *Stumm*. |

### Channels, direct messages and who can read what

| Kind | Who can read and join |
| --- | --- |
| **Public channel** | Everyone with the `teamchat` right in that sub-account can read it and joins by writing (or the *Kanal beitreten* button). |
| **Private channel** | Invited members only. **Agency admins cannot read it** either – it is invisible to everybody else (a request answers "not found"). |
| **Agency-wide channel** (admins create it, *Gilt für: Die ganze Agentur*) | Shows up in every sub-account for agency admins (public ones readable, join by writing) and for members who were invited; nobody else sees it. |
| **Direct message / group** (up to 8 people) | The participants only – not even agency admins. They belong to the person, not to a sub-account. |

Rules worth knowing: a channel owner (the creator) renames, sets the topic, archives, invites to private channels and
deletes; archived channels stay readable. Mentioning someone who is not in a private channel does nothing (the
chat never reveals who is outside). People who lose the `teamchat` right or access to the sub-account lose the
channel at once, including their open stream. A stream also ends with the login it was opened with: signing out,
"sign out other devices", a revoked session or a new password end it at once, an expired session within 20 seconds
(the browser is told `bye` and tries again only when the tab is looked at again).

### Commands

| Command | What happens |
| --- | --- |
| `/aufgabe Angebot senden morgen @Anna` | Creates a task. The due day understands *heute, morgen, übermorgen, Montag … Sonntag, 15.10., 15.10.2026, 2026-10-15*; the first `@mention` becomes the assignee. The channel gets "📌 Aufgabe angelegt" with a live card. Needs the `contacts` right (tasks live there). |
| `/kontakt Müller` | Searches contacts; one hit is posted as a card, several offer a small chooser. |
| `/agent Wie viele Aufgaben sind überfällig?` | Posts your question and the agent's answer **in the channel – everybody there reads it**. The agent sees the last ten messages of that channel as context (as data, not as instructions) and has your rights. It reads freely; if it wants to **change** something (create a deal, send a message …) the message shows "Der Agent möchte etwas ändern" with **Ausführen / Ablehnen** buttons – **only the person who asked can confirm**, once, for exactly those arguments. The mode "automatic" of the agent settings is never used here: the most it can do is "ask". |

Commands run with the caller's own rights through the normal routes, so they appear in the audit log like
everything else. The agent needs the HyperLevel Agent to be switched on for the sub-account and a text model
(*Einstellungen → KI-Agent*, *KI-Anbieter*); otherwise the command answers with that reason immediately.

## Notifications

| Where | When |
| --- | --- |
| In the app | live over the stream: new messages, unread counters, typing ("Anna tippt …"), who is online |
| Web push (kind `chat`, switch under *Einstellungen → Mein Konto*) | direct messages and groups: every message; channels: when you are **@mentioned** or someone replies in a thread you took part in – or every message if you chose *Alle Nachrichten* for that channel. Never for muted channels, never for your own messages, **never while you are looking at the chat** (a tab in the foreground counts for 45 seconds after its last signal) |
| Android app (feed event type `chat`, category *Team-Chat*) | the same people and rules; tapping opens the channel |

Push messages carry a short text preview (160 characters); people who lost access in between are skipped.

## Slack copy (optional)

*Kanal-Einstellungen → "Neue Nachrichten in Slack spiegeln"* (visible when the Slack bridge of the sub-account is
set up and enabled; works with the bot token and with an incoming webhook). Every new message of that channel
is posted to the **one Slack channel the bridge uses**, as "*Name* in #channel: text" – plain text, 160 characters
of preview, no files. It is **one way**: Slack replies do not come back, and agency-wide channels cannot be mirrored.
Private channels can be mirrored by their owner – think before you do, Slack's members then read them.

## Retention

*Team-Chat → + → Chat-Einstellungen* (needs the right *Einstellungen*): keep messages **unlimited** (default), or
delete everything older than **30, 90, 180 or 365 days**, with their files; pinned messages stay; a thread is removed
together with its first message. Agency admins set the value for agency-wide channels separately. The cleanup runs
every 30 minutes in the background tick and writes no per-message audit lines (the setting itself is audited).
Deleting a channel removes its messages and files for good.

## Realtime and self-hosting

* One HyperLevel process serves the streams (an in-memory hub); a restart makes the browsers reconnect by themselves
  (`EventSource` retry 3 s) and the chat reloads what it missed. Capacity: 600 open streams, 8 per person; a full
  server answers 503 (the tab tries again when it is looked at again – no reconnect every 3 s); a heartbeat every 20 s
  keeps proxies from closing idle streams and drops dead ones.
* **Reverse proxy:** the stream must not be buffered. HyperLevel sends `X-Accel-Buffering: no` and
  `Cache-Control: no-transform`; with nginx also set `proxy_read_timeout` generously (the heartbeat is 20 s) and
  never enable response buffering for `/api/team-chat/stream`. If the
  stream is blocked, the chat still works – messages appear after you send or reload – but not live.
* Files are stored under `data/teamchat-files` (random names, served only through the authenticated route with
  `nosniff` and a locked-down content-security-policy); the backup covers the folder. The demo mode empties it on reset.
* **Rate limit:** 20 messages per person per 10 seconds; messages up to 8,000 characters.
* **Search** is SQLite FTS5 with a `LIKE` fallback, joined against the message table so that sub-account and
  access rules always apply.
* Privacy: messages are not sent anywhere except the optional Slack copy, push previews (through the browser push
  services, text only) and the agent if somebody types `/agent`. They are part of your own backups (database and `data/teamchat-files`);
  direct messages and private channels are not visible to agency admins in the app.

## MCP, API and mobile

* MCP: `ghl_chat_post` and `ghl_chat_history` – **public channels of one sub-account only**; keys and MCP
  connections never see private channels or direct messages. Posts show up as a bot ("KI-App").
* Mobile (device token): `/api/mobile/chat/…` for the channel list, messages, posting and reading.
* Full list: [api.md → Wiki & Team-Chat](api.md#wiki--team-chat).
