# Social comments in the inbox

Comments under your own posts land in **Konversationen** as the channel **Kommentare** – next to e-mail, SMS, WhatsApp and the rest: **Facebook** page posts and **Instagram** posts/reels (through the Meta webhook you already have for [Messenger and Instagram](meta-channels.md)), and – where a [Nango](nango.md) connection exists – **YouTube** videos and **LinkedIn** company page posts. Each comment is a message on the commenter's contact with three actions: **Antworten** (a public reply under the comment), **Ausblenden / Einblenden**, and **KI-Vorschlag** (an AI reply suggestion you edit before sending).

It complements [Kommentar-zu-DM](comment-to-dm.md): those rules answer keywords automatically with a private message; here a person reads every comment and answers in public.

## Setup

*Einstellungen → Kanäle → Kommentare im Posteingang*:

| Platform | Needs | How comments arrive |
| --- | --- | --- |
| Facebook | A page under *Einstellungen → Kanäle*; webhook field **`feed`** of the page; permissions `pages_read_engagement`, `pages_manage_engagement` | Meta webhook, instantly |
| Instagram | The Instagram account linked to that page; webhook field **`comments`**; permissions `instagram_basic`, `instagram_manage_comments` | Meta webhook, instantly |
| YouTube | An active Nango connection with the provider `youtube` (scope `https://www.googleapis.com/auth/youtube.force-ssl`) | Polled every 15 minutes: the newest comments of your five latest uploads |
| LinkedIn | An active Nango connection with the provider `linkedin` (Community Management API, `r_organization_social`, `w_organization_social`) and your **organisation ID** | Polled every 15 minutes: comments on the five latest posts of the organisation |

The button *Kommentare abonnieren* on [Kommentar-zu-DM](comment-to-dm.md#set-up-the-meta-app-self-hosters) subscribes the page to `feed` and the Instagram account to `comments` through the API. Facebook and Instagram are on by default; YouTube and LinkedIn start with the comments that arrive **after** you switch them on (no flood of old comments). The [Postiz](integrations.md) connection HyperLevel uses only publishes posts – its public API has no comment endpoint – so LinkedIn and YouTube comments come through Nango.

With several Facebook pages ([meta-channels.md](meta-channels.md#multiple-pages-and-instagram-accounts)) each comment remembers the page or Instagram account it was written on, and the reply and hide calls use **that page's token**.

## In the inbox

- **Filter:** the channel chip *Kommentare* in Konversationen.
- **Contact:** the commenter becomes a contact (`@username` for Instagram, the display name for Facebook and YouTube, „LinkedIn-Mitglied“ for LinkedIn, whose API does not give names) with the tag `<platform>-kommentar`. Facebook and Instagram share the identities of the Meta inbox, so a person who comments and later writes a direct message is one contact.
- **Antworten** posts publicly under the comment (Instagram `/<comment>/replies`, Facebook `/<comment>/comments`, YouTube `comments.insert` with the thread as parent, LinkedIn a comment with `parentComment`) and writes the reply into the conversation. Limits: Instagram 2,200 characters, LinkedIn 1,250.
- **Ausblenden** hides the comment from the public (Facebook `is_hidden`, Instagram `hide`, YouTube moderation status *heldForReview*); *Einblenden* undoes it. LinkedIn's API cannot hide – delete the comment on LinkedIn.
- **KI-Vorschlag** uses the KI-Assistent (persona and facts, du/Sie from *KI-Antworten*): 1–3 friendly sentences, no promises, an offer to continue by direct message for personal questions. It is a suggestion only, stored on the comment until you reply; it counts towards the monthly AI limit (at most 60 per hour).
- Blocked senders ([spam](team-inbox.md#spam-and-blocked-senders)) are archived silently; the team inbox's assignment, deadlines and workflows treat a comment like any other inbound message (`message.inbound` with channel `comment`).

## Workflows, API and MCP

**Trigger:** *Neuer Social-Kommentar* (`social_comment.received`, filter platform) with `{{event.platform}}`, `{{event.text}}`, `{{event.permalink}}`. The general trigger *Nachricht empfangen* with channel *Kommentare* works too.

| Endpoint | |
| --- | --- |
| `GET /api/social-comments?platform=&status=open&contact_id=&limit=` | the comments with `hidden`, `can_hide`, `reply`, `suggestion` |
| `GET/PUT /api/social-comments/settings` | `{meta, youtube, linkedin, linkedin_org}`; the answer adds `sources` (what is connected) |
| `POST /api/social-comments/poll` | fetch YouTube/LinkedIn now |
| `POST /api/social-comments/:id/reply` | `{text}` – public reply |
| `POST /api/social-comments/:id/hide` | `{hidden: true|false}` |
| `POST /api/social-comments/:id/suggest` | `{instruction?}` → `{text}` |

`GET /api/conversations/:id/messages` adds `comment` to each comment message (the inbox uses it). Settings are area *Einstellungen*, the rest *Konversationen*. **MCP:** `ghl_social_comments` (`list`, `reply`, `hide`, `suggest`).

## For developers

`server/modules/social-comments.ts` (tables `social_comments`, `social_comment_authors`, `social_comment_settings`) hooks into the Meta webhook through `app.services.metaWebhookHooks` (parser shared with Kommentar-zu-DM: `parseComments` in `services/igcomments.ts`), finds the sub-account with `metaKit.accountFor`, replies through `metaKit.graph(loc, channel, method, path, body, accountId)` and polls YouTube/LinkedIn through `app.services.nango.request`. It decorates messages with `messageRows`; the inbox shows the actions through the UI slot `inbox.message` (`web/src/slots.tsx` → `pages/SocialComments.tsx`). Pure parts (parsers, prompt) live in `services/social-comments.ts`; other modules can push a comment in with `app.services.socialComments.ingest(locationId, comment)`. Tests: `tests/social-comments.test.ts` (fake Graph API and fake Nango).
