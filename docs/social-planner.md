**English** · [Deutsch](social-planner.de.md)

# Social Planner: client approval and evergreen categories

The Social Planner schedules posts for the channels of a sub-account through a self-hosted Postiz instance (set it up under *Agency → Integrations*, see [self-hosting.md](self-hosting.md) and [api.md](api.md)). This page describes two extensions: **client approval by link** and **evergreen categories**.

## Client approval (magic link)

*Social Planner → Approvals → Send for approval*: pick the channels, write one or more posts (up to 30) with a scheduled time, and add a title for the client under *More fields* – *Create link* gives you **one link for all posts**. The client needs no login: they see each post with its text, images and date, and click **Approve**, **Request changes** (with a note) or **Reject**.

- **Approved** → the post is scheduled through the Social Planner right away (if the date is already in the past, it goes to Postiz as a draft). If that fails (planner not connected, channel removed), the post stays *Approved* with the reason, and *Schedule* retries it.
- **Changes requested** → the note appears in the list; the client can still approve the same post later.
- Links are valid for **30 days**; only a hash of the link is stored. Every decision fires the `social.approval` event (for workflows and webhooks).
- API: `GET|POST /api/social-approvals` (`{title?, posts: [{content, integration_ids, date?, upload_ids?}]}` → `{url, expires_at, approvals}`), `POST /api/social-approvals/:id/schedule`, `DELETE /api/social-approvals/:id`; client page `GET /social-review/:token`. MCP: `ghl_social_approval_list`, `ghl_social_approval_create` (returns the URL, sends nothing).

## Evergreen categories

*Social Planner → Evergreen*: a category (e.g. “Tips”, “Customer quotes”) collects **reusable posts** and has a **weekly plan** (e.g. Tue 09:00, Thu 17:00, in the sub-account's time zone) and channels. With *Post automatically*, each slot publishes the post that has been used **least often** (the oldest one on a tie). *Post the next one now* publishes right away.

- *More fields*: **Reuse** (on by default) – once every post has gone out, it starts over; off: the category **pauses** when nothing unused is left. This is also where the next slots are listed with their posts, and *Delete category*.
- Every run is logged (last 50); an error (e.g. planner not connected) is shown on the category, and the next slot still runs.
- API: `GET|POST /api/social-queues`, `PATCH|DELETE /api/social-queues/:id` (`{name, integration_ids, slots: [{day: mon…sun, time: "HH:MM"}], recycle, active}`), `POST /api/social-queues/:id/items` (`{content}` or `{items: [...]}`), `PATCH|DELETE /api/social-queues/:id/items/:item`, `GET /api/social-queues/:id/preview`, `POST /api/social-queues/:id/run`. MCP: `ghl_social_queues`, `ghl_social_queue_add`.

## For developers

`server/modules/social-approval.ts` (tables `social_approval_links`, `social_approvals`) and `server/modules/social-queues.ts` (tables `social_queues`, `social_queue_items`, `social_queue_runs`; schedule purely in `cleanSlots`/`nextSlot`, scheduler via `app.onTick`, hook `app.services.socialQueues.run`) both post through `app.services.socialPost` from `modules/social.ts` – one registry line `...gapsSitesModules`. Interface: `web/src/pages/SocialExtras.tsx` (its own chunk). Tests: `tests/gaps-sites-marketing.test.ts` (with a fake Postiz).
