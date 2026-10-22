# Canvas – infinite boards for drawing, planning and design

The Canvas is HyperLevel's whiteboard and design surface: an infinite board per sub-account where people
**and AI agents** draw together – mind maps, flowcharts, customer journeys, wireframes, social-post
layouts – next to **live cards from the CRM** (contacts, deals, tickets, reports, whole pipelines).
Think Excalidraw or Miro, but wired into the rest of HyperLevel: a sticky note becomes a task, a workflow
becomes a diagram, a frame becomes a funnel page, and Claude, ChatGPT or the HyperLevel Agent can draw on the
same board while you watch.

Menu: **Canvas** (`/app/canvas`, area `canvas` in the member rights). No extra service, no npm package:
the editor is React + SVG, the scene is plain JSON, exports are rendered by HyperLevel itself.

## Using the editor

| Do | How |
| --- | --- |
| Move around | Mouse wheel / two fingers pan, `Ctrl` + wheel or pinch zooms, `Space` + drag (or the hand tool) grabs the board, the minimap jumps, `⇧1` fits everything, `⇧2` the selection |
| Draw | Rectangle `R`, ellipse `O`, diamond `D`, line `L`, arrow `A`, pen `P` (smoothed, pressure-aware), text `T` (or double-click), sticky note `S`, frame `F`, eraser `X` |
| Arrows | Start or end an arrow on a shape and it **sticks**: it follows when the shape moves. Straight, elbow or curved, with heads and a label (double-click) |
| Frames / artboards | Presets Desktop 1440, Tablet 834, Mobile 390, Social 1080×1080 / 1080×1350 / 1200×675, Story, A4, Slide 16:9. Things dropped inside belong to the frame and move with it |
| Insert | Images (upload, drag & drop, paste with `Ctrl V`, media library, **KI-Studio**), icons from the app's icon set, tables (paste from Excel), charts (bar, line, area, pie, donut), templates, Mermaid text, **live CRM cards** |
| Style | Colours, fill, stroke, opacity, corners, font, size – and **Handgezeichnet**: the same shapes in a sketchy hand-drawn look |
| Select | Click, `⇧` click, marquee, lasso (`Q` or `Ctrl` + drag), `Ctrl A`; groups select as one |
| Arrange | Smart guides and grid snapping, align and distribute, z-order (`[` `]`), group `Ctrl G`, lock `Ctrl L`, hide, layers panel |
| Edit | Undo/redo `Ctrl Z` / `Ctrl ⇧ Z`, copy/paste (also between boards), duplicate `Ctrl D` or `Alt` + drag, arrow keys nudge |
| Comment | `C` pins a comment to an element or a spot; `@Name` mentions a colleague (push + app notification); resolve threads |
| Help | `?` lists every shortcut. Dark and light mode follow the app; the editor works with touch and pen (phones, tablets, the Android app) |

### Templates

Mind map, flowchart, customer journey, funnel plan, sales process, org chart, SWOT, kanban, wireframe
kit and social-post layouts – available when you create a board, from the toolbar and as `template` in the
API / MCP. They are ordinary elements: edit them like anything you draw.

### Boards, access and sharing

* A board belongs to one sub-account. The creator is the **owner**; agency admins count as owners everywhere.
* **Team access** decides what everyone else with the `canvas` right in that sub-account may do:
  `edit`, `view` (look and comment) or `none` (private). The owner can give single people a different role
  (*Teilen → Team*).
* **Public link** (*Teilen → Öffentlicher Link*): read-only page with zoom and pan, no login, refreshes
  itself. CRM cards show no live data there. Up to 10 links per board, each revocable, with a view counter.
* **API keys and MCP connections** act for the whole sub-account (like every other API). A read-only key
  cannot draw.
* **Versions:** the board saves itself every 30 minutes while it is edited (the last 30 are kept), you can
  save named versions and restore one – the current state is saved first, nothing is lost.

## CRM on the board

