# Wiki – team knowledge next to the CRM

The Wiki is HyperLevel's internal knowledge base: **spaces** with a **nested page tree**, pages written in
Markdown with a live preview, checklists you can tick, tables and callouts – and **live cards** that show a
contact, deal, task, ticket or Canvas board with its *current* data. Colleagues are @mentioned, pages have
comments, a version history with restore, favourites, full-text search, templates, import and export (Markdown,
PDF), read-only share links and one-click publishing to the public help center. The HyperLevel Agent, Claude and
ChatGPT read and write pages through MCP.

Menu: **Wiki** (`/app/wiki`, area `wiki` in the member rights). No extra service and no npm package: the editor
is a text area plus a preview that the *server* renders, so what you see is exactly what the page will show.

It does not replace the pieces that already exist – it connects to them:

| Existing piece | How the Wiki uses it |
| --- | --- |
| Help center / knowledge base (`/api/kb/articles`) | *Teilen → Im Help Center veröffentlichen* writes a **copy** as a public article through the knowledge-base routes (rights, validation and audit log are theirs). The page remembers the article and shows "Im Help Center steht noch eine ältere Fassung" after later edits. |
| Project documents (`docs`) | A document can be embedded as a card (`[Title](card:doc:ID)`). |
| Canvas | A board can be embedded as a card with a thumbnail (`card:canvas:ID`), the Canvas can link pages. |
| Internal notes | Chat messages can be kept as a note on a contact; wiki pages stay team-internal. |
| Tasks | Pages link tasks by id (`card:task:ID`); the Wiki never owns tasks. Checklists on a page are text, not tasks – the AI helper's "Aufgaben finden" produces them, `/aufgabe` in the Team-Chat creates real ones. |
| Web push, Android feed | Mentions and comments notify (push kind `wiki`, see below). |
| HyperLevel Agent, MCP | Three tools (`ghl_wiki_search`, `ghl_wiki_get`, `ghl_wiki_upsert_page`), see [api.md](api.md#wiki--team-chat). |

## Using it

| Do | How |
| --- | --- |
| New page | **Neue Seite** (in the current space), the **＋** on a tree row (sub-page), or *Aus Vorlage …* |
| Order pages | Drag a page: onto another (becomes its child), onto the upper or lower edge (before/after), onto a space heading (top level). On phones and for keyboard users: *Mehr → Verschieben …* |
| Write | Markdown with a toolbar; `/` opens a block menu (headings, list, checklist, table, callout, code, card …), `@` mentions a person, `Ctrl B / I / K` format, Enter continues lists. Autosave after a pause – the header shows *Gespeichert*. |
| Preview | *Schreiben / Geteilt / Vorschau* switch above the editor (side by side on wide screens). |
| Tick a checklist | In the reading view; saved immediately and written to the history as "Checkliste". |
| Images and files | Upload button, paste, or drop onto the editor (max 8 MB; PNG, JPEG, GIF, WebP, PDF, text/CSV, Office documents, ZIP). SVG and HTML are refused. |
| Cards | **Karte** button or `/karte`: contacts, companies, deals, pipelines, tasks, tickets, Canvas boards, documents, wiki pages. |
| Comment | **Kommentare**: threads, replies, resolve, `@mentions`. |
| History | *Mehr → Verlauf*: every saved version with author, a line diff against the current text, **restore** (the current text is kept in the history first). |
| Favourites | The star; favourites are listed above the tree (per person). |
| Search | The field above the tree: titles and text of every page you may read, hits highlighted. |
| Delete | *Mehr → In den Papierkorb*; sub-pages go along; restorable for 30 days (*… → Papierkorb*), then emptied automatically. |
| Export | *Mehr → Als Markdown / PDF laden*, optionally with all sub-pages. |
| Import | *… → Markdown importieren*: `.md`, `.markdown`, `.txt`, `.html` (up to 50 files of 1 MB); the first `# heading` becomes the title, front-matter `title:` is honoured, HTML is converted to Markdown. |

### Markdown reference

```
# Heading (levels 1–6; "#" is shown as the second level because the page title is the first)
**bold**  *italic*  ~~struck~~  ==marked==  `code`  [link](https://…)  ![alt](/uploads/file.png)
- list            1. numbered list            - [ ] open task      - [x] done task
> quote
> [!TIP] Own title        (INFO, NOTE, TIP, WARNING, DANGER, SUCCESS – a coloured box)
| A | B |
| --- | --- |            (tables, with :--- / ---: alignment)
```code```                (fenced code block)
[@Maria Muster](user:USER_ID)          mention (the picker writes this; a plain @Name in API text works too)
[Onboarding](page:PAGE_ID)             link to another wiki page
[Anna Beispiel](card:contact:ID)       on a line of its own: a live card; inside text: a chip
```

Card kinds: `contact`, `company`, `deal`, `pipeline`, `task`, `ticket`, `canvas`, `doc`, `wiki`.
Links may be `https`, `http`, `mailto`, `tel`, `/path` and `#anchor`; images `https` or the media library
(`/uploads/…`). Raw HTML is shown as text.

## Spaces and who may do what

A **space** (up to 50 per sub-account) groups pages and carries the access rule:

| Team access | Other team members with the `wiki` right |
| --- | --- |
| `edit` (default) | read and edit, create pages, comment |
| `view` | read and comment |
| `none` | no access – private to the owner (and the agency) |

The creator is the **owner** (rename, change access, delete the space); **agency admins count as owners
everywhere**. API keys and MCP connections act for the whole sub-account (a read-only key can only read).
A page, a card or a search hit in a space you cannot read answers like a page that does not exist – never a hint
that it does. Cards show data only if the viewer may also see that record in the CRM (the Canvas card
resolver, same area rights, same sub-account filter).

## Safety of what people write

* **Server-side rendering with two independent layers**: the renderer escapes every character and writes
  only its own tags, URLs are checked against an allow-list; then an allow-list sanitiser keeps only known tags,
  attributes and classes. Even a renderer bug could not put script, event handlers, styles or foreign frames on a
  page. The tests run ~70 hostile payloads through page, public, chat and comment rendering.
* **Bounded work**: source size, line count, nesting depth and a total work budget are capped, so a hostile page
  cannot hold the server (a megabyte of `[` or `*` renders in milliseconds).
* **Uploads** are checked by type allow-list and by content (the bytes must match the declared type), size-capped,
  stored under a random name; SVG/HTML never.
* **Audit log**: creating, moving, restoring, deleting, sharing, publishing and importing write an audit entry.
  Editing writes **one entry per person, page and ten minutes** (autosave would otherwise flood the log) – the
  version history keeps every save, with author and time. Saves within ten minutes by the same person are
  merged into one version; at most 150 versions are kept per page.
* **Concurrent editing**: two people can have a page open. Saves carry the version they started from; a stale save
  is refused with a clear message (*Neu laden / Meine Fassung behalten*), nothing is silently overwritten. The
  open page checks for other people's saves every 15 seconds. There is no live co-editing (no cursors) –
  for that, use a Canvas board.

## Sharing and publishing

* **Share link** (*Teilen*): `/wiki/s/<token>` – a read-only page without login, up to 10 per page, each revocable,
  with a view counter. The token is 192 random bits; only its hash is stored (a sealed copy lets the owner copy
  the link again). The page is sent with `noindex`, `no-referrer`, `no-store` and a strict content-security
  policy (no script at all); it shows **no** live cards, mentions or links into the app. A PDF is offered too
  (`/api/public/wiki/<token>/pdf`). Uploaded images are served from `/uploads/<random name>`, so anyone with the
  page link can also load those images – do not put secrets into images of shared pages.
  Revoking a link, trashing the page or deleting the space ends access at once.
* **Help center**: *Teilen → Veröffentlichen* creates or updates an article in the knowledge base
  (`/app/help-center`) with the page title and a converted text (tables become lists, checklists get ☐/☑,
  callouts a bold title, cards and links plain text). *Zurückziehen* sets the article back to draft. The wiki
  itself is never read by the customer-facing chatbot – only published articles are.

## AI helper

*Mehr → KI-Schreibhilfe* (or the **KI** button in the editor) – needs the AI connection of the sub-account
(*Einstellungen → KI-Assistent*, your own key): **summarise**, **rewrite** (with an instruction), **continue**,
**translate**, **find tasks** (a checklist). The helper works on the selection if there is one. The answer is only a
*suggestion* in a dialog – *Unten einfügen*, *Auswahl ersetzen* or *Verwerfen*; nothing is written without that click,
and replaced text stays in the history. *Neue Seite → Mit KI schreiben* drafts a whole page from a sentence.
The page text is passed to the model as data with an instruction not to follow anything written inside it. Usage
counts under the purpose "Wiki" in the AI usage statistics.

## Templates

*Meeting-Notizen*, *Prozess / SOP*, *Projekt-Briefing*, *Onboarding-Handbuch* (a welcome page with three
sub-pages) and *Leere Seite*. Placeholders `{{datum}}`, `{{autor}}` and `{{projekt}}` are filled in when the
page is created.

## Notifications

| Event | Who | Where |
| --- | --- | --- |
| `@mention` in a comment | the mentioned person | web push (kind `wiki`, switchable in *Einstellungen → Mein Konto*) |
| Comment on a page | the page's author, the author of the comment replied to, mentioned people | web push |

Only people who may read the space are notified; a mention of somebody without access is ignored.

## For self-hosters

Nothing to set up. Pages live in the SQLite database (tables `wiki_*`), images in `data/uploads`, so the
nightly backup and the restore cover everything.

* **Search** uses SQLite FTS5 (`unicode61`, accent-insensitive, titles weigh more); if your Node build has no FTS5
  the search falls back to `LIKE` automatically (slower on huge wikis, same results). The index is a convenience:
  results are always joined with the page table and filtered by sub-account and access, so a damaged index can never
  show another sub-account's page.
* **PDF export** is built in (no browser, no library) with the standard PDF fonts: Latin text incl. German
  umlauts, € and common punctuation render; other scripts (CJK, Cyrillic, emoji) are replaced by `?`. Use Markdown
  export for those.
* Limits: 5,000 pages per sub-account, 12 levels deep, titles 200 characters, 400,000 characters per page,
  8 MB per upload.
* The trash is emptied by the background tick (`PGHL_TICK_MS`), nothing to schedule.

## API and MCP

See [api.md → Wiki & Team-Chat](api.md#wiki--team-chat). Area `wiki`; every write goes through the same guards and
audit log as the UI.
