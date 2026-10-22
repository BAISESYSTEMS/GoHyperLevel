# Knowledge memory (Cognee)

HyperLevel can connect to a **self-hosted [Cognee](https://github.com/topoteretes/cognee) server** (Apache-2.0, written against server version 1.6.2) and use it as a knowledge-graph memory: wiki pages, notes, tickets, course lessons, conversations and contacts of a sub-account become searchable by meaning. People ask it in the app (*Einstellungen → Gedächtnis → „Gedächtnis fragen“*), the in-app HyperLevel Agent and MCP clients such as Claude use it through the tool `ghl_memory_recall`.

It talks to Cognee over its **REST API** (server to server, no MCP). Data governance is the core of the feature:

- **Opt-in per sub-account, default off.** Per data type on top of that; by default only *Wiki & Dokumente* is on once a sub-account switches the memory on.
- **One dataset per sub-account and data type** (`gh_<locationId>_<type>`). HyperLevel never reads or writes a dataset of another sub-account – enforced in code and tested.
- **PII minimisation:** e-mail addresses, phone numbers and IBANs can be redacted before anything is sent (on by default for notes, tickets, conversations and contacts).
- **Erasure:** deleting a contact (GDPR erase) or a record deletes the matching Cognee data items; switching a type or the whole sub-account off offers *„Daten in Cognee löschen“*; deleting a sub-account deletes its datasets.
- **Audit:** every push, search and deletion is written to the audit log – counts, never content.
- **Status panel** with what is shared, item counts, last sync, errors and a prominent warning when the server runs without access control.

> The labels in the app are German; this page is English-first like the rest of the public docs.

## Contents

- [How it fits together](#how-it-fits-together)
- [1. Run Cognee with Docker](#1-run-cognee-with-docker)
- [2. A dedicated Cognee user for HyperLevel](#2-a-dedicated-cognee-user-for-hyperlevel)
- [3. Connect HyperLevel (agency)](#3-connect-hyperlevel-agency)
- [4. Switch it on per sub-account](#4-switch-it-on-per-sub-account)
- [What is sent](#what-is-sent)
- [Governance in detail](#governance-in-detail)
- [Erasure and deletion](#erasure-and-deletion)
- [Syncing](#syncing)
- [Using the memory](#using-the-memory)
- [Endpoints HyperLevel uses](#endpoints-hyperlevel-uses)
- [REST API of HyperLevel](#rest-api-of-hyperlevel)
- [Troubleshooting](#troubleshooting)
- [For developers](#for-developers)

## How it fits together

```
HyperLevel (one sub-account)                                 Cognee server (your own)
  wiki, notes, tickets, ...  --redact-->  add (text)  -->  dataset gh_<locationId>_<type>
         ^   background job, incremental     cognify  -->  knowledge graph + vectors
         |                                   search   <--  passages with their document ids
  ask / agent / MCP  <-- only passages that map to a live record of this sub-account
```

- The agency sets up **one server and one login** (a dedicated Cognee user). Optionally a sub-account gets a **login of its own** – then even Cognee keeps its data apart from the other sub-accounts.
- Each sub-account decides **what it shares** (*Einstellungen → Gedächtnis*). Nothing leaves HyperLevel before that.
- A **background job** (part of the normal scheduler tick, never inside a request) sends changed records, builds the graph and removes what was deleted.

## 1. Run Cognee with Docker

Cognee ships as the image `cognee/cognee`. A minimal, hardened setup next to HyperLevel (same compose project or the same Docker network, so HyperLevel reaches it as `http://cognee:8000`; no port is published to the internet):

```yaml
services:
  cognee:
    image: cognee/cognee:main        # pin a release tag in production
    restart: unless-stopped
    environment:
      LLM_API_KEY: ${COGNEE_LLM_API_KEY}       # the model Cognee builds its graph and answers with
      # -- access control and authentication ------------------------------------------------
      ENABLE_BACKEND_ACCESS_CONTROL: "true"     # REQUIRED: one isolated store per user and dataset, every call needs a login
      FASTAPI_USERS_JWT_SECRET: ${COGNEE_JWT_SECRET}   # openssl rand -hex 32 (otherwise it changes at every restart)
      JWT_LIFETIME_SECONDS: "3600"
      HASH_API_KEY: "true"                      # API keys are stored hashed
      # DEFAULT_USER_PASSWORD:                  # leave unset: no well-known default login
      # -- HyperLevel only ever sends text -------------------------------------------------------
      ACCEPT_LOCAL_FILE_PATH: "false"           # no ingestion of files from the server's disk
      ALLOW_HTTP_REQUESTS: "false"              # no fetching of URLs
      ALLOW_CYPHER_QUERY: "false"
      TELEMETRY_DISABLED: "1"
      CORS_ALLOWED_ORIGINS: "http://localhost:3000"   # HyperLevel calls server to server; browsers need no access
    volumes:
      - cognee_storage:/cognee-storage          # SQLite, LanceDB and the graph live here – back it up
volumes:
  cognee_storage:
```

Then check `docker compose exec cognee curl -s localhost:8000/health` – `{"status":"ready",…}`. The default stores support access control. It needs a supported graph/vector combination – Cognee refuses `ENABLE_BACKEND_ACCESS_CONTROL=true` with an unsupported one (see the note in its `.env.template`), it does not silently switch it off.

**`ENABLE_BACKEND_ACCESS_CONTROL=true` is not optional.** Without it all datasets share one graph and one default user; a search then runs over everything and cannot be scoped to a sub-account. HyperLevel detects this (see [Governance in detail](#governance-in-detail)), warns prominently and, by default, sends nothing.

## 2. A dedicated Cognee user for HyperLevel

Do not use the default user. Register a user for HyperLevel (the register route is part of Cognee's API, `cognee/api/v1/users/routers/get_register_router.py`):

```bash
curl -s -X POST http://cognee:8000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"gohigh@example.com","password":"<a long random password>"}'
# check the login
curl -s -X POST http://cognee:8000/api/v1/auth/login \
  -d 'username=gohigh@example.com' --data-urlencode 'password=<the password>'
```

Instead of a password you can use an **API key** of that user: log in, then `POST /api/v1/auth/api-keys` with `{"name":"gohigh"}` (header `Authorization: Bearer <token>`); HyperLevel sends it as `X-Api-Key`. Passwords and keys are stored sealed in HyperLevel (AES-256-GCM, `npm run rotate-secret` covers them) and never shown again.

Tip: for the strongest separation create one Cognee user per sub-account and enter it under *Agentur → Integrationen → Einrichtung → Wissensgedächtnis → Sub-Accounts im Überblick → Zugang*. The datasets then belong to that user.

## 3. Connect HyperLevel (agency)

*Agentur → Integrationen → Einrichtung → Wissensgedächtnis (Cognee)* (agency admins, signed in – keys cannot change it):

| Field | Meaning |
| --- | --- |
| Adresse | `https://cognee.example.com`, or `http://cognee:8000` inside the Docker network. Plain `http://` is only accepted for addresses inside a network (single-label host names, `.local`, private IPs) – credentials must not travel unencrypted over the internet. |
| Anmeldung | E-mail + password of the Cognee user, or its API key. |
| Internes Netz erlauben | Needed when Cognee runs in the same Docker network or LAN: HyperLevel's outbound guard otherwise refuses private addresses. |
| Sub-Account-Admins dürfen das Gedächtnis selbst einschalten | Off: only the agency switches sub-accounts on. |
| Auch an einen Server ohne Zugriffskontrolle senden | Not recommended (see below). |

**Verbindung testen** runs four steps and says where it fails:

1. *Server erreichbar* – `GET /health`.
2. *Zugriffskontrolle* – does the server ask for a login at all?
3. *Anmeldung* – login (or API key) works, `GET /api/v1/auth/me`.
4. *Datasets lesen* – `GET /api/v1/datasets`, how many of them are HyperLevel's.

The card also lists **all sub-accounts**: what they share, item counts, last sync, errors, which login they use – and lets the agency switch one off or delete its data in Cognee.

Removing the connection is refused while sub-accounts still share data or data is left in Cognee (it could not be deleted afterwards).

## 4. Switch it on per sub-account

*Einstellungen → Gedächtnis* (area *Einstellungen* of the sub-account):

1. Tick **Wissensgedächtnis für diesen Sub-Account einschalten**.
2. Choose the data types. Defaults: only *Wiki & Dokumente*. Personal types are marked.
3. Decide per type whether e-mail addresses, phone numbers and IBANs are redacted.
4. Decide whether members (client logins) may ask.
5. **Speichern.** The first sync starts within seconds; the status panel shows progress.

Switching a type or the sub-account off stops sending at once and offers *„Daten in Cognee löschen“*.

## What is sent

Per record one text document that starts with a header line (`HyperLevel · <Datentyp> · <kind>:<recordId>`), so it can never be read as a file path or URL by Cognee and two records never share one data item. Nothing else (no files, no attachments, no images).

| Data type (label) | Records | What goes into the text | Needed to ask | Redaction default |
| --- | --- | --- | --- | --- |
| Wiki & Dokumente | Wiki pages (not in the trash, not in private spaces `team_access = none`), the *Dokumente* entries of the sub-account | Title, space, page text; document title, kind, source, summary, link without query string | Wiki | off |
| Notizen | Notes on contacts | Contact name, date, note text | Kontakte | on |
| Tickets, Helpdesk & Wissensdatenbank | Tickets (not merged ones) with customer messages, replies and internal notes; published knowledge-base articles | Subject, status, priority, category, contact name, history; article title, category, text | Service | on |
| Kursinhalte | Published lessons of published courses | Course, module and lesson title, lesson text (no videos, no learners) | Kurse | off |
| Gesprächsverläufe (E-Mail/Chat) | Messages of the inbox without drafts, one document per conversation and month | Contact name, channel, subject, direction, time, text (each message cut at 2,000 characters) | Konversationen | on |
| Kontakte (personenbezogen) | Contacts | Name, company, city, country, source, tags, e-mail, phone, custom fields – **never** street address, postal code, date of birth | Kontakte | on |
| Gemerkte Hinweise (manuell) | Notes someone asked to remember (`ghl_memory_remember`, the form) | The note | everybody in the sub-account | off |

Documents are cut at 40,000 characters. **Redaction** replaces e-mail addresses with `[E-Mail]`, phone numbers (international or with a leading 0, 7–15 digits, dates and amounts are left alone) with `[Telefon]` and valid IBANs (ISO 13616 checksum) with `[IBAN]`. It is a safety net, not anonymisation: names and free text stay – hence the warnings on the personal types. Changing the redaction rule re-sends the affected records in their new form and removes the old copies.

## Governance in detail

**Opt-in.** A sub-account that never opted in never causes a request to Cognee (the scheduler only looks at sub-accounts with sharing on, data in Cognee or deletions queued).

**Isolation between sub-accounts** – several layers, all covered by `tests/cognee-unit.test.ts` and `tests/cognee-sync.test.ts`:

- Dataset names are made in exactly one place (`datasetName()` in `server/services/cognee/model.ts`) from the sub-account id; ids that could make two names collide are refused.
- All data access goes through `LocationClient`, bound to one sub-account. A dataset object of another sub-account, a forged name or type, or an id that is no UUID is refused **before a request exists**.
- A dataset id is only used after the server's own list confirms that it carries this sub-account's name for that type (searches, deletes and queued deletions alike).
- Searches always name the dataset ids (never "all readable datasets"); answers are accepted only from those ids. An answer without a dataset id – what a server without access control returns – is dropped.
- Every search result must map to a record that still exists in the same sub-account (and for which the asker has the area); anything else is not shown. This also hides data of an erased record whose deletion in Cognee is still queued.
- Optional **own Cognee login per sub-account**: the datasets then belong to different Cognee users, so Cognee's own access control separates them as well. The login cannot be swapped while data of that sub-account is in Cognee.
- The tenant isolation harness (`tests/tenant-isolation.test.ts`) and the secret-leak test (`tests/secret-leaks.test.ts`) include the module's routes and tables.

**Who may do what**

| Action | Who |
| --- | --- |
| Set up server and login, test, own login per sub-account, remove | Agency admins, signed in (no API/agency key) |
| Switch the memory / data types / redaction, run a sync, delete data in Cognee | Whoever has the area *Einstellungen* of the sub-account (and agency admins), signed in; the agency can forbid sub-account admins to switch on |
| Ask (UI, tool, API) | Everybody in the sub-account if *Mitglieder dürfen fragen* is on – but only about the types whose area they hold (e.g. tickets need *Service*) |
| Remember a note, list and delete notes | Agency admins, keys that may write, members with *Einstellungen* or *Wiki*, and only if *Gemerkte Hinweise* is shared |

**Access control of the server.** Cognee has no endpoint that reports `ENABLE_BACKEND_ACCESS_CONTROL`, so HyperLevel infers it: `GET /api/v1/datasets` **without** credentials answers `401` (login required, the body names the posture) or `200` (the server runs as one default user: access control is off). Searches add a second signal: with access control the answer is a list of `{dataset_id, …}` entries, without it a bare list. The result is stored, refreshed daily and with every test, and shown in the status panel:

- *Zugriffskontrolle an* – fine.
- *Server ohne Anmeldung!* – a red warning in the status panels and the agency card; **HyperLevel sends nothing and refuses searches** until it is fixed (unless the agency ticks *Auch an einen Server ohne Zugriffskontrolle senden*; deletions still go through).
- *nicht geprüft* – could not be told (e.g. the server only requires authentication explicitly); the static hint stays visible: *`ENABLE_BACKEND_ACCESS_CONTROL=true` must be set on the Cognee server.*

**Audit log** (*Agentur → Protokoll*, and the last entries in the status panel). Counts only – never the question, the passages or any record content:

| Action | Written when | Example summary |
| --- | --- | --- |
| `cognee.connection`, `cognee.test`, `cognee.account` | the agency changes or tests the connection | *Verbindung gespeichert (Adresse, Zugang)* |
| `cognee.settings` | opt-ins or redaction change | *Daten freigegeben: Notizen · Schwärzung geändert: Wiki an* |
| `cognee.push` | the sync sent records | *Notizen: 3 neu, 1 geändert, 2 Angaben (E-Mail/Telefon/IBAN) unkenntlich gemacht* |
| `cognee.search` | somebody (or a tool) asked | *Gedächtnis befragt: 2 Treffer in Wiki & Dokumente, mit Antwort* |
| `cognee.delete`, `cognee.erase`, `cognee.purge` | data was deleted in Cognee / queued by a GDPR erase / requested | *4 Einträge einer gelöschten Person in Cognee zur Löschung vorgemerkt* |
| `cognee.remember`, `cognee.forget`, `cognee.sync` | a note was kept or deleted, a sync was started by hand | *Hinweis zum Merken gespeichert (36 Zeichen)* |

## Erasure and deletion

HyperLevel keeps a **mapping table** `cognee_items` (record → Cognee data item) and a **deletion queue** `cognee_deletions` that survives restarts and an unreachable Cognee. Queued deletions are retried with backoff (1, 2, 4 … 60 minutes; after ten failures once a day) and shown in the status panel until they are through.

| Event | What happens in Cognee |
| --- | --- |
| A contact is erased (GDPR erase: `POST /api/contacts/:id/erase`, MCP `ghl_contact_erase`, agency erase by e-mail) | In the **same transaction** as the erase, the data items of everything mapped to that contact (their notes, tickets, conversation documents, contact document) are queued for deletion – even if the type is switched off meanwhile. The Art. 15 export lists the mapping rows. |
| A record is deleted, trashed, made private or unpublished (note, page, ticket, lesson, article, remembered note, contact) | The next sync (and every question, at most every 30 s) finds it and queues its data item. A deleted contact (one or a bulk delete of thousands) starts one cleanup pass right away – the `contact.deleted` events of one bulk delete are coalesced into a single pass and a single sync cycle. |
| A record changes | The new text is added; the **old version is deleted after the next graph build** (so the record never disappears from search in between). |
| A data type or the whole sub-account is switched off | Sending stops. The status panel offers **Daten in Cognee löschen**: the dataset of each type is deleted with everything in it, the mapping and sync position are reset. (Still-shared types cannot be purged.) |
| A sub-account is deleted | A database trigger queues the deletion of its datasets; the queue outlives the rows. |

What erasure **does not** reach: other people's names inside free text of wiki pages or notes, text Cognee's own LLM provider has seen, and Cognee's backups or logs on your server – handle those in your server setup and your data processing agreement with the LLM provider.

## Syncing

- Runs as a normal scheduler job (`app.onTick`, every few seconds), **in the background** – never inside a request and never holding up other jobs. Per sub-account one bounded cycle; the position (cursor per kind of record, phase, errors) lives in the database, so a restart continues where it stopped.
- **Incremental by `updated_at`**: each kind of record is read with an index on (sub-account, changed-at). Text that did not change (a hash of the text that would be sent) costs nothing; a record is sent once per change.
- Per cycle: `add` up to 20 records at a time, then **one `cognify` run in the background** per dataset, polled on the following cycles (a build that takes more than an hour counts as an error).
- **Retries and backoff** per data type: 1, 2, 4 … 60 minutes; a `429` waits at least its `Retry-After`; requests also retry network errors and `502/503/504` twice. A record Cognee refuses (400/409/413/422) is skipped and counted, the rest continues; refused records are tried again on the next full pass.
- **Pacing**: calls to the server are spaced (about 8 per second at most) and sub-accounts are processed one after the other.
- A **full pass** (every record looked at again, unchanged ones skipped) runs weekly and on *Alles neu abgleichen*. It also picks up records that became eligible again without being edited (restored from the trash, space made visible).
- Known limits: internal ticket notes are picked up when the ticket is touched again; a single deleted message changes its conversation-month document at the next change of that month; Cognee's `cognify` costs LLM calls on **your** server – start with the wiki.

## Using the memory

- **Einstellungen → Gedächtnis → Gedächtnis fragen**: a question or keywords; results with type, title (live from HyperLevel), link to the record and a short passage. *Antwort formulieren lassen* adds an answer composed by the model of the Cognee server (costs there; not offered while deletions are open).
- **In-app HyperLevel Agent** and **MCP**: tool `ghl_memory_recall` (`location_id`, `query`, optional `limit` 1–8, optional `types`) – read-only, scoped to the sub-account (a location key can only reach its own), returns at most a few short passages with sources and **at most 4 KB** of JSON in total so it cannot flood the model's context. Its output counts as third-party text for the agent (the same safety rules as for messages and tickets apply: sensitive actions after reading it need a confirmation).
- **`ghl_memory_remember`** (`location_id`, `text` ≤ 4,000 characters) keeps a note – only if *Gemerkte Hinweise* is shared and the caller may write. The note is stored in HyperLevel too (*Einstellungen → Gedächtnis → Gemerkte Hinweise*) and deleting it there deletes it in Cognee.
- At most 30 questions per minute per sub-account.

## Endpoints HyperLevel uses

All against the Cognee 1.6.2 FastAPI app (`cognee/api/client.py`). Responses of the routers that use `OutDTO` are camelCase, the others snake_case (`cognee/api/DTO.py`) – HyperLevel reads both.

| Purpose | Call | Cognee source |
| --- | --- | --- |
| Health | `GET /health` → `{status:"ready", health, version}` | `cognee/api/v1/health/routers/get_health_router.py` |
| Login | `POST /api/v1/auth/login` (form `username`, `password`) → `{access_token}`, JWT bearer, 3600 s by default; HyperLevel logs in again on expiry or `401` | `cognee/api/v1/users/routers/get_auth_router.py`, `cognee/modules/users/authentication/get_client_auth_backend.py` |
| API key | header `X-Api-Key` (instead of the login); keys are created with `POST /api/v1/auth/api-keys` | `cognee/modules/users/authentication/api_key/get_api_key_transport.py`, `cognee/api/v1/api_keys/routers/get_api_key_management_router.py` |
| Who am I | `GET /api/v1/auth/me` | `get_auth_router.py` |
| Access-control probe | `GET /api/v1/datasets` without credentials: `401` (+ "auth posture") or `200` | `cognee/api/client.py` (`GENERIC_401_HELP`), `cognee/modules/users/methods/get_authenticated_user.py` |
| List / create datasets | `GET /api/v1/datasets`, `POST /api/v1/datasets {name}` (returns the existing one of that name) | `cognee/api/v1/datasets/routers/get_datasets_router.py` |
| Add a document | `POST /api/v1/add` multipart: `raw_data` (the text), `datasetId`, `labels`, `external_metadata`, `run_in_background=false` → `data_ingestion_info[].data_id` | `cognee/api/v1/add/routers/get_add_router.py`, `cognee/tasks/ingestion/data_item.py` |
| Build the graph | `POST /api/v1/cognify {datasetIds, runInBackground:true}` | `cognee/api/v1/cognify/routers/get_cognify_router.py` |
| Build status | `GET /api/v1/datasets/status?dataset=<id>&pipeline=cognify_pipeline` → `DATASET_PROCESSING_*` | `get_datasets_router.py` |
| Search | `POST /api/v1/search {searchType: CHUNKS \| GRAPH_COMPLETION, datasetIds, query, topK}` → `[{dataset_id, dataset_name, search_result}]`; `CHUNKS` returns passages without a model call, with `document_id` and `external_metadata` | `cognee/api/v1/search/routers/get_search_router.py`, `cognee/modules/search/methods/search.py` |
| Delete one item | `DELETE /api/v1/datasets/{dataset}/data/{data}` | `get_datasets_router.py` |
| Delete a dataset | `DELETE /api/v1/datasets/{dataset}` | `get_datasets_router.py` |
| Count (fallback id lookup) | `GET /api/v1/datasets/{dataset}/data(/count)` | `get_datasets_router.py` |

Not used on purpose: `/api/v1/forget` with `everything` (would delete all of the user's datasets), local-path and URL ingestion, Cypher search.

## REST API of HyperLevel

| Route | Who | Purpose |
| --- | --- | --- |
| `GET/PUT/DELETE /api/agency/cognee`, `POST …/test` | agency admin (session) | connection (secrets never returned) |
| `GET /api/agency/cognee/overview` | agency admin | all sub-accounts |
| `PUT/DELETE /api/agency/cognee/locations/:id/account`, `POST …/test` | agency admin (session) | own Cognee login of a sub-account |
| `PUT /api/agency/cognee/locations/:id/settings`, `POST …/purge` | agency admin (session) | switch a sub-account off, delete its data in Cognee |
| `GET /api/cognee/info` | everybody in the sub-account | may I ask / remember, which types |
| `GET /api/cognee/recall?q=&limit=&types=&mode=answer&compact=1` | everybody (area rules) | ask the memory |
| `POST /api/cognee/remember`, `GET /api/cognee/memories`, `DELETE /api/cognee/memories/:id` | writers | remembered notes |
| `GET/PUT /api/cognee/admin/settings`, `GET /api/cognee/admin/status`, `POST …/sync`, `POST …/purge` | area *Einstellungen* (session for changes) | opt-ins, status, sync, delete data |

## Troubleshooting

| Message / sign | Cause and fix |
| --- | --- |
| *Cognee ist nicht erreichbar … „Internes Netz erlauben“* | The server is in the Docker network or LAN: tick *Internes Netz erlauben*. |
| *E-Mail oder Passwort bei Cognee stimmen nicht.* | Wrong login; check with the `curl` above. After a Cognee restart without `FASTAPI_USERS_JWT_SECRET` tokens change – HyperLevel logs in again by itself. |
| *Server ohne Anmeldung!* | Set `ENABLE_BACKEND_ACCESS_CONTROL=true` (and restart Cognee), then *Verbindung testen*. |
| *Cognee verweigert den Zugriff – dem Cognee-Nutzer fehlen Rechte auf das Dataset* | The datasets belong to another Cognee user (login changed, or another user created them). Use the user that created them, or delete the data and start again. |
| *Der Wissensgraph konnte … nicht gebaut werden* / *Pipeline run errored* | Cognee's own log: usually the LLM key, model name or budget (`LLM_API_KEY`). HyperLevel retries with backoff. |
| *Cognee hat die Daten abgelehnt (422)* | A record was refused; the status shows *n Einträge abgelehnt*. Check the server log; the record is tried again on the next full pass. |
| *Treffer gehören zu Einträgen, die es nicht mehr gibt* | Deleted records whose removal is still queued – by design not shown. |
| *Cognee hat die Treffer keinem Dataset zugeordnet* | The server returned results without dataset ids (access control off). Fix the server. |
| Nothing is found right after switching on | The first sync and graph build take a while (status: *Wissensgraph wird gebaut*). |

## For developers

- Server: `server/services/cognee/` – `model.ts` (types, dataset names, settings, address rules), `redact.ts`, `client.ts` (REST client, `LocationClient`), `connection.ts` (sealed login, per sub-account override), `sources.ts` (one `KindDef` per kind of record: `next`, `build`, `alive`, `describe`), `sync.ts` (engine, deletion queue, erasure, purge), `recall.ts`, `store.ts`; modules `server/modules/cognee.ts` (tables, routes), `cognee-sync.ts` (scheduler job, GDPR hook, `app.services.cognee`), `cognee-tools.ts` (MCP and agent tools). Add a new kind of record by adding a `KindDef` and, for a new data type, an entry in `CATALOG`.
- Hooks: `app.services.privacyErase` (queues deletions in the erase transaction), `app.services.audit`, `app.services.mcpTools`; the optional `untrusted` flag on an MCP `Tool` makes the agent treat its output as untrusted data.
- Test hooks: `app.services.cogneeFetch` (the HTTP layer), `cogneeSleep`, `cogneeNow` (clock), `cogneeGapMs`. `tests/cognee-fakes.ts` is a fake Cognee server (login with expiring JWT, API keys, datasets per owner, dedup, multipart `add`, search, deletions, failure injection); `tests/cognee-helpers.ts` wires it into a test app.
- Web: `web/src/pages/CogneeAgency.tsx` (agency card), `CogneeSettings.tsx` (tab *Gedächtnis*), `CogneeKit.tsx`, lazy-loaded; Akademie tour `cognee-memory` (`web/src/tour/content/memory.ts`).
- Tests: `tests/cognee-unit.test.ts`, `cognee-sync.test.ts`, `cognee-api.test.ts`, `cognee-bulk.test.ts` (counts the cleanup passes of a 10 000-contact bulk delete), plus the seeded rows in `tests/security-fixtures.ts`.