* **Live cards** – `contact`, `company`, `deal`, `task`, `ticket`, `appointment`, `project`, `report`
  (a saved report as chart or numbers) and `pipeline` (the whole board with stages and deals). They show
  the **current** record, refresh every minute and open it on double-click. Each card is read with the
  viewer's own rights: a member without the `helpdesk` area sees an error card instead of a ticket, records
  of other sub-accounts never show. Public links and exports of shared pages never contain live data.
* **Aufs Canvas:** contact, company, ticket, pipeline and workflow pages have an *Aufs Canvas* button that puts the
  record as a live card (a workflow as a diagram) on an existing or a new board and opens the board right there.
* **Sticky note → task or deal:** select notes (or any shape with text) → *Als Aufgabe* / *Als Deal*. The
  first line becomes the title, an amount like „5.000 €“ the deal value. The note is replaced by a live card
  of the new record. Every write runs the regular route (same rights, validation, audit log).
* **Workflow → diagram:** *⋯ → Workflow als Diagramm* draws trigger, steps and branches of an automation
  as a flowchart; the frame links back to the workflow.
* **Flowchart → workflow draft:** *⋯ → Flussdiagramm → Workflow-Entwurf* turns a flowchart into a **draft**
  workflow (start → trigger, shapes → steps such as e-mail, SMS, wait, tag, task, diamonds → if/else). Nothing
  runs until you review and switch it on.
* **Frames → funnel pages:** *⋯ → Rahmen → Funnel-Seiten* (or *Als Funnel-Seiten* in the inspector) creates
  one page per frame, left to right: large or bold text becomes headings, other text paragraphs, coloured
  shapes with text buttons, images stay images.

## Output

*Export* renders the whole board, the selection or one frame as **PNG** (1–4×, optionally transparent or
dark), **SVG** (text stays text) or **PDF** (vector; one page per frame if you like). From there:

* *In Mediathek / verwenden …* stores the image in the media library and offers it as a **social post draft**
  (Social Planner), an **e-mail campaign draft**, a **funnel page** image or just a link.
* The same exports are available to agents (`ghl_canvas_export`) and as links
  (`GET /api/canvas/:id/export?format=png&frame_id=…`).

## AI

* **KI zeichnen lassen** (`K` on the board, or on the board overview): describe a flowchart, mind map, org chart,
  diagram or wireframe in one sentence. The result is a normal, editable drawing (nodes, bound arrows,
  groups as frames) placed at a free spot. With a selection the text is used as context.
* **Auswahl erklären** – writes a short summary of the selection as a note next to it.
* **In Aufgaben verwandeln** – derives tasks from the selection and lays them out as live task cards.
* **Layout aufräumen** – arranges connected shapes (tree, flow or grid) without any AI call.

It uses the sub-account's AI connection (*Einstellungen → KI*, purpose „Canvas“) and counts against the
monthly AI limit. Without a connection the buttons answer with a clear error; everything else works.

## Agents and MCP

Every board is an API, so agents work on the very same objects people see. Edits appear **live** for
everyone watching, with a **labelled agent cursor** (the name of the key or „KI-Agent (im Auftrag von …)“).
A click on a person (or agent) in the header **follows** them: your view stays centred on their cursor until you pan,
zoom or press ✕. *Team ist hier → Mauszeiger anderer zeigen: Aus* hides the others' cursors and stops sending yours
([Live-Zusammenarbeit](collaboration.md)).

| Tool | Does |
| --- | --- |
| `ghl_canvas_list` | Boards of a sub-account, with element count, last change and who is watching |
| `ghl_canvas_create` | New board – empty, from a template, from Mermaid or with elements |
| `ghl_canvas_get` | Elements as JSON, a **text outline** (frames, contents, arrows from → to) and/or an SVG image |
| `ghl_canvas_add_elements` | Many elements at once; arrows connect by `from`/`to`; `ref` names, `at` places next to something, `in` puts into a frame, `layout` arranges |
| `ghl_canvas_update_elements` | Change fields; `base_version` reports conflicts, `strict` refuses stale writes |
| `ghl_canvas_delete_elements` | Delete (frames take their contents along) |
| `ghl_canvas_layout` | Auto layout: tree, flow, mind map, radial, grid – for existing elements or a new graph |
| `ghl_canvas_from_mermaid` | Mermaid flowchart, mind map or sequence diagram as editable elements |
| `ghl_canvas_export` | PNG / SVG / PDF into the media library, returns the URL |
| `ghl_canvas_comment` | Comment on an element or spot; `@Name` notifies |

