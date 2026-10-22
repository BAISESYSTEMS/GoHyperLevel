# iPhone, iPad and foldables: the installable web app

There is no native iOS app, on purpose: HyperLevel runs on iPhone and iPad as a **web app from the Home Screen** – its own window
without browser bars, an icon with your agency's name and logo, push notifications, a number on the icon, and layouts made for
the phone, the iPad (portrait, landscape, Split View, Stage Manager) and foldables such as the iPhone Duo. No App Store, no review,
no build step: an update is a deploy.

| Part | What it is | Where |
| --- | --- | --- |
| **Install** | Home-screen meta, touch icons in every size, launch images for every current iPhone/iPad/foldable screen in light and dark, a manifest with `display: standalone`; all in your agency's colour, name and logo | `web/index.html` (head lines are written at build time), `/manifest.webmanifest`, `/pwa/icon/*`, `/pwa/splash/*` |
| **Install guide** | A friendly sheet "Zum Home-Bildschirm hinzufügen" with the Share icon drawn out, shown a few seconds after signing in on iOS (never in the installed app), remembered per person | `web/src/ios/InstallSheet.tsx`, also *Einstellungen → Mein Konto → iPhone & iPad* |
| **Push** | Web Push from the installed app (iOS/iPadOS 16.4+), an explicit **Mitteilungen aktivieren** button, a tap on a notification opens the right page | `web/src/pages/PushSettings.tsx`, `web/public/sw.js`, `server/modules/push.ts` |
| **Badge** | The number of unread messages on the app icon (Badging API) – set by the app and by every push message | `web/src/ios/badge.ts`, `server/modules/pwa-ios.ts` (`GET /api/app-badge`) |
| **Phone layout** | Under 600 px: a bottom bar (Start, Nachrichten, Kontakte, Aufgaben, Mehr), one pane at a time, keyboard-aware | `web/src/ios/TabBar.tsx`, `web/src/ios/ios.css` |
| **iPad / unfolded layout** | From 600 px: the sidebar as a rail; from 720 px: list + record side by side (inbox, contacts, tasks; contacts only while a contact is open – otherwise the full table), deals open as a drawer | `web/src/ios/MasterDetail.tsx`, `web/src/ios/ios.css` |
| **Keyboard, pen, pointer** | ⌘K, ⌘N, ⌘/ (hold ⌘ for the overview), Esc; Apple Pencil writes into every field (Scribble); hover states with a pointer, no sticky hover after a tap | `web/src/ios/IosLayer.tsx`, `web/src/ios/shortcuts.ts` |

Everything is built from the existing parts (service worker, Web Push, manifest, white-label branding); it needs no new service, no
setting by the self-hoster and no npm package. Web Push and installing need **HTTPS** (a real certificate, or `localhost`).

## What was tested, and what was not

Be clear about this when you promise something to customers.

- **Tested in this repository:** the pure logic (detection, install hint with dismissal, push steps, badge, share, keyboard,
  width classes, fold reading), the server (manifest, white-label icons and launch images drawn per brand, the badge count, push
  payloads), the service worker against fake caches (badge in push, notification clicks that never leave the app, subscription
  change, offline page, cache size), the CSS guards (dvh, 16 px fields, balanced braces), and the **layouts in headless Chromium
  with iOS user agents and the viewports of iPhone 15, iPhone SE, iPad Pro 12.9" (landscape and portrait), iPad mini, Split View
  (507 and 678 px) and the iPhone Duo (folded and unfolded), light and dark** – `npm run ios:shots`. The same run **switches the
  window 466×678 → 890×626 → 466×678 in one session and checks that route, page, scroll position, open dialog, open menu, typed
  text, selection and focus survive without a reload.**
- **Not tested on hardware:** a real iPhone, iPad or iPhone Duo. Chromium is not WebKit: Safari's own toolbars, the on-screen
  keyboard (it is simulated by shrinking the visual viewport), the home-screen install, Apple's push service and the Badging
  API behave as documented by Apple but were not run here. Report anything that differs with the device and iOS version.

## Install

1. Open HyperLevel in **Safari** and sign in (any other browser on iOS/iPadOS 16.4+ can add web apps as well; an in-app browser such as
   Instagram's or Gmail's cannot – open the link in Safari).
