# Contributing to HyperLevel

Thanks for helping build the open-source alternative to GoHighLevel and HubSpot! Bug reports, connector
requests, docs, translations of the docs and code are all welcome. Please read the
[Code of Conduct](CODE_OF_CONDUCT.md) first, and report security problems privately ([SECURITY.md](SECURITY.md)).

- [Development setup](#development-setup)
- [Tests and checks](#tests-and-checks)
- [Architecture: modules and registries](#architecture-modules-and-registries)
- [Adding a module](#adding-a-module)
- [Adding a connector (integration)](#adding-a-connector-integration)
- [UI conventions](#ui-conventions)
- [Commits and pull requests](#commits-and-pull-requests)
- [Questions and support](#questions-and-support)
- [Licensing of contributions (CLA)](#licensing-of-contributions-cla)

## Development setup

Requirements: **Node.js 22.13+** (SQLite is built in – no database server) and npm. Docker is optional.

```bash
git clone https://github.com/BAISESYSTEMS/GoHyperLevel.git hyperlevel && cd hyperlevel
npm ci
npm run dev          # API on :4700 (restarts on change) + Vite on :5173 with hot reload
```

Open http://localhost:5173/app and create the first admin on the setup page. Data lives in `./data`
(delete the folder to start over). Want something to click through? Fill a separate folder with fictional
demo data and point the server at it:

```bash
npm run demo:seed -- --data-dir ./demo-data
PGHL_DATA_DIR=./demo-data npm run dev:api     # login: demo@example.com / demo1234
```

Production-like run: `npm run build && npm start` (serves the built UI from `dist-web/` on :4700).

The Android app (`android/`) is a separate Gradle project – see [android/README.md](android/README.md)
(JDK 21, Android SDK 36: `./gradlew assembleDebug testDebugUnitTest`).

## Tests and checks

Every pull request must keep these green (CI runs them on Node 22):

```bash
npm run typecheck    # server, web and scripts
npm test             # vitest: unit + end-to-end API tests against a real in-memory app
npm run build        # Vite bundle + server compile + minified browser scripts of the public forms
npm run licenses     # no dependency with a license incompatible with the AGPL-3.0
npm run oss:check    # no secrets, public IPs or forbidden files in the tracked tree
npm run docs:check   # documentation: links and anchors, orphan pages, PGHL_* variables, leftovers
```

Tests live in `tests/`. `tests/helpers.ts` starts a fresh app per test file
(`const t = await startTestApp(); await t.setup();`) and gives you `t.api.get/post/patch/put/del/raw`.
External APIs are never called: stub `globalThis.fetch` in the test or use the module's test hook
(`app.services.*Fetch` / `*Factory`, see the existing tests). New behaviour needs tests – especially
signature checks, parsing, permissions and state changes.

"Today", "this week", due dates and birthdays are the sub-account's (default Europe/Berlin), never the UTC date: in a test build
them with `berlinDay()` from `tests/helpers.ts`, not with `new Date().toISOString().slice(0, 10)`, and pin the clock with
`pinClock('2026-06-15T22:30:00Z')` (and `unpinClock()` afterwards) (00:30 the next day in Berlin) when the time of day matters
(`tests/day-boundary.test.ts`). `PGHL_TEST_NOW=2026-06-15T22:30:00Z npx vitest run tests/mobile.test.ts` runs any file at a
fixed instant.

Documentation is checked like code (`tests/docs.test.ts`, the same rules as `npm run docs:check`): every relative link and
`#anchor` must resolve, every `docs/*.md` page must be linked from the README, every `PGHL_*` variable the server reads
goes into `.env.example` **and** `docs/self-hosting.md`, every workflow action/trigger type into the lists at the end of
`docs/workflow-actions.md` (`npm run docs:gen` adds the missing rows and regenerates `docs/handbuch.md`), every route family
under `/api/` is named in some page, README numbers (MCP tools, triggers, actions, tours) must not promise more than
exists, and `CHANGELOG.md` has one `### Added` / `### Changed` / `### Fixed` heading per version. The other direction is
`tests/api-contract.test.ts`: every `METHOD /api/…` a page names, every `api.get/post/…('/api/…')` of the web app and every
endpoint of the Android app (`GoHighApi.kt`) must be a route with that method. Pages written in German
stay German; the READMEs and `docs/deploy/` are English first (`README.de.md` is the German twin).

For visual changes, attach a screenshot (light and dark mode, and a narrow mobile width) to the PR.
`npm run screenshots` renders the README screenshots from a seeded demo with headless Chromium.
`node scripts/qa-smoke.mjs` (after `npm run build`) checks what only a real layout engine can tell – dialog ✕ size and focus trap, a drawer
that fits the screen, a public invoice that fits a phone – against a seeded demo.

## Architecture: modules and registries

```
server/
  core/        HTTP router, auth, DB (node:sqlite), event bus, templates, time zones, public pages
  services/    Logic several modules share: contacts, sending (e-mail/SMS), opportunities, workflow engine …
  modules/     One module per feature: its own tables (migrations) and routes (register)
  modules/index.ts   The registry – every module is listed here
web/src/       React UI, one file per area under pages/
tests/         vitest
android/       Native Android app (Kotlin, Jetpack Compose + Glance widgets)
integrations/  Ready-made Zapier, Make and n8n connectors
```

The rules that keep the code base mergeable:

1. **A feature is a module of its own.** New tables and routes go into a new file under
   `server/modules/` (plus a page under `web/src/pages/`) – not into `core/`, `core.ts` or another
   feature's file. Edits to shared files (`modules/index.ts`, `core/permissions.ts`, the NAV in
   `web/src/main.tsx`, `styles.css`) stay small and additive.
2. **Modules talk through `app.services`, not imports.** A module exposes hooks
   (`app.services.workflowActions`, `mcpTools`, `reportSources`, `catalogExtra`, `contactFilters`,
   `messageChannels`, `cspExtra` …) and consumes others' hooks if present – if a module is missing, the core
   keeps working without that feature. The full list is in [docs/architecture.md](docs/architecture.md).
3. **Migrations are append-only.** Never rename or edit a shipped migration; add a new one.
4. **Every route declares its auth** (`public`, `user`, `admin`, `location`) and every `location` query
   filters by `ctx.locationId`. Map new route prefixes to a permission area in
   `server/core/permissions.ts` – the same map drives client-login rights and SaaS plan gating.
5. **Events, not direct calls, for automation.** `app.events.emit(locationId, 'thing.happened',
   { contactId, … })` feeds workflows, webhooks and REST hooks.
6. **Secrets never reach the browser.** Store credentials sealed (`sealSecret`/`openSecret`), return them
   masked, and use `safeFetch` (`server/services/net.ts`) with timeouts for user-supplied URLs.
7. **Public endpoints validate everything** (signatures for webhooks, size limits, rate limits).

## Adding a module

```ts
// server/modules/memberships.ts
import type { Module } from '../core/app.js';
import { bad, str } from '../core/http.js';
import { id, now } from '../core/util.js';

export const membershipsModule: Module = {
  name: 'memberships',
  migrations: [['001-init', `CREATE TABLE memberships (
    id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    name TEXT NOT NULL, created_at TEXT NOT NULL)`]],
  register(app) {
    app.router.get('/api/memberships', 'location', (ctx) =>
      app.db.all('SELECT * FROM memberships WHERE location_id = ? ORDER BY created_at DESC', ctx.locationId));
    app.router.post('/api/memberships', 'location', (ctx) => {
      const row = { id: id(), location_id: ctx.locationId, name: str(ctx.body.name, 'Name', { required: true }), created_at: now() };
      app.db.insert('memberships', row);
      app.events.emit(ctx.locationId, 'membership.created', { membership: row });
      return row;
    });
    // Optional: an MCP tool, a workflow action, a report source …
    app.services.mcpTools = [...(app.services.mcpTools ?? []), /* { name: 'ghl_list_memberships', … } */];
  },
};
```

Then: register it in `server/modules/index.ts` (near the end, before `mcpModule`), map `/api/memberships`
in `server/core/permissions.ts`, add `tests/memberships.test.ts`, a page in `web/src/pages/` with an
entry in the NAV, and document it (README feature list + a page under `docs/`).

## Adding a connector (integration)

Connectors to outside services follow the same module pattern:

- **Settings & credentials:** per sub-account in the location settings or a table of the module, agency-wide
  in `agency_settings`. Seal secrets, never return them, offer a "Verbindung testen" endpoint.
- **Outbound calls:** a small client in `server/services/<name>.ts` with timeouts and readable German error
  messages; a test hook (`app.services.<name>Fetch`) so tests can fake the API.
- **Inbound webhooks:** a `public` route under `/hooks/<name>/…` that verifies the provider's signature
  before doing anything.
- **Catalogue entry:** add it to the integrations catalogue with a live status probe:

```ts
app.services.catalogExtra = [
  ...(app.services.catalogExtra ?? []),
  {
    entry: { key: 'acme', name: 'Acme CRM', category: 'Produktivität', icon: 'apps', scope: 'location',
             setup: { location: 'settings' }, description: '…', credentials: 'API-Schlüssel unter …', docs: 'docs/acme.md' },
    location: async (ctx, locationId) => ({ status: 'ok', detail: 'Verbunden' }),
  },
];
```

- **Automation:** expose actions as workflow steps (`app.services.workflowActions`, labels in
  `web/src/pages/Workflows.tsx`), new events as triggers (`app.services.workflowTriggers`), and the most
  useful operations as MCP tools.

Not sure whether a connector fits? Open a [connector request](https://github.com/BAISESYSTEMS/GoHyperLevel/issues/new?template=connector_request.yml) first.

## UI conventions

- The UI is **German** for now (plain, short sentences; server errors via `bad('…')` in German). Public docs
  and code comments are English. Please don't start translating the UI piecemeal – i18n will come as one
  coordinated change.
- Use the building blocks in `web/src/ui.tsx` (`Modal`, `Field`, `Input`, `Select`, `Tabs`, `Badge`, `Empty`,
  `PageHead`, `useLoad`, `act`) and icons from `web/src/icons.tsx`. Colours come from the CSS tokens in
  `styles.css` so dark mode works automatically; append new CSS at the end.
- Every modal has a ✕ in the top-right corner and closes on Esc.
- New screens get `data-tour="…"` attributes on their main elements (the in-app academy builds tours on
  them; `tests/academy.test.ts` checks that tour targets exist).

## Commits and pull requests

- Branch from `main`, keep PRs focused (one feature or fix), rebase on `main` before review.
- Commit messages: imperative summary of ≤ 72 characters, optionally prefixed with the area
  (`Calendars: respect buffer after last slot`, `Docs: Coolify guide`), a blank line, then *why* the change
  is needed. Reference issues with `Fixes #123`.
- Update `CHANGELOG.md` under `## [Unreleased]` for user-visible changes (one `### Added`, `### Changed` or `### Fixed`
  heading each – add to it, never repeat it), and `README.md`/`README.de.md`/`docs/` when you change how people install,
  configure or use HyperLevel.
- Fill in the pull request template; CI must be green before review.

## Questions and support

- **Questions, ideas and setup help go to [GitHub Discussions](https://github.com/BAISESYSTEMS/GoHyperLevel/discussions)**, not
  to issues. Issues are for reproducible bugs, feature requests and connector requests (the templates ask for what is needed).
- HyperLevel is maintained on a best-effort basis: there is **no guarantee of support, response times or that a pull
  request gets merged**. Small, focused PRs with tests have the best chance. Commercial help: see the
  [partner program](docs/partner-program.md).

## Licensing of contributions (CLA)

HyperLevel is licensed under the [GNU AGPL-3.0](LICENSE). Before your first pull request can be merged, you sign the
[Contributor License Agreement](CLA.md) once: the CLA Assistant comments on the PR, and you reply with
*"I have read the CLA Document and I hereby sign the CLA"* (signatures are stored in this repository, branch
`cla-signatures`). You keep the copyright; the CLA lets the maintainer also offer the project under other licences
(dual licensing) and confirms that you have the right to submit the work. Comment `recheck` if the check does not update.
Only add dependencies whose license is compatible with the AGPL-3.0 – `npm run licenses` checks this.