The **HyperLevel Agent** (Ctrl/⌘ + J) offers these tools automatically (group „Canvas“); while a board is open
it knows which one. Try: *„Zeichne die Kundenreise für unseren Onlinekurs auf dieses Board“*, *„Lege für jede
Notiz hier eine Aufgabe an“*, *„Exportiere den Rahmen ‚Mobil‘ als PNG und mach daraus einen Social-Post-Entwurf“*.
Claude, ChatGPT and Codex use the same tools over `/mcp`. Tool results include a `link` to the board
(`/app/canvas/<id>?focus=<ids>` opens it zoomed to what was just drawn).

## The scene model

A board is a flat list of elements with stable ids; coordinates are board units (1 unit = 1 px at 100 %),
`x`/`y` is the top-left corner, `y` grows downwards. Pure JSON – this is what the API stores and agents read.

```json
{ "id": "a1", "type": "rect", "x": 0, "y": 0, "w": 160, "h": 90, "text": "Prüfen", "fill": "#a5d8ff", "sketch": true }
{ "id": "a2", "type": "arrow", "start": { "id": "a1" }, "end": { "id": "b7" }, "route": "elbow", "text": "ok" }
```

Types: `rect`, `ellipse`, `diamond`, `line`, `arrow`, `draw` (pen), `text`, `sticky`, `frame`, `image`,
`icon`, `table`, `chart`, `card`. Common fields: `x y w h angle z`, `stroke fill strokeWidth strokeStyle
(solid|dashed|dotted) fillStyle opacity radius sketch`, text (`text fontSize font bold italic align valign
color`), structure (`groupIds frameId locked hidden name link meta`). Type fields: `points`, `start`/`end`
(bindings), `route`, `startHead`/`endHead` (lines), `preset` (frames), `src` (images: media-library files
only), `icon`, `cells`/`header` (tables), `chart`, `card {kind,id}`. Every field is validated and clamped on
write; unknown fields are dropped, `null` removes an optional one. The server assigns `version` and `seed`.

Limits: 5,000 elements per board, 1,000 operations per request, 10,000 characters of text, 4,000 points per
stroke, 400 table cells, 200 chart values, 8 MB per image.

## API

All routes are under the `canvas` area; `X-Location-Id` (or `?locationId=`) selects the sub-account like
everywhere else. Details of access: owner > edit > view, see above.

