# Comment to DM (Kommentar-zu-DM)

**Marketing → Kommentar-zu-DM** is the "comment *guide* and get the link" automation known from ManyChat – for **Instagram** (posts and reels) and **Facebook pages**. A rule says: when a comment contains a keyword, **answer publicly** (with rotating texts), send a **private message** with a link and buttons, **create or update the contact**, give it tags and **start a workflow**. The same works for **replies to Instagram stories**. A second feature, the workflow action **Nachricht mit Buttons senden**, sends messages with buttons and quick replies on Instagram, Messenger and WhatsApp.

To read and answer every comment by hand in the inbox instead, see [social comments](social-comments.md). It builds on the Meta connection of [Meta channels](meta-channels.md) (*Einstellungen → Kanäle*): same page, same tokens, same webhook. Everything is per sub-account and belongs to the area **Social Planner** (`social`).

- [Set up the Meta app (self-hosters)](#set-up-the-meta-app-self-hosters)
- [Rules](#rules)
- [What happens to a comment](#what-happens-to-a-comment)
- [Story replies](#story-replies)
- [Messages with buttons](#messages-with-buttons)
- [Meta's rules and our limits](#metas-rules-and-our-limits)
- [Workflows, API and MCP](#workflows-api-and-mcp)

## Set up the Meta app (self-hosters)

You need the Meta channel setup of [docs/meta-channels.md](meta-channels.md) first: a Facebook page, an Instagram **business or creator** account connected to it, the page access token, the app secret and the webhook. For comments add:

1. **Webhook fields.** In the Meta app (*Webhooks*): for **Instagram** subscribe to `comments` (and `messages`, for story replies); for the **Page** subscribe to `feed` (comments on page posts) and keep `messages`, `messaging_postbacks`. The callback URL and verify token are on the page *Kommentar-zu-DM* (card *Verbindung zu Meta*). The button **Kommentare abonnieren** subscribes the page (`feed`, keeping the message fields) and the Instagram account (`comments`, `messages`) through the API; if Instagram refuses, set the field in the Meta app.
2. **Permissions** (shown on the page, too):
   - Instagram: `instagram_basic`, `instagram_manage_comments`, `instagram_manage_messages`, `pages_show_list`, `pages_manage_metadata`, `pages_read_engagement`.
   - Facebook page: `pages_manage_engagement`, `pages_read_engagement`, `pages_messaging`, `pages_manage_metadata`, `pages_show_list`.
3. **Access level.** In **development mode** everything works for people who have a role on the app (you, your team). To serve accounts you do not administer – your customers' – the app needs **Advanced Access** for these permissions: **App Review** with a screencast per permission, a privacy policy URL and **business verification**. Plan for days to weeks; this is Meta's process, not ours.
4. The token must be the **page token** with these permissions; a token generated before you added the permissions has to be created again.

Test: switch the app to development mode, comment the keyword from a test account that has a role on the app, and watch *Letzte Treffer*.

## Rules

*Regeln → Neue Regel* (the first matching rule wins; a rule for **one post** beats a rule for all posts, then the higher priority):

| Field | |
| --- | --- |
| Auslöser | *Kommentar unter einem Beitrag oder Reel* or *Antwort auf eine Instagram-Story*. |
| Plattform / Beitrag | Instagram, Facebook or both; all posts or one (pick from your latest posts – *Beiträge laden* – or paste the id). |
| Stichwörter | A comment matches when it **contains the keyword as a whole word**, *genau das Stichwort* is it, or *jeder Kommentar*. Case, accents (é = e), punctuation and emoji are ignored: "Guide, bitte! 🙏" matches *guide*. Up to 20 keywords. |
| Öffentliche Antwort | Up to 10 texts that **rotate** one after another (identical answers under many comments can look like spam to Instagram). Empty = no public reply. |
| Direktnachricht | Text (up to 1000 characters), a link (https only) shown as a **button**, and up to three buttons in total: *Link* or *Antwort* (the tap sends its text back as a message and can start the next automation). |
| Tags, Workflow | The contact gets the tags; the chosen **active** workflow starts for the contact. |
| Höchstens pro Stunde | Per-rule limit 1–700 (default 60). |
| Einmal je Person | By default every person gets the direct message of a rule once (they may comment again – the public reply still goes out). |

*Regel testen* checks a sample comment against your rules without sending anything. Statistics per rule: matches, messages, public answers, errors.

## What happens to a comment

1. Meta delivers the comment to the webhook (the signature is checked). Your own replies, edits, replies to replies and comments of other accounts are ignored.
2. A matching rule claims the comment **once** – delivering it twice does nothing twice (`comment_id` is unique per sub-account).
3. The **private reply** goes out through the Send API with the comment as recipient (`recipient.comment_id`). The reply is then in the person's **conversation**, so the inbox shows what they got.
4. The **public reply** is posted under the comment (Instagram: `/<comment>/replies`; Facebook: `/<comment>/comments`).
5. The person becomes a **contact** (`@username`, linked to their Instagram or Messenger id, so their answer lands on the same contact), the tags are set, `igcomment.matched` runs and the rule's workflow starts.

Each step stands on its own: a refused public reply does not stop the message, and a refused message (Meta allows one private reply per comment) still creates the contact. Whatever went wrong is shown in *Letzte Treffer* with Meta's own error message. Comments that were cut off (restart, slow Meta) are tried again for a few minutes, up to three times.

## Story replies

A rule of type *Antwort auf eine Instagram-Story* looks at **messages that answer your story** (they arrive with the `messages` field). When the text contains the keyword, HyperLevel sends the direct message into that conversation – the 24-hour window is open because the person just wrote. There is no public reply for stories.

## Messages with buttons

The action **Nachricht mit Buttons senden (Instagram/Messenger/WhatsApp)** (`meta_buttons_send`) in *Automationen*:

- **Instagram and Messenger:** up to three buttons (*Link* or *Antwort*) as a button template, or – if all are replies – up to 13 **quick replies**. The text of a button template is cut at 640 characters, button titles at 20.
- **WhatsApp:** up to three reply buttons, **or** one link button – not mixed.
- Only **within 24 hours** after the contact's last message (outside it Meta refuses free messages; WhatsApp then needs an approved template). The action fails with a clear message and sends nothing when the window is closed or the buttons do not fit the channel.
- A tap arrives as an ordinary incoming message with the button's title – use the trigger *Nachricht empfangen* (filter channel and text) to continue.

## Meta's rules and our limits

- **One private reply per comment**, within **7 days** of the comment, only for comments on your **own** posts and reels. After that, only the person's answer opens the 24-hour window for further messages.
- Instagram allows roughly **750 private replies per hour** per account. HyperLevel brakes earlier: a limit per rule (default 60 per hour) and **200 private replies per hour per sub-account** – a comment over the limit is marked *gebremst* and gets no message.
- Do not use rotating answers to hide spam; Meta can restrict accounts that send unwanted or repetitive messages. Offer something the person asked for (that is what the keyword means), keep the text honest and let people opt out ("STOP" sets *Nicht stören* for the contact).
- A comment, a direct message and the contact are **personal data**: name your use in your privacy policy. HyperLevel stores the comment text, the username and the outcome (90 days in the event list).
- Sending needs the **page token**: when it expires or loses a permission, *Einstellungen → Kanäle* shows the error and *Letzte Treffer* the failed messages.

## Workflows, API and MCP

**Trigger:** *Kommentar-Stichwort getroffen (Instagram/Facebook)* (`igcomment.matched`) with filters for the rule and the platform. Data: `{{event.text}}`, `{{event.keyword}}`, `{{event.platform}}`, `{{event.kind}}` (`comment` or `story_reply`), `{{event.dm_sent}}`, `{{event.public_reply_sent}}`, `{{event.rule.name}}`. **Action:** *Nachricht mit Buttons senden*.

**API** (area `social`):

| Route | |
| --- | --- |
| `GET /api/ig-comments/status` | Connection, webhook URL, permissions, policy notes, 7-day counters. |
| `GET/POST /api/ig-comments/rules`, `PATCH/DELETE …/rules/:id` | Rules. |
| `POST /api/ig-comments/test` | `{text, platform?, media_id?}` → which rule would match. |
| `GET /api/ig-comments/events?rule_id=&status=&limit=` | Recent matches and outcomes. |
| `GET /api/ig-comments/media?platform=` | Your latest posts, reels or page posts (for the picker). |
| `POST /api/ig-comments/subscribe` | Subscribe the page and the Instagram account to the comment fields. |

**MCP tool:** `ghl_ig_comment_rules` (list, create, update, delete, events, test).