2. Tap **Share** (iPhone: the bottom bar, iPad: top right; on newer iOS it can sit under **⋯**), scroll, tap
   **Zum Home-Bildschirm**, leave **Als Web-App öffnen** on, tap **Hinzufügen**.
3. From now on open HyperLevel from that icon. You have to **sign in once more** inside the app: Safari and the Home-Screen app do not
   share cookies. The session then lasts as long as your login does (the cookie has a lifetime, so it survives closing the app).

The sheet appears by itself a few seconds after signing in on an iPhone or iPad in a browser. *Verstanden* hides it
for two weeks, the second time for two months, the third time (or *Nicht mehr zeigen*) for good – remembered per person on that
device. It never shows inside the installed app, inside the Android app or on other systems. The same guide is always in
*Einstellungen → Mein Konto → iPhone & iPad*.

### White label

The agency's **name, colour and logo** (*Agentur → Branding*, or a client's own branding on their own domain) are used for

- the manifest (`name`, `short_name`, `theme_color`) and the `apple-mobile-web-app-title`,
- the **touch icons** (120, 152, 167, 180 and 1024 px – opaque and full-bleed, iOS rounds the corners itself) and the Android icons
  (192, 512 and a maskable 512), drawn on the server in the brand colour with the logo (an uploaded or linked PNG/JPEG; an SVG or no
  logo gives the first letter of the name),
- the **launch images**: the app icon and the name on the app's own background colour, light and dark, for every screen listed in
  `server/services/pwa-devices.ts`.

Without any branding change the shipped HyperLevel icons are used (scaled from `icon-1024.png`). Pictures are generated on demand (a few
milliseconds; the biggest iPad image about 150 ms), kept in memory and cached by the browser for an hour.

> **iOS reads name, icon and launch image when the app is added.** After changing the branding, remove the app from the
> Home Screen and add it again to see the new look.

## Push notifications on iPhone and iPad

What Apple requires, and how HyperLevel meets it:

| Requirement | In HyperLevel |
| --- | --- |
| iOS/iPadOS **16.4 or newer** | The settings page says so when the version is older (`push-flow.ts`). |
| The app must be **on the Home Screen** (a Safari tab has no `PushManager`) | `display: standalone` in the manifest; the settings page explains "Erst zum Home-Bildschirm hinzufügen" with a button for the guide. |
| The permission may only be asked **from a tap** | *Einstellungen → Mein Konto → Benachrichtigungen → **Mitteilungen aktivieren***: the click handler's first `await` is `Notification.requestPermission()`. |
| **Every** push must show a notification (silent pushes get the subscription removed) | The service worker always shows one – a generic one when the payload is unreadable. |
| A valid **VAPID** contact | The admin's e-mail address, or `PGHL_PUSH_CONTACT` (a `mailto:` or `https:` address). Apple's endpoint `web.push.apple.com` is accepted. |

The settings page walks through the steps: *Erst installieren* → *Mitteilungen aktivieren* → *an* (with the choice of what to be notified
about and a test button); *blockiert* explains where the switch is (iOS **Einstellungen → Mitteilungen → HyperLevel**); *Gerät neu
verbinden* appears when iOS has permission but this device is not registered any more (it replaced the subscription, or someone
else signed in). The service worker also re-subscribes by itself when the push service replaces a subscription (`pushsubscriptionchange`).

**Deep links from notifications.** A tap on a notification opens or focuses the installed app and shows the page it is about
(`/app/conversations/<id>`, `/app/tasks`, …) in the right sub-account (`?loc=`). Only paths inside `/app` are ever opened; anything
else lands on the start page.

### The number on the app icon