| Method | Path | |
| --- | --- | --- |
| GET / POST | `/api/canvas` | List boards (+ unread @mentions) / create (`name`, `template`, `mermaid`, `elements`, `team_access`, `settings`) |
| GET | `/api/canvas/templates` · `/mentions` · `/media` | Template list · open comments that mention me · images of the media library |
| GET / PATCH / DELETE | `/api/canvas/:id` | Read (`?outline=1&svg=1`) / rename, settings, `team_access` / delete |
| POST | `/api/canvas/:id/duplicate` | Copy a board |
| POST | `/api/canvas/:id/ops` | `{clientId?, strict?, ops: [{op: add\|update\|delete, …}]}` – element versions, per-field merge, results per op (`ok`, `conflict`, `rejected`, `locked`, `deleted`, `missing`, `error`) |
| POST | `/api/canvas/:id/elements` | Agent-friendly create: `refs`, `at`, `in`, `from`/`to`, `layout`, `origin` |
| GET | `/api/canvas/:id/changes?since=<seq>` | Catch-up after a reconnect |
| GET | `/api/canvas/:id/stream?clientId=` | **SSE**: `hello`, `ops`, `presence`, `leave`, `comment`, `board`, `reload`, `deleted`, `bye` (a person's stream ends with their login – signed out, revoked, expired – or their access to the board; a key's or MCP connection's stream ends when the key is deleted or the connection disconnected). Board full (200 viewers): 503 instead of a stream |
| POST | `/api/canvas/:id/presence` | Cursor/selection (`clientId`, `x`, `y`, `sel`) |
| POST | `/api/canvas/:id/template` · `/mermaid` · `/layout` | Insert a template / Mermaid text / auto layout |
| POST | `/api/canvas/:id/cards` | Resolve live cards (`refs: [{kind,id}]`) with the caller's rights |
| GET | `/api/canvas/:id/svg` · `/export?format=png\|svg\|pdf` | Render (`frame_id`, `ids`, `scale`, `theme`, `transparent`, `pages=frames`) |
| POST | `/api/canvas/:id/export` | Same, saved to the media library (returns `src`, `url`, `id`) |
| POST | `/api/canvas/:id/media` | Upload an image (`data:` URL, PNG/JPEG/GIF/WebP, ≤ 8 MB, content checked) |
| GET / PUT | `/api/canvas/:id/people` · `/members` | Who can see the board / set a person's role (owner) |
| GET / POST / DELETE | `/api/canvas/:id/shares[/:sid]` | Public links (owner) |
| GET / POST | `/api/canvas/:id/snapshots[/:sid/restore\|svg]` · DELETE `…/:sid` | Versions |
| GET / POST / PATCH / DELETE | `/api/canvas/:id/comments[/:cid]` | Comments with `element_id`, `x`/`y`, `parent_id`, `mentions` |
| POST | `/api/canvas/:id/convert` | Notes → tasks/deals (`element_ids`, `to`, …) |
| POST | `/api/canvas/:id/workflow-diagram` · `/workflow-draft` · `/funnel-pages` | Workflow → diagram, flowchart → draft workflow, frames → funnel pages |
| POST | `/api/canvas/:id/ai` | `{mode: draw\|explain\|tasks\|tidy, prompt, kind, ids}` |
| GET | `/canvas/s/<token>` · `/api/public/canvas/<token>` | Public read-only page and its JSON (no login) |
| GET | `/api/mobile/canvases` · `/api/mobile/canvases/:id/svg` | For the Android app: boards of all visible sub-accounts, rendered as SVG |

**Concurrency:** every element has a `version`. Changes are merged per field (last writer wins per field),
`baseVersion` turns a lost race into a `conflict` result with the merged element, `strict: true` makes the
server refuse stale writes instead. Deleted elements leave a tombstone, so a late update does not resurrect
them – only an `add` (undo) does.

## Security

* Text is **never** emitted as markup: SVG and PDF are built from escaped values only; links are limited
  to `http(s)://` and `/app/…`; images only from the media library (`/uploads/<file>`), the SVG endpoints
  send a strict `Content-Security-Policy`.
* Every route filters by the sub-account; boards, comments, links and versions of other sub-accounts are
  invisible (part of the tenant-isolation tests). Live cards use the caller's area rights.
* Public links are unguessable tokens (only the SHA-256 is stored), revocable, read-only and hide live
  CRM data; the page loads no third-party resources and carries a strict `Content-Security-Policy`.
* Agents are bound to the key's or user's sub-account and rights; changes show up in the audit log
  (`canvas.edit`, at most one line per person and board every 10 minutes while editing).

## Phones, tablets and the Android app

The editor is built for touch and pen: one finger draws (with a tool) or pans (with the select tool), two
fingers pan and zoom, long-press opens the context menu, panels become bottom sheets and the toolbar a
scrolling bar. Inside the Android app it runs in the app's WebView like the rest of the web app (`/app/canvas`
opens there). For native lists and previews the app API serves `GET /api/mobile/canvases` (all boards of the
visible sub-accounts, with `access`, `web_url`, `svg_url`) and `GET /api/mobile/canvases/:id/svg` (a rendered
picture of the board, `?theme=dark`, `?max=<px>`), using the device token and the user's rights.
