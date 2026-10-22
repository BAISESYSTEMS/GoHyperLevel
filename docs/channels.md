# Channels & providers

HyperLevel's inbox already handles email, SMS, website chat, calls, WhatsApp, Messenger and Instagram ([setup](meta-channels.md)). This page covers the additional native channels and providers, so a sub-account can use whatever works in its country:

| What | Use it for | Set up under |
| --- | --- | --- |
| [Telegram](#telegram) | Customer chats with your bot, lead capture via `t.me/<bot>?start=<campaign>` | Settings → Weitere Kanäle |
| [Discord](#discord) | A community server: DMs, chosen channels and `/support` → inbox | Settings → Weitere Kanäle |
| [Slack](#slack) | Team notifications; reply to customers from a Slack thread | Settings → Weitere Kanäle |
| [Email providers](#email-providers) | Resend, Postmark, Amazon SES, Brevo, Mailgun as senders with bounce/complaint webhooks and inbound mail | Settings → E-Mail & SMS |
| [SMS providers](#sms-providers) | seven.io, Bird (MessageBird), Vonage, Plivo with delivery reports and inbound SMS | Settings → E-Mail & SMS |
| [Web push to contacts](#web-push-to-contacts) | Browser notifications to funnel visitors who opted in | Settings → Weitere Kanäle |

Everything is per sub-account. Tokens, API keys and signing secrets are stored encrypted (AES-256-GCM with the server secret) and are never sent back to the browser. Webhooks from providers are checked by signature where the provider signs; every webhook address additionally contains a random key, so it cannot be guessed. HyperLevel must be reachable on a public **https** address (`PGHL_BASE_URL`) for any webhook to arrive.

All channels work like the existing ones: messages land in **Konversationen** (with a channel filter and icon), contacts are created or matched, `STOP` switches on „Nicht stören“, workflows start on *Nachricht empfangen*, and `POST /api/messages` / the MCP tool `ghl_send_message` send on the new channels.

## Telegram

1. In Telegram, talk to **@BotFather** → `/newbot` → pick a name and a username ending in `bot`. Copy the **token** (`123456789:AA…`).
2. HyperLevel → **Settings → Weitere Kanäle → Telegram**: paste the token → **Speichern** (HyperLevel checks it with `getMe` and shows `@your_bot`).
3. Click **Webhook setzen**. HyperLevel calls `setWebhook` with `https://<domain>/hooks/telegram/<locationId>` and a random secret token; Telegram sends that token in the `X-Telegram-Bot-Api-Secret-Token` header with every update and HyperLevel refuses updates without it.
4. **Verbindung testen** shows the bot, whether the webhook points at HyperLevel and how many updates are pending.

What arrives: private chats only (groups and channels are ignored). Text, photos, voice messages, audio, video, documents, stickers and locations; files are loaded from Telegram when someone opens them (Telegram keeps files up to 20 MB available to bots). A contact who shares their own phone number gets it on the contact.

**Lead capture with deep links:** `https://t.me/<bot>?start=<campaign>` (campaign: 1–64 characters `A–Z a–z 0–9 _ -`). Whoever opens the link and taps *Start* becomes a contact (source *Telegram*, tags from the settings) with an attribution touch `telegram / bot / <campaign>`, fires the workflow trigger **„Telegram-Bot gestartet“** (filter by campaign) and optionally receives the welcome text (merge fields allowed). The settings card builds these links; the MCP tool `ghl_telegram_link` too.

**Replying:** the composer shows a *Telegram* tab for contacts who started the bot (text up to 4096 characters, optional https file link: image, PDF, audio, video – then the text becomes the caption, max. 1024). Workflow action **„Telegram senden“**. A blocked bot shows *Kontakt hat den Bot blockiert* on the message.

**Cost:** free.

## Discord

1. [Discord Developer Portal](https://discord.com/developers/applications) → **New Application** → **Bot** → *Reset Token*, copy it. On the same page switch on the privileged **Message Content Intent**.
2. HyperLevel → **Settings → Weitere Kanäle → Discord**: paste the token, optionally the IDs of channels to read (enable *Developer Mode* in Discord, right-click a channel → *Copy Channel ID*) → **Speichern**. HyperLevel reads the application id and public key itself.
3. **Bot auf deinen Server einladen** opens the invite link (permissions: view channels, send messages, read message history).
4. Optional slash command: paste the **Interactions Endpoint URL** (`https://<domain>/hooks/discord/<locationId>`) into *General Information* (Discord sends a signed PING; HyperLevel checks the Ed25519 signature) and click **/support registrieren**. Members can then type `/support nachricht:…` anywhere the bot is; they get a private confirmation and the message lands in the inbox.

How messages arrive: HyperLevel keeps one Gateway connection (WebSocket) per sub-account with a bot – direct messages to the bot and messages in the chosen channels become conversations; other channels and bots are ignored. The connection resumes after drops; a bad token or a missing intent is shown on the card.

**Replying:** by direct message (default) or, when *Auf Kanal-Nachrichten im Kanal antworten* is on, as a reply in the channel the person wrote in. Up to 2000 characters. Workflow action **„Discord senden“**. Members who block DMs from server members get an error on the message.

**Cost:** free.

## Slack

Slack is for your **team**: every new customer message (any channel) appears in a Slack channel, one thread per conversation. A reply in the thread is sent to the customer through the channel they last wrote on (email, SMS, WhatsApp, Telegram, Discord …). HyperLevel reacts with ✅ when it went out, or posts a ⚠️ note with the reason. Messages starting with `//` stay internal.

**With a Slack app (replies work):**
1. [api.slack.com/apps](https://api.slack.com/apps) → *Create New App* → *From scratch*.
2. **OAuth & Permissions** → Bot Token Scopes: `chat:write`, `reactions:write`, `channels:history` (and `groups:history` for private channels) → *Install to Workspace* → copy the **Bot User OAuth Token** (`xoxb-…`).
3. **Basic Information** → copy the **Signing Secret**.
4. HyperLevel → **Settings → Weitere Kanäle → Slack**: token, signing secret and the **channel ID** (channel → details → bottom). Invite the bot into the channel (`/invite @your-app`).
5. Slack app → **Event Subscriptions** → on → Request URL `https://<domain>/hooks/slack/<locationId>` (verified automatically) → *Subscribe to bot events*: `message.channels` (and `message.groups`). Save.
6. **Testnachricht** in HyperLevel posts a test.

HyperLevel checks `X-Slack-Signature` (HMAC-SHA256 with the signing secret, max. 5 minutes old) and ignores Slack's retries of the same event.

**Only notifications:** choose *Nur Incoming Webhook* and paste an incoming-webhook URL (`https://hooks.slack.com/services/…`). You can limit which inbox channels are forwarded.

**Cost:** free (the free Slack plan is enough).

## Email providers

Choose the provider under **Settings → E-Mail & SMS → E-Mail-Versand → Anbieter**. The panel asks for the credentials, the sender (must be verified at the provider) and shows the **webhook address** of this sub-account (`https://<domain>/hooks/mail/<provider>/<locationId>/<key>`). *Speichern & aktivieren* makes it the sender for everything (inbox, campaigns, workflows, notifications); *Verbindung testen* makes a harmless read call.

Delivery reports update the message status: *zugestellt*, *unzustellbar* (hard bounce), *als Spam gemeldet*; soft bounces only add a note. A **hard bounce or a complaint switches the contact to „Nicht stören“** and fires the workflow triggers **„E-Mail unzustellbar (Bounce)“** / **„E-Mail als Spam gemeldet“**. Unsubscribes recorded by the provider also set „Nicht stören“.

| Provider | Credentials | Webhook check | Inbound mail | Cost (approx., check current pricing) |
| --- | --- | --- | --- | --- |
| **Resend** | API key `re_…`; webhook signing secret `whsec_…` | Svix signature (`svix-id/-timestamp/-signature`) | – | free 3,000/month (100/day), paid from ~$20/month |
| **Postmark** | Server API token, optional message stream | key in the URL (Postmark does not sign) | yes – inbound webhook | free 100/month, from ~$15/month for 10k |
| **Amazon SES** | Access key id + secret (IAM user with `ses:SendEmail`, `ses:GetAccount`), region, configuration set, optional SNS topic ARN | Amazon SNS signature (certificate from `sns.<region>.amazonaws.com`) + optional topic check | yes – receipt rule with SNS action | ~$0.10 per 1,000 emails |
| **Brevo** | API key `xkeysib-…` | key in the URL | yes – inbound parsing | free 300/day, paid from ~€9/month |
| **Mailgun** | API key, sending domain, region EU/US, webhook signing key | HMAC signature (`timestamp` + `token`), tokens used once | yes – route with `forward()` | from ~$15/month |

Where to enter the webhook:
- **Resend:** Webhooks → Add Endpoint → events `email.sent`, `email.delivered`, `email.bounced`, `email.complained`, `email.delivery_delayed`, `email.failed`; copy the signing secret into HyperLevel.
- **Postmark:** Server → Webhooks → Delivery, Bounce, Spam Complaint (+ Subscription Change). Inbound: Server → Inbound stream → webhook = the same address.
- **Amazon SES:** configuration set → event destination *Amazon SNS* (Send, Delivery, Bounce, Complaint, Reject, Delivery delay). In SNS create an **HTTPS subscription** with the address – HyperLevel confirms it automatically after checking the signature. Inbound: SES receipt rule → action *SNS* (encoding Base64) → a topic with the same subscription (SNS messages are limited to 150 KB).
- **Brevo:** Transactional → Settings → Webhooks (delivered, soft/hard bounce, spam, blocked, invalid, unsubscribed); inbound parsing on the same address.
- **Mailgun:** Sending → Webhooks (delivered, permanent fail, temporary fail, complained, unsubscribed); receiving → route `forward("<address>")`.

Inbound mails go through the same path as the IMAP sync and the generic inbound webhook (contact by email, conversation, helpdesk rules by recipient address).

Providers send a report again when they get no `2xx` (SNS, Mailgun, Resend retry for hours). A report that was handled once is answered `duplicate` (SNS message id, Mailgun token, Resend's `svix-id`, the inbound message id); a report whose processing failed (database busy, a parse error) is **not** marked as handled – the mark is taken back together with what it changed – so the provider's retry is processed, as with the Stripe webhook.

## SMS providers

Choose under **Settings → E-Mail & SMS → SMS-Versand → Anbieter**. Numbers are sent in E.164 form (contacts store `+49…`). Delivery reports set *zugestellt* / *fehlgeschlagen* (with the provider's reason); inbound SMS create or match the contact by phone number, `STOP` sets „Nicht stören“.

| Provider | Credentials | Webhook check | Cost (approx., check current pricing) |
| --- | --- | --- | --- |
| **seven.io** (Germany) | API key, optional sender, optional signing secret | HMAC (`X-Signature`, `X-Timestamp`, `X-Nonce`) when a signing secret is set | ~€0.075 per SMS to Germany, no monthly fee |
| **Bird** (formerly MessageBird) | Access key, workspace id, SMS channel id, optional signing key | HMAC (`messagebird-signature`, `messagebird-request-timestamp`) when a signing key is set | per message by country |
| **Vonage** | API key + secret, sender, optional signature secret | signed JWT (HS256, `payload_hash`) when a signature secret is set | per message by country |
| **Plivo** | Auth ID + auth token, sender | `X-Plivo-Signature-V2` with the auth token – always checked | per message by country (US from ~$0.005) |

Where to enter the webhook (`https://<domain>/hooks/sms/<provider>/<locationId>/<key>`):
- **seven.io:** Developer → Webhooks → events *SMS status* (`dlr`) and *inbound SMS* (`sms_mo`).
- **Bird:** Developer → Webhooks → subscribe `sms.outbound` (status) and `sms.inbound`.
- **Vonage:** your Vonage application → Messages → *Inbound URL* and *Status URL*; enable signed webhooks with the signature secret.
- **Plivo:** Messaging → Applications → *Message URL* (POST). HyperLevel sends the status callback URL with every SMS.

Signatures over the URL (seven.io, Bird, Plivo) need `PGHL_BASE_URL` to be exactly the address the provider calls.

## Web push to contacts

1. **Settings → Weitere Kanäle → Push an Kontakte**: switch on *Glocke auf Funnels und Websites zeigen*, adjust the texts.
2. Funnel and website pages get a small bell (bottom left). It opens a short opt-in window on your HyperLevel domain (funnel pages are sandboxed, so the browser permission is asked there), which subscribes the browser with HyperLevel's own VAPID keys.
3. The subscription is linked to the contact through the attribution visitor id – right away if the visitor is already known, or as soon as they fill in a form or book an appointment. The opt-in link from the card also works in emails or on other websites.
4. Send with the workflow action **„Push an Kontakt“** (title, text, https link; merge fields allowed), from the inbox (*Push* tab for contacts with devices) or via `POST /api/messages` with `channel: "push"` (`subject` = title, `url` = link). Each push is stored in the conversation.

Delivery goes through the browsers' push services (Google, Mozilla, Apple, Microsoft) – free. Expired subscriptions are removed automatically. On iPhones, web push only works after the page was added to the home screen.

## Webhook addresses at a glance

| Channel | Address |
| --- | --- |
| Telegram | `/hooks/telegram/<locationId>` (set by „Webhook setzen“) |
| Discord interactions | `/hooks/discord/<locationId>` |
| Slack events | `/hooks/slack/<locationId>` |
| Email providers | `/hooks/mail/<resend\|postmark\|ses\|brevo\|mailgun>/<locationId>/<key>` |
| SMS providers | `/hooks/sms/<seven\|bird\|vonage\|plivo>/<locationId>/<key>` |
| Push opt-in | `/push/<locationId>/subscribe` |

The exact addresses with key are shown in the settings. Saving a provider with `regenerate_webhook: true` (API) issues a new key.

## API & MCP

- `POST /api/messages` with `channel: telegram | discord | push` (plus `media_url` for Telegram, `subject`/`url` for push); email/SMS providers are used automatically by `channel: email | sms`.
- `GET /api/messages/channels/status?contact_id=` – which of the extra channels can reach a contact.
- Settings: `GET/PUT/DELETE /api/settings/channels/telegram|discord|slack`, `GET/PUT /api/settings/channels/push` `{enabled, button, title, text}` (switched off instead of deleted, no test), `GET /api/settings/channels/mail|sms`, `PUT/DELETE /api/settings/channels/mail|sms/<provider>`, `POST …/test` (Telegram, Discord, Slack and the mail/SMS providers).
- MCP: `ghl_send_message` lists every available channel; `ghl_telegram_link` builds campaign deep links.

## For developers

New channels plug in through registries instead of core edits (module `channels.ts`, helpers in `services/channel-kit.ts`):
`app.services.messageChannels[channel]` (send via `POST /api/messages`), `channelStatus[channel]` (composer), `channelMedia[channel]` (files of inbound messages), `channelSend(locationId, {contactId, channel, body})` (send on any channel – Slack replies use it), `emailTransports[provider]` / `smsTransports[provider]` (senders behind `deliverEmail`/`deliverSms`), plus `workflowActions`, `workflowTriggers`, `catalogExtra` and `mcpTools`. Tests swap the network with `app.services.channelFetch` (and `discordSocket` for the Discord Gateway).