The icon shows how many messages are unread (all sub-accounts you may see, only if you may use the inbox; the bottom bar's number counts only the sub-account on screen). It is set

- by the app whenever it comes to the front, after navigating, and every 90 seconds while visible (`GET /api/app-badge`), and
- by the **service worker** from the `badge` number inside every push message – so it is right while the app is closed.

It disappears at 0. iOS only allows a badge after notifications were allowed. Browsers without the Badging API simply show nothing.

## Layouts

The layout depends on the **width of the window, never on the user agent**, so the same code serves a phone, an iPad in Split View, a
Stage Manager window and a foldable that opens.

| Width | Class | What you get | Devices |
| --- | --- | --- | --- |
| under 600 px | compact | bottom bar, menu as a drawer behind **Mehr**, list **or** record (with *‹ Liste* / *‹ Aufgaben*) | iPhone (320–440 px), iPhone Duo folded (466), iPad Slide Over and 1/3 Split View (320–507) |
| 600 – 1023 px | medium | the sidebar as an icon rail, always; from **720 px** list and record side by side | iPad portrait (744–834), 1/2 and 2/3 Split View, iPhone Duo unfolded (626 upright, 890 held wide), iPhone landscape |
| 1024 px and more | expanded | the full sidebar (or the rail you chose), three columns in the inbox | iPad landscape, Stage Manager windows, desktop |

Where two panes fit, the choice is a CSS container query on the box itself (`MasterDetail.tsx`): **inbox** (views | list | conversation,
collapsing step by step), **contacts** (list | contact), **tasks** (list | task with title, description, due date and done).
A **deal** opens as a drawer on the right so the pipeline stays visible. Narrower, the same pages show one pane at a time.

**Keyboard.** The on-screen keyboard shrinks the visual viewport but not the layout viewport on iOS. `viewport.ts` measures the
difference (`visualViewport`), sets `--vv-h`/`--kb-h` and `data-keyboard="open"`; the shell then follows the visible part, the bottom bar
steps aside, composers stay above the keys and a focused field is scrolled into view.

**Native feel.**

| Topic | What is done |
| --- | --- |
| Notch, Dynamic Island, home indicator | `viewport-fit=cover` and `env(safe-area-inset-*)` on the shell, top bar, bottom bar, drawer, dialogs, toasts and floating buttons. The status bar style is `default`: it stays readable in light and dark (`black-translucent` always draws white text, which vanishes on a light header, and cannot follow the theme). |
| `100vh` | Every `vh` size has a `dvh` twin right after it (guarded by a test) – the address bar and home indicator move. |
| Zoom | Fields are 16 px on touch screens (iOS zooms into smaller ones); **pinch zoom is not blocked** (accessibility). `touch-action: manipulation` removes the double-tap delay. |
| Bounce | The page behind never bounces (`overscroll-behavior`); scroll areas bounce on their own. |
| Pull to refresh | In the installed app, pulling a page down at the top loads it again (not on pages with their own gestures: canvas, boards, wiki, editors; not while the keyboard is up). |
| Touch | Targets of at least 44 px; no grey tap flash but a pressed state; no sticky `:hover` after a tap; action buttons that faded in on hover stay visible. |
| Dropped files | A file dropped outside an upload area no longer replaces the app with that file. |

## iPad

- **Split View, Slide Over, Stage Manager:** any width from 320 px up works, there are no device checks. The classes above change
  while you drag the divider or resize the window; nothing reloads and nothing is lost.
- **Hardware keyboard:** ⌘K jump, ⌘N the page's main action ("+ Kontakt", "+ Opportunity" …), ⌘B sidebar, ⌘Z undo, ⌘⏎ send/save, Esc closes a
  dialog, menu or the overview; **⌘/** shows all of them, and **holding ⌘ for a second** shows the short list (the system's own "hold ⌘"
  overlay is not available to web apps). The inbox has its own keys (`?` lists them). Tab order follows the page.
- **Trackpad and mouse:** hover states and tooltips of the rail, right-click menus where they exist on the desktop (the canvas),
  drag and drop of pipeline and ticket cards and of files into upload areas (canvas, wiki, video studio, media library).
- **Apple Pencil:** standard fields, so **Scribble** turns handwriting into text in every field; the canvas draws with
  Pointer Events and **pen pressure** (`pointerType: 'pen'`).
- **Share sheet:** invoices (*Teilen* next to *Ansehen / PDF*) and exports (reports as CSV, the profit calculator) go through the system's
  share sheet in the installed app – Mail, Messages, AirDrop, *In Dateien sichern*.

## iPhone Duo and other foldables

The iPhone Duo is a foldable iPhone (2026). The CSS viewports below come from **third parties** (webmobilefirst.com, screensize.io)
who say Apple had not published browser values yet – treat them as estimates; **nothing in the layout depends on them**:

| State | Viewport (CSS px, 3×) | Class | Layout |
| --- | --- | --- | --- |
| folded (5.4") | 466 × 678 | compact | phone: bottom bar, one pane |
| unfolded (7.6"), held wide | 890 × 626 | medium | rail, list + conversation side by side |
| unfolded, held upright | 626 × 890 | medium | rail, one pane at a time (under 720 px) |

**Fold and unfold keep your place.** The width class is switched on `<html>` in the same frame as the resize; the pages are not
remounted: route, scroll position, open dialog, open menu drawer, typed text, selection and focus stay. Two details make that
work for panes that exist in only one layout: list and record stay mounted whichever is shown (`MasterDetail`), and the reading position of
a conversation – scrolled by the whole thread when folded and by the message list when unfolded – is carried over as a share of the
scroll height (`viewport.ts`). `npm run ios:shots` checks all of it on a 466×678 → 890×626 → 466×678 round trip.

**The hinge.** If a browser reports it (`visualViewport.segments`, `@media (horizontal-viewport-segments: 2)`, `env(viewport-segment-*)`),
`html` gets `data-segments="2"` and `--hinge-gap`, the inbox aligns its list with the first segment and dialogs stay out of the gap.
Safari publishes none of this today; the layout does not need it.

Launch images and icons exist for both screens (`iphone-duo-folded`, `iphone-duo-open` in `pwa-devices.ts`).

## Offline and robustness

- **Service worker** (`web/public/sw.js`): the app shell is served from the cache only when every file it names is cached (a half-cached shell
  would start a blank page); hashed files are cached only when they are what their name says; `/api` answers are the offline
  fallback, **limited to 80 entries per device** and cleared on logout; a page of its own ("Du bist offline", dark mode, safe areas,
  *Erneut versuchen*) appears when there is nothing cached yet.
- **Storage on iOS:** Safari deletes a site's script-written storage after 7 days without a visit; **apps added to the Home Screen are exempt from
  that cap** (WebKit's Intelligent Tracking Prevention), but iOS may still evict storage when the disk is full. The app asks for persistent
  storage (`navigator.storage.persist()`, iOS 17+), keeps the caches small and never depends on them: a missing cache is a slower first
  start, not data loss (everything lives on your server).
- **Boot guard** (`web/public/boot-guard.js`): if the app does not start within 10 seconds it replaces the blank page with a plain page
  (what went wrong, *Neu laden*, *Offline-Daten löschen*), inside the safe areas, and reports it for users who allowed error reports.
- **Camera and files:** upload fields list their file types (`accept="image/png,image/jpeg,…"`), so iOS offers *Fotomediathek*, *Foto
  aufnehmen* and *Dateien*; a `capture` attribute is deliberately not set – it would force the camera and hide the library.
- **Share target:** the Web Share Target API (receiving shares from other apps) is **not available in Safari**, so the manifest has no
  `share_target`. Sharing out of HyperLevel works (above).

## Deep links: what iOS allows

- **Notifications** open the installed app (above).
- **Links in e-mails, messages and other apps open in Safari, not in the installed app.** iOS has no Universal Links for Home-Screen
  web apps and no link capturing. A link to `/app/…` shows the page in Safari; sign in there, or open the app from the Home Screen
  and navigate. (The Android app does open such links.)
- **Inside the app**, links to pages outside the scope `/app` – a public invoice (`/i/…`), a booking page, an OAuth consent screen of
  another provider – open in a small in-app browser with a *Fertig* button. That is how iOS treats out-of-scope links; connecting
  Google or Microsoft from the installed app may end in that window – tap *Fertig* and reopen the page.

## Limits compared with a native app

| | Web app on iPhone/iPad | Native app |
| --- | --- | --- |
| Install | Safari → Zum Home-Bildschirm (guided) | App Store |
| Push | iOS 16.4+, installed app, one tap to allow; no rich media, no actions on the lock screen beyond two buttons | everything APNs offers, critical alerts |
| Widgets, Siri/Shortcuts, Live Activities, Share extension, Spotlight | **no** | yes |
| Background work | none while the app is closed (pushes wake the service worker briefly) | background fetch, location, VoIP calls |
| Links from other apps | open in Safari | Universal Links open the app |
| Offline | the shell and the last answers | whatever the app stores |
| Phone calls | browser phone while the app is open; no CallKit | CallKit |
| Haptics | not available | yes (deliberately skipped) |
| Biometrics | Passkeys (Face ID/Touch ID) for sign-in work | yes |
| Updates | immediate on the next start | through the store |

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| No "Zum Home-Bildschirm" in the Share sheet | In-app browser (Instagram, Gmail …): open the page in Safari. Private browsing tabs on old iOS versions cannot add either. |
| After installing, the app asks for the login again | Safari and the Home-Screen app keep separate cookies – sign in once inside the app. |
| "Mitteilungen aktivieren" is not there | You are still in Safari: open HyperLevel from the Home-Screen icon. iOS must be 16.4 or newer. |
| The iOS dialog never appeared / "blockiert" | The permission was denied once. iOS **Einstellungen → Mitteilungen → HyperLevel** (or the app's name) → allow. |
| Test notification arrives but real ones do not | Focus modes and *Mitteilungen → Zustellung* hide them; also check the choice of what to be notified about (*Mein Konto*). |
| "Gerät neu verbinden" | iOS replaced the subscription. Tap the button; it needs permission only once. |
| No number on the icon | Notifications must be allowed; 0 unread shows nothing. Check *Mein Konto → iPhone & iPad*. |
| The name or icon is the old one | iOS reads it when the app is added: remove the app and add it again. |
| Blank screen after an update | The boot guard shows a page after 10 s; *Neu laden*, then *Offline-Daten löschen* if it persists. Also: close the app completely and reopen it. |
| Keyboard covers a field | Report it with the iOS version – the layout follows `visualViewport`; third-party keyboards sometimes report their height late. |
| Layout looks like a phone on an iPad | The window is narrower than 600 px (Slide Over, narrow Split View) – that is the phone layout by design. |

## For developers

| Piece | File |
| --- | --- |
| Device table (CSS size × pixel ratio, one line per screen), head lines, launch image media queries | `server/services/pwa-devices.ts` (no imports; the build uses it) |
| Manifest, white-label brand, icon and launch-image drawing | `server/services/pwa-ios.ts` |
| Routes `/pwa/icon/:kind.png`, `/pwa/splash/:w×h-:scheme.png`, `GET /api/app-badge`, `app.services.pushBadge` | `server/modules/pwa-ios.ts` |
| Head lines into `index.html` at build time (`<!--ios-head-->`) | `scripts/vite-ios-head.ts` |
| Detection, width classes, keyboard, hinge | `web/src/ios/platform.ts`, `viewport.ts` |
| Install hint, push steps, badge, share, shortcuts, tabs | `install.ts`, `push-flow.ts`, `badge.ts`, `share.ts`, `shortcuts.ts`, `tabs.ts` |
| Bottom bar, install sheet, settings card, shortcut sheet, pull-to-refresh, list + record | `TabBar.tsx`, `InstallSheet.tsx`, `IosAppCard.tsx`, `IosLayer.tsx`, `MasterDetail.tsx` |
| Styles | `web/src/ios/ios.css` (shell, loaded with the entry), `ios-sheet.css` (lazy) |
| Tests | `tests/ios-pwa.test.ts`, `tests/ios-logic.test.ts`, `tests/service-worker-ios.test.ts`; browser run: `npm run ios:shots` |

A new device is one line in `IOS_DEVICES` – the head lines, the allowed picture sizes and the tests follow. A new list + record page is
`<MasterDetail open={!!id} list={…} detail={…} />`; rows in the list may carry `.md-sub` for a second line in the narrow list.
The launch-image sizes are whitelisted (`SPLASH_SIZES`): the route cannot be asked for arbitrary pictures.

Environment: `PGHL_PUSH_CONTACT` (push contact, `mailto:` or `https:`). Nothing else.
