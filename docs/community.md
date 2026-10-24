# Community

A community for your clients and fans inside the CRM: a public page people can join from, a member area with feed, messages,
challenges and live calls, an installable phone app, and the numbers to run it. It covers what Skool does and adds what a CRM
is good at: every member is a contact, every action can start a workflow, and the people, the money and the content live in one
place.

- **Team side:** menu *Seiten → Community* (`/community` in the app). One tab per job: *Beiträge*, *Meldungen*, *Kanäle*, *Mitglieder*,
  *Termine*, *Rangliste*, *Beitritt*, *Zahlen*, *Wachstum*, *Aktivierung*, *Nachrichten*, *Einstellungen*.
- **Member side:** the member area of the sub-account, `/portal/<sub-account>/community` (every group in the CRM links to it as *im Mitgliederbereich*). The same
  address works as the start page of the phone app.
- **Public side:** `/c/<community-slug>` is the page people see before they join; `/communities` lists the communities that opted in.

The UI is German; this page is English. All routes are listed in [api.md](api.md#community); every write is in the audit log; all
data is scoped to the sub-account and to the *Kurse & Community* area of the user's permissions.

## Contents

1. [Quick start](#quick-start)
2. [Joining: public page, tiers, invites, coupons](#joining-public-page-tiers-invites-coupons)
3. [Member experience](#member-experience)
4. [Gamification](#gamification)
5. [Challenges](#challenges)
6. [Live calls](#live-calls)
7. [Admin and growth](#admin-and-growth)
8. [The member app (PWA)](#the-member-app-pwa)
9. [Automations, MCP and the team app](#automations-mcp-and-the-team-app)
10. [Import and export](#import-and-export)
11. [Setup for self-hosters](#setup-for-self-hosters)
12. [Skool compared](#skool-compared)
13. [Moving from Skool](#moving-from-skool)
14. [Privacy and safety notes](#privacy-and-safety-notes)

## Quick start

1. *Seiten → Community → Neue Gruppe*. A group starts with the channels *Allgemein*, *Vorstellungsrunde* and *Ankündigungen*.
2. *Einstellungen → Zugang*: choose who gets in (see [Access modes](#access-modes)). For a Skool-style paid club pick *Beitritt über
   die Community-Seite*.
3. *Beitritt*: write the About text, add a cover, create tiers (free or paid) and, if you want, invites and discount codes.
   Copy the link of the public page (`/c/<slug>`) – that is your sales page.
4. *Wachstum → Willkommen*: switch on the welcome message and the onboarding checklist so new members know what to do first.
5. Post a first message and pin it, then *Aktivierung* for badges, perks and a first challenge.

### Access modes

| Mode | Who sees the group |
| --- | --- |
| *Alle im Mitgliederbereich* (`all`) | Everybody who can log in to the member area |
| *Teilnehmer bestimmter Kurse* (`courses`) | People with active access to one of the chosen courses |
| *Kontakte mit bestimmten Tags* (`tags`) | Contacts carrying one of the tags (set by a form, a purchase or a workflow) |
| *Beitritt über die Community-Seite* (`join`) | People who joined through `/c/<slug>`, an invite, a workflow or the import – with or without approval and payment |

`join` is the Skool-style mode: it adds the public page, tiers, trials, approval, invites and discount codes. The other three keep
working exactly as before.

## Joining: public page, tiers, invites, coupons

- **Public page `/c/<slug>`:** cover image or video, description, price, admins, search-engine tags and a join button. A page for a
  paid community shows the tiers with their features and the trial length; a community with approval says so. It loads no scripts or fonts from
  third parties.
- **Join form `/c/<slug>/join`:** name, e-mail, up to three questions of your own, the tier and a discount code. A free community
  lets people in at once or after approval; a paid tier sends people to the checkout of the product behind it.
- **Tiers:** free, monthly, yearly or one-off (lifetime). A tier has a name, a description, a list of features, a product for the
  monthly price and optionally one for the yearly price (so prices, tax and checkout are the ones from [stripe.md](stripe.md)), free
  trial days (up to 90), the courses and tags it grants, a grace period for failed payments, and can be highlighted on the page. A membership
  moves through *request → approval → payment → trial → active → past due → ended*; it starts when `product.purchased` arrives and
  ends with `product.subscription_ended`, a failed payment that is not recovered in the grace period, a refund or a removal.
- **Approval:** requests wait in *Beitritt → Anfragen* (and on the phone, see below). Approve, or reject with a reason; the
  person gets an e-mail either way (rejections can be sent silently). Moderators can answer requests from the member area.
- **Invites:** a link `/c/<slug>/i/<code>` per campaign or person, with a label, an optional tier, trial days, use limit and expiry,
  and the option to skip approval; the list shows how many used it.
- **Discount codes:** percent or fixed amount, for the first payment, a number of months or forever, with use limit, expiry and an
  optional tier; applied through the buy hooks of the Stripe module.
- **Use limits hold while somebody pays:** an invite counts when the person is in, a code when the purchase is paid – minutes after
  they left for Stripe's page. Meanwhile the use is held by that Checkout page: it expires after 31 minutes (a SEPA payment holds it
  until the bank answers), an abandoned one frees the use again. So an invite or code "for the first 10" goes out ten times even when
  many people join at once; the next one is told it is taken right now (at the join form or at *Jetzt kaufen*). A request the team
  approved is not stopped by the invite's limit at the checkout.
- **Directory:** `/communities` lists communities that switch on *Im öffentlichen Verzeichnis zeigen*. Turn the page off for the
  whole server with `PGHL_COMMUNITY_DISCOVERY=0`.
- **Welcome:** every new member gets the welcome mail of the group, the welcome message and checklist of [Wachstum](#admin-and-growth),
  the tags of the tier and the courses it includes.

## Member experience

- **Feed:** posts in Markdown with up to four images, comments one level deep, likes, `@mentions`, follow, "new" markers, pinned
  posts, search and filter chips (all, polls, videos, pinned). Posts can be edited by their author; the team and moderators can hide,
  pin, move and delete.
- **Polls:** a question with 2–6 options, single or multiple choice, with an optional end (up to 30 days).
- **Video:** a YouTube, Vimeo, Loom or MP4 link, or a file uploaded in parts (default limit 500 MB, `PGHL_COMMUNITY_VIDEO_MB`).
  Uploads can be switched off per group. Nothing from outside is embedded unchecked.
- **GIFs:** by link (https image URL); no third-party GIF service is called.
- **Direct messages:** member to member (only between people who share a group where messages are on) and member to team.
  Limits per hour and new conversations per day, block, report, unread counts, a bell and a push message. The team answers member
  messages in *Nachrichten → Postfach*. Messages between two members are never visible to the team – only a message somebody
  reports shows up in *Nachrichten → Gemeldete Nachrichten*, with the four messages before it.
- **Directory:** all members with search, level, "online now" dot and role; what a member shows is their choice.
- **Member map:** members who chose to show their city appear on a dotted world or Europe outline. It uses no map service, no
  tiles and no outside request; the position is the town, never more exact. Off by default (*Einstellungen*).
- **Online now and activity:** presence dot, "active today" and a profile heatmap of active days.
- **Profile:** name, picture, about, headline, city, links, badges, level, points, and what others may see. E-mail addresses are
  never shown to other members.
- **Roles:** *Admin* and *Moderator* among the members (hide, pin, settle reports, answer join requests from the member area).
- **Notifications:** bell, daily e-mail digest (optional, unsubscribe in the profile) and push on the phone, each with its own switch.

## Gamification

- **Points and levels:** points for posts, comments, likes received, finished lessons, live calls and challenges (all adjustable
  under *Aktivierung → Punkte & Rangliste*); nine levels with your own names and thresholds. A level can unlock a course.
- **Leaderboard:** 7 days, 30 days or all time, plus an optional **monthly reset** with a **hall of fame** archive of past months.
- **Badges:** a name, a description, an emoji, a colour and a rule. Rules: by hand only, points, level, posts, comments, likes received,
  courses finished, live calls attended, challenges completed, days as a member, days in a row active. The *Vorschau* button shows who
  would earn a badge before you save. Badges can pay bonus points (up to 1,000), appear on profiles and trigger workflows.
- **Perks:** rewards that unlock at a level – a discount code, a file download (up to 8 MB), a link or a text. A *Vorteile* page
  shows unlocked and locked perks; unlocking sends one notification. Files are only handed out to members who reached the level.
- **Channel rules:** a channel can need a minimum level or one of the tiers. Members below it see the channel locked with the reason.
- **Manual points:** *Aktivierung → Punkte & Rangliste* adds or removes points with a reason (it shows on the member's history).

## Challenges

A challenge is a start and end date with a check-in per day – "30 days of writing", "7 days of outreach". *Aktivierung → Challenges*:
title, emoji, description, dates (in the sub-account's time zone), the goal (how many check-ins finish it, all days by default),
an optional task for each day, whether a note is required, points for check-ins and for finishing, a badge for finishing and a
reminder hour.

Members join from the challenge page, check in once per day (only for today – missed days cannot be filled in later), see their
streak and the board of everybody's check-ins. The reminder goes out once per day from the reminder hour, as a bell entry and a push
message, only to people who have not checked in yet. Workflow triggers *Challenge gestartet* and *Challenge geschafft* fire at the
first and at the goal-reaching check-in.

## Live calls

Every event in *Termine* can become a **Live-Call** with one switch: a [Jitsi Meet](https://jitsi.org/) room is created, with a
random room name no one can guess. Members get a reminder shortly before the start. The room page opens 15 minutes before the start
and closes three hours after the end; members join with one tap. Attendance is booked when somebody enters (points per call are
adjustable, the trigger *Live-Call besucht* fires once per person and call). Afterwards the team adds the **recording** – a video
link (YouTube, Vimeo, Loom, MP4) or an uploaded file – which is published as a post in the channel of your choice.

By default the public server `meet.jit.si` is used. Set your own with `PGHL_JITSI_URL=https://meet.example.com` (or per group in
*Aktivierung → Live-Calls*). Camera and microphone are allowed only on the live page.

## Admin and growth

- **Zahlen (analytics):** members over time, new and left members, MRR and ARR (net), churn, trial-to-paid rate, daily active
  members, posts and comments per day, top contributors, engagement rate and the mix per tier – for 7 to 366 days (30 by default).
  An overview adds one line per group. Available as MCP tool and as JSON.
- **Welcome automation:** an automatic message from a name you choose, an automatic post (`{{name}}` placeholders), and an
  **onboarding checklist** that members see for N days (profile, introduce yourself, comment, like, join a challenge, read the
  *Start here* post, or your own steps). Steps tick themselves.
- **Start here:** choose one post as the entry point; it shows as a highlighted box above the feed with a label you choose.
- **Segments and broadcasts:** pick members by tier, minimum level, active in the last N days, inactive for N days or tag, see the
  count, then send a message now or at a time by e-mail, bell and push. The e-mail goes through the campaigns of the sub-account (so
  sender, unsubscribe and do-not-disturb are the usual ones). Segments are also available as filters in workflows and campaigns.
- **Partner programme:** connect a group to an [affiliate programme](referrals.md); members get a *Partner* tab with their link,
  clicks and commission, and can sign up with one click.
- **Moderation:** reports, auto-hide after N reports, word filter (mask or block), post and comment limits per hour, bans with optional
  hiding of content – unchanged from the first version.

## The member app (PWA)

The member area installs as an app on the home screen. It is branded per client: the name and the colour come from the sub-account,
the icon is drawn from the agency branding (the first letter on the brand colour, or the uploaded logo). Nothing is built, signed or
submitted to a store.

- **Install:** a banner offers it on Android and desktop Chrome/Edge after a few seconds; on iPhone it explains *Teilen → Zum
  Home-Bildschirm*. A closed banner stays away for two weeks.
- **Offline:** if the phone has no signal the app shows a friendly offline page. Pages themselves are never cached – a member who
  logs out sees nothing of the community afterwards.
- **Push notifications:** members switch them on in *Profil → Benachrichtigungen aufs Gerät* for each device. Pushes go out for direct messages,
  mentions, replies, announcements and events, challenges and – only for members who asked for it – every new post. Each kind has its
  own switch. Push needs HTTPS and a browser that supports Web Push (on iPhone the app must be on the home screen, iOS 16.4 or newer).
- **Android app:** the HyperLevel Android app is a WebView; open the member area with
  `https://<your-host>/portal/<sub-account>/community` as a link and it opens inside the app. Nothing changes in the Android code.

The manifest, icons and worker are served from `/portal/<key>/manifest.webmanifest`, `/portal/<key>/icon/<size>.png` and
`/portal/<key>/community-sw.js`; the page script is `/portal-pwa.js`.

## Automations, MCP and the team app

### Workflow triggers

The three original triggers plus nine more. Every trigger has a *Community-Gruppe* filter; the ones with their own filter are noted.
The event data below is what `{{event.…}}` can read; every event also carries the member as the workflow's contact.

| Trigger | Event data |
| --- | --- |
| `community.post_created` | `groupId`, `postId`, `channelId`, `contactId`, `post {title, …}` |
| `community.member_joined` | `contactId`, `groupId`, `group {id, name}` |
| `community.level_reached` | `contactId`, `groupId`, `level`, `level_name`, `group` (filter: minimum level) |
| `community.member_left` | `groupId`, `group`, `tier {id, name}`, `reason` (`canceled`, `payment_failed`, `removed`, `refunded`) |
| `community.trial_started` | `groupId`, `group`, `tier`, `trial_ends_at` (filter: tier) |
| `community.trial_converted` | `groupId`, `group`, `tier` (filter: tier) |
| `community.join_requested` | `groupId`, `group`, `tier`, `answers {question: answer}` |
| `community.challenge_joined` | `groupId`, `group`, `challenge {id, title}` (filter: challenge) |
| `community.challenge_completed` | `groupId`, `group`, `challenge {id, title}`, `checkins` (filter: challenge) |
| `community.badge_earned` | `groupId`, `group`, `badge {id, name, emoji}`, `by` (empty = automatic) (filter: badge) |
| `community.dm_received` | `from {id, name, team}`, `toTeam`, `message {id, text}`, `threadId` (filter: direction *an das Team* / *an ein Mitglied*) |
| `community.event_attended` | `groupId`, `group`, `event {id, title}` (filter: event) |

### Workflow steps

| Step | What it does |
| --- | --- |
| *In Community aufnehmen* / *Aus Community entfernen* | The existing steps; for a `join` group they create or end a free membership with the tier you name (and the welcome automation) |
| *Community-Abzeichen vergeben* | A badge by name or ID, once per member, with its notification and bonus points |
| *Community-Nachricht senden* | A direct message from the team (or a named sender); a message sent by a workflow never starts the trigger *Nachricht erhalten* again, so loops cannot happen |
| *Community-Punkte vergeben* | Positive or negative points with a reason |
| *Community-Beitrag schreiben (als Team)* | A post in a channel, optionally notifying everybody; placeholders like `{{contact.first_name}}` work |

### MCP tools

For Claude, Codex and the HyperLevel agent (every tool respects the area permission of the key):

| Tool | Use |
| --- | --- |
| `ghl_community_members` | Groups of a project, or the members of one group (search, banned only) with points, level, posts |
| `ghl_community_post` | Post as the team (Markdown; channel, pin, notify, poll, video link, GIF link). Classified as a sensitive write |
| `ghl_community_stats` | The numbers of one group or an overview of all (`days`, `series`) |
| `ghl_community_grant` | `member`, `remove`, `tier`, `badge` or `points` for one member. Classified as a sensitive write |
| `ghl_list_community_posts`, `ghl_create_community_post` | The original read and write tools |

### Team app (Android)

The Android app shows what needs attention without opening the web app: join requests, reported posts and messages, member
messages, and a button to post as the team. The endpoints are under `/api/mobile/community` and relay onto the normal routes, so
rights, validation, events and the audit log are identical. See [api.md](api.md#mobile-app).

## Import and export

*Community → Importieren / Exportieren* (see also [Moving from Skool](#moving-from-skool)):

- **Members (CSV):** `name` (or `first_name` + `last_name`), `email`, `joined` (member since), `tier`, `tags`, `points`, `phone`. Column
  names are recognised in English and German; delimiter `,` `;` or tab; BOM and quoted line breaks are fine; up to 5,000 rows and 6 MB.
  A **dry run** shows what would happen per row: new, already a contact, already a member, duplicate, invalid. You can fix the
  column mapping, the date order (day-first or month-first) and map your old tier names to tiers.
- **Posts (Markdown):** one file per post, optional front matter (`title`, `date`, `author` by e-mail or name, `channel`, `pinned`),
  a `# Heading` as title otherwise; up to 500 files, 120 KB each. Dates are kept if you want, authors are matched with members,
  everything else becomes a team post. Posts that exist already (same title and text) are skipped.
- **Quiet by default:** an import sends no mail, starts no workflow and pays no points, unless you switch each on (people marked
  *do not disturb* never get the mail). You must tick that you may contact and store these people (for example because they joined your community themselves).
- **Export:** `members.csv` (`FirstName, LastName, Email, Joined, Tier, Level, Points, Status`) and `posts.json` (posts with channel,
  author, date, likes and comments) per group, any time – your data is never locked in.

## Setup for self-hosters

Nothing is needed to start: the community works on a fresh install. The optional settings:

| Setting | Default | What it does |
| --- | --- | --- |
| `PGHL_BASE_URL` | – | The public address; used for the links in mails, push messages, the manifest and invites. Must be `https://` for push and install |
| `PGHL_COMMUNITY_DISCOVERY=0` | on | Turns the public directory `/communities` off |
| `PGHL_COMMUNITY_VIDEO_MB` | `500` | Largest video a member can upload |
| `PGHL_JITSI_URL` | `https://meet.jit.si` | The Jitsi Meet server for live calls |
| `PGHL_PUSH_CONTACT` | admin e-mail | The contact address in the push headers (a `mailto:` or https URL) |

What needs real accounts or keys (everything else runs offline):

| Feature | Needs |
| --- | --- |
| Paid tiers, trials, discount codes | A Stripe account connected in the sub-account – see [stripe.md](stripe.md) – and a product per paid tier |
| Mails (welcome, approval, digest, broadcasts, reminders) | An SMTP or other mail sender for the sub-account |
| Push on phones | HTTPS on the real domain. The VAPID key pair for members is created automatically on first use; the private half is stored encrypted |
| Live calls with your own branding or recording | Your own Jitsi server (optional; the public one works without any account) |
| The partner programme | An [affiliate programme](referrals.md) |

Back up the data directory as usual – videos and perk files live in it. Restores keep memberships, points, badges and challenges.

## Skool compared

Skool is a fine product for one thing: a simple paid community. This table is about what each does as of writing; check
skool.com for its current plans and limits.

| | Skool | This community |
| --- | --- | --- |
| Hosting and data | Skool's servers, one platform per group | Your server, your database; export any time |
| Price | Monthly platform fee per group plus a transaction fee on paid memberships | No platform fee; Stripe's own fees only |
| Public About page, paid tiers, free trial, discount codes, invites, join questions, approval | Yes | Yes |
| Feed, comments, likes, pinned posts, polls, video, GIF, search | Yes | Yes |
| Courses (classroom) | Yes, inside the group | Yes – the CRM's courses, with drip, certificates and quizzes; levels can unlock them |
| Points, levels, leaderboard | Yes | Yes, plus a monthly reset with an archive |
| Badges | Level names | Rule-based and manual badges with preview, bonus points and triggers |
| Level rewards | Level-locked courses | Courses, **perks** (codes, files, links, text) and level- or tier-locked channels |
| Challenges | No dedicated feature | Built in: daily check-ins, streaks, reminders, board, badge, workflows |
| Calendar and live calls | Calendar with meeting links | Calendar, Jitsi calls with attendance, recording post, points |
| Direct messages | Yes | Yes, with limits, blocks and reports; team inbox |
| Member directory and map | Yes | Yes – the map without any map service |
| Mobile app | Native app under Skool's brand | Installable app under **your client's** name, colour and icon, with push |
| E-mail to members | Limited e-mail blasts | Segments, scheduled broadcasts by e-mail, bell and push through your campaigns, unsubscribe included |
| Analytics | A metrics page | Members, MRR, churn, trial conversion, DAU, top contributors, per group and overall |
| Automation | Zapier connection | Native workflow triggers and steps, MCP tools for AI agents, REST API |
| CRM | None – members are not contacts | Every member is a contact with tags, pipeline, e-mail, invoices and courses |
| Affiliates | Platform-run | Your own [affiliate programme](referrals.md) with SEPA payouts |
| Public API | None (as of writing) | REST API and MCP |
| White label per client | No | Yes, per sub-account |
| Discovery | Skool's own discovery pages | Opt-in `/communities` on your server (off with one setting) – you are not part of a marketplace |

Where Skool is ahead: a large public discovery audience and a very polished native app. If you rely on being found inside Skool, that
traffic does not come with you.

## Moving from Skool

Skool has no public API, so nothing can be pulled automatically. The route that works:

1. **Prepare the new group.** Create it with access mode *Beitritt über die Community-Seite*, add the tiers (match the prices you
   charge today), channels (one per Skool category) and the badges, levels and perks you want. Do it before you invite anybody.
2. **Export the members.** In Skool, as the group owner, export the member list as CSV (the button is in the group's admin area; its
   place changes now and then). It typically has name, e-mail address and join date, and the answers to your membership questions. The
   importer recognises the usual column names and lets you fix the mapping. Rows without an e-mail address cannot be imported – the
   dry run lists them; ask those people to join through an invite link.
3. **Import them.** *Importieren / Exportieren → Mitglieder*: choose the file, check the column mapping and the date order in the dry
   run, map Skool's tier names to your tiers, tick the rights confirmation and import quietly first. Join dates are kept; points can
   come across if the CSV has them.
4. **Bring the best posts.** Copy the posts worth keeping (welcome, rules, evergreen guides) into Markdown files – one file per post,
   optional front matter – and import them as team posts, or write them again in the editor. Comments and likes do not move.
5. **Paid members.** Their subscriptions run in Skool's payment setup and cannot be transferred. Create the matching tier and send the
   people an invite with a discount code (for example the first month free). Members cancel in Skool once they have moved. Free members
   can be given access straight from the import.
6. **Announce.** Pin a post in the old group with the link of the new one, let the import send its welcome mail (or send a broadcast
   to a segment afterwards), and keep the old group open for a few weeks.
7. **Install.** Tell members to open the link on their phone and add it to the home screen; push messages come once they switch them on.

## Privacy and safety notes

- Members are contacts; they can export or delete their data like any contact ([api.md](api.md#privacy-gdpr)). Community data is part of
  the privacy export of a contact – direct messages (both sides of each conversation), blocks and reports included. Erasing a member
  deletes its conversations (for the other side too), its blocks, and the bell entries of other members about it or its posts.
- Other members never see e-mail addresses, and the map and heatmap show only what a member chose to show.
- Messages between two members are private; the team sees only messages that were reported.
- Everything a member writes is escaped on output; uploads are limited to PNG, JPG, GIF and WebP pictures (up to 3 MB) and to the video
  formats listed above; the member area runs under a strict content security policy (the community adds only its own scripts, manifest
  and worker).
- Broadcast e-mails and the import's welcome mail skip contacts marked *do not disturb*; the import is quiet unless you switch things on
  and always asks for the rights confirmation.
- Live calls use a random room name per event; whoever has the link and the member session can join, nobody else.
