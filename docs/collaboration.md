**English** · [Deutsch](collaboration.de.md)

# Live collaboration everywhere

Who on the team is where in the app right now? HyperLevel shows it on every page – without any page having to do anything for it:

- **Avatars in the top bar:** the colleagues who currently have the same page open. The hover hint says “Anna – editing right now”, and a yellow dot on the avatar shows that someone is typing there.
- **In the side menu:** small avatars next to the menu item where someone is working right now (can be turned off: “Show the team in the menu”). A click on an avatar shows the name and page, and **Go there** opens the same page. By keyboard: from the menu item, press Tab to reach the “Who is in …” button (it appears as soon as it has focus), Enter or Space opens the list, Esc closes it and returns the focus.
- **“Team is here”:** the button with the people icon in the top bar lists everyone who is online in the sub-account, with their page and **Go there** – the switches are there too.
- **“Anna just saved here”:** if someone saves on the page you have open, a hint with **Reload** appears (it reloads only the page, not the whole app).
- **“Anna is editing this too”:** if you both type on the same page, a yellow hint warns you – so nobody overwrites the other's change.
- **Other people's mouse pointers** with name and color: on by default on Canvas boards and Living Boards, on all other pages only if both sides turn it on.

All hints close with ✕ or Esc. On touch devices (phone, tablet without a mouse), no mouse pointers are shown or sent.

## Where there are live features of their own

Some areas already had their own real-time features before – there the avatars at the top stay, and the general hints “saved” and “is editing this too” do not apply:

| Area | Live feature of its own |
| --- | --- |
| Conversations | “Anna is typing…” and a collision hint per conversation ([team-inbox.md](team-inbox.md)) |
| Canvas | own mouse pointers, selection and a people list per board ([canvas.md](canvas.md)); new: **Follow** – one click on a person in the header, and your view stays on their pointer until you pan, zoom or press ✕ yourself |
| Team chat | presence and “typing …” ([team-chat.md](team-chat.md)) |
| Living Boards | changes arrive for everyone immediately ([living-boards.md](living-boards.md)); new: other people's pointers, relative to the board's grid |

## Settings

Each person decides for themselves (saved on the login, applies in all sub-accounts) in the **Team is here** popover:

| Switch | Default | Effect |
| --- | --- | --- |
| Show the team in the menu | on | Avatars next to the menu items |
| Show other people's cursors | Only on boards and Canvas | *On every page* or *Off*. Your pointer goes only to people who share their pointer too – and only while you are on the same page. *Off* also applies in the Canvas: no pointers of others, and yours is not sent |
| Invisible | off | Nobody sees you: no presence, no mouse pointer, no “saved”. You still see who is where – but no other people's mouse pointers (someone who cannot be seen themselves does not watch anyone's pointer unnoticed) |

**For the whole sub-account**, someone with the *Settings* area turns live collaboration on or off in the same popover. When it is off, the server accepts no more presence, forgets the existing presence immediately, the team list stays empty and open tabs show nothing any more.

## Privacy and works council

In Germany, presence indicators can be a technical facility for monitoring performance and behavior (§ 87 para. 1 no. 6 BetrVG, the Works Constitution Act) – wherever there is a works council, the feature should be agreed with it before you turn it on. HyperLevel is therefore built so that it cannot be turned into surveillance:

- **Live state only.** Presence, page, “editing right now” and mouse pointers exist solely in the server's memory. There is no table, no history, no statistics, no export and no log line (not in the audit log or the undo journal either). A tab that has not reported for 45 seconds is forgotten; a server restart forgets everything. Only turning it on and off for the whole sub-account is a setting like any other and appears in the audit log (`presence.settings.update`, “Live collaboration switched on/off”, with person and time).
- **No timestamps to the outside.** The team list says only “online” and where – not since when.
- **Invisible** is possible at any time, and switching it is not logged anywhere.
- **Can be turned off per sub-account.**
- **A hidden tab signs off after one minute** (no presence while nobody sits in front of the screen).
- Only the switches themselves are stored: the three personal ones in the table `presence_prefs`, the sub-account switch in the sub-account's settings.

## Who sees what

- **Only the same sub-account.** Whoever works in sub-account A is visible only to people who are also in A right now – never across sub-accounts, not even to agency admins who are somewhere else at the moment.
- **The page only with permission for the area.** A member without the *Accounting* area sees only “online” for a colleague in accounting, not where. Which page belongs to which area is defined in `PRESENCE_ROUTES` (`server/services/presence-model.ts`) – the same areas as in the menu; unknown pages show only “online”. Only admins see the agency overview, and only people with the *HR* area see the HR page.
- **No record names.** Only the address (`/contacts/<id>`) is passed on, never any text from someone else's browser – the reader's own app inserts the menu name (“Contacts”). That way neither the name of a contact or deal nor any other text can end up with the others. Whoever may not open the record does not get in with **Go there** either.
- **People only.** A sign-in in the browser (also in the WebView of the Android app) or the device token of the app. API keys, MCP connections and AI apps (OAuth), agency keys, the AI agent, plugins and the Werkstatt get 403 – as with the live stream of the team inbox.
- **Hidden logins** (the operator in cloud mode) never appear – and, like invisible people, receive no other people's mouse pointers.
- **The stream ends with the sign-in.** Signing out, a revoked session (“Sign out all others”, new password), a change to or deletion of the person, removal from the sub-account or deletion of the sub-account end the live stream immediately; an expired session at the latest at the next check (every 20 seconds). The server then sends `bye`, the tab stops reporting and only reconnects when it is looked at again.

