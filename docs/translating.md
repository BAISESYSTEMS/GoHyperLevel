# Translating HyperLevel

HyperLevel's interface is written in German and ships an English translation of the areas people use most (phase 1 of
the English UI) and of automations, marketing, the builders, projects, reports, the helpdesk, the social planner, the
wiki and team chat, and courses (phase 2). This page explains how the language layer works, how to translate a page and how to add a
language. The [roadmap](roadmap.md) lists what comes next.

## What is translated

**Phase 1 (English):**

| Area | Files | Namespace |
| --- | --- | --- |
| Shared building blocks (dialogs, toasts, pager texts, loading and error screens, dates, money) | `ui.tsx`, `api.ts`, `boot.tsx`, `lazy.tsx` | `core` |
| App shell: menu, sidebar, top bar, command palette (Ctrl+K), bottom bar on phones, project switcher, notifications, timer, the history/AI agent/feedback buttons, the undo toast, demo banner | `main.tsx`, `nav.tsx`, `theme/Sidebar.tsx`, `ios/TabBar.tsx`, `pages/PmGlobal.tsx` … | `shell` |
| Sign-in, second factor, e-mail link, account linking, first setup, the 2FA duty for admins | `pages/Login.tsx`, `webauthn.ts` | `login` |
| Dashboard | `pages/Dashboard.tsx` | `dashboard` |
| Contacts: list with its company, lead-score, health and source filters, bulk actions, CSV import, new contact, contact page, message composer, GDPR erasure | `pages/Contacts.tsx` (+ the filters from their areas' files) | `contacts` |
| Opportunities: pipeline board, deal drawer, pipeline editor | `pages/Opportunities.tsx` | `deals` |
| Conversations and the team inbox (views, owner, status, snooze, internal notes, bulk actions, shortcuts, channel filter) | `pages/Conversations.tsx`, `pages/TeamInboxKit.tsx` | `inbox` |
| Calendars and bookings: appointments, calendar editor, iCal sync, manual booking | `pages/Calendars.tsx` | `calendar` |
| Settings: tab bar, company, e-mail & SMS, reviews, live chat, fields & tags, team & users, sub-accounts, backups, API keys & webhooks, GoHighLevel import, *Mein Konto* (language, password, sign-in methods & passkeys, devices, 2FA, notifications, the phone apps, Google/Outlook calendar connections) | `pages/Settings.tsx`, `pages/SignInMethods.tsx`, `pages/PushSettings.tsx` … | `settings` |
| Invoices, quotes, credit notes, subscriptions and products, with their state and Stripe badges | `pages/Payments.tsx` | `invoices` |
| The most common generic messages the server sends (signed out, no access, not found, rate limits …) | – | `errors` |

**Phase 2 (English):**

| Area | Files | Namespace |
| --- | --- | --- |
| Workflows and automations: list, builder with trigger and step settings, action picker, conditions, runs and their log, test runs, versions, import, the AI builder, error handling | `pages/Workflows.tsx`, `pages/WorkflowTools.tsx`, `pages/WorkflowRuns.tsx`, `pages/WorkflowAi.tsx`, `pages/WorkflowErrors.tsx` | `workflows` |
| The drag-and-drop email designer (campaigns, templates, the workflow step *E-Mail senden*) | `pages/EmailBuilder.tsx` | `email` |
| Email marketing: campaigns with A/B tests, reminders, send time and speed, segments, template gallery, deliverability (reputation, warm-up, list hygiene, address checks), trigger links | `pages/Campaigns.tsx`, `pages/Segments.tsx`, `pages/EmailGallery.tsx`, `pages/Deliverability.tsx` … | `campaigns` |
| Funnels and websites: page builder (structure, blocks, inspector), design, CMS collections, redirects, statistics, accessibility check, template gallery, blog, A/B tests of pages | `pages/Funnels.tsx`, `pages/site/*`, `pages/Blog.tsx`, `pages/AbTests.tsx` | `sites` |
| Forms and surveys: builder (field types, options, jumps, conditions), design and flow, scoring, security, analytics, submissions, consent | `pages/Forms.tsx`, `pages/FormFields.tsx`, `pages/FormDesign.tsx`, `pages/FormConsent.tsx` | `forms` |
| Tasks and project planning: my tasks, projects (list, board, calendar, Gantt, workload), task details, project settings and automations, time tracking, budgets and profitability | `pages/Tasks.tsx`, `pages/TaskDetail.tsx`, `pages/Pm*.tsx` | `pm` |
| Reports: dashboards, the report builder, schedules, the report sources and their results | `pages/Reports.tsx`, `pages/ReportBuilder.tsx`, `pages/ReportDashboard.tsx`, `pages/ReportKit.tsx` | `reports` |
| Helpdesk: tickets (list, board, dashboard, workload, detail with timeline, replies and merge), helpdesk settings, the ticket workflow step, tickets from calls | `pages/Tickets.tsx`, `pages/HelpdeskSettings.tsx` | `helpdesk` |
| Social planner: calendar, list, composer, statistics, connecting channels | `pages/Social.tsx` | `social` |
| Wiki and team chat, with their emoji menu, embeds and record picker | `pages/Wiki*.tsx`, `pages/TeamChat.tsx`, `pages/Chat*.tsx`, `pages/CollabKit.tsx` | `collab` |
| Courses: course editor, students, discussion, reviews, cohorts, analytics, video library, learning paths, member-area settings, the course workflow step, a contact's courses | `pages/Courses.tsx`, `pages/CourseTabs.tsx`, `pages/CourseVideo.tsx`, `pages/CoursePaths.tsx` | `courses` |

`core` also gained what several areas share: the charts (`charts/*`), the QR code dialog, the *Aufs Canvas* button
of record pages, the opened/clicked note of e-mails, the *Konto anlegen ↗* links next to provider key fields, and the
uploads browser, image picker and Markdown editor of the blog and course editors.

**Still German** (they fall back cleanly – a missing translation shows the German text, never a raw key): every other
page – among them the community, calls and the phone system, accounting, inventory, HR, the AI and video studios,
SaaS/agency and the integrations pages –, the panels other areas render inside the translated pages (e.g. mailbox
and channel settings, the legal panels of an invoice), the guided tours and the *Akademie*, the handbook,
server-rendered public pages (booking pages, forms, funnels, invoice, portal and course member pages), e-mails the
server sends, and the server's own messages apart from the generic ones above. Texts that come from the server as
data stay German as well: the line "Anna hat zugewiesen …" in the inbox timeline, the undo journal's labels, the
names and descriptions in the workflow trigger/action catalogue, the starter templates of the email, form and site
galleries, and default names and starter content the server stores with new records (a new course's first module
and lesson, a report widget's title).

## Choosing the language

- **Signed in:** the language saved at the user – *Einstellungen → Mein Konto → Sprache* or the language button in
  the sidebar's account corner (next to *Darstellung*). It applies on every device.
- **Signed out** (login, setup, the AI app consent screen): the language picked on this device before, else what the
  browser asks for (`Accept-Language`). The login card has a *Deutsch · English* switch; a choice made there is
  saved to the profile with the next sign-in.
- When the browser asks for no supported language, the app is German.

The server side lives in `server/modules/language.ts`:

| Route | Auth | |
| --- | --- | --- |
| `GET /api/language` | public | `{ lang, locales }` – the language `Accept-Language` asks for (weights honoured), German when none matches |
| `GET /api/me/language` | user | `{ lang, auto, locales }` – the saved choice (or `null`) and the `Accept-Language` pick |
| `PUT /api/me/language` | user | `{ lang: "de" \| "en" \| null }` – `null` follows the browser again |

`GET /api/me` carries `user.lang`, so the app starts in the right language without another request. The column
`users.lang` is added by the module's own migration.

## How it works

German is the source language: **the German text in the code is the message id**. A catalog maps it to another
language.

```tsx
import { useT } from '../i18n';

export function Example({ count }: { count: number }) {
  const t = useT('contacts'); // the namespace of this file (web/src/i18n/registry.ts)
  return (
    <>
      <h1>{t('Kontakte')}</h1>
      <p>{t('{n} ausgewählt', { n: count })}</p>
      <p>{t.plural(count, { one: '{n} Kontakt', other: '{n} Kontakte' })}</p>
    </>
  );
}
```

```ts
// web/src/i18n/en/contacts.ts
export default {
  Kontakte: 'Contacts',
  '{n} ausgewählt': '{n} selected',
  '{n} Kontakte': { one: '{n} contact', other: '{n} contacts' },
} satisfies Catalog;
```

- `useT(ns)` in components: re-renders when the language changes and waits (inside the page's Suspense boundary)
  until the namespace's catalog is loaded. `tr(ns)` outside components – helpers, event handlers, toasts – translates
  with the language active at call time.
- Lookup order: the namespace's catalog, then `core`, then the German text. A typo can therefore never show a raw key.
- `{name}` placeholders are filled from the second argument; placeholders without a value and merge tags such as
  `{{contact.first_name}}` stay as they are.
- Plural forms follow `Intl.PluralRules` of the language; `forms.other` is the message id, a catalog may give one
  string or its own forms (`zero`, `one`, `two`, `few`, `many`, `other`).
- Numbers, money and dates: `fmtNumber`, `fmtMoney`, `fmtDate`, `fmtDateTime`, `fmtTime` (and `money`, `amount`, `d`,
  `dt`, `ago` in `api.ts`) use the active language – German stays `de-DE`, English takes the regional variant the
  browser asks for (`en-US`, `en-AU` …) or `en-GB`.
- Each catalog is a chunk of its own, loaded only when the language is in use: German users download no catalog. The
  runtime adds about 1.5 KB gzip to the first download; all English catalogs together are about 24 KB gzip, split by
  area. A language switch loads every namespace on screen first and then re-renders everything at once.
- `<html lang>` follows the language.
- The server keeps answering in German. Where the app shows a server message (toasts, page errors, the login card),
  `serverText()` replaces the common generic ones with the `errors` catalog.

Labels kept in constants (menu entries in `main.tsx`, status maps, tab lists) stay German in the code and are
translated where they are shown, e.g. `t(STATUS_LABEL[s])`. Their German text must then be in the catalog – the
check below treats a catalog entry as the declaration of such a text.

## Translating a page

1. Add the page's files to a namespace in `web/src/i18n/registry.ts` (or create one: an entry in `NAMESPACES` and a
   loader in `CATALOGS.en`). `file.tsx#ComponentA,ComponentB` covers only those components of a file – useful when a
   bigger page only shows a button somewhere else.
2. Wrap every text in `t()` – JSX text, `title`, `placeholder`, `aria-label`, `label`/`hint` props, toast and confirm
   messages, `Error` texts users see.
3. Run `npm run i18n:check -- --todo en`: it lists the texts still missing in the catalog. Translate them in
   `web/src/i18n/en/<namespace>.ts`.
4. Set `complete: true` for the namespace and run `npm run i18n:check` until it is clean. `tests/i18n.test.ts` runs the
   same check, so CI keeps it complete.

Keep German texts short and plain; the English ones too. Do not translate brand names, protocol names or merge tags.

### What `npm run i18n:check` reports

| Rule | Meaning |
| --- | --- |
| `missing` | a `t('…')` text of a namespace declared `complete` has no translation (in its catalog or in `core`) |
| `untranslated` | a German UI text in a file of a complete namespace that is neither wrapped in `t()` nor in a catalog – JSX text, titles, labels, placeholders, toasts, texts with German words or umlauts |
| `placeholders` | a translation uses a `{placeholder}` the German text does not have |
| `unused` | a catalog entry whose German text appears nowhere in its namespace any more (nor as a text the server sends) |
| `registry` | a namespace file is missing, or a catalog file is not registered |

Brand names, units and examples are allowed in `scripts/i18n-check.mjs` (`ALLOW`); a line that is intentionally not
translated (an HTTP header, diagnostics for bug reports) carries the comment `i18n-ignore`.

## Adding a language

Community translations are welcome. To add, say, French:

1. In `web/src/i18n/registry.ts` add `fr: { name: 'Français', intl: 'fr-FR' }` to `LOCALES` and a `fr` block to
   `CATALOGS` with one loader per namespace (`core: () => import('./fr/core')` …). A namespace without a French
   catalog simply stays German.
2. Copy `web/src/i18n/en/` to `web/src/i18n/fr/` and replace the English values. The keys stay German – the English
   file next to it shows what each one means.
3. Add `'fr'` to `UI_LOCALES` in `server/modules/language.ts` so the language can be saved and is picked from
   `Accept-Language`.
4. Run `npm run i18n:check` and `npm test`, take a look at the screens with long words (the sidebar, the settings
   tabs, the inbox bar on a phone) and open a pull request.

The language appears in every switch by itself (each language is named in its own language).
