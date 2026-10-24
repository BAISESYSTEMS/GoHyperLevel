**English** · [Deutsch](office.de.md)

# Office – documents, spreadsheets, presentations and PDF

The **Office** area (menu *Office*) holds the Office files of a sub-account: Word documents (.docx),
Excel spreadsheets (.xlsx), PowerPoint presentations (.pptx) and PDFs – every file with a gapless version history,
comments, an edit lock and optionally linked to a contact, deal or project. Files are edited
in the browser (with the optional editors, see [Setup](#setup-server)) and by the **HyperLevel Agent** or any
MCP client through five tools.

Without editors and engines the area still works: create, upload, download, upload as a new
version, restore versions, comment – and the agent can read the plain text of documents,
spreadsheets and presentations and create new files with starter text or starter rows.

## Using Office

- **List:** filter *All · Documents · Spreadsheets · Presentations · PDF*, search in the file name; per file the link,
  version, who changed it last, a lock (“Anna is editing”), open comments and who currently has the file
  open (avatars). At the top *Document*, *Spreadsheet*, *Presentation* (create empty) and *Upload* (several files).
- **Open a file:** *Edit* opens the editor in the browser and locks the file for others until you click *Done*
  (or close the window). *Open read-only* shows the file in the editor without locking and without saving.
- **Save:** *Save* in HyperLevel presses the save key in the editor; Ctrl+S (or ⌘S) in the editor does the same.
  Every save is a **new version** – nothing is overwritten.
- **Versions:** every version with number, time, author (“Anna Muster”, “AI agent (on behalf of Anna Muster)” or the
  name of the API key), size and note; *Download* and *Restore* (the old version is saved as a new
  version).
- **Comments** on the file or on a specific version, replies, *Done*; people mentioned with `@First Last`
  and the creator of the file get a push/bell notification (can be turned off under *My account*, type
  “Comments and mentions in Office files”).
- **Edit with AI:** the request (“Replace the price with €4,900 and make the heading bold”) goes with the file ID and
  version to the HyperLevel Agent; it reads the file, changes it with the Office engine and saves a new version.
  Confirmations run in the agent window as always.
- **Details:** contact, deal and project of the file, linking by search and unlinking. *As PDF* (with an engine) creates a PDF
  of the current version as a new file with the same links.

## Collaboration

- **Edit lock (“checked out”):** whoever clicks *Edit* holds the lock; the open editor renews it every
  minute, without renewal it ends by itself after 5 minutes. Others see “Anna is editing – read-only”
  and can open read-only; saving, new versions, deleting and agent changes by others are rejected with 423
  (“Anna Muster is editing the file right now – it is locked until 2:35 pm …”). Admins can take over a lock.
  API keys and MCP connections can't hold a lock.
- **Who is here:** the app's live collaboration ([collaboration.md](collaboration.md)) shows who has which file open
  (page `office/<id>`) – in the list, in the file header and in the sidebar.
- **Conflicts:** anyone saving on an older version gets “Since you opened it there is a newer version … Save as a new
  version anyway?” (409); even then the other version stays in the history.
- **No real-time co-editing:** two people don't type in the same document at the same time – the lock prevents that.

## Setup (server)

The editors (static WebAssembly pages) and engines (command-line programs) are **standalone open-source programs**
(MIT OR Apache-2.0, see [Origin, licenses and trademarks](#origin-licenses-and-trademarks)); they are not part of the repository
and not part of the HyperLevel image. Three ways:

1. **Docker (recommended):** `docker compose -f docker-compose.yml -f deploy/office/docker-compose.office.yml up -d --build`
   builds [deploy/office/Dockerfile](../deploy/office/Dockerfile) on top of the HyperLevel image, downloads the pinned versions,
   checks their SHA-256 sums and sets the paths. The image runs on Debian instead of Alpine (the engines need glibc ≥ 2.35).
2. **Without Docker:** `deploy/office/install.sh --web-dir /opt/office/web --bin-dir /opt/office/bin` (needs curl, unzip, tar,
   sha256sum; Linux x86_64 or aarch64 with glibc ≥ 2.35 for the engines), then set the variables below. HyperLevel reads
   them on every call – no restart needed.
3. **Partially:** only the engines (`--only bin`, for agent editing and PDF export) or only individual kinds (`--kinds docx,pdf`).

| Variable | Meaning |
| --- | --- |
| `PGHL_OFFICE_DIR` | Folder with the editors: one subfolder per kind `docx/`, `xlsx/`, `pptx/`, `pdf/` with the contents of the respective release zip (`index.html` + `.js` + `.wasm`). If it is missing, the area shows “Editor not installed” with this hint. |
| `PGHL_OFFICE_BIN_DIR` | Folder with the engines (`wordcraft-cli`, `gridcraft-cli`, `deckcraft-cli`, `pdfcraft-cli`). If one is missing, editing and PDF export of that kind answer with 503 “Office engine not installed”; reading falls back to plain text. |
| `PGHL_OFFICE_SANDBOX` | `strict` (default): the editor runs in a sandboxed iframe **without** HyperLevel's origin – its code reaches neither cookies nor the API. `same-origin` only if an editor doesn't start without storage of its own (see [Security](#security)). |
| `PGHL_OFFICE_MAX_MB` | Largest file (every version) in MB, default 25. |
| `PGHL_OFFICE_QUOTA_MB` | Storage for all versions of all Office files per sub-account in MB, default 2048 (`0` = no limit); above it requests are rejected with 413. |

Pinned versions and checksums: [deploy/office/versions.env](../deploy/office/versions.env) (as of: documents 0.3.0,
spreadsheets 0.3.0, presentations 0.3.0, PDF 0.4.0, from the `SHA256SUMS.txt` of the releases). The release files:

| Kind | Editor (release asset) | Engine (release asset, containing `bin/<name>-cli`) |
| --- | --- | --- |
| Documents | `wordcraft-web-0.3.0.zip` | `wordcraft-0.3.0-linux-x86_64.tar.gz` / `…-linux-aarch64.tar.gz` |
| Spreadsheets | `gridcraft-web-0.3.0.zip` | `gridcraft-0.3.0-linux-x86_64.tar.gz` / `…-linux-aarch64.tar.gz` |
| Presentations | `deckcraft-web-0.3.0.zip` | `deckcraft-0.3.0-linux-x86_64.tar.gz` / `…-linux-aarch64.tar.gz` |
| PDF | `pdfcraft-web-0.4.0.zip` | `pdfcraft-0.4.0-linux-x86_64.tar.gz` / `…-linux-aarch64.tar.gz` |

The editors are 13–40 MB (WebAssembly); `install.sh` puts `.gz`/`.br` next to them, which HyperLevel serves if the
browser accepts them (about a third of the size). The file names carry a hash and are cached for a year.

## How the editors load and save

The web builds only know file selection, drag & drop and downloads – no interface to hand them a file
or get one back. HyperLevel changes nothing in the upstream code and instead puts a small bridge script in front of the
editor (`/office/bridge.js`, inserted into the editor page with a nonce):

- **Load:** as soon as the editor is running (event `TrunkApplicationStarted`, or its “Loading …” notice disappears),
  HyperLevel sends the bytes of the version via `postMessage`, and the bridge drops them as a synthetic *drag & drop* onto the
  canvas – a real `File` in a `DataTransfer`, exactly what the editor gets when a file is dropped.
  The **PDF editor** has a way of its own: it loads `?file=<address>` itself; for that HyperLevel gives it a signed link
  valid for 10 minutes (`/office/blob/<token>/<name>.pdf`).
- **Save:** the bridge remembers every blob the page makes an object URL from, and intercepts the click on the
  hidden download link the editor creates when saving. A file of its own kind goes to HyperLevel (new
  version) instead of the download folder; anything else (e.g. a PDF export from the document editor) is
  downloaded normally, and HyperLevel offers to also store it in Office.
- **Saving from HyperLevel:** the button presses Ctrl/⌘+S in the editor (spreadsheets: Ctrl/⌘+Shift+S – the spreadsheet editor saves
  a dropped file only through *Save as*). The presentation editor saves in its own format
  (`.deckcraft`); HyperLevel converts it to `.pptx` with the engine (`POST /api/office/files/:id/versions/convert`). Without an engine:
  choose *File → Export → PowerPoint Presentation (.pptx)* in the editor (the editor's menu, which is in English) – the bridge intercepts that as `.pptx`.

Tested with the release builds above in Chromium (software WebGL, sandbox `strict`): all four load the HyperLevel file, and
saving produces a new version each time.

### Limits of the bridge

- It depends on the observable behavior of the builds (dropping onto the canvas, download link with a `download` attribute,
  keyboard shortcuts). If an upstream release changes that, loading or saving can fail – before changing a version in
  `versions.env`, open and save once. If the bridge fails, *Download* / *Upload new version* remain.
- The editor has to be running before the file is dropped; if it starts very slowly (> 10 s), the bridge drops it anyway.
  If the file doesn't appear, click *Done* and then *Edit* again.
- If you save in the editor through *File → Save as* into another format, it ends up as a download.

## AI agent and MCP

Five tools (for the HyperLevel Agent in-process, for Claude, ChatGPT & co. through `/mcp`); they run through the REST routes
below, so with permissions, sub-account binding, lock and log:

| Tool | Does |
| --- | --- |
| `ghl_office_list` (office_list) | List files, filter kind/name/contact/deal/project; shows version and lock |
| `ghl_office_read` (office_read) | Text (spreadsheets as CSV, `range`/`sheet`) and structure as JSON through the engine; without an engine only plain text. The content is third-party text for the agent. |
| `ghl_office_create` (office_create) | New file, empty, with starter text (`text`) or starter rows (`rows`), linked; optionally `commands` right away |
| `ghl_office_edit` (office_edit) | Run engine commands (`commands: [{command, params}]`) or, for spreadsheets, `writes: [{range, values, sheet?}]` on a copy and save as a new version (author: AI agent on behalf of the person); `base_version` protects against overwriting |
| `ghl_office_export_pdf` (office_export_pdf) | PDF of the file as a new file |

The engine commands are those of the upstream programs (documents: over 380 commands such as `select.text`, `format.bold`,
`insert.text`, `insert.table`; spreadsheets: `cell.set`, `range.setValues`, `insert.chart`; presentations: `slide.new` …;
PDF: tools such as `page_rotate`, `comment_add`, `form_fill`). Not allowed are commands that open, save,
export, print or run macros themselves (`file.*` and others; for PDF, only a list of modifying tools) and **any parameter
that names a file, a folder or an address** (`path`, `file`, `url`, `src`, `…Path`, `…Url` etc.) – opening and
saving is handled by HyperLevel. If someone currently has the file checked out, `office_edit` refuses (423 with name and time) –
nothing is merged or queued in the background; the agent says so and tries again later if you want.

The engine runs per call in a temp folder of its own with a copy of the file: started directly (no shell,
arguments as a list), with a minimal environment (no HyperLevel secrets), 60 s time limit, output at most 8 MB,
result at most `PGHL_OFFICE_MAX_MB`; the folder is deleted afterwards, and error messages come without temp paths.

## Security

- **Editor page** `/office/app/<kind>/`: signed in only, its own Content Security Policy – `default-src 'none'`, scripts only
  from the own server with a nonce, `'wasm-unsafe-eval'` for WebAssembly, `connect-src 'self' blob:`, no frames,
  `frame-ancestors 'self'`, no requests to third parties. The build files themselves are public open-source files
  (`/office/app/<kind>/<file>`, only names from a flat folder, no `index.html`, no path going up).
- **Sandbox `strict`** (default): the iframe has `sandbox="allow-scripts allow-downloads"` without `allow-same-origin` – the
  editor code gets an opaque origin and reaches neither HyperLevel's cookies nor the API or the
  parent page. The bridge exchanges messages only with `window.parent` and only with a random channel ID from
  the address; HyperLevel accepts only messages from exactly this iframe. The price: the editors can't store their own
  settings in the browser. `same-origin` adds `allow-same-origin` – then the editor code runs with
  HyperLevel's origin and thus with the permissions of the signed-in person; use only with verified releases (checksums).
- **Uploads** as everywhere: content has to match the type (Office = ZIP, PDF = `%PDF-`), storage name from a random ID and
  the verified type, downloads with `Content-Security-Policy: sandbox`.
- **Permissions:** area `office` (client logins need it); within the sub-account, everyone with the area sees all
  Office files. Every write request is in the log; downloads count as an export.
- **GDPR:** files linked to a contact are part of the access request (Art. 15) and go along when the
  contact is deleted – all versions on disk too, comments and locks as well.
- **Deleting a sub-account and data export:** when a sub-account is deleted (or a cloud customer), all its
  Office files go along – rows, comments, locks and every version under `<data>/office-files/`. The data export of a
  cloud customer contains the tables and all versions (`dateien/office-files/`).

## Limits

- **Alpha software:** the upstream programs are young (versions 0.3/0.4); complex files can look different from
  Microsoft Office. Every version is kept, so a bug costs at most the last change.
- No real-time co-editing (see [Collaboration](#collaboration)), no sharing of individual files with specific
  people, no public links.
- Older formats (.doc, .xls, .ppt) are not accepted; neither are .odt/.ods/.odp (the editors could open them,
  but saving is in the Office Open XML format).
- The engines are glibc programs for Linux x86_64/aarch64 – not for Alpine (musl) or macOS servers.

### Known limits

- **Spreadsheet editor 0.3.0:** the browser build aborts when you edit a cell (“time not implemented on this
  platform” – the engine measures every change with `std::time::Instant`, which doesn't exist in WebAssembly). Opening, viewing
  and saving work, every change in the editor (cell, format) ends it. Workaround until an upstream release with a fix:
  [deploy/office/build-from-source.sh](../deploy/office/build-from-source.sh) `--kind xlsx` builds the editor from source
  with [the patch](../deploy/office/patches/README.md) (Rust + trunk needed), or have cells changed through the agent or the engine
  (the command line isn't affected).
- **Presentations without an engine:** Ctrl+S in the editor saves `.deckcraft`; without an engine please choose *File → Export →
  PowerPoint Presentation (.pptx)* (the editor's menu).

## API

All routes with sign-in or API key and sub-account (`x-location-id`), area `office`:

- `GET /api/office/status` – installed editors and engines, sandbox mode, limits, storage used
- `GET/POST /api/office/files` – list (`?kind=&q=&contact_id=&deal_id=&project_id=&limit=`); create: JSON
  `{kind, name, text?, rows?, contact_id?, deal_id?, project_id?}` (empty/with starter content) or `{name, data}` (Base64) or
  raw with `content-type: application/octet-stream` and `?name=&kind=`
- `GET/PATCH/DELETE /api/office/files/:id` – details with versions (PDF: `editor_file_url`), rename/link, delete
- `GET /api/office/files/:id/download` and `GET /api/office/files/:id/raw` – content (`?version=`), as an attachment or for the editor
- `GET/POST /api/office/files/:id/versions` – versions; new version raw (`?message=&base_version=&force=1`) or JSON
  `{data, message, base_version, force}`
- `POST /api/office/files/:id/versions/convert` – save in the editor format (`?from=deckcraft`), becomes .pptx
- `POST /api/office/files/:id/versions/:version/restore` – restore a version (as a new version)
- `GET/POST/DELETE /api/office/files/:id/lock` – read the lock, take/renew it (`{take_over: true}` for admins), release it
- `GET/POST /api/office/files/:id/comments`, `PATCH/DELETE /api/office/files/:id/comments/:cid` – comments
  (`{body, version?, parent_id?}`, `{resolved}`), `GET /api/office/people` – people for @mentions
- `GET /api/office/files/:id/read` – text/structure (`?mode=both|text|structure&version=&range=&sheet=`)
- `POST /api/office/files/:id/edit` – `{commands?, writes?, message?, base_version?}`
- `POST /api/office/files/:id/export-pdf` – `{name?}`, creates a new PDF

Without sub-account binding: `/office/app/<kind>/` (editor page), `/office/app/<kind>/<file>` (build files),
`/office/bridge.js`, `/office/blob/<token>/<name>` (signed PDF link).

## Origin, licenses and trademarks

The editors and engines come from four open-source projects of one upstream team (each MIT OR Apache-2.0); which ones, in
which version and with which license text is in [deploy/office/THIRD-PARTY.md](../deploy/office/THIRD-PARTY.md). Their
names and logos are trademarks of their team and not covered by the licenses – HyperLevel therefore calls the areas neutrally
*Documents*, *Spreadsheets*, *Presentations* and *PDF* and uses no upstream logos. The unmodified editor inside the frame
may show its own name.

## For developers

`server/modules/office.ts` (tables, files, versions, content, editor routes, `contactFiles`, push kind `office`),
`office-collab.ts` (lock, comments, people), `office-tools.ts` (reading/editing/PDF/converting through the engine, the
five MCP tools); logic in `server/services/office-model.ts` (pure: kinds, names, command check, lock),
`office-store.ts` (bytes on disk under `<data>/office-files/`, limits, versions – a trigger forbids any
change to `office_versions`), `office-engine.ts` (adapter to the command-line programs), `office-blank.ts` (empty
files, text without an engine), `office-bridge.ts` + `office-bridge-js.ts` (editor page, CSP, bridge, signed links).
Interface: `web/src/pages/Office.tsx`, `OfficeFile.tsx`, `OfficeEditor.tsx`, `OfficeParts.tsx` (own chunk,
i18n area `office`). Tests: `tests/office.test.ts`, `tests/office-engine.test.ts` with engine mocks from
`tests/office-fakes.ts` (no real programs in CI).