## For developers

Module `server/modules/presence.ts`, state in `server/services/presence-hub.ts` (in memory, one process), pure logic in `server/services/presence-model.ts` (server and browser use the same file). Interface in `web/src/presence/`: `store.ts` (tiny shared state, part of the first download), `client.ts` (the one connection per tab), `Presence.tsx` (`PresenceLayer`, `PresenceBar`, `NavDots`, its own chunk), `canvas.tsx` (people and **Follow** in the Canvas).

| Route | Purpose |
| --- | --- |
| `GET /api/presence/stream?clientId=&locationId=` | SSE per tab and sub-account. Events: `hello` (`enabled`, `prefs`, `peers`), `presence` (a colleague's tab), `gone`, `saved` (`name`, `page`), `cursor` (`name`, `color`, `pts`), `settings` (`enabled`), `bye` (`reason`: `signed_out` – sign-in ended or no access any more –, `tabs` – a newer tab of the same person has taken the slot; the stream ends afterwards, and the browser should not reconnect by itself). Server full: 503 instead of a stream |
| `POST /api/presence` | Heartbeat every 15 s and on every page change: `{clientId, page, editing?, saved?, leaving?, x?, y?}` or bundled `pts: [[x, y], …]` (at most 10); a `title` from an older browser is ignored. At most 300 per person and minute (otherwise 429). Without an audit line and journal (`ctx.skipAfterWrite`) |
| `GET /api/presence/team` | online in the sub-account, one row per person: `user_id`, `name`, `color`, `page` (or `null`), `title` (always `null`), `editing` |
| `GET`/`PUT /api/presence/prefs` | own switches `invisible`, `menu`, `cursors` (`boards`, `all`, `off`); without an audit line |
| `GET`/`PUT /api/presence/settings` | switch of the sub-account `{enabled}` (area *Settings*); every change is an audit line `presence.settings.update` |

- **Page:** the address below `/app`, strictly validated (starts with `/`, at most 200 characters, only `A-Za-z0-9/_-.:~`, query and anchor are cut off).
- **Mouse pointer:** `x` as a fraction of the width (0…1), `y` in pixels from the top edge including the scroll offset, measured against the element `[data-presence-surface]` of the page (Living Boards: the grid) or otherwise against the page content. The browser takes about 20 positions per second and sends them bundled roughly three times per second (the API limit of 900 requests per minute applies per address – an office shares one); the server forwards at most one transmission per tab every 50 ms and limits the values.
- **“Saved”:** `web/src/api.ts` fires the event `pghl:saved` after every successful writing call; `client.ts` counts it only if the person clicked or typed in the page content within the last 10 s and the tab is visible, filters out its own things (presence, agent, settings, read-only POSTs such as preview, search, check, audience counting, AI drafts, polling of running jobs) and sends a `saved` at most every 3 s (the server at most every 2 s).
- **“Editing right now”:** `input`/`change` in the page content (`.content`), off again after 20 s without input; search fields (`type="search"`, `role="searchbox"`) and areas with `data-presence-ignore` do not count – filter fields of a list are best marked this way.
- **A new page** needs nothing – except an entry in `PRESENCE_ROUTES` with its area (`tests/presence.test.ts` checks that every menu item has one). `own: true` turns off the general hints (the page has its own real-time features), `cursor: 'board'` makes mouse pointers the default there, `cursor: 'own'` leaves them to the page.
- **Goodbye:** when the tab closes, the stream ends (the server forgets the tab immediately); in addition a `leaving` goes out via `fetch(…, {keepalive: true})` – `sendBeacon` cannot send the CSRF header `x-pghl`.
- **Limits:** one HyperLevel process holds the state (like Canvas and team chat); at most 1000 streams (above that 503 – the browser retries after 30 s, 60 s … at most 5 min) and 10 tabs per person (the 11th takes the place of the oldest, which gets `bye` and only reconnects when it is looked at – no back and forth); 300 reports per person and minute. After a restart, the tabs reconnect 5–10 s apart (`retry` with a random component).
- Hooks in `app.services`: `presenceHub` (among others `now` as a clock for tests, `sweep()`), `presence` (`hub`, `enabled`, `prefsOf`).
