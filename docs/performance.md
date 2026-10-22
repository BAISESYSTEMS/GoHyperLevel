# Performance and sizing

What makes HyperLevel fast, how we measure it, what a server needs, and the rules new modules follow so the
numbers stay where they are. Everything below was measured on one small VM-class machine with a single
Node process (the app is single-threaded) – your numbers will differ, the ratios will not.

- [Results](#results)
- [What changed](#what-changed)
- [Operating: monitoring and settings](#operating-monitoring-and-settings)
- [Sizing guide](#sizing-guide)
- [Measuring yourself](#measuring-yourself)
- [Rules for modules](#rules-for-modules)
- [Limits and what is left](#limits-and-what-is-left)

## Results

### Page load (headless Chromium, throttled 4G)

1.6 Mbit/s down, 150 ms round trip, median of 3 runs, `scripts/perf-browser.mjs`. "Before" is 0.0.22 as it was
deployed (one 1.8 MB script, not compressed); "after" is this release. Same server, same data (50 sub-accounts,
100k contacts), service worker blocked so every byte is counted.

| Page | First paint (FCP) | Largest paint (LCP) | Content visible | Transferred |
|---|--:|--:|--:|--:|
| Login, cold cache | 10 048 → **1 200 ms** | 10 048 → **1 200 ms** | 10 585 → **1 539 ms** | 1 935 → **126 KB** |
| Login, second visit | 488 → 452 ms | 488 → 452 ms | 1 084 → 1 061 ms | 5.6 → 4.3 KB |
| Dashboard, cold cache | 10 420 → **1 400 ms** | 12 692 → **1 592 ms** | 13 074 → **2 023 ms** | 2 004 → **131 KB** |
| Dashboard, second visit | 860 → 684 ms | 3 260 → **852 ms** | 3 560 → **1 049 ms** | 75 → 10 KB |

With the CPU also 4x slower (a mid-range phone) the second visit of the login page went from 4.8 s to 0.8 s
(parsing 1.8 MB of script is what hurt) and the cold dashboard from 16.7 s to 2.0 s LCP.

The first download (shell + login + dashboard) is about **140 KB of gzip JavaScript** (about 120 KB as brotli) plus
37 KB of CSS (measured with 0.0.40; it was 114 KB when this page was first written) – the target was 250 KB. Every other page, the funnel/e-mail editors, the tours, the agent panel, the canvas
and the browser phone are separate chunks, loaded when they are opened (hover and idle preloading hide most
of the wait).

### Server (50 sub-accounts, 100k contacts, 20k deals, 200k messages, 50k tasks, 5k invoices)

`scripts/perf-bench.mjs`, Node `http` with keep-alive, requests against the biggest sub-account (7 900
contacts). p95 in milliseconds at 10 parallel clients; "before" is the untouched 0.0.22 on the same data.
**Goal: p95 under 200 ms at 10 clients – before, 20 of 27 endpoints were above it; now none is (exports
excluded).**

| Endpoint | before p50, 1 client | before p95, 10 | after p50, 1 | **after p95, 10** | after p95, 50 | no read cache, p95 10 |
|---|--:|--:|--:|--:|--:|--:|
| `/api/dashboard` | 66 | 918 | 0.7 | **5.8** | 29 | 79 |
| `/api/contacts` (list) | 1.7 | 22 | 2.0 | **26** | 76 | 29 |
| `/api/contacts?q=` (search) | 19 | 332 | 11 | **185** | – | 207 |
| `/api/contacts?tag=` | 16 | 864 | 8.4 | **156** | – | 154 |
| `/api/conversations` | 11 | 200 | 2.3 | **33** | 111 | 35 |
| `/api/opportunities` (board, 1 500 deals) | 18 | 374 | 12 | **118** | 506 | 420 |
| `/api/tasks` | 15 | 1 145 | 4.7 | **81** | 975 | 101 |
| `/api/invoices` | 11 | 154 | 4.6 | **37** | 151 | 197 |
| `/api/project` | 49 | 884 | 2.1 | **31** | 108 | 42 |
| `/api/agency/projects` | 2 262 | 13 872 | 1.0 | **14** | 64 | 324 |
| `/api/agency/overview` | 2 411 | 7 320 | 0.9 | **14** | 49 | 260 |
| `/api/agency/contacts` | 187 | 4 866 | 4.0 | **73** | 283 | 67 |
| `/api/agency/opportunities` | 74 | 910 | 11 | **120** | 388 | 288 |
| `/api/agency/tasks` | 57 | 1 246 | 6.6 | **74** | 386 | 118 |
| `/api/mobile/summary` | 76 | 864 | 0.3 | **4.8** | 20 | 232 |
| `/api/mobile/inbox` | 49 | 843 | 0.7 | **9.9** | 30 | 64 |
| `/api/mobile/deals` | 47 | 850 | 1.2 | **16** | 79 | 273 |
| `/api/mobile/projects` | 478 | 7 849 | 0.8 | **11** | 48 | 162 |
| `/api/reports/dashboards/:id/data` | 51 | 1 348 | 0.9 | **13** | 47 | 496 |
| `/api/contacts/export.csv` (8k rows) | 99 | 1 058 | 79 | 1 151 | – | 976 |

The full table (28 endpoints, requests per second, p99) is written by `npm run perf:bench -- --json out.json`.
Reading it:

- **Read cache on (default) vs off.** Dashboards, the agency screens, the mobile counters and several lists are
  cached until the next write to the database (see [rules](#rules-for-modules)). The last column
  (`PGHL_RESULT_CACHE=0`) is the cost when every request recomputes – what you get right after each write.
  Most of the win comes from the indexes and from reading all sub-accounts with one grouped query instead of
  nine per sub-account (`/api/agency/projects`: 2.3 s → 15 ms uncached); the cache is on top.
- **50 clients on one core** simply queue: p50 is about 50 x the service time, and a few connections starve for
  seconds (look at p50 and requests per second there, not at p95/p99).
- **Exports** (`.csv`) are streamed in pages of 1 000 rows with a pause between pages, so they no longer stall
  other requests; their own latency is what it is.
- Event loop: the p99 of the lag during these runs, 50 parallel clients included, is 70–130 ms (shown under
  *Agentur → System*); before, two background jobs alone blocked the loop for about 200 ms every tick (company
  catch-up 130 ms, health scores 60–90 ms).

Cost of the speed: the 26 new indexes add about 28 % to the file size (168 → 216 MB for this data set) and about
20 % to bulk-insert time (seeding 9.6 → 11.4 s).

## What changed

**Static files and the wire.** Hashed files under `/assets/` are `public, max-age=31536000, immutable`; the page
(`/app`, `index.html`) is `no-cache` with a weak `ETag`/`Last-Modified` and answers `304`. `npm run build` writes
`.br` and `.gz` next to every text file (`scripts/precompress.mjs`); the server picks by `Accept-Encoding`
and sets `Vary`. Everything else text-like over 1 KB – JSON from the API, server-rendered pages – is
compressed on the fly (brotli level 4 or gzip 6, a few hundred microseconds); streams (SSE), ranges,
bodies a module already encoded and our own MCP relay are left alone. Security headers are unchanged.
The `no-store` that header checks used to see on `/assets/*` came from `HEAD` requests: the static handler only
knew `GET`, so `HEAD` fell through to the JSON 404 (`cache-control: no-store`). `GET` and `HEAD` now share one
handler; a missing hashed file is a real 404 (an open tab of the previous build gets "chunk gone" and reloads once
instead of receiving `index.html` as a script).

**Code splitting** (`web/src/lazy.tsx`, `vite.config.ts`). Every page is a chunk (`lazyPages`), shown inside a
`Suspense` skeleton; hovering a menu entry preloads its chunk, and the most used pages are preloaded 6 s after load, when
the browser is idle (skipped on save-data and 2G). Vendor chunks: `react`, `icons`; the app shell (`app`),
`email-builder`, `charts`, `workflow-builder` (the tools the workflow list and the visual canvas share, so the lazy canvas chunk never imports the workflow page's chunk) and the tour engine are separate. The agent panel, help button, feedback button, tour
layer and browser phone mount 2.5 s after the page, so they never compete with the data the user is waiting for.
The tour engine waits while a page skeleton is on screen, so `data-tour` targets on lazy pages keep working. A chunk
that fails to load after a deploy reloads the page once. The service worker still caches `/assets/*` cache-first, but
only files that are what their name says (status 200, never an HTML page for a script; a 404 after a deploy is passed
through and never cached) and it serves the offline shell only when every file the shell names is cached. Chunks you
have not opened yet are not available offline. `build.target` is `chrome92, edge92, firefox90, safari15` (the Android
app's WebView minimum): the output is byte-identical to Vite's default for JavaScript (+32 bytes of CSS), and syntax a
future change adds is lowered instead of leaving older WebViews with a blank page.

**SQLite.** `synchronous=NORMAL` (safe with WAL: a power cut can lose the last commits, never the file),
`temp_store=MEMORY`, `cache_size` 32 MB, `mmap_size` 256 MB, prepared statements cached per SQL text,
`PRAGMA optimize` after the migrations (so new indexes are chosen correctly from the first request) and every
six hours. Indexes live in `server/modules/perf-indexes.ts`. Aggregates for all sub-accounts are one grouped query
per table (`server/services/location-stats.ts`).

**Background jobs** (`app.onTick`). Jobs run one after the other with a pause between them; the two heavy ones
(company catch-up, health scores) work in slices of about 40 ms (`sliceTimer`) and no longer scan the whole
contact table every tick; the daily backup (`VACUUM INTO`, 0.6 s for 170 MB) runs in a worker thread.

**Visibility.** *Agentur → System* and `GET /api/admin/metrics` (admin only): event-loop lag, memory, slowest
routes, slow requests, job times, SQLite settings, row counts. Slow requests (over 300 ms) are logged with the
route pattern – never with ids, query strings or bodies; slow queries (over 50 ms, opt-in) as a normalised
fingerprint with all literals replaced by `?`.

## Operating: monitoring and settings

| Setting | Default | Meaning |
|---|---|---|
| `PGHL_SLOW_REQUEST_MS` | `300` | Requests slower than this are logged (`[slow] 412 ms GET /api/x/:id → 200`) and listed under *System*. `0` = off |
| `PGHL_SLOW_QUERY_MS` | off | e.g. `50`: times every SQL statement, logs the slow ones as `[slow-sql] 83 ms SELECT … WHERE x = ?`. Costs a few percent – for investigating |
| `PGHL_SQLITE_CACHE_MB` | `32` | SQLite page cache per process |
| `PGHL_SQLITE_MMAP_MB` | `256` | Memory-mapped part of the database file; set to the size of your database (or `0` to turn off, e.g. on network disks) |
| `PGHL_RESULT_CACHE` | on | `0` turns the read cache off |
| `PGHL_BACKUPS`, `PGHL_BACKUP_KEEP` | on, `14` | Daily backup; each copy is as big as the database |

Reading *Agentur → System*: an event-loop lag p99 above 50 ms means something blocks the process (look at the job
table and the slowest routes); sustained utilisation near 100 % means the machine is the limit; "Langsam" counts
requests over the threshold per route.

## Sizing guide

HyperLevel is one Node process with one SQLite file: it uses one core for requests, so a faster core helps more than
more cores, and you scale **up**, not out. What we saw with the data set above (200 MB database):

| Load | Fits on | Notes |
|---|---|---|
| a few users, up to ~20 sub-accounts, 50k contacts | 1 vCPU, 1 GB RAM | the default settings |
| 50 sub-accounts, 100k contacts, 1M rows in total (our test set) | 1–2 vCPU, 2 GB RAM | idle RSS ~0.4–0.7 GB; up to ~1.1 GB under 50 parallel heavy requests (memory-mapped database pages count) |
| ~500k contacts or 5M rows | 2–4 fast vCPU, 4–8 GB RAM, SSD | `PGHL_SQLITE_MMAP_MB` at database size, `PGHL_SQLITE_CACHE_MB=128` |

Rules of thumb:

- **RAM:** database size + 0.5 GB. Reads are fast while the file is in memory (page cache / `mmap`); on a cold or
  small-RAM machine the first requests after a restart are slower.
- **Disk:** SSD. Plan for the database x (1 + `PGHL_BACKUP_KEEP`) for backups, plus the WAL file (usually a few
  MB, more during big imports).
- **Throughput per core:** about 1 000–4 000 simple reads per second, 100–600 for list endpoints that return
  50–500 rows, 50–100 for the heavy ones when nothing is cached. A user clicking around causes a few requests per
  second, so one core serves tens of busy users.
- **Contact search** is a substring scan of one sub-account: about 1.3 ms per 1 000 contacts. Fine up to ~50k
  contacts in one sub-account; beyond that expect search-as-you-type to take 60 ms and more. The total count shown
  with a filter costs the same again.
- **Imports and the write cost of indexes:** a 100k-contact import takes seconds to a minute; indexes make bulk
  inserts about 20 % slower (still thousands of rows per second).
- **First start after upgrading** builds the new indexes and statistics: seconds for hundreds of thousands of rows.
- **Behind a proxy** (Caddy/Traefik/nginx) let the proxy terminate TLS and HTTP/2; the app already sends
  compressed answers, so don't compress twice (a proxy that re-compresses should skip `content-encoding` answers –
  the default for all of them).
- Do not put the data folder on a network share (SQLite needs working file locks); if you must, set
  `PGHL_SQLITE_MMAP_MB=0`.

## Measuring yourself

```bash
npm run build
npm run perf:seed -- --data-dir ./perf-data          # 50 sub-accounts, 100k contacts … (fictional, ~15 s, 220 MB)
PGHL_DATA_DIR=./perf-data npm start                  # another terminal (login perf@example.test / perf-pass-123)

npm run perf:bench -- --url http://127.0.0.1:4700    # 28 endpoints at 1 / 10 / 50 clients: req/s, p50/p95/p99
npm run perf:bench -- --concurrency 10 --budget-ms 200   # exit code 1 if a p95 is over the budget
PGHL_RESULT_CACHE=0 npm start                        # …and the same without the read cache

node scripts/perf-browser.mjs --url http://127.0.0.1:4700 --runs 3 [--cpu 4]   # FCP/LCP/bytes, login + dashboard
```

`perf:seed --scale 0.1` builds a tenth of everything. The browser check needs Playwright with Chromium
(`npx playwright install chromium`, or `PLAYWRIGHT_MODULE` / `PGHL_CHROME`); nothing is added to the project.
The tests `tests/bundle-budget.test.ts` (first download under 160 KB gzip, no page code up front, every lazy route
resolves), `tests/performance.test.ts` (cache and compression headers), `tests/perf.test.ts` (PRAGMAs, metrics,
slow logs) and `tests/perf-queries.test.ts` (the fast queries return what the plain ones did, indexes are used)
run with `npm test`.

## Rules for modules

1. **No query per sub-account or per row inside a request.** Group (`GROUP BY location_id`) or merge per-sub-account
   top-N queries; see `location-stats.ts` and the mobile inbox.
2. **Every `WHERE`/`ORDER BY` you add on a big table needs an index** – add it in your module's own migration
   (`CREATE INDEX IF NOT EXISTS …`, new migration name, never edit a shipped one). Check with
   `EXPLAIN QUERY PLAN`: `SCAN <table>` without `USING … INDEX` on contacts/messages/tasks/activities is a bug.
   `tests/perf-queries.test.ts` shows how.
3. **Read-only lists and aggregates** go through `cached(app, ctx, 10_000, () => …)` (`server/core/cache.ts`) or
   `app.db.memo(key, ttl, fn)`: served from memory until the next database write or the ttl. Never for handlers that
   write; the returned value is shared, so don't mutate it afterwards.
4. **Background jobs** (`app.onTick`) must not hold the loop longer than ~50 ms: process in batches from a cursor,
   `await sliceTimer(40)()` between items, and never scan a whole table per tick. A single long statement
   (`VACUUM`, a huge `UPDATE`) belongs in a worker thread or must be split.
5. **Big answers** (exports, long lists) are streamed or paged; return a `Readable` in a `RawResult` and wrap it in
   `gzipStream()` for text.
6. **Pages and the first download.** New pages are added with `lazyPages(() => import('./pages/X'), 'X')` in
   `main.tsx` (and in `ROUTE_PAGES` for preloading) – never an eager import. A small helper that several pages
   need goes in its own module (`web/src/tags.ts`), not into a page file: importing from a page loads that page and
   everything it imports.

## Limits and what is left

- Pages that import widgets of other pages (contacts, conversations, calendars, forms, workflows, settings) pull
  those pages' chunks in with them: a first visit to *Contacts* downloads about 120 KB gzip more, *Workflows* about
  220 KB. Idle preloading hides this for the common pages; turning the widgets into lazy components would cut it.
- Substring search and tag filters scan the sub-account's contacts (see the sizing guide); a full-text index or a
  tag table would make them constant-time.
- The agency screens count 100k contacts with an index scan (7 ms). They are cached until the next write, so a
  busy installation recomputes them after every write.
- The service worker keeps every `/assets/*` file it has seen until its cache version changes (`VERSION` in `web/public/sw.js`, bumped when the worker's rules change); old builds are not pruned in between.
- One process: SQLite and the in-process event bus mean no horizontal scaling.
