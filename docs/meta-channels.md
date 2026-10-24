**English** · [Deutsch](meta-channels.de.md)

# WhatsApp, Messenger & Instagram

WhatsApp Business (Cloud API), Facebook Messenger and Instagram Direct land directly in **Conversations** – next to e-mail, SMS and live chat. Each sub-account connects its own number and one or [several pages with their Instagram accounts](#multiple-pages-and-instagram-accounts).

- **Inbox:** a channel icon on every conversation and message, a filter per channel, images/voice messages/videos/documents right in the message, locations as a map link, status *sent → delivered → read* (or *failed* with the reason).
- **Replying:** the input field shows the tabs *WhatsApp*, *Messenger* or *Instagram*. The field shows whether the 24-hour window is open. Outside the window, WhatsApp offers the approved **templates** (preview, fill in placeholders).
- **Contacts:** WhatsApp senders are matched by phone number (E.164, as in the contacts module) – existing contacts are reused and not renamed. Messenger/Instagram senders get a contact with the name from the Meta profile (as far as Meta releases it) and the tag `messenger` or `instagram`; the app remembers the PSID/IGSID → contact mapping.
- **Automations:** trigger “Message received” with channel *WhatsApp/Messenger/Instagram*; action **“Send WhatsApp”** (text inside the 24-hour window, otherwise a template – or always one of the two; placeholders such as `{{contact.first_name}}` work). “STOP” sets “Do not disturb”.
- **API & MCP:** `POST /api/messages` with `channel: whatsapp|messenger|instagram`, templates through `POST /api/messages/meta`; MCP tools `ghl_send_message` (all channels), `ghl_list_whatsapp_templates`, `ghl_send_whatsapp`.

Prerequisite: HyperLevel is reachable at a public **https** address (`PGHL_BASE_URL`), otherwise Meta cannot deliver messages.

## 1. Create the Meta app

1. Have a business portfolio at [business.facebook.com](https://business.facebook.com) (verify it later for higher limits).
2. At [developers.facebook.com](https://developers.facebook.com/apps) → **Create app** → use case *Other* → type **Business** → connect it to the business portfolio.
3. **App settings → Basic:** copy the **app secret**. It goes into HyperLevel under **Settings → Channels → App secret**. Without it, HyperLevel accepts no messages – every delivery is verified with the signature `X-Hub-Signature-256`.

## 2. WhatsApp Business

1. In the app, **Add product → WhatsApp**. Under **WhatsApp → API Setup**, add a number of your own (or use the test number to try things out). The number must not run in the regular WhatsApp app at the same time.
2. There, copy the **phone number ID** (*Phone number ID*, not the number itself) and the **WhatsApp Business account ID** (*WhatsApp Business Account ID*).
3. Create a **permanent token** (the token on the API page expires after 24 hours):
   - Business settings → **Users → System users** → *Add* (role Admin).
   - *Assign assets*: the app and the WhatsApp account (full control).
   - *Generate new token*: choose the app, expiration **Never**, permissions `whatsapp_business_messaging` and `whatsapp_business_management`.
4. In HyperLevel, **Settings → Channels**: enter the phone number ID, account ID and token → **Save** → **Test connection** (shows the display name, number and quality rating).
5. **Webhook:** in the app under **WhatsApp → Configuration → Edit webhook**, enter the **callback URL** (`https://<domain>/hooks/meta/<locationId>`) and the **verify token** from HyperLevel → *Verify and save*. Then subscribe to the webhook field **`messages`**.
   Alternatively, **“Subscribe webhooks at Meta”** in HyperLevel sets the callback URL for this WhatsApp account only (webhook override) and subscribes the app to the account; the `messages` field must still be subscribed in the app.
6. Switch the app to **Live**. In development mode, messages only go to registered test numbers (error “not allowed to send to this number”).
7. In the **WhatsApp Manager**, add a payment method and create **templates** (category Marketing, Utility or Authentication). Approved templates appear in HyperLevel after a few minutes (the list is cached for 5 minutes). Supported are text headers, image/video/document headers (via https link), placeholders `{{1}}` or named `{{vorname}}`, and reply, phone and link buttons.

## 3. Facebook Messenger and Instagram Direct

1. The Facebook page belongs to the business portfolio; the Instagram professional account is linked to the page. In the Instagram app: **Settings → Messages and story replies → Connected tools → Allow access to messages**.
2. In the app, **Add product → Messenger** (for Instagram also **Instagram** with *Facebook Login*).
3. **Page token:** assign the page as an asset to the system user and generate a token (expiration *Never*) with `pages_messaging`, `pages_manage_metadata`, `pages_show_list` and, for Instagram, `instagram_basic` and `instagram_manage_messages`.
4. Enter the **page ID** (page → About → Page transparency) and the **Instagram account ID** (in the Graph API Explorer: `GET /<page-id>?fields=instagram_business_account`) in HyperLevel, plus the token → Save → Test connection.
5. **Webhooks:** under **Messenger → Settings → Webhooks** (object *Page*) and for the object **Instagram**, enter the same callback URL and the same verify token. Fields: `messages`, `messaging_postbacks`, `message_deliveries`, `message_reads` (optionally `message_reactions`).
6. The page has to subscribe the app: **“Subscribe webhooks at Meta”** in HyperLevel does that (`POST /<page-id>/subscribed_apps`); alternatively use “Add page” in the app's Messenger settings.
7. For messages from arbitrary people, the app needs **app review** (Advanced Access) for `pages_messaging` and `instagram_manage_messages`. Until then, it only works with people who have a role in the app.

Names come from the Meta profile (`first_name/last_name` or `name/username`). If the permission is missing, the contact is called “Messenger contact” or “Instagram contact” and can be renamed.

## Multiple pages and Instagram accounts

A sub-account can connect **several Facebook pages** (each with a linked Instagram account) – e.g. one page per branch or brand. Under **Settings → Channels → Pages and Instagram accounts** → *+ Another page*: enter the page ID, optionally the Instagram account ID, and the token of **this** page; *Test connection* reads the names and usernames of all pages, and *Subscribe webhooks at Meta* subscribes every page.

- **Incoming:** every message is assigned to the right page through the page ID or Instagram account ID (`entry.id` of the webhook) – across sub-accounts with the same app secret, too.
- **Inbox:** with more than one page, the page appears as a sub-channel on the message (“Messenger · Branch North”, “Instagram · @brand”), and the input field shows which page the reply goes out through.
- **Replying:** Facebook assigns separate person IDs (PSID/IGSID) per page. HyperLevel remembers which page someone wrote to and replies with the **token of that page**. If a page is removed, its contacts can no longer be replied to (error “… is no longer connected”).
- **Migration:** the previous single page automatically became the first page of the list during the update (migration `002-pages`), and its contacts stay assigned to it. The fields `page_id`, `page_token`, `ig_account_id` of `PUT /api/settings/meta` still edit this first page.
- [Reviews from Facebook](reputation.md) pick one of the pages, [comments in the inbox](social-comments.md) reply with the token of the page whose post was commented on. [Comment to DM](comment-to-dm.md) works with the first page.

## Comments under posts (comment to DM)

The same connection also carries [Comment to DM](comment-to-dm.md): when a keyword appears in a comment under an Instagram post, Reel or Facebook post, HyperLevel replies publicly and privately sends a message with a link. For this, additionally subscribe in the webhook: Instagram `comments`, page `feed` (the *Subscribe to comments* button on the *Comment to DM* page does it via API) and the permissions `instagram_manage_comments`, `pages_manage_engagement`, `pages_read_engagement`, `pages_manage_metadata`; for other people's accounts the app needs Advanced Access (app review) – details in the guide.

## One Meta app for several sub-accounts

A Meta app has only **one** callback URL per product. Two ways:

- **A separate app per client** – each enters its own `…/hooks/meta/<locationId>`.
- **One agency app** – enter **the same app secret** in all sub-accounts and use the callback URL of any one of these sub-accounts in the app. HyperLevel assigns each message to the right sub-account through the phone number ID, page ID or Instagram ID (only between sub-accounts with the same app secret). For WhatsApp, “Subscribe webhooks at Meta” sets an address of its own per WhatsApp account anyway.

Messages to IDs that belong to no sub-account are ignored; the note is shown under **Settings → Channels**.

## 24-hour window and costs

- **Window:** you may send free text only within 24 hours after the contact's last message. On WhatsApp, outside the window (and for the very first message) only an **approved template** works; Messenger and Instagram allow nothing outside the window (message tags are not supported here). HyperLevel checks this before sending and shows the state in the input field.
- **WhatsApp costs money:** Meta charges for templates by category (Marketing, Utility, Authentication) and the recipient's country – formerly per 24-hour conversation, now per template message. Replies inside the window are currently free. Current prices: [WhatsApp Business Platform Pricing](https://developers.facebook.com/docs/whatsapp/pricing). Messenger and Instagram are free.

## What the app stores

- IDs in plain text, **tokens and app secret encrypted** (AES-256-GCM with the server key from the data folder); they are never returned to the browser. If the server key is changed, the tokens have to be entered again.
- Messages in the normal message table (`channel` = `whatsapp`/`messenger`/`instagram`), each Meta message only once (Meta delivers several times on errors).
- Media only as a reference: HyperLevel fetches WhatsApp files only when you view them, through the Graph API (Meta keeps them for 30 days), and Messenger/Instagram attachments through Meta's CDN link. The token only goes to Meta's own servers in the process.
- Messages written directly in the WhatsApp Business app, Meta Business Suite or Instagram do not appear (Meta does not send them, or only as an “echo”, which is ignored).

## Troubleshooting

| Message | Cause |
| --- | --- |
| Meta: “Callback URL could not be verified” | Verify token copied wrong, address not reachable via https, or a proxy blocks `/hooks/` |
| No incoming messages, “Nothing received yet” | Field `messages` not subscribed, page not subscribed, app in development mode |
| 401 “Invalid signature” in the server log | App secret in HyperLevel does not match the app |
| “Access token invalid or expired” | A short-lived token was used – enter a permanent system user token |
| “Outside the 24-hour window” | Send a template or wait until the contact writes |
| “Recipient is not allowed as a test number” | App still in development mode |
| “…to unknown ID … ignored” | Check the phone number ID/page ID/Instagram ID in the settings |

## API

```bash
# Text (only inside the 24-hour window)
curl -X POST https://crm.example.com/api/messages -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"contact_id":"…","channel":"whatsapp","body":"Passt Dienstag 10 Uhr?"}'

# Approved templates with their placeholders (slots)
curl https://crm.example.com/api/messages/meta/templates -H "Authorization: Bearer $KEY"

# Send a template (also works outside the window)
curl -X POST https://crm.example.com/api/messages/meta -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"contact_id":"…","channel":"whatsapp","template":{"name":"termin_erinnerung","language":"de","values":{"body.1":"Anna","body.2":"Dienstag"}}}'
```

More endpoints: `GET /api/messages/meta/status?contact_id=` (channels, recipients, window state, `via` = page of the reply), `GET /api/messages/meta/media/:messageId` (file of an incoming message), `GET/PUT/DELETE /api/settings/meta` (with `pages`), `GET/POST /api/settings/meta/pages` (`{page_id, ig_account_id, page_token}`), `PATCH/DELETE /api/settings/meta/pages/:id`, `POST /api/settings/meta/test`, `POST /api/settings/meta/subscribe`, `GET /api/conversations?channel=whatsapp`. Public: `GET/POST /hooks/meta/:locationId` (Meta webhook).
